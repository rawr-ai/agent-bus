// Only this supervised fixture process may redirect an admitted public callback to the receiver.
import dns from "node:dns";
import { appendFileSync, readFileSync } from "node:fs";
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
    options.host !== address ||
    options.servername !== hostname ||
    Number(options.port) !== config.receiverPort ||
    options.rejectUnauthorized !== true
  )
    throw new Error("Fixture TLS dial refused.");
  appendFileSync(config.tracePath, "admitted-tls-dial\n");
  return Reflect.apply(originalConnect, tls, [
    { ...options, host: "127.0.0.1", ca: readFileSync(config.caPath) },
    ...rest,
  ]);
}) as typeof tls.connect;
