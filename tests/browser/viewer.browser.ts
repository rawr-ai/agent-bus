import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { startFixture } from "../../test/viewer-reading-fixture";
import {
  assertNoExternalLoads,
  auditExternalLoads,
  clickText,
  waitFor,
  withNativePage,
} from "./native-page";
import { isolatedTool } from "./tool-process";

// Deliberately not *.test.ts: these three connected native-browser journeys run
// only through test:browser, never during the millisecond pure-unit loop.
let stage = "arguments";
async function main() {
  const { values } = parseArgs({ options: { "capture-dir": { type: "string" } } });
  const captureDir = values["capture-dir"];
  if (captureDir !== undefined) {
    assert.ok(isAbsolute(captureDir), "capture directory must be absolute and private");
    assert.ok(
      !captureDir.startsWith(Bun.fileURLToPath(new URL("../../", import.meta.url))),
      "capture outside repository"
    );
    await mkdir(captureDir, { recursive: true });
  }
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port;
  assert.ok(port);
  await reserve.stop(true);
  // The fixture probes again and refuses if another owner claimed this port.
  stage = "compiled fixture startup";
  const fixture = await startFixture({ viewerPort: port });
  const stop = () => {
    void fixture.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let started = performance.now();
    stage = "native context and reply journey";
    await withNativePage(1440, 900, async (page) => {
      try {
        stage = "context: navigate compiled fixture";
        await page.goto(fixture.url, { timeout: 10_000 });
        stage = "context: wait observed context controls";
        await waitFor(page, ".context-group button");
        stage = "context: click alpha context";
        await clickText(page, ".context-item", "#alpha");
        stage = "context: wait context-flow heading";
        await page.waitForFunction(
          () => document.querySelector("#thread-heading")?.textContent === "Context flow",
          undefined,
          { timeout: 5_000 }
        );
        stage = "context: assert cross-audience source order";
        const ids = await page.evaluate(() =>
          Array.from(document.querySelectorAll("article[data-message-id]")).map((node) =>
            node.getAttribute("data-message-id")
          )
        );
        assert.deepEqual(ids.slice(0, 3), ["msg-a-root", "msg-b-direct-reply", "msg-c-beta-reply"]);
        const row = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".conversation-row")).findIndex((node) =>
            node.textContent?.includes("Alpha root")
          )
        );
        assert.ok(row >= 0);
        stage = "context: click root conversation row";
        await page.locator(".conversation-row").nth(row).click({ timeout: 5_000 });
        stage = "context: wait selected three-message conversation";
        await page.waitForFunction(
          () => document.querySelectorAll("article[data-message-id]").length === 3,
          undefined,
          { timeout: 5_000 }
        );
        stage = "context: wait explicit navigation focus before following a reply";
        await page.waitForFunction(
          () => document.activeElement?.id === "thread-heading",
          undefined,
          { timeout: 5_000 }
        );
        stage = "context: click third-message reply link";
        await page
          .locator('[data-message-id="msg-c-beta-reply"] .reply-link')
          .click({ timeout: 5_000 });
        stage = "context: wait parent message focus";
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("data-message-id") === "msg-b-direct-reply",
          undefined,
          { timeout: 5_000 }
        );
        stage = "context: click return-to-reply control";
        await clickText(page, "button", "Return to reply");
        stage = "context: wait original reply focus";
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("data-message-id") === "msg-c-beta-reply",
          undefined,
          { timeout: 5_000 }
        );
        stage = "context: native resource cleanup";
      } catch (error) {
        const errorFlags = {
          assertion: error instanceof assert.AssertionError,
          timeout: error instanceof Error && /timeout|timed out|deadline/i.test(error.message),
          connectionClosed:
            error instanceof Error && /connection.*closed|disconnected/i.test(error.message),
          targetLookup:
            error instanceof Error && /element|locator|selector|centroid/i.test(error.message),
        };
        const structure = await page
          .evaluate(() => {
            const link = document.querySelector('[data-message-id="msg-c-beta-reply"] .reply-link');
            const rect = link?.getBoundingClientRect();
            const center = rect
              ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
              : null;
            return {
              contexts: document.querySelectorAll(".context-group button").length,
              rows: document.querySelectorAll(".conversation-row").length,
              messageNodes: document.querySelectorAll("article[data-message-id]").length,
              alphaSelected:
                document.querySelector(".context-group .context-item.active")?.textContent ===
                "#alpha",
              contextFlow:
                document.querySelector("#thread-heading")?.textContent === "Context flow",
              conversationHeading:
                document.querySelector("#thread-heading")?.textContent === "Conversation",
              selectedMessageInHash: new URLSearchParams(location.hash.slice(1)).has("message"),
              parentFocused:
                document.activeElement?.getAttribute("data-message-id") === "msg-b-direct-reply",
              childFocused:
                document.activeElement?.getAttribute("data-message-id") === "msg-c-beta-reply",
              targetExists: link !== null,
              targetInViewport: Boolean(rect && rect.top >= 0 && rect.bottom <= innerHeight),
              targetHitTest: Boolean(link && center && link.contains(center)),
              targetTop: rect?.top ?? 0,
              targetBottom: rect?.bottom ?? 0,
              viewportHeight: innerHeight,
              historyError: document.querySelector(".context-rail .observation-error") !== null,
            };
          })
          .catch(() => ({ pageStateUnavailable: true }));
        console.error(JSON.stringify({ stage, ...errorFlags, ...structure }));
        if (captureDir)
          await page
            .screenshot({ path: join(captureDir, "failure-context.png") })
            .catch(() => undefined);
        throw error;
      }
    });
    console.log(
      `PASS connected cross-audience context and reply focus (${((performance.now() - started) / 1000).toFixed(2)}s)`
    );

    started = performance.now();
    stage = "native Markdown and theme journey";
    await withNativePage(1440, 900, async (page) => {
      await auditExternalLoads(page);
      await page.goto(`${fixture.url}#context=all&message=msg-hostile&page=thread`, {
        timeout: 10_000,
      });
      await waitFor(page, '[data-message-id="msg-hostile"] .markdown');
      const safety = await page.evaluate(() => {
        const body = document.querySelector('[data-message-id="msg-hostile"] .markdown');
        return {
          unsafe: body?.querySelectorAll("img,script,iframe,form,style,svg").length,
          hrefs: Array.from(body?.querySelectorAll("a") ?? []).map((a) => a.getAttribute("href")),
          externalResources: performance
            .getEntriesByType("resource")
            .filter((entry) => new URL(entry.name, location.href).origin !== location.origin)
            .length,
        };
      });
      assert.equal(safety.unsafe, 0, "hostile HTML and images have no executable DOM");
      assert.ok(
        safety.hrefs.length > 0 && safety.hrefs.every((href) => href?.startsWith("https://"))
      );
      assert.equal(safety.externalResources, 0, "reading does not load external resources");
      await assertNoExternalLoads(page);
      await page.locator('[aria-label="Dark theme"]').click({ timeout: 5_000 });
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      assert.ok(theme === "light" || theme === "dark");
      await page.reload({ timeout: 10_000 });
      await waitFor(page, '[data-message-id="msg-hostile"] .markdown');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      await page.goto(`${fixture.url}#context=all&message=msg-markdown&page=thread`, {
        timeout: 10_000,
      });
      await waitFor(page, '[data-message-id="msg-markdown"] .markdown table');
      if (captureDir) {
        if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "light")
          await page.locator('[aria-label="Dark theme"]').click({ timeout: 5_000 });
        await page.screenshot({ path: join(captureDir, "desktop-light.png") });
        await page.locator('[aria-label="Dark theme"]').click({ timeout: 5_000 });
        await page.screenshot({ path: join(captureDir, "desktop-dark.png") });
      }
      assert.equal(
        await page.locator('[data-message-id="msg-markdown"] .markdown pre code').count(),
        1
      );
      await page
        .locator('[data-message-id="msg-markdown"] [aria-label="Source"]')
        .click({ timeout: 5_000 });
      await waitFor(page, '[data-message-id="msg-markdown"] .message-source');
      assert.equal(await page.locator('[data-message-id="msg-markdown"] table').count(), 0);
      await assertNoExternalLoads(page);
    });
    console.log(
      `PASS connected Markdown safety, source and persistent theme (${((performance.now() - started) / 1000).toFixed(2)}s)`
    );

    started = performance.now();
    stage = "native mobile journey";
    await withNativePage(390, 844, async (page) => {
      await page.goto(fixture.url, { timeout: 10_000 });
      await waitFor(page, ".context-group button");
      await clickText(page, ".context-item", "#alpha");
      await page.waitForFunction(
        () => document.activeElement?.id === "conversation-heading",
        undefined,
        { timeout: 5_000 }
      );
      await clickText(page, "button", "Read context");
      await page.waitForFunction(() => document.activeElement?.id === "thread-heading", undefined, {
        timeout: 5_000,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      if (captureDir) await page.screenshot({ path: join(captureDir, "mobile-context.png") });
      await page.locator('[aria-label="Back to conversations"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () => document.activeElement?.id === "conversation-heading",
        undefined,
        { timeout: 5_000 }
      );
      await page
        .locator('.conversation-list [aria-label="Back to contexts"]')
        .click({ timeout: 5_000 });
      await page.waitForFunction(
        () => document.activeElement?.id === "contexts-heading",
        undefined,
        { timeout: 5_000 }
      );
    });
    console.log(
      `PASS connected mobile navigation and focus (${((performance.now() - started) / 1000).toFixed(2)}s)`
    );
    stage = "owned fixture cleanup";
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await fixture.close();
  }
  assert.equal(fixture.viewerExitCode(), 0, "owned compiled viewer exited cleanly");
}

try {
  await isolatedTool(import.meta.url, main);
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? `Browser assertion failed: ${error.message}`
      : `Browser check failed during ${stage}`
  );
  process.exitCode = 1;
}
