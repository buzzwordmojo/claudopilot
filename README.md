# claudopilot

One command turns any project into a self-driving development machine.

A founder writes an idea in ClickUp. Claude plans it, red teams it, revises until bulletproof, asks humans when stuck, implements with TDD, creates a PR, fixes review feedback automatically, and ships — all without anyone manually orchestrating the steps.

## How it works

```
Founder creates task in ClickUp
        |
        v
    PLANNING  <─────────────────┐
        |  Claude drafts spec   | Red team found blocking issues
        v                       |
    RED TEAM  ──────────────────┘
        |  No blocking issues
        |
        ├── Has questions? ──> BLOCKED (assign to human, notify, wait)
        |                        |  Human answers
        |                        └──> back to PLANNING
        |
        ├── Tagged "auto-approve"? ──> APPROVED (skip manual gate)
        |
        v
  AWAITING APPROVAL (reviewer assigned + notified)
        |  Human approves
        v
    BUILDING (humans unassigned — no notification noise)
        |  Claude implements (per-subtask commits)
        |  Creates branch + PR
        v
    IN REVIEW (reviewer assigned + notified)
        |  CodeRabbit + Security Review + Engineer
        |
        ├── Actionable feedback? ──> fix-feedback cycle
        |     |  Reads all PR feedback, pushes fixes
        |     └──> back to IN REVIEW
        |
        v
      DONE
```

claudopilot wires together:

- **ClickUp** as the source of truth (tasks, statuses, comments)
- **Claude Code** as the architect, red team, and implementer
- **GitHub Actions** as the execution engine
- **Cloudflare Workers** as the webhook bridge (ClickUp + GitHub → GitHub Actions)
- **CodeRabbit** for automated code review
- **MCP server** for Claude <> ClickUp communication (task reads, updates, comments)

The user provides API keys. claudopilot creates everything else.

## The adversarial planning loop

Most AI coding workflows are one-shot: human writes prompt, AI writes code, human reviews. This is fragile.

claudopilot introduces an adversarial loop where Claude plays both **architect** and **red team**. The red team can reject the architect's work and send it back for revision. The loop runs until the red team passes — no human babysitting required.

The red team evaluates through standard lenses (architecture, security, data integrity, UX) plus **domain-specific lenses** that are auto-suggested by analyzing your codebase during setup.

The key insight: the red team **owns the gate**. The spec doesn't advance until the red team says so. This catches flaws during planning when they're cheap to fix — not during code review when they're expensive.

## Quick start

```bash
# In your project directory
npx @buzzwordmojo/claudopilot init
```

The interactive wizard walks you through:

1. **Project detection** — auto-detects Next.js, NestJS, FastAPI, Rails
2. **ClickUp connection** — validates credentials, picks workspace/space/list, configures 8 lifecycle statuses
3. **GitHub setup** — lists repos from your org, selects target, configures git identity for CI commits
4. **Red team config** — AI-analyzes your codebase to suggest domain-specific review lenses, configures blocking severity
5. **Cross-board automations** — event-driven rules engine for syncing statuses and triggering actions across boards
6. **PR feedback cycle** — auto-fix CodeRabbit reviews, CI failures, and @claude mentions on PRs
7. **Webhook bridge** — deploys Cloudflare Worker handling both ClickUp and GitHub webhook events
8. **GitHub webhook** — creates webhook on your repo for PR feedback events (reviews, check failures, comments)
9. **Assignee management** — who gets notified when blocked, who reviews approvals and PRs, auto-unassign during automation
10. **Auto-approve** — tag name for tasks that skip the manual approval gate
11. **Companion repos** — multi-repo support for projects spanning multiple repositories
12. **Improve engine** — AI-powered codebase analysis that generates improvement ideas as ClickUp tasks
13. **Competitor tracking** — AI-powered competitive landscape discovery and profiling
14. **Dream engine** — feature ideation from competitive gaps, creates ClickUp tasks
15. **Deployment** — preview URL provider (Vercel, Railway) for PR deployments
16. **File installation** — Claude commands, GitHub Actions workflows, MCP server, CodeRabbit config
17. **Secret setup** — sets `ANTHROPIC_API_KEY` and `CLICKUP_API_KEY` as GitHub repo secrets

Everything saved to `.claudopilot.yaml` (config) and `.claudopilot.env` (secrets, gitignored). Re-running init pre-fills everything from the previous run.

## What gets installed

```
your-project/
├── .claude/
│   ├── commands/
│   │   ├── plan-feature.md      # Architect/red team planning loop
│   │   ├── red-team.md           # Standalone adversarial review
│   │   ├── implement.md          # TDD implementation with PR creation
│   │   ├── fix-feedback.md       # PR feedback reader + auto-fixer
│   │   ├── improve.md            # Codebase analysis + idea generation (if enabled)
│   │   ├── competitors.md        # Competitive landscape analysis (if enabled)
│   │   └── dream.md              # Feature ideation from competitive gaps (if enabled)
│   └── mcp-server/
│       ├── index.js              # Bundled ClickUp MCP server
│       └── package.json
├── .mcp.json                      # MCP server config for Claude Code
├── .github/workflows/
│   ├── claude.yml                 # Claude Code on @claude mentions
│   ├── security-review.yml        # Security review on PRs
│   ├── claudopilot-worker.yml     # Autonomous planning + implementation + fix-feedback
│   ├── claudopilot-improve.yml    # Scheduled improve (if enabled)
│   ├── claudopilot-competitors.yml# Competitive analysis (if enabled)
│   ├── claudopilot-dream.yml      # Feature ideation (if enabled)
│   └── claudopilot-automations.yml# Cross-board automations dispatch (if enabled)
├── .coderabbit.yaml               # CodeRabbit review config
├── .claudopilot.yaml              # Project config (safe to commit)
└── .claudopilot.env               # Secrets (gitignored)
```

## CLI commands

```bash
claudopilot init              # Interactive setup wizard (alias: claudopilot config)
claudopilot update            # Re-install generated files from existing config
claudopilot secrets           # Sync all local secrets to GitHub
claudopilot secrets --dry-run # Preview what would be synced
claudopilot auth              # Push current Claude credentials to GitHub (quick account swap)
claudopilot doctor            # Verify all integrations are connected
claudopilot status            # Show version, install situation, and config decisions
claudopilot improve           # Generate improvement ideas as ClickUp tasks
claudopilot competitors       # Run competitive landscape analysis
claudopilot dream             # Generate strategic feature ideas from competitive gaps
```

### Config subcommands

Reconfigure individual sections without re-running the full wizard:

```bash
claudopilot config project      # Project name and type
claudopilot config pm           # ClickUp connection and statuses
claudopilot config github       # GitHub PAT, owner, repo, git identity
claudopilot config cloudflare   # Cloudflare Worker webhook bridge
claudopilot config redteam      # Red team lenses, severity, rounds
claudopilot config assignees    # Blocked assignee, reviewer, unassign toggle
claudopilot config auto-approve # Auto-approve tag for small tasks
claudopilot config improve      # Improve lenses and schedule
claudopilot config competitors  # Competitor tracking discovery and schedule
claudopilot config dream        # Dream engine schedule
claudopilot config automations  # Cross-board automations rules engine
claudopilot config deployment   # Preview deployment provider (Vercel, Railway)
```

## Assignee management

claudopilot controls ClickUp task assignment to manage notification noise:

- **Unassign on auto-start** — when the planning or implementation agent begins work, it unassigns all humans. This means the dozens of architect/red-team/progress comments don't ping anyone.
- **Re-assign at transition points** — humans are only assigned (and notified via `notify_all`) at the specific moments their input is needed:
  - **Blocked** — task creator or a specific team member
  - **Awaiting approval** — configured reviewer
  - **In review** — configured reviewer (PR ready)

## Auto-approve

Tasks tagged with a configurable tag (default: `auto-approve`) skip the manual approval gate entirely. The planning agent checks tags after completing the spec and moves directly to "approved" instead of "awaiting approval". The Cloudflare Worker already triggers on both statuses, so implementation starts immediately.

Useful for small fixes, chores, and well-defined tasks that don't need human review of the plan.

## PR feedback cycle

After a PR is created and the task moves to "in review", GitHub webhooks route PR events through the Cloudflare Worker to trigger an automated fix-feedback job:

- **CodeRabbit reviews** — reads review comments, fixes actionable issues, pushes commits
- **Security findings** — addresses security review results
- **CI failures** — reads failed check run details, fixes the root cause
- **@claude mentions** — responds to explicit requests in PR comments

The fix-feedback job reads all PR feedback (reviews, check runs, comments), determines what is actionable, fixes it, and pushes. There is no artificial round limit — it responds to every actionable event. Self-loop prevention filters out CI bot events and its own commits to avoid infinite cycles.

## Cross-board automations

An event-driven rules engine that triggers actions when things happen across your ClickUp boards. Configured via `.claudopilot.yaml`.

**Triggers** (from ClickUp or GitHub):
- Status changes, tag additions/removals, task creation
- PR reviews submitted, check run failures, @claude mentions in PR comments

**Actions:**
- Update linked task status on another board
- Comment on linked tasks with template variables
- Create and link new tasks across boards
- Assign/unassign users on linked tasks
- Tag linked tasks
- Mention a ClickUp user in a task comment (with template variables like `{{taskName}}`, `{{status}}`)
- Dispatch a Claude workflow

The Cloudflare Worker evaluates rules on every webhook event and executes matching actions. This replaces manual cross-board status syncing.

## Improve engine

The improve command (`claudopilot improve`) analyzes your codebase through configurable lenses (code quality, UX, performance, security, docs, refactoring) and creates ClickUp tasks for improvement ideas.

Features:
- AI reads actual source files — every idea references specific code
- Deduplicates against existing ClickUp tasks
- Tasks tagged `ai-generated` for easy filtering
- Continuation support via state file (survives token exhaustion)
- Optional scheduled runs via GitHub Actions with approval gates

## Competitors engine

The competitors command (`claudopilot competitors`) runs AI-powered competitive landscape analysis:

- Discovers competitors based on your project description, target users, and search terms
- Profiles each competitor (features, pricing, strengths, weaknesses)
- Tracks changes on scheduled runs
- Results saved to `context/competitors.json` and `context/competitors.md`
- Optional seed list of known competitors to include

## Dream engine

The dream command (`claudopilot dream`) generates strategic feature ideas by analyzing gaps in the competitive landscape:

- Reads competitor profiles from the competitors engine
- Identifies unmet needs and differentiators
- Creates ClickUp tasks for feature ideas
- Optional scheduled runs via GitHub Actions

## Self-healing auth refresh

All Claude workflows (planning, implementation, fix-feedback, improve, competitors, dream, automations) include a pre-flight auth check:

1. Reads the stored OAuth token and checks expiration
2. If expired or expiring soon, refreshes via the Anthropic endpoint
3. Updates the `CLAUDE_LONG_LIVED_TOKEN` GitHub secret with the new token
4. Proceeds with the workflow

If refresh fails, the workflow comments on the ClickUp task with instructions to run `claudopilot auth`. No more silent auth failures crashing workflows mid-run.

## Multi-repo support

Projects spanning multiple repositories (e.g., a Next.js frontend + FastAPI backend) are first-class:

- **Planning** — the architect reads CLAUDE.md and source from all repos, tags spec changes by repo
- **Implementation** — the agent has write access to all repos, commits to each separately on the same branch name
- Companion repos are configured during init and stored in `.claudopilot.yaml`

## Task lifecycle

| Status | What happens |
|--------|-------------|
| **idea** | Task created, waiting to be picked up |
| **planning** | Webhook fires. Claude runs architect/red team loop (both phases within one session), posts comments to ClickUp, writes spec. Humans unassigned. |
| **blocked** | Claude has questions — task assigned to human + notified, waiting for answers |
| **awaiting approval** | Spec complete — reviewer assigned + notified. (Skipped if auto-approve tag present.) |
| **approved** | Webhook fires. Claude implements per subtask, creates branch + PR. Humans unassigned. |
| **building** | Implementation in progress |
| **in review** | PR created — reviewer assigned + notified. CodeRabbit + security review + human review. GitHub webhook events (reviews, check failures, @claude mentions) trigger fix-feedback cycle automatically. |
| **done** | Merged and shipped |

## Preview deployments

claudopilot can include preview URLs in PR descriptions and ClickUp comments:

- **Vercel** — zero-config, detected via GitHub Deployments API
- **Railway** — via GitHub Deployments API, or actively via Railway GraphQL API for branches without PRs

Configure with `claudopilot config deployment`.

## Prerequisites

- Node.js 20+
- A ClickUp workspace
- A GitHub repo
- Claude authentication (see below)
- `gh` CLI installed (for PR creation and secret management)
- Cloudflare account (optional, for webhook bridge)

## Authentication: API key vs Claude subscription

claudopilot uses Claude in two different contexts, and each accepts a different credential:

| Workflow | What it does | Credential | GitHub Secret |
|----------|-------------|------------|---------------|
| `claudopilot-worker.yml` (planning + implementation + fix-feedback) | Runs `claude` CLI headlessly for architect/red team loops, code generation, and PR feedback fixes | Claude subscription OAuth token | `CLAUDE_LONG_LIVED_TOKEN` |
| `claude.yml` (`@claude` mentions) | Responds to `@claude` in issues/PRs via `claude-code-action` | Anthropic API key | `ANTHROPIC_API_KEY` |
| `security-review.yml` (PR security review) | Automated security review on PRs via `claude-code-security-review` | Anthropic API key | `ANTHROPIC_API_KEY` |

### Using your Claude subscription (Max plan)

The main planning and implementation workflows run the `claude` CLI directly, which supports the Claude subscription OAuth token. This means you can use your existing Max plan instead of paying per-token via the API.

The `secrets` command handles this automatically — it reads your local Claude credentials and syncs them to GitHub:

```bash
claudopilot secrets           # sync all secrets to GitHub repo
claudopilot secrets --dry-run # preview what would be synced
```

This reads `~/.claude/.credentials.json` (created when you log into Claude Code) and sets it as `CLAUDE_LONG_LIVED_TOKEN` on your GitHub repo, along with all other secrets from `.claudopilot.env`.

**Important:** The OAuth token is tied to your personal Claude subscription and may expire when you re-login to Claude Code. Re-run `claudopilot secrets` to refresh it. In CI, the self-healing auth refresh handles this automatically.

### When you still need an API key

The `@claude` mention action and security review action use Anthropic's official GitHub Actions (`anthropics/claude-code-action`, `anthropics/claude-code-security-review`), which require an `ANTHROPIC_API_KEY`. These are lightweight, low-token-usage workflows.

If you don't need `@claude` mentions or automated security review, you can skip the API key entirely — the core planning and implementation pipeline runs on the subscription token alone.

### GitHub secrets summary

| Secret | Required | Source |
|--------|----------|--------|
| `CLAUDE_LONG_LIVED_TOKEN` | Yes | `~/.claude/.credentials.json` |
| `ANTHROPIC_API_KEY` | Optional | [console.anthropic.com](https://console.anthropic.com) |
| `CLICKUP_API_KEY` | Yes | ClickUp Settings → Apps → API Token |
| `GH_PAT` | Yes | GitHub fine-grained token (Contents, Actions, Secrets, Environments permissions) |
| `RAILWAY_API_TOKEN` | If Railway | railway.com → Account Settings → Tokens |

## Configuration

### .claudopilot.yaml (committed)

```yaml
version: '0.1.0'
project:
  name: my-project
  type: nextjs
  repos:
    - name: my-project
      path: .
      type: nextjs
      role: primary
    - name: my-api
      path: ./my-api
      type: fastapi
      role: companion
      description: FastAPI backend
pm:
  tool: clickup
  workspaceId: '...'
  spaceId: '...'
  listId: '...'
  sdlcListIds: ['...']  # boards where planning/implementation dispatch fires
  statuses:
    idea: idea
    planning: planning
    blocked: blocked
    awaitingApproval: awaiting approval
    approved: approved
    building: building
    inReview: in review
    done: done
github:
  owner: my-org
  repos: [my-project, my-api]
  anthropicKeySecretName: ANTHROPIC_API_KEY
  commitName: Jane Developer
  commitEmail: jane@example.com
redTeam:
  maxRounds: 5
  blockingSeverity: high  # critical | high | medium
  domainLenses:
    - name: External API Resilience
      description: Ensure graceful handling of third-party API failures
      checks:
        - retry logic with backoff
        - graceful degradation on outage
        - rate limit handling
assignees:
  blockedAssignee: task_creator  # or "specific"
  blockedAssigneeUserId: '...'   # if specific
  reviewerUserId: '...'
  unassignOnAutoStart: true
autoApprove:
  enabled: true
  tagName: auto-approve
improve:
  enabled: true
  schedule: '0 9 * * 1'  # Monday 9am UTC
  lenses:
    - code quality
    - UI/UX improvements
    - documentation gaps
    - performance optimization
    - security hardening
    - refactoring opportunities
competitors:
  enabled: true
  projectDescription: 'CLI that bootstraps AI planning loops...'
  targetUsers: 'Engineering teams / solo developers'
  searchTerms: ['AI code planning', 'automated code review']
  domain: 'AI-powered development automation'
  known: ['cursor', 'cody']
  schedule: '0 9 1 * *'  # First of month, 9am UTC
dream:
  enabled: true
  schedule: '0 9 2 * *'  # Second of month, 9am UTC
automations:
  enabled: true
  boards:
    sdlc: '...'       # listId for SDLC board
    bugs: '...'        # listId for bugs board
  dispatchGateTag: auto-approve  # optional: only dispatch when task has this tag
  rules:
    - name: Sync bug status to SDLC
      when:
        board: bugs
        event: status_changed
        status: done
      then:
        - update_linked: { board: sdlc, status: done }
    - name: Notify on PR review
      when:
        board: sdlc
        source: github
        event: pr_review_submitted
      then:
        - mention: { userId: '...', text: 'PR review submitted on {{taskName}}' }
feedback:
  enabled: true
deployment:
  provider: vercel  # or railway | none
```

### .claudopilot.env (gitignored)

```
ANTHROPIC_API_KEY=sk-ant-...
CLICKUP_API_KEY=pk_...
GITHUB_PAT=github_pat_...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
RAILWAY_API_TOKEN=...
```

## Roadmap

See [`context/plans/`](context/plans/) for detailed plans. Below is a summary of what's coming.

### Adapter expansion

claudopilot currently has adapters for PM tools (ClickUp, with Jira/Linear planned). Two more adapter interfaces are in progress:

**Deploy adapters** — abstract "deploy this branch, give me a URL" across platforms. Planned: Vercel (git-push driven), Azure + Terraform (explicit apply). See [`context/plans/deploy-and-qa-adapters.md`](context/plans/deploy-and-qa-adapters.md).

**QA adapters** — abstract test execution with capability flags (`unit`, `e2e`, `needsDeployUrl`). Planned: Jest, Playwright, Cypress, pytest. A composite adapter wraps multiple runners so unit tests run immediately and E2E waits for a deploy URL. See [`context/plans/deploy-and-qa-adapters.md`](context/plans/deploy-and-qa-adapters.md).

**PM adapters** — Jira and Linear, implementing the existing `PMAdapter` interface.

### Pipeline quality gates

Enhancements to the existing plan → build → review pipeline:

- **QA validation** — verify implementation against spec acceptance criteria before PR creation
- **Spec self-critique** — reduce red team rounds with an extended-thinking critique pass
- **Security gate** — block PRs on critical security findings

### Reporting & visibility

- **Changelog generation** — auto-generate release notes from completed ClickUp tasks
- **Spec-aware PR review** — PR review that understands the original planning spec, not just the diff

See [`context/plans/roadmap.md`](context/plans/roadmap.md) for the full roadmap with priority and effort estimates.

## Architecture

```
src/
├── cli.ts                    # Entry point, commander setup (version from package.json)
├── types.ts                  # Config schema, adapter interfaces
├── commands/
│   ├── init.ts               # Interactive setup wizard (17 steps)
│   ├── config.ts             # Per-section config subcommands
│   ├── update.ts             # Re-install files from existing config
│   ├── secrets.ts            # Sync secrets to GitHub repo
│   ├── auth.ts               # Quick Claude credential swap
│   ├── doctor.ts             # Health checks (assignees, auto-approve, deployments, etc.)
│   ├── status.ts             # System overview (version, config, install state)
│   ├── improve.ts            # Codebase analysis + idea generation
│   ├── competitors.ts        # Competitive landscape analysis
│   └── dream.ts              # Feature ideation from competitive gaps
├── adapters/
│   └── clickup.ts            # ClickUp API adapter
├── installers/
│   ├── claude-commands.ts     # .claude/commands/ generator (7 commands)
│   ├── github-actions.ts      # .github/workflows/ generator (up to 7 workflows)
│   ├── cloudflare-worker.ts   # Cloudflare Worker deployment (ClickUp + GitHub webhooks)
│   ├── coderabbit.ts          # .coderabbit.yaml generator
│   └── mcp-server.ts          # MCP server installer
├── utils/
│   ├── analyze.ts             # AI-powered codebase analysis
│   ├── config.ts              # .claudopilot.yaml read/write (with migration)
│   ├── detect.ts              # Project type + GitHub remote detection
│   ├── secrets.ts             # .claudopilot.env management
│   └── ui.ts                  # Terminal UI helpers
scripts/
└── bump-version.sh            # Auto-bump semver from conventional commit prefixes
```

### Adding PM tool adapters

PM tools implement the `PMAdapter` interface in `src/types.ts`. Currently only ClickUp is implemented. To add Jira or Linear, create a new adapter implementing the same interface.

## Development

```bash
npm run build      # Build with tsup
npm run dev        # Watch mode
npm run start      # Run CLI
npm run test       # Run tests
npm run typecheck  # TypeScript check
```

This project uses conventional commits. Version is auto-bumped via `scripts/bump-version.sh` (wired as a Claude Code PostToolUse hook). See `CLAUDE.md` for the full prefix table.

## License

AGPL-3.0-or-later
