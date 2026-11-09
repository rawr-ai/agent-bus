import { Schema } from "effect";

const QueryName = Schema.String;
const CatalogueVersion = Schema.Int;

/** The common page fields exposed by saved queries and embedded orientation pages. */
export const PageEnvelope = Schema.Struct({
  name: QueryName.annotate({ description: "The saved query that owns this page." }),
  catalogueVersion: CatalogueVersion.annotate({ description: "The query catalogue version." }),
  ledger: Schema.String.annotate({ description: "The ledger incarnation read." }),
  t: Schema.Int.annotate({ description: "The commit read for every row." }),
  currentHeadT: Schema.optionalKey(
    Schema.Int.annotate({ description: "The later observed head, when it moved." })
  ),
  unit: Schema.String.annotate({ description: "The unit represented by one row." }),
  args: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "The normalized query arguments.",
  }),
  rows: Schema.Array(Schema.Unknown).annotate({
    description: "Whole rows as described by the saved-query catalogue.",
  }),
  damage: Schema.Literals(["checked", "not-checked"]).annotate({
    description: "Whether entries were checked for damage.",
  }),
  damaged: Schema.Int.annotate({ description: "Damaged units encountered on this page." }),
  damagedAt: Schema.optionalKey(
    Schema.Array(Schema.Int).annotate({
      description: "Known commits of damaged units, when known.",
    })
  ),
  damagedTotal: Schema.Int.annotate({
    description: "Damaged units encountered in this traversal.",
  }),
  exhausted: Schema.Boolean.annotate({ description: "Whether no page follows at this cut." }),
  complete: Schema.Boolean.annotate({
    description: "Whether the declared relation and projection were read without damage.",
  }),
  next: Schema.optionalKey(
    Schema.String.annotate({ description: "The query-owned continuation, when more units remain." })
  ),
  note: Schema.String.annotate({ description: "The query's scope and limits." }),
});

/** Saved-query-only fields remain absent from embedded orientation page schemas. */
export const QueryEnvelope = Schema.Struct({
  ...PageEnvelope.fields,
  name: QueryName,
  catalogueVersion: CatalogueVersion,
  t: PageEnvelope.fields.t.annotate({ description: "The commit every row was read at." }),
  currentHeadT: Schema.optionalKey(
    PageEnvelope.fields.currentHeadT.schema.annotate({
      description: "The head when the page finished, if past t.",
    })
  ),
  unit: PageEnvelope.fields.unit.annotate({ description: "What one row is." }),
  args: PageEnvelope.fields.args.annotate({
    description: "The arguments as run, defaults included.",
  }),
  rows: PageEnvelope.fields.rows.annotate({
    description: "This page's rows, shaped as bus_queries describes for the operation.",
  }),
  damage: PageEnvelope.fields.damage.annotate({
    description:
      "not-checked: counted from graph predicates; damaged stored entries are not detected.",
  }),
  damaged: PageEnvelope.fields.damaged.annotate({
    description: "Unreadable entries passed on this page.",
  }),
  damagedAt: Schema.optionalKey(
    PageEnvelope.fields.damagedAt.schema.annotate({ description: "Their commits, up to 20." })
  ),
  damagedTotal: PageEnvelope.fields.damagedTotal.annotate({
    description: "Unreadable entries passed so far.",
  }),
  exhausted: PageEnvelope.fields.exhausted.annotate({ description: "No page follows at t." }),
  complete: PageEnvelope.fields.complete.annotate({
    description: "Exhausted, and every record in the traversal was read.",
  }),
  next: Schema.optionalKey(
    PageEnvelope.fields.next.schema.annotate({
      description: "Pass as cursor for the next page at the same t.",
    })
  ),
  note: PageEnvelope.fields.note.annotate({
    description: "The operation's scope and labelling limits.",
  }),
  notFound: Schema.optionalKey(Schema.Array(Schema.String)),
  root: Schema.optionalKey(Schema.String),
  members: Schema.optionalKey(Schema.Int),
  missingReplyTargets: Schema.optionalKey(Schema.Array(Schema.String)),
  omitted: Schema.optionalKey(
    Schema.Int.annotate({ description: "Evidence rows withheld on this page." })
  ),
  omittedTotal: Schema.optionalKey(
    Schema.Int.annotate({ description: "Evidence rows withheld so far in this traversal." })
  ),
  omittedReplyTargets: Schema.optionalKey(
    Schema.Int.annotate({
      description: "References to withheld or unreadable targets on this evidence page.",
    })
  ),
  rootOmitted: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "The reply tree's root could not be disclosed as message evidence.",
    })
  ),
  total: Schema.optionalKey(Schema.Int),
  totals: Schema.optionalKey(
    Schema.Struct({
      directorToCohort: Schema.Int,
      observedTrafficDays: Schema.Int,
      ratio: Schema.NullOr(Schema.Finite),
    })
  ),
  missingJson: Schema.optionalKey(
    Schema.Int.annotate({
      description: "A lower bound on damaged entries in scope: those with no stored JSON at all.",
    })
  ),
  selection: Schema.optionalKey(
    Schema.Struct({
      entries: Schema.Int.annotate({
        description:
          "Entries retained from this traversal's ranking, evaluated once on its first page.",
      }),
      truncated: Schema.Boolean.annotate({
        description: "Whether matches ranked below those entries were left out of the ranking.",
      }),
      expiresAt: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "When the bus stops holding the ranking for this traversal's cursors; present only while one is held.",
        })
      ),
    }).annotate({ description: "Search only: the ranking this traversal pages through." })
  ),
});
