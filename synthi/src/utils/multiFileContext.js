const MAX_MULTI_FILE_ENTRIES = 5;
const MAX_ACTIVE_FILE_CONTEXT_CHARS = 12000;
const MAX_SECONDARY_FILE_CHARS = 3600;

const EXCLUDED_PATH_MARKERS = [
    '/node_modules/',
    '/build/',
];

const normalizePath = (value = '') => `/${String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')}`;

const isExcludedPath = (value = '') => {
    const normalized = normalizePath(value);
    return EXCLUDED_PATH_MARKERS.some((marker) => normalized.includes(marker));
};

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
    const activePath = activeFile?.path || activeFile?.name || null;
    const files = [];

    if (activePath) {
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
    }

    if (!Array.isArray(cacheEntries) || files.length >= maxEntries) {
        return files;
    }

    const remainingSlots = Math.max(0, maxEntries - files.length);
    cacheEntries
        .filter(([path]) => path && path !== activePath && !isExcludedPath(path))
        .slice(0, remainingSlots)
        .forEach(([path, content]) => {
            const trimmed = collapseContent(content, secondaryFileMaxChars);
            if (!trimmed) return;
            // Mark referenced files explicitly so the model treats them as read-only context.
            const annotated = [
                `Reference file (read-only): ${path}`,
                'Use only to understand dependencies; do NOT copy these lines verbatim.',
                trimmed,
            ].join('\n\n');
            files.push({
                path,
                name: deriveNameFromPath(path),
                content: annotated,
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

