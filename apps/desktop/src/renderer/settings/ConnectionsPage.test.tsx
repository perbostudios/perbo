// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../shell/App.js";

let client: QueryClient;
beforeEach(() => {
  sessionStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount(hash: string): void {
  location.hash = hash;
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

it("dots each signed-in account and reads the defaults for new tasks without one", async () => {
  mount("connections");
  const defaults = (await screen.findByText("Defaults for new tasks", undefined, { timeout: 20_000 })).closest(".defaults-card")!;
  const executor = await screen.findByRole("button", { name: "Change executor model" });
  expect(defaults.contains(executor)).toBe(true);
  expect(defaults.querySelector(".connection-dot")).toBeNull();
  const card = (await screen.findByText("Claude Code", { selector: ".card-heading strong" })).closest(".card-heading")!;
  expect(card.querySelector(".connection-dot")?.classList.contains("disconnected")).toBe(false);
});

it("reads the defaults chosen while adding a provider without a dot", async () => {
  mount("providers");
  const defaults = (await screen.findByText("Select your defaults", undefined, { timeout: 20_000 })).closest(".model-defaults")!;
  const executor = await screen.findByRole("button", { name: "Change executor model" });
  expect(defaults.contains(executor)).toBe(true);
  expect(defaults.querySelectorAll(".model-picker")).toHaveLength(2);
  expect(defaults.querySelector(".connection-dot")).toBeNull();
});
