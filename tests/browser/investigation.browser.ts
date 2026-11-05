import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { startFixture } from "../../test/viewer-reading-fixture";
import { clickText, waitFor, withNativePage } from "./native-page";
import { isolatedTool } from "./tool-process";

// Test-only clock: intercept only the product's 15s scheduler, not browser/test timers.
function installClock() {
  const realSet = window.setTimeout.bind(window);
  const realClear = window.clearTimeout.bind(window);
  const scheduled = new Map<number, () => void>();
  let next = 1_000_000_000;
  let seen = 0;
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(window, "setTimeout", {
    configurable: true,
    writable: true,
    value: (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay !== 15_000 || typeof handler !== "function")
        return realSet(handler, delay, ...args);
      const id = next++;
      seen++;
      scheduled.set(id, () => handler(...args));
      return id;
    },
  });
  Object.defineProperty(window, "clearTimeout", {
    configurable: true,
    writable: true,
    value: (id?: number) => {
      if (id !== undefined && scheduled.delete(id)) return;
      realClear(id);
    },
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Reflect.set(window, "__INVESTIGATION_TEST_CLOCK__", {
    get seen() {
      return seen;
    },
    get pending() {
      return scheduled.size;
    },
    fire() {
      const item = scheduled.entries().next().value;
      if (!item) return false;
      scheduled.delete(item[0]);
      item[1]();
      return true;
    },
    visibility(value: DocumentVisibilityState) {
      visibility = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  });
}

type Control = {
  counters: { history: number; peers: number; thread: number };
  calls: Array<{
    operation: "history" | "search" | "peers" | "thread";
    arguments: Record<string, unknown>;
  }>;
};
/** The last history or search call, as [operation, args]: the window asked of the bus. */
const asked = (state: Control) => {
  const call = state.calls
    .filter((each) => each.operation === "history" || each.operation === "search")
    .at(-1);
  return [call?.operation, call?.arguments];
};
let stage = "arguments";
async function main() {
  const { values } = parseArgs({ options: { "capture-dir": { type: "string" } } });
  const capture = values["capture-dir"];
  if (capture !== undefined) {
    assert.ok(
      isAbsolute(capture) &&
        !capture.startsWith(Bun.fileURLToPath(new URL("../../", import.meta.url))),
      "capture directory must be private and outside repository"
    );
    await mkdir(capture, { recursive: true });
  }
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  assert.ok(port);
  await reservation.stop(true);
  stage = "fixture startup";
  const fixture = await startFixture({ viewerPort: port });
  const stop = () => {
    void fixture.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const controlUrl = `http://127.0.0.1:${fixture.controlPort}/control`;
  const control = async (): Promise<Control> => {
    const response = await fetch(controlUrl, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    return (await response.json()) as Control;
  };
  const configure = async (changes: Record<string, unknown>) => {
    const response = await fetch(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
  };
  const start = performance.now();
  try {
    await withNativePage(1280, 650, async (page) => {
      await page.addInitScript(installClock);
      await page.goto(fixture.url, { timeout: 10_000 });
      await waitFor(page, ".context-group button");
      await page.waitForFunction(
        () => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__")?.pending === 1,
        undefined,
        { timeout: 5_000 }
      );
      let state = await control();
      assert.deepEqual(asked(state), ["history", { direction: "backward", limit: 200 }]);
      assert.ok(
        await page.evaluate(() => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").seen >= 1),
        "15s scheduler requested"
      );

      stage = "server criteria";
      await page.locator('input[maxlength="256"]').fill("Synthetic", { timeout: 5_000 });
      await page.locator('input[maxlength="512"]').fill("#alpha", { timeout: 5_000 });
      await page.locator('[aria-label="Apply search"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".observation-scope")).some(
            (node) =>
              node.textContent?.includes("Best matches at commit ") &&
              node.textContent.includes("Synthetic") &&
              node.textContent.includes("#alpha")
          ),
        undefined,
        { timeout: 5_000 }
      );
      state = await control();
      assert.deepEqual(asked(state), [
        "search",
        { participants: ["#alpha"], text: "Synthetic", limit: 200 },
      ]);

      stage = "failed criteria and separate peers";
      await configure({ historyError: true });
      await page.locator('input[maxlength="256"]').fill("Different", { timeout: 5_000 });
      await page.locator('[aria-label="Apply search"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".notice")).some((node) =>
            node.textContent?.includes("previous criteria")
          ) &&
          Array.from(document.querySelectorAll(".observation")).some((node) =>
            node.textContent?.includes("Refresh failed")
          ),
        undefined,
        { timeout: 5_000 }
      );
      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".observation-scope")).map(
          (node) => node.textContent ?? ""
        )
      );
      assert.ok(labels.some((label) => label.includes("Synthetic") && label.includes("#alpha")));
      assert.ok(
        labels.every((label) => !label.includes("Different")),
        "old data is not labeled as new criteria"
      );
      await page.locator(".peer-link").click({ timeout: 5_000 });
      await waitFor(page, ".peer-row");
      const beforePeers = (await control()).counters.peers;
      await page.locator('[aria-label="Refresh current peers"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () =>
          document.querySelector(".peer-row") !== null &&
          !Array.from(document.querySelectorAll(".observation")).some((node) =>
            node.textContent?.includes("Refreshing")
          ),
        undefined,
        { timeout: 5_000 }
      );
      assert.ok(
        (await control()).counters.peers > beforePeers,
        "peers remain available during history failure"
      );

      // Activity as the serve reports it, through the public projection: active shows nothing,
      // inactive and unknown (with its reason) are labelled, and mute ids stay inert text.
      stage = "peer activity";
      const peerRows = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".peer-row")).map((row) => ({
          address: row.querySelector(".peer-address")?.textContent ?? "",
          meta: row.querySelector(".peer-meta")?.textContent ?? "",
          muted: Array.from(row.querySelectorAll(".peer-topics"))
            .filter((block) => block.querySelector("span")?.textContent === "Muted")
            .flatMap((block) =>
              Array.from(block.querySelectorAll(".audience-value")).map(
                (value) => value.textContent ?? ""
              )
            ),
          markup: row.querySelector("i") !== null,
        }))
      );
      const shownPeer = (address: string) => {
        const found = peerRows.find((each) => each.address === address);
        assert.ok(found, `peer row ${address}`);
        return found;
      };
      for (const address of ["fixture/alice", "fixture/dave"]) {
        assert.ok(
          !/Inactive|Activity unknown/.test(shownPeer(address).meta),
          `${address} shows no activity`
        );
        assert.deepEqual(shownPeer(address).muted, [], `${address} shows no mutes`);
      }
      assert.ok(shownPeer("fixture/bob").meta.endsWith(" · Inactive"), "inactive label");
      assert.deepEqual(shownPeer("fixture/bob").muted, [
        "*",
        "#<i>beta\\u202e</i>",
        "concern opa/ux",
      ]);
      assert.equal(shownPeer("fixture/bob").markup, false, "a mute id is never markup");
      assert.ok(
        shownPeer("fixture/carol").meta.endsWith(" · Activity unknown: damaged mail"),
        "unknown label with its reason"
      );
      assert.deepEqual(shownPeer("fixture/carol").muted, []);

      // A conversation is the bus's reply tree, which outlives the history window: when the
      // window moves on, the tree is read again at the new commit and keeps the reader's place.
      stage = "clear and follow";
      await configure({ historyError: false });
      await page.locator('[aria-label="Clear search"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".observation-scope")).some((node) =>
            node.textContent?.includes("All entries at commit ")
          ),
        undefined,
        { timeout: 5_000 }
      );
      state = await control();
      assert.deepEqual(asked(state), ["history", { direction: "backward", limit: 200 }]);
      await clickText(page, ".context-item", "#alpha");
      const row = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".conversation-row")).findIndex((node) =>
          node.textContent?.includes("Alpha root")
        )
      );
      assert.ok(row >= 0);
      await page.locator(".conversation-row").nth(row).click({ timeout: 5_000 });
      await waitFor(page, '[data-message-id="msg-a-root"]');
      await page.waitForFunction(() => document.activeElement?.id === "thread-heading", undefined, {
        timeout: 5_000,
      });
      const before = await page.evaluate(() => {
        const area = document.querySelector<HTMLElement>(".thread-scroll")!;
        area.scrollTop = 100;
        const anchor = document.querySelector<HTMLElement>('[data-message-id="msg-a-root"]')!;
        anchor.focus({ preventScroll: true });
        return {
          scroll: area.scrollTop,
          offset: anchor.getBoundingClientRect().top - area.getBoundingClientRect().top,
          top: anchor.getBoundingClientRect().top,
        };
      });
      assert.ok(before.scroll > 0, "reading region has a meaningful scroll offset");
      await configure({ mode: "changed" });
      await page.waitForFunction(
        () => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__")?.pending === 1,
        undefined,
        { timeout: 5_000 }
      );
      assert.equal(
        await page.evaluate(() => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").fire()),
        true
      );
      await waitFor(page, '[data-message-id="msg-g-new-reply"]');
      const after = await page.evaluate(() => {
        const area = document.querySelector<HTMLElement>(".thread-scroll")!;
        const anchor = document.querySelector<HTMLElement>('[data-message-id="msg-a-root"]')!;
        return {
          id: document.activeElement?.getAttribute("data-message-id"),
          tag: document.activeElement?.tagName,
          className: document.activeElement?.className,
          scroll: area.scrollTop,
          offset: anchor.getBoundingClientRect().top - area.getBoundingClientRect().top,
          top: anchor.getBoundingClientRect().top,
        };
      });
      assert.equal(
        after.id,
        "msg-a-root",
        `focus continuity: ${JSON.stringify({ before, after })}`
      );
      assert.ok(
        Math.abs(after.offset - before.offset) <= 1,
        `visual reading anchor continuity: ${JSON.stringify({ before, after })}`
      );
      assert.ok(
        Math.abs(after.top - before.top) <= 1,
        `absolute reading anchor continuity: ${JSON.stringify({ before, after })}`
      );
      assert.deepEqual(
        await page.evaluate(() => {
          const indicator = document.querySelector<HTMLElement>(".reading-observation-state")!;
          const rect = indicator.getBoundingClientRect();
          return {
            text: indicator.textContent?.trim(),
            withinViewport:
              rect.top >= 0 &&
              rect.bottom <= innerHeight &&
              rect.left >= 0 &&
              rect.right <= innerWidth,
            insideScroll: Boolean(indicator.closest(".thread-scroll")),
          };
        }),
        { text: "", withinViewport: true, insideScroll: false },
        "a followed conversation is not retained"
      );
      assert.ok(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll(".thread-scroll .observation-scope")).some((node) =>
            /^Whole reply tree at commit \d+$/.test(node.textContent ?? "")
          )
        ),
        "the followed tree is labelled with its new commit"
      );
      if (capture) await page.screenshot({ path: join(capture, "investigation-followed.png") });

      stage = "pause, visibility and manual refresh";
      await page.waitForFunction(
        () => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__")?.pending === 1,
        undefined,
        { timeout: 5_000 }
      );
      await configure({ historyDelayMs: 500 });
      const beforeOverlap = await control();
      assert.equal(
        await page.evaluate(() => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").fire()),
        true
      );
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".observation")).some((node) =>
            node.textContent?.includes("Refreshing")
          ),
        undefined,
        { timeout: 5_000 }
      );
      assert.equal(
        await page.evaluate(() => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").fire()),
        true
      );
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll(".observation")).some((node) =>
            node.textContent?.includes("Refreshing")
          ),
        undefined,
        { timeout: 5_000 }
      );
      assert.equal(
        (await control()).counters.history,
        beforeOverlap.counters.history + 1,
        "repeated ticks do not overlap a pending history read"
      );
      await configure({ historyDelayMs: 0 });
      await page.locator('[aria-label="Pause automatic refresh"]').click({ timeout: 5_000 });
      assert.equal(
        await page.evaluate(() => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").pending),
        0
      );
      const paused = await control();
      await page.locator('[aria-label="Refresh all"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll(".observation")).some((node) =>
            node.textContent?.includes("Refreshing")
          ),
        undefined,
        { timeout: 5_000 }
      );
      const manual = await control();
      assert.equal(manual.counters.history, paused.counters.history + 1);
      assert.equal(manual.counters.peers, paused.counters.peers + 1);
      await page.locator('[aria-label="Resume automatic refresh"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__")?.pending === 1,
        undefined,
        { timeout: 5_000 }
      );
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll(".observation")).some((node) =>
            node.textContent?.includes("Refreshing")
          ),
        undefined,
        { timeout: 5_000 }
      );
      const resumed = await control();
      assert.equal(resumed.counters.history, manual.counters.history + 1);
      assert.equal(resumed.counters.peers, manual.counters.peers + 1);
      await page.evaluate(() =>
        Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").visibility("hidden")
      );
      assert.equal(
        await page.evaluate(() => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").pending),
        0
      );
      await page.evaluate(() =>
        Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").visibility("visible")
      );
      await page.waitForFunction(
        () => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__")?.pending === 1,
        undefined,
        { timeout: 5_000 }
      );
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll(".observation")).some((node) =>
            node.textContent?.includes("Refreshing")
          ),
        undefined,
        { timeout: 5_000 }
      );
      const visible = await control();
      assert.equal(visible.counters.history, resumed.counters.history + 1);
      assert.equal(visible.counters.peers, resumed.counters.peers + 1);

      stage = "context flow continuity";
      await configure({ mode: "initial" });
      await page.locator('[aria-label="Refresh activity"]').click({ timeout: 5_000 });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".conversation-row")).some((node) =>
            node.textContent?.includes("Alpha root")
          ),
        undefined,
        { timeout: 5_000 }
      );
      await clickText(page, "button", "Read context");
      await page.waitForFunction(
        () =>
          document.activeElement?.id === "thread-heading" &&
          document.activeElement.textContent?.includes("Context flow"),
        undefined,
        { timeout: 5_000 }
      );
      await waitFor(page, '[data-message-id="msg-a-root"]');
      const flowBefore = await page.evaluate(() => {
        const area = document.querySelector<HTMLElement>(".thread-scroll")!;
        const anchor = document.querySelector<HTMLElement>('[data-message-id="msg-a-root"]')!;
        area.scrollTop = 100;
        anchor.focus({ preventScroll: true });
        return {
          scroll: area.scrollTop,
          offset: anchor.getBoundingClientRect().top - area.getBoundingClientRect().top,
          top: anchor.getBoundingClientRect().top,
        };
      });
      assert.ok(flowBefore.scroll > 0, "context flow has a meaningful scroll offset");
      await configure({ mode: "changed" });
      await page.waitForFunction(
        () => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__")?.pending === 1,
        undefined,
        { timeout: 5_000 }
      );
      assert.equal(
        await page.evaluate(() => Reflect.get(window, "__INVESTIGATION_TEST_CLOCK__").fire()),
        true
      );
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll(".conversation-row")).some((node) =>
            node.textContent?.includes("Alpha root")
          ),
        undefined,
        { timeout: 5_000 }
      );
      const flowAfter = await page.evaluate(() => {
        const area = document.querySelector<HTMLElement>(".thread-scroll")!;
        const anchor = document.querySelector<HTMLElement>('[data-message-id="msg-a-root"]');
        const indicator = document.querySelector<HTMLElement>(".reading-observation-state");
        const rect = indicator?.getBoundingClientRect();
        return {
          id: document.activeElement?.getAttribute("data-message-id"),
          tag: document.activeElement?.tagName,
          className: document.activeElement?.className,
          scroll: area.scrollTop,
          offset: anchor
            ? anchor.getBoundingClientRect().top - area.getBoundingClientRect().top
            : null,
          top: anchor?.getBoundingClientRect().top ?? null,
          indicator: indicator?.textContent?.trim(),
          indicatorVisible: Boolean(
            rect &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight &&
              rect.left >= 0 &&
              rect.right <= innerWidth
          ),
          indicatorOutsideScroll: !indicator?.closest(".thread-scroll"),
        };
      });
      assert.equal(
        flowAfter.id,
        "msg-a-root",
        `context flow focus continuity: ${JSON.stringify({ flowBefore, flowAfter })}`
      );
      assert.ok(
        flowAfter.offset !== null &&
          Math.abs(flowAfter.offset - flowBefore.offset) <= 1 &&
          flowAfter.top !== null &&
          Math.abs(flowAfter.top - flowBefore.top) <= 1,
        `context flow visual anchor continuity: ${JSON.stringify({ flowBefore, flowAfter })}`
      );
      assert.equal(flowAfter.indicator, "Outside current observation");
      assert.equal(flowAfter.indicatorVisible && flowAfter.indicatorOutsideScroll, true);
      await clickText(page, "button", "Read context");
      await page.waitForFunction(
        () =>
          document.activeElement?.id === "thread-heading" &&
          document.querySelector('[data-message-id="msg-a-root"]') === null &&
          document.querySelector(".reading-observation-state")?.textContent?.trim() === "",
        undefined,
        { timeout: 5_000 }
      );
      assert.equal(
        await page.evaluate(() => document.querySelector<HTMLElement>(".thread-scroll")?.scrollTop),
        0,
        "explicit Read context starts the accepted flow at the top"
      );
      if (capture) {
        if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "light")
          await page.locator('[aria-label="Dark theme"]').click({ timeout: 5_000 });
        await page.waitForFunction(
          () => document.documentElement.dataset.theme === "light",
          undefined,
          { timeout: 5_000 }
        );
        await page.screenshot({ path: join(capture, "investigation-desktop.png") });
        await page.locator('[aria-label="Dark theme"]').click({ timeout: 5_000 });
        await page.waitForFunction(
          () => document.documentElement.dataset.theme === "dark",
          undefined,
          { timeout: 5_000 }
        );
        await page.screenshot({ path: join(capture, "investigation-dark.png") });
      }
      for (const width of [390, 320]) {
        await page.setViewportSize(width, 844);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `no horizontal page overflow at ${width}px`
        );
        if (capture && width === 390)
          await page.screenshot({ path: join(capture, "investigation-mobile.png") });
      }
    });
    console.log(
      `PASS investigation, last-good and refresh continuity (${((performance.now() - start) / 1000).toFixed(2)}s)`
    );
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
