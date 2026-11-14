// Build an isolated review artifact; no credentials, service or public CLI dependencies are changed.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const archiveHash = "6c6091e6a97d0e75ecf0ec9e03fa4901cc985b2e0d76c6aab52ed3ca1ac82c25";
const entryHash = "d7fdd22e950dfc1c43a5e756692d4306910711a9f3a6187b56fcbcc2fda7041b";
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
      // The release manifest records build commit 8411af6db99085845ef061bf8c5636aff6604f5b with this tree.
      sourceCommit: "7e7d68c0a580c25e46ece8d33663d207bcfcb236",
      sourceTree: "59602f1e3a1f47d241834f73aedb1184ccf66406",
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
