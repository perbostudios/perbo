import { describe, expect, it } from "vitest";
import { runAgent } from "../../adapter.js";
import { runCodexAgent } from "../../codex/index.js";
import { runOpenCodeAgent } from "../../opencode/index.js";
import { TicketRunConfigSchema } from "./config.js";
import { resolvePorts } from "./context.js";

const config = (agent_provider: string) =>
  TicketRunConfigSchema.parse({
    ticket_key: "X",
    repository_root: "/",
    worktree_root: "/",
    bundle_root: "/",
    quarantine_root: "/",
    state_root: "/",
    agent_provider,
  });

describe("which executor a run hands its brief to", () => {
  it("is the adapter its configuration names, and never a hook's absence", () => {
    expect(resolvePorts(config("claude-cli"), undefined).agent).toBe(runAgent);
    expect(resolvePorts(config("codex-cli"), undefined).agent).toBe(runCodexAgent);
    expect(resolvePorts(config("opencode-cli"), undefined).agent).toBe(runOpenCodeAgent);
  });
});
