# WI-WEB Implementation Spec — LIVE website-flow transfer through the universal pipeline

Repo root: this directory (`mcp/synthi-mcp` package inside the IDE repo; git root is two levels up).
Branch: `feat/embodied-universal-teaching` (already checked out). Do NOT create branches.

## Mission

Prove the universal embodied teaching pipeline on the BROWSER substrate, live:
Agent A teaches a website flow through the substrate-neutral five verbs
(attach -> begin_teach -> perform_action -> end_teach -> export_skill), exports
`synthi.skill.v1`; Agent B — a SEPARATE OS PROCESS running
`scripts/bridge_agent.mts` — imports the skill, attaches to a FRESH server
instance (different port, different fixture data), runs it in `fresh_state`
mode, and the real server state proves the transfer. A structural twin lacking
the taught target attributes must FAIL discrimination.

This mirrors the proven terminal-substrate test
`tests/unit/embodied_nn_transfer_live.test.ts` (green, committed). Follow its
patterns exactly where applicable.

## Files you may change

1. `tests/unit/embodied_web_transfer_live.test.ts` — EXISTS but was written
   against imagined APIs; REWRITE it from scratch following the spec below.
2. `scripts/bridge_agent.mts` — ADD a browser-agent mode (env-driven), keeping
   all existing modes untouched (game WS url argv, kernel env, terminal env,
   license-file argv[4]).

Nothing else may change. If you believe a CORE file
(`src/embodied/**`, `src/browser_workflow_bridge/**`, `src/browser/embodied_adapter.ts`)
must change, prefer a test-side solution; if truly unavoidable, keep the change
minimal and LIST IT PRECISELY in the final report and commit message.

## Current API reality (verified — do not guess)

- Bridge HTTP: `POST http://127.0.0.1:<port>/browser-workflows/tool` with body
  `{ tool: "synthi_attach_substrate", arguments: {...} }`; response JSON has
  `{ result: {...} }`. Helper `bridgeCall(port, tool, args)` exists in the NN
  test — copy it.
- Tool argument shapes (`src/embodied/tools.ts`):
  - `synthi_attach_substrate`: `{ substrate_kind, consent: { subject, realm: { realm_kind, realm_id }, allow: ["observe","record","act"] } }` -> `{ session_id, substrate_kind }`. With NO arguments it lists available substrates.
  - `synthi_begin_teach`: `{ session_id }` -> `{ status: "recording" }`
  - `synthi_perform_action`: `{ session_id, action }` -> `{ ok }`. The action object goes straight to the substrate actor. For the browser adapter an action is a `BrowserTraceEventShape` (see below).
  - `synthi_end_teach`: `{ session_id, intent?, changed_values?, control_diffs? }` -> `{ steps_recorded, contract_id, problems }`. Contract compiles only when `changed_values` is non-empty (stage-1 diff supplied by the driver — see "Teaching" below).
  - `synthi_export_skill`: `{ competency_id }` (= contract_id from end_teach) -> full skill artifact incl. `integrity_digest`.
  - `synthi_import_skill`: `{ skill }` -> `{ imported_as, runnable, integrity_verified }`
  - `synthi_run_workflow`: `{ competency_id, session_id, mode: "fresh_state", required_level?: "E2_supervised" }` -> `{ ok, step_results }`
- In-process bridge: `startBrowserWorkflowBridge({ port, host })` from
  `src/browser_workflow_bridge/server.js` (returns `{ ready: Promise, close, server }`);
  `embodiedBridgeContext()` from `src/browser_workflow_bridge/embodied_dispatch.js`.
- Browser substrate bundle: `createBrowserEmbodiedBundle(ports)` +
  `registerSubstrateAdapter(bundle)` from `src/browser/embodied_adapter.ts`.
  Ports: `observePage(handle) -> { url, origin, dom }` and
  `performAction(handle, event) -> { ok }`.
  - Its actor pushes the event into `handle.environment.recorded` while recording; recorder emits them as steps with `embodied` conversions.
  - **The browser bundle has NO replay_provider** — `handleRunWorkflow` calls
    `teacher.run(...)` which requires `replay_provider`. So Agent B cannot run
    an imported browser skill today. THIS IS THE ONE GAP: add an OPTIONAL
    `replay_provider` to `src/browser/embodied_adapter.ts`'s
    `createBrowserEmbodiedBundle` that executes each recorded step event
    through `ports.performAction(handle, event)` and returns
    `{ ok: <all steps ok>, step_results: [...] }`. Keep it thin and universal
    (it must not know anything about catalogs or items). This is the allowed
    minimal core-side addition; call it out explicitly in the commit message.
- Licenses: `CompetencyLicense` shape used by the NN test's license file:
  `{ license_id, competency_id: <skill_id>, substrate_scope: ["browser"], realm_scopes: [{ realm_kind: "origin", realm_id: <exact origin string> }], entrustment: "E2_supervised", issued_at_ms: 0, expires_at_ms: Number.MAX_SAFE_INTEGER }`.
  `bridge_agent.mts` seeds licenses from `process.argv[4]` (a JSON file path).
  Realm matching is EXACT equality (never prefix): realm_id must equal the
  page origin string exactly (e.g. `http://127.0.0.1:PORT`).
- Bridge banner: child prints `AGENT BRIDGE LIVE on port <n>`; poll
  `/browser-workflows/tool` until responsive instead (NN-test pattern).
- Windows host: kill children with `taskkill /PID <pid> /T /F` via execFileSync;
  use forward-slash native paths; no POSIX-only APIs. Playwright chromium is
  available as `playwright-core` (repo root node_modules).

## Test design (rewrite `embodied_web_transfer_live.test.ts`)

Deterministic seeded randomness: reuse the NN test's `mulberry32` approach.
NO network beyond 127.0.0.1. No external browsers beyond playwright-core's
chromium. Everything must pass repeatedly on this Windows machine.

### Fixture sites (universal mini web app, built inline)

A tiny node:http app factory `makeSite(seed, opts)` serving ONE page:
a list of N (5..8, seed-derived) item buttons rendered as
`<button data-entity="stable-id-N">Label N - $price</button>`, plus `POST /choose`
storing the chosen entity id server-side (getter exposes it). Two knobs:
- `structural: true|false` — when false, buttons carry NO distinguishing
  attributes at all (bare `<button>text</button>`).
- Data (ids, labels, prices, count) fully seed-derived; sites A and B get
  DIFFERENT seeds => different port AND different data.
Names/labels MUST stay generic (letters/digits only, e.g. `ent-<n>-<serial>`):
this test itself must not encode domain nouns into the pipeline.

### Structural targeting rule (the heart of the test)

The observer builds, for every interactable element, a structural descriptor:
its tag plus ANY stable distinguishing attributes present in the DOM
(`data-*`, `id`, `name`, `aria-label`, exact `type`) — NEVER its text content,
NEVER any data value. From descriptors, build a CSS selector preferring
`tag[attr="value"]` chains; if NO attribute distinguishes an element from its
siblings, the element is UNRESOLVABLE — return null and let the step fail.
Implement this ONCE in the test file (agent A side) and ONCE in
bridge_agent.mts browser mode (agent B side) — shared logic would require a
new shared module; duplication across the two agents is acceptable and honest
(two independent implementations also guard against accidental coupling).
Both sides follow the same documented rule, not shared code.

### Flow

beforeAll (generous timeout, 120s):
1. Start site A (seed S) and site B (seed S+K) on ephemeral ports
   (`listen(0)`), K chosen so datasets differ; assert datasets differ.
2. Launch chromium headless IN-PROCESS (playwright-core) for agent A; wire
   `registerSubstrateAdapter(createBrowserEmbodiedBundle({ observePage, performAction }))`
   where observePage navigates/reads the CURRENT page (page.url() must be site A),
   enumerates buttons, and performAction performs `page.click(selector)` then,
   when the event carries a `detail.submit` url, issues the choose POST via
   `page.request.post(url, { data: { entity: <resolved id> } })` — resolve the
   id from the clicked element's descriptor (attribute), NOT from hardcoded data.
   Event shape: fill required BrowserTraceEventShape fields minimally
   (event_id unique, trace_id, trace_version 1, event_seq incrementing, ts,
   tab_id "a", origin, url, kind "human_action", action "click", selector,
   locator_candidates [test_id/css candidates]).
3. Start agent-A bridge IN-PROCESS on an ephemeral-or-fixed port (e.g. 3011);
   wait until responsive.
4. TEACH over the bridge (HTTP calls only, like a real client):
   attach_substrate(browser, realm {realm_kind:"origin", realm_id: originA},
   allow observe/record/act) -> begin_teach ->
   perform_action click first item selector -> perform_action click first item
   WITH detail.submit pointing at site A /choose -> end_teach(intent "...",
   changed_values: stage-1 diff built by comparing observePage dom snapshots
   taken before/begin vs after actions — emit ChangedValue-shaped entries
   `{ path: "dom.<key>.text", value_kind: "string", before, after, changed_at_tick: i }`,
   plus `control_diffs: [{ source_id: "control", changed: [] }]`) ->
   assert contract_id != null and steps_recorded == 2 ->
   export_skill(competency_id) -> assert skill_format "synthi.skill.v1".
5. Write skill JSON to a temp file. Write license file for agent B scoped to
   origin B (known already since site B bound its ephemeral port first).
6. Spawn agent B: `node <repo-root>/node_modules/tsx/dist/cli.mjs mcp/synthi-mcp/scripts/bridge_agent.mts <portB or 0> "" <licenseFile>`
   with env `SYNTHI_BROWSER_AGENT=cdp` and `SYNTHI_BROWSER_CDP_URL=<ws endpoint of a headless chrome YOU launched for B>`
   (launch a second chromium via playwright-core and expose CDP: launch with
   `chromium.launch({ headless: true })` does not expose CDP; instead spawn via
   `chromium.launchServer({ headless: true })` whose `wsEndpoint()` IS a CDP
   endpoint usable with `chromium.connectOverCDP`). cwd = repo root two levels up.
   Wait until responsive (poll loop; on persistent failure, one netstat/taskkill
   eviction retry exactly like the NN test).
7. Over HTTP to B: import_skill({skill}) -> assert runnable && integrity_verified.
8. attach_substrate(browser, realm origin B, allow observe/record/act) ->
   run_workflow(imported_as, session, fresh_state, E2_supervised) -> assert ok.
9. PROOF: site B's stored choice equals B's OWN first entity id (not A's data,
   not a memorized string). Assert site A's choice unchanged (still A's first id
   from teaching).

test 2 — twin discrimination (timeout 120s):
10. Start site C = same seed/data family as B but structural:false. Attach B's
    browser to origin C (consent), run_workflow fresh_state -> expect the run
    to be NOT ok OR step_results containing a failed/unresolved step (the
    structural selector cannot resolve without attributes). Also assert site C
    received NO choice. If the run unexpectedly succeeds, the test MUST fail —
    that would mean targeting fell back to text/content matching.

afterAll: taskkill agent B process tree, close bridges, stop both chromium
instances and all three sites (destroy sockets; use the NN test's
close-with-timeout pattern), remove temp files. No open handles (vitest must
exit cleanly).

### Robustness requirements

- All waits bounded and polled; zero arbitrary long sleeps except small poll intervals.
- Unique ephemeral ports everywhere (listen(0)); never hardcode 3003/3004-style fixed ports EXCEPT where collision risk is acceptable pick ephemeral everywhere possible; agent-B port: pass "0" and parse the banner OR pass a port derived from seed+pid. Prefer parsing the printed banner `AGENT BRIDGE LIVE on port <n>` (that is its contract).
- Console-noise discipline: collect child stdout/stderr into a buffer; on failure, include the last ~2000 chars in the thrown error message (NN-test style) so CI failures are debuggable.
- The test must be repeatable back-to-back (no global state leaks; unregister adapters you registered via try/finally where the registry API allows, or scope to this file's process).

## bridge_agent.mts browser mode (additive)

```
const cdpUrl = process.env.SYNTHI_BROWSER_CDP_URL;
if (process.env.SYNTHI_BROWSER_AGENT === "cdp" && cdpUrl) {
  unregisterAllSubstrateAdapters();
  // playwright-core connectOverCDP(cdpUrl) -> browser -> context[0] -> page(s)
  // registerSubstrateAdapter(createBrowserEmbodiedBundle({
  //   observePage: enumerate current page's interactables via the SAME
  //                structural-descriptor rule (attributes only, null when
  //                unresolvable),
  //   performAction: page.click(selector) (+ submit POST when event.detail.submit),
  // }))
}
```
Use `createRequire(import.meta.url)` to load playwright-core (hoisted at repo
root node_modules) — same trick as the existing `ws` require. Resolve pages
robustly: reuse context.pages()[0] or open one; navigate only when the current
url origin differs from the session realm (the replay driver relies on
selectors resolving on whatever page is open; keep a single tab).
Keep ALL existing modes byte-identical when the env vars are absent.

## Acceptance gates (all must hold)

1. `npx vitest run tests/unit/embodied_web_transfer_live.test.ts` GREEN twice consecutively.
2. `npx vitest run tests/unit/embodied_bridge_dispatch.test.ts tests/unit/embodied_skill_transfer.test.ts` still GREEN (no regressions).
3. `npx tsc --noEmit -p tsconfig.json` introduces no NEW errors (run before/after; report the delta). Also run eslint on the touched files if the repo lint script covers them.
4. No changes outside the three listed files (adapter replay_provider included).
5. Zero domain nouns in any src/ change; test-site naming generic.

## Commits (from repo root, two levels up)

One commit, message:
`feat(embodied): LIVE website-flow transfer - agent B replays on fresh port+data (WI-WEB)`
Body: bullet list of what is proven live + explicitly list the browser
replay_provider addition (if made). Include ONLY: the rewritten test,
bridge_agent.mts, src/browser/embodied_adapter.ts (replay_provider). Do NOT
commit .gitignore or package-lock.json changes sitting in the working tree.

## Report back

Final report must include: the vitest tail lines proving GREEN (both runs),
files changed, the exact commit hash, any deviations from this spec with
reasons.
