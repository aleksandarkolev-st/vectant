'use client';

/**
 * @fileoverview CompileErrorCard — ULTRAPLAN Phase 8.
 *
 * Renders the 3-option error card shown when the AI-synthesised build
 * manifest is rejected (multi-step build, low runner-synthesis confidence,
 * manifest heal exhausted, etc.). Surfaces the three Phase 5.3 options:
 *
 *   1. Switch to a simpler framework
 *   2. Enable "Bring Your Own Runner" mode
 *   3. Retry (for transient failures) OR wait for V2
 *
 * The card takes a `rejection` prop with `{reason, detail, actionableOptions}`
 * and renders a tailored action list based on `actionableOptions`. When
 * the rejection is a `runner_synthesis_low` type, the primary CTA is the
 * BYOR switch; when it's `multi_step_build`, there's no BYOR path (the
 * user needs a different build system entirely).
 *
 * Shape matches the existing Synthi dark-mode card convention: Radix
 * Card primitive + lucide-react icons + CSS variables for theming.
 *
 * This component is rendered-only — it does NOT orchestrate the actions
 * itself. Parent components (typically an ErrorOverlay or a panel)
 * wire the button onClick handlers to the relevant Redux actions.
 */

import { AlertOctagon, Wrench, UserCheck, Clock, ExternalLink } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

/**
 * Known rejection kinds that the Python ManifestRejection emits. These
 * come from `ai-backend/ai-engine/build_manifest.py::ManifestRejection`
 * and the new `/refactor/heal/manifest` endpoint, and should be kept
 * in sync with `HMR_AGNOSTIC_ULTRAPLAN.md` §5.3.
 */
export const REJECTION_KINDS = {
  MULTI_STEP: 'multi_step_build',
  RUNNER_SYNTHESIS_LOW: 'runner_synthesis_low',
  MANIFEST_HEAL_EXHAUSTED: 'manifest_heal_exhausted',
  UNKNOWN: 'unknown',
};

/**
 * @param {object} props
 * @param {object} props.rejection       — { kind, message, detail }
 * @param {Function} [props.onEnableByor] — called when the user clicks
 *     "Enable Bring Your Own Runner". Parent should dispatch
 *     `toggleBringYourOwnRunner()` and show a follow-up instruction.
 * @param {Function} [props.onSwitchFramework] — called when the user
 *     clicks "Switch framework". Parent opens the docs or a framework
 *     picker.
 * @param {Function} [props.onRetry]     — called when the user retries.
 *     Parent re-runs the compile.
 * @param {Function} [props.onDismiss]   — optional dismiss/close handler.
 */
export function CompileErrorCard({
  rejection,
  onEnableByor,
  onSwitchFramework,
  onRetry,
  onDismiss,
}) {
  if (!rejection) return null;

  const kind = rejection.kind || REJECTION_KINDS.UNKNOWN;
  const title = _titleForKind(kind);
  const description = _descriptionForKind(kind);
  const detail = rejection.message || rejection.detail || '';

  // Different rejection kinds get different action buttons. The logic
  // lives here rather than duplicated in every call site.
  const showByor = kind === REJECTION_KINDS.RUNNER_SYNTHESIS_LOW
    || kind === REJECTION_KINDS.MULTI_STEP
    || kind === REJECTION_KINDS.MANIFEST_HEAL_EXHAUSTED;
  const showFrameworkSwitch = kind === REJECTION_KINDS.MULTI_STEP
    || kind === REJECTION_KINDS.RUNNER_SYNTHESIS_LOW
    || kind === REJECTION_KINDS.MANIFEST_HEAL_EXHAUSTED;
  const showRetry = kind === REJECTION_KINDS.MANIFEST_HEAL_EXHAUSTED
    || kind === REJECTION_KINDS.UNKNOWN;
  const showWaitForV2 = kind === REJECTION_KINDS.MULTI_STEP;

  return (
    <Card
      className="border-red-500/30 max-w-2xl"
      style={{
        background: 'color-mix(in srgb, #ef4444 6%, var(--bg-panel, #1a1a22))',
      }}
      data-testid="compile-error-card"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-400">
          <AlertOctagon className="w-4 h-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {detail && (
          <pre
            className="text-xs font-mono whitespace-pre-wrap px-3 py-2 rounded border"
            style={{
              background: 'var(--bg-input, var(--bg-editor, #11111a))',
              borderColor: 'var(--border-subtle, #2a2a36)',
              color: 'var(--text-primary, #d4d4d8)',
              maxHeight: 200,
              overflowY: 'auto',
            }}
          >
            {detail}
          </pre>
        )}

        <div className="flex flex-col gap-2 mt-1">
          {showByor && (
            <ActionButton
              icon={UserCheck}
              primary
              onClick={onEnableByor}
              label="Enable Bring Your Own Runner"
              detail="Write your own host_runner.cpp with `// SYNTHI_USER_RUNNER` at the top. The AI won't regenerate it on splits."
            />
          )}
          {showFrameworkSwitch && (
            <ActionButton
              icon={Wrench}
              onClick={onSwitchFramework}
              label="Switch to a simpler framework"
              detail="SDL2, GLFW, raylib, sokol, SFML — all well-supported in V1."
            />
          )}
          {showRetry && (
            <ActionButton
              icon={Wrench}
              onClick={onRetry}
              label="Retry compile"
              detail="Transient errors can sometimes clear on a second attempt."
            />
          )}
          {showWaitForV2 && (
            <ActionButton
              icon={Clock}
              disabled
              label="Wait for V2 multi-step build support"
              detail="Qt/CMake/MOC pipelines need a multi-stage build executor. Not in V1."
            />
          )}
        </div>

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="self-end text-xs mt-2 px-2 py-1 rounded hover:opacity-80 transition"
            style={{ color: 'var(--text-muted)' }}
          >
            Dismiss
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function ActionButton({ icon: Icon, onClick, label, detail, primary, disabled }) {
  const base = 'flex items-start gap-2 px-3 py-2 text-left rounded border transition-all';
  const primaryStyle = primary
    ? { borderColor: 'var(--accent-primary, #60a5fa)', background: 'color-mix(in srgb, var(--accent-primary, #60a5fa) 10%, transparent)' }
    : { borderColor: 'var(--border-subtle, #2a2a36)', background: 'transparent' };
  const disabledClasses = disabled ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-90 cursor-pointer';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`${base} ${disabledClasses}`}
      style={{
        ...primaryStyle,
        color: 'var(--text-primary, #d4d4d8)',
      }}
    >
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: primary ? 'var(--accent-primary, #60a5fa)' : 'var(--text-muted, #8a8a98)' }} />
      <span className="flex flex-col gap-0.5 flex-1 min-w-0">
        <span className="text-sm font-medium">{label}</span>
        {detail && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted, #8a8a98)' }}>{detail}</span>
        )}
      </span>
    </button>
  );
}

// ─── Kind → copy lookup ─────────────────────────────────────────────

function _titleForKind(kind) {
  switch (kind) {
    case REJECTION_KINDS.MULTI_STEP:
      return 'Multi-step build not supported';
    case REJECTION_KINDS.RUNNER_SYNTHESIS_LOW:
      return 'Runner synthesis failed';
    case REJECTION_KINDS.MANIFEST_HEAL_EXHAUSTED:
      return 'Could not resolve link error';
    default:
      return 'Compile failed';
  }
}

function _descriptionForKind(kind) {
  switch (kind) {
    case REJECTION_KINDS.MULTI_STEP:
      return 'V1 only supports projects that compile with a single g++ invocation. Qt MOC, CMake, meson, and other multi-step builds are not yet executable.';
    case REJECTION_KINDS.RUNNER_SYNTHESIS_LOW:
      return 'Your project uses a macro-driven or framework-specific entry point that the AI cannot safely untangle into a plain host_runner.cpp. HMR cannot proceed without a correct runner.';
    case REJECTION_KINDS.MANIFEST_HEAL_EXHAUSTED:
      return 'The linker reported undefined symbols and the AI could not infer the correct library flags from the source. This usually means the library is uncommon or the include is ambiguous.';
    default:
      return 'The compiler rejected the AI-synthesised output. See detail below.';
  }
}

export default CompileErrorCard;
