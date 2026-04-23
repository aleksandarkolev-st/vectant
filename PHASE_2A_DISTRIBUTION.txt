# Agent MCP — Phase 2a: Distribution

**Status:** design + execution notes for the phase-2a cut of `PHASE_2_PLUS_BACKLOG.md:G3`.
**Scope:** ship an installable `synthi-mcp` to authorized users of Synthi without making the source publicly available.
**Source of truth for scope:** `AGENT_MCP_ULTRAPLAN.md` §Phase 2 + `PHASE_2_PLUS_BACKLOG.md:G3`.

---

## 1. The proprietary constraint

The phase-2 bullet in the ultraplan reads:

> npm publish `@synthi/mcp-server`.

Taken literally, that publishes the full source to the public npm registry under a scope anyone can install. For a proprietary codebase that isn't what we want — the MCP server is the integration-layer IP that makes Synthi agent-drivable, and the public-npm default gives away everything the worker teaches it about the WebRTC contract, the frame-seq gate, the locator cache, the correctness ladder, and the vision-backend plumbing.

This document re-scopes "publish" to mean **"make the build installable by authorized consumers"** and lays out the distribution channels that satisfy that.

---

## 2. Options considered

Every option below was evaluated against four axes:

- **Access control.** Can an unauthorized user install it?
- **Install friction.** What does the agent-host config become?
- **IP exposure.** How much source leaks to each authorized user?
- **Release automation cost.** What CI + tagging story does it imply?

| Option | Access control | Install friction | IP exposure | Release automation | Verdict |
|---|---|---|---|---|---|
| **A. Public npm (`@synthi/mcp-server`)** | None — anyone installs. | `npx @synthi/mcp-server` one-liner. | Full compiled JS. | Trivial `npm publish` in CI. | ❌ violates proprietary constraint. |
| **B. Private npm.js org (paid Teams)** | Org member only. | `npm install @synthi/mcp-server` after `npm login`. | Compiled JS per authorized user. | `npm publish` in CI w/ npm token. | 🟡 works but adds a paid dependency outside our existing infra. |
| **C. GitHub Packages npm (scoped private pkg)** | Repo collaborator + PAT with `read:packages`. | `npm install @synthi-inc/mcp-server` after `.npmrc` with token. | Compiled JS per authorized user. | `npm publish` in CI against GitHub Packages registry — **no new billing**. | ✅ reuses existing `synthi-inc/synthi-ide` access control. |
| **D. GHCR container image (`ghcr.io/synthi-inc/synthi-mcp`)** | Repo collaborator + PAT with `read:packages` (or `docker login ghcr.io`). | `docker run -i ghcr.io/…` invocation in MCP config. | Image layers only — source not copied into distribution medium in raw form. | `docker build` + `docker push` in CI. | ✅ reuses existing access control; stronger IP posture than npm. |
| **E. GitHub Releases tarball + installer script** | Release artifact visibility = repo visibility. Private repo ⇒ auth required to download. | `curl -H "Authorization: bearer $GH_TOKEN" … | bash`. | Tarball contains compiled JS. | Custom installer + release automation. | 🟡 viable but reinvents package-manager semantics. |
| **F. Self-hosted Verdaccio or similar private registry** | Our auth, our hardware. | Requires registry URL in `.npmrc`. | Compiled JS per authorized user. | Push-on-tag CI. | 🟡 another service to keep alive; not justified at current team size. |
| **G. Remote hosted MCP (SaaS)** | Service-side auth per tenant. | Config points at a URL, not a binary. | Zero — source never leaves Synthi servers. | Phase-4 territory per the ultraplan. | ❌ out of phase-2a scope; belongs to phase 4 (`mcp-agent` role, scoped tokens, TURN). |
| **H. Source-only — authorized users clone + build** | Repo collaborator. | `git clone`, `npm install`, `npm run build`, absolute-path register. | Full source. | None. | ❌ this is what we do today; it's the thing phase 2a is trying to replace. |

### The cut

**Ship both C and D.** They share the same access-control substrate (the `synthi-inc` GitHub org), reuse the same release pipeline (one tag-triggered workflow produces both artifacts), and give authorized consumers a choice:

- **D (GHCR image)** — the *recommended* path. Stronger IP posture (compiled JS is a container layer, not a package tarball), smaller per-user setup surface (one `docker login ghcr.io`), and matches how the existing worker runs (Docker throughout the stack).
- **C (GitHub Packages npm)** — the *fallback* path for users who can't run Docker locally (Windows hosts without WSL, CI robots that already speak npm).

Public npm (option A) is explicitly deferred. If, later, we decide to ship a stripped-down public-tier MCP under `@synthi/mcp-client` or similar, that is a separate decision with its own scope doc; phase 2a does not open that door.

### Explicitly NOT doing in phase 2a

- No license file — per user directive, deferred.
- No public documentation beyond what already exists in-repo (the README is in `mcp/synthi-mcp/README.md`, accessible to authorized users).
- No marketing site / landing page.
- No telemetry / phone-home in the published artifact (stays opt-in via `SYNTHI_PROMETHEUS_PORT`).
- No public `npm dist-tag` for prerelease channels — only release tags on the GitHub repo trigger publish.
- No source-map publishing. `tsc` default source-map output stays off so even an authorized consumer who inspects `node_modules/@synthi-inc/mcp-server/dist/**` sees compiled JS, not original TypeScript with comments.

---

## 3. What ships in phase 2a

### 3.1 Package identity shift

Rename the npm package from `@synthi/mcp-server` (public-scope default) to `@synthi-inc/mcp-server` — the `@synthi-inc` scope is tied to the GitHub org `synthi-inc`, which is how GitHub Packages gates access. The binary name `synthi-mcp` stays unchanged so agent configs don't churn.

### 3.2 Release artifact: GHCR image

- Image: `ghcr.io/synthi-inc/synthi-mcp:<version>` + `:latest`.
- Base: `node:22-slim` (matches the existing `mcp/synthi-mcp/Dockerfile`).
- Entrypoint: `node /app/dist/index.js` — stdio MCP ready out of the box.
- Published on every release tag (`vX.Y.Z`) via GitHub Actions.
- Access: authorized Synthi collaborators authenticate once with `docker login ghcr.io` using a GitHub PAT with `read:packages`.

### 3.3 Release artifact: GitHub Packages npm

- Package: `@synthi-inc/mcp-server`.
- Registry: `https://npm.pkg.github.com`.
- Contains: `dist/` (compiled JS) + `README.md` + `package.json`. No `src/`, no `tests/`, no `.live-test-*`.
- Access: authorized consumers add a `.npmrc` with a GitHub PAT carrying `read:packages`.
- `postinstall` is a no-op — users pay zero native-build cost beyond what `sharp` / `@ffmpeg-installer/ffmpeg` already require.

### 3.4 Release pipeline

One GitHub Actions workflow (`.github/workflows/mcp-release.yml`) triggered on a tag of the form `mcp-v*` that:

1. Installs and builds `mcp/synthi-mcp/`.
2. Runs `npm run typecheck` + `npm test` as a release gate.
3. Builds the Docker image and pushes to GHCR.
4. Publishes the npm tarball to GitHub Packages.
5. Posts a GitHub Release with both artifacts linked.

Tag format (`mcp-v*`) is prefixed so releases don't collide with worker / signaling-server / collab-server versions that may also eventually ride independent tag lanes.

### 3.5 Per-client config snippets

`docs/CLIENT_CONFIGS.md` in `mcp/synthi-mcp/` — one block each for:

- Claude Code (preferred: GHCR image via `docker run -i`).
- Claude Code (fallback: GitHub Packages npm via `npx` with `.npmrc`).
- Codex CLI (stdio via Docker).
- Cursor (JSON config with Docker command).
- Gemini CLI (JSON config with Docker command).
- Windsurf (JSON config with Docker command).

Every snippet uses pinned image tags (`ghcr.io/synthi-inc/synthi-mcp:v0.1.0`, not `:latest`) so agent configs don't silently pick up a breaking change.

### 3.6 Release smoke test

`mcp/synthi-mcp/scripts/release-smoke.mjs` — runs against the just-published artifact:

1. Pulls the GHCR image at the tagged version.
2. Starts it with a fake `SYNTHI_SESSION_ID` and no network side.
3. Sends a `tools/list` JSON-RPC request over stdio.
4. Asserts the tool count + the presence of the 23 expected names.
5. Asserts protocol version negotiation returns `version:1`.
6. Shuts it down cleanly.

Fails the release workflow if any assertion trips. This is the minimum that would catch "release pipeline shipped an empty dist/" or "entrypoint moved and we didn't notice."

---

## 4. Access control posture

The two artifacts share the GitHub org `synthi-inc` as their root of trust:

- **Org membership controls who can pull.** Revoking a collaborator from `synthi-inc/synthi-ide` revokes their ability to pull the image or the npm tarball — no separate license-server to keep in sync.
- **No credentials embedded in the artifact.** Users bring their own `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / signaling URL. The image is a binary, not a license-bearing blob.
- **Audit trail via GitHub.** Package pulls are visible in the `synthi-inc` org audit log, so we can see which users / machines are exercising the distribution.

This is deliberately a **coarse** access-control model: authorized user = anyone in the org. Finer-grained seat management (per-user quota, per-seat API tokens, suspended-user revocation) is a phase-4 concern that rides alongside the `mcp-agent` signaling role and scoped-agent-token issuance. Phase 2a does not try to build that.

---

## 5. Rollout

1. **Land the package rename.** `@synthi/mcp-server` → `@synthi-inc/mcp-server`. Binary name unchanged.
2. **Land the publishConfig + .npmrc.example.** Both point at `https://npm.pkg.github.com`.
3. **Land the release workflow** with `workflow_dispatch` gated initially — manual trigger only for the first one or two releases while we shake out the pipeline.
4. **Land the per-client configs.** With a note that the GHCR path is preferred.
5. **Land the smoke test.**
6. **Cut `mcp-v0.1.0`** manually. Verify the image exists in GHCR + the package is visible in the `synthi-inc` org's Packages tab.
7. **Switch workflow trigger to tag-push.** Subsequent releases auto-publish.
8. **Update `AGENT_MCP_STATUS.md`** reflecting phase 2a complete.

Each of steps 1–5 is a small landable commit that keeps main green. Step 6 is manual (one human cuts the tag). Step 7 + 8 are cleanup commits.

---

## 6. What this doesn't decide

- **Versioning policy.** When does `0.1.0` become `0.2.0` vs `1.0.0`? Out of scope. Suggestion: stay on `0.x` until phase 1 is declared done against the ultraplan (all phase-1 worker work shipped + integration tests green). Bump to `1.0.0` then.
- **Breaking-change policy.** Client configs should pin image tags. We document that. We don't yet have a SemVer commitment policy.
- **Windows / macOS distribution quirks.** GHCR image is linux/amd64 first. Multi-arch (linux/arm64 for Apple Silicon hosts) is a small Dockerfile change once someone actually needs it — deferred to first user report.
- **Air-gapped customers.** Out of scope. They'd need option F (self-hosted registry) or option H (source build) on their side; not relevant until we have one.

---

## 7. Follow-ups for phase 2b-e

- Phase 2b (`synthi-probe` + Swing adapter) ships its own artifacts — language-specific packages (`com.synthi:probe-java` Maven, etc.). Each language has its own access-control story; this doc does not pre-commit to those choices.
- Phase 2c (broker) likely ships as a second GHCR image (`ghcr.io/synthi-inc/synthi-broker`). Same pipeline pattern; separate artifact.
- Phase 2d (operator UI) is a frontend change — no separate package-distribution story required.
- Phase 2e (chaos suite) is CI-internal — never a distributed artifact.
