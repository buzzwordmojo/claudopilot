import { Command } from "commander";
import { init } from "./commands/init.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";

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

program.parse();
