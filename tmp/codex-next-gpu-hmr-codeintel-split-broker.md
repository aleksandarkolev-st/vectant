# Codex Next Session Handoff - GPU HMR CodeIntel Split Broker

Date: 2026-05-22

## Operating Instructions

Work from the repo root:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
```

Do not hardcode fixture behavior, renderer names, file names, model quirks, or
specific failure strings just to make validation pass. GPU HMR must be
contract-driven:

```text
build metadata + CodeIntel authority
  -> target-scoped projection
  -> broker-issued scope
  -> cited role generation context
  -> immutable candidates
  -> deterministic verifiers
  -> atomic promotion
```

Use the existing CodeIntel/RAG system. Do not build a second index or copied RAG
cache under GPU HMR. GPU HMR may persist compact projections, identities,
evidence refs, packages, manifests, verifier reports, and promotion records.

When code changes are made, rebuild the affected container before validation:

- Python ai-engine, prompts, verifier code, CodeIntel/RAG code: rebuild
  `ai-engine`.
- Rust worker, compile/reload/runtime code: rebuild `worker`.
- UI compile payload or preview changes: rebuild `frontend`.
- MCP harness changes: rebuild `mcp` or run the script locally if that is the
  chosen path.

Use MCP validation for user-visible proof. Compile logs alone are not enough.

## Current Repo State At Handoff

Observed locally:

```text
branch: feature/gpu-hmr-prod-orchestrator
dirty file: docs/GPU_HMR_RAG_SPLIT_IMPROVEMENT_PLAN.md
```

Recent commits observed:

```text
2256be05 checkpoint
5ea27a05 checkpoint
094ea886 test
05636e17 fix(gpu-hmr): harden real repo split validation
50a1aad9 fix(gpu-hmr): preserve deterministic ROCm edit paths
93681f9a fix(gpu-hmr): stabilize large gui validation
fe0d7272 fix(gpu-hmr): preserve real repo device reload path
4df20656 fix(gpu-hmr): gate runner reuse on planner policy
```

Run first in the next session:

```powershell
git status --short
git log --oneline -8
docker compose ps
```

If `docs/GPU_HMR_RAG_SPLIT_IMPROVEMENT_PLAN.md` is still dirty, review and
commit it before starting implementation work.

## Source-Of-Truth Documents

Read these in this order:

```text
docs/GPU_HMR_PROD_NEXT.md
docs/GPU_HMR_RAG_SPLIT_IMPROVEMENT_PLAN.md
docs/GPU_HMR_IN_DEPTH_FLOW.md
tmp/gpu_prod_next.md
tmp/codex-next-gpu-hmr-scale-validation.md
```

Purpose:

- `docs/GPU_HMR_PROD_NEXT.md`: approved production roadmap and safety contract.
- `docs/GPU_HMR_RAG_SPLIT_IMPROVEMENT_PLAN.md`: next-branch architecture for
  CodeIntel projections, split broker, immutable candidates, and promotion.
- `docs/GPU_HMR_IN_DEPTH_FLOW.md`: current end-to-end GPU HMR flow.
- `tmp/gpu_prod_next.md`: previous production hardening handoff.
- `tmp/codex-next-gpu-hmr-scale-validation.md`: container commands, MCP
  harness usage, screenshot proof style, and historical validation context.

Do not let the older `tmp/` docs override the current architecture plan. They
are operational references.

## Current Architecture Decision

The next major branch should be:

```text
feature/gpu-hmr-codeintel-split-broker
```

The current production-orchestrator/stabilization branch should not keep
absorbing this work unless explicitly requested. The split broker work changes
the architecture and should get its own review surface.

The architecture intent is:

```text
CodeIntel index + build metadata authority
  -> target-scoped projection
  -> phased readiness
  -> broker-issued role scope packages
  -> deterministic RAG-backed role context packages
  -> AI proposals inside explicit scope
  -> immutable candidate artifacts
  -> deterministic verifier promotion
  -> direct non-agentic HMR where locally provable
```

Authority boundaries:

- CodeIntel and build metadata decide what source and target facts exist.
- Broker decides what each generated role may see, include, adapt, and write.
- RAG provides cited context and explanations, not safety decisions.
- AI proposes only inside a role generation package.
- Verifiers and Arbiter decide whether a candidate can compile, run, reload,
  and be promoted.

## Immediate Work For Next Session

Start with Milestones 1 to 3 from
`docs/GPU_HMR_RAG_SPLIT_IMPROVEMENT_PLAN.md`.

### Milestone 1: Schemas And Identity

Implement schemas and hash helpers first. Do not start AI generation changes
until identity/canonicalization is settled.

Required objects:

- selected target identity
- source split identity
- compile candidate identity
- runtime verification identity
- AI generation identity
- promotion identity
- role scope package
- role generation package
- candidate spec manifest
- candidate verification record
- accepted promotion record
- verifier report
- reason-code registry entry
- source-to-generated mapping
- accepted pointer

Hard rules:

- `generatedArtifactHash` is generated role files only.
- `candidateSpecManifestHash` is immutable spec only.
- `candidateVerificationRecordHash` stores verifier/state history separately.
- `acceptedPromotionRecordHash` is the content hash of the promotion record.
- Candidate state must not mutate the candidate spec manifest.
- `candidateId` should be deterministic where possible, but lookup must work by
  `candidateSpecManifestHash`.

Canonical hashing must be shared by all producers:

- canonical JSON UTF-8 serialization
- sorted object keys
- explicit array ordering rules
- workspace-relative normalized paths
- Unicode NFC normalization
- line ending normalization
- timestamp inclusion/exclusion rules
- environment variable sorting and allowlisting
- symlink resolution policy
- case-sensitivity/collision policy

### Milestone 2: Compile-Aware Metadata

Separate target resolution from metadata enrichment.

Target resolution order:

1. explicit user/project target config
2. CMake File API
3. `compile_commands.json`
4. inferred fallback
5. unsupported

Metadata enrichment after target/compile command is known:

1. compiler dependency scan
2. toolchain probe
3. runtime probe
4. generated header content scan
5. link/runtime library resolution

Minimum evidence by operation:

- preflight/projection: selected target identity or blocking ambiguity reason,
  `targetInputFileHash`, CodeIntel generation, build metadata identity
- scope/generation: CodeIntel structural evidence, selected target metadata,
  compile-commands-backed include/link roots, no regex-only ownership
- compile: selected compile command, compiler dep scan or compile-commands
  include resolution, generated header content hash, toolchain probe hash
- promotion for ABI-sensitive paths: compiler AST or generated ABI probe,
  vendor compiler artifact evidence where available, launch-mode-specific ABI
  verifier report

### Milestone 3: Target-Scoped Projection

Create a compact projection over CodeIntel/build metadata. It must not copy
large retrieved chunks, summaries, or source text.

Projection stores:

- source split identity hash
- CodeIntel generation
- build metadata hash
- selected target identity
- source sets
- compact retrieval evidence refs
- build/toolchain evidence refs
- reason codes

Projection must fail closed if referenced generations or hashes mismatch.

## API Shape To Preserve

The architecture doc currently requires:

```text
POST /gpu-hmr/readiness
POST /gpu-hmr/projections
GET  /gpu-hmr/projections/{hash}
POST /gpu-hmr/prepare-candidate
GET  /gpu-hmr/candidates?selectedTargetIdentityHash=...
GET  /gpu-hmr/candidates/{id}
GET  /gpu-hmr/candidates/{id}/trace
POST /gpu-hmr/candidates/{id}/verify
POST /gpu-hmr/candidates/{id}/promote
POST /gpu-hmr/candidates/{id}/cancel
POST /gpu-hmr/candidates/{id}/diagnose
GET  /gpu-hmr/jobs/{id}
GET  /gpu-hmr/jobs/{id}/trace
POST /gpu-hmr/jobs/{id}/cancel
GET  /gpu-hmr/accepted/current
```

Mutating calls require an idempotency key. Async operations return a job ID.
Resource lookup should use hashes, not display names.

## Docker And Container Commands

AMD/ROCm stack from repo root:

```powershell
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:SYNTHI_GEMINI_MODEL='gemini-3.1-flash-lite-preview'
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml build ai-engine worker frontend mcp
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml up -d --force-recreate redis postgres y-sweet collab-server signaling-server ai-engine ai-gateway frontend worker coturn mcp
```

Restart ai-engine after Python, prompt, CodeIntel, RAG, verifier, or API work:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml build ai-engine
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml up -d --no-deps --force-recreate ai-engine
```

Restart worker after Rust compile/reload/runtime work:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml build worker
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml up -d --no-deps --force-recreate worker
```

Restart frontend after UI or compile payload work:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml build frontend
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml up -d --no-deps --force-recreate frontend
```

Restart MCP after harness/tool changes:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml build mcp
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml up -d --no-deps --force-recreate mcp
```

Watch logs:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml logs -f worker
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml logs -f ai-engine
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml logs -f frontend
docker compose -f docker-compose.yml -f docker-compose.gpu-amd.yml logs -f mcp
```

Stop stack:

```powershell
docker compose down
```

## MCP Validation Rules

MCP tools matter. Use them for visible proof:

- `synthi_compile`: trigger real compile path.
- `synthi_wait_hmr`: wait for compile/HMR terminal events.
- `synthi_screenshot`: capture live preview.

Correct loop:

```text
seed workspace
  -> synthi_compile
  -> synthi_wait_hmr
  -> synthi_screenshot
  -> edit user/device source
  -> synthi_wait_hmr
  -> synthi_screenshot
  -> inspect worker/ai-engine logs
```

Do not call a run passing if:

- screenshot is black/blank/missing
- HMR is a full restart disguised as device-only HMR
- generated roles are required as normal user files
- logs show stale cache reuse after code/prompt/verifier changes
- target selection is ambiguous but generation proceeds

## Existing Harnesses

Scripts:

```text
mcp/synthi-mcp/scripts/gpu-hmr-test.mjs
mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
mcp/synthi-mcp/scripts/gpu-hmr-dynamic-workspace-test.mjs
mcp/synthi-mcp/scripts/gpu-hmr-scale-validation.mjs
mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs
```

Natural scale validation command:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp
$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='auto'
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:SYNTHI_GEMINI_MODEL='gemini-3.1-flash-lite-preview'
$env:SYNTHI_SCALE_RENDER_BACKEND='glfw'
$env:SYNTHI_SCALE_CMAKE_TARGET_MODE='single'
$env:SYNTHI_SCALE_HMR_DELTA_MODE='natural_user_delta'
$env:SYNTHI_SCALE_VALIDATION_PROFILE='natural'
$env:SYNTHI_SCALE_TARGET_FILE_COUNT='1200'
$env:MCP_CONTAINER='vectant-ade-mcp-1'
$env:WORKER_CONTAINER='vectant-ade-worker-1'
$env:AI_ENGINE_CONTAINER='vectant-ade-ai-engine-1'
$env:MCP_SIGNALING_URL='ws://signaling-server:9000'
$env:SYNTHI_SYNC_TO_GCS='0'
node scripts/gpu-hmr-scale-validation.mjs
```

Multi-target/ambiguous target checks:

```powershell
$env:SYNTHI_SCALE_CMAKE_TARGET_MODE='multi'
node scripts/gpu-hmr-scale-validation.mjs

$env:SYNTHI_SCALE_CMAKE_TARGET_MODE='ambiguous'
node scripts/gpu-hmr-scale-validation.mjs
```

Renderer matrix knobs supported by the scale harness:

```text
SYNTHI_SCALE_RENDER_BACKEND=sdl2
SYNTHI_SCALE_RENDER_BACKEND=glfw
SYNTHI_SCALE_RENDER_BACKEND=raylib
SYNTHI_SCALE_RENDER_BACKEND=sfml
SYNTHI_SCALE_RENDER_BACKEND=imgui_sdl
SYNTHI_SCALE_RENDER_BACKEND=imgui_glfw
```

Dependency-unavailable cases should report preflight/blocking diagnostics, not
pass.

Real ROCm repo validation:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp
$env:SYNTHI_GPU_VENDOR='rocm'
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:SYNTHI_GEMINI_MODEL='gemini-3.1-flash-lite-preview'
$env:MCP_CONTAINER='vectant-ade-mcp-1'
$env:WORKER_CONTAINER='vectant-ade-worker-1'
$env:AI_ENGINE_CONTAINER='vectant-ade-ai-engine-1'
$env:SYNTHI_SYNC_TO_GCS='0'
node scripts/gpu-hmr-real-rocm-repo-validation.mjs
```

Known real project already exercised:

```text
project: HIPRT-Path-Tracer
repo: https://github.com/TomClabault/HIPRT-Path-Tracer.git
commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
current result: split reached generated GUI compile, failed on unavailable ImGui dependency
```

Treat that as dependency/render ownership evidence, not production success.

## Useful Logs And Artifacts

Existing logs were observed under:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/
mcp/synthi-mcp/.gpu-hmr-test-artifacts/
```

Recent log names seen:

```text
real-rocm-results.json
real-rocm-results.txt
scale-validation-results.json
scale-validation-results.txt
scale-validation-sdl2-*-results.json
scale-validation-sdl2-*-results.txt
```

Record for every validation run:

- workspace slug
- branch and commit
- dirty worktree status
- Docker compose files used
- container names/IDs or image IDs
- whether worker/ai-engine were rebuilt/restarted
- model name
- GPU vendor and arch
- renderer backend
- target resolution mode
- first compile terminal result
- HMR terminal result
- `synthi_wait_hmr.elapsedMs`
- screenshot paths and non-black/changed-pixel proof
- worker/ai-engine log markers
- reload plan and Arbiter decision if available

## Model Notes

Current harness defaults have used:

```text
SYNTHI_GEMINI_MODEL=gemini-3.1-flash-lite-preview
```

The user mentioned `gemini-3.5-flash` and large output limits. Do not assume it
is available in the configured provider. If testing a new model:

1. run a tiny seed-only project first
2. record the exact model name and provider response
3. then try scale/real-repo validation

Do not tune prompts to one model-specific failure unless the change is a
generic contract improvement.

## Implementation Guardrails

Allowed:

- parser/compile-metadata-backed classification
- source-derived mappings
- generic schema/identity/projection/verifier contracts
- generic role contract repairs that are mechanically safe
- deterministic verifier rejection with reason codes
- better prompt contracts that ask AI to honor broker-issued scope

Not allowed:

- `if SDL2 then...` style generation paths
- fixture symbol hacks
- marker-only code to appease verifiers
- generated files in normal user tree
- fallback to full split without reason and policy
- AI certifying ABI, dependency, or runtime safety
- RAG certifying safety
- regex-only safety decisions

## Commit Discipline

Keep commits narrow.

Suggested sequence:

```text
docs(gpu-hmr): record codeintel split broker handoff
feat(gpu-hmr): add canonical identity schemas
test(gpu-hmr): lock canonical hash fixtures
feat(gpu-hmr): add candidate spec and verification records
feat(gpu-hmr): add reason code registry
feat(gpu-hmr): add target metadata resolver shell
feat(gpu-hmr): add target scoped projection shell
test(gpu-hmr): reject stale projection identities
```

Do not batch schema work, API work, verifier work, and validation harness work
into one commit.

## Final Reporting Expectations

When handing back:

- state what changed
- list commits
- list exact validation commands
- summarize pass/fail with artifact paths
- call out any unproven backends or blocked dependencies
- avoid "production ready" wording unless the matrix is current and complete

