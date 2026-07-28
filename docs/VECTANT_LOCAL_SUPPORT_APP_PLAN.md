# Vectant Local Support App Plan

## Goal

Build an installable Vectant Local Support App that lets users connect Vectant to selected local machine context in a controlled, visible, and secure way.

The app should allow Vectant to:

- Read selected project and workspace context.
- Inspect approved local ports such as `localhost:3000`, `localhost:5173`, and `localhost:11434`.
- Capture useful debugging context such as logs, config files, package metadata, framework info, terminal snapshots, and app health.
- Show the user exactly what is connected, what is being read, what is ignored, and what was sent.
- Avoid hidden background access or broad machine access.

The trust model should be:

> Automatic where safe, visible always, permissioned when sensitive.

## Core Product Shape

The Local Support App should run as a small desktop app, tray app, CLI daemon, or VS Code extension-backed service.

Recommended first version:

- Desktop/tray app or CLI daemon.
- Optional VS Code extension later.
- Local HTTP/WebSocket server bound only to `127.0.0.1`.
- Pairing flow between the Vectant web app and the Local Support App.
- Workspace-scoped access.
- Read-only by default.

The Vectant web app should never silently assume access. The user should explicitly install, pair, and choose what workspace or local services are available.

## User Flow

1. User opens Vectant support.
2. Vectant explains that local context can improve debugging.
3. User installs or runs the Vectant Local Support App.
4. Local Support App opens a pairing screen with a one-time code.
5. User pairs it with their Vectant session.
6. User chooses a workspace folder.
7. Local Support App scans safe metadata first.
8. UI shows what Vectant can currently see.
9. Vectant can automatically request safe context.
10. Sensitive reads require user approval.
11. User can pause, disconnect, or remove context at any time.

## Visible UI Requirements

The frontend should make local access transparent rather than mysterious.

The UI should show:

- Current connection status: `Connected`, `Paused`, or `Disconnected`.
- Selected workspace, for example `C:\Users\name\projects\vectant-app`.
- Active local services such as `localhost:3000` or `localhost:5173`.
- Files currently included in context.
- Files ignored for security.
- Recent reads.
- Recent port requests.
- Current permission mode.
- Session duration.
- Disconnect button.
- Pause local context button.
- Review-before-send panel.

Useful UI sections:

- **Overview**: connected workspace, local ports, permission mode, and current Vectant session.
- **Context In Use**: files, logs, configs, and metadata currently available to Vectant.
- **Activity Log**: read requests, blocked files, approved files, and local port activity.
- **Sensitive Items**: blocked or approval-required files.
- **Local Ports**: detected and user-approved local services.
- **Permissions**: controls for automatic context use and approval gates.

Example activity log entries:

```txt
Vectant read package.json
Vectant requested http://localhost:5173
Blocked .env
User approved reading vite.config.ts
```

## Permission Modes

Use three clear permission modes.

### Manual

Ask before every read or local port request.

### Balanced

Automatically read safe metadata and selected low-risk project files. Ask for sensitive files, logs, and local port access.

This should be the default mode.

### Fast Support

Automatically use safe workspace context and approved ports during this support session, while still blocking secrets and high-risk paths.

## Security Rules

The Local Support App must be secure by design.

Baseline rules:

- Bind only to `127.0.0.1`.
- Never expose a public network port.
- Require pairing with a one-time code.
- Use short-lived session tokens.
- Scope access to a selected workspace.
- Default to read-only.
- Never allow arbitrary filesystem browsing.
- Never allow unrestricted port scanning.
- Do not send hidden context.
- Keep a visible audit log.
- Allow instant pause and disconnect.
- Require explicit approval for sensitive files.
- Enforce ignores locally, not only in the cloud.

The local app should be the enforcement layer. The cloud should never be trusted to merely promise it will not read something. If a file is blocked, the local app should refuse to return it.

## Default Blocked Paths And Patterns

Block these by default:

```txt
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa
id_ed25519
.ssh/
.aws/
.gcp/
.azure/
.kube/
.npmrc
.pypirc
.netrc
.DS_Store
node_modules/
.git/objects/
browser profiles
password stores
```

Also detect and block or redact sensitive content patterns:

- API keys.
- Private keys.
- OAuth tokens.
- Database URLs.
- JWTs.
- Cloud credentials.
- SSH keys.
- Payment provider secrets.

## Local Port Access

The Local Support App can help Vectant interact with local apps more reliably than browser-only localhost access.

Port rules:

- No blind port scanning by default.
- Detect common dev ports only with user consent.
- Let users manually approve ports.
- Show all active approved ports in the UI.
- Require approval before sending request or response bodies to Vectant.
- Redact cookies, authorization headers, and tokens.
- Block private network hopping.

Example allowed local service flow:

1. App detects `localhost:5173`.
2. UI shows: `Vite dev server found`.
3. User approves access.
4. Vectant can request page HTML, status, console logs, screenshots, or health checks.
5. Activity log records each request.

## Context Sources

Start with high-value, low-risk context:

- `package.json`.
- Lockfile type.
- Framework config.
- `tsconfig.json`.
- `vite.config.*`.
- `next.config.*`.
- `tailwind.config.*`.
- Selected source files.
- Recent terminal output.
- Local dev server status.
- Browser console errors.
- App logs.
- Git branch/status summary.
- Test output.

Avoid by default:

- Entire repository upload.
- Home directory access.
- Secret files.
- Database dumps.
- Customer data.
- Browser data.
- SSH credentials.
- Cloud credentials.

## Architecture

Suggested components:

- **Vectant Web App**: main support UI and chat/session interface.
- **Local Support App**: installed app responsible for local filesystem and localhost access.
- **Local Agent API**: local-only API on `127.0.0.1`.
- **Secure Pairing Service**: cloud-mediated pairing using a one-time code or QR code.
- **Policy Engine**: decides what can be read, blocked, redacted, or approval-gated.
- **Activity Log**: local and cloud-visible record of all context use.
- **Redaction Layer**: scans files, logs, headers, and responses before anything leaves the machine.

## MVP Scope

Build the first version around read-only support.

MVP features:

- Installable local app.
- Pairing with Vectant session.
- Workspace picker.
- Read safe project metadata.
- Read user-approved files.
- Detect and block secrets.
- Activity log.
- Pause and disconnect.
- Approved local port access.
- Basic local dev server health checks.
- Visible context panel in Vectant UI.

Do not include in the MVP:

- Write access.
- Running arbitrary commands.
- Full repo indexing.
- Background always-on monitoring.
- Automatic port scanning.
- Access outside the selected workspace.
- Editing files.
- Shell control.

## Phase Plan

### Phase 1: Prototype

Build a local daemon that can:

- Start on `127.0.0.1`.
- Pair with a browser session.
- Read `package.json` from a selected folder.
- Return a visible activity log.
- Block `.env`.

This proves the trust and connection model.

### Phase 2: Context UI

Add the visible Vectant frontend:

- Connected workspace.
- Current files in context.
- Ignored sensitive files.
- Recent reads.
- Pause and disconnect.
- Permission mode.

This is the trust layer and should be treated as core product, not polish.

### Phase 3: Policy Engine

Add local enforcement:

- Allowlist and denylist.
- Secret detection.
- Redaction.
- File size limits.
- Workspace boundary checks.
- Approval prompts.

### Phase 4: Local Ports

Add controlled local port support:

- Manual port approval.
- Common dev server detection.
- Health and status fetches.
- Safe response metadata capture.
- Header and secret redaction.
- Per-request logging.

### Phase 5: Developer Tooling Integration

Add optional deeper integrations:

- VS Code extension.
- Open files and current file context.
- Terminal output with approval.
- Problems panel and errors.
- Git status summary.
- Test results.

### Phase 6: Enterprise And Trust Features

Add enterprise-grade trust controls:

- Admin policies.
- Offline/local-only mode.
- No-retention mode.
- SOC 2-oriented audit logs.
- Team allowlists.
- Per-org blocked paths.
- Signed app updates.
- Device and session management.

## Risk Assessment

This is worth building if Vectant users need help with local projects, developer workflows, app debugging, AI coding, support diagnostics, or local services.

The biggest risks are:

- Leaking secrets.
- Users feeling watched.
- Overbroad filesystem access.
- Accidental localhost abuse.
- Compromised cloud session requesting local data.
- Unclear consent.

Mitigations:

- Visible UI.
- Session-scoped access.
- Local enforcement.
- Strong defaults.
- No hidden reads.
- Instant pause.
- Audit log.
- Approval gates.

## Recommendation

Build it, but start narrow.

The best MVP is:

> A read-only, session-scoped Local Support App with workspace selection, visible context usage, secret blocking, and manually approved local port access.

That gives Vectant a powerful support advantage without crossing into hidden or overbroad local access.
