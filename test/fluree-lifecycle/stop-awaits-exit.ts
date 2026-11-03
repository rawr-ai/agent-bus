// Run as a plain script by test/fluree-server.test.ts: starts the shared server, stops it, and
// reports whether the server process, its supervisor's one child, is still running the moment
// the stop resolves.
import { flureeSupervisorPid, stopFlureeServer } from "../fluree-server.ts";
import { alive, childrenOf } from "../processes.ts";

const supervisor = await flureeSupervisorPid();
const children = childrenOf(supervisor);
await stopFlureeServer();
console.log(JSON.stringify({ supervisor, children, running: children.filter(alive) }));
