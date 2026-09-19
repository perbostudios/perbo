import { describe, expect, it } from "vitest";
import { gitEnv } from "../src/worktree.js";

/**
 * What the runner's Git and `gh` are given.
 *
 * On POSIX `gh` keeps its host credential under `HOME` or `XDG_CONFIG_HOME`; on
 * Windows it keeps it in `%AppData%\GitHub CLI\hosts.yml`, so `APPDATA` is
 * forwarded, with `LOCALAPPDATA` and `USERPROFILE`. Without them the runner's
 * `gh` reports "You are not logged into any GitHub hosts" on a machine whose
 * own `gh auth status` answers, and a finished attempt fails at `gh pr create`.
 *
 * These name directories rather than carry secrets, and this is the runner's
 * environment: the one that performs the commit, the push and the pull request.
 * The agent's environment is built elsewhere and is not widened by any of this.
 */

const BASE = {
  PATH: "/usr/bin",
  APPDATA: "C:\\Users\\a\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
  USERPROFILE: "C:\\Users\\a",
  SSH_AUTH_SOCK: "/tmp/ssh",
};

describe("the environment the runner's git and gh run in", () => {
  it("forwards where Windows keeps a credential and a global config", () => {
    const env = gitEnv(BASE);
    expect(env.APPDATA).toBe("C:\\Users\\a\\AppData\\Roaming");
    expect(env.LOCALAPPDATA).toBe("C:\\Users\\a\\AppData\\Local");
    expect(env.USERPROFILE).toBe("C:\\Users\\a");
  });

  it("forwards the variables POSIX needs beside them", () => {
    const env = gitEnv(BASE);
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("carries nothing that was not named", () => {
    // The list is an allow-list, and stays one: a credential the runner holds
    // in its own environment must not reach a child merely by being present.
    const env = gitEnv({ ...BASE, NPM_TOKEN: "secret", AWS_PROFILE: "prod" });
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
  });

  it("omits a name the host does not set, rather than emptying it", () => {
    // On POSIX there is no APPDATA. An empty string is a value, and `gh` would
    // read it as a configuration directory at the filesystem root.
    const env = gitEnv({ PATH: "/usr/bin" });
    expect("APPDATA" in env).toBe(false);
    expect("LOCALAPPDATA" in env).toBe(false);
    expect("USERPROFILE" in env).toBe(false);
  });
});
