import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InterviewEventSchema, InterviewTurnSchema } from "@perbo/contracts/interview-protocol";
import { UsageError } from "../src/args.js";
import { claudeInterviewTransport } from "../src/interview-claude.js";

/** What the transport is told to run. The scripted SDK spawns nothing. */
const CLAUDE = "/usr/local/bin/claude";
import {
  INTERVIEW_AGENT_TOOLS,
  INTERVIEW_DENIED_TOOLS,
  INTERVIEW_PROVIDERS,
  INTERVIEW_SESSION_FILE,
  INTERVIEW_TOOL_NAMES,
  interviewOrientation,
  parseInterviewArgs,
  runInterviewCommand,
  type InterviewSession,
} from "../src/interview.js";
import { listTickets, readDraftSnapshot, storeDir } from "../src/tickets.js";
import type { Streams } from "../src/streams.js";
import {
  describeInterviewContract,
  drafter,
  gitIdentity,
  repository as makeRepository,
  SPEC,
  SPEC_FOLDER,
} from "./interview-contract.js";
import { claudeHarness, codexHarness } from "./interview-harness.js";
import { scriptedSdk, type ScriptStep } from "./interview-sdk.js";

/** The built command, for the approval an interview cannot make. */
const CLI = join(dirname(new URL(import.meta.url).pathname), "..", "dist", "main.js");

/**
 * `perbo interview`: the person's own Claude Code or Codex session (D-102).
 *
 * The behaviour that is the interview's, whichever transport is behind it, is
 * stated once in `interview-contract.ts` and run here once per transport. A
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
 * `interview-sdk.ts`, Codex's app server is the fake in
 * `interview-app-server.ts`, and the drafter is the scripted model
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
  extra: { argv?: string[]; sessionId?: string; spec?: string } = {},
) {
  const streams = capture();
  const sdk = scriptedSdk({ steps, cwd: repo, ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) });
  const code = await runInterviewCommand({
    argv: ["--repo", repo, "--spec", extra.spec ?? SPEC_FOLDER, ...(extra.argv ?? [])],
    streams,
    cwd: repo,
    transport: claudeInterviewTransport(sdk, CLAUDE),
    model: drafter(),
    turns: (async function* () {
      yield JSON.stringify({ type: "turn", text: "let us write the spec" });
    })(),
  });
  return { code, streams, sdk };
}

describe("parseInterviewArgs", () => {
  it("takes the repository, the spec, a session to resume, a model and a provider", () => {
    expect(parseInterviewArgs(["--repo", "..", "--spec", "specs/x", "--session", "s1", "--model", "claude-opus-5"])).toEqual({
      repo: "..",
      store: null,
      spec: "specs/x",
      session: "s1",
      model: "claude-opus-5",
      provider: "claude",
    });
    expect(parseInterviewArgs(["--provider", "codex"]).provider).toBe("codex");
    expect(() => parseInterviewArgs(["--provider", "gemini"])).toThrow(/claude or codex/);
    expect(() => parseInterviewArgs(["--approve"])).toThrow(UsageError);
    expect(() => parseInterviewArgs(["--spec"])).toThrow(/requires a value/);
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
    await runInterviewCommand({
      argv: ["--repo", repo, "--session", "sess-xyz"],
      streams,
      cwd: repo,
      transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo, sessionId: "sess-xyz" }), CLAUDE),
      model: drafter(),
      turns: (async function* () {
        yield JSON.stringify({ type: "turn", text: "hello" });
      })(),
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
    await runInterviewCommand({
      argv: ["--repo", repo, "--spec", "specs/linked"],
      streams,
      cwd: repo,
      transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
      model: drafter(),
      turns: (async function* () {
        yield JSON.stringify({ type: "turn", text: "hello" });
      })(),
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
    await runInterviewCommand({
      argv: ["--repo", repo, "--spec", SPEC_FOLDER],
      streams,
      cwd: repo,
      transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
      model: drafter(),
      turns: (async function* () {
        yield JSON.stringify({ type: "turn", text: "hello" });
      })(),
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
    await runInterviewCommand({
      argv: ["--repo", repo, "--session", "sess-two"],
      streams,
      cwd: repo,
      transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo, sessionId: "sess-two" }), CLAUDE),
      model: drafter(),
      turns: (async function* () {
        yield JSON.stringify({ type: "turn", text: "hello" });
      })(),
    });
    const started = events(streams)[0];
    expect(started?.type === "started" ? started.spec : null).toBe("specs/other/spec.md");
  });

  it("refuses a spec outside the repository's spec folder", async () => {
    const repo = repository();
    const streams = capture();
    await expect(
      runInterviewCommand({
        argv: ["--repo", repo, "--spec", "docs/notes"],
        streams,
        cwd: repo,
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
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
      runInterviewCommand({
        argv: ["--repo", repo, "--spec", named],
        streams: capture(),
        cwd: repo,
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
      await runInterviewCommand({
        argv: ["--repo", repo, "--spec", named],
        streams,
        cwd: repo,
        transport: claudeInterviewTransport(sdk, CLAUDE),
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
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
      runInterviewCommand({
        argv: ["--repo", repo],
        streams,
        cwd: repo,
        transport: claudeInterviewTransport(scriptedSdk({ steps: [], cwd: repo }), CLAUDE),
        model: drafter(),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "hello" });
        })(),
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
        ticket: null,
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
    const here = dirname(new URL(import.meta.url).pathname);
    const sources = [
      join(here, "..", "src", "interview.ts"),
      join(here, "..", "src", "interview-claude.ts"),
      join(here, "..", "src", "interview-codex.ts"),
      join(here, "..", "..", "..", "packages", "contracts", "src", "interview-protocol.ts"),
      join(here, "interview-sdk.ts"),
      join(here, "interview-app-server.ts"),
    ];
    for (const path of sources) {
      expect(readFileSync(path, "utf8").toLowerCase(), `${path} names Paseo`).not.toContain("paseo");
    }
  });
});

describe("the Claude Agent SDK", () => {
  it("is pinned in the catalog and in the lockfile", () => {
    const root = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
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
    const repo = repository(scratch);
    const behaviours: string[] = [];
    await runInterviewCommand({
      argv: ["--repo", repo, "--spec", SPEC_FOLDER],
      streams: { out: [], err: [], stdout: () => undefined, stderr: () => undefined, isTTY: false },
      cwd: repo,
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
