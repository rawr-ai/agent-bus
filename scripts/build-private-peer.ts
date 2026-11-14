// Build an isolated review artifact; no credentials, service or public CLI dependencies are changed.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const archiveHash = "72962e508686badfb36358b43b3bc14bc87721364c20c4a505ed88e2faa3ec73";
const entryHash = "ea4cf91888e84422a3216b5d549f40cb5c918e55e25da3699dc8241e521bc69a";
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
      sourceCommit: "a44e8a66d656b8738099cea368961f53a6ac0d4f",
      sourceTree: "725442e8b55ce52a498482f91a7ceb1f373fa8ff",
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
