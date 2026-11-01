import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "dist/viewer");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "public"), { recursive: true });

const browser = await Bun.build({
  entrypoints: [resolve(root, "viewer/index.html")],
  outdir: resolve(output, "public"),
  target: "browser",
  minify: true,
  sourcemap: "none",
  env: "disable",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  metafile: true,
});
if (!browser.success) throw new Error("Viewer browser build failed");
const browserGraph = JSON.stringify(browser.metafile);
if (/viewer\/server\/|src\/(?:Bus|Ledger|mcp|client)\.ts/.test(browserGraph)) {
  throw new Error("Server code entered the browser build");
}
const manifest = browser.outputs.map((artifact) => {
  const file = artifact.path.split("/").at(-1);
  if (file === undefined || file.includes("..")) throw new Error("Invalid browser output");
  return {
    path: file === "index.html" ? "/" : `/${file}`,
    file,
    contentType: artifact.type,
  };
});
await Bun.write(resolve(output, "public/manifest.json"), JSON.stringify(manifest));

const server = await Bun.build({
  entrypoints: [resolve(root, "viewer/server/main.ts")],
  outdir: output,
  target: "bun",
  minify: true,
  sourcemap: "none",
  env: "disable",
});
if (!server.success) throw new Error("Viewer server build failed");
console.log("Viewer production build complete; browser graph contains no server/core modules.");
