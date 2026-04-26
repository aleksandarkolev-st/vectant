// src/redux/workspaceSlice.js
import { createSlice, createAsyncThunk, createSelector } from '@reduxjs/toolkit';
import { api } from '@/services/api'; 
import collabClient from '@/services/collabClient';
import { getCompilerClient } from '@/services/compilerClient';
import { cancelUiAction } from './uiSlice'; // Cross-slice dependency
import { syncFileToGit, fetchGitStatus } from './gitSlice';
import { gitClient } from '@/services/gitClient';
import {
    findFirstFile,
    findFileInTree,
    findFolderInTree,
    getFileLanguage,
    getItemPathInBucket,
} from '@/utils/fileUtils'; 
import SynthiException from '@/components/SynthiException';
import { fileCache } from '@/services/fileCache';
import { loadScheduler } from '@/services/loadScheduler';
import { perfMeasureToConsole, perfOnce } from '@/services/perfMarkers';
import { openTab, selectNodes, selectTabs } from '@/components/docking-wm/state/layout-slice';
import { IDE_PANEL } from '@/components/docking-wm/panels/panel-types';

// --- Initial State and Utilities ---

/**
 * Normalize trailing newlines/carriage returns for content comparison.
 * Yjs sync can add/remove trailing newlines, so we strip them to avoid
 * false unsaved states.  Defined once at module level to avoid repeated
 * inline re-definitions (DRY).
 */
const normalizeTrailing = (s) => (typeof s === 'string' ? s.replace(/[\r\n]+$/, '') : '');

/**
 * Ensure the main editor panel tab exists in the docking layout.
 * If it was closed, re-open it in the center area so that file
 * selection / diff-open requests have somewhere to render.
 */
function ensureEditorPanel(dispatch, getState) {
    const layoutState = getState().layout;
    if (!layoutState) return;
    const nodes = layoutState.nodes || {};
    const tabs = layoutState.tabs || {};
    // Check if an editor panel tab already exists
    for (const node of Object.values(nodes)) {
        if (node.type !== 'tabgroup') continue;
        for (const tabId of node.tabs || []) {
            const t = tabs[tabId];
            if (t && t.panelType === IDE_PANEL.EDITOR) return; // already open
        }
    }
    // Also check floating windows
    for (const fw of Object.values(layoutState.floating || {})) {
        const t = tabs[fw.tabId];
        if (t && t.panelType === IDE_PANEL.EDITOR) return;
    }
    // Editor panel is missing — re-open it in the center area
    const groups = Object.entries(nodes).filter(([, n]) => n.type === 'tabgroup');
    const SIDEBAR = new Set(['explorer', 'search', 'git', 'extensions', 'extension-view', 'chat', 'pullrequests', 'settings']);
    let targetGroupId = null;
    // Prefer a center group (one that does not contain sidebar panels)
    for (const [gid, group] of groups) {
        const hasSidebar = (group.tabs || []).some(tid => {
            const t = tabs[tid];
            return t && SIDEBAR.has(t.panelType);
        });
        if (!hasSidebar) { targetGroupId = gid; break; }
    }
    if (!targetGroupId && groups.length > 0) targetGroupId = groups[0][0];
    if (targetGroupId) {
        dispatch(openTab({ panelType: IDE_PANEL.EDITOR, title: 'Editor', closable: true, targetTabGroupId: targetGroupId }));
    }
}

export const initialWorkspaceState = {
    slug: null,
    rawFiles: [],
    // Tracks files that the user has opened in tabs (order matters)
    // Each item: { path, name, language, isUnsaved }
    openFiles: [],
    activeFile: null,
    currentContent: '',
    savedContent: '',
    originalContent: '', // For diff view
    diffMode: false,     // Toggle diff view
    fileContentCache: new Map(), // Deprecated (hybrid cache is in services/fileCache)
    loadingFiles: [],    // Tracks files currently being fetched
    _filesFetching: false, // Dedup guard for fetchFilesThunk
    isLoading: false,
    status: 'idle',
    error: null,
    // Per-file savedContent cache — preserves the "last saved" baseline
    // across tab switches so the unsaved dot survives the auto-flush.
    _savedContentByPath: {},
    // Stashed pre-conflict CRDT content: { [filePath]: { content, at } }.
    // Written by selectFileThunk when a file becomes conflicted and its
    // Yjs doc is about to be destroyed.  Read by conflict-recovery UI so
    // users can reapply their unsynced edits after resolving conflicts.
    _conflictRecovery: {},
};

// --- ASYNC THUNKS (Side Effects and Persistence) ---

// Track queued re-fetch for fetchFilesThunk (mirrors fetchGitStatus dedup pattern)
let _pendingFilesFetchSlug = null;

/**
 * In-flight save coalescing registry.  Keyed by "slug:filePath".  Each entry:
 *   { promise, content, queued } where `queued` captures the latest content
 *   submitted while `promise` is in flight, so we run one chained save after
 *   the current one finishes (and coalesce everything else onto it).
 *
 * Prevents double-writes when the user spams Ctrl+S (two requests racing, the
 * later one possibly landing with stale content) and when auto-save fires
 * while a manual save is already on the wire.
 */
const _inflightSaves = new Map();

/**
 * Lazy toast dispatcher — avoids a hard import of sonner (keeps SSR / tests
 * happy when the toaster isn't mounted).  Silently no-ops if unavailable.
 */
function _toastError(message, description) {
    if (typeof window === 'undefined') return;
    import('sonner').then(({ toast }) => {
        try {
            toast.error(message, description ? { description, duration: 6000 } : { duration: 6000 });
        } catch (_) { /* ignore */ }
    }).catch(() => { /* sonner unavailable */ });
}

function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 1. Fetch Files (Read)
export const fetchFilesThunk = createAsyncThunk(
    'workspace/fetchFiles',
    async (slug, { dispatch, getState }) => {
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        // Notify compiler client about the active slug
        try {
            getCompilerClient().setSlug(slug);
        } catch (e) {
            console.warn("Failed to set slug on compiler client", e);
        }

        const files = await api.fetchFiles(slug);
        if (t0) perfMeasureToConsole('startup_metadata_load_time', t0, { slug });
        const state = getState().workspace;

        // Determine if auto-selection is needed
        let fileToSelect = null;
        if (!state.activeFile && files.length > 0) {
            const found = findFirstFile(files);
            if (found) {
                dispatch(selectFileThunk(found));
            }
        }

        // If another fetch was queued while we were in-flight, re-dispatch
        if (_pendingFilesFetchSlug) {
            const queuedSlug = _pendingFilesFetchSlug;
            _pendingFilesFetchSlug = null;
            queueMicrotask(() => dispatch(fetchFilesThunk(queuedSlug)));
        }

        // Return files and potential file to select for the reducer
        return { files, fileToSelect };
    },
    {
        // Prevent redundant concurrent fetches — queue a re-fetch instead
        condition: (slug, { getState }) => {
            const { workspace } = getState();
            if (workspace._filesFetching) {
                _pendingFilesFetchSlug = slug;
                return false;
            }
        },
    }
);

// 2. Save Content (Mutation)
export const saveFileContentThunk = createAsyncThunk(
    'workspace/saveContent',
    async (_, { dispatch, getState }) => {
        const state = getState().workspace;
        const { activeFile, currentContent, slug } = state;

        if (!activeFile) {
            return;
        }

        // Determine the authoritative content to save.
        // Use Redux editor content as the source of truth; CRDT snapshots can
        // momentarily lag during high-frequency edits and cause stale writes.
        const contentToSave = currentContent;

        // Skip ONLY when content truly hasn't changed (after normalization).
        // No git-status refresh here — there was no disk write, so nothing
        // changed from git's perspective.  Out-of-band changes (terminal edits,
        // fs-watcher events) are caught by the FS-watcher-based refresh instead.
        //
        // IMPORTANT: use _preSaveSavedContent as the baseline, NOT savedContent.
        // The `pending` reducer optimistically sets savedContent = currentContent
        // before this async function runs.  Reading savedContent here would
        // always produce a false "no change" match and skip the network write.
        // _preSaveSavedContent holds the real pre-optimistic value.
        const savedBaseline = state._preSaveSavedContent !== undefined
            ? state._preSaveSavedContent
            : state.savedContent;
        if (normalizeTrailing(contentToSave) === normalizeTrailing(savedBaseline)) {
            return contentToSave; // fulfilled reducer marks as saved
        }

        // Large-file guard: multi-MB files can blow up the CRDT transport,
        // OOM the frontend, and stall GCS/disk writes.  Reject early with a
        // clear message instead of partially corrupting anything.
        const MAX_SAVE_BYTES = 20 * 1024 * 1024; // 20 MiB
        const payloadBytes = typeof contentToSave === 'string'
            ? (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(contentToSave).length : contentToSave.length)
            : 0;
        if (payloadBytes > MAX_SAVE_BYTES) {
            const err = new Error(`File too large to save (${(payloadBytes / 1024 / 1024).toFixed(1)} MB > 20 MB)`);
            err.code = 'FILE_TOO_LARGE';
            throw err;
        }

        // Coalesce concurrent saves for the same file.  If one is already in
        // flight, queue the latest content for a single follow-up save after
        // it lands — prevents a "second request overwrites first with stale
        // content" race when the user hits Ctrl+S twice.
        const dedupKey = `${slug}:${activeFile.path}`;
        const existing = _inflightSaves.get(dedupKey);
        if (existing) {
            if (normalizeTrailing(existing.content) === normalizeTrailing(contentToSave)) {
                // Same content already on the wire — just reuse the promise.
                return existing.promise;
            }
            // Newer content to send.  Record it as the queued follow-up and
            // chain onto the existing in-flight save.
            existing.queued = contentToSave;
            return existing.promise.then(() => {
                // By the time the chain runs, a later dispatch may have
                // queued yet newer content; use whatever is latest.
                const latest = _inflightSaves.get(dedupKey)?.queued ?? contentToSave;
                return _performSave(dispatch, slug, activeFile.path, latest, dedupKey);
            });
        }

        return _performSave(dispatch, slug, activeFile.path, contentToSave, dedupKey);
    }
);

async function _performSave(dispatch, slug, filePath, contentToSave, dedupKey) {
    const entry = { content: contentToSave, queued: null, promise: null };
    _inflightSaves.set(dedupKey, entry);

    entry.promise = (async () => {
        try {
            try {
                await dispatch(syncFileToGit({ slug, filePath, content: contentToSave })).unwrap();
            } catch (e) {
                // Tuned retry: exponential-ish backoff absorbs transient flaps
                // (network blip, auth race) better than an immediate retry.
                const isAuthRace = e?.statusCode === 401;
                const firstDelay = isAuthRace ? 0 : 500;
                console.warn(`[Save] First sync attempt failed, retrying in ${firstDelay}ms…`, e.message || e);
                if (firstDelay) await _sleep(firstDelay);
                try {
                    await dispatch(syncFileToGit({ slug, filePath, content: contentToSave })).unwrap();
                } catch (retryErr) {
                    console.warn('[Save] Second sync attempt failed, retrying in 1000ms…', retryErr.message || retryErr);
                    await _sleep(1000);
                    try {
                        await dispatch(syncFileToGit({ slug, filePath, content: contentToSave })).unwrap();
                    } catch (finalErr) {
                        console.error('[Save] All retries failed', finalErr);
                        // 403s are already toasted by gitClient; don't duplicate.
                        if (finalErr?.statusCode !== 403) {
                            _toastError(
                                `Couldn't save ${filePath.split('/').pop() || filePath}`,
                                finalErr?.message || 'Network error. Changes stay in the editor — try again.',
                            );
                        }
                        throw finalErr;
                    }
                }
            }
            dispatch(fetchGitStatus(slug));

            if (typeof window !== 'undefined' && filePath) {
                window.dispatchEvent(new CustomEvent('synthi:codeintel-index-file', {
                    detail: { filePath },
                }));
            }

            dispatch(fetchFilesThunk(slug));
            // Record a local snapshot so the user can recover if they
            // just saved something they didn't mean to — git commits
            // happen much later; this is the intermediate safety net.
            try { fileCache.pushSnapshot(filePath, contentToSave); } catch (_) { /* best-effort */ }
            return contentToSave;
        } finally {
            _inflightSaves.delete(dedupKey);
        }
    })();

    return entry.promise;
}

// 3. File Selection (Manages cache and fetches content)
export const selectFileThunk = createAsyncThunk(
    'workspace/selectFile',
    async (file, { dispatch, getState }) => {
        // Ensure the editor panel exists in the docking layout
        ensureEditorPanel(dispatch, getState);
        const state = getState().workspace;
        const gitState = getState().git;
        const slug = state.slug;
        const targetPath = file?.path;

        if (!targetPath) {
            return { file, content: file?.content || '', fromCache: false };
        }

        // Check if this file has a merge conflict - if so, always read from filesystem
        const conflictedFiles = gitState?.status?.conflictedFiles || [];
        const hasConflict = conflictedFiles.includes(targetPath);
        
        if (hasConflict) {
            console.log('[Workspace] File has merge conflict, forcing fresh read:', targetPath);
            // Invalidate cache for this file
            fileCache.delete(targetPath);
            // Snapshot any unsynced CRDT content before destroying the doc.
            // Without this, local edits that hadn't been flushed to disk yet
            // silently vanish when the conflict markers replace them.  We
            // stash the pre-conflict text under `_conflictRecovery` so the
            // UI (or a recovery tool) can restore it post-resolution.
            try {
                const crdtText = getCrdtBaselineIfNewer(slug, targetPath, '');
                if (typeof crdtText === 'string' && crdtText.length > 0) {
                    dispatch(stashConflictRecovery({ path: targetPath, content: crdtText, at: Date.now() }));
                    console.log(`[Workspace] Stashed ${crdtText.length} chars of pre-conflict CRDT content for ${targetPath}`);
                }
            } catch (e) {
                console.warn('[Workspace] CRDT snapshot before conflict destroy failed:', e);
            }
            // Destroy collab doc to prevent Yjs from overwriting
            try {
                collabClient.destroyDocument(slug, targetPath);
            } catch (e) {
                console.warn('[Workspace] Error destroying collab doc:', e);
            }
        }

        // Active file must never be evicted.
        fileCache.setActive(targetPath);

        const cached = hasConflict ? undefined : fileCache.get(targetPath);
        if (cached !== undefined) {
            return { file, content: cached, fromCache: true };
        }

        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        const content = await loadScheduler.requestFileContent(slug, targetPath, { priority: 'high', background: false });

        perfOnce('first-file-open', () => {
            if (t0) perfMeasureToConsole('first_file_open_latency', t0, { path: targetPath });
        });

        // Priority-based background prefetch (cancellable, yields to user loads)
        try {
            const rawFiles = state.rawFiles || [];
            const openFiles = state.openFiles || [];
            const dir = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : '';

            const stack = Array.isArray(rawFiles) ? [...rawFiles] : [];
            const all = [];
            while (stack.length) {
                const n = stack.pop();
                if (!n) continue;
                if (n.isFolder) {
                    if (Array.isArray(n.children)) stack.push(...n.children);
                } else if (n.path) {
                    all.push(n);
                }
            }

            const sameDir = all.filter(n => {
                if (!n?.path || n.path === targetPath) return false;
                const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
                return parent === dir;
            });

            const recent = openFiles
                .filter(f => f?.path && f.path !== targetPath)
                .map(f => {
                    const meta = all.find(n => n.path === f.path);
                    return meta ? meta : { path: f.path, size: Infinity };
                });

            const medium = new Map();
            for (const n of [...sameDir, ...recent]) {
                if (n?.path) medium.set(n.path, n);
            }

            loadScheduler.prefetch(slug, Array.from(medium.values()), { priority: 'medium' });

            // Prefetch direct imports from server-side import index
            try {
                const importRes = await api.fetchFileImports(slug, targetPath);
                const importPaths = Array.isArray(importRes?.resolved) ? importRes.resolved : [];
                const MAX_IMPORT_PREFETCH = 50;
                const uniqueImports = Array.from(new Set(importPaths)).slice(0, MAX_IMPORT_PREFETCH);
                if (uniqueImports.length) {
                    loadScheduler.prefetch(slug, uniqueImports, { priority: 'high' });
                }
            } catch (_) {
                // ignore
            }

            // Lowest priority crawl pool (remaining files)
            loadScheduler.setLowPriorityPool(slug, all.map(n => n.path).filter(p => p && p !== targetPath));
        } catch (e) {
            // ignore
        }

        return { file, content, fromCache: false };
    }
);

// Helper: check if a live Yjs document has content that should be used as
// the authoritative baseline for savedContent.  When the user switches tabs,
// the CRDT may already hold edits that haven't been flushed back to the
// server response yet — using server content as savedContent would make
// isUnsaved stale.  Returns the CRDT text if it exists and differs from
// `serverContent`, otherwise returns null.
function getCrdtBaselineIfNewer(slug, filePath, serverContent) {
    try {
        const key = collabClient.getRoomKey(slug, filePath);
        const entry = collabClient.docs.get(key);
        if (!entry?.ytext) return null;
        const crdtText = entry.ytext.toString();
        if (!crdtText || crdtText.length === 0) return null;
        // Only use CRDT if it actually differs (avoids false-positive churn)
        const norm = (s) => s ? s.replace(/[\r\n]+$/, '') : '';
        if (norm(crdtText) === norm(serverContent)) return null;
        return crdtText;
    } catch (_) {
        return null;
    }
}

// 4. Create Item (Mutation)
export const handleCreateItemThunk = createAsyncThunk(
    'workspace/createItem',
    async (_, { dispatch, getState }) => {
        const { ui, workspace } = getState();
        const { mode, target, name } = ui.uiActionState;
        const slug = workspace.slug;
        
        const isFolder = mode === 'create-folder';
        let finalName = name.trim();
        if (!finalName) throw new SynthiException("Name cannot be empty.", "The name for the new item cannot be empty.");

        // Validation logic (replicated from original hook)
        const invalidChars = /[<>:"/\\|?*]/;
        if (invalidChars.test(finalName)) {
            throw new SynthiException(`The name contains invalid characters.`, "The name contains characters that are not allowed.");
        }

        const parentPath = (target && target.path)? `${target.path}/` : '';
        let fullPath;

        if (!isFolder) {
            if (!finalName.includes('.')) {
                finalName += '.txt';
            }
            fullPath = parentPath + finalName;
            if (findFileInTree(workspace.rawFiles, fullPath)) {
                throw new SynthiException('A file with this name already exists.', "A file with this name already exists.");
            }
        } else {
            fullPath = parentPath + finalName;
            if (findFolderInTree(workspace.rawFiles, fullPath)) {
                throw new SynthiException('A folder with this name already exists.', "A folder with this name already exists.");
            }
        }

        // api.createItem calls the collab-server's write-file / create-directory
        // endpoint which writes to disk. This is the authoritative creation path.
        await api.createItem(slug, fullPath, isFolder);

        // Sync to the compiler worker's disk for LSP cross-file resolution.
        // Best-effort: file-sync channel may not be open if no compilation has run.
        try {
            const client = getCompilerClient();
            if (isFolder) {
                client.mkdirSync(fullPath);
            } else {
                client.syncFile(fullPath, '');
            }
        } catch (_) { /* best-effort */ }
        
        // Dispatch cleanup and revalidation
        dispatch(cancelUiAction());
        await dispatch(fetchFilesThunk(slug));

        // If file created, select it and notify CodeIntel for indexing
        if (!isFolder) {
            const newFile = {
                name: finalName,
                type: 'file',
                language: getFileLanguage(finalName),
                path: fullPath
            };
            dispatch(selectFileThunk(newFile));
            
            // Emit event so page-level listener can trigger CodeIntel re-index
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('synthi:codeintel-index-file', {
                    detail: { filePath: fullPath },
                }));
            }
        }
    }
);

// 5. Rename Item (Mutation)
export const handleRenameItemThunk = createAsyncThunk(
    'workspace/renameItem',
    async (_, { dispatch, getState }) => {
        const { ui, workspace } = getState();
        const { target: item, name: newName } = ui.uiActionState;
        const slug = workspace.slug;
        
        if (!newName.trim() || newName === item.name) {
            dispatch(cancelUiAction());
            return;
        }

        const invalidChars = /[<>:"/\\|?*]/;
        if (invalidChars.test(newName)) {
            throw new SynthiException('New name contains invalid characters.', "The new name contains characters that are not allowed.");
        }

        const newPath = item.path.split('/').slice(0, -1).concat(newName).join('/') + (item.isFolder ? '/' : '');
        
        await api.renameItem(slug, getItemPathInBucket(item), newPath);

        // Perform complex state update in reducer/sync action
        dispatch(renameItemStateUpdate({ item, newName, newPath }));
        
        // ── Sync rename to worker disk so LSP sees the new path ──
        try {
            getCompilerClient().renameFile(item.path, newPath);
        } catch (_) { /* best-effort */ }
        
        // Notify CodeIntel so indexes are updated atomically (delete old + index new)
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('synthi:codeintel-rename-file', {
                detail: { oldPath: item.path, newPath },
            }));
        }
        
        dispatch(cancelUiAction());
        await dispatch(fetchFilesThunk(slug));
    }
);

// 5b. Move Item (drag-and-drop into a folder, or into root)
export const moveItemThunk = createAsyncThunk(
    'workspace/moveItem',
    async ({ sourcePath, sourceName, sourceIsFolder, targetFolderPath }, { dispatch, getState }) => {
        const slug = getState().workspace.slug;
        if (!sourcePath || !sourceName) return;
        // No-op: dropping onto its own parent.
        const sourceParent = sourcePath.includes('/')
            ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
            : '';
        const target = targetFolderPath || '';
        if (sourceParent === target) return;
        // Disallow dropping a folder onto itself or any descendant.
        if (sourceIsFolder && (target === sourcePath || target.startsWith(sourcePath + '/'))) {
            throw new SynthiException(
                'Cannot move a folder into itself.',
                'The destination is the folder being moved or one of its descendants.',
            );
        }
        const oldPath = sourcePath + (sourceIsFolder ? '/' : '');
        const newPath = (target ? target + '/' : '') + sourceName + (sourceIsFolder ? '/' : '');
        await api.renameItem(slug, oldPath, newPath);
        try {
            getCompilerClient().renameFile(sourcePath, newPath.replace(/\/$/, ''));
        } catch (_) { /* best-effort */ }
        await dispatch(fetchFilesThunk(slug));
    }
);


// 6. Delete Item (Mutation)
export const deleteItemThunk = createAsyncThunk(
    'workspace/deleteItem',
    async (item, { dispatch, getState }) => {
        const state = getState().workspace;
        
        const confirmMessage = item.isFolder
          ? `Are you sure you want to delete the folder "${item.name}" and all its contents?`
            : `Are you sure you want to delete the file "${item.name}"?`;
            
        if (!window.confirm(confirmMessage)) {
            return { deleted: false };
        }
        const itemPath = getItemPathInBucket(item);

        await api.deleteItem(state.slug, itemPath);
        
        // ── Sync deletion to worker disk so LSP stops indexing the file ──
        try {
            getCompilerClient().deleteFile(item.path);
        } catch (_) { /* best-effort */ }
        
        // Notify CodeIntel so all indexes/RAG stores are cleaned up
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('synthi:codeintel-delete-file', {
                detail: { filePath: item.path },
            }));
        }
        
        await dispatch(fetchFilesThunk(state.slug));
        
        return { deleted: true, path: itemPath };
    }
);


// 7. Open Diff (Read)
export const openDiffThunk = createAsyncThunk(
    'workspace/openDiff',
    async (file, { dispatch, getState }) => {
        // Ensure the editor panel exists in the docking layout
        ensureEditorPanel(dispatch, getState);
        const state = getState().workspace;
        const slug = state.slug;

        // 1. Fetch current content (working copy)
        // Priority order:
        //   a) If this is the currently active file, use Redux currentContent
        //      (reflects live edits, not stale cache).
        //   b) Check the live Yjs CRDT for this file (has unsaved edits from
        //      the collaboration layer).
        //   c) Fall back to fileCache or server fetch.
        let currentContent = '';
        if (state.activeFile && state.activeFile.path === file.path) {
            currentContent = state.currentContent || '';
        } else {
            const crdtContent = getCrdtBaselineIfNewer(slug, file.path, '');
            if (crdtContent !== null) {
                currentContent = crdtContent;
            } else {
                const cachedContent = fileCache.get(file.path);
                if (cachedContent !== undefined) currentContent = cachedContent;
                else currentContent = await loadScheduler.requestFileContent(slug, file.path, { priority: 'high', background: false });
            }
        }

        // 2. Fetch original content (HEAD)
        let originalContent = '';
        try {
            const originalPath = file.originalPath || file.path;
            const result = await gitClient.getFileContent(slug, originalPath, 'HEAD');
            originalContent = result.content;
        } catch (e) {
            console.warn('Failed to fetch HEAD content', e);
        }

        return { file, currentContent, originalContent };
    }
);

// 8. Open Commit File Diff — compare file at commit vs parent commit (read-only)
export const openCommitFileDiffThunk = createAsyncThunk(
    'workspace/openCommitFileDiff',
    async ({ filePath, commitHash }, { dispatch, getState }) => {
        ensureEditorPanel(dispatch, getState);
        const slug = getState().workspace.slug;

        // Fetch content at this commit and its parent
        let afterContent = '';
        let beforeContent = '';
        try {
            const res = await gitClient.getFileContent(slug, filePath, commitHash);
            afterContent = res.content ?? '';
        } catch (_) { /* new file — no content at this commit */ }

        try {
            const res = await gitClient.getFileContent(slug, filePath, `${commitHash}~1`);
            beforeContent = res.content ?? '';
        } catch (_) { /* file didn't exist in parent — added in this commit */ }

        const file = {
            path: filePath,
            name: filePath.split('/').pop(),
            commitDiff: true,           // flag so editor knows this is read-only historical diff
            commitHash,
        };
        return { file, currentContent: afterContent, originalContent: beforeContent };
    }
);

// --- SLICE DEFINITION ---

const workspaceSlice = createSlice({
    name: 'workspace',
    initialState: initialWorkspaceState,
    reducers: {
        // Synchronous reducers for quick state updates
        updateContent: (state, action) => {
            const newContent = action.payload || '';
            // P0: Skip entirely if content hasn't changed — prevents redundant
            // re-renders of every component subscribed to currentContent
            if (state.currentContent === newContent) return;
            state.currentContent = newContent;
            try {
                if (state.activeFile && state.activeFile.path) {
                    state.fileContentCache.set(state.activeFile.path, newContent);
                    const activePath = state.activeFile.path;
                    const isUnsaved = normalizeTrailing(newContent) !== normalizeTrailing(state.savedContent);
                    const idx = state.openFiles.findIndex(f => f.path === activePath);
                    if (idx !== -1) {
                        // P0: Only create a new object if isUnsaved actually changed
                        if (state.openFiles[idx].isUnsaved !== isUnsaved) {
                            state.openFiles[idx] = { ...state.openFiles[idx], isUnsaved };
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        },
        setDiffMode: (state, action) => {
            state.diffMode = action.payload;
        },
            // Open a file in the tab bar (keeps order and uniqueness)
            openFile: (state, action) => {
                const file = action.payload;
                if (!file) return;
                const exists = state.openFiles.find(f => f.path === file.path);
                const entry = { ...file, isUnsaved: false };
                if (!exists) state.openFiles.push(entry);
            },
            // Close a tab by path. If the closed tab is active, pick the previous
            // tab (or next) as the new active file and load cached content if available.
            closeFile: (state, action) => {
                const path = action.payload;
                if (!path) return;
                const idx = state.openFiles.findIndex(f => f.path === path);
                if (idx === -1) return;
                state.openFiles.splice(idx, 1);

                // If active file was closed, pick a neighbor
                if (state.activeFile && state.activeFile.path === path) {
                    const newIndex = Math.max(0, idx - 1);
                    const newFile = state.openFiles[newIndex] || null;
                    state.activeFile = newFile;
                    if (newFile && newFile.path) {
                        fileCache.setActive(newFile.path);
                        const cached = fileCache.get(newFile.path);
                        if (cached !== undefined) {
                            state.currentContent = cached;
                            state.savedContent = cached;
                        } else {
                            state.currentContent = '';
                            state.savedContent = '';
                        }
                    } else {
                        state.currentContent = '';
                        state.savedContent = '';
                    }
                }
            },

            // Reorder open tabs by moving element at fromIndex to toIndex
            reorderOpenFiles: (state, action) => {
                const { fromIndex, toIndex } = action.payload || {};
                if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') return;
                if (fromIndex < 0 || fromIndex >= state.openFiles.length) return;
                if (toIndex < 0 || toIndex >= state.openFiles.length) return;
                const item = state.openFiles.splice(fromIndex, 1)[0];
                state.openFiles.splice(toIndex, 0, item);
            },
        setExternalFileContent: (state, action) => {
            const { path, content } = action.payload || {};
            if (!path || typeof content !== 'string') return;
            state.fileContentCache.set(path, content);
            if (state.activeFile?.path === path) {
                state.currentContent = content;
                state.savedContent = content;
            }
        },
        // Utility reducer used by thunks for internal cleanup
        renameItemStateUpdate: (state, action) => {
            const { item, newName, newPath } = action.payload;

            // 1. Update Active File if renamed
            if (state.activeFile && state.activeFile.path === item.path) {
                state.activeFile.name = newName;
                state.activeFile.path = newPath;
            }

            // 2. Migrate cache entry (CRITICAL for data integrity)
            const cachedContent = state.fileContentCache.get(item.path);
            if (cachedContent!== undefined) {
                // Ensure state mutation safety by creating a new Map instance for Redux state
                state.fileContentCache.delete(item.path);
                state.fileContentCache.set(newPath, cachedContent);
            }
        },
        setSlug: (state, action) => {
            state.slug = action.payload;
        },
        clearFileCache: (state) => {
            state.fileContentCache = new Map();
            try { fileCache.clear(); } catch (_) {}
            try { loadScheduler.cancelBackground(); } catch (_) {}
        },
        // Clear stale saved baselines after a revert/pull/checkout.
        // Accepts { paths: string[] } or { all: true }.
        // Must be dispatched BEFORE selectFileThunk so the fulfilled handler
        // doesn't re-apply the old savedContent from _savedContentByPath.
        clearSavedBaselines: (state, action) => {
            const { paths, all } = action.payload || {};
            if (all) {
                state._savedContentByPath = {};
                state.openFiles = state.openFiles.map(f =>
                    f.isUnsaved ? { ...f, isUnsaved: false } : f
                );
            } else if (Array.isArray(paths)) {
                for (const p of paths) {
                    delete state._savedContentByPath?.[p];
                    const idx = state.openFiles.findIndex(f => f.path === p);
                    if (idx !== -1 && state.openFiles[idx].isUnsaved) {
                        state.openFiles[idx] = { ...state.openFiles[idx], isUnsaved: false };
                    }
                }
            }
        },
        /**
         * Called when another collaborator saves a file.
         * Syncs this client's savedContent so isUnsaved resets correctly.
         * If the file is currently active, set savedContent = currentContent.
         * Also updates the per-file savedContent cache.
         */
        /**
         * Record pre-conflict CRDT content for a file so the user can
         * recover unsynced edits after conflict resolution.  Older entries
         * for the same path are overwritten (last-write-wins).
         */
        stashConflictRecovery: (state, action) => {
            const { path: filePath, content, at } = action.payload || {};
            if (!filePath || typeof content !== 'string') return;
            if (!state._conflictRecovery) state._conflictRecovery = {};
            state._conflictRecovery[filePath] = { content, at: at || Date.now() };
        },
        /**
         * Clear the conflict-recovery stash for a file (e.g. after the user
         * applies or discards it).
         */
        clearConflictRecovery: (state, action) => {
            const filePath = action.payload;
            if (!filePath || !state._conflictRecovery) return;
            delete state._conflictRecovery[filePath];
        },
        markFileSavedRemotely: (state, action) => {
            const filePath = action.payload;
            if (!filePath) return;
            // Update per-file cache so switching tabs later reflects correct state
            const cached = state.fileContentCache.get(filePath);
            if (typeof cached === 'string') {
                if (!state._savedContentByPath) state._savedContentByPath = {};
                state._savedContentByPath[filePath] = cached;
            }
            // If this is the currently active file, sync savedContent
            if (state.activeFile?.path === filePath) {
                state.savedContent = state.currentContent;
            }
            // Clear isUnsaved flag on the open file tab
            const idx = state.openFiles.findIndex(f => f.path === filePath);
            if (idx !== -1 && state.openFiles[idx].isUnsaved) {
                state.openFiles[idx] = { ...state.openFiles[idx], isUnsaved: false };
            }
        },
        hydrateWorkspace: (state, action) => {
            const { openFiles, activeFile } = action.payload;
            if (openFiles) {
                state.openFiles = openFiles;
            }
            if (activeFile) {
                state.activeFile = activeFile;
            }
        },
    },
    extraReducers: (builder) => {
        // Define mutation thunk prefixes for generic matcher logic
        const MUTATION_THUNK_TYPES = [
            'workspace/saveContent',
            'workspace/createItem',
            'workspace/renameItem',
            'workspace/deleteItem',
        ];

        // --- FETCH FILES ---
        builder
          .addCase(fetchFilesThunk.pending, (state) => {
                state.isLoading = true;
                state._filesFetching = true;
                state.status = 'pending';
                state.error = null;
            })
          .addCase(fetchFilesThunk.fulfilled, (state, action) => {
                state.rawFiles = action.payload.files;
                state.isLoading = false;
                state._filesFetching = false;
                state.status = 'succeeded';
                
                // If the thunk recommended auto-selection, perform it here
                if (action.payload.fileToSelect) {
                    state.activeFile = action.payload.fileToSelect;
                    // Note: Content selection happens via a subsequent selectFileThunk dispatch
                }
            })
          .addCase(fetchFilesThunk.rejected, (state, action) => {
                state.isLoading = false;
                state._filesFetching = false;
                state.status = 'failed';
                state.error = action.error.message;
            });

        // --- SELECT FILE ---
        builder
            .addCase(selectFileThunk.pending, (state, action) => {
                const file = action.meta.arg;
                if (file && file.path && !state.loadingFiles.includes(file.path)) {
                    state.loadingFiles.push(file.path);
                }
            })
            .addCase(selectFileThunk.rejected, (state, action) => {
                const file = action.meta.arg;
                if (file && file.path) {
                    state.loadingFiles = state.loadingFiles.filter(p => p !== file.path);
                }
            })
            .addCase(openDiffThunk.fulfilled, (state, action) => {
                const { file, currentContent, originalContent } = action.payload;

                // Preserve the saved baseline if re-opening the same file in diff.
                // Only reset savedContent when switching to a different file.
                const isSameFile = state.activeFile && state.activeFile.path === file.path;
                state.activeFile = file;
                state.currentContent = currentContent;
                if (!isSameFile) {
                    state.savedContent = currentContent;
                }
                state.originalContent = originalContent;
                state.diffMode = true;
                
                // Add to open files if not present
                const exists = state.openFiles.find(f => f.path === file.path);
                if (!exists) {
                    state.openFiles.push({ ...file, isUnsaved: false });
                }
                
                // Update cache
                try { fileCache.set(file.path, currentContent); } catch (_) {}
            })
            .addCase(openCommitFileDiffThunk.fulfilled, (state, action) => {
                const { file, currentContent, originalContent } = action.payload;
                state.activeFile = file;
                state.currentContent = currentContent;
                state.savedContent = currentContent; // read-only, no unsaved marker
                state.originalContent = originalContent;
                state.diffMode = true;
            })
            .addCase(selectFileThunk.fulfilled, (state, action) => {
                const { file, content, fromCache } = action.payload;
                
                // Remove from loading list
                if (file && file.path) {
                    state.loadingFiles = state.loadingFiles.filter(p => p !== file.path);
                }
                
                // Cache unsaved content of OLD active file before switching
                if (state.activeFile && state.activeFile.path && normalizeTrailing(state.currentContent) !== normalizeTrailing(state.savedContent)) {
                    // Persist the per-file savedContent so switching back later
                    // doesn't lose the unsaved baseline.
                    if (!state._savedContentByPath) state._savedContentByPath = {};
                    state._savedContentByPath[state.activeFile.path] = state.savedContent;
                    state.fileContentCache.set(state.activeFile.path, state.currentContent);
                }

                // Switch to new file
                state.activeFile = file;
                state.currentContent = content;
                state.diffMode = false; // Disable diff mode

                // Check if this file was previously open with unsaved changes.
                // The Yjs auto-flush writes edits to disk immediately, so the
                // server content already matches the CRDT.  Without this
                // check, savedContent would be set to the (already-flushed)
                // server content, erasing the unsaved indicator.
                const existingTab = state.openFiles.find(f => f.path === file.path);
                const wasUnsaved = existingTab?.isUnsaved === true;
                const previousSaved = state._savedContentByPath?.[file.path];

                if (wasUnsaved && previousSaved !== undefined) {
                    // Restore the original savedContent baseline so the
                    // unsaved dot reappears when switching back to this tab.
                    const crdtBaseline = getCrdtBaselineIfNewer(state.slug, file.path, content);
                    state.currentContent = crdtBaseline ?? content;
                    state.savedContent = previousSaved;
                } else {
                    // Fresh file or already saved — use server content as baseline
                    const crdtBaseline = getCrdtBaselineIfNewer(state.slug, file.path, content);
                    if (crdtBaseline !== null) {
                        state.currentContent = crdtBaseline;
                        state.savedContent = content; // server version is the "last saved" baseline
                    } else {
                        state.savedContent = content;
                    }
                    // Clean up stale per-file savedContent
                    if (state._savedContentByPath) {
                        delete state._savedContentByPath[file.path];
                    }
                }
                
                // Update cache if content was newly fetched (and not from cache)
                if (!fromCache) {
                    state.fileContentCache.set(file.path, content);
                }

                // Ensure the file appears in the open tabs list.
                // Only mark as unsaved if the tab was ALREADY marked unsaved
                // before the switch.  Do NOT use getCrdtBaselineIfNewer here
                // because the CRDT auto-flush writes edits to disk
                // asynchronously — the server content already reflects the
                // CRDT state, so any difference is a transient race, not a
                // genuine unsaved edit.  This prevents the spurious unsaved
                // indicator that appeared when merely switching tabs.
                try {
                    const hasUnsaved = wasUnsaved;
                    const entry = { ...file, isUnsaved: hasUnsaved };
                    if (!existingTab) state.openFiles.push(entry);
                    else if (existingTab.isUnsaved !== hasUnsaved) {
                        const idx = state.openFiles.indexOf(existingTab);
                        state.openFiles[idx] = { ...existingTab, isUnsaved: hasUnsaved };
                    }
                } catch (e) { /* ignore */ }
            });

        // --- SAVE CONTENT ---
        builder
          .addCase(saveFileContentThunk.pending, (state) => {
                // Optimistic: immediately mark the file as saved so the UI feels instant.
                // If the thunk rejects, the rejected handler restores isUnsaved.
                try {
                    if (state.activeFile && state.activeFile.path) {
                        const idx = state.openFiles.findIndex(f => f.path === state.activeFile.path);
                        if (idx !== -1) {
                            state.openFiles[idx] = { ...state.openFiles[idx], isUnsaved: false };
                        }
                        // Cache the current savedContent so we can revert on failure
                        state._preSaveSavedContent = state.savedContent;
                        // Optimistically update savedContent to currentContent
                        state.savedContent = state.currentContent;
                    }
                } catch (e) { /* ignore */ }
            })
          .addCase(saveFileContentThunk.fulfilled, (state, action) => {
                // Clean up the revert cache
                delete state._preSaveSavedContent;
                if (action.payload) {
                    state.savedContent = action.payload;
                    if (state.activeFile && state.activeFile.path) {
                        state.fileContentCache.set(state.activeFile.path, action.payload);
                        // Clear the per-file savedContent cache — the file
                        // is now explicitly saved so tab-switching should use
                        // the new baseline, not the stale one.
                        if (state._savedContentByPath) {
                            delete state._savedContentByPath[state.activeFile.path];
                        }
                    }
                    // Mark active tab as saved (also handled in pending, but confirm here)
                    // and clear any stale permission-denied flag, since a save
                    // that lands means the user now has write access.
                    try {
                        if (state.activeFile && state.activeFile.path) {
                            const idx = state.openFiles.findIndex(f => f.path === state.activeFile.path);
                            if (idx !== -1) {
                                const prev = state.openFiles[idx];
                                state.openFiles[idx] = {
                                    ...prev,
                                    isUnsaved: false,
                                    permissionDenied: false,
                                    saveError: null,
                                    lastSavedAt: Date.now(),
                                };
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
            })
          .addCase(saveFileContentThunk.rejected, (state, action) => {
                // Rollback: restore the pre-save state so the unsaved dot reappears
                try {
                    if (state._preSaveSavedContent !== undefined) {
                        state.savedContent = state._preSaveSavedContent;
                        delete state._preSaveSavedContent;
                    }
                    if (state.activeFile && state.activeFile.path) {
                        const idx = state.openFiles.findIndex(f => f.path === state.activeFile.path);
                        if (idx !== -1) {
                            // Classify the error so the tab can surface a
                            // durable indicator (lock for 403, warning for
                            // others).  action.error carries the thrown
                            // error's message / code via redux-toolkit.
                            const code = action.error?.code || action.error?.name || '';
                            const message = action.error?.message || 'Save failed';
                            const isPermissionDenied = code === 'permission_denied' || code === 'host_only' || message.toLowerCase().includes('permission');
                            state.openFiles[idx] = {
                                ...state.openFiles[idx],
                                isUnsaved: true,
                                permissionDenied: isPermissionDenied || false,
                                saveError: message,
                            };
                        }
                    }
                } catch (e) { /* ignore */ }
            });

        // --- DELETE ITEM ---
        builder
          .addCase(deleteItemThunk.fulfilled, (state, action) => {
                if (action.payload.deleted) {
                    const deletedPath = action.payload.path;
                    
                    // Clear cache
                    state.fileContentCache.delete(deletedPath);
                    
                    // Clear editor if active file was deleted
                    if (state.activeFile && state.activeFile.path === deletedPath) {
                        state.activeFile = null;
                        state.currentContent = '';
                        state.savedContent = '';
                    }
                }
            });

        // --- GENERIC MUTATION PENDING/REJECTED HANDLERS (FIXED) ---
        builder
          .addMatcher(
                (action) => MUTATION_THUNK_TYPES.some(type => action.type === `${type}/pending`),
                (state) => {
                    state.status = 'pending';
                }
            )
          .addMatcher(
                (action) => MUTATION_THUNK_TYPES.some(type => action.type === `${type}/rejected`),
                (state, action) => {
                    state.status = 'failed';
                    state.error = action.error.message;
                    // NOTE: Removed window.alert — error is stored in state.error
                    // and shown via toast in the UI components.
                }
            )
          .addMatcher(
                (action) => MUTATION_THUNK_TYPES.some(type => action.type === `${type}/fulfilled`),
                (state) => {
                    state.status = 'succeeded';
                }
            )
          // Handle git conflicts - invalidate cache for conflicted files
          .addMatcher(
                (action) => action.type === 'git/conflictsDetected',
                (state, action) => {
                    // Ensure conflictedFiles is an array
                    let conflictedFiles = action.payload;
                    if (!conflictedFiles) {
                        conflictedFiles = [];
                    } else if (!Array.isArray(conflictedFiles)) {
                        // If it's an object with a conflictedFiles or conflicted property, extract it
                        if (conflictedFiles.conflictedFiles && Array.isArray(conflictedFiles.conflictedFiles)) {
                            conflictedFiles = conflictedFiles.conflictedFiles;
                        } else if (conflictedFiles.conflicted && Array.isArray(conflictedFiles.conflicted)) {
                            conflictedFiles = conflictedFiles.conflicted;
                        } else {
                            conflictedFiles = [];
                        }
                    }
                    
                    const slug = state.slug;
                    
                    console.log('[Workspace] Processing conflict invalidation for files:', conflictedFiles, 'slug:', slug);
                    
                    // Clear cache and reset collab docs for each conflicted file 
                    // so they get re-read from filesystem with conflict markers
                    if (conflictedFiles.length > 0) {
                        conflictedFiles.forEach(filePath => {
                            try { 
                                console.log('[Workspace] Invalidating cache for:', filePath);
                                fileCache.delete(filePath);
                                // Also destroy the collab document so it gets recreated fresh
                                if (slug) {
                                    collabClient.destroyDocument(slug, filePath);
                                }
                            } catch (e) {
                                console.warn('[Workspace] Error invalidating:', filePath, e);
                            }
                        });
                    }
                }
            );
    },
});

export const { updateContent, renameItemStateUpdate, setSlug, setExternalFileContent, openFile, closeFile, reorderOpenFiles, hydrateWorkspace, clearFileCache, clearSavedBaselines, setDiffMode, markFileSavedRemotely, stashConflictRecovery, clearConflictRecovery } = workspaceSlice.actions;

export const refreshWorkspaceThunk = createAsyncThunk(
    'workspace/refresh',
    async (_, { dispatch, getState }) => {
        const state = getState().workspace;
        dispatch(clearFileCache());
        await dispatch(fetchFilesThunk(state.slug));
        if (state.activeFile) {
            await dispatch(selectFileThunk(state.activeFile));
        }
    }
);

// --- MEMOIZED SELECTORS ---

// Selector to build the file tree (expensive operation, memoize)
export const selectFilesTree = (state) => state.workspace.rawFiles;


export const selectActiveFile = (state) => state.workspace.activeFile;
export const selectOpenFiles = (state) => state.workspace.openFiles || [];
export const selectLoadingFiles = (state) => state.workspace.loadingFiles || [];
export const selectCurrentContent = (state) => state.workspace.currentContent;

// Normalize content for comparison - only trim trailing newlines (not all whitespace)
// This prevents false "unsaved" states when Yjs syncs content with 
// slightly different trailing newlines than the file cache, while still
// detecting intentional whitespace changes like added spaces
const normalizeForComparison = (content) => {
    if (!content) return '';
    // Only strip trailing newlines (\r\n or \n), not spaces/tabs
    return content.replace(/[\r\n]+$/, '');
};

export const selectIsUnsaved = createSelector(
    selectCurrentContent,
    (state) => state.workspace.savedContent,
    (current, saved) => normalizeForComparison(current) !== normalizeForComparison(saved)
);
export const selectBreadcrumb = createSelector(
    selectActiveFile,
    (activeFile) => activeFile? activeFile.path.split("/").filter(Boolean) : []
);
export const selectFileCacheEntries = createSelector(
    (state) => state.workspace?.fileContentCache,
    (cache) => {
        if (!cache || typeof cache.entries !== 'function') return [];
        return Array.from(cache.entries());
    }
);

export default workspaceSlice.reducer;