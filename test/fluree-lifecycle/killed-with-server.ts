// Run as a plain script by test/fluree-server.test.ts, which kills it with SIGKILL: starts the
// shared server, reports it, and then never exits on its own, so no stop or afterAll can run.
import { flureeSupervisorPid } from "../fluree-server.ts";
import { childrenOf } from "../processes.ts";

const supervisor = await flureeSupervisorPid();
console.log(JSON.stringify({ supervisor, children: childrenOf(supervisor) }));
setInterval(() => {}, 60_000);
