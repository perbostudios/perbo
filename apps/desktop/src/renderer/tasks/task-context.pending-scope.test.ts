import { describe, expect, it } from "vitest";
import { pendingScope } from "./task-context.js";
import type { OpenDraft } from "../../shared/protocol.js";

/**
 * The interlock between a saved session's scope and the contract's.
 *
 * A mark made in the Explorer writes the session's draft and reaches the
 * contract only through a compile, while approval freezes the contract and
 * sends the contract file's digest — which a mark never changes. So the freeze
 * would pass and leave the marks behind, and nothing would have said so. This
 * is what the contract page asks before it offers to approve.
 */
const draft = (scope: { paths: string[]; prohibited: string[] }, over: Partial<OpenDraft> = {}): OpenDraft => ({
  id: "session-1",
  repoId: "repo-1",
  key: "PRB-1",
  admitted: true,
  outcome: "Something is true.",
  specSlug: null,
  phase: "editing",
  nodes: 0,
  drift: null,
  lastPane: null,
  lastView: null,
  title: null,
  scope,
  ...over,
});
const contract = (paths_allowed: string[], paths_prohibited: string[] = []) => ({
  paths_allowed,
  paths_prohibited,
});

describe("the scope a session holds that the contract does not", () => {
  it("is nothing when the two agree", () => {
    const held = draft({ paths: ["src/**"], prohibited: ["src/gen/**"] });
    expect(pendingScope([held], "repo-1", "PRB-1", contract(["src/**"], ["src/gen/**"]))).toBeNull();
  });

  it("is nothing when they agree but were written in another order", () => {
    const held = draft({ paths: ["b/**", "a/**"], prohibited: [] });
    expect(pendingScope([held], "repo-1", "PRB-1", contract(["a/**", "b/**"]))).toBeNull();
  });

  it("is the session's scope when a path was allowed and not yet compiled", () => {
    const held = draft({ paths: ["src/**", "docs/**"], prohibited: [] });
    expect(pendingScope([held], "repo-1", "PRB-1", contract(["src/**"]))).toEqual({
      allowed: ["src/**", "docs/**"],
      prohibited: [],
    });
  });

  // The case the CLI could not express until `--no-prohibit`: taking the last
  // prohibition back is a difference like any other, and must be seen as one.
  it("is the session's scope when the last prohibition was taken back", () => {
    const held = draft({ paths: ["src/**"], prohibited: [] });
    expect(pendingScope([held], "repo-1", "PRB-1", contract(["src/**"], ["src/gen/**"]))).toEqual({
      allowed: ["src/**"],
      prohibited: [],
    });
  });

  it("is nothing for a ticket no session holds, which is every ticket the CLI admitted", () => {
    expect(pendingScope([], "repo-1", "PRB-1", contract(["src/**"]))).toBeNull();
    expect(pendingScope(undefined, "repo-1", "PRB-1", contract(["src/**"]))).toBeNull();
  });

  it("ignores a session for another ticket, another repository, or one thrown away", () => {
    const held = draft({ paths: ["other/**"], prohibited: [] });
    expect(pendingScope([{ ...held, key: "PRB-2" }], "repo-1", "PRB-1", contract(["src/**"]))).toBeNull();
    expect(pendingScope([{ ...held, repoId: "repo-2" }], "repo-1", "PRB-1", contract(["src/**"]))).toBeNull();
    expect(
      pendingScope([{ ...held, phase: "discarded" }], "repo-1", "PRB-1", contract(["src/**"])),
    ).toBeNull();
  });
});
