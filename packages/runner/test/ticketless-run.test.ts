import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CheckResultsFileSchema,
  LimitsTableSchema,
  planContractFromSource,
  sourceContractFromArguments,
  type PlanContractWithCriteria,
  type RunBundle,
} from "@perbo/contracts";
import { scratchDirectories, watchOutbound } from "@perbo/test-support";
import { BundleStore } from "../src/bundle.js";
import { TicketRunConfigSchema, runTicket } from "../src/loop.js";
import { fakeAgent } from "../src/test-support/fake-agent.js";
import { finding, makeReview, withoutInstall } from "../src/test-support/records.js";
import { runnerRepository } from "../src/test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The loop on a contract nobody admitted (AYO-32).
 *
 * `perbo run --ticket AYO-1` hands the loop a contract a person approved. This
 * file hands it one minted here from what a person typed — the same
 * `sourceContractFromArguments` and `planContractFromSource` the command uses,
 * with no ticket, no admission and no key — and points the store at the
 * repository's own `.perbo/`. What is asserted is what the run leaves on disk
 * afterwards: the attempts record, the bundles, the results of the pinned
 * checks that judged each round, and the one independent review, all read back
 * with the shipped `BundleStore` rather than from anything this file wrote.
 *
 * The executor is a real binary the runner spawns, so the attempt, the seal,
 * the checks and the ceilings are the shipped code throughout; only the two
 * steps that cost a provider money — the review and the closure verification —
 * are doubles.
 *
 * **Fail-first, measured rather than argued.** Nothing here imports a module or
 * a symbol the change adds, so this file loads at the commit before it and each
 * test fails on the behaviour it is about instead of on an import that cannot
 * resolve.
 *
 * Taken on 2026-09-04: `packages/contracts/src` and `packages/runner/src`
 * restored to 4377cdb, the workspace packages rebuilt, then `pnpm exec vitest
 * run test/ticketless-run.test.ts` in `packages/runner`. Result: 4 of 4 failed,
 * each on `the execution bundle carries no checks.json` — at that commit the
 * loop ran the pinned checks and kept the results nowhere a reader could reach
 * them for a round no review reported. The same command after the change: 4
 * passed.
 */

const OUTCOME = "The feature module exports a computed total";
const CRITERION = "total() returns the sum of its inputs :: total([1,2]) is 3 :: test";

afterEach(() => vi.restoreAllMocks());

/**
 * The contract as `perbo run --outcome … --criterion …` mints it, and the
 * label that stands where a ticket key would.
 *
 * The label is the plan's own identity, read off the contract: with nothing
 * admitted the command labels the run by where its contract came from, and the
 * plan is keyed by the same string, so taking it from the contract is taking
 * the one the command uses.
 */
function mint(repo: { head: string }): { contract: PlanContractWithCriteria; label: string } {
  const source = sourceContractFromArguments({ outcome: OUTCOME, criteria: [CRITERION] });
  const contract = planContractFromSource({
    contract: source,
    base_commit: repo.head,
    repository_id: "repo_fixture",
    paths_allowed: ["src/**", "test/**"],
    captured_at: new Date("2026-09-04T00:00:00.000Z"),
  });
  return { contract, label: contract.ticket_id.replace(/^ticket_/, "") };
}

/**
 * The run configuration a local run gets: the record roots inside the
 * repository's own store, and the label the contract's source produced standing
 * where a ticket key would be. The worktrees go outside the checkout, which is
 * where the command's own derived default puts them — a worktree underneath it
 * would inherit the repository's package-manager workspace.
 */
function localConfig(
  repo: { dir: string },
  label: string,
  overrides: Record<string, unknown> = {},
) {
  return TicketRunConfigSchema.parse({
    ticket_key: label,
    repository_root: repo.dir,
    base_ref: "main",
    worktree_root: join(scratch("perbo-ticketless-"), "worktrees"),
    bundle_root: join(repo.dir, ".perbo", "bundles"),
    quarantine_root: join(repo.dir, ".perbo", "quarantine"),
    state_root: join(repo.dir, ".perbo", "state"),
    checks: [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        command: ["node", "-e", "process.exit(0)"],
        timeout_ms: 30_000,
      },
    ],
    model: "double",
    materialization_manifest: withoutInstall(repo.dir),
    limits: LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4 },
    }),
    ...overrides,
  });
}

/**
 * A reviewer that returns one verdict without a provider behind it, stating as
 * its target the change set it was handed — which is what a reviewer does: it
 * is told what to judge and says so in its verdict.
 */
const reviewer =
  (decision: "approve" | "remediable") =>
  async (request: {
    changeset?: { changeset_id: string };
    head_commit?: string;
  }) => ({
    artifact: makeReview({
      review_id: "rev_0000000000000001",
      decision,
      // Both are optional on the request, so an absent one is left out rather
      // than passed as undefined; `makeReview` then supplies its own default.
      ...(request.changeset === undefined ? {} : { changeset_id: request.changeset.changeset_id }),
      ...(request.head_commit === undefined ? {} : { head_commit: request.head_commit }),
      findings: decision === "remediable" ? [finding()] : [],
    }),
    bundle: {
      prompt_version: "reviewer_v2" as const,
      system_prompt: "s",
      turns: [],
      files_read: [],
      rejected_verdicts: [],
    },
  });

/** A closure verification that closes what it is handed. */
const verifier = async (input: { findings: ReadonlyArray<{ key: string }> }) => ({
  prompt_version: "closure_verify_v1",
  per_finding: input.findings.map((entry) => ({
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
});

const storeOf = (repo: { dir: string }) =>
  new BundleStore({ root: join(repo.dir, ".perbo", "bundles"), retainContext: true });

/** One artifact's bytes, as the store retained them. */
function artifactOf(store: BundleStore, bundle: RunBundle, name: string): string {
  const ref = bundle.artifacts.find((artifact) => artifact.name === name);
  expect(ref, `the ${bundle.kind} bundle carries no ${name}`).toBeDefined();
  const body = store.readObject(ref!.sha256);
  expect(body, `${name} is referenced but its bytes are not in the store`).not.toBeNull();
  return body!;
}

/** The check results one attempt's own bundle records, as the store holds them. */
function checksRecordedFor(repo: { dir: string }, ticketId: string, attemptId: string) {
  const store = storeOf(repo);
  const execution = store
    .forTicket(ticketId)
    .find((bundle) => bundle.kind === "execution" && bundle.subject_id === attemptId);
  expect(execution, `no execution bundle for ${attemptId}`).toBeDefined();
  return CheckResultsFileSchema.parse(JSON.parse(artifactOf(store, execution!, "checks.json")));
}

/** Every file under a directory, by its path relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(dir, path));
    }
  };
  walk(dir);
  return found.sort();
}

const writes = (file: string, contents: string) =>
  ({ kind: "succeed", file, contents }) as const;

describe("a run with nothing admitted behind it", () => {
  it("leaves attempts, bundles, checks and review in the repository's own .perbo/", async () => {
    const repo = runnerRepository(scratch);
    const { contract, label } = mint(repo);
    const agent = fakeAgent(scratch, [
      writes("src/feature.ts", "export const total = (n) => n.reduce((a, b) => a + b, 0);\n"),
    ]);
    // Nothing on this path may reach a hosted plane, so every socket this
    // process opens is watched rather than assumed absent.
    const outbound = watchOutbound();

    const result = await runTicket({
      config: localConfig(repo, label, { agent_binary: agent.binary }),
      contract,
      hooks: { review: reviewer("approve") as never },
    });

    expect(result.outcome).toBe("approved");
    // Keyed by where the contract came from — a digest of the outcome that was
    // typed. There is no ticket, and nothing invented a key to stand in for one.
    expect(contract.ticket_id).toMatch(/^ticket_local_[0-9a-f]{12}$/);
    expect(label).toMatch(/^local_[0-9a-f]{12}$/);

    const attempt = result.rounds[0]!.attempt;
    const attempts = JSON.parse(
      readFileSync(join(repo.dir, ".perbo", "state", `${contract.ticket_id}.attempts.json`), "utf8"),
    ) as { ticket_id: string; attempts: Array<{ attempt_id: string }> };
    expect(attempts.ticket_id).toBe(contract.ticket_id);
    expect(attempts.attempts.map((entry) => entry.attempt_id)).toEqual([attempt.attempt_id]);

    const store = storeOf(repo);
    const bundles = store.forTicket(contract.ticket_id);
    const execution = bundles.find(
      (bundle) => bundle.kind === "execution" && bundle.subject_id === attempt.attempt_id,
    );
    expect(execution).toBeDefined();
    expect(JSON.parse(artifactOf(store, execution!, "attempt.json"))).toMatchObject({
      attempt_id: attempt.attempt_id,
      ticket_id: contract.ticket_id,
    });

    // The deterministic half of the judgement, in the store beside the attempt
    // it judged rather than only inside the verdict that quoted it.
    const checks = checksRecordedFor(repo, contract.ticket_id, attempt.attempt_id);
    expect(checks.map((check) => [check.name, check.status])).toEqual([["unit", "passed"]]);
    expect(checks).toEqual(result.rounds[0]!.checks);

    // And the one independent review, joined to the attempt by the change set:
    // the reviewer was handed the one the runner sealed, and both records name
    // it, which is what `inspect` reads a review back through.
    const review = bundles.find(
      (bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"),
    );
    expect(review).toBeDefined();
    expect(review!.inputs.changeset_id).toBe(attempt.changeset_id);
    expect(JSON.parse(artifactOf(store, review!, "review.json")).decision).toBe("approve");

    // Nothing left the machine: no socket this process opened, and no host the
    // attempt named — the second is the half of it the executor's own child
    // processes could have used.
    expect(outbound.destinations()).toEqual([]);
    expect(attempt.egress).toEqual([]);

    // And no ticket key is anywhere in what was kept.
    const store_dir = join(repo.dir, ".perbo");
    const written = filesUnder(store_dir);
    expect(written.some((path) => path.startsWith("state"))).toBe(true);
    expect(written.some((path) => path.startsWith("bundles"))).toBe(true);
    for (const path of written) {
      expect(readFileSync(join(store_dir, path), "utf8"), path).not.toMatch(/\bAYO-\d+\b/);
    }
  }, 120_000);

  it("records what a remediation round's checks measured, which no review reports", async () => {
    const repo = runnerRepository(scratch);
    const { contract, label } = mint(repo);
    const agent = fakeAgent(scratch, [
      writes("src/feature.ts", "export const total = (n) => n.reduce((a, b) => a + b, 0);\n"),
      writes("test/feature.test.ts", "// exercises total()\n"),
    ]);

    const result = await runTicket({
      config: localConfig(repo, label, { agent_binary: agent.binary, max_remediation_rounds: 1 }),
      contract,
      hooks: { review: reviewer("remediable") as never, verify: verifier as never },
    });

    expect(result.outcome).toBe("approved");
    expect(result.rounds.map((round) => round.round)).toEqual([0, 1]);

    // Round 1 was verified, not reviewed — D-061 — so no review artifact quotes
    // its checks. The store holds them because the round recorded its own.
    const reviews = storeOf(repo)
      .forTicket(contract.ticket_id)
      .filter((bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"));
    expect(reviews.map((bundle) => bundle.inputs.remediation_round)).toEqual([0]);

    for (const round of result.rounds) {
      const checks = checksRecordedFor(repo, contract.ticket_id, round.attempt.attempt_id);
      expect(checks.map((check) => [check.name, check.status]), `round ${round.round}`).toEqual([
        ["unit", "passed"],
      ]);
      expect(checks, `round ${round.round}`).toEqual(round.checks);
    }
  }, 180_000);
});

describe("the ceilings a run with nothing admitted stops at", () => {
  it("stops where the spend crosses the ceiling, and keeps the stopped attempt's record", async () => {
    const repo = runnerRepository(scratch);
    const { contract, label } = mint(repo);
    // The executor reports $0.002; the ceiling is a tenth of that. D-096: a
    // cost ceiling cuts only an executor billed per token, so the credential
    // the attempt records has to be an API key for one to be in force at all.
    const agent = fakeAgent(scratch, [writes("src/feature.ts", "export const total = 1;\n")], {
      apiKeySource: "ANTHROPIC_API_KEY",
    });

    const result = await runTicket({
      config: localConfig(repo, label, {
        agent_binary: agent.binary,
        limits: {
          organisation: "test",
          // SCP-193: the ticket budget is pinned under one attempt's cost, so
          // the per-attempt ceiling is what ends this run rather than the first
          // of several attempts over the sealed branch.
          limits: { concurrent_local_attempts: 4, attempt_cost_micros: 200, ticket_cost_micros: 1 },
        },
      }),
      contract,
      hooks: { review: reviewer("approve") as never },
    });

    expect(result.outcome).toBe("terminated");
    expect(result.rounds).toHaveLength(1);
    const attempt = result.rounds[0]!.attempt;
    expect(attempt.termination.reason).toBe("cost_ceiling_exceeded");
    // The setting that raises it, named with the file it lives in.
    expect(result.detail).toContain("limits.limits.attempt_cost_micros");
    expect(result.detail).toContain(join(repo.dir, ".perbo", "config.json"));

    // It spent money on the way to being stopped, and the record says how much.
    expect(attempt.usage.cost_micros).toBe(2_000);
    const attempts = JSON.parse(
      readFileSync(join(repo.dir, ".perbo", "state", `${contract.ticket_id}.attempts.json`), "utf8"),
    ) as { attempts: Array<{ attempt_id: string; usage: { cost_micros: number } }> };
    expect(attempts.attempts).toHaveLength(1);
    expect(attempts.attempts[0]!.usage.cost_micros).toBe(2_000);
    // A stop is not a hole in the record: the attempt's bundle still carries
    // what the pinned set made of the tree it sealed.
    expect(checksRecordedFor(repo, contract.ticket_id, attempt.attempt_id)).toEqual(
      result.rounds[0]!.checks,
    );
  }, 120_000);

  it("stops after one attempt when the ceiling allows one, with that attempt priced", async () => {
    const repo = runnerRepository(scratch);
    const { contract, label } = mint(repo);
    const agent = fakeAgent(scratch, [writes("src/feature.ts", "export const total = 1;\n")]);

    // The reviewer routes a finding back, so a second attempt is what this run
    // would do next and the ceiling is the only thing that stops it.
    const result = await runTicket({
      config: localConfig(repo, label, {
        agent_binary: agent.binary,
        limits: {
          organisation: "test",
          limits: { concurrent_local_attempts: 4, remediation_rounds: 0 },
        },
      }),
      contract,
      hooks: { review: reviewer("remediable") as never, verify: verifier as never },
    });

    expect(result.outcome).toBe("remediation_exhausted");
    expect(result.rounds).toHaveLength(1);
    expect(agent.invocations()).toHaveLength(1);
    const attempt = result.rounds[0]!.attempt;
    const attempts = JSON.parse(
      readFileSync(join(repo.dir, ".perbo", "state", `${contract.ticket_id}.attempts.json`), "utf8"),
    ) as { attempts: unknown[] };
    expect(attempts.attempts).toHaveLength(1);

    // What the one attempt and the one review cost, on the records themselves.
    const bundles = storeOf(repo).forTicket(contract.ticket_id);
    const execution = bundles.find((bundle) => bundle.subject_id === attempt.attempt_id);
    expect(execution!.usage.cost_micros).toBe(attempt.usage.cost_micros);
    expect(execution!.usage.cost_micros).toBe(2_000);
    const review = bundles.find(
      (bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"),
    );
    expect(review!.usage.cost_micros).toBe(result.rounds[0]!.review!.cost_micros);
    // And the checks that judged the attempt the ceiling ended the run on.
    expect(checksRecordedFor(repo, contract.ticket_id, attempt.attempt_id)).toEqual(
      result.rounds[0]!.checks,
    );
  }, 120_000);
});
