import { isDeepStrictEqual } from "node:util";
import { hasAcceptanceCriteria, type AcceptanceCriterion, type PlanContract } from "@perbo/contracts";

export interface ContractDiff {
  /** The number of fields a person changed. `admission.edit_count` is this. */
  count: number;
  /** One line per change, in the order they are counted. */
  changes: string[];
}

const criterionKey = (criterion: AcceptanceCriterion) =>
  JSON.stringify([criterion.text, criterion.expected_verification]);

/**
 * What changed between the contract as first rendered and the one approved,
 * counted the way D-003's friction instrument asks: the outcome, each criterion
 * added, removed or reworded, each scope glob added or removed. Identity, base
 * and level are not counted — a person does not type those.
 *
 * Criteria are matched by id. An edit that renumbers them reads as rewordings,
 * which overstates the count rather than hiding a change.
 */
export function contractEditCount(before: PlanContract, after: PlanContract): ContractDiff {
  const changes: string[] = [];
  if (before.outcome !== after.outcome) changes.push("outcome reworded");

  const beforeCriteria = hasAcceptanceCriteria(before) ? before.acceptance_criteria : [];
  const afterCriteria = hasAcceptanceCriteria(after) ? after.acceptance_criteria : [];
  const previous = new Map(beforeCriteria.map((criterion) => [criterion.id, criterion]));
  const current = new Set(afterCriteria.map((criterion) => criterion.id));
  for (const criterion of afterCriteria) {
    const was = previous.get(criterion.id);
    if (!was) changes.push(`${criterion.id} added`);
    else if (criterionKey(was) !== criterionKey(criterion)) changes.push(`${criterion.id} reworded`);
  }
  for (const criterion of beforeCriteria) {
    if (!current.has(criterion.id)) changes.push(`${criterion.id} removed`);
  }

  const moved = (label: string, from: readonly string[], to: readonly string[]) => {
    const fromSet = new Set(from);
    const toSet = new Set(to);
    for (const glob of to) if (!fromSet.has(glob)) changes.push(`${label} +${glob}`);
    for (const glob of from) if (!toSet.has(glob)) changes.push(`${label} -${glob}`);
  };
  moved("scope", before.scope.paths_allowed, after.scope.paths_allowed);
  moved("prohibited", before.scope.paths_prohibited, after.scope.paths_prohibited);

  return { count: changes.length, changes };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every path at which two JSON documents differ, named the way the file reads —
 * `scope.paths_allowed[1]` — so a report points at a line rather than a field.
 *
 * Equality is `node:util`'s `isDeepStrictEqual` rather than a hand-rolled
 * comparison: it is the primitive Node ships for exactly this, and the only
 * thing added here is the path of the node that failed it. Keys are walked in
 * sorted order so the report does not depend on the order two files happen to
 * serialise their keys in — a hand-edited file frequently reorders them.
 */
function differingPaths(before: unknown, after: unknown, path: string, into: string[]): void {
  if (isDeepStrictEqual(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    // Compared by position, including past the end of the shorter one, so a
    // removed element is named at the index it was removed from rather than
    // making every element after it read as changed.
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      differingPaths(before[index], after[index], `${path}[${index}]`, into);
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      differingPaths(before[key], after[key], path === "" ? key : `${path}.${key}`, into);
    }
    return;
  }
  into.push(path === "" ? "(contract)" : path);
}

/**
 * Every field at which two contracts differ, named by path.
 *
 * Not `contractEditCount`: that one counts the fields a person meant to change,
 * in the words the friction instrument reports them in, and deliberately
 * ignores identity, base and level because a person does not type those. This
 * one is the integrity comparison — *nothing* may differ, including the fields
 * nobody types — and it names where, so a refusal can point at the lines rather
 * than say the two files disagree somewhere.
 */
export function contractDifferences(before: PlanContract, after: PlanContract): string[] {
  const paths: string[] = [];
  differingPaths(before, after, "", paths);
  return paths;
}
