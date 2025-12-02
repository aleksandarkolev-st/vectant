import { useCallback, useState } from 'react';

const MAX_INLINE_BYTES = 120 * 1024; // keep payloads small to avoid gateway timeouts

export const useChatAttachments = () => {
    const [attachments, setAttachments] = useState([]);
    const [isDragging, setIsDragging] = useState(false);

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
        const files = e.dataTransfer?.files;
        if (files && files.length) handleFilesSelected(files);
    }, [handleFilesSelected]);

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
        formatBytes,
    };
};
