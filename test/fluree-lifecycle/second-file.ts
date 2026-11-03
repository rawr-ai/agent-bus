// Run only by test/fluree-server.test.ts: the second of two files sharing the Fluree server.
// With FLUREE_FIXTURE_THROW set, it fails after using the server.
import { expect, test } from "bun:test";
import { usesServer } from "./uses-server.ts";

test("the second file still uses the same server", async () => {
  expect(await usesServer("second")).toBe(true);
  if (process.env.FLUREE_FIXTURE_THROW !== undefined) throw new Error("a test that throws");
});
