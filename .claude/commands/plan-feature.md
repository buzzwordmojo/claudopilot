You are working on ClickUp task: $ARGUMENTS

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

UNASSIGN HUMANS: Before doing any planning work, unassign any current
human assignees from the task so they don't get notified on every
progress comment. Get the assignee IDs from the task details you just
fetched (look at the assignees array) and remove them using
clickup_update_task with:
  task_id: "$ARGUMENTS"
  assignees: { "rem": [<list of current assignee IDs>] }

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



   Rate every finding as CRITICAL, HIGH, or MEDIUM.
   Findings rated HIGH or above BLOCK the spec.
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

   - If ANY HIGH or above findings exist:
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
          assignees: { "add": [<creator_id from task details>] }
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
        Check the task's tags (from the task details fetched in step 1).
        If the task has a tag named "auto-approve":
          - Move to "approved" using clickup_update_task with:
              task_id: "$ARGUMENTS"
              status: "approved"
          - Post comment using clickup_create_task_comment with:
              task_id: "$ARGUMENTS"
              comment_text: "✅ [ARCHITECT] Auto-approved (task tagged auto-approve). Implementation will start automatically."
          - STOP.

        If the task does NOT have the "auto-approve" tag:

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
- Maximum 5 loop iterations. If still blocked
  after 5, stop and ask for human guidance.
  Be efficient — combine your analysis.
- Each red team round must be HARDER than the last.
  Do not repeat the same findings. Go deeper.
- BLOCKING SEVERITY: HIGH and above block progress.
- Keep a running count: Round N of max 5.
- Every comment must start with [ARCHITECT] or [RED TEAM].
- The spec file should be the FINAL CLEAN RESULT — not an
  append-only log. Each round, rewrite the spec to incorporate
  red team feedback. The ClickUp comments ARE the audit trail.
  The spec is the polished, ready-to-implement plan.
