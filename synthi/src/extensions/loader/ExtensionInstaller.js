/**
 * Synthi Extension System - Extension Installer
 * Persists installed extensions to IndexedDB so they survive page reloads.
 * Also provides the "install from code" flow used by the UI.
 */

const DB_NAME = 'synthi-extension-registry';
const DB_VERSION = 1;
const STORE_NAME = 'installed';

/**
 * Open (or create) the IndexedDB database for extensions.
 * If the database exists but is missing the required store (e.g. from a
 * previous version conflict), it will be deleted and recreated.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB is not available'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('publisher', 'publisher', { unique: false });
        store.createIndex('name', 'name', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Verify the store actually exists (guards against stale DBs from
      // a previous version that shared the same name).
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        // Delete and retry once
        const delReq = indexedDB.deleteDatabase(DB_NAME);
        delReq.onsuccess = () => openDB().then(resolve, reject);
        delReq.onerror = () => reject(new Error('Failed to reset extension DB'));
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Wrap an IDB transaction-based operation in a Promise.
 */
function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('Transaction aborted'));
  });
}

/**
 * Save an installed extension to IndexedDB.
 * @param {{ id: string, manifest: object, code: string }} extension
 */
export async function saveExtension(extension) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const record = {
    id: extension.id,
    manifest: extension.manifest,
    code: extension.code,
    installedAt: Date.now(),
    enabled: extension.enabled !== false,
  };
  // Persist the real Node.js code for remote extension host if present
  if (extension.nodeCode) {
    record.nodeCode = extension.nodeCode;
  }
  store.put(record);
  await txPromise(tx);
  db.close();
}

/**
 * Get a single installed extension by ID.
 * @param {string} extensionId
 * @returns {Promise<object|null>}
 */
export async function getExtension(extensionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(extensionId);
    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Get all installed extensions.
 * @returns {Promise<object[]>}
 */
export async function getAllExtensions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result || []);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Remove an installed extension.
 * @param {string} extensionId
 */
export async function removeExtension(extensionId) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.delete(extensionId);
  await txPromise(tx);
  db.close();
}

/**
 * Update the enabled flag of an extension.
 * @param {string} extensionId
 * @param {boolean} enabled
 */
export async function setExtensionEnabled(extensionId, enabled) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const request = store.get(extensionId);
  
  return new Promise((resolve, reject) => {
    request.onsuccess = async () => {
      const ext = request.result;
      if (!ext) {
        db.close();
        return reject(new Error(`Extension ${extensionId} not found`));
      }
      ext.enabled = enabled;
      const putTx = db.transaction(STORE_NAME, 'readwrite');
      putTx.objectStore(STORE_NAME).put(ext);
      await txPromise(putTx);
      db.close();
      resolve();
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Clear all installed extensions.
 */
export async function clearAllExtensions() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.clear();
  await txPromise(tx);
  db.close();
}

/**
 * Fetch a VSIX from Open VSX and extract only the Node.js entry code.
 * Used to back-fill nodeCode for extensions that were cached before nodeCode
 * extraction was implemented. Saves the extracted nodeCode to IndexedDB.
 *
 * @param {string} extensionId - e.g. "GitHub.vscode-pull-request-github"
 * @param {object} manifest - The extension's manifest (needs publisher + name + version)
 * @returns {Promise<string|null>} The extracted Node.js code, or null if unavailable
 */
export async function fetchNodeCodeForExtension(extensionId, manifest) {
  try {
    const publisher = manifest.publisher || extensionId.split('.')[0];
    const name = manifest.name || extensionId.split('.').slice(1).join('.');
    const version = manifest.version;
    if (!publisher || !name) return null;

    const dlParams = new URLSearchParams({
      action: 'download-vsix',
      namespace: publisher,
      extension: name,
      ...(version ? { version } : {}),
    });
    const vsixRes = await fetch(`/api/extensions/search?${dlParams}`);
    if (!vsixRes.ok) return null;

    const vsixBuffer = await vsixRes.arrayBuffer();
    const { nodeCode } = await parseVSIX(vsixBuffer);
    if (!nodeCode) return null;

    // Persist the nodeCode to IndexedDB for future restores
    const existing = await getExtension(extensionId);
    if (existing) {
      existing.nodeCode = nodeCode;
      await saveExtension(existing);
    }

    console.log(`[ExtensionInstaller] Fetched nodeCode for ${extensionId}: ${(nodeCode.length / 1024).toFixed(0)} KB`);
    return nodeCode;
  } catch (err) {
    console.warn(`[ExtensionInstaller] Failed to fetch nodeCode for ${extensionId}:`, err.message);
    return null;
  }
}

/**
 * Parse a .vsix file (ZIP) and extract the manifest + extension code.
 * VSIX files are ZIP archives with:
 *   - extension/package.json  → manifest
 *   - extension/<main>        → entry JS file
 * 
 * NOTE: For now, this is a basic implementation. Full VSIX support would
 * need a ZIP library (e.g. JSZip). Extensions can be loaded directly
 * from code strings in the meantime.
 * 
 * @param {ArrayBuffer} vsixBuffer
 * @returns {Promise<{ manifest: object, code: string }>}
 */
/**
 * Recursively walk a manifest object and replace %key% NLS placeholders
 * with their resolved values from the NLS strings map.
 * Exported so that other modules (e.g. restore flow) can also resolve cached manifests.
 * @param {any} obj - The object to walk (manifest or sub-object)
 * @param {Record<string, string>} nlsStrings - Key→value localization map
 */
export function resolveNLS(obj, nlsStrings) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      const match = val.match(/^%(.*?)%$/);
      if (match) {
        const nlsKey = match[1];
        if (nlsStrings[nlsKey] !== undefined) {
          obj[key] = nlsStrings[nlsKey];
        }
      }
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'string') {
          const m = val[i].match(/^%(.*?)%$/);
          if (m && nlsStrings[m[1]] !== undefined) {
            val[i] = nlsStrings[m[1]];
          }
        } else if (typeof val[i] === 'object' && val[i]) {
          resolveNLS(val[i], nlsStrings);
        }
      }
    } else if (typeof val === 'object') {
      resolveNLS(val, nlsStrings);
    }
  }
}

export async function parseVSIX(vsixBuffer) {
  // We dynamically import JSZip if available; otherwise error gracefully
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(vsixBuffer);

    // Find package.json
    const manifestFile = zip.file('extension/package.json');
    if (!manifestFile) {
      throw new Error('VSIX archive does not contain extension/package.json');
    }
    const manifestText = await manifestFile.async('text');
    const manifest = JSON.parse(manifestText);

    // ── Extract TextMate grammars from the VSIX ────────────────────────
    // These are JSON/plist files referenced in contributes.grammars.
    // They provide syntax highlighting and work without running any JS.
    const grammars = {};
    if (Array.isArray(manifest.contributes?.grammars)) {
      for (const g of manifest.contributes.grammars) {
        if (!g.path) continue;
        const grammarPath = `extension/${g.path}`.replace(/^extension\/\.\//, 'extension/');
        const grammarFile = zip.file(grammarPath);
        if (grammarFile) {
          try {
            const grammarText = await grammarFile.async('text');
            grammars[g.scopeName || g.language] = {
              content: JSON.parse(grammarText),
              language: g.language,
              scopeName: g.scopeName,
              path: g.path,
            };
          } catch (_) {
            // plist or malformed JSON — skip
          }
        }
      }
    }

    // ── Extract language configuration files ───────────────────────────
    const langConfigs = {};
    if (Array.isArray(manifest.contributes?.languages)) {
      for (const lang of manifest.contributes.languages) {
        if (!lang.configuration) continue;
        const confPath = `extension/${lang.configuration}`.replace(/^extension\/\.\//, 'extension/');
        const confFile = zip.file(confPath);
        if (confFile) {
          try {
            const confText = await confFile.async('text');
            // Language config JSON may have comments — strip them
            const cleaned = confText.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            langConfigs[lang.id] = JSON.parse(cleaned);
          } catch (_) {
            // skip malformed
          }
        }
      }
    }

    // ── Extract and apply NLS (localization) strings ───────────────────
    // Many extensions use %key% placeholders in package.json that map to
    // values in package.nls.json. We must resolve these before the manifest
    // reaches Redux/UI, otherwise raw "%key%" strings appear as view names.
    const nlsFile = zip.file('extension/package.nls.json');
    let nlsStrings = {};
    if (nlsFile) {
      try {
        nlsStrings = JSON.parse(await nlsFile.async('text'));
      } catch (_) {
        // Malformed NLS file — continue without localization
      }
    }
    if (Object.keys(nlsStrings).length > 0) {
      resolveNLS(manifest, nlsStrings);
    }

    // Store extracted assets on the manifest for downstream use
    if (Object.keys(grammars).length > 0) manifest._grammars = grammars;
    if (Object.keys(langConfigs).length > 0) manifest._langConfigs = langConfigs;

    // ── Resolve the JS entry point ─────────────────────────────────────
    // Prefer the browser entry point — we run in a web worker, so the
    // Node.js bundle (main) will crash on process.binding, fs, etc.
    const hasBrowserEntry = !!manifest.browser;
    const entryField = manifest.browser || manifest.main || './extension.js';
    const entryPath = `extension/${entryField}`.replace(/^extension\/\.\//, 'extension/');

    let entryFile = zip.file(entryPath);
    let usedBrowserBundle = hasBrowserEntry && !!entryFile;

    // The manifest entry path may omit the file extension (e.g. "./dist/browser/extension").
    // Try common JS extensions before giving up.
    if (!entryFile) {
      for (const ext of ['.js', '.cjs', '.mjs']) {
        entryFile = zip.file(entryPath + ext);
        if (entryFile) {
          usedBrowserBundle = hasBrowserEntry;
          break;
        }
      }
    }

    // Fall back to main if browser file is still missing from the archive
    if (!entryFile && hasBrowserEntry && manifest.main) {
      const mainField = manifest.main;
      const fallbackPath = `extension/${mainField}`.replace(/^extension\/\.\//, 'extension/');
      console.warn(`[parseVSIX] Browser entry "${entryPath}" not found, falling back to main: "${fallbackPath}"`);
      entryFile = zip.file(fallbackPath);
      // Also try with extensions on the main fallback
      if (!entryFile) {
        for (const ext of ['.js', '.cjs', '.mjs']) {
          entryFile = zip.file(fallbackPath + ext);
          if (entryFile) break;
        }
      }
      usedBrowserBundle = false;
    }

    let code;
    let nodeCode = null; // Real Node.js bundle for remote extension host
    const extName = (manifest.displayName || manifest.name || '').replace(/'/g, "\\'");

    if (!hasBrowserEntry && entryFile) {
      // ── Node-only extension ──────────────────────────────────────────
      // The JS code uses Node.js APIs (process.binding, fs, child_process)
      // that cannot work in a web worker. Provide a lightweight stub for
      // the local worker, but ALSO extract the real Node.js bundle so the
      // remote extension host (server-side Node.js) can execute it.
      console.warn(
        `[parseVSIX] ${manifest.publisher}.${manifest.name}: Node-only extension ` +
        `(has "main" but no "browser" field). Extracting real code for remote host.`
      );

      // Extract the real Node.js bundle for the remote host
      nodeCode = await entryFile.async('text');

      const grammarCount = Object.keys(grammars).length;
      const langCount = manifest.contributes?.languages?.length || 0;
      code = `
// ${extName} v${manifest.version}
// Node-only extension — declarative contributions loaded from manifest.
// ${grammarCount} grammar(s) and ${langCount} language definition(s) extracted.
// Full functionality runs on the remote Node.js extension host.
function activate(context) {
  console.log('[${manifest.publisher}.${manifest.name}] Activated (declarative mode: syntax highlighting, language config, views)');
}
function deactivate() {}
module.exports = { activate, deactivate };
`;
      manifest._nodeOnly = true;
    } else if (entryFile) {
      code = await entryFile.async('text');

      // For dual-entry extensions (both browser + main), also extract the
      // Node.js bundle. If the browser bundle is too large for the web worker,
      // the system can fall back to the remote Node.js host.
      if (manifest.main && manifest.browser) {
        const mainPath = `extension/${manifest.main}`.replace(/^\.?\//, '').replace(/^extension\/\.\//,'extension/');
        const mainEntryPath = `extension/${manifest.main}`.replace(/^extension\/\.\//,'extension/');
        let mainFile = zip.file(mainEntryPath);
        if (!mainFile) {
          for (const ext of ['.js', '.cjs', '.mjs']) {
            mainFile = zip.file(mainEntryPath + ext);
            if (mainFile) break;
          }
        }
        if (mainFile) {
          nodeCode = await mainFile.async('text');
          console.log(
            `[parseVSIX] ${manifest.publisher}.${manifest.name}: dual-entry extension, ` +
            `extracted nodeCode (${nodeCode.length} chars) for remote host fallback.`
          );
        }
      }
    } else {
      // No entry file at all — provide minimal stub
      code = `
function activate() { console.log('[${manifest.publisher}.${manifest.name}] No entry point found'); }
function deactivate() {}
module.exports = { activate, deactivate };
`;
    }

    manifest._resolvedEntry = entryFile?.name || null;
    manifest._isWebBundle = usedBrowserBundle;

    return { manifest, code, nodeCode, grammars, langConfigs };
  } catch (e) {
    if (e.message?.includes('jszip')) {
      throw new Error(
        'VSIX parsing requires the "jszip" package. Install it with: npm install jszip. ' +
        'In the meantime, you can install extensions by providing code directly.'
      );
    }
    throw e;
  }
}
