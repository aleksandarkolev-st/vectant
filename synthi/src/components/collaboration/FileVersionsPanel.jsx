"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, RotateCcw, AlertTriangle, Loader2, Eye, ArrowLeft, Check } from 'lucide-react';
import { toast } from 'sonner';
import { diffLines } from 'diff';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import collabSessionService from '@/services/collabSessionService';
import { getCurrentUser } from '@/services/userIdentity';

const COLLAB_URL = (
  process.env.NEXT_PUBLIC_COLLAB_SERVER_URL ||
  process.env.NEXT_PUBLIC_COLLAB_URL ||
  process.env.NEXT_PUBLIC_YJS_URL ||
  'http://localhost:1234'
).replace(/^ws/, 'http').replace(/\/$/, '');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const delta = Date.now() - d.getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return d.toLocaleString();
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shortHash(h) {
  return typeof h === 'string' ? h.slice(0, 7) : '';
}

// Collapse consecutive unchanged lines into "… N unchanged lines …" rows so
// the preview doesn't scroll past untouched regions of large files.
function collapseUnchanged(parts, context = 2) {
  const out = [];
  parts.forEach((part) => {
    if (part.added || part.removed) {
      out.push(part);
      return;
    }
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length <= context * 2 + 1) {
      out.push({ ...part, _lines: lines });
      return;
    }
    out.push({ value: '', _lines: lines.slice(0, context) });
    out.push({ _gap: lines.length - context * 2 });
    out.push({ value: '', _lines: lines.slice(-context) });
  });
  return out;
}

function computeDiffStats(parts) {
  let added = 0;
  let removed = 0;
  parts.forEach((p) => {
    const count = p.count || (p.value ? p.value.split('\n').filter(Boolean).length : 0);
    if (p.added) added += count;
    else if (p.removed) removed += count;
  });
  return { added, removed };
}

/**
 * FileVersionsPanel — history dropdown for the currently-open file.
 *
 * Two views:
 *   1. List — stored snapshots from collab-server's durable persistence
 *      (GET /file-versions/:slug?filePath=...).
 *   2. Preview — content of a single snapshot (GET /file-version/:slug?...)
 *      diffed against the current saved state, with an inline Restore CTA.
 *
 * Restore (POST /file-version/restore) mirrors backend semantics: solo users
 * restore their own repo; inside a session the host owns the target repo and
 * guests need canEdit.  The panel does not enforce this itself — the server
 * returns 403 when the caller lacks permission, and we surface the message.
 */
export default function FileVersionsPanel({ slug, filePath }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState([]);
  const [error, setError] = useState(null);
  const [restoringIndex, setRestoringIndex] = useState(null);
  const [view, setView] = useState('list'); // 'list' | 'preview'
  const [preview, setPreview] = useState(null); // { version, content, baseContent }
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const abortRef = useRef(null);
  const previewAbortRef = useRef(null);

  const disabled = !slug || !filePath;

  const fetchVersions = useCallback(async () => {
    if (!slug || !filePath) return;
    if (abortRef.current) abortRef.current.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setLoading(true);
    setError(null);
    try {
      const url = `${COLLAB_URL}/file-versions/${encodeURIComponent(slug)}?filePath=${encodeURIComponent(filePath)}`;
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const payload = await res.json();
      // The server returns snapshots in newest-first order but doesn't
      // attach an index field — position in the list IS the index, and
      // /file-version/:slug?index=N looks them up by that position.
      const list = Array.isArray(payload?.versions)
        ? payload.versions.map((v, i) => ({ ...v, index: i }))
        : [];
      setVersions(list);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [slug, filePath]);

  // Refresh every time the popover opens or the active file changes
  // while open.  Also reset preview state so the panel always lands in
  // the list view when re-opened.
  useEffect(() => {
    if (open) {
      fetchVersions();
    } else {
      setView('list');
      setPreview(null);
      setPreviewError(null);
    }
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [open, fetchVersions]);

  const openPreview = useCallback(async (version) => {
    if (!version || !Number.isFinite(version.index)) return;
    setView('preview');
    setPreview({ version, content: null, baseContent: null });
    setPreviewError(null);

    if (!version.hasContent) {
      setPreviewError('This snapshot is metadata-only (content exceeded the stored-size cap).');
      return;
    }

    if (previewAbortRef.current) previewAbortRef.current.abort();
    const ctl = new AbortController();
    previewAbortRef.current = ctl;
    setPreviewLoading(true);
    try {
      // Fetch the snapshot content, plus the current saved content for diff.
      // The "current" baseline is the latest snapshot (index 0).  When the
      // user is previewing index 0 itself, skip the baseline request.
      const targetUrl = `${COLLAB_URL}/file-version/${encodeURIComponent(slug)}?filePath=${encodeURIComponent(filePath)}&index=${version.index}`;
      const requests = [fetch(targetUrl, { signal: ctl.signal }).then((r) => r.json())];
      if (version.index !== 0 && versions[0]?.hasContent) {
        const baseUrl = `${COLLAB_URL}/file-version/${encodeURIComponent(slug)}?filePath=${encodeURIComponent(filePath)}&index=0`;
        requests.push(fetch(baseUrl, { signal: ctl.signal }).then((r) => r.json()));
      }
      const [targetPayload, basePayload] = await Promise.all(requests);
      const targetContent = targetPayload?.version?.content;
      const baseContent = basePayload?.version?.content ?? null;
      if (typeof targetContent !== 'string') {
        throw new Error(targetPayload?.error || 'snapshot content unavailable');
      }
      setPreview({ version, content: targetContent, baseContent });
    } catch (e) {
      if (e.name !== 'AbortError') setPreviewError(e.message || String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, [slug, filePath, versions]);

  const closePreview = useCallback(() => {
    if (previewAbortRef.current) previewAbortRef.current.abort();
    setView('list');
    setPreview(null);
    setPreviewError(null);
  }, []);

  const restore = useCallback(async (version) => {
    if (!version || !Number.isFinite(version.index)) return;
    if (!version.hasContent) {
      toast.error('That snapshot is metadata-only (content was too large to store).');
      return;
    }
    const { id: userId } = getCurrentUser();
    const sessionId = collabSessionService.sessionId || null;
    setRestoringIndex(version.index);
    try {
      const res = await fetch(`${COLLAB_URL}/file-version/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          slug,
          filePath,
          index: version.index,
          userId,
          sessionId,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = payload?.error || payload?.message || `restore failed (${res.status})`;
        throw new Error(msg);
      }
      toast.success(`Restored ${filePath} to ${shortHash(version.hash)}`);
      setOpen(false);
      // The backend writes to disk, resets the CRDT, and broadcasts a
      // doc-invalidated notification so any live editor destroys its stale
      // Y.Doc and reconnects to Y-Sweet with the freshly-written content.
      fetchVersions();
    } catch (e) {
      toast.error(e.message || 'Restore failed');
    } finally {
      setRestoringIndex(null);
    }
  }, [slug, filePath, fetchVersions]);

  const buttonTitle = useMemo(() => (
    disabled
      ? 'Open a file to see its version history'
      : `History for ${filePath}`
  ), [disabled, filePath]);

  return (
    <Popover open={open} onOpenChange={(v) => !disabled && setOpen(v)}>
      <PopoverTrigger asChild>
        <button
          disabled={disabled}
          className={
            disabled
              ? 'flex items-center gap-1 px-2 py-1 rounded-lg border border-transparent opacity-40 cursor-not-allowed'
              : 'flex items-center gap-1 px-2 py-1 rounded-lg border border-transparent hover:bg-white/5 transition-all'
          }
          style={{ color: 'var(--text-muted)' }}
          title={buttonTitle}
          aria-label={buttonTitle}
        >
          <History className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[420px] p-0 rounded-xl border overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border-medium)',
          boxShadow: 'var(--shadow-dropdown)',
        }}
        align="end"
      >
        {view === 'list' && (
          <ListView
            filePath={filePath}
            loading={loading}
            error={error}
            versions={versions}
            restoringIndex={restoringIndex}
            onRefresh={fetchVersions}
            onPreview={openPreview}
          />
        )}
        {view === 'preview' && preview && (
          <PreviewView
            filePath={filePath}
            version={preview.version}
            content={preview.content}
            baseContent={preview.baseContent}
            loading={previewLoading}
            error={previewError}
            restoring={restoringIndex === preview.version.index}
            onBack={closePreview}
            onRestore={() => restore(preview.version)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── List view ─────────────────────────────────────────────────────────────

function ListView({ filePath, loading, error, versions, restoringIndex, onRefresh, onPreview }) {
  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <div
          className="text-xs font-semibold flex items-center gap-1.5"
          style={{ color: 'var(--text-primary)' }}
        >
          <History className="w-3.5 h-3.5" />
          Version history
        </div>
        <button
          onClick={onRefresh}
          className="text-[10px] px-2 py-1 rounded transition-colors"
          style={{
            color: 'var(--text-secondary)',
            background: 'var(--bg-surface)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
          title="Refresh"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div
        className="text-[10px] truncate mb-3 font-mono"
        style={{ color: 'var(--text-muted)' }}
      >
        {filePath || 'No file open'}
      </div>

      {loading && versions.length === 0 && (
        <div
          className="flex items-center justify-center py-6"
          style={{ color: 'var(--text-muted)' }}
        >
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          <span className="text-xs">Loading versions…</span>
        </div>
      )}

      {error && (
        <div
          className="flex items-start gap-1.5 p-2 rounded-lg text-xs mb-2"
          style={{
            background: 'var(--accent-danger-soft)',
            color: 'var(--accent-danger)',
          }}
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {!loading && !error && versions.length === 0 && (
        <div
          className="flex flex-col items-center justify-center py-6 text-center"
          style={{ color: 'var(--text-muted)' }}
        >
          <History className="w-6 h-6 mb-2 opacity-60" />
          <div className="text-xs font-medium">No history yet</div>
          <div className="text-[10px] mt-1 opacity-80">
            Save this file a few times — snapshots show up here.
          </div>
        </div>
      )}

      <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
        {versions.map((v) => (
          <VersionRow
            key={`${v.index}:${v.hash || v.ts}`}
            version={v}
            busy={restoringIndex === v.index}
            onPreview={() => onPreview(v)}
          />
        ))}
      </div>
    </div>
  );
}

function VersionRow({ version: v, busy, onPreview }) {
  const isLatest = v.index === 0;
  const metaOnly = !v.hasContent;
  const clickable = !metaOnly && !busy;

  return (
    <button
      onClick={clickable ? onPreview : undefined}
      disabled={!clickable}
      className="w-full text-left flex items-start gap-2 p-2 rounded-lg transition-all border"
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
        cursor: clickable ? 'pointer' : 'default',
        opacity: metaOnly ? 0.7 : 1,
      }}
      onMouseEnter={(e) => {
        if (clickable) {
          e.currentTarget.style.borderColor = 'var(--accent-primary)';
          e.currentTarget.style.background = 'var(--bg-panel)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
        e.currentTarget.style.background = 'var(--bg-surface)';
      }}
      title={metaOnly ? 'Content unavailable for this snapshot' : 'Preview & compare'}
    >
      <div className="flex-1 min-w-0">
        <div
          className="flex items-center gap-1.5 text-xs font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          <span>{fmtTime(v.ts)}</span>
          {isLatest && (
            <span
              className="text-[9px] px-1.5 py-px rounded"
              style={{
                background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)',
                color: 'var(--accent-tertiary)',
              }}
            >
              current
            </span>
          )}
          {metaOnly && (
            <span
              className="text-[9px] px-1.5 py-px rounded"
              style={{
                background: 'color-mix(in srgb, var(--accent-warning) 20%, transparent)',
                color: 'var(--accent-warning)',
              }}
              title="Content not stored (exceeded size cap)"
            >
              metadata only
            </span>
          )}
        </div>
        <div
          className="text-[10px] flex items-center gap-1.5 mt-0.5"
          style={{ color: 'var(--text-muted)' }}
        >
          {v.hash && <span className="font-mono">{shortHash(v.hash)}</span>}
          {Number.isFinite(v.size) && <span>·</span>}
          {Number.isFinite(v.size) && <span>{fmtBytes(v.size)}</span>}
          {v.userId && <span>·</span>}
          {v.userId && <span className="truncate">{v.userId}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 pt-0.5">
        {clickable && (
          <Eye
            className="w-3.5 h-3.5"
            style={{ color: 'var(--text-muted)' }}
          />
        )}
        {busy && (
          <Loader2
            className="w-3.5 h-3.5 animate-spin"
            style={{ color: 'var(--accent-primary)' }}
          />
        )}
      </div>
    </button>
  );
}

// ── Preview view ──────────────────────────────────────────────────────────

function PreviewView({
  filePath,
  version,
  content,
  baseContent,
  loading,
  error,
  restoring,
  onBack,
  onRestore,
}) {
  const diffParts = useMemo(() => {
    if (typeof content !== 'string') return null;
    if (typeof baseContent !== 'string' || version.index === 0) return null;
    // Diff direction: base (current) → target (what we'd restore to).
    // So "removed" lines disappear on restore, "added" lines reappear.
    return collapseUnchanged(diffLines(baseContent, content));
  }, [content, baseContent, version.index]);

  const stats = useMemo(() => {
    if (!diffParts) return null;
    return computeDiffStats(diffParts);
  }, [diffParts]);

  const isLatest = version.index === 0;

  return (
    <div className="flex flex-col" style={{ maxHeight: 500 }}>
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </button>
        <div
          className="text-[10px] font-mono truncate ml-2"
          style={{ color: 'var(--text-muted)' }}
          title={filePath}
        >
          {filePath}
        </div>
      </div>

      <div
        className="px-3 py-2 border-b"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div
          className="flex items-center gap-2 text-xs font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          <span>{fmtTime(version.ts)}</span>
          {version.hash && (
            <span
              className="font-mono text-[10px]"
              style={{ color: 'var(--text-muted)' }}
            >
              {shortHash(version.hash)}
            </span>
          )}
          {Number.isFinite(version.size) && (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              · {fmtBytes(version.size)}
            </span>
          )}
        </div>
        {stats && (
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            <span style={{ color: 'var(--accent-success)' }}>
              +{stats.added}
            </span>
            <span style={{ color: 'var(--accent-danger)' }}>
              −{stats.removed}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>
              lines vs current
            </span>
          </div>
        )}
        {isLatest && (
          <div
            className="text-[10px] mt-1"
            style={{ color: 'var(--text-muted)' }}
          >
            This is the current saved version.
          </div>
        )}
      </div>

      <div
        className="flex-1 overflow-auto font-mono text-[11px] leading-[1.45]"
        style={{ background: 'var(--bg-panel)' }}
      >
        {loading && (
          <div
            className="flex items-center justify-center py-6"
            style={{ color: 'var(--text-muted)' }}
          >
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            <span className="text-xs">Loading snapshot…</span>
          </div>
        )}

        {error && (
          <div
            className="flex items-start gap-1.5 m-3 p-2 rounded-lg text-xs"
            style={{
              background: 'var(--accent-danger-soft)',
              color: 'var(--accent-danger)',
            }}
          >
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {!loading && !error && diffParts && (
          <DiffBody parts={diffParts} />
        )}
        {!loading && !error && !diffParts && typeof content === 'string' && (
          <ContentBody content={content} />
        )}
      </div>

      <div
        className="flex items-center justify-end gap-2 px-3 py-2 border-t"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <button
          onClick={onBack}
          className="text-xs px-3 py-1.5 rounded-lg transition-colors"
          style={{
            color: 'var(--text-secondary)',
            background: 'var(--bg-surface)',
          }}
        >
          Cancel
        </button>
        <button
          onClick={onRestore}
          disabled={restoring || isLatest || !!error || loading}
          className="text-xs px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 font-medium"
          style={{
            color: isLatest || error || loading ? 'var(--text-muted)' : '#ffffff',
            background: isLatest || error || loading
              ? 'var(--bg-surface)'
              : 'var(--accent-gradient)',
            boxShadow: isLatest || error || loading ? 'none' : 'var(--accent-glow)',
            cursor: restoring || isLatest || error || loading ? 'not-allowed' : 'pointer',
            opacity: restoring ? 0.7 : 1,
          }}
          title={
            isLatest
              ? 'This is already the current version'
              : error
                ? 'Cannot restore — snapshot unavailable'
                : 'Rewrite the file to this version'
          }
        >
          {restoring ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCcw className="w-3.5 h-3.5" />
          )}
          {restoring ? 'Restoring…' : isLatest ? 'Already current' : 'Restore this version'}
        </button>
      </div>
    </div>
  );
}

function DiffBody({ parts }) {
  return (
    <div>
      {parts.map((part, i) => {
        if (part._gap) {
          return (
            <div
              key={i}
              className="px-3 py-1 text-[10px] italic"
              style={{
                color: 'var(--text-muted)',
                background: 'var(--bg-surface)',
                borderTop: '1px dashed var(--border-subtle)',
                borderBottom: '1px dashed var(--border-subtle)',
              }}
            >
              … {part._gap} unchanged line{part._gap === 1 ? '' : 's'} …
            </div>
          );
        }
        const lines = part._lines || part.value.split('\n');
        return lines.map((line, j) => {
          const marker = part.added ? '+' : part.removed ? '−' : ' ';
          const bg = part.added
            ? 'color-mix(in srgb, var(--accent-success) 14%, transparent)'
            : part.removed
              ? 'color-mix(in srgb, var(--accent-danger) 14%, transparent)'
              : 'transparent';
          const color = part.added
            ? 'var(--accent-success)'
            : part.removed
              ? 'var(--accent-danger)'
              : 'var(--text-secondary)';
          return (
            <div
              key={`${i}-${j}`}
              className="flex px-3 py-0.5"
              style={{ background: bg, color }}
            >
              <span
                className="select-none w-4 shrink-0 opacity-70"
                aria-hidden
              >
                {marker}
              </span>
              <span className="whitespace-pre-wrap break-all">{line || '​'}</span>
            </div>
          );
        });
      })}
    </div>
  );
}

function ContentBody({ content }) {
  const lines = content.split('\n');
  return (
    <div style={{ color: 'var(--text-secondary)' }}>
      {lines.map((line, i) => (
        <div key={i} className="flex px-3 py-0.5">
          <span
            className="select-none w-8 shrink-0 text-right pr-2 opacity-60"
            style={{ color: 'var(--text-muted)' }}
            aria-hidden
          >
            {i + 1}
          </span>
          <span className="whitespace-pre-wrap break-all">{line || '​'}</span>
        </div>
      ))}
    </div>
  );
}
