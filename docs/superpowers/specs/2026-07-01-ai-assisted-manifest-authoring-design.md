# AI-Assisted Manifest Authoring (Design)

- **Date:** 2026-07-01
- **Status:** Approved (brainstormed) — ready for planning
- **Branch:** `feat/docker-sysbox-engine`
- **Scope:** Help publishers author a `vectant.programs.json` two ways: **(A)** a "Generate manifest" button that asks Gemini to produce one from the workspace, previewed + saved; **(B)** making the in-workspace AI (chat/CLI/terminal, routed through the ai-engine) aware of the manifest format so it can explain + author it. Builds on the community-app hosting work already merged.

## Problem

Publishing requires a valid `vectant.programs.json`, but authoring one by hand is a barrier — a user has to know the schema (`runtimeType`, `install[]`, `launch`, `ports[]`, `permissions[]`, host-escape rules). Two gaps:

1. **No assisted authoring.** Nothing generates a manifest from what's already in the workspace (a `package.json`, a `Dockerfile`, a compose file…).
2. **The AI tools don't know the format.** The in-workspace AI chat/CLI/terminal (all routed through the ai-engine) have no knowledge of `vectant.programs.json`, so they can't help a user write or fix one.

## Decisions (locked in brainstorming)

- **Order:** Feature A (generate button) first, fully in-repo end-to-end; then Feature B (ai-engine prompt awareness). A true MCP tool exposing this over the external `synthi-mcp` server is a **later** follow-up (needs that repo).
- **Generate flow = Preview → Save.** Gemini's output is validated through `parseProgramManifest`, shown in an editable preview dialog, and only written to the workspace on an explicit **Save** (no silent auto-write, no silent clobber of an existing manifest).
- **Reuse the review-gate's validation + AI-client patterns.** `parseProgramManifest` for validation; the `AI_ENGINE_BASE` + `withInternalAiAuth` server-side client (like `aiReviewer`); the `program_review.py` shape for the Python endpoint (import-light, provider-injectable, fail-closed).
- **One small backend touch:** extend the collab-server scaffold write with an `overwrite` flag so Save can replace an existing manifest (confirmed client-side).

## Feature A — "Generate manifest" button

### Components (isolated, independently testable)

1. **`ai-engine/program_manifest_gen.py`** — `async def generate_manifest(payload, provider=None) -> dict`. Builds a prompt from the workspace context (key file names + contents) instructing the model to emit ONLY a `vectant.programs.json` object; calls `provider.ask_llm(..., mode='rule_translate')`; extracts + returns `{ "manifest": {...} }`, or `{ "error": "..." }` fail-closed on any provider/parse failure. Import-light (lazy `get_provider`); unit-tested with a fake provider (no Gemini).
2. **`ai-engine` route** `POST /programs/generate-manifest` (main.py) — pydantic `{ files: dict, workspace_name: Optional[str] }` → `generate_manifest(...)`.
3. **Next.js generate route** `POST /api/workspace/[slug]/programs/generate-manifest` — owner/admin (`canWriteScope`). Gathers workspace context (build/dependency manifests + README — `package.json`, `requirements.txt`, `Dockerfile`, `docker-compose.yml`, `.devcontainer/devcontainer.json`, `README*`) via the collab-server file-read the `detect` path already uses (extended to return this set), calls the ai-engine via `AI_ENGINE_BASE` + `withInternalAiAuth`, then **validates the returned manifest through `parseProgramManifest`**. Returns `{ manifest, valid, errors? }` — returns even when invalid so the user can fix it in the preview.
4. **Next.js save route** `POST /api/workspace/[slug]/programs/manifest` — owner/admin. **Re-validates** `{ manifest }` through `parseProgramManifest` (fail-closed — a host-escaping / invalid manifest is never written), then writes `vectant.programs.json` to the workspace via the collab-server scaffold plumbing with `overwrite: true`. Returns `{ written }`.
5. **Frontend** — a `Generate manifest` button in `StoreView` (beside "Install from manifest", owner/admin only); a `GenerateManifestDialog` component (editable `<textarea>` prefilled with the pretty-printed manifest, live-validated, Save + Cancel, and a "manifest already exists — overwrite?" confirm); client fns `generateManifest(slug)` and `saveWorkspaceManifest(slug, manifest)`.

### Data flow
`button → generateManifest(slug) → POST generate-manifest → [collab context] + [ai-engine Gemini] → validate → { manifest, valid, errors } → dialog (edit) → Save → POST manifest → re-validate → collab write (overwrite) → toast`.

## Feature B — AI-engine manifest awareness (build after A)

- Add a concise **`vectant.programs.json` reference** — the field schema (`packageId`, `version`, `runtimeType` ∈ web/cli/tui/background/gui/container, `install[]`, `launch`, `ports[]`, `permissions[]` from `KNOWN_SCOPES`, host-escape prohibitions) + 1–2 worked examples — into the ai-engine base system context (`prompts.py`).
- Any AI surface routed through the engine (chat/CLI/terminal) then understands + can author manifests.
- Test: assert the reference block appears in the built base prompt.
- The external `synthi-mcp` tool exposing this over MCP is out of scope here (separate repo / later).

## Security + correctness invariants (test-pinned)

- The Save route **re-validates server-side** through `parseProgramManifest` — a generated manifest that fails schema / scope / host-escape is never written (fail-closed). The client preview validation is convenience, not the gate.
- `generate_manifest` is **fail-closed**: provider/parse failure → `{ error }`, never a partial/garbage manifest silently saved.
- Generate + save routes are **owner/admin-only** (`canWriteScope`), consistent with the other publishing routes.
- Save **never silently overwrites** — `overwrite` is explicit + client-confirmed.
- The ai-engine endpoints stay **internal-token-gated** like the risk-review endpoint.

## Reuse / touchpoints

- `parseProgramManifest` (validation), `aiReviewer.js` / `internalAiAuth.js` (AI client pattern), `program_review.py` (Python endpoint shape), `runtimeClient.scaffoldProgram` + the collab-server `/scaffold` + `/detect` file-read (context gather + write), `StoreView.jsx` / `programsClient.js` (frontend), `prompts.py` (Feature B).

## Out of scope (later)

- The external `synthi-mcp` tool/resource exposing the schema over MCP (needs that repo).
- Multi-file scaffolding / generating the app itself (only the manifest).
- Streaming the generation; iterative "refine this manifest" chat.
- Non-Gemini providers (the engine factory is Gemini-only anyway).

## Phasing

- **Phase A:** `program_manifest_gen.py` + endpoint → collab context-gather (extend `/detect` read) + scaffold `overwrite` → Next.js generate + save routes → `GenerateManifestDialog` + button + client fns.
- **Phase B:** manifest reference in `prompts.py` + test.
