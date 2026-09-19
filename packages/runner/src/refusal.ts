import type { DiagnosticFinding } from "@perbo/contracts";

/**
 * The run will not start, and the reason is a property of the repository.
 *
 * A refusal is not a defect in this program. The repository was diagnosed,
 * something it needs was found missing, and what the person does next is a fix
 * in their own tree — so what they have to read is the finding and the command
 * that explains it, not a stack trace through modules they have never opened.
 * An error nothing recognises is the other thing entirely, and it keeps its
 * stack, because for that one the frames are the only thing that says where it
 * came from.
 *
 * That is why this is a **type** rather than a wording: the layer that prints
 * an error decides between those two readings by asking what the error is, and
 * a rule that read the message instead would be one rephrasing away from
 * handing a partner a debugging session again.
 *
 * Raised only before an attempt exists. Nothing has been executed, nothing has
 * been paid for, and the findings are the diagnostic's own — carried whole, so
 * the words a person reads here are the words `doctor` prints.
 */
export class RunRefusedError extends Error {
  /** The diagnostic's refusals, in the order it found them. */
  readonly findings: readonly DiagnosticFinding[];
  /** The checkout the findings are about: what `doctor --repo` takes. */
  readonly repository_root: string;

  constructor(input: {
    message: string;
    findings: readonly DiagnosticFinding[];
    repository_root: string;
  }) {
    super(input.message);
    this.name = "RunRefusedError";
    this.findings = input.findings;
    this.repository_root = input.repository_root;
  }
}
