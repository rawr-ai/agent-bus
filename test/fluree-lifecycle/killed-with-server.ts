// Run as a plain script by test/fluree-server.test.ts, which kills it with SIGKILL: starts the
// shared server, reports it, and then runs until killed, so no stop or afterAll can run. It exits
// with its own parent, so a test runner killed outright does not leave it and its server behind.
import { flureeSupervisorPid } from "../fluree-server.ts";
import { childrenOf, exitWithParent } from "../processes.ts";

const supervisor = await flureeSupervisorPid();
console.log(JSON.stringify({ supervisor, children: childrenOf(supervisor) }));
exitWithParent();
