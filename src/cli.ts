import { Command } from "commander";
import { init } from "./commands/init.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { update } from "./commands/update.js";
import { secrets } from "./commands/secrets.js";
import { auth } from "./commands/auth.js";

const program = new Command();

program
  .name("claudopilot")
  .description(
    "AI-augmented SDLC with self-driving planning, red team loops, and PM integration"
  )
  .version("0.1.0");

program
  .command("init")
  .description("Initialize claudopilot in the current project")
  .option("--pm <tool>", "Project management tool (clickup)", "clickup")
  .option("--skip-cloud", "Skip cloud resource creation (Cloudflare Worker)")
  .option("--force", "Overwrite existing configuration")
  .action(init);

program
  .command("doctor")
  .description("Verify all integrations are connected and working")
  .action(doctor);

program
  .command("status")
  .description("Show current task pipeline status from your PM tool")
  .action(status);

program
  .command("update")
  .description("Re-install generated files from existing config")
  .option("--include-worker", "Also redeploy the Cloudflare Worker")
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

program.parse();
