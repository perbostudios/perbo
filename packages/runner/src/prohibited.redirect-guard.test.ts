import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { commandSegments, inspectCommand, inspectPaths } from "./prohibited.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * `write_outside_worktree` judges where a write lands, not how its path is
 * spelled (SCP-156). The two command lines pinned here are the ones that ended
 * loop runs: each wrote into the attempt's own worktree by absolute path.
 */

const AYO6_ROOT =
  "/Users/nobody/.perbo/worktrees/perbo-adversarial-review-7eea98-0a500fe1e40b/att_619d57cdcd5a2eaf";

const HOME = "/Users/nobody";

const hits = (command: string, root = AYO6_ROOT) =>
  inspectCommand(command, { root, home: HOME });

const actions = (command: string, root = AYO6_ROOT) => hits(command, root).map((hit) => hit.action);

const outside = (command: string, root = AYO6_ROOT) =>
  expect(actions(command, root), command).toContain("write_outside_worktree");

const allowed = (command: string, root = AYO6_ROOT) => expect(hits(command, root), command).toEqual([]);

describe("a redirect into the attempt's own worktree", () => {
  it("allows the AYO-6 line that ended round 2", () => {
    allowed(
      `git show 4fffb08 -- apps/cli/test/escapes.test.ts > ${AYO6_ROOT}/att_619d57cdcd5a2eaf.diff`,
    );
    allowed(`git show 4fffb08 -- apps/cli/test/escapes.test.ts > ${AYO6_ROOT}/r1.diff`);
  });

  it("allows the AYO-12 line that ended round 0", () => {
    allowed(`git show HEAD:apps/cli/src/stops.ts > ${AYO6_ROOT}/apps/cli/src/stops-head.ts`);
  });

  it("allows a relative redirect that climbs and comes back", () => {
    allowed("git show HEAD > sub/../inside.txt");
    allowed("git show HEAD >> ./notes/../inside.txt");
  });

  it("allows the append and stderr forms of the same destination", () => {
    allowed(`pnpm test >> ${AYO6_ROOT}/log.txt`);
    allowed(`pnpm test 2> ${AYO6_ROOT}/err.txt`);
    allowed(`pnpm test &> ${AYO6_ROOT}/all.txt`);
  });

  it("does not read a file-descriptor duplication as a path", () => {
    allowed("pnpm test 2>&1");
    allowed(`pnpm test > ${AYO6_ROOT}/log.txt 2>&1`);
  });
});

describe("a redirect that lands outside it", () => {
  it("refuses /tmp, which the directory-name pattern let through", () => {
    outside("git show 4fffb08 -- apps/cli/test/escapes.test.ts > /tmp/r1.diff");
    outside("pnpm test > /tmp/out.log");
  });

  it("refuses an escape by `..` from the worktree root", () => {
    outside("git show HEAD > ../../escape.txt");
    outside("pnpm test > ../escape.txt");
  });

  it("refuses $HOME and ~ however they are written", () => {
    outside("git show HEAD > $HOME/x");
    outside("git show HEAD > ~/x");
    outside("git show HEAD > ${HOME}/x");
  });

  it("refuses a system path", () => {
    outside("printf x > /etc/hosts");
  });
});

describe("a redirect target the guard cannot resolve", () => {
  it("refuses it, naming what it could not resolve", () => {
    for (const [command, named] of [
      ["git show HEAD > $OUT/r1.diff", "$OUT/r1.diff"],
      ["git show HEAD > $TMPDIR/r1.diff", "$TMPDIR/r1.diff"],
      ["git show HEAD > ${OUT_DIR}/r1.diff", "${OUT_DIR}/r1.diff"],
    ] as const) {
      const found = hits(command).filter((hit) => hit.action === "write_outside_worktree");
      expect(found, command).toHaveLength(1);
      expect(found[0]?.detail, command).toContain(named);
      expect(found[0]?.detail, command).toMatch(/cannot be resolved/);
    }
  });

  it("refuses a process substitution and a redirect with no target", () => {
    outside("git show HEAD > >(tee /tmp/x)");
    outside("git show HEAD > `mktemp`");
    outside("git show HEAD >");
  });
});

describe("a symlink inside the worktree that points out of it", () => {
  it("is refused, because the destination is what counts", () => {
    const root = scratch("perbo-scp156-root-");
    const elsewhere = scratch("perbo-scp156-out-");
    symlinkSync(elsewhere, join(root, "escape-hatch"));

    outside(`git show HEAD > ${root}/escape-hatch/r1.diff`, root);
    allowed(`git show HEAD > ${root}/r1.diff`, root);
  });
});

describe("the file-touching commands, judged by destination", () => {
  it("allows a copy, a move and a removal inside the worktree", () => {
    allowed(`cp notes.md ${AYO6_ROOT}/notes-copy.md`);
    allowed(`mv notes.md ${AYO6_ROOT}/notes-moved.md`);
    allowed("rm -rf node_modules/.cache");
    allowed(`chmod 755 ${AYO6_ROOT}/scripts/run.sh`);
  });

  it("refuses one that lands outside it, by any spelling", () => {
    outside("cp secrets.json ~/backup.json");
    outside("cp secrets.json /tmp/backup.json");
    outside("mv notes.md ../../notes.md");
    outside("rm -rf /tmp/evidence");
    outside("chmod 777 /etc/hosts");
  });
});

describe("the tool-path check at seal time", () => {
  const scope = { root: AYO6_ROOT, home: HOME };
  const pathActions = (path: string) =>
    inspectPaths([path], undefined, scope).map((hit) => hit.action);

  it("does not call an absolute path inside the worktree an escape", () => {
    expect(pathActions(`${AYO6_ROOT}/apps/cli/src/stops.ts`)).not.toContain(
      "write_outside_worktree",
    );
  });

  it("does not call a `..` that resolves inside an escape", () => {
    expect(pathActions("apps/../apps/cli/src/stops.ts")).toEqual([]);
  });

  it("still refuses what resolves outside", () => {
    for (const path of ["../escape.txt", "/etc/passwd", "/tmp/r1.diff"]) {
      expect(pathActions(path), path).toContain("write_outside_worktree");
    }
  });
});

/**
 * The constructions the old spelling patterns refused and a tokenizer that
 * stops at a quote does not see. Each command is pinned verbatim.
 */
describe("a write hidden inside a quoted argument", () => {
  it("reads the operand of `sh -c` as the command it is", () => {
    outside('pnpm exec sh -c "echo x > /etc/passwd"');
    outside("npx --yes sh -c 'echo x > ~/x'");
    outside("pnpm exec sh -c 'cp secrets.json ~/backup.json'");
    outside('bash -lc "printf x > /tmp/out"');
  });

  it("reads a substitution as a command, including inside double quotes", () => {
    outside('echo "$(printf x > /etc/passwd)"');
    outside("echo \"`printf x > /Users/nobody/x`\"");
    outside('echo "$(cp secrets.json ~/x)"');
  });

  it("refuses a wrapped command it cannot read", () => {
    const found = hits('sh -c "$CMD"').filter((hit) => hit.action === "write_outside_worktree");
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toMatch(/cannot be read/);
  });

  it("still leaves a quoted argument that is only an argument alone", () => {
    allowed("rg '> /tmp' src");
    allowed('rg "cp x ~/y" src');
  });
});

describe("a separator inside a quoted argument", () => {
  it("is part of the argument, so the redirect after it is still seen", () => {
    outside('git log --format="%h | %s" > ~/log.txt');
    outside('rg -e "foo|bar" src > /etc/x');
    outside('cat "a;b.txt" > /Users/nobody/x');
    outside('git show "HEAD:a|b" > ~/x');
    outside('echo "a && b" > /Users/nobody/x');
  });

  it("keeps the same in-worktree lines allowed", () => {
    allowed(`git log --format="%h | %s" > ${AYO6_ROOT}/log.txt`);
    allowed(`git show HEAD >| ${AYO6_ROOT}/x`);
  });

  it("splits on the separators that are not inside quotes", () => {
    expect(commandSegments("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(commandSegments('a "b;c" && d')).toEqual(['a "b;c"', "d"]);
  });
});

describe("a file-touching verb that is not the first word", () => {
  it("is found after a wrapper, a keyword, a subshell and `find -exec`", () => {
    outside("pnpm exec cp secrets.json ~/backup.json");
    outside("pnpm exec rm -rf ~/x");
    outside("find . -name '*.key' -exec cp {} ~/keys/ \\;");
    outside("find . -name x -exec rm {} ~/y +");
    outside("for f in *; do cp $f ~/backup/; done");
    outside("if cp a ~/b; then echo ok; fi");
    outside("(cp a ~/b)");
    outside("{ cp a ~/b; }");
    outside("env cp a ~/b");
    outside("xargs rm ~/x");
    outside("time cp a ~/b");
    outside("nohup cp a ~/b");
  });

  it("reads a clustered `-t` as the target directory", () => {
    outside("cp -rt ~/x a");
    outside("cp -vt ~/x a b");
    outside("mv -ft ~/x a");
    outside("cp -t~/x a");
  });

  it("keeps the in-worktree forms of the same commands allowed", () => {
    allowed(`pnpm exec cp notes.md ${AYO6_ROOT}/notes-copy.md`);
    allowed(`cp -rt ${AYO6_ROOT}/backup a`);
    allowed("for f in *; do cp $f ./backup/; done");
  });
});

describe("a symlink met part way along a path", () => {
  it("is followed before `..` climbs, and a dangling link resolves to its target", () => {
    const root = scratch("perbo-scp156-walk-");
    const elsewhere = scratch("perbo-scp156-away-");
    symlinkSync(elsewhere, join(root, "escape-hatch"));
    symlinkSync(`${HOME}/.ssh/config`, join(root, "dangling"));
    writeFileSync(join(root, "real.txt"), "x");

    outside(`git show HEAD:x > escape-hatch/../x`, root);
    outside(`git show HEAD:x > ${root}/escape-hatch/../x`, root);
    outside("cat a > dangling", root);
    allowed("cat a > real.txt", root);
    allowed("cat a > sub/../real.txt", root);
  });
});

describe("a `cd` earlier on the line", () => {
  it("moves the directory the redirects after it resolve against", () => {
    allowed("cd packages/runner && pnpm exec vitest run > ../../vitest.log 2>&1");
    allowed("cd apps/cli && git show HEAD:x > ../../x");
    allowed("cd packages && cd runner && git show HEAD > ../../notes.md");
  });

  it("still refuses what lands outside from the moved directory", () => {
    outside("cd packages/runner && git show HEAD > ../../../escape.txt");
  });

  it("refuses a `cd` that leaves the worktree or cannot be resolved", () => {
    outside("cd /tmp && echo x > y");
    outside("cd $ELSEWHERE && echo x > y");
    outside("pushd /tmp && echo x > y");
    outside("cd ~ && echo x > y");
  });

  it("does not let a `cd` in a pipeline stage move what follows it", () => {
    allowed("cd packages/runner | cat");
  });
});

/**
 * The wrappers the parser steps over take options of their own. The first
 * `-flag` after one is not the program it runs.
 */
describe("a wrapper's own options", () => {
  it("does not read one as the command the wrapper runs", () => {
    outside("nice -n 10 cp a ~/b");
    outside("env -i cp a ~/b");
    outside("command -p cp a ~/b");
    outside("time -p cp a ~/b");
    outside("stdbuf -oL cp a ~/b");
    outside("exec -a name cp a ~/b");
  });

  it("sees through the forms the executor can actually reach", () => {
    outside("pnpm exec nice -n 5 cp a ~/b");
    outside("find . -exec env -i cp {} ~/y \\;");
    outside("xargs -I{} nice -n5 cp {} ~/o");
  });

  it("refuses a wrapper option it does not know, naming it", () => {
    for (const command of ["nice -Z cp a b", "sudo -Q cp a b", "xargs -Q cp a b"]) {
      const found = hits(command).filter((hit) => hit.action === "write_outside_worktree");
      expect(found, command).toHaveLength(1);
      expect(found[0]?.detail, command).toMatch(/is not an option this guard knows/);
    }
    expect(hits("nice -Z cp a b")[0]?.detail).toContain("-Z");
  });

  it("keeps the in-worktree forms of the same wrappers allowed", () => {
    allowed(`nice -n 10 cp a ${AYO6_ROOT}/b`);
    allowed(`env -i cp a ${AYO6_ROOT}/b`);
    allowed(`stdbuf -oL cp a ${AYO6_ROOT}/b`);
    allowed(`timeout 30 pnpm exec vitest run > ${AYO6_ROOT}/log.txt`);
    allowed(`xargs -I{} cp {} ${AYO6_ROOT}/out`);
  });
});

describe("`eval` with more than one operand", () => {
  it("judges the operands joined, which is what the shell runs", () => {
    outside("eval cp a ~/b");
    outside('eval "cp a" ~/b');
    outside('eval "cp a ~/b"');
    outside('eval echo x ">" ~/out.txt');
  });

  it("keeps the in-worktree join allowed", () => {
    allowed(`eval cp a ${AYO6_ROOT}/b`);
  });
});

describe("a `cd` inside a subshell", () => {
  it("moves the redirects in that same subshell", () => {
    allowed("(cd deep && echo x > ../real.txt)");
    allowed("(cd packages/runner; git show HEAD > ../../notes.md)");
  });

  it("still refuses what leaves the worktree from there", () => {
    outside("(cd deep && echo x > ../../../escape.txt)");
  });
});

describe("a wrapper named by path, or reached through a workspace flag", () => {
  it("is the same wrapper", () => {
    outside("/usr/bin/env cp a ~/b");
    outside("/usr/bin/env FOO=1 sh -c 'echo x > /etc/passwd'");
    outside("/usr/bin/nice -n 10 cp a ~/b");
  });

  it("sees through the package-manager forms this repository allow-lists", () => {
    outside("pnpm -r exec cp a ~/b");
    outside("pnpm --filter @perbo/cli exec sh -c 'echo x > /etc/passwd'");
    outside("pnpm --filter=@perbo/cli exec cp a ~/b");
    outside("pnpm exec -- cp a ~/b");
    outside("yarn workspace cli exec cp a ~/b");
    outside("bun x sh -c 'echo x > /etc/passwd'");
    outside("npm exec -- cp a ~/b");
  });

  it("refuses a package-manager option it does not know, naming it", () => {
    const found = hits("pnpm --nope exec cp a b").filter(
      (hit) => hit.action === "write_outside_worktree",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("--nope");
  });

  it("runs the wrapped command in the directory a `-C` names", () => {
    allowed(`pnpm -C packages/runner exec cp a ${AYO6_ROOT}/packages/runner/b`);
    allowed("pnpm -C packages/runner exec cp a b");
    outside("pnpm -C /tmp exec cp a b");
    outside("env -C /tmp cp a b");
  });

  it("refuses an option that builds a command from a string", () => {
    for (const command of ["env -S 'cp a ~/x' true", "env --split-string='cp a ~/x' true"]) {
      const found = hits(command).filter((hit) => hit.action === "write_outside_worktree");
      expect(found, command).toHaveLength(1);
      expect(found[0]?.detail, command).toMatch(/builds the command/);
    }
  });

  it("keeps the ordinary package-manager lines allowed", () => {
    allowed("pnpm install --frozen-lockfile");
    allowed("pnpm run build");
    allowed("pnpm -r run build");
    allowed("pnpm exec turbo run test");
    allowed(`pnpm --filter @perbo/cli exec vitest run > ${AYO6_ROOT}/log.txt`);
  });
});

describe("the operator that ends a command", () => {
  it("does not let a backgrounded or piped `cd` move what follows", () => {
    outside("cd deep & echo x > ../x");
    outside("cd deep & git show HEAD > ../x");
    outside("(cd deep | cat; echo x > ../x)");
    outside("(cd deep & echo x > ../x)");
  });

  it("still lets a sequential `cd` move it", () => {
    allowed("cd deep && echo x > ../real.txt");
    allowed("cd deep; echo x > ../real.txt");
    allowed("(cd deep && echo x > ../real.txt)");
    allowed("(cd deep; echo x > ../real.txt)");
  });

  it("reads `&&` as one operator rather than two backgrounds", () => {
    expect(commandSegments("a && b & c | d")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the options a package manager takes after `exec`", () => {
  it("does not read one as the program being run", () => {
    outside("pnpm exec -c 'echo x > /etc/passwd'");
    outside("pnpm exec --shell-mode 'cp a ~/b'");
    outside("npm x -c 'echo x > /etc/passwd'");
    outside("npm exec --call='cp a ~/b'");
    outside("pnpm exec --parallel cp a ~/b");
    outside("bun x --bun sh -c 'echo x > /etc/passwd'");
    outside("pnpm dlx --package=x sh -c 'echo x > /etc/passwd'");
  });

  it("refuses one it does not know, naming it", () => {
    const found = hits("pnpm exec --nope cp a b").filter(
      (hit) => hit.action === "write_outside_worktree",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("--nope");
  });

  it("keeps the in-worktree forms allowed", () => {
    allowed(`pnpm exec -c 'cp a ${AYO6_ROOT}/b'`);
    allowed(`pnpm exec --parallel cp a ${AYO6_ROOT}/b`);
    allowed(`pnpm dlx --package=x sh -c 'cp a ${AYO6_ROOT}/b'`);
  });
});

describe("the device targets a redirect ordinarily names", () => {
  it("allows the ones that discard or re-enter the process's own streams", () => {
    allowed("pnpm test > /dev/null");
    allowed("pnpm install > /dev/null 2>&1");
    allowed("git fetch 2>/dev/null");
    allowed("command -v node >/dev/null");
    allowed("pnpm test &>/dev/null");
    allowed("git show HEAD > /dev/stderr");
    allowed("git show HEAD > /dev/stdout");
    allowed("git show HEAD > /dev/fd/2");
    allowed("git show HEAD > /dev/tty");
    allowed("cp a /dev/null");
  });

  it("still refuses a device that is a real write", () => {
    outside("git show HEAD > /dev/disk0");
    outside("cp a /dev/disk0");
    outside("git show HEAD > /dev/nullx");
  });
});

describe("a newline inside a subshell", () => {
  it("ends a command there as it does at the top level", () => {
    allowed("(\n cd packages/cli\n pnpm build > ../../build.log\n)");
    outside("(\n cd packages/cli\n pnpm build > ../../../escape.log\n)");
  });

  it("reads `-s` as the package manager's silent flag", () => {
    outside("pnpm -s exec cp a ~/b");
    allowed("pnpm -s run build");
  });
});

/**
 * A move is not a write (SCP-162). `cd` names where later relative targets
 * resolve; it refuses nothing on its own, and what lands outside the worktree
 * from there is still refused.
 */
describe("a directory move that leaves the worktree", () => {
  it("allows the move itself", () => {
    allowed("cd /tmp && node /Users/nobody/x/apps/cli/dist/main.js doctor");
    allowed("cd /tmp");
    allowed("cd /tmp && git status");
    allowed("pushd /tmp");
    allowed("cd ~ && node --version");
    allowed(`pnpm -C /tmp exec node --version`);
    allowed("env -C /tmp node --version");
  });

  it("refuses a relative write that lands outside from there", () => {
    outside("cd /tmp && echo x > y");
    outside("(cd /tmp; echo x > y)");
    outside("pushd /tmp && echo x > y");
    outside("pnpm -C /tmp exec sh -c 'echo x > y'");
    outside("env -C /tmp cp a b");
  });

  it("allows an absolute in-worktree write from there", () => {
    allowed(`cd /tmp && echo x > ${AYO6_ROOT}/y`);
    allowed(`pnpm -C /tmp exec sh -c 'echo x > ${AYO6_ROOT}/y'`);
  });

  it("still refuses the rest of a command after a move it cannot resolve", () => {
    for (const command of [
      "cd $ELSEWHERE && node --version",
      "cd - && node --version",
      "cd ~someone && node --version",
      "popd && node --version",
      "cd $(mktemp -d) && node --version",
    ]) {
      const found = hits(command).filter((hit) => hit.action === "write_outside_worktree");
      expect(found.length, command).toBeGreaterThan(0);
      expect(found[0]?.detail, command).toMatch(/cannot be resolved/);
    }
  });

  it("keeps a move inside the worktree doing what it did", () => {
    allowed("cd deep && echo x > ../real.txt");
    allowed("cd packages/runner && pnpm exec vitest run > ../../vitest.log 2>&1");
    outside("cd packages/runner && git show HEAD > ../../../escape.txt");
  });
});

describe("a `cd` inside `eval`", () => {
  it("moves the rest of the line, because eval runs in the current shell", () => {
    outside('eval "cd /tmp" && echo x > y');
    outside("eval cd /tmp; echo x > y");
    outside("pnpm exec -c 'eval cd /tmp; echo x > y'");
  });

  it("leaves an absolute in-worktree write after it allowed", () => {
    allowed(`eval "cd /tmp" && echo x > ${AYO6_ROOT}/y`);
    allowed("eval cd packages/runner && echo x > ../../real.txt");
  });

  it("refuses the rest by name when the evaluated move cannot be resolved", () => {
    const found = hits("eval cd $ELSEWHERE && echo x > y").filter(
      (hit) => hit.action === "write_outside_worktree",
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((hit) => /cannot be resolved/.test(hit.detail))).toBe(true);
  });
});

describe("a `cd` inside a `( … )` subshell", () => {
  it("does not move what follows the closing parenthesis", () => {
    allowed(`(cd /tmp && node ${AYO6_ROOT}/apps/cli/dist/main.js doctor) > doctor.log`);
    allowed(`(cd /tmp && node ${AYO6_ROOT}/apps/cli/dist/main.js doctor); echo done > status.txt`);
    allowed("(cd /tmp) && echo x > y");
  });

  it("still judges the writes inside it from where the subshell moved", () => {
    const found = hits("(cd /tmp && echo x > y) > log.txt").filter(
      (hit) => hit.action === "write_outside_worktree",
    );
    // The detail carries the whole segment after the colon, so the assertion
    // is on the part before it: the target refused is `y`, not `log.txt`.
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toMatch(/^the redirect target y resolves to \S*\/tmp\/y, outside/);
  });
});
