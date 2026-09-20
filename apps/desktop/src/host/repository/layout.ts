import { safePath } from "./paths.js";
import type { RegisteredRepository } from "../profile/store.js";

/**
 * How the desktop spells the store the CLI keeps in a repository. One home, so
 * a surface that reads a record and a surface that writes one are reading and
 * writing the same file, and every one of them is resolved through `safePath`.
 */
export function perboPath(repo: RegisteredRepository): string {
  return safePath(repo, ".perbo");
}
export function configPath(repo: RegisteredRepository): string {
  return safePath(repo, ".perbo", "config.json");
}
/** A sibling of the configuration, so a rename over it never crosses a filesystem. */
export function configTemporaryPath(repo: RegisteredRepository, token: string): string {
  return safePath(repo, ".perbo", `config-${token}.tmp`);
}
export function ticketPath(
  repo: RegisteredRepository,
  key: string,
  suffix: ".json" | ".contract.json" | ".draft.json" | ".approach.json",
): string {
  return safePath(repo, ".perbo", "tickets", `${key}${suffix}`);
}
/** Keyed by ticket id rather than key, as the runner writes it. */
export function attemptsPath(repo: RegisteredRepository, ticketId: string): string {
  return safePath(repo, ".perbo", "state", `${ticketId}.attempts.json`);
}
export function bundlesPath(repo: RegisteredRepository): string {
  return safePath(repo, ".perbo", "bundles", "bundles");
}
export function objectsPath(repo: RegisteredRepository): string {
  return safePath(repo, ".perbo", "bundles", "objects");
}
export function objectPath(repo: RegisteredRepository, sha256: string): string {
  return safePath(repo, ".perbo", "bundles", "objects", sha256);
}
export function principlesPath(repo: RegisteredRepository): string {
  return safePath(repo, ".perbo", "principles.md");
}
