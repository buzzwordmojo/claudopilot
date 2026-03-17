# claudopilot

One command turns any project into a self-driving development machine.

A founder writes an idea in ClickUp. Claude plans it, red teams it, revises until bulletproof, asks humans when stuck, implements with TDD, creates a PR, and ships — all without anyone manually orchestrating the steps.

## How it works

```
Founder creates task in ClickUp
        |
        v
    PLANNING  <─────────────────┐
        |  Claude drafts spec   | Red team found CRITICAL
        v                       |
    RED TEAM  ──────────────────┘
        |  No CRITICAL issues
        |
        ├── Has questions? ──> BLOCKED (assign to human, wait)
        |                        |  Human answers
        |                        └──> back to PLANNING
        v
  AWAITING APPROVAL
        |  Human approves
        v
    BUILDING
        |  Claude implements (per-subtask commits)
        |  Creates branch + PR
        v
    IN REVIEW
        |  CodeRabbit + Security Review + Engineer
        v
      DONE
```

claudopilot wires together:

- **ClickUp** as the source of truth (tasks, statuses, comments)
- **Claude Code** as the architect, red team, and implementer
- **GitHub Actions** as the execution engine
- **Cloudflare Workers** as the webhook bridge (ClickUp → GitHub)
- **CodeRabbit** for automated code review

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
2. **ClickUp connection** — validates credentials, picks workspace/space/list, configures 9 lifecycle statuses
3. **GitHub setup** — lists repos from your org, selects target
4. **Red team config** — AI-analyzes your codebase to suggest domain-specific review lenses
5. **Cloudflare Worker** — deploys webhook bridge (ClickUp → GitHub Actions)
6. **File installation** — Claude commands, GitHub Actions workflows, CodeRabbit config
7. **Secret setup** — sets `ANTHROPIC_API_KEY` and `CLICKUP_API_KEY` as GitHub repo secrets

Everything saved to `.claudopilot.yaml` (config) and `.claudopilot.env` (secrets, gitignored). Re-running init pre-fills everything from the previous run.

## What gets installed

```
your-project/
├── .claude/commands/
│   ├── plan-feature.md      # Architect/red team planning loop
│   ├── red-team.md           # Standalone adversarial review
│   └── implement.md          # TDD implementation with PR creation
├── .github/workflows/
│   ├── claude.yml             # Claude Code on @claude mentions
│   ├── security-review.yml    # Security review on PRs
│   └── claudopilot-worker.yml # Autonomous planning + implementation
├── .coderabbit.yaml           # CodeRabbit review config
├── .claudopilot.yaml          # Project config (safe to commit)
└── .claudopilot.env           # Secrets (gitignored)
```

## CLI commands

```bash
claudopilot init          # Interactive setup wizard
claudopilot update        # Re-install generated files from existing config
claudopilot secrets       # Sync local secrets + Claude credentials to GitHub
claudopilot doctor        # Verify all integrations are connected
claudopilot status        # Show task pipeline from ClickUp
```

## Task lifecycle

| Status | What happens |
|--------|-------------|
| **idea** | Task created, waiting to be picked up |
| **planning** | Webhook fires. Claude runs architect/red team loop, posts comments to ClickUp, writes spec |
| **red team** | Red team evaluation in progress |
| **blocked** | Claude has questions — task assigned to human, waiting for answers |
| **awaiting approval** | Spec complete — human reviews and approves |
| **approved** | Webhook fires. Claude implements per subtask, creates branch + PR |
| **building** | Implementation in progress |
| **in review** | PR created — CodeRabbit + security review + human review |
| **done** | Merged and shipped |

## What the planning agent does

When a task moves to "planning":

1. Fetches task details from ClickUp API
2. Reads existing spec (if resuming from blocked)
3. Reads CLAUDE.md and architecture docs
4. Runs architect/red team loop (configurable max rounds)
5. Posts structured comments to the ClickUp task
6. Writes spec to task description as markdown
7. If blocked: assigns to task creator, moves to "blocked"
8. If approved: moves to "awaiting approval"

## What the implementation agent does

When a task moves to "approved":

1. Fetches task + spec from ClickUp
2. Moves task to "building"
3. Creates feature branch (`claudopilot/<task-id>`)
4. Works through spec subtasks in order with per-subtask commits
5. Pushes branch, creates PR via `gh`
6. Posts PR link to ClickUp task
7. Moves task to "in review"

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
| `claudopilot-worker.yml` (planning + implementation) | Runs `claude` CLI headlessly for architect/red team loops and code generation | Claude subscription OAuth token | `CLAUDE_LONG_LIVED_TOKEN` |
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

**Important:** The OAuth token is tied to your personal Claude subscription and may expire when you re-login to Claude Code. Re-run `claudopilot secrets` to refresh it.

### When you still need an API key

The `@claude` mention action and security review action use Anthropic's official GitHub Actions (`anthropics/claude-code-action`, `anthropics/claude-code-security-review`), which require an `ANTHROPIC_API_KEY`. These are lightweight, low-token-usage workflows.

If you don't need `@claude` mentions or automated security review, you can skip the API key entirely — the core planning and implementation pipeline runs on the subscription token alone.

### GitHub secrets summary

| Secret | Required | Source |
|--------|----------|--------|
| `CLAUDE_LONG_LIVED_TOKEN` | Yes | `~/.claude/.credentials.json` |
| `ANTHROPIC_API_KEY` | Optional | [console.anthropic.com](https://console.anthropic.com) |
| `CLICKUP_API_KEY` | Yes | ClickUp Settings → Apps → API Token |
| `GH_PAT` | Yes | GitHub fine-grained token (Contents, Actions, Secrets permissions) |

## Configuration

### .claudopilot.yaml (committed)

```yaml
version: '0.1.0'
project:
  name: my-project
  type: nextjs
pm:
  tool: clickup
  workspaceId: '...'
  spaceId: '...'
  listId: '...'
  statuses:
    idea: idea
    planning: planning
    # ... 9 statuses
github:
  owner: my-org
  repos: [my-project]
  commitName: Jane Developer
  commitEmail: jane@example.com
redTeam:
  maxRounds: 5
  domainLenses:
    - name: External API Resilience
      description: Ensure graceful handling of third-party API failures
      checks:
        - retry logic with backoff
        - graceful degradation on outage
        - rate limit handling
```

### .claudopilot.env (gitignored)

```
ANTHROPIC_API_KEY=sk-ant-...
CLICKUP_API_KEY=pk_...
GITHUB_PAT=github_pat_...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

## Roadmap

See [`context/plans/`](context/plans/) for detailed plans. Below is a summary of what's coming.

### Adapter expansion

claudopilot currently has adapters for PM tools (ClickUp, with Jira/Linear planned). Two more adapter interfaces are in progress:

**Deploy adapters** — abstract "deploy this branch, give me a URL" across platforms. Planned: Vercel (git-push driven), Azure + Terraform (explicit apply). See [`context/plans/deploy-and-qa-adapters.md`](context/plans/deploy-and-qa-adapters.md).

**QA adapters** — abstract test execution with capability flags (`unit`, `e2e`, `needsDeployUrl`). Planned: Jest, Playwright, Cypress, pytest. A composite adapter wraps multiple runners so unit tests run immediately and E2E waits for a deploy URL. See [`context/plans/deploy-and-qa-adapters.md`](context/plans/deploy-and-qa-adapters.md).

**PM adapters** — Jira and Linear, implementing the existing `PMAdapter` interface.

### Autonomous intelligence

New standalone flows that generate work, not just execute it:

- **Brainstorm / Ideation** — analyze the codebase across multiple lenses and create ClickUp tasks automatically
- **Competitor Analysis** — research competitors, surface feature gaps, create prioritized tasks
- **Security Audit** — system-wide SAST + dependency + secrets scanning, on-demand or scheduled

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
├── cli.ts                    # Entry point, commander setup
├── types.ts                  # Config schema, adapter interfaces
├── commands/
│   ├── init.ts               # Interactive setup wizard
│   ├── update.ts             # Re-install files from existing config
│   ├── secrets.ts            # Sync secrets to GitHub repo
│   ├── doctor.ts             # Health checks
│   └── status.ts             # Pipeline visualization
├── adapters/
│   └── clickup.ts            # ClickUp API adapter
├── installers/
│   ├── claude-commands.ts    # .claude/commands/ generator
│   ├── github-actions.ts     # .github/workflows/ generator
│   ├── cloudflare-worker.ts  # Cloudflare Worker deployment
│   └── coderabbit.ts         # .coderabbit.yaml generator
└── utils/
    ├── analyze.ts            # AI-powered codebase analysis
    ├── config.ts             # .claudopilot.yaml read/write
    ├── detect.ts             # Project type + GitHub remote detection
    ├── secrets.ts            # .claudopilot.env management
    └── ui.ts                 # Terminal UI helpers
```

### Adding PM tool adapters

PM tools implement the `PMAdapter` interface in `src/types.ts`. Currently only ClickUp is implemented. To add Jira or Linear, create a new adapter implementing the same interface.

## Development

```bash
npm run build      # Build with tsup
npm run dev        # Watch mode
npm run start      # Run CLI
npm run typecheck  # TypeScript check
```

## License

MIT
