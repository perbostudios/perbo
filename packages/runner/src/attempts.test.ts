import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, type TerminationReason } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "./adapter.js";
import {
  AttemptIdCollisionError,
  AttemptsRecordError,
  appendAttempts,
  lastAttemptId,
  readAttemptsRecord,
  rootAttemptId,
  runNumbers,
  runsOnRecord,
  sealedByAttempt,
  specCommitOnRecord,
} from "./attempts.js";
import { BundleStore } from "./bundle.js";
import { EgressLog } from "./egress.js";
import { TicketRunConfigSchema, runTicket } from "./loop/index.js";
import { makeAttempt, makeContract, makeReview } from "./test-support/records.js";
import { runnerRepository } from "./test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * Re-running one approved contract.
 *
 * The contract is immutable after approval, so the run that follows a stop is
 * the same plan at the same version against the same ticket. What separates the
 * two on the record is the run count, and the whole of the earlier run — its
 * termination, its bundle, its place in the order — has to survive the later
 * one. These tests drive the real loop twice with the agent and the reviewer
 * replaced; everything between them is the production path.
 */

const RECORD_TICKET = "ticket_SCP094";

function makeConfig(repositoryRoot: string, root: string, runs_started: number | null) {
  return TicketRunConfigSchema.parse({
    ticket_key: "SCP094",
    repository_root: repositoryRoot,
    base_ref: "main",
    worktree_root: join(root, "worktrees"),
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
    checks: [],
    agent_binary: "true",
    model: "double",
    runs_started,
    limits: LimitsTableSchema.parse({
      organisation: "test",
      // SCP-193: a ceiling now starts another attempt over the sealed branch
      // until the ticket budget is spent, so the budget is pinned below one
      // attempt's cost to keep run 1 a single ceiling-stopped attempt.
      limits: { concurrent_local_attempts: 4, ticket_cost_micros: 1 },
    }),
  });
}

/** An executor that writes one file and stops the way it was told to. */
function executorDouble(behaviour: {
  file: string;
  termination?: { reason: TerminationReason; detail: string };
}) {
  return async (request: {
    worktree: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    writeFileSync(join(request.worktree, "src", behaviour.file), `export const from = "${behaviour.file}";\n`);
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
        cost_partial: behaviour.termination !== undefined,
        iterations: 1,
      },
      termination: behaviour.termination ?? { reason: "completed", detail: "" },
      final_message: null,
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
}

const approves = (review_id: string) =>
  async () => ({
    artifact: makeReview({
      review_id,
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
  });

describe("the root attempt id of a run", () => {
  it("is the contract plus the ticket's run count, so a re-run mints a different one", () => {
    const contract = { plan_id: "plan_stage2", plan_version: 1, ticket_key: "SCP094" };

    const first = rootAttemptId({ ...contract, runs_started: 1 });
    const second = rootAttemptId({ ...contract, runs_started: 2 });

    // The same immutable contract, run twice: two ids.
    expect(first).not.toBe(second);
    // And the id is a function of its inputs, not of the moment it was minted.
    expect(rootAttemptId({ ...contract, runs_started: 1 })).toBe(first);
    expect(rootAttemptId({ ...contract, runs_started: 2 })).toBe(second);
    expect(first).toMatch(/^att_[0-9a-f]{16}$/);

    // Each of the other three inputs moves it too, so an id identifies one run
    // of one plan version against one ticket and nothing looser.
    expect(rootAttemptId({ ...contract, plan_id: "plan_other0001", runs_started: 1 })).not.toBe(first);
    expect(rootAttemptId({ ...contract, plan_version: 2, runs_started: 1 })).not.toBe(first);
    expect(rootAttemptId({ ...contract, ticket_key: "SCP095", runs_started: 1 })).not.toBe(first);
  });
});

describe("writing the attempts record", () => {
  const seed = (name: string) => {
    const path = join(scratch(name), "state", `${RECORD_TICKET}.attempts.json`);
    const prior = makeAttempt({ attempt_id: "att_run1round0", head_commit: "aaaaaaa" });
    appendAttempts({ path, ticket_id: RECORD_TICKET, attempts: [prior] });
    return { path, prior };
  };

  it("appends the new run's attempts after the ones already on the record", () => {
    const { path, prior } = seed("perbo-append-");

    const second = makeAttempt({
      attempt_id: "att_run2round0",
      continues_attempt_id: prior.attempt_id,
      head_commit: "bbbbbbb",
    });
    const third = makeAttempt({
      attempt_id: "att_run2round1",
      root_attempt_id: second.attempt_id,
      continues_attempt_id: second.attempt_id,
      remediation_round: 1,
      head_commit: "ccccccc",
    });
    appendAttempts({ path, ticket_id: RECORD_TICKET, attempts: [second, third] });

    const record = readAttemptsRecord(path)!;
    expect(record.attempts.map((attempt) => attempt.attempt_id)).toEqual([
      "att_run1round0",
      "att_run2round0",
      "att_run2round1",
    ]);
    // The first run's entry is the record it wrote, not a re-derived one.
    expect(record.attempts[0]).toEqual(JSON.parse(JSON.stringify(prior)));
    // Two runs, the second of which took a remediation round.
    expect(runNumbers(record.attempts)).toEqual([1, 2, 2]);
    expect(runsOnRecord(record)).toBe(2);
    expect(lastAttemptId(record)).toBe("att_run2round1");
  });

  it("refuses an id the record already holds, names each run either side of it, and writes nothing", () => {
    const { path, prior } = seed("perbo-collide-");
    // Run 1 took a remediation round, so the attempt at risk carries a root
    // that is not its own id and the record says which run wrote it.
    const priorRound1 = makeAttempt({
      attempt_id: "att_run1round1",
      root_attempt_id: prior.root_attempt_id,
      continues_attempt_id: prior.attempt_id,
      remediation_round: 1,
      head_commit: "aaaaaab",
    });
    appendAttempts({ path, ticket_id: RECORD_TICKET, attempts: [priorRound1] });
    const before = readFileSync(path, "utf8");

    // A different attempt, of a different run, under an id the record already
    // holds — what a run whose count did not move would mint.
    const injectedRoot = "att_run2round0";
    const injected = makeAttempt({
      attempt_id: priorRound1.attempt_id,
      root_attempt_id: injectedRoot,
      continues_attempt_id: injectedRoot,
      remediation_round: 1,
      created_at: "2026-08-28T00:00:00.000Z",
      head_commit: "ddddddd",
    });
    const fresh = makeAttempt({ attempt_id: injectedRoot, head_commit: "bbbbbbb" });

    const thrown = (): unknown => {
      try {
        appendAttempts({ path, ticket_id: RECORD_TICKET, attempts: [fresh, injected] });
        return null;
      } catch (error) {
        return error;
      }
    };
    const error = thrown();
    expect(error).toBeInstanceOf(AttemptIdCollisionError);
    const message = (error as Error).message;
    // The colliding id, and both sides of the collision: the run whose attempt
    // the record holds, and the run that minted the id again. Naming the id
    // alone leaves a reader unable to tell which record is at risk, and the two
    // ids a collision is between are the same string.
    expect(message).toContain(priorRound1.attempt_id);
    expect(message).toContain(prior.root_attempt_id);
    expect(message).toContain(injectedRoot);
    expect(message).toContain(path);

    // Refused, not partially applied: the file is byte for byte what it was.
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("counts a record written before attempts carried a root as the one run it held", () => {
    const path = join(scratch("perbo-legacy-"), "state", `${RECORD_TICKET}.attempts.json`);
    mkdirSync(join(path, ".."), { recursive: true });
    // The record as it was written before attempts carried a root: the file
    // held one run's attempts and the next run replaced it, so its three
    // rounds are that one run and not three.
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          ticket_id: RECORD_TICKET,
          attempts: [
            { attempt_id: "att_legacyround0", remediation_round: 0, head_commit: "aaaaaaa" },
            { attempt_id: "att_legacyround1", remediation_round: 1, head_commit: "bbbbbbb" },
            { attempt_id: "att_legacyround2", remediation_round: 2, head_commit: "ccccccc" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const legacy = readAttemptsRecord(path)!;
    expect(runNumbers(legacy.attempts)).toEqual([1, 1, 1]);
    expect(runsOnRecord(legacy)).toBe(1);

    // So the run that follows such a record is run 2, not run 4.
    const next = makeAttempt({
      attempt_id: "att_run2round0",
      continues_attempt_id: lastAttemptId(legacy),
      head_commit: "ddddddd",
    });
    expect(appendAttempts({ path, ticket_id: RECORD_TICKET, attempts: [next] }).runs).toBe(2);
    expect(runNumbers(readAttemptsRecord(path)!.attempts)).toEqual([1, 1, 1, 2]);
  });

  it("refuses to append over a record it cannot read", () => {
    const path = join(scratch("perbo-unreadable-"), "state", `${RECORD_TICKET}.attempts.json`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ this is not the record }\n");

    expect(() =>
      appendAttempts({
        path,
        ticket_id: RECORD_TICKET,
        attempts: [makeAttempt({ attempt_id: "att_run2round0" })],
      }),
    ).toThrow(AttemptsRecordError);
    expect(readFileSync(path, "utf8")).toBe("{ this is not the record }\n");
  });

  it("names five of what it could not read, then how many more (D-NEW-nothing-shown-is-cut)", () => {
    const path = join(scratch("perbo-unreadable-many-"), "state", `${RECORD_TICKET}.attempts.json`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ ticket_id: RECORD_TICKET, attempts: [1, 2, 3, 4, 5, 6, 7] }));

    let said = "";
    try {
      appendAttempts({ path, ticket_id: RECORD_TICKET, attempts: [makeAttempt({ attempt_id: "att_run2round0" })] });
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    expect(said).toContain("attempts.4:");
    expect(said).not.toContain("attempts.5:");
    expect(said).toMatch(/\n {2}and 2 more$/);
  });
});

/**
 * Replacing the attempts record.
 *
 * The record is the only copy of what every earlier run of the ticket did, so
 * the write that ends a run has to land whole or not at all: a half-written
 * record is refused by every later reader, which would stop every later run of
 * the ticket on a file nothing can repair. It is replaced by a rename rather
 * than rewritten in place, and a rename within a directory is the one step
 * that has no middle.
 */
describe("replacing the attempts record", () => {
  it("swaps the file rather than writing through it", () => {
    const state = join(scratch("perbo-atomic-"), "state");
    const path = join(state, `${RECORD_TICKET}.attempts.json`);
    appendAttempts({
      path,
      ticket_id: RECORD_TICKET,
      attempts: [makeAttempt({ attempt_id: "att_run1round0" })],
    });
    const before = readFileSync(path, "utf8");

    // A reader holding the record open across the next run's write. Its handle
    // is on the file the record was, and a rename cannot reach through it — so
    // what it reads is the whole earlier record rather than however much of the
    // later one had been written when it looked.
    const opened = openSync(path, "r");
    try {
      appendAttempts({
        path,
        ticket_id: RECORD_TICKET,
        attempts: [makeAttempt({ attempt_id: "att_run2round0" })],
      });
      expect(readFileSync(opened, "utf8")).toBe(before);
    } finally {
      closeSync(opened);
    }

    // And the path holds the record the run wrote, whole.
    expect(readAttemptsRecord(path)!.attempts).toHaveLength(2);
  });

  it("leaves nothing beside the record when the write completes", () => {
    const state = join(scratch("perbo-nothing-beside-"), "state");
    const path = join(state, `${RECORD_TICKET}.attempts.json`);
    appendAttempts({
      path,
      ticket_id: RECORD_TICKET,
      attempts: [makeAttempt({ attempt_id: "att_run1round0" })],
    });
    appendAttempts({
      path,
      ticket_id: RECORD_TICKET,
      attempts: [makeAttempt({ attempt_id: "att_run2round0" })],
    });

    // The file the write staged is gone, not left for a person to wonder at.
    expect(readdirSync(state)).toEqual([`${RECORD_TICKET}.attempts.json`]);
    expect(readAttemptsRecord(path)!.attempts).toHaveLength(2);
  });
});

describe("a re-run of the same ticket", () => {
  it("keeps the ceiling-stopped run on the record and chains the new one to it", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const root = scratch("perbo-rerun-");
    const attemptsPath = join(root, "state", `${contract.ticket_id}.attempts.json`);
    const bundleStore = () => new BundleStore({ root: join(root, "bundles"), retainContext: true });

    // Run 1 stops at the iteration ceiling, with work sealed on the branch.
    const first = await runTicket({
      config: makeConfig(repo.dir, root, 1),
      contract,
      hooks: {
        agent: executorDouble({
          file: "first.ts",
          termination: {
            reason: "iteration_ceiling_exceeded",
            detail: "attempt_iterations would reach 61, above the limit of 60",
          },
        }) as never,
        review: approves("rev_0000000000000001") as never,
      },
    });
    expect(first.outcome).toBe("terminated");
    const firstAttemptId = first.rounds[0]!.attempt.attempt_id;
    const firstBundle = bundleStore()
      .forTicket(contract.ticket_id)
      .find((bundle) => bundle.kind === "execution" && bundle.subject_id === firstAttemptId)!;
    expect(firstBundle).toBeDefined();

    // Run 2 is the same contract at the same version, with the run count moved
    // on by the ticket's history.
    const second = await runTicket({
      config: makeConfig(repo.dir, root, 2),
      contract,
      hooks: {
        agent: executorDouble({ file: "second.ts" }) as never,
        review: approves("rev_0000000000000002") as never,
      },
    });
    expect(second.outcome).toBe("approved");

    const record = readAttemptsRecord(attemptsPath)!;
    expect(record.attempts).toHaveLength(2);
    const [one, two] = record.attempts as Array<Record<string, unknown>>;

    // The stopped run is still the record it wrote: its own termination, its
    // own bundle, and the commit it sealed.
    expect(one!.attempt_id).toBe(firstAttemptId);
    expect(one!.termination).toEqual({
      reason: "iteration_ceiling_exceeded",
      detail: first.rounds[0]!.attempt.termination.detail,
    });
    expect(one!.head_commit).toBe(first.rounds[0]!.attempt.head_commit);
    const kept = bundleStore()
      .forTicket(contract.ticket_id)
      .find((bundle) => bundle.bundle_id === firstBundle.bundle_id)!;
    expect(kept).toBeDefined();
    expect(kept.subject_id).toBe(firstAttemptId);
    expect(kept.inputs.termination).toBe("iteration_ceiling_exceeded");

    // The re-run minted a distinct chain and named what it continues.
    expect(two!.attempt_id).not.toBe(one!.attempt_id);
    expect(two!.root_attempt_id).not.toBe(one!.root_attempt_id);
    expect(two!.continues_attempt_id).toBe(firstAttemptId);
    expect(two!.attempt_id).toBe(second.rounds[0]!.attempt.attempt_id);
    expect(runNumbers(record.attempts)).toEqual([1, 2]);

    // And because the first run is still on the record, the commit it left on
    // the branch is attributed to the attempt that sealed it rather than
    // carried as a bare sha.
    expect(second.rounds[0]!.attempt.prior_commits).toEqual([
      { sha: first.rounds[0]!.attempt.head_commit, attempt_id: firstAttemptId },
    ]);
  }, 120_000);

  it("counts the runs on its own record when nothing tracks the ticket", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const root = scratch("perbo-rerun-bare-");
    const attemptsPath = join(root, "state", `${contract.ticket_id}.attempts.json`);

    // A bare `--config` run has no ticket history behind it, so `runs_started`
    // is null and the runner counts the runs its own record already holds.
    for (const review of ["rev_0000000000000001", "rev_0000000000000002"]) {
      const result = await runTicket({
        config: makeConfig(repo.dir, root, null),
        contract,
        hooks: {
          agent: executorDouble({ file: `${review}.ts` }) as never,
          review: approves(review) as never,
        },
      });
      expect(result.outcome).toBe("approved");
    }

    const record = readAttemptsRecord(attemptsPath)!;
    expect(record.attempts).toHaveLength(2);
    expect(runNumbers(record.attempts)).toEqual([1, 2]);
    expect(record.attempts[1]!.attempt_id).not.toBe(record.attempts[0]!.attempt_id);
  }, 120_000);
});

describe("what the record on disk says about the commits earlier runs made", () => {
  const record = (attempts: unknown[]) => ({ attempts }) as never;

  it("names the attempt that sealed each commit, across every run of the ticket", () => {
    const sealed = sealedByAttempt(
      record([
        { attempt_id: "att_00000000000000a1", head_commit: "aaa1111" },
        { attempt_id: "att_00000000000000a2", head_commit: null },
        { attempt_id: "att_00000000000000a3", head_commit: "ccc3333" },
      ]),
    );

    expect([...sealed]).toEqual([
      ["aaa1111", "att_00000000000000a1"],
      ["ccc3333", "att_00000000000000a3"],
    ]);
  });

  it("knows nothing where there is no record to read", () => {
    expect(sealedByAttempt(null).size).toBe(0);
  });

  it("skips an attempt it cannot read rather than refusing the whole record", () => {
    expect([...sealedByAttempt(record([{ nothing: true }, { attempt_id: "att_00000000000000a1", head_commit: "aaa1111" }]))]).toEqual([
      ["aaa1111", "att_00000000000000a1"],
    ]);
  });

  it("takes the spec commit from the last attempt that recorded one", () => {
    expect(
      specCommitOnRecord(
        record([
          { spec_commit: "spec111" },
          { spec_commit: null },
          { spec_commit: "spec333" },
          { spec_commit: null },
        ]),
      ),
    ).toBe("spec333");
  });

  it("says no run has made one where nothing on the record names it", () => {
    expect(specCommitOnRecord(record([{ spec_commit: null }, {}]))).toBeNull();
    expect(specCommitOnRecord(null)).toBeNull();
  });
});
