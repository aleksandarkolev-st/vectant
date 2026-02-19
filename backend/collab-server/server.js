const http = require('http');
const WebSocket = require('ws');
// y-websocket exports have changed across versions and some environments do
// not allow accessing internal subpaths via package exports. Try a few
// common locations and fall back with a clear error message.
require('dotenv').config();
let setupWSConnection = null;
try {
  // Try the package export path without extension first (preferred)
  setupWSConnection = require('y-websocket/bin/utils').setupWSConnection;
  if (typeof setupWSConnection === 'function') {
    console.log('[Collab] loaded setupWSConnection from y-websocket/bin/utils');
  } else {
    throw new Error('setupWSConnection not exported at y-websocket/bin/utils');
  }
} catch (errA) {
  try {
    // Some installs put utils under bin/utils.js (legacy)
    setupWSConnection = require('y-websocket/bin/utils.js').setupWSConnection;
    if (typeof setupWSConnection === 'function') {
      console.log('[Collab] loaded setupWSConnection from y-websocket/bin/utils.js');
    } else {
      throw new Error('setupWSConnection not found at y-websocket/bin/utils.js');
    }
  } catch (errB) {
    try {
      // Common fallback for older builds
      setupWSConnection = require('y-websocket/dist/bin/utils.cjs').setupWSConnection;
      if (typeof setupWSConnection === 'function') {
        console.log('[Collab] loaded setupWSConnection from y-websocket/dist/bin/utils.cjs');
      } else {
        throw new Error('setupWSConnection not found at y-websocket/dist/bin/utils.cjs');
      }
    } catch (errC) {
      try {
        // As a last resort try the root package export (may not include server utils)
        const root = require('y-websocket');
        if (root && typeof root.setupWSConnection === 'function') {
          setupWSConnection = root.setupWSConnection;
          console.log('[Collab] loaded setupWSConnection from y-websocket (root export)');
        } else {
          throw new Error('setupWSConnection unavailable on y-websocket root export');
        }
      } catch (errD) {
        console.error('[Collab] Unable to load setupWSConnection from y-websocket.');
        console.error('Tried multiple locations and failed - ensure you have y-websocket installed and that it provides server utils.');
        console.error('Errors (most recent first):', errD?.message || errD, errC?.message || errC, errB?.message || errB, errA?.message || errA);
        process.exit(1);
      }
    }
  }
}
const Y = require('yjs');
const fileIndex = require('./fileIndex');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const gcsSync = require('./gcsSync');
const { createTerminalWSS, activeSessions: terminalSessions, broadcastToAll: terminalBroadcast } = require('./terminalService');
const proxyService = require('./proxyService');
let fetchFunc = null;
if (typeof fetch === 'function') {
  fetchFunc = fetch;
} else {
  try {
    fetchFunc = require('node-fetch');
  } catch (e) {
    fetchFunc = null;
  }
}

const CODE_INTEL_URL = (process.env.CODE_INTEL_URL || 'http://localhost:8000').replace(/\/$/, '');

// LevelDB persistence is optional — some environments (or registries) may not
// provide a compatible `y-leveldb` binary. Try to load it and fall back to
// an in-memory persistence implementation if it's not available.
let LeveldbPersistence = null;
try {
  LeveldbPersistence = require('y-leveldb').LeveldbPersistence;
  console.log('[Collab] y-leveldb persistence available');
} catch (e) {
  console.warn('[Collab] y-leveldb not available, using in-memory persistence fallback');
}

const PORT = process.env.COLLAB_PORT || 1234;

// Track file hashes to detect when actual files change outside of the editor
const fileHashCache = new Map(); // docName -> { hash, timestamp }

/**
 * Compute MD5 hash of content for change detection
 */
function computeHash(content) {
  return crypto.createHash('md5').update(content || '').digest('hex');
}

/**
 * Parse document name to extract slug and file path
 * Format: "workspace:slug:filepath"
 */
function parseDocName(docName) {
  if (!docName || !docName.startsWith('workspace:')) {
    return null;
  }
  const parts = docName.split(':');
  if (parts.length < 3) return null;
  const slug = parts[1];
  const filePath = parts.slice(2).join(':'); // Handle colons in file path
  return { slug, filePath };
}

/**
 * Get the actual file content from disk
 */
async function getActualFileContent(slug, filePath) {
  try {
    const repoPath = path.join(__dirname, 'repos', slug);
    const fullPath = path.join(repoPath, filePath);
    const content = await fs.readFile(fullPath, 'utf8');
    return content;
  } catch (e) {
    console.log(`[Collab] Could not read file ${slug}/${filePath}:`, e.code || e.message);
    return null;
  }
}

/**
 * Get content from a Yjs document's text type
 */
function getYDocContent(ydoc) {
  try {
    // Try common text type names used by Monaco/CodeMirror bindings
    const textTypes = ['monaco', 'content', 'text', 'codemirror'];
    for (const name of textTypes) {
      const text = ydoc.getText(name);
      if (text && text.length > 0) {
        return text.toString();
      }
    }
    return '';
  } catch (e) {
    return '';
  }
}

// Use LevelDB persistence when available, otherwise use an in-memory fallback
let basePersistence;
if (LeveldbPersistence) {
  basePersistence = new LeveldbPersistence('./data/collab-leveldb');
} else {
  // Simple in-memory persistence that encodes/decodes Yjs state updates
  class InMemoryPersistence {
    constructor() {
      this.store = new Map();
    }

    async bindState(docName, ydoc) {
      const update = this.store.get(docName);
      if (update) {
        try {
          Y.applyUpdate(ydoc, update);
        } catch (e) {
          console.warn('[Collab] failed to apply stored update for', docName, e?.message || e);
        }
      }
    }

    async writeState(docName, ydoc) {
      try {
        const update = Y.encodeStateAsUpdate(ydoc);
        this.store.set(docName, update);
      } catch (e) {
        console.warn('[Collab] failed to encode state for', docName, e?.message || e);
      }
    }
    
    async clearDocument(docName) {
      this.store.delete(docName);
    }
  }

  basePersistence = new InMemoryPersistence();
}

/**
 * Wrapper persistence that validates cached state against actual file content,
 * AND automatically flushes Y.js changes to disk for Container-First architecture.
 * This ensures the compiler/AI always sees the latest content.
 */
class ValidatingPersistence {
  constructor(innerPersistence) {
    this.inner = innerPersistence;
    // Track Y.js document observers for auto-flush
    this.docObservers = new Map(); // docName -> { ydoc, observer, flushTimer }
    // Debounce interval for disk writes (ms)
    this.FLUSH_DEBOUNCE_MS = 150;
  }

  /**
   * Set up auto-flush observer for a Y.js document
   * This ensures every Y.js change is eventually written to disk
   */
  _setupAutoFlush(docName, ydoc) {
    // Only set up for workspace documents
    const parsed = parseDocName(docName);
    if (!parsed) return;

    // Clean up existing observer if any
    this._cleanupAutoFlush(docName);

    const { slug, filePath } = parsed;
    
    // Find the text type being used
    const textTypes = ['monaco', 'content', 'text', 'codemirror'];
    let targetText = null;
    for (const name of textTypes) {
      const text = ydoc.getText(name);
      if (text) {
        targetText = text;
        break;
      }
    }

    if (!targetText) return;

    // Create observer that flushes to disk
    let flushTimer = null;
    const observer = () => {
      // Debounce disk writes
      if (flushTimer) clearTimeout(flushTimer);
      
      flushTimer = setTimeout(async () => {
        try {
          let content = targetText.toString();
          const repoPath = path.join(__dirname, 'repos', slug);
          const fullPath = path.join(repoPath, filePath);
          
          // ── CRDT Duplicate Detection ──────────────────────────────────
          // When both server (bindState) and client independently insert
          // the same content into an empty Y.Text, the CRDT merge produces
          // duplicated text. Detect this before writing to disk.
          const cached = fileHashCache.get(docName);
          if (content.length > 0 && content.length % 2 === 0) {
            const half = content.length / 2;
            const firstHalf = content.substring(0, half);
            const secondHalf = content.substring(half);
            if (firstHalf === secondHalf) {
              // Content is exactly doubled — check against disk to confirm
              // this is a CRDT merge artifact and not intentional.
              try {
                const diskContent = await getActualFileContent(slug, filePath);
                if (diskContent !== null && (firstHalf === diskContent || secondHalf === diskContent)) {
                  console.warn(`[Collab AutoFlush] CRDT duplicate detected for ${filePath} (${content.length} chars → ${firstHalf.length}). Fixing Y.Doc...`);
                  ydoc.transact(() => {
                    targetText.delete(0, targetText.length);
                    targetText.insert(0, diskContent);
                  }, 'autoflush-dedup');
                  // Observer will re-fire with corrected content; skip this write
                  return;
                }
              } catch (_) { /* ignore read errors, proceed with write */ }
            }
          }
          // Also detect content that is N× repeated (from recursive doubling
          // across multiple reconnect cycles: 2× → 4× → 8× …)
          if (content.length > 0 && cached) {
            try {
              const diskContent = await getActualFileContent(slug, filePath);
              if (diskContent && diskContent.length > 0
                  && content.length > diskContent.length
                  && content.length % diskContent.length === 0) {
                const repeats = content.length / diskContent.length;
                if (repeats >= 2 && content === diskContent.repeat(repeats)) {
                  console.warn(`[Collab AutoFlush] CRDT ${repeats}× duplicate detected for ${filePath}. Fixing Y.Doc...`);
                  ydoc.transact(() => {
                    targetText.delete(0, targetText.length);
                    targetText.insert(0, diskContent);
                  }, 'autoflush-dedup');
                  return;
                }
              }
            } catch (_) {}
          }
          // ─────────────────────────────────────────────────────────────────
          
          // Ensure directory exists
          const dirPath = path.dirname(fullPath);
          await fs.mkdir(dirPath, { recursive: true });
          
          // Write to disk
          await fs.writeFile(fullPath, content, 'utf-8');
          
          // Update hash cache
          fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });

          // Optional: Sync to GCS for cloud-backed workspaces
          const syncToGcs = String(process.env.GCS_SYNC_ON_FLUSH || 'true').toLowerCase() !== 'false';
          if (syncToGcs && gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
            try {
              await gcsSync.syncFileToGcs(slug, filePath, content);
            } catch (e) {
              console.warn(`[Collab AutoFlush] GCS sync failed for ${filePath}:`, e?.message || e);
            }
          }

          // Optional: Trigger incremental code-intel indexing
          const shouldIndex = String(process.env.CODE_INTEL_AUTO_INDEX || 'true').toLowerCase() !== 'false';
          if (shouldIndex && fetchFunc && CODE_INTEL_URL) {
            try {
              fetchFunc(`${CODE_INTEL_URL}/code-intel/index/file`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  workspace_path: slug,
                  file_path: filePath,
                }),
              }).catch(() => {});
            } catch (e) {
              // Non-fatal
            }
          }
          
          console.log(`[Collab AutoFlush] ${filePath} -> disk (${content.length} chars)`);
        } catch (e) {
          console.error(`[Collab AutoFlush] Failed to flush ${filePath}:`, e.message);
        }
      }, this.FLUSH_DEBOUNCE_MS);
    };

    // Observe changes on the text type
    targetText.observe(observer);

    // Store for cleanup
    this.docObservers.set(docName, { ydoc, text: targetText, observer, flushTimer: null });
    
    console.log(`[Collab AutoFlush] Set up auto-flush for ${docName}`);
  }

  /**
   * Clean up auto-flush observer
   */
  _cleanupAutoFlush(docName) {
    const entry = this.docObservers.get(docName);
    if (entry) {
      try {
        if (entry.text && entry.observer) {
          entry.text.unobserve(entry.observer);
        }
        if (entry.flushTimer) {
          clearTimeout(entry.flushTimer);
        }
      } catch (e) {
        console.warn(`[Collab AutoFlush] Cleanup error for ${docName}:`, e.message);
      }
      this.docObservers.delete(docName);
    }
  }

  async bindState(docName, ydoc) {
    // First, bind the persisted state (if any)
    if (this.inner.bindState) {
      await this.inner.bindState(docName, ydoc);
    }

    // Now validate against actual file
    const parsed = parseDocName(docName);
    if (!parsed) {
      // Not a workspace document, skip validation
      return;
    }

    const { slug, filePath } = parsed;
    
    const actualContent = await getActualFileContent(slug, filePath);
    
    if (actualContent === null) {
      // File doesn't exist on disk, keep persisted state
      return;
    }

    const persistedContent = getYDocContent(ydoc);
    const actualHash = computeHash(actualContent);
    const persistedHash = computeHash(persistedContent);

    // Condensed logging - only log when relevant
    if (actualHash !== persistedHash) {
      console.log(`[Collab] STALE DATA: ${filePath} | persisted=${persistedHash.substring(0, 8)} | actual=${actualHash.substring(0, 8)} | resetting...`);

      // Clear the persisted state and reset to actual content
      if (this.inner.clearDocument) {
        await this.inner.clearDocument(docName);
      }

      // Reset Yjs document to actual file content
      // Find the text type and replace its content
      const textTypes = ['monaco', 'content', 'text', 'codemirror'];
      for (const name of textTypes) {
        const text = ydoc.getText(name);
        if (text) {
          ydoc.transact(() => {
            text.delete(0, text.length);
            text.insert(0, actualContent);
          }, 'bindState-reset');
          break;
        }
      }

      // Update hash cache
      fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });
    } else {
      fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });
    }

    // ── Post-reset duplicate guard ─────────────────────────────────────
    // Because y-websocket fires bindState *without* awaiting it, a client
    // may have already synced its own content into the Y.Doc while we were
    // performing async I/O above.  If the Y.Doc content is now the file
    // content repeated (CRDT merge of two independent inserts), fix it.
    const postContent = getYDocContent(ydoc);
    if (postContent.length > 0 && actualContent && actualContent.length > 0
        && postContent.length > actualContent.length
        && postContent !== actualContent) {
      // Check if it's an exact N× repetition of the correct content
      if (postContent.length % actualContent.length === 0) {
        const repeats = postContent.length / actualContent.length;
        if (repeats >= 2 && postContent === actualContent.repeat(repeats)) {
          console.warn(`[Collab] CRDT duplicate detected after bindState for ${filePath} (${repeats}× repeat). Fixing...`);
          const textTypes2 = ['monaco', 'content', 'text', 'codemirror'];
          for (const name of textTypes2) {
            const text = ydoc.getText(name);
            if (text && text.length > 0) {
              ydoc.transact(() => {
                text.delete(0, text.length);
                text.insert(0, actualContent);
              }, 'bindState-dedup');
              break;
            }
          }
          fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });
        }
      }
    }
    // ───────────────────────────────────────────────────────────────────
    
    // Set up auto-flush so all future Y.js changes are written to disk
    // This is critical for Container-First architecture
    this._setupAutoFlush(docName, ydoc);
  }

  async writeState(docName, ydoc) {
    const content = getYDocContent(ydoc);
    
    if (this.inner.writeState) {
      await this.inner.writeState(docName, ydoc);
    }
    
    // Update hash cache when writing
    fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });
  }

  async clearDocument(docName) {
    fileHashCache.delete(docName);
    if (this.inner.clearDocument) {
      await this.inner.clearDocument(docName);
    }
  }

  // Proxy other methods to inner persistence
  async flushDocument(docName) {
    if (this.inner.flushDocument) {
      await this.inner.flushDocument(docName);
    }
  }
}

// Wrap the base persistence with validation
const persistence = new ValidatingPersistence(basePersistence);

// CRITICAL: y-websocket uses a module-level persistence variable, NOT the
// options passed to setupWSConnection. We must call setPersistence() so
// that getYDoc() → bindState() → auto-flush actually fires.
try {
  const { setPersistence } = require('y-websocket/bin/utils');
  setPersistence(persistence);
  console.log('[Collab] Persistence registered via setPersistence()');
} catch (e) {
  console.warn('[Collab] Could not call setPersistence:', e.message);
}

const gitService = require('./gitService');
const workspaceManager = require('./workspaceManager');

/**
 * Clear Yjs persistence for a document (used when merge conflicts need fresh file content).
 * @param {string} docName - The document name (room key), e.g., "workspace:slug:filepath"
 */
async function clearDocumentPersistence(docName) {
  try {
    if (persistence.clearDocument && typeof persistence.clearDocument === 'function') {
      await persistence.clearDocument(docName);
      console.log('[Collab] Cleared persistence for document:', docName);
    } else if (persistence.flushDocument && typeof persistence.flushDocument === 'function') {
      // LeveldbPersistence may use flushDocument or similar
      await persistence.flushDocument(docName);
      console.log('[Collab] Flushed document from persistence:', docName);
    } else {
      console.warn('[Collab] No clearDocument method available on persistence');
    }
  } catch (e) {
    console.warn('[Collab] Error clearing persistence for', docName, e?.message || e);
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ========================================================================
  // REVERSE PROXY — /port/<N>/... → http://127.0.0.1:<N>/...
  // Enables in-IDE preview of running dev servers (Next.js, Vite, etc.)
  // ========================================================================
  if (req.url.startsWith('/port/')) {
    proxyService.proxyHttpRequest(req, res);
    return;
  }

  // GET /ports — list active dev-server ports
  if (req.url === '/ports' && req.method === 'GET') {
    proxyService.handlePortsStatus(req, res);
    return;
  }

  // Debug endpoint to check collab server state
  if (req.url === '/debug/status' && req.method === 'GET') {
    const status = {
      server: 'running',
      persistence: LeveldbPersistence ? 'LevelDB' : 'In-Memory',
      fileHashCacheSize: fileHashCache.size,
      fileHashes: Object.fromEntries(
        Array.from(fileHashCache.entries()).map(([k, v]) => [k, { 
          hash: v.hash.substring(0, 8), 
          timestamp: new Date(v.timestamp).toISOString() 
        }])
      ),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }
  
  // Debug endpoint to validate a specific file
  if (req.url.startsWith('/debug/validate/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /debug/validate/:slug/:filePath
    const slug = parts[3];
    const filePath = parts.slice(4).join('/');
    
    if (!slug || !filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing slug or filePath' }));
      return;
    }
    
    const docName = `workspace:${slug}:${filePath}`;
    const actualContent = await getActualFileContent(slug, filePath);
    const cachedHash = fileHashCache.get(docName);
    
    const result = {
      docName,
      actualFile: actualContent !== null ? {
        exists: true,
        length: actualContent.length,
        hash: computeHash(actualContent).substring(0, 8),
        preview: actualContent.substring(0, 200),
      } : { exists: false },
      cachedHash: cachedHash ? {
        hash: cachedHash.hash.substring(0, 8),
        timestamp: new Date(cachedHash.timestamp).toISOString(),
      } : null,
      valid: cachedHash && actualContent !== null 
        ? cachedHash.hash === computeHash(actualContent) 
        : null,
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // ========================================================================
  // FILE CONTENT ENDPOINT - Used by AI backend for Container-First analysis
  // ========================================================================
  // GET /file-content/:slug/:filePath - Returns file content from disk (Source of Truth)
  if (req.url.startsWith('/file-content/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /file-content/:slug/:filePath (filePath can contain slashes)
    const slug = parts[2];
    const filePath = parts.slice(3).join('/');
    
    if (!slug || !filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug or filePath', usage: '/file-content/:slug/:filePath' }));
      return;
    }
    
    console.log(`[Collab] FILE-CONTENT request: slug=${slug}, path=${filePath}`);
    
    try {
      // Ensure repo exists and (when configured) hydrate from GCS before reading.
      if (!gitService.isRepoExists(slug)) {
        try {
          await gitService.initRepo(slug, null);
        } catch (e) {
          if (gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
            console.warn('[Collab] FILE-CONTENT auto-init failed for slug:', slug, e?.message || e);
          }
        }
      }

      const content = await getActualFileContent(slug, filePath);
      if (content === null) {
        console.log(`[Collab] FILE-CONTENT: File not found: ${slug}/${filePath}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found', slug, filePath }));
        return;
      }
      
      console.log(`[Collab] FILE-CONTENT: Returning ${content.length} chars for ${slug}/${filePath}`);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (e) {
      console.error(`[Collab] FILE-CONTENT error:`, e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read file', detail: e.message }));
    }
    return;
  }

  // ========================================================================
  // EXEC-TERMINAL ENDPOINT — Execute command in a real PTY terminal
  // ========================================================================
  // POST /exec-terminal/:slug  { command: string, timeout?: number }
  // Creates a real PTY session, executes the command, captures output,
  // and keeps the PTY alive so the frontend can connect and see it.
  // Returns: { sessionId, command, output, exitCode, timedOut }
  if (req.url.startsWith('/exec-terminal/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);

    try {
      const { createHeadlessSession } = require('./terminalService');
      const crypto = require('crypto');
      const sessionId = `ai-${crypto.randomUUID().slice(0, 8)}`;

      // Create a real PTY with a known session ID
      const { ptyProcess, cwd } = createHeadlessSession(sessionId, slug);

      console.log(`[ExecTerminal] slug=${slug} cwd=${cwd} sessionId=${sessionId} cmd=${command.slice(0, 120)}`);

      // Collect output from the PTY
      let output = '';
      const MAX_OUT = 50000;
      let commandDone = false;
      let commandSent = false;

      const outputCollector = (data) => {
        if (output.length < MAX_OUT) output += data;
      };
      ptyProcess.onData(outputCollector);

      // Write the command after the shell finishes its banner output.
      // We detect the shell is ready by waiting for the first prompt.
      // PowerShell prompt: "PS C:\...>" | Bash prompt: "$" or "#"
      const isWin = require('os').platform() === 'win32';
      const promptPattern = isWin ? /PS [^\r\n]*>/ : /[$#]\s*$/;
      let promptCheckInterval;
      let promptWaitTimeout;

      function sendCommand() {
        if (commandSent) return;
        commandSent = true;
        if (promptCheckInterval) clearInterval(promptCheckInterval);
        if (promptWaitTimeout) clearTimeout(promptWaitTimeout);
        ptyProcess.write(command + '\r');
        // Start stability checking AFTER the command is sent + a grace period
        // for the command to start producing output
        setTimeout(startStabilityCheck, 1500);
      }

      // Check every 100ms if prompt appeared
      promptCheckInterval = setInterval(() => {
        if (promptPattern.test(output)) {
          sendCommand();
        }
      }, 100);

      // Fallback: if prompt never detected, send command anyway after 1s
      promptWaitTimeout = setTimeout(() => {
        if (!commandSent) {
          console.log(`[ExecTerminal] Prompt not detected, sending command anyway`);
          sendCommand();
        }
      }, 1000);

      // Wait for the command to finish by detecting the shell prompt returning
      // AFTER the command output. Also use a stability fallback.
      function startStabilityCheck() {
        let lastOutputLen = output.length;
        let stableCount = 0;
        const STABLE_THRESHOLD = 4; // 4 consecutive checks × 500ms = 2s of silence
        const CHECK_INTERVAL = 500;
        let promptSeenAfterCmd = false;

        const checkDone = setInterval(() => {
          // Primary: detect the shell prompt reappearing after command output
          // This means the command finished and the shell is ready for input
          if (commandSent && output.length > lastOutputLen) {
            // Check if the LATEST output chunk contains the prompt
            const recentOutput = output.slice(lastOutputLen);
            if (promptPattern.test(recentOutput)) {
              promptSeenAfterCmd = true;
            }
          }

          if (output.length === lastOutputLen) {
            stableCount++;
          } else {
            stableCount = 0;
            lastOutputLen = output.length;
          }

          // Done when: prompt returned after command output + output stable for 500ms
          // OR: output stable for 2s (fallback for commands that don't return to prompt)
          if ((promptSeenAfterCmd && stableCount >= 1) || stableCount >= STABLE_THRESHOLD || commandDone) {
            clearInterval(checkDone);
            clearTimeout(hardTimeout);
            respond();
          }
        }, CHECK_INTERVAL);
      }

      const hardTimeout = setTimeout(() => {
        respond();
      }, timeoutMs);

      let responded = false;
      function respond() {
        if (responded) return;
        responded = true;

        // Extract the command output: find the echoed command and take everything after it
        // up to (but not including) the next shell prompt
        let cleanOutput = output;

        // Try to extract just the command output (between echoed command and next prompt)
        const cmdIndex = output.indexOf(command);
        if (cmdIndex !== -1) {
          // Start after the echoed command + newline
          const afterCmd = output.slice(cmdIndex + command.length).replace(/^\r?\n/, '');
          // Try to strip the trailing prompt
          const promptMatch = afterCmd.match(isWin ? /\r?\nPS [^\r\n]*>\s*$/ : /\r?\n[^\r\n]*[$#]\s*$/);
          cleanOutput = promptMatch
            ? afterCmd.slice(0, promptMatch.index).trim()
            : afterCmd.trim();
        }

        // Try to infer exit code from output (PTY doesn't expose it directly).
        // Heuristic: check for common error patterns that indicate failure.
        const looksLikeError = /\b(error|fatal|not recognized|cannot be loaded|is not a valid|denied|failed|abort)\b/i.test(cleanOutput)
          && !/\b(0 error|no error|fixed|resolved|warning)\b/i.test(cleanOutput);
        const inferredExitCode = looksLikeError ? 1 : 0;

        console.log(`[ExecTerminal] Done: sessionId=${sessionId} output=${cleanOutput.length}B exitCode=${inferredExitCode}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessionId,
          command,
          output: cleanOutput || '(no output)',
          exitCode: inferredExitCode,
          timedOut: false,
        }));
      }

      // If the PTY exits before timeout (e.g., single command), respond immediately
      ptyProcess.onExit(({ exitCode }) => {
        commandDone = true;
      });

    } catch (err) {
      console.error('[ExecTerminal] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }

    return;
  }

  // ========================================================================
  // EXEC-PTY ENDPOINT — Execute command and mirror it to user's terminal
  // ========================================================================
  // POST /exec-pty/:slug  { command: string, timeout?: number }
  // Uses child_process.spawn for reliable, clean stdout/stderr capture,
  // AND writes the command + output to the user's live PTY so they see it.
  if (req.url.startsWith('/exec-pty/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);
    const { resolveWorkspaceCwd } = require('./terminalService');
    const cwd = resolveWorkspaceCwd(slug);

    console.log(`[ExecPTY] slug=${slug} cwd=${cwd} cmd=${command.slice(0, 120)}`);

    // Find active PTY session for this workspace to mirror output
    let targetSession = null;
    for (const [, session] of terminalSessions) {
      if (session.cwd && session.cwd.endsWith(slug) && session.pty) {
        targetSession = session;
        break;
      }
    }

    // Use child_process.spawn for clean, reliable stdout/stderr capture
    const { spawn } = require('child_process');
    const isWin = require('os').platform() === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const MAX_OUT = 50000;

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);

      const combinedOutput = stdout + (stderr ? `\n${stderr}` : '');

      // NOTE: Do NOT write output to the PTY via pty.write() — that sends INPUT
      // which PowerShell/bash interprets as commands, causing errors.
      // The AI chat UI already displays the command output to the user.

      console.log(`[ExecPTY] Done: exitCode=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        command,
        exitCode,
        stdout,
        stderr,
        timedOut,
        usedPty: Boolean(targetSession),
      }));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[ExecPTY] Spawn error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  // ========================================================================
  // EXEC ENDPOINT — One-shot command execution for AI tool-calling pipeline
  // ========================================================================
  // POST /exec/:slug  { command: string, timeout?: number }
  if (req.url.startsWith('/exec/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    // Read JSON body
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);
    const { resolveWorkspaceCwd } = require('./terminalService');
    const cwd = resolveWorkspaceCwd(slug);

    console.log(`[Exec] slug=${slug} cwd=${cwd} cmd=${command.slice(0, 120)}`);

    const { spawn } = require('child_process');
    const isWin = require('os').platform() === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const MAX_OUT = 50000;

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      console.log(`[Exec] Done: exitCode=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B stderr=${stderr.length}B`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exitCode, stdout, stderr, timedOut }));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[Exec] Spawn error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  if (req.url.startsWith('/workspaces') && req.method === 'GET') {
      try {
          // Parse query params for owner
          const url = new URL(req.url, `http://${req.headers.host}`);
          const owner = url.searchParams.get('owner');
          
          const workspaces = workspaceManager.getWorkspaces(owner);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(workspaces));
      } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
      }
      return;
  }

  if (req.url.startsWith('/git/')) {
    // Parse URL: /git/:slug/:action
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // parts[0] = '', parts[1] = 'git', parts[2] = slug, parts[3] = action
    const slug = parts[2];
    const action = parts[3];

    if (!slug || !action) {
        res.writeHead(400);
        res.end('Invalid request');
        return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const data = body ? JSON.parse(body) : {};
            // Merge query params into data
            for (const [key, value] of urlObj.searchParams) {
                data[key] = value;
            }

        // Ensure the workspace repo exists for this slug.
        // This avoids REPO_NOT_FOUND for fresh workspaces and allows the server to
        // hydrate from GCS automatically (when configured) without requiring a manual
        // "Initialize Git" click.
        if (action !== 'clone' && !gitService.isRepoExists(slug)) {
          try {
            // initRepo will mkdir the repo path, init .git, and (when configured)
            // pull the current workspace contents from GCS.
            await gitService.initRepo(slug, null);
          } catch (e) {
            // If init fails, continue so the normal handler can return a structured error.
            // (Most read paths will fail and the frontend can fall back to storage.)
            if (gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
              console.warn('[Collab] auto-init repo failed for slug:', slug, e?.message || e);
            }
          }
        }

            let result;

            switch (action) {
                case 'init':
                    result = await gitService.initRepo(slug, data.remoteUrl);
                    break;
                case 'add-remote':
                    result = await gitService.addRemote(slug, data.name, data.url);
                    break;
                case 'remove-remote':
                    result = await gitService.removeRemote(slug, data.name);
                    break;
                case 'remotes':
                    result = await gitService.getRemotes(slug);
                    break;
                case 'clone':
                  result = await gitService.cloneRepo(slug, data.repoUrl, data.token);
                  // Save metadata locally
                  workspaceManager.addWorkspace(slug, data.repoUrl, data.owner, data.name);

                  // Try to create the workspace in the main Synthi app DB so the web UI finds it.
                  // Use environment var SYNTHI_APP_URL or default to http://localhost:3000
                  const SYNTHI_APP_URL = process.env.SYNTHI_APP_URL || 'http://localhost:3000';

                  // Determine fetch function - prefer global fetch (Node 18+), otherwise require node-fetch
                  let fetchFunc = null;
                  if (typeof fetch === 'function') {
                    fetchFunc = fetch;
                  } else {
                    try {
                      fetchFunc = require('node-fetch');
                    } catch (e) {
                      fetchFunc = null;
                    }
                  }

                  if (fetchFunc) {
                    const payload = {
                      name: data.name || slug,
                      slug: slug,
                      repoUrl: data.repoUrl || null
                    };

                    // Retry mechanism
                    const maxAttempts = 3;
                    let attempt = 0;
                    let created = false;
                    while (attempt < maxAttempts && !created) {
                      attempt += 1;
                      try {
                        const res = await fetchFunc(`${SYNTHI_APP_URL}/api/workspace`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        });

                        if (res.ok || res.status === 409) { // 201 created or 409 already exists are acceptable
                          created = true;
                          console.log(`[Collab] Notified Synthi app to create workspace '${slug}' (status ${res.status})`);
                          break;
                        } else {
                          const txt = await res.text().catch(() => '');
                          console.warn(`[Collab] Synthi app returned ${res.status} creating workspace '${slug}': ${txt}`);
                        }
                      } catch (err) {
                        console.warn(`[Collab] Attempt ${attempt} failed to call Synthi app for workspace creation:`, err?.message || err);
                      }

                      if (!created && attempt < maxAttempts) {
                        // simple exponential backoff
                        await new Promise(r => setTimeout(r, 1000 * attempt));
                      }
                    }

                    if (!created) {
                      // If we could not create the workspace record, fail the request - otherwise the UI will redirect to a workspace that 404s
                      const errMsg = `Failed to notify Synthi app to create workspace '${slug}' after ${maxAttempts} attempts.`;
                      console.error('[Collab]', errMsg);
                      // Throw an error to be handled by the outer catch and return non-200
                      throw new Error(errMsg);
                    }
                  } else {
                    console.warn('[Collab] Fetch not available - skipping workspace creation in main app. Set SYNTHI_APP_URL or install node-fetch.');
                  }

                  break;
                case 'status':
                    result = await gitService.getStatus(slug);
                    break;
                case 'branches':
                    result = await gitService.getBranches(slug);
                    break;
                case 'checkout':
                    result = await gitService.checkout(slug, data.branch, data.create);
                    break;
                case 'fetch':
                    result = await gitService.fetch(slug);
                    break;
                case 'commit':
                    result = await gitService.commit(slug, data.message);
                    break;
                case 'stage':
                    result = await gitService.stageFile(slug, data.filePath);
                    break;
                case 'stage-all':
                    result = await gitService.stageAll(slug);
                    break;
                case 'stage-lines':
                    result = await gitService.stageLines(slug, data.filePath, data.patch);
                    break;
                case 'unstage':
                    result = await gitService.unstageFile(slug, data.filePath);
                    break;
                case 'unstage-all':
                    result = await gitService.unstageAll(slug);
                    break;
                case 'push':
                    result = await gitService.push(slug);
                    break;
                case 'pull':
                    result = await gitService.pull(slug);
                    break;
                case 'discard':
                    result = await gitService.discardChange(slug, data.filePath);
                    break;
                case 'discard-all':
                    result = await gitService.discardAll(slug);
                    break;
                // Merge conflict resolution
                case 'resolve-ours':
                    result = await gitService.resolveConflictOurs(slug, data.filePath);
                    break;
                case 'resolve-theirs':
                    result = await gitService.resolveConflictTheirs(slug, data.filePath);
                    break;
                case 'mark-resolved':
                    result = await gitService.markResolved(slug, data.filePath);
                    break;
                case 'abort-merge':
                    result = await gitService.abortMerge(slug);
                    break;
                case 'conflict-versions':
                    result = await gitService.getConflictVersions(slug, data.filePath);
                    break;
                case 'diff':
                    result = await gitService.getDiff(slug, data.filePath, { parsed: data.parsed });
                    break;
                case 'file-content':
                    const fileContent = await gitService.getFileContent(slug, data.filePath, data.ref);
                    result = { content: fileContent };
                    break;
                case 'log':
                    result = await gitService.getLog(slug, { page: data.page, limit: data.limit });
                    break;
                case 'unpushed':
                    const max = data && data.max ? parseInt(data.max, 10) : 50;
                    result = await gitService.getUnpushedCommits(slug, max);
                    break;
                case 'incoming':
                    const incomingMax = data && data.max ? parseInt(data.max, 10) : 50;
                    result = await gitService.getIncomingCommits(slug, incomingMax);
                    break;
                case 'blame':
                    result = await gitService.getBlame(slug, data.filePath);
                    break;
                // Stash operations
                case 'stash-list':
                    result = await gitService.stashList(slug);
                    break;
                case 'stash-push':
                    result = await gitService.stashPush(slug, data.message);
                    break;
                case 'stash-pop':
                    result = await gitService.stashPop(slug, data.index);
                    break;
                case 'stash-apply':
                    result = await gitService.stashApply(slug, data.index);
                    break;
                case 'stash-drop':
                    result = await gitService.stashDrop(slug, data.index);
                    break;
                case 'sync':
                    // Sync a single file
                    await gitService.syncFile(slug, data.filePath, data.content);
                    result = { success: true };
                    break;
                case 'files':
                    result = await gitService.listFiles(slug);
                    break;
                case 'files-meta':
                  // Metadata only (no content)
                  result = { files: await gitService.listFilesMeta(slug) };
                  // Kick off index build in background (non-blocking)
                  try {
                    fileIndex.ensureIndex(slug, gitService.getRepoPath(slug)).catch(() => {});
                  } catch (_) {}
                  break;
                case 'index-ensure':
                  // Non-blocking ensure; returns immediately with current status
                  try {
                    fileIndex.ensureIndex(slug, gitService.getRepoPath(slug)).catch(() => {});
                  } catch (_) {}
                  result = fileIndex.getStatus(slug);
                  break;
                case 'index-status':
                  result = fileIndex.getStatus(slug);
                  break;
                case 'search':
                  // Index-first search; never reads disk on request
                  result = fileIndex.search(slug, data.q || data.query || '');
                  break;
                case 'open-lookup':
                  result = fileIndex.fileLookup(slug, data.q || data.query || '');
                  break;
                case 'imports':
                  result = fileIndex.getImports(slug, data.filePath || data.path || '');
                  break;
                case 'file':
                    const content = await gitService.readFile(slug, data.path);
                    result = { content };
                    break;
                case 'file-hash':
                    // Get content hash for a file (for VFS validation)
                    try {
                        const hashContent = await gitService.readFile(slug, data.path);
                        const hashValue = computeHash(hashContent);
                        result = { hash: hashValue, path: data.path };
                    } catch (e) {
                        result = { hash: null, path: data.path, error: e.message };
                    }
                    break;
                case 'write-file':
                    await gitService.writeFile(slug, data.path, data.content);
                    result = { success: true };
                    break;
                case 'write-files-batch':
                  // Batch write many files (supports base64 for binary).
                  // Payload shape: { files: [{ path, encoding: 'utf8'|'base64', content }] }
                  result = await gitService.writeFilesBatch(slug, data.files, {
                    syncToGcs: data.syncToGcs !== false,
                  });
                  break;
                case 'create-directory':
                    await gitService.createDirectory(slug, data.path);
                    result = { success: true };
                    break;
                case 'delete-item':
                    // Delete a file or folder from the workspace
                    console.log('[Collab] delete-item called for:', slug, data.path);
                    result = await gitService.deleteItem(slug, data.path);
                    console.log('[Collab] delete-item result:', result);
                    break;
                case 'clear-collab':
                    // Clear Yjs persistence for specified files (used after merge conflict resolution)
                    const filesToClear = Array.isArray(data.files) ? data.files : (data.path ? [data.path] : []);
                    for (const filePath of filesToClear) {
                        const docName = `workspace:${slug}:${filePath}`;
                        await clearDocumentPersistence(docName);
                    }
                    result = { success: true, cleared: filesToClear.length };
                    break;
                default:
                    res.writeHead(404);
                    res.end('Unknown action');
                    return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            // Handle structured GitError responses
            if (e.code && e.toJSON) {
                const statusCode = e.code === 'REPO_NOT_FOUND' || e.code === 'REPO_NOT_INITIALIZED' ? 404 : 
                                   e.code === 'AUTH_FAILED' || e.code === 'NO_REMOTE' ? 400 :
                                   e.code === 'MERGE_CONFLICT' ? 409 : 400;
                console.debug('[Collab] Git error:', e.code, e.message);
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(e.toJSON()));
                return;
            }
            
            // Legacy error handling for unstructured errors
            const msg = e?.message || '';
            if (msg.includes('not initialized') || msg.includes('not found') || msg.includes('no remote configured') || msg.includes('no configured push destination') || msg.includes('authentication failed') || msg.includes('user cancelled') || msg.includes('user cancelled dialog') || msg.includes('repository not found') || msg.includes('remote: repository not found')) {
                console.debug('[Collab] Client error in /git/:', msg);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: msg }));
            } else {
                console.error(e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: msg }));
            }
        }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Synthi collaboration server is running');
});

const wss = new WebSocket.Server({ noServer: true });

// Track active documents and their content for debugging
const activeDocuments = new Map(); // docName -> { ydoc, lastContent, clientCount }

wss.on('connection', (ws, req) => {
  const roomName = req.url ? req.url.slice(1).split('?')[0] : 'unknown';
  const clientIp = req.socket?.remoteAddress || 'unknown';
  
  console.log(`[Collab DEBUG] === WebSocket Connection ===`);
  console.log(`[Collab DEBUG]   Room: ${roomName}`);
  console.log(`[Collab DEBUG]   Client IP: ${clientIp}`);
  console.log(`[Collab DEBUG]   URL: ${req.url}`);
  
  // setupWSConnection handles the y-websocket protocol for a Y.Doc room
  setupWSConnection(ws, req, {
    persistence,
    docName: roomName,
  });
  
  // Track this connection
  if (!activeDocuments.has(roomName)) {
    activeDocuments.set(roomName, { clientCount: 0, lastUpdate: Date.now() });
  }
  const docInfo = activeDocuments.get(roomName);
  docInfo.clientCount++;
  console.log(`[Collab DEBUG]   Active clients for ${roomName}: ${docInfo.clientCount}`);
  
  ws.on('message', (data) => {
    // Handle both Buffer and string messages safely
    const byteLen = Buffer.isBuffer(data) ? data.length : (typeof data === 'string' ? Buffer.byteLength(data) : 0);
    if (byteLen > 0) {
      console.log(`[Collab DEBUG] Message received for ${roomName}: ${byteLen} bytes`);
    }
    docInfo.lastUpdate = Date.now();
  });
  
  ws.on('close', () => {
    docInfo.clientCount--;
    console.log(`[Collab DEBUG] Connection closed for ${roomName}. Remaining clients: ${docInfo.clientCount}`);
  });
  
  ws.on('error', (err) => {
    console.error(`[Collab DEBUG] WebSocket error for ${roomName}:`, err.message);
  });
});

// ─── Terminal PTY WebSocket Server ──────────────────────────────────────────
const terminalWSS = createTerminalWSS();

server.on('upgrade', (request, socket, head) => {
  const pathname = (request.url || '').split('?')[0];

  // Route /terminal upgrades to the PTY terminal service
  if (pathname === '/terminal') {
    console.log(`[Terminal] Upgrade request for PTY terminal`);
    terminalWSS.handleUpgrade(request, socket, head);
    return;
  }

  // Route /port/<N>/... WS upgrades to the reverse proxy (HMR, hot-reload)
  if (pathname.startsWith('/port/')) {
    const handled = proxyService.proxyWsUpgrade(request, socket, head);
    if (handled) return;
    // If the port isn't active, fall through (socket already destroyed by proxyWsUpgrade)
    return;
  }

  // Everything else → Yjs room (collab)
  const roomName = pathname.slice(1) || 'unknown';
  console.log(`[Collab DEBUG] Upgrade request for room: ${roomName}`);
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Collaboration server (y-websocket) listening on port ${PORT}`);
  console.log(`[Collab DEBUG] Server started with persistence: ${LeveldbPersistence ? 'LevelDB' : 'In-Memory'}`);

  // Start the port scanner so /port/<N> proxy routes work
  proxyService.startScanner(Number(PORT));

  // Notify terminal clients when dev-server ports open/close
  proxyService.onPortsChanged((ports) => {
    terminalBroadcast({ type: 'ports', ports });
  });
});
