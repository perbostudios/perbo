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

describe("OpenCode as the run's executor and reviewer (D-NEW-opencode-is-a-provider)", () => {
  it("runs `opencode` on OpenCode Zen's Claude Opus 5 where the configuration names neither", () => {
    expect(TicketRunConfigSchema.parse({ ...base, agent_provider: "opencode-cli" })).toMatchObject({
      agent_binary: "opencode",
      model: "opencode/claude-opus-5",
    });
    expect(TicketRunConfigSchema.parse({ ...base, reviewer_provider: "opencode-cli" }).reviewer_provider).toBe("opencode-cli");
  });

  it("takes no effort level for OpenCode, and says so", () => {
    const refused = TicketRunConfigSchema.safeParse({
      ...base,
      agent_provider: "opencode-cli",
      effort: "low",
      reviewer_provider: "opencode-cli",
      reviewer_effort: "high",
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
      "opencode-cli takes no effort level, not low",
      "opencode-cli takes no effort level, not high",
    ]);
  });
});
