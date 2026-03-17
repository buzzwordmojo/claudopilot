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

## Implementation Priority

| # | Feature | Type | Effort | Value |
|---|---------|------|--------|-------|
| 1 | Brainstorm / Ideation | New flow | Medium | High |
| 2 | Security Audit | New flow | Medium | High |
| 3 | Spec Self-Critique | Enhancement | Small | Medium |
| 4 | QA Validation Agent | Enhancement | Medium | High |
| 5 | Competitor Analysis | New flow | Medium | High |
| 6 | Security Gate (impl) | Enhancement | Small | High |
| 7 | Changelog Generation | New flow | Small | Medium |
| 8 | Spec-Aware PR Review | New flow | Medium | Medium |

## Architecture Notes

All new features follow existing claudopilot patterns:
- **Claude commands** go in `src/installers/claude-commands.ts` as new generator functions
- **GitHub Actions workflows** go in `src/installers/github-actions.ts` as new workflow generators
- **Init wizard** updated to configure new features (e.g., cron schedule for brainstorm, competitor list)
- **Config schema** extended in `src/types.ts` for new settings (ideation schedule, security thresholds, competitor URLs)
- **Cloudflare Worker** unchanged — new dispatch events reuse existing `repository_dispatch` pattern
