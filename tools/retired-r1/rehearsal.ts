// Loaded only by the temporary pinned predecessor test, at the paired permit checkpoint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { MailboxSource } from "../src/mailbox-import.ts";
import type { Pin } from "../src/Query.ts";
import type { ownership } from "./processes.ts";
import { spawnSupervised } from "./supervised.ts";

type Server = { child: ReturnType<typeof spawnSupervised>; port: number; stderr: Promise<string> };
type Fixture = {
  fixture: string;
  roots: readonly [string, string];
  identities: readonly [string, string];
  config: { url: string; ledger: string };
  orderedSources: readonly [MailboxSource, MailboxSource];
  operation: string;
  sourceCommit: string;
  verifiedCommit: string;
  proof: { cut: Pin; verifiedAt: Pin };
  current: Pin;
  currentCommit: string;
  spawn: (root: string) => Server;
  connect: (server: Server) => Promise<Client>;
  stop: (server: Server, client?: Client) => Promise<void>;
  call: (
    client: Client,
    name: string,
    args: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  cutNow: () => Promise<Pin>;
  readCommit: (t: number) => Promise<{ id: string }>;
  insert: (value: unknown) => Promise<void>;
  processes: ReturnType<typeof ownership>;
  allocated: Set<number>;
  acknowledged: string;
  readers: readonly [string, string];
  unread: readonly [string, string];
  legacy: string;
  author: string;
  returning: string;
  returnPending: string;
  vacant: string;
  vacantOld: string;
  session: (address: string) => string;
  newId: string;
  coldCopy: (name: string) => Promise<void>;
  openCopy: (name: string) => Promise<void>;
};
const labels = ["test.agent-bus-r1-retirement-one", "test.agent-bus-r1-retirement-two"] as const;
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const domain = `gui/${process.getuid?.()}`;
const ctl = (...args: string[]) =>
  Bun.spawnSync(["/bin/launchctl", ...args], {
    env: { PATH: systemPath, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
const override = (label: string, state: string) => {
  const list = ctl("print-disabled", domain);
  return (
    list.success &&
    list.stdout
      .toString()
      .split("\n")
      .filter((line) => line.trim().startsWith(`${JSON.stringify(label)} `))
      .map((line) => line.trim())
      .join("\n") === `${JSON.stringify(label)} => ${state}`
  );
};
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const portFree = (port: number) => {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};
const allocate = (ports: Set<number>) => {
  for (;;) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    if (port >= 10_000 && !ports.has(port)) {
      ports.add(port);
      return port;
    }
  }
};
const resultIds = (result: Record<string, unknown>) => {
  assert(Array.isArray(result.messages));
  return result.messages.map((message) => {
    assert(typeof message === "object" && message !== null && typeof message.id === "string");
    return message.id as string;
  });
};

export async function rehearse(f: Fixture) {
  assert.equal(process.platform, "darwin", "Real disposable held-job proof requires macOS.");
  for (const label of labels) {
    assert(
      override(label, "enabled"),
      `Authorize only the dedicated test label ${label} before qualification.`
    );
    assert.equal(ctl("print", `${domain}/${label}`).exitCode, 113);
  }
  const release = process.env.RETIREMENT_RELEASE!;
  const handoff = process.env.RETIREMENT_HANDOFF!;
  const oldPackage = process.env.AGENT_BUS_OLD_RELEASE!;
  const oldDigest = process.env.AGENT_BUS_OLD_RELEASE_SHA256!;
  const cli = [
    join(release, "runtime/bun"),
    "--no-env-file",
    `--config=${join(release, "app/bunfig.toml")}`,
    join(release, "app/cli.js"),
  ];
  const home = join(f.fixture, "synthetic-home");
  mkdirSync(home, { mode: 0o700 });
  const ports = [allocate(f.allocated), allocate(f.allocated)] as const;
  const env = (root: string, index: 0 | 1, port = ports[index]) => ({
    HOME: home,
    PATH: systemPath,
    LC_ALL: "C",
    AGENT_BUS_DIR: realpathSync(root),
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_LABEL: labels[index],
  });
  const invoke = (args: string[], root: string, index: 0 | 1) =>
    Bun.spawnSync(args, {
      cwd: f.fixture,
      env: env(root, index),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
  const binding = (root: string) => join(root, ".serve-binding-v1");
  const held = new Set<string>();
  const sourceFiles = (index: 0 | 1) => {
    const root = f.roots[index];
    const exact = join(
      root,
      "fluree-cursors",
      encodeURIComponent(f.config.ledger),
      `${f.current.incarnation}.v2`
    );
    return {
      sentinelPath: join(exact, ".export-pending"),
      admittedPath: join(root, ".mailbox-transition-admitted-complete-r1"),
      permitPath: join(root, ".mailbox-transition-start-permit-r1"),
    };
  };
  const plan = {
    version: 1,
    ledger: f.config.ledger,
    incarnation: f.current.incarnation,
    operation: f.operation,
    source: { head: f.proof.cut.head, commit: f.sourceCommit },
    imported: { head: f.proof.verifiedAt.head, commit: f.verifiedCommit },
    anchor: { head: f.current.head, commit: f.currentCommit },
    installations: f.orderedSources.map((src) => {
      const { sentinelPath, admittedPath, permitPath } = sourceFiles(
        src.installation === f.identities[0] ? 0 : 1
      );
      return {
        installation: src.installation,
        url: f.config.url,
        digest: src.digest,
        capturedAt: src.capturedAt,
        sentinel: digest(sentinelPath),
        admitted: digest(admittedPath),
        permit: digest(permitPath),
      };
    }),
  };
  assert(plan.anchor.head > plan.imported.head);
  const planFile = join(f.fixture, "handoff-plan.json");
  const approvals = [join(f.fixture, "checked-one"), join(f.fixture, "checked-two")] as const;
  const savePlan = (value: typeof plan) =>
    writeFileSync(planFile, JSON.stringify(value), { mode: 0o600 });
  const hand = (index: 0 | 1, mode: "check" | "publish", peer?: string) =>
    invoke(
      [
        process.execPath,
        "--no-env-file",
        "--config=/dev/null",
        handoff,
        mode,
        "--installation",
        f.identities[index],
        "--plan",
        planFile,
        "--expect-plan",
        digest(planFile),
        ...(peer === undefined
          ? []
          : ["--peer-checked", peer, "--expect-peer-checked", digest(peer)]),
      ],
      f.roots[index],
      index
    );
  const unchanged = async () => assert.deepEqual(await f.cutNow(), f.current);
  const ready = (root: string, index: 0 | 1, ...extra: string[]) => {
    const result = invoke([...cli, "verify-serve-binding", ...extra], root, index);
    return result.success && result.stdout.toString() === "serve-binding-v1\n";
  };
  const serve = async (root: string, index: 0 | 1) => {
    const port = allocate(f.allocated);
    const child = f.processes.supervisor(
      spawnSupervised([...cli, "serve", "--codex", "/usr/bin/false"], {
        cwd: f.fixture,
        env: env(root, index, port),
        stdout: "ignore",
        stderr: "pipe",
      })
    );
    const server = { child, port, stderr: new Response(child.stderr).text() };
    return { server, client: await f.connect(server) };
  };
  const noListener = async (server: Server) => {
    const done = await Promise.race([server.child.exited, Bun.sleep(10_000).then(() => null)]);
    assert(
      done !== null && done !== 0,
      "Refused executable must stop without starting a listener."
    );
    assert(portFree(server.port));
  };
  const read = async (client: Client, address: string) =>
    resultIds(await f.call(client, "bus_read", { address, session: f.session(address) }));
  const failRead = async (client: Client, address: string, session: string) =>
    assert.equal(
      (await client.callTool({ name: "bus_read", arguments: { address, session } })).isError,
      true
    );

  try {
    for (const label of labels) {
      assert(ctl("disable", `${domain}/${label}`).success);
      held.add(label);
      assert(override(label, "disabled"));
    }
    savePlan(plan);
    assert(!ready(f.roots[0], 0));
    assert(!ready(f.roots[1], 1));
    const absent = sourceFiles(1).permitPath;
    const parked = `${absent}.parked`;
    renameSync(absent, parked);
    try {
      assert(!hand(1, "check").success);
    } finally {
      renameSync(parked, absent);
    }
    savePlan({ ...plan, imported: { ...plan.imported, commit: plan.source.commit } });
    assert(!hand(0, "check").success, "A forged K must not be accepted.");
    savePlan(plan);
    for (const index of [0, 1] as const) {
      const result = hand(index, "check");
      assert(result.success, "Exact predecessor verifier rejected a complete held setup.");
      writeFileSync(approvals[index], result.stdout, { mode: 0o600 });
      assert(!existsSync(binding(f.roots[index])));
    }
    assert(!hand(0, "publish", approvals[0]).success, "A local check is not a peer check.");
    assert(hand(0, "publish", approvals[1]).success);
    assert(!existsSync(binding(f.roots[1])), "Neither installer starts in the interrupted state.");
    const intact = digest(binding(f.roots[0]));
    const inode = statSync(binding(f.roots[0])).ino;
    assert(hand(0, "publish", approvals[1]).success);
    assert.equal(statSync(binding(f.roots[0])).ino, inode);
    assert.equal(digest(binding(f.roots[0])), intact);
    writeFileSync(binding(f.roots[1]), "{}", { mode: 0o600, flag: "wx" });
    assert(
      !hand(1, "publish", approvals[0]).success,
      "A conflicting receipt must not be replaced."
    );
    assert.equal(readFileSync(binding(f.roots[1]), "utf8"), "{}");
    rmSync(binding(f.roots[1]));
    assert(hand(1, "publish", approvals[0]).success);
    await unchanged();

    // First prove both successor processes while all R1 originals are retained.
    for (const index of [0, 1] as const) {
      assert(ready(f.roots[index], index));
      const prior = await serve(f.roots[index], index);
      await f.stop(prior.server, prior.client);
    }
    await unchanged();

    // Test an isolated restore root instead of dismantling original transition evidence.
    const state = [join(f.fixture, "successor-one"), join(f.fixture, "successor-two")] as const;
    for (const index of [0, 1] as const) {
      mkdirSync(state[index], { mode: 0o700 });
      for (const name of ["config.json", "fluree-token", "installation-id", ".serve-binding-v1"])
        copyFileSync(join(f.roots[index], name), join(state[index], name));
    }
    const misplaced = join(f.fixture, "wrong-installation");
    cpSync(state[0], misplaced, { recursive: true });
    copyFileSync(join(state[1], "installation-id"), join(misplaced, "installation-id"));
    assert(!ready(misplaced, 0));
    assert(
      !ready(
        state[0],
        0,
        "--expected-recovery-head",
        String(f.current.head + 1),
        "--expected-recovery-commit",
        f.currentCommit
      ),
      "The cut is known to be behind the approved recovery floor."
    );
    await f.coldCopy("below-s");
    await f.openCopy("before-r");
    assert(!ready(state[0], 0), "A physically restored image below R must not pass.");
    while ((await f.cutNow()).head < f.current.head) {
      await f.insert({
        "@id": `urn:fixture:before-r-fork:${(await f.cutNow()).head}`,
        "urn:fixture:branch": "fork",
      });
    }
    assert.equal((await f.cutNow()).incarnation, f.current.incarnation);
    assert.notEqual((await f.readCommit(f.current.head)).id, f.currentCommit);
    assert(!ready(state[0], 0), "A same-incarnation alternative commit at R must not pass.");
    await f.openCopy("below-s");

    const retired = [await serve(state[0], 0), await serve(state[1], 1)] as const;
    await failRead(retired[1].client, f.legacy, f.session(f.legacy));
    await failRead(retired[0].client, f.legacy, "wrong-session");
    assert.deepEqual(await read(retired[0].client, f.legacy), [f.unread[0]]);
    assert.deepEqual(await read(retired[0].client, f.legacy), []);
    const one = await read(retired[0].client, f.readers[0]);
    assert.deepEqual(one, [f.unread[0], f.newId]);
    assert(!one.includes(f.acknowledged));
    assert.deepEqual(await read(retired[1].client, f.readers[1]), [f.unread[1]]);
    await f.call(retired[0].client, "bus_join", {
      address: f.returning,
      session: f.session(f.returning),
      runtime: "other",
      cwd: f.fixture,
      topics: [],
    });
    assert.deepEqual(await read(retired[0].client, f.returning), [f.returnPending]);
    assert.deepEqual(await read(retired[0].client, f.returning), []);
    const nextOwner = f.session(f.vacant) + ":new";
    await f.call(retired[1].client, "bus_join", {
      address: f.vacant,
      session: nextOwner,
      runtime: "other",
      cwd: f.fixture,
      topics: [],
    });
    const vacantRead = resultIds(
      await f.call(retired[1].client, "bus_read", {
        address: f.vacant,
        session: nextOwner,
      })
    );
    assert(!vacantRead.includes(f.vacantOld));
    assert.deepEqual(vacantRead, []);
    const pending = (
      await f.call(retired[0].client, "bus_publish", {
        from: f.author,
        session: f.session(f.author),
        to: [f.readers[1]],
        body: "pending at cold capture",
        operation: Bun.randomUUIDv7(),
      })
    ).id;
    assert.equal(typeof pending, "string");
    for (const item of retired) await f.stop(item.server, item.client);
    const afterAck = await f.cutNow();
    const recoveryCid = (await f.readCommit(afterAck.head)).id;
    const recoveryArgs = [
      "--expected-recovery-head",
      String(afterAck.head),
      "--expected-recovery-commit",
      recoveryCid,
    ];
    await f.coldCopy("post-ack");
    await f.openCopy("below-s");
    assert(ready(state[0], 0), "An R descendant is valid for routine lineage verification.");
    assert(
      !ready(state[0], 0, ...recoveryArgs),
      "A known stale R descendant must not pass a restore check."
    );
    while ((await f.cutNow()).head < afterAck.head) {
      await f.insert({
        "@id": `urn:fixture:after-r-fork:${(await f.cutNow()).head}`,
        "urn:fixture:branch": "fork",
      });
    }
    assert(ready(state[0], 0), "This alternative branch retains the same R.");
    assert(!ready(state[0], 0, ...recoveryArgs), "Reject an incomparable branch at S.");
    await f.openCopy("post-ack");
    assert(
      !ready(state[0], 0, ...recoveryArgs.slice(0, -1), f.currentCommit),
      "Reject an incomparable S."
    );
    for (const index of [0, 1] as const) {
      assert(ready(state[index], index, ...recoveryArgs));
      const restarted = await serve(state[index], index);
      assert.deepEqual(
        await read(restarted.client, f.readers[index]),
        index === 0 ? [] : [pending]
      );
      assert.deepEqual(await read(restarted.client, f.readers[index]), []);
      if (index === 0) assert.deepEqual(await read(restarted.client, f.legacy), []);
      await f.stop(restarted.server, restarted.client);
      assert(!existsSync(join(state[index], "fluree-cursors")));
    }
    const reconciled = await f.cutNow();
    assert.equal(
      reconciled.head,
      afterAck.head + 1,
      "Only the pending post-restore read writes an ACK."
    );

    const launcher = join(home, "do-not-install");
    const old = Bun.spawnSync(
      [
        "/bin/sh",
        join(release, "app/install-launch-agents.sh"),
        "--release",
        oldPackage,
        "--expect",
        oldDigest,
      ],
      {
        cwd: f.fixture,
        env: {
          ...env(state[0], 0),
          AGENT_BUS_LAUNCHER: launcher,
          AGENT_BUS_RELEASES: dirname(oldPackage),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      }
    );
    assert(
      !old.success && old.stderr.toString().includes("serving binding"),
      "Managed installer accepted an old executable."
    );
    assert(!existsSync(launcher));
    const oldExact = dirname(sourceFiles(0).sentinelPath);
    const oldBlocker = join(
      state[0],
      "fluree-cursors",
      encodeURIComponent(f.config.ledger),
      `${f.current.incarnation}.v2`
    );
    mkdirSync(oldBlocker, { recursive: true, mode: 0o700 });
    for (const name of ["layout", ".export-pending"])
      copyFileSync(join(oldExact, name), join(oldBlocker, name));
    const refused = f.spawn(state[0]);
    await noListener(refused);
    assert.match(await refused.stderr, /pending export.*not readable JSON/i);
    assert.deepEqual(await f.cutNow(), reconciled);
    console.log(
      "PASS: exact held R1 handoff, both sealed successor roots, old blocker and installer refusal, post-ACK restore, and stale/incomparable recovery refusal."
    );
  } finally {
    for (const label of held) {
      assert(ctl("enable", `${domain}/${label}`).success);
      assert(override(label, "enabled"));
      assert.equal(ctl("print", `${domain}/${label}`).exitCode, 113);
    }
  }
}
