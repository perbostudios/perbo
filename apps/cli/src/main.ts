#!/usr/bin/env node
import { admitCommandLine, approveCommandLine, listCommandLine } from "./commands/admit.js";
import { baselineCommandLine } from "./commands/baseline/index.js";
import { runCommandLine, startEntryPoint, type EntryPoint } from "./command-line/terminal.js";
import { editCommandLine } from "./commands/edit/index.js";
import { escapesCommandLine } from "./commands/escapes/index.js";
import { doctorCommandLine, executeCommandLine } from "./commands/run/index.js";
import { COMMAND_NAMES, type CommandName } from "./command-line/names.js";
import { inspectCommandLine } from "./commands/inspect.js";
import { principleCommandLine } from "./commands/principle.js";
import { reviewCommandLine } from "./commands/review/index.js";
import { VERSION } from "./version.js";
import { stopsCommandLine } from "./commands/stops.js";
import { indexCommandLine } from "./commands/symbol-index.js";
import { agentCommandLine } from "./commands/agent.js";
import { interviewCommandLine } from "./commands/interview/index.js";
import { mcpCommandLine } from "./commands/mcp.js";
import { serveCommandLine } from "./commands/serve/index.js";
import { syncCommandLine } from "./commands/sync.js";
import { USAGE } from "./command-line/usage.js";
import { verdictCommandLine } from "./commands/verdict/index.js";

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
 * thrown error exits as — is `command-line/terminal.js`.
 */
export const FULL_ENTRY_POINT: EntryPoint<CommandName> = {
  usage: USAGE,
  commands: COMMAND_NAMES,
  version: VERSION,
  dispatch(command, rest, streams) {
    const cwd = process.cwd();
    switch (command) {
      case "doctor":
        return runCommandLine(doctorCommandLine, { argv: rest, streams, cwd });
      case "baseline":
        return runCommandLine(baselineCommandLine, { argv: rest, streams, cwd });
      case "review":
        return runCommandLine(reviewCommandLine, { argv: rest, streams, cwd });
      case "inspect":
        return runCommandLine(inspectCommandLine, { argv: rest, streams, cwd });
      case "verdict":
        return runCommandLine(verdictCommandLine, { argv: rest, streams, cwd });
      case "run":
        return runCommandLine(executeCommandLine, { argv: rest, streams, cwd });
      case "admit":
        return runCommandLine(admitCommandLine, { argv: rest, streams, cwd });
      case "approve":
        return runCommandLine(approveCommandLine, { argv: rest, streams, cwd });
      case "edit":
        return runCommandLine(editCommandLine, { argv: rest, streams, cwd });
      case "list":
        return runCommandLine(listCommandLine, { argv: rest, streams, cwd });
      case "sync":
        return runCommandLine(syncCommandLine, { argv: rest, streams, cwd });
      case "serve":
        return runCommandLine(serveCommandLine, { argv: rest, streams, cwd });
      case "mcp":
        return runCommandLine(mcpCommandLine, { argv: rest, streams, cwd });
      case "agent":
        return runCommandLine(agentCommandLine, { argv: rest, streams, cwd });
      case "interview":
        return runCommandLine(interviewCommandLine, { argv: rest, streams, cwd });
      case "stops":
        return runCommandLine(stopsCommandLine, { argv: rest, streams, cwd });
      case "escapes":
        return runCommandLine(escapesCommandLine, { argv: rest, streams, cwd });
      case "principle":
        return runCommandLine(principleCommandLine, { argv: rest, streams, cwd });
      case "index":
        return runCommandLine(indexCommandLine, { argv: rest, streams, cwd });
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
