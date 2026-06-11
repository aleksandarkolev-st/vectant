# Slice 2 — Manual E2E (Git providers)

**Prereqs:**
- Running Postgres + Synthi with `npx prisma db push` applied (creates the `GitProvider` table).
- A GitLab account; a self-hosted GitLab (or GitLab-compatible host) for the generic path; GitHub already connected via login.
- **Env (OAuth apps):** synthi has no `.env.example`; set these in synthi's environment:
  - `GITLAB_CLIENT_ID` + `GITLAB_CLIENT_SECRET` — a GitLab OAuth app with redirect URI `${NEXTAUTH_URL}/api/integrations/git/oauth/gitlab/callback` and scopes `api read_user`.
  - `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` for the GitHub git-OAuth flow. NOTE: the git routes read `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, which are DISTINCT from NextAuth login's `GITHUB_ID`/`GITHUB_SECRET` — set them to the same OAuth app's credentials (or connect GitHub via PAT instead). (A follow-up will make the git flow reuse `GITHUB_ID`/`GITHUB_SECRET` directly.)
  - `NEXTAUTH_URL` must be set (used to build OAuth redirect URIs + the post-connect redirect).
  - Optional: `SYNTHI_RL_GIT` (git API requests/min per user, default 60).
  - Self-hosted/generic providers use a PAT (no OAuth app needed).

1. **OAuth (GitLab):** Integrations → Git Providers → "Connect GitLab (OAuth)" → authorize → returns to the app. ✅ Provider appears with your `accountLogin`.
2. **PAT (self-hosted/generic):** add a provider with type `generic`, a base URL, and a PAT. ✅ Appears in the list; `POST …/providers/:id/test` reports healthy.
3. **List repos:** `GET /api/integrations/git/providers/:id/repos`. ✅ Returns normalized repos for GitHub and GitLab alike (`{ id, fullName, url, private }`).
4. **Create PR/MR:** `POST …/:id/pulls` with `{repo, sourceBranch, targetBranch, title}`. ✅ GitHub opens a PR; GitLab opens an MR; both return `{ pr: { id, url, state } }`.
5. **Status:** `GET …/:id/status?repo=&ref=`. ✅ Normalized `{ checks: { state, total } }`.
6. **SSRF:** attempt to add a provider with `baseUrl=http://169.254.169.254/`. ✅ Rejected `unsafe_base_url` (400), nothing persisted.
7. **Refresh/relink:** expire/revoke an OAuth token; the next action either refreshes transparently or marks the provider `needsRelink` (no crash). ✅
8. **Disconnect:** delete a provider. ✅ Row removed AND its `EncryptedSecret` row(s) are deleted (no orphaned secrets).
9. **Device flow (headless/CLI):** `POST …/oauth/github/device/start` → visit `verification_uri` + enter `user_code` → `POST …/oauth/github/device/poll` returns 202 until authorized, then 201 + the provider appears. ✅

**Whole-plan verification (run before merge):**
- `cd synthi && npx vitest run src/lib/git src/app/api/integrations/git` → all Slice-2 suites pass (26 tests).
- `cd synthi && npx vitest run` → no regressions in the 1a/1b suites.
- **Disk-heavy (free ~6 GB first):** `cd synthi && npx prisma generate && npm run build` → build succeeds with the new `/api/integrations/git/...` routes listed. (Deferred until disk is freed — same as the Slice-1b build gate.)
