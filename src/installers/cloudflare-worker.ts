import { ui } from "../utils/ui.js";
import type { CloudflareConfig, GitHubConfig } from "../types.js";

const WORKER_SCRIPT = (
  githubRepo: string,
  githubPat: string,
  webhookSecret: string,
  clickupApiKey: string
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

    // ClickUp sends different event shapes
    const taskId = payload.task_id;
    const historyItems = payload.history_items || [];
    const statusChange = historyItems.find(
      (item) => item.field === 'status'
    );

    if (!statusChange) {
      return new Response('Not a status change', { status: 200 });
    }

    const newStatus = statusChange.after?.status?.toLowerCase();
    const triggers = ['planning', 'approved'];

    if (!triggers.includes(newStatus)) {
      return new Response('Status not tracked', { status: 200 });
    }

    // Fetch task name from ClickUp
    let taskName = '';
    try {
      const taskRes = await fetch(
        'https://api.clickup.com/api/v2/task/' + taskId,
        {
          headers: {
            Authorization: '${clickupApiKey}',
          },
        }
      );
      if (taskRes.ok) {
        const taskData = await taskRes.json();
        taskName = taskData.name || '';
      }
    } catch (e) {
      // Continue without task name
    }

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
      JSON.stringify({ dispatched: true, task_id: taskId, status: newStatus }),
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
  clickupApiKey?: string
): Promise<string> {
  const webhookSecret = generateSecret();
  const githubRepo = `${githubConfig.owner}/${githubConfig.repos[0]}`;

  const spinner = ui.spinner("Deploying Cloudflare Worker...");

  try {
    const workerName = cfConfig.workerName || "claudopilot-webhook";

    // Upload the worker script
    const scriptContent = WORKER_SCRIPT(
      githubRepo,
      githubPat,
      webhookSecret,
      clickupApiKey || ""
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
