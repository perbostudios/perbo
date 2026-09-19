/* global process */
// A PreToolUse hook that records the raw payload Claude Code hands it, then
// answers with the runner's own guard, unchanged. argv: [guardHookEntry, guardDirectory].
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const [guardHook, directory] = process.argv.slice(2);
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch { /* no tool call to judge, so nothing is admitted */ }
const interesting = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^CLAUDE/.test(k)));
appendFileSync(join(directory, "raw-hook-input.jsonl"), JSON.stringify({ at: new Date().toISOString(), stdin: (() => { try { return JSON.parse(stdin); } catch { return stdin; } })(), env: interesting }) + "\n");
const result = spawnSync(process.execPath, [guardHook, directory], { input: stdin, encoding: "utf8" });
// The guard's own silence is the third answer (defer); the guard failing to run is not, and
// must not read as one: a call it never judged is refused, as the guard itself refuses when it
// cannot read its state.
if (result.error || result.status !== 0) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `the live test's guard wrapper could not run the guard: ${result.error?.message ?? `exit ${result.status}`}`,
    },
  }));
} else {
  process.stdout.write(result.stdout ?? "");
}
process.exitCode = 0;
