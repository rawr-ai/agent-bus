import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Fluree from "../src/Fluree.ts";
import { ownershipEra } from "../src/FlureePresence.ts";
import { initializeInstallation } from "../src/installation.ts";
import * as Ledger from "../src/Ledger.ts";
import {
  MAILBOX_BOOTSTRAP_COMPLETE_FILE,
  MAILBOX_BOOTSTRAP_SPENT_FILE,
  reserveMailboxBootstrap,
} from "../src/mailbox-bootstrap.ts";
import { captureMailboxSource, verifyMailboxImport } from "../src/mailbox-import.ts";
import {
  acceptMailboxTransitionPeer,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  permitMailboxTransitionServe,
  recordMailboxTransitionReady,
} from "../src/mailbox-transition-admission.ts";
import { installMailboxTransitionGuard } from "../src/mailbox-transition-guard.ts";
import { freshLedger } from "./fluree-server.ts";
import { ownership } from "./processes.ts";
import { spawnSupervised } from "./supervised.ts";

const candidateValues = [
  process.env.AGENT_BUS_CANDIDATE_RELEASE,
  process.env.AGENT_BUS_CANDIDATE_RELEASE_SHA256,
  process.env.AGENT_BUS_CANDIDATE_COMMIT,
  process.env.AGENT_BUS_CANDIDATE_TREE,
] as const;
if (
  candidateValues.some((value) => value !== undefined) &&
  candidateValues.some((value) => !value)
) {
  throw new Error("All four candidate release, digest, commit and tree anchors are required.");
}
let verifiedCandidate: ReadonlyArray<string> | undefined;
const candidateCommand = (home: string): ReadonlyArray<string> => {
  const [root, anchor, commit, tree] = candidateValues;
  if (root === undefined || anchor === undefined || commit === undefined || tree === undefined) {
    return [process.execPath, "--no-env-file", join(import.meta.dir, "../src/bin.ts")];
  }
  if (verifiedCandidate !== undefined) return verifiedCandidate;
  if (
    !isAbsolute(root) ||
    !/^[0-9a-f]{64}$/.test(anchor) ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !/^[0-9a-f]{40}$/.test(tree)
  ) {
    throw new Error("Candidate release anchors are invalid.");
  }
  for (const directory of [root, join(root, "runtime"), join(root, "app")]) {
    if (!lstatSync(directory).isDirectory())
      throw new Error("Candidate release directory is invalid.");
  }
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const manifestPath = join(root, "manifest.json");
  if (!lstatSync(manifestPath).isFile()) throw new Error("Candidate manifest is invalid.");
  const bytes = readFileSync(manifestPath);
  if (digest(bytes) !== anchor)
    throw new Error("Candidate manifest does not match its independent anchor.");
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      commit: Schema.String,
      tree: Schema.String,
      bun: Schema.Struct({ sha256: Schema.String }),
      files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
    })
  )(JSON.parse(bytes.toString("utf8")));
  if (manifest.commit !== commit || manifest.tree !== tree)
    throw new Error("Candidate commit or tree differs from the anchor.");
  for (const name of ["runtime/bun", "app/bunfig.toml", "app/release.js", "app/cli.js"]) {
    const file = join(root, name);
    const entries = manifest.files.filter((entry) => entry.path === name);
    if (
      !lstatSync(file).isFile() ||
      entries.length !== 1 ||
      entries[0] === undefined ||
      digest(readFileSync(file)) !== entries[0].sha256 ||
      (name === "runtime/bun" && manifest.bun.sha256 !== entries[0].sha256)
    ) {
      throw new Error("Candidate bootstrap file does not match its anchored manifest.");
    }
  }
  const bun = join(root, "runtime/bun");
  const bunfig = `--config=${join(root, "app/bunfig.toml")}`;
  const result = Bun.spawnSync(
    [
      bun,
      "--no-env-file",
      bunfig,
      join(root, "app/release.js"),
      "verify",
      root,
      "--expect",
      anchor,
    ],
    {
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    }
  );
  if (
    result.exitCode !== 0 ||
    !Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Boolean }))(
      JSON.parse(result.stdout.toString())
    ).ok
  ) {
    throw new Error("Candidate bundled verification failed.");
  }
  verifiedCandidate = [bun, "--no-env-file", bunfig, join(root, "app/cli.js")];
  return verifiedCandidate;
};

const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);
const prepareLedger = (config: Fluree.FlureeConfig) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger.Ledger;
      return ledger.instance;
    }).pipe(Effect.provide(Fluree.layerFluree(config)), Effect.provide(platform))
  );

const newRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bus-bootstrap-cli-"));
  const bus = join(root, "bus");
  const home = join(root, "home");
  await mkdir(bus);
  await mkdir(home);
  return { root, bus, home, close: () => rm(root, { recursive: true, force: true }) };
};

const createProxy = async (
  provider: string,
  intercept: (
    method: string,
    path: string,
    body: string
  ) => "drop" | "missing" | "redirect" | undefined,
  redirectTo?: string
) => {
  const calls: string[] = [];
  let dropped = false;
  let missing = false;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      calls.push(`${method} ${path}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks);
      const fault = intercept(method, path, requestBody.toString("utf8"));
      if (fault === "redirect") {
        if (redirectTo === undefined) throw new Error("missing test redirect");
        response.writeHead(302, { location: redirectTo });
        response.end();
        return;
      }
      if (fault === "missing") {
        missing = true;
        response.writeHead(404);
        response.end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === "host" || name === "content-length" || value === undefined) continue;
        if (typeof value === "string") headers.set(name, value);
        else for (const item of value) headers.append(name, item);
      }
      const upstream = await fetch(`${provider}${request.url ?? "/"}`, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: requestBody }),
      });
      const body = await upstream.arrayBuffer();
      if (fault === "drop") {
        dropped = true;
        request.socket.destroy();
        return;
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(body));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test proxy did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    wasDropped: () => dropped,
    wasMissing: () => missing,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
};

const setup = async (
  bus: string,
  target: { readonly url: string; readonly ledger: string },
  token: string,
  grant: boolean
) => {
  await Effect.runPromise(
    initializeInstallation(bus, grant ? target : undefined).pipe(Effect.provide(platform))
  );
  await writeFile(join(bus, "config.json"), JSON.stringify({ fluree: target }), { mode: 0o600 });
  await writeFile(join(bus, "fluree-token"), token, { mode: 0o600 });
};

const start = (bus: string, home: string, port = 0, args: ReadonlyArray<string> = ["serve"]) =>
  spawnSupervised([...candidateCommand(home), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      NO_COLOR: "1",
      AGENT_BUS_DIR: bus,
      AGENT_BUS_PORT: String(port),
    },
  });

const refusal = async (bus: string, home: string, args: ReadonlyArray<string> = ["serve"]) => {
  const owned = ownership();
  const child = owned.supervisor(start(bus, home, 0, args));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error("candidate unexpectedly remained running");
    return { code, output: stdout + stderr };
  } finally {
    clearTimeout(timeout);
    await owned.stop();
  }
};

const actualHead = async (config: Fluree.FlureeConfig & { readonly token: string }) => {
  const response = await fetch(
    `${config.url}/v1/fluree/info/${encodeURIComponent(config.ledger)}`,
    {
      headers: { authorization: `Bearer ${config.token}` },
    }
  );
  if (!response.ok) throw new Error("test ledger info failed");
  return Schema.decodeUnknownSync(Schema.Struct({ ledger: Schema.Struct({ t: Schema.Int }) }))(
    await response.json()
  ).ledger.t;
};

const writeCounts = (calls: ReadonlyArray<string>) => ({
  creates: calls.filter((call) => call === "POST /v1/fluree/create").length,
  updates: calls.filter((call) => call === "POST /v1/fluree/update").length,
});

test("partial packaged-candidate selection fails before executing a candidate", async () => {
  const root = await newRoot();
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "test",
        import.meta.path,
        "--test-name-pattern",
        "never-selected",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          HOME: root.home,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          AGENT_BUS_CANDIDATE_RELEASE: "/nonexistent-candidate",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "All four candidate release, digest, commit and tree anchors are required."
    );
  } finally {
    await root.close();
  }
});

for (const lost of ["create", "update"] as const) {
  test(`a lost ${lost} reply never triggers a second create or config write`, async () => {
    const actual = await freshLedger(`bootstrap-lost-${lost}`);
    const root = await newRoot();
    let injected = false;
    const proxy = await createProxy(actual.url, (method, path) => {
      if (!injected && method === "POST" && path === `/v1/fluree/${lost}`) {
        injected = true;
        return "drop";
      }
      return undefined;
    });
    try {
      await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, true);
      const first = await refusal(root.bus, root.home);
      expect(first.code).toBe(1);
      expect(first.output).toContain("operator recovery");
      expect(proxy.wasDropped()).toBe(true);
      expect(await actualHead(actual)).toBe(lost === "create" ? 0 : 1);
      expect(writeCounts(proxy.calls)).toEqual({ creates: 1, updates: lost === "create" ? 0 : 1 });
      const before = writeCounts(proxy.calls);
      const requestsBefore = [...proxy.calls];
      const second = await refusal(root.bus, root.home);
      expect(second.code).toBe(1);
      expect(second.output).toContain("operator recovery");
      expect(writeCounts(proxy.calls)).toEqual(before);
      expect(proxy.calls).toEqual(requestsBefore);
    } finally {
      await proxy.close();
      await root.close();
    }
  }, 40_000);
}

test("a new grant creates once, binds the real incarnation and restarts existing-only", async () => {
  const actual = await freshLedger("bootstrap-created-once");
  const root = await newRoot();
  const proxy = await createProxy(actual.url, () => undefined);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  try {
    await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, true);
    for (let restart = 0; restart < 2; restart++) {
      const owned = ownership();
      const child = owned.supervisor(start(root.bus, root.home, port));
      try {
        let healthy = false;
        for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
          healthy = await fetch(`http://127.0.0.1:${port}/health`).then(
            (r) => r.ok,
            () => false
          );
          if (healthy) break;
          await Bun.sleep(100);
        }
        expect(healthy).toBe(true);
        expect(writeCounts(proxy.calls)).toEqual({ creates: 1, updates: 1 });
      } finally {
        await owned.stop();
      }
    }
    expect(await actualHead(actual)).toBe(1);
    const binding = JSON.parse(
      await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).text()
    );
    const response = await fetch(
      `${actual.url}/v1/fluree/show/${encodeURIComponent(actual.ledger)}?commit=t%3A1`,
      {
        headers: { authorization: `Bearer ${actual.token}` },
      }
    );
    expect(response.ok).toBe(true);
    const original = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      await response.json()
    );
    expect(binding.incarnation).toBe(original.id);
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("an isolated unauthenticated first install initializes before config and starts", async () => {
  const fluree = Bun.which("fluree");
  if (fluree === null) throw new Error("The qualified Fluree executable is required.");
  const root = await newRoot();
  const owned = ownership();
  const providerProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const providerPort = Number(providerProbe.url.port);
  providerProbe.stop(true);
  const serveProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const servePort = Number(serveProbe.url.port);
  serveProbe.stop(true);
  const url = `http://127.0.0.1:${providerPort}`;
  const ledger = `isolated-${process.pid}-${Bun.randomUUIDv7()}:main`;
  try {
    const provider = owned.supervisor(
      spawnSupervised(
        [
          fluree,
          "server",
          "run",
          "--memory",
          "--listen-addr",
          `127.0.0.1:${providerPort}`,
          "--",
          "--cors-enabled=false",
        ],
        {
          env: { HOME: root.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          stdout: "ignore",
          stderr: "ignore",
        }
      )
    );
    let providerReady = false;
    for (let attempt = 0; attempt < 100 && provider.exitCode === null; attempt++) {
      providerReady = await fetch(`${url}/v1/fluree/ledgers`).then(
        (r) => r.ok,
        () => false
      );
      if (providerReady) break;
      await Bun.sleep(100);
    }
    expect(providerReady).toBe(true);
    const initialized = await refusal(root.bus, root.home, [
      "initialize-installation",
      "--fluree-url",
      url,
      "--fluree-ledger",
      ledger,
    ]);
    expect(initialized.code).toBe(0);
    await writeFile(join(root.bus, "config.json"), JSON.stringify({ fluree: { url, ledger } }), {
      mode: 0o600,
    });
    const candidate = owned.supervisor(start(root.bus, root.home, servePort));
    let healthy = false;
    for (let attempt = 0; attempt < 100 && candidate.exitCode === null; attempt++) {
      healthy = await fetch(`http://127.0.0.1:${servePort}/health`).then(
        (r) => r.ok,
        () => false
      );
      if (healthy) break;
      await Bun.sleep(100);
    }
    expect(healthy).toBe(true);
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).exists()).toBe(true);
    expect(await Bun.file(join(root.bus, "fluree-token")).exists()).toBe(false);
  } finally {
    await owned.stop();
    await root.close();
  }
}, 40_000);

test("a concurrent serve cannot pass a targeted reservation before or after identity link", async () => {
  const actual = await freshLedger("bootstrap-reservation");
  const root = await newRoot();
  const proxy = await createProxy(actual.url, () => undefined);
  const id = "00000000-0000-4000-8000-000000000001";
  try {
    const target = { url: proxy.url, ledger: actual.ledger };
    await Effect.runPromise(reserveMailboxBootstrap(root.bus, id, target));
    await writeFile(join(root.bus, "config.json"), JSON.stringify({ fluree: target }), {
      mode: 0o600,
    });
    await writeFile(join(root.bus, "fluree-token"), actual.token, { mode: 0o600 });
    const beforeLink = await refusal(root.bus, root.home);
    expect(beforeLink.code).toBe(1);
    expect(beforeLink.output).toContain("Missing installation-id");
    expect(proxy.calls).toEqual([]);
    await writeFile(join(root.bus, "installation-id"), `${id}\n`, { mode: 0o600 });
    const afterLink = await refusal(root.bus, root.home);
    expect(afterLink.code).toBe(1);
    expect(afterLink.output).toContain("operator recovery");
    expect(proxy.calls).toEqual([]);
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("a born era opens without a full presence-history query", async () => {
  const actual = await freshLedger("bootstrap-born-era");
  const incarnation = await prepareLedger(actual);
  const root = await newRoot();
  const proxy = await createProxy(actual.url, (method, path, body) =>
    method === "POST" &&
    path === "/v1/fluree/query" &&
    body.includes('"@type":"bus:Presence"') &&
    body.includes('"?jt"')
      ? "missing"
      : undefined
  );
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const owned = ownership();
  let child: ReturnType<typeof start> | undefined;
  try {
    await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, false);
    child = owned.supervisor(start(root.bus, root.home, port));
    let healthy = false;
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then(
        (r) => r.ok,
        () => false
      );
      if (healthy) break;
      await Bun.sleep(100);
    }
    expect(healthy).toBe(true);
    const binding = JSON.parse(
      await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).text()
    );
    expect(binding.incarnation).toBe(incarnation);
    expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
  } finally {
    await owned.stop();
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("a migrated era at a later commit cannot replace missing legacy state", async () => {
  const actual = await freshLedger("bootstrap-migrated-era");
  const headers = { authorization: `Bearer ${actual.token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) =>
    fetch(`${actual.url}/v1/fluree${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const created = await post("/create", { ledger: actual.ledger });
  expect(created.status).toBe(201);
  const context = {
    bus: "https://rawr.ai/ns/agent-bus#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
  };
  const seed = await post(`/update?ledger=${encodeURIComponent(actual.ledger)}`, {
    "@context": context,
    insert: { "@id": "urn:fixture:old", "bus:value": "old" },
  });
  expect(seed.status).toBe(200);
  const era = await post(`/update?ledger=${encodeURIComponent(actual.ledger)}`, {
    "@context": context,
    insert: ownershipEra,
  });
  expect(era.status).toBe(200);
  expect(await actualHead(actual)).toBe(2);
  const root = await newRoot();
  const proxy = await createProxy(actual.url, () => undefined);
  try {
    await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, false);
    const result = await refusal(root.bus, root.home);
    expect(result.code).toBe(1);
    expect(result.output).toContain("paired admission is required");
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).exists()).toBe(false);
    expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("a ledger disappearing between precheck and serving open never creates or listens", async () => {
  const actual = await freshLedger("bootstrap-disappeared");
  await prepareLedger(actual);
  const root = await newRoot();
  const proxy = await createProxy(actual.url, (method, path) =>
    method === "GET" &&
    path.startsWith("/v1/fluree/show/") &&
    existsSync(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE))
      ? "missing"
      : undefined
  );
  try {
    await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, false);
    const result = await refusal(root.bus, root.home);
    expect(result.code).toBe(1);
    expect(proxy.wasMissing()).toBe(true);
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).exists()).toBe(true);
    expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("an existing ledger lost after grant spend is never recreated on retry", async () => {
  const actual = await freshLedger("bootstrap-spent-disappeared");
  await prepareLedger(actual);
  const root = await newRoot();
  const proxy = await createProxy(actual.url, (method, path) =>
    method === "GET" &&
    path.startsWith("/v1/fluree/show/") &&
    existsSync(join(root.bus, MAILBOX_BOOTSTRAP_SPENT_FILE))
      ? "missing"
      : undefined
  );
  try {
    await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, true);
    const first = await refusal(root.bus, root.home);
    expect(first.code).toBe(1);
    expect(proxy.wasMissing()).toBe(true);
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).exists()).toBe(false);
    const before = writeCounts(proxy.calls);
    expect(before).toEqual({ creates: 0, updates: 0 });
    const second = await refusal(root.bus, root.home);
    expect(second.code).toBe(1);
    expect(second.output).toContain("operator recovery");
    expect(writeCounts(proxy.calls)).toEqual(before);
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("check-source verifies only the isolated copy and never forwards the live token", async () => {
  const actual = await freshLedger("bootstrap-recovered-copy");
  const incarnation = await prepareLedger(actual);
  const root = await newRoot();
  let originalRequests = 0;
  const original = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      originalRequests++;
      return new Response(null, { status: 500 });
    },
  });
  const recovered = await createProxy(actual.url, () => undefined);
  const redirect = await createProxy(
    actual.url,
    () => "redirect",
    `${original.url.origin}/must-not-receive-token`
  );
  const recoveredConfig = join(root.root, "recovered-config.json");
  const recoveredToken = join(root.root, "recovered-token");
  const liveToken = "original-token-secret";
  try {
    await writeFile(
      join(root.bus, "config.json"),
      JSON.stringify({ fluree: { url: `${original.url.origin}/`, ledger: actual.ledger } })
    );
    await writeFile(join(root.bus, "fluree-token"), liveToken, { mode: 0o600 });
    await writeFile(
      recoveredConfig,
      JSON.stringify({ fluree: { url: recovered.url, ledger: actual.ledger } })
    );
    await writeFile(recoveredToken, actual.token, { mode: 0o600 });
    const args = [
      "mailbox-transition",
      "--action",
      "check-source",
      "--recovered-config",
      recoveredConfig,
      "--recovered-token",
      recoveredToken,
      "--expected-incarnation",
      incarnation,
      "--expected-head",
      "1",
      "--source-commit",
      incarnation,
    ];
    const before = (await readdir(root.bus)).sort();
    const ok = await refusal(root.bus, root.home, args);
    if (ok.code !== 0)
      throw new Error(
        ok.output.replaceAll(actual.token, "[redacted]").replaceAll(liveToken, "[redacted]")
      );
    expect(ok.code).toBe(0);
    expect(ok.output).toContain("verified");
    expect((await readdir(root.bus)).sort()).toEqual(before);
    expect(originalRequests).toBe(0);
    expect(writeCounts(recovered.calls)).toEqual({ creates: 0, updates: 0 });
    expect(await actualHead(actual)).toBe(1);

    const badCid = [...args];
    badCid[badCid.indexOf("--source-commit") + 1] = "wrong-source-cid";
    expect((await refusal(root.bus, root.home, badCid)).code).toBe(1);
    const badHead = [...args];
    badHead[badHead.indexOf("--expected-head") + 1] = "2";
    expect((await refusal(root.bus, root.home, badHead)).code).toBe(1);
    expect(await actualHead(actual)).toBe(1);
    const callsBeforeCredentialRefusals = [...recovered.calls];
    const reusedToken = [...args];
    reusedToken[reusedToken.indexOf("--recovered-token") + 1] = join(root.bus, "fluree-token");
    const reused = await refusal(root.bus, root.home, reusedToken);
    expect(reused.code).toBe(1);
    expect(reused.output).not.toContain(liveToken);
    const missingToken = [...args];
    missingToken[missingToken.indexOf("--recovered-token") + 1] = join(root.root, "missing");
    expect((await refusal(root.bus, root.home, missingToken)).code).toBe(1);
    expect(recovered.calls).toEqual(callsBeforeCredentialRefusals);

    await writeFile(
      recoveredConfig,
      JSON.stringify({ fluree: { url: recovered.url, ledger: "foreign-ledger:main" } })
    );
    expect((await refusal(root.bus, root.home, args)).code).toBe(1);
    expect(recovered.calls).toEqual(callsBeforeCredentialRefusals);
    await writeFile(
      recoveredConfig,
      JSON.stringify({ fluree: { url: original.url.origin, ledger: actual.ledger } })
    );
    expect((await refusal(root.bus, root.home, args)).code).toBe(1);
    await writeFile(
      recoveredConfig,
      JSON.stringify({
        fluree: { url: "http://user:credential-secret@127.0.0.1:9", ledger: actual.ledger },
      })
    );
    const credentialUrl = await refusal(root.bus, root.home, args);
    expect(credentialUrl.code).toBe(1);
    expect(credentialUrl.output).not.toContain("credential-secret");
    await writeFile(
      recoveredConfig,
      JSON.stringify({ fluree: { url: recovered.url, ledger: actual.ledger } })
    );
    await writeFile(recoveredToken, "wrong-token");
    const wrongCredential = await refusal(root.bus, root.home, args);
    expect(wrongCredential.code).toBe(1);
    expect(wrongCredential.output).not.toContain("wrong-token");
    await writeFile(recoveredToken, actual.token);
    await writeFile(
      recoveredConfig,
      JSON.stringify({ fluree: { url: redirect.url, ledger: actual.ledger } })
    );
    expect((await refusal(root.bus, root.home, args)).code).toBe(1);
    expect(originalRequests).toBe(0);
    expect(writeCounts(recovered.calls)).toEqual({ creates: 0, updates: 0 });
    expect(await actualHead(actual)).toBe(1);
    expect((await readdir(root.bus)).sort()).toEqual(before);
  } finally {
    await redirect.close();
    await recovered.close();
    original.stop(true);
    await root.close();
  }
}, 60_000);

const emptyLegacyFixture = async () => {
  const actual = await freshLedger("bootstrap-empty-hostile");
  const headers = { authorization: `Bearer ${actual.token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) =>
    fetch(`${actual.url}/v1/fluree${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  expect((await post("/create", { ledger: actual.ledger })).status).toBe(201);
  expect(
    (
      await post(`/update?ledger=${encodeURIComponent(actual.ledger)}`, {
        "@context": { bus: "https://rawr.ai/ns/agent-bus#" },
        insert: { "@id": "urn:fixture:before-era", "bus:value": "old" },
      })
    ).status
  ).toBe(200);
  const first = await fetch(
    `${actual.url}/v1/fluree/show/${encodeURIComponent(actual.ledger)}?commit=t%3A1`,
    { headers }
  );
  expect(first.ok).toBe(true);
  const sourceCommit = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
    await first.json()
  ).id;
  const cut = { incarnation: sourceCommit, head: 1 };
  const root = await newRoot();
  const peer = join(root.root, "peer");
  const firstCopy = join(root.root, "first-copy");
  const secondCopy = join(root.root, "second-copy");
  const badLocal = join(root.root, "bad-local");
  const badPeer = join(root.root, "bad-peer");
  const proxy = await createProxy(actual.url, () => undefined);
  try {
    const ledgerLayer = Fluree.layerFluree(actual, { existingOnly: true });
    await Effect.runPromise(initializeInstallation(root.bus).pipe(Effect.provide(platform)));
    await Effect.runPromise(initializeInstallation(peer).pipe(Effect.provide(platform)));
    const legacy = (dir: string) =>
      join(dir, "fluree-cursors", encodeURIComponent(actual.ledger), cut.incarnation);
    const emptyHash = Bun.CryptoHasher.hash("sha256", "[]", "hex");
    for (const dir of [root.bus, peer]) {
      await mkdir(`${legacy(dir)}.v2`, { recursive: true });
      await writeFile(
        join(`${legacy(dir)}.v2`, "layout"),
        JSON.stringify({ generation: Bun.randomUUIDv7(), legacy: emptyHash })
      );
    }
    const capture = (dir: string) =>
      Effect.runPromise(
        captureMailboxSource(dir, actual.ledger, cut, Effect.void).pipe(
          Effect.provide(ledgerLayer),
          Effect.provide(platform)
        )
      );
    const firstSource = await capture(root.bus);
    const secondSource = await capture(peer);
    const sources =
      firstSource.installation < secondSource.installation
        ? ([firstSource, secondSource] as const)
        : ([secondSource, firstSource] as const);
    await cp(root.bus, firstCopy, { recursive: true });
    await cp(peer, secondCopy, { recursive: true });
    const copies = [
      { root: firstCopy, receipt: firstSource },
      { root: secondCopy, receipt: secondSource },
    ] as const;
    const operation = Bun.randomUUIDv7();
    const receipt1 = join(root.root, "first-receipt.json");
    const receipt2 = join(root.root, "second-receipt.json");
    await writeFile(receipt1, JSON.stringify(firstSource));
    await writeFile(receipt2, JSON.stringify(secondSource));
    await writeFile(
      join(root.bus, "config.json"),
      JSON.stringify({ fluree: { url: proxy.url, ledger: actual.ledger } }),
      { mode: 0o600 }
    );
    await writeFile(join(root.bus, "fluree-token"), actual.token, { mode: 0o600 });
    const fence = [
      "mailbox-transition",
      "--action",
      "fence",
      "--first-receipt",
      receipt1,
      "--second-receipt",
      receipt2,
      "--operation",
      operation,
      "--expected-local-installation",
      firstSource.installation,
      "--expected-peer-installation",
      secondSource.installation,
      "--expected-incarnation",
      cut.incarnation,
      "--paired-holds-confirmed",
      "--provider-settled",
      "--source-commit",
    ];
    const wrongFence = await refusal(root.bus, root.home, [...fence, "foreign-source-cid"]);
    expect(wrongFence.code).toBe(1);
    expect(wrongFence.output).toContain("captured source commit");
    expect(await Bun.file(join(`${legacy(root.bus)}.v2`, ".export-pending")).exists()).toBe(false);
    expect(await actualHead(actual)).toBe(1);
    expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
    const noHold = await refusal(root.bus, root.home, [...fence, sourceCommit]);
    expect(noHold.code).toBe(1);
    expect(noHold.output).toContain("Cursor transition refused");
    expect(await Bun.file(join(`${legacy(root.bus)}.v2`, ".export-pending")).exists()).toBe(false);
    for (const [dir, item] of [
      [root.bus, firstSource],
      [peer, secondSource],
    ] as const) {
      await Effect.runPromise(
        installMailboxTransitionGuard(
          dir,
          actual.ledger,
          sources,
          item.installation,
          operation,
          Effect.void
        ).pipe(Effect.provide(platform))
      );
    }
    await cp(root.bus, badLocal, { recursive: true });
    await cp(peer, badPeer, { recursive: true });
    const proof = await Effect.runPromise(
      verifyMailboxImport(actual.ledger, copies, firstSource.installation).pipe(
        Effect.provide(ledgerLayer),
        Effect.provide(platform)
      )
    );
    const peerSentinel = join(`${legacy(peer)}.v2`, ".export-pending");
    const common = [
      "--first-receipt",
      receipt1,
      "--second-receipt",
      receipt2,
      "--operation",
      operation,
      "--source-commit",
      sourceCommit,
      "--expected-local-installation",
      firstSource.installation,
      "--expected-peer-installation",
      secondSource.installation,
      "--expected-incarnation",
      cut.incarnation,
      "--paired-holds-confirmed",
      "--provider-settled",
      "--peer-sentinel",
      peerSentinel,
      "--first-state",
      firstCopy,
      "--second-state",
      secondCopy,
    ];
    return {
      actual,
      root,
      proxy,
      peer,
      badLocal,
      badPeer,
      firstSource,
      secondSource,
      sources,
      proof,
      cut,
      operation,
      sourceCommit,
      common,
      ledgerLayer,
    };
  } catch (error) {
    await proxy.close();
    await root.close();
    throw error;
  }
};

const forgeEmptyAdmissions = async (
  fixture: Awaited<ReturnType<typeof emptyLegacyFixture>>,
  left: string,
  right: string,
  sourceCommit: string
) => {
  // The production ready CLI cannot issue this K=H+1 proof before era activation.
  const proof = { ...fixture.proof, verifiedAt: { ...fixture.cut, head: 2 } };
  const checks = { confirmLocalHeld: () => Effect.void, verifyLocalFence: () => Effect.void };
  const one = {
    busDir: left,
    operation: fixture.operation,
    sourceCommit,
    sources: fixture.sources,
    localInstallation: fixture.firstSource.installation,
    proof,
  };
  const two = {
    busDir: right,
    operation: fixture.operation,
    sourceCommit,
    sources: fixture.sources,
    localInstallation: fixture.secondSource.installation,
    proof,
  };
  const oneReady = await Effect.runPromise(
    recordMailboxTransitionReady(one, checks).pipe(Effect.provide(platform))
  );
  const twoReady = await Effect.runPromise(
    recordMailboxTransitionReady(two, checks).pipe(Effect.provide(platform))
  );
  await Effect.runPromise(
    acceptMailboxTransitionPeer(one, twoReady, checks).pipe(Effect.provide(platform))
  );
  await Effect.runPromise(
    acceptMailboxTransitionPeer(two, oneReady, checks).pipe(Effect.provide(platform))
  );
  const oneAdmission = await readFile(
    join(left, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE),
    "utf8"
  );
  const twoAdmission = await readFile(
    join(right, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE),
    "utf8"
  );
  await Effect.runPromise(
    permitMailboxTransitionServe(
      {
        busDir: left,
        ledgerName: fixture.actual.ledger,
        incarnation: fixture.cut.incarnation,
        localInstallation: fixture.firstSource.installation,
      },
      twoAdmission,
      checks
    ).pipe(Effect.provide(platform))
  );
  await Effect.runPromise(
    permitMailboxTransitionServe(
      {
        busDir: right,
        ledgerName: fixture.actual.ledger,
        incarnation: fixture.cut.incarnation,
        localInstallation: fixture.secondSource.installation,
      },
      oneAdmission,
      checks
    ).pipe(Effect.provide(platform))
  );
};

test("an empty legacy plan cannot import, ready or serve without the exact activated era", async () => {
  const f = await emptyLegacyFixture();
  try {
    expect(f.proof.rows).toEqual([]);
    expect(f.proof.verifiedAt.head).toBe(1);
    for (const args of [
      ["mailbox-import", ...f.common],
      ["mailbox-transition", "--action", "ready", ...f.common],
    ]) {
      const result = await refusal(f.root.bus, f.root.home, args);
      expect(result.code).toBe(1);
      expect(result.output).not.toContain("Cursor transition refused");
      expect(await actualHead(f.actual)).toBe(1);
      expect(writeCounts(f.proxy.calls)).toEqual({ creates: 0, updates: 0 });
    }
    await forgeEmptyAdmissions(f, f.root.bus, f.peer, f.sourceCommit);
    await forgeEmptyAdmissions(f, f.badLocal, f.badPeer, "foreign-source-cid");
    const beforeEra = await refusal(f.root.bus, f.root.home);
    expect(beforeEra.code).toBe(1);
    expect(await actualHead(f.actual)).toBe(1);
    expect(writeCounts(f.proxy.calls)).toEqual({ creates: 0, updates: 0 });

    const activation = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Ledger.Ledger).activateOwnershipEra({
          source: f.cut,
          commit: f.sourceCommit,
          operation: f.operation,
        });
      }).pipe(Effect.provide(f.ledgerLayer), Effect.provide(platform))
    );
    expect(activation.status).toBe("APPLIED");
    expect(await actualHead(f.actual)).toBe(2);
    const wrongCommit = [...f.common];
    wrongCommit[wrongCommit.indexOf("--source-commit") + 1] = "foreign-source-cid";
    for (const args of [
      ["mailbox-import", ...wrongCommit],
      ["mailbox-transition", "--action", "ready", ...wrongCommit],
    ]) {
      const result = await refusal(f.root.bus, f.root.home, args);
      expect(result.code).toBe(1);
      expect(result.output).toContain("retained source commit");
      expect(await actualHead(f.actual)).toBe(2);
      expect(writeCounts(f.proxy.calls)).toEqual({ creates: 0, updates: 0 });
    }
    const wrongAdmitted = await refusal(f.badLocal, f.root.home);
    expect(wrongAdmitted.code).toBe(1);
    expect(await actualHead(f.actual)).toBe(2);
    expect(writeCounts(f.proxy.calls)).toEqual({ creates: 0, updates: 0 });

    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(probe.url.port);
    probe.stop(true);
    const owned = ownership();
    const candidate = owned.supervisor(start(f.root.bus, f.root.home, port));
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 100 && candidate.exitCode === null; attempt++) {
        healthy = await fetch(`http://127.0.0.1:${port}/health`).then(
          (r) => r.ok,
          () => false
        );
        if (healthy) break;
        await Bun.sleep(100);
      }
      expect(healthy).toBe(true);
    } finally {
      await owned.stop();
    }
  } finally {
    await f.proxy.close();
    await f.root.close();
  }
}, 60_000);
