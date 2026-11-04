// For test/supervised.test.ts: a fixture whose parent is gone before it calls exitWithParent.
// As `parent <dir>`, starts itself as the child, writes the child's pid to `<dir>/child` and
// kills itself with SIGKILL. As `child <dir>`, waits until its parent is gone, as it could be
// during a slow startup, then marks `<dir>/watching` and calls exitWithParent.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitWithParent } from "../processes.ts";

const [role, dir] = Bun.argv.slice(2);
if (dir === undefined) throw new Error("usage: abandoned.ts parent|child <dir>");
if (role === "parent") {
  const child = Bun.spawn([process.execPath, import.meta.path, "child", dir], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  writeFileSync(join(dir, "child"), String(child.pid));
  process.kill(process.pid, "SIGKILL");
} else if (role === "child") {
  // Adopted by init once the parent is gone, which may already be so when this line runs.
  while (process.ppid !== 1) await Bun.sleep(20);
  writeFileSync(join(dir, "watching"), "");
  exitWithParent();
} else {
  throw new Error("usage: abandoned.ts parent|child <dir>");
}
