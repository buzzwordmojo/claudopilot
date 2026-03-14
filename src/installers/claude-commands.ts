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

Check if a specs/[feature-name].md file already exists for this task.
If it does, this is a CONTINUATION of a previous planning session.
Read the existing spec and all ClickUp comments to understand what
questions were asked, what answers were given, and resume from there.

Post a comment on the task to confirm you've started:
  curl -s -X POST "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment" \\
    -H "Authorization: $CLICKUP_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"comment_text":"[ARCHITECT] Reading task and starting planning..."}'

COMMENT FORMATTING RULES:
- ClickUp comments use comment_text (plain text with limited markdown).
- Use line breaks (\\n) to separate sections.
- Use ALL CAPS or [BRACKETS] for headers instead of **bold** (bold doesn't render).
- Use \`backticks\` for code (these do render).
- Use - for bullet lists (these render).
- Use \\n\\n between paragraphs.
- Keep comments concise — put details in the spec file, summaries in comments.

You will alternate between two roles: ARCHITECT and RED TEAM.
These are adversarial. The architect wants to ship. The red
team wants to find reasons not to.

LOOP:

1. ARCHITECT: Draft or revise the spec based on the task
   description and any previous red team findings. Read
   CLAUDE.md and any architecture docs for context.
   Save spec to specs/[feature-name].md
   Post a comment to the ClickUp task summarizing the spec:
   curl -s -X POST "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment" \\
     -H "Authorization: $CLICKUP_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"comment_text":"[ARCHITECT] <summary of spec or revision>"}'

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
   Post a comment to the ClickUp task with findings:
   curl -s -X POST "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment" \\
     -H "Authorization: $CLICKUP_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"comment_text":"[RED TEAM] <findings with severity ratings>"}'

3. DECISION:
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
        - Have a clear definition of done
        - List the files it will touch
        Example:
        \`\`\`
        ## Implementation Subtasks
        1. Change \\\`hasMarkedViewed\\\` ref from boolean to string|null
           Files: components/series/series-context-banner.tsx
           Done when: ref stores dayContentId, guard compares IDs
        2. Add .catch() error logging to markDayViewed
           Files: components/series/series-context-banner.tsx
           Done when: mutation failures logged to console
        \`\`\`

     b. SET TASK DESCRIPTION: Read the spec file and write it to the
        ClickUp task description using markdown_description.
        Use a bash script to properly JSON-escape the content:
        \`\`\`
        SPEC=$(cat specs/[feature-name].md)
        ESCAPED=$(echo "$SPEC" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
        curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d "{\\"markdown_description\\": $ESCAPED}"
        \`\`\`

     c. CREATE SUBTASKS in ClickUp for each implementation subtask:
        For each subtask in the spec:
        curl -s -X POST "https://api.clickup.com/api/v2/list/<list_id>/task" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d '{"name":"<subtask name>","parent":"$ARGUMENTS","markdown_description":"<subtask details from spec>"}'
        (Get the list_id from the parent task's list.id field)

     d. POST a final summary comment to ClickUp.

     e. MOVE the task to "awaiting approval":
        curl -s -X PUT "https://api.clickup.com/api/v2/task/$ARGUMENTS" \\
          -H "Authorization: $CLICKUP_API_KEY" \\
          -H "Content-Type: application/json" \\
          -d '{"status":"awaiting approval"}'

     f. STOP.

RULES:
- Maximum ${config.redTeam.maxRounds} loop iterations. If still CRITICAL
  after ${config.redTeam.maxRounds}, stop and ask for human guidance.
- Each red team round must be HARDER than the last.
  Do not repeat the same findings. Go deeper.
- The red team must explicitly state when HIGH findings
  are acceptable risks vs must-fix.
  Only CRITICAL blocks progress.
- Keep a running count: Round N of max ${config.redTeam.maxRounds}.
- Every comment must start with [ARCHITECT] or [RED TEAM].
- Append all rounds to the spec file. Do not overwrite
  previous rounds. They are the audit trail.
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
  return `Implement the feature described in: $ARGUMENTS

Steps:
1. Read the spec file if one exists in specs/
2. Read CLAUDE.md for project patterns and standards
3. Write failing tests first (TDD)
4. Implement the feature following existing patterns
5. Ensure all tests pass
6. Run lint and typecheck
7. Create a descriptive commit
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
