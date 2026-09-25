// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { editing as sampleEditing } from "../../sample-host/records.js";
import { useContractEditing } from "../contract-editor.js";
import { planNodes } from "@perbo/contracts/browser";
import { ContractScreen, contractShows } from "./ContractScreen.js";
import type { TaskContext } from "./task-context.js";

let client: QueryClient;
beforeEach(() => {
  sessionStorage.clear();
  localStorage.removeItem("perbo:preview-editing");
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

/** The sample's plan waiting for approval, an epic, or flat where its nodes are taken away; approved where asked. */
async function contextFor({ flat, approved }: { flat: boolean; approved: boolean }): Promise<TaskContext> {
  const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
  const detail = structuredClone(await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }));
  if (!("acceptance_criteria" in detail.contract)) throw new Error("A criterion contract is required");
  if (flat) delete detail.contract.nodes;
  if (approved) detail.ticket.approved_at = "2026-09-01T10:00:00.000Z";
  workspace.jobs = [];
  return { workspace, detail, repoId: row.repoId, navigate: vi.fn(), show: vi.fn() };
}

/** The contract as the planning's contract tab draws it, over the planning's own editor. */
function InPlanning(context: TaskContext) {
  const editor = useContractEditing(
    { kind: "ticket", repoId: context.repoId, key: context.detail.ticket.key },
    context.workspace.settings,
  );
  return <ContractScreen {...context} planning={{ editor }} />;
}

const mount = (element: React.ReactNode): void => {
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
};

describe("what a contract shows of its plan (D-NEW-basic-and-epic-flows)", () => {
  it("is one rule for the contract tab and the contract after approval", async () => {
    const epic = await contextFor({ flat: false, approved: false });
    const flat = await contextFor({ flat: true, approved: false });
    expect(contractShows(epic.detail.contract, true)).toBe("graph");
    expect(contractShows(epic.detail.contract, false)).toBe("graph");
    expect(contractShows(flat.detail.contract, true)).toBe("criteria-editor");
    expect(contractShows(flat.detail.contract, false)).toBe("criteria");
  });

  it.each([false, true])("draws an epic's graph read-only, each node saying its criteria and paths, approved: %s", async (approved) => {
    const context = await contextFor({ flat: false, approved });
    mount(approved ? <ContractScreen {...context} /> : <InPlanning {...context} />);
    const canvas = await screen.findByRole("group", { name: "Execution graph canvas" }, { timeout: 5000 });
    const nodes = within(canvas).getAllByRole("group", { name: /^Node node_/ });
    expect(nodes.length).toBeGreaterThan(0);
    // Read, panned and zoomed: nothing on it is a control, and no edge is drawn from it.
    expect(within(canvas).queryAllByRole("button")).toHaveLength(0);
    expect(canvas.querySelector(".handle, .edge-hit")).toBeNull();
    const plan = planNodes(context.detail.contract)[0]!;
    expect(within(nodes[0]!).getByText(`${plan.criteria.length} ${plan.criteria.length === 1 ? "criterion" : "criteria"} · ${plan.paths.join(" · ")}`)).toBeTruthy();
    // In place of the criteria, and of the list of nodes the graph now carries.
    expect(screen.queryByRole("region", { name: "How the work divides" })).toBeNull();
    expect(screen.queryByText("How the work divides")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit criterion 1" })).toBeNull();
  });

  it("opens a basic ticket's criteria to edit on the contract tab, and reads them only after approval", async () => {
    const waiting = await contextFor({ flat: true, approved: false });
    mount(<InPlanning {...waiting} />);
    expect(await screen.findByRole("button", { name: "Edit criterion 1" }, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Execution graph canvas" })).toBeNull();
    cleanup();
    const approved = await contextFor({ flat: true, approved: true });
    mount(<ContractScreen {...approved} />);
    const first = "acceptance_criteria" in approved.detail.contract ? approved.detail.contract.acceptance_criteria[0]!.text : "";
    expect(await screen.findByText(first)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit criterion 1" })).toBeNull();
  });
});

describe("a basic ticket's criteria written into its contract (D-NEW-basic-and-epic-flows)", () => {
  /**
   * A write the host turns away before it becomes an operation leaves nothing
   * to wait on: the page says why, rather than saying it is still writing.
   */
  it("says the refusal of a write the host turned away, and is not left writing", async () => {
    const context = await contextFor({ flat: true, approved: false });
    const request = sampleBridge.request.bind(sampleBridge);
    vi.spyOn(sampleBridge, "request").mockImplementation(((input: Parameters<typeof request>[0]) =>
      input.kind === "editingSubmit"
        ? Promise.reject(new Error("Another command holds this repository."))
        : request(input)) as typeof sampleBridge.request);
    mount(<InPlanning {...context} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit criterion 1" }, { timeout: 5000 }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), {
      target: { value: "The importer and its routes are gone, and nothing links to them." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Another command holds this repository."));
    expect(screen.queryByText("Writing the change into the contract…")).toBeNull();
    expect((screen.getByRole("button", { name: "Approve · start the loop" }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * A submission that ends with no operation of its own and no refusal —
   * called off before it was sent — leaves nothing to wait on either.
   */
  it("is not left writing after a submission that started no operation", async () => {
    const context = await contextFor({ flat: true, approved: false });
    const request = sampleBridge.request.bind(sampleBridge);
    vi.spyOn(sampleBridge, "request").mockImplementation(((input: Parameters<typeof request>[0]) =>
      input.kind === "editingSubmit"
        ? request({ kind: "editingRead", id: input.id })
        : request(input)) as typeof sampleBridge.request);
    mount(<InPlanning {...context} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit criterion 1" }, { timeout: 5000 }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), {
      target: { value: "The importer and its routes are gone, and nothing links to them." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Writing the change into the contract…");
    await waitFor(() => expect(screen.queryByText("Writing the change into the contract…")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByRole("button", { name: "Approve · start the loop" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the marks on a basic ticket's contract (D-128)", () => {
  /**
   * The chat's last change to the criteria, marked where they are read and
   * edited; the person's own change, made there by hand, marked nowhere.
   */
  it.each([
    ["the chat's change is marked", "chat", true],
    ["the person's own change is not", "person", false],
  ] as const)("%s", async (_, by, marked) => {
    const context = await contextFor({ flat: true, approved: false });
    mount(<InPlanning {...context} />);
    await screen.findByRole("button", { name: "Edit criterion 1" }, { timeout: 5000 });
    const session = (await sampleBridge.request({ kind: "drafts" })).find(
      (draft) => draft.repoId === context.repoId && draft.key === context.detail.ticket.key,
    );
    if (session === undefined) throw new Error("the contract tab must be over a planning");
    const record = await sampleBridge.request({ kind: "editingRead", id: session.id });
    const after = record.form.draft.criteria.map((criterion, index) => ({ id: `ac_${index + 1}`, text: criterion.text }));
    const first = after[0]!.text;
    const before = [{ id: "ac_1", text: "A sentence the change took away." }, ...after.slice(1), { id: "ac_9", text: "A criterion that went." }];
    sampleEditing.recordChange(session.id, {
      at: new Date().toISOString(),
      by,
      spec: null,
      plan: { before: { outcome: record.form.draft.outcome, criteria: before }, after: { outcome: record.form.draft.outcome, criteria: after } },
    });
    await sampleBridge.request({ kind: "editingRead", id: session.id });
    const editor = document.querySelector(".criteria-editor") as HTMLElement;
    if (marked) {
      await waitFor(() => expect(editor.querySelectorAll(".change--added, .change--removed").length).toBeGreaterThan(0));
      expect(within(editor).getByText("A criterion that went.").closest("del")).not.toBeNull();
      expect(editor.textContent).toContain(first);
      // The criterion the chat reworded carries its marks in its own words:
      // what came highlighted, what went struck through where it stood.
      const reworded = editor.querySelector(".criterion-text")!;
      expect(reworded.querySelectorAll(".change--added").length).toBeGreaterThan(0);
      expect(reworded.querySelectorAll(".change--removed").length).toBeGreaterThan(0);
    } else {
      // Given the same time to draw, nothing is marked.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(editor.querySelectorAll(".change--added, .change--removed, del, ins")).toHaveLength(0);
      expect(editor.textContent).not.toContain("A criterion that went.");
    }
  });
});
