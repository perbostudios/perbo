import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LimitsTableSchema, type CommandRecord } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { ADMISSION_RULES } from "../src/admission.js";
import { runAgent, type AgentResult } from "../src/adapter.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { buildAgentEnvironment, buildPermissionProfile } from "../src/profile.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The mechanism, against the binary that ships (SCP-177 criterion 2).
 *
 * Every other test in this package stands something in the agent's place. This
 * one spawns the real `claude` with the adapter's real flag set, because the
 * whole ticket rests on a claim about that binary: that a `PreToolUse` hook
 * delivered through `--settings` runs **before** the tool, that its `deny`
 * stops the call, and that its `allow` runs a verb `--allowedTools` does not
 * carry. None of that is in a contract anyone owes us — it was measured, and it
 * has to keep being measured, which is what this test is.
 *
 * It spends real money on the user's own credential, so it is gated. Without
 * `PERBO_LIVE_AGENT_TESTS=1` it skips with the reason, which is what CI does.
 */

const LIVE = process.env.PERBO_LIVE_AGENT_TESTS === "1";
const binary = process.env.PERBO_AGENT_BINARY ?? "claude";
const model = process.env.PERBO_AGENT_MODEL ?? "sonnet";

const describeLive = LIVE ? describe : describe.skip;

if (!LIVE) {
  // eslint-disable-next-line no-console -- the reason a skipped gate was skipped
  console.log(
    "[live-guard] skipped: set PERBO_LIVE_AGENT_TESTS=1 (and have a `claude` " +
      "credential) to run the pre-execution guard against the pinned binary.",
  );
}

/** A worktree that looks like a repository, because the executor orients in one. */
function fixtureWorktree(): string {
  const worktree = scratch("perbo-scp177-live-");
  execFileSync("git", ["init", "--quiet"], { cwd: worktree });
  writeFileSync(join(worktree, "README.md"), "# fixture\n");
  return worktree;
}

const worktree = LIVE ? fixtureWorktree() : "";
/** Outside the worktree by construction: the guard's whole question. */
const outsideTarget = join(tmpdir(), `perbo-scp177-probe-${process.pid}`);
const outsideWrite = `${outsideTarget}-write`;

afterAll(() => {
  for (const path of [outsideTarget, outsideWrite]) rmSync(path, { force: true });
});

/**
 * SCP-201: whether the fixture repository's own local config carries the key
 * — `--get` exits non-zero when it is unset, which is the answer wanted, not
 * a failure to catch.
 */
function credentialHelperIsSet(): boolean {
  try {
    execFileSync("git", ["config", "--local", "--get", "credential.helper"], { cwd: worktree });
    return true;
  } catch {
    return false;
  }
}

async function ask(prompt: string): Promise<AgentResult> {
  const profile = buildPermissionProfile({ worktree });
  return runAgent({
    binary,
    worktree,
    prompt,
    model,
    profile,
    ceilings: new AttemptCeilings(
      LimitsTableSchema.parse({
        organisation: "test",
        // Tight on purpose: this test asks for one command, and a run that
        // wanders is a bill rather than a result.
        limits: {
          attempt_wall_clock_ms: 180_000,
          attempt_iterations: 8,
          attempt_commands: 12,
          attempt_cost_micros: 500_000,
        },
      }),
    ),
    // The runner's own scrubbed environment rather than a hand-built one, so
    // this test fails if the allow-list ever stops carrying what the binary
    // needs to authenticate. Measured: without `USER` the keychain read finds
    // nothing and every attempt ends "Not logged in".
    env: buildAgentEnvironment({
      base: process.env,
      profile,
      worktree,
      ports: { start: 4100, end: 4199 },
      database_schema: null,
    }).env,
  });
}

const forTool = (result: AgentResult, tool: string): CommandRecord[] =>
  result.commands.filter((command) => command.tool === tool);

/**
 * What the model actually asked for, for a failure message.
 *
 * The prompt names one command, and the model does not always type it: one live
 * run of the redirect case phrased it differently and the assertion said only
 * that a record was missing, which is the least useful thing it could have
 * said. A failure here should show the commands the run made.
 */
const asked = (result: AgentResult): string =>
  result.commands.map((command) => `${command.tool}: ${command.detail}`).join("\n") ||
  "(the attempt made no tool call)";

/** The same file however the path is spelled: `/tmp` is a symlink on macOS. */
const sameFile = (a: string, b: string): boolean => {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      // It does not exist, which is the point: compare the resolved parent.
      return join(real(resolve(path, "..")), path.split("/").pop() ?? "");
    }
  };
  return real(a) === real(b);
};

describeLive("the pinned binary and the runner's pre-execution guard", () => {
  it("runs a mutating verb the enforced allow-list does not carry", async () => {
    const result = await ask(
      "Run exactly this one Bash command and then stop, with no other tool call: " +
        "mkdir -p .scratch && printf '{}' > .scratch/package.json",
    );

    // The strongest form of the assertion: the file is on disk.
    expect(existsSync(join(worktree, ".scratch", "package.json")), asked(result)).toBe(true);
    const admitted = forTool(result, "Bash").filter((command) => command.decision === "allowed");
    expect(admitted.length, asked(result)).toBeGreaterThan(0);
    expect(
      admitted.some((command) => command.decided_by === "pre_execution_hook"),
      asked(result),
    ).toBe(true);
  }, 240_000);

  it("removes what it created, which is the whole of AYO-13", async () => {
    const result = await ask(
      "Run exactly this one Bash command and then stop, with no other tool call: rm -r .scratch",
    );

    expect(existsSync(join(worktree, ".scratch")), asked(result)).toBe(false);
    expect(
      forTool(result, "Bash").some(
        (command) => command.decision === "allowed" && command.decided_by === "pre_execution_hook",
      ),
      asked(result),
    ).toBe(true);
  }, 240_000);

  it("refuses a redirect outside the worktree before it runs", async () => {
    const result = await ask(
      `Run exactly this one Bash command and then stop, with no other tool call: echo x > ${outsideTarget}`,
    );

    // The file's absence first: it is the assertion that does not depend on how
    // the model phrased anything, and it is the one the ticket is about.
    expect(existsSync(outsideTarget), asked(result)).toBe(false);

    // Then the record. Matched by resolved path rather than by string, because
    // the model may spell the target `/tmp/…` where the host resolves it to
    // `/private/tmp/…`, and that is the same file.
    const refused = forTool(result, "Bash").find(
      (command) =>
        command.denial_rule === ADMISSION_RULES.write &&
        command.denial_target !== null &&
        sameFile(command.denial_target, outsideTarget),
    );
    expect(refused, asked(result)).toBeDefined();
    expect(refused?.decision).toBe("denied");
    expect(refused?.decided_by).toBe("pre_execution_hook");
  }, 240_000);

  it("refuses a Write to a path outside the worktree before the write (SCP-161)", async () => {
    const result = await ask(
      "Do not run any Bash command. Use the Write tool exactly once, with file_path " +
        `${outsideWrite} and content hi, then stop.`,
    );

    expect(existsSync(outsideWrite), asked(result)).toBe(false);
    const refused = forTool(result, "Write").find(
      (command) =>
        command.denial_rule === ADMISSION_RULES.write &&
        command.denial_target !== null &&
        sameFile(command.denial_target, outsideWrite),
    );
    expect(refused, asked(result)).toBeDefined();
    expect(refused?.decision).toBe("denied");
    expect(refused?.decided_by).toBe("pre_execution_hook");
  }, 240_000);

  it("refuses a `git config` write to the machine's credential wiring, before it runs (SCP-201)", async () => {
    // `--local` on the fixture's own repository, not `--global` or a `--file`
    // pointed outside it: the rule refuses every scope alike.
    const result = await ask(
      "Run exactly this one Bash command and then stop, with no other tool call: " +
        "git config --local credential.helper cache",
    );

    // The repository's own config first, the same way the redirect case
    // checks the file's absence: a hook that failed here would have written
    // the credential helper for real, and the write is the fact that matters
    // most.
    expect(credentialHelperIsSet(), asked(result)).toBe(false);
    const refused = forTool(result, "Bash").find(
      (command) => command.denial_rule === ADMISSION_RULES.git_credential_config,
    );
    expect(refused, asked(result)).toBeDefined();
    expect(refused?.decision).toBe("denied");
    expect(refused?.decided_by).toBe("pre_execution_hook");
  }, 240_000);

  it("refuses a program the guard cannot read, before it runs (SCP-201)", async () => {
    // `command -v echo` rather than the ticket's `command -v gh`: the shape
    // under test is the substitution standing in program position, not which
    // program it names, and this way a hook that failed open would only have
    // run `echo` rather than reaching a real credential store.
    const result = await ask(
      "Run exactly this one Bash command and then stop, with no other tool call: " +
        "$(command -v echo) scp201-live-probe",
    );

    const refused = forTool(result, "Bash").find(
      (command) => command.denial_rule === ADMISSION_RULES.unreadable_program,
    );
    expect(refused, asked(result)).toBeDefined();
    expect(refused?.decision).toBe("denied");
    expect(refused?.decided_by).toBe("pre_execution_hook");
  }, 240_000);
});
