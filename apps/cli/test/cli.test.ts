import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { LimitExceededError, PlanContractSchema, hasAcceptanceCriteria } from "@perbo/contracts";
import { ProviderError, type ReviewModel } from "@perbo/review";
import { AgentConfigurationPresentError, DeliveryError } from "@perbo/runner";
import { WorkspaceError } from "@perbo/workspace";
import { parseReviewArgs, UsageError } from "../src/args.js";
import { ResumeRecordSchema, contractForUnresolved, mergeResumed } from "../src/resume.js";
import { VERSION, describeFailure, runReviewCommand, type RunOptions, type Streams } from "../src/run.js";
import { spawnBuilt } from "./open-build.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageMetadata: unknown = JSON.parse(
  readFileSync(resolve(here, "..", "package.json"), "utf8"),
);
if (
  typeof packageMetadata !== "object" ||
  packageMetadata === null ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string"
) {
  throw new Error("apps/cli/package.json has no string version");
}
const manifestVersion = packageMetadata.version;
const scratch = mkdtempSync(join(tmpdir(), "perbo-cli-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const contract = {
  plan_id: "plan_cli",
  version: 3,
  ticket_id: "ticket_cli",
  level: "P1",
  outcome: "search results are paginated",
  acceptance_criteria: [
    {
      id: "ac_1",
      text: "A search returns at most 25 hits per page.",
      expected_verification: { kind: "test", assertion: "a 140-hit query returns 25" },
    },
    {
      id: "ac_2",
      text: "The total number of matches is reported.",
      expected_verification: { kind: "test", assertion: "total is 140" },
    },
  ],
  scope: {
    repository_id: "repo_cli",
    paths_allowed: ["packages/search/**"],
    paths_prohibited: [".github/**"],
    generated_paths: [],
    expansion_budget_files: 3,
  },
  base: {
    base_commit: "a1b2c3d",
    context_manifest_hash: `sha256:${"0".repeat(64)}`,
    captured_at: "2026-08-27T09:00:00Z",
  },
};

const diff = `diff --git a/packages/search/src/query.ts b/packages/search/src/query.ts
index 1111111..2222222 100644
--- a/packages/search/src/query.ts
+++ b/packages/search/src/query.ts
@@ -1,1 +1,2 @@
-export const PAGE = 0;
+export const PAGE = 25;
+export const total = 140;
`;

const checks = [
  {
    check_id: "check_ut",
    name: "unit",
    kind: "unit",
    status: "passed",
    summary: "2 passed",
    command: "vitest run",
    detail: null,
    duration_ms: null,
    source: "file",
  },
];

const repoDir = join(scratch, "repo");
mkdirSync(join(repoDir, "packages/search/src"), { recursive: true });
writeFileSync(join(repoDir, "packages/search/src/query.ts"), "export const PAGE = 25;\n");
writeFileSync(join(scratch, "contract.json"), JSON.stringify(contract));
writeFileSync(join(scratch, "change.diff"), diff);
writeFileSync(join(scratch, "checks.json"), JSON.stringify(checks));

const entry = (overrides: Record<string, unknown>) => ({
  criterion_id: "ac_1",
  status: "met",
  verification_strength: "directly_verified",
  evidence_type: "test_result",
  evidence_ref: "check_ut",
  evidence_assertion: "expect(hits).toHaveLength(25)",
  evidence_file: "packages/search/test/query.test.ts",
  evidence_line: 7,
  evidence_symbol: null,
  note: null,
  ...overrides,
});

function stubModel(input: unknown): ReviewModel {
  return {
    provider: "double",
    model_id: "scripted",
    async turn() {
      return {
        toolCalls: [{ id: "t1", name: "submit_review", input }],
        usage: {
          input_tokens: 4200,
          output_tokens: 900,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: "tool_use",
      };
    },
  };
}

function failingModel(kind: "provider_unavailable" | "timeout" = "provider_unavailable"): ReviewModel {
  return {
    provider: "double",
    model_id: "scripted",
    async turn(): Promise<never> {
      throw new ProviderError("HTTP 529 after 3 attempts", 3, kind);
    },
  };
}

interface Captured {
  out: string;
  err: string;
  code: number;
}

let stateDir = "";
beforeEach(() => {
  stateDir = mkdtempSync(join(scratch, "state-"));
});

async function invoke(
  argv: string[],
  model: ReviewModel,
  isTTY = false,
  extra: Partial<RunOptions> = {},
): Promise<Captured> {
  let out = "";
  let err = "";
  const streams: Streams = {
    stdout: (chunk) => (out += chunk),
    stderr: (chunk) => (err += chunk),
    isTTY,
  };
  const args = parseReviewArgs([...argv, "--state", stateDir]);
  const code = await runReviewCommand({
    args,
    streams,
    cwd: scratch,
    now: new Date("2026-08-27T10:00:00Z"),
    makeModel: () => model,
    ...extra,
  });
  return { out, err, code };
}

const base = [
  "--contract",
  "contract.json",
  "--diff",
  "change.diff",
  "--checks",
  "checks.json",
  "--repo",
  "repo",
];

const bothMet = {
  coverage: [entry({ criterion_id: "ac_1" }), entry({ criterion_id: "ac_2" })],
  findings: [],
  check_assertions: [{ check_id: "check_ut", asserted_status: "passed" }],
  overall_confidence: 0.86,
};

describe("version source", () => {
  it("reports the package manifest version", () => {
    expect(VERSION).toBe(manifestVersion);
  });
});

describe("exit codes", () => {
  it("exits 0 only for approve", async () => {
    const result = await invoke(base, stubModel(bothMet));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).decision).toBe("approve");
  });

  it("exits 2 for a closed gate: the unmet criterion routes under d064 and still does not merge", async () => {
    const result = await invoke(
      base,
      stubModel({
        ...bothMet,
        coverage: [entry({ criterion_id: "ac_1" }), entry({ criterion_id: "ac_2", status: "not_met" })],
      }),
    );
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out).decision).toBe("remediable");
  });

  it("exits 3 for incomplete, not 2", async () => {
    const result = await invoke(
      base,
      stubModel({
        ...bothMet,
        coverage: [
          entry({ criterion_id: "ac_1" }),
          entry({ criterion_id: "ac_2", status: "cannot_determine" }),
        ],
      }),
    );
    expect(result.code).toBe(3);
    expect(JSON.parse(result.out).decision).toBe("incomplete");
  });

  it("exits 3 for error, and still emits a valid artifact", async () => {
    const result = await invoke(base, failingModel());
    expect(result.code).toBe(3);
    const artifact = JSON.parse(result.out);
    expect(artifact.decision).toBe("error");
    expect(artifact.schema_version).toBe(1);
  });

  it("exits 1 for a verdict naming a criterion the plan does not contain", async () => {
    const result = await invoke(
      base,
      stubModel({ ...bothMet, coverage: [entry({ criterion_id: "ac_9" })] }),
    );
    expect(result.code).toBe(1);
    // The reviewer was asked once for a correction and returned the same
    // verdict, so neither could be used (SCP-165).
    const artifact = JSON.parse(result.out);
    expect(artifact.error.kind).toBe("verdict_rejected");
    expect(artifact.rejected_verdicts.map((rejected: { kind: string }) => rejected.kind)).toEqual([
      "unknown_criterion_id",
      "unknown_criterion_id",
    ]);
  });

  it("gives a caller that checks only for 2 no way to merge an unreviewed change", async () => {
    const notReviewed = [await invoke(base, failingModel())];
    for (const result of notReviewed) {
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBe(2);
    }
  });
});

describe("streams", () => {
  it("puts the artifact on stdout and nothing else, when piped", async () => {
    const result = await invoke(base, stubModel(bothMet), false);
    expect(() => JSON.parse(result.out)).not.toThrow();
  });

  it("keeps progress and diagnostics on stderr under every outcome", async () => {
    const ok = await invoke(base, stubModel(bothMet));
    const failed = await invoke(base, failingModel());
    for (const result of [ok, failed]) {
      expect(() => JSON.parse(result.out)).not.toThrow();
    }
    expect(failed.err.length).toBeGreaterThan(0);
  });

  it("renders for a human on a terminal and stays inside 80 columns", async () => {
    const result = await invoke([...base, "--no-color"], stubModel(bothMet), true);
    expect(() => JSON.parse(result.out)).toThrow();
    for (const line of result.out.split("\n")) {
      expect(line.length, `too wide: ${line}`).toBeLessThanOrEqual(80);
    }
  });

  it("renders an unavailable dollar cost as unavailable rather than free", async () => {
    const model = stubModel(bothMet);
    Object.assign(model, { unreported_cost_basis: "unavailable" as const });
    const result = await invoke([...base, "--no-color"], model, true);
    expect(result.out).toContain("cost unavailable");
    expect(result.out).not.toContain("$0.000");
  });

  it("conveys strength, blocking and check results without colour", async () => {
    const result = await invoke(
      [...base, "--no-color"],
      stubModel({
        ...bothMet,
        coverage: [
          entry({ criterion_id: "ac_1", verification_strength: "proxy" }),
          entry({ criterion_id: "ac_2", status: "not_met" }),
        ],
      }),
      true,
    );
    // eslint-disable-next-line no-control-regex
    expect(result.out).not.toMatch(/\[/);
    expect(result.out).toContain("directly_verified");
    expect(result.out).toContain("proxy");
    expect(result.out).toContain("not_met");
    // Under d064 the unmet criterion routes to the executor: the finding
    // renders as work going back, and the verdict is remediable.
    expect(result.out).toContain("[FIX]");
    expect(result.out).toContain("✓");
    expect(result.out).toContain("DETERMINISTIC CHECKS");
    expect(result.out).toContain("remediable");
  });

  it("emits JSON on a terminal when asked", async () => {
    const result = await invoke([...base, "--json"], stubModel(bothMet), true);
    expect(() => JSON.parse(result.out)).not.toThrow();
  });

  // The error screen. Every check passed and no blocking
  // finding was produced, because the reviewer never got far enough to produce
  // one. The screen has to say so.
  it("renders a review that did not complete as a review that did not complete", async () => {
    const result = await invoke([...base, "--no-color"], failingModel("timeout"), true);
    expect(result.out).toContain("VERDICT");
    expect(result.out).toContain("error");
    expect(result.out).toContain("timeout");
    expect(result.out).toContain("no verdict reached on ac_1, ac_2");
    expect(result.out).toContain("perbo review --resume rev_");
    expect(result.out).toContain("re-runs only the unresolved criteria");
    expect(result.out).not.toContain("[BLOCK]");
    for (const line of result.out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("never widens past 80 columns, whatever a finding says", async () => {
    const result = await invoke(
      [...base, "--no-color"],
      stubModel({
        ...bothMet,
        findings: [
          {
            rule_id: `rule.${"x".repeat(120)}`,
            criterion_id: "ac_1",
            severity: "blocker",
            confidence: 0.99,
            file: `packages/search/${"deep/".repeat(30)}query.ts`,
            line: 1,
            symbol: null,
            statement: "y".repeat(500),
          },
        ],
      }),
      true,
    );
    for (const line of result.out.split("\n")) {
      expect(line.length, `too wide: ${line.slice(0, 100)}`).toBeLessThanOrEqual(80);
    }
  });
});

describe("a reviewer that could not be reached", () => {
  it("names the sign-in to fix and offers no resume, which would fail the same way", async () => {
    const result = await invoke([...base, "--no-color"], failingModel(), true);
    expect(result.code).toBe(3);
    expect(result.err).toContain("sign in with `claude`");
    expect(result.out).not.toContain("--resume");
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("names ANTHROPIC_API_KEY when the SDK transport was selected", async () => {
    const result = await invoke([...base, "--provider", "anthropic"], failingModel());
    expect(result.err).toContain("ANTHROPIC_API_KEY");
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("still saves a resume for a failure a re-run can clear", async () => {
    const result = await invoke([...base, "--no-color"], failingModel("timeout"), true);
    expect(result.out).toContain("perbo review --resume rev_");
    expect(readdirSync(stateDir)).toHaveLength(1);
  });
});

describe("preflight", () => {
  it("refuses to start on a machine that lacks the reviewer, with the fix, before any model call", async () => {
    let turns = 0;
    const model: ReviewModel = {
      ...stubModel(bothMet),
      async turn() {
        turns += 1;
        throw new Error("must not be called");
      },
    };
    const result = await invoke(base, model, false, {
      preflight: () => ({
        ok: false,
        findings: [
          {
            severity: "blocking",
            reason: "reviewer_binary_missing",
            detail: "the reviewer provider is `claude-cli` and `claude` is not on PATH",
            fix: "install Claude Code and sign in with `claude`",
          },
        ],
        tools: { claude: { present: false, version: null } },
      }),
    });
    expect(result.code).toBe(3);
    expect(result.err).toContain("reviewer_binary_missing");
    expect(result.err).toContain("sign in with `claude`");
    expect(result.out).toBe("");
    expect(turns).toBe(0);
  });

  it("asks only about the reviewer's transport, never about a coding agent or git", async () => {
    const requests: unknown[] = [];
    await invoke([...base, "--provider", "anthropic"], stubModel(bothMet), false, {
      preflight: (request) => {
        requests.push(request);
        return { ok: true, findings: [], tools: {} };
      },
    });
    expect(requests).toEqual([
      {
        agentBinary: null,
        agentProvider: null,
        reviewerProvider: "anthropic",
        needsGh: false,
        needsGit: false,
      },
    ]);
  });
});

describe("redaction at every exit (D-063)", () => {
  const leaky = {
    ...bothMet,
    findings: [
      {
        rule_id: "security.hardcoded_credential",
        criterion_id: "ac_1",
        severity: "major",
        confidence: 0.9,
        file: "packages/search/src/query.ts",
        line: 1,
        symbol: null,
        statement: 'A signing secret is committed: const K = "sk_live_51QeXampleNotReal";',
      },
    ],
  };

  it("never prints the credential on stdout", async () => {
    const result = await invoke(base, stubModel(leaky));
    expect(result.out).not.toContain("sk_live_51QeXampleNotReal");
    expect(result.out).toContain("[redacted");
    expect(result.err).toMatch(/redacted 1 credential/);
  });

  it("writes it unredacted only to --raw-artifact, never to stdout", async () => {
    const rawPath = join(mkdtempSync(join(scratch, "raw-")), "nested", "raw.json");
    const result = await invoke([...base, "--raw-artifact", rawPath], stubModel(leaky));
    expect(result.out).not.toContain("sk_live_51QeXampleNotReal");
    const raw = readFileSync(rawPath, "utf8");
    expect(raw).toContain("sk_live_51QeXampleNotReal");
    expect(JSON.parse(raw).review_id).toBe(JSON.parse(result.out).review_id);
  });

  it("never writes it to the bundle", async () => {
    const bundleDir = mkdtempSync(join(scratch, "bundle-"));
    const result = await invoke([...base, "--bundle", bundleDir], stubModel(leaky));
    const reviewId = JSON.parse(result.out).review_id as string;
    const bundle = readFileSync(join(bundleDir, `${reviewId}.bundle.json`), "utf8");
    expect(bundle).not.toContain("sk_live_51QeXampleNotReal");
  });

  it("never writes it to the resume record", async () => {
    const result = await invoke(
      base,
      stubModel({
        ...leaky,
        coverage: [entry({ criterion_id: "ac_1" }), entry({ criterion_id: "ac_2", status: "cannot_determine" })],
      }),
    );
    const reviewId = JSON.parse(result.out).review_id as string;
    const record = readFileSync(join(stateDir, `${reviewId}.json`), "utf8");
    expect(record).not.toContain("sk_live_51QeXampleNotReal");
    expect(record).toContain("[redacted");
  });
});

describe("a verdict-integrity error", () => {
  it("records the review that ran, not a stand-in for it", async () => {
    const result = await invoke(
      [...base, "--provider", "codex-cli"],
      stubModel({ ...bothMet, coverage: [entry({ criterion_id: "ac_9" })] }),
    );
    const artifact = JSON.parse(result.out);
    // The artifact is the one the review produced, so the transport it names is
    // the one that answered and the cost is what the two turns actually cost —
    // not the provider the command line asked for and a zero.
    expect(artifact.model.provider).toBe("double");
    expect(artifact.decision).toBe("error");
    expect(artifact.cost_micros).toBeGreaterThan(0);
    expect(artifact.rejected_verdicts).toHaveLength(2);
  });
});

describe("resume", () => {
  const partial = {
    ...bothMet,
    coverage: [
      entry({ criterion_id: "ac_1" }),
      entry({ criterion_id: "ac_2", status: "cannot_determine" }),
    ],
  };

  it("saves an unfinished review and nothing when it finishes", async () => {
    const incomplete = await invoke(base, stubModel(partial));
    const reviewId = JSON.parse(incomplete.out).review_id as string;
    expect(existsSync(join(stateDir, `${reviewId}.json`))).toBe(true);

    const clean = mkdtempSync(join(scratch, "state-"));
    let out = "";
    const args = parseReviewArgs([...base, "--state", clean]);
    await runReviewCommand({
      args,
      streams: { stdout: (chunk) => (out += chunk), stderr: () => undefined, isTTY: false },
      cwd: scratch,
      now: new Date("2026-08-27T10:00:00Z"),
      makeModel: () => stubModel(bothMet),
    });
    const id = JSON.parse(out).review_id as string;
    expect(existsSync(join(clean, `${id}.json`))).toBe(false);
  });

  it("re-runs only the unresolved criteria and merges the result", async () => {
    const incomplete = await invoke(base, stubModel(partial));
    const incompleteArtifact = JSON.parse(incomplete.out);
    const reviewId = JSON.parse(incomplete.out).review_id as string;

    // The resumed model is asked about ac_2 alone; naming ac_1 would be a
    // criterion outside the contract it was given.
    const resumed = await invoke(
      ["--resume", reviewId, "--repo", "repo"],
      stubModel({
        coverage: [entry({ criterion_id: "ac_2" })],
        findings: [],
        check_assertions: [],
        overall_confidence: 0.9,
      }),
    );
    const artifact = JSON.parse(resumed.out);
    expect(resumed.code).toBe(0);
    expect(artifact.decision).toBe("approve");
    expect(artifact.resumed_from).toBe(reviewId);
    expect(artifact.coverage.map((entry: { criterion_id: string }) => entry.criterion_id)).toEqual([
      "ac_1",
      "ac_2",
    ]);
    // Cost accumulates across both runs rather than being reported as one.
    expect(artifact.cost_micros).toBeGreaterThan(incompleteArtifact.cost_micros);
    expect(artifact.model.input_tokens).toBeGreaterThan(incompleteArtifact.model.input_tokens);
  });

  it("does not preserve a priced subtotal when either half of a resume is unavailable", async () => {
    const firstModel = stubModel(partial);
    Object.assign(firstModel, { unreported_cost_basis: "unavailable" as const });
    const incomplete = await invoke(base, firstModel);
    const first = JSON.parse(incomplete.out);

    const resumed = await invoke(
      ["--resume", first.review_id, "--repo", "repo"],
      stubModel({
        coverage: [entry({ criterion_id: "ac_2" })],
        findings: [],
        check_assertions: [],
        overall_confidence: 0.9,
      }),
    );
    const artifact = JSON.parse(resumed.out);

    expect(artifact.model.cost_basis).toBe("unavailable");
    expect(artifact.cost_micros).toBe(0);
    expect(artifact.model.input_tokens).toBeGreaterThan(first.model.input_tokens);
  });

  it("refuses to combine --resume with a fresh contract", () => {
    expect(() => parseReviewArgs(["--resume", "rev_1", "--contract", "c.json"])).toThrow(UsageError);
  });

  it("recounts escalations from the finding's routing, not from the wording of its reason", async () => {
    const fresh = JSON.parse((await invoke(base, stubModel(bothMet))).out);
    const record = ResumeRecordSchema.parse({
      review_id: "rev_0000000000000001",
      saved_at: "2026-08-27T09:00:00.000Z",
      contract,
      diff,
      checks: [],
      repo: "repo",
      head_commit: null,
      resolved_coverage: [],
      resolved_findings: [
        {
          key: "e".repeat(64),
          rule_id: "behaviour.incidental_change",
          source: "semantic",
          criterion_id: null,
          severity: "major",
          blocking: false,
          // Phrased without the words an earlier recount searched for.
          blocking_reason: "semantic on a P2 change, below the stated confidence floor of 0.7",
          routing: "escalates",
          row: "semantic_high_risk",
          closure: "human",
          direction: null,
          confidence: 0.4,
          file: "packages/search/src/query.ts",
          line: 1,
          symbol: null,
          statement: "The export now includes archived rows.",
          status: "open",
          outcome: "unknown",
          waiver: null,
        },
      ],
      unresolved: ["ac_2"],
      cost_micros: 0,
      latency_ms: 0,
    });
    expect(mergeResumed(record, fresh, ["ac_1", "ac_2"]).decision).toBe("escalate");
  });

  it("keeps a resumed graph contract's nodes parseable, dropping the resolved criterion from its node too", () => {
    const graph = PlanContractSchema.parse({
      ...contract,
      nodes: [
        { id: "node_1", title: "Page the results", criteria: ["ac_1"], paths: ["packages/search/**"] },
        { id: "node_2", title: "Report the total", criteria: ["ac_2"], paths: ["packages/search/**"] },
      ],
    });
    if (!hasAcceptanceCriteria(graph)) throw new Error("fixture has no acceptance criteria");
    // ac_1 is resolved; only ac_2, alone in node_2, is unresolved.
    const narrowed = contractForUnresolved(graph, ["ac_2"]);
    if (!hasAcceptanceCriteria(narrowed)) throw new Error("narrowed contract lost its criteria");
    expect(narrowed.acceptance_criteria.map((criterion) => criterion.id)).toEqual(["ac_2"]);
    expect(narrowed.nodes?.map((node) => node.id)).toEqual(["node_2"]);
  });
});

describe("the run bundle", () => {
  it("records the prompt and the files read, and carries no credential", async () => {
    const bundleDir = mkdtempSync(join(scratch, "bundle-"));
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
    try {
      const result = await invoke([...base, "--bundle", bundleDir], stubModel(bothMet));
      const reviewId = JSON.parse(result.out).review_id as string;
      const bundle = JSON.parse(readFileSync(join(bundleDir, `${reviewId}.bundle.json`), "utf8"));
      expect(bundle.run.system_prompt.length).toBeGreaterThan(100);
      expect(JSON.stringify(bundle)).not.toContain("sk-ant-test-not-a-real-key");
      expect(JSON.stringify(bundle)).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("argument parsing", () => {
  it("rejects an unknown flag rather than reviewing something else", () => {
    expect(() => parseReviewArgs(["--contract", "c.json", "--diff", "d", "--typo"])).toThrow(
      UsageError,
    );
  });

  it("requires a contract and a diff", () => {
    expect(() => parseReviewArgs(["--diff", "d"])).toThrow(/--contract is required/);
    expect(() => parseReviewArgs(["--contract", "c"])).toThrow(/--diff is required/);
  });

  it("accepts --flag=value as well as --flag value", () => {
    const args = parseReviewArgs(["--contract=c.json", "--diff", "d.diff", "--repo=/tmp"]);
    expect(args.contract).toBe("c.json");
    expect(args.repo).toBe("/tmp");
  });

  it("reviews on the local claude login by default, as `perbo run` does", () => {
    expect(parseReviewArgs(["--contract", "c.json", "--diff", "d.diff"]).provider).toBe("claude-cli");
  });

  it("accepts the isolated Codex reviewer transport", () => {
    const args = parseReviewArgs([
      "--contract",
      "c.json",
      "--diff",
      "d.diff",
      "--provider",
      "codex-cli",
    ]);
    expect(args.provider).toBe("codex-cli");
  });
});

describe("a failure that reaches the top level", () => {
  const noStack = (message: string) => expect(message).not.toMatch(/\n\s+at /);

  it("names the limit and the setting that raises it, with the command's own noun", () => {
    const failure = describeFailure(
      "run",
      new LimitExceededError(
        "limit_exceeded",
        "attempt_iterations",
        60,
        61,
        "attempt_iterations would reach 61, above the limit of 60",
      ),
    );
    expect(failure.code).toBe(3);
    expect(failure.message).toMatch(/^the run was refused by a limit/);
    expect(failure.message).toContain("limits.limits.attempt_iterations");
    noStack(failure.message);
  });

  it("names a kill switch as a switch, not as a ceiling", () => {
    const failure = describeFailure(
      "run",
      new LimitExceededError("provider_disabled", null, null, null, "provider claude-cli is disabled by kill switch"),
    );
    expect(failure.message).toContain("kill switch");
    expect(failure.message).not.toContain("limits.limits");
  });

  it("points a workspace failure at doctor", () => {
    const failure = describeFailure(
      "run",
      new WorkspaceError("port_allocation_unavailable", "no free range under the lock"),
    );
    expect(failure.message).toContain("could not prepare a worktree");
    expect(failure.message).toContain("perbo doctor");
    noStack(failure.message);
  });

  it("carries a delivery refusal's detail", () => {
    const failure = describeFailure(
      "run",
      new DeliveryError("refusing to push", "main is not an attempt branch"),
    );
    expect(failure.message).toContain("could not publish");
    expect(failure.message).toContain("main is not an attempt branch");
  });

  it("says what stopped an attempt when the agent loaded repository configuration", () => {
    const failure = describeFailure(
      "run",
      new AgentConfigurationPresentError("tool servers were connected: hostile", {
        mcp_servers: ["hostile"], plugins: [], skills: [], subagents: [], memory_paths: [],
      }),
    );
    expect(failure.message).toContain("stopped because tool servers were connected: hostile");
    noStack(failure.message);
  });

  it("turns a missing binary into its install step rather than a stack", () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
      syscall: "spawn claude",
      path: "claude",
      spawnargs: ["-p"],
    });
    const failure = describeFailure("review", enoent);
    expect(failure.message).toMatch(/^the review needs `claude`/);
    expect(failure.message).toContain("sign in with `claude`");
    noStack(failure.message);
  });

  it("keeps the stack only for an error nothing recognises", () => {
    const failure = describeFailure("run", new Error("something nobody expected"));
    expect(failure.code).toBe(3);
    expect(failure.message).toMatch(/^the run did not complete: Error: something nobody expected/);
    expect(failure.message).toMatch(/\n\s+at /);
  });
});

/**
 * `dist/main.js` as `turbo run build` leaves it, not a copy this file
 * compiles — the one artefact this suite does not build fresh. Each `it`
 * below is one cold spawn of it, individually bounded by `spawnBuilt`'s own
 * deadline; 20s per test is that same deadline plus a small margin for the
 * permission-free path here to actually exit rather than being killed.
 */
describe.sequential("the built binary", () => {
  const bin = resolve(here, "..", "dist", "main.js");
  const run = (argv: string[]) => {
    const result = spawnBuilt([bin, ...argv], { cwd: scratch });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  };

  it.skipIf(!existsSync(bin))("exits 1 with no arguments", () => {
    const result = run([]);
    expect(result.code, result.stderr).toBe(1);
  }, 20_000);

  it.skipIf(!existsSync(bin))("exits 0 for --help and writes nothing to stdout", () => {
    const result = run(["--help"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  }, 20_000);

  it.skipIf(!existsSync(bin))("exits 1 for an unknown command", () => {
    const result = run(["reveiw"]);
    expect(result.code, result.stderr).toBe(1);
  }, 20_000);

  it.skipIf(!existsSync(bin))("exits 1 for an unreadable contract", () => {
    const result = run(["review", "--contract", "nope.json", "--diff", "change.diff"]);
    expect(result.code, result.stderr).toBe(1);
  }, 20_000);

  it.skipIf(!existsSync(bin))("exits 1 for an unknown flag", () => {
    const result = run(["review", "--contract", "contract.json", "--diff", "change.diff", "--nope"]);
    expect(result.code, result.stderr).toBe(1);
  }, 20_000);
});

/**
 * `reviewSchema`'s doc comment says a node's call and the whole-change call
 * are never built from two different expressions of the same thing — but a
 * flat contract's one call never goes through `modelFor` at all
 * (`reviewGraph` calls `run` on `input.model` directly when the contract has
 * no nodes), so this is the one place a checks file carrying a stray node
 * tag could still let the schema promise a check id the call never shows.
 */
describe("the flat review's verdict schema", () => {
  it("is built from wholeChangeChecks, not a checks file's stray node tag", async () => {
    const flatChecksWithNodeTag = [
      {
        check_id: "check_ut",
        name: "unit",
        kind: "unit",
        status: "passed",
        summary: "2 passed",
        command: "vitest run",
        detail: null,
        duration_ms: null,
        source: "file",
      },
      {
        // A stray node tag: this contract has no `nodes` at all, but the
        // checks file still carries one — the one shape reviewSchema's
        // unfiltered `checks` and the call's own wholeChangeChecks(checks)
        // disagree on.
        check_id: "check_node_stray",
        name: "unit",
        kind: "unit",
        status: "passed",
        summary: "1 passed",
        command: "vitest run packages/search/test/other.test.ts",
        detail: null,
        duration_ms: null,
        source: "file",
        node: {
          node_id: "node_ghost",
          scope: "files",
          paths: ["packages/search/test/other.test.ts"],
          note: null,
        },
      },
    ];
    writeFileSync(join(scratch, "flat-checks-with-node-tag.json"), JSON.stringify(flatChecksWithNodeTag));

    let capturedSchema: Record<string, unknown> | null = null;
    const result = await invoke(
      [
        "--contract",
        "contract.json",
        "--diff",
        "change.diff",
        "--checks",
        "flat-checks-with-node-tag.json",
        "--repo",
        "repo",
      ],
      stubModel(bothMet),
      false,
      {
        makeModel: (submitSchema) => {
          capturedSchema = submitSchema;
          return stubModel(bothMet);
        },
      },
    );

    expect(result.code, result.err).toBe(0);
    const checkIds = (
      capturedSchema as {
        properties: { check_assertions: { items: { properties: { check_id: { enum: string[] } } } } };
      }
    ).properties.check_assertions.items.properties.check_id.enum;
    expect(checkIds).toContain("check_ut");
    expect(checkIds).toContain("check_scope");
    expect(checkIds).not.toContain("check_node_stray");
  });
});

/**
 * D-107, through `perbo review`: a graphed contract is reviewed once per
 * node and once overall, and what is printed is the combined artifact — a
 * flat contract's own tests above are untouched and still pass unmodified.
 */
describe("a graphed contract", () => {
  const graphContract = {
    plan_id: "plan_cli_graph",
    version: 1,
    ticket_id: "ticket_cli_graph",
    level: "P1",
    outcome: "search results are paginated",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "A search returns at most 25 hits per page.",
        expected_verification: { kind: "test", assertion: "a 140-hit query returns 25" },
      },
      {
        id: "ac_2",
        text: "The total number of matches is reported.",
        expected_verification: { kind: "test", assertion: "total is 140" },
      },
    ],
    nodes: [
      { id: "node_page", title: "Page size", criteria: ["ac_1"], paths: ["packages/search/src/query.ts"] },
      { id: "node_total", title: "Total count", criteria: ["ac_2"], paths: ["packages/search/src/total.ts"] },
    ],
    scope: contract.scope,
    base: contract.base,
  };

  const graphDiff = `diff --git a/packages/search/src/query.ts b/packages/search/src/query.ts
index 1111111..2222222 100644
--- a/packages/search/src/query.ts
+++ b/packages/search/src/query.ts
@@ -1,1 +1,1 @@
-export const PAGE = 0;
+export const PAGE = 25;
diff --git a/packages/search/src/total.ts b/packages/search/src/total.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/packages/search/src/total.ts
@@ -0,0 +1,1 @@
+export const total = 140;
`;

  const graphArgs = [
    "--contract",
    "graph-contract.json",
    "--diff",
    "graph-change.diff",
    "--checks",
    "checks.json",
    "--repo",
    "repo",
  ];

  /** A model that answers each `.turn()` in order from a fixed script, once each. */
  function sequentialModel(inputs: unknown[]): ReviewModel & { calls: number } {
    const model = {
      provider: "double",
      model_id: "scripted",
      calls: 0,
      async turn() {
        const input = inputs[model.calls];
        model.calls += 1;
        return {
          toolCalls: [{ id: `t${model.calls}`, name: "submit_review", input }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          stop_reason: "tool_use" as const,
        };
      },
    };
    return model;
  }

  it("reviews each node and the overall — three model runs — and prints the combined artifact", async () => {
    writeFileSync(join(scratch, "graph-contract.json"), JSON.stringify(graphContract));
    writeFileSync(join(scratch, "graph-change.diff"), graphDiff);
    writeFileSync(join(repoDir, "packages/search/src/total.ts"), "export const total = 140;\n");

    // Node order (plan order): node_page, then node_total, then the overall.
    const model = sequentialModel([
      { coverage: [entry({ criterion_id: "ac_1" })], findings: [], check_assertions: [], overall_confidence: 0.9 },
      { coverage: [entry({ criterion_id: "ac_2" })], findings: [], check_assertions: [], overall_confidence: 0.9 },
      {
        coverage: [entry({ criterion_id: "ac_1" }), entry({ criterion_id: "ac_2" })],
        findings: [],
        check_assertions: [],
        overall_confidence: 0.9,
      },
    ]);

    const result = await invoke(graphArgs, model);

    expect(model.calls).toBe(3);
    expect(result.code).toBe(0);
    const artifact = JSON.parse(result.out);
    expect(artifact.decision).toBe("approve");
    expect(artifact.coverage.map((entry: { criterion_id: string }) => entry.criterion_id).sort()).toEqual([
      "ac_1",
      "ac_2",
    ]);
  });

  it("prints the combined artifact, not the overall's alone: a node-only finding still reaches it", async () => {
    writeFileSync(join(scratch, "graph-contract.json"), JSON.stringify(graphContract));
    writeFileSync(join(scratch, "graph-change.diff"), graphDiff);
    writeFileSync(join(repoDir, "packages/search/src/total.ts"), "export const total = 140;\n");

    // node_page blocks on its own criterion; node_total and the overall both
    // approve — so the print can only carry the finding by combining them.
    const model = sequentialModel([
      {
        coverage: [entry({ criterion_id: "ac_1", status: "not_met" })],
        findings: [
          {
            // The "security" family is never remediable (blocking.ts), so a
            // blocker-severity, high-confidence finding here routes to
            // "blocks" rather than "remediable" — the decision this test
            // needs to tell the combined artifact from the overall's alone.
            rule_id: "security.unbounded_query",
            criterion_id: "ac_1",
            severity: "blocker",
            confidence: 0.95,
            file: "packages/search/src/query.ts",
            line: 1,
            symbol: null,
            statement: "PAGE is set but nothing bounds a query to it.",
          },
        ],
        check_assertions: [],
        overall_confidence: 0.9,
      },
      { coverage: [entry({ criterion_id: "ac_2" })], findings: [], check_assertions: [], overall_confidence: 0.9 },
      {
        coverage: [entry({ criterion_id: "ac_1" }), entry({ criterion_id: "ac_2" })],
        findings: [],
        check_assertions: [],
        overall_confidence: 0.9,
      },
    ]);

    const result = await invoke(graphArgs, model);

    expect(model.calls).toBe(3);
    const artifact = JSON.parse(result.out);
    expect(artifact.decision).toBe("changes_requested");
    expect(
      artifact.findings.some((finding: { rule_id: string }) => finding.rule_id === "security.unbounded_query"),
    ).toBe(true);
  });
});
