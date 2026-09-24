import { describe, expect, it } from "vitest";
import { TicketRunConfigSchema } from "./config.js";

const base = {
  ticket_key: "X",
  repository_root: "/",
  worktree_root: "/",
  bundle_root: "/",
  quarantine_root: "/",
  state_root: "/",
};

describe("each role's effort in the run configuration", () => {
  it("is null, sending nothing, unless configured", () => {
    expect(TicketRunConfigSchema.parse(base)).toMatchObject({ effort: null, reviewer_effort: null });
  });

  it("takes a level its role's provider takes, and refuses one it does not", () => {
    expect(
      TicketRunConfigSchema.parse({ ...base, agent_provider: "codex-cli", effort: "ultra", reviewer_provider: "anthropic", reviewer_effort: "max" }),
    ).toMatchObject({ effort: "ultra", reviewer_effort: "max" });
    const refused = TicketRunConfigSchema.safeParse({ ...base, effort: "ultra", reviewer_provider: "anthropic", reviewer_effort: "ultra" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join("."))).toEqual(["effort", "reviewer_effort"]);
    expect(refused.error?.issues[0]?.message).toBe("claude-cli takes low, medium, high, xhigh, max, not ultra");
  });
});
