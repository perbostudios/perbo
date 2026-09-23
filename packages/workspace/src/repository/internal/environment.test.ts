import { describe, expect, it } from "vitest";
import { ghEnv, gitEnv, githubCredentialOverlay } from "./environment.js";

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
    // read it as a configuration directory at the filesystem root; Git for
    // Windows reads an empty HOME as a home and stops looking at USERPROFILE.
    const env = gitEnv({ PATH: "/usr/bin" });
    expect("APPDATA" in env).toBe(false);
    expect("LOCALAPPDATA" in env).toBe(false);
    expect("USERPROFILE" in env).toBe(false);
    expect("HOME" in env).toBe(false);
    expect(gitEnv({ PATH: "/usr/bin", HOME: "/home/x" }).HOME).toBe("/home/x");
  });

  it("hands git no GitHub token of its own; the overlay does that where a remote is GitHub", () => {
    const env = gitEnv({ ...BASE, GH_TOKEN: "ghp_0123456789abcdefghij", GITHUB_TOKEN: "ghp_0123456789abcdefghik" });
    expect("GH_TOKEN" in env).toBe(false);
    expect("GITHUB_TOKEN" in env).toBe(false);
    expect(githubCredentialOverlay({ GH_TOKEN: "ghp_0123456789abcdefghij" })).toEqual({
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: "ghp_0123456789abcdefghij",
    });
    expect(githubCredentialOverlay({ PATH: "/usr/bin" })).toEqual({ GH_PROMPT_DISABLED: "1" });
  });

  it("forwards what Windows needs to run git and gpg at all", () => {
    const env = gitEnv({ ...BASE, SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", TMP: "C:\\Temp" });
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.TMP).toBe("C:\\Temp");
  });

  it("forwards how this machine reaches the network, in both spellings", () => {
    const env = gitEnv({
      ...BASE,
      HTTPS_PROXY: "http://proxy:3128",
      no_proxy: "github.example",
      SSL_CERT_FILE: "/etc/ssl/corp.pem",
      GIT_SSL_CAINFO: "/etc/ssl/corp.pem",
    });
    expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(env.no_proxy).toBe("github.example");
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/corp.pem");
    expect(env.GIT_SSL_CAINFO).toBe("/etc/ssl/corp.pem");
  });

  it("refuses an interactive credential helper as well as a terminal prompt", () => {
    // Git Credential Manager answers to neither the terminal nor
    // `GIT_TERMINAL_PROMPT`: without this it opens a window, and a run with
    // nobody watching waits for it until the timeout.
    const env = gitEnv(BASE);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
  });

  it("does not let the ambient environment choose a command git runs", () => {
    // `GIT_SSH_COMMAND` and `GIT_EXTERNAL_DIFF` are command lines. The person's
    // own is already reachable through their config files, which are
    // forwarded; an environment variable is not the route (ADR-0023 §4).
    const env = gitEnv({ ...BASE, GIT_SSH_COMMAND: "ssh -v", GIT_EXTERNAL_DIFF: "difftool" });
    expect("GIT_SSH_COMMAND" in env).toBe(false);
    expect("GIT_EXTERNAL_DIFF" in env).toBe(false);
  });
});

describe("the environment gh runs in, beside git's", () => {
  it("refuses a prompt and carries the credential the runner holds", () => {
    const env = ghEnv({ ...BASE, GH_TOKEN: "tok", GH_CONFIG_DIR: "/cfg", GH_HOST: "github.example" });
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(env.GH_TOKEN).toBe("tok");
    expect(env.GH_CONFIG_DIR).toBe("/cfg");
    expect(env.GH_HOST).toBe("github.example");
    // Everything git is given, because `gh` shells out to it.
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh");
  });

  it("carries the token a GitHub Enterprise host authenticates with", () => {
    // A person on an enterprise host has no `GH_TOKEN` at all, and without this
    // `gh` is logged into nothing.
    const env = ghEnv({ ...BASE, GH_ENTERPRISE_TOKEN: "ent" });
    expect(env.GH_ENTERPRISE_TOKEN).toBe("ent");
    expect("GH_TOKEN" in env).toBe(false);
  });

  it("carries nothing that was not named, tokens included", () => {
    const env = ghEnv({ ...BASE, NPM_TOKEN: "secret", GH_FORCE_TTY: "100%" });
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.GH_FORCE_TTY).toBeUndefined();
  });
});
