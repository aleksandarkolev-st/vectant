// src/services/api.js

import { getSession } from 'next-auth/react';
import SynthiException from "@/components/SynthiException";
import collabSessionService from '@/services/collabSessionService';
import { getWorkspaceRuntimeIdentity } from '@/services/runtimeScope';
import { resolveCollabHttpUrl } from '@/lib/collab-url';

/**
 * Parse an error response body and extract a human-readable message.
 * If the body is JSON with a `message` field, return that; otherwise return raw text.
 */
function parseErrorText(raw) {
    if (!raw) return 'Unknown error';
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.message === 'string') {
            return parsed.message;
        }
    } catch (_) { /* not JSON, use raw */ }
    return raw;
}

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

// Centralized collab-server URL — the single source of truth for file data.
// All file reads/writes go through the collab-server to prevent dual-source
// inconsistencies between GCS and disk.
const COLLAB_SERVER_URL = resolveCollabHttpUrl();

export class ApiClient {
    constructor() {
        // All methods use the module-level COLLAB_SERVER_URL constant
    }

    /**
     * Build common headers for collab-server requests.
     * Attaches x-user-id so the server routes to the per-user repo.
     */
    async _headers(extra = {}, { workspaceSlug = null } = {}) {
        const base = { ...extra };
        try {
            const session = await getSession();
            const userId = session?.user?.id || session?.user?.email;
            if (userId) base['x-user-id'] = userId;
            if (collabSessionService?.isActive && collabSessionService.sessionId) {
                base['x-session-id'] = collabSessionService.sessionId;
            }
            if (workspaceSlug) {
                const runtimeIdentity = getWorkspaceRuntimeIdentity(workspaceSlug, { userId });
                if (runtimeIdentity.runtimeScope) base['x-runtime-scope'] = runtimeIdentity.runtimeScope;
                if (runtimeIdentity.runtimeKind) base['x-runtime-kind'] = runtimeIdentity.runtimeKind;
                if (runtimeIdentity.filesystemUserId) base['x-runtime-fs-user-id'] = runtimeIdentity.filesystemUserId;
            }
        } catch (_) {
            // Non-fatal — server falls back to slug-level repo
        }
        return base;
    }

    // READ
    async fetchFiles(slug) {
        // Always fetch from collab-server (disk-backed, authoritative source).
        // No GCS fallback — if collab-server is down, surface the error so the
        // user knows the system is unavailable rather than showing stale data.
        const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/files-meta`, {
            headers: await this._headers(),
        });
        if (!res.ok) {
            throw new SynthiException(
                `Failed to load workspace files (status ${res.status})`,
                'The collaboration server may be unavailable. Please try again.'
            );
        }
        const data = await res.json();
        const tree = buildTreeFromFlatMeta(data.files);
        // Ensure index build in background (non-blocking)
        try { this.ensureIndex(slug); } catch (_) {}
        return tree;
    }

    async ensureIndex(slug) {
        try {
            // Fire and forget; must not block UI.
            this._headers().then(h => fetch(`${COLLAB_SERVER_URL}/git/${slug}/index-ensure`, { headers: h })).catch(() => {});
        } catch (_) {
            // ignore
        }
    }

    async getWorkspacePrepStatus(slug) {
        const res = await fetch(`${COLLAB_SERVER_URL}/api/workspace/${encodeURIComponent(slug)}/prepare`, {
            headers: await this._headers(),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new SynthiException(`Failed to load workspace prep status (status ${res.status})`, parseErrorText(errText));
        }
        return res.json();
    }

    async prepareWorkspace(slug, { force = false } = {}) {
        const suffix = force ? '?force=true' : '';
        const res = await fetch(`${COLLAB_SERVER_URL}/api/workspace/${encodeURIComponent(slug)}/prepare${suffix}`, {
            method: 'POST',
            headers: await this._headers(),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new SynthiException(`Failed to trigger workspace prep (status ${res.status})`, parseErrorText(errText));
        }
        return res.json();
    }

    async searchIndex(slug, query, options = {}) {
        const q = String(query || '');

        // Prefer collab-server index
        try {
            const url = `${COLLAB_SERVER_URL}/git/${slug}/search?q=${encodeURIComponent(q)}`;
            const res = await fetch(url, { headers: await this._headers(), signal: options.signal });
            if (res.ok) return await res.json();
        } catch (_) {
            // fall back
        }

        return { status: 'error', results: [] };
    }

    async fetchFileContent(slug, filePath, options = {}) {
        // Always fetch from collab-server (authoritative disk source).
        // No GCS fallback — prevents dual-source inconsistency.
        // Normalize path: convert backslashes to forward slashes and strip leading slash
        const safePath = (filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/file?path=${encodeURIComponent(safePath)}`, { headers: await this._headers(), signal: options.signal });
        if (!res.ok) {
            throw new SynthiException(
                `Failed to load file content (status ${res.status})`,
                `Could not read ${filePath} from the collaboration server.`
            );
        }
        const data = await res.json();
        if (typeof data.content === 'string') {
            return data.content;
        }
        throw new SynthiException('Invalid response', 'File content response was not a string.');
    }

    async fetchFileImports(slug, filePath, options = {}) {
        try {
            const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/imports?path=${encodeURIComponent(filePath)}`, { headers: await this._headers(), signal: options.signal });
            if (res.ok) return await res.json();
        } catch (_) {
            // fall back
        }
        return { status: 'error', file: filePath, imports: [], resolved: [] };
    }

    // MUTATIONS (Write Operations)
    async saveFileContent(slug, filePath, content, fileName) {
        // Write through the collab-server which handles:
        // 1. Writing to disk (repos/{slug}/{filePath})
        // 2. Auto-flushing to GCS (if configured)
        // 3. Keeping Yjs state consistent
        // This replaces the old fire-and-forget GCS upload pattern that caused
        // dual-source inconsistency.
        const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/sync`, {
            method: 'POST',
            headers: await this._headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ filePath, content }),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new SynthiException(`Failed to save file (status ${res.status})`, parseErrorText(errText));
        }
        return { ok: true };
    }

    async createItem(slug, fullPath, isFolder) {
        if (isFolder) {
            // Create directory via collab-server
            const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/create-directory`, {
                method: 'POST',
                headers: await this._headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ path: fullPath }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'Unknown error');
                throw new SynthiException(`Failed to create directory (status ${res.status})`, parseErrorText(errText));
            }
            return res.json();
        } else {
            // Create an empty file via the write-file endpoint
            const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/write-file`, {
                method: 'POST',
                headers: await this._headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ path: fullPath, content: '' }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'Unknown error');
                throw new SynthiException(`Failed to create file (status ${res.status})`, parseErrorText(errText));
            }
            return res.json();
        }
    }

    async renameItem(slug, oldPath, newPath) {
        const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/rename-item`, {
            method: 'POST',
            headers: await this._headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ oldPath, newPath }),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new SynthiException(`Failed to rename item (status ${res.status})`, parseErrorText(errText));
        }
        return res.json();
    }

    async deleteItem(slug, itemPath) {
        // Clean the path - remove trailing slash for collab-server
        const cleanPath = itemPath.endsWith('/') ? itemPath.slice(0, -1) : itemPath;

        const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/delete-item`, {
            method: 'POST',
            headers: await this._headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path: cleanPath }),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new SynthiException(`Failed to delete item (status ${res.status})`, parseErrorText(errText));
        }
        return res.json();
    }

    async execTerminalCommand(slug, command, { timeout = 300000 } = {}) {
        const trimmed = String(command || '').trim();
        if (!trimmed) {
            throw new SynthiException('Missing command', 'No workspace command was provided.');
        }

        const headers = await this._headers({ 'Content-Type': 'application/json' }, { workspaceSlug: slug });
        const body = JSON.stringify({
            command: trimmed,
            timeout,
            runtimeScope: headers['x-runtime-scope'] || null,
            runtimeKind: headers['x-runtime-kind'] || null,
            filesystemUserId: headers['x-runtime-fs-user-id'] || null,
        });
        const signal =
            typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(timeout + 5000)
                : undefined;

        let res;
        let usedTerminal = false;

        try {
            res = await fetch(`${COLLAB_SERVER_URL}/exec-terminal/${encodeURIComponent(slug)}`, {
                method: 'POST',
                headers,
                body,
                signal,
            });
            usedTerminal = res.ok;
        } catch (_) {
            res = null;
        }

        if (!usedTerminal) {
            res = await fetch(`${COLLAB_SERVER_URL}/exec/${encodeURIComponent(slug)}`, {
                method: 'POST',
                headers,
                body,
                signal,
            });
        }

        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new SynthiException(`Failed to execute workspace command (status ${res.status})`, parseErrorText(errText));
        }

        const data = await res.json();
        return {
            command: trimmed,
            exitCode: data.exitCode ?? null,
            output: usedTerminal
                ? (data.output || '')
                : `${data.stdout || ''}${data.stderr ? `\n[stderr]\n${data.stderr}` : ''}`,
            sessionId: data.sessionId || null,
            timedOut: Boolean(data.timedOut),
        };
    }
}

export const api = new ApiClient();
