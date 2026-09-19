// The draft the release workflow leaves, against a `gh` on PATH that records
// every call and answers `release list` from a scripted list, so what these
// tests prove is what a dispatch actually asks GitHub to do.
//
//   node --test tooling/package/draft-release.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "draft-release.mjs");
const VERSION = "0.0.0";

const scratch = [];

after(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function work(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A `gh` on PATH that answers `release list` with the given releases and
 * succeeds silently at everything else, logging one line per call. Nothing is
 * modelled beyond the list, so a call the script makes shows up here as an
 * argument line rather than as a silent pass.
 */
function fakeGh(releases) {
  const bin = work("perbo-draft-gh-");
  const log = join(bin, "calls");
  const list = join(bin, "releases.json");
  writeFileSync(log, "");
  writeFileSync(list, JSON.stringify(releases));
  const script = join(bin, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `if [ "$1" = "release" ] && [ "$2" = "list" ]; then cat ${JSON.stringify(list)}; exit 0; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    bin,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
}

/** A packed tarball and the checksum file beside it, as `pack.mjs` leaves them. */
function tarball() {
  const dir = work("perbo-draft-");
  const archive = join(dir, `perbo-${VERSION}.tgz`);
  writeFileSync(archive, "archive\n");
  writeFileSync(`${archive}.sha256`, `${"a".repeat(64)}  perbo-${VERSION}.tgz\n`);
  return archive;
}

const draft = (gh, target = "f".repeat(40)) =>
  spawnSync(process.execPath, [SCRIPT, VERSION, tarball(), target], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The calls that change a release, which a refusal must never make. */
const writes = (gh) =>
  gh.calls().filter((call) => /^release (create|upload|edit|delete)\b/.test(call));

test("no draft for the version: the release is created", () => {
  const gh = fakeGh([
    { tagName: "v0.0.9", isDraft: true, name: "perbo 0.0.9" },
    { tagName: "v0.0.1", isDraft: false, name: "perbo 0.0.1" },
  ]);
  const run = draft(gh);

  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.equal(gh.calls().filter((call) => call.startsWith("release create v0.0.0 ")).length, 1);
  assert.equal(gh.calls().filter((call) => call.startsWith("release upload")).length, 0);
  assert.equal(gh.calls().filter((call) => call.startsWith("release edit")).length, 0);
});

test("a draft for the version: its assets are clobbered and its notes edited, and none is created", () => {
  const gh = fakeGh([
    { tagName: "v0.0.0", isDraft: true, name: "perbo 0.0.0" },
    { tagName: "v0.0.9", isDraft: true, name: "perbo 0.0.9" },
  ]);
  const run = draft(gh);

  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const upload = gh.calls().filter((call) => call.startsWith("release upload v0.0.0 "));
  assert.equal(upload.length, 1, gh.calls().join("\n"));
  assert.match(upload[0], /--clobber/);
  assert.match(upload[0], /perbo-0\.0\.0\.tgz\.sha256/);
  assert.equal(gh.calls().filter((call) => call.startsWith("release edit v0.0.0 ")).length, 1);
  assert.equal(gh.calls().filter((call) => call.startsWith("release create")).length, 0);
});

test("a published release with the tag: the run fails naming it, and nothing is written", () => {
  const gh = fakeGh([
    { tagName: "v0.0.0", isDraft: false, name: "perbo 0.0.0" },
    { tagName: "v0.0.9", isDraft: true, name: "perbo 0.0.9" },
  ]);
  const run = draft(gh);

  assert.equal(run.status, 1);
  assert.match(`${run.stdout}${run.stderr}`, /::error::/);
  assert.match(`${run.stdout}${run.stderr}`, /v0\.0\.0/);
  assert.deepEqual(writes(gh), []);
});

test("two drafts share the tag: the run fails rather than picking one, and nothing is written", () => {
  const gh = fakeGh([
    { tagName: "v0.0.0", isDraft: true, name: "perbo 0.0.0" },
    { tagName: "v0.0.0", isDraft: true, name: "perbo 0.0.0" },
  ]);
  const run = draft(gh);

  assert.equal(run.status, 1);
  assert.match(`${run.stdout}${run.stderr}`, /::error::/);
  assert.deepEqual(writes(gh), []);
});
