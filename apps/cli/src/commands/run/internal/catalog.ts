import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { scrubEnvironment } from "@perbo/contracts";
import { CLAUDE_CLI_ENV_ALLOW_LIST } from "@perbo/model";
import { CLAUDE_METADATA_ARGS, offeredPreferredModel } from "@perbo/model/defaults";

/**
 * The model a configuration `doctor` proposes names: Claude Opus 5.5
 * where the catalog offers it, under its own id or else its 1M-context one,
 * and `fallback` where the catalog does not offer it or could not be read.
 */
export function proposedModel(offered: readonly string[] | null, fallback: string): string {
  if (offered === null) return fallback;
  return offeredPreferredModel(offered) ?? fallback;
}

const Response = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("success"),
    request_id: z.literal("catalog"),
    response: z.object({
      models: z.array(z.object({ value: z.string(), resolvedModel: z.string().optional() })),
    }),
  }),
});

/**
 * The model ids Claude Code's catalog offers, asked of `binary` with one
 * `initialize` control request and nothing else: no prompt is written, so no
 * turn starts and nothing is spent. Repository instructions, hooks, tools,
 * plugins and MCP servers are off, the environment is the one a review is
 * given, and the answer is each row's resolved model where it names one — an
 * alias (`opus`) stands for the model it resolves to. Rejects where the CLI
 * does not answer within `timeoutMs`.
 */
export function readClaudeModels(binary: string, timeoutMs = 10_000): Promise<string[]> {
  const scratch = mkdtempSync(join(tmpdir(), "perbo-doctor-models-"));
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(
      binary,
      [...CLAUDE_METADATA_ARGS],
      {
        cwd: scratch,
        env: scrubEnvironment({ base: process.env, allow: CLAUDE_CLI_ENV_ALLOW_LIST }).env,
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, ids?: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(ids!);
    };
    const timer = setTimeout(() => finish(new Error("Claude Code did not report its models in time")), timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("close", () => finish(new Error("Claude Code exited before reporting its models")));
    child.stdin.on("error", () => finish(new Error("Claude Code closed before reporting its models")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const answer = Response.safeParse(parsed);
        if (answer.success)
          finish(null, answer.data.response.response.models.map((model) => model.resolvedModel ?? model.value));
      }
    });
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "catalog",
        request: { subtype: "initialize", hooks: {}, agents: {}, skills: [] },
      }) + "\n",
    );
  }).finally(() => rmSync(scratch, { recursive: true, force: true }));
}
