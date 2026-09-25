import { z } from "zod";

const EntrySchema = z.object({
  type: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  subagent: z.boolean().optional(),
  item: z
    .object({
      type: z.string(),
      text: z.string().optional(),
      command: z.string().optional(),
      aggregatedOutput: z.string().optional(),
    })
    .optional(),
  message: z
    .object({
      content: z.array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        }),
      ),
    })
    .optional(),
});
export interface TranscriptEntry {
  author: string;
  label: string;
  text: string;
}

/**
 * Interpret only documented display fields; provider records never become actions.
 * The transcript is each turn the executor's own session spoke, as the run
 * printed it while it went — never a subagent's words (a Claude turn with a
 * `parent_tool_use_id`, a Codex item marked `subagent`) and never a row per
 * tool call: the commands it ran, a subagent's among them, are the terminal's.
 */
export function retainedOutput(raw: string | null | undefined): {
  entries: TranscriptEntry[];
  terminal: string;
} {
  const entries: TranscriptEntry[] = [],
    commands: string[] = [];
  for (const line of raw?.split("\n") ?? []) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = EntrySchema.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (entry.item?.type === "commandExecution")
      commands.push(
        "$ " +
          (entry.item.command ?? "command") +
          "\n" +
          (entry.item.aggregatedOutput ?? "No output retained."),
      );
    if (entry.item?.type === "agentMessage" && entry.item.text && entry.subagent !== true)
      entries.push({ author: "Executor", label: "message", text: entry.item.text });
    // One entry per turn, its text blocks together, as the run printed it.
    const said =
      entry.type === "assistant" && !entry.parent_tool_use_id
        ? (entry.message?.content ?? [])
            .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
            .join("\n")
            .trim()
        : "";
    if (said) entries.push({ author: "Executor", label: "message", text: said });
  }
  return { entries, terminal: commands.join("\n\n") };
}
