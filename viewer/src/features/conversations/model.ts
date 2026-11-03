import type { PublicMessage } from "../../../shared/public.ts";

export type ConversationContext =
  | { readonly kind: "all" | "broadcast" }
  | { readonly kind: "topic" | "address"; readonly value: string };

export interface ObservedConversation {
  readonly anchorMessageId: string;
  readonly messages: readonly PublicMessage[];
  readonly missingTargetIds: readonly string[];
  readonly latestSourceIndex: number;
  readonly cyclic: boolean;
}

export interface ConversationIndex {
  readonly conversations: readonly ObservedConversation[];
  readonly byMessageId: ReadonlyMap<string, ObservedConversation>;
  readonly contexts: readonly ConversationContext[];
}

export const contextKey = (context: ConversationContext): string =>
  JSON.stringify(
    context.kind === "topic" || context.kind === "address"
      ? [context.kind, context.value]
      : [context.kind]
  );

export const messageMatchesContext = (
  message: PublicMessage,
  context: ConversationContext
): boolean => {
  switch (context.kind) {
    case "all":
      return true;
    case "broadcast":
      return message.to.includes("*");
    case "topic":
      return message.to.includes(context.value);
    case "address":
      return message.from === context.value || message.to.includes(context.value);
  }
};

export const conversationsForContext = (
  index: ConversationIndex,
  context: ConversationContext
): readonly ObservedConversation[] =>
  context.kind === "all"
    ? index.conversations
    : index.conversations.filter((conversation) =>
        conversation.messages.some((message) => messageMatchesContext(message, context))
      );

interface Component {
  readonly messages: PublicMessage[];
  readonly missingTargetIds: string[];
  latestSourceIndex: number;
  cyclic: boolean;
}

const invalid = (): never => {
  throw new Error("Conversation observation rejected");
};

/** Group only explicit references inside one observation, never topic co-occurrence. */
export const buildConversationIndex = (observation: {
  readonly messages: readonly PublicMessage[];
}): ConversationIndex => {
  const messages = observation.messages;
  const real = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (real.has(message.id)) return invalid();
    real.set(message.id, index);
  }

  const edges: number[][] = Array.from({ length: messages.length }, () => []);
  const parents: Array<number | undefined> = Array.from(
    { length: messages.length },
    () => undefined
  );
  // Virtual nodes use numeric indexes in a separate map, so arbitrary IDs cannot collide.
  const missing = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.replyTo === undefined) continue;
    let target = real.get(message.replyTo);
    if (target === undefined) {
      target = missing.get(message.replyTo);
      if (target === undefined) {
        target = edges.length;
        missing.set(message.replyTo, target);
        edges.push([]);
      }
    } else {
      parents[index] = target;
    }
    const sourceEdges = edges[index];
    const targetEdges = edges[target];
    if (sourceEdges === undefined || targetEdges === undefined) return invalid();
    sourceEdges.push(target);
    targetEdges.push(index);
  }

  // Each real message has at most one parent. Three-color walks detect cycles without recursion.
  const colors = Array<number>(messages.length).fill(0);
  const cycleMembers = new Set<number>();
  for (let start = 0; start < messages.length; start++) {
    if (colors[start] !== 0) continue;
    const path: number[] = [];
    let cursor: number | undefined = start;
    while (cursor !== undefined && colors[cursor] === 0) {
      colors[cursor] = 1;
      path.push(cursor);
      cursor = parents[cursor];
    }
    if (cursor !== undefined && colors[cursor] === 1) cycleMembers.add(cursor);
    for (const node of path) colors[node] = 2;
  }

  const membership = new Map<number, Component>();
  const components: Component[] = [];
  for (let start = 0; start < edges.length; start++) {
    if (membership.has(start)) continue;
    const component: Component = {
      messages: [],
      missingTargetIds: [],
      latestSourceIndex: -1,
      cyclic: false,
    };
    components.push(component);
    const pending = [start];
    membership.set(start, component);
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) return invalid();
      for (const adjacent of edges[node] ?? []) {
        if (membership.has(adjacent)) continue;
        membership.set(adjacent, component);
        pending.push(adjacent);
      }
    }
  }

  // Fill after traversal so each component preserves the supplied API order, not graph-walk order.
  for (const [index, message] of messages.entries()) {
    const component = membership.get(index);
    if (component === undefined) return invalid();
    component.messages.push(message);
    component.latestSourceIndex = index;
    if (cycleMembers.has(index)) component.cyclic = true;
  }
  for (const [id, node] of missing) {
    const component = membership.get(node);
    if (component === undefined) return invalid();
    component.missingTargetIds.push(id);
  }

  const byMessageId = new Map<string, ObservedConversation>();
  for (const component of components) {
    const first = component.messages[0];
    if (first === undefined) return invalid();
    const conversation: ObservedConversation = {
      anchorMessageId: first.id,
      messages: component.messages,
      missingTargetIds: component.missingTargetIds,
      latestSourceIndex: component.latestSourceIndex,
      cyclic: component.cyclic,
    };
    for (const message of component.messages) byMessageId.set(message.id, conversation);
  }
  const conversations: ObservedConversation[] = [];
  const included = new Set<ObservedConversation>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined) return invalid();
    const conversation = byMessageId.get(message.id);
    if (conversation === undefined) return invalid();
    if (!included.has(conversation)) {
      included.add(conversation);
      conversations.push(conversation);
    }
  }

  const contexts: ConversationContext[] = [{ kind: "all" }];
  const keys = new Set([contextKey({ kind: "all" })]);
  const addContext = (context: ConversationContext) => {
    const key = contextKey(context);
    if (keys.has(key)) return;
    keys.add(key);
    contexts.push(context);
  };
  for (const message of messages) {
    addContext({ kind: "address", value: message.from });
    for (const recipient of message.to) {
      addContext(
        recipient === "*"
          ? { kind: "broadcast" }
          : { kind: recipient.startsWith("#") ? "topic" : "address", value: recipient }
      );
    }
  }
  return { conversations, byMessageId, contexts };
};
