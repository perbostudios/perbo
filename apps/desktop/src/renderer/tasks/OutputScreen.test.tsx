// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import type { AttemptView, Detail, Job, Snapshot } from "../../shared/protocol.js";
import { OutputScreen } from "./ReviewScreens.js";
import type { TaskContext } from "./task-context.js";
import { spokenLine } from "@perbo/contracts/browser";

let client: QueryClient;
let sample: { workspace: Snapshot; detail: Detail; repoId: string };
beforeAll(async () => {
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  const detail = await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-412" });
  sample = { workspace, detail, repoId: row.repoId };
});
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

/** The words a run speaks, and the tool calls between them. */
const EXECUTOR = ["Reading the mailer and its tests first.", "Adding a capped retry to the send path."];
const REVIEWER = "The cap has no test of its own.";

/** What the CLI prints while the run works, as the host relays it on the job's log. */
const PRINTED = [
  "  worktree /w/att_1 on prb/x at abc1234",
  "  executing",
  "  agent ready: 0 tool servers, 0 skills, credential subscription",
  `  executor says: ${EXECUTOR[0]}`,
  "  Codex pnpm test",
  `  executor says: ${EXECUTOR[1]}`,
  "  sealing the change set",
  "  check unit: pnpm test",
  "  review round 0",
  `  reviewer says: ${REVIEWER}`,
];

const run = (overrides: Partial<Job>): Job => ({
  id: "run-watched",
  repoId: sample.repoId,
  key: "PRB-412",
  kind: "run",
  label: "Run engineering loop",
  state: "running",
  startedAt: "2026-09-08T09:39:00.000Z",
  endedAt: null,
  log: "",
  error: null,
  resultKey: null,
  result: null,
  ...overrides,
});
/** The run with its first `count` lines printed. */
const running = (count: number): Job => run({ log: PRINTED.slice(0, count).join("\n") + "\n" });

/** PRB-412's Watch page over `jobs`, its latest attempt's review leaving `open` open. */
function context(jobs: Job[], open: string[] = []): TaskContext {
  const workspace = structuredClone(sample.workspace);
  const detail = structuredClone(sample.detail);
  workspace.jobs = jobs;
  workspace.refreshingRepos = [];
  const latest = detail.attempts.at(-1)!;
  const template = detail.attempts.findLast((attempt) => attempt.review)!.review!.findings[0]!;
  latest.review = {
    ...detail.attempts.findLast((attempt) => attempt.review)!.review!,
    findings: open.map((statement, at) => ({ ...template, key: String(at).repeat(64), statement, status: "open" })),
  };
  return { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
}
const view = (task: TaskContext) => (
  <QueryClientProvider client={client}>
    <OutputScreen {...task} />
  </QueryClientProvider>
);
/** The transcript's rows, each as its author and its words. */
const rows = (): string[] =>
  [...document.querySelectorAll(".transcript-entry")].map(
    (entry) => `${entry.querySelector("strong")?.textContent}: ${entry.querySelector("p")?.textContent}`,
  );
/** The retained transcript the records hold for the attempt, with what the page must not list. */
function retained(): string {
  const turn = (text: string, parent?: string) =>
    JSON.stringify({
      type: "assistant",
      ...(parent ? { parent_tool_use_id: parent } : {}),
      message: { content: [{ type: "text", text }] },
    });
  const tool = (name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    turn(EXECUTOR[0]!),
    tool("Read", { file_path: "src/mailer.ts" }),
    tool("Bash", { command: "pnpm test" }),
    turn("A subagent's own summary.", "toolu_task"),
    turn(EXECUTOR[1]!),
    tool("Write", { file_path: "src/mailer.ts" }),
    JSON.stringify({ type: "result", result: EXECUTOR[1] }),
  ].join("\n");
}

describe("the Watch page's transcript", () => {
  it("adds the agents' words as the run's progress brings them, the latest at the bottom, and no tool call", () => {
    const { rerender } = render(view(context([running(4)])));
    expect(rows()).toEqual([`Executor: ${EXECUTOR[0]}`]);
    rerender(view(context([running(6)])));
    expect(rows()).toEqual([`Executor: ${EXECUTOR[0]}`, `Executor: ${EXECUTOR[1]}`]);
    rerender(view(context([running(PRINTED.length)])));
    expect(rows()).toEqual([`Executor: ${EXECUTOR[0]}`, `Executor: ${EXECUTOR[1]}`, `Reviewer: ${REVIEWER}`]);
    const transcript = document.querySelector(".transcript")!;
    expect(transcript.textContent).not.toMatch(/tool call|Codex|pnpm|agent ready|worktree/);
  });

  it("lists the live run's words, not an earlier attempt's records, while the run goes", async () => {
    const original = bridge.request.bind(bridge);
    const request = vi.spyOn(bridge, "request").mockImplementation(((call: Parameters<typeof original>[0]) =>
      call.kind === "output"
        ? Promise.resolve({ transcript: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "An earlier attempt's words." }] } }), diff: null, notes: [] })
        : original(call)) as typeof bridge.request);
    render(view(context([running(4)], ["An earlier review's finding."])));
    await waitFor(() => expect(request.mock.calls.some(([call]) => call.kind === "output")).toBe(true));
    await new Promise((settled) => setTimeout(settled, 50));
    expect(rows()).toEqual([`Executor: ${EXECUTOR[0]}`]);
  });

  it("keeps the latest in view as words arrive while follow is on", () => {
    const { rerender } = render(view(context([running(4)])));
    const transcript = document.querySelector(".transcript") as HTMLElement;
    let height = 300;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, get: () => height });
    height = 480;
    rerender(view(context([running(6)])));
    expect(transcript.scrollTop).toBe(480);
    height = 720;
    rerender(view(context([running(PRINTED.length)])));
    expect(transcript.scrollTop).toBe(720);
  });

  it("rebuilds the same list from the records once the run has ended", async () => {
    const original = bridge.request.bind(bridge);
    vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "output"
        ? Promise.resolve({ transcript: retained(), diff: null, notes: [] })
        : original(request)) as typeof bridge.request);
    render(view(context([running(PRINTED.length)])));
    const live = rows();
    cleanup();
    // Ended, and its log no longer read: the records say it.
    render(view(context([run({ state: "completed", endedAt: "2026-09-08T09:45:00.000Z", log: "" })], [REVIEWER])));
    await waitFor(() => expect(rows()).toEqual(live));
    expect(document.querySelector(".transcript")!.textContent).not.toMatch(/subagent|tool call/);
  });
});

/** A long turn of several paragraphs, as an agent says one: far past a line's width, and whole. */
const paragraphs = (opening: string): string =>
  [
    opening,
    ...Array.from(
      { length: 12 },
      (_, at) =>
        `Step ${at + 1}: the send path reads the mailer's settings, retries a failed send after a pause that doubles each time, and stops at the cap.\n  - then its test`,
    ),
    "Done.",
  ].join("\n\n");
/** Two rounds of one run: each attempt's words, and the finding its review left open. */
const ROUNDS = [
  {
    id: "attempt-round-0",
    said: paragraphs("Adding the retry to the send path."),
    finding: "The retry has no cap.\nreview round 5\nA send that always fails retries for ever.",
  },
  {
    id: "attempt-round-1",
    said: paragraphs("Capping the retry at three."),
    finding: "The cap has no test of its own.\n\n  worktree /elsewhere on main at abc",
  },
];
/** What the CLI prints across both rounds, as the host relays it. */
const PRINTED_ROUNDS = [
  "  worktree /w/att_1 on prb/x at abc1234",
  "  executing",
  `  ${spokenLine("executor", ROUNDS[0]!.said)}`,
  "  review round 0",
  `  ${spokenLine("reviewer", ROUNDS[0]!.finding)}`,
  "  remediation round 1 of at most 2",
  `  ${spokenLine("executor", ROUNDS[1]!.said)}`,
  "  review round 1",
  `  ${spokenLine("reviewer", ROUNDS[1]!.finding)}`,
  "  finding: The unit check failed and then passed when it was run again on its own.",
];

/**
 * PRB-412 with the latest run in two attempts, each reviewed and leaving its
 * round's finding open, and a flaky check the runner itself noted on the
 * second: a finding of the runner's, not the reviewer's words.
 */
function twoRounds(jobs: Job[]): TaskContext {
  const task = context(jobs);
  const latest = task.detail.attempts.at(-1)!;
  const template = latest.review!.findings[0] ?? structuredClone(sample.detail.attempts.findLast((attempt) => attempt.review)!.review!.findings[0]!);
  const round = (at: number, extra: typeof template[] = []) => ({
    ...structuredClone(latest),
    id: ROUNDS[at]!.id,
    round: at,
    review: {
      ...latest.review!,
      findings: [
        { ...template, key: String(at).repeat(64), statement: ROUNDS[at]!.finding, status: "open" as const, source: "semantic" as const },
        ...extra,
      ],
    },
  });
  const flaky = {
    ...template,
    key: "f".repeat(64),
    statement: "The unit check failed and then passed when it was run again on its own.",
    status: "open" as const,
    source: "deterministic" as const,
  };
  task.detail.attempts = [...task.detail.attempts.slice(0, -1), round(0), round(1, [flaky])];
  return task;
}
/** Each attempt's retained transcript by its id; one missing from `transcripts` retained none. */
function recordsOf(transcripts: Record<string, string>) {
  const original = bridge.request.bind(bridge);
  return vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
    request.kind === "output"
      ? Promise.resolve({ transcript: transcripts[request.attemptId ?? ""] ?? null, diff: null, notes: [] })
      : original(request)) as typeof bridge.request);
}
const turnOf = (text: string): string => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const ended = (log: string): Job => run({ state: "completed", endedAt: "2026-09-08T09:45:00.000Z", log });

describe("the Watch page's transcript over a run of several rounds", () => {
  it("rebuilds every round the live list showed, each attempt's words then its review's open findings, in order, every turn whole", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf(ROUNDS[1]!.said) });
    render(view(twoRounds([run({ log: PRINTED_ROUNDS.join("\n") + "\n" })])));
    const live = rows();
    expect(live).toEqual([
      `Executor: ${ROUNDS[0]!.said}`,
      `Reviewer: ${ROUNDS[0]!.finding}`,
      `Executor: ${ROUNDS[1]!.said}`,
      `Reviewer: ${ROUNDS[1]!.finding}`,
    ]);
    expect(ROUNDS[0]!.said.length).toBeGreaterThan(1_500);
    cleanup();
    render(view(twoRounds([ended("")])));
    await waitFor(() => expect(rows()).toEqual(live));
    // The runner's own note of a flaky check is not the reviewer's words.
    expect(document.querySelector(".transcript")!.textContent).not.toContain("failed and then passed");
  });

  it("keeps showing the log until every attempt's transcript is read", async () => {
    let answer!: () => void;
    const held = new Promise<void>((done) => (answer = done));
    const original = bridge.request.bind(bridge);
    vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind !== "output"
        ? original(request)
        : request.attemptId === ROUNDS[0]!.id
          ? held.then(() => ({ transcript: turnOf("From the records."), diff: null, notes: [] }))
          : Promise.resolve({ transcript: turnOf("From the records too."), diff: null, notes: [] })) as typeof bridge.request);
    render(view(twoRounds([ended(`  executor says: From the log.\n`)])));
    await new Promise((settled) => setTimeout(settled, 50));
    expect(rows()).toEqual(["Executor: From the log."]);
    answer();
    await waitFor(() => expect(rows()[0]).toBe("Executor: From the records."));
  });

  it("carries the words of an attempt that retained them where another retained none", async () => {
    recordsOf({ [ROUNDS[1]!.id]: turnOf(ROUNDS[1]!.said) });
    render(view(twoRounds([ended(`  executor says: From the log.\n`)])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
      ]),
    );
  });

  it("stands on the log where no attempt retained the executor's words and the log holds them", async () => {
    recordsOf({});
    render(view(twoRounds([ended(`  executor says: From the log.\n  ${spokenLine("reviewer", ROUNDS[1]!.finding)}\n`)])));
    await new Promise((settled) => setTimeout(settled, 50));
    expect(rows()).toEqual(["Executor: From the log.", `Reviewer: ${ROUNDS[1]!.finding}`]);
  });
});

/**
 * A Codex run's log as the host relayed it while the run went: its startup
 * lines, a tally after each call, a `Codex <command>` line for each command,
 * the executor's and the reviewer's turns, and the stages between.
 */
const CODEX_LOG = readFileSync(`${import.meta.dirname}/fixtures/codex-run-log.txt`, "utf8");
/** The same run as each transport prints it: OpenCode names its commands, Claude Code prints no line for a call. */
const TRANSPORT_LOGS = {
  Codex: CODEX_LOG,
  OpenCode: CODEX_LOG.replaceAll(/^ {2}Codex /gm, "  OpenCode "),
  "Claude Code": CODEX_LOG.split("\n")
    .filter((line) => !line.startsWith("  Codex "))
    .join("\n")
    .replace("  executing\n", "  executing\n  agent ready: 0 tool servers, 0 skills, credential subscription\n"),
};
/** The agents' turns the log printed, in its order, as the page lists them. */
const SPOKEN = CODEX_LOG.split("\n").flatMap((line) => {
  const turn = /^ {2}(executor|reviewer) says: (.*)$/.exec(line);
  return turn === null ? [] : [`${turn[1] === "executor" ? "Executor" : "Reviewer"}: ${turn[2]!.replaceAll("\\n", "\n")}`];
});

describe("the Watch page of a running run, on each transport", () => {
  /** The run's first round, live: nothing of it is on record yet, so the page has only its log to read. */
  function firstRun(log: string): TaskContext {
    const task = context([run({ log })]);
    task.detail.attempts = [];
    return task;
  }

  it.each(Object.keys(TRANSPORT_LOGS) as (keyof typeof TRANSPORT_LOGS)[])(
    "lists every turn %s's log printed, the latest at the bottom, and no command",
    (transport) => {
      render(view(firstRun(TRANSPORT_LOGS[transport])));
      expect(SPOKEN).toHaveLength(17);
      expect(rows()).toEqual(SPOKEN);
      expect(rows()[0]).toMatch(/^Executor: I’ll build the standalone page/);
      expect(rows().at(-1)).toMatch(/^Executor: ## Account of this change\n\n- Fixed native time-field editing/);
      expect(document.querySelector(".transcript")!.textContent).not.toMatch(/Codex|OpenCode|\/bin\/zsh|tally:|agent ready/);
    },
  );

  it("shows the commands in the terminal, where the page keeps them", () => {
    render(view(firstRun(TRANSPORT_LOGS.Codex)));
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(document.querySelector(".terminal-output")!.textContent).toContain("Codex /bin/zsh -lc 'node tests/alarm-clock.cjs'");
  });
});

describe("the Watch page of a run that has ended", () => {
  it("lists the words it listed while the run went, from the log the run printed", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf("A record's words."), [ROUNDS[1]!.id]: turnOf("Another record's words.") });
    render(view(twoRounds([run({ log: CODEX_LOG })])));
    const live = rows();
    expect(live).toEqual(SPOKEN);
    cleanup();
    // The log it printed across both attempts, as the host keeps it once the run ended.
    render(view(twoRounds([ended(CODEX_LOG)])));
    await new Promise((settled) => setTimeout(settled, 50));
    expect(rows()).toEqual(live);
  });

  it("reads the attempts whose start the log's tail cut from their records, ahead of the ones it holds", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf("Not listed: the log holds this attempt.") });
    // The tail begins inside the first attempt, after its start.
    const tail = PRINTED_ROUNDS.slice(3).join("\n") + "\n";
    render(view(twoRounds([ended(tail)])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
      ]),
    );
  });

  it("keeps the words of an attempt the run began and did not record, and reads the one whose start the tail cut from its records", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said) });
    const task = twoRounds([]);
    // Only the first attempt is on record: the second was stopped before its record was written.
    task.detail.attempts = task.detail.attempts.slice(0, -1);
    const tail = [
      `  ${spokenLine("reviewer", "The end of the first attempt's review.")}`,
      "  remediation round 1 of at most 2",
      `  ${spokenLine("executor", "Words of an attempt nobody recorded.")}`,
      "  terminating: stalled — the agent went quiet",
    ].join("\n");
    task.workspace.jobs = [ended(tail)];
    render(view(task));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        "Executor: Words of an attempt nobody recorded.",
      ]),
    );
  });

  it("reads each attempt from its records where the log holds its start and stages but no turn", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf(ROUNDS[1]!.said) });
    const silent = PRINTED_ROUNDS.filter((line) => !/ says: /.test(line)).join("\n") + "\n";
    render(view(twoRounds([ended(silent)])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
      ]),
    );
  });

  it("reads every attempt from its records where the journal holds no run of the ticket", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf(ROUNDS[1]!.said) });
    render(view(twoRounds([])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
      ]),
    );
  });

  it("reads an attempt whose stretch of the log holds no turn from its records, and one whose stretch holds turns from the log alone", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf("Not listed: the log holds this attempt's words.") });
    const log = [
      "  worktree /w/att_1 on prb/x at abc1234",
      "  executing",
      "  sealing the change set",
      "  review round 0",
      "  remediation round 1 of at most 2",
      `  ${spokenLine("executor", "The second attempt's words, as printed.")}`,
      "  review round 1",
      `  ${spokenLine("reviewer", "The second review's words, as printed.")}`,
    ].join("\n");
    render(view(twoRounds([ended(log)])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        "Executor: The second attempt's words, as printed.",
        "Reviewer: The second review's words, as printed.",
      ]),
    );
  });

  it("reads a previous run's attempts from their records, ahead of the words of a later run that recorded none", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf(ROUNDS[1]!.said) });
    // A later run, started after both attempts on record, that recorded none of its own.
    const later = run({ state: "failed", startedAt: "2026-09-08T11:00:00.000Z", endedAt: "2026-09-08T11:05:00.000Z", log: [
      `  ${spokenLine("executor", "Words before the first start the log holds.")}`,
      "  executing",
      `  ${spokenLine("executor", "The later run's own words.")}`,
    ].join("\n") });
    render(view(twoRounds([later])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
        "Executor: Words before the first start the log holds.",
        "Executor: The later run's own words.",
      ]),
    );
  });
});

describe("the Watch page of an OpenCode run that has ended", () => {
  it("rebuilds the executor's turns from the records OpenCode's attempts kept", async () => {
    const said = (text: string): string => JSON.stringify({ sessionUpdate: "agent_message", text });
    const call = JSON.stringify({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", title: "pnpm test" });
    recordsOf({
      [ROUNDS[0]!.id]: [said(ROUNDS[0]!.said), call].join("\n"),
      [ROUNDS[1]!.id]: [call, said(ROUNDS[1]!.said)].join("\n"),
    });
    // A log that holds no attempt's start and no turn: every attempt is read from its records.
    render(view(twoRounds([ended(`  sealing the change set\n{"outcome":"approved"}\n`)])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
      ]),
    );
  });
});

describe("the Watch page over every run of a ticket", () => {
  /** An earlier run's one attempt, its review leaving its finding open. */
  const EARLIER = { id: "attempt-earlier-run", said: "The first run's words.", finding: "The first run's open finding." };
  /** PRB-412 with an earlier run's attempt ahead of the two rounds of its last run. */
  function twoRuns(jobs: Job[]): TaskContext {
    const task = twoRounds(jobs);
    const [first, second] = task.detail.attempts.slice(-2) as [AttemptView, AttemptView];
    const earlier: AttemptView = {
      ...structuredClone(first),
      id: EARLIER.id,
      run: 1,
      startedAt: "2026-09-08T08:00:00.000Z",
      review: { ...first.review!, findings: [{ ...first.review!.findings[0]!, key: "e".repeat(64), statement: EARLIER.finding }] },
    };
    task.detail.attempts = [earlier, { ...first, run: 2 }, { ...second, run: 2 }];
    return task;
  }

  it("lists both runs' words in order once the last has ended", async () => {
    recordsOf({ [EARLIER.id]: turnOf(EARLIER.said), [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf(ROUNDS[1]!.said) });
    render(view(twoRuns([ended(PRINTED_ROUNDS.join("\n") + "\n")])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${EARLIER.said}`,
        `Reviewer: ${EARLIER.finding}`,
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
      ]),
    );
  });

  it("lists the earlier run's words ahead of the live run's while it goes", async () => {
    recordsOf({ [EARLIER.id]: turnOf(EARLIER.said) });
    const task = twoRuns([running(6)]);
    // The live run has recorded nothing yet: only the earlier run is on record.
    task.detail.attempts = task.detail.attempts.slice(0, 1);
    render(view(task));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${EARLIER.said}`,
        `Reviewer: ${EARLIER.finding}`,
        `Executor: ${EXECUTOR[0]}`,
        `Executor: ${EXECUTOR[1]}`,
      ]),
    );
  });

  it("fills in an earlier run's words as its records arrive, keeping what is already read", async () => {
    let answer!: () => void;
    const held = new Promise<void>((done) => (answer = done));
    const original = bridge.request.bind(bridge);
    vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind !== "output"
        ? original(request)
        : request.attemptId === EARLIER.id
          ? held.then(() => ({ transcript: turnOf(EARLIER.said), diff: null, notes: [] }))
          : Promise.resolve({ transcript: null, diff: null, notes: [] })) as typeof bridge.request);
    render(view(twoRuns([ended(PRINTED_ROUNDS.join("\n") + "\n")])));
    const last = [`Executor: ${ROUNDS[0]!.said}`, `Reviewer: ${ROUNDS[0]!.finding}`, `Executor: ${ROUNDS[1]!.said}`, `Reviewer: ${ROUNDS[1]!.finding}`];
    await waitFor(() => expect(rows()).toEqual([`Reviewer: ${EARLIER.finding}`, ...last]));
    answer();
    await waitFor(() => expect(rows()).toEqual([`Executor: ${EARLIER.said}`, `Reviewer: ${EARLIER.finding}`, ...last]));
  });

  it("keeps an earlier run's open findings where the last run's records kept no executor words and its log holds some", async () => {
    recordsOf({});
    render(view(twoRuns([ended(`  executor says: From the log.\n`)])));
    await waitFor(() => expect(rows()).toEqual([`Reviewer: ${EARLIER.finding}`, "Executor: From the log."]));
  });
});

describe("the Watch page after a run the desktop did not start", () => {
  /** A run started from a terminal after the desktop's run ended: on record, and in no job of the journal. */
  const TERMINAL = { id: "attempt-terminal-run", said: "The terminal run's words.", finding: "The terminal run's open finding." };
  /** PRB-412 with the desktop run's attempts, `rounds` of them, and then the terminal run's one attempt. */
  function thenTerminal(rounds: 1 | 2, jobs: Job[]): TaskContext {
    const task = twoRounds(jobs);
    const desktop = task.detail.attempts.slice(-2).slice(0, rounds);
    const first = desktop[0]!;
    const terminal: AttemptView = {
      ...structuredClone(first),
      id: TERMINAL.id,
      run: 2,
      round: 0,
      startedAt: "2026-09-08T10:00:00.000Z",
      review: { ...first.review!, findings: [{ ...first.review!.findings[0]!, key: "t".repeat(64), statement: TERMINAL.finding }] },
    };
    task.detail.attempts = [...desktop, terminal];
    return task;
  }
  const printed = (count: number): string => PRINTED_ROUNDS.slice(0, count).join("\n") + "\n";

  it("lists the desktop run once, from its log, and the terminal run after it from its records", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf("Not listed: the log holds this attempt."), [TERMINAL.id]: turnOf(TERMINAL.said) });
    render(view(thenTerminal(1, [ended(printed(5))])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${TERMINAL.said}`,
        `Reviewer: ${TERMINAL.finding}`,
      ]),
    );
  });

  it("lists the terminal run after the log's words where the log's starts do not line up with the desktop run's records", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf("Not listed: the log's words stand for the desktop run."), [TERMINAL.id]: turnOf(TERMINAL.said) });
    // Two refinement rounds the desktop run's one recorded attempt, its execution, does not line up with.
    const log = [
      "  remediation round 1 of at most 3",
      `  ${spokenLine("executor", "The first refinement's words.")}`,
      "  remediation round 2 of at most 3",
      `  ${spokenLine("executor", "The second refinement's words.")}`,
    ].join("\n");
    render(view(thenTerminal(1, [ended(log)])));
    await waitFor(() =>
      expect(rows()).toEqual([
        "Executor: The first refinement's words.",
        "Executor: The second refinement's words.",
        `Executor: ${TERMINAL.said}`,
        `Reviewer: ${TERMINAL.finding}`,
      ]),
    );
  });

  it("lists both of the desktop run's attempts once, and the terminal run after them", async () => {
    recordsOf({
      [ROUNDS[0]!.id]: turnOf("Not listed: the log holds this attempt."),
      [ROUNDS[1]!.id]: turnOf("Not listed: the log holds this one too."),
      [TERMINAL.id]: turnOf(TERMINAL.said),
    });
    render(view(thenTerminal(2, [ended(printed(PRINTED_ROUNDS.length))])));
    await waitFor(() =>
      expect(rows()).toEqual([
        `Executor: ${ROUNDS[0]!.said}`,
        `Reviewer: ${ROUNDS[0]!.finding}`,
        `Executor: ${ROUNDS[1]!.said}`,
        `Reviewer: ${ROUNDS[1]!.finding}`,
        `Executor: ${TERMINAL.said}`,
        `Reviewer: ${TERMINAL.finding}`,
      ]),
    );
  });
});

describe("the Watch page's bottom bar", () => {
  it("keeps Export kept evidence at the left and the highlighted Back to the loop at the far right", () => {
    // Paused on a question, so the loop it goes back to is not a stopped one.
    render(view(context([], ["Where should a permanently failed email go?"])));
    const children = [...document.querySelector(".page-footer")!.children];
    const spacer = children.findIndex((child) => child.classList.contains("spacer"));
    expect(children.slice(0, spacer).map((child) => child.textContent)).toEqual(["Export kept evidence"]);
    expect(children.slice(spacer + 1).map((child) => child.textContent)).toEqual(["Copy transcript", "Back to the loop"]);
    expect(children.at(-1)?.className).toMatch(/primary/);
  });
});
