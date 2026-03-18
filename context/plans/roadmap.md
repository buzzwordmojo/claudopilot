# Claudopilot Roadmap

## Phase 1: Autonomous Intelligence (New Standalone Flows)

### Brainstorm / Ideation Engine
Generate improvement ideas by analyzing the target codebase across multiple lenses in parallel.

**Lenses:** code quality, UI/UX, documentation gaps, performance, security hardening, refactoring opportunities.

- New Claude command: `brainstorm.md`
- New GitHub Actions workflow trigger: `workflow_dispatch` + optional cron schedule
- Output: ClickUp tasks created with status "idea", tagged by lens category
- Inspired by Auto-Claude's ideation module (6 parallel analysis types with dedicated prompts)

### Competitor Analysis / Feature Discovery
Research competitors and surface feature gaps to steal or adapt.

- New Claude command: `competitor-scan.md`
- Input: competitor names/URLs (passed via workflow dispatch inputs)
- Flow: web research, feature matrix comparison, gap identification, priority ranking
- Output: ClickUp tasks (status "idea") with competitive context and rationale
- GitHub Actions trigger: `workflow_dispatch` with competitor list as input
- Inspired by Auto-Claude's roadmap runner with two-phase discovery + competitor analysis

### Security Audit
System-wide security check across the target project.

- New Claude command: `security-audit.md`
- Scans: secrets detection, dependency vulnerabilities, SAST findings, OWASP top 10 patterns
- GitHub Actions triggers:
  - `workflow_dispatch` (on-demand)
  - `schedule` (weekly cron)
  - As a gate in the implementation workflow (before PR creation)
- Output: GitHub issue or PR comment with findings by severity (critical/high/medium/low)
- Blocks PR creation on critical findings
- Inspired by Auto-Claude's multi-layer security scanner

## Phase 2: Pipeline Quality Gates (Enhancements to Existing Flows)

### QA Validation Agent
Validate implementation against spec acceptance criteria before creating a PR.

- New Claude command: `qa-validate.md`
- Runs after implementation, before PR creation in `claudopilot-worker.yml`
- Flow: read spec + subtasks from ClickUp, compare against actual changes, verify acceptance criteria
- On failure: post findings to ClickUp, loop back to implementation
- On pass: proceed to PR creation

### Spec Self-Critique
Add a self-critique pass to the planning loop to reduce red team round trips.

- Modification to existing `plan-feature.md` command
- After architect drafts spec, run a critique pass using extended thinking before red team
- Catches obvious gaps early, reducing average red team rounds
- Inspired by Auto-Claude's spec critic agent

### Implementation Security Gate
Integrate security audit as a mandatory step in the build pipeline.

- Modification to `claudopilot-worker.yml` implementation stage
- Run `security-audit.md` after build verification, before PR creation
- Critical findings block PR and post to ClickUp with "blocked" status
- Non-critical findings included in PR description

## Phase 3: Reporting & Visibility

### Changelog Generation
Auto-generate release notes from completed tasks.

- New Claude command: `changelog.md`
- Reads "done" tasks from ClickUp since last release tag
- Generates categorized changelog (features, fixes, improvements)
- GitHub Actions trigger: `workflow_dispatch` or on tag push
- Output: PR updating CHANGELOG.md

### PR Review with Spec Awareness
Deep PR review that understands the original planning spec.

- New Claude command: `review-pr.md`
- Fetches the spec and subtasks from ClickUp for context
- Reviews for spec-vs-implementation drift, not just code quality
- Complements CodeRabbit (which has no spec context)
- Trigger: PR opened/updated (alongside existing security-review)

## Phase 4: Developer Experience & Intelligence (Inspired by gstack)

### Persistent Browser Daemon for QA
Replace per-invocation browser launches with a persistent Chromium daemon for sub-second QA interactions.

- Bun/Node HTTP server managing a long-lived Chromium instance via Playwright
- State file (`.claudopilot/browse.json`) with pid, port, auth token
- Accessibility-tree ref system (`@e1`, `@e2`) instead of fragile CSS selectors — CSP-safe, framework-agnostic
- Idle timeout with auto-restart on next command
- Random port selection for parallel workspace support
- Integrates with QA adapters (Phase 2) as the underlying execution engine
- Inspired by gstack's browse daemon architecture (~100ms/command vs ~3s cold start)

### Design Review Quality Gate
Add a design review lane to the quality gate pipeline.

- New Claude command: `design-review.md`
- Infers design system from project CSS/Tailwind config (colors, spacing, typography, components)
- Multi-point audit: consistency, accessibility (WCAG), responsive behavior, visual hierarchy, AI slop detection
- Letter-grade scoring (A-F) per category with actionable findings
- Report-only mode (no code changes) — separate from implementation
- Optional: `design-consultation.md` for greenfield design system generation
- GitHub Actions trigger: on PR when frontend files changed
- Inspired by gstack's 80-item design audit with slop detection

### Auto-Bootstrap Test Frameworks
Detect missing test infrastructure and scaffold it automatically before running tests.

- Project type detection → select framework (vitest/jest for TS/JS, pytest for Python, etc.)
- Install dependencies, generate config, create example test
- Runs as a pre-step in `claudopilot-worker.yml` implementation stage
- Idempotent — skips if framework already configured
- Solves the known issue where implementation skips tests due to missing infrastructure
- Inspired by gstack's `/ship` auto-bootstrap pattern

### Document Sync
Auto-update project documentation after each shipped feature.

- New Claude command: `doc-sync.md`
- Reads current docs (README, ARCHITECTURE, CONTRIBUTING, CLAUDE.md, API docs)
- Cross-references against recent diff to find stale sections
- Updates only what drifted — preserves human-written prose, fixes facts
- GitHub Actions trigger: post-merge on main, or as final step in worker workflow
- Output: PR with doc updates or commit directly to main
- Inspired by gstack's `/document-release`

### Review Readiness Dashboard
Context-aware routing that determines which reviews are needed before shipping.

- Analyze PR content: backend-only? frontend-only? infra? full-stack?
- Skip irrelevant reviews (no design review for backend, no security gate for docs)
- Dashboard output in PR comment: which gates passed, which are pending, which were skipped (with reason)
- Reduces noise from one-size-fits-all red team on every PR
- Inspired by gstack's smart review routing

### LLM Judge Evals
Use an LLM to score the quality of claudopilot's own outputs.

- Evaluate: spec quality, red team thoroughness, PR descriptions, changelog entries
- Scoring dimensions: clarity, completeness, actionability
- Three test tiers: static (free, <5s), E2E (spawn real workflow, ~$3-4), LLM judge (~$0.15)
- Diff-based test selection — only run affected evals based on changed files
- Results persisted for comparison across runs
- Inspired by gstack's Sonnet-based eval and diff-aware test infrastructure

### Sprint Retrospective Generator
Auto-generate team retrospectives from PM data and git history.

- New Claude command: `retro.md`
- Pulls completed tasks from ClickUp for sprint period
- Cross-references git log for commit activity, PR merge times, review cycles
- Generates: velocity trends, shipping streaks, blockers, test health, growth areas
- GitHub Actions trigger: `workflow_dispatch` (end of sprint) or `schedule` (bi-weekly)
- Inspired by gstack's `/retro`

### Skill Template Build Pipeline
Replace static file generation with a composable template system.

- `.tmpl` files with placeholders (`{{COMMAND_REFERENCE}}`, `{{QA_METHODOLOGY}}`)
- Build step compiles templates → final output (commands, workflows, configs)
- Single source of truth for shared methodology across commands
- CI validation: `gen-templates --dry-run` + diff check for freshness
- Makes installers more maintainable as command count grows
- Inspired by gstack's gen-skill-docs pipeline

## Implementation Priority

| # | Feature | Phase | Type | Effort | Value |
|---|---------|-------|------|--------|-------|
| 1 | Brainstorm / Ideation | 1 | New flow | Medium | High |
| 2 | Security Audit | 1 | New flow | Medium | High |
| 3 | Auto-Bootstrap Test Frameworks | 4 | Enhancement | Small | High |
| 4 | Spec Self-Critique | 2 | Enhancement | Small | Medium |
| 5 | QA Validation Agent | 2 | Enhancement | Medium | High |
| 6 | Persistent Browser Daemon | 4 | New infra | Large | High |
| 7 | Design Review Quality Gate | 4 | New flow | Medium | Medium |
| 8 | Competitor Analysis | 1 | New flow | Medium | High |
| 9 | Security Gate (impl) | 2 | Enhancement | Small | High |
| 10 | Document Sync | 4 | New flow | Small | Medium |
| 11 | Review Readiness Dashboard | 4 | Enhancement | Medium | Medium |
| 12 | Changelog Generation | 3 | New flow | Small | Medium |
| 13 | Spec-Aware PR Review | 3 | New flow | Medium | Medium |
| 14 | LLM Judge Evals | 4 | New infra | Medium | Medium |
| 15 | Sprint Retro Generator | 4 | New flow | Small | Medium |
| 16 | Skill Template Pipeline | 4 | Refactor | Medium | Low |

## Architecture Notes

All new features follow existing claudopilot patterns:
- **Claude commands** go in `src/installers/claude-commands.ts` as new generator functions
- **GitHub Actions workflows** go in `src/installers/github-actions.ts` as new workflow generators
- **Init wizard** updated to configure new features (e.g., cron schedule for brainstorm, competitor list)
- **Config schema** extended in `src/types.ts` for new settings (ideation schedule, security thresholds, competitor URLs)
- **Cloudflare Worker** unchanged — new dispatch events reuse existing `repository_dispatch` pattern
