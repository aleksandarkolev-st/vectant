import { AI_COMPLETION_MAX_INPUT_CHARS } from '@/lib/completion';

export const CONTEXT_SIDE_CHARS = 1600;
export const MAX_EDGE_LINES = 60;
export const MAX_SELECTION_CHARS = 1200;

export const trimCompletionContext = (code, cursorPosition = null) => {
    if (!code) return '';
    if (code.length <= AI_COMPLETION_MAX_INPUT_CHARS) return code;

    if (!cursorPosition) {
        return code.slice(-AI_COMPLETION_MAX_INPUT_CHARS);
    }

    const lines = code.split(/\r?\n/);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const lineIndex = clamp((cursorPosition.lineNumber || 1) - 1, 0, lines.length - 1);
    const columnIndex = clamp((cursorPosition.column || 1) - 1, 0, lines[lineIndex]?.length ?? 0);

    let offset = 0;
    for (let i = 0; i < lineIndex; i++) {
        offset += (lines[i]?.length ?? 0) + 1; // account for newline
    }
    offset += columnIndex;

    const halfWindow = Math.floor(AI_COMPLETION_MAX_INPUT_CHARS / 2);
    let start = Math.max(0, offset - halfWindow);
    let end = Math.min(code.length, start + AI_COMPLETION_MAX_INPUT_CHARS);

    if ((end - start) < AI_COMPLETION_MAX_INPUT_CHARS) {
        start = Math.max(0, end - AI_COMPLETION_MAX_INPUT_CHARS);
    }

    const beforeBreak = code.lastIndexOf('\n', start - 1);
    if (beforeBreak !== -1) start = beforeBreak + 1;
    const afterBreak = code.indexOf('\n', end);
    if (afterBreak !== -1 && afterBreak > end) end = afterBreak;

    return code.slice(start, end);
};

export const takeLastChars = (value = '', max = CONTEXT_SIDE_CHARS) => {
    if (typeof value !== 'string') return '';
    if (value.length <= max) return value;
    return value.slice(value.length - max);
};

export const takeFirstChars = (value = '', max = CONTEXT_SIDE_CHARS) => {
    if (typeof value !== 'string') return '';
    if (value.length <= max) return value;
    return value.slice(0, max);
};

export const buildEdgePreview = (lines = [], count = MAX_EDGE_LINES) => {
    if (!Array.isArray(lines) || !lines.length) {
        return { head: '', tail: '' };
    }
    const safeCount = Math.max(1, count);
    const head = lines.slice(0, safeCount).join('\n');
    const tail = lines.slice(-safeCount).join('\n');
    return { head, tail };
};

export const clampSelection = (text = '') => {
    if (typeof text !== 'string' || !text.trim()) return '';
    if (text.length <= MAX_SELECTION_CHARS) return text;
    return text.slice(-MAX_SELECTION_CHARS);
};
