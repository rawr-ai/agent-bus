// Only this supervised fixture process may redirect an admitted public callback to the receiver.
import dns from "node:dns";
import { appendFileSync, readFileSync } from "node:fs";
import type { LookupFunction } from "node:net";
import tls from "node:tls";

const config = JSON.parse(readFileSync(process.argv.at(-1) ?? "", "utf8")) as {
  readonly caPath: string;
  readonly receiverPort: number;
  readonly tracePath: string;
};
const originalConnect = tls.connect.bind(tls);
const address = "93.184.216.34";
const hostname = "receiver.example.test";

dns.lookup = ((
  name: string,
  options: { readonly all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    answers: ReadonlyArray<{ readonly address: string; readonly family: number }>
  ) => void
) => {
  if (name !== hostname || !options?.all) {
    callback(Object.assign(new Error("Fixture DNS refused."), { code: "ENOTFOUND" }), []);
    return;
  }
  appendFileSync(config.tracePath, "lookup\n");
  callback(null, [{ address, family: 4 }]);
}) as typeof dns.lookup;

tls.connect = ((options: tls.ConnectionOptions, ...rest: unknown[]) => {
  if (
    options.host !== hostname ||
    options.servername !== hostname ||
    Number(options.port) !== config.receiverPort ||
    options.rejectUnauthorized !== true ||
    !("autoSelectFamily" in options) ||
    options.autoSelectFamily !== true ||
    typeof options.lookup !== "function"
  )
    throw new Error("Fixture TLS dial refused.");
  const admittedLookup = options.lookup;
  const redirectedLookup: LookupFunction = (name, lookupOptions, callback) => {
    if (name !== hostname || lookupOptions.all !== true)
      throw new Error("Fixture pinned lookup refused.");
    admittedLookup(name, lookupOptions, (error, answers) => {
      if (
        error !== null ||
        !Array.isArray(answers) ||
        answers.length !== 1 ||
        answers[0]?.address !== address ||
        answers[0]?.family !== 4
      )
        throw new Error("Fixture admitted snapshot refused.");
      appendFileSync(config.tracePath, "pinned-lookup\n");
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    });
  };
  appendFileSync(config.tracePath, "admitted-tls-dial\n");
  return Reflect.apply(originalConnect, tls, [
    { ...options, lookup: redirectedLookup, ca: readFileSync(config.caPath) },
    ...rest,
  ]);
}) as typeof tls.connect;
