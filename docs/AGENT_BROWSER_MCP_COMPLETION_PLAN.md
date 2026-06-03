# Agent Browser MCP Completion Plan

Status: draft implementation plan
Scope: browser MCP, teach mode, screenshots, consent, leases, replay, and normal-user onboarding
Principle: screenshots are the primary observation channel. Runtime/DOM data is supporting evidence, not the default replacement for visual observation.

## Goal

Make Synthi's browser MCP feel like a normal senior-developer workflow:

1. A developer opens a Synthi workspace.
2. They connect an MCP-capable agent from Codex, Claude Code, Cursor, or another client.
3. The agent attaches to the approved Synthi-hosted browser session for that workspace.
4. The developer grants exact-origin visibility and, when needed, control.
5. The developer can start teach mode, select regions/elements, perform actions, and let the agent observe.
6. The agent can inspect screenshots, DOM metadata, console, network, and trace events through the broker only.
7. The agent can generate and replay stable Playwright scripts.
8. The developer can revoke visibility or control immediately.

The browser broker remains the single authority. Agents must never talk directly to raw CDP or raw extension events.

## Cloud IDE Boundary

Synthi is a cloud IDE. The default product must not require access to the user's personal browser, personal tabs, or local PC.

The browser MCP targets a Synthi-owned runtime:

- a hosted browser service owned by Synthi
- a browser/viewer attached to the workspace
- workspace preview tabs opened inside that hosted browser
- the Synthi workspace tab/viewer presented to the user through the cloud IDE

When this plan says `browser tab`, it means a tab inside the Synthi-managed browser session unless explicitly marked as local-dev mode. It does not mean every tab the user has open on their laptop.

Local CDP is only a development harness:

- useful for testing the MCP package locally
- useful for debugging from WSL or a local workstation
- not the normal cloud product path

The cloud product path is:

```text
agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime -> screenshots/events/actions
```

The user should not need to paste a local Chrome CDP URL in normal use.

## Current State

Implemented and tested:

- `synthi_browser_attach`
- `synthi_browser_list_tabs`
- `synthi_browser_select_tab`
- `synthi_browser_open`
- `synthi_browser_request_consent`
- `synthi_browser_get_consent`
- `synthi_browser_revoke_consent`
- `synthi_browser_snapshot`
- `synthi_browser_start_teach`
- `synthi_browser_stop_teach`
- `synthi_browser_get_trace`
- `synthi_browser_generate_script`
- `synthi_browser_acquire_lease`
- `synthi_browser_release_lease`
- `synthi_browser_action`
- `synthi_browser_wait`
- `synthi_browser_get_console`
- `synthi_browser_get_network`
- Browser broker for origin consent, selected tab state, teach-mode state, active input lease, redaction, and event filtering.
- Exact-origin consent filtering for tab enumeration and snapshots.
- Screenshot plus DOM snapshot through Playwright/CDP.
- Console and network redaction.
- Locator ranking with confidence and fallback candidates.
- Replay generation with fallback locators, waits, and assertions.
- Local browser bridge server for teach-mode events.
- Dev-only unpacked Chrome extension for explicit teach-mode overlay events.
- Persistent workspace live harness: `npm run live:browser:workspace`.

Known limitation: the live harness proves backend behavior, but it still bypasses the real human-facing pairing flow. The extension and workspace UI are not yet productized.

## Target User Flow

### Workspace Flow

1. Developer opens a hosted Synthi workspace.
2. Workspace shows an Agent panel with:
   - MCP connection status
   - selected Synthi-hosted browser tab or workspace preview
   - current origin
   - consent state
   - screenshot visibility state
   - teach-mode state
   - active control lease state
   - revoke buttons
3. Developer clicks `Connect agent`.
4. Workspace presents client-specific MCP setup:
   - Codex config
   - Claude Code command
   - Cursor config
   - generic stdio command
5. Developer starts the agent client, or uses an in-workspace agent already running in Synthi.
6. Agent calls `synthi_browser_attach` with a workspace-scoped token/session, not a local PC browser endpoint.
7. Broker attaches to the Synthi-hosted browser/runtime for that workspace.
8. Workspace receives attach status and prompts for exact-origin consent.
9. Developer grants screenshot visibility for the exact origin.
10. Agent can list authorized hosted tabs and request screenshots.
11. Developer can start teach mode.
12. Workspace teach overlay lets developer select regions/elements and perform actions.
13. Agent reads teach trace and generates a Playwright script.
14. Agent requests a control lease before actions.
15. Developer can revoke lease, teach mode, screenshot visibility, diagnostics, or origin consent at any time.

### Agent Flow

The agent should be able to follow a stable instruction:

```text
Use the Synthi browser MCP. Attach to the current browser session, request consent for the workspace origin, inspect the screen, wait for the user's teach-mode trace, generate a replay script, and ask before taking a control lease.
```

The agent should not need to know whether the browser is hosted, containerized, or local-dev CDP. Those details are runtime configuration, not hardcoded behavior.

### Local Dev Flow

The current `npm run live:browser:workspace` flow is for MCP developers. It launches or attaches to a local Chromium-family browser over CDP and opens a real Synthi workspace URL.

That flow validates the backend, but it is not the intended end-user cloud flow.

## Architecture

### Browser Broker

The broker is the only authority for:

- selected tab identity
- CDP target id
- extension tab id
- hosted browser session id
- workspace id/slug
- frame id
- current URL
- current origin
- consent state
- screenshot visibility state
- console/network visibility state
- teach-mode state
- active input lease
- queued action cancellation
- redaction
- event filtering
- allowed actions
- audit events

Agents call MCP tools. MCP tools call the broker. The broker calls the Playwright/CDP adapter or accepts bridge events only after validating consent, token, tab, frame, and origin.

### Hosted Browser Adapter

The product adapter owns low-level cloud browser mechanics:

- create or attach to a workspace-owned hosted browser
- enumerate hosted tabs/pages
- open/select hosted pages
- capture screenshots
- collect DOM sample
- collect accessibility metadata
- instrument console/network events
- execute broker-approved actions
- wait for page conditions
- stream screenshots or viewport updates to the workspace UI

It must not decide policy. Every visibility or control decision belongs to the broker.

### Playwright/CDP Adapter

The local-dev adapter owns low-level browser mechanics for test harnesses:

- connect over CDP
- enumerate pages
- open/select pages
- capture screenshot
- collect DOM sample
- collect accessibility metadata
- instrument console/network events
- execute broker-approved actions
- wait for page conditions

It must not decide policy. Every visibility or control decision belongs to the broker.

### Workspace Teach Overlay

The product teach overlay runs in Synthi's workspace UI and hosted browser/viewer. It owns user interaction:

- visible teach-mode overlay
- region selection
- element picking
- human action capture
- frame and iframe awareness for hosted previews
- popup awareness for hosted previews
- visual consent indicators
- pairing to the workspace session

It must not decide policy. It can only send events to the broker/bridge. The broker accepts or rejects events.

### Browser Extension

The browser extension is optional and local-dev or advanced-user infrastructure. It is not the default cloud IDE path.

The extension owns user interaction only when the user explicitly chooses to connect a local browser:

- visible teach-mode overlay
- region selection
- element picking
- human action capture
- frame and iframe awareness
- popup awareness
- visual consent indicators
- local bridge pairing

It must not decide policy. It can only send events to the local bridge. The broker accepts or rejects events.

### Workspace UI

The workspace UI owns the user-facing flow:

- connect agent panel
- MCP client setup snippets
- session status
- consent prompts
- teach-mode controls
- screenshot permission controls
- lease status and revoke controls
- audit/event timeline
- hosted browser status
- troubleshooting for hosted browser, in-workspace agent, external MCP clients, WSL, Docker, and local-dev CDP

The workspace UI should not expose raw bridge tokens after pairing.

## Permission Model

Use separate permission tiers. Do not collapse all observation into one boolean.

### Attached

Agent has spawned the MCP and attached to a browser endpoint.

Allowed:

- MCP health
- broker state summary
- no screenshots
- no DOM text
- no console logs
- no network URLs
- no tab details except redacted pending authorization state

### Origin Consent

Developer approves one exact origin.

Rules:

- Consent does not cross subdomains.
- Consent does not cross ports.
- Consent does not cross schemes.
- Consent does not follow redirects automatically.
- Revocation immediately removes selected tab if it is on that origin.

Allowed:

- authorized tab listing for that exact origin
- current URL and title for authorized tabs
- snapshot requests only if screenshot visibility is also allowed

### Screenshot Visibility

Developer approves visual observation.

Allowed:

- screenshot capture
- screenshot-based page inspection
- visual diffing
- visual assertions

Not allowed:

- arbitrary JS evaluation
- cookies/localStorage/sessionStorage dumping
- hidden input dumping
- cross-origin frame introspection without matching consent

### Diagnostics Visibility

Developer approves diagnostics.

Allowed:

- redacted console logs
- redacted network URLs
- request/response metadata without sensitive body capture

Diagnostics can be split later into console-only and network-only if the UX needs it.

### Teach Recording

Developer explicitly starts teach mode.

Allowed:

- selected regions/elements
- human click/type/select/check actions
- element metadata needed for locators
- screenshot crops for selected regions if screenshot visibility is active

Rules:

- Teach mode pauses or stops on origin change unless the new exact origin is approved.
- Teach mode events outside the active tab/frame are rejected.
- Bridge messages require a valid token.
- Page-origin requests cannot claim another origin.

### Control Lease

Developer or policy grants temporary input control.

Allowed:

- click
- fill/type
- press
- select
- check/uncheck
- wait
- navigate only to approved origins unless explicitly allowed

Rules:

- Every action requires a valid unexpired lease.
- Lease revocation clears queued actions.
- Human action during an agent lease is logged and should either revoke or mark the lease conflicted according to policy.
- Lease max duration remains short by default.

## Screenshot Policy

Screenshots are first-class. They are the agent's primary way to verify what a user would actually see.

Requirements:

- No screenshot before exact-origin consent and screenshot visibility consent.
- Screenshot responses include tab id, URL, origin, timestamp, viewport, and redaction status.
- Screenshots are blocked on denied origins.
- Screenshots are blocked after redirects to unapproved origins.
- Screenshots are blocked for unauthorized popups and iframes.
- Region screenshots are allowed only when their owner frame origin is approved.
- Snapshot tests must assert that denied origins produce no screenshot bytes.

DOM and accessibility metadata can accompany screenshots, but they are supporting data. The product stance is visual-first.

## Locator and Replay Policy

Locator ranking order:

1. `getByRole`
2. `getByLabel`
3. `getByPlaceholder`
4. `getByTestId`
5. stable visible text
6. stable CSS
7. XPath as last resort

Every recorded action should include:

- primary locator
- confidence
- fallback candidates
- element role/name/label/test id where available
- frame id
- origin
- URL
- optional screenshot crop reference when screenshot visibility is active

Generated scripts must include:

- `PLAYWRIGHT_BASE_URL`
- waits before actions
- visibility assertions
- value assertions after fills
- fallback locator helper
- warnings for low-confidence locators
- comments for iframe/popup handling where automatic generation is uncertain

## Implementation Phases

### Phase 1: Broker Permission Hardening

Deliverables:

- Add explicit broker permission tiers for screenshot visibility and diagnostics visibility.
- Split `snapshot` into policy-aware fields: screenshot, DOM sample, title, URL, console, network.
- Ensure denied origins return no screenshot, DOM text, console, network, title, or URL detail beyond a safe error.
- Add redirect-origin checks after navigation and before snapshot.
- Add lease revocation clearing for queued actions.
- Add audit entries for every consent, revoke, teach, screenshot, diagnostics, lease, and denied request.

Acceptance:

- Unit tests cover exact-origin boundaries.
- Unit tests prove denied origins leak no sensitive observation data.
- Live harness still passes with explicit screenshot permission.

### Phase 2: Workspace Agent Panel

Deliverables:

- Add workspace Agent panel.
- Show MCP connection status.
- Show current workspace URL and origin.
- Show active Synthi-hosted browser session.
- Show local-dev CDP session only when running the local harness.
- Provide client-specific setup snippets.
- Provide `Copy MCP config` for Codex, Claude Code, Cursor, and generic stdio.
- Show consent state.
- Add grant/revoke buttons for origin, screenshot visibility, diagnostics, teach mode, and control lease.
- Show recent audit events.

Acceptance:

- A normal developer can open the workspace and understand how to connect an MCP client without reading source code.
- No hardcoded Chrome path.
- No raw token displayed after pairing.

### Phase 3: Extension Pairing and Teach Overlay

Deliverables:

- Add workspace teach overlay for hosted browser/viewer sessions.
- Add hosted-browser pairing flow between workspace UI, broker, and MCP.
- Add region selection.
- Add element selection.
- Capture human click/type/select/check actions during teach mode.
- Include iframe origin metadata.
- Include popup metadata.
- Stop/pause teach mode on unapproved origin changes.
- Show local visual status: disconnected, paired, consented, teaching, blocked.
- Keep the Chrome extension as optional local-dev/advanced-user mode.
- Replace manual service-worker-console extension config only for that optional local mode.

Acceptance:

- User can start teach mode in a cloud workspace without installing an extension.
- User can start teach mode from workspace UI.
- User can select an element and the agent receives a broker-approved trace event.
- Bad bridge token and origin spoof tests pass.

### Phase 4: Agent Control Flow

Deliverables:

- Add explicit control lease UI.
- Add lease countdown.
- Add revoke button.
- Add human-action-during-agent-lease policy.
- Ensure agent actions are visible in audit timeline.
- Ensure queued actions are interrupted on revocation.
- Add safe navigation policy.

Acceptance:

- Agent cannot act without lease.
- Revoking lease interrupts pending action queue.
- Human action during active lease is logged and handled deterministically.

### Phase 5: Replay Hardening

Deliverables:

- Add replay fixtures for React, Vue, Svelte, delayed hydration, shadow DOM, iframe, popup, duplicate labels, and flaky locators.
- Add generated-script tests for env placeholders.
- Add locator confidence threshold warnings.
- Add iframe-aware generation.
- Add popup-aware generation.
- Add screenshot-backed replay verification where possible.

Acceptance:

- Replay generated from teach mode succeeds across the fixture matrix.
- Low-confidence replay cases emit warnings instead of pretending to be stable.

### Phase 6: Live Harness and Docs

Deliverables:

- Keep `npm run live:browser` as isolated fixture smoke.
- Keep `npm run live:browser:workspace` as local-dev real workspace smoke.
- Add hosted-browser live smoke once the Synthi-hosted browser adapter exists.
- Add `npm run live:browser:workspace:headed` convenience script if useful.
- Update `mcp/synthi-mcp/TESTING.md` with the persistent workspace flow.
- Add troubleshooting for hosted browser sessions, workspace-scoped tokens, in-workspace agents, external MCP clients, WSL, Docker Desktop, host networking, CDP URL reachability, Chrome executable discovery, and optional extension pairing.
- Add screenshots of the expected Agent panel and extension states once UI exists.

Acceptance:

- A developer can reproduce the full flow from docs on a clean machine.
- CI can run a headless one-shot workspace smoke with `--no-keep-browser`.
- Manual QA can run a headed persistent workspace flow.
- Cloud QA can run the hosted-browser flow without local CDP or a local Chrome extension.

## Security Test Matrix

Add tests for:

- Consent does not cross subdomains.
- Consent does not cross ports.
- Consent does not cross schemes.
- Consent does not follow redirects.
- Denied origins produce no screenshot.
- Denied origins produce no DOM text.
- Denied origins produce no console data.
- Denied origins produce no network data.
- Denied origins produce no title/current URL detail beyond safe error.
- Teach mode stops or pauses on unapproved origin change.
- Bridge rejects bad tokens.
- Bridge rejects missing page origin.
- Bridge rejects page-origin spoofing.
- CDP target enumeration hides unauthorized tabs.
- Password redaction works.
- Token redaction works.
- Secret query-param redaction works.
- Iframe consent works.
- Popup consent works.
- Lease revocation interrupts queued actions.
- Human action during agent lease is logged and handled.

## Replay Test Matrix

Add fixtures for:

- Dynamic React page.
- Dynamic Vue page.
- Dynamic Svelte page.
- Shadow DOM component.
- Same-origin iframe.
- Cross-origin iframe.
- Delayed hydration.
- Duplicate button labels.
- Generated script with `PLAYWRIGHT_BASE_URL`.
- Generated script with environment placeholders.
- Flaky locator fallback behavior.
- Low-confidence XPath fallback warning.
- Screenshot-backed visual assertion after replay.

## MCP Tool Surface

Keep and document:

- `synthi_browser_attach`
- `synthi_browser_list_tabs`
- `synthi_browser_select_tab`
- `synthi_browser_open`
- `synthi_browser_request_consent`
- `synthi_browser_get_consent`
- `synthi_browser_revoke_consent`
- `synthi_browser_snapshot`
- `synthi_browser_start_teach`
- `synthi_browser_stop_teach`
- `synthi_browser_get_trace`
- `synthi_browser_generate_script`
- `synthi_browser_acquire_lease`
- `synthi_browser_release_lease`
- `synthi_browser_action`
- `synthi_browser_wait`
- `synthi_browser_get_console`
- `synthi_browser_get_network`

Clarify or add:

- `synthi_browser_attach_workspace`
- `synthi_browser_get_broker_state`
- `synthi_browser_set_visibility_permission`
- `synthi_browser_set_diagnostics_permission`
- `synthi_browser_pair_workspace_overlay`
- `synthi_browser_pair_extension`
- `synthi_browser_get_audit_log`
- `synthi_browser_revoke_all`

The added tools are product hardening helpers. They should not expose raw CDP or raw extension internals.
`synthi_browser_pair_extension` is for optional local browser mode only; the normal cloud path should use workspace/browser-session pairing.

## Open Design Decisions

### Extension Required vs Optional

Option A: extension required for teach mode.

- Stronger human interaction capture.
- Better overlay UX.
- More setup friction.

Option B: workspace teach overlay required for cloud teach mode, extension optional for local browser mode.

- No local install for normal cloud users.
- Better fit for Synthi-owned hosted browser sessions.
- Still allows an advanced local-browser path later.

Recommendation: workspace teach overlay is required for full cloud teach mode. The extension is optional local-dev/advanced-user infrastructure, not the default path.

### Screenshot Redaction

Screenshots are visual-first, but they may contain secrets.

Options:

- No screenshot redaction in MVP, rely on explicit consent.
- Mask form fields before screenshot where possible.
- Support user-drawn private regions.

Recommendation: MVP requires explicit screenshot consent and blocks denied origins. Follow with private-region masking.

### Hosted Browser vs Local Browser

Local CDP works for development but is wrong as the normal cloud IDE path. Synthi does not control the user's PC and should not ask normal users to expose local browser debugging endpoints.

Options:

- hosted browser controlled by Synthi
- local browser CDP for MCP developers
- extension connects the user's existing browser for advanced explicit local mode

Recommendation: make the hosted browser the product path. Keep local CDP as a developer harness and compatibility adapter only.

## Definition of Done

The remaining work is done when:

- A developer can open a Synthi workspace and connect an MCP client from visible UI instructions.
- The agent can attach without manually copying hidden bridge details.
- The agent attaches to a Synthi-hosted browser/runtime by default, not the user's personal browser.
- The developer can grant screenshot visibility for one exact origin.
- The agent can inspect screenshots only for approved origins.
- The developer can start teach mode from the workspace.
- The workspace teach overlay records real human selections and actions.
- The agent can generate a Playwright replay from the trace.
- The agent can request and use a short control lease.
- The developer can revoke consent or lease immediately.
- Security tests cover the full boundary matrix.
- Replay tests cover modern frontend edge cases.
- The hosted-browser harness validates the real cloud end-to-end flow.
- The local persistent workspace harness remains available for MCP package development.

## Suggested Work Order

1. Broker permission tiers and tests.
2. Hosted browser adapter and workspace-scoped attach flow.
3. Workspace Agent panel skeleton.
4. Workspace teach overlay productization.
5. Lease UI and human override handling.
6. Replay fixture matrix.
7. Documentation and live harness updates.

This order keeps the security boundary ahead of the UI, then turns the backend primitives into a normal developer workflow.
