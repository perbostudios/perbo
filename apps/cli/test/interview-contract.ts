import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InterviewEventSchema, type InterviewEvent } from "@perbo/contracts/interview-protocol";
import { SUBMIT_REVIEW_TOOL, type ModelRequest, type ModelTurn, type ReviewModel } from "@perbo/review";
import { INTERVIEW_SESSION_FILE, INTERVIEW_TOOL_NAMES } from "../src/interview.js";
import { listTickets, readDraftSnapshot, readTicket, storeDir } from "../src/tickets.js";

/**
 * The interview's behaviour, stated once and run once per transport (SCP-312).
 *
 * What the interview is does not depend on what is behind it: the same
 * refusals, the same tools, the same plan edits, the same resume and the same
 * record beside the spec (D-102). So this suite is written in what the session
 * *tries* — a write, a command, one of the interview's own tools — and each
 * transport's harness realises those the way its transport carries them: a
 * permission callback on the Claude Agent SDK, an approval request and a
 * dynamic tool call over the app-server's JSON-RPC on Codex.
 *
 * A case that is only meaningful for one transport is not here. Claude offers
 * every read to the permission callback and Codex answers a read inside its
 * own read-only sandbox, so a read is judged in `interview.test.ts` alone, and
 * each transport's own invocation is judged in its own file.
 */

/** One thing the session tries, in the order the script names them. */
export type ContractStep =
  /** The session says something, which reaches the stream as a message. */
  | { kind: "say"; text: string }
  /** The session writes a file. What it writes lands where the interview admits it. */
  | { kind: "write"; path: string; content: string }
  /** The session runs a command. */
  | { kind: "command"; command: string }
  /** One of the interview's own tools. */
  | { kind: "call"; tool: string; input: Record<string, unknown> };

/** What one decision the transport asked for was answered with. */
export interface ContractDecision {
  /** The call as the interview's rules named it. */
  tool: string;
  behavior: "allow" | "deny";
  /** What an admitted tool of the interview's own answered, as text. Null for the rest. */
  result: string | null;
  isError: boolean;
}

export interface ContractRun {
  code: number;
  out: string[];
  err: string[];
  decisions: ContractDecision[];
}

/** One transport, driven the same way. */
export interface InterviewHarness {
  /** The transport's name, as `--provider` spells it. */
  name: string;
  run(input: {
    repo: string;
    steps: readonly ContractStep[];
    /** Extra argv for the command, after `--repo` and `--spec`. */
    argv?: readonly string[];
    /** The id the transport gives this session back. */
    sessionId?: string;
    /** The spec folder this interview writes. */
    spec?: string;
  }): Promise<ContractRun>;
}

export const SPEC = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues exactly one activation email.
- R2: A duplicate signup inside five minutes queues nothing.

## No-Gos

- Nothing is sent to an address that has unsubscribed.

## Rabbit holes

- The provider's own retry policy.

## Notes

The queue package already has a sender.
`;

export const SPEC_FOLDER = "specs/activation-email";

export const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** A checkout with one package in it, for an interview to read and write beside. */
export function repository(scratch: string): string {
  const repo = mkdtempSync(join(scratch, "repo-"));
  mkdirSync(join(repo, "packages", "queue"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "packages", "queue", "send.ts"), "export const send = () => 1;\n");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: gitIdentity });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { env: gitIdentity });
  return repo;
}

/** The drafter `admit --from-spec` runs, scripted to one draft. */
export function drafter(): ReviewModel {
  let turn = 0;
  return {
    provider: "double",
    model_id: "scripted",
    async turn(_request: ModelRequest): Promise<ModelTurn> {
      turn += 1;
      return {
        toolCalls: [{ id: `t${turn}`, name: SUBMIT_REVIEW_TOOL, input: drafted }],
        usage: {
          input_tokens: 800,
          output_tokens: 150,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: "tool_use",
      };
    },
  };
}

export const drafted = {
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  acceptance_criteria: [
    {
      text: "A signup POST queues exactly one activation email.",
      assertion: "one message is on the queue after a single signup",
      kind: "test",
      requirement_id: "R1",
    },
    {
      text: "A duplicate signup inside five minutes queues nothing.",
      assertion: "a second signup inside the window queues nothing",
      kind: "test",
      requirement_id: "R2",
    },
  ],
  proposed_scope: { paths_allowed: ["packages/queue/**"], paths_prohibited_extra: [] },
  rationale: "Both requirements fall in the queue package.",
  depends_on: [],
  nodes: [
    { title: "Queue the email", criteria: [0], paths: ["packages/queue/**"] },
    { title: "Refuse a duplicate", criteria: [1], paths: ["packages/queue/**"] },
  ],
  edges: [{ from: 0, to: 1 }],
};

/** The events a run streamed, parsed back through the protocol's own schema. */
export function events(run: { out: string[] }): InterviewEvent[] {
  return run.out
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => InterviewEventSchema.parse(JSON.parse(line)));
}

export const refusals = (run: { out: string[] }) =>
  events(run).filter((event) => event.type === "refused");

const writeSpec = (content = SPEC): ContractStep => ({
  kind: "write",
  path: `${SPEC_FOLDER}/spec.md`,
  content,
});
const generate: ContractStep = { kind: "call", tool: "generate_plan", input: {} };

/**
 * The suite, run against one transport.
 *
 * `scratch` is a directory the caller removes; every case makes its own
 * repository under it.
 */
export function describeInterviewContract(harness: InterviewHarness, scratch: () => string): void {
  describe(`the interview on ${harness.name}`, () => {
    const run = (
      repo: string,
      steps: readonly ContractStep[],
      extra: { argv?: readonly string[]; sessionId?: string; spec?: string } = {},
    ) => harness.run({ repo, steps, ...extra });

    describe("the write boundary (D-102)", () => {
      it("refuses a write outside the spec folder, CONTEXT.md and the ADR folder, and reports it", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          { kind: "write", path: "packages/queue/send.ts", content: "hacked\n" },
          { kind: "write", path: "CONTEXT.md", content: "# Terms\n" },
          { kind: "write", path: "docs/adr/0001-queueing.md", content: "# ADR\n" },
        ]);
        expect(result.decisions.map((each) => each.behavior)).toEqual(["deny", "allow", "allow"]);
        // The code was never written, and the person was told why rather than asked.
        expect(readFileSync(join(repo, "packages", "queue", "send.ts"), "utf8")).toContain("() => 1");
        expect(readFileSync(join(repo, "CONTEXT.md"), "utf8")).toContain("# Terms");
        const refused = refusals(result);
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({ rule: "write_outside_scope" });
        expect(refused[0]?.reason).toContain("packages/queue/send.ts");
        const said = result.err.join("").split("\n").filter((line) => line.startsWith("refused:"));
        expect(said).toHaveLength(1);
        expect(said[0]).toContain("packages/queue/send.ts");
        expect(said[0], "a refusal is a statement, not a question").not.toContain("?");
      });

      it("refuses a write to another piece of work's spec", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          { kind: "write", path: "specs/somebody-else/spec.md", content: "# theirs\n" },
        ]);
        expect(result.decisions.map((each) => each.behavior)).toEqual(["allow", "deny"]);
        expect(existsSync(join(repo, "specs", "somebody-else"))).toBe(false);
        expect(refusals(result).at(-1)?.reason).toContain("specs/somebody-else/spec.md");
      });

      it("creates the spec and ADR folders on the first write to them", async () => {
        const repo = repository(scratch());
        expect(existsSync(join(repo, "specs"))).toBe(false);
        expect(existsSync(join(repo, "docs", "adr"))).toBe(false);
        await run(repo, [
          writeSpec(),
          { kind: "write", path: "docs/adr/0001-queueing.md", content: "# ADR\n" },
        ]);
        expect(existsSync(join(repo, SPEC_FOLDER, "spec.md"))).toBe(true);
        expect(existsSync(join(repo, "docs", "adr", "0001-queueing.md"))).toBe(true);
      });

      it("refuses a direct write to the ticket store", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          generate,
          { kind: "write", path: ".perbo/tickets/PRB-1.contract.json", content: "{}" },
        ]);
        expect(result.decisions[2]?.behavior).toBe("deny");
        expect(refusals(result).at(-1)?.rule).toBe("write_prohibited_path");
        expect(
          readFileSync(join(storeDir(repo, null), "tickets", "PRB-1.contract.json"), "utf8"),
        ).toContain("acceptance_criteria");
      });
    });

    describe("commands (D-102)", () => {
      it("refuses a command outside the read-only set and reports it, never asking", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          { kind: "command", command: "rg --files packages" },
          { kind: "command", command: "pnpm install" },
          { kind: "command", command: "git push origin main" },
        ]);
        expect(result.decisions.map((each) => each.behavior)).toEqual(["allow", "deny", "deny"]);
        const refused = refusals(result);
        expect(refused.map((event) => event.rule)).toEqual([
          "command_allow_list",
          "command_deny_list",
        ]);
        expect(refused[0]?.reason).toContain("read-only");
      });

      // A read-only shape is not read-only where a flag turns it into a
      // writer or into a way to run another program (SCP-355). Every
      // spelling a shell admits: the flag attached with `=`, separated, a
      // short cluster where the program has one, and standing after a `--` —
      // nothing here is trusted to be inert there, since this session never
      // asks. Refused before anything runs, so one command's refusal never
      // changes the directory or the tree the next is judged against.
      it("refuses the flags that let a read-only program write or run one, naming the flag", async () => {
        const repo = repository(scratch());
        const commands = [
          "git log --output=notes.txt",
          "git log --output notes.txt",
          "git diff --output=notes.txt",
          "git show --output=notes.txt",
          "git diff --no-index --output=notes.txt a b",
          "git log -- --output=notes.txt",
          "rg --pre evil.sh pattern",
          "rg --pre=evil.sh pattern",
          "find . -delete",
          "find . -fprint out.txt",
          "file -C -m /tmp/x.mgc",
          "file -Cm /tmp/x.mgc",
          // find's own way to run a program: the outcome this whole table is
          // about, whether or not the program it names is one this session
          // may otherwise run on its own — `true` names one it already may,
          // so only the flag itself, not a write the named program makes,
          // is what refuses each of these.
          "find . -exec true ;",
          "find . -execdir true ;",
          "find . -ok true ;",
          "find . -okdir true ;",
          // find's other ways to write a file, beside -delete and -fprint.
          "find . -fls out.txt",
          "find . -fprintf out.txt %p",
          "find . -fprint0 out.txt",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
        // The flag itself is named, not just the program, so a person reads
        // why a `git log` in particular was refused.
        const reasons = refusals(result).map((event) => event.reason);
        expect(reasons[0]).toContain("--output");
        expect(reasons[1]).toContain("--output");
        expect(reasons[2]).toContain("--output");
        expect(reasons[3]).toContain("--output");
        expect(reasons[4]).toContain("--output");
        expect(reasons[5]).toContain("--output");
        expect(reasons[6]).toContain("--pre");
        expect(reasons[7]).toContain("--pre");
        expect(reasons[8]).toContain("-delete");
        expect(reasons[9]).toContain("-fprint");
        expect(reasons[10]).toContain("-C");
        expect(reasons[11]).toContain("-C");
        expect(reasons[12]).toContain("-exec");
        expect(reasons[13]).toContain("-execdir");
        expect(reasons[14]).toContain("-ok");
        expect(reasons[15]).toContain("-okdir");
        expect(reasons[16]).toContain("-fls");
        expect(reasons[17]).toContain("-fprintf");
        expect(reasons[18]).toContain("-fprint0");
      });

      it("admits a path argument that merely contains a banned flag's word", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          { kind: "command", command: "git log docs/output-notes.md" },
          { kind: "command", command: "rg --pretend pattern" },
          { kind: "command", command: "find ./not-delete -type f" },
        ]);
        expect(result.decisions.map((each) => each.behavior)).toEqual(["allow", "allow", "allow"]);
        expect(refusals(result)).toHaveLength(0);
      });

      // A banned flag quoted, or split across a quote, still reaches the
      // program once the shell strips the quotes — the read-only list's own
      // prefix match sees only `git log`, `rg` or `find` and admits the
      // line, so the flag has to be read the same way the shell hands it
      // over, not compared against the line's raw, still-quoted words.
      it("resolves quotes, escapes and getopt abbreviations before matching a banned flag, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          "git log '--output=notes.txt'",
          "rg '--pre=evil.sh' pattern",
          'git log "--output=x"',
          "git log --output='x'",
          String.raw`find . '-exec' true {} \;`,
          "file --compile /tmp/x.mgc",
          String.raw`git log --output\=x`,
          String.raw`git log --\output=x`,
          "git log -'-output=x'",
          'git log "--output" x',
          'rg "--pre" p q',
          String.raw`rg --pre\=p q`,
          "file '-C' -m x",
          'file "-Cm" x',
          // getopt takes the shortest prefix that names exactly one of a
          // program's long options; file's own `--comp` is one.
          "file --comp -m x",
          "rg --hostname-bin=/tmp/evil.sh p",
          "rg --hostname-bin /tmp/evil.sh p",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
        const reasons = refusals(result).map((event) => event.reason);
        expect(reasons[0]).toContain("--output");
        expect(reasons[1]).toContain("--pre");
        expect(reasons[2]).toContain("--output");
        expect(reasons[3]).toContain("--output");
        expect(reasons[4]).toContain("-exec");
        expect(reasons[5]).toContain("--compile");
        expect(reasons[6]).toContain("--output");
        expect(reasons[7]).toContain("--output");
        expect(reasons[8]).toContain("--output");
        expect(reasons[9]).toContain("--output");
        expect(reasons[10]).toContain("--pre");
        expect(reasons[11]).toContain("--pre");
        expect(reasons[12]).toContain("-C");
        expect(reasons[13]).toContain("-C");
        expect(reasons[14]).toContain("--compile");
        expect(reasons[15]).toContain("--hostname-bin");
        expect(reasons[16]).toContain("--hostname-bin");
      });

      it("refuses a word whose quoting it cannot resolve, naming it, rather than guessing", async () => {
        const repo = repository(scratch());
        const commands = [
          String.raw`find . \-exec true {} ;`,
          "find . $'-exec' true {} ;",
          String.raw`find . \-delete`,
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(["deny", "deny", "deny"]);
        const reasons = refusals(result).map((event) => event.reason);
        expect(reasons[0]).toContain(String.raw`\-exec`);
        expect(reasons[1]).toContain("$'-exec'");
        expect(reasons[2]).toContain(String.raw`\-delete`);
      });

      it("refuses a command left inside an unterminated quote, naming it", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          { kind: "command", command: "find . -name 'unterminated" },
        ]);
        expect(result.decisions.map((each) => each.behavior)).toEqual(["deny"]);
        expect(refusals(result)[0]?.reason).toContain("'unterminated");
      });

      // The ticket's own shape reaches the program just the same run through
      // a substitution: `cat` and `ls` are on the read-only list, and the
      // list's own prefix match sees only them, not what they run to get
      // their argument.
      it("reads what a command substitution runs, the same as the command wrapping it", async () => {
        const repo = repository(scratch());
        const commands = [
          "cat $(git log --output=notes.txt)",
          "cat `git log --output=notes.txt`",
          "ls $(find . -delete)",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(["deny", "deny", "deny"]);
        const reasons = refusals(result).map((event) => event.reason);
        expect(reasons[0]).toContain("--output");
        expect(reasons[1]).toContain("--output");
        expect(reasons[2]).toContain("-delete");
      });

      it("reads a substitution inside double quotes too, since only single quotes suppress one", async () => {
        const repo = repository(scratch());
        const commands = [
          'cat "$(git log --output=x)"',
          'cat "`git log --output=x`"',
          'ls "$(rg --pre evil.sh q)"',
          'cat "$(find . -fprint z)"',
          'head "$( git log --output=x )"',
          'cat "prefix$(git log --output=x)suffix"',
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual([
          "deny",
          "deny",
          "deny",
          "deny",
          "deny",
          "deny",
        ]);
        const reasons = refusals(result).map((event) => event.reason);
        expect(reasons[0]).toContain("--output");
        expect(reasons[1]).toContain("--output");
        expect(reasons[2]).toContain("--pre");
        expect(reasons[3]).toContain("-fprint");
        expect(reasons[4]).toContain("--output");
        expect(reasons[5]).toContain("--output");
      });

      it("reads a substitution nested inside another, to a fixpoint, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          'cat "$(echo $(git log --output=x))"',
          "cat $(echo $(git log --output=x))",
          'cat "$(printf %s "$(git log --output=x)")"',
          'cat "$(echo "$(echo "$(git log --output=x)")")"',
          "cat $(echo `git log --output=x`)",
          "cat `echo $(git log --output=x)`",
          // The inner $( never gets its own close — only one `)` exists for
          // the two `$(` this carries — so paren depth reads the outer to
          // the end of the text; recursing into what that reads still finds
          // the well-formed `git log --output=x` a fresh scan of it holds.
          "cat $(echo $(git log --output=x)",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual([
          "deny",
          "deny",
          "deny",
          "deny",
          "deny",
          "deny",
          "deny",
        ]);
        const reasons = refusals(result).map((event) => event.reason);
        for (const reason of reasons) expect(reason).toContain("--output");
      });

      it("leaves a nested substitution inert where single quotes around it suppress it too", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          { kind: "command", command: "cat \"$(ls '$(git log --output=x)')\"" },
        ]);
        expect(result.decisions.map((each) => each.behavior)).toEqual(["allow"]);
        expect(refusals(result)).toHaveLength(0);
      });

      it("reads a substitution body's own invocation past a wrapper, a subshell, a brace group, an assignment prefix, a list or a pipeline, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          'cat "$(env git log --output=x)"',
          'cat "$(command git log --output=x)"',
          'cat "$(nice git log --output=x)"',
          'cat "$(exec git log --output=x)"',
          'cat "$(xargs git log --output=x)"',
          'cat "$( (git log --output=x) )"',
          'cat "$({ git log --output=x; })"',
          'cat "$(VAR=1 git log --output=x)"',
          'cat "$(true && git log --output=x)"',
          'cat "$(git -C . log --output=x)"',
          'cat "$(git --no-pager log --output=x)"',
          'cat "$(git -c core.pager=cat log --output=x)"',
          'cat "$(git log --output=x; true)"',
          'cat "$(true | git log --output=x)"',
          'cat "$(echo $(env git log --output=x))"',
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
        const reasons = refusals(result).map((event) => event.reason);
        for (const reason of reasons) expect(reason).toContain("read-only shapes");
      });

      it("refuses an unlisted program inside a substitution body even where no flag of it is banned, wrapped or not", async () => {
        const repo = repository(scratch());
        const commands = ['cat "$(env printf x)"', 'cat "$( (echo x) )"'];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(["deny", "deny"]);
      });

      it("reads a here-document body for a substitution when its delimiter is unquoted, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          "cat <<EOF\n$(git log --output=x)\nEOF",
          "cat <<EOF\n`git log --output=x`\nEOF",
          "cat <<-EOF\n\t$(git log --output=x)\n\tEOF",
          'cat "$(cat <<EOF\n$(git log --output=x)\nEOF\n)"',
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
        const reasons = refusals(result).map((event) => event.reason);
        for (const reason of reasons) expect(reason).toContain("--output");
      });

      it("leaves a here-document body literal where its delimiter is quoted, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          "cat <<'EOF'\n$(git log --output=x)\nEOF",
          'cat <<"EOF"\n$(git log --output=x)\nEOF',
          "cat <<\\EOF\n$(git log --output=x)\nEOF",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "allow"));
        expect(refusals(result)).toHaveLength(0);
      });

      it("reads a process-substitution body the same way a command-substitution body is read, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          "cat <(git log --output=x)",
          "rg pat <(git log --output=x)",
          'cat "$(cat <(git log --output=x))"',
          "tee >(git log --output=x)",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
        const reasons = refusals(result).map((event) => event.reason);
        for (const reason of reasons) expect(reason).toContain("--output");
      });

      it("admits a process substitution that carries no banned flag", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [{ kind: "command", command: "cat <(ls)" }]);
        expect(result.decisions.map((each) => each.behavior)).toEqual(["allow"]);
        expect(refusals(result)).toHaveLength(0);
      });

      it("refuses a ban-eligible program's own word that carries an unresolved expansion, both transports", async () => {
        const repo = repository(scratch());
        // Each of these carries the unresolved expansion on the `git`/`rg`/
        // `find` word itself, with nothing before it — an assignment-prefixed
        // form (`f=--output=x; git log $f`) is refused a step earlier, as a
        // bare environment assignment, and is held by the class case below.
        const commands = [
          'git log "$f"',
          "git log ${f}",
          'git log "${f:-}"',
          "rg $opts pattern",
          "find . $flag",
          'cat "$(git log $f)"',
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
        const reasons = refusals(result).map((event) => event.reason);
        for (const reason of reasons) expect(reason).toContain("its value is not one this reading resolves");
      });

      it("refuses a segment that runs a program past the one it names — a function body, an assignment prefix, or a bare environment assignment, both transports", async () => {
        const repo = repository(scratch());
        // Each of these matches the read-only list on its first word while
        // running a program the list never admits, or setting the environment
        // the commands after it resolve and run in. Neither is a read-only
        // shape: the runner surfaces the hidden program as one of the segment's
        // own invocations, so the guard holds every invocation to the list, and
        // a segment that runs nothing but assigns is refused on its own — a
        // `PATH`, `IFS` or `GIT_*` a later listed command would inherit turns it
        // into one that is no longer only what its own words say.
        const commands = [
          "cat () { evil.sh; }; cat",
          "cat(){ evil.sh; }; cat README.md",
          "ls () ( evil.sh ); ls",
          "cat=1 program",
          "f=--output=x; git log $f",
          "f=--output=x git log $f",
          "PATH=/tmp/evil:$PATH; ls",
          "PATH=/tmp/evil ls",
          "IFS=x; ls",
          "GIT_PAGER=program git log",
          'cat "$(cat=1 program)"',
          'cat "$(f(){ evil.sh; }; f)"',
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
      });

      it("admits a single-quoted expansion on a ban-eligible program, and a variable on one this table has no entry for", async () => {
        const repo = repository(scratch());
        const commands = ["git log '$f'", "cat $f"];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(["allow", "allow"]);
        expect(refusals(result)).toHaveLength(0);
      });

      it("refuses a shape the closure backstop finds unaccounted, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          "eval 'gi''t log --output=x'",
          "until git log --output=x; do :; done",
          "select x in a b; do git log --output=x; done",
          "f(){ git log --output=x; }; f",
          "! git log --output=x",
          "time git log --output=x",
          "cat <<EOF\ngit log --output=x\nEOF",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
      });

      it("holds a body to the read-only shapes too: what a substitution, a process substitution or a here-document runs is a command like any other, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          'cat "$(evil.sh)"',
          "cat $(program)",
          'cat "`program`"',
          "cat <(program)",
          "cat <<E\n$(program)\nE",
          'cat "$(sh -c \'evil.sh\')"',
          'cat "$(env program)"',
          'cat "$(if true; then program; fi)"',
          'cat "${x:-$(program)}"',
          'cat "$(pro\'\'gram)"',
          'cat "$(git rm -f tracked.txt)"',
          'cat "$(git clean -fdx)"',
          'cat "$(git -C . log -1)"',
          'cat "$(sed -n \'w marker.sed\' tracked.txt)"',
          'cat "$(sort -o marker.sort tracked.txt)"',
          'cat "$(GIT_EXTERNAL_DIFF=program git diff HEAD~1)"',
          'cat "$(echo $(program))"',
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
      });

      it("admits a body that runs only read-only shapes, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          'cat "$(git log -1 --format=%H)"',
          "wc -l <(git ls-files)",
          'head "$(ls | head -1)"',
          "cat <<E\n$(git status --short)\nE",
          // Two here-documents on one line, both bodies read-only.
          "cat <<A <<B\n$(git ls-files)\nA\n$(git status --short)\nB",
          // A quoted delimiter keeps its body literal, so the `$(…)` in it is
          // data `cat` prints, not a command bash runs — inert, and admitted.
          "cat <<'E'\n$(evil.sh)\nE",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "allow"));
        expect(refusals(result)).toHaveLength(0);
      });

      it("reads a substitution body past an escaped or quoted paren, so a `\\)` in it cannot end the body early, both transports", async () => {
        const repo = repository(scratch());
        // The body a `$(…)`, `<(…)`, backtick, here-document or here-string
        // runs is the one bash runs: a `)` written `\)` or inside `'…'`/`"…"`
        // is literal and does not close it. A reader that counts parens blind
        // to the escape ends the body at the first `)` and inspects only the
        // prefix before it, so a program hidden past that paren
        // (`cat $(cat \) ; evil.sh)` runs `evil.sh`) sails through as admitted;
        // reading the body the way the runner's own `readSubstitution` and
        // bash do is what refuses it (SCP-355, the adversarial round).
        const commands = [
          "cat $(cat \\) ; evil.sh)",
          'cat "$(cat \\) ; evil.sh)"',
          "cat <(cat \\) ; program)",
          "cat $(cat ')' ; evil.sh)",
          'cat $(echo ")" ; evil.sh)',
          "cat $(echo $(cat \\) ; evil.sh))",
          "cat <<E\n$(cat \\) ; evil.sh)\nE",
          "cat <<< $(cat \\) ; evil.sh)",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
      });

      it("reads a backtick body past an escaped backtick, so a nested one cannot hide a command, both transports", async () => {
        const repo = repository(scratch());
        // A `\\\`` inside `` `…` `` is an escaped backtick opening a nested
        // substitution, not the close, and bash runs the nested command. A
        // reader that ends the body at the first backtick sees only the prefix,
        // so `` cat `cat \\\`evil.sh\\\`` `` ran `evil.sh` while the guard read
        // only `` `cat \\\` ``. Undoing one level of the escaping surfaces the
        // nested command as a body of its own, which is refused.
        const commands = [
          "cat `cat \\`evil.sh\\``",
          'cat "`cat \\`evil.sh\\``"',
          "cat `sh -c \\`evil.sh\\``",
          "cat `cat \\`git rm -f tracked.txt\\``",
          "cat $(cat `evil.sh`)",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
      });

      it("reads every here-document a line opens, not only the first, both transports", async () => {
        const repo = repository(scratch());
        // Two here-documents on one line take their bodies in order — the shell
        // expands the `$(…)` in each unquoted one — so a reader that stopped at
        // the first left the second's command unseen: `cat <<A <<B` with the
        // payload in B's body ran it, and even the flag bans, since the banned
        // invocation lived in the body nothing inspected (SCP-355, the
        // adversarial round).
        const commands = [
          "cat <<A <<B\nhello\nA\n$(evil.sh)\nB",
          "cat <<A <<B\nx\nA\n$(git rm -f tracked.txt)\nB",
          "cat <<A <<B\nx\nA\n$(git log --output=x)\nB",
          "cat <<A <<B <<C\n1\nA\n2\nB\n$(evil.sh)\nC",
          "cat <<-A <<-B\n\t1\n\tA\n\t$(evil.sh)\n\tB",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
      });

      it("refuses a coprocess, whose command stands past the keyword, both transports", async () => {
        const repo = repository(scratch());
        const commands = [
          "coproc git log --output=x",
          'cat "$(coproc git log --output=x)"',
          'cat "$(coproc { git log --output=x; })"',
          'cat "$(coproc W { git log --output=x; })"',
          'cat "$(true; coproc git log --output=x)"',
          "cat <(coproc git log --output=x)",
        ];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(commands.map(() => "deny"));
      });

      it("leaves an argument the backstop's own count never scans admitted, both transports", async () => {
        const repo = repository(scratch());
        const commands = ["grep 'git' file", "cat notes-about-find.md", 'cat "$(ls "$dir")"'];
        const result = await run(
          repo,
          commands.map((command) => ({ kind: "command", command }) as ContractStep),
        );
        expect(result.decisions.map((each) => each.behavior)).toEqual(["allow", "allow", "allow"]);
        expect(refusals(result)).toHaveLength(0);
      });

      it("admits a path argument that merely contains a quoted banned word as a substring", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          { kind: "command", command: 'cat "notes--output=.md"' },
          // git and rg refuse their own abbreviations outright (git 2.50.1
          // exits 128 on `--outp=`, ripgrep 14.1.1 exits 2 on `--pr=`), so
          // neither needs a ban here the way file's getopt does.
          { kind: "command", command: "git log --outp=x" },
          { kind: "command", command: "rg --pr=p q" },
          // `--pre-glob` names a real, different rg flag; not `--pre`.
          { kind: "command", command: "rg --pre-glob *.gz p" },
        ]);
        expect(result.decisions.map((each) => each.behavior)).toEqual([
          "allow",
          "allow",
          "allow",
          "allow",
        ]);
        expect(refusals(result)).toHaveLength(0);
      });
    });

    describe("generate_plan (D-102)", () => {
      it("refuses to draft until the session has brought spec.md up to date", async () => {
        const repo = repository(scratch());
        mkdirSync(join(repo, SPEC_FOLDER), { recursive: true });
        writeFileSync(join(repo, SPEC_FOLDER, "spec.md"), SPEC);
        const result = await run(repo, [generate]);
        expect(result.decisions[0]?.isError).toBe(true);
        expect(result.decisions[0]?.result).toContain("spec.md");
        expect(existsSync(join(storeDir(repo, null), "tickets"))).toBe(false);
      });

      it("runs the drafter once the spec is written, and reports the key", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [writeSpec(), generate]);
        const call = result.decisions[1];
        expect(call?.isError).toBe(false);
        expect(call?.result).toContain("PRB-1");
        const ticket = readTicket(storeDir(repo, null), "PRB-1");
        expect(ticket.state).toBe("plan_review");
        expect(ticket.approved_at).toBeNull();
        expect(ticket.admission.spec?.path).toBe(`${SPEC_FOLDER}/spec.md`);
        expect(
          events(result).some((event) => event.type === "tool" && event.tool === "generate_plan"),
        ).toBe(true);
      });

      it("re-drafts the same ticket rather than admitting a second one", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          generate,
          writeSpec(SPEC.replace("60 seconds", "30 seconds")),
          generate,
        ]);
        expect(result.decisions[3]?.result).toContain("re-drafted PRB-1");
        expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
      });
    });

    describe("the plan's edits (D-100)", () => {
      it("changes the plan through the validated edit path, as the interview, and undoes it", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          generate,
          {
            kind: "call",
            tool: "edit_plan",
            input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } },
          },
          { kind: "call", tool: "undo_edit", input: { edit: 1 } },
        ]);
        const dir = storeDir(repo, null);
        const snapshot = readDraftSnapshot(dir, "PRB-1");
        // The undo is itself an edit, as it is at the command line, and the
        // edit it undid is marked rather than removed.
        expect(snapshot?.edits).toHaveLength(2);
        for (const edit of snapshot?.edits ?? []) expect(edit.author).toBe("interview");
        expect(snapshot?.edits[0]?.undone).toBe(true);
        // An edit the person's own session made on their behalf is recorded and
        // not counted as friction (D-100).
        expect(readTicket(dir, "PRB-1").admission.edit_count).toBe(0);
        expect(result.decisions[2]?.result).toContain("edit 1");
        expect(
          events(result).some((event) => event.type === "tool" && event.tool === "edit_plan"),
        ).toBe(true);
      });

      it("holds no way to name a plan, so it can only change the one its spec was drafted into", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          generate,
          {
            kind: "call",
            tool: "edit_plan",
            input: { key: "PRB-9", graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } },
          },
          { kind: "call", tool: "undo_edit", input: { key: "PRB-9", edit: 1 } },
          { kind: "call", tool: "read_plan", input: { key: "PRB-9" } },
        ]);
        for (const at of [2, 3, 4]) {
          expect(result.decisions[at]?.isError, `call ${at}`).toBe(true);
          expect(result.decisions[at]?.result, `call ${at}`).toContain("key");
        }
        expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(0);
      });

      it("reads the plan back: the contract, the graph, the size and the history", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          generate,
          { kind: "call", tool: "read_plan", input: {} },
        ]);
        const read = result.decisions[2]?.result ?? "";
        expect(read).toContain("node_1");
        expect(read).toContain('"size"');
        expect(read).toContain('"edits"');
      });
    });

    describe("what the session may do (D-102)", () => {
      it("holds no tool that approves, publishes, runs or merges", async () => {
        const repo = repository(scratch());
        const result = await run(repo, []);
        const started = events(result).find((event) => event.type === "started");
        expect(started?.type === "started" ? started.tools.slice().sort() : []).toEqual(
          [...INTERVIEW_TOOL_NAMES].sort(),
        );
        const result2 = await run(repo, [
          { kind: "call", tool: "approve_plan", input: {} },
          { kind: "call", tool: "publish", input: {} },
        ]);
        expect(result2.decisions.map((each) => each.behavior)).toEqual(["deny", "deny"]);
        for (const refusal of refusals(result2)) expect(refusal.reason).toContain("holds no");
      });

      it("answers every call allow or deny, and never puts one to the person", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          { kind: "command", command: "pnpm install" },
          { kind: "write", path: "packages/queue/send.ts", content: "x\n" },
          { kind: "command", command: "git status --short" },
        ]);
        expect(result.decisions).toHaveLength(4);
        for (const decision of result.decisions) {
          expect(["allow", "deny"]).toContain(decision.behavior);
        }
        // Nothing the person reads is a question: the streams carry statements.
        expect(result.err.join("")).not.toContain("?");
      });

      it("cannot reach admit --approve through generate_plan", async () => {
        const repo = repository(scratch());
        const result = await run(repo, [
          writeSpec(),
          { kind: "call", tool: "generate_plan", input: { approve: true } },
        ]);
        expect(result.decisions[1]?.isError).toBe(true);
        expect(result.decisions[1]?.result).toMatch(/approve/i);
        expect(existsSync(join(storeDir(repo, null), "tickets"))).toBe(false);
      });
    });

    describe("resuming (D-102)", () => {
      it("reports the id the transport gave back, records it beside the spec, and resumes on it", async () => {
        const repo = repository(scratch());
        const first = await run(repo, [writeSpec()], { sessionId: "sess-abc" });
        expect(events(first)[0]).toMatchObject({ type: "started", session_id: "sess-abc" });
        const recorded = JSON.parse(
          readFileSync(join(repo, SPEC_FOLDER, INTERVIEW_SESSION_FILE), "utf8"),
        ) as { session_id: string };
        expect(recorded.session_id).toBe("sess-abc");

        const second = await run(repo, [{ kind: "say", text: "carrying on" }], {
          argv: ["--session", "sess-abc"],
          sessionId: "sess-abc",
        });
        expect(events(second)[0]).toMatchObject({ type: "started", session_id: "sess-abc" });
        expect(events(second).at(-1)).toMatchObject({ type: "ended", session_id: "sess-abc" });
      });
    });
  });
}
