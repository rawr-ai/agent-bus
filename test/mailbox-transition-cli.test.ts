import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAILBOX_TRANSITION_EVIDENCE_FILES } from "../src/mailbox-transition-admission.ts";
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
