import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admittedSpecFiles } from "@perbo/contracts";
import {
  SUBMIT_REVIEW_TOOL,
  type Model,
  type ModelRequest,
  type ModelTurn,
} from "@perbo/model";
import { commitSpec } from "@perbo/runner";
import { UsageError } from "../../usage-error.js";
import { admitCommandLine, approveCommandLine } from "../admit.js";
import type { Streams } from "../../streams.js";
import { TICKET_RUNS } from "./index.js";
import { buildInspectReport, renderInspect, type InspectReport } from "../inspect.js";
import { runIndexCommand } from "../symbol-index.js";
import { readTicket, storeDir } from "../../store/tickets.js";
import { runCommandLine } from "../../command-line/terminal.js";

/**
 * What a stale spec does to the ticket it was drafted for (D-103), over a real
 * store built by `perbo admit --from-spec` and `perbo approve`.
 *
 * Two halves that have to come out differently. A run starting a ticket that
 * has not started refuses and leaves the ticket at `plan_invalid`; a ticket
 * whose run is already in flight is shown the flag by `perbo inspect` and
 * moved nowhere. Only the drafting model is a double: every ticket file, spec
 * and symbol index here is the real thing on disk.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-spec-stale-ticket-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/**
 * What the one case below gets: it builds a checkout, a worktree and a real
 * spec commit, which is already close to vitest's 5s default unloaded and
 * over it under load. The runner's own spawn-heavy tests keep the same
 * constant (`packages/runner/test/support.ts`).
 */
const CHECKOUT_TEST_TIMEOUT_MS = 30_000;

const SPEC = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues one email through @sendActivation.
- R2: A duplicate signup inside five minutes queues nothing.

## No-Gos

- Nothing is sent to an address that has unsubscribed.

## Notes

The queue package already has a sender.
`;

let repos = 0;

function repository(spec = SPEC): { repo: string; specPath: string } {
  const repo = join(scratch, `repo-${repos++}`);
  mkdirSync(join(repo, "specs", "activation-email"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitIdentity });
  const specPath = join(repo, "specs", "activation-email", "spec.md");
  writeFileSync(specPath, spec);
  mkdirSync(join(repo, "packages", "queue"), { recursive: true });
  writeFileSync(
    join(repo, "packages", "queue", "send.ts"),
    "export function sendActivation(): number {\n  return 1;\n}\n",
  );
  execFileSync("git", ["-C", repo, "add", "-A"], { env: gitIdentity });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { env: gitIdentity });
  runIndexCommand({ argv: ["--repo", repo], streams: capture(), cwd: repo });
  return { repo, specPath };
}

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (chunk: string) => out.push(chunk),
    stderr: (chunk: string) => err.push(chunk),
    isTTY: false,
  };
}

/** The drafter, scripted: one turn, one `submit_review` call, no provider. */
function scripted(draft: unknown): Model {
  let turn = 0;
  return {
    provider: "double",
    model_id: "scripted",
    async turn(_request: ModelRequest): Promise<ModelTurn> {
      const calls = turn === 0 ? [{ id: "t0", name: SUBMIT_REVIEW_TOOL, input: draft }] : [];
      turn += 1;
      return {
        toolCalls: calls,
        usage: {
          input_tokens: 800,
          output_tokens: 150,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}

const DRAFT = {
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  acceptance_criteria: [
    {
      text: "A signup POST queues one activation email.",
      assertion: "one message is on the queue after a single signup",
      kind: "test",
      requirement_id: "R1",
    },
    {
      text: "A duplicate signup inside five minutes queues nothing.",
      assertion: "a second signup inside the window queues nothing",
      kind: "test",
      requirement_id: "R2",
    },
  ],
  proposed_scope: { paths_allowed: ["packages/queue/**"], paths_prohibited_extra: [] },
  rationale: "Both requirements are about the queue.",
  depends_on: [],
};

const hashOf = (path: string): string =>
  `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

/** A repository with `PRB-1` admitted from its spec and nothing more: a ticket at `plan_review`. */
async function admitted(spec = SPEC): Promise<{ repo: string; specPath: string; dir: string }> {
  const { repo, specPath } = repository(spec);
  const code = await runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath], streams: capture(), cwd: repo, deps: { model: scripted(DRAFT) } });
  expect(code).toBe(0);
  const dir = storeDir(repo, null);
  expect(readTicket(dir, "PRB-1").state).toBe("plan_review");
  return { repo, specPath, dir };
}

/** A repository with `PRB-1` admitted from its spec and approved: a ticket at `ready`. */
async function approved(spec = SPEC): Promise<{ repo: string; specPath: string; dir: string }> {
  const { repo, specPath, dir } = await admitted(spec);
  expect(runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);
  expect(readTicket(dir, "PRB-1").state).toBe("ready");
  return { repo, specPath, dir };
}

/** The same, for work admitted from the command line: a ticket at `ready` with no spec. */
async function ticketless(): Promise<{ repo: string; dir: string }> {
  const { repo } = repository();
  const code = await runCommandLine(admitCommandLine, { argv: [
      "--repo",
      repo,
      "--outcome",
      "New users receive an activation email.",
      "--criterion",
      "A signup queues one email :: one message is on the queue",
      "--path",
      "packages/queue/**",
    ], streams: capture(), cwd: repo, deps: { model: scripted(DRAFT) } });
  expect(code).toBe(0);
  expect(runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);
  return { repo, dir: storeDir(repo, null) };
}

const work = (repo: string) => TICKET_RUNS.load({ cwd: repo, repo, store: null, key: "PRB-1" });

/** The least a report can be, for the one assertion that is about the rendering alone. */
const EMPTY_REPORT: InspectReport = {
  kind: "ticket",
  ticket: "PRB-1",
  ticket_id: "ticket_01abcdef",
  outcome: "New users receive an activation email.",
  contract_source: null,
  refusal: null,
  state: "ready",
  pull_request_url: null,
  handed_off: null,
  base: null,
  delivery_checks: null,
  admission: null,
  source: null,
  queue: null,
  spec_staleness: null,
  runs_started: 0,
  nodes: null,
  edges: null,
  approach_problem: null,
  size: null,
  attempts_path: "",
  attempts: [],
  total_cost: { micros: 0, components: 0, priced: 0, reported: 0, estimated: 0, unavailable: 0, partial: 0 },
  verdicts: [],
};

describe("a run starting a ticket that has not started", () => {
  it("takes it to plan_invalid where the spec has been edited since approval", async () => {
    const { repo, specPath, dir } = await approved();
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const loaded = work(repo);
    expect(() => TICKET_RUNS.starting(loaded, false)).toThrow(UsageError);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("plan_invalid");
    expect(ticket.history.at(-1)).toMatchObject({ from: "ready", to: "plan_invalid" });
    expect(ticket.history.at(-1)?.note).toContain("has been edited since the contract was approved from it");
  });

  /**
   * The ordinary path, which admission's own hash would call stale.
   *
   * Between admitting and approving, the ticket sits in `plan_review` and a
   * person reads the draft — which is exactly when they notice the spec needs a
   * word changed. D-103 says a spec edited **after approval** is stale, so an
   * edit made here is not one, and a run must start. Judging against the hash
   * admission took when it drafted would land the first run of an ordinary
   * ticket at `plan_invalid`, which has no row out: re-drafting refuses there,
   * because an approved contract is immutable.
   */
  it("starts where the spec was edited while the draft was being read, before approval", async () => {
    const { repo, specPath } = repository(SPEC);
    expect(
      await runCommandLine(admitCommandLine, { argv: ["--repo", repo, "--from-spec", specPath], streams: capture(), cwd: repo, deps: { model: scripted(DRAFT) } }),
    ).toBe(0);
    const dir = storeDir(repo, null);
    expect(readTicket(dir, "PRB-1").state).toBe("plan_review");

    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    expect(runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);
    expect(readTicket(dir, "PRB-1").state).toBe("ready");

    // The run starts, and the record says the spec it was approved from.
    expect(() => TICKET_RUNS.starting(work(repo), false)).not.toThrow();
    expect(readTicket(dir, "PRB-1").state).not.toBe("plan_invalid");

    // And an edit made *after* approval is still stale, so the rule moved
    // rather than went away.
    writeFileSync(specPath, SPEC.replace("60 seconds", "30 seconds"));
    expect(() => TICKET_RUNS.starting(work(repo), false)).toThrow(UsageError);
    expect(readTicket(dir, "PRB-1").state).toBe("plan_invalid");
  });

  /**
   * The ordinary path one step further: the loop's own spec commit judges
   * each file against the record `run/index.ts` hands it — `admittedSpecFiles`
   * over `admission.spec` — the same list `runConfig` and `loop.ts` reach. A
   * ticket edited in `plan_review` must clear that check too, and the file it
   * commits for `spec.md` must be the bytes approval read, not admission's.
   */
  it(
    "commits the spec the loop is fed after an edit made while the draft was being read",
    async () => {
      const { repo, specPath, dir } = await admitted();
      // Repository-local identity, so the commit `commitSpec` makes below does
      // not depend on this machine's global Git configuration — and does not
      // hang on a machine that signs commits with a key this process cannot
      // unlock.
      execFileSync("git", ["-C", repo, "config", "user.name", "t"], { env: gitIdentity });
      execFileSync("git", ["-C", repo, "config", "user.email", "t@t.invalid"], { env: gitIdentity });
      execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"], { env: gitIdentity });

      writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
      expect(runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);

      const spec = readTicket(dir, "PRB-1").admission.spec;
      if (spec === null) throw new Error("PRB-1 was admitted from a spec and should carry one");
      const files = admittedSpecFiles(spec);

      // A worktree at the commit the ticket's branch would be built from —
      // the checkout's `HEAD`, since nothing here has moved it — carrying
      // none of the bytes `files` names yet.
      const baseCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
        env: gitIdentity,
      }).trim();
      const worktree = join(scratch, `worktree-${repos}`);
      execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, baseCommit], {
        env: gitIdentity,
      });

      const result = await commitSpec({
        worktree,
        repository_root: repo,
        base_commit: baseCommit,
        ticket_key: "PRB-1",
        attempt_id: "attempt_test0",
        files,
        recorded: null,
      });

      expect(result.commit).not.toBeNull();
      expect(files.find((file) => file.path === spec.path)?.content_sha256).toBe(spec.content_sha256);
    },
    CHECKOUT_TEST_TIMEOUT_MS,
  );

  it("takes it to plan_invalid where the spec names an export the repository no longer has", async () => {
    const { repo, dir } = await approved();
    writeFileSync(
      join(repo, "packages", "queue", "send.ts"),
      "export function send(): number {\n  return 1;\n}\n",
    );
    execFileSync("git", ["-C", repo, "commit", "-qam", "rename the sender"], { env: gitIdentity });
    runIndexCommand({ argv: ["--repo", repo], streams: capture(), cwd: repo });
    expect(() => TICKET_RUNS.starting(work(repo), false)).toThrow(/@sendActivation/);
    expect(readTicket(dir, "PRB-1").state).toBe("plan_invalid");
  });

  it("takes a ticket that ran and failed there too, through the row a new attempt takes", async () => {
    const { repo, specPath, dir } = await approved();
    // A ticket an earlier attempt left `failed` has not started *this* run, so
    // it stops here as well — reopened for the attempt it never gets.
    const path = join(dir, "tickets", "PRB-1.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify(
        {
          ...stored,
          state: "failed",
          history: [
            ...(stored["history"] as unknown[]),
            { at: "2026-09-14T00:00:00.000Z", from: "ready", to: "provisioning", note: "run started" },
            { at: "2026-09-14T00:00:01.000Z", from: "provisioning", to: "failed", note: "nothing changed" },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    expect(() => TICKET_RUNS.starting(work(repo), false)).toThrow(UsageError);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("plan_invalid");
    expect(ticket.history.slice(-2).map((row) => `${row.from}->${row.to}`)).toEqual([
      "failed->ready",
      "ready->plan_invalid",
    ]);
  });

  it("starts a ticket whose spec has not moved, and says what it could not judge", async () => {
    const { repo, dir } = await approved();
    const started = TICKET_RUNS.starting(work(repo), false);
    expect(started).toBe(1);
    expect(readTicket(dir, "PRB-1").state).toBe("provisioning");
  });

  it("starts a ticket whose spec names the work it is for", async () => {
    // The reason a baseline exists, at the level a person meets it. Nearly
    // every spec names code the ticket is about to write, and asking only
    // whether those names resolve refuses the ticket's very first run and
    // leaves it at `plan_invalid`, which has no row out and which
    // `admit --start-over` refuses. Approval records what the repository had;
    // a name it never had is the work, and the work is not a stale spec.
    const { repo, dir } = await approved(
      SPEC.replace(
        "- R2: A duplicate signup inside five minutes queues nothing.",
        "- R2: A new policy module at `packages/queue/retry-policy.ts` holds the backoff,\n" +
          "  exporting @retryWithBackoff.",
      ),
    );
    const spec = readTicket(dir, "PRB-1").admission.spec;
    expect(spec?.names_that_resolved).toEqual(["@sendActivation"]);
    expect(TICKET_RUNS.starting(work(repo), false)).toBe(1);
    expect(readTicket(dir, "PRB-1").state).toBe("provisioning");
  });

  it("judges no name on a ticket approved before the baseline was recorded", async () => {
    // A store outlives the version that wrote it. Such a ticket's spec has no
    // baseline to measure a name against, so its names are said and not acted
    // on — and its bytes are judged as they always were.
    const { repo, dir } = await approved();
    const path = join(dir, "tickets", "PRB-1.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { admission: { spec: unknown } };
    const spec = stored.admission.spec as Record<string, unknown>;
    delete spec["names_that_resolved"];
    writeFileSync(path, JSON.stringify(stored, null, 2));
    // The export the spec names is gone, committed and reindexed: stale under
    // a baseline, and unjudgeable without one.
    writeFileSync(
      join(repo, "packages", "queue", "send.ts"),
      "export function send(): number {\n  return 1;\n}\n",
    );
    execFileSync("git", ["-C", repo, "commit", "-qam", "rename the sender"], { env: gitIdentity });
    runIndexCommand({ argv: ["--repo", repo], streams: capture(), cwd: repo });

    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    });
    try {
      expect(TICKET_RUNS.starting(work(repo), false)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(readTicket(dir, "PRB-1").state).toBe("provisioning");
    expect(said.join("")).toContain("approved before the names it carries were recorded");
  });

  it("says nothing at all about a spec for a ticket that was not drafted from one", async () => {
    // There is no reading to warn about, and a run must not open with a
    // warning naming a spec the ticket does not have.
    const { repo, dir } = await ticketless();
    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    });
    try {
      expect(TICKET_RUNS.starting(work(repo), false)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(readTicket(dir, "PRB-1").state).toBe("provisioning");
    expect(said.join("")).not.toContain("is not fully checked");
  });

  it("does not refuse a run over a name it could not judge, and says so on stderr", async () => {
    const { repo, dir } = await approved();
    // No index for this checkout, so nothing can say whether @sendActivation is
    // still exported. An unjudged name is not evidence and must not stop a run
    // — but a run whose spec was only half checked has to say which half.
    rmSync(join(repo, ".perbo", "index.json"));
    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    });
    try {
      expect(TICKET_RUNS.starting(work(repo), false)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(readTicket(dir, "PRB-1").state).toBe("provisioning");
    expect(said.join("")).toContain("PRB-1's spec is not fully checked");
    expect(said.join("")).toContain("build it with perbo index");
  });
});

describe("what approval records about the spec", () => {
  it("records the symbol half where the checkout was clean at approval", async () => {
    const { dir } = await approved();
    const spec = readTicket(dir, "PRB-1").admission.spec;
    expect(spec?.names_that_resolved).toEqual(["@sendActivation"]);
    expect(spec?.symbols_judged_at_approval).toBe(true);

    // And the reading a person sees names the moment it is current since. The
    // spec was not edited here, but on the ordinary path it is — in
    // `plan_review`, before approval — and "unedited since admission" over
    // that ticket is a sentence about a moment nothing was judged against.
    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.spec_staleness).toEqual({
      path: "specs/activation-email/spec.md",
      judged_against: "approval",
      stale: [],
      unjudged: [],
    });
    expect(renderInspect(report, { color: false, detail: false, version: "0.0.0" })).toContain(
      "unedited since approval, and every name in it is still here",
    );
  });

  it("records no symbol where the index could not be believed, and every reading says so", async () => {
    // The path this whole rule exists to support, landing in the gap it left.
    // Editing the spec while reading the draft is the ordinary thing to do in
    // `plan_review` — and the spec is a tracked file, so the checkout is then
    // dirty and the index is not evidence about it. No `@Symbol` reaches the
    // baseline, and without the flag beside it nothing afterwards could tell
    // that from a spec whose symbols this repository never had: `inspect`
    // would print "every name in it is still here" over a name that had gone.
    const { repo, specPath, dir } = await admitted();
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    expect(runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);
    const spec = readTicket(dir, "PRB-1").admission.spec;
    expect(spec?.names_that_resolved).toEqual([]);
    expect(spec?.symbols_judged_at_approval).toBe(false);

    // The export the spec names goes, committed and reindexed: without the
    // flag above, this reading would come back silent instead of unjudged.
    writeFileSync(
      join(repo, "packages", "queue", "send.ts"),
      "export function send(): number {\n  return 1;\n}\n",
    );
    execFileSync("git", ["-C", repo, "commit", "-qam", "rename the sender"], { env: gitIdentity });
    runIndexCommand({ argv: ["--repo", repo], streams: capture(), cwd: repo });

    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.spec_staleness?.stale).toEqual([]);
    expect(report.spec_staleness?.unjudged).toHaveLength(1);
    expect(report.spec_staleness?.unjudged[0]).toContain("@sendActivation");
    expect(report.spec_staleness?.unjudged[0]).toContain("perbo index");
    const printed = renderInspect(report, { color: false, detail: false, version: "0.0.0" });
    expect(printed).not.toContain("every name in it is still here");
    expect(printed).toContain("unjudged");
  });

  it("reads a ticket file written before the flag as one whose symbols were judged", async () => {
    // A store outlives the version that wrote it, and the version that wrote
    // such a file took the baseline exactly as this one does: what it recorded
    // was judged. Reading the absent key as "not judged" would turn the symbol
    // half off for every ticket already in every store.
    const { repo, dir } = await approved();
    const path = join(dir, "tickets", "PRB-1.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { admission: { spec: unknown } };
    const spec = stored.admission.spec as Record<string, unknown>;
    expect(spec["names_that_resolved"]).toEqual(["@sendActivation"]);
    delete spec["symbols_judged_at_approval"];
    writeFileSync(path, JSON.stringify(stored, null, 2));
    expect(readTicket(dir, "PRB-1").admission.spec?.symbols_judged_at_approval).toBe(true);

    writeFileSync(
      join(repo, "packages", "queue", "send.ts"),
      "export function send(): number {\n  return 1;\n}\n",
    );
    execFileSync("git", ["-C", repo, "commit", "-qam", "rename the sender"], { env: gitIdentity });
    runIndexCommand({ argv: ["--repo", repo], streams: capture(), cwd: repo });

    // Judged, so the lost name is stale and the run stops — the reading such a
    // ticket has always had, through the strict record and the loose one.
    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.spec_staleness?.unjudged).toEqual([]);
    expect(report.spec_staleness?.stale).toHaveLength(1);
    expect(() => TICKET_RUNS.starting(work(repo), false)).toThrow(/@sendActivation/);
    expect(readTicket(dir, "PRB-1").state).toBe("plan_invalid");
  });

  it("keeps admission's hash where approval could not read the spec", async () => {
    // Approval takes the hash from the bytes it reads, and a spec it cannot
    // read leaves admission's standing. Nothing else records one, so dropping
    // it would leave the record with no bytes at all to judge an edit against.
    const { repo, specPath, dir } = await admitted();
    const admissionHash = hashOf(specPath);
    // Unreadable as a file and still resolvable as a name: `realpath` answers
    // and `readFileSync` throws, which is the shape approval has to survive.
    rmSync(specPath);
    mkdirSync(specPath);
    expect(runCommandLine(approveCommandLine, { argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo })).toBe(0);
    rmSync(specPath, { recursive: true });
    writeFileSync(specPath, SPEC);

    expect(readTicket(dir, "PRB-1").admission.spec?.content_sha256).toBe(admissionHash);
    // And those are the bytes the reading is against: the spec is the one
    // admission read, so nothing is stale, and an edit from here is.
    const current = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(current.spec_staleness?.stale).toEqual([]);
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const edited = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(edited.spec_staleness?.stale).toHaveLength(1);
    expect(edited.spec_staleness?.stale[0]).toContain(admissionHash);
  });

  it("tells a ticket that was never approved which moment it is measured from", async () => {
    // `plan_review` is where a person reads the draft, and editing the spec
    // there is the ordinary thing to do. "Edited since the contract was
    // approved from it", and "admit this work again", name a moment that has
    // not happened and a remedy for a ticket they do not have.
    const { specPath, dir } = await admitted();
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.state).toBe("plan_review");
    expect(report.spec_staleness?.judged_against).toBe("admission");
    expect(report.spec_staleness?.stale[0]).toContain("has been edited since the contract was drafted from it");
    expect(report.spec_staleness?.stale[0]).not.toContain("approved from it");
    expect(report.spec_staleness?.unjudged[0]).not.toContain("admit this work again");
  });
});

describe("a ticket whose run is already in flight", () => {
  it("is shown the flag by inspect and left exactly where it is", async () => {
    const { specPath, dir } = await approved();
    // The state a run leaves a ticket in while its attempt is in flight. The
    // file is edited in place rather than rebuilt, so the repository root it
    // carries stays the one the store wrote.
    const path = join(dir, "tickets", "PRB-1.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify(
        {
          ...stored,
          state: "executing",
          history: [
            ...(stored["history"] as unknown[]),
            { at: "2026-09-14T00:00:00.000Z", from: "ready", to: "provisioning", note: "run started" },
            { at: "2026-09-14T00:00:01.000Z", from: "provisioning", to: "executing", note: "attempt started" },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(specPath, SPEC.replace("60 seconds", "45 seconds"));
    const before = readFileSync(path, "utf8");

    const report = buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null });
    expect(report.state).toBe("executing");
    expect(report.spec_staleness?.stale).toHaveLength(1);
    expect(report.spec_staleness?.stale[0]).toContain("has been edited since the contract was approved from it");
    expect(report.spec_staleness?.path).toBe("specs/activation-email/spec.md");
    // Nothing moved it, and nothing wrote the file at all.
    expect(readFileSync(path, "utf8")).toBe(before);

    // And it is a flag a person reads, not only a field in the JSON.
    const printed = renderInspect(report, { color: false, detail: false, version: "0.0.0" });
    expect(printed).toContain("SPEC");
    expect(printed).toContain("specs/activation-email/spec.md");
    expect(printed).toContain("stale");
    expect(printed).not.toContain("every name in it is still here");
  });

  it("says the spec is current where it is, naming the moment it is current since", () => {
    // Nothing distinguishes "checked, and still the spec" from "this build
    // does not check" unless the answer is printed either way — and "unedited
    // since admission" over an approved contract names the wrong moment, one
    // the spec has very likely been edited since and was never judged against.
    const current = (judged_against: "approval" | "admission"): string =>
      renderInspect(
        {
          ...EMPTY_REPORT,
          spec_staleness: { path: "specs/activation-email/spec.md", judged_against, stale: [], unjudged: [] },
        },
        { color: false, detail: false, version: "0.0.0" },
      );
    expect(current("approval")).toContain("unedited since approval, and every name in it is still here");
    expect(current("admission")).toContain("unedited since admission, and every name in it is still here");
  });

  it("does not call a spec current beside a reading it could not judge", () => {
    // "Every name in it is still here" printed directly above "not judged" is
    // the one sentence this section exists to keep off a person's screen: the
    // half that was checked is not the whole spec, and saying so is the point.
    const printed = renderInspect(
      {
        ...EMPTY_REPORT,
        spec_staleness: {
          path: "specs/activation-email/spec.md",
          judged_against: "approval",
          stale: [],
          unjudged: ["the symbol index was built at abc1234 and this checkout is at def5678"],
        },
      },
      { color: false, detail: false, version: "0.0.0" },
    );
    expect(printed).not.toContain("every name in it is still here");
    expect(printed).toContain("unjudged");
    expect(printed).toContain("the symbol index was built at abc1234 and this checkout is at def5678");
  });

  it("says nothing about a spec for a ticket that was not drafted from one", async () => {
    const { dir } = await ticketless();
    expect(buildInspectReport({ storeDirectory: dir, key: "PRB-1", attempt: null }).spec_staleness).toBeNull();
  });
});
