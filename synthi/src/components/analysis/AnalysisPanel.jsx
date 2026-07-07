'use client';

import {
  CheckCircle2,
  Loader2,
  RefreshCw,
  WifiOff,
  X,
} from 'lucide-react';
import { GatewayStatus } from '@/services/analyzerGatewayClient';
import { cn } from '@/lib/utils';
import { ContextMenu, useContextMenu } from '@/components/docking-wm/components/ContextMenu';
import { toast } from 'sonner';

const statusMeta = {
  [GatewayStatus.CONNECTED]: {
    label: 'Connected',
    color: 'var(--accent-success)',
  },
  [GatewayStatus.CONNECTING]: {
    label: 'Connecting',
    color: 'var(--accent-warning)',
    pulsing: true,
  },
  [GatewayStatus.DISCONNECTED]: {
    label: 'Disconnected',
    color: 'var(--text-muted)',
  },
  [GatewayStatus.ERROR]: {
    label: 'Error',
    color: 'var(--accent-danger)',
  },
  [GatewayStatus.IDLE]: {
    label: 'Idle',
    color: 'var(--text-muted)',
  },
};

export function AnalysisPanel({
  visible,
  status,
  result,
  error,
  isAnalyzing,
  onRetry,
  onClose,
}) {
  if (!visible) {
    return null;
  }

  const aiSuggestion = result?.ai_suggestion;
  const lang = result?.lang;

  const statusInfo = statusMeta[status] ?? statusMeta[GatewayStatus.IDLE];

  const { menuState, openMenu, closeMenu } = useContextMenu();

  const copyText = (text, label) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${label}`),
      () => toast.error('Copy failed'),
    );
  };

  const handleSuggestionContextMenu = (e) => {
    if (!aiSuggestion) return;
    const markdown = `### Model finding${lang ? ` (${lang})` : ''}\n\n${aiSuggestion}`;
    openMenu(e, [
      {
        id: 'copy',
        label: 'Copy finding',
        action: () => copyText(aiSuggestion, 'finding'),
      },
      {
        id: 'copy-md',
        label: 'Copy as Markdown',
        dividerAfter: !!onRetry,
        action: () => copyText(markdown, 'markdown'),
      },
      ...(onRetry ? [{
        id: 'retry',
        label: 'Re-run Analysis',
        action: onRetry,
      }] : []),
    ]);
  };

  return (
    <section
      className="vt-agent-card mx-3 mt-3 overflow-hidden text-sm"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--bg-panel) 82%, var(--bg-editor) 18%)',
      }}
    >
      <header className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>
            Analysis
          </h2>
          {lang && (
            <span
              className="rounded-md border px-2 py-0.5 text-[11px] uppercase tracking-wide"
              style={{
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-secondary)',
                background: 'color-mix(in srgb, var(--bg-editor) 70%, transparent)',
              }}
            >
              {lang}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span
              className={cn('h-2 w-2 rounded-full', statusInfo.pulsing && 'animate-pulse')}
              style={{ background: statusInfo.color || 'var(--text-muted)' }}
            />
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {error && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="th-focus-ring inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors"
              style={{
                borderColor: 'var(--border-medium)',
                color: 'var(--text-secondary)',
                background: 'transparent',
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="vt-icon-button th-focus-ring"
            aria-label="Close analysis panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="space-y-4 px-4 py-3">
        {isAnalyzing && (
          <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--accent-primary)' }} />
            Running static and model analysis
          </div>
        )}

        {error && (
          <div
            className="flex items-start gap-2 rounded-md border p-3 text-sm"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent-danger) 40%, transparent)',
              background: 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
              color: 'var(--accent-danger)',
            }}
          >
            <WifiOff className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Gateway error</p>
              <p className="text-xs opacity-80">
                {error.message || 'An unexpected error occurred.'}
              </p>
            </div>
          </div>
        )}

        {!isAnalyzing && !error && !aiSuggestion && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--accent-success)' }} />
            No diagnostics reported for the current file.
          </div>
        )}

        {!isAnalyzing && !error && aiSuggestion && (
          <div onContextMenu={handleSuggestionContextMenu}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
              Model Finding
            </p>
            <div
              className="rounded-md border p-3 text-sm leading-relaxed"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'color-mix(in srgb, var(--bg-editor) 76%, transparent)',
                color: 'var(--text-primary)',
              }}
            >
              <p className="whitespace-pre-line">{aiSuggestion}</p>
            </div>
          </div>
        )}
      </div>

      {menuState && <ContextMenu {...menuState} onClose={closeMenu} />}
    </section>
  );
}
