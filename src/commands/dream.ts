import { execSync } from "node:child_process";
import { ui } from "../utils/ui.js";
import { loadConfig, configExists } from "../utils/config.js";

export async function dream(): Promise<void> {
  ui.header("claudopilot dream");

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

  if (!config.dream?.enabled) {
    ui.error("Dream is not enabled. Run `claudopilot init` to configure it.");
    process.exitCode = 1;
    return;
  }

  const repo = `${config.github.owner}/${config.github.repos[0]}`;

  ui.info(`Triggering dream workflow on ${repo}...`);

  try {
    execSync(`gh workflow run claudopilot-dream.yml --repo ${repo}`, {
      stdio: "inherit",
    });
    ui.success("Dream workflow triggered");
    ui.info(`Watch progress: gh run list --repo ${repo} --workflow claudopilot-dream.yml`);
  } catch (error) {
    ui.error(`Failed to trigger workflow: ${error}`);
    process.exitCode = 1;
  }
}
