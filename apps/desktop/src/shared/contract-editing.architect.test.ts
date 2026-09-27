import { describe, expect, it } from "vitest";
import { interviewModelFor } from "./contract-editing.js";

/**
 * The model a planning's chat starts on (D-102): the Architect model the
 * person chose, on the provider the planning drafts with, and otherwise the
 * Architect's rule — Claude Opus 5.5 where Claude Code's catalog offers it,
 * and the planning's executor model where it does not.
 */
describe("the Architect's model", () => {
  const planning = (over: Partial<Parameters<typeof interviewModelFor>[0]> = {}) => ({
    draftingProvider: "claude-cli",
    executorModel: "claude-sonnet-5",
    architectProvider: null,
    architectModel: null,
    ...over,
  });
  const offered = ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"];

  it("is the person's choice where they made one on the provider the planning drafts with", () => {
    const chosen = planning({ architectProvider: "claude-cli", architectModel: "claude-fable-5-1" });
    expect(interviewModelFor(chosen, offered)).toBe("claude-fable-5-1");
    // A choice stands even where no catalog could be read.
    expect(interviewModelFor(chosen, null)).toBe("claude-fable-5-1");
    const onCodex = planning({ draftingProvider: "codex-cli", executorModel: "o-class", architectProvider: "codex-cli", architectModel: "codex-sample" });
    expect(interviewModelFor(onCodex, null)).toBe("codex-sample");
  });

  it("takes the rule where the choice was made on another provider", () => {
    const elsewhere = planning({ draftingProvider: "codex-cli", executorModel: "o-class", architectProvider: "claude-cli", architectModel: "claude-fable-5-1" });
    expect(interviewModelFor(elsewhere, offered)).toBe("o-class");
  });

  it("takes Opus 5.5 where nothing is chosen and the catalog offers it, under its 1M id where only that is offered", () => {
    expect(interviewModelFor(planning(), offered)).toBe("claude-opus-5-5");
    expect(interviewModelFor(planning(), ["claude-opus-5-5[1m]"])).toBe("claude-opus-5-5[1m]");
  });

  it("takes the executor's model where nothing is chosen and the catalog does not offer Opus 5.5, or cannot be read", () => {
    expect(interviewModelFor(planning(), ["claude-sonnet-5", "claude-opus-5"])).toBe("claude-sonnet-5");
    expect(interviewModelFor(planning(), null)).toBe("claude-sonnet-5");
  });
});
