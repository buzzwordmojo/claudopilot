import { ui } from "../utils/ui.js";
import { loadConfig } from "../utils/config.js";
import { loadSecrets } from "../utils/secrets.js";
import { ClickUpAdapter } from "../adapters/clickup.js";
import type { StatusConfig } from "../types.js";

export async function status(): Promise<void> {
  ui.banner();

  const config = await loadConfig();
  if (!config) {
    ui.error("No .claudopilot.yaml found. Run 'claudopilot init' first.");
    process.exit(1);
  }

  const secrets = await loadSecrets();
  const clickupKey = secrets.CLICKUP_API_KEY ?? config.pm.apiKey;
  if (!clickupKey) {
    ui.error("No ClickUp API key found. Check .claudopilot.env");
    process.exit(1);
  }

  const adapter = new ClickUpAdapter(clickupKey);
  const listId = config.pm.listId!;
  const statuses = config.pm.statuses;

  ui.header(`Pipeline: ${config.project.name}`);

  const statusOrder: (keyof StatusConfig)[] = [
    "idea",
    "planning",
    "redTeam",
    "blocked",
    "awaitingApproval",
    "approved",
    "building",
    "inReview",
    "done",
  ];

  for (const statusKey of statusOrder) {
    const statusName = statuses[statusKey];
    try {
      const tasks = await adapter.getTasksByStatus(listId, statusName);
      const icon = getStatusIcon(statusKey);
      const label = statusName.toUpperCase().padEnd(20);

      if (tasks.length === 0) {
        console.log(`  ${icon} ${label} —`);
      } else {
        console.log(`  ${icon} ${label} (${tasks.length})`);
        for (const task of tasks) {
          console.log(`     └─ ${task.name} [${task.id}]`);
        }
      }
    } catch {
      console.log(`  ? ${statusName.toUpperCase().padEnd(20)} (error fetching)`);
    }
  }

  ui.blank();
}

function getStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    idea: "💡",
    planning: "📝",
    redTeam: "🔴",
    blocked: "⏸",
    awaitingApproval: "👀",
    approved: "✅",
    building: "🔨",
    inReview: "🔍",
    done: "🚀",
  };
  return icons[status] ?? "•";
}
