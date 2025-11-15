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

/*const severityStyles = {
  error: 'bg-red-500/15 text-red-300 border border-red-600/40',
  warning: 'bg-amber-500/15 text-amber-200 border border-amber-500/30',
  info: 'bg-sky-500/15 text-sky-200 border border-sky-500/20',
  hint: 'bg-emerald-500/10 text-emerald-200 border border-emerald-500/30',
};*/

const statusMeta = {
  [GatewayStatus.CONNECTED]: {
    label: 'Connected',
    dotClass: 'bg-emerald-400',
  },
  [GatewayStatus.CONNECTING]: {
    label: 'Connecting…',
    dotClass: 'bg-amber-300 animate-pulse',
  },
  [GatewayStatus.DISCONNECTED]: {
    label: 'Disconnected',
    dotClass: 'bg-gray-500',
  },
  [GatewayStatus.ERROR]: {
    label: 'Error',
    dotClass: 'bg-red-400',
  },
  [GatewayStatus.IDLE]: {
    label: 'Idle',
    dotClass: 'bg-gray-400',
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

  return (
    <section className="mx-3 mt-3 rounded-md border border-[#2c2c2c] bg-[#151515] text-sm shadow-lg shadow-black/40">
      <header className="flex items-center justify-between border-b border-[#252525] px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">
            Analysis
          </h2>
          {lang && (
            <span className="rounded bg-[#1f1f1f] px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-300">
              {lang}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                statusInfo.dotClass || 'bg-gray-500'
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
              className="inline-flex items-center gap-1 rounded border border-[#3b3b3b] px-2 py-1 text-[11px] text-gray-300 hover:border-emerald-500 hover:text-emerald-400"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:text-gray-100"
            aria-label="Close analysis panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="space-y-4 px-4 py-3">
        {isAnalyzing && (
          <div className="flex items-center gap-2 text-gray-300">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            Running static + AI analysis…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded border border-red-600/40 bg-red-950/30 p-3 text-sm text-red-200">
            <WifiOff className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Gateway error</p>
              <p className="text-xs text-red-200/80">
                {error.message || 'An unexpected error occurred.'}
              </p>
            </div>
          </div>
        )}

        {!isAnalyzing && !error && !aiSuggestion && (
          <div className="flex items-center gap-2 text-sm text-gray-300">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            No diagnostics reported for the current file.
          </div>
        )}

        {!isAnalyzing && !error && aiSuggestion && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
              AI Suggestion
            </p>
            <div className="rounded border border-[#2e2e2e] bg-[#111111] p-3 text-sm leading-relaxed text-gray-200">
              <p className="whitespace-pre-line">{aiSuggestion}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
