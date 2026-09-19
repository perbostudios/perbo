#!/usr/bin/env node
/**
 * Record one real public pull request so `perbo review --pr` can be replayed
 * against it with no network and no credential (SCP-179, ac_4).
 *
 * Everything under `captured` in the output is what `gh` printed, verbatim and
 * unedited; everything under `notes` is authored here, in this file, so that
 * re-running the script reproduces the fixture byte for byte and no prose can
 * drift away from the capture it describes. The fixture therefore holds the
 * pull request's own title, body, commits and patch — which is what makes an
 * offline test of the ticketless flow a test of that pull request rather than
 * of values the test itself supplied.
 *
 *   node apps/cli/test/fixtures/record-pull-request.mjs [owner/repo#N]
 *
 * Run it once, commit what it writes, and re-run it only to re-pin. It reads
 * and writes nothing on GitHub beyond `pr view`, `pr diff` and two `api` GETs.
 */
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Imported rather than taken off the global, because `eslint src test` lints
// this file and the flat config declares no Node globals for it.
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Authored, not captured: why this pull request is the one pinned. Keyed by
 * reference so the script stays usable for a second pin without carrying a
 * note that belongs to the first.
 */
const NOTES = {
  "sveltejs/svelte#17852": {
    why_this_pull_request:
      "Its body states what the change does and states no acceptance criteria — and the " +
      "checklist under 'Before submitting the PR' is GitHub's template, whose items ('include " +
      "a test that fails without this PR but passes with it') read exactly like criteria and " +
      "are not any. A real pull request judged against criteria lifted off a template is the " +
      "failure SCP-179 exists to avoid, so ac_2 is tested against a real body rather than an " +
      "invented one. It is also small — four files — and merged, so the pin cannot move.",
    also_recorded_in:
      "The evaluation corpus pins the same pull request for a different purpose, as fixture " +
      "reg-010-skip-derived-reevaluation-in-inert-blocks. The two records are checked against " +
      "each other in apps/cli/test/ticketless-review.test.ts.",
    upstream_code_is_checked_in_here:
      "Deliberately, and unlike the corpus's pinned fixtures, which compute their diff from a " +
      "clone into a gitignored cache. A test that reads that cache is a test CI fails, and the " +
      "patch is what the reviewer reads — so an offline test that did not carry it would be " +
      "asserting about a change this repository wrote. sveltejs/svelte is MIT; its copyright " +
      "notice, the licence and the commit the patch was taken from are recorded above it.",
  },
};

/**
 * The fields `readPullRequest` asks for, then the record of which pull request
 * this is. The last two are SCP-211's: they say which repository the head
 * commit lives in, and a recording made before they were asked for simply does
 * not carry them — the read takes the pull request's own repository as the head
 * where `gh` reported none.
 */
const VIEW_FIELDS =
  "number,title,body,url,headRefName,baseRefName,headRefOid,baseRefOid," +
  "headRepository,headRepositoryOwner";
const RECORD_FIELDS = "state,mergeCommit,mergedAt";

const reference = process.argv[2] ?? "sveltejs/svelte#17852";
const parsed = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/.exec(reference);
if (!parsed) {
  process.stderr.write(`usage: record-pull-request.mjs [owner/repo#N] (got '${reference}')\n`);
  process.exit(2);
}
const [, owner, repo, number] = parsed;
const slug = `${owner}/${repo}`;

/** Argv only, never a shell string (ADR-0023 §4). */
const gh = (...args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });

const commands = {
  view: ["pr", "view", number, "--repo", slug, "--json", `${VIEW_FIELDS},${RECORD_FIELDS}`],
  diff: ["pr", "diff", number, "--repo", slug],
};

const viewed = JSON.parse(gh(...commands.view));
const diff = gh(...commands.diff);

// The merge commit is what ties a pinned SHA to the pull request: `headRefOid`
// is a branch tip and the branch may have moved or been deleted since.
const mergeCommit = viewed.mergeCommit?.oid ?? null;
if (mergeCommit === null) {
  process.stderr.write(`${reference} has not been merged: there is no commit to pin it by.\n`);
  process.exit(1);
}
commands.commit = ["api", `repos/${slug}/commits/${mergeCommit}`];
commands.licence = ["api", `repos/${slug}/license`];
const commit = JSON.parse(gh(...commands.commit));

/**
 * The licence, and the copyright line it opens with.
 *
 * The patch below is checked in, and a permissive licence asks that the
 * copyright notice travel with the code it covers. The full permission notice
 * is the MIT text at `licence.url`, which is where a reader is sent rather than
 * having it copied here. `content` is the licence file itself, base64.
 */
const licensed = JSON.parse(gh(...commands.licence));
const licenceText = Buffer.from(licensed.content ?? "", "base64").toString("utf8");
const isCopyright = (line) => /\bcopyright\b/i.test(line);
// The notice at the head of the file, which is one line in most licences and a
// run of them where a work has several holders. Reading stops at the first line
// that is not one, so MIT's "The above copyright notice…" clause — part of the
// permission text, not the notice — stays out of it.
const licenceLines = licenceText.split(/\r?\n/).map((line) => line.trim());
const first = licenceLines.findIndex(isCopyright);
const notice = [];
for (let i = first; i >= 0 && i < licenceLines.length && isCopyright(licenceLines[i]); i += 1) {
  notice.push(licenceLines[i]);
}
const copyright = notice.join("\n");

/** Exactly the fields `readPullRequest` asks `gh` for, and no others. */
const forTheCommand = Object.fromEntries(
  VIEW_FIELDS.split(",").map((field) => [field, viewed[field]]),
);

const fixture = {
  what_this_is:
    `${reference} as \`gh\` answered for it, recorded so a review of it replays on a machine ` +
    "with no credential and no network. Written by test/fixtures/record-pull-request.mjs; " +
    "re-run that script to re-record. Do not hand-edit — a hand-edited capture is not one.",
  captured: {
    at: new Date().toISOString().slice(0, 10),
    by: `apps/cli/test/fixtures/record-pull-request.mjs ${reference}`,
    with: gh("--version").split("\n")[0].trim(),
    commands: Object.fromEntries(
      Object.entries(commands).map(([name, args]) => [name, `gh ${args.join(" ")}`]),
    ),
    upstream_licence: licensed.license?.spdx_id ?? null,
    upstream_licence_notice: {
      copyright,
      permission_notice: `The permission notice is the ${licensed.license?.spdx_id ?? "licence"} ` +
        `text at ${licensed.html_url}; it is not copied here.`,
      url: licensed.html_url,
    },
  },
  pinned: {
    reference,
    url: viewed.url,
    title: viewed.title,
    state: viewed.state,
    merged_at: viewed.mergedAt,
    head_commit: viewed.headRefOid,
    base_commit: viewed.baseRefOid,
    merge_commit: mergeCommit,
    // A squash or rebase merge has one parent, and it is the base commit.
    parent_commits: commit.parents.map((parent) => parent.sha),
    changed_files: commit.files.map((file) => file.filename),
    repository: `https://github.com/${slug}`,
  },
  notes: NOTES[reference] ?? null,
  /** Verbatim `gh pr view`, restricted to the fields the command reads. */
  gh_pr_view: forTheCommand,
  /** Verbatim `gh pr diff`: the patch the reviewer is shown offline. */
  gh_pr_diff: diff,
};

const out = join(here, `pull-request-${owner}-${repo}-${number}.json`);
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`recorded ${reference} (${commit.files.length} files) to ${out}\n`);
