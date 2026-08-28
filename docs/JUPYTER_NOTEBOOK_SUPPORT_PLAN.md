# Jupyter Notebook Support — Agent-Compatible Integration Plan

**Status:** Proposed plan; implementation not started  
**Scope:** Connect Vectant/ADE workspaces to already-running Jupyter servers, open and inspect `.ipynb` files, and allow existing agentic workflows to work with notebooks without changing how the agent system reasons, requests approval, selects tools, executes actions, or records telemetry.  
**Primary constraint:** Jupyter must become another workspace capability behind existing ADE boundaries, not a parallel agent runtime or a replacement execution path.

---

## 1. Target outcome

Add a native notebook surface to the existing workspace so that a user can:

- Connect an approved, already-running Jupyter server to a workspace.
- Open `.ipynb` files from the normal file tree in standard workspace tabs or panels.
- Read Markdown, code, metadata, execution state, and saved outputs.
- Use existing ADE agent features while a notebook is active.
- Explicitly give the agent a notebook, selected cells, outputs, or kernel state as context through the existing context pipeline.
- Ask the agent to inspect, edit, or execute notebook-related work through existing approval, capability, audit, and policy boundaries.
- Continue using source editing, terminals, previews, collaboration, VS Code Server, MCP integrations, and other workspace features unchanged.

The integration must not introduce a second orchestration system, hidden notebook agent, independent permission model, or direct browser-to-kernel execution path.

---

## 2. Design principle

The integration is split into three layers:

1. **Notebook presentation layer**  
   Displays notebooks and notebook state inside the workspace.

2. **Jupyter capability adapter**  
   Translates approved notebook operations into Jupyter API calls while enforcing workspace, user, server, kernel, and path boundaries.

3. **Existing ADE agent layer**  
   Continues to own reasoning, context selection, approvals, tool invocation, policies, audit events, cancellation, and user-visible action status.

The agent layer must not know or care whether an approved operation is ultimately fulfilled by a terminal, file service, MCP server, or Jupyter adapter. It should interact through the same capability and action contracts already used by the ADE.

---

## 3. Non-negotiable compatibility contract

### 3.1 Existing behavior that must remain unchanged

Do not change the semantics or ordering of:

- Agent routes and workflow services.
- System prompts, tool-selection policy, planning behavior, guardrails, or model configuration.
- Existing MCP contracts and tool schemas unless an additive capability registration is explicitly approved.
- Approval prompts, action cancellation, timeout behavior, audit records, or user-visible execution status.
- Existing source-file editing in Monaco.
- Terminal, compiler, preview, HMR, debugger, VS Code Server, or extension-host execution paths.
- Workspace persistence, collaboration, CRDT/Yjs behavior, authentication, or access control.
- Existing file APIs and the way agents read or modify ordinary workspace files.

### 3.2 Allowed additive integration

The notebook integration may:

- Register a new workspace document kind for `.ipynb`.
- Add a Jupyter connection capability behind existing workspace authorization.
- Add notebook-aware context serializers to the existing context pipeline.
- Add notebook operations to the existing capability registry if that registry already supports additive providers.
- Reuse current agent action, approval, audit, progress, cancellation, and error contracts.
- Expose notebook and kernel state only when explicitly selected by the user or required by an approved notebook action.

### 3.3 Prohibited integration patterns

Do not:

- Create a separate notebook agent, notebook planner, or hidden background agent.
- Bypass existing approvals because an action originated from a notebook.
- Let the browser send arbitrary code directly to a kernel.
- store Jupyter credentials in Redux, local storage, notebook metadata, URLs, logs, analytics, or agent context.
- Automatically inject all notebook contents or outputs into every agent request.
- Treat rendered Markdown, notebook outputs, or cell metadata as trusted agent instructions.
- Let notebook connection failure alter the workspace-wide connection or agent state.
- Add a second file synchronization or collaboration protocol in the first release.

---

## 4. Required architecture audit before implementation

Before writing production code, document the actual contracts for:

| Area | Questions to resolve |
|---|---|
| File tree | How are file kinds detected and routed? Can `.ipynb` use a custom opener without affecting source files? |
| Tabs/documents | Is there an existing document registry or discriminated document type? How is focus and restoration handled? |
| Docking | How are panels registered, serialized, restored, and disposed? |
| Context pipeline | How are files, selections, terminal output, and workspace metadata attached to agent requests? |
| Capability/tool registry | Can a provider add operations without changing core orchestration code? |
| Approvals | How are read, write, execute, interrupt, and destructive actions classified? |
| Cancellation | How are running tool calls cancelled and how are partial results reported? |
| Workspace auth | Where can encrypted workspace-scoped connection configuration be stored? |
| Proxying | Is there an existing approved-port or service proxy that can safely reach Jupyter? |
| File synchronization | Which copy is authoritative when the workspace `.ipynb` file and Jupyter contents API differ? |
| Telemetry | Which action events are contractually stable and which additive fields are allowed? |

### M0 deliverable

Produce a short architecture manifest containing:

- Confirmed files and modules to modify.
- Existing interfaces to reuse.
- Core modules that must remain untouched.
- Contract snapshots for agent actions, approvals, context payloads, and telemetry.
- A decision on notebook file authority and conflict behavior.

No implementation should proceed until this manifest is reviewed.

---

## 5. Notebook document model

Use a notebook-specific document model instead of forcing notebook cells through Monaco source-file state.

```ts
interface NotebookDocumentState {
  kind: 'jupyter-notebook';
  documentId: string;
  workspaceId: string;
  path: string;
  serverId: string;
  kernelId?: string;

  connectionState:
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'unauthorized'
    | 'error';

  syncState:
    | 'clean'
    | 'workspace-newer'
    | 'server-newer'
    | 'conflict'
    | 'saving'
    | 'stale';

  kernelState?:
    | 'unknown'
    | 'starting'
    | 'idle'
    | 'busy'
    | 'interrupting'
    | 'restarting'
    | 'dead';

  notebook: NormalizedNotebook;
  revision?: string;
  lastLoadedAt?: string;
  lastSavedAt?: string;
  lastExecutionAt?: string;
}
```

### Model rules

- Keep credentials and raw authorization headers out of document state.
- Store only opaque `serverId` and `kernelId` references in client state.
- Never serialize transient kernel state into the `.ipynb` file unless required by the notebook format.
- Treat notebook content as untrusted data.
- Keep UI selection state separate from persistent notebook content.
- Preserve unknown notebook metadata during read-modify-write operations.
- Preserve cell IDs and nbformat compatibility.

---

## 6. Connection and trust model

### 6.1 Server registration

A Jupyter server connection must be:

- Registered to one workspace.
- Bound to an authenticated user or approved shared workspace identity.
- Assigned an opaque `serverId`.
- Restricted to an approved origin and optional base path.
- Configured through the existing secure workspace settings mechanism.
- Revocable without deleting notebook files.

### 6.2 Credential handling

Credentials must:

- Remain server-side or in the existing secure secret store.
- Never appear in query strings.
- Never be returned to the browser after initial submission.
- Never enter agent prompts, model context, notebook JSON, logs, traces, or analytics.
- Be redacted from errors and diagnostic events.
- Support rotation without changing notebook documents.

### 6.3 Network boundary

Preferred request path:

```text
Notebook UI or ADE action
        ↓
Existing workspace API/auth boundary
        ↓
Workspace-scoped Jupyter gateway
        ↓
Approved Jupyter server
```

Do not solve connectivity by weakening CORS, allowing arbitrary origins, or exposing unrestricted browser fetches.

### 6.4 SSRF and path protections

The gateway must:

- Resolve only registered servers.
- Reject loopback, link-local, metadata, and private destinations unless explicitly permitted by deployment policy.
- Revalidate DNS/IP resolution where relevant.
- Normalize and validate notebook paths.
- Prevent `..`, encoded traversal, symlink escape, and cross-workspace access.
- Restrict methods and Jupyter endpoints to the operations supported by the capability adapter.
- Enforce request, response, output, and execution time limits.

---

## 7. Jupyter capability adapter

Create a narrowly scoped adapter. It may call Jupyter APIs, but it must expose ADE-shaped operations rather than leaking raw Jupyter requests throughout the UI and agent code.

```ts
interface JupyterCapabilityAdapter {
  getServerStatus(input: ServerRef): Promise<ServerStatus>;
  getNotebook(input: NotebookRef): Promise<NotebookSnapshot>;
  saveNotebook(input: SaveNotebookRequest): Promise<NotebookSnapshot>;
  listKernels(input: ServerRef): Promise<KernelSummary[]>;
  connectKernel(input: KernelConnectRequest): Promise<KernelSession>;
  executeCells(input: ExecuteCellsRequest): Promise<ExecutionHandle>;
  interruptKernel(input: KernelActionRequest): Promise<void>;
  restartKernel(input: KernelActionRequest): Promise<KernelSession>;
  disconnectKernel(input: KernelActionRequest): Promise<void>;
  subscribe(input: SubscriptionRequest): Unsubscribe;
}
```

### Adapter rules

- All methods require workspace and authenticated-user context from the server, not caller-supplied trust fields.
- Operations map to existing ADE action categories such as read, write, execute, interrupt, restart, and disconnect.
- Execution returns standard ADE progress, cancellation, result, and error structures.
- The adapter must not call the agent service.
- The agent service must not embed Jupyter credentials or raw transport details.
- Retry only idempotent operations automatically.
- Never automatically retry code execution after an uncertain transport failure.
- Assign idempotency keys to saves and action IDs to executions.

---

## 8. Agentic feature integration

The goal is full compatibility with existing ADE workflows, not isolation from them.

### 8.1 Notebook context

Extend the existing context-selection pipeline with notebook serializers.

Supported explicit context units:

- Entire notebook source, subject to token and size limits.
- Selected cells.
- Cell source only.
- Cell source plus selected outputs.
- Notebook metadata summary.
- Kernel status and environment summary.
- Execution error or traceback.
- Diff between current and saved notebook revisions.

Each context unit must include provenance metadata:

```ts
interface NotebookContextDescriptor {
  workspaceId: string;
  path: string;
  notebookRevision?: string;
  cellIds?: string[];
  includesOutputs: boolean;
  includesKernelState: boolean;
  capturedAt: string;
  truncated: boolean;
}
```

### 8.2 Prompt-injection boundary

Notebook Markdown, code comments, outputs, HTML, tracebacks, and metadata are untrusted workspace content.

The context pipeline must:

- Label notebook-derived content as user/workspace data.
- Never concatenate it into system or developer instructions.
- Preserve clear content boundaries and provenance.
- Apply the same untrusted-file protections used for ordinary workspace files.
- Exclude hidden credentials and connection settings.
- Require explicit user selection for outputs likely to contain sensitive data.

### 8.3 Agent read operations

Agents should be able to inspect notebooks through the same existing file/context capabilities they already use.

Preferred order:

1. Use the existing workspace file read mechanism for notebook JSON when sufficient.
2. Use notebook-aware normalized reads when cell structure or outputs matter.
3. Use live Jupyter state only for explicitly requested current kernel/session information.

Reading a notebook must not connect or start a kernel unless the requested information requires live kernel state and the operation is approved.

### 8.4 Agent edit operations

Notebook edits must pass through an ADE-managed notebook edit operation rather than arbitrary UI mutation.

The edit operation must support:

- Add, remove, reorder, and update cells.
- Preserve cell IDs and unknown metadata.
- Validate nbformat before save.
- Produce a previewable structural diff.
- Use optimistic concurrency with a revision or content hash.
- Refuse silent overwrite when the server or workspace copy changed.
- Reuse existing approval and audit behavior for file writes.

For simple text-only modifications, the agent may still edit raw `.ipynb` JSON through existing file tools, but the UI should warn if the result is malformed and offer validation before save.

### 8.5 Agent execution operations

Agents may execute notebook cells only through an additive Jupyter execution capability that is registered with the existing ADE capability/tool system.

Execution must:

- Use the same agent action lifecycle as terminal commands.
- Require the same level of user approval as equivalent code execution.
- Display the target server, notebook, kernel, and cell IDs before approval.
- Support cancellation through the existing cancellation mechanism.
- Stream status and outputs through the existing action-progress channel.
- Keep the kernel operation auditable.
- Return structured outputs to the agent only after policy and size filtering.
- Never grant broader filesystem or network access than the underlying kernel already has.

The integration must not add notebook execution by modifying agent reasoning or prompts. It should appear as another approved executable capability in the existing registry.

### 8.6 Agent continuity while Jupyter is unavailable

When Jupyter is disconnected:

- Agents must continue to work with workspace files, terminals, source editors, and other tools.
- Notebook saved content remains readable from the workspace file where available.
- Live execution and kernel-state actions become unavailable with a scoped error.
- The global agent session must not fail or reconnect because the Jupyter connection changed.

---

## 9. Notebook UI

### 9.1 Phase A — Native read and context experience

Implement:

- Notebook title, workspace path, server label, connection status, sync status, and kernel status.
- Markdown, code, raw, and output cell rendering.
- Syntax highlighting using existing theme tokens.
- Safe rendering for plain text, images, JSON-like data, and sanitized HTML.
- Clear fallback for unsupported or blocked MIME types.
- Notebook outline and cell navigation.
- Search within notebook.
- Copy source, copy text output, open as JSON, and add selected cells to agent context.
- Loading, stale, disconnected, unauthorized, not-found, malformed, oversized, and server-error states.
- Keyboard navigation and accessible labels.

### 9.2 Phase B — Controlled editing

After read-only integration is stable:

- Edit Markdown and code cell source.
- Add, remove, reorder, and change cell type.
- Save using optimistic concurrency.
- Show structural notebook diffs.
- Resolve workspace/server conflicts explicitly.
- Allow agent-proposed edits to appear as reviewable notebook patches.

### 9.3 Phase C — Controlled execution

After the action adapter and approval integration are validated:

- Run selected cell.
- Run all or run above/below.
- Interrupt execution.
- Select, connect, restart, and disconnect kernels.
- Stream outputs and execution status.
- Expose execution errors to the existing agent context flow.

Do not embed the full JupyterLab application. A native viewer/editor keeps one workspace shell, one auth model, one action system, and one agent integration surface.

---

## 10. File authority, saving, and synchronization

The original plan does not define which notebook copy is authoritative. This must be decided before implementation.

### Recommended model

Use the workspace `.ipynb` file as the durable source of truth. Treat the Jupyter contents API as the execution-side representation of that file.

### Required behavior

- On open, compare workspace revision and Jupyter revision where both exist.
- If equal, mark the document clean.
- If one side changed, show which copy is newer.
- If both changed, mark a conflict and prevent automatic overwrite.
- Save through one coordinator that updates the durable workspace file and the Jupyter-side copy in a defined order.
- Record revision/content hashes before and after save.
- Do not use last-write-wins for concurrent notebook edits.
- Preserve unknown metadata and outputs unless the user intentionally clears them.
- If a partial save fails, surface recovery instructions and retain the unsaved client state.

If the existing workspace file system is already the same storage mounted by Jupyter, detect that configuration and avoid duplicate writes while still retaining revision checks.

---

## 11. Output rendering and data safety

Notebook outputs may contain active or sensitive content.

### Allow by default

- `text/plain`
- Bounded `application/json`
- Bounded raster images using safe object URLs
- Sanitized Markdown-derived HTML

### Restrict or defer

- Arbitrary HTML with scripts or event handlers
- JavaScript MIME outputs
- Iframes and remote embeds
- Unsanitized SVG
- Widgets requiring arbitrary frontend modules
- Outputs that load remote resources automatically
- Very large binary or tabular payloads

### Required controls

- MIME allowlist with deterministic selection order.
- Sanitization in a sandboxed renderer where possible.
- Strict Content Security Policy.
- Output byte, row, image-dimension, and render-time limits.
- User-visible truncation and download/open-as-raw alternatives.
- No automatic remote requests from rendered output.
- Clear distinction between saved output and live execution output.

---

## 12. Kernel and execution lifecycle

A kernel is a remote, stateful execution environment and must not be treated like a stateless HTTP request.

### Required lifecycle rules

- Opening a notebook does not automatically start a kernel unless explicitly configured and approved.
- Reopening a tab may reconnect to an existing permitted kernel but must not silently create one.
- Kernel identity is workspace- and user-scoped.
- Busy/idle state is shown independently of agent state.
- Execution queues must preserve cell order for a given kernel.
- Parallel execution requires explicit support and must not be inferred.
- Cancellation first attempts message-level cancellation where supported, then interrupt according to policy.
- Restart is destructive to kernel memory and must require explicit confirmation or the existing destructive-action approval class.
- Disconnecting the UI does not necessarily terminate the kernel; the UI must state which action is occurring.
- Orphaned kernels should be discoverable and manageable through workspace policy.

### Failure behavior

- If execution status is unknown after a transport loss, report it as unknown rather than failed or safe to retry.
- Do not automatically re-execute cells after reconnect.
- Preserve partial streamed outputs with an interrupted/unknown marker.
- Keep the agent action recoverable without corrupting the overall agent session.

---

## 13. Observability and audit

Reuse existing event types and add only backward-compatible notebook fields where permitted.

Audit at minimum:

- Connection created, tested, rotated, and revoked.
- Notebook read and save operations.
- Agent context attachment of notebook content.
- Cell execution request, approval, start, completion, cancellation, interruption, and unknown state.
- Kernel connect, restart, disconnect, and failure.
- Conflict detection and resolution.

Do not record:

- Raw credentials.
- Full notebook contents by default.
- Full outputs or tracebacks unless existing policy already permits them.
- Sensitive environment variables.

Telemetry failure must never block notebook viewing, saving, execution cleanup, or agent operation.

---

## 14. Performance and resilience requirements

- Parse and render large notebooks incrementally.
- Virtualize long cell lists.
- Lazy-render off-screen outputs.
- Enforce notebook and per-output size limits before expensive rendering.
- Cancel reads when the tab closes or workspace changes.
- Reconnect subscriptions with bounded exponential backoff and jitter.
- Do not retry authentication failures automatically.
- Use circuit breaking for repeatedly unavailable servers.
- Keep notebook failures inside an error boundary separate from editor, terminal, docking, and agent panels.
- Preserve unsaved edits during temporary connection loss.
- Avoid placing full notebooks in Redux if the current state architecture is not designed for large documents.

---

## 15. Implementation milestones

| Milestone | Deliverable | Exit gate |
|---|---|---|
| **M0 — Architecture and contract audit** | Confirm document, context, capability, approval, cancellation, auth, proxy, persistence, telemetry, and synchronization seams. | Reviewed architecture manifest; core no-change list; agent contract snapshots; file-authority decision. |
| **M1 — Secure connection boundary** | Workspace-scoped server registration, secret handling, approved-origin routing, SSRF/path controls, status checks, and revocation. | Security tests reject cross-workspace access, unregistered origins, credential leakage, traversal, and disallowed endpoints. |
| **M2 — Notebook parser and structural model** | Normalize nbformat notebooks while preserving unknown fields, IDs, metadata, and outputs. | Fixtures cover valid, malformed, legacy, huge, unknown-MIME, and metadata-heavy notebooks. |
| **M3 — Read-only Jupyter adapter** | Get server state and notebook snapshots using ADE-shaped errors, cancellation, and audit hooks. | Unit and integration tests cover auth failure, timeout, cancellation, stale revisions, not-found, and server loss. |
| **M4 — Native notebook viewer** | Tabs/panels, cell rendering, safe outputs, outline, search, states, accessibility, and virtualization. | Component and accessibility tests pass; notebook failures remain isolated. |
| **M5 — Existing agent context integration** | Add notebook/cell/output serializers to the current explicit context-selection pipeline. | Existing agent request contracts remain compatible; notebook data is provenance-labeled and never auto-injected. |
| **M6 — Workspace integration and regression proof** | File-tree routing, tab restoration, docking, source handoff, and connection settings. | Existing editor, terminal, preview, collaboration, extension, and agent smoke tests remain green. |
| **M7 — Controlled notebook editing** | Structural cell edits, validation, revision checks, diff preview, save coordinator, and conflict handling. | Concurrent edits cannot silently overwrite; malformed saves are blocked; recovery paths tested. |
| **M8 — Agent-compatible execution capability** | Register Jupyter execution through existing capability, approval, action, progress, cancellation, and audit systems. | Agent core orchestration and prompts remain unchanged; execution uses standard action lifecycle; no direct browser-to-kernel path. |
| **M9 — Kernel lifecycle and live output** | Kernel selection, reconnect, streaming, interrupt, restart, unknown-state handling, and cleanup. | End-to-end tests cover disconnects, partial output, cancellation, restart, orphan handling, and no duplicate execution. |
| **M10 — Production hardening** | Load testing, CSP review, security review, migration/rollback plan, docs, and staged rollout. | Feature-flag rollback proven; operational runbook complete; regression and security gates signed off. |

---

## 16. Expected file plan

Exact paths are subject to M0 confirmation.

### Likely additions

```text
synthi/src/services/jupyter/
  types.ts
  client.ts
  notebook.ts
  execution.ts
  errors.ts
  sanitization.ts
  __tests__/

synthi/src/components/notebook/
  NotebookViewer.tsx
  NotebookToolbar.tsx
  NotebookCell.tsx
  NotebookOutput.tsx
  NotebookOutline.tsx
  NotebookStatus.tsx
  NotebookConflictDialog.tsx
  notebook.css
  __tests__/

synthi/src/context/notebook/
  serializeNotebookContext.ts
  serializeCellContext.ts
  notebookContextTypes.ts
  __tests__/

synthi/src/server/jupyter/
  registry.ts
  gateway.ts
  policy.ts
  audit.ts
  routes/
  __tests__/
```

### Likely narrow modifications

- `.ipynb` file routing in the existing file tree.
- Existing open-document registry or tab reducer.
- Dock/panel registration.
- Workspace settings for Jupyter server registration.
- Existing context picker to include notebook-specific selections.
- Existing capability registry to add a Jupyter provider.
- Existing action renderer to display notebook target metadata.
- Documentation, feature flags, and test manifests.

### Core modules to avoid modifying unless M0 proves necessary

- Agent reasoning and orchestration implementation.
- Prompt construction unrelated to generic context attachments.
- Existing terminal and compiler executors.
- Existing MCP transports and contracts.
- VS Code Server manager and extension-host routing.
- Existing CRDT protocol.
- Global workspace connectivity state.

---

## 17. Verification strategy

### 17.1 Unit tests

- Notebook normalization and round-trip preservation.
- Cell ID and metadata preservation.
- MIME selection and sanitization.
- Path and origin validation.
- Credential redaction.
- Revision/hash comparison.
- Context serialization and provenance.
- Action-to-Jupyter error mapping.
- Idempotency and retry rules.
- Cancellation and unknown execution state.

### 17.2 Component tests

- Markdown, code, raw, and output cells.
- Loading, stale, disconnected, conflict, and error states.
- Large-output truncation.
- Keyboard navigation and screen-reader labels.
- Tab focus, close, reopen, and restoration.
- Agent context selection from cell and notebook scopes.
- Edit diff and conflict UI.
- Live execution progress and cancellation UI.

### 17.3 Contract tests

Capture before-and-after snapshots for:

- Existing agent request envelope.
- Existing tool/capability invocation envelope.
- Approval request and response.
- Action progress and completion events.
- Cancellation behavior.
- Telemetry event contracts.
- Error boundaries and global workspace state.

Notebook support may add optional capability metadata, but existing consumers must continue to work without understanding it.

### 17.4 Security tests

- SSRF and DNS rebinding scenarios.
- Path traversal and symlink escape.
- Cross-workspace and cross-user access.
- Credential leakage through URL, state, logs, errors, and context.
- Malicious HTML, SVG, links, and MIME bundles.
- Prompt injection in Markdown, output, metadata, and tracebacks.
- Oversized notebooks and decompression/resource exhaustion.
- Unauthorized kernel reuse.
- Execution without approval.

### 17.5 End-to-end tests

1. Register an approved existing Jupyter server.
2. Open a workspace notebook without starting a kernel.
3. Render saved Markdown, code, images, text, HTML, and unsupported outputs safely.
4. Select cells and attach them to an existing agent conversation.
5. Ask the agent to explain or modify selected cells using the current agent workflow.
6. Review and apply an agent-proposed notebook edit.
7. Connect to a kernel through an approved action.
8. Ask the agent to execute selected cells through the existing action lifecycle.
9. Cancel execution and verify standard cancellation behavior.
10. Drop the Jupyter connection mid-execution and verify unknown-state handling without breaking the agent session.
11. Create a workspace/server revision conflict and verify no silent overwrite.
12. Revoke credentials and confirm only Jupyter capabilities become unavailable.
13. Switch among notebook, source file, terminal, preview, and agent surfaces.
14. Reload the workspace and verify safe restoration without persisted credentials.
15. Disable the feature flag and verify the original workspace behavior is restored.

---

## 18. Acceptance criteria

The feature is complete only when all of the following are true:

- A user can register and revoke an approved, already-running Jupyter server for a workspace.
- `.ipynb` files open as native workspace documents without affecting Monaco source-file behavior.
- Saved notebook content and supported outputs render safely and efficiently.
- Existing ADE agents can receive explicitly selected notebook context through the current context pipeline.
- Agents can propose notebook edits through reviewable, revision-safe operations.
- Agents can execute notebook cells only through the existing capability, approval, progress, cancellation, policy, and audit systems.
- No agent prompt, reasoning flow, tool-selection policy, or orchestration order is changed merely to support Jupyter.
- Jupyter credentials never enter browser persistence, notebook files, logs, telemetry, or model context.
- Notebook and kernel failures remain isolated from the editor, terminal, preview, collaboration, and global agent session.
- Workspace/server conflicts never resolve through silent last-write-wins behavior.
- Lost execution connections never trigger automatic duplicate execution.
- Existing agent, editor, terminal, collaboration, extension, and workspace regression suites remain green.
- The feature can be disabled or rolled back without migrating or rewriting existing notebooks.

---

## 19. Rollout and rollback

Use feature flags at three levels:

1. `jupyterNotebookViewer`
2. `jupyterNotebookEditing`
3. `jupyterAgentExecution`

Roll out in that order.

### Rollback requirements

- Disabling execution must leave viewing and editing available.
- Disabling editing must leave read-only viewing available.
- Disabling the viewer must restore `.ipynb` source opening or the previous file behavior.
- Rollback must not delete server registrations, notebook files, or outputs.
- No irreversible workspace migration should be required for the first production release.

---

## 20. Deferred capabilities

Defer until the core integration is stable and separately approved:

- Jupyter widgets requiring custom frontend modules.
- Variable/data explorer.
- Notebook debugging.
- Multi-user live cell collaboration.
- Notebook-aware CRDT merging.
- Automatic environment provisioning.
- Automatic kernel startup on notebook open.
- Agent-created servers or kernels without explicit approval.
- Background notebook schedules.
- Arbitrary custom Jupyter server extensions.
- Full JupyterLab embedding.

These capabilities must build on the same adapter and ADE action boundaries rather than creating alternate paths.

---

## 21. Final implementation rule

Jupyter support is successful only if it feels native to the workspace **and** remains subordinate to the ADE's existing contracts:

- One workspace shell.
- One agent orchestration system.
- One approval model.
- One capability/action lifecycle.
- One audit path.
- One secure connection boundary.

The notebook integration may add new capabilities, but it must not redefine how agentic work operates.
