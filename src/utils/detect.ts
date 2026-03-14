import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectType } from "../types.js";

interface DetectionResult {
  type: ProjectType;
  confidence: number;
  indicators: string[];
}

export async function detectProjectType(
  dir: string = process.cwd()
): Promise<DetectionResult> {
  const checks = await Promise.all([
    checkNextJs(dir),
    checkNestJs(dir),
    checkFastAPI(dir),
    checkRails(dir),
  ]);

  const best = checks
    .filter((c) => c.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)[0];

  return best ?? { type: "generic", confidence: 0, indicators: [] };
}

async function checkNextJs(dir: string): Promise<DetectionResult> {
  const indicators: string[] = [];
  let confidence = 0;

  if (existsSync(join(dir, "next.config.js")) || existsSync(join(dir, "next.config.mjs")) || existsSync(join(dir, "next.config.ts"))) {
    indicators.push("next.config found");
    confidence += 50;
  }

  const pkg = await readPackageJson(dir);
  if (pkg?.dependencies?.next) {
    indicators.push("next in dependencies");
    confidence += 30;
  }

  if (existsSync(join(dir, "src", "app")) || existsSync(join(dir, "app"))) {
    indicators.push("app directory found");
    confidence += 20;
  }

  return { type: "nextjs", confidence, indicators };
}

async function checkNestJs(dir: string): Promise<DetectionResult> {
  const indicators: string[] = [];
  let confidence = 0;

  const pkg = await readPackageJson(dir);
  if (pkg?.dependencies?.["@nestjs/core"]) {
    indicators.push("@nestjs/core in dependencies");
    confidence += 60;
  }

  if (existsSync(join(dir, "nest-cli.json"))) {
    indicators.push("nest-cli.json found");
    confidence += 40;
  }

  return { type: "nestjs", confidence, indicators };
}

async function checkFastAPI(dir: string): Promise<DetectionResult> {
  const indicators: string[] = [];
  let confidence = 0;

  const reqFiles = ["requirements.txt", "pyproject.toml", "Pipfile"];
  for (const f of reqFiles) {
    if (existsSync(join(dir, f))) {
      try {
        const content = await readFile(join(dir, f), "utf-8");
        if (content.includes("fastapi")) {
          indicators.push(`fastapi in ${f}`);
          confidence += 50;
        }
      } catch {}
    }
  }

  if (existsSync(join(dir, "app", "main.py")) || existsSync(join(dir, "main.py"))) {
    indicators.push("main.py found");
    confidence += 20;
  }

  return { type: "fastapi", confidence, indicators };
}

async function checkRails(dir: string): Promise<DetectionResult> {
  const indicators: string[] = [];
  let confidence = 0;

  if (existsSync(join(dir, "Gemfile"))) {
    try {
      const content = await readFile(join(dir, "Gemfile"), "utf-8");
      if (content.includes("rails")) {
        indicators.push("rails in Gemfile");
        confidence += 70;
      }
    } catch {}
  }

  if (existsSync(join(dir, "config", "routes.rb"))) {
    indicators.push("config/routes.rb found");
    confidence += 30;
  }

  return { type: "rails", confidence, indicators };
}

async function readPackageJson(
  dir: string
): Promise<Record<string, any> | null> {
  try {
    const content = await readFile(join(dir, "package.json"), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function detectGitHubRemote(
  dir: string = process.cwd()
): Promise<{ owner: string; repo: string } | null> {
  try {
    const gitConfig = await readFile(
      join(dir, ".git", "config"),
      "utf-8"
    );
    const match = gitConfig.match(
      /github\.com[:/]([^/]+)\/([^/.]+)/
    );
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {}
  return null;
}
