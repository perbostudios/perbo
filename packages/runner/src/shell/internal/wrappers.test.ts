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
  // BSD xargs (macOS) appends its input unless the placeholder stands alone as an operand.
  "xargs -J % rm",
  "xargs -J% rm",
  "echo /etc/x | xargs -J % cp a b",
  // GNU `-e` and `-l` take a value only attached; the next word is the program,
  // whose destination the input then appends to.
  "xargs -l rm sub/x",
  "xargs -e rm sub/x",
  // A redirect target is the shell's word, not xargs's: the placeholder stands
  // nowhere xargs looks, so the input is appended.
  "echo /etc | xargs -J % cp > % a b",
  // A word the shell rewrites never reaches xargs as the placeholder, so the
  // input is appended after all.
  "echo /etc | xargs -J '~' cp a ~ b",
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
  // A substituting wrapper whose operands carry no placeholder runs the line as
  // it stands, once per word it reads.
  "xargs -I{} rm sub/generated",
  "xargs grep TODO",
  "xargs ls",
  "xargs curl -o out/payload https://example.com/x",
  // `{}` is what xargs is most often told to substitute, and a quoted tilde is
  // handed over as written.
  "find . -print0 | xargs -0 -J {} cp {} out",
  "xargs -J {} cp {} out",
  "xargs -J '~' cp a '~' b",
];

/**
 * The placeholder standing where the destination goes. Every operand of an
 * `rm`, a `touch`, a `mkdir`, a `tee` or an `install -d` is a destination, and
 * the last operand of a `cp` is, so a placeholder in one of those positions is
 * a path the line does not spell any more than an appended word is.
 */
const SUBSTITUTED_FOR_THE_DESTINATION = [
  "echo /etc/passwd | xargs -I{} rm {}",
  "xargs -I{} touch {}",
  "xargs -I{} mkdir {}",
  "xargs -I{} tee {}",
  "xargs -J % install -d %",
  "xargs --replace=% rm %",
  "xargs -I{} cp src {}",
  // `-i` and `--replace` take a value only attached, so the word after one is
  // the command, and the placeholder they stand for is `{}`.
  "xargs -i rm {}",
  "xargs --replace tee {}",
  // BSD `-J` substitutes wherever the placeholder stands alone, an option's value included.
  "echo /etc/x | xargs -J % curl -o % https://example.com/x",
  "xargs -J % cp -t % a",
  // The directory a wrapper moves into is a destination too.
  "echo /etc | xargs -J % env -C % rm x",
  "xargs -I{} env -C {} rm x",
  "xargs -J % pnpm -C % exec rm x",
  // A placeholder shaped like an option stands where a writer reads options,
  // so whatever the input holds is read as one: the line cannot be read.
  "echo /etc/passwd | xargs -J -r rm -r",
  "echo /etc | xargs -J -f cp a b -f",
  "echo /etc/passwd | xargs -I -f rm -f",
  "echo /etc | xargs -J -- cp a b --",
  // An unset variable is rewritten to nothing before xargs runs.
  "echo /etc | xargs -J '$P' cp a $P b",
  // `{}` and `{x}` are not brace expansions, so the shell hands them to xargs
  // as written and they stand where the destination goes.
  "echo /etc | xargs -J {} cp -t {} a",
  "echo /etc | xargs -J {} mv -t {} a",
  "echo /etc | xargs -J {} curl -o {} https://x",
  "echo /etc | xargs -J {} tar -C {} -xf a.tar",
  "echo /etc | xargs -J {} nice cp -t {} a",
  "echo /etc | xargs -J '{x}' cp -t {x} a",
  "echo /etc | xargs -J 'a~' cp -t a~ x",
  // A glob or a brace expansion in the wrapped command can put the placeholder
  // anywhere or nowhere, depending on the files present: the line is unreadable.
  "echo /etc | xargs -J '{a,b}' cp {a,b} b",
  "echo /etc | xargs -J '*' cp a * b",
  "echo /etc | xargs -J '[' cp -t [ x",
  "echo /etc | xargs -J 'zq?' cp -t zq? x",
  "echo /etc | xargs -J 'a*' cp x 'a'* b",
  "echo /etc | xargs -J 'a*' cp x \\a* b",
  "echo /etc | xargs -J '*' cp a \"\"* b",
  "echo /etc | xargs -J '{a,b}c' cp a {a,b}'c' b",
  "echo /etc | xargs -J a cp -t [a] x",
  "echo /etc | xargs -J a cp -t {a,} x",
  "echo /etc | xargs -J a cp -t ? x",
  "echo /etc | xargs -J a curl -o [a] https://x",
  // A tilde the shell expands never reaches xargs, whatever is quoted after it.
  "echo /etc | xargs -J '~/x' cp a ~/'x' b",
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

describe("a writer whose destination is the placeholder", () => {
  for (const command of SUBSTITUTED_FOR_THE_DESTINATION) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      // The refusal names the wrapper that supplies the word, because the line
      // the agent typed spells no path for it to recognise.
      expect(sentence(command), command).toContain("xargs");
    });
  }
});
