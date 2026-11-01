import type { HistoryInput } from "../shared/public";

/** Empty form fields mean absent; every other byte remains a literal server input. */
export function canonicalHistoryInput(input: HistoryInput): HistoryInput {
  return {
    limit: input.limit,
    ...(input.query === undefined || input.query === "" ? {} : { query: input.query }),
    ...(input.participant === undefined || input.participant === ""
      ? {}
      : { participant: input.participant }),
  };
}

export function historyInputKey(input: HistoryInput): string {
  const canonical = canonicalHistoryInput(input);
  return JSON.stringify([canonical.limit, canonical.query ?? null, canonical.participant ?? null]);
}

export function isHistoryInvestigation(input: HistoryInput): boolean {
  return input.query !== undefined || input.participant !== undefined;
}
