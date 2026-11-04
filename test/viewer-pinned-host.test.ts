// The browser traversal against the viewer's real host and RPC client, with an injected reader:
// what RPCLink actually raises reaches the traversal's classifier, and the fit reservation holds
// on the path the traversal sends.
import { expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { createViewer } from "../viewer/server/host.ts";
import { ObservationReader } from "../viewer/server/reader.ts";
import type { ViewerClient } from "../viewer/shared/client-types.ts";
import { MAX_CONTINUATION_LENGTH, MAX_REQUEST_BYTES } from "../viewer/shared/limits.ts";
import type {
  InvestigationPage,
  InvestigationPageInput,
  InvestigationReference,
} from "../viewer/shared/public.ts";
import { requestBytes } from "../viewer/shared/request-size.ts";
import {
  createPinnedTraversal,
  type TraversalSnapshot,
} from "../viewer/src/features/pinned/traversal.ts";

const reference: InvestigationReference = {
  name: "history",
  catalogueVersion: 1,
  ledger: "fixture-ledger",
  t: 9,
  criteria: { kinds: ["message"], direction: "forward" },
};
const row = (id: string) => ({
  t: 5,
  message: {
    id,
    ts: "2026-11-01T12:00:00.000Z",
    from: "fixture/a",
    to: ["#review"],
    kind: "message" as const,
    body: id,
  },
});
const finalPage = (id: string): InvestigationPage => ({
  entries: [row(id)],
  omitted: 0,
  damaged: 0,
  damagedTotal: 0,
  exhausted: true,
  complete: true,
});

/** A viewer whose reader is `page`, and a traversal factory reading through its RPC client. */
const hosted = (page: (input: InvestigationPageInput) => Effect.Effect<InvestigationPage>) => {
  const runtime = ManagedRuntime.make(
    Layer.succeed(
      ObservationReader,
      ObservationReader.of({
        history: () => Effect.die("unused"),
        peers: () => Effect.die("unused"),
        thread: () => Effect.die("unused"),
        investigationPage: page,
      })
    )
  );
  const viewer = createViewer({ port: 0, busPort: 1, assets: new Map(), runtime });
  const client: ViewerClient = createORPCClient(new RPCLink({ url: new URL("/rpc", viewer.url) }));
  const traversal = (value: InvestigationReference) =>
    createPinnedTraversal({
      reference: value,
      readPage: (input, signal) => client.investigationPage(input, { signal }),
      busyRetryMillis: 10,
    });
  return { viewer, traversal };
};
const until = async (
  traversal: ReturnType<ReturnType<typeof hosted>["traversal"]>,
  done: (snapshot: TraversalSnapshot) => boolean
) => {
  while (!done(traversal.getSnapshot())) await Bun.sleep(2);
  return traversal.getSnapshot();
};

test("a rerun after a cancel waits as busy, uncounted, until the cancelled page settles", async () => {
  const gate = Effect.runSync(Deferred.make<void>());
  let reads = 0;
  const { viewer, traversal } = hosted(() => {
    reads++;
    return reads === 1
      ? Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(gate)))
      : Effect.succeed(finalPage("rerun"));
  });
  try {
    const first = traversal(reference);
    first.start();
    while (reads === 0) await Bun.sleep(2);
    first.cancel();
    expect(first.getSnapshot().phase).toEqual({ kind: "ended", end: { kind: "cancelled" } });

    const rerun = traversal(reference);
    rerun.start();
    const busy = await until(rerun, (snapshot) => snapshot.phase.kind === "busy");
    expect([busy.calls, reads]).toEqual([0, 1]);
    Effect.runSync(Deferred.succeed(gate, undefined));
    const done = await until(rerun, (snapshot) => snapshot.phase.kind === "ended");
    expect([done.phase, done.calls, done.progress.entries.length]).toEqual([
      { kind: "ended", end: { kind: "complete" } },
      1,
      1,
    ]);
  } finally {
    Effect.runSync(Deferred.succeed(gate, undefined));
    await viewer.close();
  }
});

test("a reference at exactly the fit sends its longest continuation, and the host admits it", async () => {
  // Multibyte and escaped participants, so characters, JSON length and bytes all differ.
  const at = (padding: number): InvestigationReference => ({
    ...reference,
    criteria: {
      ...reference.criteria,
      participants: [
        '#q"uote',
        "#sl\\ash",
        "#€uro",
        "#😀",
        ...Array.from({ length: 5 }, (_, index) => `#${index}${"f".repeat(500)}`),
        `~${"p".repeat(padding)}`,
      ].sort(),
    },
  });
  const longest = "A".repeat(MAX_CONTINUATION_LENGTH);
  let padding = 0;
  while (requestBytes({ reference: at(padding + 1), cursor: longest }) <= MAX_REQUEST_BYTES) {
    padding++;
  }
  const exact = at(padding);
  expect(requestBytes({ reference: exact, cursor: longest })).toBe(MAX_REQUEST_BYTES);
  const cursors: Array<string | undefined> = [];
  const { viewer, traversal } = hosted((input) => {
    cursors.push(input.cursor);
    return Effect.succeed(
      input.cursor === undefined
        ? {
            entries: [row("first")],
            omitted: 0,
            damaged: 0,
            damagedTotal: 0,
            exhausted: false,
            complete: false,
            next: longest,
          }
        : finalPage("second")
    );
  });
  try {
    const reading = traversal(exact);
    reading.start();
    const done = await until(reading, (snapshot) => snapshot.phase.kind === "ended");
    expect([done.phase, done.calls]).toEqual([{ kind: "ended", end: { kind: "complete" } }, 2]);
    expect(cursors).toEqual([undefined, longest]);
  } finally {
    await viewer.close();
  }
});
