import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** On macOS, deny a relocated child access to the checkout and installed skill caches. */
export const sourceIsolated = (
  command: ReadonlyArray<string>,
  repo: string,
  extra: ReadonlyArray<string> = []
): string[] => {
  if (process.platform !== "darwin") return [...command];
  const checkout = realpathSync(repo);
  const parent = dirname(checkout);
  const sourceRoot = basename(parent) === "worktrees" ? dirname(parent) : checkout;
  const denied = [
    sourceRoot,
    join(homedir(), ".codex/plugins"),
    join(homedir(), ".codex/skills"),
    join(homedir(), ".claude/plugins"),
    join(homedir(), ".agents/skills"),
    ...extra,
  ];
  const policy = `(version 1)(allow default)${denied
    .map((path) => {
      const actual = existsSync(path) ? realpathSync(path) : resolve(path);
      return `(deny file-read* (subpath ${JSON.stringify(actual)}))`;
    })
    .join("")}`;
  return ["/usr/bin/sandbox-exec", "-p", policy, ...command];
};

/** Prove the isolation profile actually refuses a known file in the source tree. */
export const sourceIsolationRefusesRead = (
  repo: string,
  extra: ReadonlyArray<string> = [],
  additionalProbes: ReadonlyArray<string> = []
): boolean => {
  if (process.platform !== "darwin") return false;
  return [join(repo, "src/skill.ts"), ...additionalProbes].every((probe) => {
    const file = realpathSync(probe);
    readFileSync(file);
    const result = Bun.spawnSync(sourceIsolated(["/bin/cat", file], repo, extra), {
      stdout: "ignore",
      stderr: "pipe",
    });
    return (
      !result.success && /Operation not permitted|Permission denied/u.test(result.stderr.toString())
    );
  });
};
