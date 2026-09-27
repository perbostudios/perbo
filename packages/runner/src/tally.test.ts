import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTally, SecretIndex, type CommandRecord, type ExecutionAttempt, type RunBundle } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { BundleStore } from "./bundle.js";
import { RunTally, worktreePath, type AttemptTally } from "./tally.js";
import { makeAttempt } from "./test-support/records.js";

const scratch = scratchDirectories("perbo-runner-");
const TICKET = "ticket_SCP094";

/** A diff that adds each of `paths`, as the seal writes one. */
const diffOf = (paths: readonly string[]): string =>
  paths
    .map((path) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`)
    .join("");

function write(
  store: BundleStore,
  kind: RunBundle["kind"],
  subject_id: string,
  usage: Pick<RunBundle["usage"], "input_tokens" | "output_tokens" | "cost_micros" | "cost_basis"> & {
    cost_partial?: boolean;
  },
  extra: { attempt_id?: string; changeset_id?: string; diff?: readonly string[] } = {},
): void {
  store.write({
    kind,
    subject_id,
    ticket_id: TICKET,
    inputs: {
      ...(extra.attempt_id === undefined ? {} : { attempt_id: extra.attempt_id }),
      ...(extra.changeset_id === undefined ? {} : { changeset_id: extra.changeset_id }),
    },
    context_manifest: [],
    versions: { code: "stage-2", prompt: "p", policy: "local", model: "m", tool: "t" },
    usage: { ...usage, wall_clock_ms: 1 },
    artifacts: extra.diff === undefined ? [] : [{ name: "change.diff", media_type: "text/x-diff", body: diffOf(extra.diff) }],
    errors: [],
    transitions: [],
    retention: { class: "raw_transcript", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date(`2026-09-03T09:00:0${subject_id.length % 10}.000Z`),
  });
}

/** A command record, admitted or refused. */
const command = (sequence: number, decision: "allowed" | "denied"): CommandRecord => ({
  sequence,
  tool: "Bash",
  detail: `step ${sequence}`,
  decision,
  denial_reason: decision === "denied" ? "outside the runner's command allow-list" : null,
  denial_rule: null,
  denial_target: null,
  cwd: null,
  decided_by: "pre_execution_hook",
  second_reading: null,
  agent: null,
  at: "2026-09-03T09:00:00.000Z",
});

/**
 * An attempt whose record holds `admitted` commands the guard let run and one it
 * refused, so a tally that counted every command asked for would be one high.
 */
const attempt = (id: string, admitted: number, changeset_id = `cs_${id}`): ExecutionAttempt => {
  const made = makeAttempt({ attempt_id: id });
  const commands = [
    ...Array.from({ length: admitted }, (_, index) => command(index, "allowed")),
    command(admitted, "denied"),
  ];
  return { ...made, changeset_id, commands, usage: { ...made.usage, commands: commands.length } };
};

const running = (over: Partial<AttemptTally>): AttemptTally => ({
  commands: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_micros: 0,
  cost_basis: "unavailable",
  written: [],
  ...over,
});

describe("RunTally", () => {
  it("adds the running attempt to what the run has on record, and counts only the paths the ticket had not changed before", () => {
    const store = new BundleStore({ root: join(scratch("perbo-tally-"), "bundles"), retainContext: true });
    const earlier = attempt("att_0000000000000001", 9);
    write(store, "execution", earlier.attempt_id, { input_tokens: 500, output_tokens: 50, cost_micros: 9000, cost_basis: "transport_reported" }, { diff: ["src/a.ts", "src/b.ts"] });
    const lines: string[] = [];
    const tally = new RunTally({ bundles: store, ticketId: TICKET, before: [earlier], progress: (line) => lines.push(line) });

    // Nothing of the earlier run is in the run's own figures, and a path it changed is not new.
    tally.attempt(running({ commands: 2, input_tokens: 10, output_tokens: 3, written: ["src/a.ts", "src/c.ts"] }));
    expect(readTally(lines.at(-1)!)).toEqual({ commands: 2, files: 1, input_tokens: 10, output_tokens: 3, micros: 0, unpriced: 1, partial: 0 });
    // Printed again only when a figure moves.
    tally.attempt(running({ commands: 2, input_tokens: 10, output_tokens: 3, written: ["src/c.ts", "src/a.ts"] }));
    expect(lines).toHaveLength(1);

    // The attempt is recorded: its record and its bundles replace what the adapter counted.
    const first = attempt("att_0000000000000002", 3);
    write(store, "execution", first.attempt_id, { input_tokens: 100, output_tokens: 20, cost_micros: 5000, cost_basis: "transport_reported" }, { diff: ["src/a.ts", "src/c.ts", "src/d.ts"] });
    tally.recount([first]);
    expect(readTally(lines.at(-1)!)).toEqual({ commands: 3, files: 2, input_tokens: 100, output_tokens: 20, micros: 5000, unpriced: 0, partial: 0 });

    // The review of this attempt reports, and so does a closure verification
    // nothing priced; a review of another attempt is not this attempt's, nor
    // one that records no attempt, whatever change set it names.
    write(store, "review", "rev_0000000000000001", { input_tokens: 7, output_tokens: 1, cost_micros: 1000, cost_basis: "provider_list_estimate" }, { attempt_id: first.attempt_id, changeset_id: first.changeset_id! });
    write(store, "review", "rev_0000000000000002", { input_tokens: 70, output_tokens: 10, cost_micros: 10_000, cost_basis: "transport_reported" }, { attempt_id: "att_other", changeset_id: "cs_other" });
    write(store, "review", "rev_0000000000000003", { input_tokens: 700, output_tokens: 100, cost_micros: 100_000, cost_basis: "transport_reported" }, { changeset_id: first.changeset_id! });
    write(store, "review", `cv_${first.attempt_id}`, { input_tokens: 4, output_tokens: 2, cost_micros: 0, cost_basis: "unavailable" });
    tally.recount([first]);
    expect(readTally(lines.at(-1)!)).toEqual({ commands: 3, files: 2, input_tokens: 111, output_tokens: 23, micros: 6000, unpriced: 1, partial: 0 });

    // The next attempt runs on top of it, stopped part-way once recorded.
    tally.attempt(running({ commands: 1, input_tokens: 5, output_tokens: 1, cost_micros: 300, cost_basis: "provider_list_estimate", written: ["src/e.ts"] }));
    expect(readTally(lines.at(-1)!)).toEqual({ commands: 4, files: 3, input_tokens: 116, output_tokens: 24, micros: 6300, unpriced: 1, partial: 0 });
    const second = attempt("att_0000000000000003", 1);
    write(store, "execution", second.attempt_id, { input_tokens: 5, output_tokens: 1, cost_micros: 300, cost_basis: "provider_list_estimate", cost_partial: true });
    tally.recount([first, second]);
    // It retained no change set, so the path its file tool wrote is not counted.
    expect(readTally(lines.at(-1)!)).toEqual({ commands: 4, files: 2, input_tokens: 116, output_tokens: 24, micros: 6300, unpriced: 1, partial: 1 });
  });

  it("joins each review to the attempt it records, so a carried-forward change set counts its earlier review once and a second review of it counts", () => {
    const store = new BundleStore({ root: join(scratch("perbo-tally-"), "bundles"), retainContext: true });
    const lines: string[] = [];
    const tally = new RunTally({ bundles: store, ticketId: TICKET, before: [], progress: (line) => lines.push(line) });
    const first = attempt("att_0000000000000011", 1, "cs_shared");
    // Carried forward: the next attempt added nothing, and its change set is the first's.
    const carried = attempt("att_0000000000000012", 1, "cs_shared");
    write(store, "execution", first.attempt_id, { input_tokens: 0, output_tokens: 0, cost_micros: 0, cost_basis: "not_incurred" });
    write(store, "execution", carried.attempt_id, { input_tokens: 0, output_tokens: 0, cost_micros: 0, cost_basis: "not_incurred" });
    write(store, "review", "rev_0000000000000011", { input_tokens: 10, output_tokens: 1, cost_micros: 1000, cost_basis: "transport_reported" }, { attempt_id: first.attempt_id, changeset_id: "cs_shared" });

    tally.recount([first, carried]);
    // The first attempt's review, once: not again for the attempt that carried its change set.
    expect(readTally(lines.at(-1)!)).toMatchObject({ commands: 2, input_tokens: 10, output_tokens: 1, micros: 1000 });

    // The carried attempt's own review of the same change set is its own, and counts.
    write(store, "review", "rev_0000000000000012", { input_tokens: 20, output_tokens: 2, cost_micros: 2000, cost_basis: "transport_reported" }, { attempt_id: carried.attempt_id, changeset_id: "cs_shared" });
    tally.recount([first, carried]);
    expect(readTally(lines.at(-1)!)).toMatchObject({ input_tokens: 30, output_tokens: 3, micros: 3000 });
  });

  it("joins no review to an attempt whose only review bundle records no attempt, whatever change set it names", () => {
    const store = new BundleStore({ root: join(scratch("perbo-tally-"), "bundles"), retainContext: true });
    const lines: string[] = [];
    const tally = new RunTally({ bundles: store, ticketId: TICKET, before: [], progress: (line) => lines.push(line) });
    const only = attempt("att_0000000000000021", 1);
    write(store, "execution", only.attempt_id, { input_tokens: 10, output_tokens: 1, cost_micros: 100, cost_basis: "transport_reported" });
    // A bundle written before reviews recorded the attempt they judged: its
    // change set is this attempt's, and nothing else is there to prefer.
    write(store, "review", "rev_0000000000000021", { input_tokens: 700, output_tokens: 100, cost_micros: 100_000, cost_basis: "transport_reported" }, { changeset_id: only.changeset_id! });

    tally.recount([only]);
    expect(readTally(lines.at(-1)!)).toMatchObject({ input_tokens: 10, output_tokens: 1, micros: 100 });
  });

  it("starts a ticket with nothing on record at zero", () => {
    const store = new BundleStore({ root: join(scratch("perbo-tally-"), "bundles"), retainContext: true });
    const lines: string[] = [];
    new RunTally({ bundles: store, ticketId: TICKET, before: [], progress: (line) => lines.push(line) }).attempt(running({}));
    expect(readTally(lines[0]!)).toEqual({ commands: 0, files: 0, input_tokens: 0, output_tokens: 0, micros: 0, unpriced: 1, partial: 0 });
  });
});

describe("worktreePath", () => {
  const worktree = "/w/tree";
  const tmp = "/w/tree/.perbo-tmp";
  it("names a path inside the worktree relative to it, and none outside it, on its root or in the scratch directory", () => {
    expect(worktreePath(worktree, tmp, "src/a.ts")).toBe("src/a.ts");
    expect(worktreePath(worktree, tmp, "/w/tree/src/../lib/b.ts")).toBe("lib/b.ts");
    expect(worktreePath(worktree, tmp, "..cache/c.ts")).toBe("..cache/c.ts");
    expect(worktreePath(worktree, tmp, "/w/other/a.ts")).toBeNull();
    expect(worktreePath(worktree, tmp, "../a.ts")).toBeNull();
    expect(worktreePath(worktree, tmp, "/w/tree")).toBeNull();
    expect(worktreePath(worktree, tmp, "/w/tree/.perbo-tmp/draft.txt")).toBeNull();
    expect(worktreePath(worktree, null, "/w/tree/.perbo-tmp/draft.txt")).toBe(".perbo-tmp/draft.txt");
  });
});
