# Agent Browser Workflow Production-Grade Status

Updated: 2026-06-10

## Current State

The browser workflow teaching path is implemented and verified through the intended cloud-IDE route:

```text
agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime -> screenshots/events/actions -> workflow contract -> private MCP tool -> Playwright replay
```

Local CDP remains only the development harness. The verification run did not rely on fixed preview ports, fixed workspace slugs, local Chrome paths, fixed element positions, or generated-script shortcuts for a specific fixture.

Excluding real deployed IdP testing, the remaining work is about 5-8 percent. The main unfinished items are production rollout validation in third-party MCP hosts, hosted-runtime deployment wiring, and more adversarial target/auth fixtures under production policy.

## Latest Verification

Full workflow pipeline:

```bash
cd mcp/synthi-mcp
TMPDIR=/tmp TEMP=/tmp TMP=/tmp \
  SYNTHI_HOSTED_BROWSER_CDP_URL=http://127.0.0.1:43521 \
  FRONTEND_URL=http://localhost:3000 \
  COLLAB_URL=http://localhost:1234 \
  SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP=1 \
  npm run live:browser:workflow-pipeline
```

Result:

- 48 seeded projects passed.
- 0 failed checks in `tmp/workflow-pipeline-e2e/summary.json`.
- 46 generated Playwright exports were run and passed.
- 46 published private MCP workflows were called through a fresh MCP process.
- 27 cases captured visual live-replay or isolated-replay screenshots.
- Dynamic app ports were detected per case through the workspace/collab port service.
- Generated scripts rejected forwarded `/port/<number>` literals and used runtime base URLs.

Codex CLI private-tool acceptance was also attempted with `SYNTHI_CODEX_ACCEPTANCE_MODEL=gpt-5.3-spark`. The local ChatGPT-auth Codex CLI rejected that model for this account before calling tools, so the harness is now override-driven and does not hardcode a 5.5 fallback. The repo-local fresh MCP/private-tool path still passes; the 5.3-spark Codex-agent pass remains an environment-availability gap.

Visual artifacts inspected in this update:

- `tmp/workflow-pipeline-e2e/animated-saas-dashboard/after-live-replay.png`
- `tmp/workflow-pipeline-e2e/popup-chain-checkout/after-live-replay.png`
- `tmp/workflow-pipeline-e2e/ci-isolated-visual-mutation/after-ci-isolated-replay.png`

## Implemented

- Private MCP workflow tools are registered from taught workflow manifests and can be discovered through `tools/list`.
- Agents can call published `synthi_app_*` workflow tools without being handed script paths.
- Managed-browser Observe/Teach/Stop controls are injected by the hosted runtime path; the IDE Workflows panel remains the contract, manifest, export, validation, and publish surface.
- Same-origin iframes, nested iframes, popups, popup chains, and opener-return workflows preserve target context for replay.
- Cross-origin iframe and popup recording requires explicit target-origin consent and otherwise blocks taught actions.
- Clipboard paste/drop/copy/cut, file uploads, hidden file uploads, hover menus, context menus, keyboard controls, scroll/wheel, sliders, ARIA widgets, drag/sort/resize, native dialogs, rich text, code textareas, and animated dashboard interactions are covered by seeded live cases.
- Auth checkpoint and refresh-provider durability paths are covered by fixtures and unit tests with redaction and expiry classification.
- Mutation workflows default to prefix-safe replay and require same-session confirmation or isolated CI mutation replay.
- CI-isolated replay requires explicit reset/profile/postcondition configuration and run-bound mutation attestation.
- Exported Playwright scripts are executed by the live pipeline instead of only being inspected.

## Latest Commits In This Continuation

- `9db27d65` Correlate popup annotations across capture races
- `36fbdac4` Suppress cut-derived fill parameters
- `bce57661` Avoid private tool control parameter collisions

These sit on top of the earlier goal commits for private-tool registration, hosted overlay controls, exported-script runner isolation, target-origin consent, auth checkpointing, CI mutation replay, popup/iframe target handling, and visual replay proof.

## Remaining Gaps

- Validate the same private-tool discovery/call path in deployed third-party MCP hosts and production hosted-runtime policy, without local-dev CDP fallback.
- Wire production hosted-browser deployment config for the runtime, workflow bridge, private workflow store, encrypted auth checkpoint store, and per-workspace CI reset profiles.
- Expand adversarial target coverage for multiple simultaneous popups, hostile nested frame timing, and cross-origin return navigation under production consent rules.
- Keep real external IdP validation out of this run per current direction, but preserve fixture coverage for OAuth-like popups, refresh providers, checkpoint expiry, and re-auth classification.
- Add product UI for authoring mutation postconditions and reset profiles instead of configuring those only through workspace metadata.
- Run a final Codex CLI acceptance pass from inside a workspace with model `5.3-spark` when that model is available to the local/prod Codex account; the current local ChatGPT-auth Codex CLI rejects it before tool execution.
