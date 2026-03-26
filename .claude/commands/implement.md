You are implementing ClickUp task: $ARGUMENTS


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

4. UNASSIGN HUMANS: Unassign any current human assignees from the task
   so they don't get notified on every progress comment. Get the assignee
   IDs from the task details you just fetched and remove them using
   clickup_update_task with:
     task_id: "$ARGUMENTS"
     assignees: { "rem": [<list of current assignee IDs>] }

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
   gh pr create \
     --title "<concise title from task name>" \
     --body "## ClickUp Task\nhttps://app.clickup.com/t/$ARGUMENTS\n\n## Changes\n<summary of what was implemented>\n\n## Subtasks Completed\n<list each subtask>" \
     --base main \
     --head claudopilot/$ARGUMENTS

3. Post the PR URL as a comment using clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🔨 [IMPLEMENT] PR created: <PR_URL> — ready for review."
     notify_all: true

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
