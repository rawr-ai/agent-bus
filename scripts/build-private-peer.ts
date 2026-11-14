// Build an isolated review artifact; no credentials, service or public CLI dependencies are changed.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const archiveHash = "c8a868cdd84a5026a572dad95f6fa335d0fd09d52304f77f7526bba485045247";
const entryHash = "c076ea2a9d1396bc45cd5b5d2c767268991bc41ba12392eb78b30a409c381b91";
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
      sourceCommit: "22f09044bf974429d5daa2e64adf7682270ec71d",
      sourceTree: "68608aee088ff115532a2e9222c83afb8104f30e",
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
