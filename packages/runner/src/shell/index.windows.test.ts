import { describe, expect, it } from "vitest";
import { inspectWritePath, readCommandLine, resolveScope, type ResolvedScope } from "./index.js";

/**
 * Scope enforcement against a Windows worktree root.
 *
 * A drive-qualified path is the case a separator test cannot see: `C:\worktree`
 * starts with neither `/` nor `\`, so reading absoluteness from a leading
 * separator makes every Windows path relative and joins it onto the base — a
 * root of `\C:\worktree` and a target under it of
 * `\C:\worktree\C:\worktree\README.md`, whose repository-relative path is the
 * whole absolute path and matches no contract glob. That refuses every write an
 * agent makes inside its own worktree, which is the whole of a run on Windows.
 *
 * Every case below names its own semantics rather than inheriting the host's,
 * so the same assertions run identically on Windows and on Linux.
 */

const WINDOWS_ROOT = String.raw`C:\Users\a\.perbo\worktrees\test program-8b\att_c5`;
const POSIX_ROOT = "/home/a/.perbo/worktrees/wt/att_c5";
const ALLOWED = ["src/styles/**", "index.html", "tests/**", "README.md"];

const windows = (target: string): "allowed" | "refused" =>
  inspectWritePath(
    target,
    resolveScope({ root: WINDOWS_ROOT, paths_allowed: ALLOWED, semantics: "windows" }),
  ) === null
    ? "allowed"
    : "refused";

const posix = (target: string): "allowed" | "refused" =>
  inspectWritePath(
    target,
    resolveScope({ root: POSIX_ROOT, paths_allowed: ALLOWED, semantics: "posix" }),
  ) === null
    ? "allowed"
    : "refused";

describe("a Windows worktree root", () => {
  it("resolves to itself rather than to a doubled path", () => {
    const scope = resolveScope({
      root: WINDOWS_ROOT,
      paths_allowed: ALLOWED,
      semantics: "windows",
    });
    expect(scope.root).toBe("C:/Users/a/.perbo/worktrees/test program-8b/att_c5");
  });

  it("admits a top-level file the contract names", () => {
    expect(windows(WINDOWS_ROOT + String.raw`\README.md`)).toBe("allowed");
    expect(windows(WINDOWS_ROOT + String.raw`\index.html`)).toBe("allowed");
  });

  it("admits a nested file under a glob, whichever separator the agent wrote", () => {
    expect(windows(WINDOWS_ROOT + String.raw`\tests\support\color.js`)).toBe("allowed");
    expect(windows(WINDOWS_ROOT + "/tests/support/color.js")).toBe("allowed");
    expect(windows(WINDOWS_ROOT + String.raw`\src\styles\theme.css`)).toBe("allowed");
  });

  it("still refuses a path inside the worktree the contract does not name", () => {
    expect(windows(WINDOWS_ROOT + String.raw`\probe.tmp.txt`)).toBe("refused");
    expect(windows(WINDOWS_ROOT + String.raw`\package.json`)).toBe("refused");
  });

  it("still refuses the ticket store, which judges the attempt", () => {
    expect(windows(WINDOWS_ROOT + String.raw`\.perbo\config.json`)).toBe("refused");
  });

  it("still refuses a destination outside the worktree entirely", () => {
    expect(windows(String.raw`C:\Windows\System32\evil.dll`)).toBe("refused");
    expect(windows(String.raw`D:\elsewhere\file.txt`)).toBe("refused");
  });

  it("still refuses a climb out of the root", () => {
    expect(windows(WINDOWS_ROOT + String.raw`\..\..\escape.txt`)).toBe("refused");
  });
});

describe("case, where Windows resolves a name without it", () => {
  // `c:\users\A\…` and `C:\Users\a\…` name one file there, so the guard reads
  // them as one path — for the root, for the scratch directory, and for the
  // contract's globs, in both directions.
  const LOWER_ROOT = WINDOWS_ROOT.replace("C:", "c:").replace(String.raw`\Users\a`, String.raw`\users\A`);

  it("admits a path that differs from the root only in case", () => {
    expect(windows(LOWER_ROOT + String.raw`\README.md`)).toBe("allowed");
  });

  it("admits a path under an allowed glob written in another case", () => {
    expect(windows(WINDOWS_ROOT + String.raw`\SRC\Styles\theme.css`)).toBe("allowed");
  });

  it("refuses a prohibited path written in another case, under a contract that admits everything", () => {
    // No `paths_allowed`: everything inside the root is admitted but what is
    // prohibited, and the spec folder is prohibited for every scope (D-103).
    const everything = (target: string) =>
      inspectWritePath(target, resolveScope({ root: WINDOWS_ROOT, semantics: "windows" }));
    expect(everything(WINDOWS_ROOT + String.raw`\specs\auth\spec.md`)).not.toBeNull();
    expect(everything(WINDOWS_ROOT + String.raw`\SPECS\auth\spec.md`)).not.toBeNull();
    expect(everything(LOWER_ROOT + String.raw`\Specs\auth\spec.md`)).not.toBeNull();
  });

  it("refuses a path under a prohibited glob the contract wrote in capitals, in any case", () => {
    const scope = resolveScope({
      root: WINDOWS_ROOT,
      paths_prohibited: ["Config/Prod/**"],
      semantics: "windows",
    });
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\Config\Prod\keys.json`, scope)).not.toBeNull();
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\config\prod\keys.json`, scope)).not.toBeNull();
  });

  it("refuses a prohibited path differing in any letter's case, not only A–Z", () => {
    const scope = resolveScope({ root: WINDOWS_ROOT, paths_prohibited: ["Ärger/**"], semantics: "windows" });
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\ärger\notes.txt`, scope)).not.toBeNull();
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\ÄRGER\notes.txt`, scope)).not.toBeNull();
  });

  it("compares through uppercase, so a letter that upper-cases to A–Z is that letter", () => {
    // `ſ` (long s) upper-cases to `S`.
    const scope = resolveScope({ root: WINDOWS_ROOT, paths_prohibited: ["secrets/**"], semantics: "windows" });
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\ſecrets\token`, scope)).not.toBeNull();
  });

  it("refuses what an exact match refuses, whatever the fold does to it", () => {
    // Upper-casing a whole string can change its length (`ß` is `SS`), and
    // lower-casing a Greek sigma depends on what follows it.
    const refused = (glob: string, target: string) =>
      inspectWritePath(
        WINDOWS_ROOT + "\\" + target,
        resolveScope({ root: WINDOWS_ROOT, paths_prohibited: [glob], semantics: "windows" }),
      ) !== null;
    expect(refused("κωδικος*", "κωδικος.txt")).toBe(true);
    expect(refused("ΚΩΔΙΚΟΣ*", "ΚΩΔΙΚΟΣ.txt")).toBe(true);
    expect(refused("**/κωδικος.*", String.raw`docs\κωδικος.md`)).toBe(true);
    expect(refused("ΑΣ*", "ΑΣΒ.txt")).toBe(true);
    expect(refused("?.pem", "ß.pem")).toBe(true);
    expect(refused("?.pem", "İ.pem")).toBe(true);
  });

  it("folds a final sigma with a medial one, as Windows compares them", () => {
    const scope = resolveScope({ root: WINDOWS_ROOT, paths_prohibited: ["κωδικος*"], semantics: "windows" });
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\ΚΩΔΙΚΟΣ.txt`, scope)).not.toBeNull();
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\κωδικοσ.txt`, scope)).not.toBeNull();
  });

  it("reads the scratch directory in any case as the scratch directory", () => {
    // The runner's own directory is never judged by the contract's globs, and
    // no glob below names it, so only the exemption can admit a write there.
    const scope = resolveScope({
      root: WINDOWS_ROOT,
      tmpdir: WINDOWS_ROOT + String.raw`\.scratch`,
      paths_allowed: ALLOWED,
      semantics: "windows",
    });
    expect(inspectWritePath(WINDOWS_ROOT + String.raw`\.scratch\log.txt`, scope)).toBeNull();
    expect(inspectWritePath(LOWER_ROOT + String.raw`\.SCRATCH\log.txt`, scope)).toBeNull();
  });

  it("folds only A–Z in the root, so a root spelled in another letter's case is refused", () => {
    // Folding only A–Z keeps a path's length, so the prefix a comparison finds
    // is the prefix sliced off; a case Windows would also fold outside ASCII is
    // refused rather than admitted.
    const root = String.raw`C:\Users\Ärger\wt`;
    const scope = resolveScope({ root, paths_allowed: ALLOWED, semantics: "windows" });
    expect(inspectWritePath(String.raw`C:\Users\ärger\wt\README.md`, scope)).not.toBeNull();
    expect(inspectWritePath(String.raw`c:\users\Ärger\wt\README.md`, scope)).toBeNull();
  });
});

describe("a name Windows reads as another spelling", () => {
  // The contract admits everything, so only a prohibited glob refuses a path
  // inside the root: each spelling below would be admitted if it were matched
  // against the globs as written.
  const everything = (target: string) =>
    inspectWritePath(
      target,
      resolveScope({ root: WINDOWS_ROOT, paths_prohibited: ["secrets/**", "**/*.pem"], semantics: "windows" }),
    );

  it("refuses a component ending in a dot or a space, which Windows strips", () => {
    expect(everything(WINDOWS_ROOT + String.raw`\specs.\auth\spec.md`)).not.toBeNull();
    expect(everything(WINDOWS_ROOT + "\\specs \\auth\\spec.md")).not.toBeNull();
    expect(everything(WINDOWS_ROOT + String.raw`\key.pem.`)).not.toBeNull();
  });

  it("refuses a stream, which names the file or directory it belongs to", () => {
    expect(everything(WINDOWS_ROOT + String.raw`\key.pem::$DATA`)).not.toBeNull();
    expect(everything(WINDOWS_ROOT + String.raw`\secrets::$INDEX_ALLOCATION\token`)).not.toBeNull();
  });

  it("refuses a short 8.3 name, which may stand for a long one", () => {
    expect(everything(WINDOWS_ROOT + String.raw`\SECRET~1\token`)).not.toBeNull();
  });

  it("admits a name with a tilde and a digit that is too long to be a short name", () => {
    expect(everything(WINDOWS_ROOT + String.raw`\notes\backup~1.json`)).toBeNull();
  });

  it("reads each of them as written under POSIX semantics", () => {
    const scope = resolveScope({ root: POSIX_ROOT, paths_prohibited: ["secrets/**"], semantics: "posix" });
    expect(inspectWritePath(POSIX_ROOT + "/secrets./token", scope)).toBeNull();
    expect(inspectWritePath(POSIX_ROOT + "/notes/a:b", scope)).toBeNull();
    expect(inspectWritePath(POSIX_ROOT + "/SECRET~1/token", scope)).toBeNull();
  });
});

describe("a drive with no root after it", () => {
  // Windows resolves `C:rest` against drive C's own current directory, which is
  // not the worktree and not the drive's root, so where it lands is unknown.
  it("refuses it as a write target, whatever follows the drive", () => {
    expect(windows(String.raw`C:README.md`)).toBe("refused");
    expect(windows(String.raw`C:..\Users\a\.perbo\worktrees\test program-8b\att_c5\README.md`)).toBe("refused");
    expect(windows("C:")).toBe("refused");
  });

  it("refuses it where no root is named, too", () => {
    // What `resolveScope()` gives on a Windows host: no root, Windows semantics.
    const scope: ResolvedScope = {
      semantics: "windows",
      root: null,
      base: null,
      baseUnknown: false,
      home: undefined,
      tmpdir: null,
      paths_allowed: [],
      paths_prohibited: [],
    };
    expect(inspectWritePath("C:notes.txt", scope)).not.toBeNull();
    expect(inspectWritePath("notes.txt", scope)).toBeNull();
  });

  it("does not take one as a worktree root", () => {
    expect(resolveScope({ root: "C:wt", paths_allowed: ALLOWED, semantics: "windows" }).root).toBeNull();
  });

  it("refuses it after a cd, in a shell line", () => {
    const scope = resolveScope({ root: WINDOWS_ROOT, paths_allowed: ALLOWED, semantics: "windows" });
    const line = String.raw`cd .. && echo x > 'C:Users\a\.perbo\worktrees\test program-8b\att_c5\README.md'`;
    expect(readCommandLine(line, scope).findings).not.toEqual([]);
  });
});

describe("a climb under Windows semantics", () => {
  const scope = resolveScope({ root: WINDOWS_ROOT, paths_allowed: ALLOWED, semantics: "windows" });

  it("admits a climb that comes back inside the worktree", () => {
    expect(windows(String.raw`C:\Users\..\Users\a\.perbo\worktrees\test program-8b\att_c5\README.md`)).toBe("allowed");
  });

  it("stops a relative climb at the drive it started on", () => {
    expect(inspectWritePath(String.raw`..\..\..\..\..\..\..\notes.txt`, scope)?.resolved).toBe("C:/notes.txt");
  });
});

describe("a backslash inside double quotes, which bash keeps", () => {
  it("is a separator under Windows semantics, so a climb out of the worktree is refused", () => {
    const text = resolveScope({ root: WINDOWS_ROOT, paths_allowed: ["**/*.txt"], semantics: "windows" });
    expect(readCommandLine(String.raw`echo x > "..\escape.txt"`, text).findings).not.toEqual([]);
    expect(readCommandLine(String.raw`printf x > "..\..\Windows\Temp\x.txt"`, text).findings).not.toEqual([]);
  });

  it("is part of the name under POSIX semantics", () => {
    const scope = resolveScope({ root: POSIX_ROOT, paths_allowed: ALLOWED, semantics: "posix" });
    // One top-level file whose name holds backslashes, not `tests/support/color.js`.
    expect(readCommandLine(String.raw`echo x > "tests\support\color.js"`, scope).findings).not.toEqual([]);
  });

  it("still escapes a quote and a backslash", () => {
    // Each glob names the one file the escaped word spells, so a backslash left
    // in the word would miss it.
    const scope = resolveScope({
      root: POSIX_ROOT,
      paths_allowed: ['tests/a"b.txt', String.raw`tests/a\b.txt`],
      semantics: "posix",
    });
    expect(readCommandLine(String.raw`echo x > "tests/a\"b.txt"`, scope).findings).toEqual([]);
    expect(readCommandLine(String.raw`echo x > "tests/a\\b.txt"`, scope).findings).toEqual([]);
  });
});

describe("a POSIX worktree root", () => {
  it("admits what the contract names and refuses what it does not", () => {
    expect(posix(POSIX_ROOT + "/README.md")).toBe("allowed");
    expect(posix(POSIX_ROOT + "/tests/support/color.js")).toBe("allowed");
    expect(posix(POSIX_ROOT + "/probe.tmp.txt")).toBe("refused");
    expect(posix("/etc/passwd")).toBe("refused");
    expect(posix(POSIX_ROOT + "/../../escape.txt")).toBe("refused");
  });

  it("does not fold case, so a path differing from the root only in case is outside it", () => {
    // A root that exists on no host: the resolver follows symlinks it finds on
    // disk, and on a case-insensitive volume `/HOME` reaches `/home`'s link, so
    // a real directory would test the host rather than the rule.
    const root = "/nonexistent-perbo-root/a/wt";
    const scope = resolveScope({ root, paths_allowed: ALLOWED, semantics: "posix" });
    expect(inspectWritePath("/NONEXISTENT-PERBO-ROOT/a/wt/README.md", scope)).not.toBeNull();
    expect(inspectWritePath("/nonexistent-perbo-root/a/wt/README.md", scope)).toBeNull();
  });

  it("refuses a filename that merely contains backslashes", () => {
    // A backslash is an ordinary filename character here, so this is ONE
    // top-level file called `tests\support\color.js` — not a file under
    // `tests/`. Reading it as a separator would check `tests/support/color.js`
    // against the globs, admit it under `tests/**`, and let the shell write a
    // destination the contract never admitted: the guard would be judging a
    // path that does not exist. It is refused, because the real one is
    // top-level and no glob names it.
    expect(posix(POSIX_ROOT + String.raw`/tests\support\color.js`)).toBe("refused");
    // And a drive letter is just a directory name on POSIX, so this is
    // relative to the root rather than an anchor of its own.
    expect(posix(POSIX_ROOT + String.raw`/C:\evil.txt`)).toBe("refused");
  });
});
