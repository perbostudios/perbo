import { describe, expect, it } from "vitest";
import { decision, sentence, withoutMapEntry } from "../test-support/pins.js";
import { INTERPRETERS } from "./interpreter.js";

/**
 * `INTERPRETERS` pins a **decision** (SCP-190). Without the entry the verb is a
 * word the guard has no reading for, and the line it refused is allowed.
 */

/**
 * One line per interpreter, refused today because the table says that verb
 * carries a program on its command line. None of the paths in them resolves
 * anywhere, so what refuses is the reading of the code and nothing else.
 */
const INTERPRETER_LINES: Record<string, string> = {
  node: `node -e "require('fs').unlinkSync('x')"`,
  nodejs: `nodejs -e "require('fs').unlinkSync('x')"`,
  deno: `deno eval "Deno.remove('x')"`,
  python: `python -c "__import__('os').remove('x')"`,
  python2: `python2 -c "__import__('os').remove('x')"`,
  python3: `python3 -c "__import__('os').remove('x')"`,
  pypy: `pypy -c "__import__('os').remove('x')"`,
  pypy3: `pypy3 -c "__import__('os').remove('x')"`,
  ruby: `ruby -e "File.delete('x')"`,
  perl: `perl -e "unlink('x')"`,
  php: `php -r "unlink('x');"`,
  osascript: `osascript -e 'do shell script "ls"'`,
  awk: `awk '{system("rm x")}' src/index.ts`,
  gawk: `gawk '{system("rm x")}' src/index.ts`,
  mawk: `mawk '{system("rm x")}' src/index.ts`,
  nawk: `nawk '{system("rm x")}' src/index.ts`,
};

describe("every interpreter in the table, pinned by removing it", () => {
  it("has a line for every entry, and no line for an entry that is gone", () => {
    expect(Object.keys(INTERPRETER_LINES).sort()).toEqual([...INTERPRETERS.keys()].sort());
  });

  for (const [verb, command] of Object.entries(INTERPRETER_LINES)) {
    it(`\`${verb}\`: ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      // And the record says which interpreter it was, which is what makes the
      // refusal one a person can act on.
      expect(sentence(command), command).toContain(verb);
      withoutMapEntry(INTERPRETERS, verb, () => {
        expect(decision(command), `without \`${verb}\`: ${command}`).toBe("allowed");
      });
      expect(decision(command), command).toBe("refused");
    });
  }
});
