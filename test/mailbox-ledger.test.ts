import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { ownershipEra } from "../src/FlureePresence.ts";
import { Ledger, messageIri } from "../src/Ledger.ts";
import {
  encodeMailboxFact,
  type MailboxAck,
  type MailboxStart,
  type MailboxUnresolved,
  mailboxFactOf,
  mailboxIri,
  mailboxPresenceRef,
  mailboxReceiptIri,
  mailboxRunRef,
  mailboxServedDigest,
  mailboxTopicsDigest,
} from "../src/mailbox-model.ts";
import { readMailboxSlice } from "../src/mailbox-read.ts";
import type { Pin } from "../src/Query.ts";
import { boundary } from "./fluree-boundary.ts";
import { startFileFlureeServer } from "./fluree-file-server.ts";
import { flureeFetch, freshLedger, insertRaw } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const address = "claude/mailbox";
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});
type LedgerLayer = Layer.Layer<Ledger, unknown, never>;
const handle = async (layer: LedgerLayer) => {
  const runtime = ManagedRuntime.make(layer);
  cleanups.push(() => runtime.dispose());
  await runtime.runPromise(Effect.void);
  const use = <A>(f: (ledger: Ledger["Service"]) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(Effect.flatMap(Ledger, f));
  return {
    cut: () => use((ledger) => Effect.map(ledger.presenceAt(), (value) => value.cut)),
    era: (cut: Pin) => use((ledger) => ledger.ownershipEraAt(cut)),
    sourceCommitAt: (cut: Pin) => use((ledger) => ledger.sourceCommitAt(cut)),
    append: (message: Message) => use((ledger) => ledger.append(message)),
    admit: (message: Message, cut: Pin) => use((ledger) => ledger.admit(message, cut)),
    start: (message: Message, value: MailboxStart, cut: Pin) =>
      use((ledger) => ledger.admitWithStart(message, value, cut)),
    ack: (value: MailboxAck, cut: Pin) => use((ledger) => ledger.appendMailboxAck(value, cut)),
    mailbox: (value: string, cut: Pin) => use((ledger) => ledger.mailboxAt(value, cut)),
    receipt: (operation: string, cut: Pin, sender = address) =>
      use((ledger) => ledger.mailboxReceiptAt(sender, operation, cut)),
    read: (from: number) => use((ledger) => ledger.read(from)),
    readAt: (from: number, cut: Pin) => use((ledger) => ledger.readAt(from, cut)),
    candidates: (from: number, cut: Pin) => use((ledger) => ledger.mailboxCandidatesAt(from, cut)),
    checked: (from: number, cut: Pin) =>
      use((ledger) =>
        readMailboxSlice(ledger, from, cut, {
          address,
          presence: new Presence({
            runtime: "claude",
            status: "joined",
            topics: [],
            session: "tester",
          }),
          joinId: "fixture",
        })
      ),
    log: (to: number) => use((ledger) => ledger.log(to)),
    direct: (sender: string, after: number, to: number) =>
      use((ledger) => ledger.direct(sender, after, to)),
  };
};
const backends = [
  {
    name: "fluree",
    make: async () => {
      const config = await freshLedger("mailbox-storage");
      const layer = () => layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer;
      const one = await handle(layer());
      const two = await handle(layer());
      return {
        one,
        two,
        seed: (record: MailboxStart | MailboxUnresolved) =>
          insertRaw(config, {
            "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
            "@graph": [
              {
                "@id": mailboxIri(record.address),
                "bus:mailboxMarker": "v1",
                "bus:mailboxHead": mailboxReceiptIri(record.operation),
              },
              {
                "@id": mailboxReceiptIri(record.operation),
                "@type": `bus:Mailbox${record.kind === "start" ? "Start" : "Unresolved"}`,
                "bus:mailboxRecord": encodeMailboxFact(mailboxFactOf(record, null)),
              },
            ],
          }),
        damage: (value: string) =>
          insertRaw(config, {
            "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
            "@id": mailboxIri(value),
            "bus:mailboxHead": "corrupt-extra-head",
          }),
      };
    },
  },
  {
    name: "jsonl",
    make: async () => {
      const dir = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-"));
      const file = join(dir, "ledger.jsonl");
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const layer = () => layerJsonl(file).pipe(Layer.provide(platform)) as LedgerLayer;
      const one = await handle(layer());
      const two = await handle(layer());
      return {
        one,
        two,
        seed: (record: MailboxStart | MailboxUnresolved) =>
          appendFileSync(
            file,
            `${JSON.stringify({ "@mailboxStart": encodeMailboxFact(mailboxFactOf(record, null)), message: null })}\n`
          ),
        damage: () => appendFileSync(file, `${JSON.stringify({ "@mailboxAck": "{}" })}\n`),
      };
    },
  },
] as const;
const presence = (sender = address, session = "session-a") =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from: sender,
    to: ["*"],
    kind: "presence",
    body: "joined",
    presence: new Presence({ runtime: "claude", status: "joined", topics: [], session }),
  });
const message = (recipient = address) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from: "claude/sender",
    to: [recipient],
    kind: "message",
    body: "hello",
  });
const starting = (
  message: Message,
  basis: Pin,
  origin: MailboxStart["origin"] = "join"
): MailboxStart => ({
  version: 1,
  kind: "start",
  operation: message.id,
  address: message.from,
  run: message.id,
  origin,
  position: basis.head,
});
const unresolved = (
  sender = address,
  reason: MailboxUnresolved["reason"] = "missing"
): MailboxUnresolved => ({
  version: 1,
  kind: "unresolved",
  operation: Bun.randomUUIDv7(),
  address: sender,
  reason,
});
const acknowledgement = (
  run: string,
  from: number,
  through: number,
  dataCut: Pin,
  operation = Bun.randomUUIDv7()
): MailboxAck => ({
  version: 1,
  kind: "ack",
  operation,
  address,
  mode: "read",
  run,
  from,
  through,
  dataCut,
  subscription: { presenceId: run, topicsDigest: mailboxTopicsDigest([]) },
  servedCount: 1,
  servedDigest: mailboxServedDigest(["synthetic"]),
  carrierBytes: 42,
});

for (const backend of backends) {
  describe(`mailbox ledger (${backend.name})`, () => {
    test("start and presence commit together, with an exact operation receipt", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      const entry = presence();
      const value = starting(entry, basis);
      const result = await one.start(entry, value, basis);
      expect(result.status).toBe("ADMITTED");
      if (result.status !== "ADMITTED") return;
      const state = await two.mailbox(address, result.cut);
      expect(state.status).toBe("FOUND");
      if (state.status === "FOUND") expect(state.position).toBe(basis.head);
      expect((await two.receipt(entry.id, result.cut)).status).toBe("FOUND");
      expect((await two.read(basis.head)).entries.map((item) => item.message.id)).toEqual([
        entry.id,
      ]);
      expect(
        (await two.log(result.cut.head)).filter((item) => item.kind === "presence")
      ).toHaveLength(1);
    });

    test("a reused start ID with different presence intent cannot claim the first admission", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      const entry = presence();
      const start = starting(entry, basis);
      const first = await one.start(entry, start, basis);
      expect(first.status).toBe("ADMITTED");
      if (first.status !== "ADMITTED" || entry.presence === undefined) return;

      const variants = [
        new Message({
          ...entry,
          presence: new Presence({ ...entry.presence, topics: ["different"] }),
        }),
        new Message({ ...entry, presence: new Presence({ ...entry.presence, session: "other" }) }),
        new Message({
          ...entry,
          presence: new Presence({ ...entry.presence, installation: "other" }),
        }),
        new Message({ ...entry, presence: new Presence({ ...entry.presence, note: "other" }) }),
        new Message({
          ...entry,
          presence: new Presence({
            ...entry.presence,
            associations: [{ directory: "other", concerns: [] }],
          }),
        }),
        new Message({ ...entry, origin: new Origin({ host: "other" }) }),
      ];
      for (const different of variants) {
        expect((await two.start(different, start, basis)).status).toBe("REFUSED");
      }
      const final = await two.cut();
      expect(final).toEqual(first.cut);
      const stored = await two.read(basis.head);
      expect(stored.entries).toHaveLength(1);
      expect(stored.entries[0]?.message.presence?.topics).toEqual([]);
    });

    test("an exact start retry recovers its original cut after later commits", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      const entry = presence();
      const start = starting(entry, basis);
      const first = await one.start(entry, start, basis);
      if (first.status !== "ADMITTED") throw new Error("start was not admitted");
      await two.append(message("claude/neighbour"));
      const later = await two.cut();
      expect(await two.start(entry, start, basis)).toEqual(first);
      expect(await two.cut()).toEqual(later);
      const state = await two.mailbox(address, later);
      if (state.status !== "FOUND") throw new Error("missing start");
      expect(state.current.record.operation).toBe(entry.id);
      expect(state.current.record.previous).toBeNull();
      const stored = await two.read(basis.head);
      expect(stored.entries.filter((item) => item.message.id === entry.id)).toHaveLength(1);
    });

    test("a settled message or another mailbox fact cannot be claimed as a start", async () => {
      const { one, seed } = await backend.make();
      const basis = await one.cut();
      const original = message();
      await one.append(original);
      const different = new Message({ ...presence(), id: original.id });
      expect((await one.start(different, starting(different, basis), basis)).status).toBe(
        "REFUSED"
      );
      const afterMessage = await one.cut();
      expect((await one.mailbox(address, afterMessage)).status).toBe("ABSENT");

      const marker = unresolved();
      await seed(marker);
      const marked = await one.cut();
      const collided = new Message({ ...presence(), id: marker.operation });
      expect(
        (await one.start(collided, starting(collided, afterMessage), afterMessage)).status
      ).toBe("REFUSED");
      expect(await one.cut()).toEqual(marked);
    });

    test("receipt lookup cannot expose a different address's operation", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      const entry = presence();
      const first = await one.start(entry, starting(entry, basis), basis);
      if (first.status !== "ADMITTED") throw new Error("start was not admitted");
      const other = "claude/other";
      const wrong = await two.receipt(entry.id, first.cut, other);
      expect(wrong.status).toBe("ADDRESS_MISMATCH");
      expect(wrong).not.toHaveProperty("record");
      expect((await two.mailbox(other, await two.cut())).status).toBe("ABSENT");
      expect(await two.cut()).toEqual(first.cut);
    });

    test("unresolved imports remain visible and cannot be guessed as a start", async () => {
      const { one, two, seed } = await backend.make();
      const before = await one.cut();
      const marker = unresolved(address, "conflict");
      await seed(marker);
      const first = await one.cut();
      expect(await two.mailbox(address, before)).toEqual({ status: "ABSENT" });
      const unknown = await two.mailbox(address, first);
      expect(unknown.status).toBe("UNRESOLVED");
      if (unknown.status !== "UNRESOLVED") return;
      expect(unknown.reason).toBe("conflict");
      expect(unknown.current.record.operation).toBe(marker.operation);
      expect(unknown.current.record.previous).toBeNull();
      expect((await two.admit(presence(), first)).status).toBe("ADMITTED");
      const renewed = await two.cut();
      expect((await one.mailbox(address, renewed)).status).toBe("UNRESOLVED");
      const entry = presence();
      expect((await two.start(entry, starting(entry, renewed), renewed)).status).toBe("REFUSED");
      expect((await two.start(entry, starting(entry, renewed, "vacancy"), renewed)).status).toBe(
        "REFUSED"
      );
      expect(await one.cut()).toEqual(renewed);
      expect((await one.receipt(marker.operation, renewed)).status).toBe("FOUND");
      expect((await one.mailbox(address, first)).status).toBe("UNRESOLVED");
    });

    test("restart resolves an unresolved import only as an explicit atomic start", async () => {
      const { one, two, seed } = await backend.make();
      const unresolvedImport = unresolved();
      await seed(unresolvedImport);
      const marker = await one.cut();
      const entry = presence();
      const replay = { ...starting(entry, marker, "replay"), position: 0 };
      expect((await two.start(entry, replay, marker)).status).toBe("REFUSED");
      const restart = starting(entry, marker, "restart");
      const result = await two.start(entry, restart, marker);
      if (result.status !== "ADMITTED") throw new Error("restart was not admitted");
      const state = await one.mailbox(address, result.cut);
      if (state.status !== "FOUND") throw new Error("missing restart position");
      expect(state.position).toBe(marker.head);
      expect(state.current.record.operation).toBe(entry.id);
      expect(state.current.record.previous).toBe(unresolvedImport.operation);
    });

    test("a later presence alone fences a stale acknowledgement", async () => {
      const { one, two } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await one.append(message());
      const ackBasis = await one.cut();
      const ack = acknowledgement(owner.id, initial.head, ackBasis.head, ackBasis);
      const renewal = presence();
      expect((await two.admit(renewal, ackBasis)).status).toBe("ADMITTED");
      const afterRenewal = await one.cut();
      expect((await one.ack(ack, ackBasis)).status).toBe("CONFLICT");
      expect((await one.receipt(ack.operation, afterRenewal)).status).toBe("ABSENT");
      const position = await one.mailbox(address, afterRenewal);
      if (position.status !== "FOUND") throw new Error("missing original position");
      expect(position.position).toBe(initial.head);
    });

    test("a compact witness retains a 66 KB joined subscription by exact presence id", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      const original = presence();
      if (original.presence === undefined) throw new Error("missing presence");
      const topics = ["\u00e9".repeat(33_000), 'a"b\\c'];
      const joined = new Message({
        ...original,
        presence: new Presence({ ...original.presence, topics }),
      });
      const first = await one.start(joined, starting(joined, basis), basis);
      if (first.status !== "ADMITTED") throw new Error("large subscription was not joined");
      await one.append(message());
      const dataCut = await one.cut();
      const value: MailboxAck = {
        ...acknowledgement(joined.id, basis.head, dataCut.head, dataCut),
        subscription: { presenceId: joined.id, topicsDigest: mailboxTopicsDigest(topics) },
      };
      const acked = await two.ack(value, dataCut);
      if (acked.status !== "APPLIED") throw new Error("large subscription ack was refused");
      const saved = await two.receipt(value.operation, acked.cut);
      if (saved.status !== "FOUND" || saved.record.kind !== "ack") throw new Error("missing ack");
      expect(saved.record.subscription).toEqual({
        presenceRef: mailboxPresenceRef(joined.id),
        topicsDigest: mailboxTopicsDigest(topics),
      });
      expect(await two.ack(value, dataCut)).toEqual(acked);
      const historical = await one.readAt(basis.head, dataCut);
      const recovered = historical.entries.find((item) => item.message.id === joined.id);
      expect(recovered?.message.presence?.topics).toEqual(topics);
    });

    test("escaped addresses and long legacy identities fit compact receipts exactly", async () => {
      const { one, seed } = await backend.make();
      const key = "\u0001".repeat(11_000);
      const run = `legacy-${"\ud800".repeat(40_000)}`;
      const presenceId = `old-${'a\\"'.repeat(30_000)}`;
      const imported: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address: key,
        run,
        origin: "import",
        position: 0,
      };
      await seed(imported);
      await one.append(message("claude/neighbour"));
      const dataCut = await one.cut();
      const ack: MailboxAck = {
        ...acknowledgement(run, 0, dataCut.head, dataCut),
        address: key,
        subscription: { presenceId, topicsDigest: mailboxTopicsDigest(["topic"]) },
      };
      const applied = await one.ack(ack, dataCut);
      if (applied.status !== "APPLIED") throw new Error("long identity ack refused");
      const saved = await one.receipt(ack.operation, applied.cut, key);
      if (saved.status !== "FOUND" || saved.record.kind !== "ack")
        throw new Error("missing long identity ack");
      expect(saved.record.mailbox).toBe(mailboxIri(key));
      expect(saved.record.runRef).toBe(mailboxRunRef(run));
      expect(saved.record.subscription.presenceRef).toBe(mailboxPresenceRef(presenceId));
      expect(Buffer.byteLength(JSON.stringify(saved.record), "utf8")).toBeLessThan(2048);
      expect(await one.ack(ack, dataCut)).toEqual(applied);
    });

    test("a staggered stale ack cannot overwrite the later position, even if it extends farther", async () => {
      const { one, two } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await one.append(message());
      const earlier = await one.cut();
      await one.append(message());
      const basis = await one.cut();
      const a = acknowledgement(owner.id, initial.head, earlier.head, basis);
      const b = acknowledgement(owner.id, initial.head, basis.head, basis);
      expect((await one.ack(a, basis)).status).toBe("APPLIED");
      expect((await two.ack(b, basis)).status).toBe("CONFLICT");
      const final = await two.cut();
      const state = await two.mailbox(address, final);
      expect(state.status).toBe("FOUND");
      if (state.status === "FOUND") expect(state.position).toBe(earlier.head);
      expect((await two.receipt(b.operation, final)).status).toBe("ABSENT");
    });

    test("staggered individually valid lower, equal and higher acks all lose after one advance", async () => {
      const { one, two } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await one.append(message());
      const first = await one.cut();
      await one.append(message());
      const second = await one.cut();
      await one.append(message());
      const basis = await one.cut();
      const winner = acknowledgement(owner.id, initial.head, second.head, basis);
      expect((await one.ack(winner, basis)).status).toBe("APPLIED");
      const afterWinner = await one.cut();
      for (const through of [first.head, second.head, basis.head]) {
        const stale = acknowledgement(owner.id, initial.head, through, basis);
        expect((await two.ack(stale, basis)).status).toBe("CONFLICT");
        expect((await two.receipt(stale.operation, await two.cut())).status).toBe("ABSENT");
      }
      expect(await two.cut()).toEqual(afterWinner);
      const state = await two.mailbox(address, afterWinner);
      if (state.status !== "FOUND") throw new Error("missing winning position");
      expect(state.position).toBe(second.head);
      expect(state.current.record.operation).toBe(winner.operation);
      expect(state.current.record.previous).toBe(owner.id);
    });

    test("concurrent same-basis acknowledgements have one winner", async () => {
      const { one, two } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await one.append(message());
      const first = await one.cut();
      await one.append(message());
      const basis = await one.cut();
      const a = acknowledgement(owner.id, initial.head, first.head, basis);
      const b = acknowledgement(owner.id, initial.head, basis.head, basis);
      const outcomes = await Promise.all([one.ack(a, basis), two.ack(b, basis)]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["APPLIED", "CONFLICT"]);
      const cut = await one.cut();
      const receipts = await Promise.all([
        one.receipt(a.operation, cut),
        one.receipt(b.operation, cut),
      ]);
      expect(receipts.map((receipt) => receipt.status).sort()).toEqual(["ABSENT", "FOUND"]);
    });

    test("replay to the same numeric position fences an old-basis acknowledgement", async () => {
      const { one, two } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      const beginning = { ...starting(owner, initial), position: 0 };
      expect((await one.start(owner, beginning, initial)).status).toBe("ADMITTED");
      await one.append(message());
      const beforeAck = await one.cut();
      const stale = acknowledgement(owner.id, 0, beforeAck.head, beforeAck);
      const applied = acknowledgement(owner.id, 0, beforeAck.head, beforeAck);
      expect((await one.ack(applied, beforeAck)).status).toBe("APPLIED");
      const beforeReplay = await one.cut();
      const replay = presence();
      const rewind = { ...starting(replay, beforeReplay, "replay"), position: 0 };
      expect((await one.start(replay, rewind, beforeReplay)).status).toBe("ADMITTED");
      const replayCut = await one.cut();
      expect((await two.ack(stale, beforeAck)).status).toBe("CONFLICT");
      expect((await two.receipt(stale.operation, await two.cut())).status).toBe("ABSENT");
      const state = await two.mailbox(address, replayCut);
      if (state.status !== "FOUND") throw new Error("missing replay position");
      expect(state.position).toBe(0);
      expect(await two.cut()).toEqual(replayCut);
    });

    test("a later presence refuses the start without an orphan position", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      const stale = presence();
      await two.append(presence(address, "other"));
      expect((await one.start(stale, starting(stale, basis), basis)).status).toBe("REFUSED");
      const cut = await one.cut();
      expect((await one.mailbox(address, cut)).status).toBe("ABSENT");
      expect((await one.receipt(stale.id, cut)).status).toBe("ABSENT");
      expect((await one.read(basis.head)).entries.some((row) => row.message.id === stale.id)).toBe(
        false
      );
    });

    test("historic positions are pinned and invalid cuts never read the current head", async () => {
      const { one } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      const start = await one.start(owner, starting(owner, initial), initial);
      expect(start.status).toBe("ADMITTED");
      if (start.status !== "ADMITTED") return;
      expect((await one.mailbox(address, initial)).status).toBe("ABSENT");
      await one.append(message());
      const basis = await one.cut();
      const advanced = acknowledgement(owner.id, initial.head, basis.head, basis);
      expect((await one.ack(advanced, basis)).status).toBe("APPLIED");
      const old = await one.mailbox(address, start.cut);
      const current = await one.mailbox(address, await one.cut());
      if (old.status !== "FOUND" || current.status !== "FOUND") throw new Error("missing position");
      expect(old.position).toBe(initial.head);
      expect(current.position).toBe(basis.head);
      await expect(
        one.mailbox(address, { ...basis, head: Number.MAX_SAFE_INTEGER })
      ).rejects.toThrow();
      await expect(
        one.mailbox(address, { ...basis, incarnation: `${basis.incarnation}-wrong` })
      ).rejects.toThrow();
      await expect(
        one.ack(advanced, { ...basis, head: Number.MAX_SAFE_INTEGER })
      ).rejects.toThrow();
    });

    test("encoded entries are read at the supplied cut, not the later head", async () => {
      const { one } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      const joined = await one.start(owner, starting(owner, initial), initial);
      expect(joined.status).toBe("ADMITTED");
      if (joined.status !== "ADMITTED") return;
      const first = message();
      await one.append(first);
      const pin = await one.cut();
      await one.append(message());
      const slice = await one.readAt(joined.cut.head, pin);
      expect(slice.entries.map((entry) => entry.message.id)).toEqual([first.id]);
      expect(slice.next).toBe(pin.head);
      await expect(
        one.readAt(joined.cut.head, { ...pin, incarnation: `${pin.incarnation}-wrong` })
      ).rejects.toThrow();
      await expect(one.readAt(pin.head + 1, pin)).rejects.toThrow();
    });

    test("a no-start rejoin leaves the position facts unchanged", async () => {
      const { one } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await one.append(message());
      const basis = await one.cut();
      expect(
        (await one.ack(acknowledgement(owner.id, initial.head, basis.head, basis), basis)).status
      ).toBe("APPLIED");
      const before = await one.cut();
      const previous = await one.mailbox(address, before);
      if (previous.status !== "FOUND") throw new Error("missing previous position");
      const renewal = presence(address, "session-a");
      expect((await one.admit(renewal, before)).status).toBe("ADMITTED");
      const after = await one.mailbox(address, await one.cut());
      if (after.status !== "FOUND") throw new Error("missing inherited position");
      expect(after.position).toBe(basis.head);
      expect(after.current).toEqual(previous.current);
    });

    test("earlier message, presence and direct scans ignore mailbox records", async () => {
      const { one, seed } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      const mail = message();
      await one.append(mail);
      const basis = await one.cut();
      expect(
        (await one.ack(acknowledgement(owner.id, initial.head, basis.head, basis), basis)).status
      ).toBe("APPLIED");
      await seed(unresolved("claude/unresolved"));
      const cut = await one.cut();
      expect((await one.read(initial.head)).entries.map((entry) => entry.message.id)).toEqual([
        owner.id,
        mail.id,
      ]);
      expect((await one.log(cut.head)).filter((entry) => entry.kind === "presence")).toHaveLength(
        1
      );
      const direct = await one.direct(address, initial.head, cut.head);
      expect(direct.damaged).toBe(false);
      expect(direct.complete).toBe(true);
      expect(direct.found?.t).toBe(basis.head);
    });

    test("checkpoint and import are not fictional read receipts", async () => {
      const { one, seed } = await backend.make();
      const initial = await one.cut();
      const imported: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address,
        run: Bun.randomUUIDv7(),
        origin: "import",
        position: initial.head,
      };
      await seed(imported);
      await one.append(message());
      const basis = await one.cut();
      const checkpoint: MailboxAck = {
        ...acknowledgement(imported.run, initial.head, basis.head, basis),
        mode: "checkpoint",
        servedCount: 0,
        servedDigest: mailboxServedDigest([]),
        carrierBytes: 0,
      };
      expect((await one.ack(checkpoint, basis)).status).toBe("APPLIED");
      const receipt = await one.receipt(checkpoint.operation, await one.cut());
      expect(receipt.status).toBe("FOUND");
      if (receipt.status === "FOUND")
        expect(receipt.record.kind === "ack" && receipt.record.mode).toBe("checkpoint");
    });

    test("raw storage does not authenticate a run or prove the claimed served prefix", async () => {
      const { one } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await one.append(message());
      const basis = await one.cut();
      const untrusted = acknowledgement("not-the-owner-run", initial.head, basis.head, basis);
      expect((await one.ack(untrusted, basis)).status).toBe("APPLIED");
      // This is deliberately a counterexample, not a product authorization rule.
    });

    test("the same operation is idempotent and changed intent is refused", async () => {
      const { one } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await one.append(message());
      const basis = await one.cut();
      const value = acknowledgement(owner.id, initial.head, basis.head, basis);
      const first = await one.ack(value, basis);
      expect(first.status).toBe("APPLIED");
      if (first.status !== "APPLIED") return;
      await one.append(message("claude/neighbour"));
      const after = await one.cut();
      const replay = await one.ack(value, basis);
      expect(replay.status).toBe("APPLIED");
      if (replay.status === "APPLIED") expect(replay.cut).toEqual(first.cut);
      for (const changed of [
        { ...value, address: "claude/other" },
        { ...value, run: "other-run" },
        { ...value, from: value.from + 1 },
        { ...value, through: value.through + 1 },
        { ...value, subscription: { ...value.subscription, presenceId: "other-presence" } },
        {
          ...value,
          subscription: {
            ...value.subscription,
            topicsDigest: mailboxTopicsDigest(["other-topic"]),
          },
        },
        { ...value, servedDigest: mailboxServedDigest(["other"]) },
        { ...value, carrierBytes: 43 },
      ])
        expect((await one.ack(changed, basis)).status).toBe("IDENTITY_MISMATCH");
      expect(await one.cut()).toEqual(after);
    });

    test("a damaged newer fact fails the position read", async () => {
      const { one, damage } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      await damage(address);
      const damaged = await one.cut();
      await expect(one.mailbox(address, damaged)).rejects.toThrow();
      expect(await one.cut()).toEqual(damaged);
    });
  });
}

describe("mailbox Fluree boundaries", () => {
  test("the ownership era read rejects incorrect pins and an actual replacement under the same alias", async () => {
    const config = await freshLedger("ownership-era-replacement");
    const open = () => handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const store = await open();
    const cut = await store.cut();
    expect(await store.era(cut)).toBe(1);
    for (const invalid of [
      { ...cut, incarnation: "wrong" },
      { ...cut, head: cut.head + 1 },
      { ...cut, head: 0 },
    ]) {
      await expect(store.era(invalid)).rejects.toMatchObject({ _tag: "LedgerError" });
    }
    expect(await store.cut()).toEqual(cut);
    const drop = await flureeFetch("/v1/fluree/drop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ledger: config.ledger.replace(/:main$/, ""), hard: true }),
    });
    expect(drop.ok).toBe(true);
    const replacement = await open();
    const replaced = await replacement.cut();
    expect(replaced.incarnation).not.toBe(cut.incarnation);
    await expect(store.era(cut)).rejects.toMatchObject({ _tag: "LedgerError" });
    await expect(store.era(replaced)).rejects.toMatchObject({ _tag: "LedgerError" });
    expect(await replacement.era(replaced)).toBe(1);
    expect(await replacement.cut()).toEqual(replaced);
  });

  test("a transient competing ownership era invalidates later pins even when the original marker survives", async () => {
    const config = await freshLedger("ownership-era-history");
    const open = () => handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const store = await open();
    const first = await store.cut();
    expect(await store.era(first)).toBe(1);
    const context = {
      bus: "https://rawr.ai/ns/agent-bus#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    };
    const other = {
      ...ownershipEra,
      "bus:presenceEra": { "@value": "unrecognized", "@type": "xsd:string" },
    };
    await insertRaw(config, { "@context": context, ...other });
    const competing = await store.cut();
    await expect(store.era(competing)).rejects.toMatchObject({ _tag: "LedgerError" });
    const retracted = await flureeFetch(
      `/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "@context": context, where: other, delete: other }),
      }
    );
    expect(retracted.ok).toBe(true);
    const restored = await store.cut();
    for (const reader of [store, await open()]) {
      await expect(reader.era(restored)).rejects.toMatchObject({ _tag: "LedgerError" });
      expect(await reader.era(first)).toBe(1);
      expect(await reader.cut()).toEqual(restored);
    }
  });

  test("reasserting the ownership era cannot move the legacy boundary, including after reopening", async () => {
    const config = await freshLedger("changed-ownership-cut");
    const open = () => handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const store = await open();
    const original = await store.cut();
    expect(await store.era(original)).toBe(1);
    expect((await store.admit(presence(), original)).status).toBe("ADMITTED");
    const context = {
      bus: "https://rawr.ai/ns/agent-bus#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    };
    const retracted = await fetch(
      `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ "@context": context, where: ownershipEra, delete: ownershipEra }),
      }
    );
    expect(retracted.ok).toBe(true);
    const missing = await store.cut();
    for (const reader of [store, await open()]) {
      await expect(reader.era(missing)).rejects.toMatchObject({ _tag: "LedgerError" });
      expect(await reader.cut()).toEqual(missing);
    }
    await insertRaw(config, { "@context": context, ...ownershipEra });
    const damaged = await store.cut();
    for (const reader of [store, await open()]) {
      await expect(reader.era(damaged)).rejects.toMatchObject({ _tag: "LedgerError" });
      expect(await reader.era(original)).toBe(1);
      await expect(reader.admit(presence(), damaged)).rejects.toThrow("ownership fence");
      expect(await reader.cut()).toEqual(damaged);
    }
  });

  test("a damaged successor cannot settle the original join or authorize a new send", async () => {
    const config = await freshLedger("damaged-successor");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const entry = presence();
    const initial = await store.cut();
    const start = starting(entry, initial);
    const joined = await store.start(entry, start, initial);
    if (joined.status !== "ADMITTED") throw new Error("join refused");
    const ctx = { bus: "https://rawr.ai/ns/agent-bus#" };
    const response = await fetch(`${config.url}/v1/fluree/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        "@context": ctx,
        from: config.ledger,
        select: "?link",
        where: { "@id": `urn:agent-bus:message:${entry.id}`, "bus:presencePredecessor": "?link" },
      }),
    });
    if (!response.ok) throw new Error("successor lookup failed");
    const [link] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String]))(await response.json());
    await insertRaw(config, {
      "@context": ctx,
      "@id": link,
      "bus:presenceSuccessor": "another transition",
    });
    const damaged = await store.cut();
    expect((await store.start(entry, start, initial)).status).toBe("UNKNOWN");
    await expect(
      store.admit(new Message({ ...message(), from: address }), damaged)
    ).rejects.toThrow();
    expect(await store.cut()).toEqual(damaged);
  });

  test("the existing store proves a pinned native commit, not a matching height or genesis name", async () => {
    const config = await freshLedger("native-commit-pin");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const first = await store.cut();
    await store.append(message());
    const later = await store.cut();
    const relay = boundary(config.url);
    cleanups.push(relay.stop);
    const reader = await handle(
      layerFluree({ ...config, url: relay.url }, { existingOnly: true }).pipe(
        Layer.provide(platform)
      ) as LedgerLayer
    );
    const native = await flureeFetch(
      `/v1/fluree/show/${encodeURIComponent(config.ledger)}?commit=t:${later.head}`
    );
    expect(native.ok).toBe(true);
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      await native.json()
    );
    expect(await reader.sourceCommitAt(first)).toBe(first.incarnation);
    expect(await reader.sourceCommitAt(later)).toBe(id);
    expect(id).not.toBe(first.incarnation);
    for (const cut of [
      { ...later, incarnation: "different" },
      { ...later, head: 0 },
      { ...later, head: later.head + 1 },
    ]) {
      await expect(reader.sourceCommitAt(cut)).rejects.toMatchObject({ _tag: "LedgerError" });
    }
    for (const value of [
      { id, t: first.head },
      { t: later.head },
      { id: "not-a-cid", t: later.head },
    ]) {
      const answered = relay.nextPin(() => Response.json(value), later.head);
      await expect(reader.sourceCommitAt(later)).rejects.toMatchObject({ _tag: "LedgerError" });
      await answered;
    }
    expect(relay.creates()).toBe(0);
    expect(relay.updates()).toBe(0);
  });

  test("the retained ownership era fences earlier decisions and uses the last legacy presence", async () => {
    const config = await freshLedger("legacy-ownership-cut");
    const created = await flureeFetch("/v1/fluree/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ledger: config.ledger }),
    });
    expect(created.ok).toBe(true);
    const original = presence();
    await insertRaw(config, toNode(original, Schema.encodeSync(MessageJson)(original)));
    const store = await handle(
      layerFluree(config, { existingOnly: true }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const before = await store.cut();
    const newer = presence(address, "replaced");
    await insertRaw(config, toNode(newer, Schema.encodeSync(MessageJson)(newer)));
    const legacy = await store.cut();
    await expect(store.era(legacy)).rejects.toMatchObject({ _tag: "LedgerError" });
    await insertRaw(config, {
      "@context": {
        bus: "https://rawr.ai/ns/agent-bus#",
        xsd: "http://www.w3.org/2001/XMLSchema#",
      },
      ...ownershipEra,
    });
    const active = await store.cut();
    expect(active.head).toBe(legacy.head + 1);
    expect(await store.era(active)).toBe(active.head);
    await expect(store.era(legacy)).rejects.toMatchObject({ _tag: "LedgerError" });
    const send = () => new Message({ ...message(), from: address });
    await expect(store.admit(send(), before)).rejects.toThrow();
    await expect(store.admit(send(), legacy)).rejects.toThrow();
    const fresh = await store.admit(send(), active);
    if (fresh.status !== "ADMITTED") throw new Error("active legacy holder refused");
    expect(fresh.cut.head).toBe(active.head + 1);
    const renewal = presence(address, "replaced");
    const renewed = await store.admit(renewal, fresh.cut);
    if (renewed.status !== "ADMITTED") throw new Error("renewal refused");
    expect((await store.admit(send(), fresh.cut)).status).toBe("REFUSED");
    if (!renewal.presence) throw new Error("missing presence fixture");
    const leave = new Message({
      ...renewal,
      id: Bun.randomUUIDv7(),
      presence: new Presence({ ...renewal.presence, status: "left" }),
    });
    const left = await store.admit(leave, renewed.cut);
    if (left.status !== "ADMITTED") throw new Error("leave refused");
    expect((await store.admit(send(), renewed.cut)).status).toBe("REFUSED");
    expect(await store.era(left.cut)).toBe(active.head);
  });

  test("the active sender makes progress while its history is being indexed", async () => {
    const server = await startFileFlureeServer();
    cleanups.push(server.stop);
    const config = server.freshLedger("indexed-mailbox-sender");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    for (const sender of ["codex/reader", address]) {
      const join = presence(sender);
      const basis = await store.cut();
      expect((await store.start(join, starting(join, basis), basis)).status).toBe("ADMITTED");
    }
    for (let i = 0; i < 60; i++) {
      const posted = new Message({ ...message(), from: address });
      const basis = await store.cut();
      expect((await store.admit(posted, basis)).status).toBe("ADMITTED");
    }
  }, 30_000);

  test("an indexed takeover fences stale acknowledgements and replay without blocking a fresh read", async () => {
    const server = await startFileFlureeServer();
    cleanups.push(server.stop);
    const config = server.freshLedger("indexed-mailbox-takeover");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const original = presence();
    const initial = await store.cut();
    const first = await store.start(original, starting(original, initial), initial);
    if (first.status !== "ADMITTED") throw new Error("original join did not apply");
    await store.append(message());
    const oldBasis = await store.cut();
    const gate = Promise.withResolvers<void>();
    const arrived = Promise.withResolvers<void>();
    let waiting = 0;
    const relay = boundary(config.url, {
      beforeUpdate: () => {
        if (++waiting === 3) arrived.resolve();
        return gate.promise;
      },
    });
    cleanups.push(() => relay.stop());
    const slow = await handle(
      layerFluree({ ...config, url: relay.url }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const staleSend = new Message({ ...message(), from: address });
    const stale = acknowledgement(original.id, initial.head, oldBasis.head, oldBasis);
    const replay = presence();
    const pending = Promise.all([
      slow.admit(staleSend, oldBasis),
      slow.ack(stale, oldBasis),
      slow.start(replay, { ...starting(replay, oldBasis, "replay"), position: 0 }, oldBasis),
    ]);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const current = await (async () => {
      try {
        await Promise.race([
          arrived.promise,
          pending.then(() => {
            throw new Error("stale operations did not reach Fluree");
          }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("outgoing updates not held")), 4000);
          }),
        ]);
        const successor = presence(address, "new-owner");
        if (!successor.presence) throw new Error("missing fixture presence");
        const transfer = new Message({
          ...successor,
          presence: new Presence({ ...successor.presence, takeover: original.id }),
        });
        const taken = await store.admit(transfer, oldBasis);
        if (taken.status !== "ADMITTED") throw new Error("takeover did not apply");
        for (let i = 0; i < 96; i++) await store.append(message("claude/other"));
        const current = await store.cut();
        const index = Schema.decodeUnknownSync(
          Schema.Struct({ ledger: Schema.Struct({ "index-t": Schema.Int }) })
        );
        let indexed = 0;
        for (let i = 0; i < 100 && indexed < taken.cut.head; i++) {
          const info = await fetch(
            `${config.url}/v1/fluree/info/${encodeURIComponent(config.ledger)}`,
            {
              headers: { authorization: `Bearer ${config.token}` },
            }
          );
          if (!info.ok) throw new Error(`index status unavailable: HTTP ${info.status}`);
          indexed = index(await info.json()).ledger["index-t"];
          if (indexed < taken.cut.head) await Bun.sleep(100);
        }
        expect(indexed).toBeGreaterThanOrEqual(taken.cut.head);
        return { cut: current, holding: transfer.id };
      } finally {
        clearTimeout(deadline);
        gate.resolve();
        await pending;
      }
    })();
    expect((await pending).map((result) => result.status)).toEqual([
      "REFUSED",
      "CONFLICT",
      "REFUSED",
    ]);
    expect(waiting).toBe(3);
    expect(await store.cut()).toEqual(current.cut);
    expect((await store.receipt(stale.operation, current.cut)).status).toBe("ABSENT");
    expect((await store.receipt(replay.id, current.cut)).status).toBe("ABSENT");
    const fresh = acknowledgement(current.holding, initial.head, oldBasis.head, current.cut);
    const advanced = await store.ack(fresh, current.cut);
    if (advanced.status !== "APPLIED") throw new Error(`fresh acknowledgement: ${advanced.status}`);
    expect(await store.mailbox(address, advanced.cut)).toMatchObject({
      status: "FOUND",
      position: oldBasis.head,
      current: { record: { operation: fresh.operation } },
    });
    const freshSend = new Message({ ...message(), from: address });
    const send = await store.admit(freshSend, advanced.cut);
    if (send.status !== "ADMITTED") throw new Error("current sender refused");
    expect(
      (await store.readAt(current.cut.head, send.cut)).entries.map(({ message }) => message.id)
    ).toEqual([freshSend.id]);
  }, 30_000);

  test("position and historical receipt use a fixed number of pinned result queries", async () => {
    const config = await freshLedger("mailbox-pointer-reads");
    const relay = boundary(config.url);
    cleanups.push(() => relay.stop());
    const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const observed = await handle(
      layerFluree({ ...config, url: relay.url }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const start: MailboxStart = {
      version: 1,
      kind: "start",
      operation: Bun.randomUUIDv7(),
      address,
      run: "long-run",
      origin: "import",
      position: 0,
    };
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        {
          "@id": mailboxIri(address),
          "bus:mailboxMarker": "v1",
          "bus:mailboxHead": mailboxReceiptIri(start.operation),
        },
        {
          "@id": mailboxReceiptIri(start.operation),
          "@type": "bus:MailboxStart",
          "bus:mailboxRecord": encodeMailboxFact(mailboxFactOf(start, null)),
        },
      ],
    });
    const positions: number[] = [];
    for (let i = 0; i < 96; i++) {
      await direct.append(message());
      positions.push((await direct.cut()).head);
    }
    const dataCut = await direct.cut();
    let from = 0;
    let shortCut: Pin | undefined;
    let firstOperation = "";
    for (let i = 0; i < positions.length; i++) {
      const through = positions[i];
      if (through === undefined) throw new Error("missing workload position");
      const basis = await direct.cut();
      const ack = acknowledgement(start.run, from, through, dataCut);
      if (i === 0) firstOperation = ack.operation;
      const result = await direct.ack(ack, basis);
      if (result.status !== "APPLIED") throw new Error(`acknowledgement ${i} did not apply`);
      if (i === 15) shortCut = result.cut;
      from = through;
    }
    if (shortCut === undefined) throw new Error("missing short cut");
    const longCut = await direct.cut();
    const beforeShort = relay.queries();
    expect((await observed.mailbox(address, shortCut)).status).toBe("FOUND");
    const shortQueries = relay.queries() - beforeShort;
    const beforeLong = relay.queries();
    expect((await observed.mailbox(address, longCut)).status).toBe("FOUND");
    const longQueries = relay.queries() - beforeLong;
    expect(shortQueries).toBe(3);
    expect(longQueries).toBe(shortQueries);
    const beforeReceipt = relay.queries();
    expect((await observed.receipt(firstOperation, longCut)).status).toBe("FOUND");
    expect(relay.queries() - beforeReceipt).toBe(5);
    // Includes the subject's type history. Request count is not a measurement of engine work.
  }, 30_000);

  for (const readback of ["available", "unavailable"] as const) {
    test(`lost join confirmation with a bounded ${readback} readback`, async () => {
      const config = await freshLedger("known-presence");
      let responseBytes = 8192;
      const relay = boundary(config.url, { queryResponseBytes: () => responseBytes });
      cleanups.push(() => relay.stop());
      const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
      const observed = await handle(
        layerFluree({ ...config, url: relay.url }).pipe(Layer.provide(platform)) as LedgerLayer
      );
      const basis = await direct.cut();
      const original = presence();
      if (original.presence === undefined) throw new Error("missing presence");
      const topics = ["release", "x".repeat(12_000)];
      const entry = new Message({
        ...original,
        presence: new Presence({ ...original.presence, topics }),
      });
      const start = starting(entry, basis);
      const initialUpdates = relay.updates();
      const forwarded = relay.loseNextUpdate().then((reply) => {
        if (readback === "unavailable") responseBytes = 0;
        return reply;
      });
      const initial = await observed.start(entry, start, basis);
      expect(initial.status).toBe(readback === "available" ? "ADMITTED" : "UNKNOWN");
      expect(await forwarded).toEqual({ status: 200 });
      responseBytes = 8192;
      const committed = await direct.cut();
      expect((await direct.receipt(entry.id, committed)).status).toBe("FOUND");
      const next = presence(address, "replacement-session");
      expect((await direct.admit(next, committed)).status).toBe("ADMITTED");
      const mail = message();
      await direct.append(mail);
      const after = await direct.cut();
      expect(await observed.start(entry, start, basis)).toEqual({
        status: "ADMITTED",
        cut: committed,
      });
      const changed = new Message({
        ...entry,
        presence: new Presence({ ...original.presence, topics: [...topics].reverse() }),
      });
      // The mismatching full carrier cannot cross this relay to establish a definitive collision.
      expect((await observed.start(changed, start, basis)).status).toBe("UNKNOWN");
      expect((await direct.start(changed, start, basis)).status).toBe("REFUSED");
      expect(relay.updates() - initialUpdates).toBe(1);
      expect(await direct.cut()).toEqual(after);
      const entries = (await direct.readAt(basis.head, after)).entries;
      expect(
        entries.find(({ message }) => message.id === entry.id)?.message.presence?.topics
      ).toEqual(topics);
      expect(entries.map(({ message }) => message.id)).toEqual([entry.id, next.id, mail.id]);
    });
  }

  test("a presence with a language-tagged projected sender cannot settle an admission", async () => {
    const config = await freshLedger("presence-sender-kind");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const basis = await store.cut();
    const entry = presence();
    await insertRaw(config, {
      ...toNode(entry, Schema.encodeSync(MessageJson)(entry)),
      "bus:from": { "@value": entry.from, "@language": "en" },
    });
    const result = await store.admit(entry, basis);
    expect(result.status).toBe("UNKNOWN");

    const controlConfig = await freshLedger("presence-sender-control");
    const control = await handle(
      layerFluree(controlConfig).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const controlBasis = await control.cut();
    const valid = presence();
    expect((await control.admit(valid, controlBasis)).status).toBe("ADMITTED");
    const unlinked = presence();
    const held = await control.cut();
    await insertRaw(controlConfig, toNode(unlinked, Schema.encodeSync(MessageJson)(unlinked)));
    expect((await control.admit(unlinked, held)).status).toBe("UNKNOWN");
    const damaged = await control.cut();
    await expect(
      control.admit(new Message({ ...message(), from: address }), damaged)
    ).rejects.toThrow();
  });

  test("an IRI projected sender cannot settle a literal presence admission", async () => {
    const config = await freshLedger("presence-sender-iri");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const basis = await store.cut();
    const entry = presence("urn:agent-bus:synthetic-owner");
    await insertRaw(config, {
      ...toNode(entry, Schema.encodeSync(MessageJson)(entry)),
      "bus:from": { "@id": entry.from },
    });
    expect((await store.admit(entry, basis)).status).toBe("UNKNOWN");
  });

  test("a no-start presence admission never claims a concurrent different presence", async () => {
    const config = await freshLedger("presence-attribution");
    let release = () => {};
    let arrived = () => {};
    const seen = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const path = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.delete("host");
        const body = request.method === "GET" ? undefined : await request.arrayBuffer();
        if (armed && path.pathname === "/v1/fluree/update") {
          armed = false;
          arrived();
          await gate;
        }
        return fetch(`${config.url}${path.pathname}${path.search}`, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        });
      },
    });
    cleanups.push(() => proxy.stop(true));
    const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const slow = await handle(
      layerFluree({ ...config, url: proxy.url.origin }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const basis = await direct.cut();
    const entry = presence();
    if (entry.presence === undefined) throw new Error("missing presence");
    const different = new Message({
      ...entry,
      presence: new Presence({ ...entry.presence, topics: ["different"] }),
    });
    armed = true;
    const pending = slow.admit(different, basis);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        seen,
        pending.then(() => {
          throw new Error("the delayed update did not reach the relay");
        }),
        new Promise<void>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("delayed update timed out")), 3000);
        }),
      ]);
      expect((await direct.admit(entry, basis)).status).toBe("ADMITTED");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      release();
    }
    expect((await pending).status).toBe("REFUSED");
    const stored = await direct.read(basis.head);
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]?.message.presence?.topics).toEqual([]);
  });

  test("a delayed start cannot claim another presence with the same operation and different intent", async () => {
    const config = await freshLedger("mailbox-start-intent");
    let release = () => {};
    let arrived = () => {};
    const seen = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const path = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.delete("host");
        const body = request.method === "GET" ? undefined : await request.arrayBuffer();
        if (armed && path.pathname === "/v1/fluree/update") {
          armed = false;
          arrived();
          await gate;
        }
        return fetch(`${config.url}${path.pathname}${path.search}`, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        });
      },
    });
    cleanups.push(() => proxy.stop(true));
    const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const slow = await handle(
      layerFluree({ ...config, url: proxy.url.origin }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const basis = await direct.cut();
    const entry = presence();
    const start = starting(entry, basis);
    if (entry.presence === undefined) throw new Error("missing presence");
    const different = new Message({
      ...entry,
      presence: new Presence({ ...entry.presence, topics: ["different"] }),
    });
    armed = true;
    const pending = slow.start(different, start, basis);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        seen,
        pending.then(() => {
          throw new Error("the delayed update did not reach the relay");
        }),
        new Promise<void>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("delayed update timed out")), 3000);
        }),
      ]);
      expect((await direct.start(entry, start, basis)).status).toBe("ADMITTED");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      release();
    }
    expect((await pending).status).toBe("REFUSED");
    const final = await direct.cut();
    const state = await direct.mailbox(address, final);
    if (state.status !== "FOUND") throw new Error("missing starting position");
    expect(state.current.record.operation).toBe(entry.id);
    const stored = await direct.read(basis.head);
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]?.message.presence?.topics).toEqual([]);
  });

  test("a position committed after preflight fences a delayed update inside the provider", async () => {
    const config = await freshLedger("mailbox-delayed");
    let release = () => {};
    let arrived = () => {};
    const seen = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const path = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.delete("host");
        const body = request.method === "GET" ? undefined : await request.arrayBuffer();
        if (armed && path.pathname === "/v1/fluree/update") {
          armed = false;
          arrived();
          await gate;
        }
        return fetch(`${config.url}${path.pathname}${path.search}`, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        });
      },
    });
    cleanups.push(() => proxy.stop(true));
    const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const slow = await handle(
      layerFluree({ ...config, url: proxy.url.origin }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const initial = await direct.cut();
    const owner = presence();
    expect((await direct.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
    await direct.append(message());
    const first = await direct.cut();
    await direct.append(message());
    const basis = await direct.cut();
    const stale = acknowledgement(owner.id, initial.head, basis.head, basis);
    const winning = acknowledgement(owner.id, initial.head, first.head, basis);
    armed = true;
    const pending = slow.ack(stale, basis);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        seen,
        pending.then(() => {
          throw new Error("the delayed update did not reach the relay");
        }),
        new Promise<void>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("delayed update timed out")), 3000);
        }),
      ]);
      expect((await direct.ack(winning, basis)).status).toBe("APPLIED");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      release();
    }
    expect((await pending).status).toBe("CONFLICT");
    const cut = await direct.cut();
    expect((await direct.receipt(stale.operation, cut)).status).toBe("ABSENT");
    const state = await direct.mailbox(address, cut);
    if (state.status !== "FOUND") throw new Error("missing winning position");
    expect(state.position).toBe(first.head);
    expect(state.current.record.operation).toBe(winning.operation);
    expect(state.current.record.previous).toBe(owner.id);
  });

  for (const target of [
    "marker",
    "head",
    "marker-extra",
    "head-extra",
    "marker-extra-same",
    "head-extra-same",
  ] as const) {
    test(`a ${target} changed after preflight cannot pass the observed-state fence`, async () => {
      const config = await freshLedger(`mailbox-${target}-reassert`);
      let release = () => {};
      let arrived = () => {};
      const seen = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let armed = false;
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          const path = new URL(request.url);
          const headers = new Headers(request.headers);
          headers.delete("host");
          const body = request.method === "GET" ? undefined : await request.arrayBuffer();
          if (armed && path.pathname === "/v1/fluree/update") {
            armed = false;
            arrived();
            await gate;
          }
          return fetch(`${config.url}${path.pathname}${path.search}`, {
            method: request.method,
            headers,
            body,
            signal: request.signal,
          });
        },
      });
      cleanups.push(() => proxy.stop(true));
      const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
      const slow = await handle(
        layerFluree({ ...config, url: proxy.url.origin }).pipe(
          Layer.provide(platform)
        ) as LedgerLayer
      );
      const initial = await direct.cut();
      const owner = presence();
      expect((await direct.start(owner, starting(owner, initial), initial)).status).toBe(
        "ADMITTED"
      );
      await direct.append(message());
      const firstData = await direct.cut();
      const positive = acknowledgement(owner.id, initial.head, firstData.head, firstData);
      expect((await direct.ack(positive, firstData)).status).toBe("APPLIED");
      await direct.append(message());
      const basis = await direct.cut();
      const stale = acknowledgement(owner.id, firstData.head, basis.head, basis);
      armed = true;
      const pending = slow.ack(stale, basis);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          seen,
          pending.then(() => {
            throw new Error("the delayed update did not reach the relay");
          }),
          new Promise<void>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("delayed update timed out")), 3000);
          }),
        ]);
        const property = target.startsWith("marker") ? "bus:mailboxMarker" : "bus:mailboxHead";
        if (target === "marker" || target === "head") {
          const deleted = await fetch(
            `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${config.token}`,
              },
              body: JSON.stringify({
                "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
                where: { "@id": mailboxIri(address), [property]: "?value" },
                delete: { "@id": mailboxIri(address), [property]: "?value" },
              }),
            }
          );
          expect(deleted.status).toBe(200);
          await deleted.arrayBuffer();
        }
        const value =
          target === "marker"
            ? "v1"
            : target === "head"
              ? mailboxReceiptIri(positive.operation)
              : target === "marker-extra"
                ? "other-version"
                : target === "marker-extra-same"
                  ? { "@value": "v1", "@language": "en" }
                  : target === "head-extra-same"
                    ? { "@id": mailboxReceiptIri(positive.operation) }
                    : { "@id": "urn:invalid:extra-head" };
        await insertRaw(config, {
          "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
          "@id": mailboxIri(address),
          [property]: value,
        });
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        release();
      }
      expect((await pending).status).not.toBe("APPLIED");
      const current = await direct.cut();
      await expect(direct.mailbox(address, current)).rejects.toThrow();
      const response = await fetch(
        `${config.url}/v1/fluree/query/${encodeURIComponent(`${config.ledger}@t:${current.head}`)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
          body: JSON.stringify({
            select: "?predicate",
            values: [
              ["?receipt"],
              [[{ "@value": mailboxReceiptIri(stale.operation), "@type": "@id" }]],
            ],
            where: { "@id": "?receipt", "?predicate": "?object" },
          }),
        }
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });
  }

  test("a lost successful update is recovered from its immutable receipt", async () => {
    const config = await freshLedger("mailbox-unknown");
    const relay = boundary(config.url);
    cleanups.push(() => relay.stop());
    const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const unreliable = await handle(
      layerFluree({ ...config, url: relay.url }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const initial = await direct.cut();
    const owner = presence();
    expect((await direct.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
    await direct.append(message());
    const basis = await direct.cut();
    const value = acknowledgement(owner.id, initial.head, basis.head, basis);
    const forwarded = relay.loseNextUpdate();
    const settled = await unreliable.ack(value, basis);
    expect(settled.status).toBe("APPLIED");
    expect(await forwarded).toEqual({ status: 200 });
    const committed = await direct.cut();
    expect((await direct.receipt(value.operation, committed)).status).toBe("FOUND");
    expect(await unreliable.ack(value, basis)).toEqual(settled);
    expect(await direct.cut()).toEqual(committed);
  });

  test("lost successful join-start responses recover their original commits", async () => {
    const config = await freshLedger("mailbox-lost-start");
    const relay = boundary(config.url);
    cleanups.push(() => relay.stop());
    const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const unreliable = await handle(
      layerFluree({ ...config, url: relay.url }).pipe(Layer.provide(platform)) as LedgerLayer
    );
    const basis = await direct.cut();
    const entry = presence();
    const start = starting(entry, basis);
    const forwarded = relay.loseNextUpdate();
    const joined = await unreliable.start(entry, start, basis);
    expect(joined.status).toBe("ADMITTED");
    expect(await forwarded).toEqual({ status: 200 });
    if (joined.status !== "ADMITTED") return;
    expect((await direct.receipt(entry.id, joined.cut)).status).toBe("FOUND");
    await direct.append(message("claude/neighbour"));
    const afterJoin = await direct.cut();
    expect(await unreliable.start(entry, start, basis)).toEqual(joined);
    expect(await direct.cut()).toEqual(afterJoin);
  });

  for (const mode of ["ack", "start"] as const) {
    test(`an unanswered in-flight ${mode} stays unknown when its witness is not yet visible`, async () => {
      const config = await freshLedger(`mailbox-in-flight-${mode}`);
      let release = () => {};
      let arrived = () => {};
      const seen = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let armed = false;
      let forwarded: Promise<Response> | undefined;
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          const path = new URL(request.url);
          const headers = new Headers(request.headers);
          headers.delete("host");
          const body = request.method === "GET" ? undefined : await request.arrayBuffer();
          const forward = () =>
            fetch(`${config.url}${path.pathname}${path.search}`, {
              method: request.method,
              headers,
              body,
              signal: AbortSignal.timeout(3000),
            });
          if (armed && path.pathname === "/v1/fluree/update") {
            armed = false;
            forwarded = gate.then(forward);
            arrived();
            return new Response(null, { status: 504 });
          }
          return forward();
        },
      });
      cleanups.push(() => proxy.stop(true));
      const direct = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
      const unreliable = await handle(
        layerFluree({ ...config, url: proxy.url.origin }).pipe(
          Layer.provide(platform)
        ) as LedgerLayer
      );
      const initial = await direct.cut();
      const owner = presence();
      if (mode === "ack") {
        expect((await direct.start(owner, starting(owner, initial), initial)).status).toBe(
          "ADMITTED"
        );
        await direct.append(message());
      }
      const basis = await direct.cut();
      const ack = acknowledgement(owner.id, initial.head, basis.head, basis);
      const start = starting(owner, basis);
      const operation = mode === "ack" ? ack.operation : owner.id;
      armed = true;
      const pending =
        mode === "ack" ? unreliable.ack(ack, basis) : unreliable.start(owner, start, basis);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let status = 0;
      try {
        await Promise.race([
          seen,
          pending.then(() => {
            throw new Error("the update did not reach the relay");
          }),
          new Promise<void>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("in-flight update timed out")), 3000);
          }),
        ]);
        const attempt = await pending;
        expect(attempt.status).toBe("UNKNOWN");
        expect((await direct.receipt(operation, await direct.cut())).status).toBe("ABSENT");
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        release();
        if (forwarded === undefined) proxy.stop(true);
        else {
          const response = await forwarded;
          status = response.status;
          await response.arrayBuffer();
        }
      }
      expect(status).toBe(200);
      const committed = await direct.cut();
      expect((await direct.receipt(operation, committed)).status).toBe("FOUND");
      const retry =
        mode === "ack"
          ? await unreliable.ack(ack, basis)
          : await unreliable.start(owner, start, basis);
      expect(retry.status).toBe(mode === "ack" ? "APPLIED" : "ADMITTED");
      if (mode === "start") {
        const state = await direct.mailbox(address, committed);
        if (state.status !== "FOUND") throw new Error("missing in-flight start");
        expect(state.current.record.operation).toBe(owner.id);
        const entries = await direct.read(basis.head);
        expect(entries.entries.filter((item) => item.message.id === owner.id)).toHaveLength(1);
      }
      expect(await direct.cut()).toEqual(committed);
    });
  }

  test("a malformed current reference and a dangling receipt each fail closed", async () => {
    const config = await freshLedger("mailbox-damage");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const initial = await store.cut();
    const owner = presence();
    expect((await store.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
    await store.append(message());
    const basis = await store.cut();
    const value = acknowledgement(owner.id, initial.head, basis.head, basis);
    const context = { bus: "https://rawr.ai/ns/agent-bus#" };
    await insertRaw(config, {
      "@context": context,
      "@id": mailboxIri(address),
      "bus:mailboxHead": "corrupt-extra-head",
    });
    const damaged = await store.cut();
    await expect(store.mailbox(address, damaged)).rejects.toThrow();
    expect((await store.receipt(value.operation, damaged)).status).toBe("UNAVAILABLE");

    const orphanAddress = "claude/orphan";
    const orphan: MailboxStart = {
      version: 1,
      kind: "start",
      operation: Bun.randomUUIDv7(),
      address: orphanAddress,
      run: Bun.randomUUIDv7(),
      origin: "import",
      position: 0,
    };
    await insertRaw(config, {
      "@context": context,
      "@id": mailboxReceiptIri(orphan.operation),
      "@type": "bus:MailboxStart",
      "bus:mailboxRecord": encodeMailboxFact(mailboxFactOf(orphan, null)),
    });
    expect((await store.receipt(orphan.operation, await store.cut(), orphanAddress)).status).toBe(
      "MALFORMED"
    );
    const wrong = await store.receipt(orphan.operation, await store.cut(), "claude/other");
    expect(wrong.status).not.toBe("FOUND");
    expect(wrong).not.toHaveProperty("record");
  });

  test("partial colliding message and receipt nodes leave a start outcome unknown", async () => {
    const config = await freshLedger("mailbox-partial-collisions");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const firstBasis = await store.cut();
    const first = presence("claude/partial-message");
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@id": `urn:agent-bus:message:${first.id}`,
      "bus:id": first.id,
    });
    const afterFirst = await store.cut();
    expect((await store.start(first, starting(first, firstBasis), firstBasis)).status).toBe(
      "UNKNOWN"
    );
    expect(await store.cut()).toEqual(afterFirst);
    expect((await store.mailbox(first.from, afterFirst)).status).toBe("ABSENT");

    const secondBasis = await store.cut();
    const second = presence("claude/partial-receipt");
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@id": mailboxReceiptIri(second.id),
      "@type": "bus:MailboxStart",
      "bus:mailboxRecord": "{}",
    });
    const afterSecond = await store.cut();
    expect((await store.start(second, starting(second, secondBasis), secondBasis)).status).toBe(
      "UNKNOWN"
    );
    expect(await store.cut()).toEqual(afterSecond);
    expect((await store.mailbox(second.from, afterSecond)).status).toBe("ABSENT");
  });

  test("retracting a previously asserted position is damage at the later cut", async () => {
    const config = await freshLedger("mailbox-retraction");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const initial = await store.cut();
    const owner = presence();
    const admitted = await store.start(owner, starting(owner, initial), initial);
    expect(admitted.status).toBe("ADMITTED");
    if (admitted.status !== "ADMITTED") return;
    const subject = mailboxIri(address);
    const response = await fetch(
      `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
          where: { "@id": subject, "bus:mailboxHead": "?value" },
          delete: { "@id": subject, "bus:mailboxHead": "?value" },
        }),
      }
    );
    expect(response.status).toBe(200);
    expect((await store.mailbox(address, admitted.cut)).status).toBe("FOUND");
    await expect(store.mailbox(address, await store.cut())).rejects.toThrow();
  });

  test("an initial marker and first reference asserted in different commits are damage", async () => {
    const config = await freshLedger("mailbox-split-initialization");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const basis = await store.cut();
    const entry = presence();
    const start = starting(entry, basis);
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@id": mailboxIri(address),
      "bus:mailboxMarker": "v1",
    });
    const receipt = mailboxReceiptIri(entry.id);
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        { "@id": mailboxIri(address), "bus:mailboxHead": receipt },
        {
          "@id": receipt,
          "@type": "bus:MailboxStart",
          "bus:mailboxRecord": encodeMailboxFact(mailboxFactOf(start, null)),
        },
      ],
    });
    const cut = await store.cut();
    await expect(store.mailbox(address, cut)).rejects.toThrow();
    expect((await store.receipt(entry.id, cut)).status).not.toBe("FOUND");
  });

  test("retracting an unresolved import is damage, not a fresh mailbox", async () => {
    const config = await freshLedger("unresolved-retraction");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const marker = unresolved();
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        {
          "@id": mailboxIri(address),
          "bus:mailboxMarker": "v1",
          "bus:mailboxHead": mailboxReceiptIri(marker.operation),
        },
        {
          "@id": mailboxReceiptIri(marker.operation),
          "@type": "bus:MailboxUnresolved",
          "bus:mailboxRecord": encodeMailboxFact(mailboxFactOf(marker, null)),
        },
      ],
    });
    const result = await store.cut();
    const response = await fetch(
      `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
          where: { "@id": mailboxIri(address), "bus:mailboxHead": "?value" },
          delete: { "@id": mailboxIri(address), "bus:mailboxHead": "?value" },
        }),
      }
    );
    expect(response.status).toBe(200);
    expect((await store.mailbox(address, result)).status).toBe("UNRESOLVED");
    await expect(store.mailbox(address, await store.cut())).rejects.toThrow();
  });

  test("a start receipt without the same-commit presence cannot admit a join", async () => {
    const config = await freshLedger("mailbox-missing-presence");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const basis = await store.cut();
    const entry = presence();
    const operation = entry.id;
    const value = starting(entry, basis);
    const json = encodeMailboxFact(mailboxFactOf(value, null));
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        {
          "@id": mailboxIri(address),
          "bus:mailboxMarker": "v1",
          "bus:mailboxHead": mailboxReceiptIri(operation),
        },
        {
          "@id": mailboxReceiptIri(operation),
          "@type": "bus:MailboxStart",
          "bus:mailboxRecord": json,
        },
      ],
    });
    const cut = await store.cut();
    expect((await store.mailbox(address, cut)).status).toBe("FOUND");
    expect((await store.start(entry, value, basis)).status).toBe("UNKNOWN");
  });

  for (const target of ["receipt", "presence"] as const) {
    test(`reasserting the ${target} type cannot certify the original join`, async () => {
      const config = await freshLedger(`mailbox-reassert-type-${target}`);
      const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
      const basis = await store.cut();
      const owner = presence();
      const start = starting(owner, basis);
      const admitted = await store.start(owner, start, basis);
      if (admitted.status !== "ADMITTED") throw new Error("fixture join was not admitted");
      const node = {
        "@id":
          target === "receipt" ? mailboxReceiptIri(owner.id) : `urn:agent-bus:message:${owner.id}`,
        "@type": target === "receipt" ? "bus:MailboxStart" : "bus:Presence",
      };
      const context = { bus: "https://rawr.ai/ns/agent-bus#" };
      const removed = await fetch(
        `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ "@context": context, delete: node }),
        }
      );
      expect(removed.status).toBe(200);
      await removed.arrayBuffer();
      await insertRaw(config, { "@context": context, ...node });
      const changed = await store.cut();
      expect((await store.receipt(owner.id, admitted.cut)).status).toBe("FOUND");
      if (target === "receipt") {
        await expect(store.mailbox(owner.from, changed)).rejects.toThrow();
        expect((await store.receipt(owner.id, changed)).status).not.toBe("FOUND");
      }
      expect((await store.start(owner, start, basis)).status).toBe("UNKNOWN");
      expect(await store.cut()).toEqual(changed);
    });
  }

  test("a presence type added after its JSON cannot settle an earlier start", async () => {
    const config = await freshLedger("mailbox-late-presence-type");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const basis = await store.cut();
    const entry = presence();
    const start = starting(entry, basis);
    const receipt = mailboxReceiptIri(entry.id);
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        { "@id": mailboxIri(address), "bus:mailboxMarker": "v1", "bus:mailboxHead": receipt },
        {
          "@id": receipt,
          "@type": "bus:MailboxStart",
          "bus:mailboxRecord": encodeMailboxFact(mailboxFactOf(start, null)),
        },
        {
          "@id": `urn:agent-bus:message:${entry.id}`,
          "bus:id": entry.id,
          "bus:from": entry.from,
          "bus:json": Schema.encodeSync(MessageJson)(entry),
        },
      ],
    });
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@id": `urn:agent-bus:message:${entry.id}`,
      "@type": "bus:Presence",
    });
    const cut = await store.cut();
    expect((await store.start(entry, start, basis)).status).toBe("UNKNOWN");
    expect(await store.cut()).toEqual(cut);
  });

  test("an IRI under a mailbox predicate is damage, not a missing value", async () => {
    const config = await freshLedger("mailbox-wrong-term");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const initial = await store.cut();
    const owner = presence();
    expect((await store.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@id": mailboxIri(address),
      "bus:mailboxHead": { "@id": "urn:invalid:ack" },
    });
    await expect(store.mailbox(address, await store.cut())).rejects.toThrow();
  });

  test("Fluree exposes mailbox literal datatype for integrity checks", async () => {
    const config = await freshLedger("mailbox-datatype");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const initial = await store.cut();
    const owner = presence();
    expect((await store.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
    const cut = await store.cut();
    const response = await fetch(`${config.url}/v1/fluree/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        "@context": {
          bus: "https://rawr.ai/ns/agent-bus#",
          xsd: "http://www.w3.org/2001/XMLSchema#",
        },
        from: `${config.ledger}@t:1`,
        to: `${config.ledger}@t:${cut.head}`,
        select: ["?type"],
        values: [["?m"], [[{ "@type": "@id", "@value": mailboxIri(address) }]]],
        where: [
          { "@id": "?m", "bus:mailboxHead": "?value" },
          ["bind", "?type", "(datatype ?value)"],
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([["xsd:string"]]);
  });

  test("a structurally valid language-tagged event and witness are damage", async () => {
    const config = await freshLedger("mailbox-literal-type");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const initial = await store.cut();
    const owner = presence();
    expect((await store.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
    await store.append(message());
    const basis = await store.cut();
    const ack = acknowledgement(owner.id, initial.head, basis.head, basis);
    const tagged = { "@value": encodeMailboxFact(mailboxFactOf(ack, owner.id)), "@language": "en" };
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        {
          "@id": mailboxIri(address),
          "bus:mailboxHead": { "@value": mailboxReceiptIri(ack.operation), "@language": "en" },
        },
        {
          "@id": mailboxReceiptIri(ack.operation),
          "@type": "bus:MailboxAck",
          "bus:mailboxRecord": tagged,
        },
      ],
    });
    const corrupted = await store.cut();
    expect((await store.mailbox(address, basis)).status).toBe("FOUND");
    await expect(store.mailbox(address, corrupted)).rejects.toThrow();
    expect((await store.receipt(ack.operation, corrupted)).status).not.toBe("ABSENT");
  });

  test("pinned encoded-entry read alone cannot prove absence of a damaged message", async () => {
    const config = await freshLedger("mailbox-unencoded-message");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const before = await store.cut();
    const first = message();
    await store.append(first);
    const complete = await store.cut();
    const goodSibling = message();
    const damagedSubject = "urn:agent-bus:damaged-mail-without-id-or-address";
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        toNode(goodSibling, JSON.stringify(goodSibling)),
        { "@id": damagedSubject, "@type": "bus:Message" },
      ],
    });
    const after = await store.cut();
    const slice = await store.readAt(before.head, after);
    expect(slice.entries.map((entry) => entry.message.id)).toEqual([first.id, goodSibling.id]);
    expect(slice.next).toBe(after.head);
    expect(await store.candidates(complete.head, after)).toEqual(
      expect.arrayContaining([
        { subject: damagedSubject, end: after.head },
        {
          subject: messageIri(goodSibling.id),
          end: after.head,
          routing: {
            id: goodSibling.id,
            from: goodSibling.from,
            to: [address],
          },
        },
      ])
    );
    expect(await store.checked(before.head, after)).toEqual({
      entries: [{ message: first, end: complete.head }],
      damage: after.head,
    });
    expect(await store.checked(before.head, complete)).toEqual({
      entries: [{ message: first, end: complete.head }],
      damage: undefined,
    });
  });

  test("a fresh guarded write exposes matching routing, including a deliberately empty audience", async () => {
    const config = await freshLedger("mailbox-guarded-routing");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const before = await store.cut();
    const empty = new Message({ ...message(), to: [] });
    expect((await store.admit(empty, before)).status).toBe("ADMITTED");
    const afterEmpty = await store.cut();
    const direct = message();
    expect((await store.admit(direct, afterEmpty)).status).toBe("ADMITTED");
    const after = await store.cut();
    expect(await store.checked(before.head, after)).toEqual({
      entries: [{ message: direct, end: after.head }],
      damage: undefined,
    });
  });

  test("a dense scan keeps late route edits and type-only retractions at their respective damage positions", async () => {
    const config = await freshLedger("mailbox-long-history");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const earlier = message();
    await store.append(earlier);
    const from = (await store.cut()).head;
    const prefix = message();
    await store.append(prefix);
    const prefixT = (await store.cut()).head;
    const direct = message();
    const typedOnly = message("other");
    const group = [
      direct,
      typedOnly,
      new Message({ ...message(), to: [] }),
      ...Array.from({ length: 100 }, () => message("other")),
    ];
    await insertRaw(
      config,
      group.map((m) => toNode(m, JSON.stringify(m)))
    );
    const groupT = (await store.cut()).head;
    // No type candidates in these transactions; their unrelated routes are not mailbox groups.
    for (let i = 0; i < 499; i++) {
      await insertRaw(config, {
        "@id": `urn:filler:${i}`,
        "https://rawr.ai/ns/agent-bus#from": "unrelated",
      });
    }
    const ctx = { bus: "https://rawr.ai/ns/agent-bus#" };
    await insertRaw(config, {
      "@context": ctx,
      "@id": messageIri(earlier.id),
      "bus:to": "outside",
    });
    const good = await store.cut();
    const retract = async (node: Record<string, string>) => {
      const response = await flureeFetch(
        `/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ "@context": ctx, where: node, delete: node }),
        }
      );
      expect(response.ok).toBe(true);
    };
    await retract({ "@id": messageIri(typedOnly.id), "@type": "bus:Message" });
    const typeCut = await store.cut();
    const route = { "@id": messageIri(direct.id), "bus:to": address };
    await retract(route);
    await insertRaw(config, { "@context": ctx, ...route });
    const restored = await store.cut();
    const first = { message: prefix, end: prefixT };
    const both = [first, { message: direct, end: groupT }];
    expect(await store.checked(from, good)).toEqual({ entries: both, damage: undefined });
    expect(await store.checked(from, typeCut)).toEqual({ entries: both, damage: typeCut.head });
    expect(await store.checked(from, restored)).toEqual({ entries: [first], damage: groupT });
  }, 30_000);

  test.each(["bus:id", "bus:from", "bus:to"])(
    "an encoded message alone cannot hide its missing %s projection",
    async (field) => {
      const config = await freshLedger("mailbox-unprojected");
      const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
      const basis = await store.cut();
      const candidate = message();
      await insertRaw(config, { ...toNode(candidate, JSON.stringify(candidate)), [field]: null });
      const cut = await store.cut();
      expect(
        (await store.readAt(basis.head, cut)).entries.map(({ message }) => message.id)
      ).toEqual([candidate.id]);
      expect(await store.checked(basis.head, cut)).toEqual({ entries: [], damage: cut.head });
    }
  );

  test("the selected Fluree build refuses a lone-surrogate projected sender", async () => {
    const config = await freshLedger("mailbox-surrogate");
    await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const response = await fetch(
      `${config.url}/v1/fluree/insert?ledger=${encodeURIComponent(config.ledger)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
          "@id": "urn:mailbox:surrogate-control",
          "bus:from": "\ud800",
        }),
      }
    );
    expect(response.status).toBe(400);
  });
});

test("JSONL refuses mailbox positions that split a stored commit", async () => {
  const { one } = await backends[1].make();
  const initial = await one.cut();
  const owner = presence();
  expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
  const afterStart = await one.cut();
  await one.append(message());
  const basis = await one.cut();
  const middle = afterStart.head + 1;
  const invalid = acknowledgement(owner.id, initial.head, middle, basis);
  await expect(one.ack(invalid, basis)).rejects.toThrow("complete commit");
  expect(await one.cut()).toEqual(basis);
});

test("JSONL reopens compact receipts at their original byte cuts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-reopen-"));
  const file = join(dir, "ledger.jsonl");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const layer = () => layerJsonl(file).pipe(Layer.provide(platform)) as LedgerLayer;
  const first = ManagedRuntime.make(layer());
  const use = <A>(
    runtime: typeof first,
    f: (ledger: Ledger["Service"]) => Effect.Effect<A, unknown>
  ) => runtime.runPromise(Effect.flatMap(Ledger, f));
  const longRun = `legacy-${'\\"'.repeat(40_000)}`;
  const imported: MailboxStart = {
    version: 1,
    kind: "start",
    operation: Bun.randomUUIDv7(),
    address,
    run: longRun,
    origin: "import",
    position: 0,
  };
  const before = await use(first, (ledger) =>
    Effect.map(ledger.presenceAt(), (value) => value.cut)
  );
  appendFileSync(
    file,
    `${JSON.stringify({ "@mailboxStart": encodeMailboxFact(mailboxFactOf(imported, null)), message: null })}\n`
  );
  const written = await use(first, (ledger) =>
    Effect.map(ledger.presenceAt(), (value) => value.cut)
  );
  await first.dispose();
  const reopened = ManagedRuntime.make(layer());
  cleanups.push(() => reopened.dispose());
  expect(await use(reopened, (ledger) => ledger.mailboxAt(address, before))).toEqual({
    status: "ABSENT",
  });
  const state = await use(reopened, (ledger) => ledger.mailboxAt(address, written));
  if (state.status !== "FOUND" || state.current.record.kind !== "start")
    throw new Error("missing reopened import");
  expect(state.current.record.runRef).toBe(mailboxRunRef(longRun));
  expect(state.current.t).toBe(written.head);
  expect((await Bun.file(file).text()).includes(longRun)).toBe(false);
  expect(
    (await use(reopened, (ledger) => ledger.mailboxReceiptAt(address, imported.operation, written)))
      .status
  ).toBe("FOUND");
});

test("an unrelated undecodable JSONL line is not silently a mailbox position fact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-unrelated-"));
  const file = join(dir, "ledger.jsonl");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = await handle(layerJsonl(file).pipe(Layer.provide(platform)) as LedgerLayer);
  const basis = await store.cut();
  const entry = presence();
  const joined = await store.start(entry, starting(entry, basis), basis);
  if (joined.status !== "ADMITTED") throw new Error("start was not written");
  appendFileSync(file, '{"unrelated":true}\n');
  const after = await store.cut();
  const state = await store.mailbox(address, after);
  if (state.status !== "FOUND") throw new Error("position was lost");
  expect(state.current.record.operation).toBe(entry.id);
  // This says nothing about whether a consumer may acknowledge past that undecodable line.
});

test("JSONL rejects a compact receipt with a forged predecessor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-mailbox-predecessor-"));
  const file = join(dir, "ledger.jsonl");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = await handle(layerJsonl(file).pipe(Layer.provide(platform)) as LedgerLayer);
  const initial = await store.cut();
  const entry = presence();
  const joined = await store.start(entry, starting(entry, initial), initial);
  if (joined.status !== "ADMITTED") throw new Error("start was not written");
  await store.append(message());
  const basis = await store.cut();
  const ack = acknowledgement(entry.id, initial.head, basis.head, basis);
  const forged = mailboxFactOf(ack, Bun.randomUUIDv7());
  appendFileSync(file, `${JSON.stringify({ "@mailboxAck": encodeMailboxFact(forged) })}\n`);
  expect((await store.mailbox(address, basis)).status).toBe("FOUND");
  await expect(store.mailbox(address, await store.cut())).rejects.toThrow();
});
