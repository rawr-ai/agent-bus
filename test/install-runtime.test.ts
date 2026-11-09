import { expect, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
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
import { fakeRelease, mutate, replaceSealed } from "./release-fixture.ts";

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
    `printf 'launchctl %s\\n' "$*" >> ${quote(toolLog)}\n[ "$1" != print ] || exit 1\n[ "$1" != bootstrap ] || [ "\${FAIL_BOOTSTRAP:-}" != 1 ]`
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
    const kind = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file";
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
