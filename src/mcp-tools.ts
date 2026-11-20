import { Context, Schema } from "effect";
import { Tool } from "effect/ai";
import {
  ACTIVITY_REASONS,
  Association,
  InvalidAssociations,
  InvalidQuery,
  InvalidTopics,
  LedgerError,
  Message,
  MuteScope,
  NotJoined,
  NotOwner,
  Origin,
  PresenceConflict,
  QueryCapacity,
  RecipientStanding,
  Runtime,
  WakeStanding,
} from "./domain.ts";
import {
  MAX_ENTRY_CARRIER_BYTES,
  MAX_INDEXED_FIELD_BYTES,
  MAX_ORIGIN_CWD_BYTES,
  WAKE_LISTED_BYTES,
} from "./message-carrier.ts";
import {
  BulletinUpdate,
  DirectoryUpdate,
  OrientationResult,
  OrientRequest,
  WriteResult,
} from "./orientation-model.ts";
import {
  MAX_ENVELOPE_BYTES,
  MAX_QUERY_LENGTH,
  MAX_SPARQL_ROWS,
  operationNames,
  QueryEnvelope,
} from "./query-contract.ts";
import { DEFAULT_HISTORY_LIMIT, MAX_WAIT_SECONDS, SAVED_QUERY_DEADLINE_SECONDS } from "./timing.ts";
import {
  CheckWakeBindingRequest,
  MAX_WAKE_COVERAGE_IDS,
  MAX_WAKE_OBSERVATION_BYTES,
  ObserveWakeRequest,
  WakeBindingCheck,
  WakeObservation,
} from "./wake-observation.ts";

/** Native tool contracts shared by the loopback server and its forwarding clients. */
const Failure = Schema.Union([
  LedgerError,
  NotJoined,
  NotOwner,
  PresenceConflict,
  InvalidTopics,
  InvalidAssociations,
  InvalidQuery,
  QueryCapacity,
]);
// Numbers are Finite or Int: Schema.Number's JSON Schema also admits "NaN" and "Infinity"
// strings, and drops the description and bounds clients are shown.
// Public fields are an allowlist, including origin: future internal fields stay internal.
const PublicOrigin = Schema.Struct({
  host: Origin.fields.host,
  cwd: Origin.fields.cwd,
  repo: Origin.fields.repo,
  branch: Origin.fields.branch,
});
const PublicMessage = Schema.Struct({
  id: Message.fields.id,
  ts: Message.fields.ts,
  from: Message.fields.from,
  to: Message.fields.to,
  kind: Message.fields.kind,
  subject: Message.fields.subject,
  body: Message.fields.body,
  replyTo: Message.fields.replyTo,
  origin: Schema.optionalKey(PublicOrigin),
});
export const Messages = Schema.Struct({ messages: Schema.Array(PublicMessage) });

export const Joined = Schema.Struct({
  address: Schema.String.annotate({ description: "The address you joined." }),
  // Older servers did not echo topics; the CLI uses this schema to decode their results too.
  topics: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Your effective topic subscriptions. New names are unique and have no # marker; an omitted list preserves unrecognised legacy names.",
    })
  ),
  associations: Schema.optionalKey(
    Schema.Array(Association).annotate({
      description:
        "Your effective explicit directory and concern associations; they do not subscribe you to topics.",
    })
  ),
  orientation: Schema.optionalKey(
    OrientationResult.annotate({
      description:
        "An independent read after this join committed, when requested; unavailable never means the join failed.",
    })
  ),
  cursor: Schema.Finite.annotate({
    description: "Your read position in the ledger: unread mail is what comes after it.",
  }),
  hooked: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description: "This session's wake hook (the agent-bus plugin) wakes it when mail arrives.",
    })
  ),
});
// The CLI also decodes old servers with Joined. The current server always echoes this field,
// so a fresh descriptor can prove association support before a mutating join.
const CurrentJoined = Schema.Struct({
  ...Joined.fields,
  associations: Schema.Array(Association).annotate({
    description: "Your effective explicit directory and concern associations.",
  }),
});
/**
 * Direct recipients whose registration the sender's own presence read, before the append, showed
 * not joined or lacking a native wake's prerequisites. Absent when it showed none, which never
 * promises a wake or delivery.
 */
const WakeNotice = Schema.Struct({
  ledger: Schema.String.annotate({
    description: "The ledger incarnation that presence read was taken from.",
  }),
  t: Schema.Int.annotate({
    description: "The commit of that presence read, before the send was appended.",
  }),
  lacking: Schema.Array(
    Schema.Struct({
      address: Schema.String.annotate({ description: "A directly addressed recipient." }),
      standing: RecipientStanding.annotate({
        description:
          "not-joined: no current join in that read (never joined, left, or an ownerless legacy join); the message is still stored for it. no-installation / no-codex-thread: its join lacks what a native wake needs, so it sees the message only when it reads; the recipient's owner renews the join to fix it.",
      }),
    })
  ).annotate({
    description: `Each such recipient once, in the order to named them: the first whose JSON array fits ${WAKE_LISTED_BYTES} bytes, possibly none when unlisted is set.`,
  }),
  unlisted: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description:
        "How many more lacked beyond those listed. To name them, page bus_run_query peers with this ledger and t until exhausted with damage checked: a direct recipient with no joined row, or whose wake is neither recorded nor interactive, lacked. If the ledger is refused or a page is damaged or cut short, they are not named.",
    })
  ),
}).annotate({
  description:
    "Direct recipients whose registration, as observed in ledger at t before the send was appended, was not joined or lacked a native wake's prerequisites. Recipients can renew after t; its absence never means a wake routes or will arrive.",
});
export const Published = Schema.Struct({
  id: Schema.String.annotate({ description: "The new message's id, for replies to name." }),
  ts: Schema.String.annotate({ description: "When it was sent (ISO 8601)." }),
  // Optional so the CLI still decodes older servers, which never report it.
  wake: Schema.optionalKey(WakeNotice),
});
/**
 * What bus_publish answers: the sent message's id and ts, or NOT_SENT for an unconfirmed pierce
 * of all. One object, not a union: structured output needs an object root.
 */
const PublishResult = Schema.Struct({
  id: Schema.optionalKey(Published.fields.id),
  ts: Schema.optionalKey(Published.fields.ts),
  wake: Published.fields.wake,
  replayed: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "The message was already stored under this operation: id and ts are the original's, and this call wrote nothing.",
    })
  ),
  status: Schema.optionalKey(
    Schema.Literal("NOT_SENT").annotate({
      description: "Nothing was sent: piercing all needs this exact set confirmed.",
    })
  ),
  bypass: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "With NOT_SENT: the audience members it would wake despite inactivity or mutes, beyond those it addresses directly.",
    })
  ),
  digest: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "With NOT_SENT: repeat the identical call with this as confirm to send it, piercing exactly bypass.",
    })
  ),
});
const Activity = Schema.Literals(["active", "inactive", "unknown"]).annotate({
  description:
    "Activity at cut; unknown when evidence is damaged or unread, which wakes as active.",
});
/** bus_activity's receipt, one object for the same reason; status says which fields it has. */
const ActivityResult = Schema.Struct({
  status: Schema.Literals(["APPLIED", "CONFLICT", "UNKNOWN", "IDENTITY_MISMATCH"]).annotate({
    description:
      "APPLIED: in force at its commit. CONFLICT: nothing changed. UNKNOWN: it may have committed; retry only the identical intent with the same operation. IDENTITY_MISMATCH: this operation already records a different intent; nothing was written.",
  }),
  operation: Schema.String.annotate({ description: "The operation, lowercased." }),
  cut: Schema.optionalKey(
    Schema.Struct({
      head: Schema.Int.annotate({ description: "The command's own commit." }),
      incarnation: Schema.String.annotate({
        description: "The ledger incarnation it was read in.",
      }),
    }).annotate({ description: "With APPLIED or CONFLICT: where the verdict was read." })
  ),
  activity: Schema.optionalKey(
    Activity.annotate({ description: "With APPLIED: activity at cut." })
  ),
  activeSince: Schema.optionalKey(
    Schema.String.annotate({ description: "With APPLIED: when it became active, if it is." })
  ),
  activityReason: Schema.optionalKey(
    Schema.Literals(ACTIVITY_REASONS).annotate({
      description: "With APPLIED and unknown activity only: damaged-mail or incomplete-scan.",
    })
  ),
  mutes: Schema.optionalKey(
    Schema.Array(MuteScope).annotate({ description: "With APPLIED: the mutes in force at cut." })
  ),
  reason: Schema.optionalKey(
    Schema.Literals(["not-joined", "not-holder", "stale-run"]).annotate({
      description:
        "With CONFLICT: at its commit the address had no joined holder, another holder, or a newer run (a replay).",
    })
  ),
});
export const Left = Schema.Struct({
  address: Schema.String.annotate({ description: "The address you left." }),
});
export const Woken = Schema.Struct({
  addresses: Schema.Array(Schema.String).annotate({
    description:
      "Your addresses with eligible unread mail; fresh includes previously woken mail. Empty on timeout.",
  }),
  owns: Schema.Boolean.annotate({
    description: "Whether your session holds any Claude address joined from this installation.",
  }),
  superseded: Schema.Boolean.annotate({
    description: "Whether a newer call from your session ended this one.",
  }),
});
export const OwnedAddresses = Schema.Struct({
  addresses: Schema.Array(Schema.String).annotate({
    description:
      "All addresses currently held by the exact session and runtime, ordered by address; empty when none are held.",
  }),
});
export const Peers = Schema.Struct({
  peers: Schema.Array(
    Schema.Struct({
      address: Schema.String.annotate({ description: "The peer's address." }),
      runtime: Runtime.annotate({ description: "The runtime it joined as." }),
      topics: Schema.Array(Schema.String).annotate({
        description: "The topics it receives #topic messages for.",
      }),
      host: Schema.optionalKey(
        Schema.String.annotate({ description: "The machine it joined from." })
      ),
      note: Schema.optionalKey(
        Schema.String.annotate({ description: "What it said it is working on." })
      ),
      // Optional so the CLI still decodes older servers, which never report it.
      wake: Schema.optionalKey(
        WakeStanding.annotate({
          description:
            "What its join records toward a native wake: recorded (prerequisites present, not a checked wake), interactive (no native wake by design), or no-installation / no-codex-thread / no-installation-or-codex-thread (its owner must renew the join).",
        })
      ),
      // Optional so the CLI still decodes older servers, which have no activity.
      activity: Schema.optionalKey(Activity),
      activeSince: Schema.optionalKey(
        Schema.String.annotate({ description: "When it became active, if it is." })
      ),
      activityReason: Schema.optionalKey(
        Schema.Literals(ACTIVITY_REASONS).annotate({
          description: "With unknown activity only: damaged-mail or incomplete-scan.",
        })
      ),
      mutes: Schema.optionalKey(
        Schema.Array(MuteScope).annotate({
          description: "Scopes whose ambient mail does not wake it.",
        })
      ),
    })
  ),
});

/**
 * Bus tools reach only the bus's own peers and delete nothing. Effect's defaults
 * mark every tool destructive and open-world, and Codex then asks approval for
 * each call outside full access, or refuses it under approval policy never,
 * which would leave a nudged thread unable to read or answer its mail.
 */
const Local = Context.make(Tool.Destructive, false).pipe(Context.add(Tool.OpenWorld, false));
/** Tools that change nothing, not even what is unread. */
const Lookup = Local.pipe(Context.add(Tool.Readonly, true));

const Address = Schema.String.annotate({
  description:
    "Your bus address: one session's private inbox, e.g. claude/project-worker, codex/fluree-runtime or chatgpt/task. Pick one specific to this session; groups use #topics.",
});

// Optional in the schema so a call without it gets the bus's refusal, which says what to pass.
const Session = Schema.optionalKey(
  Schema.String.annotate({
    description:
      "Required: your runtime's own session id, read from your shell — $CODEX_THREAD_ID in Codex, $CLAUDE_CODE_SESSION_ID in Claude Code; other clients pass a stable id of their own. Only the session that joined an address may use it.",
  })
);

const joinFields = {
  address: Address,
  runtime: Runtime.annotate({
    description:
      "Your runtime, which decides how the bus wakes you. While you hold the address, a rejoin under a different runtime is refused.",
  }),
  session: Session,
  cwd: Schema.String.check(Schema.isStartingWith("/")).annotate({
    description: `Your absolute working directory, at most ${MAX_ORIGIN_CWD_BYTES.toLocaleString("en-US")} UTF-8 bytes. Messages you send record it with its repo and branch.`,
  }),
  topics: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        'Topics to receive #topic messages for, e.g. ["project"]. One leading # and outer whitespace are removed; duplicates are merged, case is kept. Blank names or another leading # refuse the join. Omitted on rejoin, current topics are kept; given, they replace them ([] clears). The result echoes the effective topics.',
    })
  ),
  associations: Schema.optionalKey(
    Schema.Array(Association).annotate({
      description:
        "Explicit directory and concern associations. Omitted on rejoin while held by this session keeps them; [] clears. Associations do not subscribe you to topics.",
    })
  ),
  orient: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "After joining, independently read orientation for the join's cwd (the bridge directory for hosted calls). A failed read does not undo the join.",
    })
  ),
  codexThreadId: Schema.optionalKey(
    Schema.String.annotate({ description: "Codex only: your thread id, the same as session." })
  ),
  note: Schema.optionalKey(
    Schema.String.annotate({ description: "What you are working on, for other peers." })
  ),
  replay: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Also deliver messages sent before you joined." })
  ),
};

// Not destructive: it claims a free address, or reconnects the session that holds it.
export const Join = Tool.make("bus_join", {
  description:
    "Join the agent bus once under your own address. Rejoining an address you hold, with the same session, deliberately changes its topics, associations or note; reading does not require a rejoin, including after a restart or an empty or refused wake read. Claims your address for your session and announces your runtime and topics to every peer; an address another session holds is refused, so pick one specific to this session. Codex sessions pass their own thread id so the bus can nudge them to read new messages. A Claude session is woken by the agent-bus plugin's hook, and then its join returns hooked: true; without the plugin it isn't woken, and reads with bus_read or bus_wait.",
  parameters: Schema.Struct(joinFields),
  success: CurrentJoined,
  failure: Failure,
}).annotateMerge(Local);

// Destructive: it replaces another session's hold, which is refused from then on.
export const Takeover = Tool.make("bus_takeover", {
  description:
    "Only to replace a session that has ended, when the human says so: joins an address another session holds, naming that holder's join id from bus_join's refusal. It uses this Bus machine's cursor for the address, or starts at the decision cut if there is none. Unread position does not transfer from another machine. The holder id is checked only while another session holds the address; on a free address, or your own, this joins as bus_join does. Otherwise join an address of your own with bus_join.",
  parameters: Schema.Struct({
    ...joinFields,
    holder: Schema.String.annotate({
      description: "The holder's join id, as bus_join's refusal gives it.",
    }),
  }),
  success: CurrentJoined,
  failure: Failure,
})
  .annotateMerge(Local)
  .annotate(Tool.Destructive, true);

export const Publish = Tool.make("bus_publish", {
  description: `Send from an address you own. The bus refuses the send if the sender's presence changes after its ownership check but before commit. Give an operation (a UUIDv7) to make it safe to retry: the message takes it as its id, and retrying the identical call with the same operation returns the original id and ts with replayed and writes nothing, while a different send under it is refused with nothing written. If the outcome is unconfirmed, retry with the same operation. \`to\` names the audience: peer addresses, #topic for its subscribers, or * for everyone. The complete public read carrier must fit ${MAX_ENTRY_CARRIER_BYTES / (1024 * 1024)} MiB, including recipients and escaping. Set replyTo to the id being answered; it links messages, not recipients. Name in the body who, if anyone, is asked to respond. A result with wake names addressed recipients whose observed registration was not joined or lacked a native wake's prerequisites; the message is still stored. No wake never means a recipient was woken.`,
  parameters: Schema.Struct({
    from: Address,
    session: Session,
    to: Schema.Array(Schema.String).annotate({
      description:
        "Audience: peer addresses, #topic for its subscribers, or * for every peer. A topic and an address may appear together; @mentions in body do not route. A sender never receives its own message. Choose a reply's audience explicitly; replyTo does not inherit recipients.",
    }),
    body: Schema.String.annotate({
      description: `The message text, including who, if anyone, is asked to respond. Body and subject are searchable text, each at most ${MAX_INDEXED_FIELD_BYTES.toLocaleString("en-US")} UTF-8 bytes; link to longer content (a file path, URL or commit) instead.`,
    }),
    subject: Schema.optionalKey(
      Schema.String.annotate({
        description: `A short subject line, at most ${MAX_INDEXED_FIELD_BYTES.toLocaleString("en-US")} UTF-8 bytes; bus_history searches it.`,
      })
    ),
    replyTo: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "The id of the message this answers. Links the conversation; only to routes it.",
      })
    ),
    pierce: Schema.optionalKey(
      Schema.Union([Schema.Array(Schema.String), Schema.Literal("all")]).annotate({
        description:
          'Deliberately wake recipients despite their inactivity or mutes: addresses already in this message\'s audience (others are refused), or "all", which first returns NOT_SENT with the set and a digest to confirm. Never changes their activity.',
      })
    ),
    confirm: Schema.optionalKey(
      Schema.String.annotate({
        description: 'The digest a pierce of "all" returned, to send the identical message.',
      })
    ),
    operation: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "A lowercase UUIDv7 naming this send and all its retries; it becomes the message's id. Omitted, the bus chooses the id and the send cannot be safely retried.",
      })
    ),
  }),
  success: PublishResult,
  failure: Failure,
}).annotateMerge(Local);

// A write, though not destructive: it changes only the caller's own address.
export const SetActivity = Tool.make("bus_activity", {
  description:
    "Set your address's activity, mutes or both. Going inactive is do-not-disturb: programme, topic and project/concern mail stop being eligible to wake you, but direct mail from another peer reactivates you and remains eligible. Waking depends on your runtime's available delivery. mutes replaces your muted scopes, whatever your activity. Supply a UUIDv7 operation; a retry with it returns the original receipt. Retry an UNKNOWN only with the identical intent and the same operation.",
  parameters: Schema.Struct({
    address: Address,
    session: Session,
    operation: Schema.String.annotate({
      description: "A UUIDv7 naming this change and all its retries.",
    }),
    activity: Schema.optionalKey(
      Schema.Literals(["active", "inactive"]).annotate({
        description:
          "inactive for do-not-disturb; active makes ambient mail eligible for wake when available.",
      })
    ),
    mutes: Schema.optionalKey(
      Schema.Array(MuteScope).annotate({
        description:
          "Your complete mute set, replacing the current one ([] clears): programme mutes *, topic one #topic, directory every concern topic of a registered directory, concern one concern's topic.",
      })
    ),
  }),
  success: ActivityResult,
  failure: Failure,
})
  .annotateMerge(Local)
  .annotate(Tool.Strict, true);

export const Directory = Tool.make("bus_directory", {
  description:
    "Register or replace one complete directory, with an explicit nonempty notification audience. Supply a unique UUIDv7 operation and the exact current revision (null only for first registration). A matching retry returns its original receipt; UNKNOWN may still have committed, so retry only the identical intent with the same operation id. Association does not subscribe addresses.",
  parameters: DirectoryUpdate,
  success: WriteResult,
  failure: Failure,
})
  .annotateMerge(Local)
  .annotate(Tool.Strict, true);

export const Bulletin = Tool.make("bus_bulletin", {
  description:
    "Publish programme or registered concern guidance, or withdraw an existing designation even after concern removal. Programme notices go to *; concern notices go to its registered topic plus explicitly named direct recipients. Withdrawal retains the prior audience. Supply a UUIDv7 operation and the exact current revision; after UNKNOWN retry only the identical intent with the same operation id. A committed notice does not prove it was read.",
  parameters: BulletinUpdate,
  success: WriteResult,
  failure: Failure,
})
  .annotateMerge(Local)
  .annotate(Tool.Strict, true);

export const Orient = Tool.make("bus_orient", {
  description:
    "Read designated programme guidance, directory candidates or one selected directory, its concern summaries and optional full concern bulletin, and explicit current associations at one ledger cut. It does not join, subscribe, read mail or move a cursor. Pass a candidate continuation back with the same cwd, or use the members page's saved-query continuation at the same cut. Unavailable is an aggregate status: safely read sections remain labelled at the same cut, and section/message/recovery identify the failure.",
  parameters: OrientRequest,
  success: OrientationResult,
  failure: Failure,
})
  .annotateMerge(Lookup)
  .annotate(Tool.Strict, true);

export const MIN_READ_RESULT_BYTES = 128;
const ReadResultBytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_READ_RESULT_BYTES));

export const Read = Tool.make("bus_read", {
  description:
    "Return your unread messages and mark them read. Returns immediately. A lost result may already have consumed mail; inspect bus_history before reading again. Messages include public content and origin metadata, never stored presence or session claims.",
  parameters: Schema.Struct({
    address: Address,
    session: Session,
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description:
          "The most messages to return, oldest first; the rest stay unread. A commit group is never split, so a group larger than the limit is refused without advancing the cursor. Defaults to all of them.",
      })
    ),
    maxResultBytes: Schema.optionalKey(
      ReadResultBytes.annotate({
        description: `Maximum UTF-8 JSON bytes for the complete public MCP result carrier, including both text and structured content. Whole oldest messages only; remaining messages stay unread. If the first unread commit group cannot fit the byte and count limits, the call is refused without advancing the cursor. Minimum ${MIN_READ_RESULT_BYTES}.`,
      })
    ),
  }),
  success: Messages,
  failure: Failure,
}).annotateMerge(Local);

export const Wait = Tool.make("bus_wait", {
  description: `Wait for your next unread messages (marking them read), up to timeoutSeconds (default and maximum ${MAX_WAIT_SECONDS}). Use while you expect a reply; returns an empty list on timeout. A lost result may already have consumed mail; inspect bus_history before reading again. Returns the same public message fields as bus_read, without stored presence or session claims.`,
  parameters: Schema.Struct({
    address: Address,
    session: Session,
    timeoutSeconds: Schema.optionalKey(
      Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_SECONDS })).annotate({
        description: `Seconds to wait, 0 to ${MAX_WAIT_SECONDS}; defaults to ${MAX_WAIT_SECONDS}.`,
      })
    ),
    maxResultBytes: Schema.optionalKey(
      ReadResultBytes.annotate({
        description: `Maximum UTF-8 JSON bytes for the complete public MCP result carrier, including both text and structured content. Whole oldest messages only; remaining messages stay unread. If the first unread commit group cannot fit the byte limit, the call is refused without advancing the cursor. Minimum ${MIN_READ_RESULT_BYTES}.`,
      })
    ),
  }),
  success: Messages,
  failure: Failure,
}).annotateMerge(Local);

export const ObserveWake = Tool.make("bus_observe_wake", {
  description: `Internal loopback wake-source observation, not a subscription or mail read. Returns native binding, cut, ready/news and complete proposed coverage. latestEligibleAt is the chronologically latest currently eligible recorded message time, not the observation clock; it is absent when not ready, and an invalid eligible timestamp refuses. Capture only when ready && news, atomically with coverage in the caller's store; serialize observation through capture or CAS a retained revision. Preserve coverage behind unresolved notices. Same-run renewals retain binding; leave, takeover, replay/new run or ledger replacement fence it. No cursor, activity, hook, waiter or native wake mark changes. Empty/suppressed observations preserve previous coverage. Arguments fit ${MAX_WAKE_OBSERVATION_BYTES} UTF-8 JSON bytes; complete results fit maxResultBytes (default/max ${MAX_WAKE_OBSERVATION_BYTES}), including duplicated text/structured channels, excluding JSON-RPC framing; at most ${MAX_WAKE_COVERAGE_IDS} rung ids, never truncated. Excess or primary message/presence damage refuses. Auxiliary activity/directory uncertainty follows the unchanged native wake law, not proof every auxiliary record was readable. Freshly observe on activation, restart, pending resolution and bounded-wait expiry, since reads emit no ledger change. Recheck binding/access at external send admission; this cut is not lasting authority. Not exposed by the hosted peer.`,
  parameters: ObserveWakeRequest,
  success: WakeObservation,
  failure: Failure,
})
  .annotateMerge(Lookup)
  .annotate(Tool.Strict, true);

export const CheckWakeBinding = Tool.make("bus_check_wake_binding", {
  description: `Internal loopback check of a complete captured native holding, not mail observation or subscription authority by itself. Returns binding and observationCut only after current session/runtime/local-installation/history/run checks. Ordinary renewal preserves the run; leave/rejoin, takeover, replay, runtime or history change refuses the captured binding. No mail, cursor, activity or mute eligibility is read; no state, native marks, hooks or waiters change. Already captured notices are not invalidated by later read, mute, inactivity or oversized unread backlog. Primary presence damage or unavailable authority refuses, never substitutes a new binding. Complete arguments and duplicated text/structured result carrier each fit ${MAX_WAKE_OBSERVATION_BYTES} UTF-8 JSON bytes, excluding JSON-RPC framing. A later cross-machine change can race this cut; external sends must also pass current grants, finite lease and callback checks. Not exposed by the hosted peer.`,
  parameters: CheckWakeBindingRequest,
  success: WakeBindingCheck,
  failure: Failure,
})
  .annotateMerge(Lookup)
  .annotate(Tool.Strict, true);

// Not read-only: it moves the mark of what the session was woken for.
export const Wake = Tool.make("bus_wake", {
  description: `For agent-bus's Claude Code hook, which wakes the session; sessions don't call this. Waits up to ${MAX_WAIT_SECONDS} seconds for previously unwoken mail to an address the session joined as Claude from this bus installation, and returns those addresses. A compact hook uses fresh to ring unchanged unread mail again and exits after its first nonempty response. Returns no message bodies and acknowledges no mail; a newer call from the same session ends this one.`,
  parameters: Schema.Struct({
    session: Session,
    fresh: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "For a SessionStart compact hook only: bypass unchanged-unread suppression. Keep true on empty/error retries, then exit after the first nonempty response. Repeated fresh calls can each ring; omit for other hooks.",
      })
    ),
  }),
  success: Woken,
  failure: Failure,
}).annotateMerge(Local);

export const Owned = Tool.make("bus_owned_addresses", {
  description:
    "For native compact recovery hooks, or direct read-only recovery of lost join context: list all latest joined addresses held by the exact session and runtime, ordered by address. These are session-level holdings, not inbox assignments to your role; use only your assigned address. This is not a wake, mail check or ownership claim. Returns no session values, notes or guidance bodies. Changes no cursor, activity, hook observation, waiter or wake mark. Later ownership refusals remain authoritative.",
  parameters: Schema.Struct({
    session: Session,
    runtime: Runtime.annotate({ description: "The exact runtime the addresses joined as." }),
  }),
  success: OwnedAddresses,
  failure: Failure,
}).annotateMerge(Lookup);

export const ListPeers = Tool.make("bus_peers", {
  description:
    "List the peers currently joined to the bus, with their addresses, runtimes, topics, machines and notes, ordered by address. Stored session claims and wake destinations are not returned. A preset over bus_run_query's peers at the current commit.",
  success: Peers,
  failure: Failure,
}).annotateMerge(Lookup);

export const History = Tool.make("bus_history", {
  description:
    "Past messages, newest last: without query, the newest limit messages; with query, the best full-text matches. Filter by a participant address. Does not change what is unread. Returns the same public message fields as bus_read, without stored presence or session claims. A preset over bus_run_query's history and search at one commit; use bus_run_query for snapshots, paging and completeness.",
  parameters: Schema.Struct({
    query: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Words to search subjects and bodies for; the best matches, from one evaluation of Fluree's full-text scores, are returned instead of the newest. If the ranking had to be cut and still yields fewer readable messages than limit, the call fails rather than return fewer; when the matches run out, fewer are returned.",
      })
    ),
    participant: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Only messages sent by this, or naming it among their recipients exactly: an address, #topic or *.",
      })
    ),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: `The most messages to return; defaults to ${DEFAULT_HISTORY_LIMIT}.`,
      })
    ),
  }),
  success: Messages,
  failure: Failure,
}).annotateMerge(Lookup);

export const Query = Tool.make("bus_query", {
  description: `Run one read-only SPARQL SELECT over the bus ledger at one commit t (head by default) and return its bindings. No FROM, GRAPH or SERVICE; updates and other query forms are refused. Rows are bindings, not messages. At most ${MAX_SPARQL_ROWS} rows and ${MAX_ENVELOPE_BYTES} bytes: complete is false when a cap cut the result. Prefixes bus:, xsd:, rdf: and f: are predeclared; bus_queries describes the graph. Prefer bus_run_query's saved queries.`,
  parameters: Schema.Struct({
    query: Schema.String.annotate({
      description: `One SPARQL SELECT query, up to ${MAX_QUERY_LENGTH.toLocaleString("en-US")} characters.`,
    }),
    t: Schema.optionalKey(
      Schema.Int.annotate({
        description:
          "The commit to read at, from 1 to the current head; defaults to head. Reuse a result's t to read the same snapshot again.",
      })
    ),
  }),
  success: Schema.Struct({
    name: Schema.Literal("sparql"),
    ledger: Schema.String.annotate({ description: "The ledger incarnation read." }),
    t: Schema.Int.annotate({ description: "The commit every row was read at." }),
    currentHeadT: Schema.optionalKey(
      Schema.Int.annotate({ description: "The head when the query finished, if past t." })
    ),
    unit: Schema.Literal("binding"),
    columns: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Array(Schema.String)])
    ).annotate({
      description: "Each variable's datatype, or its datatypes when they vary.",
    }),
    rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    complete: Schema.Boolean.annotate({
      description: "Every solution of the query as written is in rows.",
    }),
    cut: Schema.optionalKey(
      Schema.Literals(["rows", "bytes"]).annotate({
        description: "The server cap that stopped the result: more rows exist.",
      })
    ),
    limitReached: Schema.optionalKey(
      Schema.Literal(true).annotate({
        description: "The query's own LIMIT was reached; more solutions may exist.",
      })
    ),
    note: Schema.String,
  }),
  failure: Failure,
}).annotateMerge(Lookup);

export const RunQuery = Tool.make("bus_run_query", {
  description: `Run one saved query from the catalogue (bus_queries lists them, with argument and row schemas) at one commit t, and return one page. Pass next back as cursor, with the same name and args, for the following page at the same t (search continues the ranking of its first page while the bus holds it: see its note and selection). exhausted means no page follows; complete means exhausted with every record read, which ranked and predicate-only queries never claim. Whole rows fit in at most ${MAX_ENVELOPE_BYTES} UTF-8 JSON bytes by default, or in maxPageBytes when supplied. The call has ${SAVED_QUERY_DEADLINE_SECONDS} seconds, including waiting for a query permit.`,
  parameters: Schema.Struct({
    name: Schema.Literals(operationNames).annotate({ description: "The saved query to run." }),
    args: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Its arguments, as bus_queries describes them; unknown keys are refused.",
      })
    ),
    ledger: Schema.optionalKey(
      Schema.String.annotate({
        description: "Refuse unless this is still the ledger incarnation being read.",
      })
    ),
    t: Schema.optionalKey(
      Schema.Int.annotate({
        description:
          "The commit to read at, from 1 to the current head; defaults to head, or the cursor's.",
      })
    ),
    cursor: Schema.optionalKey(
      Schema.String.annotate({
        description: "A previous result's next, to continue that traversal.",
      })
    ),
    maxPageBytes: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(MAX_ENVELOPE_BYTES))
        .annotate({
          description: "Optional smaller logical JSON page ceiling, not a transport byte limit.",
        })
    ),
  }),
  success: QueryEnvelope,
  failure: Failure,
}).annotateMerge(Lookup);

export const Queries = Tool.make("bus_queries", {
  description:
    "List the saved-query catalogue for bus_run_query: each operation's purpose, unit, paging, completeness note, argument and row JSON Schemas and an example, with the ledger's incarnation and head t, and the raw SPARQL vocabulary for bus_query.",
  success: Schema.Struct({
    catalogueVersion: Schema.Int,
    ledger: Schema.String,
    headT: Schema.Int,
    operations: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        purpose: Schema.String,
        unit: Schema.String,
        paging: Schema.Literals(["keyset", "offset", "none"]),
        coverage: Schema.Literals(["entries", "ranked", "predicates"]),
        note: Schema.String,
        args: Schema.Record(Schema.String, Schema.Unknown),
        row: Schema.Record(Schema.String, Schema.Unknown),
        example: Schema.Struct({
          name: Schema.String,
          args: Schema.Record(Schema.String, Schema.Unknown),
        }),
      })
    ),
    raw: Schema.Struct({
      tool: Schema.Literal("bus_query"),
      prefixes: Schema.Record(Schema.String, Schema.String),
      predicates: Schema.Array(Schema.String),
      maxRows: Schema.Int,
      maxQueryLength: Schema.Int,
      note: Schema.String,
    }),
  }),
  failure: Failure,
}).annotateMerge(Lookup);

export const Leave = Tool.make("bus_leave", {
  description: "Leave the bus; peers stop seeing you and the bus stops waking you.",
  parameters: Schema.Struct({ address: Address, session: Session }),
  success: Left,
  failure: Failure,
}).annotateMerge(Local);
