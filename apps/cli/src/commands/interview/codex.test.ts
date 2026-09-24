import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { CODEX_INTERVIEW_ARGV, codexInterviewTransport } from "./codex.js";
import { INTERVIEW_TOOL_NAMES, interviewCommandLine } from "./index.js";
import { fakeAppServer, type ServerStep } from "./test-support/fake-app-server.js";
import {
  draftFromSpec,
  events,
  refusals,
  repository,
  SPEC,
  SPEC_FOLDER,
} from "./test-support/contract.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * The interview on Codex: what only this transport has (SCP-312, D-102).
 *
 * The behaviour both transports share is in `test-support/contract.ts`, run
 * once per transport from `index.test.ts`. Here is the app server itself — the
 * invocation, the approval requests its protocol sends, and the thread resume
 * it offers — driven against the fake server in `test-support/fake-app-server.ts`.
 * Nothing starts a real `codex` and nothing reaches a model.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-interview-codex-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function interview(
  steps: readonly ServerStep[],
  extra: {
    argv?: readonly string[];
    threadId?: string;
    turns?: number;
    cwd?: string;
    /** A plan admitted from the spec before the session runs, as the person's press admits one. */
    drafted?: boolean;
  } = {},
) {
  const repo = repository(scratch);
  if (extra.drafted === true) await draftFromSpec(repo);
  const server = fakeAppServer({
    root: mkdtempSync(join(scratch, "app-server-")),
    steps,
    threadId: extra.threadId ?? "thread-0001",
  });
  const streams = recordStreams();
  const code = await runCommandLine(interviewCommandLine, {
    argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "codex", ...(extra.argv ?? [])],
    streams,
    cwd: extra.cwd ?? repo,
    deps: {
      transport: codexInterviewTransport({ binary: server.binary, codexHome: server.codexHome }),
      turns: (async function* () {
        for (let i = 0; i < (extra.turns ?? 1); i += 1) {
          yield JSON.stringify({ type: "turn", text: `turn ${i}` });
        }
      })(),
    },
  });
  return { code, repo, server, streams };
}

const writeSpec: ServerStep = {
  kind: "fileChange",
  path: `${SPEC_FOLDER}/spec.md`,
  content: SPEC,
};

describe("the app server the interview starts", () => {
  it("runs it with the argv, home and thread the interview's boundary is made of", async () => {
    const { server, code } = await interview([]);
    expect(code).toBe(EXIT_CODES.approve);
    const invocation = server.invocation();
    // Written out rather than compared against the constant the session sends,
    // which would be the same value on both sides and hold nothing: these are
    // the settings the boundary is made of, and each is here for a reason the
    // module states.
    expect(invocation.argv).toEqual([
      "-c",
      "agents.enabled=false",
      "-c",
      'model_provider="openai"',
      "-c",
      'web_search="disabled"',
      "app-server",
    ]);
    expect([...CODEX_INTERVIEW_ARGV]).toEqual(invocation.argv);
    // The person's own login, and none of their configuration: a tool server
    // or a rule in their `config.toml` would decide a call the guard is what
    // decides (D-102, ADR-0030).
    expect(invocation.env.CODEX_HOME).not.toBe(server.codexHome);
    expect(invocation.home).toEqual(["auth.json"]);
    expect(Object.keys(invocation.env)).toEqual(["CODEX_HOME"]);

    const opened = server.opened();
    expect(opened.method).toBe("thread/start");
    // Every write, and every command outside the set Codex itself trusts as
    // read-only, is escalated to this client, and this client is the
    // interview's rules: a read-only sandbox performs no write without an
    // approval, and `untrusted` asks about every command Codex does not trust.
    expect(opened.params).toMatchObject({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(opened.params.cwd).toContain("repo-");
    expect(String(opened.params.developerInstructions)).toContain("grilling");
    const tools = opened.params.dynamicTools as Array<{
      name: string;
      type: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools.map((each) => each.name).sort()).toEqual([...INTERVIEW_TOOL_NAMES].sort());
    for (const tool of tools) expect(tool.type).toBe("function");
    // The fields a tool takes are the only ones it takes: a call carrying one
    // it does not is refused by the schema the session was given rather than
    // reaching the tool. (What this holds is the constraint on the wire. Zod
    // emits it for `z.object` as well as for the `z.strictObject` that states
    // it, so the spelling itself is not something a test can tell apart.)
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("asks for the capability the interview's own tools reach the thread through", async () => {
    const { server, code } = await interview([]);
    expect(code).toBe(EXIT_CODES.approve);
    // `dynamicTools` is the one boundary field the generated schema does not
    // carry: the pinned Codex holds it behind `experimentalApi`, so a
    // handshake that did not ask for it opens a thread the interview's own
    // tools never reach, and the session would have only Codex's to work with.
    expect(server.initialized()).toMatchObject({
      clientInfo: { name: "perbo_interview" },
      capabilities: { experimentalApi: true },
    });
  });

  it("passes over a line that is not a message, rather than failing the turn on it", async () => {
    // A blank line on stdout is not a message and parsing it as one ends the
    // session: what the server went on to say would never reach the person.
    const { streams, code } = await interview([
      { kind: "blank" },
      { kind: "say", text: "still here" },
    ]);
    expect(code).toBe(EXIT_CODES.approve);
    const said = events(streams).flatMap((event) =>
      event.type === "message" ? [event.message] : [],
    );
    expect(JSON.stringify(said)).toContain("still here");
  });

  it("announces the thread the server gave back, before any turn", async () => {
    const { streams } = await interview([], { threadId: "thread-xyz", turns: 0 });
    expect(events(streams)[0]).toMatchObject({ type: "started", session_id: "thread-xyz" });
  });
});

describe("the interview's rules over the app server's approvals", () => {
  it("judges a file change on every path it lands on, the move destination included", async () => {
    // The change names a file inside the spec folder and moves it out of it.
    // A check on what was named rather than on what the change does would
    // admit this (ADR-0023).
    const { streams, repo, server } = await interview([
      {
        kind: "fileChange",
        path: `${SPEC_FOLDER}/spec.md`,
        content: SPEC,
        movePath: "packages/queue/spec.md",
      },
    ]);
    expect(server.answers()[0]?.decision).toBe("decline");
    expect(refusals(streams).at(-1)).toMatchObject({ rule: "write_outside_scope" });
    expect(refusals(streams).at(-1)?.reason).toContain("packages/queue/spec.md");
    expect(existsSync(join(repo, "packages", "queue", "spec.md"))).toBe(false);
  });

  it("refuses a file change that asks to widen the boundary for the session", async () => {
    const { streams, repo, server } = await interview([
      {
        kind: "grantRoot",
        path: `${SPEC_FOLDER}/spec.md`,
        content: SPEC,
        root: "/",
      },
    ]);
    expect(server.answers()[0]?.decision).toBe("decline");
    expect(refusals(streams).at(-1)?.reason).toContain("for the rest of the session");
    expect(existsSync(join(repo, SPEC_FOLDER, "spec.md"))).toBe(false);
  });

  it("names the act an escalation rides on, whichever shape asked to widen the boundary", async () => {
    const { streams, server } = await interview([
      { kind: "grantRoot", path: `${SPEC_FOLDER}/spec.md`, content: SPEC, root: "/" },
      { kind: "escalation", command: "git status --short", field: "additionalPermissions" },
      // The older shape asks for the same root on the same field.
      { kind: "legacyPatch", paths: [`${SPEC_FOLDER}/spec.md`], grantRoot: "/" },
    ]);
    // A write that asked to widen is refused as a write and a command as a
    // command. What is refused is the escalation either way, and the person is
    // told which act carried it rather than being told about a command when
    // what the session tried was a patch.
    expect(refusals(streams).map((event) => event.tool)).toEqual([
      "Write for the rest of the session",
      "Bash for the rest of the session",
      "Write for the rest of the session",
    ]);
    expect(server.answers().map((answer) => answer.decision)).toEqual([
      "decline",
      "decline",
      expect.stringContaining("Write for the rest of the session") as unknown as string,
    ]);
  });

  it("refuses a recorded session that another provider's run left behind", async () => {
    // Two providers, two id namespaces, one `--session`. A Claude session id
    // sent to `thread/resume`, or a Codex thread to the SDK's resume, is a
    // conversation neither provider has.
    const repo = repository(scratch);
    mkdirSync(join(repo, SPEC_FOLDER), { recursive: true });
    writeFileSync(
      join(repo, SPEC_FOLDER, ".interview.json"),
      JSON.stringify({
        session_id: "sdk-session-1",
        spec: `${SPEC_FOLDER}/spec.md`,
        started_at: "2026-09-14T09:00:00.000Z",
        model: null,
        provider: "claude",
      }),
    );
    const server = fakeAppServer({
      root: mkdtempSync(join(scratch, "app-server-other-")),
      steps: [],
      threadId: "thread-other",
    });
    // With `--spec` beside it, which is how planning mode always names one:
    // the session is judged whichever way the spec was named.
    const refused = await Promise.resolve(
      runCommandLine(interviewCommandLine, {
        argv: [
          "--repo",
          repo,
          "--spec",
          SPEC_FOLDER,
          "--provider",
          "codex",
          "--session",
          "sdk-session-1",
        ],
        streams: recordStreams(),
        cwd: repo,
        deps: {
          transport: codexInterviewTransport({ binary: server.binary, codexHome: server.codexHome }),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("claude");
    expect((refused as Error).message).toContain("codex");
  });

  it("says a session that could not start did not start, rather than ending", async () => {
    // A transport failure is not an ending: the Claude transport lets one out
    // and this one did not, so a session that never opened exited as though it
    // had run and the chat read "the interview ended".
    const repo = repository(scratch);
    const streams = recordStreams();
    // A real fake server for the login it keeps, and a binary that refuses the
    // handshake in its place.
    const server = fakeAppServer({
      root: mkdtempSync(join(scratch, "app-server-refusing-")),
      steps: [],
      threadId: "thread-refused",
    });
    // A server that starts, answers `initialize` with an error and stays up:
    // a rejected handshake, which is what a Codex that cannot serve this
    // client looks like from here.
    const refusing = join(scratch, "refusing-app-server");
    writeFileSync(
      refusing,
      `#!${process.execPath}\n` +
        "const readline = require('node:readline');\n" +
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {\n" +
        "  const request = JSON.parse(line);\n" +
        "  if (request.id === undefined) return;\n" +
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,\n" +
        "    error: { code: -32000, message: 'this server serves no interview' } }) + '\\n');\n" +
        "});\n",
      { mode: 0o700 },
    );
    const failed = await Promise.resolve(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "codex"],
        streams,
        cwd: repo,
        deps: {
          transport: codexInterviewTransport({
            binary: refusing,
            codexHome: server.codexHome,
          }),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain("this server serves no interview");
  });

  it("leaves no app server running once the session has ended", async () => {
    // The child runs in a process group of its own, and ending the session
    // signals the group: a server that pays no attention to its standard input
    // closing goes with it, and so does anything it started, rather than
    // outliving the interview.
    const repo = repository(scratch);
    const streams = recordStreams();
    const server = fakeAppServer({
      root: mkdtempSync(join(scratch, "app-server-lingering-")),
      steps: [],
      threadId: "thread-lingering",
    });
    const pidFile = join(scratch, "lingering.pid");
    const lingering = join(scratch, "lingering-app-server");
    writeFileSync(
      lingering,
      `#!${process.execPath}\n` +
        "const fs = require('node:fs');\n" +
        "const readline = require('node:readline');\n" +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        // A timer keeps the process up after its input has closed.
        "setInterval(() => {}, 1000);\n" +
        "const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');\n" +
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {\n" +
        "  const message = JSON.parse(line);\n" +
        "  if (message.method === 'initialize') return reply(message.id, {});\n" +
        "  if (message.method === 'thread/start')\n" +
        "    return reply(message.id, { thread: { id: 'thread-lingering' }, model: 'm',\n" +
        "      modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'untrusted',\n" +
        "      approvalsReviewer: 'user', sandbox: 'read-only', instructionSources: [] });\n" +
        "});\n",
      { mode: 0o700 },
    );
    const code = await runCommandLine(interviewCommandLine, {
      argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "codex"],
      streams,
      cwd: repo,
      deps: {
        transport: codexInterviewTransport({ binary: lingering, codexHome: server.codexHome }),
        turns: (async function* () {})(),
      },
    });
    expect(code).toBe(EXIT_CODES.approve);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // The signal lands on its own time, so this waits for it rather than
      // reading the process table on the very next tick.
      const deadline = Date.now() + 3000;
      while (alive() && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid, "SIGKILL");
    }
  });

  it("says what a child that died mid-turn said, rather than what that left behind", async () => {
    const repo = repository(scratch);
    const streams = recordStreams();
    const server = fakeAppServer({
      root: mkdtempSync(join(scratch, "app-server-midturn-")),
      steps: [],
      threadId: "thread-midturn",
    });
    // The thread opens, the turn starts — the server answers it — and the
    // child dies with that turn still running. What it said is the answer;
    // the turn it left behind has no outcome to read, so a client reading one
    // shows the person the shape of that mistake rather than the reason.
    //
    // The reply to `turn/start` is what puts the failure on the turn rather
    // than on the request: a child that dies before replying rejects the
    // request instead, which is the route the case below this one takes.
    const dying = join(scratch, "dying-app-server");
    writeFileSync(
      dying,
      `#!${process.execPath}\n` +
        "const readline = require('node:readline');\n" +
        "const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');\n" +
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {\n" +
        "  const message = JSON.parse(line);\n" +
        "  if (message.method === 'initialize') return reply(message.id, {});\n" +
        "  if (message.method === 'thread/start')\n" +
        "    return reply(message.id, { thread: { id: 'thread-midturn' }, model: 'm',\n" +
        "      modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'untrusted',\n" +
        "      approvalsReviewer: 'user', sandbox: 'read-only', instructionSources: [] });\n" +
        "  if (message.method === 'turn/start') {\n" +
        "    reply(message.id, { turn: { id: 'turn-0' } });\n" +
        "    process.stderr.write('THE-REASON-IT-DIED\\n');\n" +
        "    setTimeout(() => process.exit(3), 200);\n" +
        "  }\n" +
        "});\n",
      { mode: 0o700 },
    );

    const failed = await Promise.resolve(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "codex"],
        streams,
        cwd: repo,
        deps: {
          transport: codexInterviewTransport({ binary: dying, codexHome: server.codexHome }),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain("THE-REASON-IT-DIED");
  });

  it("quotes the end of what a child that died said, rather than all of it", async () => {
    const repo = repository(scratch);
    const streams = recordStreams();
    const server = fakeAppServer({
      root: mkdtempSync(join(scratch, "app-server-noisy-")),
      steps: [],
      threadId: "thread-noisy",
    });
    // A server that says a great deal and then dies before the thread opens.
    // What it said is what the person is shown, so it is held to a size and
    // the end is the part kept: a crash says why on its last lines, and a
    // child that logged a megabyte would otherwise put all of it in the chat.
    const noisy = join(scratch, "noisy-app-server");
    writeFileSync(
      noisy,
      `#!${process.execPath}\n` +
        "const readline = require('node:readline');\n" +
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {\n" +
        "  const message = JSON.parse(line);\n" +
        "  if (message.method === 'initialize') {\n" +
        "    process.stderr.write('FIRST-THING-IT-SAID' + 'x'.repeat(20000)\n" +
        "      + 'LAST-THING-IT-SAID\\n');\n" +
        "    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');\n" +
        "    return;\n" +
        "  }\n" +
        // A question of its own, answered before it dies, so what it said has
        // been read by then rather than still sitting in the pipe.
        "  if (message.method === 'thread/start') {\n" +
        "    process.stdout.write(JSON.stringify({ id: 'drain',\n" +
        "      method: 'item/permissions/requestApproval', params: {} }) + '\\n');\n" +
        "    return;\n" +
        "  }\n" +
        "  if (message.id === 'drain') setTimeout(() => process.exit(3), 100);\n" +
        "});\n",
      { mode: 0o700 },
    );
    const failed = await Promise.resolve(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "codex"],
        streams,
        cwd: repo,
        deps: {
          transport: codexInterviewTransport({ binary: noisy, codexHome: server.codexHome }),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    const said = (failed as Error).message;
    expect(said).toContain("LAST-THING-IT-SAID");
    expect(said).not.toContain("FIRST-THING-IT-SAID");
    expect(said.length).toBeLessThan(8500);
  });

  it("refuses a tool call it cannot read, and one naming a tool it does not hold", async () => {
    const { server, code } = await interview([
      // A payload that is not the shape `item/tool/call` takes.
      { kind: "malformed", method: "item/tool/call" },
      // A name the session does not hold: an agent tool of the other
      // transport's, which this one never offered and cannot run.
      { kind: "tool", tool: "Read", arguments: { file_path: "README.md" } },
    ]);
    expect(code).toBe(EXIT_CODES.approve);
    expect(server.answers()[0]?.errorCode).toBe(-32602);
    expect(server.answers()[1]?.success).toBe(false);
  });

  it("runs a tool the session called with no arguments at all", async () => {
    // A tool that takes no fields is called without an `arguments` key. What
    // reaches the tool then is the call it was made with rather than nothing,
    // which the tool's own schema would refuse as input it does not take.
    const { server, code } = await interview(
      [writeSpec, { kind: "toolNoArguments", tool: "read_plan" }],
      { drafted: true },
    );
    expect(code).toBe(EXIT_CODES.approve);
    expect(server.answers()[1]?.success).toBe(true);
    expect(server.answers()[1]?.text).toContain("node_1");
  });

  it("refuses to run at all without the person's own Codex login", async () => {
    const repo = repository(scratch);
    const streams = recordStreams();
    // A home with no `auth.json`: the session runs on the person's login and
    // there is none to run on.
    const refused = await Promise.resolve(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "codex"],
        streams,
        cwd: repo,
        deps: {
          transport: codexInterviewTransport({
            binary: join(scratch, "unused-binary"),
            codexHome: mkdtempSync(join(scratch, "codex-home-empty-")),
          }),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("codex login");
  });

  it("records the provider whose id it holds, so a later run knows whose it is", async () => {
    const { code, repo } = await interview([]);
    expect(code).toBe(EXIT_CODES.approve);
    const record = JSON.parse(
      readFileSync(join(repo, SPEC_FOLDER, ".interview.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record.provider).toBe("codex");
    expect(record.session_id).toBe("thread-0001");
  });

  it("gives the child the scrubbed environment, not this process's own", async () => {
    // A key in this process is one the session would otherwise inherit, and
    // the interview runs on the person's login rather than on whatever the
    // shell that started it was carrying.
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-not-a-real-key";
    try {
      const { server, code } = await interview([]);
      expect(code).toBe(EXIT_CODES.approve);
      expect(server.invocation().env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
  });

  it("keeps the session's own Codex home to itself", async () => {
    const { server, code } = await interview([]);
    expect(code).toBe(EXIT_CODES.approve);
    const home = server.invocation().env.CODEX_HOME;
    expect(home).toBeDefined();
    // And it goes when the session does: it holds a link to the person's own
    // login, and one is made per interview.
    expect(existsSync(home!)).toBe(false);
    // ADR-0030 names the mode: a home anyone could write is a home anyone
    // could put a tool server or an approval rule in. Read while the session
    // was running, because the home goes with it.
    expect(server.invocation().homeMode).toBe(0o700);
  });

  it("restates the boundary on every turn, which is the last word on what it may do", async () => {
    const { server, code } = await interview([], { turns: 2 });
    expect(code).toBe(EXIT_CODES.approve);
    const starts = server
      .sent()
      .filter((line) => line.method === "turn/start")
      .map((line) => line.params as Record<string, unknown>);
    expect(starts).toHaveLength(2);
    // And the thread itself is not ephemeral, which is what lets the person
    // come back to this spec and continue the same conversation.
    const opened = server.sent().filter((line) => line.method === "thread/start");
    expect(opened).toHaveLength(1);
    expect((opened[0]!.params as Record<string, unknown>).ephemeral).toBe(false);
    // A turn's own settings override the thread's, so each one says again that
    // every write and every untrusted command is asked about, that this client
    // is who answers, and that nothing runs outside a read-only sandbox with
    // no network.
    for (const params of starts) {
      expect(params.approvalPolicy).toBe("untrusted");
      expect(params.approvalsReviewer).toBe("user");
      expect(params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    }
  });

  // The two fields a command approval carries that would widen the boundary if
  // the command were accepted, which the runner's own Codex adapter refuses on
  // as well (`packages/runner/src/codex/index.ts`); the third, `grantRoot`, rides on a file
  // change and is driven above. One case each, because each starts its own
  // app server and several in one case outrun a test's time.
  it.each(["networkApprovalContext", "additionalPermissions"])(
    "refuses a command carrying %s, even one the rules would admit",
    async (field) => {
      const { streams, server } = await interview([
        { kind: "escalation", command: "git status --short", field },
      ]);
      expect(server.answers()[0]?.decision).toBe("decline");
      expect(refusals(streams).at(-1)?.reason).toContain("for the rest of the session");
    },
  );

  it("judges a command on its own beside a proposal the server makes, and never takes one", async () => {
    // `accept` is one answer and `acceptWithExecpolicyAmendment` another, so a
    // proposed amendment on the request widens nothing unless it is taken —
    // and what is asserted is the answer on the wire, the plain word rather
    // than the object that would carry the amendment. A command the rules
    // refuse is refused with a proposal beside it as without one, and the
    // schema spells an absent permission as null as often as it leaves it out.
    const { server } = await interview([
      { kind: "escalation", command: "git status --short", field: "proposedExecpolicyAmendment" },
      { kind: "escalation", command: "pnpm install", field: "proposedExecpolicyAmendment" },
      {
        kind: "escalation",
        command: "git status --short",
        field: "proposedNetworkPolicyAmendments",
        value: [{ action: "allow", host: "example.com" }],
      },
      { kind: "escalation", command: "git status --short", field: "additionalPermissions", value: null },
    ]);
    expect(server.answers().map((answer) => answer.decision)).toEqual([
      "accept",
      "decline",
      "accept",
      "accept",
    ]);
  });

  /**
   * Resolve, then judge: a command's targets are resolved against the
   * directory it will actually run in, which the app server names on the
   * request. Judging them against any other directory judges a write that is
   * not the one about to happen.
   */
  it("judges a command where it will run, and refuses one that runs outside the checkout", async () => {
    const { streams, server } = await interview([
      // From `packages`, this climbs back into the spec folder: admitted.
      { kind: "command", command: "cat > ../specs/activation-email/spec.md", cwd: "packages" },
      // The same spelling the spec's own path takes, run from somewhere else:
      // it lands under the package, which the interview may not write.
      { kind: "command", command: "cat > specs/activation-email/spec.md", cwd: "packages/queue" },
      // From outside the checkout a write lands outside it, whatever it names;
      // a read there is a read, and this session may read anything (D-102).
      { kind: "command", command: "cat > spec.md", cwd: "/" },
      { kind: "command", command: "cat /etc/hosts", cwd: "/" },
    ]);
    expect(server.answers().map((answer) => answer.decision)).toEqual([
      "accept",
      "decline",
      "decline",
      "accept",
    ]);
    expect(refusals(streams).map((event) => event.rule)).toEqual([
      "write_outside_scope",
      "write_outside_worktree",
    ]);
  });

  it("judges a command by the item announced, where the request carries neither of them", async () => {
    // The server announces what it is about to run and then asks about it by
    // id alone. Both the line and the directory are on that item, so a client
    // reading only the request would be judging an empty command in the
    // thread's own directory — neither of them the act being asked about.
    const { streams, server } = await interview([
      // Announced from `packages`, this climbs back into the spec folder,
      // which the interview may write: admitted.
      {
        kind: "itemOnlyCommand",
        command: "cat > ../specs/activation-email/spec.md",
        cwd: "packages",
      },
      // The same spelling the spec's own path takes, announced from under the
      // package: it lands there, which the interview may not write.
      {
        kind: "itemOnlyCommand",
        command: "cat > specs/activation-email/spec.md",
        cwd: "packages/queue",
      },
    ]);
    expect(server.answers().map((answer) => answer.decision)).toEqual(["accept", "decline"]);
    expect(refusals(streams).map((event) => event.rule)).toEqual(["write_outside_scope"]);
    expect(refusals(streams).at(-1)?.reason).toContain("packages/queue/specs");
  });

  it("resolves a relative directory against the repository, not against where it was run", async () => {
    // `perbo interview --repo <elsewhere>` is run from anywhere; the
    // directory the app server names on a request is the repository's, so it
    // is resolved against the repository rather than the process's own.
    const { streams, server } = await interview(
      [{ kind: "command", command: "cat > ../specs/activation-email/spec.md", cwd: "packages" }],
      { cwd: scratch },
    );
    expect(server.answers()[0]?.decision).toBe("accept");
    expect(refusals(streams)).toEqual([]);
  });

  it("accepts one call at a time, and never for the session", async () => {
    const { server } = await interview([
      { kind: "command", command: "git status --short" },
      { kind: "command", command: "git status --short" },
    ]);
    // Both were asked about and both were answered `accept`: nothing the
    // interview answers stops the next one being judged.
    expect(server.answers().map((answer) => answer.decision)).toEqual(["accept", "accept"]);
  });

  it("answers the older shape of the same two questions, with the words it refused them in", async () => {
    const { streams, server } = await interview([
      // The older shapes carry argv and a map keyed by path, and take
      // `approved` or `denied` with a rejection rather than accept or decline.
      { kind: "legacyCommand", command: ["git", "status", "--short"] },
      { kind: "legacyCommand", command: ["pnpm", "install"] },
      { kind: "legacyPatch", paths: [`${SPEC_FOLDER}/spec.md`] },
      { kind: "legacyPatch", paths: ["packages/queue/send.ts"] },
    ]);
    expect(server.answers().map((answer) => answer.decision)).toEqual([
      "approved",
      '{"denied":{"rejection":"pnpm install is not one of the read-only shapes this session may run: Bash(ls:*), Bash(cat:*), Bash(head:*), Bash(tail:*), Bash(wc:*), Bash(rg:*), Bash(grep:*), Bash(find:*), Bash(file:*), Bash(cd:*), Bash(pwd), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git ls-files:*), Bash(git blame:*)"}}',
      "approved",
      expect.stringContaining("packages/queue/send.ts") as unknown as string,
    ]);
    expect(refusals(streams).map((event) => event.rule)).toEqual([
      "command_allow_list",
      "write_outside_scope",
    ]);
  });

  it("judges the older shape's patch on where a move lands, not on the file it names", async () => {
    // In that shape an update carries its destination on the change itself,
    // keyed under the file it moves: the key is inside the spec folder and the
    // move takes it out.
    const { streams, server } = await interview([
      {
        kind: "legacyPatch",
        paths: [`${SPEC_FOLDER}/spec.md`],
        movePath: "packages/queue/leak.md",
      },
    ]);
    const rejection = server.answers()[0]?.decision ?? "";
    expect(rejection).toContain("denied");
    expect(rejection).toContain("packages/queue/leak.md");
    expect(refusals(streams).at(-1)).toMatchObject({ rule: "write_outside_scope" });
    expect(refusals(streams).at(-1)?.reason).toContain("packages/queue/leak.md");
  });

  it("refuses a patch in the words of the first path it refused, not the last", async () => {
    // The older shape carries every change on one request and has room for one
    // rejection. Each path is judged, and what the server is told is the first
    // refusal: a session shown the last one would be answering for a path it
    // had already been refused on for another reason.
    const { streams, server } = await interview([
      { kind: "legacyPatch", paths: ["packages/queue/send.ts", "README.md"] },
    ]);
    const rejection = server.answers()[0]?.decision ?? "";
    expect(rejection).toContain("packages/queue/send.ts");
    expect(rejection).not.toContain("README.md");
    // And both were judged, rather than the first refusal ending the loop.
    expect(refusals(streams)).toHaveLength(2);
    expect(refusals(streams)[1]?.reason).toContain("README.md");
  });

  it("refuses a command approval carrying no command, rather than accepting it", async () => {
    // Nothing on the request and nothing on an announced item: there is no
    // command to judge, so there is nothing that could have been admitted —
    // the same reading the file-change path takes for a write naming no path.
    const { streams, server } = await interview([{ kind: "commandlessApproval" }]);
    expect(server.answers()[0]?.decision).toBe("decline");
    expect(refusals(streams).at(-1)?.tool).toBe("Bash");
  });

  it("refuses a file change nothing announced, and a payload it cannot read", async () => {
    const { streams, server } = await interview([
      // Without the item the server announced, there is nothing to judge: the
      // paths a file change lands on are on that item and not on the request.
      { kind: "unannouncedChange" },
      { kind: "malformed", method: "item/commandExecution/requestApproval" },
    ]);
    expect(server.answers()[0]?.decision).toBe("decline");
    expect(server.answers()[1]?.errorCode).toBe(-32602);
    expect(refusals(streams).map((event) => event.tool)).toEqual([
      "Write",
      "item/commandExecution/requestApproval",
    ]);
  });

  it("answers a request that would have been a question, and never puts it to the person", async () => {
    const { streams, server } = await interview([
      {
        kind: "unknownRequest",
        method: "item/tool/requestUserInput",
        params: { itemId: "ask", questions: [{ prompt: "Shall I widen the scope?" }] },
      },
      {
        kind: "unknownRequest",
        method: "item/permissions/requestApproval",
        params: { itemId: "perm", permissions: {}, cwd: ".", startedAtMs: 1 },
      },
    ]);
    // Answered, both of them, and with an error rather than an answer to the
    // question: the interview holds no way to ask anybody anything.
    expect(server.answers().map((answer) => answer.errorCode)).toEqual([-32601, -32601]);
    expect(refusals(streams).map((event) => event.tool)).toEqual([
      "item/tool/requestUserInput",
      "item/permissions/requestApproval",
    ]);
    const said = streams.err();
    expect(said).not.toContain("Shall I widen the scope?");
    expect(said).not.toContain("?");
  });
});

describe("resume (SCP-312 criterion 3)", () => {
  it("continues the thread through the server's own resume rather than replaying turns", async () => {
    const first = await interview([writeSpec], { threadId: "thread-kept" });
    expect(events(first.streams)[0]).toMatchObject({ type: "started", session_id: "thread-kept" });

    const server = fakeAppServer({
      root: mkdtempSync(join(scratch, "app-server-")),
      steps: [{ kind: "say", text: "carrying on" }],
      threadId: "a-different-thread",
    });
    const streams = recordStreams();
    await runCommandLine(interviewCommandLine, {
      argv: [
        "--repo",
        first.repo,
        "--spec",
        SPEC_FOLDER,
        "--provider",
        "codex",
        "--session",
        "thread-kept",
      ],
      streams,
      cwd: first.repo,
      deps: {
        transport: codexInterviewTransport({ binary: server.binary, codexHome: server.codexHome }),
        turns: (async function* () {
          yield JSON.stringify({ type: "turn", text: "carry on" });
        })(),
      },
    });
    const opened = server.opened();
    expect(opened.method).toBe("thread/resume");
    expect(opened.params.threadId).toBe("thread-kept");
    // The boundary is stated again on the resumed thread: a thread resumed
    // without it would carry whatever it was started with.
    expect(opened.params).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
    // One turn was started, carrying the person's turn and not the conversation.
    const turns = server.sent().filter((line) => line.method === "turn/start");
    expect(turns).toHaveLength(1);
    expect(events(streams)[0]).toMatchObject({ type: "started", session_id: "thread-kept" });
    const record = JSON.parse(
      readFileSync(join(first.repo, SPEC_FOLDER, ".interview.json"), "utf8"),
    ) as { session_id: string };
    expect(record.session_id).toBe("thread-kept");
  });
});

describe("what the session said", () => {
  it("reaches the stream in the one shape the chat reads, whichever transport spoke", async () => {
    const { streams } = await interview([{ kind: "say", text: "Tell me about the queue." }]);
    const said = events(streams).flatMap((event) =>
      event.type === "message" ? [event.message] : [],
    );
    const assistant = said.find((message) => message.type === "assistant") as
      | { message: { content: Array<{ type: string; text?: string }> } }
      | undefined;
    expect(assistant?.message.content[0]).toEqual({
      type: "text",
      text: "Tell me about the queue.",
    });
  });
});
