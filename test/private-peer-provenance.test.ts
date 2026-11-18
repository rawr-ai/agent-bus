import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveHash,
  digest,
  entryHash,
  verifyPrivateBundle,
} from "../scripts/private-modern-http.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bus-provenance-test-"));
  const peer = "synthetic peer\n";
  const host = "synthetic host\n";
  writeFileSync(join(root, "main.js"), peer);
  writeFileSync(join(root, "mcp-host.mjs"), host);
  const hostFields = {
    sourceCommit: "a1ca3083913b9d9cc0794c1acdf6c682678de1d1",
    sourceTree: "074ff06aeea433776af79040f368c9cf2b3377f4",
    archiveSha256: archiveHash,
    entrySha256: entryHash,
    bundleSha256: sha(host),
    effectVersion: "4.1.4",
    effectPackageSha256: "c25c5cec1df1befc27ae354843dc57534e22b76cb93488ddf8042ef520dda9d0",
  };
  const sourceManifest = {
    schema: "agent-bus-private-peer-source-v1",
    host: { ...hostFields, inputs: { sha256: "c".repeat(64), count: 1 } },
    peerSha256: sha(peer),
    peerInputs: { sha256: "d".repeat(64), count: 1 },
    source: { commit, tree, lockSha256: "e".repeat(64), builderSha256: "f".repeat(64) },
    bun: { version: "1.4.4", revision: "fixture", sha256: "0".repeat(64) },
  };
  const save = (manifest: object) =>
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  save(sourceManifest);
  return { root, hostFields, sourceManifest, save };
};

const owned: string[] = [];
const make = () => {
  const data = fixture();
  owned.push(data.root);
  return data;
};
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private bundle selection", () => {
  test("requires independent digest, commit and tree for source-attributed bundles", () => {
    const { root } = make();
    const anchor = digest(join(root, "manifest.json"));
    const expected = { manifestSha256: anchor, source: { commit, tree } };
    expect(verifyPrivateBundle(root, expected).schema).toBe("agent-bus-private-peer-source-v1");
    expect(() => verifyPrivateBundle(root)).toThrow();
    expect(() => verifyPrivateBundle(root, { manifestSha256: anchor })).toThrow();
    expect(() =>
      verifyPrivateBundle(root, { ...expected, manifestSha256: "0".repeat(64) })
    ).toThrow();
    expect(() =>
      verifyPrivateBundle(root, { ...expected, source: { commit: "0".repeat(40), tree } })
    ).toThrow();
    expect(() =>
      verifyPrivateBundle(root, { ...expected, source: { commit, tree: "0".repeat(40) } })
    ).toThrow();
  });

  test("refuses each changed file and a self-consistent reseal against the original anchor", () => {
    const source = make();
    const original = ["main.js", "mcp-host.mjs", "manifest.json"].map((name) =>
      digest(join(source.root, name))
    );
    const expected = { manifestSha256: original[2]!, source: { commit, tree } };
    for (const name of ["main.js", "mcp-host.mjs", "manifest.json"]) {
      const changed = make();
      for (const file of ["main.js", "mcp-host.mjs", "manifest.json"])
        copyFileSync(join(source.root, file), join(changed.root, file));
      writeFileSync(join(changed.root, name), "changed\n");
      expect(() => verifyPrivateBundle(changed.root, expected)).toThrow();
    }
    const resealed = make();
    writeFileSync(join(resealed.root, "main.js"), "replacement peer\n");
    resealed.save({ ...resealed.sourceManifest, peerSha256: sha("replacement peer\n") });
    expect(() => verifyPrivateBundle(resealed.root, expected)).toThrow();
    expect(
      verifyPrivateBundle(resealed.root, {
        ...expected,
        manifestSha256: digest(join(resealed.root, "manifest.json")),
      }).schema
    ).toBe("agent-bus-private-peer-source-v1");
    expect(
      ["main.js", "mcp-host.mjs", "manifest.json"].map((name) => digest(join(source.root, name)))
    ).toEqual(original);
  });

  test("an unanchored review stays usable but cannot satisfy a source selection", () => {
    const { root, hostFields, save, sourceManifest } = make();
    save({
      schema: "agent-bus-private-peer-review-v2",
      host: hostFields,
      peerSha256: sourceManifest.peerSha256,
      source: "working tree; exact source revision not attested",
    });
    expect(verifyPrivateBundle(root).schema).toBe("agent-bus-private-peer-review-v2");
    const expected = {
      manifestSha256: digest(join(root, "manifest.json")),
      source: { commit, tree },
    };
    expect(() => verifyPrivateBundle(root, expected)).toThrow();
  });

  test("rejects a different host archive even with a newly selected manifest digest", () => {
    const { root, sourceManifest, save } = make();
    save({
      ...sourceManifest,
      host: { ...sourceManifest.host, archiveSha256: "0".repeat(64) },
    });
    expect(() =>
      verifyPrivateBundle(root, {
        manifestSha256: digest(join(root, "manifest.json")),
        source: { commit, tree },
      })
    ).toThrow();
  });

  test("rejects symlinked or shared files instead of trusting a mutable external target", () => {
    const original = make();
    const target = make();
    const expected = {
      manifestSha256: digest(join(original.root, "manifest.json")),
      source: { commit, tree },
    };
    const linkedDirectory = join(target.root, "directory-link");
    symlinkSync(original.root, linkedDirectory);
    expect(() => verifyPrivateBundle(`${linkedDirectory}/`, expected)).toThrow();
    expect(() => verifyPrivateBundle(`${linkedDirectory}/.`, expected)).toThrow();
    rmSync(linkedDirectory);
    for (const name of ["main.js", "mcp-host.mjs", "manifest.json"])
      copyFileSync(join(original.root, name), join(target.root, name));
    rmSync(join(target.root, "main.js"));
    symlinkSync(join(original.root, "main.js"), join(target.root, "main.js"));
    expect(() => verifyPrivateBundle(target.root, expected)).toThrow();
    rmSync(join(target.root, "main.js"));
    linkSync(join(original.root, "main.js"), join(target.root, "main.js"));
    expect(() => verifyPrivateBundle(target.root, expected)).toThrow();
    expect(readFileSync(join(original.root, "main.js"), "utf8")).toBe("synthetic peer\n");
  });
});
