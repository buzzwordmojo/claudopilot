import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudopilotConfig } from "../types.js";
import { ui } from "../utils/ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function installMcpServer(
  _config: ClaudopilotConfig,
  targetDir: string = process.cwd()
): Promise<void> {
  const mcpServerDir = join(targetDir, ".claude", "mcp-server");
  await mkdir(mcpServerDir, { recursive: true });

  // Copy the pre-built MCP server bundle
  // In dev: relative to src/installers/ → ../../mcp-server/dist/index.js
  // In dist: relative to dist/ → ../mcp-server/dist/index.js
  const possiblePaths = [
    join(__dirname, "..", "..", "mcp-server", "dist", "index.js"),
    join(__dirname, "..", "mcp-server", "dist", "index.js"),
  ];

  let sourcePath: string | undefined;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      sourcePath = p;
      break;
    }
  }

  if (!sourcePath) {
    ui.warn(
      "MCP server bundle not found — run `npm run build:mcp` first. Skipping MCP server install."
    );
    return;
  }

  await copyFile(sourcePath, join(mcpServerDir, "index.js"));

  // Generate .mcp.json at project root
  // CLICKUP_API_KEY is expanded from env at runtime by Claude Code.
  // CLICKUP_WORKSPACE_ID is baked in from config since it's not secret.
  const mcpConfig = {
    mcpServers: {
      clickup: {
        command: "node",
        args: [".claude/mcp-server/index.js"],
        env: {
          CLICKUP_API_KEY: "${CLICKUP_API_KEY}",
          CLICKUP_WORKSPACE_ID: _config.pm.workspaceId ?? "",
        },
      },
    },
  };

  await writeFile(
    join(targetDir, ".mcp.json"),
    JSON.stringify(mcpConfig, null, 2) + "\n",
    "utf-8"
  );

  ui.success("MCP server installed in .claude/mcp-server/");
  ui.success(".mcp.json generated at project root");
}
