import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlanningError, fetchGitHubIssue, parseIssueReference } from "../src/index.js";

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
    const { readFileSync } = await import("node:fs");
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
