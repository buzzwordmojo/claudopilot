import { ui } from "../utils/ui.js";
import { ClickUpAdapter } from "../adapters/clickup.js";
import type { CloudflareConfig, GitHubConfig, AutomationsConfig } from "../types.js";

export interface WebhookEnsureConfig {
  clickupApiKey: string;
  workspaceId: string;
  automationsConfig?: AutomationsConfig;
}

const WORKER_SCRIPT = (
  githubRepo: string,
  githubPat: string,
  webhookSecret: string,
  clickupApiKey: string,
  sdlcListIds: string[],
  automationBoards: Record<string, string>,
  automationRules: Array<{ name: string; when: { board: string; event?: string; status?: string; tag?: string }; then: Array<Record<string, unknown>> }>,
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

    // ─── GitHub webhook handler ───
    const ghEvent = request.headers.get('X-GitHub-Event');
    if (ghEvent) {
      const ghPayload = await request.json();
      const CI_USER = 'github-actions[bot]';

      // Determine actor
      const actor = ghPayload.sender?.login || '';
      if (actor === 'github-actions[bot]' || actor === CI_USER) {
        return new Response(JSON.stringify({ ignored: true, reason: 'ci-actor' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      let ghEventType = null;
      let branch = null;
      let prNumber = null;
      let reviewer = null;
      let mentionPrompt = null;

      if (ghEvent === 'pull_request_review' && ghPayload.action === 'submitted') {
        ghEventType = 'pr_review_submitted';
        branch = ghPayload.pull_request?.head?.ref || '';
        prNumber = ghPayload.pull_request?.number;
        reviewer = ghPayload.review?.user?.login || '';
      } else if (ghEvent === 'check_run' && ghPayload.action === 'completed' && ghPayload.check_run?.conclusion === 'failure') {
        ghEventType = 'check_run_failed';
        const branches = ghPayload.check_run?.pull_requests || [];
        if (branches.length > 0) {
          branch = branches[0].head?.ref || '';
          prNumber = branches[0].number;
        }
      } else if (ghEvent === 'issue_comment' && ghPayload.action === 'created' && ghPayload.issue?.pull_request) {
        // Comment on a PR — fetch the PR to get branch
        const prUrl = ghPayload.issue.pull_request.url;
        try {
          const prRes = await fetch(prUrl, {
            headers: {
              Authorization: 'token ${githubPat}',
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'claudopilot-webhook',
            },
          });
          if (prRes.ok) {
            const prData = await prRes.json();
            branch = prData.head?.ref || '';
            prNumber = prData.number;
          }
        } catch (e) {
          // Could not fetch PR
        }
        ghEventType = 'pr_comment_mention';
        mentionPrompt = ghPayload.comment?.body || '';
      } else if (ghEvent === 'pull_request' && ghPayload.action === 'closed' && ghPayload.pull_request?.merged === true) {
        ghEventType = 'pr_merged';
        branch = ghPayload.pull_request?.head?.ref || '';
        prNumber = ghPayload.pull_request?.number;
      }

      if (!ghEventType || !branch) {
        return new Response(JSON.stringify({ ignored: true, reason: 'unhandled-gh-event' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Only process claudopilot/* branches
      if (!branch.startsWith('claudopilot/')) {
        return new Response(JSON.stringify({ ignored: true, reason: 'non-claudopilot-branch', branch }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Extract task ID from branch name: claudopilot/{taskId} or claudopilot/{taskId}-slug
      const branchSuffix = branch.replace('claudopilot/', '');
      const ghTaskId = branchSuffix.split('-')[0] || branchSuffix;

      // ─── PR merged → mark task + subtasks as done ───
      if (ghEventType === 'pr_merged') {
        // Fetch task with subtasks to mark everything done
        let taskData = null;
        try {
          const taskRes = await fetch(
            'https://api.clickup.com/api/v2/task/' + ghTaskId + '?include_subtasks=true',
            { headers: { Authorization: '${clickupApiKey}' } }
          );
          if (taskRes.ok) taskData = await taskRes.json();
        } catch (e) { /* proceed without subtask data */ }

        // Mark incomplete subtasks as done
        const subtasks = taskData?.subtasks || [];
        for (const sub of subtasks) {
          if (sub.status?.status?.toLowerCase() !== 'done') {
            await fetch('https://api.clickup.com/api/v2/task/' + sub.id, {
              method: 'PUT',
              headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'done' }),
            });
          }
        }

        // Update parent task to done
        const updateRes = await fetch(
          'https://api.clickup.com/api/v2/task/' + ghTaskId,
          {
            method: 'PUT',
            headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'done' }),
          }
        );

        if (!updateRes.ok) {
          const errBody = await updateRes.text();
          return new Response('ClickUp update failed: ' + errBody, { status: 502 });
        }

        // Post comment with notify_all
        await fetch(
          'https://api.clickup.com/api/v2/task/' + ghTaskId + '/comment',
          {
            method: 'POST',
            headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              comment_text: '[CLAUDOPILOT] ✅ PR #' + prNumber + ' merged — task and subtasks moved to done.',
              notify_all: true,
            }),
          }
        );

        return new Response(
          JSON.stringify({ done: true, source: 'github', event_type: 'pr_merged', task_id: ghTaskId }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Dispatch to GitHub Actions
      const ghDispatchRes = await fetch(
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
              task_id: ghTaskId,
              branch: branch,
              pr_number: prNumber,
              event_type: ghEventType,
              reviewer: reviewer || '',
              mention_prompt: mentionPrompt || '',
              status: 'fixing',
            },
          }),
        }
      );

      if (!ghDispatchRes.ok) {
        const body = await ghDispatchRes.text();
        // Best-effort: notify ClickUp task about dispatch failure
        try {
          await fetch(
            'https://api.clickup.com/api/v2/task/' + ghTaskId + '/comment',
            {
              method: 'POST',
              headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
              body: JSON.stringify({
                comment_text: '❌ [CLAUDOPILOT] GitHub Actions dispatch failed — the workflow could not be triggered. Check GitHub PAT permissions and repository settings.',
                notify_all: true,
              }),
            }
          );
          await fetch(
            'https://api.clickup.com/api/v2/task/' + ghTaskId,
            {
              method: 'PUT',
              headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'blocked' }),
            }
          );
        } catch (e) {
          // Best-effort — don't block the error response
        }
        return new Response('GitHub dispatch failed: ' + body, { status: 500 });
      }

      return new Response(
        JSON.stringify({ dispatched: true, source: 'github', event_type: ghEventType, task_id: ghTaskId, branch }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ─── ClickUp webhook handler ───
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

    const results = { automations: [], dispatch: false };

    // ─── Automations rules engine ───
    const BOARDS = ${JSON.stringify(automationBoards)};
    const RULES = ${JSON.stringify(automationRules)};

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
                results.automations.push({ action: 'update_linked', task: link.task_id, status: action.update_linked.status });
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
                results.automations.push({ action: 'comment_linked', task: link.task_id });
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
                  results.automations.push({ action: 'create_and_link', created: created.id, board: action.create_and_link.board });
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
                  results.automations.push({ action: 'assign_linked', task: link.task_id, userId: action.assign_linked.userId });
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
                  results.automations.push({ action: 'unassign_linked', task: link.task_id });
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
                  results.automations.push({ action: 'tag_linked', task: link.task_id, tag: action.tag_linked.tag });
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
              results.automations.push({ action: 'create_link', taskId: action.create_link.taskId });
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
                    event_type: 'clickup-automations',
                    client_payload: {
                      task_id: taskId,
                      task_name: taskData.name || '',
                      rule_name: rule.name,
                      prompt: action.dispatch.prompt,
                    },
                  }),
                }
              );
              results.automations.push({ action: 'dispatch', rule: rule.name });
            } catch (e) {
              // Continue processing
            }
          }

          if (action.mention) {
            const mentionText = (action.mention.text || '')
              .replace(/\\{\\{status\\}\\}/g, newStatus || '')
              .replace(/\\{\\{taskName\\}\\}/g, taskData.name || '');
            // Build structured comment array with proper ClickUp @mention tags
            const userId = Number(action.mention.userId);
            const commentParts = [];
            const mentionRegex = /@[\\w\\s]+/g;
            let lastIndex = 0;
            let match;
            while ((match = mentionRegex.exec(mentionText)) !== null) {
              if (match.index > lastIndex) {
                commentParts.push({ text: mentionText.slice(lastIndex, match.index) });
              }
              commentParts.push({ type: 'tag', user: { id: userId } });
              lastIndex = match.index + match[0].length;
            }
            if (lastIndex < mentionText.length) {
              commentParts.push({ text: mentionText.slice(lastIndex) });
            }
            if (commentParts.length === 0) {
              commentParts.push({ text: mentionText });
            }
            try {
              await fetch(
                'https://api.clickup.com/api/v2/task/' + taskId + '/comment',
                {
                  method: 'POST',
                  headers: {
                    Authorization: '${clickupApiKey}',
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    comment: commentParts,
                    notify_all: false,
                    assignee: userId,
                  }),
                }
              );
              results.automations.push({ action: 'mention', task: taskId, userId: action.mention.userId });
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
        JSON.stringify({ task_id: taskId, event: eventType, automations: results.automations }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const triggers = ['planning', 'approved', 'verifying'];
    const SDLC_LIST_IDS = ${JSON.stringify(sdlcListIds)};

    // Only dispatch planning/approved for tasks on the main claudopilot list
    const GATE_TAG = '${dispatchGateTag || ""}';
    const taskTags = (taskData?.tags || []).map(t => t.name?.toLowerCase());
    const gateOk = !GATE_TAG || taskTags.includes(GATE_TAG.toLowerCase());

    if (!triggers.includes(newStatus) || (taskData && !SDLC_LIST_IDS.includes(taskData.list?.id)) || !gateOk) {
      return new Response(
        JSON.stringify({ task_id: taskId, status: newStatus, automations: results.automations, gated: !gateOk }),
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
      // Best-effort: notify ClickUp task about dispatch failure
      try {
        await fetch(
          'https://api.clickup.com/api/v2/task/' + taskId + '/comment',
          {
            method: 'POST',
            headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              comment_text: '❌ [CLAUDOPILOT] GitHub Actions dispatch failed — the workflow could not be triggered. Check GitHub PAT permissions and repository settings.',
              notify_all: true,
            }),
          }
        );
        await fetch(
          'https://api.clickup.com/api/v2/task/' + taskId,
          {
            method: 'PUT',
            headers: { Authorization: '${clickupApiKey}', 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'blocked' }),
          }
        );
      } catch (e) {
        // Best-effort — don't block the error response
      }
      return new Response('GitHub dispatch failed: ' + body, {
        status: 500,
      });
    }

    return new Response(
      JSON.stringify({ dispatched: true, task_id: taskId, status: newStatus, automations: results.automations }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};
`;

/**
 * Ensure a ClickUp webhook exists pointing to the given worker URL.
 * Cleans up suspended webhooks for the same host and creates a new one if missing.
 */
async function ensureClickUpWebhook(
  workerUrl: string,
  webhookConfig: WebhookEnsureConfig
): Promise<void> {
  const adapter = new ClickUpAdapter(webhookConfig.clickupApiKey);
  const workerHost = new URL(workerUrl).hostname;

  const spinner = ui.spinner("Ensuring ClickUp webhook...");
  try {
    const webhooks = await adapter.getWebhooks(webhookConfig.workspaceId);
    const matching = webhooks.filter((w) => w.endpoint.includes(workerHost));

    // Clean up suspended webhooks for this worker
    for (const wh of matching) {
      if (wh.health.status === "suspended") {
        try {
          await adapter.deleteWebhook(wh.id);
          ui.info(`  Removed suspended webhook ${wh.id}`);
        } catch {
          // Non-fatal — continue
        }
      }
    }

    // Check if a healthy webhook still exists after cleanup
    const healthy = matching.filter((w) => w.health.status !== "suspended");

    // Also check if the secret matches the current worker URL
    const configSecret = new URL(workerUrl).searchParams.get("secret");
    const secretMatch = healthy.find((w) => {
      try {
        return new URL(w.endpoint).searchParams.get("secret") === configSecret;
      } catch {
        return false;
      }
    });

    if (secretMatch) {
      spinner.succeed("  ClickUp webhook: already registered, secret matches");
      return;
    }

    // Remove healthy-but-wrong-secret webhooks for this host (stale deploys)
    for (const wh of healthy) {
      try {
        await adapter.deleteWebhook(wh.id);
        ui.info(`  Removed stale webhook ${wh.id} (secret mismatch)`);
      } catch {
        // Non-fatal
      }
    }

    // Determine which events the webhook needs
    const webhookEvents = ["taskStatusUpdated"];
    if (webhookConfig.automationsConfig?.enabled) {
      const events = webhookConfig.automationsConfig.rules.map(
        (r) => r.when.event ?? "status_changed"
      );
      if (events.includes("created")) webhookEvents.push("taskCreated");
      if (events.includes("tag_added") || events.includes("tag_removed"))
        webhookEvents.push("taskTagUpdated");
    }

    await adapter.createWebhook(
      webhookConfig.workspaceId,
      workerUrl,
      webhookEvents
    );
    spinner.succeed("  ClickUp webhook created → Cloudflare Worker");
  } catch (error) {
    spinner.fail(`  ClickUp webhook registration failed: ${error}`);
    ui.warn("You can register the webhook manually or re-run 'claudopilot init'");
  }
}

export async function deployCloudflareWorker(
  cfConfig: CloudflareConfig,
  githubConfig: GitHubConfig,
  githubPat: string,
  clickupApiKey?: string,
  automationsConfig?: AutomationsConfig,
  sdlcListIds?: string[],
  webhookConfig?: WebhookEnsureConfig
): Promise<string> {
  // Reuse existing webhook secret from config URL on redeploy to avoid breaking registered webhooks
  let webhookSecret: string | undefined;
  if (cfConfig.workerUrl) {
    try {
      const existingUrl = new URL(cfConfig.workerUrl);
      webhookSecret = existingUrl.searchParams.get("secret") || undefined;
    } catch {
      // Malformed URL, generate new secret
    }
  }
  if (!webhookSecret) webhookSecret = generateSecret();
  const githubRepo = `${githubConfig.owner}/${githubConfig.repos[0]}`;

  const spinner = ui.spinner("Deploying Cloudflare Worker...");

  try {
    const workerName = cfConfig.workerName || "claudopilot-webhook";

    // Extract automation boards and rules for the worker
    const automationBoards = automationsConfig?.enabled ? automationsConfig.boards : {};
    const automationRules = automationsConfig?.enabled
      ? automationsConfig.rules.map((r) => ({
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
      automationBoards,
      automationRules,
      automationsConfig?.dispatchGateTag || undefined
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

    // Ensure ClickUp webhook points to this worker
    if (webhookConfig) {
      await ensureClickUpWebhook(workerUrl, webhookConfig);
    }

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
