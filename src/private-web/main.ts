import { isAbsolute } from "node:path";
import { runPrivatePeer } from "./service.ts";

export { clerkPeerResolver } from "./identity.ts";
export { servePeer } from "./program.ts";
export { decodeServiceConfig, hostConfig, runPrivatePeer } from "./service.ts";

if (import.meta.main) {
  const configFile = process.argv[2];
  if (configFile === undefined || !isAbsolute(configFile) || process.argv.length !== 3) {
    console.error("Supply one absolute private peer configuration path.");
    process.exitCode = 1;
  } else {
    try {
      const hostPath = new URL("./mcp-host.mjs", import.meta.url).href;
      const host: unknown = await import(hostPath);
      if (
        typeof host !== "object" ||
        host === null ||
        !("serveTools" in host) ||
        typeof host.serveTools !== "function"
      )
        throw new Error("Host unavailable.");
      const serveTools = host.serveTools;
      await runPrivatePeer({
        configFile,
        runHost: (config, tools, lifecycle) => serveTools(config, tools, lifecycle),
      });
    } catch {
      console.error("Private peer could not start or complete.");
      process.exitCode = 1;
    }
  }
}
