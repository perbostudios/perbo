import { z } from "zod";
import { OPENCODE_API_KEY_ENV, OPENCODE_MIN_VERSION, opencodeVersionFits } from "@perbo/contracts";
import type { Execute } from "../repository/git.js";
import type { HostIO } from "../service.js";
import type { Provider } from "../../shared/protocol.js";

/** The command a person runs in their own terminal to sign a provider in. */
export const LOGIN_COMMANDS = {
  claude: ["claude", "auth", "login"],
  codex: ["codex", "login"],
} as const;

/**
 * Whether each provider's CLI is installed on this machine and signed in, and
 * on what: a subscription reads differently from a metered key, and a person
 * signs in through their own terminal rather than here.
 */
export async function probeProviders(
  execute: Execute,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Provider[]> {
  const probe = async (id: "claude" | "codex"): Promise<Provider> => {
    const base = {
      id,
      name: id === "claude" ? "Claude Code" : "Codex",
      loginCommand: LOGIN_COMMANDS[id].join(" "),
      roles:
        id === "claude"
          ? ["Execution", "Independent review", "Planning"]
          : ["Execution", "Independent review", "Planning"],
    };
    try {
      const result = await execute(
        id,
        id === "claude" ? ["auth", "status", "--json"] : ["login", "status"],
        { cwd, timeoutMs: 12_000 },
      );
      const logged =
        id === "claude"
          ? z
              .object({
                loggedIn: z.boolean(),
                authMethod: z.string().optional(),
              })
              .safeParse(JSON.parse(result.stdout || "{}"))
          : null;
      const authenticated =
        id === "claude"
          ? logged?.success === true && logged.data.loggedIn
          : result.code === 0;
      const subscription =
        id === "claude"
          ? logged?.success === true &&
            /oauth|subscription/i.test(logged.data.authMethod ?? "")
          : /chatgpt/i.test(result.stdout + result.stderr);
      return {
        ...base,
        installed: true,
        authenticated,
        detail: authenticated
          ? subscription
            ? "Signed in with your subscription"
            : "Signed in · credential managed by the CLI"
          : "Installed · sign in through your terminal, then refresh",
      };
    } catch {
      return {
        ...base,
        installed: false,
        authenticated: false,
        detail: "CLI unavailable. Install it, sign in, then refresh.",
      };
    }
  };
  const providers = await Promise.all([probe("claude"), probe("codex"), probeOpenCode(execute, cwd, environment)]);
  return [
    ...providers,
    {
      id: "anthropic",
      name: "Anthropic API · optional",
      installed: true,
      authenticated: Boolean(environment["ANTHROPIC_API_KEY"]),
      detail: environment["ANTHROPIC_API_KEY"]
        ? "Environment credential available · metered API usage"
        : "No ANTHROPIC_API_KEY in the app environment",
      loginCommand: "",
      roles: ["Independent review"],
    },
  ];
}

/**
 * OpenCode, as every role Perbo runs on it sees it (D-134).
 *
 * There is no sign-in to offer: each role runs OpenCode under a home of
 * Perbo's own making, where a login the person made would never be read, and
 * authenticates with OpenCode Zen's key from the app environment or runs
 * OpenCode's free models without one. So an installed OpenCode at
 * {@link OPENCODE_MIN_VERSION} or later is connected, and the detail says
 * which of the two it runs on.
 */
async function probeOpenCode(execute: Execute, cwd: string, environment: NodeJS.ProcessEnv): Promise<Provider> {
  const base = {
    id: "opencode" as const,
    name: "OpenCode",
    loginCommand: "",
    roles: ["Execution", "Independent review", "Planning"],
  };
  try {
    const result = await execute("opencode", ["--version"], { cwd, timeoutMs: 12_000 });
    const line = (result.stdout || result.stderr).trim();
    if (result.code !== 0 || !opencodeVersionFits(line))
      return {
        ...base,
        installed: result.code === 0,
        authenticated: false,
        detail:
          result.code === 0
            ? `OpenCode ${line || "of an unknown version"} is installed; Perbo needs ${OPENCODE_MIN_VERSION} or later`
            : "CLI unavailable. Install OpenCode 2, then refresh.",
      };
    return {
      ...base,
      installed: true,
      authenticated: true,
      detail: environment[OPENCODE_API_KEY_ENV]
        ? `${OPENCODE_API_KEY_ENV} in the app environment · metered OpenCode Zen`
        : `No ${OPENCODE_API_KEY_ENV} · OpenCode's free models only`,
    };
  } catch {
    return {
      ...base,
      installed: false,
      authenticated: false,
      detail: "CLI unavailable. Install OpenCode 2, then refresh.",
    };
  }
}

/**
 * Open the provider's own sign-in in the person's terminal. Nothing is typed
 * for them and no credential passes through this host: the command is fixed,
 * and where there is no terminal to open the person is told what to run.
 */
export async function openLogin(io: HostIO, provider: "claude" | "codex"): Promise<null> {
  const command = LOGIN_COMMANDS[provider];
  if (!io.openTerminal)
    throw new Error(
      `Run ${command.join(" ")} in your terminal, then refresh the connection.`,
    );
  await io.openTerminal(command);
  return null;
}
