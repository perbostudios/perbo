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
 * is a source — once a `--` or a prefix keeps it from being read as an option.
 */
const DESTINATION_ON_THE_LINE = [
  "xargs -I{} cp -- {} out",
  "xargs -I{} cp ./{} out",
  "xargs -i cp -- {} out",
  "xargs -J % cp -- % out",
  "xargs -0 -n1 cp -t out --",
  "xargs --replace=% mv -- % out",
  // A substituting wrapper whose operands carry no placeholder runs the line as
  // it stands, once per word it reads.
  "xargs -I{} rm sub/generated",
  "xargs grep TODO",
  "xargs ls",
  "xargs curl -o out/payload https://example.com/x --",
  // `{}` is what xargs is most often told to substitute, and a quoted tilde is
  // handed over as written.
  "find . -print0 | xargs -0 -J {} cp -- {} out",
  "xargs -J {} cp -- {} out",
  "xargs -J '~' cp -- a '~' b",
  // The placeholder among a writer's sources, with the destination on the line.
  "xargs -J % cp -- a % out",
  "xargs -J % cp -t out -- %",
];

/**
 * The same lines where the words the wrapper supplies stand where the writer
 * still reads options: a placeholder that begins a word before `--`, or words
 * appended to a line with no `--`. What the wrapper reads is whatever its input
 * holds, and a word in it that begins with `-` is an option: after
 * `touch -- 'sub/-t..'`, `ls sub | xargs -I{} cp {} out` runs GNU `cp -t.. out`.
 */
const SUPPLIED_WHERE_OPTIONS_ARE_READ = [
  "touch -- 'sub/-t..'; ls sub | xargs -I{} cp {} out",
  "xargs -I{} cp {} out",
  "xargs -i cp {} out",
  "xargs -J % cp % out",
  "xargs -0 -n1 cp -t out",
  "xargs --replace=% mv % out",
  "xargs curl -o out/payload https://example.com/x",
  "find . -print0 | xargs -0 -J {} cp {} out",
  "xargs -J {} cp {} out",
  "xargs -J '~' cp a '~' b",
  "xargs -J % cp a % out",
  "xargs -J % cp -t out %",
  "xargs -I{} ln {} links/",
  "xargs ln -t links",
  // A word that begins with the placeholder begins with what the input holds.
  "xargs -I{} cp {}.bak out",
  // The option a word supplies can make the command a writer at all: `-i`
  // makes `sed` one, and `-C` gives an extraction its directory.
  "xargs -I{} sed -n p {} src/a.ts",
  "xargs -I{} tar -xf a.tar {}",
];

/**
 * `dd` reads no options, and an `of=` among its operands is where it writes,
 * `--` or not: a word the wrapper supplies may be one.
 */
const SUPPLIED_AMONG_DD_OPERANDS = [
  "echo of=/etc/x | xargs dd if=/dev/zero count=1",
  "echo of=/etc/x | xargs dd if=/dev/zero count=1 --",
  "xargs -I{} dd if=/dev/zero {} count=1",
  "xargs -I{} dd if=/dev/zero -- {} count=1",
];

/** A supplied word `dd` reads as a file it reads from. */
const SUPPLIED_AS_DD_INPUT = ["xargs -I{} dd if={} of=out/copy"];

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
  // BSD `-J` puts every word it reads where the placeholder stands, so the
  // placeholder is any number of words: readable only among the sources of a
  // writer whose destination the line spells. Anywhere else — the last or lone
  // operand, a skipped operand, an option's value, a wrapper's word, the
  // program — the input reaches something the guard cannot read.
  "echo /etc/passwd /etc/x | xargs -J % cp %",
  "echo /etc/passwd /etc/x | xargs -J % mv %",
  "echo /etc/passwd /etc/x | xargs -n2 -J % cp -r %",
  "echo 777 /etc/x | xargs -J % chmod % x",
  "echo root /etc/x | xargs -J % chown % x",
  "echo /etc/x | xargs -J % sed -i '' % x",
  "echo 755 /etc/x | xargs -J % mkdir -m % x",
  "echo /etc/x | xargs -J % touch -r % x",
  "echo 0 /etc/x | xargs -J % truncate -s % x",
  "echo 5 | xargs -J % timeout % cp a b",
  "echo 5 | xargs -J % nice -n % cp a b",
  "echo 'rm /etc/x' | xargs -J then then cp a b",
  "echo rm | xargs -J % % a /etc/x",
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

  for (const command of SUPPLIED_WHERE_OPTIONS_ARE_READ) {
    it(`refuses ${command}, where the words xargs supplies may be options`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("still reads options");
    });
  }

  for (const command of SUPPLIED_AMONG_DD_OPERANDS) {
    it(`refuses ${command}, where a word xargs supplies may be an of=`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("reads an of= among its operands");
    });
  }

  for (const command of SUPPLIED_AS_DD_INPUT) {
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

/**
 * A placeholder inside a command line a nested shell runs, or inside a `find`
 * body: the wrapper puts its input into a line this guard reads as written, so
 * what that line runs cannot be read, and the refusal names the wrapper.
 */
const SUBSTITUTED_INTO_A_NESTED_COMMAND = [
  "echo /etc/passwd | xargs -I{} sh -c 'rm {}'",
  "echo 'rm /etc/x' | xargs -J % sh -c %",
  "echo 'rm /etc/x' | xargs -J % pnpm exec -c %",
  "xargs -I{} bash -c 'cp a {}'",
  "xargs -I{} npx -c 'rm {}'",
  "xargs -I{} pnpm exec --call='rm {}'",
  "echo /etc/passwd | xargs -I{} find . -exec rm {} \\;",
  "echo /etc/passwd | xargs -I{} find . -exec sh -c 'rm {}' \\;",
];

/** The same shapes where the input stays out of the nested line. */
const OUTSIDE_THE_NESTED_COMMAND = [
  "xargs -I{} sh -c 'rm sub/x'",
  // BSD `-J` replaces only a whole operand, so `rm %` runs as written.
  "xargs -J % sh -c 'rm %'",
  // The input is `-name`'s pattern, and reaches no body. A `find` the input
  // is appended to is in find.test.ts: appended words can add a body.
  "xargs -I{} find . -name {} -exec rm sub/x \\;",
];

describe("a placeholder substituted into a nested command", () => {
  for (const command of SUBSTITUTED_INTO_A_NESTED_COMMAND) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("xargs");
    });
  }

  for (const command of OUTSIDE_THE_NESTED_COMMAND) {
    it(`allows ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }
});

/**
 * The destinations a line reaches outside the writer table: a link, a `git`
 * directory, the file `time -o` writes and the directory `sudo -D` runs in.
 * Each is judged where the line spells it and refused where a wrapper in front
 * fills it from its standard input, as a writer's operand is.
 */
const BEYOND_THE_WRITER_TABLE = [
  "echo /etc/x | xargs ln -s a",
  "echo /etc/x | xargs ln a",
  "xargs ln -s -t links",
  "xargs -I{} ln -s {} links/x",
  "xargs -I{} ln -s a {}",
  "echo /etc | xargs -J % git -C % clean -fdx",
  "xargs -I{} git -C {} commit -m x",
  "echo /etc/repo | xargs git init",
  "echo https://example.com/x.git | xargs git clone",
  "echo /etc/tree | xargs git worktree add",
  "time -o /etc/x ls",
  "time --output=/etc/x ls",
  "xargs -I{} time -o {} ls",
  "echo /etc/x | xargs -J % time -o % ls",
  "sudo -D /etc rm x",
  "sudo --chdir=/etc rm x",
  "xargs -I{} sudo -D {} rm x",
];

/** The same shapes where what the line writes is inside, or is only read. */
const WITHIN_OR_READ = [
  // A hard link's target is read, not written through.
  "xargs -I{} ln -- {} links/",
  "xargs ln -t links --",
  "xargs -J % git -C % log",
  "xargs git clean -fdx",
  "time -o out/timing.txt ls",
  "sudo -D src rm x",
];

describe("a destination the writer table does not name", () => {
  for (const command of BEYOND_THE_WRITER_TABLE) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  for (const command of WITHIN_OR_READ) {
    it(`allows ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }

  it("names the wrapper that fills one from its standard input", () => {
    for (const command of BEYOND_THE_WRITER_TABLE.filter((line) => line.includes("xargs"))) {
      expect(sentence(command), command).toContain("xargs");
    }
  });
});

/**
 * `sudo -R` runs the command under another root directory, where every path
 * the command names resolves somewhere this guard does not read — inside the
 * worktree or not.
 */
const UNDER_ANOTHER_ROOT = [
  "sudo -R /etc rm x",
  "sudo --chroot=/etc rm x",
  "sudo -nR /etc rm x",
  "sudo -R src rm x",
];

describe("a command run under another root directory", () => {
  for (const command of UNDER_ANOTHER_ROOT) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("under another root directory");
    });
  }
});

/**
 * One `xargs` behind another whose input reaches it: the command the inner one
 * runs is built from two inputs, and the refusal names the outer wrapper.
 */
const BEHIND_ANOTHER_WRAPPER = [
  "xargs -I{} xargs -a list -I@ cp a @ {}",
  "xargs -J % xargs -I@ cp @ %",
  "echo /etc | xargs xargs -I@ cp @ out",
];

describe("an xargs behind another", () => {
  for (const command of BEHIND_ANOTHER_WRAPPER) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("stands behind xargs");
    });
  }

  it("reads the inner one where the outer one's input reaches nothing", () => {
    expect(decision("xargs -I{} xargs cp -t out --")).toBe("allowed");
    // Without the `--`, the inner one appends its input where `cp` reads options.
    expect(sentence("xargs -I{} xargs cp -t out")).toContain("still reads options");
    expect(sentence("xargs -I{} xargs cp -t out")).not.toContain("stands behind xargs");
  });
});

/**
 * A verb that writes through one of its options — `git diff --output`,
 * `git format-patch -o`, `rg --pre`, which runs a program — behind a wrapper
 * that supplies it words. Those words land where the verb still reads its
 * options, so one can be that option: each is refused unless `--` keeps them
 * paths. A relative `--output` under a `-C` the placeholder fills lands where
 * the supplied words say, and a `--pre` program the placeholder stands in is
 * not one the line names.
 */
const OPTION_A_WRAPPER_SUPPLIES = [
  "git ls-files | xargs git diff",
  "xargs git log --oneline",
  "xargs -I{} git show {}",
  "xargs git format-patch",
  "git ls-files | xargs rg foo",
  "xargs -I{} rg foo {}",
  "xargs -J % git -C % diff --output=x.diff",
  "xargs -J % git -C % format-patch -o patches HEAD~1",
  "xargs -I{} rg --pre ./{} foo -- src",
];

/** The same, with `--` keeping the supplied words paths, or with no wrapper in front. */
const OPTION_THE_LINE_SPELLS = [
  "git ls-files | xargs git diff --",
  "xargs -I{} git show -- {}",
  "git ls-files | xargs rg foo --",
  "xargs -I{} rg foo -- {}",
  "xargs -J % git -C % log",
  "git -C src diff --output=x.diff",
  "rg --pre cat foo src",
];

describe("a word a wrapper supplies where a verb writes through an option", () => {
  for (const command of OPTION_A_WRAPPER_SUPPLIES) {
    it(`refuses ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("xargs");
    });
  }

  for (const command of OPTION_THE_LINE_SPELLS) {
    it(`allows ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }
});
