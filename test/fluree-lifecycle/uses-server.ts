import { appendFileSync } from "node:fs";
import { flureeFetch, flureeSupervisorPid } from "../fluree-server.ts";
import { childrenOf } from "../processes.ts";

/**
 * Records the shared server in FLUREE_PID_FILE under `file`, as one JSON line naming its
 * supervisor and the supervisor's children (the server, read from `ps` rather than reported by
 * the supervisor), then asks the server for its ledgers with the shared token. True when it
 * answered: it is running and is this one.
 */
export const usesServer = async (file: string) => {
  const pidFile = process.env.FLUREE_PID_FILE;
  if (pidFile === undefined) throw new Error("FLUREE_PID_FILE is not set");
  const supervisor = await flureeSupervisorPid();
  appendFileSync(
    pidFile,
    `${JSON.stringify({ file, supervisor, children: childrenOf(supervisor) })}\n`
  );
  return (await flureeFetch("/v1/fluree/ledgers")).ok;
};
