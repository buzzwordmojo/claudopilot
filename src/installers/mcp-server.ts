import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudopilotConfig } from "../types.js";
import { loadSecrets } from "../utils/secrets.js";
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

  // The bundle is ESM — Node needs "type": "module" to run .js files with import statements
  await writeFile(
    join(mcpServerDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
    "utf-8"
  );

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

  // Write secrets from .claudopilot.env into .claude/settings.local.json
  // so Claude Code has them in env for ${VAR} substitution in .mcp.json.
  // settings.local.json is gitignored and never committed.
  const secrets = await loadSecrets(targetDir);
  if (secrets.CLICKUP_API_KEY) {
    const localSettingsPath = join(targetDir, ".claude", "settings.local.json");
    let localSettings: Record<string, unknown> = {};
    if (existsSync(localSettingsPath)) {
      try {
        localSettings = JSON.parse(await readFile(localSettingsPath, "utf-8"));
      } catch {
        // Malformed — will be overwritten
      }
    }
    const env = (localSettings.env as Record<string, string>) ?? {};
    env.CLICKUP_API_KEY = secrets.CLICKUP_API_KEY;
    localSettings.env = env;
    await writeFile(localSettingsPath, JSON.stringify(localSettings, null, 2) + "\n", "utf-8");
  }

  ui.success("MCP server installed in .claude/mcp-server/");
  ui.success(".mcp.json generated at project root");
}
