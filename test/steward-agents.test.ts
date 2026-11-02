import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncStewards } from "../scripts/sync-stewards.ts";

const repo = dirname(import.meta.dir);
const temporary: string[] = [];
const expected = '---\nname: "test-role"\ndescription: "A: role #1"\nmodel: inherit\n---\nBody\n';
const source =
  'name = "test-role"\ndescription = "A: role #1"\ndeveloper_instructions = "Body\\n"\n';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stewards-"));
  temporary.push(root);
  await mkdir(join(root, ".codex/agents"), { recursive: true });
  return root;
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await Bun.write(join(root, path), content);
}

async function inventory(root: string, path = ""): Promise<string[]> {
  const entries = await readdir(join(root, path), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(path, entry.name);
    if (entry.isDirectory()) {
      result.push(`directory ${name}`, ...(await inventory(root, name)));
    } else {
      result.push(`file ${name} ${(await readFile(join(root, name))).toString("hex")}`);
    }
  }
  return result;
}

function decode(markdown: string): { header: unknown; body: string } {
  expect(markdown.startsWith("---\n")).toBe(true);
  const end = markdown.indexOf("\n---\n", 4);
  expect(end).toBeGreaterThanOrEqual(0);
  return { header: Bun.YAML.parse(markdown.slice(4, end)), body: markdown.slice(end + 5) };
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("native steward translation", () => {
  test("multiline literal bodies trim only the TOML opening newline", async () => {
    const root = await fixture();
    await put(
      root,
      ".codex/agents/one.toml",
      "name = \"test-role\"\ndescription = \"A: role #1\"\ndeveloper_instructions = '''\n\n  Body\n\n'''\n"
    );
    await syncStewards(root);
    const output = await Bun.file(join(root, ".claude/agents/test-role.md")).text();
    expect(output).toBe(expected.replace("Body\n", "\n  Body\n\n"));
    expect(decode(output).body).toBe("\n  Body\n\n");
  });

  test("renders literal bytes and preserves hostile metadata and complete bodies", async () => {
    const root = await fixture();
    await put(root, ".codex/agents/one.toml", source);
    await syncStewards(root);
    const output = await Bun.file(join(root, ".claude/agents/test-role.md")).text();
    expect(output).toBe(expected);
    expect(decode(output)).toEqual({
      header: { name: "test-role", description: "A: role #1", model: "inherit" },
      body: "Body\n",
    });

    const descriptions = [
      'Quotes " and \\ path: # value',
      "null",
      "Unicode é 中文\n---\nmodel: unsafe",
    ];
    for (const [index, description] of descriptions.entries()) {
      const body = `  Start\n\n---\n\`\`\`\nUnicode Ω\n\`\`\`\nEnd${index === 0 ? "" : "\n"}`;
      await put(
        root,
        ".codex/agents/one.toml",
        `name = "test-role"\ndescription = ${JSON.stringify(description)}\ndeveloper_instructions = ${JSON.stringify(body)}\n`
      );
      await syncStewards(root);
      expect(decode(await Bun.file(join(root, ".claude/agents/test-role.md")).text())).toEqual({
        header: { name: "test-role", description, model: "inherit" },
        body,
      });
    }
  });

  test("rejects invalid sources before touching any output", async () => {
    const root = await fixture();
    await put(root, ".codex/agents/one.toml", source);
    await put(root, ".codex/agents/two.toml", source.replaceAll("test-role", "other-role"));
    await syncStewards(root);
    await put(root, ".claude/agents/test-role.md", "stale sentinel");
    const invalid = [
      "invalid = [",
      ...[
        'name = "test-role"',
        'description = "A: role #1"',
        'developer_instructions = "Body\\n"',
      ].flatMap((line) => [
        source.replace(`${line}\n`, ""),
        source.replace(line, `${line.split(" = ")[0]} = " "`),
        source.replace(line, `${line.split(" = ")[0]} = 3`),
      ]),
      `${source}model = "unsafe"\n`,
      ...["../escape", "/absolute", "a/b", "a\\b", "a\nb", "UPPER", "a".repeat(65)].map((name) =>
        source.replace('"test-role"', JSON.stringify(name))
      ),
    ];
    for (const value of invalid) {
      await put(root, ".codex/agents/two.toml", value);
      const before = await inventory(root);
      await expect(syncStewards(root)).rejects.toThrow();
      expect(await inventory(root)).toEqual(before);
    }
    await put(root, ".codex/agents/two.toml", source);
    const before = await inventory(root);
    await expect(syncStewards(root)).rejects.toThrow("Duplicate steward name");
    expect(await inventory(root)).toEqual(before);
  });

  test("rejects missing or empty sources", async () => {
    const root = await fixture();
    await expect(syncStewards(root)).rejects.toThrow("No TOML sources");
    await rm(join(root, ".codex/agents"), { recursive: true });
    await expect(syncStewards(root, true)).rejects.toThrow("Cannot read .codex/agents");
  });

  test("check is read-only for missing, stale, extra and injected outputs; generation is idempotent", async () => {
    const root = await fixture();
    await put(root, ".codex/agents/one.toml", source);
    await put(root, ".codex/agents/two.toml", source.replaceAll("test-role", "other-role"));
    await syncStewards(root);
    const dir = join(root, ".claude/agents");
    const first = Bun.file(join(dir, "test-role.md"));
    const second = Bun.file(join(dir, "other-role.md"));
    const secondExpected = expected.replaceAll("test-role", "other-role");
    expect(await Bun.file(join(dir, "test-role.md")).text()).toBe(expected);
    expect(await second.text()).toBe(secondExpected);
    await syncStewards(root);
    expect(await first.text()).toBe(expected);
    await syncStewards(root, true);

    for (const changed of [
      expected.replace("A: role #1", "stale"),
      expected.replace("Body", "stale"),
      expected.replace("model: inherit", "model: unsafe"),
      expected.replace("model: inherit", "model: inherit\ntools: all"),
    ]) {
      await Bun.write(first, changed);
      await expect(syncStewards(root, true)).rejects.toThrow(
        "Stale output .claude/agents/test-role.md"
      );
      expect(await first.text()).toBe(changed);
    }
    await rm(join(dir, "test-role.md"));
    await expect(syncStewards(root, true)).rejects.toThrow(
      "Missing output .claude/agents/test-role.md"
    );
    expect(await first.exists()).toBe(false);
    await Bun.write(first, expected);
    await put(root, ".claude/agents/extra.md", "unrelated");
    await expect(syncStewards(root, true)).rejects.toThrow(
      "Unexpected output .claude/agents/extra.md"
    );
    await Bun.write(first, "stale sentinel");
    await rm(join(dir, "other-role.md"));
    const before = await inventory(root);
    await expect(syncStewards(root)).rejects.toThrow("Unexpected output .claude/agents/extra.md");
    expect(await inventory(root)).toEqual(before);
  });

  test("CLI resolves the repository rather than the caller's directory", async () => {
    const root = await fixture();
    const child = Bun.spawn([process.execPath, join(repo, "scripts/sync-stewards.ts"), "--check"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(await Bun.file(join(root, ".claude/agents/test-role.md")).exists()).toBe(false);
    expect(await readdir(root)).toEqual([".codex"]);
  });

  test("approved repository identities have exact counterparts and decoded parity", async () => {
    const approved = [
      "agent-bus-effect-steward",
      "agent-bus-fluree-query-steward",
      "agent-bus-mcp-steward",
      "agent-bus-orpc-steward",
      "agent-bus-simplicity-steward",
      "agent-bus-sparql-steward",
      "agent-bus-state-machine-steward",
      "agent-bus-steward-designer",
      "agent-bus-testing-design-steward",
    ];
    const sources = await readdir(join(repo, ".codex/agents"));
    const roles = await Promise.all(
      sources
        .filter((file) => file.endsWith(".toml"))
        .map(
          async (file) =>
            Bun.TOML.parse(await Bun.file(join(repo, ".codex/agents", file)).text()) as {
              name: string;
              description: string;
              developer_instructions: string;
            }
        )
    );
    expect(roles.map((role) => role.name).sort()).toEqual(approved);
    expect((await readdir(join(repo, ".claude/agents"))).sort()).toEqual(
      approved.map((name) => `${name}.md`)
    );
    for (const role of roles) {
      const output = await Bun.file(join(repo, ".claude/agents", `${role.name}.md`)).text();
      expect(decode(output)).toEqual({
        header: { name: role.name, description: role.description, model: "inherit" },
        body: role.developer_instructions,
      });
    }
  });
});
