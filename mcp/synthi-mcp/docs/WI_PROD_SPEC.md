# WI-PROD Implementation Spec — Production readiness beyond localhost

Repo: this package sits inside the IDE repo; git root is two levels up.
Branch: `feat/embodied-universal-teaching` (already checked out). Do NOT create branches.

## Mission

Make the embodied bridge deployable beyond localhost and PROVE it:
(a) deployment config layer — env-driven bind host + auth token REQUIRED when
bound beyond loopback; (b) remote-realm attach path proven by importing a skill
from a second working directory (different cwd, different realm id) into an
agent-B bridge process and executing there; (c) docs/DEPLOYMENT.md telling the
production story.

Verified reality you build on (do not re-implement):
- `startBrowserWorkflowBridge` in `src/browser_workflow_bridge/server.ts`
  ALREADY refuses tool requests on non-loopback binds when no `opts.token` is
  configured (401 `workflow_bridge_token_required`) and honors
  `x-synthi-workflow-token` when a token is set. Your job is the deployment
  wiring + proof, NOT changing server.ts semantics.
- `scripts/bridge_agent.mts`: argv `<port> <gameWsUrl> <licenseFile>`;
  env modes SYNTHI_KERNEL_AGENT / SYNTHI_BROWSER_AGENT / SYNTHI_TERMINAL_AGENT;
  prints banner `AGENT BRIDGE LIVE on port <n>` with the ACTUAL port.
- Bridge HTTP: POST `/browser-workflows/tool` body `{tool, arguments}` ->
  `{result}`. Embodied tools accept `{substrate_kind:"terminal", consent:{subject, realm:{realm_kind:"workspace", realm_id:<abs dir>}, allow:[...]}}`.
- Skill round-trip + integrity digest: `synthi_export_skill` /
  `synthi_import_skill` (see tests/unit/embodied_skill_transfer.test.ts).
- Terminal adapter executes allowlisted binaries; policy via
  `SYNTHI_TERMINAL_AGENT=node` style env or `allowlistPolicy([...])`.

## Files you may change

1. `scripts/bridge_agent.mts` — ADDITIVE deployment config layer (see below).
   All existing modes byte-identical when the new env vars are absent.
2. NEW `tests/unit/embodied_prod_deployment.test.ts` — the proof test.
3. NEW `docs/DEPLOYMENT.md` AT THE REPO ROOT (two levels up from this package)
   — wait: repo root already has many docs; create `DEPLOYMENT.md` in the SAME
   directory as NEXT_MILESTONE_UNIVERSAL_TEACHING_GOALS.md (repo-root docs/).

Nothing else. If a core change seems unavoidable, prefer not to; if truly
required, keep minimal and list it prominently in your report.

## Deployment config layer (bridge_agent.mts)

New env vars read at startup:
- `SYNTHI_BRIDGE_HOST` (default `127.0.0.1`)
- `SYNTHI_BRIDGE_TOKEN` (default unset)

Rules:
- If host is NOT loopback (localhost/127.0.0.1/::1 — reuse the same definition
  the server uses conceptually) and no token is set -> print a plain-language
  refusal to stderr and exit non-zero BEFORE binding anything. Message shape:
  `refusing to bind beyond this machine without SYNTHI_BRIDGE_TOKEN set`.
- Otherwise pass `{ port, host, ...(token ? { token } : {}) }` to
  startBrowserWorkflowBridge.
- When a token is active, log one line noting authenticated mode (never log
  the token itself).

## Proof test (tests/unit/embodied_prod_deployment.test.ts)

Three scenarios, all live HTTP/processes, no mocks. Follow
tests/unit/embodied_nn_transfer_live.test.ts conventions: bridgeCall helper,
bounded polling waits, taskkill tree cleanup on Windows, forward-slash native
paths, generous timeouts, child output captured into buffers included in
failure messages.

Scenario 1 — non-loopback requires token:
- Start `startBrowserWorkflowBridge({ port: <ephemeral>, host: "0.0.0.0" })`
  IN-PROCESS without token. POST /browser-workflows/tool
  {tool:"synthi_attach_substrate", arguments:{}} -> expect HTTP 401 with
  error `workflow_bridge_token_required`. Close it.
- Start again WITH `token: "test-token-<pid>"`. Same POST WITHOUT header ->
  401. With header `x-synthi-workflow-token` -> 200 and result carries
  available_substrates. Close it.

Scenario 2 — env layer of the standalone agent enforces the same rule:
- Spawn `bridge_agent.mts` with SYNTHI_BRIDGE_HOST=0.0.0.0 and NO token ->
  process must EXIT non-zero with the refusal text; collect output.
- Spawn with SYNTHI_BRIDGE_HOST=127.0.0.1 (default) -> stays UP (poll healthz),
  then kill.

Scenario 3 — remote-realm import+run from a SECOND WORKING DIRECTORY:
- Create two temp dirs D_A and D_B (different paths).
- In-process context A is NOT used; instead teach via a first in-process
  bridge on ephemeral port P1 (host default): register terminal bundle with
  allowlist ["node"] (registerSubstrateAdapter(createTerminalBundle(allowlistPolicy(["node"]))))
  then attach consent realm_id=D_A -> begin_teach -> perform_action
  `{run: "node -e require('fs').writeFileSync('out.txt','prod-ok')"}` (quote
  carefully or use a small .cjs file written into D_A and run
  `node write-out.cjs` to dodge quoting entirely — PREFERRED) -> end_teach with
  changed_values [{path:"out.txt", semantic_class:"", after:"prod-ok",
  changed_at_tick:1}] + control_diffs [{source_id:"ctrl",changed:[]}] ->
  export_skill. Assert contract exported.
- Write license JSON file scoped to realm D_B (realm_kind workspace,
  realm_id D_B with forward slashes), entrustment E2_supervised,
  substrate_scope ["terminal"], competency_id = skill_id.
- Spawn agent B: tsx cli + bridge_agent.mts with port "0" (parse banner for
  the REAL port), licenseFile, env SYNTHI_TERMINAL_AGENT=node, AND
  cwd = D_B (the foreign working directory — this is the point).
  Wait for responsiveness.
- Over HTTP: import_skill({skill}) -> runnable true, integrity_verified true;
  attach_substrate terminal consent realm_id=D_B; run_workflow(imported_as,
  session, fresh_state, E2_supervised) -> ok true.
- PROOF ON DISK: D_B/out.txt exists with content prod-ok; D_A/out.txt still
  holds whatever teaching wrote there (assert unchanged).

Cleanup: taskkill spawned trees, close bridges, rm temp dirs. Repeatable.

## docs/DEPLOYMENT.md content (concise, operational)

Sections: What the bridge is (one paragraph, five verbs); Local run (default
loopback, no token); Deployed run (SYNTHI_BRIDGE_HOST + REQUIRED
SYNTHI_BRIDGE_TOKEN, why); Agent deployments (SYNTHI_TERMINAL_AGENT allowlist =
deployment configuration, deny-by-default; kernel/browser/game modes one line
each); Skill files as the portable artifact (synthi.skill.v1, integrity digest,
license seeding via argv[4], realm-scoped exactness); Operational notes
(ports/banner contract, healthz, where proofs live under .visual-proof/).
No jargon beyond what the code actually uses; every claim must match reality.

## Acceptance gates

1. `npx vitest run tests/unit/embodied_prod_deployment.test.ts` GREEN twice consecutively.
2. `npx vitest run tests/unit/embodied_skill_transfer.test.ts tests/unit/embodied_nn_conformance.test.ts` still GREEN.
3. No NEW tsc errors from touched files (delta before/after).
4. Existing bridge behaviors untouched: `npx vitest run tests/unit/embodied_bridge_dispatch.test.ts` GREEN.

## Commit

From repo root: single commit
`feat(embodied): production bridge deployment layer + cross-directory live proof (WI-PROD)`
including the three files. Do NOT commit unrelated dirty files (.gitignore,
package-lock.json).

## Report back

Vitest tail lines (green twice), files changed, exact commit hash, deviations.
