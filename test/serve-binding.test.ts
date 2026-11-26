import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { persistServeBinding, readServeBinding, type ServeBinding } from "../src/serve-binding.ts";

const original: ServeBinding = {
  version: 1,
  installation: "00000000-0000-4000-8000-000000000001",
  url: "http://127.0.0.1:8095",
  ledger: "fixture:main",
  incarnation: "babcde",
  era: 2,
  anchor: { head: 4, commit: "bfghij" },
};

test("publishing a serving binding is exclusive; a byte-identical repeat does not replace it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bus-binding-"));
  const path = join(root, ".serve-binding-v1");
  try {
    await Effect.runPromise(persistServeBinding(root, original));
    const first = await lstat(path);
    expect(first.mode & 0o777).toBe(0o600);
    const bytes = await readFile(path, "utf8");
    expect(bytes).toBe(JSON.stringify(original));
    await Effect.runPromise(persistServeBinding(root, original));
    const changed = { ...original, anchor: { head: 5, commit: "bklmno" } };
    await expect(Effect.runPromise(persistServeBinding(root, changed))).rejects.toThrow();
    expect((await lstat(path)).ino).toBe(first.ino);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(
      await Effect.runPromise(readServeBinding(root, original.installation, original))
    ).toEqual(original);
    for (const spoof of [
      { ...original, installation: "00000000-0000-4000-8000-000000000002" },
      { ...original, url: "http://127.0.0.1:8094" },
      { ...original, ledger: "some-other-ledger:main" },
    ]) {
      await expect(
        Effect.runPromise(readServeBinding(root, spoof.installation, spoof))
      ).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absent, malformed, permissive-mode and symlink evidence are not interchangeable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bus-binding-damage-"));
  const path = join(root, ".serve-binding-v1");
  try {
    const read = () => Effect.runPromise(readServeBinding(root, original.installation, original));
    expect(await read()).toBeUndefined();
    await writeFile(path, '{"version":1', { mode: 0o600 });
    await expect(read()).rejects.toThrow();
    await rm(path);
    await writeFile(path, JSON.stringify(original), { mode: 0o644 });
    await expect(read()).rejects.toThrow();
    await rm(path);
    const other = join(root, "other");
    await writeFile(other, JSON.stringify(original), { mode: 0o600 });
    await symlink(other, path);
    await expect(read()).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
