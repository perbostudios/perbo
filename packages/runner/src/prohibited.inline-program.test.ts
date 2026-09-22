import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { inspectCommand, inspectCommandWithCwd } from "./prohibited.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * SCP-234: an inline program whose file access is plain, and where it lands.
 *
 * Ticket 4's attempt read one file inside its own worktree and printed it. The
 * pre-execution hook allowed it and it ran; the transcript's second reading
 * then judged the program against the read-only vocabulary, found `for` was not
 * a name that table knows, and ended the attempt as `write_outside_worktree`
 * with the detail "not a shape this guard can show writes nothing". Nothing was
 * written anywhere and the round was lost.
 *
 * The reading this file pins asks the question the rule is actually about:
 * where the program's file operations land. A plain `open`, `Path(…).write_text`
 * or `writeFileSync` on a literal path is judged by that path, and the
 * statements around it — `for`, `if`, an import, a `json.load`, a `print` — are
 * not what decides it.
 */

const ROOT = realpathSync(scratch("perbo-scp234-root-"));
const OUTSIDE = realpathSync(scratch("perbo-scp234-out-"));

mkdirSync(join(ROOT, "backlog"), { recursive: true });
writeFileSync(join(ROOT, "backlog", "issues.json"), '{"issues": []}\n');
writeFileSync(join(ROOT, "notes.md"), "notes\n");

const hits = (command: string) => inspectCommand(command, { root: ROOT, home: "/Users/nobody" });

const writes = (command: string) =>
  inspectCommandWithCwd(command, { root: ROOT, home: "/Users/nobody" }).writes;

/** The program AYO-43's attempt was terminated for, exactly as it was typed. */
const TICKET_FOUR = [
  "python3 - <<'PY'",
  "import json",
  "d=json.load(open('backlog/issues.json'))",
  "for i in d['issues']:",
  "    if i['id'] in ('SCP-146','SCP-133'):",
  "        print(json.dumps(i,indent=2,ensure_ascii=False))",
  "PY",
].join("\n");

describe("a program that reads one file inside the worktree", () => {
  it("reads ticket 4's program as reading inside the worktree, with no finding", () => {
    expect(hits(TICKET_FOUR)).toEqual([]);
  });

  it("reads the same program handed over on `-c`", () => {
    const code = [
      "import json",
      "d=json.load(open('backlog/issues.json'))",
      "for i in d['issues']:",
      "    print(json.dumps(i,indent=2))",
    ].join("\n");
    expect(hits(`python3 -c "${code}"`)).toEqual([]);
  });

  it("still refuses the same shape reading a file outside the worktree", () => {
    const command = TICKET_FOUR.replace("backlog/issues.json", `${OUTSIDE}/issues.json`);
    const found = writes(command);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.detail).toContain("outside the worktree");
    expect(found[0]?.cause ?? "outside_target").toBe("outside_target");
  });
});

describe("a plain write call, judged by where its literal path lands", () => {
  const inside: Array<[string, string]> = [
    ["open", `python3 -c "open('notes.md','w')"`],
    ["open, appending", `python3 -c "open('notes.md','a')"`],
    ["Path.write_text", `python3 -c "import pathlib; pathlib.Path('notes.md').write_text('x')"`],
    ["writeFileSync", `node -e "fs.writeFileSync('notes.md','x')"`],
  ];

  for (const [name, command] of inside) {
    it(`allows \`${name}\` on a path inside the worktree`, () => {
      expect(hits(command), command).toEqual([]);
    });
  }

  const outside: Array<[string, string]> = [
    ["open", `python3 -c "open('/etc/hosts','w')"`],
    ["Path.write_text", `python3 -c "import pathlib; pathlib.Path('/etc/hosts').write_text('x')"`],
    ["writeFileSync", `node -e "fs.writeFileSync('/etc/hosts','x')"`],
  ];

  for (const [name, command] of outside) {
    it(`refuses \`${name}\` on a path outside it, as a shown write`, () => {
      const found = writes(command);
      expect(found.length, command).toBeGreaterThan(0);
      const shown = found.filter((finding) => (finding.cause ?? "outside_target") === "outside_target");
      expect(shown.length, command).toBeGreaterThan(0);
      expect(shown[0]?.detail, command).toContain("/etc/hosts");
    });
  }

  it("refuses a destination the program does not spell as a literal", () => {
    expect(hits(`python3 -c "open(target, 'w')"`).length).toBeGreaterThan(0);
    expect(hits(`python3 -c "print(open('notes.md', mode='w'))"`).length).toBeGreaterThan(0);
  });

  it("leaves everything else the table cannot vouch for refused", () => {
    for (const command of [
      `python3 -c "import os; os.remove('notes.md')"`,
      `python3 -c "import shutil; shutil.copy('notes.md','b')"`,
      `python3 -c "open('notes.md','w').write('x')"`,
      `node -e 'fs.appendFileSync("notes.md","x")'`,
      `ruby -e "File.write('notes.md','y')"`,
      `python3 -c "os.system('ls')"`,
    ]) {
      expect(hits(command).length, command).toBeGreaterThan(0);
    }
  });
});

/**
 * The two causes a `write_outside_worktree` finding can have, kept apart.
 *
 * One shows a write landing outside the worktree. The other shows nothing at
 * all: the guard could not classify the program, which is a refusal of that
 * command and not evidence that anything was written.
 */
describe("what the finding says it is", () => {
  it("marks a program it cannot classify as unreadable, not as a shown write", () => {
    const found = writes(`python3 -c "import os; os.remove('notes.md')"`);
    expect(found.length).toBe(1);
    expect(found[0]?.cause).toBe("unreadable_program");
    expect(found[0]?.detail).toContain("python3");
  });

  it("marks a resolved path outside the worktree as a shown write", () => {
    const found = writes(`printf x > ${OUTSIDE}/evidence.txt`);
    expect(found.length).toBe(1);
    expect(found[0]?.cause ?? "outside_target").toBe("outside_target");
    expect(found[0]?.resolved).toContain(OUTSIDE);
  });

  it("marks a program built at run time as unreadable too", () => {
    const found = writes(`python3 -c "$CODE"`);
    expect(found.length).toBe(1);
    expect(found[0]?.cause).toBe("unreadable_program");
  });
});
