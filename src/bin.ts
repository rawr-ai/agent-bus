#!/usr/bin/env -S bun --no-env-file
import { homedir } from "node:os";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Logger, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Bus from "./Bus.ts";
import { claudeWake } from "./claude.ts";
import * as Client from "./client.ts";
import { defaultCodex } from "./codex.ts";
import { compactRecovery, readCompactInput } from "./compact.ts";
import { Association, LedgerError, Runtime } from "./domain.ts";
import * as Fluree from "./Fluree.ts";
import { initializeInstallation, loadInstallation } from "./installation.ts";
import * as Ledger from "./Ledger.ts";
import {
  completeMailboxBootstrap,
  inspectMailboxBootstrap,
  spendExistingAttachment,
  spendMailboxBootstrap,
} from "./mailbox-bootstrap.ts";
import { Peers, Published } from "./mcp-tools.ts";
import { OrientationResult } from "./orientation-model.ts";
import { QueryGateway } from "./Query.ts";
import * as Serve from "./serve.ts";
import {
  persistServeBinding,
  readServeBinding,
  type ServeBinding,
  sameServeBinding,
  serveBindingCapability,
  verifyServeHistory,
} from "./serve-binding.ts";
import { BUILD } from "./version.ts";

const busDir = process.env.AGENT_BUS_DIR ?? join(homedir(), ".agent-bus");
const port = Number(process.env.AGENT_BUS_PORT ?? 8096);
const endpoint = `http://127.0.0.1:${port}/mcp`;

/** `config.json` in the bus directory, which names the Fluree ledger the bus uses. */
const ConfigJson = Schema.fromJsonString(
  Schema.Struct({
    fluree: Schema.optionalKey(Schema.Struct({ url: Schema.String, ledger: Schema.String })),
  })
);

const loadConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = join(busDir, "config.json");
  if (!(yield* fs.exists(file))) return {};
  return yield* Schema.decodeUnknownEffect(ConfigJson)(yield* fs.readFileString(file));
});

/** The bearer token for the bus's Fluree server, written by the installer. */
const loadToken = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = join(busDir, "fluree-token");
  if (!(yield* fs.exists(file))) return undefined;
  return (yield* fs.readFileString(file)).trim();
});

/** `config.json` names no Fluree ledger, so the store can't open. */
class NoStore extends Schema.TaggedError<NoStore>()("NoStore", { message: Schema.String }) {}

const flureeConfig = Effect.gen(function* () {
  const { fluree } = yield* loadConfig;
  if (fluree === undefined) {
    return yield* new NoStore({
      message: `${join(busDir, "config.json")} has no Fluree ledger. Give it a "fluree" entry, as the installer writes: { "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }`,
    });
  }
  return { ...fluree, token: yield* loadToken };
});

/** Direct access to the store, for the machine's bus process. */
interface Serving {
  readonly config: Fluree.FlureeConfig;
  readonly binding: ServeBinding;
}

const BusLayer = (serving: Serving) => {
  const verified = Layer.effectDiscard(verifyServingLedger(serving)).pipe(
    Layer.provideMerge(Fluree.layerFluree(serving.config, { existingOnly: true }))
  );
  return Bus.layer(serving.binding.installation).pipe(Layer.provideMerge(verified));
};

const list = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: (text) =>
      text
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== ""),
  });

const call = Client.call(endpoint);
/**
 * What the CLI reads back from bus_publish. The message is already stored when this decodes, so a
 * standing a newer serve adds still prints instead of failing a send that would invite a resend.
 */
const Sent = Schema.Struct({
  id: Published.fields.id,
  replayed: Schema.optionalKey(Schema.Boolean),
  wake: Schema.optionalKey(
    Schema.Struct({
      t: Schema.Int,
      lacking: Schema.Array(Schema.Struct({ address: Schema.String, standing: Schema.String })),
      unlisted: Schema.optionalKey(Schema.Int),
    })
  ),
});

const address = Flag.String("address").pipe(Flag.withDescription("Your bus address"));
const session = Flag.String("session").pipe(
  Flag.withDescription(
    "Your session id; defaults by runtime to $CODEX_THREAD_ID, $CLAUDE_CODE_SESSION_ID or $AGENT_BUS_SESSION"
  ),
  Flag.optional
);
const runtimeFlag = Flag.Literals("runtime", Runtime.literals);
const optionalRuntime = runtimeFlag.pipe(
  Flag.withDescription("Your runtime, which picks the session id; defaults to the address's"),
  Flag.optional
);

/**
 * The session id to present for an address: `--session`, or the variable of
 * `--runtime` or of the runtime the address joined with, which asks the bus.
 */
const sessionOf = (of: string, runtime: Option.Option<Runtime>, explicit: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isSome(explicit)) return yield* Client.sessionFor("other", explicit.value);
    const known = Option.isSome(runtime) ? runtime.value : yield* Client.runtimeOf(endpoint, of);
    return yield* Client.sessionFor(known, undefined);
  });

const serve = Command.make(
  "serve",
  {
    codex: Flag.String("codex").pipe(
      Flag.withDescription(
        "The Codex CLI whose app-server queues nudges (default: the desktop app's own)"
      ),
      Flag.withDefault(defaultCodex)
    ),
  },
  (input) =>
    preServeAdmission.pipe(
      Effect.flatMap((binding) =>
        Layer.launch(
          Serve.layer({
            port,
            version: BUILD,
            codex: input.codex,
          })
        ).pipe(Effect.provide(BusLayer(binding)))
      ),
      Effect.catchTag("LedgerError", fail)
    )
).pipe(
  Command.withDescription(
    `Run this machine's bus: MCP over HTTP at ${endpoint}, and native delivery to this installation's Codex and Claude peers (run one per machine)`
  )
);

const verifyServeBinding = Command.make(
  "verify-serve-binding",
  {
    allowFirstCreate: Flag.Boolean("allow-first-create").pipe(
      Flag.withDescription("Also recognize a local, unspent targeted first-create reservation"),
      Flag.withDefault(false)
    ),
    expectedRecoveryHead: Flag.Int("expected-recovery-head").pipe(Flag.optional),
    expectedRecoveryCommit: Flag.String("expected-recovery-commit").pipe(Flag.optional),
  },
  ({ allowFirstCreate, expectedRecoveryHead, expectedRecoveryCommit }) =>
    Effect.gen(function* () {
      const head = Option.getOrUndefined(expectedRecoveryHead);
      const commit = Option.getOrUndefined(expectedRecoveryCommit);
      if (
        (head === undefined) !== (commit === undefined) ||
        (allowFirstCreate && head !== undefined)
      )
        return yield* new LedgerError({
          message: "Supply both recovery anchor flags together, without --allow-first-create.",
        });
      const recovery = head === undefined || commit === undefined ? undefined : { head, commit };
      const input = yield* serveInputs;
      const binding = yield* existingServeBinding(input);
      if (binding !== undefined) {
        yield* verifyServingLedger({ config: input.config, binding }, recovery).pipe(
          Effect.provide(Fluree.layerFluree(input.config, { existingOnly: true }))
        );
        yield* Console.log(serveBindingCapability);
        return;
      }
      if (
        allowFirstCreate &&
        (yield* inspectMailboxBootstrap(busDir, input.installation, input.config)).kind ===
          "unspent"
      ) {
        yield* requireStoreBinding(input.config, input.installation);
        yield* Console.log("first-create-reservation-v1");
        return;
      }
      return yield* noServingBinding();
    }).pipe(Effect.catchTags({ LedgerError: fail, InstallationError: fail, NoStore: fail }))
).pipe(
  Command.withDescription("Check the local serving binding without creating or starting anything")
);

const bindExistingLedger = Command.make(
  "bind-existing-ledger",
  {
    expectedInstallation: Flag.String("expected-installation"),
    expectedIncarnation: Flag.String("expected-incarnation"),
    expectedHead: Flag.Int("expected-head"),
    expectedCommit: Flag.String("expected-commit"),
  },
  (expected) =>
    attachExistingLedger(expected).pipe(
      Effect.catchTags({ LedgerError: fail, InstallationError: fail, NoStore: fail })
    )
).pipe(
  Command.withDescription(
    "Bind a newly initialized installation to an independently pinned existing ledger"
  )
);

const initialize = Command.make(
  "initialize-installation",
  {
    flureeUrl: Flag.String("fluree-url").pipe(
      Flag.withDescription("Exact intended Fluree origin for a new installation"),
      Flag.optional
    ),
    flureeLedger: Flag.String("fluree-ledger").pipe(
      Flag.withDescription("Exact intended Fluree ledger for a new installation"),
      Flag.optional
    ),
  },
  ({ flureeUrl, flureeLedger }) =>
    Effect.gen(function* () {
      if (Option.isSome(flureeUrl) !== Option.isSome(flureeLedger)) {
        return yield* new LedgerError({
          message: "Supply both --fluree-url and --fluree-ledger, or neither.",
        });
      }
      const target =
        Option.isSome(flureeUrl) && Option.isSome(flureeLedger)
          ? { url: flureeUrl.value, ledger: flureeLedger.value }
          : undefined;
      yield* initializeInstallation(busDir, target);
    }).pipe(Effect.catchTag("LedgerError", fail))
).pipe(
  Command.withDescription(
    "Create this bus installation's native delivery identity once; do not replace an existing identity"
  )
);

const joinCommand = Command.make(
  "join",
  {
    address,
    runtime: runtimeFlag,
    session,
    takeover: Flag.String("takeover").pipe(
      Flag.withDescription(
        "Replace an ended session: the holder's join id from the refusal (only when the human says so)"
      ),
      Flag.optional
    ),
    topics: Flag.String("topics").pipe(
      Flag.withDescription("Comma-separated topic names (optional #); an empty string clears them"),
      Flag.optional
    ),
    associations: Flag.String("associations").pipe(
      Flag.withDescription(
        'JSON array of explicit directory/concern associations; [] clears them, e.g. [{"directory":"bus","concerns":["orientation"]}]'
      ),
      Flag.optional
    ),
    orient: Flag.Boolean("orient").pipe(
      Flag.withDescription("Read orientation after the join commits"),
      Flag.withDefault(false)
    ),
    codexThread: Flag.String("codex-thread").pipe(
      Flag.withDescription("Codex thread id the bus wakes"),
      Flag.optional
    ),
    note: Flag.String("note").pipe(Flag.withDescription("What you are working on"), Flag.optional),
    replay: Flag.Boolean("replay").pipe(
      Flag.withDescription("Also deliver messages sent before joining"),
      Flag.withDefault(false)
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const associations = Option.isNone(input.associations)
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Association)))(
            input.associations.value
          ).pipe(
            Effect.mapError(
              () =>
                new Client.BusCallError({
                  message:
                    "--associations must be a JSON array of directory and concern ids. No join was sent.",
                })
            )
          );
      const joining = {
        address: input.address,
        runtime: input.runtime,
        session: yield* Client.sessionFor(input.runtime, Option.getOrUndefined(input.session)),
        cwd: process.cwd(),
        ...(associations === undefined ? {} : { associations }),
        ...(input.orient ? { orient: true } : {}),
        ...Client.defined({
          topics: Option.getOrUndefined(
            Option.map(input.topics, (text) =>
              text === "" ? [] : text.split(",").map((topic) => topic.trim())
            )
          ),
          codexThreadId: Option.getOrUndefined(input.codexThread),
          note: Option.getOrUndefined(input.note),
        }),
        replay: input.replay,
      };
      const joined = yield* Option.match(input.takeover, {
        onNone: () => Client.join(endpoint)("bus_join", joining),
        onSome: (holder) => Client.join(endpoint)("bus_takeover", { ...joining, holder }),
      });
      const topics =
        joined.topics === undefined ? "" : `; topics: ${JSON.stringify(joined.topics)}`;
      const effective =
        associations === undefined ? "" : `; associations: ${JSON.stringify(joined.associations)}`;
      yield* Console.log(`joined as ${joined.address}${topics}${effective}`);
      if (input.orient) {
        yield* Console.log(
          joined.orientation === undefined
            ? "Orientation unavailable after the committed join; retry read-only with agent-bus orient. Do not rejoin."
            : JSON.stringify(joined.orientation)
        );
      }
    })
).pipe(Command.withDescription("Join the bus as an address, from this directory"));

const orientCommand = Command.make(
  "orient",
  {
    directory: Flag.String("directory").pipe(
      Flag.withDescription("Select a directory by id"),
      Flag.optional
    ),
    concern: Flag.String("concern").pipe(
      Flag.withDescription("Include a selected concern's bulletin"),
      Flag.optional
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Absolute checkout path to discover; defaults to this directory"),
      Flag.optional
    ),
    t: Flag.Int("t").pipe(Flag.withDescription("Historical ledger commit"), Flag.optional),
    candidateCursor: Flag.String("candidate-cursor").pipe(
      Flag.withDescription("Continue candidate discovery at its original cut"),
      Flag.optional
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const result = yield* call("bus_orient", OrientationResult, {
        cwd: Option.getOrUndefined(input.cwd) ?? process.cwd(),
        ...Client.defined({
          directory: Option.getOrUndefined(input.directory),
          concern: Option.getOrUndefined(input.concern),
          t: Option.getOrUndefined(input.t),
          candidateCursor: Option.getOrUndefined(input.candidateCursor),
        }),
      });
      yield* Console.log(JSON.stringify(result));
    })
).pipe(Command.withDescription("Read current orientation without joining or moving a cursor"));

const publish = Command.make(
  "publish",
  {
    from: Flag.String("from"),
    runtime: optionalRuntime,
    session,
    to: Flag.String("to").pipe(Flag.withDescription("Comma-separated addresses, #topics or *")),
    body: Flag.String("body"),
    subject: Flag.String("subject").pipe(Flag.optional),
    replyTo: Flag.String("reply-to").pipe(Flag.optional),
    operation: Flag.String("operation").pipe(
      Flag.withDescription(
        "A lowercase UUIDv7 naming this send and its retries; repeat it to retry an unconfirmed send"
      ),
      Flag.optional
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const published = yield* call("bus_publish", Sent, {
        from: input.from,
        session: yield* sessionOf(input.from, input.runtime, input.session),
        to: list(Option.some(input.to)) ?? [],
        body: input.body,
        ...Client.defined({
          subject: Option.getOrUndefined(input.subject),
          replyTo: Option.getOrUndefined(input.replyTo),
          operation: Option.getOrUndefined(input.operation),
        }),
      });
      yield* Console.log(published.id);
      if (published.replayed === true) yield* Console.error("already sent: nothing was written");
      // The id stays the only stdout line; what the send could not wake goes to stderr.
      for (const { address, standing } of published.wake?.lacking ?? []) {
        yield* Console.error(`${address}: ${standing} at t=${published.wake?.t}`);
      }
      if (published.wake?.unlisted !== undefined)
        yield* Console.error(`${published.wake.unlisted} more not listed at t=${published.wake.t}`);
    })
).pipe(Command.withDescription("Send a message"));

const peers = Command.make("peers", {}, () =>
  Effect.gen(function* () {
    const { peers } = yield* call("bus_peers", Peers, {});
    for (const peer of peers) {
      const topics = peer.topics.length === 0 ? "" : ` #${peer.topics.join(" #")}`;
      const host = peer.host === undefined ? "" : ` on ${peer.host}`;
      const note = peer.note === undefined ? "" : ` — ${peer.note}`;
      yield* Console.log(`${peer.address} (${peer.runtime})${host}${topics}${note}`);
    }
  })
).pipe(Command.withDescription("List joined peers"));

const claudeWakeHook = Command.make("claude-wake", {}, () =>
  Effect.gen(function* () {
    // An unreadable input is no session: the hook exits quietly.
    const input = yield* Effect.tryPromise(() => Bun.stdin.text()).pipe(
      Effect.orElseSucceed(() => "")
    );
    const nudge = yield* claudeWake(endpoint, input);
    if (Option.isNone(nudge)) return;
    // An asyncRewake hook that exits 2 wakes the session, which is shown its stderr.
    yield* Console.error(nudge.value);
    process.exitCode = 2;
  })
).pipe(
  Command.withDescription(
    "The Claude Code plugin's asyncRewake hook: wait for new mail for this session's addresses, then wake it (exit 2) with a nudge to read it (reads the hook input on stdin)"
  )
);

const compactContext = Command.make(
  "compact-context",
  { runtime: Flag.Literals("runtime", ["claude", "codex"]) },
  ({ runtime }) =>
    Effect.gen(function* () {
      const context = yield* compactRecovery(
        runtime,
        readCompactInput(() => Bun.stdin.stream()),
        endpoint
      );
      if (Option.isSome(context)) yield* Console.log(context.value);
    })
).pipe(
  Command.withDescription(
    "The plugin's synchronous compact hook: recover held addresses and the current-guidance route, without changing bus state"
  )
);

const fail = (error: { readonly message: string }) =>
  Console.error(error.message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      })
    )
  );

const requireStoreBinding = (config: Fluree.FlureeConfig, installation: string) =>
  Effect.gen(function* () {
    if ((yield* loadInstallation(busDir)) !== installation) {
      return yield* new LedgerError({
        message: "The local installation changed; operator recovery is required.",
      });
    }
    const current = yield* flureeConfig;
    if (
      current.url !== config.url ||
      current.ledger !== config.ledger ||
      current.token !== config.token
    ) {
      return yield* new LedgerError({
        message: "The configured store changed; operator recovery is required.",
      });
    }
  });

interface ServeInputs {
  readonly config: Fluree.FlureeConfig;
  readonly installation: string;
}

const serveInputs = Effect.gen(function* () {
  return { config: yield* flureeConfig, installation: yield* loadInstallation(busDir) };
});

const noServingBinding = () =>
  new LedgerError({
    message:
      "No serving binding. Restore the original installation's binding or use the explicit operator attachment procedure.",
  });

const makeServeBinding = (
  { config, installation }: ServeInputs,
  incarnation: string,
  era: number,
  anchor: ServeBinding["anchor"]
): ServeBinding => ({
  version: 1,
  installation,
  url: config.url,
  ledger: config.ledger,
  incarnation,
  era,
  anchor,
});

const nativeServeBinding = (input: ServeInputs, incarnation: string) =>
  makeServeBinding(input, incarnation, 1, { head: 1, commit: incarnation });

const existingServeBinding = (input: ServeInputs) =>
  Effect.gen(function* () {
    const { config, installation } = input;
    const binding = yield* readServeBinding(busDir, installation, config);
    if (binding !== undefined) return binding;
    const state = yield* inspectMailboxBootstrap(busDir, installation, config);
    return state.kind === "complete" ? nativeServeBinding(input, state.incarnation) : undefined;
  });

/** Reopen existing-only, then check again before constructing Bus or its listener. */
const verifyServingLedger = ({ config, binding }: Serving, recovery?: ServeBinding["anchor"]) =>
  Effect.gen(function* () {
    yield* requireStoreBinding(config, binding.installation);
    yield* verifyServeHistory(binding, recovery);
    yield* requireStoreBinding(config, binding.installation);
    if (
      !sameServeBinding(
        yield* existingServeBinding({ config, installation: binding.installation }),
        binding
      )
    )
      return yield* noServingBinding();
  });

const attachExistingLedger = (expected: {
  readonly expectedInstallation: string;
  readonly expectedIncarnation: string;
  readonly expectedHead: number;
  readonly expectedCommit: string;
}) =>
  Effect.gen(function* () {
    const input = yield* serveInputs;
    const { config, installation } = input;
    const refusal = () =>
      new LedgerError({
        message:
          "Explicit attachment requires the intended, unused installation identity. Restore a lost binding instead of selecting another history.",
      });
    if (expected.expectedInstallation !== installation) return yield* refusal();
    const state = yield* inspectMailboxBootstrap(busDir, installation, config);
    const saved = yield* readServeBinding(busDir, installation, config);
    const provider = Fluree.layerFluree(config, { existingOnly: true });
    if (state.kind === "attachment-spent") {
      if (
        saved === undefined ||
        saved.incarnation !== expected.expectedIncarnation ||
        saved.anchor.head !== expected.expectedHead ||
        saved.anchor.commit !== expected.expectedCommit
      )
        return yield* refusal();
      yield* verifyServingLedger({ config, binding: saved }).pipe(Effect.provide(provider));
      return;
    }
    if (state.kind !== "identity-only" || saved !== undefined) return yield* refusal();
    yield* requireStoreBinding(config, installation);
    const binding = yield* Effect.gen(function* () {
      const at = yield* (yield* QueryGateway).pin;
      const ledger = yield* Ledger.Ledger;
      const candidate = makeServeBinding(
        input,
        expected.expectedIncarnation,
        yield* ledger.ownershipEraAt(at),
        {
          head: expected.expectedHead,
          commit: expected.expectedCommit,
        }
      );
      yield* verifyServeHistory(candidate);
      return candidate;
    }).pipe(Effect.provide(provider));
    yield* requireStoreBinding(config, installation);
    if ((yield* readServeBinding(busDir, installation, config)) !== undefined)
      return yield* refusal();
    yield* spendExistingAttachment(busDir, installation, config);
    yield* persistServeBinding(busDir, binding);
  });

/** The only creating dispatch follows an exclusive, durable one-shot grant spend. */
const preServeAdmission = Effect.gen(function* () {
  const input = yield* serveInputs;
  const { config, installation } = input;
  const persisted = yield* readServeBinding(busDir, installation, config);
  if (persisted !== undefined) return { config, binding: persisted } satisfies Serving;

  const state = yield* inspectMailboxBootstrap(busDir, installation, config);
  const provider = Fluree.layerFluree(config, { existingOnly: true });
  if (state.kind === "complete") {
    const binding = nativeServeBinding(input, state.incarnation);
    yield* verifyServingLedger({ config, binding }).pipe(Effect.provide(provider));
    yield* persistServeBinding(busDir, binding);
    return { config, binding } satisfies Serving;
  }
  if (state.kind !== "unspent") return yield* noServingBinding();
  const exists = yield* Fluree.flureeLedgerExists(config);

  yield* requireStoreBinding(config, installation);
  if ((yield* readServeBinding(busDir, installation, config)) !== undefined)
    return yield* noServingBinding();
  yield* spendMailboxBootstrap(busDir, installation, config, exists);
  if (exists)
    return yield* new LedgerError({
      message:
        "The intended first-create ledger already exists. The reservation is spent; the ledger was not attached or changed.",
    });
  const result = yield* Fluree.createFlureeLedgerOnce(config);
  if (result.status !== "CREATED" || result.cut.head !== 1)
    return yield* new LedgerError({
      message:
        "Ledger creation is uncertain or conflicted; do not retry without operator recovery.",
    });

  const binding = nativeServeBinding(input, result.cut.incarnation);
  yield* verifyServeHistory(binding).pipe(Effect.provide(provider));
  yield* requireStoreBinding(config, installation);
  yield* completeMailboxBootstrap(busDir, installation, config, binding.incarnation);
  yield* persistServeBinding(busDir, binding);
  return { config, binding } satisfies Serving;
});

const cli = Command.make("agent-bus").pipe(
  Command.withDescription("Pub/sub message bus between Claude and Codex sessions"),
  Command.withSubcommands([
    serve,
    verifyServeBinding,
    bindExistingLedger,
    initialize,
    joinCommand,
    orientCommand,
    publish,
    peers,
    claudeWakeHook,
    compactContext,
  ])
);

Command.run(cli, { version: BUILD }).pipe(
  // A refused or failed bus call, a missing store or an incomplete installation is an
  // answer, not a crash:
  // its message alone, and status 1.
  Effect.catchTags({ BusCallError: fail, NoStore: fail, InstallationError: fail }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  Effect.provide(Layer.succeed(Logger.LogToStderr)(true)),
  BunRuntime.runMain
);
