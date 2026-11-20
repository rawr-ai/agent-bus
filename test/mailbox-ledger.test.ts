import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { Message, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import {
  encodeMailboxRecord,
  type MailboxAck,
  type MailboxStart,
  mailboxIri,
  mailboxReceiptIri,
  mailboxServedDigest,
} from "../src/mailbox-model.ts";
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
    import: (value: MailboxStart, cut: Pin) => use((ledger) => ledger.importMailbox(value, cut)),
    ack: (value: MailboxAck, cut: Pin) => use((ledger) => ledger.appendMailboxAck(value, cut)),
    mailbox: (value: string, cut: Pin) => use((ledger) => ledger.mailboxAt(value, cut)),
    receipt: (operation: string, cut: Pin, sender = address) =>
      use((ledger) => ledger.mailboxReceiptAt(sender, operation, cut)),
    read: (from: number) => use((ledger) => ledger.read(from)),
    readAt: (from: number, cut: Pin) => use((ledger) => ledger.readAt(from, cut)),
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
  subscription: [],
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

      const different = new Message({
        ...entry,
        presence: new Presence({ ...entry.presence, topics: ["different"] }),
      });
      expect((await two.start(different, start, basis)).status).not.toBe("ADMITTED");
      const final = await two.cut();
      expect(final).toEqual(first.cut);
      const stored = await two.read(basis.head);
      expect(stored.entries).toHaveLength(1);
      expect(stored.entries[0]?.message.presence?.topics).toEqual([]);
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
        { ...value, subscription: ["other-topic"] },
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

  test("a lost successful update remains unknown until its immutable receipt is read", async () => {
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
    expect((await unreliable.ack(value, basis)).status).toBe("UNKNOWN");
    expect(await forwarded).toEqual({ status: 200 });
    const committed = await direct.cut();
    expect((await direct.receipt(value.operation, committed)).status).toBe("FOUND");
    expect((await unreliable.ack(value, basis)).status).toBe("APPLIED");
    expect(await direct.cut()).toEqual(committed);
  });

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
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@id": `urn:agent-bus:message:${Bun.randomUUIDv7()}`,
      "@type": "bus:Message",
      "bus:id": Bun.randomUUIDv7(),
      "bus:to": address,
    });
    const after = await store.cut();
    const slice = await store.readAt(before.head, after);
    expect(slice.entries).toEqual([]);
    expect(slice.next).toBe(after.head);
    // D2 must independently check candidate completeness and damage before acknowledging.
  });

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
