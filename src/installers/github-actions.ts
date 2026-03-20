import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ui } from "../utils/ui.js";
import type { ClaudopilotConfig, DeploymentConfig, RepoConfig } from "../types.js";

export async function installGitHubActions(
  config: ClaudopilotConfig,
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
    generateWorkerWorkflow(config)
  );

  if (config.brainstorm?.enabled) {
    await writeFile(
      join(workflowsDir, "claudopilot-brainstorm.yml"),
      generateBrainstormWorkflow(config)
    );
  }

  if (config.competitors?.enabled) {
    await writeFile(
      join(workflowsDir, "claudopilot-competitors.yml"),
      generateCompetitorsWorkflow(config)
    );
  }

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

function getCompanionRepos(config: ClaudopilotConfig): RepoConfig[] {
  return config.project.repos.filter(r => r.role === "companion");
}

function generateCompanionCheckoutSteps(companions: RepoConfig[], fetchDepth: number): string {
  return companions.map(c => `
      - uses: actions/checkout@v4
        with:
          repository: ${c.remote}
          path: ${c.name}
          token: \${{ secrets.GH_PAT }}
          fetch-depth: ${fetchDepth}`).join("\n");
}

function generateVercelDetectionStep(attempts: number, interval: number): string {
  return `
      - name: Wait for Vercel preview
        if: steps.check.outputs.has_commits == 'true'
        id: deployment
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          echo "Waiting for Vercel deployment on \$BRANCH..."
          PREVIEW_URL=""
          for i in $(seq 1 ${attempts}); do
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
            echo "Attempt \$i/${attempts} — waiting ${interval}s..."
            sleep ${interval}
          done`;
}

function generateRailwayDetectionStep(config: DeploymentConfig, attempts: number, interval: number): string {
  const railwayFallback = config.railwayProjectId
    ? `
            # Fallback: query Railway GraphQL API
            if [ -n "\$RAILWAY_API_TOKEN" ]; then
              RAILWAY_URL=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \\
                -H "Authorization: Bearer \$RAILWAY_API_TOKEN" \\
                -H "Content-Type: application/json" \\
                -d '{"query":"{ environments(projectId: \\"${config.railwayProjectId}\\") { edges { node { name deployments(first:1) { edges { node { staticUrl status } } } } } } }"}' \\
                | python3 -c "
          import sys,json
          data=json.load(sys.stdin).get('data',{}).get('environments',{}).get('edges',[])
          branch='\$BRANCH'.replace('claudopilot/','')
          for e in data:
              node=e.get('node',{})
              if branch.lower() in node.get('name','').lower():
                  deps=node.get('deployments',{}).get('edges',[])
                  if deps and deps[0]['node'].get('status')=='SUCCESS':
                      url=deps[0]['node'].get('staticUrl','')
                      if url:
                          print('https://'+url if not url.startswith('http') else url)
                          break
          " 2>/dev/null || echo "")
              if [ -n "\$RAILWAY_URL" ]; then
                PREVIEW_URL="\$RAILWAY_URL"
                echo "preview_url=\$PREVIEW_URL" >> "\$GITHUB_OUTPUT"
                break
              fi
            fi`
    : "";

  const envBlock = config.railwayProjectId
    ? `
          RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}`
    : "";

  return `
      - name: Wait for Railway preview
        if: steps.check.outputs.has_commits == 'true'
        id: deployment
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}${envBlock}
        run: |
          echo "Waiting for Railway deployment on \$BRANCH..."
          PREVIEW_URL=""
          for i in $(seq 1 ${attempts}); do
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
            fi${railwayFallback}
            echo "Attempt \$i/${attempts} — waiting ${interval}s..."
            sleep ${interval}
          done`;
}

function generateDeploymentDetectionStep(config: ClaudopilotConfig): string {
  const deployment = config.deployment;
  const timeout = deployment?.pollTimeout ?? 600;
  const interval = deployment?.pollInterval ?? 20;
  const attempts = Math.ceil(timeout / interval);

  if (!deployment) {
    // Backward compat: nextjs projects get Vercel detection
    if (config.project.type === "nextjs") {
      return generateVercelDetectionStep(attempts, interval);
    }
    return "";
  }

  switch (deployment.provider) {
    case "none":
      return "";
    case "vercel":
      return generateVercelDetectionStep(attempts, interval);
    case "railway":
      return generateRailwayDetectionStep(deployment, attempts, interval);
    default:
      return "";
  }
}

function generateWorkerWorkflow(config: ClaudopilotConfig): string {
  const companions = getCompanionRepos(config);
  const hasCompanions = companions.length > 0;
  const githubConfig = config.github;

  // Companion env var listing paths for Claude context
  const companionEnvVar = hasCompanions
    ? `\n  COMPANION_REPOS: "${companions.map(c => c.name).join(",")}"`
    : "";

  // Planning: checkout companions at default branch (read-only context)
  const planCompanionCheckouts = hasCompanions
    ? generateCompanionCheckoutSteps(companions, 1)
    : "";

  // impl-setup: checkout + branch each companion
  const implSetupCompanionSteps = hasCompanions
    ? companions.map(c => `
      - uses: actions/checkout@v4
        with:
          repository: ${c.remote}
          path: ${c.name}
          token: \${{ secrets.GH_PAT }}
          fetch-depth: 0

      - name: Create or resume branch (${c.name})
        run: |
          cd ${c.name}
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"
          if git fetch origin "\$BRANCH" 2>/dev/null; then
            echo "Resuming existing branch \$BRANCH in ${c.name}"
            git checkout "\$BRANCH"
          else
            echo "Creating new branch \$BRANCH in ${c.name}"
            git checkout -b "\$BRANCH"
          fi`).join("\n")
    : "";

  // implement: checkout companions at branch
  const implCompanionCheckouts = hasCompanions
    ? companions.map(c => `
      - uses: actions/checkout@v4
        with:
          repository: ${c.remote}
          ref: \${{ env.BRANCH }}
          path: ${c.name}
          token: \${{ secrets.GH_PAT }}
          fetch-depth: 0

      - name: Setup git (${c.name})
        run: |
          cd ${c.name}
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"`).join("\n")
    : "";

  // Push step: push all repos
  const companionPushCommands = hasCompanions
    ? companions.map(c => `
          # Push ${c.name}
          cd ${c.name}
          git checkout -- .github/workflows/ 2>/dev/null || true
          git add -A
          git diff --cached --quiet || git commit -m "WIP: uncommitted changes"
          git push origin "\$BRANCH" 2>/dev/null || true
          cd ..`).join("\n")
    : "";

  // Finalize: check + create PR per repo
  const implFinalizeCompanionCheckouts = hasCompanions
    ? companions.map(c => `
      - uses: actions/checkout@v4
        with:
          repository: ${c.remote}
          ref: \${{ env.BRANCH }}
          path: ${c.name}
          token: \${{ secrets.GH_PAT }}
          fetch-depth: 0`).join("\n")
    : "";

  const companionPrLogic = hasCompanions
    ? companions.map(c => `
          # Check ${c.name} for commits
          if [ -d "${c.name}" ]; then
            cd ${c.name}
            git fetch origin main 2>/dev/null || git fetch origin master 2>/dev/null || true
            DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}' || echo "main")
            C_AHEAD=$(git log "origin/\$DEFAULT_BRANCH..HEAD" --oneline 2>/dev/null | wc -l)
            if [ "\$C_AHEAD" -gt 0 ]; then
              C_PR=$(gh pr create \\
                --repo ${c.remote} \\
                --title "\$TASK_NAME" \\
                --body "## ClickUp Task
          https://app.clickup.com/t/\$TASK_ID

          ## Changes
          See task description for full spec.

          Related primary PR: \$PR_URL" \\
                --base "\$DEFAULT_BRANCH" \\
                --head "\$BRANCH" 2>&1) || C_PR=""
              [ -n "\$C_PR" ] && ALL_PRS="\$ALL_PRS\\\\n🔗 ${c.name} PR: \$C_PR"
            fi
            cd ..
          fi`).join("\n")
    : "";

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
  BRANCH: claudopilot/\${{ github.event.client_payload.task_id }}${companionEnvVar}

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
            -d '{"comment_text":"🤖 [CLAUDOPILOT] Planning started — architect/red team loop running..."}'

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
${planCompanionCheckouts}

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Setup Claude credentials
        run: |
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json

      - name: Inject secrets into MCP config
        run: |
          sed -i "s|\\\${CLICKUP_API_KEY}|\$CLICKUP_API_KEY|g" .mcp.json

      - name: Run planning loop
        id: claude
        continue-on-error: true
        run: |
          export ARGUMENTS="\$TASK_ID"
          # Substitute $ARGUMENTS in the prompt (no longer needs $CLICKUP_API_KEY — MCP handles auth)
          PROMPT=$(sed "s/\\$ARGUMENTS/\$TASK_ID/g" .claude/commands/plan-feature.md)
          claude -p "\$PROMPT" \\
            --max-turns 60 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Edit,Write,Bash(git *),Bash(gh *),mcp__clickup__clickup_get_task,mcp__clickup__clickup_create_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

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
              -d '{"comment_text":"✅ [CLAUDOPILOT] Planning complete — spec ready for review."}'
          elif [ "\${{ needs.plan.outputs.failure_reason }}" = "token_exhausted" ]; then
            RESET="\${{ needs.plan.outputs.reset_info }}"
            MSG="Planning paused — Claude token/rate limit reached."
            [ -n "\$RESET" ] && MSG="\$MSG \$RESET."
            MSG="\$MSG Move task back to Planning to resume when quota resets."
            ESCAPED_MSG=$(echo "\$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment_text\\":\\"⏸️ [CLAUDOPILOT] \$MSG\\"}"
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked"}'
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"❌ [CLAUDOPILOT] Planning failed — check GitHub Actions logs."}'
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
            -d '{"comment_text":"🤖 [CLAUDOPILOT] Implementation started — writing tests and code..."}'

      - name: Create or resume branch
        run: |
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"
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
${implSetupCompanionSteps}

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
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"
${implCompanionCheckouts}

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Setup Claude credentials
        run: |
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json

      - name: Inject secrets into MCP config
        run: |
          sed -i "s|\\\${CLICKUP_API_KEY}|\$CLICKUP_API_KEY|g" .mcp.json

      - name: Write code
        id: claude
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          export ARGUMENTS="\$TASK_ID"
          # Substitute $ARGUMENTS in the prompt (no longer needs $CLICKUP_API_KEY — MCP handles auth)
          PROMPT=$(sed "s/\\$ARGUMENTS/\$TASK_ID/g" .claude/commands/implement.md)
          claude -p "\$PROMPT" \\
            --max-turns 60 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Edit,Write,Bash,mcp__clickup__clickup_get_task,mcp__clickup__clickup_create_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

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
${companionPushCommands}

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
${implFinalizeCompanionCheckouts}

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

          ALL_PRS=""
          [ -n "\$PR_URL" ] && ALL_PRS="🔗 primary PR: \$PR_URL"
${companionPrLogic}

          echo "all_prs=\$ALL_PRS" >> "\$GITHUB_OUTPUT"

${generateDeploymentDetectionStep(config)}

      - name: Post results to ClickUp
        if: steps.check.outputs.has_commits == 'true'
        env:
          PR_URL: \${{ steps.pr.outputs.pr_url }}
          ALL_PRS: \${{ steps.pr.outputs.all_prs }}
          PREVIEW_URL: \${{ steps.deployment.outputs.preview_url }}
          IMPL_OUTCOME: \${{ needs.implement.outputs.outcome }}
          FAILURE_REASON: \${{ needs.implement.outputs.failure_reason }}
          RESET_INFO: \${{ needs.implement.outputs.reset_info }}
        run: |
          if [ "\$IMPL_OUTCOME" = "success" ]; then
            MSG="Implementation complete."
            [ -n "\$ALL_PRS" ] && MSG="\$MSG\\\\n\\\\n\$ALL_PRS"
            [ -n "\$PREVIEW_URL" ] && MSG="\$MSG\\\\n🔗 Preview: \$PREVIEW_URL"
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment_text\\":\\"✅ [CLAUDOPILOT] \$MSG\\"}"
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
              -d "{\\"comment_text\\":\\"⏸️ [CLAUDOPILOT] \$MSG\\"}"
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked"}'
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"⏸️ [CLAUDOPILOT] Implementation paused — reached turn limit. Progress saved to branch. Move task back to Approved to continue."}'
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked"}'
          fi
`;
}

function generateBrainstormCommonSteps(config: ClaudopilotConfig): string {
  const companions = getCompanionRepos(config);
  const hasCompanions = companions.length > 0;

  const companionCheckouts = hasCompanions
    ? generateCompanionCheckoutSteps(companions, 1)
    : "";

  return `      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          token: \${{ secrets.GH_PAT }}
${companionCheckouts}
      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Setup Claude credentials
        run: |
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json

      - name: Inject secrets into MCP config
        run: |
          sed -i "s|\\\${CLICKUP_API_KEY}|\$CLICKUP_API_KEY|g" .mcp.json`;
}

function generateBrainstormDetectStep(): string {
  return `      - name: Detect outcome
        id: detect
        if: always()
        run: |
          if [ "\${{ steps.claude.outcome }}" = "success" ]; then
            # Claude finished naturally — check if all lenses are done
            if [ -f /tmp/brainstorm-state.md ]; then
              if grep -q "## Remaining Lenses" /tmp/brainstorm-state.md 2>/dev/null && \\
                 grep -A100 "## Remaining Lenses" /tmp/brainstorm-state.md | grep -q "^-"; then
                echo "needs_continuation=true" >> "\$GITHUB_OUTPUT"
              else
                echo "needs_continuation=false" >> "\$GITHUB_OUTPUT"
              fi
            else
              echo "needs_continuation=false" >> "\$GITHUB_OUTPUT"
            fi
          else
            # Claude was interrupted (turn limit, rate limit, or error)
            if [ -f /tmp/brainstorm-state.md ]; then
              echo "needs_continuation=true" >> "\$GITHUB_OUTPUT"
            else
              echo "needs_continuation=false" >> "\$GITHUB_OUTPUT"
            fi
          fi

      - name: Upload brainstorm state
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: brainstorm-state
          path: /tmp/brainstorm-state.md
          if-no-files-found: ignore
          overwrite: true`;
}

function generateBrainstormWorkflow(config: ClaudopilotConfig): string {
  const allLenses = config.brainstorm?.lenses ?? [];
  const defaultLensesStr = allLenses.join(",");

  const scheduleBlock = config.brainstorm?.schedule
    ? `\n  schedule:\n    - cron: "${config.brainstorm.schedule}"`
    : "";

  const commonSteps = generateBrainstormCommonSteps(config);
  const detectStep = generateBrainstormDetectStep();

  // Generate continuation round jobs (rounds 2-5)
  const continuationRounds: string[] = [];
  for (let round = 2; round <= 5; round++) {
    const prevJob = round === 2 ? "brainstorm" : `brainstorm-round-${round - 1}`;

    continuationRounds.push(`
  approve-round-${round}:
    needs: ${prevJob}
    if: needs.${prevJob}.outputs.needs_continuation == 'true' && github.event_name != 'schedule'
    runs-on: ubuntu-latest
    environment: brainstorm-continue
    steps:
      - run: echo "Round ${round} approved — continuing brainstorm"

  auto-approve-round-${round}:
    needs: ${prevJob}
    if: needs.${prevJob}.outputs.needs_continuation == 'true' && github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Scheduled run — auto-continuing round ${round}"

  brainstorm-round-${round}:
    needs: [approve-round-${round}, auto-approve-round-${round}]
    if: always() && (needs.approve-round-${round}.result == 'success' || needs.auto-approve-round-${round}.result == 'success')
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      needs_continuation: \${{ steps.detect.outputs.needs_continuation }}
    steps:
${commonSteps}

      - name: Download brainstorm state
        uses: actions/download-artifact@v4
        with:
          name: brainstorm-state
          path: /tmp

      - name: Run brainstorm (round ${round})
        id: claude
        continue-on-error: true
        run: |
          LENSES="\${{ github.event.inputs.lenses }}"
          [ -z "\$LENSES" ] && LENSES="${defaultLensesStr}"
          PROMPT=$(sed "s|\\$ARGUMENTS|\$LENSES|g" .claude/commands/brainstorm.md)
          claude -p "\$PROMPT" \\
            --max-turns 20 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Write,Bash(find *),Bash(wc *),mcp__clickup__clickup_get_task,mcp__clickup__clickup_create_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

${detectStep}`);
  }

  return `name: Claudopilot Brainstorm
on:
  workflow_dispatch:
    inputs:
      lenses:
        description: "Comma-separated lenses (leave empty for all)"
        required: false${scheduleBlock}

permissions:
  contents: read

env:
  CLICKUP_API_KEY: \${{ secrets.CLICKUP_API_KEY }}

jobs:
  brainstorm:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      needs_continuation: \${{ steps.detect.outputs.needs_continuation }}
    steps:
${commonSteps}

      - name: Run brainstorm
        id: claude
        continue-on-error: true
        run: |
          LENSES="\${{ github.event.inputs.lenses }}"
          [ -z "\$LENSES" ] && LENSES="${defaultLensesStr}"
          PROMPT=$(sed "s|\\$ARGUMENTS|\$LENSES|g" .claude/commands/brainstorm.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Write,Bash(find *),Bash(wc *),mcp__clickup__clickup_get_task,mcp__clickup__clickup_create_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

${detectStep}
${continuationRounds.join("\n")}
`;
}

function generateCompetitorsWorkflow(config: ClaudopilotConfig): string {
  const scheduleBlock = config.competitors?.schedule
    ? `\n  schedule:\n    - cron: "${config.competitors.schedule}"`
    : "";

  const companions = getCompanionRepos(config);
  const hasCompanions = companions.length > 0;
  const companionCheckouts = hasCompanions
    ? generateCompanionCheckoutSteps(companions, 1)
    : "";
  const githubConfig = config.github;

  return `name: Claudopilot Competitors
on:
  workflow_dispatch:
    inputs:
      competitors:
        description: "Comma-separated competitor names to research (leave empty for full scan)"
        required: false${scheduleBlock}

permissions:
  contents: write

jobs:
  competitors:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          token: \${{ secrets.GH_PAT }}
${companionCheckouts}
      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Setup Claude credentials
        run: |
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json

      - name: Run competitor analysis
        id: claude
        continue-on-error: true
        run: |
          COMPETITORS="\${{ github.event.inputs.competitors }}"
          PROMPT=$(sed "s|\\$ARGUMENTS|\$COMPETITORS|g" .claude/commands/competitors.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --verbose \\
            --allowedTools "Read,Write,Bash(mkdir *),WebSearch,WebFetch" 2>&1 | tee /tmp/claude-output.log

      - name: Commit results
        run: |
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"
          if [ -f context/competitors.json ]; then
            git add context/competitors.json context/competitors.md
            git diff --cached --quiet || git commit -m "chore: update competitive landscape"
            git push
          else
            echo "No competitor data generated"
          fi

      - name: Report outcome
        if: always()
        run: |
          if [ "\${{ steps.claude.outcome }}" = "success" ]; then
            echo "✅ Competitor analysis complete"
          else
            echo "❌ Competitor analysis failed — check logs"
            exit 1
          fi
`;
}
