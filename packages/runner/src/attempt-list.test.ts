import { describe, expect, it } from "vitest";
import type { ExecutionAttempt, RunBundle } from "@perbo/contracts";
import { attemptList } from "./attempt-list.js";
import { attemptsSection } from "./delivery.js";
import { makeAttempt } from "./test-support/records.js";

/**
 * The pull request's list of attempts (D-NEW-pass-a-limited-loop-on), read
 * from the ticket's attempts record and its review bundles.
 */

const on = (attempt: ExecutionAttempt, adapter: string, model: string): ExecutionAttempt => ({
  ...attempt,
  agent: { ...attempt.agent, adapter, model },
});
/** A review bundle as the loop writes one: the attempt it judged, the verdict, and the connection and model in `versions`. */
const review = (attempt_id: string, tool: string, model: string, decision: string, created_at: string): RunBundle =>
  ({
    kind: "review",
    subject_id: `rev_${attempt_id}`,
    created_at,
    inputs: { attempt_id, decision },
    versions: { code: "stage-2", prompt: "reviewer_v2", policy: "blocking-matrix-v2", model, tool },
  }) as unknown as RunBundle;

/** The rows of the section, header included. */
const rows = (lines: string[]): string[] => lines.filter((line) => line.startsWith("| "));

describe("the pull request's list of attempts", () => {
  it("has one row for a ticket that ran once", () => {
    const attempt = on(makeAttempt({ attempt_id: "att_0000000000000001" }), "claude-code", "claude-opus-5-5");
    const list = attemptList([attempt], [review("att_0000000000000001", "claude-cli", "claude-fable-5-1", "approve", "2026-09-04T01:00:00.000Z")]);
    expect(rows(attemptsSection(list))).toEqual([
      "| # | run | round | executor | ended | review |",
      "| 1 | 1 | 0 | Claude Code · `claude-opus-5-5` | completed | Claude Code · `claude-fable-5-1`: approve |",
    ]);
  });

  it("says the reviewer ran on another connection after its usage limit, and leaves a closure verification out", () => {
    const limited: ExecutionAttempt = {
      ...on(makeAttempt({ attempt_id: "att_0000000000000001", root_attempt_id: "att_0000000000000001" }), "codex", "gpt-5.5"),
      usage_limit: {
        role: "reviewer",
        provider: "claude-cli",
        model: "claude-fable-5-1",
        until: "2026-09-04T03:30:00.000Z",
        zone: "Europe/London",
        quoted: "You've hit your session limit · resets 4:30am (Europe/London)",
      },
    };
    const carried = on(
      makeAttempt({ attempt_id: "att_0000000000000002", root_attempt_id: "att_0000000000000002" }),
      "codex",
      "gpt-5.5",
    );
    const list = attemptList(
      [limited, carried],
      [
        review("att_0000000000000001", "claude-cli", "claude-fable-5-1", "error", "2026-09-04T01:00:00.000Z"),
        {
          ...review("att_0000000000000002", "anthropic", "claude-opus-5", "approve", "2026-09-04T05:00:00.000Z"),
          subject_id: "cv_att_0000000000000002",
        } as RunBundle,
        review("att_0000000000000002", "anthropic", "claude-opus-5", "approve", "2026-09-04T04:00:00.000Z"),
      ],
    );
    expect(rows(attemptsSection(list)).slice(1)).toEqual([
      "| 1 | 1 | 0 | Codex · `gpt-5.5` | completed; its review was refused by the usage limit on Claude Code until " +
        "2026-09-04T03:30:00.000Z (Europe/London) | Claude Code · `claude-fable-5-1`: error |",
      "| 2 | 2 | 0 | Codex · `gpt-5.5` | completed | Anthropic API · `claude-opus-5`: approve — another connection " +
        "or model than Claude Code · `claude-fable-5-1`, after the usage limit on Claude Code |",
    ]);
  });

  it("says a model a run was started on is another, and writes a long list whole", () => {
    const attempts = Array.from({ length: 40 }, (_, index) =>
      on(
        makeAttempt({
          attempt_id: `att_${String(index).padStart(16, "0")}`,
          root_attempt_id: `att_${String(index).padStart(16, "0")}`,
        }),
        "claude-code",
        index === 20 ? "claude-sonnet-5" : "claude-opus-5-5",
      ),
    );
    const listed = rows(attemptsSection(attemptList(attempts, []))).slice(1);
    expect(listed).toHaveLength(40);
    expect(listed[20]).toBe(
      "| 21 | 21 | 0 | Claude Code · `claude-sonnet-5` — another connection or model than Claude Code · " +
        "`claude-opus-5-5`, as this run was started | completed | none |",
    );
  });

  it("keeps a row for a record it cannot read, and a table cell's pipes", () => {
    const list = attemptList(
      [{ attempt_id: "att_0000000000000009" }, on(makeAttempt({ attempt_id: "att_0000000000000001" }), "a|b", "m|n")],
      [],
    );
    expect(rows(attemptsSection(list)).slice(1)).toEqual([
      "| 1 | 1 | not recorded | not recorded | its record could not be read | none |",
      "| 2 | 2 | 0 | a\\|b · `m\\|n` | completed | none |",
    ]);
  });
});
