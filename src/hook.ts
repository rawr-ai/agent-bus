import { Effect, Option, Schema } from "effect";
import * as Client from "./client.ts";
import { formatDelivery, machine } from "./codex.ts";
import * as Mcp from "./mcp.ts";

/** The fields of a Codex `Stop` hook's input that the bus uses. */
const StopInput = Schema.fromJsonString(
  Schema.Struct({
    session_id: Schema.String,
    transcript_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
  })
);

/**
 * A Codex `Stop` hook: when a turn ends, continue it with the thread's unread
 * bus messages. This reaches threads the bus can't wake, such as those in the
 * desktop app's own app-server, without a second writer. Returns the hook's
 * JSON output, or nothing to let the turn end.
 *
 * The hook reads as the thread it reports, presenting its `session_id` as the
 * session. Subagents' hooks carry their parent's `session_id`, so it delivers
 * only when the transcript is that thread's own (rollout files are named by
 * thread id), and never without a transcript. Any failure lets the turn end,
 * with whatever was already read: a hook must never block a thread or drop
 * messages it marked read.
 */
export const codexStop = (
  url: string,
  input: string,
  host: string,
  call: ReturnType<typeof Client.call> = Client.call(url)
) =>
  Effect.gen(function* () {
    const stop = yield* Schema.decodeUnknownEffect(StopInput)(input);
    const thread = stop.session_id;
    if (stop.transcript_path == null || !stop.transcript_path.includes(thread)) {
      return Option.none<string>();
    }
    const { peers } = yield* call("bus_peers", Mcp.Peers, {}, 5);
    const blocks: Array<string> = [];
    for (const peer of peers) {
      if (
        peer.runtime !== "codex" ||
        peer.codexThreadId !== thread ||
        peer.host === undefined ||
        machine(peer.host) !== machine(host)
      ) {
        continue;
      }
      const read = yield* Effect.result(
        call("bus_read", Mcp.Messages, { address: peer.address, session: thread }, 10)
      );
      // A refusal changed nothing, so the other addresses can still be read.
      if (read._tag === "Failure") {
        if (read.failure.refused) continue;
        break;
      }
      const { messages } = read.success;
      if (messages.length > 0) blocks.push(formatDelivery(peer.address, messages));
    }
    if (blocks.length === 0) return Option.none<string>();
    return Option.some(JSON.stringify({ decision: "block", reason: blocks.join("\n\n---\n\n") }));
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
