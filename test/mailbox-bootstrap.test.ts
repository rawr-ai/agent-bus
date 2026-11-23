import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, type FileSystem } from "effect";
import { initializeInstallation, loadInstallation } from "../src/installation.ts";
import {
  completeMailboxBootstrap,
  inspectMailboxBootstrap,
  MAILBOX_BOOTSTRAP_COMPLETE_FILE,
  MAILBOX_BOOTSTRAP_GRANT_FILE,
  MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE,
  MAILBOX_BOOTSTRAP_INIT_FILE,
  MAILBOX_BOOTSTRAP_SPENT_FILE,
  reserveMailboxBootstrap,
  spendMailboxBootstrap,
} from "../src/mailbox-bootstrap.ts";
import { ownership } from "./processes.ts";
import { spawnSupervised } from "./supervised.ts";

const target = { url: "http://127.0.0.1:8095", ledger: "fixture:main" };
const identity = "00000000-0000-4000-8000-000000000001";
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.provide(effect, BunFileSystem.layer));

const fixture = () => mkdtemp(join(tmpdir(), "agent-bus-bootstrap-"));
const cleanup = (dir: string) => rm(dir, { recursive: true, force: true });

test("CLI requires both target flags for a grant while preserving targetless initialization", async () => {
  const dirs = await Promise.all([
    fixture(),
    fixture(),
    fixture(),
    fixture(),
    fixture(),
    fixture(),
  ]);
  try {
    const home = dirs[5];
    if (home === undefined) throw new Error();
    const cli = (dir: string, args: string[]) =>
      Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "../src/bin.ts"),
          "initialize-installation",
          ...args,
        ],
        {
          env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", AGENT_BUS_DIR: dir },
          timeout: 5_000,
        }
      );
    const [targeted, standalone, half, fromConfig, damaged] = dirs;
    if (
      targeted === undefined ||
      standalone === undefined ||
      half === undefined ||
      fromConfig === undefined ||
      damaged === undefined
    )
      throw new Error();
    expect(
      cli(targeted, ["--fluree-url", target.url, "--fluree-ledger", target.ledger]).exitCode
    ).toBe(0);
    const targetedId = await run(loadInstallation(targeted));
    expect(await run(inspectMailboxBootstrap(targeted, targetedId, target))).toEqual({
      kind: "unspent",
    });
    await writeFile(join(damaged, "config.json"), JSON.stringify({ fluree: target }));
    expect(
      cli(damaged, ["--fluree-url", target.url, "--fluree-ledger", target.ledger]).exitCode
    ).toBe(1);
    expect(await Bun.file(join(damaged, "installation-id")).exists()).toBe(false);
    expect(await Bun.file(join(damaged, MAILBOX_BOOTSTRAP_INIT_FILE)).exists()).toBe(false);
    expect(cli(standalone, []).exitCode).toBe(0);
    const standaloneId = await run(loadInstallation(standalone));
    expect(await run(inspectMailboxBootstrap(standalone, standaloneId, target))).toEqual({
      kind: "ungranted",
    });
    expect(cli(half, ["--fluree-url", target.url]).exitCode).toBe(1);
    expect(await Bun.file(join(half, "installation-id")).exists()).toBe(false);
    await writeFile(join(fromConfig, "config.json"), JSON.stringify({ fluree: target }));
    expect(cli(fromConfig, []).exitCode).toBe(1);
    expect(await Bun.file(join(fromConfig, "installation-id")).exists()).toBe(false);
  } finally {
    await Promise.all(dirs.map(cleanup));
  }
});

test("new targeted identity receives an exclusive private grant, never an existing identity", async () => {
  const dir = await fixture();
  const existing = await fixture();
  try {
    await run(initializeInstallation(dir, target));
    const id = await run(loadInstallation(dir));
    expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({ kind: "unspent" });
    for (const name of [MAILBOX_BOOTSTRAP_INIT_FILE, MAILBOX_BOOTSTRAP_GRANT_FILE]) {
      expect((await lstat(join(dir, name))).mode & 0o777).toBe(0o600);
      const record = JSON.parse(await readFile(join(dir, name), "utf8"));
      expect(record).toMatchObject({ installation: id, ...target });
    }
    await run(initializeInstallation(dir, target));
    await expect(
      run(initializeInstallation(dir, { ...target, ledger: "other:main" }))
    ).rejects.toThrow();

    await run(initializeInstallation(existing));
    const old = await run(loadInstallation(existing));
    await run(initializeInstallation(existing, target));
    expect(await run(inspectMailboxBootstrap(existing, old, target))).toEqual({
      kind: "ungranted",
    });
    expect(await Bun.file(join(existing, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
  } finally {
    await cleanup(dir);
    await cleanup(existing);
  }
});

test("reservation without identity or grant never becomes an ordinary existing identity", async () => {
  const dir = await fixture();
  try {
    await run(reserveMailboxBootstrap(dir, identity, target));
    await expect(run(inspectMailboxBootstrap(dir, identity, target))).rejects.toThrow();
    await expect(run(initializeInstallation(dir))).rejects.toThrow();
    await expect(run(initializeInstallation(dir, target))).rejects.toThrow();
    await writeFile(join(dir, "installation-id"), `${identity}\n`, { mode: 0o600 });
    await expect(run(inspectMailboxBootstrap(dir, identity, target))).rejects.toThrow();
    await expect(run(initializeInstallation(dir, target))).rejects.toThrow();
    expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
  } finally {
    await cleanup(dir);
  }
});

test("identity-only pending evidence refuses before and after the ID link", async () => {
  const dir = await fixture();
  try {
    await writeFile(
      join(dir, MAILBOX_BOOTSTRAP_INIT_FILE),
      JSON.stringify({
        version: 1,
        installation: identity,
        kind: "identity-only-initializing",
      }),
      { mode: 0o600 }
    );
    await expect(run(initializeInstallation(dir))).rejects.toThrow();
    await expect(run(initializeInstallation(dir, target))).rejects.toThrow();
    await writeFile(join(dir, "installation-id"), `${identity}\n`, { mode: 0o600 });
    await expect(run(inspectMailboxBootstrap(dir, identity, target))).rejects.toThrow();
    await expect(run(initializeInstallation(dir))).rejects.toThrow();
    expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE)).exists()).toBe(
      false
    );
  } finally {
    await cleanup(dir);
  }
});

test("a delayed targeted claimant cannot poison a completed identity-only initialization", async () => {
  const dir = await fixture();
  try {
    expect(await readdir(dir)).toEqual([]);
    await run(initializeInstallation(dir));
    const id = await run(loadInstallation(dir));
    const before = await readFile(join(dir, MAILBOX_BOOTSTRAP_INIT_FILE), "utf8");
    await expect(run(reserveMailboxBootstrap(dir, identity, target))).rejects.toThrow();
    expect(await run(loadInstallation(dir))).toBe(id);
    expect(await readFile(join(dir, MAILBOX_BOOTSTRAP_INIT_FILE), "utf8")).toBe(before);
    expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({ kind: "ungranted" });
    expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
  } finally {
    await cleanup(dir);
  }
});

test("a targeted claimant paused after its empty read cannot poison a completed identity-only initialization", async () => {
  const root = await fixture();
  const dir = join(root, "state");
  const ready = join(root, "ready");
  const release = join(root, "release");
  const script = join(root, "paused-claim.test.ts");
  const owned = ownership();
  try {
    await mkdir(dir);
    await writeFile(
      script,
      `
import { expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import * as original from "node:fs/promises";
const real = { ...original };
let paused = false;
mock.module("node:fs/promises", () => ({
  ...real,
  readdir: async (...args) => {
    const result = await real.readdir(...args);
    if (!paused && args[0] === process.env.RACE_STATE && result.length === 0) {
      paused = true;
      await real.writeFile(process.env.RACE_READY, "ready");
      while (!existsSync(process.env.RACE_RELEASE)) await Bun.sleep(5);
    }
    return result;
  },
}));
const { Effect } = await import(${JSON.stringify(join(import.meta.dir, "../node_modules/effect/dist/index.js"))});
const { reserveMailboxBootstrap } = await import(${JSON.stringify(join(import.meta.dir, "../src/mailbox-bootstrap.ts"))});
test("the stale empty observation cannot claim the occupied slot", async () => {
  await expect(Effect.runPromise(reserveMailboxBootstrap(
    process.env.RACE_STATE, ${JSON.stringify(identity)}, ${JSON.stringify(target)}
  ))).rejects.toThrow();
});
`
    );
    const child = owned.supervisor(
      spawnSupervised([process.execPath, "--no-env-file", "test", script], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HOME: root,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          RACE_STATE: dir,
          RACE_READY: ready,
          RACE_RELEASE: release,
        },
      })
    );
    let observed = false;
    for (let attempt = 0; attempt < 500 && child.exitCode === null; attempt++) {
      if (await Bun.file(ready).exists()) {
        observed = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(observed).toBe(true);
    await run(initializeInstallation(dir));
    const id = await run(loadInstallation(dir));
    const reservation = await readFile(join(dir, MAILBOX_BOOTSTRAP_INIT_FILE), "utf8");
    await writeFile(release, "go");
    expect(await child.exited).toBe(0);
    expect(await run(loadInstallation(dir))).toBe(id);
    expect(await readFile(join(dir, MAILBOX_BOOTSTRAP_INIT_FILE), "utf8")).toBe(reservation);
    expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({ kind: "ungranted" });
    expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
  } finally {
    await owned.stop();
    await cleanup(root);
  }
}, 20_000);

test("a durable spend without completion always refuses another dispatch", async () => {
  const dir = await fixture();
  try {
    await run(initializeInstallation(dir, target));
    const id = await run(loadInstallation(dir));
    await run(spendMailboxBootstrap(dir, id, target, false));
    const spent = await readFile(join(dir, MAILBOX_BOOTSTRAP_SPENT_FILE), "utf8");
    expect(JSON.parse(spent)).toMatchObject({ observed: "absent", installation: id });
    expect((await lstat(join(dir, MAILBOX_BOOTSTRAP_SPENT_FILE))).mode & 0o777).toBe(0o600);
    await expect(run(inspectMailboxBootstrap(dir, id, target))).rejects.toThrow();
    await expect(run(spendMailboxBootstrap(dir, id, target, false))).rejects.toThrow();
    await expect(run(initializeInstallation(dir, target))).rejects.toThrow();
    expect(await readFile(join(dir, MAILBOX_BOOTSTRAP_SPENT_FILE), "utf8")).toBe(spent);
    await run(completeMailboxBootstrap(dir, id, target, "first-commit", "grant"));
    expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({
      kind: "complete",
      incarnation: "first-commit",
    });
    await expect(
      run(completeMailboxBootstrap(dir, id, target, "another", "grant"))
    ).rejects.toThrow();
  } finally {
    await cleanup(dir);
  }
});

test("an ungranted identity may retain only an existing-ledger binding", async () => {
  const dir = await fixture();
  try {
    await run(initializeInstallation(dir));
    const id = await run(loadInstallation(dir));
    await expect(run(spendMailboxBootstrap(dir, id, target, false))).rejects.toThrow();
    await expect(
      run(completeMailboxBootstrap(dir, id, target, "incarnation", "grant"))
    ).rejects.toThrow();
    await run(completeMailboxBootstrap(dir, id, target, "incarnation", "existing"));
    expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({
      kind: "complete",
      incarnation: "incarnation",
    });
    expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
    await expect(
      run(inspectMailboxBootstrap(dir, id, { ...target, url: "http://127.0.0.1:9999" }))
    ).rejects.toThrow();
  } finally {
    await cleanup(dir);
  }
});

test("foreign, partial, oversized, symlinked and nonprivate evidence fails without replacement", async () => {
  for (const damage of ["foreign", "partial", "oversized", "symlink", "mode"] as const) {
    const dir = await fixture();
    try {
      await run(initializeInstallation(dir, target));
      const id = await run(loadInstallation(dir));
      const path = join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE);
      if (damage === "foreign") {
        const grant = JSON.parse(await readFile(path, "utf8"));
        await writeFile(
          path,
          JSON.stringify({ ...grant, installation: "00000000-0000-4000-8000-000000000002" })
        );
      } else if (damage === "partial") await writeFile(path, "{");
      else if (damage === "oversized") await writeFile(path, "x".repeat(8193));
      else if (damage === "mode") await chmod(path, 0o644);
      else {
        await rm(path);
        await symlink("missing-target", path);
      }
      await expect(run(inspectMailboxBootstrap(dir, id, target))).rejects.toThrow();
      await expect(run(initializeInstallation(dir, target))).rejects.toThrow();
      expect((await lstat(path)).isSymbolicLink()).toBe(damage === "symlink");
    } finally {
      await cleanup(dir);
    }
  }
});

test("an altered initialization reservation is never treated as an old ungranted identity", async () => {
  for (const damage of ["foreign", "partial", "oversized", "symlink"] as const) {
    const dir = await fixture();
    try {
      await run(reserveMailboxBootstrap(dir, identity, target));
      await writeFile(join(dir, "installation-id"), `${identity}\n`, { mode: 0o600 });
      const path = join(dir, MAILBOX_BOOTSTRAP_INIT_FILE);
      if (damage === "foreign") {
        const reservation = JSON.parse(await readFile(path, "utf8"));
        await writeFile(path, JSON.stringify({ ...reservation, ledger: "foreign:main" }));
      } else if (damage === "partial") await writeFile(path, "{");
      else if (damage === "oversized") await writeFile(path, "x".repeat(8193));
      else {
        await rm(path);
        await symlink("missing-target", path);
      }
      await expect(run(inspectMailboxBootstrap(dir, identity, target))).rejects.toThrow();
      await expect(run(initializeInstallation(dir))).rejects.toThrow();
      expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
    } finally {
      await cleanup(dir);
    }
  }
});

test("credential-bearing targets are refused before a grant can expose them", async () => {
  for (const url of [
    "http://user:secret@127.0.0.1:8095",
    "http://127.0.0.1:8095/?token=secret",
    "http://127.0.0.1:8095/api",
  ]) {
    const dir = await fixture();
    try {
      await expect(run(initializeInstallation(dir, { ...target, url }))).rejects.toThrow();
      expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_INIT_FILE)).exists()).toBe(false);
      expect(await Bun.file(join(dir, "installation-id")).exists()).toBe(false);
    } finally {
      await cleanup(dir);
    }
  }
});

test("neither initializer replaces a lost ID beside any established state", async () => {
  for (const entry of [
    "config.json",
    "fluree-token",
    "fluree-key.json",
    "fluree",
    "fluree-cursors",
    "agent-bus.log",
    "unknown-state",
  ]) {
    for (const targeted of [false, true]) {
      const dir = await fixture();
      try {
        const path = join(dir, entry);
        if (entry === "fluree" || entry === "fluree-cursors") await mkdir(path);
        else await writeFile(path, "retain-this-state");
        await expect(
          run(initializeInstallation(dir, targeted ? target : undefined))
        ).rejects.toThrow();
        expect(await Bun.file(join(dir, "installation-id")).exists()).toBe(false);
        expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_INIT_FILE)).exists()).toBe(false);
        expect(await Bun.file(join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists()).toBe(false);
        expect((await lstat(path)).isDirectory()).toBe(
          entry === "fluree" || entry === "fluree-cursors"
        );
        if (entry !== "fluree" && entry !== "fluree-cursors")
          expect(await readFile(path, "utf8")).toBe("retain-this-state");
      } finally {
        await cleanup(dir);
      }
    }
  }
});

test("competing targeted and targetless initializers cannot mint a grant for another identity", async () => {
  for (const secondTargeted of [true, false]) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const dir = await fixture();
      try {
        const outcomes = await Promise.allSettled([
          run(initializeInstallation(dir, target)),
          run(initializeInstallation(dir, secondTargeted ? target : undefined)),
        ]);
        const id = await run(loadInstallation(dir));
        const hasReservation = await Bun.file(join(dir, MAILBOX_BOOTSTRAP_INIT_FILE)).exists();
        const hasGrant = await Bun.file(join(dir, MAILBOX_BOOTSTRAP_GRANT_FILE)).exists();
        const identityComplete = await Bun.file(
          join(dir, MAILBOX_BOOTSTRAP_IDENTITY_COMPLETE_FILE)
        ).exists();
        if (hasGrant) {
          expect(hasReservation).toBe(true);
          expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({ kind: "unspent" });
        } else if (hasReservation && identityComplete) {
          expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({
            kind: "ungranted",
          });
        } else if (hasReservation) {
          await expect(run(inspectMailboxBootstrap(dir, id, target))).rejects.toThrow();
          expect(outcomes.some((outcome) => outcome.status === "rejected")).toBe(true);
        } else {
          expect(await run(inspectMailboxBootstrap(dir, id, target))).toEqual({
            kind: "ungranted",
          });
        }
      } finally {
        await cleanup(dir);
      }
    }
  }
});
