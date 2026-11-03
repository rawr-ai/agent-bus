// A stand-in long-lived child for test/supervised.test.ts. Writes its pid to the file named by
// its first argument, then runs until signalled. Options: `ignore-term` survives SIGTERM;
// `slow-term` takes a second to exit after SIGTERM; `exit=<code>` exits with that code shortly
// after starting.
import { writeFileSync } from "node:fs";

const [pidFile, ...options] = Bun.argv.slice(2);
if (pidFile === undefined) throw new Error("usage: stand-in.ts <pid-file> [options]");
if (options.includes("ignore-term")) process.on("SIGTERM", () => {});
if (options.includes("slow-term"))
  process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1_000));
const exit = options.find((option) => option.startsWith("exit="));
writeFileSync(pidFile, String(process.pid));
if (exit !== undefined) setTimeout(() => process.exit(Number(exit.slice(5))), 200);
setInterval(() => {}, 60_000);
