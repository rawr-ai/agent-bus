import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localToolEnvironment, refuseDotEnv } from "./tool-environment.ts";

const root = resolve(import.meta.dir, "..");
await refuseDotEnv(root);
const manifest = await Bun.file(join(root, "package.json")).json();
if (Bun.version !== manifest.engines.bun) throw new Error("Use the repository's pinned Bun");
const version = manifest.devDependencies["@typescript/native"].slice("npm:typescript@".length);
const enhanced = join(root, "node_modules/@effect/tsgo/dist/effect-tsgo.cjs");
const stock = join(root, "node_modules/@typescript/native/bin/tsc");
// Explicit executable paths must work without a hidden Node or shell-tool fallback.
const env = { ...localToolEnvironment(process.env), PATH: "" };
const run = (entry: string, args: string[], cwd: string) => {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", entry, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return { code: child.exitCode, text: child.stdout.toString() + child.stderr.toString() };
};
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
for (const [entry, args, expected] of [
  [stock, [], `Version ${version}`],
  [
    enhanced,
    [`tsc@${version}`],
    `Version ${version}+effect-tsgo.${manifest.devDependencies["@effect/tsgo"]}`,
  ],
] as const) {
  const result = run(entry, [...args, "--version"], root);
  assert(result.code === 0 && result.text.trim() === expected, result.text);
}

const temporary = await mkdtemp(join(tmpdir(), "agent-bus-toolchain-"));
try {
  await mkdir(join(temporary, "src"));
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  await Bun.write(join(temporary, "package.json"), '{"private":true,"type":"module"}\n');
  const control = join(temporary, "src/control.ts");
  const valid = 'import { Effect } from "effect"; export const task = Effect.succeed(1);\n';
  const floating =
    'import { Effect } from "effect"; export const task = Effect.gen(function* () { Effect.succeed(1); return 2; });\n';
  // These scopes are an independent coverage oracle, not imported from the launcher.
  for (const project of [
    "tsconfig.json",
    "viewer/tsconfig.server.json",
    "viewer/tsconfig.browser.json",
    "tsconfig.storybook.json",
    "tsconfig.browser-tests.json",
  ]) {
    const config = join(temporary, "tsconfig.json");
    await Bun.write(
      config,
      JSON.stringify({
        extends: join(root, project),
        files: ["src/control.ts"],
        include: [],
        exclude: [],
      })
    );
    const check = (entry: string) =>
      run(entry, [...(entry === enhanced ? [`tsc@${version}`] : []), "-p", config], temporary);

    await Bun.write(control, valid);
    for (const entry of [stock, enhanced]) {
      const result = check(entry);
      assert(result.code === 0, `${project}: valid control failed: ${result.text}`);
    }
    await Bun.write(control, floating);
    const ordinary = check(stock);
    assert(
      ordinary.code === 0,
      `${project}: control is not valid ordinary TypeScript: ${ordinary.text}`
    );
    const invalid = check(enhanced);
    assert(
      invalid.code !== 0 &&
        invalid.text.includes("TS377001") &&
        invalid.text.includes("effect(floatingEffect)"),
      `${project}: missing typed Effect failure: ${invalid.text}`
    );
    await Bun.write(control, 'export const value: number = "not a number";\n');
    for (const entry of [stock, enhanced]) {
      const result = check(entry);
      assert(
        result.code !== 0 && result.text.includes("TS2322"),
        `${project}: missed type error: ${result.text}`
      );
    }
    await Bun.write(control, valid);
    const repaired = check(enhanced);
    assert(repaired.code === 0, `${project}: corrected control failed: ${repaired.text}`);
    console.log(`PASS: ${project}: native type errors, typed Effect error and corrected code`);
  }

  assert(manifest.patchedDependencies === undefined, "Obsolete linter patch registration remains");
  const advisorySource = join(temporary, "src/advisory.ts");
  await Bun.write(
    advisorySource,
    'import { Effect } from "effect"; export const task = Effect.flatMap(Effect.succeed(1), (x) => Effect.flatMap(Effect.succeed(x), (y) => Effect.succeed(y)));\n'
  );
  const advisory = run(
    join(root, "node_modules/@biomejs/biome/bin/biome"),
    ["lint", "--config-path=biome.effect.json", advisorySource],
    root
  );
  assert(
    advisory.text.includes("Nested Effect.flatMap callbacks obscure their order"),
    `Advisory upstream linter rule did not run: ${advisory.text}`
  );
  console.log("PASS: upstream advisory Effect rule executes without the retired patch");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
