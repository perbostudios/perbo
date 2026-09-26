import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { InterviewEventSchema, InterviewTurnSchema } from "@perbo/contracts";
import { parseSpec } from "@perbo/planning";
import { UsageError } from "../../usage-error.js";
import { NEXT_STEPS } from "../../next-step.js";
import { driftKeyFor, readDriftRecord, writeDriftRecord } from "../../store/drift.js";
import { editCommandLine } from "../edit/index.js";
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
import { listTickets, readContract, readDraftSnapshot, storeDir } from "../../store/tickets.js";
import {
  admitSpec,
  describeInterviewContract,
  draftFromSpec,
  events,
  repository as makeRepository,
  SPEC,
  SPEC_FOLDER,
} from "./test-support/contract.js";
import { claudeHarness, codexHarness } from "./test-support/harness.js";
import { scriptedSdk, type ScriptStep } from "./test-support/fake-sdk.js";
import { BUILT_ENTRY, REPO_ROOT } from "../../test-support/paths.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams, type RecordedStreams } from "../../test-support/streams.js";

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

const writeSpec = (content = SPEC): ScriptStep => ({
  kind: "tool",
  tool: "Write",
  input: { file_path: `${SPEC_FOLDER}/spec.md`, content },
});
/**
 * The person's Generate plan press, between two of the session's steps, from
 * the spec as the session has just left it on disk. The session is told
 * nothing of it — it reads the store again on its next tool call.
 */
const generate = (repo: string, folder = SPEC_FOLDER): ScriptStep => ({
  kind: "act",
  act: () => admitSpec(repo, folder),
});

/** The sample spec, asking for two activation emails where it asked for one. */
const TWO = SPEC.replace("exactly one activation email", "exactly two activation emails");

/** The first criterion of PRB-1's plan as it stands. */
function firstCriterion(repo: string) {
  const contract = readContract(storeDir(repo, null), "PRB-1");
  if (!("acceptance_criteria" in contract)) throw new Error("the sample plan has criteria");
  return contract.acceptance_criteria[0]!;
}

/** The session's own `set_criterion`: new words, or the same words proven another way. */
const reword = (
  criterion: { id: string; expected_verification: unknown },
  text: string,
  proof: unknown = criterion.expected_verification,
) => ({
  kind: "call" as const,
  tool: "edit_plan",
  input: { graph_edit: { op: "set_criterion", id: criterion.id, text, expected_verification: proof } },
});

async function interview(
  repo: string,
  steps: readonly ScriptStep[],
  extra: { argv?: string[]; sessionId?: string; spec?: string; turns?: readonly string[] } = {},
) {
  const streams = recordStreams();
  const sdk = scriptedSdk({ steps, cwd: repo, ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) });
  const code = await runCommandLine(interviewCommandLine, {
    argv: ["--repo", repo, "--spec", extra.spec ?? SPEC_FOLDER, ...(extra.argv ?? [])],
    streams,
    cwd: repo,
    deps: {
      transport: claudeInterviewTransport(sdk, CLAUDE),
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
    const streams = recordStreams();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--session", "sess-xyz"],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo, sessionId: "sess-xyz" }), CLAUDE),
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
    const streams = recordStreams();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", "specs/linked"],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
      },
    });
    expect(existsSync(join(elsewhere, INTERVIEW_SESSION_FILE))).toBe(false);
    expect(streams.err()).toContain("outside");
  });

  it("writes no record through a record that is itself a symlink", async () => {
    const repo = repository();
    const elsewhere = join(scratch, "outside-file");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(repo, SPEC_FOLDER), { recursive: true });
    symlinkSync(join(elsewhere, "taken.json"), join(repo, SPEC_FOLDER, INTERVIEW_SESSION_FILE));
    const streams = recordStreams();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", SPEC_FOLDER],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
      },
    });
    expect(existsSync(join(elsewhere, "taken.json"))).toBe(false);
    expect(streams.err()).toContain("symlink");
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
    const streams = recordStreams();
    await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--session", "sess-two"],
      streams,
      cwd: repo,
      deps: {
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo, sessionId: "sess-two" }), CLAUDE),
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
    const streams = recordStreams();
    await expect(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", "docs/notes"],
        streams,
        cwd: repo,
        deps: {
          transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
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
        streams: recordStreams(),
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
      const streams = recordStreams();
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
    const streams = recordStreams();
    await expect(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo],
        streams,
        cwd: repo,
        deps: {
          transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
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

/**
 * The word that the spec is being written (D-102).
 *
 * The chat holds a session's opening line until it has said everything it is
 * going to, and drops it the moment the session does anything — so a line
 * saying "writing the spec now" is by construction the line that rule
 * swallows. The fact has to leave the process as an event instead, said as
 * the write is admitted, which is when the person is waiting on it.
 */
describe("wrote_spec", () => {
  const wrote = (streams: RecordedStreams) =>
    events(streams).filter((event) => event.type === "wrote_spec");

  it("is said once for each admitted write of the spec", async () => {
    const repo = repository();
    const { streams } = await interview(repo, [
      writeSpec(),
      writeSpec(SPEC.replace("60 seconds", "30 seconds")),
    ]);
    expect(wrote(streams)).toHaveLength(2);
    // And it is said as the write is admitted, before the tool has run: the
    // person reads it while they are waiting, not after.
    const said = events(streams).map((event) => event.type);
    expect(said.indexOf("wrote_spec")).toBeLessThan(said.indexOf("idle"));
  });

  it("is not said for a write the guard refused, or for a write somewhere else", async () => {
    const repo = repository();
    const { streams } = await interview(repo, [
      // Another piece of work's spec: refused, and it wrote nothing.
      { kind: "tool", tool: "Write", input: { file_path: "specs/somebody-else/spec.md", content: "# theirs\n" } },
      // Admitted, and this session's to write — but not the spec.
      { kind: "tool", tool: "Write", input: { file_path: "CONTEXT.md", content: "# Terms\n" } },
      { kind: "tool", tool: "Write", input: { file_path: `${SPEC_FOLDER}/notes.md`, content: "# notes\n" } },
    ]);
    expect(wrote(streams)).toHaveLength(0);
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
    await interview(repo, [writeSpec(), generate(repo)]);
    await interview(repo, [
      {
        kind: "tool",
        tool: "Write",
        input: { file_path: `${second}/spec.md`, content: SPEC.replace("Activation email", "Another thing") },
      },
      generate(repo, second),
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

  /**
   * SCP-311: an edit that changes what the plan promises takes the spec with
   * it, in the same turn.
   *
   * The plan and the spec are one document in two places, and the interview is
   * the only editor that holds both (D-102). Every other way they can part is
   * caught by reading requirement ids; this one is not, because a criterion
   * reworded in the plan and left unsaid in the spec still cites the same id.
   */
  describe("an edit that changes what the plan promises", () => {
    /** The criterion this plan carries, and the id it answers. */
    async function drafted(repo: string) {
      await interview(repo, [writeSpec(), generate(repo)]);
      return firstCriterion(repo);
    }

    it("is refused where the spec was not written in the same turn", async () => {
      const repo = repository();
      const first = await drafted(repo);
      const { sdk } = await interview(repo, [
        reword(first, "A signup POST queues exactly two activation emails."),
      ]);
      // The session is told why, in words it can act on: the refusal names the
      // one thing to do first.
      const refused = sdk.calls[0]?.result ?? "";
      expect(sdk.calls[0]?.isError).toBe(true);
      expect(refused).toMatch(/changes what PRB-1 promises/);
      expect(refused).toMatch(/Write the spec first, in this turn/);
      // And it says what is still direct, so it does not read as a wall.
      expect(refused).toMatch(/splitting, merging and drawing edges/);
      // Nothing was written: the plan still promises what the spec says.
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(0);
      expect(firstCriterion(repo).text).toBe(first.text);
    });

    it("is taken where the spec was written alongside it", async () => {
      const repo = repository();
      const first = await drafted(repo);
      await interview(repo, [
        writeSpec(TWO),
        reword(first, "A signup POST queues exactly two activation emails."),
      ]);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(1);
    });

    it("leaves an edit that only rearranges the plan alone", async () => {
      // A plan may be arranged any way at all without touching the spec: what
      // the work is for did not change
      // (D-128).
      const repo = repository();
      await interview(repo, [writeSpec(), generate(repo)]);
      await interview(repo, [
        {
          kind: "call",
          tool: "edit_plan",
          input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } },
        },
      ]);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(1);
    });

    it("holds a spec write to the turn it was made in, not to the session", async () => {
      // One spec write covers every edit made beside it, and the next change
      // has to say so again — otherwise a single write early in a planning
      // would license every later change to what the plan promises.
      const repo = repository();
      const first = await drafted(repo);
      const { sdk } = await interview(
        repo,
        [
          writeSpec(TWO),
          reword(first, "A signup POST queues exactly two activation emails."),
          // The person's next turn. Nothing is written to the spec in it.
          { kind: "await" },
          reword(first, "A signup POST queues exactly three activation emails."),
        ],
        { turns: ["let us write the spec", "and again"] },
      );
      expect(sdk.prompts.length, "the person sent a second turn").toBe(2);
      // The spec write is a call of its own, so the two edits are the next two.
      const edits = sdk.calls.filter((call) => call.tool.endsWith("edit_plan"));
      expect(edits[0]?.isError, "written alongside it").toBe(false);
      expect(edits[1]?.isError, "a turn later, with nothing written").toBe(true);
      expect(edits[1]?.result ?? "").toMatch(/changes what PRB-1 promises/);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(1);
    });

    it("holds an undo that puts a criterion's words back to the same rule", async () => {
      // Taking an edit back changes what the plan promises just as making it
      // did, and leaves the spec saying the new words.
      const repo = repository();
      const first = await drafted(repo);
      await interview(repo, [
        writeSpec(TWO),
        reword(first, "A signup POST queues exactly two activation emails."),
      ]);
      const { sdk } = await interview(repo, [
        { kind: "call", tool: "undo_edit", input: { edit: 1 } },
      ]);
      expect(sdk.calls[0]?.isError).toBe(true);
      expect(sdk.calls[0]?.result ?? "").toMatch(/takes an edit back that did/);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(1);
    });

    it("leaves an undo of an edit that only rearranged the plan alone", async () => {
      const repo = repository();
      await interview(repo, [
        writeSpec(),
        generate(repo),
        { kind: "call", tool: "edit_plan", input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } } },
      ]);
      await interview(repo, [{ kind: "call", tool: "undo_edit", input: { edit: 1 } }]);
      const edits = readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? [];
      expect(edits).toHaveLength(2);
      expect(edits[1]?.undoes).toBe(1);
    });

    it("leaves the plan being made flat again alone, which keeps every criterion", async () => {
      // The last node deleted with nothing moved and nothing dropped is the
      // plan ungrouped: arrangement, and the canonical document says so.
      const repo = repository();
      await interview(repo, [writeSpec(), generate(repo)]);
      await interview(repo, [
        {
          kind: "call",
          tool: "edit_plan",
          input: { graph_edit: { op: "delete_node", id: "node_2", move_criteria_to: "node_1" } },
        },
        {
          kind: "call",
          tool: "edit_plan",
          input: { graph_edit: { op: "delete_node", id: "node_1" } },
        },
      ]);
      const edits = readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? [];
      expect(edits).toHaveLength(2);
    });

    // Each of the three ways a plan can come to promise something else, held to
    // the same rule. Refused before the edit path reads them, so the shapes
    // here need only be well formed.
    it.each([
      ["the outcome", { outcome: "New users receive nothing at all." }],
      [
        "a criterion added whole",
        {
          graph_edit: {
            op: "add_node",
            title: "More",
            paths: ["src/**"],
            new_criteria: [
              { text: "An unsubscribe link is present.", expected_verification: { kind: "test", assertion: "it is" } },
            ],
          },
        },
      ],
      [
        "a criterion dropped whole",
        { graph_edit: { op: "delete_node", id: "node_1", move_criteria_to: null, delete_criteria: ["ac_1"] } },
      ],
    ])("refuses %s where the spec was not written alongside it", async (_name, input) => {
      const repo = repository();
      await interview(repo, [writeSpec(), generate(repo)]);
      const { sdk } = await interview(repo, [{ kind: "call", tool: "edit_plan", input }]);
      expect(sdk.calls[0]?.isError).toBe(true);
      expect(sdk.calls[0]?.result ?? "").toMatch(/changes what PRB-1 promises/);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(0);
    });

    it("leaves an undo of a change of proof alone, a turn later", async () => {
      // Taking back an edit that changed only how a criterion is proven puts
      // no words back, so it needs no spec write either.
      const repo = repository();
      const first = await drafted(repo);
      await interview(repo, [
        reword(first, first.text, { kind: "artifact", assertion: "A queued message is on the wire." }),
      ]);
      const { sdk } = await interview(repo, [{ kind: "call", tool: "undo_edit", input: { edit: 1 } }]);
      expect(sdk.calls[0]?.isError).toBe(false);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(2);
    });

    it("leaves an undo the edit path will refuse to refuse in its own words", async () => {
      // An edit already taken back cannot be taken back again, and the edit
      // path says so. Answering "write the spec first" instead would send the
      // session to write a spec for an undo that was never going to land.
      //
      // The edit is a change of promise, so this is a case the guard would
      // otherwise answer: an undo of a mere rearrangement is let through
      // either way and could not tell the two apart.
      const repo = repository();
      const first = await drafted(repo);
      await interview(repo, [
        writeSpec(TWO),
        reword(first, "A signup POST queues exactly two activation emails."),
      ]);
      await interview(repo, [
        writeSpec(),
        { kind: "call", tool: "undo_edit", input: { edit: 1 } },
      ]);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits[0]?.undone).toBe(true);
      // A turn later, nothing written, taking edit 1 back a second time.
      const { sdk } = await interview(repo, [{ kind: "call", tool: "undo_edit", input: { edit: 1 } }]);
      expect(sdk.calls[0]?.isError).toBe(true);
      expect(sdk.calls[0]?.result ?? "").not.toMatch(/Write the spec first/);
    });

    it("leaves a change of proof alone, which is not a change of promise", async () => {
      // The same criterion, proven another way. Refusing this would refuse the
      // one edit the rule deliberately leaves direct.
      const repo = repository();
      const first = await drafted(repo);
      await interview(repo, [
        reword(first, first.text, { kind: "artifact", assertion: "A queued message is on the wire." }),
      ]);
      expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(1);
    });
  });

  // The other side of the same rule. An edit's report is relayed whether it
  // worked or not, and a refused one is the text the dock shows without asking
  // — so it is the one most likely to be read, and was the one still naming a
  // command to type.
  it("relays an edit, and a refused edit, without the commands to type", async () => {
    const repo = repository();
    const { sdk } = await interview(repo, [
      writeSpec(),
      generate(repo),
      { kind: "call", tool: "edit_plan", input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_2" } } },
      // An edge to a node that is not in the plan: refused by the edit path.
      { kind: "call", tool: "edit_plan", input: { graph_edit: { op: "remove_edge", from: "node_1", to: "node_404" } } },
    ]);
    const applied = sdk.calls[1]?.result ?? "";
    expect(sdk.calls[1]?.isError).toBe(false);
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
    const refused = sdk.calls[2]?.result ?? "";
    expect(sdk.calls[2]?.isError).toBe(true);
    expect(refused.trim()).toBe("this plan has no edge node_1 -> node_404");
    // And a refused edit is not a recorded one: the edge that did come out is
    // still the only edit this plan has.
    expect(readDraftSnapshot(storeDir(repo, null), "PRB-1")?.edits ?? []).toHaveLength(1);
  });

  it("says a plan is approved rather than that none was drafted", async () => {
    const repo = repository();
    await interview(repo, [writeSpec(), generate(repo)]);
    execFileSync(process.execPath, [CLI, "approve", "PRB-1", "--repo", repo], { stdio: "ignore" });
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
    ]);
    expect(contract.sdk.calls[0]?.isError).toBe(true);
    // Refused for being approved, in the edit path's own words — not sent off
    // to write the spec of work already approved, to reach that same refusal.
    expect(contract.sdk.calls[0]?.result ?? "").not.toMatch(/Write the spec first/);
    expect(listTickets(storeDir(repo, null)).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
  }, 30_000);

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
    // And the one that has a state rule says which state it is about.
    expect(described.get("edit_plan")).toMatch(/approved/);
  });

});

/**
 * The plan's verdict across a chat turn
 * (D-128).
 *
 * A chat edit is held to the spec, so a clean verdict from before the turn
 * still holds after it and is carried to the new hashes; nothing else moves
 * it. What the carry is measured from is the state the turn began at, which
 * is what keeps a hand edit nobody read from being washed away by a later
 * chat turn.
 */
describe("the plan's verdict across a chat turn", () => {
  const SPEC_PATH = `${SPEC_FOLDER}/spec.md`;

  /** The state the pair is at now, as the record is keyed. */
  const keyNow = (repo: string) =>
    driftKeyFor({
      repositoryRoot: repo,
      specPath: SPEC_PATH,
      contract: readContract(storeDir(repo, null), "PRB-1"),
    });

  /** The first criterion of the drafted plan, and the seeded verdict beside it. */
  async function drafted(repo: string) {
    await interview(repo, [writeSpec(), generate(repo)]);
    const dir = storeDir(repo, null);
    const seeded = readDriftRecord(dir, "PRB-1");
    if (seeded === null) throw new Error("admission seeds the verdict");
    expect(seeded.origin).toBe("drafted");
    expect({ spec: seeded.spec, promises: seeded.promises }).toEqual(keyNow(repo));
    return { dir, first: firstCriterion(repo), seeded };
  }

  it("carries a clean verdict past a turn that wrote the spec and moved the plan", async () => {
    const repo = repository();
    const { dir, first, seeded } = await drafted(repo);
    const { sdk } = await interview(repo, [
      writeSpec(TWO),
      reword(first, "A signup POST queues exactly two activation emails."),
    ]);
    expect(sdk.calls.at(-1)?.isError, "the edit was taken").toBe(false);
    const record = readDriftRecord(dir, "PRB-1");
    expect(record?.origin).toBe("carried");
    expect(record?.findings).toEqual([]);
    expect(record?.dismissed).toBe(false);
    expect(record?.model).toBeNull();
    // At the new hashes, both of which moved.
    const now = keyNow(repo);
    expect({ spec: record?.spec, promises: record?.promises }).toEqual(now);
    expect(now.spec).not.toBe(seeded.spec);
    expect(now.promises).not.toBe(seeded.promises);
  });

  it("leaves the verdict where it was after a turn that wrote the spec alone", async () => {
    // The plan was not moved, so nothing vouches for it against the new
    // spec: it is read on the way to the contract.
    const repo = repository();
    const { dir, seeded } = await drafted(repo);
    await interview(repo, [writeSpec(TWO)]);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);
    expect(keyNow(repo).spec).not.toBe(seeded.spec);
  });

  it("leaves the verdict where it was after a turn whose edit was refused", async () => {
    // The spec moved and the plan did not: an edit the edit path refused —
    // here, of a criterion the plan does not carry — is not a move, whatever
    // the turn wrote beside it.
    const repo = repository();
    const { dir, first, seeded } = await drafted(repo);
    const { sdk } = await interview(repo, [
      writeSpec(TWO),
      reword({ ...first, id: "ac_99" }, "A signup POST queues exactly two activation emails."),
    ]);
    expect(sdk.calls.at(-1)?.isError, "refused: no such criterion").toBe(true);
    expect(keyNow(repo).spec).not.toBe(seeded.spec);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);
  });

  /** A person's own rewording of the first criterion, at the Graph pane. */
  const byHand = async (repo: string, first: { id: string; expected_verification: unknown }, text: string) => {
    const edited = await runCommandLine(editCommandLine, {
      argv: [
        "PRB-1",
        "--repo",
        repo,
        "--graph-edit",
        JSON.stringify({ op: "set_criterion", id: first.id, text, expected_verification: first.expected_verification }),
      ],
      streams: recordStreams(),
      cwd: repo,
    });
    expect(edited).toBe(0);
  };

  it("does not wash away a hand edit the turn did not begin from", async () => {
    const repo = repository();
    const { dir, first, seeded } = await drafted(repo);
    // Nothing has read it.
    await byHand(repo, first, "A signup POST queues exactly two activation emails.");
    const edited = keyNow(repo);
    expect(edited.promises).not.toBe(seeded.promises);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);

    // A chat turn that then writes the spec and moves the plan under the
    // guard: the record is not the one this turn began from, so it stays.
    const { sdk } = await interview(repo, [
      writeSpec(SPEC.replace("exactly one activation email", "exactly three activation emails")),
      reword(first, "A signup POST queues exactly three activation emails."),
    ]);
    expect(sdk.calls.at(-1)?.isError, "the edit was taken").toBe(false);
    expect(keyNow(repo)).not.toEqual(edited);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);
  });

  it("leaves a reading with findings for the page to read again", async () => {
    // Findings are about words, and the turn moved the words: carrying them
    // would vouch for nothing, and dropping them would say the two agree.
    const repo = repository();
    const { dir, first } = await drafted(repo);
    const read = {
      ...keyNow(repo),
      origin: "read" as const,
      findings: [
        {
          heading: "Criterion 1 and R1",
          difference: "The spec asks for one email; the plan promises two.",
          options: [
            { label: "Reword criterion 1 to say one email.", detail: null, recommended: true },
            { label: "Change R1 to ask for two.", detail: null, recommended: false },
          ],
        },
      ],
      dismissed: false,
      checked_at: "2026-09-21T10:00:00.000Z",
      model: null,
    };
    writeDriftRecord(dir, "PRB-1", read);
    const { sdk } = await interview(repo, [
      writeSpec(TWO),
      reword(first, "A signup POST queues exactly two activation emails."),
    ]);
    expect(sdk.calls.at(-1)?.isError, "the edit was taken").toBe(false);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(read);
  });

  /**
   * The turns a transport is driven through by hand: the session's tools run
   * against the store as an admitted call runs them, and a write the guard
   * admits is performed as the session's own would be.
   */
  type Turns = AsyncIterator<string>;
  const stubbed = async (
    repo: string,
    turns: readonly string[],
    script: (session: InterviewSession, pulled: Turns) => AsyncGenerator<{ session_id?: string; idle?: number }>,
  ) => {
    const streams = recordStreams();
    const code = await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", SPEC_FOLDER],
      streams,
      cwd: repo,
      deps: {
        turns: (async function* () {
          for (const text of turns) yield JSON.stringify({ type: "turn", text });
        })(),
        transport: {
          run: async function* (session) {
            const pulled = session.turns[Symbol.asyncIterator]();
            await pulled.next();
            yield { session_id: "stub-carry" };
            yield* script(session, pulled);
          },
        },
      },
    });
    expect(code).toBe(0);
    return streams;
  };
  /** The session writing the spec: admitted by the guard, then performed. */
  const sessionWrites = async (session: InterviewSession, repo: string, content: string) => {
    const decided = await session.decide("Write", { file_path: SPEC_PATH, content });
    expect(decided.behavior).toBe("allow");
    writeFileSync(join(repo, SPEC_PATH), content);
  };
  /** The session calling one of its own tools, admitted and then run. */
  const sessionCalls = async (session: InterviewSession, tool: string, input: Record<string, unknown>) => {
    const decided = await session.decide(`mcp__perbo_interview__${tool}`, input);
    expect(decided.behavior).toBe("allow");
    const bound = session.tools.find((each) => each.name === tool);
    if (bound === undefined) throw new Error(`the session holds ${tool}`);
    const result = await bound.run(input);
    expect(result.isError, result.content[0]?.text).not.toBe(true);
  };

  for (const queued of [false, true]) {
    it(`carries a turn that moved the plan ${queued ? "while a further turn was queued behind it" : "with nothing queued behind it"}`, async () => {
      // The Claude transport pulls the next turn as soon as the person sends
      // it, while the turn before is still working: what the carry is
      // measured from is the turn's own start, not the moment of the pull.
      const repo = repository();
      const { dir, first, seeded } = await drafted(repo);
      const rewording = reword(first, "A signup POST queues exactly two activation emails.");
      await stubbed(repo, ["make it two", "and go on"], async function* (session, pulled) {
        await sessionWrites(session, repo, TWO);
        await sessionCalls(session, "edit_plan", rewording.input);
        if (queued) await pulled.next();
        yield { idle: 1 };
      });
      const record = readDriftRecord(dir, "PRB-1");
      expect(record?.origin).toBe("carried");
      const now = keyNow(repo);
      expect({ spec: record?.spec, promises: record?.promises }).toEqual(now);
      expect(now).not.toEqual({ spec: seeded.spec, promises: seeded.promises });
    });
  }

  it("does not carry past a hand edit made while the turn was running", async () => {
    // The chat's edit lands on a plan a hand moved under it, so what it
    // leaves is not a plan this session alone brought from the spec: the
    // record stays at the hashes it had, for the page to read.
    const repo = repository();
    const { dir, first, seeded } = await drafted(repo);
    const { sdk } = await interview(repo, [
      writeSpec(TWO),
      { kind: "act", act: () => byHand(repo, first, "A signup POST queues two activation emails.") },
      reword(first, "A signup POST queues exactly two activation emails."),
    ]);
    expect(sdk.calls.at(-1)?.isError, "the edit was taken").toBe(false);
    expect(keyNow(repo)).not.toEqual({ spec: seeded.spec, promises: seeded.promises });
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);
  });

  it("does not carry past a spec a hand rewrote between two turns", async () => {
    // The spec moved while the chat was idle, and nobody has read the plan
    // against it. A turn that then arranges the plan without touching what it
    // promises is not a reading of it either: a verdict carried to the new
    // spec would vouch for words nobody read.
    const repo = repository();
    const { dir, first, seeded } = await drafted(repo);
    const { input: arrangement } = reword(first, first.text, {
      ...first.expected_verification,
      assertion: "the queue holds one job for the address",
    });
    await stubbed(repo, ["hello", "prove it differently"], async function* (session, pulled) {
      yield { idle: 1 };
      writeFileSync(join(repo, SPEC_PATH), TWO);
      await pulled.next();
      await sessionCalls(session, "edit_plan", arrangement);
      yield { idle: 1 };
    });
    expect(keyNow(repo).spec).not.toBe(seeded.spec);
    expect(keyNow(repo).promises).toBe(seeded.promises);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);
  });

  it("does not take a write elsewhere as the spec's own move", async () => {
    // The turn wrote CONTEXT.md, which the guard admits, and a hand rewrote
    // the spec under it. A write is the session's own only where it names
    // the spec: any other admitted write, or a command, says nothing about
    // who moved the spec, so the turn carries nothing.
    const repo = repository();
    const { dir, first, seeded } = await drafted(repo);
    const { input: arrangement } = reword(first, first.text, {
      ...first.expected_verification,
      assertion: "the queue holds one job for the address",
    });
    await stubbed(repo, ["hello"], async function* (session) {
      const decided = await session.decide("Write", { file_path: "CONTEXT.md", content: "# Context\n" });
      expect(decided.behavior).toBe("allow");
      writeFileSync(join(repo, "CONTEXT.md"), "# Context\n");
      writeFileSync(join(repo, SPEC_PATH), TWO);
      await sessionCalls(session, "edit_plan", arrangement);
      yield { idle: 1 };
    });
    expect(keyNow(repo).spec).not.toBe(seeded.spec);
    expect(readDriftRecord(dir, "PRB-1")).toEqual(seeded);
  });

  it("carries nothing from a turn a plan appeared under", async () => {
    // A plan admitted while the turn runs is another hand's: the interview no
    // longer drafts, so a ticket that was not there when the turn began came
    // from somewhere this session cannot vouch for, and the turn carries
    // nothing however cleanly its own edit landed. The verdict admission
    // seeded stays, and the reading on the way to the contract is what moves
    // it.
    const { first } = await drafted(repository());
    const repo = repository();
    const { sdk } = await interview(repo, [
      writeSpec(),
      generate(repo),
      writeSpec(TWO),
      reword(first, "A signup POST queues exactly two activation emails."),
    ]);
    expect(sdk.calls.at(-1)?.isError, "the edit was taken").toBe(false);
    const record = readDriftRecord(storeDir(repo, null), "PRB-1");
    expect(record?.origin).toBe("drafted");
    expect(record?.spec, "the spec moved past the seeded verdict").not.toBe(keyNow(repo).spec);
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
    expect(appended).toContain("edit_plan");
    expect(appended).toBe(
      interviewOrientation({
        spec: `${SPEC_FOLDER}/spec.md`,
        adr: "docs/adr",
        repositoryRoot: repo,
        names: [],
      }),
    );
  });

});

describe("the orientation", () => {
  const oriented = interviewOrientation({
    repositoryRoot: "/work/repo",
    spec: "specs/activation-email/spec.md",
    adr: "docs/adr",
    names: [],
  });

  it("carries the bundled grilling and domain-modelling skills and the boundary", () => {
    expect(oriented).toContain("grilling");
    expect(oriented).toContain("domain-modeling");
    expect(oriented).toContain("specs/activation-email/spec.md");
    expect(oriented).toContain("docs/adr");
    expect(oriented).toMatch(/cannot approve, publish or merge/);
  });

  // The interview writes the spec and stops there: the plan is the person's
  // to generate, and a session told to call a tool it does not hold
  // spends a turn being refused and says afterwards that it drafted.
  it("says the spec is written and stopped at, and the plan is the person's", () => {
    expect(oriented).toMatch(/write it and stop/);
    expect(oriented).toMatch(/the plan is the person's to generate from it/);
    expect(oriented).toMatch(/Spec pane/);
    expect(oriented).toMatch(/you hold no tool that drafts one/);
    // And it says nothing in the chat when it has: the app hands the spec
    // over, and a closing line of its own is that note said again (D-102).
    expect(oriented).toMatch(/Having written it, end the turn without a message/);
    // The silence is the first write's, before there is a plan: a spec
    // written while a plan is drafted owes the line saying why the plan needs
    // no change, and an unqualified "say nothing more" would contradict it.
    expect(oriented).toMatch(
      /When the spec is first written, before there is a plan, say nothing more:\s+the\s+app says so/,
    );
    expect(oriented).not.toMatch(/When the spec is written, say nothing more/);
    expect(oriented).toMatch(/when you write the spec while a plan is drafted/);
    expect(oriented).toMatch(/say in one line why the plan needs no\s+change/);
    expect(oriented).not.toMatch(/say so in a sentence/);
    // Nothing tells it to draft, by name or otherwise.
    expect(oriented).not.toContain("generate_plan");
  });

  it("holds the plan to the spec both ways", () => {
    // An edit of a promise writes the spec first; a spec write moves the plan
    // to answer it, or says why not, in the same turn.
    expect(oriented).toMatch(/write the spec first, in the same turn/);
    expect(oriented).toMatch(/make the plan\nanswer it in the same turn/);
    expect(oriented).toMatch(/say in one line why the plan needs no\nchange/);
    expect(oriented).toMatch(/read against the spec on the way to the contract/);
    // An answer to one of the reading's problems is acted on, not asked about.
    expect(oriented).toMatch(/one of those answers is a decision already made: act on it/);
    expect(oriented).toMatch(/ask nothing you can\nact without/);
  });

  // The drafter reads a requirement only as a list item beginning with its id
  // (D-103), so the form the session is told is the one parseSpec accepts. A
  // session not told it writes "R1. …" paragraphs, which admit --from-spec
  // refuses.
  it("names the list-item form the drafter reads requirements, No-Gos and Rabbit holes in", () => {
    const form = /Write each requirement as a list item, `([^`]+)`, with ids R1 upward\s+and never reused/.exec(
      oriented,
    )?.[1];
    expect(form).toBe("- R1: what must be true");
    expect(oriented).toMatch(/each No-Go and Rabbit hole as a plain `- ` item/);
    const spec = parseSpec(
      `# T\n\n## Outcome\n\nOne.\n\n## Requirements\n\n${form}\n\n## No-Gos\n\n- None.\n`,
    );
    expect(spec.requirements).toEqual([{ id: "R1", text: "what must be true" }]);
    expect(spec.no_gos).toEqual(["None."]);
  });

  it("says which of its two conversations this one is, and what tells them apart", () => {
    // The session is an interview until the plan exists and a chat after it
    // (D-102), and which it is changes what a turn is for: questioning and
    // writing the spec, or changing the spec and the plan together. The dock
    // says which to the person; this says it to the session.
    expect(oriented).toMatch(/two phases/);
    // Which one, told by the one fact that separates them.
    expect(oriented).toMatch(/whether a plan exists/);
    expect(oriented).toMatch(/you are an interview: you question them and write the spec/);
    expect(oriented).toMatch(/the interview ends when the spec is\nwritten and they generate the plan from it/);
    expect(oriented).toMatch(/From then on you are a chat/);
    expect(oriented).toMatch(/every turn is a change to the pair/);
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

describe("the orientation asks for the spec's title as a title", () => {
  // D-118, D-127: the folder is named
  // from the first message, and the title line is the interview's to make a
  // title of, named apart from the board as the drafter names a ticket.
  const oriented = interviewOrientation({
    repositoryRoot: "/work/repo",
    spec: "specs/a-simple-snake-game/spec.md",
    adr: "docs/adr",
    names: ["Twin-dial clock", "Snake on a\n walled board"],
  });
  const namesIn = (prompt: string) =>
    /<perbo:names trust="repo"[^>]*>\n([\s\S]*?)\n<\/perbo:names>/.exec(prompt)?.[1]?.split("\n");

  it("asks for a title, not a sentence or a cut of the message, when it first writes the spec", () => {
    expect(oriented).toMatch(/The spec's one `#` heading is its title/);
    expect(oriented).toMatch(
      /Where that line is\nUntitled — the folder was named from the person's first message, and the work has no title\nyet — and only then, make it a title when you first write the spec/,
    );
    expect(oriented).toMatch(/as a noun\nphrase and not a sentence or a cut of what they said/);
    expect(oriented).toMatch(/tell it apart from every name in the names block below/);
    expect(oriented).toMatch(/The folder keeps its name/);
    expect(oriented).toMatch(/Once a plan is drafted the title is\nthe ticket's name and follows it/);
  });

  it("is shown every ticket's name but the one drafted from its own spec", async () => {
    const repo = repository();
    await draftFromSpec(repo);
    mkdirSync(join(repo, "specs", "clock"), { recursive: true });
    writeFileSync(join(repo, "specs", "clock", "spec.md"), SPEC.replace(/^# .*$/m, "# Twin-dial clock"));
    await admitSpec(repo, "specs/clock");

    let told = "";
    const code = await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", SPEC_FOLDER],
      streams: recordStreams(),
      cwd: repo,
      deps: {
        turns: (async function* () {})(),
        transport: {
          run: async function* (session) {
            told = session.orientation;
            yield { session_id: "stub-names" };
          },
        },
      },
    });
    expect(code).toBe(0);
    expect(namesIn(told)).toEqual(["Twin-dial clock"]);
  });

  it("shows the other tickets' names in a repo-trust block, one a line", () => {
    expect(namesIn(oriented)).toEqual(["Twin-dial clock", "Snake on a walled board"]);
  });
});
