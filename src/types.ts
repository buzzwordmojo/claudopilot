export type DeploymentProvider = "vercel" | "railway" | "none";

export interface DeploymentConfig {
  provider: DeploymentProvider;
  railwayProjectId?: string;
  railwayServiceId?: string;
  pollTimeout?: number;   // seconds, default 600
  pollInterval?: number;  // seconds, default 20
}

export interface VisualVerificationConfig {
  enabled: boolean;
  alwaysCheckRoutes?: string[];     // routes to always screenshot, e.g. ["/", "/dashboard"]
  viewport?: { width: number; height: number };  // default 1280x720
  maxScreenshots?: number;          // cap to prevent runaway, default 10
  includeVideo?: boolean;           // record video of navigation
}

export interface VerifyConfig {
  enabled: boolean;
  maxRetries?: number;        // default 2 (so up to 3 total attempts: initial + 2 retries)
  lenses?: string[];          // override default lenses
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
  improve?: ImproveConfig;
  competitors?: CompetitorsConfig;
  dream?: DreamConfig;
  deployment?: DeploymentConfig;
  visualVerification?: VisualVerificationConfig;
  verify?: VerifyConfig;
  assignees?: AssigneeConfig;
  autoApprove?: AutoApproveConfig;
  automations?: AutomationsConfig;
  feedback?: FeedbackConfig;
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
  sdlcListIds?: string[];  // boards where planning/implementation dispatch fires
  statuses: StatusConfig;
}

export interface StatusConfig {
  idea: string;
  planning: string;
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

export interface ImproveConfig {
  enabled: boolean;
  schedule?: string;           // cron expression, e.g. "0 9 * * 1" (Monday 9am)
  lenses: string[];            // e.g. ["code quality", "UX", "performance", "security", "docs", "refactoring"]
}

export interface CompetitorsConfig {
  enabled: boolean;
  projectDescription: string;  // "CLI that bootstraps AI planning loops..."
  targetUsers: string;         // "Engineering teams / solo developers"
  searchTerms: string[];       // ["AI code planning", "automated code review", ...]
  domain?: string;             // synthesized or user-overridden competitive domain label
  known?: string[];            // optional seed list of known competitors
  schedule?: string;           // cron expression for periodic refresh
}

export interface DreamConfig {
  enabled: boolean;
  schedule?: string;           // cron expression for periodic runs
}

export interface FeedbackConfig {
  enabled: boolean;
}

export interface AutomationsConfig {
  enabled: boolean;
  boards: Record<string, string>;  // name → listId
  rules: AutomationRule[];
  dispatchGateTag?: string;  // if set, planning/approved dispatch only fires when task has this tag
}

export interface AutomationRule {
  name: string;
  when: AutomationTrigger;
  then: AutomationAction[];
}

export interface AutomationTrigger {
  board: string;    // references boards key
  source?: "clickup" | "github";  // defaults to "clickup"
  event?: "status_changed" | "created" | "tag_added" | "tag_removed"
    | "pr_review_submitted" | "check_run_failed" | "pr_comment_mention";  // includes GitHub PR events
  status?: string;  // status value to trigger on (required for status_changed)
  tag?: string;     // tag name to trigger on (required for tag_added/tag_removed)
}

export type AutomationAction =
  | { update_linked: { board: string; status: string } }
  | { comment_linked: { board: string; text: string } }
  | { create_link: { taskId: string } }
  | { create_and_link: { board: string; status?: string } }
  | { assign_linked: { board: string; userId: string } }
  | { unassign_linked: { board: string; userId?: string } }
  | { tag_linked: { board: string; tag: string } }
  | { dispatch: { prompt: string } }
  | { mention: { userId: string; text: string } };

export const DEFAULT_VERIFY_LENSES = [
  "build",
  "typecheck",
  "lint",
  "test",
  "merge-conflicts",
  "spec-compliance",
  "scope",
  "patterns",
  "security",
];

export const DEFAULT_IMPROVE_LENSES = [
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
