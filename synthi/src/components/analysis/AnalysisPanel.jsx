'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  WifiOff,
  X,
} from 'lucide-react';
import { GatewayStatus } from '@/services/analyzerGatewayClient';
import { cn } from '@/lib/utils';
import { ContextMenu, useContextMenu } from '@/components/docking-wm/components/ContextMenu';
import { toast } from 'sonner';

/*const severityStyles = {
  error: 'bg-red-500/15 text-red-300 border border-red-600/40',
  warning: 'bg-amber-500/15 text-amber-200 border border-amber-500/30',
  info: 'bg-sky-500/15 text-sky-200 border border-sky-500/20',
  hint: 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/30',
};*/

const statusMeta = {
  [GatewayStatus.CONNECTED]: {
    label: 'Connected',
    dotClass: 'bg-[#4ade80]',
  },
  [GatewayStatus.CONNECTING]: {
    label: 'Connecting…',
    dotClass: 'bg-[#fbbf24] animate-pulse',
  },
  [GatewayStatus.DISCONNECTED]: {
    label: 'Disconnected',
    dotClass: 'bg-[#5a6178]',
  },
  [GatewayStatus.ERROR]: {
    label: 'Error',
    dotClass: 'bg-[#ff6b6b]',
  },
  [GatewayStatus.IDLE]: {
    label: 'Idle',
    dotClass: 'bg-[#5a6178]',
  },
};

/*const severityIcon = {
  error: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
  hint: Info,
};*/

/*const severityLabel = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  hint: 'Hint',
};*/

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
    const markdown = `### AI Suggestion${lang ? ` (${lang})` : ''}\n\n${aiSuggestion}`;
    openMenu(e, [
      {
        id: 'copy',
        label: 'Copy Suggestion',
        action: () => copyText(aiSuggestion, 'suggestion'),
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
    <section className="mx-3 mt-3 rounded-md border border-[#1a1b24] bg-[#0d0e14] text-sm shadow-lg shadow-black/40">
      <header className="flex items-center justify-between border-b border-[#1a1b24] px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[#9ba2b8]">
            Analysis
          </h2>
          {lang && (
            <span className="rounded bg-[#1a1b24] px-2 py-0.5 text-[11px] uppercase tracking-wide text-[#9ba2b8]">
              {lang}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-[#9ba2b8]">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                statusInfo.dotClass || 'bg-[#5a6178]'
              )}
            />
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {error && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded border border-[#2a2b38] px-2 py-1 text-[11px] text-[#9ba2b8] hover:border-[#3a8574] hover:text-[#4aba9a]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[#5a6178] hover:text-[#f4f5f8]"
            aria-label="Close analysis panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="space-y-4 px-4 py-3">
        {isAnalyzing && (
          <div className="flex items-center gap-2 text-[#9ba2b8]">
            <Loader2 className="h-4 w-4 animate-spin text-[#3a8574]" />
            Running static + AI analysis…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded border border-[#ff6b6b]/40 bg-[#1a0f14] p-3 text-sm text-[#ff6b6b]">
            <WifiOff className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Gateway error</p>
              <p className="text-xs text-[#ff6b6b]/80">
                {error.message || 'An unexpected error occurred.'}
              </p>
            </div>
          </div>
        )}

        {!isAnalyzing && !error && !aiSuggestion && (
          <div className="flex items-center gap-2 text-sm text-[#9ba2b8]">
            <CheckCircle2 className="h-4 w-4 text-[#4ade80]" />
            No diagnostics reported for the current file.
          </div>
        )}

        {!isAnalyzing && !error && aiSuggestion && (
          <div onContextMenu={handleSuggestionContextMenu}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[#9ba2b8]">
              AI Suggestion
            </p>
            <div className="rounded border border-[#1a1b24] bg-[#08090d] p-3 text-sm leading-relaxed text-[#f4f5f8]">
              <p className="whitespace-pre-line">{aiSuggestion}</p>
            </div>
          </div>
        )}
      </div>

      {menuState && <ContextMenu {...menuState} onClose={closeMenu} />}
    </section>
  );
}
