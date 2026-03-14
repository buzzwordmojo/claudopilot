import { existsSync } from "node:fs";
import { join } from "node:path";
import { ui } from "../utils/ui.js";
import { loadConfig } from "../utils/config.js";
import { loadSecrets } from "../utils/secrets.js";
import { ClickUpAdapter } from "../adapters/clickup.js";

export async function doctor(): Promise<void> {
  ui.banner();
  ui.header("Health Check");

  const config = await loadConfig();
  if (!config) {
    ui.error("No .claudopilot.yaml found. Run 'claudopilot init' first.");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  let warned = 0;

  // Check config file
  ui.success("Config file: .claudopilot.yaml");
  passed++;

  // Check CLAUDE.md
  if (existsSync(join(process.cwd(), "CLAUDE.md"))) {
    ui.success("CLAUDE.md exists");
    passed++;
  } else {
    ui.warn("CLAUDE.md not found (recommended for Claude Code context)");
    warned++;
  }

  // Check Claude commands
  const commandsDir = join(process.cwd(), ".claude", "commands");
  const expectedCommands = [
    "plan-feature.md",
    "red-team.md",
    "implement.md",
  ];
  for (const cmd of expectedCommands) {
    if (existsSync(join(commandsDir, cmd))) {
      ui.success(`Claude command: ${cmd}`);
      passed++;
    } else {
      ui.error(`Missing Claude command: ${cmd}`);
      failed++;
    }
  }

  // Check GitHub Actions
  const workflowsDir = join(process.cwd(), ".github", "workflows");
  const expectedWorkflows = [
    "claude.yml",
    "security-review.yml",
    "claudopilot-worker.yml",
  ];
  for (const wf of expectedWorkflows) {
    if (existsSync(join(workflowsDir, wf))) {
      ui.success(`GitHub Action: ${wf}`);
      passed++;
    } else {
      ui.error(`Missing workflow: ${wf}`);
      failed++;
    }
  }

  // Check CodeRabbit config
  if (existsSync(join(process.cwd(), ".coderabbit.yaml"))) {
    ui.success("CodeRabbit config: .coderabbit.yaml");
    passed++;
  } else {
    ui.warn("No .coderabbit.yaml (optional but recommended)");
    warned++;
  }

  // Check ClickUp connection
  const secrets = await loadSecrets();
  const clickupKey = secrets.CLICKUP_API_KEY ?? config.pm.apiKey;
  if (clickupKey) {
    const spinner = ui.spinner("Testing ClickUp connection...");
    try {
      const adapter = new ClickUpAdapter(clickupKey);
      const valid = await adapter.validateCredentials();
      if (valid) {
        spinner.succeed("  ClickUp API: connected");
        passed++;
      } else {
        spinner.fail("  ClickUp API: invalid credentials");
        failed++;
      }
    } catch {
      spinner.fail("  ClickUp API: connection failed");
      failed++;
    }
  } else {
    ui.warn("No ClickUp API key found in .claudopilot.env");
    warned++;
  }

  // Check Cloudflare Worker
  if (config.cloudflare?.workerUrl) {
    const spinner = ui.spinner("Testing Cloudflare Worker...");
    try {
      const res = await fetch(config.cloudflare.workerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      if (res.ok || res.status === 401) {
        // 401 is expected without the secret
        spinner.succeed("  Cloudflare Worker: reachable");
        passed++;
      } else {
        spinner.fail(`  Cloudflare Worker: HTTP ${res.status}`);
        failed++;
      }
    } catch {
      spinner.fail("  Cloudflare Worker: unreachable");
      failed++;
    }
  } else {
    ui.warn("No Cloudflare Worker configured (webhook bridge disabled)");
    warned++;
  }

  // Summary
  ui.blank();
  ui.header("Summary");
  ui.success(`${passed} checks passed`);
  if (warned > 0) ui.warn(`${warned} warnings`);
  if (failed > 0) ui.error(`${failed} checks failed`);
  ui.blank();

  if (failed > 0) {
    ui.info("Run 'claudopilot init' to fix missing components.");
    process.exit(1);
  }
}
