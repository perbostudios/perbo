import { describe, expect, it } from "vitest";
import { TicketRunConfigSchema } from "./index.js";

/**
 * Which of the three sources named the base a run publishes against.
 *
 * The field is read by the CLI to say, before the loop starts, where the base
 * came from. It is part of a strict schema, so every value that has ever been
 * written into a run configuration has to keep parsing: `checkout` was what
 * `branch` was called before the remote's default branch became the third
 * source, and a configuration carrying it is read rather than refused.
 */

/** The narrowest configuration the schema accepts, plus the field under test. */
const parse = (origin: unknown) =>
  TicketRunConfigSchema.parse({
    ticket_key: "AYO81",
    repository_root: "/repo",
    base_ref: "main",
    worktree_root: "/w",
    bundle_root: "/b",
    quarantine_root: "/q",
    state_root: "/s",
    ...(origin === undefined ? {} : { base_ref_origin: origin }),
  });

describe("base_ref_origin", () => {
  it("takes each of the three sources, and nothing that is not one", () => {
    expect(parse("branch").base_ref_origin).toBe("branch");
    expect(parse("config").base_ref_origin).toBe("config");
    expect(parse("remote_default").base_ref_origin).toBe("remote_default");
    expect(() => parse("origin")).toThrow();
    expect(() => parse("")).toThrow();
  });

  it("says nothing where the caller did not: null, and no default source", () => {
    expect(parse(undefined).base_ref_origin).toBeNull();
    expect(parse(null).base_ref_origin).toBeNull();
  });

  it("reads a configuration written when the branch source was called checkout", () => {
    // The rename is not a redefinition: the value meant the branch this
    // checkout is on then, and that is the source it names now. A run
    // configuration carrying it parses and reports `branch`.
    expect(parse("checkout").base_ref_origin).toBe("branch");
  });
});
