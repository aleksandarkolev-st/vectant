import { diffLines } from 'diff';

export const computeDiffChunks = (oldStr = '', newStr = '') => {
    const parts = diffLines(oldStr, newStr);
    let rows = [];
    let oldLine = 1;
    let newLine = 1;

    parts.forEach((part) => {
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

    // Collapse removal/addition pairs that are actually identical text to avoid noisy diffs/stats.
    const merged = [];
    for (let i = 0; i < rows.length; i++) {
        const curr = rows[i];
        const next = rows[i + 1];
        if (curr?.type === 'rem' && next?.type === 'add') {
            if (curr.text.trim() === next.text.trim()) {
                merged.push({
                    type: 'eq',
                    lineOld: curr.lineOld,
                    lineNew: next.lineNew,
                    text: curr.text,
                });
                i += 1;
                continue;
            }
        }
        merged.push(curr);
    }
    rows = merged;
    });

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

export const stripFence = (text = '') => {
    if (!text) return '';
    const fenceRe = /```(?:\w+)?\n([\s\S]*?)```/m;
    const match = text.match(fenceRe);
    if (match && match[1]) return match[1];
    return text;
};

export const stripDiffMarkers = (text = '') => {
    if (!text) return '';
    return text
        .split('\n')
        .filter((line) => !/^@@\s|^---\s|^\+\+\+\s/.test(line))
        .map((line) => line.replace(/^[+-]/, ''))
        .join('\n')
        .trimEnd();
};

/**
 * Validate file diff blocks for common errors that indicate bad AI output.
 * Returns validation results with error details.
 */
export const validateFileDiffBlocks = (blocks = []) => {
    const errors = [];
    const warnings = [];
    const seenPaths = new Set();
    
    for (const block of blocks) {
        const { path, contentText, diffText } = block;
        
        if (!path) {
            errors.push('Found FILE block with empty or invalid path');
            continue;
        }
        
        // Check for duplicates
        if (seenPaths.has(path)) {
            errors.push(`Duplicate FILE block for ${path} - AI repeated the same file`);
            continue;
        }
        seenPaths.add(path);
        
        // Check for empty content
        const content = contentText || diffText || '';
        if (!content || content.trim().length < 5) {
            warnings.push(`FILE ${path} has very short or empty content`);
        }
        
        // Check if content looks mismatched to file extension
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const isJSLike = /^(js|jsx|ts|tsx|mjs)$/.test(ext);
        const isCSSLike = /^(css|scss|sass|less)$/.test(ext);
        const isHTMLLike = /^(html|htm)$/.test(ext);
        
        const hasHTML = /<html|<body|<head|<!DOCTYPE/i.test(content);
        const hasJSImport = /^(?:import|export|const|function|class|var|let)\s/m.test(content);
        const hasCSS = /^\s*\.[a-z]|^@media|:\s*{/m.test(content);
        
        // Flag mismatches
        if (isJSLike && hasHTML && !hasJSImport) {
            errors.push(`FILE ${path}: Detected HTML in JS file - likely wrong file or content corruption`);
        }
        if (isHTMLLike && hasJSImport && !hasHTML) {
            errors.push(`FILE ${path}: Detected JS imports in HTML file - content mismatched to extension`);
        }
        if (isCSSLike && hasHTML) {
            errors.push(`FILE ${path}: Detected HTML in CSS file - content mismatched`);
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors,
        warnings,
        blockCount: blocks.length,
    };
};

export const parseFileDiffBlocks = (text = '', fallbackPath = null) => {
    if (!text) return [];
    const blocks = [];
    const segments = text.split(/(?=FILE:\s*)/i);
    for (const segment of segments) {
        if (!segment.trim().startsWith('FILE:')) continue;
        const headerMatch = segment.match(/^FILE:\s*([^\n]+)\s*(?:\nLINES:[^\n]*\s*)?/i);
        if (!headerMatch) continue;
        const path = headerMatch[1]?.trim();
        if (!path) continue;
        const body = segment.slice(headerMatch[0].length).trim();
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

export const renderDiffChunkList = (chunks = []) => {
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
        return <div className="px-3 py-2 text-[11px] text-zinc-500 font-mono">No changes detected.</div>;
    }
    return chunks.map((chunk, ci) => {
        if (chunk.type === 'eq') {
            return chunk.items.map((row) => (
                <div key={`eq-${row.lineOld}-${row.lineNew}-${ci}`} className="px-3 py-0.5 text-zinc-500 flex gap-3 font-mono text-[11px] leading-relaxed">
                    <div className="w-8 text-right text-zinc-600 select-none flex-shrink-0">{row.lineNew}</div>
                    <div className="flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</div>
                </div>
            ));
        }
        if (chunk.type === 'eq-elide') {
            return (
                <div key={`elide-${ci}`}>
                    {chunk.head.map((row) => (
                        <div key={`head-${row.lineNew}-${ci}`} className="px-3 py-0.5 text-zinc-500 flex gap-3 font-mono text-[11px] leading-relaxed">
                            <div className="w-8 text-right text-zinc-600 select-none flex-shrink-0">{row.lineNew}</div>
                            <div className="flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</div>
                        </div>
                    ))}
                    <div className="px-3 py-1.5 text-zinc-600 text-center text-[10px] font-mono bg-zinc-900/30 border-y border-zinc-800/50">
                        ··· {chunk.elidedCount} unchanged lines ···
                    </div>
                    {chunk.tail.map((row) => (
                        <div key={`tail-${row.lineNew}-${ci}`} className="px-3 py-0.5 text-zinc-500 flex gap-3 font-mono text-[11px] leading-relaxed">
                            <div className="w-8 text-right text-zinc-600 select-none flex-shrink-0">{row.lineNew}</div>
                            <div className="flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</div>
                        </div>
                    ))}
                </div>
            );
        }
        if (chunk.type === 'add') {
            return chunk.items.map((row) => (
                <div key={`add-${row.lineNew}-${ci}`} className="px-3 py-0.5 flex gap-3 text-emerald-300 bg-emerald-950/40 border-l-2 border-emerald-500/60 font-mono text-[11px] leading-relaxed">
                    <div className="w-8 text-right text-emerald-600 select-none flex-shrink-0">{row.lineNew}</div>
                    <div className="flex-1 break-words whitespace-pre-wrap"><span className="text-emerald-500/70 select-none mr-1">+</span>{row.text || ' '}</div>
                </div>
            ));
        }
        if (chunk.type === 'rem') {
            return chunk.items.map((row) => (
                <div key={`rem-${row.lineOld}-${ci}`} className="px-3 py-0.5 flex gap-3 text-rose-300 bg-rose-950/40 border-l-2 border-rose-500/60 font-mono text-[11px] leading-relaxed">
                    <div className="w-8 text-right text-rose-600 select-none flex-shrink-0">{row.lineOld}</div>
                    <div className="flex-1 break-words whitespace-pre-wrap"><span className="text-rose-500/70 select-none mr-1">-</span>{row.text || ' '}</div>
                </div>
            ));
        }
        return null;
    });
};

export const diffStats = (chunks = []) => {
    if (!Array.isArray(chunks)) return { adds: 0, removals: 0 };
    return chunks.reduce(
        (acc, chunk) => {
            if (chunk.type === 'add' && Array.isArray(chunk.items)) {
                acc.adds += chunk.items.length;
            } else if (chunk.type === 'rem' && Array.isArray(chunk.items)) {
                acc.removals += chunk.items.length;
            }
            return acc;
        },
        { adds: 0, removals: 0 }
    );
};
