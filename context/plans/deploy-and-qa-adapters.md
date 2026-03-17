# Plan: Deploy & QA Adapter Interfaces

## Context

Claudopilot currently has an adapter pattern for PM tools (`PMAdapter`). We need the same abstraction for deployment platforms and test runners so the implement workflow can deploy feature branches and run QA regardless of the underlying tools.

Real-world usage drives the initial implementations:
- **Personal projects**: Vercel (git-push deploys) + Jest/Playwright
- **Lega**: Azure + Terraform (explicit `terraform apply`) + pytest/Playwright

## Deploy Adapter

### Interface

```typescript
interface DeployAdapter {
  name: string;

  // Deploy a branch and return the preview URL
  deploy(branch: string, opts?: DeployOptions): Promise<DeployResult>;

  // Poll/check deploy status
  getStatus(deployId: string): Promise<DeployStatus>;

  // Optional: promote a preview to production
  promote?(deployId: string): Promise<void>;
}

interface DeployOptions {
  environment?: string; // e.g. "preview", "staging"
}

interface DeployResult {
  id: string;
  url: string;
  status: "pending" | "building" | "ready" | "failed";
}

type DeployStatus = DeployResult;
```

### Implementations

| Adapter | Trigger mechanism | Notes |
|---------|------------------|-------|
| **Vercel** | Git-push driven — deploy happens automatically on push. Adapter polls Vercel API for preview URL. | Needs `VERCEL_TOKEN` and project ID |
| **Azure/Terraform** | Explicit — runs `terraform apply` with a variable for the branch/slot. | Needs Azure credentials + Terraform workspace config |
| **None/Skip** | No-op adapter for projects without deploy requirements | Returns a stub result |

### Key design decision

The adapter hides *how* the deploy triggers. The workflow just calls `deploy(branch)` and waits for a URL. Vercel's adapter detects the deploy that git push already triggered; Azure's adapter initiates one.

## QA Adapter

### Interface

```typescript
interface QAAdapter {
  name: string;
  capabilities: QACapabilities;

  // Run the test suite and return results
  run(opts?: QARunOptions): Promise<QAResult>;
}

interface QACapabilities {
  unit: boolean;       // Can run unit/integration tests
  e2e: boolean;        // Can run browser-based E2E tests
  needsDeployUrl: boolean; // E2E tests need a live URL to target
}

interface QARunOptions {
  deployUrl?: string;  // Provided if capabilities.needsDeployUrl
  suite?: string;      // Specific test suite/path to run
}

interface QAResult {
  passed: boolean;
  summary: string;     // Human-readable summary
  total: number;
  passed_count: number;
  failed_count: number;
  output: string;      // Raw test output
}
```

### Implementations

| Adapter | Capabilities | Run command |
|---------|-------------|-------------|
| **Jest** | `{ unit: true, e2e: false, needsDeployUrl: false }` | `npm test` / `npx jest` |
| **Playwright** | `{ unit: false, e2e: true, needsDeployUrl: true }` | `npx playwright test` with `BASE_URL` env var |
| **Cypress** | `{ unit: false, e2e: true, needsDeployUrl: true }` | `npx cypress run` with `CYPRESS_BASE_URL` |
| **Pytest** | `{ unit: true, e2e: false, needsDeployUrl: false }` | `pytest` |
| **Composite** | Wraps multiple adapters (e.g. Jest + Playwright) | Runs each in sequence |

### Composite adapter

Projects often have both unit and E2E tests. A `CompositeQAAdapter` takes multiple adapters and runs them in order — unit tests first (fast, no deploy needed), E2E second (only if a deploy URL is available).

## Integration into the implement workflow

The implement command's finalize step currently: push → create PR → post to ClickUp.

New flow:
1. Push branch
2. **Deploy**: call `deployAdapter.deploy(branch)`, poll until ready
3. **QA (unit)**: run adapters where `needsDeployUrl === false`
4. **QA (E2E)**: run adapters where `needsDeployUrl === true`, passing the deploy URL
5. Create PR (include test results and preview URL in PR body)
6. Post to ClickUp

If deploy or QA fails, the workflow posts the failure to ClickUp and stops before creating the PR.

## Config shape

```yaml
# .claudopilot.yaml
deploy:
  adapter: vercel          # vercel | azure-terraform | none
  vercel:
    projectId: prj_xxx
  # or
  azure:
    resourceGroup: my-rg
    appName: my-app
    terraformWorkspace: feature

qa:
  adapters:
    - type: jest
      command: npm test
    - type: playwright
      command: npx playwright test
      baseUrlEnv: BASE_URL   # env var name to pass deploy URL
```

## Secrets

New entries in `.claudopilot.env`:
- `VERCEL_TOKEN` (if using Vercel adapter)
- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` (if using Azure)

## Open questions

- Should deploy/QA run in GitHub Actions (current workflow) or locally via Claude Code? Actions is more reproducible but slower to iterate on.
- For Azure/Terraform: should we manage the Terraform state, or assume it's already set up and just run `apply`?
- PR creation: block on QA failure, or create PR with a failing status check and let the human decide?
