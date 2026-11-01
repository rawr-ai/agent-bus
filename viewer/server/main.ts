import { Schema } from "effect";
import { createViewer, type ViewerAssets } from "./host.ts";

const Manifest = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    file: Schema.String,
    contentType: Schema.String,
  })
);

const port = (value: string | undefined, fallback: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("Invalid port");
  return parsed;
};

const start = async () => {
  const directory = new URL("../../dist/viewer/public/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(Manifest)(
    await Bun.file(new URL("manifest.json", directory)).json()
  );
  const assets = new Map<string, { body: Uint8Array; contentType: string }>();
  for (const entry of manifest) {
    if (
      !/^\/[A-Za-z0-9_.\/-]*$/.test(entry.path) ||
      entry.path.includes("..") ||
      !/^[A-Za-z0-9_.-]+$/.test(entry.file)
    ) {
      throw new Error("Invalid asset manifest");
    }
    assets.set(entry.path, {
      body: new Uint8Array(await Bun.file(new URL(entry.file, directory)).arrayBuffer()),
      contentType: entry.contentType,
    });
  }
  const viewer = createViewer({
    port: port(process.env.AGENT_BUS_VIEWER_PORT, 4317),
    busPort: port(process.env.AGENT_BUS_PORT, 8096),
    assets: assets satisfies ViewerAssets,
  });
  console.log(`Agent Bus viewer: ${viewer.url.href}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void viewer.close();
    });
  }
};

start().catch(() => {
  console.error("Viewer could not start. Build the viewer and check its local ports.");
  process.exitCode = 1;
});
