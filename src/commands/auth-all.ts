import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ui } from "../utils/ui.js";

const SEARCH_ROOT = join(process.env.HOME ?? "~", "projects", "buzzwordmojo");

export async function authAll(): Promise<void> {
  ui.header("claudopilot auth-all");

  // Find all projects with .claudopilot.yaml under the search root
  let dirs: string[] = [];
  try {
    const output = execSync(`find ${SEARCH_ROOT} -maxdepth 2 -name ".claudopilot.yaml"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    dirs = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace("/.claudopilot.yaml", ""));
  } catch {
    ui.error(`Could not search ${SEARCH_ROOT}`);
    process.exitCode = 1;
    return;
  }

  if (dirs.length === 0) {
    ui.warn(`No claudopilot projects found under ${SEARCH_ROOT}`);
    return;
  }

  ui.info(`Found ${dirs.length} project(s):\n${dirs.map((d) => `  ${d}`).join("\n")}\n`);

  let passed = 0;
  let failed = 0;

  for (const dir of dirs) {
    const spinner = ui.spinner(`auth → ${dir}`);
    try {
      execSync("claudopilot auth", {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      spinner.succeed(`  ${dir}`);
      passed++;
    } catch (error: any) {
      const stderr = error?.stderr?.toString?.() || error?.message || String(error);
      spinner.fail(`  ${dir}: ${stderr.trim()}`);
      failed++;
    }
  }

  ui.info(`\n${passed} succeeded, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}
