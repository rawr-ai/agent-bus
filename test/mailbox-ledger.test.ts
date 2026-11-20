import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { Message, Origin, Presence } from "../src/domain.ts";
import { layerFluree, toNode } from "../src/Fluree.ts";
import { Ledger, messageIri } from "../src/Ledger.ts";
import {
  encodeMailboxRecord,
  type MailboxAck,
  type MailboxStart,
  type MailboxUnresolved,
  mailboxIri,
  mailboxReceiptIri,
  mailboxServedDigest,
  mailboxTopicsDigest,
} from "../src/mailbox-model.ts";
import { readMailboxSlice } from "../src/mailbox-read.ts";
import type { Pin } from "../src/Query.ts";
import { boundary } from "./fluree-boundary.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";
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
    append: (message: Message) => use((ledger) => ledger.append(message)),
    admit: (message: Message, cut: Pin) => use((ledger) => ledger.admit(message, cut)),
    start: (message: Message, value: MailboxStart, cut: Pin) =>
      use((ledger) => ledger.admitWithStart(message, value, cut)),
    classify: (value: MailboxUnresolved, cut: Pin) =>
      use((ledger) => ledger.classifyMailboxImport(value, cut)),
    import: (value: MailboxStart, cut: Pin) => use((ledger) => ledger.importMailbox(value, cut)),
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
        damage: (value: string) =>
          insertRaw(config, {
            "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
            "@id": mailboxIri(value),
            "bus:mailboxAck": "{}",
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
      expect(state.records).toHaveLength(1);
      const stored = await two.read(basis.head);
      expect(stored.entries.filter((item) => item.message.id === entry.id)).toHaveLength(1);
    });

    test("a settled message or another mailbox fact cannot be claimed as a start", async () => {
      const { one } = await backend.make();
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
      const marked = await one.classify(marker, afterMessage);
      if (marked.status !== "APPLIED") throw new Error("classification was not written");
      const collided = new Message({ ...presence(), id: marker.operation });
      expect(
        (await one.start(collided, starting(collided, afterMessage), afterMessage)).status
      ).toBe("REFUSED");
      expect(await one.cut()).toEqual(marked.cut);
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
      const imported: MailboxStart = {
        version: 1,
        kind: "start",
        operation: entry.id,
        address: other,
        run: "other-run",
        origin: "import",
        position: 0,
      };
      expect((await two.import(imported, first.cut)).status).toBe("IDENTITY_MISMATCH");
      expect((await two.mailbox(other, await two.cut())).status).toBe("ABSENT");
      expect(await two.cut()).toEqual(first.cut);
    });

    test("unresolved imports persist until explicit reconciliation", async () => {
      const { one, two } = await backend.make();
      const before = await one.cut();
      const marker = unresolved(address, "conflict");
      const first = await one.classify(marker, before);
      if (first.status !== "APPLIED") throw new Error("classification was not written");
      expect(await two.mailbox(address, before)).toEqual({ status: "ABSENT" });
      const unknown = await two.mailbox(address, first.cut);
      expect(unknown.status).toBe("UNRESOLVED");
      if (unknown.status !== "UNRESOLVED") return;
      expect(unknown.reason).toBe("conflict");
      expect(unknown.records).toHaveLength(1);
      expect(await two.classify(marker, before)).toEqual(first);
      expect((await two.classify({ ...marker, reason: "stale" }, before)).status).toBe(
        "IDENTITY_MISMATCH"
      );

      expect((await two.admit(presence(), first.cut)).status).toBe("ADMITTED");
      const renewed = await two.cut();
      expect((await one.mailbox(address, renewed)).status).toBe("UNRESOLVED");
      const entry = presence();
      expect((await two.start(entry, starting(entry, renewed), renewed)).status).toBe("REFUSED");
      const noGuess: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address,
        run: "reconciled-run",
        origin: "import",
        position: 0,
      };
      expect((await two.import(noGuess, renewed)).status).toBe("CONFLICT");
      const recovered: MailboxStart = { ...noGuess, origin: "reconcile" };
      const applied = await two.import(recovered, renewed);
      if (applied.status !== "APPLIED") throw new Error("reconciliation was not written");
      const final = await one.mailbox(address, applied.cut);
      if (final.status !== "FOUND") throw new Error("reconciliation lost the position");
      expect(final.position).toBe(0);
      expect(final.records).toHaveLength(2);
      expect((await one.mailbox(address, first.cut)).status).toBe("UNRESOLVED");
    });

    test("restart resolves an unresolved import only as an explicit atomic start", async () => {
      const { one, two } = await backend.make();
      const before = await one.cut();
      const marker = await one.classify(unresolved(), before);
      if (marker.status !== "APPLIED") throw new Error("classification was not written");
      const entry = presence();
      const replay = { ...starting(entry, marker.cut, "replay"), position: 0 };
      expect((await two.start(entry, replay, marker.cut)).status).toBe("REFUSED");
      const restart = starting(entry, marker.cut, "restart");
      const result = await two.start(entry, restart, marker.cut);
      if (result.status !== "ADMITTED") throw new Error("restart was not admitted");
      const state = await one.mailbox(address, result.cut);
      if (state.status !== "FOUND") throw new Error("missing restart position");
      expect(state.position).toBe(marker.cut.head);
      expect(state.records).toHaveLength(2);
    });

    test("concurrent reconciliation and restart have one resolution", async () => {
      const { one, two } = await backend.make();
      const before = await one.cut();
      const marked = await one.classify(unresolved(), before);
      if (marked.status !== "APPLIED") throw new Error("classification was not written");
      const entry = presence();
      const restart = starting(entry, marked.cut, "restart");
      const reconcile: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address,
        run: "recovered-run",
        origin: "reconcile",
        position: 0,
      };
      const [restarted, reconciled] = await Promise.all([
        one.start(entry, restart, marked.cut),
        two.import(reconcile, marked.cut),
      ]);
      expect(
        [restarted.status, reconciled.status].filter(
          (status) => status === "ADMITTED" || status === "APPLIED"
        )
      ).toHaveLength(1);
      const cut = await one.cut();
      const state = await two.mailbox(address, cut);
      if (state.status !== "FOUND") throw new Error("missing winning resolution");
      expect(state.records).toHaveLength(2);
      const receipts = await Promise.all([
        one.receipt(entry.id, cut),
        one.receipt(reconcile.operation, cut),
      ]);
      expect(receipts.filter((value) => value.status === "FOUND")).toHaveLength(1);
      const entries = (await one.read(marked.cut.head)).entries.filter(
        (item) => item.message.id === entry.id
      );
      expect(entries).toHaveLength(restarted.status === "ADMITTED" ? 1 : 0);
    });

    test("classification, initial start and import cannot all win the same empty basis", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      const marker = unresolved();
      const entry = presence();
      const imported: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address,
        run: "imported-run",
        origin: "import",
        position: 0,
      };
      const results = await Promise.all([
        one.classify(marker, basis),
        two.start(entry, starting(entry, basis), basis),
        one.import(imported, basis),
      ]);
      expect(
        results.filter((result) => result.status === "APPLIED" || result.status === "ADMITTED")
      ).toHaveLength(1);
      const cut = await one.cut();
      const state = await one.mailbox(address, cut);
      if (state.status === "ABSENT") throw new Error("winning fact is missing");
      expect(state.records).toHaveLength(1);
      const receipts = await Promise.all([
        one.receipt(marker.operation, cut),
        one.receipt(entry.id, cut),
        one.receipt(imported.operation, cut),
      ]);
      expect(receipts.filter((value) => value.status === "FOUND")).toHaveLength(1);
    });

    test("a later presence alone fences a stale acknowledgement and import", async () => {
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

      const other = "claude/import-target";
      const importBasis = await one.cut();
      const join = presence(other);
      expect((await two.admit(join, importBasis)).status).toBe("ADMITTED");
      const imported: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address: other,
        run: "run",
        origin: "import",
        position: 0,
      };
      expect((await one.import(imported, importBasis)).status).toBe("CONFLICT");
      expect((await one.receipt(imported.operation, await one.cut(), other)).status).toBe("ABSENT");
      expect((await one.mailbox(other, await one.cut())).status).toBe("ABSENT");
    });

    test("another address's presence and classification do not fence an import", async () => {
      const { one, two } = await backend.make();
      const basis = await one.cut();
      expect((await two.admit(presence("claude/neighbour"), basis)).status).toBe("ADMITTED");
      expect((await two.classify(unresolved("claude/elsewhere"), basis)).status).toBe("APPLIED");
      const imported: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address,
        run: "run",
        origin: "import",
        position: 0,
      };
      expect((await one.import(imported, basis)).status).toBe("APPLIED");
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
      expect(saved.record.subscription).toEqual(value.subscription);
      expect(await two.ack(value, dataCut)).toEqual(acked);
      const historical = await one.readAt(basis.head, dataCut);
      const recovered = historical.entries.find((item) => item.message.id === joined.id);
      expect(recovered?.message.presence?.topics).toEqual(topics);
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
      expect(state.records).toHaveLength(2);
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
      const renewal = presence(address, "session-a");
      expect((await one.admit(renewal, before)).status).toBe("ADMITTED");
      const after = await one.mailbox(address, await one.cut());
      if (after.status !== "FOUND") throw new Error("missing inherited position");
      expect(after.position).toBe(basis.head);
      expect(after.records).toHaveLength(2);
    });

    test("earlier message, presence and direct scans ignore mailbox records", async () => {
      const { one } = await backend.make();
      const initial = await one.cut();
      const owner = presence();
      expect((await one.start(owner, starting(owner, initial), initial)).status).toBe("ADMITTED");
      const mail = message();
      await one.append(mail);
      const basis = await one.cut();
      expect(
        (await one.ack(acknowledgement(owner.id, initial.head, basis.head, basis), basis)).status
      ).toBe("APPLIED");
      const classifiedAt = await one.cut();
      expect((await one.classify(unresolved("claude/unresolved"), classifiedAt)).status).toBe(
        "APPLIED"
      );
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
      const { one } = await backend.make();
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
      expect((await one.import(imported, initial)).status).toBe("APPLIED");
      const afterImport = await one.cut();
      expect(
        (await one.import({ ...imported, operation: Bun.randomUUIDv7() }, afterImport)).status
      ).toBe("CONFLICT");
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
      const wouldImport: MailboxStart = {
        version: 1,
        kind: "start",
        operation: Bun.randomUUIDv7(),
        address,
        run: Bun.randomUUIDv7(),
        origin: "import",
        position: 0,
      };
      const result = await one.import(wouldImport, damaged).then(
        (value) => value.status,
        () => "ERROR"
      );
      expect(["UNKNOWN", "ERROR"]).toContain(result);
      expect(await one.cut()).toEqual(damaged);
    });

    test("import distinguishes supported address keys and explicitly refuses unpaired surrogates on Fluree", async () => {
      const { one } = await backend.make();
      for (const key of [
        "\ud800",
        "\ud801",
        "\ufffd",
        "\u00e9",
        "e\u0301",
        "?one/two",
        "?one%2Ftwo",
      ]) {
        const basis = await one.cut();
        const value: MailboxStart = {
          version: 1,
          kind: "start",
          operation: Bun.randomUUIDv7(),
          address: key,
          run: Bun.randomUUIDv7(),
          origin: "import",
          position: 0,
        };
        if (backend.name === "fluree" && (key === "\ud800" || key === "\ud801")) {
          await expect(one.import(value, basis)).rejects.toThrow();
          expect(await one.cut()).toEqual(basis);
          continue;
        }
        expect((await one.import(value, basis)).status).toBe("APPLIED");
        const state = await one.mailbox(key, await one.cut());
        expect(state.status).toBe("FOUND");
        if (state.status === "FOUND") expect(state.position).toBe(0);
      }
    });
  });
}

describe("mailbox Fluree boundaries", () => {
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
    expect(state.records).toHaveLength(1);
    const stored = await direct.read(basis.head);
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]?.message.presence?.topics).toEqual([]);
  });

  test("a foreign receipt winning after preflight is a collision, not a leaked receipt", async () => {
    const config = await freshLedger("mailbox-foreign-race");
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
    const other = "claude/foreign-winner";
    const marker = unresolved(other, "stale");
    const imported: MailboxStart = {
      version: 1,
      kind: "start",
      operation: marker.operation,
      address,
      run: "run",
      origin: "import",
      position: 0,
    };
    armed = true;
    const pending = slow.import(imported, basis);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let winning: Awaited<ReturnType<typeof direct.classify>> | undefined;
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
      winning = await direct.classify(marker, basis);
      expect(winning.status).toBe("APPLIED");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      release();
    }
    if (winning?.status !== "APPLIED") throw new Error("foreign receipt did not win");
    expect((await pending).status).toBe("IDENTITY_MISMATCH");
    expect(await direct.cut()).toEqual(winning.cut);
    expect((await direct.mailbox(address, winning.cut)).status).toBe("ABSENT");
    expect((await direct.mailbox(other, winning.cut)).status).toBe("UNRESOLVED");
    const hidden = await direct.receipt(marker.operation, winning.cut, address);
    expect(hidden.status).toBe("ADDRESS_MISMATCH");
    expect(hidden).not.toHaveProperty("record");
    expect((await direct.receipt(marker.operation, winning.cut, other)).status).toBe("FOUND");
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
    expect(state.records).toHaveLength(2);
  });

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

  test("lost successful join-start and import responses recover their original commits", async () => {
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

    const other = "claude/import-after-loss";
    const imported: MailboxStart = {
      version: 1,
      kind: "start",
      operation: Bun.randomUUIDv7(),
      address: other,
      run: "imported-run",
      origin: "import",
      position: 0,
    };
    const secondForwarded = relay.loseNextUpdate();
    const saved = await unreliable.import(imported, afterJoin);
    expect(saved.status).toBe("APPLIED");
    expect(await secondForwarded).toEqual({ status: 200 });
    if (saved.status !== "APPLIED") return;
    await direct.append(message("claude/neighbour"));
    const afterImport = await direct.cut();
    expect(await unreliable.import(imported, afterJoin)).toEqual(saved);
    expect(await direct.cut()).toEqual(afterImport);
    const state = await direct.mailbox(other, afterImport);
    if (state.status !== "FOUND") throw new Error("import was not retained");
    expect(state.records).toHaveLength(1);
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
        expect(state.records).toHaveLength(1);
        const entries = await direct.read(basis.head);
        expect(entries.entries.filter((item) => item.message.id === owner.id)).toHaveLength(1);
      }
      expect(await direct.cut()).toEqual(committed);
    });
  }

  test("a malformed newer event and a dangling receipt each fail closed", async () => {
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
      "bus:mailboxAck": encodeMailboxRecord(value),
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
      "bus:mailboxRecord": encodeMailboxRecord(orphan),
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
          where: { "@id": subject, "bus:mailboxStart": "?value" },
          delete: { "@id": subject, "bus:mailboxStart": "?value" },
        }),
      }
    );
    expect(response.status).toBe(200);
    expect((await store.mailbox(address, admitted.cut)).status).toBe("FOUND");
    await expect(store.mailbox(address, await store.cut())).rejects.toThrow();
  });

  test("retracting an unresolved import is damage, not a fresh mailbox", async () => {
    const config = await freshLedger("unresolved-retraction");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const basis = await store.cut();
    const result = await store.classify(unresolved(), basis);
    if (result.status !== "APPLIED") throw new Error("classification was not written");
    const response = await fetch(
      `${config.url}/v1/fluree/update?ledger=${encodeURIComponent(config.ledger)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
          where: { "@id": mailboxIri(address), "bus:mailboxStart": "?value" },
          delete: { "@id": mailboxIri(address), "bus:mailboxStart": "?value" },
        }),
      }
    );
    expect(response.status).toBe(200);
    expect((await store.mailbox(address, result.cut)).status).toBe("UNRESOLVED");
    await expect(store.mailbox(address, await store.cut())).rejects.toThrow();
  });

  test("a start and its witness without the same-commit presence is damage", async () => {
    const config = await freshLedger("mailbox-missing-presence");
    const store = await handle(layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer);
    const operation = Bun.randomUUIDv7();
    const value: MailboxStart = {
      version: 1,
      kind: "start",
      operation,
      address,
      run: operation,
      origin: "join",
      position: 0,
    };
    const json = encodeMailboxRecord(value);
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        { "@id": mailboxIri(address), "bus:mailboxStart": json },
        {
          "@id": mailboxReceiptIri(operation),
          "@type": "bus:MailboxStart",
          "bus:mailboxRecord": json,
        },
      ],
    });
    const cut = await store.cut();
    await expect(store.mailbox(address, cut)).rejects.toThrow();
    expect((await store.receipt(operation, cut)).status).toBe("UNAVAILABLE");
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
      "bus:mailboxAck": { "@id": "urn:invalid:ack" },
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
          { "@id": "?m", "bus:mailboxStart": "?value" },
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
    const tagged = { "@value": encodeMailboxRecord(ack), "@language": "en" };
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        { "@id": mailboxIri(address), "bus:mailboxAck": tagged },
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
  const malformedImport: MailboxStart = {
    version: 1,
    kind: "start",
    operation: Bun.randomUUIDv7(),
    address: "claude/other",
    run: Bun.randomUUIDv7(),
    origin: "import",
    position: middle,
  };
  await expect(one.import(malformedImport, basis)).rejects.toThrow("complete commit");
  expect(await one.cut()).toEqual(basis);
});
