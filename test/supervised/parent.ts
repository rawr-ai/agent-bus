// A parent for test/supervised.test.ts, which kills it with SIGKILL. Starts a supervised
// stand-in, then an unsupervised one, which inherits whatever this process has not marked
// close-on-exec; reports both and never exits on its own. With `die-at-once`, it kills itself
// with SIGKILL as soon as the supervisor is spawned, before that can have started the stand-in.
import { join } from "node:path";
import { spawnSupervised } from "../supervised.ts";

const [dir, mode] = Bun.argv.slice(2);
if (dir === undefined) throw new Error("usage: parent.ts <dir> [die-at-once]");
const standIn = join(import.meta.dir, "stand-in.ts");
const supervised = spawnSupervised([process.execPath, standIn, join(dir, "supervised")]);
if (mode === "die-at-once") process.kill(process.pid, "SIGKILL");
const sibling = Bun.spawn([process.execPath, standIn, join(dir, "sibling")], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
console.log(JSON.stringify({ supervisor: supervised.pid, sibling: sibling.pid }));
setInterval(() => {}, 60_000);
