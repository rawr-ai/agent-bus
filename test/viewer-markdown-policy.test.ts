import { describe, expect, test } from "bun:test";
import { MAX_RENDERED_MARKDOWN_LENGTH, safeWebUrl } from "../viewer/src/markdown-policy.ts";

describe("message Markdown URL policy", () => {
  test.each([
    "https://example.test/notes",
    "http://example.test:8080/path?q=one#section",
    "HTTPS://example.test/encoded%20space",
    "https://example.test/a%2Fb",
  ])("keeps an explicit ordinary web destination: %s", (value) => {
    expect(safeWebUrl(value)).toBe(value);
  });

  test.each([
    "",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>fixture</script>",
    "file:///fixture/private",
    "codex://threads/fixture",
    "mailto:fixture@example.test",
    "irc://example.test/room",
    "xmpp:fixture@example.test",
    "//example.test/image",
    "/rpc/history",
    "../fixture",
    "?query=fixture",
    "#context=topic",
    "https:example.test",
    "https://",
    "https://user@example.test/",
    "https://user:password@example.test/",
    "https://user%40example.test@other.test/",
    "https://example.test\\@other.test/",
    "https://example.test/a b",
    " https://example.test/",
    "https://example.test/\nnext",
    "https://example.test/\u0000next",
    "https://example.test/\u0085next",
    "https://example.test/\u061cnext",
    "https://example.test/\u200bnext",
    "https://example.test/\u202enext",
    "https://example.test/\u2066next",
    "https://example.test/\ufeffnext",
  ])("does not turn an ambiguous or non-web value into a link: %s", (value) => {
    expect(safeWebUrl(value)).toBeUndefined();
  });

  test("bounds Markdown work without changing the full-source contract", () => {
    expect(MAX_RENDERED_MARKDOWN_LENGTH).toBe(100_000);
  });
});
