import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import {
  decodeMailboxFact,
  encodeMailboxFact,
  type MailboxAck,
  type MailboxStart,
  mailboxFactOf,
  mailboxIntentMatches,
  mailboxIri,
  mailboxPresenceRef,
  mailboxReceiptIri,
  mailboxRunRef,
  mailboxServedDigest,
  mailboxTopicsDigest,
  validMailboxFactAt,
} from "../src/mailbox-model.ts";

const address = "claude/test";
const operation = () => Bun.randomUUIDv7();
const start = (): MailboxStart => ({
  version: 1,
  kind: "start",
  operation: operation(),
  address,
  run: "run",
  origin: "join",
  position: 0,
});
const ack = (): MailboxAck => ({
  version: 1,
  kind: "ack",
  operation: operation(),
  address,
  mode: "read",
  run: "run",
  from: 0,
  through: 2,
  dataCut: { incarnation: "fixture", head: 2 },
  subscription: { presenceId: "legacy-presence", topicsDigest: mailboxTopicsDigest(["a", "b"]) },
  servedCount: 1,
  servedDigest: mailboxServedDigest(["message"]),
  carrierBytes: 42,
});

describe("compact mailbox receipts", () => {
  test("address keys preserve exact UTF-16, punctuation and normalization", () => {
    const keys = ["?one/two", "?one%2Ftwo", "\ud800", "\ud801", "\ufffd", "\u00e9", "e\u0301"];
    expect(new Set(keys.map(mailboxIri)).size).toBe(keys.length);
    expect(mailboxReceiptIri(operation())).not.toBe(mailboxIri("anything"));
  });

  test("identity references are versioned, domain separated and preserve UTF-16 units", () => {
    expect(mailboxRunRef('a"b\\c')).toBe(
      "v1:3192085d26e75d904c27be47c0e15c48d871ef6517f1b8ca9f3b7d7667258c84"
    );
    expect(mailboxPresenceRef('a"b\\c')).toBe(
      "v1:580397203a13172ad6c0e02febbc04f35916b490d62caf0752cc904e1f058e22"
    );
    expect(mailboxRunRef("\ud800")).toBe(
      "v1:a51978074d937b5893ef1d94b4052e804db5806c3b493e31b1543a13ecb19fe6"
    );
    expect(mailboxRunRef("\ud800")).not.toBe(mailboxRunRef("\ud801"));
    expect(mailboxRunRef("\ud800")).not.toBe(mailboxRunRef("\ufffd"));
    expect(mailboxRunRef("same")).not.toBe(mailboxPresenceRef("same"));
  });

  test("ordered-ID and topic digests use UTF-8 JSON and preserve boundaries", () => {
    const empty = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
    expect(mailboxServedDigest([])).toBe(empty);
    expect(mailboxTopicsDigest([])).toBe(empty);
    expect(mailboxServedDigest(["a", "b"])).not.toBe(mailboxServedDigest(["b", "a"]));
    expect(mailboxTopicsDigest(["a,b"])).not.toBe(mailboxTopicsDigest(["a", "b"]));
    expect(mailboxTopicsDigest(["a", "b"])).not.toBe(mailboxTopicsDigest(["b", "a"]));
  });

  test("canonical fact encoding refuses duplicate keys and alternate or extra fields", () => {
    const json = encodeMailboxFact(mailboxFactOf(start(), null));
    expect(Option.isSome(decodeMailboxFact(json))).toBe(true);
    expect(
      Option.isNone(decodeMailboxFact(json.replace('"position":0', '"position":1,"position":0')))
    ).toBe(true);
    expect(Option.isNone(decodeMailboxFact(json.replace(/}$/, ',"extra":true}')))).toBe(true);
    expect(Option.isNone(decodeMailboxFact(` ${json}`))).toBe(true);
  });

  test("the one mapping compares complete intent while keeping long identities out of receipts", () => {
    const input = ack();
    const previous = operation();
    const fact = mailboxFactOf(input, previous);
    expect(fact.kind).toBe("ack");
    expect(mailboxIntentMatches(input, fact)).toBe(true);
    for (const changed of [
      { ...input, address: `${address}/other` },
      { ...input, run: "other" },
      { ...input, from: 1 },
      { ...input, through: 1 },
      { ...input, subscription: { ...input.subscription, presenceId: "other" } },
      {
        ...input,
        subscription: { ...input.subscription, topicsDigest: mailboxTopicsDigest(["other"]) },
      },
      { ...input, carrierBytes: 43 },
    ])
      expect(mailboxIntentMatches(changed, fact)).toBe(false);
    const huge = {
      ...input,
      run: "r".repeat(100_000),
      subscription: { ...input.subscription, presenceId: "p".repeat(100_000) },
    };
    expect(
      Buffer.byteLength(encodeMailboxFact(mailboxFactOf(huge, previous)), "utf8")
    ).toBeLessThan(2048);
  });

  test("intrinsic position bounds, predecessor and checkpoint distinctions fail closed", () => {
    const initial = start();
    const initialFact = mailboxFactOf(initial, null);
    expect(validMailboxFactAt(initialFact, 1, "fixture")).toBe(true);
    expect(validMailboxFactAt({ ...initialFact, previous: initial.operation }, 1, "fixture")).toBe(
      false
    );
    const advance = ack();
    const fact = mailboxFactOf(advance, initial.operation);
    if (fact.kind !== "ack") throw new Error("not an acknowledgement");
    expect(validMailboxFactAt(fact, 3, "fixture")).toBe(true);
    expect(validMailboxFactAt({ ...fact, previous: null }, 3, "fixture")).toBe(false);
    expect(validMailboxFactAt({ ...fact, through: 3 }, 3, "fixture")).toBe(false);
    expect(validMailboxFactAt(fact, 2, "fixture")).toBe(false);
    expect(validMailboxFactAt(fact, 3, "other")).toBe(false);
    const checkpoint = {
      ...fact,
      mode: "checkpoint" as const,
      servedCount: 0,
      carrierBytes: 0,
      servedDigest: mailboxServedDigest([]),
    };
    expect(validMailboxFactAt(checkpoint, 3, "fixture")).toBe(true);
    expect(validMailboxFactAt({ ...checkpoint, mode: "read" }, 3, "fixture")).toBe(false);
  });
});
