// A stand-in long-lived child for test/supervised.test.ts. Writes its pid to the file named by
// its first argument, then runs until signalled. Options: `ignore-term` survives SIGTERM;
// `slow-term` and `slow-int` take a second to exit after SIGTERM or SIGINT; `exit=<code>` exits
// with that code shortly after starting; `env` also writes its environment, as JSON, beside the
// pid file; `with-parent` exits 20 seconds after its parent has, so that a stand-in nothing
// supervises outlives its parent for a test but cannot be left behind by one.
import { writeFileSync } from "node:fs";
import { orphaned } from "../processes.ts";

// Taken before the pid is published, so that a parent lost from then on is noticed.
const parent = process.ppid;
const [pidFile, ...options] = Bun.argv.slice(2);
if (pidFile === undefined) throw new Error("usage: stand-in.ts <pid-file> [options]");
if (options.includes("ignore-term")) process.on("SIGTERM", () => {});
if (options.includes("slow-term"))
  process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1_000));
if (options.includes("slow-int"))
  process.on("SIGINT", () => setTimeout(() => process.exit(0), 1_000));
const exit = options.find((option) => option.startsWith("exit="));
if (options.includes("env")) writeFileSync(`${pidFile}.env`, JSON.stringify(process.env));
writeFileSync(pidFile, String(process.pid));
if (exit !== undefined) setTimeout(() => process.exit(Number(exit.slice(5))), 200);
const timer = setInterval(() => {
  if (options.includes("with-parent") && orphaned(parent)) {
    clearInterval(timer);
    setTimeout(() => process.exit(0), 20_000);
  }
}, 100);
