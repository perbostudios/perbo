import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hasAcceptanceCriteria, parseUnifiedDiff } from "@perbo/contracts";
import { CLASS_PREFIX, anchorFileIsReal, anchoringNote } from "../src/corpus.js";
import { PERMISSIVE_LICENCES } from "../src/prepare.js";
import { DEFECT_CLASSES } from "../src/fixture.js";
import { corpus, describeCorpus } from "./corpus-present.js";

describeCorpus("the corpus is well formed", () => {
  it("is not empty", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it.each(corpus.map((entry) => [entry.fixture.id, entry] as const))(
    "%s parses and its files agree",
    (_id, entry) => {
      expect(entry.fixture.id.startsWith(CLASS_PREFIX[entry.fixture.class])).toBe(true);
      expect(entry.fixture.defective).toBe(entry.fixture.class !== "clean");

      // A pinned fixture keeps no tree and no diff in this repository: they are
      // materialised into a cache that is never checked in, so CI has neither.
      // What is checkable here is the declaration.
      if (entry.pinned) {
        const pinned = entry.fixture.pinned_repository!;
        expect(pinned.base_commit).not.toBe(pinned.head_commit);
        expect(PERMISSIVE_LICENCES).toContain(pinned.licence);
        expect(existsSync(join(entry.dir, "after"))).toBe(false);
        expect(existsSync(join(entry.dir, "change.diff"))).toBe(false);
        return;
      }

      expect(existsSync(entry.repoDir)).toBe(true);
      expect(parseUnifiedDiff(entry.diff).length).toBeGreaterThan(0);
    },
  );

  it("covers every defect class", () => {
    const present = new Set(corpus.map((entry) => entry.fixture.class));
    for (const defectClass of DEFECT_CLASSES) expect(present).toContain(defectClass);
  });

  it("includes clean changes, without which a recall number means nothing", () => {
    expect(corpus.filter((entry) => entry.fixture.class === "clean").length).toBeGreaterThan(0);
  });
});

describeCorpus("every expectation is anchored to something that exists", () => {
  it.each(corpus.map((entry) => [entry.fixture.id, entry] as const))(
    "%s names real criteria and real files",
    (_id, entry) => {
      const detection = entry.fixture.expected_detection;
      // Neither names an expectation to anchor. A contested fixture's anchor is
      // its written objection and the person who checked it, which the schema
      // requires (D-068).
      if (detection.mode === "clean" || detection.mode === "contested") return;

      const criteria = hasAcceptanceCriteria(entry.contract)
        ? entry.contract.acceptance_criteria.map((criterion) => criterion.id)
        : [];
      for (const criterionId of detection.criterion_ids) {
        expect(criteria, `${entry.fixture.id} expects ${criterionId}`).toContain(criterionId);
      }

      // A pinned fixture computes its diff from a clone that is not checked in,
      // so on a machine that has never run `perbo-corpus prepare` there is no
      // diff to anchor against — including CI, which cannot clone 800 MB of
      // upstream repositories to assert a path. The criterion check above still
      // runs; only the file check needs the diff.
      //
      // Skipped rather than passed vacuously, and named rather than skipped
      // silently: the harness itself refuses an unprepared pinned fixture at run
      // time, so the anchor is enforced where a measurement depends on it.
      if (entry.pinned && !entry.prepared) return;

      for (const file of detection.files) {
        expect(
          anchorFileIsReal(entry, file),
          `${entry.fixture.id} expects ${file}, which its diff does not touch and which is not ` +
            "in its tree either",
        ).toBe(true);
      }
    },
  );

  it("names every fixture whose anchoring it could not check on this machine", () => {
    // The compensating control for skipping the file anchor on 19 of 90
    // fixtures. Its only assertion used to be `corpus.length > 0`, which is
    // line 15 again — so deleting the note, or breaking the `prepared`
    // predicate, left a green run saying nothing while a pinned fixture's
    // `expected_detection.files` could name a path its upstream diff does not
    // contain.
    const unprepared = corpus.filter((entry) => entry.pinned && !entry.prepared);
    const note = anchoringNote(corpus);

    if (unprepared.length === 0) {
      expect(note).toBeNull();
      return;
    }
    for (const entry of unprepared) {
      expect(note, `${entry.fixture.id} is unanchored and must be named`).toContain(
        entry.fixture.id,
      );
    }
    expect(note).toContain(`${unprepared.length} of ${corpus.length}`);
    expect(note).toContain("prepare");
    // Every prepared fixture was anchored, so none of them belongs in the note.
    for (const entry of corpus.filter((e) => e.prepared)) {
      expect(note).not.toContain(entry.fixture.id);
    }
  });

  // A defective fixture that violates no criterion cannot be judged against the
  // contract, and would be measuring the reviewer's taste instead. Two classes
  // are exceptions and both for stated reasons: scope escape is decided by the
  // diff against the scope, and an unstated regression (D-053) is *defined* by
  // satisfying its criterion and breaking something the criterion never
  // mentioned — requiring one there would exclude the class by construction.
  // Each still has to be anchored to a file, so it is not judged on taste
  // either.
  const CRITERION_EXEMPT = new Set(["scope_escape", "unstated_regression"]);
  it.each(
    corpus
      .filter((entry) => entry.fixture.defective && !CRITERION_EXEMPT.has(entry.fixture.class))
      .map((entry) => [entry.fixture.id, entry] as const),
  )("%s names the criterion it violates", (_id, entry) => {
    const detection = entry.fixture.expected_detection;
    expect(detection.mode).not.toBe("clean");
    if (detection.mode === "clean" || detection.mode === "contested") return;
    expect(detection.criterion_ids.length).toBeGreaterThan(0);
  });

  it.each(
    corpus
      .filter((entry) => entry.fixture.class === "unstated_regression")
      .map((entry) => [entry.fixture.id, entry] as const),
  )("%s anchors its regression to a file", (_id, entry) => {
    const detection = entry.fixture.expected_detection;
    if (detection.mode === "clean" || detection.mode === "contested") return;
    expect(detection.files.length).toBeGreaterThan(0);
  });
});

describeCorpus("provenance", () => {
  it.each(corpus.map((entry) => [entry.fixture.id, entry] as const))(
    "%s cites a public record and states whether code was copied",
    (_id, entry) => {
      expect(entry.fixture.source.url.length).toBeGreaterThan(0);
      expect(entry.fixture.why_it_is_hard.length).toBeGreaterThan(20);
      // Copying upstream code is only admissible under a permissive licence,
      // and none of these fixtures do it.
      expect(entry.fixture.source.code_copied).toBe(false);
    },
  );
});

describeCorpus("the diff and the after tree agree", () => {
  it.each(corpus.map((entry) => [entry.fixture.id, entry] as const))(
    "%s: every non-deleted file in the diff exists in after/",
    (_id, entry) => {
      for (const file of parseUnifiedDiff(entry.diff)) {
        if (file.change_kind === "deleted") continue;
        expect(existsSync(join(entry.repoDir, file.path)), `${file.path} missing`).toBe(true);
      }
    },
  );
});

describeCorpus("the corpus in the repository is the corpus on disk", () => {
  // A fixture file that git is ignoring exists for whoever wrote it and for
  // nobody else. `adv-001`'s planted approval instruction lives in a `.log`,
  // and `adv-003`'s planted secrets live in `.env` files — both of which the
  // repository's own ignore rules were happy to eat. The diff-regeneration
  // check in CI only catches the ones a diff references; these do not have to
  // be referenced by anything to matter.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fixturesDir = join(packageRoot, "corpus", "fixtures");

  const tracked = new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", fixturesDir], {
      cwd: packageRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
  );

  const ignored = execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", fixturesDir],
    { cwd: packageRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

  it("has fixture files at all", () => {
    expect(tracked.size).toBeGreaterThan(100);
  });

  it("ignores no fixture file", () => {
    expect(ignored, `git is ignoring ${ignored.length} fixture file(s)`).toEqual([]);
  });

  it.each(corpus.map((entry) => [entry.fixture.id, entry] as const))(
    "%s: every file in after/ is in the repository",
    (_id, entry) => {
      // A pinned fixture deliberately has no file in this repository: its tree
      // is cloned at run time and never checked in, which is what keeps the
      // "no upstream code is copied" rule true for it by construction.
      if (entry.pinned) return;
      for (const file of parseUnifiedDiff(entry.diff)) {
        if (file.change_kind === "deleted") continue;
        const absolute = join(entry.repoDir, file.path);
        const rel = relative(packageRoot, absolute).split(sep).join("/");
        expect(tracked.has(rel), `${rel} is not in the repository`).toBe(true);
      }
    },
  );
});

describeCorpus("scp-006 detection is deterministic after D-062", () => {
  // Round 2 measured this fixture approved 3/3: the generated-path exemption
  // was silent and the model was the only thing that could notice a hand edit
  // to toolchain-owned output. The contract now declares the file's sources,
  // so the escape is caught by computation. This test is the structural proof;
  // the corpus number moves at the next scored run.
  it("yields a blocking deterministic finding attributable to the seeded defect", async () => {
    const entry = corpus.find((candidate) => candidate.fixture.id.startsWith("scp-006"));
    expect(entry).toBeDefined();
    const { assessScope } = await import("@perbo/review");
    const { changeSetFromDiff } = await import("@perbo/contracts");
    const changeset = changeSetFromDiff({
      diff: entry!.diff,
      base_commit: entry!.contract.base.base_commit,
    });
    const assessment = assessScope(changeset, entry!.contract.scope);
    const finding = assessment.findings.find(
      (candidate) => candidate.rule_id === "scope.generated_without_source",
    );
    expect(finding).toBeDefined();
    expect(finding!.blocking).toBe(true);
    // Attributability: score.ts matches on expected_detection.files, which only
    // the anchored modes carry — `clean` and `contested` register nothing.
    const expectation = entry!.fixture.expected_detection;
    if (expectation.mode !== "blocking" && expectation.mode !== "coverage") {
      throw new Error(`scp-006 is scored in ${expectation.mode} mode, which anchors no file`);
    }
    expect(expectation.files).toContain(finding!.file);
  });
});
