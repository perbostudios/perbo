import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scratch } from "@perbo/test-support";

/**
 * What one invocation of the fake agent binary does.
 *
 * `overloaded` is the shape measured on this repository when the model
 * transport gave up: retry notices on stderr, the synthetic assistant message
 * carrying the provider's own error, and a non-zero exit with no work done.
 * `agent_error` is an ordinary failure — the agent ran, said why it could not
 * finish, and exited non-zero with nothing about the transport in it.
 * `recovered_blip` is the one that looks like both: a 529 the transport retried
 * and served, work done after it, and then a failure of the agent's own.
 */
/**
 * `shell` is the one that runs commands and changes nothing: each entry becomes
 * a `Bash` tool call in an assistant message, and `reported_denials` becomes the
 * `permission_denials` list the agent's own permission layer reports in the
 * result envelope — the second hook the same act arrives from.
 */
export type FakeAgentBehaviour =
  | { kind: "overloaded"; status?: number; retries?: number }
  /**
   * The account's session limit, which is a 429 that says when it lifts:
   * `You've hit your session limit · resets 4:30am (Europe/London)` (SCP-193).
   * The same exhausted-transport shape as `overloaded` — retry notices, the
   * synthetic assistant message, a non-zero exit — and the difference the loop
   * acts on is only in what the provider wrote.
   */
  | { kind: "session_limit"; message: string; retries?: number }
  | { kind: "agent_error" }
  | { kind: "recovered_blip" }
  | { kind: "shell"; commands: readonly string[]; reported_denials?: readonly string[] }
  /**
   * A binary that obeys the `PreToolUse` hook, the way the pinned one was
   * measured to (SCP-177): before each call it runs the hook from its own
   * `--settings` file with the call on stdin, refuses the call and reports it
   * in `permission_denials` when the answer is `deny`, and performs it when the
   * answer is `allow` — so a test can assert that a refused write did not
   * happen without spending anything on a real agent.
   */
  | {
      kind: "guarded";
      calls: ReadonlyArray<{ tool: string; input: Record<string, unknown> }>;
      reported_denials?: readonly string[];
    }
  /**
   * A stream written out step by step, with the hook run where the real
   * binary runs it (SCP-177).
   *
   * `guarded` above decides what to emit from the hook's answer, which is what
   * an agent does; this one emits exactly what the test says and in the order
   * the test says, so a test can hold the ordering the runner's held-hit
   * settlement depends on — the `tool_use` block, then the hook, then the tool
   * result — and can leave a step out to see what the runner does without it.
   */
  | { kind: "scripted"; steps: readonly ScriptedStep[] }
  | { kind: "succeed"; file: string; contents: string };

/**
 * The subagent a step belongs to, as the stream and the hook name it
 * (ADR-0038): `parent` is the id of the subagent-starting call that started
 * it — named `Agent`, or `Task` under its former name — which the child's own
 * events carry as `parent_tool_use_id`; `id` and `type` are the `agent_id`
 * and role the child's hook payload carries and the top-level session's does
 * not. Omitted, the step is the top-level session's own.
 */
export interface ScriptedAgent {
  parent: string;
  id: string;
  type: string;
}

/** One step of a `scripted` behaviour. */
export type ScriptedStep =
  /**
   * An assistant message carrying one `tool_use` block with this id.
   *
   * `input` is null for the block a torn or truncated line leaves behind,
   * which carries a tool name and no input at all — the shape every reader of
   * `block.input` has to survive.
   */
  | {
      step: "tool_use";
      id: string;
      tool: string;
      input: Record<string, unknown> | null;
      agent?: ScriptedAgent;
    }
  /** An assistant message that is only words — what the executor's account arrives as. */
  | { step: "text"; text: string; agent?: ScriptedAgent }
  /** Run the `PreToolUse` hook from the invocation's own `--settings` file. */
  | {
      step: "hook";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      agent?: ScriptedAgent;
    }
  /** The tool's result, as a `user` message — the first event that follows the hook. */
  | { step: "tool_result"; id: string; text: string; is_error?: boolean; agent?: ScriptedAgent }
  /** A `system` event, which is emitted while the hook is still running. */
  | { step: "system"; subtype: string }
  /** The result envelope, with any refusals the agent's own layer reports. */
  | {
      step: "result";
      denials?: ReadonlyArray<{ tool: string; id?: string; input: Record<string, unknown> }>;
    };

/**
 * A real binary that behaves like a coding agent, one invocation at a time.
 *
 * The runner spawns it, reads its stream-json on stdout, its notices on stderr
 * and its exit code — so what a test drives is the adapter's own parsing rather
 * than a stand-in for it. Each invocation takes the next behaviour in the list
 * and the last one repeats, and `--version` answers the fingerprint without
 * consuming one.
 */
export function fakeAgent(
  scratch: Scratch,
  behaviours: readonly FakeAgentBehaviour[],
  options: {
    /**
     * What the init line reports the executor's credential came from, which is
     * what the runner reads to decide whether a cost cap applies (D-096).
     * `none` is a subscription login, which is what the real binary reports on
     * a developer machine and what a caller that says nothing gets; a name is
     * an API key, billed per token.
     */
    apiKeySource?: string;
  } = {},
): {
  binary: string;
  invocations: () => Array<{ cwd: string }>;
} {
  const dir = scratch("perbo-fake-agent-");
  const binary = join(dir, "agent.cjs");
  const calls = join(dir, "invocations.json");
  const source = `#!/usr/bin/env node
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } = require("node:fs");
const { dirname, join } = require("node:path");

// process.exit does not wait for writes still queued on process.stdout or
// process.stderr, so every line is written out before the process can exit.
const writeAll = (fd, text) => {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; ) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
    }
  }
};

// The runner fingerprints the binary before it runs it; answering the version
// is not an invocation.
if (process.argv.includes("--version")) {
  writeAll(1, "fake-agent 1.0.0\\n");
  process.exit(0);
}

const BEHAVIOURS = ${JSON.stringify(behaviours)};
const CALLS = ${JSON.stringify(calls)};

const seen = existsSync(CALLS) ? JSON.parse(readFileSync(CALLS, "utf8")) : [];
const behaviour = BEHAVIOURS[Math.min(seen.length, BEHAVIOURS.length - 1)];
seen.push({ cwd: process.cwd() });
writeFileSync(CALLS, JSON.stringify(seen));

const emit = (event) => writeAll(1, JSON.stringify(event) + "\\n");

emit({
  type: "system",
  subtype: "init",
  apiKeySource: ${JSON.stringify(options.apiKeySource ?? "none")},
  mcp_servers: [],
  plugins: [],
  skills: [],
  agents: [],
  memory_paths: null,
});

if (behaviour.kind === "overloaded") {
  const status = behaviour.status || 529;
  const retries = behaviour.retries || 10;
  const payload = JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    writeAll(2, 
      "API Error (" + status + " " + payload + ") · Retrying in 1 seconds… (attempt " +
        attempt + "/" + retries + ")\\n",
    );
  }
  // The synthetic message the agent emits in place of the turn it could not take.
  emit({
    type: "assistant",
    message: {
      id: "msg_synthetic",
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: " + status + " " + payload }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  });
  process.exit(1);
}

if (behaviour.kind === "session_limit") {
  const retries = behaviour.retries || 10;
  const payload = JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: behaviour.message },
  });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    writeAll(2, 
      "API Error (429 " + payload + ") · Retrying in 1 seconds… (attempt " +
        attempt + "/" + retries + ")\\n",
    );
  }
  emit({
    type: "assistant",
    message: {
      id: "msg_synthetic",
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: 429 " + payload }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  });
  process.exit(1);
}

if (behaviour.kind === "recovered_blip") {
  const payload = JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  });
  // One 529, retried and served — the agent went on working — and then a
  // failure of its own. The transport is in the transcript, but it is not
  // what ended the attempt.
  writeAll(2, 
    "API Error (529 " + payload + ") · Retrying in 1 seconds… (attempt 1/10)\\n",
  );
  emit({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } }],
      usage: { input_tokens: 14, output_tokens: 5 },
    },
  });
  emit({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "I cannot find the module this ticket names." }],
      usage: { input_tokens: 9, output_tokens: 4 },
    },
  });
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "the executor stopped: the module the ticket names does not exist",
    total_cost_usd: 0.001,
  });
  process.exit(1);
}

if (behaviour.kind === "agent_error") {
  emit({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "I cannot find the module this ticket names." }],
      usage: { input_tokens: 9, output_tokens: 4 },
    },
  });
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "the executor stopped: the module the ticket names does not exist",
    total_cost_usd: 0.001,
  });
  process.exit(1);
}

if (behaviour.kind === "scripted") {
  const { execFileSync } = require("node:child_process");
  const hookCommand = () => {
    const settings = JSON.parse(
      readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"),
    );
    return settings.hooks.PreToolUse[0].hooks[0].command;
  };
  for (const step of behaviour.steps) {
    const child = step.agent ? { parent_tool_use_id: step.agent.parent } : {};
    if (step.step === "tool_use") {
      emit({
        type: "assistant",
        ...child,
        message: {
          content: [{ type: "tool_use", id: step.id, name: step.tool, input: step.input }],
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      });
    } else if (step.step === "text") {
      emit({
        type: "assistant",
        ...child,
        message: {
          content: [{ type: "text", text: step.text }],
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      });
    } else if (step.step === "hook") {
      const input = JSON.stringify({
        session_id: "fake",
        cwd: process.cwd(),
        hook_event_name: "PreToolUse",
        tool_name: step.tool,
        tool_input: step.input,
        tool_use_id: step.id,
        ...(step.agent ? { agent_id: step.agent.id, agent_type: step.agent.type } : {}),
      });
      execFileSync("/bin/sh", ["-c", hookCommand()], { input, encoding: "utf8" });
    } else if (step.step === "tool_result") {
      emit({
        type: "user",
        ...child,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: step.id,
              content: step.text,
              is_error: step.is_error === true,
            },
          ],
        },
      });
    } else if (step.step === "system") {
      emit({ type: "system", subtype: step.subtype });
    } else {
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.005,
        permission_denials: (step.denials || []).map((denial) => ({
          tool_name: denial.tool,
          tool_use_id: denial.id,
          tool_input: denial.input,
        })),
      });
    }
  }
  process.exit(0);
}

if (behaviour.kind === "guarded") {
  const { execFileSync } = require("node:child_process");
  const settings = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"),
  );
  const hook = settings.hooks.PreToolUse[0].hooks[0].command;
  const denials = [];
  let index = 0;
  for (const call of behaviour.calls) {
    index += 1;
    const id = "toolu_fake_" + index;
    const input = JSON.stringify({
      session_id: "fake",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: call.tool,
      tool_input: call.input,
      tool_use_id: id,
    });
    const printed = execFileSync("/bin/sh", ["-c", hook], { input, encoding: "utf8" }).trim();
    // Nothing printed is the hook deferring; this stand-in then does what the
    // agent's own permission layer would, which for the tests that use it is
    // to run the call.
    const answer = printed.length > 0 ? JSON.parse(printed) : null;
    const allowed =
      answer === null || answer.hookSpecificOutput.permissionDecision === "allow";
    emit({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name: call.tool, input: call.input }],
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    });
    if (!allowed) {
      denials.push({ tool_name: call.tool, tool_use_id: id, tool_input: call.input });
      continue;
    }
    // Admitted, so it happens — which is what makes "the file was never
    // created" an assertion about the guard rather than about this stub.
    try {
      if (call.tool === "Bash") {
        execFileSync("/bin/sh", ["-c", call.input.command], { cwd: process.cwd() });
      } else if (call.tool === "Write") {
        mkdirSync(dirname(call.input.file_path), { recursive: true });
        writeFileSync(call.input.file_path, call.input.content || "");
      }
    } catch (error) {
      // A command that failed on its own is not a refusal.
    }
  }
  for (const command of behaviour.reported_denials || []) {
    denials.push({ tool_name: "Bash", tool_input: { command } });
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.004,
    permission_denials: denials,
  });
  process.exit(0);
}

if (behaviour.kind === "shell") {
  for (const command of behaviour.commands) {
    emit({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command } }],
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    });
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.003,
    permission_denials: (behaviour.reported_denials || []).map((command) => ({
      tool_name: "Bash",
      tool_input: { command },
    })),
  });
  process.exit(0);
}

const target = join(process.cwd(), behaviour.file);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, behaviour.contents);
emit({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: target } }],
    usage: { input_tokens: 20, output_tokens: 6 },
  },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.002,
  permission_denials: [],
});
process.exit(0);
`;
  writeFileSync(binary, source, { mode: 0o755 });
  return {
    binary,
    invocations: () =>
      existsSync(calls) ? (JSON.parse(readFileSync(calls, "utf8")) as Array<{ cwd: string }>) : [],
  };
}
