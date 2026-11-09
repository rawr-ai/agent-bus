import { JsonSchema, Result, Schema, SchemaIssue } from "effect";
import type { StandardJSONSchemaV1 } from "effect/StandardSchema";
import {
  EvidencePage,
  HistoryInput,
  MessagesInput,
  type Operation,
  SearchInput,
  ThreadInput,
} from "./model.ts";
import type { ReadEvidence, ReadResult } from "./reader.ts";

export const READ_SCOPE = "agent-bus:evidence:read";

interface Invocation {
  readonly auth?:
    | {
        readonly authType: string;
        readonly accessToken?: string;
      }
    | undefined;
  readonly signal: AbortSignal;
}

/** The verifier must confirm active provider authorization, not decode an unverified token. */
export interface VerifiedGrant {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly scopes: ReadonlyArray<string>;
}

export const ownerResolver =
  (options: {
    readonly owner: Pick<VerifiedGrant, "issuer" | "subject" | "audience">;
    readonly verify: (
      accessToken: string,
      signal: AbortSignal
    ) => Promise<VerifiedGrant | undefined>;
  }) =>
  async ({ auth, signal }: Invocation) => {
    const deny = () => new Error("Evidence access denied.");
    if (auth?.authType !== "oauth" || !auth.accessToken || signal.aborted) throw deny();
    let grant: VerifiedGrant | undefined;
    try {
      grant = await options.verify(auth.accessToken, signal);
    } catch {
      throw deny();
    }
    if (
      signal.aborted ||
      grant === undefined ||
      grant.issuer !== options.owner.issuer ||
      grant.subject !== options.owner.subject ||
      grant.audience !== options.owner.audience ||
      !grant.scopes.includes(READ_SCOPE)
    )
      throw deny();
    return { owner: true as const };
  };

const validationIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const wireSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input = false) => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const json: StandardJSONSchemaV1.Converter["input"] = ({ target }) => {
    if (target === "draft-2020-12") {
      return {
        $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
        ...document.schema,
        ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
      };
    }
    if (target === "draft-07") {
      const draft = JsonSchema.toDocumentDraft07(document);
      return {
        $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
        ...draft.schema,
        ...(Object.keys(draft.definitions).length === 0 ? {} : { definitions: draft.definitions }),
      };
    }
    throw new Error("Unsupported evidence schema target.");
  };
  const decode = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
    reportInput: false,
  });
  const inputFields = new Set([
    "participants",
    "fromTs",
    "toTs",
    "direction",
    "limit",
    "snapshot",
    "ledger",
    "t",
    "cursor",
    "text",
    "id",
    "ids",
  ]);
  return {
    "~standard": {
      version: 1 as const,
      vendor: "effect",
      jsonSchema: { input: json, output: json },
      validate: (value: unknown) => {
        const result = decode(value);
        if (Result.isSuccess(result)) return { value: result.success };
        if (!input) return { issues: [{ message: "Invalid evidence tool result." }] };
        return {
          issues: validationIssues(result.failure.issue).issues.map(({ path, message }) => {
            const known = path?.filter(
              (key) => typeof key === "number" || (typeof key === "string" && inputFields.has(key))
            );
            return known === undefined || known.length === 0
              ? { message }
              : { path: known, message };
          }),
        };
      },
    },
  };
};

type Refusal = Extract<ReadResult, { refusal: string }>["refusal"];
const refusalMessages: Record<Refusal, string> = {
  RANKING_UNAVAILABLE:
    "This ranking is no longer held. Start a new search; even at the same snapshot, its rank order may differ.",
  EVIDENCE_TOO_LARGE:
    "A whole evidence page cannot fit. This continuation was not consumed; no message was truncated or skipped.",
  EVIDENCE_DAMAGED: "The requested thread focus is unreadable at the snapshot.",
  STALE_LEDGER:
    "That ledger incarnation is no longer current. Do not cite evidence from a replacement as the same source.",
  DEADLINE: "The Bus did not finish the evidence read in time.",
  NOT_FOUND: "The requested thread focus is absent at the snapshot.",
  WITHHELD: "The requested thread focus is not a disclosable message.",
  INVALID_REQUEST:
    "Check the operation, supplied fields and snapshot. When continuing a page, repeat the original operation and filters.",
  INVALID_CURSOR:
    "This continuation is invalid or came from an earlier reader. Restart the traversal at its saved snapshot.",
  CAPACITY: "Evidence reading capacity is busy. No page was consumed.",
  SEARCH_TOO_BROAD:
    "This ranking exceeds the per-search limit. Narrow the words or participants and start a new search.",
  UNAVAILABLE: "The Bus could not return validated evidence.",
};
const refused = (code: Refusal) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ code, message: refusalMessages[code] }) }],
});
const success = (page: typeof EvidencePage.Type) => ({
  structuredContent: page,
  content: [{ type: "text", text: JSON.stringify(page) }],
});

export const evidenceTools = (read: ReadEvidence) => {
  const outputSchema = wireSchema(EvidencePage);
  const tool = <
    S extends Schema.ConstraintDecoder<{
      readonly snapshot?: { readonly ledger: string; readonly t: number } | undefined;
      readonly cursor?: string | undefined;
    }>,
  >(
    operation: Operation,
    description: string,
    schema: S
  ) => ({
    name: `bus_evidence_${operation}`,
    description,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    parameters: wireSchema(schema, true),
    outputSchema,
    execute: async (input: S["Type"], context: { readonly signal: AbortSignal }) => {
      if (context.signal.aborted) return refused("UNAVAILABLE");
      const { snapshot, cursor, ...args } = input;
      // The host owns this invocation until the loopback exchange settles. A downstream HTTP
      // disconnect cannot by itself prove the Bus released its reservation.
      const result = await read({ name: operation, args, snapshot, cursor });
      if (context.signal.aborted) return refused("UNAVAILABLE");
      return "page" in result ? success(result.page) : refused(result.refusal);
    },
  });
  return [
    tool(
      "history",
      "Browse messages by literal participant and UTC time window. One page in commit order; cite each ID with its page snapshot.",
      HistoryInput
    ),
    tool(
      "search",
      "Rank candidate messages by words in their subjects and bodies. Never all matches. Read their evidence using the returned snapshot.",
      SearchInput
    ),
    tool(
      "thread",
      "Read the reply tree of a message at its source snapshot. A missing or withheld link is not evidence of all discussion.",
      ThreadInput
    ),
    tool(
      "messages",
      "Read whole messages by ID at their source snapshot. Distinguishes absent, withheld, unreadable and oversized evidence.",
      MessagesInput
    ),
  ] as const;
};
