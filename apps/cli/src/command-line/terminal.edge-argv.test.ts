import { describe, expect, it } from "vitest";
import { approveCommandLine, listCommandLine, parseAdmitArgs, parseListArgs } from "../commands/admit.js";
import { parseEditArgs } from "../commands/edit/index.js";
import { parseInspectArgs } from "../commands/inspect.js";
import { parseInterviewArgs } from "../commands/interview/index.js";
import { parsePrincipleArgs } from "../commands/principle.js";
import { parseReviewArgs } from "../commands/review/index.js";
import { parseExecuteArgs } from "../commands/run/index.js";
import { parseIndexArgs } from "../commands/symbol-index.js";
import { parseVerdictArgs } from "../commands/verdict/index.js";

/**
 * Every command line built outside this package, and the input each one means.
 *
 * Three callers spawn the binary rather than importing it: the desktop host,
 * which builds one argv per request and appends `--repo <registered path>`
 * last; `perbo serve`, which starts a child `perbo run` and asks `perbo sync`
 * in process; and the corpus harness, which runs `perbo review`. None of them
 * can be changed from here, so what each line means is pinned here: a change
 * to how a line is read that changes one of these has broken a caller, and
 * says so before it ships rather than in the product.
 *
 * The values are ordinary ones. What a command makes of a *hostile* value —
 * one shaped like a flag — is `terminal.flag-injection.test.ts`.
 */

const REPO = "/Users/someone/Code/project";
const KEY = "PRB-7";

describe("the desktop host", () => {
  it("reads doctor's configuration and the write it may ask for", () => {
    // ["doctor", "--json", "--config", <path>] + --write-config, then --repo.
    const args = parseExecuteArgs(["--json", "--config", "/tmp/c.json", "--repo", REPO]);
    expect(args).toMatchObject({ json: true, config: "/tmp/c.json", repo: REPO, writeConfig: false });
    expect(
      parseExecuteArgs(["--json", "--config", "/tmp/c.json", "--write-config", "--repo", REPO])
        .writeConfig,
    ).toBe(true);
  });

  it("reads a run, with and without the bundle it resumes from", () => {
    expect(
      parseExecuteArgs(["--ticket", KEY, "--config", "/tmp/c.json", "--json", "--repo", REPO]),
    ).toMatchObject({ ticket: KEY, config: "/tmp/c.json", json: true, repo: REPO, resumeFrom: null });
    expect(
      parseExecuteArgs([
        "--ticket",
        KEY,
        "--config",
        "/tmp/c.json",
        "--json",
        "--resume-from",
        "bun_01",
        "--repo",
        REPO,
      ]).resumeFrom,
    ).toBe("bun_01");
  });

  it("reads a typed admission, criteria and scope in the order they were given", () => {
    const args = parseAdmitArgs([
      "--prefix",
      "PRB",
      "--outcome",
      "Search results paginate",
      "--criterion",
      "a page holds 20 :: a unit test asserts it :: test",
      "--criterion",
      "the last page is short :: a unit test asserts it :: test",
      "--path",
      "src/search/**",
      "--prohibit",
      "src/billing/**",
      "--json",
      "--repo",
      REPO,
    ]);
    expect(args).toMatchObject({ prefix: "PRB", title: "Search results paginate", json: true, repo: REPO });
    expect(args.criteria).toEqual([
      "a page holds 20 :: a unit test asserts it :: test",
      "the last page is short :: a unit test asserts it :: test",
    ]);
    expect(args.paths).toEqual(["src/search/**"]);
    expect(args.prohibited.at(-1)).toBe("src/billing/**");
    expect(args.approve).toBe(false);
  });

  it("reads a drafting admission from a spec and from a file", () => {
    expect(
      parseAdmitArgs([
        "--prefix",
        "PRB",
        "--from-spec",
        "specs/paginate-search/spec.md",
        "--start-over",
        KEY,
        "--provider",
        "claude-cli",
        "--model",
        "claude-opus-5",
        "--json",
        "--repo",
        REPO,
      ]),
    ).toMatchObject({
      fromSpec: "specs/paginate-search/spec.md",
      startOver: KEY,
      provider: "claude-cli",
      model: "claude-opus-5",
      approve: false,
    });
    expect(
      parseAdmitArgs([
        "--prefix",
        "PRB",
        "--from-file",
        "/tmp/issue.md",
        "--provider",
        "codex-cli",
        "--model",
        "gpt-5-codex",
        "--json",
        "--repo",
        REPO,
      ]),
    ).toMatchObject({ fromFile: "/tmp/issue.md", provider: "codex-cli", approve: false });
  });

  it("reads an edit of the contract and of the graph, and an undo", () => {
    const typed = parseEditArgs([
      KEY,
      "--outcome",
      "Search results paginate",
      "--criterion",
      "a page holds 20 :: a unit test asserts it :: test",
      "--path",
      "src/search/**",
      "--prohibit",
      "src/billing/**",
      "--json",
      "--repo",
      REPO,
    ]);
    expect(typed.key).toBe(KEY);
    expect(typed.args).toMatchObject({ outcome: "Search results paginate", json: true, repo: REPO });

    const graph = parseEditArgs([
      KEY,
      "--graph-edit",
      '{"kind":"add_node","node":{"id":"n1"}}',
      "--author",
      "you",
      "--json",
      "--repo",
      REPO,
    ]);
    expect(graph.args).toMatchObject({
      graphEdit: '{"kind":"add_node","node":{"id":"n1"}}',
      author: "you",
      json: true,
    });
    expect(
      parseEditArgs([KEY, "--undo", "2", "--author", "you", "--json", "--repo", REPO]).args.undo,
    ).toBe(2);
  });

  it("reads an approval as the key and the flags after it", () => {
    expect(approveCommandLine.read([KEY, "--json", "--repo", REPO])).toEqual({
      input: { target: { repo: REPO, store: null }, key: KEY },
      output: { json: true },
    });
  });

  it("reads a recorded principle as its one argument", () => {
    expect(parsePrincipleArgs(["add", "Prefer a refusal to a guess", "--repo", REPO])).toEqual({
      action: "add",
      text: "Prefer a refusal to a guess",
      repo: REPO,
      store: null,
    });
  });

  it("reads a sync as the key and the flags after it", () => {
    // ["sync", <key>] + --repo: the key is argv[0] and the rest is read for
    // the repository, as it is for approve.
    expect(parseListArgs(["--repo", REPO])).toMatchObject({ repo: REPO, store: null });
  });

  it("reads a verdict's decision, finding, note and author", () => {
    const args = parseVerdictArgs([
      KEY,
      "--endorse",
      "src/search/page.ts#paginate",
      "--note",
      "Agreed: the bound is the page size.",
      "--author",
      "Local user",
      "--json",
      "--repo",
      REPO,
    ]);
    expect(args.list).toBe(false);
    expect(args).toMatchObject({ reference: KEY, json: true, repo: REPO });
    if (args.list) throw new Error("unreachable");
    expect(args).toMatchObject({
      decision: "endorse",
      key: "src/search/page.ts#paginate",
      note: "Agreed: the bound is the page size.",
      author: "Local user",
    });
  });

  it("reads the symbol index, the listing and one ticket", () => {
    expect(parseIndexArgs(["--json", "--repo", REPO])).toEqual({ json: true, repo: REPO });
    expect(listCommandLine.read(["--all", "--json", "--repo", REPO])).toEqual({
      input: { target: { repo: REPO, store: null }, all: true },
      output: { json: true },
    });
    expect(parseInspectArgs([KEY, "--json", "--repo", REPO])).toEqual({
      key: KEY,
      attempt: null,
      verify: null,
      json: true,
      repo: REPO,
      store: null,
    });
  });

  it("reads an interview, with and without the session it continues", () => {
    expect(
      parseInterviewArgs([
        "--spec",
        "specs/paginate-search",
        "--model",
        "claude-opus-5",
        "--provider",
        "claude",
        "--repo",
        REPO,
      ]),
    ).toEqual({
      repo: REPO,
      store: null,
      spec: "specs/paginate-search",
      session: null,
      model: "claude-opus-5",
      provider: "claude",
    });
    expect(
      parseInterviewArgs([
        "--spec",
        "specs/paginate-search",
        "--session",
        "sess_01",
        "--model",
        "gpt-5-codex",
        "--provider",
        "codex",
        "--repo",
        REPO,
      ]),
    ).toMatchObject({ session: "sess_01", provider: "codex" });
  });
});

describe("the queue", () => {
  it("reads the run it starts and the re-level it asks for", () => {
    expect(
      parseExecuteArgs(["--ticket", KEY, "--repo", ".", "--store", "/tmp/.perbo", "--publish"]),
    ).toMatchObject({ ticket: KEY, repo: ".", store: "/tmp/.perbo", publish: true, relevel: false });
    expect(
      parseExecuteArgs([
        "--ticket",
        KEY,
        "--relevel",
        "--repo",
        ".",
        "--store",
        "/tmp/.perbo",
        "--publish",
      ]),
    ).toMatchObject({ relevel: true, publish: true });
  });

  it("reads the sync it asks for, with and without the merge", () => {
    // [<key>, "--repo", …, "--store", …] and the same with "--merge".
    expect(parseListArgs(["--repo", ".", "--store", "/tmp/.perbo"])).toMatchObject({
      repo: ".",
      store: "/tmp/.perbo",
    });
  });
});

describe("the corpus harness", () => {
  it("reads the review it runs each fixture through", () => {
    const args = parseReviewArgs([
      "--contract",
      "/corpus/f1/contract.json",
      "--diff",
      "/corpus/f1/change.diff",
      "--checks",
      "/corpus/f1/checks.json",
      "--repo",
      "/corpus/f1/repo",
      "--json",
      "--quiet",
      "--state",
      "/tmp/perbo-corpus-state",
      "--model",
      "claude-opus-5",
      "--provider",
      "anthropic",
      "--raw-artifact",
      "/tmp/raw/f1.0.json",
    ]);
    expect(args).toMatchObject({
      contract: "/corpus/f1/contract.json",
      diff: "/corpus/f1/change.diff",
      checks: "/corpus/f1/checks.json",
      repo: "/corpus/f1/repo",
      json: true,
      quiet: true,
      state: "/tmp/perbo-corpus-state",
      model: "claude-opus-5",
      provider: "anthropic",
      rawArtifact: "/tmp/raw/f1.0.json",
    });
  });

  it("reads a diff piped on standard input as the stream it is", () => {
    expect(
      parseReviewArgs(["--contract", "/c.json", "--diff", "-", "--checks", "/k.json"]).diff,
    ).toBe("-");
  });
});
