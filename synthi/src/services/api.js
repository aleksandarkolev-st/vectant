// src/services/api.js

import SynthiException from "@/components/SynthiException";

function languageFromExtension(ext) {
    const m = {
        js: 'javascript',
        jsx: 'javascript',
        ts: 'typescript',
        tsx: 'typescript',
        py: 'python',
        rs: 'rust',
        json: 'json',
        md: 'markdown',
        txt: 'plaintext',
        html: 'html',
        css: 'css',
        yml: 'yaml',
        yaml: 'yaml',
        toml: 'toml',
    };
    return m[String(ext || '').toLowerCase()] || (ext ? String(ext).toLowerCase() : 'plaintext');
}

function buildTreeFromFlatMeta(flatFiles) {
    const ignoredPrefixes = [
        '.git/',
        'node_modules/',
        '.next/',
        'dist/',
        'build/',
        'out/',
        '.cache/',
        '.turbo/',
        '.code_intel/',
        '.code_intel_backups/',
        '.synthi/',
    ];
    const root = { name: 'root', isFolder: true, children: [], path: '' };
    const files = Array.isArray(flatFiles) ? flatFiles : [];

    for (const f of files) {
        const relPath = String(f.path || '').replace(/\\/g, '/');
        if (ignoredPrefixes.some((prefix) => relPath.startsWith(prefix))) continue;
        if (!relPath) continue;
        const parts = relPath.split('/').filter(Boolean);
        let currentNode = root;
        let cumulativePath = '';

        for (let i = 0; i < parts.length; i++) {
            const partName = parts[i];
            const isLast = i === parts.length - 1;
            const markerIsFolder = f && f.isFolder === true;
            const isFolder = markerIsFolder ? true : !isLast;
            cumulativePath = cumulativePath ? `${cumulativePath}/${partName}` : partName;

            let child = currentNode.children.find(c => c.name === partName);
            if (!child) {
                child = {
                    name: partName,
                    path: cumulativePath,
                    isFolder,
                    children: isFolder ? [] : undefined,
                };
                currentNode.children.push(child);
            }

            // If this is a folder marker, ensure folder shape even if it already existed as a file path segment.
            if (markerIsFolder) {
                child.isFolder = true;
                if (!child.children) child.children = [];
            }

            if (isLast && !isFolder) {
                const ext = (f.extension || partName.split('.').pop() || '').toLowerCase();
                child.size = Number(f.size) || 0;
                child.lastModified = Number(f.lastModified) || null;
                child.extension = ext;
                child.language = f.language || languageFromExtension(ext);
            }

            if (isFolder) currentNode = child;
        }
    }

    return root.children;
}

export class ApiClient {
    constructor(baseUrl = '/api/workspace') {
        this.baseUrl = baseUrl;
    }

    async _handleResponse(response) {
        if (!response.ok) {
            let errorData = {};
            try {
                errorData = await response.json();
            } catch (e) {
                // Ignore if response isn't JSON
            }
            throw new SynthiException(errorData.error || `API Error: ${response.statusText}`, `Status: ${response.status}`);
        }
        return response;
    }

    // READ
    async fetchFiles(slug) {
        const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';

        // Prefer collab-server metadata (disk-backed, fast, no contents)
        try {
            const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/files-meta`);
            if (res.ok) {
                const data = await res.json();
                const tree = buildTreeFromFlatMeta(data.files);
                // Ensure index build in background (non-blocking)
                try { this.ensureIndex(slug); } catch (_) {}
                return tree;
            }
        } catch (e) {
            // fall back to storage
        }

        const response = await fetch(`${this.baseUrl}/${slug}`);
        const data = await this._handleResponse(response).then(r => r.json());
        try { this.ensureIndex(slug); } catch (_) {}
        return data.files;
    }

    async ensureIndex(slug) {
        try {
            const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';
            // Fire and forget; must not block UI.
            fetch(`${COLLAB_SERVER_URL}/git/${slug}/index-ensure`).catch(() => {});
        } catch (_) {
            // ignore
        }

        // Same-origin fallback index (works even if collab-server is not running)
        try {
            fetch(`${this.baseUrl}/${slug}/index/ensure`).catch(() => {});
        } catch (_) {
            // ignore
        }
    }

    async searchIndex(slug, query, options = {}) {
        const q = String(query || '');

        // 1) Prefer collab-server index when available
        try {
            const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';
            const url = `${COLLAB_SERVER_URL}/git/${slug}/search?q=${encodeURIComponent(q)}`;
            const res = await fetch(url, { signal: options.signal });
            if (res.ok) return await res.json();
        } catch (_) {
            // fall back
        }

        // 2) Same-origin index fallback (never throws network errors to UI)
        try {
            const res2 = await fetch(`${this.baseUrl}/${slug}/search?q=${encodeURIComponent(q)}`, { signal: options.signal });
            if (!res2.ok) return { status: 'error', results: [] };
            return await res2.json();
        } catch (_) {
            return { status: 'error', results: [] };
        }
    }

    async fetchFileContent(slug, filePath, options = {}) {
        // Try fetching from Collab Server first (Source of Truth for Git)
        try {
             const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';
             const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/file?path=${encodeURIComponent(filePath)}`, { signal: options.signal });
             if (res.ok) {
                 const data = await res.json();
                 if (typeof data.content === 'string') {
                     return data.content;
                 }
             }
        } catch (e) {
            console.warn("Failed to fetch from collab server, falling back to storage", e);
        }

        const response = await fetch(`${this.baseUrl}/${slug}/item?filePath=${encodeURIComponent(filePath)}`, { signal: options.signal });
        return this._handleResponse(response).then(r => r.text());
    }

    async fetchFileImports(slug, filePath, options = {}) {
        try {
            const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';
            const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/imports?path=${encodeURIComponent(filePath)}`, { signal: options.signal });
            if (res.ok) return await res.json();
        } catch (_) {
            // fall back
        }
        return { status: 'error', file: filePath, imports: [], resolved: [] };
    }

    // READ (Storage only; skips collab server)
    async fetchFileContentStorageOnly(slug, filePath, options = {}) {
        const response = await fetch(
            `${this.baseUrl}/${slug}/item?filePath=${encodeURIComponent(filePath)}`,
            { signal: options.signal }
        );
        return this._handleResponse(response).then(r => r.text());
    }

    // MUTATIONS (Write Operations)
    async saveFileContent(slug, filePath, content, fileName) {
        const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';

        // Try collab-server first (source of truth for local filesystem / file tree)
        try {
            const collabRes = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/write-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath, content }),
            });
            if (collabRes.ok) {
                // Also save to GCS in background for persistence
                (async () => {
                    try {
                        const formData = new FormData();
                        const blob = new Blob([content], { type: 'text/plain' });
                        formData.append('file', blob, fileName);
                        formData.append('filePath', filePath);
                        await fetch(`${this.baseUrl}/${slug}/item/`, { method: 'POST', body: formData });
                    } catch (_) {}
                })();
                return { ok: true };
            }
        } catch (e) {
            console.warn('[saveFileContent] Collab-server write failed, using GCS:', e.message);
        }

        // Fallback to GCS
        const formData = new FormData();
        const blob = new Blob([content], { type: 'text/plain' });
        formData.append('file', blob, fileName);
        formData.append('filePath', filePath);
      
        // This runs in background, returning an early positive -> IIFE
        (async () => {
          try {
            const res = await fetch(`${this.baseUrl}/${slug}/item/`, {
              method: 'POST',
              body: formData,
            });
            await this._handleResponse(res);
          } catch (err) {
            console.error('Background save failed:', err);
          }
        })();
        return { ok: true, optimistic: true };
    }

    async createItem(slug, fullPath, isFolder) {
        const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';

        // Try collab-server first (source of truth for local filesystem / file tree)
        try {
            if (isFolder) {
                const collabRes = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/create-directory`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: fullPath }),
                });
                if (collabRes.ok) return await collabRes.json();
            } else {
                const collabRes = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/write-file`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: fullPath, content: '' }),
                });
                if (collabRes.ok) return await collabRes.json();
            }
        } catch (e) {
            console.warn('[createItem] Collab-server failed, falling back to GCS:', e.message);
        }

        // Fallback to GCS storage
        const formData = new FormData();
        const fileName = fullPath.split('/').pop();
        const blob = new Blob([''], { type: 'text/plain' });
        formData.append('file', blob, fileName);
        formData.append('filePath', isFolder ? `${fullPath}/` : fullPath);

        const response = await fetch(`${this.baseUrl}/${slug}/item`, {
            method: 'POST',
            body: formData,
        });
        return this._handleResponse(response);
    }

    async renameItem(slug, itemPath, newPath) {
        const response = await fetch(`${this.baseUrl}/${slug}/item`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemPath, newPath }),
        });
        return this._handleResponse(response);
    }

    async deleteItem(slug, itemPath) {
        const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';
        
        // Clean the path - remove trailing slash for collab-server
        const cleanPath = itemPath.endsWith('/') ? itemPath.slice(0, -1) : itemPath;
        
        console.log('[api.deleteItem] Trying collab-server first:', slug, cleanPath);
        
        // Try collab-server first (handles local files from worker)
        try {
            const collabRes = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/delete-item`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: cleanPath }),
            });
            console.log('[api.deleteItem] Collab-server response status:', collabRes.status);
            
            if (collabRes.ok) {
                const result = await collabRes.json();
                console.log('[api.deleteItem] Collab-server result:', result);
                if (result.deleted > 0) {
                    return result;
                }
                // If deleted === 0 and not an error, the file wasn't on collab-server
                // Fall through to try GCS
            } else {
                const errText = await collabRes.text();
                console.warn('[api.deleteItem] Collab-server error:', collabRes.status, errText);
            }
        } catch (e) {
            // Collab-server unavailable, fall through to GCS
            console.warn('[api.deleteItem] Collab-server request failed:', e.message);
        }
        
        console.log('[api.deleteItem] Falling back to GCS for:', itemPath);
        
        // Fall back to GCS storage
        const response = await fetch(`${this.baseUrl}/${slug}/item`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemPath }),
        });
        return this._handleResponse(response);
    }
}

export const api = new ApiClient();
