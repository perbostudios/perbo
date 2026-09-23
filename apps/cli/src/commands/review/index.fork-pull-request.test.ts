import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Model } from "@perbo/model";
import { parseReviewArgs } from "./internal/args.js";
import { runReviewCommand } from "./index.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * `perbo review --pr` on a pull request opened from a fork (SCP-211).
 *
 * A pull request from a fork has its head commit in the fork, not in the
 * repository the pull request is open on, and reading it as though it were in
 * the base repository is how a review ends up pinned to a commit nobody can
 * fetch. What is asserted here is where the read went — the fork `gh` named,
 * and not the base repository — what the review target then carries, and that
 * a fork which cannot answer for its head stops the run before a reviewer is
 * ever built.
 *
 * The `gh` is a script, as in index.ticketless.test.ts: the argv, the JSON
 * parsing and the failure handling are the shipped ones, and every invocation
 * is logged, so "fetched from the fork" is a line in a log rather than a claim
 * about a mock.
 *
 * Fail-first, measured (2026-09-05): with `apps/cli/src/pull-request.ts` and
 * `apps/cli/src/commands/review/ticketless.ts` put back to 98b3f6d and this
 * file left in place,
 * the eight tests below fail — `pr view` asks for no head repository, no `api`
 * call is ever made, `head_repository` and `head_lookup` are not on the target
 * (the bundle's schema is strict, so a run that produced them would refuse),
 * and neither refusal happens: the unfetchable fork and the deleted one are
 * both reviewed and paid for.
 *
 * Every case spawns the `gh` script for real, so each carries an explicit
 * timeout (SCP-246, in SCP-191's style) rather than vitest's five-second
 * default: on a machine also running gates and mutant attempts, that work can
 * outrun five seconds on its own.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-fork-pr-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * SCP-200 asks whether a credential answers before the pull request is read,
 * and a token in the environment is that answer without `gh` being asked. The
 * `gh` calls below are counted, so the question is put to the replay binary on
 * every machine — and the environment is put back afterwards, because it
 * belongs to whoever ran the suite.
 */
const tokens: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    tokens[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(tokens)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * A `gh` that replays one pull request and logs every invocation.
 *
 * `auth status`, `pr view` and `pr diff` answer; `api` answers with `apiExit`,
 * which is how a fork that has gone private, been deleted or been force-pushed
 * past its head commit is played here. Anything else exits 1: a run that tried
 * to comment, review, merge or push would fail rather than pass quietly.
 */
function replayGh(
  name: string,
  view: unknown,
  options: { diff?: string; apiExit?: number; apiStderr?: string } = {},
): { binary: string; log: string } {
  const dir = mkdtempSync(join(scratch, `gh-${name}-`));
  const log = join(dir, "invocations.log");
  writeFileSync(join(dir, "view.json"), JSON.stringify(view));
  writeFileSync(join(dir, "change.diff"), options.diff ?? CHANGE);
  const apiExit = options.apiExit ?? 0;
  const apiStderr = options.apiStderr ?? "";
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat ${JSON.stringify(join(dir, "view.json"))}; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then cat ${JSON.stringify(join(dir, "change.diff"))}; exit 0; fi
if [ "$1" = "api" ]; then printf '%s' ${JSON.stringify(apiStderr)} >&2; exit ${apiExit}; fi
echo "refused: this gh replays reads only, got: $*" >&2
exit 1
`;
  const binary = join(dir, "gh");
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return { binary, log };
}

const ghInvocations = (log: string): string[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
    : [];

/** A repository with nothing in it, and above all no ticket store. */
function emptyRepo(name: string): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), "export const page = 25;\n");
  return dir;
}

const CHANGE = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,1 +1,1 @@
-export const page = 0;
+export const page = 25;
`;

const HEAD_OID = "5f7e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f";
const BASE_OID = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";

/** The pull request every test here reads, with its head repository varied. */
const pullRequest = (head: Record<string, unknown>): Record<string, unknown> => ({
  number: 41,
  title: "Paginate the search results",
  body: "Search results are paginated at twenty-five hits a page.",
  url: "https://github.com/octo/search/pull/41",
  headRefName: "paginate",
  baseRefName: "main",
  headRefOid: HEAD_OID,
  baseRefOid: BASE_OID,
  ...head,
});

/**
 * A reviewer that answers about the outcome and nothing else — these pull
 * requests state no acceptance criteria, so `ac_outcome` is the whole plan —
 * and a count of how many times it was asked anything, which is what the two
 * refusals are measured by.
 */
function countingModel(): Model & { built: number; turns: number } {
  const model = {
    provider: "double",
    model_id: "scripted",
    built: 0,
    turns: 0,
    async turn() {
      model.turns += 1;
      return {
        toolCalls: [
          {
            id: "t1",
            name: "submit_review",
            input: {
              coverage: [
                {
                  criterion_id: "ac_outcome",
                  status: "met",
                  verification_strength: "directly_verified",
                  evidence_type: "test_result",
                  evidence_ref: null,
                  evidence_assertion: "expect(page).toBe(25)",
                  evidence_file: "src/index.ts",
                  evidence_line: 1,
                  evidence_symbol: null,
                  note: null,
                },
              ],
              findings: [],
              check_assertions: [],
              overall_confidence: 0.8,
            },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: "tool_use" as const,
      };
    },
  };
  return model as unknown as Model & { built: number; turns: number };
}

interface Ran {
  out: string;
  err: string;
  code: number;
}

async function review(
  argv: string[],
  options: { cwd: string; gh: string; model: Model & { built: number; turns: number } },
): Promise<Ran> {
  const streams = recordStreams();
  const code = await runReviewCommand({
    args: parseReviewArgs(argv),
    streams,
    cwd: options.cwd,
    now: new Date("2026-09-05T09:00:00Z"),
    gh: { binary: options.gh },
    makeModel: () => {
      options.model.built += 1;
      return options.model;
    },
  });
  return { out: streams.out(), err: streams.err(), code };
}

/** The one bundle in `<repo>/.perbo/reviews`, parsed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- read back as JSON, as a person reads it
function storedBundle(repo: string): Record<string, any> {
  const dir = join(repo, ".perbo", "reviews");
  const files = readdirSync(dir).filter((name) => name.endsWith(".review.json"));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
}

describe("the head of a fork pull request is read from the fork", () => {
  it("fetches the head commit from headRepository.nameWithOwner, not from the base repository", async () => {
    const repo = emptyRepo("fork");
    const { binary, log } = replayGh(
      "fork",
      pullRequest({ headRepository: { nameWithOwner: "contributor/search", name: "search" } }),
    );
    const model = countingModel();

    const ran = await review(["--pr", "octo/search#41", "--repo", repo], {
      cwd: repo,
      gh: binary,
      model,
    });

    expect(ran.code).toBe(0);
    const invocations = ghInvocations(log);

    // The head commit was asked for, and it was asked of the fork.
    expect(invocations).toContain(`api repos/contributor/search/commits/${HEAD_OID} --silent`);
    expect(invocations.some((call) => call.startsWith("api repos/octo/search/commits"))).toBe(false);

    // The pull request itself is still read from the repository it is open on:
    // that is where the pull request is, and the fork is only where its head is.
    expect(invocations).toContain("pr diff 41 --repo octo/search");
    expect(invocations.some((call) => call.startsWith("pr view 41 --repo octo/search"))).toBe(true);

    // And the head repository was asked for in the view that named it.
    const view = invocations.find((call) => call.startsWith("pr view"))!;
    expect(view).toContain("headRepository");

    const bundle = storedBundle(repo);
    expect(bundle.target.head_repository).toBe("contributor/search");
    expect(bundle.target.head_lookup).toBe("fork");
    expect(bundle.target.head_commit).toBe(HEAD_OID);
    expect(bundle.target.base_commit).toBe(BASE_OID);

    // The person watching is told which repository the head came from.
    expect(ran.err).toContain("read from the fork contributor/search");
  }, 30_000);

  /**
   * The head repository is `{id, name}` on a `gh` that does not offer
   * `nameWithOwner`, and the owner is a field of its own. One `owner/name`
   * comes out of either shape — otherwise this reads every pull request such a
   * `gh` describes as though its head were in the base repository.
   */
  it("composes owner/name where gh names the owner separately", async () => {
    const repo = emptyRepo("fork-composed");
    const { binary, log } = replayGh(
      "fork-composed",
      pullRequest({
        headRepository: { id: "R_1", name: "search" },
        headRepositoryOwner: { login: "contributor" },
      }),
    );
    const model = countingModel();

    const ran = await review(["--pr", "octo/search#41", "--repo", repo], {
      cwd: repo,
      gh: binary,
      model,
    });

    expect(ran.code).toBe(0);
    expect(ghInvocations(log)).toContain(
      `api repos/contributor/search/commits/${HEAD_OID} --silent`,
    );
    const bundle = storedBundle(repo);
    expect(bundle.target.head_repository).toBe("contributor/search");
    expect(bundle.target.head_lookup).toBe("fork");
  }, 30_000);
});

describe("a pull request whose head is a branch of the repository it is open on", () => {
  it("resolves as it did before, and asks `gh` for nothing extra", async () => {
    const repo = emptyRepo("same-repository");
    const { binary, log } = replayGh(
      "same-repository",
      pullRequest({ headRepository: { nameWithOwner: "octo/search", name: "search" } }),
    );
    const model = countingModel();

    const ran = await review(["--pr", "octo/search#41", "--repo", repo], {
      cwd: repo,
      gh: binary,
      model,
    });

    expect(ran.code).toBe(0);
    // Three calls, the same three as before SCP-211: the credential question
    // and the two reads. No head is fetched, because the head is here.
    expect(ghInvocations(log)).toEqual([
      "auth status",
      "pr view 41 --repo octo/search --json number,title,body,url,headRefName,baseRefName,headRefOid,baseRefOid,headRepository,headRepositoryOwner",
      "pr diff 41 --repo octo/search",
    ]);

    const bundle = storedBundle(repo);
    expect(bundle.target.head_repository).toBe("octo/search");
    expect(bundle.target.head_lookup).toBe("same_repository");
    expect(bundle.target.head_commit).toBe(HEAD_OID);
    expect(bundle.target.base_commit).toBe(BASE_OID);
    expect(bundle.contract.reference).toBe("octo/search#41");
    expect(ran.err).not.toContain("read from the fork");
  }, 30_000);

  /** GitHub's names differ in case and not in identity: `Octo/Search` is here. */
  it("reads a differently-cased name as the same repository", async () => {
    const repo = emptyRepo("same-repository-case");
    const { binary, log } = replayGh(
      "same-repository-case",
      pullRequest({ headRepository: { nameWithOwner: "Octo/Search" } }),
    );
    const model = countingModel();

    await review(["--pr", "octo/search#41", "--repo", repo], { cwd: repo, gh: binary, model });

    expect(ghInvocations(log).some((call) => call.startsWith("api "))).toBe(false);
    expect(storedBundle(repo).target.head_lookup).toBe("same_repository");
    expect(storedBundle(repo).target.head_repository).toBe("Octo/Search");
  }, 30_000);

  /**
   * A `gh` that answered before this field was asked for — the recording in
   * `fixtures/` is one — reports no head repository at all. The pull request's
   * own repository is the head there, which is what this command assumed for
   * every pull request until now, and the class says which repository was read.
   */
  it("falls back to the pull request's own repository where gh reports none", async () => {
    const repo = emptyRepo("unreported");
    const { binary, log } = replayGh("unreported", pullRequest({}));
    const model = countingModel();

    const ran = await review(["--pr", "octo/search#41", "--repo", repo], {
      cwd: repo,
      gh: binary,
      model,
    });

    expect(ran.code).toBe(0);
    expect(ghInvocations(log).some((call) => call.startsWith("api "))).toBe(false);
    const bundle = storedBundle(repo);
    expect(bundle.target.head_repository).toBe("octo/search");
    expect(bundle.target.head_lookup).toBe("same_repository");
  }, 30_000);
});

describe("a fork whose head cannot be fetched is refused before anything is spent", () => {
  it("names the fork, calls no reviewer and writes no review", async () => {
    const repo = emptyRepo("fork-unfetchable");
    const { binary, log } = replayGh(
      "fork-unfetchable",
      pullRequest({ headRepository: { nameWithOwner: "contributor/search" } }),
      { apiExit: 1, apiStderr: "gh: Not Found (HTTP 404)\n" },
    );
    const model = countingModel();

    await expect(
      review(["--pr", "octo/search#41", "--repo", repo], { cwd: repo, gh: binary, model }),
    ).rejects.toThrow(/contributor\/search/);

    // Nothing was reviewed: the reviewer was never built, never asked a turn,
    // and no bundle claims a review happened.
    expect(model.built).toBe(0);
    expect(model.turns).toBe(0);
    expect(existsSync(join(repo, ".perbo"))).toBe(false);

    // And the refusal came before the diff was read, so the fork's failure
    // costs one read rather than two.
    const invocations = ghInvocations(log);
    expect(invocations.some((call) => call.startsWith("pr diff"))).toBe(false);
    expect(invocations).toContain(`api repos/contributor/search/commits/${HEAD_OID} --silent`);
  }, 30_000);

  it("says what gh said and which commit could not be fetched", async () => {
    const repo = emptyRepo("fork-unfetchable-reason");
    const { binary } = replayGh(
      "fork-unfetchable-reason",
      pullRequest({ headRepository: { nameWithOwner: "contributor/search" } }),
      { apiExit: 1, apiStderr: "gh: Not Found (HTTP 404)\n" },
    );
    const model = countingModel();

    await expect(
      review(["--pr", "octo/search#41", "--repo", repo], { cwd: repo, gh: binary, model }),
    ).rejects.toThrow(new RegExp(`${HEAD_OID}[\\s\\S]*Not Found`));
  }, 30_000);

  /**
   * GitHub answers with a null head repository where the fork a pull request
   * came from has been deleted. There is nowhere left to fetch its head commit
   * from, and pinning a review to a commit nobody can get is the thing this
   * refusal exists to prevent.
   */
  it("refuses a pull request whose head repository has been deleted", async () => {
    const repo = emptyRepo("fork-deleted");
    const { binary, log } = replayGh("fork-deleted", pullRequest({ headRepository: null }));
    const model = countingModel();

    await expect(
      review(["--pr", "octo/search#41", "--repo", repo], { cwd: repo, gh: binary, model }),
    ).rejects.toThrow(/no longer exists/);

    expect(model.built).toBe(0);
    expect(model.turns).toBe(0);
    expect(existsSync(join(repo, ".perbo"))).toBe(false);
    expect(ghInvocations(log).some((call) => call.startsWith("pr diff"))).toBe(false);
  }, 30_000);
});
