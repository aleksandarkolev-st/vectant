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
  let iconClass = 'text-emerald-400';
  let bgClass = 'bg-emerald-500/10';
  
  if (!enabled) {
    Icon = Zap;
    iconClass = 'text-gray-500';
    bgClass = 'bg-gray-500/10';
  } else if (!isConnected) {
    Icon = CloudOff;
    iconClass = 'text-gray-500';
    bgClass = 'bg-gray-500/10';
  } else if (isAnalyzing) {
    Icon = Loader2;
    iconClass = 'text-blue-400 animate-spin';
    bgClass = 'bg-blue-500/10';
  } else if (hasErrors) {
    Icon = AlertCircle;
    iconClass = 'text-red-400';
    bgClass = 'bg-red-500/10';
  } else if (hasWarnings) {
    Icon = AlertTriangle;
    iconClass = 'text-amber-400';
    bgClass = 'bg-amber-500/10';
  }
  
  // Check if AI tier is active
  const aiActive = tierStatus.ai?.status === 'running';
  
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
        'hover:bg-[#2a2a2a]',
        bgClass,
        className,
      )}
      title={enabled ? 'Proactive Analysis' : 'Proactive Analysis (Disabled)'}
    >
      <Icon className={cn('h-3.5 w-3.5', iconClass)} />
      
      {showLabel && (
        <span className={cn(
          'text-gray-400',
          !enabled && 'text-gray-600',
        )}>
          {!enabled ? 'Off' : isAnalyzing ? 'Analyzing' : 'Analysis'}
        </span>
      )}
      
      {/* Error/Warning counts */}
      {enabled && !isAnalyzing && (hasErrors || hasWarnings) && (
        <span className="flex items-center gap-1">
          {hasErrors && (
            <span className="text-red-400 font-medium">{summary.errors}</span>
          )}
          {hasErrors && hasWarnings && (
            <span className="text-gray-600">/</span>
          )}
          {hasWarnings && (
            <span className="text-amber-400 font-medium">{summary.warnings}</span>
          )}
        </span>
      )}
      
      {/* AI indicator */}
      {aiActive && (
        <Sparkles className="h-3 w-3 text-purple-400 animate-pulse" />
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
    'bottom-left': 'bottom-4 left-4',
    'top-right': 'top-4 right-4',
    'top-left': 'top-4 left-4',
  }[position] || 'bottom-4 right-4';
  
  if (!enabled) {
    return (
      <button
        onClick={() => setEnabled(true)}
        className={cn(
          'fixed z-50 p-2 rounded-full bg-[#1a1a1a] border border-[#2a2a2a]',
          'shadow-lg hover:bg-[#252525] transition-colors',
          positionClass,
          className,
        )}
        title="Enable Proactive Analysis"
      >
        <Zap className="h-4 w-4 text-gray-500" />
      </button>
    );
  }
  
  return (
    <div className={cn('fixed z-50', positionClass, className)}>
      {/* Expanded panel */}
      {isExpanded && (
        <div className={cn(
          'mb-2 p-3 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a]',
          'shadow-xl min-w-[200px]',
        )}>
          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Analysis Status
            </span>
            <button
              onClick={() => setEnabled(false)}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Disable
            </button>
          </div>
          
          {/* Connection status */}
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <span className={cn(
              'w-2 h-2 rounded-full',
              isConnected ? 'bg-emerald-500' : 'bg-red-500',
            )} />
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
          
          {/* Tier status */}
          <div className="space-y-1 mb-3">
            {Object.entries(tierStatus).map(([tier, status]) => (
              <div key={tier} className="flex items-center justify-between text-xs">
                <span className="text-gray-400 capitalize">{tier}</span>
                <span className={cn(
                  status.status === 'completed' && 'text-emerald-400',
                  status.status === 'running' && 'text-blue-400',
                  status.status === 'error' && 'text-red-400',
                  status.status === 'idle' && 'text-gray-600',
                )}>
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
                <span className="flex items-center gap-1 text-red-400">
                  <AlertCircle className="h-3 w-3" />
                  {summary.errors}
                </span>
              )}
              {summary.warnings > 0 && (
                <span className="flex items-center gap-1 text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  {summary.warnings}
                </span>
              )}
              {summary.infos > 0 && (
                <span className="text-gray-500">{summary.infos} info</span>
              )}
            </div>
          )}
          
          {/* Actions */}
          <div className="flex items-center gap-2">
            {onOpenProblems && hasIssues && (
              <button
                onClick={onOpenProblems}
                className="flex-1 px-2 py-1 rounded bg-[#252525] text-xs text-gray-300 hover:bg-[#2a2a2a]"
              >
                View Problems
              </button>
            )}
            <button
              onClick={handleRunAiAnalysis}
              disabled={isAnalyzing}
              className="flex items-center gap-1 px-2 py-1 rounded bg-purple-900/30 text-xs text-purple-300 hover:bg-purple-900/50 disabled:opacity-50"
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
          'flex items-center gap-2 px-3 py-2 rounded-full',
          'bg-[#1a1a1a] border border-[#2a2a2a]',
          'shadow-lg hover:bg-[#252525] transition-all',
          isAnalyzing && 'border-blue-500/50',
          hasIssues && summary.errors > 0 && 'border-red-500/50',
        )}
      >
        {isAnalyzing ? (
          <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
        ) : summary.errors > 0 ? (
          <AlertCircle className="h-4 w-4 text-red-400" />
        ) : summary.warnings > 0 ? (
          <AlertTriangle className="h-4 w-4 text-amber-400" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        )}
        
        {hasIssues && (
          <span className="text-xs text-gray-400">
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
      <span className={cn('flex items-center gap-1 text-xs text-gray-600', className)}>
        <Zap className="h-3 w-3" />
        Analysis off
      </span>
    );
  }
  
  if (isAnalyzing) {
    return (
      <span className={cn('flex items-center gap-1 text-xs text-blue-400', className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Analyzing...
      </span>
    );
  }
  
  if (summary.errors > 0) {
    return (
      <span className={cn('flex items-center gap-1 text-xs text-red-400', className)}>
        <AlertCircle className="h-3 w-3" />
        {summary.errors} error{summary.errors > 1 ? 's' : ''}
      </span>
    );
  }
  
  if (summary.warnings > 0) {
    return (
      <span className={cn('flex items-center gap-1 text-xs text-amber-400', className)}>
        <AlertTriangle className="h-3 w-3" />
        {summary.warnings} warning{summary.warnings > 1 ? 's' : ''}
      </span>
    );
  }
  
  return (
    <span className={cn('flex items-center gap-1 text-xs text-emerald-400', className)}>
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
