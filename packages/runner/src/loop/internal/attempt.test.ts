import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LimitsTableSchema,
  MaterializationManifestSchema,
  SecretIndex,
  type MaterializationManifest,
  type TerminationReason,
} from "@perbo/contracts";
import type { MaterializedWorkspace } from "@perbo/workspace";
import type { AgentResult } from "../../adapter.js";
import { BundleStore } from "../../bundle.js";
import { AttemptCeilings } from "../../ceilings.js";
import { buildPermissionProfile } from "../../profile.js";
import type { SealResult } from "../../seal.js";
import { classifyTermination, providerPark, recordAttempt, withCeilingGuidance } from "./attempt.js";
import { TicketRunConfigSchema } from "./config.js";
import { Ledger } from "./ledger.js";
import { finding } from "../../test-support/records.js";
import { agentResult, contract, roundState } from "./test-support/fakes.js";

const manifest = (): MaterializationManifest =>
  MaterializationManifestSchema.parse({
    manifest_version: 1,
    repository_id: "repo_fixture",
    source_checkout: "/nowhere/repo",
    entries: [],
    install: {
      kind: "none",
      package_manager: "none",
      offline_preferred: true,
      lifecycle_scripts: { policy: "disabled", exception: null },
      command: ["true"],
      pinned: true,
    },
    verify: { command: ["git", "status", "--porcelain"], timeout_ms: 1000 },
    isolation: {
      mode: "serialized",
      port_range_size: 0,
      port_range_start: 41000,
      port_range_end: 41000,
      database_schema_prefix: null,
    },
  });

const config = (limits: Record<string, number>) =>
  TicketRunConfigSchema.parse({
    ticket_key: "SCP094",
    repository_root: "/repo",
    base_ref: "main",
    worktree_root: "/wt",
    bundle_root: "/bundles",
    quarantine_root: "/quarantine",
    state_root: "/state",
    agent_binary: "true",
    model: "double",
    limits: LimitsTableSchema.parse({ organisation: "test", limits }),
  });

describe("what a partner is told when a ceiling stops an attempt", () => {
  it("names the limits key, the file that raises it and where it stands", () => {
    const guided = withCeilingGuidance(
      { reason: "iteration_ceiling_exceeded", detail: "the executor ran out of iterations" },
      config({ attempt_iterations: 40 }),
    );

    expect(guided.reason).toBe("iteration_ceiling_exceeded");
    expect(guided.detail).toBe(
      "the executor ran out of iterations — raise limits.limits.attempt_iterations in " +
        `${join("/repo", ".perbo", "config.json")} (currently 40)`,
    );
  });

  it("leaves the number out where nothing has set a limit for that resource", () => {
    const guided = withCeilingGuidance(
      { reason: "command_ceiling_exceeded", detail: "the executor ran out of commands" },
      config({}),
    );

    expect(guided.detail).toBe(
      "the executor ran out of commands — raise limits.limits.attempt_commands in " +
        `${join("/repo", ".perbo", "config.json")}`,
    );
  });

  it("says nothing extra about a termination no ceiling caused", () => {
    const termination = { reason: "completed" as const, detail: "the executor finished" };
    expect(withCeilingGuidance(termination, config({}))).toEqual(termination);
  });
});

describe("what an attempt that finished is recorded as", () => {
  const seal = (overrides: Partial<SealResult> = {}): SealResult => ({
    changeset: null,
    head_commit: null,
    diff: "",
    retained_diff: "",
    changed_paths: [],
    excluded_paths: [],
    excluded_check_artifacts: [],
    prohibited: [],
    outside_allowed_paths: [],
    ...overrides,
  });
  const agent = (reason: TerminationReason = "completed", detail = ""): AgentResult =>
    ({ termination: { reason, detail }, commands: [] }) as unknown as AgentResult;

  it("takes a prohibited action over everything the seal says after it", () => {
    expect(
      classifyTermination({
        config: config({}),
        agentResult: agent(),
        sealed: seal({
          prohibited: [{ action: "self_merge", detail: "gh pr merge" }],
          outside_allowed_paths: ["docs/README.md"],
        }),
        pathsAllowed: ["src/**"],
        inherited: [],
        carriedForward: false,
      }),
    ).toEqual({ reason: "prohibited_action", detail: "self_merge: gh pr merge" });
  });

  it("calls a write the guard should have refused a defect of the runner's", () => {
    const termination = classifyTermination({
      config: config({}),
      agentResult: agent(),
      sealed: seal({ outside_allowed_paths: ["docs/README.md"], changeset: null }),
      pathsAllowed: ["src/**"],
      inherited: [],
      carriedForward: false,
    });

    expect(termination.reason).toBe("runner_defect");
    expect(termination.detail).toContain("docs/README.md");
  });

  it("names the refusals behind a branch that adds nothing, and says so plainly without them", () => {
    const denied = {
      decision: "denied",
      denial_rule: "command_deny_list",
      denial_target: "gh",
      detail: "gh pr merge",
    };
    expect(
      classifyTermination({
        config: config({}),
        agentResult: { termination: { reason: "completed", detail: "" }, commands: [denied] } as unknown as AgentResult,
        sealed: seal(),
        pathsAllowed: ["src/**"],
        inherited: [],
        carriedForward: false,
      }),
    ).toEqual({
      reason: "no_changes_after_denials",
      detail:
        "the branch adds no change to its base, and 1 command(s) the executor asked for were " +
        "refused: command_deny_list on gh",
    });
    expect(
      classifyTermination({
        config: config({}),
        agentResult: agent(),
        sealed: seal(),
        pathsAllowed: ["src/**"],
        inherited: [],
        carriedForward: false,
      }),
    ).toEqual({ reason: "no_changes", detail: "the branch adds no change to its base" });
  });

  it("names each refused command whole, and how many more past five (D-NEW-nothing-shown-is-cut)", () => {
    const long =
      "node -e \"require('fs').writeFileSync('/etc/hosts', 'a line the guard read in full before refusing it')\"";
    const commands = [0, 1, 2, 3, 4, 5, 6].map((n) => ({
      decision: "denied",
      denial_rule: "command_allow_list",
      denial_target: null,
      detail: `${long} # ${n}`,
    }));
    const termination = classifyTermination({
      config: config({}),
      agentResult: { termination: { reason: "completed", detail: "" }, commands } as unknown as AgentResult,
      sealed: seal(),
      pathsAllowed: ["src/**"],
      inherited: [],
      carriedForward: false,
    });
    expect(long.length).toBeGreaterThan(80);
    expect(termination.detail).toContain(`command_allow_list on ${long} # 4`);
    expect(termination.detail).not.toContain(`${long} # 5`);
    expect(termination.detail.endsWith("; and 2 more")).toBe(true);
  });

  it("names the first five paths outside the contract whole, then how many more", () => {
    const paths = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `docs/${n}.md`);
    const termination = classifyTermination({
      config: config({}),
      agentResult: agent(),
      sealed: seal({ outside_allowed_paths: paths, changeset: null }),
      pathsAllowed: ["src/**"],
      inherited: [],
      carriedForward: false,
    });
    expect(termination.detail).toContain("docs/1.md, docs/2.md, docs/3.md, docs/4.md, docs/5.md and 3 more — ");
  });

  it("says a change set the executor added nothing to is what was checked and reviewed", () => {
    expect(
      classifyTermination({
        config: config({}),
        agentResult: agent(),
        sealed: seal({ changeset: { changeset_id: "cs_1" } as SealResult["changeset"], head_commit: "abc" }),
        pathsAllowed: ["src/**"],
        inherited: ["abc"],
        carriedForward: true,
      }),
    ).toEqual({
      reason: "completed",
      detail:
        "the executor added nothing to the 1 commit(s) already on the branch; that change set " +
        "is what was checked and reviewed",
    });
  });

  it("leaves the executor's own reason alone where it did not finish", () => {
    expect(
      classifyTermination({
        config: config({}),
        agentResult: agent("transport_unavailable", "HTTP 529"),
        sealed: seal({ prohibited: [{ action: "self_merge", detail: "gh pr merge" }] }),
        pathsAllowed: ["src/**"],
        inherited: [],
        carriedForward: false,
      }),
    ).toEqual({ reason: "transport_unavailable", detail: "HTTP 529" });
  });
});

describe("the wait a provider's own reset buys", () => {
  const now = new Date("2026-08-27T04:00:00.000Z");
  const clock = () => now;
  const said = "429 the session limit is reached; resets 5:00am (UTC)";

  it("is read only from a transport outage the round has not already retried", () => {
    expect(
      providerPark({
        termination: { reason: "transport_unavailable", detail: said },
        transportRetry: 1,
        waitBoundMs: 4 * 60 * 60 * 1000,
        clock,
      }),
    ).toEqual({ reset: null, parkMs: 0, park: null });
    expect(
      providerPark({
        termination: { reason: "stalled", detail: said },
        transportRetry: 0,
        waitBoundMs: 4 * 60 * 60 * 1000,
        clock,
      }),
    ).toEqual({ reset: null, parkMs: 0, park: null });
  });

  it("is taken where the reset is inside the bound", () => {
    const parked = providerPark({
      termination: { reason: "transport_unavailable", detail: said },
      transportRetry: 0,
      waitBoundMs: 4 * 60 * 60 * 1000,
      clock,
    });

    expect(parked.reset).not.toBeNull();
    expect(parked.parkMs).toBe(60 * 60 * 1000);
    expect(parked.park).toMatchObject({ reason: "provider_reset", waited_ms: 60 * 60 * 1000 });
  });

  it("is refused beyond the bound, and the reset it refused to wait for is kept", () => {
    const parked = providerPark({
      termination: { reason: "transport_unavailable", detail: said },
      transportRetry: 0,
      waitBoundMs: 60 * 1000,
      clock,
    });

    expect(parked.reset).not.toBeNull();
    expect(parked.parkMs).toBe(60 * 60 * 1000);
    expect(parked.park).toBeNull();
  });
});

describe("the record one finished attempt leaves", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function record(input: { carriedForward: boolean; headCommit: string | null }) {
    const dir = mkdtempSync(join(tmpdir(), "perbo-record-"));
    scratch.push(dir);
    const plan = contract();
    const bundles = new BundleStore({ root: join(dir, "bundles"), retainContext: true });
    const ledger = new Ledger({
      path: join(dir, `${plan.ticket_id}.attempts.json`),
      prior: null,
      ticketId: plan.ticket_id,
    });
    const toClose = [finding({ key: "a".repeat(64) }), finding({ key: "b".repeat(64) })];
    const recorded = recordAttempt({
      config: config({}),
      contract: plan,
      state: roundState({ kind: "remediate", round: 1, remediationRound: 1, openFindings: toClose }),
      brief: {
        inherited: [],
        prior_commits: [],
        toClose,
        resumedHere: null,
        resumeOutcome: null,
        pathsAllowed: ["src/**"],
        pathsProhibited: [],
        prompt: "close the findings",
        executorSkills: [],
        briefRecords: {
          outcome: plan.outcome,
          acceptance_criteria: [],
          nodes: [],
          paths_allowed: ["src/**"],
          paths_prohibited: [],
          no_gos: [],
          principles: null,
          checks: [],
          open_findings: [],
        },
      },
      bundles,
      ledger,
      attemptId: "att_0000000000000001",
      rootAttemptId: "att_0000000000000001",
      previous: undefined,
      continuesPreviousRun: null,
      at: new Date("2026-08-27T00:00:00.000Z"),
      agentResult: agentResult(),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" }), Date.now),
      environment: { env: {}, passed: [], dropped: [] },
      profile: buildPermissionProfile({ worktree: "/nowhere/worktree" }),
      materialized: {
        manifest_hash: "sha256:fixture",
        materialized_paths: [],
        ports: { start: 41000, end: 41000 },
        database_schema: null,
      } as unknown as MaterializedWorkspace,
      manifest: manifest(),
      secrets: new SecretIndex(),
      sealed: {
        changeset: { changeset_id: "cs_0000000000000001" } as never,
        head_commit: input.headCommit,
        diff: "",
        retained_diff: "",
        changed_paths: ["src/feature.ts"],
        excluded_paths: [],
        excluded_check_artifacts: [],
        prohibited: [],
        outside_allowed_paths: [],
      },
      carriedForward: input.carriedForward,
      mergedBase: null,
      specCommit: null,
      baseVerification: null,
      provisioningVerify: null,
      swept: [],
      checks: [],
      waitBoundMs: 0,
      clock: () => new Date("2026-08-27T00:01:00.000Z"),
      progress: () => undefined,
    });
    return { recorded, bundles, ledger, plan, toClose };
  }

  it("is one execution bundle naming what the round was given", () => {
    const { bundles, plan, toClose } = record({ carriedForward: false, headCommit: "ab12cd3" });

    const written = bundles.forTicket(plan.ticket_id).filter((bundle) => bundle.kind === "execution");
    expect(written).toHaveLength(1);
    expect(written[0]!.inputs["findings_given"]).toBe(toClose.map((f) => f.key).join(","));
    expect(written[0]!.inputs["findings_given_count"]).toBe(2);
  });

  it("names the attempt that sealed the head only where the attempt sealed it", () => {
    expect(record({ carriedForward: false, headCommit: "ab12cd3" }).ledger.sealedBy("ab12cd3")).toBe(
      "att_0000000000000001",
    );
    expect(record({ carriedForward: true, headCommit: "ab12cd3" }).ledger.sealedBy("ab12cd3")).toBeNull();
  });
});
