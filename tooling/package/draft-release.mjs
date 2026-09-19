#!/usr/bin/env node
// The draft the release workflow leaves for the founder: one per version, not
// one per run. Where a draft for the version already exists its assets are
// replaced and its notes and target rewritten to this run's; where none exists
// it is created. A published release with the tag is refused rather than
// touched — a version that has been published is not re-cut by a dispatch.
// Called by .github/workflows/release.yml, after the tarball is verified.
//
//   node tooling/package/draft-release.mjs <version> <tarball> [target-sha]
//
// A target sha targets that commit, which is what a dispatch wants. An empty
// target instead has gh verify that the tag already exists, which is what a tag
// push wants.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokedDirectly } from "./bundle.mjs";

const say = (error) => (error instanceof Error ? error.message : String(error));

/** Every release on this repository, newest first, drafts among them. */
function listReleases() {
  const listed = execFileSync(
    "gh",
    ["release", "list", "--limit", "100", "--json", "tagName,isDraft,name"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(listed);
}

/** The notes the release carries, written to a file for `gh` to read. */
function writeNotes(version, tarball) {
  const digest = readFileSync(`${tarball}.sha256`, "utf8").replace(/\n+$/, "");
  const notes = join(mkdtempSync(join(tmpdir(), "perbo-release-notes-")), "release-notes.md");
  writeFileSync(
    notes,
    [
      `perbo ${version}, for design partners. The digest to verify against:`,
      "",
      "```",
      digest,
      "```",
      "",
      "Install instructions are the README inside the archive. The archive does not update itself: a newer version is a new archive and a message.",
      "",
    ].join("\n"),
  );
  return notes;
}

/** Leave exactly one draft for `version`, carrying this run's tarball. */
export function draftRelease({ version, tarball, target }) {
  const tag = `v${version}`;

  let releases;
  try {
    releases = listReleases();
  } catch (error) {
    console.log(`::error::the releases on this repository could not be listed: ${say(error)}`);
    return false;
  }

  const forTag = releases.filter((release) => release.tagName === tag);
  const published = forTag.find((release) => release.isDraft !== true);
  if (published !== undefined) {
    console.log(
      `::error::${tag} is already a published release ("${published.name ?? tag}"): a published ` +
        "version is not re-cut, so nothing was attached. Release a new version instead.",
    );
    return false;
  }

  const drafts = forTag.filter((release) => release.isDraft === true);
  if (drafts.length > 1) {
    console.log(
      `::error::${tag} has ${drafts.length} drafts, so there is no one draft to replace. Delete ` +
        "all but the one to keep, then run this again.",
    );
    return false;
  }

  const assets = [tarball, `${tarball}.sha256`];
  const title = `perbo ${version}`;
  const where = target === "" ? [] : ["--target", target];

  try {
    const notes = writeNotes(version, tarball);
    if (drafts.length === 1) {
      console.log(`${tag} already has a draft: replacing its assets, notes and target.`);
      run(["release", "upload", tag, ...assets, "--clobber"]);
      run(["release", "edit", tag, "--title", title, "--notes-file", notes, ...where]);
    } else {
      console.log(`${tag} has no draft: creating one.`);
      run([
        "release",
        "create",
        tag,
        "--draft",
        ...(target === "" ? ["--verify-tag"] : where),
        "--title",
        title,
        "--notes-file",
        notes,
        ...assets,
      ]);
    }
  } catch (error) {
    console.log(`::error::the draft for ${tag} could not be written: ${say(error)}`);
    return false;
  }
  return true;
}

/** One `gh` call, its output in the run's log. */
function run(args) {
  execFileSync("gh", args, { stdio: "inherit" });
}

if (invokedDirectly(import.meta.url)) {
  const [version, tarball, target = ""] = process.argv.slice(2);
  if (version === undefined || tarball === undefined) {
    console.log("::error::draft-release.mjs needs a version and the path to a packed tarball");
    process.exit(1);
  }
  if (!draftRelease({ version, tarball, target })) process.exit(1);
}
