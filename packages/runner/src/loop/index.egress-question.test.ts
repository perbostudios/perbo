import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, readEgressQuestion, readEgressSettled } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { TicketRunConfigSchema, runTicket } from "./index.js";
import { answerEgressQuestion, readEgressQuestions } from "../egress-questions.js";
import { fakeAgent, type ScriptedStep } from "../test-support/fake-agent.js";
import { makeContract, makeReview } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/** A live run of the ticket that started before any question here was asked. */
const RUN_BEFORE = [{ started_at: "2026-01-01T00:00:00.000Z" }];

/**
 * The question end to end, as a run asks it (D-NEW-an-unlisted-host-asks):
 * the executor's call is held by the write guard's hook, the run records the
 * question on the ticket and prints it, a person answers it on the ticket's
 * record — as `perbo verdict --egress` does — and the same attempt carries on
 * with the held call let through or refused.
 */

const HOST = "googlechromelabs.github.io";
const OTHER = "storage.googleapis.com";
const fetchFrom = (host: string) => `npx @puppeteer/browsers install chrome@stable --base-url https://${host}/chrome`;
const call = (id: string, command: string): ScriptedStep[] => [
  { step: "tool_use", id, tool: "Bash", input: { command } },
  { step: "hook", id, tool: "Bash", input: { command }, reply: true },
];

/** A reviewer that approves, so nothing here spends on a real one. */
const review = (async () => ({
  artifact: makeReview({
    review_id: "rev_0000000000000900",
    decision: "approve",
    coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
    findings: [],
  }),
  bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
})) as never;

async function runAsking(steps: ScriptedStep[], choice: "allow" | "refuse") {
  const repo = runnerRepository(scratch);
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  const root = scratch("perbo-egress-run-");
  const agent = fakeAgent(scratch, [{ kind: "scripted", steps: [...steps, { step: "result" }] }]);
  const config = TicketRunConfigSchema.parse({
    ticket_key: "SCP900",
    repository_root: repo.dir,
    base_ref: "main",
    worktree_root: join(root, "worktrees"),
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
    agent_binary: agent.binary,
    model: "double",
    max_remediation_rounds: 0,
    limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
  });
  const recordPath = join(root, "state", `${contract.ticket_id}.egress.json`);
  const printed: string[] = [];
  let answered = false;
  const result = await runTicket({
    config,
    contract,
    hooks: { review },
    onProgress: (line) => {
      printed.push(line);
      // The person answers once the run has asked, on the ticket's record.
      const question = readEgressQuestion(line);
      if (question !== null && !answered) {
        answered = true;
        answerEgressQuestion({ path: recordPath, key: question.key, choice, author: "Ada <ada@example.org>", now: new Date(), liveRuns: RUN_BEFORE });
      }
    },
  });
  const attempts = JSON.parse(readFileSync(join(root, "state", `${contract.ticket_id}.attempts.json`), "utf8")) as {
    attempts: Array<{
      attempt_id: string;
      egress: Array<{ host: string; decision: string }>;
      termination: { reason: string };
      commands: Array<{ decision: string; denial_rule: string | null }>;
      permission_profile: { network_allow_list: string[] };
    }>;
  };
  return { result, printed, recordPath, attempts: attempts.attempts, configPath: join(repo.dir, ".perbo", "config.json") };
}

describe("a run's egress question, end to end", () => {
  it("asks, takes the allow, writes the host to the repository's configuration, and the same attempt runs on", async () => {
    const run = await runAsking(call("toolu_1", fetchFrom(HOST)), "allow");
    const [question] = readEgressQuestions(run.recordPath)!.questions;
    expect(question).toMatchObject({ host: HOST, command: fetchFrom(HOST), answer: { choice: "allow" } });
    expect(question!.attempt_id).toBe(run.attempts[0]!.attempt_id);
    expect(run.printed.map(readEgressSettled).filter((line) => line !== null)).toEqual([
      { key: question!.key, host: HOST, settled: "allowed" },
    ]);
    expect(JSON.parse(readFileSync(run.configPath, "utf8"))).toMatchObject({ network_allow_list: [HOST] });
    // One attempt, which did not stop on the host and recorded it allowed.
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]!.termination.reason).not.toBe("unlisted_egress_host");
    expect(run.attempts[0]!.egress).toEqual([expect.objectContaining({ host: HOST, decision: "allowed" })]);
    expect(run.attempts[0]!.permission_profile.network_allow_list).toContain(HOST);
  }, 120_000);

  it("takes the refusal, refuses a later host without asking, and records every host that was tried", async () => {
    const run = await runAsking([...call("toolu_1", fetchFrom(HOST)), ...call("toolu_2", fetchFrom(OTHER))], "refuse");
    const questions = readEgressQuestions(run.recordPath)!.questions;
    expect(questions.map((question) => [question.host, question.answer?.choice])).toEqual([[HOST, "refuse"]]);
    expect(run.printed.map(readEgressQuestion).filter((line) => line !== null)).toHaveLength(1);
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]!.termination.reason).not.toBe("unlisted_egress_host");
    expect(run.attempts[0]!.egress.map((record) => [record.host, record.decision])).toEqual([
      [HOST, "denied"],
      [OTHER, "denied"],
    ]);
    expect(run.attempts[0]!.commands.map((command) => command.denial_rule)).toEqual(["unlisted_egress_host", "unlisted_egress_host"]);
    expect(existsSync(run.configPath) && JSON.parse(readFileSync(run.configPath, "utf8")).network_allow_list).toBeFalsy();
  }, 120_000);
});
