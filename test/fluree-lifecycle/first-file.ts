// Run only by test/fluree-server.test.ts, in a `bun test` child of its own: one of two files
// sharing the Fluree server. Not named .test.ts, so the suite does not run it directly.
import { expect, test } from "bun:test";
import { usesServer } from "./uses-server.ts";

test("the first file uses the shared server", async () => {
  expect(await usesServer("first")).toBe(true);
});
