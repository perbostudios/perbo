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
import { EditingSessionSchema } from "../src/shared/protocol.js";
import type { ReplyMap, Request } from "../src/shared/protocol.js";
import { editingForm } from "../src/shared/contract-editing.js";
import { bridge } from "../src/renderer/workspace/index.js";
import { sampleBridge } from "../src/sample-host/bridge.js";
import { Composer } from "../src/renderer/tasks/Composer.js";
import { ContractScreen } from "../src/renderer/tasks/ContractScreen.js";
import type { TaskContext } from "../src/renderer/tasks/task-context.js";

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
    digest: context.detail.digest, revision: 0, resumeNew: false, phase: "editing", error: null,
    operation: null, form: editingForm(context.workspace.settings, context.detail),
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

describe("contract verification approval", () => {
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
      (screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled,
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
});
