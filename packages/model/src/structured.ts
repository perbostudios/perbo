import { READ_FILE_TOOL, SUBMIT_REVIEW_TOOL, type ModelRequest, type ToolCall } from "./turn.js";

export interface StructuredTurn {
  next?: string;
  read_paths?: unknown;
  review?: unknown;
}

/**
 * One schema covers both moves a structured-output CLI transport can make.
 * The review orchestrator still sees the same two tool calls as the direct
 * provider; only their wire representation differs.
 */
export function structuredTurnSchema(
  submitSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["next", "read_paths", "review"],
    properties: {
      next: {
        type: "string",
        enum: ["read_files", "submit_review"],
        description:
          "read_files to open more of the repository before deciding; submit_review when done.",
      },
      read_paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Repository-relative paths to open, exactly as they appear in the listing. Empty when submitting.",
      },
      review: {
        anyOf: [submitSchema, { type: "null" }],
        description: "The completed review when next is submit_review, otherwise null.",
      },
    },
  };
}

/** Render the orchestrator's last message as the text a CLI turn receives. */
export function lastUserText(request: ModelRequest): string {
  const last = request.messages[request.messages.length - 1];
  const content = last?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((block) => {
      const item = block as { type?: string; text?: string; content?: string };
      if (item.type === "tool_result") return item.content ?? "";
      return item.text ?? "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function structuredTurnToolCalls(structured: StructuredTurn): ToolCall[] {
  if (structured.next === "submit_review" && structured.review) {
    return [{ id: "cli_submit", name: SUBMIT_REVIEW_TOOL, input: structured.review }];
  }

  const paths = Array.isArray(structured.read_paths)
    ? structured.read_paths.filter((path): path is string => typeof path === "string")
    : [];
  return paths.map((path, index) => ({
    id: `cli_read_${index}`,
    name: READ_FILE_TOOL,
    input: { path },
  }));
}
