const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_MAX_FILE_CHARS = 2_000_000; // index first ~2M chars per file (streamed)
const DEFAULT_MAX_TOKEN_HITS = 400; // cap hits per token to bound memory
const DEFAULT_MAX_FILES = 200_000;

const EXT_LANGUAGE = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  txt: 'plaintext',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  html: 'html',
  css: 'css',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  sh: 'shell',
};

const TEXT_EXTENSIONS = new Set([
  'js','jsx','ts','tsx','json','md','txt','py','rs','go','java','c','h','cpp','hpp','cs','html','css','yml','yaml','toml','xml','sh',
  'env','gitignore','dockerfile','makefile','gradle','lock'
]);

function extOf(p) {
  const base = (p || '').split('/').pop() || '';
  if (!base) return '';
  if (!base.includes('.')) {
    const lc = base.toLowerCase();
    if (lc === 'dockerfile') return 'dockerfile';
    if (lc === 'makefile') return 'makefile';
    if (lc.endsWith('.env')) return 'env';
    return '';
  }
  return base.split('.').pop().toLowerCase();
}

function languageForPath(p) {
  const ext = extOf(p);
  return EXT_LANGUAGE[ext] || (ext ? ext : 'plaintext');
}

function normalizeRel(rel) {
  return rel.replace(/\\/g, '/');
}

function tokenizeLine(line) {
  const out = new Set();
  const re = /[A-Za-z_][A-Za-z0-9_]{1,}/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    out.add(m[0].toLowerCase());
    if (out.size > 64) break;
  }
  return out;
}

function extractSymbols(line, lang) {
  const symbols = [];
  const trimmed = line.trim();
  if (!trimmed) return symbols;

  if (lang === 'python') {
    let m = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
    if (m) symbols.push(m[1]);
    m = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (m) symbols.push(m[1]);
    return symbols;
  }

  if (lang === 'rust') {
    let m = /^(pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (m) symbols.push(m[2]);
    m = /^(pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (m) symbols.push(m[2]);
    m = /^(pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (m) symbols.push(m[2]);
    return symbols;
  }

  if (lang === 'javascript' || lang === 'typescript') {
    let m = /^(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (m) symbols.push(m[4]);
    m = /^(export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (m) symbols.push(m[2]);
    m = /^(export\s+)?(const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(async\s+)?\(/.exec(trimmed);
    if (m) symbols.push(m[3]);
    return symbols;
  }

  // generic
  let m = /^(class|struct|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
  if (m) symbols.push(m[2]);
  m = /^(function)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
  if (m) symbols.push(m[2]);
  return symbols;
}

async function* walkFiles(repoPath, signal) {
  const stack = [repoPath];
  while (stack.length) {
    if (signal?.aborted) return;
    const dir = stack.pop();
    let dh;
    try {
      dh = await fs.promises.opendir(dir);
    } catch {
      continue;
    }

    for await (const dirent of dh) {
      if (signal?.aborted) return;
      const name = dirent.name;
      if (name === '.git') continue;
      const full = path.join(dir, name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.isFile()) {
        yield full;
      }
    }
  }
}

class FileIndexService {
  constructor() {
    this._bySlug = new Map();
  }

  _getWorkspace(slug) {
    let ws = this._bySlug.get(slug);
    if (!ws) {
      ws = {
        status: 'idle',
        startedAt: null,
        builtAt: null,
        error: null,
        metaByPath: new Map(),
        fileList: [],
        tokenHits: new Map(),
        symbols: new Map(),
        nameIndex: [],
        controller: null,
        buildPromise: null,
      };
      this._bySlug.set(slug, ws);
    }
    return ws;
  }

  getStatus(slug) {
    const ws = this._getWorkspace(slug);
    return {
      status: ws.status,
      startedAt: ws.startedAt,
      builtAt: ws.builtAt,
      error: ws.error ? String(ws.error) : null,
      files: ws.fileList.length,
      tokens: ws.tokenHits.size,
      symbols: ws.symbols.size,
    };
  }

  async ensureIndex(slug, repoPath, options = {}) {
    const ws = this._getWorkspace(slug);
    if (ws.status === 'building' && ws.buildPromise) return ws.buildPromise;
    if (ws.status === 'ready' && !options.force) return ws.buildPromise || Promise.resolve();

    if (ws.controller) {
      try { ws.controller.abort(); } catch (_) {}
    }

    ws.controller = new AbortController();
    const signal = ws.controller.signal;

    ws.status = 'building';
    ws.startedAt = Date.now();
    ws.builtAt = null;
    ws.error = null;
    ws.metaByPath = new Map();
    ws.fileList = [];
    ws.tokenHits = new Map();
    ws.symbols = new Map();
    ws.nameIndex = [];

    const maxFileChars = Number.isFinite(options.maxFileChars) ? options.maxFileChars : DEFAULT_MAX_FILE_CHARS;
    const maxTokenHits = Number.isFinite(options.maxTokenHits) ? options.maxTokenHits : DEFAULT_MAX_TOKEN_HITS;

    ws.buildPromise = (async () => {
      let fileCount = 0;
      try {
        for await (const absPath of walkFiles(repoPath, signal)) {
          if (signal.aborted) return;
          fileCount++;
          if (fileCount > DEFAULT_MAX_FILES) break;

          const rel = normalizeRel(path.relative(repoPath, absPath));
          const st = await fs.promises.stat(absPath);

          const ext = extOf(rel);
          const lang = languageForPath(rel);

          const meta = {
            path: rel,
            size: st.size,
            lastModified: st.mtimeMs,
            extension: ext,
            language: lang,
          };

          ws.metaByPath.set(rel, meta);
          ws.fileList.push(meta);
          ws.nameIndex.push({
            path: rel,
            nameLower: (path.basename(rel) || '').toLowerCase(),
            pathLower: rel.toLowerCase(),
          });

          const isText = TEXT_EXTENSIONS.has(ext) || ext === '';
          if (!isText) continue;

          // Stream lines for token/symbol indexing
          await this._indexFile(absPath, rel, lang, { signal, maxFileChars, maxTokenHits, ws });
        }

        if (signal.aborted) return;
        ws.status = 'ready';
        ws.builtAt = Date.now();
      } catch (e) {
        if (signal.aborted) return;
        ws.status = 'error';
        ws.error = e?.message || String(e);
      }
    })();

    return ws.buildPromise;
  }

  async _indexFile(absPath, relPath, lang, { signal, maxFileChars, maxTokenHits, ws }) {
    const stream = fs.createReadStream(absPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lineNumber = 0;
    let approxChars = 0;

    const yieldEvery = 200;

    try {
      for await (const line of rl) {
        if (signal.aborted) break;
        lineNumber++;
        approxChars += (line?.length || 0) + 1;

        const tokens = tokenizeLine(line);
        if (tokens.size) {
          const preview = line.length > 240 ? line.slice(0, 240) + '…' : line;
          for (const t of tokens) {
            let arr = ws.tokenHits.get(t);
            if (!arr) {
              arr = [];
              ws.tokenHits.set(t, arr);
            }
            if (arr.length < maxTokenHits) {
              arr.push({ path: relPath, lineNumber, preview });
            }
          }
        }

        const symbols = extractSymbols(line, lang);
        for (const s of symbols) {
          const key = String(s);
          let arr = ws.symbols.get(key);
          if (!arr) {
            arr = [];
            ws.symbols.set(key, arr);
          }
          if (arr.length < 200 && !arr.includes(relPath)) arr.push(relPath);
        }

        if (approxChars >= maxFileChars) break;
        if (lineNumber % yieldEvery === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
    } finally {
      try { rl.close(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
    }
  }

  search(slug, query, options = {}) {
    const ws = this._getWorkspace(slug);
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { status: ws.status, results: [] };

    const tokens = q.match(/[a-zA-Z_][a-zA-Z0-9_]{1,}/g)?.map((t) => t.toLowerCase()) || [];
    const wantAll = tokens.length >= 2;

    const fileLimit = Number.isFinite(options.limitFiles) ? options.limitFiles : 100;
    const matchLimit = Number.isFinite(options.limitMatchesPerFile) ? options.limitMatchesPerFile : 200;

    // Token-based index-first search
    if (tokens.length) {
      const byFile = new Map(); // path -> { file, matches, tokenSet }

      for (const t of tokens) {
        const hits = ws.tokenHits.get(t);
        if (!hits) continue;
        for (const h of hits) {
          let rec = byFile.get(h.path);
          if (!rec) {
            const meta = ws.metaByPath.get(h.path) || { path: h.path };
            rec = {
              file: {
                path: h.path,
                name: path.basename(h.path),
                language: meta.language,
                size: meta.size,
                lastModified: meta.lastModified,
              },
              matches: [],
              tokenSet: new Set(),
              lineSet: new Set(),
            };
            byFile.set(h.path, rec);
          }
          rec.tokenSet.add(t);
          const lineKey = String(h.lineNumber);
          if (!rec.lineSet.has(lineKey) && rec.matches.length < matchLimit) {
            rec.lineSet.add(lineKey);
            rec.matches.push({ lineNumber: h.lineNumber, preview: h.preview });
          }
        }
      }

      let list = Array.from(byFile.values());
      if (wantAll) {
        list = list.filter((r) => tokens.every((t) => r.tokenSet.has(t)));
      }

      list.sort((a, b) => {
        const at = a.tokenSet.size;
        const bt = b.tokenSet.size;
        if (bt !== at) return bt - at;
        return (a.file.path || '').localeCompare(b.file.path || '');
      });

      const results = list.slice(0, fileLimit).map((r) => ({
        file: r.file,
        matches: r.matches,
        matchCount: r.matches.length,
      }));

      return { status: ws.status, results };
    }

    // Path-only lookup fallback (still index-based; no disk reads)
    const results = this.fileLookup(slug, q, { limit: fileLimit }).results.map((f) => ({
      file: { path: f.path, name: path.basename(f.path) },
      matches: [],
      matchCount: 0,
    }));

    return { status: ws.status, results };
  }

  fileLookup(slug, query, options = {}) {
    const ws = this._getWorkspace(slug);
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { status: ws.status, results: [] };
    const limit = Number.isFinite(options.limit) ? options.limit : 100;

    const out = [];
    for (const rec of ws.nameIndex) {
      if (rec.nameLower.includes(q) || rec.pathLower.includes(q)) {
        out.push({ path: rec.path });
        if (out.length >= limit) break;
      }
    }
    return { status: ws.status, results: out };
  }
}

module.exports = new FileIndexService();
