import type { UsageLimitStop } from "@perbo/contracts";

/**
 * What the command line says about a run that ended on a provider's usage
 * limit, and how it is carried on to another connection
 * (D-NEW-pass-a-limited-loop-on). `perbo run` prints it where the run ends and
 * `perbo inspect` under the attempt, both from `usageLimitStop`.
 *
 * A usage limit is a connection's, so the command it names takes another
 * connection for the role that was limited, and a model of that connection's;
 * the work is taken from the stopped attempt's execution bundle, as any
 * `--resume-from` takes it.
 */
export function usageLimitLines(args: {
  limit: UsageLimitStop;
  /** How `perbo run` names the work again: `--ticket PRB-1`, or what stands for it. */
  subject: string;
  /** The stopped attempt's execution bundle, where one is on record. */
  bundleId: string | null;
}): string[] {
  const { limit } = args;
  const whose = limit.role === "executor" ? "the executor's" : "the reviewer's";
  const said = limit.waited
    ? `refused ${limit.role === "executor" ? "the attempt" : "the review"} again after the run waited ` +
      `out its stated reset at ${limit.until} (${limit.zone})`
    : `refused ${limit.role === "executor" ? "the attempt" : "the review"} on a usage limit until ` +
      `${limit.until} (${limit.zone})`;
  const flags =
    limit.role === "executor"
      ? "--provider <another connection> --model <one of its models>"
      : "--reviewer-provider <another connection> --reviewer-model <one of its models>";
  return [
    `limit   ${whose} connection, ${limit.provider} (${limit.model}), ${said}: ${limit.quoted}`,
    ...(args.bundleId === null
      ? []
      : [
          `pass on perbo run ${args.subject} --resume-from ${args.bundleId} ${flags}`,
          `        or without them, on the same connection, once ${limit.until} has passed`,
        ]),
  ];
}
