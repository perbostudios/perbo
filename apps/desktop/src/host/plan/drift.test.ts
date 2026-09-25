import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REREAD_COULD_NOT_START } from "../../shared/contract-editing.js";
import { DriftReadings, type DriftDeps } from "./drift.js";
import type { JobOperation } from "../jobs/runner.js";
import type { DriftFinding } from "@perbo/planning";
import type { EditingSession, InterviewEntry, Job } from "../../shared/protocol.js";

/**
 * A reading's words on their way to the person (D-128): redacted, and never
 * cut short to fit — a field a redaction lengthens past what it holds fails
 * the reading rather than showing a sentence cut off, and a note the chat is
 * given is given whole.
 */

/** A secret-named value in the environment, short enough that `[redacted]` is longer than it. */
const SECRET = "q7w8e9r0";
beforeEach(() => {
  process.env["PERBO_DRIFT_TEST_TOKEN"] = SECRET;
});
afterEach(() => {
  delete process.env["PERBO_DRIFT_TEST_TOKEN"];
});

const session = {
  id: "s-1",
  repoId: "r-1",
  key: "PRB-1",
  specSlug: "signup-mail",
  phase: "ready",
  drift: { open: [], resolved: false },
  conversation: [],
} as unknown as EditingSession;

function readings(options: { repository?: () => never } = {}) {
  const said: InterviewEntry["line"][] = [];
  const landed: DriftFinding[][] = [];
  const operations: Promise<void>[] = [];
  let reply: unknown = null;
  const deps: DriftDeps = {
    editing: {
      read: () => session,
      landDrift: (_id: string, verdict: { findings: DriftFinding[] }) => {
        landed.push(verdict.findings);
      },
      clearDrift: () => undefined,
      recordRead: () => undefined,
    } as unknown as DriftDeps["editing"],
    sessions: () => [session],
    repository: options.repository ?? (() => ({ id: "r-1", name: "webstore", path: "/tmp/webstore" })),
    tickets: { list: async () => ({ tickets: [{ key: "PRB-1", approved_at: null }] }) } as unknown as DriftDeps["tickets"],
    reads: { invalidate: () => undefined },
    jobs: {
      start: (meta: { key: string | null; kind: string }, operation: JobOperation) => {
        const job = { id: "j-1", repoId: "r-1", key: meta.key, kind: meta.kind, state: "running" } as Job;
        operations.push(
          operation(job, {
            signal: new AbortController().signal,
            invoke: async () => {
              job.result = reply;
              return { code: 0, stdout: "", stderr: "", cancelled: false } as never;
            },
          }),
        );
        return job;
      },
      live: () => [],
      settled: () => new Promise<Job>(() => undefined),
    } as unknown as DriftDeps["jobs"],
    cli: {} as DriftDeps["cli"],
    models: () => ({ draftingProvider: "claude-cli", executorModel: "claude-opus-5-5" }) as never,
    interview: {
      working: () => false,
      say: (_id, line) => {
        said.push(line);
        return null;
      },
      askingChanged: () => undefined,
    },
  };
  return {
    drift: new DriftReadings(deps),
    said,
    landed,
    answer: (findings: DriftFinding[]) => {
      reply = {
        key: "PRB-1",
        spec: `sha256:${"a".repeat(64)}`,
        promises: `sha256:${"b".repeat(64)}`,
        origin: "read",
        findings,
        dismissed: false,
        checked_at: "2026-09-25T10:00:00.000Z",
        model: null,
        cached: true,
      };
    },
    /** The reading's own work, once it has run. */
    ran: () => operations[0]!,
  };
}

const finding = (over: Partial<DriftFinding>): DriftFinding => ({
  heading: "Criterion 2 and R2",
  difference: "R2 asks for one retry; criterion 2 promises two.",
  options: [
    { label: "Retry once, as the spec says.", detail: null, recommended: true },
    { label: "Retry twice, and say so in the spec.", detail: null, recommended: false },
  ],
  ...over,
});

describe("what a reading puts in front of the person", () => {
  it("shows a field whole, with the secret it quoted redacted", async () => {
    const { drift, landed, answer, ran } = readings();
    answer([finding({ heading: `The token ${SECRET} is in the spec` })]);
    await drift.check("s-1", null);
    await ran();
    expect(landed[0]![0]!.heading).toBe("The token [redacted] is in the spec");
  });

  it("fails the reading, rather than cutting it, where a redaction lengthens a field past what it holds", async () => {
    const { drift, landed, answer, ran } = readings();
    // 119 characters as the model wrote them, 121 once the secret is `[redacted]`.
    const heading = `The token ${SECRET} is quoted in the spec as written ${"x".repeat(119 - 52)}`;
    expect(heading).toHaveLength(119);
    answer([finding({ heading })]);
    await drift.check("s-1", null);
    await expect(ran()).rejects.toThrow("The reading's heading is longer than the 120 characters it may hold");
    expect(landed).toEqual([]);
  });

  it("leaves out a detail a redaction lengthens past what it holds, whole, and keeps the rest", async () => {
    const { drift, landed, answer, ran } = readings();
    const detail = `Quote ${SECRET} ${"y".repeat(599 - 15)}`;
    expect(detail).toHaveLength(599);
    answer([
      finding({
        options: [
          { label: "Retry once, as the spec says.", detail, recommended: true },
          { label: "Retry twice.", detail: "The spec says two.", recommended: false },
        ],
      }),
    ]);
    await drift.check("s-1", null);
    await ran();
    expect(landed[0]![0]!.options.map((option) => option.detail)).toEqual([null, "The spec says two."]);
  });
});

describe("a reading owed that could not be started", () => {
  it("says why in the chat whole, however long the reason", async () => {
    const reason = "The repository this planning is in is no longer registered with Perbo. ".repeat(40).trim();
    const { drift, said } = readings({
      repository: () => {
        throw new Error(reason);
      },
    });
    await drift.reread("s-1");
    expect(reason.length).toBeGreaterThan(2000);
    expect(said).toEqual([{ kind: "note", text: `${REREAD_COULD_NOT_START}: ${reason}` }]);
  });
});
