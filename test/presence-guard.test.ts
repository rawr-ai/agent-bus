// The guard on a presence write, at the Ledger boundary: `admit(presence, basis)` lands only if
// no presence for the presence's address was written after `basis`, and only once for its id.
// Each backend runs as two Ledger instances on one store, a decider and an independent writer,
// as two serves (or two Bus layers in one process, for JSONL) share one ledger. Bus-level
// interleavings on Fluree are in lifecycle-takeover-race.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { Message, MessageJson, Origin, Presence } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import type { Pin } from "../src/Query.ts";
import { freshLedger } from "./fluree-server.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const address = "claude/guarded";
const TIMEOUT = 30_000;

const presence = (from: string, session: string) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from,
    to: ["*"],
    kind: "presence",
    body: `${from} joined`,
    origin: new Origin({ host: "fixture", cwd: "/work" }),
    presence: new Presence({ runtime: "claude", status: "joined", topics: [], session }),
  });
const note = (from: string) =>
  new Message({
    id: Bun.randomUUIDv7(),
    ts: new Date().toISOString(),
    from,
    to: ["*"],
    kind: "message",
    body: "not a presence",
    origin: new Origin({ host: "fixture", cwd: "/work" }),
  });

type LedgerLayer = Layer.Layer<Ledger, unknown, never>;
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
afterAll(async () => {
  for (const runtime of runtimes) await runtime.dispose();
});

const handle = async (layer: LedgerLayer) => {
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  await runtime.runPromise(Effect.void);
  const use = <A>(f: (ledger: Ledger["Service"]) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(Effect.flatMap(Ledger, f));
  return {
    cut: () => use((ledger) => Effect.map(ledger.presenceAt(), (read) => read.cut)),
    ids: (at?: number) =>
      use((ledger) =>
        Effect.map(ledger.presenceAt(at), (read) => read.entries.map((entry) => entry.id))
      ),
    append: (message: Message) => use((ledger) => ledger.append(message)),
    admit: (message: Message, basis: Pin) => use((ledger) => ledger.admit(message, basis)),
    command: (from: string, operation: string = Bun.randomUUIDv7()) =>
      use((ledger) =>
        ledger.appendCommand(
          operation,
          JSON.stringify({ address: from, runtime: "claude", session: "session:a", run: "run" })
        )
      ),
    readCommand: (operation: string) => use((ledger) => ledger.readCommand(operation)),
  };
};

const backends = [
  {
    name: "fluree",
    make: async () => {
      const config = await freshLedger("presence-guard");
      const layer = () => layerFluree(config).pipe(Layer.provide(platform)) as LedgerLayer;
      return { decider: await handle(layer()), writer: await handle(layer()), file: undefined };
    },
  },
  {
    name: "jsonl",
    make: async () => {
      const file = join(mkdtempSync(join(tmpdir(), "agent-bus-guard-")), "ledger.jsonl");
      const layer = () => layerJsonl(file).pipe(Layer.provide(platform)) as LedgerLayer;
      return { decider: await handle(layer()), writer: await handle(layer()), file };
    },
  },
] as const;

for (const backend of backends) {
  describe(`presence guard (${backend.name})`, () => {
    test(
      "a presence for the address at the basis itself does not block",
      async () => {
        const { decider, writer } = await backend.make();
        await writer.append(presence(address, "session:earlier"));
        const basis = await decider.cut();
        const attempt = presence(address, "session:a");
        const admission = await decider.admit(attempt, basis);
        expect(admission.status).toBe("ADMITTED");
        if (admission.status !== "ADMITTED") return;
        expect(admission.cut.head).toBeGreaterThan(basis.head);
        expect(await decider.ids(admission.cut.head)).toContain(attempt.id);
      },
      TIMEOUT
    );

    test(
      "a presence for the address after the basis refuses, and nothing is written",
      async () => {
        const { decider, writer } = await backend.make();
        const basis = await decider.cut();
        await writer.append(presence(address, "session:other"));
        const attempt = presence(address, "session:a");
        const admission = await decider.admit(attempt, basis);
        expect(admission.status).toBe("REFUSED");
        expect(await writer.ids()).not.toContain(attempt.id);
      },
      TIMEOUT
    );

    test(
      "control: a presence without a session reads, and a later presence still admits",
      async () => {
        const { decider, writer } = await backend.make();
        const legacy = new Message({
          ...presence(address, "unused"),
          presence: new Presence({ runtime: "claude", status: "joined", topics: [] }),
        });
        await writer.append(legacy);
        const basis = await decider.cut();
        expect(await decider.ids()).toContain(legacy.id);
        const attempt = presence(address, "session:a");
        expect((await decider.admit(attempt, basis)).status).toBe("ADMITTED");
      },
      TIMEOUT
    );

    test(
      "another address's presence after the basis does not block",
      async () => {
        const { decider, writer } = await backend.make();
        const basis = await decider.cut();
        await writer.append(presence("claude/neighbour", "session:other"));
        expect((await decider.admit(presence(address, "session:a"), basis)).status).toBe(
          "ADMITTED"
        );
      },
      TIMEOUT
    );

    test(
      "a non-presence message from the address after the basis does not block",
      async () => {
        const { decider, writer } = await backend.make();
        const basis = await decider.cut();
        await writer.append(note(address));
        expect((await decider.admit(presence(address, "session:a"), basis)).status).toBe(
          "ADMITTED"
        );
      },
      TIMEOUT
    );

    test(
      "an address command for the address after the basis does not block",
      async () => {
        const { decider, writer } = await backend.make();
        const basis = await decider.cut();
        await writer.command(address);
        expect((await decider.admit(presence(address, "session:a"), basis)).status).toBe(
          "ADMITTED"
        );
      },
      TIMEOUT
    );

    test(
      "replaying an admitted id, even from its own commit, is refused and stored once",
      async () => {
        const { decider, writer } = await backend.make();
        const attempt = presence(address, "session:a");
        const first = await decider.admit(attempt, await decider.cut());
        expect(first.status).toBe("ADMITTED");
        if (first.status !== "ADMITTED") return;
        // From its own commit, no other presence is newer: only the id can refuse it.
        const replay = await decider.admit(attempt, first.cut);
        expect((await writer.ids()).filter((id) => id === attempt.id)).toHaveLength(1);
        expect(replay.status).toBe("REFUSED");
      },
      TIMEOUT
    );

    test(
      "a resend from the original basis never stores a second entry",
      async () => {
        const { decider, writer } = await backend.make();
        const attempt = presence(address, "session:a");
        const basis = await decider.cut();
        expect((await decider.admit(attempt, basis)).status).toBe("ADMITTED");
        // Outside the contract (a fresh id per attempt, never resent): the status may report
        // the original admission, but the entry is never written twice.
        await decider.admit(attempt, basis);
        expect((await writer.ids()).filter((id) => id === attempt.id)).toHaveLength(1);
      },
      TIMEOUT
    );

    test(
      "a presence read at a cut excludes presences committed after it",
      async () => {
        const { decider, writer } = await backend.make();
        const before = presence(address, "session:before");
        await writer.append(before);
        const cut = await decider.cut();
        const after = presence(address, "session:after");
        await writer.append(after);
        const at = await decider.ids(cut.head);
        expect(at).toContain(before.id);
        expect(at).not.toContain(after.id);
        expect(await decider.ids()).toContain(after.id);
      },
      TIMEOUT
    );

    test(
      "valid presence history larger than any query page is read completely",
      async () => {
        const { decider, writer } = await backend.make();
        // About 400 KiB of valid presences, past the 256 KiB bound on bounded query responses.
        const large = Array.from({ length: 40 }, (_, i) => {
          const entry = presence(`claude/large-${i}`, `session:${i}`);
          return new Message({ ...entry, body: "x".repeat(10_000) });
        });
        for (const entry of large) await writer.append(entry);
        const ids = await decider.ids();
        expect(large.every((entry) => ids.includes(entry.id))).toBe(true);
        expect(
          (await decider.admit(presence(address, "session:a"), await decider.cut())).status
        ).toBe("ADMITTED");
      },
      TIMEOUT
    );

    if (backend.name === "jsonl") {
      test(
        "an undecodable line past the basis refuses",
        async () => {
          const { decider, file } = await backend.make();
          const basis = await decider.cut();
          appendFileSync(file, "{not json\n");
          const attempt = presence(address, "session:a");
          expect((await decider.admit(attempt, basis)).status).toBe("REFUSED");
        },
        TIMEOUT
      );

      test(
        "a malformed command-prefixed line past the basis refuses",
        async () => {
          const { decider, file } = await backend.make();
          const basis = await decider.cut();
          // A torn command line could have run into anything, a rival presence included.
          appendFileSync(file, '{"@command":"torn","command":"{\\"addr\n');
          const attempt = presence(address, "session:a");
          expect((await decider.admit(attempt, basis)).status).toBe("REFUSED");
        },
        TIMEOUT
      );

      test(
        "a presence carrying command keys is still a presence to the guard",
        async () => {
          const { decider, file } = await backend.make();
          const basis = await decider.cut();
          // Only a line written as a command passes; extra keys never make a presence one.
          const rival = await Effect.runPromise(
            Schema.encodeEffect(MessageJson)(presence(address, "session:b"))
          );
          appendFileSync(file, `${rival.slice(0, -1)},"@command":"x","command":"{}"}\n`);
          const attempt = presence(address, "session:a");
          expect((await decider.admit(attempt, basis)).status).toBe("REFUSED");
        },
        TIMEOUT
      );

      test(
        "two layers writing one command at once store it once",
        async () => {
          const { decider, writer, file } = await backend.make();
          const operation = Bun.randomUUIDv7();
          await Promise.all([
            decider.command(address, operation),
            writer.command(address, operation),
          ]);
          expect((await decider.readCommand(operation)).status).toBe("FOUND");
          expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
        },
        TIMEOUT
      );
    }
  });
}

describe("presence guard (jsonl): two Bus layers on one file", () => {
  /** A Bus whose next admit first runs `before`, the seam that interleaves two layers. */
  const busOn = (file: string, seam: { before?: (() => Promise<void>) | undefined }) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bus-guard-bus-"));
    const ledger = Layer.effect(
      Ledger,
      Effect.map(Ledger, (inner) =>
        Ledger.of({
          ...inner,
          admit: (message, basis) =>
            Effect.flatMap(
              Effect.promise(async () => {
                const before = seam.before;
                seam.before = undefined;
                await before?.();
              }),
              () => inner.admit(message, basis)
            ),
        })
      )
    ).pipe(Layer.provideMerge(layerJsonl(file).pipe(Layer.provide(platform))));
    const runtime = ManagedRuntime.make(
      Bus.layer("test-installation").pipe(
        Layer.provideMerge(ledger),
        Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
        Layer.provide(platform)
      )
    );
    runtimes.push(runtime);
    const join_ = (session: string) =>
      runtime.runPromise(
        Effect.match(
          Effect.flatMap(Bus.Bus, (bus) =>
            bus.join({ address, runtime: "claude", session, cwd: process.cwd() })
          ),
          {
            onFailure: (error) => ({
              ok: false as const,
              error: error as { _tag?: string; message?: string },
            }),
            onSuccess: () => ({ ok: true as const }),
          }
        )
      );
    const peer = () =>
      runtime.runPromise(
        Effect.map(
          Effect.flatMap(Bus.Bus, (bus) => bus.peers),
          (peers) => peers.find((p) => p.address === address)
        )
      );
    return { join: join_, peer };
  };

  test(
    "two free claims: the loser is refused naming the winner's join",
    async () => {
      const file = join(mkdtempSync(join(tmpdir(), "agent-bus-guard-")), "ledger.jsonl");
      const seam: { before?: (() => Promise<void>) | undefined } = {};
      const a = busOn(file, seam);
      const b = busOn(file, {});
      let winner: Awaited<ReturnType<typeof b.join>> | undefined;
      seam.before = async () => {
        winner = await b.join("session:b");
      };
      const loser = await a.join("session:a");

      expect(winner?.ok).toBe(true);
      const held = await b.peer();
      expect(held?.presence.session).toBe("session:b");
      expect(loser.ok).toBe(false);
      if (loser.ok) return;
      expect(loser.error._tag).toBe("NotOwner");
      expect(loser.error.message).toContain(`"${held?.joinId}"`);
    },
    TIMEOUT
  );
});
