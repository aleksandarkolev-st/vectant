// src/components/healing/HealingHistoryPanel.jsx
// Time-travel view of recently applied healing fixes.
//
// Each row summarises one fix; clicking expands an inline diff of the
// before/after text pulled straight from the undo stack.  "Revert to here"
// walks Monaco's native undo down to that point, so the text state stays
// consistent even when fixes overlap.
//
// Revert is dispatched via a window CustomEvent so this panel stays
// decoupled from the Monaco editor (which only page.jsx owns).

'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';
import {
  selectAppliedFixes,
  selectUndoStack,
} from '@/redux/healingSelectors';
import { History, RotateCcw, ChevronRight } from 'lucide-react';
import { codeToTokens } from 'shiki';
import { useTheme } from '@/components/ThemeProvider';

const HEAL_REVERT_EVENT = 'synthi:heal-revert-to-fix';

// ── Shiki tokenization helpers ──────────────────────────────────────────
// Mirrors the file-versions diff so applied-fix previews look identical to
// the snapshot diff users already know.  Falls back to plain text on any
// tokenization error — never gates rendering on highlighting.
const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  c: 'c', h: 'c', hpp: 'cpp', hh: 'cpp', cs: 'csharp',
  java: 'java', kt: 'kotlin', swift: 'swift', php: 'php',
  html: 'html', htm: 'html', css: 'css', scss: 'scss',
  sass: 'sass', less: 'less', json: 'json', yaml: 'yaml',
  yml: 'yaml', toml: 'toml', xml: 'xml', md: 'markdown',
  sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  dockerfile: 'dockerfile', prisma: 'prisma', graphql: 'graphql',
  gql: 'graphql', vue: 'vue', svelte: 'svelte',
};

function langFromPath(filePath) {
  if (!filePath) return 'text';
  const base = String(filePath).split('/').pop() || '';
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const ext = (base.split('.').pop() || '').toLowerCase();
  return EXT_TO_LANG[ext] || 'text';
}

const DIFF_KIND_STYLES = {
  removed: {
    bg: 'color-mix(in srgb, var(--accent-danger) 15%, transparent)',
    marker: '-',
    markerColor: 'var(--accent-danger)',
  },
  added: {
    bg: 'color-mix(in srgb, var(--accent-success) 15%, transparent)',
    marker: '+',
    markerColor: 'var(--accent-success)',
  },
};

function TokenLine({ tokens, raw }) {
  if (Array.isArray(tokens) && tokens.length > 0) {
    return (
      <>
        {tokens.map((tok, i) => (
          <span
            key={i}
            style={{
              color: tok.color || 'inherit',
              fontStyle: tok.fontStyle === 2 ? 'italic' : undefined,
              fontWeight: tok.fontStyle === 1 ? 'bold' : undefined,
            }}
          >
            {tok.content}
          </span>
        ))}
      </>
    );
  }
  return <span>{raw || '​'}</span>;
}

function DiffLine({ kind, tokens, raw }) {
  const style = DIFF_KIND_STYLES[kind];
  return (
    <div className="flex px-2 py-px" style={{ background: style.bg }}>
      <span
        aria-hidden
        className="select-none w-3 shrink-0 text-center"
        style={{ color: style.markerColor, opacity: 0.85 }}
      >
        {style.marker}
      </span>
      <span
        className="whitespace-pre-wrap break-all flex-1"
        style={{ color: 'var(--text-primary)' }}
      >
        <TokenLine tokens={tokens} raw={raw} />
      </span>
    </div>
  );
}

function fmtTime(ts) {
  if (!ts) return '';
  const delta = Date.now() - ts;
  if (delta < 60_000)       return 'just now';
  if (delta < 3_600_000)    return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000)   return `${Math.round(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split('/');
  return parts[parts.length - 1];
}

function humanCategory(cat) {
  return (cat || 'issue').replace(/_/g, ' ');
}

// ── Inline diff for a single fix ────────────────────────────────────────
// Tokenizes both halves with shiki, matching the snapshot diff in
// FileVersionsPanel so users get the same visual treatment everywhere.
// Tokenization is async; we keep raw lines as the immediate fallback so
// the diff always renders even before highlighting lands.
function FixDiff({ originalText, replacementText, filePath }) {
  const [oldTokens, setOldTokens] = useState(null);
  const [newTokens, setNewTokens] = useState(null);
  const { shikiTheme } = useTheme();
  const activeTheme = shikiTheme || 'github-dark-default';

  const oldLines = (originalText ?? '').split('\n');
  const newLines = (replacementText ?? '').split('\n');

  useEffect(() => {
    let cancelled = false;
    const lang = langFromPath(filePath);
    const tokenize = async (text) => {
      if (typeof text !== 'string' || text.length === 0) return null;
      try {
        const res = await codeToTokens(text, { lang, theme: activeTheme });
        return res?.tokens || null;
      } catch (_) {
        try {
          const res = await codeToTokens(text, { lang: 'text', theme: activeTheme });
          return res?.tokens || null;
        } catch (__) {
          return null;
        }
      }
    };
    (async () => {
      const [o, n] = await Promise.all([
        tokenize(originalText),
        tokenize(replacementText),
      ]);
      if (cancelled) return;
      setOldTokens(o);
      setNewTokens(n);
    })();
    return () => { cancelled = true; };
  }, [originalText, replacementText, filePath, activeTheme]);

  return (
    <div
      className="mt-1.5 rounded-md font-mono text-[11px] leading-[1.45] overflow-x-auto"
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {oldLines.map((line, i) => (
        <DiffLine
          key={`o-${i}`}
          kind="removed"
          tokens={oldTokens?.[i]}
          raw={line}
        />
      ))}
      {newLines.map((line, i) => (
        <DiffLine
          key={`n-${i}`}
          kind="added"
          tokens={newTokens?.[i]}
          raw={line}
        />
      ))}
    </div>
  );
}

// ── Single row ──────────────────────────────────────────────────────────
function HistoryRow({ fix, undoEntry, isUndoable, onRevert }) {
  const [expanded, setExpanded] = useState(false);

  const handleRevert = useCallback((e) => {
    e.stopPropagation();
    onRevert?.(fix.id);
  }, [fix.id, onRevert]);

  return (
    <div
      className="rounded-md heal-card"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 px-2 py-1.5 text-left"
      >
        <ChevronRight
          className={`w-3 h-3 mt-0.5 flex-shrink-0 heal-chevron ${expanded ? 'is-open' : ''}`}
          style={{ color: 'var(--text-muted)' }}
        />
        <div className="flex-1 min-w-0">
          <div
            className="text-xs truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {humanCategory(fix.category)}
            {fix.description && fix.description !== fix.category && (
              <span style={{ color: 'var(--text-muted)' }}>
                {' - '}{fix.description}
              </span>
            )}
          </div>
          <div
            className="flex items-center gap-2 mt-0.5 text-[10px]"
            style={{ color: 'var(--text-dim)' }}
          >
            <span>{fmtTime(fix.appliedAt)}</span>
            {fix.filePath && (
              <>
                <span>·</span>
                <span className="truncate" title={fix.filePath}>
                  {shortPath(fix.filePath)}
                </span>
              </>
            )}
            {fix.source && (
              <>
                <span>·</span>
                <span>{fix.source.replace(/_/g, ' ')}</span>
              </>
            )}
          </div>
        </div>
        {isUndoable && (
          <span
            onClick={handleRevert}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleRevert(e);
            }}
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 flex-shrink-0 cursor-pointer"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
            }}
            title="Revert to the state just before this fix was applied"
          >
            <RotateCcw className="w-2.5 h-2.5" />
            Revert to here
          </span>
        )}
      </button>

      {expanded && undoEntry && (
        <div className="px-2 pb-2 heal-row-enter">
          <FixDiff
            originalText={undoEntry.originalText}
            replacementText={fix.replacementText}
            filePath={fix.filePath}
          />
        </div>
      )}
      {expanded && !undoEntry && (
        <div
          className="px-2 pb-2 text-[10px] italic heal-row-enter"
          style={{ color: 'var(--text-dim)' }}
        >
          No diff available (undo entry purged).
        </div>
      )}
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────
export function HealingHistoryPanel() {
  const applied = useSelector(selectAppliedFixes);
  const undoStack = useSelector(selectUndoStack);
  const [open, setOpen] = useState(false);

  // Build a fast map: applied fix id → undo entry, so the diff view can
  // render without an O(n) find on every render.
  const undoById = {};
  for (const u of undoStack) {
    if (u?.fixId) undoById[u.fixId] = u;
  }
  const undoableIds = new Set(undoStack.map((u) => u.fixId).filter(Boolean));

  const handleRevert = useCallback((fixId) => {
    if (typeof window === 'undefined' || !fixId) return;
    window.dispatchEvent(new CustomEvent(HEAL_REVERT_EVENT, { detail: { fixId } }));
  }, []);

  if (!applied || applied.length === 0) return null;

  const recent = applied.slice(0, 20);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        <History className="w-3 h-3" />
        <ChevronRight
          className={`w-3 h-3 heal-chevron ${open ? 'is-open' : ''}`}
          aria-hidden
        />
        <span>Recent fixes ({applied.length})</span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-1.5 heal-stagger">
          {recent.map((fix) => (
            <HistoryRow
              key={fix.id || `${fix.appliedAt}-${fix.category}`}
              fix={fix}
              undoEntry={undoById[fix.id]}
              isUndoable={undoableIds.has(fix.id)}
              onRevert={handleRevert}
            />
          ))}
          {applied.length > recent.length && (
            <div
              className="text-[10px] text-center py-1"
              style={{ color: 'var(--text-dim)' }}
            >
              + {applied.length - recent.length} older fixes
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const HEAL_REVERT_EVENT_NAME = HEAL_REVERT_EVENT;
export default HealingHistoryPanel;
