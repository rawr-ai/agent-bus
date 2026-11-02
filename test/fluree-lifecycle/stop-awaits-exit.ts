// Run as a plain script by test/fluree-server.test.ts: starts the shared server, stops it, and
// reports whether its process still exists the moment the stop resolves.
import { flureeServerPid, stopFlureeServer } from "../fluree-server.ts";

const pid = await flureeServerPid();
await stopFlureeServer();
let exists = true;
try {
  process.kill(pid, 0);
} catch {
  exists = false;
}
console.log(JSON.stringify({ pid, exists }));
