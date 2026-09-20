import { describe, expect, it } from "vitest";
import {
  completeSymbol,
  markSpecSymbols,
  nearestSymbolNames,
  replaceSymbolName,
  specSymbolNames,
  symbolBeingTyped,
  symbolOptions,
} from "./spec-text.js";

/**
 * SCP-321: the one reading of `@Symbol` in a spec (D-103, D-015).
 *
 * The Spec pane marks a name, the completion offers one, and the impact
 * warnings act on one. All three read the spec through here, so a name the
 * pane marks unknown is a name the impact analysis also went looking for.
 */
describe("the @Symbol references a spec names", () => {
  const marked = (text: string): string[] =>
    markSpecSymbols(text).flatMap((run) => (run.name === null ? [] : [run.name]));

  it("splits the text into runs that put it back together exactly", () => {
    for (const text of [
      "",
      "@signup",
      "see @signup here",
      "line one\n- @retry and @signup\n",
      "no names at all",
      "an @ on its own",
    ]) {
      expect(markSpecSymbols(text).map((run) => run.text).join("")).toBe(text);
    }
  });

  it("marks a name at the start, after a space, after a newline and inside brackets", () => {
    expect(marked("@signup is the entry point")).toEqual(["signup"]);
    expect(marked("see @signup here")).toEqual(["signup"]);
    expect(marked("one\n@signup")).toEqual(["signup"]);
    expect(marked("(@signup)")).toEqual(["signup"]);
    expect(marked("- @signup, @retry")).toEqual(["signup", "retry"]);
  });

  it("marks the run as the whole reference, the @ included", () => {
    const runs = markSpecSymbols("see @signup here");
    expect(runs).toEqual([
      { text: "see ", name: null },
      { text: "@signup", name: "signup" },
      { text: " here", name: null },
    ]);
  });

  it("takes $ as an identifier character, as the impact analysis does", () => {
    expect(marked("@retry$Queue holds them")).toEqual(["retry$Queue"]);
    expect(marked("@$ is jQuery")).toEqual(["$"]);
    expect(marked("@_private")).toEqual(["_private"]);
  });

  it("is not an address, a property or a doubled at-sign", () => {
    expect(marked("owner@example.com")).toEqual([]);
    expect(marked("queue.@retry")).toEqual([]);
    expect(marked("@@signup")).toEqual([]);
    expect(marked("x$@signup")).toEqual([]);
    expect(marked("@1signup")).toEqual([]);
  });

  it("names each reference once, in the order it first appears", () => {
    expect(specSymbolNames("@retry then @signup then @retry again")).toEqual([
      "retry",
      "signup",
    ]);
    expect(specSymbolNames("nothing here")).toEqual([]);
  });

  describe("the name being typed before the caret", () => {
    it("is the @ just started, and the letters after it", () => {
      expect(symbolBeingTyped("see @")).toEqual({ from: 4, query: "" });
      expect(symbolBeingTyped("see @sig")).toEqual({ from: 4, query: "sig" });
      expect(symbolBeingTyped("@sig")).toEqual({ from: 0, query: "sig" });
      expect(symbolBeingTyped("one\n@re")).toEqual({ from: 4, query: "re" });
      expect(symbolBeingTyped("@retry$Qu")).toEqual({ from: 0, query: "retry$Qu" });
    });

    it("is nothing once the name has been left", () => {
      expect(symbolBeingTyped("see @sig ")).toBeNull();
      expect(symbolBeingTyped("see @sig\n")).toBeNull();
      expect(symbolBeingTyped("nothing")).toBeNull();
      expect(symbolBeingTyped("")).toBeNull();
    });

    it("refuses the same places the marking refuses", () => {
      expect(symbolBeingTyped("owner@exampl")).toBeNull();
      expect(symbolBeingTyped("queue.@ret")).toBeNull();
      expect(symbolBeingTyped("@@sig")).toBeNull();
      expect(symbolBeingTyped("x$@sig")).toBeNull();
    });
  });

  /**
   * What the Spec pane's completion offers, and what choosing one writes.
   * The measuring and the popup are the pane's; the text is this.
   */
  describe("the names offered for what is being typed", () => {
    const index = [
      { name: "signup" },
      { name: "resignupHandler" },
      { name: "signupQueue" },
      { name: "retry" },
      { name: "retryQueue" },
      { name: "sendActivation" },
    ];

    it("matches anywhere in the name, and puts the ones that start with it first", () => {
      expect(symbolOptions("signup", index, 6).map((each) => each.name)).toEqual([
        "signup",
        "signupQueue",
        "resignupHandler",
      ]);
    });

    it("ignores case on both sides", () => {
      expect(symbolOptions("QUEUE", index, 6).map((each) => each.name)).toEqual([
        "signupQueue",
        "retryQueue",
      ]);
      expect(symbolOptions("retryq", index, 6).map((each) => each.name)).toEqual(["retryQueue"]);
    });

    it("offers everything for an @ with nothing typed after it, in the index's own order", () => {
      expect(symbolOptions("", index, 6).map((each) => each.name)).toEqual(
        index.map((each) => each.name),
      );
    });

    it("stops at the limit rather than filling the pane", () => {
      expect(symbolOptions("", index, 2).map((each) => each.name)).toEqual([
        "signup",
        "resignupHandler",
      ]);
      expect(symbolOptions("nothing matches this", index, 6)).toEqual([]);
    });
  });

  describe("choosing a name", () => {
    it("writes the reference and a space, and leaves the caret past both", () => {
      const written = completeSymbol({ text: "see @sig here", from: 4, to: 8, name: "signup" });
      expect(written.text).toBe("see @signup here");
      expect(written.caret).toBe("see @signup ".length);
      expect(written.text[written.caret]).toBe("h");
    });

    it("writes over an @ with nothing after it", () => {
      expect(completeSymbol({ text: "see @", from: 4, to: 5, name: "signup" })).toEqual({
        text: "see @signup ",
        caret: 12,
      });
    });

    it("does not double the space that was already there", () => {
      expect(completeSymbol({ text: "@sig and more", from: 0, to: 4, name: "signup" }).text).toBe(
        "@signup and more",
      );
    });
  });

  describe("replacing a name the index does not hold", () => {
    it("replaces every reference to it in the section, and nothing else", () => {
      expect(
        replaceSymbolName("@signUp queues, and @signUp again. @signUpQueue stays.", "signUp", "signup"),
      ).toBe("@signup queues, and @signup again. @signUpQueue stays.");
    });

    it("leaves the places that are not references alone", () => {
      expect(replaceSymbolName("mail signUp@example.com about @signUp", "signUp", "signup")).toBe(
        "mail signUp@example.com about @signup",
      );
      expect(replaceSymbolName("queue.@signUp", "signUp", "signup")).toBe("queue.@signUp");
    });

    it("replaces a name whose characters a regular expression would read as syntax", () => {
      expect(replaceSymbolName("@retry$Queue holds them", "retry$Queue", "retryQueue")).toBe(
        "@retryQueue holds them",
      );
    });
  });

  describe("the nearest names to one the index does not hold", () => {
    const names = ["signup", "signupQueue", "retry", "sendActivation", "signOut"];

    it("offers the closest by edit distance, nearest first", () => {
      expect(nearestSymbolNames("signUp", names, 2)).toEqual(["signup", "signOut"]);
      expect(nearestSymbolNames("retrie", names, 2)).toEqual(["retry", "signup"]);
    });

    it("ignores case, so a name that differs only in case is the nearest of all", () => {
      expect(nearestSymbolNames("SIGNUP", names, 1)).toEqual(["signup"]);
    });

    it("breaks a tie by name, so the same spec offers the same two every time", () => {
      expect(nearestSymbolNames("xyzzy", ["bbb", "aaa", "ccc"], 2)).toEqual(["aaa", "bbb"]);
    });

    it("offers what there is when the index holds fewer", () => {
      expect(nearestSymbolNames("signUp", ["signup"], 2)).toEqual(["signup"]);
      expect(nearestSymbolNames("signUp", [], 2)).toEqual([]);
    });
  });
});
