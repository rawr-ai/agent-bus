import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  mailboxIri,
  mailboxReceiptIri,
  mailboxServedDigest,
  mailboxTopicsDigest,
  type RawMailboxRecord,
  resolveMailbox,
} from "../src/mailbox-model.ts";

const operation = () => Bun.randomUUIDv7();
const address = "claude/test";
const start = (
  position: number,
  t: number,
  id = operation(),
  origin = "join"
): RawMailboxRecord => ({
  predicate: "start",
  json: JSON.stringify({
    version: 1,
    kind: "start",
    operation: id,
    address,
    run: "run",
    origin,
    position,
  }),
  t,
});
const ack = (from: number, through: number, t: number, id = operation()): RawMailboxRecord => ({
  predicate: "ack",
  json: JSON.stringify({
    version: 1,
    kind: "ack",
    operation: id,
    address,
    mode: "read",
    run: "run",
    from,
    through,
    dataCut: { incarnation: "fixture", head: t - 1 },
    subscription: { presenceId: "legacy-presence", topicsDigest: mailboxTopicsDigest([]) },
    servedCount: 1,
    servedDigest: mailboxServedDigest(["message"]),
    carrierBytes: 42,
  }),
  t,
});
const resolve = (rows: ReadonlyArray<RawMailboxRecord>, head = 100) =>
  Effect.runPromise(resolveMailbox(rows, address, head, "fixture"));

describe("mailbox storage facts", () => {
  test("the mailbox is address keyed, including punctuation and leading question marks", () => {
    const keys = ["?one/two", "?one%2Ftwo", "\ud800", "\ud801", "\ufffd", "\u00e9", "e\u0301"];
    expect(new Set(keys.map(mailboxIri)).size).toBe(keys.length);
    expect(mailboxReceiptIri(operation())).not.toBe(mailboxIri("anything"));
  });

  test("an absent mailbox remains absent", async () => {
    expect(await resolve([])).toEqual({ status: "ABSENT" });
  });

  test("all facts are ordered by commit; replay is an explicit rewind", async () => {
    const begin = start(0, 1);
    const first = ack(0, 2, 3);
    const rewind = start(0, 4, operation(), "replay");
    const second = ack(0, 4, 5);
    const state = await resolve([second, first, rewind, begin], 5);
    expect(state.status).toBe("FOUND");
    if (state.status !== "FOUND") return;
    expect(state.position).toBe(4);
    expect(state.records.map((row) => row.t)).toEqual([1, 3, 4, 5]);
  });

  test("a skipped predecessor, non-advance or ack without a start is damage", async () => {
    await expect(resolve([start(0, 1), ack(1, 2, 3)])).rejects.toThrow("could not be established");
    await expect(resolve([start(0, 1), ack(0, 0, 3)])).rejects.toThrow("could not be established");
    await expect(resolve([ack(0, 1, 3)])).rejects.toThrow("could not be established");
  });

  test("a record cannot acknowledge its own or a future commit", async () => {
    await expect(resolve([start(2, 2)])).rejects.toThrow("could not be established");
    await expect(resolve([start(0, 1), ack(0, 3, 3)])).rejects.toThrow("could not be established");
    await expect(resolve([start(0, 1), ack(0, 2, 3)], 2)).rejects.toThrow(
      "could not be established"
    );
  });

  test("two facts at one commit or one reused operation cannot decide a position", async () => {
    const id = operation();
    await expect(resolve([start(0, 1), start(0, 1)])).rejects.toThrow("could not be established");
    await expect(resolve([start(0, 1, id), ack(0, 2, 3, id)])).rejects.toThrow(
      "could not be established"
    );
  });

  test("a malformed newer record fails, rather than selecting an older position", async () => {
    const invalid: RawMailboxRecord = { predicate: "ack", json: "{}", t: 4 };
    await expect(resolve([start(0, 1), ack(0, 2, 3), invalid])).rejects.toThrow("t=4");
  });

  test("unknown fields and a mismatched predicate are damage", async () => {
    const extra: RawMailboxRecord = {
      predicate: "start",
      json: JSON.stringify({
        version: 1,
        kind: "start",
        operation: operation(),
        address,
        run: "run",
        origin: "join",
        position: 0,
        extra: true,
      }),
      t: 1,
    };
    await expect(resolve([extra])).rejects.toThrow("could not be established");
    await expect(resolve([{ ...start(0, 1), predicate: "ack" }])).rejects.toThrow(
      "could not be established"
    );
  });

  test("a duplicate JSON key is damage even when the last value would decode", async () => {
    const valid = ack(0, 2, 3);
    const duplicate = {
      ...valid,
      json: valid.json.replace('"through":2', '"through":1,"through":2'),
    };
    await expect(resolve([start(0, 1), duplicate])).rejects.toThrow("could not be established");
  });

  test("an event for a different exact address is damage, never a merged mailbox", async () => {
    const misaddressed: RawMailboxRecord = {
      predicate: "start",
      json: JSON.stringify({
        version: 1,
        kind: "start",
        operation: operation(),
        address: "claude/other",
        run: "run",
        origin: "join",
        position: 0,
      }),
      t: 1,
    };
    await expect(resolve([misaddressed])).rejects.toThrow("could not be established");
  });

  test("an empty checkpoint is explicit, while an empty read is invalid", async () => {
    const checkpoint: RawMailboxRecord = {
      predicate: "ack",
      t: 3,
      json: JSON.stringify({
        version: 1,
        kind: "ack",
        operation: operation(),
        address,
        mode: "checkpoint",
        run: "run",
        from: 0,
        through: 2,
        dataCut: { incarnation: "fixture", head: 2 },
        subscription: { presenceId: "legacy-presence", topicsDigest: mailboxTopicsDigest([]) },
        servedCount: 0,
        servedDigest: mailboxServedDigest([]),
        carrierBytes: 0,
      }),
    };
    const state = await resolve([start(0, 1), checkpoint]);
    expect(state.status).toBe("FOUND");
    if (state.status === "FOUND") expect(state.position).toBe(2);
    const invalid = { ...checkpoint, json: checkpoint.json.replace('"checkpoint"', '"read"') };
    await expect(resolve([start(0, 1), invalid])).rejects.toThrow("could not be established");
  });

  test("the ordered-ID digest uses the exact order and UTF-8 JSON encoding", () => {
    expect(mailboxServedDigest([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    );
    expect(mailboxServedDigest(["a", "b"])).not.toBe(mailboxServedDigest(["b", "a"]));
    expect(mailboxTopicsDigest([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    );
    expect(mailboxTopicsDigest(["a", "b"])).not.toBe(mailboxTopicsDigest(["b", "a"]));
    expect(mailboxTopicsDigest(["a,b"])).not.toBe(mailboxTopicsDigest(["a", "b"]));
  });
});
