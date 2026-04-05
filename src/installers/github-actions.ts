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

  if (config.improve?.enabled) {
    await writeFile(
      join(workflowsDir, "claudopilot-improve.yml"),
      generateImproveWorkflow(config)
    );
  }

  if (config.competitors?.enabled) {
    await writeFile(
      join(workflowsDir, "claudopilot-competitors.yml"),
      generateCompetitorsWorkflow(config)
    );
  }

  if (config.dream?.enabled) {
    await writeFile(
      join(workflowsDir, "claudopilot-dream.yml"),
      generateDreamWorkflow(config)
    );
  }

  if (config.automations?.enabled) {
    await writeFile(
      join(workflowsDir, "claudopilot-automations.yml"),
      generateAutomationsWorkflow(config)
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

function generateVisualVerificationSteps(config: ClaudopilotConfig): string {
  const vv = config.visualVerification;
  if (!vv?.enabled) return "";

  const viewport = vv.viewport ?? { width: 1280, height: 720 };
  const maxScreenshots = vv.maxScreenshots ?? 10;
  const alwaysRoutes = vv.alwaysCheckRoutes?.length
    ? vv.alwaysCheckRoutes.map((r) => `"${r}"`).join(", ")
    : '"/"';

  const videoInstructions = vv.includeVideo
    ? `
    6. For the most important page (the one most affected by the changes), also record a short video:
       - Use Playwright's video recording: \`context = await browser.newContext({ recordVideo: { dir: '/tmp/screenshots/', size: { width: ${viewport.width}, height: ${viewport.height} } } })\`
       - Navigate through the page interactions (scroll, click interactive elements)
       - Close the context to finalize the video
       - Convert to GIF: \`ffmpeg -i <video.webm> -vf "fps=10,scale=${viewport.width}:-1" -loop 0 /tmp/screenshots/interaction.gif\``
    : "";

  const canVerify = "steps.check.outputs.has_commits == 'true' && steps.deployment.outputs.preview_url != ''";

  return `
      - name: Setup visual verification
        if: ${canVerify}
        run: |
          npx playwright install --with-deps chromium
          npm install -g @anthropic-ai/claude-code
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json

      - name: Visual Verification
        if: ${canVerify}
        id: visual_verify
        continue-on-error: true
        env:
          PREVIEW_URL: \${{ steps.deployment.outputs.preview_url }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          mkdir -p /tmp/screenshots
          git diff origin/main...HEAD > /tmp/pr-diff.txt

          claude -p "You are performing visual verification of a preview deployment.

          PREVIEW URL: \$PREVIEW_URL

          INSTRUCTIONS:
          1. Read /tmp/pr-diff.txt to understand what files changed in this PR.
          2. Analyze the project structure to identify the routing convention:
             - Next.js App Router: look for src/app/**/page.tsx or app/**/page.tsx
             - Next.js Pages Router: look for pages/**/*.tsx
             - Other frameworks: look for route definitions
          3. From the diff, determine which routes/pages are AFFECTED by the changes.
             Map changed files to their corresponding URL paths.
          4. Combine affected routes with these always-check routes: [${alwaysRoutes}]
             Deduplicate the list. Cap at ${maxScreenshots} total routes.
          5. Write a Node.js script at /tmp/screenshot.js using playwright that:
             - Launches chromium (headless)
             - For each route, navigates to PREVIEW_URL + route
             - Waits for networkidle
             - Takes a full-page screenshot at ${viewport.width}x${viewport.height}
             - Saves to /tmp/screenshots/ with descriptive filenames (e.g., home.png, dashboard.png)
             - Handles 404s or errors gracefully (log and continue)
             - Closes the browser when done${videoInstructions}
          6. Run the script: node /tmp/screenshot.js
          7. List what was captured: ls -la /tmp/screenshots/
          8. Write a brief summary to /tmp/screenshots/SUMMARY.md listing each route and what you observed.

          RULES:
          - Do NOT modify any project source files
          - Maximum ${maxScreenshots} screenshots
          - If a page fails to load, note it in the summary and continue
          - Focus on public-facing pages, skip admin/auth-protected routes unless they appear in always-check" \\
            --max-turns 15 \\
            --allowedTools "Read,Bash,Write" 2>&1 | tee /tmp/visual-verify.log

          SCREENSHOT_COUNT=$(ls /tmp/screenshots/*.png 2>/dev/null | wc -l)
          echo "screenshot_count=\$SCREENSHOT_COUNT" >> "\$GITHUB_OUTPUT"

      - uses: actions/upload-artifact@v4
        if: steps.visual_verify.outcome == 'success' && steps.visual_verify.outputs.screenshot_count != '0'
        with:
          name: visual-verification
          path: /tmp/screenshots/
          retention-days: 30

      - name: Post visual verification to PR
        if: steps.visual_verify.outcome == 'success' && steps.pr.outputs.pr_url != ''
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
          PR_URL: \${{ steps.pr.outputs.pr_url }}
        run: |
          PR_NUMBER=$(echo "\$PR_URL" | grep -oE '[0-9]+$')
          SCREENSHOT_COUNT=\${{ steps.visual_verify.outputs.screenshot_count }}
          RUN_URL="\$GITHUB_SERVER_URL/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"

          COMMENT="## 📸 Visual Verification\\n\\n"
          COMMENT="\${COMMENT}**\${SCREENSHOT_COUNT} screenshots captured** of affected routes.\\n\\n"

          if [ -f /tmp/screenshots/SUMMARY.md ]; then
            SUMMARY=$(cat /tmp/screenshots/SUMMARY.md)
            COMMENT="\${COMMENT}\${SUMMARY}\\n\\n"
          fi

          COMMENT="\${COMMENT}📦 [Download screenshots](\${RUN_URL}#artifacts) from workflow artifacts.\\n"
          COMMENT="\${COMMENT}\\n---\\n*Automated by claudopilot visual verification*"

          gh pr comment "\$PR_NUMBER" --body "$(echo -e "\$COMMENT")"
`;
}

function generateAuthRefreshStep(): string {
  return `
      - name: Refresh Claude credentials if needed
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          CREDS_FILE="\$HOME/.claude/.credentials.json"
          if [ ! -f "\$CREDS_FILE" ]; then
            echo "No credentials file found"
            exit 0
          fi

          # Check expiration
          EXPIRES_AT=\$(python3 -c "
          import json
          with open('\$CREDS_FILE') as f:
              creds = json.load(f)
          oauth = creds.get('claudeAiOauth', {})
          if isinstance(oauth, dict):
              print(oauth.get('expiresAt', 0))
          else:
              print(0)
          " 2>/dev/null || echo "0")

          NOW_MS=\$(python3 -c "import time; print(int(time.time() * 1000))")
          BUFFER_MS=300000  # 5 minutes

          if [ "\$EXPIRES_AT" -gt "\$((NOW_MS + BUFFER_MS))" ] 2>/dev/null; then
            echo "Token valid — expires in \$(( (EXPIRES_AT - NOW_MS) / 60000 )) minutes"
            exit 0
          fi

          echo "Token expired or expiring soon — attempting refresh..."

          # Extract refresh token
          REFRESH_TOKEN=\$(python3 -c "
          import json
          with open('\$CREDS_FILE') as f:
              creds = json.load(f)
          oauth = creds.get('claudeAiOauth', {})
          if isinstance(oauth, dict):
              print(oauth.get('refreshToken', ''))
          " 2>/dev/null || echo "")

          if [ -z "\$REFRESH_TOKEN" ]; then
            echo "::warning::No refresh token found — cannot auto-refresh"
            exit 0
          fi

          # Refresh the token
          RESPONSE=\$(curl -s -X POST "https://api.anthropic.com/v1/oauth/token" \\
            -H "Content-Type: application/json" \\
            -d "{\\"grant_type\\":\\"refresh_token\\",\\"refresh_token\\":\\"\$REFRESH_TOKEN\\"}")

          NEW_ACCESS=\$(echo "\$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('accessToken',''))" 2>/dev/null || echo "")

          if [ -z "\$NEW_ACCESS" ]; then
            echo "::warning::Token refresh failed — will attempt run with existing credentials"
            exit 0
          fi

          # Write refreshed credentials
          echo "\$RESPONSE" | python3 -c "
          import json, sys
          resp = json.load(sys.stdin)
          creds = {'claudeAiOauth': resp}
          with open('\$CREDS_FILE', 'w') as f:
              json.dump(creds, f)
          "

          # Update GitHub secret so future runs use the fresh token
          cat "\$CREDS_FILE" | gh secret set CLAUDE_LONG_LIVED_TOKEN --repo "\$GITHUB_REPOSITORY"

          echo "Token refreshed successfully"
`;
}

function generateMcpConfigStep(_config: ClaudopilotConfig): string {
  return `      - name: Inject secrets into MCP config
        run: |
          sed -i "s|\\\${CLICKUP_API_KEY}|\$CLICKUP_API_KEY|g" .mcp.json`;
}

/**
 * Generate bash curl command to move a task to "blocked" status,
 * optionally assigning the blockedAssigneeUserId if configured.
 */
function generateMoveToBlocked(config: ClaudopilotConfig): string {
  const userId = config.assignees?.blockedAssignee === "specific"
    ? config.assignees.blockedAssigneeUserId
    : undefined;

  if (userId) {
    return `curl -s -X PUT "https://api.clickup.com/api/v2/task/\\$TASK_ID" \\
              -H "Authorization: \\$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked","assignees":{"add":[${userId}]}}'`;
  }
  return `curl -s -X PUT "https://api.clickup.com/api/v2/task/\\$TASK_ID" \\
              -H "Authorization: \\$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"blocked"}'`;
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
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Run planning loop
        id: claude
        continue-on-error: true
        run: |
          set -o pipefail
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
        if: always() && steps.claude.outcome == 'failure'
        run: |
          if grep -qiE "authentication_error|token.has.expired|OAuth.token|invalid.*api.key|unauthorized|401" /tmp/claude-output.log 2>/dev/null; then
            echo "failure_reason=auth_expired" >> "\$GITHUB_OUTPUT"
          elif grep -qiE "hit your limit|rate.limit|token.limit|quota|spending.limit|capacity|too many requests|resource.exhausted|overloaded|529|account.paym|billing" /tmp/claude-output.log 2>/dev/null; then
            echo "failure_reason=token_exhausted" >> "\$GITHUB_OUTPUT"
            RESET_INFO=$(grep -oiE "resets [0-9]+[ap]m \\([A-Z]+\\)" /tmp/claude-output.log 2>/dev/null | head -1 || echo "")
            echo "reset_info=\$RESET_INFO" >> "\$GITHUB_OUTPUT"
          else
            echo "failure_reason=error" >> "\$GITHUB_OUTPUT"
          fi

      - name: Fail if Claude failed
        if: always() && steps.claude.outcome == 'failure'
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
          FAILURE="\${{ needs.plan.outputs.failure_reason }}"
          if [ "\${{ needs.plan.result }}" = "success" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"✅ [CLAUDOPILOT] Planning complete — spec ready for review."}'
            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"awaiting approval"}'
          elif [ "\$FAILURE" = "auth_expired" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"🔑 [CLAUDOPILOT] Planning failed — Claude authentication expired. Run \`claudopilot auth\` to refresh credentials, then move task back to Planning."}'
            ${generateMoveToBlocked(config)}
          elif [ "\$FAILURE" = "token_exhausted" ]; then
            RESET="\${{ needs.plan.outputs.reset_info }}"
            MSG="Planning paused — Claude token/rate limit reached."
            [ -n "\$RESET" ] && MSG="\$MSG \$RESET."
            MSG="\$MSG Move task back to Planning to resume when quota resets."
            ESCAPED_MSG=$(echo "\$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment_text\\":\\"⏸️ [CLAUDOPILOT] \$MSG\\"}"
            ${generateMoveToBlocked(config)}
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"❌ [CLAUDOPILOT] Planning failed — check GitHub Actions logs for details."}'
            ${generateMoveToBlocked(config)}
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
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Write code
        id: claude
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          set -o pipefail
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
        if: always() && steps.claude.outcome == 'failure'
        run: |
          if grep -qiE "authentication_error|token.has.expired|OAuth.token|invalid.*api.key|unauthorized|401" /tmp/claude-output.log 2>/dev/null; then
            echo "failure_reason=auth_expired" >> "\$GITHUB_OUTPUT"
          elif grep -qiE "hit your limit|rate.limit|token.limit|quota|spending.limit|capacity|too many requests|resource.exhausted|overloaded|529|account.paym|billing" /tmp/claude-output.log 2>/dev/null; then
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
    timeout-minutes: ${config.visualVerification?.enabled ? 25 : 15}${config.verify?.enabled ? `
    outputs:
      has_commits: \${{ steps.check.outputs.has_commits }}
      impl_outcome: \${{ needs.implement.outputs.outcome }}
      pr_url: \${{ steps.pr.outputs.pr_url }}` : ""}
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
${generateVisualVerificationSteps(config)}

      - name: Post results to ClickUp
        if: steps.check.outputs.has_commits == 'true'
        env:
          PR_URL: \${{ steps.pr.outputs.pr_url }}
          ALL_PRS: \${{ steps.pr.outputs.all_prs }}
          PREVIEW_URL: \${{ steps.deployment.outputs.preview_url }}
          SCREENSHOT_COUNT: \${{ steps.visual_verify.outputs.screenshot_count }}
          IMPL_OUTCOME: \${{ needs.implement.outputs.outcome }}
          FAILURE_REASON: \${{ needs.implement.outputs.failure_reason }}
          RESET_INFO: \${{ needs.implement.outputs.reset_info }}
        run: |
          if [ "\$IMPL_OUTCOME" = "success" ]; then
            MSG="Implementation complete."
            [ -n "\$ALL_PRS" ] && MSG="\$MSG\\\\n\\\\n\$ALL_PRS"
            [ -n "\$PREVIEW_URL" ] && MSG="\$MSG\\\\n🔗 Preview: \$PREVIEW_URL"
            [ -n "\$SCREENSHOT_COUNT" ] && [ "\$SCREENSHOT_COUNT" -gt 0 ] 2>/dev/null && MSG="\$MSG\\\\n📸 Visual verification: \$SCREENSHOT_COUNT screenshots captured"
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment_text\\":\\"✅ [CLAUDOPILOT] \$MSG\\"}"
${config.verify?.enabled ? `            # Verify phase enabled — do NOT move to "in review" here.
            # The verify job will handle the status transition.` : `            curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"status":"in review"}'`}
          elif [ "\$FAILURE_REASON" = "auth_expired" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"🔑 [CLAUDOPILOT] Implementation failed — Claude authentication expired. Run \`claudopilot auth\` to refresh credentials, then move task back to Approved."}'
            ${generateMoveToBlocked(config)}
          elif [ "\$FAILURE_REASON" = "token_exhausted" ]; then
            MSG="Implementation paused — Claude token/rate limit reached."
            [ -n "\$RESET_INFO" ] && MSG="\$MSG \$RESET_INFO."
            MSG="\$MSG Progress saved to branch. Move task back to Approved to resume when quota resets."
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment_text\\":\\"⏸️ [CLAUDOPILOT] \$MSG\\"}"
            ${generateMoveToBlocked(config)}
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"⏸️ [CLAUDOPILOT] Implementation paused — reached turn limit. Progress saved to branch. Move task back to Approved to continue."}'
            ${generateMoveToBlocked(config)}
          fi

${config.verify?.enabled ? `  # ═══════════════════════════════════════════
  # POST-BUILD VERIFICATION
  # ═══════════════════════════════════════════

  verify:
    if: github.event.client_payload.status == 'approved' && needs.impl-finalize.outputs.has_commits == 'true' && needs.impl-finalize.outputs.impl_outcome == 'success'
    name: 🔍 Verify PR
    needs: impl-finalize
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Post verify started comment
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"🔍 [CLAUDOPILOT] Post-build verification started — reviewing PR against quality lenses..."}'

      - uses: actions/checkout@v4
        with:
          ref: \${{ env.BRANCH }}
          fetch-depth: 0
          token: \${{ secrets.GH_PAT }}

      - name: Setup git
        run: |
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Setup Claude credentials
        run: |
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Run verify-pr
        id: verify
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          set -o pipefail
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(sed "s/\\$ARGUMENTS/\$TASK_ID/g" .claude/commands/verify-pr.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Edit,Write,Bash,mcp__clickup__clickup_get_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment" 2>&1 | tee /tmp/claude-output.log

      - name: Push any verify commits
        if: always()
        run: |
          git add -A
          git diff --cached --quiet || git commit -m "fix: add verify findings for retry"
          git push origin "\$BRANCH" 2>/dev/null || true

      - name: Handle verify crash
        if: always() && steps.verify.outcome == 'failure'
        run: |
          # On crash (not a verdict), treat as PASS with warning — don't block
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"🔍 [REVIEW] Verify agent crashed — treating as PASS with warning. Moving to in review."}'
          curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"status":"in review"}'

` : ""}${config.verify?.enabled ? `  # ═══════════════════════════════════════════
  # STANDALONE VERIFY (triggered by "verifying" status)
  # ═══════════════════════════════════════════

  verify-standalone:
    if: github.event.client_payload.status == 'verifying'
    name: 🔍 Verify PR (standalone)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Post verify started comment
        run: |
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"🔍 [CLAUDOPILOT] Post-build verification started — reviewing PR against quality lenses..."}'

      - uses: actions/checkout@v4
        with:
          ref: \${{ env.BRANCH }}
          fetch-depth: 0
          token: \${{ secrets.GH_PAT }}

      - name: Setup git
        run: |
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Setup Claude credentials
        run: |
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Run verify-pr
        id: verify
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          set -o pipefail
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(sed "s/\\$ARGUMENTS/\$TASK_ID/g" .claude/commands/verify-pr.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Edit,Write,Bash,mcp__clickup__clickup_get_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment" 2>&1 | tee /tmp/claude-output.log

      - name: Push any verify commits
        if: always()
        run: |
          git add -A
          git diff --cached --quiet || git commit -m "fix: add verify findings for retry"
          git push origin "\$BRANCH" 2>/dev/null || true

      - name: Handle verify crash
        if: always() && steps.verify.outcome == 'failure'
        run: |
          # On crash (not a verdict), treat as PASS with warning — don't block
          curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"comment_text":"🔍 [REVIEW] Verify agent crashed — treating as PASS with warning. Moving to in review."}'
          curl -s -X PUT "https://api.clickup.com/api/v2/task/\$TASK_ID" \\
            -H "Authorization: \$CLICKUP_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d '{"status":"in review"}'

` : ""}  # ═══════════════════════════════════════════
  # FIX PR FEEDBACK
  # ═══════════════════════════════════════════

  fix-feedback:
    if: github.event.client_payload.status == 'fixing'
    name: 🔧 Fix PR Feedback
    runs-on: ubuntu-latest
    timeout-minutes: 30
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

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Setup Claude credentials
        run: |
          mkdir -p ~/.claude
          echo '\${{ secrets.CLAUDE_LONG_LIVED_TOKEN }}' > ~/.claude/.credentials.json
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Collect PR feedback
        id: feedback
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
        run: |
          BRANCH="\${{ env.BRANCH }}"
          PR_NUMBER="\${{ github.event.client_payload.pr_number }}"

          # Find PR number if not provided
          if [ -z "\$PR_NUMBER" ]; then
            PR_NUMBER=$(gh pr list --head "\$BRANCH" --json number -q '.[0].number' 2>/dev/null || echo "")
          fi

          if [ -z "\$PR_NUMBER" ]; then
            echo "No PR found for branch \$BRANCH"
            echo "has_feedback=false" >> "\$GITHUB_OUTPUT"
            exit 0
          fi

          REPO="\${{ github.repository }}"

          # Fetch reviews
          REVIEWS=$(gh api "repos/\$REPO/pulls/\$PR_NUMBER/reviews" --paginate 2>/dev/null || echo "[]")

          # Fetch PR comments
          COMMENTS=$(gh api "repos/\$REPO/issues/\$PR_NUMBER/comments" --paginate 2>/dev/null || echo "[]")

          # Fetch inline review comments
          REVIEW_COMMENTS=$(gh api "repos/\$REPO/pulls/\$PR_NUMBER/comments" --paginate 2>/dev/null || echo "[]")

          # Fetch check runs
          HEAD_SHA=$(gh pr view "\$PR_NUMBER" --json headRefOid -q '.headRefOid' 2>/dev/null || echo "")
          CHECK_RUNS="[]"
          CHECK_FAILURES="[]"
          if [ -n "\$HEAD_SHA" ]; then
            CHECK_RUNS=$(gh api "repos/\$REPO/commits/\$HEAD_SHA/check-runs" --jq '.check_runs | map({name, status, conclusion, html_url})' 2>/dev/null || echo "[]")
            CHECK_FAILURES=$(gh api "repos/\$REPO/commits/\$HEAD_SHA/check-runs" --jq '[.check_runs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | {name, conclusion, html_url, output: {title: .output.title, summary: .output.summary}}]' 2>/dev/null || echo "[]")
          fi

          # Build feedback JSON
          python3 -c "
          import json, sys
          feedback = {
              'pr_number': int('\$PR_NUMBER'),
              'reviews': json.loads(''''\$REVIEWS'''),
              'comments': json.loads(''''\$COMMENTS'''),
              'review_comments': json.loads(''''\$REVIEW_COMMENTS'''),
              'check_runs': json.loads(''''\$CHECK_RUNS'''),
              'check_failures': json.loads(''''\$CHECK_FAILURES''')
          }
          with open('/tmp/pr-feedback.json', 'w') as f:
              json.dump(feedback, f, indent=2)
          # Determine if there's actionable feedback
          has = (
              len(feedback['review_comments']) > 0 or
              len(feedback['check_failures']) > 0 or
              any(r.get('state') == 'changes_requested' for r in feedback['reviews']) or
              len(feedback['comments']) > 0
          )
          print('true' if has else 'false')
          " > /tmp/has_feedback.txt

          echo "has_feedback=$(cat /tmp/has_feedback.txt)" >> "\$GITHUB_OUTPUT"

      - name: Run fix-feedback
        if: steps.feedback.outputs.has_feedback == 'true'
        id: claude
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
          MENTION_PROMPT: \${{ github.event.client_payload.mention_prompt }}
        run: |
          set -o pipefail
          export ARGUMENTS="\$TASK_ID"
          PROMPT=$(sed "s/\\$ARGUMENTS/\$TASK_ID/g" .claude/commands/fix-feedback.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Edit,Write,Bash,mcp__clickup__clickup_get_task,mcp__clickup__clickup_create_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

      - name: Detect failure reason
        id: detect
        if: always() && steps.claude.outcome == 'failure'
        run: |
          if grep -qiE "authentication_error|token.has.expired|OAuth.token|invalid.*api.key|unauthorized|401" /tmp/claude-output.log 2>/dev/null; then
            echo "failure_reason=auth_expired" >> "\$GITHUB_OUTPUT"
          elif grep -qiE "hit your limit|rate.limit|token.limit|quota|spending.limit|capacity|too many requests|resource.exhausted|overloaded|529|account.paym|billing" /tmp/claude-output.log 2>/dev/null; then
            echo "failure_reason=token_exhausted" >> "\$GITHUB_OUTPUT"
          else
            echo "failure_reason=error" >> "\$GITHUB_OUTPUT"
          fi

      - name: Push fixes
        if: steps.feedback.outputs.has_feedback == 'true'
        run: |
          git checkout -- .github/workflows/ 2>/dev/null || true
          git checkout -- .claude/commands/ 2>/dev/null || true
          git add -A
          git diff --cached --quiet || git commit -m "WIP: uncommitted feedback fixes"
          git push origin "\$BRANCH"

      - name: Post summary to ClickUp
        if: always()
        env:
          FAILURE_REASON: \${{ steps.detect.outputs.failure_reason }}
        run: |
          if [ "\${{ steps.feedback.outputs.has_feedback }}" != "true" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"🔧 [CLAUDOPILOT] No actionable PR feedback found."}'
          elif [ -f /tmp/feedback-summary.txt ]; then
            SUMMARY=$(cat /tmp/feedback-summary.txt | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '""')
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"comment_text\\":\\"🔧 [CLAUDOPILOT] PR feedback addressed:\\\\n\\\\n\$SUMMARY\\"}"
          elif [ "\$FAILURE_REASON" = "auth_expired" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"🔑 [CLAUDOPILOT] Fix feedback failed — Claude authentication expired. Run \`claudopilot auth\` to refresh credentials, then check the GitHub Actions run for details."}'
            ${generateMoveToBlocked(config)}
          elif [ "\$FAILURE_REASON" = "token_exhausted" ]; then
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"⏸️ [CLAUDOPILOT] Fix feedback paused — Claude token/rate limit reached. Check the GitHub Actions run for details."}'
            ${generateMoveToBlocked(config)}
          else
            curl -s -X POST "https://api.clickup.com/api/v2/task/\$TASK_ID/comment" \\
              -H "Authorization: \$CLICKUP_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d '{"comment_text":"❌ [CLAUDOPILOT] Fix feedback failed — check the GitHub Actions run for details."}'
            ${generateMoveToBlocked(config)}
          fi
`;
}

function generateImproveCommonSteps(config: ClaudopilotConfig): string {
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
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}`;
}

function generateImproveDetectStep(): string {
  return `      - name: Detect outcome
        id: detect
        if: always()
        run: |
          if [ "\${{ steps.claude.outcome }}" = "success" ]; then
            # Claude finished naturally — check if all lenses are done
            if [ -f /tmp/improve-state.md ]; then
              if grep -q "## Remaining Lenses" /tmp/improve-state.md 2>/dev/null && \\
                 grep -A100 "## Remaining Lenses" /tmp/improve-state.md | grep -q "^-"; then
                echo "needs_continuation=true" >> "\$GITHUB_OUTPUT"
              else
                echo "needs_continuation=false" >> "\$GITHUB_OUTPUT"
              fi
            else
              echo "needs_continuation=false" >> "\$GITHUB_OUTPUT"
            fi
          else
            # Claude was interrupted (turn limit, rate limit, or error)
            if [ -f /tmp/improve-state.md ]; then
              echo "needs_continuation=true" >> "\$GITHUB_OUTPUT"
            else
              echo "needs_continuation=false" >> "\$GITHUB_OUTPUT"
            fi
          fi

      - name: Upload improve state
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: improve-state
          path: /tmp/improve-state.md
          if-no-files-found: ignore
          overwrite: true`;
}

function generateImproveWorkflow(config: ClaudopilotConfig): string {
  const allLenses = config.improve?.lenses ?? [];
  const defaultLensesStr = allLenses.join(",");

  const scheduleBlock = config.improve?.schedule
    ? `\n  schedule:\n    - cron: "${config.improve.schedule}"`
    : "";

  const commonSteps = generateImproveCommonSteps(config);
  const detectStep = generateImproveDetectStep();

  // Generate continuation round jobs (rounds 2-5)
  const continuationRounds: string[] = [];
  for (let round = 2; round <= 5; round++) {
    const prevJob = round === 2 ? "improve" : `improve-round-${round - 1}`;

    continuationRounds.push(`
  approve-round-${round}:
    needs: ${prevJob}
    if: needs.${prevJob}.outputs.needs_continuation == 'true' && github.event_name != 'schedule'
    runs-on: ubuntu-latest
    environment: improve-continue
    steps:
      - run: echo "Round ${round} approved — continuing improve"

  auto-approve-round-${round}:
    needs: ${prevJob}
    if: needs.${prevJob}.outputs.needs_continuation == 'true' && github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Scheduled run — auto-continuing round ${round}"

  improve-round-${round}:
    needs: [approve-round-${round}, auto-approve-round-${round}]
    if: always() && (needs.approve-round-${round}.result == 'success' || needs.auto-approve-round-${round}.result == 'success')
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      needs_continuation: \${{ steps.detect.outputs.needs_continuation }}
    steps:
${commonSteps}

      - name: Download improve state
        uses: actions/download-artifact@v4
        with:
          name: improve-state
          path: /tmp

      - name: Run improve (round ${round})
        id: claude
        continue-on-error: true
        run: |
          set -o pipefail
          LENSES="\${{ github.event.inputs.lenses }}"
          [ -z "\$LENSES" ] && LENSES="${defaultLensesStr}"
          PROMPT=$(sed "s|\\$ARGUMENTS|\$LENSES|g" .claude/commands/improve.md)
          claude -p "\$PROMPT" \\
            --max-turns 20 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Write,Bash(find *),Bash(wc *),mcp__clickup__clickup_get_task,mcp__clickup__clickup_create_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

${detectStep}`);
  }

  return `name: Claudopilot Improve
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
  improve:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    outputs:
      needs_continuation: \${{ steps.detect.outputs.needs_continuation }}
    steps:
${commonSteps}

      - name: Run improve
        id: claude
        continue-on-error: true
        run: |
          set -o pipefail
          LENSES="\${{ github.event.inputs.lenses }}"
          [ -z "\$LENSES" ] && LENSES="${defaultLensesStr}"
          PROMPT=$(sed "s|\\$ARGUMENTS|\$LENSES|g" .claude/commands/improve.md)
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

env:
  CLICKUP_API_KEY: \${{ secrets.CLICKUP_API_KEY }}

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
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Run competitor analysis
        id: claude
        continue-on-error: true
        run: |
          set -o pipefail
          COMPETITORS="\${{ github.event.inputs.competitors }}"
          PROMPT=$(sed "s|\\$ARGUMENTS|\$COMPETITORS|g" .claude/commands/competitors.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,Write,Bash(mkdir *),WebSearch,WebFetch,mcp__clickup__clickup_create_task" 2>&1 | tee /tmp/claude-output.log

      - name: Commit results
        run: |
          git config user.name "${githubConfig.commitName ?? "claudopilot"}"
          git config user.email "${githubConfig.commitEmail ?? "noreply@claudopilot.dev"}"
          if [ -f context/competitors.json ]; then
            git add context/competitors.json context/competitors.md
            git diff --cached --quiet || git commit -m "chore: update competitive landscape"
            git checkout -- . 2>/dev/null || true
            git clean -fd 2>/dev/null || true
            git pull --rebase origin main
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

function generateDreamWorkflow(config: ClaudopilotConfig): string {
  const scheduleBlock = config.dream?.schedule
    ? `\n  schedule:\n    - cron: "${config.dream.schedule}"`
    : "";

  const companions = getCompanionRepos(config);
  const hasCompanions = companions.length > 0;
  const companionCheckouts = hasCompanions
    ? generateCompanionCheckoutSteps(companions, 1)
    : "";

  return `name: Claudopilot Dream
on:
  workflow_dispatch:${scheduleBlock}

permissions:
  contents: read

env:
  CLICKUP_API_KEY: \${{ secrets.CLICKUP_API_KEY }}

jobs:
  dream:
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
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Run dream engine
        id: claude
        continue-on-error: true
        run: |
          set -o pipefail
          PROMPT=$(cat .claude/commands/dream.md)
          claude -p "\$PROMPT" \\
            --max-turns 40 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,WebSearch,WebFetch,Bash(find *),Bash(wc *),mcp__clickup__clickup_get_task,mcp__clickup__clickup_create_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

      - name: Report outcome
        if: always()
        run: |
          if [ "\${{ steps.claude.outcome }}" = "success" ]; then
            echo "✅ Dream engine complete"
          else
            echo "❌ Dream engine failed — check logs"
            exit 1
          fi
`;
}

function generateAutomationsWorkflow(config: ClaudopilotConfig): string {
  const companions = getCompanionRepos(config);
  const hasCompanions = companions.length > 0;
  const companionCheckouts = hasCompanions
    ? generateCompanionCheckoutSteps(companions, 1)
    : "";

  return `name: Claudopilot Automations
on:
  repository_dispatch:
    types: [clickup-automations]

permissions:
  contents: read

env:
  CLICKUP_API_KEY: \${{ secrets.CLICKUP_API_KEY }}
  TASK_ID: \${{ github.event.client_payload.task_id }}

jobs:
  automations:
    name: "\${{ github.event.client_payload.rule_name }}"
    runs-on: ubuntu-latest
    timeout-minutes: 15
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
${generateAuthRefreshStep()}
${generateMcpConfigStep(config)}

      - name: Run automations dispatch
        id: claude
        continue-on-error: true
        env:
          AUTOMATIONS_PROMPT: \${{ github.event.client_payload.prompt }}
          RULE_NAME: \${{ github.event.client_payload.rule_name }}
          TASK_NAME: \${{ github.event.client_payload.task_name }}
        run: |
          set -o pipefail
          CONTEXT="Task ID: \$TASK_ID\\nTask Name: \$TASK_NAME\\nRule: \$RULE_NAME\\n\\n"
          FULL_PROMPT="\$CONTEXT\$AUTOMATIONS_PROMPT"
          claude -p "\$FULL_PROMPT" \\
            --max-turns 15 \\
            --verbose \\
            --mcp-config .mcp.json \\
            --allowedTools "Read,mcp__clickup__clickup_get_task,mcp__clickup__clickup_update_task,mcp__clickup__clickup_get_task_comments,mcp__clickup__clickup_create_task_comment,mcp__clickup__clickup_get_list_tasks" 2>&1 | tee /tmp/claude-output.log

      - name: Report outcome
        if: always()
        run: |
          if [ "\${{ steps.claude.outcome }}" = "success" ]; then
            echo "Automations dispatch complete (\$RULE_NAME)"
          else
            echo "Automations dispatch failed — check logs"
            exit 1
          fi
`;
}
