import { readFileSync } from "node:fs";
import { runSessionStartHook } from "./brief.js";
import { failClosed, runPreToolHook } from "./pretool.js";

/**
 * The hook the attempt's settings file installs, as a program (SCP-177,
 * D-096).
 *
 * Two events reach it, and the call's `hook_event_name` says which. For
 * `PreToolUse` — once per Bash, Write, Edit, MultiEdit and NotebookEdit call,
 * and once per call to the tool that starts a subagent, under either name
 * Claude Code answers to for it (Agent, or Task under its former name),
 * before the tool — the call arrives as JSON on stdin and the decision goes
 * back as JSON on stdout. For `SessionStart` under the `compact` matcher, what
 * goes back is the round's brief and the state block, as plain text that
 * Claude Code adds to the compacted context. The guard's directory is the one
 * argument either way.
 *
 * It exits 0 whatever happens. A non-zero exit other than 2 is a non-blocking
 * hook error, which runs the tool — so the only safe way to fail is to print a
 * refusal and leave.
 */

/** Whether this call is the brief's event rather than the guard's. */
function isSessionStart(stdin: string): boolean {
  try {
    return (JSON.parse(stdin) as { hook_event_name?: unknown }).hook_event_name === "SessionStart";
  } catch {
    // Unreadable: judged as a tool call, which is the answer that fails closed.
    return false;
  }
}

function main(): void {
  const directory = process.argv[2];
  if (directory === undefined) {
    process.stdout.write(
      JSON.stringify(failClosed("the runner's write guard was started without its state directory")),
    );
    return;
  }
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    // No tool call to judge, so there is nothing to admit.
  }
  if (isSessionStart(stdin)) {
    // Printed as it is: a SessionStart hook's standard output is what Claude
    // Code adds to the context, so an envelope would land in the brief.
    // Nothing printed is the other answer — the session did not start from a
    // compaction, or this attempt recorded no brief.
    const text = runSessionStartHook(directory, stdin);
    if (text !== null) process.stdout.write(text);
    return;
  }
  const response = runPreToolHook(directory, stdin);
  // Nothing printed is the third answer: the runner has no grounds either way
  // and the agent's own permission layer decides, as it did before this hook.
  if (response !== null) process.stdout.write(JSON.stringify(response));
}

try {
  main();
} catch (error) {
  process.stdout.write(
    JSON.stringify(
      failClosed(
        `the runner's write guard failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ),
  );
}
process.exitCode = 0;
