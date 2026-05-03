/**
 * SynthiFileSystemProvider
 *
 * Registers a virtual file-system overlay with @codingame/monaco-vscode-api
 * so that `file:///synthi/…` URIs resolve to content from the Redux file
 * cache instead of the (nonexistent) local filesystem.
 *
 * This fixes "Unable to resolve nonexistent file" errors that occur when
 * Monaco's FileService tries to stat/read file URIs that only exist on
 * the remote worker.
 */

let overlayDisposable = null;
let fileProvider = null;
let fileDisposables = new Map(); // path → IDisposable

/**
 * Initialise (or re-initialise) the virtual filesystem overlay.
 *
 * @param {Array<[string, string]>} fileCacheEntries  — [[path, content], …]
 * @param {Array}                   rawFiles          — workspace file tree
 */
export async function initSynthiFileSystem(fileCacheEntries, rawFiles) {
    const {
        registerFileSystemOverlay,
        RegisteredFileSystemProvider,
        RegisteredMemoryFile,
    } = await import('@codingame/monaco-vscode-files-service-override');
    const { URI } = await import('@codingame/monaco-vscode-api/vscode/vs/base/common/uri');

    // Create the provider once; subsequent calls just update files
    if (!fileProvider) {
        fileProvider = new RegisteredFileSystemProvider(false /* not read-only */);
        // Priority 10 so our overlay wins over the default empty FS (priority 0)
        overlayDisposable = registerFileSystemOverlay(10, fileProvider);
    }

    // Build a set of paths we already have registered
    const existingPaths = new Set(fileDisposables.keys());

    // Collect all file paths + content from the cache
    const cacheMap = new Map(fileCacheEntries || []);

    // Walk the file tree to discover all paths (even those without cache)
    const allPaths = new Set();
    const walk = (nodes) => {
        if (!nodes) return;
        for (const node of nodes) {
            if (node.isFolder) {
                // Skip heavy directories the LSP doesn't need
                const name = node.name?.toLowerCase();
                if (['node_modules', '.git', '__pycache__', 'target', 'build', 'dist',
                    '.gradle', '.idea', 'bin', 'obj', '.dart_tool', '_build', 'deps',
                    '.elixir_ls', '.jdtls-data', 'zig-cache', '.next', 'vendor',
                    'zig-out', '.zig-cache', 'coverage', '.nyc_output'].includes(name)) continue;
                walk(node.children);
            } else if (node.path) {
                allPaths.add(node.path);
            }
        }
    };
    walk(rawFiles);

    // Register files that have cached content and aren't already registered
    for (const path of allPaths) {
        const content = cacheMap.get(path);
        if (!content) continue; // Skip files without cached content
        if (existingPaths.has(path)) {
            existingPaths.delete(path); // Mark as still present
            continue; // Already registered — skip (updates handled by updateFile)
        }
        registerSingleFile(fileProvider, RegisteredMemoryFile, URI, path, content);
    }

    // Also register any cache entries not in the tree (e.g. newly created files)
    for (const [path, content] of cacheMap) {
        if (!content || fileDisposables.has(path)) continue;
        registerSingleFile(fileProvider, RegisteredMemoryFile, URI, path, content);
    }
}

function registerSingleFile(provider, RegisteredMemoryFile, URI, path, content) {
    try {
        const safePath = path.startsWith('/') ? path.slice(1) : path;
        const uri = URI.parse(`file:///synthi/${safePath}`);
        const file = new RegisteredMemoryFile(uri, content);
        const disposable = provider.registerFile(file);
        fileDisposables.set(path, disposable);
    } catch (e) {
        // Silently skip files that fail to register (e.g. invalid paths)
        console.warn('[SynthiFS] Failed to register file:', path, e.message);
    }
}

/**
 * Update a single file's content in the virtual FS.
 * Re-registers the file so the in-memory content is refreshed.
 *
 * @param {string} path    — workspace-relative path
 * @param {string} content — new file content
 */
export async function updateFile(path, content) {
    if (!fileProvider) return;
    const {
        RegisteredMemoryFile,
    } = await import('@codingame/monaco-vscode-files-service-override');
    const { URI } = await import('@codingame/monaco-vscode-api/vscode/vs/base/common/uri');

    // Dispose old registration
    const old = fileDisposables.get(path);
    if (old) {
        old.dispose();
        fileDisposables.delete(path);
    }

    if (content != null) {
        registerSingleFile(fileProvider, RegisteredMemoryFile, URI, path, content);
    }
}

/**
 * Remove a file from the virtual FS.
 *
 * @param {string} path — workspace-relative path
 */
export function removeFile(path) {
    const d = fileDisposables.get(path);
    if (d) {
        d.dispose();
        fileDisposables.delete(path);
    }
}

/**
 * Register an absolute system path (e.g. /usr/include/c++/11/iostream)
 * with the overlay so Monaco's file service can resolve it the next time
 * a feature (go-to-definition, hover) navigates there. The URI scheme is
 * always `file:` because clangd and other servers emit `file://` URIs;
 * intercepting before Monaco gets the open request avoids a default
 * filesystem fallback that fails on Windows for Linux paths.
 *
 * Two URIs are registered for each path: the canonical `URI.file(absPath)`
 * form Monaco produces for go-to-definition and the verbatim URI string
 * the LSP returned (if different). Encoding round-trips between clangd
 * and Monaco can otherwise produce two URI strings that compare unequal
 * but resolve to the same file.
 *
 * @param {string} absPath Absolute path on the worker
 * @param {string} content File contents
 * @param {string} [originalUri] The exact URI string the LSP emitted
 * @returns {Promise<boolean>} true on success
 */
export async function registerSystemFile(absPath, content, originalUri) {
    if (!fileProvider) {
        // initSynthiFileSystem hasn't run yet; the overlay isn't installed.
        return false;
    }
    if (!absPath || typeof content !== 'string') return false;
    const {
        RegisteredMemoryFile,
    } = await import('@codingame/monaco-vscode-files-service-override');
    const { URI } = await import('@codingame/monaco-vscode-api/vscode/vs/base/common/uri');

    // Re-register if we already have it so the latest content wins.
    const dispose = (key) => {
        const old = fileDisposables.get(key);
        if (old) {
            try { old.dispose(); } catch (_) { /* ignored */ }
            fileDisposables.delete(key);
        }
    };
    const tryRegister = (uri, key) => {
        try {
            const file = new RegisteredMemoryFile(uri, content);
            const disposable = fileProvider.registerFile(file);
            fileDisposables.set(key, disposable);
            return true;
        } catch (e) {
            console.warn('[SynthiFS] registerSystemFile failed:', key, e?.message);
            return false;
        }
    };

    let ok = false;
    try {
        const canonical = URI.file(absPath);
        const canonicalKey = `sys:${canonical.toString()}`;
        dispose(canonicalKey);
        ok = tryRegister(canonical, canonicalKey) || ok;
    } catch (e) {
        console.warn('[SynthiFS] URI.file failed for', absPath, e?.message);
    }

    if (originalUri) {
        try {
            const verbatim = URI.parse(originalUri);
            const verbatimKey = `sys:${verbatim.toString()}`;
            if (!fileDisposables.has(verbatimKey)) {
                dispose(verbatimKey);
                ok = tryRegister(verbatim, verbatimKey) || ok;
            }
        } catch (e) {
            console.warn('[SynthiFS] URI.parse failed for', originalUri, e?.message);
        }
    }

    if (ok) fileDisposables.set(`syspath:${absPath}`, { dispose: () => {} });
    return ok;
}

/**
 * Has a system file already been registered? Lets callers skip a
 * round-trip to the worker for files we've cached this session.
 * @param {string} absPath
 */
export function hasSystemFile(absPath) {
    return fileDisposables.has(`syspath:${absPath}`);
}

/**
 * Tear down the overlay (e.g. on unmount).
 */
export function disposeSynthiFileSystem() {
    for (const [, d] of fileDisposables) {
        try { d.dispose(); } catch (_) {}
    }
    fileDisposables.clear();
    if (overlayDisposable) {
        overlayDisposable.dispose();
        overlayDisposable = null;
    }
    fileProvider = null;
}
