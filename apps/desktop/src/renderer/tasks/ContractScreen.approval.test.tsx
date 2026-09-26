// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AcceptanceCriterion } from "@perbo/contracts";
import { EditingSessionSchema, RequestSchema, TYPED_PATH_MAX_CHARS } from "../../shared/protocol.js";
import { typeInto } from "../../test-support/typing.js";
import type { ReplyMap, Request } from "../../shared/protocol.js";
import { editingForm } from "../../shared/contract-editing.js";
import { bridge } from "../workspace/index.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import { Composer } from "./Composer.js";
import { ContractScreen } from "./ContractScreen.js";
import type { TaskContext } from "./task-context.js";

let client: QueryClient;
beforeEach(() => {
  sessionStorage.clear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

async function contextFor(criteria: AcceptanceCriterion[]): Promise<TaskContext> {
  const workspace = structuredClone(
    await sampleBridge.request({ kind: "snapshot" }),
  );
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
  const detail = structuredClone(
    await sampleBridge.request({
      kind: "detail",
      repoId: row.repoId,
      key: row.ticket.key,
    }),
  );
  if (!("acceptance_criteria" in detail.contract))
    throw new Error("A criterion contract is required");
  detail.contract.acceptance_criteria = criteria;
  // A flat plan, whose contract lists its criteria; an epic's shows its graph.
  delete detail.contract.nodes;
  detail.attempts = [];
  workspace.jobs = [];
  return {
    workspace,
    detail,
    repoId: row.repoId,
    navigate: vi.fn(),
    show: vi.fn(),
  };
}

function mount(element: ReactNode): void {
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function captureEdits(context: TaskContext) {
  const original = bridge.request.bind(bridge);
  let session = EditingSessionSchema.parse({
    version: 1, id: crypto.randomUUID(), repoId: context.repoId, key: context.detail.ticket.key,
    digest: context.detail.digest, revision: 0, resumeNew: false, lastPane: null, confirmed: null, read: null, impact: null, named: null, drift: null, change: null, phase: "editing", error: null,
    operation: null, interviewModel: null, form: editingForm(context.workspace.settings, context.detail),
  });
  return vi.spyOn(bridge, "request").mockImplementation(
    async <T extends Request>(request: T): Promise<ReplyMap[T["kind"]]> => {
      if (request.kind === "detail") return context.detail as ReplyMap[T["kind"]];
      if (request.kind === "editingSave") session = { ...session, form: request.form, revision: session.revision + 1 };
      if (request.kind === "editingSubmit") session = { ...session, phase: "working" };
      if (["editingOpen", "editingRead", "editingSave", "editingSubmit"].includes(request.kind))
        return structuredClone(session) as ReplyMap[T["kind"]];
      return original(request);
    },
  );
}

const criterion = (
  assertion = "Queue one activation email.",
): AcceptanceCriterion => ({
  id: "AC-1",
  text: "Queue one activation email.",
  expected_verification: { kind: "test", assertion },
});

describe("what the scope does not cover, where it is approved", () => {
  // Impact is only ever actionable before approval — a scope frozen is a scope
  // no warning can move — so the count belongs on the page that freezes it
  // rather than in a pane somebody has to know to open.
  it("says how many files fall outside, and never holds the button for it", async () => {
    const context = await contextFor([criterion()]);
    const original = bridge.request.bind(bridge);
    const asked = vi.spyOn(bridge, "request").mockImplementation((request) =>
      request.kind === "impactContract"
        ? Promise.resolve({
            warnings: [
              { path: "packages/auth/package.json", reasons: [{ kind: "dependency", detail: "" }] },
              { path: "packages/ui/src/theme.ts", reasons: [{ kind: "imports_scope", detail: "" }] },
            ],
            index: { commit: null, files: 0, symbols: 0, supported: true, workingTree: "clean" },
            readAt: new Date().toISOString(),
          } as never)
        : original(request),
    );
    try {
      mount(<ContractScreen {...context} />);
      expect(await screen.findByText(/2 files outside this scope/)).toBeTruthy();
      // Advice, not a gate: the button it sits beside is still live. One that
      // held approval would be one people learn to click past.
      expect(
        (screen.getByRole("button", { name: "Approve · start the loop" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    } finally {
      asked.mockRestore();
    }
  });

  // The ordinary case is a scope that covers what the work reaches, and a line
  // reporting nothing is a line in the way of the one that matters.
  it("says nothing when the scope covers everything", async () => {
    const context = await contextFor([criterion()]);
    const original = bridge.request.bind(bridge);
    const asked = vi.spyOn(bridge, "request").mockImplementation((request) =>
      request.kind === "impactContract"
        ? Promise.resolve({
            warnings: [],
            index: { commit: null, files: 0, symbols: 0, supported: true, workingTree: "clean" },
            readAt: new Date().toISOString(),
          } as never)
        : original(request),
    );
    try {
      mount(<ContractScreen {...context} />);
      await screen.findByRole("button", { name: "Approve · start the loop" });
      await waitFor(() =>
        expect(asked.mock.calls.some(([r]) => r.kind === "impactContract")).toBe(true),
      );
      expect(screen.queryByText(/outside this scope/)).toBeNull();
    } finally {
      asked.mockRestore();
    }
  });
});

describe("contract verification approval", () => {
  it("says where the plan and the spec disagree, and never holds the button for it", async () => {
    // Read before the contract is frozen, because this is the last moment
    // either can still move. Advice and not a gate: a warning that held Approve
    // is one people learn to click past, as the impact count beside it is not.
    const context = await contextFor([
      { id: "ac_1", text: "The queue retries.", expected_verification: { kind: "test", assertion: "a" } },
    ]);
    context.detail.specFindings = [
      { kind: "uncited", requirementId: "R2", criteria: [], text: "The queue gives up." },
      { kind: "dangling", requirementId: "R9", criteria: ["ac_1"], text: null },
    ];
    mount(<ContractScreen {...context} />);

    expect((await screen.findByText(/nothing in this plan/)).textContent).toContain("R2");
    expect(screen.getByText(/no longer states/).textContent).toContain("R9");
    expect(
      (screen.getByRole("button", { name: "Approve · start the loop" }) as HTMLButtonElement)
        .disabled,
      "advice, not a gate",
    ).toBe(false);
  });

  it("says nothing where the plan and the spec agree", async () => {
    const context = await contextFor([
      { id: "ac_1", text: "The queue retries.", expected_verification: { kind: "test", assertion: "a" } },
    ]);
    context.detail.specFindings = [];
    mount(<ContractScreen {...context} />);
    await screen.findByRole("button", { name: "Approve · start the loop" });
    expect(document.querySelectorAll(".spec-findings")).toHaveLength(0);
  });

  it("marks an assertion the draft did not propose, and leaves the others unmarked", async () => {
    // Approving freezes the criteria and their verification, so this is the
    // last place a changed assertion can be read. When one moves the claim is
    // untouched, so nothing else on the page would show it.
    const context = await contextFor([
      { id: "ac_1", text: "The queue retries.", expected_verification: { kind: "test", assertion: "retry.test.ts covers the backoff" } },
      { id: "ac_2", text: "The queue gives up.", expected_verification: { kind: "test", assertion: "give-up.test.ts covers the cap" } },
    ]);
    context.detail.changedAssertions = ["ac_2"];
    mount(<ContractScreen {...context} />);

    const marked = await screen.findByText(/give-up\.test\.ts covers the cap/);
    expect(marked.textContent).toContain("changed since the draft");
    const untouched = screen.getByText(/retry\.test\.ts covers the backoff/);
    expect(untouched.textContent).not.toContain("changed since the draft");
    // A pointer for the eye, not a banner over the page.
    expect(document.querySelectorAll(".criterion-moved")).toHaveLength(1);
  });

  it("shows the assertion, evidence kind and named manual reviewer before approval", async () => {
    const context = await contextFor([
      {
        ...criterion(),
        expected_verification: {
          kind: "query",
          assertion: "The queue contains exactly one row per new signup.",
        },
      },
      {
        id: "AC-2",
        text: "The printed email is readable.",
        expected_verification: {
          kind: "manual",
          assertion: "The paper printout has no clipped text.",
          manual_reviewer: "Morgan Lee",
          manual_reason: "Requires inspection on the office printer.",
        },
      },
    ]);
    mount(<ContractScreen {...context} />);
    expect(
      screen.getByText(
        "Expected query: The queue contains exactly one row per new signup.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Expected manual: The paper printout has no clipped text."),
    ).toBeTruthy();
    expect(screen.getByText("Reviewer: Morgan Lee")).toBeTruthy();
    expect(
      screen.getByText("Why manual: Requires inspection on the office printer."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Approve · start the loop",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Back to planning" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps an assertion derived from criterion text in sync through compilation", async () => {
    const context = await contextFor([criterion()]);
    const requests = captureEdits(context);
    mount(
      <Composer
        {...context}
        existing={context.detail}
        existingRepoId={context.repoId}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit criterion 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), {
      target: { value: "Queue two activation emails." },
    });
    expect(
      (screen.getByLabelText("Observable assertion") as HTMLTextAreaElement).value,
    ).toBe("Queue two activation emails.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Expected test: Queue two activation emails.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compile the contract" }));
    await waitFor(() => expect(requests).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "editingSave",
        form: expect.objectContaining({ draft: expect.objectContaining({
          criteria: [{
            text: "Queue two activation emails.",
            assertion: "Queue two activation emails.",
            kind: "test",
          }],
        }) }),
      }),
    ));
  });

  it("holds a new allowed path to what a path holds where it is typed, and saves it without a refusal (D-NEW-nothing-shown-is-cut)", async () => {
    const context = await contextFor([criterion()]);
    const requests = captureEdits(context);
    mount(
      <Composer
        {...context}
        existing={context.detail}
        existingRepoId={context.repoId}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "+ add a path" }));
    const path = screen.getByRole("textbox", { name: "New allowed path" }) as HTMLInputElement;
    typeInto(path, "p".repeat(TYPED_PATH_MAX_CHARS + 20));
    expect(path.value).toHaveLength(TYPED_PATH_MAX_CHARS);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Compile the contract" }));
    await waitFor(() =>
      expect(requests.mock.calls.some(([request]) => request.kind === "editingSave")).toBe(true),
    );
    const saved = requests.mock.calls.map(([request]) => request).findLast((request) => request.kind === "editingSave")!;
    expect(RequestSchema.safeParse(saved).success).toBe(true);
    expect((saved as Extract<Request, { kind: "editingSave" }>).form.draft.paths).toContain(
      "p".repeat(TYPED_PATH_MAX_CHARS),
    );
  });

  it("lets a distinct assertion and its evidence kind be reviewed and saved together", async () => {
    const context = await contextFor([criterion("The queue contains exactly one row.")]);
    const requests = captureEdits(context);
    mount(
      <Composer
        {...context}
        existing={context.detail}
        existingRepoId={context.repoId}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit criterion 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), {
      target: { value: "Queue two activation emails." },
    });
    const assertion = screen.getByLabelText("Observable assertion") as HTMLTextAreaElement;
    expect(assertion.value).toBe("The queue contains exactly one row.");
    expect(assertion.closest("details")).toBeNull();
    fireEvent.change(assertion, {
      target: { value: "The queue contains exactly two rows." },
    });
    fireEvent.click(screen.getByLabelText("Evidence type"));
    fireEvent.click(screen.getByRole("option", { name: "query" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByText("Expected query: The queue contains exactly two rows."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compile the contract" }));
    await waitFor(() => expect(requests).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "editingSave",
        form: expect.objectContaining({ draft: expect.objectContaining({
          criteria: [{
            text: "Queue two activation emails.",
            assertion: "The queue contains exactly two rows.",
            kind: "query",
          }],
        }) }),
      }),
    ));
  });

  it("refuses an empty assertion and discards all pending fields on Escape", async () => {
    const context = await contextFor([criterion("The queue contains exactly one row.")]);
    const requests = captureEdits(context);
    mount(
      <Composer
        {...context}
        existing={context.detail}
        existingRepoId={context.repoId}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit criterion 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), {
      target: { value: "Queue two activation emails." },
    });
    fireEvent.click(screen.getByLabelText("Evidence type"));
    fireEvent.click(screen.getByRole("option", { name: "query" }));
    const assertion = screen.getByLabelText("Observable assertion");
    fireEvent.change(assertion, { target: { value: "" } });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(assertion, { key: "Escape" });
    expect(
      screen.getByText("Expected test: The queue contains exactly one row."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compile the contract" }));
    await waitFor(() => expect(requests).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "editingSave",
        form: expect.objectContaining({ draft: expect.objectContaining({
          criteria: [{
            text: "Queue one activation email.",
            assertion: "The queue contains exactly one row.",
            kind: "test",
          }],
        }) }),
      }),
    ));
  });

  it("adds a criterion past four, because the plan has as many as the work has (D-100)", async () => {
    const five = Array.from({ length: 5 }, (_, at) => ({ ...criterion(), id: `AC-${at + 1}`, text: `Criterion ${at + 1}.` }));
    const context = await contextFor(five);
    captureEdits(context);
    mount(
      <Composer
        {...context}
        existing={context.detail}
        existingRepoId={context.repoId}
      />,
    );
    const add = (await screen.findByRole("button", { name: /Add a criterion/ })) as HTMLButtonElement;
    expect(screen.getAllByRole("button", { name: /^Edit criterion \d+$/ })).toHaveLength(5);
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(await screen.findByRole("textbox", { name: "Criterion 6" })).toBeTruthy();
  });
});
