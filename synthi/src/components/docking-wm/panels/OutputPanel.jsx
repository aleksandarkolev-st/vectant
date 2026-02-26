'use client';

/**
 * @fileoverview Output Panel — displays program stdout/stderr in a terminal-like view.
 *
 * Subscribes to:
 *  - `synthi:program-output` — structured {type, line, sessionId} from runner stdout/stderr
 *  - `synthi:build-log`      — raw build log lines (compilation status, etc.)
 *
 * The panel distinguishes between:
 *  - Program output (stdout/stderr from the running program)
 *  - Build messages  ([Java] Compiling..., Build succeeded, errors, etc.)
 *
 * Renders in a monospace, terminal-like view with auto-scroll and clear controls.
 */

import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { Trash2, ArrowDownToLine, Lock, Unlock, ChevronDown } from 'lucide-react';

// ────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────

const MAX_LINES = 5000;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// ────────────────────────────────────────────────────────
//  ANSI color mapping (basic 8 colors + bright variants)
// ────────────────────────────────────────────────────────

const ANSI_COLORS = {
  '30': '#6e6e6e', '31': '#ef4444', '32': '#22c55e', '33': '#eab308',
  '34': '#3b82f6', '35': '#a855f7', '36': '#06b6d4', '37': '#d4d4d8',
  '90': '#737373', '91': '#f87171', '92': '#4ade80', '93': '#facc15',
  '94': '#60a5fa', '95': '#c084fc', '96': '#22d3ee', '97': '#fafafa',
};

function parseAnsiLine(text) {
  // Strip ANSI for now — keep it simple. Return plain text segments.
  // Future: could render colored spans.
  const stripped = text.replace(ANSI_REGEX, '');
  return stripped;
}

// ────────────────────────────────────────────────────────
//  Line entry types
// ────────────────────────────────────────────────────────

/**
 * @typedef {Object} OutputLine
 * @property {number}  id        - Unique monotonic id
 * @property {string}  text      - Display text
 * @property {'stdout'|'stderr'|'system'} kind - Line classification
 * @property {number}  ts        - Timestamp (ms)
 * @property {string}  [sessionId] - Session that produced this line
 */

let lineIdCounter = 0;

function makeLine(text, kind = 'stdout', sessionId = null) {
  return {
    id: ++lineIdCounter,
    text: parseAnsiLine(text),
    kind,
    ts: Date.now(),
    sessionId,
  };
}

// ────────────────────────────────────────────────────────
//  OutputPanel component
// ────────────────────────────────────────────────────────

const OutputPanel = memo(function OutputPanel() {
  const [lines, setLines] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const userScrolledUp = useRef(false);

  // ── Auto-scroll to bottom ──────────────────────────────
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [lines, autoScroll]);

  // ── Detect manual scroll ───────────────────────────────
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom && !autoScroll) {
      setAutoScroll(true);
      userScrolledUp.current = false;
    } else if (!atBottom && autoScroll) {
      setAutoScroll(false);
      userScrolledUp.current = true;
    }
  }, [autoScroll]);

  // ── Append helper ──────────────────────────────────────
  const appendLines = useCallback((newEntries) => {
    setLines((prev) => {
      const merged = [...prev, ...newEntries];
      return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
    });
  }, []);

  // ── Subscribe to program output events ─────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Clear output when a new build starts
    const handleNewBuild = () => {
      setLines([]);
      setAutoScroll(true);
    };

    // Primary: structured program output (stdout/stderr from runner)
    const handleProgramOutput = (e) => {
      const detail = e?.detail;
      if (!detail) return;
      const { type, line, sessionId } = detail;
      if (line == null) return;

      const kind = type === 'stderr' ? 'stderr' : 'stdout';
      appendLines([makeLine(String(line), kind, sessionId)]);
    };

    // Secondary: build log (compilation messages, status lines)
    const handleBuildLog = (e) => {
      const raw = e?.detail;
      if (raw == null) return;
      const text = typeof raw === 'string' ? raw : String(raw);

      // Try to parse JSON — if it's structured stdout/stderr, skip (handled by program-output)
      try {
        const parsed = JSON.parse(text);
        if (parsed && (parsed.type === 'stdout' || parsed.type === 'stderr')) return;
        // LSP stderr is internal diagnostic noise — never show in Output panel
        if (parsed && parsed.type === 'lsp-stderr') return;
        // Status-done messages are internal — skip
        if (parsed && (parsed.status === 'done' || parsed.status === 'error')) return;
        // HMR status messages are internal — skip
        if (parsed && parsed.type === 'hmr-status') return;
        // If it has .line, extract it (e.g. stderr from compilation)
        if (parsed && parsed.line != null) {
          appendLines([makeLine(String(parsed.line), parsed.type === 'stderr' ? 'stderr' : 'system')]);
          return;
        }
      } catch (_) {
        // Not JSON — plain text build message
      }

      // Plain text build message
      if (text.trim()) {
        appendLines([makeLine(text, 'system')]);
      }
    };

    window.addEventListener('synthi:show-output-panel', handleNewBuild);
    window.addEventListener('synthi:program-output', handleProgramOutput);
    window.addEventListener('synthi:build-log', handleBuildLog);

    return () => {
      window.removeEventListener('synthi:show-output-panel', handleNewBuild);
      window.removeEventListener('synthi:program-output', handleProgramOutput);
      window.removeEventListener('synthi:build-log', handleBuildLog);
    };
  }, [appendLines]);

  // ── Clear all output ───────────────────────────────────
  const handleClear = useCallback(() => {
    setLines([]);
  }, []);

  // ── Scroll to bottom ──────────────────────────────────
  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // ── Line color by kind ────────────────────────────────
  const kindColor = (kind) => {
    switch (kind) {
      case 'stderr': return 'var(--output-stderr, #ef4444)';
      case 'system': return 'var(--output-system, #6b7280)';
      default:       return 'var(--text-primary, #d4d4d8)';
    }
  };

  return (
    <div className="h-full w-full flex flex-col" style={{ background: 'var(--bg-terminal, var(--bg-sidebar))', color: 'var(--text-primary)' }}>
      {/* ── Toolbar ─────────────────────────────────── */}
      <div
        className="h-9 flex items-center justify-between px-2 border-b shrink-0 select-none"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sidebar)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            Output
          </span>
          {lines.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
              {lines.length} line{lines.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {/* Auto-scroll toggle */}
          <button
            className="w-7 h-7 flex items-center justify-center rounded th-btn-ghost transition-colors"
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? 'Auto-scroll ON (click to disable)' : 'Auto-scroll OFF (click to enable)'}
          >
            {autoScroll
              ? <Lock className="w-3.5 h-3.5" strokeWidth={2} style={{ color: 'var(--accent-primary)' }} />
              : <Unlock className="w-3.5 h-3.5" strokeWidth={2} />
            }
          </button>
          {/* Scroll to bottom */}
          {!autoScroll && (
            <button
              className="w-7 h-7 flex items-center justify-center rounded th-btn-ghost transition-colors"
              onClick={scrollToBottom}
              title="Scroll to bottom"
            >
              <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          )}
          {/* Clear */}
          <button
            className="w-7 h-7 flex items-center justify-center rounded th-btn-ghost transition-colors"
            onClick={handleClear}
            title="Clear Output"
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* ── Content area ────────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-1 font-mono text-xs leading-5"
        onScroll={handleScroll}
        style={{ background: 'var(--bg-terminal, var(--bg-sidebar))' }}
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center" style={{ color: 'var(--text-disabled)' }}>
            No output yet — run your program to see output here.
          </div>
        ) : (
          lines.map((entry) => (
            <div
              key={entry.id}
              className="whitespace-pre-wrap break-all"
              style={{ color: kindColor(entry.kind) }}
            >
              {entry.text}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
});

export default OutputPanel;
