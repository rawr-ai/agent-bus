import { appendFileSync } from "node:fs";
import { flureeFetch, flureeServerPid } from "../fluree-server.ts";

/**
 * Records the shared server's pid in FLUREE_PID_FILE under `file`, then asks the server for
 * its ledgers with the shared token. True when it answered: it is running and is this one.
 */
export const usesServer = async (file: string) => {
  const pidFile = process.env.FLUREE_PID_FILE;
  if (pidFile === undefined) throw new Error("FLUREE_PID_FILE is not set");
  appendFileSync(pidFile, `${file} ${await flureeServerPid()}\n`);
  return (await flureeFetch("/v1/fluree/ledgers")).ok;
};
