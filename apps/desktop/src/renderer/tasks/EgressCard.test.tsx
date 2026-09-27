// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { egressQuestionLine, egressSettledLine } from "@perbo/contracts";
import { sampleBridge } from "../../sample-host/bridge.js";
import { RequestSchema, type Detail, type Job, type Snapshot } from "../../shared/protocol.js";
import { pendingEgressQuestion } from "../../shared/egress-question.js";
import { readStage } from "../../shared/runner-progress.js";
import { LoopScreen } from "./LoopScreen.js";
import { stageWords, watchTranscript, type TaskContext } from "./task-context.js";
import { homeTone } from "./ticket-workspace.js";

/**
 * The question a live run waits on, on the desktop (D-137):
 * a card in the decision card's frame showing the host and the whole command,
 * Refuse the default and highlighted, Allow beside it, the press sending the
 * question's key and the answer; the ticket reads as needing the person on
 * Home; and the loop page's steps and Watch show the pause.
 */

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

const QUESTION = {
  key: "egq_0123456789abcdef",
  host: "googlechromelabs.github.io",
  // Two lines, so the card is seen to show the command whole.
  command: "cd tools &&\n  npx @puppeteer/browsers install chrome@stable --base-url https://googlechromelabs.github.io/chrome",
};

const running = (log: string): Job => ({
  id: "run-egress",
  repoId: sample.repoId,
  key: "PRB-412",
  kind: "run",
  label: "Run engineering loop",
  state: "running",
  startedAt: "2026-09-27T09:00:00.000Z",
  endedAt: null,
  log,
  error: null,
  resultKey: null,
  result: null,
});
const asked = `  executing\n  ${egressQuestionLine(QUESTION)}\n  answer with: perbo verdict PRB-412 --egress ${QUESTION.key} --allow, or --refuse`;
const settled = `${asked}\n  ${egressSettledLine(QUESTION, "refused")}`;

function context(log: string, state: Job["state"] = "running"): TaskContext {
  const workspace = structuredClone(sample.workspace);
  const detail = structuredClone(sample.detail);
  workspace.jobs = [{ ...running(log), state }];
  workspace.refreshingRepos = [];
  detail.ticket.state = "executing";
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  row.ticket.state = "executing";
  return { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
}
function mount(task: TaskContext): void {
  render(
    <QueryClientProvider client={client}>
      <LoopScreen {...task} />
    </QueryClientProvider>,
  );
}

describe("the egress card", () => {
  it("shows the host and the whole command, under Decisions required", () => {
    mount(context(asked));
    const card = screen.getByRole("dialog", { name: "Decisions required" });
    expect(within(card).getByText(`Allow ${QUESTION.host}?`)).toBeTruthy();
    expect(within(card).getByLabelText("The whole command").textContent).toBe(QUESTION.command);
  });

  it("has Refuse as the default: highlighted, rightmost and focused, with Allow beside it", () => {
    mount(context(asked));
    const card = screen.getByRole("dialog", { name: "Decisions required" });
    const refuse = within(card).getByRole("button", { name: "Refuse" });
    const allow = within(card).getByRole("button", { name: "Allow" });
    expect(document.activeElement).toBe(refuse);
    expect(refuse.className).toContain("button--primary");
    expect(allow.className).not.toContain("button--primary");
    const buttons = [...card.querySelector(".decision-actions")!.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Allow", "Refuse"]);
  });

  for (const [press, allow] of [
    ["Refuse", false],
    ["Allow", true],
  ] as const) {
    it(`sends the question's key and ${press.toLowerCase()} on ${press}, and nothing the run printed`, async () => {
      const request = vi.spyOn(sampleBridge, "request").mockResolvedValue(null as never);
      mount(context(asked));
      fireEvent.click(screen.getByRole("button", { name: press }));
      const sent = request.mock.calls.map(([call]) => call).filter((call) => call.kind === "egressAnswer");
      expect(sent).toEqual([{ kind: "egressAnswer", repoId: sample.repoId, key: "PRB-412", question: QUESTION.key, allow }]);
      expect(RequestSchema.safeParse(sent[0]).success).toBe(true);
      expect(await screen.findByText("Sending your answer…")).toBeTruthy();
    });
  }

  it("says what the host refused, and takes an answer again", async () => {
    vi.spyOn(sampleBridge, "request").mockRejectedValue(new Error("no run of PRB-412 is live"));
    mount(context(asked));
    fireEvent.click(screen.getByRole("button", { name: "Refuse" }));
    expect(await screen.findByText("no run of PRB-412 is live")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refuse" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("is not raised for a run being stopped, as Home does not count it", () => {
    const task = context(asked, "stopping");
    mount(task);
    expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
    const row = { repoId: sample.repoId, ticket: { ...sample.detail.ticket, state: "executing" as const } };
    expect(homeTone(task.workspace, row)).not.toBe("yellow");
  });

  it("is gone once the run says the question is settled", () => {
    mount(context(settled));
    expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
  });
});

describe("the pause, where else it shows", () => {
  it("reads a waiting question from the run's own lines, and none once settled", () => {
    expect(pendingEgressQuestion(asked)).toEqual(QUESTION);
    expect(pendingEgressQuestion(settled)).toBeNull();
  });

  it("makes the ticket one that needs the person on Home, while the run waits", () => {
    const row = { repoId: sample.repoId, ticket: { ...sample.detail.ticket, state: "executing" as const } };
    expect(homeTone({ jobs: [running(asked)], refreshingRepos: [] }, row)).toBe("yellow");
    expect(homeTone({ jobs: [running(settled)], refreshingRepos: [] }, row)).toBeNull();
  });

  it("is a step on the loop page, and the answer after it", () => {
    const stage = readStage(egressQuestionLine(QUESTION))!;
    expect(stageWords(stage)).toBe(`Waiting on you: allow ${QUESTION.host}?`);
    expect(stageWords(readStage(egressSettledLine(QUESTION, "allowed"))!)).toBe(`You allowed ${QUESTION.host}`);
    mount(context(asked));
    const steps = screen.getByRole("region", { name: "Description of steps" });
    expect(steps.textContent).toContain(`Waiting on you: allow ${QUESTION.host}?`);
  });

  it("is the last line on Watch while the run waits, in the runner's words", () => {
    const job = running(asked);
    expect(watchTranscript([job], job, []).at(-1)).toEqual({
      author: "Perbo",
      label: "decision raised",
      text: `Waiting on you: allow ${QUESTION.host}?`,
    });
    const answered = running(settled);
    expect(watchTranscript([answered], answered, []).some((entry) => entry.author === "Perbo")).toBe(false);
  });
});
