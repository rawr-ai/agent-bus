// Build an isolated review artifact; no credentials, service or public CLI dependencies are changed.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const archiveHash = "d16821e6e327dbab807811fd07a0db5884adef41a922d838648ca021e778c0d8";
const entryHash = "8c3e4aa9c172a1caf107e352aee8e9676c98ff2ff0b27003655cb0508d77b939";
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
      // The archive was built from b6598398a4ca16118c9321ed76b19e42db3d2c4e, with the same tree.
      sourceCommit: "ba7941117038b079371a65ea6ca29727382be03c",
      sourceTree: "29e50685664f3cb36d5fc1451cccdf50b113c127",
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
