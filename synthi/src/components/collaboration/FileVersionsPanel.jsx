"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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

/**
 * FileVersionsPanel — history dropdown for the currently-open file.
 *
 * Lists stored snapshots from the collab-server's durable persistence
 * (GET /file-versions/:slug?filePath=...) and exposes a one-click
 * "Restore" action backed by POST /file-version/restore.
 *
 * Restore semantics mirror the backend: solo users restore their own
 * repo; inside a session the host owns the target repo and guests need
 * canEdit.  The panel does not enforce this itself — the server returns
 * 403 when the caller lacks permission, and we surface the message.
 */
export default function FileVersionsPanel({ slug, filePath }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState([]);
  const [error, setError] = useState(null);
  const [restoringIndex, setRestoringIndex] = useState(null);
  const abortRef = useRef(null);

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
      const list = Array.isArray(payload?.versions) ? payload.versions : [];
      setVersions(list);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [slug, filePath]);

  // Refresh every time the popover opens or the active file changes
  // while open.  Mounted once the user clicks the button, so the common
  // "never open this panel" case costs zero network.
  useEffect(() => {
    if (open) fetchVersions();
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, [open, fetchVersions]);

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
      // Let the rest of the UI refresh against the freshly rewritten
      // disk state.  The CRDT doc is also reset server-side (or hard-
      // invalidated) so live editors should pick up the new content.
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
        className="w-[360px] p-3 shadow-xl rounded-xl border"
        style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-medium)' }}
        align="end"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
            <History className="w-3.5 h-3.5" />
            Version history
          </div>
          <button
            onClick={fetchVersions}
            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="Refresh"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        <div className="text-[10px] truncate mb-2" style={{ color: 'var(--text-muted)' }}>
          {filePath || 'No file open'}
        </div>

        {loading && versions.length === 0 && (
          <div className="flex items-center justify-center py-6" style={{ color: 'var(--text-muted)' }}>
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            <span className="text-xs">Loading versions…</span>
          </div>
        )}

        {error && (
          <div
            className="flex items-start gap-1.5 p-2 rounded-lg text-xs mb-2"
            style={{ background: '#ff575710', color: '#ff5757' }}
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

        <div className="space-y-2 max-h-[340px] overflow-y-auto">
          {versions.map((v) => {
            const busy = restoringIndex === v.index;
            const isLatest = v.index === 0;
            const metaOnly = !v.hasContent;
            return (
              <div
                key={`${v.index}:${v.hash || v.ts}`}
                className="flex items-start gap-2 p-2 border rounded-lg"
                style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                    <span>{fmtTime(v.ts)}</span>
                    {isLatest && (
                      <span
                        className="text-[9px] px-1 py-px rounded"
                        style={{ background: '#4ade8020', color: '#4ade80' }}
                      >
                        latest
                      </span>
                    )}
                    {metaOnly && (
                      <span
                        className="text-[9px] px-1 py-px rounded"
                        style={{ background: '#fbbf2420', color: '#fbbf24' }}
                        title="Content not stored (exceeded size cap)"
                      >
                        metadata only
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {v.hash && <span className="font-mono">{shortHash(v.hash)}</span>}
                    {Number.isFinite(v.size) && <span>·</span>}
                    {Number.isFinite(v.size) && <span>{fmtBytes(v.size)}</span>}
                    {v.userId && <span>·</span>}
                    {v.userId && <span className="truncate">{v.userId}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => restore(v)}
                    disabled={busy || metaOnly || isLatest}
                    title={
                      isLatest
                        ? 'This is already the current version'
                        : metaOnly
                          ? 'Content unavailable for this snapshot'
                          : 'Restore this version'
                    }
                    className={
                      busy || metaOnly || isLatest
                        ? 'p-1 rounded bg-white/5 opacity-50 cursor-not-allowed'
                        : 'p-1 rounded bg-[#3b82f620] hover:bg-[#3b82f630] transition-colors'
                    }
                  >
                    {busy
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[#3b82f6]" />
                      : <RotateCcw className="w-3.5 h-3.5 text-[#3b82f6]" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
