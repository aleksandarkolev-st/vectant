# Jupyter notebook architecture manifest

## Scope and authority decision

The durable workspace `.ipynb` file is authoritative. A connected Jupyter server is an
approved execution-side representation of that same relative path. When the server is
mounted onto the workspace, the adapter detects the matching content hash and performs
one write; otherwise it writes the workspace first and then the server. A mismatch on
both sides is a conflict, never last-write-wins.

## Confirmed seams

| Concern | Existing contract | Notebook integration |
| --- | --- | --- |
| File tree | `workspaceSlice.selectFileThunk` owns file selection; `FileTree` and `FileItem` route user file activation through it. | `.ipynb` remains a normal workspace file and is given a `jupyter-notebook` document presentation in the editor surface. |
| Tabs and docking | `docking-wm` opens regular editor tabs with a `filePath`; the legacy editor consumes `workspace.openFiles` and `activeFile`. | Notebook tabs reuse the same file-path tab identity, focus, close, and restoration behavior. |
| Workspace persistence | Workspace item routes and the collab-backed Git file API own durable contents. | The save coordinator writes through the existing workspace route and uses hashes to coordinate with Jupyter. |
| Agent context | `AIChatWindow` explicitly opts an active file into the request; the chat route receives additive attachment content. | Notebook and selected-cell serializers provide provenance-labelled, bounded attachments only after a user opt-in. |
| Agent actions and approvals | `api/chat/route.js`, `CommandApprovalCard`, and `approve-command` own the standard action lifecycle. | Jupyter execution is an additive action provider which requires the same approval record and cancellation contract. |
| Credentials | Integration records use `EncryptedSecret` through `tokenCrypto`; public shapes intentionally omit material. | Jupyter registrations use the same server-side encryption boundary and never return a token. |
| Audit | Existing routes use structured, additive server events. | Jupyter events store operation metadata and redacted summaries, never credentials, full notebooks, or full outputs. |

## Modules to add

- `src/lib/jupyter/`: policy, registration store, secure gateway, notebook normalization,
  content hashing, output safety, audit, and action lifecycle helpers.
- `src/app/api/workspace/[slug]/jupyter/`: server registration, health, snapshot, save,
  and approved execution routes.
- `src/components/notebook/`: isolated notebook viewer/editor, safe output renderer,
  outline, context controls, connection settings, and conflict UI.
- `src/context/notebook/`: bounded serializers for notebook, cell, output, and kernel
  state attachments.

## Narrow modifications

- The workspace editor chooses the notebook presentation for `.ipynb`, retaining Monaco
  for every other file.
- The chat attachment builder accepts a notebook attachment supplied by the active
  document. Existing message, prompt, tool, approval, and cancellation envelopes remain
  unchanged.
- Workspace settings exposes the Jupyter registration UI when the viewer flag is on.

## Core no-change list

The agent planner, prompts, model configuration, tool-selection order, terminal and
compiler executors, MCP schemas, VS Code server routing, CRDT protocol, global workspace
connectivity, and normal Monaco source editing are not modified by this integration.

## Contract snapshots

- Agent request: existing fields are unchanged. Notebook data is supplied only as an
  ordinary explicit attachment with `kind: "jupyter-notebook"`, provenance, path, scope,
  and truncation fields.
- Approval: execution creates the existing pending approval shape with action metadata;
  the browser never receives a Jupyter credential or kernel transport.
- Cancellation: an AbortSignal reaches the server gateway. An interrupted transport
  produces `unknown`, not an automatic retry.
- Telemetry: events add `targetType`, `serverId`, `notebookPath`, and redacted result
  summaries. Telemetry failures are ignored after the operation has been attempted.

## Security and rollout

Gateway requests are server-only, validate an encrypted workspace-scoped registration,
use an HTTPS-or-loopback origin allowlist, reject credentials in URLs, reject traversal,
and permit only the Jupyter Contents, Sessions, Kernels, and Kernel Channels routes that
match the registered server and requested workspace path. Three independent environment
flags gate viewer, editing, and agent execution. Disabling a later flag leaves earlier
stages intact; disabling the viewer returns `.ipynb` to source-file behavior.
