# Agent Browser Workflow Production-Grade Status

Updated: 2026-06-10

## Current State

The browser workflow teaching path is implemented and verified through the intended cloud-IDE route:

```text
agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime -> screenshots/events/actions -> workflow contract -> private MCP tool -> Playwright replay
```

Local CDP remains only the development harness. The verification run did not rely on fixed preview ports, fixed workspace slugs, local Chrome paths, fixed element positions, or generated-script shortcuts for a specific fixture.

Excluding real deployed IdP testing, the remaining work is about 1 percent. The main unfinished items are production rollout validation in deployed third-party MCP hosts and final account-available Codex `5.3-spark` acceptance from inside a workspace.

## Latest Verification

Full workflow pipeline:

```bash
cd mcp/synthi-mcp
TMPDIR=/tmp TEMP=/tmp TMP=/tmp \
  SYNTHI_HOSTED_BROWSER_CDP_URL="$DYNAMIC_HOSTED_CDP_URL" \
  FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}" \
  COLLAB_URL="${COLLAB_URL:-http://localhost:1234}" \
  SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP=1 \
  npm run live:browser:workflow-pipeline
```

`DYNAMIC_HOSTED_CDP_URL` is supplied by the local hosted-runtime harness during verification. It is not a product default, a fixed port, or a workspace-specific value.

Result:

- 48 seeded projects passed.
- 0 failed checks in `tmp/workflow-pipeline-e2e/summary.json`.
- 46 generated Playwright exports were run and passed.
- 46 published private MCP workflows were called through a fresh MCP process.
- 27 cases captured visual live-replay or isolated-replay screenshots.
- Dynamic app ports were detected per case through the workspace/collab port service.
- Generated scripts rejected forwarded `/port/<number>` literals and used runtime base URLs.

Codex CLI private-tool acceptance was also attempted with `SYNTHI_CODEX_ACCEPTANCE_MODEL=gpt-5.3-spark`. The local ChatGPT-auth Codex CLI rejected that model for this account before calling tools, so the harness is now override-driven and does not hardcode a 5.5 fallback. The repo-local fresh MCP/private-tool path still passes; the 5.3-spark Codex-agent pass remains an environment-availability gap.

The Codex private-tool acceptance harness now configures the MCP server through `SYNTHI_HOSTED_BROWSER_CDP_URL`, `SYNTHI_HOSTED_BROWSER_WORKSPACE_URL`, and `SYNTHI_WORKSPACE_ID`, prompts the agent to call `synthi_browser_attach_current_workspace`, and rejects evidence that used the local `synthi_browser_attach` CDP path. Local CDP remains only the outer dev harness used to supply a Synthi-hosted runtime endpoint during local verification.

The stdio MCP private-tool acceptance harness was also verified through the hosted attach path:

- transcript: `tmp/private-tool-stdio-acceptance/mcp-stdio-private-tool-acceptance.json`
- visual proof: `tmp/private-tool-stdio-acceptance/after-private-tool-call.png`
- discovered tool: `synthi_app_open_details`
- attach evidence: `hosted_attach=true`, `local_attach=false`, `runtime_kind=hosted`
- replay evidence: one private-tool workflow step replayed through MCP stdio and produced the expected app state.

Deployment readiness is now machine-checkable through `synthi_browser_get_deployment_readiness`. The report is redacted and verifies hosted runtime config, workflow bridge config/token policy, encrypted private workflow store config, encrypted auth checkpoint store config, workspace scope, replay-isolation profile state, and absence of local CDP env leakage in production mode.

Targeted replay-isolation verification:

- Portable replay-isolation profile manifests can be passed into MCP safety tools and merged with workspace overrides.
- CI-isolated replay now requires the selected auth checkpoint to be explicitly active for the taught workflow.
- The IDE Workflows panel surfaces CI replay profile readiness from MCP state and dispatches `synthi_safety_run_ci_isolated_replay` without hardcoded workspace slugs, ports, or fixture assumptions.
- The Workflows panel now hydrates replay-isolation profile state from the bridge, lets a developer edit base URL, CI/reset/assertion/postcondition commands, profile ids, seed ids, working directory, auth provider id, and mutation permission, then saves a portable `synthi.replayIsolationProfile.v1` manifest through the existing MCP safety tool.
- Codex private-tool acceptance is wired to the hosted-runtime attach path and has unit coverage that rejects local CDP attach evidence.
- Stdio private-tool acceptance is also wired to the hosted-runtime attach path; the spawned MCP process receives hosted runtime env only and strips `SYNTHI_BROWSER_CDP_URL`.
- Production deployment wiring has an MCP preflight with unit coverage for hosted runtime, workflow bridge, encrypted stores, workspace scope, and local CDP leakage.
- Simultaneous popup annotation races are hardened: queued popup annotations no longer attach backward to earlier opener clicks outside a bounded browser-event skew window.
- Nested iframe workflow target ids include durable frame-locator chain context when needed, so repeated inner frame ids do not collapse distinct replay targets.
- Generated replay scripts now cover returning to the opener page after consented cross-origin popup actions.
- Direct `synthi_browser_run_workflow` replay now re-checks current iframe and popup target-origin consent before dispatching adapter actions, matching the private-tool consent gate.
- Published private workflow MCP schemas now advertise `artifact_root` for strict clients calling `ciOnly` isolated replay.

Visual artifacts inspected in this update:

- `tmp/workflow-pipeline-e2e/animated-saas-dashboard/after-live-replay.png`
- `tmp/workflow-pipeline-e2e/popup-chain-checkout/after-live-replay.png`
- `tmp/workflow-pipeline-e2e/ci-isolated-visual-mutation/after-ci-isolated-replay.png`
- `tmp/private-tool-stdio-acceptance/after-private-tool-call.png`
- `tmp/agent-workflow-ci-profile-card.png`
- `tmp/agent-workflow-ci-profile-editor-card.png`

## Implemented

- Private MCP workflow tools are registered from taught workflow manifests and can be discovered through `tools/list`.
- Agents can call published `synthi_app_*` workflow tools without being handed script paths.
- The Codex acceptance harness uses hosted workspace attach evidence for private MCP tools instead of local attach evidence, while remaining model-configurable for `5.3-spark`.
- The stdio MCP acceptance harness uses `synthi_browser_attach_current_workspace` and rejects local-dev CDP attachment evidence.
- `synthi_browser_get_deployment_readiness` gives deployers and agents a redacted readiness gate before relying on browser workflow tools in production.
- Managed-browser Observe/Teach/Stop controls are injected by the hosted runtime path; the IDE Workflows panel remains the contract, manifest, export, validation, and publish surface.
- Same-origin iframes, nested iframes, popups, popup chains, and opener-return workflows preserve target context for replay.
- Close-together popup opener clicks preserve their own popup tab ids and URLs instead of sharing a broad queued annotation window.
- Cross-origin iframe and popup recording and direct replay require current explicit target-origin consent and otherwise block before adapter dispatch.
- Clipboard paste/drop/copy/cut, file uploads, hidden file uploads, hover menus, context menus, keyboard controls, scroll/wheel, sliders, ARIA widgets, drag/sort/resize, native dialogs, rich text, code textareas, and animated dashboard interactions are covered by seeded live cases.
- Auth checkpoint and refresh-provider durability paths are covered by fixtures and unit tests with redaction and expiry classification.
- Mutation workflows default to prefix-safe replay and require same-session confirmation or isolated CI mutation replay.
- CI-isolated replay requires explicit reset/profile/postcondition configuration and run-bound mutation attestation.
- Replay-isolation profiles have a portable manifest schema that can be registered with MCP safety tools and carried across workspace/runtime boundaries.
- The Workflows panel now shows CI replay profile readiness and exposes a CI replay action when the MCP profile state is ready.
- The Workflows panel can author and edit replay-isolation profiles without fixed ports, fixed workspace slugs, local Chrome paths, or fixture-specific command guesses.
- Exported Playwright scripts are executed by the live pipeline instead of only being inspected.

## Latest Commits In This Continuation

- `6977ff62` Use hosted attach in stdio private tool acceptance
- `6760eff9` Mock hosted capture in teach alias test
- `f3868e68` Enforce replay target origin consent
- `f1ca5422` Advertise private workflow artifact root
- `89b432c4` Cover cross-origin popup return replay
- `d544bf77` Disambiguate nested iframe workflow targets
- `94cec3a7` Disambiguate simultaneous popup annotations
- `d6494d3c` Add browser workflow deployment readiness preflight
- `70df51f0` Use hosted runtime in Codex workflow acceptance
- `6859f454` Add replay isolation profile authoring
- `41053f36` Surface CI replay profiles in workflows panel
- `7b9006d7` Select auth checkpoint in CI replay test
- `174ccfc1` Add replay isolation profile manifests
- `a234240f` Make Codex workflow acceptance model configurable
- `c054e919` Update browser workflow goal status
- `9db27d65` Correlate popup annotations across capture races
- `36fbdac4` Suppress cut-derived fill parameters
- `bce57661` Avoid private tool control parameter collisions

These sit on top of the earlier goal commits for private-tool registration, hosted overlay controls, exported-script runner isolation, target-origin consent, auth checkpointing, CI mutation replay, popup/iframe target handling, and visual replay proof.

## Remaining Gaps

- Validate the same private-tool discovery/call path in deployed third-party MCP hosts and production hosted-runtime policy, not just the repo-local Codex/fresh-MCP harness.
- Expand adversarial target coverage only for production-host-specific timing/target-policy variants that cannot be simulated in local unit/live fixtures.
- Keep real external IdP validation out of this run per current direction, but preserve fixture coverage for OAuth-like popups, refresh providers, checkpoint expiry, and re-auth classification.
- Run a final Codex CLI acceptance pass from inside a workspace with model `5.3-spark` when that model is available to the local/prod Codex account; the current local ChatGPT-auth Codex CLI rejects it before tool execution.
