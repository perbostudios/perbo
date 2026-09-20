import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_LOCAL_VERDICTS,
  LocalVerdictsSchema,
  type DecidedBy,
  type LocalVerdicts,
} from "@perbo/contracts";
import { git } from "@perbo/workspace";
import type { Streams } from "../../streams.js";

/**
 * The local verdicts record — `<store>/verdicts.json` — read and written
 * (SCP-181).
 *
 * It sits at the root of the store rather than under `state/`, beside the
 * tickets and the config, because it is not working state: `state/` holds what
 * `perbo sync` can rebuild from a pull request, and nothing can rebuild a
 * decision a person took here. Losing it loses the decision.
 *
 * Reading is split in two on purpose. `perbo verdict` uses the strict reader
 * and refuses to write over a file it cannot parse — a new file started on top
 * of an unreadable one is decisions destroyed silently. `stops` and `inspect`
 * use the lenient one, which names the problem on stderr and reports what it
 * can, because a report that dies on a bad file tells nobody anything.
 */

export const VERDICTS_FILE = "verdicts.json";

export const verdictsPath = (dir: string): string => join(dir, VERDICTS_FILE);

export class VerdictStoreError extends Error {}

/** The record, or the empty one where the file does not exist yet. Throws on a bad file. */
export function readLocalVerdicts(dir: string): LocalVerdicts {
  const path = verdictsPath(dir);
  if (!existsSync(path)) return EMPTY_LOCAL_VERDICTS;
  try {
    return LocalVerdictsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new VerdictStoreError(
      `${path} is not a readable verdicts record: ` +
        `${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}

/**
 * The same, for a reader: an unreadable file is named on stderr and read as
 * empty. `streams` is nullable for the one caller that builds a report with
 * nowhere to say it — the warning is then left to whoever prints the report.
 */
export function readLocalVerdictsOrWarn(dir: string, streams: Streams | null): LocalVerdicts {
  try {
    return readLocalVerdicts(dir);
  } catch (error) {
    if (!(error instanceof VerdictStoreError)) throw error;
    streams?.stderr(`warning: ${error.message}; local decisions were not counted\n`);
    return EMPTY_LOCAL_VERDICTS;
  }
}

export function writeLocalVerdicts(dir: string, file: LocalVerdicts): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(verdictsPath(dir), `${JSON.stringify(LocalVerdictsSchema.parse(file), null, 2)}\n`);
}

/**
 * Who is taking the decision, when `--author` does not say: this checkout's
 * git identity, which is `user.name` and `user.email` and nothing else.
 *
 * No account and no token. The two config lines are what git already asks
 * every contributor for, they are read from the repository the decision is
 * about, and where the repository names neither the command refuses rather
 * than inventing somebody — the account name of whoever happened to be logged
 * in names a machine, not a person who decided.
 */
export interface GitIdentity {
  name: string | null;
  email: string | null;
}

/** The two config lines to run, named in every refusal. */
export const GIT_IDENTITY_COMMANDS = [
  'git config user.name "Your Name"',
  'git config user.email "you@example.com"',
] as const;

export function readGitIdentity(repositoryRoot: string): GitIdentity {
  const config = (key: string): string | null => {
    try {
      return git.configSync(repositoryRoot, key);
    } catch {
      // No git, no repository, or a read that did not finish: none of them is
      // an error here, and none of them names anybody.
      return null;
    }
  };
  return { name: config("user.name"), email: config("user.email") };
}

/**
 * The identity as one line, in the form git itself writes it — or `null` where
 * the repository names neither half, which is the refusal above. One half on
 * its own still names somebody and is recorded as it stands.
 */
export function authorLine(identity: GitIdentity): string | null {
  const { name, email } = identity;
  if (name !== null && email !== null) return `${name} <${email}>`;
  return name ?? email;
}

/**
 * The typed pair the record carries, where the repository names both halves.
 *
 * `null` where it names one or neither: `decided_by` is a name *and* an
 * address, and half of one padded out with an empty string would be a record
 * claiming something nobody wrote down. The `author` line above still carries
 * whichever half there is.
 */
export function decidedBy(identity: GitIdentity): DecidedBy | null {
  const { name, email } = identity;
  return name !== null && email !== null ? { name, email } : null;
}

/**
 * `--author` read back as the same pair, when it was written in the form this
 * command writes: `Name <email>`. Anything else is prose naming somebody, and
 * prose is left in `author` alone rather than split on a guess.
 */
export function authorIdentity(author: string): DecidedBy | null {
  const match = /^\s*(\S.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(author);
  return match === null ? null : { name: match[1]!, email: match[2]! };
}
