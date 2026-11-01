import { parseArgs } from "node:util";
import { withNativePage } from "./native-page";
import { isolatedTool } from "./tool-process";

// Opt-in DOM-only qualification of the live viewer. Real content stays inside
// the page: only structural booleans, counts and elapsed time cross this boundary.
const result = {
  passed: false,
  historyObserved: false,
  historyUnavailable: false,
  historyEmpty: false,
  historySettled: false,
  contextSelected: false,
  contextFlow: false,
  visibleMessages: 0,
  messageReadingProved: false,
  literalContextMembership: false,
  fullSourceVisible: false,
  sourceUnclamped: false,
  literalAudiences: false,
  themeChanged: false,
  peersObserved: false,
  peersUnavailable: false,
  peerRows: 0,
  elapsedMillis: 0,
};

async function main() {
  const start = performance.now();
  try {
    const { values } = parseArgs({ options: { url: { type: "string" } } });
    if (values.url === undefined) throw new Error();
    const url = new URL(values.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error();

    await withNativePage(1440, 900, async (page) => {
      await page.goto(url.href, { timeout: 5_000 });
      await page.waitForFunction(
        () => {
          const node = document.querySelector(".context-rail .observation");
          const text = node?.textContent ?? "";
          return text.startsWith("Observed ") || node?.classList.contains("observation-error");
        },
        undefined,
        { timeout: 12_000 }
      );
      const history = await page.evaluate(() => {
        const node = document.querySelector(".context-rail .observation");
        const observed =
          (node?.textContent ?? "").startsWith("Observed ") &&
          !node?.classList.contains("observation-error");
        return {
          observed,
          unavailable: node?.classList.contains("observation-error") ?? false,
          empty: observed && document.querySelectorAll(".conversation-row").length === 0,
        };
      });
      result.historySettled = true;
      result.historyObserved = history.observed;
      result.historyUnavailable = history.unavailable;
      result.historyEmpty = history.empty;
      if (!history.observed) throw new Error();

      const contextPosition = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".context-group .context-item")).findIndex((node) => {
          const heading = node.closest(".context-group")?.querySelector("h2")?.textContent;
          return heading === "Topics" || heading === "Addresses";
        })
      );
      if (contextPosition >= 0) {
        await page
          .locator(".context-group .context-item")
          .nth(contextPosition)
          .click({ timeout: 3_000 });
        await page.waitForFunction(
          () =>
            document.querySelector("#thread-heading")?.textContent === "Context flow" &&
            document.querySelectorAll("article[data-message-id]").length > 0,
          undefined,
          { timeout: 3_000 }
        );
        result.contextSelected = true;
        const context = await page.evaluate(() => {
          const messages = Array.from(document.querySelectorAll("article[data-message-id]"));
          const active = document.querySelector(
            ".context-group .context-item.active bdi"
          )?.textContent;
          return {
            flow: document.querySelector("#thread-heading")?.textContent === "Context flow",
            visible: messages.filter((node) => node.getClientRects().length > 0).length,
            literal:
              active !== undefined &&
              messages.some((node) =>
                Array.from(
                  node.querySelectorAll(".sender bdi, .thread-to .audience-value bdi")
                ).some((value) => value.textContent === active)
              ),
          };
        });
        result.contextFlow = context.flow;
        result.visibleMessages = context.visible;
        result.literalContextMembership = context.literal;
        if (!context.flow || context.visible === 0 || !context.literal) throw new Error();
      } else if (!history.empty) {
        await page.locator(".conversation-row").first().click({ timeout: 3_000 });
        await page.waitForFunction(
          () => document.querySelectorAll("article[data-message-id]").length > 0,
          undefined,
          { timeout: 3_000 }
        );
        result.visibleMessages = await page.evaluate(
          () =>
            Array.from(document.querySelectorAll("article[data-message-id]")).filter(
              (node) => node.getClientRects().length > 0
            ).length
        );
      }

      if (!history.empty) {
        await page
          .locator('article[data-message-id] [aria-label="Source"]')
          .first()
          .click({ timeout: 3_000 });
        const reading = await page.evaluate(() => {
          const message = document.querySelector("article[data-message-id]");
          const source = message?.querySelector(".message-source");
          const style = source ? getComputedStyle(source) : undefined;
          return {
            source: Boolean(
              source && source.getClientRects().length && source.textContent !== null
            ),
            unclamped:
              style !== undefined &&
              style.textOverflow !== "ellipsis" &&
              (style.webkitLineClamp === "none" || style.webkitLineClamp === ""),
            audiences:
              Boolean(message?.querySelector(".thread-to .audience")) &&
              Array.from(message?.querySelectorAll(".thread-to .audience-value") ?? []).every(
                (node) => node.querySelector("bdi[dir='auto']") !== null
              ),
          };
        });
        result.fullSourceVisible = reading.source;
        result.sourceUnclamped = reading.unclamped;
        result.literalAudiences = reading.audiences;
        result.messageReadingProved =
          result.visibleMessages > 0 && reading.source && reading.unclamped && reading.audiences;
        if (!result.messageReadingProved) throw new Error();
      }

      const before = await page.evaluate(() => document.documentElement.dataset.theme);
      await page.locator('[aria-label="Dark theme"]').click({ timeout: 3_000 });
      result.themeChanged = await page.evaluate((previous) => {
        const current = document.documentElement.dataset.theme;
        return (current === "light" || current === "dark") && current !== previous;
      }, before);
      if (!result.themeChanged) throw new Error();
      await page.locator(".peer-link").click({ timeout: 3_000 });
      await page.waitForFunction(
        () => {
          const node = document.querySelector(".thread-view .observation");
          return (
            (node?.textContent ?? "").startsWith("Observed ") ||
            node?.classList.contains("observation-error")
          );
        },
        undefined,
        { timeout: 12_000 }
      );
      const peers = await page.evaluate(() => {
        const node = document.querySelector(".thread-view .observation");
        return {
          observed:
            (node?.textContent ?? "").startsWith("Observed ") &&
            !node?.classList.contains("observation-error"),
          unavailable: node?.classList.contains("observation-error") ?? false,
          rows: document.querySelectorAll(".peer-row").length,
        };
      });
      result.peersObserved = peers.observed;
      result.peersUnavailable = peers.unavailable;
      result.peerRows = peers.rows;
      if (!peers.observed && !peers.unavailable) throw new Error();
    });
    result.passed = true;
  } catch {
    process.exitCode = 1;
  } finally {
    result.elapsedMillis = Math.round(performance.now() - start);
    console.log(JSON.stringify(result));
  }
}

try {
  await isolatedTool(import.meta.url, main);
} catch {
  process.exitCode = 1;
  console.log(JSON.stringify(result));
}
