// Build an isolated review artifact; no credentials, service or public CLI dependencies are changed.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, sep } from "node:path";

const archiveHash = "a89ea13eea6eea52950ffedfdf381672f8aa69448185cfdc474f337431de574a";
const entryHash = "d262e777cac0ee6bf7cf6d5f22719c87c6713396de0cdaee8be878da1c4244a2";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const [archive, parent] = process.argv.slice(2);
if (!archive || !parent || !isAbsolute(archive) || !isAbsolute(parent) || process.argv.length !== 4)
  throw new Error("Supply the absolute host archive and existing private output directory.");
if (hash(readFileSync(archive)) !== archiveHash) throw new Error("Wrong host artifact.");
const entry = realpathSync(Bun.resolveSync("mcp-openapi", import.meta.dir));
if (hash(readFileSync(entry)) !== entryHash) throw new Error("Wrong installed host entry.");
const effectPackage = realpathSync(createRequire(entry).resolve("effect/package.json"));
const effectRoot = dirname(effectPackage);
const effectManifest: unknown = JSON.parse(readFileSync(effectPackage, "utf8"));
if (
  typeof effectManifest !== "object" ||
  effectManifest === null ||
  !("version" in effectManifest) ||
  effectManifest.version !== "4.1.4"
)
  throw new Error("Wrong isolated host runtime.");
const out = mkdtempSync(join(parent, "private-peer-"));
let complete = false;
try {
  let runtimeImports = 0;
  // The host owns a different Effect version from the native peer; seal it into its module.
  const hostBuild = await Bun.build({
    entrypoints: [entry],
    outdir: out,
    naming: "mcp-host.mjs",
    target: "bun",
    format: "esm",
    external: ["@valibot/to-json-schema", "arktype", "sury"],
    plugins: [
      {
        name: "isolated-host-effect",
        setup(build) {
          build.onResolve({ filter: /^effect(?:\/|$)/ }, (args) => {
            const resolved = realpathSync(Bun.resolveSync(args.path, args.resolveDir));
            if (!resolved.startsWith(`${effectRoot}${sep}`))
              throw new Error("Host runtime escaped its isolated package.");
            runtimeImports++;
            return { path: resolved };
          });
        },
      },
    ],
  });
  if (!hostBuild.success || runtimeImports === 0) throw new Error("Host runtime bundle failed.");
  const host = join(out, "mcp-host.mjs");
  if (/["'`]\/(?:Users|home)\/|["'`][A-Za-z]:\\+Users\\+/u.test(readFileSync(host, "utf8")))
    throw new Error("Host bundle contains a private build locator.");
  const result = await Bun.build({
    entrypoints: ["./src/private-web/main.ts"],
    outdir: out,
    target: "bun",
    format: "esm",
  });
  if (!result.success) throw new Error("Private peer bundle failed.");
  const peer = join(out, "main.js");
  const manifest = {
    schema: "agent-bus-private-peer-review-v2",
    host: {
      sourceCommit: "12794ff42710c8e468cbb06f9b7111ee2385e090",
      sourceTree: "84af328b4bbdaf74033cbdfc83cea6969d8e6eba",
      archiveSha256: archiveHash,
      entrySha256: entryHash,
      bundleSha256: hash(readFileSync(host)),
      effectVersion: effectManifest.version,
      effectPackageSha256: hash(readFileSync(effectPackage)),
    },
    peerSha256: hash(readFileSync(peer)),
    source: "working tree; exact source revision not attested",
  };
  await Bun.write(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  complete = true;
  console.log(out);
} finally {
  if (!complete) rmSync(out, { recursive: true, force: true });
}
