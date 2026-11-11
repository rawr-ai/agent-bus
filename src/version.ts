/** agent-bus's version: the CLI's `--version`, and the name it gives MCP servers and Codex app-servers. */
export const VERSION = "0.2.0";

/** Replaced by the release build with the release's id; absent when running from a checkout. */
declare const AGENT_BUS_RELEASE: string | undefined;

/** The release this code was built into, or `source` when it runs from a checkout. */
export const RELEASE: string = typeof AGENT_BUS_RELEASE === "string" ? AGENT_BUS_RELEASE : "source";

/** What `--version` and the MCP server report: the release id, or the version and `+source`. */
export const BUILD = RELEASE === "source" ? `${VERSION}+source` : RELEASE;
