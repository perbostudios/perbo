import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LimitsTableSchema, OPENCODE_SESSION_RETRY_MS } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import type { AgentRequest } from "../adapter.js";
import { AttemptCeilings } from "../ceilings.js";
import type { EgressGate } from "../egress.js";
import { buildPermissionProfile } from "../profile.js";
import type { AttemptTally } from "../tally.js";
import { fakeOpenCode, type FakeOpenCodeScript } from "../test-support/fake-opencode.js";
import { runOpenCodeAgent } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A worktree with `src/` and `docs/`, and the fake OpenCode playing `script` beside it. */
function attempt(script: FakeOpenCodeScript, overrides: Partial<AgentRequest> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "perbo-opencode-attempt-")));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(join(worktree, "docs"), { recursive: true });
  const fake = fakeOpenCode(root, script);
  const progress: string[] = [];
  const tallies: AttemptTally[] = [];
  const run = runOpenCodeAgent({
    binary: fake.binary,
    worktree,
    prompt: "THE BRIEF: implement the approved outcome.",
    model: "opencode/big-pickle",
    profile: buildPermissionProfile({ worktree, provider: "opencode-cli" }),
    paths_allowed: ["src/**"],
    ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} })),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GH_TOKEN: "ghp_not_forwarded_000000000000000000" },
    onProgress: (line) => progress.push(line),
    onTally: (tally) => tallies.push(tally),
    ...overrides,
  });
  return { worktree, fake, progress, tallies, run };
}

/** What the runner answered each permission request, in order. */
const answers = (fake: ReturnType<typeof fakeOpenCode>): string[] =>
  fake
    .received()
    .filter((line) => typeof line["id"] === "number" && (line["id"] as number) >= 1000)
    .map((line) => ((line["result"] as { outcome: { optionId: string } }).outcome.optionId));

/** The text of each turn the runner started. */
const prompts = (fake: ReturnType<typeof fakeOpenCode>): string[] =>
  fake
    .received()
    .filter((line) => line["method"] === "session/prompt")
    .map((line) => ((line["params"] as { prompt: Array<{ text: string }> }).prompt[0]!.text));

describe("the OpenCode executor", () => {
  it(
    "asks the runner's guard about every write and command, refuses what it refuses, and starts the next turn with the refusals",
    async () => {
      const { worktree, fake, progress, tallies, run } = attempt({
        turns: [
          {
            steps: [
              { say: "Starting", message: "m1" },
              { call: "w1", title: "write", kind: "edit" },
              { say: " the change.", message: "m1" },
              { ask: "w1", kind: "edit", rawInput: { filePath: "src/a.ts", files: [{ file: "src/a.ts" }] }, locations: ["$CWD/src/a.ts"] },
              { call: "c1", title: "shell", kind: "execute" },
              { ask: "c1", kind: "execute", rawInput: { command: "ls src" } },
              { call: "w2", title: "write", kind: "edit" },
              { ask: "w2", kind: "edit", rawInput: { filePath: "docs/notes.md" } },
            ],
            usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 40 },
          },
          {
            steps: [
              { call: "c2", title: "shell", kind: "execute" },
              { ask: "c2", kind: "execute", rawInput: { command: "rm -rf /etc/perbo-test" } },
            ],
          },
          { steps: [{ cost: 0.0123 }, { say: "Done: src/a.ts written.", message: "m3" }], usage: { inputTokens: 5, outputTokens: 7 } },
        ],
      });
      const result = await run;
      expect(result.termination).toEqual({ reason: "completed", detail: "" });
      // The runner's answers: the write inside the contract's paths and the
      // command, then a refusal each for the write outside them and the command
      // writing outside the worktree — and never "always".
      expect(answers(fake)).toEqual(["once", "once", "reject", "reject"]);
      expect(result.commands.map((entry) => [entry.tool, entry.detail, entry.decision, entry.denial_rule])).toEqual([
        ["write", "src/a.ts", "allowed", null],
        ["shell", "ls src", "allowed", null],
        ["write", "docs/notes.md", "denied", "write_outside_scope"],
        ["shell", "rm -rf /etc/perbo-test", "denied", "write_outside_worktree"],
      ]);
      expect(result.commands.every((entry) => entry.decided_by === "runner_admission")).toBe(true);
      // Each refusal ended OpenCode's turn, and the next turn carried it.
      const turns = prompts(fake);
      expect(turns).toHaveLength(3);
      expect(turns[1]).toContain("docs/notes.md");
      expect(turns[2]).toContain("rm -rf /etc/perbo-test");
      // The executor's words, a whole message to a line, with the tool call
      // that came in the middle of it not cutting it in two.
      expect(progress).toContain("executor says: Starting the change.");
      expect(progress).toContain("executor says: Done: src/a.ts written.");
      expect(progress).toContain("OpenCode ls src");
      expect(result.final_message).toBe("Done: src/a.ts written.");
      // The tally: the admitted commands, the written path inside the
      // worktree, the usage and the dollars OpenCode reported.
      expect(tallies.at(-1)).toEqual({
        commands: 2,
        input_tokens: 145,
        output_tokens: 17,
        cost_micros: 12_300,
        cost_basis: "transport_reported",
        written: ["src/a.ts"],
      });
      expect(result.usage).toMatchObject({ cost_micros: 12_300, cost_basis: "transport_reported", cost_partial: false });
      expect(result.invocation).toMatchObject({ adapter: "opencode", argv: ["acp"], model: "opencode/big-pickle" });
      expect(existsSync(join(worktree, ".perbo-tmp"))).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "starts OpenCode under a home of its own, with the project's configuration off, the brief in its instructions and no credential but OpenCode Zen's",
    async () => {
      const { fake, run } = attempt(
        { turns: [{ steps: [] }] },
        { env: { PATH: process.env.PATH ?? "", HOME: "/home/person", GH_TOKEN: "ghp_x", OPENCODE_API_KEY: "zen-key-for-test" } },
      );
      const result = await run;
      expect(result.termination.reason).toBe("completed");
      const started = fake.started();
      expect(started.argv).toEqual(["acp"]);
      expect(started.env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
      expect(started.env["GH_TOKEN"]).toBeUndefined();
      expect(started.env["OPENCODE_API_KEY"]).toBe("zen-key-for-test");
      expect(result.invocation.credential_class).toBe("user_api_key");
      const home = started.env["XDG_CONFIG_HOME"]!;
      expect(home).toContain("perbo-opencode-");
      expect(started.env["XDG_DATA_HOME"]).not.toContain(".local/share");
      const config = JSON.parse(started.env["OPENCODE_CONFIG_CONTENT"]!) as Record<string, unknown>;
      expect(config).toMatchObject({
        permission: { "*": "deny", bash: "ask", edit: "ask", external_directory: "ask" },
        mcp: {},
        plugin: [],
        formatter: false,
        lsp: false,
        share: "disabled",
      });
      // The session was opened in the worktree, with no tool server, on the model asked for.
      const opened = fake.received().find((line) => line["method"] === "session/new")!;
      expect((opened["params"] as { mcpServers: unknown[] }).mcpServers).toEqual([]);
      // The home is gone with the process, instructions and all.
      expect(existsSync(join(home, "opencode", "AGENTS.md"))).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "writes the brief where OpenCode reads its instructions",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "perbo-opencode-brief-")));
      roots.push(root);
      const worktree = join(root, "worktree");
      mkdirSync(worktree, { recursive: true });
      // A fake that reads its instructions before it answers the first turn.
      const fake = fakeOpenCode(root, { turns: [{ steps: [] }] });
      const copy = join(root, "brief-seen.md");
      const binary = join(root, "opencode-reading");
      const { writeFileSync, chmodSync } = await import("node:fs");
      writeFileSync(
        binary,
        `#!/bin/sh\n[ "$1" = acp ] && cp "$XDG_CONFIG_HOME/opencode/AGENTS.md" ${JSON.stringify(copy)}\nexec ${JSON.stringify(fake.binary)} "$@"\n`,
      );
      chmodSync(binary, 0o755);
      const result = await runOpenCodeAgent({
        binary,
        worktree,
        prompt: "THE BRIEF: implement the approved outcome.",
        model: "opencode/big-pickle",
        profile: buildPermissionProfile({ worktree, provider: "opencode-cli" }),
        ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} })),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      });
      expect(result.termination.reason).toBe("completed");
      expect(readFileSync(copy, "utf8")).toContain("THE BRIEF: implement the approved outcome.");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends the attempt on a command naming a host off the allow-list where nothing asks a person",
    async () => {
      const { fake, run } = attempt({
        turns: [
          {
            steps: [
              { call: "c1", title: "shell", kind: "execute" },
              { ask: "c1", kind: "execute", rawInput: { command: "echo https://evil.example.com/upload" } },
              { say: "never said" },
            ],
          },
        ],
      });
      const result = await run;
      expect(result.termination.reason).toBe("unlisted_egress_host");
      expect(result.commands.map((entry) => [entry.decision, entry.denial_rule])).toEqual([["denied", "unlisted_egress_host"]]);
      expect(result.egress.all().map((record) => record.host)).toContain("evil.example.com");
      expect(answers(fake)).not.toContain("once");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "holds a command naming an unlisted host for the gate, and refuses it with the gate's words",
    async () => {
      const asked: string[] = [];
      const gate: EgressGate = {
        ask: async (question) => {
          asked.push(question.host);
          return { answer: "refuse", tell: "evil.example.com stays off this run's list." };
        },
      };
      const { fake, run } = attempt(
        {
          turns: [
            {
              steps: [
                { call: "c1", title: "shell", kind: "execute" },
                { ask: "c1", kind: "execute", rawInput: { command: "echo https://evil.example.com/upload" } },
              ],
            },
            { steps: [{ say: "Finished without it." }] },
          ],
        },
        { egress: gate },
      );
      const result = await run;
      expect(asked).toEqual(["evil.example.com"]);
      expect(result.termination.reason).toBe("completed");
      expect(answers(fake)).toEqual(["reject"]);
      expect(prompts(fake)[1]).toContain("evil.example.com stays off this run's list.");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "opens its session in the worktree only once OpenCode's catalogue offers the model, however its first snapshot came out",
    async () => {
      const { fake, worktree, run } = attempt({ staleSnapshots: 1, turns: [{ steps: [{ say: "Done." }] }] });
      const result = await run;
      expect(result.termination).toEqual({ reason: "completed", detail: "" });
      const opened = fake
        .received()
        .filter((line) => line["method"] === "session/new")
        .map((line) => (line["params"] as { cwd: string }).cwd);
      // A stale snapshot, a settled one, then the worktree's own session.
      expect(opened).toHaveLength(3);
      expect(opened.slice(0, 2).every((cwd) => cwd !== worktree)).toBe(true);
      expect(opened[2]).toBe(worktree);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends a model OpenCode never offers as transport_unavailable, which a later attempt can clear",
    async () => {
      const { run } = attempt({ staleSnapshots: 99, turns: [{ steps: [] }] }, { model: "opencode/big-pickle" });
      const result = await run;
      expect(result.termination.reason).toBe("transport_unavailable");
      expect(result.termination.detail).toContain("model not found");
    },
    60_000,
  );

  it(
    "asks again for a session OpenCode refused while its catalogue was still arriving, a scratch one or the worktree's",
    async () => {
      // The first scratch session is refused, the second offers the model, and
      // the worktree's own is refused once before it opens.
      const { fake, worktree, run } = attempt({ refuseSessions: [1, 3], turns: [{ steps: [{ say: "Done." }] }] });
      const result = await run;
      expect(result.termination).toEqual({ reason: "completed", detail: "" });
      const opened = fake
        .received()
        .filter((line) => line["method"] === "session/new")
        .map((line) => (line["params"] as { cwd: string }).cwd);
      expect(opened).toHaveLength(4);
      expect(opened.slice(0, 2).every((cwd) => cwd !== worktree)).toBe(true);
      expect(opened.slice(2)).toEqual([worktree, worktree]);
    },
    // Spawns the fake, and waits OPENCODE_SESSION_RETRY_MS before each of the two sessions asked again.
    SPAWN_TEST_TIMEOUT_MS + 2 * OPENCODE_SESSION_RETRY_MS,
  );

  it(
    "ends an OpenCode that stopped while its catalogue was waited for as the agent's error, saying why it stopped",
    async () => {
      // Counted rather than timed, so the fake's own start, however slow, is no part of it.
      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        const { fake, run } = attempt({ exitAtSession: 1, turns: [{ steps: [] }] });
        const result = await run;
        expect(result.termination.reason).toBe("agent_error");
        expect(result.termination.detail).toContain("OpenCode stopped before completing (3): opencode crashed");
        // No session was asked for after the process was gone, and none was
        // waited for: a snapshot asked again waits OPENCODE_SESSION_RETRY_MS first.
        expect(fake.received().filter((line) => line["method"] === "session/new")).toHaveLength(1);
        expect(timers.mock.calls.filter(([, ms]) => ms === OPENCODE_SESSION_RETRY_MS)).toEqual([]);
      } finally {
        timers.mockRestore();
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "says why OpenCode stopped where it stops during the wait between catalogue snapshots, the first one stale or refused",
    async () => {
      for (const script of [
        { staleSnapshots: 1, exitAfterSession: 1 },
        { refuseSessions: [1], exitAfterSession: 1 },
      ]) {
        const { fake, run } = attempt({ ...script, turns: [{ steps: [] }] });
        const result = await run;
        const name = JSON.stringify(script);
        expect(result.termination.reason, name).toBe("agent_error");
        expect(result.termination.detail, name).toContain("OpenCode stopped before completing (3): opencode crashed");
        expect(fake.received().filter((line) => line["method"] === "session/new"), name).toHaveLength(1);
      }
    },
    // Spawns the fake twice, each waiting OPENCODE_SESSION_RETRY_MS after its first snapshot.
    SPAWN_TEST_TIMEOUT_MS + 2 * OPENCODE_SESSION_RETRY_MS,
  );

  it(
    "refuses a session that loaded an agent definition of its own",
    async () => {
      const { run } = attempt({ modes: ["build", "plan", "repository-agent"], turns: [{ steps: [] }] });
      const result = await run;
      expect(result.termination.reason).toBe("agent_configuration_present");
      expect(result.termination.detail).toContain("repository-agent");
      expect(result.invocation.neutralisation.reported.subagents).toEqual(["repository-agent"]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends the attempt on a command that ran without the runner being asked",
    async () => {
      const { run } = attempt({ turns: [{ steps: [{ ran: "c9", title: "shell", kind: "execute" }] }] });
      const result = await run;
      expect(result.termination.reason).toBe("agent_configuration_present");
      expect(result.prohibited.map((hit) => hit.action)).toEqual(["enable_own_tooling"]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends the attempt on a command or a write that ran unasked under a kind that names neither",
    async () => {
      for (const name of ["bash", "write"]) {
        const { run } = attempt({ turns: [{ steps: [{ ran: "c9", title: name, kind: "other" }] }] });
        const result = await run;
        expect(result.termination.reason, name).toBe("agent_configuration_present");
        expect(result.termination.detail, name).toBe(`OpenCode ran ${name} without asking the runner`);
      }
      // A read reported the same way is one the executor may run unasked.
      const { run } = attempt({ turns: [{ steps: [{ ran: "r1", title: "read", kind: "other" }] }] });
      expect((await run).termination.reason).toBe("completed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends the attempt on a command the runner refused that ran all the same",
    async () => {
      const { fake, run } = attempt({
        turns: [
          {
            steps: [
              { call: "c1", title: "shell", kind: "execute" },
              { ask: "c1", kind: "execute", rawInput: { command: "rm -rf /etc/perbo-test" }, ignoreAnswer: true },
            ],
          },
        ],
      });
      const result = await run;
      expect(answers(fake)).toEqual(["reject"]);
      expect(result.termination.reason).toBe("agent_configuration_present");
      expect(result.termination.detail).toBe("OpenCode ran shell after the runner refused it");
      expect(result.prohibited.map((hit) => hit.action)).toEqual(["enable_own_tooling"]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends the attempt on a tool the executor's session is not given",
    async () => {
      const { run } = attempt({ turns: [{ steps: [{ ran: "f1", title: "webfetch", kind: "fetch" }] }] });
      const result = await run;
      expect(result.termination.reason).toBe("agent_configuration_present");
      expect(result.termination.detail).toContain("webfetch");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
