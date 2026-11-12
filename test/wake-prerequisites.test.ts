import { describe, expect, test } from "bun:test";
import {
  lackingWake,
  latestPresences,
  Message,
  Presence,
  Runtime,
  type WakeStanding,
  wakeStanding,
} from "../src/domain.ts";

/** The rule as literal rows: runtime, installation recorded, Codex thread recorded → standing. */
const table: ReadonlyArray<readonly [Runtime, boolean, boolean, WakeStanding]> = [
  ["claude", true, true, "recorded"],
  ["claude", true, false, "recorded"],
  ["claude", false, true, "no-installation"],
  ["claude", false, false, "no-installation"],
  ["codex", true, true, "recorded"],
  ["codex", true, false, "no-codex-thread"],
  ["codex", false, true, "no-installation"],
  ["codex", false, false, "no-installation-or-codex-thread"],
  ["human", true, true, "interactive"],
  ["human", true, false, "interactive"],
  ["human", false, true, "interactive"],
  ["human", false, false, "interactive"],
  ["other", true, true, "interactive"],
  ["other", true, false, "interactive"],
  ["other", false, true, "interactive"],
  ["other", false, false, "interactive"],
];

const joined = (runtime: Runtime, installation: boolean, thread: boolean) =>
  new Presence({
    runtime,
    status: "joined",
    topics: [],
    session: "s",
    ...(installation ? { installation: "i" } : {}),
    ...(thread ? { codexThreadId: "s" } : {}),
  });

let sequence = 0;
const entry = (from: string, presence: Partial<Presence> & Pick<Presence, "status">) =>
  new Message({
    id: `p-${sequence++}`,
    ts: "2026-11-11T00:00:00.000Z",
    from,
    to: ["*"],
    kind: "presence",
    body: "",
    presence: new Presence({ runtime: "codex", topics: [], ...presence }),
  });

describe("wakeStanding", () => {
  test("every runtime has a row for each combination", () => {
    // A runtime added without rows fails here rather than taking another runtime's rule.
    expect(table.map(([runtime]) => runtime).filter((r, i, all) => all.indexOf(r) === i)).toEqual([
      ...Runtime.literals,
    ]);
    expect(table).toHaveLength(Runtime.literals.length * 4);
  });

  test.each(table)(
    "%s, installation %p, thread %p → %s",
    (runtime, installation, thread, standing) => {
      expect(wakeStanding(joined(runtime, installation, thread))).toBe(standing);
    }
  );
});

describe("lackingWake", () => {
  const latest = latestPresences([
    entry("codex/ok", { status: "joined", session: "a", installation: "i", codexThreadId: "a" }),
    entry("claude/ok", { status: "joined", runtime: "claude", session: "b", installation: "i" }),
    entry("claude/legacy", { status: "joined", runtime: "claude", session: "c" }),
    entry("codex/nothread", { status: "joined", session: "d", installation: "i" }),
    entry("human/h", { status: "joined", runtime: "human", session: "e" }),
    entry("codex/left", { status: "joined", session: "f", installation: "i", codexThreadId: "f" }),
    entry("codex/left", { status: "left", session: "f" }),
    entry("codex/ownerless", { status: "joined", installation: "i", codexThreadId: "g" }),
    // A sessionless leave is ignored, as delivery ignores it: the join stands.
    entry("claude/stays", { status: "joined", runtime: "claude", session: "h", installation: "i" }),
    entry("claude/stays", { status: "left", runtime: "claude" }),
    // Another address held by the sender's own session: ownership is per address.
    entry("claude/sibling", { status: "joined", runtime: "claude", session: "b" }),
  ]);
  const lacking = (to: ReadonlyArray<string>, from = "claude/ok") => lackingWake(latest, from, to);

  test("names lacking direct recipients once, in to order", () => {
    expect(
      lacking([
        "codex/never",
        "codex/ok",
        "claude/legacy",
        "codex/nothread",
        "codex/left",
        "codex/ownerless",
        "codex/never",
        "human/h",
        "claude/stays",
      ])
    ).toEqual([
      { address: "codex/never", standing: "not-joined" },
      { address: "claude/legacy", standing: "no-installation" },
      { address: "codex/nothread", standing: "no-codex-thread" },
      { address: "codex/left", standing: "not-joined" },
      { address: "codex/ownerless", standing: "not-joined" },
    ]);
  });

  test("the sender, topics and * are not direct recipients", () => {
    expect(lacking(["claude/legacy"], "claude/legacy")).toEqual([]);
    // Only the sending address is excluded, not every address its session holds.
    expect(lacking(["claude/sibling"])).toEqual([
      { address: "claude/sibling", standing: "no-installation" },
    ]);
    expect(lacking(["*", "#reviews", "#codex/never"])).toEqual([]);
    expect(lacking(["*", "#reviews", "codex/never"])).toEqual([
      { address: "codex/never", standing: "not-joined" },
    ]);
  });
});
