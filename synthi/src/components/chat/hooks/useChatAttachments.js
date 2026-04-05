import { useCallback, useState } from 'react';

const MAX_INLINE_BYTES = 120 * 1024; // keep payloads small to avoid gateway timeouts

export const useChatAttachments = (options = {}) => {
    const { fileCacheEntries = [], getFileCacheEntries = null, rawFiles = [] } = options;
    const [attachments, setAttachments] = useState([]);
    const [isDragging, setIsDragging] = useState(false);

    const getCachedFileMap = useCallback(() => {
        const entries = typeof getFileCacheEntries === 'function' ? getFileCacheEntries() : fileCacheEntries;
        return new Map(entries || []);
    }, [fileCacheEntries, getFileCacheEntries]);

    // Recursively collect all files from a folder node
    const collectFilesFromFolder = useCallback((folderNode, collected = []) => {
        if (!folderNode) return collected;
        if (!folderNode.isFolder) {
            collected.push(folderNode);
            return collected;
        }
        if (Array.isArray(folderNode.children)) {
            for (const child of folderNode.children) {
                collectFilesFromFolder(child, collected);
            }
        }
        return collected;
    }, []);

    // Find a node in the file tree by path
    const findNodeByPath = useCallback((nodes, targetPath) => {
        for (const node of nodes) {
            if (node.path === targetPath) return node;
            if (node.isFolder && node.children) {
                const found = findNodeByPath(node.children, targetPath);
                if (found) return found;
            }
        }
        return null;
    }, []);

    // Add workspace files as attachments
    const addWorkspaceFiles = useCallback((filePaths) => {
        const cachedFileMap = getCachedFileMap();
        const newAttachments = [];
        
        for (const path of filePaths) {
            const node = findNodeByPath(rawFiles, path);
            if (!node) continue;
            
            // If it's a folder, collect all files within
            const filesToAdd = node.isFolder ? collectFilesFromFolder(node) : [node];
            
            for (const fileNode of filesToAdd) {
                const content = cachedFileMap.get(fileNode.path);
                const isText = /\.(txt|md|js|ts|tsx|jsx|json|py|rb|go|rs|java|cpp|c|h|hpp|cs|php|html|css|scss|yaml|yml|toml|xml|sql|sh|bash|zsh|ps1)$/i.test(fileNode.name);
                
                if (content && isText) {
                    const truncated = content.length > MAX_INLINE_BYTES 
                        ? content.slice(0, MAX_INLINE_BYTES) + '\n\n... [truncated]' 
                        : content;
                    newAttachments.push({
                        id: `ws-${fileNode.path}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                        name: fileNode.name,
                        path: fileNode.path,
                        size: content.length,
                        type: 'text/plain',
                        content: truncated,
                        kind: 'text',
                        isWorkspaceFile: true,
                    });
                } else if (isText) {
                    // File not cached, add as reference
                    newAttachments.push({
                        id: `ws-ref-${fileNode.path}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                        name: fileNode.name,
                        path: fileNode.path,
                        size: 0,
                        type: 'text/plain',
                        content: `[File: ${fileNode.path}]`,
                        kind: 'text',
                        isWorkspaceFile: true,
                        notCached: true,
                    });
                }
            }
        }
        
        if (newAttachments.length) {
            setAttachments((prev) => [...prev, ...newAttachments]);
        }
        return newAttachments.length;
    }, [collectFilesFromFolder, findNodeByPath, getCachedFileMap, rawFiles]);

    const handleFilesSelected = useCallback((files) => {
        if (!files || !files.length) return;
        const readPromises = Array.from(files).map((file) => new Promise((resolve) => {
            const reader = new FileReader();
            const isText = file.type.startsWith('text/') || /\.(txt|md|js|ts|tsx|jsx|json|py|rb|go|rs|java|cpp|c|h|cs|php)$/i.test(file.name);
            const isImage = file.type.startsWith('image/');
            const isTooLarge = file.size > MAX_INLINE_BYTES;

            if (isImage && !isTooLarge) {
                reader.onload = () => resolve({ name: file.name, size: file.size, type: file.type, content: reader.result || '', kind: 'image' });
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(file);
            } else if (isText && !isTooLarge) {
                reader.onload = () => resolve({ name: file.name, size: file.size, type: file.type || 'text/plain', content: reader.result || '', kind: 'text' });
                reader.onerror = () => resolve(null);
                reader.readAsText(file);
            } else {
                resolve({ name: file.name, size: file.size, type: file.type || 'binary', content: null, kind: 'binary', note: isTooLarge ? 'omitted (too large)' : 'binary attachment' });
            }
        }));

        Promise.all(readPromises).then((results) => {
            const cleaned = results.filter(Boolean).map((item) => ({
                ...item,
                id: `${item.name}-${item.size}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            }));
            if (cleaned.length) setAttachments((prev) => [...prev, ...cleaned]);
        });
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setIsDragging(false);
        
        // Check for workspace file paths first (dragged from file tree or tabs)
        const workspacePath = e.dataTransfer?.getData('text/workspace-path') || e.dataTransfer?.getData('text/tab-path');
        if (workspacePath) {
            const paths = workspacePath.split(',').map(p => p.trim()).filter(Boolean);
            if (paths.length && addWorkspaceFiles(paths) > 0) {
                return; // Successfully added workspace files
            }
        }
        
        // Fallback to regular file drop
        const files = e.dataTransfer?.files;
        if (files && files.length) handleFilesSelected(files);
    }, [addWorkspaceFiles, handleFilesSelected]);

    const handleDragOver = useCallback((e) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handlePaste = useCallback((e) => {
        const items = e.clipboardData?.items || [];
        const files = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length) {
            e.preventDefault();
            handleFilesSelected(files);
        }
    }, [handleFilesSelected]);

    const removeAttachment = useCallback((id) => {
        setAttachments((prev) => prev.filter((att) => att.id !== id));
    }, []);

    // Clear all attachments after a send or when resetting the composer.
    const clearAttachments = useCallback(() => setAttachments([]), []);

    const formatBytes = useCallback((bytes) => {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return `${bytes} B`;
        const kb = bytes / 1024;
        if (kb < 1024) return `${kb.toFixed(1)} KB`;
        return `${(kb / 1024).toFixed(1)} MB`;
    }, []);

    return {
        attachments,
        isDragging,
        handleFilesSelected,
        handleDrop,
        handleDragOver,
        handleDragLeave,
        handlePaste,
        removeAttachment,
        clearAttachments,
        formatBytes,
        addWorkspaceFiles,
    };
};
