import { describe, expect, it } from "vitest";
import { attemptEnding, connectionName, stoppedBy } from "./ending.js";

/** How an attempt ended and who ran it, in the one set of words the brief and the pull request read. */
describe("an attempt's ending", () => {
  const plain = (reason: string) => ({ termination: { reason }, wait: null, usage_limit: null });
  const limit = { provider: "codex-cli", until: "2026-09-04T03:30:00.000Z", zone: "Europe/London" };

  it.each([
    ["completed", "completed"],
    ["cancelled", "stopped by a person (`cancelled`)"],
    ["cost_ceiling_exceeded", "stopped by a ceiling (`cost_ceiling_exceeded`)"],
    ["transport_unavailable", "ended when its provider was unavailable"],
    ["stalled", "stalled: no tool activity for the stall window"],
    ["no_changes", "changed nothing"],
    ["workspace_error", "ended `workspace_error`"],
  ])("says %s as %s", (reason, said) => {
    expect(attemptEnding(plain(reason))).toBe(said);
  });

  it("names the connection whose usage limit ended the run, the executor's or its review's", () => {
    expect(
      attemptEnding({ termination: { reason: "transport_unavailable" }, wait: null, usage_limit: { ...limit, role: "executor" } }),
    ).toBe("stopped by the usage limit on Codex until 2026-09-04T03:30:00.000Z (Europe/London)");
    expect(
      attemptEnding({ termination: { reason: "completed" }, wait: null, usage_limit: { ...limit, role: "reviewer" } }),
    ).toBe("completed; its review was refused by the usage limit on Codex until 2026-09-04T03:30:00.000Z (Europe/London)");
  });

  it("says a park the run sat out and went on from", () => {
    expect(
      attemptEnding({ termination: { reason: "transport_unavailable" }, wait: { until: limit.until, zone: limit.zone }, usage_limit: null }),
    ).toBe(
      "refused by its provider, which named its reset; the run waited until 2026-09-04T03:30:00.000Z (Europe/London) and went on",
    );
  });

  it("names who stopped an attempt part-way for the brief", () => {
    expect(stoppedBy("transport_unavailable", "executor")).toBe("its provider's usage limit");
    expect(stoppedBy("cancelled", null)).toBe("a person");
    expect(stoppedBy("wall_clock_exceeded", null)).toBe("a ceiling");
    expect(stoppedBy("agent_error", null)).toBeNull();
  });

  it("names a connection by any of the words the records use for it", () => {
    expect(["claude-cli", "claude-code", "codex-cli", "codex", "opencode-cli", "opencode", "anthropic", "double"].map(connectionName)).toEqual([
      "Claude Code", "Claude Code", "Codex", "Codex", "OpenCode", "OpenCode", "Anthropic API", "double",
    ]);
  });
});
