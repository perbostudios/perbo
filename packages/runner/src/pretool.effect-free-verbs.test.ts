import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { codexCommandDecision } from "./codex/index.js";
import { EFFECT_FREE_VERBS, judgePreToolCall, type PreToolGuardState } from "./pretool.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The verbs the guard treats as having no effect it has not already judged are
 * one set, and both executors read it.
 *
 * Each verb is exercised through the executor that consults the set, with the
 * entry present and with it taken out: an entry that changes no decision in
 * either executor is not pinned by anything, and a second copy of the list
 * would drift silently.
 */
const ROOT = realpathSync(scratch("perbo-effect-free-"));
mkdirSync(join(ROOT, "src"));

const state: PreToolGuardState = {
  root: ROOT,
  cwd: ROOT,
  tmpdir: null,
  paths_allowed: ["**"],
  paths_prohibited: [],
  allow_list: ["Bash(cat:*)"],
  deny_list: [],
};

/** One line per verb, in the shape that verb is actually written. */
const FORMS: Record<string, string> = {
  cd: "cd src",
  pushd: "pushd src",
  popd: "popd",
  pwd: "pwd",
  echo: "echo x",
  printf: "printf x",
  true: "true",
  false: "false",
  ":": ":",
};

const claude = (line: string) =>
  judgePreToolCall(
    { tool_name: "Bash", tool_use_id: "t", tool_input: { command: line } },
    state,
    new Date(0),
  ).decision.answer;

// Codex reaches its own eligibility rule only where the hook defers, which a
// wrapping shell forces; the `cat` gives the line something the allow-list
// carries, so the verb is what the answer turns on.
const codex = (line: string) =>
  codexCommandDecision(`/bin/zsh -lc "${line} && cat src/a.ts"`, ROOT, state).decision;

/** Runs `body` with `verb` out of the set, and puts it back either way. */
const without = (verb: string, body: () => void) => {
  EFFECT_FREE_VERBS.delete(verb);
  try {
    body();
  } finally {
    EFFECT_FREE_VERBS.add(verb);
  }
};

describe("the effect-free verbs", () => {
  it("has a line for every verb and none for a verb that is gone", () => {
    expect(Object.keys(FORMS).sort()).toEqual([...EFFECT_FREE_VERBS].sort());
  });

  for (const [verb, form] of Object.entries(FORMS)) {
    if (verb === "popd") continue;
    it(`admits \`${form}\` in both executors, and neither once \`${verb}\` leaves the set`, () => {
      expect(claude(form)).toBe("allow");
      expect(codex(form)).toBe("allowed");
      without(verb, () => {
        expect(claude(form)).toBe("defer");
        expect(codex(form)).toBe("denied");
      });
    });
  }

  it("refuses `popd` with the entry and without it, because the reader refuses every popd", () => {
    expect(claude("popd")).toBe("deny");
    expect(codex("popd")).toBe("denied");
    without("popd", () => {
      expect(claude("popd")).toBe("deny");
      expect(codex("popd")).toBe("denied");
    });
  });
});
