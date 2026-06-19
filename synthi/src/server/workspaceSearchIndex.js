import readline from 'node:readline';
import path from 'node:path';
import { createGcsStorage, getGcsBucketName } from '@/server/gcsStorage';

const storage = createGcsStorage();

const BUCKET_NAME = getGcsBucketName('my-workspace-content-bucket');

const DEFAULT_MAX_FILE_CHARS = 2_000_000;
const DEFAULT_MAX_TOKEN_HITS = 400;

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

function extOf(relPath) {
  const base = (relPath || '').split('/').pop() || '';
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

function languageForPath(relPath) {
  const ext = extOf(relPath);
  return EXT_LANGUAGE[ext] || (ext ? ext : 'plaintext');
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

function normalizeRelFromGcs(gcsName, prefix) {
  return String(gcsName || '').substring(prefix.length).replace(/\\/g, '/');
}

class WorkspaceSearchIndex {
  constructor() {
    this._byWorkspace = new Map();
  }

  _ws(id) {
    let ws = this._byWorkspace.get(id);
    if (!ws) {
      ws = {
        status: 'idle',
        startedAt: null,
        builtAt: null,
        error: null,
        tokenHits: new Map(),
        nameIndex: [],
        metaByPath: new Map(),
        controller: null,
        buildPromise: null,
      };
      this._byWorkspace.set(id, ws);
    }
    return ws;
  }

  status(id) {
    const ws = this._ws(id);
    return {
      status: ws.status,
      startedAt: ws.startedAt,
      builtAt: ws.builtAt,
      error: ws.error ? String(ws.error) : null,
      tokens: ws.tokenHits.size,
      files: ws.metaByPath.size,
    };
  }

  ensure(id, options = {}) {
    const ws = this._ws(id);
    if (ws.status === 'building' && ws.buildPromise) return ws.buildPromise;
    if (ws.status === 'ready' && !options.force) return ws.buildPromise || Promise.resolve();

    if (ws.controller) {
      try { ws.controller.abort(); } catch (_) {}
    }
    ws.controller = new AbortController();

    ws.status = 'building';
    ws.startedAt = Date.now();
    ws.builtAt = null;
    ws.error = null;
    ws.tokenHits = new Map();
    ws.nameIndex = [];
    ws.metaByPath = new Map();

    const maxFileChars = Number.isFinite(options.maxFileChars) ? options.maxFileChars : DEFAULT_MAX_FILE_CHARS;
    const maxTokenHits = Number.isFinite(options.maxTokenHits) ? options.maxTokenHits : DEFAULT_MAX_TOKEN_HITS;

    // Kick off in background; return a promise for callers that do await.
    ws.buildPromise = (async () => {
      const signal = ws.controller.signal;
      try {
        const bucket = storage.bucket(BUCKET_NAME);
        const prefix = `workspaces/${id}/`;
        const [files] = await bucket.getFiles({ prefix, autoPaginate: true });

        for (const f of files) {
          if (signal.aborted) return;
          const rel = normalizeRelFromGcs(f.name, prefix);
          if (!rel) continue;
          if (rel.endsWith('/')) continue;

          const ext = extOf(rel);
          const lang = languageForPath(rel);

          let meta;
          try {
            const [md] = await f.getMetadata();
            const size = Number(md.size) || 0;
            const updated = md.updated ? Date.parse(md.updated) : null;
            meta = { path: rel, size, lastModified: Number.isFinite(updated) ? updated : null, extension: ext, language: lang };
          } catch {
            meta = { path: rel, size: 0, lastModified: null, extension: ext, language: lang };
          }

          ws.metaByPath.set(rel, meta);
          ws.nameIndex.push({
            path: rel,
            nameLower: (path.basename(rel) || '').toLowerCase(),
            pathLower: rel.toLowerCase(),
          });

          const isText = TEXT_EXTENSIONS.has(ext) || ext === '';
          if (!isText) continue;

          await this._indexFile(f, rel, { ws, signal, maxFileChars, maxTokenHits });
        }

        if (signal.aborted) return;
        ws.status = 'ready';
        ws.builtAt = Date.now();
      } catch (e) {
        if (ws.controller?.signal?.aborted) return;
        ws.status = 'error';
        ws.error = e?.message || String(e);
      }
    })();

    return ws.buildPromise;
  }

  async _indexFile(gcsFile, relPath, { ws, signal, maxFileChars, maxTokenHits }) {
    const stream = gcsFile.createReadStream();
    stream.setEncoding('utf8');

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

  search(id, query, options = {}) {
    const ws = this._ws(id);
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { status: ws.status, results: [] };

    const tokens = q.match(/[a-zA-Z_][a-zA-Z0-9_]{1,}/g)?.map((t) => t.toLowerCase()) || [];
    const wantAll = tokens.length >= 2;

    const fileLimit = Number.isFinite(options.limitFiles) ? options.limitFiles : 100;
    const matchLimit = Number.isFinite(options.limitMatchesPerFile) ? options.limitMatchesPerFile : 200;

    if (ws.status !== 'ready') {
      return { status: ws.status, results: [] };
    }

    if (tokens.length) {
      const byFile = new Map();

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

    // Path/name fallback lookup (index-only)
    const out = [];
    for (const rec of ws.nameIndex) {
      if (rec.nameLower.includes(q) || rec.pathLower.includes(q)) {
        out.push({
          file: { path: rec.path, name: path.basename(rec.path) },
          matches: [],
          matchCount: 0,
        });
        if (out.length >= fileLimit) break;
      }
    }

    return { status: ws.status, results: out };
  }
}

export const workspaceSearchIndex = new WorkspaceSearchIndex();
