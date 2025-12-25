# PHASE G: STRATEGIC DECISIONS

## What Synthi Will Never Support

This document codifies the hard boundaries of Synthi's extension system. These are not "todo" items - they are explicit decisions to **not** support certain capabilities.

---

## ❌ NEVER SUPPORTED

### 1. Native Node.js Modules

**Decision:** Extensions cannot use native Node.js modules or C++ addons.

**Rationale:**
- Native modules cannot run in browser/Web Worker environment
- Security risk: native code can bypass all sandboxing
- Platform-specific builds create distribution nightmares
- Memory safety issues we cannot detect or control

**Affected APIs:**
- `child_process` - No spawning processes
- `fs` (native) - No direct filesystem access
- `path` with native bindings - No native path operations
- Any `*.node` binary modules

**Alternative:**
- Use our virtual filesystem API for file operations
- Use Language Server Protocol for language tooling
- Use WebAssembly for compute-intensive tasks

---

### 2. Extension Debugging

**Decision:** No support for attaching debuggers to running extensions.

**Rationale:**
- Web Workers cannot support full debugging protocol
- Chrome DevTools cannot attach to Worker contexts reliably
- Debugging malicious extensions could expose attack surface
- Complexity/benefit ratio is not justified

**What we provide instead:**
- Comprehensive logging API (`vscode.output`)
- Extension Inspector for crash analysis
- Performance profiling snapshots
- Clear error messages with stack traces

---

### 3. Open Extension Marketplace

**Decision:** No arbitrary VSIX installation from unknown sources.

**Rationale:**
- VSIX files can contain malicious code
- No way to verify extension safety in browser
- User trust model requires curation
- Attack surface is too large

**What we support:**
- Curated marketplace with reviewed extensions
- Pre-approved list of VS Code Marketplace extensions
- Organization-managed extension allowlists
- Manual review process for new submissions

---

### 4. Extension Host Processes

**Decision:** No separate extension host processes (single Worker model).

**Rationale:**
- Browser cannot spawn additional processes
- SharedArrayBuffer requirements complicate deployment
- Single Worker model is simpler and sufficient
- Process isolation is overkill for sandboxed environment

**Tradeoff accepted:**
- All extensions share one Worker = one bad extension can affect others
- Mitigated by: quarantine system, automatic restart, crash isolation

---

### 5. Source Maps for Obfuscated Extensions

**Decision:** No automatic source map loading for minified extensions.

**Rationale:**
- Extensions must provide readable source for review
- Obfuscation suggests something to hide
- Source maps add complexity and memory overhead
- Security auditing requires readable code

**Requirement:**
- Extensions must submit unminified source for review
- Production bundles can be minified but source must be available

---

### 6. Arbitrary Network Access

**Decision:** Extensions cannot make arbitrary network requests.

**Rationale:**
- CORS prevents most cross-origin requests anyway
- Data exfiltration risk
- Privacy concerns with tracking

**What we support:**
- Fetch to same-origin endpoints
- Fetch to pre-approved API endpoints (GitHub, language servers)
- WebSocket to Synthi collaboration server
- Explicit user consent for other origins

---

### 7. Extension-to-Extension RPC

**Decision:** No direct communication between extensions.

**Rationale:**
- Complexity explosion with N² communication paths
- Fault isolation becomes impossible
- Security boundary violations
- Debugging nightmares

**What we support:**
- Command-based communication (`vscode.commands.executeCommand`)
- Shared state through workspace APIs
- Event-based loose coupling

---

### 8. Custom Webview Protocols

**Decision:** No custom protocol handlers (`vscode-resource://`, custom schemes).

**Rationale:**
- Browser security model prevents custom protocols
- URL scheme registration is platform-specific
- Workarounds are fragile and security-sensitive

**What we support:**
- Standard HTTPS for external resources
- Base64 data URIs for embedded content
- Blob URLs for dynamic content
- Proxy through Synthi backend for resources

---

## ⚠️ INTENTIONALLY LIMITED

### 1. File System Access

**Supported:**
- Virtual filesystem within workspace boundaries
- Read/write to workspace files
- Workspace-local storage

**Not supported:**
- Access outside workspace directory
- System file access
- User home directory access

---

### 2. UI Customization

**Supported:**
- Tree views in sidebar
- Status bar items
- Webview panels (sandboxed)
- Command palette commands
- Notifications/toasts

**Not supported:**
- Custom editor chrome/toolbar
- Menu bar modifications
- Native dialogs
- Custom decorations outside editor

---

### 3. Language Features

**Supported (Experimental):**
- Syntax highlighting (TextMate grammars)
- Basic IntelliSense (completion, hover)
- Diagnostics (errors/warnings)
- Code actions (basic)
- Document formatting

**Not supported:**
- Full LSP protocol (partial implementation only)
- Debug Adapter Protocol
- Testing API (runners)
- Notebook API
- Semantic highlighting (pending)

---

## 📋 VERSION COMMITMENT

This document represents the extension system contract as of **v1.0.0**.

Changes to this document that ADD restrictions must:
1. Be announced with 6-month deprecation notice
2. Provide migration path for affected extensions
3. Be tracked in CHANGELOG

Changes that REMOVE restrictions (adding capabilities):
1. Can be done at any time
2. Must maintain backward compatibility
3. Must go through security review

---

## 🔒 SECURITY MODEL SUMMARY

```
┌─────────────────────────────────────────────────────────────┐
│                     USER'S BROWSER                          │
│                                                             │
│  ┌───────────────┐           ┌──────────────────────────┐  │
│  │   Main Thread │◄─RPC─────►│   Web Worker (Sandbox)   │  │
│  │               │  (validated)│                         │  │
│  │  - UI         │           │  - Extensions            │  │
│  │  - State      │           │  - Limited APIs          │  │
│  │  - Auth       │           │  - No DOM                │  │
│  │               │           │  - No Network (direct)   │  │
│  └───────┬───────┘           └──────────────────────────┘  │
│          │                                                  │
│          │ HTTPS only                                       │
│          ▼                                                  │
│  ┌───────────────┐                                          │
│  │ Synthi Backend│                                          │
│  │               │                                          │
│  │ - File Proxy  │                                          │
│  │ - LSP Proxy   │                                          │
│  │ - Collab      │                                          │
│  └───────────────┘                                          │
└─────────────────────────────────────────────────────────────┘

Extensions CAN:
  ✓ Register commands
  ✓ Modify text in editors  
  ✓ Read/write workspace files (via API)
  ✓ Show UI elements (via API)
  ✓ Receive events (save, open, etc)

Extensions CANNOT:
  ✗ Access DOM
  ✗ Access other browser tabs
  ✗ Access local filesystem directly
  ✗ Make arbitrary network requests
  ✗ Access other extensions' memory
  ✗ Persist data outside workspace
  ✗ Spawn processes
  ✗ Access system resources
```

---

## RATIONALE: Why These Limits?

### "Why not support X?"

Every feature has cost:
1. **Security surface** - More APIs = more attack vectors
2. **Compatibility burden** - Once shipped, must maintain forever
3. **Testing complexity** - Each feature multiplies test cases
4. **User confusion** - More options = harder to understand

### "VS Code supports it!"

VS Code runs in a different environment:
- Full Node.js runtime with process isolation
- Native OS integration
- Signed and reviewed marketplace
- Desktop security model

Synthi runs in browser:
- No process isolation
- Strict browser sandbox
- Unknown execution environment
- Web security model

The same extension running in VS Code vs Synthi is fundamentally different, even if the API looks similar.

### "This is too restrictive!"

That's intentional. We can always **add** capabilities later if needed. We cannot safely **remove** capabilities once extensions depend on them.

Start restrictive, expand based on real needs.

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-01 | Initial strategic decisions document |

---

*This document is part of the Synthi Extension System specification.*
