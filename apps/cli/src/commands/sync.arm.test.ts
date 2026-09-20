import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  TicketSchema,
  transition,
  unattendedMergeStatus,
  type Ticket,
} from "@perbo/contracts";
import { parseAdmitArgs, runAdmitCommand } from "./admit.js";
import type { Streams } from "../streams.js";
import { runSyncCommand } from "./sync.js";
import { readTicket, storeDir, writeTicket } from "../store/tickets.js";

/**
 * SCP-206 criterion 3: which arm produced a delivery record survives the sync
 * that reads GitHub over it.
 *
 * `sync` writes the delivery record whole from what `gh` said, and `gh` has
 * nothing to say about which arm opened the branch. So the field has to be
 * carried across deliberately; without that, one sync turns every direct-arm
 * row back into the loop's and the two arms stop being distinguishable in the
 * one instrument that reads both.
 *
 * The test spawns a real `git` and a fake `gh` on PATH, so it declares its own
 * deadline.
 */

const SPAWN_DEADLINE_MS = 20_000;

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-arm-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PR = 41;
const url = `https://github.com/o/r/pull/${PR}`;
const BRANCH = "direct/perbo-1/search-results-are-paginated";

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

const ghAnswer = (
  state = "OPEN",
  commits: Array<{ oid: string; messageHeadline: string; messageBody: string }> = [],
): string =>
  `${JSON.stringify({
    number: PR,
    url,
    state,
    body: "",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    commits,
  })}\n`;

function fakeGh(name = "bin", answer: string = ghAnswer()): string {
  const bin = join(scratch, name);
  mkdirSync(bin, { recursive: true });
  const body = join(bin, "view.json");
  writeFileSync(body, answer);
  const script = join(bin, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
      `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat ${JSON.stringify(body)}; exit 0; fi`,
      'echo "unexpected: $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return bin;
}

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
});

/**
 * A ticket whose delivery record was written by the direct arm, not the loop.
 *
 * `state` is where the walk is left, so a test can stand it exactly where the
 * arm's own record leaves it (`executing`) or one sync later (`pr_open`).
 */
function directArmTicket(
  name: string,
  options: { state?: "executing" | "pr_open"; arm?: "loop" | "direct" } = {},
): { repo: string; dir: string } {
  const repo = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"], {
    env: gitIdentity,
  });
  runAdmitCommand({
    args: parseAdmitArgs([
      "--repo",
      repo,
      "--outcome",
      "Search results are paginated.",
      "--criterion",
      "A second page is reachable. :: a paging test",
      "--path",
      "packages/search/**",
      "--approve",
    ]),
    streams: capture(),
    cwd: repo,
  });
  const dir = storeDir(repo, null);
  const at = new Date("2026-09-04T09:00:00.000Z");
  let ticket: Ticket = readTicket(dir, "PRB-1");
  const arm = options.arm ?? "direct";
  ticket = transition(ticket, "provisioning", "the arm was provisioned", at);
  ticket = transition(ticket, "executing", "1 invocation", at);
  ticket = TicketSchema.parse({
    ...ticket,
    delivery: {
      branch: BRANCH,
      pull_request_url: url,
      pull_request_number: PR,
      state: "open",
      observed_at: at.toISOString(),
      opened_by: arm === "direct" ? "direct" : "loop",
      mergeable: null,
      commits_outside_loop: null,
      github_credential: "GH_TOKEN",
      arm,
    },
    updated_at: at.toISOString(),
  });
  if ((options.state ?? "pr_open") === "pr_open") {
    ticket =
      arm === "direct"
        ? transition(ticket, "pr_open", "the agent opened it; a person merges it", at)
        : transition(
            transition(
              transition(ticket, "verifying", "checked", at),
              "independent_review",
              "reviewed independently",
              at,
            ),
            "pr_open",
            "approved; a human merges it",
            at,
          );
  }
  writeTicket(dir, ticket);
  return { repo, dir };
}

describe("sync carries the arm across the record it rewrites", () => {
  it(
    "still says `direct` after `gh` has been read over it",
    async () => {
      const { repo, dir } = directArmTicket("direct");
      process.env.PATH = `${fakeGh("bin-open")}:${originalPath ?? ""}`;
      process.env.GH_TOKEN = "ghp_scp206syncarmsentinel";

      const code = await runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T11:40:00.000Z"),
      });

      expect(code).toBe(EXIT_CODES.approve);
      const after = readTicket(dir, "PRB-1");
      expect(after.delivery.arm).toBe("direct");
      expect(after.delivery.pull_request_number).toBe(PR);
    },
    SPAWN_DEADLINE_MS,
  );

  it("reads a record written before the arm existed as the loop's", () => {
    const { dir } = directArmTicket("legacy");
    const path = join(dir, "tickets", "PRB-1.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      delivery: Record<string, unknown>;
    };
    delete raw.delivery.arm;
    expect(TicketSchema.parse(raw).delivery.arm).toBe("loop");
  }, SPAWN_DEADLINE_MS);
});

/**
 * SCP-206: the direct arm's record read all the way to a scored merge.
 *
 * The pre-registration's first metric is unattended merges per arm, read
 * through these same instruments — so `sync` has to be able to walk a
 * direct-arm record to `pr_open` and then to `merged`, and to judge its commits
 * by that arm's own trailer rather than by the loop's.
 */
describe("sync carries a direct-arm record to a scored merge", () => {
  it(
    "walks executing to pr_open on the arm, and refuses the same walk for the loop",
    async () => {
      const { repo, dir } = directArmTicket("walk", { state: "executing" });
      process.env.PATH = `${fakeGh("bin-walk", ghAnswer("OPEN"))}:${originalPath ?? ""}`;
      process.env.GH_TOKEN = "ghp_scp206syncarmsentinel";

      const code = await runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T11:40:00.000Z"),
      });

      expect(code).toBe(EXIT_CODES.approve);
      const after = readTicket(dir, "PRB-1");
      expect(after.state).toBe("pr_open");
      expect(after.delivery.arm).toBe("direct");
      expect(after.history.some((row) => row.to === "independent_review")).toBe(false);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "still refuses to reconcile a loop ticket stranded on the same two states",
    async () => {
      // The row the direct arm takes is `executing -> pr_open`, and a loop
      // ticket stranded at `executing` with a pull request on its branch and no
      // completed attempt behind it stands on exactly those two states. It is
      // the case the guard is for: the evidence disagrees with itself, and the
      // walk must still be refused rather than routed around.
      const { repo, dir } = directArmTicket("loop-stranded", { state: "executing", arm: "loop" });
      const before = readFileSync(join(dir, "tickets", "PRB-1.json"), "utf8");
      process.env.PATH = `${fakeGh("bin-loop-stranded", ghAnswer("OPEN"))}:${originalPath ?? ""}`;
      process.env.GH_TOKEN = "ghp_scp206syncarmsentinel";
      const streams = capture();

      const code = await runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams,
        cwd: repo,
        now: new Date("2026-09-04T11:40:00.000Z"),
      });

      expect(code).toBe(EXIT_CODES.did_not_complete);
      expect(readFileSync(join(dir, "tickets", "PRB-1.json"), "utf8")).toBe(before);
      expect(streams.err.join("")).toContain("refusing to reconcile it to pr_open");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "reads commits_outside_loop for a direct record by that arm's own trailer",
    async () => {
      const { repo, dir } = directArmTicket("commits", { state: "pr_open" });
      process.env.PATH = `${fakeGh(
        "bin-commits",
        ghAnswer("MERGED", [
          {
            oid: "c1",
            messageHeadline: "signup rejects an undeliverable address",
            messageBody: "Arm: direct\n",
          },
        ]),
      )}:${originalPath ?? ""}`;
      process.env.GH_TOKEN = "ghp_scp206syncarmsentinel";

      await runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T11:40:00.000Z"),
        mergeFacts: () => null,
      });

      const after = readTicket(dir, "PRB-1");
      expect(after.state).toBe("merged");
      expect(after.delivery.commits_outside_loop).toBe(false);
      expect(unattendedMergeStatus(after)).toBe("unattended");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "reads a commit the agent made without the trailer as outside that arm",
    async () => {
      const { repo, dir } = directArmTicket("untrailed", { state: "pr_open" });
      process.env.PATH = `${fakeGh(
        "bin-untrailed",
        ghAnswer("MERGED", [
          { oid: "c1", messageHeadline: "signup rejects it", messageBody: "Arm: direct\n" },
          { oid: "c2", messageHeadline: "fix the test", messageBody: "" },
        ]),
      )}:${originalPath ?? ""}`;
      process.env.GH_TOKEN = "ghp_scp206syncarmsentinel";

      await runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T11:40:00.000Z"),
        mergeFacts: () => null,
      });

      const after = readTicket(dir, "PRB-1");
      expect(after.delivery.commits_outside_loop).toBe(true);
      expect(unattendedMergeStatus(after)).toBe("attended");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "still judges a loop record by the loop's own trailer",
    async () => {
      const { repo, dir } = directArmTicket("loop-trailer", { state: "pr_open", arm: "loop" });
      process.env.PATH = `${fakeGh(
        "bin-loop-trailer",
        ghAnswer("MERGED", [
          { oid: "c1", messageHeadline: "PRB-1: pagination", messageBody: "Attempt: att_1\n" },
        ]),
      )}:${originalPath ?? ""}`;
      process.env.GH_TOKEN = "ghp_scp206syncarmsentinel";

      await runSyncCommand({
        argv: ["PRB-1", "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: new Date("2026-09-04T11:40:00.000Z"),
        mergeFacts: () => null,
      });

      expect(readTicket(dir, "PRB-1").delivery.commits_outside_loop).toBe(false);
    },
    SPAWN_DEADLINE_MS,
  );
});
