const http = require('http');
const WebSocket = require('ws');
// y-websocket exports have changed across versions and some environments do
// not allow accessing internal subpaths via package exports. Try a few
// common locations and fall back with a clear error message.
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
 * Wrapper persistence that validates cached state against actual file content.
 * This prevents stale data from being loaded when files change outside the editor.
 */
class ValidatingPersistence {
  constructor(innerPersistence) {
    this.inner = innerPersistence;
    // console.log('[Collab DEBUG] ValidatingPersistence wrapper initialized');
  }

  async bindState(docName, ydoc) {
    // console.log(\`[Collab DEBUG] === bindState START: \${docName} ===\`);
    
    // First, bind the persisted state (if any)
    if (this.inner.bindState) {
      // console.log(\`[Collab DEBUG]   Calling inner.bindState...\`);
      await this.inner.bindState(docName, ydoc);
      // console.log(\`[Collab DEBUG]   Inner bindState completed\`);
    }

    // Now validate against actual file
    const parsed = parseDocName(docName);
    if (!parsed) {
      // Not a workspace document, skip validation
      // console.log(\`[Collab DEBUG]   Not a workspace document, skipping validation\`);
      return;
    }

    const { slug, filePath } = parsed;
    // console.log(\`[Collab DEBUG]   Parsed: slug=\${slug}, filePath=\${filePath}\`);
    
    const actualContent = await getActualFileContent(slug, filePath);
    
    if (actualContent === null) {
      // File doesn't exist on disk, keep persisted state
      // console.log(\`[Collab DEBUG]   File not found on disk, keeping persisted state\`);
      return;
    }

    const persistedContent = getYDocContent(ydoc);
    const actualHash = computeHash(actualContent);
    const persistedHash = computeHash(persistedContent);

    // console.log(\`[Collab DEBUG]   Persisted content: \${persistedContent.length} chars, hash=\${persistedHash.substring(0, 8)}\`);
    // console.log(\`[Collab DEBUG]   Actual file: \${actualContent.length} chars, hash=\${actualHash.substring(0, 8)}\`);
    // console.log(\`[Collab DEBUG]   Persisted preview: \${JSON.stringify(persistedContent.substring(0, 100))}...\`);
    // console.log(\`[Collab DEBUG]   Actual preview: \${JSON.stringify(actualContent.substring(0, 100))}...\`);

    if (actualHash !== persistedHash) {
      // console.log(\`[Collab DEBUG]   *** STALE DATA DETECTED ***\`);
      // console.log(\`[Collab DEBUG]   Resetting document to actual file content\`);

      // Clear the persisted state and reset to actual content
      if (this.inner.clearDocument) {
        await this.inner.clearDocument(docName);
        // console.log(\`[Collab DEBUG]   Cleared persisted state\`);
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
          });
          // console.log(\`[Collab DEBUG]   Reset text type '\${name}' with \${actualContent.length} chars\`);
          break;
        }
      }

      // Update hash cache
      fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });
    } else {
      // console.log(\`[Collab DEBUG]   Content is VALID (hashes match)\`);
      fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });
    }
    
    // console.log(\`[Collab DEBUG] === bindState END: \${docName} ===\`);
  }

  async writeState(docName, ydoc) {
    const content = getYDocContent(ydoc);
    console.log(`[Collab DEBUG] writeState: ${docName} (${content.length} chars)`);
    
    if (this.inner.writeState) {
      await this.inner.writeState(docName, ydoc);
    }
    
    // Update hash cache when writing
    fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });
  }

  async clearDocument(docName) {
    console.log(`[Collab DEBUG] clearDocument: ${docName}`);
    fileHashCache.delete(docName);
    if (this.inner.clearDocument) {
      await this.inner.clearDocument(docName);
    }
  }

  // Proxy other methods to inner persistence
  async flushDocument(docName) {
    console.log(`[Collab DEBUG] flushDocument: ${docName}`);
    if (this.inner.flushDocument) {
      await this.inner.flushDocument(docName);
    }
  }
}

// Wrap the base persistence with validation
const persistence = new ValidatingPersistence(basePersistence);

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
                case 'file':
                    const content = await gitService.readFile(slug, data.path);
                    result = { content };
                    break;
                case 'write-file':
                    await gitService.writeFile(slug, data.path, data.content);
                    result = { success: true };
                    break;
                case 'create-directory':
                    await gitService.createDirectory(slug, data.path);
                    result = { success: true };
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
    console.log(`[Collab DEBUG] Message received for ${roomName}: ${data.length} bytes`);
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

server.on('upgrade', (request, socket, head) => {
  const roomName = request.url ? request.url.slice(1).split('?')[0] : 'unknown';
  console.log(`[Collab DEBUG] Upgrade request for room: ${roomName}`);
  
  // We accept all WebSocket connections at any path (room name encoded in path)
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`Collaboration server (y-websocket) listening on port ${PORT}`);
  console.log(`[Collab DEBUG] Server started with persistence: ${LeveldbPersistence ? 'LevelDB' : 'In-Memory'}`);
});
