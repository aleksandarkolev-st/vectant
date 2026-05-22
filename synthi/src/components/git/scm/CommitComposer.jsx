'use client';

/**
 * CommitComposer — the sticky-bottom chat-style composer.
 *
 * Anatomy:
 *
 *   [scm-composer]                              ← sticky bottom, ambient top hairline
 *     [scm-error-strip?]                        ← user-facing actionError, dismissable
 *     [scm-composer-shell]                      ← gradient ring on focus, sweep on AI stream
 *       [textarea]                              ← auto-grow 28px → 160px
 *       [extended description textarea?]       ← reveals on "+ details"
 *       [scm-composer-toolbar]
 *         [CommitTypeChips]                    ← only when focused or has message
 *         [amend toggle?]                       ← only when unpushed > 0
 *         [details toggle]
 *         [spacer]
 *         [✦ AI sparkle]                       ← placeholder for now (per spec)
 *         [submit pill]                         ← gradient when ready, ghost when not
 *
 * The composer is presentational + locally-stateful only for its
 * textarea sizing, placeholder rotation, and the flash modifier
 * after a successful submit.  All other state is owned by the
 * parent and passed in as props.
 *
 * Keyboard:
 *   Ctrl/Cmd+Enter         → submit (commit)
 *   Ctrl/Cmd+Shift+Enter   → submit + push
 *   Cmd+B/I/U etc. are NOT intercepted — the textarea is plain.
 *
 * The global Ctrl+Enter / Ctrl+Shift+P / Ctrl+Shift+Enter shortcuts
 * are handled at the panel root (data-git-panel attribute);
 * we duplicate them here on the textarea itself so they fire even
 * if focus is briefly inside a sub-control.
 */

import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  Sparkles, ArrowUp, ChevronDown, ChevronUp, Edit3, X, Loader2,
} from 'lucide-react';
import { CommitTypeChips } from './CommitTypeChips';

// Placeholder rotation — picked per render via a stable hash so the
// hint changes when the staged-count changes but doesn't churn every
// keystroke.  Keeps the composer from feeling chatty when the user
// is concentrating.
const PLACEHOLDERS_HAS_CHANGES = [
  'Summarize your changes…',
  'Describe what you fixed…',
  'feat: …',
  'Why does this matter?',
];
const PLACEHOLDER_CLEAN = 'Branch up to date — nothing to commit.';

function pickPlaceholder(fileCount) {
  if (fileCount === 0) return PLACEHOLDER_CLEAN;
  return PLACEHOLDERS_HAS_CHANGES[fileCount % PLACEHOLDERS_HAS_CHANGES.length];
}

// Format the submit-button label based on commit + push state.
function pickSubmitLabel({ amendMode, ahead, isSubmitting }) {
  if (isSubmitting) return amendMode ? 'Amending…' : 'Committing…';
  if (amendMode) return 'Amend';
  if (ahead > 0) return 'Commit & Push';
  return 'Commit';
}

function CommitComposerImpl({
  // Controlled message + body state
  message = '',
  onMessageChange,
  commitBody = '',
  onCommitBodyChange,
  showCommitBody = false,
  onToggleCommitBody,

  // Amend
  amendMode = false,
  onToggleAmend,
  canAmend = false,

  // Submit state
  canCommit = false,        // true when message + (staged OR amend)
  ahead = 0,
  isSubmitting = false,
  onSubmit,                 // ()  => commit only
  onSubmitAndPush,          // ()  => commit + push

  // AI
  onAIGenerate,             // ()  => kick off commit-message generation
  isAIStreaming = false,
  aiAvailable = true,       // if false, hide the sparkle button entirely

  // Context (drives placeholder + amend visibility)
  fileCount = 0,

  // Error strip (above the composer)
  error = null,
  errorCode = null,
  onDismissError,
}) {
  // Local state — purely visual.
  const [flashing, setFlashing] = useState(false);
  const textareaRef = useRef(null);
  const submitButtonRef = useRef(null);
  // Was the previous render submitting?  Used to trigger the flash
  // on the trailing edge of a successful submit.
  const prevSubmittingRef = useRef(isSubmitting);

  // Auto-grow the textarea on input.  Capped by CSS at 160px max-height.
  const autoGrow = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    // 6px safety margin so we don't get a stale scrollbar on the
    // exact-fit edge.
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 160)}px`;
  }, []);

  useLayoutEffect(() => { autoGrow(); }, [autoGrow, message]);

  // Detect submit → settled transition and play the flash once.
  useEffect(() => {
    const wasSubmitting = prevSubmittingRef.current;
    prevSubmittingRef.current = isSubmitting;
    if (wasSubmitting && !isSubmitting && !error) {
      setFlashing(true);
      const t = window.setTimeout(() => setFlashing(false), 760);
      return () => window.clearTimeout(t);
    }
  }, [isSubmitting, error]);

  const placeholder = useMemo(() => pickPlaceholder(fileCount), [fileCount]);
  const submitLabel = useMemo(
    () => pickSubmitLabel({ amendMode, ahead, isSubmitting }),
    [amendMode, ahead, isSubmitting],
  );

  // The visible message-vs-canCommit gating logic deliberately mirrors
  // the legacy GitStatus.jsx semantics so the redesign behaves the
  // same: a non-empty message with at least one staged file (or amend
  // mode) is the green light.
  const isReady = canCommit && !isSubmitting;

  const handleTextareaKeyDown = useCallback((e) => {
    // Ctrl/Cmd+Shift+Enter → commit & push
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      if (isReady) onSubmitAndPush?.();
      return;
    }
    // Ctrl/Cmd+Enter → commit
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (isReady) onSubmit?.();
      return;
    }
  }, [isReady, onSubmit, onSubmitAndPush]);

  const handleSubmitClick = useCallback(() => {
    if (!isReady) return;
    if (ahead > 0 && !amendMode) {
      onSubmitAndPush?.();
    } else {
      onSubmit?.();
    }
  }, [isReady, ahead, amendMode, onSubmit, onSubmitAndPush]);

  // Compact "Commit only" affordance when the primary action is
  // "Commit & Push" — surfaces as a tiny chevron split.
  const showSplit = ahead > 0 && !amendMode && isReady;
  const handleCommitOnly = useCallback((e) => {
    e.stopPropagation();
    onSubmit?.();
  }, [onSubmit]);

  const shellClass = [
    'scm-composer-shell',
    isAIStreaming ? 'is-streaming' : '',
  ].filter(Boolean).join(' ');

  const submitClass = [
    'scm-composer-submit',
    isReady ? 'is-ready' : '',
    flashing ? 'is-flashing' : '',
  ].filter(Boolean).join(' ');

  // Error code may be UNCOMMITTED_CHANGES (handled elsewhere) — that
  // case is suppressed by the parent before reaching here, but guard
  // anyway so an accidental wiring doesn't leak the strip.
  const showError = !!error && errorCode !== 'UNCOMMITTED_CHANGES';

  return (
    <div className="scm-composer">
      {showError && (
        <div className="scm-error-strip" role="alert">
          <span className="flex-1 min-w-0 truncate" title={error}>{error}</span>
          <button
            type="button"
            className="scm-error-strip-dismiss"
            onClick={onDismissError}
            aria-label="Dismiss error"
            title="Dismiss"
          >
            <X className="w-3 h-3" strokeWidth={2} />
          </button>
        </div>
      )}

      <div className={shellClass}>
        <textarea
          ref={textareaRef}
          className="scm-composer-textarea"
          value={message}
          onChange={(e) => { onMessageChange?.(e.target.value); }}
          onInput={autoGrow}
          onKeyDown={handleTextareaKeyDown}
          placeholder={placeholder}
          rows={1}
          spellCheck
          disabled={isSubmitting}
          aria-label="Commit message"
        />

        {showCommitBody && (
          <textarea
            className="scm-composer-textarea"
            value={commitBody}
            onChange={(e) => { onCommitBodyChange?.(e.target.value); }}
            placeholder="Extended description (optional)…"
            rows={2}
            spellCheck
            disabled={isSubmitting}
            aria-label="Extended commit description"
            style={{
              borderTop: '1px solid var(--border-subtle)',
              minHeight: 48,
              maxHeight: 120,
            }}
          />
        )}

        <div className="scm-composer-toolbar">
          {/* Type chips — visible when the user is engaged (focused
              OR has typed something OR has a current type prefix). */}
          <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            <CommitTypeChips message={message} onChange={onMessageChange} />
          </div>

          {/* Amend toggle — appears only when amend is possible (the
              last commit is unpushed AND no merge is in progress).
              The canAmend prop encodes that precondition. */}
          {canAmend && (
            <button
              type="button"
              className="scm-type-chip"
              data-state={amendMode ? 'active' : 'inactive'}
              onClick={onToggleAmend}
              aria-pressed={amendMode}
              title="Amend the previous commit"
            >
              Amend
            </button>
          )}

          {/* Details toggle — reveals the extended description body. */}
          <button
            type="button"
            className="scm-row-action th-focus-ring"
            onClick={onToggleCommitBody}
            title={showCommitBody ? 'Hide details' : 'Add details'}
            aria-label={showCommitBody ? 'Hide details' : 'Add details'}
            aria-pressed={showCommitBody}
          >
            {showCommitBody
              ? <ChevronUp className="w-3 h-3" strokeWidth={2} />
              : <Edit3 className="w-3 h-3" strokeWidth={2} />}
          </button>

          {/* AI sparkle — placeholder behavior in this commit (no
              backend route yet).  Calls onAIGenerate, which the
              parent can wire to a real generator when ready. */}
          {aiAvailable && (
            <button
              type="button"
              className={[
                'scm-composer-sparkle th-focus-ring',
                isAIStreaming ? 'is-streaming' : '',
              ].filter(Boolean).join(' ')}
              onClick={onAIGenerate}
              disabled={isAIStreaming || isSubmitting}
              title="Suggest a commit message"
              aria-label="Suggest a commit message"
            >
              {isAIStreaming
                ? <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
                : <Sparkles className="w-3 h-3" strokeWidth={2} />}
            </button>
          )}

          {/* Submit pill — gradient when ready.  Split button when
              we're going to commit-and-push so the user can still
              opt for commit-only with a single click. */}
          <div className="flex items-center" ref={submitButtonRef}>
            <button
              type="button"
              className={submitClass}
              onClick={handleSubmitClick}
              disabled={!isReady}
              style={showSplit ? { borderTopRightRadius: 0, borderBottomRightRadius: 0, marginRight: 0 } : undefined}
              aria-label={submitLabel}
              title={ahead > 0 && !amendMode ? 'Ctrl/Cmd+Shift+Enter — commit & push' : 'Ctrl/Cmd+Enter — commit'}
            >
              {isSubmitting
                ? <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
                : <ArrowUp className="w-3 h-3" strokeWidth={2} />}
              <span>{submitLabel}</span>
            </button>
            {showSplit && (
              <button
                type="button"
                className={submitClass}
                onClick={handleCommitOnly}
                disabled={!isReady}
                title="Commit only (no push)"
                aria-label="Commit only"
                style={{
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  paddingLeft: 6,
                  paddingRight: 6,
                  marginLeft: 1,
                }}
              >
                <ChevronDown className="w-3 h-3" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const CommitComposer = memo(CommitComposerImpl);

export default CommitComposer;
export { CommitComposer };
