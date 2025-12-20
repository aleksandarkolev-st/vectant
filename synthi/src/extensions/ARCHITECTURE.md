# Synthi VS Code Extension System Architecture

## Baseline Rules (Non-Negotiable)

| Rule | Enforcement |
|------|-------------|
| One Monaco instance | Single source of truth for all text models |
| One extension host worker | Single Web Worker for all extensions |
| Zero extension JS on main thread | All extension code runs in worker |
| No DOM access for extensions | Strict sandbox boundary |
| Webviews only via iframes | CSP-enforced isolation |

**If any of these break, stop.**

---

## Directory Structure

```
src/extensions/
├── ARCHITECTURE.md           # This file
├── index.js                  # Public API exports
├── types.d.ts                # TypeScript definitions
│
├── host/                     # Extension Host (Web Worker)
│   ├── ExtensionHostWorker.js    # Main worker entry
│   ├── ExtensionHostMain.js      # Worker initialization
│   ├── ExtensionRegistry.js      # Extension metadata registry
│   ├── ActivationManager.js      # Activation event handling
│   └── ExtensionContext.js       # Per-extension context
│
├── api/                      # VS Code API Implementation
│   ├── vscode.js                 # Main vscode namespace
│   ├── commands.js               # Command registry
│   ├── workspace.js              # Workspace API
│   ├── window.js                 # Window API (limited)
│   ├── languages.js              # Language features
│   ├── env.js                    # Environment API
│   └── extensions.js             # Extensions API
│
├── services/                 # Stubbed Services
│   ├── FileSystemService.js      # Async batched file ops
│   ├── ConfigurationService.js   # Read-only config
│   ├── StorageService.js         # IndexedDB storage
│   ├── TelemetryService.js       # No-op stub
│   └── LogService.js             # Console-based logging
│
├── bridge/                   # Main Thread ↔ Worker Communication
│   ├── MainThreadBridge.js       # Main thread coordinator
│   ├── WorkerProxy.js            # RPC proxy to worker
│   ├── MonacoBridge.js           # Monaco ↔ Extension sync
│   ├── MessageProtocol.js        # Typed message protocol
│   └── WebviewBridge.js          # Webview communication
│
├── loader/                   # Extension Loading Pipeline
│   ├── VSIXLoader.js             # VSIX unzip and parse
│   ├── ManifestParser.js         # package.json validation
│   ├── ExtensionValidator.js     # Hard filter validation
│   └── ExtensionInstaller.js     # IndexedDB storage
│
├── webview/                  # Webview Implementation
│   ├── WebviewManager.js         # Lifecycle management
│   ├── WebviewHost.html          # iframe host template
│   └── WebviewCSP.js             # Content security policy
│
├── scheduler/                # Performance Management
│   ├── ExtensionScheduler.js     # CPU budget enforcement
│   ├── MemoryMonitor.js          # Heap tracking
│   ├── TimerThrottler.js         # Timer management
│   └── VisibilityManager.js      # Tab visibility handling
│
└── perf/                     # Performance Validation
    ├── TypingLatencyMonitor.js   # Input lag measurement
    ├── ActivationBenchmark.js    # Extension startup timing
    └── CPUProfiler.js            # Extension CPU usage
```

---

## Phase Implementation Details

### Phase 1-2: Web Extension Host

The extension host runs in a dedicated Web Worker. No extension code touches the main thread.

```
Main Thread                    Extension Host Worker
┌─────────────────┐            ┌─────────────────────┐
│ Monaco Editor   │◄──────────►│ VS Code API Impl    │
│ MainThreadBridge│  postMsg   │ Extension Runtime   │
│ WebviewManager  │            │ Service Stubs       │
└─────────────────┘            └─────────────────────┘
```

### Phase 3-4: Extension Loading & Activation

**Allowed Activation Events:**
- `onLanguage:<languageId>` - Language file opened
- `onCommand:<commandId>` - Command invoked
- `onView:<viewId>` - View opened

**Blocked Activation Events:**
- `*` - Always active (BLOCKED)
- `onStartupFinished` - After startup (BLOCKED)
- `onFileSystem:<scheme>` - File system events (BLOCKED)
- `workspaceContains:<glob>` - Workspace files (BLOCKED)

**Activation Budget:**
- Soft limit: 200ms warning
- Hard limit: 1000ms kill

### Phase 5-6: Service Stubs & Monaco Bridge

**Implemented Services (Minimal):**
| Service | Implementation |
|---------|---------------|
| FileSystem | Async, batched, cached via IndexedDB |
| Workspace | Static metadata snapshot |
| Configuration | Read-only, no write support |
| TextDocument | Monaco model wrapper |

**Disabled Services:**
- SCM (Source Control)
- Tasks
- Debug
- Terminal (extension-created)
- Telemetry (no-op)

**Monaco Bridge Rules:**
- Monaco text model is authoritative
- No string copying (use TextBuffer references)
- All edits are diffs
- Batch updates (never sync per keystroke)

### Phase 7-9: Webviews, Commands, Storage

**Webview Lifecycle:**
```
create → visible → hidden → suspended → destroyed
           │         │
           └─────────┘ (toggle visibility)
```

**Webview Rules:**
- One webview = one iframe
- Strict CSP (no inline scripts)
- postMessage only communication
- Cap message rate (100/sec)
- Drop messages when hidden

**Command Execution:**
- Async only
- 500ms timeout
- Rate limit: 10/sec per extension

### Phase 10-12: Scheduling & Memory

**CPU Budget:**
- 50ms per 1s per extension
- Exceeded = throttled
- 3 violations = suspended

**Memory Limits:**
- 64MB heap per extension (configurable)
- 256MB total extension memory
- Exceeded = killed + auto-restart

**Visibility Handling:**
- Tab hidden = extensions paused
- Tab visible = extensions resumed
- Hidden > 30s = extensions suspended

### Phase 13: Performance Targets

| Metric | Target | Kill Threshold |
|--------|--------|----------------|
| Typing latency | < 10ms | > 50ms |
| Extension activation | < 300ms median | > 1000ms |
| Main thread JS from extensions | 0ms | Any |
| Hidden webview CPU | 0% | > 1% |

---

## Message Protocol

```typescript
interface ExtensionMessage {
  id: number;
  type: 'request' | 'response' | 'event';
  method: string;
  args?: any[];
  result?: any;
  error?: { message: string; stack?: string };
}

// Main → Worker
type MainToWorker =
  | { method: 'activateExtension'; args: [extensionId: string] }
  | { method: 'deactivateExtension'; args: [extensionId: string] }
  | { method: 'executeCommand'; args: [commandId: string, ...args: any[]] }
  | { method: 'textDocumentChange'; args: [uri: string, changes: TextChange[]] }
  | { method: 'selectionChange'; args: [uri: string, selections: Selection[]] };

// Worker → Main
type WorkerToMain =
  | { method: 'applyEdit'; args: [uri: string, edits: TextEdit[]] }
  | { method: 'showMessage'; args: [type: string, message: string] }
  | { method: 'registerCommand'; args: [commandId: string] }
  | { method: 'createWebview'; args: [viewId: string, options: WebviewOptions] }
  | { method: 'postWebviewMessage'; args: [viewId: string, message: any] };
```

---

## Startup Sequence

```
1. Load Monaco                     [0ms]
2. Open editor (paint)             [50ms]  ← User can type here
3. Load extension metadata         [100ms] (IndexedDB, no execute)
4. Start extension host worker     [150ms] (lazy, on demand)
5. Activate extensions (demand)    [200ms+] (only when triggered)
```

**Critical:** Editor must be interactive before extensions load.

---

## Security Model

```
┌─────────────────────────────────────────────────────┐
│ Main Thread (Trusted)                               │
│  ├─ Monaco Editor                                   │
│  ├─ MainThreadBridge (validates all messages)       │
│  └─ WebviewManager (enforces CSP)                   │
└─────────────────────────────────────────────────────┘
                    │
            postMessage (structured clone)
                    │
┌─────────────────────────────────────────────────────┐
│ Extension Host Worker (Sandboxed)                   │
│  ├─ VS Code API (restricted)                        │
│  ├─ Extension Code (untrusted)                      │
│  └─ No DOM, no fetch to arbitrary URLs              │
└─────────────────────────────────────────────────────┘
                    │
            postMessage (sanitized)
                    │
┌─────────────────────────────────────────────────────┐
│ Webview iframes (Isolated)                          │
│  ├─ Strict CSP                                      │
│  ├─ No access to parent                             │
│  └─ sandboxed: allow-scripts                        │
└─────────────────────────────────────────────────────┘
```

---

## Extension Compatibility

**Supported:**
- Web extensions (`browser` field in package.json)
- Language extensions (syntax, snippets)
- Theme extensions
- Simple command extensions
- Webview-based UI extensions

**Unsupported:**
- Native extensions (node dependencies)
- Debug adapters
- Task providers
- Terminal extensions
- SCM providers
- Extension-to-extension API
