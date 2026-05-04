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
import { recordNepEvent, isNepKilled, checkServerKill } from '@/lib/nepTelemetry';
import { gitClient } from '@/services/gitClient';
import { fileCache } from '@/services/fileCache';
import { loadScheduler } from '@/services/loadScheduler';
import { selectFileThunk } from '@/redux/workspaceSlice';

const NEP_DEBOUNCE_MS = 600;
const NEP_MIN_INTERVAL_MS = 1500; // floor between auto-fires (rate limit)
// Per-session cap on NEP fires. Heavy refactor sessions could otherwise blow
// API budget. Plan-grade gap "cost ceiling / rate limit per session is
// absent" — addressed by this cap. Resets on workspace switch.
const NEP_PER_SESSION_FIRE_CAP = 200;

const NEP_GUTTER_CLASS = 'synthi-nep-gutter-dot';
const NEP_LINE_CLASS = 'synthi-nep-target-line';
const NEP_CONFIRM_LINE_CLASS = 'synthi-nep-confirm-line';
// Strikethrough on the SEARCH range — visualises what the prediction will
// remove. Combined with the REPLACE preview view zone below, the user sees
// the full edit *before* committing it.
const NEP_SEARCH_STRIKE_CLASS = 'synthi-nep-search-strike';
// Cross-file hint dot: the prediction targets a file that isn't open as a
// tab, so the primary gutter dot has nothing to decorate. We fall back to a
// dot in the active editor's gutter at the user's cursor line so the user
// gets a visible signal that Tab will jump to a prediction elsewhere.
const NEP_CROSSFILE_GUTTER_CLASS = 'synthi-nep-gutter-dot-crossfile';

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

const NEP_LOCAL_STORAGE_KEY = 'synthi.nep.enabled';

// NEP is on by default. Explicit opt-out paths (in priority order):
//   1. window.__SYNTHI_NEP_ENABLED__ = false
//   2. localStorage `synthi.nep.enabled` = "0" / "false"
//   3. NEXT_PUBLIC_NEXT_EDIT_PREDICTION = "0" / "false"
// Anything else falls through to enabled.
const isNepEnabled = () => {
  if (typeof window !== 'undefined') {
    if (window.__SYNTHI_NEP_ENABLED__ === false) return false;
    if (window.__SYNTHI_NEP_ENABLED__) return true;
    try {
      const stored = window.localStorage?.getItem?.(NEP_LOCAL_STORAGE_KEY);
      if (stored === '1' || stored === 'true') return true;
      if (stored === '0' || stored === 'false') return false;
    } catch (_) { /* SSR / private mode */ }
  }
  if (typeof process !== 'undefined') {
    const v = process.env?.NEXT_PUBLIC_NEXT_EDIT_PREDICTION;
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  }
  return true;
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

// Classify a SEARCH/REPLACE pair so the UI can choose between strike-and-
// replace versus pure-insert visualisation. The previous implementation
// always struck the SEARCH range and showed the full REPLACE text below —
// which read as "this is being deleted" even when the model was just
// inserting new lines after a piece of unchanged code. Detect that case
// and skip the strike.
//
//   - 'noop'    : SEARCH === REPLACE (or trivial). Nothing to render.
//   - 'append'  : REPLACE.startsWith(SEARCH). Show only the added tail
//                 below the SEARCH range, no strikethrough.
//   - 'prepend' : REPLACE.endsWith(SEARCH). Show only the added head
//                 above the SEARCH range, no strikethrough.
//   - 'modify'  : the SEARCH text genuinely changes. Strike + full REPLACE
//                 preview, the original behaviour.
const classifyEditDiff = (search, replace) => {
  if (typeof search !== 'string' || typeof replace !== 'string') {
    return { kind: 'modify' };
  }
  if (search === replace) return { kind: 'noop' };
  if (replace.startsWith(search)) {
    let added = replace.slice(search.length);
    // Strip exactly one leading newline — the view zone sits visually
    // below the SEARCH end line, so the line break separating SEARCH
    // from the added tail is implicit in the zone's placement.
    if (added.startsWith('\n')) added = added.slice(1);
    if (!added) return { kind: 'noop' };
    return { kind: 'append', added };
  }
  if (replace.endsWith(search)) {
    let added = replace.slice(0, replace.length - search.length);
    if (added.endsWith('\n')) added = added.slice(0, -1);
    if (!added) return { kind: 'noop' };
    return { kind: 'prepend', added };
  }
  return { kind: 'modify' };
};

// Walk a workspace file tree (rawFiles) looking for the first node whose
// path matches `targetPath` exactly. Used by the Tab cascade to convert a
// path string from a NEP block into a real file-tree node so we can dispatch
// selectFileThunk and switch tabs to a non-active prediction target.
const findNodeByPath = (nodes, targetPath) => {
  if (!Array.isArray(nodes) || !targetPath) return null;
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.isFolder) {
      if (Array.isArray(n.children)) stack.push(...n.children);
    } else if (n.path === targetPath) {
      return n;
    }
  }
  return null;
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
  // Optional cross-file enablers. When both are provided, NEP can decorate
  // and jump to predictions in files other than the currently-active one.
  // (`dispatch` is the redux dispatch; `rawFiles` is the workspace tree.)
  dispatch = null,
  rawFiles = [],
  // After-apply hook — fires once a NEP block has been written into the
  // model. Editor.jsx wires this to the same Ctrl+S pipeline (collab-server
  // REST save, worker disk sync, LSP didSave, HMR compile) so a NEP-applied
  // edit lands durably in the cloud instead of relying on Yjs flush timing.
  onApply = null,
}) => {
  const [enabled, setEnabled] = useState(() => isNepEnabled());
  const [nepState, setNepState] = useState(STATE.IDLE);
  // Paths with at least one queued NEP prediction. The tab bar reads this
  // to badge tabs whose file has a pending prediction the user can't see
  // unless they switch to it (the gutter dot only renders against the
  // active editor's model). Recomputed every time the queue mutates.
  const [predictedPaths, setPredictedPaths] = useState(() => new Set());

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

  // Per-model decoration ids for the gutter dot + line highlight.
  // Keyed by `model.uri.toString()` so a prediction targeting a non-active
  // file can decorate that file's Monaco model directly — the dot becomes
  // visible whenever the user switches to that tab. Decorations on a model
  // survive editor remounts because they're attached to the model itself,
  // not to the editor instance.
  const decorationIdsByModelRef = useRef(new Map());

  // Inline diff-preview artifacts: a Monaco view zone (multi-line ghost
  // box below the SEARCH range showing the REPLACE text) + a content widget
  // (the floating "Tab to apply" hint). Tracked here so they can be torn
  // down on state transitions, queue advance, workspace reset, and
  // cross-file jumps. Only ever bound to the ACTIVE editor's model — the
  // strikethrough/preview only renders for predictions in the active file;
  // cross-file predictions get the gutter dot + tab badge until the user
  // jumps and the active model becomes the prediction's target.
  const previewArtifactsRef = useRef({ zoneId: null, widget: null, zoneNode: null });

  // Pending cross-file jump. When the Tab cascade fires for a prediction
  // whose target path isn't the active file, we dispatch selectFileThunk
  // to switch tabs and stash the jump details here. The activeFile-watching
  // effect below catches the switch and applies the reveal+setPosition
  // once Editor.jsx's model effect has had a chance to bind the new model.
  const pendingJumpRef = useRef(null);

  // ── lifecycle: workspace reset ──────────────────────────────────────────
  useEffect(() => {
    recentEditsRef.current = resetNepBuffer();
    queueRef.current = [];
    queueIndexRef.current = 0;
    lastAppliedEditRef.current = null;
    sessionFireCountRef.current = 0;
    setPredictedPaths((prev) => (prev.size ? new Set() : prev));
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
    if (typeof window === 'undefined') return undefined;
    // Expose a stable toggle on window so users can flip NEP without
    // touching DevTools' source. `synthiNep.enable()`/`disable()`/`toggle()`
    // persist in localStorage and update React state immediately.
    const toggle = (next) => {
      const v = next ?? !isNepEnabled();
      try { window.localStorage?.setItem?.(NEP_LOCAL_STORAGE_KEY, v ? '1' : '0'); }
      catch (_) { /* ignored */ }
      window.__SYNTHI_NEP_ENABLED__ = !!v;
      setEnabled(!!v);
      console.log(`[NEP] ${v ? 'enabled' : 'disabled'}`);
      return !!v;
    };
    window.synthiNep = {
      enable: () => toggle(true),
      disable: () => toggle(false),
      toggle: () => toggle(),
      status: () => isNepEnabled(),
    };
    return () => {
      try { delete window.synthiNep; } catch (_) { /* ignored */ }
    };
  }, []);

  // ── helpers ─────────────────────────────────────────────────────────────

  // Find the Monaco model for a workspace-relative path. Tries the canonical
  // `file:///synthi/<path>` URI shape Editor.jsx creates, then falls back to
  // a scan over all live models for a matching path/fsPath suffix.
  const findModelForPath = useCallback((targetPath) => {
    if (!monacoInstance || !targetPath) return null;
    try {
      const norm = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
      const uri = monacoInstance.Uri.parse(`file:///synthi/${norm}`);
      const direct = monacoInstance.editor.getModel(uri);
      if (direct) return direct;
    } catch (_) { /* fall through */ }
    try {
      const models = monacoInstance.editor.getModels?.() || [];
      for (const m of models) {
        const u = m.uri;
        if (!u) continue;
        const uriPath = (u.path || '').replace(/^\/+/, '');
        const fsPath = (u.fsPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (uriPath === targetPath || fsPath === targetPath
            || uriPath.endsWith('/' + targetPath) || fsPath.endsWith('/' + targetPath)) {
          return m;
        }
        // Also recognize the synthi-prefixed shape: `synthi/<targetPath>`.
        if (uriPath === `synthi/${targetPath}` || uriPath.endsWith(`/synthi/${targetPath}`)) {
          return m;
        }
      }
    } catch (_) { /* ignored */ }
    return null;
  }, [monacoInstance]);

  const clearDecorations = useCallback(() => {
    if (!monacoInstance) return;
    const map = decorationIdsByModelRef.current;
    for (const [uriStr, ids] of map) {
      if (!ids?.length) continue;
      try {
        const uri = monacoInstance.Uri.parse(uriStr);
        const model = monacoInstance.editor.getModel(uri);
        if (model) {
          model.deltaDecorations(ids, []);
        }
      } catch (_) { /* model gone */ }
    }
    map.clear();
  }, [monacoInstance]);

  // Tear down the inline diff-preview view-zone + content widget. Safe to
  // call when nothing is mounted (no-op).
  const clearEditPreview = useCallback(() => {
    const { zoneId, widget } = previewArtifactsRef.current;
    if (editorInstance) {
      if (zoneId !== null) {
        try {
          editorInstance.changeViewZones((accessor) => {
            accessor.removeZone(zoneId);
          });
        } catch (_) { /* zone already gone */ }
      }
      if (widget) {
        try { editorInstance.removeContentWidget(widget); } catch (_) { /* widget already gone */ }
      }
    }
    previewArtifactsRef.current = { zoneId: null, widget: null, zoneNode: null };
  }, [editorInstance]);

  // Read the editor's resolved fontInfo so the preview's monospace text
  // matches the surrounding code metrics — same fix as the inline-completion
  // ghost text (see providers.js). Without this the view-zone DOM lives
  // outside the editor's font cascade and renders at browser-default size,
  // which is what made the user describe everything as "tiny".
  const getEditorFontMetrics = useCallback(() => {
    if (!editorInstance || !monacoInstance) return null;
    try {
      const EditorOption = monacoInstance.editor.EditorOption;
      if (!EditorOption) return null;
      const fontInfo = editorInstance.getOption(EditorOption.fontInfo);
      if (!fontInfo) return null;
      return {
        fontFamily: fontInfo.fontFamily,
        fontWeight: fontInfo.fontWeight,
        fontSize: fontInfo.fontSize,
        lineHeight: fontInfo.lineHeight,
        letterSpacing: fontInfo.letterSpacing,
        fontFeatureSettings: fontInfo.fontFeatureSettings,
      };
    } catch (_) {
      return null;
    }
  }, [editorInstance, monacoInstance]);

  // Render the inline diff preview as a Monaco view zone showing some
  // ghost-tokenized text at a chosen line. The caller picks the text and
  // placement based on the edit kind — see renderJumpHint for the dispatch:
  // 'modify' shows the full REPLACE below the SEARCH range, 'append' shows
  // only the added tail, 'prepend' shows only the added head above. Only
  // ever attached to the active editor.
  //
  // placement: { afterLineNumber: number, text: string, label: string }
  //   afterLineNumber follows Monaco's view-zone semantics: 0 places the
  //   zone above line 1, N places it after line N.
  const renderEditPreview = useCallback(async (placement) => {
    if (!editorInstance || !monacoInstance || !placement) return;
    const text = placement.text || '';
    if (!text) return;
    const afterLineNumber = placement.afterLineNumber;
    if (typeof afterLineNumber !== 'number' || afterLineNumber < 0) return;
    const labelText = placement.label || 'Next edit';

    const metrics = getEditorFontMetrics();

    const zoneNode = document.createElement('div');
    zoneNode.className = 'synthi-nep-replace-preview';
    if (metrics) {
      if (metrics.fontFamily) zoneNode.style.fontFamily = metrics.fontFamily;
      if (typeof metrics.fontSize === 'number') zoneNode.style.fontSize = metrics.fontSize + 'px';
      if (typeof metrics.lineHeight === 'number') zoneNode.style.lineHeight = metrics.lineHeight + 'px';
      if (typeof metrics.letterSpacing === 'number') zoneNode.style.letterSpacing = metrics.letterSpacing + 'px';
      if (metrics.fontFeatureSettings) zoneNode.style.fontFeatureSettings = metrics.fontFeatureSettings;
    }

    const lines = text.split('\n');
    const heightInLines = Math.max(1, lines.length);

    let colorized = '';
    try {
      const html = await monacoInstance.editor.colorize(
        text,
        activeLanguage || 'plaintext',
        { tabSize: 4 },
      );
      colorized = typeof html === 'string' ? html : '';
    } catch (_) { /* fallthrough to plain-text fallback */ }

    const escapeHtml = (s) => s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (!colorized) {
      colorized = lines.map((l) => escapeHtml(l)).join('<br/>');
    }

    zoneNode.innerHTML = `
      <div class="synthi-nep-replace-preview__rail" aria-hidden="true"></div>
      <div class="synthi-nep-replace-preview__body">
        <div class="synthi-nep-replace-preview__label">
          <span class="synthi-nep-replace-preview__icon">↳</span>
          <span>${escapeHtml(labelText)} · <kbd>Tab</kbd> to apply</span>
        </div>
        <div class="synthi-nep-replace-preview__code">${colorized}</div>
      </div>
    `;

    let zoneId = null;
    try {
      editorInstance.changeViewZones((accessor) => {
        zoneId = accessor.addZone({
          afterLineNumber,
          heightInLines,
          domNode: zoneNode,
          suppressMouseDown: true,
        });
      });
    } catch (_) { /* view zone failed to attach — fall back to no preview */ }

    previewArtifactsRef.current = {
      zoneId,
      widget: previewArtifactsRef.current.widget,
      zoneNode,
    };
  }, [editorInstance, monacoInstance, activeLanguage, getEditorFontMetrics]);

  const renderJumpHint = useCallback((entry, opts = {}) => {
    if (!monacoInstance || !entry) {
      clearDecorations();
      clearEditPreview();
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
      clearEditPreview();
      return;
    }

    // Always start from a clean slate so decorations from a previous
    // queue entry (possibly in a different file) don't linger.
    clearDecorations();
    clearEditPreview();

    const model = findModelForPath(path);
    if (!model) {
      // Predicted file isn't open as a tab — its Monaco model doesn't
      // exist, so the primary gutter dot has nothing to bind to. Fall back
      // to a hint dot in the ACTIVE editor's gutter at the user's cursor
      // line so they have a visible "Tab to jump" signal. Without this the
      // prediction is silently invisible until the user opens the target
      // tab. Tab itself still works via the cross-file selectFileThunk
      // path; once the new tab's model exists the activeFile-watching
      // effect re-runs renderJumpHint against it and the proper dot lands.
      try {
        const fallbackModel = editorInstance?.getModel?.();
        if (!fallbackModel) return;
        const cursor = editorInstance.getPosition?.();
        const hintLine = Math.max(1, cursor?.lineNumber || 1);
        const Range = monacoInstance.Range;
        const target = path.split('/').filter(Boolean).pop() || path;
        const newDecorations = [{
          range: new Range(hintLine, 1, hintLine, 1),
          options: {
            isWholeLine: false,
            glyphMarginClassName: NEP_CROSSFILE_GUTTER_CLASS,
            glyphMarginHoverMessage: {
              value: `Next-edit prediction queued for **${target}** (line ${line}) — Tab to jump`,
            },
          },
        }];
        const newIds = fallbackModel.deltaDecorations([], newDecorations);
        decorationIdsByModelRef.current.set(fallbackModel.uri.toString(), newIds);
      } catch (_) { /* decoration churn is best-effort */ }
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

      // Edit-kind dispatch. Pure additive edits (REPLACE = SEARCH + tail or
      // head + SEARCH) don't get a strikethrough — slashing through code the
      // model is keeping verbatim was reading as "this is being deleted"
      // when the model was just inserting new lines around it. Modifying
      // edits keep the strike + full REPLACE preview behaviour.
      let placement = null;
      if (entry.kind === NEP_BLOCK_KIND.SEARCH && !opts.confirm) {
        const activePath = activeFile?.path || activeFile?.name;
        const isActiveTarget = entry.location?.path && entry.location.path === activePath;

        // Locate the SEARCH range in the target model so we know where to
        // anchor the preview view zone (above or below) and, for 'modify',
        // where to draw the strike.
        let startLine = null;
        let endLine = null;
        let searchRange = null;
        try {
          const value = model.getValue();
          const offset = value.indexOf(entry.block?.search ?? '');
          if (offset >= 0 && entry.block?.search) {
            const startPos = model.getPositionAt(offset);
            const endPos = model.getPositionAt(offset + entry.block.search.length);
            startLine = startPos.lineNumber;
            endLine = endPos.lineNumber;
            searchRange = new Range(
              startPos.lineNumber, startPos.column,
              endPos.lineNumber, endPos.column,
            );
          }
        } catch (_) { /* model out of sync */ }

        if (searchRange) {
          const diff = classifyEditDiff(entry.block?.search, entry.block?.replace);

          if (diff.kind === 'modify') {
            newDecorations.push({
              range: searchRange,
              options: {
                inlineClassName: NEP_SEARCH_STRIKE_CLASS,
                hoverMessage: { value: 'Next-edit prediction will replace this text — Tab to apply' },
              },
            });
            if (isActiveTarget) {
              placement = {
                afterLineNumber: endLine,
                text: entry.block.replace,
                label: 'Replace',
              };
            }
          } else if (diff.kind === 'append' && isActiveTarget) {
            placement = {
              afterLineNumber: endLine,
              text: diff.added,
              label: 'Insert',
            };
          } else if (diff.kind === 'prepend' && isActiveTarget) {
            // afterLineNumber = startLine - 1 places the zone immediately
            // above the SEARCH range. Clamp at 0 so a prediction at line 1
            // still renders (Monaco treats afterLineNumber: 0 as "above
            // line 1").
            placement = {
              afterLineNumber: Math.max(0, startLine - 1),
              text: diff.added,
              label: 'Insert',
            };
          }
        }
      }

      const newIds = model.deltaDecorations([], newDecorations);
      decorationIdsByModelRef.current.set(model.uri.toString(), newIds);

      // Fire-and-forget — colorize() is async but the preview is purely
      // decorative; we never block the Tab cascade on it.
      if (placement) {
        renderEditPreview(placement).catch(() => { /* preview is decorative */ });
      }
    } catch (_) { /* decoration churn is best-effort */ }
  }, [monacoInstance, clearDecorations, clearEditPreview, findModelForPath,
      activeFile, renderEditPreview]);

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

  // Recompute the predictedPaths set from the queue's REMAINING entries
  // (cursor onwards). Called after every queue mutation (push / advance /
  // clear) so the tab-bar badge tracks reality — a path stays predicted
  // only while at least one entry at-or-after the cursor still references
  // it. Already-accepted entries don't count.
  const syncPredictedPaths = useCallback(() => {
    const set = new Set();
    const start = queueIndexRef.current;
    for (let i = start; i < queueRef.current.length; i++) {
      const entry = queueRef.current[i];
      const p = entry?.kind === NEP_BLOCK_KIND.SEARCH
        ? entry.location?.path
        : entry?.block?.path;
      if (p) set.add(p);
    }
    setPredictedPaths((prev) => {
      // Skip the state update when nothing actually changed — this keeps
      // the tab bar from re-rendering on every keystroke that fires a
      // sync no-op.
      if (prev.size !== set.size) return set;
      for (const p of set) if (!prev.has(p)) return set;
      return prev;
    });
  }, []);

  const resetToIdle = useCallback((reason = 'reset') => {
    cancelInflight(reason);
    queueRef.current = [];
    queueIndexRef.current = 0;
    pendingJumpRef.current = null;
    clearDecorations();
    clearEditPreview();
    setPredictedPaths((prev) => (prev.size ? new Set() : prev));
    setNepState(STATE.IDLE);
  }, [cancelInflight, clearDecorations, clearEditPreview]);

  // Cross-file jump completion. After Tab dispatches selectFileThunk for a
  // prediction in a non-active file, Editor.jsx remounts the editor with
  // the new model on the next render. We watch activeFile and, once it
  // matches the queued jump, finish the reveal+setPosition and re-render
  // the gutter dot against the now-existing model.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || !editorInstance) return;
    const currentPath = activeFile?.path || activeFile?.name;
    if (!currentPath || currentPath !== pending.path) return;

    pendingJumpRef.current = null;

    // Defer one tick so Editor.jsx's `setModel` effect has had a chance to
    // bind the target model to the editor instance — without this we'd
    // call revealLineInCenter on the previous file's model.
    const timer = setTimeout(() => {
      try {
        editorInstance.revealLineInCenter(pending.line);
        editorInstance.setPosition({ lineNumber: pending.line, column: 1 });
        editorInstance.focus?.();
      } catch (_) { /* model not ready yet */ }

      // Re-render decorations: the model only just came into existence, so
      // the renderJumpHint call from when the prediction landed had nothing
      // to decorate against. Replay against the current queue entry so the
      // dot + line tint show up after the tab switch.
      const idx = queueIndexRef.current;
      const entry = queueRef.current[idx];
      if (entry) {
        renderJumpHint(entry, {
          confirm: nepState === STATE.ARMED_CONFIRM,
        });
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [activeFile, editorInstance, renderJumpHint, nepState]);

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

        recentEditsRef.current = pushNepEdit(recentEditsRef.current, {
          path,
          snippet,
          // Stash the raw inserted text so fireNep can synthesise an
          // appliedEdit for the impact endpoint when the user hasn't
          // accepted a NEP block yet. Without this, the very first NEP
          // fire (and every fire until an apply lands) skips edit-impact
          // and the model sees no cross-file candidates.
          insertedText,
        });

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
    // Refresh server-kill cache (60s TTL — cheap on hit). Awaited so the
    // first fire after a flag flip blocks until the response lands; every
    // subsequent fire within the TTL window is a Date.now() compare.
    try { await checkServerKill(); } catch (_) { /* network — ignored */ }
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

    // Eager neighbour prefetch: race the workspace's likely cross-file
    // targets into the cache before we send the prompt, so the model has a
    // substrate to predict against. Without this, the prefetch that
    // selectFileThunk schedules at medium priority often hasn't completed
    // yet when the user finishes typing, and NEP's payload only contains
    // the active file. Bounded by a hard 250 ms timeout — if files don't
    // land in time we fire with what we have and let the validator's
    // hydrateFile fallback fetch each block's target on demand.
    if (workspaceSlug && Array.isArray(rawFiles) && rawFiles.length) {
      const dir = activePath && activePath.includes('/')
        ? activePath.slice(0, activePath.lastIndexOf('/'))
        : '';
      const collected = [];
      const stack = [...rawFiles];
      while (stack.length && collected.length < 12) {
        const n = stack.pop();
        if (!n) continue;
        if (n.isFolder) {
          if (Array.isArray(n.children)) stack.push(...n.children);
          continue;
        }
        if (!n.path || n.path === activePath) continue;
        const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
        // Same-directory siblings first; recently-edited paths next.
        if (parent === dir) collected.push(n.path);
      }
      // Also prioritise paths that already showed up in the recent-edit
      // ring buffer — the user touched them, the model is most likely to
      // chase a refactor across them.
      const editPaths = new Set(
        (recentEditsRef.current || []).map((e) => e?.path).filter(Boolean)
      );
      for (const p of editPaths) {
        if (p !== activePath && !collected.includes(p)) collected.push(p);
      }
      const toFetch = collected
        .filter((p) => typeof fileCache.get(p) !== 'string')
        .slice(0, 8);
      if (toFetch.length) {
        try {
          await Promise.race([
            Promise.all(toFetch.map((p) =>
              loadScheduler.requestFileContent(workspaceSlug, p, { priority: 'high' })
                .catch(() => null)
            )),
            new Promise((resolve) => setTimeout(resolve, 250)),
          ]);
        } catch (_) { /* best-effort */ }
        if (controller.signal.aborted) return;
      }
    }

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

    if (typeof console !== 'undefined' && console.info) {
      console.info(`[NEP] fire — workspace=${workspaceSlug || '?'} active=${activePath} files=${Object.keys(files).length} recentEdits=${recentEditsRef.current.length}`);
    }

    const cursor = editorInstance.getPosition?.()
      ? {
          line: editorInstance.getPosition().lineNumber,
          column: editorInstance.getPosition().column,
        }
      : null;

    // Synthesise an appliedEdit from the most recent keystroke-driven edit
    // when no NEP block has been accepted yet. The impact endpoint extracts
    // identifiers from `search` to seed the symbol-graph BFS, so passing
    // the freshly-typed text is enough to find cross-file candidates —
    // we don't have the pre-edit text on hand for a synthetic `replace`,
    // and the endpoint tolerates equal search/replace (it just unions the
    // identifiers). Real applied edits always win when present.
    let appliedEdit = lastAppliedEditRef.current;
    if (!appliedEdit) {
      const buf = recentEditsRef.current;
      if (Array.isArray(buf) && buf.length) {
        const last = buf[buf.length - 1];
        const text = (typeof last?.insertedText === 'string' && last.insertedText.trim())
          ? last.insertedText
          : null;
        if (last?.path && text) {
          appliedEdit = { path: last.path, search: text, replace: text, kind: null };
        }
      }
    }

    const payload = {
      workspaceSlug: workspaceSlug || null,
      language: activeLanguage || 'plaintext',
      activePath,
      cursor,
      recentEdits: recentEditsRef.current.map((e) => ({ path: e.path, snippet: e.snippet })),
      files,
      // Phase 2: send the last applied edit so the route can pull impact
      // candidates from the symbol graph and inject them into the prompt.
      // Falls back to a synthetic edit derived from the user's last
      // keystroke so the cross-file path bootstraps without needing an
      // earlier NEP accept.
      appliedEdit,
    };

    recordNepEvent('fire', {
      has_applied_edit: Boolean(lastAppliedEditRef.current),
      has_synthetic_edit: Boolean(appliedEdit) && !lastAppliedEditRef.current,
    });

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

    // Cross-file unblock (NEP plan §6, Phase 2): the validator must be able
    // to read any workspace file, not just ones the user has open. Falls
    // back to the singleton fileCache (loadScheduler-populated) so prefetch
    // and on-demand fetches both feed validation. Without this every block
    // targeting a closed file would reject as `file_missing`.
    const liveReader = (p) => {
      if (!p) return null;
      if (typeof getLiveFileContent === 'function') {
        const v = getLiveFileContent(p);
        if (typeof v === 'string') return v;
      }
      if (p === activePath && typeof liveActiveContent === 'string') {
        return liveActiveContent;
      }
      const fromPayload = files[p];
      if (typeof fromPayload === 'string') return fromPayload;
      try {
        const v = fileCache.get(p);
        if (typeof v === 'string') return v;
      } catch (_) { /* singleton miss */ }
      return null;
    };

    // Best-effort async hydration: if a block lands for a file we don't have
    // content for yet, fetch it via loadScheduler (which hits collab-server
    // and populates the singleton fileCache that liveReader reads from).
    // Bounded by the abort controller — if the stream tore or the user
    // typed, we stop fetching. Errors fall through to file_missing.
    const hydrateFile = async (path) => {
      if (!path || !workspaceSlug) return;
      if (typeof liveReader(path) === 'string') return;
      try {
        await loadScheduler.requestFileContent(workspaceSlug, path, { priority: 'high' });
      } catch (_) { /* validator will reject as file_missing */ }
    };

    const ingest = async (results) => {
      for (const result of results) {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          recordNepEvent('rejected', {
            reason: result.reason || REJECT_REASONS.PARSE_ERROR,
            detail: result.detail,
          });
          if (typeof console !== 'undefined' && console.info) {
            console.info(`[NEP] block parse-rejected: reason=${result.reason} detail=${result.detail || ''}`);
          }
          continue;
        }
        recordNepEvent('emitted');
        const block = result.block;
        await hydrateFile(block.path);
        if (controller.signal.aborted) return;
        const v = validateBlock(block, liveReader);

        let entry = null;
        if (block.kind === NEP_BLOCK_KIND.SEARCH) {
          if (!v.ok) {
            recordNepEvent('rejected', { reason: v.reason, path: v.path || block.path });
            if (typeof console !== 'undefined' && console.info) {
              console.info(`[NEP] block validate-rejected: path=${block.path} reason=${v.reason} cross_file=${block.path !== activePath}`);
            }
            continue;
          }
          recordNepEvent('validated', { kind: block.kind });
          const line = locateBlock(block, liveReader);
          if (!line) continue;
          entry = { kind: NEP_BLOCK_KIND.SEARCH, block, location: { path: block.path, line } };
          if (typeof console !== 'undefined' && console.info) {
            console.info(`[NEP] block validated: path=${block.path}:${line} cross_file=${block.path !== activePath}`);
          }
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
          if (typeof console !== 'undefined' && console.info) {
            console.info(`[NEP] SEARCH ALL validated: path=${block.path} sites=${sites.length}`);
          }
        } else {
          continue;
        }
        if (!entry) continue;
        queueRef.current.push(entry);
        syncPredictedPaths();
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
        await ingest(parser.feed(decoder.decode(value, { stream: true })));
      }
      await ingest(parser.feed(decoder.decode()));
      await ingest(parser.flush());
    } catch (_) {
      // Stream tore mid-block — anything we already armed is still valid.
    }

    if (!armedYet) setNepState(STATE.IDLE);
  }, [
    enabled, editorInstance, activeFile, activeLanguage, workspaceSlug,
    getFileCacheEntries, getLiveFileContent, cancelInflight, renderJumpHint,
    syncPredictedPaths,
  ]);

  useEffect(() => { fireNepRef.current = fireNep; }, [fireNep]);

  // ── write helper ────────────────────────────────────────────────────────
  // The collab-server is the source of truth. Three write paths:
  //   1. Active file → setValue on the active model (current Yjs binding
  //      broadcasts through collab-server).
  //   2. Other open file (user has it in another tab) → setValue on that
  //      tab's model so the user sees the change immediately and Yjs
  //      reconciles via collab-server.
  //   3. Closed file → gitClient.writeFile, which hits collab-server's
  //      /git/:slug/write-file. The next time the user opens the file they
  //      see the new content. We do NOT touch Monaco's RegisteredMemoryFile
  //      cache — collab-server is authoritative; the cache reloads on open.
  const findOpenModel = useCallback((targetPath) => {
    if (!monacoInstance || !targetPath) return null;
    try {
      const models = monacoInstance.editor.getModels?.() || [];
      for (const m of models) {
        const uri = m.uri;
        if (!uri) continue;
        const uriPath = (uri.path || '').replace(/^\/+/, '');
        const fsPath = (uri.fsPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (uriPath === targetPath || fsPath === targetPath || uriPath.endsWith('/' + targetPath)) {
          return m;
        }
      }
    } catch (_) { /* ignored */ }
    return null;
  }, [monacoInstance]);

  // Replace a model's full content via pushEditOperations. We can't use
  // model.setValue here: setValue raises onDidChangeContent with
  // e.isFlush=true, and collabClient's local-change listener (collabClient.js:128)
  // bails on flush events. The result is the user-reported bug — the
  // edit shows up in the editor but never broadcasts through Yjs to
  // collab-server, so on reload the file reverts to its pre-edit
  // content. pushEditOperations fires a normal (isFlush=false) change,
  // which the collab listener picks up and forwards to the worker /
  // y-sweet, persisting the edit on disk.
  const replaceModelContent = useCallback((model, newContent) => {
    if (!model) return false;
    try {
      const range = model.getFullModelRange();
      model.pushEditOperations(
        [],
        [{ range, text: newContent, forceMoveMarkers: true }],
        () => null,
      );
      return true;
    } catch (_) {
      return false;
    }
  }, []);

  const writeFileContent = useCallback(async (targetPath, content) => {
    const activePath = activeFile?.path || activeFile?.name;
    // (1) Active file → write through the active model. Most common path.
    if (targetPath === activePath) {
      const model = editorInstance?.getModel?.();
      if (model && replaceModelContent(model, content)) {
        return { via: 'active_model' };
      }
    }
    // (2) Other open file → write through its model.
    const openModel = findOpenModel(targetPath);
    if (openModel && replaceModelContent(openModel, content)) {
      return { via: 'open_model' };
    }
    // (3) Closed file → hit collab-server directly.
    if (!workspaceSlug) {
      throw new Error('cannot write to closed file: no workspaceSlug');
    }
    await gitClient.writeFile(workspaceSlug, targetPath, content);
    // Update the singleton cache so the next NEP fire sees the post-edit
    // content. Without this, validateBlock for chained refactors keeps
    // matching against pre-edit text (since liveReader falls back to the
    // singleton) and the second block in the chain rejects as no_match.
    try { fileCache.set(targetPath, content); } catch (_) { /* best-effort */ }
    return { via: 'collab_server' };
  }, [editorInstance, activeFile, monacoInstance, workspaceSlug, findOpenModel, replaceModelContent]);

  // Run the host-supplied save pipeline (REST persist, worker disk sync,
  // LSP didSave, HMR retrigger) once an apply has landed. Best-effort —
  // a thrown onApply must not prevent the queue from advancing, the
  // model already has the edit and Yjs will eventually broadcast it.
  const runOnApply = useCallback(async (path, content) => {
    if (typeof onApply !== 'function') return;
    try { await onApply(path, content); }
    catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[NEP] onApply threw for ${path}:`, err?.message || err);
      }
    }
  }, [onApply]);

  // ── apply helpers ───────────────────────────────────────────────────────
  const applySearchBlock = useCallback(async (entry) => {
    const next = applyBlock(entry.block, getLiveFileContent);
    const path = entry.block.path;
    let writeResult;
    try {
      writeResult = await writeFileContent(path, next);
    } catch (err) {
      // Apply failed at the write layer — surface to telemetry and bail.
      // The prediction was already validated, so this is an infrastructure
      // failure (collab-server unreachable, permissions, etc), not a model
      // quality issue.
      recordNepEvent('rejected', { reason: 'write_failed', detail: err?.message, path });
      throw err;
    }
    await runOnApply(path, next);
    // Classify + stash for the next NEP fire's appliedEdit. This is what
    // closes the cross-file refactor-chase loop: Phase 2 prompt sees the
    // applied edit, /code-intel/edit-impact returns the next sites.
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
    recordNepEvent('accepted', { kind: NEP_BLOCK_KIND.SEARCH, path, via: writeResult?.via });
  }, [getLiveFileContent, writeFileContent, runOnApply]);

  /**
   * Apply a SEARCH ALL block at a SINGLE site identified by byte-offset.
   * Used by the per-site confirmation flow. Re-validates by recomputing the
   * offset against the LIVE file (in case prior accepts shifted text).
   *
   * Cross-file aware via writeFileContent.
   */
  const applySearchAllSite = useCallback(async (entry, siteIdx) => {
    const path = entry.block.path;
    const live = getLiveFileContent ? getLiveFileContent(path) : null;
    if (typeof live !== 'string') throw new Error('live content missing for ' + path);
    const offsets = findAllOffsets(live, entry.block.search);
    if (siteIdx >= offsets.length) {
      // Site is gone (prior accept shifted text and removed this match).
      // Skip silently.
      return live;
    }
    const offset = offsets[siteIdx];
    const next = live.slice(0, offset) + entry.block.replace + live.slice(offset + entry.block.search.length);
    await writeFileContent(path, next);
    await runOnApply(path, next);
    return next;
  }, [getLiveFileContent, writeFileContent, runOnApply]);

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
        // Recompute predicted-paths so the tab badge for an accepted
        // entry's file disappears once nothing else is queued for it.
        syncPredictedPaths();
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
          (async () => {
            try {
              await applySearchAllSite(entry, entry.cursor ?? 0);
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
          })();
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
          (async () => {
            let safety = 200;
            let live = getLiveFileContent ? getLiveFileContent(entry.block.path) : null;
            while (typeof live === 'string' && live.indexOf(entry.block.search) !== -1 && safety-- > 0) {
              try {
                await applySearchAllSite(entry, 0);
                recordNepEvent('accepted', { kind: NEP_BLOCK_KIND.SEARCH_ALL, path: entry.block.path, batch: true });
              } catch (err) { break; }
              live = getLiveFileContent ? getLiveFileContent(entry.block.path) : null;
            }
            advanceQueue();
          })();
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
          // Dismiss any active inline-completion suggestion so Tab doesn't
          // simultaneously commit ghost text AND jump to the NEP site. Monaco's
          // keybinding system for "editor.action.inlineSuggest.commit" fires
          // after onKeyDown listeners and is not stopped by e.stopPropagation(),
          // so we explicitly hide the inline suggest before it can commit.
          try { editorInstance.trigger('nep', 'editor.action.inlineSuggest.hide', null); } catch (_) {}
          const path = entry.location?.path;
          const line = entry.location?.line;
          const activePath = activeFile?.path || activeFile?.name;
          if (path && path === activePath) {
            try {
              editorInstance.revealLineInCenter(line);
              editorInstance.setPosition({ lineNumber: line, column: 1 });
            } catch (_) { /* ignored */ }
          } else if (path && line && dispatch) {
            // Cross-file jump. Try the workspace tree first; fall back to a
            // synthetic file node when the path isn't represented there
            // (freshly-created files not yet reflected in `rawFiles`,
            // anything outside the user-visible tree). selectFileThunk
            // only needs `.path` to load — name/type are for display, and
            // the loadScheduler will fetch content from the collab-server
            // disk on cache miss. If the file genuinely doesn't exist on
            // disk the thunk rejects silently, same as if a manual file
            // open had been attempted.
            const targetNode = (Array.isArray(rawFiles) ? findNodeByPath(rawFiles, path) : null)
              || {
                name: path.split('/').filter(Boolean).pop() || path,
                type: 'file',
                path,
              };
            pendingJumpRef.current = { path, line };
            if (typeof console !== 'undefined' && console.info) {
              console.info(`[NEP] cross-file jump: ${activePath} → ${path}:${line}`);
            }
            try { dispatch(selectFileThunk(targetNode)); }
            catch (err) {
              console.warn('[NEP] cross-file selectFileThunk threw:', err?.message);
              pendingJumpRef.current = null;
            }
          }
          setNepState(STATE.ARMED_CURRENT);
          return;
        }
        if (nepState === STATE.ARMED_CURRENT) {
          e.preventDefault();
          e.stopPropagation();
          (async () => {
            try {
              await applySearchBlock(entry);
              advanceQueue();
            } catch (err) {
              recordNepEvent('rejected', { reason: 'revalidate_failed', detail: err?.message });
              resetToIdle('revalidate-failed');
            }
          })();
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
    dispatch, rawFiles, syncPredictedPaths,
  ]);

  return {
    nepState,
    enabled,
    setEnabled,
    // Set of file paths with at least one queued NEP prediction. The
    // tab-bar consumer reads this to badge tabs whose dot-on-the-gutter
    // can't be seen because the user isn't currently viewing that file.
    predictedPaths,
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
