import { Effect } from "effect";
import SparqlJs from "sparqljs";
import { InvalidQuery, LedgerError } from "./domain.ts";
import { QueryGateway } from "./Query.ts";

export const BUS = "https://rawr.ai/ns/agent-bus#";

/** Prefixes available to every query without declaring them. */
export const PREFIXES = {
  bus: BUS,
  xsd: "http://www.w3.org/2001/XMLSchema#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  f: "https://ns.flur.ee/db#",
};

export const MAX_QUERY_LENGTH = 32_768;
/** The most rows a raw query returns; one more is fetched to tell whether more exist. */
export const MAX_SPARQL_ROWS = 500;

const invalid = (message: string) => new InvalidQuery({ message });

/** The first construct that would read outside the pinned bus ledger, if any. */
const reachesOut = (node: unknown): string | undefined => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = reachesOut(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  if ("from" in node) return "FROM and FROM NAMED";
  if ("type" in node && node.type === "service") return "SERVICE";
  if ("type" in node && node.type === "graph") return "GRAPH";
  for (const value of Object.values(node)) {
    const found = reachesOut(value);
    if (found !== undefined) return found;
  }
  return undefined;
};

export interface ValidatedSelect {
  /** The query regenerated from its syntax tree, with the server's row cap applied. */
  readonly text: string;
  /** The caller's own LIMIT when it is within the cap and kept as written. */
  readonly callerLimit: number | undefined;
}

/**
 * Checks that a query is one SPARQL SELECT over the bus ledger alone: no FROM
 * or FROM NAMED (the ledger and commit are pinned by the request path), no
 * GRAPH and no SERVICE, which Fluree can answer with an empty success that
 * would pass for a complete result. Returns the query regenerated from its
 * syntax tree, so caller comments, which Fluree reads for PRAGMA request
 * options, never reach the server. A LIMIT above the cap, or none, becomes the
 * cap plus one sentinel row.
 */
export const validateSelect = (text: string) =>
  Effect.gen(function* () {
    if (text.trim() === "" || text.length > MAX_QUERY_LENGTH) {
      return yield* invalid(`A query must be 1-${MAX_QUERY_LENGTH} characters.`);
    }
    const parsed = yield* Effect.try({
      try: () => new SparqlJs.Parser({ prefixes: PREFIXES, sparqlStar: true }).parse(text),
      catch: (cause) =>
        invalid(`Not valid SPARQL: ${cause instanceof Error ? cause.message : String(cause)}`),
    });
    if (parsed.type !== "query" || parsed.queryType !== "SELECT") {
      return yield* invalid("Only SELECT queries are allowed.");
    }
    const outside = reachesOut(parsed);
    if (outside !== undefined) {
      return yield* invalid(
        `${outside} is not allowed: a query reads the bus ledger alone, at the commit t it is pinned to.`
      );
    }
    const written = parsed.limit;
    const keep = written !== undefined && written <= MAX_SPARQL_ROWS;
    const query: SparqlJs.SelectQuery = keep ? parsed : { ...parsed, limit: MAX_SPARQL_ROWS + 1 };
    return {
      text: new SparqlJs.Generator({ sparqlStar: true }).stringify(query),
      callerLimit: keep ? written : undefined,
    } satisfies ValidatedSelect;
  });

/** The largest `bus_query` result, as UTF-8 JSON; the same cap as catalogue results. */
const MAX_RESULT_BYTES = 65_536;

export const SPARQL_NOTE =
  "Rows are SPARQL bindings at t, keyed by variable, not messages: one message can give many rows or none. complete means every solution of the query as written is here; cut says which server cap stopped it (rows: more than 500 solutions; bytes: the byte budget). limitReached means your own LIMIT may have stopped it. Page with your own ORDER BY and OFFSET or a keyset at the same t, or use bus_run_query.";

export interface SparqlEnvelope {
  readonly name: "sparql";
  readonly ledger: string;
  readonly t: number;
  readonly currentHeadT?: number;
  readonly unit: "binding";
  readonly columns: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly complete: boolean;
  readonly cut?: "rows" | "bytes";
  readonly limitReached?: true;
  readonly note: string;
}

/**
 * Runs a caller's SPARQL SELECT read-only at one commit: validated and
 * regenerated first, pinned to `t` (head by default) of one ledger incarnation,
 * capped at 500 rows with a sentinel and at MAX_RESULT_BYTES, whole rows trimmed.
 */
export const runSparql = (text: string, t: number | undefined) =>
  Effect.gen(function* () {
    const gateway = yield* QueryGateway;
    const validated = yield* validateSelect(text);
    const pin = yield* gateway.pin;
    if (t !== undefined && (t < 1 || t > pin.head)) {
      return yield* invalid(`t must be a commit from 1 to ${pin.head}.`);
    }
    const at = t ?? pin.head;
    const result = yield* gateway.sparql(at, validated.text);
    if (result.t !== at) {
      return yield* new LedgerError({ message: "Fluree answered at another commit." });
    }
    const after = yield* gateway.pin;
    if (after.incarnation !== pin.incarnation) {
      return yield* new LedgerError({
        message: "The ledger was replaced while the query ran; run it again.",
      });
    }
    const overCap = validated.callerLimit === undefined && result.rows.length > MAX_SPARQL_ROWS;
    const rows = overCap ? result.rows.slice(0, MAX_SPARQL_ROWS) : result.rows;
    const firstCut = overCap
      ? ("rows" as const)
      : result.truncated
        ? ("bytes" as const)
        : undefined;
    const envelope = (kept: number): SparqlEnvelope => {
      const cut = kept < rows.length ? (firstCut ?? "bytes") : firstCut;
      return {
        name: "sparql",
        ledger: pin.incarnation,
        t: at,
        ...(after.head > at ? { currentHeadT: after.head } : {}),
        unit: "binding",
        columns: result.columns,
        rows: rows.slice(0, kept),
        complete: cut === undefined,
        ...(cut === undefined ? {} : { cut }),
        ...(validated.callerLimit !== undefined && rows.length === validated.callerLimit
          ? { limitReached: true as const }
          : {}),
        note: SPARQL_NOTE,
      };
    };
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    let kept = rows.length;
    let envelopeNow = envelope(kept);
    while (kept > 0 && size(envelopeNow) > MAX_RESULT_BYTES) {
      kept -= 1;
      envelopeNow = envelope(kept);
    }
    // An empty preview is never returned: no binding fitting means the first one is oversized.
    if (kept === 0 && (rows.length > 0 || result.truncated)) {
      return yield* invalid(
        `The first binding (row 1) at t=${at} alone exceeds the result byte limit; select fewer or shorter values.`
      );
    }
    return envelopeNow;
  });
