import { confirm, input, select, password } from "@inquirer/prompts";
import { ui } from "../utils/ui.js";
import { loadConfig, saveConfig } from "../utils/config.js";
import { loadSecrets, saveSecrets, maskKey } from "../utils/secrets.js";
import { detectProjectType } from "../utils/detect.js";
import { ClickUpAdapter } from "../adapters/clickup.js";
import { update } from "./update.js";
import {
  setupClickUp,
  setupGitHub,
  setupCloudflare,
  setupRedTeam,
  setupDeployment,
  setupImprove,
  setupCompetitors,
  setupDream,
  setupAutomations,
  setupAssignees,
  setupAutoApprove,
  customizeStatuses,
} from "./init.js";
import type { ClaudopilotConfig } from "../types.js";
import { DEFAULT_STATUSES } from "../types.js";

function requireConfig(config: ClaudopilotConfig | null): asserts config is ClaudopilotConfig {
  if (!config) {
    ui.error("No .claudopilot.yaml found. Run 'claudopilot init' first.");
    process.exit(1);
  }
}

async function saveAndUpdate(config: ClaudopilotConfig): Promise<void> {
  await saveConfig(config);
  ui.success("Config saved to .claudopilot.yaml");

  const regen = await confirm({
    message: "Regenerate project files now?",
    default: true,
  });
  if (regen) {
    await update({ includeWorker: false });
  }
}

// ─── config project ───

export async function configProject(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);

  ui.header("Project Settings");

  const detection = await detectProjectType();
  const projectName = await input({
    message: "Project name:",
    default: config.project.name,
  });

  const projectType = await select({
    message: `Detected ${detection.type}. Correct?`,
    choices: [
      { name: `Yes, ${detection.type}`, value: detection.type },
      { name: "Next.js", value: "nextjs" as const },
      { name: "NestJS", value: "nestjs" as const },
      { name: "FastAPI", value: "fastapi" as const },
      { name: "Rails", value: "rails" as const },
      { name: "Other / Generic", value: "generic" as const },
    ],
    default: config.project.type ?? detection.type,
  });

  config.project.name = projectName;
  config.project.type = projectType;

  await saveAndUpdate(config);
}

// ─── config pm ───

export async function configPm(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);
  const secrets = await loadSecrets();

  ui.header("PM Tool (ClickUp)");

  const pmConfig = await setupClickUp(secrets.CLICKUP_API_KEY, config.pm);

  // Configure statuses
  const useDefaults = await confirm({
    message: "Use default statuses?",
    default: true,
  });

  let statuses = config.pm.statuses ?? DEFAULT_STATUSES;
  if (!useDefaults) {
    statuses = await customizeStatuses(config.pm.statuses);
  }

  const statusSpinner = ui.spinner("Updating ClickUp list statuses...");
  try {
    const adapter = new ClickUpAdapter(pmConfig.apiKey!);
    await adapter.configureStatuses(pmConfig.listId!, statuses);
    statusSpinner.succeed("  ClickUp statuses configured");
  } catch (error) {
    statusSpinner.fail("  Failed to configure statuses");
    ui.warn(`You may need to set statuses manually. Error: ${error}`);
  }

  config.pm = { tool: pmConfig.tool, workspaceId: pmConfig.workspaceId, spaceId: pmConfig.spaceId, listId: pmConfig.listId, statuses };
  await saveSecrets({ CLICKUP_API_KEY: pmConfig.apiKey });
  await saveAndUpdate(config);
}

// ─── config github ───

export async function configGithub(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);
  const secrets = await loadSecrets();

  ui.header("GitHub Settings");

  const githubConfig = await setupGitHub(secrets.GITHUB_PAT, config.github);

  config.github = {
    owner: githubConfig.owner,
    repos: githubConfig.repos,
    anthropicKeySecretName: githubConfig.anthropicKeySecretName,
    commitName: githubConfig.commitName,
    commitEmail: githubConfig.commitEmail,
  };

  await saveSecrets({ GITHUB_PAT: githubConfig.pat });
  await saveAndUpdate(config);
}

// ─── config cloudflare ───

export async function configCloudflare(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);
  const secrets = await loadSecrets();

  ui.header("Cloudflare Worker");

  const cfConfig = await setupCloudflare(
    secrets.CLOUDFLARE_API_TOKEN,
    secrets.CLOUDFLARE_ACCOUNT_ID,
    config.cloudflare
  );

  config.cloudflare = { workerName: cfConfig.workerName };

  await saveSecrets({
    CLOUDFLARE_API_TOKEN: cfConfig.apiToken,
    CLOUDFLARE_ACCOUNT_ID: cfConfig.accountId,
  });
  await saveAndUpdate(config);
}

// ─── config redteam ───

export async function configRedteam(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);
  const secrets = await loadSecrets();

  ui.header("Red Team Agent");

  const anthropicKey = secrets.ANTHROPIC_API_KEY;
  const clickupKey = secrets.CLICKUP_API_KEY;
  const workspaceId = config.pm.workspaceId;

  if (!anthropicKey || !clickupKey || !workspaceId) {
    ui.error("Missing Anthropic API key, ClickUp key, or workspace ID. Run 'claudopilot init' first.");
    process.exit(1);
  }

  config.redTeam = await setupRedTeam(anthropicKey, clickupKey, workspaceId, config.redTeam);
  await saveAndUpdate(config);
}

// ─── config improve ───

export async function configImprove(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);

  ui.header("Improvement Engine");

  config.improve = await setupImprove(config.improve);
  await saveAndUpdate(config);
}

// ─── config competitors ───

export async function configCompetitors(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);

  ui.header("Competitor Tracking");

  config.competitors = await setupCompetitors(config.competitors);
  await saveAndUpdate(config);
}

// ─── config dream ───

export async function configDream(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);

  ui.header("Dream Engine");

  config.dream = await setupDream(config.dream);
  await saveAndUpdate(config);
}

// ─── config assignees ───

export async function configAssignees(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);
  const secrets = await loadSecrets();

  ui.header("Assignee Management");

  const clickupKey = secrets.CLICKUP_API_KEY;
  const workspaceId = config.pm.workspaceId;

  if (!clickupKey || !workspaceId) {
    ui.error("Missing ClickUp key or workspace ID. Run 'claudopilot init' first.");
    process.exit(1);
  }

  config.assignees = await setupAssignees(clickupKey, workspaceId, config.assignees);
  await saveAndUpdate(config);
}

// ─── config auto-approve ───

export async function configAutoApprove(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);

  ui.header("Auto-Approve Tag");

  config.autoApprove = await setupAutoApprove(config.autoApprove);
  await saveAndUpdate(config);
}

// ─── config automations ───

export async function configAutomations(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);
  const secrets = await loadSecrets();

  ui.header("Cross-Board Automations");

  const clickupKey = secrets.CLICKUP_API_KEY;
  const spaceId = config.pm.spaceId;
  const workspaceId = config.pm.workspaceId;

  if (!clickupKey || !spaceId || !workspaceId) {
    ui.error("Missing ClickUp key, space ID, or workspace ID. Run 'claudopilot init' first.");
    process.exit(1);
  }

  config.automations = await setupAutomations(clickupKey, spaceId, workspaceId, config.automations);
  await saveAndUpdate(config);
}

// ─── config deployment ───

export async function configDeployment(): Promise<void> {
  ui.banner();
  const config = await loadConfig();
  requireConfig(config);

  ui.header("Preview Deployments");

  const deploymentResult = await setupDeployment(config.project.type, config.deployment);

  config.deployment = deploymentResult
    ? {
        provider: deploymentResult.provider,
        railwayProjectId: deploymentResult.railwayProjectId,
        railwayServiceId: deploymentResult.railwayServiceId,
        pollTimeout: deploymentResult.pollTimeout,
        pollInterval: deploymentResult.pollInterval,
      }
    : undefined;

  if (deploymentResult?.provider === "railway" && deploymentResult.railwayApiToken) {
    await saveSecrets({ RAILWAY_API_TOKEN: deploymentResult.railwayApiToken });
  }

  await saveAndUpdate(config);
}
