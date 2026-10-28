#!/usr/bin/env bun
/**
 * Checks that the Markdown stays navigable and keeps its shape (decision 8 of
 * docs/frames/docs-consolidation.md). Run by `bun run check`.
 *
 * 1. Links and anchors: every relative link and image in every Markdown file
 *    resolves, and a `#fragment` on a Markdown target names a heading there.
 *    Inline, reference-style ([text][ref], [text][], [ref]) and HTML href/src
 *    links are all followed, including ones that span lines.
 * 2. Scope line: each current page, README.md and each skill file opens with a
 *    plain paragraph after its H1.
 * 3. Page shape: architecture pages and runbooks have their fixed H2 sections.
 * 4. The overview links every architecture, platform and runbook page.
 * 5. History links: current pages cite frames and research only from their
 *    History footer. Today's violations are allowlisted; the allowlist can
 *    only shrink.
 *
 * Syntax the parser does not model fails explicitly instead of passing: setext
 * headings and references with no definition. Links inside indented code
 * blocks are still checked as links (the check errs toward failing).
 *
 * `--print-allowlist` prints the current frame-link violations as an array to
 * paste into FRAME_LINK_ALLOWLIST.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

// Pages still awaiting reshaping. Phase 2 of the docs-consolidation frame empties it.
export const SHAPE_ALLOWLIST: ReadonlyArray<string> = [
  "docs/architecture/topology.md",
  "docs/architecture/delivery.md",
  "docs/architecture/connections.md",
  "docs/architecture/codex-hosting.md",
];

// Today's links from current pages into frames or research, as "<file> -> <target>".
// Phase 2 of the docs-consolidation frame empties it.
export const FRAME_LINK_ALLOWLIST: ReadonlyArray<string> = [
  "docs/architecture/codex-hosting.md -> docs/frames/codex-wake.md",
  "docs/architecture/codex-hosting.md -> docs/frames/desktop-wake-spike.md",
  "docs/architecture/codex-hosting.md -> docs/frames/load-on-mail.md",
  "docs/architecture/delivery.md -> docs/frames/claude-wake.md",
  "docs/architecture/delivery.md -> docs/frames/load-on-mail.md",
  "docs/architecture/delivery.md -> docs/frames/nudge-hygiene.md",
  "docs/architecture/delivery.md -> docs/frames/one-codex-route.md",
  "docs/architecture/delivery.md -> docs/frames/queue-wake.md",
  "docs/overview.md -> docs/frames/address-ownership.md",
  "docs/overview.md -> docs/frames/claude-wake.md",
  "docs/overview.md -> docs/frames/finish-swap.md",
  "docs/overview.md -> docs/frames/load-on-mail.md",
  "docs/overview.md -> docs/frames/one-codex-route.md",
  "docs/overview.md -> docs/frames/queue-wake.md",
  "docs/overview.md -> docs/frames/simplification-pass.md",
];

const ARCHITECTURE_SECTIONS = ["What it does", "Rules", "Why", "Limits", "Rests on", "History"];
const OVERVIEW = "docs/overview.md";
const OVERVIEW_TOPICS = "Which page owns each topic";
const HISTORY = "History";
const EXCLUDED = [".repos/", "node_modules/", ".agents/"];

const root = resolve(import.meta.dir, "..");

export type Failure = { readonly file: string; readonly line: number; readonly message: string };
type LinkKind = "inline" | "reference" | "definition";
type Link = { readonly line: number; readonly target: string; readonly kind: LinkKind };
type Heading = { readonly line: number; readonly level: number; readonly text: string };
type Problem = { readonly line: number; readonly message: string };
export type Doc = {
  /** The lines with front matter, comments and code blocks blanked, so numbers still match. */
  readonly lines: ReadonlyArray<string>;
  /** Links as readers see them. Definitions appear only when no reference uses them. */
  readonly links: ReadonlyArray<Link>;
  readonly headings: ReadonlyArray<Heading>;
  readonly slugs: ReadonlySet<string>;
  /** Syntax the parser cannot honour, and references with no definition. */
  readonly problems: ReadonlyArray<Problem>;
};
type FrameLink = { readonly file: string; readonly line: number; readonly target: string };

/** The Markdown to check, and a way to read it: the repository, or fixtures in a test. */
export type Corpus = {
  readonly files: ReadonlyArray<string>;
  readonly exists: (path: string) => boolean;
  readonly doc: (path: string) => Doc | undefined;
};

// ---------------------------------------------------------------------------
// Parsing

const FENCE = /^\s*(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const CODE_SPAN = /(`+)([\s\S]+?)(?<!`)\1(?!`)/g;
const INLINE_LINK =
  /\]\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HTML_URL = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DEFINITION =
  /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:\s*(<[^>\n]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*(?:\n|$)/;

const blankOut = (text: string): string => text.replace(/[^\n]/g, " ");

/** Blank out inline code spans so they hold no links; newlines stay so offsets keep their lines. */
const maskCode = (text: string): string => text.replace(CODE_SPAN, blankOut);

const unangle = (target: string): string =>
  target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;

const normalizeLabel = (label: string): string => label.replace(/\s+/g, " ").trim().toLowerCase();

/** Blank HTML comments outside code spans; reports whether one is still open at the line's end. */
const stripComments = (line: string, startOpen: boolean): { text: string; open: boolean } => {
  let text = line;
  let open = startOpen;
  let pos = 0;
  for (;;) {
    const masked = maskCode(text);
    const from = open ? pos : masked.indexOf("<!--", pos);
    if (from === -1) return { text, open: false };
    const end = masked.indexOf("-->", open ? pos : from + 4);
    const stop = end === -1 ? text.length : end + 3;
    text = text.slice(0, from) + " ".repeat(stop - from) + text.slice(stop);
    if (end === -1) return { text, open: true };
    open = false;
    pos = stop;
  }
};

/** Blanks YAML front matter, HTML comments and fenced code; an opening fence becomes a bare marker. */
const cleanLines = (raw: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out: string[] = [];
  let start = 0;
  if (raw[0]?.trim() === "---") {
    const end = raw.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end !== -1) {
      for (let i = 0; i <= end; i++) out.push("");
      start = end + 1;
    }
  }
  let fence: { char: string; length: number } | undefined;
  let inComment = false;
  for (const line of raw.slice(start)) {
    if (fence !== undefined) {
      const closing = FENCE.exec(line)?.[1];
      if (
        closing?.[0] === fence.char &&
        closing.length >= fence.length &&
        line.trim() === closing
      ) {
        fence = undefined;
      }
      out.push("");
      continue;
    }
    const stripped = stripComments(line, inComment);
    inComment = stripped.open;
    const opening = FENCE.exec(stripped.text)?.[1];
    if (opening !== undefined) {
      fence = { char: opening[0] ?? "`", length: opening.length };
      out.push(fence.char.repeat(3));
    } else {
      out.push(stripped.text);
    }
  }
  return out;
};

type Block = {
  readonly text: string;
  readonly starts: ReadonlyArray<{ offset: number; line: number }>;
};

const isFenceMarker = (line: string): boolean => /^(`{3}|~{3})$/.test(line);

/** Paragraph-like blocks: runs of non-blank lines, with headings and code fences on their own. */
const blocksOf = (lines: ReadonlyArray<string>): ReadonlyArray<Block> => {
  const blocks: Block[] = [];
  let text = "";
  let starts: { offset: number; line: number }[] = [];
  const flush = () => {
    if (starts.length > 0) blocks.push({ text, starts });
    text = "";
    starts = [];
  };
  lines.forEach((line, index) => {
    if (line.trim() === "" || isFenceMarker(line)) return flush();
    if (ATX_HEADING.test(line)) flush();
    const content = line.replace(/^\s{0,3}(?:>\s?)+/, "");
    starts.push({ offset: text.length, line: index + 1 });
    text += `${content}\n`;
    if (ATX_HEADING.test(line)) flush();
  });
  flush();
  return blocks;
};

const lineAt = (block: Block, offset: number): number => {
  let line = 1;
  for (const start of block.starts) if (start.offset <= offset) line = start.line;
  return line;
};

type Definition = { readonly target: string; used: boolean; readonly line: number };

/** Removes the definitions a block opens with, recording them; returns the block text without them. */
const takeDefinitions = (block: Block, definitions: Map<string, Definition>): string => {
  let text = block.text;
  let consumed = 0;
  for (;;) {
    const match = DEFINITION.exec(text.slice(consumed));
    if (match === null) break;
    const label = normalizeLabel(match[1] ?? "");
    if (label !== "" && !(match[1] ?? "").startsWith("^") && !definitions.has(label)) {
      definitions.set(label, {
        target: unangle(match[2] ?? ""),
        used: false,
        line: lineAt(block, consumed),
      });
    }
    const length = match[0].length;
    text =
      text.slice(0, consumed) +
      blankOut(text.slice(consumed, consumed + length)) +
      text.slice(consumed + length);
    consumed += length;
  }
  return text;
};

/** Pairs of matching `[` `]` offsets, innermost first, honouring backslash escapes. */
const bracketPairs = (text: string): ReadonlyArray<readonly [number, number]> => {
  const open: number[] = [];
  const pairs: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "[") open.push(i);
    else if (ch === "]") {
      const start = open.pop();
      if (start !== undefined) pairs.push([start, i]);
    }
  }
  return pairs;
};

const scanBlock = (
  block: Block,
  text: string,
  definitions: Map<string, Definition>,
  links: Link[],
  problems: Problem[]
): void => {
  const masked = maskCode(text);
  for (const match of masked.matchAll(INLINE_LINK)) {
    if (masked[match.index - 1] === "\\") continue;
    const line = lineAt(block, match.index);
    links.push({ line, target: unangle(match[1] ?? ""), kind: "inline" });
  }
  for (const match of masked.matchAll(HTML_URL)) {
    const target = match[1] ?? match[2] ?? "";
    links.push({ line: lineAt(block, match.index), target, kind: "inline" });
  }
  const pairs = bracketPairs(masked);
  const closeOf = new Map(pairs);
  const consumed = new Set<number>();
  for (const [open, close] of pairs) {
    if (consumed.has(open) || masked[open + 1] === "^") continue;
    const next = masked[close + 1];
    if (next === "(") continue;
    const line = lineAt(block, open);
    const own = masked.slice(open + 1, close);
    let label = normalizeLabel(own);
    if (next === "[") {
      const refClose = closeOf.get(close + 1);
      if (refClose === undefined) continue;
      consumed.add(close + 1);
      const ref = normalizeLabel(masked.slice(close + 2, refClose));
      label = ref === "" ? label : ref;
      const found = definitions.get(label);
      if (label === "") continue;
      if (found === undefined) {
        problems.push({ line, message: `reference [${label}] has no definition` });
        continue;
      }
      found.used = true;
      links.push({ line, target: found.target, kind: "reference" });
    } else {
      const found = definitions.get(label);
      if (label === "" || found === undefined) continue;
      found.used = true;
      links.push({ line, target: found.target, kind: "reference" });
    }
  }
};

const setextProblems = (lines: ReadonlyArray<string>): ReadonlyArray<Problem> =>
  lines.flatMap((line, i) => {
    const prev = lines[i - 1] ?? "";
    const paragraph =
      prev.trim() !== "" &&
      !isFenceMarker(prev) &&
      !ATX_HEADING.test(prev) &&
      !/^\s*([-*+]\s|\d+[.)]\s|\||>)/.test(prev);
    return paragraph && SETEXT_UNDERLINE.test(line)
      ? [{ line: i + 1, message: "setext heading underline: use a # heading (unsupported here)" }]
      : [];
  });

export const parseDoc = (source: string): Doc => {
  const lines = cleanLines(source.split("\n"));
  const headings: Heading[] = [];
  lines.forEach((raw, index) => {
    const heading = ATX_HEADING.exec(raw);
    if (heading !== null) {
      headings.push({ line: index + 1, level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
    }
  });
  const blocks = blocksOf(lines);
  const definitions = new Map<string, Definition>();
  const bodies = blocks.map((block) => takeDefinitions(block, definitions));
  const links: Link[] = [];
  const problems: Problem[] = [...setextProblems(lines)];
  blocks.forEach((block, i) => {
    scanBlock(block, bodies[i] ?? "", definitions, links, problems);
  });
  for (const def of definitions.values()) {
    if (!def.used) links.push({ line: def.line, target: def.target, kind: "definition" });
  }
  links.sort((a, b) => a.line - b.line);
  return { lines, links, headings, slugs: new Set(slugify(headings.map((h) => h.text))), problems };
};

// ---------------------------------------------------------------------------
// GitHub heading slugs

/** The text a heading renders as: links reduced to their text, emphasis and code marks gone. */
export const renderedHeading = (text: string): string =>
  text
    .split(/(`+.+?`+)/)
    .map((part) => {
      const code = /^(`+)(.+?)\1$/.exec(part);
      if (code !== null) return code[2] ?? "";
      return part
        .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\*/g, "")
        .replace(/(?<![\p{L}\p{N}])_+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])_+(?![\p{L}\p{N}_])/gu, "");
    })
    .join("")
    .trim();

/** GitHub's slugger, including `-1`, `-2` suffixes for duplicates within a file. */
export const slugify = (headings: ReadonlyArray<string>): ReadonlyArray<string> => {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  return headings.map((heading) => {
    const base = renderedHeading(heading)
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    while (used.has(slug)) {
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      slug = `${base}-${n}`;
    }
    used.add(slug);
    return slug;
  });
};

// ---------------------------------------------------------------------------
// Corpora

const cachedDocs = (read: (path: string) => string | undefined): Corpus["doc"] => {
  const cache = new Map<string, Doc | undefined>();
  return (path) => {
    if (!cache.has(path)) {
      const text = read(path);
      cache.set(path, text === undefined ? undefined : parseDoc(text));
    }
    return cache.get(path);
  };
};

const git = (...args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out = Bun.spawnSync(["git", "-C", root, ...args, "-z"], { stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  return out.stdout.toString().split("\0").filter(Boolean);
};

/** Tracked and untracked-but-not-ignored Markdown in the repository, minus vendored trees. */
export const repoCorpus = (): Corpus => {
  const found = new Set([
    ...git("ls-files", "*.md"),
    ...git("ls-files", "--others", "--exclude-standard", "*.md"),
  ]);
  const files = [...found]
    .filter((f) => !EXCLUDED.some((x) => f.startsWith(x) || f.includes(`/${x}`)))
    .filter((f) => existsSync(join(root, f)))
    .sort();
  return {
    files,
    exists: (path) => existsSync(join(root, path)),
    doc: cachedDocs((path) => {
      const full = join(root, path);
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : undefined;
    }),
  };
};

/** Fixtures keyed by path. Other existing paths (images, source files) may be named in `extra`. */
export const memoryCorpus = (
  sources: Readonly<Record<string, string>>,
  extra: ReadonlyArray<string> = []
): Corpus => {
  const paths = [...Object.keys(sources), ...extra];
  return {
    files: Object.keys(sources)
      .filter((f) => f.endsWith(".md"))
      .sort(),
    exists: (path) => paths.some((p) => p === path || p.startsWith(`${path}/`)),
    doc: cachedDocs((path) => sources[path]),
  };
};

// ---------------------------------------------------------------------------
// Resolving links

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

type Resolved = { readonly path: string; readonly fragment: string | undefined };

/** Splits a link target into a repo-relative path and fragment; undefined for external targets. */
const resolveTarget = (file: string, target: string): Resolved | undefined => {
  if (/^[a-z][a-z0-9+.-]+:/i.test(target) || target.startsWith("//")) return undefined;
  const hash = target.indexOf("#");
  const beforeHash = hash === -1 ? target : target.slice(0, hash);
  const fragment = hash === -1 ? undefined : decode(target.slice(hash + 1));
  const pathPart = decode(beforeHash.split("?")[0] ?? "");
  if (pathPart === "") return { path: file, fragment };
  const path = pathPart.startsWith("/")
    ? posix.normalize(pathPart.slice(1))
    : posix.normalize(posix.join(posix.dirname(file), pathPart));
  return { path: path.replace(/\/$/, ""), fragment };
};

// ---------------------------------------------------------------------------
// Checks

/** 1. Relative links exist, and fragments on Markdown targets name a heading. */
export const checkLinks = (corpus: Corpus): ReadonlyArray<Failure> => {
  const failures: Failure[] = [];
  for (const file of corpus.files) {
    const doc = corpus.doc(file);
    for (const { line, message } of doc?.problems ?? []) failures.push({ file, line, message });
    for (const { line, target } of doc?.links ?? []) {
      const resolved = resolveTarget(file, target);
      if (resolved === undefined) continue;
      if (!corpus.exists(resolved.path)) {
        failures.push({ file, line, message: `broken link: ${target} does not exist` });
        continue;
      }
      const { path, fragment } = resolved;
      if (fragment === undefined || fragment === "" || !path.endsWith(".md")) continue;
      const known = corpus.doc(path)?.slugs;
      if (known !== undefined && !known.has(fragment)) {
        failures.push({
          file,
          line,
          message: `broken anchor: ${path} has no heading #${fragment}`,
        });
      }
    }
  }
  return failures;
};

const isScopePage = (file: string): boolean =>
  file === OVERVIEW ||
  file === "README.md" ||
  /^docs\/(architecture|platforms|runbooks)\/[^/]+\.md$/.test(file) ||
  file.startsWith("plugin/skills/");

const BLOCK_START =
  /^(#{1,6}(\s|$)|[-*+](\s|$)|\d+[.)](\s|$)|\||>|`{3}|~{3}|<|\s{4}|\s*(-{3,}|\*{3,}|_{3,})\s*$)/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 2. The first block after the H1 is a plain paragraph. */
export const checkScopeLine = (corpus: Corpus): ReadonlyArray<Failure> => {
  const failures: Failure[] = [];
  for (const file of corpus.files.filter(isScopePage)) {
    const doc = corpus.doc(file);
    const h1 = doc?.headings[0];
    if (doc === undefined) continue;
    if (h1 === undefined || h1.level !== 1) {
      failures.push({ file, line: 1, message: "scope line: the page has no H1 heading" });
      continue;
    }
    let next = h1.line;
    while (next < doc.lines.length && (doc.lines[next] ?? "").trim() === "") next++;
    const first = doc.lines[next];
    if (first === undefined || first.trim() === "") {
      failures.push({ file, line: h1.line, message: "scope line: nothing follows the H1" });
    } else if (BLOCK_START.test(first) || TABLE_DELIMITER.test(doc.lines[next + 1] ?? "x")) {
      failures.push({
        file,
        line: next + 1,
        message: "scope line: the first block after the H1 must be a plain paragraph",
      });
    }
  }
  return failures;
};

const h2s = (doc: Doc): ReadonlyArray<Heading> => doc.headings.filter((h) => h.level === 2);

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** 3. Architecture pages and runbooks have their fixed H2 sections. */
export const checkShape = (
  corpus: Corpus,
  allowlist: ReadonlyArray<string> = SHAPE_ALLOWLIST
): ReadonlyArray<Failure> => {
  const failures: Failure[] = [];
  const conforming = new Set<string>();
  for (const file of corpus.files) {
    const architecture = /^docs\/architecture\/[^/]+\.md$/.test(file);
    const runbook = /^docs\/runbooks\/[^/]+\.md$/.test(file);
    const doc = corpus.doc(file);
    if (doc === undefined || !(architecture || runbook)) continue;
    const headings = h2s(doc);
    const names = headings.map((h) => h.text);
    let nonconforming = false;
    const fail = (line: number, message: string) => {
      nonconforming = true;
      if (!allowlist.includes(file)) failures.push({ file, line, message });
    };
    if (architecture && !sameList(names, ARCHITECTURE_SECTIONS)) {
      fail(
        headings[0]?.line ?? 1,
        `page shape: H2 sections are [${names.join(", ")}], expected [${ARCHITECTURE_SECTIONS.join(", ")}]`
      );
    }
    if (runbook && names[0] !== "Before you start") {
      fail(headings[0]?.line ?? 1, `page shape: the first H2 must be "Before you start"`);
    }
    if (runbook && names[names.length - 1] !== "If it fails") {
      fail(
        headings[headings.length - 1]?.line ?? 1,
        `page shape: the last H2 must be "If it fails"`
      );
    }
    if (!nonconforming) conforming.add(file);
  }
  for (const entry of allowlist) {
    if (conforming.has(entry) || !corpus.files.includes(entry)) {
      failures.push({
        file: entry,
        line: 1,
        message: "stale shape allowlist entry: the page conforms or is gone; remove it",
      });
    }
  }
  return failures;
};

/** The last line of the section a heading opens: before the next H2, or the file's end. */
const sectionEnd = (doc: Doc, heading: Heading): number => {
  const next = h2s(doc).find((h) => h.line > heading.line);
  return next === undefined ? doc.lines.length : next.line - 1;
};

/** 4. The overview's topic section links every architecture, platform and runbook page. */
export const checkOverview = (corpus: Corpus): ReadonlyArray<Failure> => {
  const doc = corpus.doc(OVERVIEW);
  if (doc === undefined) return [{ file: OVERVIEW, line: 1, message: "the overview is missing" }];
  const topics = h2s(doc).find((h) => h.text === OVERVIEW_TOPICS);
  if (topics === undefined) {
    return [{ file: OVERVIEW, line: 1, message: `missing H2 "${OVERVIEW_TOPICS}"` }];
  }
  const end = sectionEnd(doc, topics);
  const linked = new Set(
    doc.links
      .filter((l) => l.kind !== "definition" && l.line > topics.line && l.line <= end)
      .map((l) => resolveTarget(OVERVIEW, l.target)?.path)
  );
  return corpus.files
    .filter((f) => /^docs\/(architecture|platforms|runbooks)\/[^/]+\.md$/.test(f))
    .filter((f) => !linked.has(f))
    .map((f) => ({
      file: OVERVIEW,
      line: topics.line,
      message: `"${OVERVIEW_TOPICS}" does not link ${f}`,
    }));
};

const inHistoryScope = (file: string): boolean =>
  file === OVERVIEW ||
  file === "README.md" ||
  /^docs\/(architecture|runbooks)\/[^/]+\.md$/.test(file) ||
  file.startsWith("plugin/skills/");

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** Links from current pages into frames or research that sit outside their History footer. */
export const frameLinkViolations = (corpus: Corpus): ReadonlyArray<FrameLink> => {
  const violations: FrameLink[] = [];
  for (const file of corpus.files.filter(inHistoryScope)) {
    const doc = corpus.doc(file);
    if (doc === undefined) continue;
    const history = h2s(doc).find((h) => h.text === HISTORY);
    const historyEnd = history === undefined ? 0 : sectionEnd(doc, history);
    for (const { line, target, kind } of doc.links) {
      if (kind === "definition") continue;
      const path = resolveTarget(file, target)?.path;
      if (path === undefined) continue;
      const inFrames = within(path, "docs/frames");
      const inResearch = within(path, "docs/research");
      if (!inFrames && !inResearch) continue;
      if (history !== undefined && line >= history.line && line <= historyEnd) continue;
      if (path === "docs/frames/README.md") continue;
      if (file === "README.md" && inResearch) continue;
      violations.push({ file, line, target: path });
    }
  }
  return violations;
};

const violationKey = (v: FrameLink): string => `${v.file} -> ${v.target}`;

/** 5. Only allowlisted links into frames or research sit outside History; entries cannot go stale. */
export const checkFrameLinks = (
  corpus: Corpus,
  allowlist: ReadonlyArray<string> = FRAME_LINK_ALLOWLIST
): ReadonlyArray<Failure> => {
  const violations = frameLinkViolations(corpus);
  const allowed = new Set(allowlist);
  const seen = new Set(violations.map(violationKey));
  const failures: Failure[] = violations
    .filter((v) => !allowed.has(violationKey(v)))
    .map((v) => ({
      file: v.file,
      line: v.line,
      message: `link to ${v.target} outside the History section`,
    }));
  for (const entry of allowlist) {
    if (!seen.has(entry)) {
      failures.push({
        file: entry.split(" -> ")[0] ?? entry,
        line: 1,
        message: `stale allowlist entry: remove it from FRAME_LINK_ALLOWLIST (${entry})`,
      });
    }
  }
  return failures;
};

/** Every check, over the allowlists in this file; failures ordered by file and line. */
export const checkAll = (corpus: Corpus): ReadonlyArray<Failure> =>
  [
    ...checkLinks(corpus),
    ...checkScopeLine(corpus),
    ...checkShape(corpus),
    ...checkOverview(corpus),
    ...checkFrameLinks(corpus),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

// ---------------------------------------------------------------------------
// Running

const printAllowlist = (corpus: Corpus): void => {
  const keys = [...new Set(frameLinkViolations(corpus).map(violationKey))].sort();
  console.log("[");
  for (const key of keys) console.log(`  ${JSON.stringify(key)},`);
  console.log("]");
};

const main = (): number => {
  const corpus = repoCorpus();
  if (process.argv.includes("--print-allowlist")) {
    printAllowlist(corpus);
    return 0;
  }
  const failures = checkAll(corpus);
  for (const f of failures) console.log(`${f.file}:${f.line}: ${f.message}`);
  if (failures.length > 0) {
    console.log(`\ncheck-docs: ${failures.length} failure${failures.length === 1 ? "" : "s"}`);
    return 1;
  }
  console.log(`check-docs: ${corpus.files.length} Markdown files ok`);
  return 0;
};

if (import.meta.main) process.exit(main());
