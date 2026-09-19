## Linked ticket and approved contract

- Ticket / external issue:
- Plan version:
- Execution attempt / run bundle:
- Decision or ADR, when applicable:

## Intended outcome

What user or operating outcome should change? What is the observation metric and window?

## Change set

Summarise changed packages, services, data, configuration, contracts, integrations, and external behaviour.

## Acceptance-criteria coverage

- [ ] Every criterion has a linked check, artifact, metric, or named manual review.
- [ ] No criterion is `asserted_only` at P2 or above; each `directly_verified` criterion names its assertion.
- [ ] Scope matches the approved contract, or the deviation is within `expansion_budget_files` and recorded as advisory.
- [ ] The pinned context is still valid; any base advance did not overlap the plan's scope.

## Verification and independence

- [ ] Affected lint, type, unit, integration, contract, and E2E checks required by risk pass.
- [ ] Security, data, migration, dependency, licence, and cost checks required by risk pass.
- [ ] Independent review has no unresolved blocking finding, or an authorised waiver with an expiry is linked.
- [ ] The reviewer did not receive the executor's narrative or transcript.
- [ ] Run-bundle capture is complete for model- or tool-mediated work, and the `replayability` tier is recorded.
- [ ] A human is merging this. The system does not merge its own pull request.

## Trust boundary and agent authority

- [ ] No repository or external content occupied an instruction position.
- [ ] Any review verdict was structured output over plan-supplied criteria, not parsed prose.
- [ ] Deterministic check results took precedence over model assertions about them.
- [ ] No prohibited action was attempted; any denial is audited.
- Outbound hosts contacted during execution:

## Source authority and external effects

- Authoritative source/field groups changed:
- New connector permissions or data exposure:
- External actions and idempotency/compensation:
- Conflict, staleness, or backfill behaviour:

## Cost, rollout, and operations

- Estimated one-off and recurring cost delta:
- Actual execution/model/provider cost:
- Rollout/canary plan:
- Rollback or forward-recovery plan:
- SLO, alert, runbook, and kill-switch impact:

## Architecture and documentation impact

Check any changed surface and link the corresponding update:

- [ ] Domain/entity/event/state machine
- [ ] Source authority or sync direction
- [ ] Autonomy/risk/approval policy
- [ ] Planning/review/run-bundle/evaluation contract
- [ ] Trust boundary, prohibited action, or agent permission profile
- [ ] Public promise, target customer, or roadmap gate
- [ ] No canonical architecture surface changed

Where applicable, the specification, ADR/decision register, diagram and evaluation fixture were updated in the same pull request.
