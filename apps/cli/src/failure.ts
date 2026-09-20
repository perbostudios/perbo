import { EXIT_CODES, LimitExceededError } from "@perbo/contracts";
import {
  AgentConfigurationPresentError,
  DeliveryError,
  ResumeRefusedError,
  RunRefusedError,
} from "@perbo/runner";
import { CommandFailedError, WorkspaceError } from "@perbo/workspace";

/**
 * What a refused run says: what was found, and what to run about it.
 *
 * The findings are the diagnostic's own, printed one to a line with the reason
 * that names them and the detail that explains them — which is also where a
 * finding states its fix, so nothing here has to restate one. Then the command
 * that answers the whole question against this repository, because the finding
 * on its own tells a person what is wrong and not how to see the rest of it.
 */
function refusalReport(noun: string, error: RunRefusedError): string {
  const found = error.findings.map((finding) => `\n  ${finding.reason} — ${finding.detail}`).join("");
  return (
    `${noun} did not start: ${error.message}.${found}\n` +
    `Nothing was executed. \`perbo doctor --repo ${error.repository_root}\` reports the whole ` +
    "diagnostic."
  );
}

/**
 * One sentence per failure class, with the fix where one is known. A stack
 * trace is kept only for an error nothing here recognises, because a partner
 * reading "the review did not complete: Error: spawn claude ENOENT" followed
 * by twelve frames is being handed a debugging session instead of an answer.
 */
export function describeFailure(command: string, error: unknown): { message: string; code: number } {
  const noun =
    command === "review" ? "the review" : command === "run" ? "the run" : `\`perbo ${command}\``;
  const code = EXIT_CODES.did_not_complete;
  if (error instanceof RunRefusedError) return { message: refusalReport(noun, error), code };
  if (error instanceof LimitExceededError) {
    const raise =
      error.reason === "limit_exceeded" && error.resource
        ? ` Raise limits.limits.${error.resource} in .perbo/config.json to allow it.`
        : " Clear the kill switch in the limits table to allow it.";
    return { message: `${noun} was refused by a limit: ${error.message}.${raise}`, code };
  }
  if (error instanceof WorkspaceError) {
    return {
      message: `${noun} could not prepare a worktree (${error.reason}): ${error.message}. Run \`perbo doctor --repo .\` for the specific reason.`,
      code,
    };
  }
  if (error instanceof DeliveryError) {
    return { message: `${noun} could not publish: ${error.message} — ${error.detail}.`, code };
  }
  if (error instanceof ResumeRefusedError) {
    return {
      message:
        `${noun} could not resume from ${error.bundle_id}: ${error.message}. Nothing was ` +
        "executed and the bundle is untouched; run the ticket without --resume-from to start " +
        "from the base commit instead.",
      code,
    };
  }
  if (error instanceof AgentConfigurationPresentError) {
    return {
      message:
        `${noun} stopped because ${error.message}. The attempt is recorded; nothing was ` +
        "reviewed. Remove the configuration the agent loaded, or report which path it named.",
      code,
    };
  }
  // A command the run started and could not finish. The error already carries
  // the argv, the exit code and what the command wrote; all that was missing is
  // that they reached the person, so this branch prints them and drops the
  // frames. It is not the seal's own: every command a run starts — the install,
  // the checks, the push — fails the same way and says why the same way.
  if (error instanceof CommandFailedError) {
    return { message: `${noun} stopped on a command that failed: ${error.message}`, code };
  }
  const failure = error as { code?: unknown; path?: unknown; syscall?: unknown };
  if (error instanceof Error && failure.code === "ENOENT" && typeof failure.syscall === "string" && failure.syscall.startsWith("spawn")) {
    const binary = typeof failure.path === "string" ? failure.path : failure.syscall.replace(/^spawn\s*/, "") || "a binary";
    const fix =
      binary === "claude"
        ? "install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in with `claude`"
        : binary === "gh"
          ? "install the GitHub CLI (https://cli.github.com) and run `gh auth login`"
          : binary === "git"
            ? "install git (https://git-scm.com)"
            : `install \`${binary}\` and make sure it is on PATH`;
    return { message: `${noun} needs \`${binary}\`, which is not on PATH: ${fix}.`, code };
  }
  return {
    message: `${noun} did not complete: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    code,
  };
}
