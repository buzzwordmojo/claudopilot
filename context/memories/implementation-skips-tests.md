# Implementation Agent Skips Tests

The implementation agent doesn't run any tests, lint, or typecheck. Two causes:

1. No `npm install` step in the workflow before Claude runs — dependencies aren't available
2. The implement command says "skip if not available" which lets Claude skip everything

**Why:** Without checks, the agent can push broken code. TDD was a core design goal.

**How to apply:**
- Add `npm install` (or detect package manager) as a workflow step before the implement step
- Make the implement command read package.json scripts and explicitly list which checks to run
- Change wording from "skip if not available" to "you MUST run these checks"
- Consider adding a verification step in the workflow after Claude finishes (run tests independently)
