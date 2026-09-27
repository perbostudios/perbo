// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CoverageStatus, CriterionEvidenceBinding, VerificationStrength } from "@perbo/contracts";
import { sampleBridge } from "../../sample-host/bridge.js";
import { RequestSchema, TYPED_TEXT_MAX_CHARS, type Detail, type Request, type Snapshot } from "../../shared/protocol.js";
import { typeInto } from "../../test-support/typing.js";
import { bridge } from "../workspace/index.js";
import { MergeScreen, ReviewScreen } from "./ReviewScreens.js";
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

type Row = { status: CoverageStatus; strength: VerificationStrength; assertion: string } | null;

/**
 * PRB-412's review page, its latest attempt's review covering the contract's
 * criteria as `rows` say, in order; a `null` row leaves that criterion out of
 * the review's coverage.
 */
function context(rows: Row[]): TaskContext {
  const workspace = structuredClone(sample.workspace);
  const detail = structuredClone(sample.detail);
  workspace.jobs = [];
  workspace.refreshingRepos = [];
  const contract = detail.contract as { acceptance_criteria: { id: string; text: string }[] };
  const template = detail.attempts.findLast((attempt) => attempt.review)!.review!;
  contract.acceptance_criteria = rows.map((_, at) => ({
    ...contract.acceptance_criteria[0]!,
    id: `AC-${at + 1}`,
    text: `Criterion number ${at + 1}`,
  }));
  const coverage: CriterionEvidenceBinding[] = rows.flatMap((row, at) =>
    row === null
      ? []
      : [
          {
            criterion_id: `AC-${at + 1}`,
            status: row.status,
            verification_strength: row.strength,
            evidence: {
              type: "test_result",
              ref: null,
              assertion: row.assertion,
              location: { file: "src/mailer.test.ts", line: 40 + at, symbol: null },
            },
            note: null,
            authored_in_response_to: null,
          },
        ],
  );
  detail.attempts.at(-1)!.review = { ...template, findings: [], coverage } as typeof template;
  return { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
}
const view = (task: TaskContext) =>
  render(
    <QueryClientProvider client={client}>
      <ReviewScreen {...task} />
    </QueryClientProvider>,
  );
const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".review-criterion")];
/** The brand icon a card leads with, by its file name. */
const icon = (card: HTMLElement): string =>
  card.querySelector(".review-outcome img")!.getAttribute("src")!.replace(/^.*\//, "").replace(/\.\w+$/, "");
const badge = (card: HTMLElement): HTMLElement => card.querySelector(".evidence-strength")!;

describe("the review page's criterion cards", () => {
  it("lead each criterion with a tick where met, a cross where not met and a question mark where it cannot be determined or was not reviewed", () => {
    view(
      context([
        { status: "met", strength: "directly_verified", assertion: "one" },
        { status: "not_met", strength: "directly_verified", assertion: "two" },
        { status: "cannot_determine", strength: "directly_verified", assertion: "three" },
        null,
      ]),
    );
    expect(cards().map(icon)).toEqual(["approve", "reject", "help", "help"]);
    expect(cards().map((card) => card.querySelector(".review-outcome")!.getAttribute("aria-label"))).toEqual([
      "met",
      "not met",
      "cannot determine",
      "not reviewed",
    ]);
  });

  it("colour the badge by how the criterion was established, in the founder's words", () => {
    view(
      context([
        { status: "met", strength: "directly_verified", assertion: "one" },
        { status: "met", strength: "proxy", assertion: "two" },
        { status: "met", strength: "asserted_only", assertion: "three" },
        null,
      ]),
    );
    expect(cards().map((card) => [badge(card).textContent, badge(card).className])).toEqual([
      ["directly verified", "evidence-strength evidence-strength--green"],
      ["inferred", "evidence-strength evidence-strength--amber"],
      ["evidence not retained", "evidence-strength evidence-strength--red"],
      ["not reviewed", "evidence-strength evidence-strength--red"],
    ]);
  });

  it("say the same words in the same cases as a table, under Established", () => {
    view(
      context([
        { status: "met", strength: "directly_verified", assertion: "one" },
        { status: "met", strength: "proxy", assertion: "two" },
        { status: "not_met", strength: "asserted_only", assertion: "three" },
        null,
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "View as a table" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Criterion", "Outcome", "Established"]);
    expect(
      within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent)),
    ).toEqual([
      ["Criterion number 1", "met", "directly verified"],
      ["Criterion number 2", "met", "inferred"],
      ["Criterion number 3", "not met", "evidence not retained"],
      ["Criterion number 4", "not reviewed", "not reviewed"],
    ]);
  });

  it("carry the criterion and its badge, with the evidence only behind the i beside the criterion", () => {
    view(context([{ status: "met", strength: "directly_verified", assertion: "retries stop after three sends" }]));
    const [card] = cards();
    const evidence = "src/mailer.test.ts:40 · retries stop after three sends";
    const hint = screen.getByRole("button", { name: "The evidence for criterion 01" });
    expect(card!.contains(hint)).toBe(true);
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toBe(evidence);
    const shown = card!.cloneNode(true) as HTMLElement;
    shown.querySelector(".info-hint-body")!.remove();
    expect(shown.textContent).toContain("Criterion number 1");
    expect(shown.textContent).toContain("directly verified");
    expect(shown.textContent).not.toContain("retries stop after three sends");
    expect(shown.textContent).not.toContain("src/mailer.test.ts");
  });
});

/**
 * The founder's rule for a bar of actions: the highlighted one sits at the
 * bottom right.
 */
describe("the review and merge screens' primary action", () => {
  it("is Next, alone at the right of the review page's bottom bar and not in its summary", () => {
    view(context([{ status: "met", strength: "directly_verified", assertion: "one" }]));
    const next = screen.getByRole("button", { name: "Next" });
    const footer = document.querySelector<HTMLElement>("section[data-screen='s15'] > footer.page-footer")!;
    expect(footer.contains(next)).toBe(true);
    expect(footer.lastElementChild).toBe(next);
    expect(document.querySelector(".review-summary")!.contains(next)).toBe(false);
    // Below everything the page reports.
    const body = document.querySelector(".review-body")!;
    expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is Merge on GitHub, at the far right of the merge bar after Back to review and Don't merge", () => {
    const task = context([{ status: "met", strength: "directly_verified", assertion: "one" }]);
    task.detail.ticket.delivery = {
      ...task.detail.ticket.delivery,
      pull_request_url: "https://github.com/o/r/pull/412",
      pull_request_number: 412,
    };
    render(
      <QueryClientProvider client={client}>
        <MergeScreen {...task} />
      </QueryClientProvider>,
    );
    const bar = [...document.querySelectorAll<HTMLElement>(".merge-actions > .button")];
    expect(bar.map((button) => button.textContent)).toEqual(["Back to review", "Don’t merge", "Merge on GitHub"]);
    expect(bar.at(-1)!.className).toContain("button--primary");
  });
});

describe("a note sent back with a finding (D-NEW-nothing-shown-is-cut)", () => {
  it("is held to what a note holds where it is typed, and sent whole without a refusal", async () => {
    // jsdom has no modal dialog; the dialog is only opened here.
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      };
      HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      };
    }
    const task = context([{ status: "met", strength: "directly_verified", assertion: "one" }]);
    const review = task.detail.attempts.at(-1)!.review!;
    const template = sample.detail.attempts.flatMap((attempt) => attempt.review?.findings ?? [])[0];
    expect(template).toBeDefined();
    review.findings = [{ ...template!, status: "open" }];
    const sent: Request[] = [];
    vi.spyOn(bridge, "request").mockImplementation((async (request: Request) => {
      sent.push(request);
      return null;
    }) as typeof bridge.request);
    view(task);
    fireEvent.click(screen.getByRole("button", { name: "Send a finding back" }));
    const note = screen.getByLabelText("Your assessment") as HTMLTextAreaElement;
    typeInto(note, "n".repeat(TYPED_TEXT_MAX_CHARS + 50));
    expect(note.value).toHaveLength(TYPED_TEXT_MAX_CHARS);
    fireEvent.click(within(note.closest("dialog")!).getByRole("button", { name: "Record feedback" }));
    await vi.waitFor(() => expect(sent.some((request) => request.kind === "verdict")).toBe(true));
    const verdict = sent.find((request) => request.kind === "verdict")!;
    expect(RequestSchema.safeParse(verdict).success).toBe(true);
    expect((verdict as { note: string }).note).toBe("n".repeat(TYPED_TEXT_MAX_CHARS));
  });
});
