// The investigation page procedure through the real host and RPC client, against a fake
// upstream that echoes the arguments it was sent: admission, cancellation, typed failures and
// the request-size boundary. The real bus is covered in viewer-investigation-bus.test.ts.
import { expect, test } from "bun:test";
import { createORPCClient, isDefinedError, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createViewer } from "../viewer/server/host.ts";
import { ObservationReader } from "../viewer/server/reader.ts";
import type { ViewerClient } from "../viewer/shared/client-types.ts";
import { MAX_REQUEST_BYTES } from "../viewer/shared/limits.ts";
import {
  type InvestigationPageInput,
  type InvestigationReference,
  MAX_CONTINUATION_LENGTH,
} from "../viewer/shared/public.ts";
import { referenceFits, requestBytes } from "../viewer/shared/request-size.ts";

const marker = "private-fixture-value-never-disclosed";
const LEDGER = "fixture-ledger";
const AT = 9;
const reference: InvestigationReference = {
  name: "history",
  catalogueVersion: 1,
  ledger: LEDGER,
  t: AT,
  criteria: { participants: ["#review"], kinds: ["message"], direction: "forward" },
};
const message = {
  t: 5,
  id: "fixture-message",
  ts: "2026-11-01T12:00:00.000Z",
  from: "fixture/a",
  to: ["#review"],
  kind: "message",
  body: "Synthetic",
  session: marker,
};
const CallSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.Struct({
    name: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
    t: Schema.optionalKey(Schema.Number),
    cursor: Schema.optionalKey(Schema.String),
  }),
});
const RequestSchema = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

type Mode =
  | "normal"
  | "hold"
  | "other-ledger"
  | "short-limit-after-cursor"
  | "malformed"
  | "tool-error"
  | "outage";

/** A viewer whose upstream answers each call as the bus would, at the arguments it was sent. */
const setup = (timeoutMillis = 2_000) => {
  let mode: Mode = "normal";
  const calls: Array<typeof CallSchema.Type.arguments> = [];
  const held = new Set<() => void>();
  let aborts = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = Schema.decodeUnknownSync(RequestSchema)(await request.json());
      const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: input.id, result });
      if (input.method === "server/discover") {
        return respond({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private",
        });
      }
      if (input.method === "tools/list") {
        return respond({
          ttlMs: 0,
          cacheScope: "private",
          tools: [{ name: "bus_run_query", inputSchema: { type: "object", properties: {} } }],
        });
      }
      const call = Schema.decodeUnknownSync(CallSchema)(input.params).arguments;
      calls.push(call);
      if (mode === "hold") {
        await new Promise<void>((resolve) => {
          const finish = () => {
            held.delete(finish);
            resolve();
          };
          held.add(finish);
          request.signal.addEventListener(
            "abort",
            () => {
              aborts++;
              finish();
            },
            { once: true }
          );
        });
      }
      if (mode === "outage") return new Response(marker, { status: 503 });
      if (mode === "tool-error") {
        return respond({ isError: true, content: [{ type: "text", text: marker }] });
      }
      const args =
        mode === "short-limit-after-cursor" && call.cursor !== undefined
          ? { ...call.args, limit: 50 }
          : call.args;
      const first = call.cursor === undefined;
      return respond({
        content: [],
        structuredContent:
          mode === "malformed"
            ? { name: "history", rows: "invalid" }
            : {
                name: call.name,
                catalogueVersion: 1,
                ledger: mode === "other-ledger" ? "replaced" : LEDGER,
                t: call.t ?? AT,
                unit: "entry",
                args,
                rows: [first ? message : { ...message, id: "second", t: 6 }],
                damage: "checked",
                damaged: 0,
                damagedTotal: 0,
                ...(first && call.name === "history" && call.args.direction !== "backward"
                  ? { exhausted: false, complete: false, next: "bq1.page-2" }
                  : { exhausted: true, complete: true }),
                note: "note",
              },
      });
    },
  });
  const viewer = createViewer({
    port: 0,
    busPort: upstream.port ?? 0,
    timeoutMillis,
    assets: new Map(),
  });
  const client: ViewerClient = createORPCClient(new RPCLink({ url: new URL("/rpc", viewer.url) }));
  return {
    viewer,
    client,
    calls,
    mode: (value: Mode) => {
      mode = value;
    },
    aborts: () => aborts,
    release: () => {
      for (const finish of held) finish();
    },
    /** Resolves once the upstream has received `count` calls in all. */
    reached: async (count: number) => {
      while (calls.length < count) await Bun.sleep(5);
    },
    close: async () => {
      await viewer.close();
      for (const finish of held) finish();
      await upstream.stop(true);
    },
  };
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("expected a failure");
};
/** A live read that the "hold" upstream keeps open. */
const liveRead = (client: ViewerClient) => client.history({ limit: 50 }).catch(() => undefined);

test("one page reads the reference's criteria at its commit, and its continuation", async () => {
  const fixture = setup();
  try {
    const first = await fixture.client.investigationPage({ reference });
    expect(first).toEqual({
      entries: [{ t: 5, message: { ...message, session: undefined } }].map(({ t, message }) => ({
        t,
        message: {
          id: message.id,
          ts: message.ts,
          from: message.from,
          to: message.to,
          kind: "message",
          body: message.body,
        },
      })),
      omitted: 0,
      damaged: 0,
      damagedTotal: 0,
      exhausted: false,
      complete: false,
      next: "bq1.page-2",
    });
    const second = await fixture.client.investigationPage({ reference, cursor: "bq1.page-2" });
    expect(second.entries.map((entry) => entry.message.id)).toEqual(["second"]);
    expect(fixture.calls).toEqual([
      { name: "history", args: { ...reference.criteria, limit: 200 }, t: AT },
      { name: "history", args: { ...reference.criteria, limit: 200 }, t: AT, cursor: "bq1.page-2" },
    ]);
    expect(JSON.stringify([first, second])).not.toContain(marker);
  } finally {
    await fixture.close();
  }
});

test("a reference not in the bus's echoed form is refused before any upstream call", async () => {
  const fixture = setup();
  const criteria = (changes: Record<string, unknown>) => ({
    reference: { ...reference, criteria: { ...reference.criteria, ...changes } },
  });
  try {
    // Valid in shape, but not what the bus echoes: the procedure's own declared refusal.
    for (const input of [
      criteria({ participants: ["b", "a"] }),
      criteria({ participants: ["a", "a"] }),
      criteria({ fromTs: "2026-11-02T00:00:00Z", toTs: "2026-11-01T00:00:00Z" }),
      criteria({ fromTs: "2026-02-30T00:00:00Z" }),
    ]) {
      const error = await failure(
        fixture.client.investigationPage(input as InvestigationPageInput)
      );
      expect([error.status, error.code, error.message, isDefinedError(error)]).toEqual([
        400,
        "BAD_REQUEST",
        "Not a pinned history reference",
        true,
      ]);
    }
    // Invalid in shape: refused by input validation, which carries its own issues.
    for (const input of [
      criteria({ direction: "backward" }),
      criteria({ kinds: ["presence"] }),
      { reference: { ...reference, extra: true } },
      { reference, cursor: 'bq1."' },
      { reference, cursor: "A".repeat(MAX_CONTINUATION_LENGTH + 1) },
    ]) {
      const error = await failure(
        fixture.client.investigationPage(input as InvestigationPageInput)
      );
      expect([error.status, error.code, error.message]).toEqual([
        400,
        "BAD_REQUEST",
        "Input validation failed",
      ]);
    }
    expect(fixture.calls).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("upstream answers become typed failures that never carry bus text", async () => {
  const fixture = setup();
  try {
    const expectations: Array<[Mode, string, number, unknown]> = [
      ["other-ledger", "IDENTITY_MISMATCH", 502, { field: "ledger" }],
      ["malformed", "PAGE_REJECTED", 502, undefined],
      ["tool-error", "BUS_ERROR", 502, undefined],
      ["outage", "UPSTREAM_UNAVAILABLE", 503, undefined],
    ];
    for (const [mode, code, status, data] of expectations) {
      fixture.mode(mode);
      const error = await failure(fixture.client.investigationPage({ reference }));
      expect([error.code, error.status, error.data, isDefinedError(error)]).toEqual([
        code,
        status,
        data,
        true,
      ]);
      expect(JSON.stringify(error)).not.toContain(marker);
    }
    // Every page is checked, the continued ones included.
    fixture.mode("short-limit-after-cursor");
    await fixture.client.investigationPage({ reference });
    const later = await failure(
      fixture.client.investigationPage({ reference, cursor: "bq1.page-2" })
    );
    expect([later.code, later.data]).toEqual(["IDENTITY_MISMATCH", { field: "limit" }]);
  } finally {
    await fixture.close();
  }
});

test("one investigation page leaves seven reads for live observations", async () => {
  const fixture = setup();
  try {
    fixture.mode("hold");
    const investigation = fixture.client.investigationPage({ reference }).catch(() => undefined);
    await fixture.reached(1);
    const busy = await failure(fixture.client.investigationPage({ reference }));
    expect([busy.status, busy.code, isDefinedError(busy)]).toEqual([
      429,
      "TOO_MANY_REQUESTS",
      false,
    ]);
    const live = Array.from({ length: 6 }, () => liveRead(fixture.client));
    await fixture.reached(7);
    // The seventh live read is admitted alongside the investigation page.
    live.push(liveRead(fixture.client));
    await fixture.reached(8);
    // Full: another investigation page is investigation-busy, before host admission.
    const full = await failure(fixture.client.investigationPage({ reference }));
    expect(full.status).toBe(429);
    const overflow = await failure(fixture.client.history({ limit: 50 }));
    expect([overflow.status, isDefinedError(overflow)]).toEqual([503, false]);
    expect(fixture.calls).toHaveLength(8);
    fixture.release();
    await Promise.all([investigation, ...live]);
  } finally {
    await fixture.close();
  }
});

test("a full host refuses an investigation page as busy, not unavailable, and keeps the flag clear", async () => {
  const fixture = setup();
  try {
    fixture.mode("hold");
    const live = Array.from({ length: 8 }, () => liveRead(fixture.client));
    await fixture.reached(8);
    const busy = await failure(fixture.client.investigationPage({ reference }));
    expect([busy.status, busy.code, isDefinedError(busy)]).toEqual([
      429,
      "TOO_MANY_REQUESTS",
      false,
    ]);
    // A live read at the same occupancy keeps its existing 503.
    const live503 = await failure(fixture.client.history({ limit: 50 }));
    expect(live503.status).toBe(503);
    expect(fixture.calls).toHaveLength(8);
    fixture.release();
    await Promise.all(live);
    fixture.mode("normal");
    expect((await fixture.client.investigationPage({ reference })).entries).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("busy, a closing viewer and an upstream outage stay three distinct client failures", async () => {
  const fixture = setup();
  // Calls the host directly, so a request after close() meets the closing viewer, not a socket.
  const direct: ViewerClient = createORPCClient(
    new RPCLink({ url: new URL("/rpc", fixture.viewer.url), fetch: fixture.viewer.fetch })
  );
  try {
    fixture.mode("hold");
    const held = fixture.client.investigationPage({ reference }).catch(() => undefined);
    await fixture.reached(1);
    const busy = await failure(fixture.client.investigationPage({ reference }));
    fixture.release();
    await held;
    fixture.mode("outage");
    const outage = await failure(fixture.client.investigationPage({ reference }));
    await fixture.viewer.close();
    const unavailable = await failure(direct.investigationPage({ reference }));
    expect(
      [busy, unavailable, outage].map((error) => [error.status, error.code, isDefinedError(error)])
    ).toEqual([
      [429, "TOO_MANY_REQUESTS", false],
      [503, "SERVICE_UNAVAILABLE", false],
      [503, "UPSTREAM_UNAVAILABLE", true],
    ]);
  } finally {
    await fixture.close();
  }
});

test("every way an investigation page ends releases admission for the next", async () => {
  const fixture = setup(300);
  const admitted = async () => {
    fixture.mode("normal");
    expect((await fixture.client.investigationPage({ reference })).entries).toHaveLength(1);
  };
  const post = (body: string) =>
    fetch(new URL("/rpc/investigationPage", fixture.viewer.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  try {
    await admitted();
    for (const [mode, status] of [
      ["other-ledger", 502],
      ["malformed", 502],
      ["tool-error", 502],
      ["outage", 503],
      // A held upstream ends at the viewer's deadline.
      ["hold", 504],
    ] as const) {
      fixture.mode(mode);
      expect((await failure(fixture.client.investigationPage({ reference }))).status).toBe(status);
      await admitted();
    }
    expect((await post(JSON.stringify({ json: { reference, extra: 1 } }))).status).toBe(400);
    await admitted();
    expect((await post(" ".repeat(MAX_REQUEST_BYTES + 1))).status).toBe(413);
    await admitted();
    fixture.mode("hold");
    const controller = new AbortController();
    const cancelled = fixture.client.investigationPage(
      { reference },
      { signal: controller.signal }
    );
    const before = fixture.calls.length;
    const abortsBefore = fixture.aborts();
    await fixture.reached(before + 1);
    controller.abort();
    // The cancelled request rejects, and this cancellation, not an earlier one, reaches upstream.
    expect(
      await cancelled.then(
        () => "resolved",
        () => "rejected"
      )
    ).toBe("rejected");
    while (fixture.aborts() === abortsBefore) await Bun.sleep(5);
    await admitted();
  } finally {
    await fixture.close();
  }
});

test("a cancelled page keeps its admission until its handler settles, then a rerun is admitted", async () => {
  // A reader whose cancelled page settles only when the test opens the gate.
  const gate = Effect.runSync(Deferred.make<void>());
  let reads = 0;
  const runtime = ManagedRuntime.make(
    Layer.succeed(
      ObservationReader,
      ObservationReader.of({
        history: () => Effect.die("unused"),
        peers: () => Effect.die("unused"),
        thread: () => Effect.die("unused"),
        investigationPage: () => {
          reads++;
          return reads === 1
            ? Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(gate)))
            : Effect.succeed({
                entries: [],
                omitted: 0,
                damaged: 0,
                damagedTotal: 0,
                exhausted: true,
                complete: true,
              });
        },
      })
    )
  );
  const viewer = createViewer({ port: 0, busPort: 1, assets: new Map(), runtime });
  const client: ViewerClient = createORPCClient(new RPCLink({ url: new URL("/rpc", viewer.url) }));
  try {
    const controller = new AbortController();
    const cancelled = client.investigationPage({ reference }, { signal: controller.signal });
    while (reads === 0) await Bun.sleep(5);
    controller.abort();
    expect(
      await cancelled.then(
        () => "resolved",
        () => "rejected"
      )
    ).toBe("rejected");
    // The client has given up, but the handler has not settled: a rerun is still busy.
    const busy = await failure(client.investigationPage({ reference }));
    expect(busy.status).toBe(429);
    expect(reads).toBe(1);
    Effect.runSync(Deferred.succeed(gate, undefined));
    let rerun: Awaited<ReturnType<ViewerClient["investigationPage"]>> | undefined;
    while (rerun === undefined) {
      rerun = await client.investigationPage({ reference }).catch((error: unknown) => {
        if (error instanceof ORPCError && error.status === 429) return undefined;
        throw error;
      });
    }
    expect(rerun.exhausted).toBe(true);
    expect(reads).toBe(2);
  } finally {
    // Open the gate on every path, or a failed assertion leaves close() waiting on the handler.
    Effect.runSync(Deferred.succeed(gate, undefined));
    await viewer.close();
  }
});

test("a page request of exactly the host's byte limit is admitted, and one byte more is refused", async () => {
  const fixture = setup();
  const sent: number[] = [];
  const recording: ViewerClient = createORPCClient(
    new RPCLink({
      url: new URL("/rpc", fixture.viewer.url),
      fetch: async (request, init) => {
        sent.push((await request.clone().arrayBuffer()).byteLength);
        return fetch(request, init);
      },
    })
  );
  // Multibyte and escaped characters, so bytes, characters and JSON length all differ.
  // Five full-length tokens fill most of the body; the last token pads it to the byte.
  const fixed = [
    '#q"uote',
    "#sl\\ash",
    "#€uro",
    "#😀",
    ...Array.from({ length: 5 }, (_, index) => `#${index}${"f".repeat(510)}`),
  ];
  const cursor = `bq1.${"A".repeat(MAX_CONTINUATION_LENGTH - 4)}`;
  const at = (padding: number): InvestigationPageInput => ({
    reference: {
      ...reference,
      criteria: {
        ...reference.criteria,
        participants: [...fixed, `~${"p".repeat(padding)}`].sort(),
      },
    },
    cursor,
  });
  try {
    let padding = 0;
    while (requestBytes(at(padding + 1)) <= MAX_REQUEST_BYTES) padding++;
    // The padding token stays a valid participant, so the host, not the schema, refuses `over`.
    expect(padding).toBeGreaterThan(0);
    expect(padding + 2).toBeLessThanOrEqual(512);
    const exact = at(padding);
    const over = at(padding + 1);
    expect([requestBytes(exact), requestBytes(over)]).toEqual([
      MAX_REQUEST_BYTES,
      MAX_REQUEST_BYTES + 1,
    ]);
    const page = await recording.investigationPage(exact);
    expect(page.entries).toHaveLength(1);
    expect(fixture.calls).toHaveLength(1);
    const refused = await failure(recording.investigationPage(over));
    expect(refused.status).toBe(413);
    expect(fixture.calls).toHaveLength(1);
    // The recorded bodies, not a recomputation, are the oracle for requestBytes.
    expect(sent).toEqual([MAX_REQUEST_BYTES, MAX_REQUEST_BYTES + 1]);
    expect(referenceFits(exact.reference)).toBe(true);
    expect(referenceFits(over.reference)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("live history still refuses investigation fields", async () => {
  const fixture = setup();
  try {
    for (const input of [
      { limit: 50, cursor: "bq1.x" },
      { limit: 50, t: 3 },
      { limit: 50, reference },
    ]) {
      const error = await failure(fixture.client.history(input as { limit: number }));
      expect(error.status).toBe(400);
    }
    const query = await fetch(new URL("/rpc/investigationPage?x=1", fixture.viewer.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { reference } }),
    });
    const get = await fetch(new URL("/rpc/investigationPage", fixture.viewer.url));
    expect([query.status, get.status]).toEqual([404, 405]);
    expect(fixture.calls).toEqual([]);
  } finally {
    await fixture.close();
  }
});
