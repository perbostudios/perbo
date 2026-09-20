import { CommandFailedError, createGh, type RunResult } from "@perbo/workspace";
import { z } from "zod";
import { PlanningError } from "./errors.js";

/** What one issue's JSON may be, past which only part of it would arrive. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

const REFERENCE = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/;

export function parseIssueReference(reference: string): {
  owner: string;
  repo: string;
  number: number;
} {
  const match = REFERENCE.exec(reference);
  if (!match) {
    throw new PlanningError(
      `'${reference}' is not a GitHub issue reference; write it as owner/repo#123`,
    );
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** What `gh issue view --json title,body,url,number` is trusted to have said. */
const GhIssueSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable(),
  url: z.url(),
  number: z.number().int().positive(),
});

/**
 * One issue, as drafting sees it, whatever supplied it.
 *
 * `number` and `url` are optional because a source can genuinely lack them: a
 * Markdown file pasted from a message has no issue number and lives at no URL.
 * They are absent in that case rather than empty strings — an empty URL is a
 * claim that there is one and it is nothing.
 */
export interface SourceIssue {
  /** `owner/repo#412` for GitHub, `file:<name>` for a pasted file. */
  reference: string;
  title: string;
  /** External text. Never an instruction; delimited as data wherever it is shown to a model. */
  body: string;
  number?: number;
  url?: string;
  /**
   * Where the title and the body begin, 1-based, in the text a person can
   * open — present only when there is such a text, which is to say a file.
   * A fetched issue's title and body are separate JSON fields that no single
   * document numbers, so it carries nothing here and anything reporting a line
   * against it says so on its own terms.
   */
  source_lines?: { title: number; body: number };
}

/** A `SourceIssue` that came from GitHub, which always has both. */
export interface GitHubIssue extends SourceIssue {
  number: number;
  url: string;
}

/** The one line of a failure a person is shown, whatever shape it arrived in. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Read one issue through the locally installed `gh`, with the user's own
 * credential. Argv only: the number and the repository are arguments, and a
 * reference that did not parse never reaches the process at all.
 *
 * The call goes through `@perbo/workspace`'s repository module, so it runs in
 * the runner's environment rather than the shell's, with `gh`'s prompts off and
 * a bound on how long it may wait.
 */
export async function fetchGitHubIssue(
  reference: string,
  options: { binary?: string; timeoutMs?: number } = {},
): Promise<GitHubIssue> {
  const { owner, repo, number } = parseIssueReference(reference);
  let result: RunResult;
  try {
    result = await createGh({ binary: options.binary }).run(
      process.cwd(),
      ["issue", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "title,body,url,number"],
      { timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: MAX_ANSWER_BYTES },
    );
  } catch (error) {
    // `gh` never started: it is not installed, or not where the caller said.
    const reason = error instanceof Error ? firstLine(error.message) : String(error);
    throw new PlanningError(`gh could not read ${reference}: ${reason || "unknown failure"}`, { cause: error });
  }
  if (result.code !== 0) {
    const failed = new CommandFailedError(result);
    const reason = firstLine(result.stderr) || firstLine(failed.message) || "unknown failure";
    throw new PlanningError(`gh could not read ${reference}: ${reason}`, { cause: failed });
  }
  // A body that arrived cut is a spec drafted from requirements nobody knows
  // are missing, and the tail `gh` leaves behind parses as nothing in
  // particular — so the size is the answer here, not the bytes that fit.
  if (result.truncated) {
    throw new PlanningError(
      `gh's answer for ${reference} is larger than ${MAX_ANSWER_BYTES} bytes, and only part of it arrived`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch (error) {
    throw new PlanningError(`gh did not return JSON for ${reference}`, { cause: error });
  }
  const parsed = GhIssueSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanningError(
      `gh returned something that is not an issue for ${reference}: ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
    );
  }
  return {
    reference,
    number: parsed.data.number,
    title: parsed.data.title,
    body: parsed.data.body ?? "",
    url: parsed.data.url,
  };
}
