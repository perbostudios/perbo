import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { ADMISSION_RULES } from "../src/admission.js";
import { runAgent } from "../src/adapter.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { buildPermissionProfile } from "../src/profile.js";
import { fakeAgent } from "../src/test-support/fake-agent.js";
import { scratch } from "./support.js";

/**
 * SCP-177, at the seam: what the hook decided is what the record says, and what
 * the record says did not happen did not happen.
 *
 * The binary here obeys the hook the adapter installed — it runs it before each
 * call, refuses the call when the answer is `deny` and performs it when the
 * answer is `allow` — which is the behaviour the pinned binary was measured
 * showing. So the assertions are about files on disk as well as about rows.
 */

const outside = join(tmpdir(), `perbo-scp177-record-${process.pid}`);

const run = async (
  calls: ReadonlyArray<{ tool: string; input: Record<string, unknown> }>,
  extra: { reported_denials?: readonly string[]; hookProgram?: readonly string[] } = {},
) => {
  const worktree = scratch("perbo-scp177-record-");
  const agent = fakeAgent(scratch, [
    {
      kind: "guarded",
      calls,
      ...(extra.reported_denials ? { reported_denials: extra.reported_denials } : {}),
    },
  ]);
  const result = await runAgent({
    binary: agent.binary,
    worktree,
    prompt: "do the thing",
    model: "none",
    profile: buildPermissionProfile({ worktree }),
    ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    ...(extra.hookProgram ? { hookProgram: extra.hookProgram } : {}),
  });
  return { result, worktree };
};

describe("a call the guard refused", () => {
  it("does not run, and the record names the rule and the target", async () => {
    const { result } = await run([
      { tool: "Bash", input: { command: `echo x > ${outside}` } },
    ]);

    expect(existsSync(outside)).toBe(false);
    const [command] = result.commands;
    expect(command?.decision).toBe("denied");
    expect(command?.denial_rule).toBe(ADMISSION_RULES.write);
    expect(command?.denial_target).toBe(outside);
    // Distinct from the agent's own allow-list refusal, which is what SCP-163
    // asked the record to be able to tell apart.
    expect(command?.decided_by).toBe("pre_execution_hook");
    // And one row, not two, though the refusal is reported a second time in the
    // result envelope.
    expect(result.commands).toHaveLength(1);
  }, 60_000);

  it("does not write, when the call was a file tool outside the root", async () => {
    const target = `${outside}-write`;
    const { result } = await run([
      { tool: "Write", input: { file_path: target, content: "hi" } },
    ]);

    expect(existsSync(target)).toBe(false);
    expect(result.commands[0]?.decision).toBe("denied");
    expect(result.commands[0]?.denial_rule).toBe(ADMISSION_RULES.write);
    expect(result.commands[0]?.decided_by).toBe("pre_execution_hook");
  }, 60_000);
});

describe("a call the guard admitted", () => {
  it("runs a mutating verb the enforced allow-list does not carry", async () => {
    const { result, worktree } = await run([
      {
        tool: "Bash",
        input: { command: "mkdir -p .scratch && printf '{}' > .scratch/package.json" },
      },
    ]);

    expect(existsSync(join(worktree, ".scratch", "package.json"))).toBe(true);
    expect(result.commands[0]?.decision).toBe("allowed");
    expect(result.commands[0]?.decided_by).toBe("pre_execution_hook");
  }, 60_000);

  it("removes what it created, which is the whole of AYO-13", async () => {
    const { result, worktree } = await run([
      { tool: "Bash", input: { command: "mkdir -p .scratch && touch .scratch/x" } },
      { tool: "Bash", input: { command: "rm -r .scratch" } },
    ]);

    expect(existsSync(join(worktree, ".scratch"))).toBe(false);
    expect(result.commands.map((command) => command.decision)).toEqual(["allowed", "allowed"]);
  }, 60_000);
});

describe("a refusal the agent's own layer made", () => {
  it("is recorded as that layer's, not as the guard's", async () => {
    // The hook never saw this one: the agent reports it in the result envelope
    // and nowhere else, which is what the outer `--allowedTools` list produces.
    const { result } = await run([], { reported_denials: ["curl https://example.com"] });

    const [command] = result.commands;
    expect(command?.decision).toBe("denied");
    expect(command?.decided_by).toBe("agent_permission_layer");
  }, 60_000);
});

describe("the runner's two readings of one call", () => {
  it("records the disagreement, keeping the decision that was enforced", async () => {
    // A hook that admits everything, so the enforced answer and the reading
    // after the fact differ on a write the resolver puts outside the worktree.
    // The record has to say which one happened — the call ran — and that the
    // other reading refused it.
    const stubDir = mkdtempSync(join(tmpdir(), "perbo-scp177-stub-"));
    const stub = join(stubDir, "always-allow.cjs");
    writeFileSync(
      stub,
      `const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const directory = process.argv[2];
const call = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(
  join(directory, "decisions.jsonl"),
  JSON.stringify({
    tool_use_id: call.tool_use_id,
    tool: call.tool_name,
    decision: "allowed",
    rule: null,
    target: null,
    reason: null,
    cwd: ".",
    at: new Date().toISOString(),
  }) + "\\n",
);
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "the stub admits everything",
    },
  }),
);
`,
      "utf8",
    );

    const target = `${outside}-disagree`;
    const { result } = await run([{ tool: "Bash", input: { command: `echo x > ${target}` } }], {
      hookProgram: [process.execPath, stub],
    });

    // The record says what happened — the enforced answer admitted it — and
    // keeps the other reading beside it.
    const [command] = result.commands;
    expect(command?.decision).toBe("allowed");
    expect(command?.decided_by).toBe("pre_execution_hook");
    expect(command?.second_reading).toContain(ADMISSION_RULES.write);
    expect(command?.second_reading).toContain(target);
    // And the second reading is still a control: it raises the prohibited
    // action and the attempt is terminated on it, which is what stands between
    // a guard that stopped working and a write nobody notices.
    expect(result.termination.reason).toBe("prohibited_action");
    expect(result.prohibited.map((hit) => hit.action)).toContain("write_outside_worktree");
  }, 60_000);
});
