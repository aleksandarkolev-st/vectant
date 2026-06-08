# Agent Browser MCP Status

Date: 2026-06-08

## Current Status

The teach-to-workflow path is implemented and verified across the local Docker/cloud-IDE development stack:

```text
agent/client -> Synthi MCP -> workflow bridge -> broker -> hosted Playwright browser/runtime -> screenshots/events/actions
```

Local CDP remains a development harness only. The tested user-facing path is the hosted runtime and injected browser toolbox inside the managed preview, with the IDE Workflows panel used for contract, manifest, export, validation, and publish state.

## Verified Coverage

The comprehensive workflow pipeline passed 11 seeded projects. Each case seeded a workspace, detected the actual running preview port, observed through the hosted browser toolbox, taught the workflow, compiled the contract, exported Playwright, validated replay state, and ran the generated Playwright script.

The latest run also asserted that exported scripts do not embed forwarded preview paths such as `/port/<runtime-port>`. Generated scripts now take the app or forwarded preview URL through `PLAYWRIGHT_BASE_URL`.

Passed cases:

- `clipboard-copy-cut-textarea`
- `multi-select-controls`
- `range-slider`
- `custom-aria-slider`
- `pointer-sortable`
- `splitter-resizer`
- `hidden-file-input-upload`
- `keyboard-control-keys`
- `terminal-text-entry`
- `wheel-zoom-surface`
- `animated-saas-dashboard`

Most recent comprehensive command:

```bash
SYNTHI_WORKFLOW_PIPELINE_CASES=clipboard-copy-cut-textarea,multi-select-controls,range-slider,custom-aria-slider,pointer-sortable,splitter-resizer,hidden-file-input-upload,keyboard-control-keys,terminal-text-entry,wheel-zoom-surface,animated-saas-dashboard \
SYNTHI_HOSTED_BROWSER_CDP_URL=http://127.0.0.1:36895 \
SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL=http://127.0.0.1:9466 \
FRONTEND_URL=http://localhost:3000 \
COLLAB_URL=http://localhost:1234 \
timeout 1200s npm run live:browser:workflow-pipeline
```

Result:

```text
[ok] workflow pipeline passed 11 seeded project(s)
artifacts=/mnt/c/Users/dev/Downloads/synthi-test/synthi-ide/tmp/workflow-pipeline-e2e
```

Additional artifact scan:

```text
no forwarded port literals in rerun exported specs
```

Additional verification run before the comprehensive pass:

```bash
npx vitest run tests/unit/playwright_adapter.test.ts tests/unit/browser_replay_generation.test.ts
npm run typecheck
npm run build
```

Results:

```text
56 unit tests passed
typecheck passed
build passed
```

## Recent Implementation Commits

- `fafd5fc9` Flush pending teach effects before next action
- `c253b476` Parameterize animated dashboard pipeline replay
- `1a43ab14` Align pointer sortable pipeline with prefix replay
- `e75467b4` Align range slider pipeline with prefix replay
- `85ce9dc9` Teach custom ARIA slider drags
- `ef208d6a` Teach wheel pan zoom workflows
- `906b8ee6` Parameterize custom ARIA option replay
- `864ccc46` Support hidden file input workflow replay

## What Works Now

- Hosted browser toolbox for Observe, Teach, and Stop inside the managed preview.
- IDE Workflows panel for compile, manifest, export, validate, replay history, and publish state.
- Auto-detected workspace preview ports through the collab port forwarding path.
- Same-session replay for non-mutating workflows.
- Prefix-only replay for workflows that reach a mutation boundary.
- Generated Playwright scripts that parameterize fill/select/range/terminal/custom-option values instead of baking in the taught values.
- Generated Playwright scripts require `PLAYWRIGHT_BASE_URL` for proxied workspace previews instead of embedding the detected forwarded port.
- Hidden file inputs replayed with `setInputFiles` and `toBeAttached` instead of visibility assertions.
- Calibrated pointer drag replay for sortable lanes, splitter resize, and custom ARIA sliders.
- Modifier wheel replay with mouse positioning, keyboard modifiers, and real wheel deltas.
- Rapid keyboard control key capture with stable per-step observed effects.

## Remaining Gaps

These are not blockers for the current local demo path, but they remain before calling the product generally production-ready:

- Multi-tab and popup workflows need broader live coverage beyond the existing smaller popup fixtures.
- Closed Shadow DOM still requires an explicit app bridge or must remain blocked.
- Canvas/WebGL semantics need app-provided semantic affordances; generic pixel-level canvas automation is intentionally not promised.
- Auth durability needs real IdP checkpoint and refresh-provider testing against actual SSO providers.
- Full mutation replay should run only in an isolated CI profile with a resettable base URL and explicit mutation permission.
- Published private MCP tool handoff should get an end-to-end agent-client acceptance test against a real configured agent.
- The repository has a pre-existing git maintenance issue: commits succeed, but git gc reports `fatal: bad tree object be45a9be79c6f1bc8c246ace783ac807a93ab469`.

## Demo Environment

Current local services for the verified run:

- Frontend: `http://localhost:3000`
- Collab server: `http://localhost:1234`
- Workflow bridge: `http://127.0.0.1:9466/browser-workflows/state`
- Hosted browser CDP harness: `http://127.0.0.1:36895`

The live demo workspace URL should be generated by the live harness or pipeline seed output for the current run. Do not hardcode slugs or preview ports.
