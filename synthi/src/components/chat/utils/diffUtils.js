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

/**
 * Detect whether a body contains SEARCH/REPLACE blocks.
 */
const hasSearchReplaceBlocks = (text = '') =>
    /<<<+\s*SEARCH/i.test(text) && />>>+\s*REPLACE/i.test(text);

/**
 * Apply SEARCH/REPLACE blocks to original content.
 * Each block matches exact text in the original and replaces it.
 *
 * Format:
 *   <<<<<<< SEARCH
 *   exact text to find
 *   =======
 *   replacement text
 *   >>>>>>> REPLACE
 *
 * @param {string} original - The original file content
 * @param {string} blockText - Text containing one or more SEARCH/REPLACE blocks
 * @returns {string|false} The updated content, or false if any search block wasn't found
 */
export const applySearchReplace = (original, blockText) => {
    if (!blockText) return false;
    // Parse all SEARCH/REPLACE pairs
    const blockRe = /<<<+\s*SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>+\s*REPLACE/gi;
    let result = original || '';
    let match;
    let applied = 0;

    /** Normalise a line for fuzzy comparison: trim + collapse whitespace */
    const normLine = (l) => l.trim().replace(/\s+/g, ' ');

    while ((match = blockRe.exec(blockText)) !== null) {
        const searchText = match[1];
        const replaceText = match[2];

        // ── Strategy 1: Exact match ─────────────────────────────
        let idx = result.indexOf(searchText);
        if (idx !== -1) {
            result = result.slice(0, idx) + replaceText + result.slice(idx + searchText.length);
            applied++;
            continue;
        }

        // ── Strategy 2: Trimmed-line matching ───────────────────
        const searchLines = searchText.split('\n').map(l => l.trimEnd());
        const resultLines = result.split('\n');
        let found = false;
        for (let i = 0; i <= resultLines.length - searchLines.length; i++) {
            let ok = true;
            for (let j = 0; j < searchLines.length; j++) {
                if (resultLines[i + j].trimEnd() !== searchLines[j]) { ok = false; break; }
            }
            if (ok) {
                const matchedLines = resultLines.slice(i, i + searchLines.length);
                const exactOriginal = matchedLines.join('\n');
                const pos = result.indexOf(exactOriginal);
                if (pos !== -1) {
                    result = result.slice(0, pos) + replaceText + result.slice(pos + exactOriginal.length);
                    applied++;
                    found = true;
                    break;
                }
            }
        }
        if (found) continue;

        // ── Strategy 3: Normalised whitespace matching ──────────
        // Collapse all runs of whitespace so indentation / tab-vs-space differences don't matter
        const searchNorm = searchLines.map(normLine).filter(Boolean);
        if (searchNorm.length > 0) {
            for (let i = 0; i <= resultLines.length - searchNorm.length; i++) {
                let ok = true;
                for (let j = 0; j < searchNorm.length; j++) {
                    if (normLine(resultLines[i + j]) !== searchNorm[j]) { ok = false; break; }
                }
                if (ok) {
                    const matchedLines = resultLines.slice(i, i + searchNorm.length);
                    const exactOriginal = matchedLines.join('\n');
                    const pos = result.indexOf(exactOriginal);
                    if (pos !== -1) {
                        result = result.slice(0, pos) + replaceText + result.slice(pos + exactOriginal.length);
                        applied++;
                        found = true;
                        break;
                    }
                }
            }
        }
        if (found) continue;

        // ── Strategy 4: Best subsequence match ──────────────────
        // The AI sometimes includes extra context lines or omits lines.
        // Find the longest contiguous run of matching normalised lines in
        // the result. If ≥50% of searchNorm lines match, accept it.
        if (searchNorm.length >= 2) {
            const resultNorm = resultLines.map(normLine);
            let bestStart = -1, bestLen = 0, bestSearchStart = 0;
            for (let si = 0; si < searchNorm.length; si++) {
                for (let ri = 0; ri < resultNorm.length; ri++) {
                    if (resultNorm[ri] !== searchNorm[si]) continue;
                    // Count how many consecutive lines match
                    let len = 0;
                    while (si + len < searchNorm.length && ri + len < resultNorm.length
                           && resultNorm[ri + len] === searchNorm[si + len]) {
                        len++;
                    }
                    if (len > bestLen) {
                        bestLen = len;
                        bestStart = ri;
                        bestSearchStart = si;
                    }
                }
            }
            // Accept if ≥50% of search lines matched contiguously
            if (bestLen >= Math.ceil(searchNorm.length * 0.5) && bestStart !== -1) {
                const matchedLines = resultLines.slice(bestStart, bestStart + bestLen);
                const exactOriginal = matchedLines.join('\n');
                const pos = result.indexOf(exactOriginal);
                if (pos !== -1) {
                    result = result.slice(0, pos) + replaceText + result.slice(pos + exactOriginal.length);
                    applied++;
                    found = true;
                }
            }
        }
        if (found) continue;

        console.warn('[SEARCH/REPLACE] Could not find search text:', searchText.slice(0, 100));
        return false;
    }
    return applied > 0 ? result : false;
};

/**
 * Best-effort partial application of SEARCH/REPLACE blocks.
 * Unlike applySearchReplace which fails entirely if ANY block doesn't match,
 * this applies as many blocks as possible and skips the ones that fail.
 * Also uses a lower subsequence threshold (35% instead of 50%).
 *
 * @param {string} original - The original file content
 * @param {string} blockText - Text containing one or more SEARCH/REPLACE blocks
 * @returns {{ result: string, applied: number, failed: number, total: number }|false}
 */
export const applySearchReplacePartial = (original, blockText) => {
    if (!blockText) return false;
    const blockRe = /<<<+\s*SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>+\s*REPLACE/gi;
    let result = original || '';
    let applied = 0;
    let failed = 0;
    let total = 0;

    const normLine = (l) => l.trim().replace(/\s+/g, ' ');
    let match;

    while ((match = blockRe.exec(blockText)) !== null) {
        total++;
        const searchText = match[1];
        const replaceText = match[2];
        let found = false;

        // Strategy 1: Exact
        let idx = result.indexOf(searchText);
        if (idx !== -1) {
            result = result.slice(0, idx) + replaceText + result.slice(idx + searchText.length);
            applied++;
            continue;
        }

        // Strategy 2: Trimmed-line
        const searchLines = searchText.split('\n').map(l => l.trimEnd());
        const resultLines = result.split('\n');
        for (let i = 0; i <= resultLines.length - searchLines.length; i++) {
            let ok = true;
            for (let j = 0; j < searchLines.length; j++) {
                if (resultLines[i + j].trimEnd() !== searchLines[j]) { ok = false; break; }
            }
            if (ok) {
                const matchedLines = resultLines.slice(i, i + searchLines.length);
                const exactOriginal = matchedLines.join('\n');
                const pos = result.indexOf(exactOriginal);
                if (pos !== -1) {
                    result = result.slice(0, pos) + replaceText + result.slice(pos + exactOriginal.length);
                    applied++;
                    found = true;
                    break;
                }
            }
        }
        if (found) continue;

        // Strategy 3: Normalized whitespace
        const searchNorm = searchLines.map(normLine).filter(Boolean);
        if (searchNorm.length > 0) {
            for (let i = 0; i <= resultLines.length - searchNorm.length; i++) {
                let ok = true;
                for (let j = 0; j < searchNorm.length; j++) {
                    if (normLine(resultLines[i + j]) !== searchNorm[j]) { ok = false; break; }
                }
                if (ok) {
                    const matchedLines = resultLines.slice(i, i + searchNorm.length);
                    const exactOriginal = matchedLines.join('\n');
                    const pos = result.indexOf(exactOriginal);
                    if (pos !== -1) {
                        result = result.slice(0, pos) + replaceText + result.slice(pos + exactOriginal.length);
                        applied++;
                        found = true;
                        break;
                    }
                }
            }
        }
        if (found) continue;

        // Strategy 4: Subsequence with lower threshold (35%)
        if (searchNorm.length >= 2) {
            const rLines = result.split('\n');
            const rNorm = rLines.map(normLine);
            let bestStart = -1, bestLen = 0;
            for (let si = 0; si < searchNorm.length; si++) {
                for (let ri = 0; ri < rNorm.length; ri++) {
                    if (rNorm[ri] !== searchNorm[si]) continue;
                    let len = 0;
                    while (si + len < searchNorm.length && ri + len < rNorm.length
                           && rNorm[ri + len] === searchNorm[si + len]) {
                        len++;
                    }
                    if (len > bestLen) {
                        bestLen = len;
                        bestStart = ri;
                    }
                }
            }
            if (bestLen >= Math.ceil(searchNorm.length * 0.35) && bestStart !== -1) {
                const matchedLines = rLines.slice(bestStart, bestStart + bestLen);
                const exactOriginal = matchedLines.join('\n');
                const pos = result.indexOf(exactOriginal);
                if (pos !== -1) {
                    result = result.slice(0, pos) + replaceText + result.slice(pos + exactOriginal.length);
                    applied++;
                    found = true;
                }
            }
        }
        if (found) continue;

        failed++;
    }

    if (total === 0) return false;
    if (applied === 0) return false;
    return { result, applied, failed, total };
};

/**
 * Extract REPLACE sections from SEARCH/REPLACE blocks without matching.
 * Used as a last-resort fallback when applySearchReplace fails —
 * shows the intended replacement content so the user can manually apply it.
 * @param {string} blockText - Text containing SEARCH/REPLACE blocks
 * @returns {string|null} Concatenated REPLACE content, or null
 */
export const extractReplaceContent = (blockText) => {
    if (!blockText) return null;
    const blockRe = /<<<+\s*SEARCH\s*\n[\s\S]*?\n?=======\s*\n([\s\S]*?)\n?>>>+\s*REPLACE/gi;
    const parts = [];
    let m;
    while ((m = blockRe.exec(blockText)) !== null) {
        if (m[1] != null) parts.push(m[1]);
    }
    return parts.length > 0 ? parts.join('\n') : null;
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
        const isSearchReplace = hasSearchReplaceBlocks(normalized);
        blocks.push({
            path,
            diffText: looksLikeDiff ? normalized : null,
            contentText: looksLikeDiff ? null : (isSearchReplace ? null : normalized),
            searchReplaceText: isSearchReplace ? normalized : null,
            isValidDiff: looksLikeDiff || isSearchReplace || Boolean(normalized),
        });
    }
    if (!blocks.length && fallbackPath) {
        const raw = stripFence(text).replace(/\r\n/g, '\n').trim();
        if (!raw) return blocks;
        const looksLikeDiff = /^---\s+/m.test(raw) && /^\+\+\+\s+/m.test(raw) && /@@\s+/m.test(raw);
        const isSearchReplace = hasSearchReplaceBlocks(raw);
        // If the text is neither a diff nor SEARCH/REPLACE, check if it's actually
        // code vs a natural language explanation. Only create a fallback block for code.
        if (!looksLikeDiff && !isSearchReplace) {
            const sentences = (raw.match(/[.!?](?:\s|$)/g) || []).length;
            const codeTokens = (raw.match(/[{}();=<>[\]]/g) || []).length;
            const codeRatio = codeTokens / raw.length;
            const startsWithProse = /^(The |No |I |This |It |There |These |That |All |However |Note |In |Based |After |Upon |Looking |I've |Your |We )/.test(raw);
            // If it looks like prose (many sentences, few code tokens), don't create block
            if (startsWithProse && sentences >= 2 && codeRatio < 0.03) {
                return blocks;
            }
            if (sentences >= 4 && codeRatio < 0.015) {
                return blocks;
            }
        }
        blocks.push({
            path: fallbackPath,
            diffText: looksLikeDiff ? raw : null,
            contentText: looksLikeDiff ? null : (isSearchReplace ? null : raw),
            searchReplaceText: isSearchReplace ? raw : null,
            isValidDiff: looksLikeDiff || isSearchReplace || Boolean(raw),
        });
    }
    return blocks;
};

export const renderDiffChunkList = (chunks = []) => {
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
        return <div className="px-2 py-1.5 text-[10px] text-zinc-500 font-mono">No changes detected.</div>;
    }
    return chunks.map((chunk, ci) => {
        if (chunk.type === 'eq') {
            return chunk.items.map((row) => (
                <div key={`eq-${row.lineOld}-${row.lineNew}-${ci}`} className="px-2 py-px text-zinc-500 flex gap-2 font-mono text-[10px] leading-snug">
                    <div className="w-6 text-right text-zinc-600 select-none flex-shrink-0">{row.lineNew}</div>
                    <div className="flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</div>
                </div>
            ));
        }
        if (chunk.type === 'eq-elide') {
            return (
                <div key={`elide-${ci}`}>
                    {chunk.head.map((row) => (
                        <div key={`head-${row.lineNew}-${ci}`} className="px-2 py-px text-zinc-500 flex gap-2 font-mono text-[10px] leading-snug">
                            <div className="w-6 text-right text-zinc-600 select-none flex-shrink-0">{row.lineNew}</div>
                            <div className="flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</div>
                        </div>
                    ))}
                    <div className="px-2 py-1 text-zinc-600 text-center text-[9px] font-mono bg-zinc-900/30 border-y border-zinc-800/50">
                        ··· {chunk.elidedCount} unchanged lines ···
                    </div>
                    {chunk.tail.map((row) => (
                        <div key={`tail-${row.lineNew}-${ci}`} className="px-2 py-px text-zinc-500 flex gap-2 font-mono text-[10px] leading-snug">
                            <div className="w-6 text-right text-zinc-600 select-none flex-shrink-0">{row.lineNew}</div>
                            <div className="flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</div>
                        </div>
                    ))}
                </div>
            );
        }
        if (chunk.type === 'add') {
            return chunk.items.map((row) => (
                <div key={`add-${row.lineNew}-${ci}`} className="px-2 py-px flex gap-2 text-emerald-300 bg-emerald-950/40 border-l-2 border-emerald-500/60 font-mono text-[10px] leading-snug">
                    <div className="w-6 text-right text-emerald-600 select-none flex-shrink-0">{row.lineNew}</div>
                    <div className="flex-1 break-words whitespace-pre-wrap"><span className="text-emerald-500/70 select-none mr-0.5">+</span>{row.text || ' '}</div>
                </div>
            ));
        }
        if (chunk.type === 'rem') {
            return chunk.items.map((row) => (
                <div key={`rem-${row.lineOld}-${ci}`} className="px-2 py-px flex gap-2 text-rose-300 bg-rose-950/40 border-l-2 border-rose-500/60 font-mono text-[10px] leading-snug">
                    <div className="w-6 text-right text-rose-600 select-none flex-shrink-0">{row.lineOld}</div>
                    <div className="flex-1 break-words whitespace-pre-wrap"><span className="text-rose-500/70 select-none mr-0.5">-</span>{row.text || ' '}</div>
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
