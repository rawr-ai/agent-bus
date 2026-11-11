import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, type FileSystem } from "effect";
import { initializeInstallation, loadInstallation } from "../src/installation.ts";
import { spawnSupervised } from "./supervised.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.provide(effect, BunFileSystem.layer));

const cli = (dir: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [process.execPath, "--no-env-file", join(import.meta.dir, "../src/bin.ts"), ...args],
    { env: { ...process.env, AGENT_BUS_DIR: dir, AGENT_BUS_PORT: "9" }, timeout: 5_000 }
  );
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const serve = async (dir: string) => {
  const supervisor = spawnSupervised(
    [process.execPath, "--no-env-file", join(import.meta.dir, "../src/bin.ts"), "serve"],
    { env: { ...process.env, AGENT_BUS_DIR: dir, AGENT_BUS_PORT: "9" }, stderr: "pipe" }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = Promise.all([
      supervisor.exited,
      new Response(supervisor.stdout).text(),
      new Response(supervisor.stderr).text(),
    ]);
    const [code, stdout, stderr] = await Promise.race([
      output,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("serve did not exit within 5000ms")), 5_000);
      }),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGTERM");
    await supervisor.exited;
  }
};

test("explicit initialization is idempotent, race safe and distinct by state directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bus-installation-"));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await Promise.all(Array.from({ length: 6 }, () => run(initializeInstallation(a))));
    const original = await readFile(join(a, "installation-id"), "utf8");
    expect(await readdir(a)).toEqual(["installation-id"]);
    expect(cli(a, "initialize-installation")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await readFile(join(a, "installation-id"), "utf8")).toBe(original);
    expect(cli(b, "initialize-installation")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await run(loadInstallation(a))).toBe(original.trim());
    expect(await run(loadInstallation(b))).not.toBe(original.trim());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serve never creates a missing identity, and neither command overwrites invalid state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bus-installation-"));
  try {
    const identity = join(dir, "installation-id");
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ fluree: { url: "http://127.0.0.1:9", ledger: "fixture:main" } })
    );
    await mkdir(join(dir, "fluree-cursors"));
    const missing = await serve(dir);
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toContain("Missing installation-id.");
    expect(await Bun.file(identity).exists()).toBe(false);

    const malformed = "do-not-print-this-stored-value\n";
    await writeFile(identity, malformed);
    for (const command of ["serve", "initialize-installation"]) {
      const result = command === "serve" ? await serve(dir) : cli(dir, command);
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("Cannot read a valid installation-id.");
      expect(result.stderr).not.toContain(malformed.trim());
      expect(await readFile(identity, "utf8")).toBe(malformed);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
