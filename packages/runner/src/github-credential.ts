import { GH_NOT_LOGGED_IN, type GithubCredential } from "@perbo/contracts";
import { createGh, gh } from "@perbo/workspace";

/**
 * Which credential GitHub is read through, and whether it answers (SCP-200).
 *
 * One question, asked in one place, so that `sync`, `publish`, `review --pr`
 * and `doctor` all decide it the same way and all record the same answer. The
 * machine's `gh` login is a single file every process shares; a `GH_TOKEN` in
 * the environment is a credential the process holds itself, and is the only
 * one of the two that several processes can use at once without racing each
 * other for it.
 *
 * Nothing here ever returns, prints or records the token's value. The answer is
 * which path served, never what was on it.
 */

export interface GithubCredentialReading {
  credential: GithubCredential;
  /** Whether `gh auth status` exited zero on that path. */
  answers: boolean;
}

/** Refused before anything was read: this machine has no GitHub credential. */
export class GithubCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubCredentialError";
  }
}

/**
 * The path `gh` will take, from the environment alone.
 *
 * `gh` reads `GH_TOKEN` first and `GITHUB_TOKEN` after it; either is the token
 * path, and the answer names the path rather than which variable held it.
 */
export function githubCredential(env: NodeJS.ProcessEnv = process.env): GithubCredential {
  return env.GH_TOKEN || env.GITHUB_TOKEN ? "GH_TOKEN" : "gh_login";
}

export interface GithubCredentialRequest {
  env?: NodeJS.ProcessEnv;
  /** The `gh` to ask. Production leaves it as the one on PATH. */
  binary?: string | undefined;
  timeoutMs?: number;
}

/** Whether `gh auth status` answers on whichever credential the env carries. */
function ghAnswers(request: GithubCredentialRequest): boolean {
  const asked = request.binary === undefined ? gh : createGh({ binary: request.binary });
  try {
    const status = asked.runSync(process.cwd(), ["auth", "status"], {
      ...(request.env === undefined ? {} : { base: request.env }),
      timeoutMs: request.timeoutMs ?? 30_000,
    });
    return status.code === 0;
  } catch {
    // No `gh` on this machine at all, which is the same answer as one that
    // will not say who it is logged in as.
    return false;
  }
}

/**
 * The path and whether it answers, asking `gh` on both.
 *
 * For a diagnostic — `perbo doctor` — where "GitHub answers" is the thing
 * being reported, and a token that GitHub has since revoked is exactly what a
 * person is looking for.
 */
export function readGithubCredential(
  request: GithubCredentialRequest = {},
): GithubCredentialReading {
  return { credential: githubCredential(request.env), answers: ghAnswers(request) };
}

/**
 * The reading a command needs before it reads GitHub, or a refusal.
 *
 * A token in the environment is taken at its word and `gh` is not asked about
 * its own login at all — that is one fewer process touching the shared config,
 * which is the point. Without one, `gh`'s stored login is the fallback and is
 * asked; a `gh` that cannot answer is refused here rather than at whatever the
 * command was going to do next.
 */
export function requireGithubCredential(
  request: GithubCredentialRequest & { what: string },
): GithubCredentialReading {
  const credential = githubCredential(request.env);
  if (credential === "GH_TOKEN") return { credential, answers: true };
  if (ghAnswers(request)) return { credential, answers: true };
  throw new GithubCredentialError(
    `${GH_NOT_LOGGED_IN} and no GH_TOKEN is set, so ${request.what}. ` +
      "Run `gh auth login`, or export GH_TOKEN with a token scoped to this repository.",
  );
}
