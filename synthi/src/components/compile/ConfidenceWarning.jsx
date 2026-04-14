'use client';

/**
 * @fileoverview ConfidenceWarning — ULTRAPLAN Phase 8.
 *
 * Lightweight pre-compile nudge shown when the AI-synthesised build
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
 * Shape matches the existing Synthi alert convention: Radix Card
 * primitive + lucide-react icons + CSS variables for theming.
 *
 * Parent components are responsible for deciding WHEN to show this
 * (typically: when `manifest.confidence.overall === "medium"` or when
 * `confidence.runner_synthesis === "medium"` on a Tier 1/2 split).
 */

import { AlertTriangle, X, ExternalLink } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

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
      body: 'The AI can probably isolate your `main()` into a clean host_runner.cpp, but the project has framework boilerplate that might need manual adjustment.',
    });
  }
  if (linkLevel === 'medium') {
    concerns.push({
      label: 'Link flags',
      body: 'The AI identified your library but the exact link flags may differ by distribution. If the compile fails with `undefined reference`, the manifest heal loop will try to fix it automatically.',
    });
  }

  return (
    <Card
      className="border-yellow-500/40 max-w-xl"
      style={{
        background: 'color-mix(in srgb, #eab308 6%, var(--bg-panel, #1a1a22))',
      }}
      data-testid="confidence-warning"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-yellow-400 text-sm">
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Medium confidence — compile may need adjustment
          </span>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="opacity-60 hover:opacity-100 transition"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          The AI split your project successfully but flagged uncertainty in the areas below. Compile will proceed — this is just a heads-up.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pb-4">
        {concerns.map((c) => (
          <div
            key={c.label}
            className="text-[11px] leading-relaxed pl-3 border-l-2"
            style={{ borderColor: '#eab308', color: 'var(--text-primary)' }}
          >
            <strong>{c.label}:</strong> {c.body}
          </div>
        ))}
        {notes && (
          <div className="text-[11px] leading-relaxed mt-1 px-2 py-1.5 rounded" style={{
            background: 'var(--bg-input, var(--bg-editor, #11111a))',
            color: 'var(--text-muted)',
          }}>
            <strong>AI note:</strong> {notes}
          </div>
        )}
        {onLearnMore && (
          <button
            type="button"
            onClick={onLearnMore}
            className="flex items-center gap-1 text-[11px] mt-1 self-start hover:opacity-80 transition"
            style={{ color: 'var(--accent-primary, #60a5fa)' }}
          >
            <ExternalLink className="w-3 h-3" />
            Learn about confidence levels
          </button>
        )}
      </CardContent>
    </Card>
  );
}

export default ConfidenceWarning;
