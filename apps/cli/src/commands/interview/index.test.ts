import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { InterviewEventSchema, InterviewTurnSchema } from "@perbo/contracts";
import { UsageError } from "../../usage-error.js";
import { NEXT_STEPS } from "../../next-step.js";
import { claudeInterviewTransport } from "./claude.js";

/** What the transport is told to run. The scripted SDK spawns nothing. */
const CLAUDE = "/usr/local/bin/claude";
import {
  INTERVIEW_AGENT_TOOLS,
  INTERVIEW_DENIED_TOOLS,
  INTERVIEW_PROVIDERS,
  INTERVIEW_SESSION_FILE,
  INTERVIEW_TOOL_NAMES,
  interviewOrientation,
  interviewCommandLine,
  type InterviewSession,
} from "./index.js";
import { listTickets, readDraftSnapshot, storeDir } from "../../store/tickets.js";
import type { Streams } from "../../streams.js";
import {
  describeInterviewContract,
  drafter,
  gitIdentity,
  repository as makeRepository,
  SPEC,
  SPEC_FOLDER,
} from "./test-support/contract.js";
import { claudeHarness, codexHarness } from "./test-support/harness.js";
import { scriptedSdk, type ScriptStep } from "./test-support/fake-sdk.js";
import { BUILT_ENTRY, REPO_ROOT } from "../../test-support/paths.js";
import { runCommandLine } from "../../command-line/terminal.js";

/** The built command, for the approval an interview cannot make. */
const CLI = BUILT_ENTRY;

/**
 * `perbo interview`: the person's own Claude Code or Codex session (D-102).
 *
 * The behaviour that is the interview's, whichever transport is behind it, is
 * stated once in `test-support/contract.ts` and run here once per transport. A
 * factory rather than a table of transports, because what differs between them
 * is not a parameter but the traffic a step becomes: a write is a permission
 * callback on the Claude Agent SDK and a file-change approval on Codex's app
 * server, and only a factory can hold both.
 *
 * What is in this file is Claude's alone: the SDK's own invocation, and the
 * calls only it can make — a file tool naming no path, an `Edit` that fails
 * after it is admitted, and the reads it offers the callback that Codex
 * answers inside its own read-only sandbox.
 *
 * Nothing here starts a session or calls a model. The SDK is the double in
 * `test-support/fake-sdk.ts`, Codex's app server is the fake in
 * `test-support/fake-app-server.ts`, and the drafter is the scripted model
 * `admit --from-spec` takes.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-interview-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const repository = () => makeRepository(scratch);

describeInterviewContract(claudeHarness(), () => scratch);
describeInterviewContract(codexHarness(() => scratch), () => scratch);

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (c) => out.push(c), stderr: (c) => err.push(c), isTTY: false };
}

/** The events the command streamed, parsed back through the protocol's own schema. */
const events = (streams: { out: string[] }) =>
  streams.out
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => InterviewEventSchema.parse(JSON.parse(line)));

const writeSpec = (content = SPEC): ScriptStep => ({
  kind: "tool",
  tool: "Write",
  input: { file_path: `${SPEC_FOLDER}/spec.md`, content },
});
const generate: ScriptStep = { kind: "call", tool: "generate_plan", input: {} };

async function interview(
  repo: string,
  steps: readonly ScriptStep[],
  extra: { argv?: string[]; sessionId?: string; spec?: string; turns?: readonly string[] } = {},
) {
  const streams = capture();
  const sdk = scriptedSdk({ steps, cwd: repo, ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) });
  const code = await runCommandLine(interviewCommandLine, {
    argv: ["--repo", repo, "--spec", extra.spec ?? SPEC_FOLDER, ...(extra.argv ?? [])],
    streams,
    cwd: repo,
    deps: {
      transport: claudeInterviewTransport(sdk, CLAUDE),
      model: drafter(),
      turns: (async function* () {
        for (const text of extra.turns ?? ["let us write the spec"])
          yield JSON.stringify({ type: "turn", text });
      })(),
    },
  });
  return { code, streams, sdk };
}

/** The input one line means, which is what the assertions below are about. */
const interviewLine = (argv: readonly string[]) => interviewCommandLine.read(argv).input;

describe("the line an interview is asked for by", () => {
  it("takes the repository, the spec, a session to resume, a model and a provider", () => {
    expect(interviewLine(["--repo", "..", "--spec", "specs/x", "--session", "s1", "--model", "claude-opus-5"])).toEqual({
      repo: "..",
      store: null,
      spec: "specs/x",
      session: "s1",
      model: "claude-opus-5",
      provider: "claude",
    });
    expect(interviewLine(["--provider", "codex"]).provider).toBe("codex");
    expect(() => interviewLine(["--provider", "gemini"])).toThrow(/claude or codex/);
    expect(() => interviewLine(["--approve"])).toThrow(UsageError);
    expect(() => interviewLine(["--spec"])).toThrow(/requires a value/);
    // The two the interview runs on, spelled as `perbo agent` spells them.
    expect([...INTERVIEW_PROVIDERS]).toEqual(["claude", "codex"]);
  });

  it("resumes into the folder the record sits in, not the path it names", async () => {
    const repo = repository();
    await interview(repo, [writeSpec()], { sessionId: "sess-xyz" });
    // A record edited by hand to name somewhere else entirely.
    const path = join(repo, SPEC_FOLDER, INTERVIEW_SESSION_FILE);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...record, spec: "specs/x/../../../pwned/spec.md" }));
    const streams = capture();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--session", "sess-xyz"],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo, sessionId: "sess-xyz" }), CLAUDE),
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
      },
    });
    const started = events(streams)[0];
    expect(started?.type === "started" ? started.spec : null).toBe(`${SPEC_FOLDER}/spec.md`);
    expect(existsSync(join(repo, "..", "pwned"))).toBe(false);
  });

  it("writes its record inside the checkout, or not at all", async () => {
    const repo = repository();
    const elsewhere = join(scratch, "outside");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(repo, "specs"), { recursive: true });
    symlinkSync(elsewhere, join(repo, "specs", "linked"));
    const streams = capture();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", "specs/linked"],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
      },
    });
    expect(existsSync(join(elsewhere, INTERVIEW_SESSION_FILE))).toBe(false);
    expect(streams.err.join("")).toContain("outside");
  });

  it("writes no record through a record that is itself a symlink", async () => {
    const repo = repository();
    const elsewhere = join(scratch, "outside-file");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(repo, SPEC_FOLDER), { recursive: true });
    symlinkSync(join(elsewhere, "taken.json"), join(repo, SPEC_FOLDER, INTERVIEW_SESSION_FILE));
    const streams = capture();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", SPEC_FOLDER],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
      },
    });
    expect(existsSync(join(elsewhere, "taken.json"))).toBe(false);
    expect(streams.err.join("")).toContain("symlink");
  });

  it("takes the spec of the folder a session's record was found in, and skips a record it cannot read", async () => {
    const repo = repository();
    // One record naming a folder that is not its own, and one that is not a record.
    for (const [slug, body] of [
      ["other", JSON.stringify({ session_id: "sess-two", spec: "specs/ghost/spec.md" })],
      ["broken", JSON.stringify({ session_id: 7 })],
    ] as const) {
      mkdirSync(join(repo, "specs", slug), { recursive: true });
      writeFileSync(join(repo, "specs", slug, INTERVIEW_SESSION_FILE), body);
    }
    const streams = capture();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--session", "sess-two"],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo, sessionId: "sess-two" }), CLAUDE),
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
      },
    });
    const started = events(streams)[0];
    expect(started?.type === "started" ? started.spec : null).toBe("specs/other/spec.md");
  });

  it("refuses a spec outside the repository's spec folder", async () => {
    const repo = repository();
    const streams = capture();
    await expect(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", "docs/notes"],
        streams,
        cwd: repo,
        deps: {
          transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
          model: drafter(),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).rejects.toThrow(/specs/);
  });

  /**
   * However a spec is spelled, the folder the session may write is one piece of
   * work under the repository's spec folder — never that folder, which holds
   * every other piece of work's spec as well.
   */
  it("never admits the folder every spec sits in, however the spec is spelled", async () => {
    const repo = repository();
    const run = (named: string) =>
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", named],
        streams: capture(),
        cwd: repo,
        deps: {
          transport: claudeInterviewTransport(
            scriptedSdk({
              steps: [
                {
                  kind: "tool",
                  tool: "Write",
                  input: { file_path: "specs/somebody-else/spec.md", content: "# theirs\n" },
                },
              ],
              cwd: repo,
            }),
            CLAUDE,
          ),
          model: drafter(),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      });
    for (const named of ["specs", "specs/", "specs/spec.md", "specs/./spec.md", "specs/x/../spec.md", "specs/.", "docs/notes"]) {
      await expect(run(named), named).rejects.toThrow(/one piece of work/);
    }
    // And the spellings that do name one: each may write its own and no other.
    for (const named of ["specs/x", "specs/x/", "./specs/x/.", "specs/x/spec.md"]) {
      const streams = capture();
      const sdk = scriptedSdk({
        steps: [
          {
            kind: "tool",
            tool: "Write",
            input: { file_path: "specs/somebody-else/spec.md", content: "# theirs\n" },
          },
        ],
        cwd: repo,
      });
      await runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", named],
        streams,
        cwd: repo,
        deps: {
          transport: claudeInterviewTransport(sdk, CLAUDE),
          model: drafter(),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      });
      expect(sdk.calls[0]?.behavior, named).toBe("deny");
      expect(existsSync(join(repo, "specs", "somebody-else")), named).toBe(false);
      const started = events(streams)[0];
      expect(started?.type === "started" ? started.spec : null, named).toBe("specs/x/spec.md");
    }
  });

  it("refuses a run that names neither a spec nor a session to resume", async () => {
    const repo = repository();
    const streams = capture();
    await expect(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo],
        streams,
        cwd: repo,
        deps: {
          transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
          model: drafter(),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).rejects.toThrow(/--spec/);
  });
});

describe("the write boundary, on the Claude Agent SDK (SCP-311 criterion 1)", () => {
  it("refuses a file tool that names no path", async () => {
    const repo = repository();
    const { sdk } = await interview(repo, [
      { kind: "tool", tool: "Write", input: { content: "# nowhere\n" } },
    ]);
    expect(sdk.calls[0]?.behavior).toBe("deny");
  });

  it("makes nothing for a read: a path outside the checkout, or a folder not yet written, is left as it is", async () => {
    const repo = repository();
    const elsewhere = join(scratch, "elsewhere", "nested");
    await interview(repo, [
      { kind: "tool", tool: "Read", input: { file_path: join(elsewhere, "file.ts") } },
      { kind: "tool", tool: "Read", input: { file_path: "docs/adr/0002-nothing.md" } },
      { kind: "tool", tool: "Grep", input: { pattern: "send", path: join(elsewhere, "deeper") } },
    ]);
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(join(repo, "docs", "adr"))).toBe(false);
  });

});

describe("generate_plan (SCP-311 criterion 2)", () => {
  it("takes any change to spec.md as bringing it up to date, however it was made", async () => {
    const repo = repository();
    mkdirSync(join(repo, SPEC_FOLDER), { recursive: true });
    writeFileSync(join(repo, SPEC_FOLDER, "spec.md"), SPEC);
    const { sdk } = await interview(repo, [
      {
        kind: "tool",
        tool: "Edit",
        input: { file_path: `${SPEC_FOLDER}/spec.md`, old_string: "60 seconds", new_string: "30 seconds" },
        // The tool is admitted and then performs the edit, as a session's own does.
        writes: { path: `${SPEC_FOLDER}/spec.md`, content: SPEC.replace("60 seconds", "30 seconds") },
      },
      generate,
    ]);
    expect(sdk.calls[0]?.behavior).toBe("allow");
    expect(sdk.calls[1]?.isError).toBe(false);
    expect(sdk.calls[1]?.result).toContain("PRB-1");
  });

  // A group is put to the person and nothing waits for it, so without a rule a
  // session can ask and draft in the one breath — which is drafting around its
  // own guess at the answer, and then telling them afterwards which way it
  // went. Their answer may change the spec this drafts from.
  it("refuses to draft while a group of questions stands unanswered", async () => {
    const ask: ScriptStep = {
      kind: "call",
      tool: "ask_options",
      input: {
        groups: [
          {
            title: "Ordering within a day",
            parts: [
              {
                question: "How are a day's events ordered?",
                options: [
                  { label: "Timed first, then untimed", detail: null, recommended: true },
                  { label: "In the order they were written", detail: null, recommended: false },
                ],
              },
            ],
          },
        ],
      },
    };
    const repo = repository();
    const { sdk } = await interview(repo, [writeSpec(), ask, generate]);
    expect(sdk.calls[1]?.isError).toBe(false);
    expect(sdk.calls[2]?.isError).toBe(true);
    expect(sdk.calls[2]?.result).toContain("unanswered");
    expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual([]);
  });

  // The other half: their turn is their answer, so it lets the draft through.
  // A check nobody can pass is as useless as one nobody can fail.
  it("drafts once their turn has answered the group", async () => {
    const ask: ScriptStep = {
      kind: "call",
      tool: "ask_options",
      input: {
        groups: [
          {
            title: null,
            parts: [
              {
                question: "How are a day's events ordered?",
                options: [
                  { label: "Timed first", detail: null, recommended: true },
                  { label: "As written", detail: null, recommended: false },
                ],
              },
            ],
          },
        ],
      },
    };
    const repo = repository();
    // Two turns: the session asks on the first, and drafts on the second,
    // which is the turn their answer arrived in.
    const { sdk } = await interview(repo, [writeSpec(), ask, { kind: "await" }, generate], {
      turns: ["let us write the spec", "Timed first"],
    });
    expect(sdk.calls.at(-1)?.isError).toBe(false);
    expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
  });

  // The shape the tool's own description recommends — independent groups go
  // separately, up to MAX_QUESTION_GROUPS — and the one a counter of turns gets
  // wrong. The person is put one group at a time, so answering the first leaves
  // the second on screen; a plan drafted then is drafted around a guess at it.
  it("holds the draft until every group of a multi-group asking is answered", async () => {
    const twoGroups: ScriptStep = {
      kind: "call",
      tool: "ask_options",
      input: {
        groups: [
          {
            title: "Ordering",
            parts: [
              {
                question: "How are a day's events ordered?",
                options: [
                  { label: "Timed first", detail: null, recommended: true },
                  { label: "As written", detail: null, recommended: false },
                ],
              },
            ],
          },
          {
            title: "Filler days",
            parts: [
              {
                question: "What fills the days around the month?",
                options: [
                  { label: "Left blank", detail: null, recommended: true },
                  { label: "Greyed in", detail: null, recommended: false },
                ],
              },
            ],
          },
        ],
      },
    };
    const repo = repository();
    const { sdk } = await interview(
      repo,
      // Their answer to the first group, then a draft that must still be
      // refused, then their answer to the second, then the draft that lands.
      [writeSpec(), twoGroups, { kind: "await" }, generate, { kind: "await" }, generate],
      { turns: ["let us write the spec", "Timed first", "Left blank"] },
    );
    const drafts = sdk.calls.filter((call) => call.tool.endsWith("generate_plan"));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.isError, "drafted with a group still on screen").toBe(true);
    expect(drafts[0]?.result).toContain("unanswered");
    expect(drafts[1]?.isError).toBe(false);
    expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
  });

  // The asking ends whole when they say something of their own, exactly as the
  // planning record ends it (D-117), so the guard cannot deadlock a session
  // whose questions the person simply talked past.
  it("lets the draft through once they answer with something of their own", async () => {
    const twoGroups: ScriptStep = {
      kind: "call",
      tool: "ask_options",
      input: {
        groups: [
          {
            title: null,
            parts: [
              {
                question: "How are a day's events ordered?",
                options: [
                  { label: "Timed first", detail: null, recommended: true },
                  { label: "As written", detail: null, recommended: false },
                ],
              },
            ],
          },
          {
            title: null,
            parts: [
              {
                question: "What fills the days around the month?",
                options: [
                  { label: "Left blank", detail: null, recommended: true },
                  { label: "Greyed in", detail: null, recommended: false },
                ],
              },
            ],
          },
        ],
      },
    };
    const repo = repository();
    const { sdk } = await interview(
      repo,
      [writeSpec(), twoGroups, { kind: "await" }, generate],
      { turns: ["let us write the spec", "forget the ordering, just build it"] },
    );
    expect(sdk.calls.at(-1)?.isError).toBe(false);
    expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
  });

  it("refuses a second draft from a spec nothing has changed since the first", async () => {
    const repo = repository();
    const { sdk } = await interview(repo, [writeSpec(), generate, generate]);
    expect(sdk.calls[1]?.isError).toBe(false);
    expect(sdk.calls[2]?.isError).toBe(true);
    expect(sdk.calls[2]?.result).toContain("as this session last saw it");
    // And a change after that draft opens it again.
    const again = await interview(repo, [writeSpec(SPEC.replace("60 seconds", "30 seconds")), generate]);
    expect(again.sdk.calls[1]?.isError).toBe(false);
    expect(again.sdk.calls[1]?.result).toContain("re-drafted PRB-1");
  });

  it("refuses to draft where the tool that was going to write the spec did not", async () => {
    const repo = repository();
    mkdirSync(join(repo, SPEC_FOLDER), { recursive: true });
    writeFileSync(join(repo, SPEC_FOLDER, "spec.md"), SPEC);
    // Admitted, and then it fails, as an Edit whose old_string is absent does.
    const { sdk } = await interview(repo, [
      {
        kind: "tool",
        tool: "Edit",
        input: { file_path: `${SPEC_FOLDER}/spec.md`, old_string: "nothing like this", new_string: "x" },
      },
      generate,
    ]);
    expect(sdk.calls[0]?.behavior).toBe("allow");
    expect(sdk.calls[1]?.isError).toBe(true);
    expect(sdk.calls[1]?.result).toContain("spec.md");
    expect(existsSync(join(storeDir(repo, null), "tickets"))).toBe(false);
  });

  // Each command closes its report by telling whoever ran it what to type next,
  // which is true at a terminal and false in the app, where approving and
  // editing are buttons. A tool's result reaches the person nearly word for
  // word, so the lines would send someone sitting in the app off to a terminal
  // they never opened.
  it("relays the admission without the commands a terminal is told to type", async () => {
    const repo = repository();
    const { sdk } = await interview(repo, [writeSpec(), generate]);
    const relayed = sdk.calls[1]?.result ?? "";
    expect(relayed).toContain("PRB-1");
    // Who approves is still said, in words that hold on either surface.
    expect(relayed).toContain("A person reads and approves it; this session cannot.");
    for (const step of NEXT_STEPS) expect(relayed, step).not.toContain(step);
    expect(relayed).not.toContain("perbo approve");
    expect(relayed).not.toContain("perbo edit");
    // Only the block goes. What a first draft wrote is printed after it, and is
    // the one report of where D-103's pages landed.
    expect(relayed).toContain(`${SPEC_FOLDER}/spec.md`);
  });
});

describe("edit_plan (SCP-311 criterion 3)", () => {
  // Refusing a call that names a key is in the contract suite; what is here is
  // why it is refused — no tool declares one for the model to fill in.
  it("declares no tool that takes a plan's key", async () => {
    const { sdk } = await interview(repository(), []);
    const server = Object.values(sdk.options?.mcpServers ?? {})[0] as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    for (const each of server.tools)
      expect(Object.keys(each.inputSchema), each.name).not.toContain("key");
  });

  it("changes the plan of the spec it is about, and leaves another piece of work's alone", async () => {
    const repo = repository();
    const second = "specs/another-thing";
    // Two pieces of work in one repository, each drafted by its own interview.
    await interview(repo, [writeSpec(), generate]);
    await interview(repo, [
      {
        kind: "tool",
        tool: "Write",
        input: { file_path: `${second}/spec.md`, content: SPEC.replace("Activation email", "Another thing") },
      },
      generate,
    ], { spec: second });
    const dir = storeDir(repo, null);
    expect(listTickets(dir).map((ticket) => ticket.key)).toEqual(["PRB-1", "PRB-2"]);

    // The second interview's edit lands on the second ticket, and only there.
    await interview(repo, [
      {
        kind: "call",
        tool: "edit_plan",
        input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } },
      },
    ], { spec: second });
    expect(readDraftSnapshot(dir, "PRB-2")?.edits ?? []).toHaveLength(1);
    expect(readDraftSnapshot(dir, "PRB-1")?.edits ?? []).toHaveLength(0);
  });

  // The other side of the same rule. An edit's report is relayed whether it
  // worked or not, and a refused one is the text the dock shows without asking
  // — so it is the one most likely to be read, and was the one still naming a
  // command to type.
  it("relays an edit, and a refused edit, without the commands to type", async () => {
    const repo = repository();
    const { sdk } = await interview(repo, [
      writeSpec(),
      generate,
      { kind: "call", tool: "edit_plan", input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } } },
      // An edge to a node that is not in the plan: refused by the edit path.
      { kind: "call", tool: "edit_plan", input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_404" } } },
    ]);
    const applied = sdk.calls[2]?.result ?? "";
    expect(sdk.calls[2]?.isError).toBe(false);
    expect(applied).toContain("PRB-1");
    for (const step of NEXT_STEPS) expect(applied, step).not.toContain(step);
    expect(applied).not.toContain("perbo approve");

    // The refusal half is not judged by the same loop, because no refusal can
    // fail it: `perbo edit` refuses by throwing, and a thrown message is the
    // whole of what the interview relays — whatever the command wrote to its
    // streams before it is dropped — so no refusal it issues carries a block,
    // and a loop over NEXT_STEPS here would pass against any relay at all.
    // What holds of a refused edit is that it reaches the session as an error
    // in the command's own words and nothing besides, which is also what would
    // catch a command to type if a refusal ever came to carry one.
    const refused = sdk.calls[3]?.result ?? "";
    expect(sdk.calls[3]?.isError).toBe(true);
    expect(refused.trim()).toBe("this plan has no edge node_1 -> node_404");
    // And a refused edit is not a recorded one: the edge that did come out is
    // still the only edit this plan has.
    expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(1);
  });

  it("says a plan is approved rather than that none was drafted", async () => {
    const repo = repository();
    await interview(repo, [writeSpec(), generate]);
    execFileSync(process.execPath, [CLI, "approve", "PRB-1", "--repo", repo], { env: gitIdentity, stdio: "ignore" });
    const { sdk } = await interview(repo, [
      { kind: "call", tool: "edit_plan", input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } } },
      { kind: "call", tool: "read_plan", input: {} },
    ]);
    // The order between its nodes may still change, as at the command line.
    expect(sdk.calls[0]?.isError).toBe(false);
    expect(sdk.calls[0]?.result).toContain("PRB-1");
    // Reading it is not refused either: an approved contract is immutable, not secret.
    expect(sdk.calls[1]?.isError).toBe(false);
    expect(sdk.calls[1]?.result).toContain("approved_at");
    // Its contract is not the interview's to change, and `perbo edit` says so.
    const contract = await interview(repo, [
      {
        kind: "call",
        tool: "edit_plan",
        input: { outcome: "Something else entirely." },
      },
      // And drafting again would be a second ticket from one spec.
      writeSpec(SPEC.replace("60 seconds", "45 seconds")),
      generate,
    ]);
    expect(contract.sdk.calls[0]?.isError).toBe(true);
    expect(contract.sdk.calls[2]?.isError).toBe(true);
    expect(contract.sdk.calls[2]?.result).toContain("second ticket from one spec");
    expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
  }, 30_000);

  it("names the state a plan is in, for a state that is not past plan_review", async () => {
    const repo = repository();
    await interview(repo, [writeSpec(), generate]);
    // A spec edited after its plan was drafted takes the ticket back, not on (D-103).
    const dir = storeDir(repo, null);
    const path = join(dir, "tickets", "PRB-1.json");
    const ticket = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...ticket, state: "plan_invalid" }));
    const { sdk } = await interview(repo, [writeSpec(SPEC.replace("60 seconds", "45 seconds")), generate]);
    expect(sdk.calls[1]?.isError).toBe(true);
    expect(sdk.calls[1]?.result).toContain("plan_invalid");
    expect(sdk.calls[1]?.result).not.toContain("moved past");
    expect(listTickets(dir).map((each) => each.key)).toEqual(["PRB-1"]);
  });

  /**
   * A tool's description is what the model reads before it calls one, so a
   * description that claims a narrower rule than the code enforces is a
   * refusal nothing issued: the session simply does not call the tool.
   */
  it("describes each tool by what it does, not by a rule it stopped having", async () => {
    const repo = repository();
    const { sdk } = await interview(repo, []);
    const server = Object.values(sdk.options?.mcpServers ?? {})[0] as {
      tools: Array<{ name: string; description: string }>;
    };
    const described = new Map(server.tools.map((each) => [each.name, each.description]));
    expect([...described.keys()].sort()).toEqual([...INTERVIEW_TOOL_NAMES].sort());
    for (const [name, description] of described) {
      // `perbo edit` decides what an approved plan allows, and these act on
      // the plan whatever state it is in.
      expect(description, name).not.toMatch(/unapproved/i);
    }
    // And the two that have a state rule say which state it is about.
    expect(described.get("edit_plan")).toMatch(/approved/);
    expect(described.get("generate_plan")).toMatch(/plan_review/);
  });

});

describe("what the session may do (SCP-311 criterion 5)", () => {
  it("holds no tool that approves, publishes, runs or merges", async () => {
    const repo = repository();
    const { sdk } = await interview(repo, []);
    const offered = [...INTERVIEW_TOOL_NAMES, ...INTERVIEW_AGENT_TOOLS];
    for (const name of offered) {
      expect(name, `${name} names a person's own act`).not.toMatch(/approve|publish|merge|^Run$/i);
    }
    const server = Object.values(sdk.options?.mcpServers ?? {})[0] as { tools: Array<{ name: string }> };
    expect(server.tools.map((each) => each.name).sort()).toEqual([...INTERVIEW_TOOL_NAMES].sort());
    expect(sdk.options?.tools).toEqual([...INTERVIEW_AGENT_TOOLS]);
    // Every call reaches the guard, which is the whole seam. Claude Code
    // resolves a call before the permission callback wherever something has
    // already decided it — a mode that denies outright, a rule in `allowedTools`
    // or one in a settings file — and the callback is only the surface the
    // undecided call reaches. So the session is given nothing that decides one.
    expect(sdk.options?.allowedTools).toEqual([]);
    expect(sdk.options?.settingSources).toEqual([]);
    expect(sdk.options?.permissionMode).toBe("default");
    // Written out rather than compared against the list the transport reads:
    // the runner's deny list, and the subagent tool under the name the pinned
    // binary sends and its former name, because the roles are the executor's.
    expect(sdk.options?.disallowedTools).toEqual([...INTERVIEW_DENIED_TOOLS]);
    expect(sdk.options?.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
    // And the session is told what it is for. Emptied, this is a stock Claude
    // Code session holding four tools with no account of them: the guard would
    // still refuse every act it should, and the interview would be gone. The
    // Codex transport asserts its own twin of this on the wire.
    const appended = sdk.options?.systemPrompt.append ?? "";
    expect(appended).toContain(SPEC_FOLDER);
    expect(appended).toContain("generate_plan");
    expect(appended).toBe(
      interviewOrientation({
        spec: `${SPEC_FOLDER}/spec.md`,
        adr: "docs/adr",
        repositoryRoot: repo,
      }),
    );
  });

});

describe("the orientation", () => {
  it("carries the bundled grilling and domain-modelling skills and the boundary", () => {
    const orientation = interviewOrientation({
      repositoryRoot: "/work/repo",
      spec: "specs/activation-email/spec.md",
      adr: "docs/adr",
    });
    expect(orientation).toContain("grilling");
    expect(orientation).toContain("domain-modeling");
    expect(orientation).toContain("specs/activation-email/spec.md");
    expect(orientation).toContain("docs/adr");
    expect(orientation).toMatch(/cannot approve, publish or merge/);
  });
});

describe("the streamed protocol", () => {
  it("refuses an undeclared field on a turn and on an event", () => {
    expect(InterviewTurnSchema.parse({ type: "turn", text: "hello" })).toEqual({
      type: "turn",
      text: "hello",
    });
    expect(() => InterviewTurnSchema.parse({ type: "turn", text: "hi", tool: "Bash" })).toThrow();
    expect(() =>
      InterviewEventSchema.parse({ type: "refused", tool: "Bash", rule: "x", target: null, reason: "r", extra: 1 }),
    ).toThrow();
  });
});

describe("Paseo (SCP-311 criterion 8)", () => {
  it("is followed as a design and named nowhere in the interview's own code", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = [
      join(here, "index.ts"),
      join(here, "claude.ts"),
      join(here, "codex.ts"),
      join(REPO_ROOT, "packages", "contracts", "src", "interview-protocol.ts"),
      join(here, "test-support", "fake-sdk.ts"),
      join(here, "test-support", "fake-app-server.ts"),
    ];
    for (const path of sources) {
      expect(readFileSync(path, "utf8").toLowerCase(), `${path} names Paseo`).not.toContain("paseo");
    }
  });
});

describe("the Claude Agent SDK", () => {
  it("is pinned in the catalog and in the lockfile", () => {
    const root = REPO_ROOT;
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const pinned = /"@anthropic-ai\/claude-agent-sdk":\s*(\d+\.\d+\.\d+)\s*$/m.exec(workspace);
    expect(pinned, "the catalog pins no @anthropic-ai/claude-agent-sdk").not.toBeNull();
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain(`@anthropic-ai/claude-agent-sdk@${pinned?.[1]}`);
    const manifest = JSON.parse(readFileSync(join(root, "apps", "cli", "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies["@anthropic-ai/claude-agent-sdk"]).toBe("catalog:");
    // The binary is one file with no `node_modules` beside it, so nothing here
    // may declare a dependency that would have to be installed with it.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});

/**
 * Where a call runs, which decides what it may write (D-102).
 *
 * Driven through the transport seam rather than through either provider,
 * because the two carry a directory differently: Codex names it on every
 * request, and the Claude session does not, so a shell that moves has to be
 * followed from call to call. Both readings meet here.
 */
describe("the directory a call is judged against", () => {
  const decisions = async (
    ask: (decide: InterviewSession["decide"]) => Promise<void>,
  ): Promise<string[]> => {
    const repo = repository();
    const behaviours: string[] = [];
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", SPEC_FOLDER],
      streams: { stdout: () => undefined, stderr: () => undefined, isTTY: false },
      cwd: repo,
      deps: {
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
        transport: {
          run: async function* (session) {
            await ask(async (tool, input, cwd) => {
              const decided = await session.decide(tool, input, cwd);
              behaviours.push(decided.behavior);
              return decided;
            });
            yield { session_id: "stub-1" };
          },
        },
      },
    });
    return behaviours;
  };

  it("resolves a directory the transport names against the repository", async () => {
    // The spec folder, named relative to the repository as the app server
    // names it. Judged against anything else, this write lands elsewhere.
    expect(
      await decisions(async (decide) => {
        await decide("Bash", { command: "cat > spec.md" }, SPEC_FOLDER);
      }),
    ).toEqual(["allow"]);
  });

  it("follows a shell that moves only where the transport names no directory", async () => {
    // A `cd` moves the tracked directory, and the call after it is judged
    // where that left the shell.
    expect(
      await decisions(async (decide) => {
        await decide("Bash", { command: `cd ${SPEC_FOLDER}` });
        await decide("Bash", { command: "cat > spec.md" });
      }),
    ).toEqual(["allow", "allow"]);
    // The same two calls, the first carrying its own directory: it moves no
    // shell, so the second is judged at the repository's root, where that
    // write lands outside the spec folder.
    expect(
      await decisions(async (decide) => {
        await decide("Bash", { command: `cd ${SPEC_FOLDER}` }, ".");
        await decide("Bash", { command: "cat > spec.md" });
      }),
    ).toEqual(["allow", "deny"]);
  });
});
