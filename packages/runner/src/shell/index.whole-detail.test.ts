import { describe, expect, it } from "vitest";
import { readCommandLine, resolveScope } from "./index.js";

/**
 * The line a refusal is about is quoted whole (D-NEW-nothing-shown-is-cut).
 *
 * Every reason the guard gives ends with the segment it read, and that segment
 * is the executor's own command: tool output a person reads to know what was
 * refused, however long it runs. Each line below is padded past any length a
 * cut kept, and reaches one of the reasons by the path it names.
 */

const PAD = `PADDINGTOKEN${"x".repeat(240)}END`;
const scope = resolveScope({ root: "/work/tree", home: "/Users/nobody" });

const cases: ReadonlyArray<[string, string, string?]> = [
  ["a destination outside the worktree", `rm -rf / ${PAD}`],
  [
    "a spawned command's write, named whole",
    `node -e "require('child_process').execSync('echo ${PAD} > /etc/perbo-out')"`,
    `runs \`echo ${PAD} > /etc/perbo-out\``,
  ],
  ["inline code this guard cannot read", `node -e \\\\ ${PAD}`],
  ["a wrapper's destination from standard input", `xargs ln -s -t links ${PAD}`],
  ["a wrapper's operands from standard input", `xargs rm ${PAD}`],
  ["a program's stdin script that is not on the line", `PADDING=${PAD} pnpm exec node <<'JS'`],
  ["a shell's stdin script that is not on the line", `PADDING=${PAD} bash <<'SH'`],
  ["a command built at run time", `eval $CMD ${PAD}`],
  ["an option whose value hides the command", `npm -v ${PAD}`],
  ["an option that builds the command from a string", `env -S 'cp a ~/x' true ${PAD}`],
  ["an option that runs under another root", `sudo -R ${PAD}`],
  ["a command passed to a wrapper that cannot be read", `xargs -I{} npx -c 'rm {}' ${PAD}`],
  ["a working directory that cannot be resolved", `cd - ${PAD}`],
  ["a directory a wrapper substitutes", `xargs -I{} env -C {} rm x ${PAD}`],
  ["a placeholder where the command stands", `echo rm | xargs -J % % a /etc/x ${PAD}`],
  ["a placeholder shaped like an option", `echo /etc | xargs -J -- cp a b -- ${PAD}`],
  ["a program behind a wrapper fed from standard input", `xargs -J % xargs -I@ cp @ % ${PAD}`],
  ["a placeholder the shell expands", `echo /etc | xargs -J a cp -t ? x ${PAD}`],
  ["a program built at run time", `exec $CMD ${PAD}`],
  ["a popd", `PADDING=${PAD} popd && node --version`],
  ["what find walks, fed from standard input", `xargs find . -name x ${PAD}`],
  ["find's starting points from a file", `find -files0-from list -delete ${PAD}`],
  ["a legacy rule", `rm -rf build # don't touch ~/x ${PAD}`],
  ["a line that cannot be read", `cd - # ${PAD}`],
  ["a backup suffix built when the line runs", `cp -b --suffix="$S" src/a.ts src/other/ ${PAD}`],
  ["a word built where a writer still reads options", `find src $(echo -delete) ${PAD}`],
  ["a sed script the line does not spell", `sed -i "$X" src/a.ts ${PAD}`],
  [
    "an ANSI-C quote this guard cannot end",
    `echo $'\\''; cp a /etc/x ${PAD}`,
    `the $'…' in ${JSON.stringify(`$'\\''; cp a /etc/x ${PAD}`)} holds`,
  ],
];

describe("a refusal quotes the line it read, whole", () => {
  for (const [label, command, quoted] of cases) {
    it(label, () => {
      const details = readCommandLine(command, scope).findings.map((finding) => finding.detail);
      const quoting = details.filter((detail) => detail.includes("PADDINGTOKEN"));
      expect(quoting.length, details.join("\n")).toBeGreaterThan(0);
      for (const detail of quoting) expect(detail).toContain(PAD);
      if (quoted !== undefined) expect(details.join("\n")).toContain(quoted);
    });
  }
});
