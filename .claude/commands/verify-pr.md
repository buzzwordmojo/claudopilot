You are verifying a PR for ClickUp task: $ARGUMENTS

SETUP:

1. Fetch the task details and spec using clickup_get_task with task_id "$ARGUMENTS".
   Read the task name, description (the spec), and subtasks.

2. Fetch existing comments using clickup_get_task_comments with task_id "$ARGUMENTS".
   Count comments that match the pattern "[REVIEW] Attempt" to determine the
   current attempt number.

3. Post a comment using clickup_create_task_comment with:
     task_id: "$ARGUMENTS"
     comment_text: "🔍 [REVIEW] Attempt N of 3 — Starting post-build verification..."
   (Replace N with the current attempt number.)

CHECKS (run all, collect results):

Configured lenses:
- build
- typecheck
- lint
- test
- merge-conflicts
- spec-compliance
- scope
- patterns
- security

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
   git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main
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
     ```markdown
     # Verify Findings
     ## Blocking Issues
     1. **<Lens>** — <description of issue and how to fix it>
     ## Warnings
     - <warning description>
     ```

  2. Post a ClickUp comment using the FAIL output format below.

  3. Check attempt count:
     - If attempt >= 2 (max retries reached):
       a. Move task to "blocked" using clickup_update_task with:
            task_id: "$ARGUMENTS"
            status: "blocked"
       b. Assign creator using clickup_update_task with:
            task_id: "$ARGUMENTS"
            assignees: { "add": [<creator_id from task details>] }
       c. Post a comment: "🔍 [REVIEW] Max retries (2) reached. Moving to blocked for human review."
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

```
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
```

OUTPUT FORMAT — FAIL:

Post as a ClickUp comment using clickup_create_task_comment with:
  task_id: "$ARGUMENTS"
  comment_text: (use the format below)

```
🔍 [REVIEW] Attempt N of 3 — FAIL

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
```

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
