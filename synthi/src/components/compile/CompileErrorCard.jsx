'use client';

/**
 * @fileoverview CompileErrorCard — ULTRAPLAN Phase 8.
 *
 * Renders the 3-option error card shown when the agent-synthesized build
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
 * Shape matches the Vectant diagnostic panel convention: dense chrome,
 * tokenized severity, explicit recovery actions.
 *
 * This component is rendered-only — it does NOT orchestrate the actions
 * itself. Parent components (typically an ErrorOverlay or a panel)
 * wire the button onClick handlers to the relevant Redux actions.
 */

import { AlertOctagon, Wrench, UserCheck, Clock, ExternalLink } from 'lucide-react';

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
    <section
      className="max-w-2xl overflow-hidden rounded-[var(--radius-panel)] border"
      style={{
        background: 'color-mix(in srgb, var(--accent-danger) 7%, var(--bg-panel) 93%)',
        borderColor: 'color-mix(in srgb, var(--accent-danger) 38%, var(--border-subtle))',
      }}
      data-testid="compile-error-card"
    >
      <header
        className="border-b px-4 py-3"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'color-mix(in srgb, var(--bg-editor) 46%, transparent)',
        }}
      >
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--accent-danger)' }}>
          <AlertOctagon className="h-3.5 w-3.5" />
          Build gate
        </div>
        <h3 className="mt-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {description}
        </p>
      </header>
      <div className="flex flex-col gap-3 p-4">
        {detail && (
          <pre
            className="max-h-[200px] overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-control)] border px-3 py-2 font-mono text-xs"
            style={{
              background: 'var(--bg-editor)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-primary)',
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
              label="Enable operator runner"
              detail="Keep host_runner.cpp under operator control with // SYNTHI_USER_RUNNER so synthesis will not overwrite it."
            />
          )}
          {showFrameworkSwitch && (
            <ActionButton
              icon={Wrench}
              onClick={onSwitchFramework}
              label="Switch runtime profile"
              detail="Use a single-stage profile such as SDL2, GLFW, raylib, sokol, or SFML for this gate."
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
              label="Requires multi-stage executor"
              detail="Qt, CMake, MOC, and generated build graphs need a staged runner before this path can ship."
            />
          )}
        </div>

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="th-focus-ring self-end rounded-[var(--radius-control)] border px-2 py-1 text-xs transition hover:opacity-80"
            style={{
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-muted)',
            }}
          >
            Dismiss
          </button>
        )}
      </div>
    </section>
  );
}

function ActionButton({ icon: Icon, onClick, label, detail, primary, disabled }) {
  const base = 'th-focus-ring flex items-start gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-left transition-all';
  const primaryStyle = primary
    ? { borderColor: 'color-mix(in srgb, var(--accent-primary) 45%, var(--border-subtle))', background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' }
    : { borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-editor) 42%, transparent)' };
  const disabledClasses = disabled ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-90 cursor-pointer';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`${base} ${disabledClasses}`}
      style={{
        ...primaryStyle,
        color: 'var(--text-primary)',
      }}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: primary ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
      <span className="flex flex-col gap-0.5 flex-1 min-w-0">
        <span className="text-sm font-medium">{label}</span>
        {detail && (
          <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{detail}</span>
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
      return 'Your project uses a macro-driven or framework-specific entry point that runner synthesis cannot safely untangle into a plain host_runner.cpp. HMR cannot proceed without a correct runner.';
    case REJECTION_KINDS.MANIFEST_HEAL_EXHAUSTED:
      return 'The linker reported undefined symbols and the manifest healer could not infer the correct library flags from the source. This usually means the library is uncommon or the include is ambiguous.';
    default:
      return 'The compiler rejected the synthesized output. See detail below.';
  }
}

export default CompileErrorCard;
