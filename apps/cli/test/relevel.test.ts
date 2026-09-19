import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { TicketRunConfigSchema } from "@perbo/runner";
import { UsageError } from "../src/args.js";
import { parseAdmitArgs, runAdmitCommand, type Streams } from "../src/admit.js";
import { TICKET_RUNS, parseExecuteArgs } from "../src/execute.js";
import { processDeps } from "../src/serve.js";
import { readTicket, storeDir as storeDirOf, writeTicket } from "../src/tickets.js";
import { TicketSchema, transition, withReconciliation } from "@perbo/contracts";
import { runListCommand, parseListArgs } from "../src/admit.js";
import { mergedTicketContext, ticketKeysMergedBetween } from "../src/relevel.js";
import { storeDir } from "../src/tickets.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./spawn-timeout.js";

/**
 * SCP-227: what a re-level's conflict round is briefed with, read from the
 * base's own history and the store's own contracts — never from anything a
 * model wrote.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-relevel-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" }).trim();

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (c) => out.push(c), stderr: (c) => err.push(c), isTTY: false };
}

function admitted(repo: string, outcome: string, path: string): string {
  const streams = capture();
  const code = runAdmitCommand({
    args: parseAdmitArgs([
      "--repo", repo,
      "--outcome", outcome,
      "--criterion", `${outcome} :: a test asserts it`,
      "--path", path,
      "--approve",
      "--json",
    ]),
    streams,
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error(streams.err.join(""));
  return (JSON.parse(streams.out.join("")) as { ticket: { key: string } }).ticket.key;
}

/** One commit on the current branch touching `path`. */
function commit(dir: string, path: string, message: string): string {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), `${message}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

describe("what merged under a branch", () => {
  it("reads the loop's own merge shapes out of the base's history, and nothing else", () => {
    const repo = join(scratch, "history");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "README.md", "base");
    const from = git(repo, "rev-parse", "HEAD");
    // The runner's own merge subject.
    git(repo, "checkout", "-q", "-b", "ayo/AYO-1/one");
    commit(repo, "one.md", "one");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "AYO-1: merge ayo/AYO-1/one into main\n\nAttempt: att_0000000000000001", "ayo/AYO-1/one");
    // A person's merge of the loop's pull request, which names the branch.
    git(repo, "checkout", "-q", "-b", "ayo/AYO-2/two");
    commit(repo, "two.md", "two");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #5 from lianmatsuo/ayo/AYO-2/two", "ayo/AYO-2/two");
    // A commit that mentions a key in prose is not a merge of that ticket's branch.
    commit(repo, "notes.md", "AYO-9 is mentioned here and ayo-9 is not a namespace");
    const to = git(repo, "rev-parse", "HEAD");
    return ticketKeysMergedBetween({ repository_root: repo, from, to }).then((keys) => {
      expect(keys).toEqual(["AYO-1", "AYO-2"]);
    });
  }, SPAWN_TEST_TIMEOUT_MS);

  it("reads a merge of an prb/ branch the way it reads an ayo/ one, and no other namespace's", () => {
    const repo = join(scratch, "history-prb");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "README.md", "base");
    const from = git(repo, "rev-parse", "HEAD");
    // A person's merge of the loop's pull request, which names the branch.
    git(repo, "checkout", "-q", "-b", "prb/PRB-3/three");
    commit(repo, "three.md", "three");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #7 from lianmatsuo/prb/PRB-3/three", "prb/PRB-3/three");
    // The same shape under a namespace the loop does not own is not the loop's merge.
    git(repo, "checkout", "-q", "-b", "feature/PRB-4/four");
    commit(repo, "four.md", "four");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #8 from lianmatsuo/feature/PRB-4/four", "feature/PRB-4/four");
    const to = git(repo, "rev-parse", "HEAD");
    return ticketKeysMergedBetween({ repository_root: repo, from, to }).then((keys) => {
      expect(keys).toEqual(["PRB-3"]);
    });
  }, SPAWN_TEST_TIMEOUT_MS);

  it("briefs with the store's approved contracts for those keys, never the branch's own", async () => {
    const repo = join(scratch, "context");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "README.md", "base");
    mkdirSync(join(repo, ".perbo"), { recursive: true });
    writeFileSync(join(repo, ".perbo", "config.json"), JSON.stringify({ base_ref: "main" }));
    const one = admitted(repo, "One is done.", "one/**");
    const two = admitted(repo, "Two is done.", "two/**");
    const mine = admitted(repo, "Mine is done.", "mine/**");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "admit");
    // My branch, cut here; then the other two merge into main after it.
    git(repo, "branch", `ayo/${mine}/mine`);
    for (const [key, dir] of [[one, "one"], [two, "two"]] as const) {
      git(repo, "checkout", "-q", "-b", `ayo/${key}/${dir}`);
      commit(repo, `${dir}/file.md`, dir);
      git(repo, "checkout", "-q", "main");
      git(repo, "merge", "-q", "--no-ff", "-m", `${key}: merge ayo/${key}/${dir} into main\n\nAttempt: att_x`, `ayo/${key}/${dir}`);
    }
    const context = await mergedTicketContext({
      dir: storeDir(repo),
      repository_root: repo,
      base_ref: "main",
      branch: `ayo/${mine}/mine`,
      except: mine,
    });
    expect(context).toEqual([
      { ticket_key: one, outcome: "One is done.", criteria: ["One is done. :: a test asserts it"], paths_allowed: ["one/**"] },
      { ticket_key: two, outcome: "Two is done.", criteria: ["Two is done. :: a test asserts it"], paths_allowed: ["two/**"] },
    ]);
    // A branch level with the base has nothing under it.
    expect(
      await mergedTicketContext({ dir: storeDir(repo), repository_root: repo, base_ref: "main", branch: "main", except: mine }),
    ).toEqual([]);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("the store's hooks for a re-level", () => {
  function admittedRepo(): { repo: string; key: string } {
    const repo = join(scratch, `hooks-${Math.random().toString(16).slice(2)}`);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "README.md", "base");
    mkdirSync(join(repo, ".perbo"), { recursive: true });
    writeFileSync(join(repo, ".perbo", "config.json"), JSON.stringify({ base_ref: "main" }));
    return { repo, key: admitted(repo, "Mine is done.", "mine/**") };
  }
  const toPrOpen = (repo: string, key: string) => {
    const dir = storeDirOf(repo);
    let ticket = readTicket(dir, key);
    for (const state of ["provisioning", "executing", "verifying", "independent_review", "pr_open"] as const) {
      ticket = transition(ticket, state, `walk to ${state}`);
    }
    writeTicket(dir, ticket);
    return ticket;
  };

  it("starts a re-level with no run count, on the loop's own open pull request only", () => {
    const { repo, key } = admittedRepo();
    const dir = storeDirOf(repo);
    const work = { dir, key, contract: undefined as never };
    expect(() => TICKET_RUNS.starting(work, true)).toThrow(/is ready; --relevel/);
    toPrOpen(repo, key);
    expect(TICKET_RUNS.starting(work, true)).toBeNull();
    // The ticket did not move.
    expect(readTicket(dir, key).state).toBe("pr_open");
    // A direct arm's pull request is not the loop's to re-level.
    const open = readTicket(dir, key);
    writeTicket(dir, TicketSchema.parse({ ...open, delivery: { ...open.delivery, arm: "direct" } }));
    expect(() => TICKET_RUNS.starting(work, true)).toThrow(/direct arm/);
    writeTicket(dir, TicketSchema.parse({ ...open, delivery: { ...open.delivery, opened_by: "hand_off" } }));
    expect(() => TICKET_RUNS.starting(work, true)).toThrow(/hand-off/);
  });

  it("hands a run the branch the ticket's delivery record names", () => {
    const { repo, key } = admittedRepo();
    const dir = storeDirOf(repo);
    const open = toPrOpen(repo, key);
    const recorded = `ayo/${open.ticket_id.replace("ticket_", "")}/mine-is-done`;
    writeTicket(dir, TicketSchema.parse({ ...open, delivery: { ...open.delivery, branch: recorded } }));
    const work = { dir, key, contract: undefined as never };
    expect(TicketRunConfigSchema.parse(TICKET_RUNS.runConfig(work, null, false)).delivery_branch).toBe(recorded);
  });

  it("keeps the delivery record's opener and arm when a re-level finishes", () => {
    const { repo, key } = admittedRepo();
    const dir = storeDirOf(repo);
    const open = toPrOpen(repo, key);
    const before = TicketSchema.parse({
      ...open,
      delivery: {
        ...open.delivery,
        branch: "ayo/x/y",
        pull_request_url: "https://example.invalid/pull/3",
        pull_request_number: 3,
        state: "open",
        opened_by: "loop",
        arm: "loop",
        observed_at: "2026-09-10T10:00:00.000Z",
        // What a sync had read, which a fresh delivery record would drop.
        mergeable: "mergeable",
        commits_outside_loop: false,
        github_credential: "gh_login",
      },
    });
    writeTicket(dir, before);
    const state = TICKET_RUNS.finished(
      { dir, key, contract: undefined as never },
      {
        workspace: { branch: "ayo/x/y" },
        pull_request: { url: "https://example.invalid/pull/3", number: 3 },
        delivery_checks: { checks: [], state: "unchecked" },
        outcome: "relevelled",
      } as never,
      new Date("2026-09-10T12:00:00.000Z"),
      true,
    );
    expect(state).toBe("pr_open");
    const after = readTicket(dir, key);
    expect(after.delivery.opened_by).toBe("loop");
    expect(after.delivery.arm).toBe("loop");
    expect(after.delivery.pull_request_number).toBe(3);
    expect(after.delivery.checks_state).toBe("unchecked");
    expect(after.delivery.observed_at).toBe("2026-09-10T12:00:00.000Z");
    // Everything a sync had read stays: a re-level rewrote none of it.
    expect(after.delivery.mergeable).toBe("mergeable");
    expect(after.delivery.commits_outside_loop).toBe(false);
    expect(after.delivery.github_credential).toBe("gh_login");
  });

  it("shows a failed re-level on list", () => {
    const { repo, key } = admittedRepo();
    const dir = storeDirOf(repo);
    const open = toPrOpen(repo, key);
    writeTicket(
      dir,
      withReconciliation(open, {
        base_tip: "c".repeat(40),
        exit_code: 3,
        at: "2026-09-10T11:00:00.000Z",
        reason: "carries 1 commit the loop did not make",
      }),
    );
    const streams = capture();
    runListCommand({ args: parseListArgs(["--repo", repo]), streams, cwd: repo });
    expect(streams.out.join("")).toContain(
      "re-level did not level the branch at cccccccccccc (exit 3: carries 1 commit the loop did not make)",
    );
  });
});

describe("the queue's reading of a branch", () => {
  it("judges by the pushed branch, so an unpushed merge commit does not read as level", async () => {
    const repo = join(scratch, "pushed");
    const remote = join(scratch, "pushed-remote.git");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "README.md", "base");
    execFileSync("git", ["init", "-q", "--bare", remote], { env });
    git(repo, "remote", "add", "origin", remote);
    git(repo, "checkout", "-q", "-b", "ayo/AYO-1/one");
    commit(repo, "one.md", "one");
    git(repo, "push", "-q", "-u", "origin", "ayo/AYO-1/one");
    git(repo, "checkout", "-q", "main");
    commit(repo, "two.md", "two");
    const tip = git(repo, "rev-parse", "main");
    const deps = processDeps({ repo, store: null, cwd: repo });
    expect(await deps.baseState({ repository_root: repo, base_ref: "main", branch: "ayo/AYO-1/one" })).toEqual({ tip, behind: true });
    // A local merge nobody pushed changes nothing the pull request can see.
    git(repo, "checkout", "-q", "ayo/AYO-1/one");
    git(repo, "merge", "-q", "--no-edit", "main");
    expect(await deps.baseState({ repository_root: repo, base_ref: "main", branch: "ayo/AYO-1/one" })).toEqual({ tip, behind: true });
    git(repo, "push", "-q", "origin", "ayo/AYO-1/one");
    expect(await deps.baseState({ repository_root: repo, base_ref: "main", branch: "ayo/AYO-1/one" })).toEqual({ tip, behind: false });
    expect(await deps.baseState({ repository_root: repo, base_ref: "main", branch: "ayo/AYO-9/none" })).toBeNull();
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("run --relevel", () => {
  it("is a flag and takes no value", () => {
    expect(parseExecuteArgs(["--ticket", "AYO-1", "--relevel"]).relevel).toBe(true);
    expect(parseExecuteArgs(["--ticket", "AYO-1"]).relevel).toBe(false);
    expect(() => parseExecuteArgs(["--relevel=yes"])).toThrow(UsageError);
  });
});
