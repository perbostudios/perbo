// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewError } from "@perbo/contracts";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Detail, Snapshot } from "../../shared/protocol.js";
import { ReviewScreen } from "./ReviewScreens.js";
import type { TaskContext } from "./task-context.js";

/**
 * A review that ended on an error says why in one sentence on the review
 * page's summary, and the error as the review recorded it sits behind the `i`
 * beside that sentence, never in the sentence itself.
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

const REJECTED =
  "the reviewer returned 2 verdict(s) this plan cannot accept: (1) verdict names unknown criterion 'ac_99'; " +
  "(2) verdict does not match the schema: findings.0.statement: Invalid input: expected string, received undefined";

/** PRB-412's review page, its latest attempt's review ended on `error`. */
function context(error: Pick<ReviewError, "kind" | "message">): TaskContext {
  const workspace = structuredClone(sample.workspace);
  const detail = structuredClone(sample.detail);
  workspace.jobs = [];
  workspace.refreshingRepos = [];
  const template = detail.attempts.findLast((attempt) => attempt.review)!.review!;
  detail.attempts.at(-1)!.review = {
    ...template,
    decision: "error",
    coverage: [],
    findings: [],
    error: { attempts: 2, unresolved_criteria: [], reading: [], ...error },
  } as typeof template;
  return { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
}
const view = (task: TaskContext) =>
  render(
    <QueryClientProvider client={client}>
      <ReviewScreen {...task} />
    </QueryClientProvider>,
  );
/** The summary line as a person reads it: the `i`'s panel left out. */
function summary(): { shown: string; hint: string } {
  const line = document.querySelector<HTMLElement>(".review-summary p")!;
  const hint = screen.getByRole("button", { name: "The review's error" });
  expect(line.contains(hint)).toBe(true);
  const panel = document.getElementById(hint.getAttribute("aria-describedby")!)!;
  const shown = line.cloneNode(true) as HTMLElement;
  shown.querySelector(".info-hint-body")!.remove();
  return { shown: shown.textContent ?? "", hint: panel.textContent ?? "" };
}

describe("the review page's summary of a review that ended on an error", () => {
  it.each(["verdict_rejected", "malformed_verdict", "unknown_criterion_id"] as const)(
    "says a %s answer could not be parsed, with the recorded error only behind the i",
    (kind) => {
      view(context({ kind, message: REJECTED }));
      const { shown, hint } = summary();
      expect(shown).toContain("The reviewer's answer could not be parsed.");
      expect(shown).not.toContain("review findings unavailable");
      expect(shown).not.toContain("unresolved findings");
      expect(shown).not.toContain("cannot accept");
      expect(hint).toBe(REJECTED);
    },
  );

  it("keeps its own sentence for an error of another kind, the recorded error behind the i", () => {
    const message = "the provider did not answer: claude exited 1 (reading src/feature.ts)";
    view(context({ kind: "provider_unavailable", message }));
    const { shown, hint } = summary();
    expect(shown).toContain("review findings unavailable");
    expect(shown).not.toContain("could not be parsed");
    expect(shown).not.toContain("the provider did not answer");
    expect(hint).toBe(message);
  });
});
