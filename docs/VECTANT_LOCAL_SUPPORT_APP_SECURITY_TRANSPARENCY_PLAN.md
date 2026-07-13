# Vectant Local Support App — Security, Transparency, and Local Preview Plan v3

## 0. Executive Summary

Build the Vectant Local Support App as a **read-only, session-scoped, workspace-scoped, locally enforced support bridge** between a user's machine and a single Vectant support session.

This feature is powerful enough to become dangerous if it is implemented loosely. It gives a cloud product a controlled path toward local files, local logs, local development servers, and potentially local browser-visible behavior. Therefore the product must be designed as a security product first and a support convenience second.

The core promise must be:

> Vectant can only see local information that the local app permits, the user can inspect, the current session is allowed to request, and the policy engine has classified as safe enough to send.

The local app must **not** become:

- a hidden background monitoring agent;
- a remote shell;
- a general filesystem indexer;
- a repository uploader;
- a localhost port scanner;
- a generic localhost/private-network proxy;
- a browser profile or cookie bridge;
- a way for Vectant AI or support staff to silently scrape the user's machine;
- a permanent trust grant after installation.

The safe first product is:

> A local desktop/tray app that pairs with one Vectant support session, allows one selected workspace, blocks secrets locally, exposes only explicit read-only capabilities, shows exactly what was requested/sent/blocked/redacted, and permits localhost preview only through manually approved, isolated, host-based preview origins.

Security and frontend transparency are not separate polish work. They are the minimum viable feature.

---

## 0.1 Highest-Risk Areas Requiring Extra Care

The following areas are the release-critical security hotspots:

1. **Pairing and device identity** — a malicious website or compromised browser session must not pair or hijack the bridge.
2. **Local API exposure** — random web pages must not be able to call the local agent through `localhost`.
3. **Workspace boundary enforcement** — symlinks, junctions, path traversal, case-insensitive paths, mount points, and archive tricks must not escape the selected workspace.
4. **Secret leakage** — `.env`, keys, tokens, cookies, cloud credentials, database URLs, logs, and generated files must be blocked or redacted before leaving the machine.
5. **Localhost preview** — approved preview must not become a private-network proxy, SSRF primitive, cookie exfiltration route, service-worker persistence mechanism, or state-changing request engine.
6. **AI/support agent separation** — browser preview for the user must not automatically mean Vectant AI or a human support agent can read, click, inspect, scrape, or summarize the page.
7. **Auditability** — the user must always be able to inspect what happened, including denied requests.
8. **Release safety** — this must not enter public beta without org kill switches, version enforcement, update signing, red-team tests, and abuse-case coverage.

---

## 0.2 Major Weaknesses Found and Fixed in v3

The previous plan was strong, but it still left several dangerous implementation gaps. This v3 version fixes them by making the following changes:

| Area | Weakness | v3 Improvement |
|---|---|---|
| Security model | Threat model existed, but release gates were not strict enough | Adds explicit trust boundaries, STRIDE-style abuse mapping, and non-negotiable launch blockers |
| Pairing | Device signing existed, but request-level binding was underspecified | Adds proof-of-possession refresh, consent receipts, request envelopes, replay protection, and session capability binding |
| Local API | Good CORS/CSRF controls, but local endpoint classes were not separated enough | Splits public health, browser management, cloud relay, and internal desktop IPC surfaces |
| Preview | Host-based routing was correct, but proxy parser and browser execution risks needed more detail | Adds request smuggling defenses, DNS/IP canonicalization, userinfo blocking, Host header rules, external navigation handling, iframe sandboxing, and CSP wrapper rules |
| Agent access | Separate permissions existed, but the MVP boundary needed to be stricter | Blocks agent read/interact in MVP unless separately launched under a dedicated security review |
| Filesystem | Path checks were present, but archive and generated artifact risks were not explicit enough | Adds archive extraction ban, file identity checks, TOCTOU controls, revalidation after open, sparse file limits, and content-type sniffing |
| Redaction | Scanner requirements existed, but confidence handling was not operational enough | Adds block-on-uncertainty, scanner versioning, fixture tests, redaction previews, and no-cloud raw preview guarantee |
| Logs | Audit logging existed, but security vs user-facing logs needed clearer separation | Adds event classes, tamper-evidence, retention defaults, log scrubbing requirements, and incident export format |
| Frontend | Transparency screens were strong, but “available” vs “sent” needed stricter wording | Adds exact UI claims, status labels, review copy, and UX acceptance tests |
| Enterprise | Org controls existed, but should be pre-beta blockers | Makes org kill switch, allowlists, min app version, retention controls, and agent access policy mandatory before beta |
| Supply chain | Updates were covered, but dependency/build provenance needed more detail | Adds SBOM, reproducible builds where practical, dependency signing, secret scanning in CI, and compromised-update response |
| Operations | Incident response and abuse monitoring were thin | Adds security operations, emergency disable, alerting, abuse investigation, and rollback playbooks |

---

## 1. Product Goal

The Local Support App helps Vectant debug local development projects without requiring users to paste large amounts of context manually.

Vectant may help inspect, only when locally permitted:

- selected workspace metadata;
- selected source/config files;
- framework metadata;
- dependency metadata;
- package manager metadata;
- local dev server status;
- manually approved localhost services;
- approved logs and terminal snapshots;
- safe diagnostic summaries;
- git branch/status summaries;
- browser console errors from approved local preview sessions;
- test output when explicitly supplied or approved.

Vectant must not silently inspect:

- the user's entire computer;
- the user's home directory;
- files outside the selected workspace;
- secret files;
- browser profiles;
- password stores;
- SSH, cloud, package manager, database, or deployment credentials;
- database dumps;
- customer/private data;
- unrelated localhost services;
- arbitrary localhost ports;
- private network hosts;
- shell command output;
- process lists beyond narrowly approved local port identity hints;
- screen, camera, microphone, clipboard, keychain, or accessibility APIs.

The product trust model is:

> Automatic only where low-risk, visible always, locally enforced always, permissioned when sensitive, blocked when dangerous, and revocable immediately.

---

## 2. Non-Negotiable Security Principles

These are release blockers.

### 2.1 Local Enforcement First

The local app must enforce policy before data leaves the machine.

The cloud may request; the local app decides. The cloud must never be the only authorization or redaction layer.

If Vectant asks for a blocked file, blocked port, blocked method, blocked header, blocked redirect, or blocked capability, the local app must refuse locally, send no sensitive content, and write a user-visible denied event.

### 2.2 Read-Only by Default

The MVP must not support:

- file editing;
- file deletion;
- arbitrary command execution;
- package installation;
- git mutation;
- database mutation;
- terminal control;
- browser automation;
- remote desktop;
- POST/PUT/PATCH/DELETE to local services;
- persistent background indexing.

Future write features require a separate product, threat model, permission model, UI, logging model, red-team review, and enterprise policy gate.

### 2.3 Session-Scoped Access

Default behavior:

- one Vectant support session at a time;
- one selected workspace at a time;
- session dies when disconnected;
- session dies when the local app exits;
- pairing code expires quickly;
- local session tokens are short-lived;
- approvals expire at session end;
- no permission silently carries to another chat, workspace, org, browser tab, or device.

Installation is not consent. Pairing is not broad consent. Workspace selection is not full repository upload consent. Port preview is not AI scraping consent.

### 2.4 Workspace Boundary

All filesystem access must be bounded to a user-selected workspace root.

The local app must enforce:

- absolute path construction from workspace root;
- canonical path resolution;
- symlink resolution;
- Windows junction and reparse point handling;
- case-insensitive path comparison on filesystems where relevant;
- mount point and device path blocking;
- UNC path blocking unless explicitly supported later;
- hidden sensitive folder blocking;
- revalidation after file open to avoid time-of-check/time-of-use races.

### 2.5 Explicit Localhost Boundary

Local port access must be limited to approved loopback services.

The app must not become:

- an SSRF proxy;
- a private network proxy;
- a LAN scanner;
- a cloud metadata proxy;
- a cookie/session bridge;
- a browser automation engine;
- a way to trigger local state-changing actions.

### 2.6 Transparent Frontend

The user must always be able to answer:

- Is local support connected?
- Which Vectant account/session is connected?
- Which device is connected?
- Which workspace is connected?
- Which files are available locally?
- Which files have actually been sent?
- Which files were ignored?
- Which files were blocked?
- Which data was redacted?
- Which local ports are approved?
- What can happen automatically?
- What requires approval?
- What did Vectant request?
- What did Vectant receive?
- What was denied?
- How do I pause?
- How do I disconnect?
- How do I revoke approvals?
- How do I export/delete local activity history?

### 2.7 Deny on Uncertainty

Deny the request if any of these fail:

- authentication;
- session validation;
- proof-of-possession;
- request schema validation;
- policy lookup;
- path resolution;
- file classification;
- secret scanning;
- redaction;
- port identity validation;
- redirect validation;
- header policy application;
- logging write;
- approval state lookup.

Do not “send and hope.”

### 2.8 No Hidden Context

No invisible preload. No silent repo upload. No background crawl. No “because the desktop app is installed, we can inspect your machine.”

The frontend must distinguish:

```txt
Available locally != Sent to Vectant
Approved for browser preview != Approved for AI/support reading
Redacted preview != Raw original sent
Connected != Unlimited access
```

---

## 3. Explicit MVP Non-Goals

The MVP must not include:

- arbitrary command execution;
- AI agent file editing;
- remote terminal control;
- full repository upload;
- background always-on daemon mode;
- automatic broad port scanning;
- access outside selected workspace;
- browser profile access;
- cookies/localStorage/sessionStorage extraction;
- database connection inspection;
- cloud credential inspection;
- SSH credential inspection;
- package manager token inspection;
- remote desktop;
- screen recording;
- microphone/camera access;
- clipboard monitoring;
- accessibility API usage;
- automatic dependency installation;
- automatic git operations;
- admin/root privileges;
- persistent port approvals;
- agent browser interaction;
- local service POST/PUT/PATCH/DELETE;
- service-worker-enabled preview;
- public/private network proxying.

Any of these changes the risk class of the product and must be handled as a separate launch.

---

## 4. Security Architecture Overview

### 4.1 Control Plane vs Data Plane

Separate control-plane operations from data-plane operations.

**Control plane:**

- pairing;
- session creation;
- device identity;
- capability grants;
- approval prompts;
- policy distribution;
- revocation;
- activity summaries;
- admin controls.

**Data plane:**

- file reads;
- log reads;
- metadata reads;
- local port health checks;
- preview streams;
- redacted payload sends.

Rules:

- control-plane authorization does not automatically authorize data-plane transfer;
- data-plane requests must include a capability, target, session, request ID, expiry, and policy version;
- local policy must re-check every data-plane request;
- data-plane messages must be replay-resistant;
- logs must clearly indicate control vs data events.

### 4.2 Layered Decision Pipeline

Every request follows this pipeline:

```txt
User-visible session state
  ↓
Cloud session authorization
  ↓
Signed/nonce-bound request envelope
  ↓
Local session token validation
  ↓
Device proof-of-possession check where required
  ↓
Local policy engine
  ↓
Workspace/port adapter
  ↓
Classification
  ↓
Secret scanner
  ↓
Redaction or block
  ↓
Review-before-send if required
  ↓
Minimal payload send
  ↓
Local and cloud-safe audit log
```

### 4.3 Trust Boundaries

| Boundary | Risk | Required control |
|---|---|---|
| Browser ↔ Vectant web app | CSRF, clickjacking, confused user | CSRF tokens, Fetch Metadata, frame protections, clear UI |
| Vectant web app ↔ cloud session API | compromised session, overbroad request | server authorization, capability envelopes, audit |
| Cloud session API ↔ local bridge | replay, spoofing, token theft | short TTL, request nonce, device PoP, revocation |
| Local bridge ↔ filesystem | path escape, secret leakage | canonicalization, denylist, scanner, approval |
| Local bridge ↔ localhost service | SSRF, cookie leak, state change | port approval, loopback-only, header policy, method blocking |
| Preview host ↔ user's browser | XSS, service workers, cookies, framing | isolated domain, sandboxed iframe, no main cookies, CSP wrapper |
| Local app UI ↔ local daemon | IPC abuse | schema validation, least privilege, no generic command API |
| Logs/telemetry ↔ storage | secret retention | scrubbing, hashing, no raw bodies, retention limits |

---

## 5. Threat Model

### 5.1 Assets to Protect

| Asset | Why it matters | MVP default |
|---|---|---|
| API keys | Account/cloud compromise | Block/redact |
| Private keys | SSH/TLS/deploy identity compromise | Block |
| OAuth tokens | User/app impersonation | Block/redact |
| Cookies/session IDs | Web session takeover | Block/redact |
| `.env` files | Usually contain secrets | Block |
| `.aws`, `.gcp`, `.azure` | Cloud compromise | Block |
| `.kube` | Cluster compromise | Block |
| Browser profiles | Passwords, cookies, history | Block |
| Password stores/keychains | Credential compromise | Block |
| Customer data | Legal/privacy risk | Block unless future enterprise flow |
| DB dumps | High-volume sensitive data | Block |
| Source code | IP risk, often needed for support | Scoped and approved |
| Logs | Token/PII risk | Redact + approval |
| Local ports | Admin panels/dev tools | Manual approval only |
| Preview cookies | Session confusion/exfiltration | Strip by default |
| Activity logs | Accountability and privacy | Minimized, scrubbed, exportable |
| Update channel | Full local compromise risk | Signed, downgrade-protected |

### 5.2 Threat Actors

| Actor | Example | Defense |
|---|---|---|
| Malicious website | Calls `127.0.0.1` API | no public endpoints beyond health, token, Origin, CSRF, Fetch Metadata |
| Compromised Vectant browser session | Requests `.ssh/id_ed25519` | local policy denies, user-visible log |
| Malicious repo | Symlink to `~/.aws/credentials` | canonical path and symlink checks |
| Malicious local dev server | Sets cookies for Vectant domain | response header policy strips/rewrites |
| Malicious local process | Binds approved port after original closes | invalidate on process/port identity change |
| Network attacker | Hijacks pairing | TLS, short code TTL, fingerprint, device signature |
| Curious support agent | Requests broad context | least privilege capabilities, approval prompts, audit |
| Malicious support agent | Attempts repeated denied reads | rate limits, alerts, audit, org controls |
| Local malware | Steals token from disk | memory-only token, OS keychain, short TTL |
| Update attacker | Pushes malicious app | signed updates, version enforcement, emergency revoke |
| User misunderstanding | Thinks preview is local-only | persistent banner, sent-history UI, plain copy |

### 5.3 STRIDE Abuse Mapping

| Category | Abuse case | Required mitigation |
|---|---|---|
| Spoofing | Fake browser/device claims same pairing code | fingerprint, device key signing, local + browser confirmation |
| Tampering | Cloud modifies request target after approval | signed request envelope, request ID, consent receipt binding |
| Repudiation | Support claims no local file was requested | local activity log, cloud audit summary, exportable records |
| Information disclosure | `.env` or token in logs sent | denylist, scanner, redaction, review-before-send |
| Denial of service | Huge file/stream exhausts memory | size caps, flow control, rate limits, backpressure |
| Elevation of privilege | Renderer XSS reaches filesystem | process isolation, IPC schemas, no Node integration, CSP |

### 5.4 Critical Abuse Cases to Test

The system must be built around these tests:

1. Random website attempts `fetch('http://127.0.0.1:<port>/context/request-file')`.
2. Compromised tab requests `../../.ssh/id_ed25519`.
3. Workspace contains symlink `src/config.js -> ../../.aws/credentials`.
4. `.env` appears under a nonstandard filename like `production.env.backup`.
5. Log contains `Authorization: Bearer ...`, JWT, database URL, and cookie.
6. Local preview redirects to `http://169.254.169.254/latest/meta-data/`.
7. Local preview redirects to `http://192.168.1.1/admin`.
8. Local app sets `Set-Cookie: vectant_session=...; Domain=.vectant.com`.
9. Local app attempts service-worker registration.
10. Approved port closes, then sensitive admin panel opens on the same port.
11. Preview sends chunked response with conflicting `Content-Length`.
12. WebSocket Origin is missing or cross-site.
13. Support agent requests response body when only browser preview is approved.
14. Fast Support attempts to auto-send source/log data.
15. Old vulnerable local app version tries to pair.

---

## 6. Recommended Product Shape

### 6.1 MVP Form

Recommended MVP:

- desktop/tray app plus local daemon;
- local API bound only to loopback;
- cloud relay connection initiated by local app outbound to Vectant;
- one support session at a time;
- one selected workspace at a time;
- read-only capabilities only;
- Balanced mode default;
- Manual mode available;
- Fast Support either excluded from MVP or disabled until transparency is proven;
- visible context inventory;
- local-first policy engine;
- explicit approval for source/log/sensitive data;
- manually approved local ports;
- browser preview only through isolated preview hosts;
- agent read blocked by default;
- no agent interaction in MVP.

### 6.2 Technology Recommendation

Recommended order:

1. **Tauri or native shell** for smaller desktop attack surface.
2. **Electron** only if web-stack speed is essential and hardening is treated as release-critical.
3. **CLI daemon** for internal prototype only.
4. **VS Code extension** later, because editor APIs create a different consent model.

If Electron is used:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- `sandbox: true`;
- remote module disabled;
- no untrusted remote content in privileged windows;
- strict CSP;
- all IPC schema-validated;
- no generic `readFile`, `writeFile`, `exec`, or `openPath` IPC;
- block unexpected navigation;
- block new windows by default;
- disable permission requests by default;
- treat renderer XSS as potential local compromise.

If Tauri is used:

- restrict command allowlist tightly;
- no generic filesystem plugin access to renderer;
- validate all commands with schemas;
- use explicit capabilities only;
- keep bridge/session tokens outside renderer state;
- disable shell/open APIs unless absolutely necessary.

---

## 7. System Architecture

### 7.1 Components

```mermaid
flowchart LR
    User[User] --> Web[Vectant Web App]
    User --> LocalUI[Local Support App UI]
    Web --> Pairing[Pairing Service]
    LocalUI --> Pairing
    Web <--> SessionAPI[Support Session API]
    SessionAPI <--> Relay[Bridge Relay / Preview Gateway]
    LocalUI --> Daemon[Local Agent Daemon]
    Daemon --> Policy[Local Policy Engine]
    Daemon --> FS[Workspace File Adapter]
    Daemon --> Ports[Local Port Adapter]
    Daemon --> Scanner[Scanner + Redactor]
    Daemon --> Log[Local Activity Log]
    Daemon <--> Relay
    Web --> Transparency[Transparency Panel]
    Admin[Org Admin Policy] --> SessionAPI
    Admin --> Pairing
```

### 7.2 Component Responsibilities

#### Vectant Web App

Responsible for:

- explaining local support before pairing;
- showing persistent status;
- showing context inventory;
- showing sent/blocked/redacted activity;
- requesting local context through the session API;
- presenting approvals;
- providing pause/disconnect/revoke controls.

Not responsible for:

- bypassing local policy;
- directly reaching the filesystem;
- directly scanning localhost;
- hiding local activity from the user.

#### Local Support App UI

Responsible for:

- install/start flow;
- pairing confirmation;
- fingerprint display;
- workspace picker;
- permission mode selection;
- local approvals;
- activity log;
- exact sent-payload display;
- pause/disconnect;
- local export/delete controls;
- security warnings.

#### Local Agent Daemon

Responsible for:

- loopback-only local API;
- outbound authenticated relay connection;
- session validation;
- local policy enforcement;
- file/port/log request handling;
- scanner/redactor execution;
- rate limiting;
- local audit logging;
- fail-closed behavior.

#### Pairing Service

Responsible for:

- short-lived pairing codes;
- challenge generation;
- fingerprint derivation;
- device public key registration;
- local/browser confirmation coordination;
- token issuance;
- revocation;
- app version checks;
- org policy checks.

#### Relay / Preview Gateway

Responsible for:

- routing cloud requests to the paired bridge;
- enforcing server-side session/capability checks;
- applying preview host routing;
- applying edge response/request header policy;
- not logging sensitive preview URLs or headers;
- stream flow control;
- connection shutdown on revoke.

#### Local Policy Engine

Responsible for:

- workspace boundary decisions;
- capability evaluation;
- org/user/session policy precedence;
- file classification;
- local port rules;
- approval requirements;
- fail-closed decisions;
- policy versioning.

#### Scanner + Redactor

Responsible for:

- detecting secrets in files, logs, headers, URLs, and responses;
- redacting safe-to-send values;
- blocking unsafe data;
- producing redaction summaries;
- never exposing raw redacted values to cloud logs.

#### Activity Log

Responsible for:

- user-visible local event history;
- denied-request history;
- sent-payload records;
- local export;
- deletion controls;
- tamper-evident enterprise export.

---

## 8. Pairing, Device Identity, and Session Protocol

### 8.1 Pairing Goals

Pairing must prove:

- the user intentionally connected the local app;
- the local app and browser are approving the same pairing attempt;
- the bridge is bound to one Vectant user/session/org policy;
- a malicious website cannot silently pair;
- a stolen code alone cannot pair;
- a stale code cannot be reused;
- bearer-token theft alone is insufficient;
- the user can revoke immediately.

### 8.2 Device Keypair

The local bridge must generate a device keypair on first run or first pairing.

Requirements:

- use platform crypto APIs;
- prefer Ed25519 or P-256 depending on platform support;
- store private key in OS keychain/DPAPI/Keychain/Secure Enclave equivalent when available;
- never send private key to Vectant;
- register only public key and key ID;
- rotate on user request, app reset, suspected compromise, or major security update;
- support device unlinking;
- do not treat a random local nonce as device identity.

### 8.3 Pairing Fingerprint

Derive a short fingerprint from:

```txt
pairing_id + server_nonce + browser_session_id + device_public_key + requested_user_id
```

Rules:

- show fingerprint in browser and local app;
- user must compare values;
- fingerprint changes every attempt;
- device name is informational only;
- mismatch means reject.

Example:

```txt
Browser:
Approve Bombt-PC?
Fingerprint: 7F2C-K91A

Local app:
Vectant support session wants to connect.
Fingerprint: 7F2C-K91A
```

### 8.4 Pairing Flow

1. User opens Vectant support.
2. Web app explains exactly what local support can and cannot expose.
3. User starts Local Support App.
4. Local app creates/loads device keypair.
5. Local app requests pairing challenge.
6. Pairing service creates short-lived pairing ID, code, nonce, and fingerprint.
7. Local app displays code and fingerprint.
8. User enters code in browser or scans QR.
9. Browser shows device name, OS, app version, org policy, and fingerprint.
10. Local app shows Vectant account/session and fingerprint.
11. User confirms in both places.
12. Bridge signs challenge.
13. Pairing service verifies signature.
14. Cloud checks app version and org policy.
15. Session token is issued with limited capabilities.
16. Local app starts as `Connected / No workspace selected` or `Paused`.
17. User selects workspace.
18. Context requests can now succeed only within selected capabilities.

### 8.5 Pairing Code Limits

```txt
Default TTL: 2 minutes
Maximum TTL: 5 minutes
One-time use: required
Failed attempts per code: 5
Failed attempts per account/IP/device: rate-limited
Replay protection: required
Local confirmation after browser claim: required
```

Errors must not reveal whether a code exists.

### 8.6 Session Token Requirements

Session token or server-side session state must bind:

- session ID;
- user ID;
- org ID;
- workspace ID after selection;
- device ID;
- public key ID;
- app version;
- protocol version;
- issued-at;
- expiry;
- permission mode;
- allowed capabilities;
- approved file scopes;
- approved port scopes;
- preview host IDs;
- policy version;
- revocation counter.

Suggested defaults:

```txt
Pairing code TTL: 2 minutes preferred, 5 minutes max
Local session token TTL: 30 minutes
Inactivity timeout: 15 minutes
Preview token TTL: 5-15 minutes
File approval TTL: current session only
Port approval TTL: current session only
Fast Support TTL: max 30 minutes, if shipped at all
```

### 8.7 Request Envelope

Every cloud-to-local request must use an explicit envelope.

Example:

```json
{
  "type": "context.request_file",
  "request_id": "req_01HY...",
  "session_id": "sess_123",
  "bridge_id": "br_123",
  "workspace_id": "wk_123",
  "capability": "workspace.file.source.read",
  "target": {
    "path": "src/App.tsx"
  },
  "reason": "Debug frontend error from current support chat",
  "requested_by": "vectant_ai",
  "created_at": "2026-07-04T17:00:00Z",
  "expires_at": "2026-07-04T17:00:30Z",
  "nonce": "base64url-random",
  "policy_version": "2026.07.04",
  "requires_user_visible_log": true
}
```

Local validation:

- request ID has not been seen before;
- envelope is not expired;
- session matches current pairing;
- bridge ID matches local bridge;
- workspace ID matches selected workspace;
- capability is allowed;
- requested actor is visible in log;
- policy version is accepted;
- nonce is recorded to prevent replay.

### 8.8 Consent Receipts

For user-approved data, store a consent receipt.

Consent receipt fields:

```json
{
  "approval_id": "appr_123",
  "request_id": "req_123",
  "session_id": "sess_123",
  "target_display": "src/App.tsx",
  "capability": "workspace.file.source.read",
  "approved_scope": "once|session",
  "approved_by_user": "user_123",
  "approved_at": "2026-07-04T17:01:00Z",
  "expires_at": "session_end",
  "content_hash_after_redaction": "sha256:...",
  "redaction_summary": {
    "count": 0
  }
}
```

A later payload must not use a stale approval if the path, capability, actor, session, or content class changed materially.

### 8.9 Proof-of-Possession Refresh

For longer sessions:

- server sends fresh nonce;
- bridge signs nonce + session ID + revocation counter;
- failed proof pauses session;
- repeated failure revokes session;
- failure is visible in frontend.

### 8.10 Disconnect and Revocation

Disconnect must:

- revoke cloud token;
- revoke local token;
- revoke preview tokens;
- revoke agent tokens;
- close WebSockets;
- stop preview streams;
- stop file reads;
- clear pending approvals;
- clear memory caches;
- invalidate port approvals;
- clear one-time preview cookies where possible;
- mark session disconnected;
- write activity event;
- notify only the pairing user's active sessions by default.

Pause must:

- keep pairing metadata;
- reject new context requests;
- reject preview streams;
- keep UI available;
- log denied requests while paused;
- allow user resume.

---

## 9. Local Agent API Hardening

### 9.1 Bind Rules

The local agent must:

- bind only to `127.0.0.1` and/or `[::1]`;
- never bind to `0.0.0.0`;
- never expose LAN access;
- use a random high port;
- verify actual bound address after startup;
- refuse startup if not loopback;
- prefer exclusive binding where supported;
- expose only a non-sensitive health endpoint unauthenticated.

### 9.2 Separate Endpoint Classes

Separate these surfaces:

| Surface | Examples | Required protection |
|---|---|---|
| Public local health | `/health` | no sensitive data, no CORS wildcard |
| Browser management | pairing, pause, approve, revoke | auth, CSRF, Origin, Fetch Metadata, clickjacking protection |
| Cloud relay | context/port requests | session token, request envelope, replay protection |
| Desktop IPC | UI ↔ daemon | schema validation, no generic commands |
| Internal worker | scanner/file adapter | not network-exposed |

### 9.3 CORS and Origin Rules

The local API must:

- deny CORS by default;
- allow only exact configured Vectant origins;
- reject wildcard origins;
- reject `null` origin except explicit desktop-internal flows;
- reject unexpected browser-originated requests;
- require bearer token or signed nonce on every non-public endpoint;
- never rely on CORS alone.

### 9.4 CSRF and Localhost Request Protection

Every stateful or data-returning browser route must require:

- authenticated session;
- CSRF token or signed request nonce;
- strict method validation;
- content-type validation;
- request schema validation;
- `Origin` validation where present;
- Fetch Metadata checks;
- no state change via GET.

### 9.5 Fetch Metadata Policy

```txt
Sec-Fetch-Site: same-origin    -> allow if auth + CSRF pass
Sec-Fetch-Site: same-site      -> allow only explicitly trusted Vectant domains
Sec-Fetch-Site: cross-site     -> deny state-changing and local-preview routes
Sec-Fetch-Site: none           -> allow only safe top-level navigation
Missing headers                -> deny high-risk routes, fall back to Origin/CSRF for low-risk routes
```

### 9.6 Clickjacking Rules

Never iframe:

- pairing approval;
- port approval;
- file approval;
- agent-access approval;
- review-before-send;
- disconnect confirmation;
- permission downgrade/upgrade.

Use `frame-ancestors 'none'` or equivalent for approval routes.

Preview content may be framed only inside a Vectant-controlled UI and only from isolated preview origins with sandbox rules.

### 9.7 Endpoint Shape

Prefer explicit capability endpoints:

```txt
GET  /health
POST /session/pair/confirm
POST /session/pause
POST /session/resume
POST /session/disconnect
GET  /session/status
POST /workspace/select
GET  /workspace/summary
POST /context/request-file
POST /context/request-metadata
POST /context/request-log
POST /ports/propose
POST /ports/approve
POST /ports/request-health
GET  /activity
POST /activity/export
POST /policy/evaluate-preview
```

Avoid generic dangerous endpoints:

```txt
GET  /read?path=...
GET  /proxy?url=...
POST /execute
POST /scan-all
POST /upload-repo
POST /open-browser-profile
POST /run-command
```

### 9.8 Request Validation

Every request must validate:

- required fields;
- field types;
- max string length;
- enum values;
- path format;
- URL format;
- content size;
- workspace ID;
- session ID;
- capability;
- actor;
- expiry;
- nonce uniqueness.

Invalid requests:

- return generic error to caller;
- write detailed local denied event;
- expose no partial data.

### 9.9 Rate Limits

Suggested MVP defaults:

```txt
Max concurrent file reads: 4
Max file requests/min/session: 60
Max log requests/min/session: 10
Max port health requests/min/session: 30
Max preview requests/min/host: 60
Max failed requests/min/session: 20
Max automatic metadata bytes/min: 2 MB
Max activity entries returned: 200
```

Repeated suspicious requests should trigger:

- temporary cooldown;
- visible warning;
- cloud-side security event;
- optional session pause for severe patterns.

### 9.10 Error Handling

Cloud-facing errors must not leak:

- absolute paths outside approved UI;
- tokens;
- environment variables;
- stack traces;
- raw scanner output;
- local usernames;
- process command lines;
- response bodies.

Local UI may show more detail, but still must not display raw secrets after redaction.

---

## 10. Permission Model

### 10.1 Policy Precedence

Evaluate permissions in this order:

```txt
Hardcoded safety baseline
  > Emergency remote kill switch
  > Enterprise/org policy
  > Workspace policy
  > User global setting
  > Current session mode
  > Item-specific approval
  > Final scanner/redactor decision
```

A lower layer cannot override a higher safety block.

Examples:

- `.ssh/` remains blocked even if user chooses Fast Support.
- Enterprise policy disabling port preview cannot be overridden by user approval.
- Scanner failure blocks even if the file was approved.

### 10.2 Permission Modes

#### Manual Mode

Use for sensitive projects.

Behavior:

- ask before every file read;
- ask before every log read;
- ask before every port request;
- metadata requires review before send;
- no automatic context updates;
- no Fast Support;
- all decisions logged.

#### Balanced Mode

Default.

Behavior:

- automatically read safe metadata;
- automatically summarize allowlisted low-risk config;
- ask before source files unless explicitly selected;
- ask before logs and terminal snapshots;
- ask before port approval;
- block secrets;
- show automatic reads in activity log;
- show all sent payloads in history.

#### Fast Support Mode

Should not ship in MVP unless UX tests prove users understand it.

If shipped:

- visible warning banner always shown;
- TTL required;
- max 30 minutes;
- limited to one workspace;
- safe metadata/config only;
- source/logs still approval-gated;
- secrets blocked;
- ports still manual;
- response bodies still review-gated;
- enterprise policy can disable;
- user can downgrade anytime.

Fast Support must never mean full machine access.

### 10.3 Capabilities

Use narrow capabilities:

```txt
workspace.summary.read
workspace.file.safe_metadata.read
workspace.file.config.read
workspace.file.source.read
workspace.file.log.read
workspace.git.status.read
workspace.terminal.snapshot.read
localhost.port.detect
localhost.port.health.read
localhost.port.response_metadata.read
localhost.port.response_body.read
browser.console.read
browser.network_summary.read
activity.read
```

Do not use broad capabilities:

```txt
filesystem.read
localhost.proxy
machine.inspect
browser.control
agent.full_access
```

### 10.4 Actor Separation

Every request must name its actor:

```txt
user_browser
vectant_ai
support_agent
system
org_admin
```

The UI must show this plainly:

```txt
Vectant AI requested src/App.tsx.
Support agent Maria requested the last 100 log lines.
Your browser requested localhost:5173 preview.
```

Actor identity affects approval. A permission granted to the user's browser is not automatically granted to Vectant AI or support staff.

---

## 11. Data Classification

### 11.1 Classification Levels

| Level | Name | Examples | Default |
|---|---|---|---|
| L0 | Public/empty | framework name, package manager type | automatic in Balanced |
| L1 | Low-risk metadata | dependency summary, scripts summary, git branch | automatic in Balanced, visible log |
| L2 | Project context | selected source/config files | approval or selected scope |
| L3 | Sensitive-likely | logs, terminal output, config with URLs | redact + review |
| L4 | Secret/private | `.env`, credentials, tokens | block |
| L5 | Forbidden | browser profiles, SSH private keys, password stores | block, no override in MVP |

### 11.2 File Categories

| File/category | Level | MVP action |
|---|---:|---|
| `package.json` | L1 | allow visible summary/full if small |
| lockfiles | L1/L2 | summary preferred, full only with size cap |
| `tsconfig.json` | L1/L2 | allow with visibility |
| `vite.config.*` | L2 | allow after visible inclusion or approval |
| `next.config.*` | L2 | allow after visible inclusion or approval |
| `tailwind.config.*` | L2 | allow after visible inclusion or approval |
| selected source file | L2 | ask unless preselected for session |
| logs | L3 | redact + ask |
| terminal snapshot | L3 | redact + ask |
| `.env`, `.env.*` | L4 | block |
| private keys | L5 | block |
| browser profiles | L5 | block |
| database dumps | L5 | block |
| archives | L4/L5 | block in MVP |
| binaries/executables | L5 | block |
| generated build output | L2/L3 | ignore by default |
| dependency folders | L2/L3/huge | ignore by default |

---

## 12. Filesystem Access Plan

### 12.1 Workspace Selection

User explicitly chooses one workspace folder.

UI copy:

```txt
Connected workspace:
C:\Users\Kaloyan\projects\vectant-app

Vectant can only request files inside this folder.
Sensitive files are still blocked.
Nothing outside this folder is available through Local Support.
```

### 12.2 Path Resolution Algorithm

For every path request:

1. Treat request path as workspace-relative only.
2. Reject absolute paths from cloud requests.
3. Normalize separators.
4. Reject NUL bytes and invalid encodings.
5. Resolve `.` and `..`.
6. Join against canonical workspace root.
7. Resolve symlinks/junctions/reparse points.
8. Check final canonical target remains inside canonical workspace root.
9. Reject device paths, named pipes, UNC paths, and mount escapes.
10. Open file safely.
11. Re-check file identity after open where possible.
12. Confirm regular file.
13. Enforce size/type limits.
14. Classify and scan before send.

### 12.3 TOCTOU Controls

To reduce time-of-check/time-of-use races:

- resolve and check path immediately before open;
- prefer APIs that avoid following symlinks where possible for blocked classes;
- after open, compare file metadata/inode/file ID with the checked target where supported;
- cap read size from file descriptor, not path;
- abort if metadata changes during read for sensitive classes;
- do not cache path decisions without file identity.

### 12.4 Default Ignored/Blocked Paths

Block or ignore by default:

```txt
.env
.env.*
*.pem
*.key
*.p12
*.pfx
*.crt
*.cer
*.der
id_rsa
id_ed25519
id_ecdsa
known_hosts
.ssh/
.aws/
.gcp/
.azure/
.kube/
.docker/
.npmrc
.pypirc
.netrc
.git-credentials
.git/config              # safe summary only, never tokenized remotes
.DS_Store
Thumbs.db
node_modules/
vendor/
dist/
build/
.next/
.nuxt/
coverage/
.git/objects/
.git/logs/
.git/hooks/
.idea/
.vscode/settings.json    # scan before any summary
*.sqlite
*.db
*.dump
*.bak
*.sql
*.tar
*.gz
*.zip
*.7z
*.rar
*.exe
*.dll
*.dylib
*.so
*.bin
browser profiles
password stores
```

### 12.5 Allowlisted Low-Risk Metadata

Balanced mode may summarize:

```txt
package.json
pnpm-lock.yaml summary
yarn.lock summary
package-lock.json summary
bun.lockb summary
requirements.txt
pyproject.toml
Cargo.toml
go.mod
composer.json
Gemfile
README.md first section if small
Dockerfile metadata only
framework config summary
```

Prefer summaries over raw large files.

### 12.6 Source File Access

Rules:

- no automatic whole-repo upload;
- user can approve individual source files;
- user can approve folder scope for current session only;
- scope approval must show included patterns and exclusions;
- generated/minified files ignored;
- scanner runs before send;
- exact file path, size, classification, and redactions shown;
- large files require approval.

### 12.7 Logs and Terminal Snapshots

Logs are L3 by default.

Rules:

- never auto-send in Balanced;
- cap line count and byte count;
- default to recent lines only;
- scanner required;
- redaction preview required;
- user can trim before sending;
- preserve redaction markers;
- block if unsafe after redaction.

Suggested prompt:

```txt
Vectant wants to read the last 200 lines of your Vite dev server log.
Potential secrets will be redacted before anything is sent.
Review the preview before approving.
```

### 12.8 Size Limits

```txt
Automatic metadata file max: 128 KB
Automatic config file max: 256 KB
Approval-gated source file max: 1 MB
Approval-gated log max: 512 KB
Hard block without future special flow: 5 MB
Full repo upload: unsupported
```

### 12.9 Binary and Archive Files

MVP blocks:

- binaries;
- executables;
- archives;
- PDFs;
- images;
- database files;
- memory dumps;
- crash dumps;
- compiled artifacts.

Reason: binary/archive content is difficult to classify safely, can be huge, and may hide secrets.

Future diagnostic bundles require a separate review flow.

---

## 13. Secret Detection and Redaction

### 13.1 Scanner Requirements

Detect:

- API keys;
- private keys;
- OAuth access/refresh tokens;
- JWTs;
- database URLs;
- cloud credentials;
- SSH keys;
- package registry tokens;
- webhook secrets;
- GitHub/GitLab tokens;
- Slack/Discord tokens;
- AI provider API keys;
- Firebase service account keys;
- connection strings;
- Basic Auth headers;
- Bearer tokens;
- cookies;
- session IDs;
- high-entropy key/value pairs.

### 13.2 Scanner Strategy

Use layered detection:

1. path/filename rules;
2. structured parsers for `.json`, `.env`, `.yaml`, `.toml`, `.ini`;
3. known token regexes;
4. entropy scanning;
5. key-name heuristics;
6. URL credential parser;
7. header parser;
8. JWT parser;
9. cloud credential recognizers;
10. denylist of sensitive key names.

### 13.3 Block vs Redact

Block entire item when:

- private key detected;
- cloud credential file detected;
- `.env` requested;
- browser/password store requested;
- scanner fails;
- confidence is high and redaction cannot guarantee safety;
- file path is forbidden.

Redact + review when:

- logs contain bearer tokens;
- config contains database URL with password;
- stack trace contains Authorization header;
- response body contains cookie or token-like strings.

Allow only when:

- file class is allowed;
- no sensitive content found;
- permission mode permits;
- user approved if required.

### 13.4 Redaction Format

Use stable markers:

```txt
[REDACTED:API_KEY:sha256_8=1a2b3c4d]
[REDACTED:JWT:sha256_8=9f8e7d6c]
[REDACTED:DB_PASSWORD]
[REDACTED:COOKIE]
```

The hash helps correlate repeated secrets without exposing them.

Do not log raw values locally or in cloud telemetry.

### 13.5 Review-Before-Send

For L3 items show:

- file/log name;
- line count;
- byte count;
- redacted preview;
- redaction summary;
- destination session;
- requesting actor;
- approve once;
- deny;
- always block item;
- open permissions.

Dangerous L4/L5 items must not show an approve option in MVP.

### 13.6 Scanner Quality Gates

Before beta:

- fixture suite for all supported secret types;
- scanner failure tests;
- false-negative review for common framework files;
- no raw fixture secret in local logs;
- no raw fixture secret in cloud logs;
- scanner version included in audit record;
- security team signs off on block/redact thresholds.

---

## 14. Local Port and Browser Preview Plan

### 14.1 Core Rule

Local port support is a separate high-risk capability. Do not treat it as part of filesystem access.

A user may approve:

```txt
Browser preview for me
```

without approving:

```txt
Vectant AI can read this page
Vectant support can inspect this page
Vectant can click this page
Vectant can receive response bodies
```

### 14.2 Never Use Path-Prefix Preview Routing

Do not expose local apps like:

```txt
https://app.vectant.com/local/br_abc123/port/3000/foo
```

Problems:

- absolute paths resolve to the main app origin;
- Vite/Next/HMR paths break;
- `/api/foo` can hit Vectant instead of local app;
- OAuth callbacks and redirects become confused;
- cookies can collide with Vectant cookies;
- service workers become dangerous;
- infrastructure logs record sensitive local app paths under the main app.

Use host-based preview:

```txt
https://br-{bridgePublicId}-p{port}-{nonce}.vectant-preview.dev/foo
```

Rules:

- hostname identifies bridge/session/port;
- target path remains unchanged;
- preview domain is separate from main app;
- preview host is session-scoped and port-scoped;
- preview token is short-lived;
- revoke invalidates host/token.

### 14.3 Preview Origin Isolation

Example:

```txt
Main app:       https://app.vectant.com
Preview domain: https://*.vectant-preview.dev
```

Isolation goals:

- no main Vectant auth cookies sent to preview;
- local app cookies never apply to main Vectant app;
- local app JS cannot access Vectant localStorage;
- preview has separate CSP and permissions policy;
- service workers blocked by default;
- logs scrub preview traffic separately.

### 14.4 Preview Framing and Browser Execution Risk

Preview content is local app content running in the user's browser. Treat it as untrusted content.

Rules:

- render preview inside a sandboxed iframe where possible;
- do not grant `allow-top-navigation` except explicit user action;
- do not grant camera/mic/geolocation/USB/serial/HID/payment;
- force `Referrer-Policy: no-referrer`;
- force `Cache-Control: no-store`;
- do not expose Vectant tokens to preview frame;
- do not run preview content on `app.vectant.com`;
- do not inject privileged Vectant scripts into preview content unless separately threat-modeled.

Suggested iframe sandbox:

```txt
sandbox="allow-scripts allow-forms allow-same-origin"
```

Do not add `allow-popups`, `allow-top-navigation`, or permission APIs by default.

### 14.5 Port Discovery

MVP:

- no broad scanning;
- user manually adds a port;
- app may suggest common dev ports only after consent;
- process info is local-only by default;
- user approves each port.

Suggested common ports:

```txt
3000 React/Next
5173 Vite
5174 Vite alternate
8080 common dev server
4200 Angular
5000 Flask
8000 Django/Python
11434 Ollama
```

### 14.6 Namespace Clarity

Explain what `localhost` means.

Examples:

```txt
Bridge is running on: Windows host
Loopback scope: Windows localhost
```

```txt
Bridge is running inside: WSL Ubuntu
Loopback scope: WSL localhost, not Windows host localhost
```

```txt
Bridge is running inside: Docker container
Loopback scope: container localhost
```

### 14.7 Port Approval UI

Show:

- host;
- port;
- preview host;
- detected service type;
- process name if safely available;
- PID if safely available;
- command/executable hash if available;
- requested capability;
- browser preview permission;
- agent read permission;
- agent interaction permission;
- body sharing permission;
- screenshot permission;
- console/network summary permission;
- TTL;
- expiration behavior;
- revoke button.

Default approval state:

```txt
[x] Browser preview for me
[ ] Let Vectant AI read page content
[ ] Let a support agent read page content
[ ] Let Vectant AI inspect console/network summaries
[ ] Let Vectant AI click or interact with the page
[ ] Send response bodies after review
[ ] Send screenshots after review
```

### 14.8 Split Port Permissions

Store separate flags:

```json
{
  "port": 5173,
  "target_host": "127.0.0.1",
  "preview_host": "br-k82md-p5173-r9q2.vectant-preview.dev",
  "browser_preview_allowed": true,
  "agent_read_allowed": false,
  "support_agent_read_allowed": false,
  "agent_interact_allowed": false,
  "send_response_body_allowed": false,
  "send_screenshot_allowed": false,
  "send_console_errors_allowed": false,
  "state_changing_methods_allowed": false,
  "expires_at": "session_end",
  "invalidate_on_port_close": true,
  "invalidate_on_process_change": true
}
```

### 14.9 Port Identity and Lifetime

A port number is not identity.

Invalidate approval when:

- bridge restarts;
- session disconnects;
- port closes;
- PID changes;
- executable hash changes;
- command hash changes;
- working directory hash changes;
- preview host expires;
- org policy changes;
- permission mode becomes stricter;
- TTL expires.

Persistent port approvals are disabled in MVP.

### 14.10 Allowed Targets

Allowed:

```txt
127.0.0.1
[::1]
localhost only after resolving to loopback
```

Blocked:

```txt
0.0.0.0
public IPs
private LAN ranges
link-local addresses
cloud metadata IPs
unix sockets
named pipes
file:// URLs
custom schemes
```

Validate final resolved IP, not the string.

### 14.11 DNS and URL Canonicalization

Before proxying:

- parse URL with a strict URL parser;
- reject userinfo (`http://user:pass@host`);
- normalize host;
- handle IPv6 literals;
- handle IPv4 integer/hex/octal forms by rejecting them;
- reject punycode tricks unless not relevant to loopback allowlist;
- resolve `localhost` each time or pin safely;
- verify final address is loopback;
- re-check after redirect;
- block DNS rebinding opportunities by not allowing arbitrary hostnames.

### 14.12 HTTP Method Rules

MVP allowed:

```txt
GET for browser preview
HEAD for health/status
OPTIONS only where needed and safe
```

MVP blocked:

```txt
POST
PUT
PATCH
DELETE
TRACE
CONNECT
```

No file upload through the preview bridge.

### 14.13 Request Header Policy

Never forward:

```txt
Cookie
Authorization
Proxy-Authorization
X-API-Key
X-Auth-Token
X-CSRF-Token from Vectant app
Forwarded
X-Forwarded-For
X-Real-IP
Sec-* headers not meaningful to target
```

Set only safe bridge headers:

```txt
X-Vectant-Preview: 1
X-Vectant-Preview-Session: opaque-preview-session-id
X-Vectant-Preview-Mode: browser|agent-read|health
```

Do not include raw user ID, org ID, email, device ID, or workspace path.

### 14.14 Response Header Policy

Dangerous headers:

```txt
Set-Cookie
Location
Service-Worker-Allowed
Clear-Site-Data
Content-Security-Policy
X-Frame-Options
Cross-Origin-Opener-Policy
Cross-Origin-Embedder-Policy
Cross-Origin-Resource-Policy
Alt-Svc
Report-To
NEL
Link
Refresh
```

Policy:

| Header | Behavior |
|---|---|
| `Set-Cookie` | Strip by default. Optional future isolated cookie mode only. |
| `Location` | Rewrite same approved target; block unsafe/private/file/custom redirects. |
| `Service-Worker-Allowed` | Strip. |
| Service worker script responses | Block by default. |
| `Clear-Site-Data` | Strip except controlled revocation cleanup. |
| `Content-Security-Policy` | Replace or merge with preview-safe CSP. |
| `X-Frame-Options` | Enforce Vectant preview framing policy. |
| COOP/COEP/CORP | Strip/rewrite for preview isolation. |
| `Alt-Svc` | Strip. |
| `Report-To`/`NEL` | Strip. |
| `Link` | Strip/rewrite if private/local target. |
| `Refresh` | Block/rewrite like `Location`. |
| Hop-by-hop | Strip dynamically and statically. |
| Cache | Force `no-store`. |

Edge-added headers:

```txt
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=(), hid=()
```

### 14.15 Cookie Policy

MVP:

```txt
Set-Cookie from local app: stripped
Cookie to local app: not forwarded
Vectant auth cookies: never sent to preview target
```

Future isolated-cookie mode:

- per approved preview host;
- host-only cookies;
- strip `Domain`;
- force `Secure`;
- `HttpOnly` preserved;
- `SameSite=Lax` or stricter where compatible;
- clear on revoke;
- never allow cookies for `app.vectant.com`, `.vectant.com`, or other preview hosts.

### 14.16 Redirect Rules

| Location | Behavior |
|---|---|
| `/foo` | rewrite to same preview host `/foo` |
| `foo` | resolve relative to current preview path |
| `http://127.0.0.1:3000/foo` | rewrite if same approved target |
| `http://localhost:3000/foo` | resolve and rewrite if same approved target |
| `http://[::1]:3000/foo` | rewrite if same approved target |
| `http://192.168.1.1/` | block/interstitial, no auto-follow |
| `http://10.0.0.5/` | block/interstitial, no auto-follow |
| `http://169.254.169.254/` | block always |
| `file:///...` | block always |
| custom schemes | block unless outside bridge |
| external https | normal external navigation only, not proxied, no local referrer |

### 14.17 Service Worker Policy

MVP:

- block service worker script requests;
- strip `Service-Worker-Allowed`;
- use short-lived preview origins;
- clear site data on revoke where possible;
- never allow service workers on main app origin.

Future exception requires explicit isolated throwaway origin and warning.

### 14.18 WebSocket Policy

WebSockets are disabled by default.

If needed for Vite/Next HMR:

- separate approval;
- browser-only unless agent access separately approved;
- validate Origin;
- require preview token;
- bind to approved host/port/path;
- allowlist HMR paths;
- strip cookies;
- cap message size;
- cap stream lifetime;
- log open/close/bytes;
- no agent WebSocket access in MVP.

### 14.19 HTTP Parser and Smuggling Defenses

The preview gateway and bridge must reject ambiguous HTTP messages:

- conflicting `Content-Length` headers;
- both `Content-Length` and `Transfer-Encoding` where unsafe;
- invalid chunked encoding;
- obs-fold headers;
- invalid header names;
- oversized headers;
- absolute-form requests unless explicitly handled;
- `CONNECT` always;
- `Upgrade` unless approved WebSocket path;
- hop-by-hop headers named by `Connection`.

Hop-by-hop stripping algorithm:

1. Parse `Connection` header.
2. Split listed names.
3. Normalize case.
4. Remove every listed header.
5. Remove standard hop-by-hop headers.
6. Apply request/response policy.

Always remove:

```txt
Connection
Keep-Alive
Proxy-Authenticate
Proxy-Authorization
TE
Trailer
Transfer-Encoding
Upgrade
```

### 14.20 Flow Control and Backpressure

Use per-stream and per-bridge flow-control windows.

Example:

```json
{
  "type": "proxy.window_update",
  "stream_id": "s_123",
  "bytes": 262144
}
```

Defaults:

```txt
max frame size: 64 KB
initial stream window: 256 KB
max stream window: 1 MB
max buffered bytes/stream: 512 KB
max buffered bytes/bridge: 8 MB
stream idle timeout: 30 sec
HTTP stream lifetime: 5 min max
```

### 14.21 Concurrency Limits

```txt
max active HTTP streams/bridge: 16
max active WebSockets/bridge: 4
max active streams/preview host: 8
max active streams/user: 32
max requests/min/bridge: 120
max requests/min/preview host: 60
max failed requests/min/bridge: 20
max approved body preview: 1 MB
max buffered bytes/user: 32 MB
```

Repeated violations log security events and may pause the session.

---

## 15. Agent Read and Interaction Policy

### 15.1 MVP Position

MVP should allow:

- user browser preview;
- health/status checks;
- safe response metadata if approved.

MVP should not allow:

- Vectant AI reading full HTML;
- support agents reading full HTML;
- AI clicking or interacting;
- form submission;
- network scraping;
- screenshot sending;
- console log streaming;
- WebSocket inspection.

### 15.2 Future Agent Read

If later added, agent read must require separate approval per port and actor.

Approval copy:

```txt
Allow Vectant AI to read this local page?

This lets Vectant receive selected visible text, page metadata, console error summaries, and network summaries from http://127.0.0.1:5173 during this support session.
It does not allow clicking, form submission, POST requests, file access, cookies, or access to other ports.
```

### 15.3 Future Agent Interaction

Agent interaction is a separate high-risk feature.

Before shipping it requires:

- separate threat model;
- recorded user approval;
- per-action review or live visible control;
- no hidden interactions;
- no form submission by default;
- no credential fields;
- no destructive actions;
- no POST/PUT/PATCH/DELETE without special review;
- session recording or detailed action log;
- enterprise disable by default.

---

## 16. Frontend Transparency Plan

### 16.1 Design Principle

The frontend should not merely say “connected.” It should show proof.

The user must see:

- what is connected;
- what is available;
- what is ignored;
- what was requested;
- what was blocked;
- what was redacted;
- what was sent;
- what can happen automatically;
- how to stop it.

### 16.2 Persistent Banner

States:

```txt
Disconnected
Installed but not paired
Paired, no workspace selected
Connected
Paused
Fast Support active
Approval needed
Error
Update required
Org policy blocked
```

Connected copy:

```txt
Local Support Connected
Workspace: vectant-app
Mode: Balanced
Approved ports: 5173
Last context sent: 14 seconds ago
[Review activity] [Pause] [Disconnect]
```

Fast Support copy:

```txt
Fast Support is active for this session
Vectant may automatically use safe project metadata from vectant-app.
Secrets are still blocked. Source files, logs, and response bodies still require approval.
Expires in 24 minutes.
[Switch to Balanced] [Pause] [Disconnect]
```

### 16.3 Overview Screen

Show:

- connection state;
- paired Vectant account;
- current support session;
- device name;
- app version;
- selected workspace;
- permission mode;
- approved ports;
- session duration;
- automatic context setting;
- last request;
- last sent payload;
- pause/disconnect controls.

### 16.4 Context Inventory

Sections:

1. safe metadata;
2. approved files;
3. ignored files;
4. blocked sensitive files;
5. logs;
6. local services;
7. git/project state;
8. recently sent payloads.

Each item shows:

- path/name;
- type;
- classification;
- size;
- last read time;
- sent/not sent;
- redaction count;
- approval state;
- revoke/remove action.

### 16.5 Sent Payload History

Every sent record shows:

- timestamp;
- trigger;
- actor;
- reason;
- data type;
- file path or port URL;
- bytes sent;
- hash of sent content;
- redaction summary;
- preview of exactly sent content;
- policy reason;
- approval receipt if applicable;
- revoke future access.

Example:

```txt
Sent to Vectant
20:13:44

Requested by: Vectant AI
Reason: Debug Vite startup error
Payload: vite.config.ts
Size: 2.4 KB
Redactions: 0
Allowed because: You approved config files for this session.

[View sent content] [Stop sharing this file] [Report issue]
```

### 16.6 Review-Before-Send

Required details:

- plain-language reason;
- exact requested item;
- requesting actor;
- risk level;
- preview of redacted content;
- redaction count;
- destination session;
- approval duration;
- deny/block controls.

Buttons:

```txt
Approve once
Approve for this session
Deny
Always block this item
Open permissions
```

L4/L5 items show no approve button.

### 16.7 Activity Log

Filters:

- all;
- sent;
- blocked;
- redacted;
- approvals;
- ports;
- files;
- session events;
- errors;
- security warnings.

Good entry:

```txt
Blocked .env
Vectant AI requested .env, but secret files are blocked by local policy.
Nothing was sent.
```

Bad entry:

```txt
GET /context/file 403
```

### 16.8 Sensitive Items Screen

Show protected items and why.

Example:

```txt
Sensitive items protected

.env              blocked: secret file pattern
.aws/             blocked: cloud credentials folder
id_ed25519        blocked: private SSH key
.npmrc            blocked: package registry token risk

Vectant cannot read these files through Local Support.
```

### 16.9 Local Ports Screen

Show:

- approved ports;
- detected but unapproved ports;
- preview host;
- capability flags;
- method restrictions;
- body sharing status;
- last request;
- revoke button.

### 16.10 UX Acceptance Tests

The UI is not ready unless test users can answer quickly:

1. What workspace is connected?
2. What files has Vectant seen?
3. What files were blocked?
4. Was `.env` sent?
5. Which ports are approved?
6. Can Vectant AI read the preview page?
7. Can support staff read the preview page?
8. How do you pause?
9. How do you disconnect?
10. What was redacted?
11. What did Fast Support do automatically?
12. How do you revoke a port?
13. How do you delete local activity history?

Failure threshold: if more than 10% of users cannot answer these after onboarding, do not ship public beta.

---

## 17. Audit Logging, Privacy, and Retention

### 17.1 What to Log

Log:

- app start/stop;
- pairing started/completed/failed;
- workspace selected;
- permission mode changed;
- file requested/allowed/denied/redacted;
- approval prompt shown;
- approval granted/denied;
- port detected/approved/revoked;
- preview request allowed/denied;
- redirect blocked;
- header stripped;
- service worker blocked;
- session paused/resumed/disconnected;
- policy update;
- scanner error;
- suspicious request;
- invalid token;
- bad origin;
- rate limit.

### 17.2 What Not to Log

Do not log:

- raw secrets;
- full tokens;
- cookies;
- Authorization headers;
- raw private paths outside workspace;
- raw file content in security logs;
- local response bodies;
- OAuth codes;
- query strings by default;
- browser profile paths;
- full process command lines in cloud logs.

### 17.3 Infrastructure Log Scrubbing

Scrub at all layers:

- app logs;
- reverse proxy;
- CDN/edge;
- load balancer;
- WebSocket gateway;
- APM traces;
- exception reporting;
- analytics;
- frontend telemetry;
- support tools.

Never log full preview URLs.

Bad:

```txt
GET /login/callback?code=abc123&state=secret on br-k82md-p5173-r9q2.vectant-preview.dev
```

Better:

```txt
GET [preview_host_hash] path_category=auth_callback query_present=true query_scrubbed=true
```

### 17.4 Retention Defaults

```txt
Local activity metadata: 30 days
Sent content preview: current session only by default
Approval records: current session only
Pairing token: memory only
Preview cookies: stripped; if future isolated mode, cleared on revoke
Cloud context: support policy or no-retention mode
```

### 17.5 User Controls

User can:

- disconnect;
- pause;
- delete local activity history;
- delete saved approvals;
- remove workspace history;
- export audit log;
- request cloud deletion where supported.

### 17.6 Tamper-Evident Enterprise Export

Enterprise export includes:

- hash-chained events;
- signed bundle;
- app version;
- policy version;
- scanner version;
- payload hashes;
- approval receipts;
- denials;
- redaction counts;
- no raw secrets.

---

## 18. Org and Workspace Controls Required Before Public Beta

These are pre-beta requirements, not later enterprise polish.

Required policies:

```txt
localBridge.enabled
localBridge.allowedUsers
localBridge.allowedGroups
localBridge.blockedUsers
localBridge.browserPreviewAllowed
localBridge.agentAccessAllowed
localBridge.supportAgentReadAllowed
localBridge.agentInteractionAllowed
localBridge.maxAllowedPorts
localBridge.allowedPortRanges
localBridge.blockedPortRanges
localBridge.requireReauthForPairing
localBridge.requireDeviceKeypair
localBridge.minAppVersion
localBridge.allowedAppChannels
localBridge.allowPersistentPortApprovals
localBridge.allowWebSocketPreview
localBridge.allowServiceWorkersInPreview
localBridge.allowedPreviewDomains
localBridge.noRetentionRequired
localBridge.localOnlyModeRequired
localBridge.fastSupportAllowed
```

Safe beta defaults:

```json
{
  "localBridge.enabled": false,
  "localBridge.browserPreviewAllowed": true,
  "localBridge.agentAccessAllowed": false,
  "localBridge.supportAgentReadAllowed": false,
  "localBridge.agentInteractionAllowed": false,
  "localBridge.maxAllowedPorts": 3,
  "localBridge.requireReauthForPairing": true,
  "localBridge.requireDeviceKeypair": true,
  "localBridge.allowPersistentPortApprovals": false,
  "localBridge.allowWebSocketPreview": false,
  "localBridge.allowServiceWorkersInPreview": false,
  "localBridge.fastSupportAllowed": false
}
```

Admin UI must show:

- paired devices;
- app versions;
- last active time;
- policy version;
- active sessions;
- approved ports count;
- whether agent access is disabled;
- revoke controls.

User UI must show org restrictions:

```txt
Your organization allows browser preview but blocks Vectant AI from reading local page contents.
```

---

## 19. Update, Distribution, and Supply Chain Security

### 19.1 Installer Requirements

Installer must:

- be code signed;
- verify package integrity;
- install with least privilege;
- avoid admin rights;
- explain local support clearly;
- not auto-start hidden in MVP;
- uninstall cleanly;
- remove session tokens on uninstall;
- leave no hidden daemon running after uninstall.

### 19.2 Auto-Update Requirements

Updates must:

- be signed;
- verify signatures before install;
- prevent downgrade;
- support emergency revocation;
- show update status;
- allow enterprise pinning;
- fail closed if verification fails.

### 19.3 Version Enforcement

Cloud refuses pairing with:

- known vulnerable versions;
- unsupported protocol versions;
- unsigned builds outside dev;
- tampered build metadata;
- disabled channels.

Local UI copy:

```txt
Update required
This version can no longer connect because it is outdated or insecure.
```

### 19.4 Build Supply Chain

Before beta:

- CI secret scanning;
- dependency vulnerability scanning;
- SBOM generated for desktop app and backend;
- signed release artifacts;
- protected release branches;
- two-person review for update signing changes;
- reproducible builds where practical;
- dependency pinning;
- update signing keys stored in hardened environment;
- emergency signing key rotation playbook.

---

## 20. Desktop App Hardening

### 20.1 Process Model

Separate:

- UI process;
- local API daemon;
- scanner worker;
- file adapter;
- port adapter;
- update process.

Keep privileged operations out of renderer/UI.

### 20.2 Least Privilege

Run as normal user.

Do not request:

- admin/root;
- disk-wide permission prompts;
- accessibility permissions;
- screen recording;
- terminal automation;
- browser profile access;
- keychain access beyond app-owned secrets.

### 20.3 IPC Hardening

IPC rules:

- schema validate every message;
- narrow command names;
- no raw eval;
- no shell;
- no generic file path operation;
- no direct renderer filesystem access;
- denied IPC attempts logged;
- renderer never receives session private key or long-lived token.

### 20.4 CSP

Example desktop UI CSP:

```txt
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self' https://api.vectant.com http://127.0.0.1:*;
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
```

Adjust production domains precisely.

---

## 21. Security Operations and Incident Response

### 21.1 Monitoring

Alert on:

- repeated denied secret requests;
- repeated path traversal attempts;
- repeated bad origins;
- high failed pairing attempts;
- suspicious support-agent request patterns;
- preview redirect blocks to metadata/private IPs;
- old app versions attempting pairing;
- scanner failures;
- unusually high preview traffic;
- rate limit violations.

### 21.2 Emergency Controls

Must exist before beta:

- global feature kill switch;
- org-level kill switch;
- min-version bump;
- preview gateway disable;
- agent access disable;
- pairing disable;
- vulnerable app version blocklist;
- update revocation.

### 21.3 Incident Playbook

For suspected data leak:

1. disable affected capability;
2. revoke active sessions;
3. block vulnerable versions;
4. preserve audit logs;
5. identify affected users/orgs;
6. determine what payload hashes/content classes were sent;
7. rotate signing/session keys if needed;
8. notify according to policy/legal requirements;
9. publish fixed version;
10. add regression tests.

---

## 22. MVP Scope

### 22.1 MVP Must Include

- local app;
- loopback-only local API;
- secure pairing;
- device keypair;
- pairing fingerprint;
- one support session;
- one workspace;
- Balanced mode;
- Manual mode;
- visible banner;
- context inventory;
- activity log;
- blocked sensitive items screen;
- local policy engine;
- workspace boundary enforcement;
- default denylist;
- scanner/redactor;
- review-before-send;
- pause/disconnect;
- manual port approval;
- host-based preview domain;
- browser preview only;
- health/status checks;
- no write access;
- no command execution;
- signed installer/update plan;
- org kill switch.

### 22.2 MVP Must Not Include

- Fast Support unless separately approved;
- agent read;
- agent interaction;
- POST/PUT/PATCH/DELETE;
- arbitrary WebSockets;
- service workers;
- isolated cookie mode unless heavily tested;
- persistent port approvals;
- repository upload;
- shell commands;
- filesystem writes;
- background always-on mode.

### 22.3 MVP Success Criteria

MVP is successful if:

- support can debug common project setup issues;
- users can clearly see what was sent;
- secrets are blocked locally;
- `.env` and credential fixtures never leave the machine;
- local API cannot be called by random websites;
- preview does not expose main Vectant cookies;
- unapproved ports cannot be reached;
- support/AI cannot read preview contents without separate permission;
- user can pause/disconnect instantly;
- security tests pass.

---

## 23. Phase Plan

### Phase 0 — Security Design Lock

Deliverables:

- finalized threat model;
- architecture diagrams;
- trust boundaries;
- policy model;
- pairing protocol spec;
- preview gateway spec;
- data retention spec;
- security acceptance criteria;
- red-team test list.

Exit criteria:

- security owner signs off;
- product agrees to MVP exclusions;
- org kill switch design approved.

### Phase 1 — Local Agent Prototype

Build:

- loopback-only daemon;
- workspace picker;
- path resolver;
- `.env` blocking;
- denylist;
- local activity log;
- no cloud connection yet.

Exit criteria:

- path traversal tests pass;
- symlink/junction tests pass;
- `.env` cannot be read;
- local API not callable without token.

### Phase 2 — Pairing and Session Control

Build:

- pairing code;
- fingerprint;
- device keypair;
- challenge signing;
- session token;
- pause/disconnect;
- version enforcement.

Exit criteria:

- replay attempts fail;
- mismatched fingerprint rejected;
- expired code rejected;
- revoke closes session.

### Phase 3 — Transparency Frontend

Build:

- persistent banner;
- overview;
- context inventory;
- sent payload history;
- blocked items;
- approval modals;
- local ports screen.

Exit criteria:

- UX test users can answer transparency questions;
- disconnect visible everywhere;
- sent content view works.

### Phase 4 — Scanner and Redaction

Build:

- scanner engine;
- redaction layer;
- fixtures;
- review-before-send;
- scanner version logging.

Exit criteria:

- fixture secrets blocked/redacted;
- scanner failure denies;
- no raw secret in logs.

### Phase 5 — Host-Based Preview MVP

Build:

- isolated preview domain;
- manual port approval;
- preview token;
- request/response header policy;
- redirect blocking/rewrite;
- service worker blocking;
- flow control;
- browser preview only.

Exit criteria:

- no path-prefix routing;
- main auth cookie not sent;
- unapproved ports denied;
- private/metadata redirects blocked;
- service worker tests pass.

### Phase 6 — Internal Beta

Build:

- org kill switch;
- min app version;
- admin visibility;
- security telemetry;
- emergency disable;
- release signing.

Exit criteria:

- red team complete;
- incident playbook tested;
- security acceptance checklist complete.

### Phase 7 — Future Agent Read

Only after separate security review.

Deliverables:

- actor-specific approval;
- no interaction;
- data minimization;
- response summaries;
- screenshots/logs review;
- enterprise disabled by default.

### Phase 8 — Future Enterprise Expansion

Possible later:

- device posture;
- managed policies;
- audit bundles;
- no-retention mode;
- approved workspace roots;
- SIEM export.

---

## 24. Implementation Interfaces

### 24.1 Policy Decision Interface

```ts
type PolicyDecision = {
  decision: 'allow' | 'deny' | 'approval_required' | 'redact_then_approval';
  reason: string;
  classification: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  requiredApproval?: {
    scope: 'once' | 'session';
    message: string;
  };
  redactionRequired: boolean;
  logUserVisible: true;
};
```

### 24.2 File Request Schema

```json
{
  "request_id": "req_123",
  "session_id": "sess_123",
  "workspace_id": "wk_123",
  "capability": "workspace.file.source.read",
  "path": "src/App.tsx",
  "max_bytes": 262144,
  "reason": "Debug runtime error",
  "actor": "vectant_ai",
  "expires_at": "2026-07-04T17:01:00Z"
}
```

### 24.3 File Response Schema

```json
{
  "request_id": "req_123",
  "decision": "allowed",
  "path_display": "src/App.tsx",
  "classification": "L2",
  "bytes_sent": 4820,
  "content_sha256": "sha256:...",
  "redactions": [],
  "scanner_version": "scanner-2026.07.04",
  "policy_version": "2026.07.04"
}
```

### 24.4 Denied Response Schema

```json
{
  "request_id": "req_123",
  "decision": "denied",
  "path_display": ".env",
  "classification": "L4",
  "reason": "blocked_secret_file_pattern",
  "bytes_sent": 0,
  "user_visible_message": "Blocked .env. This file usually contains secrets. Nothing was sent."
}
```

### 24.5 Port Approval Schema

```json
{
  "port": 5173,
  "target_host": "127.0.0.1",
  "preview_host": "br-k82md-p5173-r9q2.vectant-preview.dev",
  "browser_preview_allowed": true,
  "agent_read_allowed": false,
  "support_agent_read_allowed": false,
  "agent_interact_allowed": false,
  "send_response_body_allowed": false,
  "state_changing_methods_allowed": false,
  "expires_at": "session_end",
  "process_identity_hash": "sha256:..."
}
```

---

## 25. Security Test Plan

### 25.1 Local API Tests

Test:

- no auth token;
- wrong token;
- expired token;
- replayed request ID;
- bad Origin;
- missing CSRF;
- cross-site Fetch Metadata;
- invalid schema;
- excessive body size;
- rate limit.

Expected: denied, no sensitive data, user-visible log when relevant.

### 25.2 Filesystem Tests

Test:

- `../` traversal;
- absolute path request;
- symlink escape;
- Windows junction escape;
- case-insensitive bypass;
- mount point escape;
- NUL byte;
- invalid Unicode;
- `.env` variants;
- `.aws/credentials`;
- `.ssh/id_ed25519`;
- huge file;
- sparse file;
- binary file;
- archive file;
- file swapped after approval.

Expected: blocked or approval-gated safely.

### 25.3 Secret Scanner Tests

Fixtures:

- fake GitHub token;
- fake OpenAI API key;
- fake JWT;
- fake AWS key;
- fake private key;
- fake database URL;
- fake cookie;
- fake Authorization header;
- fake npm token;
- fake Firebase service account.

Expected:

- redacted/blocked;
- no raw secret in output;
- no raw secret in local logs;
- no raw secret in cloud logs;
- scanner failure denies.

### 25.4 Preview Tests

Test:

- unapproved port;
- approved browser preview;
- agent read without approval;
- POST request;
- Authorization header;
- Cookie header;
- `Set-Cookie` for `.vectant.com`;
- redirect to LAN;
- redirect to metadata IP;
- redirect to file URL;
- service worker registration;
- WebSocket without approval;
- WebSocket bad Origin;
- huge response;
- binary response;
- conflicting `Content-Length`;
- chunked smuggling;
- `Connection` naming sensitive header.

Expected:

- risky requests denied;
- headers stripped;
- redirects blocked;
- body not sent to AI/support;
- all actions logged.

### 25.5 Frontend Tests

Ask users:

1. What is connected?
2. What has been sent?
3. What was blocked?
4. Did Vectant see `.env`?
5. Which ports are approved?
6. Can AI read the local preview?
7. How do you revoke approval?
8. How do you disconnect?
9. What was redacted?
10. What will happen automatically?

Expected: users answer correctly without reading docs.

### 25.6 Red Team Before Beta

Required red-team scenarios:

- malicious website localhost attack;
- compromised support session;
- malicious repo symlink farm;
- malicious local dev server;
- preview SSRF attempt;
- secret-heavy logs;
- update downgrade attempt;
- endpoint fuzzing;
- WebSocket abuse;
- confused-deputy approval flow.

No public beta until critical/high findings are fixed.

---

## 26. Risk Register

| Risk | Severity | Likelihood | Mitigation | Blocker |
|---|---:|---:|---|---|
| Secret leakage from files | Critical | Medium | denylist, scanner, approval, local enforcement | Yes |
| Malicious website calls local API | Critical | Medium | token, Origin, CSRF, Fetch Metadata | Yes |
| Symlink escape | Critical | Medium | canonicalization, revalidation | Yes |
| Preview SSRF/private network access | Critical | Medium | loopback-only, redirect blocks, URL canonicalization | Yes |
| Cookie/session confusion | Critical | Medium | preview domain isolation, cookie stripping | Yes |
| Service worker persistence | High | Medium | block by default, short-lived hosts | Yes |
| Agent reads preview unintentionally | High | Medium | separate permission, MVP disabled | Yes |
| User misunderstanding | High | High | persistent UI, sent history, UX tests | Yes |
| Logs leak tokens/PII | High | High | scanner, redaction, review | Yes |
| Insecure update | Critical | Low/Medium | signed updates, downgrade prevention | Yes |
| Electron/Tauri IPC abuse | Critical | Depends | isolation, schema validation, no generic APIs | Yes |
| Infrastructure logs leak URLs/tokens | High | Medium | log scrubbing, APM config tests | Yes |
| Enterprise overexposure | High | Medium | org kill switch, default disabled | Before beta |
| Fast Support overshares | High | Medium | exclude MVP or strict TTL/limits | Before enabling |

---

## 27. Release Blocker Checklist

### 27.1 Security Blockers

- [ ] Local API binds only to loopback.
- [ ] Non-loopback bind fails.
- [ ] Random local port.
- [ ] Auth required on all non-health endpoints.
- [ ] Origin validation.
- [ ] CSRF/signed nonce protection.
- [ ] Fetch Metadata checks.
- [ ] Pairing code TTL and rate limits.
- [ ] Device keypair challenge signing.
- [ ] Pairing fingerprint in browser and local app.
- [ ] Session TTL.
- [ ] Request replay protection.
- [ ] Workspace boundary enforcement.
- [ ] Symlink/junction escape tests.
- [ ] Denylist enforced locally.
- [ ] Scanner/redactor.
- [ ] Scanner failure denies.
- [ ] No shell execution.
- [ ] No filesystem writes.
- [ ] No full repo upload.
- [ ] No broad port scan.
- [ ] Manual port approval only.
- [ ] Host-based preview domain.
- [ ] No main Vectant cookies in preview.
- [ ] Response header policy.
- [ ] Redirect restrictions.
- [ ] Service workers blocked.
- [ ] Flow control and rate limits.
- [ ] Signed installer/update.
- [ ] Org kill switch.
- [ ] Emergency disable.

### 27.2 Frontend Transparency Blockers

- [ ] Persistent banner.
- [ ] Overview screen.
- [ ] Context inventory.
- [ ] Sent payload history.
- [ ] Blocked sensitive items.
- [ ] Redaction summaries.
- [ ] Review-before-send.
- [ ] Activity log.
- [ ] Local ports screen.
- [ ] Permission mode screen.
- [ ] Pause visible everywhere.
- [ ] Disconnect visible everywhere.
- [ ] Revoke controls.
- [ ] Export/delete local history.
- [ ] Clear actor identity on requests.
- [ ] Users can distinguish available vs sent.

### 27.3 Product Blockers

- [ ] Onboarding explains risks.
- [ ] Workspace picker complete.
- [ ] Balanced mode default.
- [ ] Manual mode available.
- [ ] Fast Support disabled or strictly controlled.
- [ ] Agent read disabled in MVP.
- [ ] Agent interaction disabled in MVP.
- [ ] Error states understandable.
- [ ] Uninstall stops local bridge.
- [ ] Update-required state implemented.

---

## 28. Example User-Facing Copy

### Install Explanation

```txt
Vectant Local Support helps debug your local project by sharing selected project context with this support session.

You choose the workspace.
You can see what is read.
Sensitive files are blocked locally.
You can pause or disconnect at any time.
```

### Workspace Selection

```txt
Choose the project folder Vectant can help with.

Vectant can only request files inside this folder.
Secret files like .env, SSH keys, and cloud credentials are blocked even inside this folder.
```

### Source File Approval

```txt
Vectant AI wants to read src/App.tsx to understand the error.

This file is inside your selected workspace.
No secrets were detected.

Approve once for this support session?
```

### Log Approval

```txt
Vectant wants to read the last 200 lines of your dev server log.

Logs can contain tokens, database URLs, or user data.
Local Support found and redacted 2 possible secrets.
Review the preview before sending.
```

### Blocked Secret

```txt
Blocked .env

This file usually contains secrets such as API keys or database passwords.
Local Support does not send .env files.
Nothing was sent to Vectant.
```

### Port Approval

```txt
Approve localhost:5173?

This looks like a Vite dev server.
You can preview it through Vectant using an isolated preview URL.
Vectant AI will not read the page unless you separately allow that.
Cookies and Authorization headers are not forwarded.
```

### Agent Read Approval

```txt
Allow Vectant AI to read this local page?

This lets Vectant receive selected visible text and page metadata from http://127.0.0.1:5173 during this support session.
It does not allow clicking, form submission, POST requests, cookies, or access to other ports.
```

### Disconnect

```txt
Disconnect Local Support?

Vectant will no longer be able to request local files, logs, or localhost services from this computer.
Current session approvals will be revoked.
```

---

## 29. Final Build Strategy

Build in this order:

1. local-only prototype with workspace boundary and `.env` blocking;
2. secure pairing and device identity;
3. transparency UI;
4. policy engine;
5. scanner/redactor;
6. review-before-send approvals;
7. host-based browser preview with manual ports;
8. org controls and emergency kill switches;
9. internal red team;
10. limited beta;
11. future agent read only after separate review.

Do not reverse the order. Shipping local ports, Fast Support, browser automation, or editor integrations before local policy enforcement and transparency are mature would turn the feature into a trust liability.

The safest competitive advantage is:

> Vectant can prove exactly what it can see, exactly what it cannot see, exactly what was sent, and exactly how the user can stop it.

---

## 30. Reference Standards for Implementation

Use these as implementation references:

- OWASP Application Security Verification Standard;
- OWASP API Security Top 10 2023;
- OWASP Logging Cheat Sheet;
- OWASP Cheat Sheets for CSRF, XSS, SSRF, Clickjacking, File Upload, and Secrets Management;
- RFC 8252 OAuth 2.0 for Native Apps;
- official Electron Security guidance if Electron is used;
- Tauri security model and allowlist/capability guidance if Tauri is used;
- platform keychain guidance for Windows DPAPI, macOS Keychain, and Linux Secret Service.

---

## 31. Final Recommendation

Build the feature, but only as a narrow, trust-centered MVP.

Recommended MVP:

> A read-only, session-scoped, workspace-scoped local support bridge with cryptographic pairing, local policy enforcement, secret blocking, review-before-send, visible activity history, immediate pause/disconnect, and manually approved host-based localhost preview for the user's browser only.

Do not ship broad localhost proxying, full repository indexing, shell commands, file editing, browser automation, background daemon mode, persistent approvals, or AI page reading in the first release.

The product should communicate one simple message:

```txt
You control what Vectant can see.
Sensitive files are blocked locally.
Nothing sensitive is sent without review.
You can pause or disconnect at any time.
```

---

## 32. Current Implementation Goals

The remaining shippable implementation goals are tracked in:

- `docs/VECTANT_LOCAL_SUPPORT_APP_REMAINING_IMPLEMENTATION_GOALS.md`

Do not treat release-checklist mappings, static UI evidence, helper functions, or unit-only coverage as completion. A blocker is complete only when the feature works end-to-end through the production desktop app, local daemon, cloud control plane, browser UI, audit storage, and security tests.

## 33. Implementation evidence update — 2026-07-13

The current implementation has verified loopback-only preview enforcement and browser-only capability projections across the desktop IPC path, Rust local gateway, cloud session persistence, relay control, and transparency UI. Native clippy/tests, the production Next build, focused web tests, and Chromium local-support gates pass for the exercised workflows, including protected daemon status, preview rejection of state-changing methods and private-network targets, session/port revocation, scrubbed transparency state, live PostgreSQL-backed cloud/relay E2E for polling, review, encrypted payload upload, denied-secret alerting, and revocation purge, and explicit Windows installer downgrade rejection in the Tauri/release configuration.

This evidence does not constitute release readiness. The Windows installer smoke path passes locally, but the artifact is unsigned because the updater private signing key and production certificate are not available in the workspace. Signed updater tamper/downgrade/revocation tests and production release controls remain required before beta or public release.
