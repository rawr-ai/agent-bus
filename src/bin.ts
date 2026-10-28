#!/usr/bin/env -S bun --no-env-file
import { homedir } from "node:os";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Logger, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Bus from "./Bus.ts";
import * as Cursors from "./Cursors.ts";
import { claudeWake } from "./claude.ts";
import * as Client from "./client.ts";
import { defaultCodex, localHost } from "./codex.ts";
import { Runtime } from "./domain.ts";
import * as Fluree from "./Fluree.ts";
import * as Ledger from "./Ledger.ts";
import * as Mcp from "./mcp.ts";
import * as Serve from "./serve.ts";

const VERSION = "0.2.0";

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

/** Cursors are positions in one ledger's history, so each ledger instance keeps its own. */
const cursorsFor = (ledgerId: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const ledger = yield* Ledger.Ledger;
      return Cursors.layerFiles(
        join(busDir, "fluree-cursors", encodeURIComponent(ledgerId), ledger.instance)
      );
    })
  );

/** `config.json` names no Fluree ledger, so the store can't open. */
class NoStore extends Schema.TaggedError<NoStore>()("NoStore", { message: Schema.String }) {}

/** Direct access to the store, for the machine's bus process. */
const BusLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* loadConfig;
    if (config.fluree === undefined) {
      return yield* new NoStore({
        message: `${join(busDir, "config.json")} has no Fluree ledger. Give it a "fluree" entry, as the installer writes: { "fluree": { "url": "http://127.0.0.1:8095", "ledger": "agent-bus:main" } }`,
      });
    }
    const token = yield* loadToken;
    return Bus.layer.pipe(
      Layer.provideMerge(cursorsFor(config.fluree.ledger)),
      Layer.provideMerge(Fluree.layerFluree({ ...config.fluree, token }))
    );
  })
);

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
    host: Flag.String("host").pipe(
      Flag.withDescription("Wake the Codex peers that joined from this machine"),
      Flag.withDefault(localHost)
    ),
  },
  (input) =>
    Layer.launch(
      Serve.layer({
        port,
        version: VERSION,
        codex: input.codex,
        host: input.host,
      })
    ).pipe(Effect.provide(BusLayer))
).pipe(
  Command.withDescription(
    `Run this machine's bus: MCP over HTTP at ${endpoint}, and delivery to this machine's Codex peers (run one per machine)`
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
      Flag.withDescription("Comma-separated topics to receive"),
      Flag.optional
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
      const joining = {
        address: input.address,
        runtime: input.runtime,
        session: yield* Client.sessionFor(input.runtime, Option.getOrUndefined(input.session)),
        cwd: process.cwd(),
        ...Client.defined({
          topics: list(input.topics),
          codexThreadId: Option.getOrUndefined(input.codexThread),
          note: Option.getOrUndefined(input.note),
        }),
        replay: input.replay,
      };
      const joined = yield* Option.match(input.takeover, {
        onNone: () => call("bus_join", Mcp.Joined, joining),
        onSome: (holder) => call("bus_takeover", Mcp.Joined, { ...joining, holder }),
      });
      yield* Console.log(`joined as ${joined.address}`);
    })
).pipe(Command.withDescription("Join the bus as an address, from this directory"));

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
  },
  (input) =>
    Effect.gen(function* () {
      const published = yield* call("bus_publish", Mcp.Published, {
        from: input.from,
        session: yield* sessionOf(input.from, input.runtime, input.session),
        to: list(Option.some(input.to)) ?? [],
        body: input.body,
        ...Client.defined({
          subject: Option.getOrUndefined(input.subject),
          replyTo: Option.getOrUndefined(input.replyTo),
        }),
      });
      yield* Console.log(published.id);
    })
).pipe(Command.withDescription("Send a message"));

const peers = Command.make("peers", {}, () =>
  Effect.gen(function* () {
    const { peers } = yield* call("bus_peers", Mcp.Peers, {});
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

const fail = (error: { readonly message: string }) =>
  Console.error(error.message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      })
    )
  );

const cli = Command.make("agent-bus").pipe(
  Command.withDescription("Pub/sub message bus between Claude and Codex sessions"),
  Command.withSubcommands([serve, joinCommand, publish, peers, claudeWakeHook])
);

Command.run(cli, { version: VERSION }).pipe(
  // A refused or failed bus call, or a missing store, is an answer, not a crash:
  // its message alone, and status 1.
  Effect.catchTags({ BusCallError: fail, NoStore: fail }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  Effect.provide(Layer.succeed(Logger.LogToStderr)(true)),
  BunRuntime.runMain
);
