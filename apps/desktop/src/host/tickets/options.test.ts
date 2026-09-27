import { describe, expect, it, vi } from "vitest";
import { SettingsSchema, type ModelCatalog, type Settings } from "../../shared/protocol.js";
import { decisionOptions, type DecisionOptionsDeps } from "./options.js";
import type { RegisteredRepository } from "../profile/store.js";

/**
 * The host's side of the Architect's answers to a decision
 * (D-NEW-decision-options): the command it runs, on which model, and what it
 * lets through to the page.
 */

const repo: RegisteredRepository = { id: "80000000-0000-4000-8000-000000000001", name: "checkout", path: "/checkout" };
const KEY = "d".repeat(64);
const printed = (text = "Park it on the dead-letter queue.") =>
  JSON.stringify({
    key: "PRB-1",
    review_id: "rev_1",
    findings: [{ finding_key: KEY, options: [{ text, recommended: true }] }],
    cached: false,
  });

function deps(over: {
  settings?: Partial<Settings>;
  catalog?: string[] | null;
  results?: Array<{ code: number; stdout: string; stderr: string }>;
}): DecisionOptionsDeps & { runs: string[][]; pauses: number[] } {
  const runs: string[][] = [];
  const pauses: number[] = [];
  const results = [...(over.results ?? [{ code: 0, stdout: printed(), stderr: "" }])];
  return {
    runs,
    pauses,
    cli: {
      run: async (args) => {
        runs.push(args);
        // The last result stands for every run after it.
        return { ...(results.length > 1 ? results.shift()! : results[0]!), cancelled: false };
      },
    },
    catalogs: {
      known: async () =>
        over.catalog === null
          ? undefined
          : ({ models: (over.catalog ?? []).map((id) => ({ id, isDefault: false })) } as unknown as ModelCatalog),
    },
    models: () => SettingsSchema.parse({ executorModel: "claude-sonnet-5", ...over.settings }),
    pause: async (ms) => void pauses.push(ms),
  };
}

describe("the Architect's answers, as the host asks for them", () => {
  it("runs perbo options with the ticket and each finding, on the Architect's provider and model", async () => {
    const asked = deps({ catalog: ["claude-sonnet-5", "claude-opus-5-5"] });
    const answer = await decisionOptions(asked, repo, "PRB-1", [KEY]);
    expect(asked.runs).toEqual([
      ["options", "PRB-1", "--finding", KEY, "--provider", "claude-cli", "--model", "claude-opus-5-5", "--json"],
    ]);
    expect(answer.findings[0]!.options).toEqual([{ text: "Park it on the dead-letter queue.", recommended: true }]);

    // The Architect model the person chose, where it is on the drafting provider.
    const chosen = deps({ settings: { architectProvider: "claude-cli", architectModel: "claude-haiku-5" } });
    await decisionOptions(chosen, repo, "PRB-1", [KEY]);
    expect(chosen.runs[0]!.slice(-5, -1)).toEqual(["--provider", "claude-cli", "--model", "claude-haiku-5"]);

    // A catalog that cannot be read falls to the planning's executor model.
    const unread = deps({ catalog: null });
    await decisionOptions(unread, repo, "PRB-1", [KEY]);
    expect(unread.runs[0]!.slice(-3, -1)).toEqual(["--model", "claude-sonnet-5"]);
  });

  it("tries a command that did not run again after each pause, and says the last failure redacted", async () => {
    vi.stubEnv("PERBO_TEST_TOKEN", "hunter2x");
    try {
      const failing = deps({
        results: [{ code: 1, stdout: "", stderr: "error: no credential hunter2x" }],
      });
      await expect(decisionOptions(failing, repo, "PRB-1", [KEY])).rejects.toThrow(
        "error: no credential [redacted]",
      );
      expect(failing.runs).toHaveLength(4);
      expect(failing.pauses).toEqual([2_000, 4_000, 8_000]);

      const late = deps({
        results: [
          { code: 1, stdout: "", stderr: "error: the network" },
          { code: 0, stdout: printed(), stderr: "" },
        ],
      });
      expect((await decisionOptions(late, repo, "PRB-1", [KEY])).findings).toHaveLength(1);
      expect(late.runs).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("redacts an answer and fails one redaction lengthens past its length rather than cutting it (D-NEW-nothing-shown-is-cut)", async () => {
    vi.stubEnv("PERBO_TEST_TOKEN", "hunter2x");
    try {
      const kept = await decisionOptions(
        deps({ results: [{ code: 0, stdout: printed("Rotate hunter2x\n  now."), stderr: "" }] }),
        repo,
        "PRB-1",
        [KEY],
      );
      expect(kept.findings[0]!.options[0]!.text).toBe("Rotate [redacted] now.");
      const long = "Rotate hunter2x " + "x".repeat(400 - "Rotate hunter2x ".length);
      await expect(
        decisionOptions(deps({ results: [{ code: 0, stdout: printed(long), stderr: "" }] }), repo, "PRB-1", [KEY]),
      ).rejects.toThrow(/longer than the 400 characters it may hold once a secret in it is redacted/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
