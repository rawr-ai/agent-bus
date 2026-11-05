import { isAbsolute } from "node:path";
import { Duration, Effect, Option, Schema, Stream } from "effect";
import type { HttpClient } from "effect/http";
import * as Client from "./client.ts";
import { validSession } from "./domain.ts";
import { OwnedAddresses } from "./mcp.ts";
import { COMPACT_DEADLINE, COMPACT_OUTPUT_BYTES } from "./timing.ts";

type NativeRuntime = "claude" | "codex";
type Lookup = (
  session: string,
  runtime: NativeRuntime
) => Effect.Effect<unknown, Client.BusCallError, HttpClient.HttpClient>;

const Input = Schema.fromJsonString(
  Schema.Struct({
    session_id: Schema.String,
    cwd: Schema.String,
    hook_event_name: Schema.Literal("SessionStart"),
    source: Schema.Literal("compact"),
  })
);

/** A scoped reader: interruption cancels the stream rather than abandoning stdin.text(). */
export const readCompactInput = (evaluate: () => ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate,
    onError: () => new Client.BusCallError({ message: "Compact input was unreadable." }),
  }).pipe(
    Stream.decodeText(),
    Stream.runCollect,
    Effect.map((chunks) => chunks.join(""))
  );

const asciiJson = (value: ReadonlyArray<string> | { readonly cwd: string }) =>
  JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
  );

/** Only fixed instructions and ASCII-escaped JSON data enter privileged hook context. */
export const formatCompact = (
  runtime: NativeRuntime,
  cwd: string,
  addresses: ReadonlyArray<string>,
  budget = COMPACT_OUTPUT_BYTES
): Option.Option<string> => {
  if (addresses.length === 0) return Option.none();
  const session = runtime === "codex" ? "$CODEX_THREAD_ID" : "$CLAUDE_CODE_SESSION_ID";
  const held = asciiJson([...new Set(addresses)].sort());
  const route = asciiJson({ cwd });
  const text = `[agent-bus] The hook observed these addresses: ${held}. Hook identity can be shared or refer to a parent; this list does not assign inboxes to your role. Recover and use only your assigned address. Do not read all listed inboxes or commandeer delegates' addresses. Do not call bus_join to recover them. Use your own ${session} as session. For current guidance, call bus_orient with ${route}; it consumes no mail. Normal ownership refusals remain authoritative; do not automatically rejoin a refused address. Continue your work.`;
  return Buffer.byteLength(text, "utf8") + 1 <= budget ? Option.some(text) : Option.none();
};

/** One quiet, finite observation; timeout interrupts and finalizes stdin and MCP resources. */
export const compactRecovery = <E, R>(
  runtime: NativeRuntime,
  input: Effect.Effect<string, E, R>,
  url: string,
  lookup: Lookup = (session, runtime) =>
    Client.call(url)("bus_owned_addresses", OwnedAddresses, { session, runtime }),
  deadline: Duration.Input = COMPACT_DEADLINE
) =>
  Effect.gen(function* () {
    const hook = yield* Schema.decodeUnknownEffect(Input)(yield* input);
    if (!validSession(hook.session_id) || !isAbsolute(hook.cwd)) return Option.none<string>();
    const result = yield* lookup(hook.session_id, runtime);
    const { addresses } = yield* Schema.decodeUnknownEffect(OwnedAddresses)(result);
    return formatCompact(runtime, hook.cwd, addresses);
  }).pipe(
    Effect.catch(() => Effect.succeed(Option.none<string>())),
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () => Effect.succeed(Option.none<string>()),
    })
  );
