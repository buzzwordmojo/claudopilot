# PM Tool Abstraction: One-File Adapter Pattern

## Context

claudopilot is locked into ClickUp across 4 coupling points: adapter, Worker, workflows, and MCP server. Adding a new PM tool (Jira, Linear, etc.) currently requires touching 7+ files across 4 abstraction layers. Nobody will do that.

**Goal:** Make adding a new PM tool a **one-file task** — implement `PMClient` in the MCP server, and everything else just works.

**Key architectural insight:** Instead of abstracting 4 separate layers, route ALL PM operations through one gateway — the MCP server. Workflows stop curling ClickUp directly. The Worker stops making ClickUp API calls for write operations. Claude handles PM interactions via `pm_*` MCP tools, which delegate to the right client.

## Architecture: Before → After

### Before (current)
```
Workflow shell steps ──curl──→ ClickUp API (comments, status updates)
Claude commands ──MCP──→ clickup_* tools ──→ ClickUp API
Cloudflare Worker ──fetch──→ ClickUp API (automations: update linked, comment, mention)
```
Three separate places calling ClickUp. Three places to rewrite for each new PM tool.

### After
```
Workflow shell steps ──→ (removed — Claude does it via MCP)
Claude commands ──MCP──→ pm_* tools ──→ PMClient interface ──→ ClickUp/Jira/Linear API
Cloudflare Worker ──→ parse webhook + dispatch (no more write operations)
```
One place to add a new PM tool: implement `PMClient`.

## Phase 1: Interface + Factory + Noop Adapters

**Goal:** Clean types, adapter factory, config migration. Foundation for everything.

### 1.1 Expand `PMAdapter` interface — `src/types.ts`

Complete interface covering every PM operation used in the codebase:

```typescript
export type PMTool = "clickup" | "jira" | "linear" | "trello" | "monday";

export interface PMAdapter {
  readonly name: string;

  // Auth
  validateCredentials(): Promise<boolean>;

  // Hierarchy navigation (generic names, tool-specific meanings)
  getWorkspaces(): Promise<{ id: string; name: string }[]>;
  getProjects(workspaceId: string): Promise<{ id: string; name: string }[]>;
  getBoards(projectId: string): Promise<{ id: string; name: string }[]>;
  createBoard(projectId: string, name: string): Promise<{ id: string; name: string }>;

  // Status management
  configureStatuses(boardId: string, statuses: StatusConfig): Promise<void>;
  getBoardStatuses(boardId: string): Promise<{ status: string; color: string }[]>;

  // Tasks
  getTask(taskId: string): Promise<PMTask>;
  getTaskWithRelations(taskId: string): Promise<PMTaskWithRelations>;
  createTask(boardId: string, task: CreateTaskInput): Promise<{ id: string; name: string }>;
  updateTaskStatus(taskId: string, status: string): Promise<void>;
  getTasksByStatus(boardId: string, status: string): Promise<PMTask[]>;

  // Comments
  getTaskComments(taskId: string): Promise<PMComment[]>;
  createTaskComment(taskId: string, text: string, assignee?: string): Promise<void>;

  // Relations
  createTaskRelation(taskId: string, relatedTaskId: string): Promise<void>;

  // Members
  getMembers(workspaceId: string): Promise<{ id: string; username: string; email: string }[]>;

  // Webhooks
  createWebhook(workspaceId: string, url: string, events?: string[]): Promise<{ id: string }>;

  // URLs
  getTaskUrl(taskId: string): string;
}

export interface PMTask {
  id: string;
  name: string;
  status: string;
  boardId: string;
}

export interface PMTaskWithRelations extends PMTask {
  relatedTaskIds: string[];
  subtaskIds?: string[];
}

export interface PMComment {
  id: string;
  text: string;
  author?: string;
  createdAt?: string;
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  status?: string;
  tags?: string[];
  parentId?: string;
}
```

### 1.2 Tool-specific config sub-objects — `src/types.ts`

```typescript
export interface PMConfig {
  tool: PMTool;
  statuses: StatusConfig;
  clickup?: ClickUpPMConfig;
  jira?: JiraPMConfig;
  linear?: LinearPMConfig;
  trello?: TrelloPMConfig;
  monday?: MondayPMConfig;
  // Deprecated flat fields (auto-migrated on load)
  apiKey?: string;
  workspaceId?: string;
  spaceId?: string;
  listId?: string;
  sdlcListIds?: string[];
}

export interface ClickUpPMConfig {
  apiKey: string;
  workspaceId: string;
  spaceId: string;
  listId: string;
  sdlcListIds?: string[];
}

export interface JiraPMConfig {
  email: string;
  apiToken: string;
  siteUrl: string;
  projectKey: string;
}

export interface LinearPMConfig {
  apiKey: string;
  teamId: string;
  projectId?: string;
}

export interface TrelloPMConfig {
  apiKey: string;
  token: string;
  boardId: string;
}

export interface MondayPMConfig {
  apiKey: string;
  boardId: string;
}
```

### 1.3 Update ClickUp adapter — `src/adapters/clickup.ts`

Rename methods to match new interface:
- `getSpaces()` → `getProjects()`
- `getLists()` → `getBoards()`
- `createList()` → `createBoard()`
- `getListStatuses()` → `getBoardStatuses()`
- `getTaskWithLinks()` → `getTaskWithRelations()` (maps `linked_tasks[].task_id` → `relatedTaskIds`)
- `createTaskLink()` → `createTaskRelation()`
- Add `updateTaskStatus()`, `getTaskUrl()`

### 1.4 Noop adapters — `src/adapters/{jira,linear,trello,monday}.ts`

Each implements `PMAdapter`, every method throws:
```typescript
throw new Error(`${this.name}: not yet implemented. See CONTRIBUTING.md for how to add a PM adapter.`);
```

### 1.5 Adapter factory — `src/adapters/index.ts`

```typescript
export function createAdapter(config: PMConfig): PMAdapter {
  switch (config.tool) {
    case "clickup": return new ClickUpAdapter(getClickUpConfig(config));
    case "jira":    return new JiraAdapter();
    case "linear":  return new LinearAdapter();
    case "trello":  return new TrelloAdapter();
    case "monday":  return new MondayAdapter();
  }
}

// Handles flat→nested config migration
function getClickUpConfig(config: PMConfig): ClickUpPMConfig { ... }
```

### 1.6 Config migration — `src/utils/config.ts`

On load, detect old flat format and restructure:
```typescript
if (config.pm.apiKey && !config.pm.clickup) {
  config.pm.clickup = {
    apiKey: config.pm.apiKey,
    workspaceId: config.pm.workspaceId!,
    spaceId: config.pm.spaceId!,
    listId: config.pm.listId!,
    sdlcListIds: config.pm.sdlcListIds,
  };
}
```

### 1.7 Update call sites — `init.ts`, `config.ts`, `doctor.ts`

Replace `new ClickUpAdapter(apiKey)` with `createAdapter(config)` where possible. Keep ClickUp-specific wizard flow (workspace→space→list) behind `config.pm.tool === "clickup"` guard.

### 1.8 PM tool selection in init — `src/commands/init.ts`

Prompt before PM setup:
```
Project management tool:
  > ClickUp
    Jira (coming soon)
    Linear (coming soon)
    Trello (coming soon)
    Monday (coming soon)
```

Non-ClickUp selections warn and proceed with limited functionality.

### Files changed (Phase 1):
- `src/types.ts`
- `src/adapters/clickup.ts`
- `src/adapters/index.ts` (new)
- `src/adapters/jira.ts` (new)
- `src/adapters/linear.ts` (new)
- `src/adapters/trello.ts` (new)
- `src/adapters/monday.ts` (new)
- `src/utils/config.ts`
- `src/commands/init.ts`
- `src/commands/config.ts`
- `src/commands/doctor.ts`

---

## Phase 2: MCP as Single PM Gateway

**Goal:** ALL PM operations go through `pm_*` MCP tools. Workflows stop curling ClickUp. Adding a new PM tool = implementing one `PMClient` class.

### 2.1 Generic MCP server — `mcp-server/src/`

Create `PMClient` interface mirroring the adapter:

```typescript
// mcp-server/src/pm-client.ts (new)
export interface PMClient {
  getTask(id: string): Promise<PMTask>;
  createTask(boardId: string, input: CreateTaskInput): Promise<{ id: string }>;
  updateTask(id: string, updates: Record<string, unknown>): Promise<void>;
  getTaskComments(id: string): Promise<PMComment[]>;
  createTaskComment(id: string, text: string, assignee?: string): Promise<void>;
  getBoardTasks(boardId: string, status?: string): Promise<PMTask[]>;
  getTaskUrl(id: string): string;
}
```

Refactor existing `ClickUpClient` to implement `PMClient`.

Update `mcp-server/src/index.ts`:
- Read `PM_TOOL` from env (default "clickup")
- Factory-create the right client
- Register tools with generic names: `pm_get_task`, `pm_create_task`, `pm_update_task`, `pm_get_task_comments`, `pm_create_task_comment`, `pm_get_board_tasks`

### 2.2 Update `.mcp.json` generation — `src/installers/mcp-server.ts`

- Server name: `"pm"` (was `"clickup"`)
- Env vars: `PM_TOOL`, `PM_API_KEY`, plus tool-specific vars based on `config.pm.tool`
- ClickUp: `PM_TOOL=clickup`, `PM_API_KEY=${CLICKUP_API_KEY}`, `PM_WORKSPACE_ID=...`
- Jira: `PM_TOOL=jira`, `PM_API_KEY=${JIRA_API_TOKEN}`, `PM_SITE_URL=...`, `PM_PROJECT_KEY=...`

### 2.3 MCP tool name constants — `src/utils/mcp-tools.ts` (new)

```typescript
export const PM_TOOLS = {
  getTask:           "mcp__pm__pm_get_task",
  createTask:        "mcp__pm__pm_create_task",
  updateTask:        "mcp__pm__pm_update_task",
  getTaskComments:   "mcp__pm__pm_get_task_comments",
  createTaskComment: "mcp__pm__pm_create_task_comment",
  getBoardTasks:     "mcp__pm__pm_get_board_tasks",
} as const;

export const PM_ALLOWED_TOOLS = Object.values(PM_TOOLS).join(",");
```

### 2.4 Update Claude command templates — `src/installers/claude-commands.ts`

Global find-replace across all generators:
- `clickup_get_task` → `pm_get_task`
- `clickup_create_task` → `pm_create_task`
- `clickup_update_task` → `pm_update_task`
- `clickup_get_task_comments` → `pm_get_task_comments`
- `clickup_create_task_comment` → `pm_create_task_comment`
- `clickup_get_list_tasks` → `pm_get_board_tasks`
- `"ClickUp task"` → `"task"` (or keep generic)
- `https://app.clickup.com/t/$ARGUMENTS` → dynamically generated from `getTaskUrl()`

Also update command instructions to say "Use MCP tools for ALL PM interactions" rather than referencing ClickUp specifically.

### 2.5 Update `--allowedTools` in workflows — `src/installers/github-actions.ts`

Replace all `mcp__clickup__clickup_*` tool name strings with import of `PM_ALLOWED_TOOLS`. Affects ~8 allowedTools strings across plan, implement, fix-feedback, improve, competitors, dream, automations jobs.

### 2.6 Remove workflow `curl` calls to ClickUp — `src/installers/github-actions.ts`

**This is the key change.** Currently workflows post ClickUp comments and update statuses via shell `curl`. Instead:

**For plan-complete, impl-finalize, fix-feedback-complete jobs:**
Replace `curl` blocks with Claude micro-prompts that use MCP tools:

```yaml
- name: Post result to PM
  run: |
    claude -p "Post a comment on task $TASK_ID: '✅ Planning complete — spec ready for review.' Then update the task status to 'awaiting approval'." \
      --max-turns 3 \
      --mcp-config .mcp.json \
      --allowedTools "${PM_ALLOWED_TOOLS}"
```

**Trade-off:** Slightly more overhead per status update (~5s for Claude to make 2 MCP calls vs ~1s for direct curl). But:
- Works with ANY PM tool — no curl commands to maintain per tool
- Claude already has MCP tools loaded in these jobs
- The status update jobs are separate runners anyway, so latency isn't blocking

**Alternative for latency-sensitive paths:** Add a thin CLI command to the MCP server that can be called directly:
```yaml
- name: Post result to PM
  run: |
    node .claude/mcp-server/cli.js comment "$TASK_ID" "✅ Planning complete"
    node .claude/mcp-server/cli.js status "$TASK_ID" "awaiting approval"
```
This avoids spinning up Claude for simple operations while still going through the abstracted `PMClient`. **This is the recommended approach** — add a `cli.js` entry point to the MCP server that exposes key operations as shell commands.

### 2.7 MCP server CLI entry point — `mcp-server/src/cli.ts` (new)

```typescript
// Usage: node cli.js <command> <taskId> [args...]
// Commands: comment, status, get-task-name
const client = createPMClient(process.env.PM_TOOL);
switch (command) {
  case "comment": await client.createTaskComment(taskId, text); break;
  case "status":  await client.updateTask(taskId, { status }); break;
  case "get-task-name": console.log((await client.getTask(taskId)).name); break;
}
```

Build this alongside the MCP server via tsup. Workflows call it instead of `curl`.

### Files changed (Phase 2):
- `mcp-server/src/pm-client.ts` (new)
- `mcp-server/src/cli.ts` (new)
- `mcp-server/src/index.ts`
- `mcp-server/src/clickup.ts` (renamed from client.ts)
- `mcp-server/src/tools/*.ts`
- `src/installers/mcp-server.ts`
- `src/utils/mcp-tools.ts` (new)
- `src/installers/claude-commands.ts`
- `src/installers/github-actions.ts`
- `tsup.config.ts` (add cli.ts entry point)

---

## Phase 3: Worker Simplification (cleanup)

**Goal:** Worker becomes a pure webhook router — no PM API calls.

### 3.1 Move automation write operations to dispatched workflows

Currently the Worker does inline ClickUp API calls for automation actions (update_linked, comment_linked, mention, etc.). Move these to a dispatched workflow:

- Worker parses webhook, matches rules, determines actions needed
- Instead of executing actions inline, Worker dispatches to GitHub Actions with the action list in `client_payload`
- The `claudopilot-automations.yml` workflow receives the action list and executes each via the MCP server CLI

### 3.2 Worker keeps read operations inline

The Worker still needs to:
- Fetch the source task (to determine board, linked tasks)
- Read task data for rule matching

These reads stay as inline `fetch()` calls. For ClickUp, the Worker still calls `api.clickup.com` to read task data. This is acceptable because:
- Read operations are needed for routing decisions
- They're fast (single GET)
- The Worker needs the data *before* it can decide what to dispatch

For other PM tools, the Worker would need tool-specific read logic. This is the one place that remains tool-specific — but it's just reads, and the Worker is already generated as a tool-specific template.

### 3.3 Simplify Worker template — `src/installers/cloudflare-worker.ts`

Remove all write operations (POST/PUT to ClickUp) from the Worker template. The Worker becomes:
1. Parse webhook (tool-specific)
2. Fetch task data for routing (tool-specific read)
3. Match rules
4. Dispatch to GitHub Actions with action list

~200 lines removed from the Worker template.

### Files changed (Phase 3):
- `src/installers/cloudflare-worker.ts`
- `src/installers/github-actions.ts` (automations workflow handles action execution)

---

## What adding a new PM tool looks like after all 3 phases

1. Create `mcp-server/src/jira.ts` implementing `PMClient` (~100 lines)
2. Create `src/adapters/jira.ts` implementing `PMAdapter` (~150 lines)
3. Add Jira webhook parsing to Worker template (~50 lines)
4. Add Jira setup flow to init wizard (~100 lines)

**Total: ~400 lines, 4 files. No changes to workflows, commands, or MCP tool names.**

---

## Verification

**Phase 1:**
- `npm run build` + `npm run test` + `npm run typecheck`
- `claudopilot init` shows tool selection, ClickUp path works identically
- Noop adapters throw clear errors

**Phase 2:**
- MCP server starts, `pm_get_task` tool works with ClickUp
- `node .claude/mcp-server/cli.js comment <taskId> "test"` posts to ClickUp
- `claudopilot update` in test project, trigger a planning task, verify comments/status updates work through MCP CLI instead of curl
- Verify `--allowedTools` in generated workflows reference `pm_*` tools

**Phase 3:**
- Worker no longer makes ClickUp write calls
- Automation actions execute via dispatched workflow
- End-to-end: ClickUp status change → Worker dispatch → workflow executes actions via MCP CLI
