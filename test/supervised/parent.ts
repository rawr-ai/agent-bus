// A parent for test/supervised.test.ts, which kills it with SIGKILL. Starts a supervised
// stand-in, then an unsupervised one, which inherits whatever this process has not marked
// close-on-exec and exits some time after this process; reports both and exits only with its
// own parent. With `die-at-once`, it writes the supervisor's pid and kills itself with SIGKILL as
// soon as the supervisor is spawned, usually before that has started the stand-in.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitWithParent } from "../processes.ts";
import { spawnSupervised } from "../supervised.ts";

const [dir, mode] = Bun.argv.slice(2);
if (dir === undefined) throw new Error("usage: parent.ts <dir> [die-at-once]");
const standIn = join(import.meta.dir, "stand-in.ts");
const supervised = spawnSupervised([process.execPath, standIn, join(dir, "supervised")]);
if (mode === "die-at-once") {
  writeFileSync(join(dir, "supervisor"), String(supervised.pid));
  process.kill(process.pid, "SIGKILL");
}
const sibling = Bun.spawn([process.execPath, standIn, join(dir, "sibling"), "with-parent"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
console.log(JSON.stringify({ supervisor: supervised.pid, sibling: sibling.pid }));
exitWithParent();
