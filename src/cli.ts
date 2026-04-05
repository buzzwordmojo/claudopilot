import { createRequire } from "node:module";
import { Command } from "commander";
import { init } from "./commands/init.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { update } from "./commands/update.js";
import { secrets } from "./commands/secrets.js";
import { auth } from "./commands/auth.js";
import { improve } from "./commands/improve.js";
import { competitors } from "./commands/competitors.js";
import { dream } from "./commands/dream.js";
import {
  configProject,
  configPm,
  configGithub,
  configCloudflare,
  configRedteam,
  configImprove,
  configCompetitors,
  configDream,
  configAutomations,
  configDeployment,
  configVisualVerification,
  configAssignees,
  configAutoApprove,
} from "./commands/config.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

program
  .name("claudopilot")
  .description(
    "AI-augmented SDLC with self-driving planning, red team loops, and PM integration"
  )
  .version(version);

program
  .command("init")
  .description("Initialize claudopilot in the current project (alias for config)")
  .option("--pm <tool>", "Project management tool (clickup)", "clickup")
  .option("--skip-cloud", "Skip cloud resource creation (Cloudflare Worker)")
  .option("--force", "Overwrite existing configuration")
  .action(init);

const configCmd = program
  .command("config")
  .description("Configure claudopilot — run without args for full wizard, or specify a section")
  .option("--pm <tool>", "Project management tool (clickup)", "clickup")
  .option("--skip-cloud", "Skip cloud resource creation (Cloudflare Worker)")
  .option("--force", "Overwrite existing configuration")
  .action(init);

configCmd
  .command("project")
  .description("Project name and type")
  .action(configProject);

configCmd
  .command("pm")
  .description("PM tool connection (ClickUp) and statuses")
  .action(configPm);

configCmd
  .command("github")
  .description("GitHub PAT, owner, repo, and git identity")
  .action(configGithub);

configCmd
  .command("cloudflare")
  .description("Cloudflare Worker webhook bridge")
  .action(configCloudflare);

configCmd
  .command("redteam")
  .description("Red team agent lenses, severity, and blocked assignee")
  .action(configRedteam);

configCmd
  .command("improve")
  .description("Improvement engine lenses and schedule")
  .action(configImprove);

configCmd
  .command("competitors")
  .description("Competitor tracking discovery and schedule")
  .action(configCompetitors);

configCmd
  .command("dream")
  .description("Dream engine schedule")
  .action(configDream);

configCmd
  .command("automations")
  .description("Cross-board automations rules engine")
  .action(configAutomations);

configCmd
  .command("deployment")
  .description("Preview deployment provider (Vercel, Railway, none)")
  .action(configDeployment);

configCmd
  .command("visual-verification")
  .description("Visual verification of preview deployments (screenshots + video)")
  .action(configVisualVerification);

configCmd
  .command("assignees")
  .description("Assignee management for workflow states")
  .action(configAssignees);

configCmd
  .command("auto-approve")
  .description("Auto-approve tag for small tasks")
  .action(configAutoApprove);

program
  .command("doctor")
  .description("Verify all integrations are connected and working")
  .action(doctor);

program
  .command("status")
  .description("Show version, install situation, and config decisions")
  .action(status);

program
  .command("update")
  .description("Re-install generated files from existing config")
  .option("--include-worker", "Also redeploy the Cloudflare Worker")
  .option("--include-statuses", "Sync ClickUp board statuses from config")
  .option("--skip-self-update", "Skip pulling latest claudopilot (used internally)")
  .action(update);

program
  .command("secrets")
  .description("Sync local secrets and Claude credentials to GitHub repo secrets")
  .option("--dry-run", "Show what would be synced without making changes")
  .action(secrets);

program
  .command("auth")
  .description("Push current Claude credentials to GitHub (quick account swap)")
  .action(auth);

program
  .command("improve")
  .description("Generate improvement ideas as ClickUp tasks")
  .option("--lenses <lenses>", "Comma-separated lenses to analyze")
  .action(improve);

program
  .command("competitors")
  .description("Run competitive landscape analysis")
  .option("--competitors <names>", "Comma-separated competitor names to research")
  .action(competitors);

program
  .command("dream")
  .description("Generate strategic feature ideas from competitive landscape")
  .action(dream);

program.parse();
