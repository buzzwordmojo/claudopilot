import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ui } from "../utils/ui.js";

export async function installGitHubActions(
  targetDir: string = process.cwd()
): Promise<void> {
  const workflowsDir = join(targetDir, ".github", "workflows");
  await mkdir(workflowsDir, { recursive: true });

  await writeFile(
    join(workflowsDir, "claude.yml"),
    CLAUDE_ACTION_WORKFLOW
  );

  await writeFile(
    join(workflowsDir, "security-review.yml"),
    SECURITY_REVIEW_WORKFLOW
  );

  await writeFile(
    join(workflowsDir, "claudopilot-worker.yml"),
    CLAUDOPILOT_WORKER_WORKFLOW
  );

  ui.success("GitHub Actions workflows installed in .github/workflows/");
}

const CLAUDE_ACTION_WORKFLOW = `name: Claude Code
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  claude:
    if: |
      contains(github.event.comment.body, '@claude') ||
      github.event_name == 'issues'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          claude_args: "--max-turns 10"
`;

const SECURITY_REVIEW_WORKFLOW = `name: Security Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  security:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 2
      - uses: anthropics/claude-code-security-review@main
        with:
          comment-pr: true
          claude-api-key: \${{ secrets.ANTHROPIC_API_KEY }}
`;

const CLAUDOPILOT_WORKER_WORKFLOW = `name: Claudopilot Worker
on:
  repository_dispatch:
    types: [clickup-task]

env:
  CLICKUP_API_KEY: \${{ secrets.CLICKUP_API_KEY }}

jobs:
  process:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Comment — Planning started
        if: github.event.client_payload.status == 'planning'
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"🤖 **[CLAUDOPILOT]** Planning started — architect/red team loop running..."}'

      - name: Plan feature
        if: github.event.client_payload.status == 'planning'
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(ARGUMENTS="\$TASK_ID" CLICKUP_API_KEY="\$CLICKUP_API_KEY" envsubst '$ARGUMENTS $CLICKUP_API_KEY' < .claude/commands/plan-feature.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --allowedTools "Read,Edit,Write,Bash(git *),Bash(curl *),mcp__clickup*"

      - name: Comment — Planning complete
        if: github.event.client_payload.status == 'planning' && success()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"✅ **[CLAUDOPILOT]** Planning complete — spec ready for review."}'

      - name: Comment — Planning failed
        if: github.event.client_payload.status == 'planning' && failure()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"❌ **[CLAUDOPILOT]** Planning failed — check GitHub Actions logs."}'

      - name: Comment — Implementation started
        if: github.event.client_payload.status == 'approved'
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"🤖 **[CLAUDOPILOT]** Implementation started — writing tests and code..."}'

      - name: Implement feature
        if: github.event.client_payload.status == 'approved'
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(ARGUMENTS="\$TASK_ID" CLICKUP_API_KEY="\$CLICKUP_API_KEY" envsubst '$ARGUMENTS $CLICKUP_API_KEY' < .claude/commands/implement.md)
          claude -p "\$PROMPT" \\
            --max-turns 50 \\
            --allowedTools "Read,Edit,Write,Bash,mcp__clickup*"

      - name: Comment — Implementation complete
        if: github.event.client_payload.status == 'approved' && success()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"✅ **[CLAUDOPILOT]** Implementation complete — PR created."}'

      - name: Comment — Implementation failed
        if: github.event.client_payload.status == 'approved' && failure()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"❌ **[CLAUDOPILOT]** Implementation failed — check GitHub Actions logs."}'
`;
