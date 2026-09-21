import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LimitsTableSchema,
  type MaterializationManifest,
  type ReviewArtifact,
} from "@perbo/contracts";
import type { Model } from "@perbo/model";
import { runReview } from "@perbo/review";
import { branchName } from "@perbo/workspace";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "../src/adapter.js";
import { EgressLog } from "../src/egress.js";
import { TicketRunConfigSchema, runTicket } from "../src/loop/index.js";
import { makeAttempt, makeContract, withoutInstall } from "../src/test-support/records.js";
import { runnerRepository } from "../src/test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * Which commit's verification a check failure is attributed to.
 *
 * `caused_by_change` on a `check.*` finding is the answer to "did the base
 * already fail this", and the routing policy reads it: a check the change broke
 * goes back to the executor for one round, a check that was already failing
 * blocks. The runner's answer has to be about the contract's base commit, and
 * the provisioning verify only runs there on the attempt that creates the
 * branch — an attempt continuing a ticket provisions on the ticket's own sealed
 * head, where a verify failure is the ticket's earlier work and not the base.
 */

/** A command that fails exactly while the named file is in the worktree. */
const failsWhile = (path: string): string[] => [
  "node",
  "-e",
  `process.exit(require("node:fs").existsSync(${JSON.stringify(path)}) ? 1 : 0)`,
];

const BREAKS = "src/broken.ts";

/** A manifest that installs nothing and verifies with the check's own command. */
function manifestVerifying(repositoryRoot: string, command: string[]): MaterializationManifest {
  return { ...withoutInstall(repositoryRoot), verify: { command, timeout_ms: 30_000 } };
}

function makeConfig(repositoryRoot: string, manifest: MaterializationManifest, unit: string[]) {
  const root = scratch("perbo-base-verify-");
  return TicketRunConfigSchema.parse({
    materialization_manifest: manifest,
    ticket_key: "SCP094",
    repository_root: repositoryRoot,
    base_ref: "main",
    worktree_root: join(root, "worktrees"),
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
    checks: [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        command: unit,
        timeout_ms: 30_000,
      },
    ],
    agent_binary: "true",
    model: "double",
    max_remediation_rounds: 2,
    limits: LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4 },
    }),
  });
}

/**
 * An agent double that writes what the round is given and ends the way the
 * round is told to, so a run can be cut with its work sealed on the branch.
 */
const agentDouble = (
  rounds: ReadonlyArray<{
    write?: (worktree: string) => void;
    termination?: AgentResult["termination"];
  }>,
) => {
  let round = 0;
  const run = async (request: {
    worktree: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    const step = rounds[Math.min(round, rounds.length - 1)]!;
    round += 1;
    step.write?.(request.worktree);
    return {
      invocation: {
        adapter: "double",
        binary_path: "/bin/true",
        binary_version: "0.0.0",
        binary_sha256: "0".repeat(64),
        model: "double",
        credential_class: "subscription",
        argv: ["-p", "<prompt>"],
        shape_sha256: "1".repeat(64),
        neutralisation: {
          suppressed_at_invocation: ["double"],
          withheld_from_worktree: [],
          asserted_empty: ["mcp_servers"],
          reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
        },
      },
      commands: [],
      egress: new EgressLog(request.profile.network_allow_list),
      prohibited: [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        cost_micros: 1234,
        cost_basis: "transport_reported",
        cost_partial: false,
        iterations: 1,
      },
      termination: step.termination ?? { reason: "completed", detail: "" },
      final_message: null,
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
  return { run };
};

/** The one criterion `makeContract` carries, answered by the pinned check. */
const covers = {
  criterion_id: "ac_1",
  status: "met",
  verification_strength: "directly_verified",
  evidence_type: "test_result",
  evidence_ref: "check_unit",
  evidence_assertion: "total([1,2]) is 3",
  evidence_file: "src/feature.ts",
  evidence_line: 1,
  evidence_symbol: null,
  note: null,
  closure: "none",
};

/** A reviewer transport that submits one clean verdict every time it is asked. */
function cleanModel(): Model {
  return {
    provider: "double",
    model_id: "scripted",
    async turn() {
      return {
        toolCalls: [
          {
            id: "t1",
            name: "submit_review",
            input: {
              coverage: [covers],
              findings: [],
              check_assertions: [],
              overall_confidence: 0.9,
            },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: "tool_use",
      };
    },
  };
}

/** The deterministic finding the failing pinned check produces. */
const checkFinding = (review: ReviewArtifact | null | undefined) =>
  (review?.findings ?? []).find((one) => one.rule_id.startsWith("check."));

const closesEverything = async (input: Record<string, unknown>) => ({
  prompt_version: "closure_verify_v1",
  per_finding: (input.findings as Array<{ key: string }>).map((entry) => ({
    finding_key: entry.key,
    status: "closed" as const,
    pointer: "src/feature.ts",
  })),
  deterministic_failure: null,
  all_closed: true,
  open_keys: [],
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  cost_micros: 30,
  cost_basis: "provider_list_estimate" as const,
});

describe("a check failure on an attempt that continued a sealed commit", () => {
  it("is the change's, because the base — not the sealed head — is what was verified", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const manifest = manifestVerifying(repo.dir, failsWhile(BREAKS));
    const config = makeConfig(repo.dir, manifest, failsWhile(BREAKS));

    // Run one: the executor seals the commit that breaks the check, and the
    // host suspends the attempt before anything reviews it.
    const cut = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble([
          {
            write: (worktree) =>
              writeFileSync(join(worktree, BREAKS), "export const broken = true;\n"),
            termination: { reason: "host_suspended", detail: "the host was suspended" },
          },
        ]).run as never,
      },
    });
    expect(cut.outcome).toBe("terminated");
    expect(cut.rounds[0]?.attempt.head_commit).not.toBeNull();

    // Run two continues over that commit: its worktree starts on the sealed
    // head, where the manifest's verify fails for the ticket's own earlier
    // work — but the base is what the review is told about.
    const model = cleanModel();
    const second = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble([
          { write: (worktree) => writeFileSync(join(worktree, "src/feature.ts"), "export const total = 3;\n") },
          { write: (worktree) => rmSync(join(worktree, BREAKS), { force: true }) },
        ]).run as never,
        review: ((input: Parameters<typeof runReview>[0]) =>
          runReview({ ...input, model })) as never,
        verify: closesEverything as never,
      },
    });

    const finding = checkFinding(second.rounds[0]?.review);
    expect(finding, "the failing pinned check produced no finding").toBeDefined();
    expect(finding?.caused_by_change).toBe(true);
    expect(finding?.routing).toBe("remediable");
    expect(second.outcome).not.toBe("escalated");

    // The record says which commit the attribution rests on, and keeps the
    // attempt's own provisioning verify apart from it.
    const attempt = second.rounds[0]!.attempt;
    expect(attempt.base_verification).toEqual({ commit: repo.head, verified: true });
    expect(attempt.provisioning_verify?.commit).toBe(cut.rounds[0]?.attempt.head_commit);
    expect(attempt.provisioning_verify?.verified).toBe(false);
    // And the first run recorded the answer in the first place.
    expect(cut.rounds[0]?.attempt.base_verification).toEqual({
      commit: repo.head,
      verified: true,
    });
  }, 120_000);

  it("blocks when the base itself fails the verify", async () => {
    const repo = runnerRepository(scratch);
    // The base carries the file the verify and the check both refuse.
    writeFileSync(join(repo.dir, BREAKS), "export const broken = true;\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "a base that does not verify");
    const head = repo.git("rev-parse", "HEAD").trim();

    const contract = makeContract();
    contract.base.base_commit = head;
    const manifest = manifestVerifying(repo.dir, failsWhile(BREAKS));
    const config = makeConfig(repo.dir, manifest, failsWhile(BREAKS));
    const model = cleanModel();

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble([
          { write: (worktree) => writeFileSync(join(worktree, "src/feature.ts"), "export const total = 3;\n") },
        ]).run as never,
        review: ((input: Parameters<typeof runReview>[0]) =>
          runReview({ ...input, model })) as never,
        verify: closesEverything as never,
      },
    });

    const finding = checkFinding(result.rounds[0]?.review);
    expect(finding?.caused_by_change).toBe(false);
    expect(finding?.routing).toBe("blocks");
    expect(result.rounds[0]?.attempt.base_verification).toEqual({ commit: head, verified: false });
  }, 120_000);

  it("tells the review nothing while no run has measured the base", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const manifest = manifestVerifying(repo.dir, failsWhile(BREAKS));
    const config = makeConfig(repo.dir, manifest, failsWhile(BREAKS));

    // The ticket's branch already carries a commit that fails the verify, and
    // its record — written before the field existed — says nothing about the
    // base. This run provisions on that commit, so it cannot measure the base
    // either.
    const branch = branchName({
      ticket_key: "SCP094",
      ticket_id: contract.ticket_id,
      outcome: contract.outcome,
    });
    repo.git("checkout", "-q", "-b", branch);
    writeFileSync(join(repo.dir, BREAKS), "export const broken = true;\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "sealed by a run this record predates");
    repo.git("checkout", "-q", "main");

    // Written as a record from before the fields existed: the two keys are
    // absent, not null, which is what a reader has to cope with.
    const { base_verification, provisioning_verify, ...older } = makeAttempt({
      attempt_id: "att_00000000000000ff",
      ticket_id: contract.ticket_id,
      head_commit: repo.git("rev-parse", branch).trim(),
      branch,
    });
    void base_verification;
    void provisioning_verify;
    mkdirSync(config.state_root, { recursive: true });
    writeFileSync(
      join(config.state_root, `${contract.ticket_id}.attempts.json`),
      `${JSON.stringify({ ticket_id: contract.ticket_id, attempts: [older] }, null, 2)}\n`,
    );

    const model = cleanModel();
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble([
          { write: (worktree) => writeFileSync(join(worktree, "src/feature.ts"), "export const total = 3;\n") },
        ]).run as never,
        review: ((input: Parameters<typeof runReview>[0]) =>
          runReview({ ...input, model })) as never,
        verify: closesEverything as never,
      },
    });

    const finding = checkFinding(result.rounds[0]?.review);
    expect(finding, "the failing pinned check produced no finding").toBeDefined();
    expect(finding?.caused_by_change).toBeNull();
    expect(result.rounds[0]?.attempt.base_verification).toBeNull();
    expect(result.rounds[0]?.attempt.provisioning_verify?.verified).toBe(false);
  }, 120_000);

  it("tells the review nothing where the verify measures nothing, whatever the record says", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    // `git status --porcelain` passes on any checkout Git can read, and the
    // pinned check fails on the base and on the change alike.
    const manifest = manifestVerifying(repo.dir, ["git", "status", "--porcelain"]);
    const config = makeConfig(repo.dir, manifest, ["node", "-e", "process.exit(1)"]);

    // The ticket's record answers "verified" for this very base, from an
    // attempt whose verify was the same command.
    const branch = branchName({
      ticket_key: "SCP094",
      ticket_id: contract.ticket_id,
      outcome: contract.outcome,
    });
    repo.git("branch", branch);
    const recorded = {
      ...makeAttempt({
        attempt_id: "att_00000000000000fe",
        ticket_id: contract.ticket_id,
        head_commit: repo.head,
        branch,
      }),
      base_verification: { commit: repo.head, verified: true },
    };
    mkdirSync(config.state_root, { recursive: true });
    writeFileSync(
      join(config.state_root, `${contract.ticket_id}.attempts.json`),
      `${JSON.stringify({ ticket_id: contract.ticket_id, attempts: [recorded] }, null, 2)}\n`,
    );

    const model = cleanModel();
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble([
          { write: (worktree) => writeFileSync(join(worktree, "src/feature.ts"), "export const total = 3;\n") },
        ]).run as never,
        review: ((input: Parameters<typeof runReview>[0]) =>
          runReview({ ...input, model })) as never,
        verify: closesEverything as never,
      },
    });

    // Neither the base nor the change is blamed, and nothing is recorded that
    // a later attempt would read back as a measurement.
    const finding = checkFinding(result.rounds[0]?.review);
    expect(finding, "the failing pinned check produced no finding").toBeDefined();
    expect(finding?.caused_by_change).toBeNull();
    expect(result.rounds[0]?.attempt.base_verification).toBeNull();
    expect(result.rounds[0]?.attempt.provisioning_verify).toBeNull();
  }, 120_000);
});
