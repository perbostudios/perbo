import { redact } from "../process.js";
import { specSectionsAt } from "./spec.js";
import { ChangeMarks as Marks } from "../../shared/change-marks.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Detail, EditingSession, InterviewEntry } from "../../shared/protocol.js";

export interface MarksDeps {
  editing: Pick<ContractEditing, "read" | "recordChange">;
  /** Every planning this host keeps, live or not. */
  sessions(): readonly EditingSession[];
  repository(id: string): RegisteredRepository;
  contract(repo: RegisteredRepository, key: string): { contract: Detail["contract"] };
  /** A line in the planning's chat, where a change could not be marked. */
  say(id: string, line: InterviewEntry["line"]): void;
}

/**
 * The change marks (D-128) over the repository's files: the spec's sections
 * off its file, the plan's promise off the ticket's contract, and an error
 * redacted before the chat shows it. What is marked, and where, is
 * {@link Marks}, which the sample host marks with too (D-120).
 */
export class ChangeMarks extends Marks<RegisteredRepository> {
  constructor(deps: MarksDeps) {
    super({
      read: (id) => deps.editing.read(id),
      sessions: () => deps.sessions(),
      repository: (id) => deps.repository(id),
      spec: specSectionsAt,
      contract: (repo, key) => deps.contract(repo, key).contract,
      recordChange: (id, change) => deps.editing.recordChange(id, change),
      say: (id, line) => deps.say(id, line),
      redact: (text) => redact(text),
    });
  }
}
