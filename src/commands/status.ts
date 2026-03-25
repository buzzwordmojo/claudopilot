import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { ui } from "../utils/ui.js";
import { loadConfig, getConfigPath } from "../utils/config.js";
import { loadSecrets, maskKey } from "../utils/secrets.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export async function status(): Promise<void> {
  ui.banner();

  // ── Version & Install ──────────────────────────────
  ui.header("Version & Install");

  console.log(`  ${chalk.bold("Version:")}       ${pkg.version}`);
  console.log(`  ${chalk.bold("Node:")}          ${process.version}`);
  console.log(`  ${chalk.bold("CLI path:")}      ${resolve(join(import.meta.dirname, ".."))}`);
  console.log(`  ${chalk.bold("Working dir:")}   ${process.cwd()}`);

  // ── Config ─────────────────────────────────────────
  ui.header("Configuration");

  const configPath = getConfigPath();
  const config = await loadConfig();

  if (!config) {
    ui.warn(`No config found at ${configPath}`);
    ui.info("Run 'claudopilot init' to set up this project.");
    ui.blank();
    return;
  }

  ui.success(`Config: ${configPath}`);
  console.log(`  ${chalk.bold("Config version:")} ${config.version ?? "unset"}`);

  // ── Project ────────────────────────────────────────
  ui.header("Project");

  console.log(`  ${chalk.bold("Name:")}          ${config.project.name}`);
  console.log(`  ${chalk.bold("Type:")}          ${config.project.type}`);
  console.log(`  ${chalk.bold("Root:")}          ${config.project.rootDir}`);

  if (config.project.repos.length > 0) {
    console.log(`  ${chalk.bold("Repos:")}`);
    for (const repo of config.project.repos) {
      const role = repo.role ? chalk.dim(` (${repo.role})`) : "";
      console.log(`    • ${repo.name} → ${repo.path}${role}`);
    }
  }

  // ── PM Tool ────────────────────────────────────────
  ui.header("PM Integration");

  console.log(`  ${chalk.bold("Tool:")}          ${config.pm.tool}`);
  console.log(`  ${chalk.bold("List ID:")}       ${config.pm.listId ?? chalk.dim("not set")}`);

  if (config.pm.sdlcListIds && config.pm.sdlcListIds.length > 0) {
    console.log(`  ${chalk.bold("SDLC boards:")}   ${config.pm.sdlcListIds.join(", ")}`);
  }

  const statusMap = config.pm.statuses;
  console.log(`  ${chalk.bold("Statuses:")}      idea=${statusMap.idea}, planning=${statusMap.planning}, redTeam=${statusMap.redTeam}`);
  console.log(`                 blocked=${statusMap.blocked}, awaiting=${statusMap.awaitingApproval}, approved=${statusMap.approved}`);
  console.log(`                 building=${statusMap.building}, inReview=${statusMap.inReview}, done=${statusMap.done}`);

  // ── GitHub ─────────────────────────────────────────
  ui.header("GitHub");

  console.log(`  ${chalk.bold("Owner:")}         ${config.github.owner}`);
  console.log(`  ${chalk.bold("Repos:")}         ${config.github.repos.join(", ")}`);
  console.log(`  ${chalk.bold("Git identity:")}  ${config.github.commitName} <${config.github.commitEmail}>`);

  // ── Secrets ────────────────────────────────────────
  ui.header("Secrets");

  const secrets = await loadSecrets();
  const secretChecks: [string, string | undefined][] = [
    ["ANTHROPIC_API_KEY", secrets.ANTHROPIC_API_KEY],
    ["CLICKUP_API_KEY", secrets.CLICKUP_API_KEY ?? config.pm.apiKey],
    ["GITHUB_PAT", secrets.GITHUB_PAT],
    ["CLOUDFLARE_API_TOKEN", secrets.CLOUDFLARE_API_TOKEN],
    ["RAILWAY_API_TOKEN", secrets.RAILWAY_API_TOKEN],
  ];

  for (const [name, value] of secretChecks) {
    if (value) {
      console.log(`  ${chalk.green("✓")} ${name.padEnd(24)} ${chalk.dim(maskKey(value))}`);
    } else {
      console.log(`  ${chalk.dim("·")} ${name.padEnd(24)} ${chalk.dim("not set")}`);
    }
  }

  // ── Features ───────────────────────────────────────
  ui.header("Features");

  // Cloudflare Worker
  if (config.cloudflare?.workerUrl) {
    ui.success(`Cloudflare Worker: ${config.cloudflare.workerName} → ${config.cloudflare.workerUrl}`);
  } else {
    ui.info("Cloudflare Worker: not configured");
  }

  // Red Team
  console.log(`  ${chalk.green("✓")} Red Team: ${config.redTeam.maxRounds} rounds, blocks on ${config.redTeam.blockingSeverity}+`);
  if (config.redTeam.domainLenses.length > 0) {
    console.log(`    Lenses: ${config.redTeam.domainLenses.map((l) => l.name).join(", ")}`);
  }

  // Deployment
  const dp = config.deployment;
  if (!dp) {
    if (config.project.type === "nextjs") {
      ui.success("Deployment: Vercel (auto-detected)");
    } else {
      ui.info("Deployment: not configured");
    }
  } else if (dp.provider === "none") {
    ui.info("Deployment: disabled");
  } else {
    ui.success(`Deployment: ${dp.provider}${dp.railwayProjectId ? ` (project ${dp.railwayProjectId})` : ""}`);
  }

  // Assignees
  if (config.assignees) {
    ui.success(`Assignees: blocked→${config.assignees.blockedAssignee}${config.assignees.reviewerUserId ? `, reviewer=${config.assignees.reviewerUserId}` : ""}${config.assignees.unassignOnAutoStart ? ", unassign-on-start" : ""}`);
  } else {
    ui.info("Assignees: not configured");
  }

  // Auto-approve
  if (config.autoApprove?.enabled) {
    ui.success(`Auto-approve: tag "${config.autoApprove.tagName}"`);
  } else {
    ui.info("Auto-approve: disabled");
  }

  // Improve
  if (config.improve?.enabled) {
    ui.success(`Improve: ${config.improve.lenses.join(", ")}${config.improve.schedule ? ` (${config.improve.schedule})` : ""}`);
  } else {
    ui.info("Improve: disabled");
  }

  // Competitors
  if (config.competitors?.enabled) {
    ui.success(`Competitors: ${config.competitors.searchTerms.length} search terms${config.competitors.schedule ? ` (${config.competitors.schedule})` : ""}`);
  } else {
    ui.info("Competitors: disabled");
  }

  // Dream
  if (config.dream?.enabled) {
    ui.success(`Dream: enabled${config.dream.schedule ? ` (${config.dream.schedule})` : ""}`);
  } else {
    ui.info("Dream: disabled");
  }

  // Automations
  if (config.automations?.enabled) {
    const boardCount = Object.keys(config.automations.boards).length;
    const ruleCount = config.automations.rules.length;
    ui.success(`Automations: ${boardCount} board(s), ${ruleCount} rule(s)${config.automations.dispatchGateTag ? `, gate tag "${config.automations.dispatchGateTag}"` : ""}`);
  } else {
    ui.info("Automations: disabled");
  }

  // ── Installed Files ────────────────────────────────
  ui.header("Installed Files");

  const cwd = process.cwd();
  const files: [string, string][] = [
    ["CLAUDE.md", join(cwd, "CLAUDE.md")],
    [".mcp.json", join(cwd, ".mcp.json")],
    ["MCP server", join(cwd, ".claude", "mcp-server", "index.js")],
    [".coderabbit.yaml", join(cwd, ".coderabbit.yaml")],
    ["plan-feature.md", join(cwd, ".claude", "commands", "plan-feature.md")],
    ["red-team.md", join(cwd, ".claude", "commands", "red-team.md")],
    ["implement.md", join(cwd, ".claude", "commands", "implement.md")],
    ["claude.yml", join(cwd, ".github", "workflows", "claude.yml")],
    ["security-review.yml", join(cwd, ".github", "workflows", "security-review.yml")],
    ["claudopilot-worker.yml", join(cwd, ".github", "workflows", "claudopilot-worker.yml")],
  ];

  if (config.improve?.enabled) {
    files.push(["improve.md", join(cwd, ".claude", "commands", "improve.md")]);
    files.push(["claudopilot-improve.yml", join(cwd, ".github", "workflows", "claudopilot-improve.yml")]);
  }

  if (config.automations?.enabled) {
    files.push(["claudopilot-automations.yml", join(cwd, ".github", "workflows", "claudopilot-automations.yml")]);
  }

  for (const [label, path] of files) {
    if (existsSync(path)) {
      console.log(`  ${chalk.green("✓")} ${label}`);
    } else {
      console.log(`  ${chalk.red("✗")} ${label} ${chalk.dim("(missing)")}`);
    }
  }

  ui.blank();
}
