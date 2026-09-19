import { describe, expect, it } from "vitest";
import { judgingChecks } from "../src/shared/checks.js";

/**
 * The attempt view shows the checks that judged the change (D-107): a result a
 * node ran is that node's own evidence and stays out of it.
 */
describe("the checks an attempt view shows", () => {
  it("keeps the whole-change results and leaves a node's own out", () => {
    const whole = { name: "unit", status: "passed" };
    const perNode = { name: "unit", status: "failed", node: { node_id: "node_1" } };
    expect(judgingChecks([whole, perNode, { ...whole, name: "lint" }])).toEqual([whole, { ...whole, name: "lint" }]);
    expect(judgingChecks([])).toEqual([]);
  });
});
