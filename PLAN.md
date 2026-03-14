# claudopilot — Product Plan

## Vision

One command turns any project into a self-driving development machine. A founder writes an idea in ClickUp. Claude plans it, red teams it, revises until bulletproof, asks humans when stuck, implements with TDD, creates a PR, and ships — all without anyone manually orchestrating the steps.

`npx @buzzwordmojo/claudopilot init` installs the entire workflow.

## Problem

Small teams (1-3 engineers) waste enormous time on the glue between tools: copying task descriptions into prompts, manually triggering CI, checking PR reviews, updating task boards. AI coding tools are powerful but disconnected — they don't know about your PM board, your deploy pipeline, or your team's review process.

The result: engineers spend more time orchestrating than building.

## Solution

claudopilot is a CLI that wires together:
- **PM tool** (ClickUp, Jira, Linear) as the source of truth
- **Claude Code** as the architect, red team, and implementer
- **GitHub Actions** as the execution engine
- **Cloudflare Workers** as the webhook bridge
- **CodeRabbit** for static analysis
- **Railway/Vercel/etc** for preview deployments

The user provides API keys. claudopilot creates everything else.

## Core Innovation: The Self-Driving Planning Loop

Most AI coding workflows are: human writes prompt → AI writes code → human reviews. This is one-shot and fragile.

claudopilot introduces an adversarial planning loop that runs autonomously:

```
PLANNING ──► RED TEAM ──► CRITICAL found? ──YES──► back to PLANNING
                              │
                              NO
                              │
                              ▼
                    Need human input? ──YES──► BLOCKED (ask & wait)
                              │
                              NO
                              │
                              ▼
                      AWAITING APPROVAL
```

Claude plays both architect and adversarial reviewer. The red team can reject the architect's work and send it back for revision. This loop runs until the red team passes — no human babysitting required.

The key insight: the red team **owns the gate**. The spec doesn't advance until the red team says so. This catches architectural flaws, security gaps, and edge cases during planning when they're cheap to fix — not during code review when they're expensive.

## The Full Lifecycle

```
Founder creates task in PM tool
  │
  ▼
IDEA ──► assigned to Claude
  │
  ▼
PLANNING ◄──────────────────┐
  │ Claude drafts spec      │ Red team found CRITICAL
  ▼                         │
RED TEAM ───────────────────┘
  │ No CRITICAL issues
  │
  ├── Has questions? ──► BLOCKED (wait for human)
  │                        │ Human answers
  │                        └──► back to PLANNING
  │
  ▼
AWAITING APPROVAL
  │ Human approves
  ▼
APPROVED
  │ Claude implements (TDD)
  ▼
BUILDING
  │ Creates PR
  ▼
IN REVIEW
  │ CI + CodeRabbit + Screenshots + Security Review
  │ Engineer reviews
  ▼
DONE
  │ Merge → auto-deploy
```

## What `claudopilot init` Does

Interactive wizard that:

1. **Detects** project type (Next.js, NestJS, FastAPI, Rails, generic)
2. **Connects** to PM tool (ClickUp API key → validates → picks workspace/space/list)
3. **Configures statuses** on the PM board programmatically (9 statuses)
4. **Detects GitHub** remote (owner/repo from .git/config)
5. **Configures red team** (max rounds, domain-specific lenses)
6. **Deploys** Cloudflare Worker (webhook bridge: PM → GitHub Actions)
7. **Creates webhook** on PM tool pointing to the worker
8. **Installs Claude commands** (.claude/commands/plan-feature.md, red-team.md, implement.md)
9. **Installs GitHub Actions** (claude.yml, security-review.yml, claudopilot-worker.yml)
10. **Installs CodeRabbit config** (.coderabbit.yaml)
11. **Creates CLAUDE.md** template if missing
12. **Saves config** to .claudopilot.yaml

Everything is created programmatically. No manual steps.

## CLI Commands

| Command | Description |
|---------|-------------|
| `claudopilot init` | Full interactive setup wizard |
| `claudopilot doctor` | Verify all integrations are connected |
| `claudopilot status` | Show task pipeline from PM tool |
| `claudopilot add-repo` | Add another repo to existing config (future) |
| `claudopilot update` | Update installed files to latest templates (future) |
| `claudopilot teardown` | Remove all installed files and cloud resources (future) |

## Architecture

```
src/
├── cli.ts                    # Entry point, commander setup
├── types.ts                  # Config schema, adapter interfaces
├── commands/
│   ├── init.ts               # The wizard
│   ├── doctor.ts             # Health checks
│   └── status.ts             # Pipeline view
├── adapters/
│   ├── clickup.ts            # ClickUp API (implemented)
│   ├── jira.ts               # Jira API (future)
│   └── linear.ts             # Linear API (future)
├── installers/
│   ├── claude-commands.ts    # .claude/commands/ generator
│   ├── github-actions.ts     # .github/workflows/ generator
│   ├── cloudflare-worker.ts  # Worker deployment
│   └── coderabbit.ts         # .coderabbit.yaml generator
└── utils/
    ├── config.ts             # .claudopilot.yaml read/write
    ├── detect.ts             # Project type + GitHub remote detection
    └── ui.ts                 # chalk/ora terminal UI
```

### Adapter Pattern

PM tools implement the `PMAdapter` interface:

```typescript
interface PMAdapter {
  validateCredentials(): Promise<boolean>;
  getWorkspaces(): Promise<{ id: string; name: string }[]>;
  getSpaces(workspaceId: string): Promise<...>;
  getLists(spaceId: string): Promise<...>;
  configureStatuses(listId: string, statuses: StatusConfig): Promise<void>;
  getTasksByStatus(listId: string, status: string): Promise<...>;
  createWebhook(workspaceId: string, url: string): Promise<...>;
}
```

Adding Jira or Linear means implementing this interface. The rest of the system is agnostic.

### Config File (.claudopilot.yaml)

```yaml
version: '0.1.0'
project:
  name: my-project
  type: nextjs
  repos:
    - name: my-project
      path: .
      remote: owner/my-project
pm:
  tool: clickup
  workspaceId: '...'
  spaceId: '...'
  listId: '...'
  statuses:
    idea: idea
    planning: planning
    redTeam: red team
    blocked: blocked
    awaitingApproval: awaiting approval
    approved: approved
    building: building
    inReview: in review
    done: done
github:
  owner: my-org
  repos: [my-project]
cloudflare:
  workerName: claudopilot-webhook
  workerUrl: https://claudopilot-webhook.my-subdomain.workers.dev
redTeam:
  maxRounds: 5
  domainLenses:
    - name: E-commerce
      checks:
        - payment flow edge cases
        - inventory race conditions
        - international currency handling
```

## Red Team Domain Lenses

The red team evaluates specs through generic lenses (architecture, security, data integrity, UX) plus **domain-specific lenses** configured during init:

| Domain | Example Checks |
|--------|---------------|
| Trip planning | Timezone handling, international destinations, group conflicts, booking changes |
| E-commerce | Payment flows, inventory races, currency conversion, refund paths |
| Healthcare | HIPAA compliance, data retention, audit logging, consent management |
| Fintech | Transaction atomicity, regulatory compliance, fraud detection, precision math |
| SaaS | Multi-tenancy isolation, billing edge cases, plan limits, data export |

Users define their own lenses during init. The lenses are embedded into the generated Claude commands.

## Roadmap

### v0.1 — MVP (Current)
- [x] CLI scaffold (commander + inquirer)
- [x] ClickUp adapter (connect, validate, configure statuses, webhooks)
- [x] Project type detection (Next.js, NestJS, FastAPI, Rails)
- [x] Claude command installer (plan-feature, red-team, implement)
- [x] GitHub Actions installer (claude.yml, security-review.yml, worker.yml)
- [x] Cloudflare Worker deployment
- [x] CodeRabbit config installer
- [x] Doctor command (health checks)
- [x] Status command (pipeline view)
- [x] Config management (.claudopilot.yaml)

### v0.2 — Hardening
- [ ] ClickUp list creation (currently asks user to create manually)
- [ ] Secret management (keychain/env vars instead of yaml)
- [ ] Idempotent init (detect what's already installed, only add missing pieces)
- [ ] `claudopilot update` (update installed files to latest templates)
- [ ] Error recovery (resume init from where it failed)
- [ ] Comprehensive test suite
- [ ] Monorepo / multi-repo support (init across multiple repos)

### v0.3 — PM Adapters
- [ ] Jira adapter
- [ ] Linear adapter
- [ ] Generic webhook adapter (for unsupported PM tools)
- [ ] Status mapping (translate between PM tool status names)

### v0.4 — Enhanced Automation
- [ ] Playwright screenshot installer (per-project screenshot spec + workflow)
- [ ] Railway PR environment setup helper
- [ ] Auto-detect CI tool (GitHub Actions, GitLab CI, etc.)
- [ ] `claudopilot add-repo` for multi-repo projects
- [ ] Custom Claude command templates per project type

### v0.5 — Intelligence
- [ ] `claudopilot analyze` — scan codebase, suggest CLAUDE.md content
- [ ] `claudopilot suggest-lenses` — analyze codebase to suggest red team lenses
- [ ] Cost estimation (estimate API cost per feature based on complexity)
- [ ] Metrics dashboard (track planning rounds, red team findings, cycle time)

### v1.0 — Production
- [ ] npm publish under @buzzwordmojo/claudopilot
- [ ] npx support
- [ ] CI-friendly mode (non-interactive with env vars)
- [ ] `claudopilot teardown` (clean removal)
- [ ] Documentation site
- [ ] Example repos with claudopilot pre-configured

## Open Questions

1. **Secret storage**: API keys in .claudopilot.yaml is bad for repos. Options: system keychain, .env file (gitignored), or environment variables only. Leaning toward .env + environment variables with .claudopilot.yaml storing non-secret config only.

2. **Pricing model**: Is this open source? Freemium with a hosted Cloudflare Worker? The Cloudflare Worker is the only "hosted" piece — everything else is files installed in the user's repo.

3. **Multi-repo orchestration**: Features that span multiple repos (frontend + backend + BFF) need coordinated planning. The spec should identify affected repos, and implementation should happen in sequence. How does the worker know which repo to dispatch to?

4. **Resume across status changes**: When a task goes Blocked → Planning, Claude needs the context from the previous planning session. Options: store session ID in ClickUp custom field, or reconstruct context from the spec file + comments.

5. **Rate limiting / cost control**: Headless Claude runs can be expensive. Should claudopilot enforce a per-task cost cap? Or leave that to Anthropic's API settings?

## Competitive Landscape

- **Cursor / Windsurf**: IDE-level AI coding, no PM integration, no autonomous planning
- **GitHub Copilot Workspace**: Spec → plan → implement, but GitHub-only, no PM integration, no red team
- **Devin / SWE-agent**: Autonomous coding agents, but no PM integration, no adversarial planning loop
- **CodeRabbit**: Review-only, no planning or implementation
- **Sweep AI**: GitHub issue → PR, but no red team loop, limited PM integration

claudopilot's differentiator is the **PM-driven adversarial planning loop**. Nobody else has the red team gate before implementation.
