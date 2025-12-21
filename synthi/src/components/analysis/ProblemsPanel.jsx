'use client';

/**
 * ProblemsPanel Component
 * 
 * Displays all diagnostics from proactive analysis in a VS Code-like
 * problems panel. Shows errors, warnings, and info with:
 * - Severity icons and colors
 * - File path and line number
 * - Quick navigation to issue location
 * - Filtering by severity/tier
 * - Real-time updates as analysis runs
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCode,
  Filter,
  Info,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Severity configuration
const SEVERITY_CONFIG = {
  error: {
    icon: AlertCircle,
    label: 'Error',
    className: 'text-red-400',
    bgClass: 'bg-red-500/10 border-red-500/30',
    dotClass: 'bg-red-500',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    className: 'text-amber-400',
    bgClass: 'bg-amber-500/10 border-amber-500/30',
    dotClass: 'bg-amber-500',
  },
  info: {
    icon: Info,
    label: 'Info',
    className: 'text-blue-400',
    bgClass: 'bg-blue-500/10 border-blue-500/30',
    dotClass: 'bg-blue-500',
  },
  hint: {
    icon: Lightbulb,
    label: 'Hint',
    className: 'text-emerald-400',
    bgClass: 'bg-emerald-500/10 border-emerald-500/30',
    dotClass: 'bg-emerald-500',
  },
};

// Tier badges
const TIER_CONFIG = {
  static: {
    label: 'Static',
    className: 'bg-slate-700 text-slate-200',
  },
  semantic: {
    label: 'Semantic',
    className: 'bg-indigo-900/50 text-indigo-300',
  },
  ai: {
    label: 'AI',
    className: 'bg-purple-900/50 text-purple-300',
    icon: Sparkles,
  },
};

/**
 * Single diagnostic item with cross-file navigation support
 */
function DiagnosticItem({ diagnostic, onNavigate, isSelected, filePath }) {
  const severityConfig = SEVERITY_CONFIG[diagnostic.severity] || SEVERITY_CONFIG.info;
  const tierConfig = TIER_CONFIG[diagnostic.tier] || TIER_CONFIG.static;
  const SeverityIcon = severityConfig.icon;
  const TierIcon = tierConfig.icon;
  
  const handleClick = useCallback(() => {
    if (onNavigate) {
      // Include file path for cross-file navigation
      onNavigate({
        filePath: diagnostic.filePath || diagnostic.primaryFile || filePath,
        line: diagnostic.location?.line ?? 0,
        column: diagnostic.location?.column ?? 0,
        endLine: diagnostic.location?.endLine,
        endColumn: diagnostic.location?.endColumn,
      });
    }
  }, [diagnostic, onNavigate, filePath]);
  
  return (
    <button
      onClick={handleClick}
      className={cn(
        'w-full text-left px-3 py-2 flex items-start gap-2 transition-colors',
        'hover:bg-[#2a2a2a] focus:bg-[#2a2a2a] focus:outline-none',
        isSelected && 'bg-[#2a2a2a] border-l-2 border-l-blue-500',
      )}
    >
      {/* Severity Icon */}
      <SeverityIcon className={cn('h-4 w-4 mt-0.5 flex-shrink-0', severityConfig.className)} />
      
      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Message */}
        <p className="text-sm text-gray-200 break-words">
          {diagnostic.message}
        </p>
        
        {/* Explanation (AI diagnostics) */}
        {diagnostic.explanation && (
          <p className="text-xs text-gray-400 mt-1 break-words">
            {diagnostic.explanation}
          </p>
        )}
        
        {/* Meta info */}
        <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
          {/* Location - show range for multi-line diagnostics */}
          <span className="flex items-center gap-1">
            <FileCode className="h-3 w-3" />
            {diagnostic.location?.endLine !== undefined && 
             diagnostic.location.endLine !== diagnostic.location.line ? (
              // Multi-line span
              <>Ln {(diagnostic.location?.line ?? 0) + 1}-{(diagnostic.location.endLine ?? 0) + 1}</>
            ) : (
              // Single line
              <>Ln {(diagnostic.location?.line ?? 0) + 1}, Col {(diagnostic.location?.column ?? 0) + 1}</>
            )}
          </span>
          
          {/* Code */}
          {diagnostic.code && (
            <span className="font-mono">{diagnostic.code}</span>
          )}
          
          {/* Tier badge */}
          <span className={cn(
            'px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide flex items-center gap-1',
            tierConfig.className,
          )}>
            {TierIcon && <TierIcon className="h-2.5 w-2.5" />}
            {tierConfig.label}
          </span>
          
          {/* Confidence (AI only) */}
          {diagnostic.confidence && diagnostic.confidence < 1 && (
            <span className="text-purple-400">
              {Math.round(diagnostic.confidence * 100)}%
            </span>
          )}
        </div>
        
        {/* Cross-file references */}
        {diagnostic.crossFileRefs?.length > 0 && (
          <div className="mt-1 text-xs text-gray-500">
            <span className="text-gray-400">Related: </span>
            {diagnostic.crossFileRefs.map((ref, idx) => (
              <button
                key={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onNavigate) {
                    onNavigate({
                      filePath: ref.filePath || ref.file,
                      line: ref.location?.line ?? ref.line ?? 0,
                      column: ref.location?.column ?? 0,
                    });
                  }
                }}
                className="text-blue-400 hover:text-blue-300 hover:underline ml-1"
              >
                {ref.filePath?.split('/').pop() || ref.file?.split('/').pop()}:{(ref.location?.line ?? ref.line ?? 0) + 1}
              </button>
            ))}
          </div>
        )}
        
        {/* Quick fixes available indicator */}
        {diagnostic.fixes?.length > 0 && (
          <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
            <Lightbulb className="h-3 w-3" />
            {diagnostic.fixes.length} quick fix{diagnostic.fixes.length > 1 ? 'es' : ''} available
          </div>
        )}
      </div>
    </button>
  );
}

/**
 * Grouped diagnostics by file
 */
function FileGroup({ filePath, diagnostics, onNavigate, isExpanded, onToggle }) {
  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;
  
  return (
    <div className="border-b border-[#2a2a2a] last:border-b-0">
      {/* File header */}
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-[#252525] text-left"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-gray-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-500" />
        )}
        
        <FileCode className="h-4 w-4 text-gray-400" />
        <span className="text-sm text-gray-300 truncate flex-1">{filePath}</span>
        
        {/* Counts */}
        <div className="flex items-center gap-1.5">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <span className="w-4 h-4 rounded-full bg-red-500/20 flex items-center justify-center">
                {errorCount}
              </span>
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-amber-400">
              <span className="w-4 h-4 rounded-full bg-amber-500/20 flex items-center justify-center">
                {warningCount}
              </span>
            </span>
          )}
        </div>
      </button>
      
      {/* Diagnostics list */}
      {isExpanded && (
        <div className="bg-[#1a1a1a]">
          {diagnostics.map((diagnostic, index) => (
            <DiagnosticItem
              key={`${diagnostic.code}-${diagnostic.location?.line}-${index}`}
              diagnostic={diagnostic}
              onNavigate={onNavigate}
              filePath={filePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Filter bar for diagnostics
 */
function FilterBar({ filters, onFilterChange, summary }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2a2a2a] bg-[#1a1a1a]">
      <Filter className="h-3.5 w-3.5 text-gray-500" />
      
      {/* Severity filters */}
      {Object.entries(SEVERITY_CONFIG).map(([severity, config]) => {
        const count = summary[`${severity}s`] || summary[severity] || 0;
        const isActive = filters.severities.includes(severity);
        
        return (
          <button
            key={severity}
            onClick={() => onFilterChange('severity', severity)}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors',
              isActive
                ? config.bgClass
                : 'bg-transparent hover:bg-[#2a2a2a] text-gray-500',
            )}
          >
            <span className={cn('w-2 h-2 rounded-full', config.dotClass)} />
            <span className={isActive ? config.className : ''}>{count}</span>
          </button>
        );
      })}
      
      {/* Tier filters */}
      <div className="border-l border-[#3a3a3a] pl-2 ml-1">
        {Object.entries(TIER_CONFIG).map(([tier, config]) => {
          const isActive = filters.tiers.includes(tier);
          const TierIcon = config.icon;
          
          return (
            <button
              key={tier}
              onClick={() => onFilterChange('tier', tier)}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors ml-1',
                isActive
                  ? config.className
                  : 'bg-transparent hover:bg-[#2a2a2a] text-gray-500',
              )}
            >
              {TierIcon && <TierIcon className="h-3 w-3 inline mr-1" />}
              {config.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Main ProblemsPanel component
 */
export function ProblemsPanel({
  diagnostics = [],
  summary = {},
  isAnalyzing = false,
  tierStatus = {},
  filePath = 'Current File',
  onNavigate,
  onRefresh,
  onClose,
  className,
}) {
  // Filter state
  const [filters, setFilters] = useState({
    severities: ['error', 'warning', 'info', 'hint'],
    tiers: ['static', 'semantic', 'ai'],
  });
  
  // Expansion state - expand all files with diagnostics by default
  const [expandedFiles, setExpandedFiles] = useState(() => {
    const files = new Set();
    diagnostics.forEach(d => {
      if (d.filePath) files.add(d.filePath);
    });
    files.add(filePath); // Always include current file
    return files;
  });
  
  // Update expanded files when diagnostics change (to include new files)
  useMemo(() => {
    const newFiles = new Set(expandedFiles);
    diagnostics.forEach(d => {
      if (d.filePath && !newFiles.has(d.filePath)) {
        newFiles.add(d.filePath);
      }
    });
    if (newFiles.size !== expandedFiles.size) {
      setExpandedFiles(newFiles);
    }
  }, [diagnostics]);
  
  // Handle filter changes
  const handleFilterChange = useCallback((type, value) => {
    setFilters(prev => {
      const key = type === 'severity' ? 'severities' : 'tiers';
      const current = prev[key];
      const updated = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value];
      return { ...prev, [key]: updated };
    });
  }, []);
  
  // Filter diagnostics
  const filteredDiagnostics = useMemo(() => {
    return diagnostics.filter(d =>
      filters.severities.includes(d.severity) &&
      filters.tiers.includes(d.tier)
    );
  }, [diagnostics, filters]);
  
  // Group by file
  const groupedDiagnostics = useMemo(() => {
    const groups = new Map();
    for (const diagnostic of filteredDiagnostics) {
      const path = diagnostic.filePath || filePath;
      if (!groups.has(path)) {
        groups.set(path, []);
      }
      groups.get(path).push(diagnostic);
    }
    return groups;
  }, [filteredDiagnostics, filePath]);
  
  // Toggle file expansion
  const toggleFile = useCallback((path) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);
  
  return (
    <div className={cn(
      'flex flex-col bg-[#151515] border border-[#2a2a2a] rounded-md overflow-hidden',
      className,
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a2a2a]">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Problems
          </h3>
          
          {/* Summary badges */}
          <div className="flex items-center gap-1.5">
            {summary.errors > 0 && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/20 text-xs text-red-400">
                <AlertCircle className="h-3 w-3" />
                {summary.errors}
              </span>
            )}
            {summary.warnings > 0 && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-xs text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {summary.warnings}
              </span>
            )}
          </div>
          
          {/* Analysis status */}
          {isAnalyzing && (
            <div className="flex items-center gap-1 text-xs text-blue-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Analyzing...
            </div>
          )}
        </div>
        
        {/* Actions */}
        <div className="flex items-center gap-1">
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={isAnalyzing}
              className="p-1 rounded hover:bg-[#2a2a2a] text-gray-400 hover:text-gray-200 disabled:opacity-50"
              title="Refresh analysis"
            >
              <RefreshCw className={cn('h-4 w-4', isAnalyzing && 'animate-spin')} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[#2a2a2a] text-gray-400 hover:text-gray-200"
              title="Close panel"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      
      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onFilterChange={handleFilterChange}
        summary={summary}
      />
      
      {/* Tier progress indicators */}
      {isAnalyzing && (
        <div className="flex items-center gap-2 px-3 py-1 bg-[#1a1a1a] border-b border-[#2a2a2a] text-xs">
          {Object.entries(tierStatus).map(([tier, status]) => {
            const config = TIER_CONFIG[tier];
            if (!config) return null;
            
            return (
              <span key={tier} className="flex items-center gap-1 text-gray-400">
                {status.status === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                ) : status.status === 'completed' ? (
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                ) : status.status === 'error' ? (
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-gray-600" />
                )}
                {config.label}
                {status.elapsed > 0 && (
                  <span className="text-gray-600">({Math.round(status.elapsed)}ms)</span>
                )}
              </span>
            );
          })}
        </div>
      )}
      
      {/* Diagnostics list */}
      <div className="flex-1 overflow-auto">
        {filteredDiagnostics.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500">
            {diagnostics.length === 0 ? (
              <>
                <AlertCircle className="h-8 w-8 mb-2 text-emerald-500/50" />
                <p className="text-sm">No problems detected</p>
                <p className="text-xs text-gray-600 mt-1">Your code looks good!</p>
              </>
            ) : (
              <>
                <Filter className="h-8 w-8 mb-2" />
                <p className="text-sm">No problems match filters</p>
                <p className="text-xs text-gray-600 mt-1">Adjust filters to see results</p>
              </>
            )}
          </div>
        ) : (
          <div>
            {Array.from(groupedDiagnostics.entries()).map(([path, fileDiagnostics]) => (
              <FileGroup
                key={path}
                filePath={path}
                diagnostics={fileDiagnostics}
                onNavigate={onNavigate}
                isExpanded={expandedFiles.has(path)}
                onToggle={() => toggleFile(path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ProblemsPanel;
