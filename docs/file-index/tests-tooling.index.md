---
area: tests-tooling
generated: 2026-08-25
files: 51
---

# File Index — tests-tooling (51 files)

Kinds: asset: 1, source/config: 46, test: 4


## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `e2e/example.spec.ts` | 583 | Expect a title "to contain" a substring. |

## asset

| File | Bytes | Note |
|---|---|---|
| `probe/synthi-probe/.gitignore` | 20 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `probe/synthi-probe/Makefile` | 925 | synthi-probe reference build. POSIX-only, no external deps. |
| `probe/synthi-probe/README.md` | 3 | Proprietary posture |
| `probe/synthi-probe/examples/example_counter.c` | 3 | example_counter.c — reference guest integration of synthi-probe. |
| `probe/synthi-probe/include/synthi_probe.h` | 6 | synthi_probe.h — C interface for the cooperative enriched-tier probe. |
| `probe/synthi-probe/src/synthi_probe.c` | 16 | synthi_probe.c — reference implementation of the cooperative probe. |
| `scripts/assemble_obsidian_vault.py` | 4 | Assemble docs/obsidian-src/*.md deep-dive analyses into the Obsidian vault. |
| `scripts/build-oauth-relay-extension.mjs` | 6 | defines `crc32` |
| `scripts/build_file_index.py` | 9 | Build a complete file-by-file index of the vectant-ade repo for the Obsidian vault. |
| `scripts/codesite-gitservice-boundary-proof.mjs` | 20 | defines `proofTempRoot` |
| `scripts/codesite-gitservice-index-proof.mjs` | 27 | defines `proofTempRoot` |
| `scripts/codesite-gitservice-worktree-proof.mjs` | 28 | defines `proofTempRoot` |
| `scripts/codesitefs-runtime-boundary-proof.mjs` | 25 | defines `sha256` |
| `scripts/configure-workspace-node-pool.sh` | 2 | Usage: scripts/configure-workspace-node-pool.sh [options] |
| `scripts/deploy-prod.sh` | 5 | Usage: scripts/deploy-prod.sh [options] |
| `scripts/live-agent-recognition-proof.sh` | 4 | Live proof: automatic agent recognition. Two agents owned by DIFFERENT users, |
| `scripts/live-bidirectional-chat-proof.sh` | 9 | MEDIATED AGENT-TO-AGENT CHAT — FULL BIDIRECTIONAL ROUND-TRIP PROOF |
| `scripts/live-canonical-acceptance-proof.sh` | 17 | CANONICAL ACCEPTANCE PROOF (plan §9) — vectant-ade shared-session CodeSite |
| `scripts/live-channel-fuzzer.mjs` | 9 | CHANNEL FUZZER — registered direct channels, live-stack scenario fuzz. |
| `scripts/live-channel-proof.sh` | 11 | REGISTERED DIRECT CHANNELS — LIVE PROOF |
| `scripts/live-multi-agent-proof.sh` | 10 | Live multi-agent connection proof against the running Compose stack. |
| `scripts/live-runtime-observation-proof.sh` | 6 | Live proof: a real managed-runtime crash inside the collab-server becomes a |
| `scripts/live-shadow-executed-proof.sh` | 9 | EXECUTED SHADOW MERGE PROOF (plan Workstream E, §9.4 executed mode) |
| `scripts/live-shadow-fuzzer.mjs` | 12 | LIVE SCENARIO FUZZER — vectant-ade CodeSite shadow merge + control plane |
| `scripts/passive-workspace-agent-discovery.mjs` | 8 | Black-box acceptance proof for Vectant's passive workspace instruction |

## test

| File | Bytes | Note |
|---|---|---|
| `scripts/run-codesite-tests.mjs` | 2 | Runs the CodeSite control-plane + route test suites from source with a |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `scripts/run-project.sh` | 6 | repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" |
| `scripts/start-gpu-stack.ps1` | 6 | [string]$Image = $env:SYNTHI_WORKER_GPU_IMAGE, |
| `scripts/start-gpu-stack.sh` | 5 | repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" |
| `scripts/trigger_therapeutic_tomography.py` | 7 | Generate and validate the Agent Therapeutic Tomography demo trace. |
| `scripts/validate-dojo-release-render.sh` | 3 | echo "Usage: $0 <rendered-kubernetes-manifest.yaml>" >&2 |

## test

| File | Bytes | Note |
|---|---|---|
| `tasks/codesite-testid-baseline.txt` | 2 | codesite-assumption-invalidator |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `tasks/e2e-runbook-program-workspace-sync.md` | 5 | E2E test guide — program↔workspace file sync (local hybrid) |
| `tasks/handoff-community-app-hosting.md` | 7 | Handoff prompt — Community-App Hosting (submission + hybrid review gate) |
| `tasks/handoff-kasmvnc-stream-auto-login.md` | 12 | Handoff — implement KasmVNC stream auto-login (per-session injected credentials) |
| `tasks/handoff-program-workspace-file-sync.md` | 9 | HANDOFF — Implement "Program ↔ Workspace file sync (foundation)" |
| `tasks/handoff-real-programs-in-workspace.md` | 18 | HANDOFF PROMPT — "Real programs in the workspace" (Vectant/synthi) |
| `tasks/lessons.md` | 49 | - When a user provides logo or brand image assets, use the supplied files directly instead of recreating the artwork in SVG or code. |
| `tasks/new-project-picker-plan.md` | 5 | New-Workspace Project & File Picker — Plan 2026-05-12 |
| `tasks/todo.md` | 186 | > ⚠️⚠️ **RECURRING REMINDER — READ WHENEVER TOUCHING "PROGRAMS" / GUI DEV TOOLS** ⚠️⚠️ |
| `tests/example.spec.ts` | 583 | Expect a title "to contain" a substring. |
| `tests/local-support-admin.spec.ts` | 2 | import { expect, test } from "@playwright/test"; |
| `tests/local-support-desktop-shell.spec.ts` | 23 | import { expect, test } from "@playwright/test"; |
| `tests/local-support-live-cloud.spec.ts` | 4 | import { test, expect } from '@playwright/test'; |
| `tests/local-support-live-daemon.spec.ts` | 8 | import { test, expect } from '@playwright/test'; |
| `tests/local-support-live-relay.spec.ts` | 11 | import { test, expect } from '@playwright/test'; |
| `tests/local-support-staging-smoke.spec.ts` | 3 | import { test, expect } from '@playwright/test'; |
| `tests/local-support-transparency.spec.ts` | 14 | import { expect, test } from "@playwright/test"; |

## test

| File | Bytes | Note |
|---|---|---|
| `tests/security/k8s-network-policies.test.mjs` | 3 | defines `manifestDoc` |
| `tests/security/k8s-preview-ingress-iap.test.mjs` | 2 | defines `manifestDoc` |
