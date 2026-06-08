# Agent Browser MCP Status

Updated: 2026-06-08

## Current Proof Point

Latest investor/demo workspace:

- `http://localhost:3000/workspace/workflow-pipeline-animated-saas-dashboard-mq5qu1x7`

The local proof stack used Docker frontend/collab services, a Synthi workflow bridge, and a Synthi-hosted browser CDP endpoint. App preview ports were detected dynamically through the workspace/collab port service; no workflow fixture relied on a hardcoded preview port.

## Implemented In This Goal

- Private MCP workflow tools are registered from taught workflow manifests and can be called without giving an agent a script path.
- Managed-browser Observe/Teach/Stop toolbox is injected by the hosted browser runtime path, while the IDE panel remains the contract/export/manifest/validation surface.
- Same-origin iframe and popup/new-tab workflows record target context and replay through generated Playwright.
- Exported Playwright scripts avoid forwarded-port literals and use `PLAYWRIGHT_BASE_URL` plus workflow parameters.
- Mutation workflows default to prefix-safe replay and require either explicit same-session confirmation or CI-isolated replay.
- CI-isolated replay runs reset/profile commands, requires `ALLOW_WORKFLOW_MUTATION=1`, executes the generated script, and reports pass/fail artifacts.
- Trace redaction is recursive, handles sensitive key names including camelCase forms, protects cyclic/deep structures, and prevents trace-injected auth durability from granting unattended replay.
- Auth checkpoint enrollment can only create checkpoint durability. Refresh-provider and CI-auth durability must come from configured and validated provider metadata.
- Workflow manifest, publish, direct replay, private-tool replay, and CI private-tool paths enforce live auth readiness.
- Auth checkpoint/provider metadata now sits behind a store boundary so production can swap in encrypted durable storage without changing tool behavior.
- CI-isolated replay profiles support a configured workspace working directory and run reset/replay commands there instead of relying on the MCP process cwd.

## Validation Evidence

Unit coverage:

- `npx vitest run tests/unit/auth_checkpoint.test.ts tests/unit/browser_broker.test.ts tests/unit/browser_workflow_contract.test.ts tests/unit/browser_replay_generation.test.ts tests/unit/browser_tools.test.ts tests/unit/private_tool_manifest.test.ts tests/unit/safety_tools.test.ts tests/unit/browser_workflow_bridge.test.ts`
- Result: 8 files passed, 168 tests passed.

Build/type coverage:

- `npm run typecheck`
- `npm run build`

Live browser/exported-script coverage:

- `SYNTHI_WORKFLOW_PIPELINE_CASES=popup-form-window,parameterized-form-data,ci-isolated-visual-mutation,animated-saas-dashboard npm run live:browser:workflow-pipeline`
- Result: 4 seeded projects passed in the final sweep.
- Each case clicked Observe/Teach/Stop in the managed browser, compiled/exported in the IDE panel, ran the exported Playwright script, and captured screenshots.

Key visual artifacts:

- `tmp/workflow-pipeline-e2e/animated-saas-dashboard/after-teach-actions.png`
- `tmp/workflow-pipeline-e2e/popup-form-window/after-teach-actions.png`
- `tmp/workflow-pipeline-e2e/ci-isolated-visual-mutation/after-teach-actions.png`

## Remaining Production Work

- Replace the current in-memory auth checkpoint store with encrypted, tenant-scoped browser storage checkpoint persistence and restore in the hosted runtime.
- Wire validated refresh providers and CI auth providers to actual hosted-browser auth-state minting, not only readiness policy.
- Run the private MCP tool acceptance test against a deployed agent client, not only the in-process MCP/private-tool registry.
- Expand target coverage for cross-origin iframes and popup chains that require separate consent grants per target.
- Move CI-isolated replay profile commands into first-class per-workspace infrastructure with database/app reset contracts.
- Add postcondition authoring UI so mutation workflows can assert saved/deleted/submitted state beyond observed text effects.
- Keep hardening adversarial fixtures: real IdP redirects, expired sessions, file uploads with large files, drag/drop edge cases, and multi-popup checkout flows.
