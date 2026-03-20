import { execSync } from "node:child_process";
import { ui } from "../utils/ui.js";
import { loadConfig, configExists } from "../utils/config.js";

interface ImproveOptions {
  lenses?: string;
}

export async function improve(options: ImproveOptions): Promise<void> {
  ui.header("claudopilot improve");

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

  if (!config.improve?.enabled) {
    ui.error("Improve is not enabled. Run `claudopilot init` to configure it.");
    process.exitCode = 1;
    return;
  }

  const repo = `${config.github.owner}/${config.github.repos[0]}`;
  const lenses = options.lenses ?? "";

  ui.info(`Triggering improve workflow on ${repo}...`);

  try {
    const cmd = lenses
      ? `gh workflow run claudopilot-improve.yml --repo ${repo} --field lenses="${lenses}"`
      : `gh workflow run claudopilot-improve.yml --repo ${repo}`;

    execSync(cmd, { stdio: "inherit" });
    ui.success("Improve workflow triggered");
    ui.info(`Watch progress: gh run list --repo ${repo} --workflow claudopilot-improve.yml`);
  } catch (error) {
    ui.error(`Failed to trigger workflow: ${error}`);
    process.exitCode = 1;
  }
}
