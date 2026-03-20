import { execSync } from "node:child_process";
import { ui } from "../utils/ui.js";
import { loadConfig, configExists } from "../utils/config.js";

interface CompetitorsOptions {
  competitors?: string;
}

export async function competitors(options: CompetitorsOptions): Promise<void> {
  ui.header("claudopilot competitors");

  if (!configExists()) {
    ui.error("No .claudopilot.yaml found. Run `claudopilot init` first.");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  if (!config) {
    ui.error("Failed to load config from .claudopilot.yaml");
    process.exitCode = 1;
    return;
  }

  if (!config.competitors?.enabled) {
    ui.error("Competitor tracking is not enabled. Run `claudopilot init` to configure it.");
    process.exitCode = 1;
    return;
  }

  const repo = `${config.github.owner}/${config.github.repos[0]}`;
  const competitorsList = options.competitors ?? "";

  ui.info(`Triggering competitors workflow on ${repo}...`);

  try {
    const cmd = competitorsList
      ? `gh workflow run claudopilot-competitors.yml --repo ${repo} --field competitors="${competitorsList}"`
      : `gh workflow run claudopilot-competitors.yml --repo ${repo}`;

    execSync(cmd, { stdio: "inherit" });
    ui.success("Competitors workflow triggered");
    ui.info(`Watch progress: gh run list --repo ${repo} --workflow claudopilot-competitors.yml`);
  } catch (error) {
    ui.error(`Failed to trigger workflow: ${error}`);
    process.exitCode = 1;
  }
}
