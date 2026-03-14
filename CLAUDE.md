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

## Key Patterns

- Interactive wizard using @inquirer/prompts
- All cloud resources created programmatically (ClickUp statuses, Cloudflare Worker, GitHub webhooks)
- Config stored in `.claudopilot.yaml` in target project
- Commands are idempotent — running init again updates, doesn't duplicate
