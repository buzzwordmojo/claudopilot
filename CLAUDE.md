# claudopilot

AI-augmented SDLC CLI tool. Bootstraps self-driving planning loops with red team agents into any project.

## Development Commands

```bash
npm run build      # Build with tsup
npm run dev        # Watch mode
npm run start      # Run CLI
npm run test       # Run tests
npm run typecheck  # TypeScript check
```

## Architecture

- `src/cli.ts` — Entry point, commander setup
- `src/commands/` — CLI commands (init, doctor, status)
- `src/adapters/` — PM tool adapters (ClickUp, future: Jira, Linear)
- `src/installers/` — File generators (Claude commands, GitHub Actions, Cloudflare Worker, CodeRabbit)
- `src/utils/` — Config management, project detection, UI helpers
- `src/types.ts` — Shared type definitions
- `templates/` — Static template files

## Adapter Pattern

PM tools implement the `PMAdapter` interface in `src/types.ts`. Currently only ClickUp. To add Jira/Linear, create a new adapter in `src/adapters/` implementing the same interface.

## Commit Convention

This project uses **conventional commits**. Every commit message MUST start with a type prefix:

| Prefix | Semver bump | Use for |
|--------|-------------|---------|
| `feat:` | minor | New features, new commands, new config options |
| `fix:` | patch | Bug fixes, correcting broken behavior |
| `perf:` | patch | Performance improvements |
| `feat!:` / `fix!:` / `BREAKING CHANGE` | major | Breaking changes to CLI, config schema, or public API |
| `chore:` | none | Deps, CI, tooling, version bumps |
| `docs:` | none | Documentation only |
| `refactor:` | none | Code changes that don't fix bugs or add features |
| `test:` | none | Adding or updating tests |
| `style:` | none | Formatting, whitespace |

A PostToolUse hook (`scripts/bump-version.sh`) auto-bumps `package.json` after each commit based on the prefix. Version bump commits (`chore: bump version to X.Y.Z`) are created automatically — do not bump manually.

Scopes are optional: `feat(init): add auto-approve setup step`

## Key Patterns

- Interactive wizard using @inquirer/prompts
- All cloud resources created programmatically (ClickUp statuses, Cloudflare Worker, GitHub webhooks)
- Config stored in `.claudopilot.yaml` in target project
- Commands are idempotent — running init again updates, doesn't duplicate
- Version is sourced from `package.json` only — `src/cli.ts` reads it at runtime via `createRequire`

## Project Context

Check `context/` for plans, decisions, and institutional knowledge:
- `context/plans/` — Roadmaps and implementation plans
- `context/memories/` — Known issues, decisions, and project context that should persist across sessions
