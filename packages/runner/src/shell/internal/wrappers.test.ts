import { describe, expect, it } from "vitest";
import { decision, sentence } from "../test-support/pins.js";
import { WRAPPERS } from "./wrappers.js";

/**
 * `xargs` appends the words it reads from standard input to the command it
 * runs, so a writer behind it is handed destinations the line never spells.
 * `appendsOperands` is what says so, and it is pinned the way every other table
 * entry is (SCP-190): taken off the entry, each line below is allowed and the
 * guard reads a write whose target it has not seen.
 */

/** Lines whose destinations all arrive on standard input. */
const FROM_STANDARD_INPUT = [
  "echo /etc/x | xargs touch",
  "xargs -0 rm -rf < list.txt",
  "xargs rm",
  "xargs touch",
  "xargs cp a",
  "xargs -n1 mkdir",
  "find . -name '*.log' | xargs rm -f",
  "xargs -0 install -d",
  // Every operand of an `rm` is a destination, so the appended ones are too.
  "xargs rm sub/generated",
  // A value attached to a short option is that option's value: `-a`, `-d` and
  // `-s` each take one, so the `i`, `I` and `J` inside these lines name no
  // substitution and the words still arrive as operands.
  "xargs -alist.txt rm",
  "xargs -dI rm",
  "xargs -sJ rm",
];

/**
 * The same wrapper where the line does spell the destination: `-I`, `-i` and
 * `-J` substitute the words into operands already written down, and `-t` names
 * a directory the operands are written into, so what arrives on standard input
 * is a source.
 */
const DESTINATION_ON_THE_LINE = [
  "xargs -I{} cp {} out",
  "xargs -i cp {} out",
  "xargs -J % cp % out",
  "xargs -0 -n1 cp -t out",
  "xargs --replace=% mv % out",
  "xargs grep TODO",
  "xargs ls",
  "xargs curl -o out/payload https://example.com/x",
];

/** Run `body` with the xargs entry no longer saying it appends operands. */
const notAppending = (body: () => void) => {
  const held = WRAPPERS.get("xargs")!;
  WRAPPERS.set("xargs", { ...held, appendsOperands: false });
  try {
    body();
  } finally {
    WRAPPERS.set("xargs", held);
  }
};

describe("a writer handed its operands on standard input", () => {
  for (const command of FROM_STANDARD_INPUT) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      // The refusal has to say which wrapper supplies the words, because the
      // line the agent typed names no path for it to recognise.
      expect(sentence(command), command).toContain("xargs");
      notAppending(() => {
        expect(decision(command), `not appending: ${command}`).toBe("allowed");
      });
      expect(decision(command), command).toBe("refused");
    });
  }
});

describe("a writer whose destination is on the line", () => {
  for (const command of DESTINATION_ON_THE_LINE) {
    it(`allows ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }
});
