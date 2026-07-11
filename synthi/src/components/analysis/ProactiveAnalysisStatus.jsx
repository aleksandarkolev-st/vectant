'use client';

/**
 * ProactiveAnalysisStatus
 * 
 * A compact status indicator for proactive analysis that can be shown
 * in the editor's status bar or as a floating badge. Shows:
 * 
 * - Current analysis status (idle, analyzing, error)
 * - Error/warning counts
 * - Quick access to Problems panel
 * - Connection status
 */

import React, { useCallback, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  Loader2,
  Sparkles,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProactiveAnalysisContext } from './ProactiveAnalysisProvider';

const tone = {
  success: 'var(--accent-success)',
  warning: 'var(--accent-warning)',
  danger: 'var(--accent-danger)',
  info: 'var(--accent-secondary)',
  muted: 'var(--text-muted)',
  ai: 'var(--attention-purple)',
};

function softStyle(color, extra = {}) {
  return {
    borderColor: `color-mix(in srgb, ${color} 28%, transparent)`,
    background: `color-mix(in srgb, ${color} 8%, transparent)`,
    color,
    ...extra,
  };
}

/**
 * Compact status badge for status bar
 */
export function ProactiveAnalysisStatusBadge({
  onClick,
  className,
  showLabel = true,
}) {
  const {
    summary,
    isAnalyzing,
    enabled,
    connectionStatus,
    tierStatus,
  } = useProactiveAnalysisContext();
  
  const hasErrors = summary.errors > 0;
  const hasWarnings = summary.warnings > 0;
  const isConnected = connectionStatus === 'connected';
  
  // Determine icon and color based on state
  let Icon = CheckCircle2;
  let iconColor = tone.success;
  let stateColor = tone.success;
  
  if (!enabled) {
    Icon = Zap;
    iconColor = tone.muted;
    stateColor = tone.muted;
  } else if (!isConnected) {
    Icon = CloudOff;
    iconColor = tone.muted;
    stateColor = tone.muted;
  } else if (isAnalyzing) {
    Icon = Loader2;
    iconColor = tone.info;
    stateColor = tone.info;
  } else if (hasErrors) {
    Icon = AlertCircle;
    iconColor = tone.danger;
    stateColor = tone.danger;
  } else if (hasWarnings) {
    Icon = AlertTriangle;
    iconColor = tone.warning;
    stateColor = tone.warning;
  }
  
  // Check if AI tier is active
  const aiActive = tierStatus.ai?.status === 'running';
  
  return (
    <button
      onClick={onClick}
      className={cn(
        'th-focus-ring flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
        className,
      )}
      style={softStyle(stateColor)}
      title={enabled ? 'Proactive Analysis' : 'Proactive Analysis (Disabled)'}
    >
      <Icon className={cn('h-3.5 w-3.5', isAnalyzing && 'animate-spin')} style={{ color: iconColor }} />
      
      {showLabel && (
        <span style={{ color: enabled ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
          {!enabled ? 'Off' : isAnalyzing ? 'Analyzing' : 'Analysis'}
        </span>
      )}
      
      {/* Error/Warning counts */}
      {enabled && !isAnalyzing && (hasErrors || hasWarnings) && (
        <span className="flex items-center gap-1">
          {hasErrors && (
            <span className="font-medium" style={{ color: tone.danger }}>{summary.errors}</span>
          )}
          {hasErrors && hasWarnings && (
            <span style={{ color: 'var(--text-muted)' }}>/</span>
          )}
          {hasWarnings && (
            <span className="font-medium" style={{ color: tone.warning }}>{summary.warnings}</span>
          )}
        </span>
      )}
      
      {/* AI indicator */}
      {aiActive && (
        <Sparkles className="h-3 w-3 animate-pulse" style={{ color: tone.ai }} />
      )}
    </button>
  );
}

/**
 * Floating status indicator with more details
 */
export function ProactiveAnalysisStatusFloat({
  position = 'bottom-right',
  onOpenProblems,
  className,
}) {
  const {
    diagnostics,
    summary,
    isAnalyzing,
    enabled,
    setEnabled,
    connectionStatus,
    tierStatus,
    analyzeFull,
    settings,
  } = useProactiveAnalysisContext();
  
  const [isExpanded, setIsExpanded] = useState(false);
  
  const hasIssues = summary.total > 0;
  const isConnected = connectionStatus === 'connected';
  
  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);
  
  const handleRunAiAnalysis = useCallback(() => {
    analyzeFull({ includeAi: true });
  }, [analyzeFull]);
  
  const positionClass = {
    'bottom-right': 'bottom-4 right-4',
    'bottom-left': 'bottom-4 left-16',
    'top-right': 'top-4 right-4',
    'top-left': 'top-4 left-4',
  }[position] || 'bottom-4 right-4';
  
  if (!enabled) {
    return (
      <button
        onClick={() => setEnabled(true)}
        className={cn(
          'th-focus-ring fixed z-50 rounded-full border p-2 transition-colors',
          positionClass,
          className,
        )}
        style={{
          borderColor: 'var(--border-medium)',
          background: 'color-mix(in srgb, var(--bg-panel) 84%, transparent)',
          color: tone.muted,
        }}
        title="Enable Proactive Analysis"
      >
        <Zap className="h-4 w-4" />
      </button>
    );
  }
  
  return (
    <div className={cn('fixed z-50', positionClass, className)}>
      {/* Expanded panel */}
      {isExpanded && (
        <div className={cn(
          'vt-dialog-surface mb-2 min-w-[220px] p-3',
        )}>
          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Analysis Status
            </span>
            <button
              onClick={() => setEnabled(false)}
              className="text-xs transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              Disable
            </button>
          </div>
          
          {/* Connection status */}
          <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span className="h-2 w-2 rounded-full" style={{ background: isConnected ? tone.success : tone.danger }} />
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
          
          {/* Tier status */}
          <div className="space-y-1 mb-3">
            {Object.entries(tierStatus).map(([tier, status]) => (
              <div key={tier} className="flex items-center justify-between text-xs">
                <span className="capitalize" style={{ color: 'var(--text-secondary)' }}>{tier}</span>
                <span style={{
                  color: status.status === 'completed'
                    ? tone.success
                    : status.status === 'running'
                      ? tone.info
                      : status.status === 'error'
                        ? tone.danger
                        : tone.muted,
                }}>
                  {status.status}
                  {status.elapsed > 0 && ` (${Math.round(status.elapsed)}ms)`}
                </span>
              </div>
            ))}
          </div>
          
          {/* Summary */}
          {hasIssues && (
            <div className="flex items-center gap-2 text-xs mb-3">
              {summary.errors > 0 && (
                <span className="flex items-center gap-1" style={{ color: tone.danger }}>
                  <AlertCircle className="h-3 w-3" />
                  {summary.errors}
                </span>
              )}
              {summary.warnings > 0 && (
                <span className="flex items-center gap-1" style={{ color: tone.warning }}>
                  <AlertTriangle className="h-3 w-3" />
                  {summary.warnings}
                </span>
              )}
              {summary.infos > 0 && (
                <span style={{ color: tone.muted }}>{summary.infos} info</span>
              )}
            </div>
          )}
          
          {/* Actions */}
          <div className="flex items-center gap-2">
            {onOpenProblems && hasIssues && (
              <button
                onClick={onOpenProblems}
                className="th-focus-ring flex-1 rounded-md border px-2 py-1 text-xs"
                style={{ borderColor: 'var(--border-medium)', color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--bg-editor) 72%, transparent)' }}
              >
                View Problems
              </button>
            )}
            <button
              onClick={handleRunAiAnalysis}
              disabled={isAnalyzing}
              className="th-focus-ring flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
              style={softStyle(tone.ai)}
            >
              <Sparkles className="h-3 w-3" />
              AI
            </button>
          </div>
        </div>
      )}
      
      {/* Main button */}
      <button
        onClick={handleToggle}
        className={cn(
          'th-focus-ring flex items-center gap-2 rounded-full border px-3 py-2 transition-colors',
        )}
        style={{
          borderColor: isAnalyzing
            ? `color-mix(in srgb, ${tone.info} 44%, transparent)`
            : hasIssues && summary.errors > 0
              ? `color-mix(in srgb, ${tone.danger} 44%, transparent)`
              : 'var(--border-medium)',
          background: 'color-mix(in srgb, var(--bg-panel) 84%, transparent)',
        }}
      >
        {isAnalyzing ? (
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: tone.info }} />
        ) : summary.errors > 0 ? (
          <AlertCircle className="h-4 w-4" style={{ color: tone.danger }} />
        ) : summary.warnings > 0 ? (
          <AlertTriangle className="h-4 w-4" style={{ color: tone.warning }} />
        ) : (
          <CheckCircle2 className="h-4 w-4" style={{ color: tone.success }} />
        )}
        
        {hasIssues && (
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {summary.total}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * Inline status for editor header
 */
export function ProactiveAnalysisInlineStatus({ className }) {
  const {
    summary,
    isAnalyzing,
    enabled,
  } = useProactiveAnalysisContext();
  
  if (!enabled) {
    return (
      <span className={cn('flex items-center gap-1 text-xs', className)} style={{ color: tone.muted }}>
        <Zap className="h-3 w-3" />
        Analysis off
      </span>
    );
  }
  
  if (isAnalyzing) {
    return (
      <span className={cn('flex items-center gap-1 text-xs', className)} style={{ color: tone.info }}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Analyzing...
      </span>
    );
  }
  
  if (summary.errors > 0) {
    return (
      <span className={cn('flex items-center gap-1 text-xs', className)} style={{ color: tone.danger }}>
        <AlertCircle className="h-3 w-3" />
        {summary.errors} error{summary.errors > 1 ? 's' : ''}
      </span>
    );
  }
  
  if (summary.warnings > 0) {
    return (
      <span className={cn('flex items-center gap-1 text-xs', className)} style={{ color: tone.warning }}>
        <AlertTriangle className="h-3 w-3" />
        {summary.warnings} warning{summary.warnings > 1 ? 's' : ''}
      </span>
    );
  }
  
  return (
    <span className={cn('flex items-center gap-1 text-xs', className)} style={{ color: tone.success }}>
      <CheckCircle2 className="h-3 w-3" />
      No issues
    </span>
  );
}

export default {
  ProactiveAnalysisStatusBadge,
  ProactiveAnalysisStatusFloat,
  ProactiveAnalysisInlineStatus,
};
