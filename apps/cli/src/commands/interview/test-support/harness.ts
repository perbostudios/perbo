import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { claudeInterviewTransport } from "../claude.js";

/** What the transport is told to run. The scripted SDK spawns nothing. */
const CLAUDE = "/usr/local/bin/claude";
import { codexInterviewTransport } from "../codex.js";
import { interviewCommandLine } from "../index.js";
import { fakeAppServer, type ServerStep } from "./fake-app-server.js";
import {
  drafter,
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

/** One turn from the person, which is what makes a session run at all. */
const oneTurn = async function* (): AsyncGenerator<string> {
  yield JSON.stringify({ type: "turn", text: "let us write the spec" });
};

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
          model: drafter(),
          turns: oneTurn(),
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
          model: drafter(),
          turns: oneTurn(),
        },
      });
      // A tool call the interview refused is answered with the refusal's own
      // words, as the other transport answers one, so what says it was refused
      // is the `refused` event the protocol carries it on.
      const refused = new Set(
        refusals(streams).map((event) => event.tool),
      );
      const decisions: ContractDecision[] = server.answers().map((answer, at) => {
        const step = input.steps[at];
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
