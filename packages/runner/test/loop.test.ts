import { execFileSync, spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LimitsTableSchema,
  PlanContractSchema,
  SecretIndex,
  type MaterializationManifest,
  type PlanContract,
} from "@perbo/contracts";
import type { Model } from "@perbo/model";
import { runReview } from "@perbo/review";
import { branchName } from "@perbo/workspace";
import type { AgentResult } from "../src/adapter.js";
import { EgressLog } from "../src/egress.js";
import { BundleStore } from "../src/bundle.js";
import { RunLockedError, acquireRunLock } from "../src/lock.js";
import { TicketRunConfigSchema, runTicket } from "../src/loop.js";
import { TRANSPORT_RETRY_DELAY_MS } from "../src/transport.js";
import { fakeAgent } from "../src/test-support/fake-agent.js";
import {
  finding,
  makeAttempt,
  makeContract,
  makeReview,
  withoutInstall,
} from "../src/test-support/records.js";
import { git, makeRepo, scratch } from "./support.js";

/**
 * The loop, with the agent and the reviewer replaced by doubles.
 *
 * Everything between them is real: the worktree, the materialization, the
 * commit, the seal, the bundles and the cleanup. What the doubles let this test
 * do is drive the one path that costs money and is the point of Stage 2 — a
 * finding that goes back to the executor and a second review that grades the
 * answer without being told it is one.
 */

const agentDouble = (write: (worktree: string, round: number) => void) => {
  let round = 0;
  const calls: string[] = [];
  const run = async (request: {
    worktree: string;
    prompt: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    calls.push(request.prompt);
    write(request.worktree, round);
    round += 1;
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
      termination: { reason: "completed", detail: "" },
      final_message: null,
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
  return { run, calls };
};

/** The key every run in this file is started under, unless a test says otherwise. */
const TICKET_KEY = "SCP094";

function makeConfig(
  repositoryRoot: string,
  manifest?: MaterializationManifest,
  unitCommand: string[] = ["node", "-e", "process.exit(0)"],
) {
  const root = scratch("perbo-loop-");
  return TicketRunConfigSchema.parse({
    ...(manifest ? { materialization_manifest: manifest } : {}),
    ticket_key: TICKET_KEY,
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
        command: unitCommand,
        timeout_ms: 30_000,
      },
    ],
    agent_binary: "true",
    model: "double",
    max_remediation_rounds: 2,
    limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
  });
}

describe("the loop closes", () => {
  it("routes a finding to the executor, re-seals, and grades the answer independently", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    config.executor_skills = ["codebase-design"];

    const agent = agentDouble((worktree, round) => {
      if (round === 0) {
        mkdirSync(join(worktree, "src"), { recursive: true });
        writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
      } else {
        mkdirSync(join(worktree, "test"), { recursive: true });
        writeFileSync(join(worktree, "test", "feature.test.ts"), "// exercises total()\n");
      }
    });

    const reviewInputs: Array<Record<string, unknown>> = [];
    const verifyInputs: Array<Record<string, unknown>> = [];

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async (input: Record<string, unknown>) => {
          reviewInputs.push(input);
          return {
            artifact: makeReview({
              review_id: "rev_0000000000000001",
              decision: "remediable",
              findings: [finding()],
            }),
            bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
          };
        }) as never,
        verify: (async (input: Record<string, unknown>) => {
          verifyInputs.push(input);
          const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
          return {
            prompt_version: "closure_verify_v1",
            per_finding: keys.map((finding_key) => ({ finding_key, status: "closed", pointer: "test/feature.test.ts" })),
            deterministic_failure: null,
            all_closed: true,
            open_keys: [],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 30,
            cost_basis: "provider_list_estimate",
          };
        }) as never,
      },
    });

    expect(result.outcome).toBe("approved");
    expect(result.rounds).toHaveLength(2);

    // D-061: exactly one independent review — round 1 verifies, it does not re-judge.
    expect(reviewInputs).toHaveLength(1);
    expect(verifyInputs).toHaveLength(1);
    for (const prompt of agent.calls) expect(prompt).toContain("# Codebase Design");
    for (const input of [...reviewInputs, ...verifyInputs]) {
      expect(JSON.stringify(input)).not.toContain("# Codebase Design");
      expect(input).not.toHaveProperty("executor_skills");
    }
    for (const round of result.rounds) expect(round.attempt.executor_skills[0]?.id).toBe("codebase-design");

    // A remediation round is a new attempt, not a repair.
    const [first, second] = result.rounds;
    expect(second?.attempt.remediation_round).toBe(1);
    expect(second?.attempt.continues_attempt_id).toBe(first?.attempt.attempt_id);
    expect(second?.attempt.attempt_id).not.toBe(first?.attempt.attempt_id);
    expect(second?.attempt.root_attempt_id).toBe(first?.attempt.root_attempt_id);
    // Re-sealed: a different head, so any verdict against the first pair is superseded.
    expect(second?.attempt.head_commit).not.toBe(first?.attempt.head_commit);

    // The remediation brief carries the finding, and the verifier is handed the
    // finding it must check — dependence is the design here, per D-061.
    expect(agent.calls[1]).toContain("remediation round 1 of at most 2");
    expect(agent.calls[1]).toContain("No test exercises total()");
    expect(JSON.stringify(verifyInputs[0])).toContain("No test exercises total()");

    // The verification round produces no review artifact; the gate-opening
    // judgement stays with round 0's independent review.
    expect(second?.review).toBeNull();
    expect(second?.verification?.all_closed).toBe(true);
    expect(result.final_review?.review_id).toBe("rev_0000000000000001");
  }, 60_000);

  it("carries a decline end to end: parsed from the transcript, skipped by the verifier, escalated to a person", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const fixedKey = "f".repeat(64);
    const declinedKey = "e".repeat(64);
    const declineText = `NO_PRACTICE ${declinedKey}: whether archived rows belong in exports is a product call`;

    let agentRound = 0;
    const agent = async (request: { worktree: string; profile: { network_allow_list: readonly string[] } }): Promise<AgentResult> => {
      const round = agentRound++;
      if (round === 0) {
        mkdirSync(join(request.worktree, "src"), { recursive: true });
        writeFileSync(join(request.worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
      } else {
        mkdirSync(join(request.worktree, "test"), { recursive: true });
        writeFileSync(join(request.worktree, "test", "feature.test.ts"), "// exercises total()\n");
      }
      return {
        invocation: {
          adapter: "double", binary_path: "/bin/true", binary_version: "0.0.0",
          binary_sha256: "0".repeat(64), model: "double", credential_class: "subscription",
          argv: ["-p", "<prompt>"], shape_sha256: "1".repeat(64),
          neutralisation: {
            suppressed_at_invocation: ["double"], withheld_from_worktree: [], asserted_empty: ["mcp_servers"],
            reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
          },
        },
        commands: [], egress: new EgressLog(request.profile.network_allow_list), prohibited: [],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          output_tokens: 5,
          cost_micros: 1234,
          cost_basis: "transport_reported",
          cost_partial: false,
          iterations: 1,
        },
        termination: { reason: "completed", detail: "" },
        final_message: null,
        // The transcript as the adapter records it: stream-json event lines.
        transcript:
          round === 0
            ? ['{"type":"result","subtype":"success"}']
            : [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Fixing one.\n${declineText}` }] } })],
      };
    };

    const verifyInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000002",
            decision: "remediable",
            findings: [finding(), finding({ key: declinedKey, rule_id: "behaviour.incidental_change", statement: "Exports now include archived rows." })],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        verify: (async (input: Record<string, unknown>) => {
          verifyInputs.push(input);
          const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
          return {
            prompt_version: "closure_verify_v2",
            per_finding: keys.map((finding_key) => ({ finding_key, status: "closed", pointer: "test/feature.test.ts", idiomatic: "established_pattern", practice: "" })),
            deterministic_failure: null,
            all_closed: true,
            open_keys: [],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 30,
            cost_basis: "provider_list_estimate",
          };
        }) as never,
      },
    });

    // The declined finding never reached the verifier; the fixed one did.
    expect((verifyInputs[0]?.findings as Array<{ key: string }>).map((entry) => entry.key)).toEqual([fixedKey]);
    // The decline is on the round record with its reason, and the run ends with
    // a person deciding — not approved, not exhausted.
    expect(result.rounds[1]?.declines).toEqual([
      { finding_key: declinedKey, reason: "whether archived rows belong in exports is a product call" },
    ]);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("no-determinable-practice");
  }, 60_000);

  it("bounds the rounds and hands it to a human rather than looping", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir),
      max_remediation_rounds: 1,
    });

    const agent = agentDouble((worktree, round) => {
      writeFileSync(join(worktree, `src/round-${round}.ts`), `export const round = ${round};\n`);
    });
    const availability: unknown[] = [];
    let verifications = 0;

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async (input: Record<string, unknown>) => ({
          artifact: makeReview({
            review_id: `rev_000000000000000${availability.push(input.remediationAvailable)}`,
            decision: "remediable",
            findings: [finding()],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        verify: (async (input: Record<string, unknown>) => {
          verifications += 1;
          const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
          return {
            prompt_version: "closure_verify_v1",
            per_finding: keys.map((finding_key) => ({ finding_key, status: "not_closed", pointer: "" })),
            deterministic_failure: null,
            all_closed: false,
            open_keys: keys,
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 30,
            cost_basis: "provider_list_estimate",
          };
        }) as never,
      },
    });

    expect(result.rounds).toHaveLength(2);
    // One independent review, one verification — and with the round having
    // closed nothing, a person sees it rather than the loop asking again.
    expect(availability).toEqual([true]);
    expect(verifications).toBe(1);
    // SCP-194: the round closed none of what it was given, which is a stall
    // and not a budget that ran out. Both hand it to a person; they say
    // different things about why.
    expect(result.outcome).toBe("remediation_stalled");
  }, 60_000);

  it("a check regression during remediation is changes_requested, not a fresh review", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir),
      max_remediation_rounds: 2,
    });

    const agent = agentDouble((worktree, round) => {
      writeFileSync(join(worktree, `src/round-${round}.ts`), `export const round = ${round};
`);
    });

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "remediable",
            findings: [finding()],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        verify: (async (input: Record<string, unknown>) => {
          const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
          return {
            prompt_version: "closure_verify_v1",
            per_finding: keys.map((finding_key) => ({ finding_key, status: "cannot_tell", pointer: "" })),
            deterministic_failure: "check_ut is failed: the fixed tree does not pass the pinned checks",
            all_closed: false,
            open_keys: keys,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 0,
            cost_basis: "not_incurred",
          };
        }) as never,
      },
    });

    expect(result.outcome).toBe("changes_requested");
    expect(result.detail).toContain("pinned checks");
  }, 60_000);

  /**
   * d069 (SCP-276): a round given the failing pinned check that leaves it
   * failing was the once, and the stop says so; a scope escape after the same
   * round is a regression and keeps its name. The verifier's own gate is the
   * arbiter — the review hook here routes the check finding and nothing else.
   */
  const stopAfterRoutedCheck = async (
    kind: "check" | "scope",
    failure: string,
  ): Promise<{ outcome: string; detail: string | null }> => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir),
      max_remediation_rounds: 2,
    });
    const agent = agentDouble((worktree, round) => {
      writeFileSync(join(worktree, `src/round-${round}.ts`), `export const round = ${round};
`);
    });
    const routedCheck = finding({
      rule_id: "check.unit",
      source: "deterministic",
      row: "deterministic",
      closure: null,
      severity: "blocker",
      file: null,
      line: null,
      symbol: "unit",
      statement: "The unit check failed (exited 1).",
      routing: "remediable",
      blocking: false,
      caused_by_change: true,
    });
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "remediable",
            findings: [routedCheck],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        verify: (async (input: Record<string, unknown>) => {
          const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
          return {
            prompt_version: "closure_verify_v1",
            per_finding: keys.map((finding_key) => ({ finding_key, status: "cannot_tell", pointer: "" })),
            deterministic_failure: failure,
            deterministic_failure_kind: kind,
            all_closed: false,
            open_keys: keys,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 0,
            cost_basis: "not_incurred",
          };
        }) as never,
      },
    });
    return { outcome: result.outcome, detail: result.detail };
  };

  it("a routed check still failing after its round stops as the checks failing, not as a regression", async () => {
    const result = await stopAfterRoutedCheck(
      "check",
      "check_ut is failed: the fixed tree does not pass the pinned checks",
    );
    expect(result.outcome).toBe("changes_requested");
    expect(result.detail).toMatch(/^the pinned checks still fail after remediation round 1: check_ut is failed/);
  }, 60_000);

  it("a scope escape after a routed check's round is a regression and says so", async () => {
    const result = await stopAfterRoutedCheck("scope", "scope: src/other.ts is outside the admitted paths");
    expect(result.outcome).toBe("changes_requested");
    expect(result.detail).toMatch(/^the fix regressed: scope: /);
  }, 60_000);

  it("does not hand an injected-instruction finding back to the executor", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "remediable",
            findings: [
              finding({
                rule_id: "context.injected_instruction",
                statement: "A test log instructs the reviewer to approve.",
              }),
            ],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
      },
    });

    // Quoting attacker-authored text into an executor brief is the laundering
    // path the trust tiers exist to prevent, so this class escalates instead.
    expect(result.outcome).toBe("escalated");
    expect(agent.calls).toHaveLength(1);
  }, 60_000);
});

describe("the record", () => {
  it("writes a bundle for every attempt and every review, and never rewrites one", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });
    await runTicket({
      config,
      contract,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "approve",
            coverage: [
              { criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" },
            ],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
      },
    });

    const store = new BundleStore({ root: config.bundle_root, retainContext: true });
    const written = store.forTicket(contract.ticket_id);
    expect(written.map((bundle) => bundle.kind).sort()).toEqual(["execution", "review"]);

    const execution = written.find((bundle) => bundle.kind === "execution")!;
    expect(execution.artifacts.map((artifact) => artifact.name)).toContain("transcript.jsonl");
    expect(execution.artifacts.map((artifact) => artifact.name)).toContain("change.diff");
    expect(execution.replayability).toBe("re_executable");
    expect(store.readObject(execution.artifacts[0]!.sha256)).not.toBeNull();

    // Attempts are appended to a file that a retry does not overwrite.
    const attemptsFile = join(config.state_root, `${contract.ticket_id}.attempts.json`);
    expect(existsSync(attemptsFile)).toBe(true);
    const attempts = JSON.parse(readFileSync(attemptsFile, "utf8")) as { attempts: unknown[] };
    expect(attempts.attempts).toHaveLength(1);
  }, 60_000);

  /**
   * The join key a review bundle records is the reviewer's own target, and the
   * loop copies it rather than restating it.
   *
   * A regression pin, not a test of new behaviour: this is what the loop did
   * before SCP-180 and what it must go on doing after it. `inputs.changeset_id`
   * is what every reader joins a review to its attempt by — `perbo inspect`
   * among them — and a run reached this file having changed it to the change
   * set the runner sealed, which is the same value in every run a real reviewer
   * makes and a different one only where the reviewer states a target of its
   * own. Nothing in SCP-180 asked for that, so it is pinned here instead.
   *
   * The double states a target no seal produced, which is the only condition
   * that tells the two rules apart: the assertion below is the reviewer's
   * string, and the attempt's own change set is asserted to differ from it so
   * that a loop reaching for the seal fails rather than coincidentally passing.
   *
   * What this pins is where the value comes from, not that the value is right.
   * A reviewer that mis-states its target orphans its review from the attempt
   * in `inspect`, which joins on this key — a question about the reviewer's
   * contract, and not one an unrequested change here was the place to answer.
   */
  it("records the reviewer's own target as the review bundle's change set", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    /** A target no seal in this run produced, so the two rules cannot agree. */
    const stated = "cs_reviewerstated1";
    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });
    const result = await runTicket({
      config,
      contract,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000002",
            decision: "approve",
            coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
            changeset_id: stated,
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
      },
    });

    const sealed = result.rounds[0]!.attempt.changeset_id;
    expect(sealed).not.toBeNull();
    expect(sealed).not.toBe(stated);

    const review = new BundleStore({ root: config.bundle_root, retainContext: true })
      .forTicket(contract.ticket_id)
      .find((bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"));
    expect(review).toBeDefined();
    expect(review!.inputs["changeset_id"]).toBe(stated);
  }, 60_000);

  it("degrades the replay claim honestly when the bytes were not kept", () => {
    const root = scratch("perbo-bundle-");
    const store = new BundleStore({ root, retainContext: false });
    const { bundle } = store.write({
      kind: "execution",
      subject_id: "att_x",
      ticket_id: "ticket_x",
      inputs: {},
      context_manifest: [],
      versions: { code: "c", prompt: "p", policy: "pol", model: "m", tool: "t" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cost_micros: 0,
        cost_basis: "not_incurred",
        wall_clock_ms: 0,
      },
      artifacts: [{ name: "a.txt", media_type: "text/plain", body: "hello" }],
      errors: [],
      transitions: [],
      retention: { class: "raw_transcript", expires_at: null },
      secrets: new SecretIndex(),
      excluded_paths: [],
      deterministic: false,
      model_version_pinned: true,
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    expect(bundle.replayability).toBe("forensic");
    expect(bundle.artifacts[0]?.retained).toBe(false);
    expect(store.readObject(bundle.artifacts[0]!.sha256)).toBeNull();
  });
});

describe("actual_risk exceeding planned_risk", () => {
  it("escalates the attempt rather than discarding it", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          // A P1 plan whose sealed diff derived P2, reviewed under the stronger
          // policy and escalated. The attempt still exists and is still recorded.
          artifact: {
            ...makeReview({ review_id: "rev_0000000000000001", decision: "escalate" }),
            planned_risk: "P1" as const,
            actual_risk: "P2" as const,
            escalated: true,
          },
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
      },
    });

    expect(result.outcome).toBe("escalated");
    expect(result.rounds).toHaveLength(1);
    // Not discarded: the attempt has a change set, a head commit and a record.
    expect(result.rounds[0]?.attempt.changeset_id).not.toBeNull();
    expect(result.rounds[0]?.attempt.head_commit).not.toBeNull();
    expect(result.rounds[0]?.attempt.termination.reason).toBe("completed");
    expect(result.final_review?.escalated).toBe(true);
    expect(result.final_review?.planned_risk).toBe("P1");
    expect(result.final_review?.actual_risk).toBe("P2");

    // And the branch survives cleanup, so the work is recoverable.
    const branches = execFileSync("git", ["branch", "--list", result.workspace.branch], {
      cwd: repo.dir,
      encoding: "utf8",
    });
    expect(branches).toContain(result.workspace.branch);
  }, 60_000);

  it("appends a retry rather than overwriting its predecessor", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const agent = agentDouble((worktree, round) => {
      writeFileSync(join(worktree, `src/round-${round}.ts`), `export const r = ${round};\n`);
    });
    const reviews = [
      makeReview({ review_id: "rev_0000000000000001", decision: "remediable", findings: [finding()] }),
      makeReview({
        review_id: "rev_0000000000000002",
        decision: "approve",
        coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
      }),
    ];
    let call = 0;

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: reviews[call++]!,
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        // Round 1 verifies rather than re-reviews (D-061), and the verifier
        // this loop reaches for by default is a model call over the configured
        // reviewer transport. This case is about what the attempts record
        // holds, so the verdict is a fixture: closing every finding fixes the
        // run at the two rounds the record is then asserted on.
        verify: (async (input: Record<string, unknown>) => ({
          prompt_version: "closure_verify_v1",
          per_finding: (input.findings as Array<{ key: string }>).map((entry) => ({
            finding_key: entry.key,
            status: "closed",
            pointer: "src/round-1.ts",
          })),
          deterministic_failure: null,
          all_closed: true,
          open_keys: [],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          cost_micros: 30,
          cost_basis: "provider_list_estimate",
        })) as never,
      },
    });

    const attempts = JSON.parse(
      readFileSync(join(config.state_root, `${contract.ticket_id}.attempts.json`), "utf8"),
    ) as { attempts: Array<{ attempt_id: string; head_commit: string }> };
    expect(attempts.attempts).toHaveLength(2);
    expect(attempts.attempts[0]!.attempt_id).not.toBe(attempts.attempts[1]!.attempt_id);
    expect(attempts.attempts[0]!.head_commit).not.toBe(attempts.attempts[1]!.head_commit);
    // Both attempts' commits are reachable from the branch: the first is the
    // second's parent, not something the second replaced.
    const log = execFileSync("git", ["log", "--format=%H", result.workspace.branch], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim().split("\n");
    expect(log).toContain(attempts.attempts[0]!.head_commit);
    expect(log).toContain(attempts.attempts[1]!.head_commit);
  }, 60_000);
});

/**
 * The one criterion `makeContract` carries, answered by an assertion a passing
 * check establishes — so an accepted verdict here approves rather than routing
 * a verification finding into a remediation round.
 */
const covers = (criterion_id: string) => ({
  criterion_id,
  status: "met",
  coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
  evidence_type: "test_result",
  evidence_ref: "check_unit",
  evidence_assertion: "expect(thing).toBe(1)",
  evidence_file: "src/thing.ts",
  evidence_line: 1,
  evidence_symbol: null,
  note: null,
  closure: "none",
});

const verdict = (coverage: unknown[]) => ({
  coverage,
  findings: [],
  check_assertions: [],
  overall_confidence: 0.9,
});

/**
 * A reviewer transport that submits the verdicts it was given, in order, and
 * repeats the last one when it is asked again. Every request it saw is kept, so
 * a test can say how many turns the reviewer took and what the retry told it.
 */
function verdictModel(verdicts: unknown[]): {
  model: Model;
  requests: Array<{ messages: unknown }>;
} {
  const requests: Array<{ messages: unknown }> = [];
  const model: Model = {
    provider: "double",
    model_id: "scripted",
    async turn(request) {
      const index = requests.length;
      requests.push({ messages: request.messages });
      return {
        toolCalls: [
          {
            id: `t${index + 1}`,
            name: "submit_review",
            input: verdicts[Math.min(index, verdicts.length - 1)],
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
  return { model, requests };
}

describe("a verdict the plan cannot accept", () => {
  const setUp = () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    // The fixture's lockfile is rewritten while the worktree is provisioned.
    // Declaring it generated keeps a deterministic scope escape from deciding
    // the outcome these tests are about.
    contract.scope.generated_paths = ["pnpm-lock.yaml"];
    const config = makeConfig(repo.dir);
    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });
    return { repo, contract, config, agent };
  };

  it("asks the reviewer once more with the reason and takes the corrected verdict", async () => {
    const { contract, config, agent } = setUp();
    const { model, requests } = verdictModel([
      verdict([covers("ac_1"), covers("ac_1")]),
      verdict([covers("ac_1")]),
    ]);

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: ((input: Parameters<typeof runReview>[0]) =>
          runReview({ ...input, model })) as never,
      },
    });

    // The round reached a decision rather than ending on the first verdict.
    expect(result.outcome).toBe("approved");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain("verdict covers ac_1 more than once");
    expect(result.rounds[0]?.review?.rejected_verdicts).toHaveLength(1);
    expect(result.rounds[0]?.review?.error).toBeNull();
  }, 60_000);

  it("records review_failed with both reasons and leaves the sealed change set alone", async () => {
    const { repo, contract, config, agent } = setUp();
    const { model, requests } = verdictModel([verdict([covers("ac_1"), covers("ac_1")])]);

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: ((input: Parameters<typeof runReview>[0]) =>
          runReview({ ...input, model })) as never,
      },
    });

    expect(result.outcome).toBe("review_failed");
    expect(result.detail).toContain("verdict_rejected");
    expect(result.detail).toMatch(/cannot accept/);
    // One retry, never a second.
    expect(requests).toHaveLength(2);

    const review = result.rounds[0]?.review;
    expect(review?.error?.kind).toBe("verdict_rejected");
    expect(review?.rejected_verdicts.map((rejected) => rejected.attempt)).toEqual([1, 2]);
    for (const rejected of review?.rejected_verdicts ?? []) {
      expect(rejected.reason).toContain("verdict covers ac_1 more than once");
    }

    // The executor's sealed commit is still the branch's tip: the reviewer's
    // malformed output cost the review, not the attempt.
    expect(result.rounds[0]?.attempt.head_commit).not.toBeNull();
    expect(git(repo.dir, "rev-parse", result.workspace.branch).trim()).toBe(
      result.rounds[0]?.attempt.head_commit,
    );

    const store = new BundleStore({ root: config.bundle_root, retainContext: true });
    const bundle = store
      .forTicket(contract.ticket_id)
      .find((written) => written.kind === "review" && written.subject_id.startsWith("rev_"))!;
    expect(bundle.artifacts.map((artifact) => artifact.name)).toEqual(
      expect.arrayContaining(["review.json", "rejected-verdict-1.json", "rejected-verdict-2.json"]),
    );
  }, 60_000);

  it("takes one reviewer turn when the plan accepts the first verdict", async () => {
    const { contract, config, agent } = setUp();
    const { model, requests } = verdictModel([verdict([covers("ac_1")])]);

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: ((input: Parameters<typeof runReview>[0]) =>
          runReview({ ...input, model })) as never,
      },
    });

    expect(result.outcome).toBe("approved");
    expect(requests).toHaveLength(1);
    expect(result.rounds[0]?.review?.rejected_verdicts).toEqual([]);
  }, 60_000);
});

describe("a review that did not complete", () => {
  const setUp = () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });
    return { contract, config, agent };
  };

  it("records a provider outage as review_failed with the error kind, never as a verdict", async () => {
    const { contract, config, agent } = setUp();
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "error",
            coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
            error: {
              kind: "provider_unavailable",
              message: "HTTP 529 after 3 attempts",
              attempts: 3,
              unresolved_criteria: ["ac_1"],
              reading: [],
            },
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
      },
    });

    expect(result.outcome).toBe("review_failed");
    expect(result.detail).toContain("provider_unavailable");
    expect(result.detail).toContain("HTTP 529");
    // The attempt and its review record survive; only the verdict is withheld.
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.review?.decision).toBe("error");
  }, 60_000);

  /**
   * A transport failure names what the review was reading (SCP-188).
   *
   * AYO-33's note said `provider_unavailable` and nothing else, so a re-run
   * reviewed the same sealed commit and would have died on the same file. The
   * note has to carry the one fact that makes the re-run different.
   */
  const reviewFailedOn = async (reading: string[]) => {
    const { contract, config, agent } = setUp();
    return runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "error",
            coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
            error: {
              kind: "provider_unavailable",
              message: "the claude CLI failed: spawn E2BIG",
              attempts: 1,
              unresolved_criteria: ["ac_1"],
              reading,
            },
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
      },
    });
  };

  it("names the file the review was reading when the transport failed", async () => {
    const result = await reviewFailedOn(["packages/contracts/src/verdicts.ts"]);

    expect(result.outcome).toBe("review_failed");
    expect(result.detail).toContain("packages/contracts/src/verdicts.ts");
    expect(result.detail).toContain("reading");
  }, 60_000);

  it("says so when the transport failed with no file named", async () => {
    const result = await reviewFailedOn([]);

    expect(result.outcome).toBe("review_failed");
    expect(result.detail).toContain("no file named");
  }, 60_000);

  it("hands an incomplete review to a person rather than recording changes_requested (D-057)", async () => {
    const { contract, config, agent } = setUp();
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "incomplete",
            coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
      },
    });

    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("incomplete");
    expect(result.detail).toContain("ac_1");
  }, 60_000);
});

describe("the reviewer's kill switch", () => {
  it("stops the run before an attempt is paid for when the reviewer provider is disabled", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir),
      reviewer_provider: "claude-cli",
      limits: {
        organisation: "test",
        limits: { concurrent_local_attempts: 4 },
        kill_switches: { disabled_providers: ["claude-cli"] },
      },
    });
    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });

    await expect(
      runTicket({ config, contract, hooks: { agent: agent.run as never } }),
    ).rejects.toMatchObject({ name: "LimitExceededError", reason: "provider_disabled" });
    await expect(
      runTicket({ config, contract, hooks: { agent: agent.run as never } }),
    ).rejects.toThrow(/claude-cli/);
    expect(agent.calls).toHaveLength(0);
  }, 60_000);
});

describe("a ceiling termination", () => {
  it("names the configuration key and file that raise it", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    // SCP-193: an iteration ceiling is now followed by another attempt over the
    // sealed branch until the ticket budget is spent, so the budget is pinned
    // below one attempt's cost to make this ceiling the run's own answer. What
    // the test is about is unchanged: the stop names the key and the file.
    config.limits = LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4, ticket_cost_micros: 1_000 },
    });

    const agent = async (request: {
      worktree: string;
      profile: { network_allow_list: readonly string[] };
    }): Promise<AgentResult> => {
      writeFileSync(join(request.worktree, "src/thing.ts"), "export const thing = 1;\n");
      return {
        invocation: {
          adapter: "double", binary_path: "/bin/true", binary_version: "0.0.0",
          binary_sha256: "0".repeat(64), model: "double", credential_class: "subscription",
          argv: ["-p", "<prompt>"], shape_sha256: "1".repeat(64),
          neutralisation: {
            suppressed_at_invocation: ["double"], withheld_from_worktree: [], asserted_empty: ["mcp_servers"],
            reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
          },
        },
        commands: [], egress: new EgressLog(request.profile.network_allow_list), prohibited: [],
        usage: {
          input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5, cost_micros: 1234,
          cost_basis: "transport_reported", cost_partial: false, iterations: 61,
        },
        termination: {
          reason: "iteration_ceiling_exceeded",
          detail: "attempt_iterations would reach 61, above the limit of 60",
        },
        final_message: null,
        transcript: [],
      };
    };

    const result = await runTicket({ config, contract, hooks: { agent: agent as never } });

    expect(result.outcome).toBe("terminated");
    expect(result.detail).toContain("limits.limits.attempt_iterations");
    expect(result.detail).toContain(join(repo.dir, ".perbo", "config.json"));
    expect(result.rounds[0]?.attempt.termination.detail).toContain("limits.limits.attempt_iterations");
  }, 60_000);
});

/**
 * A commit an earlier run's seal left on the ticket's branch. The branch is
 * created from the base commit the first time and extended after, through a
 * throwaway worktree, so the loop finds the branch ahead of its base exactly
 * as it does after a run that was terminated once its work was sealed.
 */
function sealOnBranch(
  repo: { dir: string; head: string },
  contract: PlanContract,
  files: Record<string, string>,
  branch = branchName({ ticket_key: TICKET_KEY, ticket_id: contract.ticket_id, outcome: contract.outcome }),
): string {
  const path = join(scratch("perbo-prior-"), "wt");
  if (git(repo.dir, "branch", "--list", branch).trim().length > 0) {
    git(repo.dir, "worktree", "add", path, branch);
  } else {
    git(repo.dir, "worktree", "add", "-b", branch, path, repo.head);
  }
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), body);
  }
  git(path, "add", "-A");
  git(path, "commit", "-qm", `an earlier run sealed ${Object.keys(files).join(", ")}`);
  const head = git(path, "rev-parse", "HEAD").trim();
  git(repo.dir, "worktree", "remove", "--force", path);
  return head;
}

const approvingReview = (record: Array<Record<string, unknown>>) =>
  (async (input: Record<string, unknown>) => {
    record.push(input);
    return {
      artifact: makeReview({ review_id: "rev_0000000000000001", decision: "approve" }),
      bundle: {
        prompt_version: "reviewer_v2",
        system_prompt: "s",
        turns: [],
        files_read: [],
        rejected_verdicts: [],
      },
    };
  }) as never;

const reviewedPaths = (input: Record<string, unknown> | undefined): string[] =>
  ((input?.["changeset"] as { files: Array<{ path: string }> } | undefined)?.files ?? [])
    .map((file) => file.path)
    .sort();

describe("a re-run of a ticket whose branch is already recorded", () => {
  /** The branch an earlier run of this contract is on: `ayo/`, which an PRB key does not derive. */
  const RECORDED = "ayo/scp094/the-feature-module-exports-a-com";
  const CARRIED = { "src/carried.ts": "export const carried = 1;\n" };

  it("keeps the branch its delivery record names", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir, withoutInstall(repo.dir)),
      ticket_key: "PRB-7",
      delivery_branch: RECORDED,
    });
    const prior = sealOnBranch(repo, contract, CARRIED, RECORDED);

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(() => undefined).run as never, review: approvingReview([]) },
    });

    const attempt = result.rounds[0]!.attempt;
    expect(attempt.branch).toBe(RECORDED);
    // The earlier run's commit is on the branch this attempt worked on.
    expect(attempt.prior_commits.map((commit) => commit.sha)).toEqual([prior]);
    // And no branch was cut under the prefix the key derives.
    expect(git(repo.dir, "branch", "--list", "prb/*").trim()).toBe("");
  }, 60_000);

  it("keeps the branch its latest attempt was on", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir, withoutInstall(repo.dir)),
      ticket_key: "PRB-7",
    });
    const prior = sealOnBranch(repo, contract, CARRIED, RECORDED);
    mkdirSync(config.state_root, { recursive: true });
    writeFileSync(
      join(config.state_root, `${contract.ticket_id}.attempts.json`),
      `${JSON.stringify(
        {
          ticket_id: contract.ticket_id,
          attempts: [
            makeAttempt({
              attempt_id: "att_00000000000000aa",
              ticket_id: contract.ticket_id,
              head_commit: prior,
              branch: RECORDED,
            }),
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(() => undefined).run as never, review: approvingReview([]) },
    });

    const attempt = result.rounds[0]!.attempt;
    expect(attempt.branch).toBe(RECORDED);
    expect(attempt.prior_commits.map((commit) => commit.sha)).toEqual([prior]);
    expect(git(repo.dir, "branch", "--list", "prb/*").trim()).toBe("");
  }, 60_000);
});

describe("a re-run on a branch that already carries sealed commits", () => {
  it("reviews the commit an earlier run sealed when the executor changes nothing", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, withoutInstall(repo.dir));
    const prior = sealOnBranch(repo, contract, {
      "src/carried.ts": "export const total = (n: number[]) => n.length;\n",
    });

    const agent = agentDouble(() => undefined);
    const reviewInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReviewCapturing(reviewInputs) },
    });

    // The change set is the branch's diff against base, so the round runs its
    // checks and reaches the one independent review.
    expect(result.outcome).toBe("approved");
    expect(result.rounds[0]?.review).not.toBeNull();
    expect(reviewInputs).toHaveLength(1);
    expect(reviewedPaths(reviewInputs[0])).toEqual(["src/carried.ts"]);

    const attempt = result.rounds[0]!.attempt;
    expect(attempt.termination.reason).toBe("completed");
    expect(attempt.termination.detail).toContain("added nothing");
    expect(attempt.change_set_origin).toBe("carried_forward");
    expect(attempt.changeset_id).not.toBeNull();
    expect(attempt.head_commit).toBe(prior);
    expect(attempt.prior_commits.map((commit) => commit.sha)).toEqual([prior]);
    // No attempt record for the earlier run survives, so the sha stands alone.
    expect(attempt.prior_commits[0]?.attempt_id).toBeNull();
    expect(result.final_review?.target.prior_commits.map((commit) => commit.sha)).toEqual([prior]);
  }, 60_000);

  it("counts every commit on the branch that predates the attempt", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, withoutInstall(repo.dir));
    const first = sealOnBranch(repo, contract, { "src/one.ts": "export const one = 1;\n" });
    const second = sealOnBranch(repo, contract, { "src/two.ts": "export const two = 2;\n" });

    const agent = agentDouble(() => undefined);
    const reviewInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    expect(result.outcome).toBe("approved");
    expect(reviewedPaths(reviewInputs[0])).toEqual(["src/one.ts", "src/two.ts"]);
    const attempt = result.rounds[0]!.attempt;
    expect(attempt.prior_commits.map((commit) => commit.sha)).toEqual([first, second]);
    expect(attempt.change_set_origin).toBe("carried_forward");
  }, 60_000);

  it("refuses a judging artifact an earlier attempt sealed, which this one never touched", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, withoutInstall(repo.dir));
    sealOnBranch(repo, contract, { ".perbo/config.json": '{"checks":[]}\n' });

    const agent = agentDouble(() => undefined);
    const reviewInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    // The executor staged nothing, so the attempt's own delta is empty and the
    // seal's inspection of the range is the only thing that sees this file.
    const attempt = result.rounds[0]!.attempt;
    expect(attempt.termination.reason).toBe("prohibited_action");
    expect(attempt.termination.detail).toContain("modify_judging_artifact");
    expect(attempt.termination.detail).toContain(".perbo/config.json");
    expect(attempt.prohibited_action_hits.map((hit) => hit.action)).toContain(
      "modify_judging_artifact",
    );

    // The round stops at the seal: no review is bought over a change set the
    // system may not judge.
    expect(reviewInputs).toHaveLength(0);
    expect(result.rounds[0]?.review).toBeNull();
    expect(result.outcome).toBe("terminated");
    expect(result.detail).toContain("modify_judging_artifact");
  }, 60_000);

  /**
   * SCP-195: a scope escape that reached the seal is the runner's defect.
   *
   * The double writes straight into the worktree, which is exactly the shape
   * the guard cannot see: no tool call, no command line, nothing to resolve. So
   * this is the case the seal exists for — and the run stops on it as a defect
   * in the runner rather than buying a review that would find it.
   */
  it("stops the attempt as runner_defect when a changed path is outside the contract's scope", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, withoutInstall(repo.dir));

    const agent = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
      // Outside `src/**` and `test/**`, and outside every package they declare:
      // the change the review would block on, made where no command named it.
      writeFileSync(join(worktree, "package.json"), '{"name":"escaped"}\n');
    });
    const reviewInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    const attempt = result.rounds[0]!.attempt;
    expect(attempt.termination.reason).toBe("runner_defect");
    expect(attempt.termination.detail).toContain("package.json");
    // No review is bought over a change set the guard should never have allowed.
    expect(reviewInputs).toHaveLength(0);
    expect(result.outcome).toBe("terminated");
  }, 60_000);

  it("still records no_changes when the branch adds nothing to its base", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, withoutInstall(repo.dir));

    const agent = agentDouble(() => undefined);
    const reviewInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    expect(result.outcome).toBe("no_changes");
    expect(reviewInputs).toHaveLength(0);
    const attempt = result.rounds[0]!.attempt;
    expect(attempt.termination.reason).toBe("no_changes");
    expect(attempt.changeset_id).toBeNull();
    expect(attempt.prior_commits).toEqual([]);
    expect(attempt.change_set_origin).toBe("attempt");
  }, 60_000);

  /**
   * SCP-163: an attempt that could not act is not an attempt that chose not to.
   *
   * The executor here is the real fake-agent binary, spawned by the real
   * adapter: it asks for its commands, the runner decides each one, and nothing
   * is written to the tree. What separates the two endings is only what the
   * runner refused on the way.
   */
  const runWithShellAgent = async (commands: readonly string[]) => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, withoutInstall(repo.dir));
    config.agent_binary = fakeAgent(scratch, [{ kind: "shell", commands }]).binary;

    const reviewInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { review: approvingReview(reviewInputs) },
    });
    return { result, attempt: result.rounds[0]!.attempt };
  };

  it("records no_changes_after_denials, with the count, when refusals preceded the nothing", async () => {
    // Deny-list refusals, which is one of the two the runner still authors. A
    // verb the allow-list merely does not carry is no longer one of them, and
    // the other — a write outside the worktree — is a prohibited action that
    // ends the attempt before it can end in nothing.
    const { result, attempt } = await runWithShellAgent([
      // Inside the contract's paths, so the only thing refusing it is the
      // deny-list, which is what this test is about.
      "sudo rm -r src/.scratch",
      `git commit -m "wip"`,
    ]);

    expect(attempt.termination.reason).toBe("no_changes_after_denials");
    expect(attempt.termination.detail).toContain("2 command(s)");
    expect(attempt.commands.filter((command) => command.decision === "denied")).toHaveLength(2);
    expect(attempt.changeset_id).toBeNull();
    expect(result.outcome).toBe("no_changes");
  }, 90_000);

  it("still records plain no_changes where the executor was refused nothing", async () => {
    const { result, attempt } = await runWithShellAgent(["ls -la", "git status"]);

    expect(attempt.commands.filter((command) => command.decision === "denied")).toEqual([]);
    expect(attempt.termination.reason).toBe("no_changes");
    expect(attempt.changeset_id).toBeNull();
    expect(result.outcome).toBe("no_changes");
  }, 90_000);

  /**
   * The ending an unlisted-name denial invented.
   *
   * `cd` and `echo` are on no allow-list and the agent's permission layer runs
   * both. While the runner refused them by name, an attempt that changed
   * nothing and had only ever moved and printed came out
   * `no_changes_after_denials` — an executor that could not act, said of one
   * that simply chose not to.
   */
  it("ends no_changes where the only commands were `cd` and `echo`", async () => {
    const { result, attempt } = await runWithShellAgent([
      "cd packages/evaluation",
      'echo "nothing to change"',
    ]);

    expect(attempt.commands.filter((command) => command.decision === "denied")).toEqual([]);
    expect(attempt.termination.reason).toBe("no_changes");
    expect(result.outcome).toBe("no_changes");
  }, 90_000);

  it("reviews the old files and the new ones when the executor adds to what is there", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, withoutInstall(repo.dir));
    const prior = sealOnBranch(repo, contract, { "src/carried.ts": "export const carried = 1;\n" });

    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
    });
    const reviewInputs: Array<Record<string, unknown>> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    expect(result.outcome).toBe("approved");
    expect(reviewedPaths(reviewInputs[0])).toEqual(["src/carried.ts", "src/feature.ts"]);
    const attempt = result.rounds[0]!.attempt;
    expect(attempt.change_set_origin).toBe("attempt");
    expect(attempt.prior_commits.map((commit) => commit.sha)).toEqual([prior]);
    expect(attempt.head_commit).not.toBe(prior);
  }, 60_000);

  it("names the attempt that sealed a commit when that record is on hand", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const agent = agentDouble((worktree, round) => {
      if (round === 0) {
        writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
      } else {
        mkdirSync(join(worktree, "test"), { recursive: true });
        writeFileSync(join(worktree, "test", "feature.test.ts"), "// exercises total()\n");
      }
    });

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "remediable",
            findings: [finding()],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        verify: (async (input: Record<string, unknown>) => ({
          prompt_version: "closure_verify_v1",
          per_finding: (input.findings as Array<{ key: string }>).map((entry) => ({
            finding_key: entry.key,
            status: "closed",
            pointer: "test/feature.test.ts",
          })),
          deterministic_failure: null,
          all_closed: true,
          open_keys: [],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          cost_micros: 30,
          cost_basis: "provider_list_estimate",
        })) as never,
      },
    });

    const [first, second] = result.rounds;
    expect(first?.attempt.prior_commits).toEqual([]);
    expect(second?.attempt.prior_commits).toEqual([
      { sha: first?.attempt.head_commit, attempt_id: first?.attempt.attempt_id },
    ]);
  }, 60_000);
});

/**
 * A stand-in for the pinned unit check that fails once and passes when it is
 * run again, printing the shape a vitest suite under turbo prints.
 */
function flakyUnitCheck(alwaysFails: boolean): { command: string[]; calls: () => number } {
  const dir = scratch("perbo-flaky-check-");
  const counter = join(dir, "calls");
  const script = join(dir, "check.cjs");
  const failing = [
    "@perbo/cli:test:  ❯ test/x.test.ts (2 tests | 1 failed) 58ms",
    "@perbo/cli:test:      × case 5ms",
    "@perbo/cli:test:  FAIL  test/x.test.ts > suite > case",
    "@perbo/cli:test: AssertionError: expected 1 to be 2",
    "@perbo/cli:test:  Test Files  1 failed | 12 passed (13)",
    "@perbo/cli:test:        Tests  1 failed | 142 passed (143)",
    "",
  ].join("\n");
  const passing = [
    "@perbo/cli:test:  ✓ test/x.test.ts (2 tests) 12ms",
    "@perbo/cli:test:  Test Files  13 passed (13)",
    "@perbo/cli:test:        Tests  143 passed (143)",
    "",
  ].join("\n");
  writeFileSync(
    script,
    [
      'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
      `const counter = ${JSON.stringify(counter)};`,
      'const calls = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
      "writeFileSync(counter, String(calls + 1));",
      `if (calls > 0 && !${alwaysFails}) {`,
      `  process.stdout.write(${JSON.stringify(passing)});`,
      "  process.exit(0);",
      "}",
      `process.stdout.write(${JSON.stringify(failing)});`,
      'process.stderr.write(" ERROR  run failed: command  exited (1)\\n");',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  return {
    command: ["node", script],
    calls: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0),
  };
}

const approvingReviewCapturing = (reviewInputs: Array<Record<string, unknown>>) =>
  (async (input: Record<string, unknown>) => {
    reviewInputs.push(input);
    return {
      artifact: makeReview({ review_id: "rev_0000000000000003", decision: "approve" }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    };
  }) as never;

describe("a unit check that fails once", () => {
  it("re-runs it, records the flake, and hands the reviewer a check that passed", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const check = flakyUnitCheck(false);
    const config = makeConfig(repo.dir, undefined, check.command);

    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
    });
    const reviewInputs: Array<Record<string, unknown>> = [];

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    expect(result.outcome).toBe("approved");
    expect(check.calls()).toBe(2);

    const unit = result.rounds[0]!.checks[0]!;
    expect(unit.status).toBe("passed");
    expect(unit.flaky).toBe(true);
    expect(unit.reruns).toBe(1);
    expect(unit.failing_tests?.join("\n")).toContain("test/x.test.ts > suite > case");

    // What the reviewer was handed: a check that passed, so its own
    // `check.unit` blocking finding has nothing to fire on.
    const handed = reviewInputs[0]!.checks as Array<{ status: string; flaky?: boolean }>;
    expect(handed[0]!.status).toBe("passed");
    expect(handed[0]!.flaky).toBe(true);

    // The flake still reaches the round, as the runner's own advisory finding.
    const flake = result.rounds[0]!.review!.findings.find(
      (found) => found.rule_id === "check.unit_flaky",
    );
    expect(flake?.severity).toBe("advisory");
    expect(flake?.routing).toBe("advisory");
    expect(flake?.blocking).toBe(false);
    expect(flake?.statement).toContain("test/x.test.ts > suite > case");
  }, 60_000);

  it("closes the gate when the failure reproduces, and names the test that closed it", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const check = flakyUnitCheck(true);
    const config = makeConfig(repo.dir, undefined, check.command);

    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
    });
    const reviewInputs: Array<Record<string, unknown>> = [];

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async (input: Record<string, unknown>) => {
          reviewInputs.push(input);
          return {
            artifact: makeReview({ review_id: "rev_0000000000000004", decision: "changes_requested" }),
            bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
          };
        }) as never,
      },
    });

    expect(check.calls()).toBe(2);
    const unit = result.rounds[0]!.checks[0]!;
    expect(unit.status).toBe("failed");
    expect(unit.flaky).toBe(false);
    expect(unit.reruns).toBe(1);
    expect(unit.rerun?.status).toBe("failed");
    expect(unit.failing_tests?.join("\n")).toContain("test/x.test.ts > suite > case");
    expect(unit.rerun?.failing_tests?.join("\n")).toContain("test/x.test.ts > suite > case");
    expect(unit.detail).toContain("FAIL  test/x.test.ts > suite > case");

    const handed = reviewInputs[0]!.checks as Array<{ status: string }>;
    expect(handed[0]!.status).toBe("failed");
    expect(
      result.rounds[0]!.review!.findings.some((found) => found.rule_id === "check.unit_flaky"),
    ).toBe(false);
  }, 60_000);
});

/**
 * SCP-159, through the real adapter: the executor here is a stream on disk and
 * the runner terminates it, so what the record and the bundle say it cost is
 * what the transport had reported by the stop rather than nothing.
 */
describe("an attempt the runner stopped", () => {
  const stoppingExecutor = (lines: readonly string[]): string => {
    const binary = join(scratch("perbo-scp159-loop-"), "executor");
    writeFileSync(
      binary,
      `#!/bin/sh\ncase "$1" in --version) echo 'fake-executor 1.0.0'; exit 0 ;; esac\n` +
        `cat <<'JSON'\n${lines.join("\n")}\nJSON\nsleep 30\n`,
      { mode: 0o755 },
    );
    return binary;
  };

  it("records the charge reported before the stop, and the bundle agrees", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const charged = (total: number) =>
      JSON.stringify({
        type: "assistant",
        total_cost_usd: total,
        message: {
          content: [],
          usage: {
            input_tokens: 1_000,
            cache_creation_input_tokens: 50,
            output_tokens: 100,
          },
        },
      });
    config.agent_binary = stoppingExecutor([
      charged(1.25),
      charged(2.0),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "cp secrets.json ~/backup.json" } },
          ],
          usage: {},
        },
      }),
    ]);

    const result = await runTicket({ config, contract });

    expect(result.outcome).toBe("terminated");
    const attempt = result.rounds[0]!.attempt;
    expect(attempt.termination.reason).toBe("prohibited_action");
    expect(attempt.usage.cost_micros).toBe(2_000_000);
    expect(attempt.usage.cost_basis).toBe("transport_reported");
    expect(attempt.usage.cost_partial).toBe(true);
    expect(attempt.usage.cache_creation_input_tokens).toBe(100);
    expect(attempt.usage.token_ceiling_tokens).toBe(2_300);

    const bundle = new BundleStore({ root: config.bundle_root, retainContext: true })
      .forTicket(contract.ticket_id)
      .find((written) => written.kind === "execution");
    expect(bundle?.usage.cost_micros).toBe(2_000_000);
    expect(bundle?.usage.cost_basis).toBe("transport_reported");
    expect(bundle?.usage.cost_partial).toBe(true);
  }, 60_000);
});

describe("the pull request the loop publishes", () => {
  it("names where the work came from, carried from the run configuration into the body", async () => {
    // The source line is built inside `runTicket`, from `config.ticket_source`.
    // Calling `pullRequestBody` directly proves the line renders and parsing a
    // configuration proves the field survives; neither notices the argument
    // going missing between them, which is the only place it can be lost.
    const issue = "/repo/inbox/SCP-169.md";
    const repo = makeRepo();
    const remote = scratch("perbo-remote-");
    git(remote, "init", "-q", "--bare");
    git(repo.dir, "remote", "add", "origin", remote);

    // A `gh` that records the body it is handed and refuses `pr view`, so
    // creation is the path taken. The runner holds the credential and shells
    // out to `gh` itself, so this is where the published body can be read.
    const bin = scratch("perbo-gh-");
    const bodyFile = join(bin, "body.txt");
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        'if [ "$2" != "create" ]; then exit 1; fi',
        "while [ $# -gt 0 ]; do",
        `  if [ "$1" = "--body" ]; then shift; printf %s "$1" > ${JSON.stringify(bodyFile)}; fi`,
        "  shift",
        "done",
        'echo "https://github.example/o/r/pull/7"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir),
      publish: true,
      ticket_source: {
        kind: "file",
        reference: issue,
        url: null,
        title_at_admission: "A pasted issue",
      },
    });

    const agent = agentDouble((worktree) => {
      writeFileSync(join(worktree, "src/thing.ts"), "export const thing = 1;\n");
    });

    const path = process.env.PATH;
    let result;
    try {
      process.env.PATH = `${bin}:${path ?? ""}`;
      result = await runTicket({
        config,
        contract,
        hooks: {
          agent: agent.run as never,
          review: (async () => ({
            artifact: makeReview({
              review_id: "rev_0000000000000001",
              decision: "approve",
              coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
            }),
            bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
          })) as never,
        },
      });
    } finally {
      process.env.PATH = path;
    }

    expect(result.outcome).toBe("approved");
    expect(result.pull_request?.url).toBe("https://github.example/o/r/pull/7");
    expect(readFileSync(bodyFile, "utf8")).toContain(`Source: file ${issue}`);
  }, 60_000);
});

/**
 * SCP-172, end to end: what the loop does about a model transport that gave up.
 *
 * The executor is a real process in every case, exiting either the way the
 * measured transport failure did — retry notices on stderr, the synthetic
 * assistant message carrying the provider's error, exit 1 with no work done —
 * or the way an ordinary failure does. So what drives the loop is the runner's
 * own reading of the exit rather than a termination a double handed it, and the
 * two exits are told apart here rather than assumed apart. The reviewer stays a
 * double: it is a model call, and none of these cases is about its judgement.
 */
describe("an attempt whose model transport gave up", () => {
  const approve = (async () => ({
    artifact: makeReview({
      review_id: "rev_0000000000000009",
      decision: "approve",
      coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
    }),
    bundle: {
      prompt_version: "reviewer_v2",
      system_prompt: "s",
      turns: [],
      files_read: [],
      rejected_verdicts: [],
    },
  })) as never;

  /** The ticket's attempts record, as the run appended it. */
  const recordedAttempts = (config: { state_root: string }, ticket_id: string) =>
    (
      JSON.parse(readFileSync(join(config.state_root, `${ticket_id}.attempts.json`), "utf8")) as {
        attempts: Array<{
          attempt_id: string;
          root_attempt_id: string;
          continues_attempt_id: string | null;
          remediation_round: number;
          termination: { reason: string; detail: string };
          usage: { wall_clock_ms: number; cost_basis: string };
        }>;
      }
    ).attempts;

  it("waits, runs one more attempt from the same base, and the run finishes", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = fakeAgent(scratch, [
      { kind: "overloaded", status: 529, retries: 10 },
      { kind: "succeed", file: "src/feature.ts", contents: "export const total = (n) => n.length;\n" },
    ]);
    config.agent_binary = agent.binary;

    // The wait is observed rather than served: a minute of real time proves
    // nothing this test does not already assert about the order of events.
    const waited: number[] = [];
    const result = await runTicket({
      config,
      contract,
      sleep: async (ms) => {
        waited.push(ms);
      },
      hooks: { review: approve },
    });

    expect(result.outcome).toBe("approved");
    expect(waited).toEqual([TRANSPORT_RETRY_DELAY_MS]);
    // Two executions of the real binary: the failure is not replayed from a
    // cache and the retry is a fresh process.
    expect(agent.invocations()).toHaveLength(2);

    // One round ran, and it ran twice: the round record is still one per
    // round, with the attempt the transport ended named on it.
    expect(result.rounds).toHaveLength(1);
    const [first] = result.rounds[0]!.superseded_attempts;
    const second = result.rounds[0]!.attempt;
    expect(result.rounds[0]!.round).toBe(0);
    expect(first!.termination.reason).toBe("transport_unavailable");
    expect(first!.termination.detail).toContain("529");
    expect(first!.termination.detail).toContain("Overloaded");
    expect(second!.termination.reason).toBe("completed");

    // The second attempt is the first one's continuation, from the same base
    // and in the same worktree — the same work again rather than a new round
    // with a new brief.
    expect(second!.attempt_id).not.toBe(first!.attempt_id);
    expect(second!.continues_attempt_id).toBe(first!.attempt_id);
    expect(second!.root_attempt_id).toBe(first!.root_attempt_id);
    expect(second!.base_commit).toBe(first!.base_commit);
    expect(second!.worktree_path).toBe(first!.worktree_path);
    expect(second!.remediation_round).toBe(0);
    expect(agent.invocations()[1]!.cwd).toBe(agent.invocations()[0]!.cwd);

    // Both attempts are counted by the run: both on the ticket's record, in
    // order, and both metered — the retry is an attempt the run paid for, not
    // a free second go.
    const recorded = recordedAttempts(config, contract.ticket_id);
    expect(recorded.map((attempt) => attempt.attempt_id)).toEqual([
      first!.attempt_id,
      second!.attempt_id,
    ]);
    expect(recorded[1]!.continues_attempt_id).toBe(first!.attempt_id);
    for (const attempt of recorded) expect(attempt.usage.wall_clock_ms).toBeGreaterThan(0);

    // And the run's cost accounting holds one execution bundle per attempt,
    // so what the run spent includes what the failed one spent.
    const executions = new BundleStore({ root: config.bundle_root, retainContext: true })
      .forTicket(contract.ticket_id)
      .filter((bundle) => bundle.kind === "execution");
    expect(executions.map((bundle) => bundle.subject_id).sort()).toEqual(
      [first!.attempt_id, second!.attempt_id].sort(),
    );
    expect(
      executions.find((bundle) => bundle.subject_id === first!.attempt_id)?.inputs.termination,
    ).toBe("transport_unavailable");
  }, 60_000);

  it("prices both attempts in the pull request and claims no round it did not run", async () => {
    const repo = makeRepo();
    const remote = scratch("perbo-remote-");
    git(remote, "init", "-q", "--bare");
    git(repo.dir, "remote", "add", "origin", remote);

    // A `gh` that records the body it is handed and refuses `pr view`, so
    // creation is the path taken.
    const bin = scratch("perbo-gh-transport-");
    const bodyFile = join(bin, "body.txt");
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        'if [ "$2" != "create" ]; then exit 1; fi',
        "while [ $# -gt 0 ]; do",
        `  if [ "$1" = "--body" ]; then shift; printf %s "$1" > ${JSON.stringify(bodyFile)}; fi`,
        "  shift",
        "done",
        'echo "https://github.example/o/r/pull/9"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const agent = fakeAgent(scratch, [
      { kind: "overloaded", status: 529, retries: 10 },
      { kind: "succeed", file: "src/feature.ts", contents: "export const total = (n) => n.length;\n" },
    ]);
    const config = TicketRunConfigSchema.parse({
      ...makeConfig(repo.dir),
      agent_binary: agent.binary,
      publish: true,
    });

    const path = process.env.PATH;
    let result;
    try {
      process.env.PATH = `${bin}:${path ?? ""}`;
      result = await runTicket({ config, contract, sleep: async () => undefined, hooks: { review: approve } });
    } finally {
      process.env.PATH = path;
    }

    expect(result.outcome).toBe("approved");
    const body = readFileSync(bodyFile, "utf8");
    const [first] = result.rounds[0]!.superseded_attempts;
    const second = result.rounds[0]!.attempt;

    // The body names the attempt that produced the change set, and does not
    // credit the run with a remediation round: the second attempt answered a
    // transport failure, not a finding.
    expect(body).toContain(`Attempt: \`${second!.attempt_id}\``);
    expect(body).not.toContain("remediation round");
    // Both attempts are components of the run's cost accounting, beside the
    // review — three in all, one of them the transport failure that ended
    // before its transport priced it.
    expect(body).toContain("of 3 model-cost component(s)");
    expect(first!.termination.reason).toBe("transport_unavailable");
  }, 60_000);

  it("fails the ticket on the second one in a row, naming the transport error", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    // The last behaviour repeats, so this executor's transport is out for the
    // whole run rather than for one attempt.
    const agent = fakeAgent(scratch, [{ kind: "overloaded", status: 529, retries: 10 }]);
    config.agent_binary = agent.binary;

    const waited: number[] = [];
    const result = await runTicket({
      config,
      contract,
      sleep: async (ms) => {
        waited.push(ms);
      },
      hooks: { review: approve },
    });

    // `terminated` is the outcome the ticket is recorded `failed` from: the
    // change never reached a review, so there is nothing to request changes on.
    expect(result.outcome).toBe("terminated");
    // One retry, and only one: the run stops rather than sitting out a third.
    expect(waited).toEqual([TRANSPORT_RETRY_DELAY_MS]);
    expect(agent.invocations()).toHaveLength(2);

    const recorded = recordedAttempts(config, contract.ticket_id);
    expect(recorded).toHaveLength(2);
    expect(recorded.map((attempt) => attempt.termination.reason)).toEqual([
      "transport_unavailable",
      "transport_unavailable",
    ]);
    // Two attempts of one round: the run never opened a second round, so the
    // round record holds one entry, naming both.
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.attempt.attempt_id).toBe(recorded[1]!.attempt_id);
    expect(result.rounds[0]!.superseded_attempts.map((attempt) => attempt.attempt_id)).toEqual([
      recorded[0]!.attempt_id,
    ]);

    // The note names the weather, not a generic agent exit.
    expect(result.detail).toContain("transport_unavailable");
    expect(result.detail).toContain("529");
    expect(result.detail).toContain("Overloaded");
    expect(result.detail).toContain("the model transport was unavailable");
    expect(result.detail).not.toContain("agent_error");
  }, 60_000);

  it("leaves an ordinary agent failure to fail the ticket on its first attempt", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = fakeAgent(scratch, [{ kind: "agent_error" }]);
    config.agent_binary = agent.binary;

    const waited: number[] = [];
    const result = await runTicket({
      config,
      contract,
      sleep: async (ms) => {
        waited.push(ms);
      },
      hooks: { review: approve },
    });

    expect(result.outcome).toBe("terminated");
    // Nothing was waited for and nothing was retried: an agent that ran and
    // failed is evidence about the attempt.
    expect(waited).toEqual([]);
    expect(agent.invocations()).toHaveLength(1);

    const recorded = recordedAttempts(config, contract.ticket_id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.termination.reason).toBe("agent_error");
    expect(result.detail).toContain("agent_error");
    expect(result.detail).toContain("the agent exited 1");
  }, 60_000);

  it("buys no extra attempt for a 529 the transport retried and served", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    // A 529 on stderr, retried and served, work after it, and then a failure
    // of the agent's own. The transport is in the transcript but is not what
    // ended the attempt, so this is an ordinary failure on its first attempt.
    const agent = fakeAgent(scratch, [{ kind: "recovered_blip" }]);
    config.agent_binary = agent.binary;

    const waited: number[] = [];
    const result = await runTicket({
      config,
      contract,
      sleep: async (ms) => {
        waited.push(ms);
      },
      hooks: { review: approve },
    });

    expect(result.outcome).toBe("terminated");
    expect(waited).toEqual([]);
    expect(agent.invocations()).toHaveLength(1);

    const recorded = recordedAttempts(config, contract.ticket_id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.termination.reason).toBe("agent_error");
    expect(recorded[0]!.termination.detail).not.toContain("529");
    expect(result.detail).toContain("agent_error");
    expect(result.detail).not.toContain("transport");
  }, 60_000);
});

/**
 * SCP-193: a run cut by a ceiling or a provider limit continues on its own.
 *
 * Two different stops with the same shape — the work is sealed and a person
 * types `run` again — and two different answers. A cost or iteration ceiling is
 * answered by another attempt over the sealed branch, until the ticket budget
 * is spent. A provider that named its own reset time is answered by waiting for
 * it.
 */
describe("a run a ceiling cut", () => {
  /**
   * An executor that ends on `termination` for its first `cut` invocations and
   * completes after, writing a different file each time so the branch grows and
   * the seal has something to commit.
   */
  const cutThenComplete = (input: {
    cut: number;
    termination: { reason: string; detail: string };
    files: readonly string[];
    /** What the double says it authenticated with; billed per token unless said otherwise. */
    credential?: "user_api_key" | "subscription";
  }) => {
    let call = 0;
    const seen: Array<{ worktree: string; terminated: string }> = [];
    const run = async (request: {
      worktree: string;
      profile: { network_allow_list: readonly string[] };
    }): Promise<AgentResult> => {
      const index = call++;
      const file = input.files[Math.min(index, input.files.length - 1)]!;
      mkdirSync(join(request.worktree, dirname(file)), { recursive: true });
      writeFileSync(join(request.worktree, file), `// written on invocation ${index}\n`);
      const termination =
        index < input.cut ? input.termination : { reason: "completed", detail: "" };
      seen.push({ worktree: request.worktree, terminated: termination.reason });
      return {
        invocation: {
          adapter: "double", binary_path: "/bin/true", binary_version: "0.0.0",
          // D-096: a cost ceiling cuts only an executor billed per token, and
          // the ticket budget that decides whether a cut attempt is continued
          // is measured on the same credential. A subscription has neither.
          binary_sha256: "0".repeat(64), model: "double",
          credential_class: input.credential ?? "user_api_key",
          argv: ["-p", "<prompt>"], shape_sha256: "1".repeat(64),
          neutralisation: {
            suppressed_at_invocation: ["double"], withheld_from_worktree: [], asserted_empty: ["mcp_servers"],
            reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
          },
        },
        commands: [], egress: new EgressLog(request.profile.network_allow_list), prohibited: [],
        usage: {
          input_tokens: 10, output_tokens: 5, cost_micros: 1_000_000,
          cost_basis: "transport_reported", cost_partial: index < input.cut, iterations: 61,
        },
        termination,
        transcript: [],
      } as unknown as AgentResult;
    };
    return { run, seen };
  };

  const approve = (async () => ({
    artifact: makeReview({ review_id: "rev_0000000000000193", decision: "approve" }),
    bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
  })) as never;

  const recordedAttempts = (config: { state_root: string }, ticket_id: string) =>
    (
      JSON.parse(readFileSync(join(config.state_root, `${ticket_id}.attempts.json`), "utf8")) as {
        attempts: Array<{
          attempt_id: string;
          continues_attempt_id: string | null;
          remediation_round: number;
          prior_commits: Array<{ sha: string }>;
          termination: { reason: string };
          wait: { until: string; zone: string; reason: string; waited_ms: number } | null;
        }>;
      }
    ).attempts;

  it("starts the next attempt over the sealed branch instead of ending the run", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = cutThenComplete({
      cut: 1,
      termination: {
        reason: "cost_ceiling_exceeded",
        detail: "attempt_cost_micros would reach 5000001, above the limit of 5000000",
      },
      files: ["src/feature.ts", "test/feature.test.ts"],
    });

    const result = await runTicket({
      config,
      contract,
      sleep: async () => undefined,
      hooks: { agent: agent.run as never, review: approve },
    });

    expect(result.outcome).toBe("approved");
    // One round, two attempts: the ceiling did not spend a remediation round.
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.round).toBe(0);
    expect(result.rounds[0]!.superseded_attempts).toHaveLength(1);

    const cut = result.rounds[0]!.superseded_attempts[0]!;
    const continued = result.rounds[0]!.attempt;
    expect(cut.termination.reason).toBe("cost_ceiling_exceeded");
    expect(continued.termination.reason).toBe("completed");
    expect(continued.attempt_id).not.toBe(cut.attempt_id);
    expect(continued.continues_attempt_id).toBe(cut.attempt_id);
    expect(continued.root_attempt_id).toBe(cut.root_attempt_id);
    expect(continued.remediation_round).toBe(0);

    // Over the sealed branch: the cut attempt's commit is on it, attributed to
    // the attempt that made it, and the continuation did not start from base.
    expect(cut.head_commit).not.toBeNull();
    expect(continued.prior_commits.map((commit) => commit.sha)).toContain(cut.head_commit);
    expect(continued.prior_commits[0]!.attempt_id).toBe(cut.attempt_id);
    expect(agent.seen[1]!.worktree).toBe(agent.seen[0]!.worktree);

    // Run 1, attempts 1 and 2, in that order on the ticket's record.
    const recorded = recordedAttempts(config, contract.ticket_id);
    expect(recorded.map((attempt) => attempt.attempt_id)).toEqual([
      cut.attempt_id,
      continued.attempt_id,
    ]);
  }, 60_000);

  it("stops with the ticket budget named once the budget is spent", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    // One attempt costs $1.00 in this double, so a $0.50 budget is spent by the
    // first one and no continuation may start.
    config.limits = LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4, ticket_cost_micros: 500_000 },
    });
    const agent = cutThenComplete({
      cut: 5,
      termination: {
        reason: "iteration_ceiling_exceeded",
        detail: "attempt_iterations would reach 61, above the limit of 60",
      },
      files: ["src/feature.ts"],
    });

    const result = await runTicket({
      config,
      contract,
      sleep: async () => undefined,
      hooks: { agent: agent.run as never, review: approve },
    });

    expect(result.outcome).toBe("terminated");
    expect(result.detail).toContain("iteration_ceiling_exceeded");
    expect(result.detail).toContain("limits.limits.ticket_cost_micros");
    expect(result.detail).toContain("$0.50");
    // Exactly one attempt: the budget was already spent when the first ended.
    expect(agent.seen).toHaveLength(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.superseded_attempts).toHaveLength(0);
  }, 60_000);

  it("continues until the budget is reached and prices the run as the sum", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    // $1.00 an attempt against a $2.50 budget: attempts at $0, $1 and $2 all
    // have room; the one that takes the ticket to $3 does not.
    config.limits = LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4, ticket_cost_micros: 2_500_000 },
    });
    const agent = cutThenComplete({
      cut: 99,
      termination: {
        reason: "cost_ceiling_exceeded",
        detail: "attempt_cost_micros would reach 5000001, above the limit of 5000000",
      },
      files: ["src/one.ts", "src/two.ts", "src/three.ts", "src/four.ts"],
    });

    const result = await runTicket({
      config,
      contract,
      sleep: async () => undefined,
      hooks: { agent: agent.run as never, review: approve },
    });

    expect(result.outcome).toBe("terminated");
    expect(agent.seen).toHaveLength(3);
    expect(recordedAttempts(config, contract.ticket_id)).toHaveLength(3);
    expect(result.rounds[0]!.superseded_attempts).toHaveLength(2);
    expect(result.detail).toContain("$3.00");
  }, 60_000);

  it("leaves a subscription attempt's figure out of a per-token budget (D-096)", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    config.limits = LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4, ticket_cost_micros: 2_500_000 },
    });
    const cut = {
      cut: 99,
      termination: {
        reason: "cost_ceiling_exceeded",
        detail: "attempt_cost_micros would reach 5000001, above the limit of 5000000",
      },
      files: ["src/one.ts", "src/two.ts", "src/three.ts", "src/four.ts"],
    };

    // A first run on a subscription: its one attempt reports $1.00, which is a
    // measure of work and not a bill, and no budget binds, so the run ends
    // with that attempt on the ticket's record.
    const subscribed = cutThenComplete({ ...cut, credential: "subscription" });
    const first = await runTicket({
      config,
      contract,
      sleep: async () => undefined,
      hooks: { agent: subscribed.run as never, review: approve },
    });
    expect(first.outcome).toBe("terminated");
    expect(subscribed.seen).toHaveLength(1);

    // A second run on an API key against the same $2.50: the subscription
    // attempt's dollar is not spend, so attempts at $0, $1 and $2 all have
    // room, as they would on a ticket nothing had run on. Each writes a file
    // the sealed branch does not yet carry, so each has work of its own.
    const billed = cutThenComplete({
      ...cut,
      files: ["src/five.ts", "src/six.ts", "src/seven.ts", "src/eight.ts"],
    });
    const second = await runTicket({
      config,
      contract,
      sleep: async () => undefined,
      hooks: { agent: billed.run as never, review: approve },
    });
    expect(second.outcome).toBe("terminated");
    expect(billed.seen).toHaveLength(3);
    expect(second.detail).toContain("$3.00");
  }, 90_000);
});

describe("a run a provider's session limit cut", () => {
  const approve = (async () => ({
    artifact: makeReview({ review_id: "rev_0000000000000194", decision: "approve" }),
    bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
  })) as never;

  /**
   * 00:15 UTC on 4 September 2026. London is on BST that day, so a limit that
   * resets at 4:30am there lifts at 03:30 UTC — three hours and a quarter
   * after this instant, and inside the six-hour default bound.
   */
  const NOW = new Date("2026-09-04T00:15:00.000Z");
  const RESETS_AT = "2026-09-04T03:30:00.000Z";
  const UNTIL_RESET_MS = Date.parse(RESETS_AT) - NOW.getTime();
  const SESSION_LIMIT = "You've hit your session limit · resets 4:30am (Europe/London)";

  const attemptsOnDisk = (config: { state_root: string }, ticket_id: string) => {
    const path = join(config.state_root, `${ticket_id}.attempts.json`);
    if (!existsSync(path)) return [];
    return (
      JSON.parse(readFileSync(path, "utf8")) as {
        attempts: Array<{
          attempt_id: string;
          termination: { reason: string };
          wait: { until: string; zone: string; reason: string; waited_ms: number } | null;
        }>;
      }
    ).attempts;
  };

  it("parks until the reset, records the wait before sleeping, and resumes the same attempt", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = fakeAgent(scratch, [
      { kind: "session_limit", message: SESSION_LIMIT },
      { kind: "succeed", file: "src/feature.ts", contents: "export const total = (n) => n.length;\n" },
    ]);
    config.agent_binary = agent.binary;

    const waited: number[] = [];
    /** What the record held at the moment the loop went to sleep. */
    let recordedBeforeSleeping: ReturnType<typeof attemptsOnDisk> = [];
    const result = await runTicket({
      config,
      contract,
      now: () => NOW,
      sleep: async (ms) => {
        waited.push(ms);
        recordedBeforeSleeping = attemptsOnDisk(config, contract.ticket_id);
      },
      hooks: { review: approve },
    });

    expect(result.outcome).toBe("approved");
    // Not the flat 60s an overloaded transport buys: the provider said when.
    expect(waited).toEqual([UNTIL_RESET_MS]);
    expect(waited[0]).not.toBe(TRANSPORT_RETRY_DELAY_MS);
    expect(agent.invocations()).toHaveLength(2);

    // One round; the parked attempt is the round's superseded one, and the
    // wait is on it with the provider's own words.
    expect(result.rounds).toHaveLength(1);
    const parked = result.rounds[0]!.superseded_attempts[0]!;
    expect(parked.termination.reason).toBe("transport_unavailable");
    expect(parked.wait).not.toBeNull();
    expect(parked.wait!.reason).toBe("provider_reset");
    expect(parked.wait!.until).toBe(RESETS_AT);
    expect(parked.wait!.zone).toBe("Europe/London");
    expect(parked.wait!.waited_ms).toBe(UNTIL_RESET_MS);
    expect(parked.wait!.quoted).toContain("resets 4:30am");

    // The same attempt resumed: same round, same worktree, same base.
    const resumed = result.rounds[0]!.attempt;
    expect(resumed.remediation_round).toBe(0);
    expect(resumed.worktree_path).toBe(parked.worktree_path);
    expect(resumed.base_commit).toBe(parked.base_commit);
    expect(resumed.continues_attempt_id).toBe(parked.attempt_id);

    // On disk before the sleep, not after: the wait has to outlive a process
    // that is killed while it is parked.
    expect(recordedBeforeSleeping.map((attempt) => attempt.attempt_id)).toEqual([
      parked.attempt_id,
    ]);
    expect(recordedBeforeSleeping[0]!.wait?.until).toBe(RESETS_AT);
    // And the record is not written twice: the final append adds only what the
    // park had not already flushed.
    expect(attemptsOnDisk(config, contract.ticket_id).map((one) => one.attempt_id)).toEqual([
      parked.attempt_id,
      resumed.attempt_id,
    ]);
  }, 60_000);

  it("refuses to wait past the bound rather than waking before the provider does", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    config.limits = LimitsTableSchema.parse({
      organisation: "test",
      // One hour, against a reset three and a quarter hours out.
      limits: { concurrent_local_attempts: 4, wait_for_provider_ms: 3_600_000 },
    });
    const agent = fakeAgent(scratch, [{ kind: "session_limit", message: SESSION_LIMIT }]);
    config.agent_binary = agent.binary;

    const waited: number[] = [];
    const result = await runTicket({
      config,
      contract,
      now: () => NOW,
      sleep: async (ms) => {
        waited.push(ms);
      },
      hooks: { review: approve },
    });

    expect(result.outcome).toBe("terminated");
    expect(waited).toEqual([]);
    expect(agent.invocations()).toHaveLength(1);
    expect(result.detail).toContain("limits.limits.wait_for_provider_ms");
    expect(result.detail).toContain(RESETS_AT);
  }, 60_000);

  it("honours a park a killed run left on the record", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = fakeAgent(scratch, [
      { kind: "succeed", file: "src/feature.ts", contents: "export const total = (n) => n.length;\n" },
    ]);
    config.agent_binary = agent.binary;

    // The record a process killed mid-park leaves behind.
    const killed = {
      ...makeAttempt({ attempt_id: `att_${"1".repeat(16)}`, ticket_id: contract.ticket_id }),
      termination: { reason: "transport_unavailable" as const, detail: SESSION_LIMIT },
      wait: {
        reason: "provider_reset" as const,
        started_at: "2026-09-03T23:00:00.000Z",
        until: RESETS_AT,
        waited_ms: 16_200_000,
        zone: "Europe/London",
        quoted: SESSION_LIMIT,
      },
    };
    mkdirSync(config.state_root, { recursive: true });
    writeFileSync(
      join(config.state_root, `${contract.ticket_id}.attempts.json`),
      `${JSON.stringify({ ticket_id: contract.ticket_id, attempts: [killed] }, null, 2)}\n`,
    );

    const waited: number[] = [];
    const result = await runTicket({
      config,
      contract,
      now: () => NOW,
      sleep: async (ms) => {
        waited.push(ms);
      },
      hooks: { review: approve },
    });

    // The remainder of the recorded park, waited before anything was spent.
    expect(waited).toEqual([UNTIL_RESET_MS]);
    expect(result.outcome).toBe("approved");
  }, 60_000);
});

describe("a second run of a ticket that is already running", () => {
  it("refuses with the pid and the wait, and takes over a lock whose process is gone", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = fakeAgent(scratch, [
      { kind: "succeed", file: "src/feature.ts", contents: "export const total = (n) => n.length;\n" },
    ]);
    config.agent_binary = agent.binary;
    const approve = (async () => ({
      artifact: makeReview({ review_id: "rev_0000000000000195", decision: "approve" }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    })) as never;

    // A live run: this process, which is certainly alive.
    const held = acquireRunLock({
      state_root: config.state_root,
      ticket_id: contract.ticket_id,
      ticket_key: config.ticket_key,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });

    await expect(runTicket({ config, contract, hooks: { review: approve } })).rejects.toThrow(
      RunLockedError,
    );
    await expect(runTicket({ config, contract, hooks: { review: approve } })).rejects.toThrow(
      String(process.pid),
    );

    // Parked, and the refusal says so rather than only "already running".
    held.parked({
      reason: "provider_reset",
      started_at: "2026-09-04T00:00:00.000Z",
      until: "2026-09-04T03:30:00.000Z",
      waited_ms: 12_600_000,
      zone: "Europe/London",
      quoted: "resets 4:30am (Europe/London)",
    });
    await expect(runTicket({ config, contract, hooks: { review: approve } })).rejects.toThrow(
      /parked until 2026-09-04T03:30:00.000Z \(Europe\/London\)/,
    );

    // A lock whose process is gone is stale, and the next run takes it over
    // rather than refusing on a pid nothing answers to.
    //
    // The pid is earned rather than written down: a child that ran to
    // completion and was reaped is a process that certainly existed and
    // certainly does not now, which is exactly what the stale check has to
    // answer ESRCH for. A literal low pid is not that on every machine — pid 2
    // is a live kernel thread on GitHub's Linux runners, so the fixture read as
    // held rather than stale and the run was refused.
    const departed = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(departed.status).toBe(0);
    expect(departed.pid).toBeGreaterThan(0);
    writeFileSync(
      held.path,
      `${JSON.stringify({
        pid: departed.pid,
        host: hostname(),
        ticket_id: contract.ticket_id,
        ticket_key: config.ticket_key,
        started_at: "2026-09-04T00:00:00.000Z",
        wait: null,
      })}\n`,
    );
    const result = await runTicket({ config, contract, hooks: { review: approve } });
    expect(result.outcome).toBe("approved");
    // A run that ended leaves no lock behind.
    expect(existsSync(held.path)).toBe(false);
  }, 60_000);
});

/**
 * SCP-194: remediation is bounded by progress and budget, not by two rounds.
 *
 * The doubles here drive one thing the loop could not be asked before: how many
 * rounds a run gets. A round that closed something earns the next; a round that
 * closed nothing ends the ticket with the open keys named; and the cap sits
 * above both rather than being the rule.
 */
describe("remediation bounded by progress", () => {
  /** Four routed findings, distinct in key and rule so a stop can name one. */
  const routed = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      finding({
        key: String(index + 1).repeat(64),
        rule_id: `test.missing_for_criterion_${index + 1}`,
        statement: `Finding ${index + 1} is open.`,
      }),
    );

  const reviewing = (findings: ReturnType<typeof routed>, seen: unknown[] = []) =>
    (async (input: Record<string, unknown>) => {
      seen.push(input);
      return {
        artifact: makeReview({
          review_id: "rev_0000000000000194",
          decision: "remediable" as const,
          findings,
          head_commit: (input.head_commit as string | undefined) ?? "def5678",
          changeset_id:
            (input.changeset as { changeset_id?: string } | undefined)?.changeset_id ??
            "cs_0000000000000001",
        }),
        bundle: {
          prompt_version: "reviewer_v2",
          system_prompt: "s",
          turns: [],
          files_read: [],
          rejected_verdicts: [],
        },
      };
    }) as never;

  /**
   * A verifier that closes exactly what the plan says, round by round: the
   * `n`th call closes the first `plan[n]` of the findings it was handed.
   */
  const verifying = (plan: readonly number[]) => {
    const rounds: Array<{ given: string[]; closed: string[] }> = [];
    const verify = (async (input: Record<string, unknown>) => {
      const given = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
      const closed = given.slice(0, plan[rounds.length] ?? 0);
      const open = given.filter((key) => !closed.includes(key));
      rounds.push({ given, closed });
      return {
        prompt_version: "closure_verify_v1",
        per_finding: given.map((finding_key) => ({
          finding_key,
          status: closed.includes(finding_key) ? "closed" : "not_closed",
          pointer: "src/feature.ts",
        })),
        deterministic_failure: null,
        all_closed: open.length === 0,
        open_keys: open,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost_micros: 30,
        cost_basis: "provider_list_estimate",
      };
    }) as never;
    return { verify, rounds };
  };

  const writesPerRound = () =>
    agentDouble((worktree, round) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", `round-${round}.ts`), `export const round = ${round};\n`);
    });

  it("runs a third round after 2 and 1 closures, then stalls on the round that closed none", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    config.max_remediation_rounds = 6;

    const findings = routed(4);
    const agent = writesPerRound();
    const verifier = verifying([2, 1, 0]);
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: reviewing(findings), verify: verifier.verify },
    });

    // Three remediation rounds ran under a rule that used to allow two, and
    // the third is the one that ended the ticket.
    expect(verifier.rounds.map((round) => round.closed.length)).toEqual([2, 1, 0]);
    expect(result.rounds.map((round) => round.round)).toEqual([0, 1, 2, 3]);
    expect(result.outcome).toBe("remediation_stalled");
    // The key still open, named where a person reads the stop.
    expect(result.detail).toContain(findings[3]!.key);
    expect(result.detail).toContain("closed none");
  }, 90_000);

  it("finishes on the third round when each round closes one", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    config.max_remediation_rounds = 6;

    const agent = writesPerRound();
    const verifier = verifying([1, 1, 1]);
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: reviewing(routed(3)), verify: verifier.verify },
    });

    expect(verifier.rounds.map((round) => round.given.length)).toEqual([3, 2, 1]);
    expect(result.rounds).toHaveLength(4);
    const last = result.rounds[3]!;
    expect(last.verification?.all_closed).toBe(true);
    expect(result.outcome).toBe("approved");
  }, 90_000);

  it("stops at the cap while it is still closing findings, and says which cap", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    config.max_remediation_rounds = 2;

    const agent = writesPerRound();
    const verifier = verifying([1, 1]);
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: reviewing(routed(3)), verify: verifier.verify },
    });

    // Progress every round, and the cap — not the progress rule — is what ends
    // it, so the stop is `remediation_exhausted` and names the setting.
    expect(verifier.rounds.map((round) => round.closed.length)).toEqual([1, 1]);
    expect(result.outcome).toBe("remediation_exhausted");
    expect(result.detail).toContain("max_remediation_rounds");
  }, 90_000);
});

describe("a re-run of a ticket whose last review left findings open", () => {
  const findings = [
    finding({ key: "a".repeat(64), rule_id: "test.missing_for_criterion_a" }),
    finding({ key: "b".repeat(64), rule_id: "test.missing_for_criterion_b" }),
  ];

  const reviewer = (seen: unknown[]) =>
    (async (input: Record<string, unknown>) => {
      seen.push(input);
      return {
        artifact: makeReview({
          review_id: "rev_0000000000000164",
          decision: "remediable" as const,
          findings,
          head_commit: (input.head_commit as string | undefined) ?? "def5678",
          changeset_id:
            (input.changeset as { changeset_id?: string } | undefined)?.changeset_id ??
            "cs_0000000000000001",
        }),
        bundle: {
          prompt_version: "reviewer_v2",
          system_prompt: "s",
          turns: [],
          files_read: [],
          rejected_verdicts: [],
        },
      };
    }) as never;

  const closesEverything = (seen: unknown[]) =>
    (async (input: Record<string, unknown>) => {
      seen.push(input);
      const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
      return {
        prompt_version: "closure_verify_v1",
        per_finding: keys.map((finding_key) => ({ finding_key, status: "closed", pointer: "src/fix.ts" })),
        deterministic_failure: null,
        all_closed: true,
        open_keys: [],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost_micros: 30,
        cost_basis: "provider_list_estimate",
      };
    }) as never;

  it("starts a remediation round from them rather than reviewing the same commit again", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    // Run 1 gets no remediation round, so it ends with the review on record and
    // both findings open — the state a `changes_requested` ticket is in.
    config.max_remediation_rounds = 0;

    const reviews: unknown[] = [];
    const verifications: unknown[] = [];
    const first = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble((worktree) => {
          mkdirSync(join(worktree, "src"), { recursive: true });
          writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
        }).run as never,
        review: reviewer(reviews),
      },
    });
    expect(first.outcome).toBe("remediation_exhausted");
    expect(reviews).toHaveLength(1);

    config.max_remediation_rounds = 6;
    const agent = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "fix.ts"), "export const fixed = true;\n");
    });
    const second = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: reviewer(reviews), verify: closesEverything(verifications) },
    });

    // No second review of the commit the first one already judged.
    expect(reviews).toHaveLength(1);
    // The run's first round is remediation, and its brief carries the findings.
    expect(second.rounds[0]!.kind).toBe("remediate");
    expect(agent.calls[0]).toContain("remediation round 1");
    expect(agent.calls[0]).toContain(findings[0]!.key);
    expect(verifications).toHaveLength(1);
    expect(second.outcome).toBe("approved");
  }, 90_000);

  it("reviews afresh when the branch has moved since that review", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    config.max_remediation_rounds = 0;

    const reviews: unknown[] = [];
    await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble((worktree) => {
          mkdirSync(join(worktree, "src"), { recursive: true });
          writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
        }).run as never,
        review: reviewer(reviews),
      },
    });
    expect(reviews).toHaveLength(1);

    // Somebody committed to the branch between the runs: the change set is no
    // longer the one that review judged.
    sealOnBranch(repo, contract, { "src/by-hand.ts": "export const byHand = true;\n" });

    config.max_remediation_rounds = 6;
    const second = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble((worktree) => {
          writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 2;\n");
        }).run as never,
        review: reviewer(reviews),
        verify: closesEverything([]),
      },
    });

    expect(reviews).toHaveLength(2);
    expect(second.rounds[0]!.kind).toBe("execute");
    expect(second.rounds[0]!.review).not.toBeNull();
  }, 90_000);
});

describe("a scope escape handed back to a remediation round", () => {
  const scopeFinding = finding({
    key: "5".repeat(64),
    rule_id: "scope.path_outside_allowed",
    file: "src/wide.ts",
    statement: "The change set touches a path the contract does not admit.",
  });
  const otherFinding = finding({
    key: "6".repeat(64),
    rule_id: "test.missing_for_criterion",
    statement: "No test exercises total().",
  });

  it("puts it first with the globs quoted, and refuses a round that widened instead", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    config.max_remediation_rounds = 6;

    const agent = agentDouble((worktree, round) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      if (round === 0) {
        writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
        return;
      }
      // The round was asked to narrow the change set and added a file instead.
      mkdirSync(join(worktree, "test"), { recursive: true });
      writeFileSync(join(worktree, "test", "extra.test.ts"), "// a file nobody asked for\n");
    });

    const verifications: unknown[] = [];
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        // The other finding is listed first by the reviewer; the brief must
        // still lead with the scope one.
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000195",
            decision: "remediable" as const,
            findings: [otherFinding, scopeFinding],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        verify: (async (input: unknown) => {
          verifications.push(input);
          throw new Error("the widened round must be refused before anything verifies it");
        }) as never,
      },
    });

    const brief = agent.calls[1]!;
    // The globs, in the same sentence the guard refuses in, and the scope
    // finding ahead of the other one.
    expect(brief).toContain("writes are admitted only under: `src/**`, `test/**`");
    expect(brief.indexOf(scopeFinding.key)).toBeLessThan(brief.indexOf(otherFinding.key));

    expect(verifications).toHaveLength(0);
    expect(result.outcome).toBe("changes_requested");
    expect(result.detail).toContain("widened the change set");
    expect(result.detail).toContain("test/extra.test.ts");
    expect(result.detail).toContain("writes are admitted only under");
  }, 90_000);
});

describe("a conflict round in the middle of a ticket's rounds", () => {
  /** A commit on the repository's own `main`, made while the run is in flight. */
  const landOnBase = (repo: string, file: string, contents: string): string => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), contents);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", `base: ${file}`);
    return git(repo, "rev-parse", "HEAD").trim();
  };

  it("does not spend a remediation round, so the finding still gets one", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    // One remediation round, and a conflict round that must not be it.
    config.max_remediation_rounds = 1;

    const conflicting = "src/index.ts";
    const agent = agentDouble((worktree, round) => {
      if (round === 0) {
        writeFileSync(join(worktree, conflicting), "export const version = 2;\n");
        landOnBase(repo.dir, conflicting, "export const version = 3;\n");
        return;
      }
      if (round === 1) {
        // The conflict round's only task.
        writeFileSync(join(worktree, conflicting), "export const version = 3;\n");
        return;
      }
      mkdirSync(join(worktree, "test"), { recursive: true });
      writeFileSync(join(worktree, "test", "feature.test.ts"), "// exercises total()\n");
    });

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000192",
            decision: "remediable" as const,
            findings: [finding()],
          }),
          bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
        })) as never,
        verify: (async (input: Record<string, unknown>) => {
          const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
          return {
            prompt_version: "closure_verify_v1",
            per_finding: keys.map((finding_key) => ({ finding_key, status: "closed", pointer: "test/feature.test.ts" })),
            deterministic_failure: null,
            all_closed: true,
            open_keys: [],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 30,
            cost_basis: "provider_list_estimate",
          };
        }) as never,
      },
    });

    expect(result.rounds.map((round) => round.kind)).toEqual([
      "execute",
      "resolve_conflict",
      "remediate",
    ]);
    // The cap is one remediation round, and the conflict did not consume it.
    expect(result.outcome).toBe("approved");
  }, 90_000);
});

/**
 * D-107, through the loop: what the round hands the checks and what it records.
 *
 * The two cases are one pair — the same repository, the same executor, the
 * same pinned check, and only the plan's graph different. A flat plan's
 * assertion says nothing on its own; beside the graphed one it says the node
 * results the loop records come from the plan's nodes and nowhere else.
 */
describe("a graphed ticket's round", () => {
  /** A two-node plan over the same scope `makeContract` declares. */
  const graphed = (base_commit: string): PlanContract => {
    const contract = makeContract();
    // A P0 carries no acceptance criteria to extend; `makeContract` builds a P1.
    if (contract.level === "P0") throw new Error(`the fixture contract is ${contract.level}`);
    return PlanContractSchema.parse({
      ...contract,
      base: { ...contract.base, base_commit },
      acceptance_criteria: [
        ...contract.acceptance_criteria,
        {
          id: "ac_2",
          text: "a test exercises total()",
          expected_verification: { kind: "test", assertion: "the suite names total()" },
        },
      ],
      nodes: [
        { id: "node_module", title: "The module", criteria: ["ac_1"], paths: ["src/**"] },
        { id: "node_tests", title: "Its tests", criteria: ["ac_2"], paths: ["test/**"] },
      ],
    });
  };

  /** An executor that writes one source file and one test file. */
  const writesBoth = () =>
    agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      mkdirSync(join(worktree, "test"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
      writeFileSync(join(worktree, "test", "feature.test.ts"), "// exercises total()\n");
    });

  it("records the pinned check once per node beside the whole-change result", async () => {
    const repo = makeRepo();
    const contract = graphed(repo.head);
    const config = makeConfig(repo.dir);
    const agent = writesBoth();
    const reviewInputs: Array<Record<string, unknown>> = [];

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    const checks = result.rounds[0]!.checks;
    expect(checks).toHaveLength(3);

    const whole = checks.filter((check) => check.node === undefined);
    expect(whole).toHaveLength(1);
    expect(whole[0]!.status).toBe("passed");

    // The node whose paths hold only a source file has no test file for the
    // narrow form, so the check ran over the change for it and said so.
    const module = checks.find((check) => check.node?.node_id === "node_module")!;
    expect(module.node?.scope).toBe("task");
    expect(module.node?.note).toContain("test file");

    // The node whose paths hold the change's test file was narrowed to it.
    // The fixture worktree has no test runner to resolve, so this asserts what
    // the run was aimed at and not what it concluded.
    const tests = checks.find((check) => check.node?.node_id === "node_tests")!;
    expect(tests.node?.scope).toBe("files");
    expect(tests.node?.paths).toEqual(["test/feature.test.ts"]);

    // D-107: reviewed once per node, in plan order, then once overall — three
    // calls. A node's own call is handed only that node's own check result; the
    // overall call, last, is handed the whole-change result and nothing tagged.
    expect(reviewInputs).toHaveLength(3);
    const [moduleCall, testsCall, overallCall] = reviewInputs as Array<{ checks: Array<{ node?: { node_id?: string } }> }>;
    expect(moduleCall!.checks).toHaveLength(1);
    expect(moduleCall!.checks[0]!.node?.node_id).toBe("node_module");
    expect(testsCall!.checks).toHaveLength(1);
    expect(testsCall!.checks[0]!.node?.node_id).toBe("node_tests");
    // A node's result is evidence for that node's review and gates nothing:
    // the overall call is handed the whole-change result, and the gate is open.
    expect(overallCall!.checks).toHaveLength(1);
    expect(overallCall!.checks[0]!.node).toBeUndefined();
    expect(result.outcome).toBe("approved");
  }, 90_000);

  it("records no node at all for a plan without a graph", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const agent = writesBoth();
    const reviewInputs: Array<Record<string, unknown>> = [];

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approvingReview(reviewInputs) },
    });

    expect(result.rounds[0]!.checks).toHaveLength(1);
    expect(result.rounds[0]!.checks.every((check) => check.node === undefined)).toBe(true);
    expect((reviewInputs[0]!.checks as unknown[])).toHaveLength(1);
    expect(result.outcome).toBe("approved");
    // AC5: a flat plan has no nodes to review on their own, so the reviewer is
    // called exactly once, unchanged, and there is no per-node record.
    expect(reviewInputs).toHaveLength(1);
    expect(result.node_reviews).toEqual([]);
    expect(result.rounds[0]!.node_reviews).toEqual([]);
    // A flat plan has no node to build a model for, so reviewGraph never
    // calls the model factory: the one call carries the one model the loop
    // itself built, the same as before reviewGraph existed.
    expect(reviewInputs[0]!.model).toBeDefined();
  }, 90_000);

  it("a node-only blocking finding closes the gate the overall call alone left open", async () => {
    const repo = makeRepo();
    const contract = graphed(repo.head);
    const config = makeConfig(repo.dir);
    const agent = writesBoth();
    const reviewInputs: Array<Record<string, unknown>> = [];
    const blocking = finding({ key: "a".repeat(64), blocking: true, routing: "blocks", criterion_id: "ac_1" });
    // Node order: `node_module` (blocking), then `node_tests`, then the
    // overall — both approve on their own, so only the node's finding can be
    // why the ticket ends changes_requested.
    const outcomes = [
      { review_id: "rev_000000000000a001", decision: "changes_requested" as const, findings: [blocking] },
      { review_id: "rev_000000000000b001", decision: "approve" as const },
      { review_id: "rev_000000000000f001", decision: "approve" as const },
    ];
    let call = 0;
    const review = (async (input: Record<string, unknown>) => {
      reviewInputs.push(input);
      const script = outcomes[call]!;
      call += 1;
      return {
        artifact: makeReview(script),
        bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
      };
    }) as never;

    const result = await runTicket({ config, contract, hooks: { agent: agent.run as never, review } });

    expect(reviewInputs).toHaveLength(3);
    expect(result.node_reviews.map((entry) => entry.node_id)).toEqual(["node_module", "node_tests"]);
    expect(result.node_reviews[0]!.review?.decision).toBe("changes_requested");
    expect(result.node_reviews[1]!.review?.decision).toBe("approve");
    // The overall call and node_tests both approved; only node_module blocked.
    expect(result.outcome).toBe("changes_requested");
    expect(result.final_review?.findings.some((entry) => entry.key === blocking.key)).toBe(true);
    // Each of the three calls carries its own model, built from its own
    // narrowed contract and checks (D-107): a shared one would offer a
    // node's call a schema for criteria and checks that are not its own.
    const models = reviewInputs.map((input) => input.model);
    expect(new Set(models).size).toBe(3);
  }, 90_000);
});
