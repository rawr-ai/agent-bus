import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const sourceFields = ["description", "developer_instructions", "name"];

/** The closing frontmatter delimiter and its newline are the only body separator. */
export async function syncStewards(root: string, check = false): Promise<void> {
  const sourceDir = join(root, ".codex", "agents");
  const outputDir = join(root, ".claude", "agents");
  let sourceFiles: string[];
  try {
    sourceFiles = (await readdir(sourceDir)).filter((file) => file.endsWith(".toml")).sort();
  } catch {
    throw new Error("Cannot read .codex/agents source directory");
  }
  if (sourceFiles.length === 0) throw new Error("No TOML sources in .codex/agents");

  const outputs = new Map<string, string>();
  for (const file of sourceFiles) {
    let source: Record<string, unknown>;
    try {
      source = Bun.TOML.parse(await Bun.file(join(sourceDir, file)).text()) as Record<
        string,
        unknown
      >;
    } catch {
      throw new Error(`Cannot parse .codex/agents/${file} as TOML`);
    }
    if (JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(sourceFields)) {
      throw new Error(`Invalid fields in .codex/agents/${file}`);
    }
    const { name, description, developer_instructions: body } = source;
    if (
      typeof name !== "string" ||
      name.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      typeof description !== "string" ||
      description.trim().length === 0 ||
      typeof body !== "string" ||
      body.trim().length === 0
    ) {
      throw new Error(`Invalid required value in .codex/agents/${file}`);
    }
    const output = `${name}.md`;
    if (outputs.has(output)) throw new Error(`Duplicate steward name in .codex/agents/${file}`);
    outputs.set(
      output,
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nmodel: inherit\n---\n${body}`
    );
  }

  let existing: string[];
  try {
    existing = await readdir(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = [];
  }
  for (const file of existing) {
    if (!outputs.has(file)) throw new Error(`Unexpected output .claude/agents/${file}`);
  }
  if (check) {
    for (const [file, content] of outputs) {
      const output = Bun.file(join(outputDir, file));
      if (!(await output.exists())) throw new Error(`Missing output .claude/agents/${file}`);
      if ((await output.text()) !== content) throw new Error(`Stale output .claude/agents/${file}`);
    }
    return;
  }
  await mkdir(outputDir, { recursive: true });
  for (const [file, content] of outputs) await Bun.write(join(outputDir, file), content);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { check: { type: "boolean" } },
    });
    await syncStewards(dirname(import.meta.dir), values.check ?? false);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Steward sync failed");
    process.exitCode = 1;
  }
}
