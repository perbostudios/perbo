import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { inspectCommand } from "../src/prohibited.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * SCP-190: inline code is allowed only where the guard can show it writes
 * nothing.
 *
 * SCP-161 read inline code against a list of calls that write, allow-by-default.
 * That list is finite and the ways a program can reach the filesystem are not,
 * so the stand-in's review of #325 found eight shapes it had never heard of and
 * therefore let through — `os.remove` reached through `__import__`, `os.replace`
 * and `shutil.move`, Ruby's `File.delete` and `FileUtils.rm_rf`, Perl's `open`
 * with a `>` mode and its backtick spawn, `Deno.remove`. Each is refused here,
 * and none of them is refused by name: they are refused because the read-only
 * table does not name them, which is the same reason the ninth shape nobody has
 * thought of yet will be refused.
 *
 * The other direction is the constraint that makes the first one shippable. A
 * guard that refuses `print(1+1)` is a guard that gets waived, so the lines an
 * attempt actually types are pinned as allowed alongside.
 */

const ROOT = realpathSync(scratch("perbo-scp190-root-"));
const OUTSIDE = realpathSync(scratch("perbo-scp190-out-"));

mkdirSync(join(ROOT, "src"), { recursive: true });
writeFileSync(join(ROOT, "package.json"), '{"name": "fixture"}\n');
writeFileSync(join(ROOT, "notes.md"), "notes\n");

const writes = (command: string) =>
  inspectCommand(command, { root: ROOT, home: "/Users/nobody" }).filter(
    (hit) => hit.action === "write_outside_worktree",
  );

const hits = (command: string) => inspectCommand(command, { root: ROOT, home: "/Users/nobody" });

/** Refused, and the record says which interpreter was going to run it. */
const refusedNaming = (command: string, interpreter: string) => {
  const found = writes(command);
  expect(found.length, command).toBeGreaterThan(0);
  expect(found.map((hit) => hit.detail).join("\n"), command).toContain(interpreter);
};

/**
 * The eight shapes the stand-in found on 2026-09-04, every one of them allowed
 * by the deny-list reading and every one of them refused by this one.
 */
describe("a filesystem or process call the table never heard of", () => {
  const GAPS: Array<[string, string]> = [
    [`python3 -c "__import__('os').remove(chr(47)+'x')"`, "python3"],
    [`python3 -c "__import__('os').replace('a', 'b')"`, "python3"],
    [`python3 -c "__import__('shutil').move('a', 'b')"`, "python3"],
    [`ruby -e "File.delete('x')"`, "ruby"],
    [`ruby -e "FileUtils.rm_rf('x')"`, "ruby"],
    [`perl -e 'open(my $fh, ">", $p)'`, "perl"],
    ["perl -e '`rm -rf x`'", "perl"],
    [`deno eval "Deno.remove('x')"`, "deno"],
  ];

  for (const [command, interpreter] of GAPS) {
    it(`refuses ${command}, naming ${interpreter}`, () => {
      refusedNaming(command, interpreter);
    });
  }

  it("says what it was that the table did not know, so the line can be rewritten", () => {
    const detail = writes(`python3 -c "__import__('os').remove(chr(47)+'x')"`)
      .map((hit) => hit.detail)
      .join("\n");
    expect(detail).toContain("__import__");
    expect(detail).toContain("not a call the read-only table names");
  });

  it("names the backtick rather than the command inside it", () => {
    expect(writes("perl -e '`rm -rf x`'")[0]?.detail).toContain("backtick");
    // And a JavaScript template literal, which is the same character meaning a
    // string, stays on the allowed side.
    expect(hits("node -e 'const x = `a`; console.log(x)'")).toEqual([]);
  });

  it("reaches the same shapes through standard input, as `-c` code is reached", () => {
    refusedNaming(["python3 <<'PY'", "__import__('os').remove('x')", "PY"].join("\n"), "python3");
    refusedNaming(`python3 <<< "__import__('os').remove('x')"`, "python3");
    refusedNaming(`echo "__import__('os').remove('x')" | python3`, "python3");
  });
});

/**
 * The ways round the table, none of which is on it.
 *
 * `import os` is admitted — the module list carries it so `os.environ.get` can
 * be written — and the call list is what keeps that from meaning `os.remove`.
 * These are the shapes that test where that line actually falls: an alias, a
 * `from … import`, a value passed through a local name, a subscript instead of
 * an attribute, an attribute on a `Path` this scan cannot type. Every one of
 * them is refused, and not one of them is refused by name.
 */
describe("the reach-arounds, refused because the table does not name them", () => {
  for (const command of [
    `python3 -c "import os; os.remove('x')"`,
    `python3 -c "import os as o; o.remove('y')"`,
    `python3 -c "from os import remove; remove('y')"`,
    `python3 -c "x = os; x.remove('y')"`,
    `python3 -c "import pathlib; p = pathlib.Path('a'); p.replace('b')"`,
    `python3 -c "import pathlib; p = pathlib.Path('a'); p.unlink()"`,
    `python3 -c "f = open('x'); f.write('y')"`,
    `python3 -c "print(open('x', mode='w'))"`,
    `python3 -c "exec('import os')"`,
    `python3 -c "import json; json.dump({}, open('x','w'))"`,
    `node -e "require('fs')['rmSync']('x')"`,
    `node -e "import('fs').then(f => f.rmSync('x'))"`,
    // A plain write reached through a local name. Since SCP-234 the call is one
    // the guard reads, so what refuses it is where it writes rather than the
    // shape it is written in — and outside the root is still refused.
    `node -e "const p = require('node:path'); p.writeFileSync('${OUTSIDE}/x','y')"`,
    `ruby -e "IO.write('x','y')"`,
    `perl -e 'system("rm x")'`,
    "awk '{system(\"rm x\")}' src/index.ts",
    `osascript -e 'do shell script "rm x"'`,
  ]) {
    it(`refuses ${command}`, () => {
      expect(writes(command).length, command).toBeGreaterThan(0);
    });
  }
});

/**
 * The lines SCP-190's third criterion names, and the ones the suites around it
 * already ran. A read-only table that refuses these is not shippable.
 */
describe("the read-only shapes, still allowed", () => {
  for (const command of [
    // The three the ticket names.
    `python3 -c "print(1+1)"`,
    `node -e "console.log(process.version)"`,
    `python3 -c "import json,sys; print(json.load(open('package.json'))['name'])"`,
    // Printing, arithmetic and strings.
    `python3 -c "print(2 ** 8)"`,
    `python3 -c "print(len('abc'))"`,
    `python3 -c "print(' '.join(['a', 'b']))"`,
    `node -e "console.log(1 + 1)"`,
    `node -e 'process.stdout.write("ok")'`,
    `perl -e 'print 1'`,
    `ruby -e "puts 1 + 1"`,
    "awk '{print $1}' src/index.ts",
    "awk -F, '{print $2}' src/data.csv",
    // JSON, in both languages.
    `python3 -c "import json; print(json.dumps({'a': 1}))"`,
    `node -e "console.log(JSON.stringify({a: 1}))"`,
    // Reading a file inside the root.
    `python3 -c "print(open('package.json').read())"`,
    `python3 -c "import pathlib; print(pathlib.Path('notes.md').read_text())"`,
    `node -e "console.log(require('node:path').join('a', 'b'))"`,
    // Version and environment queries.
    `node -p "process.version"`,
    `python3 -c "import sys; print(sys.version)"`,
    `python3 -c "import os; print(os.environ.get('HOME'))"`,
    `python3 -c "import platform; print(platform.python_version())"`,
    // Binding a name to a read-only expression.
    `node -e "const x = 1 + 1; console.log(x)"`,
    // The same shapes arriving on standard input.
    ["python3 <<'PY'", "import json", "print(json.dumps({'a': 1}))", "PY"].join("\n"),
    `python3 <<< "print(1)"`,
    `echo "print(1 + 1)" | python3`,
    // An interpreter given no program at all, and one given a file.
    "python3 --version",
    "python3 scripts/report.py",
    "node scripts/build.js",
  ]) {
    it(`allows ${command.replaceAll("\n", " ⏎ ")}`, () => {
      expect(hits(command), command).toEqual([]);
    });
  }
});

/**
 * The two halves of the reading, kept apart.
 *
 * A path outside the root refuses on the first pass whatever the code around it
 * does, and a shape the table cannot vouch for refuses on the second whatever
 * paths it names. Asserted separately because a guard that only ever fired on
 * one of them would pass most of the file above.
 */
describe("the pass that refused, and what it said", () => {
  it("refuses a path outside the root even inside an allowed shape", () => {
    const detail = writes(`python3 -c "print(open('${OUTSIDE}/config.json').read())"`)
      .map((hit) => hit.detail)
      .join("\n");
    expect(detail).toContain("outside the worktree");
  });

  it("keeps the write-call sentence for the shapes an agent reaches for", () => {
    // Each destination is a name rather than a literal: the sentence is what a
    // refusal carries where the guard cannot place the write, and a literal
    // path inside the worktree is admitted with nothing to say (SCP-234).
    const sentences: Array<[string, string]> = [
      [`python3 -c "open(target,'w')"`, "opens a file for writing"],
      [`node -e "fs.writeFileSync(target,'x')"`, "writes a file"],
      [`python3 -c "os.system('ls')"`, "spawns a process of its own"],
    ];
    for (const [command, sentence] of sentences) {
      expect(writes(command).map((hit) => hit.detail).join("\n"), command).toContain(sentence);
    }
  });
});
