# Slice 2 — Git Provider Abstraction (v1 design)

**Status:** approved design → ready for task plan.
**Branch:** `tool-compatibility` (shared by all slices; reuses the Slice-1 foundation).
**Roadmap ref:** `docs/superpowers/plans/2026-06-01-tool-compatibility-roadmap.md` §5.

## 1. Purpose & context

Synthi today integrates GitHub two ways: NextAuth OAuth login (`GitHubProvider`, `repo` scope →
`session.accessToken`) and a per-user encrypted PAT (`User.githubTokenCipher` → `session.githubToken`,
via `src/lib/tokenCrypto.js`); `/api/github/create-repo` consumes these. Slice 2 generalizes this into a
**provider-agnostic Git integration**: connect GitLab and self-hosted/enterprise ("generic") providers
alongside GitHub, behind one adapter interface, with secrets in the existing vault and the same
scope/role authz as Slice 1.

This slice is **API-level** (REST calls to provider APIs). Running `git`/`gh` as a managed process is
**Slice 3**; keep that boundary.

## 2. Goals / non-goals

**Goals (v1):**
- A `GitProvider` registry (personal/workspace scoped) for GitLab + generic providers, with a GitHub
  adapter that wraps the existing GitHub token so all three share one interface.
- Auth: platform OAuth apps (env client id/secret) for github.com + gitlab.com — **web flow** (app) and
  **device flow** (CLI/headless) — plus a **PAT** path for self-hosted/enterprise/generic. Token refresh.
- Provider adapter actions: `testConnection`, `listRepos`, `createPullRequest` (normalizes GitHub PR ⇄
  GitLab MR), `getStatus(repo, ref)`.
- App UI to connect/list/disconnect providers, reusing the Slice-1 Connect UI pattern.

**Non-goals (deferred):**
- **Inbound webhooks** (push/PR-MR/pipeline ingress + signature verification + event router + replay/dedupe)
  → **Slice 2b** (own spec; needs public ingress infra).
- **Bitbucket** — fast-follow once the adapter interface lands.
- **PAT/CLI access to git actions** (these routes are session-authed in v1; CLI access is a follow-up).
- **Full GitHub migration** off `User.githubTokenCipher` (the GitHub adapter reads the existing token; the
  old plumbing is untouched).
- A dedicated `GitActionAudit` table (reuse/extend the `McpCallAudit` pattern later if needed — YAGNI now).
- Process-level `git`/`gh` execution (Slice 3).

## 3. Acceptance criteria

1. A user can connect a **GitLab** account via OAuth (web flow in the app) and a **self-hosted GitLab**
   or **generic** provider via PAT + base URL; the credential is stored encrypted in `EncryptedSecret`.
2. A **device flow** lets a headless/CLI context obtain provider authorization (start → poll → stored).
3. `listRepos`, `createPullRequest`, and `getStatus` work against GitHub, GitLab, and a generic provider
   through one adapter interface, with GitHub/GitLab response differences normalized.
4. Expired OAuth access tokens are transparently refreshed; a failed refresh marks the provider
   `needsRelink` without throwing.
5. All provider URLs (including user-supplied `baseUrl`) pass the Slice-1 **SSRF guard** before any fetch.
6. All routes are NextAuth-gated, `canReadScope`-checked, and rate-limited; tokens never appear in logs,
   error responses, or audit data.
7. Unit suites (vitest, mocked `fetch`+prisma) cover adapter normalization, OAuth exchange/refresh, PAT
   storage, the SSRF guard on `baseUrl`, and route authz/scope.

## 4. Data model — `GitProvider` (new, sibling to `McpConnection`)

New Prisma model (mirrors `McpConnection`'s scoping so authz/UI reuse cleanly):

```prisma
model GitProvider {
  id                   String    @id @default(cuid())
  name                 String                       // user label, e.g. "Work GitLab"
  providerType         String                       // 'github' | 'gitlab' | 'generic'
  baseUrl              String?                       // null = provider default; set for self-hosted/enterprise
  scope                String                        // 'personal' | 'workspace'
  ownerUserId          String?
  workspaceSlug        String?
  authType             String    @default("pat")     // 'oauth' | 'pat'
  secretId             String?   @unique             // PAT, or OAuth access token
  secret               EncryptedSecret? @relation("GitProviderSecret", fields: [secretId], references: [id], onDelete: SetNull)
  refreshSecretId      String?   @unique             // OAuth refresh token (if any)
  refreshSecret        EncryptedSecret? @relation("GitProviderRefresh", fields: [refreshSecretId], references: [id], onDelete: SetNull)
  accessTokenExpiresAt DateTime?
  oauthScopes          String[]  @default([])
  accountLogin         String?                       // provider username, for display
  enabled              Boolean   @default(true)
  needsRelink          Boolean   @default(false)
  lastHealthState      String?
  lastHealthAt         DateTime?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  @@index([ownerUserId])
  @@index([workspaceSlug])
}
```

`EncryptedSecret` gains two optional back-relations (`GitProviderSecret`, `GitProviderRefresh`); no other
Slice-1 model changes. **GitHub** does not require a row — its adapter reads `session.githubToken` /
`User.githubTokenCipher`; it is surfaced in the providers list as an implicit `github` provider.

## 5. Provider adapter interface

Location: `synthi/src/lib/git/` (in-app; not a workspace package yet — YAGNI until a CLI needs it).
A `providerType → adapter` registry; each adapter implements:

```ts
// pseudo-interface (JS in-app, matching the repo's API-route style)
testConnection(conn)                         -> { ok, accountLogin } | { ok:false, error }
listRepos(conn, { page?, perPage?, search? }) -> { ok, repos: NormalizedRepo[] } | { ok:false, error }
createPullRequest(conn, { repo, sourceBranch, targetBranch, title, body })
                                              -> { ok, pr: NormalizedPR } | { ok:false, error }
getStatus(conn, { repo, ref })                -> { ok, checks: NormalizedStatus } | { ok:false, error }
```

Adapters: `githubAdapter`, `gitlabAdapter`, `genericAdapter`. They normalize provider differences
(GitHub *pull request* vs GitLab *merge request* → `createPullRequest`/`NormalizedPR`; repo/status shapes).
The `generic` adapter targets a configured `baseUrl` with the GitLab- or GitHub-compatible REST surface the
user selects (v1 supports the GitLab-compatible shape for generic self-hosted GitLab; truly arbitrary
forges are out of scope). Each adapter resolves credentials via a shared `getToken(conn)` that handles
PAT vs OAuth (+ refresh) uniformly.

## 6. Auth (OAuth web + device + PAT, refresh)

- **Web flow (app):** `GET /api/integrations/git/oauth/:provider/start` → redirect to the provider's
  authorize URL (state + PKCE where supported); `GET /api/integrations/git/oauth/:provider/callback` →
  exchange code → store access (+ refresh) token in `EncryptedSecret`, create/update the `GitProvider` row.
- **Device flow (CLI/headless):** `POST /api/integrations/git/oauth/:provider/device/start` → returns
  `{ device_code, user_code, verification_uri, interval }`; `POST …/device/poll` → on success store tokens.
- **PAT:** `POST /api/integrations/git/providers` with `{ providerType, baseUrl?, name, token }` → encrypt
  token, `authType:'pat'`. Used for self-hosted/enterprise/generic where we cannot pre-register an OAuth app.
- **Refresh:** a `withFreshToken(conn)` helper checks `accessTokenExpiresAt`, refreshes via the stored
  refresh token before an action, and updates the vault; a failed refresh sets `needsRelink=true` and
  returns a typed error (mirrors the existing `githubTokenNeedsRelink`).
- **Platform OAuth apps:** env `GITLAB_CLIENT_ID/SECRET` (+ reuse the existing GitHub OAuth app). Generic
  self-hosted has no platform app → PAT only in v1.

## 7. API routes (`/api/integrations/git/…`)

All NextAuth-gated (`resolveActor` → 401), `canReadScope`-checked for workspace-scoped rows, and
rate-limited via a new `RATE_LIMITS.git` group — mirroring the Slice-1 `connections` route pattern.
`export const runtime = 'nodejs'`.

| Route | Method | Purpose |
|---|---|---|
| `/providers` | GET | list connected providers (scoped; includes the implicit GitHub) |
| `/providers` | POST | add a PAT-based provider |
| `/providers/:id` | DELETE | disconnect (revoke local; delete row + secret) |
| `/providers/:id/test` | POST | health/`testConnection` |
| `/providers/:id/repos` | GET | `listRepos` |
| `/providers/:id/pulls` | POST | `createPullRequest` (PR/MR) |
| `/providers/:id/status` | GET | `getStatus` (`?repo=&ref=`) |
| `/oauth/:provider/start`, `/callback`, `/device/start`, `/device/poll` | — | OAuth (§6) |

## 8. Security

- **SSRF:** every provider API URL and user-supplied `baseUrl` passes the Slice-1 SSRF guard
  (`assertSafeUrl` from the mcp-hub) before any fetch — blocks self-hosted URLs resolving to internal IPs.
- **Secret hygiene:** tokens live only in `EncryptedSecret` (AES-256-GCM); never logged, never in error
  responses, never returned by GET (only `accountLogin` + `last4` for display).
- **Error normalization:** provider API failures map to typed codes (`rate_limited | not_found | forbidden
  | provider_error | needs_relink`); upstream messages are summarized, not passed through verbatim.
- **Authz:** personal rows owner-checked; workspace rows `canReadScope`-checked (member-only), same as
  Slice 1.

## 9. Connect UI

A "Git Providers" section in the Integrations panel + a "Connect provider" dialog: choose `providerType`
→ OAuth (redirect / device code) or PAT entry → optional `baseUrl` for self-hosted. List shows
`accountLogin`, health, and a `needsRelink` badge with a re-link action; disconnect button. Derivative of
`AddConnectionDialog` / `ConnectedToolsPanel`; reuses theme vars + `ui/button` + lucide + sonner.

## 10. Testing

vitest TDD (mock `fetch` + prisma; `vi.hoisted` for hoisted mocks), no live provider calls, no builds
needed per task:
- adapter normalization (GitHub PR ⇄ GitLab MR; repo/status shapes) per adapter;
- OAuth callback code-exchange + the refresh helper (expired → refreshed; refresh-fail → `needsRelink`);
- PAT storage (encrypted; only `last4`/`accountLogin` returned);
- SSRF guard rejects internal `baseUrl`;
- route authz/scope (401 unauth, 403 non-member, rate-limit 429).

## 11. Reuse of the Slice-1 foundation

`EncryptedSecret` + `tokenCrypto`; `resolveActor` + `canReadScope`; `rateLimit` (`checkLimit` + new `git`
group); `assertSafeUrl` SSRF guard (from the hub); the Connect UI components; the route/handler conventions
(`runtime='nodejs'`, typed JSON errors). No changes to MCP code.

## 12. Boundary vs Slice 3

API-level provider actions (REST) live here. Process-level `git`/`gh`/CI execution is Slice 3's managed
program runtime. A provider connected here MAY later supply credentials to a Slice-3 session, but that
wiring is out of scope for Slice 2.

## 13. Decisions resolved (this brainstorm)

- **v1 scope:** connections + auth + API actions; webhooks → 2b.
- **Providers v1:** GitLab + generic + a thin GitHub adapter over the existing token (Bitbucket later).
- **Model:** new `GitProvider` sibling to `McpConnection` (no Slice-1 model refactor).
- **Auth:** platform OAuth (env) for github.com/gitlab.com (web + device) + PAT for self-hosted/generic.
