import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { inspectCommandWithCwd } from "../../prohibited.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * Where inline code writes, and only where it writes.
 *
 * A string in inline code is a write destination only where it is the target
 * of a write: an operand of a write call, or a redirect or a writer inside a
 * command the code spawns. The interpreter a spawn uses, the directory it runs
 * in, a file the code reads and a URL it fetches are not writes, and a finding
 * that says they are ends an attempt that wrote nothing: `{shell:'/bin/zsh'}`
 * in a `command -v` probe is a shell to run, and the registry URL an
 * `https.get` fetches is a resource to read.
 */

const ROOT = realpathSync(scratch("perbo-inline-code-root-"));
mkdirSync(join(ROOT, "src"), { recursive: true });

/** A contract that admits writes under `src/` only, as a ticket's does. */
const SCOPE = { root: ROOT, home: "/Users/nobody", paths_allowed: ["src/**"] };

const findings = (command: string) => inspectCommandWithCwd(command, SCOPE).writes;

/** The findings that place a write, which are the ones that end an attempt. */
const shown = (command: string) =>
  findings(command).filter((finding) => (finding.cause ?? "outside_target") === "outside_target");

/** A `command -v` probe under a named shell, and a registry fetch. */
const COMMAND_V_PROBE = `node -e "const{execSync}=require('child_process');for(const c of ['playwright','python3','deno','bun','open']){try{console.log(c, execSync('command -v '+c,{shell:'/bin/zsh'}).toString().trim())}catch(e){}}"`;
const REGISTRY_FETCH = `node -e "const https=require('https');const r=https.get('https://registry.npmjs.org/jsdom',{timeout:8000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{console.log(JSON.parse(d)['dist-tags'])})});r.on('error',e=>console.log(e.message))"`;

describe("a string that is not the target of a write", () => {
  it("does not read the shell a spawn runs with as a write", () => {
    expect(shown(COMMAND_V_PROBE)).toEqual([]);
  });

  it("does not read a URL as a path", () => {
    expect(shown(REGISTRY_FETCH)).toEqual([]);
  });

  it("still refuses both, as programs it cannot show write nothing", () => {
    // Neither `child_process` nor `https` is on the read-only table, so the
    // command is refused before it runs, as a program it cannot read rather
    // than as a write it never saw.
    for (const command of [COMMAND_V_PROBE, REGISTRY_FETCH]) {
      const found = findings(command);
      expect(found.length, command).toBe(1);
      expect(found[0]?.cause, command).toBe("unreadable_program");
    }
  });

  const none: Array<[string, string]> = [
    ["a `cwd` option", `node -e "require('child_process').execSync('ls', {cwd: '/tmp'})"`],
    ["a `shell` option", `node -e "require('child_process').execSync('ls', {shell: '/bin/bash'})"`],
    ["a Python `cwd`", `python3 -c "import subprocess; subprocess.run(['ls'], cwd='/tmp')"`],
    ["a read with `readFileSync`", `node -e "console.log(require('fs').readFileSync('/etc/hosts','utf8'))"`],
    ["a read with `existsSync`", `node -e "console.log(require('fs').existsSync('/etc/hosts'))"`],
    ["a read with `stat`", `node -e "console.log(require('fs').statSync('/etc/hosts'))"`],
    ["an `open` in a read mode", `python3 -c "print(open('/etc/passwd','r').read())"`],
    ["an `open` with no mode", `python3 -c "print(open('/etc/passwd').read())"`],
    ["a spawned `command -v`", `node -e "require('child_process').execSync('command -v node')"`],
    ["a spawned read", `python3 -c "import subprocess; subprocess.run(['cat', '/etc/hosts'])"`],
    ["a path it only prints", `node -e "console.log('/etc/hosts')"`],
    ["a shebang it only prints", `python3 -c "print('#!/usr/bin/env python3')"`],
    ["a path in a position this reading does not know", `node -e "const x = require('some-lib'); x.frob('/etc/hosts')"`],
    ["a URL as a spawn's `cwd`", `node -e "require('child_process').execSync('ls', {cwd: 'https://example.com'})"`],
    ["`remove` on a list", `python3 -c "xs = ['/etc/hosts']; xs.remove('/etc/hosts')"`],
  ];

  for (const [name, command] of none) {
    it(`places no write for ${name}`, () => {
      expect(shown(command), command).toEqual([]);
    });
  }
});

describe("a string that is the target of a write", () => {
  const outside: Array<[string, string, string]> = [
    ["`writeFileSync`", `node -e "require('fs').writeFileSync('/etc/hosts','x')"`, "/etc/hosts"],
    ["`open` for writing", `python3 -c "open('/etc/passwd','w').write('x')"`, "/etc/passwd"],
    ["`open` with a `mode=`", `python3 -c "open('/etc/passwd', mode='a')"`, "/etc/passwd"],
    ["a spawned `rm`", `node -e "require('child_process').execSync('rm -rf /tmp/x')"`, "/tmp/x"],
    ["a spawned argv", `python3 -c "import subprocess; subprocess.run(['rm', '-rf', '/tmp/x'])"`, "/tmp/x"],
    ["a spawned redirect", `node -e "require('child_process').execSync('echo x > /tmp/x')"`, "/tmp/x"],
    ["`shutil.rmtree`", `python3 -c "import shutil; shutil.rmtree('/tmp/x')"`, "/tmp/x"],
    ["`shutil.copy`'s destination", `python3 -c "import shutil; shutil.copy('src/a', '/tmp/x')"`, "/tmp/x"],
    ["`os.remove`", `python3 -c "import os; os.remove('/tmp/x')"`, "/tmp/x"],
    ["`os.makedirs` under an alias", `python3 -c "import os as o; o.makedirs('/tmp/x')"`, "/tmp/x"],
    ["a destructured `rmSync`", `node -e "const {rmSync: gone} = require('node:fs'); gone('/tmp/x')"`, "/tmp/x"],
    ["`fs.promises.writeFile`", `node -e "fs.promises.writeFile('/tmp/x', 'y')"`, "/tmp/x"],
    ["`Path.unlink`", `python3 -c "import pathlib; pathlib.Path('/tmp/x').unlink()"`, "/tmp/x"],
    ["a bound `Path`'s `write_text`", `python3 -c "from pathlib import Path; p = Path('/tmp/x'); p.write_text('y')"`, "/tmp/x"],
    ["`__import__('os').remove`", `python3 -c "__import__('os').remove('/tmp/x')"`, "/tmp/x"],
    ["a spawn in a named `cwd`", `node -e "require('child_process').execSync('rm x', {cwd: '/tmp'})"`, "/tmp/x"],
    ["a relative write after `chdir`", `python3 -c "import os; os.chdir('/tmp'); open('x', 'w')"`, "/tmp/x"],
    ["a Ruby backtick", "ruby -e '`rm -rf /tmp/x`'", "/tmp/x"],
    ["an `awk` redirect", `awk '{print > "/tmp/x"}' src/a.txt`, "/tmp/x"],
    ["an `awk` `system`", `awk '{system("rm /tmp/x")}' src/a.txt`, "/tmp/x"],
  ];

  for (const [name, command, path] of outside) {
    it(`places ${name} outside the worktree`, () => {
      const placed = shown(command);
      expect(placed.length, command).toBeGreaterThan(0);
      expect(placed[0]?.rule, command).toBe("write_outside_worktree");
      expect(placed[0]?.resolved, command).toContain(path);
    });
  }

  it("places a write inside the worktree against the contract", () => {
    const placed = shown(`node -e "require('fs').writeFileSync('docs/a.md', 'x')"`);
    expect(placed.length).toBe(1);
    expect(placed[0]?.rule).toBe("write_outside_scope");
    expect(placed[0]?.target).toBe("docs/a.md");
  });

  it("admits a write the contract admits", () => {
    expect(findings(`node -e "fs.writeFileSync('src/a.ts', 'x')"`)).toEqual([]);
  });
});

/**
 * A write call takes its target as a path, never a URL: `https://x/y` is a
 * directory called `https:` below where the code runs, and on Windows
 * `C://Users/a` is the drive's own `Users`. Each is judged where it lands.
 */
describe("a URL-shaped string given to a write call", () => {
  mkdirSync(join(ROOT, ".perbo"), { recursive: true });
  mkdirSync(join(ROOT, "specs"), { recursive: true });
  const PROHIBITED = { root: ROOT, home: "/Users/nobody", paths_prohibited: [".perbo/**"] };
  const placed = (command: string, scope: Parameters<typeof inspectCommandWithCwd>[1]) =>
    inspectCommandWithCwd(command, scope).writes.filter(
      (finding) => (finding.cause ?? "outside_target") === "outside_target",
    );

  it("is judged as a path inside the worktree, and refused outside the contract", () => {
    for (const command of [
      `node -e "require('fs').writeFileSync('https://example.com/x', 'y')"`,
      `node -e "fs.writeFileSync('https://x/y','z')"`,
      `python3 -c "open('file:///etc/hosts', 'w')"`,
    ]) {
      expect(placed(command, SCOPE).map((finding) => finding.rule), command).toEqual(["write_outside_scope"]);
    }
  });

  it("is refused where it lands in a prohibited path", () => {
    for (const command of [
      `cd .perbo && node -e "fs.writeFileSync('https://x/y','z')"`,
      `cd specs && python3 -c "open('file:///y','w')"`,
    ]) {
      expect(placed(command, PROHIBITED).map((finding) => finding.rule), command).toEqual([
        "write_prohibited_path",
      ]);
    }
  });

  it("is a drive path under Windows semantics, refused outside the worktree", () => {
    const windows = { root: String.raw`C:\Users\a\wt`, home: String.raw`C:\Users\a`, semantics: "windows" as const };
    for (const [command, path] of [
      [`node -e "fs.writeFileSync('C://Users/a/.ssh/authorized_keys','y')"`, "C:/Users/a/.ssh/authorized_keys"],
      [`python3 -c "open('C://Users/a/x.txt','w')"`, "C:/Users/a/x.txt"],
    ] as const) {
      const found = placed(command, windows);
      expect(found.map((finding) => finding.rule), command).toEqual(["write_outside_worktree"]);
      expect(found[0]?.resolved, command).toBe(path);
    }
  });
});
