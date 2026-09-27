import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES, EgressQuestionsSchema, type EgressQuestion } from "@perbo/contracts";
import { verdictCommandLine } from "./index.js";
import { makeTicket } from "../../test-support/records.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * `perbo verdict <ticket> --egress <key> --allow|--refuse`
 * (D-137): a person's answer to the question a live run
 * is waiting on, written to the ticket's egress record that run reads, and
 * refused where nothing waits on it.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-verdict-egress-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_egressverdict1";
const KEY = "egq_0123456789abcdef";
const HOST = "googlechromelabs.github.io";
const NOW = new Date("2026-09-27T10:00:00.000Z");
const AUTHOR = "Ada Byron <ada@example.org>";

function question(over: Partial<EgressQuestion> = {}): EgressQuestion {
  return {
    key: KEY,
    host: HOST,
    command: `npx @puppeteer/browsers install chrome@stable --base-url https://${HOST}/chrome`,
    attempt_id: "att_egressverdict001",
    asked_at: "2026-09-27T09:55:00.000Z",
    expires_at: "2026-09-27T10:15:00.000Z",
    answer: null,
    closed_at: null,
    ...over,
  };
}

/** A store whose ticket has a run live on it (its lock, held by this process) and one question. */
function storeWith(name: string, options: { live?: boolean; questions?: EgressQuestion[]; runStarted?: string } = {}) {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-8.json"),
    JSON.stringify(makeTicket({ key: "AYO-8", ticket_id: TICKET_ID, repository_root: repo, state: "executing" })),
  );
  writeFileSync(
    join(store, "state", `${TICKET_ID}.egress.json`),
    JSON.stringify({ schema_version: 1, ticket_id: TICKET_ID, questions: options.questions ?? [question()] }),
  );
  if (options.live !== false)
    writeFileSync(
      join(store, "state", `${TICKET_ID}.lock.json`),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        ticket_id: TICKET_ID,
        ticket_key: "AYO-8",
        started_at: options.runStarted ?? "2026-09-27T09:50:00.000Z",
        wait: null,
      }),
    );
  const record = () =>
    EgressQuestionsSchema.parse(JSON.parse(readFileSync(join(store, "state", `${TICKET_ID}.egress.json`), "utf8")));
  return { repo, record };
}

async function answer(repo: string, ...flags: string[]) {
  const streams = recordStreams();
  const code = await runCommandLine(verdictCommandLine, {
    argv: ["AYO-8", ...flags, "--author", AUTHOR, "--repo", repo],
    streams,
    cwd: repo,
    now: NOW,
  });
  return { code, streams };
}

describe("perbo verdict --egress", () => {
  it("records an allow on the question, with who and when, for the run waiting on it", async () => {
    const { repo, record } = storeWith("allow");
    const { code } = await answer(repo, "--egress", KEY, "--allow");
    expect(code).toBe(EXIT_CODES.approve);
    expect(record().questions[0]!.answer).toEqual({ choice: "allow", author: AUTHOR, decided_at: NOW.toISOString() });
  });

  it("records a refusal, and takes the key by a prefix that names one question", async () => {
    const { repo, record } = storeWith("refuse");
    const { code } = await answer(repo, "--egress", KEY.slice(0, 10), "--refuse");
    expect(code).toBe(EXIT_CODES.approve);
    expect(record().questions[0]!.answer?.choice).toBe("refuse");
  });

  it("refuses a question answered already, and writes nothing", async () => {
    const answered = question({ answer: { choice: "refuse", author: "Someone", decided_at: "2026-09-27T09:58:00.000Z" } });
    const { repo, record } = storeWith("answered", { questions: [answered] });
    await expect(answer(repo, "--egress", KEY, "--allow")).rejects.toThrow(/was answered refuse by Someone/);
    expect(record().questions[0]).toEqual(answered);
  });

  it("refuses a question whose window passed", async () => {
    const { repo, record } = storeWith("expired", { questions: [question({ expires_at: "2026-09-27T09:59:00.000Z" })] });
    await expect(answer(repo, "--egress", KEY, "--allow")).rejects.toThrow(/expired/);
    expect(record().questions[0]!.answer).toBeNull();
  });

  it("refuses a question the run closed when it stopped waiting, and writes nothing", async () => {
    const closed = question({ closed_at: "2026-09-27T09:58:00.000Z" });
    const { repo, record } = storeWith("closed", { questions: [closed] });
    await expect(answer(repo, "--egress", KEY, "--allow")).rejects.toThrow(/was closed at/);
    expect(record().questions[0]).toEqual(closed);
  });

  it("refuses where the live run started after the question was asked: it is not the run that asked", async () => {
    const { repo, record } = storeWith("later-run", { runStarted: "2026-09-27T09:56:00.000Z" });
    await expect(answer(repo, "--egress", KEY, "--allow")).rejects.toThrow(/no live run of this ticket is the one that asked/);
    expect(record().questions[0]!.answer).toBeNull();
  });

  it("refuses where no run of the ticket is live, since nothing waits on the answer", async () => {
    const { repo, record } = storeWith("not-live", { live: false });
    await expect(answer(repo, "--egress", KEY, "--allow")).rejects.toThrow(/no run of AYO-8 is live/);
    expect(record().questions[0]!.answer).toBeNull();
  });

  it("takes exactly one answer, and nothing that belongs to a review", () => {
    const read = (...argv: string[]) => () => verdictCommandLine.read(["AYO-8", ...argv]);
    expect(read("--egress", KEY)).toThrow(/--allow or --refuse/);
    expect(read("--egress", KEY, "--allow", "--refuse")).toThrow(/--allow or --refuse/);
    expect(read("--allow")).toThrow(/--egress <question key>/);
    expect(read("--egress", KEY, "--allow", "--note", "x")).toThrow(/--note/);
    expect(read("--egress", KEY, "--allow", "--stand-in")).toThrow(/--stand-in cannot/);
    expect(verdictCommandLine.read(["AYO-8", "--egress", KEY, "--refuse"]).input).toMatchObject({ egress: KEY, allow: false });
  });
});
