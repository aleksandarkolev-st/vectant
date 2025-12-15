// src/redux/workspaceSlice.js
import { createSlice, createAsyncThunk, createSelector } from '@reduxjs/toolkit';
import { api } from '@/services/api'; 
import collabClient from '@/services/collabClient';
import { getCompilerClient } from '@/services/compilerClient';
import { cancelUiAction } from './uiSlice'; // Cross-slice dependency
import { syncFileToGit, fetchGitStatus } from './gitSlice';
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

// --- Initial State and Utilities ---

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
    isLoading: false,
    status: 'idle',
    error: null,
};

// --- ASYNC THUNKS (Side Effects and Persistence) ---

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

        // Return files and potential file to select for the reducer
        return { files, fileToSelect };
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

        // Determine the authoritative content to save:
        // 1. If a collab doc exists for this file, use the CRDT content (most up-to-date)
        // 2. Otherwise fall back to Redux currentContent
        let contentToSave = currentContent;
        let usedCrdt = false;
        
        try {
            // Build the key the same way collabClient does
            const safePath = activeFile.path.replace(/[^a-zA-Z0-9_.\-\/]/g, '_');
            const key = `workspace:${slug}:${safePath}`;
            const entry = collabClient.docs.get(key);
            
            if (entry && entry.ytext) {
                const crdtText = entry.ytext.toString();
                if (crdtText && crdtText.length > 0) {
                    contentToSave = crdtText;
                    usedCrdt = true;
                }
            }
        } catch (e) {
            console.warn('[Save] Failed to get CRDT content, using Redux content', e);
        }
        
        // Skip save if content hasn't changed
        if (contentToSave === state.savedContent) {
            return contentToSave; // Return content to ensure reducer still marks as saved
        }

        try {
            await api.saveFileContent(slug, activeFile.path, contentToSave, activeFile.name);
            
            // Sync to Git
            dispatch(syncFileToGit({ slug, filePath: activeFile.path, content: contentToSave }));
            dispatch(fetchGitStatus(slug));

        } catch (e) {
            console.error('[Save] Failed to save file', e);
            throw e; // Re-throw so the thunk is rejected
        }
        
        // Ensure tree is revalidated silently after save
        dispatch(fetchFilesThunk(slug)); 

        // Return the content that was saved to update savedContent state
        return contentToSave; 
    }
);

// 3. File Selection (Manages cache and fetches content)
export const selectFileThunk = createAsyncThunk(
    'workspace/selectFile',
    async (file, { getState }) => {
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

            // Lowest priority crawl pool (remaining files)
            loadScheduler.setLowPriorityPool(slug, all.map(n => n.path).filter(p => p && p !== targetPath));
        } catch (e) {
            // ignore
        }

        return { file, content, fromCache: false };
    }
);

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

        await api.createItem(slug, fullPath, isFolder);
        
        // Dispatch cleanup and revalidation
        dispatch(cancelUiAction());
        await dispatch(fetchFilesThunk(slug));

        // If file created, select it
        if (!isFolder) {
            const newFile = {
                name: finalName,
                type: 'file',
                language: getFileLanguage(finalName),
                path: fullPath
            };
            dispatch(selectFileThunk(newFile));
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
        
        dispatch(cancelUiAction());
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
        
        await dispatch(fetchFilesThunk(state.slug));
        
        return { deleted: true, path: itemPath };
    }
);


import { gitClient } from '@/services/gitClient';

// 7. Open Diff (Read)
export const openDiffThunk = createAsyncThunk(
    'workspace/openDiff',
    async (file, { dispatch, getState }) => {
        const state = getState().workspace;
        const slug = state.slug;

        // 1. Fetch current content (working copy)
        let currentContent = '';
        const cachedContent = fileCache.get(file.path);
        if (cachedContent !== undefined) currentContent = cachedContent;
        else currentContent = await loadScheduler.requestFileContent(slug, file.path, { priority: 'high', background: false });

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

// --- SLICE DEFINITION ---

const workspaceSlice = createSlice({
    name: 'workspace',
    initialState: initialWorkspaceState,
    reducers: {
        // Synchronous reducers for quick state updates
        updateContent: (state, action) => {
            const newContent = action.payload || '';
            state.currentContent = newContent;
            // Mark active file's tab as unsaved when content differs from savedContent
            try {
                if (state.activeFile && state.activeFile.path) {
                    const activePath = state.activeFile.path;
                    const isUnsaved = newContent !== state.savedContent;
                    console.debug('[Redux updateContent] path:', activePath, 'isUnsaved:', isUnsaved, 
                                  'contentLen:', newContent.length, 'savedLen:', state.savedContent?.length);
                    const idx = state.openFiles.findIndex(f => f.path === activePath);
                    if (idx !== -1) {
                        state.openFiles[idx] = { ...state.openFiles[idx], isUnsaved };
                    }
                }
            } catch (e) { console.warn('[Redux updateContent] error:', e); }
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
                state.status = 'pending';
                state.error = null;
            })
          .addCase(fetchFilesThunk.fulfilled, (state, action) => {
                state.rawFiles = action.payload.files;
                state.isLoading = false;
                state.status = 'succeeded';
                
                // If the thunk recommended auto-selection, perform it here
                if (action.payload.fileToSelect) {
                    state.activeFile = action.payload.fileToSelect;
                    // Note: Content selection happens via a subsequent selectFileThunk dispatch
                }
            })
          .addCase(fetchFilesThunk.rejected, (state, action) => {
                state.isLoading = false;
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
                state.activeFile = file;
                state.currentContent = currentContent;
                state.savedContent = currentContent; // Assuming saved on disk matches current for now
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
            .addCase(selectFileThunk.fulfilled, (state, action) => {
                const { file, content, fromCache } = action.payload;
                
                // Remove from loading list
                if (file && file.path) {
                    state.loadingFiles = state.loadingFiles.filter(p => p !== file.path);
                }
                
                // Cache unsaved content of OLD active file before switching
                if (state.activeFile && state.activeFile.path && state.currentContent!== state.savedContent) {
                    state.fileContentCache.set(state.activeFile.path, state.currentContent);
                }

                // Switch to new file
                state.activeFile = file;
                state.currentContent = content;
                state.savedContent = content;
                state.diffMode = false; // Disable diff mode
                
                // Update cache if content was newly fetched (and not from cache)
                if (!fromCache) {
                    state.fileContentCache.set(file.path, content);
                }

                // Ensure the file appears in the open tabs list
                try {
                    const exists = state.openFiles.find(f => f.path === file.path);
                    const entry = { ...file, isUnsaved: false };
                    if (!exists) state.openFiles.push(entry);
                } catch (e) { /* ignore */ }
            });

        // --- SAVE CONTENT ---
        builder
          .addCase(saveFileContentThunk.fulfilled, (state, action) => {
                if (action.payload) {
                    state.savedContent = action.payload;
                    if (state.activeFile && state.activeFile.path) {
                        state.fileContentCache.set(state.activeFile.path, action.payload);
                    }
                    // Mark active tab as saved
                    try {
                        if (state.activeFile && state.activeFile.path) {
                            const idx = state.openFiles.findIndex(f => f.path === state.activeFile.path);
                            if (idx !== -1) state.openFiles[idx] = { ...state.openFiles[idx], isUnsaved: false };
                        }
                    } catch (e) { /* ignore */ }
                }
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
                    window.alert(`Operation Failed: ${action.error.message}`);
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

export const { updateContent, renameItemStateUpdate, setSlug, setExternalFileContent, openFile, closeFile, reorderOpenFiles, hydrateWorkspace, clearFileCache } = workspaceSlice.actions;

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
export const selectIsUnsaved = createSelector(
    selectCurrentContent,
    (state) => state.workspace.savedContent,
    (current, saved) => current!== saved
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