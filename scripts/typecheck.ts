import { dirname, join } from "node:path";

const typecheckProjects = [
  "tsconfig.json",
  "viewer/tsconfig.server.json",
  "viewer/tsconfig.browser.json",
  "tsconfig.storybook.json",
  "tsconfig.browser-tests.json",
] as const;

const root = dirname(import.meta.dir);
const manifest = await Bun.file(join(root, "package.json")).json();
const native = manifest.devDependencies["@typescript/native"] as string;
if (!/^npm:typescript@\d+\.\d+\.\d+$/.test(native)) {
  throw new Error("Typecheck requires an exactly pinned native TypeScript target");
}
const version = native.slice("npm:typescript@".length);
const runner = join(root, "node_modules/@effect/tsgo/dist/effect-tsgo.cjs");

for (const project of typecheckProjects) {
  console.log(`Typecheck: ${project}`);
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", runner, `tsc@${version}`, "-p", project],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  const code = await child.exited;
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
