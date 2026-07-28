# Vectant Local Support App — Full Access Support Mode and Process Visibility Plan

## 0. Purpose and relationship to the existing plan

This is a separate production plan for two higher-trust operating modes that can be enabled after the controls in `VECTANT_LOCAL_SUPPORT_APP_SECURITY_TRANSPARENCY_PLAN.md` are complete.

It does not weaken, replace, or append to the existing MVP plan. The current read-only, review-first mode remains the default. This plan introduces a precise vocabulary:

- **Auto Approval** is the decision behavior: eligible requests are accepted automatically instead of producing an individual approval prompt.
- **Full Access** is the capability profile: the local app exposes a workspace capability graph, accepts hyper-specific requests against that graph, can run commands through the command broker, and can inspect/use local ports even when they were not manually shared.

Auto Approval and Full Access are independently represented in policy and consent. Full Access normally uses Auto Approval, but the names must never be collapsed into one boolean. This plan adds a separately named and separately governed capability for organizations and users who explicitly want:

- automatic acceptance of eligible support requests;
- a complete, queryable capability graph of the selected workspace;
- hyper-specific requests for graph nodes, files, diagnostics, commands, processes, and local ports;
- live visibility into relevant local processes and listeners;
- faster support workflows that do not require an approval prompt for every low-risk request.
- restricted workspace file changes and structured context from commands it has run.

“Full access” is a product name for a complete diagnostic operating mode. It must never mean unrestricted remote control, arbitrary code execution, silent surveillance, or access to secrets. Every capability remains locally enforced, bounded, revocable, and visible.

The target outcome is:

> A production-grade, high-trust support mode that can automatically approve safe diagnostic requests while making its scope, process visibility, data movement, actor, retention, and revocation state continuously understandable to the user.

## 1. Product definition

### 1.1 Auto Approval Mode

Auto Approval is a policy decision mode. It removes repetitive per-request prompts only for capabilities already included in the active consent receipt and policy. It does not add capabilities by itself.

Auto Approval can cover Full Access requests, including commands and unshared local ports, only when the Full Access grant explicitly includes those categories. A request that exceeds the graph, command policy, network boundary, budget, or session scope is denied or paused; it is never silently broadened.

### 1.2 Full Access Support Mode

Full Access Support Mode is a session-scoped privileged diagnostic profile. At enrollment it creates a workspace capability graph and grants Vectant the ability to request specific graph nodes and bounded diagnostic operations automatically.

It may include:

- a complete workspace capability graph containing discoverable paths, file identities, classifications, relationships, project metadata, and requestability state, but not raw file contents or secrets;
- hyper-specific reads of graph nodes, ranges, symbols, manifests, logs, test results, and diagnostics;
- command execution through the command broker defined below;
- restricted workspace file creation, patching, and replacement through the mutation broker defined below;
- structured, bounded context from command stdout, stderr, exit status, changed files, and relevant console output;
- framework, dependency, build, test, and runtime metadata;
- process inventory and listener metadata under the rules in this plan;
- discovery and use of local loopback ports without prior manual port sharing, subject to port policy and process identity checks;
- automatic delivery of low-risk diagnostic payloads;
- queued delivery of higher-risk payloads when policy requires confirmation.

It must not include:

- command execution outside the command broker, including direct shell transport or arbitrary executable paths;
- file writes, edits, deletion, or renaming outside the mutation broker and its explicitly granted workspace scope;
- package installation or updates;
- git mutation or credential use;
- database queries or mutation;
- screen, camera, microphone, clipboard, keychain, password-store, or accessibility access;
- browser profile, cookies, local storage, session storage, or password access;
- private keys, cloud credentials, tokens, secrets, database dumps, or unrestricted home-directory reads;
- LAN, cloud metadata, arbitrary private-host access, or network scanning outside the declared local-port scope;
- process termination, suspension, injection, debugging, memory inspection, handle duplication, or environment-variable collection;
- persistence outside the declared session and policy lifetime.

### 1.3 Auto Approval is policy acceptance, not a trust bypass

Auto-accept is valid only when all of the following are true:

1. The user deliberately enrolled the session or organization in Full Access and explicitly enabled Auto Approval.
2. The mode is visibly active in the local app and the connected Vectant UI.
3. The request matches a versioned capability policy, target scope, actor, session, workspace, and expiry.
4. Local classification and secret scanning succeed.
5. The payload remains within configured size, rate, volume, and retention limits.
6. The request is within the capability graph, command broker, or local-port policy and does not cross a denied boundary.
7. A scrubbed audit event is durably recorded before delivery.
8. The user can pause or revoke the mode immediately.

Failure of any condition changes the decision to deny or a locally visible paused state; it never falls through to automatic delivery or an implicit scope expansion.

### 1.4 Workspace capability graph

Full Access starts by producing a local graph of the selected workspace. The graph is a capability map, not a repository upload. It gives Vectant enough structure to ask for precise information without first requesting broad directory contents.

Graph nodes may include:

- workspace-relative file and directory identifiers;
- stable content and metadata hashes;
- file size, type, language, and generated/binary/archive classification;
- symbol, import, dependency, script, test, and configuration relationships;
- project/runtime metadata;
- log and diagnostic sources;
- process and local-port relationships when proven;
- requestability state: available, auto-requestable, locally redacted, blocked, or expired.

The initial graph must not contain raw file bodies, secret values, credentials, environment variables, command lines, or arbitrary absolute paths. Sensitive node names are hashed or represented by a blocked category. Graph construction must use the same canonicalization, sensitive-path, scanner, and workspace-containment rules as ordinary reads.

Every graph request must identify a node ID, requested field or range, reason/class, maximum response size, and request ID. “Give me everything” is not a valid hyper-specific request and must be rejected by schema validation.

Graph freshness is explicit. A stale graph cannot authorize a changed file, process, port, or policy. The local app revalidates the node and content immediately before release.

### 1.5 Command execution is a first-class privileged capability

Full Access may run commands, but command execution must go through a dedicated local command broker rather than a generic remote shell. Auto Approval means the user has already granted this command capability for the session; it does not remove execution isolation, limits, or logging.

The broker must:

- run commands in the selected workspace with a controlled working directory;
- use an explicit executable and argument model, preserving argument boundaries;
- expose the effective environment as a scrubbed policy projection, never as a secret source;
- apply OS-level process isolation, resource limits, timeout, output caps, and concurrency limits;
- capture stdout/stderr only through bounded, locally scanned channels;
- redact or block secrets before any output leaves the machine;
- record executable identity, argument hash, workspace hash, actor, policy, exit status, duration, and byte counts;
- terminate the command tree on timeout, disconnect, pause, revoke, or budget exhaustion;
- prevent command output from becoming an implicit approval for a later command.

The broker must reject shell metacharacter ambiguity, command substitution, untrusted executable resolution, path traversal, environment injection, terminal control sequences, interactive prompts, background persistence, and attempts to escape the workspace or network policy. Workspace file changes are allowed only through the mutation broker below. Installing software, changing git state, changing databases, changing system configuration, or mutating user data outside the selected workspace must be separately classified and explicitly enabled by a future destructive-action policy; it is not silently included merely because Full Access is active.

Command execution is visible as “Automatically run under Full Access policy,” with the exact command display, arguments, target workspace, output summary, and result available in local history. Raw output remains local until it passes the existing scanner/redactor and payload policy.

### 1.6 Restricted workspace file mutation

Full Access may change local files when the active consent receipt includes `support.full_access.workspace.file.mutate`. This is a controlled mutation capability, not a general filesystem-write API.

All mutations must use a local mutation broker that:

- accepts structured patches or complete replacement content, never an opaque shell write command;
- addresses files by workspace-relative graph node ID and current content hash;
- rejects absolute paths, traversal, symlink/junction escapes, sensitive paths, generated/dependency artifacts, archives, binaries, sparse files, and files outside the selected workspace;
- revalidates the path, file identity, policy, and content hash immediately before commit;
- creates an atomic transaction with a before hash, after hash, unified diff, actor, request ID, and policy version;
- enforces file count, byte, line, patch, and transaction budgets;
- preserves a local recovery copy or reversible journal according to the retention policy;
- supports `revert` only through a separately audited capability bound to the transaction ID;
- refuses writes when the workspace is dirty in a conflicting way unless the request includes a matching current hash and explicit conflict policy;
- never writes credentials, secret files, private keys, package-manager auth, cloud config, or blocked paths;
- stops and rolls back the transaction on partial failure, disconnect, pause, revoke, timeout, or policy change.

Auto Approval can authorize these mutations only when the user and organization explicitly enabled file mutation in Full Access. Each mutation must still produce a local before/after diff, changed-file list, and durable audit event before the result is reported to Vectant. The local UI must show “Automatically changed under Full Access policy,” the exact files, the diff summary, and the available revert action. A mutation is never represented as a normal read approval.

File mutation does not grant permission to change the operating system, install software, modify credentials, alter security settings, mutate databases, change git history, or write outside the workspace. Those are separate capabilities and remain disabled unless separately designed and consented.

### 1.7 Command and console context capture

When Full Access runs a command, the support session may receive the command’s diagnostic context, not an unrestricted stream of the machine’s output. Context capture is tied to the exact command execution ID and includes only fields allowed by policy:

- exit status and termination reason;
- duration, resource-limit outcome, and bounded byte counts;
- scrubbed stdout and stderr within per-command limits;
- structured diagnostics parsed from known tool formats;
- changed-file and graph-node hashes caused by an authorized mutation;
- relevant local console output from the explicitly targeted process or port;
- selected error lines, stack frames, test failures, compiler diagnostics, and request IDs;
- redaction count, scanner version, and omitted-output reason.

Console context must be explicitly scoped to the process, command, port, or request that produced it. The app must not collect global terminal history, unrelated process output, background logs, keystrokes, interactive terminal input, or console output from an unselected service.

Output is streamed through bounded local buffers, secret scanning, terminal-control stripping, and backpressure. A scanner failure, ambiguous source, output overflow, or context-source mismatch denies the payload or returns a scrubbed summary with zero raw bytes sent. Context is not permission to execute a new command or read an arbitrary log; each follow-up request is separately authorized by the active Full Access graph and policy.

### 1.8 Unshared local ports

Full Access may discover and use local ports that were not manually shared in the earlier browser-preview workflow. This is a distinct capability: `support.full_access.local_port.discover` and `support.full_access.local_port.use`.

The local port scope is initially limited to loopback addresses on the device. The app may discover listeners and request a specific port, protocol, path, method, or response field without requiring a separate user click, but every request is still checked against:

- session, workspace, actor, policy, and Full Access consent;
- process identity and listener ownership;
- loopback address and canonical port;
- method and path policy;
- request/response size and rate budgets;
- credential/header stripping;
- redirect, WebSocket, service-worker, and private-network protections;
- audit durability before delivery.

Unshared does not mean unrestricted. LAN addresses, metadata services, arbitrary private hosts, public internet destinations, credential-bearing requests, state-changing methods, and unknown listener identities remain denied unless a future separately reviewed network capability is enabled. A port approval is invalidated when its listener identity, process, session, or policy changes.

Port responses are sent only after local filtering. Cookies, authorization headers, proxy credentials, API keys, CSRF tokens, userinfo, and sensitive response headers remain blocked. Browser preview, agent read, command execution, and response-body delivery remain separate capabilities even when they concern the same port.

## 2. Trust model and security posture

Full Access Support Mode introduces a higher consequence of cloud-session compromise, local UI compromise, policy mistakes, and user misunderstanding. It therefore requires defense in depth across the browser, cloud, relay, local daemon, privileged adapters, and desktop UI.

### 2.1 Separate capability namespace

Create a distinct capability namespace. Do not infer Full Access from the presence of an existing capability or a generic boolean such as `auto_accept: true`.

Examples:

```text
support.full_access.enroll
support.auto_approval.enable
support.full_access.graph.read
support.full_access.graph.node.request
support.full_access.command.execute
support.full_access.command.context.read
support.full_access.workspace.file.mutate
support.full_access.workspace.file.revert
support.full_access.process.inventory
support.full_access.process.listener_metadata
support.full_access.local_port.discover
support.full_access.local_port.use
```

Every request must carry an exact capability, actor, session, org, workspace, policy version, target class, request ID, expiry, and device proof where required. The local app must reject capability substitution, scope widening, omitted fields, and unknown future capabilities.

### 2.2 No single switch controls the mode

Activation requires independent controls:

- user enrollment and confirmation;
- cloud organization policy allow;
- session-level grant;
- local app version and security posture check;
- workspace scope;
- capability-specific policy;
- local pause/revocation state.

The effective grant is the intersection of these controls. A cloud administrator cannot silently override a local user pause. A local user cannot enable a capability that the organization has disabled.

### 2.3 Full Access is broad, but not an unbounded remote shell

Full Access must continue to use the existing local policy engine, workspace containment checks, scanner/redactor, command broker, port isolation, approval queue, audit chain, session revocation, and relay request-envelope validation. It is an additional privileged policy profile, not a bypass around those systems.

The security boundary changes from “read-only by default” to “explicitly authorized diagnostic actions with local enforcement.” The following remain hard-denied unless a future capability is separately designed, consented, implemented, and reviewed:

- secret and credential access;
- arbitrary host/network access;
- hidden persistence;
- unrestricted shell transport;
- destructive system or user-data mutation outside the restricted workspace mutation broker;
- process control or inspection of memory/environment/handles;
- browser profile and user-session access.

## 3. Enrollment and consent

### 3.1 Explicit enrollment flow

The local desktop app must provide a dedicated Full Access enrollment flow with:

- a plain-language scope summary;
- exact capabilities being enabled;
- explicit separation of Auto Approval from Full Access;
- workspace graph contents and requestable node classes;
- command execution scope, broker limits, and mutation policy;
- workspace file mutation scope, transaction/revert policy, and conflict behavior;
- command/console context sources and redaction rules;
- local-port discovery/use scope, including unshared-port behavior;
- exact data categories that may be sent automatically;
- process visibility explanation;
- exclusions, including secrets and process contents;
- organization and support actor identity;
- start and expiry time;
- retention period;
- pause and revoke controls;
- a test request preview;
- a confirmation step requiring local desktop interaction.

Pairing or installation alone must never enroll the mode.

### 3.2 Consent receipt

Persist a signed, scrubbed consent receipt containing:

- consent ID and session ID;
- account, organization, support actor, and device fingerprint;
- workspace identity hash, not the raw path;
- selected capability set;
- Auto Approval state and auto-accepted classes;
- Full Access graph, command, process, and local-port scopes;
- denied classes and hard-denied boundaries;
- process visibility level;
- policy and scanner versions;
- maximum payload size and daily/session volume limits;
- created, expires, paused, revoked, and last-reviewed timestamps;
- local confirmation method and app version.

The receipt must be bound to the request envelope. A changed scope, actor, workspace, policy, app version, or device invalidates the receipt and requires re-enrollment.

### 3.3 Re-consent triggers

Require fresh local consent when:

- the organization changes the allowed capability set;
- a new actor type is introduced;
- process visibility increases;
- Auto Approval changes from metadata to source, logs, commands, ports, file mutation, or command context;
- workspace file mutation or revert is added to the consent receipt;
- Full Access graph, command, or local-port scope increases;
- the workspace changes;
- the local app loses its secure storage or device identity;
- the app is downgraded or enters an unsupported security posture;
- policy/scanner major version changes;
- the session is transferred to another device or browser identity.

## 4. Auto Approval policy design

### 4.1 Capability classes

Use risk classes with independent limits:

| Class | Examples | Default in Full Access | Local handling |
|---|---|---:|---|
| A | app/framework metadata, graph metadata, process names | Auto-accept | scrub, audit, send |
| B | dependency manifests, test summaries, listener metadata, bounded health checks | Auto-accept if scoped | classify, cap, audit |
| C | source files, approved logs, specific command results, specific local-port responses, restricted workspace patches | Auto-accept only when explicitly granted | scan/redact, transaction/volume cap, audit |
| D | unusual files, large logs, broad command output, ambiguous targets, unknown listeners | Paused or denied | local review/diagnostics only |
| E | secrets, credentials, private keys, dumps, binaries, archives, forbidden process fields | Always deny | zero bytes, security event |

The organization may reduce access, but may not promote Class E to auto-accept.

### 4.2 Request-level Auto Approval checks

Before every automatic release, the local app must verify:

- authenticated session and device proof;
- active Full Access consent receipt;
- exact actor and organization match;
- target is within the graph, command broker, or local-port scope;
- target has not crossed a sensitive-path or sensitive-category rule;
- content classification is known;
- scanner/redactor succeeded;
- content hash and metadata remain stable;
- request is within rate, volume, concurrency, command, and port limits;
- file mutations match current hashes and mutation budgets;
- command context is tied to the originating execution, process, port, or request;
- no recent policy change or emergency pause applies;
- audit write succeeded.

Never auto-accept based only on filename, MIME type, extension, process name, port number, or a prior approval.

### 4.3 Progressive safety limits

Auto Approval must have bounded budgets:

- maximum bytes per request;
- maximum bytes per category per session;
- maximum requests per minute;
- maximum concurrent reads;
- maximum process records per snapshot;
- maximum snapshot frequency;
- maximum retained local history;
- maximum number of approved services/listeners.

On budget exhaustion, the app pauses automatic delivery and shows a local explanation. It must not silently continue with a larger scope.

### 4.4 Automatic delivery transparency

Each automatic send must appear in the local activity view with:

- “Automatically sent under Full Access policy” wording;
- actor and capability;
- target display name and stable hash;
- classification;
- bytes sent;
- redaction count;
- policy/scanner versions;
- timestamp and request ID;
- retention/deletion status.

The UI must never label an auto-accepted item merely as “approved” because that implies a per-item user click.

## 5. Process visibility

### 5.1 Scope of process information

The process feature is diagnostic inventory, not process control or surveillance. The default visible record is limited to:

- stable local process identity hash;
- executable basename and normalized display name;
- process category/classification;
- PID only when necessary for a short-lived local correlation and never as a durable identity;
- start time or age bucket;
- listening loopback ports;
- protocol and bind address class;
- parent process category, if available and permitted;
- observed working-directory hash when it is inside the selected workspace;
- health/status metadata supplied by the local adapter;
- whether the process was user-selected, workspace-related, or merely observed as a listener.

### 5.2 Information that must not leave the machine

Never send by default:

- command-line arguments;
- full executable paths outside the selected workspace;
- environment variables;
- inherited environment values;
- process memory or open handles;
- file descriptors;
- window titles, document names, or user activity;
- usernames, account names, home paths, or machine names unless separately approved and minimized;
- code-signing certificates or binary contents;
- process stdout/stderr unless separately requested as a log and scanned;
- child-process trees beyond the configured depth and category rules;
- processes owned by other users where the OS exposes them;
- kernel/system/security processes except coarse health counters.

### 5.3 Process collection modes

Offer explicit modes:

1. **Workspace processes:** processes whose executable or working-directory identity is proven to belong to the selected workspace.
2. **Full Access listeners:** processes bound to any discovered loopback port included by the active Full Access local-port scope, even when the port was not manually shared, with process identity binding.
3. **Approved listeners:** processes bound to a manually approved loopback port from the existing browser-preview flow.
4. **Diagnostic inventory:** coarse names/categories and loopback listener metadata, subject to organization policy.

Full Access may see the complete set of eligible workspace/listener records, but “all processes with all details” is still not a valid capability. Process contents, memory, environment, handles, and unrelated-user process data remain outside the graph and command/port scopes.

There must be no “all processes with all details” mode in this product. A future enterprise exception would require a separate security review and OS-specific privacy design.

### 5.4 Process identity and race safety

Process records are volatile. The adapter must:

- collect using the least-privileged OS API available;
- avoid elevation by default;
- bind listener approvals to a process identity tuple/hash, not PID alone;
- revalidate identity immediately before returning a sensitive diagnostic result;
- invalidate records when the process exits or identity changes;
- avoid treating PID reuse as continuity;
- distinguish “not visible due to OS permission” from “not running”;
- fail closed when identity cannot be established.

The local app must not kill, pause, inject into, attach a debugger to, or modify a process as part of this mode.

### 5.5 Process UI requirements

The local app must show:

- which process data is visible to Vectant;
- which process fields are hidden locally;
- collection time and freshness;
- why each process was included;
- which listener/port approval it is associated with;
- whether the record was sent, redacted, denied, or expired;
- a one-click pause for process visibility;
- a one-click revoke for all process-related grants.

The UI must not imply that “visible to the local app” means “sent to Vectant.”

## 6. Cloud, relay, and policy integration

Extend the existing control plane with:

- organization-level Full Access enable/disable;
- per-capability allowlists;
- process visibility level;
- allowed workspace mode and workspace count;
- actor restrictions;
- command broker policy and executable/resource limits;
- workspace mutation policy, file/byte/transaction budgets, and revert retention;
- command context and console-output source/field allowlists;
- Full Access local-port discovery/use policy for unshared loopback listeners;
- app minimum version and security posture;
- maximum auto-accept budgets;
- retention and export policy;
- emergency pause and global kill switch;
- device/session revocation;
- mandatory re-consent version.

The relay must carry policy identifiers and consent-receipt references, not secret policy material. The cloud may request within policy, but the local app remains the final authority.

Cloud and support tooling must receive scrubbed process summaries only. Raw command lines, environment variables, full paths, and process output must be rejected at schema validation, not merely omitted by the UI.

## 7. Desktop architecture additions

Add a least-privilege process-inspection adapter isolated from the main local gateway. It should expose narrow typed operations such as:

```text
list_workspace_processes(scope, freshness)
list_approved_listeners(session_id)
inspect_listener_identity(port, expected_identity)
```

It must not expose a generic process API, shell escape, arbitrary path argument, or raw OS object handle.

The renderer receives sanitized projections only. Tokens, device keys, raw paths, environment values, command lines, and unredacted process records must remain outside renderer state.

All new IPC commands require:

- strict schemas and bounded values;
- capability checks;
- session and consent binding;
- local audit events;
- dangerous-fragment rejection;
- negative tests for malformed scope, PID, port, path, and freshness values.

## 8. Audit, privacy, and operations

Add event classes for:

- Full Access enrollment, re-consent, pause, resume, and revoke;
- auto-accept decision and delivery;
- workspace mutation requested, committed, rolled back, conflicted, or reverted;
- command context captured, redacted, truncated, or denied;
- process inventory collection;
- process field suppression/redaction;
- listener identity change;
- budget exhaustion;
- policy mismatch;
- scanner failure;
- emergency kill switch;
- device/session revocation.

Audit records must contain decision metadata and stable hashes, never raw command lines, environment variables, raw process paths, raw secrets, or process output. Local history deletion must remove eligible process records and leave only the existing scrubbed deletion marker behavior.

Operational alerts should detect:

- unusual auto-accept volume;
- sudden scope expansion attempts;
- repeated denied sensitive process fields;
- process identity churn on an approved port;
- repeated policy mismatches;
- scanner failures;
- requests from stale or downgraded clients;
- support actors requesting capabilities outside their role;
- repeated pause/re-enable cycles that could indicate user confusion or abuse.

## 9. Security test and red-team plan

Required end-to-end tests include:

- enrollment cannot occur from the browser alone;
- a paused local app denies auto-accept despite a valid cloud request;
- org-disabled Full Access cannot be enabled locally;
- Auto Approval cannot be enabled without a separate Full Access grant;
- the initial workspace graph contains structure and requestability metadata but no raw bodies or secrets;
- a hyper-specific graph-node request succeeds only for a current graph node and bounded field/range;
- a graph request for “everything” or an unlisted node is denied;
- a Full Access command runs only through the command broker with bounded time, output, process tree, and workspace scope;
- a workspace patch requires the current graph node/content hash and produces an atomic before/after diff;
- a mutation conflict, partial write, pause, revoke, disconnect, or timeout leaves no partial change and records the outcome;
- blocked files, secrets, symlinks, generated artifacts, binaries, and out-of-workspace paths cannot be mutated;
- authorized mutations can be reverted only by transaction ID and a separately audited capability;
- command stdout/stderr and targeted console output return bounded, scrubbed context tied to the execution/request ID;
- global terminal history, unrelated service logs, keystrokes, interactive input, and unselected console output never enter context;
- output overflow, scanner failure, or context-source mismatch returns a scrubbed summary or zero raw bytes;
- command timeout, disconnect, pause, revoke, and budget exhaustion terminate the command tree;
- command output is scanned/redacted before delivery and forbidden environment/credential data never leaves the machine;
- Full Access can discover and use an unshared loopback port when process identity and port policy match;
- an unshared port cannot reach LAN, metadata, public, or arbitrary private-host targets;
- a listener identity change revokes the unshared-port grant;
- a changed consent scope invalidates existing requests;
- policy version changes require re-consent;
- scanner failure denies automatic delivery;
- TOCTOU changes deny automatic delivery;
- auto-accept budgets stop delivery at the exact boundary;
- Class E content is never auto-accepted;
- process command-line and environment fields never appear in cloud payloads;
- PID reuse and process restart invalidate identity-bound approvals;
- a process moving outside the workspace is excluded or denied;
- a listener changing process identity is revoked;
- inaccessible OS process data is reported as unavailable, not guessed;
- renderer compromise cannot invoke arbitrary process inspection;
- malformed process/port/path IPC requests are denied;
- disconnect, uninstall, emergency pause, and update-required state revoke all grants;
- cloud logs, local logs, exports, telemetry, and error strings contain no forbidden process fields or secrets.

Red-team scenarios must include a compromised support session, malicious local process, PID reuse race, malicious workspace process, hostile dev server, renderer XSS, policy downgrade, stale consent receipt, volume-exhaustion attempt, and a user accidentally enabling the mode without understanding its scope.

## 10. Production release gates

Full Access Support Mode must not be enabled in production until all of these are true:

- current Local Support MVP security gates pass end-to-end;
- signed desktop artifacts and updater verification are available in the real release pipeline;
- organization and global kill switches are exercised against production-like infrastructure;
- consent, policy, relay, local enforcement, UI, audit, and revoke paths are covered by live E2E tests;
- process inspection has passed OS-specific privacy and least-privilege review on Windows, macOS, and Linux targets;
- high and critical red-team findings are closed;
- support actors have role-based access and training;
- retention, deletion, and customer disclosure behavior are approved;
- incident response includes Full Access abuse, accidental over-collection, and key compromise scenarios;
- an independent security owner signs off on the capability matrix and launch evidence.

The release must support an immediate server-side disable, local emergency pause, device/session revocation, and forced downgrade to the existing review-first mode.

## 11. Implementation sequence

1. Freeze the capability taxonomy and forbidden-field schema.
2. Add the separate Auto Approval and Full Access policy models, consent receipt, and re-consent invalidation.
3. Build the workspace capability graph with scrubbed structure, hashes, classifications, and requestability state.
4. Implement hyper-specific graph requests and bounded Auto Approval in the existing local decision pipeline.
5. Build the least-privilege command broker with process-tree, resource, output, and workspace controls.
6. Build the restricted workspace mutation broker with atomic transactions, diffs, conflict checks, and revert.
7. Build command/console context capture with source binding, redaction, backpressure, and bounded retention.
8. Build the least-privilege process adapter and process identity model.
9. Add Full Access discovery/use for unshared loopback ports, preserving the existing preview protections.
10. Add sanitized graph, command, mutation, context, process, and port projections to local UI, relay envelopes, and audit storage.
11. Add organization controls, budgets, emergency pause, and forced fallback to review-first mode.
12. Complete desktop, cloud, relay, OS-specific, and red-team tests.
13. Exercise incident response and signed release gates.
14. Enable internally for a small allowlist with conservative graph, command, mutation, context, and loopback-port limits.
15. Expand limits only after measured evidence, never by silently changing the existing grant.

## 12. Non-negotiable product promise

The product must communicate:

```text
Full Access Support is enabled for this session.
It can automatically send approved diagnostic information within the scope shown here.
Sensitive files, credentials, command lines, environment variables, and process contents remain blocked.
It can run bounded commands, apply restricted workspace changes, and return scrubbed context from those actions.
You can see what was sent, pause access, or revoke the session at any time.
```

Full Access Support Mode is complete only when that promise is true in the local enforcement path, the cloud relay, the desktop UI, the audit export, and the release evidence—not merely in configuration or documentation.
