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
