import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Fluree from "../src/Fluree.ts";
import { initializeInstallation } from "../src/installation.ts";
import { Ledger } from "../src/Ledger.ts";
import { captureMailboxSource, verifyMailboxImport } from "../src/mailbox-import.ts";
import {
  acceptMailboxTransitionPeer,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  MAILBOX_TRANSITION_EVIDENCE_FILES,
  permitMailboxTransitionServe,
  recordMailboxTransitionReady,
} from "../src/mailbox-transition-admission.ts";
import { installMailboxTransitionGuard } from "../src/mailbox-transition-guard.ts";
import { QueryGateway } from "../src/Query.ts";
import { freshLedger } from "./fluree-server.ts";
import { ownership } from "./processes.ts";
import { spawnSupervised } from "./supervised.ts";

const operation = "01940000-0000-7000-8000-000000000001";
const identity = "00000000-0000-4000-8000-000000000001";
const anchor = [
  "--expected-local-installation",
  identity,
  "--expected-peer-installation",
  "00000000-0000-4000-8000-000000000002",
  "--expected-incarnation",
  "test-incarnation",
];
const common = [
  "--first-receipt",
  "first",
  "--second-receipt",
  "second",
  "--operation",
  operation,
  ...anchor,
];
const holds = ["--paired-holds-confirmed", "--provider-settled"];

const cli = async (args: ReadonlyArray<string>, dir?: string) => {
  const home = dir ?? mkdtempSync(join(tmpdir(), "agent-bus-cli-home-"));
  const owned = ownership();
  const child = owned.supervisor(
    spawnSupervised([process.execPath, join(import.meta.dir, "../src/bin.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        NO_COLOR: "1",
        AGENT_BUS_DIR: home,
        AGENT_BUS_PORT: "0",
      },
    })
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 3_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error("CLI did not exit before its supervised timeout");
    return { code, output: stdout + stderr };
  } finally {
    clearTimeout(timer);
    await owned.stop();
    if (dir === undefined) rmSync(home, { recursive: true, force: true });
  }
};

test("transition requires separately attested paired holds and provider settlement", async () => {
  for (const [flags, expected] of [
    [[], "--paired-holds-confirmed"],
    [["--paired-holds-confirmed"], "--provider-settled"],
  ] as const) {
    const result = await cli(["mailbox-transition", "--action", "fence", ...common, ...flags]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(expected);
  }
});

test("check-source requires its isolated files and complete external cut", async () => {
  const cases = [
    { flags: [], expected: "--recovered-config" },
    { flags: ["--recovered-config", "copy"], expected: "--recovered-token" },
    {
      flags: ["--recovered-config", "copy", "--recovered-token", "copy-token"],
      expected: "--expected-incarnation",
    },
    {
      flags: [
        "--recovered-config",
        "copy",
        "--recovered-token",
        "copy-token",
        "--expected-incarnation",
        "instance",
      ],
      expected: "--source-commit",
    },
    {
      flags: [
        "--recovered-config",
        "copy",
        "--recovered-token",
        "copy-token",
        "--expected-incarnation",
        "instance",
        "--source-commit",
        "cid",
      ],
      expected: "--expected-head",
    },
  ];
  for (const { flags, expected } of cases) {
    const result = await cli(["mailbox-transition", "--action", "check-source", ...flags]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(expected);
  }
});

test("transition action-specific flags and retained UUIDv7 are required before local operations", async () => {
  const cases = [
    { action: "fence", extra: [], expected: "--source-commit" },
    { action: "ready", extra: [], expected: "--first-state" },
    { action: "ready", extra: ["--first-state", "one"], expected: "--second-state" },
    {
      action: "ready",
      extra: ["--first-state", "one", "--second-state", "two"],
      expected: "--peer-sentinel",
    },
    {
      action: "admit",
      extra: ["--first-state", "one", "--second-state", "two", "--peer-sentinel", "peer"],
      expected: "--peer-ready",
    },
    { action: "permit", extra: [], expected: "--peer-sentinel" },
    { action: "permit", extra: ["--peer-sentinel", "peer"], expected: "--peer-admitted" },
    { action: "era", extra: [], expected: "--peer-sentinel" },
    { action: "era", extra: ["--peer-sentinel", "peer"], expected: "--source-commit" },
    {
      action: "ready",
      extra: ["--first-state", "one", "--second-state", "two", "--peer-sentinel", "peer"],
      expected: "--source-commit",
    },
    {
      action: "admit",
      extra: [
        "--first-state",
        "one",
        "--second-state",
        "two",
        "--peer-sentinel",
        "peer",
        "--peer-ready",
        "ready",
      ],
      expected: "--source-commit",
    },
    {
      action: "permit",
      extra: ["--peer-sentinel", "peer", "--peer-admitted", "admitted"],
      expected: "--source-commit",
    },
  ];
  for (const { action, extra, expected } of cases) {
    const result = await cli([
      "mailbox-transition",
      "--action",
      action,
      ...common,
      ...holds,
      ...extra,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(expected);
  }
  const badOperation = await cli([
    "mailbox-transition",
    "--action",
    "fence",
    "--first-receipt",
    "first",
    "--second-receipt",
    "second",
    "--operation",
    "not-a-uuid",
    ...anchor,
    ...holds,
  ]);
  expect(badOperation.code).toBe(1);
  expect(badOperation.output).toContain("UUIDv7");
});

test("permit needs no copied roots or ready attestation", async () => {
  const result = await cli([
    "mailbox-transition",
    "--action",
    "permit",
    ...common,
    ...holds,
    "--peer-sentinel",
    "peer",
    "--peer-admitted",
    "peer-admitted",
    "--source-commit",
    "source-cid",
  ]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("has no Fluree ledger");
  expect(result.output).not.toContain("--first-state");
  expect(result.output).not.toContain("--peer-ready");
});

test("import refuses without the operator attestations and required peer evidence", async () => {
  const base = [
    "mailbox-import",
    "--first-state",
    "one",
    "--second-state",
    "two",
    ...common,
    "--source-commit",
    "source-cid",
  ];
  const missingPeer = await cli([...base, ...holds]);
  expect(missingPeer.code).not.toBe(0);
  expect(missingPeer.output).toContain("peer-sentinel");
  const missingHold = await cli([...base, "--peer-sentinel", "peer", "--provider-settled"]);
  expect(missingHold.code).toBe(1);
  expect(missingHold.output).toContain("--paired-holds-confirmed");
  const missingSettlement = await cli([
    ...base,
    "--peer-sentinel",
    "peer",
    "--paired-holds-confirmed",
  ]);
  expect(missingSettlement.code).toBe(1);
  expect(missingSettlement.output).toContain("--provider-settled");
});

const gateFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-transition-cli-"));
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path.startsWith("/v1/fluree/show/")) return Response.json({ id: "test-incarnation" });
      if (path.startsWith("/v1/fluree/exists/")) return Response.json({ exists: false });
      return new Response(null, { status: 503 });
    },
  });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ fluree: { url: server.url.origin, ledger: "test:main" } })
  );
  writeFileSync(join(dir, "installation-id"), identity);
  return {
    dir,
    requests,
    server,
    close: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("transition and import refuse an unknown anchored installation or incarnation before provider access", async () => {
  const fixture = gateFixture();
  try {
    const peer = "00000000-0000-4000-8000-000000000002";
    const unknown = "00000000-0000-4000-8000-000000000009";
    const source = (installation: string) =>
      JSON.stringify({
        version: 1,
        ledger: "test:main",
        installation,
        cut: { incarnation: "test-incarnation", head: 3 },
        capturedAt: 1,
        digest: "a".repeat(64),
      });
    const first = join(fixture.dir, "first-receipt");
    const second = join(fixture.dir, "second-receipt");
    writeFileSync(first, source(identity));
    writeFileSync(second, source(peer));
    for (const [local, remote, incarnation] of [
      [unknown, peer, "test-incarnation"],
      [identity, unknown, "test-incarnation"],
      [identity, peer, "another-incarnation"],
    ] as const) {
      const flags = [
        "--first-receipt",
        first,
        "--second-receipt",
        second,
        "--operation",
        operation,
        "--expected-local-installation",
        local,
        "--expected-peer-installation",
        remote,
        "--expected-incarnation",
        incarnation,
        ...holds,
      ];
      for (const args of [
        ["mailbox-transition", "--action", "fence", "--source-commit", "source-cid", ...flags],
        [
          "mailbox-import",
          "--first-state",
          "one",
          "--second-state",
          "two",
          "--peer-sentinel",
          "peer",
          "--source-commit",
          "source-cid",
          ...flags,
        ],
      ]) {
        const result = await cli(args, fixture.dir);
        expect(result.code).toBe(1);
        expect(result.output).toContain("independent preflight anchor");
      }
    }
    expect(fixture.requests).toEqual([]);
  } finally {
    fixture.close();
  }
});

test("serve refuses a legacy ledger without completed admission before default ledger creation", async () => {
  const fixture = gateFixture();
  try {
    mkdirSync(join(fixture.dir, "fluree-cursors", encodeURIComponent("test:main")), {
      recursive: true,
    });
    const result = await cli(["serve"], fixture.dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("admission");
    expect(fixture.requests).toEqual(["GET /v1/fluree/show/test%3Amain"]);
  } finally {
    fixture.close();
  }
});

test("an empty legacy cursor parent cannot be treated as a fresh installation", async () => {
  const fixture = gateFixture();
  try {
    mkdirSync(join(fixture.dir, "fluree-cursors"));
    const result = await cli(["serve"], fixture.dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("admission");
    expect(fixture.requests).toEqual(["GET /v1/fluree/show/test%3Amain"]);
  } finally {
    fixture.close();
  }
});

test("any dangling admission evidence prevents the fresh-install exception", async () => {
  for (const name of MAILBOX_TRANSITION_EVIDENCE_FILES) {
    const fixture = gateFixture();
    try {
      symlinkSync("missing-target", join(fixture.dir, name));
      const result = await cli(["serve"], fixture.dir);
      expect(result.code).toBe(1);
      expect(result.output).toContain("admission");
      expect(fixture.requests).toEqual(["GET /v1/fluree/show/test%3Amain"]);
    } finally {
      fixture.close();
    }
  }
});

test("serve refuses a symlinked cursor root without contacting the provider", async () => {
  const fixture = gateFixture();
  try {
    symlinkSync("missing-target", join(fixture.dir, "fluree-cursors"));
    const result = await cli(["serve"], fixture.dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("not a real directory");
    expect(fixture.requests).toEqual([]);
  } finally {
    fixture.close();
  }
});

test("a missing ledger is never created for an identity without a grant", async () => {
  const fixture = gateFixture();
  try {
    const result = await cli(["serve"], fixture.dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("no unspent creation grant");
    expect(fixture.requests).toContain("GET /v1/fluree/exists/test%3Amain");
    expect(fixture.requests).not.toContain("POST /v1/fluree/create");
  } finally {
    fixture.close();
  }
});

test("serve requires the historical verification commit even after the head advances", async () => {
  const actual = await freshLedger("transition-verified-commit");
  const root = mkdtempSync(join(tmpdir(), "agent-bus-transition-commit-"));
  const local = join(root, "local");
  const peer = join(root, "peer");
  const localCopy = join(root, "local-copy");
  const peerCopy = join(root, "peer-copy");
  mkdirSync(local);
  mkdirSync(peer);
  const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);
  const ledgerLayer = Fluree.layerFluree(actual, { existingOnly: true });
  const headers = { authorization: `Bearer ${actual.token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) =>
    fetch(`${actual.url}/v1/fluree${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const update = (id: string) =>
    post(`/update?ledger=${encodeURIComponent(actual.ledger)}`, {
      "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
      insert: { "@id": id, "bus:value": "fixture" },
    });
  const pin = () =>
    Effect.runPromise(
      Effect.flatMap(QueryGateway, (gateway) => gateway.pin).pipe(
        Effect.provide(ledgerLayer),
        Effect.provide(platform)
      )
    );
  let mode: "normal" | "missing" | "changed" | "behind" | "after-behind" = "normal";
  const requests: string[] = [];
  let verificationHead = 0;
  let historicalReads = 0;
  let sawHistoricalRead = false;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const historical =
        url.pathname.startsWith("/v1/fluree/show/") &&
        url.searchParams.get("commit") === `t:${verificationHead}`;
      if (historical) {
        historicalReads++;
        sawHistoricalRead = true;
      }
      if (historical && mode === "missing") return new Response(null, { status: 404 });
      const forwarded = new Headers(request.headers);
      forwarded.delete("host");
      forwarded.delete("content-length");
      const upstream = await fetch(`${actual.url}${url.pathname}${url.search}`, {
        method: request.method,
        headers: forwarded,
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: await request.arrayBuffer() }),
      });
      if (upstream.ok && historical && mode === "changed") {
        const commit = Schema.decodeUnknownSync(
          Schema.Struct({ id: Schema.String, t: Schema.Int, parents: Schema.Array(Schema.String) })
        )(await upstream.json());
        const changed = `b${"a".repeat(55)}`;
        return Response.json({
          ...commit,
          id: commit.id === changed ? `b${"b".repeat(55)}` : changed,
        });
      }
      if (
        upstream.ok &&
        url.pathname.startsWith("/v1/fluree/info/") &&
        (mode === "behind" || (mode === "after-behind" && sawHistoricalRead))
      ) {
        return Response.json({ ledger: { t: verificationHead - 1 } });
      }
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    },
  });
  try {
    expect((await post("/create", { ledger: actual.ledger })).status).toBe(201);
    expect((await update("urn:fixture:before-era")).status).toBe(200);
    const source = await pin();
    expect(source.head).toBe(1);
    const sourceCommit = await Effect.runPromise(
      Effect.flatMap(Ledger, (ledger) => ledger.sourceCommitAt(source)).pipe(
        Effect.provide(ledgerLayer),
        Effect.provide(platform)
      )
    );
    for (const dir of [local, peer]) {
      await Effect.runPromise(initializeInstallation(dir).pipe(Effect.provide(platform)));
      const legacy = join(
        dir,
        "fluree-cursors",
        encodeURIComponent(actual.ledger),
        source.incarnation
      );
      mkdirSync(`${legacy}.v2`, { recursive: true });
      writeFileSync(
        join(`${legacy}.v2`, "layout"),
        JSON.stringify({
          generation: Bun.randomUUIDv7(),
          legacy: Bun.CryptoHasher.hash("sha256", "[]", "hex"),
        })
      );
    }
    const capture = (dir: string) =>
      Effect.runPromise(
        captureMailboxSource(dir, actual.ledger, source, Effect.void).pipe(
          Effect.provide(ledgerLayer),
          Effect.provide(platform)
        )
      );
    const first = await capture(local);
    const second = await capture(peer);
    const sources =
      first.installation < second.installation
        ? ([first, second] as const)
        : ([second, first] as const);
    cpSync(local, localCopy, { recursive: true });
    cpSync(peer, peerCopy, { recursive: true });
    for (const [dir, receipt] of [
      [local, first],
      [peer, second],
    ] as const) {
      await Effect.runPromise(
        installMailboxTransitionGuard(
          dir,
          actual.ledger,
          sources,
          receipt.installation,
          operation,
          Effect.void
        ).pipe(Effect.provide(platform))
      );
    }
    const activation = await Effect.runPromise(
      Effect.flatMap(Ledger, (ledger) =>
        ledger.activateOwnershipEra({ source, commit: sourceCommit, operation })
      ).pipe(Effect.provide(ledgerLayer), Effect.provide(platform))
    );
    expect(activation.status).toBe("APPLIED");
    expect((await update("urn:fixture:verification-cut")).status).toBe(200);
    const proof = await Effect.runPromise(
      verifyMailboxImport(
        actual.ledger,
        [
          { root: localCopy, receipt: first },
          { root: peerCopy, receipt: second },
        ],
        first.installation
      ).pipe(Effect.provide(ledgerLayer), Effect.provide(platform))
    );
    expect(proof.rows).toEqual([]);
    verificationHead = proof.verifiedAt.head;
    expect(verificationHead).toBe(3);
    const verifiedCommit = await Effect.runPromise(
      Effect.flatMap(Ledger, (ledger) => ledger.sourceCommitAt(proof.verifiedAt)).pipe(
        Effect.provide(ledgerLayer),
        Effect.provide(platform)
      )
    );
    const checks = { confirmLocalHeld: () => Effect.void, verifyLocalFence: () => Effect.void };
    const base = { operation, sourceCommit, verifiedCommit, sources, proof };
    const one = { ...base, busDir: local, localInstallation: first.installation };
    const two = { ...base, busDir: peer, localInstallation: second.installation };
    const readyOne = await Effect.runPromise(
      recordMailboxTransitionReady(one, checks).pipe(Effect.provide(platform))
    );
    const readyTwo = await Effect.runPromise(
      recordMailboxTransitionReady(two, checks).pipe(Effect.provide(platform))
    );
    await Effect.runPromise(
      acceptMailboxTransitionPeer(one, readyTwo, checks).pipe(Effect.provide(platform))
    );
    await Effect.runPromise(
      acceptMailboxTransitionPeer(two, readyOne, checks).pipe(Effect.provide(platform))
    );
    const peerAdmission = readFileSync(
      join(peer, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE),
      "utf8"
    );
    await Effect.runPromise(
      permitMailboxTransitionServe(
        {
          busDir: local,
          ledgerName: actual.ledger,
          incarnation: source.incarnation,
          localInstallation: first.installation,
        },
        peerAdmission,
        checks
      ).pipe(Effect.provide(platform))
    );
    writeFileSync(
      join(local, "config.json"),
      JSON.stringify({ fluree: { url: proxy.url.origin, ledger: actual.ledger } })
    );
    writeFileSync(join(local, "fluree-token"), actual.token, { mode: 0o600 });
    expect((await update("urn:fixture:after-verification")).status).toBe(200);
    const advanced = await pin();
    expect(advanced.head).toBeGreaterThan(verificationHead);

    for (const failure of ["missing", "changed", "behind", "after-behind"] as const) {
      mode = failure;
      sawHistoricalRead = false;
      const before = historicalReads;
      const result = await cli(["serve"], local);
      expect(result.code).toBe(1);
      expect(result.output).toContain("admission evidence");
      if (failure === "behind") expect(historicalReads).toBe(before);
      else expect(historicalReads).toBeGreaterThan(before);
      expect(await pin()).toEqual(advanced);
      expect(requests.some((entry) => /^POST \/v1\/fluree\/(create|update)/.test(entry))).toBe(
        false
      );
    }

    mode = "normal";
    const readsBeforeStart = historicalReads;
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(probe.url.port);
    probe.stop(true);
    const owned = ownership();
    const child = owned.supervisor(
      spawnSupervised([process.execPath, join(import.meta.dir, "../src/bin.ts"), "serve"], {
        stdout: "ignore",
        stderr: "ignore",
        env: {
          HOME: root,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          NO_COLOR: "1",
          AGENT_BUS_DIR: local,
          AGENT_BUS_PORT: String(port),
        },
      })
    );
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
        healthy = await fetch(`http://127.0.0.1:${port}/health`).then(
          (response) => response.ok,
          () => false
        );
        if (healthy) break;
        await Bun.sleep(100);
      }
      expect(healthy).toBe(true);
      expect(historicalReads).toBeGreaterThanOrEqual(readsBeforeStart + 2);
      expect(await pin()).toEqual(advanced);
      expect(requests.some((entry) => /^POST \/v1\/fluree\/(create|update)/.test(entry))).toBe(
        false
      );
    } finally {
      await owned.stop();
    }
  } finally {
    proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
