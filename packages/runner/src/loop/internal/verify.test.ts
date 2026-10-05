import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import type { ClosureRow, ClosureVerification } from "@perbo/review";
import { SecretIndex } from "@perbo/contracts";
import { BundleStore } from "../../bundle.js";
import type { SealResult } from "../../seal.js";
import { TicketRunConfigSchema } from "./config.js";
import { Ledger } from "./ledger.js";
import { refuseWidening, roundChangedPaths, routeVerification, verifyRound } from "./verify.js";
import { finding, makeReview } from "../../test-support/records.js";
import { runnerRepository } from "../../test-support/repository.js";
import { attempt, contract, roundState } from "./test-support/fakes.js";

const verification = (overrides: Partial<ClosureVerification> = {}): ClosureVerification => ({
  all_closed: true,
  open_keys: [],
  per_finding: [],
  deterministic_failure: null,
  deterministic_failure_kind: null,
  prompt_version: "closure_v1",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  cost_micros: 1000,
  cost_basis: "transport_reported",
  ...overrides,
});

const closed = (key: string): ClosureRow => ({
  finding_key: key,
  status: "closed",
  pointer: "test/feature.test.ts",
  idiomatic: "cannot_tell",
  practice: "",
});
const openRow = (key: string): ClosureRow => ({
  finding_key: key,
  status: "not_closed",
  pointer: "",
  idiomatic: "cannot_tell",
  practice: "",
});

const route = (overrides: Partial<Parameters<typeof routeVerification>[0]> = {}) =>
  routeVerification({
    verification: verification(),
    toVerify: [],
    openFindings: [],
    declines: 0,
    handed: new Set(),
    remediationRound: 1,
    maxRounds: 2,
    spend: { micros: 0, priced: 0 },
    budget: null,
    configPath: "/repo/.perbo/config.json",
    ...overrides,
  });

describe("a scope round that widened instead of narrowing", () => {
  it("is refused with the paths that arrived and the globs the contract admits", () => {
    const step = refuseWidening({
      widened: ["src/other.ts"],
      scopeGiven: [finding({ rule_id: "scope.outside_allowed" })],
      remediationRound: 1,
      pathsAllowed: ["src/feature/**"],
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "changes_requested" } });
    expect(step?.end.detail).toContain("was given 1 scope finding(s) and widened");
    expect(step?.end.detail).toContain("src/other.ts");
    expect(step?.end.detail).toContain("src/feature/**");
  });

  it("names five paths whole and says how many more (D-133)", () => {
    const step = refuseWidening({
      widened: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
      scopeGiven: [],
      remediationRound: 1,
      pathsAllowed: [],
    });

    expect(step?.end.detail).toContain("a.ts, b.ts, c.ts, d.ts, e.ts and 1 more were not in");
  });

  it("says nothing about a round that narrowed", () => {
    expect(
      refuseWidening({ widened: [], scopeGiven: [], remediationRound: 1, pathsAllowed: [] }),
    ).toBeNull();
  });
});

describe("where a round's closure verification sends the run", () => {
  it("reads a check that was already failing as still failing rather than as a regression", () => {
    const step = route({
      toVerify: [finding({ source: "deterministic", rule_id: "check.unit" })],
      verification: verification({
        deterministic_failure: "the unit check (`pnpm test`) failed on the round's tree; the round changed src/a.ts.",
        deterministic_failure_kind: "check",
      }),
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "changes_requested" } });
    expect(step.next === "stop" && step.end.detail).toBe(
      "the pinned checks still fail after remediation round 1: the unit check (`pnpm test`) failed on the round's tree; the round changed src/a.ts.",
    );
  });

  it("reads any other deterministic failure as the fix having regressed", () => {
    const scope = route({
      toVerify: [finding({ source: "deterministic", rule_id: "check.unit" })],
      verification: verification({
        deterministic_failure: "scope: src/other.ts",
        deterministic_failure_kind: "scope",
      }),
    });
    const checkNobodyRouted = route({
      toVerify: [finding({ source: "semantic", rule_id: "test.missing_for_criterion" })],
      verification: verification({
        deterministic_failure: "the unit check (`pnpm test`) failed on the round's tree; the round changed src/a.ts.",
        deterministic_failure_kind: "check",
      }),
    });

    expect(scope.next === "stop" && scope.end.detail).toBe("the fix regressed: scope: src/other.ts");
    expect(checkNobodyRouted.next === "stop" && checkNobodyRouted.end.detail).toBe(
      "the fix regressed: the unit check (`pnpm test`) failed on the round's tree; the round changed src/a.ts.",
    );
  });

  it("sends a handed finding back to a person when the round stalls, and not when it regressed", () => {
    const handed = finding({ key: "a".repeat(64), routing: "escalates" });
    const handedOpen = (deterministic_failure: string | null, keys: string[] = [handed.key]) =>
      route({
        toVerify: [handed],
        openFindings: [handed],
        handed: new Set(keys),
        verification: verification({
          all_closed: false,
          open_keys: [handed.key],
          per_finding: [openRow(handed.key)],
          deterministic_failure,
          deterministic_failure_kind: deterministic_failure === null ? null : "scope",
        }),
      });

    const regressed = handedOpen("scope: src/other.ts");
    expect(regressed).toMatchObject({ next: "stop", end: { outcome: "changes_requested" } });
    expect(regressed.next === "stop" && regressed.end.detail).toBe("the fix regressed: scope: src/other.ts");
    const stalled = handedOpen(null);
    expect(stalled).toMatchObject({ next: "stop", end: { outcome: "escalated" } });
    expect(stalled.next === "stop" && stalled.end.detail).toContain(
      "; a finding a person handed to the executor is still open, so it is theirs to decide again",
    );
    expect(handedOpen(null, [])).toMatchObject({ next: "stop", end: { outcome: "remediation_stalled" } });
  });

  it("approves a round that closed everything, and asks a person where any was declined", () => {
    const approved = route({ remediationRound: 2 });
    const withDeclines = route({ remediationRound: 2, declines: 1 });

    expect(approved).toMatchObject({ next: "stop", end: { outcome: "approved" } });
    expect(approved.next === "stop" && approved.end.detail).toBe(
      "round 0's routed findings verified closed after 2 remediation round(s)",
    );
    expect(withDeclines).toMatchObject({ next: "stop", end: { outcome: "escalated" } });
    expect(withDeclines.next === "stop" && withDeclines.end.detail).toContain(
      "1 finding(s) declared no-determinable-practice",
    );
  });

  it("stalls a round that closed none of what it was given, naming what is still open", () => {
    const one = finding({ key: "a".repeat(64) });
    const step = route({
      toVerify: [one],
      openFindings: [one],
      verification: verification({
        all_closed: false,
        open_keys: [one.key],
        per_finding: [openRow(one.key)],
      }),
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "remediation_stalled" } });
    expect(step.next === "stop" && step.end.detail).toContain(
      `closed none of the 1 finding(s) it was given`,
    );
    expect(step.next === "stop" && step.end.detail).toContain(`Still open: ${one.key}`);
  });

  it("buys the next round for one that closed something and has rounds and money left", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const step = route({
      toVerify: [shut, left],
      openFindings: [shut, left],
      spend: { micros: 100, priced: 1 },
      budget: 1_000_000,
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), openRow(left.key)],
      }),
    });

    expect(step).toMatchObject({
      next: "advance",
      kind: "remediate",
      remediation: true,
      carry: { openFindings: [left] },
    });
  });

  it("checks the cap before the budget, and each says where to raise itself", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const stillClosing = {
      toVerify: [shut, left],
      openFindings: [shut, left],
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), openRow(left.key)],
      }),
    };
    const atBoth = route({
      ...stillClosing,
      remediationRound: 2,
      spend: { micros: 3_000_000, priced: 2 },
      budget: 500_000,
    });
    const atTheBudget = route({
      ...stillClosing,
      remediationRound: 1,
      spend: { micros: 3_000_000, priced: 2 },
      budget: 500_000,
    });

    expect(atBoth).toMatchObject({ next: "stop", end: { outcome: "remediation_exhausted" } });
    expect(atBoth.next === "stop" && atBoth.end.detail).toContain("2 is the cap");
    expect(atTheBudget).toMatchObject({ next: "stop", end: { outcome: "remediation_exhausted" } });
    expect(atTheBudget.next === "stop" && atTheBudget.end.detail).toContain(
      "the ticket has spent $3.00 of the $0.50 in limits.limits.ticket_cost_micros",
    );
  });

  it("leaves an unpriced run to the cap alone", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const step = route({
      toVerify: [shut, left],
      openFindings: [shut, left],
      spend: { micros: 9_000_000, priced: 0 },
      budget: 500_000,
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), openRow(left.key)],
      }),
    });

    expect(step).toMatchObject({ next: "advance", kind: "remediate" });
  });

  it("adds the declined count to every stop that names what is still open", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const step = route({
      toVerify: [shut, left],
      openFindings: [shut, left],
      declines: 2,
      remediationRound: 2,
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), openRow(left.key)],
      }),
    });

    expect(step.next === "stop" && step.end.detail).toContain("(and 2 declined for a person)");
  });
});

describe("the bundle a closure verification leaves", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("says which findings are still open, exactly as the verification counted them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perbo-verify-"));
    scratch.push(dir);
    const plan = contract();
    const bundles = new BundleStore({ root: join(dir, "bundles"), retainContext: true });
    const ledger = new Ledger({
      path: join(dir, `${plan.ticket_id}.attempts.json`),
      prior: null,
      ticketId: plan.ticket_id,
    });
    const open = finding({ key: "a".repeat(64) });
    const closedOne = finding({ key: "b".repeat(64) });
    const recorded = attempt({ attempt_id: "att_0000000000000001" });
    const sealed: SealResult = {
      changeset: { changeset_id: "cs_0000000000000001" } as never,
      head_commit: "ab12cd3",
      diff: "diff --git a/src/feature.ts b/src/feature.ts",
      retained_diff: "diff --git a/src/feature.ts b/src/feature.ts",
      changed_paths: ["src/feature.ts"],
      excluded_paths: [],
      excluded_check_artifacts: [],
      prohibited: [],
      outside_allowed_paths: [],
    };

    const step = await verifyRound({
      config: TicketRunConfigSchema.parse({
        ticket_key: "AYO-1",
        repository_root: "/repo",
        worktree_root: "/wt",
        bundle_root: join(dir, "bundles"),
        quarantine_root: "/quarantine",
        state_root: "/state",
      }),
      contract: plan,
      state: roundState({
        kind: "remediate",
        round: 1,
        remediationRound: 1,
        openFindings: [open, closedOne],
        finalReview: makeReview(),
      }),
      ledger,
      bundles,
      attemptId: "att_0000000000000001",
      sealed,
      gating: [],
      declines: [],
      toClose: [open, closedOne],
      widened: [],
      scopeGiven: [],
      pathsAllowed: ["src/**"],
      record: {
        round: 1,
        kind: "remediate",
        attempt: recorded,
        superseded_attempts: [],
        review: null,
        node_reviews: [],
        verification: null,
        checks: [],
        remediable_findings: 0,
        directly_verified: 0,
        declines: [],
      },
      maxRounds: 2,
      budget: null,
      configPath: "/repo/.perbo/config.json",
      secrets: new SecretIndex(),
      verify: async () =>
        verification({
          all_closed: false,
          open_keys: [open.key],
          per_finding: [closed(closedOne.key), openRow(open.key)],
        }),
      clock: () => new Date("2026-08-27T00:00:00.000Z"),
      progress: () => undefined,
    });

    const written = bundles
      .forTicket(plan.ticket_id)
      .filter((bundle) => bundle.subject_id === "cv_att_0000000000000001");
    expect(written).toHaveLength(1);
    expect(written[0]!.inputs["findings_open"]).toBe(open.key);
    expect(written[0]!.inputs["findings_closed"]).toBe(closedOne.key);
    expect(written[0]!.inputs["head_commit"]).toBe("ab12cd3");
    expect(step.next).toBe("advance");
  });
});

describe("the paths a round itself changed", () => {
  const scratchRepo = scratchDirectories("perbo-round-paths-");

  /** The ticket's bundles as `roundChangedPaths` reads them: the review's, then each verification's. */
  const bundlesOf = (...bundles: Array<{ subject_id: string; at: string; inputs: Record<string, string> }>) =>
    ({
      forTicket: () =>
        bundles.map((bundle) => ({
          kind: "review",
          subject_id: bundle.subject_id,
          created_at: bundle.at,
          inputs: { findings_given: "", findings_open: "", ...bundle.inputs },
        })),
    }) as never;

  /** A branch off main: the judged commit adds two files, and the round changes one of them. */
  const branch = () => {
    const repo = runnerRepository(scratchRepo);
    const base = repo.head;
    repo.git("checkout", "-q", "-b", "ticket");
    const judged = repo.commit({ "src/a.ts": "a\n", "src/b.ts": "b\n" }, "judged");
    return { repo, base, judged };
  };

  it("reads the round's sealed commit against the last commit a verification judged, passing over a refusal", async () => {
    const { repo, base, judged } = branch();
    const verified = repo.commit({ "src/a.ts": "a2\n" }, "round 1");
    const refused = repo.commit({ "src/other.ts": "x\n" }, "refused round");
    repo.git("reset", "-q", "--hard", verified);
    const head = repo.commit({ "src/b.ts": "b2\n" }, "round 3");
    const bundles = bundlesOf(
      { subject_id: "rev_0000000000000001", at: "2026-10-05T00:00:00.000Z", inputs: { base_commit: base, head_commit: judged } },
      { subject_id: "cv_att_1", at: "2026-10-05T00:01:00.000Z", inputs: { base_commit: base, head_commit: verified } },
      { subject_id: "cv_att_2", at: "2026-10-05T00:02:00.000Z", inputs: { base_commit: base, refused_head_commit: refused } },
    );

    const paths = await roundChangedPaths({
      bundles,
      ticket_id: "tkt_1",
      worktree: repo.dir,
      base_commit: base,
      sealed: { head_commit: head, changed_paths: ["src/a.ts", "src/b.ts"] },
    });

    expect(paths).toEqual(["src/b.ts"]);
  });

  it("is empty where the round sealed the commit last judged, and null where the record names none", async () => {
    const { repo, base, judged } = branch();
    const review = { subject_id: "rev_0000000000000001", at: "2026-10-05T00:00:00.000Z", inputs: { base_commit: base, head_commit: judged } };
    const read = (bundles: never) =>
      roundChangedPaths({
        bundles,
        ticket_id: "tkt_1",
        worktree: repo.dir,
        base_commit: base,
        sealed: { head_commit: judged, changed_paths: ["src/a.ts", "src/b.ts"] },
      });

    expect(await read(bundlesOf(review))).toEqual([]);
    expect(await read(bundlesOf())).toBeNull();
  });

  it("leaves out a path only the base brought, where the round merged the base up", async () => {
    const { repo, base, judged } = branch();
    repo.git("checkout", "-q", "main");
    const movedBase = repo.commit({ "lib/base-only.ts": "base\n" }, "base moves");
    repo.git("checkout", "-q", "ticket");
    repo.git("merge", "-q", "--no-edit", "main");
    const head = repo.commit({ "src/b.ts": "b2\n" }, "round 1");
    const bundles = bundlesOf({
      subject_id: "rev_0000000000000001",
      at: "2026-10-05T00:00:00.000Z",
      inputs: { base_commit: base, head_commit: judged },
    });
    const read = (base_commit: string) =>
      roundChangedPaths({
        bundles,
        ticket_id: "tkt_1",
        worktree: repo.dir,
        base_commit,
        sealed: { head_commit: head, changed_paths: ["src/a.ts", "src/b.ts"] },
      });

    expect(await read(movedBase)).toEqual(["src/b.ts"]);
    // Against the base the review judged on, nothing moved, and git's own list stands.
    expect(await read(base)).toEqual(["lib/base-only.ts", "src/b.ts"]);

    // A round that puts one of the judged change's files back as the base has
    // it leaves that file out of its own change set, and the round still
    // changed it: the judged change held it.
    repo.git("rm", "-q", "src/a.ts");
    repo.git("commit", "-q", "-m", "round 2");
    const restored = repo.git("rev-parse", "HEAD").trim();
    expect(
      await roundChangedPaths({
        bundles,
        ticket_id: "tkt_1",
        worktree: repo.dir,
        base_commit: movedBase,
        sealed: { head_commit: restored, changed_paths: ["src/b.ts"] },
      }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
