import { describe, expect, test } from "bun:test";
import {
  checkAll,
  checkFrameLinks,
  checkLinks,
  checkOverview,
  checkScopeLine,
  checkShape,
  memoryCorpus,
  slugify,
} from "../scripts/check-docs.ts";

const messages = (failures: ReadonlyArray<{ file: string; line: number; message: string }>) =>
  failures.map((f) => `${f.file}:${f.line}: ${f.message}`);

const links = (sources: Record<string, string>, extra?: ReadonlyArray<string>) =>
  messages(checkLinks(memoryCorpus(sources, extra)));

describe("links and anchors", () => {
  test("a clean set of links passes, including a heading's own slug", () => {
    const failures = links({
      "a.md":
        "# A\n\nSee [b](b.md#the-b-heading), [self](#a), [dir](docs), [web](https://x.y/z).\n",
      "b.md": "# B\n\n## The B heading\n",
      docs: "",
    });
    expect(failures).toEqual([]);
  });

  test("a bad anchor and a missing file fail with their lines", () => {
    const failures = links({
      "a.md": "# A\n\n[x](b.md#nope)\n\n[y](missing.md)\n\n[z](#nothing)\n",
      "b.md": "# B\n",
    });
    expect(failures).toEqual([
      "a.md:3: broken anchor: b.md has no heading #nope",
      "a.md:5: broken link: missing.md does not exist",
      "a.md:7: broken anchor: a.md has no heading #nothing",
    ]);
  });

  test("fences and inline code are ignored for links and headings", () => {
    const failures = links({
      "a.md":
        "# A\n\n`[x](nope.md)`\n\n```\n[y](nope.md)\n# Fake heading\n```\n\n~~~\n[z](nope.md)\n~~~\n\n[w](#fake-heading)\n",
    });
    expect(failures).toEqual(["a.md:14: broken anchor: a.md has no heading #fake-heading"]);
  });

  test("duplicate headings get -1, -2 and punctuation is dropped", () => {
    expect(slugify(["Foo", "Foo", "Foo"])).toEqual(["foo", "foo-1", "foo-2"]);
    expect(slugify(["Will a session be woken?", "The `threads/wake` link", "Across: SSH"])).toEqual(
      ["will-a-session-be-woken", "the-threadswake-link", "across-ssh"]
    );
    expect(
      links({ "a.md": "# A\n\n## Dup\n\n## Dup\n\n[a](#dup) [b](#dup-1) [c](#dup-2)\n" })
    ).toEqual(["a.md:7: broken anchor: a.md has no heading #dup-2"]);
  });

  test("%20 escapes in targets are decoded", () => {
    expect(links({ "a.md": "# A\n\n[x](my%20file.md)\n", "my file.md": "# M\n" })).toEqual([]);
  });

  test("fragments on non-Markdown targets are not checked", () => {
    expect(links({ "a.md": "# A\n\n[x](src/a.ts#L10)\n" }, ["src/a.ts"])).toEqual([]);
  });

  test("an inline link split across lines is followed", () => {
    expect(links({ "a.md": "# A\n\nSee [broken](\nmissing.md\n) here.\n" })).toEqual([
      "a.md:3: broken link: missing.md does not exist",
    ]);
  });

  test("a reference link resolves through a definition on later lines", () => {
    const sources = (target: string) => ({
      "a.md": `# A\n\nSee [broken][x] and [again][X] and [collapsed][] and [short].\n\nOther text.\n\n[x]: ${target}\n[collapsed]: ${target}\n[short]: ${target}\n`,
      "ok.md": "# Ok\n",
    });
    expect(links(sources("ok.md"))).toEqual([]);
    expect(links(sources("missing.md"))).toEqual([
      "a.md:3: broken link: missing.md does not exist",
      "a.md:3: broken link: missing.md does not exist",
      "a.md:3: broken link: missing.md does not exist",
      "a.md:3: broken link: missing.md does not exist",
    ]);
  });

  test("a definition with its destination on the next line is read", () => {
    expect(links({ "a.md": '# A\n\n[x][r]\n\n[r]:\n  missing.md "Title"\n' })).toEqual([
      "a.md:3: broken link: missing.md does not exist",
    ]);
  });

  test("an unused definition is still checked, and a bare [word] without one is prose", () => {
    expect(links({ "a.md": "# A\n\nA [note] here.\n\n[spare]: missing.md\n" })).toEqual([
      "a.md:5: broken link: missing.md does not exist",
    ]);
  });

  test("a reference with no definition fails", () => {
    expect(links({ "a.md": "# A\n\nSee [text][nowhere] and [other][].\n" })).toEqual([
      "a.md:3: reference [nowhere] has no definition",
      "a.md:3: reference [other] has no definition",
    ]);
  });

  test("an anchor matching a heading only inside an HTML comment fails", () => {
    const failures = links({
      "a.md":
        "# A\n\n<!--\n## Hidden\n[c](nope.md)\n-->\n\n<!-- ## Same line --> text\n\n[x](#hidden) [y](#same-line)\n",
    });
    expect(failures).toEqual([
      "a.md:10: broken anchor: a.md has no heading #hidden",
      "a.md:10: broken anchor: a.md has no heading #same-line",
    ]);
  });

  test("HTML href and src attributes are checked", () => {
    expect(links({ "a.md": '# A\n\n<a href="gone.md">x</a> <img src="gone.png">\n' })).toEqual([
      "a.md:3: broken link: gone.md does not exist",
      "a.md:3: broken link: gone.png does not exist",
    ]);
  });

  test("setext headings fail explicitly instead of passing silently", () => {
    expect(links({ "a.md": "# A\n\nTitle\n-----\n" })).toEqual([
      "a.md:4: setext heading underline: use a # heading (unsupported here)",
    ]);
  });
});

const scope = (sources: Record<string, string>) => messages(checkScopeLine(memoryCorpus(sources)));

describe("scope line", () => {
  test("a plain paragraph after the H1 passes", () => {
    expect(scope({ "docs/overview.md": "# O\n\nWhat this covers.\n\n## Next\n" })).toEqual([]);
  });

  test.each([
    ["a list", "- item"],
    ["a numbered list", "1. item"],
    ["a table", "| a | b |\n| - | - |"],
    ["a blockquote", "> quote"],
    ["a code fence", "```\ncode\n```"],
    ["HTML", "<div>x</div>"],
    ["a heading", "## Next"],
  ])("%s straight after the H1 fails", (_name, block) => {
    const failures = scope({ "docs/architecture/x.md": `# X\n\n${block}\n` });
    expect(failures).toEqual([
      "docs/architecture/x.md:3: scope line: the first block after the H1 must be a plain paragraph",
    ]);
  });

  test("README.md is covered, and an H1 followed straight by an H2 fails", () => {
    expect(scope({ "README.md": "# agent-bus\n## Install\n\nText.\n" })).toEqual([
      "README.md:2: scope line: the first block after the H1 must be a plain paragraph",
    ]);
    expect(scope({ "README.md": "# agent-bus\n\nWhat it is.\n" })).toEqual([]);
  });

  test("skill files are covered and their front matter is skipped", () => {
    const good = "---\nname: agent-bus\ndescription: x\n---\n\n# Skill\n\nWhat it is.\n";
    expect(scope({ "plugin/skills/agent-bus/SKILL.md": good })).toEqual([]);
    const bad = "---\nname: agent-bus\n---\n\n# Skill\n\n## Section\n";
    expect(scope({ "plugin/skills/agent-bus/references/queries.md": bad })).toEqual([
      "plugin/skills/agent-bus/references/queries.md:7: scope line: the first block after the H1 must be a plain paragraph",
    ]);
  });

  test("pages outside the current set are not covered", () => {
    expect(scope({ "docs/frames/x.md": "# F\n\n- list\n" })).toEqual([]);
  });

  test("a missing H1 fails", () => {
    expect(scope({ "docs/overview.md": "Text only.\n" })).toEqual([
      "docs/overview.md:1: scope line: the page has no H1 heading",
    ]);
  });
});

const ARCHITECTURE = (extra = "") =>
  `# P\n\nScope.\n\n## What it does\n\n## Rules\n\n## Why\n\n## Limits\n\n## Rests on\n\n## History\n${extra}`;
const RUNBOOK = "# R\n\nScope.\n\n## Before you start\n\n## Steps\n\n## If it fails\n";

describe("page shape", () => {
  test("conforming pages pass", () => {
    const corpus = memoryCorpus({
      "docs/architecture/a.md": ARCHITECTURE(),
      "docs/runbooks/r.md": RUNBOOK,
    });
    expect(checkShape(corpus, [])).toEqual([]);
  });

  test("a missing History heading fails", () => {
    const corpus = memoryCorpus({
      "docs/architecture/messaging.md": ARCHITECTURE().replace("## History", "## Histor"),
    });
    expect(messages(checkShape(corpus, []))).toEqual([
      "docs/architecture/messaging.md:5: page shape: H2 sections are [What it does, Rules, Why, Limits, Rests on, Histor], expected [What it does, Rules, Why, Limits, Rests on, History]",
    ]);
  });

  test("a runbook must start with Before you start and end with If it fails", () => {
    const corpus = memoryCorpus({ "docs/runbooks/r.md": "# R\n\nScope.\n\n## Steps\n" });
    expect(messages(checkShape(corpus, []))).toEqual([
      'docs/runbooks/r.md:5: page shape: the first H2 must be "Before you start"',
      'docs/runbooks/r.md:5: page shape: the last H2 must be "If it fails"',
    ]);
  });

  test("an allowlisted page is exempt, and a stale entry fails", () => {
    const corpus = memoryCorpus({
      "docs/architecture/old.md": "# Old\n\nScope.\n\n## Whatever\n",
      "docs/architecture/new.md": ARCHITECTURE(),
    });
    expect(checkShape(corpus, ["docs/architecture/old.md"])).toEqual([]);
    expect(messages(checkShape(corpus, ["docs/architecture/new.md", "docs/gone.md"]))).toEqual([
      "docs/architecture/old.md:5: page shape: H2 sections are [Whatever], expected [What it does, Rules, Why, Limits, Rests on, History]",
      "docs/architecture/new.md:1: stale shape allowlist entry: the page conforms or is gone; remove it",
      "docs/gone.md:1: stale shape allowlist entry: the page conforms or is gone; remove it",
    ]);
  });
});

describe("overview topic table", () => {
  const overview = (rows: string) =>
    `# O\n\nScope.\n\n## Which page owns each topic\n\n${rows}\n## Other\n\n[late](architecture/c.md)\n`;
  const pages = {
    "docs/architecture/a.md": "# A\n",
    "docs/platforms/p.md": "# P\n",
    "docs/runbooks/r.md": "# R\n",
  };

  test("a section naming every page passes, including through a reference link", () => {
    const rows = "[A](architecture/a.md) [P][p]\n[R](runbooks/r.md)\n\n[p]: platforms/p.md\n";
    expect(checkOverview(memoryCorpus({ "docs/overview.md": overview(rows), ...pages }))).toEqual(
      []
    );
  });

  test("a missing page fails, and a link after the section does not count", () => {
    const corpus = memoryCorpus({
      "docs/overview.md": overview("[A](architecture/a.md) [R](runbooks/r.md)\n"),
      ...pages,
      "docs/architecture/c.md": "# C\n",
    });
    expect(messages(checkOverview(corpus))).toEqual([
      'docs/overview.md:5: "Which page owns each topic" does not link docs/architecture/c.md',
      'docs/overview.md:5: "Which page owns each topic" does not link docs/platforms/p.md',
    ]);
  });

  test("a missing section heading fails", () => {
    const corpus = memoryCorpus({ "docs/overview.md": "# O\n\nScope.\n" });
    expect(messages(checkOverview(corpus))).toEqual([
      'docs/overview.md:1: missing H2 "Which page owns each topic"',
    ]);
  });
});

describe("history links", () => {
  const page = (body: string, history = "") =>
    `# P\n\nScope.\n\n${body}\n## History\n\n${history}\n`;

  test("links inside History, to the frames index, and from README to research pass", () => {
    const corpus = memoryCorpus({
      "docs/architecture/a.md": page("[index](../frames/README.md)", "[f](../frames/x.md)"),
      "README.md": "# R\n\nScope. [r](docs/research/y.md)\n",
      "docs/platforms/p.md": "# P\n\nEvidence: [f](../frames/x.md)\n",
    });
    expect(checkFrameLinks(corpus, [])).toEqual([]);
  });

  test("a frame link outside History fails, from a reference too", () => {
    const corpus = memoryCorpus({
      "docs/architecture/a.md": page(
        "See [f](../frames/x.md) and [g][g].\n\n[g]: ../research/z.md"
      ),
      "plugin/skills/s/SKILL.md": "# S\n\nUse [f](../../../docs/frames/x.md).\n",
    });
    expect(messages(checkFrameLinks(corpus, []))).toEqual([
      "docs/architecture/a.md:5: link to docs/frames/x.md outside the History section",
      "docs/architecture/a.md:5: link to docs/research/z.md outside the History section",
      "plugin/skills/s/SKILL.md:3: link to docs/frames/x.md outside the History section",
    ]);
  });

  test("allowlisted violations pass, and entries that no longer match fail", () => {
    const corpus = memoryCorpus({ "docs/architecture/a.md": page("[f](../frames/x.md)") });
    const entry = "docs/architecture/a.md -> docs/frames/x.md";
    expect(checkFrameLinks(corpus, [entry])).toEqual([]);
    expect(
      messages(checkFrameLinks(corpus, [entry, "docs/overview.md -> docs/frames/y.md"]))
    ).toEqual([
      "docs/overview.md:1: stale allowlist entry: remove it from FRAME_LINK_ALLOWLIST (docs/overview.md -> docs/frames/y.md)",
    ]);
  });
});

describe("the repository's own allowlists", () => {
  test("every check runs over a conforming fixture without failures", () => {
    const corpus = memoryCorpus({
      "docs/overview.md":
        "# O\n\nScope.\n\n## Which page owns each topic\n\n[A](architecture/a.md)\n",
      "docs/architecture/a.md": ARCHITECTURE(),
    });
    // The shipped allowlists name real pages, so only those entries are stale here.
    expect(checkAll(corpus).every((f) => f.message.includes("stale"))).toBe(true);
  });
});
