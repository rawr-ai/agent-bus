// Guards the pages that restate the code against drift: docs/architecture/interfaces.md,
// the timing table in docs/architecture/delivery.md, and the agent-bus skill. It compares
// names, shapes, numbers and quoted text with what the code registers and says, so a tool,
// a parameter, a bound, a quoted refusal or a timing constant that changes without its page
// fails here. Of the refusals only the ownership checks of src/Bus.ts are checked the other
// way (each needs a row in interfaces.md); a new message elsewhere in the code is not noticed.
// The test cannot judge whether a description is right, only that what it names exists and
// agrees.
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
  items?: Schema;
  enum?: ReadonlyArray<unknown>;
  minimum?: number;
  maximum?: number;
};
const parametersOf = (tool: Tool) => (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
const resultFieldsOf = (tool: Tool) => Object.keys(tool.outputSchema?.properties ?? {});
const parameterNames = new Set(tools.flatMap((tool) => Object.keys(parametersOf(tool))));

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
const SOURCE_LINES = SOURCES.flatMap((source) => source.split("\n"));

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

const KINDS = ["string", "number", "integer", "boolean", "array", "object"];
const numbersIn = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).sort();

/**
 * What a type cell gets wrong against the schema, comparing whole tokens: the kind words (an
 * array's item kind too, as in "string array"), or an enum's backticked values; and the
 * numbers, which must be exactly the schema's bounds.
 */
const typeProblems = (schema: Schema, cell: string) => {
  const prose = cell.replaceAll(/`[^`]*`/g, " ");
  const words: Array<string> = prose.match(/[A-Za-z]+/g) ?? [];
  // The schema's integer bound for "any safe integer" isn't a bound the page states.
  const bounds = [schema.minimum, schema.maximum]
    .filter((b): b is number => b !== undefined && Math.abs(b) < Number.MAX_SAFE_INTEGER)
    .map(String)
    .sort();
  const [stated, expected]: [Array<string>, Array<string>] =
    schema.enum === undefined
      ? [
          KINDS.filter((kind) => words.includes(kind)),
          schema.type === "array" ? [schema.items?.type ?? "", "array"] : [schema.type ?? ""],
        ]
      : [ticked(cell), schema.enum.map(String)];
  return [
    ...(stated.sort().join() === expected.sort().join()
      ? []
      : [`the type cell says ${stated.join(", ")}; the schema ${expected.join(", ")}`]),
    ...(numbersIn(prose).join() === bounds.join()
      ? []
      : [
          `the type cell's numbers are ${numbersIn(prose).join(", ")}; the schema's ${bounds.join(", ")}`,
        ]),
  ];
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
          ...typeProblems(schema, type).map((problem) => `${tool.name}.${name}: ${problem}`),
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

/** Every Markdown file of the skill, found by walking its folder. */
const skillFiles = (dir: string): Array<string> =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? skillFiles(`${dir}/${entry.name}`)
      : entry.name.endsWith(".md")
        ? [`${dir}/${entry.name}`]
        : []
  );
const SKILL_FILES = skillFiles("plugin/skills/agent-bus");

describe("tool names in the pages are real", () => {
  test.each(["docs/architecture/interfaces.md", ...SKILL_FILES])("%s", (path) => {
    // The host's own prefix for the server's tools: mcp__agent-bus__bus_read is bus_read.
    const text = read(path).replaceAll("mcp__agent-bus__", "");
    const written = [...text.matchAll(/(?<![A-Za-z0-9_])bus_[A-Za-z0-9_]+/g)].map(
      ([name = ""]) => name
    );
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((name) => toolNamed(name) === undefined)).toEqual([]);
  });
});

/**
 * Backticked tokens of the skill that are one plain word and aren't a parameter of any tool.
 * The skill keeps backticks for parameters, full tool names, `hooked: true`, commands, SPARQL
 * and placeholders, so a lone word in backticks is checked as a parameter name unless listed.
 */
const NOT_PARAMETERS = [
  // `agent-bus` CLI subcommands.
  "publish",
  "peers",
  // SPARQL keywords and functions.
  "SELECT",
  "LIMIT",
  "OFFSET",
  "FROM",
  "SERVICE",
  "DESCRIBE",
  "CONSTRUCT",
  "ASK",
  "CONTAINS",
];

describe("parameter names in the skill are real", () => {
  test.each(SKILL_FILES)("%s", (path) => {
    const words = ticked(read(path)).filter((span) => /^[A-Za-z][A-Za-z0-9]*$/.test(span));
    expect(
      words.filter((word) => !parameterNames.has(word) && !NOT_PARAMETERS.includes(word))
    ).toEqual([]);
  });
});

// --- Refusals ---------------------------------------------------------------------------

/**
 * The text a refusals row quotes: from its first double quote to its last, so quotes inside
 * it survive. Each `<placeholder>` or ellipsis splits it into fragments, which must occur
 * in the code in that order on one line, where the same place is a `${…}` interpolation or
 * a shortened tail. A row can't be satisfied by splicing two messages.
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
const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a line of code has the fragments in order. */
const wordedBy = (fragments: ReadonlyArray<string>, line: string) =>
  new RegExp(fragments.map(escaped).join(".*?")).test(line);

/** Rows that describe a refusal without quoting one: the wording isn't ours to check. */
const UNQUOTED = [
  // Effect's own schema message, which differs by MCP revision.
  "A schema message",
  // The skill describes this one in words: a store error has no fixed wording.
  "A store error, or no answer",
];

/** The first-column cells of the tables under a Refusals or Errors heading of a page. */
const refusalRows = (path: string) =>
  sectionsTitled(read(path), ["Refusals", "Errors"])
    .flatMap(({ lines }) => tablesOf(lines))
    .flatMap((table) => table.rows.map((row) => row[0] ?? ""));

describe("refusals quote the code", () => {
  const pages: Array<string> = ["docs/architecture/interfaces.md", ...SKILL_FILES];

  test("interfaces.md, SKILL.md and queries.md have refusal tables", () => {
    const withRows = pages.filter((path) => refusalRows(path).length > 0);
    expect(withRows).toEqual(
      expect.arrayContaining([
        "docs/architecture/interfaces.md",
        "plugin/skills/agent-bus/SKILL.md",
        "plugin/skills/agent-bus/references/queries.md",
      ])
    );
    expect(refusalRows(pages[0] ?? "").length).toBeGreaterThan(10);
  });

  test.each(pages)("%s", (path) => {
    const missing = refusalRows(path).flatMap((cell) => {
      const fragments = fragmentsOf(cell);
      if (fragments === undefined) {
        return UNQUOTED.some((start) => cell.startsWith(start))
          ? []
          : [`${cell}: quotes no wording`];
      }
      return SOURCE_LINES.some((line) => wordedBy(fragments, line))
        ? []
        : [`${fragments.join(" … ")}: not worded so in one place in the code`];
    });
    expect(missing).toEqual([]);
  });

  // The ownership checks are src/Bus.ts's `message: "…"` literals and `sessionHelp`.
  test("every ownership refusal in src/Bus.ts has a row in interfaces.md", () => {
    const lines = read("src/Bus.ts").split("\n");
    const help = lines[lines.findIndex((line) => line.startsWith("const sessionHelp =")) + 1] ?? "";
    const literals = [help, ...lines.filter((line) => /^\s*message: ["`]/.test(line))].map((line) =>
      line.replaceAll('\\"', '"')
    );
    expect(literals.length).toBeGreaterThan(3);
    const rows = refusalRows("docs/architecture/interfaces.md").flatMap((cell) => {
      const fragments = fragmentsOf(cell);
      return fragments === undefined ? [] : [fragments];
    });
    expect(literals.filter((line) => !rows.some((fragments) => wordedBy(fragments, line)))).toEqual(
      []
    );
  });
});

// --- delivery.md: timeouts and schedules -----------------------------------------------

const SCALE: Record<string, number> = { ms: 0.001, s: 1, min: 60, KiB: 1024, MiB: 1024 * 1024 };
const TIME_UNITS = ["ms", "s", "min"];

/**
 * A value cell as parts in seconds or bytes, each with its unit. A unit applies to the bare
 * numbers before it: "5, 15, 60 min".
 */
const quantities = (cell: string) => {
  let unit: string | undefined;
  return cell
    .split(",")
    .reverse()
    .map((part) => {
      const [, amount = "", own] = /^([\d.]+)\s*([A-Za-z]+)?$/.exec(part.trim()) ?? [];
      unit = own ?? unit;
      return {
        unit,
        value: Number(amount) * (unit === undefined ? 1 : (SCALE[unit] ?? Number.NaN)),
      };
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

/** Whether a constant is a time: a Duration, or a count of seconds by its name. */
const isTime = (name: string) => {
  const value = Timing[name as keyof typeof Timing] as unknown;
  return name.endsWith("_SECONDS") || [value].flat().some((item) => Duration.isDuration(item));
};

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

  test("each row states the value in code, with a time unit exactly for a time", () => {
    const wrong = rows.flatMap(({ names, value }) => {
      const stated = quantities(value);
      // One constant may be a list ("5, 15, 60 min"); several constants take one value each.
      const actual = names.flatMap((name) => exported(Timing[name as keyof typeof Timing]));
      const unitless = stated.flatMap(({ unit }, at) => {
        const name = names.length === 1 ? names[0] : names[at];
        const timed = unit !== undefined && TIME_UNITS.includes(unit);
        return name !== undefined && timed !== isTime(name) ? [name] : [];
      });
      const same =
        stated.length === actual.length &&
        stated.every(({ value }, at) => Math.abs(value - (actual[at] ?? Number.NaN)) < 1e-9);
      return [
        ...(same ? [] : [`${names.join(", ")}: the table says ${value}, the code ${actual}`]),
        ...unitless.map((name) => `${name}: ${value} has the wrong kind of unit`),
      ];
    });
    expect(wrong).toEqual([]);
  });

  test("each row's files use every constant of the row, and aren't src/timing.ts", () => {
    const unused = rows.flatMap(({ names, files }) =>
      files.flatMap((file) => [
        ...(file === "src/timing.ts" ? [`${names.join(", ")}: src/timing.ts defines it`] : []),
        ...names
          .filter((name) => !new RegExp(`\\b${name}\\b`).test(read(file)))
          .map((name) => `${name} is not in ${file}`),
      ])
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
