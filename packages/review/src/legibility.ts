import { createHash } from "node:crypto";
import type { CheckResult, Finding } from "@perbo/contracts";

/**
 * Is the change set one a person can read? (SCP-114.)
 *
 * Observed 2026-08-30. An executor closing a timing attack wrote `U+0000` into
 * a string literal where it meant a space. The code works — a NUL is a valid
 * JavaScript string character and `charCodeAt` returns 0 — so the pinned checks
 * passed, the scope computation found nothing out of bounds, and the closure
 * verification confirmed the routed finding addressed. Git classifies a file
 * containing a NUL as binary, so the security-critical comparison function
 * rendered as `Binary files … differ`: invisible in the change set, while its
 * 149 lines of tests were fully visible and green.
 *
 * Three controls approved a change nobody could read, because none of them
 * asked whether it was legible. This asks.
 *
 * It sits on the deterministic row: unlike a semantic finding there is no
 * judgement in it, and its result outranks anything the model says next. Under
 * d068 the one case the executor itself caused — illegible bytes on a line or
 * in a file this change added or modified — goes back to it for one round,
 * because removing its own bytes is work it can do; the verifier stops a round
 * that leaves them. A file the change did not touch blocks as before.
 */

/**
 * Spelled as an escape, never as the byte itself. A source file holding a raw
 * NUL is the binary file this rule exists to catch: git will not render its
 * diff, and until SCP-188 it also killed the review outright, because the
 * transport passed the prompt to the provider CLI as a process argument and
 * Node refuses an argument containing one. `packages/contracts/test` reads
 * every source file under `packages` as bytes to keep it that way.
 */
const NUL = "\u0000";

/** `git diff` says this, verbatim, when it will not render a file. */
const BINARY_MARKER = /^Binary files .* differ$/m;

const FILE_HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;

export interface LegibilityAssessment {
  findings: Finding[];
  check: CheckResult;
}

const findingKey = (path: string, reason: string): string =>
  createHash("sha256").update(`legibility|${reason}|${path}`).digest("hex");

function unreadable(path: string, reason: string, statement: string): Finding {
  return {
    key: findingKey(path, reason),
    rule_id: `legibility.${reason}`,
    source: "deterministic",
    row: "deterministic",
    // A deterministic finding is not asked: d068 routes one the change itself
    // caused on `caused_by_change`, which the reviewer sets from the diff.
    closure: null,
    direction: null,
    caused_by_change: null,
    criterion_id: null,
    severity: "blocker",
    blocking: true,
    blocking_reason: "the change set contains a file no reviewer can read",
    confidence: null,
    file: path,
    line: null,
    symbol: null,
    statement,
    routing: "blocks",
    status: "open",
    outcome: "unknown",
    waiver: null,
  } as Finding;
}

const matches = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => {
    const expression = new RegExp(
      `^${pattern
        .split("**")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*"))
        .join(".*")}$`,
    );
    return expression.test(path);
  });

/**
 * The offset of the first NUL byte, or -1.
 *
 * Asked of bytes rather than of a string: a file holding one is not text, and
 * decoding it first is how the byte becomes invisible.
 */
export function nulByteOffset(bytes: Uint8Array): number {
  return bytes.indexOf(0);
}

/** One read the reviewer asked for, as far as this rule needs to know. */
export interface IllegibleRead {
  ok: boolean;
  path: string;
  /** Present when the file was refused for carrying a NUL byte. */
  illegible?: { offset: number } | undefined;
}

/**
 * The same rule, one step further along the review (SCP-188).
 *
 * `assessLegibility` asks whether the change set renders. This asks it of a
 * file the reviewer opened to follow the change out of a diff that would not
 * render it — the only way its contents were ever going to be seen — and the
 * answer is the same: a file nobody can read is a finding on the change, and
 * the byte offset is what makes it fixable rather than merely reported.
 *
 * @param reads every read of this review, refused ones included
 * @param binaryPaths glob patterns the contract declares as holding binary
 *   assets, as `assessLegibility` uses them
 */
export function illegibleReadFindings(
  reads: readonly IllegibleRead[],
  binaryPaths: readonly string[],
): Finding[] {
  const findings: Finding[] = [];
  for (const read of reads) {
    if (read.ok || read.illegible === undefined) continue;
    if (matches(read.path, binaryPaths)) continue;
    findings.push(
      unreadable(
        read.path,
        "nul_byte_in_file",
        `${read.path} contains a NUL byte (U+0000) at byte ${read.illegible.offset}. The ` +
          `reviewer asked to read it and could not: git classifies any file holding one as ` +
          `binary, so its contents are absent from the diff, and the file itself is not text. ` +
          `The code may still run — a NUL is a valid string character in most languages — which ` +
          `is how an unreadable file reaches a green review.`,
      ),
    );
  }
  return findings;
}

/**
 * @param diff the unified diff the reviewer is shown
 * @param binaryPaths glob patterns the contract declares as holding binary
 *   assets. An image in a path declared for images is not a legibility fault.
 */
export function assessLegibility(diff: string, binaryPaths: readonly string[]): LegibilityAssessment {
  const findings: Finding[] = [];

  // Split into per-file sections so a marker or a NUL is attributed correctly.
  const lines = diff.split("\n");
  let current: string | null = null;
  let section: string[] = [];

  const finish = () => {
    if (current === null) return;
    const path = current;
    const body = section.join("\n");
    if (!matches(path, binaryPaths)) {
      if (BINARY_MARKER.test(body)) {
        findings.push(
          unreadable(
            path,
            "unrenderable_file",
            `\`git diff\` will not render ${path}: it reports "Binary files … differ", so the ` +
              `contents of this file are absent from the change set a reviewer is shown. Any test ` +
              `covering it is still visible and can pass, which is how an unreadable file reaches a ` +
              `green review.`,
          ),
        );
      } else {
        const added = section.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
        const index = added.findIndex((line) => line.includes(NUL));
        if (index !== -1) {
          findings.push(
            unreadable(
              path,
              "control_character_in_source",
              `An added line in ${path} contains a NUL byte (U+0000) — added line ${index + 1}. ` +
                `The code may run: a NUL is a valid string character in most languages. Git ` +
                `classifies any file containing one as binary, so this file will render as ` +
                `"Binary files … differ" and its contents will be invisible to review.`,
            ),
          );
        }
      }
    }
    current = null;
    section = [];
  };

  for (const line of lines) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      finish();
      current = header[2] ?? header[1] ?? null;
      section = [];
      continue;
    }
    if (current !== null) section.push(line);
  }
  finish();

  const failed = findings.length > 0;
  return {
    findings,
    check: {
      check_id: "check_legibility",
      name: "change set is readable",
      kind: "lint",
      status: failed ? "failed" : "passed",
      summary: failed
        ? `${findings.length} file(s) the reviewer cannot read`
        : "every changed file renders in the diff",
      command: "(computed from the change set)",
      detail: failed ? findings.map((finding) => finding.statement).join("\n") : null,
      duration_ms: null,
      source: "computed",
    } as CheckResult,
  };
}
