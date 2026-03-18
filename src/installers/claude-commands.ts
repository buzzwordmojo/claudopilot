import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClaudopilotConfig, RepoConfig, RedTeamConfig, BrainstormConfig } from "../types.js";
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

  if (config.brainstorm?.enabled) {
    await writeFile(
      join(commandsDir, "brainstorm.md"),
      generateBrainstormCommand(config)
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
   - If ANY ${severity.toUpperCase()}${severity !== "critical" ? " or above" : ""} findings exist:
     GO TO STEP 1.

   - If no blocking findings but you have QUESTIONS for
     the human (ambiguous requirements, business decisions
     you cannot make):
     a. Post questions as a ClickUp comment using
        clickup_create_task_comment with task_id "$ARGUMENTS"
        and comment_text prefixed with "❓ [BLOCKED]".
     b. Move the task to "blocked" using clickup_update_task with:
          task_id: "$ARGUMENTS"
          status: "blocked"
     c. Assign it so the right person knows to respond using
        clickup_update_task with:
          task_id: "$ARGUMENTS"
${config.redTeam.blockedAssignee === "specific" && config.redTeam.blockedAssigneeUserId
  ? `          assignees: { "add": [${config.redTeam.blockedAssigneeUserId}] }`
  : `          assignees: { "add": [<creator_id from task details>] }`}
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

     d. POST a final summary comment using clickup_create_task_comment.

     e. MOVE the task to "awaiting approval" using clickup_update_task with:
          task_id: "$ARGUMENTS"
          status: "awaiting approval"

     f. STOP.

RULES:
- CRITICAL: You MUST use the MCP tools (clickup_get_task, clickup_update_task,
  clickup_create_task_comment, etc.) to interact with ClickUp. Do NOT use curl.
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

4. Check if a branch already exists (this may be a RESUMPTION):
   git fetch origin claudopilot/$ARGUMENTS 2>/dev/null
   If it exists: this is a continuation. Check out the existing branch:
     git checkout claudopilot/$ARGUMENTS
   Read git log to see what's already been committed. Fetch ClickUp
   comments using clickup_get_task_comments with task_id "$ARGUMENTS"
   to see which subtasks were completed.
   Skip completed subtasks and continue from where it left off.
   If it doesn't exist: create a new branch:
     git checkout -b claudopilot/$ARGUMENTS

5. Read CLAUDE.md for project patterns and standards.

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

3. Post the PR URL as a comment using clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🔨 [IMPLEMENT] PR created: <PR_URL>"

4. Move the task to "in review" using clickup_update_task with:
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

function generateBrainstormCommand(config: ClaudopilotConfig): string {
  const lenses = config.brainstorm?.lenses ?? [];
  const lensesList = lenses.map((l) => `- ${l}`).join("\n");
  const listId = config.pm.listId ?? "<LIST_ID>";
  const ideaStatus = config.pm.statuses.idea ?? "idea";

  return `You are running the claudopilot brainstorm engine.

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

Before starting, check if /tmp/brainstorm-state.md exists.

If it DOES exist, you are CONTINUING a previous round. Read it to understand:
- Which lenses are already completed (skip them entirely)
- Draft ideas not yet created as ClickUp tasks (create them FIRST)
- Which lens was in progress (resume analysis there)
- Which lenses remain (analyze those next)

If it does NOT exist, this is a fresh run. Start from Phase 0.

PROGRESS SAVING (critical — do this after EVERY lens):
After completing analysis for each lens, update /tmp/brainstorm-state.md with
your findings and draft ideas. This file is your checkpoint — if you run out
of turns, the next round will read it to continue.

Write draft ideas to the state file BEFORE creating ClickUp tasks. This way,
if you run out of turns during task creation, the next round can create the
remaining tasks without re-analyzing code.

State file format:
\`\`\`markdown
# Brainstorm State

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

IMPORTANT: Update /tmp/brainstorm-state.md to mark this lens as "In Progress"
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
/tmp/brainstorm-state.md under "Draft Ideas" BEFORE creating any ClickUp tasks.
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
*Generated by claudopilot brainstorm engine*
\`\`\`

Lens tag mapping (use these as the second tag):
- code quality → \`code-quality\`
- UI/UX improvements → \`ux\`
- documentation gaps → \`docs\`
- performance optimization → \`performance\`
- security hardening → \`security\`
- refactoring opportunities → \`refactoring\`
- For custom lenses, slugify the name (lowercase, hyphens).

After creating each task, update /tmp/brainstorm-state.md:
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
  immediately write /tmp/brainstorm-state.md with everything you have learned
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
- Description must end with: "---\\n*Generated by claudopilot brainstorm engine*"
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
