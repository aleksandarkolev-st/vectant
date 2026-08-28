---
title: Docs & Tooling Catalog — vectant-ade
repo: vectant-ade
generated: 2026-08-25
scope: docs/ (157 .md), scripts/, e2e/, tests/, probe/synthi-probe, tasks/, ops/
---

# Docs & Tooling Catalog — vectant-ade

Catalog of every documentation file and tooling directory in the repo, organized by owning
system. Types: **plan** (forward-looking design/implementation), **reference** (describes what
exists), **proof** (evidence/artifact of something working), **runbook** (operational how-to),
**status** (progress/gap tracking).

Systems: `frontend` · `collab` · `ai-engine` · `mcp` · `gpu-hmr` · `infra` · `dojo` ·
`security` · `product`

---

## 1. gpu-hmr — Hot Module Replacement for compiled/GPU code

The largest doc cluster: the AI-HMR pipeline (Next.js-style hot reload for C++/Rust) and its
extension to CUDA/ROCm GPU kernels, plus investor-demo evidence.

| File | Summary | Type |
|---|---|---|
| `AI_HMR_ARCHITECTURE.md` | Architecture of the compiled-language (C++/Rust) HMR system achieving "Next.js-like" DX; lists new worker modules. | reference |
| `AI_HMR_SYSTEM_REFERENCE.md` | v2.0 "complete technical reference" aimed at architects/backend/security engineers; production-ready framing. | reference |
| `AI_HMR_IN_DEPTH.md` | End-to-end explanation of the pipeline from Next.js editor UI through the Rust worker compiler service. | reference |
| `AI_HMR_DEEP_ANALYSIS.md` | In-depth analysis of how AI-powered HMR works, layer by layer. | reference |
| `AI_HMR_COMPREHENSIVE_REPORT.md` | Generated comprehensive analysis scoped to `backend/synthi-webrtc-compiler/worker/src/`. | reference |
| `AI_HMR_IMPLEMENTATION_REPORT.md` | Implementation audit (~18k lines Rust + ~2k JS/React); notes dead code integrated via HmrOrchestrator. | status |
| `HMR_END_TO_END.md` | Traces a keystroke to a swapped-in `.so` in the preview and back — every component and wire format, grounded in live code (2026-04-28). | reference |
| `HMR_CODE_AUDIT_2026-04-10.md` | Audit of the compiled-language HMR implementation across worker `hmr/` and `runtime/`. | status |
| `GPU_HMR_IN_DEPTH_FLOW.md` | Current GPU HMR path end-to-end: user code → browser → worker → AI engine (2026-05-18). | reference |
| `GPU_HMR_ULTRAPLAN.md` | Plan to extend HMR to CUDA & ROCm GPU kernels, building on the 4-file AI split + BuildManifest pipeline. | plan |
| `GPU_HMR_TECH_AGNOSTIC_PLAN.md` | Makes GPU HMR backend-agnostic by treating render/window backend as first-class data instead of an SDL2 guess. | plan |
| `GPU_HMR_DETERMINISTIC_PARTIAL_RELOAD_PLAN.md` | Correctness-milestone plan (deterministic partial reload) preceding artifact fission/performance work. | plan |
| `GPU_HMR_FULL_RUNTIME_CORRECTNESS_PLAN.md` | Defines what must be true to claim full runtime render correctness for large real renderers (HIPRT-class); stricter than "it compiled". | plan |
| `GPU_HMR_PROD_NEXT.md` | Production-hardening plan to make GPU HMR reliable for engineers on real native GPU projects. | plan |
| `GPU_HMR_RAG_SPLIT_IMPROVEMENT_PLAN.md` | GPU HMR CodeIntel Split Broker implementation plan (stricter rev, milestones 1–3 ready). | plan |
| `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md` | Hardens GPU HMR from friendly-profile demos to safely accepting broad real-world GPU projects; introduces a proof ledger. | plan |
| `GPU_HMR_UNIVERSAL_ACCEPTANCE_IMPLEMENTATION_STATUS.md` | Implementation status recorded against the universal-acceptance proof plan (2026-06-09). | status |
| `GPU_HMR_INVESTOR_DEMO_STATUS.md` | States the safe investor-demo claim and current demo position (2026-06-09). | status |
| `HMR_AGNOSTIC_ULTRAPLAN.md` | Ultraplan for library- and language-agnostic HMR (Milestone 1: ~2700 lines C++; M2 deferred multi-language). Awaiting Phase 1 dry-run. | plan |
| `HMR_LIGHTNING_ULTRAPLAN.md` | Companion plan making *runtime* HMR instant: any C++ library, sub-frame value edits (rev 2, drafting). | plan |
| `ULTRAPLAN_Complete_Log.md` | Complete user↔agent design log behind the library/language-agnostic HMR ultraplan, incl. internal reasoning. | reference |

### Evidence artifacts
| Path | Contents | Type |
|---|---|---|
| `docs/gpu-hmr-investor-demo/ray-bounce-20260608/` | Before/after HMR screenshots (`before-hmr-first.png`, `after-hmr-first.png`, diff) plus frame-metadata JSON showing brokered frame swap. | proof |

---

## 2. mcp — Synthi Agent MCP & browser automation

Docs for the MCP server that lets external AI coding agents drive the IDE/runtime
(`mcp/synthi-mcp/`), plus the agent-browser workflow teaching track.

| File | Summary | Type |
|---|---|---|
| `VISION.md` | Synthi MCP vision: the runtime substrate letting AI agents develop/run/verify remote-compiled programs with human-level fidelity; sits above the ultraplan. | reference |
| `AGENT_MCP_ULTRAPLAN.md` | v4.5 design-space ultraplan (supersedes v2–v4.3); awaiting approval for Phase 0.5 spike. | plan |
| `AGENT_MCP_MVP.md` | Scope-locked MVP spec — the current build target; supersedes the ultraplan as implementation plan. | plan |
| `AGENT_MCP_IMPLEMENTATION_PLAN.md` | Draft-v1 implementation plan organized in tracks against the MVP scope (branch `claude/agent-mcp`). | plan |
| `AGENT_MCP_PHASE_B_PLAN.md` | Durable migration plan for Phase B (commits 2–9) after commit 1 shipped peer_id signaling. | plan |
| `AGENT_MCP_BROKER_ROLLOUT_PLAN.md` | Execution-grade rollout spec migrating per-agent direct TBR/WebRTC attach to brokered attach with SLOs and security boundaries. | plan |
| `AGENT_MCP_FEEDBACK_NOTES.md` | Post-critique capture on the v1 plan (incl. the "mental-model mistake") feeding the v2 rewrite. | reference |
| `AGENT_MCP_STATUS.md` | Status: phase 0.5 instrumentation + phase 1 code complete in-process; no live-stack validation yet (32 tests). | status |
| `AGENT_MCP_REMAINING_WORK.md` | Exhaustive gap report between the ultraplan (v4.5 phase-1 scope) and what exists in-tree at branch tip. | status |
| `PHASE_0_5_FINDINGS.md` | Findings template for the live spike harness; live-mode cells to fill after a real docker-compose session run. | status |
| `PHASE_2_PLUS_BACKLOG.md` | Ticket-sized backlog explicitly deferred from the v4 ultraplan review (2026-04-17). | plan |
| `AGENT_BROWSER_MCP_COMPLETION_PLAN.md` | Draft plan for teaching Synthi a browser workflow once in the cloud IDE and converting it into reliable generated Playwright code. | plan |
| `AGENT_BROWSER_MCP_GOAL_STATUS.md` | Production-grade status of the browser workflow teaching path — implemented and verified through the cloud-IDE route (2026-06-10). | status |
| `AGENT_BROWSER_MCP_STATUS.md` | Earlier status with the latest investor/demo workspace proof point (2026-06-08). | status |

---

## 3. ai-engine — Retrieval, completions, healing, verification

AI backend capabilities: code-intelligence retrieval, inline completions, self-healing,
output-quality validation, failure distillation, and model training plans.

| File | Summary | Type |
|---|---|---|
| `AI_SYSTEM_ARCHITECTURE.md` | Deep-dive into code indexing/storage/retrieval: storage tiers, pipeline, retrieval blueprint. | reference |
| `inline_completions_nep_plan.md` | Inline-completions foundation (shipped: hybrid retrieval, RRF+MMR merge) plus Next-Edit Prediction plan. | plan |
| `synthi-diff-patch-training-plan.md` | Training plan for a diff-patch custom model; phases gated on decisions D1–D14; local-teacher default. | plan |
| `synthi-genome-master-plan.md` | Master plan for a deep chat-output verification system ("Genome"): real toolchains in worktrees vs. an opposing AI. | plan |
| `synthi-genome-progress.md` | Wave-by-wave delivery tracker for the Genome master plan (✅/🟡/⚪ convention). | status |
| `PROBLEM_AND_SOLUTION.md` | Problem statement for "AI understands the prompt but emits awful/mismatched code," with solution overview. | reference |
| `AI_OUTPUT_QUALITY_FIX.md` | Implementation summary of the fix for malformed/duplicate AI output (server-side validation etc.). | status |
| `DEPLOYMENT_CHECKLIST.md` | Deployment checklist enumerating exactly which files changed for the AI-output-quality fix. | runbook |
| `VALIDATION_TEST_GUIDE.md` | Quick guide to the three validation layers that catch/reject bad AI output (duplicates, mixing, unclosed fences). | runbook |
| `PROACTIVE_ANALYSIS.md` | Multi-tier proactive-analysis pipeline detecting likely errors *before* compilation. | reference |
| `SELF_HEALING_ARCHITECTURE.md` | Technical reference for the AI-assisted deterministic code-repair engine: safety gating, pre-compile fixes, HMR-integrated healing. | reference |
| `SELF_HEALING_CHANGELOG.md` | Changelog for the renamed "Targeted Auto-Fix" system (narrow regex-detected fixes, not arbitrary repair). | status |
| `WRITING_HEALING_RULES.md` | How-to guide for authoring new rules for the self-healing/auto-fix rule modules. | runbook |
| `FAILURE_DISTILLER_AGENT_FEATURE_IMPROVED.md` | Feature plan: distill a real software failure into the smallest stable debugging world within a declared budget. | plan |
| `FAILURE_DISTILLER_MANUAL_FALLBACK.md` | Runbook for proving Failure Distiller manually when Docker/browser-control gates can't run locally. | runbook |
| `AGENT_THERAPEUTIC_TOMOGRAPHY_PLAN.md` | Plan for "Therapeutic Tomography": repo-local executable readiness + wired production release gate; deployed proof incomplete. | plan |
| `THERAPEUTIC_TOMOGRAPHY_RELEASE_EVIDENCE_STATUS.md` | Flags the release-evidence JSON as stale/local-only (example.test endpoints) and intentionally rejected by production. | status |

---

## 4. dojo — Agent Dojo, CodeSite, Regret Memory / counterfactual infra

Agent-evaluation vivarium and the CodeSite coordination/control-plane workstream with its
live proof scripts (see also §11 Tooling).

| File | Summary | Type |
|---|---|---|
| `agent_dojo_breakthrough_spec.md` | Unified breakthrough product spec for the Agent Dojo Vivarium Cortex (2026-06-10). | plan |
| `AGENT_DOJO_FULL_MATURE_VIVARIUM_CORTEX_PLAN.md` | Planning document for completing the "mature product universe" vivarium cortex. | plan |
| `AGENT_DOJO_GOOGLE_CLOUD_IMPLEMENTATION_PLAN.md` | Implementation plan for running the Dojo on Google Cloud (GKE); not a deployment log. | plan |
| `AGENT_DOJO_IMPLEMENTATION_STATUS.md` | Source-of-truth maturity baseline of the current Dojo implementation in `mcp/synthi-mcp`. | status |
| `AGENT_DOJO_RELEASE_GATE_RUNBOOK.md` | How to prove the mature release gates without manufacturing fake local evidence when external systems are missing. | runbook |
| `CODESITE_CONSTRUCTION_COORDINATION_PLAN.md` | Revised product + implementation plan for CodeSite "Air Traffic Control" coordination (2026-06-25). | plan |
| `MULTI_HUMAN_MULTI_AGENT_SHARED_SESSION_PROOF_PLAN.md` | Implementation + acceptance plan for multi-human/multi-agent shared-session synchronization, owned by collaboration & CodeSite control plane. | plan |
| `REGISTERED_DIRECT_CHANNELS_DESIGN.md` | Proposal for agent-to-agent negotiated direct channels as a future CodeSite extension. | plan |
| `CHANNEL_MODES_TRADEOFFS.md` | Design-only tradeoff guide for choosing session/channel types; companion to the direct-channels design. | reference |
| `REGRET_MEMORY_PLAN.md` | Novelty plan: "counterfactual taste for agentic software work — learn from futures the user did not ship." | plan |
| `REGRET_MEMORY_NOVELTY_PLAN.md` | Detailed proposal of the Vectant Counterfactual Infra working-name Regret Memory (2026-06-21). | plan |
| `VECTANT_COUNTERFACTUAL_INFRA_REGRET_MEMORY_PLAN.md` | Same detailed counterfactual-infra proposal (duplicate/canonical twin of the novelty plan). | plan |
| `CAUSAL_TWIN_CLOUD_PLAN.md` | Proposal: fork, replay, and prove what a software change *would* have done — counterfactual infrastructure. | plan |
| `REGRET_MEMORY_DOJO_CORTEX_INTEGRATION_PLAN.md` | Integration plan wiring Regret Memory into the Agent Dojo Vivarium Cortex (2026-06-24); consolidates the source plans above. | plan |

---

## 5. collab — Real-time collaboration

| File | Summary | Type |
|---|---|---|
| `COLLABORATION.md` | Collaboration architecture: Yjs CRDT editing + lightweight y-websocket server for multi-user concurrent workspace edits. | reference |

---

## 6. frontend — Synthi IDE surface & integrations

Editor shell, extensions, notebooks, mobile, OAuth-relay UX, plus the dated
`docs/superpowers/` plan/spec corpus (IDE feature slices).

### Core references & plans
| File | Summary | Type |
|---|---|---|
| `DOCKING_ARCHITECTURE.md` | Architecture guide for the fully custom tiling/floating Docking Window Manager built from scratch. | reference |
| `EXTENSION_STRATEGIC_DECISIONS.md` | Codifies what the extension system will *never* support — explicit non-goals bounding the browser-based extension worker. | reference |
| `VSCODE_SERVER_INTEGRATION.md` | "Path A": delegate Node-only VS Code extensions to a real VS Code Server (code-server). | reference |
| `AUTH_REMOTE_HOST_SUPPORT.md` | Auth capabilities in the remote-host extension flow (`vscode.authentication.getSession` support matrix). | reference |
| `ANDROID_WORKSPACE_RECONCILIATION.md` | Fixes Android/Gradle builds running in a stateless worker via write-through build reconciliation. | reference |
| `MOBILE_BUILD_ARCHITECTURE.md` | ADR selecting the mobile stack for Synthi cloud workers (Dec 2025). | reference |
| `JUPYTER_NOTEBOOK_SUPPORT_PLAN.md` | Proposed integration connecting workspaces to already-running Jupyter servers behind existing ADE boundaries. | plan |
| `JUPYTER_NOTEBOOK_ARCHITECTURE_MANIFEST.md` | Authority decision: the durable `.ipynb` file is authoritative; a connected Jupyter server is an execution-side representation. | reference |
| `JUPYTER_NOTEBOOK_RUNBOOK.md` | Runbook: Prisma migration + setup steps required before enabling the notebook viewer. | runbook |
| `TERMINAL_OAUTH_RELAY_PLAN.md` | Decision + plan to stop centering terminal OAuth on the noVNC workspace browser (localhost semantics). | plan |
| `VECTANT_OAUTH_RELAY_EXTENSION_PUBLISHING.md` | Publishing guide for the OAuth Relay browser extension that forwards localhost callback navigations to the workspace relay session. | runbook |

### docs/superpowers/ — dated implementation plans (31)

Superpowers-style TDD execution plans (checkbox tasks, subagent-driven development) for IDE
feature slices. All type **plan**, tag `frontend` unless noted.

| File | Summary |
|---|---|
| `plans/2026-05-22-editor-split-multi-pane.md` | Multi-pane editor split implementation plan. |
| `plans/2026-05-31-external-mcp-client-plan-1a.md` | External MCP client slice 1a: foundation + hub + in-app AI (with R1 addendum warning). |
| `plans/2026-05-31-external-mcp-client-plan-1a-addendum-R1.md` | Review addendum R1 responding to design review of slice 1a. |
| `plans/2026-05-31-external-mcp-client-1a-E2E.md` | Manual E2E checklist for slice 1a (Postgres/schema prereqs). |
| `plans/2026-06-02-external-mcp-client-1b-plan.md` | Slice 1b: CLI-agent external-MCP consumer implementation plan. |
| `plans/2026-06-02-external-mcp-client-1b-E2E.md` | Slice 1b manual E2E closing criterion #4. |
| `plans/2026-06-02-git-provider-abstraction-slice2-plan.md` | Git provider abstraction (slice 2 v1) implementation plan. |
| `plans/2026-06-02-git-provider-abstraction-slice2-E2E.md` | Slice 2 manual E2E for git providers. |
| `plans/2026-06-03-slice3-phase1-workspace-program-runtime-plan.md` | Slice 3 phase 1: workspace program runtime (branch `tool-compatibility`). |
| `plans/2026-06-06-slice3-phase2-recipe-manifests-installs-plan.md` | Recipe manifests + persisted installs. |
| `plans/2026-06-08-slice3-phase3-web-port-detection-program-ux-plan.md` | Web-port auto-detection + polished program tab UX. |
| `plans/2026-06-08-slice3-phase4-gui-runtime-type-thin-slice-plan.md` | GUI runtime type thin slice (stubbed surface). |
| `plans/2026-06-08-slice3-phase5-open-marketplace-v1-plan.md` | Open marketplace v1: publish + browse + install. |
| `plans/2026-06-09-default-marketplace-programs-and-ui-plan.md` | Default marketplace programs + Programs panel UI. |
| `plans/2026-06-09-make-default-programs-runnable-plan.md` | Make default programs runnable in the workspace. |
| `plans/2026-06-09-native-docker-execution-phase1.md` | Native Docker execution dev-hybrid slice. `infra` |
| `plans/2026-06-11-terminal-container-runtime-phase2a.md` | Docker-capable terminal (terminal-in-runtime-container). `infra` |
| `plans/2026-06-11-terminal-container-runtime-phase2b.md` | Terminal-launched server port forwarding. `infra` |
| `plans/2026-06-12-sysbox-runtime-phase2-plan.md` | Sysbox per-workspace Docker runtime on GKE. `infra` |
| `plans/2026-06-20-gui-dev-tool-streaming.md` | GUI dev-tool streaming + AI command control. `frontend`/`collab` |
| `plans/2026-06-22-cli-tui-programs-in-integrated-terminal.md` | CLI/TUI programs opening in the integrated terminal. |
| `plans/2026-06-22-gui-catalog-web-ui-docker-portainer.md` | GUI catalog web-UI tier + Docker (Portainer). |
| `plans/2026-06-22-kasmvnc-stream-auto-login.md` | KasmVNC stream auto-login. |
| `plans/2026-06-23-programs-panel-uiux-overhaul.md` | Programs Panel UI/UX overhaul. |
| `plans/2026-06-29-community-app-hosting-phase1.md` | Community-app hosting phase 1: submission + hybrid review gate. `product` |
| `plans/2026-06-30-autonomous-review-and-publisher-self-service.md` | Autonomous review pipeline + publisher self-service. `product` |
| `plans/2026-06-30-community-app-hosting-phase2-ai.md` | Community-app hosting phase 2: AI auto-approve/triage. `ai-engine`/`product` |
| `plans/2026-07-01-ai-assisted-manifest-authoring.md` | AI-assisted manifest authoring. `ai-engine` |
| `plans/2026-07-04-paid-apps.md` | Paid apps / marketplace billing. `product` |
| `plans/2026-07-25-codesite-panel-redesign.md` | CodeSite panel redesign implementation. `dojo` |
| `plans/2026-07-26-codesite-panel-visual-redesign.md` | CodeSite panel visual redesign. `dojo` |

### docs/superpowers/specs/ — approved designs (26)

Design counterparts to the plans above. All type **plan** (design stage), tag `frontend`
unless noted.

| File | Summary |
|---|---|
| `specs/2026-05-21-source-control-vectant-redesign-design.md` | Source Control "Conduit" Vectant redesign spec (awaiting approval). |
| `specs/2026-05-22-editor-split-multi-pane-design.md` | Multi-pane editor split design. |
| `specs/2026-05-25-ai-chat-living-orb-redesign-design.md` | AI chat "Living Orb" redesign. |
| `specs/2026-05-26-ai-chat-layout-refactor-rail-stream.md` | AI chat layout refactor: rail + stream. |
| `specs/2026-05-31-external-mcp-client-design.md` | Slice 1 foundation + external MCP client design. `mcp` |
| `specs/2026-06-01-workspace-program-runtime-design.md` | Slice 3 revised: workspace program runtime & marketplace. |
| `specs/2026-06-02-external-mcp-client-1b-design.md` | CLI-agent external-MCP consumer design. `mcp` |
| `specs/2026-06-02-git-provider-abstraction-slice2-design.md` | Git provider abstraction v1 (approved). |
| `specs/2026-06-09-default-marketplace-programs-and-ui-design.md` | Default marketplace programs + panel UI redesign. |
| `specs/2026-06-09-make-default-programs-runnable-design.md` | Making default programs runnable. |
| `specs/2026-06-09-native-docker-execution-phase1-design.md` | Native Docker execution vertical slice. `infra` |
| `specs/2026-06-11-terminal-container-runtime-design.md` | Uniform docker-capable terminal design. `infra` |
| `specs/2026-06-12-sysbox-runtime-design.md` | Production Sysbox per-workspace Docker runtime on GKE. `infra` |
| `specs/2026-06-16-real-programs-in-workspace-design.md` | Container programs on the Sysbox runtime (real-programs slice 1). `infra` |
| `specs/2026-06-18-cloud-deploy-integration-merge-design.md` | Integrating cloud-deploy trunk into sysbox-programs branch. `infra` |
| `specs/2026-06-20-gui-dev-tool-streaming-design.md` | GUI dev-tool streaming + AI command control (approved). |
| `specs/2026-06-21-program-workspace-file-sync-design.md` | Program ↔ workspace file sync foundation (approved). |
| `specs/2026-06-22-cli-tui-programs-in-integrated-terminal-design.md` | CLI/TUI programs in integrated terminal spec. |
| `specs/2026-06-22-gui-catalog-web-ui-docker-portainer-design.md` | GUI catalog web-UI tier + Portainer spec. |
| `specs/2026-06-22-kasmvnc-stream-auto-login-design.md` | Per-session injected KasmVNC credentials design. |
| `specs/2026-06-23-programs-panel-uiux-overhaul-design.md` | Programs panel UI/UX overhaul design. |
| `specs/2026-06-25-community-app-hosting-design.md` | Community-app hosting submission + hybrid review gate. `product` |
| `specs/2026-06-30-autonomous-review-and-publisher-self-service-design.md` | Autonomous review pipeline + publisher self-service. `product` |
| `specs/2026-07-01-ai-assisted-manifest-authoring-design.md` | AI-assisted manifest authoring. `ai-engine` |
| `specs/2026-07-04-paid-apps-design.md` | Paid apps marketplace billing control plane. `product` |
| `specs/2026-07-25-codesite-panel-redesign-design.md` | CodeSite panel redesign design. `dojo` |

### docs/superpowers/ root
| File | Summary | Type |
|---|---|---|
| `2026-06-12-opus-handoff-implementation-prompt.md` | Self-contained copy-paste handoff prompt for a fresh Opus chat implementing the GKE Sysbox per-workspace Docker runtime (Phase 2). | plan |

---

## 7. infra — Deployment, cloud, performance

| File | Summary | Type |
|---|---|---|
| `CONTAINER_FIRST_ARCHITECTURE.md` | Container-first architecture eliminating "ghost errors" (stale diagnostics after AI-applied suggestions). | reference |
| `COST_OPTIMIZATION_REVIEW.md` | Cost review recommending No-Go for Spot VMs on the primary workspace pool. | reference |
| `LATENCY_BUDGETS.md` | Baseline latency report and reference p95 budgets from the Compiled HMR Recovery Plan. | reference |

---

## 8b. Parallel abstractions (worker consolidation)

| File | Summary | Type |
|---|---|---|
| `PARALLEL_ABSTRACTIONS_CONSOLIDATION.md` | Plan to consolidate overlapping/parallel abstractions in the worker codebase; marked ✅ IMPLEMENTED (Dec 2025, same audit batch as the AI_HMR reports). Tag `gpu-hmr`. | status |

---

## 8. security — Sandboxing & trust boundaries

| File | Summary | Type |
|---|---|---|
| `SECURITY_SANDBOXING.md` | Security model for Synthi HMR — explicit RCE-by-design warning and sandboxing requirements before use outside trusted local envs. | reference |

(Local Support app security docs are under §9 `product`; k8s policy tests under §12.)

---

## 9. product — Vectant Local Support App

Installable support bridge letting the cloud product access selected local machine context
in a controlled, visible way.

| File | Summary | Type |
|---|---|---|
| `VECTANT_LOCAL_SUPPORT_APP_PLAN.md` | Product goal/plan for the installable Local Support App connecting Vectant to controlled local context. | plan |
| `VECTANT_LOCAL_SUPPORT_APP_SECURITY_TRANSPARENCY_PLAN.md` | v3 security/transparency design: read-only, session-scoped, locally enforced support bridge. | plan |
| `VECTANT_LOCAL_SUPPORT_APP_FULL_ACCESS_AND_PROCESS_VISIBILITY_PLAN.md` | Separate production plan for opt-in higher-trust modes (full access, process visibility) without weakening MVP defaults. | plan |
| `VECTANT_LOCAL_SUPPORT_APP_REMAINING_IMPLEMENTATION_GOALS.md` | Remaining goals baseline (~44% complete) building on existing Rust helpers and transparency UI. | status |
| `VECTANT_LOCAL_SUPPORT_APP_IMPLEMENTATION_EVIDENCE.md` | Verification evidence (latest local Windows check 2026-07-13; daemon status projections updated 2026-08-21). | status |
| `VECTANT_LOCAL_SUPPORT_APP_INCIDENT_RESPONSE.md` | Incident-response runbook around real control-plane actions; missing state treated as fail-closed incident. | runbook |
| `VECTANT_LOCAL_SUPPORT_INCIDENT_RESPONSE.md` | Broader incident-response runbook: device-key compromise, malicious pairing, signing-key compromise; IC may disable globally without a release. | runbook |

---

## 10. docs/obsidian-src/ — vault source notes (this directory)

Sibling deep-dive analyses assembled into the Obsidian vault by `scripts/assemble_obsidian_vault.py`.
This file (`docs-and-tooling.md`) is one of the nine notes.

| File | Summary |
|---|---|
| `ai-engine.md` | Service analysis of `ai-backend/ai-engine`. |
| `collab-server.md` | Service analysis of `backend/collab-server`. *(listed on disk; not shown in first dir scan above)* |
| `dojo-codesite.md` | Dojo, CodeSite & Local Support trust-infrastructure analysis. |
| `frontend-synthi.md` | Frontend analysis of the `synthi/` Next.js 15 IDE. |
| `gpu-hmr.md` | GPU-HMR analysis (ROCM/HIP, gfx1201, proof ledger, fission). |
| `infra-deployment.md` | Infra/deployment survey (compose, k8s/, cloudbuild, cloudrun/, ops/). |
| `mcp-synthi.md` | `mcp/synthi-mcp` TypeScript MCP server analysis. |
| `rust-systems.md` | Rust systems analysis (WebRTC signaling, coturn, android-emulator, local-support). |
| `supporting-services.md` | Supporting services: packages/, y-sweet, webrtc-compiler, gateway, agent-runner, oauth-extension. |

### Other evidence artifacts in docs/
| Path | Contents | Type |
|---|---|---|
| `docs/proofs/jupyter-workspace-visual.png` | Visual proof screenshot for Jupyter notebook workspace support. | proof |

---

## 11. scripts/ — tooling catalog (24 files)

One-line purpose per file (task estimated 23; actual count is 24).

| Script | Purpose |
|---|---|
| `assemble_obsidian_vault.py` | Assemble `docs/obsidian-src/*.md` analyses into Obsidian vault notes with frontmatter/provenance; idempotent. |
| `build-oauth-relay-extension.mjs` | Build/package the Vectant OAuth Relay browser extension. |
| `codesite-gitservice-boundary-proof.mjs` | Acceptance proof of CodeSite GitService boundary behavior. |
| `codesite-gitservice-index-proof.mjs` | Acceptance proof of CodeSite GitService index operations. |
| `codesite-gitservice-worktree-proof.mjs` | Acceptance proof of CodeSite GitService worktree operations. |
| `codesitefs-runtime-boundary-proof.mjs` | Proof of the CodeSiteFS runtime boundary contract. |
| `configure-workspace-node-pool.sh` | Configure the GKE workspace node pool. |
| `deploy-prod.sh` | Deploy the stack to production. |
| `live-agent-recognition-proof.sh` | Live proof that differently-owned agents auto-recognize each other in one shared session. |
| `live-bidirectional-chat-proof.sh` | Live proof of mediated agent-to-agent chat round-trip (closes review caveat #2). |
| `live-canonical-acceptance-proof.sh` | Canonical acceptance proof (plan §9) of shared-session CodeSite. |
| `live-channel-fuzzer.mjs` | Fuzz registered direct channels against the live stack. |
| `live-channel-proof.sh` | Live proof of registered direct channels (companion to their design docs). |
| `live-multi-agent-proof.sh` | Live proof: two differently-owned agents attach to one shared project with durable impact notices. |
| `live-runtime-observation-proof.sh` | Live proof: managed-runtime crash becomes a normalized causal event + routed inbox notice. |
| `live-shadow-executed-proof.sh` | Executed shadow-merge proof (Workstream E §9.4 executed mode). |
| `live-shadow-fuzzer.mjs` | Scenario fuzzer for CodeSite shadow merge + control plane. |
| `passive-workspace-agent-discovery.mjs` | Black-box acceptance proof of the passive workspace instruction contract (plain Codex/Claude, no MCP hints). |
| `run-codesite-tests.mjs` | Run CodeSite control-plane + route suites via pinned standalone Vitest harness. |
| `run-project.sh` | Local development runner for the whole project. |
| `start-gpu-stack.ps1`, `start-gpu-stack.sh` | Start the local GPU worker stack (build/pull flags, image override). |
| `trigger_therapeutic_tomography.py` | Deterministically generate + validate the Therapeutic Tomography demo trace (no deploy). |
| `validate-dojo-release-render.sh` | Validate a rendered Kubernetes manifest for the Dojo release gate. |

---

## 12. e2e/, tests/, probe/, tasks/, ops/

### e2e/ — Playwright (summary)
- `playwright.config.ts` lives at the **repo root**: `testDir: './tests'`, `fullyParallel`,
  `forbidOnly` on CI, `retries: 2` on CI only, single worker on CI, HTML reporter;
  standard devices/projects config.
- `e2e/example.spec.ts` — stock Playwright scaffold spec (hits playwright.dev); placeholder only.
- Real end-to-end coverage lives under `tests/`.

### tests/ — Playwright + node-assert suites
| Spec | Purpose | Tag |
|---|---|---|
| `tests/example.spec.ts` | Stock Playwright demo spec (placeholder). | infra |
| `tests/local-support-admin.spec.ts` | Browser E2E for Local Support admin surfaces (requires `VECTANT_TEST_BASE_URL`). | product |
| `tests/local-support-desktop-shell.spec.ts` | Desktop-shell tests loading the static transparency UI via file URL. | product |
| `tests/local-support-live-cloud.spec.ts` | Live cloud E2E, gated by `LOCAL_SUPPORT_LIVE_CLOUD_E2E=1`; imports app Prisma client. | product |
| `tests/local-support-live-daemon.spec.ts` | Spawns/exercises the local daemon over HTTP. | product |
| `tests/local-support-live-relay.spec.ts` | Live relay E2E using tempdirs + child processes. | product |
| `tests/local-support-staging-smoke.spec.ts` | Staging smoke suite gated by `LOCAL_SUPPORT_STAGING_E2E=1`. | product |
| `tests/local-support-transparency.spec.ts` | Transparency UI behavior tests. | security |
| `tests/security/k8s-network-policies.test.mjs` | Asserts k8s NetworkPolicy manifests match expected policy posture. | security |
| `tests/security/k8s-preview-ingress-iap.test.mjs` | Asserts preview ingress/IAP configuration in k8s manifests. | security |

### probe/synthi-probe — cooperative enriched-tier C library
- `README.md`: guest programs link `synthi-probe` to publish semantic UI entities (labels,
  buttons, text fields) to a listening Synthi MCP agent — for UIs the a11y bridge can't read
  (SDL2/OpenGL/custom renderers). Distributed as binary releases on ghcr (proprietary posture).
- `Makefile`: POSIX reference build — static + shared lib + `example_counter`; no external deps.
- `include/synthi_probe.h`, `src/synthi_probe.c` (~16 KB): library implementation.
- `examples/example_counter.c`: sample guest program.
Tag: `mcp` (+`gpu-hmr` consumers). Type: reference/tooling.

### tasks/ — working notes & handoffs
| File | Summary | Tag |
|---|---|---|
| `todo.md` (190 KB) | Rolling task log; carries standing warnings (e.g. programs work = command/CLI control only, visual GUI driving is next). | product |
| `lessons.md` (50 KB) | Accumulated engineering lessons (brand assets, NEXT_PUBLIC_* build-time injection, etc.). | infra |
| `handoff-real-programs-in-workspace.md` | Self-contained handoff prompt implementing real programs in the workspace. | infra |
| `handoff-program-workspace-file-sync.md` | Handoff prompt for program ↔ workspace file sync foundation. | infra |
| `handoff-kasmvnc-stream-auto-login.md` | Handoff prompt for KasmVNC stream auto-login. | frontend |
| `handoff-community-app-hosting.md` | Handoff prompt for community-app hosting submission + review gate. | product |
| `e2e-runbook-program-workspace-sync.md` | Verified-state E2E test guide for program/workspace file sync (local hybrid images listed). | runbook |
| `new-project-picker-plan.md` | Plan for the New-Workspace project & file picker on empty workspaces. | frontend |
| `codesite-testid-baseline.txt` | Baseline inventory of `codesite-*` test IDs used by UI tests. | dojo |

### ops/ — cloud provisioning (PowerShell)
| Script | Purpose | Tag |
|---|---|---|
| `cloudrun/ensure-vpc-connector.ps1` | Ensure Cloud Run VPC connector in `europe-west10`. | infra |
| `gcp/ensure-standalone-edge-alb.ps1` | Ensure standalone edge ALB on `synthi-beta-cluster`. | infra |
| `gke/ensure-hybrid-node-pools.ps1` | Ensure hybrid node pools on `synthi-beta-cluster` (project `vectant-proj`). | infra |

---

## Coverage check

- docs/ root: 90/90 .md catalogued (§§1–9).
- docs/obsidian-src: 8 sibling notes + this file (§10).
- docs/superpowers: 1 handoff + 31 plans + 26 specs (§6) = 58.
- Evidence dirs: gpu-hmr-investor-demo/ray-bounce-20260608 (5 artifacts), proofs/ (1 png) (§§1, 10).
- Tooling: scripts/ 24, e2e/ 1 + root config, tests/ 10, probe/ 6, tasks/ 9, ops/ 3 (§§11–12).
- Total .md in docs/: **157**, all accounted for above.
