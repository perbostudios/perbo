/**
 * The check results that judged a change: every one run over the whole
 * change. A result a node ran carries `node` and is that node's own evidence
 * (D-107); the attempt view shows what judged the change, so it leaves those
 * out.
 */
export function judgingChecks<T extends object>(checks: readonly T[]): T[] {
  return checks.filter((check) => !("node" in check) || (check as { node?: unknown }).node === undefined);
}
