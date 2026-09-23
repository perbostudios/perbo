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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelPicker, modelName } from "./ConnectionScreens.js";
import { bridge } from "../workspace/index.js";
import { SettingsSchema } from "../../shared/protocol.js";
import type { ModelCatalog, ModelProvider, Provider } from "../../shared/protocol.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});
function mount(
  saved = "claude-sonnet-5",
  role: "executor" | "reviewer" = "executor",
  connections?: Provider[],
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
          connections={connections}
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
        efforts: [],
      },
    ],
  };
}
describe("shared discovered model picker", () => {
  it.each(["executor", "reviewer"] as const)(
    "selects a discovered %s model with no editable model textbox",
    async (role) => {
      mount("claude-sonnet-5", role);
      fireEvent.click(
        screen.getByRole("button", { name: `Change ${role} model` }),
      );
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Sonnet 5"));
      expect(screen.queryByRole("textbox", { name: /Model/ })).toBeNull();
      fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
      fireEvent.click(await screen.findByRole("option", { name: "Fable 5.1" }));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(screen.getByRole("status").textContent).toContain(
        `"${role}Model":"claude-fable-5-1"`,
      );
    },
  );
  it("switches provider using its discovered default and only commits on Done", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Change executor model" }),
    );
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Sonnet 5"));
    fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("O-class"));
    expect(screen.getByText(/"executorModel":"claude-sonnet-5"/)).toBeTruthy();
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
describe("the picker's effort, its edges and its closed reading", () => {
  const open = async (role: "executor" | "reviewer" = "executor") => {
    fireEvent.click(screen.getByRole("button", { name: `Change ${role} model` }));
    return screen.findByRole("group", { name: `${role} model selection` });
  };
  const choose = async (label: string) => {
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Model" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: label }));
  };
  const saved = () => JSON.parse(document.querySelector("output")!.textContent!) as Record<string, unknown>;

  it("closes on a click outside, keeping what was chosen as Done would", async () => {
    mount();
    await open();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Sonnet 5"));
    await choose("Fable 5.1");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group", { name: "executor model selection" })).toBeNull();
    expect(saved().executorModel).toBe("claude-fable-5-1");
  });

  it("stays open on a click outside while no model is chosen", async () => {
    mount();
    const request = vi.spyOn(bridge, "request").mockResolvedValue({
      provider: "codex-cli",
      source: "sample",
      discoveredAt: new Date().toISOString(),
      models: [],
    });
    await open();
    fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    await screen.findByText("No models were reported. Check sign-in and refresh.");
    fireEvent.mouseDown(document.body);
    expect(screen.getByRole("group", { name: "executor model selection" })).toBeTruthy();
    expect(saved().executorProvider).toBe("claude-cli");
    request.mockRestore();
  });

  it("closes on a click outside without changing a saved model the catalog no longer lists", async () => {
    mount("retired-model");
    await open();
    await screen.findByText("Your saved model is no longer listed. Choose a model to replace it.");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group", { name: "executor model selection" })).toBeNull();
    expect(saved().executorModel).toBe("retired-model");
  });

  it("keeps the skill choices and says nothing more about them", async () => {
    mount();
    const popup = await open();
    fireEvent.click(await screen.findByText("Engineering skills · 0 selected"));
    expect(popup.querySelectorAll(".skill-options input[type=checkbox]").length).toBeGreaterThan(3);
    expect(popup.textContent).not.toMatch(/Matt Pocock|Choose up to three|records the version/);
  });

  it("caps the skills list so the popup fits the window, and the list scrolls", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const rule = /\n\.skill-options \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/overflow: auto;/);
    expect(Number(/max-height: (\d+)px;/.exec(rule)?.[1])).toBeLessThanOrEqual(64);
  });

  it("offers the levels a Claude model reports, and reads the choice when closed", async () => {
    mount();
    await open();
    await choose("Opus 5");
    const slider = screen.getByRole("slider", { name: "executor effort" });
    expect(slider.getAttribute("max")).toBe("5");
    expect(slider.getAttribute("aria-valuetext")).toBe("Default");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(screen.getByText("High", { selector: "b" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(saved()).toMatchObject({ executorModel: "claude-opus-5", executorEffort: "high", reviewerEffort: null });
    const closed = screen.getByRole("button", { name: "Change executor model" });
    expect(closed.querySelector("strong")!.textContent).toBe("Opus 5");
    expect(closed.querySelector(".model-effort")!.textContent).toBe("High");
  });

  it("takes a saved level back to Default", async () => {
    mount();
    await open();
    await choose("Opus 5");
    fireEvent.change(screen.getByRole("slider", { name: "executor effort" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(saved().executorEffort).toBe("high");
    await open();
    const slider = await screen.findByRole("slider", { name: "executor effort" });
    expect(slider.getAttribute("aria-valuetext")).toBe("High");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("Default");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(saved().executorEffort).toBeNull();
    const closed = screen.getByRole("button", { name: "Change executor model" });
    expect(closed.querySelector(".model-effort")!.textContent).toBe("Default");
  });

  it("starts a new provider at Default rather than the saved level", async () => {
    mount();
    await open();
    await choose("Opus 5");
    // High, a level Codex's model offers too.
    fireEvent.change(screen.getByRole("slider", { name: "executor effort" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(saved().executorEffort).toBe("high");
    await open();
    fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    const slider = await screen.findByRole("slider", { name: "executor effort" });
    expect(slider.getAttribute("aria-valuetext")).toBe("Default");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(saved()).toMatchObject({ executorProvider: "codex-cli", executorEffort: null });
  });

  it.each([
    [true, false],
    [false, true],
  ])("closed, marks the provider signed in (%s) with its dot", (authenticated, disconnected) => {
    mount("claude-fable-5-1", "executor", [
      { id: "claude", name: "Claude Code", installed: true, authenticated, detail: "", loginCommand: "claude login", roles: [] },
      { id: "codex", name: "Codex", installed: true, authenticated: !authenticated, detail: "", loginCommand: "codex login", roles: [] },
    ]);
    const closed = screen.getByRole("button", { name: "Change executor model" });
    const dot = closed.querySelector(".model-effort + .connection-dot")!;
    expect(dot).toBeTruthy();
    expect(dot.classList.contains("disconnected")).toBe(disconnected);
    expect(closed.querySelector(".spacer")!.lastElementChild).toBe(dot);
  });

  it("offers Codex's own levels, and none for a model that reports none", async () => {
    mount();
    await open();
    await choose("Opus 5");
    fireEvent.change(screen.getByRole("slider", { name: "executor effort" }), { target: { value: "5" } });
    // A model with no effort setting has no control, and nothing is sent for it.
    await choose("Haiku 4.5");
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    const slider = await screen.findByRole("slider", { name: "executor effort" });
    // O-class reports low to xhigh: four stops above Default.
    expect(slider.getAttribute("max")).toBe("4");
    fireEvent.change(slider, { target: { value: "4" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("Extra high");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(saved()).toMatchObject({ executorProvider: "codex-cli", executorEffort: "xhigh" });
  });

  it("sets the reviewer's effort apart from the executor's", async () => {
    mount("claude-sonnet-5", "reviewer");
    await open("reviewer");
    await choose("Sonnet 5");
    fireEvent.change(screen.getByRole("slider", { name: "reviewer effort" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(saved()).toMatchObject({ reviewerEffort: "low", executorEffort: null });
    expect(screen.getByRole("button", { name: "Change reviewer model" }).textContent).toContain("Low");
  });

  it("offers no effort on the optional API, whose catalog reports none", async () => {
    mount("claude-sonnet-5", "reviewer");
    await open("reviewer");
    fireEvent.click(screen.getByRole("combobox", { name: "reviewer provider" }));
    fireEvent.click(await screen.findByRole("option", { name: /Anthropic API/ }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Claude Opus 5"));
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("the name a closed picker reads", () => {
  it.each([
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-opus-5[1m]", "Opus 5 · 1M"],
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["gpt-5.6-terra", "gpt-5.6-terra"],
  ])("%s reads as %s", (id, name) => {
    expect(modelName(id)).toBe(name);
  });
});
