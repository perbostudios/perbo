import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import type { Model, ModelRequest } from "@perbo/model";
import { parseReviewArgs } from "../src/args.js";
import { exitForThrown } from "../src/entry.js";
import { runReviewCommand, type Streams } from "../src/run.js";
import { USAGE } from "../src/usage.js";

/**
 * `perbo review --diff -` and `--checks -`: one of the two read from standard
 * input, so a CI step that already holds the diff in a pipe does not have to
 * write a temporary file for it.
 *
 * The reviewer is a double, as it is in the ticketless suite: what is under
 * test is where the bytes came from, not what a provider makes of them. So the
 * assertion that matters is an equality between two whole runs — the piped one
 * and the file one — rather than a claim that some function was called with
 * some string. The two refusals are asserted the other way round: on the exit
 * code and the words, and on the model never having been built at all, because
 * "refused before anything is read or spent" is a claim about what did *not*
 * happen.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-review-stdin-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const contract = {
  plan_id: "plan_stdin",
  version: 1,
  ticket_id: "ticket_stdin",
  level: "P1",
  outcome: "search results are paginated",
  acceptance_criteria: [
    {
      id: "ac_1",
      text: "A search returns at most 25 hits per page.",
      expected_verification: { kind: "test", assertion: "a 140-hit query returns 25" },
    },
  ],
  scope: {
    repository_id: "repo_stdin",
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

const DIFF = `diff --git a/packages/search/src/query.ts b/packages/search/src/query.ts
index 1111111..2222222 100644
--- a/packages/search/src/query.ts
+++ b/packages/search/src/query.ts
@@ -1,1 +1,1 @@
-export const PAGE = 0;
+export const PAGE = 25;
`;

const checks = [
  {
    check_id: "check_ut",
    name: "unit",
    kind: "unit",
    status: "passed",
    summary: "1 passed",
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
writeFileSync(join(scratch, "change.diff"), DIFF);
writeFileSync(join(scratch, "checks.json"), JSON.stringify(checks));

/** Every request a stubbed reviewer was handed, for a test to search. */
const requests: ModelRequest[] = [];

/** A reviewer that answers the one criterion, and counts what it was asked. */
function stubModel(turns: { count: number }): Model {
  return {
    provider: "double",
    model_id: "scripted",
    async turn(request) {
      requests.push(request);
      turns.count += 1;
      return {
        toolCalls: [
          {
            id: "t1",
            name: "submit_review",
            input: {
              coverage: [
                {
                  criterion_id: "ac_1",
                  status: "met",
                  verification_strength: "directly_verified",
                  evidence_type: "test_result",
                  evidence_ref: "check_ut",
                  evidence_assertion: "expect(hits).toHaveLength(25)",
                  evidence_file: "packages/search/src/query.ts",
                  evidence_line: 1,
                  evidence_symbol: null,
                  note: null,
                },
              ],
              findings: [],
              check_assertions: [{ check_id: "check_ut", asserted_status: "passed" }],
              overall_confidence: 0.86,
            },
          },
        ],
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

interface Ran {
  out: string;
  err: string;
  code: number;
  /** How many times a reviewer was built, and how many turns it was asked for. */
  models: number;
  turns: number;
  /** How many times standard input was read. */
  reads: number;
}

let stateDir = "";
beforeEach(() => {
  stateDir = mkdtempSync(join(scratch, "state-"));
});

/**
 * One `perbo review`, with an optional standard input.
 *
 * A refusal is turned into an exit code by `exitForThrown` — the function
 * `startEntryPoint` maps a thrown error with, so the code and the words
 * asserted below are the ones the binary gives — rather than by a copy of that
 * mapping kept here.
 */
async function review(argv: string[], stdin?: string): Promise<Ran> {
  let out = "";
  let err = "";
  const streams: Streams = {
    stdout: (chunk) => (out += chunk),
    stderr: (chunk) => (err += chunk),
    isTTY: false,
  };
  const turns = { count: 0 };
  const ran = { models: 0, reads: 0 };
  let code: number;
  try {
    code = await runReviewCommand({
      args: parseReviewArgs([...argv, "--state", stateDir]),
      streams,
      cwd: scratch,
      now: new Date("2026-08-27T10:00:00Z"),
      makeModel: () => {
        ran.models += 1;
        return stubModel(turns);
      },
      ...(stdin === undefined
        ? {}
        : {
            stdin: () => {
              ran.reads += 1;
              return stdin;
            },
          }),
    });
  } catch (error) {
    const failure = exitForThrown("review", error);
    err += `error: ${failure.message}\n`;
    code = failure.code;
  }
  return { out, err, code, turns: turns.count, ...ran };
}

/**
 * The artifact with what cannot repeat taken out of it: the review's own
 * identifier, the time it was created and how long it took. Everything else is
 * a function of the contract, the diff and the check results, and so must be
 * equal between two runs given the same three by different routes.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["review_id", "created_at", "latency_ms"].includes(key))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

describe("a node's check result", () => {
  it("never reaches the reviewer: the review of the change is handed the whole-change results alone", async () => {
    const perNode = {
      ...checks[0]!,
      status: "failed",
      summary: "1 failed",
      node: { node_id: "node_queue", paths: ["packages/search/test/query.test.ts"], scope: "files", note: null },
    };
    writeFileSync(join(scratch, "checks-nodes.json"), JSON.stringify([checks[0], perNode]));
    requests.length = 0;
    const ran = await review([
      "--contract", "contract.json", "--diff", "change.diff", "--checks", "checks-nodes.json", "--repo", "repo",
    ]);
    expect(ran.code).toBe(EXIT_CODES.approve);
    expect(JSON.stringify(requests)).not.toContain("node_queue");
    const artifact = JSON.parse(ran.out) as { checks?: unknown[] };
    expect(JSON.stringify(artifact)).not.toContain("node_queue");
  });
});

describe("the diff on standard input", () => {
  it("reviews the piped diff exactly as it reviews the same diff from a file", async () => {
    const fromFile = await review([
      "--contract",
      "contract.json",
      "--diff",
      "change.diff",
      "--checks",
      "checks.json",
      "--repo",
      "repo",
    ]);
    const piped = await review(
      [
        "--contract",
        "contract.json",
        "--diff",
        "-",
        "--checks",
        "checks.json",
        "--repo",
        "repo",
      ],
      DIFF,
    );

    expect(piped.code).toBe(fromFile.code);
    expect(piped.code).toBe(EXIT_CODES.approve);
    expect(piped.reads).toBe(1);
    // Field for field, identifiers and timestamps aside: the same verdict, the
    // same coverage, the same head commit (the digest of the diff, which is
    // the same diff), the same checks.
    const artifact = JSON.parse(piped.out) as Record<string, unknown>;
    expect(stable(artifact)).toEqual(stable(JSON.parse(fromFile.out)));
    expect(artifact.decision).toBe("approve");
    // The identifiers are excluded above because they are the fields allowed to
    // differ, not because they do: a review id is a digest of what was
    // reviewed, and with the clock pinned these two runs earn the same one.
    // Asserted rather than left implied — an id that stopped being a function
    // of the inputs is worth finding out about here.
    expect(artifact.review_id).toBe(
      (JSON.parse(fromFile.out) as Record<string, unknown>).review_id,
    );
  });

  it("puts the verdict on stdout alone, with the progress on stderr", async () => {
    const piped = await review(
      ["--contract", "contract.json", "--diff", "-", "--checks", "checks.json", "--repo", "repo"],
      DIFF,
    );

    // The whole of stdout parses as the artifact: a stream carrying the piped
    // diff back, or a line of progress, would not.
    expect(() => JSON.parse(piped.out)).not.toThrow();
    expect(piped.out).not.toContain("diff --git");
    expect(piped.err).not.toContain("\"decision\"");
    expect(piped.turns).toBe(1);
  });
});

describe("the check results on standard input", () => {
  it("reviews the piped check results exactly as it reviews the same file", async () => {
    const fromFile = await review([
      "--contract",
      "contract.json",
      "--diff",
      "change.diff",
      "--checks",
      "checks.json",
      "--repo",
      "repo",
    ]);
    const piped = await review(
      ["--contract", "contract.json", "--diff", "change.diff", "--checks", "-", "--repo", "repo"],
      `${JSON.stringify(checks)}\n`,
    );

    expect(piped.code).toBe(EXIT_CODES.approve);
    expect(piped.reads).toBe(1);
    const artifact = JSON.parse(piped.out) as Record<string, unknown>;
    expect(stable(artifact)).toEqual(stable(JSON.parse(fromFile.out)));
    // The check the reviewer was told about is the piped one, and it outranks
    // the model the same way it does from a file.
    expect(artifact.checks).toEqual(JSON.parse(fromFile.out).checks);
  });

  it("refuses check results that are not a CheckResult list, naming standard input", async () => {
    const piped = await review(
      ["--contract", "contract.json", "--diff", "change.diff", "--checks", "-", "--repo", "repo"],
      `{"check_id":"check_ut"}\n`,
    );

    expect(piped.code).toBe(EXIT_CODES.usage_or_input_error);
    expect(piped.err).toContain("standard input is not a valid CheckResult list");
    expect(piped.models).toBe(0);
  });
});

describe("the rule that only one of the two may read standard input", () => {
  it("refuses --diff - beside --checks - before anything is read or spent", async () => {
    const both = await review(
      ["--contract", "contract.json", "--diff", "-", "--checks", "-", "--repo", "repo"],
      DIFF,
    );

    expect(both.code).toBe(EXIT_CODES.usage_or_input_error);
    expect(both.err).toContain("one of the two may read standard input, not both");
    // Nothing was read from the stream — the diff is still there for the
    // corrected invocation — and no reviewer was ever built, so nothing was
    // spent on a run that was going to be refused.
    expect(both.reads).toBe(0);
    expect(both.models).toBe(0);
    expect(both.turns).toBe(0);
    expect(both.out).toBe("");
  });
});

describe("an empty standard input", () => {
  it("refuses --diff - with nothing piped in, before any model call", async () => {
    const empty = await review(
      ["--contract", "contract.json", "--diff", "-", "--checks", "checks.json", "--repo", "repo"],
      "",
    );

    expect(empty.code).toBe(EXIT_CODES.usage_or_input_error);
    expect(empty.err).toContain("empty diff");
    expect(empty.models).toBe(0);
    expect(empty.turns).toBe(0);
    expect(empty.out).toBe("");
  });

  it("refuses whitespace as a diff too, which is what an empty range pipes", async () => {
    const blank = await review(
      ["--contract", "contract.json", "--diff", "-", "--checks", "checks.json", "--repo", "repo"],
      "\n\n",
    );

    expect(blank.code).toBe(EXIT_CODES.usage_or_input_error);
    expect(blank.err).toContain("empty diff");
    expect(blank.models).toBe(0);
  });

  it("refuses --checks - with nothing piped in, before any model call", async () => {
    const empty = await review(
      ["--contract", "contract.json", "--diff", "change.diff", "--checks", "-", "--repo", "repo"],
      "",
    );

    expect(empty.code).toBe(EXIT_CODES.usage_or_input_error);
    expect(empty.err).toContain("read nothing from standard input");
    expect(empty.models).toBe(0);
  });
});

/** The help is where a person finds out that `-` is a value these two flags take. */
describe("what the help says about standard input", () => {
  it("offers the piped form and states the rule", () => {
    const flat = USAGE.replace(/\\/g, "").replace(/\s+/g, " ");
    expect(flat).toContain("--diff -");
    expect(flat).toContain("`-` reads it from standard input");
    expect(flat).toContain("one of the two may read standard input, not both");
  });
});
