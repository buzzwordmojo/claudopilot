# ClickUp Subtask Strategy

Planning agent should propose implementation subtasks in the spec. For larger features, these should become ClickUp subtasks on the parent task. Currently disabled because:

1. ClickUp boards show subtasks as top-level cards (confusing)
2. Small tasks don't need subtasks — agent should decide based on complexity

**Why:** Subtasks give better context confinement during implementation and visible progress in ClickUp.

**How to apply:** Re-enable subtask creation when we add logic for the agent to assess task complexity and only create ClickUp subtasks for multi-file/multi-concern features. Also investigate ClickUp board settings to hide subtasks from the main view, or use a different approach (checklist items instead of subtasks).
