import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClaudopilotConfig, RedTeamConfig } from "../types.js";
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

  ui.success("Claude commands installed in .claude/commands/");
}

function generatePlanFeatureCommand(config: ClaudopilotConfig): string {
  const domainLenses = config.redTeam.domainLenses
    .map(
      (l) =>
        `${l.name}:\n${l.checks.map((c) => `   - ${c}`).join("\n")}`
    )
    .join("\n\n");

  return `You are working on ClickUp task: $ARGUMENTS

First, fetch the task details from ClickUp using:
  curl -s "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
    -H "Authorization: $CLICKUP_API_KEY"

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
Read the existing spec and all ClickUp comments to understand what
questions were asked, what answers were given, and resume from there.

Post a comment on the task to confirm you've started:
  curl -s -X POST "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment" \\
    -H "Authorization: $CLICKUP_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"comment":[{"text":"🏗️ [ARCHITECT] ","attributes":{"bold":true}},{"text":"Reading task and starting planning..."}]}'

COMMENT FORMATTING RULES:
- Use ClickUp rich text format: {"comment": [{"text":"...","attributes":{}},...]}
- ARCHITECT comments: header = {"text":"🏗️ [ARCHITECT] <title>\\n","attributes":{"bold":true}}
- RED TEAM comments: header = {"text":"🔴 [RED TEAM] <title>\\n","attributes":{"bold":true}}
- BLOCKED comments: header = {"text":"❓ [BLOCKED] <title>\\n","attributes":{"bold":true}}
- For severity labels use bold: {"text":"CRITICAL: ","attributes":{"bold":true}}
- For file paths use code: {"text":"path/to/file.ts","attributes":{"code-inline":true}}
- Plain body text: {"text":"description here\\n","attributes":{}}
- Keep comments concise — details in the spec file, summaries in comments.

You will alternate between two roles: ARCHITECT and RED TEAM.
These are adversarial. The architect wants to ship. The red
team wants to find reasons not to.

LOOP:

1. ARCHITECT: Draft or revise the spec based on the task
   description and any previous red team findings. Read
   CLAUDE.md and any architecture docs for context.
   Save spec to specs/[feature-name].md
   Post a comment to the ClickUp task summarizing the spec using
   the rich text format from COMMENT FORMATTING RULES above.

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
   Post a comment to the ClickUp task with findings using
   the rich text format from COMMENT FORMATTING RULES above.
   Use bold for severity labels (CRITICAL:, HIGH:, MEDIUM:)
   and code-inline for file paths.

3. CHECK FOR NEW STAKEHOLDER INPUT:
   Before making a decision, re-fetch task comments to check for
   new human input added while you were working:
   curl -s "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment" \\
     -H "Authorization: $CLICKUP_API_KEY"

   Compare against comments you've already seen. Track the count
   of comments you've read so far — any new ones are new input.

   IGNORE comments that start with [ARCHITECT], [RED TEAM],
   [CLAUDOPILOT], or [IMPLEMENT] — those are yours.

   If there ARE new human comments:
   - Read them carefully as additional requirements or clarifications
   - Post an acknowledgment using rich text format with 🏗️ [ARCHITECT] header,
     noting what new input was received and that it will be incorporated.
   - GO TO STEP 1 to revise the spec with the new input
     (this does NOT count against the max rounds limit)

   If there are no new human comments, proceed to DECISION.

4. DECISION:
   - If ANY critical findings exist:
     GO TO STEP 1.

   - If no critical findings but you have QUESTIONS for
     the human (ambiguous requirements, business decisions
     you cannot make):
     a. Post questions as a ClickUp comment prefixed with [BLOCKED].
     b. Move the task to "blocked":
        curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d '{"status":"blocked"}'
     c. Assign it so the right person knows to respond:
${config.redTeam.blockedAssignee === "specific" && config.redTeam.blockedAssigneeUserId
  ? `        curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d '{"assignees":{"add":[${config.redTeam.blockedAssigneeUserId}]}}'`
  : `        Use the creator.id from the task details:
        curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d '{"assignees":{"add":[<creator_id>]}}'`}
     d. STOP. A human will answer and move the task back to "planning",
        which will trigger a new run. The new run will read comments
        and the spec file to pick up where you left off.

   - If no critical findings and no questions — PLANNING IS COMPLETE:

     a. FINALIZE THE SPEC: Make sure the spec file includes a section
        at the end called "## Implementation Subtasks" that breaks the
        work into discrete, ordered subtasks. Each subtask should be:
        - Small enough for a single focused implementation pass
        - Self-contained: an implementer can work from the subtask
          description alone without re-reading the full parent spec
        - Include: context, files, approach, acceptance criteria, edge cases

     b. SET TASK DESCRIPTION: Read the spec file and write it to the
        ClickUp task description using markdown_description.
        Use a bash script to properly JSON-escape the content:
        SPEC=$(cat specs/[feature-name].md)
        ESCAPED=$(echo "$SPEC" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
        curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d "{\\"markdown_description\\": $ESCAPED}"

     c. CREATE SUBTASKS if the work involves multiple files or
        distinct concerns (skip for simple single-file fixes).
        First, get the list ID from the parent task's list.id field.
        Then for each subtask, create it with a COMPLETE spec as its
        description — not just a title. Each subtask description should
        include:
        - Context: why this change is needed (reference the parent spec)
        - What to change: specific files, functions, components
        - How to change it: the approach, with code-level detail
        - Acceptance criteria: what "done" looks like
        - Edge cases or risks the red team identified for this piece

        curl -s -X POST "https://api.clickup.com/api/v2/list/<list_id>/task" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d '{"name":"<subtask title>","parent":"$ARGUMENTS","status":"idea","markdown_description":"<full subtask spec>"}'

        The implementation agent will use each subtask's description
        as its working spec, so make them self-contained enough to
        implement without re-reading the entire parent spec.

     d. POST a final summary comment to ClickUp.

     e. MOVE the task to "awaiting approval":
        curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d '{"status":"awaiting approval"}'

     f. STOP.

RULES:
- CRITICAL: You MUST use the Bash tool to EXECUTE every curl command
  in this prompt. Do NOT just describe what you would do — actually
  run the commands. This includes: fetching the task, posting comments,
  updating the task description, and changing status.
  If you mention doing something to ClickUp, you must run the curl.
- TURN BUDGET: You have a limited number of tool calls. Reserve at
  least 5 turns for finalization (writing description, posting summary,
  moving status). If you are on round 3+ and have no CRITICAL findings,
  finalize immediately rather than doing another round.
- Maximum ${config.redTeam.maxRounds} loop iterations. If still CRITICAL
  after ${config.redTeam.maxRounds}, stop and ask for human guidance.
  Be efficient — combine your analysis.
- Each red team round must be HARDER than the last.
  Do not repeat the same findings. Go deeper.
- The red team must explicitly state when HIGH findings
  are acceptable risks vs must-fix.
  Only CRITICAL blocks progress.
- Keep a running count: Round N of max ${config.redTeam.maxRounds}.
- Every comment must start with [ARCHITECT] or [RED TEAM].
- The spec file should be the FINAL CLEAN RESULT — not an
  append-only log. Each round, rewrite the spec to incorporate
  red team feedback. The ClickUp comments ARE the audit trail.
  The spec is the polished, ready-to-implement plan.
`;
}

function generateRedTeamCommand(config: ClaudopilotConfig): string {
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

Output format:
### Red Team Report
**CRITICAL** (must fix):
- ...
**HIGH** (should fix):
- ...
**MEDIUM** (consider):
- ...
**Suggested mitigations** for each critical/high item.
`;
}

function generateImplementCommand(config: ClaudopilotConfig): string {
  return `You are implementing ClickUp task: $ARGUMENTS

SETUP:

1. Fetch the task details from ClickUp:
   curl -s "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
     -H "Authorization: $CLICKUP_API_KEY"
   Read the task name, description (the spec), and subtasks.

2. Move the task to "building":
   curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
     -H "Authorization: $CLICKUP_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"status":"building"}'

3. Post a comment confirming you've started:
   curl -s -X POST "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment" \\
     -H "Authorization: $CLICKUP_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"comment":[{"text":"🔨 [IMPLEMENT] ","attributes":{"bold":true}},{"text":"Starting implementation. Reading spec and creating branch..."}]}'

4. Check if a branch already exists (this may be a RESUMPTION):
   git fetch origin claudopilot/$ARGUMENTS 2>/dev/null
   If it exists: this is a continuation. Check out the existing branch:
     git checkout claudopilot/$ARGUMENTS
   Read git log to see what's already been committed. Read the
   ClickUp comments to see which subtasks were completed.
   Skip completed subtasks and continue from where it left off.
   If it doesn't exist: create a new branch:
     git checkout -b claudopilot/$ARGUMENTS

5. Read CLAUDE.md for project patterns and standards.

IMPLEMENTATION:

Work through the implementation subtasks from the spec IN ORDER.
Skip any subtasks that were already completed in a previous run
(check git log and ClickUp comments).
For each remaining subtask:

a. Post a comment to ClickUp noting which subtask you're working on.
b. Read the relevant files listed in the subtask.
c. Write failing tests first (TDD) if the project has a test framework.
d. Implement the changes following existing patterns.
e. Run any available checks:
   - Tests (npm test, pytest, etc.)
   - Lint (npm run lint, etc.)
   - Typecheck (npm run typecheck, tsc --noEmit, etc.)
   Only run checks that are defined in the project. Skip if not available.
f. Commit the subtask with a descriptive message.
g. Post a comment to ClickUp confirming the subtask is done.
h. If the subtask exists as a ClickUp subtask, mark it done:
     curl -s -X PUT "https://api.clickup.com/api/v2/task/<subtask_id>" \\
       -H "Authorization: $CLICKUP_API_KEY" \\
       -H "Content-Type: application/json" \\
       -d '{"status":"done"}'
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

3. Post the PR URL as a comment on the ClickUp task:
   curl -s -X POST "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment" \\
     -H "Authorization: $CLICKUP_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"comment":[{"text":"🔨 [IMPLEMENT] ","attributes":{"bold":true}},{"text":"PR created: <PR_URL>"}]}'

4. Move the task to "in review":
   curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
     -H "Authorization: $CLICKUP_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"status":"in review"}'

RULES:
- CRITICAL: You MUST use the Bash tool to EXECUTE every curl and git
  command. Do NOT just describe what you would do — actually run them.
- Follow existing code patterns. Read before you write.
- Commit after each subtask, not one giant commit at the end.
- If a test or lint fails, fix it before moving on.
- If you get stuck on a subtask, post a comment to ClickUp explaining
  the issue and continue with the next subtask.
`;
}

export async function installClaudeMd(
  config: ClaudopilotConfig,
  targetDir: string = process.cwd()
): Promise<boolean> {
  const claudeMdPath = join(targetDir, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    ui.info("CLAUDE.md already exists, skipping");
    return false;
  }

  const content = `# CLAUDE.md

## Project: ${config.project.name}

## Development Commands

\`\`\`bash
# TODO: Add your project's development commands here
\`\`\`

## Architecture Notes

<!-- TODO: Describe your project's architecture -->

## Patterns and Conventions

<!-- TODO: Document patterns Claude should follow -->

## Common Mistakes to Avoid

<!-- TODO: List gotchas and anti-patterns -->
`;

  await writeFile(claudeMdPath, content, "utf-8");
  ui.success("CLAUDE.md template created (fill in project details)");
  return true;
}
