import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEgressQuestion, readEgressSettled } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { answerEgressQuestion, readEgressQuestions } from "../../egress-questions.js";
import type { EgressGate } from "../../egress.js";
import { buildPermissionProfile } from "../../profile.js";
import { RunEgressQuestions } from "./egress.js";

const scratch = scratchDirectories("perbo-runner-");

/** A live run of the ticket that started before any question here was asked. */
const RUN_BEFORE = [{ started_at: "2026-01-01T00:00:00.000Z" }];

/**
 * One run's egress questions (D-137): the first unlisted
 * host asks and the attempt waits on the answer; an allow is that host, on the
 * configuration and the live profile; a refusal closes the run's questions and
 * is remembered on the ticket; nobody answering within the window stops.
 */

const TICKET = "ticket_egress";
const ATTEMPT = "att_egress0000000001";
const HOST = "googlechromelabs.github.io";
const OTHER = "storage.googleapis.com";
const COMMAND = `curl -fsSL https://${HOST}/chrome-for-testing/known-good-versions.json -o versions.json`;

function run(
  root = scratch("perbo-egress-questions-"),
  config: Record<string, unknown> | null = { _comment: "kept", checks: [] },
  clock: () => Date = () => new Date(),
) {
  const recordPath = join(root, "state", `${TICKET}.egress.json`);
  const configPath = join(root, ".perbo", "config.json");
  if (config !== null) {
    mkdirSync(join(root, ".perbo"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  const printed: string[] = [];
  const profile = buildPermissionProfile({ worktree: root });
  const questions = new RunEgressQuestions({
    recordPath,
    ticketId: TICKET,
    ticketKey: "PRB-9",
    configPath,
    profile,
    progress: (line) => printed.push(line),
    clock,
    pollMs: 10,
  });
  return { root, recordPath, configPath, printed, profile, gate: questions.forAttempt(ATTEMPT), questions };
}

const ask = (gate: EgressGate, host: string, wait_ms = 5_000, signal = new AbortController().signal) =>
  gate.ask({ host, command: COMMAND.replace(HOST, host), wait_ms, signal });

/** Answer the run's open question the way `perbo verdict --egress` does, once the run has recorded it. */
async function answerWhenAsked(recordPath: string, choice: "allow" | "refuse"): Promise<void> {
  for (;;) {
    const open = readEgressQuestions(recordPath)?.questions.find((question) => question.answer === null);
    if (open !== undefined) {
      answerEgressQuestion({ path: recordPath, key: open.key, choice, author: "Ada <ada@example.org>", now: new Date(), liveRuns: RUN_BEFORE });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the first unlisted host of a run", () => {
  it("is recorded on the ticket as a question, with the whole command, and printed as one", async () => {
    const r = run();
    const asking = ask(r.gate, HOST);
    await answerWhenAsked(r.recordPath, "allow");
    await asking;
    const [question] = readEgressQuestions(r.recordPath)!.questions;
    expect(question).toMatchObject({ host: HOST, command: COMMAND, attempt_id: ATTEMPT });
    expect(Date.parse(question!.expires_at) - Date.parse(question!.asked_at)).toBe(5_000);
    const line = r.printed.map(readEgressQuestion).find((read) => read !== null);
    expect(line).toEqual({ key: question!.key, host: HOST, command: COMMAND });
    expect(r.printed.some((printed) => printed.includes(`perbo verdict PRB-9 --egress ${question!.key} --allow`))).toBe(true);
  });

  it("waits for the answer: nothing is settled until a person gives one", async () => {
    const r = run();
    let settled = false;
    const asking = ask(r.gate, HOST).then((verdict) => {
      settled = true;
      return verdict;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await answerWhenAsked(r.recordPath, "allow");
    expect(await asking).toEqual({ answer: "allow" });
  });
});

describe("an allow", () => {
  it("adds that one host to network_allow_list, keeping the rest of the file, and to the live profile", async () => {
    const r = run();
    const asking = ask(r.gate, HOST);
    await answerWhenAsked(r.recordPath, "allow");
    expect(await asking).toEqual({ answer: "allow" });
    const written = JSON.parse(readFileSync(r.configPath, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({ _comment: "kept", checks: [], network_allow_list: [HOST] });
    expect(r.profile.network_allow_list).toContain(HOST);
    expect(r.printed.map(readEgressSettled).filter((read) => read !== null)).toEqual([
      expect.objectContaining({ host: HOST, settled: "allowed" }),
    ]);
  });

  it("is one host, not a category: the same host passes again, and another is not asked", async () => {
    const r = run();
    const asking = ask(r.gate, HOST);
    await answerWhenAsked(r.recordPath, "allow");
    await asking;
    expect(await ask(r.gate, HOST)).toEqual({ answer: "allow" });
    expect(await ask(r.gate, `mirror.${HOST}`)).toMatchObject({ answer: "refuse" });
    expect(readEgressQuestions(r.recordPath)!.questions).toHaveLength(1);
  });

  it("writes a configuration where the repository had none", async () => {
    const r = run(undefined, null);
    const asking = ask(r.gate, HOST);
    await answerWhenAsked(r.recordPath, "allow");
    await asking;
    expect(JSON.parse(readFileSync(r.configPath, "utf8"))).toEqual({ network_allow_list: [HOST] });
  });
});

describe("a refusal", () => {
  it("tells the executor the network is closed for the run, and closes the run's questions", async () => {
    const r = run();
    const asking = ask(r.gate, HOST);
    await answerWhenAsked(r.recordPath, "refuse");
    const verdict = await asking;
    expect(verdict.answer).toBe("refuse");
    expect(verdict.answer === "refuse" && verdict.tell).toMatch(/network is closed for the rest of this run/);
    expect(JSON.parse(readFileSync(r.configPath, "utf8"))).not.toHaveProperty("network_allow_list");
    expect(r.profile.network_allow_list).not.toContain(HOST);
  });

  it("refuses a second unlisted host silently: no question is recorded or printed for it", async () => {
    const r = run();
    const asking = ask(r.gate, HOST);
    await answerWhenAsked(r.recordPath, "refuse");
    await asking;
    const second = await ask(r.gate, OTHER);
    expect(second.answer).toBe("refuse");
    expect(second.answer === "refuse" && second.tell).toMatch(/network is closed/);
    expect(readEgressQuestions(r.recordPath)!.questions.map((question) => question.host)).toEqual([HOST]);
    expect(r.printed.map(readEgressQuestion).filter((read) => read !== null)).toHaveLength(1);
  });

  it("is remembered on the ticket: a later run refuses the host without asking, and still asks about another", async () => {
    const first = run();
    const asking = ask(first.gate, HOST);
    await answerWhenAsked(first.recordPath, "refuse");
    await asking;
    const later = run(first.root);
    const again = await ask(later.gate, HOST);
    expect(again.answer).toBe("refuse");
    expect(again.answer === "refuse" && again.tell).toMatch(/refused .* on this ticket/);
    expect(readEgressQuestions(first.recordPath)!.questions).toHaveLength(1);
    // A remembered refusal is not the run's one question.
    const other = ask(later.gate, OTHER);
    await answerWhenAsked(first.recordPath, "allow");
    expect(await other).toEqual({ answer: "allow" });
  });
});

describe("a question nobody answers", () => {
  it("is settled unanswered once the window has passed, which the attempt stops on", async () => {
    const r = run();
    const verdict = await ask(r.gate, HOST, 120);
    expect(verdict.answer).toBe("unanswered");
    expect(verdict.answer === "unanswered" && verdict.detail).toContain(HOST);
    expect(r.printed.map(readEgressSettled).filter((read) => read !== null)).toEqual([
      expect.objectContaining({ settled: "unanswered" }),
    ]);
  });

  it("is closed on the record once the window passed, so no answer is taken for it", async () => {
    const r = run();
    await ask(r.gate, HOST, 50);
    const [question] = readEgressQuestions(r.recordPath)!.questions;
    expect(question!.closed_at).not.toBeNull();
    expect(() =>
      answerEgressQuestion({ path: r.recordPath, key: question!.key, choice: "allow", author: "Ada", now: new Date(), liveRuns: RUN_BEFORE }),
    ).toThrow(/was closed at/);
  });

  it("stops waiting when the attempt stops for another reason, and is closed so no answer is taken", async () => {
    const r = run();
    const stopping = new AbortController();
    const asking = ask(r.gate, HOST, 60_000, stopping.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopping.abort();
    expect((await asking).answer).toBe("unanswered");
    const [question] = readEgressQuestions(r.recordPath)!.questions;
    // Inside the window, with the run still live: only the close refuses it.
    expect(() =>
      answerEgressQuestion({ path: r.recordPath, key: question!.key, choice: "allow", author: "Ada", now: new Date(), liveRuns: RUN_BEFORE }),
    ).toThrow(/was closed at/);
  });

  /**
   * The person answers after the run's last read, and the attempt then stops
   * for another reason: the answer is still theirs, and is settled as given,
   * while the stopping attempt lets nothing through.
   */
  it("settles an allow that landed just before the attempt stopped, and lets nothing through", async () => {
    const r = run();
    const stopping = new AbortController();
    const asking = ask(r.gate, HOST, 60_000, stopping.signal);
    await answerWhenAsked(r.recordPath, "allow");
    stopping.abort();
    const verdict = await asking;
    expect(verdict.answer).toBe("unanswered");
    expect(JSON.parse(readFileSync(r.configPath, "utf8"))).toMatchObject({ network_allow_list: [HOST] });
    expect(r.profile.network_allow_list).toContain(HOST);
    expect(r.printed.map(readEgressSettled).filter((read) => read !== null)).toEqual([
      expect.objectContaining({ host: HOST, settled: "allowed" }),
    ]);
    // Allowed for the rest of the run: the same host passes without a question.
    expect(await ask(r.gate, HOST)).toEqual({ answer: "allow" });
  });

  it("settles a refusal that landed just before the attempt stopped, and remembers it", async () => {
    const r = run();
    const stopping = new AbortController();
    const asking = ask(r.gate, HOST, 60_000, stopping.signal);
    await answerWhenAsked(r.recordPath, "refuse");
    stopping.abort();
    expect((await asking).answer).toBe("unanswered");
    expect(r.printed.map(readEgressSettled).filter((read) => read !== null)).toEqual([
      expect.objectContaining({ host: HOST, settled: "refused" }),
    ]);
    const again = await ask(r.gate, HOST);
    expect(again.answer === "refuse" && again.tell).toMatch(/refused .* on this ticket/);
  });

  /**
   * The race at the edge of the window: the person answers after the run's
   * last read and before it closes the question. The answer is taken, and the
   * run acts on it rather than stopping as though nobody had answered.
   */
  it("acts on an answer that lands between its last read and its close", async () => {
    const asked = Date.parse("2026-09-27T10:00:00.000Z");
    const WAIT = 60_000;
    let calls = 0;
    let recordPath = "";
    const clock = (): Date => {
      calls += 1;
      // The first call stamps the question; the second is the run's check of
      // the window, just after a read that found no answer: the person's
      // answer lands now, inside the window, and the window has then passed.
      if (calls === 2) {
        const [open] = readEgressQuestions(recordPath)!.questions;
        answerEgressQuestion({ path: recordPath, key: open!.key, choice: "allow", author: "Ada", now: new Date(asked + WAIT - 1), liveRuns: RUN_BEFORE });
      }
      return new Date(calls === 1 ? asked : asked + WAIT + 1);
    };
    const r = run(undefined, undefined, clock);
    recordPath = r.recordPath;
    expect(await ask(r.gate, HOST, WAIT)).toEqual({ answer: "allow" });
    const [question] = readEgressQuestions(r.recordPath)!.questions;
    expect(question!.answer?.choice).toBe("allow");
    expect(question!.closed_at).toBeNull();
    expect(JSON.parse(readFileSync(r.configPath, "utf8"))).toMatchObject({ network_allow_list: [HOST] });
  });
});

describe("what a person can be asked", () => {
  it("is only a plain host name, which is all the configuration can carry (ADR-0023)", async () => {
    const r = run();
    const verdict = await ask(r.gate, "evil_host");
    expect(verdict.answer).toBe("refuse");
    expect(existsSync(r.recordPath)).toBe(false);
  });
});
