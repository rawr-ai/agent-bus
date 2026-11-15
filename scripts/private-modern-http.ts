// Qualification-only wire calls: the selected host has no legacy initialize transport.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Schema } from "effect";

export const archiveHash = "90ac182ec316eaff54b787573ca076aea5bd98e346d2f6290945f05a4c244cce";
export const entryHash = "e8b43e25a64d0bf5e70cc4efc358c0d3e4bc7e901706933fe1d026db6d38f8d5";
export const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const manifestSchema = Schema.Struct({
  schema: Schema.Literal("agent-bus-private-peer-review-v2"),
  peerSha256: Schema.String,
  source: Schema.String,
  host: Schema.Struct({
    sourceCommit: Schema.Literal("a1ca3083913b9d9cc0794c1acdf6c682678de1d1"),
    sourceTree: Schema.Literal("074ff06aeea433776af79040f368c9cf2b3377f4"),
    archiveSha256: Schema.Literal(archiveHash),
    entrySha256: Schema.Literal(entryHash),
    bundleSha256: Schema.String,
    effectVersion: Schema.Literal("4.1.4"),
    effectPackageSha256: Schema.Literal(
      "c25c5cec1df1befc27ae354843dc57534e22b76cb93488ddf8042ef520dda9d0"
    ),
  }),
});

export const verifyPrivateBundle = (directory: string) => {
  const manifest = Schema.decodeUnknownSync(manifestSchema, { onExcessProperty: "error" })(
    JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))
  );
  assert.match(manifest.host.effectPackageSha256, /^[a-f0-9]{64}$/);
  assert.equal(digest(join(directory, "main.js")), manifest.peerSha256);
  assert.equal(digest(join(directory, "mcp-host.mjs")), manifest.host.bundleSha256);
  return manifest;
};

export const hostForQualification = (archive: string, parent: string, selectedBundle?: string) => {
  assert.equal(digest(archive), archiveHash, "Wrong host artifact.");
  if (selectedBundle !== undefined) {
    assert(isAbsolute(selectedBundle), "Supply the absolute selected private bundle directory.");
    const manifest = verifyPrivateBundle(selectedBundle);
    console.log(`Selected private host SHA-256: ${manifest.host.bundleSha256}`);
    return join(selectedBundle, "mcp-host.mjs");
  }
  const built = Bun.spawnSync(
    [process.execPath, "--no-env-file", "scripts/build-private-peer.ts", archive, parent],
    { stdout: "pipe", stderr: "inherit" }
  );
  assert(built.success, "Could not build the selected private host.");
  const directory = built.stdout.toString().trim();
  assert(isAbsolute(directory) && directory.startsWith(`${parent}/private-peer-`));
  const manifest = verifyPrivateBundle(directory);
  console.log(`Built private host SHA-256: ${manifest.host.bundleSha256}`);
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
