import { Effect } from "effect";

/**
 * Whether the bus may have the Codex daemon load a thread to run its nudge,
 * with no client attached: only when the turn can't wait on a person and the
 * load keeps the thread's permissions.
 */
export type Eligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

const yes: Eligibility = { eligible: true };
const no = (reason: string): Eligibility => ({ eligible: false, reason });

/** What a resume restores, from a thread's rollout (Codex 0.164, `thread_processor.rs`). */
export interface Settings {
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

/** A rollout line, as a settings record: its approval policy, and the snapshot if `threadId` owns it. */
const recordOf = (line: string, threadId: string) => {
  // Most lines are neither kind, and can be large.
  if (!line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) {
    return undefined;
  }
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // A line still being written.
    return undefined;
  }
  const payload = field(record, "payload");
  if (field(record, "type") === "turn_context") {
    return { approval: field(payload, "approval_policy"), snapshot: undefined };
  }
  if (
    field(record, "type") !== "event_msg" ||
    field(payload, "type") !== "thread_settings_applied"
  ) {
    return undefined;
  }
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

const NEWLINE = 0x0a;

/**
 * What a resume of `threadId` would restore, read backwards from the end of
 * its rollout a chunk at a time, so a long thread's file isn't read whole.
 */
export const latestSettings = (path: string, threadId: string, chunkSize = 64 * 1024) =>
  Effect.tryPromise({
    try: async (): Promise<Settings> => {
      const file = Bun.file(path);
      // A missing file reads as empty.
      if (!(await file.exists())) throw new Error("it doesn't exist");
      const decoder = new TextDecoder();
      let approval: { readonly value: unknown } | undefined;
      let snapshot: Settings["snapshot"];
      const take = (bytes: Uint8Array) => {
        const record = recordOf(decoder.decode(bytes), threadId);
        if (record === undefined) return false;
        approval ??= { value: record.approval };
        snapshot ??= record.snapshot;
        return snapshot !== undefined;
      };
      let end = file.size;
      // The start of a line whose beginning is in an earlier chunk.
      let rest = new Uint8Array(0);
      let found = false;
      while (end > 0 && !found) {
        const start = Math.max(0, end - chunkSize);
        const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
        const bytes = new Uint8Array(chunk.length + rest.length);
        bytes.set(chunk);
        bytes.set(rest, chunk.length);
        let lineEnd = bytes.length;
        for (let at = bytes.length - 1; at >= 0 && !found; at--) {
          if (bytes[at] !== NEWLINE) continue;
          found = take(bytes.subarray(at + 1, lineEnd));
          lineEnd = at;
        }
        rest = bytes.slice(0, lineEnd);
        end = start;
      }
      if (!found) take(rest);
      return { approval: approval?.value, snapshot };
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

/** Codex's own profiles, which every config compiles (Codex 0.164, `config/permissions.rs`). */
const BUILT_IN_PROFILES = new Set([":read-only", ":workspace", ":danger-full-access"]);

/** Collaboration modes that offer no tool to wait for the user's answer: Default, and its older names. */
const DEFAULT_MODES = new Set(["default", "code", "pair_programming", "execute", "custom"]);

/**
 * Whether a thread with these settings may be borrowed. This follows Codex
 * 0.164's resume: it keeps the approval policy, and takes permissions and
 * collaboration mode only from the thread's own latest snapshot. It selects a
 * named profile again by name, and keeps an unnamed one only if it lists no
 * specific paths (`core/src/config/mod.rs`); otherwise it applies the
 * daemon's default. Anything this doesn't recognise is not eligible.
 */
export const eligibility = ({ approval, snapshot }: Settings): Eligibility => {
  if (approval !== "never") {
    return no(
      approval === undefined
        ? "its rollout has no settings record"
        : `its approval policy is ${JSON.stringify(approval)}, so a turn could wait on an approval with no one to answer it`
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
    return BUILT_IN_PROFILES.has(snapshot.profileId)
      ? yes
      : no(
          `its permission profile ${JSON.stringify(snapshot.profileId)} comes from the owner's config, and a resume falls back to the daemon's default if it no longer compiles`
        );
  }
  const kind = field(snapshot.profile, "type");
  if (kind === "disabled") return yes;
  if (kind === "managed") {
    const fileSystem = field(snapshot.profile, "file_system");
    if (field(fileSystem, "type") === "unrestricted") return yes;
    const entries = field(fileSystem, "entries");
    if (field(fileSystem, "type") === "restricted" && Array.isArray(entries)) {
      const listsPaths = entries.some((entry: unknown) => {
        const access = field(entry, "access");
        const path = field(field(entry, "path"), "type");
        return (
          access !== "deny" && access !== "none" && (path === "path" || path === "glob_pattern")
        );
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
 * snapshot with every input and after every compaction, so its latest one is
 * in that span (Codex 0.164, `thread-store/src/local/model_context.rs`).
 */
const HISTORY_MODES = new Set(["legacy", "paginated"]);

/** Whether a thread may be borrowed, from its rollout. Anything unreadable makes it not. */
export const readEligibility = (threadId: string, { path, historyMode }: Stored) => {
  if (typeof historyMode !== "string" || !HISTORY_MODES.has(historyMode)) {
    return Effect.succeed(
      no(`its history is kept as ${JSON.stringify(historyMode)}, which this version doesn't read`)
    );
  }
  if (path === undefined) return Effect.succeed(no("Codex reports no rollout file for it"));
  return latestSettings(path, threadId).pipe(
    Effect.map(eligibility),
    Effect.catch((cause) => Effect.succeed(no(`its rollout can't be read (${cause})`)))
  );
};
