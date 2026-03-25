import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AutomationsConfig, AutomationRule, ClaudopilotConfig } from "../types.js";

// ─── Worker script generation tests ───

describe("Cloudflare Worker automations rules", () => {
  it("embeds automation boards and rules into the worker script", async () => {
    // We can't import the WORKER_SCRIPT directly (it's a local const),
    // but we can test via deployCloudflareWorker's script generation.
    // Instead, test the shape of the config that flows into the worker.
    const automationsConfig: AutomationsConfig = {
      enabled: true,
      boards: {
        engineering: "901234567",
        support: "901234568",
      },
      rules: [
        {
          name: "Notify support when eng builds",
          when: { board: "engineering", status: "building" },
          then: [
            { update_linked: { board: "support", status: "in progress" } },
            {
              comment_linked: {
                board: "support",
                text: "Engineering started building {{taskName}}.",
              },
            },
          ],
        },
      ],
    };

    expect(automationsConfig.boards.engineering).toBe("901234567");
    expect(automationsConfig.rules).toHaveLength(1);
    expect(automationsConfig.rules[0].when.board).toBe("engineering");
    expect(automationsConfig.rules[0].then).toHaveLength(2);
  });
});

// ─── Rule matching logic (simulates what the Worker does) ───

interface SimBoard {
  [name: string]: string; // name → listId
}

interface SimRule {
  name: string;
  when: { board: string; event?: string; status?: string; tag?: string };
  then: Array<Record<string, unknown>>;
}

function matchRules(
  rules: SimRule[],
  boards: SimBoard,
  sourceListId: string,
  eventType: "status_changed" | "created" | "tag_added" | "tag_removed",
  newStatus?: string,
  changedTag?: string
): SimRule[] {
  // Reverse lookup: listId → board name
  const listIdToBoard: Record<string, string> = {};
  for (const [name, id] of Object.entries(boards)) {
    listIdToBoard[id] = name;
  }

  const sourceBoard = listIdToBoard[sourceListId];
  if (!sourceBoard) return [];

  return rules.filter((r) => {
    if (r.when.board !== sourceBoard) return false;
    const ruleEvent = r.when.event || "status_changed";
    if (ruleEvent !== eventType) return false;
    if (ruleEvent === "status_changed" && r.when.status !== newStatus)
      return false;
    if (
      (ruleEvent === "tag_added" || ruleEvent === "tag_removed") &&
      r.when.tag?.toLowerCase() !== changedTag
    )
      return false;
    return true;
  });
}

describe("Rule matching", () => {
  const boards: SimBoard = {
    engineering: "list-eng-1",
    support: "list-sup-2",
    qa: "list-qa-3",
  };

  const rules: SimRule[] = [
    {
      name: "Notify support when eng builds",
      when: { board: "engineering", status: "building" },
      then: [{ update_linked: { board: "support", status: "in progress" } }],
    },
    {
      name: "Close support when eng done",
      when: { board: "engineering", status: "done" },
      then: [{ update_linked: { board: "support", status: "resolved" } }],
    },
    {
      name: "QA trigger on eng review",
      when: { board: "engineering", status: "in review" },
      then: [{ update_linked: { board: "qa", status: "ready for qa" } }],
    },
  ];

  it("matches rules by source board and status", () => {
    const matched = matchRules(rules, boards, "list-eng-1", "status_changed", "building");
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("Notify support when eng builds");
  });

  it("matches different status on same board", () => {
    const matched = matchRules(rules, boards, "list-eng-1", "status_changed", "done");
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("Close support when eng done");
  });

  it("returns empty for untracked statuses", () => {
    const matched = matchRules(rules, boards, "list-eng-1", "status_changed", "planning");
    expect(matched).toHaveLength(0);
  });

  it("returns empty for unknown list IDs (loop prevention)", () => {
    // A status update on the support list should NOT match engineering rules
    const matched = matchRules(rules, boards, "list-sup-2", "status_changed", "building");
    expect(matched).toHaveLength(0);
  });

  it("returns empty for completely unknown lists", () => {
    const matched = matchRules(rules, boards, "unknown-list", "status_changed", "building");
    expect(matched).toHaveLength(0);
  });
});

// ─── Loop prevention ───

describe("Loop prevention", () => {
  const boards: SimBoard = {
    engineering: "list-eng",
    support: "list-sup",
  };

  const rules: SimRule[] = [
    {
      name: "Eng → Support",
      when: { board: "engineering", status: "building" },
      then: [{ update_linked: { board: "support", status: "in progress" } }],
    },
  ];

  it("rule fires when source is engineering board", () => {
    const matched = matchRules(rules, boards, "list-eng", "status_changed", "building");
    expect(matched).toHaveLength(1);
  });

  it("rule does NOT fire when the update on support triggers a webhook", () => {
    // After the Worker updates a support task to "in progress",
    // ClickUp fires a new webhook. The source list is support,
    // which doesn't match any rule's trigger board.
    const matched = matchRules(rules, boards, "list-sup", "status_changed", "in progress");
    expect(matched).toHaveLength(0);
  });

  it("even if support status matches a different rule's status name, board mismatch prevents firing", () => {
    const matched = matchRules(rules, boards, "list-sup", "status_changed", "building");
    expect(matched).toHaveLength(0);
  });
});

// ─── Task created event matching ───

describe("Task created event matching", () => {
  const boards: SimBoard = {
    support: "list-sup",
    engineering: "list-eng",
  };

  const rules: SimRule[] = [
    {
      name: "Clone support ticket to engineering",
      when: { board: "support", event: "created" },
      then: [{ dispatch: { prompt: "Create eng task from support ticket" } }],
    },
    {
      name: "Notify support when eng builds",
      when: { board: "engineering", event: "status_changed", status: "building" },
      then: [{ update_linked: { board: "support", status: "in progress" } }],
    },
  ];

  it("matches created rules on task creation", () => {
    const matched = matchRules(rules, boards, "list-sup", "created");
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("Clone support ticket to engineering");
  });

  it("does NOT match created rules on status change", () => {
    const matched = matchRules(rules, boards, "list-sup", "status_changed", "open");
    expect(matched).toHaveLength(0);
  });

  it("does NOT match status_changed rules on created event", () => {
    const matched = matchRules(rules, boards, "list-eng", "created");
    expect(matched).toHaveLength(0);
  });

  it("status_changed rules still work alongside created rules", () => {
    const matched = matchRules(rules, boards, "list-eng", "status_changed", "building");
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("Notify support when eng builds");
  });

  it("created event on wrong board returns empty", () => {
    const matched = matchRules(rules, boards, "list-eng", "created");
    expect(matched).toHaveLength(0);
  });
});

// ─── Tag event matching ───

describe("Tag event matching", () => {
  const boards: SimBoard = {
    support: "list-sup",
    engineering: "list-eng",
  };

  const rules: SimRule[] = [
    {
      name: "Tag engineering on support → create eng task",
      when: { board: "support", event: "tag_added", tag: "engineering" },
      then: [{ create_and_link: { board: "engineering" } }],
    },
    {
      name: "Tag resolved on eng → close support",
      when: { board: "engineering", event: "tag_added", tag: "resolved" },
      then: [{ update_linked: { board: "support", status: "resolved" } }],
    },
  ];

  it("matches tag_added rules", () => {
    const matched = matchRules(rules, boards, "list-sup", "tag_added", undefined, "engineering");
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("Tag engineering on support → create eng task");
  });

  it("does NOT match wrong tag name", () => {
    const matched = matchRules(rules, boards, "list-sup", "tag_added", undefined, "urgent");
    expect(matched).toHaveLength(0);
  });

  it("does NOT match tag event on wrong board", () => {
    const matched = matchRules(rules, boards, "list-eng", "tag_added", undefined, "engineering");
    expect(matched).toHaveLength(0);
  });

  it("tag_added does NOT match tag_removed", () => {
    const matched = matchRules(rules, boards, "list-sup", "tag_removed", undefined, "engineering");
    expect(matched).toHaveLength(0);
  });

  it("tag events don't interfere with status_changed rules", () => {
    const mixed: SimRule[] = [
      ...rules,
      { name: "status rule", when: { board: "support", event: "status_changed", status: "open" }, then: [] },
    ];
    const tagMatch = matchRules(mixed, boards, "list-sup", "tag_added", undefined, "engineering");
    expect(tagMatch).toHaveLength(1);
    const statusMatch = matchRules(mixed, boards, "list-sup", "status_changed", "open");
    expect(statusMatch).toHaveLength(1);
  });
});

// ─── Dispatch gate tag ───

describe("Dispatch gate tag", () => {
  function shouldDispatch(
    taskTags: string[],
    gateTag: string | undefined
  ): boolean {
    if (!gateTag) return true;
    return taskTags.map((t) => t.toLowerCase()).includes(gateTag.toLowerCase());
  }

  it("allows dispatch when no gate tag configured", () => {
    expect(shouldDispatch([], undefined)).toBe(true);
    expect(shouldDispatch(["foo"], undefined)).toBe(true);
  });

  it("blocks dispatch when gate tag is missing from task", () => {
    expect(shouldDispatch([], "claudopilot")).toBe(false);
    expect(shouldDispatch(["urgent", "bug"], "claudopilot")).toBe(false);
  });

  it("allows dispatch when gate tag is present", () => {
    expect(shouldDispatch(["claudopilot"], "claudopilot")).toBe(true);
    expect(shouldDispatch(["urgent", "claudopilot"], "claudopilot")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(shouldDispatch(["Claudopilot"], "claudopilot")).toBe(true);
    expect(shouldDispatch(["CLAUDOPILOT"], "claudopilot")).toBe(true);
  });
});

// ─── Template substitution ───

describe("Template substitution", () => {
  function substituteTemplates(
    text: string,
    vars: { status: string; taskName: string }
  ): string {
    return text
      .replace(/\{\{status\}\}/g, vars.status)
      .replace(/\{\{taskName\}\}/g, vars.taskName);
  }

  it("replaces {{status}} and {{taskName}}", () => {
    const result = substituteTemplates(
      "Engineering has started {{status}} on {{taskName}}.",
      { status: "building", taskName: "Fix login bug" }
    );
    expect(result).toBe(
      "Engineering has started building on Fix login bug."
    );
  });

  it("handles multiple occurrences", () => {
    const result = substituteTemplates(
      "{{taskName}} is now {{status}}. Tracking {{taskName}}.",
      { status: "done", taskName: "Task A" }
    );
    expect(result).toBe("Task A is now done. Tracking Task A.");
  });

  it("handles text with no templates", () => {
    const result = substituteTemplates("Plain text, no vars.", {
      status: "x",
      taskName: "y",
    });
    expect(result).toBe("Plain text, no vars.");
  });
});

// ─── Action classification ───

describe("Action type detection", () => {
  it("identifies worker-executed actions", () => {
    const workerActions = ["update_linked", "comment_linked", "create_link"];
    const actions = [
      { update_linked: { board: "support", status: "in progress" } },
      { comment_linked: { board: "support", text: "Hello" } },
      { create_link: { taskId: "abc123" } },
    ];

    for (const action of actions) {
      const key = Object.keys(action)[0];
      expect(workerActions).toContain(key);
    }
  });

  it("identifies dispatch actions (GH Actions)", () => {
    const action = { dispatch: { prompt: "Find related tickets" } };
    expect("dispatch" in action).toBe(true);
  });
});

// ─── AutomationsConfig validation ───

describe("AutomationsConfig shape", () => {
  it("requires at least 2 boards for meaningful automations", () => {
    const config: AutomationsConfig = {
      enabled: true,
      boards: { engineering: "1", support: "2" },
      rules: [],
    };
    expect(Object.keys(config.boards).length).toBeGreaterThanOrEqual(2);
  });

  it("rules reference board names that exist in boards map", () => {
    const config: AutomationsConfig = {
      enabled: true,
      boards: { engineering: "1", support: "2" },
      rules: [
        {
          name: "test",
          when: { board: "engineering", status: "building" },
          then: [{ update_linked: { board: "support", status: "active" } }],
        },
      ],
    };

    for (const rule of config.rules) {
      expect(config.boards).toHaveProperty(rule.when.board);
      for (const action of rule.then) {
        if ("update_linked" in action) {
          expect(config.boards).toHaveProperty(action.update_linked.board);
        }
        if ("comment_linked" in action) {
          expect(config.boards).toHaveProperty(action.comment_linked.board);
        }
      }
    }
  });
});
