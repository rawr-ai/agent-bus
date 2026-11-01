import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { localBrowser, type Page, Stagehand } from "@browserbasehq/stagehand";

// Adapted from OPA website's tests/browser/guest-page.ts, native Stagehand 4.
// Omitting userDataDir creates an SDK-owned unique profile, removed on close.
export async function withNativePage(
  width: number,
  height: number,
  run: (page: Page) => Promise<void>
): Promise<void> {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await localBrowser.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  let stagehand: Stagehand | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await stagehand?.close();
      } finally {
        await browser.close();
      }
    })());
  const stop = () => {
    void close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    stagehand = await Stagehand.create({ browser, logging: { level: "off" } });
    await browser.context.setDomainPolicy({ allowedDomains: ["127.0.0.1"] });
    const page = await browser.context.activePage();
    assert.ok(page, "native browser has a page");
    await page.setViewportSize(width, height);
    assert.deepEqual(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      { width, height },
      "actual browser viewport"
    );
    await run(page);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await close();
  }
}

export async function auditExternalLoads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const audit = { externalAttempts: 0, imageElements: 0 };
    Reflect.set(window, "__VIEWER_SYNTHETIC_LOAD_AUDIT__", audit);
    const external = (url: string) => {
      try {
        if (new URL(url, location.href).origin !== location.origin) audit.externalAttempts++;
      } catch {
        /* Invalid synthetic URLs cannot load. */
      }
    };
    const originalFetch = window.fetch.bind(window);
    const auditedFetch = (target: RequestInfo | URL, init?: RequestInit) => {
      external(target instanceof Request ? target.url : String(target));
      return originalFetch(target, init);
    };
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: auditedFetch,
    });
    const seen = new WeakSet<HTMLImageElement>();
    const inspect = (node: Node) => {
      if (!(node instanceof Element)) return;
      const images =
        node instanceof HTMLImageElement ? [node] : Array.from(node.querySelectorAll("img"));
      for (const image of images) {
        if (!seen.has(image)) {
          seen.add(image);
          audit.imageElements++;
        }
        if (image.getAttribute("src")) external(image.getAttribute("src") ?? "");
      }
    };
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        inspect(mutation.target);
        for (const node of mutation.addedNodes) inspect(node);
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      if (/^https?:/.test(event.blockedURI)) external(event.blockedURI);
    });
  });
}

export async function assertNoExternalLoads(page: Page): Promise<void> {
  assert.deepEqual(
    await page.evaluate(() => Reflect.get(window, "__VIEWER_SYNTHETIC_LOAD_AUDIT__")),
    { externalAttempts: 0, imageElements: 0 },
    "no fetch/image insertion or CSP-blocked external load attempts"
  );
}

export async function waitFor(page: Page, selector: string): Promise<void> {
  assert.equal(await page.waitForSelector(selector, { timeout: 5_000 }), true, selector);
}

export async function clickText(page: Page, selector: string, text: string): Promise<void> {
  const position = await page.evaluate(
    ({ selector, text }) =>
      Array.from(document.querySelectorAll(selector)).findIndex(
        (element) => element.textContent?.trim() === text
      ),
    { selector, text }
  );
  assert.ok(position >= 0, "requested synthetic control exists");
  await page.locator(selector).nth(position).click({ timeout: 5_000 });
}
