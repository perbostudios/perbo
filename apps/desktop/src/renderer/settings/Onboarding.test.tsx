// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { PERSON_NAME_MAX_CHARS, RequestSchema, type Request, type Snapshot } from "../../shared/protocol.js";
import { typeInto } from "../../test-support/typing.js";
import { bridge } from "../workspace/index.js";
import { Onboarding } from "./Onboarding.js";

let workspace: Snapshot;
beforeAll(async () => {
  workspace = await sampleBridge.request({ kind: "snapshot" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the name asked for on the first screen (D-NEW-nothing-shown-is-cut)", () => {
  it("is held to what a name holds where it is typed, and saved without a refusal", async () => {
    const sent: Request[] = [];
    vi.spyOn(bridge, "request").mockImplementation((async (request: Request) => {
      sent.push(request);
      return null;
    }) as typeof bridge.request);
    const fresh = structuredClone(workspace);
    fresh.settings.name = "";
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Onboarding workspace={fresh} navigate={() => undefined} />
      </QueryClientProvider>,
    );
    const name = screen.getByRole("textbox", { name: "Your name" }) as HTMLInputElement;
    typeInto(name, "n".repeat(PERSON_NAME_MAX_CHARS + 20));
    expect(name.value).toHaveLength(PERSON_NAME_MAX_CHARS);
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(sent.some((request) => request.kind === "saveSettings")).toBe(true));
    const saved = sent.find((request) => request.kind === "saveSettings")!;
    expect(RequestSchema.safeParse(saved).success).toBe(true);
    expect((saved as Extract<Request, { kind: "saveSettings" }>).settings.name).toBe("n".repeat(PERSON_NAME_MAX_CHARS));
  });
});
