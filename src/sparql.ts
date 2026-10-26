import { Effect } from "effect";
import SparqlJs from "sparqljs";
import { LedgerError } from "./domain.ts";

export const BUS = "https://rawr.ai/ns/agent-bus#";

/** Prefixes available to every query without declaring them. */
const PREFIXES = {
  bus: BUS,
  xsd: "http://www.w3.org/2001/XMLSchema#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  f: "https://ns.flur.ee/db#",
};

const MAX_QUERY_LENGTH = 32_768;

const invalid = (message: string) => new LedgerError({ message });

/** Whether any node of the query names another dataset or endpoint. */
const reachesOut = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(reachesOut);
  if (typeof node !== "object" || node === null) return false;
  if ("from" in node || ("type" in node && node.type === "service")) return true;
  return Object.values(node).some(reachesOut);
};

/**
 * Checks that a query is a read of the bus ledger alone: one SPARQL SELECT with
 * no FROM (the ledger and time are pinned by the request) and no SERVICE.
 * Returns the query regenerated from its syntax tree, so caller comments, which
 * Fluree reads for PRAGMA directives, never reach the server.
 */
export const validateSelect = (text: string) =>
  Effect.gen(function* () {
    if (text.trim() === "" || text.length > MAX_QUERY_LENGTH) {
      return yield* invalid(`A query must be 1-${MAX_QUERY_LENGTH} characters.`);
    }
    const parsed = yield* Effect.try({
      try: () => new SparqlJs.Parser({ prefixes: PREFIXES }).parse(text),
      catch: (cause) =>
        invalid(`Not valid SPARQL: ${cause instanceof Error ? cause.message : String(cause)}`),
    });
    if (parsed.type !== "query" || parsed.queryType !== "SELECT") {
      return yield* invalid("Only SELECT queries are allowed.");
    }
    if (reachesOut(parsed)) {
      return yield* invalid(
        "FROM and SERVICE are not allowed: queries read the bus ledger, at `t` when given."
      );
    }
    return new SparqlJs.Generator().stringify(parsed);
  });
