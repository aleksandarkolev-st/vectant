import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyPatch } from 'diff';
import { getFileLanguage, findFirstFile } from '@/utils/fileUtils';
import { buildFilesPayload } from '@/utils/multiFileContext';
import { api } from '@/services/api';
import { computeDiffChunks, parseFileDiffBlocks, stripDiffMarkers, validateFileDiffBlocks } from '../utils/diffUtils';
import { selectFileThunk, setExternalFileContent, fetchFilesThunk } from '@/redux/workspaceSlice';
import { useContextWindow } from './useContextWindow';
import { useAgentPipeline, PIPELINE_MODES } from './useAgentPipeline';

// AI Engine base URL for intent classification
const AI_ENGINE_BASE = process.env.NEXT_PUBLIC_AI_ENGINE_URL || 'http://localhost:8000';

/**
 * Classify user query intent using the AI backend's LLM-based classifier.
 * Falls back to local heuristics if the backend is unavailable.
 * 
 * @param {string} query - The user's query
 * @param {string} context - Optional context (e.g., current file content snippet)
 * @returns {Promise<{intent: string, needsCodeChanges: boolean, responseMode: string}>}
 */
const classifyQueryIntent = async (query, context = null) => {
    try {
        const response = await fetch(`${AI_ENGINE_BASE}/classify/intent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, context }),
            signal: AbortSignal.timeout(2000), // Fast timeout for responsiveness
        });
        
        if (response.ok) {
            const data = await response.json();
            return {
                intent: data.intent || 'unknown',
                needsCodeChanges: data.needs_code_changes !== false, // Default to true
                responseMode: data.response_mode || 'patch',
            };
        }
    } catch (e) {
        console.debug('Intent classification fallback to heuristics:', e.message);
    }
    
    // Fallback to local heuristics if backend is unavailable
    return fallbackIntentDetection(query);
};

// Fallback heuristic-based intent detection (used when backend is unavailable)
const fallbackIntentDetection = (prompt) => {
    if (!prompt) return { intent: 'unknown', needsCodeChanges: true, responseMode: 'patch' };
    
    const lower = prompt.toLowerCase().trim();
    
    // Keywords that indicate the user WANTS code changes
    const CHANGE_KEYWORDS = [
        'fix', 'change', 'modify', 'update', 'edit', 'refactor', 'rename',
        'add', 'remove', 'delete', 'insert', 'create', 'implement', 'write',
        'generate', 'build', 'make', 'replace', 'bug', 'error', 'issue',
        'improve', 'optimize', 'new file', 'new class', 'new function',
    ];
    
    // Keywords that indicate explanation (NO code changes)
    const EXPLAIN_KEYWORDS = [
        'explain', 'describe', 'what does', 'what is', 'how does', 'how is',
        'why does', 'why is', 'tell me about', 'understand', 'walk me through',
        'help me understand', 'clarify', 'overview', 'summary',
    ];
    
    // Check for explain keywords first
    if (EXPLAIN_KEYWORDS.some(kw => lower.includes(kw))) {
        return { intent: 'explain', needsCodeChanges: false, responseMode: 'explain' };
    }
    
    // Check for change keywords
    if (CHANGE_KEYWORDS.some(kw => lower.includes(kw))) {
        return { intent: 'change', needsCodeChanges: true, responseMode: 'patch' };
    }
    
    // Questions are typically explanation requests
    if (lower.endsWith('?') || /^(what|how|why|where|when|which|who|is|are|does|do|can|could)\b/.test(lower)) {
        return { intent: 'explain', needsCodeChanges: false, responseMode: 'explain' };
    }
    
    // Default to assuming code changes for imperative statements
    return { intent: 'unknown', needsCodeChanges: true, responseMode: 'patch' };
};

// Pulls the first code block or multiline text segment out of a markdown-ish AI response.
const extractCodeFromMarkdown = (text) => {
    if (!text) return null;
    const fenceRe = /```(?:\w+)?\n([\s\S]*?)```/m;
    let m = text.match(fenceRe);
    if (m && m[1]) return m[1].replace(/\r/g, '');

    const preCodeRe = /<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/i;
    m = text.match(preCodeRe);
    if (m && m[1]) return m[1].replace(/\r/g, '');

    const codeTagRe = /<code[^>]*>([\s\S]*?)<\/code>/i;
    m = text.match(codeTagRe);
    if (m && m[1]) return m[1].replace(/\r/g, '');

    if (!/[<>]/.test(text) && text.split('\n').length > 3) return text.replace(/\r/g, '');

    return null;
};

// Main hook that orchestrates sending prompts, streaming responses, and managing suggestion state.
export const useAISuggestions = ({
    activeSession,
    chatSessions,
        mutateSession,
        appendMessagesToSession,
        resetSuggestionsForSession,
    activeFile,
    currentCode,
    editor,
    onSuggest,
    onBusy,
    clearSignal,
    fileCacheEntries,
    workspaceSlug,
    rawFiles,
    dispatch,
    aiModel = null,
    aiApiKey = null,
}) => {
    const clientReady = true;
    const [isLoading, setIsLoading] = useState(false);
    const lastClearSignalRef = useRef(clearSignal);
    const cachedFileMap = useMemo(() => new Map(fileCacheEntries), [fileCacheEntries]);
    const lastSuggestionSnapshotRef = useRef(null);
    const onSuggestRef = useRef(onSuggest);
    const currentCodeRef = useRef(currentCode);
    const fallbackPathRef = useRef(activeFile?.path || activeFile?.name || null);
    const activeFileRef = useRef(activeFile);

    // ── Context Window ──────────────────────────────────────────────
    const {
        buildContextWindow,
        formatForAPI,
        getContextDebugInfo,
        estimateTokens,
        availableTokens,
    } = useContextWindow({ maxTokens: 28000 });

    // Keep the latest onSuggest callback reference in sync.
    useEffect(() => {
        onSuggestRef.current = onSuggest;
    }, [onSuggest]);

    // Track the latest editor code snapshot for diffing partial suggestions.
    useEffect(() => {
        currentCodeRef.current = currentCode;
    }, [currentCode]);

    useEffect(() => {
        activeFileRef.current = activeFile;
    }, [activeFile]);

    // Flatten workspace file tree into a simple list of paths for quick lookups.
    const flattenWorkspaceFiles = useMemo(() => {
        const output = [];
        const walk = (nodes = []) => {
            nodes.forEach((node) => {
                if (!node) return;
                if (node.isFolder && Array.isArray(node.children)) {
                    walk(node.children);
                } else if (!node.isFolder && node.path) {
                    output.push(node.path);
                }
            });
        };
        walk(rawFiles);
        return output;
    }, [rawFiles]);

    // Resolve a file node object given a path in the workspace tree.
    const findFileNodeByPath = useCallback((targetPath) => {
        if (!targetPath) return null;
        const walk = (nodes = []) => {
            for (const node of nodes) {
                if (!node) continue;
                if (!node.isFolder && node.path === targetPath) {
                    return node;
                }
                if (node.isFolder && Array.isArray(node.children)) {
                    const found = walk(node.children);
                    if (found) return found;
                }
            }
            return null;
        };
        return walk(rawFiles);
    }, [rawFiles]);

    // Normalize and resolve a possibly partial path to a known workspace path.
    const resolveWorkspacePath = useCallback((inputPath) => {
        if (!inputPath) return null;
        const normalized = inputPath.replace(/^\.\/+/, '').trim();
        if (!normalized) return null;
        if (flattenWorkspaceFiles.includes(normalized)) {
            return normalized;
        }
        // Only attempt suffix matching when the provided path includes a folder,
        // to avoid hijacking similarly named files in other directories.
        const hasFolderHint = normalized.includes('/');
        if (hasFolderHint) {
            const matches = flattenWorkspaceFiles.filter((p) => p.endsWith(normalized));
            if (matches.length === 1) return matches[0];
            if (matches.length > 1) {
                return matches.reduce((shortest, current) =>
                    current.length < shortest.length ? current : shortest,
                matches[0]);
            }
        }
        return null;
    }, [flattenWorkspaceFiles]);

    const normalizePathParts = (parts = []) => {
        const output = [];
        parts.forEach((part) => {
            if (!part || part === '.') return;
            if (part === '..') {
                output.pop();
                return;
            }
            output.push(part);
        });
        return output;
    };

    const resolveRelativePath = (basePath = '', relativePath = '') => {
        if (!relativePath) return null;
        const rel = relativePath.replace(/^\.\/+/, '').trim();
        if (!rel) return null;
        if (rel.startsWith('/') || rel.startsWith('\\')) {
            return rel.replace(/^\/+/, '').replace(/\\/g, '/');
        }
        const baseParts = String(basePath || '').replace(/\\/g, '/').split('/');
        baseParts.pop();
        const relParts = rel.replace(/\\/g, '/').split('/');
        const combined = normalizePathParts([...baseParts, ...relParts]);
        return combined.join('/');
    };

    const extractReferencedPaths = useCallback((activePath, content = '') => {
        if (!activePath || !content) return [];
        const found = new Set();
        const addPath = (value) => {
            if (!value) return;
            const cleaned = value.split('#')[0].split('?')[0].trim();
            if (!cleaned || /^https?:/i.test(cleaned) || cleaned.startsWith('data:')) return;
            const resolved = resolveRelativePath(activePath, cleaned);
            const workspacePath = resolveWorkspacePath(resolved) || resolveWorkspacePath(cleaned);
            if (workspacePath) found.add(workspacePath);
        };

        const htmlRefs = [
            /<script[^>]*\s+src=["']([^"']+)["']/gi,
            /<link[^>]*\s+href=["']([^"']+)["']/gi,
            /<img[^>]*\s+src=["']([^"']+)["']/gi,
            /<source[^>]*\s+src=["']([^"']+)["']/gi,
        ];
        htmlRefs.forEach((re) => {
            let m;
            while ((m = re.exec(content))) addPath(m[1]);
        });

        const jsRefs = [
            /import\s+[^\n]*?from\s+["']([^"']+)["']/gi,
            /require\(\s*["']([^"']+)["']\s*\)/gi,
        ];
        jsRefs.forEach((re) => {
            let m;
            while ((m = re.exec(content))) addPath(m[1]);
        });

        const cssRefs = [
            /@import\s+["']([^"']+)["']/gi,
            /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
        ];
        cssRefs.forEach((re) => {
            let m;
            while ((m = re.exec(content))) addPath(m[1]);
        });

        return Array.from(found).slice(0, 4);
    }, [resolveWorkspacePath]);

    const inferSiblingPaths = useCallback((activePath) => {
        if (!activePath) return [];
        const normalized = String(activePath).replace(/\\/g, '/');
        const parts = normalized.split('/');
        const fileName = parts.pop() || '';
        const folder = parts.join('/');
        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        const folderPrefix = folder ? `${folder}/` : '';

        const htmlExts = new Set(['html', 'htm']);
        const jsExts = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs']);
        const cssExts = new Set(['css', 'scss', 'sass']);

        let targetExts = [];
        if (htmlExts.has(ext)) {
            targetExts = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'css', 'scss', 'sass'];
        } else if (jsExts.has(ext)) {
            targetExts = ['html', 'htm', 'css', 'scss', 'sass'];
        } else if (cssExts.has(ext)) {
            targetExts = ['html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'mjs'];
        } else {
            return [];
        }

        const siblings = flattenWorkspaceFiles
            .filter((path) => path.startsWith(folderPrefix) && path !== normalized)
            .filter((path) => {
                const siblingExt = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
                return targetExts.includes(siblingExt);
            })
            .slice(0, 3);

        return siblings;
    }, [flattenWorkspaceFiles]);

    // Clear inline suggestion previews when a clear signal is triggered.
    useEffect(() => {
        const session = activeSession;
        if (!session) return;
        if (clearSignal === lastClearSignalRef.current) return;
        lastClearSignalRef.current = clearSignal;
        // Only clear inline suggestion preview; keep multi-file suggestions intact.
        mutateSession(session.id, (s) => ({
            ...s,
            suggestedCode: null,
            showDiff: false,
        }));
        try {
            if (typeof onSuggestRef.current === 'function') onSuggestRef.current(null);
        } catch (e) {}
    }, [activeSession, clearSignal, mutateSession]);

    // Load the current content for a path from editor cache or remote storage.
    const getBaseContentForPath = useCallback(async (targetPath) => {
        if (!targetPath) return null;
        const resolvedPath = resolveWorkspacePath(targetPath) || targetPath;
        if (activeFile?.path === resolvedPath) {
            if (editor?.getValue) {
                return editor.getValue();
            }
            return currentCode || '';
        }
        if (cachedFileMap.has(resolvedPath)) {
            return cachedFileMap.get(resolvedPath);
        }
        if (workspaceSlug) {
            try {
                return await api.fetchFileContent(workspaceSlug, resolvedPath);
            } catch (err) {
                const isNotFound = typeof err?.description === 'string' && err.description.includes('Status: 404');
                if (!isNotFound) {
                    console.error('Failed to load file content for AI suggestion', err);
                }
                return null;
            }
        }
        return null;
    }, [activeFile?.path, cachedFileMap, currentCode, editor, resolveWorkspacePath, workspaceSlug]);

    // ── Agent Pipeline ──────────────────────────────────────────────
    const {
        activePipeline,
        pipelineHistory,
        currentMode: agentMode,
        runPipeline,
        cancelPipeline,
        setCurrentMode: setAgentMode,
        shouldUseAgents,
        PIPELINE_MODES: MODES,
    } = useAgentPipeline({
        workspaceSlug,
        activeFile,
        currentCode,
        getBaseContentForPath,
        flattenWorkspaceFiles,
        resolveWorkspacePath,
        onProgress: null, // wired per-request in handleSendMessage
    });

    // Convert AI diff/plaintext responses into structured multi-file suggestions.
    const buildMultiFileSuggestions = useCallback(async (rawText) => {
        const fallbackPath = fallbackPathRef.current;
        const blocks = parseFileDiffBlocks(rawText, fallbackPath);
        if (!blocks.length) return [];
        const hydrated = [];
        const isNoChangeText = (contentText = '') => {
            const firstLine = (contentText || '').split('\n')[0].trim().toUpperCase();
            return firstLine.startsWith('NO_CHANGES') || firstLine.startsWith('NO CHANGES') || firstLine.startsWith('NO CHANGE');
        };
        const isDeleteInstruction = (contentText = '') => {
            const norm = (contentText || '').trim().toUpperCase();
            return norm === 'DELETE' || norm === 'DELETE FILE' || norm === 'DELETE_FILE' || norm === 'REMOVE FILE' || norm === 'DELETE FOLDER' || norm === 'REMOVE FOLDER';
        };
        const isFolderPath = (p = '') => p.endsWith('/') || p.toLowerCase().includes('[folder]');

        for (const block of blocks) {
            const hasFolderHint = typeof block.path === 'string' && block.path.includes('/');
            const activeBasePath = activeFileRef.current?.path || activeFileRef.current?.name || '';
            const relativeCandidate = !hasFolderHint
                ? resolveRelativePath(activeBasePath, block.path)
                : null;
            const resolvedPath = resolveWorkspacePath(relativeCandidate)
                || resolveWorkspacePath(block.path)
                || relativeCandidate
                || block.path;
            const folderFlag = isFolderPath(block.path);
            const baseContent = folderFlag ? '' : await getBaseContentForPath(resolvedPath);
            const baseIsMissing = folderFlag ? false : typeof baseContent !== 'string';
            const currentContent = baseIsMissing ? '' : baseContent;

            if (block.contentText && !block.diffText) {
                if (isDeleteInstruction(block.contentText)) {
                    hydrated.push({
                        path: block.path,
                        resolvedPath,
                        diffText: null,
                        originalContent: currentContent,
                        updatedContent: '',
                        isNewFile: false,
                        isFolder: folderFlag,
                        deleteFile: !folderFlag,
                        deleteFolder: folderFlag,
                        chunks: [],
                        status: 'pending',
                    });
                    continue;
                }
                if (isNoChangeText(block.contentText)) {
                    continue;
                }
                hydrated.push({
                    path: block.path,
                    resolvedPath,
                    diffText: null,
                    originalContent: currentContent,
                    updatedContent: block.contentText,
                    isNewFile: baseIsMissing && !folderFlag,
                    isFolder: folderFlag,
                    chunks: computeDiffChunks(currentContent, block.contentText),
                    status: 'pending',
                });
                continue;
            }

            if (!block.isValidDiff || !block.diffText) {
                // If the model returned no diff/content but referenced a file, interpret as clearing the file.
                if (!block.diffText && !block.contentText) {
                    hydrated.push({
                        path: block.path,
                        resolvedPath,
                        diffText: null,
                        originalContent: currentContent,
                        updatedContent: '',
                        isNewFile: baseIsMissing && !folderFlag,
                        isFolder: folderFlag,
                        deleteFile: folderFlag ? false : baseIsMissing ? false : true,
                        deleteFolder: folderFlag,
                        chunks: [],
                        status: 'pending',
                    });
                    continue;
                }
                hydrated.push({
                    path: block.path,
                    resolvedPath,
                    diffText: block.diffText,
                    status: 'error',
                    error: 'AI response did not include usable diff or content. Ask again with a specific file path.',
                });
                continue;
            }

            let patched = applyPatch(currentContent, block.diffText);
            if (patched === false && baseIsMissing) {
                patched = stripDiffMarkers(block.diffText);
            }
            if (patched === false) {
                hydrated.push({
                    path: block.path,
                    resolvedPath,
                    diffText: block.diffText,
                    status: 'error',
                    error: baseIsMissing ? 'File not found; unable to apply AI diff.' : 'Failed to apply AI diff to the current file contents.',
                });
                continue;
            }
            const isDelete = !baseIsMissing && typeof patched === 'string' && patched.length === 0;
            hydrated.push({
                path: block.path,
                resolvedPath,
                diffText: block.diffText,
                originalContent: currentContent,
                updatedContent: patched,
                isNewFile: baseIsMissing && !folderFlag,
                isFolder: folderFlag,
                deleteFile: isDelete && !folderFlag,
                deleteFolder: isDelete && folderFlag,
                chunks: folderFlag ? [] : computeDiffChunks(currentContent, patched),
                status: 'pending',
            });
        }
        return hydrated;
    }, [getBaseContentForPath, resolveWorkspacePath]);

    // Ensure the requested file is active in the editor, selecting or creating it as needed.
    const openFileByPath = useCallback(async (path) => {
        if (!path) return null;
        const resolvedPath = resolveWorkspacePath(path) || path;
        if (activeFile?.path === resolvedPath) {
            return resolvedPath;
        }
        const node = findFileNodeByPath(resolvedPath);
        if (node) {
            await dispatch(selectFileThunk(node));
            return resolvedPath;
        }
        const fallbackName = resolvedPath.split('/').pop() || resolvedPath;
        await dispatch(selectFileThunk({
            path: resolvedPath,
            name: fallbackName,
            type: 'file',
            language: getFileLanguage(fallbackName),
        }));
        return resolvedPath;
    }, [activeFile?.path, dispatch, findFileNodeByPath, resolveWorkspacePath]);

    // Push new content into editor/redux for a given path and flag if it should be saved.
    const applyContentToPath = useCallback((path, newContent, { skipSave = false } = {}) => {
        if (!path || typeof newContent !== 'string') return;
        const resolvedPath = resolveWorkspacePath(path) || path;
        if (activeFile?.path === resolvedPath && editor) {
            const model = editor.getModel ? editor.getModel() : null;
            if (model && typeof editor.executeEdits === 'function') {
                const fullRange = model.getFullModelRange();
                editor.executeEdits('ai-apply', [{ range: fullRange, text: newContent }]);
                if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop();
            } else if (typeof editor.setValue === 'function') {
                editor.setValue(newContent);
            }
        }
        dispatch(setExternalFileContent({ path: resolvedPath, content: newContent }));
        return { resolvedPath, saved: !skipSave };
    }, [activeFile?.path, dispatch, editor, resolveWorkspacePath]);

    // Apply a pending file suggestion to the workspace and mark its status.
    const handleApplyFileSuggestion = useCallback(async (sessionId, path) => {
        if (!path) return;
        const session = chatSessions.find((s) => s.id === sessionId);
        const suggestion = session?.fileSuggestions?.find((fs) => fs.path === path);
        if (!suggestion || suggestion.status !== 'pending') return;
        if (suggestion.updatedContent == null) {
            mutateSession(sessionId, (s) => ({
                ...s,
                fileSuggestions: s.fileSuggestions.map((fs) =>
                    fs.path === path ? { ...fs, status: 'error', error: 'Missing updated content from AI response.' } : fs
                ),
            }));
            return;
        }

        mutateSession(sessionId, (s) => ({
            ...s,
            fileSuggestions: s.fileSuggestions.map((fs) =>
                fs.path === path ? { ...fs, status: 'saving' } : fs
            ),
        }));

        try {
            const targetPath = suggestion.resolvedPath || resolveWorkspacePath(path) || path;
            if (suggestion.isNewFile || suggestion.isFolder) {
                mutateSession(sessionId, (s) => ({
                    ...s,
                    fileSuggestions: s.fileSuggestions.map((fs) =>
                        fs.path === path ? { ...fs, status: 'saving' } : fs
                    ),
                }));
                try {
                    const allowed = typeof window !== 'undefined'
                        ? window.confirm(`Create new ${suggestion.isFolder ? 'folder' : 'file'} "${targetPath}" from AI suggestion?`)
                        : true;
                    if (!allowed) {
                        mutateSession(sessionId, (s) => ({
                            ...s,
                            fileSuggestions: s.fileSuggestions.map((fs) =>
                                fs.path === path ? { ...fs, status: 'pending' } : fs
                            ),
                        }));
                        return;
                    }
                } catch (e) {
                    // fallback to proceed
                }
            }
            if (suggestion.deleteFile) {
                const allowedDelete = typeof window !== 'undefined'
                    ? window.confirm(`Delete file "${targetPath}" from AI suggestion?`)
                    : true;
                if (!allowedDelete) {
                    mutateSession(sessionId, (s) => ({
                        ...s,
                        fileSuggestions: s.fileSuggestions.map((fs) =>
                            fs.path === path ? { ...fs, status: 'pending' } : fs
                        ),
                    }));
                    return;
                }
            }
            if (workspaceSlug && (suggestion.isNewFile || suggestion.isFolder)) {
                try {
                    try { if (typeof onBusy === 'function') onBusy(true); } catch (e) {}
                    const createPath = suggestion.isFolder && !targetPath.endsWith('/') ? `${targetPath}/` : targetPath;
                    await api.createItem(workspaceSlug, createPath, Boolean(suggestion.isFolder));
                    await dispatch(fetchFilesThunk(workspaceSlug));
                } catch (createErr) {
                    mutateSession(sessionId, (s) => ({
                        ...s,
                        fileSuggestions: s.fileSuggestions.map((fs) =>
                            fs.path === path ? { ...fs, status: 'error', error: createErr?.message || 'Failed to create item.' } : fs
                        ),
                    }));
                    return;
                } finally {
                    try { if (typeof onBusy === 'function') onBusy(false); } catch (e) {}
                }
            }
            if (workspaceSlug && suggestion.deleteFile) {
                try {
                    try { if (typeof onBusy === 'function') onBusy(true); } catch (e) {}
                    const allowedDelete = typeof window !== 'undefined'
                        ? window.confirm(`Delete file "${targetPath}" from AI suggestion?`)
                        : true;
                    if (!allowedDelete) {
                        mutateSession(sessionId, (s) => ({
                            ...s,
                            fileSuggestions: s.fileSuggestions.map((fs) =>
                                fs.path === path ? { ...fs, status: 'pending' } : fs
                            ),
                        }));
                        return;
                    }
                    await api.deleteItem(workspaceSlug, targetPath);
                    const result = await dispatch(fetchFilesThunk(workspaceSlug));
                    // If the deleted file was active, pick a fallback (same folder or first file)
                    if (activeFileRef.current && activeFileRef.current.path === targetPath) {
                        const files = result?.payload?.files || [];
                        const nextFile = (() => {
                            const deletedFolder = targetPath.includes('/') ? targetPath.split('/').slice(0, -1).join('/') : '';
                            const siblings = files.filter(f => !f.isFolder && (deletedFolder ? f.path.startsWith(`${deletedFolder}/`) : !f.path.includes('/')));
                            if (siblings.length) return siblings[0];
                            return findFirstFile(files);
                        })();
                        if (nextFile) {
                            dispatch(selectFileThunk(nextFile));
                        }
                    }
                } catch (delErr) {
                    mutateSession(sessionId, (s) => ({
                        ...s,
                        fileSuggestions: s.fileSuggestions.map((fs) =>
                            fs.path === path ? { ...fs, status: 'error', error: delErr?.message || 'Failed to delete file.' } : fs
                        ),
                    }));
                    return;
                } finally {
                    try { if (typeof onBusy === 'function') onBusy(false); } catch (e) {}
                }
            } else if (workspaceSlug && suggestion.deleteFolder) {
                try {
                    try { if (typeof onBusy === 'function') onBusy(true); } catch (e) {}
                    const allowedDelete = typeof window !== 'undefined'
                        ? window.confirm(`Delete folder "${targetPath}" from AI suggestion?`)
                        : true;
                    if (!allowedDelete) {
                        mutateSession(sessionId, (s) => ({
                            ...s,
                            fileSuggestions: s.fileSuggestions.map((fs) =>
                                fs.path === path ? { ...fs, status: 'pending' } : fs
                            ),
                        }));
                        return;
                    }
                    await api.deleteItem(workspaceSlug, targetPath.endsWith('/') ? targetPath : `${targetPath}/`);
                    await dispatch(fetchFilesThunk(workspaceSlug));
                } catch (delErr) {
                    mutateSession(sessionId, (s) => ({
                        ...s,
                        fileSuggestions: s.fileSuggestions.map((fs) =>
                            fs.path === path ? { ...fs, status: 'error', error: delErr?.message || 'Failed to delete folder.' } : fs
                        ),
                    }));
                    return;
                } finally {
                    try { if (typeof onBusy === 'function') onBusy(false); } catch (e) {}
                }
            } else {
                await openFileByPath(targetPath);
                // Always persist new files after user approval.
                applyContentToPath(targetPath, suggestion.updatedContent, { skipSave: false });
                if (workspaceSlug) {
                    const fileName = targetPath.split('/').pop() || 'file.txt';
                    await api.saveFileContent(workspaceSlug, targetPath, suggestion.updatedContent, fileName);
                }
            }
            mutateSession(sessionId, (s) => ({
                ...s,
                fileSuggestions: s.fileSuggestions.map((fs) => {
                    if (fs.path !== path) return fs;
                    const finalStatus = (suggestion.deleteFile || suggestion.deleteFolder) ? 'deleted' : 'applied';
                    return { ...fs, status: finalStatus, error: null };
                }),
            }));
            try {
                if (typeof onSuggestRef.current === 'function') onSuggestRef.current({ clear: true });
            } catch (e) {}
        } catch (error) {
        mutateSession(sessionId, (s) => ({
            ...s,
            fileSuggestions: s.fileSuggestions.map((fs) =>
                fs.path === path ? { ...fs, status: 'error', error: error.message || 'Failed to save changes.' } : fs
            ),
        }));
    }
    }, [applyContentToPath, chatSessions, mutateSession, openFileByPath, resolveWorkspacePath, workspaceSlug, dispatch, onBusy]);

    // Mark a file suggestion as rejected and notify listeners.
    const handleRejectFileSuggestion = useCallback((sessionId, path) => {
        if (!path) return;
        mutateSession(sessionId, (s) => ({
            ...s,
            fileSuggestions: s.fileSuggestions.map((fs) =>
                fs.path === path ? { ...fs, status: 'rejected' } : fs
            ),
        }));
        try {
            if (typeof onSuggestRef.current === 'function') onSuggestRef.current({ clear: true });
        } catch (e) {}
    }, [mutateSession]);

    // Build a snapshot of current suggestions for history or fallback reuse.
    const buildSuggestionSnapshot = useCallback((session) => {
        try {
            if (!session) return null;
            const hasLive = (session.fileSuggestions?.length || 0) > 0 || session.suggestedCode;
            const fallback = lastSuggestionSnapshotRef.current;
            const source = hasLive ? session : fallback;
            if (!source) return null;
            const fileSuggestions = hasLive ? (session.fileSuggestions || []) : (fallback?.fileSuggestions || []);
            const suggestedCode = hasLive ? session.suggestedCode : (fallback?.suggestedCode || null);
            if (!fileSuggestions.length && !suggestedCode) return null;
            let diffChunks = [];
            try {
                diffChunks = suggestedCode
                    ? computeDiffChunks(currentCodeRef.current || currentCode || '', suggestedCode)
                    : (fallback?.diffChunks || []);
            } catch (e) {
                diffChunks = fallback?.diffChunks || [];
            }
            const timestamp = session.suggestionTimestamp
                ? new Date(session.suggestionTimestamp)
                : (fallback?.timestamp ? new Date(fallback.timestamp) : new Date());
            return { fileSuggestions, suggestedCode, diffChunks, timestamp };
        } catch (e) {
            return null;
        }
    }, [currentCode, currentCodeRef]);

    // Persist a suggestion snapshot into the message history and clear live state.
    const pushSnapshotToHistory = useCallback((sessionId, snapshot) => {
        try {
            if (!sessionId || !snapshot) return;
            mutateSession(sessionId, (s) => ({
                ...s,
                messages: [
                    ...s.messages,
                    {
                        id: `suggestion-${Date.now()}`,
                        role: 'suggestion-history',
                        timestamp: snapshot.timestamp || new Date(),
                        snapshot,
                    }
                ],
                fileSuggestions: [],
                suggestedCode: null,
                showDiff: false,
                suggestionTimestamp: null,
            }));
            lastSuggestionSnapshotRef.current = null;
        } catch (e) {
            // swallow to avoid bubbling to global error handler
        }
    }, [mutateSession]);

    // Open a suggested file and surface its proposed content to the editor preview.
    const handlePreviewFileSuggestion = useCallback(async (sessionId, path) => {
        if (!path || typeof onSuggest !== 'function') return;
        const session = chatSessions.find((s) => s.id === sessionId);
        const suggestion = session?.fileSuggestions?.find((fs) => fs.path === path);
        if (!suggestion || suggestion.status === 'error' || suggestion.deleteFile) return;
        const targetPath = suggestion.resolvedPath || resolveWorkspacePath(path) || path;
        await openFileByPath(targetPath);
        onSuggest({ completion: suggestion.updatedContent || '', filePath: targetPath });
    }, [chatSessions, onSuggest, openFileByPath, resolveWorkspacePath]);

    // Apply a single-file inline suggestion to the editor and archive it to history.
    const applySuggestion = useCallback(() => {
        if (!activeSession || !activeSession.suggestedCode) return;
        const suggestedCode = activeSession.suggestedCode;
        try {
            const snapshotRaw = buildSuggestionSnapshot(activeSession);
            const snapshot = snapshotRaw ? { ...snapshotRaw, timestamp: new Date() } : null;
            if (editor && typeof editor.executeEdits === 'function' && editor.getModel) {
                const model = editor.getModel();
                if (model) {
                    const fullRange = model.getFullModelRange();
                    editor.executeEdits('ai-apply', [{ range: fullRange, text: suggestedCode }]);
                    if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop();
                } else if (typeof editor.setValue === 'function') {
                    editor.setValue(suggestedCode);
                }
            } else if (editor && typeof editor.setValue === 'function') {
                editor.setValue(suggestedCode);
            }
            pushSnapshotToHistory(activeSession.id, snapshot);
        } catch (e) {
            // ignore snapshot errors; still continue
        }
        try {
            if (typeof onSuggest === 'function') onSuggest(null);
        } catch (e) {}
        appendMessagesToSession(activeSession.id, [{ id: Date.now(), role: 'assistant', content: 'Suggestion applied to editor.', timestamp: new Date() }]);
    }, [activeSession, appendMessagesToSession, buildSuggestionSnapshot, editor, onSuggest, pushSnapshotToHistory]);

    // Reject the current inline suggestion and push it into history for reference.
    const rejectSuggestion = useCallback(() => {
        if (!activeSession) return;
        try {
            const snapshotRaw = buildSuggestionSnapshot(activeSession);
            const snapshot = snapshotRaw ? { ...snapshotRaw, timestamp: new Date() } : null;
            pushSnapshotToHistory(activeSession.id, snapshot);
        } catch (e) {
            // ignore snapshot errors
        }
        try {
            if (typeof onSuggest === 'function') onSuggest(null);
        } catch (e) {}
        appendMessagesToSession(activeSession.id, [{ id: Date.now(), role: 'assistant', content: 'Suggestion rejected.', timestamp: new Date() }]);
        lastSuggestionSnapshotRef.current = null;
    }, [activeSession, appendMessagesToSession, buildSuggestionSnapshot, onSuggest, pushSnapshotToHistory]);

    // Archive any active suggestion snapshot without applying it.
    const archiveCurrentSuggestion = useCallback(() => {
        const session = activeSession;
        if (!session) return;
        try {
            const snapshotRaw = buildSuggestionSnapshot(session);
            const snapshot = snapshotRaw ? { ...snapshotRaw, timestamp: new Date() } : null;
            if (!snapshot) return;
            pushSnapshotToHistory(session.id, snapshot);
        } catch (e) {
            // ignore snapshot errors
        }
    }, [activeSession, buildSuggestionSnapshot, pushSnapshotToHistory]);

    // Format attachments into a text block the AI prompt can consume.
    const buildAttachmentText = (attachments = []) => {
        if (!Array.isArray(attachments) || attachments.length === 0) return '';
        return attachments.map((att) => {
            const header = `FILE: ${att.name || 'attachment'} (${att.type || 'unknown'}, ${att.size || 0} bytes)`;
            if (att.kind === 'image' && att.content) {
                return `${header}\nImage attachment provided. Analyze the image content and identify any issues or anything requested by the user.`;
            }
            if (att.kind === 'text' && att.content) {
                const snippet = att.content.length > 4000 ? `${att.content.slice(0, 4000)}\n... [truncated]` : att.content;
                return `${header}\n\`\`\`\n${snippet}\n\`\`\``;
            }
            const note = att.note || 'Binary attachment; content not inlined.';
            return `${header}\n${note}`;
        }).join('\n\n');
    };

    // Send a user prompt to the AI, stream partial responses, and update suggestion state.
    const handleSendMessage = useCallback(async (inputValue, attachments = [], streamHandlers = {}) => {
        if (!inputValue?.trim()) return;
        if (!activeSession) return;
        const {
            controller,
            onStreamStart,
            onFirstToken,
            onChunk,
            onDone,
            onCanceled,
            onError,
            onLog,
        } = streamHandlers || {};

        archiveCurrentSuggestion();

        const userMessage = {
            id: Date.now(),
            role: 'user',
            content: inputValue,
            timestamp: new Date(),
        attachments,
    };

        appendMessagesToSession(activeSession.id, [userMessage]);
        setIsLoading(true);

        const progressId = `progress-${Date.now()}`;
        const pushProgress = (updater) => {
            mutateSession(activeSession.id, (session) => ({
                ...session,
                messages: session.messages.map((m) => {
                    if (m.id !== progressId) return m;
                    return updater(m);
                }),
            }));
        };
        const appendProgressLog = (line) => {
            pushProgress((m) => ({
                ...m,
                logs: m.logs.some((l) => l === line) ? m.logs : [...m.logs, line],
            }));
        };

        const progressTimestamp = new Date(Date.now() + 1); // ensure it renders right after the user message
        const promptSnippet = (inputValue || '').slice(0, 120).replace(/\s+/g, ' ').trim();
        const attachmentNote = Array.isArray(attachments) && attachments.length ? `Attachments: ${attachments.length}` : null;

        mutateSession(activeSession.id, (session) => ({
            ...session,
            messages: [
                ...session.messages,
                {
                    id: progressId,
                    role: 'progress',
                    status: 'working',
                    expanded: true,
                    logs: [
                        'Working...',
                        promptSnippet ? `Understanding request: "${promptSnippet}"` : 'Understanding request',
                        attachmentNote || null,
                    ].filter(Boolean),
                    timestamp: progressTimestamp,
                },
            ],
        }));

        let streamBuffer = '';
        let finalSuggestion = '';
        let buffered = '';
        let firstToken = true;
        const abortController = controller || new AbortController();
        let timeoutId = null;

        try {
            const langSource =
                activeFile?.language ||
                (activeFile?.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = (langSource || 'plaintext').toLowerCase();
            const code = currentCode || '';
            const userPrompt = inputValue;
            
            // Classify user intent using LLM-based backend (with local fallback)
            // This determines whether the user wants code changes or just an explanation
            appendProgressLog('Classifying intent...');
            const contextSnippet = code ? code.slice(0, 500) : null; // Small snippet for context
            const { needsCodeChanges, responseMode, intent } = await classifyQueryIntent(userPrompt, contextSnippet);
            appendProgressLog(`Intent: ${intent} → ${needsCodeChanges ? 'code changes' : 'explanation'}`);
            
            // ── Agent Pipeline ──────────────────────────────────────
            // Run sub-agents if the prompt warrants it (complex queries, multi-file, search, etc.)
            let agentContext = '';
            let agentResults = [];
            const useAgents = shouldUseAgents(userPrompt);
            
            if (useAgents) {
                appendProgressLog('Running agent pipeline...');
                onLog?.('Dispatching sub-agents');
                try {
                    const pipelineResult = await runPipeline(userPrompt, {
                        referencedFilesLoaded: false,
                    }, {
                        mode: agentMode === PIPELINE_MODES.DIRECT ? PIPELINE_MODES.AUTO : agentMode,
                        signal: abortController.signal,
                        onStepStart: (step) => {
                            appendProgressLog(`${step.agentName}: starting...`);
                            onLog?.(`Agent: ${step.agentName}`);
                        },
                        onStepComplete: (result) => {
                            const status = result.status === 'completed' ? '✓' : '✗';
                            appendProgressLog(`${status} ${result.agentName}: ${result.status}`);
                        },
                        onPlanReady: (plan) => {
                            appendProgressLog(`Plan: ${plan.steps.length} steps — ${plan.reasoning}`);
                        },
                    });
                    agentContext = pipelineResult.agentContext || '';
                    agentResults = pipelineResult.results || [];
                    if (agentResults.length > 0) {
                        appendProgressLog(`Agent pipeline: ${agentResults.filter(r => r.status === 'completed').length}/${agentResults.length} steps completed`);
                    }
                } catch (agentErr) {
                    appendProgressLog(`Agent pipeline error: ${agentErr.message}. Continuing without agents.`);
                    agentContext = '';
                    agentResults = [];
                }
            }

            // ── Context Window ──────────────────────────────────────
            // Build a token-budgeted context window with all gathered information
            
            // Build different prompts based on classified intent
            let requestPrompt;
            let requestMode = responseMode;
            
            if (!needsCodeChanges) {
                // For explanation/question queries, use a simpler prompt that doesn't ask for FILE: blocks
                requestPrompt = `${userPrompt}

Provide a clear, informative explanation answering the user's question. 
Do NOT use FILE: markers or suggest code changes unless the user explicitly asks for modifications.
If you include code snippets for illustration, use standard markdown code blocks.
Focus on understanding and clarity - explain concepts, describe how code works, or answer questions.

Stream at least two short progress updates wrapped in <progress>...</progress> as you reason.`;
            } else {
                // For code change requests, use the full patch prompt
                requestPrompt = `${userPrompt}

When the user asks you to CREATE NEW FILES (new pages, components, apps, etc.), you MUST create them using FILE: blocks at the appropriate paths. Do NOT fold new file content into an existing file. Each new file gets its own FILE: block.

If the user asks to delete a file, return an empty content block or the literal text DELETE to mark deletion. Always respect the workspace tree when creating or deleting files.

For modifications to existing files, modify only the files the user mentions or that are relevant to the change.

Start with a brief (6-7 sentences) summary of the change. Stream at least three short progress updates wrapped in <progress>...</progress> as you reason (no code inside progress). Emit the summary before any FILE sections. After the summary, return one or more sections in this exact format:
FILE: <path>
\`\`\`
<full updated file content only; no diff markers, no +/-, no @@, no ---/+++>
\`\`\`

Do not include any other commentary. Do not restate the user's request or any instructions; only describe what you changed/created/deleted. Preserve all code outside the requested change. Do not add speculative comments or boilerplate. Do not duplicate entire documents or repeat the same file content. Do not insert HTML into JS files (or vice versa). If unclear, return FILE: <path> then NO_CHANGES and a brief clarifying question.

If image attachments are present, read/ocr the images and extract any text or code they contain. Use the extracted content to fulfill the request, rewriting it as needed into the target file(s).`;
            }
            
            const activePath = activeFile?.path || activeFile?.name || '';
            const referencedPaths = extractReferencedPaths(activePath, code);
            const siblingPaths = referencedPaths.length === 0 ? inferSiblingPaths(activePath) : [];
            const relatedPaths = Array.from(new Set([...referencedPaths, ...siblingPaths]));
            const referencedEntries = relatedPaths.length
                ? await Promise.all(relatedPaths.map(async (path) => [path, await getBaseContentForPath(path)]))
                : [];
            const referencedCacheEntries = referencedEntries.filter((entry) => entry[0] && typeof entry[1] === 'string');
            const cacheEntryMap = new Map(fileCacheEntries);
            referencedCacheEntries.forEach(([path, content]) => {
                if (!cacheEntryMap.has(path)) cacheEntryMap.set(path, content);
            });
            const mergedCacheEntries = Array.from(cacheEntryMap.entries());

            const filesPayloadRaw = buildFilesPayload({
                activeFile,
                fullDocument: code,
                cacheEntries: mergedCacheEntries,
            });
            const mentionsOtherFile = /\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,5}\b/.test(userPrompt) || /other file|another file|files/i.test(userPrompt) || /delete\s+\w+/i.test(userPrompt) || /remove\s+\w+/i.test(userPrompt) || /create\s+\w+/i.test(userPrompt) || /new file/i.test(userPrompt);
            const includeRelatedFiles = relatedPaths.length > 0;
            const wantsFullRepo = /\b(full repo|entire repo|whole repo|entire project|all files|full context)\b/i.test(userPrompt);
            const filesPayload = mentionsOtherFile
                ? filesPayloadRaw
                : includeRelatedFiles
                    ? filesPayloadRaw
                    : filesPayloadRaw.filter((f) => f.path === (activeFile?.path || activeFile?.name));
            // Disable fallback to active file when prompt targets other files (creates/deletes) to avoid hijacking the active file.
            fallbackPathRef.current = mentionsOtherFile ? null : (activeFile?.path || activeFile?.name || null);
            if (filesPayload.length > 1 || mentionsOtherFile || includeRelatedFiles) {
                requestPrompt = `${requestPrompt}\n\nAdditional workspace files are attached. Update all related files needed to fulfill the request (HTML/CSS/JS as applicable). Reference them by their path when relevant.`;
            }
            const attachmentText = buildAttachmentText(attachments);
            if (attachmentText) {
                requestPrompt = `${requestPrompt}\n\nUser attachments:\n${attachmentText}`;
            }
            if (needsCodeChanges) {
                requestPrompt = `${requestPrompt}\n\nStream at least three progress updates inside <progress>...</progress> as you reason (no code inside progress).`;
            }
            appendProgressLog(filesPayload.length ? `Context files: ${filesPayload.length}` : 'Context files: 0');

            // ── Build Context Window ────────────────────────────────
            // Use the context window manager to fit everything within token budget
            const sessionMessages = activeSession?.messages?.filter(m => m.role === 'user' || m.role === 'assistant') || [];
            const contextWindow = buildContextWindow({
                currentMessage: userPrompt,
                messages: sessionMessages,
                activeFile,
                currentCode: code,
                referencedFiles: referencedCacheEntries,
                relatedFiles: [],
                codeIntelContext: null, // will be fetched server-side
                agentResults: agentResults.filter(r => r.status === 'completed'),
            });
            const contextDebug = getContextDebugInfo(contextWindow);
            appendProgressLog(`Context window: ${contextDebug.utilization} used (${contextDebug.includedEntries} entries, ${contextDebug.excludedEntries} excluded${contextDebug.hasSummary ? ', with summary' : ''})`);
            onLog?.(`Context: ${contextDebug.utilization}`);
            
            // Inject agent-gathered context into the prompt
            if (agentContext) {
                requestPrompt = `${requestPrompt}\n\n=== AGENT-GATHERED CONTEXT ===\nThe following context was gathered by specialized sub-agents analyzing your workspace:\n${agentContext}\n=== END AGENT CONTEXT ===`;
                appendProgressLog('Agent context injected into prompt');
            }
            
            // If we have a conversation summary from context window, inject it
            const { contextPrefix } = formatForAPI(contextWindow);
            if (contextPrefix) {
                requestPrompt = `${contextPrefix}\n\n${requestPrompt}`;
            }

            try { if (typeof onBusy === 'function') onBusy(true); } catch (e) {}

            onStreamStart?.();
            onLog?.('Preparing request');

            // Safety timeout so UI doesn't hang forever if the backend never responds
            timeoutId = setTimeout(() => {
                try { abortController.abort('timeout'); } catch (e) {}
            }, 60_000);

            onLog?.('Analyzing prompt and files');
            appendProgressLog('Analyzing prompt and files');
            const serializedAttachments = Array.isArray(attachments)
                ? attachments.map((att) => ({
                    name: att?.name || '',
                    type: att?.type || '',
                    size: att?.size || 0,
                    kind: att?.kind || '',
                    content: typeof att?.content === 'string' ? att.content : '',
                }))
                : [];

            const resp = await fetch('/api/chat', {
                method: 'POST',
                signal: abortController.signal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    lang: normalizedLang,
                    code,
                    prompt: requestPrompt,
                    mode: requestMode,
                    files: filesPayload,
                    attachments: serializedAttachments,
                    focusPath: activeFile?.path || activeFile?.name || null,
                    model: aiModel,
                    apiKey: aiApiKey,
                    // Code intelligence integration
                    workspacePath: workspaceSlug || null,
                    useCodeIntel: true,
                    maxContextTokens: Math.min(6000, Math.floor(availableTokens * 0.2)),
                    fullRepoContext: wantsFullRepo,
                    // Context window conversation history for multi-turn coherence
                    conversationHistory: formatForAPI(contextWindow).conversationHistory,
                    // Agent pipeline metadata
                    agentMode: useAgents ? agentMode : 'direct',
                    agentStepCount: agentResults.length,
                }),
            });

            if (!resp.ok) {
                throw new Error(`AI request failed (status ${resp.status})`);
            }
            const traceSummary = resp.headers.get('x-code-intel-trace-summary');
            const traceCount = resp.headers.get('x-code-intel-trace-count');
            const sourcesHeader = resp.headers.get('x-code-intel-sources');
            let contextSources = [];
            if (sourcesHeader) {
                try {
                    contextSources = JSON.parse(decodeURIComponent(sourcesHeader));
                } catch (e) {
                    contextSources = [];
                }
            }
            if (traceSummary) {
                const message = traceCount && traceCount !== '0'
                    ? `Context trace (${traceCount}): ${traceSummary}`
                    : `Context trace: ${traceSummary}`;
                onLog?.(message);
                appendProgressLog(message);
            }
            if ((traceSummary || (contextSources && contextSources.length)) && activeSession) {
                appendMessagesToSession(activeSession.id, [{
                    id: `context-${Date.now()}`,
                    role: 'context',
                    timestamp: new Date(Date.now() + 2),
                    contextMeta: {
                        traceSummary: traceSummary || '',
                        traceCount: traceCount || '0',
                        sources: contextSources,
                    },
                }]);
            }
            onLog?.('Connected to model');
            appendProgressLog('Drafting answer');

            const reader = resp.body?.pipeThrough(new TextDecoderStream()).getReader();
            if (!reader) {
                throw new Error('No response stream received from AI');
            }

            let summaryBuffer = '';
            let progressBuffer = '';
            const progressTokens = {
                start: '<progress>',
                end: '</progress>',
            };
            const collectProgress = (text = '') => {
                const logs = [];
                const pattern = /<progress>([\s\S]*?)<\/progress>/gi;
                let cleaned = text;
                let m;
                while ((m = pattern.exec(cleaned))) {
                    const t = (m[1] || '').trim();
                    if (t) {
                        // Strip any user prompt echoing
                        logs.push(t.replace(/Understanding request:[\s\S]*$/i, '').trim() || t);
                    }
                }
                cleaned = cleaned.replace(pattern, '');
                return { cleaned, logs };
            };
            const drainProgressBuffer = (finalFlush = false) => {
                let stableText = '';
                while (true) {
                    const start = progressBuffer.indexOf(progressTokens.start);
                    if (start === -1) {
                        if (finalFlush) {
                            stableText += progressBuffer;
                            progressBuffer = '';
                            break;
                        }
                        let preserve = 0;
                        for (let i = progressTokens.start.length - 1; i > 0; i--) {
                            if (progressBuffer.endsWith(progressTokens.start.slice(0, i))) {
                                preserve = i;
                                break;
                            }
                        }
                        const flushUntil = Math.max(0, progressBuffer.length - preserve);
                        if (flushUntil > 0) {
                            stableText += progressBuffer.slice(0, flushUntil);
                            progressBuffer = progressBuffer.slice(flushUntil);
                        }
                        break;
                    }
                    const beforeProgress = progressBuffer.slice(0, start);
                    stableText += beforeProgress;
                    const end = progressBuffer.indexOf(progressTokens.end, start + progressTokens.start.length);
                    if (end === -1) {
                        progressBuffer = progressBuffer.slice(start);
                        break;
                    }
                    let progressText = progressBuffer.slice(start + progressTokens.start.length, end).trim();
                    if (progressText) {
                        progressText = progressText.replace(/Understanding request:[\s\S]*$/i, '').trim() || progressText;
                        appendProgressLog(progressText);
                    }
                    progressBuffer = progressBuffer.slice(end + progressTokens.end.length);
                }
                return stableText;
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                await new Promise((resolve) => setTimeout(resolve, 60)); // slow streaming slightly
                buffered += value;
                const lines = buffered.split('\n');
                buffered = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let parsed = null;
                    try {
                        parsed = JSON.parse(line);
                    } catch (e) {
                        continue;
                    }
                    // Skip validation errors — they are metadata, not content
                    if (parsed?.validationFailed) {
                        console.warn('[AI Chat] Validation:', parsed.validationError || 'format issue');
                        continue;
                    }
                    const delta = parsed?.delta || parsed?.text || '';
                    const doneFlag = Boolean(parsed?.done);
                    if (delta) {
                        progressBuffer += delta;

                        const stableText = drainProgressBuffer();

                        if (!stableText) continue;
                        streamBuffer += stableText;

                        if (firstToken) {
                            firstToken = false;
                            onFirstToken?.();
                            onLog?.('Model started responding');
                            appendProgressLog('Thinking through solution');
                        }
                        onLog?.('Refining response');
                        appendProgressLog('Refining response');
                        summaryBuffer += stableText;

                        // Stream explanation text in real-time for explain mode
                        if (!needsCodeChanges && typeof onChunk === 'function') {
                            // In explain mode, stream the content as it arrives
                            onChunk(summaryBuffer);
                        }

                        let partialCode = extractCodeFromMarkdown(streamBuffer);
                        if (!partialCode) {
                            const openIdx = streamBuffer.indexOf('```');
                            if (openIdx !== -1) {
                                const afterFence = streamBuffer.slice(openIdx + 3);
                                const firstNewline = afterFence.indexOf('\n');
                                const contentStart = firstNewline === -1 ? 0 : firstNewline + 1;
                                partialCode = afterFence.slice(contentStart);
                                const closeIdx = partialCode.indexOf('```');
                                if (closeIdx !== -1) partialCode = partialCode.slice(0, closeIdx);
                            } else if (streamBuffer.length > 40) {
                                partialCode = streamBuffer;
                            }
                        }

                        if (partialCode) {
                            const cleaned = partialCode.replace(/\r/g, '');
                            mutateSession(activeSession.id, (session) => ({
                                ...session,
                                suggestedCode: cleaned,
                            }));
                            try {
                                if (typeof onSuggest === 'function') onSuggest({ completion: cleaned, partial: true, language: normalizedLang, filePath: activeFile?.path || activeFile?.name || null });
                            } catch (e) {}
                        }
                    }
                    if (doneFlag) {
                        finalSuggestion = streamBuffer;
                    }
                }
            }

            const trailingStableText = drainProgressBuffer(true);
            if (trailingStableText) {
                streamBuffer += trailingStableText;
                summaryBuffer += trailingStableText;
            }

            finalSuggestion = streamBuffer;
            // Final pass: extract any remaining progress markers from accumulated text
            const finalProgress = collectProgress(finalSuggestion);
            finalProgress.logs.forEach((p) => appendProgressLog(p));
            finalSuggestion = finalProgress.cleaned;
            const summaryProgress = collectProgress(summaryBuffer);
            summaryProgress.logs.forEach((p) => appendProgressLog(p));
            summaryBuffer = summaryProgress.cleaned;
            onLog?.('Finalizing response');
            if (needsCodeChanges) {
                appendProgressLog('Drafting code changes');
                appendProgressLog('Summarizing changes');
            } else {
                appendProgressLog('Preparing explanation');
            }
            // Mark progress finished before streaming the summary to the bubble
            pushProgress((m) => ({ ...m, status: 'finished' }));

            // After progress is done, stream the summary text only (before FILE sections / code)
            try {
                const markerIdx = (() => {
                    const fileIdx = summaryBuffer.indexOf('FILE:');
                    const codeIdx = summaryBuffer.indexOf('```');
                    if (fileIdx === -1 && codeIdx === -1) return -1;
                    if (fileIdx === -1) return codeIdx;
                    if (codeIdx === -1) return fileIdx;
                    return Math.min(fileIdx, codeIdx);
                })();
                const summaryOnly = markerIdx === -1 ? summaryBuffer : summaryBuffer.slice(0, markerIdx);
                // Only do post-stream chunking for code changes mode
                // In explain mode, we already streamed in real-time
                if (needsCodeChanges && summaryOnly && typeof onChunk === 'function') {
                    const pieces = summaryOnly.split(/(\n{2,})/).filter(Boolean);
                    for (const piece of pieces) {
                        onChunk(piece);
                        await new Promise((resolve) => setTimeout(resolve, 80));
                    }
                }
            } catch (streamErr) {
                appendProgressLog(`Summary stream error: ${streamErr?.message || 'unknown error'}`);
            }
            onDone?.();

            const suggestion = finalSuggestion || summaryBuffer || '';
            const summaryText = (() => {
                const parts = suggestion.split(/FILE:/i);
                const prefix = (parts[0] || '').trim();
                return prefix ? prefix.split('\n').slice(0, 4).join('\n').trim() : '';
            })();

            // IMPORTANT: Skip diff parsing entirely when in explain mode
            // This prevents the explanation text from being treated as code changes
            let multiFileSuggestions = [];
            if (needsCodeChanges) {
                try {
                    multiFileSuggestions = await buildMultiFileSuggestions(suggestion || '');
                    
                    // Validate before displaying to user
                    if (multiFileSuggestions.length > 0) {
                        const validation = validateFileDiffBlocks(multiFileSuggestions.map((s) => ({
                            path: s.path,
                            contentText: s.updatedContent || '',
                            diffText: s.diffText || '',
                        })));
                        
                        if (!validation.isValid && validation.errors.length > 0) {
                            console.warn('[Validation] Multi-file suggestions failed validation:', validation.errors);
                            // Log to user
                            appendProgressLog(`⚠️ Suggestion validation failed: ${validation.errors[0]}`);
                            
                            // Reject bad suggestions - show error instead
                            multiFileSuggestions = [];
                            displayedContent = `⚠️ AI response was malformed or contained contradictory changes:\n${validation.errors.slice(0, 2).join('\n')}\n\nPlease try again or provide more specific instructions.`;
                        } else if (validation.warnings.length > 0) {
                            // Log warnings but allow suggestions to pass
                            validation.warnings.forEach(w => console.warn('[Validation Warning]', w));
                        }
                    }
                } catch (e) {
                    console.error('[buildMultiFileSuggestions]', e);
                    multiFileSuggestions = [];
                }
            }
            const hasMultiFileSuggestions = multiFileSuggestions.length > 0;

            let codeOnly = null;
            let displayedContent = suggestion || 'No response received';
            const isPlaceholderText = (text = '') => {
                const normalized = text.toLowerCase();
                return (
                    normalized.includes('no_changes') ||
                    normalized.includes('no changes') ||
                    normalized.includes('cannot make any changes') ||
                    normalized.includes('need the content') ||
                    normalized.includes('provide the content')
                );
            };

            if (hasMultiFileSuggestions) {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    fileSuggestions: multiFileSuggestions,
                    suggestedCode: null,
                    showDiff: true,
                    suggestionTimestamp: Date.now(),
                }));
                lastSuggestionSnapshotRef.current = {
                    fileSuggestions: multiFileSuggestions,
                    suggestedCode: null,
                    diffChunks: [],
                    timestamp: new Date(),
                };
                try {
                    if (typeof onSuggest === 'function') onSuggest(null);
                } catch (e) {}
                const prefix = summaryText ? `${summaryText}\n\n` : '';
                displayedContent = `${prefix}AI suggested changes for ${multiFileSuggestions.length} file${multiFileSuggestions.length > 1 ? 's' : ''}. Review them below.`;
            } else {
                // Clear any existing suggestions
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    fileSuggestions: [],
                    suggestedCode: null, // Also clear single-file suggestions
                    showDiff: false, // Hide diff view
                    suggestionTimestamp: null,
                }));
                lastSuggestionSnapshotRef.current = null;

                // Only try to extract code if we're in code-change mode
                // For explain mode, just display the response as-is
                if (needsCodeChanges) {
                    codeOnly = extractCodeFromMarkdown(suggestion);
                    const isRawPatch = /(^---\s+a\/.+\n\+\+\+\s+b\/)|(^@@\s+-\d+,?\d*\s+\+\d+,?\d*\s+@@)/m.test(suggestion || '');
                    if (!codeOnly && isRawPatch) {
                        const patched = applyPatch(code, suggestion);
                        if (patched !== false) {
                            codeOnly = patched;
                        }
                    }

                    if (codeOnly && !isPlaceholderText(codeOnly) && !isPlaceholderText(displayedContent)) {
                        displayedContent = summaryText || (suggestion || '').replace(/```[\s\S]*?```/g, '');
                        displayedContent = displayedContent.replace(/<pre[^>]*>[\s\S]*?<code[^>]*>[\s\S]*?<\/code>[\s\S]*?<\/pre>/gi, '');
                        displayedContent = displayedContent.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, '');
                        displayedContent = displayedContent.trim();
                        if (!displayedContent) {
                            displayedContent = 'AI suggested code changes — preview shown below.';
                        }
                    } else {
                        codeOnly = null;
                        if (summaryText) {
                            displayedContent = summaryText;
                        } else if (isPlaceholderText(suggestion || '')) {
                            displayedContent = 'AI could not produce changes for the active file. Please clarify the request or provide file content.';
                        }
                    }
                } else {
                    // Explain mode: just use the full response as display content
                    // Don't try to extract code or create diffs
                    codeOnly = null;
                    displayedContent = suggestion || 'No response received';
                }
            }

            // Drop any pending placeholder suggestions from multi-file results
            if (hasMultiFileSuggestions) {
                const filtered = multiFileSuggestions.filter((sugg) => {
                    const text = sugg.updatedContent || sugg.diffText || '';
                    return !isPlaceholderText(text);
                });
                if (filtered.length !== multiFileSuggestions.length) {
                    mutateSession(activeSession.id, (session) => ({
                        ...session,
                        fileSuggestions: filtered,
                    }));
                }
                if (filtered.length === 0) {
                    displayedContent = 'AI could not produce usable changes. Please provide more context or a specific path.';
                }
            }

            // For code change mode without multi-file suggestions, use summaryText as display
            // For explain mode, keep the full displayedContent (already set above)
            if (!hasMultiFileSuggestions && needsCodeChanges) {
                if (codeOnly) {
                    displayedContent = summaryText || displayedContent;
                } else if (summaryText) {
                    displayedContent = summaryText;
                }
            }
            // In explain mode, displayedContent is already the full response - don't truncate it

            const now = Date.now();
            const messagesToAppend = [{
                id: now + 1,
                role: 'assistant',
                content: displayedContent,
                inlineSummary: true,
                timestamp: new Date(),
            }];

            if (!hasMultiFileSuggestions && codeOnly) {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    suggestedCode: codeOnly,
                    suggestionTimestamp: Date.now(),
                }));
                lastSuggestionSnapshotRef.current = {
                    fileSuggestions: [],
                    suggestedCode: codeOnly,
                    diffChunks: computeDiffChunks(currentCode || '', codeOnly),
                    timestamp: new Date(),
                };
                try {
                    if (typeof onSuggest === 'function') {
                        onSuggest({ completion: codeOnly, language: normalizedLang, filePath: activeFile?.path || activeFile?.name || null });
                    }
                } catch (e) {}
            } else if (!hasMultiFileSuggestions) {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    suggestedCode: null,
                    suggestionTimestamp: null,
                }));
                lastSuggestionSnapshotRef.current = null;
            }

            appendMessagesToSession(activeSession.id, messagesToAppend);
        } catch (error) {
            const aborted = abortController.signal?.aborted;
            if (aborted) {
                onCanceled?.(streamBuffer || '');
                onLog?.('Generation cancelled');
                appendProgressLog('Generation cancelled');
                if (activeSession && streamBuffer) {
                    appendMessagesToSession(activeSession.id, [{
                        id: Date.now() + 1,
                        role: 'assistant',
                        content: streamBuffer,
                        timestamp: new Date(),
                    }]);
                }
            } else {
                onError?.();
                onLog?.(`Generation failed: ${error?.message || 'unknown error'}`);
                appendProgressLog(`Generation failed: ${error?.message || 'unknown error'}`);
                const errorMessage = {
                    id: Date.now() + 1,
                    role: 'assistant',
                    content: 'Generation failed. Try again.',
                    timestamp: new Date(),
                };
                if (activeSession) appendMessagesToSession(activeSession.id, [errorMessage]);
                pushProgress((m) => ({ ...m, status: 'failed' }));
            }
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            setIsLoading(false);
            try { if (typeof onBusy === 'function') onBusy(false); } catch(e){}
        }
    }, [activeSession, activeFile, appendMessagesToSession, archiveCurrentSuggestion, buildMultiFileSuggestions, currentCode, fileCacheEntries, mutateSession, onBusy, onSuggest, aiApiKey, aiModel, buildContextWindow, formatForAPI, getContextDebugInfo, availableTokens, shouldUseAgents, runPipeline, agentMode]);

    const suggestedCode = activeSession?.suggestedCode ?? null;
    const fileSuggestions = activeSession?.fileSuggestions ?? [];

    const diffChunks = useMemo(() => {
        if (!suggestedCode) return [];
        return computeDiffChunks(currentCode || '', suggestedCode);
    }, [currentCode, suggestedCode]);

    return {
        isLoading,
        clientReady,
        fileSuggestions,
        suggestedCode,
        diffChunks,
        handleSendMessage,
        applySuggestion,
        rejectSuggestion,
        handleApplyFileSuggestion,
        handleRejectFileSuggestion,
        handlePreviewFileSuggestion,
        // Agent pipeline
        agentMode,
        setAgentMode,
        activePipeline,
        pipelineHistory,
        cancelPipeline,
        // Context window
        contextWindowInfo: { availableTokens, estimateTokens },
    };
};
