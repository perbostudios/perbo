// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import type { Detail, Job, Snapshot } from "../../shared/protocol.js";
import { OutputScreen } from "./ReviewScreens.js";
import type { TaskContext } from "./task-context.js";

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

/** Two rounds of one run: each attempt's words, and the finding its review left open. */
const ROUNDS = [
  { id: "attempt-round-0", said: "Adding the retry to the send path.", finding: "The retry has no cap." },
  { id: "attempt-round-1", said: "Capping the retry at three.", finding: "The cap has no test of its own." },
];
/** What the CLI prints across both rounds, as the host relays it. */
const PRINTED_ROUNDS = [
  "  worktree /w/att_1 on prb/x at abc1234",
  "  executing",
  `  executor says: ${ROUNDS[0]!.said}`,
  "  review round 0",
  `  reviewer says: ${ROUNDS[0]!.finding}`,
  "  remediation round 1 of at most 2",
  `  executor says: ${ROUNDS[1]!.said}`,
  "  review round 1",
  `  reviewer says: ${ROUNDS[1]!.finding}`,
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
  it("rebuilds every round the live list showed, each attempt's words then its review's open findings, in order", async () => {
    recordsOf({ [ROUNDS[0]!.id]: turnOf(ROUNDS[0]!.said), [ROUNDS[1]!.id]: turnOf(ROUNDS[1]!.said) });
    render(view(twoRounds([run({ log: PRINTED_ROUNDS.join("\n") + "\n" })])));
    const live = rows();
    expect(live).toEqual([
      `Executor: ${ROUNDS[0]!.said}`,
      `Reviewer: ${ROUNDS[0]!.finding}`,
      `Executor: ${ROUNDS[1]!.said}`,
      `Reviewer: ${ROUNDS[1]!.finding}`,
    ]);
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
    render(view(twoRounds([ended(`  executor says: From the log.\n  reviewer says: ${ROUNDS[1]!.finding}\n`)])));
    await new Promise((settled) => setTimeout(settled, 50));
    expect(rows()).toEqual(["Executor: From the log.", `Reviewer: ${ROUNDS[1]!.finding}`]);
  });
});

describe("the Watch page's bottom bar", () => {
  it("keeps Export kept evidence at the left and the highlighted Back to the loop at the far right", () => {
    render(view(context([])));
    const children = [...document.querySelector(".page-footer")!.children];
    const spacer = children.findIndex((child) => child.classList.contains("spacer"));
    expect(children.slice(0, spacer).map((child) => child.textContent)).toEqual(["Export kept evidence"]);
    expect(children.slice(spacer + 1).map((child) => child.textContent)).toEqual(["Copy transcript", "Back to the loop"]);
    expect(children.at(-1)?.className).toMatch(/primary/);
  });
});
