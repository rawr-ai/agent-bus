import { MAX_HISTORY_LIMIT } from "../shared/limits";
import type { HistoryInput, PublicMessage } from "../shared/public";
import {
  type ConversationContext,
  contextKey,
  type ObservedConversation,
} from "./features/conversations/model";

export type ReadingIntent =
  | { readonly kind: "conversation"; readonly selectedMessageId: string }
  | { readonly kind: "flow"; readonly context: ConversationContext };

export type ReadingUnit = ReadingIntent & {
  readonly messages: readonly PublicMessage[];
  readonly criteria: HistoryInput;
  readonly observedAt: string;
} & (
    | { readonly kind: "conversation"; readonly conversation: ObservedConversation }
    | { readonly kind: "flow" }
  );

export interface ReadingSnapshot {
  readonly unit: ReadingUnit | null;
  readonly retained: boolean;
}

export const EMPTY_READING_SNAPSHOT: ReadingSnapshot = { unit: null, retained: false };

function intentKey(intent: ReadingIntent): string {
  return intent.kind === "conversation"
    ? JSON.stringify(["conversation", intent.selectedMessageId])
    : JSON.stringify(["flow", contextKey(intent.context)]);
}

/** Choose before rendering: an evicted reading node must never unmount for an effect frame. */
export function reconcileReadingUnit(
  previous: ReadingSnapshot,
  intent: ReadingIntent | null,
  candidate: ReadingUnit | null
): ReadingSnapshot {
  if (
    (previous.unit?.messages.length ?? 0) > MAX_HISTORY_LIMIT ||
    (candidate?.messages.length ?? 0) > MAX_HISTORY_LIMIT
  )
    throw new Error("Reading observation rejected");
  if (intent === null) return EMPTY_READING_SNAPSHOT;
  const key = intentKey(intent);
  if (candidate !== null && intentKey(candidate) !== key)
    throw new Error("Reading observation rejected");
  if (previous.unit === null || intentKey(previous.unit) !== key)
    return candidate === null ? EMPTY_READING_SNAPSHOT : { unit: candidate, retained: false };
  // Once retained, only an explicit reading action clears this one bounded snapshot.
  if (previous.retained) return previous;
  const ids = new Set(candidate?.messages.map((message) => message.id));
  if (candidate === null || previous.unit.messages.some((message) => !ids.has(message.id)))
    return { unit: previous.unit, retained: true };
  return candidate === previous.unit ? previous : { unit: candidate, retained: false };
}
