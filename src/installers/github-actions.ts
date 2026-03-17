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
  const e = (s: string) => s; // no-op, keeps template readable
  // All ${{ }} and $ env refs need \$ in the template literal
  return `name: Claudopilot Worker
run-name: "\${{ github.event.client_payload.status }} — \${{ github.event.client_payload.task_name || github.event.client_payload.task_id }}"
on:
  repository_dispatch:
    types: [clickup-task]

permissions:
  contents: write
  pull-requests: write

env:
  CLICKUP_API_KEY: \${{ secrets.CLICKUP_API_KEY }}
  TASK_ID: \${{ github.event.client_payload.task_id }}
  BRANCH: claudopilot/\${{ github.event.client_payload.task_id }}

# ═══════════════════════════════════════════
# PLANNING
# ═══════════════════════════════════════════

jobs:
  plan-setup:
    if: github.event.client_payload.status == 'planning'
    name: 📋 Planning Setup
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Post started comment
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment":[{"text":"🤖 [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Planning started — architect/red team loop running..."}]}'

  plan:
    if: github.event.client_payload.status == 'planning'
    name: 🏗️ Architect / Red Team Loop
    needs: plan-setup
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      failure_reason: \${{ steps.detect.outputs.failure_reason }}
      reset_info: \${{ steps.detect.outputs.reset_info }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          token: \${{ secrets.GH_PAT }}

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Run planning loop
        id: claude
        continue-on-error: true
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}
        run: |
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(ARGUMENTS="\$TASK_ID" CLICKUP_API_KEY="\$CLICKUP_API_KEY" envsubst '\$ARGUMENTS \$CLICKUP_API_KEY' < .claude/commands/plan-feature.md)
          claude -p "\$PROMPT" \\
            --max-turns 60 \\
            --verbose \\
            --allowedTools "Read,Edit,Write,Bash(git *),Bash(curl *),mcp__clickup*" 2>&1 | tee /tmp/claude-output.log

      - name: Detect failure reason
        id: detect
        if: steps.claude.outcome == 'failure'
        run: |
          if grep -qiE "hit your limit|rate.limit|token.limit|quota|spending.limit|capacity|too many requests|resource.exhausted|overloaded|529|account.paym|billing" /tmp/claude-output.log 2>/dev/null; then
            echo "failure_reason=token_exhausted" >> "\$GITHUB_OUTPUT"
            RESET_INFO=$(grep -oiE "resets [0-9]+[ap]m \\([A-Z]+\\)" /tmp/claude-output.log 2>/dev/null | head -1 || echo "")
            echo "reset_info=\$RESET_INFO" >> "\$GITHUB_OUTPUT"
          else
            echo "failure_reason=error" >> "\$GITHUB_OUTPUT"
          fi

      - name: Fail if Claude failed
        if: steps.claude.outcome == 'failure'
        run: exit 1

  plan-complete:
    if: github.event.client_payload.status == 'planning' && always()
    name: 📋 Planning Result
    needs: plan
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Post result
        run: |
          if [ "\${{ needs.plan.result }}" = "success" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment":[{"text":"✅ [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Planning complete — spec ready for review."}]}'
          elif [ "\${{ needs.plan.outputs.failure_reason }}" = "token_exhausted" ]; then
            RESET="\${{ needs.plan.outputs.reset_info }}"
            MSG="Planning paused — Claude token/rate limit reached."
            [ -n "\$RESET" ] && MSG="\$MSG \$RESET."
            MSG="\$MSG Move task back to Planning to resume when quota resets."
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment\\":[{\\"text\\":\\"⏸️ [CLAUDOPILOT] \\",\\"attributes\\":{\\"bold\\":true}},{\\"text\\":\\"\$MSG\\"}]}"
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked"}'
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment":[{"text":"❌ [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Planning failed — check GitHub Actions logs."}]}'
          fi

  # ═══════════════════════════════════════════
  # IMPLEMENTATION
  # ═══════════════════════════════════════════

  impl-setup:
    if: github.event.client_payload.status == 'approved'
    name: 🔨 Setup Branch
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GH_PAT }}

      - name: Move to building + comment
        run: |
          curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"status":"building"}'
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment":[{"text":"🤖 [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Implementation started — writing tests and code..."}]}'

      - name: Create or resume branch
        run: |
          git config user.name "${config.commitName}"
          git config user.email "${config.commitEmail}"
          if git fetch origin "\$BRANCH" 2>/dev/null; then
            echo "Resuming existing branch \$BRANCH"
            git checkout "\$BRANCH"
            git rebase origin/main || git rebase --abort
            git push --force-with-lease origin "\$BRANCH"
          else
            echo "Creating new branch \$BRANCH"
            git checkout -b "\$BRANCH"
            git push --set-upstream origin "\$BRANCH"
          fi

  implement:
    if: github.event.client_payload.status == 'approved'
    name: 🔨 Implement Feature
    needs: impl-setup
    runs-on: ubuntu-latest
    timeout-minutes: 45
    outputs:
      outcome: \${{ steps.claude.outcome }}
      failure_reason: \${{ steps.detect.outputs.failure_reason }}
      reset_info: \${{ steps.detect.outputs.reset_info }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ env.BRANCH }}
          fetch-depth: 0
          token: \${{ secrets.GH_PAT }}

      - name: Setup git
        run: |
          git config user.name "${config.commitName}"
          git config user.email "${config.commitEmail}"

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Write code
        id: claude
        continue-on-error: true
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(ARGUMENTS="\$TASK_ID" CLICKUP_API_KEY="\$CLICKUP_API_KEY" envsubst '\$ARGUMENTS \$CLICKUP_API_KEY' < .claude/commands/implement.md)
          claude -p "\$PROMPT" \\
            --max-turns 60 \\
            --verbose \\
            --allowedTools "Read,Edit,Write,Bash,mcp__clickup*" 2>&1 | tee /tmp/claude-output.log

      - name: Detect failure reason
        id: detect
        if: steps.claude.outcome == 'failure'
        run: |
          if grep -qiE "hit your limit|rate.limit|token.limit|quota|spending.limit|capacity|too many requests|resource.exhausted|overloaded|529|account.paym|billing" /tmp/claude-output.log 2>/dev/null; then
            echo "failure_reason=token_exhausted" >> "\$GITHUB_OUTPUT"
            RESET_INFO=$(grep -oiE "resets [0-9]+[ap]m \\([A-Z]+\\)" /tmp/claude-output.log 2>/dev/null | head -1 || echo "")
            echo "reset_info=\$RESET_INFO" >> "\$GITHUB_OUTPUT"
          else
            echo "failure_reason=error" >> "\$GITHUB_OUTPUT"
          fi

      - name: Install dependencies
        run: npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts 2>/dev/null || true

      - name: Verify build
        id: verify
        continue-on-error: true
        run: |
          if grep -q '"claudopilot:verify"' package.json 2>/dev/null; then
            echo "Running claudopilot:verify..."
            npm run claudopilot:verify 2>&1 || echo "CHECKS_FAILED=true" >> "\$GITHUB_ENV"
          else
            echo "No claudopilot:verify script — falling back to tsc + lint"
            FAILED=""
            if npx tsc --version 2>/dev/null; then
              npx tsc --noEmit 2>&1 || FAILED="typecheck"
            fi
            if grep -q '"lint"' package.json 2>/dev/null; then
              npm run lint 2>&1 || FAILED="\$FAILED lint"
            fi
            [ -n "\$FAILED" ] && echo "CHECKS_FAILED=true" >> "\$GITHUB_ENV"
          fi

      - name: Fix build errors
        if: env.CHECKS_FAILED == 'true'
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}
        run: |
          echo "Build verification failed. Asking Claude to fix..."
          claude -p "The build is failing. Run the failing command(s), read the errors, and fix them. Then commit the fix." \\
            --max-turns 15 \\
            --allowedTools "Read,Edit,Write,Bash"

      - name: Push commits
        run: |
          git checkout -- .github/workflows/ 2>/dev/null || true
          git checkout -- .claude/commands/ 2>/dev/null || true
          git add -A
          git diff --cached --quiet || git commit -m "WIP: uncommitted changes"
          git push origin "\$BRANCH"

  impl-finalize:
    if: github.event.client_payload.status == 'approved' && always()
    name: 🔗 Finalize (PR + Preview)
    needs: implement
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ env.BRANCH }}
          fetch-depth: 0
          token: \${{ secrets.GH_PAT }}

      - name: Check for commits
        id: check
        run: |
          git fetch origin main
          COMMIT_COUNT=$(git log origin/main..HEAD --oneline 2>/dev/null | wc -l)
          echo "Commits ahead of main: \$COMMIT_COUNT"
          if [ "\$COMMIT_COUNT" -gt 0 ]; then
            echo "has_commits=true" >> "\$GITHUB_OUTPUT"
          else
            echo "has_commits=false" >> "\$GITHUB_OUTPUT"
          fi

      - name: Create PR
        if: steps.check.outputs.has_commits == 'true'
        id: pr
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          TASK_NAME=$(curl -s "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
            -H "Authorization: \$CLICKUP_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name','Implementation'))" 2>/dev/null || echo "Implementation")
          EXISTING=$(gh pr list --head "\$BRANCH" --json number -q '.[0].number' 2>/dev/null || echo "")
          if [ -n "\$EXISTING" ]; then
            PR_URL=$(gh pr view "\$EXISTING" --json url -q '.url')
          else
            PR_URL=$(gh pr create \\
              --title "\$TASK_NAME" \\
              --body "## ClickUp Task
          https://app.clickup.com/t/\$TASK_ID

          ## Changes
          See task description for full spec." \\
              --base main \\
              --head "\$BRANCH" 2>&1) || PR_URL=""
          fi
          echo "pr_url=\$PR_URL" >> "\$GITHUB_OUTPUT"

      - name: Wait for Vercel preview
        if: steps.check.outputs.has_commits == 'true'
        id: vercel
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
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
                echo "preview_url=\$PREVIEW_URL" >> "\$GITHUB_OUTPUT"
                break
              fi
            fi
            echo "Attempt \$i/30 — waiting 20s..."
            sleep 20
          done

      - name: Post results to ClickUp
        if: steps.check.outputs.has_commits == 'true'
        env:
          PR_URL: \${{ steps.pr.outputs.pr_url }}
          PREVIEW_URL: \${{ steps.vercel.outputs.preview_url }}
          IMPL_OUTCOME: \${{ needs.implement.outputs.outcome }}
          FAILURE_REASON: \${{ needs.implement.outputs.failure_reason }}
          RESET_INFO: \${{ needs.implement.outputs.reset_info }}
        run: |
          if [ "\$IMPL_OUTCOME" = "success" ]; then
            MSG="Implementation complete."
            [ -n "\$PR_URL" ] && MSG="\$MSG\\\\n\\\\n🔗 PR: \$PR_URL"
            [ -n "\$PREVIEW_URL" ] && MSG="\$MSG\\\\n🔗 Preview: \$PREVIEW_URL"
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment\\":[{\\"text\\":\\"✅ [CLAUDOPILOT] \\",\\"attributes\\":{\\"bold\\":true}},{\\"text\\":\\"\$MSG\\"}]}"
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"in review"}'
          elif [ "\$FAILURE_REASON" = "token_exhausted" ]; then
            MSG="Implementation paused — Claude token/rate limit reached."
            [ -n "\$RESET_INFO" ] && MSG="\$MSG \$RESET_INFO."
            MSG="\$MSG Progress saved to branch. Move task back to Approved to resume when quota resets."
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment\\":[{\\"text\\":\\"⏸️ [CLAUDOPILOT] \\",\\"attributes\\":{\\"bold\\":true}},{\\"text\\":\\"\$MSG\\"}]}"
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked"}'
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment":[{"text":"⏸️ [CLAUDOPILOT] ","attributes":{"bold":true}},{"text":"Implementation paused — reached turn limit. Progress saved to branch. Move task back to Approved to continue."}]}'
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked"}'
          fi
`;
}
