// Qualify a copied review bundle in a source-independent child against a disposable owning Bus.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import { layerFluree } from "../src/Fluree.ts";
import * as Serve from "../src/serve.ts";
import { freshLedger, stopFlureeServer } from "../test/fluree-server.ts";
import { spawnSupervised } from "../test/supervised.ts";

const input = process.argv[2];
if (!input || !isAbsolute(input) || process.argv.length !== 3)
  throw new Error("Supply one absolute bundle path.");
const Manifest = Schema.Struct({
  schema: Schema.Literal("agent-bus-private-peer-review-v1"),
  peerSha256: Schema.String,
  source: Schema.String,
  host: Schema.Struct({
    sourceCommit: Schema.String,
    sourceTree: Schema.String,
    archiveSha256: Schema.String,
    entrySha256: Schema.String,
  }),
});
const manifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" })(
  JSON.parse(readFileSync(join(input, "manifest.json"), "utf8"))
);
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
assert.equal(
  manifest.host.archiveSha256,
  "6c6091e6a97d0e75ecf0ec9e03fa4901cc985b2e0d76c6aab52ed3ca1ac82c25"
);
assert.equal(
  manifest.host.entrySha256,
  "d7fdd22e950dfc1c43a5e756692d4306910711a9f3a6187b56fcbcc2fda7041b"
);
assert.equal(digest(join(input, "main.js")), manifest.peerSha256);
assert.equal(digest(join(input, "mcp-host.mjs")), manifest.host.entrySha256);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-relocated-")));
let disposeBus: (() => Promise<void>) | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let launched: ReturnType<typeof spawnSupervised> | undefined;
try {
  for (let path = dir; ; path = dirname(path)) {
    assert(!existsSync(join(path, "node_modules")), `Node modules ancestor at ${path}`);
    if (path === parse(path).root) break;
  }
  const relocated = join(dir, "consumer");
  mkdirSync(relocated);
  for (const name of ["main.js", "mcp-host.mjs"])
    copyFileSync(join(input, name), join(relocated, name));
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
  launched = spawnSupervised(
    [process.execPath, "--no-env-file", join(relocated, "main.js"), privateConfig],
    {
      cwd: dir,
      env: { HOME: dir, PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: cert },
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  let challenged = false;
  let lastStatus = 0;
  const statuses = new Set<number>();
  for (let attempt = 0; attempt < 15 && launched.exitCode === null && !challenged; attempt++) {
    try {
      lastStatus = (
        await fetch(`http://127.0.0.1:${servicePort}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            host: "fixture.invalid",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        })
      ).status;
      challenged = lastStatus === 401;
      statuses.add(lastStatus);
    } catch {
      await Bun.sleep(100);
    }
    if (!challenged) await Bun.sleep(300);
  }
  assert(
    challenged,
    `Relocated production entry did not start and require OAuth (discovery requests: ${discoveryRequests}, HTTP statuses: ${[...statuses].join(",")}).`
  );
  launched.kill();
  await launched.exited;
  launched = undefined;
  const child = spawnSupervised(
    [
      process.execPath,
      "--no-env-file",
      join(dir, "private-peer-relocated.js"),
      relocated,
      privateConfig,
    ],
    {
      cwd: dir,
      env: { HOME: dir, PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: cert },
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 30_000);
  });
  const status = await Promise.race([child.exited, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  if (status === null) {
    child.kill();
    await child.exited;
    throw new Error("Relocated fixture timed out.");
  }
  assert.equal(status, 0);
  assert(identityRequests.first > 0 && identityRequests.second > 0);
} finally {
  if (launched !== undefined) {
    launched.kill();
    await launched.exited;
  }
  provider?.stop(true);
  await disposeBus?.();
  await stopFlureeServer();
  rmSync(dir, { recursive: true, force: true });
}
