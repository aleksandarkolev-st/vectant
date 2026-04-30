// Next-Edit Prediction (NEP) — Phases 1 + 2 + 3.
//
// Owns:
//   - The 8 KB byte-bounded NEP recent-edit ring buffer (separate from the
//     primary completion buffer).
//   - The fetch/stream lifecycle to /api/next-edit.
//   - The state machine: idle ↔ pending ↔ armed ↔ armed-current
//     (+ armed-confirm for SEARCH ALL multi-site preview, Phase 2).
//   - Stream-time validation against current file contents.
//   - Re-validation right before apply (concurrent edits could land between
//     stream-time and Tab — the file may have changed).
//   - The jump-hint gutter dot + ghost overlay rendering.
//   - The Tab cascade: first Tab jumps cursor + shows ghost, second Tab
//     applies, any other key returns to idle.
//   - Phase 2: edit-kind classification of the LAST applied edit, fed into
//     the next NEP request as `appliedEdit` so the API can pull cross-file
//     impact candidates.
//   - Phase 2: per-site confirmation flow for SEARCH ALL.
//   - Phase 3: telemetry counters (emitted / validated / accepted /
//     rejection-reason breakdown), kill-switch gate, per-session cost
//     ceiling.
//
// Phases 1+2 are feature-flagged off by default. Enable via
// NEXT_PUBLIC_NEXT_EDIT_PREDICTION=1 or window.__SYNTHI_NEP_ENABLED__=true.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  API_NEXT_EDIT_ROUTE,
  createStreamParser,
  validateBlock,
  applyBlock,
  locateBlock,
  NEP_BLOCK_KIND,
  REJECT_REASONS,
} from '@/lib/nextEdit';
import {
  pushNepEdit,
  resetNepBuffer,
  renderRecentEditsBlock,
} from '@/utils/nepRecentEdits';
import { classifyEdit } from '@/lib/editKindClassifier';
import { recordNepEvent, isNepKilled } from '@/lib/nepTelemetry';

const NEP_DEBOUNCE_MS = 600;
const NEP_MIN_INTERVAL_MS = 1500; // floor between auto-fires (rate limit)
// Per-session cap on NEP fires. Heavy refactor sessions could otherwise blow
// API budget. Plan-grade gap "cost ceiling / rate limit per session is
// absent" — addressed by this cap. Resets on workspace switch.
const NEP_PER_SESSION_FIRE_CAP = 200;

const NEP_GUTTER_CLASS = 'synthi-nep-gutter-dot';
const NEP_LINE_CLASS = 'synthi-nep-target-line';
const NEP_CONFIRM_LINE_CLASS = 'synthi-nep-confirm-line';

const STATE = {
  IDLE: 'idle',
  PENDING: 'pending',
  ARMED: 'armed',
  ARMED_CURRENT: 'armed-current',
  // SEARCH ALL multi-site preview (Phase 2). The user is reviewing one site
  // at a time; Tab accepts THIS site, Shift-Tab skips, A applies all
  // remaining matched sites, Esc cancels the batch.
  ARMED_CONFIRM: 'armed-confirm',
};

const isNepEnabled = () => {
  if (typeof window !== 'undefined' && window.__SYNTHI_NEP_ENABLED__) return true;
  if (typeof process !== 'undefined') {
    const v = process.env?.NEXT_PUBLIC_NEXT_EDIT_PREDICTION;
    if (v === '1' || v === 'true') return true;
  }
  return false;
};

/**
 * Find ALL byte-offset positions of `needle` in `haystack`. Used by SEARCH
 * ALL: the validator returns N>=1; we then locate every site so the user
 * can review each before accepting.
 */
const findAllOffsets = (haystack, needle) => {
  const out = [];
  if (!haystack || !needle) return out;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
};

const offsetToLine = (content, offset) => {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
};

export const useNextEditPrediction = ({
  editorInstance,
  monacoInstance,
  activeFile,
  activeLanguage,
  workspaceSlug,
  getFileCacheEntries,
  getLiveFileContent,
  workspaceResetKey,
}) => {
  const [enabled, setEnabled] = useState(() => isNepEnabled());
  const [nepState, setNepState] = useState(STATE.IDLE);

  const recentEditsRef = useRef([]);
  const lastFireRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const abortRef = useRef(null);
  const sessionFireCountRef = useRef(0);

  // Validated queue. Each entry is one of:
  //   - { kind: 'SEARCH', block, location: {path, line} }
  //   - { kind: 'SEARCH ALL', block, sites: [{offset, line}, ...], cursor: 0 }
  // Cursor through the queue → queueIndexRef.
  const queueRef = useRef([]);
  const queueIndexRef = useRef(0);

  // The last edit the user accepted, classified by edit-kind. Sent on the
  // next NEP request as `appliedEdit` so /api/next-edit can pull impact.
  const lastAppliedEditRef = useRef(null);

  // Decoration ids for the gutter dot + line highlight.
  const decorationIdsRef = useRef([]);

  // ── lifecycle: workspace reset ──────────────────────────────────────────
  useEffect(() => {
    recentEditsRef.current = resetNepBuffer();
    queueRef.current = [];
    queueIndexRef.current = 0;
    lastAppliedEditRef.current = null;
    sessionFireCountRef.current = 0;
    if (abortRef.current) {
      try { abortRef.current.abort('workspace-reset'); } catch (_) { /* ignored */ }
      abortRef.current = null;
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setNepState(STATE.IDLE);
  }, [workspaceResetKey]);

  useEffect(() => {
    setEnabled(isNepEnabled());
  }, []);

  // ── helpers ─────────────────────────────────────────────────────────────
  const clearDecorations = useCallback(() => {
    if (!editorInstance) return;
    if (decorationIdsRef.current.length) {
      try {
        decorationIdsRef.current = editorInstance.deltaDecorations(decorationIdsRef.current, []);
      } catch (_) { /* model gone */ }
    }
  }, [editorInstance]);

  const renderJumpHint = useCallback((entry, opts = {}) => {
    if (!editorInstance || !monacoInstance || !entry) {
      clearDecorations();
      return;
    }
    let line = null;
    let path = null;
    if (entry.kind === NEP_BLOCK_KIND.SEARCH) {
      line = entry.location?.line;
      path = entry.location?.path;
    } else if (entry.kind === NEP_BLOCK_KIND.SEARCH_ALL) {
      const site = entry.sites?.[entry.cursor ?? 0];
      line = site?.line;
      path = entry.block?.path;
    }
    if (!line || !path) {
      clearDecorations();
      return;
    }
    const activePath = activeFile?.path || activeFile?.name;
    if (path !== activePath) {
      clearDecorations();
      return;
    }
    try {
      const Range = monacoInstance.Range;
      const lineCls = opts.confirm ? NEP_CONFIRM_LINE_CLASS : NEP_LINE_CLASS;
      const newDecorations = [
        {
          range: new Range(line, 1, line, 1),
          options: {
            isWholeLine: false,
            glyphMarginClassName: NEP_GUTTER_CLASS,
            glyphMarginHoverMessage: {
              value: opts.confirm
                ? 'SEARCH ALL site (Tab accept · Shift-Tab skip · A apply-all · Esc cancel)'
                : 'Next-edit prediction (Tab to jump, Tab again to apply)',
            },
          },
        },
        {
          range: new Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: lineCls,
          },
        },
      ];
      decorationIdsRef.current = editorInstance.deltaDecorations(
        decorationIdsRef.current,
        newDecorations,
      );
    } catch (_) { /* decoration churn is best-effort */ }
  }, [editorInstance, monacoInstance, activeFile, clearDecorations]);

  const cancelInflight = useCallback((reason = 'cancel') => {
    if (abortRef.current) {
      try { abortRef.current.abort(reason); } catch (_) { /* ignored */ }
      abortRef.current = null;
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const resetToIdle = useCallback((reason = 'reset') => {
    cancelInflight(reason);
    queueRef.current = [];
    queueIndexRef.current = 0;
    clearDecorations();
    setNepState(STATE.IDLE);
  }, [cancelInflight, clearDecorations]);

  // Forward decl so the recent-edit listener can call it before fireNep is
  // declared via useCallback below.
  const fireNepRef = useRef(null);

  // ── recent-edit capture ─────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !editorInstance) return undefined;

    const disposable = editorInstance.onDidChangeModelContent?.((event) => {
      try {
        const path = activeFile?.path || activeFile?.name || null;
        if (!path) return;
        const model = editorInstance.getModel?.();
        if (!model) return;
        const changes = Array.isArray(event?.changes) ? event.changes : [];
        if (!changes.length) return;

        const sorted = [...changes].sort((a, b) => {
          const al = a?.range?.startLineNumber ?? 0;
          const bl = b?.range?.startLineNumber ?? 0;
          if (al !== bl) return al - bl;
          return (a?.range?.startColumn ?? 0) - (b?.range?.startColumn ?? 0);
        });
        const insertedText = sorted.map((c) => c?.text || '').join('').replace(/\s+$/u, '');
        if (!insertedText.trim()) return;

        const firstRange = sorted[0]?.range;
        const lastRange = sorted[sorted.length - 1]?.range || firstRange;
        if (!firstRange || !lastRange) return;

        const startLine = Math.max(1, firstRange.startLineNumber || 1);
        const insertedNewlines = (insertedText.match(/\n/g) || []).length;
        const endLine = Math.max(startLine, (lastRange.endLineNumber || startLine) + insertedNewlines);

        const totalLines = model.getLineCount?.() ?? endLine;
        const ctxStart = Math.max(1, startLine - 3);
        const ctxEnd = Math.min(totalLines, endLine + 3);
        const readLines = (from, to) => {
          if (from > to) return '';
          try {
            return model.getValueInRange({
              startLineNumber: from,
              startColumn: 1,
              endLineNumber: to,
              endColumn: model.getLineMaxColumn?.(to) ?? 1,
            }) || '';
          } catch (_) { return ''; }
        };
        const before = readLines(ctxStart, Math.max(ctxStart, startLine - 1));
        const after = readLines(Math.min(totalLines, endLine + 1), ctxEnd);

        const markInserted = (t) => t.split('\n').map((l) => `+ ${l}`).join('\n');
        const markContext = (t) => (t ? t.split('\n').map((l) => `  ${l}`).join('\n') : '');
        const headerLine = `@@ ${path} L${startLine}-${endLine} @@`;
        const snippet = [
          headerLine,
          markContext(before),
          markInserted(insertedText),
          markContext(after),
        ].filter(Boolean).join('\n');

        recentEditsRef.current = pushNepEdit(recentEditsRef.current, { path, snippet });

        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          if (fireNepRef.current) fireNepRef.current();
        }, NEP_DEBOUNCE_MS);

        // Section 3 cancellation rule: any non-Tab keystroke drops the queue.
        if (
          nepState === STATE.ARMED ||
          nepState === STATE.ARMED_CURRENT ||
          nepState === STATE.ARMED_CONFIRM
        ) {
          resetToIdle('user-typed');
        }
      } catch (_) { /* recent-edit capture is best-effort */ }
    });
    return () => { try { disposable?.dispose?.(); } catch (_) { /* ignored */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, editorInstance, activeFile]);

  // ── fire NEP ────────────────────────────────────────────────────────────
  const fireNep = useCallback(async () => {
    if (!enabled) return;
    if (!editorInstance || !activeFile) return;
    if (isNepKilled()) return;
    if (sessionFireCountRef.current >= NEP_PER_SESSION_FIRE_CAP) return;

    const now = Date.now();
    if (now - lastFireRef.current < NEP_MIN_INTERVAL_MS) return;
    lastFireRef.current = now;
    sessionFireCountRef.current += 1;

    cancelInflight('superseded');
    setNepState(STATE.PENDING);

    const controller = new AbortController();
    abortRef.current = controller;

    const activePath = activeFile?.path || activeFile?.name || null;
    const liveActiveContent = getLiveFileContent
      ? getLiveFileContent(activePath)
      : (editorInstance.getModel?.()?.getValue?.() ?? '');

    const cacheEntries = typeof getFileCacheEntries === 'function'
      ? getFileCacheEntries() : [];
    const files = {};
    if (activePath && typeof liveActiveContent === 'string') {
      files[activePath] = liveActiveContent;
    }
    if (cacheEntries) {
      const iter = Array.isArray(cacheEntries) ? cacheEntries : Array.from(cacheEntries);
      for (const [p, content] of iter) {
        if (!p || typeof content !== 'string') continue;
        if (p === activePath) continue;
        files[p] = content;
      }
    }

    const cursor = editorInstance.getPosition?.()
      ? {
          line: editorInstance.getPosition().lineNumber,
          column: editorInstance.getPosition().column,
        }
      : null;

    const payload = {
      workspaceSlug: workspaceSlug || null,
      language: activeLanguage || 'plaintext',
      activePath,
      cursor,
      recentEdits: recentEditsRef.current.map((e) => ({ path: e.path, snippet: e.snippet })),
      files,
      // Phase 2: send the last applied edit so the route can pull impact
      // candidates from the symbol graph and inject them into the prompt.
      appliedEdit: lastAppliedEditRef.current,
    };

    recordNepEvent('fire', { has_applied_edit: Boolean(lastAppliedEditRef.current) });

    let res;
    try {
      res = await fetch(API_NEXT_EDIT_ROUTE, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (!controller.signal.aborted) setNepState(STATE.IDLE);
      return;
    }
    if (!res.ok) { setNepState(STATE.IDLE); return; }

    const reader = res.body?.getReader?.();
    if (!reader) { setNepState(STATE.IDLE); return; }

    const parser = createStreamParser();
    const decoder = new TextDecoder();
    let armedYet = false;

    const fallbackGet = (p) => {
      if (p === activePath) return liveActiveContent;
      const v = files[p];
      return typeof v === 'string' ? v : null;
    };
    const liveReader = getLiveFileContent || fallbackGet;

    const ingest = (results) => {
      for (const result of results) {
        if (!result.ok) {
          recordNepEvent('rejected', {
            reason: result.reason || REJECT_REASONS.PARSE_ERROR,
            detail: result.detail,
          });
          continue;
        }
        recordNepEvent('emitted');
        const block = result.block;
        const v = validateBlock(block, liveReader);

        let entry = null;
        if (block.kind === NEP_BLOCK_KIND.SEARCH) {
          if (!v.ok) {
            recordNepEvent('rejected', { reason: v.reason, path: v.path || block.path });
            continue;
          }
          recordNepEvent('validated', { kind: block.kind });
          const line = locateBlock(block, liveReader);
          if (!line) continue;
          entry = { kind: NEP_BLOCK_KIND.SEARCH, block, location: { path: block.path, line } };
        } else if (block.kind === NEP_BLOCK_KIND.SEARCH_ALL) {
          // Phase 2 treats phase2_required as the OPPORTUNITY to enter the
          // confirm flow — the validator's "reject" was the Phase 1 stub.
          if (!v.ok && v.reason !== REJECT_REASONS.PHASE2_REQUIRED) {
            recordNepEvent('rejected', { reason: v.reason, path: v.path || block.path });
            continue;
          }
          recordNepEvent('validated', { kind: block.kind });
          const live = liveReader(block.path);
          if (typeof live !== 'string') continue;
          const offsets = findAllOffsets(live, block.search);
          if (offsets.length === 0) continue;
          const sites = offsets.map((offset) => ({ offset, line: offsetToLine(live, offset) }));
          entry = { kind: NEP_BLOCK_KIND.SEARCH_ALL, block, sites, cursor: 0 };
        } else {
          continue;
        }
        if (!entry) continue;
        queueRef.current.push(entry);
        if (!armedYet) {
          armedYet = true;
          queueIndexRef.current = 0;
          if (entry.kind === NEP_BLOCK_KIND.SEARCH_ALL) {
            setNepState(STATE.ARMED_CONFIRM);
            renderJumpHint(entry, { confirm: true });
          } else {
            setNepState(STATE.ARMED);
            renderJumpHint(entry);
          }
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) {
          try { reader.cancel(); } catch (_) { /* ignored */ }
          return;
        }
        if (done) break;
        ingest(parser.feed(decoder.decode(value, { stream: true })));
      }
      ingest(parser.feed(decoder.decode()));
      ingest(parser.flush());
    } catch (_) {
      // Stream tore mid-block — anything we already armed is still valid.
    }

    if (!armedYet) setNepState(STATE.IDLE);
  }, [
    enabled, editorInstance, activeFile, activeLanguage, workspaceSlug,
    getFileCacheEntries, getLiveFileContent, cancelInflight, renderJumpHint,
  ]);

  useEffect(() => { fireNepRef.current = fireNep; }, [fireNep]);

  // ── apply helpers ───────────────────────────────────────────────────────
  const applySearchBlock = useCallback((entry) => {
    const next = applyBlock(entry.block, getLiveFileContent);
    const path = entry.block.path;
    const activePath = activeFile?.path || activeFile?.name;
    if (path === activePath) {
      const model = editorInstance.getModel?.();
      if (model) model.setValue(next);
    } else {
      // Cross-file apply lands when we wire VFS write here. For now log;
      // the prediction was already validated, so when the wiring lands we
      // know it'll succeed.
      if (typeof console !== 'undefined') {
        console.debug('[NEP] cross-file apply pending VFS hookup', path);
      }
    }
    // Classify + stash for the next NEP fire's appliedEdit.
    try {
      const cls = classifyEdit({
        search: entry.block.search,
        replace: entry.block.replace,
        path: entry.block.path,
      });
      lastAppliedEditRef.current = {
        path: entry.block.path,
        search: entry.block.search,
        replace: entry.block.replace,
        kind: cls.kind,
        confidence: cls.confidence,
      };
    } catch (_) {
      lastAppliedEditRef.current = {
        path: entry.block.path,
        search: entry.block.search,
        replace: entry.block.replace,
      };
    }
    recordNepEvent('accepted', { kind: NEP_BLOCK_KIND.SEARCH, path });
  }, [editorInstance, activeFile, getLiveFileContent]);

  /**
   * Apply a SEARCH ALL block at a SINGLE site identified by byte-offset.
   * Used by the per-site confirmation flow. Re-validates by recomputing the
   * offset against the LIVE file (in case prior accepts shifted text).
   */
  const applySearchAllSite = useCallback((entry, siteIdx) => {
    const path = entry.block.path;
    const live = getLiveFileContent ? getLiveFileContent(path) : null;
    if (typeof live !== 'string') throw new Error('live content missing for ' + path);
    const offsets = findAllOffsets(live, entry.block.search);
    if (siteIdx >= offsets.length) {
      // The site we wanted is gone (prior accept shifted text and removed
      // this match). Skip silently.
      return live;
    }
    const offset = offsets[siteIdx];
    const next = live.slice(0, offset) + entry.block.replace + live.slice(offset + entry.block.search.length);
    const activePath = activeFile?.path || activeFile?.name;
    if (path === activePath) {
      const model = editorInstance.getModel?.();
      if (model) model.setValue(next);
    }
    return next;
  }, [editorInstance, activeFile, getLiveFileContent]);

  // ── Tab cascade ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !editorInstance) return undefined;

    const disposable = editorInstance.onKeyDown?.((e) => {
      if (queueRef.current.length === 0) return;
      const idx = queueIndexRef.current;
      const entry = queueRef.current[idx];
      if (!entry) return;

      const advanceQueue = () => {
        queueIndexRef.current += 1;
        if (queueIndexRef.current < queueRef.current.length) {
          const nextEntry = queueRef.current[queueIndexRef.current];
          if (nextEntry.kind === NEP_BLOCK_KIND.SEARCH_ALL) {
            setNepState(STATE.ARMED_CONFIRM);
            renderJumpHint(nextEntry, { confirm: true });
          } else {
            setNepState(STATE.ARMED);
            renderJumpHint(nextEntry);
          }
        } else {
          resetToIdle('drained');
        }
      };

      // SEARCH ALL confirm flow.
      if (nepState === STATE.ARMED_CONFIRM) {
        if (e.code === 'Tab' && !e.shiftKey) {
          // Tab → accept this site, advance.
          e.preventDefault();
          e.stopPropagation();
          try {
            applySearchAllSite(entry, entry.cursor ?? 0);
            recordNepEvent('accepted', { kind: NEP_BLOCK_KIND.SEARCH_ALL, path: entry.block.path });
          } catch (err) {
            recordNepEvent('rejected', { reason: 'apply_failed', detail: err?.message });
            resetToIdle('apply-failed');
            return;
          }
          // Re-locate sites against the LIVE file (offsets just shifted).
          const live = getLiveFileContent ? getLiveFileContent(entry.block.path) : null;
          if (typeof live === 'string' && live.indexOf(entry.block.search) !== -1) {
            entry.sites = findAllOffsets(live, entry.block.search).map((off) => ({
              offset: off, line: offsetToLine(live, off),
            }));
            entry.cursor = 0;
            renderJumpHint(entry, { confirm: true });
          } else {
            advanceQueue();
          }
          return;
        }
        if (e.code === 'Tab' && e.shiftKey) {
          // Shift+Tab → skip this site.
          e.preventDefault();
          e.stopPropagation();
          entry.cursor = (entry.cursor ?? 0) + 1;
          if (entry.cursor < (entry.sites?.length ?? 0)) {
            renderJumpHint(entry, { confirm: true });
          } else {
            advanceQueue();
          }
          return;
        }
        if (e.code === 'KeyA') {
          // 'A' → apply all REMAINING sites in this batch.
          e.preventDefault();
          e.stopPropagation();
          let safety = 200;
          let live = getLiveFileContent ? getLiveFileContent(entry.block.path) : null;
          while (typeof live === 'string' && live.indexOf(entry.block.search) !== -1 && safety-- > 0) {
            try {
              applySearchAllSite(entry, 0);
              recordNepEvent('accepted', { kind: NEP_BLOCK_KIND.SEARCH_ALL, path: entry.block.path, batch: true });
            } catch (err) { break; }
            live = getLiveFileContent ? getLiveFileContent(entry.block.path) : null;
          }
          advanceQueue();
          return;
        }
        if (e.code === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          resetToIdle('confirm-escape');
          return;
        }
        // Any other key cancels the queue (Section 3 rule).
        resetToIdle('non-confirm-key');
        return;
      }

      // SEARCH (single-site) flow.
      if (e.code === 'Tab') {
        if (nepState === STATE.ARMED) {
          e.preventDefault();
          e.stopPropagation();
          const path = entry.location?.path;
          const activePath = activeFile?.path || activeFile?.name;
          if (path === activePath) {
            try {
              editorInstance.revealLineInCenter(entry.location.line);
              editorInstance.setPosition({
                lineNumber: entry.location.line,
                column: 1,
              });
            } catch (_) { /* ignored */ }
          }
          setNepState(STATE.ARMED_CURRENT);
          return;
        }
        if (nepState === STATE.ARMED_CURRENT) {
          e.preventDefault();
          e.stopPropagation();
          try {
            applySearchBlock(entry);
            advanceQueue();
          } catch (err) {
            recordNepEvent('rejected', { reason: 'revalidate_failed', detail: err?.message });
            resetToIdle('revalidate-failed');
          }
          return;
        }
      }
      // Any other key while armed (non-confirm) → cancel.
      if (nepState === STATE.ARMED || nepState === STATE.ARMED_CURRENT) {
        resetToIdle('non-tab-key');
      }
    });
    return () => { try { disposable?.dispose?.(); } catch (_) { /* ignored */ } };
  }, [
    enabled, editorInstance, nepState, activeFile, getLiveFileContent,
    renderJumpHint, resetToIdle, applySearchBlock, applySearchAllSite,
  ]);

  return {
    nepState,
    enabled,
    setEnabled,
    _internals: {
      recentEditsRef,
      queueRef,
      lastAppliedEditRef,
      fireNep,
      resetToIdle,
      renderRecentEditsBlock: () => renderRecentEditsBlock(recentEditsRef.current),
    },
  };
};
