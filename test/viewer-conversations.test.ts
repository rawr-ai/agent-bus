import { expect, test } from "bun:test";
import type { HistoryObservation, PublicMessage } from "../viewer/shared/public.ts";
import {
  buildConversationIndex,
  type ConversationContext,
  contextKey,
  conversationsForContext,
  messageMatchesContext,
} from "../viewer/src/features/conversations/model.ts";

const message = (id: string, fields: Partial<PublicMessage> = {}): PublicMessage => ({
  id,
  ts: "not-a-date",
  from: "fixture/sender",
  to: [],
  kind: "message",
  body: `Body ${id}`,
  ...fields,
});
const observation = (messages: PublicMessage[]): HistoryObservation => ({
  messages,
  criteria: { limit: 200 },
  observedAt: "fixture-observation",
  omitted: 0,
  snapshot: { ledger: "fixture-ledger", t: 1 },
  window: "all",
  damaged: 0,
  complete: true,
});
const ids = (messages: readonly PublicMessage[]) => messages.map((item) => item.id);

test("literal topic/address contexts select whole cross-audience reply components", () => {
  const input = observation([
    message("a", { to: ["#Alpha"], from: "one" }),
    message("b", { to: ["person"], from: "two", replyTo: "a" }),
    message("separate", { to: ["#Alpha"], from: "three" }),
    message("c", { to: ["#Beta"], from: "four", replyTo: "b" }),
  ]);
  const index = buildConversationIndex(input);
  expect(index.conversations.map((group) => ids(group.messages))).toEqual([
    ["a", "b", "c"],
    ["separate"],
  ]);
  expect(
    conversationsForContext(index, { kind: "topic", value: "#Alpha" }).map((group) =>
      ids(group.messages)
    )
  ).toEqual([["a", "b", "c"], ["separate"]]);
  expect(
    conversationsForContext(index, { kind: "topic", value: "#Beta" }).map((group) =>
      ids(group.messages)
    )
  ).toEqual([["a", "b", "c"]]);
  expect(
    conversationsForContext(index, { kind: "address", value: "person" }).map((group) =>
      ids(group.messages)
    )
  ).toEqual([["a", "b", "c"]]);
  expect(index.byMessageId.get("b")).toBe(index.byMessageId.get("a"));
  expect(index.byMessageId.get("a")?.messages[1]?.to).toEqual(["person"]);
  expect(index.byMessageId.get("separate")).not.toBe(index.byMessageId.get("a"));
});

test("shared missing parents group siblings without fabricating a message", () => {
  const index = buildConversationIndex(
    observation([
      message("d", { replyTo: "missing" }),
      message("e", { replyTo: "missing" }),
      message("f", { replyTo: "another-missing" }),
    ])
  );
  expect(index.conversations.map((group) => ids(group.messages))).toEqual([["f"], ["d", "e"]]);
  expect(index.byMessageId.get("d")?.missingTargetIds).toEqual(["missing"]);
  expect(index.byMessageId.has("missing")).toBe(false);
  expect(index.conversations.every((group) => !group.cyclic)).toBe(true);
});

test("self, two-node cycles and attached branches terminate and mark only their groups", () => {
  const index = buildConversationIndex(
    observation([
      message("self", { replyTo: "self" }),
      message("x", { replyTo: "y" }),
      message("y", { replyTo: "x" }),
      message("branch", { replyTo: "x" }),
      message("plain"),
    ])
  );
  expect(
    index.conversations.map((group) => ({ ids: ids(group.messages), cyclic: group.cyclic }))
  ).toEqual([
    { ids: ["plain"], cyclic: false },
    { ids: ["x", "y", "branch"], cyclic: true },
    { ids: ["self"], cyclic: true },
  ]);
  expect(index.byMessageId.get("x")?.missingTargetIds).toEqual([]);
});

test("empty IDs and empty references are meaningful, distinct from absent reference", () => {
  const known = buildConversationIndex(
    observation([message(""), message("child", { replyTo: "" }), message("unlinked")])
  );
  expect(ids(known.byMessageId.get("")?.messages ?? [])).toEqual(["", "child"]);
  expect(known.byMessageId.get("child")?.missingTargetIds).toEqual([]);
  const missing = buildConversationIndex(
    observation([
      message("first", { replyTo: "" }),
      message("second", { replyTo: "" }),
      message("no-reference"),
    ])
  );
  expect(ids(missing.byMessageId.get("first")?.messages ?? [])).toEqual(["first", "second"]);
  expect(missing.byMessageId.get("first")?.missingTargetIds).toEqual([""]);
  expect(missing.byMessageId.get("no-reference")).not.toBe(missing.byMessageId.get("first"));
  expect(
    buildConversationIndex(observation([message("", { replyTo: "" })])).conversations[0]?.cyclic
  ).toBe(true);
});

test("opaque IDs cannot collide with virtual nodes, map prototypes or context encodings", () => {
  const index = buildConversationIndex(
    observation([
      message("missing:parent"),
      message("child", { replyTo: "parent" }),
      message("__proto__", { replyTo: "constructor" }),
      message("constructor"),
      message('["topic","#A"]'),
    ])
  );
  expect(index.conversations).toHaveLength(4);
  expect(index.byMessageId.get("child")?.missingTargetIds).toEqual(["parent"]);
  expect(index.byMessageId.get("child")).not.toBe(index.byMessageId.get("missing:parent"));
  expect(ids(index.byMessageId.get("__proto__")?.messages ?? [])).toEqual([
    "__proto__",
    "constructor",
  ]);
});

test("context identities preserve odd strings, case, whitespace and distinct roles", () => {
  const input = message("odd", {
    from: "#sender",
    to: ["#", "#Case", "#case", "", " A ", "*", "#Case"],
  });
  const index = buildConversationIndex(observation([input]));
  expect(index.contexts).toEqual([
    { kind: "all" },
    { kind: "address", value: "#sender" },
    { kind: "topic", value: "#" },
    { kind: "topic", value: "#Case" },
    { kind: "topic", value: "#case" },
    { kind: "address", value: "" },
    { kind: "address", value: " A " },
    { kind: "broadcast" },
  ]);
  expect(messageMatchesContext(input, { kind: "topic", value: "#sender" })).toBe(false);
  expect(messageMatchesContext(input, { kind: "address", value: "#sender" })).toBe(true);
  expect(messageMatchesContext(input, { kind: "address", value: "A" })).toBe(false);
  const contexts: ConversationContext[] = [
    { kind: "all" },
    { kind: "broadcast" },
    { kind: "address", value: "all" },
    { kind: "topic", value: "all" },
    { kind: "topic", value: 'a","b' },
    { kind: "topic", value: 'a","b"' },
    { kind: "address", value: "" },
  ];
  expect(new Set(contexts.map(contextKey)).size).toBe(contexts.length);
  expect(contextKey({ kind: "topic", value: "#A" })).toBe('["topic","#A"]');
});

test("broadcast and topic recipients never expand into hypothetical address recipients", () => {
  const broadcast = message("broadcast", { to: ["*"] });
  const topic = message("topic", { to: ["#subscribed"] });
  for (const item of [broadcast, topic]) {
    expect(messageMatchesContext(item, { kind: "address", value: "joined/subscriber" })).toBe(
      false
    );
  }
  const index = buildConversationIndex(observation([broadcast, topic]));
  expect(
    conversationsForContext(index, { kind: "broadcast" }).map((group) => ids(group.messages))
  ).toEqual([["broadcast"]]);
  expect(conversationsForContext(index, { kind: "address", value: "joined/subscriber" })).toEqual(
    []
  );
  expect(conversationsForContext(index, { kind: "all" })).toBe(index.conversations);
});

test("shared subject, time, address pair, body mentions and topic are not reply edges", () => {
  const index = buildConversationIndex(
    observation([
      message("a", {
        from: "alice",
        to: ["bob", "#ops"],
        subject: "Same",
        body: "Mentions #not-addressed",
      }),
      message("b", { from: "bob", to: ["alice", "#ops"], subject: "Same" }),
    ])
  );
  expect(index.conversations.map((group) => ids(group.messages))).toEqual([["b"], ["a"]]);
  expect(conversationsForContext(index, { kind: "address", value: "alice" })).toHaveLength(2);
  expect(index.contexts).not.toContainEqual({ kind: "topic", value: "#not-addressed" });
});

test("literal topic variants and broadcast lookalikes are never normalized", () => {
  const values = ["#Ops", "#ops", "# ops", "#", "##ops", "ops", "* ", "*"];
  const index = buildConversationIndex(
    observation(values.map((value, position) => message(String(position), { to: [value] })))
  );
  expect(index.contexts.filter((context) => context.kind === "topic")).toEqual([
    { kind: "topic", value: "#Ops" },
    { kind: "topic", value: "#ops" },
    { kind: "topic", value: "# ops" },
    { kind: "topic", value: "#" },
    { kind: "topic", value: "##ops" },
  ]);
  expect(
    conversationsForContext(index, { kind: "broadcast" }).map((group) => ids(group.messages))
  ).toEqual([["7"]]);
  expect(
    conversationsForContext(index, { kind: "address", value: "* " }).map((group) =>
      ids(group.messages)
    )
  ).toEqual([["6"]]);
});

test("original source order and latest source index override invalid or conflicting timestamps", () => {
  const input = observation([
    message("future", { ts: "2099-01-01T00:00:00Z" }),
    message("separate", { ts: "1900-01-01T00:00:00Z" }),
    message("invalid", { ts: "not-a-date", replyTo: "future" }),
    message("early", { ts: "1900-01-01T00:00:00Z", replyTo: "invalid" }),
    message("last", { ts: "" }),
  ]);
  const index = buildConversationIndex(input);
  expect(
    index.conversations.map((group) => ({
      ids: ids(group.messages),
      latest: group.latestSourceIndex,
    }))
  ).toEqual([
    { ids: ["last"], latest: 4 },
    { ids: ["future", "invalid", "early"], latest: 3 },
    { ids: ["separate"], latest: 1 },
  ]);
  expect(index.byMessageId.get("future")?.anchorMessageId).toBe("future");
});

test("200-message reverse-reference chain is iterative and preserves all supplied records", () => {
  const input = observation(
    Array.from({ length: 200 }, (_, index) =>
      message(String(index), index === 199 ? {} : { replyTo: String(index + 1) })
    )
  );
  const index = buildConversationIndex(input);
  expect(index.conversations).toHaveLength(1);
  expect(ids(index.conversations[0]?.messages ?? [])).toEqual(
    Array.from({ length: 200 }, (_, i) => String(i))
  );
  expect(index.conversations[0]?.cyclic).toBe(false);
  expect(index.conversations[0]?.missingTargetIds).toEqual([]);
  expect(index.byMessageId.size).toBe(200);
});

test("duplicate IDs refuse generically without choosing a version", () => {
  for (const id of ["duplicate", "", "__proto__"]) {
    const input = observation([message(id), message(id, { body: "private-sentinel" })]);
    expect(() => buildConversationIndex(input)).toThrow("Conversation observation rejected");
    try {
      buildConversationIndex(input);
    } catch (error) {
      expect(String(error)).not.toContain("private-sentinel");
    }
  }
});

test("projection never mutates records, source arrays, criteria or omission metadata", () => {
  const input: HistoryObservation = {
    ...observation([
      message("child", { to: ["#A"], replyTo: "root", origin: { host: "fixture" } }),
      message("root", { subject: "Observed subject" }),
    ]),
    omitted: 3,
  };
  const before = structuredClone(input);
  Object.freeze(input.messages[0]?.to);
  Object.freeze(input.messages[0]?.origin);
  input.messages.forEach(Object.freeze);
  Object.freeze(input.messages);
  Object.freeze(input.criteria);
  Object.freeze(input);
  const index = buildConversationIndex(input);
  expect(input).toEqual(before);
  expect(index.byMessageId.get("child")?.messages).not.toBe(input.messages);
  expect(index.byMessageId.size).toBe(2);
  expect(index.conversations[0]?.anchorMessageId).toBe("child");
  expect(index.conversations[0]).not.toHaveProperty("title");
});

test("refresh recomputation relocates a selected message after components merge or split", () => {
  const previous = buildConversationIndex(
    observation([message("selected", { replyTo: "parent" }), message("other")])
  );
  const selectedId = "selected";
  const oldGroup = previous.byMessageId.get(selectedId);
  expect(ids(oldGroup?.messages ?? [])).toEqual(["selected"]);
  const merged = buildConversationIndex(
    observation([
      message("selected", { replyTo: "parent" }),
      message("other"),
      message("parent", { replyTo: "other" }),
    ])
  );
  expect(ids(merged.byMessageId.get(selectedId)?.messages ?? [])).toEqual([
    "selected",
    "other",
    "parent",
  ]);
  const split = buildConversationIndex(
    observation([message("selected", { replyTo: "parent" }), message("other")])
  );
  expect(ids(split.byMessageId.get(selectedId)?.messages ?? [])).toEqual(["selected"]);
  const gone = buildConversationIndex(observation([message("other")]));
  expect(gone.byMessageId.get(selectedId)).toBeUndefined();
  expect(ids(oldGroup?.messages ?? [])).toEqual(["selected"]);
  expect(conversationsForContext(gone, { kind: "topic", value: "#disappeared" })).toEqual([]);
});

test("empty and all-omitted observations produce no invented conversations or directory", () => {
  const input: HistoryObservation = { ...observation([]), omitted: 200 };
  const index = buildConversationIndex(input);
  expect(index.conversations).toEqual([]);
  expect(index.byMessageId.size).toBe(0);
  expect(index.contexts).toEqual([{ kind: "all" }]);
});
