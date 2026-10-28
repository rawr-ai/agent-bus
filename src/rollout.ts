import { Duration, Effect } from "effect";

/**
 * Whether the bus may have the Codex daemon load a thread to run its nudge,
 * with no client attached: only when the turn can't wait on a person or a
 * client, and the load keeps the thread's permissions.
 */
export type Eligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

const yes: Eligibility = { eligible: true };
const no = (reason: string): Eligibility => ({ eligible: false, reason });

/** What a resume restores, from a thread's rollout (Codex 0.164, `thread_processor.rs`). */
export interface Settings {
  /**
   * From the rollout's first record, `session_meta`, which a resume reads its
   * dynamic tools from (`core/src/session/mod.rs`); a fork's resume skips its
   * ancestors' (`thread-store/src/local/model_context.rs`). Undefined if it
   * doesn't start with one.
   */
  readonly session:
    | {
        /** Tools a client registered for the thread, which only that client answers. */
        readonly dynamicTools: number;
        /** A fork by reference, which resumes with its lineage's history up to the fork point. */
        readonly forked: boolean;
      }
    | undefined;
  /**
   * The latest persisted status event (`task_started`, `task_complete` or
   * `turn_aborted`), which a resume restores the thread's status from
   * (`core/src/agent/status.rs`; `rollout/src/policy.rs` persists no others).
   * Undefined if the thread's own rollout has none.
   */
  readonly status: { readonly type: string; readonly reason: unknown } | undefined;
  /** From the latest `turn_context` or `thread_settings_applied`, whoever wrote it. */
  readonly approval: unknown;
  /**
   * The latest `thread_settings_applied` the thread wrote itself: the only
   * record a resume restores permissions and collaboration mode from. Copied
   * history can hold another thread's.
   */
  readonly snapshot:
    | {
        /** A named permission profile, which a resume selects again by name. */
        readonly profileId: unknown;
        readonly profile: unknown;
        readonly mode: unknown;
      }
    | undefined;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    // A line still being written.
    return undefined;
  }
};

const STATUS_EVENTS = ["task_started", "task_complete", "turn_aborted"];

/** A rollout line, as a status event, or as a settings record: its approval policy, and the snapshot if `threadId` owns it. */
const recordOf = (line: string, threadId: string) => {
  // Most lines are none of these kinds, and can be large.
  if (
    !line.includes('"turn_context"') &&
    !line.includes('"thread_settings_applied"') &&
    !STATUS_EVENTS.some((type) => line.includes(`"${type}"`))
  ) {
    return undefined;
  }
  const record = parse(line);
  const payload = field(record, "payload");
  if (field(record, "type") === "turn_context") {
    return { approval: field(payload, "approval_policy"), snapshot: undefined };
  }
  if (field(record, "type") !== "event_msg") return undefined;
  const type = field(payload, "type");
  if (typeof type === "string" && STATUS_EVENTS.includes(type)) {
    return { status: { type, reason: field(payload, "reason") } };
  }
  if (type !== "thread_settings_applied") return undefined;
  const settings = field(payload, "thread_settings");
  return {
    approval: field(settings, "approval_policy"),
    snapshot:
      field(payload, "thread_id") === threadId
        ? {
            profileId: field(field(settings, "active_permission_profile"), "id"),
            profile: field(settings, "permission_profile"),
            mode: field(field(settings, "collaboration_mode"), "mode"),
          }
        : undefined,
  };
};

const sessionOf = (line: string): Settings["session"] => {
  const record = parse(line);
  if (field(record, "type") !== "session_meta") return undefined;
  const payload = field(record, "payload");
  const tools = field(payload, "dynamic_tools");
  const base = field(payload, "history_base");
  return {
    dynamicTools: Array.isArray(tools) ? tools.length : 0,
    forked: base !== undefined && base !== null,
  };
};

/** A reason a rollout can't be read that names no path, so no thread id. */
class Unreadable extends Error {}

const NEWLINE = 0x0a;
/** The first record holds the base instructions; one longer than this isn't read. */
const MAX_FIRST_LINE = 8 * 1024 * 1024;

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};

/**
 * What a resume of `threadId` would restore: the session record from the
 * rollout's first line, and the settings read backwards from its end a chunk
 * at a time, so a long thread's file isn't read whole. Reading stops once it
 * has the latest status event and the thread's own snapshot, or at an approval
 * policy that makes it ineligible anyway. A failure says only what kind it was.
 */
export const latestSettings = (path: string, threadId: string, chunkSize = 64 * 1024) =>
  Effect.tryPromise({
    try: async (signal): Promise<Settings> => {
      const file = Bun.file(path);
      // A missing file reads as empty.
      if (!(await file.exists())) throw new Unreadable("it doesn't exist");
      const read = async (start: number, end: number) => {
        if (signal.aborted) throw new Unreadable("reading it was abandoned");
        return new Uint8Array(await file.slice(start, end).arrayBuffer());
      };
      const decoder = new TextDecoder();

      const head: Array<Uint8Array> = [];
      for (let start = 0; start < file.size; start += chunkSize) {
        if (start >= MAX_FIRST_LINE) throw new Unreadable("its first record is too long");
        const chunk = await read(start, Math.min(file.size, start + chunkSize));
        const end = chunk.indexOf(NEWLINE);
        head.push(end < 0 ? chunk : chunk.subarray(0, end));
        if (end >= 0) break;
      }
      const session = sessionOf(decoder.decode(concat(head)));

      let approval: { readonly value: unknown } | undefined;
      let snapshot: Settings["snapshot"];
      let status: Settings["status"];
      const take = (bytes: Uint8Array) => {
        const record = recordOf(decoder.decode(bytes), threadId);
        if (record === undefined) return false;
        if ("status" in record) status ??= record.status;
        else {
          approval ??= { value: record.approval };
          snapshot ??= record.snapshot;
        }
        if (approval !== undefined && approval.value !== "never") return true;
        return snapshot !== undefined && status !== undefined;
      };
      let end = file.size;
      // The pieces of a line whose beginning is in an earlier chunk, in file order.
      let rest: Array<Uint8Array> = [];
      let done = false;
      while (end > 0 && !done) {
        const start = Math.max(0, end - chunkSize);
        const chunk = await read(start, end);
        let lineEnd = chunk.length;
        for (let at = chunk.length - 1; at >= 0 && !done; at--) {
          if (chunk[at] !== NEWLINE) continue;
          done = take(concat([chunk.subarray(at + 1, lineEnd), ...rest]));
          rest = [];
          lineEnd = at;
        }
        rest.unshift(chunk.subarray(0, lineEnd));
        end = start;
      }
      if (!done) take(concat(rest));
      return { session, approval: approval?.value, snapshot, status };
    },
    catch: (cause) => {
      if (cause instanceof Unreadable) return cause.message;
      // A file system error's message names the path, which names the thread.
      const code = field(cause, "code");
      return typeof code === "string" ? `error ${code}` : "an unexpected error";
    },
  });

/** Abort reasons a resume restores as `Interrupted`, whose queue Codex doesn't run (`ext/queue/src/service.rs`). */
const INTERRUPTED = new Set(["interrupted", "budget_limited"]);

/** Codex's own profiles, which every config compiles (Codex 0.164, `config/permissions.rs`). */
const BUILT_IN_PROFILES = new Set([":read-only", ":workspace", ":danger-full-access"]);

/** Collaboration modes that offer no tool to wait for the user's answer: Default, and its older names. */
const DEFAULT_MODES = new Set(["default", "code", "pair_programming", "execute", "custom"]);

/** A saved profile's file system entries, or none for a profile that lists none. */
const entriesOf = (profile: unknown): ReadonlyArray<unknown> => {
  const entries = field(field(profile, "file_system"), "entries");
  return Array.isArray(entries) ? entries : [];
};
const denies = (entry: unknown) =>
  field(entry, "access") === "deny" || field(entry, "access") === "none";

/**
 * Whether a thread with these settings may be borrowed. This follows Codex
 * 0.164's resume: it restores the client's dynamic tools, keeps the approval
 * policy, and takes permissions and collaboration mode only from the thread's
 * own latest snapshot. It compiles a named profile again by name, which drops
 * any denials carried over from an earlier profile, and keeps an unnamed one
 * only if it lists no specific paths (`core/src/config/mod.rs`); otherwise it
 * applies the daemon's default. It restores the status of the last turn, and
 * runs no queued input while that is `Interrupted`. Anything this doesn't
 * recognise is not eligible.
 */
export const eligibility = (settings: Settings): Eligibility => {
  const permitted = permissions(settings);
  if (!permitted.eligible) return permitted;
  const { session, status } = settings;
  if (status === undefined) {
    return session?.forked === true
      ? no(
          "it hasn't run a turn since it was forked, so its status comes from another thread's history"
        )
      : yes;
  }
  return status.type === "turn_aborted" && INTERRUPTED.has(String(status.reason))
    ? no(
        "its last turn was interrupted, so Codex runs no queued input until the thread gets new input"
      )
    : yes;
};

/** Whether a resume keeps what the thread may do, and nothing in it can wait on a person or a client. */
const permissions = ({ session, approval, snapshot }: Settings): Eligibility => {
  if (approval !== "never") {
    return no(
      approval === undefined
        ? "its rollout has no settings record"
        : `its approval policy is ${JSON.stringify(approval)}, so a turn could wait on an approval with no one to answer it`
    );
  }
  if (session === undefined) return no("its rollout doesn't start with a session record");
  if (session.dynamicTools > 0) {
    return no(
      "a client registered tools for it, and a call to one would wait for that client, which a borrow doesn't attach"
    );
  }
  if (snapshot === undefined) {
    return no(
      "its rollout has no settings snapshot of its own, so a resume would apply the daemon's default permissions"
    );
  }
  if (typeof snapshot.mode !== "string" || !DEFAULT_MODES.has(snapshot.mode)) {
    return no(
      `its collaboration mode is ${JSON.stringify(snapshot.mode)}, where a turn can wait for the user's answer`
    );
  }
  if (typeof snapshot.profileId === "string" && snapshot.profileId !== "") {
    if (!BUILT_IN_PROFILES.has(snapshot.profileId)) {
      return no(
        `its permission profile ${JSON.stringify(snapshot.profileId)} comes from the owner's config, and a resume falls back to the daemon's default if it no longer compiles`
      );
    }
    // Switching to a built-in keeps the earlier profile's denials (`session/session.rs`);
    // compiling it again by name doesn't.
    return entriesOf(snapshot.profile).some(denies)
      ? no(
          `it denies paths that ${snapshot.profileId} doesn't, which a resume would drop by compiling the profile again`
        )
      : yes;
  }
  const kind = field(snapshot.profile, "type");
  if (kind === "disabled") return yes;
  if (kind === "managed") {
    const fileSystem = field(snapshot.profile, "file_system");
    if (field(fileSystem, "type") === "unrestricted") return yes;
    if (field(fileSystem, "type") === "restricted" && Array.isArray(field(fileSystem, "entries"))) {
      const listsPaths = entriesOf(snapshot.profile).some((entry: unknown) => {
        const path = field(field(entry, "path"), "type");
        return !denies(entry) && (path === "path" || path === "glob_pattern");
      });
      return listsPaths
        ? no(
            "its sandbox lists specific paths (the older workspace-write setting), which a resume replaces with the daemon's default"
          )
        : yes;
    }
  }
  return no("its permission profile is of a kind this version doesn't know");
};

/** Where a thread's rollout is, and how its history is kept, as `thread/read` reports them. */
export interface Stored {
  readonly path: string | undefined;
  readonly historyMode: unknown;
}

/**
 * How a thread's history is kept. Both keep the rollout canonical: a paginated
 * thread resumes from its latest compaction onwards, and Codex writes a
 * snapshot after every compaction, so its latest one is in that span (Codex 0.164, `thread-store/src/local/model_context.rs`).
 */
const HISTORY_MODES = new Set(["legacy", "paginated"]);

/** How long reading a rollout may take; it holds up the other peers' turns in the cycle. */
const READ_TIMEOUT = Duration.seconds(5);

/** Whether a thread may be borrowed, from its rollout. Anything unreadable makes it not. */
export const readEligibility = (
  threadId: string,
  { path, historyMode }: Stored,
  timeout: Duration.Duration = READ_TIMEOUT
) => {
  if (typeof historyMode !== "string" || !HISTORY_MODES.has(historyMode)) {
    return Effect.succeed(
      no(`its history is kept as ${JSON.stringify(historyMode)}, which this version doesn't read`)
    );
  }
  if (path === undefined) return Effect.succeed(no("Codex reports no rollout file for it"));
  return latestSettings(path, threadId).pipe(
    Effect.map(eligibility),
    Effect.catch((cause) => Effect.succeed(no(`its rollout can't be read (${cause})`))),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.succeed(no(`its rollout took longer than ${Duration.format(timeout)} to read`)),
    })
  );
};
