import { describe, expect, it } from "vitest";
import { PULL_REQUEST_TITLE_LIMIT, pullRequestTitle } from "./deliver.js";

describe("the pull request's title", () => {
  it("is the key and the outcome where the outcome is one sentence", () => {
    expect(pullRequestTitle("PRB-8", "The feature module exports a computed total")).toBe(
      "PRB-8: The feature module exports a computed total",
    );
  });

  it("is the key and the outcome's first whole sentence, never a sentence cut short", () => {
    const first = `New users receive an activation email within 60s of signup, ${"and the mailer retries a failed send, ".repeat(3)}logged once.`;
    expect(first.length).toBeGreaterThan(120);
    const outcome = `${first}\nThe retry is capped at v1.2's three attempts! Nothing else changes.`;
    expect(pullRequestTitle("PRB-8", outcome)).toBe(`PRB-8: ${first}`);
    expect(pullRequestTitle("PRB-8", "Is the total right? It is.")).toBe("PRB-8: Is the total right?");
  });

  it("is the key alone where the first sentence does not fit GitHub's limit", () => {
    const outcome = `The report lists ${"every open invoice, ".repeat(20)}by customer. Then it totals them.`;
    expect(`PRB-8: ${outcome.split(". ")[0]}.`.length).toBeGreaterThan(PULL_REQUEST_TITLE_LIMIT);
    expect(pullRequestTitle("PRB-8", outcome)).toBe("PRB-8");
    const fits = "x".repeat(PULL_REQUEST_TITLE_LIMIT - "PRB-8: ".length);
    expect(pullRequestTitle("PRB-8", fits)).toBe(`PRB-8: ${fits}`);
    expect(pullRequestTitle("PRB-8", fits + "x")).toBe("PRB-8");
  });
});
