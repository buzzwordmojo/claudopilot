import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ui } from "../utils/ui.js";
import { loadConfig, configExists } from "../utils/config.js";
import { loadSecrets, maskKey } from "../utils/secrets.js";

const CREDENTIALS_PATH = join(
  process.env.HOME ?? "~",
  ".claude",
  ".credentials.json"
);

export async function auth(): Promise<void> {
  ui.header("claudopilot auth");

  if (!configExists()) {
    ui.error("No .claudopilot.yaml found. Run `claudopilot init` first.");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  if (!config) {
    ui.error("Failed to load config.");
    process.exitCode = 1;
    return;
  }

  const secrets = await loadSecrets();
  if (!secrets.GITHUB_PAT) {
    ui.error("GITHUB_PAT not found in .claudopilot.env — cannot authenticate with GitHub.");
    process.exitCode = 1;
    return;
  }

  // Read Claude OAuth token
  if (!existsSync(CREDENTIALS_PATH)) {
    ui.error(`${CREDENTIALS_PATH} not found. Log into Claude Code first: claude`);
    process.exitCode = 1;
    return;
  }

  let token: string;
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf-8");
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (!oauth) {
      ui.error("No Claude OAuth token found in credentials file. Log into Claude Code first: claude");
      process.exitCode = 1;
      return;
    }
    // Store the full credentials object so the runner can refresh tokens
    token = JSON.stringify({ claudeAiOauth: oauth });
  } catch {
    ui.error(`Could not parse ${CREDENTIALS_PATH}`);
    process.exitCode = 1;
    return;
  }

  // Secrets are set on the primary repo only — workflows run there and companions use GH_PAT
  const repoSlug = `${config.github.owner}/${config.github.repos[0]}`;
  const displayToken = typeof JSON.parse(token).claudeAiOauth === "string"
    ? JSON.parse(token).claudeAiOauth
    : JSON.parse(token).claudeAiOauth?.accessToken ?? "";
  ui.info(`Token: ${maskKey(displayToken)}`);
  ui.info(`Target: ${repoSlug}`);

  const spinner = ui.spinner(`Setting CLAUDE_LONG_LIVED_TOKEN on ${repoSlug}...`);
  try {
    execSync(`gh secret set CLAUDE_LONG_LIVED_TOKEN --repo ${repoSlug}`, {
      input: token,
      env: { ...process.env, GH_TOKEN: secrets.GITHUB_PAT },
      stdio: ["pipe", "pipe", "pipe"],
    });
    spinner.succeed(`  CLAUDE_LONG_LIVED_TOKEN updated on ${repoSlug}`);
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || error?.message || String(error);
    spinner.fail(`  Failed: ${stderr.trim()}`);
    process.exitCode = 1;
  }
}
