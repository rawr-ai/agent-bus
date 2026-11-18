// Builds either an explicitly unattested review artifact or a source-attributed artifact.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const archiveHash = "90ac182ec316eaff54b787573ca076aea5bd98e346d2f6290945f05a4c244cce";
const entryHash = "e8b43e25a64d0bf5e70cc4efc358c0d3e4bc7e901706933fe1d026db6d38f8d5";
const effectHash = "c25c5cec1df1befc27ae354843dc57534e22b76cb93488ddf8042ef520dda9d0";
const archivePath = "dist/private-artifacts/mcp-openapi-2.1.0-a1ca308.tgz";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path: string) => hash(readFileSync(path));
const withoutShebang = (source: string) =>
  source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
const inside = (root: string, path: string) => path.startsWith(`${root}${sep}`);

type BundleInputs = { readonly sha256: string; readonly count: number };
type Built = {
  readonly host: {
    readonly sourceCommit: string;
    readonly sourceTree: string;
    readonly archiveSha256: string;
    readonly entrySha256: string;
    readonly bundleSha256: string;
    readonly effectVersion: string;
    readonly effectPackageSha256: string;
  };
  readonly peerSha256: string;
  readonly hostInputs: BundleInputs;
  readonly peerInputs: BundleInputs;
};

/** The exact files Bun reports using must resolve inside the exported source and install. */
function inputs(root: string, metadata: Bun.BuildMetafile | undefined): BundleInputs {
  if (metadata === undefined) throw new Error("Bundle input metadata is missing.");
  const files = Object.keys(metadata.inputs).map((name) => {
    const file = realpathSync(resolve(root, name));
    if (!inside(root, file) || !lstatSync(file).isFile())
      throw new Error("A bundle input escaped its isolated source.");
    return { path: relative(root, file).split(sep).join("/"), sha256: fileHash(file) };
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sha256: hash(JSON.stringify(files)), count: files.length };
}

async function bundle(root: string, out: string, isolated: boolean): Promise<Built> {
  const entry = realpathSync(Bun.resolveSync("mcp-openapi", join(root, "package.json")));
  const entryBytes = readFileSync(entry);
  if (hash(entryBytes) !== entryHash) throw new Error("Wrong installed host entry.");
  const effectPackage = realpathSync(createRequire(entry).resolve("effect/package.json"));
  const effectRoot = dirname(effectPackage);
  if (isolated && (!inside(root, entry) || !inside(root, effectPackage)))
    throw new Error("Host dependencies escaped the isolated source.");
  const effectManifest: unknown = JSON.parse(readFileSync(effectPackage, "utf8"));
  if (
    typeof effectManifest !== "object" ||
    effectManifest === null ||
    !("version" in effectManifest) ||
    effectManifest.version !== "4.1.4" ||
    fileHash(effectPackage) !== effectHash
  )
    throw new Error("Wrong isolated host runtime.");
  const runtimeImports = new Bun.Transpiler({ loader: "js" })
    .scan(withoutShebang(entryBytes.toString("utf8")))
    .imports.filter(({ path }) => /^effect(?:\/|$)/u.test(path));
  if (runtimeImports.length === 0) throw new Error("Host runtime imports are missing.");
  for (const { path } of runtimeImports) {
    const resolved = realpathSync(Bun.resolveSync(path, dirname(entry)));
    if (!inside(effectRoot, resolved))
      throw new Error("Host runtime escaped its isolated package.");
  }
  const hostBuild = await Bun.build({
    entrypoints: [entry],
    outdir: out,
    naming: "mcp-host.mjs",
    target: "bun",
    format: "esm",
    env: "disable",
    metafile: true,
    external: ["@valibot/to-json-schema", "arktype", "sury"],
  });
  if (!hostBuild.success) throw new Error("Host runtime bundle failed.");
  const host = join(out, "mcp-host.mjs");
  const hostSource = readFileSync(host, "utf8");
  if (
    new Bun.Transpiler({ loader: "js" })
      .scan(withoutShebang(hostSource))
      .imports.some(({ path }) => /^effect(?:\/|$)/u.test(path))
  )
    throw new Error("Host runtime was not bundled.");
  if (/["'`]\/(?:Users|home)\/|["'`][A-Za-z]:\\+Users\\+/u.test(hostSource))
    throw new Error("Host bundle contains a private build locator.");
  const peerBuild = await Bun.build({
    entrypoints: [join(root, "src/private-web/main.ts")],
    outdir: out,
    target: "bun",
    format: "esm",
    env: "disable",
    metafile: true,
  });
  if (!peerBuild.success) throw new Error("Private peer bundle failed.");
  return {
    host: {
      sourceCommit: "a1ca3083913b9d9cc0794c1acdf6c682678de1d1",
      sourceTree: "074ff06aeea433776af79040f368c9cf2b3377f4",
      archiveSha256: archiveHash,
      entrySha256: entryHash,
      bundleSha256: fileHash(host),
      effectVersion: effectManifest.version,
      effectPackageSha256: fileHash(effectPackage),
    },
    peerSha256: fileHash(join(out, "main.js")),
    hostInputs: inputs(root, hostBuild.metafile),
    peerInputs: inputs(root, peerBuild.metafile),
  };
}

function must(args: ReadonlyArray<string>, cwd: string, env: Record<string, string>, what: string) {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status ?? -1}).`);
  return result.stdout;
}

/** Check the export against every tree blob, including files Git attributes might omit or alter. */
function checkExport(root: string, listing: string, objectFormat: string) {
  const files = new Map<string, { oid: string; executable: boolean }>();
  for (const line of listing.split("\0")) {
    if (line === "") continue;
    const entry = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/u.exec(line);
    if (!entry) throw new Error("Source tree contains a symlink, submodule or unsupported entry.");
    const name = entry[3]!;
    if (
      isAbsolute(name) ||
      name.split("/").some((part) => part === "" || part === "." || part === "..") ||
      files.has(name)
    )
      throw new Error("Source tree contains an unsafe path.");
    files.set(name, { oid: entry[2]!, executable: entry[1] === "100755" });
  }
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const full = join(directory, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, path);
      else {
        const expected = files.get(path);
        if (!stat.isFile() || expected === undefined)
          throw new Error("Export contains an unexpected or non-regular file.");
        const bytes = readFileSync(full);
        const oid = createHash(objectFormat)
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        if (oid !== expected.oid || Boolean(stat.mode & 0o111) !== expected.executable)
          throw new Error("Export differs from the selected source tree.");
        files.delete(path);
      }
    }
  };
  walk(root, "");
  if (files.size !== 0) throw new Error("Export omitted files from the selected source tree.");
}

async function review(archive: string, parent: string) {
  if (!isAbsolute(archive) || !isAbsolute(parent))
    throw new Error("Supply the absolute host archive and existing private output directory.");
  if (fileHash(archive) !== archiveHash) throw new Error("Wrong host artifact.");
  const out = mkdtempSync(join(realpathSync(parent), "private-peer-"));
  let complete = false;
  try {
    const built = await bundle(realpathSync(process.cwd()), out, false);
    const manifest = {
      schema: "agent-bus-private-peer-review-v2",
      host: built.host,
      peerSha256: built.peerSha256,
      source: "working tree; exact source revision not attested",
    };
    await Bun.write(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    complete = true;
    console.log(out);
  } finally {
    if (!complete) rmSync(out, { recursive: true, force: true });
  }
}

function production(argv: ReadonlyArray<string>) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      commit: { type: "string" },
      tree: { type: "string" },
      archive: { type: "string" },
      bun: { type: "string" },
      "bun-sha256": { type: "string" },
      "builder-sha256": { type: "string" },
      out: { type: "string" },
    },
  });
  const { repo, commit, tree, archive, bun, out } = values;
  const bunSha = values["bun-sha256"];
  const builderSha = values["builder-sha256"];
  if (
    !repo ||
    !commit ||
    !tree ||
    !archive ||
    !bun ||
    !bunSha ||
    !builderSha ||
    !out ||
    ![repo, archive, bun, out].every(isAbsolute) ||
    !/^[0-9a-f]{64}$/u.test(bunSha) ||
    !/^[0-9a-f]{64}$/u.test(builderSha)
  )
    throw new Error(
      "Supply absolute --repo, --archive, --bun and --out, plus --commit, --tree, --bun-sha256 and --builder-sha256."
    );
  const executable = realpathSync(bun);
  if (realpathSync(process.execPath) !== executable || fileHash(executable) !== bunSha)
    throw new Error("Running Bun does not match the independently selected executable and digest.");
  if (fileHash(archive) !== archiveHash) throw new Error("Wrong host artifact.");
  const builderHash = fileHash(import.meta.path);
  if (builderHash !== builderSha)
    throw new Error("Build recipe does not match the independently selected digest.");
  const work = realpathSync(mkdtempSync(join(tmpdir(), "agent-bus-private-build-")));
  let output: string | undefined;
  let complete = false;
  try {
    for (let ancestor = dirname(work); ; ancestor = dirname(ancestor)) {
      if (existsSync(join(ancestor, "node_modules")))
        throw new Error("An isolated build ancestor contains node_modules.");
      if (ancestor === dirname(ancestor)) break;
    }
    const env = {
      HOME: work,
      PATH: `${dirname(executable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const git = (args: ReadonlyArray<string>, what: string) =>
      must(
        [
          "/usr/bin/git",
          "--no-replace-objects",
          "-c",
          "core.attributesFile=/dev/null",
          "-C",
          repo,
          ...args,
        ],
        work,
        env,
        what
      );
    const format = git(["rev-parse", "--show-object-format"], "reading Git object format").trim();
    const length = format === "sha1" ? 40 : format === "sha256" ? 64 : 0;
    if (
      length === 0 ||
      !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(commit) ||
      !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(tree)
    )
      throw new Error("Commit and tree must be full Git object IDs.");
    const resolved = git(
      ["rev-parse", "--verify", `${commit}^{commit}`],
      "resolving commit"
    ).trim();
    const actualTree = git(["rev-parse", "--verify", `${commit}^{tree}`], "resolving tree").trim();
    if (resolved !== commit || actualTree !== tree)
      throw new Error("Selected commit and tree do not agree.");
    const listing = git(["ls-tree", "-rz", "--full-tree", commit], "listing source tree");
    // Reject special entries before extracting, so tar never follows a source-tree symlink.
    for (const line of listing.split("\0"))
      if (line !== "" && !/^(100644|100755) blob [0-9a-f]+\t/u.test(line))
        throw new Error("Source tree contains a symlink, submodule or unsupported entry.");
    const src = join(work, "src");
    mkdirSync(src);
    const tar = join(work, "source.tar");
    git(["archive", "--format=tar", "-o", tar, commit], "exporting commit");
    must(["/usr/bin/tar", "-xf", tar, "-C", src], work, env, "unpacking commit");
    checkExport(src, listing, format);
    const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
    if (pkg.engines?.bun !== Bun.version || pkg.packageManager !== `bun@${Bun.version}`)
      throw new Error("Running Bun does not match the selected source pin.");
    if (pkg.devDependencies?.["mcp-openapi"] !== `file:${archivePath}`)
      throw new Error("Selected source does not name the approved host archive.");
    const lock = join(src, "bun.lock");
    const lockHash = fileHash(lock);
    mkdirSync(dirname(join(src, archivePath)), { recursive: true });
    copyFileSync(archive, join(src, archivePath), constants.COPYFILE_EXCL);
    if (fileHash(join(src, archivePath)) !== archiveHash)
      throw new Error("Copied host archive differs.");
    must(
      [
        executable,
        "install",
        "--no-env-file",
        `--config=${join(src, "bunfig.toml")}`,
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-save",
        "--no-progress",
        "--backend=copyfile",
        `--cache-dir=${join(work, "cache")}`,
      ],
      src,
      env,
      "isolated frozen install"
    );
    if (fileHash(lock) !== lockHash)
      throw new Error("Frozen install changed the selected lockfile.");
    output = mkdtempSync(join(realpathSync(out), "private-peer-"));
    const result = must(
      [
        executable,
        "--no-env-file",
        "--no-install",
        "--config=/dev/null",
        import.meta.path,
        "--internal-bundle",
        src,
        output,
      ],
      src,
      env,
      "isolated bundle"
    );
    const built = JSON.parse(result) as Built;
    if (fileHash(executable) !== bunSha || fileHash(import.meta.path) !== builderHash)
      throw new Error("Build executable or recipe changed during the build.");
    const manifest = {
      schema: "agent-bus-private-peer-source-v1",
      host: { ...built.host, inputs: built.hostInputs },
      peerSha256: built.peerSha256,
      peerInputs: built.peerInputs,
      source: { commit, tree, lockSha256: lockHash, builderSha256: builderHash },
      bun: { version: Bun.version, revision: Bun.revision, sha256: bunSha },
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(output, "manifest.json"), text);
    for (const name of ["main.js", "mcp-host.mjs", "manifest.json"])
      chmodSync(join(output, name), 0o444);
    chmodSync(output, 0o555);
    complete = true;
    console.log(JSON.stringify({ directory: output, manifestSha256: hash(text) }));
  } finally {
    if (!complete && output !== undefined) {
      chmodSync(output, 0o700);
      rmSync(output, { recursive: true, force: true });
    }
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--internal-bundle" && args.length === 3) {
    const root = realpathSync(args[1]!);
    console.log(JSON.stringify(await bundle(root, args[2]!, true)));
  } else if (args[0] === "build") production(args.slice(1));
  else if (args.length === 2) await review(args[0]!, args[1]!);
  else
    throw new Error(
      "Supply archive and output parent for a nonpromotable review build, or use build with explicit source and Bun identities."
    );
}
