import { defineTool } from "../util.js";
import type { ClickUpClient } from "../clickup.js";

export function createTaskTools(client: ClickUpClient) {
  const getTask = defineTool((z) => ({
    name: "clickup_get_task",
    description:
      "Get a ClickUp task by ID. Returns name, description, status, subtasks, and comments count.",
    inputSchema: {
      task_id: z.string().describe("ClickUp task ID"),
    },
    handler: async (input) => {
      return (await client.getTask(input.task_id)) as Record<string, unknown>;
    },
  }));

  const createTask = defineTool((z) => ({
    name: "clickup_create_task",
    description: "Create a new task in a ClickUp list",
    inputSchema: {
      list_id: z.string().describe("ClickUp list ID"),
      name: z.string().describe("Task name"),
      markdown_description: z
        .string()
        .optional()
        .describe("Task description in markdown format"),
      status: z.string().optional().describe("Task status"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Array of tag names"),
      parent: z
        .string()
        .optional()
        .describe("Parent task ID to create this as a subtask"),
    },
    handler: async (input) => {
      const { list_id, ...params } = input;
      return (await client.createTask(list_id, params)) as Record<
        string,
        unknown
      >;
    },
  }));

  const updateTask = defineTool((z) => ({
    name: "clickup_update_task",
    description: "Update a ClickUp task (status, description, assignees)",
    inputSchema: {
      task_id: z.string().describe("ClickUp task ID"),
      name: z.string().optional().describe("Task name"),
      markdown_description: z
        .string()
        .optional()
        .describe("Task description in markdown format"),
      status: z.string().optional().describe("Task status"),
      assignees: z
        .object({
          add: z
            .array(z.number())
            .optional()
            .describe("User IDs to add"),
          rem: z
            .array(z.number())
            .optional()
            .describe("User IDs to remove"),
        })
        .optional()
        .describe("Assignee changes"),
    },
    handler: async (input) => {
      const { task_id, ...params } = input;
      return (await client.updateTask(task_id, params)) as Record<
        string,
        unknown
      >;
    },
  }));

  return [getTask, createTask, updateTask];
}
