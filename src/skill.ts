import activity from "../plugin/skills/agent-bus/references/activity.md" with { type: "text" };
import addressing from "../plugin/skills/agent-bus/references/addressing.md" with { type: "text" };
import orientation from "../plugin/skills/agent-bus/references/orientation.md" with {
  type: "text",
};
import queries from "../plugin/skills/agent-bus/references/queries.md" with { type: "text" };
import refusals from "../plugin/skills/agent-bus/references/refusals.md" with { type: "text" };
import runtimes from "../plugin/skills/agent-bus/references/runtimes.md" with { type: "text" };
import skill from "../plugin/skills/agent-bus/SKILL.md" with { type: "text" };

/** The authored skill is bundled into each server, including its relative references. */
export const busSkill = {
  uri: "skill://agent-bus/SKILL.md",
  files: {
    "SKILL.md": skill,
    "references/activity.md": activity,
    "references/addressing.md": addressing,
    "references/orientation.md": orientation,
    "references/queries.md": queries,
    "references/refusals.md": refusals,
    "references/runtimes.md": runtimes,
  },
};
