import { type Context, Effect, Option, Schema } from "effect";
import {
  type Activity,
  type ActivityReason,
  AddressCommandJson,
  activityAt,
  type DirectScan,
  foldStanding,
  LedgerError,
  type Logged,
  MessageJson,
  type MuteScope,
  needsScan,
  qualifies,
} from "./domain.ts";
import { COMMAND_PREFIX, messageIri } from "./Ledger.ts";
import type { QueryGateway } from "./Query.ts";

/**
 * The one indexed basis for activity (docs/frames/reachable-inactivity.md, "One basis"): the
 * presence and command log, and the direct candidates after an anchor, read at one pinned
 * commit. The Fluree ledger serves delivery from it, and the catalogue serves queries.
 */
type Gateway = Context.Service.Shape<typeof QueryGateway>;

/** Direct candidates read per query, and the most read before a scan is incomplete. */
const DIRECT_PAGE = 200;
const DIRECT_PAGES = 50;

const invalidResponse = () => new LedgerError({ message: "Fluree returned an invalid response." });
const decodeRows =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalidResponse));

const EntryRows = Schema.Array(
  Schema.Tuple([Schema.Number, Schema.String, Schema.NullOr(Schema.String)])
);
const PresenceRows = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.NullOr(Schema.Number),
    Schema.NullOr(Schema.Number),
    Schema.NullOr(Schema.Number),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
  ])
);
const CommandRows = Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.Number]));
const decodeEntry = Schema.decodeUnknownOption(MessageJson);
const decodeCommand = Schema.decodeUnknownOption(AddressCommandJson, {
  onExcessProperty: "error",
});

/** Rows of (t, id, json) grouped by key: an entry stored with several JSON values is damaged. */
const grouped = (rows: ReadonlyArray<readonly [number, string, string | null]>) => {
  const groups = new Map<string, { t: number; id: string; json: string | null; copies: number }>();
  for (const [t, id, json] of rows) {
    const key = JSON.stringify([t, id]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { t, id, json, copies: 1 });
    else group.copies += 1;
  }
  return [...groups.values()];
};

/** An entry's decoded message, or nothing when it is missing, malformed, duplicated or misnamed. */
const entryOf = (group: ReturnType<typeof grouped>[number]) =>
  group.copies > 1 || group.json === null
    ? Option.none()
    : Option.filter(decodeEntry(group.json), (message) => message.id === group.id);

/**
 * Presence rows of (node, entry t, id t, sender t, id, json, from) grouped by node. A valid
 * entry is ordered by its own commit, as the guarded presence read and the guard key on it; a
 * damaged node counts from the latest commit of anything still stored on it. A retraction
 * leaves nothing there, so that is only a lower bound, and the fold lets no reset end it. A
 * node with several ids, entries or senders is damaged; one with neither an id nor an entry
 * holds nothing to read.
 */
const presenceNodes = (
  rows: ReadonlyArray<
    readonly [
      string,
      number | null,
      number | null,
      number | null,
      string | null,
      string | null,
      string | null,
    ]
  >
) => {
  const nodes = new Map<
    string,
    {
      node: string;
      t: number;
      latest: number;
      id: string | null;
      json: string | null;
      from: string | null;
      copies: number;
    }
  >();
  for (const [node, entryT, idT, fromT, id, json, from] of rows) {
    const t = entryT ?? idT;
    if (t === null) continue;
    const latest = Math.max(t, idT ?? t, fromT ?? t);
    const found = nodes.get(node);
    if (found === undefined) nodes.set(node, { node, t, latest, id, json, from, copies: 1 });
    else {
      found.copies += 1;
      found.latest = Math.max(found.latest, latest);
    }
  }
  return [...nodes.values()];
};

/**
 * A presence node's decoded entry, or nothing when it is missing, malformed, duplicated or
 * misnamed. A session-bearing entry must also be the presence its id names, recorded under its
 * own sender, as the guarded presence read requires: no standing rests on one it refuses.
 */
const presenceOf = (node: ReturnType<typeof presenceNodes>[number]) =>
  node.copies > 1 || node.json === null || node.id === null
    ? Option.none()
    : Option.filter(
        decodeEntry(node.json),
        (message) =>
          message.id === node.id &&
          (message.presence?.session === undefined ||
            (message.kind === "presence" &&
              node.node === messageIri(message.id) &&
              node.from === message.from))
      );

/** The address a damaged command names, when its JSON says that much. */
const legibleAddress = (json: string) => {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === "object" && value !== null && "address" in value) {
      return typeof value.address === "string" ? value.address : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/** Every presence entry and command node visible at `t`, in commit order. */
export const logAt = (gateway: Gateway, t: number) =>
  Effect.gen(function* () {
    const presences = yield* gateway
      .jsonld(t, {
        // Every typed presence node, each value a row of its own: nothing missing or repeated is
        // dropped or merged before the fold sees it.
        select: ["?m", "?jt", "?it", "?ft", "?id", "?json", "?from"],
        where: [
          { "@id": "?m", "@type": "bus:Presence" },
          ["optional", { "@id": "?m", "bus:json": { "@value": "?json", "@t": "?jt" } }],
          ["optional", { "@id": "?m", "bus:id": { "@value": "?id", "@t": "?it" } }],
          ["optional", { "@id": "?m", "bus:from": { "@value": "?from", "@t": "?ft" } }],
        ],
        orderBy: "?m",
      })
      .pipe(Effect.flatMap(decodeRows(PresenceRows)));
    const commands = yield* gateway
      .jsonld(t, {
        select: ["?c", "?json", "?t"],
        where: [
          { "@id": "?c", "@type": "bus:AddressCommand" },
          { "@id": "?c", "bus:command": { "@value": "?json", "@t": "?t" } },
        ],
        orderBy: "?t",
      })
      .pipe(Effect.flatMap(decodeRows(CommandRows)));
    const log: Array<Logged> = [];
    for (const node of presenceNodes(presences)) {
      const message = presenceOf(node);
      log.push(
        Option.isSome(message)
          ? { kind: "presence", t: node.t, message: message.value }
          : { kind: "damaged", t: node.latest, lasting: true }
      );
    }
    const nodes = new Map<string, Array<readonly [string, number]>>();
    for (const [subject, json, at] of commands) {
      nodes.set(subject, [...(nodes.get(subject) ?? []), [json, at]]);
    }
    for (const [subject, values] of nodes) {
      const [only] = values;
      const command =
        values.length === 1 && only !== undefined && subject.startsWith(COMMAND_PREFIX)
          ? decodeCommand(only[0])
          : Option.none();
      const at = Math.max(...values.map(([, commit]) => commit));
      log.push(
        Option.isSome(command)
          ? {
              kind: "command",
              t: at,
              operation: subject.slice(COMMAND_PREFIX.length),
              command: command.value,
            }
          : {
              kind: "damaged",
              t: at,
              // Several values may name several addresses: then it may be anyone's.
              address:
                values.length === 1 && only !== undefined ? legibleAddress(only[0]) : undefined,
            }
      );
    }
    return log.sort((a, b) => a.t - b.t);
  });

/**
 * The direct candidates for `address` committed in (after, t], through the indexed `bus:to`,
 * each decoded from its stored JSON, which alone decides whether it qualifies. An indexed
 * sender never rules a damaged candidate out. Pages stop at the first qualifying message.
 */
export const directAt = (gateway: Gateway, address: string, after: number, t: number) =>
  Effect.gen(function* () {
    let damaged = false;
    let key: readonly [number, string] | undefined;
    for (let page = 0; page < DIRECT_PAGES; page++) {
      const rows = yield* gateway
        .jsonld(t, {
          selectDistinct: ["?t", "?id", "?json"],
          where: [
            { "@id": "?m", "bus:to": address },
            { "@id": "?m", "bus:id": { "@value": "?id", "@t": "?t" } },
            ["optional", { "@id": "?m", "bus:json": "?json" }],
            [
              "filter",
              key === undefined
                ? `(> ?t ${after})`
                : `(or (> ?t ${key[0]}) (and (= ?t ${key[0]}) (> ?id ${JSON.stringify(key[1])})))`,
            ],
          ],
          orderBy: ["?t", "?id"],
          limit: DIRECT_PAGE + 1,
        })
        .pipe(Effect.flatMap(decodeRows(EntryRows)));
      const more = rows.length > DIRECT_PAGE;
      const groups = grouped(rows);
      // A full page's last entry may have more copies on the next page: leave it to that page.
      const whole = more && groups.length > 1 ? groups.slice(0, -1) : groups;
      for (const group of whole) {
        const message = entryOf(group);
        if (Option.isNone(message)) damaged = true;
        else if (qualifies(message.value, address)) {
          return {
            found: { ts: message.value.ts, t: group.t },
            damaged,
            complete: true,
          } satisfies DirectScan;
        }
        key = [group.t, group.id];
      }
      if (!more) return { damaged, complete: true } satisfies DirectScan;
    }
    return { damaged, complete: false } satisfies DirectScan;
  });

/** What queries show of an address's activity at their cut. */
export interface Shown {
  readonly activity: Activity;
  readonly activeSince?: string;
  /** With unknown only: why. */
  readonly activityReason?: ActivityReason;
  readonly mutes: ReadonlyArray<MuteScope>;
}

/**
 * Activity and mutes at `t` for each address, from one log read and a direct-candidate scan
 * for each anchor-inactive address: the same fold delivery uses, never coerced.
 */
export const activitiesAt = (gateway: Gateway, t: number, addresses: Iterable<string>) =>
  Effect.gen(function* () {
    const log = yield* logAt(gateway, t);
    const shown = new Map<string, Shown>();
    for (const address of addresses) {
      if (shown.has(address)) continue;
      const standing = foldStanding(address, log);
      const scan = needsScan(standing)
        ? yield* directAt(gateway, address, standing.anchor.t, t)
        : undefined;
      shown.set(address, { ...activityAt(standing, scan), mutes: [...standing.mutes] });
    }
    return shown;
  });
