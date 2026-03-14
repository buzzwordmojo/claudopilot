export interface ClaudopilotConfig {
  version: string;
  project: ProjectConfig;
  pm: PMConfig;
  github: GitHubConfig;
  cloudflare?: CloudflareConfig;
  redTeam: RedTeamConfig;
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
}

export interface CloudflareConfig {
  apiToken?: string;
  accountId?: string;
  workerName: string;
  workerUrl?: string;
}

export interface RedTeamConfig {
  maxRounds: number;
  domainLenses: DomainLens[];
  blockedAssignee: "task_creator" | "specific";
  blockedAssigneeUserId?: string;
}

export interface DomainLens {
  name: string;
  description: string;
  checks: string[];
}

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
}
