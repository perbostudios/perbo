import { join } from "node:path";

/**
 * OpenCode as a provider (D-134): how each of the three
 * roles Perbo runs on it — the executor, the reviewer and the chat — starts
 * `opencode acp`, in one place so the three cannot start it differently.
 *
 * Every role runs OpenCode under a home of Perbo's own making, fresh for the
 * process: its configuration, data, state and cache directories are
 * directories Perbo made, the project's own configuration is switched off, and
 * the whole configuration it runs on is {@link opencodeConfig}'s. OpenCode 2
 * keeps a credential and the "always allow" rules a person gave it in the same
 * database, and a saved rule decides a call before any client is asked, so the
 * person's own database never reaches a role: an OpenCode role authenticates
 * with `OPENCODE_API_KEY` from the environment, OpenCode Zen's key, or runs
 * OpenCode's free models without one.
 */

/**
 * The earliest OpenCode a role runs: 2.0.14, the build every guarantee here
 * was measured on — the ACP server's permission requests, its tool-server
 * configuration, the instruction file it reads and the layout of its data
 * directory. No earlier build was measured, so none is admitted.
 */
export const OPENCODE_MIN_VERSION = "2.0.14";

/** OpenCode Zen's key, the one credential an OpenCode role is passed, and only by name. */
export const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";

/** How every role starts OpenCode: its Agent Client Protocol server on stdio. */
export const OPENCODE_ACP_ARGV = ["acp"] as const;

/**
 * The primary agents OpenCode itself defines. A session that reports any other
 * has loaded an agent definition from somewhere, and a role refuses it.
 */
export const OPENCODE_BUILTIN_MODES = ["build", "plan"] as const;

/**
 * How often, and how far apart, a role asks OpenCode for a session. OpenCode
 * reads its model catalogue as it starts and refuses a session asked for before
 * the catalogue has arrived ("Internal service failure", measured on 2.0.14),
 * which a fresh cache makes the ordinary first answer.
 */
export const OPENCODE_SESSION_ATTEMPTS = 5;
export const OPENCODE_SESSION_RETRY_MS = 2_000;

/** The three roles, in Perbo's words. */
export const OPENCODE_ROLES = ["executor", "reviewer", "interview"] as const;
export type OpenCodeRole = (typeof OPENCODE_ROLES)[number];

/** What a role's session may do without asking: read, list and search inside its directory. */
const READS = { read: "allow", glob: "allow", grep: "allow", list: "allow" } as const;

/**
 * Each role's permission rules, in OpenCode's `permission` shape; the last
 * matching rule wins and `*` goes first, so a tool nobody named is denied —
 * and a denied tool is not offered to the model at all.
 *
 * `ask` is what reaches Perbo: OpenCode puts every such call to the ACP client
 * as `session/request_permission` before it runs, and nothing but the client's
 * answer lets it through. The executor and the chat ask about every command,
 * every file change and every call reaching outside their directory.
 *
 * The reviewer holds no tool it can use, since what it reads comes through the
 * reviewer's own reader: it runs in an empty scratch directory, a read outside
 * it is denied, its transport refuses every command it asks about, and any
 * tool call at all fails the turn. A read and a shell tool are offered all
 * the same, because OpenCode Zen refuses its free models to a session that
 * offers neither ("provider authentication required", measured on 2.0.14).
 */
export function opencodePermissions(role: OpenCodeRole, tools: readonly string[] = []): Record<string, string> {
  if (role === "reviewer") return { "*": "deny", read: "allow", bash: "ask", external_directory: "deny" };
  return {
    "*": "deny",
    ...READS,
    bash: "ask",
    edit: "ask",
    external_directory: "ask",
    ...Object.fromEntries(role === "interview" ? tools.map((tool) => [opencodeToolName(tool), "allow"]) : []),
  };
}

/**
 * The name OpenCode gives one of the chat's own tools, which its permission
 * rule names exactly: a wildcard over the server's prefix does not reach a
 * tool server's tools on OpenCode 2.0.14.
 */
export function opencodeToolName(tool: string): string {
  return `${OPENCODE_INTERVIEW_SERVER}_${tool}`;
}

/** The name the chat's own tools are served under on OpenCode, which prefixes each tool's name. */
export const OPENCODE_INTERVIEW_SERVER = "perbo_interview";

/**
 * The whole configuration a role runs on, as the JSON `OPENCODE_CONFIG_CONTENT`
 * carries. Everything that could start a program, reach a host or add an
 * instruction of its own is off or empty: no tool server but the chat's own,
 * no plugin, no instruction file, no formatter or language server (each runs a
 * program after an edit, unasked), no session sharing, no update, no snapshot.
 *
 * `tools` is where the chat's own tools are served, on the loopback interface
 * behind a token of the process's own, and which they are; only the chat is
 * given it. They are offered one tool each rather than through OpenCode's Code
 * Mode, which would run code the model writes to call them.
 */
export function opencodeConfig(
  role: OpenCodeRole,
  tools?: { url: string; token: string; names: readonly string[] },
): string {
  return JSON.stringify({
    permission: opencodePermissions(role, tools?.names ?? []),
    mcp:
      role === "interview" && tools !== undefined
        ? {
            servers: {
              [OPENCODE_INTERVIEW_SERVER]: {
                type: "remote",
                url: tools.url,
                headers: { Authorization: `Bearer ${tools.token}` },
                oauth: false,
                codemode: false,
              },
            },
          }
        : {},
    plugin: [],
    instructions: [],
    formatter: false,
    lsp: false,
    share: "disabled",
    autoupdate: false,
    snapshot: false,
  });
}

/**
 * Where a role's own text goes under `root`: the `AGENTS.md` of the
 * configuration directory {@link opencodeEnvironment} gives OpenCode, which it
 * reads as the user's global instructions and sends beside its own system
 * prompt on every request. The directory is Perbo's, so that file is the only
 * instruction a role's session carries; the project's are off.
 */
export function opencodeInstructionsPath(root: string): string {
  return join(root, "config", "opencode", "AGENTS.md");
}

/**
 * The environment a role's `opencode acp` receives beside the caller's
 * allow-list: the directories under `root` that stand for OpenCode's own, the
 * project's configuration switched off, and the configuration. `root` is a
 * directory the caller made for this process and removes after it.
 */
export function opencodeEnvironment(root: string, config: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_CONTENT: config,
  };
}

/**
 * Whether a `opencode --version` line names a build at or past
 * {@link OPENCODE_MIN_VERSION}. The line is `2.0.14` or `opencode v2.0.14`.
 */
export function opencodeVersionFits(line: string | null): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(line ?? "");
  if (found === null) return false;
  const [major, minor, patch] = found.slice(1).map(Number) as [number, number, number];
  const [wantMajor, wantMinor, wantPatch] = OPENCODE_MIN_VERSION.split(".").map(Number) as [number, number, number];
  if (major !== wantMajor) return major > wantMajor;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}
