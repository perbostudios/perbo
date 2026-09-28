import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES, type ReviewArtifact, type UsageLimitStop } from "@perbo/contracts";
import { TicketRunConfigSchema, type PreflightRequest, type PreflightResult } from "@perbo/runner";
import { initRepository } from "@perbo/test-support";
import { admitCommandLine } from "../admit.js";
import { inspectCommandLine } from "../inspect.js";
import { type ExecuteDeps, executeCommandLine, withModelChoice } from "./index.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { makeReview } from "../../test-support/records.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * D-NEW-pass-a-limited-loop-on at the command line: a ticket whose run ended
 * on a provider's usage limit is carried on to another connection with
 * `perbo run --ticket KEY --resume-from <bundle> --provider … --model …` (or
 * `--reviewer-provider … --reviewer-model …`), from the stopped attempt's work.
 *
 * The executor and the reviewer are stand-ins: what is proven is the surface
 * — what the stop says, what `inspect` records, and that the next run's
 * executor is the other connection's model, handed the work and told whose it
 * was — and not a provider's transport.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-run-usage-limit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const SESSION_LIMIT = "429 · You've hit your session limit · resets 4:30am (Europe/London)";
const LIMITED_MODEL = "claude-opus-5-5";
const WORK = "export const started = 'before the limit';\n";

/** What the machine answers: everything is there, for every connection. */
const ready = (seen: PreflightRequest[]) => (request: PreflightRequest): PreflightResult => {
  seen.push(request);
  return { ok: true, findings: [], tools: {}, github: null };
};

/** A repository with PRB-1 admitted and approved, and the run configuration it runs under. */
function fixture(): { repo: string; config: string } {
  const dir = mkdtempSync(join(scratch, "ticket-"));
  const repo = join(dir, "repo");
  initRepository(repo, {
    files: { "package.json": JSON.stringify({ name: "fixture" }), "src/index.ts": "export const version = 1;\n" },
  });
  const admitted = recordStreams();
  const code = runCommandLine(admitCommandLine, {
    argv: [
      "--repo", repo,
      "--outcome", "The feature module exports a computed total",
      "--criterion", "total() returns the sum of its inputs :: total([1,2]) is 3 :: test",
      "--path", "src/**",
      "--approve",
      "--json",
    ],
    streams: admitted,
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error(admitted.err());
  const config = join(dir, "run.json");
  writeFileSync(
    config,
    JSON.stringify({
      worktree_root: join(dir, "worktrees"),
      agent_provider: "claude-cli",
      model: LIMITED_MODEL,
      effort: "high",
      reviewer_provider: "claude-cli",
      reviewer_model: LIMITED_MODEL,
      materialization_manifest: {
        manifest_version: 1,
        repository_id: "repo_fixture",
        source_checkout: repo,
        entries: [],
        install: {
          kind: "none",
          package_manager: "none",
          offline_preferred: true,
          lifecycle_scripts: { policy: "disabled", exception: null },
          command: ["true"],
          pinned: true,
        },
        verify: { command: ["node", "-e", "process.exit(0)"], timeout_ms: 30_000 },
        isolation: { mode: "parallel", port_range_size: 0, port_range_start: 41_000, port_range_end: 41_009, database_schema_prefix: null },
      },
      // No reset is waited for, so a stated one always ends the run.
      limits: { organisation: "test", limits: { concurrent_local_attempts: 4, wait_for_provider_ms: 0 } },
    }),
  );
  return { repo, config };
}

/** One executor call as the stand-in saw it. */
interface Seen {
  model: string;
  prompt: string;
  binary: string;
}

/**
 * An executor stand-in: each call writes the next file of `script` into the
 * worktree and ends as the script says — refused by its provider's usage
 * limit, or finished.
 */
function executor(script: ReadonlyArray<{ file: string; body: string; limited: boolean }>) {
  const seen: Seen[] = [];
  const run = async (request: {
    worktree: string;
    prompt: string;
    model: string;
    binary: string;
  }) => {
    const step = script[Math.min(seen.length, script.length - 1)]!;
    seen.push({ model: request.model, prompt: request.prompt, binary: request.binary });
    const path = join(request.worktree, step.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, step.body);
    return {
      invocation: {
        adapter: "double",
        binary_path: request.binary,
        binary_version: "0.0.0",
        binary_sha256: "0".repeat(64),
        model: request.model,
        credential_class: "subscription",
        argv: ["-p", "<prompt>"],
        shape_sha256: "1".repeat(64),
        neutralisation: {
          suppressed_at_invocation: ["double"],
          withheld_from_worktree: [],
          asserted_empty: ["mcp_servers"],
          reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
        },
      },
      commands: [],
      egress: { all: () => [] },
      prohibited: [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        cost_micros: 1234,
        cost_basis: "transport_reported",
        cost_partial: false,
        iterations: 1,
      },
      termination: step.limited
        ? { reason: "transport_unavailable", detail: `the provider refused every retry: ${SESSION_LIMIT}` }
        : { reason: "completed", detail: "" },
      final_message: null,
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
  return { run: run as never, seen };
}

/** A review that approves, or one its provider refused on a usage limit, on the given connection. */
function reviewer(answer: "approve" | "limited", model: { provider: string; model_id: string }) {
  const calls: number[] = [];
  const review = async (request: { changeset?: { changeset_id: string } }) => {
    calls.push(calls.length);
    const base = makeReview({
      review_id: "rev_0000000000000101",
      changeset_id: request.changeset?.changeset_id ?? "cs_0000000000000001",
      decision: answer === "approve" ? "approve" : "error",
      cost_basis: "unavailable",
    });
    const artifact: ReviewArtifact = {
      ...base,
      model: { ...base.model, provider: model.provider, model_id: model.model_id },
      ...(answer === "limited"
        ? {
            coverage: base.coverage.map((entry) => ({ ...entry, status: "cannot_determine" as const })),
            findings: [],
            error: {
              kind: "provider_unavailable" as const,
              message: SESSION_LIMIT,
              attempts: 1,
              unresolved_criteria: base.coverage.map((entry) => entry.criterion_id),
              reading: [],
            },
          }
        : {}),
    };
    return {
      artifact,
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    };
  };
  return { review: review as never, calls };
}

async function run(
  at: { repo: string; config: string },
  deps: Partial<ExecuteDeps>,
  argv: readonly string[] = [],
): Promise<{ code: number; err: string }> {
  const streams = recordStreams();
  const code = await runCommandLine(executeCommandLine, {
    argv: ["--repo", at.repo, "--ticket", "PRB-1", "--config", at.config, "--json", ...argv],
    streams,
    cwd: at.repo,
    deps: { preflight: ready([]), ...deps },
  });
  return { code, err: streams.err() };
}

interface InspectJson {
  attempts: Array<{
    attempt_id: string;
    agent: { model: string };
    usage_limit: UsageLimitStop | null;
    bundles: Array<{ bundle_id: string; kind: string }>;
    record: { resumed_from: { bundle_id: string } | null };
  }>;
}
function inspect(repo: string): InspectJson {
  const streams = recordStreams();
  expect(
    runCommandLine(inspectCommandLine, { argv: ["PRB-1", "--repo", repo, "--json"], streams, cwd: repo }),
  ).toBe(0);
  return streams.json<InspectJson>();
}

/** The line `perbo run` ends a limited run with, naming the bundle to carry on from. */
const passOnLine = (err: string): string => err.split("\n").find((line) => line.startsWith("pass on ")) ?? "";

describe("a ticket stopped on the executor's usage limit, at the command line", () => {
  it("says whose limit it was, and --provider and --model carry the work on to another connection", async () => {
    const at = fixture();
    const agent = executor([
      { file: "src/started.ts", body: WORK, limited: true },
      { file: "src/feature.ts", body: "export const total = (n) => n.length;\n", limited: false },
    ]);

    const stopped = await run(at, { hooks: { agent: agent.run, review: reviewer("approve", { provider: "codex-cli", model_id: "gpt-5.5" }).review } });
    expect(stopped.code, stopped.err).toBe(EXIT_CODES.did_not_complete);
    expect(stopped.err).toContain(
      `limit   the executor's connection, claude-cli (${LIMITED_MODEL}), refused the attempt on a usage limit until`,
    );
    const limited = inspect(at.repo).attempts;
    expect(limited).toHaveLength(1);
    expect(limited[0]!.usage_limit).toMatchObject({ role: "executor", provider: "claude-cli", model: LIMITED_MODEL, waited: false });
    const bundle = limited[0]!.bundles.find((entry) => entry.kind === "execution")!.bundle_id;
    expect(passOnLine(stopped.err)).toBe(
      `pass on perbo run --ticket PRB-1 --resume-from ${bundle} --provider <another connection> --model <one of its models>`,
    );

    // The person takes Codex for the executor, from the stopped attempt's work.
    const machine: PreflightRequest[] = [];
    const carried = await run(
      at,
      { preflight: ready(machine), hooks: { agent: agent.run, review: reviewer("approve", { provider: "codex-cli", model_id: "gpt-5.5" }).review } },
      ["--resume-from", bundle, "--provider", "codex-cli", "--model", "gpt-5.5"],
    );
    expect(carried.code, carried.err).toBe(0);
    // The machine was asked for Codex, and Codex's model ran.
    expect(machine[0]).toMatchObject({ agentProvider: "codex-cli", agentBinary: "codex" });
    expect(agent.seen.map((call) => call.model)).toEqual([LIMITED_MODEL, "gpt-5.5"]);
    expect(agent.seen[1]!.binary).toBe("codex");
    const brief = agent.seen[1]!.prompt;
    expect(brief).toContain("was stopped part-way by its provider's usage limit (it ended `transport_unavailable`)");
    expect(brief).toContain(`That attempt ran on another model, \`${LIMITED_MODEL}\`; you are \`gpt-5.5\``);

    const record = inspect(at.repo).attempts;
    expect(record.map((attempt) => attempt.agent.model)).toEqual([LIMITED_MODEL, "gpt-5.5"]);
    expect(record[1]!.record.resumed_from?.bundle_id).toBe(bundle);
    expect(record[1]!.usage_limit).toBeNull();
  }, 120_000);
});

describe("a ticket stopped on the reviewer's usage limit, at the command line", () => {
  it("says so, and --reviewer-provider and --reviewer-model carry the review on to another connection", async () => {
    const at = fixture();
    const agent = executor([{ file: "src/feature.ts", body: "export const total = (n) => n.length;\n", limited: false }]);

    const refused = reviewer("limited", { provider: "claude-cli", model_id: LIMITED_MODEL });
    const stopped = await run(at, { hooks: { agent: agent.run, review: refused.review } });
    expect(stopped.code, stopped.err).toBe(EXIT_CODES.did_not_complete);
    expect(stopped.err).toContain(
      `limit   the reviewer's connection, claude-cli (${LIMITED_MODEL}), refused the review on a usage limit until`,
    );
    const limited = inspect(at.repo).attempts;
    expect(limited[0]!.usage_limit).toMatchObject({ role: "reviewer", provider: "claude-cli", model: LIMITED_MODEL });
    const bundle = limited[0]!.bundles.find((entry) => entry.kind === "execution")!.bundle_id;
    expect(passOnLine(stopped.err)).toBe(
      `pass on perbo run --ticket PRB-1 --resume-from ${bundle} --reviewer-provider <another connection> --reviewer-model <one of its models>`,
    );

    const machine: PreflightRequest[] = [];
    const approving = reviewer("approve", { provider: "anthropic", model_id: "claude-fable-5-1" });
    const carried = await run(
      at,
      { preflight: ready(machine), hooks: { agent: agent.run, review: approving.review } },
      ["--resume-from", bundle, "--reviewer-provider", "anthropic", "--reviewer-model", "claude-fable-5-1"],
    );
    expect(carried.code, carried.err).toBe(0);
    expect(machine[0]).toMatchObject({ agentProvider: "claude-cli", reviewerProvider: "anthropic" });
    expect(approving.calls).toHaveLength(1);
    // The same executor model carries its own finished work on, told no review judged it.
    expect(agent.seen.map((call) => call.model)).toEqual([LIMITED_MODEL, LIMITED_MODEL]);
    expect(agent.seen[1]!.prompt).toContain(
      "finished its work, and no review judged it: the reviewer's provider refused the review on a usage limit",
    );
  }, 120_000);
});

describe("withModelChoice", () => {
  const configured = {
    ticket_key: "PRB-1",
    repository_root: "/repo",
    base_ref: "main",
    worktree_root: "/w",
    bundle_root: "/b",
    quarantine_root: "/q",
    state_root: "/s",
    agent_binary: "/opt/claude",
    agent_provider: "claude-cli",
    model: LIMITED_MODEL,
    effort: "high",
    reviewer_provider: "claude-cli",
    reviewer_model: LIMITED_MODEL,
    reviewer_effort: "high",
  };
  const none: Parameters<typeof withModelChoice>[1] = {
    provider: null,
    model: null,
    reviewerProvider: null,
    reviewerModel: null,
  };
  const parsed = (flags: Partial<typeof none>) =>
    TicketRunConfigSchema.parse(withModelChoice(configured, { ...none, ...flags }));

  it("takes another connection's binary, model and effort with it", () => {
    const config = parsed({ provider: "codex-cli", model: "gpt-5.5" });
    expect(config).toMatchObject({ agent_provider: "codex-cli", agent_binary: "codex", model: "gpt-5.5", effort: null });
    // The reviewer is untouched.
    expect(config).toMatchObject({ reviewer_provider: "claude-cli", reviewer_model: LIMITED_MODEL, reviewer_effort: "high" });
  });

  it("starts another connection at its own default model where none is named", () => {
    const config = parsed({ provider: "opencode-cli" });
    expect(config.agent_provider).toBe("opencode-cli");
    expect(config.model).not.toBe(LIMITED_MODEL);
  });

  it("changes only the model on the connection already configured", () => {
    expect(parsed({ provider: "claude-cli", model: "claude-sonnet-5" })).toMatchObject({
      agent_binary: "/opt/claude",
      model: "claude-sonnet-5",
      effort: "high",
    });
  });

  it("takes the reviewer to another connection, its model and effort with it", () => {
    expect(parsed({ reviewerProvider: "anthropic", reviewerModel: "claude-fable-5-1" })).toMatchObject({
      reviewer_provider: "anthropic",
      reviewer_model: "claude-fable-5-1",
      reviewer_effort: null,
      agent_provider: "claude-cli",
      model: LIMITED_MODEL,
    });
  });

  it("refuses a connection the role does not run on", () => {
    expect(() => withModelChoice(configured, { ...none, provider: "anthropic" })).toThrow(/--provider takes/);
    expect(() => withModelChoice(configured, { ...none, reviewerProvider: "gemini" })).toThrow(/--reviewer-provider takes/);
  });
});
