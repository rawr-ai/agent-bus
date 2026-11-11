// Build an isolated review artifact; no credentials, service or public CLI dependencies are changed.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const archiveHash = "4c95d202370fa3af4515a5993a659d733682c22f7f95e8bfc4ad834518ca3f4a";
const entryHash = "78ac81acc5bb47bd001efd00d504d2adc42857263d21d32ffc3ddfc57b166642";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const [archive, parent] = process.argv.slice(2);
if (!archive || !parent || !isAbsolute(archive) || !isAbsolute(parent) || process.argv.length !== 4)
  throw new Error("Supply the absolute host archive and existing private output directory.");
if (hash(readFileSync(archive)) !== archiveHash) throw new Error("Wrong host artifact.");
const out = mkdtempSync(join(parent, "private-peer-"));
let complete = false;
try {
  const extract = Bun.spawnSync(["tar", "-xzf", archive, "-C", out, "package/dist/index.js"]);
  if (!extract.success) throw new Error("Could not extract host entry.");
  const extracted = join(out, "package/dist/index.js");
  if (hash(readFileSync(extracted)) !== entryHash) throw new Error("Wrong host entry.");
  renameSync(extracted, join(out, "mcp-host.mjs"));
  rmSync(join(out, "package"), { recursive: true });
  const result = await Bun.build({
    entrypoints: ["./src/private-web/main.ts"],
    outdir: out,
    target: "bun",
    format: "esm",
  });
  if (!result.success) throw new Error("Private peer bundle failed.");
  const peer = join(out, "main.js");
  const manifest = {
    schema: "agent-bus-private-peer-review-v1",
    host: {
      sourceCommit: "da738cbd9e8b0d29a4e2d7dbbb379971b23ae719",
      sourceTree: "004cafedc6c5bb3996b76a7c41efa59bd32f47c1",
      archiveSha256: archiveHash,
      entrySha256: entryHash,
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
