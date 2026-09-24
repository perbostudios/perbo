import { describe, expect, it } from "vitest";
import { everySegment, readCommandLine, resolveScope } from "./index.js";

/**
 * A substitution is a command the shell runs before the one it stands in:
 * `echo "$(mail -s hi a@b)"` runs `mail`, and `echo <(rm -rf ~/x)` runs `rm`.
 * The reading keeps each body as a segment of its own in `substitutions`,
 * with its own programs, and hands the segment it stands in the body's
 * findings, invocations, unreadable programs and whether it was accounted
 * for — so a caller asking what a line runs walks to it, and the segment's
 * own programs stay the ones its own command runs.
 */

const scope = resolveScope({ root: "/work/tree", home: "/Users/nobody" });

/** Every program the line runs, at any depth. */
const runs = (command: string) =>
  everySegment(readCommandLine(command, scope).segments).flatMap((segment) => segment.programs);

/** The programs of the line's own segments, without their substitutions. */
const own = (command: string) =>
  readCommandLine(command, scope).segments.flatMap((segment) => segment.programs);

const resolved = (command: string) =>
  readCommandLine(command, scope).findings.map((finding) => finding.resolved);

describe("the programs a substitution runs", () => {
  for (const [command, program] of [
    ['echo "$(mail -s hi a@b </dev/null)"', "mail"],
    ["echo `mail -s hi a@b </dev/null`", "mail"],
    ["status=$(mail -s hi a@b </dev/null)", "mail"],
    ["true $(sendmail -t < m.eml)", "sendmail"],
    ["echo <(mail -s hi a@b </dev/null)", "mail"],
    ["diff <(ls) <(mail -s hi a@b)", "mail"],
    ["while read l; do echo $l; done < <(mail -s hi a@b)", "mail"],
    ['cat < "$(mail -s hi a@b)"', "mail"],
    ['cat <<< "$(mail -s hi a@b)"', "mail"],
    ["cat <<EOF\n$(mail -s hi a@b)\nEOF", "mail"],
    ["tee >(mail -s hi a@b) < notes.md", "mail"],
    ["echo $((mail -s hi a@b) ; (true))", "mail"],
    ["echo $((true) && (mail -s hi a@b))", "mail"],
    ["cat <<EOF\n$((mail -s hi a@b) ; (true))\nEOF", "mail"],
    ["echo `echo \\`mail -s hi a@b\\``", "mail"],
    ["rg --pre mail pattern src", "mail"],
    ["rg --pre=/usr/bin/mail pattern src", "mail"],
  ] as const) {
    it(`reads \`${command.replace(/\n/g, "⏎")}\` as running ${program}`, () => {
      expect(runs(command), command).toContain(program);
    });
  }

  it("keeps the body as a segment of its own, out of the segment's own programs", () => {
    const [segment] = readCommandLine('echo "$(mail -s hi a@b)"', scope).segments;
    expect(segment!.programs).toEqual(["echo"]);
    expect(segment!.substitutions.map((inner) => inner.text)).toEqual(["mail -s hi a@b"]);
    expect(segment!.substitutions[0]!.programs).toEqual(["mail"]);
    expect(segment!.invocations).toContain("mail -s hi a@b");
  });

  it("does not hand the body's writes to the segment as its own verb", () => {
    const [segment] = readCommandLine("echo $(rm -f notes.md)", scope).segments;
    expect(segment!.mutating).toBe(false);
    expect(segment!.substitutions[0]!.mutating).toBe(true);
  });

  it("hands the segment a body it could not account for", () => {
    const [segment] = readCommandLine('echo "$(sh notify.sh)"', scope).segments;
    expect(segment!.accounted).toBe(false);
  });

  it("reads a quoted here-document's body as data, and an escaped `$(` as text", () => {
    expect(runs("cat <<'EOF'\n$(mail -s hi a@b)\nEOF")).not.toContain("mail");
    expect(runs("cat <<EOF\n\\$(mail -s hi a@b)\nEOF")).not.toContain("mail");
  });

  it("reads `command -v` as a lookup, which runs nothing", () => {
    expect(own('echo "$(command -v mail)"')).toEqual(["echo"]);
    expect(runs('echo "$(command -v mail)"')).toEqual(["echo"]);
    expect(own("command -V mail")).toEqual([]);
    expect(own("command -p mail -s hi a@b")).toEqual(["mail"]);
  });

  it("reads arithmetic as arithmetic where the inner group closes at the end", () => {
    expect(runs("echo $((1 + 2))")).toEqual(["echo"]);
    expect(runs("echo $(( (1 + 2) * 3 ))")).toEqual(["echo"]);
    expect(runs("echo $(( $(mail -s hi a@b) + 1 ))")).toContain("mail");
  });
});

describe("the writes a substitution makes", () => {
  it("finds the write in `echo <(rm -rf ~/x)`", () => {
    expect(resolved("echo <(rm -rf ~/x)")).toEqual(["/Users/nobody/x"]);
  });

  it("finds the write in `cat < <(rm -rf ~/x)`", () => {
    expect(resolved("cat < <(rm -rf ~/x)")).toEqual(["/Users/nobody/x"]);
  });

  it("finds the write in a body that nests parentheses", () => {
    expect(resolved("echo <( (rm -rf ~/x) )")).toEqual(["/Users/nobody/x"]);
  });

  it("finds the write in `$((a) ; (b))`, which is a command substitution", () => {
    expect(resolved("echo $((rm -rf ~/x) ; (true))")).toEqual(["/Users/nobody/x"]);
    expect(resolved("echo $((true) && (rm -rf ~/x))")).toEqual(["/Users/nobody/x"]);
    expect(resolved("cat <<EOF\n$((rm -rf ~/x) ; (true))\nEOF")).toEqual(["/Users/nobody/x"]);
  });

  it("finds the write behind an escaped backtick, which nests a substitution", () => {
    expect(resolved("echo `echo \\`rm -rf ~/x\\``")).toEqual(["/Users/nobody/x"]);
    const [segment] = readCommandLine("echo `echo \\`rm -rf ~/x\\``", scope).segments;
    expect(segment!.accounted).toBe(true);
  });

  it("reads `< <(…)` as input nothing on the line spells, not as a script file", () => {
    // An interpreter handed a script file is left to whoever reads files; one
    // reading a process substitution's output runs a program built at run time.
    const read = readCommandLine("python3 < <(echo 'print(1)')", scope);
    expect(read.findings.map((finding) => finding.detail).join("\n")).toMatch(
      /python3 reads from < <\(echo 'print\(1\)'\) cannot be read/,
    );
  });

  it("still refuses an output process substitution as a redirect it cannot place", () => {
    const read = readCommandLine("echo x > >(cat)", scope);
    expect(read.findings.map((finding) => finding.detail).join("\n")).toMatch(/process substitution/);
  });

  it("leaves a body that writes inside the worktree with no finding", () => {
    expect(readCommandLine("echo <(rm -f notes.md)", scope).findings).toEqual([]);
  });
});

describe("the command `rg --pre` runs", () => {
  it("is the program over the paths the search reads", () => {
    expect(resolved("rg --pre rm x ~/victim")).toEqual(["/Users/nobody/victim"]);
    expect(resolved("rg -n --pre=rm -g '*.ts' x src ~/victim")).toEqual(["/Users/nobody/victim"]);
    expect(resolved("rg --pre rm -e x ~/victim")).toEqual(["/Users/nobody/victim"]);
  });

  it("reads the whole search as the program's operand where no path is named", () => {
    const [segment] = readCommandLine("rg --pre rm x", scope).segments;
    expect(segment!.mutating).toBe(true);
    expect(segment!.programs).toEqual(["rg", "rm"]);
    expect(resolved("rg --pre rm x")).toEqual([]);
  });

  it("refuses a program built at run time", () => {
    const [segment] = readCommandLine("rg --pre $P x", scope).segments;
    expect(segment!.unreadablePrograms).toEqual(["$P"]);
  });

  it("leaves a search with no preprocessor as a search", () => {
    const [segment] = readCommandLine("rg -n mail /tmp/elsewhere", scope).segments;
    expect(segment!.programs).toEqual(["rg"]);
    expect(segment!.mutating).toBe(false);
  });
});
