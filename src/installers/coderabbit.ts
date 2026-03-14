import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ui } from "../utils/ui.js";

export async function installCodeRabbitConfig(
  targetDir: string = process.cwd()
): Promise<void> {
  const configPath = join(targetDir, ".coderabbit.yaml");
  if (existsSync(configPath)) {
    ui.info(".coderabbit.yaml already exists, skipping");
    return;
  }

  await writeFile(configPath, CODERABBIT_CONFIG, "utf-8");
  ui.success(".coderabbit.yaml created");
}

const CODERABBIT_CONFIG = `# CodeRabbit configuration
# Customize path_instructions for your project's patterns

reviews:
  auto_review:
    enabled: true
  path_instructions:
    - path: "src/**"
      instructions: |
        - Flag missing tests
        - Flag potential security issues
        - Flag unnecessary complexity
        - Check for proper error handling
`;
