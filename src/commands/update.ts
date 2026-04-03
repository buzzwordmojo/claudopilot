import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
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

const PKG_NAME = "@buzzwordmojo/claudopilot";

const require = createRequire(import.meta.url);
const { version: currentVersion } = require("../../package.json");

interface UpdateOptions {
  includeWorker?: boolean;
  skipSelfUpdate?: boolean;
}

/**
 * Resolve the claudopilot repo root from the running script's location.
 * tsup bundles everything into a single dist/cli.js, so repo root is one level up.
 */
function getRepoRoot(): string {
  // Resolve symlinks (e.g. /usr/bin/claudopilot -> .../claudopilot/dist/cli.js)
  const scriptPath = realpathSync(process.argv[1]);
  return resolve(dirname(scriptPath), "..");
}

/**
 * Detect whether we're running from a git clone (npm link) or an npm install.
 */
function isGitInstall(): boolean {
  const repoRoot = getRepoRoot();
  return existsSync(resolve(repoRoot, ".git"));
}

/**
 * Self-update via git pull + rebuild (for npm link / dev installs).
 */
async function selfUpdateFromGit(repoRoot: string, args: string[]): Promise<boolean> {
  const spinner = ui.spinner("Pulling latest claudopilot...");

  // Stash any local changes so git pull --rebase can proceed
  let didStash = false;
  try {
    const stashOutput = execSync("git stash --include-untracked", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    didStash = !stashOutput.includes("No local changes to save");
  } catch {
    // If stash fails, continue anyway — pull may still work
  }

  try {
    const pullOutput = execSync("git pull --rebase", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (pullOutput === "Current branch main is up to date.") {
      spinner.succeed("  claudopilot already up to date");
    } else {
      spinner.succeed(`  claudopilot updated`);
    }
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || error?.message || String(error);
    spinner.fail(`  Failed to pull latest: ${stderr.trim()}`);
    ui.warn("Continuing with current version...");
    if (didStash) {
      try { execSync("git stash pop", { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }); } catch {}
    }
    return false;
  }

  // Restore stashed changes
  if (didStash) {
    try {
      execSync("git stash pop", { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      ui.warn("Could not restore stashed changes — run `git stash pop` manually in claudopilot repo");
    }
  }

  const buildSpinner = ui.spinner("Rebuilding claudopilot...");
  try {
    execSync("npm run build", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    buildSpinner.succeed("  claudopilot rebuilt");
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || error?.message || String(error);
    buildSpinner.fail(`  Build failed: ${stderr.trim()}`);
    ui.warn("Continuing with current version...");
    return false;
  }

  // Re-exec with the freshly built CLI
  const cliPath = resolve(repoRoot, "dist", "cli.js");
  const reExecArgs = ["update", "--skip-self-update", ...args];
  ui.info("Re-running update with latest version...\n");
  try {
    execSync(`node ${cliPath} ${reExecArgs.join(" ")}`, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
  } catch {
    // Exit code propagated via stdio inherit
  }
  return true;
}

/**
 * Self-update via npm (for global npm installs).
 */
async function selfUpdateFromNpm(): Promise<boolean> {
  const spinner = ui.spinner("Checking for updates...");
  try {
    const latest = execSync(`npm view ${PKG_NAME} version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (latest === currentVersion) {
      spinner.succeed(`  claudopilot v${currentVersion} is already the latest`);
      return false;
    }

    spinner.succeed(`  New version available: v${currentVersion} → v${latest}`);
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || error?.message || String(error);
    spinner.fail(`  Failed to check for updates: ${stderr.trim()}`);
    ui.warn("Continuing with current version...");
    return false;
  }

  const installSpinner = ui.spinner(`Updating ${PKG_NAME}...`);
  try {
    execSync(`npm install -g ${PKG_NAME}@latest`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    installSpinner.succeed("  claudopilot updated");
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() || error?.message || String(error);
    installSpinner.fail(`  Update failed: ${stderr.trim()}`);
    ui.warn("Continuing with current version...");
    return false;
  }

  // Re-exec with the freshly installed CLI
  ui.info("Re-running update with latest version...\n");
  try {
    execSync(`claudopilot update --skip-self-update`, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
  } catch {
    // Exit code propagated via stdio inherit
  }
  return true;
}

export async function update(options: UpdateOptions): Promise<void> {
  ui.header("claudopilot update");

  // Self-update unless --skip-self-update was passed (to avoid infinite loop)
  if (!options.skipSelfUpdate) {
    let reExeced: boolean;

    if (isGitInstall()) {
      const repoRoot = getRepoRoot();
      const passthrough: string[] = [];
      if (options.includeWorker) passthrough.push("--include-worker");
      reExeced = await selfUpdateFromGit(repoRoot, passthrough);
    } else {
      reExeced = await selfUpdateFromNpm();
    }

    if (reExeced) return; // Fresh version already ran
  }

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
        // Build webhook config so worker deploy also ensures the ClickUp webhook
        const clickupKey = secrets.CLICKUP_API_KEY ?? config.pm.apiKey;
        const webhookConfig =
          clickupKey && config.pm.workspaceId
            ? {
                clickupApiKey: clickupKey,
                workspaceId: config.pm.workspaceId,
                automationsConfig: config.automations,
              }
            : undefined;

        await deployCloudflareWorker(
          {
            ...config.cloudflare,
            apiToken: secrets.CLOUDFLARE_API_TOKEN,
            accountId: secrets.CLOUDFLARE_ACCOUNT_ID,
          },
          config.github,
          secrets.GITHUB_PAT,
          secrets.CLICKUP_API_KEY,
          config.automations,
          config.pm.sdlcListIds ?? (config.pm.listId ? [config.pm.listId] : []),
          webhookConfig
        );
        ui.success("Cloudflare Worker redeployed");
      } catch (error) {
        ui.error(`Cloudflare Worker deploy failed: ${error}`);
      }
    }
  }

  ui.success("Update complete");
}
