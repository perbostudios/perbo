import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { claudeInterviewTransport } from "../claude.js";

/** What the transport is told to run. The scripted SDK spawns nothing. */
const CLAUDE = "/usr/local/bin/claude";
import { codexInterviewTransport } from "../codex.js";
import { interviewCommandLine } from "../index.js";
import { fakeAppServer, type ServerStep } from "./fake-app-server.js";
import { openCodeInterviewTransport } from "../opencode.js";
import { fakeOpenCode, type OpenCodeStep } from "./fake-opencode.js";
import {
  refusals,
  SPEC_FOLDER,
  type ContractDecision,
  type ContractRun,
  type ContractStep,
  type InterviewHarness,
} from "./contract.js";
import { scriptedSdk, type ScriptStep } from "./fake-sdk.js";
import { runCommandLine } from "../../../command-line/terminal.js";
import { recordStreams } from "../../../test-support/streams.js";

/**
 * The turns: the one that makes a session run at all, then one for each
 * `turn` step, in order. Each is handed over only when the transport asks for
 * the next, which is when the session has ended the turn before it.
 */
const turnsOf = async function* (
  steps: readonly ContractStep[],
  opening = "let us write the spec",
): AsyncGenerator<string> {
  yield JSON.stringify({ type: "turn", text: opening });
  for (const step of steps)
    if (step.kind === "turn")
      yield JSON.stringify({ type: "turn", text: step.text, ...(step.asking ? { asking: step.asking } : {}) });
};

/** The steps that ask the transport for an answer, in the order its answers are logged. */
const asking = (steps: readonly ContractStep[]): ContractStep[] =>
  steps.filter((step) => step.kind !== "say" && step.kind !== "turn");

/** What a step looks like to the Claude Agent SDK. */
function asSdkStep(step: ContractStep): ScriptStep {
  switch (step.kind) {
    case "say":
      return {
        kind: "message",
        message: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: step.text }] },
        },
      };
    case "write":
      return { kind: "tool", tool: "Write", input: { file_path: step.path, content: step.content } };
    case "command":
      return { kind: "tool", tool: "Bash", input: { command: step.command } };
    case "call":
      return { kind: "call", tool: step.tool, input: step.input };
    case "turn":
      return { kind: "await" };
  }
}

export function claudeHarness(): InterviewHarness {
  return {
    name: "claude",
    async run(input): Promise<ContractRun> {
      const streams = recordStreams();
      const sdk = scriptedSdk({
        steps: input.steps.map(asSdkStep),
        cwd: input.repo,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      const code = await runCommandLine(interviewCommandLine, {
        argv: [
          "--repo",
          input.repo,
          "--spec",
          input.spec ?? SPEC_FOLDER,
          ...(input.argv ?? []),
        ],
        streams,
        cwd: input.repo,
        deps: {
          transport: claudeInterviewTransport(sdk, CLAUDE),
          turns: turnsOf(input.steps, input.opening),
        },
      });
      const decisions: ContractDecision[] = sdk.calls.map((call) => ({
        tool: call.tool,
        behavior: call.behavior,
        result: call.result,
        isError: call.isError,
      }));
      return { code, streams, decisions };
    },
  };
}

/** What a step looks like to a Codex app server. */
function asServerStep(step: ContractStep): ServerStep {
  switch (step.kind) {
    case "say":
      return { kind: "say", text: step.text };
    case "write":
      return { kind: "fileChange", path: step.path, content: step.content };
    case "command":
      return { kind: "command", command: step.command };
    case "call":
      return { kind: "tool", tool: step.tool, arguments: step.input };
    case "turn":
      return { kind: "await" };
  }
}

export function codexHarness(scratch: () => string): InterviewHarness {
  return {
    name: "codex",
    async run(input): Promise<ContractRun> {
      const streams = recordStreams();
      const server = fakeAppServer({
        root: mkdtempSync(join(scratch(), "app-server-")),
        steps: input.steps.map(asServerStep),
        threadId: input.sessionId ?? "thread-0001",
      });
      const code = await runCommandLine(interviewCommandLine, {
        argv: [
          "--repo",
          input.repo,
          "--spec",
          input.spec ?? SPEC_FOLDER,
          "--provider",
          "codex",
          ...(input.argv ?? []),
        ],
        streams,
        cwd: input.repo,
        deps: {
          transport: codexInterviewTransport({ binary: server.binary, codexHome: server.codexHome }),
          turns: turnsOf(input.steps, input.opening),
        },
      });
      // A tool call the interview refused is answered with the refusal's own
      // words, as the other transport answers one, so what says it was refused
      // is the `refused` event the protocol carries it on.
      const refused = new Set(
        refusals(streams).map((event) => event.tool),
      );
      const asked = asking(input.steps);
      const decisions: ContractDecision[] = server.answers().map((answer, at) => {
        const step = asked[at];
        const tool =
          step?.kind === "call" ? step.tool : step?.kind === "command" ? "Bash" : "Write";
        const behavior: "allow" | "deny" =
          answer.decision !== null
            ? answer.decision === "accept"
              ? "allow"
              : "deny"
            : refused.has(tool) || refused.has(`mcp__perbo_interview__${tool}`)
              ? "deny"
              : "allow";
        return {
          tool,
          behavior,
          result: answer.text,
          isError: behavior === "allow" && answer.success === false,
        };
      });
      return { code, streams, decisions };
    },
  };
}

/**
 * OpenCode, driven through the same contract. A step it asks about and the
 * interview refuses ends OpenCode's turn; the transport starts the next one
 * and the fake goes on from the step after, so every step is still tried in
 * its order.
 */
export function openCodeHarness(scratch: () => string): InterviewHarness {
  return {
    name: "opencode",
    async run(input): Promise<ContractRun> {
      const streams = recordStreams();
      const fake = fakeOpenCode({
        root: mkdtempSync(join(scratch(), "opencode-")),
        steps: input.steps.map((step): OpenCodeStep => (step.kind === "turn" ? { kind: "await" } : step)),
        sessionId: input.sessionId ?? "ses-0001",
      });
      const code = await runCommandLine(interviewCommandLine, {
        argv: [
          "--repo",
          input.repo,
          "--spec",
          input.spec ?? SPEC_FOLDER,
          "--provider",
          "opencode",
          ...(input.argv ?? []),
        ],
        streams,
        cwd: input.repo,
        deps: {
          transport: openCodeInterviewTransport({
            binary: fake.binary,
            dataDirectory: mkdtempSync(join(scratch(), "opencode-data-")),
            // The fake's catalogue settles as soon as it is asked.
            wait: async () => undefined,
          }),
          turns: turnsOf(input.steps, input.opening),
        },
      });
      // A tool call the interview refused is answered with the refusal's own
      // words, as on the other transports, so what says it was refused is the
      // `refused` event the protocol carries it on.
      const refused = new Set(refusals(streams).map((event) => event.tool));
      const asked = asking(input.steps);
      const decisions: ContractDecision[] = fake.answers().map((answer, at) => {
        const step = asked[at];
        const tool = step?.kind === "call" ? step.tool : step?.kind === "command" ? "Bash" : "Write";
        const behavior: "allow" | "deny" =
          answer.decision !== null
            ? answer.decision === "once"
              ? "allow"
              : "deny"
            : refused.has(tool) || refused.has(`mcp__perbo_interview__${tool}`)
              ? "deny"
              : "allow";
        return {
          tool,
          behavior,
          result: answer.text,
          isError: behavior === "allow" && answer.isError === true,
        };
      });
      return { code, streams, decisions };
    },
  };
}
