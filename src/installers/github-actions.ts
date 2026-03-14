import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ui } from "../utils/ui.js";
import type { GitHubConfig } from "../types.js";

export async function installGitHubActions(
  githubConfig: GitHubConfig,
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
    generateWorkerWorkflow(githubConfig)
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

function generateWorkerWorkflow(config: GitHubConfig): string {
  return `name: Claudopilot Worker
run-name: "\${{ github.event.client_payload.status }} — task \${{ github.event.client_payload.task_id }}"
on:
  repository_dispatch:
    types: [clickup-task]

permissions:
  contents: write
  pull-requests: write

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
          token: \${{ secrets.GH_PAT }}

      - name: Setup git identity
        run: |
          git config user.name "${config.commitName}"
          git config user.email "${config.commitEmail}"

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
            -d '{"comment":[{"text":"🤖 [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Planning started — architect/red team loop running..."}]}'

      - name: Plan feature
        if: github.event.client_payload.status == 'planning'
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(ARGUMENTS="\$TASK_ID" CLICKUP_API_KEY="\$CLICKUP_API_KEY" envsubst '$ARGUMENTS $CLICKUP_API_KEY' < .claude/commands/plan-feature.md)
          claude -p "\$PROMPT" \\
            --max-turns 60 \\
            --verbose \\
            --allowedTools "Read,Edit,Write,Bash(git *),Bash(curl *),mcp__clickup*"

      - name: Comment — Planning complete
        if: github.event.client_payload.status == 'planning' && success()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment":[{"text":"✅ [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Planning complete — spec ready for review."}]}'

      - name: Comment — Planning failed
        if: github.event.client_payload.status == 'planning' && failure()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment":[{"text":"❌ [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Planning failed — check GitHub Actions logs."}]}'

      - name: Comment — Implementation started
        if: github.event.client_payload.status == 'approved'
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment":[{"text":"🤖 [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Implementation started — writing tests and code..."}]}'

      - name: Setup git for commits
        if: github.event.client_payload.status == 'approved'
        run: |
          git config user.name "${config.commitName}"
          git config user.email "${config.commitEmail}"

      - name: Implement feature
        if: github.event.client_payload.status == 'approved'
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          TASK_ID: \${{ github.event.client_payload.task_id }}
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(ARGUMENTS="\$TASK_ID" CLICKUP_API_KEY="\$CLICKUP_API_KEY" envsubst '$ARGUMENTS $CLICKUP_API_KEY' < .claude/commands/implement.md)
          claude -p "\$PROMPT" \\
            --max-turns 50 \\
            --verbose \\
            --allowedTools "Read,Edit,Write,Bash,mcp__clickup*"

      - name: Wait for Vercel preview deployment
        if: github.event.client_payload.status == 'approved' && success()
        id: vercel
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
          BRANCH: claudopilot/\${{ github.event.client_payload.task_id }}
        run: |
          echo "Waiting for Vercel deployment on \$BRANCH..."
          PREVIEW_URL=""
          for i in $(seq 1 30); do
            DEPLOY=$(curl -s \\
              -H "Authorization: Bearer \$GH_TOKEN" \\
              -H "Accept: application/vnd.github+json" \\
              "https://api.github.com/repos/\${{ github.repository }}/deployments?ref=\$BRANCH&per_page=1")
            DEPLOY_ID=$(echo "\$DEPLOY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null || echo "")
            if [ -n "\$DEPLOY_ID" ]; then
              STATUS=$(curl -s \\
                -H "Authorization: Bearer \$GH_TOKEN" \\
                -H "Accept: application/vnd.github+json" \\
                "https://api.github.com/repos/\${{ github.repository }}/deployments/\$DEPLOY_ID/statuses")
              PREVIEW_URL=$(echo "\$STATUS" | python3 -c "
          import sys,json
          statuses=json.load(sys.stdin)
          for s in statuses:
              if s.get('state') == 'success' and s.get('environment_url'):
                  print(s['environment_url'])
                  break
          " 2>/dev/null || echo "")
              if [ -n "\$PREVIEW_URL" ]; then
                echo "Found preview: \$PREVIEW_URL"
                echo "preview_url=\$PREVIEW_URL" >> "\$GITHUB_OUTPUT"
                break
              fi
            fi
            echo "Attempt \$i/30 — waiting 20s..."
            sleep 20
          done
          if [ -z "\$PREVIEW_URL" ]; then
            echo "preview_url=" >> "\$GITHUB_OUTPUT"
            echo "Timed out waiting for Vercel deployment"
          fi

      - name: Comment — Implementation complete
        if: github.event.client_payload.status == 'approved' && success()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
          PREVIEW_URL: \${{ steps.vercel.outputs.preview_url }}
        run: |
          if [ -n "\$PREVIEW_URL" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment\\":[{\\"text\\":\\"✅ [CLAUDOPILOT] \\",\\"attributes\\":{\\"bold\\":true}},{\\"text\\":\\"Implementation complete — PR created.\\\\n\\\\n\\"},{\\"text\\":\\"🔗 Preview: \\",\\"attributes\\":{\\"bold\\":true}},{\\"text\\":\\"\$PREVIEW_URL\\\\n\\"}]}"
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment":[{"text":"✅ [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Implementation complete — PR created. (Preview deployment not yet available)"}]}'
          fi

      - name: Comment — Implementation failed
        if: github.event.client_payload.status == 'approved' && failure()
        env:
          TASK_ID: \${{ github.event.client_payload.task_id }}
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment":[{"text":"❌ [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Implementation failed — check GitHub Actions logs."}]}'
`;
}
