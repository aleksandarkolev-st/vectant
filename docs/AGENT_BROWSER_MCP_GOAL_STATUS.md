# Agent Browser Workflow Production-Grade Status

Updated: 2026-06-09

## Current State

The browser workflow teaching path is implemented and verified through the cloud-IDE product route:

agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime -> screenshots/events/actions -> workflow contract -> private MCP tool -> Playwright replay.

This run did not add fixed preview ports, fixed workspace slugs, local Chrome paths, or case-specific generated-script shortcuts.

## Implemented In This Run

- Real MCP/private-tool acceptance over the spawned stdio MCP boundary:
  - Added `npm run live:browser:private-tool-stdio`.
  - Seeds an encrypted saved-workflow store, spawns `dist/index.js`, discovers `synthi_app_*` from `tools/list`, looks up the manifest over MCP, attaches to the configured hosted browser CDP, opens an OS-assigned fixture URL, calls the discovered private tool through `tools/call`, and captures a screenshot proving the action happened.
- Hosted browser lifecycle hardening for long live matrices:
  - The workflow pipeline now prunes stale CDP page targets before attach and closes per-case pages after each case.
  - This avoids attach slowdowns from hundreds of old tabs without relying on a fixed port or slug.
- Full workflow matrix proof:
  - 37 seeded projects passed.
  - Every case clicked the UI buttons, compiled, exported, generated manifest, published private tool, called the discovered private tool where parameters were available, validated, and ran the exported Playwright script.
  - Covered forms, parameterized input, clipboard paste/drop/copy/cut, iframes, open Shadow DOM, ARIA widgets, range sliders, pointer drag/sort/resize, animated SaaS dashboard, file uploads, hover menus, double-click/context menu, keyboard/control keys, terminal-like text entry, scroll/wheel surfaces, downloads, network mutation classification, CI-isolated mutation replay, native confirm/prompt dialogs, popups, rich text, textarea/code editor, dashboard workflows, and navigation/review queue.
- Mutation safety and isolated replay:
  - Mutation-heavy private tools defaulted to prefix-only replay unless isolation/confirmation was used.
  - CI isolated replay passed with `mutation=true` for the visual mutation fixture.
- Auth durability plumbing:
  - Unit tests cover encrypted auth checkpoint metadata, approved storage state restore, refresh-provider handoff, and CI isolated replay receiving validated auth provider storage state.

## Verification

Commands run successfully:

```bash
cd mcp/synthi-mcp
npm run typecheck
npm run build
TMPDIR=/tmp TEMP=/tmp TMP=/tmp npm run test:unit
TMPDIR=/tmp TEMP=/tmp TMP=/tmp SYNTHI_HOSTED_BROWSER_CDP_URL=http://127.0.0.1:43521 npm run live:browser:private-tool-stdio
TMPDIR=/tmp TEMP=/tmp TMP=/tmp SYNTHI_HOSTED_BROWSER_CDP_URL=http://127.0.0.1:43521 SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL=http://127.0.0.1:9466 FRONTEND_URL=http://localhost:3000 COLLAB_URL=http://localhost:1234 npm run live:browser:workflow-pipeline
```

Results:

- Unit suite: 70 files passed, 754 tests passed.
- Full workflow matrix: 37 seeded projects passed.
- Stdio private-tool acceptance: passed after final build.
- Typecheck/build: passed.

Visual proof artifacts:

- `tmp/private-tool-stdio-acceptance/after-private-tool-call.png`
- `tmp/workflow-pipeline-e2e/animated-saas-dashboard/after-validate-panel.png`
- `tmp/workflow-pipeline-e2e/popup-form-window/after-validate-panel.png`
- `tmp/workflow-pipeline-e2e/ci-isolated-visual-mutation/after-validate-panel.png`

Generated-script proof:

- The workflow matrix runs every generated Playwright script through a per-case Playwright runner.
- The per-case runner path prevents substring/spec collisions between cases such as file upload and hidden file upload.
- The matrix rejects forwarded `/port/<number>` literals in generated scripts.

## Commits From This Continuation

- `950f07aa` Prune stale hosted browser pages in workflow pipeline
- `d217a4ff` Add stdio private workflow acceptance proof

Earlier commits in the same goal also covered parameter naming, private tool parameter proof, exported-script runner isolation, and expectation alignment for mutation-safe prefix exports.

## Remaining Gaps

These are not blockers for the repo-local production-grade proof, but they are still the next hardening targets before broad external rollout:

- Real LLM-agent prompt acceptance is not yet automated. We now prove the actual stdio MCP boundary with raw JSON-RPC, but not an external Codex/Synthi LLM prompt choosing the tool by natural language.
- Real third-party IdP coverage is not yet complete. Auth storage/checkpoint/redaction paths are tested with fixtures and unit coverage; OAuth/SAML/magic-link providers against real external services still need environment-specific validation.
- Popup and iframe coverage is fixture-proven for opener-linked popups and same-origin iframes. More hostile cross-origin popup/iframe cases should be validated under production consent policy.
- CI isolated replay is proven for resettable fixture mutation workflows. Production teams still need per-workspace reset profiles, fixture users, and postcondition definitions configured for their apps.
- Git auto-gc still reports an unrelated bad tree object during commits: `be45a9be79c6f1bc8c246ace783ac807a93ab469`.
