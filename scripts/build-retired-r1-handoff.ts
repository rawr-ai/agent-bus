import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bundle, externalImports, fileSha256, removeOwned } from "./release.ts";

const predecessor = "a32ae0aecb3413e1e04363f464242ae1a9136418";
const tree = "9fdb8fdd151ce11771ab91f92816f4d219e94348";
const repo = resolve(import.meta.dir, "..");
const recipe = "tools/retired-r1/handoff.ts";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "expected-recipe": { type: "string" },
    "git-repo": { type: "string" },
  },
});
const output = values.out;
assert(output && isAbsolute(output), "--out must be an absolute new directory");
const gitRepo = values["git-repo"] ?? repo;
assert(isAbsolute(gitRepo), "--git-repo must be absolute");
const recipeBytes = readFileSync(join(repo, recipe));
const recipeDigest = fileSha256(join(repo, recipe));
assert.match(recipeDigest, /^[0-9a-f]{64}$/);
assert.equal(
  recipeDigest,
  values["expected-recipe"],
  "Use the independently reviewed recipe digest"
);
const bun = realpathSync(process.execPath);
const work = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-r1-verifier-")));
const home = join(work, "home");
const exported = join(work, "source");
const archive = join(work, "a32.tar");
const env = { HOME: home, PATH: `${dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin`, LC_ALL: "C" };
const run = (args: [string, ...string[]], cwd = repo) => {
  const result = spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf8", timeout: 90_000 });
  if (result.status !== 0) throw new Error(`The isolated build step failed: ${args[0]}`);
  return result.stdout.trim();
};
try {
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(exported);
  assert.equal(
    run([
      "git",
      "-C",
      gitRepo,
      "--no-replace-objects",
      "rev-parse",
      "--verify",
      `${predecessor}^{tree}`,
    ]),
    tree
  );
  run([
    "git",
    "-C",
    gitRepo,
    "--no-replace-objects",
    "archive",
    "--format=tar",
    "-o",
    archive,
    predecessor,
  ]);
  run(["/usr/bin/tar", "-xf", archive, "-C", exported]);
  const pkg = JSON.parse(readFileSync(join(exported, "package.json"), "utf8"));
  assert.equal(Bun.version, pkg.engines?.bun);
  assert.equal(pkg.packageManager, `bun@${Bun.version}`);
  run(
    [
      bun,
      "--no-env-file",
      "--config=/dev/null",
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    exported
  );
  mkdirSync(join(exported, dirname(recipe)), { recursive: true });
  writeFileSync(join(exported, recipe), recipeBytes, { flag: "wx" });
  const bundled = join(work, "handoff.js");
  bundle({ src: exported, entry: recipe, outfile: bundled, bun, env });
  assert.deepEqual(externalImports(readFileSync(bundled, "utf8")), []);
  mkdirSync(output, { mode: 0o700 });
  const entry = join(output, "handoff.js");
  copyFileSync(bundled, entry);
  const manifest = join(output, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      predecessor,
      tree,
      recipe: recipeDigest,
      lock: fileSha256(join(exported, "bun.lock")),
      bun: fileSha256(bun),
      entry: fileSha256(entry),
    }),
    { mode: 0o400, flag: "wx" }
  );
  console.log(fileSha256(manifest));
} finally {
  removeOwned(work);
}
