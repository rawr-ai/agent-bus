import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  MAILBOX_BOOTSTRAP_GRANT_FILE,
  MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE,
  MAILBOX_BOOTSTRAP_SPENT_FILE,
  reserveMailboxBootstrap,
} from "../src/mailbox-bootstrap.ts";
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
  ) => "drop" | "missing" | "redirect" | "conflict" | undefined,
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
      if (fault === "conflict") {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "conflict" }));
        return;
      }
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

const bindingFile = ".serve-binding-v1";

const commitAt = async (config: Fluree.FlureeConfig & { readonly token: string }, head: number) => {
  const response = await fetch(
    `${config.url}/v1/fluree/show/${encodeURIComponent(config.ledger)}?commit=t%3A${head}`,
    { headers: { authorization: `Bearer ${config.token}` } }
  );
  if (!response.ok) throw new Error("fixture commit is unavailable");
  return Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await response.json()).id;
};

const oldNativeCompletion = async (
  bus: string,
  target: { readonly url: string; readonly ledger: string },
  incarnation: string
) => {
  const installation = (await readFile(join(bus, "installation-id"), "utf8")).trim();
  await writeFile(
    join(bus, MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE),
    JSON.stringify({ version: 1, installation, kind: "identity-only-complete" }),
    { mode: 0o600 }
  );
  await writeFile(
    join(bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE),
    JSON.stringify({
      version: 1,
      installation,
      ...target,
      kind: "complete",
      origin: "existing",
      incarnation,
    }),
    { mode: 0o600 }
  );
};

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
    expect(
      await refusal(root.bus, root.home, ["verify-serve-binding", "--allow-first-create"])
    ).toEqual({
      code: 0,
      output: "first-create-reservation-v1\n",
    });
    expect(proxy.calls).toEqual([]);
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
      if (restart === 0) {
        expect(await refusal(root.bus, root.home, ["verify-serve-binding"])).toEqual({
          code: 0,
          output: "serve-binding-v1\n",
        });
        await rm(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE));
        await rm(join(root.bus, MAILBOX_BOOTSTRAP_GRANT_FILE));
        await rm(join(root.bus, MAILBOX_BOOTSTRAP_SPENT_FILE));
      }
    }
    expect(await actualHead(actual)).toBe(1);
    const binding = JSON.parse(await Bun.file(join(root.bus, bindingFile)).text());
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

test("identity-only serve refuses; explicitly attached identity cannot select a new cut after binding loss", async () => {
  const actual = await freshLedger("bootstrap-remote-attach");
  const root = await newRoot();
  let proxy: Awaited<ReturnType<typeof createProxy>> | undefined;
  const owned = ownership();
  const exists = async () => {
    const response = await fetch(
      `${actual.url}/v1/fluree/exists/${encodeURIComponent(actual.ledger)}`,
      { headers: { authorization: `Bearer ${actual.token}` } }
    );
    if (!response.ok) throw new Error("The disposable ledger existence check failed.");
    return Schema.decodeUnknownSync(Schema.Struct({ exists: Schema.Boolean }))(
      await response.json()
    ).exists;
  };
  try {
    proxy = await createProxy(actual.url, () => undefined);
    const initialized = await refusal(root.bus, root.home, ["initialize-installation"]);
    expect(initialized.code).toBe(0);
    const identity = await readFile(join(root.bus, "installation-id"));
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE)).exists()).toBe(
      true
    );
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
    const config = JSON.stringify({ fluree: { url: proxy.url, ledger: actual.ledger } });
    await writeFile(join(root.bus, "config.json"), config, { mode: 0o600 });
    await writeFile(join(root.bus, "fluree-token"), actual.token, { mode: 0o600 });
    expect(await exists()).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await refusal(root.bus, root.home);
      expect(result.code).toBe(1);
      expect(result.output).toContain("No serving binding");
      expect(await exists()).toBe(false);
      expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
      expect(await readFile(join(root.bus, "installation-id"))).toEqual(identity);
      expect(await readFile(join(root.bus, "config.json"), "utf8")).toBe(config);
      expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_SPENT_FILE)).exists()).toBe(false);
      expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).exists()).toBe(false);
    }
    expect(proxy.calls).toEqual([]);

    // Provision the remote ledger independently; attaching still must not create or update it.
    const incarnation = await prepareLedger(actual);
    const update = await fetch(
      `${actual.url}/v1/fluree/update?ledger=${encodeURIComponent(actual.ledger)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${actual.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          insert: { "@id": "urn:fixture:existing", "urn:fixture:note": "after genesis" },
        }),
      }
    );
    expect(update.status).toBe(200);
    const head = await actualHead(actual);
    const commit = await commitAt(actual, head);
    expect(head).toBeGreaterThan(1);
    expect((await refusal(root.bus, root.home)).code).toBe(1);
    const attach = [
      "bind-existing-ledger",
      "--expected-installation",
      identity.toString("utf8").trim(),
      "--expected-incarnation",
      incarnation,
      "--expected-head",
      String(head),
      "--expected-commit",
      commit,
    ];
    const wrong = [...attach.slice(0, -1), incarnation];
    expect((await refusal(root.bus, root.home, wrong)).code).toBe(1);
    expect((await refusal(root.bus, root.home, attach)).code).toBe(0);
    expect((await refusal(root.bus, root.home, attach)).code).toBe(0);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(probe.url.port);
    probe.stop(true);
    const candidate = owned.supervisor(start(root.bus, root.home, port));
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
    expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
    expect(await actualHead(actual)).toBe(head);
    expect(await readFile(join(root.bus, "installation-id"))).toEqual(identity);
    expect(await readFile(join(root.bus, "config.json"), "utf8")).toBe(config);
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
    const bytes = await readFile(join(root.bus, bindingFile), "utf8");
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({
          anchor: Schema.Struct({ head: Schema.Int, commit: Schema.String }),
          incarnation: Schema.String,
        })
      )(JSON.parse(bytes))
    ).toEqual({ anchor: { head, commit }, incarnation });
    await owned.stop();
    const advance = await fetch(
      `${actual.url}/v1/fluree/update?ledger=${encodeURIComponent(actual.ledger)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${actual.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          insert: { "@id": "urn:fixture:recovery", "urn:fixture:note": "later" },
        }),
      }
    );
    expect(advance.ok).toBe(true);
    const recoveryHead = await actualHead(actual);
    expect(recoveryHead).toBe(head + 1);
    const recoveryCommit = await commitAt(actual, recoveryHead);
    const verifyAt = (at: number, cid: string) =>
      refusal(root.bus, root.home, [
        "verify-serve-binding",
        "--expected-recovery-head",
        String(at),
        "--expected-recovery-commit",
        cid,
      ]);
    expect(await verifyAt(recoveryHead, recoveryCommit)).toEqual({
      code: 0,
      output: "serve-binding-v1\n",
    });
    expect((await verifyAt(recoveryHead + 1, recoveryCommit)).code).toBe(1);
    expect((await verifyAt(recoveryHead, commit)).code).toBe(1);
    expect((await verifyAt(1, incarnation)).code).toBe(1);
    expect(await readFile(join(root.bus, bindingFile), "utf8")).toBe(bytes);
    await rm(join(root.bus, bindingFile));
    expect((await refusal(root.bus, root.home)).code).toBe(1);
    expect((await refusal(root.bus, root.home, attach)).code).toBe(1);
    expect(existsSync(join(root.bus, bindingFile))).toBe(false);
    expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
  } finally {
    try {
      await owned.stop();
    } finally {
      try {
        await proxy?.close();
      } finally {
        await root.close();
      }
    }
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
    const target = { url: proxy.url, ledger: actual.ledger };
    await setup(root.bus, target, actual.token, false);
    await oldNativeCompletion(root.bus, target, incarnation);
    expect(await refusal(root.bus, root.home, ["verify-serve-binding"])).toEqual({
      code: 0,
      output: "serve-binding-v1\n",
    });
    expect(existsSync(join(root.bus, bindingFile))).toBe(false);
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
    const binding = JSON.parse(await Bun.file(join(root.bus, bindingFile)).text());
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
    expect(result.output).toContain("No serving binding");
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).exists()).toBe(false);
    const installation = (await readFile(join(root.bus, "installation-id"), "utf8")).trim();
    const genesis = await commitAt(actual, 1);
    const attachAt = (head: number, commit: string) =>
      refusal(root.bus, root.home, [
        "bind-existing-ledger",
        "--expected-installation",
        installation,
        "--expected-incarnation",
        genesis,
        "--expected-head",
        String(head),
        "--expected-commit",
        commit,
      ]);
    // The exact genesis is on this history but predates the active era. Validation must
    // refuse it before spending this fresh identity's only attachment attempt.
    expect((await attachAt(1, genesis)).code).toBe(1);
    expect(existsSync(join(root.bus, MAILBOX_BOOTSTRAP_SPENT_FILE))).toBe(false);
    expect(existsSync(join(root.bus, bindingFile))).toBe(false);
    expect((await attachAt(2, await commitAt(actual, 2))).code).toBe(0);
    expect(writeCounts(proxy.calls)).toEqual({ creates: 0, updates: 0 });
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("a ledger disappearing between precheck and serving open never creates or listens", async () => {
  const actual = await freshLedger("bootstrap-disappeared");
  const incarnation = await prepareLedger(actual);
  const root = await newRoot();
  const proxy = await createProxy(actual.url, (method, path) =>
    method === "GET" &&
    path.startsWith("/v1/fluree/show/") &&
    existsSync(join(root.bus, bindingFile))
      ? "missing"
      : undefined
  );
  try {
    const target = { url: proxy.url, ledger: actual.ledger };
    await setup(root.bus, target, actual.token, false);
    await oldNativeCompletion(root.bus, target, incarnation);
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

test("a positively observed first-create conflict spends the grant without adopting or recreating", async () => {
  const actual = await freshLedger("bootstrap-spent-disappeared");
  await prepareLedger(actual);
  const root = await newRoot();
  const proxy = await createProxy(actual.url, () => undefined);
  try {
    await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, true);
    const first = await refusal(root.bus, root.home);
    expect(first.code).toBe(1);
    expect(first.output).toContain("already exists");
    expect(existsSync(join(root.bus, MAILBOX_BOOTSTRAP_SPENT_FILE))).toBe(true);
    expect(await Bun.file(join(root.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE)).exists()).toBe(false);
    const before = writeCounts(proxy.calls);
    expect(before).toEqual({ creates: 0, updates: 0 });
    const drop = await fetch(`${actual.url}/v1/fluree/drop`, {
      method: "POST",
      headers: { authorization: `Bearer ${actual.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ledger: actual.ledger.replace(/:main$/, ""), hard: true }),
    });
    expect(drop.ok).toBe(true);
    const after = await fetch(
      `${actual.url}/v1/fluree/exists/${encodeURIComponent(actual.ledger)}`,
      { headers: { authorization: `Bearer ${actual.token}` } }
    );
    expect(await after.json()).toMatchObject({ exists: false });
    const requests = [...proxy.calls];
    const second = await refusal(root.bus, root.home);
    expect(second.code).toBe(1);
    expect(second.output).toContain("operator recovery");
    expect(proxy.calls).toEqual(requests);
    expect(writeCounts(proxy.calls)).toEqual(before);
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("provider conflict after absent observation is one dispatch and never an upsert", async () => {
  const actual = await freshLedger("bootstrap-create-conflict");
  const root = await newRoot();
  const proxy = await createProxy(actual.url, (method, path) =>
    method === "POST" && path === "/v1/fluree/create" ? "conflict" : undefined
  );
  try {
    await setup(root.bus, { url: proxy.url, ledger: actual.ledger }, actual.token, true);
    const first = await refusal(root.bus, root.home);
    expect(first.code).toBe(1);
    expect(first.output).toContain("uncertain or conflicted");
    expect(writeCounts(proxy.calls)).toEqual({ creates: 1, updates: 0 });
    const calls = [...proxy.calls];
    const retry = await refusal(root.bus, root.home);
    expect(retry.code).toBe(1);
    expect(proxy.calls).toEqual(calls);
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);

test("an old unspent R1 grant cannot authorize a new store after upgrade", async () => {
  const actual = await freshLedger("bootstrap-old-unspent");
  const root = await newRoot();
  const proxy = await createProxy(actual.url, () => undefined);
  try {
    const target = { url: proxy.url, ledger: actual.ledger };
    await setup(root.bus, target, actual.token, true);
    const installation = (await readFile(join(root.bus, "installation-id"), "utf8")).trim();
    const grantPath = join(root.bus, MAILBOX_BOOTSTRAP_GRANT_FILE);
    const oldGrant = JSON.stringify({ version: 1, installation, ...target, kind: "grant" });
    await writeFile(grantPath, oldGrant, { mode: 0o600 });
    for (const args of [
      ["serve"],
      ["verify-serve-binding", "--allow-first-create"],
      ["initialize-installation", "--fluree-url", target.url, "--fluree-ledger", target.ledger],
    ]) {
      const result = await refusal(root.bus, root.home, args);
      expect(result.code).toBe(1);
      expect(result.output).toContain("operator recovery");
    }
    expect(proxy.calls).toEqual([]);
    expect(await readFile(grantPath, "utf8")).toBe(oldGrant);
    expect(existsSync(join(root.bus, MAILBOX_BOOTSTRAP_SPENT_FILE))).toBe(false);
  } finally {
    await proxy.close();
    await root.close();
  }
}, 40_000);
