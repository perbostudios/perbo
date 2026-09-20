import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/test-support/paths.js";

/**
 * The documents that state what a plan is, against what a plan now is.
 *
 * A contradiction between a document and the code is a defect, and the one this
 * guards is specific: every canonical page promised a flat contract of two to
 * four criteria, and a plan may now group as many as the work has into nodes.
 * Read rather than validated structurally, because `validate_docs.py` checks
 * links and lifecycle agreement and passes happily on two pages asserting
 * opposite things.
 */

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("the documents that say what a plan is", () => {
  it("documents the node and approach fields in docs/04", () => {
    const doc = read("docs/04-ticket-workspace-and-review.md");
    for (const promised of [
      "`nodes`",
      "`requirement_id`",
      "<KEY>.approach.json",
      "The approach record",
      "--from-spec",
      "--graph-edit",
      "--undo",
    ]) {
      expect(doc).toContain(promised);
    }
    // The approach is the half review never receives, and the page says so.
    expect(doc).toContain("The reviewer never receives it");
  });

  it("no longer says the approach is never written down", () => {
    // Most of the approach still is not: steps, notes and discovered work are
    // the executor's. The order between nodes and the spec's No-Gos are the
    // part that is, and a page saying otherwise contradicts the store.
    for (const path of [
      "docs/03-domain-and-event-model.md",
      "docs/04-ticket-workspace-and-review.md",
      "docs/adr/0016-minimal-machine-maintained-planning.md",
    ]) {
      const doc = read(path);
      for (const stale of [
        'There is no separate "approach" document',
        "the approach, which the executor owns and nobody writes down",
      ]) {
        expect(`${path}: ${doc.includes(stale)}`).toBe(`${path}: false`);
      }
    }
  });

  it("promises no maximum number of criteria anywhere it used to", () => {
    for (const path of [
      "README.md",
      "apps/cli/README.md",
      "packages/planning/README.md",
      "docs/02-system-architecture.md",
      "docs/03-domain-and-event-model.md",
      "docs/04-ticket-workspace-and-review.md",
      "docs/05-component-specifications.md",
      "docs/15-product-experience-and-onboarding.md",
      "docs/11-open-decisions.md",
    ]) {
      // Whatever the line breaks and the case: a promise wrapped across two
      // lines or written with a capital is still the promise.
      const doc = read(path).replace(/\s+/g, " ").toLowerCase();
      for (const promise of [
        "two to four criteria",
        "two to four acceptance_criteria",
        "two to four acceptance criteria",
        "up to four criteria",
      ]) {
        expect(`${path}: ${doc.includes(promise)}`).toBe(`${path}: false`);
      }
    }
  });

  it("states what is built about the graph rather than that it is not", () => {
    const decisions = read("docs/11-open-decisions.md");
    const d100 = decisions.slice(
      decisions.indexOf("### D-100"),
      decisions.indexOf("### D-101"),
    );
    expect(d100).not.toContain("Decided, not built");
    expect(d100).not.toContain("a flat list of two to four criteria");

    const adr = read("docs/adr/0037-execution-graph.md");
    expect(adr).not.toContain("not built");
    expect(read("docs/adr/0016-minimal-machine-maintained-planning.md")).not.toContain(
      "This is decided, not built.",
    );
    expect(read("docs/planning-mode-and-execution-graphs.md")).not.toContain(
      "None of it is built yet",
    );
  });
});

describe("the command's own help", () => {
  it("names every flag the graph work added", () => {
    const help = read("apps/cli/src/command-line/usage.ts");
    for (const flag of ["--from-spec", "--graph-edit", "--undo", "--author"]) {
      expect(help).toContain(flag);
    }
  });

  it("says what admitting a spec puts on the ticket's branch", () => {
    const help = read("apps/cli/src/command-line/usage.ts");
    expect(help).toContain("the loop commits");
    expect(help).toContain("of its own under the spec folder");
  });
});
