#!/usr/bin/env node
import { parseReviewArgs } from "./args.js";
import {
  parseAdmitArgs,
  parseListArgs,
  runAdmitCommand,
  runApproveCommand,
  runListCommand,
} from "./admit.js";
import { runBaselineCommand } from "./baseline.js";
import { startEntryPoint, type EntryPoint } from "./entry.js";
import { runEditCommand } from "./edit.js";
import { runEscapesCommand } from "./escapes.js";
import {
  FULL_COMMAND_SET,
  parseExecuteArgs,
  runDoctorCommand,
  runExecuteCommand,
  type FullCommandName,
} from "./execute.js";
import { runInspectCommand } from "./inspect.js";
import { parsePrincipleArgs, runPrincipleCommand } from "./principles.js";
import { runReviewCommand } from "./run.js";
import { VERSION } from "./version.js";
import { runStopsCommand } from "./stops.js";
import { runIndexCommand } from "./symbol-index.js";
import { runAgentCommand } from "./agent.js";
import { runInterviewCommand } from "./interview.js";
import { runMcpCommand } from "./mcp.js";
import { runServeCommand } from "./serve.js";
import { runSyncCommand } from "./sync.js";
import { USAGE } from "./usage.js";
import { runVerdictCommand } from "./verdict.js";

/**
 * `perbo` (docs/04, "Review CLI contract", SCP-091).
 *
 * Every command: the six that work against a repository with nothing
 * admitted — doctor, baseline, review, inspect, verdict, run — the twelve
 * that build history across machines — admission, its edits and approval, the
 * work on record, the pull-request read-back, the queue over the store, its
 * endpoint, the session that reads it and the interview that writes the spec,
 * and the two measures over it — and
 * `index`, which reads the repository's own code and writes only the symbol
 * and import index built from it.
 *
 * The shell around the table — help, version, an unknown command, and what a
 * thrown error exits as — is `entry.js`.
 */
export const FULL_ENTRY_POINT: EntryPoint<FullCommandName> = {
  usage: USAGE,
  commands: FULL_COMMAND_SET,
  version: VERSION,
  dispatch(command, rest, streams) {
    const cwd = process.cwd();
    switch (command) {
      case "doctor":
        return runDoctorCommand({ args: parseExecuteArgs(rest), streams, cwd });
      case "baseline":
        return runBaselineCommand({ argv: rest, streams, cwd });
      case "review":
        return runReviewCommand({ args: parseReviewArgs(rest), streams, cwd, now: new Date() });
      case "inspect":
        return runInspectCommand({ argv: rest, streams, cwd });
      case "verdict":
        return runVerdictCommand({ argv: rest, streams, cwd });
      case "run":
        return runExecuteCommand({ args: parseExecuteArgs(rest), streams, cwd });
      case "admit":
        return runAdmitCommand({ args: parseAdmitArgs(rest), streams, cwd });
      case "approve":
        return runApproveCommand({ argv: rest, streams, cwd });
      case "edit":
        return runEditCommand({ argv: rest, streams, cwd });
      case "list":
        return runListCommand({ args: parseListArgs(rest), streams, cwd });
      case "sync":
        return runSyncCommand({ argv: rest, streams, cwd });
      case "serve":
        return runServeCommand({ argv: rest, streams, cwd });
      case "mcp":
        return runMcpCommand({ argv: rest, streams, cwd });
      case "agent":
        return runAgentCommand({ argv: rest, streams, cwd });
      case "interview":
        return runInterviewCommand({ argv: rest, streams, cwd });
      case "stops":
        return runStopsCommand({ argv: rest, streams, cwd });
      case "escapes":
        return runEscapesCommand({ argv: rest, streams, cwd });
      case "principle":
        return runPrincipleCommand(parsePrincipleArgs(rest));
      case "index":
        return runIndexCommand({ argv: rest, streams, cwd });
      default:
        // Unreachable: the shell refuses anything not in `commands`, and this
        // switch covers every one of them. A command added to the table and not
        // to the switch fails to compile rather than at the user.
        return assertNever(command);
    }
  },
};

function assertNever(command: never): never {
  throw new Error(`this build has no ${String(command)} command`);
}

startEntryPoint(process.argv.slice(2), FULL_ENTRY_POINT);
