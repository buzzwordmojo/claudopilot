import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { ClaudopilotConfig } from "../types.js";

const CONFIG_FILENAME = ".claudopilot.yaml";

export function getConfigPath(rootDir: string = process.cwd()): string {
  return join(rootDir, CONFIG_FILENAME);
}

export async function loadConfig(
  rootDir: string = process.cwd()
): Promise<ClaudopilotConfig | null> {
  const configPath = getConfigPath(rootDir);
  if (!existsSync(configPath)) return null;

  const content = await readFile(configPath, "utf-8");
  return parse(content) as ClaudopilotConfig;
}

export async function saveConfig(
  config: ClaudopilotConfig,
  rootDir: string = process.cwd()
): Promise<void> {
  // Strip secrets — they belong in .claudopilot.env, not the yaml
  const clean: ClaudopilotConfig = {
    ...config,
    pm: {
      ...config.pm,
      apiKey: undefined,
    },
    cloudflare: config.cloudflare
      ? {
          workerName: config.cloudflare.workerName,
          workerUrl: config.cloudflare.workerUrl,
          apiToken: undefined,
          accountId: undefined,
        }
      : undefined,
  };

  const configPath = getConfigPath(rootDir);
  const content = stringify(clean, {
    lineWidth: 80,
    singleQuote: true,
  });
  await writeFile(configPath, content, "utf-8");
}

export function configExists(rootDir: string = process.cwd()): boolean {
  return existsSync(getConfigPath(rootDir));
}
