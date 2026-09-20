import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlanningError } from "./errors.js";
import { fetchGitHubIssue, parseIssueReference } from "./issue.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-planning-issue-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in `gh` that records its argv and prints a fixed answer. */
function fakeGh(name: string, script: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("parseIssueReference", () => {
  it("reads owner/repo#N and nothing else", () => {
    expect(parseIssueReference("acme/widget-store#193")).toEqual({
      owner: "acme",
      repo: "widget-store",
      number: 193,
    });
    for (const bad of ["widget-store#193", "acme/widget-store", "AYO-1", "owner/repo#0", "a/b#1; rm"]) {
      expect(() => parseIssueReference(bad), bad).toThrow(PlanningError);
    }
  });
});

describe("fetchGitHubIssue", () => {
  it("asks gh for the issue by argv and validates what comes back", async () => {
    const argvFile = join(scratch, "argv.txt");
    const binary = fakeGh(
      "gh-ok",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\n` +
        `printf '%s' '{"title":"Users are not getting the email","body":"Steps: sign up.","url":"https://github.com/o/r/issues/412","number":412}'`,
    );
    const issue = await fetchGitHubIssue("o/r#412", { binary });
    expect(issue).toEqual({
      reference: "o/r#412",
      number: 412,
      title: "Users are not getting the email",
      body: "Steps: sign up.",
      url: "https://github.com/o/r/issues/412",
    });
    expect(readFileSync(argvFile, "utf8").trim().split("\n")).toEqual([
      "issue",
      "view",
      "412",
      "--repo",
      "o/r",
      "--json",
      "title,body,url,number",
    ]);
  });

  it("treats a null body as empty text", async () => {
    const binary = fakeGh(
      "gh-null-body",
      `printf '%s' '{"title":"t","body":null,"url":"https://github.com/o/r/issues/1","number":1}'`,
    );
    expect((await fetchGitHubIssue("o/r#1", { binary })).body).toBe("");
  });

  it("turns a gh failure into one sentence, not a stack", async () => {
    const binary = fakeGh("gh-fail", `echo 'GraphQL: Could not resolve to an Issue' >&2; exit 1`);
    await expect(fetchGitHubIssue("o/r#9", { binary })).rejects.toThrow(PlanningError);
    await expect(fetchGitHubIssue("o/r#9", { binary })).rejects.toThrow(
      /gh could not read o\/r#9: GraphQL: Could not resolve to an Issue/,
    );
  });

  it("refuses an answer that is not an issue", async () => {
    const binary = fakeGh("gh-junk", `printf '%s' '{"title":"","number":"x"}'`);
    await expect(fetchGitHubIssue("o/r#2", { binary })).rejects.toThrow(PlanningError);
  });
});

/**
 * `gh` runs in the runner's environment, not in this process's.
 *
 * Drafting is reached from the command line, where the person's own shell holds
 * whatever it holds. What `gh` needs from it — the host, the configuration
 * directory, the token — is named; the rest is not passed on, and a prompt is a
 * failure rather than a process waiting on a terminal nobody is watching.
 */
describe("the gh fetchGitHubIssue starts", () => {
  it.skipIf(process.platform === "win32")("runs with prompts off and no ambient secret", async () => {
    const dump = join(scratch, "issue-child-env.txt");
    const binary = fakeGh(
      "gh-env",
      `env > ${JSON.stringify(dump)}\n` +
        `printf '%s' '{"title":"t","body":"b","url":"https://github.com/o/r/issues/3","number":3}'`,
    );
    process.env.PERBO_SENTINEL_TOKEN = "a token the child must not see";
    try {
      expect((await fetchGitHubIssue("o/r#3", { binary })).number).toBe(3);
    } finally {
      delete process.env.PERBO_SENTINEL_TOKEN;
    }

    const child = readFileSync(dump, "utf8").split("\n");
    expect(child).toContain("GH_PROMPT_DISABLED=1");
    expect(child).toContain("GIT_TERMINAL_PROMPT=0");
    expect(child.filter((line) => line.startsWith("PERBO_SENTINEL_TOKEN="))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses an answer too large to hold, rather than reading the part that fits",
    async () => {
      // An issue body is what a spec is drafted from, so a body that arrived
      // cut is a spec missing requirements nobody knows are missing. The tail
      // `gh` leaves behind also still parses as nothing in particular, so the
      // refusal has to say what happened.
      const binary = fakeGh(
        "gh-flood",
        `printf '{"title":"t","body":"'\n` +
          `head -c 17000000 /dev/zero | tr '\\0' 'a'\n` +
          `printf '","url":"https://github.com/o/r/issues/4","number":4}'`,
      );
      await expect(fetchGitHubIssue("o/r#4", { binary })).rejects.toThrow(
        /gh's answer for o\/r#4 is larger than .*only part of it/,
      );
    },
    60_000,
  );
});
