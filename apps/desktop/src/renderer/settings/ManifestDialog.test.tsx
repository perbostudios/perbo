// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ManifestDialog } from "./ManifestDialog.js";
import { bridge } from "../workspace/index.js";
import type { ManifestEditor, ReplyMap, Request } from "../../shared/protocol.js";

// jsdom has no modal dialog; the dialog's own open state is all these cases read.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
});

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const repoId = "repo_a";

const manifest = (digest: string, offLimits: string[]): ReplyMap["manifest"] => ({
  digest,
  value: { entries: [], offLimits },
  testCommand: "t",
});

/**
 * The dialog over a spy: `manifest` answers whatever the case says it reads
 * now, and `saveManifest` records the digest the save carried.
 */
function mount(reads: () => ReplyMap["manifest"], cached?: ReplyMap["manifest"]) {
  const saves: { digest: string; value: ManifestEditor }[] = [];
  const closes: number[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  if (cached) client.setQueryData(["manifest", repoId], cached);
  vi.spyOn(bridge, "request").mockImplementation(
    async <T extends Request>(request: T): Promise<ReplyMap[T["kind"]]> => {
      if (request.kind === "manifest") return reads() as ReplyMap[T["kind"]];
      if (request.kind === "saveManifest") {
        saves.push({ digest: request.digest, value: request.value });
        return null as ReplyMap[T["kind"]];
      }
      throw new Error(`unexpected ${request.kind}`);
    },
  );
  render(
    <QueryClientProvider client={client}>
      <ManifestDialog repoId={repoId} close={() => closes.push(1)} />
    </QueryClientProvider>,
  );
  return { client, saves, closes };
}

const paths = (): HTMLTextAreaElement =>
  screen.getByRole("textbox", { name: "Off-limits paths" }) as HTMLTextAreaElement;
const save = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "Save manifest" }) as HTMLButtonElement;

describe("the worktree manifest dialog", () => {
  /**
   * The configuration has moved since the cached read — another writer, the
   * CLI, or a hand edit — and reopening the dialog is how a person recovers.
   * Holding a copy of the read made the reopen show the stale one and every
   * save fail until the cache entry was collected.
   */
  it("shows the configuration as it reads now, and saves against that digest", async () => {
    const { saves } = mount(() => manifest(B, ["new/**"]), manifest(A, ["old/**"]));
    await waitFor(() => expect(paths().value).toBe("new/**"));
    fireEvent.click(save());
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]!.digest).toBe(B);
  });

  /**
   * A change under an unfinished edit is said rather than silently applied or
   * silently lost: the host would refuse the save, and the interface should
   * say so before it is tried.
   */
  it("says when the configuration moved under an edit, and can start again from it", async () => {
    let read = manifest(A, ["theirs-not-yet/**"]);
    const { client, saves } = mount(() => read);
    await waitFor(() => expect(paths().value).toBe("theirs-not-yet/**"));
    fireEvent.change(paths(), { target: { value: "mine/**" } });
    read = manifest(B, ["theirs/**"]);
    await client.invalidateQueries({ queryKey: ["manifest", repoId] });
    await screen.findByText(
      "The repository configuration changed after you started editing. Saving now would be refused.",
    );
    expect(save().disabled).toBe(true);
    expect(paths().value).toBe("mine/**");
    fireEvent.click(
      screen.getByRole("button", { name: "Start again from the current configuration" }),
    );
    await waitFor(() => expect(paths().value).toBe("theirs/**"));
    fireEvent.click(save());
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]!.digest).toBe(B);
  });

  it("saves the person's edit against the digest they started from, and closes", async () => {
    const { saves, closes } = mount(() => manifest(A, ["old/**"]));
    await waitFor(() => expect(paths().value).toBe("old/**"));
    fireEvent.change(paths(), { target: { value: "mine/**" } });
    fireEvent.click(save());
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ digest: A, value: { entries: [], offLimits: ["mine/**"] } });
    await waitFor(() => expect(closes).toHaveLength(1));
  });
});
