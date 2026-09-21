import { describe, expect, it } from "vitest";
import {
  QUEUE_HOLDING_STATES,
  changedPathsOverlap,
  queueOrder,
  scopeOverlap,
  waitsFor,
  type Scheduled,
} from "./scheduling.js";
import { TicketSchema, type Ticket, type TicketState } from "@perbo/contracts";

/**
 * The queue's decisions are set arithmetic over records a person approved:
 * which ticket goes first, which one waits, and on what. Nothing here reads a
 * model, a clock or a file, so every rule is asserted on fixtures alone.
 */

function ticket(input: {
  key: string;
  state?: TicketState;
  priority?: Ticket["priority"];
  admitted_at?: string;
  depends_on?: string[];
}): Ticket {
  return TicketSchema.parse({
    schema_version: 1,
    ticket_id: `ticket_${input.key.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
    key: input.key,
    title: `${input.key} does a thing.`,
    state: input.state ?? "ready",
    priority: input.priority ?? "normal",
    labels: [],
    depends_on: input.depends_on ?? [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: `plan_${input.key.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
    plan_version: 1,
    approved_at: "2026-09-10T10:00:00.000Z",
    admitted_at: input.admitted_at ?? "2026-09-10T09:00:00.000Z",
    updated_at: "2026-09-10T10:00:00.000Z",
    admission: { elapsed_ms: 10, criteria_source: "typed", criteria_count: 1 },
    history: [{ at: "2026-09-10T09:00:00.000Z", from: null, to: "plan_review", note: "admitted" }],
  });
}

const scheduled = (
  t: Ticket,
  paths_allowed: string[],
  generated_paths: string[] = [],
): Scheduled => ({ ticket: t, scope: { paths_allowed, generated_paths } });

describe("scopeOverlap", () => {
  it("names a glob inside another's static prefix, either way round", () => {
    expect(scopeOverlap(["packages/runner/**"], ["packages/**"])).toEqual([
      { mine: "packages/runner/**", theirs: "packages/**" },
    ]);
    expect(scopeOverlap(["packages/**"], ["packages/runner/src/**"])).toEqual([
      { mine: "packages/**", theirs: "packages/runner/src/**" },
    ]);
  });

  it("does not confuse a sibling directory with a prefix", () => {
    expect(scopeOverlap(["packages/run/**"], ["packages/runner/**"])).toEqual([]);
    expect(scopeOverlap(["apps/cli/**"], ["packages/cli/**"])).toEqual([]);
  });

  it("cuts the prefix at a directory, so a partial segment reaches the files it admits", () => {
    expect(scopeOverlap(["src/foo*.ts"], ["src/foobar.ts"])).toEqual([{ mine: "src/foo*.ts", theirs: "src/foobar.ts" }]);
    expect(scopeOverlap(["src/foobar.ts"], ["src/foo*.ts"])).toEqual([{ mine: "src/foobar.ts", theirs: "src/foo*.ts" }]);
    expect(scopeOverlap(["src/foo*.ts"], ["docs/**"])).toEqual([]);
  });

  it("treats a glob with no literal prefix as reaching everywhere", () => {
    expect(scopeOverlap(["**"], ["docs/**"])).toEqual([{ mine: "**", theirs: "docs/**" }]);
    expect(scopeOverlap(["docs/**"], ["**/*.ts"])).toEqual([{ mine: "docs/**", theirs: "**/*.ts" }]);
  });

  it("is empty for disjoint scopes", () => {
    expect(scopeOverlap(["site/**", "docs/**"], ["packages/runner/**"])).toEqual([]);
  });
});

describe("changedPathsOverlap", () => {
  it("returns the sealed paths a scope's globs admit", () => {
    expect(
      changedPathsOverlap(
        ["packages/runner/src/loop.ts", "docs/04.md", "packages/review/src/prompt.ts"],
        ["packages/runner/**", "docs/**"],
        [],
      ),
    ).toEqual(["packages/runner/src/loop.ts", "docs/04.md"]);
  });

  it("leaves generated paths to the reconciliation round", () => {
    expect(
      changedPathsOverlap(["pnpm-lock.yaml", "packages/runner/src/loop.ts"], ["**"], ["**/pnpm-lock.yaml"]),
    ).toEqual(["packages/runner/src/loop.ts"]);
  });
});

describe("queueOrder", () => {
  it("puts a dependency before the ticket that names it, above priority", () => {
    const low = ticket({ key: "AYO-1", admitted_at: "2026-09-10T09:00:00.000Z" });
    const high = ticket({ key: "AYO-2", priority: "high", depends_on: ["AYO-1"], admitted_at: "2026-09-10T08:00:00.000Z" });
    const urgent = ticket({ key: "AYO-3", priority: "urgent", admitted_at: "2026-09-10T10:00:00.000Z" });
    expect(queueOrder([high, urgent, low]).map((t) => t.key)).toEqual(["AYO-3", "AYO-1", "AYO-2"]);
    // A dependency the store does not hold orders nothing; waitsFor reports it.
    const orphan = ticket({ key: "AYO-4", priority: "urgent", depends_on: ["AYO-404"] });
    expect(queueOrder([low, orphan]).map((t) => t.key)).toEqual(["AYO-4", "AYO-1"]);
    // A cycle a person wrote still yields one order, by the tie-break.
    const a = ticket({ key: "AYO-5", depends_on: ["AYO-6"], admitted_at: "2026-09-10T08:00:00.000Z" });
    const b = ticket({ key: "AYO-6", depends_on: ["AYO-5"], admitted_at: "2026-09-10T09:00:00.000Z" });
    expect(queueOrder([b, a]).map((t) => t.key)).toEqual(["AYO-5", "AYO-6"]);
  });

  it("orders by priority, then admission time, then key", () => {
    const late = ticket({ key: "AYO-3", admitted_at: "2026-09-10T12:00:00.000Z" });
    const early = ticket({ key: "AYO-2", admitted_at: "2026-09-10T08:00:00.000Z" });
    const urgent = ticket({ key: "AYO-9", priority: "urgent", admitted_at: "2026-09-10T13:00:00.000Z" });
    const tie = ticket({ key: "AYO-1", admitted_at: "2026-09-10T08:00:00.000Z" });
    expect(queueOrder([late, early, urgent, tie]).map((t) => t.key)).toEqual(["AYO-9", "AYO-1", "AYO-2", "AYO-3"]);
  });
});

describe("waitsFor", () => {
  const noSealed = () => null;

  it("waits on an unmerged dependency, naming its state", () => {
    const dep = ticket({ key: "AYO-1", state: "executing" });
    const me = ticket({ key: "AYO-2", depends_on: ["AYO-1"], admitted_at: "2026-09-10T09:30:00.000Z" });
    const all = [scheduled(dep, ["docs/**"]), scheduled(me, ["apps/**"])];
    expect(waitsFor(all[1]!, all, noSealed)).toEqual([
      { key: "AYO-1", reason: "depends_on", paths: [], state: "executing" },
    ]);
  });

  it("does not wait on a merged dependency", () => {
    const dep = ticket({ key: "AYO-1", state: "merged" });
    const me = ticket({ key: "AYO-2", depends_on: ["AYO-1"] });
    expect(waitsFor(scheduled(me, ["apps/**"]), [scheduled(dep, ["docs/**"]), scheduled(me, ["apps/**"])], noSealed)).toEqual(
      [],
    );
  });

  it("waits on a dependency the store does not hold, with no state to name", () => {
    const me = ticket({ key: "AYO-2", depends_on: ["AYO-404"] });
    expect(waitsFor(scheduled(me, ["apps/**"]), [scheduled(me, ["apps/**"])], noSealed)).toEqual([
      { key: "AYO-404", reason: "depends_on", paths: [], state: null },
    ]);
  });

  it("waits on a ticket ahead in the order whose scope overlaps", () => {
    const first = ticket({ key: "AYO-1", admitted_at: "2026-09-10T08:00:00.000Z" });
    const second = ticket({ key: "AYO-2", admitted_at: "2026-09-10T09:00:00.000Z" });
    const all = [scheduled(first, ["packages/runner/**"]), scheduled(second, ["packages/**"])];
    expect(waitsFor(all[1]!, all, noSealed)).toEqual([
      { key: "AYO-1", reason: "scope_overlap", paths: ["packages/runner/**"], state: "ready" },
    ]);
    // The first is ahead, so it waits on nothing: overlap becomes an ordering,
    // never a deadlock.
    expect(waitsFor(all[0]!, all, noSealed)).toEqual([]);
  });

  it("only a holding state ahead counts, and a settled one never does", () => {
    const first = ticket({ key: "AYO-1", state: "changes_requested", admitted_at: "2026-09-10T08:00:00.000Z" });
    const second = ticket({ key: "AYO-2", admitted_at: "2026-09-10T09:00:00.000Z" });
    const all = [scheduled(first, ["packages/**"]), scheduled(second, ["packages/**"])];
    expect(waitsFor(all[1]!, all, noSealed)).toEqual([]);
    for (const state of ["merged", "cancelled", "failed", "closed", "changes_requested", "plan_review"] as const) {
      expect(QUEUE_HOLDING_STATES).not.toContain(state);
    }
    for (const state of ["ready", "blocked", "provisioning", "executing", "verifying", "independent_review", "pr_open"] as const) {
      expect(QUEUE_HOLDING_STATES).toContain(state);
    }
  });

  it("judges a sealed ticket by the paths it actually changed, not its globs", () => {
    const sealed = ticket({ key: "AYO-1", state: "pr_open", admitted_at: "2026-09-10T08:00:00.000Z" });
    const me = ticket({ key: "AYO-2", admitted_at: "2026-09-10T09:00:00.000Z" });
    const all = [scheduled(sealed, ["packages/**"]), scheduled(me, ["packages/runner/**"])];
    // The globs overlap; the diff does not.
    expect(waitsFor(all[1]!, all, () => ["packages/review/src/prompt.ts"])).toEqual([]);
    // The diff does.
    expect(waitsFor(all[1]!, all, () => ["packages/runner/src/loop.ts"])).toEqual([
      { key: "AYO-1", reason: "scope_overlap", paths: ["packages/runner/src/loop.ts"], state: "pr_open" },
    ]);
  });

  it("exempts generated paths on either side from the sealed comparison", () => {
    const sealed = ticket({ key: "AYO-1", state: "pr_open", admitted_at: "2026-09-10T08:00:00.000Z" });
    const me = ticket({ key: "AYO-2", admitted_at: "2026-09-10T09:00:00.000Z" });
    const all = [
      scheduled(sealed, ["packages/**"], ["**/pnpm-lock.yaml"]),
      scheduled(me, ["**"], ["**/*.snap"]),
    ];
    expect(waitsFor(all[1]!, all, () => ["pnpm-lock.yaml", "packages/x/test/a.snap"])).toEqual([]);
  });

  it("cannot deadlock a dependency on a ticket behind it: the dependency goes first", () => {
    const low = ticket({ key: "AYO-1", admitted_at: "2026-09-10T09:00:00.000Z" });
    const high = ticket({ key: "AYO-2", priority: "high", depends_on: ["AYO-1"], admitted_at: "2026-09-10T08:00:00.000Z" });
    const all = [scheduled(high, ["packages/**"]), scheduled(low, ["packages/runner/**"])];
    expect(waitsFor(all[1]!, all, noSealed)).toEqual([]);
    expect(waitsFor(all[0]!, all, noSealed)).toEqual([{ key: "AYO-1", reason: "depends_on", paths: [], state: "ready" }]);
  });

  it("names every wait, dependency first, so the reason line is complete", () => {
    const dep = ticket({ key: "AYO-1", state: "executing", admitted_at: "2026-09-10T08:00:00.000Z" });
    const ahead = ticket({ key: "AYO-2", admitted_at: "2026-09-10T08:30:00.000Z" });
    const me = ticket({ key: "AYO-3", depends_on: ["AYO-1"], admitted_at: "2026-09-10T09:00:00.000Z" });
    const all = [scheduled(dep, ["docs/**"]), scheduled(ahead, ["apps/**"]), scheduled(me, ["apps/cli/**"])];
    expect(waitsFor(all[2]!, all, noSealed)).toEqual([
      { key: "AYO-1", reason: "depends_on", paths: [], state: "executing" },
      { key: "AYO-2", reason: "scope_overlap", paths: ["apps/**"], state: "ready" },
    ]);
  });

  it("a ticket with no contract on record waits on nothing for scope, only for dependencies", () => {
    const ahead = ticket({ key: "AYO-1", admitted_at: "2026-09-10T08:00:00.000Z" });
    const me = ticket({ key: "AYO-2", admitted_at: "2026-09-10T09:00:00.000Z" });
    const all: Scheduled[] = [scheduled(ahead, ["**"]), { ticket: me, scope: null }];
    expect(waitsFor(all[1]!, all, noSealed)).toEqual([]);
  });
});
