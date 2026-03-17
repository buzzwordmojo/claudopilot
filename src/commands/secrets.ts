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

interface SecretsOptions {
  dryRun?: boolean;
}

interface SecretEntry {
  ghSecretName: string;
  value: string | undefined;
  source: string;
  description: string;
  warning?: string;
}

export async function secrets(options: SecretsOptions): Promise<void> {
  ui.header("claudopilot secrets");

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

  const localSecrets = await loadSecrets();
  const repoSlug = `${config.github.owner}/${config.github.repos[0]}`;

  // Read Claude OAuth token
  let claudeOAuthToken: string | undefined;
  if (existsSync(CREDENTIALS_PATH)) {
    try {
      const raw = await readFile(CREDENTIALS_PATH, "utf-8");
      const creds = JSON.parse(raw);
      claudeOAuthToken = creds.claudeAiOauth;
    } catch {
      ui.warn(`Could not parse ${CREDENTIALS_PATH}`);
    }
  }

  // Build the list of secrets to sync
  const entries: SecretEntry[] = [
    {
      ghSecretName: "CLAUDE_LONG_LIVED_TOKEN",
      value: claudeOAuthToken,
      source: "~/.claude/.credentials.json",
      description: "Claude subscription OAuth token (planning + implementation workflows)",
      warning:
        "This token is tied to your personal Claude subscription. " +
        "It may expire when you re-login to Claude Code — re-run this command to refresh.",
    },
    {
      ghSecretName: "CLICKUP_API_KEY",
      value: localSecrets.CLICKUP_API_KEY,
      source: ".claudopilot.env",
      description: "ClickUp API key (task comments + status updates)",
    },
    {
      ghSecretName: "GH_PAT",
      value: localSecrets.GITHUB_PAT,
      source: ".claudopilot.env",
      description: "GitHub PAT (branch creation + PR + workflow checkout)",
    },
    {
      ghSecretName: "ANTHROPIC_API_KEY",
      value: localSecrets.ANTHROPIC_API_KEY,
      source: ".claudopilot.env",
      description: "Anthropic API key (@claude mentions + security review)",
    },
  ];

  // Show what we found
  ui.info(`Target: ${repoSlug}`);
  ui.blank();

  const available = entries.filter((e) => e.value);
  const missing = entries.filter((e) => !e.value);

  for (const entry of available) {
    ui.success(`${entry.ghSecretName} — ${maskKey(entry.value!)}`);
    console.log(`      ${entry.description}`);
    if (entry.warning) {
      ui.warn(entry.warning);
    }
  }

  for (const entry of missing) {
    ui.warn(`${entry.ghSecretName} — not found (${entry.source})`);
    console.log(`      ${entry.description}`);
  }

  if (available.length === 0) {
    ui.error("No secrets found to sync.");
    process.exitCode = 1;
    return;
  }

  ui.blank();

  if (options.dryRun) {
    ui.info(`Dry run — would set ${available.length} secret(s) on ${repoSlug}`);
    return;
  }

  if (!localSecrets.GITHUB_PAT) {
    ui.error("GITHUB_PAT not found in .claudopilot.env — cannot authenticate with GitHub.");
    process.exitCode = 1;
    return;
  }

  // Sync each secret
  let succeeded = 0;
  let failed = 0;

  for (const entry of available) {
    const spinner = ui.spinner(`Setting ${entry.ghSecretName} on ${repoSlug}...`);
    try {
      execSync(`gh secret set ${entry.ghSecretName} --repo ${repoSlug}`, {
        input: entry.value,
        env: { ...process.env, GH_TOKEN: localSecrets.GITHUB_PAT },
        stdio: ["pipe", "pipe", "pipe"],
      });
      spinner.succeed(`  ${entry.ghSecretName} set on ${repoSlug}`);
      succeeded++;
    } catch (error: any) {
      const stderr =
        error?.stderr?.toString?.() || error?.message || String(error);
      spinner.fail(`  ${entry.ghSecretName}: ${stderr.trim()}`);
      failed++;
    }
  }

  ui.blank();
  if (failed === 0) {
    ui.success(`${succeeded} secret(s) synced to ${repoSlug}`);
  } else {
    ui.warn(`${succeeded} synced, ${failed} failed`);
  }

  if (missing.length > 0) {
    ui.info(
      `${missing.length} secret(s) skipped (not found locally): ${missing.map((e) => e.ghSecretName).join(", ")}`
    );
  }
}
