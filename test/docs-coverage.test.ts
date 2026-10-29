// Guards the pages that restate the code against drift: docs/architecture/interfaces.md,
// the timing table in docs/architecture/delivery.md, and the agent-bus skill. It compares
// names, shapes, numbers and quoted text with what the code registers and says, so a tool,
// a parameter, a refusal or a constant that changes without its page fails here. It cannot
// judge whether a description is right, only that what it names exists and agrees.
//
// Conventions the pages keep for it:
// - a tool's section in interfaces.md is a `#### \`bus_x\`` heading with a "Parameter" table;
// - a refusal is the text between a row's first and last double quote, where a `<placeholder>`
//   or an ellipsis stands for any text the code interpolates;
// - delivery.md's table names each constant of src/timing.ts in backticks.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import * as Bus from "../src/Bus.ts";
import * as Cursors from "../src/Cursors.ts";
import * as Serve from "../src/serve.ts";
import * as Timing from "../src/timing.ts";
import { layerJsonl } from "./jsonl-ledger.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// --- The code ---------------------------------------------------------------------------

/** The tools as the official SDK lists them from an in-process server. */
const listTools = async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-docs-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.url.port);
  probe.stop(true);
  const server = ManagedRuntime.make(
    Serve.layerHttp({ port, version: "test" }).pipe(
      Layer.provide(
        Bus.layer.pipe(
          Layer.provideMerge(layerJsonl(join(dir, "ledger.jsonl"))),
          Layer.provideMerge(Cursors.layerFiles(join(dir, "cursors"))),
          Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
        )
      )
    )
  );
  try {
    await server.runPromise(Effect.void);
    const client = new Client({ name: "docs-coverage", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    );
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
    }
  } finally {
    await server.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
};

const tools = await listTools();
const toolNamed = (name: string) => tools.find((tool) => tool.name === name);
type Schema = {
  type?: string;
  enum?: ReadonlyArray<unknown>;
  minimum?: number;
  maximum?: number;
};
const parametersOf = (tool: Tool) => (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
const resultFieldsOf = (tool: Tool) => Object.keys(tool.outputSchema?.properties ?? {});

/**
 * Where refusals are worded, with each `${NAME}` that names a string or number constant of
 * those files replaced by its value, so a page can state "10 seconds" or "32768". Any other
 * interpolation stays as written, for a `<placeholder>` or ellipsis in the page to stand for.
 */
const SOURCES = (() => {
  const files = ["Bus", "mcp", "sparql", "Fluree", "client", "bin"].map((file) =>
    read(`src/${file}.ts`).replaceAll('\\"', '"')
  );
  const constants = new Map(
    files.flatMap((text) =>
      [...text.matchAll(/^(?:export )?const ([A-Z_]+) = ("[^"]*"|[\d_]+);$/gm)].map(
        ([, name = "", value = ""]) => [name, value.replaceAll(/["_]/g, "")] as const
      )
    )
  );
  return files.map((text) =>
    text.replaceAll(/\$\{([A-Z_]+)\}/g, (whole, name: string) => constants.get(name) ?? whole)
  );
})();

// --- Markdown ---------------------------------------------------------------------------

interface Section {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
}
interface Table {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

/** Each heading's section: the lines below it up to the next heading at its level or above. */
const sectionsOf = (text: string): ReadonlyArray<Section> => {
  const lines = text.split("\n");
  const headings: Array<{ index: number; level: number; title: string }> = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6}) (.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      headings.push({ index, level: heading[1].length, title: heading[2] });
    }
  });
  return headings.map(({ index, level, title }, at) => {
    const next = headings.slice(at + 1).find((heading) => heading.level <= level);
    return { title, lines: lines.slice(index + 1, next?.index ?? lines.length) };
  });
};

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

const tablesOf = (lines: ReadonlyArray<string>): ReadonlyArray<Table> => {
  const found: Array<Array<ReadonlyArray<string>>> = [];
  let open = false;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      open = false;
      continue;
    }
    if (!open) found.push([]);
    open = true;
    found.at(-1)?.push(cells(line));
  }
  return found.map(([header = [], , ...rows]) => ({ header, rows }));
};

/** A table's rows as records of the named columns; a missing column fails the test that asked. */
const records = <K extends string>(table: Table, names: ReadonlyArray<K>) => {
  const indexes = names.map((name) => {
    const index = table.header.indexOf(name);
    if (index < 0)
      throw new Error(`no "${name}" column in a table headed ${table.header.join(" | ")}`);
    return index;
  });
  return table.rows.map(
    (row) =>
      Object.fromEntries(names.map((name, at) => [name, row[indexes[at] ?? -1] ?? ""])) as Record<
        K,
        string
      >
  );
};

/** The backticked spans of some Markdown. */
const ticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map(([, span = ""]) => span);

const sectionsTitled = (text: string, titles: ReadonlyArray<string>) =>
  sectionsOf(text).filter(({ title }) => titles.includes(title));

// --- interfaces.md: the tools -----------------------------------------------------------

const interfaces = read("docs/architecture/interfaces.md");
const toolSection = (name: string) =>
  sectionsOf(interfaces).find(({ title }) => title === `\`${name}\``);
/** bus_takeover "takes every parameter of bus_join … and one more", so its page is both. */
const INHERITS: Record<string, string> = { bus_takeover: "bus_join" };

interface ParameterRow {
  readonly name: string;
  readonly type: string;
  readonly required: string;
}

const parameterRows = (name: string): ReadonlyArray<ParameterRow> => [
  ...tablesOf(toolSection(name)?.lines ?? [])
    .filter((table) => table.header[0] === "Parameter")
    .flatMap((table) => records(table, ["Parameter", "Type", "Required"]))
    .map((row) => ({
      name: ticked(row.Parameter)[0] ?? "",
      type: row.Type,
      required: row.Required,
    })),
  ...(INHERITS[name] === undefined ? [] : parameterRows(INHERITS[name] ?? "")),
];

/** Whether a type cell says what the schema says: its kind or enum values, and its bounds. */
const typeProblems = (schema: Schema, cell: string) => {
  const kinds = schema.enum === undefined ? [schema.type ?? ""] : schema.enum.map(String);
  // The schema's integer bound for "any safe integer" isn't a bound the page states.
  const bounds = [schema.minimum, schema.maximum].filter(
    (bound): bound is number => bound !== undefined && Math.abs(bound) < Number.MAX_SAFE_INTEGER
  );
  return [...kinds, ...bounds.map(String)].filter((word) => !cell.includes(word));
};

/** The first table under a heading of interfaces.md. */
const tableUnder = (title: string) => {
  const [table] = tablesOf(sectionsTitled(interfaces, [title])[0]?.lines ?? []);
  if (table === undefined) throw new Error(`no table under "${title}"`);
  return table;
};
const ANNOTATIONS = "Tool × annotation × approval";

describe("interfaces.md covers the toolkit", () => {
  test("the tool table, the tool sections and the annotation table list the same tools", () => {
    const names = tools.map((tool) => tool.name).sort();
    const listed = (table: Table) => table.rows.map((row) => ticked(row[0] ?? "")[0]).sort();
    expect(listed(tableUnder("MCP tools"))).toEqual(names);
    expect(listed(tableUnder(ANNOTATIONS))).toEqual(names);
    const headed = sectionsOf(interfaces).flatMap(({ title }) => ticked(title));
    expect(headed.filter((title) => title.startsWith("bus_")).sort()).toEqual(names);
  });

  test("the annotation table says what the tools set", () => {
    const hints = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;
    const table = tableUnder(ANNOTATIONS);
    for (const row of records(table, ["Tool", ...hints.map((hint) => `\`${hint}\``)])) {
      const name = ticked(row.Tool ?? "")[0] ?? "";
      const stated = hints.map((hint) => (row[`\`${hint}\``] ?? "").replaceAll("*", ""));
      const set = hints.map((hint) => String(toolNamed(name)?.annotations?.[hint]));
      expect([name, stated]).toEqual([name, set]);
    }
  });

  test("every parameter of every tool is in its table, and the table names nothing else", () => {
    const problems = tools.flatMap((tool) => {
      const rows = parameterRows(tool.name);
      const documented = rows.map((row) => row.name);
      return [
        ...Object.keys(parametersOf(tool))
          .filter((name) => !documented.includes(name))
          .map((name) => `${tool.name}.${name} is missing from its table`),
        ...documented
          .filter((name) => parametersOf(tool)[name] === undefined)
          .map((name) => `${tool.name}'s table names ${name}, which the tool lacks`),
      ];
    });
    expect(problems).toEqual([]);
  });

  test("each row's type, bounds and requirement agree with the schema", () => {
    const problems = tools.flatMap((tool) =>
      parameterRows(tool.name).flatMap(({ name, type, required }) => {
        const schema = parametersOf(tool)[name];
        if (schema === undefined) return [];
        const mustHave = tool.inputSchema.required?.includes(name) === true;
        // `session` is optional in every schema so a call without it gets the bus's refusal.
        const said = required.startsWith("yes");
        const agrees = said === mustHave || (said && required.includes("optional in the schema"));
        return [
          ...typeProblems(schema, type).map(
            (word) => `${tool.name}.${name}: the type cell lacks "${word}"`
          ),
          ...(agrees ? [] : [`${tool.name}.${name}: "${required}" contradicts the schema`]),
        ];
      })
    );
    expect(problems).toEqual([]);
  });

  test("every field of every result is named in its tool's section", () => {
    const problems = tools.flatMap((tool) => {
      const named = [tool.name, INHERITS[tool.name]].flatMap((name) =>
        ticked(toolSection(name ?? "")?.lines.join("\n") ?? "")
      );
      return resultFieldsOf(tool)
        .filter((field) => !named.includes(field))
        .map((field) => `${tool.name} returns ${field}, which its section doesn't name`);
    });
    expect(problems).toEqual([]);
  });
});

describe("tool names in the pages are real", () => {
  const skill = (dir: string): ReadonlyArray<string> =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? skill(`${dir}/${entry.name}`)
        : entry.name.endsWith(".md")
          ? [`${dir}/${entry.name}`]
          : []
    );
  const SKILL_FILES = skill("plugin/skills/agent-bus");

  test.each(["docs/architecture/interfaces.md", ...SKILL_FILES])("%s", (path) => {
    const written = [...read(path).matchAll(/`(bus_[a-z]+)`/g)].map(([, name = ""]) => name);
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((name) => toolNamed(name) === undefined)).toEqual([]);
  });
});

// --- Refusals ---------------------------------------------------------------------------

/**
 * The text a refusals row quotes: from its first double quote to its last, so quotes inside
 * it survive. Each `<placeholder>` or ellipsis splits it into fragments, which must occur
 * in the code, where the same place is a `${…}` interpolation or a shortened tail.
 */
const fragmentsOf = (cell: string) => {
  const first = cell.indexOf('"');
  const last = cell.lastIndexOf('"');
  if (first < 0 || last <= first) return undefined;
  return cell
    .slice(first + 1, last)
    .split(/`?<[^>]+>`?|…/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== "");
};

/** Rows that describe a refusal without quoting one: the wording isn't ours to check. */
const UNQUOTED = [
  // Effect's own schema message, which differs by MCP revision.
  "A schema message",
  // The skill describes this one in words: a store error has no fixed wording.
  "A store error, or no answer",
];

describe("refusals quote the code", () => {
  const pages = [
    "docs/architecture/interfaces.md",
    "plugin/skills/agent-bus/SKILL.md",
    "plugin/skills/agent-bus/references/queries.md",
  ];

  test.each(pages)("%s", (path) => {
    const rows = sectionsTitled(read(path), ["Refusals", "Errors"])
      .flatMap(({ lines }) => tablesOf(lines))
      .flatMap((table) => table.rows.map((row) => row[0] ?? ""));
    expect(rows.length).toBeGreaterThan(3);
    const missing = rows.flatMap((cell) => {
      const fragments = fragmentsOf(cell);
      if (fragments === undefined) {
        return UNQUOTED.some((start) => cell.startsWith(start))
          ? []
          : [`${cell}: quotes no wording`];
      }
      return fragments
        .filter((fragment) => !SOURCES.some((source) => source.includes(fragment)))
        .map((fragment) => `${fragment}: not in the code`);
    });
    expect(missing).toEqual([]);
  });
});

// --- delivery.md: timeouts and schedules -----------------------------------------------

const UNITS: Record<string, number> = { ms: 0.001, s: 1, min: 60, KiB: 1024, MiB: 1024 * 1024 };

/** A value cell as numbers in seconds or bytes. A unit applies to the bare numbers before it: "5, 15, 60 min". */
const quantities = (cell: string) => {
  let scale = 1;
  return cell
    .split(",")
    .reverse()
    .map((part) => {
      const [, amount = "", unit] = /^([\d.]+)\s*([A-Za-z]+)?$/.exec(part.trim()) ?? [];
      scale = unit === undefined ? scale : (UNITS[unit] ?? Number.NaN);
      return Number(amount) * scale;
    })
    .reverse();
};

/** An export of timing.ts in the same units: a Duration in seconds, a count as it is. */
const exported = (value: unknown): ReadonlyArray<number> =>
  Array.isArray(value)
    ? value.flatMap(exported)
    : Duration.isDuration(value)
      ? [Duration.toMillis(value) / 1000]
      : [Number(value)];

describe("delivery.md's timeouts and schedules", () => {
  const [table] = tablesOf(
    sectionsTitled(read("docs/architecture/delivery.md"), ["Timeouts and schedules"])[0]?.lines ??
      []
  );
  if (table === undefined) throw new Error("no timing table");
  const rows = records(table, ["Constant", "Value", "Used in"]).map((row) => ({
    names: ticked(row.Constant),
    value: row.Value,
    files: ticked(row["Used in"]),
  }));
  const code = Object.entries(Timing);

  test("every export of src/timing.ts has a row, and every row names an export", () => {
    const named = rows.flatMap(({ names }) => names);
    expect(code.map(([name]) => name).filter((name) => !named.includes(name))).toEqual([]);
    expect(named.filter((name) => !code.some(([exportName]) => exportName === name))).toEqual([]);
    // A value written in place has no name to check: name it in src/timing.ts.
    expect(rows.filter(({ names }) => names.length === 0).map(({ value }) => value)).toEqual([]);
  });

  test("each row states the value in code", () => {
    const wrong = rows.flatMap(({ names, value }) => {
      const stated = quantities(value);
      // One constant may be a list ("5, 15, 60 min"); several constants take one value each.
      const actual = names.flatMap((name) => exported(Timing[name as keyof typeof Timing]));
      const same =
        stated.length === actual.length &&
        stated.every((amount, at) => Math.abs(amount - (actual[at] ?? Number.NaN)) < 1e-9);
      return same ? [] : [`${names.join(", ")}: the table says ${value}, the code ${actual}`];
    });
    expect(wrong).toEqual([]);
  });

  test("each row's files use the constant", () => {
    const unused = rows.flatMap(({ names, files }) =>
      files
        .filter((file) => !names.some((name) => read(file).includes(name)))
        .map((file) => `${names.join(", ")} is not in ${file}`)
    );
    expect(unused).toEqual([]);
  });
});

// --- Paths ------------------------------------------------------------------------------

describe("paths the pages name exist", () => {
  test.each(["docs/architecture/interfaces.md", "docs/architecture/delivery.md"])("%s", (path) => {
    const named = ticked(read(path)).filter((span) =>
      /^(src|scripts|plugin|test)\/[\w./-]+$/.test(span)
    );
    expect(named.filter((file) => !existsSync(join(root, file)))).toEqual([]);
  });
});

// Codex injects an explicitly mentioned skill's whole file cut to 8,000 bytes, and lists a
// description cut to 1,024 characters (docs/platforms/codex.md, "What a Codex plugin can
// carry"). The margin keeps a later edit from crossing either limit unnoticed.
describe("the skill fits what hosts show", () => {
  const skill = read("plugin/skills/agent-bus/SKILL.md");

  test("SKILL.md is at most 7,000 bytes", () => {
    expect(Buffer.byteLength(skill, "utf8")).toBeLessThanOrEqual(7_000);
  });

  test("its description is at most 1,024 characters", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    const description =
      /^description:\s*\|?\n?([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(frontmatter)?.[1] ?? "";
    expect(description.trim().length).toBeGreaterThan(0);
    expect(description.trim().length).toBeLessThanOrEqual(1_024);
  });
});
