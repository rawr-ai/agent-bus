import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSha256, removeOwned, type Verdict, verify } from "../scripts/release.ts";
import { bunWrapper, fakeRelease, mutate, reseal as resealRelease } from "./release-fixture.ts";

const ID = "0.0.0-test";
let root: string;
let bun: string;
let dir: string;
let digest: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-release-verify-")));
  bun = bunWrapper(join(root, "approved-bun"));
  ({ dir, digest } = fakeRelease(root, ID, bun));
});
afterEach(() => removeOwned(root));

const check = (path = dir, expect = digest, approved: string | undefined = bun) =>
  verify(path, { expect, bun: approved });

const reseal = (edit: Parameters<typeof resealRelease>[1]) => resealRelease(dir, edit);

const refused = (verdict: Verdict, reason: string) => {
  expect(verdict.ok).toBe(false);
  expect(verdict.problems.join("\n")).toContain(reason);
};

test("an intact release verifies, here and after relocation, and reports only identities", () => {
  const verdict = check();
  expect(verdict).toEqual({ ok: true, id: ID, manifestSha256: digest, problems: [] });
  const elsewhere = join(root, "moved");
  // A relocation as an operator does it: modes preserved.
  expect(spawnSync("/bin/mkdir", ["-p", elsewhere]).status).toBe(0);
  expect(spawnSync("/bin/cp", ["-Rp", dir, elsewhere]).status).toBe(0);
  expect(check(join(elsewhere, ID)).ok).toBe(true);
});

test("a consistent edit of a file and its manifest hash fails the external anchor", () => {
  const cli = join(dir, "app/cli.js");
  mutate(join(dir, "app"), 0o555, () =>
    mutate(cli, 0o444, () => appendFileSync(cli, "// tampered\n"))
  );
  const newDigest = reseal((manifest) => {
    for (const file of manifest.files)
      if (file.path === "app/cli.js") file.sha256 = fileSha256(cli);
  });
  refused(check(), "manifest digest does not match the expected anchor");
  // Even under the tamperer's own digest the approved Bun still holds, but the code changed:
  // only the anchor catches this, which is why activation must record it.
  expect(check(dir, newDigest).ok).toBe(true);
});

test("a different runtime, even one reporting the right version, is not the approved Bun", () => {
  const runtime = join(dir, "runtime/bun");
  mutate(join(dir, "runtime"), 0o555, () =>
    mutate(runtime, 0o555, () => {
      unlinkSync(runtime);
      writeFileSync(runtime, `#!/bin/sh\necho ${Bun.version}\n`);
    })
  );
  const newDigest = reseal((manifest) => {
    const sha = fileSha256(runtime);
    for (const file of manifest.files) if (file.path === "runtime/bun") file.sha256 = sha;
    (manifest.bun as { sha256: string }).sha256 = sha;
  });
  refused(check(), "manifest digest does not match");
  refused(check(dir, newDigest), "runtime/bun is not the approved Bun");
});

for (const [name, reason, apply] of [
  [
    "an extra file",
    "unlisted file: extra",
    () => mutate(dir, 0o555, () => writeFileSync(join(dir, "extra"), "x")),
  ],
  [
    "a hidden extra file",
    "unlisted file: app/.DS_Store",
    () => mutate(join(dir, "app"), 0o555, () => writeFileSync(join(dir, "app/.DS_Store"), "x")),
  ],
  [
    "a missing file",
    "missing file: app/dist/viewer/main.js",
    () =>
      mutate(join(dir, "app/dist/viewer"), 0o555, () =>
        unlinkSync(join(dir, "app/dist/viewer/main.js"))
      ),
  ],
  [
    "one changed byte in skill text no run executes",
    "content differs: plugin/skills/agent-bus/SKILL.md",
    () => {
      const skill = join(dir, "plugin/skills/agent-bus/SKILL.md");
      mutate(skill, 0o444, () => appendFileSync(skill, " "));
    },
  ],
  [
    "an exec bit removed",
    "file mode differs: runtime/bun",
    () => chmodSync(join(dir, "runtime/bun"), 0o444),
  ],
  [
    "a write bit added",
    "file mode differs: app/cli.js",
    () => chmodSync(join(dir, "app/cli.js"), 0o644),
  ],
  ["setuid", "file mode differs: runtime/bun", () => chmodSync(join(dir, "runtime/bun"), 0o4555)],
  [
    "a writable directory",
    "directory mode is not 0555: app",
    () => chmodSync(join(dir, "app"), 0o755),
  ],
  [
    "a symlink to identical content",
    "not a regular file or directory: app/cli.js",
    () => {
      const cli = join(dir, "app/cli.js");
      const copy = join(root, "cli-copy.js");
      cpSync(cli, copy);
      mutate(join(dir, "app"), 0o555, () => {
        unlinkSync(cli);
        symlinkSync(copy, cli);
      });
    },
  ],
  [
    "a hard link to an outside file",
    "file has other hard links: app/cli.js",
    () => linkSync(join(dir, "app/cli.js"), join(root, "outside-link")),
  ],
  [
    "a FIFO",
    "not a regular file or directory: pipe",
    () => mutate(dir, 0o555, () => spawnSync("/usr/bin/mkfifo", [join(dir, "pipe")])),
  ],
] as const) {
  test(`refuses ${name}`, () => {
    apply();
    refused(check(), reason);
  });
}

for (const [name, reason, edit] of [
  [
    "an absolute path",
    "unsafe path",
    (files: Array<Record<string, string>>) =>
      files.push({ path: "/etc/hosts", sha256: "", mode: "0444" }),
  ],
  [
    "a parent path",
    "unsafe path",
    (files: Array<Record<string, string>>) =>
      files.push({ path: "app/../x", sha256: "", mode: "0444" }),
  ],
  [
    "a duplicated path",
    "manifest lists a path twice: app/cli.js",
    (files: Array<Record<string, string>>) =>
      files.push({ ...files.find((file) => file.path === "app/cli.js")! }),
  ],
] as const) {
  test(`refuses a manifest with ${name}, even under its own digest`, () => {
    const newDigest = reseal((manifest) => edit(manifest.files));
    refused(check(dir, newDigest), reason);
  });
}

test("refuses a release whose directory name is not its id, or that is itself a link", () => {
  const renamed = join(root, "other-name");
  renameSync(dir, renamed);
  refused(check(renamed), "directory name differs from the release id");
  renameSync(renamed, dir);
  const link = join(root, "linked");
  symlinkSync(dir, link);
  refused(check(link), "release path is not a real directory");
});

test("refuses without a valid anchor or with a relative path, before reading anything", () => {
  refused(check(dir, "not-a-digest"), "--expect must be a sha256 digest");
  refused(check("relative/path"), "release path must be absolute");
});

test("a hook subcommand missing from the release's CLI is refused", () => {
  const cli = join(dir, "app/cli.js");
  mutate(join(dir, "app"), 0o555, () =>
    mutate(cli, 0o444, () =>
      writeFileSync(
        cli,
        `${readFileSync(cli, "utf8")}if (process.argv[2] === "claude-wake") process.exit(3);\n`
      )
    )
  );
  const newDigest = reseal((manifest) => {
    for (const file of manifest.files)
      if (file.path === "app/cli.js") file.sha256 = fileSha256(cli);
  });
  refused(check(dir, newDigest), "hook subcommand missing from this release's CLI: claude-wake");
});
