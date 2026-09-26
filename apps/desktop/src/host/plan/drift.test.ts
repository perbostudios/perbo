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
  // A problem open, which is what a turn's end reads the plan again for (D-128).
  drift: {
    open: [{ heading: "Criterion 1 and R1", difference: "R1 asks for one email; criterion 1 promises two.", options: [] }],
    resolved: false,
  },
  conversation: [],
} as unknown as EditingSession;

function readings(
  options: {
    repository?: () => never;
    session?: EditingSession;
    /** How each run of `perbo drift` ends, in turn; a run past the list succeeds. */
    runs?: (Error | null)[];
    /** What each run of `perbo drift` prints, in turn, in place of the answer; a run past the list prints the answer. */
    prints?: unknown[];
    signal?: AbortSignal;
  } = {},
) {
  const said: InterviewEntry["line"][] = [];
  const paused: number[] = [];
  let invoked = 0;
  const landed: DriftFinding[][] = [];
  const recorded: string[] = [];
  const asked: (string | null)[] = [];
  const operations: Promise<void>[] = [];
  let reply: unknown = null;
  const deps: DriftDeps = {
    editing: {
      read: () => options.session ?? session,
      landDrift: (_id: string, verdict: { findings: DriftFinding[] }) => {
        landed.push(verdict.findings);
      },
      clearDrift: () => undefined,
      recordRead: (_id: string, state: string) => {
        recorded.push(state);
      },
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
            signal: options.signal ?? new AbortController().signal,
            invoke: async () => {
              const failure = options.runs?.[invoked] ?? null;
              const printed = options.prints?.[invoked];
              invoked += 1;
              if (failure !== null) throw failure;
              job.result = printed === undefined ? reply : printed;
              return { code: 0, stdout: "", stderr: "", cancelled: false } as never;
            },
          }),
        );
        return job;
      },
      live: () => [],
      settled: () => new Promise<Job>(() => undefined),
    } as unknown as DriftDeps["jobs"],
    state: (id) => {
      const at = `state-of-${id}`;
      asked.push(at);
      return at;
    },
    cli: {} as DriftDeps["cli"],
    models: () => ({ draftingProvider: "claude-cli", executorModel: "claude-opus-5-5" }) as never,
    pause: async (ms) => {
      paused.push(ms);
    },
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
    paused,
    /** How many times `perbo drift` was run. */
    invoked: () => invoked,
    landed,
    recorded,
    asked,
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

  it("fails the reading, rather than leaving the detail out, where a redaction lengthens a detail past what it holds", async () => {
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
    await expect(ran()).rejects.toThrow(
      "The reading's option's detail is longer than the 600 characters it may hold",
    );
    expect(landed).toEqual([]);
  });

  it("keeps a detail whole that fits once redacted, and lets one that redaction empties go", async () => {
    const { drift, landed, answer, ran } = readings();
    answer([
      finding({
        options: [
          { label: "Retry once, as the spec says.", detail: `Quote ${SECRET}.`, recommended: true },
          { label: "Retry twice.", detail: "\u001b[31m", recommended: false },
        ],
      }),
    ]);
    await drift.check("s-1", null);
    await ran();
    expect(landed[0]![0]!.options.map((option) => option.detail)).toEqual(["Quote [redacted].", null]);
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
    // One sentence, and why behind its `i`, whole (D-NEW-nothing-shown-is-cut).
    expect(said).toEqual([{ kind: "note", text: `${REREAD_COULD_NOT_START}.`, output: reason }]);
  });
});

describe("a reading that does not run (D-NEW-basic-and-epic-flows)", () => {
  const down = (): Error => new Error("perbo drift exited with code 1: No credential for Claude.");

  it("is run again after 2, 4 and 8 seconds, and fails its job with the last error once all four tries have failed", async () => {
    const { drift, answer, ran, landed, recorded, paused, invoked } = readings({ runs: [down(), down(), down(), down()] });
    answer([]);
    await drift.check("s-1", "state-read");
    await expect(ran()).rejects.toThrow("No credential for Claude.");
    expect(invoked()).toBe(4);
    expect(paused).toEqual([2_000, 4_000, 8_000]);
    // Nothing is landed or recorded as read, so the next confirm reads again.
    expect(landed).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("lands what a later try reads, as a reading that ran the first time does", async () => {
    const { drift, answer, ran, landed, recorded, paused, invoked } = readings({ runs: [down()] });
    answer([finding({})]);
    await drift.check("s-1", "state-read");
    await ran();
    expect(invoked()).toBe(2);
    expect(paused).toEqual([2_000]);
    expect(landed).toHaveLength(1);
    expect(recorded).toEqual(["state-read"]);
  });

  it("runs again after a print that is not a verdict", async () => {
    const { drift, answer, ran, landed, paused, invoked } = readings({ prints: [{ findings: "not a verdict" }] });
    answer([finding({})]);
    await drift.check("s-1", null);
    await ran();
    expect(invoked()).toBe(2);
    expect(paused).toEqual([2_000]);
    expect(landed).toHaveLength(1);
  });

  it("is not run again once its job is cancelled", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const { drift, answer, ran, paused, invoked } = readings({ runs: [down()], signal: cancelled.signal });
    answer([]);
    await drift.check("s-1", null);
    await expect(ran()).rejects.toThrow("No credential for Claude.");
    expect(invoked()).toBe(1);
    expect(paused).toEqual([]);
  });
});

describe("a re-read owed once a turn ends", () => {
  it("records the state it read at, as a reading a page asked for does", async () => {
    // The re-read after an answer on the Problems pane is a reading like any
    // other: a basic ticket's Confirm contract after it compares the state it
    // is at with this reading's and reads nothing again
    // (D-NEW-basic-and-epic-flows).
    const { drift, answer, ran, recorded, asked } = readings();
    answer([]);
    await drift.reread("s-1");
    await ran();
    expect(asked).toEqual(["state-of-s-1"]);
    expect(recorded).toEqual(["state-of-s-1"]);
  });
});

describe("a turn's end with no problem open", () => {
  it("starts no reading: the chat's edits are read at the confirm (D-128)", async () => {
    const resolved = { ...session, drift: { open: [], resolved: true } } as unknown as EditingSession;
    const { drift, asked, answer } = readings({ session: resolved });
    answer([]);
    await drift.reread("s-1");
    expect(asked).toEqual([]);
    // Owed by a reading a turn overlapped, it is read whatever the record says.
    await drift.reread("s-1", true);
    expect(asked).toEqual(["state-of-s-1"]);
  });
});

describe("a reading the plan was drafted again under (D-NEW-basic-and-epic-flows)", () => {
  it("lands nothing and records no state once Generate plan or Start over replaced the plan it read", async () => {
    const planning = { ...session, drift: null, operation: { id: "op-1", intent: "generate" } } as unknown as EditingSession;
    const { drift, landed, recorded, answer, ran } = readings({ session: planning });
    answer([finding({})]);
    await drift.check("s-1", "state-read");
    // Start over pressed while the model read.
    (planning as { operation: unknown }).operation = { id: "op-2", intent: "startOver" };
    await ran();
    expect(landed).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("lands a reading an operation that drafts nothing overlapped, as before", async () => {
    const planning = { ...session, drift: null, operation: { id: "op-1", intent: "generate" } } as unknown as EditingSession;
    const { drift, landed, recorded, answer, ran } = readings({ session: planning });
    answer([finding({})]);
    await drift.check("s-1", "state-read");
    (planning as { operation: unknown }).operation = { id: "op-2", intent: "compile" };
    await ran();
    expect(landed).toHaveLength(1);
    expect(recorded).toEqual(["state-read"]);
  });
});
