#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClickUpClient } from "./clickup.js";
import { createTaskTools } from "./tools/task.js";
import { createCommentTools } from "./tools/comment.js";
import { createListTools } from "./tools/list.js";

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
    ...createListTools(client),
  ];

  const server = new McpServer(
    {
      name: "claudopilot-clickup",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
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
