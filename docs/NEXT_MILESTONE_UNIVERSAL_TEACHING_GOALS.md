# Universal Embodied Teaching — Next-Milestone Goal Doc

Branch: feat/embodied-universal-teaching
Predecessor plan: docs/UNIVERSAL_EMBODIED_TEACHING_PLAN.md (Phases 0–5 implemented and verified; see "Verified to date" there).

## Mission

The end goal: a user can teach this system ANYTHING demonstrable on the machine or in any reachable world — games, neural-network training, kernels, website flows, low-level systems, APIs — and an independent agent executes it. Proven live, with world-state evidence, computer-vision verification of visual surfaces, randomized conformance (zero hardcoding), production-usable beyond localhost, and a user surface simple enough that no jargon is needed.

## Operating rules (binding)

1. Orchestrator mode: coding tasks are delegated to `codex --profile zen` (`codex --profile zen exec --skip-git-repo-check --cd <repo> "<task>"`). Hermes reviews, integrates, verifies.
2. One patch/fix = one commit; each commit leaves the embodied test suite green. Baseline numbers recorded below.
3. No hardcoding: scenario nouns never enter core code. Randomized multi-world conformance + noun gates stay green.
4. Live proof: every claimed capability is exercised against a real process/world/file/network — never mocked. Visual surfaces get .visual-proof artifacts regenerated from real runs and verified on the desktop via computer vision (screenshot capture, not only AX trees).
5. Subagents for genuinely independent workstreams; their output is verified before integration.
6. User-friendliness is an acceptance gate: five verbs, zero jargon.

## Baseline (recorded 2026-08-24, before next-milestone work)

- `npx vitest run tests/unit/embodied_nn_transfer_live.test.ts` — FAILING at step 1
  (terminal adapter act() splits command args on whitespace without quote awareness;
  `node -e require('fs')... 'payload'` breaks). Root cause identified in
  src/embodied/adapters/terminal/index.ts:170 (act path uses naive split; replay
  path already has quote-aware splitArgs).
- package-lock.json modified (uncommitted); untracked: NN live test, corpus scripts,
  live_report.mjs — to be committed as part of WI-NN after the fix lands.

## Work items

### WI-NN — Neural-network substrate proof (terminal substrate applied to ML)
Fix the terminal actor's argument splitting (quote-aware, shared helper used by BOTH
act and replay paths; universal — no command-shape special-casing). Then land the
LIVE agent-to-agent NN transfer test: Agent A teaches write→train(numpy MLP)→verify
through the real bridge; Agent B (separate OS process) imports synthi.skill.v1,
licenses into its own realm, re-executes fresh_state, and its own freshly trained
model.json proves transfer (final_loss < first_loss, accuracy > 0.85).
Files: mcp/synthi-mcp/src/embodied/adapters/terminal/index.ts (+ splitArgs export),
mcp/synthi-mcp/tests/unit/embodied_nn_transfer_live.test.ts,
mcp/synthi-mcp/scripts/bridge_agent.mts (terminal-agent mode), scripts/corpus/*.
Acceptance: test green twice consecutively; commit includes test + scripts.
Commits: (a) fix terminal arg splitting + regression unit test; (b) LIVE NN transfer
test + corpus scripts + bridge_agent terminal mode.

### WI-WEB — Website-flow substrate proof (browser substrate through universal pipeline)
A taught website flow (real local site served over HTTP) captured through the browser
adapter's Recorder compiles to a substrate-neutral competency, is exported as
synthi.skill.v1, imported by an independent agent B process, and replayed against a
FRESH server instance with different port + fixture data — proving the flow transfers
by structure, not by memorized URL/data. Conformance: randomized fixture content per
seed; twin site (different data) must fail discrimination.
Acceptance: new e2e test green; visual proof artifact from the live run.
Commit: one feat commit (test + any adapter gap-fixes it forces, listed in message).

### WI-PROD — Production readiness beyond localhost
Bridge currently binds 127.0.0.1 with token auth optional-by-default. Add:
(a) deployment config layer (env-driven bind host, auth token required when bound
beyond loopback); (b) remote-realm attach path so an agent B on another machine can
import a skill and execute against ITS local worlds (the skill file is the portable
artifact — prove import+run from a second working directory with different realm id);
(c) docs/DEPLOYMENT.md covering the production story.
Acceptance: automated test proving non-loopback bind refuses without token and works
with token; cross-directory import+run test; DEPLOYMENT.md committed.

### WI-UI — Observe substrate picker (product surface, five verbs, zero jargon)
Agent panel Observe view gains a source picker fed by synthi_attach_substrate's
realm list ("Where should I watch?" — plain language). Users never see adapter/realm/
lease vocabulary. Verified via computer use on the real desktop.
Acceptance: picker renders all five registered substrate kinds with human labels;
computer-use screenshot proof archived under .visual-proof/ui/.

### WI-ENGINES — Real game-engine plugin behind the WS protocol
Web engine plugin first: a headless web-canvas game world speaking the existing
scene-graph WS protocol, registered as a dojo world_manifest scenario; conformance
harness runs against it across seeds (tick-rate wobble variant included).
Acceptance: protocol conformance suite green against the plugin; randomized seeds;
no core changes required (proving the plugin boundary holds).

## Proof & review gates (closing work)

- .visual-proof/<topic>/ artifacts regenerated from live runs (never hand-typed);
  each verified on the desktop via computer vision.
- Independent subagent review of every claim in this doc + commit messages vs
  reality (re-runs key commands); hallucinations fixed before final report.
