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
  store.put({
    id: extension.id,
    manifest: extension.manifest,
    code: extension.code,
    installedAt: Date.now(),
    enabled: extension.enabled !== false,
  });
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
    const extName = (manifest.displayName || manifest.name || '').replace(/'/g, "\\'");

    if (!hasBrowserEntry && entryFile) {
      // ── Node-only extension: don't load the Node bundle ──────────────
      // The JS code uses Node.js APIs (process.binding, fs, child_process)
      // that cannot work in a web worker. Instead, provide stub code that
      // activates cleanly. Declarative contributions (syntax highlighting,
      // language definitions, views, etc.) still work from the manifest.
      console.warn(
        `[parseVSIX] ${manifest.publisher}.${manifest.name}: Node-only extension ` +
        `(has "main" but no "browser" field). Loading declarative contributions only.`
      );
      const grammarCount = Object.keys(grammars).length;
      const langCount = manifest.contributes?.languages?.length || 0;
      code = `
// ${extName} v${manifest.version}
// Node-only extension — declarative contributions loaded from manifest.
// ${grammarCount} grammar(s) and ${langCount} language definition(s) extracted.
// Full functionality requires a Node.js extension host (not available in web).
function activate(context) {
  console.log('[${manifest.publisher}.${manifest.name}] Activated (declarative mode: syntax highlighting, language config, views)');
}
function deactivate() {}
module.exports = { activate, deactivate };
`;
      manifest._nodeOnly = true;
    } else if (entryFile) {
      code = await entryFile.async('text');
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

    return { manifest, code, grammars, langConfigs };
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
