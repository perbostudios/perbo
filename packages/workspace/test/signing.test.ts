import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnose } from "../src/diagnostic.js";
import { git, makeRepo } from "./support.js";

/**
 * A repository whose git configuration signs commits, diagnosed before an
 * attempt rather than at the commit that seals one.
 *
 * A developer's global configuration commonly carries `commit.gpgsign true`
 * with a key that lives behind a passphrase. Nothing in an attempt asks that
 * key to sign until the seal, which is after the agent has run and been paid
 * for — so this is the fact that has to be stated first.
 *
 * The fixtures generate their own keys and set the signing configuration in the
 * repository's own config, and each runs with `SSH_AUTH_SOCK` unset and the
 * global configuration pointed at `/dev/null`, so what is measured is the
 * fixture rather than the machine the suite happens to run on.
 *
 * Nothing here imports a symbol the change adds: each test fails on the
 * diagnostic's answer rather than on an import.
 */

const scratch = () => mkdtempSync(join(tmpdir(), "perbo-signing-"));

/** A key pair, locked behind `passphrase` where one is given. */
function keypair(name: string, passphrase: string): { pub: string; secret: string } {
  const secret = join(scratch(), name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", name, "-f", secret], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  return { pub: `${secret}.pub`, secret };
}

/** A repository that signs its commits with `pub`, and is otherwise well formed. */
function signsWith(pub: string): string {
  const repo = makeRepo();
  git(repo.dir, "config", "commit.gpgsign", "true");
  git(repo.dir, "config", "gpg.format", "ssh");
  git(repo.dir, "config", "user.signingkey", pub);
  return repo.dir;
}

/**
 * The diagnostic reads the environment this process is in, so the machine's own
 * agent and global configuration are taken out of it for the duration.
 */
const CLEARED = ["SSH_AUTH_SOCK", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;
const held = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of CLEARED) held.set(name, process.env[name]);
  delete process.env["SSH_AUTH_SOCK"];
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
});

afterEach(() => {
  for (const name of CLEARED) {
    const value = held.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const SIGNING = "commit_signing_unavailable";

describe("a repository whose configuration signs commits", () => {
  it("refuses it where the key cannot sign, quoting what the signer said", async () => {
    const key = keypair("locked", "a-passphrase-no-agent-holds");
    const repo = signsWith(key.pub);

    const result = await diagnose({ checkout: repo, repository_id: "repo_fixture" });

    const finding = result.findings.find((candidate) => candidate.reason === SIGNING);
    expect(finding, `findings were ${result.findings.map((f) => f.reason).join(", ")}`).toBeDefined();
    // A refusal, not a note: the attempt must not start.
    expect(finding?.severity).toBe("refusal");
    expect(result.materializable).toBe(false);

    // The signer's own words, which are the only thing that says which key and
    // what was wrong with it.
    expect(finding?.detail).toMatch(/incorrect passphrase/i);
    expect(finding?.detail).toContain(key.secret);

    // Both ways out, named.
    expect(finding?.detail).toContain("ssh-add");
    expect(finding?.detail).toContain("commit.gpgsign false");
  }, 60_000);

  it("says nothing where the key signs, and leaves the repository as it found it", async () => {
    const key = keypair("open", "");
    const repo = signsWith(key.pub);
    const before = git(repo, "fsck", "--no-progress", "--unreachable", "--dangling");

    const result = await diagnose({ checkout: repo, repository_id: "repo_fixture" });

    expect(result.findings.map((finding) => finding.reason)).toEqual([]);
    expect(result.materializable).toBe(true);
    // The probe signs, so it makes a commit object; it must not make one here.
    expect(git(repo, "fsck", "--no-progress", "--unreachable", "--dangling")).toBe(before);
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("says nothing about a repository that does not sign", async () => {
    // `makeRepo` sets `commit.gpgsign false`, which is the ordinary case.
    const repo = makeRepo();

    const result = await diagnose({ checkout: repo.dir, repository_id: "repo_fixture" });

    expect(result.findings.map((finding) => finding.reason)).toEqual([]);
    expect(result.materializable).toBe(true);
  }, 60_000);
});
