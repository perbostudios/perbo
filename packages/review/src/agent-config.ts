import {
  findingKey,
  isAgentConfigPath,
  type ChangeSet,
  type CheckResult,
  type Finding,
} from "@perbo/contracts";

/**
 * ADR-0030. Repository-supplied agent configuration — hooks, tool-server
 * manifests, provider base-URL overrides, instruction files — executes before
 * any of the product's controls apply, and is attacker-controlled under exactly
 * the threat model already accepted for source and test output.
 *
 * Stage 1 runs no agent, so there is nothing here to suppress at invocation.
 * What Stage 1 owes the ADR is that a change *introducing* such configuration
 * **fails closed**: the reviewer never reads its contents (`repo.ts` refuses),
 * and its presence in the diff is a deterministic blocking finding rather than
 * a judgement call. Agent configuration is attempt-immutable (D-045); a change
 * that edits it is a change to the execution substrate, not to the product.
 */
export function assessAgentConfiguration(changeset: ChangeSet): {
  findings: Finding[];
  check: CheckResult;
} {
  const touched = changeset.files
    .filter((file) => isAgentConfigPath(file.path))
    .map((file) => file.path)
    .sort();

  const findings: Finding[] = touched.map((path) => ({
    key: findingKey({
      rule_id: "security.agent_configuration",
      criterion_id: null,
      file: path,
      symbol: null,
    }),
    rule_id: "security.agent_configuration",
    source: "deterministic",
    // Overwritten by `applyBlocking`; a deterministic finding is never routed.
    row: null,
    closure: null,
    direction: null,
    caused_by_change: null,
    criterion_id: null,
    severity: "blocker",
    blocking: true,
    blocking_reason: "",
    confidence: null,
    file: path,
    line: null,
    symbol: null,
    statement:
      `${path} is repository-supplied agent configuration. A hook is arbitrary code execution ` +
      "and a tool-server manifest is an unmediated egress channel, and neither passes through " +
      "the runner's command allow-list. Agent configuration is attempt-immutable and is " +
      "promoted at admission by a human, never introduced by a change (ADR-0030).",
    status: "open",
    outcome: "unknown",
    routing: "blocks",
    waiver: null,
  }));

  return {
    findings,
    check: {
      check_id: "check_agent_config",
      name: "agent-config",
      kind: "policy",
      status: touched.length === 0 ? "passed" : "failed",
      summary:
        touched.length === 0
          ? "0 agent-configuration paths"
          : `${touched.length} agent-configuration path(s)`,
      command: "ADR-0030",
      detail: touched.length === 0 ? null : touched.join(", "),
      duration_ms: null,
      source: "computed",
    },
  };
}
