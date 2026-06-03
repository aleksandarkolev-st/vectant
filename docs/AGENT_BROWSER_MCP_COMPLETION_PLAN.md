# Agent Browser MCP Completion Plan

Status: draft implementation plan
Scope: browser MCP, teach mode, screenshots, consent, leases, replay, and normal-user onboarding
Principle: screenshots are the primary observation channel. Runtime/DOM data is supporting evidence, not the default replacement for visual observation.

## Goal

Make Synthi's browser MCP feel like a normal senior-developer workflow:

1. A developer opens a Synthi workspace.
2. They connect an MCP-capable agent from Codex, Claude Code, Cursor, or another client.
3. The agent attaches to the approved browser session.
4. The developer grants exact-origin visibility and, when needed, control.
5. The developer can start teach mode, select regions/elements, perform actions, and let the agent observe.
6. The agent can inspect screenshots, DOM metadata, console, network, and trace events through the broker only.
7. The agent can generate and replay stable Playwright scripts.
8. The developer can revoke visibility or control immediately.

The browser broker remains the single authority. Agents must never talk directly to raw CDP or raw extension events.

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

1. Developer starts Synthi locally or opens a hosted Synthi workspace.
2. Workspace shows an Agent panel with:
   - MCP connection status
   - selected browser tab
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
5. Developer starts the agent client.
6. Agent calls `synthi_browser_attach`.
7. Workspace receives attach status and prompts for exact-origin consent.
8. Developer grants visibility for the exact origin.
9. Agent can list authorized tabs and request screenshots.
10. Developer can start teach mode.
11. Browser overlay lets developer select regions/elements and perform actions.
12. Agent reads teach trace and generates a Playwright script.
13. Agent requests a control lease before actions.
14. Developer can revoke lease, teach mode, or origin consent at any time.

### Agent Flow

The agent should be able to follow a stable instruction:

```text
Use the Synthi browser MCP. Attach to the current browser session, request consent for the workspace origin, inspect the screen, wait for the user's teach-mode trace, generate a replay script, and ask before taking a control lease.
```

The agent should not need to know whether the browser was launched by Chrome, Playwright Chromium, Docker, WSL, or a hosted session. Those details are runtime configuration, not hardcoded behavior.

## Architecture

### Browser Broker

The broker is the only authority for:

- selected tab identity
- CDP target id
- extension tab id
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

### Playwright/CDP Adapter

The adapter owns low-level browser mechanics:

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

### Browser Extension

The extension owns user interaction:

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
- troubleshooting for WSL, Docker, and hosted cases

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
- Show active browser/CDP session if available.
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

- Replace manual service-worker-console config with a pairing flow.
- Add visible extension overlay.
- Add region selection.
- Add element selection.
- Capture human click/type/select/check actions during teach mode.
- Include iframe origin metadata.
- Include popup metadata.
- Stop/pause teach mode on unapproved origin changes.
- Show local visual status: disconnected, paired, consented, teaching, blocked.

Acceptance:

- User can pair extension without opening DevTools.
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
- Keep `npm run live:browser:workspace` as real workspace smoke.
- Add `npm run live:browser:workspace:headed` convenience script if useful.
- Update `mcp/synthi-mcp/TESTING.md` with the persistent workspace flow.
- Add troubleshooting for WSL, Docker Desktop, host networking, CDP URL reachability, Chrome executable discovery, and extension pairing.
- Add screenshots of the expected Agent panel and extension states once UI exists.

Acceptance:

- A developer can reproduce the full flow from docs on a clean machine.
- CI can run a headless one-shot workspace smoke with `--no-keep-browser`.
- Manual QA can run a headed persistent workspace flow.

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

- `synthi_browser_get_broker_state`
- `synthi_browser_set_visibility_permission`
- `synthi_browser_set_diagnostics_permission`
- `synthi_browser_pair_extension`
- `synthi_browser_get_audit_log`
- `synthi_browser_revoke_all`

The added tools are product hardening helpers. They should not expose raw CDP or raw extension internals.

## Open Design Decisions

### Extension Required vs Optional

Option A: extension required for teach mode.

- Stronger human interaction capture.
- Better overlay UX.
- More setup friction.

Option B: extension optional, CDP-only fallback.

- Easier setup.
- Worse element-picking UX.
- More fragile teach capture.

Recommendation: extension required for full teach mode, CDP-only allowed for agent-driven observation/control.

### Screenshot Redaction

Screenshots are visual-first, but they may contain secrets.

Options:

- No screenshot redaction in MVP, rely on explicit consent.
- Mask form fields before screenshot where possible.
- Support user-drawn private regions.

Recommendation: MVP requires explicit screenshot consent and blocks denied origins. Follow with private-region masking.

### Hosted Browser vs Local Browser

Local CDP works for development but is awkward for normal users.

Options:

- local browser CDP only
- hosted browser controlled by Synthi
- extension connects the user's existing browser

Recommendation: keep local CDP for developer MVP, design broker APIs so hosted browser can plug in later.

## Definition of Done

The remaining work is done when:

- A developer can open a Synthi workspace and connect an MCP client from visible UI instructions.
- The agent can attach without manually copying hidden bridge details.
- The developer can grant screenshot visibility for one exact origin.
- The agent can inspect screenshots only for approved origins.
- The developer can start teach mode from the workspace.
- The extension overlay records real human selections and actions.
- The agent can generate a Playwright replay from the trace.
- The agent can request and use a short control lease.
- The developer can revoke consent or lease immediately.
- Security tests cover the full boundary matrix.
- Replay tests cover modern frontend edge cases.
- The persistent workspace harness validates the real end-to-end flow.

## Suggested Work Order

1. Broker permission tiers and tests.
2. Workspace Agent panel skeleton.
3. Extension pairing flow.
4. Teach overlay productization.
5. Lease UI and human override handling.
6. Replay fixture matrix.
7. Documentation and live harness updates.

This order keeps the security boundary ahead of the UI, then turns the backend primitives into a normal developer workflow.
