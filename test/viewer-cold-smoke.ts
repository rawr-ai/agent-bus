// Run after viewer:build. This process uses only a synthetic modern MCP endpoint.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Schema } from "effect";
import type { ViewerClient } from "../viewer/shared/client-types.ts";

const RequestSchema = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.Unknown,
});
const CallSchema = Schema.Struct({ name: Schema.String });
const methods: string[] = [];
const calls: string[] = [];
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const input = Schema.decodeUnknownSync(RequestSchema)(await request.json());
    methods.push(input.method);
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: input.id, result });
    if (input.method === "server/discover") {
      return reply({
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: "private",
      });
    }
    if (input.method === "tools/list") {
      return reply({
        ttlMs: 0,
        cacheScope: "private",
        tools: ["bus_history", "bus_peers"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      });
    }
    if (input.method !== "tools/call") return new Response("Refused", { status: 400 });
    const call = Schema.decodeUnknownSync(CallSchema)(input.params);
    calls.push(call.name);
    return reply({
      content: [],
      structuredContent:
        call.name === "bus_history"
          ? {
              messages: [
                {
                  id: "cold-fixture",
                  ts: "2026-11-01T12:00:00.000Z",
                  from: "fixture/a",
                  to: ["*"],
                  kind: "message",
                  body: "Synthetic cold artifact smoke",
                },
              ],
            }
          : { peers: [] },
    });
  },
});
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const viewerPort = reserve.port;
await reserve.stop(true);
if (viewerPort === undefined) throw new Error("Could not reserve fixture port");
const child = Bun.spawn([process.execPath, "--no-env-file", "dist/viewer/main.js"], {
  env: {
    PATH: process.env.PATH ?? "",
    AGENT_BUS_PORT: String(upstream.port),
    AGENT_BUS_VIEWER_PORT: String(viewerPort),
  },
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
});
const deadline = setTimeout(() => {
  child.kill("SIGTERM");
}, 5_000);
let exitStatus: number | undefined;
try {
  const reader = child.stdout.getReader();
  const initial = await reader.read();
  reader.releaseLock();
  if (initial.done || !new TextDecoder().decode(initial.value).includes("Agent Bus viewer:")) {
    throw new Error("Cold viewer did not start");
  }
  const url = `http://127.0.0.1:${viewerPort}`;
  const page = await fetch(url);
  const html = await page.text();
  if (page.status !== 200 || !html.includes("<script")) throw new Error("Built HTML missing");
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  if (asset === undefined || !(await fetch(new URL(asset, url))).ok)
    throw new Error("Built script unavailable");
  const rejected = await fetch(url, { headers: { origin: "http://hostile.invalid" } });
  if (rejected.status !== 403) throw new Error("Cold asset Origin guard missing");
  const client: ViewerClient = createORPCClient(new RPCLink({ url: `${url}/rpc` }));
  if ((await client.history({ limit: 50 })).messages[0]?.id !== "cold-fixture")
    throw new Error("Cold history failed");
  if ((await client.peers({})).peers.length !== 0) throw new Error("Cold peers failed");
  if (
    calls.join(",") !== "bus_history,bus_peers" ||
    methods.some((method) => !["server/discover", "tools/list", "tools/call"].includes(method))
  ) {
    throw new Error("Cold upstream boundary widened");
  }
  console.log(
    "Cold viewer: built HTML/assets, Origin guard, modern history/peers and typed DTOs passed."
  );
} finally {
  clearTimeout(deadline);
  child.kill("SIGINT");
  exitStatus = await child.exited;
  await upstream.stop(true);
}
if (exitStatus !== 0) throw new Error("Cold viewer did not shut down cleanly");
