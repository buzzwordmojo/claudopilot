import { defineTool } from "../util.js";
import { markdownToClickUp } from "../markdown-to-clickup.js";
import type { ClickUpClient } from "../clickup.js";

export function createCommentTools(client: ClickUpClient) {
  const getTaskComments = defineTool((z) => ({
    name: "clickup_get_task_comments",
    description: "Get all comments on a ClickUp task",
    inputSchema: {
      task_id: z.string().describe("ClickUp task ID"),
    },
    handler: async (input) => {
      return (await client.getTaskComments(input.task_id)) as Record<
        string,
        unknown
      >;
    },
  }));

  const createTaskComment = defineTool((z) => ({
    name: "clickup_create_task_comment",
    description:
      "Post a comment on a ClickUp task. Supports markdown formatting (bold, italic, code, links, lists, code blocks).",
    inputSchema: {
      task_id: z.string().describe("ClickUp task ID"),
      comment_text: z
        .string()
        .describe(
          "Comment text in markdown format. Supports **bold**, *italic*, `code`, [links](url), bullet/ordered lists, and ```code blocks```."
        ),
    },
    handler: async (input) => {
      const blocks = markdownToClickUp(input.comment_text);
      return (await client.createTaskComment(
        input.task_id,
        input.comment_text,
        blocks
      )) as Record<string, unknown>;
    },
  }));

  return [getTaskComments, createTaskComment];
}
