# E2E test guide — program↔workspace file sync (local hybrid)

State as handed off (all verified):
- Images built: `vectant-gui-base:dev`, `vectant-dbeaver:dev`, `vectant-runtime:local`.
- Stack up (`docker compose ps` all Up; postgres/redis/y-sweet healthy; frontend 200, collab 200).
- collab-server rebuilt with the slice code; **`SYNTHI_FS_POLL_ENABLED=1`** (poll fallback on),
  continuous flush on by default. Verified live: `/app/continuousFlushService.js` present,
  `fsWatcherService` has the poll fns, watcher runs on the per-user dir.
- frontend rebuilt with the Task-1 recipe mount + `NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS=1`.
- DB seeded: 8 `@vectant/*` programs. `@vectant/dbeaver` launch in the DB =
  `docker run --rm --name vectant-dbeaver -p 6901:6901 -v "$PWD":/workspace -w /workspace vectant-dbeaver:dev`
  (the `-v "$PWD":/workspace -w /workspace` mount is present — Task 1 live).
- Local override (gitignored, not committed): `docker-compose.override.yml` sets the poll flag +
  points the frontend's `DATABASE_URL` at the local Postgres.

Already PROVEN (no UI needed) — mechanism e2e with the real images + the slice code, in the
production-equivalent topology (two containers sharing a volume, like collab-server + the program
pod on a PVC):
- program→editor: the real DBeaver container wrote `/workspace/from-dbeaver.sql` to a shared volume →
  the polling fallback (in a separate container) detected it → emitted the `fs-change` events the
  editor pipeline consumes (Y-Sweet invalidation + tree refresh).
- editor→program: the real `continuousFlushService` flushed editor content to `/workspace` on save →
  the DBeaver container read it back with exact content.

## 2026-06-22 — DBeaver GUI stream fix (verify the UI is usable)

The noVNC stream now routes its websocket through the `/wsport/<slug>/<port>/websockify` proxy
instead of the root `/websockify` (which 1006'd and made DBeaver's UI unusable). Frontend rebuilt
with this fix (`programSessionClient.getProgramSessionAppUrl` `vncPath` option + `ProgramSessionPanel`
passing `vncPath: true`) and the auth bypass baked in.

Current state (verified this session):
- Stack up; frontend 200, workspace page 200 (no login redirect), collab 200.
- DBeaver installed for workspace `rfxr7ism` (install `cmqo1a5aq0006q101ws0o6ebd`, status `installed`).
- `vectant-dbeaver:dev` image cached inside the runtime → relaunch is fast, no manual `docker load`.
- Inner DBeaver session was wiped by an overnight runtime restart → must click Launch again.

Test (browser):
1. Open http://localhost:3000/workspace/rfxr7ism (loads straight in; bypass on).
2. Programs panel → DBeaver → **Launch**. Wait ~30–60s for the runtime to start DBeaver.
3. Open the **App** tab. A KasmVNC sign-in popup appears → enter `vectant` / `vectant123`
   (that popup is KasmVNC's own basic auth — the separate credential-handoff slice; expected).
4. Success = DBeaver's desktop renders **and stays connected** (no immediate 1006 disconnect) and is
   clickable. Ignore the session-status label if it shows CRASHED — known collab-side tracking quirk;
   judge by whether the App tab is interactive.

Known local-only caveat (not part of this test): in the local hybrid runtime DBeaver runs as uid 1000
but `/workspace` is owned by uid 1001, so DBeaver can't *write* new files to /workspace here.
Program→editor writes were proven separately by writing as the runtime root. Prod Sysbox runs
root-in-userns, so there's no uid mismatch there.

## How to test the full UI launch yourself

1. Open http://localhost:3000. Sign in with Google (gives a stable per-user identity, matching how
   the repo dir is named) — or rely on the workspace auth bypass. Open or create a workspace.
2. Open the **Programs** activity-bar panel → install **DBeaver** (Marketplace → Install) → **Launch**.
3. First launch spawns the per-workspace runtime container but DBeaver's image isn't in that
   container's (isolated, rootless) docker yet, so the run fails. Load it once (PowerShell):
   ```powershell
   $rt = docker ps --filter "label=vectant/runtime=workspace-runtime-local" --format "{{.Names}}" | Select-Object -First 1
   docker save vectant-dbeaver:dev | docker exec -i --user rootless $rt docker load
   ```
   (~668MB; ~1-2 min. The runtime container is created on the first launch attempt; if `$rt` is empty,
   click Launch once, wait ~20s for it to appear, then run the load.)
4. Re-launch DBeaver. The App tab streams the KasmVNC desktop with DBeaver.

## The round-trip

- **program → editor:** create a file under `/workspace` from the program. Either use DBeaver's SQL
  editor → Save As → `/workspace/from-dbeaver.sql`, or from a shell:
  ```powershell
  $db = docker ps --filter "name=vectant-dbeaver" --format "{{.ID}}" | Select-Object -First 1
  docker exec $db sh -c "echo 'SELECT 1;' > /workspace/from-dbeaver.sql"
  ```
  → within ~1.5s the editor file tree shows `from-dbeaver.sql`; open it → correct content.
- **editor → program:** edit + save a file in Monaco. The continuous flush writes it to
  `repos/<slug>/<userId>` on the shared volume; confirm the program sees it:
  ```powershell
  docker exec $db cat /workspace/<that-file>
  ```

## Notes
- Want it pre-loaded? Tell me the workspace slug you'll use and I'll pre-spawn its runtime container
  and load the image so step 3 is unnecessary.
- MCP exec/launch tools won't work locally (need the Sysbox pod) — expected, out of scope.
- Path alignment (spec §6), confirmed live: watcher (`resolveWorkspaceCwd`), flush
  (`getEffectiveRepoPath`), and the program `/workspace` mount all resolve to `repos/<slug>/<userId>`,
  keyed by the workspaceUserId.
