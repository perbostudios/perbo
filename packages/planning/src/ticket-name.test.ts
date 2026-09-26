import { describe, expect, it } from "vitest";
import { keptTitleRefusal, ticketName, type TicketNaming } from "./ticket-name.js";

// D-127: a ticket's name is never over 60 characters, and never a cut.
const LONG_TITLE = "Activation email " + "and its retries ".repeat(36) + "x".repeat(7);
const LONG_SENTENCE = "New users receive an activation email " + "and a reminder ".repeat(37) + "anyway.";
const FULL = "Activation email retries " + "y".repeat(35);

const naming = (over: Partial<TicketNaming>): TicketNaming => ({
  drafted: "",
  specTitle: "",
  outcome: LONG_SENTENCE,
  taken: [],
  key: "PRB-7",
  keepTitle: false,
  ...over,
});

describe("ticketName", () => {
  it("uses six-hundred-character stand-ins and a sixty-character name", () => {
    expect(LONG_TITLE).toHaveLength(600);
    expect(LONG_SENTENCE).toHaveLength(600);
    expect(FULL).toHaveLength(60);
  });

  it("is the drafted name where no other ticket carries it", () => {
    expect(ticketName(naming({ drafted: "Activation email", specTitle: "Emails" }))).toBe("Activation email");
  });

  it("passes over a taken drafted name for the spec's title, ignoring case and spacing", () => {
    expect(
      ticketName(naming({ drafted: "Activation email", specTitle: "Emails", taken: ["activation  EMAIL"] })),
    ).toBe("Emails");
  });

  it("passes over a spec title past the cap for the outcome's first sentence", () => {
    expect(
      ticketName(naming({ specTitle: LONG_TITLE, outcome: `Activation emails are retried. ${LONG_SENTENCE}` })),
    ).toBe("Activation emails are retried.");
  });

  it("numbers the first candidate that fits, past a number another ticket carries", () => {
    expect(
      ticketName(
        naming({
          drafted: "Activation email retries",
          specTitle: LONG_TITLE,
          taken: ["Activation email retries", "activation email retries 2"],
        }),
      ),
    ).toBe("Activation email retries 3");
  });

  it("numbers a typed ticket's first sentence where another ticket carries it", () => {
    expect(
      ticketName(naming({ outcome: "Activation emails are retried. Twice.", taken: ["Activation emails are retried."] })),
    ).toBe("Activation emails are retried. 2");
  });

  it("numbers the next candidate where the first has no room for a number", () => {
    expect(ticketName(naming({ drafted: FULL, specTitle: "Activation email", taken: [FULL, "Activation email"] }))).toBe(
      "Activation email 2",
    );
  });

  it("is the key where every candidate is past the cap or taken with no room for a number", () => {
    expect(ticketName(naming({ drafted: FULL, specTitle: LONG_TITLE, taken: [FULL] }))).toBe("PRB-7");
    expect(ticketName(naming({}))).toBe("PRB-7");
  });

  it("keeps a person's title as it stands, whatever was drafted and whatever is taken", () => {
    expect(
      ticketName(naming({ keepTitle: true, drafted: "Activation email", specTitle: "Emails  retried", taken: ["Emails retried"] })),
    ).toBe("Emails retried");
  });

  it("names a ticket whose spec has no title as any other, with keepTitle", () => {
    expect(ticketName(naming({ keepTitle: true, drafted: "Activation email" }))).toBe("Activation email");
  });

  it("refuses a kept title past the cap rather than cutting it", () => {
    expect(() => ticketName(naming({ keepTitle: true, specTitle: LONG_TITLE }))).toThrow(
      "the spec's title is 600 characters, and a ticket's name is at most 60 (D-127): shorten the title, then draft the plan again",
    );
  });
});

describe("keptTitleRefusal", () => {
  it("refuses a title one past the cap and keeps one at it", () => {
    expect(keptTitleRefusal(FULL + "z")).toBe(
      "the spec's title is 61 characters, and a ticket's name is at most 60 (D-127): shorten the title, then draft the plan again",
    );
    expect(keptTitleRefusal(FULL)).toBeNull();
  });
});
