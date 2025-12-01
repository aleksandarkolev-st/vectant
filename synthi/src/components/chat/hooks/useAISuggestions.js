import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyPatch } from 'diff';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { getFileLanguage } from '@/utils/fileUtils';
import { buildFilesPayload } from '@/utils/multiFileContext';
import { api } from '@/services/api';
import { computeDiffChunks, parseFileDiffBlocks, stripDiffMarkers } from '../utils/diffUtils';
import { selectFileThunk, setExternalFileContent } from '@/redux/workspaceSlice';

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
}) => {
    const { askAi, clientReady } = useAnalyzerGateway();
    const [isLoading, setIsLoading] = useState(false);
    const lastClearSignalRef = useRef(clearSignal);
    const cachedFileMap = useMemo(() => new Map(fileCacheEntries), [fileCacheEntries]);

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

    const resolveWorkspacePath = useCallback((inputPath) => {
        if (!inputPath) return null;
        const normalized = inputPath.replace(/^\.\/+/, '').trim();
        if (!normalized) return null;
        if (flattenWorkspaceFiles.includes(normalized)) {
            return normalized;
        }
        const matches = flattenWorkspaceFiles.filter((p) => p.endsWith(normalized));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
            return matches.reduce((shortest, current) =>
                current.length < shortest.length ? current : shortest,
            matches[0]);
        }
        return null;
    }, [flattenWorkspaceFiles]);

    useEffect(() => {
        if (!activeSession) return;
        if (clearSignal === lastClearSignalRef.current) return;
        lastClearSignalRef.current = clearSignal;
        resetSuggestionsForSession(activeSession.id);
        try {
            if (typeof onSuggest === 'function') onSuggest(null);
        } catch (e) {}
    }, [activeSession, clearSignal, onSuggest, resetSuggestionsForSession]);

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
                console.error('Failed to load file content for AI suggestion', err);
            }
        }
        return null;
    }, [activeFile?.path, cachedFileMap, currentCode, editor, resolveWorkspacePath, workspaceSlug]);

    const buildMultiFileSuggestions = useCallback(async (rawText) => {
        const fallbackPath = activeFile?.path || activeFile?.name || null;
        const blocks = parseFileDiffBlocks(rawText, fallbackPath);
        if (!blocks.length) return [];
        const hydrated = [];
        const isNoChangeText = (contentText = '') => {
            const firstLine = (contentText || '').split('\n')[0].trim().toUpperCase();
            return firstLine.startsWith('NO_CHANGES') || firstLine.startsWith('NO CHANGES') || firstLine.startsWith('NO CHANGE');
        };
        for (const block of blocks) {
            const resolvedPath = resolveWorkspacePath(block.path) || block.path;
            const baseContent = await getBaseContentForPath(resolvedPath);
            const baseIsMissing = typeof baseContent !== 'string';
            const currentContent = baseIsMissing ? '' : baseContent;

            if (block.contentText && !block.diffText) {
                if (isNoChangeText(block.contentText)) {
                    continue;
                }
                hydrated.push({
                    path: block.path,
                    resolvedPath,
                    diffText: null,
                    originalContent: currentContent,
                    updatedContent: block.contentText,
                    isNewFile: baseIsMissing,
                    chunks: computeDiffChunks(currentContent, block.contentText),
                    status: 'pending',
                });
                continue;
            }

            if (!block.isValidDiff || !block.diffText) {
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
            hydrated.push({
                path: block.path,
                resolvedPath,
                diffText: block.diffText,
                originalContent: currentContent,
                updatedContent: patched,
                isNewFile: baseIsMissing,
                chunks: computeDiffChunks(currentContent, patched),
                status: 'pending',
            });
        }
        return hydrated;
    }, [activeFile?.name, activeFile?.path, getBaseContentForPath, resolveWorkspacePath]);

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

    const applyContentToPath = useCallback((path, newContent, { skipSave = false } = {}) => {
        if (!path || typeof newContent !== 'string') return;
        const resolvedPath = resolveWorkspacePath(path) || path;
        if (activeFile?.path === resolvedPath && editor && typeof editor.setValue === 'function') {
            editor.setValue(newContent);
        }
        dispatch(setExternalFileContent({ path: resolvedPath, content: newContent }));
        return { resolvedPath, saved: !skipSave };
    }, [activeFile?.path, dispatch, editor, resolveWorkspacePath]);

    const handleApplyFileSuggestion = useCallback(async (sessionId, path) => {
        if (!path) return;
        const session = chatSessions.find((s) => s.id === sessionId);
        const suggestion = session?.fileSuggestions?.find((fs) => fs.path === path);
        if (!suggestion || suggestion.status !== 'pending') return;
        if (!suggestion.updatedContent) {
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
            await openFileByPath(targetPath);
            applyContentToPath(targetPath, suggestion.updatedContent, { skipSave: suggestion.isNewFile });
            if (workspaceSlug && !suggestion.isNewFile) {
                const fileName = targetPath.split('/').pop() || 'file.txt';
                await api.saveFileContent(workspaceSlug, targetPath, suggestion.updatedContent, fileName);
            }
            mutateSession(sessionId, (s) => ({
                ...s,
                fileSuggestions: s.fileSuggestions.map((fs) =>
                    fs.path === path ? { ...fs, status: 'applied', error: null } : fs
                ),
            }));
        } catch (error) {
            mutateSession(sessionId, (s) => ({
                ...s,
                fileSuggestions: s.fileSuggestions.map((fs) =>
                    fs.path === path ? { ...fs, status: 'error', error: error.message || 'Failed to save changes.' } : fs
                ),
            }));
        }
    }, [applyContentToPath, chatSessions, mutateSession, openFileByPath, resolveWorkspacePath, workspaceSlug]);

    const handleRejectFileSuggestion = useCallback((sessionId, path) => {
        if (!path) return;
        mutateSession(sessionId, (s) => ({
            ...s,
            fileSuggestions: s.fileSuggestions.map((fs) =>
                fs.path === path ? { ...fs, status: 'rejected' } : fs
            ),
        }));
    }, [mutateSession]);

    const handlePreviewFileSuggestion = useCallback(async (sessionId, path) => {
        if (!path || typeof onSuggest !== 'function') return;
        const session = chatSessions.find((s) => s.id === sessionId);
        const suggestion = session?.fileSuggestions?.find((fs) => fs.path === path);
        if (!suggestion || suggestion.status === 'error') return;
        const targetPath = suggestion.resolvedPath || resolveWorkspacePath(path) || path;
        await openFileByPath(targetPath);
        onSuggest({ completion: suggestion.updatedContent || '', filePath: targetPath });
    }, [chatSessions, onSuggest, openFileByPath, resolveWorkspacePath]);

    const applySuggestion = useCallback(() => {
        if (!activeSession || !activeSession.suggestedCode) return;
        const suggestedCode = activeSession.suggestedCode;
        if (editor && typeof editor.setValue === 'function') {
            editor.setValue(suggestedCode);
        }
        mutateSession(activeSession.id, (session) => ({
            ...session,
            suggestedCode: null,
            showDiff: false,
        }));
        try {
            if (typeof onSuggest === 'function') onSuggest(null);
        } catch (e) {}
        appendMessagesToSession(activeSession.id, [{ id: Date.now(), role: 'assistant', content: 'Suggestion applied to editor.', timestamp: new Date() }]);
    }, [activeSession, appendMessagesToSession, editor, mutateSession, onSuggest]);

    const rejectSuggestion = useCallback(() => {
        if (!activeSession) return;
        mutateSession(activeSession.id, (session) => ({
            ...session,
            suggestedCode: null,
            showDiff: false,
        }));
        try {
            if (typeof onSuggest === 'function') onSuggest(null);
        } catch (e) {}
        appendMessagesToSession(activeSession.id, [{ id: Date.now(), role: 'assistant', content: 'Suggestion rejected.', timestamp: new Date() }]);
    }, [activeSession, appendMessagesToSession, mutateSession, onSuggest]);

    const handleSendMessage = useCallback(async (inputValue) => {
        if (!inputValue?.trim()) return;
        if (!activeSession) return;

        const userMessage = {
            id: Date.now(),
            role: 'user',
            content: inputValue,
            timestamp: new Date(),
        };

        appendMessagesToSession(activeSession.id, [userMessage]);
        setIsLoading(true);

        try {
            const langSource =
                activeFile?.language ||
                (activeFile?.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = (langSource || 'plaintext').toLowerCase();
            const code = currentCode || '';
            const userPrompt = inputValue;
            let patchRequest = `${userPrompt}

Only modify the file(s) explicitly mentioned or the active file. Do not add new files unless explicitly asked.

Start with a brief (6-7 sentences) summary of the change. After the summary, return one or more sections in this exact format:
FILE: <path>
\`\`\`
<full updated file content only; no diff markers, no +/-, no @@, no ---/+++>
\`\`\`

Do not include any other commentary. Preserve all code outside the requested change. Do not add speculative comments or boilerplate. If unclear, return FILE: <path> then NO_CHANGES and a brief clarifying question.`;
            const filesPayloadRaw = buildFilesPayload({
                activeFile,
                fullDocument: code,
                cacheEntries: fileCacheEntries,
            });
            const mentionsOtherFile = /\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,5}\b/.test(userPrompt) || /other file|another file|files/i.test(userPrompt);
            const filesPayload = mentionsOtherFile
                ? filesPayloadRaw
                : filesPayloadRaw.filter((f) => f.path === (activeFile?.path || activeFile?.name));
            if (filesPayload.length > 1 || mentionsOtherFile) {
                patchRequest = `${patchRequest}\n\nAdditional workspace files are attached. Reference them by their path when relevant.`;
            }

            try { if (typeof onBusy === 'function') onBusy(true); } catch (e) {}

            let streamBuffer = '';
            let finalSuggestion = '';

            const response = await askAi({
                lang: normalizedLang,
                code,
                prompt: patchRequest,
                mode: 'patch',
                files: filesPayload,
                focusPath: activeFile?.path || activeFile?.name || null,
                onProgress: (data) => {
                    const chunk = typeof data === 'string' ? data : (data?.partial ?? '');
                    const isFinal = typeof data === 'object' ? Boolean(data.final) : false;
                    if (chunk) {
                        streamBuffer += chunk;

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

                    if (isFinal) {
                        finalSuggestion = streamBuffer;
                    }
                }
            });

            const suggestion = response?.ai_suggestion || response?.suggestion || finalSuggestion || '';
            const summaryText = (() => {
                const parts = suggestion.split(/FILE:/i);
                const prefix = (parts[0] || '').trim();
                return prefix ? prefix.split('\n').slice(0, 4).join('\n').trim() : '';
            })();

            let multiFileSuggestions = [];
            try {
                multiFileSuggestions = await buildMultiFileSuggestions(suggestion || '');
            } catch (e) {
                multiFileSuggestions = [];
            }
            const hasMultiFileSuggestions = multiFileSuggestions.length > 0;

            let codeOnly = null;
            let displayedContent = suggestion || 'No response received';

            if (hasMultiFileSuggestions) {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    fileSuggestions: multiFileSuggestions,
                    suggestedCode: null,
                    showDiff: true,
                }));
                try {
                    if (typeof onSuggest === 'function') onSuggest(null);
                } catch (e) {}
                const prefix = summaryText ? `${summaryText}\n\n` : '';
                displayedContent = `${prefix}AI suggested changes for ${multiFileSuggestions.length} file${multiFileSuggestions.length > 1 ? 's' : ''}. Review them below.`;
            } else {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    fileSuggestions: [],
                }));

                codeOnly = extractCodeFromMarkdown(suggestion);
                const isRawPatch = /(^---\s+a\/.+\n\+\+\+\s+b\/)|(^@@\s+-\d+,?\d*\s+\+\d+,?\d*\s+@@)/m.test(suggestion || '');
                if (!codeOnly && isRawPatch) {
                    const patched = applyPatch(code, suggestion);
                    if (patched !== false) {
                        codeOnly = patched;
                    }
                }

                if (codeOnly) {
                    displayedContent = summaryText || (suggestion || '').replace(/```[\s\S]*?```/g, '');
                    displayedContent = displayedContent.replace(/<pre[^>]*>[\s\S]*?<code[^>]*>[\s\S]*?<\/code>[\s\S]*?<\/pre>/gi, '');
                    displayedContent = displayedContent.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, '');
                    displayedContent = displayedContent.trim();
                    if (!displayedContent) {
                        displayedContent = 'AI suggested code changes — preview shown below.';
                    }
                } else if (summaryText) {
                    displayedContent = summaryText;
                }
            }

            const now = Date.now();
            const messagesToAppend = [{
                id: now + 1,
                role: 'assistant',
                content: displayedContent,
                timestamp: new Date(),
            }];

            if (!hasMultiFileSuggestions && codeOnly) {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    suggestedCode: codeOnly,
                }));
                try {
                    if (typeof onSuggest === 'function') {
                        onSuggest({ completion: codeOnly, language: normalizedLang, filePath: activeFile?.path || activeFile?.name || null });
                    }
                } catch (e) {}
            } else if (!hasMultiFileSuggestions) {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    suggestedCode: null,
                }));
            }

            appendMessagesToSession(activeSession.id, messagesToAppend);
        } catch (error) {
            const errorMessage = {
                id: Date.now() + 1,
                role: 'assistant',
                content: `Error: ${error.message || 'Failed to get AI response. Make sure the backend is running.'}`,
                timestamp: new Date(),
            };
            if (activeSession) appendMessagesToSession(activeSession.id, [errorMessage]);
        } finally {
            setIsLoading(false);
            try { if (typeof onBusy === 'function') onBusy(false); } catch(e){}
        }
    }, [activeSession, activeFile, appendMessagesToSession, askAi, buildMultiFileSuggestions, currentCode, fileCacheEntries, mutateSession, onBusy, onSuggest]);

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
    };
};
