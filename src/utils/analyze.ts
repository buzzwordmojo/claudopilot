import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import type { DomainLens } from "../types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

interface CodebaseSnapshot {
  packageJson?: string;
  claudeMd?: string;
  readme?: string;
  directoryTree: string;
  sampleFiles: { path: string; content: string }[];
}

async function buildDirectoryTree(
  rootDir: string,
  prefix = "",
  depth = 3
): Promise<string> {
  if (depth === 0) return "";

  const entries = await readdir(rootDir, { withFileTypes: true });
  const lines: string[] = [];

  const filtered = entries.filter(
    (e) =>
      !e.name.startsWith(".") &&
      !["node_modules", "dist", ".next", "__pycache__", ".venv", "vendor", ".git"].includes(e.name)
  );

  for (const entry of filtered) {
    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/`);
      const subtree = await buildDirectoryTree(
        join(rootDir, entry.name),
        prefix + "  ",
        depth - 1
      );
      if (subtree) lines.push(subtree);
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }

  return lines.join("\n");
}

async function findKeyFiles(
  rootDir: string,
  maxFiles = 8,
  maxSizeKb = 12
): Promise<{ path: string; content: string }[]> {
  const candidates = [
    // Config files that reveal architecture
    "convex/schema.ts",
    "prisma/schema.prisma",
    "drizzle/schema.ts",
    "src/types.ts",
    "src/types/index.ts",
    "app/types.ts",
    "src/lib/db.ts",
    "src/schema.ts",
    // Route/API files
    "src/app/api/route.ts",
    "app/api/route.ts",
    "src/routes/index.ts",
    "app/routers/__init__.py",
    "config/routes.rb",
    // Main entry points
    "src/index.ts",
    "src/main.ts",
    "src/app.ts",
    "app/main.py",
    "app/page.tsx",
    "src/app/page.tsx",
  ];

  const results: { path: string; content: string }[] = [];

  for (const candidate of candidates) {
    if (results.length >= maxFiles) break;
    const fullPath = join(rootDir, candidate);
    if (existsSync(fullPath)) {
      try {
        const stats = await stat(fullPath);
        if (stats.size <= maxSizeKb * 1024) {
          const content = await readFile(fullPath, "utf-8");
          results.push({ path: candidate, content });
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  // If we didn't find enough, scan for schema/type files
  if (results.length < 3) {
    const srcDirs = ["src", "app", "convex", "lib"];
    for (const dir of srcDirs) {
      if (results.length >= maxFiles) break;
      const dirPath = join(rootDir, dir);
      if (!existsSync(dirPath)) continue;
      try {
        const files = await readdir(dirPath);
        for (const file of files) {
          if (results.length >= maxFiles) break;
          if (
            file.match(/schema|types?|model|entities/i) &&
            file.match(/\.(ts|js|py|rb)$/)
          ) {
            const filePath = join(dirPath, file);
            const relPath = relative(rootDir, filePath);
            if (results.some((r) => r.path === relPath)) continue;
            try {
              const stats = await stat(filePath);
              if (stats.size <= maxSizeKb * 1024) {
                const content = await readFile(filePath, "utf-8");
                results.push({ path: relPath, content });
              }
            } catch {
              // skip
            }
          }
        }
      } catch {
        // skip
      }
    }
  }

  return results;
}

async function gatherSnapshot(rootDir: string): Promise<CodebaseSnapshot> {
  const snapshot: CodebaseSnapshot = {
    directoryTree: "",
    sampleFiles: [],
  };

  // package.json / pyproject.toml / Gemfile
  for (const f of ["package.json", "pyproject.toml", "Gemfile", "requirements.txt"]) {
    const p = join(rootDir, f);
    if (existsSync(p)) {
      snapshot.packageJson = await readFile(p, "utf-8");
      break;
    }
  }

  // CLAUDE.md
  const claudeMd = join(rootDir, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    snapshot.claudeMd = await readFile(claudeMd, "utf-8");
  }

  // README
  for (const f of ["README.md", "readme.md", "README"]) {
    const p = join(rootDir, f);
    if (existsSync(p)) {
      snapshot.readme = await readFile(p, "utf-8");
      break;
    }
  }

  snapshot.directoryTree = await buildDirectoryTree(rootDir);
  snapshot.sampleFiles = await findKeyFiles(rootDir);

  return snapshot;
}

export async function suggestDomainLenses(
  anthropicKey: string,
  rootDir: string = process.cwd()
): Promise<DomainLens[]> {
  const snapshot = await gatherSnapshot(rootDir);

  const codebaseContext = [
    snapshot.packageJson && `## package.json / dependencies\n${snapshot.packageJson}`,
    snapshot.claudeMd && `## CLAUDE.md\n${snapshot.claudeMd}`,
    snapshot.readme && `## README (first 2000 chars)\n${snapshot.readme.slice(0, 2000)}`,
    `## Directory structure\n${snapshot.directoryTree}`,
    ...snapshot.sampleFiles.map(
      (f) => `## ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `You are analyzing a codebase to suggest domain-specific red team lenses for an adversarial code review process.

The red team ALREADY checks these generic areas (do NOT suggest these):
- Architecture (coupling, patterns, scale)
- Data integrity (race conditions, partial failures, migrations)
- Security (auth, input validation, data leakage)
- User experience (error states, loading states, mobile)

Your job is to suggest 2-4 ADDITIONAL lenses specific to THIS project's domain and technical stack. Focus on engineering risks that are unique to this type of application.

Each lens needs:
- name: Short label (e.g., "Async AI Pipeline", "Real-time Sync")
- description: One sentence explaining what the red team should focus on
- checks: 3-6 specific technical things to verify

Respond with ONLY valid JSON — an array of objects with "name", "description", and "checks" (string array) fields. No markdown, no explanation.

Here is the codebase:

${codebaseContext}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
  };

  const text = data.content[0]?.text ?? "[]";

  // Extract JSON from response (handle possible markdown wrapping)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const lenses = JSON.parse(jsonMatch[0]) as DomainLens[];
  return lenses;
}
