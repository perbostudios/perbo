import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { SymbolIndexSchema, type AdmittedSpec, type SymbolIndex } from "@perbo/contracts";
import type { SpecStaleness } from "./inspect.js";
import { headCommit, trackedFiles } from "./store.js";
import { symbolIndexPath, workingTree } from "./symbol-index.js";

/**
 * Whether a ticket's spec is still the one its contract was drafted from
 * (D-103).
 *
 * Two ways it stops being: the file has been edited since the bytes the
 * contract was approved from, or it has lost code — an `@Symbol` or a path —
 * that the repository had when the plan was approved. Either makes the spec
 * stale, and a stale spec is what `perbo run --ticket` refuses to start a
 * ticket on and what `perbo inspect` prints beside every ticket, running or
 * not. A ticket that has not been approved has no such moment, so its spec is
 * measured from admission and every sentence here says which of the two it
 * took.
 *
 * **Lost, and not merely absent.** Most of a spec describes work still to do:
 * "a new policy module at `packages/queue/retry-policy.ts` holds the backoff",
 * "@retryWithBackoff is exported from it". Asking only whether a name resolves
 * now answers no for every one of those, on the ticket's first run, before the
 * work it names has been written — and `plan_invalid` has no row out. So the
 * baseline is the set of names the repository had when the plan was approved,
 * recorded then on the admission record ({@link specBaseline}); a name
 * outside that set is work the plan is for and is never judged, and the whole
 * set is unjudged for a record written before it existed.
 *
 * Nothing here judges a spelling. Every path is resolved first and judged on
 * where it lands, because a record travels between checkouts and a folder on
 * the way may be a link: `specs/../specs/x/spec.md` and an absolute path into
 * the checkout are the same file, and a path that resolves outside the
 * repository is not one the repository has however it is written.
 *
 * What cannot be judged is said rather than guessed. The symbol index is a
 * cache with a commit stamped on it and nothing keeps it fresh (D-015), so a
 * name missing from an index built at another commit is not evidence, and
 * neither is one missing from an index that skipped a file it might have been
 * declared in. Both are reported as unjudged: a false "stale" would take an
 * approved ticket off the queue over a name that is still there.
 *
 * The third of those is the one a person cannot fix afterwards. An index that
 * could not be believed *at approval* put no `@Symbol` in the baseline, so no
 * reading of that ticket can ever call one stale — and the record says that
 * happened, so every reading says so instead of calling the spec current over
 * a name that has gone.
 */

const sha256 = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * A symbol a spec names: `@` and an identifier.
 *
 * Not preceded by a word character, so the local part of an address is not one,
 * and not by `/`, so the `@someuser` inside a URL is part of the URL. Not
 * followed by `/`, so a scoped package name such as `@perbo/contracts` is the
 * package it is rather than a symbol called `perbo`, and not by `(`, so a
 * decorator written as `@Injectable()` is not read as a name this repository
 * ought to export.
 *
 * Not `spec-text.ts`'s `specSymbolNames`, the reading the Spec pane completes
 * from and marks by and the impact warnings look up: that reading takes `/`
 * and `(` as ordinary characters after a name, so it would read `@perbo` out
 * of `@perbo/contracts` and `@Injectable` out of `@Injectable()` — both
 * names nothing here exports, and both wrong to call stale. A false "stale"
 * takes an approved ticket off the queue, which is the more expensive
 * mistake, so this reading stays narrower than the shared one rather than
 * matching it.
 */
const SYMBOL = /(?<![A-Za-z0-9_$@/])@([A-Za-z_$][A-Za-z0-9_$]*)(?![A-Za-z0-9_$/(])/g;

/** The `@Symbol` names a spec's text holds, each once, in the order it names them. */
function namedSymbols(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(SYMBOL)].map((match) => match[1]!))];
}

/** Opens or closes a fenced block: three or more backticks or tildes, indented at most three. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A spec's text with its fenced blocks taken out.
 *
 * Both readers below run over prose. A fence holds code, and code in a spec is
 * usually either somebody else's — `@Injectable()`, an import from a package —
 * or the shape of what the ticket is about to write. Neither is the spec
 * claiming this repository has the name. Inline spans stay: a path in prose is
 * nearly always written in one.
 *
 * An unclosed fence swallows the rest of the document, which is the direction
 * to be wrong in — a name not read is a name nothing calls stale.
 */
function outsideFences(markdown: string): string {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of markdown.split("\n")) {
    const mark = FENCE.exec(line)?.[1]![0] ?? null;
    if (open === null) {
      if (mark === null) kept.push(line);
      else open = mark;
    } else if (mark === open) {
      open = null;
    }
  }
  return kept.join("\n");
}

/**
 * A token with the Markdown emphasis it was written in taken off.
 *
 * A spec is Markdown and bolding the path under discussion is ordinary, so
 * `**packages/queue/retry.ts**` names the file that `packages/queue/retry.ts`
 * names. A glob is kept out by the charset a path token has to be spelled in
 * ({@link namedPaths}) and not by anything here.
 *
 * What the balance does decide is where the run ends. `**_internal/retry.ts**`
 * opens with three characters this could take and closes with two, and only
 * matching the close to the open stops the leading `_` of a real directory
 * being eaten with the emphasis.
 */
function unemphasised(token: string): string {
  const opened = /^([*_]{1,3})(.+?)\1$/.exec(token);
  return opened === null ? token : opened[2]!;
}

/**
 * The paths a spec's text names, each once.
 *
 * A path is a token with a separator in it that ends in a file extension: a
 * glob names a set rather than a file and a URL names something that is not
 * here, so neither is one. Narrow, though not the thing keeping a wrong reading
 * from costing a ticket — that is the baseline, which a token nothing ever
 * resolved never reaches. What narrowness buys is the other direction: a token
 * this does not recognise is a path nothing judges, so a version string read as
 * a path is harmless and a real path missed is a lost file nobody is told about.
 */
function namedPaths(markdown: string): string[] {
  const found = new Set<string>();
  for (const raw of markdown.split(/[\s`"'()[\]{}<>,;|]+/)) {
    // Sentence punctuation first, then emphasis: a bolded path ending a
    // sentence is written `**packages/queue/retry.ts**.`, and taking the
    // emphasis off first would leave a run that no longer ends the token, so
    // the path would be dropped.
    const token = unemphasised(raw.replace(/[.:!?]+$/, ""));
    if (token.length === 0 || token.includes("://")) continue;
    if (!/[\\/]/.test(token)) continue;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(token)) continue;
    // The charset is what keeps a glob out: `*` is not in it, so
    // `packages/queue/*.ts` names a set rather than the file it looks like.
    if (!/^[A-Za-z0-9_.$+@~\-\\/:]+$/.test(token)) continue;
    found.add(token);
  }
  return [...found];
}

/**
 * Where a repository-relative path lands, or why it lands nowhere in this
 * repository.
 *
 * Resolved against the repository root and then `realpath`ed, rather than
 * judged as a spelling. `resolve` collapses `.` and `..` textually before the
 * disk is touched — so a `..` climbs the written path and not the one on disk
 * — and leaves a spelling this platform calls absolute where it is; `realpath`
 * is what follows the links in what is left, and what makes `docs/away/x.ts`
 * through a link out of the checkout read as outside it. A backslash is a
 * separator here whatever platform is reading, because a spec written on
 * Windows is read on every other machine that clones the repository.
 *
 * Note `resolve` and nothing hand-rolled beside it. A drive letter is absolute
 * on Windows, where `resolve` knows it, and an ordinary directory name
 * everywhere else, where it is judged against this repository like any other
 * relative path. Calling it absolute on every platform would hand `C:/x.ts` to
 * `realpath` unresolved, and answer about the directory the CLI happened to be
 * started in rather than about this checkout.
 */
function resolveInside(
  repositoryRoot: string,
  inside: string,
  named: string,
): { real: string } | { problem: string } {
  const absolute = resolve(repositoryRoot, named.split("\\").join("/"));
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return { problem: "is not in the repository" };
  }
  if (real !== inside && !real.startsWith(inside + sep)) {
    return { problem: `resolves to ${real}, outside the repository` };
  }
  return { real };
}

/**
 * A named path as git would spell it from the repository root.
 *
 * Resolved lexically and not through its links, because what this is asked for
 * is what git has filed under that name: a link inside the checkout is not the
 * file it points at, and a clone that never had the link never had the name.
 * A spelling that climbs out of the repository comes back with its `..` still
 * on it, which no listing of tracked files holds.
 */
function repositoryRelative(repositoryRoot: string, named: string): string {
  const root = resolve(repositoryRoot);
  return relative(root, resolve(root, named.split("\\").join("/"))).split(sep).join("/");
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message.split("\n")[0]! : String(error);

/** The index this repository last built, or why it is not evidence about this checkout. */
function currentIndex(repositoryRoot: string): { index: SymbolIndex } | { problem: string } {
  const path = symbolIndexPath(repositoryRoot);
  let parsed: SymbolIndex;
  try {
    parsed = SymbolIndexSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return {
      problem:
        `the symbol index at ${path} could not be read (${describe(error)}), so the ` +
        "symbols this spec names are not judged: build it with perbo index",
    };
  }
  let head: string;
  let tree: "clean" | "modified";
  try {
    head = headCommit(repositoryRoot);
    tree = workingTree(repositoryRoot);
  } catch (error) {
    return { problem: `the checkout at ${repositoryRoot} cannot be read: ${describe(error)}` };
  }
  // Three clauses, because the index is evidence about one tree and each of
  // them is a different tree. A commit that has moved, an index built over
  // uncommitted changes, and a checkout that carries them now: under any of
  // them the names in the record are not the names on disk.
  if (parsed.head_commit !== head) {
    return {
      problem:
        `the symbol index was built at ${parsed.head_commit.slice(0, 7)} and this checkout is at ` +
        `${head.slice(0, 7)}, so the symbols this spec names are not judged: rebuild it with perbo index`,
    };
  }
  if (parsed.working_tree === "modified") {
    return {
      problem:
        "the symbol index was built over uncommitted changes, so the symbols this spec names " +
        "are not judged: commit them and rebuild it with perbo index",
    };
  }
  if (tree === "modified") {
    return {
      problem:
        "this checkout carries uncommitted changes the symbol index was not built over, so the " +
        "symbols this spec names are not judged: rebuild it with perbo index",
    };
  }
  return { index: parsed };
}

/**
 * What approval records about the spec: the names this repository has that the
 * spec carries, the bytes they were read from, and whether the symbol index
 * could be believed while it was read.
 *
 * One read answers the first two, because they are one answer about one
 * moment. Taking the hash separately would let the file move between them, and
 * the pair would then describe two different specs — a baseline of names from
 * before an edit, beside a hash from after it.
 *
 * **The names.** A path is here if git tracks it *and* it resolves inside the
 * checkout, and an `@Symbol` if the index holds it. Everything else the spec
 * names is work the plan is for, and a name left out here is a name nothing
 * will ever call stale — which is why an index that cannot be believed
 * contributes no symbols at all rather than a guess, and why an unreadable
 * checkout or spec records nothing. Wrong in this direction costs a reading;
 * wrong in the other costs a ticket.
 *
 * Tracked, because the record travels and the untracked half of a checkout
 * does not. A spec naming a build output — `apps/cli/dist/reader.js` — names a
 * file this machine has and no clone of the repository does, and recording it
 * would have a fresh clone read the spec as one that has lost a file.
 *
 * **The hash** is what makes "stale" mean **edited after approval**, which is
 * what [D-103](../../../docs/11-open-decisions.md) says it means. Admission's
 * own hash is taken when the contract is drafted, and between drafting and
 * approving is exactly when a person reads the draft and edits the spec — so
 * judging against admission's hash would call the ordinary path stale and
 * leave the ticket at `plan_invalid`, which has no row out. A spec that
 * cannot be read leaves the hash null, and the reading side keeps admission's:
 * wrong in that direction usually costs only a reading, except on the
 * intersection of a `plan_review` edit and a spec unreadable at approval,
 * where admission's hash is what the ticket's first run is judged against and
 * costs the ticket instead. Recording a hash of bytes nobody read would cost
 * a ticket outright.
 *
 * **Whether the index could be believed** is recorded because the answer
 * outlives this moment. Approving over a checkout with uncommitted changes in
 * tracked files records no `@Symbol` at all — and a spec edited in
 * `plan_review`, which is the ordinary thing to do while reading the draft, is
 * itself such a change. Without this flag that half of the baseline would go
 * missing in silence and every later reading would call the spec current over
 * a name that had gone. It is asked of the index alone and before the spec is
 * read, so it says what it says whatever else this read fails on.
 */
export function specBaseline(args: { repositoryRoot: string; specPath: string }): {
  names: string[];
  content_sha256: string | null;
  symbols_judged: boolean;
} {
  const read = currentIndex(args.repositoryRoot);
  const index = "problem" in read ? null : read.index;
  const nothing = { names: [], content_sha256: null, symbols_judged: index !== null };
  let inside: string;
  try {
    inside = realpathSync(args.repositoryRoot);
  } catch {
    return nothing;
  }
  const at = resolveInside(args.repositoryRoot, inside, args.specPath);
  if ("problem" in at) return nothing;
  let bytes: Buffer;
  try {
    bytes = readFileSync(at.real);
  } catch {
    return nothing;
  }
  const text = outsideFences(bytes.toString("utf8"));
  const content_sha256 = sha256(bytes);
  const exported = new Set(
    index === null ? [] : index.files.flatMap((file) => file.exports.map((each) => each.name)),
  );
  const tracked = new Set(trackedFiles(args.repositoryRoot));
  const names = [
    ...namedPaths(text).filter((named) => {
      if (!tracked.has(repositoryRelative(args.repositoryRoot, named))) return false;
      // Tracked answers what git has under the name; this answers where the
      // name lands, which for a tracked link out of the checkout is not here.
      return !("problem" in resolveInside(args.repositoryRoot, inside, named));
    }),
    ...namedSymbols(text)
      .filter((name) => exported.has(name))
      .map((name) => `@${name}`),
  ];
  return { names, content_sha256, symbols_judged: index !== null };
}

/**
 * The staleness of the spec a ticket was drafted from, or `null` where no spec
 * was: a ticket admitted from an issue, a file or the command line has none,
 * and inventing an answer for it would put a reading beside work it is not
 * about.
 */
export function specStaleness(args: {
  /** The checkout the ticket's work happens in, resolved. */
  repositoryRoot: string;
  /**
   * Whether this ticket's contract has been approved — `approved_at`, which is
   * written once and never cleared.
   *
   * It decides which moment the reading is against, and every sentence below
   * says which. An approved contract is measured from approval: that is the
   * statement a person signed, and D-103 makes an edit after it the stale one.
   * A ticket still in `plan_review` has no such moment, so it is measured from
   * admission — and an edit made there is the ordinary thing to do while
   * reading the draft rather than something wrong.
   */
  approved: boolean;
  /**
   * The ticket's `admission.spec`: the four fields this reads, rather than the
   * whole record, so the display reading of a ticket file — which is loose
   * everywhere the strict schema is not — satisfies it too. A record from
   * before approval recorded a baseline carries the key with no value or no key
   * at all, and the two are one answer.
   */
  spec:
    | (Pick<AdmittedSpec, "path" | "content_sha256"> & {
        names_that_resolved?: string[] | null | undefined;
        symbols_judged_at_approval?: boolean | undefined;
      })
    | null;
}): SpecStaleness | null {
  const recorded = args.spec;
  if (recorded === null) return null;
  const stale: string[] = [];
  const unjudged: string[] = [];
  const judged_against = args.approved ? "approval" : "admission";
  const answer = (): SpecStaleness => ({ path: recorded.path, judged_against, stale, unjudged });

  // The checkout every path below is judged against, resolved once. A
  // repository this cannot read answers nothing rather than answering stale:
  // a spec is not the thing at fault when its checkout is missing.
  let inside: string;
  try {
    inside = realpathSync(args.repositoryRoot);
  } catch (error) {
    unjudged.push(
      `${args.repositoryRoot} cannot be read (${describe(error)}), so nothing about ` +
        `${recorded.path} is judged`,
    );
    return answer();
  }

  const at = resolveInside(args.repositoryRoot, inside, recorded.path);
  if ("problem" in at) {
    stale.push(`${recorded.path}, which the contract was drafted from, ${at.problem}`);
    return answer();
  }
  let markdown: Buffer;
  try {
    markdown = readFileSync(at.real);
  } catch (error) {
    stale.push(`${recorded.path} cannot be read: ${describe(error)}`);
    return answer();
  }
  const found = sha256(markdown);
  if (found !== recorded.content_sha256) {
    stale.push(
      `${recorded.path} has been edited since the contract was ` +
        `${args.approved ? "approved" : "drafted"} from it: the record holds ` +
        `${recorded.content_sha256} and the file is ${found}`,
    );
  }

  const text = outsideFences(markdown.toString("utf8"));
  // The baseline, and what to do without one. A record approved before the
  // list existed has nothing saying which of these names the repository ever
  // had, so none of them is evidence either way and all of them are said —
  // the same reading an index that cannot be believed gets, for the same
  // reason. The spec's own bytes are judged above and are judged regardless.
  const baseline = recorded.names_that_resolved ?? null;
  if (baseline === null) {
    const names = [...namedPaths(text), ...namedSymbols(text).map((name) => `@${name}`)];
    if (names.length > 0) {
      unjudged.push(
        args.approved
          ? `${recorded.path} was approved before the names it carries were recorded, so nothing ` +
            `says which of ${names.join(", ")} this repository ever had: admit this work again to ` +
            "judge them"
          : `${recorded.path} has not been approved, so nothing yet says which of ` +
            `${names.join(", ")} this repository has: approving this contract records them`,
      );
    }
    return answer();
  }
  const had = new Set(baseline);

  for (const named of namedPaths(text)) {
    if (!had.has(named)) continue;
    const landed = resolveInside(args.repositoryRoot, inside, named);
    if ("problem" in landed) stale.push(`${recorded.path} names ${named}, which ${landed.problem}`);
  }

  // The half approval could not take. `symbols_judged_at_approval` is false
  // where the index was not evidence about the tree the plan was signed
  // against, so no `@Symbol` reached the baseline and `had` cannot separate a
  // name this repository has lost from one the plan is for. Every name in the
  // spec is said instead of none of them being judged in silence. Absent is
  // true: a record written before the field was recorded was written by a
  // version that took the baseline the same way, and nothing about it changed.
  if (recorded.symbols_judged_at_approval === false) {
    const named = namedSymbols(text);
    if (named.length > 0) {
      unjudged.push(
        `${recorded.path} names ${named.map((name) => `@${name}`).join(", ")}, and the symbol ` +
          "index could not be believed when this contract was approved, so nothing says which of " +
          "them this repository had then: commit what the checkout is carrying, rebuild it with " +
          "perbo index, and admit this work again to judge them",
      );
    }
    return answer();
  }

  const symbols = namedSymbols(text).filter((name) => had.has(`@${name}`));
  if (symbols.length > 0) {
    const read = currentIndex(args.repositoryRoot);
    if ("problem" in read) {
      unjudged.push(read.problem);
    } else {
      const exported = new Set(read.index.files.flatMap((file) => file.exports.map((each) => each.name)));
      const gone = symbols.filter((name) => !exported.has(name));
      // A name the index does not hold is only evidence where the index read
      // everything: a file it skipped may declare the very name being asked
      // about, and marking it gone would be wrong in the direction that costs
      // a person their ticket.
      if (gone.length > 0 && read.index.skipped.length > 0) {
        unjudged.push(
          `${recorded.path} names ${gone.map((name) => `@${name}`).join(", ")}, which the symbol ` +
            `index does not hold; it skipped ${read.index.skipped.map((file) => file.path).join(", ")}, ` +
            "so nothing here says the name is gone",
        );
      } else {
        for (const name of gone) {
          stale.push(`${recorded.path} names @${name}, which nothing in the repository exports`);
        }
      }
    }
  }
  return answer();
}
