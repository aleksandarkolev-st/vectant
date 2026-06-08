# Agent Workflow Teaching Completion Plan

Status: draft implementation plan
Scope: cloud IDE workflow teaching, hosted browser screenshots, causal replay, Playwright generation, broker safety, and codebase-aware hardening
Lead product bet: a developer teaches Synthi a browser workflow once inside the cloud IDE, and Synthi converts it into a reliable, maintainable Playwright workflow tied to the workspace codebase.

## Product Wedge

Do not position this as generic browser automation. That space is crowded: browser MCPs, browser codegen, hosted browser services, CDP tools, and screenshot/action loops already exist.

The defensible wedge is:

```text
Teach Synthi a browser workflow once.
Synthi turns it into a reliable test, replay, or fix loop.
```

Synthi can make this stronger than generic browser tools because it owns the cloud IDE, the codebase, the preview runtime, the hosted browser, and the agent loop at the same time.

Everything in this plan serves one first use case:

```text
Generate durable E2E tests and reusable browser workflows from manual teach-mode usage.
```

Secondary use cases:

- debug frontend behavior with an agent that can see the live app
- turn repetitive UI tasks into workspace scripts
- create reproducible bug reports from taught traces
- let frontend developers, QA, PMs, and support teach workflows without knowing Playwright
- run taught workflows after code changes and let the agent explain failures

## User Experience

The average user should not see MCP internals. They should experience this as a browser-aware coding assistant inside Synthi.

The intended flow:

1. Open a Synthi workspace.
2. Open the app preview.
3. Connect the agent.
4. Allow the agent to view screenshots of this preview.
5. Click `Teach workflow`.
6. Perform the workflow once.
7. Click `Generate test` or `Generate workflow`.
8. Run the generated replay.
9. Let the agent fix failures or suggest source patches.

Good UI language:

- `Allow agent to view this preview?`
- `Start teaching`
- `Generate test`
- `Run workflow`
- `Open fix`

Bad UI language for normal users:

- `Acquire control lease`
- `Grant exact-origin consent`
- `Inspect broker state`
- `Pair extension`
- `Paste CDP endpoint`

The Agent panel should be split into five simple views:

- `Connect`: agent status and setup only
- `Observe`: selected preview, screenshot visibility, basic diagnostics
- `Teach`: start/stop, taught step count, compile status
- `Run`: replay status, control permission, action log
- `History`: generated workflows, recordings, audit events

Local-dev CDP state should only appear behind a developer flag.

## Cloud IDE Boundary

Synthi is a cloud IDE. The normal product path must not require access to the user's personal browser, personal tabs, or local PC.

The browser MCP targets a Synthi-owned runtime:

- a hosted browser service owned by Synthi
- a browser/viewer attached to the workspace
- preview pages opened inside that hosted browser
- screenshots streamed back into the workspace
- actions routed through the broker

When this plan says `browser tab`, it means a tab/page inside the Synthi-managed browser session unless explicitly marked as local-dev mode. It does not mean every tab the user has open on their laptop.

Local CDP is only a development harness:

- useful for testing the MCP package locally
- useful for debugging from WSL or a workstation
- not the cloud product path

The cloud product path is:

```text
agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime -> screenshots/events/actions
```

The user should not need to paste a local Chrome CDP URL in normal use.

## Current State

Implemented and tested at the MCP/backend level:

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
- browser broker for origin consent, selected tab state, teach-mode state, active input lease, redaction, and event filtering
- exact-origin consent filtering for tab enumeration and snapshots
- screenshot plus DOM snapshot through Playwright/CDP
- console and network redaction
- basic locator ranking with confidence and fallback candidates
- replay generation with fallback locators, waits, and assertions
- local browser bridge server for teach-mode events
- dev-only unpacked Chrome extension for explicit teach-mode overlay events
- persistent local workspace live harness: `npm run live:browser:workspace`

Known limitations:

- The current harness proves backend behavior but not the cloud user flow.
- The hosted browser adapter is not productized.
- The workspace Agent panel is not productized.
- Teach mode captures actions, not workflow intent.
- Replay generation is still too close to locator generation.
- The current plan needs a workflow contract compiler before replay can be durable.

## MVP Cut

The MVP should prove the useful loop, not every browser edge case.

Include in MVP:

- workspace Agent panel skeleton
- hosted browser attach for the current workspace preview
- screenshot observation with explicit user approval
- workspace teach overlay for one same-origin preview
- minimal taught trace with before/after screenshots
- causal workflow contract compiler for the taught trace
- one generated Playwright test/workflow
- replay in a CI-like runner
- failure explanation for replay failures
- source patch suggestion when a stable locator is missing

Cut from MVP:

- optional local browser extension
- console/network diagnostics UI
- broad external MCP onboarding polish
- popup support
- full iframe support
- multi-tab workflows
- long audit timeline
- broad client-specific setup matrix
- advanced lease conflict policy

Keep the cuts in the roadmap. Do not let them block the first useful loop.

## Target User Story

A developer is building a dashboard.

They say:

```text
Teach this flow as a regression test.
```

They click through:

1. Login mock.
2. Open dashboard.
3. Filter by date.
4. Click export.
5. Confirm the download button appears.

Synthi generates:

- a Playwright test
- stable locators
- intent comments
- assertions
- screenshots or screenshot diffs
- warnings for weak selectors
- a suggested source patch if the UI lacks stable automation hooks

Then the user says:

```text
Now run this after the refactor.
```

The agent runs it. If it fails, Synthi shows:

```text
Step 3 failed. The date filter button is no longer visible.
Likely cause: DateRangePicker changed in src/components/DateRangePicker.tsx.
Suggested fix: add data-synthi-affordance="dashboard.date-filter.open"
or update the workflow intent if the filter moved.
```

That is the product value.

## Workflow Contract Compiler

Do not generate Playwright directly from the raw trace. Compile the trace into a causal workflow contract, harden that contract, then emit Playwright.

Raw trace:

```text
click input
type value
click Save
toast appears
```

Workflow contract:

```text
Before the step, the settings form is visible and dirty.
The user intends to persist updated settings.
The primary submit affordance should be clicked.
After the step, dirty state clears, a success signal appears, and the update request completes.
Toast wording may change. The action fails hard if validation errors appear or the request fails.
```

### Data Captured During Teach Mode

Each taught step should capture:

- screenshot before action
- screenshot after action
- accessibility snapshot
- DOM metadata
- framework/component metadata when available
- clicked element candidates
- route state
- form state
- visible state delta
- network completion markers
- console/runtime events
- timing and hydration markers
- user input values
- viewport and device mode
- source component mapping where available

Screenshots remain the primary user-facing truth. DOM, accessibility, console, and network data explain why something is interactable or why it failed.

### Human Confirmation

Only ask the human when the compiler cannot infer intent safely.

Good one-click confirmations:

- `Was the goal to submit the form?`
- `Should this value be fixed or parameterized?`
- `Is this success message required?`
- `Should this step survive if the button text changes?`

Do not turn teach mode into a questionnaire.

### Contract Shape

Each compiled step should resemble:

```json
{
  "stepId": "save-settings",
  "intent": "persist updated settings",
  "preconditions": [
    "settings form is visible",
    "save button is enabled"
  ],
  "action": {
    "kind": "click",
    "preferredAffordance": "primary submit action in settings form"
  },
  "locatorCandidates": [
    "getByRole('button', { name: /save/i })",
    "data-synthi-affordance='settings.persist.primary'",
    "component:SettingsForm.SaveButton"
  ],
  "expectedEffects": [
    "dirty state clears",
    "success feedback appears",
    "settings update request completes"
  ],
  "toleratedVariants": [
    "toast wording changes",
    "button position changes",
    "layout switches mobile/desktop"
  ],
  "hardFailures": [
    "validation errors visible",
    "settings request fails",
    "route leaves settings unexpectedly"
  ],
  "recoveryRule": "wait-reobserve-relocate-once-then-classify",
  "dataBindings": {
    "displayName": "parameter",
    "apiBaseUrl": "environment",
    "submitCopy": "variant"
  }
}
```

### Required Step Fields

A reliable replay needs more than locators. Each step must include:

- preconditions: what must be true before the action
- action intent: why this control is being used
- preferred affordance: semantic target, not only raw label
- expected state transition: what should change after the action
- acceptable variants: what UI changes are tolerated
- hard failures: what must fail the workflow
- failure classifier: timing, locator drift, app bug, auth state, route change, test data issue, or environment issue
- recovery rule: retry, wait, re-locate, ask human, or fail hard
- data binding: constants, variables, generated test data, or environment values

Without this layer, Synthi will only generate nicer brittle scripts.

## Counterfactual Hardening

After the human teaches the flow once, Synthi should run a local counterfactual hardening pass against the workspace preview.

Counterfactual variants:

- viewport changes
- dark mode
- reduced motion
- delayed hydration
- slow network
- duplicated labels
- reordered DOM
- changed button copy
- hidden optional fields
- old cached bundle
- feature flag variants
- same-origin iframe boundary where relevant

A locator or assertion is accepted only if it survives the configured counterfactual runs.

This is materially different from normal codegen. Codegen records what happened. Synthi should compile what must remain true.

## Codebase-Aware Locator Strategy

The standard Playwright locator order is necessary but not differentiating:

1. `getByRole`
2. `getByLabel`
3. `getByPlaceholder`
4. `getByTestId`
5. stable visible text
6. stable CSS
7. XPath as last resort

Synthi should add a codebase-aware layer before falling back to weak selectors:

- prefer product-domain intent over raw UI label
- prefer source-backed component identity when workspace code is available
- map DOM nodes back to React/Vue/Svelte component files where possible
- suggest stable affordance attributes when no reliable locator exists
- generate source patches when the app is not automation-friendly

Preferred affordance attribute:

```html
<button data-synthi-affordance="settings.persist.primary">
  Save
</button>
```

Avoid silently falling back to brittle CSS or XPath. If no stable target exists, the compiler should either ask for confirmation or propose a source patch.

## Hosted Browser Runtime

The hosted browser adapter must be explicit. `Create or attach to a workspace-owned browser` is not enough.

Decisions to implement:

- browser pool warmup
- cold-start budget
- per-workspace session lifetime
- storage persistence policy
- auth state strategy for previews
- viewport defaults
- device emulation defaults
- file upload support
- download capture support
- multiple previews per workspace
- preview rebuild detection
- HMR/reload detection
- WebSocket reconnect behavior
- browser crash recovery
- session recording retention
- billing or quota model
- concurrent agents attached to one workspace
- screenshot streaming lifecycle
- worker/container placement

Initial recommendation:

- warm pool for Chromium workers
- one default browser session per active workspace
- default viewport `1440x900`
- resettable storage per workflow run
- same-origin preview support in MVP
- one agent observer plus one active controller at a time
- session recordings retained only for generated workflows and explicit bug reports

## Broker Authority

The broker remains the single policy authority.

It owns:

- workspace id/slug
- hosted browser session id
- selected preview/page
- current URL
- current origin
- screenshot visibility state
- diagnostics visibility state
- teach-mode state
- workflow recording state
- active control lease
- queued action cancellation
- redaction
- event filtering
- allowed actions
- audit events

Agents call MCP tools. MCP tools call the broker. The broker calls the hosted browser adapter, local-dev CDP adapter, or workspace teach overlay after validating consent, token, tab/page, frame, and origin.

Agents must never talk directly to raw CDP or raw overlay events.

## Permission Model

The user-facing model should be simple:

- `Allow agent to view this preview`
- `Start teaching`
- `Allow agent to run this workflow`
- `Revoke`

Internally, keep separate permission tiers:

- attached, no visibility
- exact-origin approval
- screenshot visibility
- diagnostics visibility
- teach recording
- control lease

Rules:

- Screenshot capture requires exact-origin approval and screenshot visibility.
- Consent does not cross subdomains, ports, schemes, or redirects.
- Denied origins produce no screenshot, DOM text, console, network, title, or current URL detail beyond a safe error.
- Teach mode pauses or stops on unapproved origin change.
- Control requires a short lease.
- Lease revocation clears queued actions.
- Human action during an agent lease is logged and handled deterministically.

## Screenshot Policy

Screenshots are first-class. They are the primary way Synthi verifies what a user would actually see.

Requirements:

- No screenshot before exact-origin approval and screenshot visibility.
- Screenshot responses include page id, URL, origin, timestamp, viewport, and redaction status.
- Screenshots are blocked on denied origins.
- Screenshots are blocked after redirects to unapproved origins.
- Region screenshots are allowed only when their owner frame origin is approved.
- Snapshot tests must assert that denied origins produce no screenshot bytes.

DOM and accessibility metadata can accompany screenshots, but they are supporting data.

## MCP Tool Surface

Agents should use fewer high-level tools by default.

Default high-level tools:

- `synthi_browser_attach_current_workspace`
- `synthi_browser_observe`
- `synthi_browser_begin_teach`
- `synthi_browser_end_teach`
- `synthi_browser_compile_workflow`
- `synthi_browser_run_workflow`
- `synthi_browser_explain_failure`

Keep lower-level tools for advanced/debug use:

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

Add or clarify:

- `synthi_browser_attach_workspace`
- `synthi_browser_get_broker_state`
- `synthi_browser_set_visibility_permission`
- `synthi_browser_set_diagnostics_permission`
- `synthi_browser_pair_workspace_overlay`
- `synthi_browser_get_workflow_contract`
- `synthi_browser_apply_affordance_patch`
- `synthi_browser_get_audit_log`
- `synthi_browser_revoke_all`

`synthi_browser_pair_extension` remains optional local browser infrastructure only.

## Implementation Phases

### Phase 0: Safety Floor

Deliverables:

- exact-origin screenshot consent
- screenshot denied-origin leak tests
- hosted workspace token shape
- broker state model for workspace id, preview id, origin, and screenshot permission

Acceptance:

- denied origins produce no screenshot bytes
- consent does not cross subdomain, port, scheme, or redirect
- the local live harness still passes

### Phase 1: Agent Panel Skeleton

Deliverables:

- Agent panel next to the preview
- `Connect`, `Observe`, `Teach`, `Run`, and `History` views
- fake broker data or fixture-backed state
- no local CDP fields unless dev flag is enabled

Acceptance:

- a user can understand the intended flow without knowing MCP, CDP, broker, bridge, or lease terms
- a developer can click through the panel with fixture data

### Phase 2: Hosted Browser Attach With Real Screenshot

Deliverables:

- hosted browser session for current workspace preview
- broker-mediated attach to that session
- first screenshot displayed in the Agent panel
- screenshot visibility approval UI
- basic observe tool wired to hosted screenshot

Acceptance:

- hosted browser attach p95 under 5 seconds with warm pool
- first screenshot p95 under 2 seconds after attach
- zero manual config for in-workspace agent path
- no local Chrome/CDP required

### Phase 3: Minimal Teach Overlay

Deliverables:

- `Teach workflow` button
- workspace overlay on hosted preview
- capture click/type/select/check actions
- capture screenshot before and after each action
- capture accessible target metadata
- stop recording and show taught step count

Acceptance:

- teach event delivery p95 under 250 ms
- one same-origin workflow records a complete trace
- trace includes before/after screenshots for each step

### Phase 4: First Workflow Contract and Playwright Output

Deliverables:

- trace-to-contract compiler
- intent inference per step
- precondition inference
- expected-effect inference
- parameter detection
- basic failure classifier
- Playwright emitter from contract
- generated test saved into the workspace

Acceptance:

- one taught flow compiles into a workflow contract
- generated script includes intent comments and failure explanations
- compiler refuses low-confidence output instead of emitting brittle XPath
- script passes same-session replay for the taught workflow

### Phase 5: CI-Like Replay Runner

Deliverables:

- run generated workflow in a fresh browser/session
- capture replay screenshots
- compare expected effects
- classify failures
- show failure explanation in Agent panel

Acceptance:

- generated script passes same-session replay at least 95 percent on MVP fixture suite
- generated script passes cold-session replay at least 85 percent on MVP fixture suite
- replay failure includes classified reason at least 90 percent of the time

### Phase 6: Counterfactual Teach Compiler

Deliverables:

- before/after visual delta extraction
- source component mapping
- counterfactual replay runner
- viewport and hydration variants
- duplicate-label variant
- text-change variant
- affordance patch generator
- source patch proposal UI

Acceptance:

- contract survives viewport, hydration, duplicate-label, and text-change variants
- compiler suggests source patch instead of XPath fallback
- generated script remains maintainable after accepted affordance patch

### Phase 7: Hardening and Roadmap Features

Deliverables:

- broader security test matrix
- console/network diagnostics UI
- iframe support
- popup support
- multi-tab workflows
- optional local browser extension pairing
- advanced lease conflict policy
- external MCP onboarding polish
- longer audit timeline and recordings

Acceptance:

- full security matrix passes
- replay fixture matrix passes
- hosted-browser cloud QA passes without local CDP or local extension
- local-dev harness remains available for MCP package development

## MVP Metrics

Use measurable gates:

- hosted browser attach p95 under 5 seconds with warm pool
- first screenshot p95 under 2 seconds after attach
- teach event delivery p95 under 250 ms
- generated script passes same-session replay at least 95 percent on MVP fixtures
- generated script passes cold-session replay at least 85 percent on MVP fixtures
- zero manual config for in-workspace agent path
- external MCP setup completed by a new developer in under 3 minutes after onboarding is in scope
- replay failure includes classified reason at least 90 percent of the time

## MVP Test Matrix

MVP fixtures:

- React page with form submit
- delayed hydration
- duplicate button labels
- changed button text
- viewport change
- slow network
- weak locator requiring affordance patch

MVP security tests:

- consent does not cross subdomains
- consent does not cross ports
- consent does not cross schemes
- consent does not follow redirects
- denied origins produce no screenshot
- denied origins produce no DOM text
- teach mode stops or pauses on unapproved origin change
- control action requires lease
- lease revocation interrupts queued actions

## Roadmap Test Matrix

Add later:

- Vue page
- Svelte page
- shadow DOM component
- same-origin iframe
- cross-origin iframe
- popup
- generated script with environment placeholders
- flaky locator fallback behavior
- low-confidence XPath fallback warning
- screenshot-backed visual assertion after replay
- denied origins produce no console data
- denied origins produce no network data
- denied origins produce no title/current URL detail beyond safe error
- bridge rejects bad tokens
- bridge rejects page-origin spoofing
- CDP target enumeration hides unauthorized tabs in local-dev mode
- password redaction
- token redaction
- secret query-param redaction
- human action during agent lease is logged and handled

## Definition of Done

The product loop is done when:

- a developer can open a Synthi workspace and connect the in-workspace agent with no local browser setup
- the agent attaches to a Synthi-hosted browser/runtime by default
- the user can allow screenshot visibility for the current preview
- the user can teach a same-origin workflow from the workspace overlay
- Synthi compiles the taught trace into a workflow contract
- Synthi generates a Playwright test/workflow from the contract
- Synthi runs that workflow in a fresh session
- failures are classified and explained
- weak locators produce source patch suggestions instead of silent brittle fallbacks
- the local persistent workspace harness remains available for MCP package development

The roadmap is done when:

- counterfactual hardening covers the full fixture matrix
- iframe, popup, multi-tab, diagnostics, extension, and external-client onboarding are productized
- security tests cover the full boundary matrix

## Suggested Work Order

1. Safety floor for screenshot consent and denied-origin leaks.
2. Agent panel skeleton with fixture state.
3. Hosted browser attach with real screenshot.
4. Minimal teach overlay recording one same-origin trace.
5. Workflow contract compiler for that trace.
6. Playwright emitter and same-session replay.
7. CI-like cold-session replay and failure classifier.
8. Counterfactual hardening and source affordance patches.
9. Broader security, diagnostics, iframe/popup, optional extension, external onboarding, and docs.

This order validates the end-to-end user loop early, then hardens it into a defensible workflow compiler.
