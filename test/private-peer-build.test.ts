// Opt in with the approved archive and independently selected commit and tree.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyPrivateBundle } from "../scripts/private-modern-http.ts";

const archive = process.env.AGENT_BUS_PRIVATE_PROVENANCE_ARCHIVE;
const commit = process.env.AGENT_BUS_PRIVATE_PROVENANCE_COMMIT;
const tree = process.env.AGENT_BUS_PRIVATE_PROVENANCE_TREE;
const qualify = archive && commit && tree ? test : test.skip;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

qualify(
  "source attribution ignores dirty, untracked and ignored working-tree inputs",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-provenance-qualification-")));
    const repo = resolve(import.meta.dir, "..");
    const bun = realpathSync(process.execPath);
    const env = {
      HOME: root,
      PATH: `${dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const run = (args: string[], cwd = root, input?: string) =>
      spawnSync(args[0]!, args.slice(1), {
        cwd,
        env,
        input,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    const must = (args: string[], cwd = root, input?: string) => {
      const result = run(args, cwd, input);
      expect(result.status, `fixture command failed: ${args[0]}`).toBe(0);
      return result.stdout.trim();
    };
    const out = join(root, "outputs");
    mkdirSync(out);
    const recipe = join(repo, "scripts/build-private-peer.ts");
    const recipeSha = sha(recipe);
    const args = (
      sourceRepo: string,
      selectedCommit = commit!,
      selectedTree = tree!,
      selectedArchive = archive!,
      bunSha = sha(bun),
      builderSha = recipeSha
    ) => [
      bun,
      "--no-env-file",
      "--config=/dev/null",
      recipe,
      "build",
      "--repo",
      sourceRepo,
      "--commit",
      selectedCommit,
      "--tree",
      selectedTree,
      "--archive",
      selectedArchive,
      "--bun",
      bun,
      "--bun-sha256",
      bunSha,
      "--builder-sha256",
      builderSha,
      "--out",
      out,
    ];
    const build = (sourceRepo: string) => {
      const result = run(args(sourceRepo), repo);
      expect(result.status, "source-attributed build failed").toBe(0);
      return JSON.parse(result.stdout) as { directory: string; manifestSha256: string };
    };
    try {
      const first = build(repo);
      const expected = {
        manifestSha256: first.manifestSha256,
        source: { commit: commit!, tree: tree! },
      };
      const firstManifest = verifyPrivateBundle(first.directory, expected);
      expect(firstManifest.schema).toBe("agent-bus-private-peer-source-v1");
      if (firstManifest.schema !== "agent-bus-private-peer-source-v1")
        throw new Error("Wrong schema.");
      expect(firstManifest.source.builderSha256).toBe(recipeSha);
      const original = ["main.js", "mcp-host.mjs", "manifest.json"].map((name) =>
        sha(join(first.directory, name))
      );

      // This disposable Git fixture borrows only immutable objects; no shared refs or worktrees change.
      const dirty = join(root, "dirty-repo");
      mkdirSync(dirty);
      must(["git", "init", "--quiet", dirty]);
      const common = must([
        "git",
        "-C",
        repo,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      writeFileSync(join(dirty, ".git/objects/info/alternates"), `${join(common, "objects")}\n`);
      must(["git", "-C", dirty, "read-tree", commit!]);
      const tar = join(root, "source.tar");
      must(["git", "-C", dirty, "archive", "--format=tar", "-o", tar, commit!]);
      must(["/usr/bin/tar", "-xf", tar, "-C", dirty]);
      const peer = join(dirty, "src/private-web/main.ts");
      expect(lstatSync(peer).isFile()).toBe(true);
      expect(lstatSync(peer).nlink).toBe(1);
      writeFileSync(peer, `${readFileSync(peer, "utf8")}\nthrow new Error("dirty fixture");\n`);
      writeFileSync(
        join(dirty, "src/private-web/untracked-override.ts"),
        "throw new Error('untracked');\n"
      );
      mkdirSync(join(dirty, "node_modules/mcp-openapi/dist"), { recursive: true });
      writeFileSync(
        join(dirty, "node_modules/mcp-openapi/dist/index.js"),
        "throw new Error('ignored dependency');\n"
      );
      expect(
        run(["git", "-C", dirty, "diff", "--quiet", "--", "src/private-web/main.ts"]).status
      ).toBe(1);
      expect(
        run(["git", "-C", dirty, "check-ignore", "-q", "node_modules/mcp-openapi/dist/index.js"])
          .status
      ).toBe(0);

      // A replacement ref exists only in this disposable Git directory and must not change selection.
      const parent = must(["git", "--no-replace-objects", "-C", dirty, "rev-parse", `${commit!}^`]);
      mkdirSync(join(dirty, ".git/refs/replace"), { recursive: true });
      writeFileSync(join(dirty, ".git/refs/replace", commit!), `${parent}\n`);
      const second = build(dirty);
      verifyPrivateBundle(second.directory, expected);
      expect(second.manifestSha256).toBe(first.manifestSha256);
      for (const name of ["main.js", "mcp-host.mjs", "manifest.json"])
        expect(readFileSync(join(second.directory, name))).toEqual(
          readFileSync(join(first.directory, name))
        );

      const before = readdirSync(out).sort();
      expect(run(args(repo, "HEAD", tree!), repo).status).not.toBe(0);
      expect(run(args(repo, commit!, "0".repeat(tree!.length)), repo).status).not.toBe(0);
      expect(run(args(repo, "0".repeat(commit!.length), tree!), repo).status).not.toBe(0);
      expect(run(args(repo, commit!, tree!, archive!, "0".repeat(64)), repo).status).not.toBe(0);
      expect(
        run(args(repo, commit!, tree!, archive!, sha(bun), "0".repeat(64)), repo).status
      ).not.toBe(0);
      const wrongArchive = join(root, "wrong-host.tgz");
      writeFileSync(wrongArchive, "not the approved archive");
      expect(run(args(repo, commit!, tree!, wrongArchive), repo).status).not.toBe(0);
      writeFileSync(join(dirty, ".git/info/attributes"), "src/private-web/main.ts export-ignore\n");
      expect(run(args(dirty), repo).status).not.toBe(0);
      // An unreachable synthetic commit in this disposable fixture points outside its tree.
      const outside = join(root, "outside-source.ts");
      writeFileSync(outside, "throw new Error('outside');\n");
      const blob = must(["git", "-C", dirty, "hash-object", "-w", "--stdin"], root, outside);
      expect(existsSync(join(dirty, ".git/objects", blob.slice(0, 2), blob.slice(2)))).toBe(true);
      const linkedTree = must(
        ["git", "-C", dirty, "mktree"],
        root,
        `120000 blob ${blob}\tescape.ts\n`
      );
      const linkedCommit = must(
        [
          "git",
          "-C",
          dirty,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit-tree",
          linkedTree,
        ],
        root,
        "disposable symlink fixture\n"
      );
      const rejected = run(args(dirty, linkedCommit, linkedTree), repo);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("Source tree contains a symlink");
      expect(readdirSync(out).sort()).toEqual(before);
      expect(
        ["main.js", "mcp-host.mjs", "manifest.json"].map((name) => sha(join(first.directory, name)))
      ).toEqual(original);

      const relocated = join(root, "relocated");
      mkdirSync(relocated);
      for (const name of ["main.js", "mcp-host.mjs", "manifest.json"])
        copyFileSync(join(first.directory, name), join(relocated, name));
      verifyPrivateBundle(relocated, expected);
      for (const name of ["main.js", "mcp-host.mjs", "manifest.json"])
        expect(readFileSync(join(relocated, name))).toEqual(
          readFileSync(join(first.directory, name))
        );
    } finally {
      // The builder seals only directories it created under this disposable root.
      for (const name of readdirSync(out)) {
        const artifact = join(out, name);
        if (lstatSync(artifact).isDirectory()) chmodSync(artifact, 0o700);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000
);
