/**
 * The model each transport calls when the caller names none.
 *
 * One value per provider, in one place: a default that is also a price card's
 * subject, or a default spelled twice, is a default that drifts.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-terra";
/** OpenCode names a model `provider/model`; Claude Opus 5 through OpenCode Zen, which needs `OPENCODE_API_KEY`. */
export const DEFAULT_OPENCODE_MODEL = "opencode/claude-opus-5";

/**
 * Claude Opus 5.5, wherever Claude Code's catalog offers it: the Architect's
 * model by its rule (D-102), the model a picker lists first, and the
 * executor's default in a new setup and a proposed `.perbo/config.json`
 * (D-093); the reviewer keeps {@link DEFAULT_CLAUDE_MODEL} (D-010). Offered under
 * this id or its 1M-context one; it is never assumed offered, and a caller
 * reads the catalog first.
 */
export const PREFERRED_CLAUDE_MODEL = "claude-opus-5-5";

/**
 * {@link PREFERRED_CLAUDE_MODEL} under the id a catalog offers it by: its own,
 * or else its 1M-context one. Undefined where the catalog offers neither.
 */
export function offeredPreferredModel(offered: readonly string[]): string | undefined {
  return [PREFERRED_CLAUDE_MODEL, PREFERRED_CLAUDE_MODEL + "[1m]"].find((id) => offered.includes(id));
}

/**
 * Claude Code in stream-json mode with repository instructions, hooks, tools,
 * plugins and MCP servers off. A catalog read and a usage probe speak control
 * requests to it and never write a user message, so no turn starts.
 */
export const CLAUDE_METADATA_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--setting-sources",
  "user",
  "--settings",
  '{"disableAllHooks":true,"enabledPlugins":{}}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
  "--disable-slash-commands",
  "--no-chrome",
  "--safe-mode",
];
