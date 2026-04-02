import { confirm, input, select, password, checkbox } from "@inquirer/prompts";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { ui } from "../utils/ui.js";
import { loadConfig, saveConfig, configExists } from "../utils/config.js";
import { detectProjectType, detectGitHubRemote } from "../utils/detect.js";
import { ClickUpAdapter } from "../adapters/clickup.js";
import {
  installClaudeCommands,
  installClaudeMd,
} from "../installers/claude-commands.js";
import { installGitHubActions } from "../installers/github-actions.js";
import { deployCloudflareWorker } from "../installers/cloudflare-worker.js";
import { installCodeRabbitConfig } from "../installers/coderabbit.js";
import { installMcpServer } from "../installers/mcp-server.js";
import type {
  ClaudopilotConfig,
  CompetitorsConfig,
  DreamConfig,
  DeploymentConfig,
  DeploymentProvider,
  DomainLens,
  PMConfig,
  GitHubConfig,
  CloudflareConfig,
  RedTeamConfig,
  ImproveConfig,
  FeedbackConfig,
  AssigneeConfig,
  AutoApproveConfig,
  RepoConfig,
  StatusConfig,
  Severity,
  AutomationsConfig,
  AutomationRule,
  AutomationAction,
  VisualVerificationConfig,
} from "../types.js";
import { DEFAULT_STATUSES, DEFAULT_IMPROVE_LENSES } from "../types.js";
import { suggestDomainLenses } from "../utils/analyze.js";
import { loadSecrets, saveSecrets, maskKey } from "../utils/secrets.js";

interface InitOptions {
  pm: string;
  skipCloud?: boolean;
  force?: boolean;
}

export async function init(options: InitOptions): Promise<void> {
  ui.banner();

  // Load saved state
  const secrets = await loadSecrets();
  const existing = await loadConfig();
  const hasState = Object.values(secrets).some(Boolean) || existing !== null;

  if (hasState) {
    ui.info("Found existing configuration — saved values will be used as defaults.");
  }

  // Check for existing config
  if (configExists() && !options.force) {
    const overwrite = await confirm({
      message:
        "claudopilot is already initialized. Re-configure?",
      default: true,
    });
    if (!overwrite) {
      ui.info("No changes made.");
      return;
    }
  }

  // ─── Pre-flight checklist (skip if we have saved secrets) ───
  if (!hasState) {
    ui.checklist("Before we start, you'll need:", [
      {
        label: "ClickUp API token",
        detail:
          "ClickUp → Settings (bottom-left) → Apps → Generate API Token",
      },
      {
        label: "GitHub Personal Access Token",
        detail:
          'github.com → Settings → Developer settings → Fine-grained tokens → "Contents", "Actions", "Secrets", and "Environments" repo permissions',
      },
      ...(options.skipCloud
        ? []
        : [
            {
              label: "Cloudflare API token (optional)",
              detail:
                "dash.cloudflare.com → My Profile → API Tokens → Create Token → \"Edit Workers\" template",
            },
            {
              label: "Cloudflare account ID (optional)",
              detail:
                "dash.cloudflare.com → any domain or Workers page → right sidebar under \"Account ID\"",
            },
          ]),
      {
        label: "Anthropic API key",
        detail:
          "console.anthropic.com → API Keys → Create Key — used to analyze your codebase + added as a GitHub repo secret",
      },
    ]);

    const ready = await confirm({
      message: "Ready to continue?",
      default: true,
    });
    if (!ready) {
      ui.info("Take your time. Run claudopilot init again when ready.");
      return;
    }
  }

  const totalSteps = options.skipCloud ? 16 : 18;
  let step = 0;

  // ─── Step 1: Detect project ───
  step++;
  ui.step(step, totalSteps, "Detecting project type...");

  const detection = await detectProjectType();
  const projectName = await input({
    message: "Project name:",
    default: existing?.project?.name ?? process.cwd().split("/").pop() ?? "my-project",
  });

  const projectType = await select({
    message: `Detected ${detection.type} (${detection.indicators.join(", ") || "no indicators"}). Correct?`,
    choices: [
      { name: `Yes, ${detection.type}`, value: detection.type },
      { name: "Next.js", value: "nextjs" as const },
      { name: "NestJS", value: "nestjs" as const },
      { name: "FastAPI", value: "fastapi" as const },
      { name: "Rails", value: "rails" as const },
      { name: "Other / Generic", value: "generic" as const },
    ],
    default: existing?.project?.type ?? detection.type,
  });

  ui.success(`Project: ${projectName} (${projectType})`);

  // ─── Anthropic API key (used for analysis + GitHub Actions) ───
  let anthropicKey: string;
  if (secrets.ANTHROPIC_API_KEY) {
    ui.success(`Anthropic API key found (${maskKey(secrets.ANTHROPIC_API_KEY)})`);
    anthropicKey = secrets.ANTHROPIC_API_KEY;
  } else {
    ui.hint([
      "Your Anthropic API key is used to:",
      "1. Analyze your codebase and suggest red team lenses (right now)",
      "2. Power Claude in GitHub Actions (you'll add it as a repo secret later)",
      "",
      "Get one at: console.anthropic.com → API Keys → Create Key",
    ]);
    anthropicKey = await password({
      message: "Anthropic API key:",
    });
  }

  // ─── Step 2: Connect PM tool ───
  step++;
  ui.step(step, totalSteps, "Connecting to ClickUp...");

  const pmConfig = await setupClickUp(secrets.CLICKUP_API_KEY, existing?.pm);

  // ─── Step 3: Configure statuses ───
  step++;
  ui.step(step, totalSteps, "Configuring task statuses...");

  const existingStatuses = existing?.pm?.statuses;
  const useDefaults = await confirm({
    message:
      "Use default statuses (idea → planning → blocked → awaiting approval → approved → building → in review → done)?",
    default: true,
  });

  let statuses: StatusConfig = existingStatuses ?? DEFAULT_STATUSES;
  if (!useDefaults) {
    statuses = await customizeStatuses(existingStatuses);
  }

  const statusSpinner = ui.spinner("Updating ClickUp list statuses...");
  try {
    const adapter = new ClickUpAdapter(pmConfig.apiKey!);
    await adapter.configureStatuses(pmConfig.listId!, statuses);
    statusSpinner.succeed("  ClickUp statuses configured");
  } catch (error) {
    statusSpinner.fail("  Failed to configure statuses");
    ui.warn(
      `You may need to set statuses manually in ClickUp. Error: ${error}`
    );
  }

  // ─── Step 4: GitHub setup ───
  step++;
  ui.step(step, totalSteps, "Configuring GitHub...");

  const githubConfig = await setupGitHub(secrets.GITHUB_PAT, existing?.github);

  // ─── Step 5: Red team configuration ───
  step++;
  ui.step(step, totalSteps, "Configuring red team agent...");

  const redTeamConfig = await setupRedTeam(anthropicKey, pmConfig.apiKey!, pmConfig.workspaceId!, existing?.redTeam);

  // ─── Cross-Board Automations (before Worker so rules can be embedded) ───
  step++;
  ui.step(step, totalSteps, "Cross-board automations...");

  const automationsConfig = await setupAutomations(pmConfig.apiKey!, pmConfig.spaceId!, pmConfig.workspaceId!, existing?.automations);

  // ─── PR Feedback Cycle ───
  step++;
  ui.step(step, totalSteps, "PR feedback cycle...");

  const feedbackConfig = await setupFeedback(existing?.feedback);

  // ─── Deploy Cloudflare Worker ───
  let cloudflareConfig: CloudflareConfig | undefined;
  let workerUrl: string | undefined;

  if (!options.skipCloud) {
    step++;
    ui.step(step, totalSteps, "Deploying webhook bridge...");

    const setupCf = await confirm({
      message:
        "Deploy a Cloudflare Worker to bridge ClickUp webhooks → GitHub Actions?\n" +
        "  (Each project needs its own worker, but you can reuse the same Cloudflare account)",
      default: existing?.cloudflare !== undefined || true,
    });

    if (setupCf) {
      cloudflareConfig = await setupCloudflare(
        secrets.CLOUDFLARE_API_TOKEN,
        secrets.CLOUDFLARE_ACCOUNT_ID,
        existing?.cloudflare,
        projectName
      );

      ui.info("Reusing your GitHub PAT from step 4 for webhook dispatch.");

      try {
        workerUrl = await deployCloudflareWorker(
          cloudflareConfig,
          githubConfig,
          githubConfig.pat,
          pmConfig.apiKey!,
          automationsConfig,
          pmConfig.sdlcListIds ?? (pmConfig.listId ? [pmConfig.listId] : []),
          {
            clickupApiKey: pmConfig.apiKey!,
            workspaceId: pmConfig.workspaceId!,
            automationsConfig,
          }
        );

        // ─── Create GitHub webhook for PR feedback ───
        if (workerUrl && feedbackConfig?.enabled) {
          step++;
          ui.step(step, totalSteps, "Creating GitHub webhook for PR feedback...");

          const repoSlug = `${githubConfig.owner}/${githubConfig.repos[0]}`;
          const webhookSecret = cloudflareConfig.apiToken; // reuse as shared secret
          const ghWebhookUrl = `${workerUrl}?secret=${webhookSecret}`;
          const { execSync } = await import("node:child_process");

          const ghWebhookSpinner = ui.spinner(`Checking existing GitHub webhooks on ${repoSlug}...`);
          try {
            // Check if a webhook already exists for this Worker URL
            const existingHooksRaw = execSync(
              `gh api repos/${repoSlug}/hooks`,
              {
                env: { ...process.env, GH_TOKEN: githubConfig.pat },
                stdio: ["pipe", "pipe", "pipe"],
              }
            ).toString();
            const existingHooks = JSON.parse(existingHooksRaw) as { id: number; config: { url?: string } }[];
            const alreadyExists = existingHooks.some(
              (h) => h.config?.url && h.config.url.startsWith(workerUrl!)
            );

            if (alreadyExists) {
              ghWebhookSpinner.succeed(`  GitHub webhook already exists for ${workerUrl}`);
            } else {
              ghWebhookSpinner.succeed("  No existing webhook found — creating...");
              const createSpinner = ui.spinner(`Creating GitHub webhook on ${repoSlug}...`);
              try {
                execSync(
                  `gh api repos/${repoSlug}/hooks -X POST ` +
                  `-f name=web ` +
                  `-f 'config[url]=${ghWebhookUrl}' ` +
                  `-f config[content_type]=json ` +
                  `-f[] events=pull_request_review ` +
                  `-f[] events=check_run ` +
                  `-f[] events=issue_comment ` +
                  `-f[] events=pull_request ` +
                  `-f active=true`,
                  {
                    env: { ...process.env, GH_TOKEN: githubConfig.pat },
                    stdio: ["pipe", "pipe", "pipe"],
                  }
                );
                createSpinner.succeed(`  GitHub webhook created on ${repoSlug} → ${workerUrl}`);
              } catch (whError: any) {
                const stderr = whError?.stderr?.toString?.() || whError?.message || String(whError);
                createSpinner.fail(`  Could not create GitHub webhook: ${stderr.trim()}`);
                ui.warn("You can create the webhook manually in GitHub repo settings → Webhooks.");
              }
            }
          } catch (listError: any) {
            const stderr = listError?.stderr?.toString?.() || listError?.message || String(listError);
            ghWebhookSpinner.fail(`  Could not list GitHub webhooks: ${stderr.trim()}`);
            ui.warn("You can create the webhook manually in GitHub repo settings → Webhooks.");
          }
        }
      } catch (error) {
        ui.error(`Cloudflare deployment failed: ${error}`);
        ui.warn("You can set this up later with: claudopilot init --skip-cloud=false");
      }
    }
  }

  // ─── Assignee management ───
  step++;
  ui.step(step, totalSteps, "Configuring assignee management...");

  const assigneesConfig = await setupAssignees(pmConfig.apiKey!, pmConfig.workspaceId!, existing?.assignees);

  // ─── Auto-approve tag ───
  step++;
  ui.step(step, totalSteps, "Configuring auto-approve...");

  const autoApproveConfig = await setupAutoApprove(existing?.autoApprove);

  // ─── Companion repos ───
  step++;
  ui.step(step, totalSteps, "Multi-repo setup...");

  const primaryRepo: RepoConfig = {
    name: projectName,
    path: ".",
    type: projectType,
    remote: githubConfig.repos[0]
      ? `${githubConfig.owner}/${githubConfig.repos[0]}`
      : undefined,
    role: "primary",
  };

  const allRepos: RepoConfig[] = [primaryRepo];
  const allGithubRepos: string[] = [...githubConfig.repos];

  // Check for existing companions
  const existingCompanions = existing?.project?.repos?.filter(r => r.role === "companion") ?? [];

  const multiRepo = await confirm({
    message: "Does this project span multiple repositories?",
    default: existingCompanions.length > 0,
  });

  if (multiRepo) {
    const availableRepos = githubConfig.fetchedRepos
      .filter(r => r.name !== githubConfig.repos[0]);

    if (availableRepos.length > 0) {
      // Pre-select existing companions
      const existingCompanionNames = existingCompanions.map(c => {
        const remote = c.remote ?? "";
        return remote.includes("/") ? remote.split("/").pop()! : c.name;
      });

      const companionNames = await checkbox({
        message: "Select companion repositories:",
        choices: availableRepos.map(r => ({
          name: r.name,
          value: r.name,
          checked: existingCompanionNames.includes(r.name),
        })),
      });

      for (const name of companionNames) {
        const existingCompanion = existingCompanions.find(c =>
          c.remote === `${githubConfig.owner}/${name}` || c.name === name
        );

        const compType = await select({
          message: `Type for ${name}:`,
          choices: [
            { name: "Next.js", value: "nextjs" as const },
            { name: "NestJS", value: "nestjs" as const },
            { name: "FastAPI", value: "fastapi" as const },
            { name: "Rails", value: "rails" as const },
            { name: "Other / Generic", value: "generic" as const },
          ],
          default: existingCompanion?.type ?? "generic",
        });

        const compDescription = await input({
          message: `Description for ${name} (e.g., "FastAPI backend — REST API + database"):`,
          default: existingCompanion?.description ?? "",
        });

        allRepos.push({
          name,
          path: `./${name}`,
          type: compType,
          remote: `${githubConfig.owner}/${name}`,
          role: "companion",
          description: compDescription || undefined,
        });
        allGithubRepos.push(name);
      }

      if (companionNames.length > 0) {
        ui.success(`${companionNames.length} companion repo(s) added`);
      }
    } else {
      ui.warn("No other repos found — enter companion repo names manually");
      let addMore = true;
      while (addMore) {
        const name = await input({ message: "Companion repo name:" });
        const compType = await select({
          message: `Type for ${name}:`,
          choices: [
            { name: "Next.js", value: "nextjs" as const },
            { name: "NestJS", value: "nestjs" as const },
            { name: "FastAPI", value: "fastapi" as const },
            { name: "Rails", value: "rails" as const },
            { name: "Other / Generic", value: "generic" as const },
          ],
        });
        const compDescription = await input({
          message: `Description for ${name}:`,
        });

        allRepos.push({
          name,
          path: `./${name}`,
          type: compType,
          remote: `${githubConfig.owner}/${name}`,
          role: "companion",
          description: compDescription || undefined,
        });
        allGithubRepos.push(name);

        addMore = await confirm({ message: "Add another companion?", default: false });
      }
    }
  }

  // ─── Improvement Engine ───
  step++;
  ui.step(step, totalSteps, "Improvement engine...");

  const improveConfig = await setupImprove(existing?.improve);

  // ─── Competitor Tracking ───
  step++;
  ui.step(step, totalSteps, "Competitor tracking...");

  const competitorsConfig = await setupCompetitors(existing?.competitors);

  // ─── Dream Engine ───
  step++;
  ui.step(step, totalSteps, "Dream engine...");

  const dreamConfig = await setupDream(existing?.dream);

  // ─── Deployment / Preview URLs ───
  step++;
  ui.step(step, totalSteps, "Preview deployments...");

  const deploymentConfig = await setupDeployment(projectType, existing?.deployment);

  const visualVerificationConfig = await setupVisualVerification(
    !!deploymentConfig && deploymentConfig.provider !== "none",
    existing?.visualVerification,
  );

  // ─── Install files ───
  step++;
  ui.step(step, totalSteps, "Installing project files...");

  const config: ClaudopilotConfig = {
    version: "0.1.0",
    project: {
      name: projectName,
      type: projectType,
      rootDir: process.cwd(),
      repos: allRepos,
    },
    pm: { tool: pmConfig.tool, workspaceId: pmConfig.workspaceId, spaceId: pmConfig.spaceId, listId: pmConfig.listId, statuses },
    github: { owner: githubConfig.owner, repos: allGithubRepos, anthropicKeySecretName: githubConfig.anthropicKeySecretName, commitName: githubConfig.commitName, commitEmail: githubConfig.commitEmail },
    cloudflare: cloudflareConfig
      ? { workerName: cloudflareConfig.workerName, workerUrl }
      : undefined,
    redTeam: redTeamConfig,
    improve: improveConfig,
    competitors: competitorsConfig,
    dream: dreamConfig,
    feedback: feedbackConfig,
    deployment: deploymentConfig,
    visualVerification: visualVerificationConfig,
    assignees: assigneesConfig,
    autoApprove: autoApproveConfig,
    automations: automationsConfig,
  };

  await saveConfig(config);
  ui.success("Config saved to .claudopilot.yaml");

  // Save secrets for future runs
  await saveSecrets({
    ANTHROPIC_API_KEY: anthropicKey,
    CLICKUP_API_KEY: pmConfig.apiKey,
    GITHUB_PAT: githubConfig.pat,
    ...(cloudflareConfig
      ? {
          CLOUDFLARE_API_TOKEN: cloudflareConfig.apiToken,
          CLOUDFLARE_ACCOUNT_ID: cloudflareConfig.accountId,
        }
      : {}),
    ...(deploymentConfig?.provider === "railway" && deploymentConfig.railwayApiToken
      ? { RAILWAY_API_TOKEN: deploymentConfig.railwayApiToken }
      : {}),
  });
  ui.success("Secrets saved to .claudopilot.env");

  // Ensure .claudopilot.env and .mcp.json are gitignored
  await ensureGitignored(".claudopilot.env");
  await ensureGitignored(".mcp.json");

  await installClaudeMd(config);
  await installClaudeCommands(config);
  await installGitHubActions(config);
  await installCodeRabbitConfig();
  await installMcpServer(config);

  // ─── Step 8: Set GitHub repo secrets ───
  step++;
  ui.step(step, totalSteps, "Setting GitHub secrets...");

  // ─── Set GitHub repo secret ───
  const setSecret = await confirm({
    message: `Set ${config.github.anthropicKeySecretName} as a GitHub Actions secret on ${githubConfig.owner}/${githubConfig.repos[0]}?`,
    default: true,
  });

  if (setSecret) {
    const repoSlug = `${githubConfig.owner}/${githubConfig.repos[0]}`;
    const { execSync } = await import("node:child_process");

    // Set Anthropic API key
    const anthropicSpinner = ui.spinner(`Setting ANTHROPIC_API_KEY on ${repoSlug}...`);
    try {
      execSync(
        `gh secret set ANTHROPIC_API_KEY --repo ${repoSlug}`,
        {
          input: anthropicKey,
          env: { ...process.env, GH_TOKEN: githubConfig.pat },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      anthropicSpinner.succeed(`  ANTHROPIC_API_KEY set on ${repoSlug}`);
    } catch (error: any) {
      const stderr = error?.stderr?.toString?.() || error?.message || String(error);
      anthropicSpinner.fail(`  Could not set ANTHROPIC_API_KEY: ${stderr.trim()}`);
    }

    // Set GitHub PAT (used by workflows for checkout and gh CLI)
    const ghPatSpinner = ui.spinner(`Setting GH_PAT on ${repoSlug}...`);
    try {
      execSync(
        `gh secret set GH_PAT --repo ${repoSlug}`,
        {
          input: githubConfig.pat,
          env: { ...process.env, GH_TOKEN: githubConfig.pat },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      ghPatSpinner.succeed(`  GH_PAT set on ${repoSlug}`);
    } catch (error: any) {
      const stderr = error?.stderr?.toString?.() || error?.message || String(error);
      ghPatSpinner.fail(`  Could not set GH_PAT: ${stderr.trim()}`);
    }

    // Set ClickUp API key (used by workflow to post comments on tasks)
    const clickupSpinner = ui.spinner(`Setting CLICKUP_API_KEY on ${repoSlug}...`);
    try {
      execSync(
        `gh secret set CLICKUP_API_KEY --repo ${repoSlug}`,
        {
          input: pmConfig.apiKey,
          env: { ...process.env, GH_TOKEN: githubConfig.pat },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      clickupSpinner.succeed(`  CLICKUP_API_KEY set on ${repoSlug}`);
    } catch (error: any) {
      const stderr = error?.stderr?.toString?.() || error?.message || String(error);
      clickupSpinner.fail(`  Could not set CLICKUP_API_KEY: ${stderr.trim()}`);
    }

    // Set Railway API token if configured
    if (deploymentConfig?.provider === "railway" && deploymentConfig.railwayApiToken) {
      const railwaySpinner = ui.spinner(`Setting RAILWAY_API_TOKEN on ${repoSlug}...`);
      try {
        execSync(
          `gh secret set RAILWAY_API_TOKEN --repo ${repoSlug}`,
          {
            input: deploymentConfig.railwayApiToken,
            env: { ...process.env, GH_TOKEN: githubConfig.pat },
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        railwaySpinner.succeed(`  RAILWAY_API_TOKEN set on ${repoSlug}`);
      } catch (error: any) {
        const stderr = error?.stderr?.toString?.() || error?.message || String(error);
        railwaySpinner.fail(`  Could not set RAILWAY_API_TOKEN: ${stderr.trim()}`);
      }
    }

    // Create improve-continue environment for approval gates
    if (config.improve?.enabled) {
      const envSpinner = ui.spinner(`Creating improve-continue environment on ${repoSlug}...`);
      try {
        execSync(
          `gh api repos/${repoSlug}/environments/improve-continue --method PUT`,
          {
            env: { ...process.env, GH_TOKEN: githubConfig.pat },
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        envSpinner.succeed(`  improve-continue environment created on ${repoSlug}`);
        ui.hint([
          "To enable approval gates: go to GitHub repo → Settings → Environments →",
          "improve-continue → add yourself as a required reviewer.",
        ]);
      } catch (error: any) {
        const stderr = error?.stderr?.toString?.() || error?.message || String(error);
        envSpinner.fail(`  Could not create environment: ${stderr.trim()}`);
        ui.warn("You can create the 'improve-continue' environment manually in GitHub repo settings.");
        ui.hint(["This usually means your GitHub PAT is missing the 'Environments: Read and write' permission."]);
      }
    }
  }

  // ─── Post-init: remaining manual steps ───
  ui.header("Almost done!");

  ui.info("MCP server installed — Claude Code will auto-discover ClickUp tools from .mcp.json.");

  ui.info("Verify everything is connected:");
  ui.blank();
  console.log("    claudopilot doctor");

  ui.done();
}

// ─── PM Setup ───

export async function setupClickUp(savedKey?: string, existing?: PMConfig): Promise<PMConfig> {
  let apiKey: string;
  if (savedKey) {
    ui.success(`ClickUp API key found (${maskKey(savedKey)})`);
    apiKey = savedKey;
  } else {
    ui.hint([
      "To get your ClickUp API token:",
      "1. Open ClickUp and click your avatar (bottom-left)",
      "2. Go to Settings → Apps",
      '3. Under "API Token", click Generate (or copy existing)',
      "",
      "Docs: https://clickup.com/api/developer-tools/authentication",
    ]);
    apiKey = await password({
      message: "ClickUp API token:",
    });
  }

  const adapter = new ClickUpAdapter(apiKey);

  const spinner = ui.spinner("Validating credentials...");
  const valid = await adapter.validateCredentials();
  if (!valid) {
    spinner.fail("  Invalid ClickUp API key");
    throw new Error(
      "Could not validate ClickUp credentials. Check your API key."
    );
  }
  spinner.succeed("  ClickUp credentials valid");

  const workspaces = await adapter.getWorkspaces();
  const workspaceId = await select({
    message: "Select workspace:",
    choices: workspaces.map((w) => ({
      name: w.name,
      value: w.id,
    })),
    default: existing?.workspaceId,
  });

  const spaces = await adapter.getSpaces(workspaceId);
  const spaceId = await select({
    message: "Select space:",
    choices: spaces.map((s) => ({
      name: s.name,
      value: s.id,
    })),
    default: existing?.spaceId,
  });

  const lists = await adapter.getLists(spaceId);
  const listChoices = [
    { name: "+ Create new list", value: "__new__" },
    ...lists.map((l) => ({ name: l.name, value: l.id })),
  ];

  const listChoice = await select({
    message: "Select list (or create new):",
    choices: listChoices,
    default: existing?.listId,
  });

  let listId = listChoice;
  if (listChoice === "__new__") {
    const listName = await input({
      message: "New list name:",
      default: "Claudopilot",
    });
    const listSpinner = ui.spinner(`Creating list "${listName}" in ClickUp...`);
    try {
      const newList = await adapter.createList(spaceId, listName);
      listId = newList.id;
      listSpinner.succeed(`  List "${listName}" created`);
    } catch (error) {
      listSpinner.fail(`  Failed to create list: ${error}`);
      throw error;
    }
  }

  return {
    tool: "clickup",
    apiKey,
    workspaceId,
    spaceId,
    listId,
    statuses: existing?.statuses ?? DEFAULT_STATUSES,
  };
}

// ─── GitHub Setup ───

export async function setupGitHub(savedPat?: string, existing?: GitHubConfig): Promise<GitHubConfig & { pat: string; fetchedRepos: { name: string; full_name: string }[] }> {
  const detected = await detectGitHubRemote();

  let pat: string;
  if (savedPat) {
    ui.success(`GitHub PAT found (${maskKey(savedPat)})`);
    pat = savedPat;
  } else {
    ui.hint([
      "We need a GitHub Personal Access Token to list your repos",
      "and (optionally) to dispatch Actions from the webhook bridge.",
      "",
      "To create a fine-grained token:",
      "1. github.com → Settings → Developer settings → Personal access tokens",
      "2. Fine-grained tokens → Generate new token",
      '3. Name it (e.g., "claudopilot"), set an expiration',
      "4. Under Repository access, select the repos you want to use",
      "5. Under Permissions → Repository permissions, enable:",
      "   • Contents: Read and write",
      "   • Actions: Read and write",
      "   • Secrets: Read and write (to set ANTHROPIC_API_KEY)",
      "   • Environments: Read and write (to create approval gates)",
      "   • Metadata: Read-only (auto-selected)",
      '6. Click "Generate token" and copy it',
      "",
      "Docs: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    ]);
    pat = await password({
      message: "GitHub Personal Access Token:",
    });
  }

  // Detect owner from git remote, or use existing, or ask
  const defaultOwner = existing?.owner ?? detected?.owner;
  let owner: string;
  if (defaultOwner) {
    const useDefault = await confirm({
      message: `Use GitHub owner "${defaultOwner}"?`,
      default: true,
    });
    owner = useDefault
      ? defaultOwner
      : await input({ message: "GitHub owner/org:" });
  } else {
    owner = await input({ message: "GitHub owner/org:" });
  }

  // Fetch repos from GitHub API
  const spinner = ui.spinner(`Fetching repos for ${owner}...`);
  let repos: { name: string; full_name: string }[] = [];
  try {
    // Try as org first, fall back to user
    let res = await fetch(
      `https://api.github.com/orgs/${owner}/repos?per_page=100&sort=updated`,
      { headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) {
      res = await fetch(
        `https://api.github.com/users/${owner}/repos?per_page=100&sort=updated`,
        { headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" } }
      );
    }
    if (res.ok) {
      const data = (await res.json()) as { name: string; full_name: string }[];
      repos = data;
    }
    spinner.succeed(`  Found ${repos.length} repos for ${owner}`);
  } catch {
    spinner.fail("  Could not fetch repos from GitHub");
  }

  // Default repo: existing config > git remote detection
  const defaultRepo = existing?.repos?.[0] ?? detected?.repo;

  let selectedRepo: string;
  if (repos.length > 0) {
    selectedRepo = await select({
      message: "Select repository:",
      choices: [
        ...repos.map((r) => ({
          name: r.name,
          value: r.name,
        })),
        { name: "Other (type manually)", value: "__other__" },
      ],
      default: defaultRepo,
    });

    if (selectedRepo === "__other__") {
      selectedRepo = await input({
        message: "GitHub repo name:",
        default: defaultRepo,
      });
    }
  } else {
    selectedRepo = await input({
      message: "GitHub repo name:",
      default: defaultRepo,
    });
  }

  // Git identity for CI commits (needed for Vercel deployments, etc.)
  ui.hint([
    "Commits made by the automation need a git identity.",
    "Use your own name/email if your deploy platform (e.g., Vercel)",
    "needs to recognize the committer.",
  ]);

  const commitName = await input({
    message: "Git commit author name:",
    default: existing?.commitName ?? owner,
  });

  const commitEmail = await input({
    message: "Git commit author email:",
    default: existing?.commitEmail,
  });

  return {
    owner,
    repos: [selectedRepo],
    anthropicKeySecretName: existing?.anthropicKeySecretName ?? "ANTHROPIC_API_KEY",
    commitName,
    commitEmail,
    pat,
    fetchedRepos: repos,
  };
}

// ─── Cloudflare Setup ───

export async function setupCloudflare(
  savedToken?: string,
  savedAccountId?: string,
  existing?: CloudflareConfig,
  projectName?: string
): Promise<CloudflareConfig> {
  let apiToken: string;
  if (savedToken) {
    ui.success(`Cloudflare API token found (${maskKey(savedToken)})`);
    apiToken = savedToken;
  } else {
    ui.hint([
      "To create a Cloudflare API token:",
      "1. Go to dash.cloudflare.com → My Profile → API Tokens",
      '2. Click "Create Token"',
      '3. Use the "Edit Cloudflare Workers" template',
      '4. Set Account Resources → your account, Zone Resources → "All zones"',
      '5. Click "Continue to summary" → "Create Token"',
      '6. Copy the token (you won\'t see it again)',
      "",
      "Docs: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/",
    ]);
    apiToken = await password({
      message: "Cloudflare API token:",
    });
  }

  let accountId: string;
  if (savedAccountId) {
    ui.success(`Cloudflare account ID found (${maskKey(savedAccountId)})`);
    accountId = savedAccountId;
  } else {
    ui.hint([
      "To find your Cloudflare account ID:",
      "1. Go to dash.cloudflare.com",
      "2. Click Workers & Pages in the left sidebar",
      '3. Your Account ID is on the right side under "Account details"',
      "   (or in the URL: dash.cloudflare.com/<account-id>/workers)",
    ]);
    accountId = await input({
      message: "Cloudflare account ID:",
    });
  }

  const slugifiedProject = projectName
    ? projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
    : undefined;
  const workerName = await input({
    message: "Worker name:",
    default: existing?.workerName ?? (slugifiedProject ? `claudopilot-${slugifiedProject}` : "claudopilot-webhook"),
  });

  return { apiToken, accountId, workerName };
}

// ─── Red Team Setup ───

export async function setupRedTeam(anthropicKey: string, clickupApiKey: string, workspaceId: string, existing?: RedTeamConfig): Promise<RedTeamConfig> {
  const maxRounds = await select({
    message: "Max red team iterations per feature:",
    choices: [
      { name: "3 (faster, less thorough)", value: 3 },
      { name: "5 (recommended)", value: 5 },
      { name: "7 (very thorough)", value: 7 },
    ],
    default: existing?.maxRounds ?? 5,
  });

  const blockingSeverity = await select<Severity>({
    message: "Minimum severity that blocks the spec:",
    choices: [
      { name: "Critical only (lenient — HIGH findings noted but don't block)", value: "critical" },
      { name: "High and above (recommended — HIGH and CRITICAL block)", value: "high" },
      { name: "Medium and above (strict — all findings block)", value: "medium" },
    ],
    default: existing?.blockingSeverity ?? "critical",
  });

  // If we have existing lenses, offer to keep them
  let domainLenses: DomainLens[] = [];

  if (existing?.domainLenses && existing.domainLenses.length > 0) {
    ui.info(`Found ${existing.domainLenses.length} existing domain lens${existing.domainLenses.length > 1 ? "es" : ""}:`);
    for (const lens of existing.domainLenses) {
      console.log(
        `    ${chalk.bold.white(lens.name)}: ${chalk.dim(lens.description)}`
      );
      for (const check of lens.checks) {
        console.log(chalk.dim(`      • ${check}`));
      }
    }

    const keepExisting = await confirm({
      message: "Keep existing domain lenses?",
      default: true,
    });

    if (keepExisting) {
      domainLenses = [...existing.domainLenses];
    }
  }

  // Only show the analysis hint if we don't already have lenses
  if (domainLenses.length === 0) {
    ui.hint([
      "Domain lenses add TECHNICAL checks specific to your product domain.",
      "The red team already covers architecture, security, data integrity, and UX.",
      "These lenses catch domain-specific engineering pitfalls it would otherwise miss.",
    ]);
  }

  // Offer AI-powered analysis
  const autoAnalyze = await confirm({
    message: domainLenses.length > 0
      ? "Run AI analysis to suggest additional lenses?"
      : "Auto-analyze your codebase to suggest domain lenses?",
    default: domainLenses.length === 0,
  });

  if (autoAnalyze) {
    const spinner = ui.spinner("Analyzing codebase...");
    try {
      const suggested = await suggestDomainLenses(anthropicKey);
      spinner.succeed(`  Found ${suggested.length} suggested lenses`);

      // Filter out lenses with names that match existing ones
      const existingNames = new Set(domainLenses.map((l) => l.name.toLowerCase()));
      const newSuggestions = suggested.filter(
        (l) => !existingNames.has(l.name.toLowerCase())
      );

      if (newSuggestions.length === 0 && suggested.length > 0) {
        ui.info("All suggested lenses overlap with existing ones — nothing new to add.");
      }

      // Present each suggestion for review
      for (const lens of newSuggestions) {
        ui.blank();
        console.log(
          `    ${chalk.bold.white(lens.name)}: ${chalk.dim(lens.description)}`
        );
        for (const check of lens.checks) {
          console.log(chalk.dim(`      • ${check}`));
        }

        const action = await select({
          message: `"${lens.name}" →`,
          choices: [
            { name: "Accept", value: "accept" },
            { name: "Edit", value: "edit" },
            { name: "Skip", value: "skip" },
          ],
        });

        if (action === "accept") {
          domainLenses.push(lens);
        } else if (action === "edit") {
          const name = await input({
            message: "Lens name:",
            default: lens.name,
          });
          const description = await input({
            message: "Red team focus:",
            default: lens.description,
          });
          const checksRaw = await input({
            message: "Checks (comma-separated):",
            default: lens.checks.join(", "),
          });
          domainLenses.push({
            name,
            description,
            checks: checksRaw
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean),
          });
        }
      }
    } catch (error) {
      spinner.fail("  Could not analyze codebase");
      ui.warn(`${error}`);
    }
  }

  // Always offer to add more manually
  const addManual = await confirm({
    message: domainLenses.length > 0
      ? "Add additional lenses manually?"
      : "Add domain lenses manually?",
    default: domainLenses.length === 0,
  });

  if (addManual) {
    let addMore = true;
    while (addMore) {
      const name = await input({
        message: "Lens name (e.g., 'Payment Processing', 'External API Integration'):",
      });
      const description = await input({
        message: `Red team focus for "${name}":`,
      });
      const checksRaw = await input({
        message: "Checks (comma-separated):",
      });

      domainLenses.push({
        name,
        description,
        checks: checksRaw
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      });

      addMore = await confirm({
        message: "Add another lens?",
        default: false,
      });
    }
  }

  if (domainLenses.length > 0) {
    ui.success(`${domainLenses.length} domain lens${domainLenses.length > 1 ? "es" : ""} configured`);
  }

  return { maxRounds, blockingSeverity, domainLenses, blockedAssignee: existing?.blockedAssignee ?? "task_creator", blockedAssigneeUserId: existing?.blockedAssigneeUserId };
}

// ─── Assignee Management Setup ───

export async function setupAssignees(clickupApiKey: string, workspaceId: string, existing?: AssigneeConfig): Promise<AssigneeConfig> {
  ui.hint([
    "Assignee management controls who gets notified at each workflow transition.",
    "Humans are unassigned during automated work (no noise), then re-assigned",
    "when their input is needed (blocked, awaiting approval, in review).",
  ]);

  const blockedAssignee = await select({
    message: "When blocked, assign task to:",
    choices: [
      { name: "Task creator (the person who made the task)", value: "task_creator" as const },
      { name: "A specific team member", value: "specific" as const },
    ],
    default: existing?.blockedAssignee ?? "task_creator",
  });

  let blockedAssigneeUserId = existing?.blockedAssigneeUserId;

  if (blockedAssignee === "specific") {
    const adapter = new ClickUpAdapter(clickupApiKey);
    const membersSpinner = ui.spinner("Fetching workspace members...");
    try {
      const members = await adapter.getMembers(workspaceId);
      membersSpinner.succeed(`  Found ${members.length} members`);

      blockedAssigneeUserId = await select({
        message: "Assign blocked tasks to:",
        choices: members.map((m) => ({
          name: `${m.username} (${m.email})`,
          value: m.id,
        })),
        default: blockedAssigneeUserId,
      });
    } catch (error) {
      membersSpinner.fail("  Could not fetch members");
      blockedAssigneeUserId = await input({
        message: "ClickUp user ID to assign:",
        default: blockedAssigneeUserId,
      });
    }
  }

  // Reviewer
  const reviewerChoice = await select({
    message: "Who should be assigned when a task needs review? (awaiting approval, in review)",
    choices: [
      { name: "Same as blocked assignee", value: "same" },
      { name: "A specific team member", value: "specific" },
      { name: "Nobody (skip)", value: "nobody" },
    ],
    default: existing?.reviewerUserId
      ? "specific"
      : existing?.reviewerUserId === undefined
        ? "same"
        : "nobody",
  });

  let reviewerUserId: string | undefined;
  if (reviewerChoice === "same") {
    reviewerUserId = blockedAssignee === "specific" ? blockedAssigneeUserId : undefined;
  } else if (reviewerChoice === "specific") {
    const adapter = new ClickUpAdapter(clickupApiKey);
    const membersSpinner = ui.spinner("Fetching workspace members...");
    try {
      const members = await adapter.getMembers(workspaceId);
      membersSpinner.succeed(`  Found ${members.length} members`);

      reviewerUserId = await select({
        message: "Assign review tasks to:",
        choices: members.map((m) => ({
          name: `${m.username} (${m.email})`,
          value: m.id,
        })),
        default: existing?.reviewerUserId,
      });
    } catch (error) {
      membersSpinner.fail("  Could not fetch members");
      reviewerUserId = await input({
        message: "ClickUp user ID for reviewer:",
        default: existing?.reviewerUserId,
      });
    }
  }

  const unassignOnAutoStart = await confirm({
    message: "Unassign humans when automation starts working? (reduces notification noise)",
    default: existing?.unassignOnAutoStart ?? true,
  });

  ui.success("Assignee management configured");

  return { blockedAssignee, blockedAssigneeUserId, reviewerUserId, unassignOnAutoStart };
}

// ─── Auto-Approve Setup ───

export async function setupAutoApprove(existing?: AutoApproveConfig): Promise<AutoApproveConfig | undefined> {
  const enabled = await confirm({
    message: "Enable auto-approve tag? Tasks with this tag skip manual approval.",
    default: existing?.enabled ?? true,
  });

  if (!enabled) {
    return undefined;
  }

  const tagName = await input({
    message: "Tag name:",
    default: existing?.tagName ?? "auto-approve",
  });

  ui.success(`Auto-approve enabled for tag "${tagName}"`);

  return { enabled: true, tagName };
}

// ─── Deployment Setup ───

export async function setupDeployment(
  projectType: string,
  existing?: DeploymentConfig
): Promise<(DeploymentConfig & { railwayApiToken?: string }) | undefined> {
  const configure = await confirm({
    message: "Configure preview deployments?",
    default: existing !== undefined || projectType === "nextjs",
  });

  if (!configure) {
    return undefined;
  }

  const provider = await select<DeploymentProvider>({
    message: "Deployment provider:",
    choices: [
      { name: "Vercel (auto-detected via GitHub Deployments API, no token needed)", value: "vercel" },
      { name: "Railway", value: "railway" },
      { name: "None (skip preview URLs)", value: "none" },
    ],
    default: existing?.provider ?? (projectType === "nextjs" ? "vercel" : "railway"),
  });

  if (provider === "none") {
    return { provider: "none" };
  }

  if (provider === "vercel") {
    ui.success("Vercel preview URLs will be detected via GitHub Deployments API (zero-config)");
    return { provider: "vercel" };
  }

  // Railway setup
  ui.hint([
    "Railway supports two modes for preview URLs:",
    "1. GitHub Deployments API — enable PR environments in Railway settings, no token needed",
    "2. Railway GraphQL API — for branches without PRs, requires an API token",
    "",
    "You can use both: the workflow tries GitHub Deployments first, then falls back to the Railway API.",
  ]);

  let railwayApiToken: string | undefined;
  let railwayProjectId: string | undefined;
  let railwayServiceId: string | undefined;

  const useRailwayApi = await confirm({
    message: "Configure Railway API for active environment creation?",
    default: !!existing?.railwayProjectId,
  });

  if (useRailwayApi) {
    ui.hint([
      "To create a Railway API token:",
      "1. Go to railway.com → Account Settings → Tokens",
      '2. Click "Create Token"',
      "3. Copy the token",
    ]);
    railwayApiToken = await password({
      message: "Railway API token:",
    });

    ui.hint([
      "To find your Railway project ID:",
      "1. Open your project in Railway",
      "2. Go to Settings → General",
      "3. Copy the Project ID",
    ]);
    railwayProjectId = await input({
      message: "Railway project ID:",
      default: existing?.railwayProjectId,
    });

    railwayServiceId = await input({
      message: "Railway service ID (optional, for multi-service projects — leave empty to skip):",
      default: existing?.railwayServiceId ?? "",
    });
    if (!railwayServiceId) railwayServiceId = undefined;
  }

  return {
    provider: "railway",
    railwayProjectId,
    railwayServiceId,
    railwayApiToken,
  };
}

// ─── Visual Verification Setup ───

export async function setupVisualVerification(
  hasDeployment: boolean,
  existing?: VisualVerificationConfig
): Promise<VisualVerificationConfig | undefined> {
  if (!hasDeployment) {
    return undefined;
  }

  const enable = await confirm({
    message: "Enable visual verification? (Claude screenshots preview deployments and posts to PR)",
    default: existing?.enabled ?? false,
  });

  if (!enable) {
    return undefined;
  }

  const routesInput = await input({
    message: "Routes to always verify (comma-separated, e.g. /,/dashboard,/settings):",
    default: existing?.alwaysCheckRoutes?.join(", ") ?? "/",
  });

  const maxScreenshots = await input({
    message: "Maximum screenshots per verification:",
    default: String(existing?.maxScreenshots ?? 10),
  });

  const includeVideo = await confirm({
    message: "Record video/GIF of the most affected page?",
    default: existing?.includeVideo ?? false,
  });

  return {
    enabled: true,
    alwaysCheckRoutes: routesInput.split(",").map((r) => r.trim()).filter(Boolean),
    maxScreenshots: parseInt(maxScreenshots, 10) || 10,
    includeVideo,
  };
}

// ─── Improve Setup ───

export async function setupImprove(existing?: ImproveConfig): Promise<ImproveConfig | undefined> {
  const enable = await confirm({
    message: "Enable improvement engine? (AI analyzes codebase and generates improvement ideas as ClickUp tasks)",
    default: existing?.enabled ?? true,
  });

  if (!enable) {
    return undefined;
  }

  const useSchedule = await confirm({
    message: "Run improve on a schedule?",
    default: !!existing?.schedule,
  });

  let schedule: string | undefined;
  if (useSchedule) {
    schedule = await input({
      message: "Cron expression (e.g., '0 9 * * 1' for Monday 9am UTC):",
      default: existing?.schedule ?? "0 9 * * 1",
    });
  }

  // Lens selection
  const defaultLenses = existing?.lenses ?? DEFAULT_IMPROVE_LENSES;
  ui.info("Default improve lenses:");
  for (const lens of defaultLenses) {
    console.log(`    • ${lens}`);
  }

  const customizeLenses = await confirm({
    message: "Customize lenses?",
    default: false,
  });

  let lenses: string[];
  if (customizeLenses) {
    const selected = await checkbox({
      message: "Select lenses to enable:",
      choices: DEFAULT_IMPROVE_LENSES.map((l) => ({
        name: l,
        value: l,
        checked: defaultLenses.includes(l),
      })),
    });

    const addCustom = await confirm({
      message: "Add custom lenses?",
      default: false,
    });

    if (addCustom) {
      let addMore = true;
      while (addMore) {
        const lens = await input({ message: "Lens name:" });
        selected.push(lens);
        addMore = await confirm({ message: "Add another?", default: false });
      }
    }

    lenses = selected;
  } else {
    lenses = defaultLenses;
  }

  return { enabled: true, schedule, lenses };
}

// ─── Competitor Tracking Setup ───

export async function setupCompetitors(existing?: CompetitorsConfig): Promise<CompetitorsConfig | undefined> {
  const enable = await confirm({
    message: "Enable competitor tracking? (AI discovers and profiles competitors, tracks changes over time)",
    default: existing?.enabled ?? false,
  });

  if (!enable) {
    return undefined;
  }

  ui.hint([
    "We'll ask a few questions about your project to automatically",
    "discover competitors. You won't need to list them manually.",
  ]);

  const projectDescription = await input({
    message: "What does this project do? (1-2 sentences)",
    default: existing?.projectDescription,
  });

  const targetUsers = await input({
    message: "Who are your target users?",
    default: existing?.targetUsers,
  });

  const searchTermsRaw = await input({
    message: "What would someone Google to find a tool like yours? (comma-separated)",
    default: existing?.searchTerms?.join(", "),
  });

  const searchTerms = searchTermsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  // Synthesize a domain label from the answers
  const domain = existing?.domain ?? `${projectDescription.split(".")[0]} for ${targetUsers.toLowerCase()}`;
  ui.success(`Competitive domain: "${domain}"`);
  ui.hint(["This is stored in .claudopilot.yaml — edit anytime."]);

  // Optional: known competitors as hints
  const addKnown = await confirm({
    message: "Know any competitors already? (optional — AI will discover them either way)",
    default: (existing?.known?.length ?? 0) > 0,
  });

  let known: string[] | undefined;
  if (addKnown) {
    const knownRaw = await input({
      message: "Competitor names (comma-separated):",
      default: existing?.known?.join(", "),
    });
    known = knownRaw
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  // Schedule
  const useSchedule = await confirm({
    message: "Run competitor scan on a schedule?",
    default: !!existing?.schedule,
  });

  let schedule: string | undefined;
  if (useSchedule) {
    schedule = await input({
      message: "Cron expression (e.g., '0 9 * * 1' for Monday 9am UTC):",
      default: existing?.schedule ?? "0 9 * * 1",
    });
  }

  return {
    enabled: true,
    projectDescription,
    targetUsers,
    searchTerms,
    domain,
    known: known && known.length > 0 ? known : undefined,
    schedule,
  };
}

// ─── Dream Setup ───

export async function setupDream(existing?: DreamConfig): Promise<DreamConfig | undefined> {
  const enable = await confirm({
    message: "Enable dream engine? (AI imagines new features based on competitive landscape and market gaps)",
    default: existing?.enabled ?? false,
  });

  if (!enable) {
    return undefined;
  }

  const useSchedule = await confirm({
    message: "Run dream on a schedule?",
    default: !!existing?.schedule,
  });

  let schedule: string | undefined;
  if (useSchedule) {
    schedule = await input({
      message: "Cron expression (e.g., '0 9 * * 1' for Monday 9am UTC):",
      default: existing?.schedule ?? "0 9 * * 1",
    });
  }

  return { enabled: true, schedule };
}

// ─── Feedback Setup ───

export async function setupFeedback(existing?: FeedbackConfig): Promise<FeedbackConfig | undefined> {
  const enabled = await confirm({
    message: "Enable PR feedback cycle? (AI reads and fixes CodeRabbit/security/CI feedback on PRs)",
    default: existing?.enabled ?? true,
  });

  if (!enabled) {
    return undefined;
  }

  ui.success("PR feedback cycle enabled");

  return { enabled: true };
}

// ─── Automations Setup ───

export async function setupAutomations(clickupApiKey: string, spaceId: string, workspaceId: string, existing?: AutomationsConfig): Promise<AutomationsConfig | undefined> {
  const config_workspaceId = workspaceId;
  const enable = await confirm({
    message: "Enable cross-board automations? (Automate statuses, comments, and mentions between ClickUp boards via task relationships)",
    default: existing?.enabled ?? false,
  });

  if (!enable) {
    return undefined;
  }

  const adapter = new ClickUpAdapter(clickupApiKey);

  // Fetch lists for the space
  const listsSpinner = ui.spinner("Fetching lists...");
  let lists: { id: string; name: string }[] = [];
  try {
    lists = await adapter.getLists(spaceId);
    listsSpinner.succeed(`  Found ${lists.length} lists`);
  } catch (error) {
    listsSpinner.fail("  Could not fetch lists");
    ui.warn(`${error}`);
    return undefined;
  }

  // Set up named boards
  const boards: Record<string, string> = { ...(existing?.boards ?? {}) };

  if (Object.keys(boards).length > 0) {
    ui.info("Existing boards:");
    for (const [name, id] of Object.entries(boards)) {
      const listName = lists.find((l) => l.id === id)?.name ?? id;
      console.log(`    ${chalk.bold.white(name)}: ${chalk.dim(listName)} (${id})`);
    }
    const keepBoards = await confirm({
      message: "Keep existing boards?",
      default: true,
    });
    if (!keepBoards) {
      for (const key of Object.keys(boards)) {
        delete boards[key];
      }
    }
  }

  let addMore = true;
  while (addMore) {
    const boardName = await input({
      message: "Board name (e.g., 'engineering', 'support', 'qa'):",
    });

    const listId = await select({
      message: `Select list for "${boardName}":`,
      choices: lists.map((l) => ({ name: `${l.name} (${l.id})`, value: l.id })),
    });

    boards[boardName] = listId;
    ui.success(`Board "${boardName}" → list ${listId}`);

    addMore = await confirm({ message: "Add another board?", default: Object.keys(boards).length < 2 });
  }

  if (Object.keys(boards).length < 2) {
    ui.warn("Cross-board automations requires at least 2 boards.");
    return undefined;
  }

  // Set up rules
  const rules: AutomationRule[] = [...(existing?.rules ?? [])];
  const boardNames = Object.keys(boards);

  if (rules.length > 0) {
    ui.info(`${rules.length} existing rule(s):`);
    for (const rule of rules) {
      console.log(`    ${chalk.bold.white(rule.name)}: ${rule.when.board}/${rule.when.status} → ${rule.then.length} action(s)`);
    }
    const keepRules = await confirm({
      message: "Keep existing rules?",
      default: true,
    });
    if (!keepRules) {
      rules.length = 0;
    }
  }

  let addRules = await confirm({
    message: rules.length > 0 ? "Add more rules?" : "Add automation rules?",
    default: rules.length === 0,
  });

  while (addRules) {
    const ruleName = await input({
      message: "Rule name (e.g., 'Notify support when engineering ships'):",
    });

    const triggerBoard = await select({
      message: "Trigger board (when a task on this board changes):",
      choices: boardNames.map((b) => ({ name: b, value: b })),
    });

    const triggerEvent = await select({
      message: "Trigger event:",
      choices: [
        { name: "Status changes to...", value: "status_changed" as const },
        { name: "Task created on this board", value: "created" as const },
        { name: "Tag added to task", value: "tag_added" as const },
        { name: "Tag removed from task", value: "tag_removed" as const },
      ],
    });

    let triggerTag: string | undefined;
    if (triggerEvent === "tag_added" || triggerEvent === "tag_removed") {
      triggerTag = await input({ message: "Tag name:" });
    }

    let triggerStatus: string | undefined;
    if (triggerEvent === "status_changed") {
      // Fetch statuses for the trigger board
      let statusChoices: { name: string; value: string }[] = [];
      try {
        const statuses = await adapter.getListStatuses(boards[triggerBoard]);
        statusChoices = statuses.map((s) => ({ name: s.status, value: s.status.toLowerCase() }));
      } catch {
        ui.warn("Could not fetch statuses — enter manually.");
      }

      if (statusChoices.length > 0) {
        triggerStatus = await select({
          message: "Trigger status:",
          choices: statusChoices,
        });
      } else {
        triggerStatus = await input({
          message: "Trigger status (lowercase):",
        });
      }
    }

    // Actions
    const actions: AutomationAction[] = [];
    let addActions = true;
    while (addActions) {
      const actionType = await select({
        message: "Action type:",
        choices: [
          { name: "Update linked task status", value: "update_linked" },
          { name: "Comment on linked task", value: "comment_linked" },
          { name: "Create task on another board and link", value: "create_and_link" },
          { name: "Assign user on linked task", value: "assign_linked" },
          { name: "Unassign user(s) on linked task", value: "unassign_linked" },
          { name: "Add tag to linked task", value: "tag_linked" },
          { name: "Create task link", value: "create_link" },
          { name: "Dispatch to Claude (complex reasoning)", value: "dispatch" },
          { name: "Mention user in comment on linked task", value: "mention" },
        ],
      });

      if (actionType === "update_linked") {
        const targetBoard = await select({
          message: "Target board:",
          choices: boardNames.filter((b) => b !== triggerBoard).map((b) => ({ name: b, value: b })),
        });
        let targetStatus: string;
        try {
          const targetStatuses = await adapter.getListStatuses(boards[targetBoard]);
          targetStatus = await select({
            message: "Set linked task status to:",
            choices: targetStatuses.map((s) => ({ name: s.status, value: s.status.toLowerCase() })),
          });
        } catch {
          targetStatus = await input({ message: "Target status (lowercase):" });
        }
        actions.push({ update_linked: { board: targetBoard, status: targetStatus } });
      } else if (actionType === "create_and_link") {
        const targetBoard = await select({
          message: "Create task on which board:",
          choices: boardNames.filter((b) => b !== triggerBoard).map((b) => ({ name: b, value: b })),
        });
        let targetStatus: string | undefined;
        const setStatus = await confirm({ message: "Set an initial status on the new task?", default: false });
        if (setStatus) {
          try {
            const targetStatuses = await adapter.getListStatuses(boards[targetBoard]);
            targetStatus = await select({
              message: "Initial status:",
              choices: targetStatuses.map((s) => ({ name: s.status, value: s.status.toLowerCase() })),
            });
          } catch {
            targetStatus = await input({ message: "Initial status (lowercase):" });
          }
        }
        actions.push({ create_and_link: { board: targetBoard, status: targetStatus } });
      } else if (actionType === "assign_linked") {
        const targetBoard = await select({
          message: "Target board:",
          choices: boardNames.filter((b) => b !== triggerBoard).map((b) => ({ name: b, value: b })),
        });
        let userId: string;
        try {
          const members = await adapter.getMembers(config_workspaceId);
          userId = await select({
            message: "Assign to:",
            choices: members.map((m) => ({ name: `${m.username} (${m.email})`, value: m.id })),
          });
        } catch {
          userId = await input({ message: "ClickUp user ID:" });
        }
        actions.push({ assign_linked: { board: targetBoard, userId } });
      } else if (actionType === "unassign_linked") {
        const targetBoard = await select({
          message: "Target board:",
          choices: boardNames.filter((b) => b !== triggerBoard).map((b) => ({ name: b, value: b })),
        });
        const unassignSpecific = await confirm({ message: "Unassign a specific user? (No = unassign all)", default: false });
        let userId: string | undefined;
        if (unassignSpecific) {
          try {
            const members = await adapter.getMembers(config_workspaceId);
            userId = await select({
              message: "Unassign:",
              choices: members.map((m) => ({ name: `${m.username} (${m.email})`, value: m.id })),
            });
          } catch {
            userId = await input({ message: "ClickUp user ID:" });
          }
        }
        actions.push({ unassign_linked: { board: targetBoard, userId } });
      } else if (actionType === "tag_linked") {
        const targetBoard = await select({
          message: "Target board:",
          choices: boardNames.filter((b) => b !== triggerBoard).map((b) => ({ name: b, value: b })),
        });
        const tag = await input({ message: "Tag name:" });
        actions.push({ tag_linked: { board: targetBoard, tag } });
      } else if (actionType === "comment_linked") {
        const targetBoard = await select({
          message: "Target board:",
          choices: boardNames.filter((b) => b !== triggerBoard).map((b) => ({ name: b, value: b })),
        });
        const text = await input({
          message: "Comment text (supports {{status}}, {{taskName}} templates):",
        });
        actions.push({ comment_linked: { board: targetBoard, text } });
      } else if (actionType === "create_link") {
        const taskId = await input({ message: "Task ID to link to:" });
        actions.push({ create_link: { taskId } });
      } else if (actionType === "dispatch") {
        const prompt = await input({
          message: "Claude prompt (what should Claude do?):",
        });
        actions.push({ dispatch: { prompt } });
      } else if (actionType === "mention") {
        const targetBoard = await select({
          message: "Target board:",
          choices: boardNames.filter((b) => b !== triggerBoard).map((b) => ({ name: b, value: b })),
        });
        let userId: string;
        try {
          const members = await adapter.getMembers(config_workspaceId);
          userId = await select({
            message: "User to mention:",
            choices: members.map((m) => ({ name: `${m.username} (${m.email})`, value: m.id })),
          });
        } catch {
          userId = await input({ message: "ClickUp user ID to mention:" });
        }
        const text = await input({
          message: "Comment text (supports {{taskName}}, {{status}} placeholders):",
          default: "Hey, {{taskName}} moved to {{status}} — please take a look.",
        });
        actions.push({ mention: { userId, text } });
      }

      addActions = await confirm({ message: "Add another action to this rule?", default: false });
    }

    rules.push({ name: ruleName, when: { board: triggerBoard, event: triggerEvent, status: triggerStatus, tag: triggerTag }, then: actions });
    ui.success(`Rule "${ruleName}" added`);

    addRules = await confirm({ message: "Add another rule?", default: false });
  }

  if (rules.length === 0) {
    ui.warn("No rules configured — automations will be enabled but won't do anything.");
  }

  // Dispatch gate tag
  ui.hint([
    "You can require a specific tag on tasks before the planning/implementation",
    "workflow triggers. Tasks without this tag will be ignored even if they",
    "reach 'planning' or 'approved' status. Leave empty to process all tasks.",
  ]);

  const existingTag = existing?.dispatchGateTag || undefined; // treat "" as no tag
  const useGateTag = await confirm({
    message: "Require a tag for planning/implementation dispatch?",
    default: !!existingTag,
  });

  let dispatchGateTag: string | undefined;
  if (useGateTag) {
    dispatchGateTag = await input({
      message: "Tag name (tasks must have this tag to trigger planning/implementation):",
      default: existingTag ?? "claudopilot",
    });
  }

  return { enabled: true, boards, rules, ...(dispatchGateTag ? { dispatchGateTag } : {}) };
}

// ─── Status Customization ───

export async function customizeStatuses(existing?: StatusConfig): Promise<StatusConfig> {
  const defaults = existing ?? DEFAULT_STATUSES;
  const statuses: StatusConfig = { ...defaults };

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const value = await input({
      message: `Status name for "${key}":`,
      default: defaultValue,
    });
    (statuses as unknown as Record<string, string>)[key] = value;
  }

  return statuses;
}

// ─── Gitignore Helper ───

async function ensureGitignored(entry: string): Promise<void> {
  const gitignorePath = join(process.cwd(), ".gitignore");

  let content = "";
  if (existsSync(gitignorePath)) {
    content = await readFile(gitignorePath, "utf-8");
    if (content.split("\n").some((line) => line.trim() === entry)) {
      return; // already present
    }
  }

  const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${newline}${entry}\n`, "utf-8");
}
