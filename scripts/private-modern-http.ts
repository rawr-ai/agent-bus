// Qualification-only wire calls: the selected host has no legacy initialize transport.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Schema } from "effect";

export const archiveHash = "90ac182ec316eaff54b787573ca076aea5bd98e346d2f6290945f05a4c244cce";
export const entryHash = "e8b43e25a64d0bf5e70cc4efc358c0d3e4bc7e901706933fe1d026db6d38f8d5";
export const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const hostFields = {
  sourceCommit: Schema.Literal("a1ca3083913b9d9cc0794c1acdf6c682678de1d1"),
  sourceTree: Schema.Literal("074ff06aeea433776af79040f368c9cf2b3377f4"),
  archiveSha256: Schema.Literal(archiveHash),
  entrySha256: Schema.Literal(entryHash),
  bundleSha256: Schema.String,
  effectVersion: Schema.Literal("4.1.4"),
  effectPackageSha256: Schema.Literal(
    "c25c5cec1df1befc27ae354843dc57534e22b76cb93488ddf8042ef520dda9d0"
  ),
};
const inputs = Schema.Struct({ sha256: Schema.String, count: Schema.Number });
const reviewSchema = Schema.Struct({
  schema: Schema.Literal("agent-bus-private-peer-review-v2"),
  peerSha256: Schema.String,
  source: Schema.Literal("working tree; exact source revision not attested"),
  host: Schema.Struct(hostFields),
});
const sourceSchema = Schema.Struct({
  schema: Schema.Literal("agent-bus-private-peer-source-v1"),
  peerSha256: Schema.String,
  peerInputs: inputs,
  host: Schema.Struct({ ...hostFields, inputs }),
  source: Schema.Struct({
    commit: Schema.String,
    tree: Schema.String,
    lockSha256: Schema.String,
    builderSha256: Schema.String,
  }),
  bun: Schema.Struct({ version: Schema.String, revision: Schema.String, sha256: Schema.String }),
});
const manifestSchema = Schema.Union([reviewSchema, sourceSchema]);

export type BundleExpectation = {
  readonly manifestSha256: string;
  readonly source?: { readonly commit: string; readonly tree: string } | undefined;
};

/** A review without an external anchor is usable for development only, never promotion. */
export const verifyPrivateBundle = (directory: string, expected?: BundleExpectation) => {
  assert(isAbsolute(directory), "Supply an absolute bundle directory.");
  const trimmed = directory.replace(/\/+$/u, "");
  const name = basename(trimmed);
  assert(trimmed !== "" && name !== "." && name !== "..", "Bundle path must name a directory.");
  const root = join(realpathSync(dirname(trimmed)), name);
  if (expected !== undefined)
    assert.match(expected.manifestSha256, /^[a-f0-9]{64}$/u, "Invalid external manifest digest.");
  assert(lstatSync(root).isDirectory(), "Bundle directory must not be a symlink.");
  assert.deepEqual(readdirSync(root).sort(), ["main.js", "manifest.json", "mcp-host.mjs"]);
  for (const name of ["main.js", "manifest.json", "mcp-host.mjs"]) {
    const file = lstatSync(join(root, name));
    assert(file.isFile() && file.nlink === 1, "Bundle entries must be independent regular files.");
  }
  if (expected !== undefined)
    assert.equal(
      digest(join(root, "manifest.json")),
      expected.manifestSha256,
      "Manifest anchor differs."
    );
  const manifest = Schema.decodeUnknownSync(manifestSchema, { onExcessProperty: "error" })(
    JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
  );
  const sha = (value: string) => assert.match(value, /^[a-f0-9]{64}$/u);
  sha(manifest.peerSha256);
  sha(manifest.host.bundleSha256);
  if (manifest.schema === "agent-bus-private-peer-source-v1") {
    assert(
      expected?.source,
      "An external digest and independently selected commit and tree are required."
    );
    assert.match(manifest.source.commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.equal(manifest.source.tree.length, manifest.source.commit.length);
    assert.match(manifest.source.tree, /^[a-f0-9]+$/u);
    assert.equal(manifest.source.commit, expected.source.commit, "Selected commit differs.");
    assert.equal(manifest.source.tree, expected.source.tree, "Selected tree differs.");
    for (const value of [
      manifest.source.lockSha256,
      manifest.source.builderSha256,
      manifest.bun.sha256,
      manifest.host.inputs.sha256,
      manifest.peerInputs.sha256,
    ])
      sha(value);
    for (const value of [manifest.host.inputs.count, manifest.peerInputs.count])
      assert(Number.isSafeInteger(value) && value > 0, "Bundle input count is invalid.");
  } else assert.equal(expected?.source, undefined, "An unattested review build is not promotable.");
  assert.equal(digest(join(root, "main.js")), manifest.peerSha256);
  assert.equal(digest(join(root, "mcp-host.mjs")), manifest.host.bundleSha256);
  return manifest;
};

export const hostForQualification = (
  archive: string,
  parent: string,
  selectedBundle?: string,
  expected?: BundleExpectation
) => {
  assert.equal(digest(archive), archiveHash, "Wrong host artifact.");
  if (selectedBundle !== undefined) {
    assert(isAbsolute(selectedBundle), "Supply the absolute selected private bundle directory.");
    const manifest = verifyPrivateBundle(selectedBundle, expected);
    console.log(`Selected ${manifest.schema} host SHA-256: ${manifest.host.bundleSha256}`);
    if (manifest.schema === "agent-bus-private-peer-review-v2")
      console.log("Review bundle only: source is unattested and it is not promotable.");
    return join(selectedBundle, "mcp-host.mjs");
  }
  assert.equal(expected, undefined, "An external bundle anchor needs a selected bundle.");
  const built = Bun.spawnSync(
    [process.execPath, "--no-env-file", "scripts/build-private-peer.ts", archive, parent],
    { stdout: "pipe", stderr: "inherit" }
  );
  assert(built.success, "Could not build the selected private host.");
  const directory = built.stdout.toString().trim();
  assert(isAbsolute(directory) && directory.startsWith(`${parent}/private-peer-`));
  const manifest = verifyPrivateBundle(directory, {
    manifestSha256: digest(join(directory, "manifest.json")),
  });
  assert.equal(manifest.schema, "agent-bus-private-peer-review-v2");
  console.log(`Built nonpromotable review host SHA-256: ${manifest.host.bundleSha256}`);
  return join(directory, "mcp-host.mjs");
};

export const protocolVersion = "2026-07-28";
const routingHeader = (value: string) =>
  /^[\t\x20-\x7e]*$/.test(value) && !value.startsWith("=?base64?")
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
export const modernRequest = (
  endpoint: string | URL,
  clientName: string,
  id: number,
  method: string,
  params: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {}
) =>
  fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(typeof params.name === "string"
        ? { "mcp-name": routingHeader(params.name) }
        : method === "resources/read" && typeof params.uri === "string"
          ? { "mcp-name": routingHeader(params.uri) }
          : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: clientName, version: "1.0.0" },
          ...(typeof params._meta === "object" && params._meta !== null ? params._meta : {}),
        },
      },
    }),
  });

const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
export const modernHttp = (
  endpoint: string | URL,
  clientName: string,
  headers: Readonly<Record<string, string>>,
  serverInfo: { readonly name: string; readonly version: string }
) => {
  let sequence = 0;
  const request = async <T>(
    message: { readonly method: string; readonly params: Readonly<Record<string, unknown>> },
    resultSchema: { readonly parse: (input: unknown) => T }
  ): Promise<T> => {
    const id = ++sequence;
    const response = await modernRequest(
      endpoint,
      clientName,
      id,
      message.method,
      message.params,
      headers
    );
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, id);
    if (body.error !== undefined) {
      const error = record(body.error);
      assert.equal(typeof error.code, "number");
      assert.equal(typeof error.message, "string");
      throw Object.assign(new Error(String(error.message)), error);
    }
    const result = record(body.result);
    assert.equal(result.resultType, "complete");
    assert.deepEqual(record(result._meta)["io.modelcontextprotocol/serverInfo"], serverInfo);
    return resultSchema.parse(result);
  };
  return {
    request,
    discover: () => request({ method: "server/discover", params: {} }, { parse: record }),
    listTools: () => request({ method: "tools/list", params: {} }, ListToolsResultSchema),
    callTool: (params: Readonly<Record<string, unknown>>) =>
      request({ method: "tools/call", params }, CallToolResultSchema),
  };
};

export type ModernHttp = ReturnType<typeof modernHttp>;
