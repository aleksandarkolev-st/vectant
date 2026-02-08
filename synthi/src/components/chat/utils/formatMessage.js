import DOMPurify from 'dompurify';

/**
 * Patterns to detect clickable code references in AI responses.
 */
const FILE_EXTENSIONS = 'cpp|hpp|h|c|js|jsx|ts|tsx|py|rs|go|java|kt|swift|rb|php|css|scss|html|json|yaml|yml|toml|md';
const FILE_PATTERN = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_-]*\\.(${FILE_EXTENSIONS}))\\b`, 'g');
const METHOD_PATTERN = /\b([a-zA-Z_][a-zA-Z0-9_]*)\(\)/g;
const CLASS_PATTERN = /\b([A-Z][a-zA-Z0-9_]{2,})\b/g;

// Words to skip when detecting class names
const SKIP_WORDS = new Set([
    'The', 'This', 'That', 'Here', 'There', 'These', 'Those', 'Which', 'What', 
    'When', 'Where', 'How', 'Why', 'Key', 'Purpose', 'Note', 'Example', 'File',
    'Class', 'Method', 'Function', 'Variable', 'Object', 'Array', 'String',
    'Number', 'Boolean', 'True', 'False', 'Null', 'Undefined', 'Return', 'Import',
    'Export', 'Default', 'Const', 'Let', 'Var', 'New', 'Delete', 'Void', 'Int'
]);

// Common method names to skip
const SKIP_METHODS = new Set([
    'if', 'for', 'while', 'switch', 'return', 'new', 'delete', 'class', 
    'function', 'const', 'let', 'var', 'get', 'set', 'has', 'is', 'to', 'of'
]);

/**
 * Make file paths and symbols clickable in text content.
 * This is called BEFORE HTML escaping on raw text segments.
 */
const addNavigationMarkers = (text) => {
    // Track positions that have already been marked to avoid double-wrapping
    const markers = [];
    
    // Find file references first (highest priority)
    FILE_PATTERN.lastIndex = 0;
    let match;
    while ((match = FILE_PATTERN.exec(text)) !== null) {
        markers.push({
            start: match.index,
            end: match.index + match[0].length,
            type: 'file',
            target: match[1],
            original: match[0]
        });
    }
    
    // Find method calls
    METHOD_PATTERN.lastIndex = 0;
    while ((match = METHOD_PATTERN.exec(text)) !== null) {
        const methodName = match[1];
        if (SKIP_METHODS.has(methodName.toLowerCase())) continue;
        // Check overlap with existing markers
        const overlaps = markers.some(m => 
            (match.index >= m.start && match.index < m.end) ||
            (match.index + match[0].length > m.start && match.index + match[0].length <= m.end)
        );
        if (!overlaps) {
            markers.push({
                start: match.index,
                end: match.index + match[0].length,
                type: 'method',
                target: methodName,
                original: match[0]
            });
        }
    }
    
    // Find class names
    CLASS_PATTERN.lastIndex = 0;
    while ((match = CLASS_PATTERN.exec(text)) !== null) {
        const className = match[1];
        if (SKIP_WORDS.has(className)) continue;
        // Check overlap with existing markers
        const overlaps = markers.some(m => 
            (match.index >= m.start && match.index < m.end) ||
            (match.index + match[0].length > m.start && match.index + match[0].length <= m.end)
        );
        if (!overlaps) {
            markers.push({
                start: match.index,
                end: match.index + match[0].length,
                type: 'class',
                target: className,
                original: match[0]
            });
        }
    }
    
    // Sort markers by position (descending) to replace from end to start
    markers.sort((a, b) => b.start - a.start);
    
    // Apply markers
    let result = text;
    for (const marker of markers) {
        const navClass = marker.type === 'file' ? 'ai-nav-file' : 
                         marker.type === 'method' ? 'ai-nav-method' : 'ai-nav-class';
        const navType = marker.type === 'file' ? 'file' : 'symbol';
        const replacement = `[[NAV:${navType}:${navClass}:${marker.target}:${marker.original}]]`;
        result = result.slice(0, marker.start) + replacement + result.slice(marker.end);
    }
    
    return result;
};

/**
 * Convert navigation markers to HTML after escaping
 */
const convertNavigationMarkers = (html) => {
    return html.replace(/\[\[NAV:([^:]+):([^:]+):([^:]+):([^\]]+)\]\]/g, 
        (_, navType, navClass, target, original) => {
            return `<span class="ai-nav-link ${navClass}" data-nav-type="${navType}" data-nav-target="${target}">${original}</span>`;
        }
    );
};

/**
 * Parse message content into segments (text and code blocks).
 * Returns an array of segments for React to render with proper components.
 */
export const parseMessageSegments = (content, options = {}) => {
    if (!content) return [];
    const { enableNavigation = true } = options;

    const escapeHtml = (str = '') => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const cleaned = content.replace(/^#{1,6}\s+/gm, '');
    const codeBlockRe = /```([a-zA-Z0-9_+-]*)\s*([\s\S]*?)```/g;
    let lastIndex = 0;
    const rawSegments = [];
    let match;

    while ((match = codeBlockRe.exec(cleaned)) !== null) {
        if (match.index > lastIndex) {
            rawSegments.push({ type: 'text', value: cleaned.slice(lastIndex, match.index) });
        }
        rawSegments.push({ type: 'code', value: match[2] || '', lang: match[1] || '' });
        lastIndex = codeBlockRe.lastIndex;
    }
    if (lastIndex < cleaned.length) {
        rawSegments.push({ type: 'text', value: cleaned.slice(lastIndex) });
    }

    // Process text segments
    return rawSegments.map((segment, index) => {
        if (segment.type === 'code') {
            return {
                type: 'code',
                code: segment.value.trim(),
                lang: segment.lang,
                key: `code-${index}`
            };
        }
        
        // Process text segment
        let processed = segment.value;
        if (enableNavigation) {
            processed = addNavigationMarkers(processed);
        }
        
        let escaped = escapeHtml(processed);
        
        // Apply markdown formatting
        escaped = escaped
            .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>')
            .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
            .replace(/`([^`]+)`/g, '<code class="bg-[#3a3a3d] px-1 rounded text-xs">$1</code>')
            .replace(/\n/g, '<br />');
        
        // Convert navigation markers to HTML after escaping
        if (enableNavigation) {
            escaped = convertNavigationMarkers(escaped);
        }
        
        return {
            type: 'text',
            html: escaped,
            key: `text-${index}`
        };
    });
};

/**
 * Legacy: Format message as a single HTML string.
 * For new code, prefer parseMessageSegments with CodeBlock component.
 */
export const formatMessageContent = (content, options = {}) => {
    if (!content) return '';
    const { enableNavigation = true } = options;

    const escapeHtml = (str = '') => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const cleaned = content.replace(/^#{1,6}\s+/gm, '');
    const codeBlockRe = /```([a-zA-Z0-9_+-]*)\s*([\s\S]*?)```/g;
    let lastIndex = 0;
    const segments = [];
    let match;

    while ((match = codeBlockRe.exec(cleaned)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: 'text', value: cleaned.slice(lastIndex, match.index) });
        }
        segments.push({ type: 'block', value: match[2] || '', lang: match[1] || '' });
        lastIndex = codeBlockRe.lastIndex;
    }
    if (lastIndex < cleaned.length) {
        segments.push({ type: 'text', value: cleaned.slice(lastIndex) });
    }

    const html = segments.map((segment) => {
        if (segment.type === 'block') {
            // For legacy: use placeholder that will be highlighted by Shiki
            const escaped = escapeHtml(segment.value.trim());
            const langLabel = segment.lang ? `<span class="code-lang-label">${segment.lang}</span>` : '';
            return `<div class="ai-code-wrapper">${langLabel}<pre class="ai-code-block"><code class="ai-code-block">${escaped}</code></pre></div>`;
        }
        
        // Add navigation markers BEFORE escaping
        let processed = segment.value;
        if (enableNavigation) {
            processed = addNavigationMarkers(processed);
        }
        
        let escaped = escapeHtml(processed);
        
        // Apply markdown formatting
        escaped = escaped
            .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>')
            .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
            .replace(/`([^`]+)`/g, '<code class="bg-[#3a3a3d] px-1 rounded text-xs">$1</code>')
            .replace(/\n/g, '<br />');
        
        // Convert navigation markers to HTML after escaping
        if (enableNavigation) {
            escaped = convertNavigationMarkers(escaped);
        }
        
        return escaped;
    }).join('');

    try {
        return DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['strong', 'em', 'code', 'pre', 'br', 'div', 'span', 'p', 'ul', 'ol', 'li'],
            ALLOWED_ATTR: ['class', 'data-nav-type', 'data-nav-target', 'data-lang']
        });
    } catch (e) {
        return html;
    }
};