// The check the release workflow runs between packing the archive and attaching
// it: the archive's contents in the log, and a refusal if the runner's
// write-guard hook is not among them.
//
//   node --test tooling/package/verify-tarball.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "verify-tarball.mjs");

const scratch = [];

after(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An archive shaped like the packed one, carrying the named files under `bin/`. */
function tarball(names) {
  const work = mkdtempSync(join(tmpdir(), "perbo-verify-"));
  scratch.push(work);
  const name = "perbo-0.0.0";
  mkdirSync(join(work, name, "bin"), { recursive: true });
  writeFileSync(join(work, name, "package.json"), "{}\n");
  for (const file of names) writeFileSync(join(work, name, "bin", file), "x\n");
  const archive = join(work, `${name}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", work, name]);
  return archive;
}

const verify = (archive) =>
  spawnSync(process.execPath, [SCRIPT, archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("an archive carrying the hook passes, and its contents are listed", () => {
  const run = verify(tarball(["perbo.mjs", "guard-hook.js"]));
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /perbo-0\.0\.0\/bin\/guard-hook\.js/);
  assert.match(run.stdout, /perbo-0\.0\.0\/bin\/perbo\.mjs/);
  assert.doesNotMatch(run.stdout, /::error::/);
});

test("an archive without the hook fails, naming what is missing", () => {
  const run = verify(tarball(["perbo.mjs"]));
  assert.equal(run.status, 1);
  assert.match(`${run.stdout}${run.stderr}`, /::error::/);
  assert.match(`${run.stdout}${run.stderr}`, /bin\/guard-hook\.js/);
  // The listing is printed either way: a failure says what the archive did hold.
  assert.match(run.stdout, /perbo-0\.0\.0\/bin\/perbo\.mjs/);
});

test("a tarball that cannot be read fails rather than passing silently", () => {
  const run = verify(join(tmpdir(), "perbo-no-such-archive.tgz"));
  assert.notEqual(run.status, 0);
});
