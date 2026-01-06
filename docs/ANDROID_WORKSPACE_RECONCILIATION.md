# Android / Gradle Workspace Reconciliation (Write‑Through Builds)

## Problem
Synthi’s Android compilation runs inside a stateless worker:

1. Worker downloads the user workspace to a temporary build directory.
2. Gradle/Android tooling generates required files (wrapper, `local.properties`, build outputs, intermediates).
3. The build finishes, but generated artifacts stay only inside the temp directory.

This breaks:

- Emulator testing (next run starts “cold”).
- Incremental builds (no persisted wrapper/config/build outputs).
- User visibility of generated Gradle/Android configuration.

## Goal
Make Android/Gradle auto-generated files persist back into the *real* Synthi workspace deterministically, without requiring any user manual setup or project-type metadata.

Key requirements:

- No manual CLI interaction.
- No assumption Android files already exist.
- Infer “Android intent” only from workspace file presence (already done by the mobile pipeline’s React Native/Gradle detection).
- Worker remains stateless.
- After build, diff generated files vs the original workspace snapshot.
- Stream back only new/modified files over WebRTC.
- IDE applies the writes atomically (batch) into the real workspace.

## Architecture (Two-Phase Build)

### Phase 1 — Workspace Hydration
- Worker downloads workspace to a temp directory (existing behavior).
- Worker captures a **pre-build snapshot** of relevant paths (hashes for known Gradle/Android artifact locations).

### Phase 2 — Build + Reconciliation
- Worker runs Gradle/Android build tooling in the temp workspace.
- After the build attempt (success **or failure**), worker:
  - Scans the configured artifact set in the temp workspace.
  - Computes hashes and diffs vs the pre-build snapshot.
  - Streams back only new/changed artifacts over WebRTC (`build-log` channel).
- IDE receives the stream, reassembles chunked payloads, and applies them to the real workspace via a **single batch write** to collab-server.

## File-flow diagram

```text
┌──────────────┐           ┌──────────────────────────┐
│  IDE Browser  │  WebRTC   │  Rust Worker (stateless) │
│  (Next.js)    │◄────────► │  downloads workspace      │
└─────┬────────┘           └───────────┬──────────────┘
      │                                 │
      │ collab-server (workspace repo)  │ temp workspace dir
      │                                 │
      ▼                                 ▼
┌──────────────────┐          ┌──────────────────────────┐
│ collab-server repo│          │ /tmp/workspace/<slug>/   │
│ (source-of-truth) │          │  + Gradle-generated files │
└────────┬─────────┘          └───────────┬──────────────┘
         │                                 │
         │ batch write                      │ snapshot + diff
         │ (base64/utf8)                    │ stream file chunks
         ▼                                 ▼
┌──────────────────┐          ┌──────────────────────────┐
│ persisted workspace│◄────────│ workspace-reconcile msgs │
│ (repo + optional   │ WebRTC  │ over build-log channel   │
│  GCS mirror)       │          └──────────────────────────┘
└──────────────────┘
```

## Sync rules (Ownership + Safety)

### Always synced
- `gradlew`
- `gradlew.bat`
- `gradle/wrapper/*`
- `local.properties`

### Persisted when generated (create-only)
These can be user-authored. To avoid clobbering user intent, we only write them back if they **did not exist** in the original snapshot:

- `settings.gradle`, `settings.gradle.kts`
- `build.gradle`, `build.gradle.kts`

### Configurable sync (build outputs)
Optional directories (disabled by default):

- `build/`
- `app/build/`

Enable via worker environment:

- `SYNTHI_SYNC_BUILD_OUTPUTS=1`

Safety caps (defaults):

- `SYNTHI_SYNC_MAX_FILES=200`
- `SYNTHI_SYNC_MAX_TOTAL_BYTES=26214400` (25 MiB)
- `SYNTHI_SYNC_MAX_FILE_BYTES=5242880` (5 MiB)

These caps prevent runaway sync (Gradle caches/intermediates can explode in size).

## WebRTC reconciliation protocol
Messages are JSON sent over the existing `build-log` datachannel.

- `workspace-reconcile-begin`
  - Includes a `summary` object describing limits and planned actions.
- `workspace-file-begin`
  - Includes `path`, `sha256`, `size`, `mode` (`create`/`overwrite`), `total_chunks`, and a `data` hint (`text`/`binary`).
- `workspace-file-chunk`
  - Contains `idx` and `data` (base64 chunk).
- `workspace-file-end`
- `workspace-reconcile-end`

## Concrete implementation

### Worker (Rust)
- Pre-build snapshot: `take_snapshot(workspace_root)`
- Post-build diff + stream: `reconcile_and_stream(log_dc, session_id, workspace_root, snapshot)`

Files:
- Worker reconciliation logic: backend/synthi-webrtc-compiler/worker/src/workspace_reconcile.rs
- Hooked into mobile job after Gradle build (success or failure): backend/synthi-webrtc-compiler/worker/src/mobile_job.rs

### IDE (Next.js)
- Compiler client intercepts reconciliation messages and dispatches a dedicated browser event:
  - `synthi:workspace-reconcile`

- Workspace page listens for these events, assembles chunks, then applies all files via one call:
  - `gitClient.writeFilesBatch(slug, files, { syncToGcs: true })`

Files:
- WebRTC message dispatch: synthi/src/services/compilerClient.js
- Apply logic: synthi/src/app/workspace/[slug]/page.jsx
- Batch API client: synthi/src/services/gitClient.js

### collab-server
Adds an action `write-files-batch` that writes many files to the repo and (optionally) mirrors to GCS per file.

Files:
- Route handler: backend/collab-server/server.js
- Implementation: backend/collab-server/gitService.js

## Edge cases

- Partial/failed builds: reconciliation still runs; wrapper/config created early is still persisted.
- Corrupted Gradle cache / gigantic outputs: optional build outputs are off by default, and hard size/file caps prevent over-sync.
- Safety against overwriting user files: `build.gradle*` and `settings.gradle*` are create-only; they won’t overwrite existing user-authored build scripts.
- Binary artifacts: transported as base64 chunks and written via collab-server as raw bytes.
