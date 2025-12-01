import { diffLines } from 'diff';

export const computeDiffChunks = (oldStr = '', newStr = '') => {
    const parts = diffLines(oldStr, newStr);
    const rows = [];
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