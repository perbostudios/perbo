// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ModelPicker } from "../src/renderer/settings/ConnectionScreens.js";
import { bridge } from "../src/renderer/workspace/index.js";
import { SettingsSchema } from "../src/shared/protocol.js";
import type { ModelCatalog, ModelProvider } from "../src/shared/protocol.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});
function mount(
  saved = "sonnet-class",
  role: "executor" | "reviewer" = "executor",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  function Picker() {
    const [models, setModels] = useState(
      SettingsSchema.parse({ executorModel: saved, reviewerModel: saved }),
    );
    return (
      <>
        <ModelPicker
          role={role}
          models={models}
          onChange={(choice) => setModels({ ...models, ...choice })}
        />
        <output>{JSON.stringify(models)}</output>
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Picker />
    </QueryClientProvider>,
  );
  return client;
}
function catalog(provider: ModelProvider, id: string): ModelCatalog {
  return {
    provider,
    discoveredAt: new Date().toISOString(),
    source: "sample",
    models: [
      {
        id,
        label: `Discovered ${id}`,
        description: "From the provider",
        isDefault: true,
      },
    ],
  };
}
describe("shared discovered model picker", () => {
  it.each(["executor", "reviewer"] as const)(
    "selects a discovered %s model with no editable model textbox",
    async (role) => {
      mount("sonnet-class", role);
      fireEvent.click(
        screen.getByRole("button", { name: `Change ${role} model` }),
      );
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Sonnet-class"));
      expect(screen.queryByRole("textbox", { name: /Model/ })).toBeNull();
      fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
      fireEvent.click(await screen.findByRole("option", { name: "Opus sample" }));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(screen.getByRole("status").textContent).toContain(
        `"${role}Model":"opus-sample"`,
      );
    },
  );
  it("switches provider using its discovered default and only commits on Done", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Change executor model" }),
    );
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Sonnet-class"));
    fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("O-class"));
    expect(screen.getByText(/"executorModel":"sonnet-class"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("status").textContent).toContain(
      '"executorModel":"o-class"',
    );
    expect(screen.getByRole("status").textContent).toContain(
      '"draftingProvider":"codex-cli"',
    );
  });
  it("keeps a saved model visible when it disappears instead of silently changing it", async () => {
    mount("retired-model");
    fireEvent.click(
      screen.getByRole("button", { name: "Change executor model" }),
    );
    await screen.findByText(
      "Your saved model is no longer listed. Choose a model to replace it.",
    );
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("retired-model · not listed");
    fireEvent.keyDown(
      screen.getByRole("group", { name: "executor model selection" }),
      { key: "Escape" },
    );
    expect(screen.getByRole("status").textContent).toContain(
      '"executorModel":"retired-model"',
    );
  });
  it("shows a failed refresh and recovers through Refresh models", async () => {
    mount("discovered-id");
    const request = vi
      .spyOn(bridge, "request")
      .mockRejectedValueOnce(new Error("CLI unavailable"));
    fireEvent.click(
      screen.getByRole("button", { name: "Change executor model" }),
    );
    await screen.findByText("CLI unavailable");
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    request.mockResolvedValue(catalog("claude-cli", "discovered-id"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Discovered discovered-id"));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});
