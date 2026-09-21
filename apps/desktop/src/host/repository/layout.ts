import {
  STORE_DIRNAME,
  approachPath,
  attemptsPath as attemptsSegments,
  bundleManifestsDir,
  bundleObjectPath,
  bundleObjectsDir,
  configPath as configSegments,
  contractPath,
  draftPath,
  principlesPath as principlesSegments,
  ticketFilePath,
  type StorePath,
} from "@perbo/contracts";
import { safePath } from "./paths.js";
import type { RegisteredRepository } from "../profile/store.js";

/**
 * How the desktop reaches the store the CLI keeps in a repository. One home,
 * so a surface that reads a record and a surface that writes one are reading
 * and writing the same file.
 *
 * `@perbo/contracts` names each record, which is what keeps the three
 * processes over one store agreeing; what is here is the desktop's half —
 * resolving one against the registered repository through `safePath`, which
 * refuses a path that leaves the checkout or reaches its place through a link.
 */
function storePath(repo: RegisteredRepository, segments: StorePath): string {
  return safePath(repo, STORE_DIRNAME, ...segments);
}

const TICKET_FILE = {
  ".json": ticketFilePath,
  ".contract.json": contractPath,
  ".draft.json": draftPath,
  ".approach.json": approachPath,
} as const;

export function perboPath(repo: RegisteredRepository): string {
  return safePath(repo, STORE_DIRNAME);
}
export function configPath(repo: RegisteredRepository): string {
  return storePath(repo, configSegments());
}
export function ticketPath(
  repo: RegisteredRepository,
  key: string,
  suffix: keyof typeof TICKET_FILE,
): string {
  return storePath(repo, TICKET_FILE[suffix](key));
}
/** Keyed by ticket id rather than key, as the runner writes it. */
export function attemptsPath(repo: RegisteredRepository, ticketId: string): string {
  return storePath(repo, attemptsSegments(ticketId));
}
export function bundlesPath(repo: RegisteredRepository): string {
  return storePath(repo, bundleManifestsDir());
}
export function objectsPath(repo: RegisteredRepository): string {
  return storePath(repo, bundleObjectsDir());
}
export function objectPath(repo: RegisteredRepository, sha256: string): string {
  return storePath(repo, bundleObjectPath(sha256));
}
export function principlesPath(repo: RegisteredRepository): string {
  return storePath(repo, principlesSegments());
}
