# Vectant Local Support Implementation Evidence

Last local verification: 2026-07-13 on Windows.

This file indexes executable evidence. It does not make static acceptance mappings count as completion, and it does not authorize public beta. Re-run every command from the reviewed commit and attach immutable CI/deployment evidence before release.

## Repository implementation

### Desktop and local authority

- Tauri desktop UI implements workspace selection, browser/cloud pairing fingerprint confirmation, local review approve/deny, pause/resume/disconnect, approval revocation, native loopback port detection/approval/open/revoke, scrubbed history export/delete, live policy/update-required state, and signed update check/install.
- Renderer IPC is an exact allowlist. Filesystem, shell, clipboard, keychain, token, private-key, raw-audit, and arbitrary path commands are denied. Renderer state is sanitized before serialization.
- Device identity uses Windows DPAPI in production. The native app owns tokens, private keys, approval content, port process identities, updater access, file dialogs, and the loopback listener.
- Exit, disconnect, cloud revocation, policy disable, listener close, and listener process-identity change revoke the applicable sessions, approvals, tokens, streams, and ports.

Evidence:

```powershell
cargo fmt --manifest-path backend/vectant-local-support-app/Cargo.toml --check
cargo clippy --manifest-path backend/vectant-local-support-app/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path backend/vectant-local-support-app/Cargo.toml
cargo fmt --manifest-path backend/vectant-local-support-app/desktop/Cargo.toml --check
cargo clippy --manifest-path backend/vectant-local-support-app/desktop/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path backend/vectant-local-support-app/desktop/Cargo.toml
npx playwright test tests/local-support-desktop-shell.spec.ts --project=chromium
```

Verified locally: 77 parent/unit/security tests, 9 desktop tests including real loopback pairing/policy/relay sockets, and 6 desktop Chromium flows.

The production Cargo package no longer contains the former standalone CLI daemon, and the session API no longer provides an implicit `acct_local`/`org_local` identity fallback. A feature-gated `local-support-test-daemon` exists only for live integration checks. `tests/local-support-live-daemon.spec.ts` starts that real process and uses Playwright request traffic against its real loopback socket to verify health and the protected status boundary. This is local daemon evidence, not cloud deployment evidence.

### Pairing, sessions, relay, and cloud controls

- Pairing challenges, attempts, sessions, device nonces, relay leases, encrypted one-time payloads, revocations, security events, and enterprise policy are durable Prisma models with migrations.
- Pairing binds browser session, account, organization, workspace, device fingerprint/public key, capabilities, policy/protocol/app versions, expiry, and confirmation receipt.
- Every relay request uses body-bound Ed25519 proof, nonce/replay protection, exact session scope, expiry/version/policy checks, and a minimized signed envelope. The desktop is outbound-only and recovers after transient relay failure; cloud 401/403 is terminal local revocation.
- Global/org/pairing/preview/agent disables, minimum version, vulnerable-version blocklist, and retention are durable. Desktop pairing and preview recheck live policy; preview disable/unavailable revokes local ports, tokens, and streams.
- Denied relay outcomes atomically create scrubbed routed security alerts without raw local bodies.

Evidence:

```powershell
$env:DATABASE_URL='postgresql://validation:validation@127.0.0.1:5432/validation'
npx prisma validate --schema synthi/prisma/schema.prisma
npm run test --workspace synthi -- src/lib/local-support src/app/api/local-support
```

The focused CI command in `.github/workflows/local-support-security.yml` is authoritative for the selected cloud suite. Verified locally during the current audit: 141 tests passed across 26 focused files, with one explicitly skipped test. On 2026-07-13, the full Prisma schema was validated and all 25 migrations were applied successfully to a clean local PostgreSQL 16 container, then the container was removed. This proves migration compatibility, not staging deployment identity or production data safety.

CI now includes a PostgreSQL service job that runs `prisma validate` and `prisma migrate deploy` against a clean database. It proves migration application in CI; it does not substitute for the intended staging deployment or browser-to-cloud-to-desktop proof.

The live-cloud gate now starts a real Next server against that PostgreSQL service, loads `/local-support` in Chromium, updates emergency policy through the admin HTTP route, and reads it back through the public policy route. The same flow passed locally on 2026-07-13 with one Chromium flow. A separate Playwright gate also passed locally on 2026-07-13 against a clean PostgreSQL 16 container: it queued a signed browser envelope, used the production Rust `RelayClient` feature-gated probe to poll and acknowledge review, uploaded a redacted payload through the real device-proof endpoint, queried the database to verify encrypted storage plus `queued`/`review_pending`/`sent` audit state, exercised a denied L4 request and verified a routed scrubbed `denied_secret` alert, then issued a real admin session revoke and verified the Rust client observed terminal revocation and the encrypted payload was purged. These are local Next/PostgreSQL/Rust proofs; they do not yet prove browser-to-cloud-to-installed-desktop pairing, staging deployment identity, or a real outbound production relay session.

### Review-before-send, scanner, audit, and preview

- Source/log bodies remain in the native approval queue until local approval and request-bound release. Denial/revocation clears queued content; release rechecks expiry, identity, file hash, and file metadata.
- Secret fixtures cover GitHub/OpenAI/AWS keys, JWT, private keys, database URLs, cookies, authorization headers, npm tokens, and Firebase service accounts. Scanner failure and uncertain/unsafe content fail closed.
- Workspace reads block traversal, absolute/device/UNC paths, symlink/junction escape, ignored/generated artifacts, archives, binary/large/sparse files, and TOCTOU replacement.
- Local audit storage is hash chained, size bounded, symlink safe, retained, scrubbed, exportable, deletable, and contains consent receipts without raw bodies.
- Preview is loopback-only, host/token/session/process bound, GET/HEAD-only, rate/stream/size limited, and strips credentials/cookies/hop-by-hop headers. It blocks service workers, WebSockets, smuggling, private/metadata redirects, unsafe schemes/userinfo, and process changes. Browser preview never grants AI/support page reads.

The parent Rust security suite is the executable evidence for these invariants. `tests/local-support-live-daemon.spec.ts` now adds a real Playwright boundary test against a live upstream server: credential headers are rejected before forwarding, upstream response cookies/CSP are scrubbed, bad origins and service-worker paths are denied (including percent-encoded paths), approved relative redirects are rewritten, external HTTPS navigation is left unproxied, private redirects are blocked, and revoke invalidates subsequent traffic. Preview tests also include Windows native listener ownership.

### Transparency and operations UI

- `/local-support` polls live local/cloud transparency state, distinguishes locally available/review-required/blocked/sent data, and forwards export/delete/session/port controls to the local daemon.
- `/local-support/admin` loads durable policy, paired devices, active sessions, revocations, and routed alerts; it applies policy and confirms device/session revocation. The operations token is kept only in component memory.

Evidence:

```powershell
npm run build --workspace synthi
$env:VECTANT_TEST_BASE_URL='http://127.0.0.1:3000'
npx playwright test tests/local-support-transparency.spec.ts tests/local-support-admin.spec.ts --project=chromium
```

Verified locally during the current audit: 16/16 Chromium tests passed across transparency, admin, desktop-shell, and live-daemon specs against a freshly started server whose listener was verified to belong to this workspace; the server log contained no `EADDRINUSE`. The production Next build also completed successfully. This is local runtime evidence, not authenticated staging deployment evidence.

Supply-chain evidence: `npm audit --workspace synthi --omit=dev --audit-level=high` completed successfully, while reporting 53 moderate/low advisories in the broader dependency tree. `cargo audit --manifest-path backend/vectant-local-support-app/Cargo.toml --deny warnings` could not run because `cargo-audit` is not installed on the local validation host; the CI workflow still declares that gate.

### Packaging and updater

- Tauri produces MSI and NSIS bundles with the declared Windows icon set.
- `tauri-plugin-updater` is registered in Rust. Check/install are narrow native IPC commands; install requires native confirmation, rechecks the candidate, relies on Tauri signature verification and downgrade protection, installs, then restarts.
- The independent package verifier binds Ed25519-signed metadata to channel, version policy, emergency revocation, and exact artifact SHA-256 bytes.
- `.github/workflows/local-support-release.yml` requires the protected signing environment, builds updater artifacts, Authenticode-signs installers, verifies them, generates checksums/SBOM, removes the ephemeral certificate, smoke-tests signed install/uninstall, and re-verifies on a clean runner.
- The checked-in Tauri configuration keeps updater artifacts and the signed updater plugin active with a valid non-production fixture public key. A local Tauri build using a matching ephemeral key produced one `.sig` updater artifact and one NSIS installer on 2026-07-13. The protected release job rejects both the old zero sentinel and reuse of the fixture key; it must replace the fixture with the real public key. No release is considered signed without the protected key, certificate, HTTPS endpoint, and clean-runner checks.

Hands-on unsigned packaging smoke command:

```powershell
cd backend/vectant-local-support-app/desktop
cargo tauri build --no-sign
cd ../../..
& backend/vectant-local-support-app/scripts/windows-installer-smoke.ps1 `
  -InstallerPath 'backend/vectant-local-support-app/desktop/target/release/bundle/nsis/Vectant Local Support_0.1.0_x64-setup.exe'
```

Verified locally: MSI and NSIS were produced; NSIS installed into a unique temporary directory; the installed executable opened only a random `127.0.0.1` listener; silent uninstall removed the executable and left no Local Support process.

Re-verified on 2026-07-13 after the updater/package changes with a Tauri NSIS build followed by `scripts/windows-installer-smoke.ps1`: the installed executable opened only a random loopback listener, returned a valid `/health` response, rejected an unprotected `/v1/status` request, and uninstalled cleanly. This is installed daemon-boundary evidence only; it is not Authenticode, production updater-key, or staging cloud evidence.

## Public-beta gates requiring external evidence

These are not complete merely because workflow/runbook code exists:

1. Provision the `local-support-signing` protected GitHub environment with a CA-issued Windows certificate and production Tauri updater key/HTTPS endpoint.
2. Require two-person/security-owner review for signing workflow, updater, and key/config changes through repository environment and branch protection.
3. Run `Local Support Signed Release`; preserve the clean-runner signature, checksum, SBOM, install/uninstall, unsigned/tampered/wrong-channel/downgrade/revocation rejection evidence.
4. Apply Prisma migrations to the intended deployment and run browser-cloud-desktop pairing, relay approval/denial, policy disable, device/session revoke, transparency, and preview scenarios against that live environment.
5. Exercise `VECTANT_LOCAL_SUPPORT_INCIDENT_RESPONSE.md` as a dated tabletop, including emergency disable and signing-key rotation; close all findings.
6. Complete independent red-team scenarios from the remaining-goals plan and close every critical/high finding before public beta.

External host check performed with Playwright on 2026-07-13: `https://beta.vectant.dev/local-support` reached Google IAP and could not be exercised without an authorized staging account; `https://app.vectant.dev` and `https://updates.vectant.dev` failed TLS negotiation from the validation host. No authenticated staging desktop/cloud run was claimed from that check.

`.github/workflows/local-support-staging-e2e.yml` now provides the protected-environment gate for the missing deployment proof. Its Ubuntu job requires `LOCAL_SUPPORT_STAGING_BASE_URL` and `LOCAL_SUPPORT_STAGING_ADMIN_TOKEN`, rejects auth redirects, exercises durable emergency disable and a denied relay boundary, and restores the prior policy. Its Windows job builds an installer and exercises the installed app/daemon boundary. It has been syntax/list-checked locally but has not been run without staging credentials.

Until all six have immutable evidence and security-owner sign-off, the signed public-beta acceptance criteria remain unproven and release must stay blocked.
