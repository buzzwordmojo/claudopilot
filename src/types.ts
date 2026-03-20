export type DeploymentProvider = "vercel" | "railway" | "none";

export interface DeploymentConfig {
  provider: DeploymentProvider;
  railwayProjectId?: string;
  railwayServiceId?: string;
  pollTimeout?: number;   // seconds, default 600
  pollInterval?: number;  // seconds, default 20
}

export interface AssigneeConfig {
  blockedAssignee: "task_creator" | "specific";
  blockedAssigneeUserId?: string;
  reviewerUserId?: string;
  unassignOnAutoStart: boolean;
}

export interface AutoApproveConfig {
  enabled: boolean;
  tagName: string;
}

export interface ClaudopilotConfig {
  version: string;
  project: ProjectConfig;
  pm: PMConfig;
  github: GitHubConfig;
  cloudflare?: CloudflareConfig;
  redTeam: RedTeamConfig;
  brainstorm?: BrainstormConfig;
  deployment?: DeploymentConfig;
  assignees?: AssigneeConfig;
  autoApprove?: AutoApproveConfig;
}

export interface ProjectConfig {
  name: string;
  type: ProjectType;
  rootDir: string;
  repos: RepoConfig[];
}

export type ProjectType =
  | "nextjs"
  | "nestjs"
  | "fastapi"
  | "rails"
  | "generic";

export interface RepoConfig {
  name: string;
  path: string;
  type: ProjectType;
  remote?: string;
  role?: "primary" | "companion";
  description?: string;
}

export interface PMConfig {
  tool: "clickup" | "jira" | "linear";
  apiKey?: string;
  workspaceId?: string;
  spaceId?: string;
  listId?: string;
  statuses: StatusConfig;
}

export interface StatusConfig {
  idea: string;
  planning: string;
  redTeam: string;
  blocked: string;
  awaitingApproval: string;
  approved: string;
  building: string;
  inReview: string;
  done: string;
}

export const DEFAULT_STATUSES: StatusConfig = {
  idea: "idea",
  planning: "planning",
  redTeam: "red team",
  blocked: "blocked",
  awaitingApproval: "awaiting approval",
  approved: "approved",
  building: "building",
  inReview: "in review",
  done: "done",
};

export interface GitHubConfig {
  owner: string;
  repos: string[];
  anthropicKeySecretName: string;
  commitName: string;
  commitEmail: string;
}

export interface CloudflareConfig {
  apiToken?: string;
  accountId?: string;
  workerName: string;
  workerUrl?: string;
}

export type Severity = "critical" | "high" | "medium";

export interface RedTeamConfig {
  maxRounds: number;
  blockingSeverity: Severity;
  domainLenses: DomainLens[];
  blockedAssignee: "task_creator" | "specific";
  blockedAssigneeUserId?: string;
}

export interface DomainLens {
  name: string;
  description: string;
  checks: string[];
}

export interface BrainstormConfig {
  enabled: boolean;
  schedule?: string;           // cron expression, e.g. "0 9 * * 1" (Monday 9am)
  lenses: string[];            // e.g. ["code quality", "UX", "performance", "security", "docs", "refactoring"]
}

export const DEFAULT_BRAINSTORM_LENSES = [
  "code quality",
  "UI/UX improvements",
  "documentation gaps",
  "performance optimization",
  "security hardening",
  "refactoring opportunities",
];

export interface PMAdapter {
  name: string;
  validateCredentials(): Promise<boolean>;
  getWorkspaces(): Promise<{ id: string; name: string }[]>;
  getSpaces(workspaceId: string): Promise<{ id: string; name: string }[]>;
  getLists(spaceId: string): Promise<{ id: string; name: string }[]>;
  configureStatuses(
    listId: string,
    statuses: StatusConfig
  ): Promise<void>;
  createBotUser?(workspaceId: string): Promise<{ id: string; name: string }>;
  getTasksByStatus(
    listId: string,
    status: string
  ): Promise<{ id: string; name: string; status: string }[]>;
  createWebhook(
    workspaceId: string,
    webhookUrl: string
  ): Promise<{ id: string }>;
  createTask?(
    listId: string,
    task: { name: string; description?: string; status?: string; tags?: string[] }
  ): Promise<{ id: string; name: string }>;
}
