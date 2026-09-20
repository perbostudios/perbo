import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { TicketRunConfigSchema } from "./config.js";
import { withCeilingGuidance } from "./attempt.js";

const config = (limits: Record<string, number>) =>
  TicketRunConfigSchema.parse({
    ticket_key: "SCP094",
    repository_root: "/repo",
    base_ref: "main",
    worktree_root: "/wt",
    bundle_root: "/bundles",
    quarantine_root: "/quarantine",
    state_root: "/state",
    agent_binary: "true",
    model: "double",
    limits: LimitsTableSchema.parse({ organisation: "test", limits }),
  });

describe("what a partner is told when a ceiling stops an attempt", () => {
  it("names the limits key, the file that raises it and where it stands", () => {
    const guided = withCeilingGuidance(
      { reason: "iteration_ceiling_exceeded", detail: "the executor ran out of iterations" },
      config({ attempt_iterations: 40 }),
    );

    expect(guided.reason).toBe("iteration_ceiling_exceeded");
    expect(guided.detail).toBe(
      "the executor ran out of iterations — raise limits.limits.attempt_iterations in " +
        `${join("/repo", ".perbo", "config.json")} (currently 40)`,
    );
  });

  it("leaves the number out where nothing has set a limit for that resource", () => {
    const guided = withCeilingGuidance(
      { reason: "command_ceiling_exceeded", detail: "the executor ran out of commands" },
      config({}),
    );

    expect(guided.detail).toBe(
      "the executor ran out of commands — raise limits.limits.attempt_commands in " +
        `${join("/repo", ".perbo", "config.json")}`,
    );
  });

  it("says nothing extra about a termination no ceiling caused", () => {
    const termination = { reason: "completed" as const, detail: "the executor finished" };
    expect(withCeilingGuidance(termination, config({}))).toEqual(termination);
  });
});
