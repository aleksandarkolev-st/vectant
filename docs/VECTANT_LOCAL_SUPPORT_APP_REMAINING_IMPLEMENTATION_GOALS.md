# Vectant Local Support App Remaining Implementation Goals

Status baseline: current implementation is approximately 44% complete. Treat the existing Rust helpers, static transparency UI, acceptance tables, and CI mapping as partial evidence only. A goal is complete only when the feature works end-to-end through the desktop app, local daemon, cloud control plane, browser UI, audit storage, and tests that exercise the real path.

## Evidence update — 2026-07-13

Verified in the current worktree:

- Native backend, desktop, local-support web/API, Chromium desktop, and Chromium live-daemon gates pass for the exercised scenarios.
- Native clippy gates, the production Next build, and the focused web test gate pass; Chromium Local Support UI/runtime coverage passes 15/15.
- Preview enforcement is loopback-only across native IPC, the Rust gateway, cloud port persistence, relay control, and transparency projections. Agent reads, interaction, response bodies, screenshots, console data, state-changing methods, and persistent approvals remain disabled.
- Local sent-history projections now carry the recorded relay byte count and redaction count instead of placeholder zeroes.
- The Windows NSIS installer was built and passed install, loopback health/protected-status, and uninstall smoke checks locally.
- Windows installer downgrade rejection is explicit in the Tauri bundle configuration and enforced by the signed-release workflow guard; the release build accepts the configuration.
- Live Chromium E2E against the host-mapped PostgreSQL container passed cloud policy/admin controls and the Rust relay path: poll, review outcome, encrypted payload upload, denied-secret alert, session revocation, and payload purge.

Still unverified or blocked:

- The local release build cannot produce a signed updater artifact without `TAURI_SIGNING_PRIVATE_KEY`; the generated installer was `NotSigned`.
- Production certificate signing, updater tamper/downgrade/revocation verification, and release-branch controls require their configured CI secrets/infrastructure.
- Full repository tests are not a Local Support release proof; unrelated existing failures remain outside this feature’s focused gates.

## MVP Blockers

### Goal 1: Ship the Real Desktop/Tray App Shell

**Objective:** Replace the CLI-only prototype with a hardened desktop/tray app that users can operate safely.

**Scope:** Choose Tauri unless a later architecture review explicitly justifies another native shell. Implement workspace picker, pairing UI, local activity UI, approval modals, port approval UI, pause/resume/disconnect, update-required state, and error states. Split privileged work across UI, local API daemon, scanner/file adapter, port adapter, and updater processes. Enforce desktop CSP, schema-validated IPC, no renderer filesystem access, and no renderer access to tokens or device keys.

**Acceptance criteria:**

- User can install/run the app, pick one workspace, pair one support session, pause, disconnect, approve/deny file/log sends, approve/revoke a port, export/delete history, and see all state changes in the desktop UI.
- The old printed development bearer token flow is removed from production builds.
- Renderer compromise cannot directly read files, tokens, device private keys, keychain entries, local logs, or arbitrary paths.
- IPC exposes only narrow commands with schema validation and user-visible denied events for invalid or dangerous commands.
- App quits/disconnects revoke session approvals and approved ports.

**Key files/areas:** `backend/vectant-local-support-app/`, new Tauri/native shell package, `backend/vectant-local-support-app/src/ipc.rs`, `backend/vectant-local-support-app/src/lifecycle.rs`, installer/update packaging, desktop CSP/config.

**Tests required:** Desktop E2E for workspace pick, pairing, approval, pause/disconnect, port revoke, history export/delete; IPC fuzz/negative tests; renderer filesystem/token access tests; process-boundary tests; install/uninstall smoke tests on Windows first.

**Blockers/dependencies:** Shell choice, desktop signing pipeline, OS storage decision for device identity, cloud pairing API contract.

### Goal 2: Implement Production Pairing and Session Binding

**Objective:** Replace development token behavior with cryptographic browser-cloud-local pairing and request-level authorization.

**Scope:** Implement short-lived pairing code, browser/local fingerprint confirmation, device key proof, cloud challenge, consent receipt binding, OS-owned secure storage for device identity where appropriate, session TTL, replay protection, and revoke semantics. Bind every request to session, workspace, actor, capability, request id, expiry, policy version, and device proof when required.

**Acceptance criteria:**

- A random website cannot pair or call non-health local APIs.
- Expired, replayed, mismatched, wrong-account, wrong-org, wrong-workspace, wrong-device, vulnerable-version, and revoked-session requests fail locally with zero bytes sent.
- Pairing consent receipt records session id, account/org, device fingerprint, workspace, capabilities, policy version, expiry, and user confirmation.
- Device identity persists only through approved OS-owned storage and can be reset/revoked.
- Request validation happens in both cloud control plane and local app; local app remains final authority.

**Key files/areas:** `backend/vectant-local-support-app/src/pair.rs`, `backend/vectant-local-support-app/src/session.rs`, `backend/vectant-local-support-app/src/http.rs`, `synthi/src/app/api/local-support/request-envelope/`, `synthi/src/lib/local-support/controlPlane.js`.

**Tests required:** Pairing E2E across browser, cloud API, and desktop; malicious website localhost call; expired code; bad fingerprint; device-proof failure; replay; session revoke; min-version and blocklist enforcement.

**Blockers/dependencies:** Cloud session API, device storage library, signed app identity/build metadata, admin policy service.

### Goal 3: Build Cloud Relay and Control Plane Integration

**Objective:** Connect the local app to Vectant through an outbound-only relay with cloud authorization and audit summaries.

**Scope:** Local app initiates an outbound connection to Vectant. Cloud authorizes support session, account/org, capabilities, minimum app version, kill switches, request envelopes, and policy version. Keep browser-management, cloud-relay, local API, and desktop IPC surfaces separate. Cloud logs only scrubbed summaries and hashes, never raw local bodies.

**Acceptance criteria:**

- No inbound network exposure beyond loopback local API.
- Cloud refuses unauthorized accounts/orgs, disabled orgs, disabled pairing, disabled preview, blocked vulnerable app versions, and stale protocol versions.
- Relay forwards only signed/nonce-bound envelopes and receives only minimized responses.
- Cloud audit entries contain actor, request id, capability, target display/hash/classification, decision, bytes, redaction count, policy/scanner versions, and no raw body.
- Control-plane and data-plane logs are distinguishable.

**Key files/areas:** `synthi/src/app/api/local-support/`, `synthi/src/lib/local-support/controlPlane.js`, new cloud relay service/API routes, backend relay client, security event route.

**Tests required:** Relay integration tests; cloud authorization negative tests; scrubbed audit snapshot tests; kill switch/min-version tests; relay disconnect/reconnect tests.

**Blockers/dependencies:** Auth/session model for support sessions, org policy schema, cloud audit storage, relay transport decision.

### Goal 4: Make Transparency UI Live and Truthful

**Objective:** Replace mock/static transparency state with live product state sourced from the local app and cloud session.

**Scope:** Connect the web and desktop transparency screens to real session state, workspace inventory, sent payloads, blocked requests, redactions, local ports, approvals, exports, deletes, and policy state. Remove demo constants such as `sess_7K9`, fake workspace paths, fake port approvals, and static evidence tables that imply completion.

**Acceptance criteria:**

- The UI shows the real device, account/org, session, workspace, policy version, scanner version, connection status, and permission mode.
- Inventory distinguishes "available locally", "approval required", "blocked locally", and "sent to Vectant" from real payload history.
- Sent history is generated only after a successful send and includes actor, request id, target, classification, hash, redactions, bytes, reason, and time.
- Blocked and denied requests are visible with zero bytes sent.
- Export/delete actions operate on local product storage, not static arrays.
- Release evidence UI marks items as partial until live implementation and E2E proof exist.

**Key files/areas:** `synthi/src/components/local-support/LocalSupportTransparency.jsx`, `synthi/src/lib/local-support/acceptance.js`, `tests/local-support-transparency.spec.ts`, desktop UI screens, backend status/audit endpoints.

**Tests required:** Browser E2E against a running local app; desktop UI E2E; mock-data absence tests; export content tests; UX acceptance tests proving users can answer available-vs-sent and preview-vs-agent-read questions.

**Blockers/dependencies:** Desktop shell state API, local audit product storage, cloud relay session state.

### Goal 5: Complete Review-Before-Send and Scanner Production Behavior

**Objective:** Ensure source/log/sensitive data cannot leave the machine without local classification, redaction, and user consent.

**Scope:** Implement approval queues for source/log reads, file classification, content-type sniffing, sparse file handling, generated artifact blocking, binary/archive blocking, confidence handling, TOCTOU revalidation, consent receipts, deny/revoke behavior, and no-raw-secret guarantees across logs, telemetry, exports, errors, and tests.

**Acceptance criteria:**

- Source and log reads queue for review unless classified as low-risk metadata allowed by policy.
- Consent receipts include request id, actor, target path/port, capability, classification, scanner version, policy version, content hash, scope, expiry, and approval id.
- Deny/revoke immediately prevents send and invalidates queued sends.
- Scanner failure, uncertain classification, TOCTOU mismatch, binary/archive/sparse/generated artifact, or path escape denies locally.
- No raw secrets appear in local logs, cloud logs, exported history, telemetry, test output, or error messages.

**Key files/areas:** `backend/vectant-local-support-app/src/workspace.rs`, `backend/vectant-local-support-app/src/scanner.rs`, `backend/vectant-local-support-app/src/audit.rs`, approval queue/storage modules, UI approval modals.

**Tests required:** Secret fixture suite; generated/binary/archive/sparse fixtures; symlink/junction/TOCTOU tests; approval queue E2E; deny/revoke race tests; log/export/telemetry secret scans.

**Blockers/dependencies:** Product audit storage, scanner fixture corpus, desktop approval UI, cloud request envelope binding.

### Goal 6: Implement the Real Localhost Preview Gateway

**Objective:** Turn preview helpers into a working browser-only proxy/gateway that cannot become SSRF, credential exfiltration, or AI read access.

**Scope:** Build host-based preview routing, preview token validation, loopback-only request forwarding, streamed responses with size/flow control, request/response header rewriting, redirect rewriting/blocking, service-worker blocking, rate limiting, port identity binding, and explicit capability separation. Browser preview must not grant AI/support read access.

**Acceptance criteria:**

- Only manually approved loopback ports with matching preview host, token, session, and process identity can be previewed.
- Private network, metadata IP, arbitrary WebSocket, bad Origin, POST/PUT/PATCH/DELETE, cookie, auth header, service worker, request smuggling, and path-prefix bypass attempts are denied.
- Redirects to the approved loopback service are rewritten; private/metadata/file/custom-scheme/userinfo redirects are blocked; safe external navigations are not proxied.
- Response bodies stream to the user's browser only; AI/support receive no page body without a separate future permission model.
- Port close or process identity change revokes approval.

**Key files/areas:** `backend/vectant-local-support-app/src/preview.rs`, new preview gateway server/route, `synthi/src/app/api/local-support/`, local port adapter, UI port approval/revoke controls.

**Tests required:** Preview E2E with a real dev server; SSRF/private network tests; header/cookie/auth stripping tests; redirect tests; service-worker tests; WebSocket abuse tests; smuggling/duplicate content-length tests; rate/flow-control tests.

**Blockers/dependencies:** Preview domain/host routing design, relay/gateway deployment path, local process identity implementation.

### Goal 7: Product Audit Storage, Enterprise Controls, and Operations

**Objective:** Make audit, admin policy, and operational safety real enough for internal beta.

**Scope:** Implement local user-visible event storage for allowed, denied, redacted, approved, revoked, paused, disconnected, exported, and deleted events. Separate security/internal events from user-facing summaries. Add tamper-evident chain, retention controls, scrubbed export/delete behavior, cloud-safe summaries, org/global kill switches, min app version, preview/pairing/agent disables, vulnerable version blocklist, admin UI/API, and monitoring alerts.

**Acceptance criteria:**

- Local event log persists as product storage with hash-chain verification and scrubbed export.
- Delete behavior follows retention/no-retention policy and never leaves hidden raw bodies.
- Admin can view paired devices, app versions, last active time, policy version, active sessions, approved ports count, and revoke devices/sessions.
- Global/org kill switches, min-version bump, pairing disable, preview disable, agent access disable, and vulnerable-version blocklist take effect immediately.
- Alerts exist for denied secrets, traversal, bad origins, pairing failures, suspicious requests, preview redirect blocks, old versions, scanner failures, traffic spikes, and rate limits.

**Key files/areas:** `backend/vectant-local-support-app/src/audit.rs`, `synthi/src/app/api/local-support/security-event/`, admin policy/control-plane APIs, desktop/web transparency UIs, ops dashboards/playbooks.

**Tests required:** Audit hash-chain tests; retention/export/delete tests; admin revoke E2E; kill switch E2E; alert routing tests; cloud-summary no-raw-body tests.

**Blockers/dependencies:** Admin policy store, observability stack, legal/product retention decisions, cloud audit schema.

## Pre-Beta / Public Release Blockers

### Goal 8: Signed Release, Incident Response, and Beta Red-Team Gate

**Objective:** Establish the signed release, incident-response, and red-team path required before any public beta.

**Scope:** Code-signed installer, signed artifacts, auto-update verification, downgrade prevention, emergency revocation, signing-key rotation playbook, SBOM, dependency scanning, secret scanning, protected branches, two-person review for signing changes, incident playbooks, and full integration/red-team gates.

**Acceptance criteria:**

- Public beta is blocked until critical/high red-team findings are fixed.
- Signed installer/update path rejects unsigned, tampered, revoked, and downgraded builds.
- Emergency disable and signing-key rotation playbooks have been exercised.
- Required red-team scenarios pass: malicious website localhost call, compromised session, symlink farm, malicious dev server, SSRF, secret-heavy logs, downgrade attempt, endpoint fuzzing, WebSocket abuse, confused-deputy approval flow.
- Release evidence is based on live implementation and CI/E2E proof, not acceptance tables or static UI mappings.

**Key files/areas:** `.github/workflows/local-support-security.yml`, release/signing workflows, updater module, incident response docs, red-team test harness.

**Tests required:** Signed update integration; downgrade/revocation tests; CI supply-chain gates; red-team suite; incident tabletop checklist; protected-branch/signing-change review verification.

**Blockers/dependencies:** Signing certificate/key management, release infrastructure, security owner sign-off, red-team capacity.

## Post-MVP / Future Work

Keep these outside the MVP and out of public beta unless they receive a separate product/security design, enterprise policy gate, consent model, implementation plan, and red-team review:

- Vectant AI or support agent page read access for localhost preview.
- Agent browser interaction, clicking, form submission, screenshots, or console/network body capture.
- Fast Support auto-send mode, broad repository upload, or persistent approvals.
- File writes, file edits, shell commands, package installation, git mutation, database mutation, or terminal control.
- VS Code/editor extension integration, remote desktop, screen recording, clipboard monitoring, accessibility APIs, or browser profile access.
