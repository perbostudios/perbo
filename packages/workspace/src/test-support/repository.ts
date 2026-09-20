import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

/** A throwaway repository with two commits and a gitignored `.env`. */
export function makeRepo(): { dir: string; head: string; first: string } {
  const dir = mkdtempSync(join(tmpdir(), "perbo-ws-"));
  git(dir, "init", "-q", "-b", "main");
  // Repository-local identity, so a fixture does not depend on the developer's
  // global Git configuration — and does not fail on a machine that signs
  // commits with a key this process cannot unlock.
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), ".env\n.env.*\ncerts/\nnode_modules/\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node -e 0" } }, null, 2));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  const first = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "src.ts"), "export const value = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "second");
  const head = git(dir, "rev-parse", "HEAD").trim();
  return { dir, head, first };
}

export { git };
