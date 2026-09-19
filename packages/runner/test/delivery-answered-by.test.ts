import { describe, expect, it } from "vitest";
import { parseStopAnswers } from "../src/delivery.js";

/**
 * Who ticked, read off the body (D-058).
 *
 * A person clicking a box in the GitHub UI leaves an unsigned tick — the UI
 * writes nothing else — and the AI stand-in answers by editing the body through
 * `gh` and signs the line it ticked. That signature is the only thing that can
 * tell the two apart afterwards. What is read here is what the body says, so an
 * unsigned tick carries no `answered_by` at all rather than one reading `null`:
 * the body said nothing, and the field is absent for exactly that reason.
 * `reconcileStopVerdicts` is where an answer nothing signed is recorded as a
 * person's, once, instead of that judgement being made twice.
 *
 * The body is untrusted text, so what it is allowed to do is bounded: the
 * signature can take a stop out of the partner reading and can never put one
 * in, and nothing outside a task-list line carrying a stop marker is read at
 * all.
 */

const key = (c: string) => c.repeat(64);
const marker = (k: string, answer: "endorse" | "override") =>
  `<!-- perbo:stop key=${k} answer=${answer} rule=auth.token_never_expires routing=blocks -->`;
const SIGNED = "<!-- perbo:answered-by who=stand_in -->";

/** The two boxes of one stop, ticked and signed as each argument says. */
const boxes = (
  k: string,
  endorse: { ticked: boolean; sign?: string },
  override: { ticked: boolean; sign?: string } = { ticked: false },
): string =>
  [
    `  - [${endorse.ticked ? "x" : " "}] I wanted to be asked before this was fixed ${marker(k, "endorse")}${
      endorse.sign ? ` ${endorse.sign}` : ""
    }`,
    `  - [${override.ticked ? "x" : " "}] The agent should have fixed this on its own ${marker(k, "override")}${
      override.sign ? ` ${override.sign}` : ""
    }`,
  ].join("\n");

describe("the answerer a pull-request body reports", () => {
  it("is the stand-in on a signed tick and nobody on an unsigned one", () => {
    const body = [boxes(key("a"), { ticked: true, sign: SIGNED }), boxes(key("b"), { ticked: true })].join("\n");
    const [signed, unsigned] = parseStopAnswers(body);
    expect(signed).toEqual({
      finding_key: key("a"),
      rule_id: "auth.token_never_expires",
      routing: "blocks",
      answer: "endorse",
      answered_by: "stand_in",
    });
    // Deep equality against an object with no `answered_by` at all: the entry
    // does not carry the field, rather than carrying it empty.
    expect(unsigned).toEqual({
      finding_key: key("b"),
      rule_id: "auth.token_never_expires",
      routing: "blocks",
      answer: "endorse",
    });
    expect(Object.hasOwn(unsigned!, "answered_by")).toBe(false);
  });

  it("is nobody where no box is ticked, whatever a line was signed with", () => {
    const body = boxes(key("c"), { ticked: false, sign: SIGNED });
    expect(parseStopAnswers(body)).toEqual([
      {
        finding_key: key("c"),
        rule_id: "auth.token_never_expires",
        routing: "blocks",
        answer: null,
      },
    ]);
  });

  it("reads an explicit person signature as a person", () => {
    const body = boxes(key("d"), { ticked: true, sign: "<!-- perbo:answered-by who=person -->" });
    expect(parseStopAnswers(body)[0]?.answered_by).toBe("person");
  });

  it("takes the stand-in's word over a person's where one stop's two lines disagree", () => {
    // A conflict is not an answer either way; what must not happen is a stop
    // the stand-in put its name to being counted as a partner's.
    const body = boxes(
      key("e"),
      { ticked: true, sign: "<!-- perbo:answered-by who=person -->" },
      { ticked: true, sign: SIGNED },
    );
    expect(parseStopAnswers(body)[0]).toMatchObject({ answer: "conflict", answered_by: "stand_in" });
  });

  it("reads a body that signs every tick as signing every stop away", () => {
    // The body is text anyone with write access to the pull request can edit,
    // and the direction the signature runs in is outwards: signing every tick
    // takes every stop out of the partner population. Nothing here stops that,
    // so it is read exactly as written and counted where the reading is — what
    // must not happen is a body being able to claim the opposite.
    const signed = ["6", "7", "8"].map((c) => boxes(key(c), { ticked: true, sign: SIGNED })).join("\n");
    const stops = parseStopAnswers(signed);
    expect(stops.map((stop) => stop.answered_by)).toEqual(["stand_in", "stand_in", "stand_in"]);
    // Every answer is still an answer: the label says who, never whether.
    expect(stops.map((stop) => stop.answer)).toEqual(["endorse", "endorse", "endorse"]);
  });

  it("reads no signature out of prose or a malformed marker", () => {
    const body = [
      `${SIGNED} — a line of prose that ticks nothing`,
      boxes(key("1"), { ticked: true, sign: "<!-- perbo:answered-by who=nobody -->" }),
      boxes(key("2"), { ticked: true, sign: "<!-- perbo:answered-by stand_in -->" }),
      SIGNED,
    ].join("\n");
    expect(parseStopAnswers(body).map((stop) => stop.answered_by)).toEqual([undefined, undefined]);
  });
});
