import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { EgressQuestion } from "@perbo/contracts";
import { scratchDirectories, SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import {
  addToNetworkAllowList,
  answerEgressQuestion,
  closeEgressQuestion,
  readEgressQuestions,
} from "./egress-questions.js";
import { RecordLockedError, recordLockPath } from "./record-lock.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The one write of an allowed host into `.perbo/config.json`
 * (D-NEW-an-unlisted-host-asks): a plain host name or nothing (ADR-0023), the
 * rest of the file kept as it was.
 */
describe("adding a host to network_allow_list", () => {
  const config = (contents: Record<string, unknown>): string => {
    const dir = join(scratch("perbo-allow-list-"), ".perbo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(contents, null, 2));
    return join(dir, "config.json");
  };

  it("appends the host and keeps every other key, comments included, in their order", () => {
    const path = config({ _comment: "hand-kept", network_allow_list: ["mirror.example.org"], checks: [] });
    expect(addToNetworkAllowList(path, "googlechromelabs.github.io")).toBe(true);
    const written = readFileSync(path, "utf8");
    expect(Object.keys(JSON.parse(written) as object)).toEqual(["_comment", "network_allow_list", "checks"]);
    expect(JSON.parse(written)).toMatchObject({ network_allow_list: ["mirror.example.org", "googlechromelabs.github.io"] });
  });

  it("writes nothing where the host is listed already", () => {
    const path = config({ network_allow_list: ["googlechromelabs.github.io"] });
    const before = readFileSync(path, "utf8");
    expect(addToNetworkAllowList(path, "googlechromelabs.github.io")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses anything that is not a plain host name, and writes nothing", () => {
    const path = config({ checks: [] });
    const before = readFileSync(path, "utf8");
    for (const value of ["https://evil.example.org", "*.github.io", "evil.example.org/path", "a b"])
      expect(() => addToNetworkAllowList(path, value)).toThrow(/not a host name/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

/**
 * The ticket's record of its questions: an answer is taken only while the run
 * that asked still waits, a close and an answer cannot both land, and every
 * writer works under the record's lock.
 */
describe("answering a question on the ticket's record", () => {
  const ASKED = "2026-09-27T10:00:00.000Z";
  const question = (key: string, over: Partial<EgressQuestion> = {}): EgressQuestion => ({
    key,
    host: "googlechromelabs.github.io",
    command: "npx @puppeteer/browsers install chrome@stable",
    attempt_id: "att_egressrecord0001",
    asked_at: ASKED,
    expires_at: "2026-09-27T10:20:00.000Z",
    answer: null,
    closed_at: null,
    ...over,
  });
  const KEY = "egq_00000000000000aa";
  const WITHIN = new Date("2026-09-27T10:05:00.000Z");
  const THE_RUN = [{ started_at: "2026-09-27T09:59:00.000Z" }];
  const record = (...questions: EgressQuestion[]): string => {
    const path = join(scratch("perbo-egress-record-"), "state", "ticket_egressrecord.egress.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema_version: 1, ticket_id: "ticket_egressrecord", questions }));
    return path;
  };
  const answer = (path: string, over: Partial<Parameters<typeof answerEgressQuestion>[0]> = {}) =>
    answerEgressQuestion({ path, key: KEY, choice: "allow", author: "Ada", now: WITHIN, liveRuns: THE_RUN, ...over });

  it("takes an answer while the run that asked it waits", () => {
    const path = record(question(KEY));
    expect(answer(path).answer).toEqual({ choice: "allow", author: "Ada", decided_at: WITHIN.toISOString() });
    expect(readEgressQuestions(path)!.questions[0]!.answer?.choice).toBe("allow");
  });

  it("refuses a question the run closed, and writes nothing", () => {
    const path = record(question(KEY, { closed_at: "2026-09-27T10:04:00.000Z" }));
    const before = readFileSync(path, "utf8");
    expect(() => answer(path)).toThrow(/was closed at/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses where the only live run started after the question was asked: a later run did not ask it", () => {
    const path = record(question(KEY));
    expect(() => answer(path, { liveRuns: [{ started_at: "2026-09-27T10:01:00.000Z" }] })).toThrow(/no live run/);
    expect(() => answer(path, { liveRuns: [] })).toThrow(/no live run/);
    expect(readEgressQuestions(path)!.questions[0]!.answer).toBeNull();
  });

  it("closes an unanswered question, after which no answer is taken", () => {
    const path = record(question(KEY));
    expect(closeEgressQuestion(path, KEY, WITHIN)).toBeNull();
    expect(readEgressQuestions(path)!.questions[0]!.closed_at).toBe(WITHIN.toISOString());
    expect(() => answer(path)).toThrow(/was closed at/);
  });

  it("returns an answer that landed before the close, and does not close the question", () => {
    const path = record(question(KEY));
    answer(path, { choice: "refuse" });
    expect(closeEgressQuestion(path, KEY, WITHIN)).toMatchObject({ choice: "refuse" });
    expect(readEgressQuestions(path)!.questions[0]!.closed_at).toBeNull();
  });

  it("refuses to write while another process holds the record's lock, rather than write without it", () => {
    const path = record(question(KEY));
    writeFileSync(
      recordLockPath(path),
      JSON.stringify({ pid: process.pid, host: hostname(), token: "held", taken_at: WITHIN.toISOString() }),
    );
    try {
      expect(() => answerEgressQuestion({ path, key: KEY, choice: "allow", author: "Ada", now: WITHIN, liveRuns: THE_RUN, lockWaitMs: 50 })).toThrow(
        RecordLockedError,
      );
      expect(readEgressQuestions(path)!.questions[0]!.answer).toBeNull();
    } finally {
      rmSync(recordLockPath(path), { force: true });
    }
  });
});

/**
 * Real processes at once, against the built module: two answers to one
 * question never both succeed, and a run's append racing an answer is never
 * written over. Many rounds, because a race that happens not to overlap once
 * proves nothing.
 */
describe("the record's writers at once", () => {
  const ROUNDS = 15;
  const built = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "egress-questions.js");
  /** A node process that runs one change against the record and prints what happened. */
  const writer = (script: string): Promise<string> =>
    new Promise((resolveDone) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(built).href)});\n${script}`]);
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("close", () => resolveDone(out.trim()));
    });
  const questionJson = (key: string) =>
    JSON.stringify({
      key,
      host: "googlechromelabs.github.io",
      command: "npx x",
      attempt_id: "att_egressrecord0001",
      asked_at: new Date(Date.now() - 1_000).toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      answer: null,
      closed_at: null,
    });

  it(
    "takes one of two answers to one question, and keeps a run's append made while an answer is written",
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const path = join(scratch("perbo-egress-race-"), "state", "ticket_egressrace.egress.json");
        mkdirSync(dirname(path), { recursive: true });
        const first = "egq_00000000000000b1";
        writeFileSync(path, `{"schema_version":1,"ticket_id":"ticket_egressrace","questions":[${questionJson(first)}]}`);
        const answerIt = (choice: string) =>
          writer(
            `try { m.answerEgressQuestion({ path: ${JSON.stringify(path)}, key: ${JSON.stringify(first)}, choice: ${JSON.stringify(choice)}, author: ${JSON.stringify(choice)}, now: new Date(), liveRuns: [{ started_at: "2020-01-01T00:00:00.000Z" }] }); console.log("taken"); } catch (e) { console.log("refused " + e.message); }`,
          );
        const append = writer(
          `m.recordEgressQuestion(${JSON.stringify(path)}, "ticket_egressrace", ${questionJson("egq_00000000000000b2")}); console.log("appended");`,
        );
        const results = await Promise.all([answerIt("allow"), answerIt("refuse"), append]);
        expect(results.filter((result) => result === "taken"), results.join("\n")).toHaveLength(1);
        expect(results[2]).toBe("appended");
        const after = readEgressQuestions(path)!;
        expect(after.questions.map((each) => each.key)).toEqual([first, "egq_00000000000000b2"]);
        expect(after.questions[0]!.answer).not.toBeNull();
      }
    },
    SPAWN_TEST_TIMEOUT_MS * 4,
  );
});
