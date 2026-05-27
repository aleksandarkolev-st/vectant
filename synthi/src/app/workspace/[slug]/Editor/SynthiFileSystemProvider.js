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
let currentSlug = null;          // for lazy-fetch from collab-server
let inFlightFetches = new Map(); // path → Promise (dedupe concurrent fetches)

// File extensions worth lazy-fetching as text. Binary blobs (images,
// archives, fonts) would just produce garbage when treated as UTF-8 strings
// and would also bloat the in-memory overlay; skip them.
const TEXT_LAZY_FETCH_EXTS = new Set([
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'ipp', 'inl',
    'java', 'kt', 'kts', 'scala', 'groovy',
    'cs', 'fs', 'vb',
    'rs', 'go', 'swift', 'zig',
    'py', 'pyi', 'pyx',
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'rb', 'php', 'pl', 'lua', 'r',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env',
    'md', 'markdown', 'txt', 'rst',
    'xml', 'svg', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'dockerfile', 'gitignore', 'gitattributes',
    'gradle', 'sbt', 'pom', 'cmake', 'makefile', 'mk',
    'tex', 'bib',
]);

function isTextLikePath(path) {
    if (!path) return false;
    const lower = path.toLowerCase();
    // Special-cased filenames without extensions
    if (lower.endsWith('/dockerfile') || lower === 'dockerfile') return true;
    if (lower.endsWith('/makefile') || lower === 'makefile') return true;
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return false;
    return TEXT_LAZY_FETCH_EXTS.has(lower.slice(dot + 1));
}

/**
 * Initialise (or re-initialise) the virtual filesystem overlay.
 *
 * @param {Array<[string, string]>} fileCacheEntries  — [[path, content], …]
 * @param {Array}                   rawFiles          — workspace file tree
 * @param {string}                  [slug]            — workspace slug for lazy-fetch
 */
export async function initSynthiFileSystem(fileCacheEntries, rawFiles, slug) {
    if (slug) currentSlug = slug;
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

    // Register files that have cached content and aren't already registered.
    // For workspace files we know exist but have no cache entry yet, register
    // an empty placeholder + kick off a lazy fetch from collab-server. This
    // prevents Monaco's text-model resolver (e.g. createModelReference fired
    // by go-to-definition, breadcrumbs, hover peek) from falling through to
    // the default disk file service, which on Windows tries to read paths
    // like `\synthi\src\com\example\gui\SnakeGame.java` from the local FS
    // and surfaces a confusing "Unable to resolve nonexistent file" toast.
    for (const path of allPaths) {
        if (existingPaths.has(path)) {
            existingPaths.delete(path); // Mark as still present
            continue; // Already registered — updates handled by updateFile
        }
        const content = cacheMap.get(path);
        if (content != null) {
            registerSingleFile(fileProvider, RegisteredMemoryFile, URI, path, content);
        } else if (isTextLikePath(path)) {
            // Register empty placeholder so the overlay claims the URI now.
            registerSingleFile(fileProvider, RegisteredMemoryFile, URI, path, '');
            // Fetch real content in the background; updateFile() will refresh
            // the registration once it arrives.
            scheduleLazyFetch(path);
        }
    }

    // Also register any cache entries not in the tree (e.g. newly created files)
    for (const [path, content] of cacheMap) {
        if (content == null || fileDisposables.has(path)) continue;
        registerSingleFile(fileProvider, RegisteredMemoryFile, URI, path, content);
    }
}

function scheduleLazyFetch(path) {
    if (!currentSlug || inFlightFetches.has(path)) return;
    // Defer the import so we don't pull api.js into the critical init path.
    const p = (async () => {
        try {
            const { api } = await import('@/services/api');
            const content = await api.fetchFileContent(currentSlug, path);
            if (typeof content === 'string') {
                await updateFile(path, content);
            }
        } catch (e) {
            // Non-fatal: the placeholder stays empty. Real-content load
            // will still happen if/when the user opens the file directly.
            console.debug('[SynthiFS] lazy fetch skipped for', path, e?.message);
        } finally {
            inFlightFetches.delete(path);
        }
    })();
    inFlightFetches.set(path, p);
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
