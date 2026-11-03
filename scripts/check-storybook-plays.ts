import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import storybookPackage from "storybook/package.json";
import { withNativePage } from "../tests/browser/native-page";
import { isolatedTool } from "../tests/browser/tool-process";
import { type PlayEvent, type PlayObservation, playVerdict } from "./storybook-play-verdict";

// Version-coupled native channel adapter borrowed from OPA website's checker.
// Requalify against real positive AND negative stories when Storybook changes.
async function observePlay({ storyId, timeoutMs }: { storyId: string; timeoutMs: number }) {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";
  const preview: unknown = Reflect.get(window, "__STORYBOOK_PREVIEW__");
  const channel: unknown = Reflect.get(window, "__STORYBOOK_ADDONS_CHANNEL__");
  const render = record(preview) ? preview.currentRender : undefined;
  const story = record(render) ? render.story : undefined;
  if (!record(story) || typeof story.playFunction !== "function")
    return { events: [], end: "no-play" } satisfies PlayObservation;
  if (!record(channel)) throw new Error("Storybook channel unavailable");
  const on = channel.on;
  const off = channel.off;
  const emit = channel.emit;
  if (typeof on !== "function" || typeof off !== "function" || typeof emit !== "function")
    throw new Error("Storybook channel incompatible");
  return new Promise<PlayObservation>((resolve) => {
    const events: PlayEvent[] = [];
    const listeners: Array<{ type: string; listener: (payload: unknown) => void }> = [];
    let settling = false;
    let frame: number | undefined;
    const finish = (end: PlayObservation["end"]) => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const { type, listener } of listeners) off.call(channel, type, listener);
      resolve({ events, end });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    for (const type of [
      "storyRenderPhaseChanged",
      "storyFinished",
      "playFunctionThrewException",
      "unhandledErrorsWhilePlaying",
      "storyThrewException",
      "storyErrored",
    ]) {
      const listener = (payload: unknown) => {
        const data = record(payload) ? payload : {};
        if (typeof data.storyId === "string" && data.storyId !== storyId) return;
        events.push({
          type,
          ...(typeof data.storyId === "string" ? { storyId: data.storyId } : {}),
          ...(typeof data.newPhase === "string" ? { phase: data.newPhase } : {}),
          ...(typeof data.status === "string" ? { status: data.status } : {}),
        });
        if (type === "storyFinished" && !settling) {
          settling = true;
          // Keep listeners through subsequent microtasks and two painted frames:
          // an error after success still defeats the verdict, without sleep-based sync.
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => finish("finished"));
          });
        }
      };
      listeners.push({ type, listener });
      on.call(channel, type, listener);
    }
    emit.call(channel, "forceRemount", { storyId });
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

async function staticStorybook() {
  const root = new URL("../dist/storybook/", import.meta.url);
  assert.ok(await Bun.file(new URL("index.json", root)).exists(), "build Storybook first");
  const files = new Map<string, Blob>();
  for await (const path of new Bun.Glob("**/*").scan({
    cwd: Bun.fileURLToPath(root),
    onlyFiles: true,
  })) {
    const file = Bun.file(new URL(path, root));
    files.set(`/${path}`, new Blob([await file.arrayBuffer()], { type: file.type }));
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, self) {
      const url = new URL(request.url);
      if (request.headers.get("host") !== `127.0.0.1:${self.port}`)
        return new Response("Refused", { status: 403 });
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Refused", { status: 405 });
      const file = files.get(url.pathname === "/" ? "/index.html" : url.pathname);
      return file
        ? new Response(request.method === "HEAD" ? null : file, {
            headers: {
              "content-type": file.type,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
              "content-security-policy":
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            },
          })
        : new Response("Not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, close: () => server.stop(true) };
}

async function main() {
  assert.equal(storybookPackage.version, "10.6.3", "requalify Storybook event adapter");
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { url: { type: "string" } },
  });
  const ids = positionals.length
    ? positionals
    : [
        "reader-message-body--rich-and-hostile",
        "reader-message-body--large-source",
        "reader-message-body--dark-mobile",
        "viewer-context-journey--cross-audience",
        "viewer-context-journey--mobile-context",
        "viewer-investigation--exact-search-and-clear",
        "viewer-investigation--dark-narrow",
        "viewer-automatic-refresh--pause-and-resume",
        "viewer-observation-states--empty-and-all-omitted",
        "viewer-observation-states--unavailable-then-observed",
        "viewer-observation-states--failed-refresh-keeps-last-good",
        "viewer-observation-states--refresh-announces-arrivals",
        "viewer-observation-states--retained-reading",
        "viewer-stopped--render-defect",
      ];
  assert.ok(
    ids.every((id) => /^[a-zA-Z0-9_-]+$/.test(id)),
    "literal story IDs required"
  );
  const owned = values.url === undefined ? await staticStorybook() : undefined;
  const stop = () => {
    void owned?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const base = new URL(values.url ?? owned?.url ?? "");
    assert.ok(
      base.protocol === "http:" &&
        base.hostname === "127.0.0.1" &&
        base.port &&
        base.pathname === "/" &&
        !base.search &&
        !base.hash &&
        !base.username &&
        !base.password,
      "explicit loopback HTTP origin required"
    );
    const response = await fetch(new URL("index.json", base), {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    assert.ok(response.ok, "Storybook index available");
    const index: unknown = await response.json();
    assert.ok(isRecord(index) && isRecord(index.entries), "Storybook index shape");
    let failed = false;
    for (const id of ids) {
      const entry: unknown = index.entries[id];
      assert.ok(isRecord(entry) && entry.type === "story", "requested story exists");
      const start = performance.now();
      const mobile = id.endsWith("--mobile-context") || id.endsWith("--dark-mobile");
      const narrow = id.endsWith("--dark-narrow");
      await withNativePage(
        narrow ? 320 : mobile ? 390 : 1440,
        narrow ? 640 : mobile ? 844 : 900,
        async (page) => {
          await page.goto(new URL(`iframe.html?id=${id}&viewMode=story`, base).href, {
            timeout: 10_000,
          });
          await page.waitForFunction(
            (storyId) => {
              const preview: unknown = Reflect.get(window, "__STORYBOOK_PREVIEW__");
              if (!preview || typeof preview !== "object") return false;
              const render: unknown = Reflect.get(preview, "currentRender");
              return (
                render !== null &&
                typeof render === "object" &&
                Reflect.get(render, "id") === storyId &&
                ["finished", "errored"].includes(String(Reflect.get(render, "phase")))
              );
            },
            id,
            { timeout: 15_000 }
          );
          const observation = await page.evaluate(observePlay, { storyId: id, timeoutMs: 15_000 });
          const verdict = playVerdict(id, observation);
          if (!verdict.ok) console.error(JSON.stringify(observation));
          failed ||= !verdict.ok;
          console.log(
            `${verdict.ok ? "PASS" : "FAIL"} ${id}: ${verdict.reason} (${((performance.now() - start) / 1000).toFixed(2)}s)`
          );
        }
      );
    }
    if (failed) process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await owned?.close();
  }
}

if (import.meta.main) {
  try {
    await isolatedTool(import.meta.url, main);
  } catch {
    console.error("Storybook play check failed");
    process.exitCode = 1;
  }
}
