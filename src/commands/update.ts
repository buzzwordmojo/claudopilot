import { ui } from "../utils/ui.js";
import { loadConfig, configExists } from "../utils/config.js";
import { loadSecrets } from "../utils/secrets.js";
import {
  installClaudeCommands,
  installClaudeMd,
} from "../installers/claude-commands.js";
import { installGitHubActions } from "../installers/github-actions.js";
import { installCodeRabbitConfig } from "../installers/coderabbit.js";
import { deployCloudflareWorker } from "../installers/cloudflare-worker.js";
import { installMcpServer } from "../installers/mcp-server.js";

interface UpdateOptions {
  includeWorker?: boolean;
}

export async function update(options: UpdateOptions): Promise<void> {
  ui.header("claudopilot update");

  if (!configExists()) {
    ui.error(
      "No .claudopilot.yaml found. Run `claudopilot init` first."
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  if (!config) {
    ui.error("Failed to load config from .claudopilot.yaml");
    process.exitCode = 1;
    return;
  }

  const secrets = await loadSecrets();
  const totalSteps = options.includeWorker ? 6 : 5;

  // Re-generate local files
  ui.step(1, totalSteps, "Regenerating Claude commands...");
  await installClaudeCommands(config);

  ui.step(2, totalSteps, "Regenerating GitHub Actions workflows...");
  await installGitHubActions(config);

  ui.step(3, totalSteps, "Checking CodeRabbit config...");
  await installCodeRabbitConfig();

  ui.step(4, totalSteps, "Checking CLAUDE.md...");
  await installClaudeMd(config);

  ui.step(5, totalSteps, "Updating MCP server...");
  await installMcpServer(config);

  // Optionally redeploy Cloudflare Worker
  if (options.includeWorker) {
    ui.step(6, 6, "Redeploying Cloudflare Worker...");

    if (!config.cloudflare) {
      ui.warn("No Cloudflare config found in .claudopilot.yaml — skipping worker deploy");
    } else if (!secrets.CLOUDFLARE_API_TOKEN || !secrets.CLOUDFLARE_ACCOUNT_ID) {
      ui.error("Cloudflare secrets missing from .claudopilot.env — cannot deploy worker");
    } else if (!secrets.GITHUB_PAT) {
      ui.error("GitHub PAT missing from .claudopilot.env — cannot deploy worker");
    } else {
      try {
        await deployCloudflareWorker(
          {
            ...config.cloudflare,
            apiToken: secrets.CLOUDFLARE_API_TOKEN,
            accountId: secrets.CLOUDFLARE_ACCOUNT_ID,
          },
          config.github,
          secrets.GITHUB_PAT,
          secrets.CLICKUP_API_KEY
        );
        ui.success("Cloudflare Worker redeployed");
      } catch (error) {
        ui.error(`Cloudflare Worker deploy failed: ${error}`);
      }
    }
  }

  ui.success("Update complete");
}
