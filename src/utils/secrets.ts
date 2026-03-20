import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = ".claudopilot.env";

export interface StoredSecrets {
  ANTHROPIC_API_KEY?: string;
  CLICKUP_API_KEY?: string;
  GITHUB_PAT?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  RAILWAY_API_TOKEN?: string;
}

const SECRET_KEYS: (keyof StoredSecrets)[] = [
  "ANTHROPIC_API_KEY",
  "CLICKUP_API_KEY",
  "GITHUB_PAT",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "RAILWAY_API_TOKEN",
];

export async function loadSecrets(
  rootDir: string = process.cwd()
): Promise<StoredSecrets> {
  const envPath = join(rootDir, ENV_FILE);
  if (!existsSync(envPath)) return {};

  const content = await readFile(envPath, "utf-8");
  const secrets: StoredSecrets = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (SECRET_KEYS.includes(key as keyof StoredSecrets) && value) {
      (secrets as Record<string, string>)[key] = value;
    }
  }

  return secrets;
}

export async function saveSecrets(
  secrets: StoredSecrets,
  rootDir: string = process.cwd()
): Promise<void> {
  const envPath = join(rootDir, ENV_FILE);

  // Merge with existing
  const existing = await loadSecrets(rootDir);
  const merged = { ...existing, ...secrets };

  const lines = [
    "# claudopilot secrets — DO NOT COMMIT",
    "# This file is gitignored by default",
    "",
  ];

  for (const key of SECRET_KEYS) {
    const value = merged[key];
    if (value) {
      lines.push(`${key}=${value}`);
    }
  }

  lines.push("");
  await writeFile(envPath, lines.join("\n"), "utf-8");
}

/** Mask a key for display, e.g., "pk_8215...2CW3" */
export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
