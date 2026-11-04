import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "@browserbasehq/stagehand";
import { PAGE_CATALOGUE_VERSION } from "../../test/bus-pages";
import {
  FIXTURE_LEDGER,
  INVESTIGATION_ARGS,
  STRESS_MESSAGES,
  startFixture,
} from "../../test/viewer-reading-fixture";
import { checkReference } from "../../viewer/shared/public";
import {
  assertNoExternalLoads,
  auditExternalLoads,
  clickText,
  waitFor,
  withNativePage,
} from "./native-page";
import { isolatedTool } from "./tool-process";

// Deliberately not *.test.ts: one connected pinned-investigation journey on the synthetic
// fixture, run only through test:browser:pinned. It proves wiring, never what a provider holds.

type Control = {
  head: number;
  counters: Record<"history" | "peers" | "thread" | "refused" | "aborted", number>;
  calls: Array<{
    operation: string;
    arguments: Record<string, unknown>;
    t?: number;
    offset: number;
  }>;
};

// The link format the agent guidance documents, built here rather than by the viewer's own
// helper, so a drift shared by the viewer's encoder and parser fails.
const linkFor = (url: string, reference: unknown) =>
  `${url}#investigation=${encodeURIComponent(JSON.stringify(reference))}`;

// The stress mode's two byte-cut pages, pinned in test/viewer-bus-pages.test.ts.
const FIRST_PAGE = 15;
const COMMITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 21, 22];
const TIMES = STRESS_MESSAGES.map((message) => message.ts);
const DELAY_MS = 3_000;

const statusIs = (page: Page, text: string, timeout = 5_000) =>
  page.waitForFunction(
    (expected) => document.querySelector(".pinned-status")?.textContent === expected,
    text,
    { timeout }
  );

const screen = (page: Page) =>
  page.evaluate(() => ({
    status: document.querySelector(".pinned-status")?.textContent,
    coverage: document.querySelector(".pinned-coverage")?.textContent ?? null,
    counts: document.querySelector(".pinned-counts")?.textContent,
    actions: Array.from(document.querySelectorAll(".pinned-actions button")).map(
      (button) => button.textContent
    ),
    commits: Array.from(document.querySelectorAll(".pinned-entry-meta [data-t]")).map((node) =>
      Number(node.getAttribute("data-t"))
    ),
    times: Array.from(document.querySelectorAll(".pinned-entries time")).map((node) =>
      node.getAttribute("datetime")
    ),
    summaryClaimsComplete:
      document.querySelector(".pinned-summary")?.textContent?.includes("Complete") ?? false,
    ledger: document.querySelector(".pinned-identity dd")?.textContent,
    commit: document.querySelector(".pinned-identity dd[data-t]")?.getAttribute("data-t"),
  }));

/** Sets the reader's theme through its own control, as viewer.browser.ts does. */
const theme = async (page: Page, wanted: "light" | "dark") => {
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== wanted)
    await page.locator('[aria-label="Dark theme"]').click({ timeout: 5_000 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), wanted);
};

/** The narrow layout: no sideways scroll, and the visible action reachable where it is drawn. */
const narrow = async (page: Page, action: string) => {
  await page.setViewportSize(320, 700);
  assert.deepEqual(
    await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    { width: 320, height: 700 },
    "actual narrow viewport"
  );
  const layout = await page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll(".pinned-actions button")).find(
      (node) => node.textContent === label
    );
    button?.scrollIntoView({ block: "center" });
    const rect = button?.getBoundingClientRect();
    const hit = rect
      ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      : null;
    const header = document.querySelector(".app-header");
    const link = document.querySelector(".app-header .text-action");
    return {
      scrollFits: document.documentElement.scrollWidth <= innerWidth,
      headerOneLine: Boolean(
        header &&
          link &&
          header.scrollWidth <= header.clientWidth &&
          link.getClientRects().length === 1 &&
          (document.querySelector(".brand")?.getBoundingClientRect().height ?? Infinity) <= 24
      ),
      summaryFits:
        (document.querySelector(".pinned-summary")?.getBoundingClientRect().right ?? Infinity) <=
        innerWidth,
      buttonInView: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth),
      buttonHit: Boolean(button && hit && button.contains(hit)),
    };
  }, action);
  assert.deepEqual(layout, {
    scrollFits: true,
    headerOneLine: true,
    summaryFits: true,
    buttonInView: true,
    buttonHit: true,
  });
  await page.evaluate(() => document.querySelector(".pinned-summary")?.scrollIntoView());
};

/**
 * The fixture's Markdown message shown in place, with its own lists' markers, indentation and no
 * entry separators inside it: the outer entry list's styles stop at its own items.
 */
const markdownLists = async (page: Page) => {
  const lists = await page.evaluate(() => {
    const article = Array.from(document.querySelectorAll(".pinned-entries article")).find(
      (node) =>
        node.querySelector(".provenance-fields div:last-child dd")?.textContent === "msg-markdown"
    );
    article?.scrollIntoView({ block: "start" });
    const body = article?.querySelector(".markdown");
    const style = (selector: string) => {
      const node = body?.querySelector(selector);
      return node ? getComputedStyle(node) : undefined;
    };
    const marked = (selector: string) => {
      const type = style(selector)?.listStyleType;
      return type !== undefined && type !== "none";
    };
    const indented = (selector: string) =>
      Number.parseFloat(style(selector)?.paddingLeft ?? "0") > 0;
    const items = Array.from(body?.querySelectorAll("li") ?? []);
    return {
      ordered: style(":scope > ol")?.listStyleType,
      orderedIndented: indented(":scope > ol"),
      bullets: marked(":scope > ul"),
      bulletsIndented: indented(":scope > ul"),
      nested: marked("ul > li > ul"),
      nestedIndented: indented("ul > li > ul"),
      items: items.length,
      separators: items.filter((item) => getComputedStyle(item).borderTopStyle !== "none").length,
      scrollFits: document.documentElement.scrollWidth <= innerWidth,
    };
  });
  assert.deepEqual(lists, {
    ordered: "decimal",
    orderedIndented: true,
    bullets: true,
    bulletsIndented: true,
    nested: true,
    nestedIndented: true,
    items: 8,
    separators: 0,
    scrollFits: true,
  });
};

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
  const capture = async (page: Page, name: string) => {
    if (captureDir !== undefined) await page.screenshot({ path: join(captureDir, name) });
  };
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port;
  assert.ok(port);
  await reserve.stop(true);
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
  try {
    let started = performance.now();
    stage = "refused references";
    await withNativePage(1440, 900, async (page) => {
      await page.goto(`${fixture.url}#investigation=%7Bbad`, { timeout: 10_000 });
      await waitFor(page, "#pinned-heading");
      await statusIs(
        page,
        "This link does not carry a pinned history reference in the form the bus returns."
      );
      const backward = {
        name: "history",
        catalogueVersion: PAGE_CATALOGUE_VERSION,
        ledger: FIXTURE_LEDGER,
        t: 20,
        criteria: { kinds: ["message"], direction: "backward" },
      };
      await page.goto(linkFor(fixture.url, backward), { timeout: 10_000 });
      await statusIs(
        page,
        "This reference asks for more than a forward message reading, which the viewer does not read."
      );
      assert.equal(
        await page.evaluate(() => document.querySelector("#pinned-heading")?.textContent),
        "Reference refused"
      );
      const { counters } = await control();
      assert.deepEqual(
        [counters.history, counters.peers, counters.thread],
        [0, 0, 0],
        "a refused reference reads nothing, and the live viewer does not start behind it"
      );
    });
    console.log(
      `PASS refused pinned references read nothing (${((performance.now() - started) / 1000).toFixed(2)}s)`
    );

    started = performance.now();
    stage = "pinned reference";
    await configure({ mode: "stress", historyDelayMs: DELAY_MS });
    const { head } = await control();
    const { limit: _, ...criteria } = INVESTIGATION_ARGS;
    const reference = {
      name: "history",
      catalogueVersion: PAGE_CATALOGUE_VERSION,
      ledger: FIXTURE_LEDGER,
      t: head,
      criteria,
    };
    const checked = checkReference(reference);
    assert.ok("reference" in checked, "the journey's reference is the bus's echoed form");
    assert.equal(JSON.stringify(checked.reference), JSON.stringify(reference));

    await withNativePage(1440, 900, async (page) => {
      await auditExternalLoads(page);
      stage = "open by link";
      await page.goto(linkFor(fixture.url, reference), { timeout: 10_000 });
      await statusIs(page, `Reading page 1 at commit ${head}.`);
      let shown = await screen(page);
      assert.equal(shown.ledger, FIXTURE_LEDGER);
      assert.equal(shown.commit, String(head));

      stage = "progress";
      await statusIs(page, `Reading page 2 at commit ${head}.`, DELAY_MS + 5_000);
      shown = await screen(page);
      assert.deepEqual(
        shown.commits,
        COMMITS.slice(0, FIRST_PAGE),
        "page 1 is shown as it arrived"
      );
      assert.equal(
        shown.counts,
        "15 entries kept · 1 page read · 0 omitted by the viewer · 0 unreadable"
      );
      assert.deepEqual(shown.actions, ["Cancel"]);
      const reading = (await control()).calls;
      assert.deepEqual(
        reading.map((call) => call.offset),
        [0, FIRST_PAGE],
        "page 2 follows the cursor page 1 returned"
      );

      stage = "cancel";
      await clickText(page, ".pinned-actions button", "Cancel");
      await statusIs(page, "Cancelled: you stopped the reading.");
      shown = await screen(page);
      assert.equal(
        shown.coverage,
        "Partial: the earliest 15 entries of the window. The rest were not kept, and nothing is claimed about them."
      );
      assert.deepEqual(shown.actions, ["Read again"]);
      assert.equal(shown.summaryClaimsComplete, false, "a cancelled reading never says Complete");
      assert.deepEqual(shown.commits, COMMITS.slice(0, FIRST_PAGE));
      assert.deepEqual(shown.times, TIMES.slice(0, FIRST_PAGE));
      // The cancelled page's upstream request ends with it; the fixture's counter is the only
      // evidence here, and it says nothing about what a real store stops doing.
      const deadline = performance.now() + 5_000;
      let aborted = (await control()).counters.aborted;
      while (aborted !== 1 && performance.now() < deadline) {
        await Bun.sleep(50);
        aborted = (await control()).counters.aborted;
      }
      assert.equal(aborted, 1, "the cancelled page's upstream request was aborted");

      stage = "partial screenshots";
      await theme(page, "light");
      await capture(page, "pinned-desktop-cancelled-light.png");
      await theme(page, "dark");
      await capture(page, "pinned-desktop-cancelled-dark.png");
      await theme(page, "light");
      await narrow(page, "Read again");
      await capture(page, "pinned-320-cancelled.png");
      await page.setViewportSize(1440, 900);

      stage = "read again";
      await configure({ historyDelayMs: 0 });
      const rerun = performance.now();
      await clickText(page, ".pinned-actions button", "Read again");
      await statusIs(
        page,
        `Complete: all 16 messages matching these criteria at commit ${head}.`,
        9_000
      );
      const rerunSeconds = (performance.now() - rerun) / 1000;
      shown = await screen(page);
      assert.deepEqual(shown.commits, COMMITS);
      assert.deepEqual(shown.times, TIMES);
      assert.equal(
        shown.counts,
        "16 entries kept · 2 pages read · 0 omitted by the viewer · 0 unreadable"
      );
      assert.equal(shown.coverage, null);
      assert.deepEqual(shown.actions, ["Read again"]);
      const final = await control();
      assert.deepEqual(
        final.calls.map((call) => [call.operation, call.t, call.offset, call.arguments]),
        [0, FIRST_PAGE, 0, FIRST_PAGE].map((offset) => [
          "history",
          head,
          offset,
          INVESTIGATION_ARGS,
        ]),
        "every page at the reference's commit with its criteria; the rerun starts afresh"
      );
      assert.deepEqual(
        [final.counters.peers, final.counters.thread, final.counters.refused],
        [0, 0, 0],
        "no live observation runs beside the investigation"
      );
      await assertNoExternalLoads(page);

      stage = "complete screenshots";
      await page.evaluate(() => document.querySelector(".pinned-summary")?.scrollIntoView());
      await capture(page, "pinned-desktop-complete-light.png");
      await markdownLists(page);
      await capture(page, "pinned-desktop-markdown-lists.png");
      await narrow(page, "Read again");
      await capture(page, "pinned-320-complete.png");
      await markdownLists(page);
      await capture(page, "pinned-320-markdown-lists.png");
      console.log(`rerun completed in ${rerunSeconds.toFixed(2)}s`);
    });
    console.log(
      `PASS pinned investigation opened by link, cancelled with partial progress and read again to completion (${((performance.now() - started) / 1000).toFixed(2)}s)`
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
      ? `Browser assertion failed during ${stage}: ${error.message}`
      : `Browser check failed during ${stage}`
  );
  process.exitCode = 1;
}
