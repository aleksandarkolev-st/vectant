/**
 * Local symbol-aware context for inline completions.
 *
 * Extracts identifiers from the cursor neighborhood, finds their declarations
 * in the workspace's file cache, and produces a compact set of reference
 * chunks the FIM prompt can consume. Runs entirely in the browser — no RAG,
 * no embedding, no extra network hop. Total budget: <30 ms for typical inputs.
 *
 * Why not whole files: the previous payload shipped up to 16 reference files
 * per request (≈ tens of KB) and the model echoed from them. Targeted snippets
 * (one declaration per relevant symbol, ~200 chars each) give the model the
 * type/signature info it needs without the noise.
 */

// Languages whose keywords we never want to treat as user symbols.
const KEYWORDS = new Set([
    // C / C++ / C-like
    'auto', 'break', 'case', 'char', 'class', 'const', 'continue', 'default', 'delete',
    'do', 'double', 'else', 'enum', 'extern', 'false', 'float', 'for', 'goto', 'if',
    'inline', 'int', 'long', 'namespace', 'new', 'nullptr', 'operator', 'private',
    'protected', 'public', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
    'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename',
    'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while', 'catch',
    // JavaScript / TypeScript
    'abstract', 'any', 'as', 'async', 'await', 'boolean', 'declare', 'export',
    'function', 'from', 'import', 'in', 'instanceof', 'interface', 'is', 'let',
    'module', 'never', 'null', 'number', 'of', 'package', 'readonly', 'require',
    'string', 'super', 'symbol', 'type', 'typeof', 'undefined', 'unknown', 'var',
    'with', 'yield',
    // Python / common
    'and', 'def', 'elif', 'except', 'finally', 'global', 'lambda', 'not', 'or',
    'pass', 'raise', 'self', 'None', 'True', 'False', 'finally',
]);

// How much of the prefix to scan when extracting symbols. The cursor's
// immediate neighborhood matters most; everything 2 KB back is mostly noise.
const PREFIX_SCAN_CHARS = 2000;
// Max symbols we'll look up. Each lookup costs O(N files × file_size) — keep small.
const MAX_SYMBOLS = 6;
// Per-chunk budget when extracting a declaration's surrounding lines.
const CHUNK_LINE_BUDGET = 16;
const CHUNK_CHAR_BUDGET = 320;
// Total reference budget across all chunks. Server caps at MAX_REFS_CHARS
// (~5 KB) so we leave the higher cap for RAG-supplied snippets and keep the
// client-side bag tighter.
const TOTAL_REF_CHAR_BUDGET = 2200;
// Recent-edit context budget per entry. A diff-style entry is roughly
// "header + 3 lines context + n inserted lines + 3 lines context"; 480 fits
// most realistic edits without truncating the inserted text.
const RECENT_EDIT_CHAR_BUDGET = 480;
const RECENT_EDIT_TTL_MS = 60_000;
const RECENT_EDIT_MAX_ENTRIES = 4;

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Extract candidate symbols from the prefix, scored by how likely they are to
 * be useful context. The cursor's current line and the most-recent type-shaped
 * tokens (qualified names, capitalized identifiers) get priority.
 *
 * Returns up to MAX_SYMBOLS unique identifier strings, highest-priority first.
 */
export const extractSymbols = (prefix = '') => {
    if (typeof prefix !== 'string' || !prefix) return [];

    const scan = prefix.length > PREFIX_SCAN_CHARS
        ? prefix.slice(prefix.length - PREFIX_SCAN_CHARS)
        : prefix;

    const lastNewline = scan.lastIndexOf('\n');
    const currentLine = lastNewline >= 0 ? scan.slice(lastNewline + 1) : scan;
    // The last identifier on the current line is what the user is typing —
    // don't recommend looking up a partial symbol.
    const incompleteAtCursor = (currentLine.match(/[A-Za-z_][A-Za-z0-9_]*$/) || [''])[0];

    const scores = new Map(); // identifier -> score
    const bump = (ident, delta) => {
        if (!ident || ident.length < 2) return;
        if (KEYWORDS.has(ident)) return;
        if (ident === incompleteAtCursor) return;
        scores.set(ident, (scores.get(ident) || 0) + delta);
    };

    // Pass 1: identifiers in the current line carry the most weight.
    let m;
    IDENT_RE.lastIndex = 0;
    while ((m = IDENT_RE.exec(currentLine))) {
        const ident = m[0];
        let score = 4;
        if (/^[A-Z]/.test(ident)) score += 2;            // CapitalizedNames → likely types
        if (currentLine.indexOf(ident + '(') !== -1) score += 2; // function-call shape
        bump(ident, score);
    }

    // Pass 2: qualified names (Foo::bar, foo.bar, foo->bar) — pull out the head.
    const qualified = scan.match(/[A-Za-z_][A-Za-z0-9_]*(?=\s*(?:::|\.|->))/g) || [];
    for (const ident of qualified) bump(ident, 3);

    // Pass 3: anything else in the last few hundred chars.
    const tail = scan.slice(Math.max(0, scan.length - 500));
    IDENT_RE.lastIndex = 0;
    while ((m = IDENT_RE.exec(tail))) {
        const ident = m[0];
        let score = 1;
        if (/^[A-Z]/.test(ident)) score += 1;
        bump(ident, score);
    }

    return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SYMBOLS)
        .map(([ident]) => ident);
};

/**
 * Build the language-specific regex set for finding a symbol's declaration.
 * Returns null when we don't know the language well enough — callers should
 * fall back to the generic word-boundary match.
 */
const declarationPatternsFor = (symbol, language) => {
    const sym = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lang = (language || '').toLowerCase();
    if (lang === 'cpp' || lang === 'c' || lang === 'objective-c' || lang === 'objective-cpp') {
        return [
            new RegExp(`(?:class|struct|union|enum)\\s+${sym}\\b`, 'm'),
            new RegExp(`typedef\\s+[^;]*?\\b${sym}\\s*[;{]`, 'm'),
            new RegExp(`^\\s*[\\w\\s\\*&:<>,]+\\s+${sym}\\s*\\(`, 'm'),  // function decl
            new RegExp(`#define\\s+${sym}\\b`, 'm'),
        ];
    }
    if (lang === 'typescript' || lang === 'typescriptreact' || lang === 'tsx' ||
        lang === 'javascript' || lang === 'javascriptreact' || lang === 'jsx') {
        return [
            new RegExp(`(?:class|interface|type|enum)\\s+${sym}\\b`, 'm'),
            new RegExp(`function\\s+${sym}\\s*\\(`, 'm'),
            new RegExp(`(?:const|let|var)\\s+${sym}\\s*[=:]`, 'm'),
            new RegExp(`export\\s+(?:default\\s+)?(?:function|class|const|let|var)\\s+${sym}\\b`, 'm'),
        ];
    }
    if (lang === 'python') {
        return [
            new RegExp(`(?:class|def)\\s+${sym}\\s*[\\(:]`, 'm'),
            new RegExp(`^${sym}\\s*=`, 'm'),
        ];
    }
    if (lang === 'go') {
        return [
            new RegExp(`(?:func|type|var|const)\\s+${sym}\\b`, 'm'),
        ];
    }
    if (lang === 'rust') {
        return [
            new RegExp(`(?:fn|struct|enum|trait|type|const|static)\\s+${sym}\\b`, 'm'),
        ];
    }
    if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
        return [
            new RegExp(`(?:class|interface|enum|record)\\s+${sym}\\b`, 'm'),
            new RegExp(`(?:public|private|protected|static|final|abstract|\\s)+\\s+${sym}\\s*\\(`, 'm'),
        ];
    }
    return null;
};

/**
 * Slice a chunk of `content` around `matchIndex` — a few lines of context
 * before and after, capped to CHUNK_LINE_BUDGET / CHUNK_CHAR_BUDGET.
 */
const sliceChunk = (content, matchIndex) => {
    if (matchIndex < 0 || matchIndex >= content.length) return null;

    // Walk backward to grab a few lines of leading context.
    let start = matchIndex;
    let leadingNewlines = 0;
    while (start > 0 && leadingNewlines < 2) {
        start--;
        if (content[start] === '\n') leadingNewlines++;
    }
    if (start > 0) start++; // step past the newline we counted

    // Walk forward up to CHUNK_LINE_BUDGET lines of body.
    let end = matchIndex;
    let trailingNewlines = 0;
    while (end < content.length && trailingNewlines < CHUNK_LINE_BUDGET) {
        if (content[end] === '\n') trailingNewlines++;
        end++;
    }

    let snippet = content.slice(start, end);
    if (snippet.length > CHUNK_CHAR_BUDGET) {
        snippet = snippet.slice(0, CHUNK_CHAR_BUDGET) + '\n…';
    }

    const startLine = (content.slice(0, start).match(/\n/g) || []).length + 1;
    return { snippet, startLine };
};

/**
 * Search the file cache for declarations of each symbol. Returns at most
 * one chunk per (file, symbol) pair, capped by TOTAL_REF_CHAR_BUDGET overall.
 *
 * @param {string[]} symbols
 * @param {Iterable<[string, string]>} cacheEntries  e.g. fileCacheEntriesRef.current
 * @param {string|null} activePath  skip the active file (its content is already in prefix/suffix)
 * @param {string} language
 */
export const findDeclarationChunks = (symbols, cacheEntries, activePath, language) => {
    if (!Array.isArray(symbols) || !symbols.length) return [];
    if (!cacheEntries) return [];

    const entries = Array.isArray(cacheEntries) ? cacheEntries : Array.from(cacheEntries);
    const refs = [];
    const seen = new Set();
    let totalChars = 0;

    for (const symbol of symbols) {
        if (totalChars >= TOTAL_REF_CHAR_BUDGET) break;
        const langPatterns = declarationPatternsFor(symbol, language);
        const sym = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fallback = new RegExp(`\\b${sym}\\b`, 'm');

        for (const [path, content] of entries) {
            if (totalChars >= TOTAL_REF_CHAR_BUDGET) break;
            if (!path || typeof content !== 'string' || !content) continue;
            if (path === activePath) continue;
            const dedupKey = `${path}::${symbol}`;
            if (seen.has(dedupKey)) continue;

            // Try language-specific declaration patterns first; fall back to
            // a generic word-boundary match if none are available.
            let matchIdx = -1;
            if (langPatterns) {
                for (const re of langPatterns) {
                    const r = re.exec(content);
                    if (r) { matchIdx = r.index; break; }
                }
            }
            if (matchIdx === -1) {
                const r = fallback.exec(content);
                if (r) matchIdx = r.index;
            }
            if (matchIdx === -1) continue;

            const chunk = sliceChunk(content, matchIdx);
            if (!chunk) continue;

            seen.add(dedupKey);
            refs.push({
                path,
                symbol,
                snippet: chunk.snippet,
                startLine: chunk.startLine,
                kind: 'symbol',
            });
            totalChars += chunk.snippet.length;
            // Only one file per symbol — first declaration wins.
            break;
        }
    }

    return refs;
};

/**
 * Append a recent-edit entry to the ring buffer.  Drops entries older than
 * RECENT_EDIT_TTL_MS and keeps the buffer at RECENT_EDIT_MAX_ENTRIES.
 *
 * @param {Array<{path: string, snippet: string, ts: number}>} buffer
 * @param {{path: string, snippet: string}} entry
 */
export const pushRecentEdit = (buffer, entry) => {
    if (!Array.isArray(buffer) || !entry?.path || !entry?.snippet) return buffer;
    const now = Date.now();
    // Diff-shaped snippets start with `@@` and have inserted lines marked
    // with `+ `. When we have to truncate, keep the header and the inserted
    // lines (the actual signal) over surrounding context. Falls back to a
    // simple head-slice for anything else.
    const trim = (text) => {
        if (text.length <= RECENT_EDIT_CHAR_BUDGET) return text;
        if (text.startsWith('@@')) {
            const lines = text.split('\n');
            const header = lines[0];
            const inserted = lines.filter((l) => l.startsWith('+ '));
            const ctx = lines.filter((l) => !l.startsWith('+ ') && l !== header);
            const out = [header];
            let used = header.length + 1;
            const fit = (line) => {
                const room = RECENT_EDIT_CHAR_BUDGET - used - 1;
                if (room <= 0) return false;
                if (line.length + 1 <= room) {
                    out.push(line);
                    used += line.length + 1;
                    return true;
                }
                // Single line over budget — truncate from the head: an inserted
                // line's prefix carries the strongest "what is being typed"
                // signal, and we'd rather keep partial intent than nothing.
                out.push(line.slice(0, room - 1) + '…');
                used += room;
                return false;
            };
            // Inserted lines first (the actual change); then as much context as fits.
            for (const line of inserted) {
                if (!fit(line)) break;
            }
            for (const line of ctx) {
                if (!fit(line)) break;
            }
            return out.join('\n');
        }
        return text.slice(0, RECENT_EDIT_CHAR_BUDGET);
    };
    const trimmedSnippet = trim(entry.snippet);
    // Coalesce repeated edits to the same file into the most recent snippet.
    const next = buffer.filter(e => e.path !== entry.path && (now - e.ts) < RECENT_EDIT_TTL_MS);
    next.push({ path: entry.path, snippet: trimmedSnippet, ts: now });
    while (next.length > RECENT_EDIT_MAX_ENTRIES) next.shift();
    return next;
};

/**
 * Project the recent-edit buffer into reference shape, dropping the active
 * file (already covered by the request's prefix/suffix) and any stale entries.
 */
export const recentEditRefs = (buffer, activePath) => {
    if (!Array.isArray(buffer) || !buffer.length) return [];
    const now = Date.now();
    return buffer
        .filter(e => e.path && e.path !== activePath && (now - e.ts) < RECENT_EDIT_TTL_MS)
        .map(e => ({
            path: e.path,
            snippet: e.snippet,
            kind: 'recent-edit',
        }));
};

/**
 * Build the full `references` payload for an inline completion request.
 *
 * @returns {Array<{path:string, snippet:string, kind:string, symbol?:string, startLine?:number}>}
 */
export const buildCompletionReferences = ({
    prefix,
    language,
    activePath,
    cacheEntries,
    recentEdits,
}) => {
    const symbols = extractSymbols(prefix);
    const symbolRefs = findDeclarationChunks(symbols, cacheEntries, activePath, language);
    const editRefs = recentEditRefs(recentEdits, activePath);

    // Recent edits are usually most relevant, but we cap them so they don't
    // crowd out the symbol declarations.
    const out = [];
    let totalChars = 0;
    for (const ref of [...editRefs.slice(0, 2), ...symbolRefs]) {
        if (totalChars + ref.snippet.length > TOTAL_REF_CHAR_BUDGET) continue;
        out.push(ref);
        totalChars += ref.snippet.length;
    }
    return out;
};
