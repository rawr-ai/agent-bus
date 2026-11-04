import { checkReference, type InvestigationReference } from "../../../shared/public";
import { referenceFits } from "../../../shared/request-size";

/**
 * A pinned investigation link carries its reference as the whole fragment after this prefix:
 * `encodeURIComponent(JSON.stringify(reference))`. The value is decoded as the exact inverse,
 * so a `+` stays a `+`; it never shares the fragment with the live viewer's keys.
 */
const PREFIX = "#investigation=";

export type FragmentReading =
  | { readonly kind: "none" }
  | { readonly kind: "reference"; readonly reference: InvestigationReference }
  | { readonly kind: "refused"; readonly reason: "invalid" | "unsupported" };

/** The investigation a location fragment names, if any, accepted only in the bus's echo form. */
export const parseInvestigationFragment = (hash: string): FragmentReading => {
  if (!hash.startsWith(PREFIX)) return { kind: "none" };
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(hash.slice(PREFIX.length)));
  } catch {
    return { kind: "refused", reason: "invalid" };
  }
  const checked = checkReference(value);
  return "reference" in checked
    ? { kind: "reference", reference: checked.reference }
    : { kind: "refused", reason: checked.refused };
};

/** The fragment that opens `reference`. */
export const investigationHash = (reference: InvestigationReference) =>
  `${PREFIX}${encodeURIComponent(JSON.stringify(reference))}`;

export type Narrowing =
  | { readonly reference: InvestigationReference }
  | { readonly problem: "window" | "too-large" };

/**
 * The same reading over another window at the same commit. Values are kept exactly as typed,
 * and an empty field leaves its bound unset; a value the bus would not echo unchanged is
 * refused, never rewritten.
 */
export const narrowedReference = (
  reference: InvestigationReference,
  fromTs: string,
  toTs: string
): Narrowing => {
  const { fromTs: _from, toTs: _to, ...criteria } = reference.criteria;
  const checked = checkReference({
    ...reference,
    criteria: {
      ...criteria,
      ...(fromTs === "" ? {} : { fromTs }),
      ...(toTs === "" ? {} : { toTs }),
    },
  });
  if (!("reference" in checked)) return { problem: "window" };
  if (!referenceFits(checked.reference)) return { problem: "too-large" };
  return { reference: checked.reference };
};
