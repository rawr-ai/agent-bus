import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localToolEnvironment } from "./tool-environment.ts";

// Mutation experiments run on disposable source, never the live checkout.
const source = resolve(import.meta.dir, "..");
const sandbox = await mkdtemp(join(tmpdir(), "agent-bus-nx-"));
type Run = { output: string; code: number; elapsed: number };
const receipts: Array<{ check: string; elapsedMs: number }> = [];
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
async function run(args: string[]): Promise<Run> {
  const start = performance.now();
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "scripts/local-tool.ts", "nx", ...args],
    {
      cwd: sandbox,
      env: localToolEnvironment(process.env),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const [code, out, err] = await Promise.all([child.exited, stdout, stderr]);
  return { output: out + err, code, elapsed: performance.now() - start };
}
async function expectRun(check: string, args: string[], expectation: "hit" | "miss" | "fail") {
  const result = await run(args);
  if (expectation === "fail") assert(result.code !== 0, `${check}: unexpected success`);
  else {
    assert(result.code === 0, `${check}: ${result.output}`);
    const hit = /Cache:\s+1\/1 hit/.test(result.output);
    assert(
      expectation === "hit" ? hit : !hit,
      `${check}: incorrect cache outcome: ${result.output}`
    );
  }
  receipts.push({ check, elapsedMs: Math.round(result.elapsed) });
}
async function inventory(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      values.push(...(await inventory(join(dir, entry.name), `${relative}/`)));
    else
      values.push(`${relative}:${Bun.hash(await Bun.file(join(dir, entry.name)).arrayBuffer())}`);
  }
  return values;
}
try {
  const rootFiles = (await readdir(source)).filter((name) =>
    /^(?:package\.json|bun\.lock|bunfig\.toml|nx\.json|project\.json|biome\.json|\.editorconfig|\.gitignore|tsconfig(?:\.[\w-]+)?\.json)$/.test(
      name
    )
  );
  for (const name of [
    ...rootFiles,
    "src",
    "viewer",
    "test",
    "tests",
    "scripts",
    "stories",
    ".storybook",
  ]) {
    await cp(join(source, name), join(sandbox, name), { recursive: true });
  }
  await symlink(join(source, "node_modules"), join(sandbox, "node_modules"), "dir");
  const target = ["run", "agent-bus:viewer-build", "--output-style=static"];
  await expectRun("viewer cold miss", target, "miss");
  await expectRun("viewer warm hit", target, "hit");
  const initial = await inventory(join(sandbox, "dist/viewer"));
  await rm(join(sandbox, "dist/viewer"), { recursive: true });
  await expectRun("viewer restores deleted output", target, "hit");
  assert(
    JSON.stringify(await inventory(join(sandbox, "dist/viewer"))) === JSON.stringify(initial),
    "restored output differs"
  );
  const cssPath = join(sandbox, "viewer/src/conversation.css");
  const css = await Bun.file(cssPath).text();
  await Bun.write(cssPath, `${css}\n/* cache qualification sentinel */\n`);
  await expectRun("CSS invalidates viewer build", target, "miss");
  const unitTarget = ["run", "agent-bus:test-viewer-unit", "--output-style=static"];
  await expectRun("unit cold miss", unitTarget, "miss");
  await expectRun("unit warm hit", unitTarget, "hit");
  await Bun.write(cssPath, `${css}\n/* independent CSS sentinel */\n`);
  await expectRun("CSS does not invalidate pure units", unitTarget, "hit");
  const modelPath = join(sandbox, "viewer/src/features/conversations/model.ts");
  const model = await Bun.file(modelPath).text();
  await Bun.write(modelPath, `${model}\nthrow new Error("synthetic cache falsifier");\n`);
  await expectRun("model change misses and fails units", unitTarget, "fail");
  await Bun.write(modelPath, model);
  await expectRun("restored model reuses correct prior result", unitTarget, "hit");
  const lockPath = join(sandbox, "bun.lock");
  const lock = await Bun.file(lockPath).text();
  await Bun.write(lockPath, `${lock}\n`);
  await expectRun("lock bytes invalidate units", unitTarget, "miss");
  await Bun.write(lockPath, lock);
  const schemaPath = join(sandbox, "viewer/shared/public.ts");
  const schema = await Bun.file(schemaPath).text();
  await Bun.write(schemaPath, `${schema}\n// schema cache sentinel\n`);
  await expectRun("public schema invalidates units", unitTarget, "miss");
  await Bun.write(schemaPath, schema);
  const storyTarget = ["run", "agent-bus:storybook-build", "--output-style=static"];
  await expectRun("Storybook cold miss", storyTarget, "miss");
  await expectRun("Storybook warm hit", storyTarget, "hit");
  const stories = await inventory(join(sandbox, "dist/storybook"));
  await rm(join(sandbox, "dist/storybook"), { recursive: true });
  await expectRun("Storybook restores deleted output", storyTarget, "hit");
  assert(
    JSON.stringify(await inventory(join(sandbox, "dist/storybook"))) === JSON.stringify(stories),
    "restored Storybook output differs"
  );
  await Bun.write(
    join(sandbox, "vite.config.ts"),
    'throw new Error("synthetic root Vite config must not load");\n'
  );
  await Bun.write(
    join(sandbox, "postcss.config.cjs"),
    'throw new Error("synthetic root PostCSS config must not load");\n'
  );
  await expectRun("dedicated workbench ignores hostile root configs", storyTarget, "miss");
  const selected = await run([
    "show",
    "projects",
    "--affected",
    "--files=viewer/src/conversation.css",
    "--json",
  ]);
  assert(
    selected.code === 0 && JSON.parse(selected.output).includes("agent-bus"),
    "affected CSS project was not selected"
  );
  receipts.push({
    check: "CSS affected selects the one root project",
    elapsedMs: Math.round(selected.elapsed),
  });
  const envPath = join(sandbox, ".env");
  await Bun.write(
    envPath,
    "NX_CLOUD_ACCESS_TOKEN=SYNTHETIC_ONLY\nNODE_OPTIONS=--require=synthetic-missing-file\n"
  );
  const denied = await run(["show", "project", "agent-bus", "--json"]);
  assert(
    denied.code !== 0 &&
      denied.output.includes("Tool refused") &&
      !denied.output.includes("SYNTHETIC_ONLY"),
    "dotenv preflight did not refuse safely before Nx"
  );
  receipts.push({ check: "dotenv refused before Nx", elapsedMs: Math.round(denied.elapsed) });
  console.log(JSON.stringify({ passed: true, receipts }, null, 2));
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
