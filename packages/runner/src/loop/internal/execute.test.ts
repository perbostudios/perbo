import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretIndex, type PermissionProfile } from "@perbo/contracts";
import type { MaterializedWorkspace } from "@perbo/workspace";
import { AgentConfigurationPresentError } from "../../adapter.js";
import { buildPermissionProfile } from "../../profile.js";
import { TicketRunConfigSchema } from "./config.js";
import type { LoopPorts } from "./context.js";
import { execute } from "./execute.js";
import { agentResult, roundState, workspace } from "./test-support/fakes.js";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A worktree carrying the one thing the quarantine exists to move. */
function worktreeWithConfiguration(): string {
  const dir = scratchDir("perbo-execute-worktree-");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "settings.json"), '{"hooks":{}}');
  return dir;
}

function run(agent: LoopPorts["agent"], worktreePath: string, quarantineRoot: string) {
  const profile: PermissionProfile = buildPermissionProfile({ worktree: worktreePath });
  const config = TicketRunConfigSchema.parse({
    ticket_key: "AYO-1",
    repository_root: worktreePath,
    worktree_root: join(quarantineRoot, "worktrees"),
    bundle_root: join(quarantineRoot, "bundles"),
    quarantine_root: quarantineRoot,
    state_root: join(quarantineRoot, "state"),
  });
  return execute({
    config,
    state: roundState({ workspace: workspace({ path: worktreePath }) }),
    brief: {
      inherited: [],
      prior_commits: [],
      toClose: [],
      resumedHere: null,
      resumeOutcome: null,
      pathsAllowed: ["src/**"],
      pathsProhibited: [],
      prompt: "do the ticket",
      executorSkills: [],
      briefRecords: {
        outcome: "the feature works",
        acceptance_criteria: [],
        nodes: [],
        paths_allowed: ["src/**"],
        paths_prohibited: [],
        no_gos: [],
        principles: null,
        checks: [],
        open_findings: [],
      },
    },
    attemptId: "att_0000000000000001",
    at: new Date("2026-08-27T00:00:00.000Z"),
    profile,
    materialized: { ports: { start: 41000, end: 41000 }, database_schema: null } as MaterializedWorkspace,
    secrets: new SecretIndex(),
    agent,
    progress: () => undefined,
  });
}

describe("a repository whose agent configuration the runner could not move", () => {
  it("stops the run with what the adapter refused over, and leaves no journal behind", async () => {
    const worktreePath = worktreeWithConfiguration();
    const quarantineRoot = scratchDir("perbo-execute-store-");

    const step = await run(
      () => {
        throw new AgentConfigurationPresentError("the worktree still carries .claude/settings.json", {
          mcp_servers: [],
          plugins: [],
          skills: [],
          subagents: [],
          memory_paths: [],
        });
      },
      worktreePath,
      quarantineRoot,
    );

    expect(step).toEqual({
      next: "stop",
      end: { outcome: "terminated", detail: "the worktree still carries .claude/settings.json" },
    });
    // The configuration is back where the person left it, and the store the
    // journal was written to is gone with it.
    expect(existsSync(join(worktreePath, ".claude", "settings.json"))).toBe(true);
    expect(readdirSync(quarantineRoot)).toEqual([]);
  });
});

describe("what the attempt's record says was withheld", () => {
  it("is what the quarantine moved out of the worktree", async () => {
    const worktreePath = worktreeWithConfiguration();
    const quarantineRoot = scratchDir("perbo-execute-store-");
    let sawConfiguration = true;

    const executed = await run(
      async () => {
        sawConfiguration = existsSync(join(worktreePath, ".claude"));
        return agentResult();
      },
      worktreePath,
      quarantineRoot,
    );

    expect(sawConfiguration).toBe(false);
    expect("executed" in executed && executed.executed.result.invocation.neutralisation.withheld_from_worktree).toEqual([
      ".claude",
    ]);
    expect(existsSync(join(worktreePath, ".claude", "settings.json"))).toBe(true);
    expect(readdirSync(quarantineRoot)).toEqual([]);
  });
});
