// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CLOSE_REQUEST, CLOSE_RESPONSE, CloseResponseSchema, type DesktopBridge } from "../shared/protocol.js";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
const sent: Array<[string, unknown]> = [];
let bridge: DesktopBridge;

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => handlers.set(channel, handler),
    send: (channel: string, value: unknown) => sent.push([channel, value]),
    invoke: vi.fn(),
    removeListener: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, value: DesktopBridge) => {
      bridge = value;
    },
  },
}));

beforeAll(async () => {
  await import("./preload.js");
});

/**
 * Why the editor could not save before the window closed reaches the host
 * whole (D-NEW-nothing-shown-is-cut): it is what the person is told.
 */
describe("the editor's answer to a close", () => {
  it("carries the whole reason a save failed", async () => {
    const reason = `The contract could not be saved: ${"the host refused it for a reason it states at length, ".repeat(60)}end.`;
    bridge.beforeClose!(() => Promise.reject(new Error(reason)));
    handlers.get(CLOSE_REQUEST)!({}, "8d0e7a0e-4d5e-4a8b-9c1f-2b3a4c5d6e7f");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [channel, value] = sent[0]!;
    expect(channel).toBe(CLOSE_RESPONSE);
    expect(reason.length).toBeGreaterThan(2000);
    const response = CloseResponseSchema.parse(value);
    expect(response.error).toBe(reason);
  });
});
