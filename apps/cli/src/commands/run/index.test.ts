import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema } from "@perbo/contracts";
import { DEFAULT_DELIVERED_CHECKS_BOUND_MS, TicketRunConfigSchema } from "@perbo/runner";
import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../../usage-error.js";
import { readPullRequestChecks } from "../../pull-request.js";
import { parseAdmitArgs, runAdmitCommand } from "../admit.js";
import {
  BASE_SOURCE_LABEL,
  deliveryChecksBoundMs,
  deliveryChecksMessage,
  deliveryChecksReason,
  exitCodeForRun,
  mergeRunConfig,
  parseExecuteArgs,
  renderCeilingsLine,
  renderRun,
  runDoctorCommand,
  runExecuteCommand,
  usageOf,
} from "./index.js";
import { readTicket, storeDir } from "../../store/tickets.js";
import { makeAttempt, makeTicket } from "../../test-support/attempt-fixture.js";
import { REPO_ROOT } from "../../test-support/paths.js";

const streams = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      isTTY: false,
    },
  };
};

describe("perbo run / doctor argument parsing", () => {
  it("rejects an unknown flag rather than reviewing something else", () => {
    expect(() => parseExecuteArgs(["--contarct", "c.json"])).toThrow(UsageError);
    expect(() => parseExecuteArgs(["positional"])).toThrow(UsageError);
    expect(() => parseExecuteArgs(["--publish=yes"])).toThrow(/does not take a value/);
  });

  it("takes publish as an explicit flag, never as a default", () => {
    expect(parseExecuteArgs(["--contract", "c.json", "--config", "r.json"]).publish).toBe(false);
    expect(parseExecuteArgs(["--publish"]).publish).toBe(true);
  });
});

describe("exit codes", () => {
  it("keeps the review contract's meaning one layer out", () => {
    expect(exitCodeForRun("approved")).toBe(0);
    expect(exitCodeForRun("changes_requested")).toBe(2);
    expect(exitCodeForRun("escalated")).toBe(2);
    expect(exitCodeForRun("remediation_exhausted")).toBe(2);
    expect(exitCodeForRun("no_changes")).toBe(3);
    expect(exitCodeForRun("terminated")).toBe(3);
    // A reviewer outage is a run that did not complete, not a closed gate.
    expect(exitCodeForRun("review_failed")).toBe(3);
  });

  it("gives no non-zero code the meaning of success", () => {
    for (const outcome of [
      "changes_requested",
      "escalated",
      "remediation_exhausted",
      "no_changes",
      "terminated",
      "review_failed",
    ] as const) {
      expect(exitCodeForRun(outcome)).not.toBe(0);
    }
  });
});

// `perbo doctor` refusing a repository it cannot materialize lives in
// doctor-refusal.test.ts, where the preflight and the diagnostic are injected
// and the test observes that no process is started to reach the refusal.

describe("the run rendering", () => {
  it("shows each round, where its findings went, and what it cost", () => {
    const rendered = renderRun({
      ticket_id: "ticket_1",
      workspace: { branch: "ayo/scp094/x" } as never,
      rounds: [
        {
          round: 0,
          attempt: {
            termination: { reason: "completed" },
            usage: { cost_micros: 40_000, cost_basis: "provider_list_estimate" },
          } as never,
          review: {
            decision: "remediable",
            coverage: [{}, {}],
            cost_micros: 210_000,
            model: { cost_basis: "provider_list_estimate" },
          } as never,
          kind: "execute",
          superseded_attempts: [],
          node_reviews: [],
          verification: null,
          checks: [],
          remediable_findings: 2,
          directly_verified: 0,
          declines: [],
        },
        {
          round: 1,
          attempt: {
            termination: { reason: "completed" },
            usage: { cost_micros: 30_000, cost_basis: "transport_reported" },
          } as never,
          review: {
            decision: "approve",
            coverage: [{}, {}],
            cost_micros: 190_000,
            model: { cost_basis: "provider_list_estimate" },
          } as never,
          kind: "remediate",
          superseded_attempts: [],
          node_reviews: [],
          verification: null,
          checks: [],
          remediable_findings: 0,
          directly_verified: 2,
          declines: [],
        },
      ],
      final_review: null,
      node_reviews: [],
      pull_request: { url: "https://example.invalid/pull/1", number: 1 },
      merge: null,
      delivery_checks: null,
      github_credential: "gh_login",
      outcome: "approved",
      detail: "the gate is open",
      incomplete_review: null,
      merged_base: null,
    });
    expect(rendered).toContain("ayo/scp094/x");
    expect(rendered).toContain("remediation 1");
    expect(rendered).toContain("2 to the executor");
    expect(rendered).toContain("2/2 directly verified");
    expect(rendered).toContain("$0.2100 estimated");
    expect(rendered).toContain("OUTCOME   approved");
    expect(rendered).toContain("PR        https://example.invalid/pull/1");
    // Every component the run was charged for: two attempts and two reviews.
    expect(rendered).toContain(
      "COST      $0.4700 \u2014 4 of 4 priced, 1 reported, 3 estimated",
    );
  });

  it("does not render an unavailable review charge as zero dollars", () => {
    const rendered = renderRun({
      ticket_id: "ticket_1",
      workspace: { branch: "ayo/scp094/x" } as never,
      rounds: [
        {
          round: 0,
          attempt: {
            termination: { reason: "completed" },
            usage: { cost_micros: 0, cost_basis: "not_incurred" },
          } as never,
          review: {
            decision: "approve",
            coverage: [],
            cost_micros: 0,
            model: { cost_basis: "unavailable" },
          } as never,
          kind: "execute",
          superseded_attempts: [],
          node_reviews: [],
          verification: null,
          checks: [],
          remediable_findings: 0,
          directly_verified: 0,
          declines: [],
        },
      ],
      final_review: null,
      node_reviews: [],
      pull_request: null,
      merge: null,
      delivery_checks: null,
      github_credential: null,
      outcome: "approved",
      detail: "the gate is open",
      incomplete_review: null,
      merged_base: null,
    });

    expect(rendered).toContain("cost unavailable");
    expect(rendered).not.toContain("$0.0000");
  });
});

/**
 * SCP-279: what the run tells a person when nothing reported on the head.
 *
 * Both endings arrive at `renderRun` as the same empty rollup, and they are not
 * the same news: a repository that runs no check on a pull request has nothing
 * to wait for and something to configure, and a head whose checks had not
 * reported when the run stopped waiting may well be green ten minutes later.
 *
 * The reading the line is written from is the real one — `readPullRequestChecks`
 * against a `gh` on PATH, over a checkout this writes — so what is read here is
 * a repository, not a shape the test asserted about itself.
 */
describe("what the run says when no check reported on the head", () => {
  /** Both readings spawn `gh` twice, so the case declares its own deadline. */
  const SPAWN_DEADLINE_MS = 30_000;

  /**
   * A `gh` that lists this checkout's workflows and answers for its base.
   *
   * `body` is what `workflow list` writes, for the cases that are about the
   * listing itself rather than about the workflows in it; by default it is the
   * workflows above, as JSON.
   */
  function ghListing(
    bin: string,
    workflows: ReadonlyArray<{ name: string; path: string }>,
    body?: string,
  ): void {
    mkdirSync(bin, { recursive: true });
    const listed = join(bin, "workflows.json");
    writeFileSync(
      listed,
      body ?? JSON.stringify(workflows.map((entry) => ({ ...entry, state: "active" }))),
    );
    const script = join(bin, "gh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `if [ "$1" = "workflow" ] && [ "$2" = "list" ]; then cat ${JSON.stringify(listed)}; exit 0; fi`,
        'if [ "$1" = "api" ]; then',
        "  case \"$*\" in",
        // No ruleset, and a base branch with no protection — a 404, which is an
        // answer: this branch requires no status check.
        "    *rules/branches*) printf '[]'; exit 0;;",
        '    *protection*) printf "gh: Not Found (HTTP 404)\\n" >&2; exit 1;;',
        "  esac",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
  }

  /**
   * What this repository runs on a pull request, read the way `run` and
   * `doctor` read it: the shipped reader, over a checkout this writes, with a
   * `gh` on PATH answering.
   */
  async function repositoryChecks(name: string, on: "push" | "pull_request") {
    const dir = mkdtempSync(join(tmpdir(), `perbo-run-checks-${name}-`));
    const path = `.github/workflows/${on === "push" ? "release" : "ci"}.yml`;
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, path), `name: CI\non:\n  ${on}:\n    branches: [main]\njobs: {}\n`);
    const bin = join(dir, ".bin");
    ghListing(bin, [{ name: "CI", path }]);

    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      return await readPullRequestChecks({ worktree: dir, base_ref: "main" });
    } finally {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The same reading over a repository with no workflow at all, where the
   * whole of what `gh workflow list` writes is the case's own `body`.
   */
  async function repositoryWithoutWorkflows(name: string, body: string) {
    const dir = mkdtempSync(join(tmpdir(), `perbo-run-checks-${name}-`));
    const bin = join(dir, ".bin");
    ghListing(bin, [], body);

    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      return await readPullRequestChecks({ worktree: dir, base_ref: "main" });
    } finally {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A finished run that published, whose head reported nothing at all. */
  const publishedWithNothingReported = (waited_ms: number, bounded: boolean) =>
    ({
      ticket_id: "ticket_1",
      workspace: { branch: "ayo/scp290/x" } as never,
      rounds: [],
      final_review: null,
      pull_request: { url: "https://example.invalid/pull/1", number: 1 },
      delivery_checks: { checks: [], state: "unchecked", waited_ms, bounded },
      outcome: "approved",
      detail: "the gate is open",
    }) as never;

  const checksBlock = (rendered: string): string =>
    rendered
      .split("\n")
      .filter((line) => line.startsWith("CHECKS") || line.startsWith("          "))
      .join("\n");

  it(
    "names the repository where it runs nothing, and the wait where the checks were late",
    async () => {
      const runsNothing = await repositoryChecks("nothing", "push");
      const runsChecks = await repositoryChecks("late", "pull_request");

      // The repository that runs nothing is read as running nothing, and a
      // delivery read here is allowed no wait at all; the one that runs a
      // workflow on every pull request keeps the whole bound.
      expect(runsNothing.runs_checks).toBe(false);
      expect(deliveryChecksBoundMs(runsNothing, DEFAULT_DELIVERED_CHECKS_BOUND_MS)).toBe(0);
      expect(runsChecks.runs_checks).toBe(true);
      expect(deliveryChecksBoundMs(runsChecks, DEFAULT_DELIVERED_CHECKS_BOUND_MS)).toBe(
        DEFAULT_DELIVERED_CHECKS_BOUND_MS,
      );

      // The same empty reading, from the two repositories, in the run's own
      // words. The reason is what the record carries and the sentence under it
      // is what the person reads.
      const nothingRead = { checks: [], state: "unchecked" as const, waited_ms: 0, bounded: true };
      expect(deliveryChecksReason(nothingRead, runsNothing)).toBe("none reported");
      expect(deliveryChecksReason(nothingRead, runsChecks)).toBe("not reported in time");
      // A `gh` that would not answer the rollup at all is the third ending, and
      // it is not either of those: the run never waited, so nothing timed out.
      expect(deliveryChecksReason({ checks: [], bounded: false }, runsChecks)).toBe("unreadable");
      expect(deliveryChecksMessage({ ...nothingRead, bounded: false }, runsChecks)).toContain(
        "`gh` would not report the checks",
      );

      const nothing = checksBlock(
        renderRun(publishedWithNothingReported(0, true), { repository_checks: runsNothing }),
      );
      const late = checksBlock(
        renderRun(publishedWithNothingReported(DEFAULT_DELIVERED_CHECKS_BOUND_MS, true), {
          repository_checks: runsChecks,
        }),
      );

      expect(nothing).toContain("unchecked — none reported");
      expect(nothing).toContain("this repository runs no checks on pull requests");
      expect(late).toContain("unchecked — not reported in time");
      expect(late).toContain("had not concluded after 900s");
      expect(late).not.toContain("runs no checks");
      // Neither is a pass, and neither reads as the other.
      expect(nothing).not.toEqual(late);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "reads an empty workflow list as an answer of no workflows",
    async () => {
      // `gh workflow list --all` writes nothing at all on a repository that has
      // no workflow, and that is the answer "none": a run here has nothing to
      // wait for, and is allowed no wait at all.
      const listsNothing = await repositoryWithoutWorkflows("empty-list", "");
      expect(listsNothing.answered).toBe(true);
      expect(listsNothing.workflows_seen).toBe(0);
      expect(listsNothing.runs_checks).toBe(false);
      expect(deliveryChecksBoundMs(listsNothing, DEFAULT_DELIVERED_CHECKS_BOUND_MS)).toBe(0);
      expect(
        deliveryChecksReason(
          { checks: [], bounded: true },
          listsNothing,
        ),
      ).toBe("none reported");

      // Whitespace is the same nothing.
      const blank = await repositoryWithoutWorkflows("blank-list", "\n");
      expect(blank.answered).toBe(true);
      expect(blank.runs_checks).toBe(false);
      expect(deliveryChecksBoundMs(blank, DEFAULT_DELIVERED_CHECKS_BOUND_MS)).toBe(0);

      // Anything else `gh` writes that is not JSON is still no answer, and an
      // unanswered reading keeps the whole bound rather than skipping the wait.
      const garbled = await repositoryWithoutWorkflows("garbled-list", "not json at all");
      expect(garbled.answered).toBe(false);
      expect(garbled.detail).toContain("`gh workflow list` did not answer with JSON");
      expect(deliveryChecksBoundMs(garbled, DEFAULT_DELIVERED_CHECKS_BOUND_MS)).toBe(
        DEFAULT_DELIVERED_CHECKS_BOUND_MS,
      );
    },
    SPAWN_DEADLINE_MS,
  );
});

const doctorArgs = (repo: string, extra: Partial<Parameters<typeof runDoctorCommand>[0]["args"]> = {}) => ({
  ticket: null,
  store: null,
  contract: null,
  config: null,
  repo,
  worktreeRoot: null,
  publish: false,
  json: true,
  quiet: true,
  writeConfig: false,
  probe: false,
  resumeFrom: null,
  outcome: null,
  criteria: [],
  paths: [],
  pr: null,
  relevel: false,
  ...extra,
});

function repository(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `perbo-execute-${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "base"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return dir;
}

/**
 * A PATH with git on it and nothing else, so the coding agent is genuinely
 * absent rather than mocked absent. Restored by the returned function.
 */
function withoutClaudeOnPath(): () => void {
  const bin = mkdtempSync(join(tmpdir(), "perbo-fake-bin-"));
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  symlinkSync(git, join(bin, "git"));
  const previous = process.env.PATH;
  process.env.PATH = bin;
  return () => {
    process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  };
}

/**
 * Every case below runs `doctor` or `run` end to end against a real
 * repository, a cold spawn under the load SCP-191 measures rather than an
 * idle machine's five seconds.
 */
const DOCTOR_RUN_TIMEOUT_MS = 60_000;

describe("preflight, before anything is touched", () => {
  it("doctor reports a missing agent binary with the command that fixes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perbo-preflight-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const restore = withoutClaudeOnPath();
    try {
      const json = streams();
      expect(await runDoctorCommand({ args: doctorArgs(dir), streams: json.streams, cwd: process.cwd() })).toBe(1);
      const result = JSON.parse(json.out.join("")) as {
        preflight: { ok: boolean; findings: Array<{ reason: string; fix: string; severity: string }> };
      };
      expect(result.preflight.ok).toBe(false);
      const missing = result.preflight.findings.find((finding) => finding.reason === "agent_binary_missing");
      expect(missing?.severity).toBe("blocking");
      expect(missing?.fix).toContain("npm install -g @anthropic-ai/claude-code");

      const text = streams();
      text.streams.isTTY = true;
      await runDoctorCommand({ args: doctorArgs(dir, { json: false }), streams: text.streams, cwd: process.cwd() });
      const rendered = text.out.join("");
      expect(rendered).toContain("PREFLIGHT");
      expect(rendered).toContain("✗ claude   not found");
      expect(rendered).toContain("blocking  agent_binary_missing:");
      expect(rendered).toContain("fix: install Claude Code");
      expect(rendered).toContain("machine NOT ready");
    } finally {
      restore();
    }
  }, DOCTOR_RUN_TIMEOUT_MS);

  it("run exits 3 and leaves the ticket exactly where it was", async () => {
    const repo = repository("run-preflight");
    const admit = streams();
    expect(
      runAdmitCommand({
        args: parseAdmitArgs([
          "--repo", repo,
          "--outcome", "Search results are paginated.",
          "--criterion", "A page holds 25 hits. :: a 140-hit query returns 25",
          "--path", "packages/search/**",
          "--approve",
        ]),
        streams: admit.streams,
        cwd: repo,
      }),
    ).toBe(0);
    const before = readTicket(storeDir(repo, null), "PRB-1");
    expect(before.state).toBe("ready");

    const restore = withoutClaudeOnPath();
    try {
      const run = streams();
      const code = await runExecuteCommand({
        args: doctorArgs(repo, { ticket: "PRB-1", json: false }),
        streams: run.streams,
        cwd: repo,
      });
      expect(code).toBe(3);
      expect(run.err.join("")).toContain("agent_binary_missing");
      expect(run.err.join("")).toContain("PRB-1 was not touched");
      expect(run.out.join("")).toBe("");
    } finally {
      restore();
    }
    expect(readTicket(storeDir(repo, null), "PRB-1")).toEqual(before);
  }, DOCTOR_RUN_TIMEOUT_MS);
});

describe("ceilings surfaced", () => {
  it("doctor prints the effective table and names the attempt that hit one", async () => {
    const repo = repository("ceilings");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "config.json"),
      JSON.stringify({
        _comment: "raised after the dogfood run hit 61",
        limits: { organisation: "t", limits: { attempt_iterations: 200 } },
      }),
    );
    writeFileSync(
      join(store, "tickets", "AYO-3.json"),
      JSON.stringify(makeTicket({ key: "AYO-3", ticket_id: "ticket_ceiling0001", repository_root: repo })),
    );
    writeFileSync(
      join(store, "state", "ticket_ceiling0001.attempts.json"),
      JSON.stringify({
        ticket_id: "ticket_ceiling0001",
        attempts: [
          makeAttempt({
            attempt_id: "att_ceiling000001",
            ticket_id: "ticket_ceiling0001",
            created_at: "2026-08-28T11:33:33.000Z",
            termination: {
              reason: "iteration_ceiling_exceeded",
              detail: "attempt_iterations would reach 61, above the limit of 60",
            },
            usage: { iterations: 61, commands: 40, wall_clock_ms: 320_000 },
            changeset_id: null,
            head_commit: null,
          }),
        ],
      }),
    );

    const text = streams();
    text.streams.isTTY = true;
    await runDoctorCommand({ args: doctorArgs(repo, { json: false }), streams: text.streams, cwd: repo });
    const rendered = text.out.join("");
    expect(rendered).toMatch(/attempt_iterations\s+200\s+200\s+config \(no default\)/);
    // D-096: nothing raised it and nothing defaults it, so there is no ceiling
    // to print — and the table says that rather than a number. Four resources
    // read this way now, the wall clock and the token count among them.
    expect(rendered).toMatch(/attempt_commands\s+—\s+no ceiling\s+not set/);
    expect(rendered).toMatch(/attempt_wall_clock_ms\s+—\s+no ceiling\s+not set/);
    expect(rendered).toMatch(/attempt_tokens\s+—\s+no ceiling\s+not set/);
    // The one resource this ticket gives a default, and the two whose default
    // waits on the executor being billed per token.
    expect(rendered).toMatch(/attempt_stall_ms\s+1200000\s+20m\s+default/);
    expect(rendered).toMatch(/attempt_cost_micros\s+5000000\s+\$5\.00\s+per-token default/);
    expect(rendered).toMatch(/ticket_cost_micros\s+60000000\s+\$60\.00\s+per-token default/);
    expect(rendered).toContain(
      "the two cost keys bind only where the executor is billed per token",
    );
    expect(rendered).toContain("ceiling hit  AYO-3 att_ceiling000001: attempt_iterations reached 61 against 60");
    expect(rendered).toContain("raise it with limits.limits.attempt_iterations in");
    expect(rendered).toContain("(now 200)");

    const json = streams();
    await runDoctorCommand({ args: doctorArgs(repo), streams: json.streams, cwd: repo });
    const result = JSON.parse(json.out.join("")) as {
      limits: {
        effective: Record<string, number | null>;
        ceiling_terminations: Array<Record<string, unknown>>;
      };
    };
    expect(result.limits.effective.attempt_iterations).toBe(200);
    expect(result.limits.effective.attempt_commands).toBeNull();
    expect(result.limits.effective.attempt_stall_ms).toBe(1_200_000);
    // The table's own answer, before a credential is known: neither cost key
    // bounds anything on its own (D-096).
    expect(result.limits.effective.attempt_cost_micros).toBeNull();
    expect(result.limits.effective.ticket_cost_micros).toBeNull();
    expect(result.limits.ceiling_terminations).toEqual([
      {
        ticket: "AYO-3",
        ticket_id: "ticket_ceiling0001",
        attempt_id: "att_ceiling000001",
        resource: "attempt_iterations",
        reached: 61,
        limit: 60,
        config_key: "limits.limits.attempt_iterations",
      },
    ]);
  }, DOCTOR_RUN_TIMEOUT_MS);

  it("renders the one-line ceilings a run prints first, naming only what stands", () => {
    const line = renderCeilingsLine(
      LimitsTableSchema.parse({
        organisation: "t",
        limits: { attempt_wall_clock_ms: 2_700_000, attempt_cost_micros: 15_000_000 },
      }),
    );
    expect(line).toBe(
      // D-096: the stall window is the only thing that stops a run nobody asked
      // to stop, and it leads.
      "stall 20m · " +
        // SCP-193: the two that bound the ticket rather than one attempt, which
        // are the ones a person reads when a run continues itself.
        // SCP-194: the cap is six, and it is a cap above the progress rule
        // rather than the rule itself.
        "remediation rounds 6 · provider wait 6h · " +
        // Marked per-token because whether they bind at all depends on the
        // credential the executor turns out to authenticate with, and nothing
        // has read that yet. The $15 is the repository's own.
        "per-token cost $15.00 · per-token ticket budget $60.00 · " +
        // A wall clock only because this repository set one; no token,
        // iteration or command ceiling is named because none is in force.
        "wall clock 45m",
    );
  });

  it("names a counter the repository configured, after the bounds every run has", () => {
    const line = renderCeilingsLine(
      LimitsTableSchema.parse({
        organisation: "t",
        limits: { attempt_iterations: 400, round_iterations: 80, attempt_commands: 400 },
      }),
    );
    expect(line).toBe(
      "stall 20m · remediation rounds 6 · provider wait 6h · " +
        "per-token cost $5.00 · per-token ticket budget $60.00 · " +
        "iterations 400 · round iterations 80 · commands 400",
    );
  });

  it("reads the token ceiling's actual counter when billed usage was deduplicated", () => {
    const attempt = makeAttempt({
      attempt_id: "att_ceilingtokens01",
      ticket_id: "ticket_ceiling0001",
      created_at: "2026-08-28T11:33:33.000Z",
      termination: { reason: "completed", detail: "the agent completed" },
      usage: {
        input_tokens: 160,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 40,
        output_tokens: 10,
        token_ceiling_tokens: 260,
      },
      changeset_id: null,
      head_commit: null,
    });

    expect(usageOf(attempt, "attempt_tokens")).toBe(260);
  });
});

describe("a partner's first hour", () => {
  const codexSelection = {
    agent_binary: "codex",
    agent_provider: "codex-cli",
    model: "gpt-5.6-terra",
    reviewer_provider: "codex-cli",
    reviewer_model: "gpt-6-astra",
  };
  const readyPreflight = () => vi.fn(() => ({
    ok: true,
    findings: [],
    tools: { codex: { present: true, version: "test" } },
    github: null,
  }));

  it("uses explicit Codex choices for readiness and retains the complete proposed configuration", async () => {
    const repo = repository("codex-first-hour");
    try {
      execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "x", scripts: { test: "vitest run", lint: "eslint ." } }),
      );
      writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const overridePath = join(repo, "desktop-selection.json");
      writeFileSync(overridePath, JSON.stringify({ ...codexSelection, _comment: "Desktop selection" }));
      const configPath = join(repo, ".perbo", "config.json");
      const preflight = readyPreflight();
      const proposed = streams();
      const proposedCode = await runDoctorCommand({
        args: doctorArgs(repo, { config: "desktop-selection.json", probe: false }),
        streams: proposed.streams,
        cwd: repo,
        preflight,
      });
      expect(proposedCode).toBe(0);
      expect(preflight).toHaveBeenCalledWith({
        agentBinary: "codex",
        agentProvider: "codex-cli",
        reviewerProvider: "codex-cli",
        needsGh: false,
        installBinary: "pnpm",
        probeGithub: true,
      });
      expect(JSON.parse(proposed.out.join(""))).toMatchObject({
        provider: {
          transport: "codex-cli",
          model: "gpt-6-astra",
          probed: false,
          probe: null,
          dependency: { reason: expect.stringContaining(overridePath) },
        },
        checks: { pinned: ["check_lint", "check_unit"] },
        config: {
          path: configPath,
          present: false,
          written: false,
          override_path: overridePath,
          proposed: {
            ...codexSelection,
            base_ref: "main",
            checks: [{ check_id: "check_lint" }, { check_id: "check_unit" }],
            materialization_manifest: { source_checkout: "." },
            // D-096: the proposal writes the defaults a run actually has, and
            // the cost caps are not among them — a repository that wants one
            // adds the key.
            limits: { limits: { attempt_stall_ms: 1_200_000 } },
          },
        },
      });
      expect(existsSync(configPath)).toBe(false);

      const text = streams();
      text.streams.isTTY = true;
      await runDoctorCommand({
        args: doctorArgs(repo, { config: overridePath, json: false, probe: false }),
        streams: text.streams,
        cwd: repo,
        preflight,
      });
      expect(text.out.join("")).toContain(`--config ${overridePath} --write-config`);
      expect(text.out.join("")).toContain("check_lint, check_unit (proposed)");

      const written = streams();
      expect(await runDoctorCommand({
        args: doctorArgs(repo, { config: overridePath, writeConfig: true, probe: false }),
        streams: written.streams,
        cwd: repo,
        preflight,
      })).toBe(0);
      expect(JSON.parse(written.out.join(""))).toMatchObject({
        config: { present: false, written: true, proposed: codexSelection },
        provider: { dependency: { reason: expect.stringContaining(configPath) } },
      });
      const saved = TicketRunConfigSchema.parse(
        mergeRunConfig({ dir: join(repo, ".perbo"), key: "PRB-1", repository_root: repo }, null),
      );
      expect(saved).toMatchObject({ ...codexSelection, base_ref: "main" });
      expect(saved.checks.map((check) => check.check_id)).toEqual(["check_lint", "check_unit"]);
      expect(saved.materialization_manifest?.source_checkout).toBe(repo);
      expect(saved.limits.limits.attempt_stall_ms).toBe(1_200_000);
      // D-096: the scaffold writes the defaults a run actually has, and the
      // ceilings this ticket removed have none — including the two cost caps,
      // whose numbers wait on a credential billed per token.
      expect(saved.limits.limits.attempt_cost_micros).toBeUndefined();
      expect(saved.limits.limits.ticket_cost_micros).toBeUndefined();
      expect(saved.limits.limits.attempt_wall_clock_ms).toBeUndefined();
      expect(saved.limits.limits.attempt_tokens).toBeUndefined();
      expect(saved.limits.limits.attempt_iterations).toBeUndefined();
      expect(saved.limits.limits.round_iterations).toBeUndefined();
      expect(saved.limits.limits.attempt_commands).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, DOCTOR_RUN_TIMEOUT_MS);

  it("overlays provider choices for readiness while preserving an existing repository agreement", async () => {
    const repo = repository("codex-existing-config");
    try {
      execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
      const store = join(repo, ".perbo");
      mkdirSync(store);
      const configPath = join(store, "config.json");
      const stored = JSON.stringify({
        agent_binary: "claude",
        model: "claude-opus-5",
        reviewer_provider: "claude-cli",
        checks: [{ check_id: "check_saved" }],
      });
      writeFileSync(configPath, stored);
      const overridePath = join(repo, "desktop-selection.json");
      writeFileSync(overridePath, JSON.stringify(codexSelection));
      const preflight = readyPreflight();
      const report = streams();
      await runDoctorCommand({
        args: doctorArgs(repo, { config: overridePath, probe: false }),
        streams: report.streams,
        cwd: repo,
        preflight,
      });
      expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
        agentBinary: "codex",
        reviewerProvider: "codex-cli",
      }));
      expect(JSON.parse(report.out.join(""))).toMatchObject({
        provider: {
          transport: "codex-cli",
          model: "gpt-6-astra",
          dependency: { reason: expect.stringContaining(`with overrides from ${overridePath}`) },
        },
        checks: { pinned: ["check_saved"] },
        config: { present: true, proposed: null, written: false, override_path: overridePath },
      });
      expect(readFileSync(configPath, "utf8")).toBe(stored);
      await expect(runDoctorCommand({
        args: doctorArgs(repo, { config: overridePath, writeConfig: true, probe: false }),
        streams: streams().streams,
        cwd: repo,
        preflight,
      })).rejects.toThrow(/already exists; doctor never overwrites it/);
      expect(readFileSync(configPath, "utf8")).toBe(stored);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, DOCTOR_RUN_TIMEOUT_MS);

  it.each([null, [], "codex", 17])("rejects a non-object explicit configuration: %j", async (value) => {
    const repo = mkdtempSync(join(tmpdir(), "perbo-doctor-invalid-config-"));
    try {
      const overridePath = join(repo, "selection.json");
      writeFileSync(overridePath, JSON.stringify(value));
      const preflight = readyPreflight();
      await expect(runDoctorCommand({
        args: doctorArgs(repo, { config: overridePath, writeConfig: true }),
        streams: streams().streams,
        cwd: repo,
        preflight,
      })).rejects.toThrow(`${overridePath} is not a JSON object`);
      expect(preflight).not.toHaveBeenCalled();
      expect(existsSync(join(repo, ".perbo", "config.json"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("proposes a config from what it can see, writes it once, and never over an existing file", async () => {
    const repo = repository("first-hour");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest run", lint: "eslint .", build: "tsc" } }),
    );
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const configPath = join(repo, ".perbo", "config.json");

    const proposed = streams();
    await runDoctorCommand({ args: doctorArgs(repo), streams: proposed.streams, cwd: repo });
    const first = JSON.parse(proposed.out.join("")) as {
      config: { present: boolean; written: boolean; proposed: { checks: Array<Record<string, unknown>>; limits: { limits: Record<string, number> }; materialization_manifest: { source_checkout: string } } };
    };
    expect(first.config.present).toBe(false);
    expect(first.config.written).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(first.config.proposed.checks.map((check) => check.check_id)).toEqual(["check_lint", "check_unit"]);
    expect(first.config.proposed.checks[1]).toMatchObject({ command: ["pnpm", "run", "test"], kind: "unit" });
    expect(first.config.proposed.limits.limits.attempt_stall_ms).toBe(1_200_000);
    expect(first.config.proposed.limits.limits.attempt_iterations).toBeUndefined();
    expect(first.config.proposed.materialization_manifest.source_checkout).toBe(".");

    const text = streams();
    text.streams.isTTY = true;
    await runDoctorCommand({ args: doctorArgs(repo, { json: false }), streams: text.streams, cwd: repo });
    expect(text.out.join("")).toContain("does not exist. Proposed:");
    expect(text.out.join("")).toContain("--write-config");

    const written = streams();
    await runDoctorCommand({ args: doctorArgs(repo, { writeConfig: true }), streams: written.streams, cwd: repo });
    expect(existsSync(configPath)).toBe(true);
    expect((JSON.parse(written.out.join("")) as { config: { written: boolean } }).config.written).toBe(true);

    // What it wrote is a run configuration the loop accepts, through the same merge a ticket gets.
    const merged = TicketRunConfigSchema.safeParse(
      mergeRunConfig({ dir: join(repo, ".perbo"), key: "PRB-1", repository_root: repo }, null),
    );
    expect(merged.success).toBe(true);
    expect(merged.success && merged.data.checks.map((check) => check.name)).toEqual(["lint", "test"]);

    const untouched = readFileSync(configPath, "utf8");
    await expect(
      runDoctorCommand({ args: doctorArgs(repo, { writeConfig: true }), streams: streams().streams, cwd: repo }),
    ).rejects.toThrow(/already exists; doctor never overwrites it/);
    expect(readFileSync(configPath, "utf8")).toBe(untouched);
  }, DOCTOR_RUN_TIMEOUT_MS);
});

/**
 * The CLI README's account of where a run publishes, against the labels the
 * code prints.
 */
describe("where a run publishes, as the README tells it", () => {
  it("names branch, then config, then remote default, and the key that sets one", () => {
    const readme = readFileSync(join(REPO_ROOT, "apps", "cli", "README.md"), "utf8");
    const heading = "## Where a run publishes";
    expect(readme).toContain(heading);

    // The section, to the next one: what the labels are read against is this
    // section's own prose, not a mention of `config` three pages away.
    const after = readme.slice(readme.indexOf(heading) + heading.length);
    const next = after.search(/^#{2,3} /m);
    const section = next === -1 ? after : after.slice(0, next);

    // The three sources the code labels, in the order they are read, and every
    // one of them named — a source added to BASE_SOURCE_LABEL and left out of
    // the README fails here.
    const labels = Object.values(BASE_SOURCE_LABEL);
    expect(labels).toEqual(["branch", "config", "remote default"]);
    const at = labels.map((label) => section.indexOf(`**${label}**`));
    expect(at.every((index) => index !== -1)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));

    // And the key a person sets to name one themselves.
    expect(section).toContain("base_ref");
  });
});
