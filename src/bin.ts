#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Logger, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Bus from "./Bus.ts";
import * as Cursors from "./Cursors.ts";
import * as Client from "./client.ts";
import { defaultSocket, formatDelivery, localHost } from "./codex.ts";
import { Runtime } from "./domain.ts";
import * as Fluree from "./Fluree.ts";
import { codexStop } from "./hook.ts";
import * as Ledger from "./Ledger.ts";
import * as Mcp from "./mcp.ts";
import * as Serve from "./serve.ts";

const VERSION = "0.2.0";

const busDir = process.env.AGENT_BUS_DIR ?? join(homedir(), ".agent-bus");
const jsonlFile = join(busDir, "ledger.jsonl");
const port = Number(process.env.AGENT_BUS_PORT ?? 8096);
const endpoint = `http://127.0.0.1:${port}/mcp`;

/** `config.json` in the bus directory; without a `fluree` entry the bus uses the JSONL ledger. */
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

/** Direct access to the store, for the machine's bus process and offline imports. */
const BusLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* loadConfig;
    if (config.fluree === undefined) {
      return Bus.layer.pipe(
        Layer.provideMerge(Ledger.layerJsonl(jsonlFile)),
        Layer.provideMerge(Cursors.layerFiles(join(busDir, "cursors")))
      );
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

const serve = Command.make(
  "serve",
  {
    codexSocket: Flag.String("codex-socket").pipe(Flag.withDefault(defaultSocket)),
    host: Flag.String("host").pipe(
      Flag.withDescription("Wake the Codex peers that joined from this machine"),
      Flag.withDefault(localHost)
    ),
  },
  (input) =>
    Layer.launch(
      Serve.layer({ port, version: VERSION, codexSocket: input.codexSocket, host: input.host })
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
    runtime: Flag.Literals("runtime", Runtime.literals),
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
      const joined = yield* call("bus_join", Mcp.Joined, {
        address: input.address,
        runtime: input.runtime,
        cwd: process.cwd(),
        ...Client.defined({
          topics: list(input.topics),
          codexThreadId: Option.getOrUndefined(input.codexThread),
          note: Option.getOrUndefined(input.note),
        }),
        replay: input.replay,
      });
      yield* Console.log(
        joined.codexHost === "other"
          ? `joined as ${joined.address}; the bus wakes this Codex thread only while this machine's daemon has it loaded`
          : `joined as ${joined.address}`
      );
    })
).pipe(Command.withDescription("Join the bus as an address, from this directory"));

const publish = Command.make(
  "publish",
  {
    from: Flag.String("from"),
    to: Flag.String("to").pipe(Flag.withDescription("Comma-separated addresses, #topics or *")),
    body: Flag.String("body"),
    subject: Flag.String("subject").pipe(Flag.optional),
    replyTo: Flag.String("reply-to").pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* () {
      const published = yield* call("bus_publish", Mcp.Published, {
        from: input.from,
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

const wait = Command.make(
  "wait",
  {
    address,
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Seconds to wait; 0 waits until a message arrives"),
      Flag.withDefault(0)
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const messages = yield* Client.waitFor(
        endpoint,
        input.address,
        input.timeout > 0 ? input.timeout : undefined
      );
      if (messages.length === 0) return yield* Console.log("[agent-bus] no new messages");
      yield* Console.log(formatDelivery(input.address, messages));
    })
).pipe(
  Command.withDescription(
    "Block until messages arrive for an address, print them and mark them read (run in the background to be woken)"
  )
);

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

const codexStopHook = Command.make("codex-stop-hook", {}, () =>
  Effect.gen(function* () {
    const input = yield* Effect.promise(() => Bun.stdin.text());
    const output = yield* codexStop(endpoint, input, localHost);
    if (Option.isSome(output)) yield* Console.log(output.value);
  })
).pipe(
  Command.withDescription(
    "Codex Stop hook: continue the ending turn with the thread's unread bus messages (reads the hook input on stdin)"
  )
);

const importJsonl = Command.make(
  "import-jsonl",
  { file: Flag.String("file").pipe(Flag.withDefault(jsonlFile)) },
  (input) =>
    Effect.gen(function* () {
      const target = yield* Ledger.Ledger;
      const bus = yield* Bus.Bus;
      const cursors = yield* Cursors.Cursors;
      const source = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* Ledger.Ledger;
        }),
        Ledger.layerJsonl(input.file)
      );
      const existing = new Set((yield* target.read(0)).entries.map((entry) => entry.message.id));
      let copied = 0;
      for (const { message } of (yield* source.read(0)).entries) {
        if (existing.has(message.id)) continue;
        yield* target.append(message);
        copied += 1;
      }
      // Imported peers start at the present in the new store, as a fresh join would.
      const head = yield* target.end;
      for (const peer of yield* bus.peers) {
        if (Option.isNone(yield* cursors.get(peer.address))) {
          yield* cursors.set(peer.address, head);
        }
      }
      yield* Console.log(`imported ${copied} entries from ${input.file}`);
    }).pipe(Effect.provide(BusLayer))
).pipe(
  Command.withDescription(
    "Copy a JSONL ledger into the configured store, skipping entries already there"
  )
);

const cli = Command.make("agent-bus").pipe(
  Command.withDescription("Pub/sub message bus between Claude and Codex sessions"),
  Command.withSubcommands([serve, joinCommand, publish, wait, peers, codexStopHook, importJsonl])
);

Command.run(cli, { version: VERSION }).pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  Effect.provide(Layer.succeed(Logger.LogToStderr)(true)),
  BunRuntime.runMain
);
