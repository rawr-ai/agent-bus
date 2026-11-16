// Qualify a copied review bundle in a source-independent child against a disposable owning Bus.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, stopFlureeServer } from "../test/fluree-server.ts";
import {
  alive,
  childrenOf,
  exitsWithin,
  type Identity,
  identify,
  ownership,
} from "../test/processes.ts";
import { sourceIsolated, sourceIsolationRefusesRead } from "../test/source-isolation.ts";
import { spawnSupervised } from "../test/supervised.ts";
import { verifyPrivateBundle } from "./private-modern-http.ts";
import { authoredSkill } from "./skill-wire.ts";

const input = process.argv[2];
if (!input || !isAbsolute(input) || process.argv.length !== 3)
  throw new Error("Supply one absolute bundle path.");
verifyPrivateBundle(input);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-relocated-")));
const repo = process.cwd();
let disposeBus: (() => Promise<void>) | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
try {
  if (
    process.platform === "darwin" &&
    !sourceIsolationRefusesRead(
      repo,
      [input],
      [join(input, "main.js"), join(input, "mcp-host.mjs")]
    )
  )
    throw new Error("The relocated peer's source-isolation control failed.");
  console.log(
    process.platform === "darwin"
      ? "Source and original bundle reads denied for relocated children."
      : "Source-read isolation not established on this platform; cwd and HOME relocation only."
  );
  for (let path = dir; ; path = dirname(path)) {
    assert(!existsSync(join(path, "node_modules")), `Node modules ancestor at ${path}`);
    if (path === parse(path).root) break;
  }
  const relocated = join(dir, "consumer");
  mkdirSync(relocated);
  for (const name of ["main.js", "mcp-host.mjs"])
    copyFileSync(join(input, name), join(relocated, name));
  const skillOracle = join(dir, "skill-oracle.json");
  writeFileSync(skillOracle, JSON.stringify(authoredSkill(process.cwd())), { mode: 0o600 });
  const invalidConfig = join(dir, "private-config.json");
  writeFileSync(invalidConfig, "{}\n", { mode: 0o600 });
  const smoke = Bun.spawnSync(
    [process.execPath, "--no-env-file", join(relocated, "main.js"), invalidConfig],
    { cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" }
  );
  assert(!smoke.success);
  assert(smoke.stderr.toString().includes("Private peer could not start or complete."));
  const built = await Bun.build({
    entrypoints: ["./scripts/fixtures/private-peer-relocated.ts"],
    outdir: dir,
    target: "bun",
    format: "esm",
  });
  if (!built.success) throw new Error("Could not build isolated fixture.");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const store = layerFluree(await freshLedger("relocated-peer")).pipe(Layer.provide(platform));
  const bus = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "relocated-peer-fixture" }).pipe(
      Layer.provideMerge(
        Bus.layer("fixture").pipe(
          Layer.provideMerge(store),
          Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
          Layer.provide(platform)
        )
      )
    )
  );
  disposeBus = () => bus.dispose();
  await bus.runPromise(Effect.void);
  const cert = join(dir, "fixture-ca.pem");
  const certKey = join(dir, "fixture-ca-key.pem");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      certKey,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" }
  );
  if (!generated.success)
    throw new Error("Could not make the disposable HTTPS provider certificate.");
  let issuer = "";
  let discoveryRequests = 0;
  const identityRequests = { first: 0, second: 0 };
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(certKey), cert: Bun.file(cert) },
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/openid-configuration") {
        discoveryRequests++;
        return Response.json({
          issuer,
          userinfo_endpoint: `${issuer}/userinfo`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
        });
      }
      if (path === "/userinfo") {
        const token = request.headers.get("authorization");
        if (token === "Bearer synthetic-first") {
          identityRequests.first++;
          return Response.json({ sub: "fixture-first" });
        }
        if (token === "Bearer synthetic-second") {
          identityRequests.second++;
          return Response.json({ sub: "fixture-second" });
        }
      }
      return new Response(null, { status: 401 });
    },
  });
  issuer = `https://127.0.0.1:${provider.port}`;
  const serviceProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const servicePort = Number(serviceProbe.url.port);
  serviceProbe.stop(true);
  const firstGrant = join(dir, "grant-first.json");
  const secondGrant = join(dir, "grant-second.json");
  const keyFile = join(dir, "key.json");
  const tokens = join(dir, "tokens");
  mkdirSync(tokens, { mode: 0o700 });
  const config = {
    schema: "agent-bus-private-web-v2",
    baseUrl: "https://fixture.invalid",
    resource: "https://fixture.invalid/mcp",
    port: servicePort,
    principals: [
      { subject: "fixture-first", grantFile: firstGrant },
      { subject: "fixture-second", grantFile: secondGrant },
    ],
    provider: {
      issuer,
      userInfo: `${issuer}/userinfo`,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
    },
    sessionKeyFile: keyFile,
    binding: "fixture",
    sources: {
      fixture: { port, expectedBusVersion: "relocated-peer-fixture" },
      live: { port: servicePort, expectedBusVersion: "unused" },
    },
    oauth: {
      clientId: "fixture",
      clientSecret: randomBytes(32).toString("hex"),
      jwtSigningKey: randomBytes(32).toString("hex"),
      encryptionKey: randomBytes(32).toString("hex"),
      tokenStorageDir: tokens,
      allowedRedirectUris: ["https://fixture.invalid/callback"],
    },
  };
  const privateConfig = join(dir, "start-config.json");
  writeFileSync(privateConfig, JSON.stringify(config), { mode: 0o600 });
  for (const { subject, grantFile } of config.principals)
    writeFileSync(
      grantFile,
      JSON.stringify({ subject, resource: config.resource, permissions: ["agent-bus:peer"] }),
      { mode: 0o600 }
    );
  writeFileSync(keyFile, JSON.stringify({ key: randomBytes(32).toString("base64url") }), {
    mode: 0o600,
  });
  const eventsKeyFile = join(dir, "events-key.json");
  const eventsPath = join(dir, "events.db");
  writeFileSync(eventsKeyFile, JSON.stringify({ key: randomBytes(32).toString("base64") }), {
    mode: 0o600,
  });
  writeFileSync(eventsPath, "", { mode: 0o600, flag: "wx" });
  const startup = {
    ...config,
    events: {
      storagePath: eventsPath,
      maxBytes: 1_048_576,
      encryptionKeyFile: eventsKeyFile,
    },
  };
  const startupConfig = join(dir, "startup-config.json");
  writeFileSync(startupConfig, JSON.stringify(startup), { mode: 0o600 });
  const bundle: unknown = await import(pathToFileURL(join(relocated, "main.js")).href);
  assert(
    bundle &&
      typeof bundle === "object" &&
      "initializeWatchAuthority" in bundle &&
      typeof bundle.initializeWatchAuthority === "function"
  );
  const initializationCommand = [
    process.execPath,
    "--no-env-file",
    "--config=/dev/null",
    "-e",
    `
      try {
        const { initializeWatchAuthority } = await import(process.argv[1]);
        initializeWatchAuthority(process.argv[2]);
      } catch {
        console.error("Watch authority initialization refused; preserve existing state.");
        process.exitCode = 1;
      }
    `,
    join(relocated, "main.js"),
    startupConfig,
  ];
  const initialization = Bun.spawnSync(initializationCommand, {
    cwd: dir,
    env: { HOME: dir, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(initialization.success, "Bundled offline initialization refused.");
  const watchState = eventsPath + ".watch.sqlite";
  const initializedBytes = readFileSync(watchState);
  const repeatedInitialization = Bun.spawnSync(initializationCommand, {
    cwd: dir,
    env: { HOME: dir, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(repeatedInitialization.exitCode, 1);
  assert.equal(repeatedInitialization.stdout.byteLength, 0);
  assert.equal(
    repeatedInitialization.stderr.toString().trim(),
    "Watch authority initialization refused; preserve existing state."
  );
  assert.deepEqual(readFileSync(watchState), initializedBytes);
  const falseConfig = join(dir, "false-config.json");
  writeFileSync(falseConfig, JSON.stringify({ ...startup, requestDiagnostics: false }), {
    mode: 0o600,
  });
  const diagnosticConfig = join(dir, "diagnostic-config.json");
  writeFileSync(diagnosticConfig, JSON.stringify({ ...startup, requestDiagnostics: true }), {
    mode: 0o600,
  });
  const toolsDiagnosticConfig = join(dir, "tools-diagnostic-config.json");
  writeFileSync(toolsDiagnosticConfig, JSON.stringify({ ...config, requestDiagnostics: true }), {
    mode: 0o600,
  });
  const within = async <T>(work: Promise<T>, milliseconds: number): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), milliseconds);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const diagnosticPrefix = "[mcp-openapi] request-diagnostic ";
  const authorizationPrefix = "[agent-bus] authorization-diagnostic ";
  type StderrReader = {
    read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
  const drainStderr = async (reader: StderrReader) => {
    const bytes = new Uint8Array(65_536);
    let size = 0;
    let overflow = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value === undefined) throw new Error("Diagnostic stream returned no data.");
        const count = Math.min(value.byteLength, bytes.byteLength - size);
        bytes.set(value.subarray(0, count), size);
        size += count;
        if (count < value.byteLength) overflow = true;
      }
      return { text: new TextDecoder().decode(bytes.subarray(0, size)), overflow, failed: false };
    } catch {
      return { text: "", overflow, failed: true };
    } finally {
      reader.releaseLock();
    }
  };
  const probeStartup = async (
    configPath: string,
    expected: { readonly host: boolean; readonly consumer: boolean }
  ) => {
    const owned = ownership();
    const launched = owned.supervisor(
      spawnSupervised(
        sourceIsolated(
          [process.execPath, "--no-env-file", join(relocated, "main.js"), configPath],
          repo,
          [input]
        ),
        {
          cwd: dir,
          env: { HOME: dir, PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: cert },
          stdout: "ignore",
          stderr: "pipe",
        }
      )
    );
    const children = new Map<string, Identity>();
    let supervisorIdentity: Identity | undefined;
    const registerChildren = () => {
      if (supervisorIdentity === undefined || !alive(supervisorIdentity)) return;
      for (const child of childrenOf(launched.pid)) {
        const key = `${child.pid}:${child.started}`;
        if (!children.has(key)) {
          children.set(key, child);
          owned.process(child);
        }
      }
    };
    const discoveryBefore = discoveryRequests;
    let challenged = false;
    let failed = false;
    let reader: StderrReader | undefined;
    let drain: ReturnType<typeof drainStderr> | undefined;
    let captured: Awaited<ReturnType<typeof drainStderr>> | undefined;
    try {
      const streamReader = launched.stderr.getReader();
      reader = streamReader;
      drain = drainStderr(streamReader).catch(() => ({ text: "", overflow: false, failed: true }));
      supervisorIdentity = identify(launched.pid);
      if (supervisorIdentity === undefined) throw new Error("Relocated supervisor did not start.");
      const deadline = Date.now() + 10_000;
      while (children.size === 0 && launched.exitCode === null && Date.now() < deadline) {
        registerChildren();
        if (children.size === 0) await Bun.sleep(20);
      }
      if (children.size === 0) throw new Error("Relocated production child did not start.");
      let ready = false;
      while (!ready && launched.exitCode === null && Date.now() < deadline) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${servicePort}/.well-known/oauth-protected-resource`,
            {
              headers: { host: "fixture.invalid" },
              signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
            }
          );
          await response.arrayBuffer();
          ready = response.status === 200;
        } catch {
          // A listener still starting may refuse the connection.
        }
        if (!ready) await Bun.sleep(100);
      }
      if (!ready) throw new Error("Relocated production listener did not start.");
      const response = await fetch(`http://127.0.0.1:${servicePort}/mcp`, {
        method: "POST",
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "fixture.invalid",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      await response.arrayBuffer();
      challenged = response.status === 401;
      if (!challenged || discoveryRequests <= discoveryBefore)
        throw new Error("Relocated production startup did not require OAuth.");
    } catch {
      failed = true;
    } finally {
      const attempt = async (step: () => Promise<void> | void) => {
        try {
          await step();
        } catch {
          failed = true;
        }
      };
      await attempt(registerChildren);
      await attempt(() => owned.stop());
      await attempt(async () => {
        if ((await within(launched.exited, 2_000)) === undefined) failed = true;
      });
      await attempt(async () => {
        for (const child of children.values())
          if (!(await exitsWithin(child, 2_000))) failed = true;
      });
      await attempt(async () => {
        if (drain === undefined || reader === undefined) {
          failed = true;
          return;
        }
        captured = await within(drain, 2_000);
        if (captured === undefined) {
          failed = true;
          await within(
            reader
              .cancel()
              .catch(() => undefined)
              .then(() => true),
            1_000
          );
          await within(drain, 1_000);
        }
      });
    }
    if (failed || captured === undefined || captured.failed || captured.overflow)
      throw new Error("Relocated production startup or diagnostic capture failed.");
    const hasAdmission = captured.text.split("\n").some((line) => {
      if (!line.startsWith(diagnosticPrefix)) return false;
      try {
        const record: unknown = JSON.parse(line.slice(diagnosticPrefix.length));
        return (
          typeof record === "object" &&
          record !== null &&
          "type" in record &&
          record.type === "admission" &&
          "method" in record &&
          record.method === "POST"
        );
      } catch {
        return false;
      }
    });
    const hasAuthorization = captured.text.split("\n").some((line) => {
      if (!line.startsWith(authorizationPrefix)) return false;
      try {
        const record: unknown = JSON.parse(line.slice(authorizationPrefix.length));
        return (
          typeof record === "object" &&
          record !== null &&
          "type" in record &&
          record.type === "enabled" &&
          "maxRecords" in record &&
          record.maxRecords === 52
        );
      } catch {
        return false;
      }
    });
    if (
      (expected.host ? !hasAdmission : captured.text.includes(diagnosticPrefix)) ||
      (expected.consumer ? !hasAuthorization : captured.text.includes(authorizationPrefix))
    )
      throw new Error("Relocated production diagnostic setting was not observed.");
  };
  await probeStartup(startupConfig, { host: false, consumer: false });
  await probeStartup(falseConfig, { host: false, consumer: false });
  await probeStartup(diagnosticConfig, { host: true, consumer: true });
  const watchPath = `${eventsPath}.watch.sqlite`;
  const parkedWatchPath = `${watchPath}.parked`;
  renameSync(watchPath, parkedWatchPath);
  try {
    await probeStartup(toolsDiagnosticConfig, { host: true, consumer: false });
  } finally {
    renameSync(parkedWatchPath, watchPath);
  }
  writeFileSync(privateConfig, JSON.stringify({ ...startup, requestDiagnostics: true }), {
    mode: 0o600,
  });
  const child = spawnSupervised(
    sourceIsolated(
      [
        process.execPath,
        "--no-env-file",
        join(dir, "private-peer-relocated.js"),
        relocated,
        privateConfig,
        skillOracle,
      ],
      repo,
      [input]
    ),
    {
      cwd: dir,
      env: { HOME: dir, PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: cert },
      stdout: "inherit",
      stderr: "pipe",
    }
  );
  const fixtureReader = child.stderr.getReader();
  const fixtureDrain = drainStderr(fixtureReader).catch(() => ({
    text: "",
    overflow: false,
    failed: true,
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 30_000);
  });
  const status = await Promise.race([child.exited, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  if (status === null) {
    child.kill();
    await child.exited;
  }
  const captured = await within(fixtureDrain, 2_000);
  if (captured === undefined) {
    await within(
      fixtureReader.cancel().catch(() => undefined),
      1_000
    );
    await within(fixtureDrain, 1_000);
  }
  if (status === null) throw new Error("Relocated fixture timed out.");
  if (status !== 0) {
    // Surface fixed guidance failures without forwarding captured wire errors or source frames.
    const guidanceFailure = [
      "Hosted discovery instructions are missing.",
      "Hosted discovery lost essential opening guidance.",
      "Hosted discovery lost identity, wake or recovery guidance.",
      "Hosted catalogue discovery failed.",
      "Hosted join description lost its wake or recovery qualification.",
      "Hosted activity description lost its conditional wake or guarded retry guidance.",
      "Hosted catalogue leaked native-only guidance.",
    ].find((label) =>
      captured?.text.split("\n").some((line) => {
        const message = line.trim();
        return message === `AssertionError: ${label}` || message === `error: ${label}`;
      })
    );
    throw new Error(guidanceFailure ?? "Relocated fixture failed.");
  }
  if (captured === undefined || captured.failed || captured.overflow)
    throw new Error("Relocated callback diagnostic capture failed.");
  const hasCallbackOutcome = captured.text.split("\n").some((line) => {
    if (!line.startsWith(authorizationPrefix)) return false;
    try {
      const record: unknown = JSON.parse(line.slice(authorizationPrefix.length));
      return (
        typeof record === "object" &&
        record !== null &&
        "type" in record &&
        record.type === "authorization" &&
        "callback" in record &&
        record.callback === "subscription" &&
        "outcome" in record &&
        record.outcome === "native_observation_failed"
      );
    } catch {
      return false;
    }
  });
  if (!hasCallbackOutcome)
    throw new Error("Relocated service did not emit a subscription authorization outcome.");
  assert(identityRequests.first > 0 && identityRequests.second > 0);
} finally {
  provider?.stop(true);
  await disposeBus?.();
  await stopFlureeServer();
  rmSync(dir, { recursive: true, force: true });
}
