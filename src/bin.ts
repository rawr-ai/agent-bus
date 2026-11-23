#!/usr/bin/env -S bun --no-env-file
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
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
import { cursorTransition, verifyMailboxTransitionSentinelText } from "./cursor-layout.ts";
import { cursorWriterIsStopped } from "./cursor-quiescence.ts";
import { Association, LedgerError, Runtime } from "./domain.ts";
import * as Fluree from "./Fluree.ts";
import { initializeInstallation, loadInstallation } from "./installation.ts";
import * as Ledger from "./Ledger.ts";
import {
  checkExistingMailboxBootstrap,
  completeMailboxBootstrap,
  inspectMailboxBootstrap,
  spendMailboxBootstrap,
} from "./mailbox-bootstrap.ts";
import {
  captureMailboxSource,
  importMailboxPositions,
  legacyCursorPath,
  type MailboxSource,
  MailboxSourceJson,
  verifyMailboxImport,
} from "./mailbox-import.ts";
import {
  acceptMailboxTransitionPeer,
  assertMailboxTransitionAdmitted,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  MAILBOX_TRANSITION_EVIDENCE_FILES,
  MAILBOX_TRANSITION_READY_COMPLETE_FILE,
  permitMailboxTransitionServe,
  recordMailboxTransitionReady,
} from "./mailbox-transition-admission.ts";
import {
  buildMailboxTransitionSentinel,
  installMailboxTransitionGuard,
  verifyMailboxTransitionGuard,
} from "./mailbox-transition-guard.ts";
import { Peers, Published } from "./mcp-tools.ts";
import { OrientationResult } from "./orientation-model.ts";
import { type Pin, QueryGateway } from "./Query.ts";
import * as Serve from "./serve.ts";
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
interface ServeBinding {
  readonly config: Fluree.FlureeConfig;
  readonly installation: string;
  readonly incarnation: string;
  readonly kind: "native" | "transition";
}

const BusLayer = (binding: ServeBinding) => {
  const verified = Layer.effectDiscard(verifyServingLedger(binding)).pipe(
    Layer.provideMerge(Fluree.layerFluree(binding.config, { existingOnly: true }))
  );
  return Bus.layer(binding.installation).pipe(Layer.provideMerge(verified));
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

const confirmCursorWriterOffline = Effect.try({
  try: () => {
    if (process.platform !== "darwin") return false;
    return cursorWriterIsStopped(
      process.env.AGENT_BUS_LABEL,
      process.getuid?.(),
      process.env.AGENT_BUS_PORT,
      (command, args, capture) => {
        const result = Bun.spawnSync([command, ...args], {
          env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          stdout: capture === "stderr" ? "ignore" : "pipe",
          stderr: capture === "stdout" ? "ignore" : "pipe",
        });
        const text = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
        return { status: result.exitCode, text };
      }
    );
  },
  catch: () => false,
}).pipe(
  Effect.orElseSucceed(() => false),
  Effect.flatMap((offline) =>
    offline
      ? Effect.void
      : Effect.fail(
          new LedgerError({
            message:
              "Cursor transition refused: set AGENT_BUS_LABEL and AGENT_BUS_PORT to the verified owned serve job and its port. Disable and boot out that job and confirm the port is clear before changing cursor state.",
          })
        )
  )
);

const cursors = Command.make(
  "cursors",
  { action: Flag.Literals("action", ["check", "migrate", "export", "abort-export"]) },
  ({ action }) =>
    Effect.gen(function* () {
      const installation = yield* loadInstallation(busDir);
      if (action !== "check") {
        yield* confirmCursorWriterOffline;
      }
      const config = yield* flureeConfig;
      const report = yield* Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger;
        return yield* cursorTransition(
          yield* legacyCursorPath(busDir, config.ledger, ledger.instance),
          installation,
          action,
          confirmCursorWriterOffline
        );
      }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
      yield* Console.log(JSON.stringify({ installation, ...report }));
    }).pipe(Effect.catchTag("LedgerError", fail))
).pipe(
  Command.withDescription(
    "Exact-address cursor layout v2: check without writing; other actions require serve disabled, unloaded and off its port"
  )
);

const mailboxSource = Command.make("mailbox-source", {}, () =>
  Effect.gen(function* () {
    yield* confirmCursorWriterOffline;
    const config = yield* flureeConfig;
    const proof = yield* Effect.gen(function* () {
      const ledger = yield* Ledger.Ledger;
      const { cut } = yield* ledger.presenceAt();
      return yield* captureMailboxSource(busDir, config.ledger, cut, confirmCursorWriterOffline);
    }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
    yield* Console.log(JSON.stringify(proof));
  }).pipe(Effect.catchTag("LedgerError", fail))
).pipe(
  Command.withDescription(
    "Capture the stopped local installation's exact cursor inventory at the current ledger cut, without writing"
  )
);

const invalidMailboxSource = () =>
  new LedgerError({ message: "Mailbox import requires readable, valid retained source receipts." });

/** Open bounded external evidence without following a replaced or dangling symlink. */
const readEvidence = (file: string, limit: number) =>
  Effect.tryPromise({
    try: async () => {
      const original = await lstat(file);
      if (!original.isFile() || original.size > limit) throw new Error();
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.size > limit ||
          before.ino !== original.ino ||
          before.dev !== original.dev
        )
          throw new Error();
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        const after = await handle.stat();
        if (
          size > limit ||
          size !== before.size ||
          after.size !== size ||
          after.mtimeMs !== before.mtimeMs
        )
          throw new Error();
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      new LedgerError({
        message: "Mailbox transition evidence is missing, unsafe, or unreadable.",
      }),
  });

const readMailboxSource = (file: string) =>
  readEvidence(file, 4096).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MailboxSourceJson, { onExcessProperty: "error" })),
    Effect.mapError(invalidMailboxSource)
  );

const transitionRefusal = (message: string) =>
  new LedgerError({ message: `Mailbox transition refused: ${message}` });

const transitionAttestations = (operation: string, paired: boolean, settled: boolean) =>
  Effect.gen(function* () {
    if (!paired)
      return yield* transitionRefusal("attest both holds with --paired-holds-confirmed.");
    if (!settled)
      return yield* transitionRefusal("attest provider settlement with --provider-settled.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operation)) {
      return yield* transitionRefusal(
        "--operation must be a lowercase UUIDv7 retained for every retry."
      );
    }
  });

const requiredTransitionFlag = (value: Option.Option<string>, flag: string) =>
  Option.match(value, {
    onNone: () => Effect.fail(transitionRefusal(`${flag} is required for this action.`)),
    onSome: (text) =>
      text.length === 0
        ? Effect.fail(transitionRefusal(`${flag} is required for this action.`))
        : Effect.succeed(text),
  });

const sortedSources = (
  first: MailboxSource,
  second: MailboxSource
): readonly [MailboxSource, MailboxSource] =>
  first.installation < second.installation ? [first, second] : [second, first];

const sameMailboxSource = (first: MailboxSource, second: MailboxSource) =>
  first.version === second.version &&
  first.ledger === second.ledger &&
  first.installation === second.installation &&
  first.cut.incarnation === second.cut.incarnation &&
  first.cut.head === second.cut.head &&
  first.capturedAt === second.capturedAt &&
  first.digest === second.digest;

const requireTransitionAnchors = (
  sources: readonly [MailboxSource, MailboxSource],
  localInstallation: string,
  expectedLocalInstallation: string,
  expectedPeerInstallation: string,
  expectedIncarnation: string
) =>
  Effect.gen(function* () {
    const [first, second] = sources;
    if (
      expectedLocalInstallation === expectedPeerInstallation ||
      localInstallation !== expectedLocalInstallation ||
      ![first.installation, second.installation].includes(expectedLocalInstallation) ||
      ![first.installation, second.installation].includes(expectedPeerInstallation) ||
      first.installation === second.installation ||
      expectedIncarnation === "" ||
      first.cut.incarnation !== expectedIncarnation ||
      second.cut.incarnation !== expectedIncarnation
    )
      return yield* transitionRefusal(
        "the installation pair or incarnation does not match the independent preflight anchor."
      );
  });

const verifyHeldTransition = (
  ledgerName: string,
  sources: readonly [MailboxSource, MailboxSource],
  installation: string,
  operation: string,
  peerFile: string,
  expectedLocalInstallation: string,
  expectedPeerInstallation: string,
  expectedIncarnation: string
) =>
  Effect.gen(function* () {
    yield* requireTransitionAnchors(
      sources,
      installation,
      expectedLocalInstallation,
      expectedPeerInstallation,
      expectedIncarnation
    );
    yield* confirmCursorWriterOffline;
    const ledger = yield* Ledger.Ledger;
    if (
      ledger.instance !== expectedIncarnation ||
      (yield* ledger.presenceAt()).cut.incarnation !== expectedIncarnation
    ) {
      return yield* transitionRefusal(
        "the current ledger incarnation does not match the independent preflight anchor."
      );
    }
    yield* verifyMailboxTransitionGuard(busDir, ledgerName, sources, installation, operation);
    const peer =
      sources[0].installation === installation ? sources[1].installation : sources[0].installation;
    const expected = yield* buildMailboxTransitionSentinel(ledgerName, sources, peer, operation);
    yield* verifyMailboxTransitionSentinelText(yield* readEvidence(peerFile, 4096), expected);
    yield* confirmCursorWriterOffline;
    yield* verifyMailboxTransitionGuard(busDir, ledgerName, sources, installation, operation);
    if ((yield* ledger.presenceAt()).cut.incarnation !== expectedIncarnation) {
      return yield* transitionRefusal(
        "the current ledger incarnation changed; keep both writers held."
      );
    }
  });

const inspectLegacyEvidence = (ledgerName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const infoAt = (path: string) =>
      fs
        .lstat(path)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(undefined)
              : Effect.fail(transitionRefusal("could not inspect the local installation."))
          )
        );
    const root = yield* infoAt(busDir);
    if (root?.type !== "Directory") {
      return yield* transitionRefusal("the installation root is not a real directory.");
    }
    const cursors = join(busDir, "fluree-cursors");
    const cursorRoot = yield* infoAt(cursors);
    if (cursorRoot !== undefined && cursorRoot.type !== "Directory") {
      return yield* transitionRefusal("the legacy cursor root is not a real directory.");
    }
    const encoded = yield* Effect.try({
      try: () => encodeURIComponent(ledgerName),
      catch: () => transitionRefusal("the configured ledger is invalid."),
    });
    if (encoded === "" || encoded === "." || encoded === "..") {
      return yield* transitionRefusal("the configured ledger is invalid.");
    }
    const legacy = yield* infoAt(join(cursors, encoded));
    if (legacy !== undefined && legacy.type !== "Directory") {
      return yield* transitionRefusal("the legacy ledger cursor root is not a real directory.");
    }
    let evidence = false;
    for (const name of MAILBOX_TRANSITION_EVIDENCE_FILES) {
      if ((yield* infoAt(join(busDir, name))) !== undefined) evidence = true;
    }
    return cursorRoot !== undefined || evidence;
  });

const verifyTransitionActivation = (source: Pin, operation: string, sourceCommit: string) =>
  Effect.gen(function* () {
    if (sourceCommit.length === 0 || sourceCommit.length > 4096) {
      return yield* transitionRefusal("the independently retained source commit is invalid.");
    }
    const ledger = yield* Ledger.Ledger;
    const witness = yield* ledger.ownershipActivationAt({ source, operation });
    if (witness.sourceCommit !== sourceCommit) {
      return yield* transitionRefusal(
        "the ownership activation does not match the retained source commit."
      );
    }
  });

const verifyCapturedSource = (source: Pin, sourceCommit: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger.Ledger;
    const gateway = yield* QueryGateway;
    const before = yield* gateway.pin;
    if (
      ledger.instance !== source.incarnation ||
      before.incarnation !== source.incarnation ||
      before.head !== source.head
    ) {
      return yield* transitionRefusal(
        "the actual ledger is not at the captured cut; keep both writers held."
      );
    }
    if ((yield* ledger.sourceCommitAt(source)) !== sourceCommit) {
      return yield* transitionRefusal(
        "the captured source commit does not match the independently retained CID."
      );
    }
    const after = yield* gateway.pin;
    if (after.incarnation !== source.incarnation || after.head !== source.head) {
      return yield* transitionRefusal("the actual ledger changed while checking the captured cut.");
    }
  });

const recoveredFlureeConfig = (configFile: string, tokenFile: string) =>
  Effect.gen(function* () {
    const refused = () =>
      transitionRefusal("cannot establish separate original and recovered-copy credentials.");
    const original = (yield* loadConfig.pipe(Effect.mapError(refused))).fluree;
    if (original === undefined) return yield* refused();
    const liveToken = (yield* readEvidence(join(busDir, "fluree-token"), 8192)).trim();
    const recovered = yield* Schema.decodeUnknownEffect(ConfigJson, { onExcessProperty: "error" })(
      yield* readEvidence(configFile, 4096)
    ).pipe(Effect.mapError(refused));
    if (recovered.fluree === undefined) return yield* refused();
    const token = (yield* readEvidence(tokenFile, 8192)).trim();
    const origin = (value: string) =>
      Effect.try({
        try: () => {
          const url = new URL(value);
          if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.username !== "" ||
            url.password !== "" ||
            url.pathname !== "/" ||
            url.search !== "" ||
            url.hash !== ""
          )
            throw new Error();
          return url.origin;
        },
        catch: refused,
      });
    if (
      liveToken.length === 0 ||
      token.length === 0 ||
      /[\s\x00-\x1f\x7f]/.test(token) ||
      original.ledger !== recovered.fluree.ledger ||
      token === liveToken ||
      (yield* origin(original.url)) === (yield* origin(recovered.fluree.url))
    )
      return yield* refused();
    return { ...recovered.fluree, token };
  });

const checkTransitionAdmission = (
  config: Fluree.FlureeConfig,
  installation: string,
  incarnation: string
) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger.Ledger;
    yield* assertMailboxTransitionAdmitted(
      { busDir, ledgerName: config.ledger, incarnation, localInstallation: installation },
      (binding) =>
        Effect.gen(function* () {
          yield* verifyMailboxTransitionGuard(
            busDir,
            config.ledger,
            binding.sources,
            binding.localInstallation,
            binding.operation
          );
          yield* verifyTransitionActivation(
            binding.sources[0].cut,
            binding.operation,
            binding.sourceCommit
          );
        }).pipe(Effect.provideService(Ledger.Ledger, ledger))
    );
  });

const requireStoreBinding = (config: Fluree.FlureeConfig, installation: string) =>
  Effect.gen(function* () {
    if ((yield* loadInstallation(busDir)) !== installation) {
      return yield* transitionRefusal(
        "the local installation changed; operator recovery is required."
      );
    }
    const current = yield* flureeConfig;
    if (
      current.url !== config.url ||
      current.ledger !== config.ledger ||
      current.token !== config.token
    ) {
      return yield* transitionRefusal(
        "the configured store changed; operator recovery is required."
      );
    }
  });

const verifyNativeEra = Effect.gen(function* () {
  const ledger = yield* Ledger.Ledger;
  const cut = yield* (yield* QueryGateway).pin;
  if (cut.incarnation !== ledger.instance || (yield* ledger.ownershipEraAt(cut)) !== 1) {
    return yield* transitionRefusal(
      "this ledger was not born with the ownership era; paired admission is required."
    );
  }
  return ledger.instance;
});

/** Every serving Ledger is reopened existing-only and rechecked before Bus is built. */
const verifyServingLedger = (binding: ServeBinding) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger.Ledger;
    yield* requireStoreBinding(binding.config, binding.installation);
    if (ledger.instance !== binding.incarnation) {
      return yield* transitionRefusal(
        "the ledger incarnation changed; operator recovery is required."
      );
    }
    yield* checkExistingMailboxBootstrap(busDir, binding.installation, binding.config);
    if (binding.kind === "transition") {
      yield* checkTransitionAdmission(binding.config, binding.installation, ledger.instance);
    } else {
      if (yield* inspectLegacyEvidence(binding.config.ledger)) {
        return yield* transitionRefusal(
          "legacy state appeared before serving; paired admission is required."
        );
      }
      const state = yield* inspectMailboxBootstrap(busDir, binding.installation, binding.config);
      if (state.kind !== "complete" || state.incarnation !== ledger.instance) {
        return yield* transitionRefusal("the native bootstrap binding is missing or changed.");
      }
      yield* verifyNativeEra;
    }
  });

/** The only creating dispatch follows an exclusive, durable one-shot grant spend. */
const preServeAdmission = Effect.gen(function* () {
  const config = yield* flureeConfig;
  const installation = yield* loadInstallation(busDir);
  yield* checkExistingMailboxBootstrap(busDir, installation, config);
  if (yield* inspectLegacyEvidence(config.ledger)) {
    const incarnation = yield* Effect.gen(function* () {
      const ledger = yield* Ledger.Ledger;
      yield* checkTransitionAdmission(config, installation, ledger.instance);
      return ledger.instance;
    }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
    return { config, installation, incarnation, kind: "transition" } satisfies ServeBinding;
  }

  const state = yield* inspectMailboxBootstrap(busDir, installation, config);
  const exists = yield* Fluree.flureeLedgerExists(config);
  if (!exists && state.kind !== "unspent") {
    return yield* transitionRefusal(
      "the ledger is absent and this installation has no unspent creation grant."
    );
  }
  yield* requireStoreBinding(config, installation);
  if (yield* inspectLegacyEvidence(config.ledger)) {
    return yield* transitionRefusal(
      "legacy state appeared during bootstrap; paired admission is required."
    );
  }
  if (state.kind === "unspent") yield* spendMailboxBootstrap(busDir, installation, config, exists);

  let created: string | undefined;
  if (!exists) {
    const result = yield* Fluree.createFlureeLedgerOnce(config);
    if (result.status !== "CREATED" || result.cut.head !== 1) {
      return yield* transitionRefusal(
        "ledger creation is uncertain or conflicted; do not retry without operator recovery."
      );
    }
    created = result.cut.incarnation;
  }
  const incarnation = yield* verifyNativeEra.pipe(
    Effect.provide(Fluree.layerFluree(config, { existingOnly: true }))
  );
  if (
    (created !== undefined && incarnation !== created) ||
    (state.kind === "complete" && incarnation !== state.incarnation)
  ) {
    return yield* transitionRefusal(
      "the ledger incarnation changed; operator recovery is required."
    );
  }
  yield* requireStoreBinding(config, installation);
  if (yield* inspectLegacyEvidence(config.ledger)) {
    return yield* transitionRefusal(
      "legacy state appeared during bootstrap; paired admission is required."
    );
  }
  if (state.kind !== "complete") {
    yield* completeMailboxBootstrap(
      busDir,
      installation,
      config,
      incarnation,
      state.kind === "unspent" ? "grant" : "existing"
    );
  }
  return { config, installation, incarnation, kind: "native" } satisfies ServeBinding;
});

const mailboxImport = Command.make(
  "mailbox-import",
  {
    firstState: Flag.String("first-state").pipe(
      Flag.withDescription("The first held installation's copied state root")
    ),
    firstReceipt: Flag.String("first-receipt").pipe(
      Flag.withDescription("The first installation's independently retained mailbox-source receipt")
    ),
    secondState: Flag.String("second-state").pipe(
      Flag.withDescription("The second held installation's copied state root")
    ),
    secondReceipt: Flag.String("second-receipt").pipe(
      Flag.withDescription(
        "The second installation's independently retained mailbox-source receipt"
      )
    ),
    pairedHoldsConfirmed: Flag.Boolean("paired-holds-confirmed").pipe(
      Flag.withDescription(
        "Attest both old serve jobs are held through reconciliation and activation"
      )
    ),
    providerSettled: Flag.Boolean("provider-settled").pipe(
      Flag.withDescription("Attest that all old writer provider requests have settled")
    ),
    operation: Flag.String("operation").pipe(
      Flag.withDescription("Retained lowercase UUIDv7 identifying this transition")
    ),
    sourceCommit: Flag.String("source-commit").pipe(
      Flag.withDescription("Independently recovered full commit CID at the captured source cut")
    ),
    peerSentinel: Flag.String("peer-sentinel").pipe(
      Flag.withDescription("The peer sentinel transferred over trusted transport")
    ),
    expectedLocalInstallation: Flag.String("expected-local-installation").pipe(
      Flag.withDescription("Local installation ID from the independent preflight anchor")
    ),
    expectedPeerInstallation: Flag.String("expected-peer-installation").pipe(
      Flag.withDescription("Peer installation ID from the independent preflight anchor")
    ),
    expectedIncarnation: Flag.String("expected-incarnation").pipe(
      Flag.withDescription("Ledger incarnation from the independent preflight anchor")
    ),
  },
  ({
    firstState,
    firstReceipt,
    secondState,
    secondReceipt,
    pairedHoldsConfirmed,
    providerSettled,
    operation,
    sourceCommit,
    peerSentinel,
    expectedLocalInstallation,
    expectedPeerInstallation,
    expectedIncarnation,
  }) =>
    Effect.gen(function* () {
      yield* transitionAttestations(operation, pairedHoldsConfirmed, providerSettled);
      if (sourceCommit.length === 0 || sourceCommit.length > 4096) {
        return yield* transitionRefusal("the independently retained source commit is invalid.");
      }
      const config = yield* flureeConfig;
      const installation = yield* loadInstallation(busDir);
      const first = yield* readMailboxSource(firstReceipt);
      const second = yield* readMailboxSource(secondReceipt);
      const sources = sortedSources(first, second);
      yield* requireTransitionAnchors(
        sources,
        installation,
        expectedLocalInstallation,
        expectedPeerInstallation,
        expectedIncarnation
      );
      yield* buildMailboxTransitionSentinel(config.ledger, sources, installation, operation);
      yield* verifyTransitionActivation(sources[0].cut, operation, sourceCommit).pipe(
        Effect.provide(Fluree.layerFluree(config, { existingOnly: true }))
      );
      yield* confirmCursorWriterOffline;
      const fs = yield* FileSystem.FileSystem;
      const copies = [
        { root: firstState, receipt: first },
        { root: secondState, receipt: second },
      ] as const;
      const proof = yield* Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger;
        const held = Effect.gen(function* () {
          yield* verifyHeldTransition(
            config.ledger,
            sources,
            installation,
            operation,
            peerSentinel,
            expectedLocalInstallation,
            expectedPeerInstallation,
            expectedIncarnation
          );
          yield* verifyTransitionActivation(sources[0].cut, operation, sourceCommit);
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Ledger.Ledger, ledger)
        );
        yield* held;
        const report = yield* importMailboxPositions(config.ledger, copies, installation, held);
        yield* held;
        yield* Console.log(
          JSON.stringify({
            phase: "import-report-not-admission",
            localHold: "checked-disabled-unloaded-and-off-port",
            pairedHolds: "operator-attested",
            providerSettlement: "operator-attested",
            ...report,
          })
        );
        const verified = yield* verifyMailboxImport(config.ledger, copies, installation);
        yield* held;
        return verified;
      }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
      yield* Console.log(
        JSON.stringify({
          localHold: "checked-disabled-unloaded-and-off-port",
          pairedHolds: "operator-attested",
          providerSettlement: "operator-attested",
          peerSentinel: "content-verified-not-peer-liveness",
          verifiedAt: proof.verifiedAt,
          rows: proof.rows,
        })
      );
    }).pipe(Effect.catchTag("LedgerError", fail))
).pipe(
  Command.withDescription(
    "Import verified exact cursor copies into absent ledger mailboxes once, with both old writers held"
  )
);

const mailboxTransition = Command.make(
  "mailbox-transition",
  {
    action: Flag.Literals("action", ["check-source", "fence", "era", "ready", "admit", "permit"]),
    firstReceipt: Flag.String("first-receipt").pipe(
      Flag.withDescription("First retained source receipt"),
      Flag.optional
    ),
    secondReceipt: Flag.String("second-receipt").pipe(
      Flag.withDescription("Second retained source receipt"),
      Flag.optional
    ),
    operation: Flag.String("operation").pipe(
      Flag.withDescription("Retained lowercase UUIDv7 for the transition"),
      Flag.optional
    ),
    expectedLocalInstallation: Flag.String("expected-local-installation").pipe(
      Flag.withDescription("Local installation ID from the independent preflight anchor"),
      Flag.optional
    ),
    expectedPeerInstallation: Flag.String("expected-peer-installation").pipe(
      Flag.withDescription("Peer installation ID from the independent preflight anchor"),
      Flag.optional
    ),
    expectedIncarnation: Flag.String("expected-incarnation").pipe(
      Flag.withDescription("Ledger incarnation from the independent preflight anchor"),
      Flag.optional
    ),
    pairedHoldsConfirmed: Flag.Boolean("paired-holds-confirmed").pipe(
      Flag.withDescription("Attest both original serve jobs are held"),
      Flag.withDefault(false)
    ),
    providerSettled: Flag.Boolean("provider-settled").pipe(
      Flag.withDescription("Attest all old writer provider requests have settled"),
      Flag.withDefault(false)
    ),
    firstState: Flag.String("first-state").pipe(
      Flag.withDescription("First copied state root"),
      Flag.optional
    ),
    secondState: Flag.String("second-state").pipe(
      Flag.withDescription("Second copied state root"),
      Flag.optional
    ),
    peerSentinel: Flag.String("peer-sentinel").pipe(
      Flag.withDescription("Peer sentinel transferred over trusted transport"),
      Flag.optional
    ),
    peerReady: Flag.String("peer-ready").pipe(
      Flag.withDescription("Peer completed ready attestation transferred over trusted transport"),
      Flag.optional
    ),
    peerAdmitted: Flag.String("peer-admitted").pipe(
      Flag.withDescription("Peer completed admission transferred over trusted transport"),
      Flag.optional
    ),
    sourceCommit: Flag.String("source-commit").pipe(
      Flag.withDescription("Independently recovered full commit CID at the captured source cut"),
      Flag.optional
    ),
    expectedHead: Flag.Int("expected-head").pipe(
      Flag.withDescription("Independently retained source head for the recovered-copy check"),
      Flag.optional
    ),
    recoveredConfig: Flag.String("recovered-config").pipe(
      Flag.withDescription("Separately provisioned recovered-copy Fluree config"),
      Flag.optional
    ),
    recoveredToken: Flag.String("recovered-token").pipe(
      Flag.withDescription("Separately provisioned recovered-copy Fluree token file"),
      Flag.optional
    ),
  },
  (raw) =>
    Effect.gen(function* () {
      if (raw.action === "check-source") {
        const configFile = yield* requiredTransitionFlag(raw.recoveredConfig, "--recovered-config");
        const tokenFile = yield* requiredTransitionFlag(raw.recoveredToken, "--recovered-token");
        const incarnation = yield* requiredTransitionFlag(
          raw.expectedIncarnation,
          "--expected-incarnation"
        );
        const sourceCommit = yield* requiredTransitionFlag(raw.sourceCommit, "--source-commit");
        if (
          Option.isNone(raw.expectedHead) ||
          !Number.isSafeInteger(raw.expectedHead.value) ||
          raw.expectedHead.value < 1
        ) {
          return yield* transitionRefusal("--expected-head must be a positive integer.");
        }
        if (sourceCommit.length > 4096)
          return yield* transitionRefusal("the independently retained source commit is invalid.");
        const config = yield* recoveredFlureeConfig(configFile, tokenFile);
        const source = { incarnation, head: raw.expectedHead.value };
        yield* verifyCapturedSource(source, sourceCommit).pipe(
          Effect.provide(Fluree.layerFluree(config, { existingOnly: true })),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
        );
        yield* Console.log(JSON.stringify({ status: "verified", cut: source }));
        return;
      }
      const input = {
        ...raw,
        operation: yield* requiredTransitionFlag(raw.operation, "--operation"),
        firstReceipt: yield* requiredTransitionFlag(raw.firstReceipt, "--first-receipt"),
        secondReceipt: yield* requiredTransitionFlag(raw.secondReceipt, "--second-receipt"),
        expectedLocalInstallation: yield* requiredTransitionFlag(
          raw.expectedLocalInstallation,
          "--expected-local-installation"
        ),
        expectedPeerInstallation: yield* requiredTransitionFlag(
          raw.expectedPeerInstallation,
          "--expected-peer-installation"
        ),
        expectedIncarnation: yield* requiredTransitionFlag(
          raw.expectedIncarnation,
          "--expected-incarnation"
        ),
      };
      yield* transitionAttestations(
        input.operation,
        input.pairedHoldsConfirmed,
        input.providerSettled
      );
      const needsCopies = input.action === "ready" || input.action === "admit";
      const firstState = needsCopies
        ? yield* requiredTransitionFlag(input.firstState, "--first-state")
        : undefined;
      const secondState = needsCopies
        ? yield* requiredTransitionFlag(input.secondState, "--second-state")
        : undefined;
      const peerSentinel =
        input.action === "fence"
          ? undefined
          : yield* requiredTransitionFlag(input.peerSentinel, "--peer-sentinel");
      const peerReady =
        input.action === "admit"
          ? yield* requiredTransitionFlag(input.peerReady, "--peer-ready")
          : undefined;
      const peerAdmitted =
        input.action === "permit"
          ? yield* requiredTransitionFlag(input.peerAdmitted, "--peer-admitted")
          : undefined;
      const sourceCommit = yield* requiredTransitionFlag(input.sourceCommit, "--source-commit");
      if (sourceCommit.length > 4096) {
        return yield* transitionRefusal("the independently retained source commit is invalid.");
      }
      const config = yield* flureeConfig;
      const installation = yield* loadInstallation(busDir);
      const first = yield* readMailboxSource(input.firstReceipt);
      const second = yield* readMailboxSource(input.secondReceipt);
      const sources = sortedSources(first, second);
      yield* requireTransitionAnchors(
        sources,
        installation,
        input.expectedLocalInstallation,
        input.expectedPeerInstallation,
        input.expectedIncarnation
      );
      yield* buildMailboxTransitionSentinel(config.ledger, sources, installation, input.operation);
      if (input.action === "fence") {
        yield* verifyCapturedSource(sources[0].cut, sourceCommit).pipe(
          Effect.provide(Fluree.layerFluree(config, { existingOnly: true }))
        );
      } else if (input.action !== "era") {
        yield* verifyTransitionActivation(sources[0].cut, input.operation, sourceCommit).pipe(
          Effect.provide(Fluree.layerFluree(config, { existingOnly: true }))
        );
      }
      yield* confirmCursorWriterOffline;

      if (input.action === "fence") {
        const sentinel = yield* Effect.gen(function* () {
          const ledger = yield* Ledger.Ledger;
          const gateway = yield* QueryGateway;
          const atCapturedCut = Effect.gen(function* () {
            yield* requireTransitionAnchors(
              sources,
              installation,
              input.expectedLocalInstallation,
              input.expectedPeerInstallation,
              input.expectedIncarnation
            );
            yield* confirmCursorWriterOffline;
            yield* verifyCapturedSource(sources[0].cut, sourceCommit).pipe(
              Effect.provideService(Ledger.Ledger, ledger),
              Effect.provideService(QueryGateway, gateway)
            );
            yield* confirmCursorWriterOffline;
          });
          yield* atCapturedCut;
          const installed = yield* installMailboxTransitionGuard(
            busDir,
            config.ledger,
            sources,
            installation,
            input.operation,
            atCapturedCut
          );
          yield* atCapturedCut;
          yield* verifyMailboxTransitionGuard(
            busDir,
            config.ledger,
            sources,
            installation,
            input.operation
          );
          yield* atCapturedCut;
          return installed;
        }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
        yield* Console.log(
          JSON.stringify({
            marker: join(
              busDir,
              "fluree-cursors",
              encodeURIComponent(config.ledger),
              `${sentinel.cut.incarnation}.v2`,
              ".export-pending"
            ),
            localHold: "checked-disabled-unloaded-and-off-port",
            pairedHolds: "operator-attested",
            providerSettlement: "operator-attested",
          })
        );
        return;
      }
      if (input.action === "era") {
        if (peerSentinel === undefined) {
          return yield* transitionRefusal(
            "the peer sentinel and captured source commit are required."
          );
        }
        const result = yield* Effect.gen(function* () {
          const ledger = yield* Ledger.Ledger;
          const held = verifyHeldTransition(
            config.ledger,
            sources,
            installation,
            input.operation,
            peerSentinel,
            input.expectedLocalInstallation,
            input.expectedPeerInstallation,
            input.expectedIncarnation
          );
          yield* held;
          const activated = yield* ledger
            .activateOwnershipEra({
              source: sources[0].cut,
              commit: sourceCommit,
              operation: input.operation,
            })
            .pipe(Effect.onExit(() => held));
          if (activated.status === "UNKNOWN") {
            return yield* transitionRefusal(
              "the era activation may have committed; retain both holds and retry the same operation."
            );
          }
          if (activated.status === "CONFLICT") {
            return yield* transitionRefusal(
              "the captured era activation conflicts; retain both holds for review."
            );
          }
          yield* verifyTransitionActivation(sources[0].cut, input.operation, sourceCommit);
          return activated;
        }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
        yield* Console.log(
          JSON.stringify({
            activation: result.status,
            cut: result.cut,
            commit: result.commit,
            localHold: "checked-disabled-unloaded-and-off-port",
            pairedHolds: "operator-attested",
            providerSettlement: "operator-attested",
            peerSentinel: "content-verified-not-peer-liveness",
          })
        );
        return;
      }

      if (input.action === "permit") {
        if (peerSentinel === undefined || peerAdmitted === undefined) {
          return yield* transitionRefusal(
            "the transferred peer sentinel and admission are required."
          );
        }
        const peerBytes = yield* readEvidence(peerAdmitted, 1024 * 1024);
        yield* Effect.gen(function* () {
          const ledger = yield* Ledger.Ledger;
          yield* permitMailboxTransitionServe(
            {
              busDir,
              ledgerName: config.ledger,
              incarnation: input.expectedIncarnation,
              localInstallation: installation,
            },
            peerBytes,
            {
              confirmLocalHeld: () => confirmCursorWriterOffline,
              verifyLocalFence: (binding) =>
                Effect.gen(function* () {
                  if (
                    binding.operation !== input.operation ||
                    binding.sourceCommit !== sourceCommit ||
                    binding.localInstallation !== installation ||
                    !sameMailboxSource(binding.sources[0], sources[0]) ||
                    !sameMailboxSource(binding.sources[1], sources[1])
                  )
                    return yield* transitionRefusal(
                      "the admitted operation does not match the retained source receipts."
                    );
                  yield* verifyHeldTransition(
                    config.ledger,
                    binding.sources,
                    binding.localInstallation,
                    binding.operation,
                    peerSentinel,
                    input.expectedLocalInstallation,
                    input.expectedPeerInstallation,
                    input.expectedIncarnation
                  );
                  yield* verifyTransitionActivation(
                    binding.sources[0].cut,
                    binding.operation,
                    binding.sourceCommit
                  );
                  if ((yield* readEvidence(peerAdmitted, 1024 * 1024)) !== peerBytes) {
                    return yield* transitionRefusal("the transferred peer admission changed.");
                  }
                }).pipe(Effect.provideService(Ledger.Ledger, ledger)),
            }
          );
        }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
        yield* Console.log(
          JSON.stringify({
            permitted: true,
            localHold: "checked-disabled-unloaded-and-off-port",
            pairedHolds: "operator-attested",
            providerSettlement: "operator-attested",
            peerSentinel: "content-verified-not-peer-liveness",
            startedServices: false,
          })
        );
        return;
      }

      if (firstState === undefined || secondState === undefined || peerSentinel === undefined) {
        return yield* transitionRefusal(
          "both copied roots and the transferred peer sentinel are required."
        );
      }
      const copies = [
        { root: firstState, receipt: first },
        { root: secondState, receipt: second },
      ] as const;
      const peerBytes =
        peerReady === undefined ? undefined : yield* readEvidence(peerReady, 1024 * 1024);
      const proof = yield* Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger;
        yield* verifyHeldTransition(
          config.ledger,
          sources,
          installation,
          input.operation,
          peerSentinel,
          input.expectedLocalInstallation,
          input.expectedPeerInstallation,
          input.expectedIncarnation
        );
        yield* verifyTransitionActivation(sources[0].cut, input.operation, sourceCommit);
        const verified = yield* verifyMailboxImport(config.ledger, copies, installation);
        const expected = JSON.stringify(verified);
        const checks = {
          confirmLocalHeld: () => confirmCursorWriterOffline,
          verifyLocalFence: (binding: {
            readonly sources: readonly [MailboxSource, MailboxSource];
            readonly localInstallation: string;
            readonly operation: string;
            readonly sourceCommit: string;
          }) =>
            Effect.gen(function* () {
              if (
                binding.operation !== input.operation ||
                binding.sourceCommit !== sourceCommit ||
                binding.localInstallation !== installation ||
                !sameMailboxSource(binding.sources[0], sources[0]) ||
                !sameMailboxSource(binding.sources[1], sources[1])
              )
                return yield* transitionRefusal(
                  "the admitted operation does not match the retained source receipts."
                );
              yield* verifyHeldTransition(
                config.ledger,
                binding.sources,
                binding.localInstallation,
                binding.operation,
                peerSentinel,
                input.expectedLocalInstallation,
                input.expectedPeerInstallation,
                input.expectedIncarnation
              );
              yield* verifyTransitionActivation(
                binding.sources[0].cut,
                binding.operation,
                binding.sourceCommit
              );
              if (
                peerReady !== undefined &&
                (yield* readEvidence(peerReady, 1024 * 1024)) !== peerBytes
              ) {
                return yield* transitionRefusal("the transferred peer ready attestation changed.");
              }
              const current = yield* verifyMailboxImport(config.ledger, copies, installation).pipe(
                Effect.provideService(Ledger.Ledger, ledger)
              );
              if (JSON.stringify(current) !== expected) {
                return yield* transitionRefusal(
                  "the verified import proof changed; keep both writers held."
                );
              }
            }).pipe(
              Effect.catchTag("InstallationError", () =>
                Effect.fail(transitionRefusal("a copied installation could not be verified."))
              ),
              Effect.provideService(Ledger.Ledger, ledger)
            ),
        };
        const transition = {
          busDir,
          operation: input.operation,
          sourceCommit,
          sources,
          localInstallation: installation,
          proof: verified,
        };
        if (input.action === "ready") {
          yield* recordMailboxTransitionReady(transition, checks);
        } else {
          if (peerBytes === undefined)
            return yield* transitionRefusal("--peer-ready is required for admission.");
          yield* acceptMailboxTransitionPeer(transition, peerBytes, checks);
        }
        return verified;
      }).pipe(Effect.provide(Fluree.layerFluree(config, { existingOnly: true })));
      yield* Console.log(
        JSON.stringify({
          ...(input.action === "ready"
            ? { ready: join(busDir, MAILBOX_TRANSITION_READY_COMPLETE_FILE) }
            : {
                admitted: true,
                admittedEvidence: join(busDir, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE),
              }),
          localHold: "checked-disabled-unloaded-and-off-port",
          pairedHolds: "operator-attested",
          providerSettlement: "operator-attested",
          peerSentinel: "content-verified-not-peer-liveness",
          verifiedAt: proof.verifiedAt,
          startedServices: false,
        })
      );
    }).pipe(Effect.catchTag("LedgerError", fail))
).pipe(
  Command.withDescription(
    "Fence, activate the era, prove, admit and permit the two held installations without starting services"
  )
);

const cli = Command.make("agent-bus").pipe(
  Command.withDescription("Pub/sub message bus between Claude and Codex sessions"),
  Command.withSubcommands([
    serve,
    cursors,
    mailboxSource,
    mailboxImport,
    mailboxTransition,
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
