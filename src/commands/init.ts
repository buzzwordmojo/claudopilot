import { confirm, input, select, password } from "@inquirer/prompts";
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
import type {
  ClaudopilotConfig,
  DomainLens,
  PMConfig,
  GitHubConfig,
  CloudflareConfig,
  RedTeamConfig,
  StatusConfig,
} from "../types.js";
import { DEFAULT_STATUSES } from "../types.js";
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
          'github.com → Settings → Developer settings → Fine-grained tokens → "Contents", "Actions", and "Secrets" repo permissions',
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

  const totalSteps = options.skipCloud ? 7 : 8;
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
      "Use default statuses (idea → planning → red team → blocked → awaiting approval → approved → building → in review → done)?",
    default: true,
  });

  let statuses: StatusConfig = existingStatuses ?? DEFAULT_STATUSES;
  if (!useDefaults) {
    statuses = await customizeStatuses(existingStatuses);
  }

  const statusSpinner = ui.spinner("Updating ClickUp list statuses...");
  try {
    const adapter = new ClickUpAdapter(pmConfig.apiKey);
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

  // ─── Step 6: Deploy Cloudflare Worker ───
  let cloudflareConfig: CloudflareConfig | undefined;
  let workerUrl: string | undefined;

  if (!options.skipCloud) {
    step++;
    ui.step(step, totalSteps, "Deploying webhook bridge...");

    const setupCf = await confirm({
      message:
        "Deploy a Cloudflare Worker to bridge ClickUp webhooks → GitHub Actions?",
      default: existing?.cloudflare !== undefined || true,
    });

    if (setupCf) {
      cloudflareConfig = await setupCloudflare(
        secrets.CLOUDFLARE_API_TOKEN,
        secrets.CLOUDFLARE_ACCOUNT_ID,
        existing?.cloudflare
      );

      ui.info("Reusing your GitHub PAT from step 4 for webhook dispatch.");

      try {
        workerUrl = await deployCloudflareWorker(
          cloudflareConfig,
          githubConfig,
          githubConfig.pat
        );

        // Create ClickUp webhook pointing to the worker
        const adapter = new ClickUpAdapter(pmConfig.apiKey);
        await adapter.createWebhook(
          pmConfig.workspaceId!,
          workerUrl
        );
        ui.success("ClickUp webhook created → Cloudflare Worker → GitHub Actions");
      } catch (error) {
        ui.error(`Cloudflare deployment failed: ${error}`);
        ui.warn("You can set this up later with: claudopilot init --skip-cloud=false");
      }
    }
  }

  // ─── Step 7: Install files ───
  step++;
  ui.step(step, totalSteps, "Installing project files...");

  const config: ClaudopilotConfig = {
    version: "0.1.0",
    project: {
      name: projectName,
      type: projectType,
      rootDir: process.cwd(),
      repos: [
        {
          name: projectName,
          path: ".",
          type: projectType,
          remote: githubConfig.repos[0]
            ? `${githubConfig.owner}/${githubConfig.repos[0]}`
            : undefined,
        },
      ],
    },
    pm: { tool: pmConfig.tool, workspaceId: pmConfig.workspaceId, spaceId: pmConfig.spaceId, listId: pmConfig.listId, statuses },
    github: { owner: githubConfig.owner, repos: githubConfig.repos, anthropicKeySecretName: githubConfig.anthropicKeySecretName },
    cloudflare: cloudflareConfig
      ? { workerName: cloudflareConfig.workerName, workerUrl }
      : undefined,
    redTeam: redTeamConfig,
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
  });
  ui.success("Secrets saved to .claudopilot.env");

  // Ensure .claudopilot.env is gitignored
  await ensureGitignored(".claudopilot.env");

  await installClaudeMd(config);
  await installClaudeCommands(config);
  await installGitHubActions();
  await installCodeRabbitConfig();

  // ─── Step 8: MCP setup instructions ───
  step++;
  ui.step(step, totalSteps, "Claude Code MCP setup...");

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
  }

  // ─── Post-init: remaining manual steps ───
  ui.header("Almost done — a few manual steps remaining");

  ui.info("1. Connect Claude Code to ClickUp via MCP:");
  ui.blank();
  console.log(
    "    claude mcp add --transport http clickup https://mcp.clickup.com/mcp"
  );
  ui.blank();
  ui.info("   Then run /mcp in a Claude Code session to authorize.");

  ui.info("2. Verify everything is connected:");
  ui.blank();
  console.log("    claudopilot doctor");

  ui.done();
}

// ─── PM Setup ───

async function setupClickUp(savedKey?: string, existing?: PMConfig): Promise<PMConfig> {
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

async function setupGitHub(savedPat?: string, existing?: GitHubConfig): Promise<GitHubConfig & { pat: string }> {
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

  return {
    owner,
    repos: [selectedRepo],
    anthropicKeySecretName: existing?.anthropicKeySecretName ?? "ANTHROPIC_API_KEY",
    pat,
  };
}

// ─── Cloudflare Setup ───

async function setupCloudflare(
  savedToken?: string,
  savedAccountId?: string,
  existing?: CloudflareConfig
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

  const workerName = await input({
    message: "Worker name:",
    default: existing?.workerName ?? "claudopilot-webhook",
  });

  return { apiToken, accountId, workerName };
}

// ─── Red Team Setup ───

async function setupRedTeam(anthropicKey: string, clickupApiKey: string, workspaceId: string, existing?: RedTeamConfig): Promise<RedTeamConfig> {
  const maxRounds = await select({
    message: "Max red team iterations per feature:",
    choices: [
      { name: "3 (faster, less thorough)", value: 3 },
      { name: "5 (recommended)", value: 5 },
      { name: "7 (very thorough)", value: 7 },
    ],
    default: existing?.maxRounds ?? 5,
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

  // ─── Blocked assignee ───
  ui.hint([
    "When the planning agent has questions, it moves the task to 'blocked'.",
    "Who should be assigned so they know to respond?",
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

  return { maxRounds, domainLenses, blockedAssignee, blockedAssigneeUserId };
}

// ─── Status Customization ───

async function customizeStatuses(existing?: StatusConfig): Promise<StatusConfig> {
  const defaults = existing ?? DEFAULT_STATUSES;
  const statuses: StatusConfig = { ...defaults };

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const value = await input({
      message: `Status name for "${key}":`,
      default: defaultValue,
    });
    (statuses as Record<string, string>)[key] = value;
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
