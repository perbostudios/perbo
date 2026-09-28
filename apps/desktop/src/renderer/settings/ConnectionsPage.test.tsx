// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../shell/App.js";
import { bridge } from "../workspace/index.js";
import { ANTHROPIC_API_ABOUT, type Provider, type Request } from "../../shared/protocol.js";

let client: QueryClient;
beforeEach(() => {
  sessionStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
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
  // The Architect's model beside the executor's and the reviewer's (D-102).
  expect(defaults.contains(screen.getByRole("button", { name: "Change architect model" }))).toBe(true);
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

/**
 * The host's probe answering with the connections given, OpenCode's among
 * them, and everything else as the sample host answers it.
 */
function probeAnswers(rows: Provider[]): void {
  const answer = bridge.request.bind(bridge);
  vi.spyOn(bridge, "request").mockImplementation(((request: Request) =>
    request.kind === "providers" ? Promise.resolve(rows) : answer(request)) as typeof bridge.request);
}
const claude: Provider = { id: "claude", name: "Claude Code", installed: true, authenticated: true, detail: "Signed in with your subscription", loginCommand: "claude auth login", roles: ["Execution", "Independent review", "Planning"] };
const opencode = (roles: string[]): Provider => ({
  id: "opencode",
  name: "OpenCode",
  installed: true,
  authenticated: true,
  detail: "No OPENCODE_API_KEY · OpenCode's free models only",
  loginCommand: "",
  roles,
});

it("draws OpenCode's card as the others are drawn, connected, with no sign-in of its own", async () => {
  probeAnswers([claude, opencode(["Execution", "Independent review", "Planning"])]);
  mount("connections");
  const card = (await screen.findByText("OpenCode", { selector: ".card-heading strong" }, { timeout: 20_000 })).closest("section")!;
  expect(card.querySelector(".connection-dot")?.classList.contains("disconnected")).toBe(false);
  expect(within(card as HTMLElement).queryByRole("button", { name: /Sign in/ })).toBeNull();
  expect(within(card as HTMLElement).getByRole("button", { name: "Refresh" })).toBeTruthy();
  expect(card.textContent).toContain("No OPENCODE_API_KEY · OpenCode's free models only");
  expect(card.textContent).toContain("CLI");
  expect(card.textContent).not.toContain("subscription CLI");
  // Claude Code's card keeps its sign-in.
  const claudeCard = screen.getByText("Claude Code", { selector: ".card-heading strong" }).closest("section")!;
  expect(within(claudeCard as HTMLElement).getByRole("button", { name: "Sign in again" })).toBeTruthy();
});

it("greys out a provider for a role its connection does not offer", async () => {
  probeAnswers([claude, { ...claude, id: "codex", name: "Codex", loginCommand: "codex login", roles: ["Execution", "Planning"] }]);
  mount("connections");
  fireEvent.click(await screen.findByRole("button", { name: "Change reviewer model" }, { timeout: 20_000 }));
  fireEvent.click(screen.getByRole("combobox", { name: "reviewer provider" }));
  expect((await screen.findByRole("option", { name: /Codex/ })).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("combobox", { name: "reviewer provider" }));
  fireEvent.click(screen.getByRole("button", { name: "Change executor model" }));
  fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
  expect((await screen.findByRole("option", { name: /Codex/ })).getAttribute("aria-disabled")).not.toBe("true");
});

it("offers OpenCode in the pickers for the roles its connection offers, and greys it for the rest", async () => {
  probeAnswers([claude, opencode(["Execution", "Planning"])]);
  mount("connections");
  fireEvent.click(await screen.findByRole("button", { name: "Change executor model" }, { timeout: 20_000 }));
  fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
  expect((await screen.findByRole("option", { name: "OpenCode · CLI" })).getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(screen.getByRole("combobox", { name: "executor provider" }));
  fireEvent.click(screen.getByRole("button", { name: "Change reviewer model" }));
  fireEvent.click(screen.getByRole("combobox", { name: "reviewer provider" }));
  expect((await screen.findByRole("option", { name: "OpenCode · CLI" })).getAttribute("aria-disabled")).toBe("true");
});

it("draws no connection dot on an API row, and says what the row is before how its key is supplied", async () => {
  mount("usage");
  const api = (await screen.findByText("Anthropic API", { selector: ".card-heading strong" }, { timeout: 20_000 })).closest("section")!;
  // Nothing probes an API key, so a dot there would say nothing.
  expect(api.querySelector(".connection-dot")).toBeNull();
  const lines = [...api.querySelectorAll("p")].map((line) => line.textContent);
  expect(lines).toEqual([ANTHROPIC_API_ABOUT, "No API key in the app environment."]);
  expect(ANTHROPIC_API_ABOUT).toBe(
    "A direct Anthropic API key, offered for the reviewer only and billed per token under the per-token cost caps, separate from the Claude Code login the executor, reviewer and Architect run on.",
  );
  // A CLI's sign-in is probed, and its row keeps the dot.
  for (const name of ["Claude Code", "Codex", "OpenCode"]) {
    const cli = screen.getByText((text) => text.startsWith(name), { selector: ".card-heading strong" }).closest("section")!;
    expect(cli.querySelector(".connection-dot"), name).not.toBeNull();
  }
});
