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
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, type FileSystem } from "effect";
import { releaseLauncher, removeOwned } from "../scripts/release.ts";
import {
  MAILBOX_BOOTSTRAP_COMPLETE_FILE,
  MAILBOX_BOOTSTRAP_GRANT_FILE,
  MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE,
  MAILBOX_BOOTSTRAP_INIT_FILE,
  MAILBOX_BOOTSTRAP_SPENT_FILE,
} from "../src/mailbox-bootstrap.ts";
import {
  acceptMailboxTransitionPeer,
  assertMailboxTransitionAdmitted,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  MAILBOX_TRANSITION_READY_FILE,
  permitMailboxTransitionServe,
  recordMailboxTransitionReady,
} from "../src/mailbox-transition-admission.ts";
import { buildMailboxTransitionSentinel } from "../src/mailbox-transition-guard.ts";
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

// Release and activation cases run several bounded commands plus fixture setup and cleanup.
const RELEASE_TEST_TIMEOUT_MS = 30_000;

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
    // A first install: the fixture's established identity is not there yet.
    await rm(config);
    await rm(identity);
    // Stub only the CLI command; installation.test.ts exercises its actual file behavior.
    await writeFile(
      f.entry,
      `import { readFile, writeFile } from "node:fs/promises";
if (process.argv[2] === "initialize-installation") {
  const file = process.env.AGENT_BUS_DIR + "/installation-id";
  await writeFile(process.env.AGENT_BUS_DIR + "/initialize-args.json", JSON.stringify(process.argv.slice(3)));
  await writeFile(process.env.AGENT_BUS_DIR + "/initialize-order.json", JSON.stringify(await readFile(${JSON.stringify(f.toolLog)}, "utf8")));
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
    expect(JSON.parse(await readFile(join(f.bus, "initialize-args.json"), "utf8"))).toEqual([
      "--fluree-url",
      "http://127.0.0.1:47890",
      "--fluree-ledger",
      "agent-bus:main",
    ]);
    expect(JSON.parse(await readFile(join(f.bus, "initialize-order.json"), "utf8"))).toBe("");
    const first = await readFile(identity, "utf8");

    expect(await f.install(["--bun", f.bunA])).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await Bun.file(config).exists()).toBe(true);
    expect(await readFile(identity, "utf8")).toBe(first);

    await rm(identity);
    const missingIdentity = await f.install(["--bun", f.bunA], { FAIL_INITIALIZE: "1" });
    expect(missingIdentity.exitCode).toBe(1);
    expect(missingIdentity.stderr).toContain(
      "owned serve LaunchAgent requires its original valid installation-id"
    );
    expect(await f.install(undefined, { FAIL_INITIALIZE: "1" })).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(await Bun.file(identity).exists()).toBe(false);

    // Without an attributed job, the retained-cursor check still protects an incomplete root.
    await rm(f.plist);
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

test.skipIf(process.platform !== "darwin")(
  "a retained owned serve job prevents full installation into its missing state root",
  async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      await rm(f.bus, { recursive: true });
      await writeFile(f.toolLog, "");
      const before = await snapshot(f.root);
      for (const args of [
        ["--bun", f.bunA],
        ["--remote", "fixture-host", "--bun", f.bunA],
      ]) {
        const result = await f.install(args, { AGENT_BUS_PORT: "47895" });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "owned serve LaunchAgent refers to a missing installation root"
        );
        expect(await snapshot(f.root)).toEqual(before);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      }

      // A job relying on launchd's HOME default names the default root too.
      await writeJob(f.plist, {
        Label: f.label,
        ProgramArguments: [f.launcher, "serve"],
        EnvironmentVariables: { HOME: f.home },
      });
      const defaultRoot = join(f.home, ".agent-bus");
      const defaultBefore = await snapshot(f.root);
      const result = await f.install(["--bun", f.bunA], { AGENT_BUS_DIR: "" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "owned serve LaunchAgent refers to a missing installation root"
      );
      expect(existsSync(defaultRoot)).toBe(false);
      expect(await snapshot(f.root)).toEqual(defaultBefore);
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "a retained owned job refuses an empty root or missing, invalid or linked identity before writes",
  async () => {
    for (const kind of [
      "empty-root",
      "missing-identity",
      "empty-identity",
      "invalid-identity",
      "identity-directory",
      "identity-link",
      "broken-identity-link",
      "root-link",
    ]) {
      const f = await fixture();
      try {
        expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
        await writeFile(
          f.entry,
          `if (process.argv[2] === "initialize-installation") { console.log("initializer reached"); process.exit(42); }\n`
        );
        const identity = join(f.bus, "installation-id");
        if (kind === "empty-root") {
          await rm(f.bus, { recursive: true });
          await mkdir(f.bus);
        } else if (kind === "root-link") {
          const target = join(f.root, "linked-state-target");
          renameSync(f.bus, target);
          await symlink(target, f.bus);
        } else {
          await rm(identity);
          if (kind === "empty-identity") await writeFile(identity, "");
          if (kind === "invalid-identity") await writeFile(identity, `${IDENTITY}\nextra`);
          if (kind === "identity-directory") await mkdir(identity);
          if (kind === "identity-link") {
            const target = join(f.root, "linked-identity-target");
            await writeFile(target, `${IDENTITY}\n`);
            await symlink(target, identity);
          }
          if (kind === "broken-identity-link")
            await symlink(join(f.root, "missing-identity"), identity);
        }
        await writeFile(f.toolLog, "");
        const before = await snapshot(f.root);
        for (const args of [
          ["--bun", f.bunA],
          ["--remote", "fixture-host", "--bun", f.bunA],
        ]) {
          const result = await f.install(args, { AGENT_BUS_PORT: "47895" });
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            kind === "root-link"
              ? "owned serve LaunchAgent refers to an unsafe installation root"
              : "owned serve LaunchAgent requires its original valid installation-id"
          );
          expect(result.stdout).not.toContain("initializer reached");
          expect(await snapshot(f.root)).toEqual(before);
          expect(await readFile(f.toolLog, "utf8")).toBe("");
        }
      } finally {
        await f.dispose();
      }
    }
  },
  RELEASE_TEST_TIMEOUT_MS
);

test.skipIf(process.platform !== "darwin")(
  "a retained owned job allows a valid original identity when config is absent",
  async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      await writeFile(
        f.entry,
        `if (process.argv[2] === "initialize-installation") { console.log("initializer reached"); process.exit(42); }\n`
      );
      await rm(join(f.bus, "config.json"));
      const identity = await readFile(join(f.bus, "installation-id"));
      await writeFile(f.toolLog, "");
      for (const args of [
        ["--bun", f.bunA],
        ["--remote", "fixture-host", "--bun", f.bunA],
      ]) {
        const result = await f.install(args);
        expect(result.exitCode).toBe(42);
        expect(result.stdout).toContain("initializer reached");
        expect(await readFile(join(f.bus, "installation-id"))).toEqual(identity);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      }
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "a conflicting or unknown same-label job refuses before initializing an absent or empty root",
  async () => {
    for (const kind of [
      "launcher",
      "label",
      "other-root",
      "extra-args",
      "program",
      "malformed",
      "directory",
      "symlink",
      "broken-link",
    ]) {
      const f = await fixture();
      try {
        await writeFile(
          f.entry,
          `if (process.argv[2] === "initialize-installation") { console.log("initializer reached"); process.exit(42); }\n`
        );
        const job = {
          Label: kind === "label" ? "another.label" : f.label,
          ProgramArguments: [
            kind === "launcher" ? join(f.root, "foreign") : f.launcher,
            "serve",
            ...(kind === "extra-args" ? ["--other"] : []),
          ],
          ...(kind === "program" ? { Program: join(f.root, "foreign") } : {}),
          EnvironmentVariables: {
            AGENT_BUS_DIR: kind === "other-root" ? join(f.root, "other") : f.bus,
          },
        };
        if (kind === "malformed") {
          await writeFile(f.plist, "not a plist\n");
        } else if (kind === "directory") {
          await mkdir(f.plist);
        } else if (kind === "broken-link") {
          await symlink(join(f.root, "missing-plist"), f.plist);
        } else if (kind === "symlink") {
          const target = join(f.root, "foreign-link-target.plist");
          await writeJob(target, job);
          await symlink(target, f.plist);
        } else {
          await writeJob(f.plist, job);
        }
        await rm(f.bus, { recursive: true });
        if (kind === "malformed" || kind === "symlink") await mkdir(f.bus);
        const before = await snapshot(f.root);
        for (const args of [
          ["--bun", f.bunA],
          ["--remote", "fixture-host", "--bun", f.bunA],
        ]) {
          const result = await f.install(args);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain("cannot be attributed to the exact requested state root");
          expect(result.stderr).not.toContain("requires its original valid installation-id");
          expect(result.stdout).not.toContain("initializer reached");
          expect(await snapshot(f.root)).toEqual(before);
          expect(await readFile(f.toolLog, "utf8")).toBe("");
        }
      } finally {
        await f.dispose();
      }
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "an unreadable same-label plist refuses before initializing a missing root",
  async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.entry,
        `if (process.argv[2] === "initialize-installation") { console.log("initializer reached"); process.exit(42); }\n`
      );
      await writeJob(f.plist, {
        Label: f.label,
        ProgramArguments: [f.launcher, "serve"],
        EnvironmentVariables: { AGENT_BUS_DIR: f.bus },
      });
      await rm(f.bus, { recursive: true });
      const before = await snapshot(f.root);
      chmodSync(f.plist, 0);
      for (const args of [
        ["--bun", f.bunA],
        ["--remote", "fixture-host", "--bun", f.bunA],
      ]) {
        const result = await f.install(args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("cannot be attributed to the exact requested state root");
        expect(result.stdout).not.toContain("initializer reached");
        expect((await lstat(f.plist)).mode & 0o777).toBe(0);
        expect(existsSync(f.bus)).toBe(false);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      }
      chmodSync(f.plist, 0o644);
      expect(await snapshot(f.root)).toEqual(before);
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "same-label jobs cannot be rebound through dot, slash or symlink aliases of their state root",
  async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      await writeFile(
        f.entry,
        `if (process.argv[2] === "initialize-installation") { console.log("initializer reached"); process.exit(42); }\n`
      );
      await rm(f.bus, { recursive: true });
      await mkdir(f.bus);
      const alias = join(f.root, "state-alias");
      await symlink(f.bus, alias);
      await writeFile(f.toolLog, "");
      for (const requested of [`${f.bus}/.`, `${f.bus}/`, alias]) {
        const before = await snapshot(f.root);
        for (const args of [
          ["--bun", f.bunA],
          ["--remote", "fixture-host", "--bun", f.bunA],
        ]) {
          const result = await f.install(args, { AGENT_BUS_DIR: requested });
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain("cannot be attributed to the exact requested state root");
          expect(result.stdout).not.toContain("initializer reached");
          expect(await snapshot(f.root)).toEqual(before);
          expect(await readFile(f.toolLog, "utf8")).toBe("");
        }
      }

      // Also refuse when the plist contains the alias and the request uses the real path.
      await writeJob(f.plist, {
        Label: f.label,
        ProgramArguments: [f.launcher, "serve"],
        EnvironmentVariables: { AGENT_BUS_DIR: alias },
      });
      const before = await snapshot(f.root);
      for (const args of [
        ["--bun", f.bunA],
        ["--remote", "fixture-host", "--bun", f.bunA],
      ]) {
        const result = await f.install(args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("cannot be attributed to the exact requested state root");
        expect(result.stdout).not.toContain("initializer reached");
        expect(await snapshot(f.root)).toEqual(before);
      }
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "an identical alias spelling still requires and preserves the original identity",
  async () => {
    const f = await fixture();
    try {
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      await writeFile(
        f.entry,
        `if (process.argv[2] === "initialize-installation") { console.log("initializer reached"); process.exit(42); }\n`
      );
      await rm(f.bus, { recursive: true });
      await mkdir(f.bus);
      const homeAlias = join(f.root, "home-alias");
      await symlink(f.home, homeAlias);
      const paths = [`${f.bus}/.`, join(homeAlias, f.bus.slice(f.home.length + 1))];
      await writeFile(f.toolLog, "");
      for (const requested of paths) {
        await writeJob(f.plist, {
          Label: f.label,
          ProgramArguments: [f.launcher, "serve"],
          EnvironmentVariables: { AGENT_BUS_DIR: requested },
        });
        const missing = await snapshot(f.root);
        for (const args of [
          ["--bun", f.bunA],
          ["--remote", "fixture-host", "--bun", f.bunA],
        ]) {
          const result = await f.install(args, { AGENT_BUS_DIR: requested });
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain("requires its original valid installation-id");
          expect(result.stdout).not.toContain("initializer reached");
          expect(await snapshot(f.root)).toEqual(missing);
        }
        const identity = join(f.bus, "installation-id");
        await writeFile(identity, `${IDENTITY}\n`);
        for (const args of [
          ["--bun", f.bunA],
          ["--remote", "fixture-host", "--bun", f.bunA],
        ]) {
          const result = await f.install(args, { AGENT_BUS_DIR: requested });
          expect(result.exitCode).toBe(42);
          expect(result.stdout).toContain("initializer reached");
          expect(await readFile(identity, "utf8")).toBe(`${IDENTITY}\n`);
          expect(await readFile(f.toolLog, "utf8")).toBe("");
        }
        await rm(identity);
      }
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "a differently named job does not prevent a genuine fresh installation",
  async () => {
    const f = await fixture();
    try {
      const other = join(f.agents, "other.agent-bus.plist");
      await writeJob(other, {
        Label: "other.agent-bus",
        ProgramArguments: [f.launcher, "serve"],
        EnvironmentVariables: { AGENT_BUS_DIR: join(f.root, "other-state") },
      });
      await writeFile(
        f.entry,
        `if (process.argv[2] === "initialize-installation") { console.log("initializer reached"); process.exit(42); }\n`
      );
      await rm(f.bus, { recursive: true });
      const before = await snapshot(other);
      for (const args of [
        ["--bun", f.bunA],
        ["--remote", "fixture-host", "--bun", f.bunA],
      ]) {
        const result = await f.install(args);
        expect(result.exitCode).toBe(42);
        expect(result.stdout).toContain("initializer reached");
        expect(await snapshot(other)).toEqual(before);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      }
    } finally {
      await f.dispose();
    }
  }
);

test("fresh remote attachment initializes identity only and keeps identity and config on retry", async () => {
  const f = await fixture();
  try {
    const config = join(f.bus, "config.json");
    const identity = join(f.bus, "installation-id");
    await rm(config);
    await rm(identity);
    await writeFile(
      f.entry,
      `import { readFile, writeFile } from "node:fs/promises";
if (process.argv[2] === "initialize-installation") {
  const file = process.env.AGENT_BUS_DIR + "/installation-id";
  await writeFile(process.env.AGENT_BUS_DIR + "/initialize-args.json", JSON.stringify(process.argv.slice(3)));
  await writeFile(process.env.AGENT_BUS_DIR + "/initialize-order.json", JSON.stringify(await readFile(${JSON.stringify(f.toolLog)}, "utf8")));
  try { await writeFile(file, crypto.randomUUID(), { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (process.env.FAIL_INITIALIZE === "1") process.exit(42);
}
`
    );
    await executable(
      join(f.tools, "scp"),
      `printf 'scp %s\\n' "$*" >> ${quote(f.toolLog)}\nfor last; do :; done\nprintf 'fixture.token.signature\\n' > "$last"`
    );
    const args = ["--remote", "fixture-host", "--bun", f.bunA];
    expect(await f.install(args, { FAIL_INITIALIZE: "1" })).toMatchObject({ exitCode: 42 });
    expect(JSON.parse(await readFile(join(f.bus, "initialize-args.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(await readFile(join(f.bus, "initialize-order.json"), "utf8"))).toBe("");
    expect(await Bun.file(config).exists()).toBe(false);
    expect(await readFile(f.toolLog, "utf8")).toBe("");
    const first = await readFile(identity, "utf8");
    expect(await f.install(args)).toMatchObject({ exitCode: 0, stderr: "" });
    const establishedConfig = await readFile(config, "utf8");
    expect(JSON.parse(establishedConfig)).toEqual({
      fluree: { url: "http://127.0.0.1:47890", ledger: "agent-bus:main" },
    });
    expect(await readFile(identity, "utf8")).toBe(first);
    expect(await f.install(args, { FAIL_INITIALIZE: "1" })).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(await readFile(identity, "utf8")).toBe(first);
    expect(await readFile(config, "utf8")).toBe(establishedConfig);
  } finally {
    await f.dispose();
  }
});

test(
  "remote preflight preserves incomplete or damaged bootstrap evidence before any installation writes",
  async () => {
    for (const variant of [
      "unspent",
      "partial",
      "malformed-grant",
      "public-grant",
      "grant-link",
      "complete-link",
      "identity-partial",
      "missing-identity",
    ] as const) {
      const f = await fixture();
      try {
        const record = {
          version: 1,
          installation: IDENTITY,
          url: "http://127.0.0.1:47890",
          ledger: "agent-bus:main",
        };
        const write = (name: string, value: object) =>
          writeFile(join(f.bus, name), JSON.stringify(value), { mode: 0o600 });
        if (variant === "identity-partial") {
          await write(MAILBOX_BOOTSTRAP_INIT_FILE, {
            version: 1,
            installation: IDENTITY,
            kind: "identity-only-initializing",
          });
        } else {
          await write(MAILBOX_BOOTSTRAP_INIT_FILE, { ...record, kind: "initializing" });
          const grant = { ...record, kind: "grant" };
          if (variant === "grant-link") {
            const target = join(f.root, "foreign-grant");
            await writeFile(target, JSON.stringify(grant), { mode: 0o600 });
            await symlink(target, join(f.bus, MAILBOX_BOOTSTRAP_GRANT_FILE));
          } else if (variant === "malformed-grant") {
            await writeFile(join(f.bus, MAILBOX_BOOTSTRAP_GRANT_FILE), "{", { mode: 0o600 });
          } else {
            await write(MAILBOX_BOOTSTRAP_GRANT_FILE, grant);
            if (variant === "public-grant")
              chmodSync(join(f.bus, MAILBOX_BOOTSTRAP_GRANT_FILE), 0o644);
          }
          if (variant !== "unspent") {
            await write(MAILBOX_BOOTSTRAP_SPENT_FILE, {
              ...record,
              kind: "spent",
              observed: "present",
            });
            const complete = {
              ...record,
              kind: "complete",
              origin: "grant",
              incarnation: "fixture-incarnation",
            };
            if (variant === "complete-link") {
              const target = join(f.root, "foreign-completion");
              await writeFile(target, JSON.stringify(complete), { mode: 0o600 });
              await symlink(target, join(f.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE));
            } else if (variant === "partial") {
              await writeFile(join(f.bus, MAILBOX_BOOTSTRAP_COMPLETE_FILE), "{", { mode: 0o600 });
            } else {
              await write(MAILBOX_BOOTSTRAP_COMPLETE_FILE, complete);
            }
          }
        }
        if (variant === "missing-identity") await rm(join(f.bus, "installation-id"));
        const digest = async () =>
          Bun.CryptoHasher.hash("sha256", JSON.stringify(await snapshot(f.root)), "hex");
        const before = await digest();
        const result = await f.install(["--remote", "fixture-host", "--bun", f.bunA], {
          AGENT_BUS_REPO: resolve(import.meta.dir, ".."),
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Remote attachment refused");
        expect(await digest()).toBe(before);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      } finally {
        await f.dispose();
      }
    }
  },
  RELEASE_TEST_TIMEOUT_MS
);

test(
  "remote preflight keeps an established completed grant binding intact",
  async () => {
    const f = await fixture();
    try {
      const record = {
        version: 1,
        installation: IDENTITY,
        url: "http://127.0.0.1:47890",
        ledger: "agent-bus:main",
      };
      for (const [name, value] of [
        [MAILBOX_BOOTSTRAP_INIT_FILE, { ...record, kind: "initializing" }],
        [MAILBOX_BOOTSTRAP_GRANT_FILE, { ...record, kind: "grant" }],
        [MAILBOX_BOOTSTRAP_SPENT_FILE, { ...record, kind: "spent", observed: "present" }],
        [
          MAILBOX_BOOTSTRAP_COMPLETE_FILE,
          { ...record, kind: "complete", origin: "grant", incarnation: "fixture-incarnation" },
        ],
      ] as const) {
        await writeFile(join(f.bus, name), JSON.stringify(value), { mode: 0o600 });
      }
      await executable(
        join(f.tools, "scp"),
        `printf 'scp %s\\n' "$*" >> ${quote(f.toolLog)}\nfor last; do :; done\nprintf 'existing.token.signature\\n' > "$last"`
      );
      const identity = await readFile(join(f.bus, "installation-id"));
      const config = await readFile(join(f.bus, "config.json"));
      const evidence = await Promise.all(
        [
          MAILBOX_BOOTSTRAP_INIT_FILE,
          MAILBOX_BOOTSTRAP_GRANT_FILE,
          MAILBOX_BOOTSTRAP_SPENT_FILE,
          MAILBOX_BOOTSTRAP_COMPLETE_FILE,
        ].map((name) => readFile(join(f.bus, name)))
      );
      expect(
        await f.install(["--remote", "fixture-host", "--bun", f.bunA], {
          AGENT_BUS_REPO: resolve(import.meta.dir, ".."),
        })
      ).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await readFile(join(f.bus, "installation-id"))).toEqual(identity);
      expect(await readFile(join(f.bus, "config.json"))).toEqual(config);
      expect(
        await Promise.all(
          [
            MAILBOX_BOOTSTRAP_INIT_FILE,
            MAILBOX_BOOTSTRAP_GRANT_FILE,
            MAILBOX_BOOTSTRAP_SPENT_FILE,
            MAILBOX_BOOTSTRAP_COMPLETE_FILE,
          ].map((name) => readFile(join(f.bus, name)))
        )
      ).toEqual(evidence);
    } finally {
      await f.dispose();
    }
  },
  RELEASE_TEST_TIMEOUT_MS
);

test(
  "remote preflight accepts a completed identity-only initialization without granting creation",
  async () => {
    const f = await fixture();
    try {
      for (const [name, kind] of [
        [MAILBOX_BOOTSTRAP_INIT_FILE, "identity-only-initializing"],
        [MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE, "identity-only-complete"],
      ] as const) {
        await writeFile(
          join(f.bus, name),
          JSON.stringify({ version: 1, installation: IDENTITY, kind }),
          { mode: 0o600 }
        );
      }
      await executable(
        join(f.tools, "scp"),
        `printf 'scp %s\\n' "$*" >> ${quote(f.toolLog)}\nfor last; do :; done\nprintf 'existing.token.signature\\n' > "$last"`
      );
      const identity = await readFile(join(f.bus, "installation-id"));
      const config = await readFile(join(f.bus, "config.json"));
      expect(
        await f.install(["--remote", "fixture-host", "--bun", f.bunA], {
          AGENT_BUS_REPO: resolve(import.meta.dir, ".."),
        })
      ).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await readFile(join(f.bus, "installation-id"))).toEqual(identity);
      expect(await readFile(join(f.bus, "config.json"))).toEqual(config);
      expect(await Bun.file(join(f.bus, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
    } finally {
      await f.dispose();
    }
  },
  RELEASE_TEST_TIMEOUT_MS
);

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

test(
  "release mode binds the launcher to a verified release without a checkout, and source rollback adopts it",
  async () => {
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
  },
  RELEASE_TEST_TIMEOUT_MS
);

test(
  "release mode refuses bad arguments, unverified or misplaced releases before any write",
  async () => {
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
        [
          ["--expect", good.digest, "--runtime-only", "--bun", f.bunA],
          "--expect requires --release",
        ],
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
  },
  RELEASE_TEST_TIMEOUT_MS
);

for (const kind of ["marker-only", "appended", "outside-releases", "relative", "dot-release"]) {
  test(
    `refuses a ${kind} release launcher before any write or service operation`,
    async () => {
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
    },
    RELEASE_TEST_TIMEOUT_MS
  );
}

test(
  "release mode hashes each file it runs with system tools before running any of them",
  async () => {
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
  },
  RELEASE_TEST_TIMEOUT_MS
);

test(
  "release mode binds one spelling of the release and refuses the root, . and ..",
  async () => {
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
  },
  RELEASE_TEST_TIMEOUT_MS
);

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

const PEER_IDENTITY = "f0b6c1f5-3d2a-4c7b-9e8f-1a2b3c4d5e6f";
const OPERATION = "018f1234-5678-7abc-8def-0123456789ab";
const GENERATION = "018f1234-5678-7abc-8def-0123456789ac";
const cursorHelp = "Exact-address cursor layout v2: operator-only";

const sourceCli = (probe: string) => `const args = process.argv.slice(2);
if (args.join(" ") === "cursors --help") console.log(${JSON.stringify(cursorHelp)});
else if (args[0] === "serve-admission-capability") { ${probe} }
else console.log("fixture CLI");\n`;

const releaseCli = (id: string, probe: string) => `const args = process.argv.slice(2);
if (args[0] === "--version") console.log(${JSON.stringify(`agent-bus v${id}`)});
else if (args.join(" ") === "cursors --help") console.log(${JSON.stringify(cursorHelp)});
else if (args[0] === "serve-admission-capability") { ${probe} }
else console.log("fixture CLI");\n`;

async function transitionFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const ledger = "agent-bus:main";
  const cut = { incarnation: "fixture-commit", head: 7 };
  const sources = [
    {
      version: 1 as const,
      ledger,
      installation: IDENTITY,
      cut,
      capturedAt: 12,
      digest: "a".repeat(64),
    },
    {
      version: 1 as const,
      ledger,
      installation: PEER_IDENTITY,
      cut,
      capturedAt: 13,
      digest: "b".repeat(64),
    },
  ] as const;
  const sentinel = await Effect.runPromise(
    buildMailboxTransitionSentinel(ledger, sources, IDENTITY, OPERATION)
  );
  const exact = join(
    f.bus,
    "fluree-cursors",
    encodeURIComponent(sentinel.ledger),
    `${sentinel.cut.incarnation}.v2`
  );
  await mkdir(exact, { recursive: true });
  const marker = join(exact, ".export-pending");
  await writeFile(marker, JSON.stringify(sentinel));
  const ready = {
    version: 2,
    operation: OPERATION,
    sourceCommit: "fixture-h-cid",
    verifiedCommit: "fixture-k-cid",
    sources,
    cut: sentinel.cut,
    verifiedAt: { ...sentinel.cut, head: 8 },
    proofDigest: "c".repeat(64),
    installation: IDENTITY,
  };
  return { sentinel, exact, marker, ready, sources };
}

test.skipIf(process.platform !== "darwin")(
  "a capable target accepts production-generated complete paired evidence without changing it",
  async () => {
    const f = await fixture();
    try {
      await writeFile(f.entry, sourceCli('process.stdout.write("r1-h-k-peer-legacy-read-v2\\n");'));
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      const t = await transitionFixture(f);
      const peer = join(f.root, "peer-transition");
      await mkdir(peer);
      const proof = { cut: t.sentinel.cut, verifiedAt: { ...t.sentinel.cut, head: 8 }, rows: [] };
      const checks = { confirmLocalHeld: () => Effect.void, verifyLocalFence: () => Effect.void };
      const common = {
        operation: OPERATION,
        sourceCommit: "fixture-h-cid",
        verifiedCommit: "fixture-k-cid",
        sources: t.sources,
        proof,
      };
      const local = { ...common, busDir: f.bus, localInstallation: IDENTITY };
      const other = { ...common, busDir: peer, localInstallation: PEER_IDENTITY };
      const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
      const localReady = await run(recordMailboxTransitionReady(local, checks));
      const peerReady = await run(recordMailboxTransitionReady(other, checks));
      await run(acceptMailboxTransitionPeer(local, peerReady, checks));
      await run(acceptMailboxTransitionPeer(other, localReady, checks));
      await run(
        permitMailboxTransitionServe(
          {
            busDir: f.bus,
            ledgerName: t.sentinel.ledger,
            incarnation: t.sentinel.cut.incarnation,
            localInstallation: IDENTITY,
          },
          await readFile(join(peer, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE), "utf8"),
          checks
        )
      );
      const before = await snapshot(f.bus);
      expect(await f.install(["--runtime-only", "--bun", f.bunB])).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(await snapshot(f.bus)).toEqual(before);

      // Select the actual candidate source from a verified release-shaped binding,
      // rather than relying only on a stand-in that prints the capability token.
      const id = "1.0.0-e3e3e3e3e3e3";
      const release = await f.release(id);
      const releaseDigest = replaceSealed(
        release.dir,
        "app/cli.js",
        releaseCli(id, 'process.stdout.write("r1-h-k-peer-legacy-read-v2\\n");')
      );
      expect(await f.install(["--release", release.dir, "--expect", releaseDigest])).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(
        await f.install(["--runtime-only", "--bun", f.bunB], {
          AGENT_BUS_REPO: resolve(import.meta.dir, ".."),
        })
      ).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await snapshot(f.bus)).toEqual(before);

      // The installer checks compatibility, not the full canonical admission.
      // A structurally plausible extra field can pass it, but serve's strict
      // admission check rejects that evidence before its fence callback.
      const readyPath = join(f.bus, MAILBOX_TRANSITION_READY_FILE);
      const readyRecord = JSON.parse(await readFile(readyPath, "utf8"));
      await writeFile(readyPath, JSON.stringify({ ...readyRecord, foreign: true }));
      const damaged = await snapshot(f.bus);
      expect(
        await f.install(["--runtime-only", "--bun", f.bunB], {
          AGENT_BUS_REPO: resolve(import.meta.dir, ".."),
        })
      ).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await snapshot(f.bus)).toEqual(damaged);
      let checkedFence = false;
      const result = await run(
        Effect.exit(
          assertMailboxTransitionAdmitted(
            {
              busDir: f.bus,
              ledgerName: t.sentinel.ledger,
              incarnation: t.sentinel.cut.incarnation,
              localInstallation: IDENTITY,
            },
            () =>
              Effect.sync(() => {
                checkedFence = true;
              })
          )
        )
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(checkedFence).toBe(false);
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "paired evidence prevents incompatible source or release rebinding before any surface changes",
  async () => {
    const f = await fixture();
    try {
      await writeFile(f.entry, sourceCli('console.log("old help");'));
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      const legacyId = "1.0.0-e1e1e1e1e1e1";
      const legacy = await f.release(legacyId);
      const legacyDigest = replaceSealed(
        legacy.dir,
        "app/cli.js",
        releaseCli(legacyId, 'console.log("old help");')
      );
      const currentId = "1.0.0-e2e2e2e2e2e2";
      const current = await f.release(currentId);
      const currentDigest = replaceSealed(
        current.dir,
        "app/cli.js",
        releaseCli(currentId, 'process.stdout.write("r1-h-k-peer-legacy-read-v2\\n");')
      );
      const transition = await transitionFixture(f);
      await writeFile(
        join(f.bus, ".mailbox-transition-ready-r1"),
        JSON.stringify(transition.ready)
      );
      await writeFile(f.toolLog, "");
      const before = await snapshot(f.root);
      for (const args of [
        ["--bun", f.bunB],
        ["--runtime-only", "--bun", f.bunB],
        ["--release", legacy.dir, "--expect", legacyDigest],
      ]) {
        const result = await f.install(args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "does not declare the required R1 serve-admission capability"
        );
        expect(await snapshot(f.root)).toEqual(before);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      }

      const state = await snapshot(f.bus);
      const plist = await readFile(f.plist, "utf8");
      expect(await f.install(["--release", current.dir, "--expect", currentDigest])).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(await snapshot(f.bus)).toEqual(state);
      expect(await readFile(f.plist, "utf8")).toBe(plist);
      expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(current.dir));

      await writeFile(f.entry, sourceCli('process.stdout.write("r1-h-k-peer-legacy-read-v2\\n");'));
      expect(await f.install(["--runtime-only", "--bun", f.bunB])).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(await snapshot(f.bus)).toEqual(state);
      expect(await readFile(f.plist, "utf8")).toBe(plist);
    } finally {
      await f.dispose();
    }
  },
  RELEASE_TEST_TIMEOUT_MS
);

test.skipIf(process.platform !== "darwin")(
  "paired evidence requires the exact successful capability response, including its newline",
  async () => {
    const f = await fixture();
    try {
      await writeFile(f.entry, sourceCli('process.stdout.write("r1-h-k-peer-legacy-read-v2\\n");'));
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      await transitionFixture(f);
      for (const probe of [
        'process.stdout.write("r1-h-k-peer-legacy-read-v2");',
        'process.stdout.write("r1-h-k-peer-legacy-read-v2\\n\\n");',
        'process.stdout.write("r1-h-k-peer-legacy-read-v2\\n"); process.exit(1);',
        'process.stdout.write("r1-h-k-peer-v0\\n");',
        'process.stdout.write("r1-h-k-peer-v1\\n");',
        'process.stdout.write("r1-h-k-peer-legacy-read-v2\\0\\n");',
      ]) {
        await writeFile(f.entry, sourceCli(probe));
        await writeFile(f.toolLog, "");
        const before = await snapshot(f.root);
        const result = await f.install(["--runtime-only", "--bun", f.bunB]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "does not declare the required R1 serve-admission capability"
        );
        expect(await snapshot(f.root)).toEqual(before);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      }
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "malformed, foreign, incomplete or linked transition evidence is preserved and refuses rebinding",
  async () => {
    for (const kind of [
      "marker-json",
      "marker-foreign",
      "marker-link",
      "marker-path",
      "marker-installation",
      "record-json",
      "record-previous-ready",
      "record-foreign",
      "record-empty-k",
      "record-wrong-k-incarnation",
      "record-k-at-h",
      "record-wrong-h",
      "record-long-cid",
      "record-wrong-source-version",
      "record-duplicate-admission",
      "record-link",
      "record-without-marker",
      "unknown-record",
    ]) {
      const f = await fixture();
      try {
        await writeFile(
          f.entry,
          sourceCli('process.stdout.write("r1-h-k-peer-legacy-read-v2\\n");')
        );
        expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
        const t = await transitionFixture(f);
        const record = join(f.bus, ".mailbox-transition-ready-r1");
        switch (kind) {
          case "marker-json":
            await writeFile(t.marker, "{");
            break;
          case "marker-foreign":
            await writeFile(t.marker, JSON.stringify({ kind: "foreign" }));
            break;
          case "marker-link":
            await rm(t.marker);
            await writeFile(join(f.root, "marker-target"), JSON.stringify(t.sentinel));
            await symlink(join(f.root, "marker-target"), t.marker);
            break;
          case "marker-path":
            await writeFile(t.marker, JSON.stringify({ ...t.sentinel, ledger: "different:main" }));
            break;
          case "marker-installation":
            await writeFile(
              t.marker,
              JSON.stringify({ ...t.sentinel, installation: PEER_IDENTITY })
            );
            break;
          case "record-json":
            await writeFile(record, "{");
            break;
          case "record-previous-ready":
            await writeFile(record, JSON.stringify({ ...t.ready, version: 1 }));
            break;
          case "record-foreign":
            await writeFile(record, JSON.stringify({ ...t.ready, operation: GENERATION }));
            break;
          case "record-empty-k":
            await writeFile(record, JSON.stringify({ ...t.ready, verifiedAt: {} }));
            break;
          case "record-wrong-k-incarnation":
            await writeFile(
              record,
              JSON.stringify({ ...t.ready, verifiedAt: { incarnation: "other", head: 8 } })
            );
            break;
          case "record-k-at-h":
            await writeFile(record, JSON.stringify({ ...t.ready, verifiedAt: t.ready.cut }));
            break;
          case "record-wrong-h":
            await writeFile(
              record,
              JSON.stringify({ ...t.ready, cut: { ...t.ready.cut, head: 6 } })
            );
            break;
          case "record-long-cid":
            await writeFile(
              record,
              JSON.stringify({ ...t.ready, verifiedCommit: "x".repeat(4097) })
            );
            break;
          case "record-wrong-source-version":
            await writeFile(
              record,
              JSON.stringify({
                ...t.ready,
                sources: [{ ...t.ready.sources[0], version: 2 }, t.ready.sources[1]],
              })
            );
            break;
          case "record-duplicate-admission":
            await writeFile(
              join(f.bus, ".mailbox-transition-admitted-r1"),
              JSON.stringify({ version: 1, attestations: [t.ready, t.ready] })
            );
            break;
          case "record-link":
            await writeFile(join(f.root, "record-target"), JSON.stringify(t.ready));
            await symlink(join(f.root, "record-target"), record);
            break;
          case "record-without-marker":
            await rm(t.marker);
            await writeFile(record, JSON.stringify(t.ready));
            break;
          case "unknown-record":
            await writeFile(join(f.bus, ".mailbox-transition-foreign-r1"), "{}");
            break;
        }
        await writeFile(f.toolLog, "");
        const before = await snapshot(f.root);
        const result = await f.install(["--runtime-only", "--bun", f.bunB]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Mailbox transition binding refused");
        expect(await snapshot(f.root)).toEqual(before);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      } finally {
        await f.dispose();
      }
    }
  },
  RELEASE_TEST_TIMEOUT_MS
);

test.skipIf(process.platform !== "darwin")(
  "an ordinary pending export is not mistaken for paired transition evidence",
  async () => {
    const f = await fixture();
    try {
      await writeFile(f.entry, sourceCli('console.log("old help");'));
      expect(await f.install()).toMatchObject({ exitCode: 0, stderr: "" });
      const t = await transitionFixture(f);
      await writeFile(
        t.marker,
        JSON.stringify({
          generation: GENERATION,
          operation: OPERATION,
          exact: "a".repeat(64),
          original: "b".repeat(64),
          exported: "c".repeat(64),
        })
      );
      const state = await snapshot(f.bus);
      expect(await f.install(["--runtime-only", "--bun", f.bunB])).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(await snapshot(f.bus)).toEqual(state);
    } finally {
      await f.dispose();
    }
  }
);

test.skipIf(process.platform !== "darwin")(
  "an exact-aware current launcher cannot authorize selecting a legacy target against active exact state",
  async () => {
    const f = await fixture();
    try {
      const legacy = await f.release("1.0.0-d1d1d1d1d1d1");
      const nextId = "1.0.0-d2d2d2d2d2d2";
      const next = await f.release(nextId);
      const nextDigest = replaceSealed(
        next.dir,
        "app/cli.js",
        `const args = process.argv.slice(2);
console.log(args[0] === "--version" ? "agent-bus v${nextId}" :
  args.join(" ") === "cursors --help" ? "Exact-address cursor layout v2: operator-only" : "Native CLI help");\n`
      );
      const bindNext = ["--release", next.dir, "--expect", nextDigest];
      const selectOld = ["--release", legacy.dir, "--expect", legacy.digest];
      expect(await f.install(selectOld)).toMatchObject({ exitCode: 0, stderr: "" });
      const parent = join(f.bus, "fluree-cursors", "fixture");
      const old = join(parent, "incarnation");
      const exact = `${old}.v2`;
      await mkdir(old, { recursive: true });
      await mkdir(exact);
      await writeFile(join(old, "fixture%2FA.json"), '{"cursor":2}');
      await writeFile(join(exact, "layout"), '{"fixture":"active"}');
      await writeFile(join(exact, "fixture.json"), '{"address":"fixture/A","cursor":5}');
      expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(legacy.dir));
      expect(await f.install(bindNext)).toMatchObject({ exitCode: 0, stderr: "" });
      await writeFile(f.toolLog, "");
      expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(next.dir));
      const before = await snapshot(f.root);
      // The legacy fixture exits zero for all help requests, like the actual old CLI.
      for (const args of [selectOld, ["--runtime-only", "--bun", f.bunA]]) {
        const refusal = await f.install(args);
        expect(refusal.exitCode).toBe(1);
        expect(refusal.stderr).toContain("does not support the active exact cursor layout");
        expect(await snapshot(f.root)).toEqual(before);
        expect(await readFile(f.toolLog, "utf8")).toBe("");
      }
      expect(await f.install(bindNext)).toMatchObject({ exitCode: 0, stderr: "" });
      // The binder does not convert files; model the already-completed stopped export here.
      await writeFile(join(old, "fixture%2FA.json"), '{"cursor":5}');
      renameSync(exact, `${exact}.saved-fixture`);
      expect(await f.install(selectOld)).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await readFile(f.launcher, "utf8")).toBe(releaseLauncher(legacy.dir));
    } finally {
      await f.dispose();
    }
  },
  RELEASE_TEST_TIMEOUT_MS
);

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
      const unset = { AGENT_BUS_PORT: "", AGENT_BUS_DIR: "" };
      // The kept job's own state directory is the one whose identity a release needs: a valid
      // one in the installer's directory or in HOME's default does not stand in for it.
      const homeDefault = join(f.home, ".agent-bus");
      await mkdir(homeDefault);
      await writeFile(join(homeDefault, "installation-id"), `${IDENTITY}\n`, { mode: 0o600 });
      await writeJob(f.plist, {
        Label: f.label,
        ProgramArguments: [f.launcher, "serve"],
        EnvironmentVariables: { AGENT_BUS_DIR: otherBus, AGENT_BUS_PORT: "47892" },
        KeepAlive: true,
        RunAtLoad: true,
      });
      await writeFile(f.toolLog, "");
      const unidentified = await snapshot(f.root);
      const refused = await f.install(["--release", good.dir, "--expect", good.digest], unset);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(`No valid installation-id in ${otherBus}`);
      expect(await snapshot(f.root)).toEqual(unidentified);
      expect(await readFile(f.toolLog, "utf8")).toBe("");
      await writeFile(join(otherBus, "installation-id"), `${IDENTITY}\n`, { mode: 0o600 });
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
  },
  RELEASE_TEST_TIMEOUT_MS
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
  },
  RELEASE_TEST_TIMEOUT_MS
);

test(
  "an interrupted release activation leaves the job unchanged and the same command recovers",
  async () => {
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
  },
  RELEASE_TEST_TIMEOUT_MS
);

test(
  "release activation needs this installation's identity and creates none",
  async () => {
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
        ["uppercase", () => writeFile(identity, `${IDENTITY.toUpperCase()}\n`)],
        ["not version 4", () => writeFile(identity, `${IDENTITY.replace("-4c7b-", "-3c7b-")}\n`)],
        ["split across lines", () => writeFile(identity, IDENTITY.replace("-1a2b", "-\n1a2b"))],
        ["with a NUL after it", () => writeFile(identity, `${IDENTITY}\0junk\n`)],
        // Stricter than serve, whose trim passes a byte-order mark: restore the file as written.
        ["with a byte-order mark", () => writeFile(identity, `\uFEFF${IDENTITY}\n`)],
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
      // The control: an established identity binds, as written or with the whitespace serve
      // trims, and activation leaves the file exactly as it was.
      for (const written of [
        `${IDENTITY}\n`,
        IDENTITY,
        `${IDENTITY}\r\n`,
        `  ${IDENTITY} \n\n`,
        `\n${IDENTITY}\n`,
      ]) {
        await rm(identity, { recursive: true, force: true });
        await writeFile(identity, written, { mode: 0o600 });
        const entry = async () => {
          const { ino, mtimeNs, mode } = await lstat(identity, { bigint: true });
          return { ino, mtimeNs, mode, bytes: await readFile(identity, "utf8") };
        };
        const before = await entry();
        const result = await activate();
        expect({ written, exitCode: result.exitCode, stderr: result.stderr }).toEqual({
          written,
          exitCode: 0,
          stderr: "",
        });
        // Not rewritten or replaced, even with the same bytes.
        expect(await entry()).toEqual(before);
        expect(before.bytes).toBe(written);
      }
    } finally {
      await f.dispose();
    }
    // Fifteen activations, each a full install-runtime run.
  },
  RELEASE_TEST_TIMEOUT_MS
);
