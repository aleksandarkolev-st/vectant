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
  findIndentTolerantMatch,
  reindentReplace,
  NEP_BLOCK_KIND,
  REJECT_REASONS,
} from '@/lib/nextEdit';
import {
  pushNepEdit,
  resetNepBuffer,
  renderRecentEditsBlock,
} from '@/utils/nepRecentEdits';
import { buildNepContextPacket } from '@/utils/aiContextBroker';
import { classifyEdit } from '@/lib/editKindClassifier';
import { recordNepEvent, isNepKilled, checkServerKill } from '@/lib/nepTelemetry';
import { recordAiReplaySample } from '@/lib/aiReplayHarness';
import { gitClient } from '@/services/gitClient';
import { fileCache } from '@/services/fileCache';
import { loadScheduler } from '@/services/loadScheduler';
import { selectFileThunk } from '@/redux/workspaceSlice';

const NEP_DEBOUNCE_MS = 400;
const NEP_MIN_INTERVAL_MS = 800; // floor between auto-fires (rate limit)
const NEP_MAX_REFINEMENT_PASSES = 1;
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

// Line-level diff for the REPLACE preview. Returns an array of REPLACE-side
// line entries tagged with whether they're new (`added: true`) versus
// preserved from SEARCH (`added: false`). Removed lines aren't emitted —
// they're visualised in-place by the strikethrough decoration.
//
// Uses a standard LCS so that a renamed line surrounded by unchanged
// context reports the rename as `added` (and the removal as a strike),
// not as an entire run of unrelated edits.
const computeLineDiff = (search, replace) => {
  const a = (search || '').split('\n');
  const b = (replace || '').split('\n');
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = m;
  let j = n;
  while (j > 0) {
    if (i > 0 && a[i - 1] === b[j - 1]) {
      out.unshift({ added: false, line: b[j - 1] });
      i--; j--;
    } else if (i === 0 || dp[i][j - 1] >= dp[i - 1][j]) {
      out.unshift({ added: true, line: b[j - 1] });
      j--;
    } else {
      // Line removed from SEARCH — visualised in-place by the strike,
      // skip from REPLACE-side preview.
      i--;
    }
  }
  return out;
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
  // True once we've hit NEP_PER_SESSION_FIRE_CAP and silently stopped
  // firing. The consumer (Editor.jsx) reads this and renders a non-blocking
  // notice — the previous behaviour (silent stop) made it look like the
  // feature had broken. Resets on workspace switch.
  const [fireCapReached, setFireCapReached] = useState(false);

  const recentEditsRef = useRef([]);
  const previousContentByPathRef = useRef(new Map());
  const lastFireRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const abortRef = useRef(null);
  const nepRequestSeqRef = useRef(0);
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

  // Cursor-anchored "predicting next edit…" indicator. Mounted only while
  // nepState === PENDING so the user knows a prediction is being computed.
  // Without this, the ~300-700 ms gap between debounce-fire and the first
  // armed gutter dot felt like the feature was simply not engaging.
  const pendingWidgetRef = useRef(null);

  // ── lifecycle: workspace reset ──────────────────────────────────────────
  useEffect(() => {
    recentEditsRef.current = resetNepBuffer();
    previousContentByPathRef.current = new Map();
    queueRef.current = [];
    queueIndexRef.current = 0;
    lastAppliedEditRef.current = null;
    sessionFireCountRef.current = 0;
    setPredictedPaths((prev) => (prev.size ? new Set() : prev));
    setFireCapReached(false);
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

  // ── pending indicator ───────────────────────────────────────────────────
  // Mount a small cursor-anchored content widget while NEP is fetching so
  // the user sees the feature engaging instead of guessing whether it
  // bailed. Tear down on every other state.
  useEffect(() => {
    if (!editorInstance || !monacoInstance) return undefined;
    if (nepState !== STATE.PENDING) {
      const w = pendingWidgetRef.current;
      if (w) {
        try { editorInstance.removeContentWidget(w); } catch (_) { /* ignored */ }
        pendingWidgetRef.current = null;
      }
      return undefined;
    }
    const node = document.createElement('span');
    node.className = 'synthi-nep-pending-pill';
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = '<span class="synthi-nep-pending-pill__dot"></span>'
      + '<span class="synthi-nep-pending-pill__dot"></span>'
      + '<span class="synthi-nep-pending-pill__dot"></span>'
      + '<span class="synthi-nep-pending-pill__label">NEP</span>';
    const widget = {
      getId: () => 'synthi.nep.pending',
      getDomNode: () => node,
      getPosition: () => {
        const pos = editorInstance.getPosition?.();
        if (!pos) return null;
        return {
          position: { lineNumber: pos.lineNumber, column: pos.column },
          preference: [
            monacoInstance.editor.ContentWidgetPositionPreference.EXACT,
            monacoInstance.editor.ContentWidgetPositionPreference.BELOW,
          ],
        };
      },
    };
    try { editorInstance.addContentWidget(widget); } catch (_) { /* ignored */ }
    pendingWidgetRef.current = widget;

    // Re-layout on cursor moves so the pill chases the caret.
    const layoutDispose = editorInstance.onDidChangeCursorPosition?.(() => {
      try { editorInstance.layoutContentWidget(widget); } catch (_) { /* ignored */ }
    });

    return () => {
      try { layoutDispose?.dispose?.(); } catch (_) { /* ignored */ }
      try { editorInstance.removeContentWidget(widget); } catch (_) { /* ignored */ }
      if (pendingWidgetRef.current === widget) pendingWidgetRef.current = null;
    };
  }, [editorInstance, monacoInstance, nepState]);

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

  // Render the inline diff preview as a Monaco view zone. Each line in the
  // placement carries an `added` flag — added lines get a green '+' marker
  // and a soft green tint so the user sees exactly what's being inserted.
  // Unchanged lines (the `false` case) only appear for 'modify' edits, where
  // they sit alongside added lines as context for the replacement; 'append'
  // and 'prepend' edits set `added: true` on every line so the entire zone
  // reads as an insert.
  //
  // placement: {
  //   afterLineNumber: number,             // Monaco view-zone semantics: 0 = above line 1.
  //   lines: [{ added: bool, line: string }],
  //   label: string,
  // }
  const renderEditPreview = useCallback(async (placement) => {
    if (!editorInstance || !monacoInstance || !placement) return;
    const lines = Array.isArray(placement.lines) ? placement.lines : null;
    if (!lines || lines.length === 0) return;
    const afterLineNumber = placement.afterLineNumber;
    if (typeof afterLineNumber !== 'number' || afterLineNumber < 0) return;
    const labelText = placement.label || 'Next edit';

    const metrics = getEditorFontMetrics();

    const escapeHtml = (s) => s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Cap the visible height. A REPLACE bigger than this is summarised
    // with a "+N more lines" tail row so the preview never eats more than
    // a screenful of viewport. Tab still applies the full block — the
    // visualisation is informational, not authoritative.
    const PREVIEW_MAX_LINES = 12;
    const overflowCount = Math.max(0, lines.length - PREVIEW_MAX_LINES);
    const visibleLines = overflowCount > 0 ? lines.slice(0, PREVIEW_MAX_LINES) : lines;

    // Per-line colorize. Loses cross-line tokenizer state (multi-line
    // strings/comments fall back to default colors) but keeps the per-line
    // structure we need to tint added rows green. NEP REPLACE blocks are
    // small enough that the parallel cost is negligible.
    const colorizeLine = async (text) => {
      if (!text) return '';
      try {
        const html = await monacoInstance.editor.colorize(
          text,
          activeLanguage || 'plaintext',
          { tabSize: 4 },
        );
        return typeof html === 'string'
          ? html.replace(/<br\s*\/?>\s*$/i, '')
          : escapeHtml(text);
      } catch (_) {
        return escapeHtml(text);
      }
    };

    const renderedLines = await Promise.all(
      visibleLines.map(async (entry) => {
        const inner = await colorizeLine(entry.line);
        const cls = entry.added
          ? 'synthi-nep-replace-preview__line synthi-nep-replace-preview__line--added'
          : 'synthi-nep-replace-preview__line';
        const marker = entry.added ? '+' : ' ';
        return `<div class="${cls}"><span class="synthi-nep-replace-preview__marker">${marker}</span><span class="synthi-nep-replace-preview__line-text">${inner || '&nbsp;'}</span></div>`;
      }),
    );

    if (overflowCount > 0) {
      renderedLines.push(
        `<div class="synthi-nep-replace-preview__line synthi-nep-replace-preview__line--overflow">`
        + `<span class="synthi-nep-replace-preview__marker">…</span>`
        + `<span class="synthi-nep-replace-preview__line-text">+${overflowCount} more line${overflowCount === 1 ? '' : 's'}</span>`
        + `</div>`,
      );
    }

    const zoneNode = document.createElement('div');
    zoneNode.className = 'synthi-nep-replace-preview';
    if (metrics) {
      if (metrics.fontFamily) zoneNode.style.fontFamily = metrics.fontFamily;
      if (typeof metrics.fontSize === 'number') zoneNode.style.fontSize = metrics.fontSize + 'px';
      if (typeof metrics.lineHeight === 'number') zoneNode.style.lineHeight = metrics.lineHeight + 'px';
      if (typeof metrics.letterSpacing === 'number') zoneNode.style.letterSpacing = metrics.letterSpacing + 'px';
      if (metrics.fontFeatureSettings) zoneNode.style.fontFeatureSettings = metrics.fontFeatureSettings;
    }

    zoneNode.innerHTML = `
      <div class="synthi-nep-replace-preview__rail" aria-hidden="true"></div>
      <div class="synthi-nep-replace-preview__body">
        <div class="synthi-nep-replace-preview__label">
          <span class="synthi-nep-replace-preview__icon">↳</span>
          <span>${escapeHtml(labelText)} · <kbd>Tab</kbd> to apply</span>
        </div>
        <div class="synthi-nep-replace-preview__code">${renderedLines.join('')}</div>
      </div>
    `;

    let zoneId = null;
    try {
      editorInstance.changeViewZones((accessor) => {
        zoneId = accessor.addZone({
          afterLineNumber,
          heightInLines: visibleLines.length + (overflowCount > 0 ? 1 : 0),
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
        let matchedFileText = null;
        try {
          const value = model.getValue();
          const search = entry.block?.search ?? '';
          let offset = search ? value.indexOf(search) : -1;
          let length = search.length;
          if (offset >= 0) {
            matchedFileText = search;
          } else if (search) {
            // Fall back to the indent-tolerant matcher so additive/replace
            // visualisation still renders for matches the validator
            // accepted via the relaxed path. Without this the strike would
            // silently drop and the user sees REPLACE-only.
            const indent = findIndentTolerantMatch(value, search);
            if (indent.ok) {
              offset = indent.offset;
              length = indent.length;
              matchedFileText = indent.fileText;
            }
          }
          if (offset >= 0 && search) {
            const startPos = model.getPositionAt(offset);
            const endPos = model.getPositionAt(offset + length);
            startLine = startPos.lineNumber;
            endLine = endPos.lineNumber;
            searchRange = new Range(
              startPos.lineNumber, startPos.column,
              endPos.lineNumber, endPos.column,
            );
          }
        } catch (_) { /* model out of sync */ }

        if (searchRange) {
          // Re-indent the model's REPLACE against the file's actual indent
          // so the preview matches what applyBlock will land. Without this,
          // an indent-tolerant match shows the model's hallucinated indent
          // — and when the model emits cumulative leading whitespace the
          // preview rows scatter across the viewport instead of stacking
          // at a consistent column. classifyEditDiff and computeLineDiff
          // both compare against matchedFileText (the file's actual text
          // for the SEARCH range) so the append/prepend prefix checks
          // succeed against post-reindent content.
          const previewBefore = matchedFileText !== null
            ? matchedFileText
            : (entry.block?.search ?? '');
          const previewAfter = (matchedFileText !== null && entry.block?.replace != null)
            ? reindentReplace(entry.block.search, entry.block.replace, matchedFileText)
            : (entry.block?.replace ?? '');
          const diff = classifyEditDiff(previewBefore, previewAfter);

          if (diff.kind === 'modify') {
            newDecorations.push({
              range: searchRange,
              options: {
                inlineClassName: NEP_SEARCH_STRIKE_CLASS,
                hoverMessage: { value: 'Next-edit prediction will replace this text — Tab to apply' },
              },
            });
            if (isActiveTarget) {
              // Per-line diff so the user sees + markers on the actually-new
              // lines rather than a wall of green claiming "everything is new".
              placement = {
                afterLineNumber: endLine,
                lines: computeLineDiff(previewBefore, previewAfter),
                label: 'Replace',
              };
            }
          } else if (diff.kind === 'append' && isActiveTarget) {
            placement = {
              afterLineNumber: endLine,
              lines: diff.added.split('\n').map((line) => ({ added: true, line })),
              label: 'Insert',
            };
          } else if (diff.kind === 'prepend' && isActiveTarget) {
            // afterLineNumber = startLine - 1 places the zone immediately
            // above the SEARCH range. Clamp at 0 so a prediction at line 1
            // still renders (Monaco treats afterLineNumber: 0 as "above
            // line 1").
            placement = {
              afterLineNumber: Math.max(0, startLine - 1),
              lines: diff.added.split('\n').map((line) => ({ added: true, line })),
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
    const remaining = Math.max(0, queueRef.current.length - queueIndexRef.current);
    if (remaining > 0 && reason !== 'drained') {
      const entry = queueRef.current[queueIndexRef.current];
      recordNepEvent('dismissed', {
        reason,
        remaining,
        kind: entry?.kind || null,
        path: entry?.block?.path || entry?.location?.path || null,
        request_id: entry?.requestId || null,
      });
      recordAiReplaySample({
        feature: 'nep',
        phase: 'dismissed',
        requestId: entry?.requestId || null,
        payload: {
          reason,
          remaining,
          entry,
        },
      });
    }
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
    try {
      const path = activeFile?.path || activeFile?.name || null;
      const model = editorInstance.getModel?.();
      if (path && model) previousContentByPathRef.current.set(path, model.getValue?.() ?? '');
    } catch (_) { /* seed is best-effort */ }

    const disposable = editorInstance.onDidChangeModelContent?.((event) => {
      try {
        const path = activeFile?.path || activeFile?.name || null;
        if (!path) return;
        const model = editorInstance.getModel?.();
        if (!model) return;
        const changes = Array.isArray(event?.changes) ? event.changes : [];
        if (!changes.length) return;
        const previousContent = previousContentByPathRef.current.get(path);
        const nextContent = model.getValue?.() ?? '';

        const sorted = [...changes].sort((a, b) => {
          const al = a?.range?.startLineNumber ?? 0;
          const bl = b?.range?.startLineNumber ?? 0;
          if (al !== bl) return al - bl;
          return (a?.range?.startColumn ?? 0) - (b?.range?.startColumn ?? 0);
        });
        const insertedText = sorted.map((c) => c?.text || '').join('').replace(/\s+$/u, '');
        const deletedText = (typeof previousContent === 'string')
          ? sorted.map((c) => {
              const off = Number(c?.rangeOffset);
              const len = Number(c?.rangeLength);
              if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0) return '';
              return previousContent.slice(off, off + len);
            }).join('').replace(/\s+$/u, '')
          : '';
        previousContentByPathRef.current.set(path, nextContent);
        if (!insertedText.trim() && !deletedText.trim()) return;

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

        const markInserted = (t) => (t ? t.split('\n').map((l) => `+ ${l}`).join('\n') : '');
        const markDeleted = (t) => (t ? t.split('\n').map((l) => `- ${l}`).join('\n') : '');
        const markContext = (t) => (t ? t.split('\n').map((l) => `  ${l}`).join('\n') : '');
        const headerLine = `@@ ${path} L${startLine}-${endLine} @@`;
        const snippet = [
          headerLine,
          markContext(before),
          markDeleted(deletedText),
          markInserted(insertedText),
          markContext(after),
        ].filter(Boolean).join('\n');

        const searchText = deletedText.trim() ? deletedText : insertedText;
        const replaceText = deletedText.trim() ? insertedText : insertedText;
        recentEditsRef.current = pushNepEdit(recentEditsRef.current, {
          path,
          snippet,
          // Stash the raw inserted text so fireNep can synthesise an
          // appliedEdit for the impact endpoint when the user hasn't
          // accepted a NEP block yet. Without this, the very first NEP
          // fire (and every fire until an apply lands) skips edit-impact
          // and the model sees no cross-file candidates.
          insertedText,
          searchText,
          replaceText,
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
        // Typing during PENDING means the in-flight stream is parsing
        // against stale file contents — its SEARCH text was selected
        // before the new keystroke landed. Cut the fetch now so the
        // debounce timer above (which we just refreshed) gets to fire
        // with the post-keystroke state. Without this we waste tokens
        // on a request the validator will mostly reject.
        if (nepState === STATE.PENDING) {
          cancelInflight('user-typed-during-pending');
          setNepState(STATE.IDLE);
        }
      } catch (_) { /* recent-edit capture is best-effort */ }
    });
    return () => { try { disposable?.dispose?.(); } catch (_) { /* ignored */ } };
    // nepState is intentionally a dep — the listener reads it to decide
    // whether to drop the queue or cancel a PENDING fetch. Without this dep
    // the closure freezes on STATE.IDLE and both code paths become dead.
    // The cost is one Monaco listener re-bind per state transition, which
    // is cheap compared to firing wasted token budget at the API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, editorInstance, activeFile, nepState, cancelInflight, resetToIdle]);

  // ── fire NEP ────────────────────────────────────────────────────────────
  const fireNep = useCallback(async (refinement = null) => {
    if (!enabled) return;
    if (!editorInstance || !activeFile) return;
    // Refresh server-kill cache (60s TTL — cheap on hit). Awaited so the
    // first fire after a flag flip blocks until the response lands; every
    // subsequent fire within the TTL window is a Date.now() compare.
    try { await checkServerKill(); } catch (_) { /* network — ignored */ }
    if (isNepKilled()) return;
    if (sessionFireCountRef.current >= NEP_PER_SESSION_FIRE_CAP) {
      // First-time hit emits a single telemetry event so we can see how
      // often users actually saturate the cap; subsequent fires within the
      // session are silently dropped. The functional setter dedups so the
      // event fires once per session even though we read no state here.
      setFireCapReached((prev) => {
        if (!prev) recordNepEvent('rejected', { reason: 'session_cap', cap: NEP_PER_SESSION_FIRE_CAP });
        return true;
      });
      return;
    }

    const now = Date.now();
    const isRefinement = Boolean(refinement?.feedback?.length);
    const refinementPass = Number(refinement?.pass || 0);
    if (!isRefinement && now - lastFireRef.current < NEP_MIN_INTERVAL_MS) return;
    lastFireRef.current = now;
    sessionFireCountRef.current += 1;

    cancelInflight('superseded');
    setNepState(STATE.PENDING);

    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++nepRequestSeqRef.current;

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
    const { files, codeIntel } = buildNepContextPacket({
      activePath,
      activeContent: liveActiveContent,
      cacheEntries,
      recentEdits: recentEditsRef.current,
    });

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
        const search = (typeof last?.searchText === 'string' && last.searchText.trim())
          ? last.searchText
          : ((typeof last?.insertedText === 'string' && last.insertedText.trim()) ? last.insertedText : null);
        const replace = typeof last?.replaceText === 'string'
          ? last.replaceText
          : null;
        if (last?.path && search) {
          appliedEdit = { path: last.path, search, replace: replace ?? search, kind: null };
        }
      }
    }

    const payload = {
      requestId,
      workspaceSlug: workspaceSlug || null,
      language: activeLanguage || 'plaintext',
      activePath,
      cursor,
      recentEdits: recentEditsRef.current.map((e) => ({ path: e.path, snippet: e.snippet })),
      files,
      codeIntel,
      validationFeedback: isRefinement ? refinement.feedback : [],
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
      request_id: requestId,
      refinement_pass: isRefinement ? refinementPass : 0,
    });
    recordAiReplaySample({
      feature: 'nep',
      phase: 'request',
      requestId,
      payload: {
        workspaceSlug: workspaceSlug || null,
        language: activeLanguage || 'plaintext',
        activePath,
        cursor,
        recentEdits: payload.recentEdits,
        filePaths: Object.keys(files),
        files,
        codeIntel,
        appliedEdit,
        validationFeedback: isRefinement ? refinement.feedback : [],
        refinementPass: isRefinement ? refinementPass : 0,
      },
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
    const validationFeedback = [];

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
            request_id: requestId,
          });
          recordAiReplaySample({
            feature: 'nep',
            phase: 'parse_rejected',
            requestId,
            payload: {
              reason: result.reason || REJECT_REASONS.PARSE_ERROR,
              detail: result.detail,
              raw: result.raw,
            },
          });
          validationFeedback.push({
            reason: result.reason || REJECT_REASONS.PARSE_ERROR,
            detail: result.detail,
            raw: result.raw,
          });
          if (typeof console !== 'undefined' && console.info) {
            console.info(`[NEP] block parse-rejected: reason=${result.reason} detail=${result.detail || ''}`);
          }
          continue;
        }
        recordNepEvent('emitted');
        const block = result.block;
        recordAiReplaySample({
          feature: 'nep',
          phase: 'emitted',
          requestId,
          payload: { block },
        });
        await hydrateFile(block.path);
        if (controller.signal.aborted) return;
        const v = validateBlock(block, liveReader);

        let entry = null;
        if (block.kind === NEP_BLOCK_KIND.SEARCH) {
          if (!v.ok) {
            recordNepEvent('rejected', { reason: v.reason, path: v.path || block.path, request_id: requestId });
            recordAiReplaySample({
              feature: 'nep',
              phase: 'validate_rejected',
              requestId,
              payload: { reason: v.reason, path: v.path || block.path, block },
            });
            validationFeedback.push({
              reason: v.reason,
              path: v.path || block.path,
              search: block.search,
              replace: block.replace,
            });
            if (typeof console !== 'undefined' && console.info) {
              console.info(`[NEP] block validate-rejected: path=${block.path} reason=${v.reason} cross_file=${block.path !== activePath}`);
            }
            continue;
          }
          const line = locateBlock(block, liveReader);
          if (!line) continue;
          recordNepEvent('validated', { kind: block.kind, request_id: requestId });
          recordAiReplaySample({
            feature: 'nep',
            phase: 'validated',
            requestId,
            payload: { kind: block.kind, path: block.path, block, line },
          });
          entry = { kind: NEP_BLOCK_KIND.SEARCH, requestId, block, location: { path: block.path, line } };
          if (typeof console !== 'undefined' && console.info) {
            console.info(`[NEP] block validated: path=${block.path}:${line} cross_file=${block.path !== activePath}`);
          }
        } else if (block.kind === NEP_BLOCK_KIND.SEARCH_ALL) {
          // Phase 2 treats phase2_required as the OPPORTUNITY to enter the
          // confirm flow — the validator's "reject" was the Phase 1 stub.
          if (!v.ok && v.reason !== REJECT_REASONS.PHASE2_REQUIRED) {
            recordNepEvent('rejected', { reason: v.reason, path: v.path || block.path, request_id: requestId });
            recordAiReplaySample({
              feature: 'nep',
              phase: 'validate_rejected',
              requestId,
              payload: { reason: v.reason, path: v.path || block.path, block },
            });
            validationFeedback.push({
              reason: v.reason,
              path: v.path || block.path,
              search: block.search,
              replace: block.replace,
            });
            continue;
          }
          recordNepEvent('validated', { kind: block.kind, request_id: requestId });
          const live = liveReader(block.path);
          if (typeof live !== 'string') continue;
          const offsets = findAllOffsets(live, block.search);
          if (offsets.length === 0) continue;
          const sites = offsets.map((offset) => ({ offset, line: offsetToLine(live, offset) }));
          entry = { kind: NEP_BLOCK_KIND.SEARCH_ALL, requestId, block, sites, cursor: 0 };
          recordAiReplaySample({
            feature: 'nep',
            phase: 'validated',
            requestId,
            payload: { kind: block.kind, path: block.path, block, sites },
          });
          if (typeof console !== 'undefined' && console.info) {
            console.info(`[NEP] SEARCH ALL validated: path=${block.path} sites=${sites.length}`);
          }
        } else {
          continue;
        }
        if (!entry) continue;
        // Dedup: a stream can re-emit the same block (model retry, partial
        // emission then re-flush) and the queue would stack identical
        // jumps that the user has to Tab past for no reason. Match by
        // kind + path + search + replace — anything that produces the
        // same edit at the same site is a duplicate. We only check the
        // remaining queue (cursor onwards) so accepted/skipped entries
        // don't suppress a legitimate re-emission later.
        const isDuplicate = (() => {
          for (let i = queueIndexRef.current; i < queueRef.current.length; i++) {
            const existing = queueRef.current[i];
            if (!existing || existing.kind !== entry.kind) continue;
            const a = existing.block || {};
            const b = entry.block || {};
            if (a.path === b.path && a.search === b.search && a.replace === b.replace) {
              return true;
            }
          }
          return false;
        })();
        if (isDuplicate) {
          recordNepEvent('rejected', { reason: 'duplicate', path: entry.block?.path, request_id: requestId });
          continue;
        }
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

    if (!armedYet) {
      setNepState(STATE.IDLE);
      if (!isRefinement && validationFeedback.length && refinementPass < NEP_MAX_REFINEMENT_PASSES) {
        const feedback = validationFeedback.slice(0, 6);
        recordAiReplaySample({
          feature: 'nep',
          phase: 'refinement_scheduled',
          requestId,
          payload: {
            reason: 'validation_repair',
            feedback,
          },
        });
        setTimeout(() => {
          try {
            fireNepRef.current?.({ feedback, pass: refinementPass + 1 });
          } catch (_) { /* best-effort repair */ }
        }, 0);
      }
    }
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
    recordNepEvent('accepted', { kind: NEP_BLOCK_KIND.SEARCH, path, via: writeResult?.via, request_id: entry.requestId || null });
    recordAiReplaySample({
      feature: 'nep',
      phase: 'accepted',
      requestId: entry.requestId || null,
      payload: {
        kind: NEP_BLOCK_KIND.SEARCH,
        path,
        via: writeResult?.via,
        block: entry.block,
      },
    });
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
              recordNepEvent('accepted', {
                kind: NEP_BLOCK_KIND.SEARCH_ALL,
                path: entry.block.path,
                request_id: entry.requestId || null,
              });
              recordAiReplaySample({
                feature: 'nep',
                phase: 'accepted',
                requestId: entry.requestId || null,
                payload: {
                  kind: NEP_BLOCK_KIND.SEARCH_ALL,
                  path: entry.block.path,
                  site: entry.cursor ?? 0,
                  block: entry.block,
                },
              });
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
          recordNepEvent('skipped', {
            kind: NEP_BLOCK_KIND.SEARCH_ALL,
            path: entry.block.path,
            site: entry.cursor ?? 0,
            request_id: entry.requestId || null,
          });
          recordAiReplaySample({
            feature: 'nep',
            phase: 'skipped',
            requestId: entry.requestId || null,
            payload: {
              kind: NEP_BLOCK_KIND.SEARCH_ALL,
              path: entry.block.path,
              site: entry.cursor ?? 0,
              block: entry.block,
            },
          });
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
          // Single writeFileContent call → single pushEditOperations →
          // single undo entry. Previously this was N sequential applies
          // and Ctrl+Z had to be pressed N times to back out the batch.
          e.preventDefault();
          e.stopPropagation();
          (async () => {
            const path = entry.block.path;
            const search = entry.block.search;
            const replace = entry.block.replace;
            const live = getLiveFileContent ? getLiveFileContent(path) : null;
            if (typeof live !== 'string' || !search) {
              advanceQueue();
              return;
            }
            const offsets = findAllOffsets(live, search);
            const remaining = offsets.slice(Math.max(0, entry.cursor ?? 0));
            const count = remaining.length;
            if (count === 0) {
              advanceQueue();
              return;
            }
            let next = live;
            for (let i = remaining.length - 1; i >= 0; i--) {
              const offset = remaining[i];
              next = next.slice(0, offset) + replace + next.slice(offset + search.length);
            }
            try {
              await writeFileContent(path, next);
              await runOnApply(path, next);
              for (let i = 0; i < count; i++) {
                recordNepEvent('accepted', {
                  kind: NEP_BLOCK_KIND.SEARCH_ALL,
                  path,
                  batch: true,
                  request_id: entry.requestId || null,
                });
              }
              recordAiReplaySample({
                feature: 'nep',
                phase: 'accepted_batch',
                requestId: entry.requestId || null,
                payload: {
                  kind: NEP_BLOCK_KIND.SEARCH_ALL,
                  path,
                  count,
                  block: entry.block,
                },
              });
            } catch (err) {
              recordNepEvent('rejected', { reason: 'apply_failed', detail: err?.message });
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
          // Single-Tab apply when the cursor is already at the prediction
          // line in the active file. The "jump" half of the cascade is
          // wasted in that case — the user's eyes are already on the
          // armed line, asking them to Tab twice is just friction.
          if (path && path === activePath) {
            const cursor = editorInstance.getPosition?.();
            if (cursor && cursor.lineNumber === line) {
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
    dispatch, rawFiles, syncPredictedPaths, writeFileContent, runOnApply,
  ]);

  return {
    nepState,
    enabled,
    setEnabled,
    // True once the per-session fire cap has been hit. The UI surface is
    // a non-blocking notice — we're not pausing input, just signaling that
    // automatic predictions are off until the workspace reloads.
    fireCapReached,
    fireCap: NEP_PER_SESSION_FIRE_CAP,
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
