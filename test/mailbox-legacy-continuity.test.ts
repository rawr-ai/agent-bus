import { expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import { Message, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import {
  encodeMailboxFact,
  type MailboxRecord,
  mailboxFactOf,
  mailboxHolderRef,
  mailboxInstallationRef,
  mailboxIri,
  mailboxPresenceRef,
  mailboxReceiptIri,
  mailboxRunRef,
} from "../src/mailbox-model.ts";
import { freshLedger, insertRaw } from "./fluree-server.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const event = (address: string, status: "joined" | "left") =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from: address,
    to: ["*"],
    kind: "presence",
    body: `${address} ${status}`,
    presence: new Presence({ runtime: "other", session: `owner:${address}`, topics: [], status }),
  });
const mail = (address: string, body: string) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from: "sender",
    to: [address],
    kind: "message",
    body,
  });

test("retained import facts preserve manual reads, source return and no-file vacancy", async () => {
  const config = await freshLedger("legacy-continuity");
  const one = Bun.randomUUIDv7();
  const two = Bun.randomUUIDv7();
  let fault: "UNAVAILABLE" | "ABSENT" | undefined;
  let targetOperation = "";
  const selected = layerFluree(config);
  const withFault = Layer.effect(Ledger)(
    Effect.map(Ledger, (ledger) =>
      Ledger.of({
        ...ledger,
        mailboxReceiptAt: (address, operation, cut) => {
          if (address !== "legacy/manual" || operation !== targetOperation || fault === undefined)
            return ledger.mailboxReceiptAt(address, operation, cut);
          const status = fault;
          fault = undefined;
          return Effect.succeed(status === "ABSENT" ? { status, cut } : { status });
        },
      })
    )
  ).pipe(Layer.provideMerge(selected));
  const runtime = ManagedRuntime.make(withFault.pipe(Layer.provideMerge(platform)));
  const machine = (installation: string) =>
    ManagedRuntime.make(
      Bus.layer(installation).pipe(Layer.provideMerge(withFault), Layer.provide(platform))
    );
  let a = machine(one);
  const b = machine(two);
  const use = <A, E>(f: (ledger: Ledger["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Ledger, f));
  const cut = () => use((ledger) => ledger.presenceAt().pipe(Effect.map((result) => result.cut)));
  const writeFact = async (record: MailboxRecord) => {
    const receipt = mailboxReceiptIri(record.operation);
    await insertRaw(config, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      "@graph": [
        {
          "@id": mailboxIri(record.address),
          "bus:mailboxMarker": "v1",
          "bus:mailboxHead": receipt,
        },
        {
          "@id": receipt,
          "@type": `bus:Mailbox${record.kind === "start" ? "Start" : "Unresolved"}`,
          "bus:mailboxRecord": encodeMailboxFact(mailboxFactOf(record, null)),
        },
      ],
    });
  };
  try {
    const manual = event("legacy/manual", "joined");
    const returned = event("legacy/return", "joined");
    const vacant = event("legacy/vacant", "joined");
    for (const entry of [manual, returned, vacant]) await use((ledger) => ledger.append(entry));
    const consumed = mail(manual.from, "consumed");
    await use((ledger) => ledger.append(consumed));
    const position = (await cut()).head;
    const first = mail(manual.from, "first");
    const second = mail(manual.from, "second");
    await use((ledger) => ledger.append(first));
    await use((ledger) => ledger.append(second));
    const returnedLeave = event(returned.from, "left");
    const vacantLeave = event(vacant.from, "left");
    await use((ledger) => ledger.append(returnedLeave));
    await use((ledger) => ledger.append(vacantLeave));
    const captured = await cut();
    targetOperation = Bun.randomUUIDv7();
    for (const [entry, operation] of [
      [manual, targetOperation],
      [returned, Bun.randomUUIDv7()],
    ] as const) {
      await writeFact({
        version: 1,
        kind: "start",
        operation,
        address: entry.from,
        run: entry.id,
        origin: "import",
        position,
        legacySource: {
          cut: captured,
          presenceRef: mailboxPresenceRef(entry === returned ? returnedLeave.id : entry.id),
          installationRef: mailboxInstallationRef(one),
        },
      });
    }
    await writeFact({
      version: 1,
      kind: "unresolved",
      operation: Bun.randomUUIDv7(),
      address: vacant.from,
      reason: "missing",
      vacant: {
        cut: captured,
        presenceRef: mailboxPresenceRef(vacantLeave.id),
        runRef: mailboxRunRef(vacant.id),
        holderRef: mailboxHolderRef("other", `owner:${vacant.from}`),
        noFiles: true,
      },
    });
    const session = `owner:${manual.from}`;
    const keyed = (holder = session, id = Bun.randomUUIDv7()) =>
      a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.read({ address: manual.from, session: holder, readId: id })
        )
      );
    const before = await cut();
    await expect(
      b.runPromise(Effect.flatMap(Bus.Bus, (bus) => bus.take(manual.from, session)))
    ).rejects.toThrow();
    await expect(keyed("wrong-session")).rejects.toMatchObject({ _tag: "NotOwner" });
    expect(
      await a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) => bus.deliver(manual.from, () => Effect.succeed("woke")))
      )
    ).toBeUndefined();
    expect(await cut()).toEqual(before);
    const peek = await a.runPromise(
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.read({ address: manual.from, session, peek: true, limit: 1 })
      )
    );
    expect(peek.messages.map(({ id }) => id)).toEqual([first.id]);
    const receipt = peek.receipt;
    if (!receipt?.basis || !receipt.served) throw new Error("No peek receipt");
    const witnessedReceipt = { ...receipt, basis: receipt.basis, served: receipt.served };
    await a.runPromise(
      Effect.flatMap(Bus.Bus, (bus) =>
        bus.ack({ address: manual.from, session, receipt: witnessedReceipt })
      )
    );
    await a.dispose();
    a = machine(one);
    await expect(
      b.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.ack({ address: manual.from, session, receipt: witnessedReceipt })
        )
      )
    ).rejects.toMatchObject({
      _tag: "NotJoined",
    });
    expect(
      (
        await a.runPromise(
          Effect.flatMap(Bus.Bus, (bus) =>
            bus.ack({ address: manual.from, session, receipt: witnessedReceipt })
          )
        )
      ).receipt.replayed
    ).toBe(true);
    const afterAck = await cut();
    const state = await use((ledger) => ledger.mailboxAt(manual.from, afterAck));
    const readId = Bun.randomUUIDv7();
    fault = "UNAVAILABLE";
    await expect(keyed(session, readId)).rejects.toMatchObject({
      _tag: "LedgerError",
      message: expect.stringMatching(/Retry the same call once.*same readId/),
    });
    fault = "ABSENT";
    await expect(keyed(session, readId)).rejects.toMatchObject({
      _tag: "LedgerError",
      message: expect.stringContaining("Ask the operator to reconcile"),
    });
    expect(await cut()).toEqual(afterAck);
    expect(await use((ledger) => ledger.mailboxAt(manual.from, afterAck))).toEqual(state);
    const recovered = await keyed(session, readId);
    expect(recovered.messages.map(({ id }) => id)).toEqual([second.id]);
    expect((await keyed(session, readId)).receipt).toMatchObject({ readId, replayed: true });
    expect((await keyed(session, recovered.nextReadId)).messages).toEqual([]);
    const claim = (address: string) =>
      a.runPromise(
        Effect.flatMap(Bus.Bus, (bus) =>
          bus.join({ address, session: `owner:${address}`, runtime: "other", cwd: "/fixture" })
        )
      );
    expect((await claim(returned.from)).cursor).toBe(position);
    const beforeVacancy = await cut();
    expect((await claim(vacant.from)).cursor).toBe(beforeVacancy.head);
    await insertRaw(config, {
      "@id": mailboxReceiptIri(targetOperation),
      "https://example.invalid/unexpected": "damaged",
    });
    const damaged = await cut();
    await expect(keyed()).rejects.toMatchObject({
      _tag: "LedgerError",
      message: expect.stringContaining("Ask the operator to reconcile"),
    });
    expect(await cut()).toEqual(damaged);
  } finally {
    await a.dispose();
    await b.dispose();
    await runtime.dispose();
  }
}, 30_000);
