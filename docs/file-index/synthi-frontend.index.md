---
area: synthi-frontend
generated: 2026-08-25
files: 1191
---

# File Index — synthi-frontend (1191 files)

Kinds: asset: 10, image: 17, source/config: 954, test: 210


## asset

| File | Bytes | Note |
|---|---|---|
| `synthi/.dockerignore` | 37 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/.env.example` | 3 | External MCP tool connections (Plan 1a/1b) |

## asset

| File | Bytes | Note |
|---|---|---|
| `synthi/.gcloudignore` | 51 | binary or generated artifact |
| `synthi/.gitignore` | 532 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/@/components/ui/resizable.jsx` | 1 | import * as React from "react" |
| `synthi/Dockerfile` | 7 | Synthi IDE — Frontend (Next.js 15, standalone output) |
| `synthi/Dockerfile.migrate` | 1 | Synthi IDE — Prisma Migration Image |
| `synthi/README.md` | 4 | Getting Started |

## image

| File | Bytes | Note |
|---|---|---|
| `synthi/artifacts/jupyter-create-smoke.png` | 68 | binary or generated artifact |
| `synthi/artifacts/jupyter-execution-success.png` | 154 | binary or generated artifact |
| `synthi/artifacts/jupyter-frontend-smoke.png` | 68 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/components.json` | 450 | JSON data (components.json) |
| `synthi/eslint.config.mjs` | 505 | import { dirname } from "path"; |
| `synthi/jsconfig.json` | 77 | JSON data (jsconfig.json) |
| `synthi/next.config.mjs` | 5 | Resolve a dependency's path robustly whether npm hoisted it to the repo-root |
| `synthi/package-lock.json` | 583 | JSON data (package-lock.json) |
| `synthi/package.json` | 4 | JSON data (package.json) |
| `synthi/postcss.config.mjs` | 94 | '@tailwindcss/postcss': {}, |
| `synthi/prisma/backfills/backfill-workspace-roles.sql` | 1 | Backfill: WorkspaceMembership.role (Plan 1a addendum R1-9) |
| `synthi/prisma/migrations/20251010085525_add_basic_user_to_test_connection/migration.sql` | 332 | CreateTable |
| `synthi/prisma/migrations/20251010143741_add_workspaces_support_in_db/migration.sql` | 1 | CreateTable |
| `synthi/prisma/migrations/20251010150613_add_name_field_to_workspace_item/migration.sql` | 238 | - Added the required column `name` to the `WorkspaceItem` table without a default value. This is not possible if the table is not empty. |
| `synthi/prisma/migrations/20251011111949_add_is_folder_property_to_workspace_item/migration.sql` | 100 | ALTER TABLE "WorkspaceItem" ADD COLUMN     "isFolder" BOOLEAN NOT NULL DEFAULT false; |
| `synthi/prisma/migrations/20251012121413_remove_workspace_item_model/migration.sql` | 371 | DropForeignKey |
| `synthi/prisma/migrations/20251211194534_jfasldkf/migration.sql` | 492 | CreateIndex |
| `synthi/prisma/migrations/20260517000000_explicit_workspace_membership/migration.sql` | 1 | CreateTable |
| `synthi/prisma/migrations/20260526153000_add_github_token_metadata/migration.sql` | 128 | ADD COLUMN IF NOT EXISTS "githubTokenCipher" TEXT, |
| `synthi/prisma/migrations/20260610120000_add_github_pat_storage/migration.sql` | 208 | Add encrypted GitHub PAT storage used by auth/session token hydration. |
| `synthi/prisma/migrations/20260612110000_workspace_membership_roles/migration.sql` | 628 | Add durable workspace membership roles. |
| `synthi/prisma/migrations/20260629090000_add_codesite_control_plane/migration.sql` | 20 | CreateTable |
| `synthi/prisma/migrations/20260630030000_add_codesite_proof_repo_state/migration.sql` | 67 | ALTER TABLE "CodeSiteProofBundle" ADD COLUMN "repoStateJson" TEXT; |
| `synthi/prisma/migrations/20260630033000_add_codesite_event_logical_time_cursor/migration.sql` | 246 | CREATE INDEX IF NOT EXISTS "CodeSiteEvent_projectId_logicalTime_idx" |
| `synthi/prisma/migrations/20260630043000_add_codesite_transaction_snapshot_evidence/migration.sql` | 86 | ALTER TABLE "CodeSiteMutationTransaction" ADD COLUMN "baseSnapshotEvidenceJson" TEXT; |
| `synthi/prisma/migrations/20260630195000_add_codesite_substrate_identity/migration.sql` | 1 | ALTER TABLE IF EXISTS "McpCallAudit" |
| `synthi/prisma/migrations/20260701013000_add_codesite_line_provenance_ranges/migration.sql` | 273 | ALTER TABLE "CodeSiteLineProvenance" ADD COLUMN "startLine" INTEGER; |
| `synthi/prisma/migrations/20260701014500_add_codesite_line_provenance_project_range_index/migration.sql` | 159 | CREATE INDEX "CodeSiteLineProvenance_projectId_filePath_startLine_endLine_idx" |
| `synthi/prisma/migrations/20260702093000_add_codesite_project_members/migration.sql` | 2 | CREATE TABLE "CodeSiteProjectMember" ( |
| `synthi/prisma/migrations/20260702094000_add_codesite_proof_signatures/migration.sql` | 306 | ALTER TABLE "CodeSiteProofBundle" ADD COLUMN "proofSignatureJson" TEXT; |
| `synthi/prisma/migrations/20260704120000_add_codesite_governance_workflows/migration.sql` | 4 | CreateTable |
| `synthi/prisma/migrations/20260710120000_add_local_support_relay_control_plane/migration.sql` | 3 | Create durable, body-free Local Support relay delivery state. |
| `synthi/prisma/migrations/20260710130000_add_local_support_paired_session/migration.sql` | 1 | CREATE TABLE "LocalSupportSession" ( |
| `synthi/prisma/migrations/20260710140000_add_local_support_device_nonce/migration.sql` | 719 | CREATE TABLE "LocalSupportDeviceNonce" ( |
| `synthi/prisma/migrations/20260710150000_add_encrypted_local_support_payload/migration.sql` | 906 | Approved Local Support payloads are encrypted before insertion and are |
| `synthi/prisma/migrations/20260711090000_add_durable_local_support_pairing/migration.sql` | 1 | CREATE TABLE "LocalSupportPairingChallenge" ( |
| `synthi/prisma/migrations/20260711110000_add_local_support_session_app_version/migration.sql` | 91 | ALTER TABLE "LocalSupportSession" ADD COLUMN "appVersion" TEXT NOT NULL DEFAULT 'unknown'; |
| `synthi/prisma/migrations/20260711120000_add_local_support_security_events/migration.sql` | 1 | CREATE TABLE "LocalSupportSecurityEvent" ( |
| `synthi/prisma/migrations/20260711130000_add_local_support_policy_state/migration.sql` | 692 | CREATE TABLE "LocalSupportPolicyState" ( |
| `synthi/prisma/migrations/20260713100000_add_local_support_approved_ports/migration.sql` | 93 | ALTER TABLE "LocalSupportSession" ADD COLUMN "approvedPortsJson" TEXT NOT NULL DEFAULT '[]'; |
| `synthi/prisma/migrations/20260714090000_add_local_support_control_commands/migration.sql` | 1 | CREATE TABLE "LocalSupportControlCommand" ( |
| `synthi/prisma/migrations/20260714120000_add_local_support_control_audit/migration.sql` | 1 | CREATE TABLE "LocalSupportControlAudit" ( |
| `synthi/prisma/migrations/20260714150000_add_local_support_policy_org_scope/migration.sql` | 159 | ALTER TABLE "LocalSupportPolicyState" ADD COLUMN "orgId" TEXT; |
| `synthi/prisma/migrations/20260714160000_add_local_support_full_access_policy/migration.sql` | 261 | ALTER TABLE "LocalSupportPolicyState" |
| `synthi/prisma/migrations/20260716234000_add_local_support_control_proposal/migration.sql` | 73 | ALTER TABLE "LocalSupportControlCommand" |
| `synthi/prisma/migrations/20260722000000_add_encrypted_secret/migration.sql` | 268 | CREATE TABLE "EncryptedSecret" ( |
| `synthi/prisma/migrations/20260723000000_add_jupyter_notebook_support/migration.sql` | 1 | CREATE TABLE "JupyterServer" ( |
| `synthi/prisma/migrations/20260728000000_add_programs_marketplace_and_integrations/migration.sql` | 14 | CreateTable |
| `synthi/prisma/migrations/20260821100000_add_local_support_linked_projects/migration.sql` | 1 | CREATE TABLE "LocalSupportLinkedProject" ( |
| `synthi/prisma/migrations/20260822040000_add_codesite_agent_attachment_identity/migration.sql` | 1 | ALTER TABLE "CodeSiteAgentSession" |
| `synthi/prisma/migrations/20260822041500_complete_codesite_agent_attachment_identity/migration.sql` | 1 | Keep legacy project and agent rows valid while preserving every identity supplied |
| `synthi/prisma/migrations/20260822043000_add_codesite_agent_access_token/migration.sql` | 423 | ALTER TABLE "CodeSiteAgentSession" |
| `synthi/prisma/migrations/20260822060000_add_codesite_shared_knowledge/migration.sql` | 4 | CREATE TABLE "CodeSiteKnowledgeItem" ( |
| `synthi/prisma/migrations/20260823070000_add_codesite_agent_channels/migration.sql` | 1 | Registered direct channels (docs/REGISTERED_DIRECT_CHANNELS_DESIGN.md) |
| `synthi/prisma/migrations/migration_lock.toml` | 128 | Please do not edit this file manually |

## asset

| File | Bytes | Note |
|---|---|---|
| `synthi/prisma/schema.prisma` | 45 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/public/content-hash-worker.js` | 1 | content-hash-worker.js — Off-main-thread content hashing via crypto.subtle. |
| `synthi/public/extension-host-worker-hardened.js` | 59 | Synthi Extension System - Hardened Extension Host Worker |
| `synthi/public/extension-host-worker.js` | 18 | Synthi Extension Host Worker - Bundled Version |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/public/extension-test-v2.html` | 36 | { box-sizing: border-box; } |
| `synthi/public/extension-test-v3.html` | 27 | html asset |
| `synthi/public/extension-test.html` | 26 | { box-sizing: border-box; } |

## asset

| File | Bytes | Note |
|---|---|---|
| `synthi/public/extensions/synthi-oauth-relay-v0.1.0.zip` | 4 | binary or generated artifact |
| `synthi/public/extensions/synthi-oauth-relay.zip` | 4 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/public/extensions/synthi-oauth-relay/README.md` | 2 | Vectant OAuth Relay Extension |
| `synthi/public/extensions/synthi-oauth-relay/background.js` | 7 | defines `storageArea` |
| `synthi/public/extensions/synthi-oauth-relay/content-bridge.js` | 884 | const PAGE_SOURCES = new Set(['vectant-oauth-relay-page', 'synthi-oauth-relay-page']); |
| `synthi/public/extensions/synthi-oauth-relay/manifest.json` | 747 | Relays redirected localhost OAuth callbacks from your browser into an active Vectant workspace. |

## image

| File | Bytes | Note |
|---|---|---|
| `synthi/public/file.svg` | 391 | binary or generated artifact |
| `synthi/public/globe.svg` | 1 | binary or generated artifact |
| `synthi/public/next.svg` | 1 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/public/node-polyfills.js` | 561 | defines `__require` |

## image

| File | Bytes | Note |
|---|---|---|
| `synthi/public/synthi-dark-logo.svg` | 57 | binary or generated artifact |
| `synthi/public/synthi-logo.svg` | 32 | binary or generated artifact |
| `synthi/public/synthi-v-mark.svg` | 0 | binary or generated artifact |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/public/test-extension.vsix` | 1 |     ;VJ\AX/�  �     extension/package.json]�KO�0�������PnU�P����&�v��Ȼ |

## image

| File | Bytes | Note |
|---|---|---|
| `synthi/public/vectant-dark-theme.png` | 62 | binary or generated artifact |
| `synthi/public/vectant-light-theme.png` | 57 | binary or generated artifact |

## asset

| File | Bytes | Note |
|---|---|---|
| `synthi/public/vectant/extensions/vectant-oauth-relay-v0.1.0.zip` | 4 | binary or generated artifact |
| `synthi/public/vectant/extensions/vectant-oauth-relay.zip` | 4 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/public/vectant/extensions/vectant-oauth-relay/README.md` | 2 | Vectant OAuth Relay Extension |
| `synthi/public/vectant/extensions/vectant-oauth-relay/background.js` | 7 | defines `storageArea` |
| `synthi/public/vectant/extensions/vectant-oauth-relay/content-bridge.js` | 884 | const PAGE_SOURCES = new Set(['vectant-oauth-relay-page', 'synthi-oauth-relay-page']); |
| `synthi/public/vectant/extensions/vectant-oauth-relay/manifest.json` | 747 | Relays redirected localhost OAuth callbacks from your browser into an active Vectant workspace. |

## image

| File | Bytes | Note |
|---|---|---|
| `synthi/public/vectant/left_bracket_full.png` | 26 | binary or generated artifact |
| `synthi/public/vectant/right_bracket_full.png` | 26 | binary or generated artifact |
| `synthi/public/vectant/the_V.png` | 113 | binary or generated artifact |
| `synthi/public/vercel.svg` | 128 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/public/vscode-tunnel-sw.js` | 7 | Synthi VS Code Tunnel Service Worker |

## image

| File | Bytes | Note |
|---|---|---|
| `synthi/public/window.svg` | 385 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/scripts/build-node-polyfills.js` | 1 | Build script: bundles all Node.js browser polyfills into a single file |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/scripts/build-test-vsix.js` | 2 | Build a minimal test .vsix file for testing the extension install flow. |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/scripts/codesite-channel-relay.cjs` | 7 | CodeSite registered direct channel — relay transport (Phase 2). |
| `synthi/scripts/codesite-counterfactual-memory-proof.mjs` | 21 | defines `repoRoot` |
| `synthi/scripts/codesite-emergency-broadcasts-proof.mjs` | 14 | defines `repoRoot` |
| `synthi/scripts/codesite-filesystem-boundary-proof.mjs` | 12 | defines `repoRoot` |
| `synthi/scripts/codesite-full-workflow-proof.mjs` | 211 | import crypto from 'node:crypto'; |
| `synthi/scripts/codesite-line-inspector-proof.mjs` | 22 | defines `repoRoot` |
| `synthi/scripts/codesite-metrics-proof.mjs` | 15 | defines `repoRoot` |
| `synthi/scripts/codesite-mutation-surface-coverage-proof.mjs` | 17 | defines `repoRoot` |
| `synthi/scripts/codesite-pilot-license-proof.mjs` | 19 | defines `repoRoot` |
| `synthi/scripts/codesite-proof-api.mjs` | 5 | defines `proofAuthCookieHeader` |
| `synthi/scripts/codesite-proof-verify.mjs` | 22 | defines `main` |
| `synthi/scripts/codesite-quarantine-review-proof.mjs` | 54 | defines `repoRoot` |
| `synthi/scripts/codesite-radar-adapter-proof.mjs` | 11 | import path from 'node:path'; |
| `synthi/scripts/codesite-release-gate-suite-freshness-proof.mjs` | 7 | defines `git` |
| `synthi/scripts/codesite-release-gate.mjs` | 72 | import crypto from 'node:crypto'; |
| `synthi/scripts/codesite-repo-local-autosync-proof.mjs` | 22 | defines `repoRoot` |
| `synthi/scripts/codesite-repo-policy-compiler-proof.mjs` | 14 | defines `repoRoot` |
| `synthi/scripts/codesite-run-mature-proof-suite.mjs` | 26 | import { execFileSync, spawnSync } from 'node:child_process'; |
| `synthi/scripts/codesite-runtime-mount-boundary-proof.mjs` | 12 | defines `repoRoot` |
| `synthi/scripts/codesite-runtime-quarantine-proof.mjs` | 18 | defines `repoRoot` |
| `synthi/scripts/codesite-runway-occupancy-proof.mjs` | 15 | defines `repoRoot` |
| `synthi/scripts/codesite-shadow-runner.mjs` | 45 | import crypto from 'node:crypto'; |
| `synthi/scripts/codesite-shadow-simulator-proof.mjs` | 19 | defines `repoRoot` |
| `synthi/scripts/codesite-ui-governance-proof.mjs` | 39 | defines `route` |
| `synthi/scripts/codesite-unmanaged-host-boundary-proof.mjs` | 22 | defines `repoRoot` |
| `synthi/scripts/dojo-ghost-mode-visual-proof.mjs` | 10 | import { spawn, spawnSync } from "node:child_process"; |
| `synthi/scripts/dojo-visual-proof-utils.mjs` | 78 | export * from "../../mcp/synthi-mcp/scripts/lib/dojo-visual-proof-utils.mjs"; |
| `synthi/scripts/dojo-visual-proof.mjs` | 44 | import { spawn, spawnSync } from "node:child_process"; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/scripts/live-test-nep.mjs` | 33 | Next-Edit Prediction (NEP) live-test harness. |

## asset

| File | Bytes | Note |
|---|---|---|
| `synthi/scripts/nep-replay-fixture.jsonl` | 1 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/scripts/nep-replay.mjs` | 16 | NEP offline replay harness — Phase 3. |
| `synthi/scripts/polyfill-entry.js` | 19 | Node.js polyfill entry point for the extension host worker. |
| `synthi/scripts/prepare-standalone.js` | 1 | const fs = require("node:fs"); |
| `synthi/scripts/shadow-card-visual-proof.mjs` | 9 | defines `main` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/scripts/test-ai-primitives.mjs` | 5 | import assert from 'node:assert/strict'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/ReduxProvider.jsx` | 382 | import { Provider } from 'react-redux'; |
| `synthi/src/app/SessionProvider.jsx` | 339 | renders `NextAuthSessionProvider` |
| `synthi/src/app/[slug]/page.jsx` | 844 | import { redirect } from 'next/navigation'; |
| `synthi/src/app/api/admin/program-reviews/[versionId]/route.js` | 1 | POST /api/admin/program-reviews/:versionId  body {action:'approve'/'reject', notes?} |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/admin/program-reviews/__tests__/adminReviewRoutes.test.js` | 3 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/admin/program-reviews/route.js` | 728 | GET /api/admin/program-reviews — platform-admin only: the pending_review queue. |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/agent/__tests__/route.test.js` | 9 | defines `request` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/agent/route.js` | 24 | import { NextResponse } from 'next/server'; |
| `synthi/src/app/api/auth/[...nextauth]/route.js` | 160 | import NextAuth from 'next-auth'; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/auth/token/__tests__/route.test.js` | 3 | import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/auth/token/route.js` | 5 | defines `hashRuntimeScopePart` |
| `synthi/src/app/api/browser-workflows/[...path]/route.js` | 22 | defines `runtime` |
| `synthi/src/app/api/browser-workflows/state/route.js` | 294 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/chat/__tests__/externalTools.test.js` | 11 | All mock handles via vi.hoisted so the hoisted vi.mock factories don't hit a TDZ. |
| `synthi/src/app/api/chat/__tests__/route.test.js` | 8 | import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/chat/approve-command/route.js` | 4 | API endpoint for approving/rejecting pending AI command executions. |
| `synthi/src/app/api/chat/externalTools.js` | 10 | defines `isExternalToolName` |
| `synthi/src/app/api/chat/route.js` | 98 | import { NextResponse } from 'next/server'; |
| `synthi/src/app/api/chat/toolDefinitions.js` | 28 | Gemini Function Calling — Tool Definitions & Executors |
| `synthi/src/app/api/classify/intent/route.js` | 235 | defines `POST` |
| `synthi/src/app/api/code-intel/[...path]/route.js` | 648 | defines `runtime` |
| `synthi/src/app/api/completion/route.js` | 21 | import { NextResponse } from 'next/server'; |
| `synthi/src/app/api/counterfactual/[...path]/route.js` | 1 | Authenticated same-origin bridge for the counterfactual control plane. |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/counterfactual/[...path]/route.test.js` | 1 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/extensions/search/route.js` | 8 | Open VSX Registry API Proxy |
| `synthi/src/app/api/format/route.js` | 2 | defines `POST` |
| `synthi/src/app/api/github/create-repo/route.js` | 2 | defines `POST` |
| `synthi/src/app/api/integrations/connections/[id]/route.js` | 2 | defines `PATCH` |
| `synthi/src/app/api/integrations/connections/[id]/test/route.js` | 1 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/connections/__tests__/connectionRoutes.test.js` | 7 | import { describe, it, expect, vi, beforeEach } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/connections/route.js` | 3 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/git/oauth/[provider]/__tests__/oauthWeb.test.js` | 3 | import { describe, it, expect, vi, beforeEach } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/git/oauth/[provider]/callback/route.js` | 2 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/git/oauth/[provider]/device/__tests__/oauthDevice.test.js` | 4 | import { describe, it, expect, vi, beforeEach } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/git/oauth/[provider]/device/poll/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/integrations/git/oauth/[provider]/device/start/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/integrations/git/oauth/[provider]/start/route.js` | 1 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/git/providers/[id]/__tests__/actionRoutes.test.js` | 4 | import { describe, it, expect, vi, beforeEach } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/git/providers/[id]/pulls/route.js` | 3 | pulls/route.js |
| `synthi/src/app/api/integrations/git/providers/[id]/repos/route.js` | 457 | repos/route.js |
| `synthi/src/app/api/integrations/git/providers/[id]/route.js` | 1 | defines `DELETE` |
| `synthi/src/app/api/integrations/git/providers/[id]/status/route.js` | 592 | status/route.js |
| `synthi/src/app/api/integrations/git/providers/[id]/test/route.js` | 1 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/git/providers/__tests__/providerRoutes.test.js` | 1 | import { describe, it, expect, vi, beforeEach } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/git/providers/route.js` | 2 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/audit/__tests__/auditRoute.test.js` | 8 | defines `req` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/audit/route.js` | 5 | defines `runtime` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/jupyter/__tests__/jupyterRoute.test.js` | 5 | defines `request` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/jupyter/route.js` | 8 | defines `runtime` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/programs/[sessionId]/__tests__/lifecycleRoutes.test.js` | 2 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/programs/[sessionId]/restart/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/integrations/mcp/programs/[sessionId]/route.js` | 2 | PAT-gated single-session read for the MCP `synthi_read_session` tool |
| `synthi/src/app/api/integrations/mcp/programs/[sessionId]/stop/route.js` | 1 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/programs/__tests__/programsRoutes.test.js` | 5 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/app/api/integrations/mcp/programs/detect/__tests__/route.test.js` | 2 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/programs/detect/route.js` | 4 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/programs/launch/__tests__/launchRoute.test.js` | 5 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/programs/launch/route.js` | 4 | defines `runtime` |
| `synthi/src/app/api/integrations/mcp/programs/route.js` | 1 | PAT-gated program inventory for the MCP `synthi_list_programs` tool |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/resolve/__tests__/resolveRoute.test.js` | 1 | defines `req` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/resolve/route.js` | 1 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/runtime-exec/__tests__/runtimeExecRoute.test.js` | 4 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/mcp/runtime-exec/route.js` | 3 | PAT-gated runtime command exec for the MCP `synthi_exec_in_runtime` tool |
| `synthi/src/app/api/integrations/tokens/[id]/route.js` | 1 | defines `DELETE` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/integrations/tokens/__tests__/tokenRoutes.test.js` | 3 | defines `req` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/integrations/tokens/route.js` | 1 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/internal/payments/webhook/__tests__/webhookRoute.test.js` | 3 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/internal/payments/webhook/route.js` | 2 | POST /api/internal/payments/webhook |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/internal/programs/process-pending/__tests__/processPendingRoute.test.js` | 1 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/internal/programs/process-pending/route.js` | 1 | POST /api/internal/programs/process-pending |
| `synthi/src/app/api/local-support/admin/state/route.js` | 3 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/admin/state/route.test.js` | 13 | import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/httpGuards.js` | 3 | defines `readBoundedJson` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/httpGuards.test.js` | 5 | defines `mockJsonRequest` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/linked-projects/route.js` | 4 | defines `GET` |
| `synthi/src/app/api/local-support/pairing/route.js` | 3 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/pairing/route.test.js` | 12 | import { createHash, generateKeyPairSync, sign } from "node:crypto"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/policy/route.js` | 1 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/policy/route.test.js` | 1 | import { afterEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/preview-gateway/route.js` | 2 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/preview-gateway/route.test.js` | 9 | defines `enableLocalSupport` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/relay/device/payload/route.js` | 3 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/relay/device/payload/route.test.js` | 4 | defines `request` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/relay/device/route.js` | 8 | defines `runtime` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/relay/device/route.test.js` | 9 | import { beforeEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/relay/payload/route.js` | 1 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/relay/payload/route.test.js` | 2 | defines `request` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/relay/route.js` | 3 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/relay/route.test.js` | 11 | import { afterEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/request-envelope/route.js` | 2 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/request-envelope/route.test.js` | 10 | import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/security-event/route.js` | 2 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/security-event/route.test.js` | 5 | defines `request` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/test-request/route.js` | 3 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/test-request/route.test.js` | 2 | defines `request` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/transparency-action/route.js` | 17 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/transparency-action/route.test.js` | 25 | import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/local-support/transparency-state/route.js` | 7 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/local-support/transparency-state/route.test.js` | 9 | import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/next-edit/flag/route.js` | 1 | NEP server-side kill switch (Phase 3). |
| `synthi/src/app/api/next-edit/route.js` | 24 | import { NextResponse } from 'next/server'; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/next-edit/telemetry/__tests__/route.test.js` | 2 | defines `req` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/next-edit/telemetry/route.js` | 4 | NEP telemetry aggregator (Phase 3). |
| `synthi/src/app/api/oauth-relay/callback/route.js` | 2 | defines `POST` |
| `synthi/src/app/api/oauth-relay/session/route.js` | 1 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/programs/__tests__/seedDefaultsRoute.test.js` | 1 | import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/programs/seed-defaults/route.js` | 888 | POST /api/programs/seed-defaults |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/provenance/[...path]/__tests__/route.test.js` | 3 | defines `ctx` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/provenance/[...path]/route.js` | 2 | defines `runtime` |
| `synthi/src/app/api/shadow/[jobId]/apply/route.js` | 1 | Synthi Genome — POST /api/shadow/[jobId]/apply |
| `synthi/src/app/api/shadow/[jobId]/cancel/route.js` | 865 | Synthi Genome — POST /api/shadow/[jobId]/cancel |
| `synthi/src/app/api/shadow/[jobId]/stream/route.js` | 1 | Synthi Genome — GET /api/shadow/[jobId]/stream |
| `synthi/src/app/api/shadow/[jobId]/why/route.js` | 1 | Synthi Genome — POST /api/shadow/[jobId]/why |
| `synthi/src/app/api/shadow/cost/route.js` | 2 | Synthi Genome — /api/shadow/cost |
| `synthi/src/app/api/shadow/run/route.js` | 2 | Synthi Genome — POST /api/shadow/run |
| `synthi/src/app/api/shadow/verify-only/route.js` | 2 | Synthi Genome — POST /api/shadow/verify-only |
| `synthi/src/app/api/shadow_continuous/opt_out/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/shadow_continuous/state/route.js` | 1 | GET /api/shadow_continuous/state?workspace_path=... |
| `synthi/src/app/api/theme-generate/route.js` | 6 | POST /api/theme-generate |
| `synthi/src/app/api/turn-credentials/route.js` | 3 | GET /api/turn-credentials |
| `synthi/src/app/api/user/github-token/route.js` | 2 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/codesite/[[...path]]/route.js` | 42 | acknowledgeInboxItemForAgent, |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/codesite/__tests__/codesiteRoute.test.js` | 51 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/index/ensure/route.js` | 825 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/index/status/route.js` | 503 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/item/__tests__/route.test.js` | 8 | defines `request` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/item/route.js` | 15 | defines `badRequest` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/jupyter/__tests__/routes.test.js` | 5 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/jupyter/execute/route.js` | 2 | defines `POST` |
| `synthi/src/app/api/workspace/[slug]/jupyter/kernels/[kernelId]/interrupt/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/workspace/[slug]/jupyter/kernels/[kernelId]/restart/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/workspace/[slug]/jupyter/save/route.js` | 2 | defines `POST` |
| `synthi/src/app/api/workspace/[slug]/jupyter/servers/[id]/route.js` | 681 | defines `DELETE` |
| `synthi/src/app/api/workspace/[slug]/jupyter/servers/[id]/test/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/workspace/[slug]/jupyter/servers/route.js` | 1 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/jupyter/snapshot/route.js` | 1 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/members/route.js` | 2 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/program-sessions/[sessionId]/events/route.js` | 1 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/program-sessions/[sessionId]/restart/route.js` | 1 | defines `POST` |
| `synthi/src/app/api/workspace/[slug]/program-sessions/[sessionId]/route.js` | 2 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/program-sessions/[sessionId]/stop/route.js` | 1 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/program-sessions/__tests__/programSessionRoutes.test.js` | 11 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/program-sessions/route.js` | 4 | defines `GET` |
| `synthi/src/app/api/workspace/[slug]/programs/[installId]/launch/route.js` | 3 | defines `POST` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/programs/__tests__/checkoutRoute.test.js` | 3 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/app/api/workspace/[slug]/programs/__tests__/pricingRoute.test.js` | 3 | defines `PricingError` |
| `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js` | 32 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/workspace/[slug]/programs/checkout/route.js` | 2 | POST /api/workspace/:slug/programs/checkout  { packageId } |
| `synthi/src/app/api/workspace/[slug]/programs/detect/route.js` | 3 | GET /api/workspace/[slug]/programs/detect |
| `synthi/src/app/api/workspace/[slug]/programs/generate-manifest/route.js` | 1 | POST /api/workspace/:slug/programs/generate-manifest |
| `synthi/src/app/api/workspace/[slug]/programs/install/route.js` | 5 | defines `POST` |
| `synthi/src/app/api/workspace/[slug]/programs/installed/route.js` | 858 | GET /api/workspace/:slug/programs/installed |
| `synthi/src/app/api/workspace/[slug]/programs/manifest/route.js` | 1 | POST /api/workspace/:slug/programs/manifest  { manifest } |
| `synthi/src/app/api/workspace/[slug]/programs/marketplace/route.js` | 1 | GET /api/workspace/:slug/programs/marketplace?q= |
| `synthi/src/app/api/workspace/[slug]/programs/pricing/route.js` | 2 | POST /api/workspace/:slug/programs/pricing |
| `synthi/src/app/api/workspace/[slug]/programs/publish/route.js` | 2 | POST /api/workspace/:slug/programs/publish |
| `synthi/src/app/api/workspace/[slug]/programs/scaffold/route.js` | 1 | POST /api/workspace/:slug/programs/scaffold  { packageId } |
| `synthi/src/app/api/workspace/[slug]/programs/submissions/route.js` | 907 | GET /api/workspace/:slug/programs/submissions |
| `synthi/src/app/api/workspace/[slug]/programs/unpublish/route.js` | 1 | POST /api/workspace/:slug/programs/unpublish  { packageId } |
| `synthi/src/app/api/workspace/[slug]/route.js` | 6 | defines `buildFileTree` |
| `synthi/src/app/api/workspace/[slug]/search/route.js` | 1 | defines `GET` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/api/workspace/__tests__/route.test.js` | 4 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/api/workspace/route.js` | 7 | defines `GET` |
| `synthi/src/app/auth.js` | 3 | defines `authOptions` |
| `synthi/src/app/auth/loopback/page.jsx` | 49 | import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'; |
| `synthi/src/app/collab/[sessionId]/page.jsx` | 11 | /collab/[sessionId] — Guest invite landing page. |
| `synthi/src/app/dojo-release-seed/page.jsx` | 1 | renders `DojoReleaseSeedPage` |
| `synthi/src/app/editor-overrides.css` | 38 | Editor container with rounded top corners. |
| `synthi/src/app/extension-test/page.jsx` | 1 | renders `ExtensionTestPage` |

## image

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/favicon.ico` | 25 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/globals.css` | 103 | ===== SYNTHI THEME VARIABLES ===== */ |
| `synthi/src/app/layout.js` | 3 | import "./editor-overrides.css"; |
| `synthi/src/app/local-support/admin/page.jsx` | 351 | renders `LocalSupportAdminPage` |
| `synthi/src/app/local-support/page.jsx` | 379 | renders `LocalSupportPage` |
| `synthi/src/app/login/page.jsx` | 11 | import { Suspense, useEffect, useState } from "react"; |
| `synthi/src/app/page.jsx` | 60 | import { useCallback, useEffect, useMemo, useRef, useState } from "react"; |
| `synthi/src/app/workspace/ActivityBar.jsx` | 5 | @param {Object} props |
| `synthi/src/app/workspace/OperatorStatusBarButton.jsx` | 1 | StatusBar trigger for the operator console. Mounts OperatorDialog |
| `synthi/src/app/workspace/ShellSelector.jsx` | 6 | import React, { useState, useEffect, useCallback } from 'react'; |
| `synthi/src/app/workspace/StatusBar.jsx` | 54 | import { memo, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'; |
| `synthi/src/app/workspace/TerminalManager.jsx` | 28 | import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'; |
| `synthi/src/app/workspace/TerminalPane.jsx` | 77 | import React, { useEffect, useRef, useState, useCallback, memo } from 'react'; |
| `synthi/src/app/workspace/TopNav.jsx` | 20 | import { memo, useEffect, useState, useMemo } from 'react'; |
| `synthi/src/app/workspace/VectantLogoCollapsed.jsx` | 8 | VectantLogoCollapsed — the V at the center of the collapsed silhouette. |
| `synthi/src/app/workspace/[slug]/Editor/AICompletion.js` | 33 | defines `useAiCompletion` |
| `synthi/src/app/workspace/[slug]/Editor/ConflictBanner.jsx` | 21 | Detects and parses merge conflict markers in code content |
| `synthi/src/app/workspace/[slug]/Editor/DiffGutterStaging.jsx` | 20 | DiffGutterStaging — JetBrains/IntelliJ-style interactive staging for Monaco DiffEditor. |
| `synthi/src/app/workspace/[slug]/Editor/Editor.jsx` | 292 | src/app/Editor.jsx |
| `synthi/src/app/workspace/[slug]/Editor/NextEditPrediction.js` | 80 | Next-Edit Prediction (NEP) — Phases 1 + 2 + 3. |
| `synthi/src/app/workspace/[slug]/Editor/SelectionContextMenu.jsx` | 4 | SelectionContextMenu — custom right-click menu for the Monaco code editor. |
| `synthi/src/app/workspace/[slug]/Editor/SynthiFileSystemProvider.js` | 11 | SynthiFileSystemProvider |
| `synthi/src/app/workspace/[slug]/Editor/diffManager.js` | 22 | defines `useDiffManager` |
| `synthi/src/app/workspace/[slug]/Editor/events.js` | 19 | defines `useEditorEvents` |
| `synthi/src/app/workspace/[slug]/Editor/gitGutter.css` | 2 | ── Added lines — green bar ─────────────────────────────────────────────── */ |
| `synthi/src/app/workspace/[slug]/Editor/gitGutterPeek.js` | 12 | gitGutterPeek.js — Peek diff widget for git gutter bars |
| `synthi/src/app/workspace/[slug]/Editor/gitGutterService.js` | 16 | gitGutterService.js — Git diff gutter decorations for Monaco Editor |
| `synthi/src/app/workspace/[slug]/Editor/index.js` | 40 | export { default } from './Editor.jsx'; |
| `synthi/src/app/workspace/[slug]/Editor/languageTokenizers.js` | 10 | Monarch Tokenizer Registration |
| `synthi/src/app/workspace/[slug]/Editor/options.js` | 4 | Synthi Editor Options - Premium Configuration |
| `synthi/src/app/workspace/[slug]/Editor/providers.js` | 48 | defines `useEditorProviders` |
| `synthi/src/app/workspace/[slug]/Editor/tabIntentRouter.js` | 2 | defines `TAB_INTENT_OWNER` |
| `synthi/src/app/workspace/[slug]/Editor/theme.js` | 683 | @fileoverview Synthi Editor Theme Bridge |
| `synthi/src/app/workspace/[slug]/Editor/tokenizers/cpp.js` | 6 | Rich Monarch grammar for C / C++. |
| `synthi/src/app/workspace/[slug]/Editor/tokenizers/css.js` | 4 | Rich Monarch grammar for CSS — emits selector, property, value, unit, hex, |
| `synthi/src/app/workspace/[slug]/Editor/tokenizers/html.js` | 4 | Rich Monarch grammar for HTML — emits tag, attribute name, attribute |
| `synthi/src/app/workspace/[slug]/Editor/tokenizers/java.js` | 4 | Rich Monarch grammar for Java — emits annotations, generics, function calls, |
| `synthi/src/app/workspace/[slug]/Editor/tokenizers/javascript.js` | 5 | Rich Monarch grammar for JavaScript — distinguishes function calls, |
| `synthi/src/app/workspace/[slug]/Editor/tokenizers/rust.js` | 4 | Rich Monarch grammar for Rust — distinguishes macros (`println!`), |
| `synthi/src/app/workspace/[slug]/Editor/tokenizers/typescript.js` | 6 | Rich Monarch grammar for TypeScript — extends the JavaScript grammar with |
| `synthi/src/app/workspace/[slug]/Editor/utils.js` | 5 | defines `CONTEXT_SIDE_CHARS` |
| `synthi/src/app/workspace/[slug]/FileItem.jsx` | 32 | src/app/FileItem.jsx |
| `synthi/src/app/workspace/[slug]/FileTree.jsx` | 44 | import { useState, useRef, useEffect, useCallback, memo, useMemo } from "react"; |
| `synthi/src/app/workspace/[slug]/Icons.jsx` | 1 | import { ChevronRight, Folder, FolderOpen, FileCode2, FileJson, FileType, FileText } from 'lucide-react'; |
| `synthi/src/app/workspace/[slug]/SearchView.jsx` | 13 | import { useEffect, useRef, useState, useCallback, useMemo } from "react"; |
| `synthi/src/app/workspace/[slug]/codesite/page.jsx` | 415 | import CodeSitePanel from '@/components/codesite/CodeSitePanel'; |
| `synthi/src/app/workspace/[slug]/dojo/case-law/page.jsx` | 243 | import CaseLawDashboard from '@/components/dojo/CaseLawDashboard'; |
| `synthi/src/app/workspace/[slug]/dojo/debug/time-machine/page.jsx` | 256 | import TimeMachineDebugger from '@/components/dojo/TimeMachineDebugger'; |
| `synthi/src/app/workspace/[slug]/dojo/evidence/page.jsx` | 247 | import EvidenceDashboard from '@/components/dojo/EvidenceDashboard'; |
| `synthi/src/app/workspace/[slug]/dojo/governance/page.jsx` | 255 | import GovernanceDashboard from '@/components/dojo/GovernanceDashboard'; |
| `synthi/src/app/workspace/[slug]/dojo/page.jsx` | 215 | import DojoShell from '@/components/dojo/DojoShell'; |
| `synthi/src/app/workspace/[slug]/dojo/practice/page.jsx` | 262 | import PracticeWorldDashboard from '@/components/dojo/PracticeWorldDashboard'; |
| `synthi/src/app/workspace/[slug]/dojo/skills/[skillId]/cortex/page.jsx` | 313 | import SkillCortexGraph from '@/components/dojo/SkillCortexGraph'; |
| `synthi/src/app/workspace/[slug]/dojo/skills/[skillId]/passport/page.jsx` | 306 | import SkillPassport from '@/components/dojo/SkillPassport'; |
| `synthi/src/app/workspace/[slug]/dojo/skills/page.jsx` | 237 | import SkillCardGrid from '@/components/dojo/SkillCardGrid'; |
| `synthi/src/app/workspace/[slug]/dojo/source/page.jsx` | 251 | import SourceApiDashboard from '@/components/dojo/SourceApiDashboard'; |
| `synthi/src/app/workspace/[slug]/dojo/therapeutic-trace/page.jsx` | 278 | import TherapeuticTomographyTrace from '@/components/dojo/TherapeuticTomographyTrace'; |
| `synthi/src/app/workspace/[slug]/operator/EscapeHatchPanel.jsx` | 13 | EscapeHatchPanel — drains the MCP's escape-hatch queue. |
| `synthi/src/app/workspace/[slug]/operator/OperatorDialog.jsx` | 1 | OperatorDialog — shadcn Dialog wrapper for the operator console. |
| `synthi/src/app/workspace/[slug]/operator/OperatorPanel.jsx` | 8 | OperatorPanel — content-only view for the operator console. Safe to |
| `synthi/src/app/workspace/[slug]/operator/page.jsx` | 769 | `/workspace/<slug>/operator` — opens the operator console as a modal |
| `synthi/src/app/workspace/[slug]/page.jsx` | 178 | import { useState, useEffect, useCallback, useRef, useMemo, startTransition, useDeferredValue } from 'react'; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/app/workspace/__tests__/TerminalManager.agentLauncher.test.jsx` | 8 | @vitest-environment jsdom */ |
| `synthi/src/app/workspace/__tests__/TerminalPane.agentBinding.test.jsx` | 8 | @vitest-environment jsdom */ |
| `synthi/src/app/workspace/__tests__/terminalAgentBinding.test.js` | 7 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/app/workspace/docking-demo/page.jsx` | 3 | @fileoverview Docking system component showcase / playground. |
| `synthi/src/app/workspace/page.js` | 8 | import Image from "next/image"; |
| `synthi/src/app/workspace/popout/page.jsx` | 3 | @fileoverview Next.js route for pop-out windows. |
| `synthi/src/app/workspace/responsive.css` | 12 | Workspace responsive overrides. |
| `synthi/src/app/workspace/terminalAgentBinding.js` | 5 | defines `normalizeTerminalAgentBinding` |
| `synthi/src/components/DraggableVideoWidget.jsx` | 13 | import React, { useState, useRef, useEffect } from 'react'; |
| `synthi/src/components/EditorPaneHeader.jsx` | 2 | EditorPaneHeader |
| `synthi/src/components/EditorTabStrip.jsx` | 18 | EditorTabStrip |
| `synthi/src/components/ErrorOverlay.jsx` | 40 | Error Overlay Component |
| `synthi/src/components/ExtensionDebugPanel.jsx` | 9 | Extension System Debug Panel |
| `synthi/src/components/ExtensionPanel.jsx` | 13 | Synthi Extension System - Extension Panel Component |
| `synthi/src/components/GlobalErrorHandler.jsx` | 1 | Ignore Canceled errors from Monaco or other promises |
| `synthi/src/components/HMRStatusIndicator.jsx` | 18 | HMR Status Indicator |
| `synthi/src/components/NativeContextMenuGuard.jsx` | 1 | Suppresses the browser's native right-click menu everywhere inside the |
| `synthi/src/components/NewProjectPicker.jsx` | 21 | NewProjectPicker - modal shown in two contexts: |
| `synthi/src/components/RenderBoundary.jsx` | 1 | RenderBoundary.jsx — React render isolation boundary |
| `synthi/src/components/SessionTokenHydrator.jsx` | 3 | renders `SessionTokenHydrator` |
| `synthi/src/components/SettingsPanelContent.jsx` | 37 | @fileoverview SettingsPanelContent — shared settings panel used in both |
| `synthi/src/components/StatusIslandPresetDialog.jsx` | 3 | renders `StatusIslandPresetDialog` |
| `synthi/src/components/StoreHydrator.jsx` | 1 | StoreHydrator - Hydrates global UI preferences from localStorage. |
| `synthi/src/components/SynthiException.js` | 568 | Pass a combined message to the parent Error class |
| `synthi/src/components/ThemeCreator.jsx` | 43 | @fileoverview ThemeCreator |
| `synthi/src/components/ThemeEditorPanel.jsx` | 10 | @fileoverview ThemeEditorPanel |
| `synthi/src/components/ThemePicker.jsx` | 19 | @fileoverview ThemePicker |
| `synthi/src/components/ThemeProvider.jsx` | 4 | @fileoverview ThemeProvider |
| `synthi/src/components/WorkspaceHydrator.jsx` | 1 | WorkspaceHydrator - Hydrates workspace-specific state (open tabs and active tab) |
| `synthi/src/components/WorkspaceNotFoundModal.jsx` | 1 | Redirect to root route |
| `synthi/src/components/agent-workflows/AgentWorkflowPanel.jsx` | 80 | import { memo, useCallback, useEffect, useMemo, useState } from 'react'; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/agent-workflows/__tests__/AgentWorkflowPanel.test.jsx` | 21 | import React, { act } from 'react'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/analysis/AnalysisPanel.jsx` | 6 | import { GatewayStatus } from '@/services/analyzerGatewayClient'; |
| `synthi/src/components/analysis/ProactiveAnalysisProvider.jsx` | 10 | ProactiveAnalysisProvider |
| `synthi/src/components/analysis/ProactiveAnalysisStatus.jsx` | 11 | ProactiveAnalysisStatus |
| `synthi/src/components/analysis/ProblemsPanel.jsx` | 34 | ProblemsPanel Component |
| `synthi/src/components/analysis/ProvenanceOverlay.jsx` | 19 | import React, { useState, useEffect, useCallback } from 'react'; |
| `synthi/src/components/analysis/index.js` | 547 | Proactive Analysis Components |
| `synthi/src/components/chat/AIChatWindow.jsx` | 111 | import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'; |
| `synthi/src/components/chat/ArbiterCard.jsx` | 6 | Synthi Genome — ArbiterCard |
| `synthi/src/components/chat/ChatEmptyState.jsx` | 1 | ChatEmptyState — the first-run / empty-conversation surface. |
| `synthi/src/components/chat/ChatRail.jsx` | 2 | ChatRail — the "Rail + Stream" rail (wide surfaces only). Slide-in overlay |
| `synthi/src/components/chat/ChatSessionDropdown.jsx` | 2 | ChatSessionDropdown — the narrow-surface session switcher that replaces the |
| `synthi/src/components/chat/CommandApprovalCard.jsx` | 5 | CommandApprovalCard – renders inline in the chat timeline when the AI |
| `synthi/src/components/chat/CounterfactualControls.jsx` | 7 | Workspace-scoped retention and policy controls for counterfactual telemetry. */ |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/chat/CounterfactualControls.test.jsx` | 4 | import React, { act } from 'react'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/chat/CounterfactualInspection.jsx` | 3 | Read-only, workspace-scoped inspection of durable counterfactual telemetry. |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/chat/CounterfactualInspection.test.jsx` | 1 | import React, { act } from 'react'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/chat/DiagnosticsDrawer.jsx` | 5 | DiagnosticsDrawer — consolidates the power-user panels that used to crowd |
| `synthi/src/components/chat/MultiverseCard.jsx` | 9 | Synthi Genome - MultiverseCard |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/chat/MultiverseCard.test.jsx` | 4 | import React, { act } from 'react'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/chat/ProviderLogos.jsx` | 4 | Provider logos for the chat model picker. |
| `synthi/src/components/chat/ReasoningCard.jsx` | 5 | ReasoningCard — the agent's live thinking + context surface (the old raw |
| `synthi/src/components/chat/RegressionFindingsCard.jsx` | 3 | Synthi Genome — regression findings card (Wave 4, master plan §14). |
| `synthi/src/components/chat/ShadowCostPanel.jsx` | 7 | Synthi Genome — Cost dashboard for shadow verify (Wave 4). |
| `synthi/src/components/chat/StalenessBadge.jsx` | 1 | Synthi Genome — StalenessBadge |
| `synthi/src/components/chat/ThinkingDots.jsx` | 614 | export function ThinkingDots() { |
| `synthi/src/components/chat/VectantOrb.jsx` | 8 | VectantOrb - Vectant console identity: a fluid, morphing gradient orb rendered |
| `synthi/src/components/chat/chat.css` | 33 | ── The orb (WebGL canvas wrapper) ────────────────────────────────── |
| `synthi/src/components/chat/hooks/useAISuggestions.js` | 136 | import { useCallback, useEffect, useMemo, useRef, useState } from 'react'; |
| `synthi/src/components/chat/hooks/useAgentPipeline.js` | 34 | useAgentPipeline — Multi-agent orchestration for AI chat. |
| `synthi/src/components/chat/hooks/useChatAttachments.js` | 8 | defines `useChatAttachments` |
| `synthi/src/components/chat/hooks/useChatInput.js` | 658 | defines `useChatInput` |
| `synthi/src/components/chat/hooks/useChatSessions.js` | 2 | Context window metadata |
| `synthi/src/components/chat/hooks/useContextWindow.js` | 19 | useContextWindow — Manages a sliding context window for AI chat sessions. |
| `synthi/src/components/chat/hooks/useContinuousFindings.js` | 2 | Subscribes to /api/shadow_continuous/state for a workspace and exposes |
| `synthi/src/components/chat/hooks/useShadowVerify.js` | 8 | Synthi Genome — `useShadowVerify(jobId)` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/chat/hooks/useShadowVerify.test.mjs` | 2 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/chat/utils/CodeBlock.jsx` | 4 | Map common language aliases to Shiki language IDs |
| `synthi/src/components/chat/utils/MessageContent.jsx` | 1 | MessageContent - Renders AI message content with syntax-highlighted code blocks. |
| `synthi/src/components/chat/utils/diffUtils.js` | 23 | defines `computeDiffChunks` |
| `synthi/src/components/chat/utils/fileSuggestionsUtils.js` | 1011 | Pending - stronger yellow/amber for visibility |
| `synthi/src/components/chat/utils/formatMessage.js` | 9 | Patterns to detect clickable code references in AI responses. |
| `synthi/src/components/codesite/CodeSitePanel.jsx` | 52 | import React, { useCallback, useEffect, useMemo, useState } from "react"; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/codesite/__tests__/CodeSitePanel.test.jsx` | 64 | @vitest-environment jsdom */ |
| `synthi/src/components/codesite/__tests__/codesiteClient.test.js` | 5 | defines `FakeEventSource` |
| `synthi/src/components/codesite/__tests__/testIdInvariant.test.js` | 2 | The CodeSite redesign splits a 9,000-line component into per-view files. The |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/codesite/codesiteClient.js` | 19 | defines `CODE_SITE_LIVE_EVENT_TYPES` |
| `synthi/src/components/codesite/icons.js` | 1 | defines `CodeSiteIcons` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/codesite/lib/__tests__/governanceActions.test.js` | 2 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/components/codesite/lib/__tests__/payloadIdentity.test.js` | 4 | The five queueGovernanceAction payloads used to be inline object literals in |
| `synthi/src/components/codesite/lib/__tests__/sectionGroups.test.js` | 1 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/codesite/lib/format.js` | 20 | defines `asArray` |
| `synthi/src/components/codesite/lib/governance.js` | 5 | defines `documentLabel` |
| `synthi/src/components/codesite/lib/governanceActions.js` | 5 | defines `documentReviewAction` |
| `synthi/src/components/codesite/lib/graph.js` | 5 | defines `zoneClass` |
| `synthi/src/components/codesite/lib/motion.js` | 249 | Shared easing curves. These live outside the panel so the components that |
| `synthi/src/components/codesite/lib/quarantine.js` | 13 | defines `hasEntries` |
| `synthi/src/components/codesite/lib/sectionGroups.js` | 2 | Ten sections is more than a panel this size can present flat, which is why the |
| `synthi/src/components/codesite/nav/CommandStrip.jsx` | 2 | The panel's first navigation level. Deliberately close to Workflows' |
| `synthi/src/components/codesite/nav/DesktopSectionRail.jsx` | 909 | The wide-dock first level. Keeps `codesite-desktop-section-rail`, which is in |
| `synthi/src/components/codesite/nav/MobileSectionTabs.jsx` | 4 | The narrow-dock first level. Shows the four groups rather than all ten |
| `synthi/src/components/codesite/nav/ViewStrip.jsx` | 2 | Second navigation level: the sections inside the active group. |
| `synthi/src/components/codesite/ui/EmptyLine.jsx` | 278 | renders `EmptyLine` |
| `synthi/src/components/codesite/ui/IconButton.jsx` | 1 | renders `IconButton` |
| `synthi/src/components/codesite/ui/JsonPreview.jsx` | 578 | renders `JsonPreview` |
| `synthi/src/components/codesite/ui/LoadingSkeleton.jsx` | 428 | renders `LoadingSkeleton` |
| `synthi/src/components/codesite/ui/Metric.jsx` | 1 | renders `Metric` |
| `synthi/src/components/codesite/ui/OperatorPane.jsx` | 1 | One surface, not three. This used to be a bordered card wrapping a bordered |
| `synthi/src/components/codesite/ui/PathList.jsx` | 1 | renders `PathList` |
| `synthi/src/components/codesite/ui/Pill.jsx` | 899 | renders `Pill` |
| `synthi/src/components/codesite/ui/Row.jsx` | 620 | Three columns only once the panel can hold them. This primitive backs most of |
| `synthi/src/components/codesite/ui/Section.jsx` | 940 | A section is a label over its content, not a framed box. The panel stacks up |
| `synthi/src/components/codesite/ui/SignalBar.jsx` | 675 | renders `SignalBar` |
| `synthi/src/components/codesite/ui/StatusRailItem.jsx` | 1 | renders `StatusRailItem` |
| `synthi/src/components/codesite/ui/TagList.jsx` | 1 | renders `TagList` |
| `synthi/src/components/codesite/ui/index.js` | 672 | export { default as EmptyLine } from "./EmptyLine"; |
| `synthi/src/components/codesite/views/ActivityView.jsx` | 3 | renders `ActivityView` |
| `synthi/src/components/codesite/views/EvidenceView.jsx` | 3 | renders `EvidenceView` |
| `synthi/src/components/codesite/views/GovernanceView.jsx` | 6 | renders `GovernanceView` |
| `synthi/src/components/codesite/views/GraphView.jsx` | 7 | renders `GraphView` |
| `synthi/src/components/codesite/views/InspectionsView.jsx` | 5 | renders `InspectionsView` |
| `synthi/src/components/codesite/views/LocksView.jsx` | 4 | renders `LocksView` |
| `synthi/src/components/codesite/views/OverviewView.jsx` | 8 | renders `OverviewView` |
| `synthi/src/components/codesite/views/QuarantineView.jsx` | 2 | renders `QuarantineView` |
| `synthi/src/components/codesite/views/ReplayView.jsx` | 1 | renders `ReplayView` |
| `synthi/src/components/codesite/views/SimulatorView.jsx` | 1 | renders `SimulatorView` |
| `synthi/src/components/codesite/views/activity/BlackBoxFlightRecorder.jsx` | 4 | renders `BlackBoxFlightRecorder` |
| `synthi/src/components/codesite/views/activity/TowerStreamPanel.jsx` | 6 | renders `TowerStreamPanel` |
| `synthi/src/components/codesite/views/channels/ChannelsView.jsx` | 12 | Channels view — registered direct channels with one-click actions. |
| `synthi/src/components/codesite/views/evidence/MetricScorecard.jsx` | 2 | renders `MetricScorecard` |
| `synthi/src/components/codesite/views/evidence/SerializableIsolationDeck.jsx` | 12 | renders `SerializableIsolationDeck` |
| `synthi/src/components/codesite/views/evidence/SuccessMetricsDeck.jsx` | 4 | renders `SuccessMetricsDeck` |
| `synthi/src/components/codesite/views/governance/GovernanceConsole.jsx` | 27 | renders `GovernanceConsole` |
| `synthi/src/components/codesite/views/governance/GovernanceReviewGate.jsx` | 4 | renders `GovernanceReviewGate` |
| `synthi/src/components/codesite/views/graph/ScopeTopology.jsx` | 22 | renders `ScopeTopology` |
| `synthi/src/components/codesite/views/graph/WorkGraphConnector.jsx` | 1 | renders `WorkGraphConnector` |
| `synthi/src/components/codesite/views/graph/WorkGraphNode.jsx` | 1 | renders `WorkGraphNode` |
| `synthi/src/components/codesite/views/index.js` | 647 | export { default as OverviewView } from "./OverviewView"; |
| `synthi/src/components/codesite/views/knowledge/SharedKnowledgePanel.jsx` | 18 | import { useId, useMemo, useRef, useState } from "react"; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/codesite/views/knowledge/__tests__/SharedKnowledgePanel.test.jsx` | 12 | @vitest-environment jsdom */ |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/codesite/views/locks/PilotLicenseHealthPanel.jsx` | 5 | renders `PilotLicenseHealthPanel` |
| `synthi/src/components/codesite/views/locks/RunwayOccupancyBoard.jsx` | 3 | renders `RunwayOccupancyBoard` |
| `synthi/src/components/codesite/views/overview/CodeSiteOperatingModel.jsx` | 7 | Which saved view each queue row belongs to. Membership is structural — what |
| `synthi/src/components/codesite/views/overview/DeploymentStatusCard.jsx` | 4 | import { CodeSiteIcons } from "../../icons"; |
| `synthi/src/components/codesite/views/overview/MetricRow.jsx` | 1 | renders `MetricRow` |
| `synthi/src/components/codesite/views/overview/MetricsGroup.jsx` | 595 | renders `MetricsGroup` |
| `synthi/src/components/codesite/views/overview/TowerNowStrip.jsx` | 7 | renders `TowerNowStrip` |
| `synthi/src/components/codesite/views/quarantine/FilesystemBoundaryProofPanel.jsx` | 5 | renders `FilesystemBoundaryProofPanel` |
| `synthi/src/components/codesite/views/quarantine/ProofValueList.jsx` | 1 | renders `ProofValueList` |
| `synthi/src/components/codesite/views/quarantine/QuarantineReviewPanel.jsx` | 24 | renders `QuarantineReviewPanel` |
| `synthi/src/components/codesite/views/replay/CausalReplayDeck.jsx` | 8 | renders `CausalReplayDeck` |
| `synthi/src/components/codesite/views/replay/LineProvenanceDeck.jsx` | 11 | renders `LineProvenanceDeck` |
| `synthi/src/components/codesite/views/replay/handovers.js` | 2 | defines `causalReplayHandovers` |
| `synthi/src/components/codesite/views/simulator/AssumptionInvalidatorPanel.jsx` | 4 | renders `AssumptionInvalidatorPanel` |
| `synthi/src/components/codesite/views/simulator/TowerSimulatorDeck.jsx` | 11 | renders `TowerSimulatorDeck` |
| `synthi/src/components/collaboration/CollabToolbar.jsx` | 13 | import React, { useState, useCallback, useEffect, useMemo } from 'react'; |
| `synthi/src/components/collaboration/FileVersionsPanel.jsx` | 31 | import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'; |
| `synthi/src/components/collaboration/GuestBanner.jsx` | 6 | GuestBanner — Thin persistent top bar shown for guests / knocking users. |
| `synthi/src/components/collaboration/MissedEventsTray.jsx` | 10 | import React, { useCallback, useEffect, useMemo, useState } from 'react'; |
| `synthi/src/components/collaboration/PresenceList.jsx` | 4 | renders `PresenceList` |
| `synthi/src/components/collaboration/SessionControlPanel.jsx` | 17 | import React, { useState, useCallback } from 'react'; |
| `synthi/src/components/collaboration/ShareModal.jsx` | 26 | import React, { useState, useCallback, useEffect, useRef } from 'react'; |
| `synthi/src/components/collaboration/WorkspaceUsersPanel.jsx` | 28 | renders `WorkspaceUsersPanel` |
| `synthi/src/components/collaboration/collabTheme.js` | 775 | Shared collaboration theme constants. |
| `synthi/src/components/collaboration/index.js` | 450 | Collaboration Components — barrel export |
| `synthi/src/components/compile/CompileErrorCard.jsx` | 9 | @fileoverview CompileErrorCard — ULTRAPLAN Phase 8. |
| `synthi/src/components/compile/ConfidenceWarning.jsx` | 5 | @fileoverview ConfidenceWarning — ULTRAPLAN Phase 8. |
| `synthi/src/components/dashboard/AIJumpstartSection.jsx` | 17 | import { useState, useCallback, useRef, useMemo } from "react"; |
| `synthi/src/components/dock/DockLayoutManager.jsx` | 23 | DockLayoutManager |
| `synthi/src/components/docking-wm/DockableWorkspace.jsx` | 8 | @fileoverview DockableWorkspace — drop-in replacement for the rigid |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/docking-wm/__tests__/layout-ops.test.js` | 11 | @fileoverview Test suite for docking layout operations. |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/docking-wm/components/ContextMenu.jsx` | 8 | @fileoverview Context menu for docking tab groups and tabs. |
| `synthi/src/components/docking-wm/components/DockingActivityBar.jsx` | 19 | @fileoverview DockingActivityBar — activity bar wired to the docking system. |
| `synthi/src/components/docking-wm/components/DockingContainer.jsx` | 2 | @fileoverview DockingContainer — the root visual component of the docking system. |
| `synthi/src/components/docking-wm/components/DockingProvider.jsx` | 4 | @fileoverview DockingProvider — root context provider for the docking system. |
| `synthi/src/components/docking-wm/components/DropOverlay.jsx` | 4 | @fileoverview DropOverlay — translucent overlay showing where a panel will land. |
| `synthi/src/components/docking-wm/components/FloatingWindow.jsx` | 8 | @fileoverview FloatingWindow — a draggable/resizable window overlay. |
| `synthi/src/components/docking-wm/components/LayoutDebugOverlay.jsx` | 6 | @fileoverview Development-only layout debug overlay. |
| `synthi/src/components/docking-wm/components/LayoutPresetPicker.jsx` | 8 | @fileoverview Layout preset picker component. |
| `synthi/src/components/docking-wm/components/LayoutRenderer.jsx` | 2 | @fileoverview LayoutRenderer — recursive renderer for the layout tree. |
| `synthi/src/components/docking-wm/components/PanelContainer.jsx` | 3 | @fileoverview PanelContainer — wrapper around the actual panel content. |
| `synthi/src/components/docking-wm/components/PanelGrip.jsx` | 1 | @fileoverview PanelGrip — drag affordance for panel headers and title bars. |
| `synthi/src/components/docking-wm/components/PopoutWindow.jsx` | 4 | @fileoverview PopoutWindow — content for a detached browser window. |
| `synthi/src/components/docking-wm/components/SplitContainer.jsx` | 2 | @fileoverview SplitContainer — renders a row or column of children with splitters. |
| `synthi/src/components/docking-wm/components/SplitterHandle.jsx` | 2 | @fileoverview SplitterHandle — the invisible 4px draggable border between panels. |
| `synthi/src/components/docking-wm/components/Tab.jsx` | 7 | @fileoverview Tab — individual tab in a tab bar. |
| `synthi/src/components/docking-wm/components/TabBar.jsx` | 3 | @fileoverview TabBar — horizontal row of draggable tabs. |
| `synthi/src/components/docking-wm/components/TabGroup.jsx` | 9 | @fileoverview TabGroup — leaf node in the layout tree. |
| `synthi/src/components/docking-wm/components/WorkspaceProfileManager.jsx` | 9 | @fileoverview WorkspaceProfileManager — UI for saving, loading, and managing workspace profiles. |
| `synthi/src/components/docking-wm/components/index.js` | 905 | @fileoverview Components barrel export. |
| `synthi/src/components/docking-wm/context/workspace-panel-context.js` | 694 | @fileoverview Shared context for passing workspace-level props to |
| `synthi/src/components/docking-wm/hooks/index.js` | 743 | @fileoverview Hooks barrel export. |
| `synthi/src/components/docking-wm/hooks/use-activity-bar-docking.js` | 8 | @fileoverview Hook to bridge the ActivityBar with the docking system. |
| `synthi/src/components/docking-wm/hooks/use-docking.js` | 6 | @fileoverview Core docking context hook. |
| `synthi/src/components/docking-wm/hooks/use-drag-panel.js` | 3 | @fileoverview Hook for making elements draggable as panel tabs. |
| `synthi/src/components/docking-wm/hooks/use-drop-zone.js` | 3 | @fileoverview Hook for making elements drop targets for docking. |
| `synthi/src/components/docking-wm/hooks/use-floating-window.js` | 5 | @fileoverview Hook for floating window interactions. |
| `synthi/src/components/docking-wm/hooks/use-keyboard-navigation.js` | 11 | @fileoverview Keyboard navigation for the docking window manager. |
| `synthi/src/components/docking-wm/hooks/use-layout-history.js` | 6 | @fileoverview Layout undo/redo system. |
| `synthi/src/components/docking-wm/hooks/use-layout-persistence.js` | 3 | @fileoverview Hook for auto-persisting layout state to localStorage. |
| `synthi/src/components/docking-wm/hooks/use-popout.js` | 5 | @fileoverview Hook for pop-out window (detached browser window) management. |
| `synthi/src/components/docking-wm/hooks/use-responsive-layout.js` | 4 | @fileoverview Responsive layout adaptation hook. |
| `synthi/src/components/docking-wm/hooks/use-sidebar-auto-collapse.js` | 8 | useSidebarAutoCollapse |
| `synthi/src/components/docking-wm/hooks/use-splitter.js` | 5 | @fileoverview Hook for splitter resize handles. |
| `synthi/src/components/docking-wm/index.js` | 6 | @fileoverview Synthi Docking Window Manager — Public API |
| `synthi/src/components/docking-wm/panels/OutputPanel.jsx` | 11 | @fileoverview Output Panel — displays program stdout/stderr in a terminal-like view. |
| `synthi/src/components/docking-wm/panels/ide-panels.js` | 7 | @fileoverview IDE panel definitions for the docking window manager. |
| `synthi/src/components/docking-wm/panels/index.js` | 657 | @fileoverview Panels barrel export. |
| `synthi/src/components/docking-wm/panels/layout-presets.js` | 15 | @fileoverview Pre-built workspace layout presets. |
| `synthi/src/components/docking-wm/panels/panel-types.js` | 889 | @fileoverview IDE panel type constants. |
| `synthi/src/components/docking-wm/panels/panel-wrappers.jsx` | 48 | @fileoverview Docking-aware wrappers for IDE panels. |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/docking-wm/state/__tests__/layout-slice.editor-split.test.js` | 2 | One editor pane showing a.java, focused. |
| `synthi/src/components/docking-wm/state/__tests__/layout-slice.floating-panel.test.js` | 1 | A minimal layout with one non-empty editor group (so cleanup never prunes the root). |
| `synthi/src/components/docking-wm/state/__tests__/layout-slice.panel-multiplicity.test.js` | 5 | defines `registerTestPanel` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/docking-wm/state/index.js` | 113 | @fileoverview State barrel export. |
| `synthi/src/components/docking-wm/state/layout-slice.js` | 19 | @fileoverview Redux slice for layout state management. |
| `synthi/src/components/docking-wm/state/panel-registry-core.js` | 1 | @fileoverview JSX-free panel registry primitives. |
| `synthi/src/components/docking-wm/state/panel-registry.js` | 2 | @fileoverview Panel Registry — manages panel type registrations. |
| `synthi/src/components/docking-wm/styles/docking.css` | 22 | Synthi Docking Window Manager — Styles |
| `synthi/src/components/docking-wm/types.js` | 7 | @fileoverview Type definitions for the Synthi Docking Window Manager. |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/docking-wm/utils/__tests__/editor-panes.test.js` | 1 | Minimal layout: a row split with two editor tabgroups. |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/docking-wm/utils/aria.js` | 4 | @fileoverview ARIA attribute helpers for the docking system. |
| `synthi/src/components/docking-wm/utils/editor-panes.js` | 2 | @fileoverview Pure helpers for projecting the layout's editor tabgroups |
| `synthi/src/components/docking-wm/utils/geometry.js` | 5 | @fileoverview Drop zone geometry hit-testing. |
| `synthi/src/components/docking-wm/utils/id-generator.js` | 1 | @fileoverview Unique ID generation for layout nodes, tabs, and windows. |
| `synthi/src/components/docking-wm/utils/index.js` | 298 | @fileoverview Utilities barrel export. |
| `synthi/src/components/docking-wm/utils/layout-node.js` | 5 | @fileoverview Layout tree node creation factories. |
| `synthi/src/components/docking-wm/utils/layout-ops.js` | 20 | @fileoverview Layout tree mutation operations. |
| `synthi/src/components/docking-wm/utils/layout-query.js` | 7 | @fileoverview Layout tree traversal, query, and validation utilities. |
| `synthi/src/components/docking-wm/utils/layout-validation.js` | 10 | @fileoverview Layout validation and error recovery utilities. |
| `synthi/src/components/docking-wm/utils/panel-dedupe.js` | 658 | defines `shouldDeduplicatePanel` |
| `synthi/src/components/docking-wm/utils/serialization.js` | 6 | @fileoverview Layout serialization, deserialization, and migration. |
| `synthi/src/components/docking/DockablePanel.jsx` | 21 | DockablePanel - Visual Studio-style dockable panel system |
| `synthi/src/components/docking/index.js` | 207 | Docking system components |
| `synthi/src/components/dojo/AntibodyRegistry.jsx` | 2 | renders `AntibodyRegistry` |
| `synthi/src/components/dojo/ApiCandidateReview.jsx` | 3 | renders `ApiCandidateReview` |
| `synthi/src/components/dojo/ApprovalQueue.jsx` | 4 | renders `ApprovalQueue` |
| `synthi/src/components/dojo/AuditExportPanel.jsx` | 2 | renders `AuditExportPanel` |
| `synthi/src/components/dojo/CaseLawDashboard.jsx` | 5 | renders `CaseLawDashboard` |
| `synthi/src/components/dojo/CaseLawRegistry.jsx` | 3 | renders `CaseLawRegistry` |
| `synthi/src/components/dojo/CheckrideReportView.jsx` | 3 | renders `CheckrideReportView` |
| `synthi/src/components/dojo/ComplianceEvidencePack.jsx` | 3 | renders `ComplianceEvidencePack` |
| `synthi/src/components/dojo/ConsumerSkillCard.jsx` | 6 | renders `ConsumerSkillCard` |
| `synthi/src/components/dojo/CortexNodeInspector.jsx` | 13 | renders `CortexNodeInspector` |
| `synthi/src/components/dojo/DojoShell.jsx` | 19 | renders `DojoShell` |
| `synthi/src/components/dojo/EvidenceDashboard.jsx` | 9 | import { useEffect, useState } from 'react'; |
| `synthi/src/components/dojo/EvidenceLedgerChain.jsx` | 4 | import { Link2 } from 'lucide-react'; |
| `synthi/src/components/dojo/GeneratedToolReview.jsx` | 2 | renders `GeneratedToolReview` |
| `synthi/src/components/dojo/GhostModePanel.jsx` | 4 | renders `GhostModePanel` |
| `synthi/src/components/dojo/GovernanceDashboard.jsx` | 16 | renders `GovernanceDashboard` |
| `synthi/src/components/dojo/GovernanceOverview.jsx` | 1 | renders `GovernanceOverview` |
| `synthi/src/components/dojo/GuardrailProvenance.jsx` | 2 | renders `GuardrailProvenance` |
| `synthi/src/components/dojo/HumanVsAgentActionDiff.jsx` | 2 | renders `HumanVsAgentActionDiff` |
| `synthi/src/components/dojo/LicenseHealthBoard.jsx` | 5 | renders `LicenseHealthBoard` |
| `synthi/src/components/dojo/PolicyGateTable.jsx` | 2 | renders `PolicyGateTable` |
| `synthi/src/components/dojo/PracticeWorldDashboard.jsx` | 15 | renders `PracticeWorldDashboard` |
| `synthi/src/components/dojo/ProofCapsuleDrawer.jsx` | 7 | renders `ProofCapsuleDrawer` |
| `synthi/src/components/dojo/RecertificationQueue.jsx` | 3 | renders `RecertificationQueue` |
| `synthi/src/components/dojo/RedactedEvidenceExportPanel.jsx` | 4 | import { FileArchive } from 'lucide-react'; |
| `synthi/src/components/dojo/RefusalExplainerDrawer.jsx` | 5 | renders `RefusalExplainerDrawer` |
| `synthi/src/components/dojo/SkillCardGrid.jsx` | 6 | renders `SkillCardGrid` |
| `synthi/src/components/dojo/SkillCortexGraph.jsx` | 56 | import { useEffect, useMemo, useRef, useState } from 'react'; |
| `synthi/src/components/dojo/SkillPassport.jsx` | 15 | renders `SkillPassport` |
| `synthi/src/components/dojo/SkillRegistryTable.jsx` | 2 | renders `SkillRegistryTable` |
| `synthi/src/components/dojo/SourceAffordancePrPlan.jsx` | 5 | renders `SourceAffordancePrPlan` |
| `synthi/src/components/dojo/SourceApiDashboard.jsx` | 8 | renders `SourceApiDashboard` |
| `synthi/src/components/dojo/SubstrateLadderView.jsx` | 4 | renders `SubstrateLadderView` |
| `synthi/src/components/dojo/TherapeuticTomographyTrace.jsx` | 32 | import { useEffect, useMemo, useState } from 'react'; |
| `synthi/src/components/dojo/TimeMachineDebugger.jsx` | 9 | renders `TimeMachineDebugger` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/dojo/__tests__/CaseLawDashboard.test.jsx` | 4 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/DojoShell.test.jsx` | 3 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/EvidenceDashboard.test.jsx` | 5 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/GovernanceDashboard.test.jsx` | 24 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/PracticeWorldDashboard.test.jsx` | 5 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/ProofRefusalDrawer.test.jsx` | 11 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/RegretSignals.test.jsx` | 6 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/SkillCardGrid.test.jsx` | 4 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/SkillCortexGraph.test.jsx` | 10 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/SkillPassport.test.jsx` | 4 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/SourceApiDashboard.test.jsx` | 6 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/TherapeuticTomographyTrace.test.jsx` | 18 | import React, { act } from 'react'; |
| `synthi/src/components/dojo/__tests__/TimeMachineDebugger.test.jsx` | 5 | import React, { act } from 'react'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/emulator/EmulatorControls.jsx` | 1 | renders `EmulatorControls` |
| `synthi/src/components/emulator/EmulatorFrame.jsx` | 2 | renders `EmulatorFrame` |
| `synthi/src/components/emulator/EmulatorPanel.jsx` | 15 | renders `EmulatorPanel` |
| `synthi/src/components/emulator/EmulatorScreen.jsx` | 19 | import React from 'react'; |
| `synthi/src/components/emulator/FloatingEmulatorWindow.jsx` | 19 | renders `FloatingEmulatorWindow` |
| `synthi/src/components/emulator/emulatorStates.js` | 977 | Mobile runtime state primitives. Local standby mode uses these until a |
| `synthi/src/components/extensions/ExtensionSidebar.jsx` | 54 | Extension Sidebar View |
| `synthi/src/components/extensions/ExtensionViewContainer.jsx` | 22 | ExtensionViewContainer |
| `synthi/src/components/git/BranchSelector.jsx` | 15 | import React, { useEffect, useState, useCallback, useMemo } from 'react'; |
| `synthi/src/components/git/CommitGraphColumn.jsx` | 10 | Shared SourceTree-style commit graph column that renders: |
| `synthi/src/components/git/CommitHistoryPanel.jsx` | 35 | import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'; |
| `synthi/src/components/git/CreatePRForm.jsx` | 10 | import React, { useState, useEffect } from 'react'; |
| `synthi/src/components/git/GitHubTokenModal.jsx` | 2 | Stub modal that points the user at Settings, where the per-user GitHub PAT |
| `synthi/src/components/git/GitStatus.jsx` | 801 | GitStatus — preserved import surface. |
| `synthi/src/components/git/GitSummaryPanel.jsx` | 14 | GitSummaryPanel — compact source-control summary docked at the |
| `synthi/src/components/git/HunkStagingView.jsx` | 26 | import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'; |
| `synthi/src/components/git/InteractiveRebasePanel.jsx` | 13 | import React, { useState, useCallback, useRef, useEffect } from 'react'; |
| `synthi/src/components/git/MarkdownRenderer.jsx` | 25 | GitHub-parity Markdown renderer — zero external dependencies. |
| `synthi/src/components/git/MergeConflictEditor.jsx` | 22 | ── Vectant brand-aligned conflict palette ───────────────────────────────── |
| `synthi/src/components/git/PRDetail.jsx` | 55 | import React, { useState, useEffect, useRef, useCallback } from 'react'; |
| `synthi/src/components/git/PullRequestsPanel.jsx` | 22 | import React, { useEffect, useState, useCallback, useRef } from 'react'; |
| `synthi/src/components/git/gitUtils.js` | 14 | Git UI utility functions. |
| `synthi/src/components/git/scm/BranchBridge.jsx` | 4 | BranchBridge — the top header of the SCM column. |
| `synthi/src/components/git/scm/CommitComposer.jsx` | 13 | CommitComposer — the sticky-bottom chat-style composer. |
| `synthi/src/components/git/scm/CommitTypeChips.jsx` | 2 | CommitTypeChips — a controlled row of conventional-commit type |
| `synthi/src/components/git/scm/FileRow.jsx` | 7 | FileRow — a single file in the Source Control panel. |
| `synthi/src/components/git/scm/FileSections.jsx` | 7 | FileSections — the middle, scrollable region of the SCM column. |
| `synthi/src/components/git/scm/FocalCard.jsx` | 5 | FocalCard — the morphing "what matters now" card just under the |
| `synthi/src/components/git/scm/OverflowMenu.jsx` | 5 | OverflowMenu — the dropdown opened by the Branch Bridge's |
| `synthi/src/components/git/scm/SourceControlPanel.jsx` | 29 | SourceControlPanel — the top-level container that replaces the |
| `synthi/src/components/git/scm/StashList.jsx` | 4 | StashList — sub-view content for the "Stashes" pill in the SCM |
| `synthi/src/components/git/scm/SubViewPills.jsx` | 2 | SubViewPills — 3-tab pill switcher that selects which secondary |
| `synthi/src/components/git/scm/scm-tokens.css` | 22 | ═══════════════════════════════════════════════════════════════════ |
| `synthi/src/components/git/scm/useFocalCardState.js` | 3 | useFocalCardState — derive the one focal state for the SCM panel |
| `synthi/src/components/healing/AIActivityTimeline.jsx` | 3 | src/components/healing/AIActivityTimeline.jsx |
| `synthi/src/components/healing/AIConfidenceGate.jsx` | 2 | src/components/healing/AIConfidenceGate.jsx |
| `synthi/src/components/healing/AIDiffPreview.jsx` | 3 | src/components/healing/AIDiffPreview.jsx |
| `synthi/src/components/healing/AIErrorBoundary.jsx` | 2 | src/components/healing/AIErrorBoundary.jsx |
| `synthi/src/components/healing/AIFixCard.jsx` | 11 | src/components/healing/AIFixCard.jsx |
| `synthi/src/components/healing/AIInlineWidget.js` | 13 | src/components/healing/AIInlineWidget.js |
| `synthi/src/components/healing/AIStatsPanel.jsx` | 9 | src/components/healing/AIStatsPanel.jsx |
| `synthi/src/components/healing/AISuppressedRulesPanel.jsx` | 6 | src/components/healing/AISuppressedRulesPanel.jsx |
| `synthi/src/components/healing/FailureDistillerPanel.jsx` | 18 | import { useCallback, useEffect, useMemo, useState } from 'react'; |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/healing/FailureDistillerPanel.test.jsx` | 6 | @vitest-environment jsdom */ |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/healing/HealingHistoryPanel.jsx` | 11 | src/components/healing/HealingHistoryPanel.jsx |
| `synthi/src/components/healing/HealingIndicator.jsx` | 6 | src/components/healing/HealingIndicator.jsx |
| `synthi/src/components/healing/HealingPendingPanel.jsx` | 6 | src/components/healing/HealingPendingPanel.jsx |
| `synthi/src/components/healing/HealingPresetSelector.jsx` | 4 | src/components/healing/HealingPresetSelector.jsx |
| `synthi/src/components/healing/HealingRulesEditor.jsx` | 25 | src/components/healing/HealingRulesEditor.jsx |
| `synthi/src/components/healing/HealingSettingsPanel.jsx` | 24 | src/components/healing/HealingSettingsPanel.jsx |
| `synthi/src/components/healing/HealingStatsDashboard.jsx` | 3 | Healing Statistics Dashboard panel. |
| `synthi/src/components/healing/HealingToast.jsx` | 3 | src/components/healing/HealingToast.jsx |
| `synthi/src/components/healing/PreCompileHealToast.jsx` | 1 | src/components/healing/PreCompileHealToast.jsx |
| `synthi/src/components/healing/RuntimeHealingIndicator.jsx` | 5 | RuntimeHealingIndicator — visual feedback for HMR runtime healing. |
| `synthi/src/components/healing/aiCodeActions.js` | 3 | src/components/healing/aiCodeActions.js |
| `synthi/src/components/healing/aiDiagnostics.js` | 4 | src/components/healing/aiDiagnostics.js |
| `synthi/src/components/healing/aiHoverProvider.js` | 3 | src/components/healing/aiHoverProvider.js |
| `synthi/src/components/healing/aiNotifications.js` | 3 | src/components/healing/aiNotifications.js |
| `synthi/src/components/healing/healingDecorations.js` | 2 | src/components/healing/healingDecorations.js |
| `synthi/src/components/healing/index.js` | 1 | src/components/healing/index.js |
| `synthi/src/components/healing/pendingFixCodeActions.js` | 4 | src/components/healing/pendingFixCodeActions.js |
| `synthi/src/components/integrations/AddConnectionDialog.jsx` | 6 | renders `AddConnectionDialog` |
| `synthi/src/components/integrations/CliAccessSection.jsx` | 3 | renders `CliAccessSection` |
| `synthi/src/components/integrations/ConnectedToolsPanel.jsx` | 8 | import { useCallback, useEffect, useState } from 'react'; |
| `synthi/src/components/integrations/GitProvidersSection.jsx` | 4 | renders `GitProvidersSection` |
| `synthi/src/components/integrations/integrationsClient.js` | 3 | defines `fetchConnections` |
| `synthi/src/components/local-support/LocalSupportAdmin.jsx` | 10 | renders `LocalSupportAdmin` |
| `synthi/src/components/local-support/LocalSupportTransparency.jsx` | 72 | import { useEffect, useMemo, useRef, useState } from "react"; |
| `synthi/src/components/local-support/local-support.css` | 3 | css asset |
| `synthi/src/components/notebook/JupyterConnectionSettings.jsx` | 4 | renders `JupyterConnectionSettings` |
| `synthi/src/components/notebook/NotebookViewer.jsx` | 25 | import { useEffect, useMemo, useState } from 'react'; |
| `synthi/src/components/ports/PortsPanel.jsx` | 3 | renders `PortsPanel` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/ports/__tests__/PortsPanel.test.jsx` | 2 | @vitest-environment jsdom */ |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/programs/ConfirmDialog.jsx` | 3 | Generic Vectant confirm dialog. Used by workspace tools for destructive or |
| `synthi/src/components/programs/FirstPublishTutorial.jsx` | 2 | Per-user localStorage key for "has seen the first-publish tutorial". */ |
| `synthi/src/components/programs/GenerateManifestDialog.jsx` | 2 | Preview + edit dialog for an AI-generated vectant.programs.json. The user |
| `synthi/src/components/programs/ProgramIcon.jsx` | 1 | The lookup key is the slug after the publisher, e.g. "@vectant/dbeaver" → "dbeaver". |
| `synthi/src/components/programs/ProgramSessionPanel.jsx` | 17 | import { useCallback, useEffect, useMemo, useState } from 'react'; |
| `synthi/src/components/programs/ProgramsPanel.jsx` | 20 | import { useCallback, useEffect, useState } from 'react'; |
| `synthi/src/components/programs/ScaleToFitFrame.jsx` | 2 | Largest scale that fits a baseWidth×baseHeight box inside a |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/components/programs/__tests__/ConfirmDialog.test.jsx` | 1 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/ProgramIcon.test.jsx` | 1 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx` | 8 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/ScaleToFitFrame.test.jsx` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/components/programs/__tests__/filterStrip.test.jsx` | 1 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/firstPublishTutorial.test.jsx` | 1 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/generateManifestDialog.test.jsx` | 3 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/libraryView.test.jsx` | 5 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/myAppsView.test.jsx` | 2 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/programDetail.test.jsx` | 1 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/programSessionSections.test.js` | 3 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/components/programs/__tests__/programThumbnail.test.jsx` | 2 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/programTile.test.jsx` | 1 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/programTokens.test.js` | 794 | @vitest-environment node */ |
| `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx` | 13 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx` | 5 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/runningCard.test.jsx` | 1 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/storeTile.test.jsx` | 3 | @vitest-environment jsdom */ |
| `synthi/src/components/programs/__tests__/storeView.test.jsx` | 2 | @vitest-environment jsdom */ |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/components/programs/library/LibraryView.jsx` | 5 | renders `LibraryView` |
| `synthi/src/components/programs/library/ProgramThumbnail.jsx` | 2 | ONE snapshot of a webGui program, taken ~60-90s after it started, via KasmVNC's |
| `synthi/src/components/programs/library/ProgramTile.jsx` | 1 | renders `ProgramTile` |
| `synthi/src/components/programs/library/RunningCard.jsx` | 4 | Per-state tone: only a running session glows green; stopped is muted, crashed is red. |
| `synthi/src/components/programs/myapps/MyAppCard.jsx` | 2 | Human label + colour per review state (the autonomous pipeline's surface). */ |
| `synthi/src/components/programs/myapps/MyAppsView.jsx` | 1 | Publisher self-service board: every app this workspace has submitted, with its |
| `synthi/src/components/programs/programLogos.js` | 9 | Brand logos for the built-in programs — single-path SVGs from simple-icons |
| `synthi/src/components/programs/programSessionSections.js` | 2 | defines `isActiveProgramSession` |
| `synthi/src/components/programs/programTokens.js` | 2 | Single source of truth for the Programs panel's vectant styling. Values come |
| `synthi/src/components/programs/programsClient.js` | 6 | defines `parseJson` |
| `synthi/src/components/programs/store/FilterStrip.jsx` | 4 | Horizontal chip strip with the navbar tab-strip scrollbar: native bar hidden, |
| `synthi/src/components/programs/store/ProgramDetail.jsx` | 3 | renders `ProgramDetail` |
| `synthi/src/components/programs/store/StoreTile.jsx` | 3 | renders `StoreTile` |
| `synthi/src/components/programs/store/StoreView.jsx` | 4 | renders `StoreView` |
| `synthi/src/components/ui/PromptDialog.jsx` | 3 | renders `PromptDialog` |
| `synthi/src/components/ui/UnsavedChangesDialog.jsx` | 4 | UnsavedChangesDialog — Vectant "Save / Discard / Cancel" modal. |
| `synthi/src/components/ui/button.jsx` | 1 | import * as React from "react" |
| `synthi/src/components/ui/card.jsx` | 2 | import * as React from "react" |
| `synthi/src/components/ui/checkbox.jsx` | 920 | import * as React from "react" |
| `synthi/src/components/ui/context-menu.jsx` | 7 | import * as React from "react" |
| `synthi/src/components/ui/dialog.jsx` | 2 | import * as React from "react" |
| `synthi/src/components/ui/dropdown-menu.jsx` | 6 | import * as React from "react" |
| `synthi/src/components/ui/input.jsx` | 934 | import * as React from "react" |
| `synthi/src/components/ui/label.jsx` | 552 | import * as React from "react" |
| `synthi/src/components/ui/popover.jsx` | 717 | import * as React from 'react'; |
| `synthi/src/components/ui/resizable.jsx` | 1 | import * as React from "react" |
| `synthi/src/components/ui/scroll-area.jsx` | 1 | import * as React from "react" |
| `synthi/src/components/ui/select.jsx` | 5 | import * as React from "react" |
| `synthi/src/components/ui/separator.jsx` | 642 | import * as React from "react" |
| `synthi/src/components/ui/sonner.jsx` | 774 | import { useTheme } from "next-themes" |
| `synthi/src/components/ui/tabs.jsx` | 1 | import * as React from "react" |
| `synthi/src/components/ui/textarea.jsx` | 589 | import * as React from "react" |
| `synthi/src/components/ui/useConfirmDialog.js` | 824 | defines `useConfirmDialog` |
| `synthi/src/components/ui/usePromptDialog.js` | 799 | defines `usePromptDialog` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/context/notebook/__tests__/serializeNotebookContext.test.js` | 876 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/context/notebook/serializeNotebookContext.js` | 1 | defines `serializeNotebookContext` |
| `synthi/src/extensions/ARCHITECTURE.md` | 10 | Synthi VS Code Extension System Architecture |
| `synthi/src/extensions/api/authentication.js` | 2 | Synthi Extension System - Authentication API |
| `synthi/src/extensions/api/commands.js` | 2 | Synthi Extension System - Commands API |
| `synthi/src/extensions/api/debug.js` | 4 | Synthi Extension System - Debug API |
| `synthi/src/extensions/api/env.js` | 4 | Synthi Extension System - Env API |
| `synthi/src/extensions/api/extensions.js` | 2 | Synthi Extension System - Extensions API |
| `synthi/src/extensions/api/languages.js` | 10 | Synthi Extension System - Languages API |

## asset

| File | Bytes | Note |
|---|---|---|
| `synthi/src/extensions/api/languages.js.bak` | 14 | binary or generated artifact |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/extensions/api/scm.js` | 2 | Synthi Extension System - SCM API |
| `synthi/src/extensions/api/tasks.js` | 3 | Synthi Extension System - Tasks API |
| `synthi/src/extensions/api/terminal.js` | 3 | Synthi Extension System - Terminal API |
| `synthi/src/extensions/api/uri.js` | 3 | Synthi Extension System - URI Implementation |
| `synthi/src/extensions/api/vscode.js` | 31 | Synthi Extension System - VS Code API |
| `synthi/src/extensions/api/window.js` | 18 | Synthi Extension System - Window API |
| `synthi/src/extensions/api/workspace.js` | 14 | Synthi Extension System - Workspace API |
| `synthi/src/extensions/bridge/LanguageProviderBridge.js` | 34 | Synthi Extension System - Language Provider Bridge |
| `synthi/src/extensions/bridge/MainThreadBridge.js` | 58 | Synthi Extension System - Main Thread Bridge |
| `synthi/src/extensions/bridge/MessageProtocol.js` | 7 | Synthi Extension System - Message Protocol |
| `synthi/src/extensions/bridge/MonacoBridge.js` | 12 | Synthi Extension System - Monaco Bridge |
| `synthi/src/extensions/bridge/VSCodeServerProxy.js` | 28 | Synthi Extension System - VS Code Server Proxy |
| `synthi/src/extensions/bridge/WorkerProxy.js` | 13 | Synthi Extension System - Worker Proxy |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/extensions/bridge/__tests__/MainThreadBridge.vscode-server.test.js` | 2 | import { describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/extensions/core/CrossExtensionIsolation.js` | 15 | Synthi Extension System - Cross-Extension Isolation |
| `synthi/src/extensions/core/ErrorReporter.js` | 11 | Synthi Extension System - User-Facing Error Reporter |
| `synthi/src/extensions/core/ExtensionInspector.js` | 12 | Synthi Extension System - Extension Inspector |
| `synthi/src/extensions/core/ExtensionManager.js` | 23 | Synthi Extension System - Extension Manager |
| `synthi/src/extensions/core/ExtensionState.js` | 14 | Synthi Extension System - Extension State Machine (FIXED) |
| `synthi/src/extensions/core/ExtensionStateReducer.js` | 20 | Synthi Extension System - Extension State Reducer |
| `synthi/src/extensions/core/FrozenAPI.js` | 13 | Synthi Extension System - Frozen API Surface |
| `synthi/src/extensions/core/LivelockDetector.js` | 10 | Synthi Extension System - Livelock Detector |
| `synthi/src/extensions/core/ObservabilityStore.js` | 13 | Synthi Extension System - Async Observability Store |
| `synthi/src/extensions/core/RestartFence.js` | 9 | Synthi Extension System - Restart Fence |
| `synthi/src/extensions/core/RuntimeAPIEnforcer.js` | 14 | Synthi Extension System - Runtime API Enforcer |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/extensions/core/TestSuite.js` | 19 | Synthi Extension System - Comprehensive Test Suite |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/extensions/core/VSIXCompatibility.js` | 19 | Synthi Extension System - VSIX Compatibility Classifier |
| `synthi/src/extensions/core/index.js` | 2 | Synthi Extension System - Core Module |
| `synthi/src/extensions/host/ActivationManager.js` | 6 | Synthi Extension System - Activation Manager |
| `synthi/src/extensions/host/ExtensionContext.js` | 5 | Synthi Extension System - Extension Context |
| `synthi/src/extensions/host/ExtensionHostMain.js` | 34 | Synthi Extension System - Extension Host Main |
| `synthi/src/extensions/host/ExtensionHostWorker.js` | 614 | Synthi Extension System - Extension Host Worker |
| `synthi/src/extensions/host/ExtensionRegistry.js` | 7 | Synthi Extension System - Extension Registry |
| `synthi/src/extensions/index.js` | 15 | Synthi Extension System - Main Export |
| `synthi/src/extensions/loader/ExtensionImportParser.js` | 2 | defines `normalizeId` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/extensions/loader/ExtensionImportParser.test.js` | 2 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/extensions/loader/ExtensionInstaller.js` | 17 | Synthi Extension System - Extension Installer |
| `synthi/src/extensions/loader/GrammarRegistrar.js` | 8 | Synthi Extension System - Grammar Registrar |
| `synthi/src/extensions/loader/ManifestParser.js` | 6 | Synthi Extension System - Manifest Parser |
| `synthi/src/extensions/loader/ThemeRegistrar.js` | 4 | @fileoverview Synthi Extension System - Theme Registrar |
| `synthi/src/extensions/loader/index.js` | 536 | Synthi Extension System - Loader Index |
| `synthi/src/extensions/perf/ActivationBenchmark.js` | 6 | Synthi Extension System - Activation Benchmark |
| `synthi/src/extensions/perf/CPUProfiler.js` | 6 | Synthi Extension System - CPU Profiler |
| `synthi/src/extensions/perf/TypingLatencyMonitor.js` | 5 | Synthi Extension System - Typing Latency Monitor |
| `synthi/src/extensions/perf/index.js` | 351 | Synthi Extension System - Performance Index |
| `synthi/src/extensions/scheduler/ExtensionScheduler.js` | 7 | Synthi Extension System - Extension Scheduler |
| `synthi/src/extensions/scheduler/MemoryMonitor.js` | 6 | Synthi Extension System - Memory Monitor |
| `synthi/src/extensions/scheduler/TimerThrottler.js` | 7 | Synthi Extension System - Timer Throttler |
| `synthi/src/extensions/scheduler/VisibilityManager.js` | 5 | Synthi Extension System - Visibility Manager |
| `synthi/src/extensions/scheduler/index.js` | 403 | Synthi Extension System - Scheduler Index |
| `synthi/src/extensions/services/StorageService.js` | 7 | Synthi Extension System - Storage Service |
| `synthi/src/extensions/test/bad-extension-manifest.json` | 478 | Intentionally bad extension for testing kill functionality |
| `synthi/src/extensions/test/bad-extension.js` | 699 | Bad Extension: Infinite Loop |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/extensions/test/extension-test-runner.js` | 5 | Extension Test Runner |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/extensions/test/hello-world-extension.js` | 2 | Test Extension: Hello World |
| `synthi/src/extensions/test/hello-world-manifest.json` | 568 | A test extension for Synthi IDE extension system |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/extensions/test/test-node.mjs` | 6 | Node.js Test Runner for Extension System |
| `synthi/src/extensions/test/test.html` | 13 | html asset |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/extensions/webview/WebviewManager.js` | 12 | Synthi Extension System - Webview Manager |
| `synthi/src/hooks/useAIAutoAnalysis.js` | 2 | src/hooks/useAIAutoAnalysis.js |
| `synthi/src/hooks/useAIHealing.js` | 36 | src/hooks/useAIHealing.js |
| `synthi/src/hooks/useAIHealingKeyboard.js` | 3 | src/hooks/useAIHealingKeyboard.js |
| `synthi/src/hooks/useAISelectionAnalysis.js` | 2 | src/hooks/useAISelectionAnalysis.js |
| `synthi/src/hooks/useAnalyzerGateway.js` | 30 | defines `useAnalyzerGateway` |
| `synthi/src/hooks/useBatchHealing.js` | 1 | Hook for batch-healing multiple files at once. |
| `synthi/src/hooks/useBlockedUsers.js` | 1 | React hook for managing the current user's block list. |
| `synthi/src/hooks/useBoundaryTrigger.js` | 8 | src/hooks/useBoundaryTrigger.js |
| `synthi/src/hooks/useCodeIntelIndex.js` | 8 | Hook to manage code intelligence indexing for a workspace. |
| `synthi/src/hooks/useCodeIntelMetrics.js` | 2 | Hook for code-intel metrics. |
| `synthi/src/hooks/useCollabNotifications.js` | 9 | Helper — returns a toast action that opens the collab popup */ |
| `synthi/src/hooks/useCollabSession.js` | 9 | React hook for managing a collaboration session. |
| `synthi/src/hooks/useCollabStatus.js` | 595 | React hook that returns the aggregated collaboration WebSocket status. |
| `synthi/src/hooks/useCompileManifestListener.js` | 3 | @fileoverview useCompileManifestListener — ULTRAPLAN Phase 8. |
| `synthi/src/hooks/useCompiler.js` | 6 | Auto-reconnect timer ref — persists across status changes |
| `synthi/src/hooks/useDeferredValue.js` | 3 | src/hooks/useDeferredValue.js |
| `synthi/src/hooks/useDockKeyboardShortcuts.js` | 1 | useDockKeyboardShortcuts |
| `synthi/src/hooks/useExtensions.js` | 78 | Synthi Extension System - useExtensions Hook |
| `synthi/src/hooks/useFilePresence.js` | 3 | useFilePresence — tracks which users are editing each open file. |
| `synthi/src/hooks/useHMR.js` | 16 | import { useEffect, useRef, useState, useCallback } from 'react'; |
| `synthi/src/hooks/useHealingKeyboard.js` | 2 | Hook that registers keyboard shortcuts for the self-healing system. |
| `synthi/src/hooks/useHealingStats.js` | 2 | Hook to retrieve and display healing statistics and cache metrics. |
| `synthi/src/hooks/useHealingUndo.js` | 4 | src/hooks/useHealingUndo.js |
| `synthi/src/hooks/useHotSwap.js` | 1 | useHotSwap.js |
| `synthi/src/hooks/usePendingFixCodeActions.js` | 2 | src/hooks/usePendingFixCodeActions.js |
| `synthi/src/hooks/usePresence.js` | 3 | React hook that returns the list of active users for a workspace |
| `synthi/src/hooks/usePreviewLifecycle.js` | 1 | usePreviewLifecycle |
| `synthi/src/hooks/useProactiveAnalysis.js` | 14 | useProactiveAnalysis Hook |
| `synthi/src/hooks/useRetryCompile.js` | 3 | useRetryCompile |
| `synthi/src/hooks/useRuntimeHealing.js` | 3 | useRuntimeHealing — React hook for HMR runtime healing. |
| `synthi/src/hooks/useSSE.js` | 2 | useSSE — React hook to subscribe to Server-Sent Events for a workspace. |
| `synthi/src/hooks/useSelfHealing.js` | 40 | src/hooks/useSelfHealing.js |
| `synthi/src/hooks/useSmartRuleSuggestions.js` | 4 | src/hooks/useSmartRuleSuggestions.js |
| `synthi/src/hooks/useVFSWorkspaceAnalysis.js` | 17 | VFS-Backed Workspace Analysis Hook |
| `synthi/src/hooks/useViewport.js` | 2 | Breakpoints (px). Aligned with Tailwind's defaults so utility classes |
| `synthi/src/hooks/useVirtualizedTree.js` | 3 | useVirtualizedTree – flattens a recursive file-tree into a flat array of |
| `synthi/src/hooks/useWorkspaceAnalysis.js` | 19 | useWorkspaceAnalysis Hook |
| `synthi/src/hooks/useWorkspacePresence.js` | 3 | React hook that returns workspace-level presence info: |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/__tests__/oauthRelayServer.test.js` | 3 | defines `runtimeScopeForDemoUser` |
| `synthi/src/lib/__tests__/preview-store.test.js` | 3 | Preview Store Integration Tests |
| `synthi/src/lib/__tests__/terminal-preview-links.test.js` | 8 | import { describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/__tests__/workspaceAccess.test.js` | 8 | defines `loadAccessModule` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/adapter-health-panel.js` | 3 | adapter-health-panel.js — Frontend adapter health panel |
| `synthi/src/lib/adapter-status.js` | 3 | adapter-status.js — Frontend adapter status store |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/agent-routing/__tests__/agent-context-budget.test.js` | 927 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/agent-routing/__tests__/agent-pipeline-routing.test.js` | 2 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/agent-routing/__tests__/chat-tool-routing.test.js` | 3 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/agent-routing/__tests__/independent-agent-validator.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/agent-routing/__tests__/skill-metadata-registry.test.js` | 3 | import { describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/agent-routing/agent-context-budget.js` | 845 | Bounds inter-agent context before it crosses an execution boundary. |
| `synthi/src/lib/agent-routing/agent-execution-policy.js` | 2 | Server-owned capabilities for the legacy chat agent types.  The client may |
| `synthi/src/lib/agent-routing/agent-pipeline-routing.js` | 3 | This is an identifier/group catalog, never a collection of tool schemas. |
| `synthi/src/lib/agent-routing/chat-tool-routing.js` | 6 | This catalog deliberately contains only identifiers and routing metadata. |
| `synthi/src/lib/agent-routing/independent-agent-validator.js` | 1 | defines `validateIndependentAgentResult` |
| `synthi/src/lib/agent-routing/selective-skill-loader.js` | 3 | Next and Vitest can transform import.meta.url to a non-file URL. Synthi |
| `synthi/src/lib/agent-routing/skill-execution-context.js` | 1 | Builds the one narrow boundary where selected skill bodies are allowed to |
| `synthi/src/lib/agent-routing/skill-metadata-registry.js` | 12 | Routing must work from this deliberately small metadata shape.  In |
| `synthi/src/lib/agent-routing/workspace-agent-protocol.js` | 1 | This is an immutable server-owned baseline. Passive workspace instruction |
| `synthi/src/lib/ai-jumpstart-session.js` | 4 | AI Jumpstart session transfer utilities. |
| `synthi/src/lib/ai-loop-status.js` | 4 | ai-loop-status.js |
| `synthi/src/lib/aiCompletionTelemetry.js` | 5 | Inline-completion telemetry. Mirrors the NEP pattern in nepTelemetry.js |
| `synthi/src/lib/aiReplayHarness.js` | 4 | Local replay/eval capture for AI editor features. |
| `synthi/src/lib/candidate-tracker.js` | 3 | candidate-tracker.js |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/codesite/__tests__/activityBridgeReadiness.test.js` | 6 | import { afterEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/artifacts.test.js` | 50 | defines `persistedKnowledge` |
| `synthi/src/lib/codesite/__tests__/autoChannels.test.js` | 5 | defines `peerSession` |
| `synthi/src/lib/codesite/__tests__/channelRelay.test.js` | 4 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/channelSecurity.test.js` | 4 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/codesiteShadowRunner.test.js` | 17 | defines `sha256` |
| `synthi/src/lib/codesite/__tests__/controlPlane.test.js` | 372 | ﻿import fs from 'fs/promises'; |
| `synthi/src/lib/codesite/__tests__/dojoPublicVerifier.test.js` | 4 | defines `signedProofFixture` |
| `synthi/src/lib/codesite/__tests__/filesystemBoundaryProof.test.js` | 3 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/knowledgeEvents.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/knowledgePolicy.test.js` | 23 | defines `base` |
| `synthi/src/lib/codesite/__tests__/knowledgeRecords.test.js` | 4 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/knowledgeResponses.test.js` | 3 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/knowledgeRouting.test.js` | 4 | defines `item` |
| `synthi/src/lib/codesite/__tests__/metrics.test.js` | 15 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/pilotLicense.test.js` | 8 | defines `projectFixture` |
| `synthi/src/lib/codesite/__tests__/policy.test.js` | 14 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/projectCoordinationBus.test.js` | 9 | defines `rawObservation` |
| `synthi/src/lib/codesite/__tests__/projectObservation.test.js` | 18 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/codesite/__tests__/proofVerifierCli.test.js` | 21 | synthi package root, resolved from this file's location so the suite is |
| `synthi/src/lib/codesite/__tests__/repoPolicyCompiler.test.js` | 5 | defines `write` |
| `synthi/src/lib/codesite/__tests__/repoSnapshot.test.js` | 6 | defines `version` |
| `synthi/src/lib/codesite/__tests__/routeHelpers.internalAuth.test.js` | 3 | defines `reqWith` |
| `synthi/src/lib/codesite/__tests__/substrateIdentity.test.js` | 1 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/codesite/activityBridgeReadiness.js` | 7 | defines `configuredCollabHttpUrl` |
| `synthi/src/lib/codesite/artifacts.js` | 61 | defines `CODESITE_ARTIFACT_VERSION` |
| `synthi/src/lib/codesite/autoChannels.js` | 4 | Local copy of controlPlane's unique() — autoChannels must not import the |
| `synthi/src/lib/codesite/channelSecurity.js` | 5 | Registered direct channels — security primitives. |
| `synthi/src/lib/codesite/controlPlane.js` | 536 | ﻿import { spawn } from 'child_process'; |
| `synthi/src/lib/codesite/deliverySecurity.js` | 3 | Workstream F.2 — outbound delivery adapter hardening. |
| `synthi/src/lib/codesite/dojoProof.js` | 7 | defines `buildCodeSiteDojoProofInput` |
| `synthi/src/lib/codesite/dojoPublicVerifier.js` | 12 | defines `verifyDojoProofCapsulePublicWithKeyRecord` |
| `synthi/src/lib/codesite/filesystemBoundaryProof.js` | 10 | defines `buildFilesystemBoundaryProofRecords` |
| `synthi/src/lib/codesite/json.js` | 862 | defines `parseJson` |
| `synthi/src/lib/codesite/knowledgeEvents.js` | 743 | defines `canonicalKnowledgeEventType` |
| `synthi/src/lib/codesite/knowledgePolicy.js` | 28 | defines `KNOWLEDGE_KINDS` |
| `synthi/src/lib/codesite/knowledgeRecords.js` | 5 | defines `dateOrNull` |
| `synthi/src/lib/codesite/knowledgeResponses.js` | 4 | const ACTIONS = Object.freeze({ |
| `synthi/src/lib/codesite/knowledgeRouting.js` | 8 | defines `unique` |
| `synthi/src/lib/codesite/metrics.js` | 35 | import { asArray, parseJson } from './json'; |
| `synthi/src/lib/codesite/pilotLicense.js` | 35 | defines `PILOT_LICENSE_HEALTH_SCHEMA_VERSION` |
| `synthi/src/lib/codesite/policy.js` | 44 | defines `AIRSPACE_CLASSES` |
| `synthi/src/lib/codesite/projectCoordinationBus.js` | 9 | defines `PROJECT_COORDINATION_PIPELINE` |
| `synthi/src/lib/codesite/projectObservation.js` | 20 | defines `PROJECT_OBSERVATION_SCHEMA_VERSION` |
| `synthi/src/lib/codesite/proof.js` | 17 | defines `buildProofBundle` |
| `synthi/src/lib/codesite/repoPolicyCompiler.js` | 18 | defines `discoverRepoPolicySignals` |
| `synthi/src/lib/codesite/repoSnapshot.js` | 19 | defines `buildReadSnapshotEvidence` |
| `synthi/src/lib/codesite/routeHelpers.js` | 4 | defines `readJson` |
| `synthi/src/lib/codesite/substrateIdentity.js` | 2 | defines `normalizeCodeSiteRef` |
| `synthi/src/lib/collab-url.js` | 919 | defines `resolveCollabHttpUrl` |
| `synthi/src/lib/collabGuestAccess.js` | 3 | collabGuestAccess — server-only bridge from a Next.js API route to the |
| `synthi/src/lib/completion.js` | 8 | Shared constants and helpers for the AI code completion flow. |
| `synthi/src/lib/contrast-utils.js` | 3 | @fileoverview Color Contrast Utilities |
| `synthi/src/lib/diagnostics-normalizer.js` | 3 | Diagnostics Normalizer |
| `synthi/src/lib/diagnostics-schema.js` | 2 | Unified Diagnostics Schema |
| `synthi/src/lib/dirty-files.js` | 2 | dirty-files.js |
| `synthi/src/lib/dynlib-status.js` | 2 | dynlib-status.js |
| `synthi/src/lib/editKindClassifier.js` | 6 | Edit-kind classifier — Phase 2. |
| `synthi/src/lib/failure-distiller-runtime-evidence.js` | 4 | defines `append` |
| `synthi/src/lib/formatters.js` | 1 | Client-side helper to register Monaco formatting providers that call the |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/git/__tests__/providerConfig.test.js` | 1 | import { describe, it, expect, beforeEach } from 'vitest'; |
| `synthi/src/lib/git/__tests__/store.test.js` | 5 | import { describe, it, expect, vi, beforeEach } from 'vitest'; |
| `synthi/src/lib/git/__tests__/token.test.js` | 3 | import { describe, it, expect, vi, beforeEach } from 'vitest'; |
| `synthi/src/lib/git/adapters/__tests__/adapters.test.js` | 3 | defines `okJson` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/git/adapters/generic.js` | 134 | generic.js — self-hosted GitLab-compatible; reuse the gitlab adapter unchanged. |
| `synthi/src/lib/git/adapters/github.js` | 2 | defines `github` |
| `synthi/src/lib/git/adapters/gitlab.js` | 2 | defines `gitlab` |
| `synthi/src/lib/git/adapters/index.js` | 372 | defines `getAdapter` |
| `synthi/src/lib/git/providerConfig.js` | 1 | Per-provider hosted defaults + OAuth endpoints. baseUrl overrides host for self-hosted. |
| `synthi/src/lib/git/routeHelpers.js` | 1 | Auth + load (with secrets) + scope-check a git provider; returns {error?:Response, conn?, adapter?, actor?}. */ |
| `synthi/src/lib/git/safeFetch.js` | 239 | fetch() gated by the Slice-1 SSRF guard. Throws (does not fetch) on unsafe URLs. */ |
| `synthi/src/lib/git/store.js` | 4 | Build a Prisma where-clause scoped to the actor (personal) or workspace. */ |
| `synthi/src/lib/git/token.js` | 2 | Return a usable access token for a connection, refreshing an expired OAuth token first. */ |
| `synthi/src/lib/githubToken.js` | 885 | Sync, in-memory GitHub token cache used by Redux thunks and other non-React |
| `synthi/src/lib/gpu-hmr-status.js` | 4 | defines `emit` |
| `synthi/src/lib/healing/persistence.js` | 1 | src/lib/healing/persistence.js |
| `synthi/src/lib/healing/ruleEngine.js` | 15 | src/lib/healing/ruleEngine.js |
| `synthi/src/lib/hmr-runtime.js` | 15 | Client-side HMR Runtime |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/integrations/__tests__/connectionStore.test.js` | 2 | vi.mock factories are hoisted above module-level consts, so the mock state must be |
| `synthi/src/lib/integrations/__tests__/pat.test.js` | 1012 | import { describe, it, expect } from 'vitest'; |
| `synthi/src/lib/integrations/__tests__/patAuth.test.js` | 2 | defines `reqWith` |
| `synthi/src/lib/integrations/__tests__/rateLimit.test.js` | 1 | import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'; |
| `synthi/src/lib/integrations/__tests__/scope.test.js` | 5 | vi.hoisted so the mock state exists before the hoisted vi.mock factory runs. |
| `synthi/src/lib/integrations/__tests__/session.test.js` | 1 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/integrations/connectionStore.js` | 4 | R1-10: connections are identified by `id`, never by `name` (names are user-controlled, |
| `synthi/src/lib/integrations/pat.js` | 731 | sha256 hex of a token string. Stored + looked up — the plaintext is never persisted. */ |
| `synthi/src/lib/integrations/patAuth.js` | 1 | Extract a Bearer token from the Authorization header, or null. */ |
| `synthi/src/lib/integrations/rateLimit.js` | 2 | Dependency-free fixed-window rate limiter for the integrations API and external |
| `synthi/src/lib/integrations/scope.js` | 2 | Roles permitted to mutate a workspace connection (R1-9). Plain 'member' is read-only. |
| `synthi/src/lib/integrations/session.js` | 861 | Resolve the authenticated actor to { userId, email, workspaceUserId }, or null. */ |
| `synthi/src/lib/internalAiAuth.js` | 240 | defines `withInternalAiAuth` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/jupyter/__tests__/flags.test.js` | 739 | import { afterEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/jupyter/__tests__/notebook.test.js` | 3 | import { afterEach, describe, expect, it, vi } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/jupyter/audit.js` | 524 | Records redacted operational facts only. Observability must never block Jupyter work. */ |
| `synthi/src/lib/jupyter/client.js` | 6 | defines `JupyterGatewayError` |
| `synthi/src/lib/jupyter/flags.js` | 507 | Editing and execution are core notebook capabilities. They are available |
| `synthi/src/lib/jupyter/notebook.js` | 4 | defines `sha256` |
| `synthi/src/lib/jupyter/outputSafety.js` | 687 | defines `chooseSafeOutput` |
| `synthi/src/lib/jupyter/policy.js` | 2 | defines `validateJupyterOrigin` |
| `synthi/src/lib/jupyter/registry.js` | 2 | defines `listJupyterServers` |
| `synthi/src/lib/jupyter/sync.js` | 1 | Computes a deterministic notebook sync state. Hashes represent durable content, |
| `synthi/src/lib/local-support/acceptance.js` | 15 | defines `RELEASE_BLOCKER_CATEGORIES` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/acceptance.test.js` | 6 | import { describe, expect, it } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/adminStore.js` | 5 | defines `readDurableAdminState` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/adminStore.test.js` | 3 | import { describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/controlPlane.js` | 70 | defines `LOCAL_SUPPORT_PROTOCOL` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/controlPlane.test.js` | 27 | defines `envelope` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/deviceAuth.js` | 4 | defines `authenticateLocalSupportDevice` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/deviceAuth.test.js` | 4 | defines `fixture` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/linkedProjectStore.js` | 5 | defines `normalizeLinkedProject` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/nextConfigHeaders.test.js` | 1 | import { describe, expect, it } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/pairingStore.js` | 9 | defines `findPairingOrganization` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/pairingStore.test.js` | 7 | defines `challenge` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/policyStore.js` | 23 | defines `readDurableLocalSupportPolicy` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/policyStore.test.js` | 16 | import { describe, expect, it, vi } from "vitest"; |
| `synthi/src/lib/local-support/postgres.integration.test.js` | 3 | import { describe, expect, it } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/relayPayloadCrypto.js` | 1 | defines `encryptRelayPayload` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/relayPayloadCrypto.test.js` | 1 | import { describe, expect, it } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/relayPayloadStore.js` | 5 | defines `storeApprovedRelayPayload` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/relayPayloadStore.test.js` | 4 | import { beforeEach, describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/relayStore.js` | 17 | defines `enqueueLocalControlCommand` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/relayStore.test.js` | 15 | defines `requestRecord` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/securityEventStore.js` | 1 | defines `persistSecurityEvent` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/securityEventStore.test.js` | 1 | import { describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/sessionStore.js` | 6 | defines `persistPairedSession` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/sessionStore.test.js` | 5 | import { describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/local-support/transparencyStore.js` | 4 | defines `readCloudTransparencyState` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/local-support/transparencyStore.test.js` | 3 | import { describe, expect, it, vi } from "vitest"; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/loop-status.js` | 2 | loop-status.js |
| `synthi/src/lib/name-validator.js` | 3 | @fileoverview Theme Name Validator |
| `synthi/src/lib/nepTelemetry.js` | 11 | NEP telemetry — Phase 3. |
| `synthi/src/lib/nextEdit.js` | 15 | Shared constants, stream parser, and validator for Next-Edit Prediction (NEP). |
| `synthi/src/lib/oauthRelayServer.js` | 11 | defines `base64UrlEncode` |
| `synthi/src/lib/preview-lifecycle.js` | 2 | Preview Lifecycle Schema |
| `synthi/src/lib/preview-store-bridge.js` | 4 | Preview Store Bridge |
| `synthi/src/lib/preview-store.js` | 4 | Native Preview Lifecycle Store |
| `synthi/src/lib/prisma.js` | 280 | defines `prisma` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/programs/__tests__/aiReviewer.test.js` | 2 | import { describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/checkoutReference.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/compose.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/defaultPrograms.test.js` | 6 | import { describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/devcontainer.test.js` | 6 | Assert a thrown ProgramManifestError with a given code (and optional field). */ |
| `synthi/src/lib/programs/__tests__/dockerfile.test.js` | 1 | Container programs mount the workspace so they share /workspace with the editor. |
| `synthi/src/lib/programs/__tests__/earnings.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/entitlements.test.js` | 2 | import { afterEach, describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/hardGates.test.js` | 3 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/hostEscape.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/imageScanner.test.js` | 2 | import { describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/imageSize.test.js` | 3 | A single-platform image manifest: total = config.size + Σ layers.size. */ |
| `synthi/src/lib/programs/__tests__/manifest.test.js` | 7 | Assert a thrown ProgramManifestError with a given code (and optional field). */ |
| `synthi/src/lib/programs/__tests__/manifestGenerator.test.js` | 1 | import { describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/paidEntitlements.test.js` | 2 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/paidGate.test.js` | 2 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/paymentWebhook.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/pricing.test.js` | 4 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/reHoster.test.js` | 2 | import { describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/repoDetect.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/reviewOrchestrator.test.js` | 11 | A persisted 'submitted' container row, as the worker (processSubmission) sees it. */ |
| `synthi/src/lib/programs/__tests__/routeHelpers.test.js` | 3 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/runtimeClient.test.js` | 5 | defines `mockFetch` |
| `synthi/src/lib/programs/__tests__/scaffoldTemplates.test.js` | 2 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/store.test.js` | 31 | import { beforeEach, describe, expect, it, vi } from 'vitest'; |
| `synthi/src/lib/programs/__tests__/stripeSignature.test.js` | 1 | defines `sign` |
| `synthi/src/lib/programs/__tests__/workspaceMount.test.js` | 533 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/programs/aiReviewer.js` | 3 | @fileoverview Phase-2 advisory AI risk review for community submissions. |
| `synthi/src/lib/programs/checkoutReference.js` | 1 | @fileoverview HMAC-signed checkout reference. Binds the checkout hand-off |
| `synthi/src/lib/programs/compose.js` | 2 | @fileoverview Minimal, dependency-free mapper from a `docker-compose.yml` into |
| `synthi/src/lib/programs/defaultPrograms.js` | 10 | @fileoverview Canonical default marketplace catalog (single source of truth). |
| `synthi/src/lib/programs/devcontainer.js` | 8 | @fileoverview Pure import mapper for a documented subset of the |
| `synthi/src/lib/programs/dockerfile.js` | 1 | @fileoverview Mapper from a repo-root `Dockerfile` into the shared |
| `synthi/src/lib/programs/earnings.js` | 1 | @fileoverview Pure publisher-earnings math. Gross = the sum of captured prices |
| `synthi/src/lib/programs/entitlements.js` | 2 | @fileoverview Publish entitlement + platform-admin hooks. `canPublish` is the |
| `synthi/src/lib/programs/hardGates.js` | 2 | @fileoverview Pure, fail-closed hard gates for a community-app submission. |
| `synthi/src/lib/programs/hostEscape.js` | 1 | @fileoverview Shared host-escape ruleset. Single source of truth for the |
| `synthi/src/lib/programs/imageScanner.js` | 2 | @fileoverview trivy CVE scan wrapper for community-app images. The exec |
| `synthi/src/lib/programs/imageSize.js` | 3 | @fileoverview Deterministic image-size gate for community-app images. Uses |
| `synthi/src/lib/programs/manifest.js` | 8 | @fileoverview Pure parser/validator for the `vectant.programs.json` recipe manifest. |
| `synthi/src/lib/programs/manifestGenerator.js` | 1 | @fileoverview Server-side client for the ai-engine manifest generator. Mirrors |
| `synthi/src/lib/programs/paidEntitlements.js` | 1 | @fileoverview Entitlement store — who is allowed to install/run a paid app. |
| `synthi/src/lib/programs/paidGate.js` | 1 | @fileoverview Route helper: compose the paywall for a (program, subject). Ties |
| `synthi/src/lib/programs/paymentWebhook.js` | 1 | @fileoverview Pure helpers for mapping a Stripe webhook event to an entitlement |
| `synthi/src/lib/programs/pricing.js` | 3 | @fileoverview Program pricing — validation (pure) + thin prisma wrappers. |
| `synthi/src/lib/programs/reHoster.js` | 2 | @fileoverview Re-host an approved community image into our Artifact Registry, |
| `synthi/src/lib/programs/repoDetect.js` | 1 | @fileoverview Repo auto-detection (Slice 1 — real programs): map the |
| `synthi/src/lib/programs/reviewOrchestrator.js` | 9 | @fileoverview Drives the community-app review state machine, autonomously. |
| `synthi/src/lib/programs/routeHelpers.js` | 2 | defines `normalizeGrantScopes` |
| `synthi/src/lib/programs/runtimeClient.js` | 6 | defines `parseJsonResponse` |
| `synthi/src/lib/programs/scaffoldTemplates.js` | 4 | Minimal inline starter templates for the scaffoldable @vectant/* defaults. |
| `synthi/src/lib/programs/store.js` | 19 | defines `parseJsonText` |
| `synthi/src/lib/programs/stripeSignature.js` | 1 | @fileoverview Verify Stripe's `Stripe-Signature` header without pulling in the |
| `synthi/src/lib/programs/workspaceMount.js` | 1 | @fileoverview Shared helper: bind-mount the per-workspace dir into a program |
| `synthi/src/lib/project-templates/index.js` | 17 | Project & file template registry for the New-Workspace picker. |
| `synthi/src/lib/proxyAiEngine.js` | 1 | defines `proxyAiEngineRequest` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/lib/security/__tests__/csp.test.js` | 1 | defines `frameSrc` |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/lib/security/csp.js` | 1 | Build the app Content-Security-Policy. `frame-src` must include the |
| `synthi/src/lib/state-restore-status.js` | 4 | state-restore-status.js |
| `synthi/src/lib/statusIslandPreferences.js` | 9 | defines `STATUS_ISLAND_OFFSET_KEY` |
| `synthi/src/lib/terminal-color-overrides.js` | 2 | Terminal color overrides — per-browser tweaks layered on top of whatever |
| `synthi/src/lib/terminal-preview-links.js` | 12 | Terminal output can include OSC-8 hyperlink wrappers and ANSI/control bytes |
| `synthi/src/lib/theme-creator-schema.js` | 6 | @fileoverview Theme Creator Section Schema |
| `synthi/src/lib/theme-engine.js` | 18 | @fileoverview Synthi Theme Engine |
| `synthi/src/lib/tokenCrypto.js` | 1 | defines `encryptToken` |
| `synthi/src/lib/utils.js` | 137 | defines `cn` |
| `synthi/src/lib/workspaceAccess.js` | 6 | defines `WORKSPACE_MANAGE_ROLES` |
| `synthi/src/lib/workspaceInstallPlan.js` | 1 | defines `getWorkspaceDependencyInstallPlan` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/redux/__tests__/pane-active-file.test.js` | 1 | import { describe, it, expect } from 'vitest'; |
| `synthi/src/redux/__tests__/portsSlice.test.js` | 1 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/redux/compileManifestSlice.js` | 4 | src/redux/compileManifestSlice.js |
| `synthi/src/redux/extensionSlice.js` | 15 | src/redux/extensionSlice.js |
| `synthi/src/redux/gitSlice.js` | 41 | Returns the current user's GitHub token (PAT > GitHub OAuth) sourced from |
| `synthi/src/redux/healingSelectors.js` | 10 | src/redux/healingSelectors.js |
| `synthi/src/redux/healingSlice.js` | 27 | src/redux/healingSlice.js |
| `synthi/src/redux/hooks.js` | 212 | src/redux/hooks.js |
| `synthi/src/redux/isolatedSelectors.js` | 4 | isolatedSelectors.js — Narrow, memoized Redux selectors for render isolation |
| `synthi/src/redux/paneActiveFile.js` | 817 | Pure decisions linking the global workspace file model to the docking |
| `synthi/src/redux/portsSlice.js` | 1 | Forwardable TCP ports detected inside the workspace runtime container |
| `synthi/src/redux/prSlice.js` | 22 | prSlice.js — Redux state for Pull Request management. |
| `synthi/src/redux/store.js` | 12 | src/redux/store.js |
| `synthi/src/redux/themeSlice.js` | 7 | @fileoverview Theme Redux Slice |
| `synthi/src/redux/uiSlice.js` | 8 | src/redux/uiSlice.js |
| `synthi/src/redux/workspaceSlice.js` | 64 | src/redux/workspaceSlice.js |
| `synthi/src/server/gcsStorage.js` | 799 | defines `createGcsStorage` |
| `synthi/src/server/workspaceSearchIndex.js` | 9 | import readline from 'node:readline'; |
| `synthi/src/services/ContainerVFS.js` | 9 | Container-Centric Virtual File System (ContainerVFS) |
| `synthi/src/services/MonacoSocketAdapter.js` | 14 | Adapts an RTCDataChannel to the WebSocket-like interface that |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/services/__tests__/agentWorkflowClient.test.js` | 5 | defines `jsonMockResponse` |
| `synthi/src/services/__tests__/agentWorkflowHandoff.test.js` | 3 | import { describe, expect, it } from 'vitest'; |
| `synthi/src/services/__tests__/aiSuppressedRules.test.js` | 12 | @fileoverview Tests for aiSuppressedRules.js — fingerprint-aware suppression store. |
| `synthi/src/services/__tests__/programSessionClient.test.js` | 2 | COLLAB_BASE defaults to http://localhost:1234 in the test env (no |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/services/agentWorkflowClient.js` | 6 | AgentWorkflowClient - direct browser client for the MCP browser workflow |
| `synthi/src/services/agentWorkflowDojoAudit.js` | 2 | defines `asRecord` |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/src/services/agentWorkflowDojoAudit.test.js` | 1 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `synthi/src/services/agentWorkflowHandoff.js` | 6 | defines `safeWorkflowDirectoryName` |
| `synthi/src/services/aiFixHistory.js` | 3 | src/services/aiFixHistory.js |
| `synthi/src/services/aiSuppressedRules.js` | 14 | src/services/aiSuppressedRules.js |
| `synthi/src/services/analyzerGatewayClient.js` | 44 | Increase timeout to better accommodate long-running AI/gateway requests. |
| `synthi/src/services/api.js` | 16 | src/services/api.js |
| `synthi/src/services/collabClient.js` | 48 | CollabClient — Workspace collaboration orchestrator. |
| `synthi/src/services/collabSessionService.js` | 42 | CollabSessionService — Frontend service for "Remote Control" collaboration. |
| `synthi/src/services/compilerClient.js` | 98 | defines `shouldUseWorkspaceSpawner` |
| `synthi/src/services/crdtWorkerBridge.js` | 14 | CRDT Worker Bridge — Main-thread adapter for the collab-crdt Web Worker. |
| `synthi/src/services/dojoClient.js` | 101 | defines `createEmptyDojoSummary` |
| `synthi/src/services/escapeHatchClient.js` | 4 | EscapeHatchClient — thin HTTP + SSE client for the MCP's operator |
| `synthi/src/services/fileCache.js` | 5 | Per-file local snapshot history (most-recent-first).  Bounded so huge |
| `synthi/src/services/gitClient.js` | 14 | Normalize a file path to forward slashes and strip leading slash. |
| `synthi/src/services/loadScheduler.js` | 6 | defines `LoadScheduler` |
| `synthi/src/services/lspRegistry.js` | 7 | Synthi LSP Registry |
| `synthi/src/services/monacoDiagnosticsAdapter.js` | 12 | Monaco Diagnostics Adapter |
| `synthi/src/services/operatorClient.js` | 5 | operatorClient — WS client for the operator observability UI. |
| `synthi/src/services/perfMarkers.js` | 1 | defines `perfEnabled` |
| `synthi/src/services/prClient.js` | 16 | prClient.js — GitHub REST API client for Pull Request management. |
| `synthi/src/services/preCompileHealer.js` | 13 | Pre-Compile Healer — client-side syntax fixer that runs BEFORE HMR compiles. |
| `synthi/src/services/programSessionClient.js` | 3 | defines `parseJson` |
| `synthi/src/services/runtimeErrorInterceptor.js` | 19 | Runtime Error Interceptor |
| `synthi/src/services/runtimeScope.js` | 2 | defines `hashRuntimeScopePart` |
| `synthi/src/services/sseClient.js` | 6 | sseClient.js — Frontend SSE (Server-Sent Events) client for Synthi IDE |
| `synthi/src/services/userIdentity.js` | 1 | Centralised localStorage keys and accessor for the current |
| `synthi/src/services/vfs/VFSProvider.jsx` | 6 | VFS React Context Provider |
| `synthi/src/services/vfs/VirtualFileSystem.js` | 22 | Virtual File System (VFS) - Server-First Architecture |
| `synthi/src/services/vfs/index.js` | 161 | VFS Module Exports |
| `synthi/src/services/vscodeTunnelService.js` | 17 | VSCodeTunnelService |
| `synthi/src/themes/THEME_MIGRATION.md` | 3 | Theme Migration — Remaining Hardcoded Colors |
| `synthi/src/themes/builtin/high-contrast-dark.json` | 9 | JSON data (high-contrast-dark.json) |
| `synthi/src/themes/builtin/high-contrast-light.json` | 9 | JSON data (high-contrast-light.json) |
| `synthi/src/themes/builtin/midnight.json` | 8 | JSON data (midnight.json) |
| `synthi/src/themes/builtin/solarized-dark.json` | 9 | JSON data (solarized-dark.json) |
| `synthi/src/themes/builtin/solarized-light.json` | 9 | JSON data (solarized-light.json) |
| `synthi/src/themes/builtin/synthi-classic.json` | 8 | JSON data (synthi-classic.json) |
| `synthi/src/themes/builtin/synthi-dark.json` | 19 | JSON data (synthi-dark.json) |
| `synthi/src/themes/builtin/synthi-light.json` | 16 | JSON data (synthi-light.json) |
| `synthi/src/themes/builtin/vectant-sand.json` | 16 | JSON data (vectant-sand.json) |
| `synthi/src/themes/builtin/vectant-sky.json` | 16 | JSON data (vectant-sky.json) |
| `synthi/src/themes/index.js` | 1 | @fileoverview Built-in theme barrel — imports all shipped themes. |
| `synthi/src/themes/theme-schema.js` | 11 | @fileoverview Synthi Theme Schema |
| `synthi/src/utils/aiContextBroker.js` | 10 | defines `CONTEXT_SIDE_CHARS` |
| `synthi/src/utils/completionContext.js` | 14 | Local symbol-aware context for inline completions. |
| `synthi/src/utils/dependencyResolver.js` | 6 | import { getFileLanguage } from './fileUtils'; |
| `synthi/src/utils/fileIcons.js` | 6 | VS Code Icons - clean and professional |
| `synthi/src/utils/fileUtils.js` | 4 | Determines the file language for Monaco Editor based on the file extension. |
| `synthi/src/utils/getInitials.js` | 474 | Returns initials for a display name (e.g. "Jane Doe" → "JD"). |
| `synthi/src/utils/hunkDiff.js` | 3 | Compute a minimal line-range hunk between two strings. |
| `synthi/src/utils/languageMapper.js` | 2 | src/utils/languageMapper.js |
| `synthi/src/utils/multiFileContext.js` | 3 | Files that are never useful as AI context — they waste tokens. |
| `synthi/src/utils/nepRecentEdits.js` | 5 | NEP recent-edit ring buffer — Section 4 of the plan. |
| `synthi/src/workers/collab-crdt.worker.js` | 18 | eslint-env worker */ |
| `synthi/temp.js` | 0 | js file: temp.js |

## test

| File | Bytes | Note |
|---|---|---|
| `synthi/vitest.config.mjs` | 334 | import { defineConfig } from 'vitest/config'; |
