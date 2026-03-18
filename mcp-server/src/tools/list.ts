import { defineTool } from "../util.js";
import type { ClickUpClient } from "../clickup.js";

export function createListTools(client: ClickUpClient) {
  const getListTasks = defineTool((z) => ({
    name: "clickup_get_list_tasks",
    description: "Get tasks from a ClickUp list with optional filtering",
    inputSchema: {
      list_id: z.string().describe("ClickUp list ID"),
      archived: z.boolean().optional().describe("Include archived tasks"),
      page: z.number().optional().describe("Page number (0-indexed)"),
      subtasks: z.boolean().optional().describe("Include subtasks"),
      include_closed: z.boolean().optional().describe("Include closed tasks"),
      statuses: z
        .array(z.string())
        .optional()
        .describe("Filter by status names"),
    },
    handler: async (input) => {
      const { list_id, ...params } = input;
      return (await client.getListTasks(list_id, params)) as Record<
        string,
        unknown
      >;
    },
  }));

  return [getListTasks];
}
