'use client';

/**
 * ReasoningCard — the agent's live thinking + context surface (the old raw
 * "Working… Classifying intent…" box). Three states off one `progress`
 * message:
 *   working  → live vertical timeline, header shows context chips, last step
 *              is the active/pulsing one.
 *   finished → collapses to a one-line summary ("Reasoned over N files · M
 *              steps"), expandable back to the timeline.
 *   failed   → the single error surface: red, message + "Try again" / "Copy
 *              error", with the steps available under expand.
 *
 * Context ("Context files: 1", "Context window: 0.0% used") and the error
 * line are parsed out of the logs and surfaced as chips / the error body, so
 * they don't clutter the step list.
 */
import { useState, useCallback } from 'react';
import { RotateCw, Copy, Check, ChevronRight, ChevronDown } from 'lucide-react';

const CTX_FILES = /context files?:\s*(\d+)/i;
const CTX_WINDOW = /context window:\s*([\d.]+)\s*%/i;
const ERR_LINE = /^(generation failed|request failed)/i;
const HIDE_STEP = /^(context files?:|context window:|generation failed)/i;

function parseLogs(logs) {
  let files = null;
  let ctx = null;
  let error = null;
  for (const line of logs || []) {
    let m;
    if ((m = line.match(CTX_FILES))) files = Number(m[1]);
    if ((m = line.match(CTX_WINDOW))) ctx = parseFloat(m[1]);
    if (ERR_LINE.test(line)) error = line;
  }
  const steps = (logs || []).filter((l) => l && !HIDE_STEP.test(l));
  return { files, ctx, error, steps };
}

function Chevron({ open }) {
  const C = open ? ChevronDown : ChevronRight;
  return <C className="w-3.5 h-3.5" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />;
}

function Timeline({ steps, live, className = '' }) {
  return (
    <div className={`vx-tl ${className}`}>
      {steps.map((s, i) => {
        const active = live && i === steps.length - 1;
        return (
          <div key={`${i}-${s}`} className={`vx-step ${active ? 'active' : 'done'}`}>
            <span className="vx-step-dot" />
            {s}
          </div>
        );
      })}
    </div>
  );
}

export default function ReasoningCard({ logs = [], status = 'working', expanded = false, onToggle, onRetry }) {
  const isFailed = status === 'failed';
  const isFinished = status === 'finished';
  const { files, ctx, error, steps } = parseLogs(logs);
  const [copied, setCopied] = useState(false);

  const copyError = useCallback(() => {
    const text = error || (logs || []).join('\n');
    try { navigator.clipboard?.writeText(text); } catch (_) { /* best effort */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, [error, logs]);

  // ── Error ──
  if (isFailed) {
    const code = error ? (error.match(/status\s*(\d{3})/i) || [])[1] : null;
    const msg = (error || 'The request failed.').replace(/^generation failed:\s*/i, '');
    return (
      <div className="vx-rcard vx-rcard--err">
        <button type="button" className="vx-rcard-hd" onClick={onToggle} aria-expanded={expanded}>
          <span className="vx-rcard-mark" />
          <span className="vx-rcard-title">Generation failed</span>
          <span className="vx-rcard-chips">
            {code && <span className="vx-chip vx-chip--err">{code}</span>}
            <Chevron open={expanded} />
          </span>
        </button>
        <div className="vx-rcard-errbody">
          <div className="vx-rcard-errmsg">{msg}</div>
          <div className="vx-rcard-acts">
            <button type="button" className="vx-btn vx-btn--primary" onClick={onRetry}>
              <RotateCw className="w-3 h-3" strokeWidth={2} /> Try again
            </button>
            <button type="button" className="vx-btn vx-btn--ghost" onClick={copyError}>
              {copied ? <Check className="w-3 h-3" strokeWidth={2} /> : <Copy className="w-3 h-3" strokeWidth={2} />}
              {copied ? 'Copied' : 'Copy error'}
            </button>
          </div>
          {expanded && steps.length > 0 && <Timeline steps={steps} live={false} className="vx-tl--details" />}
        </div>
      </div>
    );
  }

  // ── Finished: collapsed summary, expand → timeline ──
  if (isFinished) {
    return (
      <div className="vx-rcard">
        <button type="button" className="vx-rcard-sum" onClick={onToggle} aria-expanded={expanded}>
          <span className="vx-rcard-mark vx-rcard-mark--ok"><Check className="w-2.5 h-2.5 text-white" strokeWidth={3} /></span>
          <span className="vx-rcard-sumtxt">
            Reasoned{files != null ? <> over <b>{files} file{files === 1 ? '' : 's'}</b></> : ''}
            {' · '}{steps.length} step{steps.length === 1 ? '' : 's'}
          </span>
          <span className="ml-auto"><Chevron open={expanded} /></span>
        </button>
        {expanded && <Timeline steps={steps} live={false} />}
      </div>
    );
  }

  // ── Working: live timeline ──
  return (
    <div className="vx-rcard">
      <div className="vx-rcard-hd vx-rcard-hd--static">
        <span className="vx-rcard-mark vx-rcard-mark--live" />
        <span className="vx-rcard-title">Reasoning</span>
        <span className="vx-rcard-chips">
          {files != null && <span className="vx-chip">{files} file{files === 1 ? '' : 's'}</span>}
          {ctx != null && (
            <span className="vx-chip">
              ctx <span className="vx-meter"><i style={{ width: `${Math.max(4, Math.min(100, ctx))}%` }} /></span>
            </span>
          )}
        </span>
      </div>
      <Timeline steps={steps} live />
    </div>
  );
}
