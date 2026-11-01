const node = Bun.which("node");
if (!node) throw new Error("Node runtime unavailable");
const child = Bun.spawn([node, "--version"], { stdout: "pipe", stderr: "pipe" });
const nodeVersion = (await new Response(child.stdout).text()).trim();
if ((await child.exited) !== 0) throw new Error("Node runtime identity unavailable");
console.log(
  JSON.stringify({ bun: Bun.version, node: nodeVersion, os: process.platform, arch: process.arch })
);

export {};
