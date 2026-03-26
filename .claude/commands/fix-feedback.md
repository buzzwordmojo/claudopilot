You are fixing PR feedback for ClickUp task: $ARGUMENTS

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
  comment_text: "🔧 [IMPLEMENT] PR feedback addressed:\n<summary content>"

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
