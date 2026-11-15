// Qualification oracle: enumerate authored files independently of the production imports.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { ModernHttp } from "./private-modern-http.ts";

const rootUri = "skill://agent-bus";
const skillUri = `${rootUri}/SKILL.md`;
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

export const authoredSkill = (repo: string): Readonly<Record<string, string>> => {
  const root = join(repo, "plugin/skills/agent-bus");
  const walk = (directory: string, prefix = ""): Array<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return walk(join(directory, entry.name), `${path}/`);
      assert(entry.isFile(), `Unexpected skill entry: ${path}`);
      return [path];
    });
  const paths = walk(root).sort();
  assert.deepEqual(paths, [
    "SKILL.md",
    "references/activity.md",
    "references/addressing.md",
    "references/orientation.md",
    "references/queries.md",
    "references/refusals.md",
    "references/runtimes.md",
  ]);
  return Object.fromEntries(
    paths.map((path) => {
      const bytes = readFileSync(join(root, path));
      const value = bytes.toString("utf8");
      assert.deepEqual(Buffer.from(value, "utf8"), bytes, `${path} is not UTF-8`);
      return [path, value];
    })
  );
};

const checkSkillWire = async (
  client: ModernHttp,
  expected: Readonly<Record<string, string>>,
  intervalMs: number,
  mark: (phase: string) => void
) => {
  const request = async (method: string, params: Readonly<Record<string, unknown>> = {}) => {
    mark(typeof params.uri === "string" ? `${method} ${params.uri}` : method);
    if (intervalMs > 0) await Bun.sleep(intervalMs);
    return client.request({ method, params }, { parse: record });
  };
  const discovery = await request("server/discover");
  const capabilities = record(discovery.capabilities);
  assert.equal(record(capabilities.resources).listChanged, false);
  assert.deepEqual(record(capabilities.extensions)["io.modelcontextprotocol/skills"], {
    directoryRead: true,
  });
  const list = await request("skills/list");
  assert(Array.isArray(list.skills));
  assert.equal(list.nextCursor, undefined);
  assert.equal(list.skills.length, 1);
  const skill = record(list.skills[0]);
  assert.equal(skill.uri, skillUri);
  const frontmatter = record(skill.frontmatter);
  const root = expected["SKILL.md"];
  assert(root);
  const yaml = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(root)?.[1];
  assert(yaml);
  const parsed = record(Bun.YAML.parse(yaml));
  assert(typeof parsed.description === "string");
  assert.equal(frontmatter.name, "agent-bus");
  assert.deepEqual(frontmatter, parsed);
  assert.deepEqual(record((await request("skills/get", { uri: skillUri })).skill), skill);
  const manifest = Object.entries(expected).map(([path, value]) => ({
    uri: `${rootUri}/${path}`,
    size: Buffer.byteLength(value, "utf8"),
    digest: `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
  }));
  assert.deepEqual(skill.resources, manifest);
  const resources = await request("resources/list");
  assert(Array.isArray(resources.resources));
  assert.equal(resources.nextCursor, undefined);
  assert.deepEqual(
    resources.resources.map((item) => record(item).uri).sort(),
    manifest.map(({ uri }) => uri).sort()
  );
  const directory = async (uri: string) => {
    const result = await request("resources/directory/read", { uri });
    assert(Array.isArray(result.resources));
    assert.equal(result.nextCursor, undefined);
    return result.resources.map((item) => record(item));
  };
  const top = await directory(rootUri);
  assert.deepEqual(top.map((item) => item.uri).sort(), [skillUri, `${rootUri}/references`].sort());
  assert.equal(
    top.find((item) => item.uri === `${rootUri}/references`)?.mimeType,
    "inode/directory"
  );
  const references = await directory(`${rootUri}/references`);
  assert.deepEqual(
    references.map((item) => item.uri).sort(),
    manifest
      .map(({ uri }) => uri)
      .filter((uri) => uri !== skillUri)
      .sort()
  );
  for (const [path, value] of Object.entries(expected)) {
    const uri = `${rootUri}/${path}`;
    const read = await request("resources/read", { uri });
    assert(Array.isArray(read.contents));
    assert.equal(read.contents.length, 1);
    const content = record(read.contents[0]);
    assert.equal(content.uri, uri);
    assert.equal(content.mimeType, "text/markdown");
    assert(typeof content.text === "string");
    assert(
      Buffer.from(content.text, "utf8").equals(Buffer.from(value, "utf8")),
      `Wrong bytes: ${path}`
    );
  }
  const addressing = expected["references/addressing.md"];
  const runtimes = expected["references/runtimes.md"];
  assert(root && addressing && runtimes);
  assert(root.includes("references/runtimes.md#hosted-chatgpt"));
  assert(addressing.includes("../SKILL.md#dont"));
  const forward = new URL("references/runtimes.md#hosted-chatgpt", skillUri);
  assert.equal(forward.hash, "#hosted-chatgpt");
  forward.hash = "";
  assert.equal(forward.href, `${rootUri}/references/runtimes.md`);
  assert(runtimes.includes("## Hosted ChatGPT"));
  const back = new URL("../SKILL.md#dont", `${rootUri}/references/addressing.md`);
  assert.equal(back.hash, "#dont");
  back.hash = "";
  assert.equal(back.href, skillUri);
  assert(root.includes("## Don't"));
  for (const [method, uri] of [
    ["skills/get", "skill://missing/SKILL.md"],
    ["resources/read", `${rootUri}/references/missing.md`],
    ["resources/read", "other://agent-bus/SKILL.md"],
    ["resources/directory/read", `${rootUri}/missing`],
  ]) {
    assert(method && uri);
    await assert.rejects(
      request(method, { uri }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === -32602,
      `${method} ${uri} did not return the expected refusal`
    );
  }
  assert.deepEqual(record((await request("skills/get", { uri: skillUri })).skill), skill);
};

/** Compare a real modern MCP endpoint with an independent authored-file oracle. */
export const verifySkillWire = async (
  client: ModernHttp,
  expected: Readonly<Record<string, string>>,
  intervalMs = 0
) => {
  let phase = "setup";
  try {
    await checkSkillWire(client, expected, intervalMs, (current) => {
      phase = current;
    });
  } catch {
    throw new Error(`Skill wire verification failed at ${phase}.`);
  }
};
