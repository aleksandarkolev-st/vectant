'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { Send, X, Plus } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { getFileLanguage } from '@/utils/fileUtils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { diffLines, applyPatch } from 'diff';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { selectFileCacheEntries, setExternalFileContent, selectFileThunk } from '@/redux/workspaceSlice';
import { buildFilesPayload } from '@/utils/multiFileContext';
import { api } from '@/services/api';

const createChatSession = (index = 1) => ({
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: `Chat ${index}`,
    messages: [],
    suggestedCode: null,
    showDiff: true,
    fileSuggestions: [],
});

const AIChatWindow = ({ onClose, isVisible = true, activeFile, currentCode, editor = null, docked = false, onSuggest = null, onBusy = null, clearSignal = 0 }) => {
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef(null);
    const { askAi, clientReady } = useAnalyzerGateway();
    const sessionCounterRef = useRef(2);
    const initialSessionRef = useRef(createChatSession(1));
    const [chatSessions, setChatSessions] = useState([initialSessionRef.current]);
    const [activeSessionId, setActiveSessionId] = useState(initialSessionRef.current.id);
    const activeSession = chatSessions.find((session) => session.id === activeSessionId) || chatSessions[0] || null;
    const messages = activeSession?.messages ?? [];
    const suggestedCode = activeSession?.suggestedCode ?? null;
    const showDiff = activeSession?.showDiff ?? true;
    const lastClearSignalRef = useRef(clearSignal);
    const dispatch = useAppDispatch();
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);
    const workspaceSlug = useAppSelector((state) => state.workspace.slug);
    const rawFiles = useAppSelector((state) => state.workspace.rawFiles || []);
    const cachedFileMap = useMemo(() => new Map(fileCacheEntries), [fileCacheEntries]);
    const fileSuggestions = activeSession?.fileSuggestions ?? [];
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
        // Prefer the shortest match if multiple hit the suffix
        if (matches.length > 1) {
            return matches.reduce((shortest, current) =>
                current.length < shortest.length ? current : shortest,
            matches[0]);
        }
        return null;
    }, [flattenWorkspaceFiles]);

    const renderDiffChunkList = (chunks = []) => {
        if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
            return <div className="px-1 text-gray-500">No changes detected.</div>;
        }
        return chunks.map((chunk, ci) => {
            if (chunk.type === 'eq') {
                return chunk.items.map((row) => (
                    <div key={`eq-${row.lineOld}-${row.lineNew}-${ci}`} className="px-1 text-gray-400 flex gap-2">
                        <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                        <div className="flex-1 break-words">{row.text}</div>
                    </div>
                ));
            }
            if (chunk.type === 'eq-elide') {
                return (
                    <div key={`elide-${ci}`}>
                        {chunk.head.map((row) => (
                            <div key={`head-${row.lineNew}-${ci}`} className="px-1 text-gray-400 flex gap-2">
                                <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                                <div className="flex-1 break-words">{row.text}</div>
                            </div>
                        ))}
                        <div className="px-1 text-gray-500 text-center">... {chunk.elidedCount} unchanged lines ...</div>
                        {chunk.tail.map((row) => (
                            <div key={`tail-${row.lineNew}-${ci}`} className="px-1 text-gray-400 flex gap-2">
                                <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                                <div className="flex-1 break-words">{row.text}</div>
                            </div>
                        ))}
                    </div>
                );
            }
            if (chunk.type === 'add') {
                return chunk.items.map((row) => (
                    <div key={`add-${row.lineNew}-${ci}`} className="px-1 flex gap-2 text-emerald-300 bg-emerald-900/5">
                        <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                        <div className="flex-1 break-words">+ {row.text}</div>
                    </div>
                ));
            }
            if (chunk.type === 'rem') {
                return chunk.items.map((row) => (
                    <div key={`rem-${row.lineOld}-${ci}`} className="px-1 flex gap-2 text-rose-300 bg-rose-900/5">
                        <div className="w-10 text-right text-[11px] text-gray-500">{row.lineOld}</div>
                        <div className="flex-1 break-words">- {row.text}</div>
                    </div>
                ));
            }
            return null;
        });
    };

    const fileSuggestionStatusClasses = (status) => {
        switch (status) {
            case 'saving':
                return 'text-amber-200 bg-amber-500/10 border border-amber-500/40';
            case 'applied':
                return 'text-emerald-200 bg-emerald-500/10 border border-emerald-500/40';
            case 'rejected':
                return 'text-gray-300 bg-gray-600/10 border border-gray-500/30';
            case 'error':
                return 'text-rose-200 bg-rose-500/10 border border-rose-500/40';
            default:
                return 'text-amber-200 bg-amber-500/10 border border-amber-500/40';
        }
    };

    const fileSuggestionStatusLabel = (status) => {
        switch (status) {
            case 'saving':
                return 'Saving...';
            case 'applied':
                return 'Applied';
            case 'rejected':
                return 'Dismissed';
            case 'error':
                return 'Error';
            default:
                return 'Pending';
        }
    };

    const mutateSession = (sessionId, mutator) => {
        setChatSessions((prev) =>
            prev.map((session) => {
                if (session.id !== sessionId) return session;
                return mutator(session);
            })
        );
    };

    const appendMessagesToSession = (sessionId, newMessages) => {
        mutateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages, ...newMessages],
        }));
    };

    const handleNewSession = () => {
        const newSession = createChatSession(sessionCounterRef.current);
        sessionCounterRef.current += 1;
        setChatSessions((prev) => [...prev, newSession]);
        setActiveSessionId(newSession.id);
    };

    const handleCloseSession = (sessionId) => {
        if (chatSessions.length <= 1) return;
        setChatSessions((prev) => {
            const filtered = prev.filter((session) => session.id !== sessionId);
            if (activeSessionId === sessionId) {
                const fallback = filtered[filtered.length - 1]?.id ?? filtered[0]?.id ?? null;
                setActiveSessionId(fallback);
            }
            return filtered.length ? filtered : [createChatSession(1)];
        });
    };

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        if (scrollRef.current) {
            const scrollArea = scrollRef.current.querySelector('[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]');
            if (scrollArea) {
                scrollArea.scrollTop = scrollArea.scrollHeight;
            }
        }
    }, [messages, suggestedCode, fileSuggestions]);

    useEffect(() => {
        if (clearSignal === lastClearSignalRef.current) return;
        lastClearSignalRef.current = clearSignal;
        // If upstream clears completions, wipe suggestions for the active session and inform parent
        mutateSession(activeSessionId, (session) => ({
            ...session,
            suggestedCode: null,
            fileSuggestions: [],
            showDiff: false,
        }));
        try {
            if (typeof onSuggest === 'function') onSuggest(null);
        } catch (e) {}
    }, [clearSignal, activeSessionId, mutateSession, onSuggest]);

    const extractCodeFromMarkdown = (text) => {
        if (!text) return null;
        // 1) fenced code block
        const fenceRe = /```(?:\w+)?\n([\s\S]*?)```/m;
        let m = text.match(fenceRe);
        if (m && m[1]) return m[1].replace(/\r/g, '');

        // 2) <pre><code>...</code></pre> or <code>...</code>
        const preCodeRe = /<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/i;
        m = text.match(preCodeRe);
        if (m && m[1]) return m[1].replace(/\r/g, '');

        const codeTagRe = /<code[^>]*>([\s\S]*?)<\/code>/i;
        m = text.match(codeTagRe);
        if (m && m[1]) return m[1].replace(/\r/g, '');

        // 3) fallback: if the whole message looks like plain code, return it
        if (!/[<>]/.test(text) && text.split('\n').length > 3) return text.replace(/\r/g, '');

        return null;
    };

    // Compute a compact diff with line numbers and collapsed equal blocks using `diff`.
const computeDiffChunks = (oldStr = '', newStr = '') => {
        const parts = diffLines(oldStr, newStr);
        const rows = [];
        let oldLine = 1;
        let newLine = 1;

        parts.forEach((part) => {
            // Split into lines and drop a final empty line caused by trailing newline
            const lines = part.value.split('\n');
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

            lines.forEach((line) => {
                if (part.added) {
                    rows.push({ type: 'add', lineNew: newLine, text: line });
                    newLine++;
                } else if (part.removed) {
                    rows.push({ type: 'rem', lineOld: oldLine, text: line });
                    oldLine++;
                } else {
                    rows.push({ type: 'eq', lineOld: oldLine, lineNew: newLine, text: line });
                    oldLine++;
                    newLine++;
                }
            });
        });

        // Collapse long equal sequences into elided chunks for readability
        const chunks = [];
        let i = 0;
        while (i < rows.length) {
            if (rows[i].type !== 'eq') {
                chunks.push({ type: rows[i].type, items: [rows[i]] });
                i++;
                continue;
            }

            const start = i;
            while (i < rows.length && rows[i].type === 'eq') i++;
            const items = rows.slice(start, i);
            const count = items.length;
            if (count > 8) {
                const head = items.slice(0, 2);
                const tail = items.slice(-2);
                chunks.push({ type: 'eq-elide', head, tail, elidedCount: count - 4 });
            } else {
                chunks.push({ type: 'eq', items });
            }
        }

    return chunks;
};

const stripDiffMarkers = (text = '') => {
    if (!text) return '';
    return text
        .split('\n')
        .filter((line) => !/^@@\s|^---\s|^\+\+\+\s/.test(line))
        .map((line) => line.replace(/^[+-]/, ''))
        .join('\n')
        .trimEnd();
};

const parseFileDiffBlocks = (text = '', fallbackPath = null) => {
    if (!text) return [];
    const blocks = [];
    const segments = text.split(/(?=FILE:\s*)/i);
    for (const segment of segments) {
        if (!segment.trim().startsWith('FILE:')) continue;
        const headerMatch = segment.match(/^FILE:\s*([^\n]+)\s*(?:\nLINES:[^\n]*\s*)?/i);
        if (!headerMatch) continue;
        const path = headerMatch[1]?.trim();
        if (!path) continue;
        let body = segment.slice(headerMatch[0].length).trim();
        if (!body) continue;
        const raw = stripFence(body).trim();
        if (!raw) continue;
        const normalized = raw.replace(/\r\n/g, '\n').trim();
        const looksLikeDiff = /^---\s+/m.test(normalized) && /^\+\+\+\s+/m.test(normalized) && /@@\s+/m.test(normalized);
        blocks.push({
            path,
            diffText: looksLikeDiff ? normalized : null,
            contentText: looksLikeDiff ? null : normalized,
            isValidDiff: looksLikeDiff || Boolean(normalized),
        });
    }
    if (!blocks.length && fallbackPath) {
        const raw = stripFence(text).replace(/\r\n/g, '\n').trim();
        const looksLikeDiff = /^---\s+/m.test(raw) && /^\+\+\+\s+/m.test(raw) && /@@\s+/m.test(raw);
        blocks.push({
            path: fallbackPath,
            diffText: looksLikeDiff ? raw : null,
            contentText: looksLikeDiff ? null : raw,
            isValidDiff: looksLikeDiff || Boolean(raw),
        });
    }
    return blocks;
};

    const getBaseContentForPath = async (targetPath) => {
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
    };

    const buildMultiFileSuggestions = async (rawText) => {
        const fallbackPath = activeFile?.path || activeFile?.name || null;
        const blocks = parseFileDiffBlocks(rawText, fallbackPath);
        if (!blocks.length) return [];
        const hydrated = [];
        for (const block of blocks) {
            const resolvedPath = resolveWorkspacePath(block.path) || block.path;
            const baseContent = await getBaseContentForPath(resolvedPath);
            const baseIsMissing = typeof baseContent !== 'string';
            const currentContent = baseIsMissing ? '' : baseContent;

            // If the model returned full content instead of a diff, accept it.
            if (block.contentText && !block.diffText) {
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
    };

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

    const applyContentToPath = (path, newContent, { skipSave = false } = {}) => {
        if (!path || typeof newContent !== 'string') return;
        const resolvedPath = resolveWorkspacePath(path) || path;
        if (activeFile?.path === resolvedPath && editor && typeof editor.setValue === 'function') {
            editor.setValue(newContent);
        }
        dispatch(setExternalFileContent({ path: resolvedPath, content: newContent }));
        return { resolvedPath, saved: !skipSave };
    };

    const handleApplyFileSuggestion = async (sessionId, path) => {
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
    };

    const handleRejectFileSuggestion = (sessionId, path) => {
        if (!path) return;
        mutateSession(sessionId, (s) => ({
            ...s,
            fileSuggestions: s.fileSuggestions.map((fs) =>
                fs.path === path ? { ...fs, status: 'rejected' } : fs
            ),
        }));
    };

    const handlePreviewFileSuggestion = async (sessionId, path) => {
        if (!path || typeof onSuggest !== 'function') return;
        const session = chatSessions.find((s) => s.id === sessionId);
        const suggestion = session?.fileSuggestions?.find((fs) => fs.path === path);
        if (!suggestion || suggestion.status === 'error') return;
        const targetPath = suggestion.resolvedPath || resolveWorkspacePath(path) || path;
        await openFileByPath(targetPath);
        onSuggest({ completion: suggestion.updatedContent || '', filePath: targetPath });
    };

    const handleSendMessage = async () => {
        if (!inputValue.trim()) return;

        if (!activeSession) return;

        const userMessage = {
            id: Date.now(),
            role: 'user',
            content: inputValue,
            timestamp: new Date(),
        };

        appendMessagesToSession(activeSession.id, [userMessage]);
        setInputValue('');
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

Start with a brief (3-4 sentences) summary of the change. After the summary, return one or more sections in this exact format:
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
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    };

    const applySuggestion = () => {
        if (!activeSession || !suggestedCode) return;
        if (editor && typeof editor.setValue === 'function') {
            editor.setValue(suggestedCode);
        }
        // Clear suggestion after applying
        mutateSession(activeSession.id, (session) => ({
            ...session,
            suggestedCode: null,
            showDiff: false,
        }));
        try {
            if (typeof onSuggest === 'function') onSuggest(null);
        } catch (e) {}
        // Add a small assistant confirmation message
        appendMessagesToSession(activeSession.id, [{ id: Date.now(), role: 'assistant', content: 'Suggestion applied to editor.', timestamp: new Date() }]);
    };

    const rejectSuggestion = () => {
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
    };

    const formatMessageContent = (content) => {
        // We deliberately do not insert zero-width spaces around angle brackets
        // to avoid breaking HTML tags that the model may return. We still
        // transform simple markdown-like emphasis and inline code to HTML.
        if (!content) return '';
        // Remove markdown headings like `###` because we don't have a full
        // markdown renderer and headers can produce odd output.
        const cleaned = content.replace(/^#{1,6}\s+/gm, '');

        const html = cleaned
            .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>')
            .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
            .replace(/`([^`]+)`/g, '<code class="bg-[#3a3a3d] px-1 rounded text-xs">$1</code>')
            .replace(/\n/g, '<br />');

        // Sanitize HTML to avoid XSS while allowing basic formatting and code blocks
        try {
            return DOMPurify.sanitize(html, {
                ALLOWED_TAGS: ['strong', 'em', 'code', 'pre', 'br', 'div', 'span', 'p', 'ul', 'ol', 'li'],
                ALLOWED_ATTR: ['class']
            });
        } catch (e) {
            return html;
        }
    };

    if (!isVisible) return null;

    const diffChunks = suggestedCode ? computeDiffChunks(currentCode || '', suggestedCode) : [];

    // Choose container classes based on docked/inline mode
    const containerClass = docked
        ? 'h-full w-full bg-transparent flex flex-col min-h-0'
        : 'fixed top-10 right-0 bottom-0 w-96 bg-[#1e1e1e] border-l border-[#545454] rounded-l-lg shadow-2xl flex flex-col min-h-0 z-40';

    return (
        <div className={containerClass}>
            {/* Header */}
            <div className="flex flex-col border-b border-[#545454] bg-[#252526]">
                <div className="flex items-center justify-between px-4 py-3">
                    <h2 className="text-sm font-semibold text-gray-200">AI Assistant</h2>
                    <div className="flex items-center gap-2">
                        {(suggestedCode || fileSuggestions.length > 0) && (
                            <div className="text-xs text-gray-300">
                                {fileSuggestions.length > 0 ? `${fileSuggestions.length} file${fileSuggestions.length > 1 ? 's' : ''} ready` : 'Suggestion ready'}
                            </div>
                        )}
                        <button
                            onClick={onClose}
                            className="p-1 hover:bg-[#3e3e42] rounded transition-colors"
                            title="Close chat"
                        >
                            <X className="w-4 h-4 text-gray-400" />
                        </button>
                    </div>
                </div>
                <div className="px-3 pb-2 flex items-center gap-2 overflow-x-auto">
                    {chatSessions.map((session) => {
                        const isActive = session.id === activeSession?.id;
                        return (
                            <button
                                key={session.id}
                                onClick={() => setActiveSessionId(session.id)}
                                className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs border transition-colors ${
                                    isActive
                                        ? 'bg-emerald-600/15 border-emerald-500 text-emerald-200'
                                        : 'bg-[#1e1e1e] border-[#2f2f2f] text-gray-400 hover:text-gray-200'
                                }`}
                            >
                                <span className="truncate max-w-[120px]">{session.title}</span>
                                {chatSessions.length > 1 && (
                                    <X
                                        className="w-3 h-3 text-gray-400 hover:text-gray-200"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleCloseSession(session.id);
                                        }}
                                    />
                                )}
                            </button>
                        );
                    })}
                    <button
                        onClick={handleNewSession}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-dashed border-[#3a3a3a] text-gray-300 hover:border-emerald-500 hover:text-emerald-200 transition-colors"
                        title="Start a new chat"
                    >
                        <Plus className="w-3 h-3" />
                        New
                    </button>
                </div>
            </div>

            {/* Messages Area */}
            <ScrollArea ref={scrollRef} className="flex-1 px-4 py-2 min-h-0">
                <div className="space-y-3">
                    {messages.length === 0 ? (
                        <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
                            <p>Start a conversation with the AI assistant</p>
                        </div>
                    ) : (
                        messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                            >
                                <div
                                    className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                                        msg.role === 'user'
                                            ? 'bg-emerald-600 text-white'
                                            : 'bg-[#2d2d30] text-gray-200 border border-[#454545]'
                                    }`}
                                >
                                    <div 
                                        className="break-all whitespace-pre-wrap text-xs leading-relaxed"
                                        dangerouslySetInnerHTML={{ __html: formatMessageContent(msg.content) }}
                                    />
                                    <span className="text-xs opacity-70 mt-1 block">
                                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            </div>
                        ))
                    )}
                    {isLoading && (
                        <div className="flex justify-start">
                            <div className="bg-[#2d2d30] border border-[#454545] px-3 py-2 rounded-lg">
                                <div className="flex space-x-2">
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse"></div>
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-100"></div>
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-200"></div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Suggested code preview + diff controls */}
                    {fileSuggestions.length > 0 ? (
                        <div className="space-y-3">
                            {fileSuggestions.map((suggestion) => (
                                <div key={suggestion.path} className="px-3 py-3 bg-[#171717] border border-[#3a3a3a] rounded">
                                    <div className="flex items-center justify-between gap-2 mb-3">
                                        <div>
                                            <div className="text-sm font-medium text-gray-100 break-all">{suggestion.path}</div>
                                            <div className={`inline-flex mt-1 px-2 py-0.5 rounded-full text-[11px] ${fileSuggestionStatusClasses(suggestion.status)}`}>
                                                {fileSuggestionStatusLabel(suggestion.status)}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                disabled={Boolean(suggestion.error)}
                                                onClick={() => handlePreviewFileSuggestion(activeSession.id, suggestion.path)}
                                            >
                                                Preview
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={suggestion.status !== 'pending'}
                                                onClick={() => handleRejectFileSuggestion(activeSession.id, suggestion.path)}
                                            >
                                                Reject
                                            </Button>
                                            <Button
                                                variant="default"
                                                size="sm"
                                                disabled={suggestion.status !== 'pending' || Boolean(suggestion.error)}
                                                onClick={() => handleApplyFileSuggestion(activeSession.id, suggestion.path)}
                                            >
                                                Apply
                                            </Button>
                                        </div>
                                    </div>
                                    {suggestion.error ? (
                                        <div className="text-sm text-rose-300 bg-rose-500/5 border border-rose-500/40 px-3 py-2 rounded">
                                            {suggestion.error}
                                        </div>
                                    ) : (
                                        <div className="max-h-[55vh] overflow-auto text-xs font-mono bg-[#0f0f10] rounded p-2">
                                            {renderDiffChunkList(suggestion.chunks)}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : suggestedCode && (
                        <div className="px-2 py-2 bg-[#171717] border border-[#3a3a3a] rounded">
                            <div className="flex items-center justify-between mb-2">
                                <div className="text-sm font-medium text-gray-200">Suggestion</div>
                                <div className="flex items-center gap-2">
                                    {isLoading ? (
                                        <div className="flex items-center gap-2 text-xs text-gray-300">
                                            <div className="w-3 h-3 rounded-full bg-gray-400 animate-pulse" aria-hidden></div>
                                            <span>Thinking...</span>
                                        </div>
                                    ) : null}
                                    <Button variant="secondary" size="sm" onClick={rejectSuggestion}>Reject</Button>
                                    <Button variant="default" size="sm" onClick={applySuggestion}>Accept</Button>
                                </div>
                            </div>

                            <div className="max-h-[55vh] overflow-auto text-xs font-mono">
                                {renderDiffChunkList(diffChunks)}
                            </div>
                        </div>
                    )}
                </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="px-4 py-3 border-t border-[#545454] bg-[#252526]">
                <div className="flex gap-2">
                    <Input
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="Ask AI for suggestions... (Enter to send)"
                        disabled={isLoading || !clientReady}
                        className="flex-1"
                    />
                    <Button
                        onClick={handleSendMessage}
                        disabled={!inputValue.trim() || isLoading || !clientReady}
                        title="Send message (Enter)"
                    >
                        <Send className="w-4 h-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default AIChatWindow;
