import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { isCredentialEnvName, redactCredentials, scrubEnvironment } from "@perbo/contracts";
import {
  CLAUDE_CLI_ENV_ALLOW_LIST,
  codexCliModel,
  providerFailureText,
} from "@perbo/model";

/**
 * One minimal call to the reviewer, made by `perbo doctor --probe` before an
 * attempt has spent anything.
 *
 * Every other check `doctor` makes is local: a binary is on PATH, a version is
 * new enough, a credential *variable* is set. None of them can tell a key that
 * was revoked yesterday from one that works, a model name with a typo in it
 * from one this account can call, or a machine behind a proxy that drops the
 * connection. Those are found today by starting a run, provisioning a worktree
 * and paying an executor to write a change — and then failing at the review.
 * So this asks the provider itself, once, with the smallest call the transport
 * can make, and names which of the four things went wrong.
 *
 * Two properties are the whole point and are stated here because they are the
 * ones that could quietly stop being true:
 *
 * 1. **It is the configured transport, not a stand-in.** `claude-cli` spawns
 *    the same binary the reviewer spawns, with the same suppression flags and
 *    the same scrubbed environment; `anthropic` posts to the same endpoint with
 *    the same header. A probe that agreed with a run only by construction would
 *    be measuring nothing.
 * 2. **Nothing that authenticates reaches the caller.** The provider's own
 *    words are quoted back — that is most of the diagnostic value — and a
 *    provider that echoes the key into its error text is common. So every
 *    credential-shaped value the environment holds is removed from that text by
 *    exact match, and the shared credential detector then runs over what is
 *    left for the shapes this machine does not hold.
 */

export type ProbeProvider = "anthropic" | "claude-cli" | "codex-cli";

/**
 * What went wrong, as a person has to act on it. The four named in the outcome
 * are the four with distinct fixes; `transport_missing` is the local failure
 * that precedes all of them, and `unclassified` is what an honest classifier
 * needs so that a failure it has never seen is reported as itself rather than
 * as the nearest label.
 */
export type ProbeFailureClass =
  | "authentication"
  | "unknown_model"
  | "network"
  | "rate_limit"
  | "transport_missing"
  | "unclassified";

export interface ProbeRequest {
  provider: ProbeProvider;
  /** The model the reviewer is configured to call, and the one the probe calls. */
  model: string;
  /** Defaults to the process environment, which is where both credentials live. */
  env?: NodeJS.ProcessEnv;
  /** `claude-cli` only: the binary the reviewer transport spawns. */
  binary?: string;
  timeoutMs?: number;
}

export interface ProbeSuccess {
  ok: true;
  provider: ProbeProvider;
  model: string;
  /** The measured round trip, which is the other half of "it answers". */
  elapsed_ms: number;
}

export interface ProbeFailure {
  ok: false;
  provider: ProbeProvider;
  model: string;
  elapsed_ms: number;
  failure: ProbeFailureClass;
  /** One sentence naming what failed. Never the provider's raw text. */
  detail: string;
  /** The provider's own words, bounded and redacted, or null where it said none. */
  said: string | null;
  /** The one action that clears it, in the shape `preflight` writes fixes. */
  fix: string;
}

export type ProbeResult = ProbeSuccess | ProbeFailure;

/**
 * The smallest thing that still goes all the way to the model: one turn, one
 * token back. The prompt is fixed and carries nothing from the repository.
 */
const PROBE_PROMPT = "ping";

/** A diagnostic waits, but not for as long as a review may. */
const PROBE_TIMEOUT_MS = 60_000;

const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Names whose values authenticate something. `isCredentialEnvName` is the
 * runner's own list of what may never be forwarded to a child; this widens it
 * by shape for the *reading* side, because a value that must not be forwarded
 * must also not be printed.
 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;

/** Below this a value is a setting, not a credential, and matching it would mangle prose. */
const MIN_SECRET_LENGTH = 8;

function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    if (isCredentialEnvName(name) || SECRET_NAME.test(name)) values.add(value);
  }
  // Longest first: a key and a prefix of it both present must not leave the
  // prefix behind after the longer one is replaced.
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * The provider's own words, as this command is allowed to state them: one
 * bounded line with nothing the process was handed quoted back
 * (`providerFailureText`), then every credential this machine holds removed by
 * exact match, then the shared detector over what remains.
 */
export function probeSaid(raw: string, env: NodeJS.ProcessEnv): string | null {
  let text = providerFailureText(raw, [PROBE_PROMPT]);
  if (text === "no error text") return null;
  for (const secret of secretValues(env)) {
    text = text.split(secret).join("[redacted:environment]");
  }
  return redactCredentials(text).text;
}

const AUTHENTICATION =
  /invalid[\s_-]*(?:x-)?api[\s_-]*key|authentication[\s_-]*error|permission[\s_-]*error|unauthorized|invalid bearer token|oauth token (?:has )?expired|please run\s*`?\/login|not logged in|log ?in to|sign in|credential/i;
const UNKNOWN_MODEL =
  /not[\s_-]*found[\s_-]*error|unknown model|invalid model|model[^\n]{0,60}?(?:not found|does not exist|is not (?:a )?valid|not available|is unknown)/i;
const RATE_LIMIT =
  /rate[\s_-]*limit|too many requests|overloaded|quota exceeded|usage limit|capacity/i;
const NETWORK =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|getaddrinfo|socket hang up|fetch failed|network|connection (?:error|refused|reset|closed|timed out)|certificate|self.signed|tunneling socket|proxy/i;

/**
 * Which of the classes a refusal belongs to.
 *
 * The HTTP status is taken first where there is one, because it is the
 * provider's own statement and does not depend on the wording of a message.
 * The text is read only where there is no status to read — which is every
 * `claude-cli` failure that never reached the API, and every fetch that threw.
 */
export function classifyProbeFailure(input: { status: number | null; text: string }): ProbeFailureClass {
  const { status, text } = input;
  if (status !== null) {
    if (status === 401 || status === 403) return "authentication";
    if (status === 404) return "unknown_model";
    if (status === 429 || status === 529) return "rate_limit";
    if (status >= 500) return "network";
  }
  if (AUTHENTICATION.test(text)) return "authentication";
  if (UNKNOWN_MODEL.test(text)) return "unknown_model";
  if (RATE_LIMIT.test(text)) return "rate_limit";
  if (NETWORK.test(text)) return "network";
  return "unclassified";
}

/** What each class means, in one sentence that does not repeat the provider's. */
function detailFor(failure: ProbeFailureClass, request: { model: string; binary: string }): string {
  switch (failure) {
    case "authentication":
      return "the provider refused the credential";
    case "unknown_model":
      return `the provider does not know the model \`${request.model}\``;
    case "rate_limit":
      return "the provider refused the call for rate or quota";
    case "network":
      return "the provider did not answer";
    case "transport_missing":
      return `\`${request.binary}\` could not be run`;
    case "unclassified":
      return "the provider refused the call and did not say why in words this recognises";
  }
}

/** The one action that clears it, which differs by transport as well as by class. */
function fixFor(
  failure: ProbeFailureClass,
  request: { provider: ProbeProvider; model: string; binary: string },
): string {
  if (request.provider === "codex-cli") return failure === "authentication" ? "run `codex login`, then probe again" : failure === "transport_missing" ? "install the Codex CLI, then run `codex login`" : failure === "unknown_model" ? `choose a Codex model this account can call instead of ${request.model}` : "check the Codex CLI connection and subscription allowance, then probe again";
  const cli = request.provider === "claude-cli";
  switch (failure) {
    case "authentication":
      return cli
        ? `run \`${request.binary}\` and sign in — the reviewer calls it on your own login — ` +
            "or set ANTHROPIC_API_KEY and reviewer_provider to `anthropic`"
        : "export ANTHROPIC_API_KEY with a key this account still accepts, or set " +
            "reviewer_provider to `claude-cli` to review on your Claude Code login";
    case "unknown_model":
      return (
        `set reviewer_model in .perbo/config.json to a model this account can call — \`${request.model}\` ` +
        "is not one — or remove it to take the default"
      );
    case "rate_limit":
      return "wait for the limit to reset, or use an account with headroom: a run would stop at the same limit";
    case "network":
      return cli
        ? "check the connection the `claude` binary makes (proxy, VPN, ANTHROPIC_BASE_URL) and probe again"
        : "check the connection to the API (proxy, VPN, ANTHROPIC_BASE_URL) and probe again";
    case "transport_missing":
      return cli
        ? "install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in with `claude`"
        : `make \`${request.binary}\` runnable, or set reviewer_provider to \`claude-cli\``;
    case "unclassified":
      return "take the provider's own words above to its support; nothing here recognises this refusal";
  }
}

function failure(input: {
  request: { provider: ProbeProvider; model: string; binary: string };
  failure: ProbeFailureClass;
  said: string | null;
  elapsed_ms: number;
}): ProbeFailure {
  return {
    ok: false,
    provider: input.request.provider,
    model: input.request.model,
    elapsed_ms: input.elapsed_ms,
    failure: input.failure,
    detail: detailFor(input.failure, input.request),
    said: input.said,
    fix: fixFor(input.failure, input.request),
  };
}

interface CliOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

/**
 * One invocation with the prompt on stdin, the way the transport makes it:
 * `promisify(execFile)` returns a promise and not the child, so there is
 * nowhere to write the prompt.
 */
function runCli(
  binary: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
): Promise<CliOutput> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      [...args],
      { ...options, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failed = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number }) | null;
        resolve({
          stdout,
          stderr,
          code: failed === null ? 0 : typeof failed.code === "number" ? failed.code : null,
          killed: failed?.killed === true,
          spawnError: failed !== null && typeof failed.code === "string" ? failed : null,
        });
      },
    );
    // A process that exits before draining the prompt closes this pipe under
    // the write; the callback already carries why.
    child.stdin?.on("error", () => {});
    child.stdin?.end(PROBE_PROMPT);
  });
}

/** What the CLI puts on stdout under `--output-format json`, as far as this reads it. */
interface CliEnvelope {
  is_error?: boolean;
  api_error_status?: number | null;
  result?: unknown;
}

async function probeClaudeCli(
  request: Required<Pick<ProbeRequest, "model" | "binary">> & { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProbeResult> {
  const identity = { provider: "claude-cli" as const, model: request.model, binary: request.binary };
  // The reviewer transport's own invocation, minus the review: the same
  // suppression set (ADR-0030), the same scrubbed environment, the same
  // scratch working directory, and a prompt of one word on stdin.
  const args = [
    "-p",
    "--model",
    request.model,
    "--tools",
    "",
    "--setting-sources",
    "user",
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    '{"disableAllHooks":true}',
    "--disable-slash-commands",
    "--output-format",
    "json",
  ];
  const environment = scrubEnvironment({ base: request.env, allow: CLAUDE_CLI_ENV_ALLOW_LIST });

  const started = performance.now();
  const out = await runCli(request.binary, args, {
    cwd: tmpdir(),
    timeout: request.timeoutMs,
    env: environment.env,
  });
  const elapsed_ms = Math.round(performance.now() - started);
  const said = probeSaid(`${out.stderr}\n${out.stdout}`.trim(), request.env);

  if (out.spawnError !== null) {
    return failure({
      request: identity,
      failure: out.spawnError.code === "ENOENT" ? "transport_missing" : "unclassified",
      said,
      elapsed_ms,
    });
  }
  if (out.killed) {
    return failure({
      request: identity,
      failure: "network",
      said: `no answer within ${Math.round(request.timeoutMs / 1000)}s`,
      elapsed_ms,
    });
  }

  // The result envelope, where there is one. A CLI that failed before it could
  // write one has said what it has to say on stderr instead.
  let envelope: CliEnvelope | null;
  try {
    envelope = JSON.parse(out.stdout) as CliEnvelope;
  } catch {
    envelope = null;
  }

  if (out.code === 0 && envelope !== null && envelope.is_error !== true) {
    return { ok: true, provider: "claude-cli", model: request.model, elapsed_ms };
  }

  const status = typeof envelope?.api_error_status === "number" ? envelope.api_error_status : null;
  const text = [
    out.stderr,
    typeof envelope?.result === "string" ? envelope.result : out.stdout,
  ]
    .filter(Boolean)
    .join("\n");
  return failure({
    request: identity,
    failure: classifyProbeFailure({ status, text }),
    said,
    elapsed_ms,
  });
}

async function probeAnthropic(
  request: { model: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProbeResult> {
  const identity = { provider: "anthropic" as const, model: request.model, binary: "the API" };
  const key = request.env.ANTHROPIC_API_KEY;
  if (!key) {
    // No call is made, because there is nothing to authenticate it with. It is
    // the same class a rejected key gets: the provider will not answer this
    // machine, and the fix is the same variable.
    return failure({
      request: identity,
      failure: "authentication",
      said: "ANTHROPIC_API_KEY is not set, so no call was made",
      elapsed_ms: 0,
    });
  }
  const base = (request.env.ANTHROPIC_BASE_URL ?? ANTHROPIC_API).replace(/\/+$/, "");

  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 1,
        messages: [{ role: "user", content: PROBE_PROMPT }],
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    const elapsed_ms = Math.round(performance.now() - started);
    const thrown = error as { name?: string; message?: string; cause?: { message?: string } };
    const text = [thrown.message, thrown.cause?.message].filter(Boolean).join(": ");
    return failure({
      request: identity,
      failure: thrown.name === "TimeoutError" ? "network" : classifyProbeFailure({ status: null, text }),
      said:
        thrown.name === "TimeoutError"
          ? `no answer within ${Math.round(request.timeoutMs / 1000)}s`
          : probeSaid(text, request.env),
      elapsed_ms,
    });
  }

  if (response.ok) {
    // The body is read before the clock is stopped: a round trip is not over
    // until the answer has arrived.
    await response.text();
    const elapsed_ms = Math.round(performance.now() - started);
    return { ok: true, provider: "anthropic", model: request.model, elapsed_ms };
  }

  const body = await response.text().catch(() => "");
  const elapsed_ms = Math.round(performance.now() - started);
  return failure({
    request: identity,
    failure: classifyProbeFailure({ status: response.status, text: body }),
    said: probeSaid(body, request.env),
    elapsed_ms,
  });
}

/**
 * Ask the configured reviewer, once, whether it will answer this machine.
 *
 * Never throws: every way this can fail is one of the classes, and a diagnostic
 * that ends in a stack trace has diagnosed nothing.
 */
export async function probeReviewer(request: ProbeRequest): Promise<ProbeResult> {
  const env = request.env ?? process.env;
  const timeoutMs = request.timeoutMs ?? PROBE_TIMEOUT_MS;
  const binary = request.binary ?? (request.provider === "codex-cli" ? "codex" : "claude");
  try {
    if (request.provider === "codex-cli") {
      const model = codexCliModel({ modelId: request.model, binary, timeoutMs, submitSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
      const started = performance.now();
      try {
        await model.turn({ system: "Connectivity check. Submit the review with ok true. No repository files are needed.", messages: [{ role: "user", content: "ping" }], forceSubmit: true });
        return { ok: true, provider: "codex-cli", model: request.model, elapsed_ms: Math.round(performance.now() - started) };
      } finally { await model.dispose?.(); }
    }
    return request.provider === "claude-cli"
      ? await probeClaudeCli({ model: request.model, binary, env, timeoutMs })
      : await probeAnthropic({ model: request.model, env, timeoutMs });
  } catch (error) {
    return failure({
      request: { provider: request.provider, model: request.model, binary },
      failure: "unclassified",
      said: probeSaid(error instanceof Error ? error.message : String(error), env),
      elapsed_ms: 0,
    });
  }
}

/**
 * The reviewer a run on this checkout would use, and where each half of it came
 * from.
 *
 * Resolved in one place because two callers read it — the probe, which calls
 * that transport at that model, and the sentence that says why a failed probe
 * blocks — and a second resolution would eventually disagree with the loop's
 * own (`reviewer_model ?? model`, `reviewer_provider`).
 */
export interface ConfiguredReviewer {
  provider: ProbeProvider;
  model: string;
  /**
   * The keys of the run configuration those two were actually read from, in
   * reading order. Empty where the file exists and says nothing about the
   * reviewer, which is a different fact about that file and gets a different
   * sentence below.
   */
  keys: string[];
}

export function configuredReviewer(
  config: Record<string, unknown> | null,
  defaults: { provider: ProbeProvider; model: string },
): ConfiguredReviewer {
  const provider = config?.["reviewer_provider"];
  const reviewerModel = config?.["reviewer_model"];
  const runModel = config?.["model"];
  const pinned = provider === "anthropic" || provider === "claude-cli" || provider === "codex-cli";
  const keys: string[] = [];
  if (pinned) keys.push("reviewer_provider");
  if (typeof reviewerModel === "string" && reviewerModel !== "") keys.push("reviewer_model");
  else if (typeof runModel === "string" && runModel !== "") keys.push("model");
  return {
    provider: pinned ? provider : defaults.provider,
    model:
      typeof reviewerModel === "string" && reviewerModel !== ""
        ? reviewerModel
        : typeof runModel === "string" && runModel !== ""
          ? runModel
          : defaults.model,
    keys,
  };
}

/**
 * Whether a failed probe is a reason for `doctor` to exit non-zero here.
 *
 * A diagnostic does not fail a machine for a question nobody asked: on a
 * checkout that no run is configured for, a provider that will not answer is
 * reported and the exit code is the one `doctor` would have had anyway. It
 * becomes blocking exactly where this checkout's own reasons say a command
 * would depend on the provider — `--publish` opens the pull request only after
 * a review, and a `.perbo/config.json` is the file `perbo run` is configured
 * from, and every run reviews.
 *
 * The reason states only what is true of the file in front of it. A config that
 * pins `reviewer_provider`, `reviewer_model` or the run's `model` is named by
 * those keys; a config that pins none of them still configures a run here, and
 * the sentence says that the review takes the default rather than crediting the
 * file with a choice it does not contain. Both block, for the one reason a run
 * here reviews at all — but a person reading the exit code is told which of the
 * two they have, and can open the file and check.
 */
export interface ProbeDependency {
  blocking: boolean;
  reason: string;
}

/** The ecosystem's own "a, b and c", rather than a join that mangles two. */
const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

export function reviewerDependency(input: {
  publish: boolean;
  configured: boolean;
  configPath: string;
  /** The keys of that file the reviewer identity was read from; see `configuredReviewer`. */
  reviewerKeys: readonly string[];
  /** The transport the probe used, which is what a file naming none of them gets. */
  provider: ProbeProvider;
}): ProbeDependency {
  if (input.publish) {
    return {
      blocking: true,
      reason:
        "--publish opens the pull request only after this provider has reviewed the attempt, " +
        "so a provider that will not answer is blocking",
    };
  }
  if (input.configured) {
    const names =
      input.reviewerKeys.length > 0
        ? `${input.configPath} sets ${AND.format([...input.reviewerKeys])}`
        : `${input.configPath} configures a run here and names no reviewer, so the review takes ` +
          `the default \`${input.provider}\``;
    return {
      blocking: true,
      reason: `\`perbo run\` here reviews through this provider — ${names} — so a provider that will not answer is blocking`,
    };
  }
  return {
    blocking: false,
    reason: `no run on this checkout is configured yet (${input.configPath} does not exist), so this is reported and the exit code is unchanged`,
  };
}

/**
 * The PROVIDER block: whether the reviewer answers this machine, and what to do
 * when it does not.
 *
 * Written whether or not the probe ran, because "not asked" and "asked and it
 * answered" are different states and a block that appeared only sometimes would
 * read as the second.
 */
export function renderProviderProbe(input: {
  provider: ProbeProvider;
  model: string;
  result: ProbeResult | null;
  dependency: ProbeDependency;
}): string[] {
  const label = input.provider.padEnd(12);
  if (input.result === null) {
    return [
      `  · ${label} the probe was not run — pass --probe to make one minimal call at ${input.model}`,
    ];
  }
  if (input.result.ok) {
    return [`  ✓ ${label} ${input.model} answered in ${input.result.elapsed_ms} ms`];
  }
  const lines = [
    `  ✗ ${label} ${input.result.failure}: ${input.result.detail} (after ${input.result.elapsed_ms} ms)`,
  ];
  if (input.result.said !== null) lines.push(`    ${"".padEnd(12)} said: ${input.result.said}`);
  lines.push(`    ${"".padEnd(12)} fix: ${input.result.fix}`);
  lines.push(
    `    ${"".padEnd(12)} ${input.dependency.blocking ? "blocking" : "advisory"}: ${input.dependency.reason}`,
  );
  return lines;
}
