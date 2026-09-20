import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ADMISSION_RULES, judgeCommand } from "../src/admission.js";
import { githubCredential } from "../src/github-credential.js";
import { preflight, renderPreflight } from "../src/preflight.js";
import { DEFAULT_COMMAND_ALLOW_LIST, DEFAULT_COMMAND_DENY_LIST } from "../src/profile.js";

/**
 * SCP-200: which credential path GitHub is read through, decided once.
 *
 * One `gh` login on a machine is not shared safely by every process on it, so
 * the runner reads GitHub through `GH_TOKEN` where the environment carries one
 * and through `gh`'s own stored login where it does not — and it says which,
 * before a run provisions anything. A machine with neither is refused in the
 * words a person can search for.
 *
 * Every check here spawns a fake `gh` on PATH, so each declares its own
 * deadline: the gate runs these under load beside everything else.
 */

const SPAWN_DEADLINE_MS = 20_000;

const scratch = mkdtempSync(join(tmpdir(), "perbo-gh-credential-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A `gh` on PATH that answers `--version` and decides `auth status` by exit
 * code, and logs every argument list it was given. Nothing else is answered:
 * a call this does not model is a failure here rather than a silent pass.
 */
function fakeGh(name: string, authExit: number): { path: string; calls: () => string[] } {
  const bin = join(scratch, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls");
  writeFileSync(log, "");
  const script = join(bin, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `if [ "$1" = "--version" ]; then echo "gh version 2.62.0 (fake)"; exit 0; fi`,
      `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit ${authExit}; fi`,
      `echo "this fake gh answers --version and auth status only, got: $*" >&2`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    path: bin,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== ""),
  };
}

/** A request that asks about nothing but `gh`. */
const request = (env: NodeJS.ProcessEnv, needsGh: boolean, probeGithub?: boolean) => ({
  agentBinary: null,
  agentProvider: null,
  reviewerProvider: "anthropic" as const,
  needsGh,
  needsGit: false,
  env: { ANTHROPIC_API_KEY: "set", ...env },
  ...(probeGithub === undefined ? {} : { probeGithub }),
});

const SENTINEL = "ghp_scp200sentineltokenvalue";

describe("the credential path GitHub is read through", () => {
  it(
    "refuses a publishing run with neither a token nor a login, in the words `gh is not logged in`",
    () => {
      const gh = fakeGh("logged-out", 1);
      const result = preflight(request({ PATH: gh.path }, true));

      expect(result.ok).toBe(false);
      const finding = result.findings.find((entry) => entry.reason === "gh_not_authenticated");
      expect(finding?.severity).toBe("blocking");
      expect(finding?.detail).toContain("gh is not logged in");
      expect(result.github).toEqual({ credential: "gh_login", answers: false });
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "reads through GH_TOKEN where the environment carries one, and says so",
    () => {
      const gh = fakeGh("token", 0);
      const result = preflight(request({ PATH: gh.path, GH_TOKEN: SENTINEL }, true));

      expect(result.github?.credential).toBe("GH_TOKEN");
      expect(result.findings.map((entry) => entry.reason)).not.toContain("gh_not_authenticated");
      expect(result.ok).toBe(true);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "falls back to `gh`'s stored login where no token is set",
    () => {
      const gh = fakeGh("login", 0);
      const result = preflight(request({ PATH: gh.path }, true));

      expect(result.github).toEqual({ credential: "gh_login", answers: true });
      expect(result.ok).toBe(true);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "asks `gh auth status` nothing on a run that does not publish and was not told to",
    () => {
      const gh = fakeGh("quiet", 0);
      const result = preflight(request({ PATH: gh.path }, false));

      expect(gh.calls()).toEqual(["--version"]);
      expect(result.github).toBeNull();
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "asks anyway when the caller wants the answer — which is what `doctor` is for",
    () => {
      const gh = fakeGh("probed", 0);
      const result = preflight(request({ PATH: gh.path }, false, true));

      expect(gh.calls()).toEqual(["--version", "auth status"]);
      expect(result.github).toEqual({ credential: "gh_login", answers: true });
    },
    SPAWN_DEADLINE_MS,
  );
});

describe("which variable names the token path", () => {
  it("counts GITHUB_TOKEN as the token path, since `gh` reads it after GH_TOKEN", () => {
    expect(githubCredential({ GITHUB_TOKEN: "x" })).toBe("GH_TOKEN");
    expect(githubCredential({ GH_TOKEN: "x" })).toBe("GH_TOKEN");
    expect(githubCredential({})).toBe("gh_login");
    expect(githubCredential({ GH_TOKEN: "" })).toBe("gh_login");
  });
});

describe("what the preflight block prints about it", () => {
  it(
    "names the path and whether it answers, and never the token",
    () => {
      const gh = fakeGh("render-token", 0);
      const rendered = renderPreflight(preflight(request({ PATH: gh.path, GH_TOKEN: SENTINEL }, true)));

      expect(rendered).toContain("GH_TOKEN");
      expect(rendered).toContain("answers");
      expect(rendered).not.toContain(SENTINEL);
      // Not even a prefix: a token's first characters identify the account it
      // belongs to, and a diagnostic is pasted into issues.
      expect(rendered).not.toContain(SENTINEL.slice(0, 8));
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "says so when nothing answers",
    () => {
      const gh = fakeGh("render-none", 1);
      const rendered = renderPreflight(preflight(request({ PATH: gh.path }, true)));

      expect(rendered).toContain("gh login");
      expect(rendered).toContain("gh is not logged in");
    },
    SPAWN_DEADLINE_MS,
  );
});

/**
 * SCP-200 criterion 3: an attempt cannot touch the machine's `gh` credential.
 *
 * `Bash(gh:*)` already refuses every `gh` an executor could reach, and it stays
 * — narrowing it to admit `gh auth status` would admit `gh pr merge` and `gh
 * api` with it. What the credential entries add is the thing the deny list
 * exists for: the refusal a person reads names the rule that made it, so
 * `denied` against `gh auth login` says which prohibition was hit rather than
 * only that the word was `gh`.
 */
describe("the write guard on the machine's gh credential", () => {
  const judge = (command: string) =>
    judgeCommand({
      tool: "Bash",
      detail: command,
      allow_list: DEFAULT_COMMAND_ALLOW_LIST,
      deny_list: DEFAULT_COMMAND_DENY_LIST,
      scope: { root: scratch, home: "/Users/nobody" },
    }).admission;

  const CREDENTIAL_COMMANDS: Array<[string, string]> = [
    ["gh auth login", "Bash(gh auth:*)"],
    ["gh auth logout", "Bash(gh auth:*)"],
    ["gh auth refresh", "Bash(gh auth:*)"],
    ["gh auth token", "Bash(gh auth:*)"],
    ["gh auth setup-git", "Bash(gh auth:*)"],
    ["gh config set editor vim", "Bash(gh config set:*)"],
    // The deny list is read against every command the resolver found the line
    // runs, so a wrapper in front of it changes nothing.
    ["env gh auth login", "Bash(gh auth:*)"],
    ["sh -c 'gh config set git_protocol ssh'", "Bash(gh config set:*)"],
  ];

  for (const [command, entry] of CREDENTIAL_COMMANDS) {
    it(`refuses \`${command}\` under ${entry}`, () => {
      const admission = judge(command);
      expect(admission.decision, command).toBe("denied");
      expect(admission.rule, command).toBe(ADMISSION_RULES.deny_list);
      expect(admission.reason ?? "", command).toContain(entry);
    });
  }

  it("keeps the blanket entry, so the rest of `gh` is refused too", () => {
    expect(DEFAULT_COMMAND_DENY_LIST as readonly string[]).toContain("Bash(gh:*)");
    for (const command of ["gh pr merge 1", "gh api /user", "gh auth status", "gh config get editor"]) {
      expect(judge(command).decision, command).toBe("denied");
    }
  });
});
