// This fixture is bundled separately and run from a directory with no node_modules ancestors.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { InvocationIdentity, ToolInvocation } from "mcp-openapi";
import type * as Identity from "../../src/private-web/identity.ts";
import type * as Service from "../../src/private-web/service.ts";

const [dir, configFile] = process.argv.slice(2);
if (!dir || !configFile) throw new Error("Missing isolated fixture inputs.");
const bundle: unknown = await import(pathToFileURL(join(dir, "main.js")).href);
const isBundle = (value: unknown): value is { runPrivatePeer: typeof Service.runPrivatePeer } =>
  typeof value === "object" &&
  value !== null &&
  "runPrivatePeer" in value &&
  typeof value.runPrivatePeer === "function";
if (!isBundle(bundle)) throw new Error("Invalid peer bundle.");
const host: unknown = await import(pathToFileURL(join(dir, "mcp-host.mjs")).href);
if (
  typeof host !== "object" ||
  host === null ||
  !("serveTools" in host) ||
  typeof host.serveTools !== "function"
)
  throw new Error("Invalid host bundle.");
const serveTools = host.serveTools;
const key = randomBytes(32).toString("hex");
const resource = "https://fixture.invalid/mcp";
const secondGrant = join(dirname(configFile), "grant-second.json");
const abort = new AbortController();
let hostPort = 0;
let checkWatch: ((ticket: string, allowed: boolean) => Promise<void>) | undefined;
const running = bundle.runPrivatePeer({
  configFile,
  signal: abort.signal,
  runHost: async (config, tools, lifecycle) => {
    hostPort = config.port;
    const invocation = (principal: string) => ({
      auth: { authType: "oauth", accessToken: `synthetic-${principal}` },
      signal: abort.signal,
      requestMeta: { "openai/session": "same-conversation" },
    });
    const first = await lifecycle.resolveContext(invocation("first"));
    const second = await lifecycle.resolveContext(invocation("second"));
    assert(first.session && second.session && first.session !== second.session);
    writeFileSync(secondGrant, "{bad", { mode: 0o600 });
    await assert.rejects(lifecycle.resolveContext(invocation("second")), /Peer access denied/);
    assert.deepEqual(await lifecycle.resolveContext(invocation("first")), first);
    writeFileSync(
      secondGrant,
      JSON.stringify({ subject: "fixture-second", resource, permissions: ["agent-bus:peer"] }),
      { mode: 0o600 }
    );
    assert.deepEqual(await lifecycle.resolveContext(invocation("second")), second);
    const { events, ...ordinaryLifecycle } = lifecycle;
    if (events === undefined) throw new Error("Missing production Events program.");
    const eventInvocation: InvocationIdentity = {
      auth: { authType: "oauth", accessToken: "synthetic-first" },
      signal: abort.signal,
      client: { version: undefined },
    };
    const account = await events.resolvePrincipal(eventInvocation);
    checkWatch = async (ticket, allowed) => {
      const scope = await events.authorizeSubscription({
        account,
        event: "mail.wake",
        arguments: { address: "chatgpt/bundle-a", ticket },
        invocation: eventInvocation,
        signal: abort.signal,
      });
      assert.equal(scope !== undefined, allowed);
    };
    // The isolated host uses an API key instead of OAuth; carry its synthetic account to
    // the production tool invocation just as resolveContext does for ordinary tools.
    const fixtureTools = tools.map((tool) => ({
      ...tool,
      execute: (input: unknown, context: ToolInvocation<Identity.PeerActor>) =>
        tool.execute(input, {
          ...context,
          auth:
            context.auth?.authType === "apiKey"
              ? {
                  authType: "oauth",
                  accessToken: `synthetic-${context.requestMeta?.["fixture/principal"]}`,
                }
              : context.auth,
        }),
    }));
    return serveTools({ ...config, serverAuth: { type: "apiKey", key } }, fixtureTools, {
      ...ordinaryLifecycle,
      resolveContext: (value: Identity.PeerInvocation) =>
        lifecycle.resolveContext({
          ...value,
          auth:
            value.auth?.authType === "apiKey"
              ? {
                  authType: "oauth",
                  accessToken: `synthetic-${value.requestMeta?.["fixture/principal"]}`,
                }
              : undefined,
        }),
    });
  },
});
void running.catch(() => undefined);
let client: Client | undefined;
try {
  for (let attempt = 0; attempt < 50 && client === undefined; attempt++) {
    if (hostPort === 0) {
      await Bun.sleep(100);
      continue;
    }
    const candidate = new Client({ name: "relocated-fixture", version: "1.0.0" });
    try {
      await candidate.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hostPort}/mcp`), {
          requestInit: { headers: { "x-api-key": key } },
        })
      );
      client = candidate;
    } catch {
      await candidate.close();
      await Bun.sleep(100);
    }
  }
  assert(client);
  const connected = client;
  const call = async (name: string, args: Record<string, unknown>, principal: string) => {
    await Bun.sleep(300);
    return connected.callTool({
      name,
      arguments: args,
      _meta: { "openai/session": "same-conversation", "fixture/principal": principal },
    });
  };
  const success = async (name: string, args: Record<string, unknown>, principal: string) => {
    const result = await call(name, args, principal);
    assert.notEqual(result.isError, true);
    return result.structuredContent;
  };
  await success("bus_join", { address: "chatgpt/bundle-a" }, "first");
  await success("bus_join", { address: "chatgpt/bundle-b" }, "second");
  const prepared = await call("bus_prepare_watch", { address: "chatgpt/bundle-a" }, "first");
  assert.notEqual(prepared.isError, true);
  const value = prepared.structuredContent;
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert(Object.keys(value).sort().join(",") === "arguments,event");
  assert("event" in value && "arguments" in value && value.event === "mail.wake");
  const args = value.arguments;
  assert(args && typeof args === "object" && !Array.isArray(args));
  assert(Object.keys(args).sort().join(",") === "address,ticket");
  assert("address" in args && args.address === "chatgpt/bundle-a");
  assert(
    "ticket" in args && typeof args.ticket === "string" && /^[A-Za-z0-9_-]{22}$/.test(args.ticket)
  );
  assert(Array.isArray(prepared.content));
  const text = prepared.content[0];
  assert(text && typeof text === "object" && "text" in text && typeof text.text === "string");
  assert(JSON.stringify(JSON.parse(text.text)) === JSON.stringify(value));
  assert(checkWatch);
  await checkWatch(args.ticket, true);
  const sent = await success(
    "bus_publish",
    { from: "chatgpt/bundle-b", to: ["chatgpt/bundle-a"], body: "relocated body" },
    "second"
  );
  assert.equal((await call("bus_read", { address: "chatgpt/bundle-a" }, "second")).isError, true);
  const received = await success("bus_read", { address: "chatgpt/bundle-a" }, "first");
  assert(typeof sent === "object" && sent !== null && "id" in sent);
  assert(
    typeof received === "object" &&
      received !== null &&
      "messages" in received &&
      Array.isArray(received.messages)
  );
  assert.equal(received.messages[0]?.id, sent.id);
  assert.equal(received.messages[0]?.body, "relocated body");
  await success("bus_leave", { address: "chatgpt/bundle-a" }, "first");
  await checkWatch(args.ticket, false);
  console.log("Relocated runPrivatePeer and exact host two-principal fixture passed.");
} finally {
  await client?.close();
  abort.abort();
  await running.catch(() => undefined);
}
