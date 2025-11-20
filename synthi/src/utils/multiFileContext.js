const MAX_MULTI_FILE_ENTRIES = 5;
const MAX_ACTIVE_FILE_CONTEXT_CHARS = 12000;
const MAX_SECONDARY_FILE_CHARS = 3600;

const collapseContent = (value = '', max = MAX_SECONDARY_FILE_CHARS) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    if (value.length <= max) return value;
    const headSize = Math.floor(max / 2);
    const tailSize = Math.max(1, max - headSize);
    const head = value.slice(0, headSize);
    const tail = value.slice(value.length - tailSize);
    return `${head}\n...\n${tail}`;
};

const deriveNameFromPath = (path = '') => {
    if (typeof path !== 'string' || !path) return 'file';
    const parts = path.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
};

const buildFilesPayload = ({
    activeFile,
    fullDocument = '',
    beforeCursor = '',
    afterCursor = '',
    fileHeader = '',
    fileTail = '',
    cacheEntries = [],
    maxEntries = MAX_MULTI_FILE_ENTRIES,
    activeFileMaxChars = MAX_ACTIVE_FILE_CONTEXT_CHARS,
    secondaryFileMaxChars = MAX_SECONDARY_FILE_CHARS,
} = {}) => {
    if (!activeFile) return [];
    const activePath = activeFile.path || activeFile.name || 'active-file';
    const files = [];

    const activeContent = collapseContent(fullDocument, activeFileMaxChars);
    const sections = [];
    if (beforeCursor || afterCursor) {
        sections.push(`Around cursor:\n${beforeCursor || ''}<<CURSOR>>${afterCursor || ''}`);
    }
    if (fileHeader) sections.push(`File header:\n${fileHeader}`);
    if (fileTail) sections.push(`File tail:\n${fileTail}`);

    const activePayload = [activeContent, ...sections].filter(Boolean).join('\n\n-----\n\n');
    if (activePayload.trim()) {
        files.push({
            path: activePath,
            name: activeFile.name || deriveNameFromPath(activePath),
            content: activePayload,
        });
    }

    if (!Array.isArray(cacheEntries) || files.length >= maxEntries) {
        return files;
    }

    const remainingSlots = Math.max(0, maxEntries - files.length);
    cacheEntries
        .filter(([path]) => path && path !== activePath)
        .slice(0, remainingSlots)
        .forEach(([path, content]) => {
            const trimmed = collapseContent(content, secondaryFileMaxChars);
            if (!trimmed) return;
            files.push({
                path,
                name: deriveNameFromPath(path),
                content: trimmed,
            });
        });

    return files;
};

export {
    MAX_MULTI_FILE_ENTRIES,
    MAX_ACTIVE_FILE_CONTEXT_CHARS,
    MAX_SECONDARY_FILE_CHARS,
    collapseContent,
    deriveNameFromPath,
    buildFilesPayload,
};

