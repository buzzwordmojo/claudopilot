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

  // Check improve command
  if (config.improve?.enabled) {
    if (existsSync(join(commandsDir, "improve.md"))) {
      ui.success("Claude command: improve.md");
      passed++;
    } else {
      ui.error("Missing Claude command: improve.md (improve enabled)");
      failed++;
    }
  }

  // Check MCP server
  const mcpJsonPath = join(process.cwd(), ".mcp.json");
  const mcpServerPath = join(process.cwd(), ".claude", "mcp-server", "index.js");

  if (existsSync(mcpJsonPath)) {
    ui.success("MCP config: .mcp.json");
    passed++;
  } else {
    ui.error("Missing .mcp.json (run 'claudopilot update' to generate)");
    failed++;
  }

  if (existsSync(mcpServerPath)) {
    ui.success("MCP server: .claude/mcp-server/index.js");
    passed++;
  } else {
    ui.error("Missing MCP server bundle (run 'claudopilot update' to install)");
    failed++;
  }

  // Check GitHub Actions
  const workflowsDir = join(process.cwd(), ".github", "workflows");
  const expectedWorkflows = [
    "claude.yml",
    "security-review.yml",
    "claudopilot-worker.yml",
  ];
  if (config.improve?.enabled) {
    expectedWorkflows.push("claudopilot-improve.yml");
  }
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

  // Check companion repo access
  const companions = config.project.repos.filter(r => r.role === "companion");
  if (companions.length > 0) {
    const ghPat = secrets.GITHUB_PAT;
    if (ghPat) {
      for (const companion of companions) {
        const remote = companion.remote ?? `${config.github.owner}/${companion.name}`;
        const spinner = ui.spinner(`Checking access to ${remote}...`);
        try {
          const res = await fetch(`https://api.github.com/repos/${remote}`, {
            headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" },
          });
          if (res.ok) {
            spinner.succeed(`  Companion repo: ${remote} accessible`);
            passed++;
          } else {
            spinner.fail(`  Companion repo: ${remote} — HTTP ${res.status}`);
            failed++;
          }
        } catch {
          spinner.fail(`  Companion repo: ${remote} — connection failed`);
          failed++;
        }
      }
    } else {
      ui.warn(`${companions.length} companion repo(s) configured but no GITHUB_PAT to verify access`);
      warned++;
    }
  }

  // Check assignee management
  if (config.assignees) {
    ui.success(`Assignee management: configured (blocked → ${config.assignees.blockedAssignee}${config.assignees.blockedAssigneeUserId ? `, user ${config.assignees.blockedAssigneeUserId}` : ""})`);
    passed++;
    if (config.assignees.reviewerUserId) {
      ui.success(`Reviewer: ${config.assignees.reviewerUserId}`);
      passed++;
    }
    if (config.assignees.unassignOnAutoStart) {
      ui.success("Unassign on auto-start: enabled");
      passed++;
    }
  } else {
    ui.warn("No assignee management configured (notifications won't be targeted)");
    warned++;
  }

  // Check automations
  if (config.automations?.enabled) {
    const boardCount = Object.keys(config.automations.boards).length;
    const ruleCount = config.automations.rules.length;
    ui.success(`Cross-board automations: ${boardCount} board(s), ${ruleCount} rule(s)`);
    passed++;

    // Verify board list IDs exist
    if (clickupKey) {
      for (const [name, listId] of Object.entries(config.automations.boards)) {
        const boardSpinner = ui.spinner(`Verifying board "${name}" (list ${listId})...`);
        try {
          const adapter = new ClickUpAdapter(clickupKey);
          await adapter.getListStatuses(listId);
          boardSpinner.succeed(`  Board "${name}": list ${listId} accessible`);
          passed++;
        } catch {
          boardSpinner.fail(`  Board "${name}": list ${listId} not accessible`);
          failed++;
        }
      }
    }

    // Check automations workflow exists
    if (config.automations.rules.some((r) => r.then.some((a) => "dispatch" in a))) {
      if (existsSync(join(workflowsDir, "claudopilot-automations.yml"))) {
        ui.success("GitHub Action: claudopilot-automations.yml");
        passed++;
      } else {
        ui.error("Missing workflow: claudopilot-automations.yml (automations dispatch rules configured)");
        failed++;
      }
    }
  }

  // Check auto-approve
  if (config.autoApprove?.enabled) {
    ui.success(`Auto-approve tag: "${config.autoApprove.tagName}"`);
    passed++;
  } else {
    ui.info("Auto-approve: not enabled (all tasks require manual approval)");
  }

  // Check deployment provider
  const deployment = config.deployment;
  if (!deployment) {
    if (config.project.type === "nextjs") {
      ui.success("Deployment: Vercel (auto-detected for Next.js, via GitHub Deployments API)");
      passed++;
    } else {
      ui.warn("No deployment provider configured (preview URLs disabled)");
      warned++;
    }
  } else if (deployment.provider === "none") {
    ui.success("Deployment: none (preview URLs disabled)");
    passed++;
  } else if (deployment.provider === "vercel") {
    ui.success("Deployment: Vercel (via GitHub Deployments API)");
    passed++;
  } else if (deployment.provider === "railway") {
    if (deployment.railwayProjectId) {
      const railwayToken = secrets.RAILWAY_API_TOKEN;
      if (railwayToken) {
        const spinner = ui.spinner("Testing Railway API connection...");
        try {
          const res = await fetch("https://backboard.railway.com/graphql/v2", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${railwayToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: "{ me { email } }" }),
          });
          if (res.ok) {
            const data = (await res.json()) as { data?: { me?: { email?: string } } };
            const email = data?.data?.me?.email;
            spinner.succeed(`  Railway API: connected${email ? ` (${email})` : ""}`);
            passed++;
          } else {
            spinner.fail(`  Railway API: HTTP ${res.status}`);
            failed++;
          }
        } catch {
          spinner.fail("  Railway API: connection failed");
          failed++;
        }
      } else {
        ui.warn("Railway configured with project ID but no RAILWAY_API_TOKEN in .claudopilot.env");
        warned++;
      }
    } else {
      ui.success("Deployment: Railway (via GitHub Deployments API only)");
      passed++;
    }
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

  // Check ClickUp webhook health
  if (config.cloudflare?.workerUrl && clickupKey && config.pm.workspaceId) {
    const whSpinner = ui.spinner("Checking ClickUp webhook health...");
    try {
      const adapter = new ClickUpAdapter(clickupKey);
      const webhooks = await adapter.getWebhooks(config.pm.workspaceId);
      const workerHost = new URL(config.cloudflare.workerUrl).hostname;
      const matching = webhooks.filter((w) =>
        w.endpoint.includes(workerHost)
      );

      if (matching.length === 0) {
        whSpinner.fail(
          "  ClickUp webhook: no webhook registered for worker URL — events won't reach GitHub Actions"
        );
        failed++;
      } else if (matching.length > 1) {
        whSpinner.warn(
          `  ClickUp webhook: ${matching.length} duplicate webhooks for worker (may cause double-triggers)`
        );
        warned++;
      } else {
        const wh = matching[0];
        if (wh.health.status === "suspended") {
          whSpinner.fail(
            `  ClickUp webhook: SUSPENDED (${wh.health.fail_count} failures) — re-register with 'claudopilot init'`
          );
          failed++;
        } else if (wh.health.status === "failing") {
          whSpinner.warn(
            `  ClickUp webhook: FAILING (${wh.health.fail_count} failures) — check worker secret matches`
          );
          warned++;
        } else {
          // Verify the secret in the webhook URL matches the config
          const configUrl = new URL(config.cloudflare.workerUrl);
          const whUrl = new URL(wh.endpoint);
          if (
            configUrl.searchParams.get("secret") !==
            whUrl.searchParams.get("secret")
          ) {
            whSpinner.warn(
              "  ClickUp webhook: active but secret mismatch with .claudopilot.yaml worker URL"
            );
            warned++;
          } else {
            whSpinner.succeed("  ClickUp webhook: active, secret matches");
            passed++;
          }
        }
      }
    } catch {
      whSpinner.fail("  ClickUp webhook: failed to query webhooks");
      failed++;
    }
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
