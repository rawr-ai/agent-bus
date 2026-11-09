import { expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseLauncher, removeOwned } from "../scripts/release.ts";
import { fakeRelease, mutate, replaceSealed, reseal } from "./release-fixture.ts";

const installer = resolve(import.meta.dir, "../scripts/install-launch-agents.sh");
const manifest = await Bun.file(
  resolve(import.meta.dir, "../plugin/.claude-plugin/plugin.json")
).json();
const hookCommand: string = manifest.hooks.SessionStart.find(
  (group: { hooks: Array<{ asyncRewake?: boolean }> }) =>
    group.hooks.some((hook) => hook.asyncRewake)
).hooks[0].command;
const codexManifest = await Bun.file(
  resolve(import.meta.dir, "../plugin/.codex-plugin/plugin.json")
).json();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function command(args: string[], env: Record<string, string>, cwd: string, stdin = "") {
  const child = Bun.spawn(args, {
    cwd,
    env,
    detached: true,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 8_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function executable(path: string, content: string) {
  await writeFile(path, `#!/bin/sh\nset -eu\n${content}\n`, { mode: 0o755 });
}

/** An established installation identity, as initialize-installation writes it. */
const IDENTITY = "0b6c1f5e-3d2a-4c7b-9e8f-1a2b3c4d5e6f";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-bus-install-")));
  const home = join(root, "home with a 'quote' & <xml>");
  const repo = join(root, "source with a 'quote' & <xml>");
  const tools = join(root, "tools");
  const bus = join(home, "state 'quoted' & <xml>");
  const agents = join(home, "Library/LaunchAgents");
  const launcher = join(home, ".local/bin/agent-bus");
  const label = "test.agent-bus.runtime";
  const toolLog = join(root, "tool-calls");
  for (const dir of [tools, join(repo, "src"), join(home, ".bun/bin"), agents, bus])
    await mkdir(dir, { recursive: true });
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await writeFile(toolLog, "");
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ engines: { bun: Bun.version }, packageManager: `bun@${Bun.version}` })
  );
  const entry = join(repo, "src/bin.ts");
  await writeFile(
    entry,
    `console.log(JSON.stringify({runtime: process.env.BINDING_RUNTIME, args: process.argv.slice(2), dotenv: process.env.BINDING_DOTENV ?? null}));\n`
  );
  await writeFile(join(bus, ".env"), "BINDING_DOTENV=must-not-load\n");
  await writeFile(join(bus, "config.json"), '{"kept":"config"}\n');
  await writeFile(join(bus, "fluree-token"), "existing.token.signature\n", { mode: 0o600 });
  await writeFile(join(bus, "installation-id"), `${IDENTITY}\n`, { mode: 0o600 });
  await writeFile(
    join(bus, "fluree-key.json"),
    '{"did":"did:key:kept","privateKey":{"hex":"kept"}}\n',
    { mode: 0o600 }
  );
  await mkdir(join(bus, "fluree/.fluree"), { recursive: true });
  for (const suffix of ["fluree", "tunnel"])
    await writeFile(join(agents, `${label}.${suffix}.plist`), `keep ${suffix}\n`);
  await executable(
    join(tools, "launchctl"),
    `printf 'launchctl %s\\n' "$*" >> ${quote(toolLog)}\n[ "$1" != print ] || exit 113\n[ "$1" != bootstrap ] || [ "\${FAIL_BOOTSTRAP:-}" != 1 ]`
  );
  await executable(
    join(tools, "curl"),
    `printf 'curl %s\\n' "$*" >> ${quote(toolLog)}\ncase "$*" in\n  *'/health') exit 0 ;;\n  *'-H '*) printf 200 ;;\n  *) printf 401 ;;\nesac`
  );
  for (const name of ["fluree", "ssh", "scp"])
    await executable(
      join(tools, name),
      `printf '${name} %s\\n' "$*" >> ${quote(toolLog)}\nexit 91`
    );
  const bunA = join(root, "bun A's & <runtime>");
  const bunB = join(root, "bun B's & <runtime>");
  for (const [path, identity] of [
    [bunA, "A"],
    [bunB, "B"],
  ])
    await executable(
      path!,
      `export BINDING_RUNTIME=${identity}\nexec ${quote(process.execPath)} "$@"`
    );
  for (const dir of [tools, join(home, ".local/bin"), join(home, ".bun/bin")])
    await executable(join(dir, "bun"), 'echo "PATH decoy Bun ran" >&2\nexit 93');
  const env = {
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AGENT_BUS_REPO: repo,
    AGENT_BUS_DIR: bus,
    AGENT_BUS_LABEL: label,
    AGENT_BUS_PORT: "47891",
    AGENT_BUS_FLUREE_PORT: "47890",
  };
  return {
    root,
    home,
    repo,
    bus,
    agents,
    launcher,
    entry,
    label,
    toolLog,
    bunA,
    bunB,
    tools,
    env,
    plist: join(agents, `${label}.plist`),
    releases: join(home, ".local/share/agent-bus/releases"),
    /** Seals a stand-in release built on Bun A in the default releases directory. */
    release: async (id: string, bun = bunA) => {
      await mkdir(join(home, ".local/share/agent-bus/releases"), { recursive: true });
      return fakeRelease(join(home, ".local/share/agent-bus/releases"), id, bun);
    },
    install: (args = ["--runtime-only", "--bun", bunA], extra = {}) =>
      command(["/bin/sh", installer, ...args], { ...env, ...extra }, root),
    dispose: async () => removeOwned(root),
  };
}

async function snapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  async function visit(path: string) {
    const stat = await lstat(path);
    // Only a regular file is read: reading a FIFO would wait for a writer.
    const kind = stat.isDirectory()
      ? "dir"
      : stat.isSymbolicLink()
        ? "link"
        : stat.isFile()
          ? "file"
          : "other";
    entries.push([
      path.slice(root.length),
      kind,
      stat.mode,
      stat.mtimeMs,
      kind === "link"
        ? await readlink(path)
        : kind === "file"
          ? (await readFile(path)).toString("base64")
          : null,
    ]);
    if (kind === "dir")
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return entries;
}

test("runtime-only adopts the old source link without touching source, credentials or other jobs", async () => {
  const f = await fixture();
  try {
    await symlink(f.entry, f.launcher);
    const sourceBefore = await snapshot(f.repo);
    const stateBefore = await snapshot(f.bus);
    const otherJobsBefore = await Promise.all(
      ["fluree", "tunnel"].map((suffix) => snapshot(join(f.agents, `${f.label}.${suffix}.plist`)))
    );
    const result = await f.install();
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect((await lstat(f.launcher)).isSymbolicLink()).toBe(false);
    expect((await lstat(f.launcher)).mode & 0o777).toBe(0o755);
    expect(await snapshot(f.repo)).toEqual(sourceBefore);
    expect(await snapshot(f.bus)).toEqual(stateBefore);
    expect(
      await Promise.all(
        ["fluree", "tunnel"].map((suffix) => snapshot(join(f.agents, `${f.label}.${suffix}.plist`)))
      )
    ).toEqual(otherJobsBefore);
    const calls = (await readFile(f.toolLog, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatch(new RegExp(`^launchctl bootout gui/\\d+/${f.label}$`));
    expect(calls[1]).toMatch(new RegExp(`^launchctl print gui/\\d+/${f.label}$`));
    expect(calls[2]).toBe(`launchctl bootstrap gui/${process.getuid?.()} ${f.plist}`);
    expect(calls[3]).toBe("curl -fsS http://127.0.0.1:47891/health");
  } finally {
    await f.dispose();
  }
});

test("launcher and real plugin hook use the explicit runtime under env-i and ignore dotenv", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    for (const [args, expectedArgs] of [
      [
        [f.launcher, "--help", "a b'c & <d>"],
        ["--help", "a b'c & <d>"],
      ],
      [["/bin/sh", "-c", hookCommand], ["claude-wake"]],
    ]) {
      const result = await command(args!, { HOME: f.home, PATH: "/usr/bin:/bin" }, f.bus, "{}\n");
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({ runtime: "A", args: expectedArgs, dotenv: null });
    }
  } finally {
    await f.dispose();
  }
});

test("Codex inline hooks use the upstream hooks-file envelope", () => {
  // codex rust-v0.165.0-alpha.1.2, core-plugins/src/loader_tests.rs:
  // load_plugin_hooks_supports_inline_manifest_hooks. This is not a native loader test.
  const hooksFile = { hooks: { SessionStart: expect.any(Array) } };
  const pr42EventMap = codexManifest.hooks.hooks;
  expect(codexManifest.hooks).toEqual(hooksFile);
  expect(pr42EventMap).not.toEqual(hooksFile);
});

test("both actual compact manifest commands use the managed runtime without changing async wake declarations", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    expect(manifest.hooks.Stop[0].hooks[0].command).toBe(hookCommand);
    expect(manifest.hooks.StopFailure[0].hooks[0].command).toBe(hookCommand);
    for (const [runtime, events] of [
      ["claude", manifest.hooks],
      ["codex", codexManifest.hooks.hooks],
    ] as const) {
      const group = events.SessionStart.find(
        (group: { matcher?: string }) => group.matcher !== undefined
      );
      const hook = group.hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.async).toBeUndefined();
      expect(hook.asyncRewake).toBeUndefined();
      expect(new RegExp(group.matcher).test("compact")).toBe(true);
      expect(new RegExp(group.matcher).test("resume")).toBe(false);
      expect(hook.timeout).toBe(5);
      const result = await command(
        ["/bin/sh", "-c", hook.command],
        { HOME: f.home, PATH: "/usr/bin:/bin" },
        f.bus,
        "{}\n"
      );
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        runtime: "A",
        args: ["compact-context", "--runtime", runtime],
        dotenv: null,
      });
    }
  } finally {
    await f.dispose();
  }
});

test.skipIf(process.platform !== "darwin")(
  "independent plist parse names only the launcher and preserves XML-sensitive paths",
  async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      const result = await command(
        ["/usr/bin/plutil", "-convert", "json", "-o", "-", f.plist],
        { PATH: "/usr/bin:/bin" },
        f.root
      );
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      const plist = JSON.parse(result.stdout);
      expect(plist.ProgramArguments).toEqual([f.launcher, "serve"]);
      expect(plist.WorkingDirectory).toBe(f.bus);
      expect(plist.EnvironmentVariables).toEqual({
        HOME: f.home,
        AGENT_BUS_DIR: f.bus,
        AGENT_BUS_PORT: "47891",
      });
      expect(plist.StandardOutPath).toBe(join(f.bus, "agent-bus.log"));
      expect(plist.StandardErrorPath).toBe(join(f.bus, "agent-bus.log"));
      const served = await command(
        plist.ProgramArguments,
        { HOME: f.home, PATH: "/usr/bin:/bin" },
        f.bus
      );
      expect(served).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(served.stdout)).toEqual({ runtime: "A", args: ["serve"], dotenv: null });
    } finally {
      await f.dispose();
    }
  }
);

test("managed update is idempotent and explicit upgrade then rollback reproduces the first binding", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    const first = await Promise.all([readFile(f.launcher, "utf8"), readFile(f.plist, "utf8")]);
    const calls = await readFile(f.toolLog, "utf8");
    await writeFile(f.toolLog, "");
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await Promise.all([readFile(f.launcher, "utf8"), readFile(f.plist, "utf8")])).toEqual(
      first
    );
    expect(await readFile(f.toolLog, "utf8")).toBe(calls);
    expect(await f.install(["--bun", f.bunB, "--runtime-only"])).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    const selected = await command([f.launcher, "--help"], { HOME: f.home, PATH: "/bin" }, f.bus);
    expect(JSON.parse(selected.stdout).runtime).toBe("B");
    expect(await f.install(["--runtime-only", "--bun", f.bunA])).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(await Promise.all([readFile(f.launcher, "utf8"), readFile(f.plist, "utf8")])).toEqual(
      first
    );
    expect(await readFile(f.toolLog, "utf8")).not.toMatch(/fluree|tunnel|scp|ssh/);
  } finally {
    await f.dispose();
  }
});

test("full install initializes identity before first config, including after an interrupted attempt", async () => {
  const f = await fixture();
  try {
    const config = join(f.bus, "config.json");
    const identity = join(f.bus, "installation-id");
    await rm(config);
    // Stub only the CLI command; installation.test.ts exercises its actual file behavior.
    await writeFile(
      f.entry,
      `import { writeFile } from "node:fs/promises";
if (process.argv[2] === "initialize-installation") {
  const file = process.env.AGENT_BUS_DIR + "/installation-id";
  try { await writeFile(file, crypto.randomUUID(), { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (process.env.FAIL_INITIALIZE === "1") process.exit(42);
}
`
    );

    expect(await f.install(["--bun", f.bunA], { FAIL_INITIALIZE: "1" })).toMatchObject({
      exitCode: 42,
    });
    expect(await Bun.file(config).exists()).toBe(false);
    expect(await Bun.file(f.plist).exists()).toBe(false);
    const first = await readFile(identity, "utf8");

    expect(await f.install(["--bun", f.bunA])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await Bun.file(config).exists()).toBe(true);
    expect(await readFile(identity, "utf8")).toBe(first);

    await rm(identity);
    expect(await f.install(["--bun", f.bunA], { FAIL_INITIALIZE: "1" })).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(await f.install(undefined, { FAIL_INITIALIZE: "1" })).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(await Bun.file(identity).exists()).toBe(false);

    await rm(config);
    await mkdir(join(f.bus, "fluree-cursors"));
    await writeFile(f.toolLog, "");
    const partial = await f.install(["--bun", f.bunA]);
    expect(partial.exitCode).toBe(1);
    expect(partial.stderr).toContain("Retained cursors but no config.json or installation-id.");
    expect(await readFile(f.toolLog, "utf8")).toBe("");
    expect(await Bun.file(config).exists()).toBe(false);
    expect(await Bun.file(identity).exists()).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("full install adopts a managed launcher and uses the same binding, with optional PATH selection", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await f.install(["--bun", f.bunB])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readFile(f.launcher, "utf8")).toContain(quote(f.bunB));
    await rm(join(f.tools, "bun"));
    await symlink(f.bunA, join(f.tools, "bun"));
    expect(await f.install([])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readFile(f.launcher, "utf8")).toContain(quote(f.bunA));
    await rm(join(f.tools, "bun"));
    await symlink(f.bunB, join(f.tools, "bun"));
    const selected = await command([f.launcher, "--help"], { HOME: f.home, PATH: "/bin" }, f.bus);
    expect(JSON.parse(selected.stdout).runtime).toBe("A");
    expect(await readFile(f.plist, "utf8")).not.toContain("--no-env-file");
  } finally {
    await f.dispose();
  }
});

for (const kind of [
  "file",
  "marker-only",
  "changed-managed",
  "foreign-link",
  "broken-link",
  "directory",
]) {
  test(`refuses ${kind} launcher before any write or service operation`, async () => {
    const f = await fixture();
    try {
      if (kind === "file") await writeFile(f.launcher, "foreign executable\n");
      if (kind === "marker-only")
        await writeFile(
          f.launcher,
          "#!/bin/sh\n# agent-bus managed runtime launcher v1\necho foreign\n"
        );
      if (kind === "changed-managed") {
        expect(await f.install()).toMatchObject({ exitCode: 0 });
        await writeFile(f.launcher, `${await readFile(f.launcher, "utf8")}echo foreign\n`);
        await writeFile(f.toolLog, "");
      }
      if (kind === "foreign-link") await symlink(join(f.bus, "config.json"), f.launcher);
      if (kind === "broken-link") await symlink(join(f.root, "missing"), f.launcher);
      if (kind === "directory") await mkdir(f.launcher);
      const before = await snapshot(f.root);
      const result = await f.install();
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Refusing foreign launcher");
      expect(await snapshot(f.root)).toEqual(before);
    } finally {
      await f.dispose();
    }
  });
}

test("invalid arguments, missing or unusable Bun, and mismatched source pins refuse before writes", async () => {
  const f = await fixture();
  try {
    const unusable = join(f.root, "unusable-bun");
    await writeFile(unusable, "not executable\n");
    const broken = join(f.root, "broken-bun");
    await executable(broken, "exit 92");
    const cases = [
      ["--unknown"],
      ["--help", "--unknown"],
      ["--remote"],
      ["--bun"],
      ["--bun", "relative"],
      ["--runtime-only"],
      ["--runtime-only", "--remote", "host", "--bun", f.bunA],
      ["--runtime-only", "--bun", f.bunA, "--bun", f.bunB],
      ["--runtime-only", "--runtime-only", "--bun", f.bunA],
      ["--runtime-only", "--bun", join(f.root, "missing-bun")],
      ["--runtime-only", "--bun", unusable],
      ["--runtime-only", "--bun", broken],
      ["--runtime-only", "--bun", "/usr/bin/true"],
    ];
    for (const args of cases) {
      const before = await snapshot(f.root);
      const result = await f.install(args);
      expect(result.exitCode).not.toBe(0);
      expect(await snapshot(f.root)).toEqual(before);
    }
    const noBunBefore = await snapshot(f.root);
    const noBun = await f.install([], { PATH: "" });
    expect(noBun.exitCode).not.toBe(0);
    expect(noBun.stderr).toContain("bun is not on PATH; supply --bun");
    expect(await snapshot(f.root)).toEqual(noBunBefore);
    await writeFile(
      join(f.repo, "package.json"),
      JSON.stringify({ engines: { bun: "0.0.1" }, packageManager: "bun@0.0.1" })
    );
    const before = await snapshot(f.root);
    const result = await f.install();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not match source pin 0.0.1");
    expect(await snapshot(f.root)).toEqual(before);
  } finally {
    await f.dispose();
  }
});

test("a source that cannot run refuses before touching an existing launcher or jobs", async () => {
  const f = await fixture();
  try {
    await symlink(f.entry, f.launcher);
    await writeFile(f.entry, 'throw new Error("source preflight failed");\n');
    const before = await snapshot(f.root);
    const result = await f.install();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Selected runtime cannot run");
    expect(await snapshot(f.root)).toEqual(before);
  } finally {
    await f.dispose();
  }
});

test("failed launchd activation leaves a coherent binding that the same updater can recover", async () => {
  const f = await fixture();
  try {
    const failed = await f.install(undefined, { FAIL_BOOTSTRAP: "1" });
    expect(failed.exitCode).not.toBe(0);
    expect(await readFile(f.launcher, "utf8")).toContain(quote(f.bunA));
    expect(await readFile(f.plist, "utf8")).toContain("<string>serve</string>");
    expect(
      (await readdir(join(f.home, ".local/bin"))).filter((name) => name.includes(".tmp."))
    ).toEqual([]);
    expect((await readdir(f.agents)).filter((name) => name.includes(".tmp."))).toEqual([]);
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
  } finally {
    await f.dispose();
  }
});

test("release mode binds the launcher to a verified release without a checkout, and source rollback adopts it", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    const sourceLauncher = await readFile(f.launcher, "utf8");
    const plist = await readFile(f.plist, "utf8");
    const a = await f.release("1.0.0-aaaaaaaaaaaa");
    const b = await f.release("1.0.0-bbbbbbbbbbbb");
    // A bunfig.toml where the installer, launcher and hook run: its preload must never load.
    const preloaded = join(f.root, "bunfig-preloaded");
    await writeFile(
      join(f.root, "preload.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(preloaded)}, "1");\n`
    );
    for (const dir of [f.root, f.bus])
      await writeFile(
        join(dir, "bunfig.toml"),
        `preload = [${JSON.stringify(join(f.root, "preload.js"))}]\n`
      );
    const stateBefore = await snapshot(f.bus);
    // No source root anywhere: the release's own installer, with no AGENT_BUS_REPO.
    const { AGENT_BUS_REPO: _, ...withoutSource } = f.env;
    for (const target of [a, b]) {
      await writeFile(f.toolLog, "");
      const result = await command(
        [
          "/bin/sh",
          join(target.dir, "app/install-launch-agents.sh"),
          "--release",
          target.dir,
          "--expect",
          target.digest,
        ],
        withoutSource,
        f.root
      );
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(target.dir));
      expect((await lstat(f.launcher)).mode & 0o777).toBe(0o755);
      expect(await readFile(f.plist, "utf8")).toBe(plist);
      expect(await readFile(f.toolLog, "utf8")).not.toMatch(/fluree|tunnel|scp|ssh/);
      // The launcher and the real plugin hook run this release's code under env -i, without dotenv.
      for (const [args, expectedArgs] of [
        [[f.launcher, "serve"], ["serve"]],
        [["/bin/sh", "-c", hookCommand], ["claude-wake"]],
      ]) {
        const ran = await command(args!, { HOME: f.home, PATH: "/usr/bin:/bin" }, f.bus, "{}\n");
        expect(ran).toMatchObject({ exitCode: 0, stderr: "" });
        expect(JSON.parse(ran.stdout)).toEqual({
          runtime: "A",
          args: expectedArgs,
          dotenv: null,
          release: target.dir.split("/").at(-1),
        });
      }
    }
    expect(await snapshot(f.bus)).toEqual(stateBefore);
    expect(existsSync(preloaded)).toBe(false);
    // Each activation kept the binding it replaced: first the source launcher, then A's.
    const bindings = join(f.home, ".local/share/agent-bus/bindings");
    const records = (await readdir(bindings)).sort();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatch(/^launcher\.\d{8}T\d{6}Z\.\d+\.before-1\.0\.0-aaaaaaaaaaaa$/);
    expect(await readFile(join(bindings, records[0]!), "utf8")).toBe(sourceLauncher);
    expect(records[1]).toMatch(/\.before-1\.0\.0-bbbbbbbbbbbb$/);
    expect(await readFile(join(bindings, records[1]!), "utf8")).toBe(releaseLauncher(a.dir));
    // Rolling back to source uses the runtime-only path, which owns a release launcher.
    expect(await f.install(["--runtime-only", "--bun", f.bunB])).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    const source = await command([f.launcher, "--help"], { HOME: f.home, PATH: "/bin" }, f.bus);
    expect(JSON.parse(source.stdout)).toEqual({ runtime: "B", args: ["--help"], dotenv: null });
    expect(await readFile(f.plist, "utf8")).toBe(plist);
  } finally {
    await f.dispose();
  }
});

test("release mode refuses bad arguments, unverified or misplaced releases before any write", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    const good = await f.release("1.0.0-cccccccccccc");
    // Changed after sealing, under the recorded digest: its Bun, then its CLI.
    const swappedBun = await f.release("1.0.0-dddddddddddd");
    mutate(join(swappedBun.dir, "runtime"), 0o555, () =>
      mutate(join(swappedBun.dir, "runtime/bun"), 0o555, () =>
        appendFileSync(join(swappedBun.dir, "runtime/bun"), "# changed\n")
      )
    );
    const changedCli = await f.release("1.0.0-abababababab");
    mutate(join(changedCli.dir, "app"), 0o555, () =>
      mutate(join(changedCli.dir, "app/cli.js"), 0o444, () =>
        appendFileSync(join(changedCli.dir, "app/cli.js"), "// changed\n")
      )
    );
    // A verifier that always passes, sealed under its own digest: only the installer's
    // anchor, computed before any release code runs, stands between it and activation.
    const lenient = await f.release("1.0.0-acacacacacac");
    replaceSealed(lenient.dir, "app/release.js", "process.exit(0);\n");
    const outside = fakeRelease(f.root, "1.0.0-eeeeeeeeeeee", f.bunA);
    const releaseArgs = (dir: string, digest: string) => ["--release", dir, "--expect", digest];
    const cases: Array<[string[], string]> = [
      [releaseArgs(good.dir, "0".repeat(64)), "did not verify"],
      [releaseArgs(swappedBun.dir, swappedBun.digest), "its Bun differs from its manifest"],
      [releaseArgs(changedCli.dir, changedCli.digest), "did not verify"],
      [releaseArgs(lenient.dir, lenient.digest), "did not verify"],
      [releaseArgs(outside.dir, outside.digest), "not directly inside"],
      [releaseArgs(join(f.releases, "missing"), good.digest), "does not exist"],
      [["--release", "relative", "--expect", good.digest], "absolute directory"],
      [["--release", good.dir], "requires --expect"],
      [[...releaseArgs(good.dir, good.digest), "--bun", f.bunA], "omit --bun"],
      [["--expect", good.digest, "--runtime-only", "--bun", f.bunA], "--expect requires --release"],
      [
        [...releaseArgs(good.dir, good.digest), "--runtime-only", "--bun", f.bunA],
        "cannot be combined with --runtime-only",
      ],
      [
        [...releaseArgs(good.dir, good.digest), "--remote", "host"],
        "cannot be combined with --remote",
      ],
      [[...releaseArgs(good.dir, good.digest), "--release", good.dir], "more than once"],
    ];
    for (const [args, reason] of cases) {
      await writeFile(f.toolLog, "");
      const before = await snapshot(f.root);
      const result = await f.install(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(reason);
      expect(await snapshot(f.root)).toEqual(before);
      expect(await readFile(f.toolLog, "utf8")).toBe("");
    }
  } finally {
    await f.dispose();
  }
});

for (const kind of ["marker-only", "appended", "outside-releases", "relative", "dot-release"]) {
  test(`refuses a ${kind} release launcher before any write or service operation`, async () => {
    const f = await fixture();
    try {
      const good = await f.release("1.0.0-ffffffffffff");
      const genuine = releaseLauncher(good.dir);
      const content = {
        "marker-only": "#!/bin/sh\n# agent-bus managed release launcher v2\necho foreign\n",
        appended: `${genuine}echo foreign\n`,
        "outside-releases": releaseLauncher(join(f.root, "elsewhere/1.0.0-ffffffffffff")),
        relative: releaseLauncher("releases/1.0.0-ffffffffffff"),
        "dot-release": releaseLauncher(join(f.releases, ".tmp-1.0.0-ffffffffffff")),
      }[kind]!;
      await writeFile(f.launcher, content, { mode: 0o755 });
      const before = await snapshot(f.root);
      const result = await f.install(["--release", good.dir, "--expect", good.digest]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Refusing foreign launcher");
      expect(await snapshot(f.root)).toEqual(before);
    } finally {
      await f.dispose();
    }
  });
}

test("release mode hashes each file it runs with system tools before running any of them", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    const ran = join(f.root, "release-code-ran");
    const marking = `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "1");\n`;
    const preload = join(f.root, "marking-preload.js");
    await writeFile(preload, marking);
    const preloading = `preload = [${JSON.stringify(preload)}]\n`;
    const changeInPlace = (dir: string, path: string, content: string) => {
      const file = join(dir, path);
      mutate(join(file, ".."), 0o555, () =>
        mutate(file, 0o444, () => writeFileSync(file, content))
      );
    };
    // Each is changed after sealing and offered under its recorded digest.
    const verifier = await f.release("1.0.0-a1a1a1a1a1a1");
    changeInPlace(verifier.dir, "app/release.js", `${marking}process.exit(0);\n`);
    const config = await f.release("1.0.0-a2a2a2a2a2a2");
    changeInPlace(config.dir, "app/bunfig.toml", preloading);
    // The same bytes, but through a link to a file outside the release.
    const linked = await f.release("1.0.0-a3a3a3a3a3a3");
    const outsideCopy = join(f.root, "release-copy.js");
    cpSync(join(linked.dir, "app/release.js"), outsideCopy);
    mutate(join(linked.dir, "app"), 0o555, () => {
      unlinkSync(join(linked.dir, "app/release.js"));
      symlinkSync(outsideCopy, join(linked.dir, "app/release.js"));
    });
    // The whole app directory replaced by a link to an identical copy outside.
    const linkedApp = await f.release("1.0.0-a4a4a4a4a4a4");
    const appCopy = join(f.root, "app-copy");
    cpSync(join(linkedApp.dir, "app"), appCopy, { recursive: true });
    chmodSync(linkedApp.dir, 0o755);
    chmodSync(join(linkedApp.dir, "app"), 0o755);
    renameSync(join(linkedApp.dir, "app"), join(f.root, "app-moved"));
    symlinkSync(appCopy, join(linkedApp.dir, "app"));
    chmodSync(linkedApp.dir, 0o555);
    // A FIFO in the Bun's place: a hash would wait on it forever, so its type is checked first.
    const fifo = await f.release("1.0.0-a8a8a8a8a8a8");
    mutate(join(fifo.dir, "runtime"), 0o555, () => {
      unlinkSync(join(fifo.dir, "runtime/bun"));
      expect(Bun.spawnSync(["/usr/bin/mkfifo", join(fifo.dir, "runtime/bun")]).exitCode).toBe(0);
    });
    // A manifest, sealed under its own digest, that no longer lists the Bun config.
    const unlisted = await f.release("1.0.0-a5a5a5a5a5a5");
    const unlistedDigest = reseal(unlisted.dir, (manifest) => {
      manifest.files = manifest.files.filter((file) => file.path !== "app/bunfig.toml");
    });
    const cases: Array<[string, string, string]> = [
      [verifier.dir, verifier.digest, "app/release.js differs from its manifest"],
      [config.dir, config.digest, "app/bunfig.toml differs from its manifest"],
      [linked.dir, linked.digest, "app/release.js is not a regular file"],
      [linkedApp.dir, linkedApp.digest, "app is missing or a link"],
      [unlisted.dir, unlistedDigest, "its manifest does not list app/bunfig.toml"],
      [fifo.dir, fifo.digest, "runtime/bun is not a regular file"],
    ];
    for (const [dir, digest, reason] of cases) {
      await writeFile(f.toolLog, "");
      const before = await snapshot(f.root);
      const result = await f.install(["--release", dir, "--expect", digest]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(reason);
      expect(existsSync(ran)).toBe(false);
      expect(await snapshot(f.root)).toEqual(before);
      expect(await readFile(f.toolLog, "utf8")).toBe("");
    }
    // Positive controls: resealed and offered under the new digest, each change does run.
    for (const [id, path, content] of [
      ["1.0.0-a6a6a6a6a6a6", "app/release.js", `${marking}process.exit(0);\n`],
      ["1.0.0-a7a7a7a7a7a7", "app/bunfig.toml", preloading],
    ] as const) {
      const control = await f.release(id);
      const digest = replaceSealed(control.dir, path, content);
      await f.install(["--release", control.dir, "--expect", digest]);
      expect(existsSync(ran)).toBe(true);
      unlinkSync(ran);
    }
  } finally {
    await f.dispose();
  }
});

test("release mode binds one spelling of the release and refuses the root, . and ..", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    const good = await f.release("1.0.0-b1b1b1b1b1b1");
    // A link in the releases directory named like a release: a trailing slash must not
    // make the directory test follow it.
    const alias = join(f.releases, "1.0.0-b2b2b2b2b2b2");
    await symlink(good.dir, alias);
    const cases: Array<[string, string]> = [
      ["/", "absolute directory"],
      ["//", "absolute directory"],
      [`${good.dir}/.`, "not . or .."],
      [`${good.dir}/..`, "not . or .."],
      [`${f.releases}/../releases/${good.dir.split("/").at(-1)}`, "not . or .."],
      [`${alias}/`, "not a real directory"],
      [`${alias}//`, "not a real directory"],
    ];
    for (const [path, reason] of cases) {
      await writeFile(f.toolLog, "");
      const before = await snapshot(f.root);
      const result = await f.install(["--release", path, "--expect", good.digest]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(reason);
      expect(await snapshot(f.root)).toEqual(before);
      expect(await readFile(f.toolLog, "utf8")).toBe("");
    }
    const bound = await f.install(["--release", `${good.dir}//`, "--expect", good.digest]);
    expect(bound).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(good.dir));
  } finally {
    await f.dispose();
  }
});

/** Writes a serve job as XML, from its JSON shape, the way launchd reads it. */
async function writeJob(path: string, job: Record<string, unknown>) {
  await writeFile(path, JSON.stringify(job));
  const converted = await command(
    ["/usr/bin/plutil", "-convert", "xml1", path],
    { PATH: "/usr/bin:/bin" },
    "/"
  );
  expect(converted.exitCode).toBe(0);
}

test.skipIf(process.platform !== "darwin")(
  "activation keeps the owned serve job byte for byte and waits on its own port",
  async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      const good = await f.release("1.0.0-c1c1c1c1c1c1");
      // The owned job as another installer wrote it: no HOME, its own port and state.
      const otherBus = join(f.home, "other state");
      await mkdir(otherBus);
      // The kept job's own state directory is the one whose identity a release needs.
      await writeFile(join(otherBus, "installation-id"), `${IDENTITY}\n`, { mode: 0o600 });
      const unset = { AGENT_BUS_PORT: "", AGENT_BUS_DIR: "" };
      for (const [env, port, overrides] of [
        [{ AGENT_BUS_DIR: otherBus, AGENT_BUS_PORT: "47892" }, "47892", unset],
        [
          { AGENT_BUS_DIR: otherBus, AGENT_BUS_PORT: "47892" },
          "47892",
          { AGENT_BUS_PORT: "47892", AGENT_BUS_DIR: otherBus },
        ],
        // No port of its own: serve's default applies, and that is the one waited on.
        [{ AGENT_BUS_DIR: otherBus }, "8096", unset],
      ] as const) {
        await writeJob(f.plist, {
          Label: f.label,
          ProgramArguments: [f.launcher, "serve"],
          EnvironmentVariables: env,
          KeepAlive: true,
          RunAtLoad: true,
        });
        for (const args of [
          ["--release", good.dir, "--expect", good.digest],
          ["--runtime-only", "--bun", f.bunA],
        ]) {
          const kept = await snapshot(f.plist);
          await writeFile(f.toolLog, "");
          expect(await f.install(args, overrides)).toMatchObject({ exitCode: 0, stderr: "" });
          expect(await snapshot(f.plist)).toEqual(kept);
          const calls = await readFile(f.toolLog, "utf8");
          expect(calls).toContain(`launchctl bootstrap gui/${process.getuid?.()} ${f.plist}\n`);
          expect(calls).toContain(`curl -fsS http://127.0.0.1:${port}/health\n`);
        }
      }
      expect(existsSync(join(otherBus, "agent-bus.log"))).toBe(false);
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "activation refuses, unchanged, a serve job it does not own or an override it would not apply",
  async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      const good = await f.release("1.0.0-c2c2c2c2c2c2");
      const owned = {
        Label: f.label,
        ProgramArguments: [f.launcher, "serve"],
        EnvironmentVariables: { AGENT_BUS_DIR: f.bus, AGENT_BUS_PORT: "47892" },
      };
      const cases: Array<[string, () => Promise<void>, Record<string, string>, string]> = [
        [
          "another port",
          () => writeJob(f.plist, owned),
          {},
          "AGENT_BUS_PORT=47891 differs from its port 47892",
        ],
        [
          "another state directory",
          () => writeJob(f.plist, owned),
          { AGENT_BUS_PORT: "", AGENT_BUS_DIR: join(f.home, "elsewhere") },
          "AGENT_BUS_DIR differs from its state directory",
        ],
        [
          "a Program override",
          () => writeJob(f.plist, { ...owned, Program: "/bin/sh" }),
          { AGENT_BUS_PORT: "" },
          "not the owned job",
        ],
        [
          "another label",
          () => writeJob(f.plist, { ...owned, Label: "other" }),
          { AGENT_BUS_PORT: "" },
          "not the owned job",
        ],
        [
          "extra arguments",
          () => writeJob(f.plist, { ...owned, ProgramArguments: [f.launcher, "serve", "--x"] }),
          { AGENT_BUS_PORT: "" },
          "not the owned job",
        ],
        [
          "another launcher",
          () => writeJob(f.plist, { ...owned, ProgramArguments: [join(f.root, "other"), "serve"] }),
          { AGENT_BUS_PORT: "" },
          "not the owned job",
        ],
        [
          "a link to an owned job",
          async () => {
            const target = join(f.root, "linked.plist");
            await writeJob(target, owned);
            await symlink(target, f.plist);
          },
          { AGENT_BUS_PORT: "" },
          "not a regular file",
        ],
        [
          "unreadable contents",
          () => writeFile(f.plist, "not a plist\n"),
          { AGENT_BUS_PORT: "" },
          "not a readable plist",
        ],
      ];
      for (const [, prepare, overrides, reason] of cases) {
        await rm(f.plist, { force: true });
        await prepare();
        for (const args of [
          ["--release", good.dir, "--expect", good.digest],
          ["--runtime-only", "--bun", f.bunA],
        ]) {
          await writeFile(f.toolLog, "");
          const before = await snapshot(f.root);
          const result = await f.install(args, overrides);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain(reason);
          expect(await snapshot(f.root)).toEqual(before);
          expect(await readFile(f.toolLog, "utf8")).toBe("");
        }
      }
    } finally {
      await f.dispose();
    }
  }
);

test("an interrupted release activation leaves the job unchanged and the same command recovers", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    const plist = await snapshot(f.plist);
    const good = await f.release("1.0.0-c3c3c3c3c3c3");
    const args = ["--release", good.dir, "--expect", good.digest];
    const failed = await f.install(args, { FAIL_BOOTSTRAP: "1" });
    expect(failed.exitCode).not.toBe(0);
    expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(good.dir));
    expect(await snapshot(f.plist)).toEqual(plist);
    expect((await readdir(f.agents)).filter((name) => name.includes(".tmp."))).toEqual([]);
    expect(await f.install(args)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(good.dir));
    expect(await snapshot(f.plist)).toEqual(plist);
  } finally {
    await f.dispose();
  }
});

test("release activation needs this installation's identity and creates none", async () => {
  const f = await fixture();
  try {
    expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
    const good = await f.release("1.0.0-cccccccccccc");
    const identity = join(f.bus, "installation-id");
    const activate = () => f.install(["--release", good.dir, "--expect", good.digest]);
    const refusals: Array<[string, () => Promise<void>]> = [
      ["missing", () => rm(identity, { force: true })],
      ["not a UUID", () => writeFile(identity, "hostname.local\n", { mode: 0o600 })],
      ["with a second line", () => writeFile(identity, `${IDENTITY}\n${IDENTITY}\n`)],
      [
        "a link to a valid one",
        async () => {
          await writeFile(join(f.root, "elsewhere-id"), `${IDENTITY}\n`);
          await symlink(join(f.root, "elsewhere-id"), identity);
        },
      ],
      ["a directory", () => mkdir(identity)],
    ];
    for (const [kind, arrange] of refusals) {
      await rm(identity, { recursive: true, force: true });
      await arrange();
      await writeFile(f.toolLog, "");
      const before = await snapshot(f.root);
      const result = await activate();
      expect({ kind, exitCode: result.exitCode }).toEqual({ kind, exitCode: 1 });
      expect(result.stderr).toContain("No valid installation-id");
      expect(await snapshot(f.root)).toEqual(before);
      expect(await readFile(f.toolLog, "utf8")).toBe("");
    }
    // The control: the same activation with an established identity binds, and keeps it.
    await rm(identity, { recursive: true, force: true });
    await writeFile(identity, `${IDENTITY}\n`, { mode: 0o600 });
    expect(await activate()).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readFile(identity, "utf8")).toBe(`${IDENTITY}\n`);
  } finally {
    await f.dispose();
  }
});
