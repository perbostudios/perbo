import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReviewArtifactSchema, type ReviewArtifact } from "@perbo/contracts";
import { assessLegibility, type ReviewModel } from "@perbo/review";
import { UsageError, parseReviewArgs } from "../src/args.js";
import { renderReviewMarkdown } from "../src/markdown.js";
import { runReviewCommand, type Streams } from "../src/run.js";

/**
 * `review --format markdown` (SCP-219).
 *
 * The rendering is pinned by `review-markdown.golden.md`, byte for byte,
 * against the verdict stored beside it in `review-markdown-artifact.json`. The
 * artifact is not hand-written: it is what this command emits for the scripted
 * verdict below, so the same fixture is both the stored verdict the markdown is
 * rendered from and the JSON bytes the default format still writes.
 *
 * Two things about the review are held still so that "byte for byte" means
 * something: the clock, which `now` already injects, and `Date.now()`, which
 * the latency measurement reads — faked here so the measured latency is zero
 * rather than however long the suite took.
 */

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "review-markdown.golden.md");
const artifactPath = join(here, "review-markdown-artifact.json");

const scratch = mkdtempSync(join(tmpdir(), "perbo-markdown-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const contract = {
  plan_id: "plan_markdown",
  version: 3,
  ticket_id: "ticket_markdown",
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
    repository_id: "repo_markdown",
    paths_allowed: ["packages/search/**"],
    paths_prohibited: [".github/**"],
    generated_paths: [],
    expansion_budget_files: 3,
  },
  base: {
    base_commit: "a1b2c3d",
    context_manifest_hash: `sha256:${"0".repeat(64)}`,
    captured_at: "2026-09-04T09:00:00Z",
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
  {
    check_id: "check_lint",
    name: "lint",
    kind: "lint",
    status: "failed",
    summary: "1 error",
    command: "eslint .",
    detail: "packages/search/src/query.ts: prefer const",
    duration_ms: null,
    source: "file",
  },
];

mkdirSync(join(scratch, "repo", "packages/search/src"), { recursive: true });
writeFileSync(join(scratch, "repo/packages/search/src/query.ts"), "export const PAGE = 25;\n");
writeFileSync(join(scratch, "contract.json"), JSON.stringify(contract));
writeFileSync(join(scratch, "change.diff"), diff);
writeFileSync(join(scratch, "checks.json"), JSON.stringify(checks));

/** The verdict the golden is a rendering of, as the reviewer would submit it. */
const verdict = {
  coverage: [
    {
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
      closure: "none",
    },
    {
      criterion_id: "ac_2",
      status: "not_met",
      verification_strength: "asserted_only",
      evidence_type: "none",
      evidence_ref: null,
      evidence_assertion: null,
      evidence_file: null,
      evidence_line: null,
      evidence_symbol: null,
      note: "No test reads the total back.",
      closure: "executor",
    },
  ],
  findings: [
    {
      rule_id: "criterion.unverified",
      criterion_id: "ac_2",
      severity: "major",
      confidence: 0.71,
      file: "packages/search/src/query.ts",
      line: 2,
      symbol: "total",
      statement:
        "The total is exported as a constant rather than counted, so nothing\nestablishes that it tracks the query.",
      closure: "executor",
      direction: "negative",
    },
    {
      rule_id: "naming.exported_constant_case",
      criterion_id: "ac_1",
      severity: "minor",
      confidence: 0.4,
      file: "packages/search/src/query.ts",
      line: null,
      symbol: null,
      statement: "`total` is exported in lower case beside `PAGE`.",
      closure: "executor",
      direction: "neutral",
    },
  ],
  check_assertions: [{ check_id: "check_ut", asserted_status: "passed" }],
  overall_confidence: 0.62,
};

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
        stop_reason: "tool_use" as const,
      };
    },
  };
}

interface Captured {
  out: string;
  err: string;
  code: number;
}

/**
 * The real command, with the clock held still at both places it is read: `now`,
 * which stamps the artifact, and `Date.now()`, which measures the latency.
 */
async function invoke(extra: string[], input: unknown = verdict): Promise<Captured> {
  let out = "";
  let err = "";
  const streams: Streams = {
    stdout: (chunk) => (out += chunk),
    stderr: (chunk) => (err += chunk),
    isTTY: false,
  };
  const frozen = new Date("2026-09-04T10:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => frozen.getTime();
  try {
    const code = await runReviewCommand({
      args: parseReviewArgs([
        "--contract",
        "contract.json",
        "--diff",
        "change.diff",
        "--checks",
        "checks.json",
        "--repo",
        "repo",
        "--state",
        stateDir,
        ...extra,
      ]),
      streams,
      cwd: scratch,
      now: frozen,
      makeModel: () => stubModel(input),
    });
    return { out, err, code };
  } finally {
    Date.now = realNow;
  }
}

let stateDir = "";
let stored: ReviewArtifact;
let golden = "";

beforeAll(() => {
  stateDir = mkdtempSync(join(scratch, "state-"));
  stored = ReviewArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, "utf8")));
  golden = readFileSync(goldenPath, "utf8");
});

describe("the stored verdict, rendered as markdown", () => {
  it("equals the golden byte for byte", async () => {
    const rendered = await invoke(["--format", "markdown"]);
    expect(rendered.out).toBe(golden);
    // And the same bytes from the stored artifact alone, so the golden pins the
    // rendering rather than the run that happened to produce it.
    expect(`${renderReviewMarkdown(stored)}\n`).toBe(golden);
  });

  it("leads with the verdict line", () => {
    const [first] = golden.split("\n");
    expect(first).toBe(
      "**Verdict: changes_requested** — 1 blocking · 2 for the executor · 1 advisory · confidence 0.62",
    );
    expect(first).toContain(stored.decision);
  });

  it("groups the findings under the acceptance criterion each is about, with file and line", () => {
    // Every criterion the verdict covered is a heading, and each finding a
    // person reads sits under the criterion it names — not in artifact order.
    // A finding the executor closed is counted on one line instead.
    for (const entry of stored.coverage) {
      expect(golden).toContain(`### ${entry.criterion_id} — ${entry.status}, ${entry.verification_strength}`);
    }
    const routed = stored.findings.filter((finding) => finding.routing === "remediable");
    expect(routed).not.toHaveLength(0);
    expect(golden).toContain(
      `${routed.length} findings went to the executor and are not listed here; ` +
        `review \`${stored.review_id}\` records each one.`,
    );
    for (const finding of routed) expect(golden).not.toContain(finding.rule_id);
    const sections = new Map(
      golden
        .split(/^### /m)
        .slice(1)
        .map((section) => [section.split("\n")[0]!, section] as const),
    );
    for (const finding of stored.findings.filter((one) => one.routing !== "remediable")) {
      const heading = [...sections.keys()].find((key) =>
        finding.criterion_id === null
          ? key.startsWith("Findings tied to no acceptance criterion")
          : key.startsWith(`${finding.criterion_id} `),
      );
      expect(heading, `a section for ${finding.rule_id}`).toBeDefined();
      const section = sections.get(heading!)!;
      expect(section).toContain(finding.rule_id);
      if (finding.file !== null) {
        const at = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
        expect(section).toContain(`\`${at}\``);
      }
    }
  });

  it("carries the legibility footer the review package exports", () => {
    // The words are `assessLegibility`'s own, for the same change set: the
    // footer quotes the row the rule wrote onto the artifact rather than
    // forming a second opinion about whether the diff could be read.
    const exported = assessLegibility(diff, []);
    expect(exported.check.check_id).toBe("check_legibility");
    expect(golden).toContain(
      `> **Legibility**: ${exported.check.status} — ${exported.check.summary}`,
    );
    expect(stored.checks.map((check) => check.check_id)).toContain("check_legibility");
  });

  it("carries one provenance line naming the model, the prompt version and the cost", () => {
    const provenance = golden
      .split("\n")
      .filter((line) => line.includes(stored.model.model_id) || line.includes(stored.model.prompt_version));
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toBe(
      "_Reviewed by `double/scripted` · prompt `reviewer_v10` · $0.043 estimated._",
    );
    expect(provenance[0]).toContain(stored.model.prompt_version);
    expect(provenance[0]).toContain(`$${(stored.cost_micros / 1_000_000).toFixed(3)}`);
  });
});

describe("a finding with no location", () => {
  it("renders `unlocatable` and the reason, never an empty file or a placeholder line", async () => {
    const unlocated = await invoke(["--format", "markdown"], {
      ...verdict,
      findings: [
        {
          ...verdict.findings[0]!,
          file: null,
          line: null,
          symbol: null,
          statement: "The pagination bound is decided somewhere this diff does not show.",
          // Only a finding a person has to read is rendered, so the one this
          // is about is one the reviewer said a person must close.
          closure: "human",
        },
      ],
    });
    const line = unlocated.out
      .split("\n")
      .find((one) => one.includes("criterion.unverified"));
    expect(line).toContain(
      "`criterion.unverified` · unlocatable — the reviewer recorded no file for it · confidence 0.71",
    );
    // Nothing that reads as a location: no empty code span, no bare colon-line,
    // no `(no file)` or `-` standing in for one.
    expect(unlocated.out).not.toMatch(/``/);
    expect(unlocated.out).not.toMatch(/\(no file\)/);
    expect(unlocated.out).not.toMatch(/·\s`?:\d/);
  });

  it("says why a deterministic row has none, which is a different reason", () => {
    // The failed check's finding is measured over the change set; it names no
    // path because there is none to name, not because the reviewer omitted one.
    const deterministic = stored.findings.find((finding) => finding.source === "deterministic");
    expect(deterministic?.file).toBeNull();
    expect(golden).toContain(
      "unlocatable — a deterministic check measured this over the change set rather than at a path",
    );
  });
});

describe("--format json", () => {
  it("is the default, and its bytes are the stored artifact's", async () => {
    const defaulted = await invoke([]);
    // The stored artifact moves when the finding schema does:
    // `UPDATE_REVIEW_ARTIFACT=1 pnpm exec vitest run test/review-markdown.test.ts`
    // rewrites it from this very invocation, and the diff is what to read.
    if (process.env["UPDATE_REVIEW_ARTIFACT"] === "1") writeFileSync(artifactPath, defaulted.out);
    expect(defaulted.out).toBe(readFileSync(artifactPath, "utf8"));
  });

  it("named explicitly writes the same bytes", async () => {
    const named = await invoke(["--format", "json"]);
    expect(named.out).toBe(readFileSync(artifactPath, "utf8"));
  });

  it("is what the parser leaves unset, so nothing else changed shape", () => {
    expect(parseReviewArgs(["--contract", "c", "--diff", "d"]).format).toBeNull();
    expect(parseReviewArgs(["--contract", "c", "--diff", "d", "--format", "json"]).format).toBe("json");
  });
});

describe("an unrecognised --format", () => {
  it("is a usage error naming the accepted values, not a crash or a silent fallback", () => {
    let thrown: unknown;
    try {
      parseReviewArgs(["--contract", "c", "--diff", "d", "--format", "html"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).message).toBe("--format must be one of 'json', 'markdown'");
  });
});

describe("what the rendering does not carry", () => {
  it("quotes neither the reviewed diff nor the plan's outcome or criteria", async () => {
    const rendered = await invoke(["--format", "markdown"]);
    for (const line of diff.split("\n")) {
      if (line.trim() === "") continue;
      expect(rendered.out, line).not.toContain(line);
    }
    expect(rendered.out).not.toContain(contract.outcome);
    for (const criterion of contract.acceptance_criteria) {
      expect(rendered.out).not.toContain(criterion.text);
      expect(rendered.out).not.toContain(criterion.expected_verification.assertion);
    }
    // The criteria are still there — as the ids the verdict recorded, which is
    // what the verdict said about them and all of it.
    for (const criterion of contract.acceptance_criteria) {
      expect(rendered.out).toContain(`### ${criterion.id} `);
    }
  });
});
