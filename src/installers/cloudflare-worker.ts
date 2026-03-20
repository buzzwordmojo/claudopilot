import { ui } from "../utils/ui.js";
import type { CloudflareConfig, GitHubConfig, SyncConfig } from "../types.js";

const WORKER_SCRIPT = (
  githubRepo: string,
  githubPat: string,
  webhookSecret: string,
  clickupApiKey: string,
  sdlcListIds: string[],
  syncBoards: Record<string, string>,
  syncRules: Array<{ name: string; when: { board: string; event?: string; status?: string; tag?: string }; then: Array<Record<string, unknown>> }>,
  dispatchGateTag?: string
) => `
export default {
  async fetch(request, env) {
    // Verify webhook secret
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== '${webhookSecret}') {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();
    const taskId = payload.task_id;
    const event = payload.event;

    // Determine event type, status, and tag info
    let eventType = null;   // 'created', 'status_changed', 'tag_added', 'tag_removed'
    let newStatus = null;
    let changedTag = null;

    if (event === 'taskCreated') {
      eventType = 'created';
    } else if (event === 'taskTagUpdated') {
      const historyItems = payload.history_items || [];
      const tagChange = historyItems.find((item) => item.field === 'tag');
      if (tagChange) {
        // ClickUp tag changes: after has the added tag, before has the removed tag
        if (tagChange.after && tagChange.after.tag) {
          eventType = 'tag_added';
          changedTag = tagChange.after.tag.toLowerCase();
        } else if (tagChange.before && tagChange.before.tag) {
          eventType = 'tag_removed';
          changedTag = tagChange.before.tag.toLowerCase();
        }
      }
    } else {
      const historyItems = payload.history_items || [];
      const statusChange = historyItems.find(
        (item) => item.field === 'status'
      );
      if (statusChange) {
        eventType = 'status_changed';
        newStatus = statusChange.after?.status?.toLowerCase();
      }
    }

    if (!eventType) {
      return new Response('Unhandled event', { status: 200 });
    }

    const results = { sync: [], dispatch: false };

    // ─── Sync rules engine ───
    const BOARDS = ${JSON.stringify(syncBoards)};
    const RULES = ${JSON.stringify(syncRules)};

    // Reverse lookup: listId → board name
    const listIdToBoard = {};
    for (const [name, id] of Object.entries(BOARDS)) {
      listIdToBoard[id] = name;
    }

    // Fetch task with linked_tasks to determine source board
    let taskData = null;
    try {
      const taskRes = await fetch(
        'https://api.clickup.com/api/v2/task/' + taskId + '?include_subtasks=true',
        { headers: { Authorization: '${clickupApiKey}' } }
      );
      if (taskRes.ok) {
        taskData = await taskRes.json();
      }
    } catch (e) {
      // Continue without task data
    }

    // For created events, grab the initial status from task data
    if (eventType === 'created' && taskData) {
      newStatus = taskData.status?.status?.toLowerCase() || null;
    }

    if (taskData && RULES.length > 0) {
      const sourceListId = taskData.list?.id;
      const sourceBoard = listIdToBoard[sourceListId];
      const linkedTasks = taskData.linked_tasks || [];

      // Match rules by board + event type
      const matchedRules = RULES.filter((r) => {
        if (r.when.board !== sourceBoard) return false;
        const ruleEvent = r.when.event || 'status_changed';
        if (ruleEvent !== eventType) return false;
        if (ruleEvent === 'status_changed' && r.when.status !== newStatus) return false;
        if ((ruleEvent === 'tag_added' || ruleEvent === 'tag_removed') && r.when.tag?.toLowerCase() !== changedTag) return false;
        return true;
      });

      for (const rule of matchedRules) {
        for (const action of rule.then) {
          if (action.update_linked) {
            const targetListId = BOARDS[action.update_linked.board];
            if (!targetListId) continue;
            for (const link of linkedTasks) {
              try {
                const ltRes = await fetch(
                  'https://api.clickup.com/api/v2/task/' + link.task_id,
                  { headers: { Authorization: '${clickupApiKey}' } }
                );
                if (!ltRes.ok) continue;
                const lt = await ltRes.json();
                if (lt.list?.id !== targetListId) continue;
                await fetch(
                  'https://api.clickup.com/api/v2/task/' + link.task_id,
                  {
                    method: 'PUT',
                    headers: {
                      Authorization: '${clickupApiKey}',
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ status: action.update_linked.status }),
                  }
                );
                results.sync.push({ action: 'update_linked', task: link.task_id, status: action.update_linked.status });
              } catch (e) {
                // Continue processing other links
              }
            }
          }

          if (action.comment_linked) {
            const targetListId = BOARDS[action.comment_linked.board];
            if (!targetListId) continue;
            let text = action.comment_linked.text || '';
            text = text.replace(/\\{\\{status\\}\\}/g, newStatus || '');
            text = text.replace(/\\{\\{taskName\\}\\}/g, taskData.name || '');
            for (const link of linkedTasks) {
              try {
                const ltRes = await fetch(
                  'https://api.clickup.com/api/v2/task/' + link.task_id,
                  { headers: { Authorization: '${clickupApiKey}' } }
                );
                if (!ltRes.ok) continue;
                const lt = await ltRes.json();
                if (lt.list?.id !== targetListId) continue;
                await fetch(
                  'https://api.clickup.com/api/v2/task/' + link.task_id + '/comment',
                  {
                    method: 'POST',
                    headers: {
                      Authorization: '${clickupApiKey}',
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ comment_text: text }),
                  }
                );
                results.sync.push({ action: 'comment_linked', task: link.task_id });
              } catch (e) {
                // Continue processing
              }
            }
          }

          if (action.create_and_link) {
            const targetListId = BOARDS[action.create_and_link.board];
            if (targetListId) {
              try {
                // Create a new task on the target board
                const createRes = await fetch(
                  'https://api.clickup.com/api/v2/list/' + targetListId + '/task',
                  {
                    method: 'POST',
                    headers: {
                      Authorization: '${clickupApiKey}',
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      name: taskData.name || 'Linked task',
                      markdown_description: (taskData.description || '') + '\\n\\nLinked from: https://app.clickup.com/t/' + taskId,
                      ...(action.create_and_link.status ? { status: action.create_and_link.status } : {}),
                    }),
                  }
                );
                if (createRes.ok) {
                  const created = await createRes.json();
                  // Link the new task back to the source
                  await fetch(
                    'https://api.clickup.com/api/v2/task/' + taskId + '/link/' + created.id,
                    {
                      method: 'POST',
                      headers: {
                        Authorization: '${clickupApiKey}',
                        'Content-Type': 'application/json',
                      },
                    }
                  );
                  results.sync.push({ action: 'create_and_link', created: created.id, board: action.create_and_link.board });
                }
              } catch (e) {
                // Continue processing
              }
            }
          }

          if (action.assign_linked) {
            const targetListId = BOARDS[action.assign_linked.board];
            if (targetListId) {
              for (const link of linkedTasks) {
                try {
                  const ltRes = await fetch(
                    'https://api.clickup.com/api/v2/task/' + link.task_id,
                    { headers: { Authorization: '${clickupApiKey}' } }
                  );
                  if (!ltRes.ok) continue;
                  const lt = await ltRes.json();
                  if (lt.list?.id !== targetListId) continue;
                  const existing = (lt.assignees || []).map(a => a.id);
                  if (!existing.includes(Number(action.assign_linked.userId))) {
                    await fetch(
                      'https://api.clickup.com/api/v2/task/' + link.task_id,
                      {
                        method: 'PUT',
                        headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
                        body: JSON.stringify({ assignees: { add: [Number(action.assign_linked.userId)] } }),
                      }
                    );
                  }
                  results.sync.push({ action: 'assign_linked', task: link.task_id, userId: action.assign_linked.userId });
                } catch (e) {}
              }
            }
          }

          if (action.unassign_linked) {
            const targetListId = BOARDS[action.unassign_linked.board];
            if (targetListId) {
              for (const link of linkedTasks) {
                try {
                  const ltRes = await fetch(
                    'https://api.clickup.com/api/v2/task/' + link.task_id,
                    { headers: { Authorization: '${clickupApiKey}' } }
                  );
                  if (!ltRes.ok) continue;
                  const lt = await ltRes.json();
                  if (lt.list?.id !== targetListId) continue;
                  const toRemove = action.unassign_linked.userId
                    ? [Number(action.unassign_linked.userId)]
                    : (lt.assignees || []).map(a => a.id);
                  if (toRemove.length > 0) {
                    await fetch(
                      'https://api.clickup.com/api/v2/task/' + link.task_id,
                      {
                        method: 'PUT',
                        headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
                        body: JSON.stringify({ assignees: { rem: toRemove } }),
                      }
                    );
                  }
                  results.sync.push({ action: 'unassign_linked', task: link.task_id });
                } catch (e) {}
              }
            }
          }

          if (action.tag_linked) {
            const targetListId = BOARDS[action.tag_linked.board];
            if (targetListId) {
              for (const link of linkedTasks) {
                try {
                  const ltRes = await fetch(
                    'https://api.clickup.com/api/v2/task/' + link.task_id,
                    { headers: { Authorization: '${clickupApiKey}' } }
                  );
                  if (!ltRes.ok) continue;
                  const lt = await ltRes.json();
                  if (lt.list?.id !== targetListId) continue;
                  await fetch(
                    'https://api.clickup.com/api/v2/task/' + link.task_id + '/tag/' + encodeURIComponent(action.tag_linked.tag),
                    {
                      method: 'POST',
                      headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
                    }
                  );
                  results.sync.push({ action: 'tag_linked', task: link.task_id, tag: action.tag_linked.tag });
                } catch (e) {}
              }
            }
          }

          if (action.create_link) {
            try {
              await fetch(
                'https://api.clickup.com/api/v2/task/' + taskId + '/link/' + action.create_link.taskId,
                {
                  method: 'POST',
                  headers: {
                    Authorization: '${clickupApiKey}',
                    'Content-Type': 'application/json',
                  },
                }
              );
              results.sync.push({ action: 'create_link', taskId: action.create_link.taskId });
            } catch (e) {
              // Continue processing
            }
          }

          if (action.dispatch) {
            try {
              await fetch(
                'https://api.github.com/repos/${githubRepo}/dispatches',
                {
                  method: 'POST',
                  headers: {
                    Authorization: 'token ${githubPat}',
                    Accept: 'application/vnd.github.v3+json',
                    'User-Agent': 'claudopilot-webhook',
                  },
                  body: JSON.stringify({
                    event_type: 'clickup-sync',
                    client_payload: {
                      task_id: taskId,
                      task_name: taskData.name || '',
                      rule_name: rule.name,
                      prompt: action.dispatch.prompt,
                    },
                  }),
                }
              );
              results.sync.push({ action: 'dispatch', rule: rule.name });
            } catch (e) {
              // Continue processing
            }
          }
        }
      }
    }

    // ─── Existing planning/approved dispatch (status_changed only) ───
    if (eventType !== 'status_changed' || !newStatus) {
      return new Response(
        JSON.stringify({ task_id: taskId, event: eventType, sync: results.sync }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const triggers = ['planning', 'approved'];
    const SDLC_LIST_IDS = ${JSON.stringify(sdlcListIds)};

    // Only dispatch planning/approved for tasks on the main claudopilot list
    const GATE_TAG = '${dispatchGateTag || ""}';
    const taskTags = (taskData?.tags || []).map(t => t.name?.toLowerCase());
    const gateOk = !GATE_TAG || taskTags.includes(GATE_TAG.toLowerCase());

    if (!triggers.includes(newStatus) || (taskData && !SDLC_LIST_IDS.includes(taskData.list?.id)) || !gateOk) {
      return new Response(
        JSON.stringify({ task_id: taskId, status: newStatus, sync: results.sync, gated: !gateOk }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const taskName = taskData?.name || '';

    // Trigger GitHub Actions
    const response = await fetch(
      'https://api.github.com/repos/${githubRepo}/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: 'token ${githubPat}',
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'claudopilot-webhook',
        },
        body: JSON.stringify({
          event_type: 'clickup-task',
          client_payload: {
            task_id: taskId,
            status: newStatus,
            task_name: taskName,
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      return new Response('GitHub dispatch failed: ' + body, {
        status: 500,
      });
    }

    return new Response(
      JSON.stringify({ dispatched: true, task_id: taskId, status: newStatus, sync: results.sync }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};
`;

export async function deployCloudflareWorker(
  cfConfig: CloudflareConfig,
  githubConfig: GitHubConfig,
  githubPat: string,
  clickupApiKey?: string,
  syncConfig?: SyncConfig,
  sdlcListIds?: string[]
): Promise<string> {
  const webhookSecret = generateSecret();
  const githubRepo = `${githubConfig.owner}/${githubConfig.repos[0]}`;

  const spinner = ui.spinner("Deploying Cloudflare Worker...");

  try {
    const workerName = cfConfig.workerName || "claudopilot-webhook";

    // Extract sync boards and rules for the worker
    const syncBoards = syncConfig?.enabled ? syncConfig.boards : {};
    const syncRules = syncConfig?.enabled
      ? syncConfig.rules.map((r) => ({
          name: r.name,
          when: r.when,
          then: r.then,
        }))
      : [];

    // Upload the worker script
    const scriptContent = WORKER_SCRIPT(
      githubRepo,
      githubPat,
      webhookSecret,
      clickupApiKey || "",
      sdlcListIds ?? [],
      syncBoards,
      syncRules,
      syncConfig?.dispatchGateTag
    );

    const formData = new FormData();
    formData.append(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2024-01-01",
      })
    );
    formData.append(
      "worker.js",
      new Blob([scriptContent], { type: "application/javascript+module" }),
      "worker.js"
    );

    const uploadRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfConfig.accountId}/workers/scripts/${workerName}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${cfConfig.apiToken}`,
        },
        body: formData,
      }
    );

    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      throw new Error(`Worker upload failed: ${body}`);
    }

    // Ensure account has a workers.dev subdomain
    let subdomain: string | null = null;

    const accountRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfConfig.accountId}/workers/subdomain`,
      {
        headers: {
          Authorization: `Bearer ${cfConfig.apiToken}`,
        },
      }
    );

    if (accountRes.ok) {
      const accountData = (await accountRes.json()) as {
        result: { subdomain: string } | null;
      };
      subdomain = accountData.result?.subdomain ?? null;
    }

    if (!subdomain) {
      // Create workers.dev subdomain — derive from account ID
      // Cloudflare requires a unique name; use workerName prefix
      const subdomainName = `claudopilot-${cfConfig.accountId!.slice(0, 8)}`;
      const createRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfConfig.accountId}/workers/subdomain`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${cfConfig.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ subdomain: subdomainName }),
        }
      );

      if (createRes.ok) {
        const createData = (await createRes.json()) as {
          result: { subdomain: string };
        };
        subdomain = createData.result.subdomain;
      } else {
        const body = await createRes.text();
        ui.warn(`Could not create workers.dev subdomain: ${body}`);
        ui.warn("Visit dash.cloudflare.com → Workers & Pages to set one up manually.");
      }
    }

    // Enable the workers.dev route for this worker
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfConfig.accountId}/workers/scripts/${workerName}/subdomain`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfConfig.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }
    );

    let workerUrl: string;
    if (subdomain) {
      workerUrl = `https://${workerName}.${subdomain}.workers.dev?secret=${webhookSecret}`;
    } else {
      workerUrl = `https://${workerName}.workers.dev?secret=${webhookSecret}`;
    }

    spinner.succeed(`  Cloudflare Worker deployed: ${workerName}`);
    return workerUrl;
  } catch (error) {
    spinner.fail("  Failed to deploy Cloudflare Worker");
    throw error;
  }
}

function generateSecret(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}
