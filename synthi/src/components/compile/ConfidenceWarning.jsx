'use client';

/**
 * @fileoverview ConfidenceWarning — ULTRAPLAN Phase 8.
 *
 * Lightweight pre-compile nudge shown when the agent-synthesized build
 * manifest reports MEDIUM confidence in runner_synthesis or link_flags.
 * Purpose: let the user know the compile might fail before they hit
 * "compile" and give them the option to pre-emptively switch to BYOR
 * mode or edit the manifest.
 *
 * Different from `CompileErrorCard` in three ways:
 *   - Warning, not error — yellow/amber tint, not red.
 *   - Dismissible by default (user can just ignore the nudge).
 *   - Shown BEFORE the compile, not after.
 *
 * Shape matches the Vectant diagnostic panel convention: compact
 * warning chrome, tokenized controls, and direct operator language.
 *
 * Parent components are responsible for deciding WHEN to show this
 * (typically: when `manifest.confidence.overall === "medium"` or when
 * `confidence.runner_synthesis === "medium"` on a Tier 1/2 split).
 */

import { AlertTriangle, X, ExternalLink } from 'lucide-react';

/**
 * @param {object} props
 * @param {object} props.confidence  — the manifest's `confidence` block,
 *     shape: `{overall, runner_synthesis, link_flags, notes}`.
 * @param {Function} [props.onDismiss] — optional dismiss handler. When
 *     omitted, the X button is hidden and the warning is persistent.
 * @param {Function} [props.onLearnMore] — optional link-out for the
 *     "Learn more about confidence levels" link.
 */
export function ConfidenceWarning({ confidence, onDismiss, onLearnMore }) {
  if (!confidence) return null;

  const runnerLevel = confidence.runner_synthesis;
  const linkLevel = confidence.link_flags;
  const overall = confidence.overall;
  const notes = confidence.notes || '';

  // Only render for medium — low is a hard rejection (CompileErrorCard),
  // high needs no warning. Caller should also honour this but we
  // belt-and-suspenders in case a "medium" leaks through from elsewhere.
  const isMediumWorthShowing =
    overall === 'medium' || runnerLevel === 'medium' || linkLevel === 'medium';
  if (!isMediumWorthShowing) return null;

  const concerns = [];
  if (runnerLevel === 'medium') {
    concerns.push({
      label: 'Runner synthesis',
      body: 'Runner synthesis can probably isolate your `main()` into a clean host_runner.cpp, but the project has framework boilerplate that might need manual adjustment.',
    });
  }
  if (linkLevel === 'medium') {
    concerns.push({
      label: 'Link flags',
      body: 'The manifest matched your library, but the exact link flags may differ by distribution. If compile fails with `undefined reference`, the heal loop will try to fix it automatically.',
    });
  }

  return (
    <section
      className="max-w-xl overflow-hidden rounded-[var(--radius-panel)] border"
      style={{
        background: 'color-mix(in srgb, var(--accent-warning) 8%, var(--bg-panel) 92%)',
        borderColor: 'color-mix(in srgb, var(--accent-warning) 42%, var(--border-subtle))',
      }}
      data-testid="confidence-warning"
    >
      <header
        className="border-b px-4 py-3"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'color-mix(in srgb, var(--bg-editor) 44%, transparent)',
        }}
      >
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 font-semibold" style={{ color: 'var(--accent-warning)' }}>
            <AlertTriangle className="h-4 w-4" />
            Compile route needs review
          </span>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="vt-icon-button th-focus-ring h-7 w-7"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          The split succeeded, but the runner manifest flagged uncertainty in the areas below before dispatch.
        </p>
      </header>
      <div className="flex flex-col gap-2 p-4">
        {concerns.map((c) => (
          <div
            key={c.label}
            className="border-l-2 pl-3 text-[11px] leading-relaxed"
            style={{ borderColor: 'var(--accent-warning)', color: 'var(--text-primary)' }}
          >
            <strong>{c.label}:</strong> {c.body}
          </div>
        ))}
        {notes && (
          <div className="mt-1 rounded-[var(--radius-control)] border px-2 py-1.5 text-[11px] leading-relaxed" style={{
            background: 'var(--bg-editor)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-muted)',
          }}>
            <strong>Runner note:</strong> {notes}
          </div>
        )}
        {onLearnMore && (
          <button
            type="button"
            onClick={onLearnMore}
            className="th-focus-ring mt-1 flex items-center gap-1 self-start rounded-[var(--radius-control)] border px-2 py-1 text-[11px] transition hover:opacity-80"
            style={{
              borderColor: 'var(--border-subtle)',
              color: 'var(--accent-primary)',
            }}
          >
            <ExternalLink className="h-3 w-3" />
            Learn about confidence levels
          </button>
        )}
      </div>
    </section>
  );
}

export default ConfidenceWarning;
