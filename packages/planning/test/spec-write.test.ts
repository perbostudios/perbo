import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_SPEC_FOLDER } from "@perbo/contracts";
import {
  MAX_SPEC_SLUG_LENGTH,
  PlanningError,
  parseSpec,
  readSpecSections,
  readSpecText,
  renderSpec,
  specSlug,
  specTitleFromMessage,
  writeSpecFile,
  EMPTY_SPEC_TEXT,
  SpecConflict,
  type SpecText,
  type WrittenSpec,
} from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-spec-write-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let repos = 0;
const repository = (): string => {
  const root = join(scratch, `repo-${repos++}`);
  mkdirSync(root, { recursive: true });
  return root;
};

const text = (over: Partial<SpecText> = {}): SpecText => ({
  title: "Activation email",
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  requirements: "- A signup POST queues exactly one activation email.\n- A duplicate signup queues nothing.",
  no_gos: "- Nothing is sent to an address that has unsubscribed.",
  rabbit_holes: "- Templating: the existing template stays.",
  notes: "The queue package already has a sender.",
  ...over,
});

/**
 * Write a spec having just read it, which is what a caller with nothing else
 * to say does: `base` is the file as it stands, so none of these is a write
 * against a stale read. The tests that hold a base from earlier on purpose are
 * in the last describe block, which is what the staleness is about.
 */
const write = (args: Omit<Parameters<typeof writeSpecFile>[0], "base">): WrittenSpec => {
  const at = join(
    args.repositoryRoot,
    ...(args.folder ?? DEFAULT_SPEC_FOLDER).split("/"),
    args.slug ?? specSlug(args.text.title),
    "spec.md",
  );
  return writeSpecFile({
    ...args,
    base: existsSync(at) ? readSpecText(at).text : EMPTY_SPEC_TEXT,
  });
};

describe("the slug a spec's folder takes", () => {
  it("is the title, lowercased, with every run of anything else one hyphen", () => {
    expect(specSlug("Activation email")).toBe("activation-email");
    expect(specSlug("  A light mode — for the *whole* app!  ")).toBe("a-light-mode-for-the-whole-app");
    expect(specSlug("SCP-336: specs as folders")).toBe("scp-336-specs-as-folders");
    expect(specSlug("v2.1 export")).toBe("v2-1-export");
    // Deterministic: the same title is the same folder, however often it is asked.
    expect(specSlug("Activation email")).toBe(specSlug("Activation  email"));
  });

  it("caps its length without leaving a trailing hyphen", () => {
    const slug = specSlug(`${"word ".repeat(40)}end`);
    expect(slug.length).toBeLessThanOrEqual(MAX_SPEC_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("word-word")).toBe(true);
  });

  it("refuses a title no slug can be made from, rather than inventing a folder name", () => {
    for (const title of ["", "   ", "—— ***", "。、。"]) {
      expect(() => specSlug(title)).toThrow(PlanningError);
    }
    expect(() => specSlug("***")).toThrow(/title/i);
  });
});

describe("writing a spec", () => {
  it("creates specs/ and specs/<slug>/ when they are missing, in the form parseSpec reads", () => {
    const root = repository();
    expect(existsSync(join(root, "specs"))).toBe(false);
    const written = write({ repositoryRoot: root, text: text() });
    expect(written.slug).toBe("activation-email");
    expect(written.created).toBe(true);
    expect(written.path).toBe(join(root, "specs", "activation-email", "spec.md"));
    expect(existsSync(written.path)).toBe(true);

    const parsed = parseSpec(readFileSync(written.path, "utf8"));
    expect(parsed.title).toBe("Activation email");
    expect(parsed.outcome).toBe(
      "New users receive an activation email within 60 seconds of signing up.",
    );
    expect(parsed.requirements).toEqual([
      { id: "R1", text: "A signup POST queues exactly one activation email." },
      { id: "R2", text: "A duplicate signup queues nothing." },
    ]);
    expect(parsed.no_gos).toEqual(["Nothing is sent to an address that has unsubscribed."]);
    expect(parsed.rabbit_holes).toEqual(["Templating: the existing template stays."]);
    expect(parsed.notes).toBe("The queue package already has a sender.");
  });

  it("writes a folder named by the configured spec folder instead of specs/", () => {
    const root = repository();
    const written = write({ repositoryRoot: root, folder: "docs/specs", text: text() });
    expect(written.path).toBe(join(root, "docs", "specs", "activation-email", "spec.md"));
    expect(written.folder).toBe("docs/specs/activation-email");
  });

  it("refuses a second spec whose title takes a slug this repository already holds", () => {
    const root = repository();
    write({ repositoryRoot: root, text: text() });
    expect(() => write({ repositoryRoot: root, text: text() })).toThrow(
      /specs\/activation-email/,
    );
    // The same folder, named as the one being rewritten, is the edit rather than a second spec.
    const again = write({ repositoryRoot: root, slug: "activation-email", text: text() });
    expect(again.created).toBe(false);
    expect(again.slug).toBe("activation-email");
  });

  it("leaves a supporting file beside spec.md alone, and never reads one as input", () => {
    const root = repository();
    const written = write({ repositoryRoot: root, text: text() });
    const beside = join(root, "specs", "activation-email", "measurements.md");
    writeFileSync(beside, "# Measurements\n\n## Not A Heading A Spec Has\n\n- R9: never read\n");
    const after = write({
      repositoryRoot: root,
      slug: written.slug,
      text: text({
        requirements:
          "- R1: A signup POST queues exactly one activation email.\n" +
          "- R2: A duplicate signup queues nothing.\n- A failed send is retried.",
      }),
    });
    expect(readFileSync(beside, "utf8")).toContain("R9: never read");
    // R9 is in the file beside the spec, so the new requirement is R3 and not R10.
    expect(after.requirements.map((each) => each.id)).toEqual(["R1", "R2", "R3"]);
  });
});

describe("where the spec is written", () => {
  it("refuses a spec folder that is a symlink, so nothing is written outside the repository", () => {
    const root = repository();
    const elsewhere = join(scratch, `elsewhere-${repos++}`);
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(root, "specs"));
    expect(() => write({ repositoryRoot: root, text: text() })).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "activation-email"))).toBe(false);
  });

  it("refuses a link however the folder is spelled, a `..` on the way included", () => {
    const root = repository();
    const elsewhere = join(scratch, `elsewhere-${repos++}`);
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(root, "specs"), { recursive: true });
    symlinkSync(elsewhere, join(root, "specs", "activation-email"));
    expect(() =>
      write({ repositoryRoot: root, folder: "nope/../specs", text: text() }),
    ).toThrow(PlanningError);
    expect(existsSync(join(elsewhere, "spec.md"))).toBe(false);
  });

  it("names a repository that does not exist, rather than failing on the way to it", () => {
    expect(() =>
      write({ repositoryRoot: join(scratch, "no-such-repository"), text: text() }),
    ).toThrow(PlanningError);
  });

  it("refuses a spec.md that is a symlink, dangling or not", () => {
    const root = repository();
    const elsewhere = join(scratch, `elsewhere-${repos++}`);
    mkdirSync(join(root, "specs", "activation-email"), { recursive: true });
    symlinkSync(join(elsewhere, "spec.md"), join(root, "specs", "activation-email", "spec.md"));
    expect(() =>
      write({ repositoryRoot: root, slug: "activation-email", text: text() }),
    ).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "spec.md"))).toBe(false);
  });

  it("refuses a link before reading what it points at", () => {
    const root = repository();
    const elsewhere = join(scratch, `elsewhere-${repos++}`);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(elsewhere, "spec.md"),
      "# Another repository's spec\n\n## Outcome\n\nSomething from outside.\n",
    );
    mkdirSync(join(root, "specs", "activation-email"), { recursive: true });
    symlinkSync(join(elsewhere, "spec.md"), join(root, "specs", "activation-email", "spec.md"));

    let refusal: unknown;
    try {
      // A first save: this writer has read nothing, and what the link names is
      // nothing it wrote.
      writeSpecFile({
        repositoryRoot: root,
        slug: "activation-email",
        base: EMPTY_SPEC_TEXT,
        text: text(),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PlanningError);
    expect((refusal as Error).message).toMatch(/symlink/);
    // Not a clash between two writers: the link is refused before anything
    // reads what it names, so no text from outside the repository is carried
    // back to whoever asked for the write.
    expect(refusal).not.toBeInstanceOf(SpecConflict);
    expect((refusal as { current?: unknown }).current).toBeUndefined();
    expect(readFileSync(join(elsewhere, "spec.md"), "utf8")).toContain("Something from outside.");
  });

  it("refuses a spec's own folder that is a symlink", () => {
    const root = repository();
    const elsewhere = join(scratch, `elsewhere-${repos++}`);
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(root, "specs"), { recursive: true });
    symlinkSync(elsewhere, join(root, "specs", "activation-email"));
    expect(() => write({ repositoryRoot: root, text: text() })).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "spec.md"))).toBe(false);
  });
});

describe("a requirement's id", () => {
  it("is given when the requirement is written, R1 upward", () => {
    const root = repository();
    const written = write({ repositoryRoot: root, text: text() });
    expect(written.requirements).toEqual([
      { id: "R1", text: "A signup POST queues exactly one activation email." },
      { id: "R2", text: "A duplicate signup queues nothing." },
    ]);
  });

  it("stays with its requirement when the text is edited", () => {
    const root = repository();
    const first = write({ repositoryRoot: root, text: text() });
    const edited = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({
        requirements:
          "- R1: A signup POST queues exactly one activation email, once.\n" +
          "- R2: A duplicate signup queues nothing.",
      }),
    });
    expect(edited.requirements).toEqual([
      { id: "R1", text: "A signup POST queues exactly one activation email, once." },
      { id: "R2", text: "A duplicate signup queues nothing." },
    ]);
  });

  it("is absent, and so is the mark, while the spec has no requirement", () => {
    const root = repository();
    const written = write({ repositoryRoot: root, text: text({ requirements: "" }) });
    expect(written.requirements).toEqual([]);
    const read = readSpecText(written.path);
    expect(read.requirements).toEqual([]);
    expect(read.text.requirements).toBe("");
    expect(read.highWater).toBe(0);
  });

  it("stays with its requirement when the requirement is written again without its id", () => {
    const root = repository();
    const first = write({ repositoryRoot: root, text: text() });
    // The same two sentences arrive unnumbered, as an editor that had not read
    // the file back sends them.
    const again = write({ repositoryRoot: root, slug: first.slug, text: text() });
    expect(again.requirements).toEqual(first.requirements);
    // A new sentence still takes the next id past the mark.
    const added = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({ requirements: `${text().requirements}\n- A failed send is retried.` }),
    });
    expect(added.requirements.map((each) => each.id)).toEqual(["R1", "R2", "R3"]);
  });

  it("goes to the line that names it, not to one that repeats the old text", () => {
    const root = repository();
    const first = write({ repositoryRoot: root, text: text() });
    // R2's sentence is written again unnumbered, and R2 itself is given new text.
    const edited = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({
        requirements:
          "- R1: A signup POST queues exactly one activation email.\n" +
          "- A duplicate signup queues nothing.\n" +
          "- R2: A duplicate signup is refused.",
      }),
    });
    expect(edited.requirements).toEqual([
      { id: "R1", text: "A signup POST queues exactly one activation email." },
      { id: "R3", text: "A duplicate signup queues nothing." },
      { id: "R2", text: "A duplicate signup is refused." },
    ]);
  });

  it("is never given twice, even where the file names one on a line without its bullet", () => {
    const root = repository();
    const first = write({
      repositoryRoot: root,
      text: text({ requirements: "- A signup POST queues exactly one activation email." }),
    });
    // A hand-edited file: R1 named on a plain line, no mark below it.
    writeFileSync(
      first.path,
      readFileSync(first.path, "utf8")
        .replace("- R1: A signup POST", "R1: A signup POST")
        .replace(/\n<!--[^\n]*-->\n/, "\n"),
    );
    const again = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({ requirements: "A signup POST queues exactly one activation email.\ntwo" }),
    });
    expect(again.requirements.map((each) => each.id)).toEqual(["R1", "R2"]);
    expect(parseSpec(readFileSync(first.path, "utf8")).requirements.map((each) => each.id)).toEqual([
      "R1",
      "R2",
    ]);
  });

  it("counts toward the mark on an indented list item, as the reader takes one", () => {
    const root = repository();
    const first = write({
      repositoryRoot: root,
      text: text({ requirements: "- A parent requirement.\n- A child requirement." }),
    });
    // A hand-edited file: the child nested under its parent, and no mark.
    writeFileSync(
      first.path,
      readFileSync(first.path, "utf8")
        .replace("- R2: A child requirement.", "  - R2: A child requirement.")
        .replace(/\n<!--[^\n]*-->\n/, "\n"),
    );
    expect(readSpecText(first.path).highWater).toBe(2);
    write({ repositoryRoot: root, slug: first.slug, text: text({ requirements: "- R1: A parent requirement." }) });
    const added = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({ requirements: "- R1: A parent requirement.\n- Another requirement." }),
    });
    expect(added.requirements.map((each) => each.id)).toEqual(["R1", "R3"]);
  });

  it("is refused where the text names it twice", () => {
    const root = repository();
    expect(() =>
      write({
        repositoryRoot: root,
        text: text({ requirements: "- R1: one\n- R1: two" }),
      }),
    ).toThrow(/R1 twice/);
  });

  it("is never reused after its requirement is removed, and a re-read keeps the ids", () => {
    const root = repository();
    const first = write({ repositoryRoot: root, text: text() });
    expect(first.requirements.map((each) => each.id)).toEqual(["R1", "R2"]);

    // R2 goes...
    const removed = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({ requirements: "- R1: A signup POST queues exactly one activation email." }),
    });
    expect(removed.requirements.map((each) => each.id)).toEqual(["R1"]);

    // ...and the next requirement written is R3, because R2 was used once.
    const added = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({
        requirements:
          "- R1: A signup POST queues exactly one activation email.\n- A failed send is retried.",
      }),
    });
    expect(added.requirements).toEqual([
      { id: "R1", text: "A signup POST queues exactly one activation email." },
      { id: "R3", text: "A failed send is retried." },
    ]);

    // Reading the file back gives the same ids: nothing is renumbered by a read.
    const read = readSpecText(added.path);
    expect(read.requirements.map((each) => each.id)).toEqual(["R1", "R3"]);
    expect(read.text.title).toBe("Activation email");
    // And writing what was read back changes nothing at all.
    const again = write({ repositoryRoot: root, slug: first.slug, text: read.text });
    expect(again.requirements.map((each) => each.id)).toEqual(["R1", "R3"]);
    expect(readFileSync(again.path, "utf8")).toBe(readFileSync(added.path, "utf8"));
  });

  it("survives a file whose highest id is gone, because the mark is kept in the file", () => {
    const root = repository();
    const first = write({ repositoryRoot: root, text: text() });
    write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({ requirements: "- R1: one\n- R2: two\n- three\n- four" }),
    });
    // R1..R4 have been used; dropping every one of them past R1 must not free them.
    const shrunk = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({ requirements: "- R1: one" }),
    });
    expect(readSpecText(shrunk.path).highWater).toBe(4);
    const grown = write({
      repositoryRoot: root,
      slug: first.slug,
      text: text({ requirements: "- R1: one\n- five" }),
    });
    expect(grown.requirements.map((each) => each.id)).toEqual(["R1", "R5"]);
  });

  it("keeps the mark where parseSpec does not read it as a requirement", () => {
    const root = repository();
    const written = write({ repositoryRoot: root, text: text() });
    const markdown = readFileSync(written.path, "utf8");
    expect(markdown).toMatch(/<!--\s*perbo:requirement-ids/);
    expect(parseSpec(markdown).requirements).toHaveLength(2);
  });
});

/**
 * SCP-321: `writeSpecFile` is what a pane's own save calls — the Spec pane and
 * the Impact pane's No-Go action. The interview writes the same `spec.md`
 * through its own tools and never calls this. Every write through here says
 * what it read, and the check is on the sections the file holds at the moment
 * of the write, never on when anybody last looked (D-102, D-103).
 */
describe("a write against a spec that has moved", () => {
  /** Write, having read the file first: what every caller does but the tests above. */
  const settled = (root: string, slug: string, over: Partial<SpecText> = {}) => {
    const path = join(root, "specs", slug, "spec.md");
    const base = existsSync(path) ? readSpecText(path).text : EMPTY_SPEC_TEXT;
    return writeSpecFile({ repositoryRoot: root, slug, base, text: { ...base, ...over } });
  };

  const started = (): { root: string; slug: string; base: SpecText } => {
    const root = repository();
    const written = writeSpecFile({ repositoryRoot: root, base: EMPTY_SPEC_TEXT, text: text() });
    return { root, slug: written.slug, base: readSpecText(written.path).text };
  };

  /**
   * Two writers that reached the same words have nothing to settle.
   *
   * A refusal asks a person to choose between two texts, so it has to be
   * between two texts. The No-Go action is the case that makes this ordinary:
   * `withNoGo` is idempotent by design, so if the interview has already written
   * the line the pane is about to add, the pane's text and the file's are
   * character-for-character the same — and refusing would have shown a person
   * two identical passages and asked which they wanted.
   */
  it("writes a section both sides changed to the same words, rather than refusing", () => {
    const { root, slug, base } = started();
    const agreed = "The sentence both of them wrote.";
    settled(root, slug, { outcome: agreed });

    const written = writeSpecFile({
      repositoryRoot: root,
      slug,
      base,
      text: { ...base, outcome: agreed },
    });
    expect(readSpecText(written.path).text.outcome).toBe(agreed);
  });

  it("refuses a section both the writer and the file changed, and writes nothing", () => {
    const { root, slug, base } = started();
    settled(root, slug, { outcome: "The interview's sentence." });
    const before = readFileSync(join(root, "specs", slug, "spec.md"), "utf8");

    let refusal: unknown;
    try {
      writeSpecFile({
        repositoryRoot: root,
        slug,
        base,
        text: { ...base, outcome: "The person's sentence." },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SpecConflict);
    expect((refusal as SpecConflict).conflicting).toEqual(["outcome"]);
    expect((refusal as SpecConflict).current.outcome).toBe("The interview's sentence.");
    // Nothing landed: a refused write is not half a write.
    expect(readFileSync(join(root, "specs", slug, "spec.md"), "utf8")).toBe(before);
  });

  /**
   * The case above changes only the section that conflicts, so a writer that
   * merged and wrote the non-conflicting sections before throwing would leave
   * the same bytes it should when it writes nothing at all. Here the writer
   * also changes a section the file did not, which a half write would still
   * write.
   */
  it("writes nothing at all when refused, not even a section the file itself did not touch", () => {
    const { root, slug, base } = started();
    settled(root, slug, { outcome: "The interview's sentence." });
    const before = readFileSync(join(root, "specs", slug, "spec.md"), "utf8");

    let refusal: unknown;
    try {
      writeSpecFile({
        repositoryRoot: root,
        slug,
        base,
        text: { ...base, outcome: "The person's sentence.", notes: "The person's note." },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SpecConflict);
    expect((refusal as SpecConflict).conflicting).toEqual(["outcome"]);
    expect(readFileSync(join(root, "specs", slug, "spec.md"), "utf8")).toBe(before);
    // The section nobody else touched is still what it was read as, not what
    // was sent.
    expect(readSpecText(join(root, "specs", slug, "spec.md")).text.notes).toBe(base.notes);
  });

  it("refuses in the other order too: the writer saved first, and the file moved after", () => {
    const { root, slug, base } = started();
    // The person saves, and keeps writing against what they had.
    settled(root, slug, { notes: "The person's note." });
    expect(() =>
      writeSpecFile({
        repositoryRoot: root,
        slug,
        base,
        text: { ...base, notes: "The interview's note." },
      }),
    ).toThrow(SpecConflict);
  });

  it("applies a section nobody else touched and keeps the one somebody else wrote", () => {
    const { root, slug, base } = started();
    settled(root, slug, { no_gos: "- The interview's No-Go." });

    const written = writeSpecFile({
      repositoryRoot: root,
      slug,
      base,
      text: { ...base, notes: "The person's note." },
    });
    const now = readSpecText(written.path).text;
    expect(now.notes).toBe("The person's note.");
    expect(now.no_gos).toBe("- The interview's No-Go.");
  });

  it("names every conflicting section, the title among them", () => {
    const { root, slug, base } = started();
    settled(root, slug, { title: "Theirs", outcome: "Theirs.", notes: "Theirs." });
    let refusal: SpecConflict | null = null;
    try {
      writeSpecFile({
        repositoryRoot: root,
        slug,
        base,
        text: { ...base, title: "Mine", outcome: "Mine.", rabbit_holes: "Mine." },
      });
    } catch (error) {
      refusal = error as SpecConflict;
    }
    expect(refusal?.conflicting).toEqual(["title", "outcome"]);
  });

  it("refuses a write against a spec that has gone", () => {
    const { root, slug, base } = started();
    rmSync(join(root, "specs", slug, "spec.md"));
    expect(() =>
      writeSpecFile({
        repositoryRoot: root,
        slug,
        base,
        text: { ...base, outcome: "Still mine." },
      }),
    ).toThrow(SpecConflict);
  });

  it("takes a spec that does not exist yet as a write against nothing", () => {
    const root = repository();
    const written = writeSpecFile({ repositoryRoot: root, base: EMPTY_SPEC_TEXT, text: text() });
    expect(written.created).toBe(true);
    expect(readSpecText(written.path).text.outcome).toBe(text().outcome);
  });

  it("does not refuse a writer that sends back what the file already says", () => {
    const { root, slug, base } = started();
    settled(root, slug, { outcome: "The interview's sentence." });
    // The writer changed nothing, so the section it read moving is not a clash.
    const written = writeSpecFile({ repositoryRoot: root, slug, base, text: base });
    expect(readSpecText(written.path).text.outcome).toBe("The interview's sentence.");
  });
});

describe("the title taken from the first thing a person said", () => {
  it("is their own first sentence, with the opening dropped", () => {
    expect(specTitleFromMessage("I want a poem about technology")).toBe("A poem about technology");
    expect(specTitleFromMessage("Can you add a dark mode toggle")).toBe("Add a dark mode toggle");
    expect(specTitleFromMessage("Please fix the login redirect. It loops.")).toBe("Fix the login redirect");
    // No opening to drop is left alone.
    expect(specTitleFromMessage("Split the queue node")).toBe("Split the queue node");
  });

  it("keeps an abbreviation whole rather than ending the sentence on it", () => {
    // A stop after a short token is an abbreviation; ending there would name
    // the folder `fix-dr`, and a folder is minted once.
    expect(specTitleFromMessage("Fix Dr. Smith's login redirect")).toBe("Fix Dr. Smith's login redirect");
    expect(specTitleFromMessage("Handle e.g. the parser edge cases")).toBe("Handle e.g. the parser edge cases");
    expect(specTitleFromMessage("Add a toggle vs. a switch")).toBe("Add a toggle vs. a switch");
    // An ordinary word still ends one.
    expect(specTitleFromMessage("Update the README. Also fix tests")).toBe("Update the README");
    expect(specTitleFromMessage("Fix the bug! It crashes.")).toBe("Fix the bug");
  });

  it("clips to a whole word, short enough to slug", () => {
    const title = specTitleFromMessage(`${"word ".repeat(40)}end`);
    expect(title.length).toBeLessThanOrEqual(MAX_SPEC_SLUG_LENGTH);
    expect(title.endsWith(" ")).toBe(false);
    // Cut at a word, not through one.
    expect(title).toMatch(/word$/);
    expect(() => specSlug(title)).not.toThrow();
  });

  it("cuts a single word longer than the cap rather than leaving nothing", () => {
    const title = specTitleFromMessage("a".repeat(200));
    expect(title.length).toBe(MAX_SPEC_SLUG_LENGTH);
  });

  it("refuses a message no folder name can come from", () => {
    for (const message of ["", "   ", "*** ———", "?!?!"]) {
      expect(() => specTitleFromMessage(message)).toThrow(PlanningError);
    }
  });

  it("names the same folder the title would, so nothing is minted twice", () => {
    const title = specTitleFromMessage("I want a poem about technology");
    expect(specSlug(title)).toBe("a-poem-about-technology");
  });
});

/**
 * A heading in the Requirements section groups the requirements under it, and
 * the two readers of that section agree about it: `parseSpec` reads list items
 * there and passes everything else over, so an editor that numbered a heading
 * would make one file say two things.
 */
describe("a heading among the requirements", () => {
  const withHeadings: SpecText = {
    ...EMPTY_SPEC_TEXT,
    title: "A screen time page",
    outcome: "A page counts the time it is looked at.",
    requirements: [
      "### The page",
      "- It is one file, opened from disk.",
      "",
      "### Measuring",
      "- It counts only while the browser reports it visible.",
    ].join("\n"),
  };

  it("keeps the heading a heading, and numbers only what states a requirement", () => {
    const { markdown, requirements } = renderSpec(withHeadings);
    expect(requirements.map((each) => each.id)).toEqual(["R1", "R2"]);
    expect(requirements[0]!.text).toBe("It is one file, opened from disk.");
    const section = markdown.split("## Requirements\n\n")[1]!.split("\n## ")[0]!;
    expect(section).toContain("### The page\n\n- R1: It is one file");
    expect(section).toContain("### Measuring\n\n- R2: It counts only");
    // The heading is not a requirement, in the file or in what it parses to.
    expect(section).not.toContain("- R1: ### The page");
    expect(requirements.some((each) => each.text.startsWith("#"))).toBe(false);
  });

  it("reads back through the strict parser with the same requirements", () => {
    const { markdown } = renderSpec(withHeadings);
    expect(parseSpec(markdown).requirements.map((each) => each.id)).toEqual(["R1", "R2"]);
  });

  it("keeps the ids where they are when the section is saved again", () => {
    const once = renderSpec(withHeadings);
    const twice = renderSpec(
      { ...withHeadings, requirements: once.markdown.split("## Requirements\n\n")[1]!.split("\n## ")[0]! },
      { highWater: once.highWater },
    );
    expect(twice.requirements.map((each) => each.id)).toEqual(["R1", "R2"]);
    expect(twice.highWater).toBe(2);
  });
});

/**
 * The depth of a heading in the Requirements section, which is not a matter of
 * taste: `#` and `##` are the file's own delimiters, so a line at either depth
 * written inside `## Requirements` is read back as the start of another section
 * and takes every requirement under it out of the spec.
 */
describe("how deep a heading in Requirements may be", () => {
  const withHeading = (marks: string): SpecText => ({
    ...EMPTY_SPEC_TEXT,
    title: "A screen time page",
    outcome: "A page counts the time it is looked at.",
    requirements: `${marks} Rendering\n- It is one file.\n- It counts visible time.`,
  });

  it.each(["###", "####"])("keeps %s as a heading, with its requirements under it", (marks) => {
    const { markdown } = renderSpec(withHeading(marks));
    const read = readSpecSections(markdown);
    expect(read.requirements.map((each) => each.id)).toEqual(["R1", "R2"]);
    expect(read.text.requirements).toContain(`${marks} Rendering`);
  });

  it.each(["#", "##"])("writes %s back as a requirement, because a heading there is lost", (marks) => {
    const { markdown, requirements } = renderSpec(withHeading(marks));
    // Written as a requirement — odd to read, and every line survives.
    expect(requirements.map((each) => each.text)).toEqual([
      `${marks} Rendering`,
      "It is one file.",
      "It counts visible time.",
    ]);
    const read = readSpecSections(markdown);
    expect(read.requirements).toHaveLength(3);
    expect(read.text.requirements.length).toBeGreaterThan(0);
  });
});

/**
 * "Keep both" hands the renderer the file's text and the person's one after the
 * other. A requirement repeated that way is deduplicated by its id; a heading
 * has no id, so it is deduplicated by what it says.
 */
describe("a section whose text arrives twice", () => {
  it("writes each heading once, with every requirement still under one", () => {
    const section = "### The page\n- R1: It is one file.\n\n### Measuring\n- R2: It counts visible time.";
    const both: SpecText = {
      ...EMPTY_SPEC_TEXT,
      title: "A screen time page",
      outcome: "A page counts the time it is looked at.",
      requirements: `${section}\n${section}\n- It resets at midnight.`,
    };
    const { markdown, requirements } = renderSpec(both, { highWater: 2 });
    const written = markdown.split("## Requirements\n\n")[1]!.split("\n## ")[0]!;
    expect(written.match(/### The page/g)).toHaveLength(1);
    expect(written.match(/### Measuring/g)).toHaveLength(1);
    expect(requirements.map((each) => each.id)).toEqual(["R1", "R2", "R3"]);
    // No heading left standing with nothing under it.
    expect(written).not.toMatch(/### Measuring\n\n\n/);
  });
});
