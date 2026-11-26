/**
 * Reuse the historical pinned harness only to materialize two genuine, small,
 * synthetic R1 installations. The retirement assertions run against the exact
 * successor package and separately anchored handoff bundle, never a live root.
 */
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
import { fileSha256, removeOwned, verify } from "./release.ts";

const predecessor = "a32ae0aecb3413e1e04363f464242ae1a9136418";
const tree = "9fdb8fdd151ce11771ab91f92816f4d219e94348";
const repo = resolve(import.meta.dir, "..");
const bun = realpathSync(process.execPath);
const names = [
  "release",
  "expect",
  "file-writer",
  "expect-file-writer",
  "prior-mailbox",
  "expect-prior-mailbox",
  "handoff",
  "expect-handoff",
  "fluree",
  "expect-fluree",
  "private-archive",
  "expect-private-archive",
] as const;
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: Object.fromEntries([...names, "git-repo"].map((name) => [name, { type: "string" }])),
});
const gitRepo = values["git-repo"] ?? repo;
assert(typeof gitRepo === "string" && isAbsolute(gitRepo), "--git-repo must be absolute");
const need = (name: (typeof names)[number]) => {
  const value = values[name];
  assert.equal(typeof value, "string", `Pass --${name}`);
  return value as string;
};
const path = (name: (typeof names)[number]) => {
  const value = need(name);
  assert(isAbsolute(value), `--${name} must be absolute`);
  return value;
};
const digest = (name: (typeof names)[number]) => {
  const value = need(name);
  assert.match(value, /^[0-9a-f]{64}$/, `--${name} must be a SHA-256 digest`);
  return value;
};
const release = path("release");
assert(verify(release, { expect: digest("expect") }).ok, "Successor package did not verify");
const fluree = path("fluree");
assert.equal(fileSha256(fluree), digest("expect-fluree"), "Fluree executable did not verify");
assert.equal(Bun.which("fluree"), fluree, "Put the pinned Fluree directory first on PATH");
const handoff = path("handoff");
const handoffManifest = join(handoff, "manifest.json");
assert.equal(
  fileSha256(handoffManifest),
  digest("expect-handoff"),
  "Handoff manifest did not verify"
);
const manifest = JSON.parse(readFileSync(handoffManifest, "utf8"));
assert.equal(manifest.predecessor, predecessor);
assert.equal(manifest.tree, tree);
assert.equal(manifest.bun, fileSha256(bun));
assert.equal(manifest.entry, fileSha256(join(handoff, "handoff.js")));
assert.equal(fileSha256(path("private-archive")), digest("expect-private-archive"));

const work = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-r1-rehearsal-")));
const home = join(work, "home");
const exported = join(work, "source");
const archive = join(work, "a32.tar");
const env = {
  HOME: home,
  PATH: `${dirname(bun)}:${dirname(fluree)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  LC_ALL: "C",
};
const run = (args: [string, ...string[]], cwd = repo) => {
  const result = spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf8", timeout: 90_000 });
  if (result.status !== 0) throw new Error(`The isolated rehearsal setup failed: ${args[0]}`);
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
  const locked = join(exported, "dist/private-artifacts/mcp-openapi-2.1.0-a1ca308.tgz");
  mkdirSync(dirname(locked), { recursive: true });
  copyFileSync(path("private-archive"), locked);
  run(
    [
      bun,
      "--no-env-file",
      "--config=/dev/null",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    exported
  );
  const test = "test/mailbox-transition-old-release.test.ts";
  const file = join(exported, test);
  const connector =
    "      expect(await cutNow()).toEqual(advanced);\n      const nextTwo = candidate(roots[1]);";
  const data = readFileSync(file, "utf8");
  assert.equal(data.split(connector).length, 2, "The frozen fixture has a different join point");
  // At this point both old roots have real R1 permits. No retirement logic is patched into
  // either historic executable or the successor; only this disposable test is extended.
  const beforeR = "      const nextOne = candidate(roots[0]);";
  const beforeCapture = "      const unresolvedMail = await send(unresolved,";
  const census = "const expectedAddresses = [author, ...readers, unresolved, legacy].sort();";
  assert.equal(data.split(beforeR).length, 2);
  assert.equal(data.split(beforeCapture).length, 2);
  assert.equal(data.split(census).length, 2);
  writeFileSync(
    file,
    data
      .replace(
        beforeCapture,
        `      const returning = "fixture/retirement-return";
      const vacant = "fixture/retirement-vacancy";
      await call(clientOne, "bus_join", {
        address: returning, session: session(returning), runtime: "other", cwd: fixture, topics: [],
      });
      const returnPending = await send(returning, "mail pending at leave");
      await call(clientOne, "bus_leave", { address: returning, session: session(returning) });
      const historicalVacancy = async (status: "joined" | "left") => {
        const event = new Message({
          id: Bun.randomUUIDv7(), ts: new Date().toISOString(), from: vacant, to: ["*"], kind: "presence",
          body: "synthetic fileless holding",
          presence: new Presence({ status, runtime: "other", session: session(vacant), topics: [] }),
        });
        await insertRaw(config, toNode(event, Schema.encodeSync(MessageJson)(event)));
      };
      await historicalVacancy("joined");
      const vacantOld = await send(vacant, "mail directed to the earlier fileless holding");
      await historicalVacancy("left");
${beforeCapture}`
      )
      .replace(
        census,
        "const expectedAddresses = [author, ...readers, unresolved, legacy, returning, vacant].sort();"
      )
      .replace(
        beforeR,
        `      await provider.coldCopy("before-r");
${beforeR}`
      )
      .replace(
        connector,
        `      expect(await cutNow()).toEqual(advanced);
      await stop(nextOne, nextClientOne);
      const { rehearse } = await import("./retirement-companion.ts");
      await rehearse({
        fixture, roots, identities, config, orderedSources, operation, sourceCommit, verifiedCommit,
        proof, current: advanced, currentCommit: (await readCommit(advanced.head)).id, spawn, connect,
        stop, call, cutNow, readCommit, processes, allocated, acknowledged, readers, unread, legacy,
        session, author, returning, returnPending, vacant, vacantOld,
        insert: (data: unknown) => insertRaw(config, data), newId: newSend.id,
        coldCopy: provider.coldCopy, openCopy: provider.openCopy,
      });
      return;
      const nextTwo = candidate(roots[1]);`
      )
  );
  copyFileSync(
    join(repo, "tools/retired-r1/rehearsal.ts"),
    join(exported, "test/retirement-companion.ts")
  );
  copyFileSync(
    join(repo, "test/fluree-file-server.ts"),
    join(exported, "test/fluree-file-server.ts")
  );
  const out = spawnSync(bun, ["--no-env-file", "--config=/dev/null", "test", test], {
    cwd: exported,
    env: {
      ...env,
      AGENT_BUS_OLD_RELEASE: path("file-writer"),
      AGENT_BUS_OLD_RELEASE_SHA256: digest("expect-file-writer"),
      AGENT_BUS_PRIOR_MAILBOX_RELEASE: path("prior-mailbox"),
      AGENT_BUS_PRIOR_MAILBOX_RELEASE_SHA256: digest("expect-prior-mailbox"),
      AGENT_BUS_FLUREE_SHA256: digest("expect-fluree"),
      AGENT_BUS_FLUREE_VERSION: run([fluree, "--version"]).replace(/^fluree /, ""),
      RETIREMENT_RELEASE: release,
      RETIREMENT_HANDOFF: join(handoff, "handoff.js"),
    },
    stdio: "inherit",
    timeout: 150_000,
  });
  if (out.status !== 0) process.exitCode = 1;
} finally {
  removeOwned(work);
}
