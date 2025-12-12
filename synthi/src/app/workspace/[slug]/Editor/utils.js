import { AI_COMPLETION_MAX_INPUT_CHARS } from '@/lib/completion';
import { useRef, useCallback, useEffect } from 'react';

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

export const useCustomScrollbar = (dependencies = []) => {
    const tabsContainerRef = useRef(null);
    const scrollbarThumbRef = useRef(null);
    const scrollTimeoutRef = useRef(null);

    const updateScrollbar = useCallback(() => {
        const container = tabsContainerRef.current;
        const thumb = scrollbarThumbRef.current;
        if (!container || !thumb) return;

        const { scrollWidth, clientWidth, scrollLeft } = container;
        
        if (scrollWidth <= clientWidth) {
            thumb.style.display = 'none';
            return;
        }
        
        thumb.style.display = 'block';
        
        // Calculate thumb width
        const thumbWidth = Math.max((clientWidth / scrollWidth) * clientWidth, 20);
        const maxScrollLeft = scrollWidth - clientWidth;
        const maxThumbLeft = clientWidth - thumbWidth;
        
        // Calculate thumb position
        const thumbLeft = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * maxThumbLeft : 0;
        
        thumb.style.width = `${thumbWidth}px`;
        thumb.style.transform = `translateX(${thumbLeft}px)`;
    }, []);

    const handleScroll = useCallback(() => {
        updateScrollbar();
        const thumb = scrollbarThumbRef.current;
        if (thumb) {
            thumb.classList.add('visible');
            if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
            scrollTimeoutRef.current = setTimeout(() => {
                thumb.classList.remove('visible');
            }, 1000);
        }
    }, [updateScrollbar]);

    // Handle dragging the scrollbar thumb
    const handleThumbMouseDown = useCallback((e) => {
        e.preventDefault();
        const container = tabsContainerRef.current;
        const thumb = scrollbarThumbRef.current;
        if (!container || !thumb) return;

        const startX = e.clientX;
        const startScrollLeft = container.scrollLeft;
        const { scrollWidth, clientWidth } = container;
        const maxScrollLeft = scrollWidth - clientWidth;
        const thumbWidth = thumb.clientWidth;
        const maxThumbLeft = clientWidth - thumbWidth;

        const handleMouseMove = (moveEvent) => {
            if (maxThumbLeft <= 0) return;
            const deltaX = moveEvent.clientX - startX;
            const scrollDelta = (deltaX / maxThumbLeft) * maxScrollLeft;
            container.scrollLeft = startScrollLeft + scrollDelta;
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, []);

    useEffect(() => {
        const container = tabsContainerRef.current;
        if (!container) return;
        
        const resizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                updateScrollbar();
            });
        });
        resizeObserver.observe(container);
        
        // Initial update
        updateScrollbar();
        
        return () => resizeObserver.disconnect();
    }, [updateScrollbar, ...dependencies]);

    return {
        tabsContainerRef,
        scrollbarThumbRef,
        handleScroll,
        handleThumbMouseDown,
        updateScrollbar
    };
};
