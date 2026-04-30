// Next-Edit Prediction (NEP) — Phase 1 wiring.
//
// Owns:
//   - The 8 KB byte-bounded NEP recent-edit ring buffer (separate from the
//     primary completion buffer).
//   - The fetch/stream lifecycle to /api/next-edit.
//   - The state machine: idle ↔ pending ↔ armed ↔ armed-current.
//   - Stream-time validation against current file contents.
//   - Re-validation right before apply (concurrent edits could land between
//     stream-time and Tab — the file may have changed).
//   - The jump-hint gutter dot + ghost overlay rendering.
//   - The Tab cascade: first Tab jumps cursor + shows ghost, second Tab
//     applies, any other key returns to idle.
//
// Phase 1 is feature-flagged off by default. Enable via NEXT_PUBLIC_NEXT_EDIT_PREDICTION=1.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  API_NEXT_EDIT_ROUTE,
  createStreamParser,
  validateBlock,
  applyBlock,
  locateBlock,
  NEP_BLOCK_KIND,
} from '@/lib/nextEdit';
import {
  pushNepEdit,
  resetNepBuffer,
  renderRecentEditsBlock,
} from '@/utils/nepRecentEdits';

const NEP_DEBOUNCE_MS = 600;
const NEP_MIN_INTERVAL_MS = 1500; // floor between auto-fires (per-session cost ceiling)
const NEP_GUTTER_CLASS = 'synthi-nep-gutter-dot';
const NEP_LINE_CLASS = 'synthi-nep-target-line';

const STATE = {
  IDLE: 'idle',
  PENDING: 'pending',
  ARMED: 'armed',
  ARMED_CURRENT: 'armed-current',
};

/**
 * Default flag check. Env var or window override (the latter is for the live
 * test harness — it can flip the flag without restarting the dev server).
 */
const isNepEnabled = () => {
  if (typeof window !== 'undefined' && window.__SYNTHI_NEP_ENABLED__) return true;
  if (typeof process !== 'undefined') {
    const v = process.env?.NEXT_PUBLIC_NEXT_EDIT_PREDICTION;
    if (v === '1' || v === 'true') return true;
  }
  return false;
};

export const useNextEditPrediction = ({
  editorInstance,
  monacoInstance,
  activeFile,
  activeLanguage,
  workspaceSlug,
  // Lazy file-cache reader: returns Iterable<[path, content]>. Same shape the
  // primary completion hook reads from, so wiring is one line in Editor.jsx.
  getFileCacheEntries,
  // Returns the live content of `path` from the editor's models or file cache.
  // Validator + apply path call this — it MUST reflect the current model
  // contents (concurrent-edit re-validation per Section 8).
  getLiveFileContent,
  // Workspace lifecycle reset hook. Plan Q1: NEP shares this with the primary
  // buffer.  Caller passes the same trigger (slug change) and we drop state.
  workspaceResetKey,
}) => {
  const [enabled, setEnabled] = useState(() => isNepEnabled());
  const [nepState, setNepState] = useState(STATE.IDLE);

  const recentEditsRef = useRef([]);
  const lastFireRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const abortRef = useRef(null);

  // Validated queue + cursor into it.  Each entry is { block, location } where
  // location is { path, line } so we know where to drop the gutter dot.
  const queueRef = useRef([]);
  const queueIndexRef = useRef(0);

  // Decoration ids for the gutter dot + line highlight.  We delta-replace on
  // every transition so the visual is always glued to the active prediction.
  const decorationIdsRef = useRef([]);

  // ── lifecycle: workspace reset ──────────────────────────────────────────
  useEffect(() => {
    recentEditsRef.current = resetNepBuffer();
    queueRef.current = [];
    queueIndexRef.current = 0;
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

  // Re-read flag on mount (lets the live test flip the window override
  // before the editor mounts and have it pick up).
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

  const renderJumpHint = useCallback((entry) => {
    if (!editorInstance || !monacoInstance || !entry) {
      clearDecorations();
      return;
    }
    const { location } = entry;
    if (!location?.path || !location?.line) {
      clearDecorations();
      return;
    }
    // Phase 1: render only when the predicted edit is in the active file.
    // Cross-file jumps land in Phase 2 with the impact graph; for now we
    // surface them to the queue but don't paint a dot in another file's gutter.
    const activePath = activeFile?.path || activeFile?.name;
    if (location.path !== activePath) {
      clearDecorations();
      return;
    }
    try {
      const Range = monacoInstance.Range;
      const newDecorations = [
        {
          range: new Range(location.line, 1, location.line, 1),
          options: {
            isWholeLine: false,
            glyphMarginClassName: NEP_GUTTER_CLASS,
            glyphMarginHoverMessage: { value: 'Next-edit prediction (Tab to jump, Tab again to apply)' },
          },
        },
        {
          range: new Range(location.line, 1, location.line, 1),
          options: {
            isWholeLine: true,
            className: NEP_LINE_CLASS,
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

        // Each fresh edit also restarts the debounce timer for the NEP fire.
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          fireNep();
        }, NEP_DEBOUNCE_MS);

        // If we already have an armed prediction, the user typed → cancel.
        // Section 3 of the plan: any non-Tab keystroke drops the queue.
        if (nepState === STATE.ARMED || nepState === STATE.ARMED_CURRENT) {
          resetToIdle('user-typed');
        }
      } catch (_) { /* recent-edit capture is best-effort */ }
    });
    return () => { try { disposable?.dispose?.(); } catch (_) { /* ignored */ } };
    // We intentionally don't depend on `nepState` — the listener reads it
    // through closure-fresh refs via the resetToIdle/fireNep callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, editorInstance, activeFile]);

  // ── fire NEP ────────────────────────────────────────────────────────────
  const fireNep = useCallback(async () => {
    if (!enabled) return;
    if (!editorInstance || !activeFile) return;

    const now = Date.now();
    if (now - lastFireRef.current < NEP_MIN_INTERVAL_MS) return;
    lastFireRef.current = now;

    cancelInflight('superseded');
    setNepState(STATE.PENDING);

    const controller = new AbortController();
    abortRef.current = controller;

    // Build the file payload. The active file MUST be included so the model
    // can emit SEARCH against its own current contents. Other files come
    // from the file cache, capped by the route's NEP_FILES_BUDGET_CHARS.
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
      for (const [path, content] of iter) {
        if (!path || typeof content !== 'string') continue;
        if (path === activePath) continue;
        files[path] = content;
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
    };

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
    if (!res.ok) {
      setNepState(STATE.IDLE);
      return;
    }

    const reader = res.body?.getReader?.();
    if (!reader) {
      setNepState(STATE.IDLE);
      return;
    }

    const parser = createStreamParser();
    const decoder = new TextDecoder();
    let armedYet = false;

    // Validator/locator both need a `getFileContent(path)`. Prefer the live
    // model reader when supplied; fall back to the in-prompt files we sent —
    // this keeps Phase 1 honest (file_missing only fires when the path is
    // genuinely unknown, not just because the caller didn't wire the reader).
    const fallbackGet = (p) => {
      if (p === activePath) return liveActiveContent;
      const v = files[p];
      return typeof v === 'string' ? v : null;
    };
    const reader2 = getLiveFileContent || fallbackGet;

    const ingest = (results) => {
      for (const result of results) {
        if (!result.ok) {
          // Telemetry hook (Phase 3 will aggregate; for now console for debug).
          if (typeof console !== 'undefined') {
            console.debug('[NEP] block rejected', result.reason, result.detail || '');
          }
          continue;
        }
        const block = result.block;
        const v = validateBlock(block, reader2);
        if (!v.ok) {
          if (typeof console !== 'undefined') {
            console.debug('[NEP] validate rejected', v.reason, v.path || block.path);
          }
          continue;
        }
        // Phase 1: only execute SEARCH. SEARCH ALL is logged by the validator.
        if (block.kind !== NEP_BLOCK_KIND.SEARCH) continue;

        const line = locateBlock(block, reader2);
        if (!line) continue;
        queueRef.current.push({ block, location: { path: block.path, line } });
        if (!armedYet) {
          armedYet = true;
          queueIndexRef.current = 0;
          setNepState(STATE.ARMED);
          renderJumpHint(queueRef.current[0]);
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

    if (!armedYet) {
      setNepState(STATE.IDLE);
    }
  }, [
    enabled, editorInstance, activeFile, activeLanguage, workspaceSlug,
    getFileCacheEntries, getLiveFileContent, cancelInflight, renderJumpHint,
  ]);

  // ── Tab cascade ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !editorInstance) return undefined;

    const disposable = editorInstance.onKeyDown?.((e) => {
      if (queueRef.current.length === 0) return;
      const idx = queueIndexRef.current;
      const entry = queueRef.current[idx];
      if (!entry) return;

      // Tab → cascade. Anything else → cancel (Section 3 cancellation rule).
      if (e.code === 'Tab') {
        if (nepState === STATE.ARMED) {
          // First Tab: jump cursor to the predicted line.
          e.preventDefault();
          e.stopPropagation();
          const path = entry.location.path;
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
          // Second Tab: re-validate (file may have changed since stream-time)
          // and apply.
          e.preventDefault();
          e.stopPropagation();
          try {
            const next = applyBlock(entry.block, getLiveFileContent);
            const path = entry.block.path;
            const activePath = activeFile?.path || activeFile?.name;
            if (path === activePath) {
              const model = editorInstance.getModel?.();
              if (model) {
                model.setValue(next);
              }
            } else {
              // Cross-file apply lands in Phase 2 with the file-system bridge.
              // For Phase 1 we just log and skip.
              if (typeof console !== 'undefined') {
                console.debug('[NEP] cross-file apply deferred to Phase 2', path);
              }
            }
            // Advance to next block, or return to idle if drained.
            queueIndexRef.current += 1;
            if (queueIndexRef.current < queueRef.current.length) {
              setNepState(STATE.ARMED);
              renderJumpHint(queueRef.current[queueIndexRef.current]);
            } else {
              resetToIdle('drained');
            }
          } catch (err) {
            // Re-validation failed (file changed underneath). Drop the queue.
            if (typeof console !== 'undefined') {
              console.debug('[NEP] re-validate failed at apply', err?.reason || err?.message);
            }
            resetToIdle('revalidate-failed');
          }
          return;
        }
      }
      // Any other key while armed → cancel.
      if (nepState === STATE.ARMED || nepState === STATE.ARMED_CURRENT) {
        resetToIdle('non-tab-key');
      }
    });
    return () => { try { disposable?.dispose?.(); } catch (_) { /* ignored */ } };
  }, [enabled, editorInstance, nepState, activeFile, getLiveFileContent, renderJumpHint, resetToIdle]);

  // ── selection-change cancel ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !editorInstance) return undefined;
    const disposable = editorInstance.onDidChangeCursorSelection?.((e) => {
      if (nepState !== STATE.ARMED && nepState !== STATE.ARMED_CURRENT) return;
      // Cursor jumps that we issued during a Tab cascade come through here too;
      // the source `api` is non-keyboard. A keyboard-driven selection change
      // means the user moved the cursor — drop the queue.
      if (e?.source && e.source !== 'api' && e.source !== 'mouse') return;
    });
    return () => { try { disposable?.dispose?.(); } catch (_) { /* ignored */ } };
  }, [enabled, editorInstance, nepState]);

  return {
    nepState,
    enabled,
    setEnabled,
    // Exposed for tests / debug overlays.
    _internals: {
      recentEditsRef,
      queueRef,
      fireNep,
      resetToIdle,
      renderRecentEditsBlock: () => renderRecentEditsBlock(recentEditsRef.current),
    },
  };
};
