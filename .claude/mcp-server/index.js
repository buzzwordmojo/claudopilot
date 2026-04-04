#!/usr/bin/env node

// mcp-server/src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// mcp-server/src/clickup.ts
var BASE_URL = "https://api.clickup.com/api/v2";
var ClickUpClient = class {
  headers;
  workspaceId;
  constructor(apiKey, workspaceId) {
    this.workspaceId = workspaceId;
    this.headers = {
      Authorization: apiKey,
      "Content-Type": "application/json"
    };
  }
  async request(endpoint, options = {}) {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      ...options,
      headers: this.headers
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ClickUp API error ${response.status}: ${body}`);
    }
    return response.json();
  }
  async getTask(taskId) {
    return this.request(
      `/task/${taskId}?team_id=${this.workspaceId}&include_subtasks=true&include_markdown_description=true`
    );
  }
  async createTask(listId, params) {
    return this.request(`/list/${listId}/task`, {
      method: "POST",
      body: JSON.stringify(params)
    });
  }
  async updateTask(taskId, params) {
    return this.request(`/task/${taskId}?team_id=${this.workspaceId}`, {
      method: "PUT",
      body: JSON.stringify(params)
    });
  }
  async getTaskComments(taskId) {
    return this.request(
      `/task/${taskId}/comment?team_id=${this.workspaceId}`
    );
  }
  async createTaskComment(taskId, commentText, commentBlocks) {
    const body = commentBlocks ? { comment: commentBlocks, notify_all: false } : { comment_text: commentText };
    return this.request(
      `/task/${taskId}/comment?team_id=${this.workspaceId}`,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );
  }
  async getListTasks(listId, params = {}) {
    const queryParams = new URLSearchParams();
    if (params.archived !== void 0)
      queryParams.append("archived", params.archived.toString());
    if (params.page !== void 0)
      queryParams.append("page", params.page.toString());
    if (params.subtasks !== void 0)
      queryParams.append("subtasks", params.subtasks.toString());
    if (params.include_closed !== void 0)
      queryParams.append("include_closed", params.include_closed.toString());
    if (params.statuses) {
      for (const status of params.statuses) {
        queryParams.append("statuses[]", status);
      }
    }
    const queryString = queryParams.toString() ? `?${queryParams.toString()}` : "";
    return this.request(
      `/list/${listId}/task${queryString}`
    );
  }
};

// mcp-server/src/util.ts
import { z } from "zod";
var defineTool = (cb) => {
  const tool = cb(z);
  const wrappedHandler = async (input, _) => {
    try {
      const result = await tool.handler(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  };
  return {
    ...tool,
    handler: wrappedHandler
  };
};

// mcp-server/src/tools/task.ts
function createTaskTools(client) {
  const getTask = defineTool((z2) => ({
    name: "clickup_get_task",
    description: "Get a ClickUp task by ID. Returns name, description, status, subtasks, and comments count.",
    inputSchema: {
      task_id: z2.string().describe("ClickUp task ID")
    },
    handler: async (input) => {
      return await client.getTask(input.task_id);
    }
  }));
  const createTask = defineTool((z2) => ({
    name: "clickup_create_task",
    description: "Create a new task in a ClickUp list",
    inputSchema: {
      list_id: z2.string().describe("ClickUp list ID"),
      name: z2.string().describe("Task name"),
      markdown_description: z2.string().optional().describe("Task description in markdown format"),
      status: z2.string().optional().describe("Task status"),
      tags: z2.array(z2.string()).optional().describe("Array of tag names"),
      parent: z2.string().optional().describe("Parent task ID to create this as a subtask")
    },
    handler: async (input) => {
      const { list_id, ...params } = input;
      return await client.createTask(list_id, params);
    }
  }));
  const updateTask = defineTool((z2) => ({
    name: "clickup_update_task",
    description: "Update a ClickUp task (status, description, assignees)",
    inputSchema: {
      task_id: z2.string().describe("ClickUp task ID"),
      name: z2.string().optional().describe("Task name"),
      markdown_description: z2.string().optional().describe("Task description in markdown format"),
      status: z2.string().optional().describe("Task status"),
      assignees: z2.object({
        add: z2.array(z2.number()).optional().describe("User IDs to add"),
        rem: z2.array(z2.number()).optional().describe("User IDs to remove")
      }).optional().describe("Assignee changes")
    },
    handler: async (input) => {
      const { task_id, ...params } = input;
      return await client.updateTask(task_id, params);
    }
  }));
  return [getTask, createTask, updateTask];
}

// mcp-server/src/markdown-to-clickup.ts
function markdownToClickUp(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const codeBlockMatch = line.match(/^```(\w*)$/);
    if (codeBlockMatch) {
      const lang = codeBlockMatch[1] || "plain";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({
        text: codeLines.join("\n"),
        attributes: {}
      });
      blocks.push({
        text: "\n",
        attributes: { "code-block": { "code-block": lang } }
      });
      continue;
    }
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      blocks.push(...parseInline(headingMatch[1], { bold: true }));
      blocks.push({ text: "\n", attributes: {} });
      i++;
      continue;
    }
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2);
      blocks.push(...parseInline(bulletMatch[2]));
      const attrs = { list: "bullet" };
      if (indent > 0) attrs.indent = indent;
      blocks.push({ text: "\n", attributes: attrs });
      i++;
      continue;
    }
    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (orderedMatch) {
      const indent = Math.floor(orderedMatch[1].length / 2);
      blocks.push(...parseInline(orderedMatch[2]));
      const attrs = { list: "ordered" };
      if (indent > 0) attrs.indent = indent;
      blocks.push({ text: "\n", attributes: attrs });
      i++;
      continue;
    }
    if (line.trim() === "") {
      blocks.push({ text: "\n", attributes: {} });
      i++;
      continue;
    }
    blocks.push(...parseInline(line));
    blocks.push({ text: "\n", attributes: {} });
    i++;
  }
  return blocks;
}
function parseInline(text, baseAttrs = {}) {
  const blocks = [];
  const inlineRe = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let match;
  while ((match = inlineRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      blocks.push({ text: plain, attributes: { ...baseAttrs } });
    }
    if (match[1]) {
      blocks.push({
        text: match[2],
        attributes: { ...baseAttrs, bold: true }
      });
    } else if (match[3]) {
      blocks.push({
        text: match[4],
        attributes: { ...baseAttrs, italic: true }
      });
    } else if (match[5]) {
      blocks.push({
        text: match[6],
        attributes: { ...baseAttrs, code: true }
      });
    } else if (match[7]) {
      blocks.push({
        text: match[8],
        attributes: { ...baseAttrs, link: match[9] }
      });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    blocks.push({ text: remaining, attributes: { ...baseAttrs } });
  }
  if (blocks.length === 0) {
    blocks.push({ text, attributes: { ...baseAttrs } });
  }
  return blocks;
}

// mcp-server/src/tools/comment.ts
function createCommentTools(client) {
  const getTaskComments = defineTool((z2) => ({
    name: "clickup_get_task_comments",
    description: "Get all comments on a ClickUp task",
    inputSchema: {
      task_id: z2.string().describe("ClickUp task ID")
    },
    handler: async (input) => {
      return await client.getTaskComments(input.task_id);
    }
  }));
  const createTaskComment = defineTool((z2) => ({
    name: "clickup_create_task_comment",
    description: "Post a comment on a ClickUp task. Supports markdown formatting (bold, italic, code, links, lists, code blocks).",
    inputSchema: {
      task_id: z2.string().describe("ClickUp task ID"),
      comment_text: z2.string().describe(
        "Comment text in markdown format. Supports **bold**, *italic*, `code`, [links](url), bullet/ordered lists, and ```code blocks```."
      )
    },
    handler: async (input) => {
      const blocks = markdownToClickUp(input.comment_text);
      return await client.createTaskComment(
        input.task_id,
        input.comment_text,
        blocks
      );
    }
  }));
  return [getTaskComments, createTaskComment];
}

// mcp-server/src/tools/list.ts
function createListTools(client) {
  const getListTasks = defineTool((z2) => ({
    name: "clickup_get_list_tasks",
    description: "Get tasks from a ClickUp list with optional filtering",
    inputSchema: {
      list_id: z2.string().describe("ClickUp list ID"),
      archived: z2.boolean().optional().describe("Include archived tasks"),
      page: z2.number().optional().describe("Page number (0-indexed)"),
      subtasks: z2.boolean().optional().describe("Include subtasks"),
      include_closed: z2.boolean().optional().describe("Include closed tasks"),
      statuses: z2.array(z2.string()).optional().describe("Filter by status names")
    },
    handler: async (input) => {
      const { list_id, ...params } = input;
      return await client.getListTasks(list_id, params);
    }
  }));
  return [getListTasks];
}

// mcp-server/src/index.ts
async function main() {
  const apiKey = process.env.CLICKUP_API_KEY;
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    console.error(
      "CLICKUP_API_KEY and CLICKUP_WORKSPACE_ID environment variables are required"
    );
    process.exit(1);
  }
  const client = new ClickUpClient(apiKey, workspaceId);
  const tools = [
    ...createTaskTools(client),
    ...createCommentTools(client),
    ...createListTools(client)
  ];
  const server = new McpServer(
    {
      name: "claudopilot-clickup",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );
  tools.forEach((tool) => {
    server.tool(tool.name, tool.description, tool.inputSchema, tool.handler);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("claudopilot-clickup MCP server running on stdio");
}
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
