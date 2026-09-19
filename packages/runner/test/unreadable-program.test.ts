import { describe, expect, it } from "vitest";
import { ADMISSION_RULES, judgeCommand } from "../src/admission.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../src/profile.js";

/**
 * SCP-201 criterion 2: a program the parser cannot read at all.
 *
 * `$(command -v gh) auth login` hides `gh` from every list: the resolver reads
 * the program position as the literal text `$(command -v gh)`, so `Bash(gh
 * auth:*)` never matches it and no write target exists to judge either — the
 * command silently fell through as "unaccounted" and was, in effect, admitted.
 * This is the fix: a program position the resolver cannot read at all is
 * refused by name, because there is no way to know what will actually run.
 */

const judge = (command: string) =>
  judgeCommand({
    tool: "Bash",
    detail: command,
    allow_list: DEFAULT_COMMAND_ALLOW_LIST,
    deny_list: DEFAULT_COMMAND_DENY_LIST,
    scope: { root: "/tmp/perbo-scp201-fixture", home: "/Users/nobody" },
  }).admission;

describe("a program position the resolver cannot read", () => {
  it("refuses a `$(…)` substitution standing where the verb should be", () => {
    const admission = judge("$(command -v gh) auth login");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.unreadable_program);
    expect(admission.target).toBe("$(command -v gh)");
    expect(admission.reason ?? "").toContain("$(command -v gh)");
    expect(admission.reason ?? "").toContain("cannot be read");
  });

  it("refuses the same shape written with backticks", () => {
    const admission = judge("`command -v gh` auth login");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.unreadable_program);
    expect(admission.target).toBe("`command -v gh`");
  });

  it("refuses `eval` of a variable, under the same rule as the bare form", () => {
    const admission = judge("eval $CMD");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.unreadable_program);
    expect(admission.target).toBe("$CMD");
  });

  it("refuses `eval` of a substitution", () => {
    const admission = judge("eval $(command -v gh) auth login");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.unreadable_program);
  });

  it("refuses `exec` of a variable", () => {
    const admission = judge("exec $CMD");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.unreadable_program);
    expect(admission.target).toBe("$CMD");
  });

  it("refuses `exec` of a substitution — the exact shape SCP-201 was opened for", () => {
    const admission = judge("exec $(command -v gh) auth login");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.unreadable_program);
    expect(admission.target).toBe("$(command -v gh)");
  });

  it("refuses it wherever a wrapper puts it, the way the deny-list already does", () => {
    const admission = judge("env $(command -v gh) auth login");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.unreadable_program);
  });
});

/**
 * What the resolver already did with a substitution before this ticket, and
 * must keep doing: read it as data when it stands as an argument rather than
 * as the program itself. Written from the resolver's behaviour today, not
 * from what it should do, so it pins the boundary of the new rule rather than
 * guessing it.
 */
describe("a substitution in argument position, unaffected", () => {
  it("`$(pwd)` as a plain argument is not a program and stays admitted", () => {
    const admission = judge("echo $(pwd)");
    expect(admission.decision).toBe("allowed");
  });

  it("`$(pwd)` as a `cd` target is still read as an unresolvable path, not as a program", () => {
    const admission = judge("cd $(pwd)");
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.write);
  });

  it("a write hidden inside an argument's substitution is still the write rule, not this one", () => {
    const admission = judge('echo "$(printf x > /etc/passwd)"');
    expect(admission.decision).toBe("denied");
    expect(admission.rule).toBe(ADMISSION_RULES.write);
  });
});
