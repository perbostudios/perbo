import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { inspectCommand } from "../../prohibited.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A backup is a second path a writer writes beside its destination, so it is
 * judged as a write: `<dest><suffix>`, a numbered `<dest>.~N~`, `sed -i`'s
 * `<file><suffix>`, and `rsync --backup-dir`.
 */

const ROOT = realpathSync(scratch("perbo-backup-"));
for (const directory of ["src/other", "bin"]) mkdirSync(join(ROOT, directory), { recursive: true });
writeFileSync(join(ROOT, "src/a.ts"), "source\n");
writeFileSync(join(ROOT, "src/other/a.ts"), "other\n");

const actions = (command: string, paths_prohibited: string[] = ["**/*.pem"]) =>
  inspectCommand(command, {
    root: ROOT,
    cwd: ROOT,
    home: "/Users/nobody",
    paths_allowed: ["src/**", "bin/**"],
    paths_prohibited,
    spec_folder_writable: true,
  }).map((hit) => hit.action);

const refusedAs = (command: string, action: string, prohibited?: string[]) =>
  expect(actions(command, prohibited), command).toContain(action);

const admitted = (command: string, prohibited?: string[]) =>
  expect(actions(command, prohibited), command).toEqual([]);

describe("a coreutils backup, judged as a write", () => {
  const SPELLINGS = [
    "-b --suffix=.pem",
    "-b --suf=.pem",
    "-b --su .pem",
    "-S .pem",
    "-S.pem",
    "-bS.pem",
    "--backup=simple --suffix=.pem",
    "--back -S .pem",
  ];

  it("refuses a suffix that makes the backup a prohibited path, into a directory or onto a file", () => {
    for (const verb of ["cp", "mv", "install"]) {
      for (const spelling of SPELLINGS) {
        for (const destination of ["src/other/", "src/other", "src/other/a.ts"]) {
          refusedAs(`${verb} ${spelling} src/a.ts ${destination}`, "write_prohibited_path");
        }
      }
    }
    for (const command of [
      "ln -f -b --suffix=.pem src/a.ts src/other/",
      "ln -sf -S .pem ../a.ts src/other/a.ts",
      "ln -sfS.pem ../a.ts src/other/",
      "ln -f --backup --suf=.pem src/a.ts src/other/a.ts",
    ]) {
      refusedAs(command, "write_prohibited_path");
    }
  });

  it("admits the default suffix where the backup is in scope", () => {
    for (const command of [
      "cp -b src/a.ts src/other/",
      "mv -b src/a.ts src/other/",
      "cp --backup src/a.ts src/other/a.ts",
      "install -b src/a.ts src/other",
      "ln -fb src/a.ts src/other/",
      "cp -b --suffix=.orig src/a.ts src/other/",
      "SIMPLE_BACKUP_SUFFIX=.orig cp -b src/a.ts src/other/",
    ]) {
      admitted(command);
    }
  });

  it("judges the default `~` and a numbered backup as written paths", () => {
    refusedAs("cp -b src/a.ts src/other/", "write_prohibited_path", ["**/*~"]);
    refusedAs("mv --backup=numbered src/a.ts src/other/a.ts", "write_prohibited_path", ["**/*.~1~"]);
    admitted("cp src/a.ts src/other/", ["**/*~"]);
  });

  it("reads SIMPLE_BACKUP_SUFFIX where the line gives it a literal value, and refuses it otherwise", () => {
    for (const command of [
      "SIMPLE_BACKUP_SUFFIX=.pem cp -b src/a.ts src/other/",
      "export SIMPLE_BACKUP_SUFFIX=.pem; mv -b src/a.ts src/other/",
      "SIMPLE_BACKUP_SUFFIX='.pem' ln -fb src/a.ts src/other/",
    ]) {
      refusedAs(command, "write_prohibited_path");
    }
    for (const command of [
      'SIMPLE_BACKUP_SUFFIX="$X" cp -b src/a.ts src/other/',
      "read SIMPLE_BACKUP_SUFFIX; cp -b src/a.ts src/other/",
    ]) {
      refusedAs(command, "write_outside_worktree");
    }
  });

  it("refuses a suffix built when the line runs", () => {
    for (const command of [
      'cp -b --suffix="$S" src/a.ts src/other/',
      "mv -S $(printf .pem) src/a.ts src/other/",
      "ln -fS `echo .pem` src/a.ts src/other/",
      // What `xargs` substitutes is a suffix the line does not spell.
      "ls | xargs -I{} cp -b --suffix={} src/a.ts src/other/",
    ]) {
      refusedAs(command, "write_outside_worktree");
    }
  });
});

describe("`sed -i` with a suffix, and `rsync` backups", () => {
  it("judges the file `sed` keeps beside each one it rewrites", () => {
    for (const command of [
      "sed -i.pem s/a/b/ src/a.ts",
      "sed --in-place=.pem s/a/b/ src/a.ts",
      "sed --in=.pem s/a/b/ src/a.ts",
      "sed -ni.pem p src/a.ts",
      // BSD's suffix is the next word.
      "sed -i .pem s/a/b/ src/a.ts",
    ]) {
      refusedAs(command, "write_prohibited_path");
    }
    refusedAs("sed -i'bak/*' s/a/b/ src/a.ts", "write_prohibited_path", ["**/bak/**"]);
    for (const command of ["sed -i s/a/b/ src/a.ts", "sed -i '$d' src/a.ts", "sed -ie s/a/b/ src/a.ts"]) {
      admitted(command);
    }
  });

  it("judges an rsync backup and its backup directory", () => {
    refusedAs("rsync -a -b --suffix=.pem src/a.ts src/other/a.ts", "write_prohibited_path");
    refusedAs("rsync -a --backup-dir=/tmp/x src/a.ts src/other/a.ts", "write_outside_worktree");
    refusedAs("rsync -a --backup-d=keys src/a.ts src/other/a.ts", "write_prohibited_path", ["src/other/keys/**"]);
  });
});
