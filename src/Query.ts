import { Context, Effect, Layer } from "effect";
import { LedgerError } from "./domain.ts";

/** The ledger's identity at one moment: its head commit and the incarnation it belongs to. */
export interface Pin {
  /** The latest commit `t`. */
  readonly head: number;
  /**
   * The id of the ledger's first commit. A ledger replaced under the same
   * alias has another, so `t` alone never names a snapshot across replacements.
   */
  readonly incarnation: string;
}

/** Agent JSON's result for a single-ledger SELECT. */
export interface SparqlResult {
  /** Each variable's datatype, or its datatypes when they vary. */
  readonly columns: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** The commit Fluree reports it read. */
  readonly t: number;
  /** Fluree cut rows to its byte budget: formatter metadata, not the end of the relation. */
  readonly truncated: boolean;
}

/**
 * Read-only access to the ledger for queries. Every query is pinned in the
 * request path to one commit (`/query/{ledger}@t:{t}`), so it reads what was
 * visible at that commit and nothing else; there is no method that writes.
 */
export class QueryGateway extends Context.Service<
  QueryGateway,
  {
    readonly pin: Effect.Effect<Pin, LedgerError>;
    /** A JSON-LD query (without `from`) at commit `t`. */
    readonly jsonld: (
      t: number,
      body: Record<string, unknown>
    ) => Effect.Effect<unknown, LedgerError>;
    /** An already validated SPARQL SELECT at commit `t`, as budgeted Agent JSON. */
    readonly sparql: (t: number, text: string) => Effect.Effect<SparqlResult, LedgerError>;
  }
>()("agent-bus/QueryGateway") {
  /** For stores without a query engine (the tests' JSONL ledger): every call refuses. */
  static readonly layerUnavailable = Layer.succeed(
    QueryGateway,
    QueryGateway.of({
      pin: Effect.fail(unavailable()),
      jsonld: () => Effect.fail(unavailable()),
      sparql: () => Effect.fail(unavailable()),
    })
  );
}

function unavailable() {
  return new LedgerError({ message: "Queries need the Fluree ledger." });
}
