import { Clock, Duration, Effect, Option, Schema } from "effect";
import * as Client from "./client.ts";
import { validSession } from "./domain.ts";
import { Woken } from "./mcp.ts";
import { WAKE_CALL_TIMEOUT_SECONDS, WAKE_FAILING_FOR, WAKE_RETRY } from "./timing.ts";

/** The field of a Claude Code hook's input that the wake uses. */
const HookInput = Schema.fromJsonString(
  Schema.Struct({ session_id: Schema.optionalKey(Schema.String) })
);

/**
 * What the session is told, one line per address. It carries no text from
 * other sessions: the hook's output enters the session's context as Claude
 * Code's own, so senders' text stays in `bus_read`'s result. A woken session
 * may have lost its join from context (a compaction, a resume), so it is told
 * not to rejoin; after `/clear` a rejoin would be refused, the old id holding
 * the address. A wake may land mid-turn, so it carries on rather than ending
 * a turn, and says when its read fails: the same unread mail doesn't wake it
 * again.
 */
export const formatWake = (address: string) =>
  `[agent-bus] New messages for ${JSON.stringify(address)}. Read them with the agent-bus bus_read tool, as that address with your $CLAUDE_CODE_SESSION_ID as session, and handle them; don't call bus_join first. If bus_read returns no messages, or says the address isn't joined or belongs to another session, carry on without replying and without rejoining. If it fails, try once more; if it fails again, say so and carry on.`;

/**
 * Whether the hook's parent (Claude Code, or the shell it ran the hook in) is
 * the one it started with. A hook outliving its session would otherwise take
 * the session's next wake to nobody.
 */
const parentAlive = () => {
  const parent = process.ppid;
  return () => process.ppid === parent;
};

/**
 * The Claude Code wake: the agent-bus plugin runs it as an `asyncRewake` hook
 * when a session starts or resumes and whenever a turn ends, in the
 * background. It waits until an address the session owns has mail it hasn't
 * been woken for, and returns the nudge, which the hook prints to stderr and
 * exits 2 to wake the session; the woken turn's end starts the next. Returns
 * nothing (exit 0, no wake) when the input has no usable session, the session
 * owns no address, a newer hook took over, or calls keep failing for ten
 * minutes. With the session checked here, every failure is transient: `serve`
 * restarting, its store unavailable, or a `serve` from before `bus_wake`, which
 * a deploy replaces within that window. It marks nothing read: the session's
 * own `bus_read` does.
 *
 * The session is the hook input's `session_id`, which is the session's own
 * `CLAUDE_CODE_SESSION_ID` (after `/clear`, the new one).
 */
export const claudeWake = (
  url: string,
  input: string,
  call: ReturnType<typeof Client.call> = Client.call(url),
  failingFor: Duration.Duration = WAKE_FAILING_FOR,
  /** Whether the session that started the hook is still there; an orphaned hook stops. */
  alive: () => boolean = parentAlive()
) =>
  Effect.gen(function* () {
    const session = yield* Schema.decodeUnknownEffect(HookInput)(input).pipe(
      Effect.map((hook) => hook.session_id),
      Effect.orElseSucceed(() => undefined)
    );
    if (!validSession(session)) return Option.none<string>();
    let failingSince: number | undefined;
    while (alive()) {
      const result = yield* Effect.result(
        call("bus_wake", Woken, { session }, WAKE_CALL_TIMEOUT_SECONDS)
      );
      if (result._tag === "Success") {
        failingSince = undefined;
        const { addresses, owns, superseded } = result.success;
        if (superseded || !owns) return Option.none<string>();
        if (addresses.length > 0) return Option.some(addresses.map(formatWake).join("\n"));
        continue;
      }
      const now = yield* Clock.currentTimeMillis;
      failingSince ??= now;
      if (now - failingSince >= Duration.toMillis(failingFor)) return Option.none<string>();
      yield* Effect.sleep(WAKE_RETRY);
    }
    return Option.none<string>();
  });
