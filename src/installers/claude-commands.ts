import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClaudopilotConfig, RepoConfig, RedTeamConfig, ImproveConfig, CompetitorsConfig, DreamConfig, AssigneeConfig, AutoApproveConfig, VerifyConfig } from "../types.js";
import { DEFAULT_VERIFY_LENSES } from "../types.js";
import { ui } from "../utils/ui.js";

export async function installClaudeCommands(
  config: ClaudopilotConfig,
  targetDir: string = process.cwd()
): Promise<void> {
  const commandsDir = join(targetDir, ".claude", "commands");
  await mkdir(commandsDir, { recursive: true });

  await writeFile(
    join(commandsDir, "plan-feature.md"),
    generatePlanFeatureCommand(config)
  );

  await writeFile(
    join(commandsDir, "red-team.md"),
    generateRedTeamCommand(config)
  );

  await writeFile(
    join(commandsDir, "implement.md"),
    generateImplementCommand(config)
  );

  if (config.improve?.enabled) {
    await writeFile(
      join(commandsDir, "improve.md"),
      generateImproveCommand(config)
    );
  }

  if (config.competitors?.enabled) {
    await writeFile(
      join(commandsDir, "competitors.md"),
      generateCompetitorsCommand(config)
    );
  }

  if (config.dream?.enabled) {
    await writeFile(
      join(commandsDir, "dream.md"),
      generateDreamCommand(config)
    );
  }

  if (config.verify?.enabled) {
    await writeFile(
      join(commandsDir, "verify-pr.md"),
      generateVerifyPrCommand(config)
    );
  }

  if (config.feedback?.enabled !== false) {
    await writeFile(
      join(commandsDir, "fix-feedback.md"),
      generateFixPrFeedbackCommand(config)
    );
  }

  ui.success("Claude commands installed in .claude/commands/");
}

function getCompanionRepos(config: ClaudopilotConfig): RepoConfig[] {
  return config.project.repos.filter(r => r.role === "companion");
}

function generateMultiRepoContext(config: ClaudopilotConfig, mode: "plan" | "implement"): string {
  const companions = getCompanionRepos(config);
  if (companions.length === 0) return "";

  const primary = config.project.repos.find(r => r.role === "primary") ?? config.project.repos[0];
  const repoLines = [
    `- ${primary.name} (primary, ${primary.path}): ${primary.description || primary.type}`,
    ...companions.map(c => `- ${c.name} (companion, ${c.path}): ${c.description || c.type}`),
  ].join("\n");

  if (mode === "plan") {
    return `
MULTI-REPO PROJECT:
This project spans multiple repositories:
${repoLines}

When planning, read CLAUDE.md and source from ALL repos.
In the spec, tag each change with which repo it belongs to.
`;
  }

  return `
MULTI-REPO PROJECT:
You have write access to all repos:
${repoLines}

Commit changes to each repo separately using:
${companions.map(c => `  cd ${c.path} && git add ... && git commit ... && cd ..`).join("\n")}
Branch name is the same across all repos: claudopilot/<task-id>
`;
}

function generatePlanFeatureCommand(config: ClaudopilotConfig): string {
  const severity = config.redTeam.blockingSeverity ?? "critical";
  const domainLenses = config.redTeam.domainLenses
    .map(
      (l) =>
        `${l.name}:\n${l.checks.map((c) => `   - ${c}`).join("\n")}`
    )
    .join("\n\n");

  const multiRepoContext = generateMultiRepoContext(config, "plan");

  return `You are working on ClickUp task: $ARGUMENTS
${multiRepoContext}
First, fetch the task details using clickup_get_task with task_id "$ARGUMENTS".
Read the task name, description, and any comments to understand
what needs to be built. Also note the creator.id from the response —
you may need it later if the task gets blocked.

PRESERVE THE ORIGINAL REQUEST: Save the original task name and
description (before you modify anything). When you write the spec
file, start it with:
## Original Request
> <original task name>
>
> <original task description, or "No description provided" if empty>

This preserves what the human actually asked for.

Check if a specs/[feature-name].md file already exists for this task.
If it does, this is a CONTINUATION of a previous planning session.
Read the existing spec and fetch ClickUp comments using
clickup_get_task_comments with task_id "$ARGUMENTS" to understand what
questions were asked, what answers were given, and resume from there.

Post a comment on the task to confirm you've started using
clickup_create_task_comment with:
  task_id: "$ARGUMENTS"
  comment_text: "🏗️ [ARCHITECT] Reading task and starting planning..."
${config.assignees?.unassignOnAutoStart !== false ? `
UNASSIGN HUMANS: Before doing any planning work, unassign any current
human assignees from the task so they don't get notified on every
progress comment. Get the assignee IDs from the task details you just
fetched (look at the assignees array) and remove them using
clickup_update_task with:
  task_id: "$ARGUMENTS"
  assignees: { "rem": [<list of current assignee IDs>] }
` : ""}
You will alternate between two roles: ARCHITECT and RED TEAM.
These are adversarial. The architect wants to ship. The red
team wants to find reasons not to.

LOOP:

1. ARCHITECT: Draft or revise the spec based on the task
   description and any previous red team findings. Read
   CLAUDE.md and any architecture docs for context.
   Save spec to specs/[feature-name].md
   Post a comment to the ClickUp task summarizing the spec using
   clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🏗️ [ARCHITECT] <summary of spec>"

2. RED TEAM: Attack the spec. Be brutal. Evaluate through
   these lenses:

   Architecture:
   - Does this follow the established patterns?
   - Are we creating unnecessary coupling?
   - Will this scale?

   Data integrity:
   - What if the process fails halfway?
   - Race conditions with concurrent users?
   - Migration safety and rollback?

   Security:
   - Auth and authorization gaps
   - Input validation gaps
   - Data leakage between users or tenants

   User experience:
   - Slow or offline connections?
   - Empty states, error states, loading states?
   - Mobile behavior?

${domainLenses ? `   Domain-specific:\n${domainLenses}` : ""}

   Rate every finding as CRITICAL, HIGH, or MEDIUM.
   Findings rated ${severity.toUpperCase()} or above BLOCK the spec.
   Post a comment to the ClickUp task with findings using
   clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🔴 [RED TEAM] <findings with severity ratings>"

3. CHECK FOR NEW STAKEHOLDER INPUT:
   Before making a decision, re-fetch task comments to check for
   new human input added while you were working using
   clickup_get_task_comments with task_id "$ARGUMENTS".

   Compare against comments you've already seen. Track the count
   of comments you've read so far — any new ones are new input.

   IGNORE comments that start with [ARCHITECT], [RED TEAM],
   [CLAUDOPILOT], or [IMPLEMENT] — those are yours.

   If there ARE new human comments:
   - Read them carefully as additional requirements or clarifications
   - Post an acknowledgment using clickup_create_task_comment with
     task_id "$ARGUMENTS" and comment_text noting the new input.
   - GO TO STEP 1 to revise the spec with the new input
     (this does NOT count against the max rounds limit)

   If there are no new human comments, proceed to DECISION.

4. DECISION:
   MINIMUM ROUNDS: You MUST complete at least one full cycle
   (architect draft → red team review) before finalizing.
   If this is your first pass and the red team has not yet
   reviewed the spec, GO TO STEP 2 — do NOT skip to finalization.

   - If ANY ${severity.toUpperCase()}${severity !== "critical" ? " or above" : ""} findings exist:
     GO TO STEP 1.

   - If no blocking findings but you have QUESTIONS for
     the human (ambiguous requirements, business decisions
     you cannot make):
     a. Move the task to "blocked" using clickup_update_task with:
          task_id: "$ARGUMENTS"
          status: "blocked"
     b. Assign the right person so they get notified using
        clickup_update_task with:
          task_id: "$ARGUMENTS"
${config.assignees?.blockedAssignee === "specific" && config.assignees?.blockedAssigneeUserId
  ? `          assignees: { "add": [${config.assignees.blockedAssigneeUserId}] }`
  : `          assignees: { "add": [<creator_id from task details>] }`}
     c. THEN post questions as a ClickUp comment using
        clickup_create_task_comment with task_id "$ARGUMENTS"
        and comment_text prefixed with "❓ [BLOCKED]"
        and notify_all: true (so the assigned person gets pinged).
     d. STOP. A human will answer and move the task back to "planning",
        which will trigger a new run. The new run will read comments
        and the spec file to pick up where you left off.

   - If no blocking findings and no questions — PLANNING IS COMPLETE:

     a. FINALIZE THE SPEC: Make sure the spec file includes a section
        at the end called "## Implementation Subtasks" that breaks the
        work into discrete, ordered subtasks. Each subtask should be:
        - Small enough for a single focused implementation pass
        - Self-contained: an implementer can work from the subtask
          description alone without re-reading the full parent spec
        - Include: context, files, approach, acceptance criteria, edge cases

     b. SET TASK DESCRIPTION: Read the spec file and write it to the
        ClickUp task description using clickup_update_task with:
          task_id: "$ARGUMENTS"
          markdown_description: <contents of specs/[feature-name].md>

     c. CREATE SUBTASKS if the work involves multiple files or
        distinct concerns (skip for simple single-file fixes).
        Get the list ID from the parent task's list.id field.
        For each subtask, use clickup_create_task with:
          list_id: <list_id>
          name: "<subtask title>"
          parent: "$ARGUMENTS"
          status: "idea"
          markdown_description: "<full subtask spec>"

        Each subtask description should include:
        - Context: why this change is needed (reference the parent spec)
        - What to change: specific files, functions, components
        - How to change it: the approach, with code-level detail
        - Acceptance criteria: what "done" looks like
        - Edge cases or risks the red team identified for this piece

        The implementation agent will use each subtask's description
        as its working spec, so make them self-contained enough to
        implement without re-reading the entire parent spec.

     d. CHECK FOR AUTO-APPROVE:
${config.autoApprove?.enabled ? `        Check the task's tags (from the task details fetched in step 1).
        If the task has a tag named "${config.autoApprove.tagName}":
          - Move to "approved" using clickup_update_task with:
              task_id: "$ARGUMENTS"
              status: "approved"
          - Post comment using clickup_create_task_comment with:
              task_id: "$ARGUMENTS"
              comment_text: "✅ [ARCHITECT] Auto-approved (task tagged ${config.autoApprove.tagName}). Implementation will start automatically."
          - STOP.

        If the task does NOT have the "${config.autoApprove.tagName}" tag:` : "        Proceed to manual approval:"}
${config.assignees?.reviewerUserId ? `        - Assign reviewer using clickup_update_task with:
              task_id: "$ARGUMENTS"
              assignees: { "add": [${config.assignees.reviewerUserId}] }` : ""}
        - POST a final summary comment using clickup_create_task_comment
          with notify_all: true:
            task_id: "$ARGUMENTS"
            comment_text: "📋 [ARCHITECT] Planning complete — ready for review."
        - MOVE the task to "awaiting approval" using clickup_update_task with:
              task_id: "$ARGUMENTS"
              status: "awaiting approval"

     e. STOP.

RULES:
- CRITICAL: You MUST use the MCP tools (clickup_get_task, clickup_update_task,
  clickup_create_task_comment, etc.) to interact with ClickUp. Do NOT use curl.
- MINIMUM 1 FULL CYCLE: You must always run at least one architect
  draft AND one red team review before finalizing — even for simple
  bug fixes. No exceptions.
- TURN BUDGET: You have a limited number of tool calls. Reserve at
  least 5 turns for finalization (writing description, posting summary,
  moving status). If you are on round 3+ and have no blocking findings,
  finalize immediately rather than doing another round.
- Maximum ${config.redTeam.maxRounds} loop iterations. If still blocked
  after ${config.redTeam.maxRounds}, stop and ask for human guidance.
  Be efficient — combine your analysis.
- Each red team round must be HARDER than the last.
  Do not repeat the same findings. Go deeper.
- BLOCKING SEVERITY: ${severity.toUpperCase()} and above block progress.${severity === "critical" ? "\n  The red team must explicitly state when HIGH findings\n  are acceptable risks vs must-fix." : ""}
- Keep a running count: Round N of max ${config.redTeam.maxRounds}.
- Every comment must start with [ARCHITECT] or [RED TEAM].
- The spec file should be the FINAL CLEAN RESULT — not an
  append-only log. Each round, rewrite the spec to incorporate
  red team feedback. The ClickUp comments ARE the audit trail.
  The spec is the polished, ready-to-implement plan.
`;
}

function generateRedTeamCommand(config: ClaudopilotConfig): string {
  const severity = config.redTeam.blockingSeverity ?? "critical";
  const domainLenses = config.redTeam.domainLenses
    .map(
      (l) =>
        `**${l.name}**\n${l.checks.map((c) => `- ${c}`).join("\n")}`
    )
    .join("\n\n");

  return `Red team the following: $ARGUMENTS

You are an adversarial reviewer. Your job is to BREAK this plan.
Do not be polite. Do not hedge. Be direct about what is wrong.

Evaluate through these lenses:

**Architecture**
- Does this follow established patterns?
- Unnecessary coupling?
- Scale issues at 10x/100x?

**Data integrity**
- Partial failure scenarios?
- Race conditions?
- Migration rollback safety?

**Security**
- Auth/authz gaps?
- Input validation?
- Data leakage?

**User experience**
- Slow/offline behavior?
- Error and empty states?
- Mobile?

${domainLenses}

Blocking threshold: ${severity.toUpperCase()} and above block the spec.

Output format:
### Red Team Report
**CRITICAL** (must fix):
- ...
**HIGH** (${severity === "critical" ? "should fix" : "must fix"}):
- ...
**MEDIUM** (${severity === "medium" ? "must fix" : "consider"}):
- ...
**Suggested mitigations** for each blocking item.
`;
}

function generateImplementCommand(config: ClaudopilotConfig): string {
  const multiRepoContext = generateMultiRepoContext(config, "implement");

  return `You are implementing ClickUp task: $ARGUMENTS
${multiRepoContext}

SETUP:

1. Fetch the task details using clickup_get_task with task_id "$ARGUMENTS".
   Read the task name, description (the spec), and subtasks.

2. Move the task to "building" using clickup_update_task with:
     task_id: "$ARGUMENTS"
     status: "building"

3. Post a comment confirming you've started using
   clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🔨 [IMPLEMENT] Starting implementation. Reading spec and creating branch..."
${config.assignees?.unassignOnAutoStart !== false ? `
4. UNASSIGN HUMANS: Unassign any current human assignees from the task
   so they don't get notified on every progress comment. Get the assignee
   IDs from the task details you just fetched and remove them using
   clickup_update_task with:
     task_id: "$ARGUMENTS"
     assignees: { "rem": [<list of current assignee IDs>] }
` : ""}
5. Check if a branch already exists (this may be a RESUMPTION):
   git fetch origin claudopilot/$ARGUMENTS 2>/dev/null
   If it exists: this is a continuation. Check out the existing branch:
     git checkout claudopilot/$ARGUMENTS
   Read git log to see what's already been committed. Fetch ClickUp
   comments using clickup_get_task_comments with task_id "$ARGUMENTS"
   to see which subtasks were completed.
   Skip completed subtasks and continue from where it left off.
   If it doesn't exist: create a new branch:
     git checkout -b claudopilot/$ARGUMENTS

6. Read CLAUDE.md for project patterns and standards.

PR SCOPE — CRITICAL:

Only make changes directly required by the spec. Do NOT bundle unrelated
refactors, cleanup, or "while I'm here" improvements into the same branch.
If you notice something worth fixing (e.g., moving module-level singletons
to lazy init, renaming variables, extracting utilities), note it in a
ClickUp comment but do NOT include it in this PR. Mixed-concern PRs are
harder to review, harder to revert, and risk rejecting good feature work
over unrelated changes. One PR = one concern.

IMPLEMENTATION:

Work through the implementation subtasks from the spec IN ORDER.
Skip any subtasks that were already completed in a previous run
(check git log and ClickUp comments).
For each remaining subtask:

a. Post a comment using clickup_create_task_comment with task_id "$ARGUMENTS"
   noting which subtask you're working on.
b. Read the relevant files listed in the subtask.
c. Write failing tests first (TDD) if the project has a test framework.
d. Implement the changes following existing patterns.
e. Run any available checks:
   - Tests (npm test, pytest, etc.)
   - Lint (npm run lint, etc.)
   - Typecheck (npm run typecheck, tsc --noEmit, etc.)
   Only run checks that are defined in the project. Skip if not available.
f. Commit the subtask with a descriptive message.
g. Post a comment using clickup_create_task_comment confirming the subtask is done.
h. If the subtask exists as a ClickUp subtask, mark it done using
   clickup_update_task with:
     task_id: <subtask_id>
     status: "done"
   (Get the subtask IDs from the parent task's subtasks list
   fetched in step 1. Match by name.)

FINALIZE:

1. Push the branch:
   git push origin claudopilot/$ARGUMENTS

2. Create a pull request using gh:
   gh pr create \\
     --title "<concise title from task name>" \\
     --body "## ClickUp Task\\nhttps://app.clickup.com/t/$ARGUMENTS\\n\\n## Changes\\n<summary of what was implemented>\\n\\n## Subtasks Completed\\n<list each subtask>" \\
     --base main \\
     --head claudopilot/$ARGUMENTS

3. ${config.assignees?.reviewerUserId ? `Assign reviewer using clickup_update_task with:
     task_id: "$ARGUMENTS"
     assignees: { "add": [${config.assignees.reviewerUserId}] }

4. ` : ""}Post the PR URL as a comment using clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🔨 [IMPLEMENT] PR created: <PR_URL> — ready for review."
     notify_all: true

${config.assignees?.reviewerUserId ? "5" : "4"}. Move the task to "in review" using clickup_update_task with:
     task_id: "$ARGUMENTS"
     status: "in review"

RULES:
- CRITICAL: Use the MCP tools for all ClickUp interactions. Use Bash
  only for git commands, running tests, and creating PRs with gh.
- Follow existing code patterns. Read before you write.
- Commit after each subtask, not one giant commit at the end.
- If a test or lint fails, fix it before moving on.
- If you get stuck on a subtask, post a comment to ClickUp explaining
  the issue and continue with the next subtask.
`;
}

function generateVerifyPrCommand(config: ClaudopilotConfig): string {
  const maxRetries = config.verify?.maxRetries ?? 2;
  const maxAttempts = maxRetries + 1;
  const lenses = config.verify?.lenses ?? DEFAULT_VERIFY_LENSES;
  const lensesList = lenses.map((l) => `- ${l}`).join("\n");

  return `You are verifying a PR for ClickUp task: $ARGUMENTS

SETUP:

1. Fetch the task details and spec using clickup_get_task with task_id "$ARGUMENTS".
   Read the task name, description (the spec), and subtasks.

2. Fetch existing comments using clickup_get_task_comments with task_id "$ARGUMENTS".
   Count comments that match the pattern "[REVIEW] Attempt" to determine the
   current attempt number.

3. Post a comment using clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🔍 [REVIEW] Attempt N of ${maxAttempts} — Starting post-build verification..."
   (Replace N with the current attempt number.)

CHECKS (run all, collect results):

Configured lenses:
${lensesList}

For each lens, run the appropriate check:

1. **Build check**: Detect and run the project build command (e.g., npm run build).
   Skip if no build script exists. Result: PASS / FAIL.

2. **Typecheck**: Detect and run typecheck command (e.g., npm run typecheck, tsc --noEmit).
   Skip if no typecheck script exists. Result: PASS / FAIL.

3. **Lint check**: Detect and run lint command (e.g., npm run lint).
   Skip if no lint script exists. Result: PASS / FAIL.

4. **Test check**: Detect and run the test suite (e.g., npm test).
   Skip if no test script exists.
   IMPORTANT: If tests fail but the diff does NOT touch test files,
   classify as WARNING (not FAIL) — likely flaky tests.
   Result: PASS / FAIL / WARNING.

5. **Merge conflict check**: Run:
   git fetch origin main
   git merge-tree \$(git merge-base HEAD origin/main) HEAD origin/main
   Only FAIL if conflicts involve files this PR modified.
   Result: PASS (clean) / FAIL (conflicts in PR files) / WARNING (conflicts in other files).

6. **Spec compliance**: Read the spec from the task description. Read the diff
   (git diff origin/main...HEAD). Verify all spec requirements are implemented.
   FAIL if any requirement is missing. Result: PASS / FAIL.

7. **Scope check**: Verify no out-of-scope changes beyond what the spec requires.
   Result: PASS / WARNING (minor extras).

8. **Pattern check**: Read CLAUDE.md, verify the code follows established patterns.
   Result: PASS / WARNING (minor deviations).

9. **Security scan**: Check the diff for obvious vulnerabilities:
   - Command injection, SQL injection, XSS
   - Hardcoded secrets, API keys, passwords
   - Unsafe deserialization, path traversal
   Result: PASS / FAIL / WARNING.

EXECUTIVE OVERVIEW:

After running all checks, write a 2-4 sentence summary of what the PR does.
Read the diff and the spec — write a plain-English description of the change,
the approach taken, and notable design choices. Written for a human who hasn't
read the spec — they should understand the PR from this alone.

Also gather:
- Files changed count and list
- Lines added/removed (from git diff --stat)

CONFIDENCE RATING:

Determine the rating algorithmically based on lens results:
- 🟢 SAFE: All lenses show PASS. No WARNING or FAIL results.
- 🟡 CAUTION: All lenses show PASS or WARNING (no FAIL). At least one WARNING.
- 🔴 RISKY: Any lens shows FAIL. PR should not be merged as-is.

VERDICT:

Classify each finding as BLOCKING or WARNING:
- BLOCKING: build/type/lint/test failures, merge conflicts, missing spec requirements, security failures
- WARNING: minor pattern deviations, scope notes, flaky test suspicion

If ANY BLOCKING findings:
  1. Write structured findings to .verify-findings.md at the repo root.
     Format:
     \`\`\`markdown
     # Verify Findings
     ## Blocking Issues
     1. **<Lens>** — <description of issue and how to fix it>
     ## Warnings
     - <warning description>
     \`\`\`

  2. Post a ClickUp comment using the FAIL output format below.

  3. Check attempt count:
     - If attempt >= ${maxRetries} (max retries reached):
       a. Move task to "blocked" using clickup_update_task with:
            task_id: "$ARGUMENTS"
            status: "blocked"
       b. Assign creator using clickup_update_task with:
            task_id: "$ARGUMENTS"
            assignees: { "add": [<creator_id from task details>] }
       c. Post a comment: "🔍 [REVIEW] Max retries (${maxRetries}) reached. Moving to blocked for human review."
       d. STOP.
     - Else:
       a. Commit .verify-findings.md:
          git add .verify-findings.md && git commit -m "fix: add verify findings for retry"
       b. Push the branch:
          git push origin claudopilot/$ARGUMENTS
       c. Move task to "approved" using clickup_update_task with:
            task_id: "$ARGUMENTS"
            status: "approved"
       d. STOP. (This triggers reimplementation via the Cloudflare Worker.)

If NO blocking findings:
  1. Post a ClickUp comment using the PASS output format below.
  2. Move task to "in review" using clickup_update_task with:
       task_id: "$ARGUMENTS"
       status: "in review"

OUTPUT FORMAT — PASS:

Post as a ClickUp comment using clickup_create_task_comment with:
  task_id: "$ARGUMENTS"
  comment_text: (use the format below)

\`\`\`
🔍 [REVIEW] Attempt N — PASS

## Executive Overview
<2-4 sentence summary of what this PR does>

**Files changed:** <count> (<file list>)
**Lines:** +<added> / -<removed>

## Confidence: 🟢 SAFE
<one-line explanation>

## Lens Results
| Lens | Result | Notes |
|------|--------|-------|
| Build | ✅ Pass | — |
| Typecheck | ✅ Pass | — |
| Lint | ✅ Pass | — |
| Tests | ✅ Pass | N tests passed |
| Merge conflicts | ✅ Clean | — |
| Spec compliance | ✅ Complete | All N requirements implemented |
| Scope | ✅ On target | — |
| Patterns | ✅ Consistent | — |
| Security | ✅ Clean | No issues found |

## Warnings
- (none, or minor items)
\`\`\`

OUTPUT FORMAT — FAIL:

Post as a ClickUp comment using clickup_create_task_comment with:
  task_id: "$ARGUMENTS"
  comment_text: (use the format below)

\`\`\`
🔍 [REVIEW] Attempt N of ${maxAttempts} — FAIL

## Executive Overview
<2-4 sentence summary of what the PR attempts to do>

**Files changed:** <count> (<file list>)
**Lines:** +<added> / -<removed>

## Confidence: 🔴 RISKY (or 🟡 CAUTION if only warnings)
<N blocking issues found. Brief description.>

## Lens Results
| Lens | Result | Notes |
|------|--------|-------|
| Build | ❌ FAIL / ✅ Pass | <notes> |
| Typecheck | ❌ FAIL / ✅ Pass | <notes> |
| ... | ... | ... |

## Blocking Issues
1. **<Lens>** — <description>
2. **<Lens>** — <description>

## Warnings
- <warning description>
\`\`\`

If more than 10 blocking issues or 5 warnings exist, truncate to those limits
and append: "N more findings — see .verify-findings.md on the branch for the full list."

EDGE CASES:
- No build/test/lint scripts: Skip those checks. Only run diff-based lenses.
  Confidence can still be SAFE if diff-based lenses pass.
- Flaky tests: If tests fail but diff doesn't touch test files, classify as
  WARNING not BLOCKING. Confidence becomes CAUTION.
- Large diffs (50+ files): Focus on spec-mentioned files. Confidence becomes
  CAUTION due to review scope limitation.
- Branch conflicts: Only FAIL on conflicts in PR-modified files.
- Spec gaps: PASS with WARNING, don't send back with unclear instructions.
- If this command crashes (non-zero exit, not a verdict): The workflow treats
  it as PASS with warning — don't block on infrastructure failures.

RULES:
- CRITICAL: Use the MCP tools (clickup_get_task, clickup_update_task,
  clickup_create_task_comment, clickup_get_task_comments) for all ClickUp
  interactions. Do NOT use curl.
- Run ALL lenses before making a verdict. Don't short-circuit on the first failure.
- The confidence rating is derived PURELY from lens result icons (❌/⚠️/✅) —
  not from LLM judgment. This makes it deterministic and predictable.
- Be specific in findings — include file paths, line numbers, and fix suggestions.
`;
}

function generateImproveCommand(config: ClaudopilotConfig): string {
  const lenses = config.improve?.lenses ?? [];
  const lensesList = lenses.map((l) => `- ${l}`).join("\n");
  const listId = config.pm.listId ?? "<LIST_ID>";
  const ideaStatus = config.pm.statuses.idea ?? "idea";

  return `You are running the claudopilot improve engine.

YOUR ROLE: You are a senior engineer conducting a structured codebase audit.
Find opportunities the CODE REVEALS — not strategic wishes. Every idea must
be grounded in specific files, functions, or patterns you actually read.

ARGUMENTS: $ARGUMENTS
(If ARGUMENTS is non-empty, it is a comma-separated list of lenses to focus on.
 If empty, use ALL configured lenses below.)

CONFIGURED LENSES:
${lensesList}

═══════════════════════════════════════
STATE FILE (continuation support)
═══════════════════════════════════════

Before starting, check if /tmp/improve-state.md exists.

If it DOES exist, you are CONTINUING a previous round. Read it to understand:
- Which lenses are already completed (skip them entirely)
- Draft ideas not yet created as ClickUp tasks (create them FIRST)
- Which lens was in progress (resume analysis there)
- Which lenses remain (analyze those next)

If it does NOT exist, this is a fresh run. Start from Phase 0.

PROGRESS SAVING (critical — do this after EVERY lens):
After completing analysis for each lens, update /tmp/improve-state.md with
your findings and draft ideas. This file is your checkpoint — if you run out
of turns, the next round will read it to continue.

Write draft ideas to the state file BEFORE creating ClickUp tasks. This way,
if you run out of turns during task creation, the next round can create the
remaining tasks without re-analyzing code.

State file format:
\`\`\`markdown
# Improve State

## Completed Lenses
- <lens name> (<N> ideas generated, <M> tasks created)

## Draft Ideas (not yet created as tasks)
### <lens name>
1. **<idea title>** — <brief description>
   Files: <affected files>
   Effort: <trivial|small|medium|large>

## In Progress
- Currently analyzing: <lens name>
- Files read so far: [<list>]

## Remaining Lenses
- <lens name>
- <lens name>
\`\`\`

═══════════════════════════════════════
PHASE 0: LOAD CONTEXT
═══════════════════════════════════════

1. Read CLAUDE.md and understand the project structure, patterns, and conventions.

2. Survey the codebase structure — read key directories, entry points, and
   config files to build a mental model of the architecture.

3. Fetch existing tasks from ClickUp to avoid duplicates using
   clickup_get_list_tasks with:
     list_id: "${listId}"
     include_closed: true
   Build a list of existing task names/descriptions. You MUST NOT suggest
   anything that overlaps with an existing task.

═══════════════════════════════════════
PHASE 1: DEEP ANALYSIS (per lens)
═══════════════════════════════════════

For each lens (filtered by ARGUMENTS if provided), systematically analyze
the codebase. Read actual source files — do not guess from file names alone.

IMPORTANT: Update /tmp/improve-state.md to mark this lens as "In Progress"
before you start reading files.

For each lens, look for these opportunity categories:
- **Pattern extensions**: A pattern exists in one place but could be applied elsewhere
- **Architecture gaps**: Data models or infrastructure that support capabilities not yet built
- **Configuration opportunities**: Hard-coded values that should be configurable
- **Missing states**: Error handling, loading states, empty states, edge cases
- **Existing code that reveals need**: TODOs, workarounds, commented-out code, suppressed warnings

═══════════════════════════════════════
PHASE 2: GENERATE IDEAS
═══════════════════════════════════════

For each lens, identify 2-5 concrete ideas. Write ALL draft ideas to
/tmp/improve-state.md under "Draft Ideas" BEFORE creating any ClickUp tasks.
Then move to Phase 3 to create the tasks.

Each idea MUST have:

1. **Specific title**: Describes the change, not the problem.
   Good: "Add input validation to user registration endpoint"
   Bad: "Improve input validation"

2. **Rationale**: Why the code reveals this opportunity — reference the
   specific file/function/pattern that shows it's needed.

3. **Implementation approach**: How to do it, referencing existing patterns
   in the codebase that can be followed or extended.

4. **Affected files**: List every file that would need changes.

5. **Estimated effort**:
   - trivial (1-2 hrs): Direct copy of existing pattern with minor changes
   - small (< 1 day): Clear pattern exists, some new logic needed
   - medium (1-3 days): Pattern exists but needs adaptation
   - large (3+ days): Significant new work, but architecture supports it

═══════════════════════════════════════
PHASE 3: CREATE CLICKUP TASKS
═══════════════════════════════════════

For each validated idea (including any draft ideas from the state file that
haven't been created yet), create a ClickUp task using clickup_create_task with:
  list_id: "${listId}"
  name: "<clean, specific title>"
  status: "${ideaStatus}"
  tags: ["ai-generated", "<lens-tag>"]
  markdown_description: "<description — see format below>"

Task description format:
\`\`\`
<What this change does — 1-2 sentences>

**Rationale:** <Why the code reveals this opportunity. Reference specific
files/functions/patterns.>

**Suggested approach:** <How to implement, referencing existing patterns>

**Files involved:**
- \`path/to/file1.ts\`
- \`path/to/file2.ts\`

**Existing patterns to follow:** <Reference similar implementations in
the codebase that can serve as a template>

**Estimated effort:** <trivial|small|medium|large>

---
*Generated by claudopilot improve engine*
\`\`\`

Lens tag mapping (use these as the second tag):
- code quality → \`code-quality\`
- UI/UX improvements → \`ux\`
- documentation gaps → \`docs\`
- performance optimization → \`performance\`
- security hardening → \`security\`
- refactoring opportunities → \`refactoring\`
- For custom lenses, slugify the name (lowercase, hyphens).

After creating each task, update /tmp/improve-state.md:
- Move the idea from "Draft Ideas" to the "Completed Lenses" section
- Record the ClickUp task ID next to the idea

═══════════════════════════════════════
PHASE 4: SUMMARY
═══════════════════════════════════════

Output a summary listing:
- Total ideas generated per lens
- Each task title and its ClickUp task ID
- Any lenses that had no actionable ideas (and why)

═══════════════════════════════════════
RULES
═══════════════════════════════════════

- TURN BUDGET: You have a limited number of tool calls. Track how many turns
  you have used. When you have 2 turns remaining, STOP what you are doing and
  immediately write /tmp/improve-state.md with everything you have learned
  so far — completed lenses, draft ideas, files read, current analysis state.
  This is more important than creating ClickUp tasks. Tasks can be created in
  the next round; lost analysis cannot be recovered.
- CRITICAL: Use the MCP tools (clickup_create_task, clickup_get_list_tasks)
  for all ClickUp interactions. Do NOT use curl.
- Every task MUST include the \`ai-generated\` tag — this is how humans
  identify AI-generated ideas on the ClickUp board.
- Task titles stay clean — NO [AI] prefix. Tags handle identification.
- ONLY suggest ideas grounded in code you actually read. No speculative
  "you should probably add..." suggestions.
- Each idea MUST reference specific files, functions, or patterns.
- Don't suggest things already being tracked (you checked in Phase 0).
- Validate before creating: if you can't point to the specific code that
  reveals the opportunity, drop the idea.
- Description must end with: "---\\n*Generated by claudopilot improve engine*"
`;
}

function generateCompetitorsCommand(config: ClaudopilotConfig): string {
  const cc = config.competitors!;
  const listId = config.pm.listId ?? "<LIST_ID>";
  const knownList = cc.known && cc.known.length > 0
    ? `\nKNOWN COMPETITORS (start here, then discover more):\n${cc.known.map(c => `- ${c}`).join("\n")}\n`
    : "";

  return `You are running the claudopilot competitive intelligence engine.

YOUR ROLE: You are a market analyst and product researcher. Your job is to
discover, profile, and track competitors in this project's space — then
persist a structured dossier that other workflows can reference.

ARGUMENTS: $ARGUMENTS
(If ARGUMENTS is non-empty, it is a comma-separated list of specific
competitors to research. If empty, do a full scan.)

═══════════════════════════════════════
PROJECT CONTEXT
═══════════════════════════════════════

Project description: ${cc.projectDescription}
Target users: ${cc.targetUsers}
Search terms: ${cc.searchTerms.join(", ")}
${cc.domain ? `Competitive domain: ${cc.domain}` : ""}
${knownList}
═══════════════════════════════════════
PHASE 0: LOAD EXISTING STATE
═══════════════════════════════════════

1. Read CLAUDE.md and README.md (if present) to understand what this
   project does — its features, architecture, and value proposition.
   This is your baseline for comparison.

2. Check if context/competitors.json exists.
   - If it DOES: this is a REFRESH. Load it, note the lastUpdated date,
     and focus on what has CHANGED since then. You do NOT need to
     re-research unchanged information — just verify it's still accurate
     and look for updates (new features, pricing changes, new entrants).
   - If it does NOT: this is a first run. Full discovery.

═══════════════════════════════════════
PHASE 1: DISCOVER COMPETITORS
═══════════════════════════════════════

Use WebSearch to find competitors. Search strategies:
- Search each configured search term
- Search "[project type] alternatives"
- Search "best [domain] tools [current year]"
- Search "competitor comparison [domain]"
- Look at GitHub topics, awesome lists, and comparison sites

If ARGUMENTS specified specific competitors, research only those.
Otherwise, aim to identify 5-10 relevant competitors.

For each candidate, verify it actually competes in the same space.
Discard false positives (e.g., same name but different domain).

═══════════════════════════════════════
PHASE 2: PROFILE EACH COMPETITOR
═══════════════════════════════════════

For each confirmed competitor, use WebSearch and WebFetch to research:

1. **Identity**: name, URL, tagline/positioning statement
2. **Product**: key features list (be specific — not "AI features" but
   "inline code completions, chat-based refactoring, agent mode")
3. **Pricing**: free tier? pricing model? price points?
4. **Target audience**: who are they building for?
5. **Tech details**: open source? what stack? integrations?
6. **Traction signals**: GitHub stars (if OSS), notable customers,
   funding, team size — whatever is publicly available
7. **Recent activity** (last ~90 days): check their blog, changelog,
   release notes, Twitter/X, GitHub releases for recent developments
8. **Strengths**: what do they do well relative to this project?
9. **Weaknesses**: where do they fall short? What do users complain about?
   Check Reddit, GitHub issues, app store reviews, HN threads.

IMPORTANT: Be specific and factual. Cite sources. Don't speculate —
if you can't find pricing info, say "not publicly listed" rather than
guessing.

═══════════════════════════════════════
PHASE 3: DIFF AGAINST PREVIOUS
═══════════════════════════════════════

If context/competitors.json existed (refresh mode):
- Flag NEW competitors not in the previous file
- Flag REMOVED competitors (acquired, shut down, pivoted away)
- For existing competitors, diff each field and note changes:
  new features, pricing changes, positioning shifts, recent launches
- Add each change to the changelog array with today's date

If this is a first run, skip this phase.

═══════════════════════════════════════
PHASE 4: WRITE OUTPUT
═══════════════════════════════════════

1. Write context/competitors.json with this structure:

\`\`\`json
{
  "lastUpdated": "YYYY-MM-DD",
  "projectDescription": "${cc.projectDescription}",
  "domain": "<competitive domain label>",
  "competitors": [
    {
      "name": "<name>",
      "url": "<url>",
      "tagline": "<their positioning>",
      "features": ["<specific feature 1>", "<specific feature 2>"],
      "pricing": "<pricing summary>",
      "targetAudience": "<who they target>",
      "techDetails": "<open source? stack? integrations?>",
      "tractionSignals": "<stars, funding, customers>",
      "recentChanges": [
        { "date": "YYYY-MM", "change": "<what changed>" }
      ],
      "strengths": ["<strength vs this project>"],
      "weaknesses": ["<weakness vs this project>"],
      "sources": ["<URLs you referenced>"]
    }
  ],
  "changelog": [
    { "date": "YYYY-MM-DD", "entry": "<what changed in the landscape>" }
  ],
  "gaps": [
    "<thing competitors offer that this project doesn't>",
    "<underserved niche none of them address well>"
  ]
}
\`\`\`

2. Write context/competitors.md — a human-readable summary:

\`\`\`markdown
# Competitive Landscape

Last updated: YYYY-MM-DD

## Summary
<2-3 sentence overview of the competitive landscape>

## Competitors

### <Competitor Name>
**URL:** <url>
**Tagline:** <tagline>
**Key features:** <bullet list>
**Pricing:** <summary>
**Recent activity:** <notable recent changes>
**vs this project:** <how they compare — strengths and weaknesses>

(repeat for each)

## Market Gaps & Opportunities
<bullet list of gaps identified — things competitors miss or do poorly>

## Changes Since Last Run
<bullet list of what changed, or "First run" if new>
\`\`\`

═══════════════════════════════════════
PHASE 5: CREATE CLICKUP CARD
═══════════════════════════════════════

Create a ClickUp task as a dated record of this analysis using
clickup_create_task with:
  list_id: "${listId}"
  name: "Competitive Analysis — YYYY-MM-DD"
  status: "done"
  tags: ["competitive-analysis"]
  markdown_description: <see format below>

The task description should contain a concise summary of findings:

\`\`\`markdown
# Competitive Analysis — YYYY-MM-DD

## Competitors Profiled
<For each competitor, one line: **Name** — tagline (key differentiator)>

## Key Findings
<3-5 bullet points: most important insights from this run>

## Market Gaps & Opportunities
<bullet list from the gaps array in competitors.json>

## Changes Since Last Run
<bullet list of what changed, or "First run — initial scan" if new>

---
*Full details: context/competitors.json and context/competitors.md*
\`\`\`

IMPORTANT: This task is a REFERENCE CARD only. It uses status "done" and
tag "competitive-analysis" so the claudopilot worker workflow will never
act on it. It exists for visibility on the board and to be manually
moved/referenced later.

═══════════════════════════════════════
PHASE 6: SUMMARY
═══════════════════════════════════════

Output a brief summary:
- How many competitors profiled (new vs updated)
- Key changes since last run (if refresh)
- Top 3 gaps/opportunities worth exploring
- The ClickUp task ID created

═══════════════════════════════════════
RULES
═══════════════════════════════════════

- CRITICAL: Use the MCP tools (clickup_create_task) for ClickUp. Do NOT use curl.
- Use WebSearch and WebFetch for all research. Do NOT fabricate information.
- Every claim must be verifiable — include source URLs.
- If you cannot find information about a field, say so explicitly rather
  than guessing. "Pricing not publicly listed" is better than a guess.
- Focus on FACTS, not opinions. Strengths/weaknesses should be grounded
  in observable features, user feedback, or market positioning.
- Keep the JSON valid and parseable. Use arrays for multi-value fields.
- Create the context/ directory if it doesn't exist.
- On refresh runs, preserve competitor entries that you couldn't verify
  as gone — mark them with a note rather than deleting.
`;
}

function generateDreamCommand(config: ClaudopilotConfig): string {
  const listId = config.pm.listId ?? "<LIST_ID>";
  const ideaStatus = config.pm.statuses.idea ?? "idea";
  const cc = config.competitors;

  const competitorsContext = cc?.enabled
    ? `
COMPETITOR DATA:
This project has competitor tracking enabled. Read context/competitors.json
for detailed competitor profiles including their features, pricing, strengths,
weaknesses, and market gaps. This is your PRIMARY input for ideation.

If context/competitors.json does not exist, note this in your output and
suggest running the competitors workflow first. You can still generate ideas
from the codebase and web research, but the output will be less targeted.
`
    : `
NOTE: Competitor tracking is not configured for this project. You will need
to do your own web research to understand the competitive landscape. Consider
suggesting that the team enable competitor tracking for better results.
`;

  return `You are running the claudopilot dream engine.

YOUR ROLE: You are a product strategist. Your job is to imagine features
worth building — informed by what competitors offer, what gaps exist in
the market, and what this project's architecture makes possible.

This is STRATEGIC ideation, not tactical code improvement. You are asking
"what should we BUILD?" not "what should we FIX?"

═══════════════════════════════════════
PHASE 0: GATHER CONTEXT
═══════════════════════════════════════

1. Read CLAUDE.md and README.md to understand what this project does,
   its architecture, and its current feature set.

2. Survey the codebase structure — read key directories, entry points,
   and config files to understand what capabilities already exist.
${competitorsContext}
3. Fetch existing tasks from ClickUp to avoid duplicating ideas using
   clickup_get_list_tasks with:
     list_id: "${listId}"
     include_closed: true
   Build a list of existing task names/descriptions. Do NOT suggest
   anything that overlaps with an existing task.

═══════════════════════════════════════
PHASE 1: IDENTIFY OPPORTUNITIES
═══════════════════════════════════════

Analyze from these angles:

**Competitive gaps** (if competitor data available):
- Features competitors have that this project lacks — which are worth adding?
- Weaknesses competitors have — where can this project leapfrog them?
- Underserved niches no competitor addresses well

**Market opportunities** (use WebSearch):
- What are users in this space asking for? Check Reddit, forums, social media
- What trends are emerging in this domain?
- What adjacent capabilities would make this project stickier?

**Architecture-enabled features**:
- What does the existing tech stack make easy to build?
- What data does the project already have that could power new features?
- What integrations would multiply value?

**User experience gaps**:
- What's the onboarding experience missing?
- What would make power users more productive?
- What would make the product shareable/viral?

═══════════════════════════════════════
PHASE 2: GENERATE IDEAS
═══════════════════════════════════════

Generate 5-10 feature ideas. Each idea MUST have:

1. **Title**: Describes the feature, not the problem.
   Good: "AI-powered weekly digest email with personalized highlights"
   Bad: "Better notifications"

2. **Strategic rationale**: WHY this feature matters — reference
   competitive gaps, user needs, or market trends. Cite sources.

3. **What it does**: 2-3 sentence description of the user experience.

4. **Competitive advantage**: How this positions the project vs competitors.
   Reference specific competitors by name if data is available.

5. **Implementation feasibility**: What existing architecture/data/patterns
   make this buildable? What's the rough effort?
   - quick win (< 1 week): Uses existing infrastructure with minimal new work
   - medium (1-3 weeks): Requires new components but fits existing patterns
   - large (3+ weeks): Significant new infrastructure or external integrations

6. **Impact estimate**: low / medium / high — based on how many users
   it affects and how much value it adds.

Prioritize ideas that are HIGH impact + use existing architecture.
Don't suggest features that require a complete pivot.

═══════════════════════════════════════
PHASE 3: CREATE CLICKUP TASKS
═══════════════════════════════════════

For each idea, create a ClickUp task using clickup_create_task with:
  list_id: "${listId}"
  name: "<clean, specific feature title>"
  status: "${ideaStatus}"
  tags: ["dream", "ai-generated"]
  markdown_description: <see format below>

Task description format:
\`\`\`
<What this feature does — 2-3 sentences describing the user experience>

**Strategic rationale:** <Why this matters. Reference competitive gaps,
user needs, or market trends. Cite sources.>

**Competitive advantage:** <How this positions us vs competitors.
Name specific competitors if data available.>

**Implementation approach:** <How to build it using existing architecture.
Reference specific files/patterns/infrastructure.>

**Feasibility:** <quick win | medium | large>
**Impact:** <low | medium | high>

---
*Generated by claudopilot dream engine*
\`\`\`

═══════════════════════════════════════
PHASE 4: SUMMARY
═══════════════════════════════════════

Output a summary listing:
- Total ideas generated
- Each task title, ClickUp task ID, feasibility, and impact
- Top 3 recommendations (highest impact-to-effort ratio)
- Any gaps where more research is needed

═══════════════════════════════════════
RULES
═══════════════════════════════════════

- CRITICAL: Use the MCP tools (clickup_create_task, clickup_get_list_tasks)
  for all ClickUp interactions. Do NOT use curl.
- Every task MUST include the \`dream\` and \`ai-generated\` tags.
- Task titles stay clean — NO [AI] prefix. Tags handle identification.
- Ground ideas in EVIDENCE: competitor data, user feedback, market trends,
  or architectural analysis. No "you should probably..." speculation.
- Don't suggest things already being tracked (you checked in Phase 0).
- Think BIG but BUILDABLE. Dream features should be ambitious but realistic
  given the project's architecture and team size.
- When referencing competitors, be specific: "Competitor X charges $Y/mo
  for Z, but their implementation lacks..." not "some competitors do this."
- Description must end with: "---\\n*Generated by claudopilot dream engine*"
`;
}

function generateFixPrFeedbackCommand(config: ClaudopilotConfig): string {
  return `You are fixing PR feedback for ClickUp task: $ARGUMENTS

SETUP:

1. Fetch the task details using clickup_get_task with task_id "$ARGUMENTS".
   Read the task name and description for context on what was implemented.

2. Read /tmp/pr-feedback.json which contains structured PR feedback:
   - reviews: GitHub PR reviews (approved, changes_requested, commented)
   - comments: PR-level comments
   - review_comments: Inline code review comments (with file paths and line numbers)
   - check_runs: CI check run results
   - check_failures: Details of failed CI checks

3. Check for MENTION_PROMPT environment variable. If set, this is a specific
   request from a reviewer mentioning @claude — prioritize that request above
   all other feedback.

CATEGORIZE FEEDBACK:

Go through every piece of feedback and categorize it:

**ACTIONABLE** — Code changes requested:
- Explicit change requests ("change X to Y", "add validation for Z")
- Bug reports with reproduction steps
- Inline review comments pointing to specific code issues
- Requested refactors with clear direction

**CI FAILURES** — Automated check failures:
- Test failures
- Lint errors
- Type check errors
- Build failures

**INFORMATIONAL** — No code change needed:
- Questions (don't answer them — that's for the human)
- Praise or approval comments
- FYI comments or context-sharing
- Architectural discussion (don't make unilateral changes)
- Nitpicks without clear direction

FIX ACTIONABLE ITEMS:

For each ACTIONABLE item, in order:
a. Read the relevant file(s)
b. Make the requested change, following existing code patterns
c. Run available checks (tests, lint, typecheck) if they exist
d. Commit with a descriptive message referencing the feedback:
   "fix: <what was fixed> (PR feedback)"

FIX CI FAILURES:

For each CI failure:
a. Read the error output from check_failures
b. Identify the root cause
c. Fix the issue
d. Run the failing check locally to verify
e. Commit with: "fix: <what was fixed> (CI)"

PUSH:

After all fixes are committed:
git push origin HEAD

SUMMARIZE:

Write a summary to /tmp/feedback-summary.txt with this format:

## PR Feedback Summary

### Fixed
- <bullet for each fix, referencing the original feedback>

### CI Fixes
- <bullet for each CI fix>

### Skipped (Informational)
- <bullet for each skipped item and why>

### Not Addressed
- <bullet for anything you couldn't fix and why>

POST TO CLICKUP:

Post the summary as a ClickUp comment using clickup_create_task_comment with:
  task_id: "$ARGUMENTS"
  comment_text: "🔧 [IMPLEMENT] PR feedback addressed:\\n<summary content>"

RULES:
- CRITICAL: Use the MCP tools for all ClickUp interactions. Do NOT use curl.
- Do NOT make cosmetic or stylistic changes beyond what was explicitly requested.
- Do NOT answer questions in comments — skip them as INFORMATIONAL.
- Do NOT modify .github/workflows/ files.
- Do NOT modify .claude/commands/ files.
- If a reviewer's request conflicts with the spec or architecture, skip it
  and note it in the "Not Addressed" section.
- Each fix gets its own commit with a clear message.
- If MENTION_PROMPT is set, address that specific request FIRST, then handle
  remaining actionable feedback.
`;
}

export async function installClaudeMd(
  config: ClaudopilotConfig,
  targetDir: string = process.cwd(),
  { force = false }: { force?: boolean } = {}
): Promise<boolean> {
  const claudeMdPath = join(targetDir, "CLAUDE.md");
  if (existsSync(claudeMdPath) && !force) {
    ui.info("CLAUDE.md already exists, skipping");
    return false;
  }

  const companions = getCompanionRepos(config);
  const relatedReposSection = companions.length > 0
    ? `\n## Related Repositories\n\n${companions.map(c =>
        `- **${c.name}** (\`${c.remote ?? c.path}\`): ${c.description || c.type}`
      ).join("\n")}\n`
    : "";

  const content = `# CLAUDE.md

## Project: ${config.project.name}

## Development Commands

\`\`\`bash
# TODO: Add your project's development commands here
\`\`\`

## Architecture Notes

<!-- TODO: Describe your project's architecture -->
${relatedReposSection}
## Patterns and Conventions

<!-- TODO: Document patterns Claude should follow -->

## Common Mistakes to Avoid

<!-- TODO: List gotchas and anti-patterns -->
`;

  await writeFile(claudeMdPath, content, "utf-8");
  ui.success("CLAUDE.md template created (fill in project details)");
  return true;
}
