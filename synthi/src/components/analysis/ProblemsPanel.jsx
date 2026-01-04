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
 * 
 * COLOR PALETTE (exact, no deviations):
 * - Error panel background: #2B0F12 (muted dark red, low eye strain)
 * - Error text: #E6E6E6 (readable, no pure white)
 * - Error accent (icon, left bar): #C6362B (confirmed errors only)
 * - Warning background: #2A1E0A
 * - Warning accent: #D4A017
 * - Info/analysis background: #121212
 * - Info accent: #3A7AFE
 * - Borders: #3A3A3A (never red borders everywhere)
 * - Hover: +8% brightness only, no color shift
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

// EXACT COLOR PALETTE - DO NOT DEVIATE
const COLORS = {
  // Error colors
  errorBg: '#2B0F12',        // Muted dark red background
  errorText: '#E6E6E6',      // Readable text, not pure white
  errorAccent: '#C6362B',    // Icon/left bar accent
  errorHoverBg: '#361419',   // +8% brightness
  
  // Warning colors
  warningBg: '#2A1E0A',
  warningAccent: '#D4A017',
  warningHoverBg: '#352810', // +8% brightness
  
  // Info colors
  infoBg: '#121212',
  infoAccent: '#3A7AFE',
  infoHoverBg: '#1a1a1a',    // +8% brightness
  
  // General
  border: '#3A3A3A',
  panelBg: '#121212',
  headerBg: '#1a1a1a',
  text: '#E6E6E6',
  textMuted: '#888888',
  textDim: '#666666',
};

// Severity configuration with EXACT colors
const SEVERITY_CONFIG = {
  error: {
    icon: AlertCircle,
    label: 'Error',
    textClass: 'text-[#E6E6E6]',
    iconClass: 'text-[#C6362B]',
    bgClass: 'bg-[#2B0F12] border-l-[#C6362B]',
    badgeBg: 'bg-[#2B0F12]',
    dotClass: 'bg-[#C6362B]',
    hoverBg: 'hover:bg-[#361419]',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    textClass: 'text-[#E6E6E6]',
    iconClass: 'text-[#D4A017]',
    bgClass: 'bg-[#2A1E0A] border-l-[#D4A017]',
    badgeBg: 'bg-[#2A1E0A]',
    dotClass: 'bg-[#D4A017]',
    hoverBg: 'hover:bg-[#352810]',
  },
  info: {
    icon: Info,
    label: 'Info',
    textClass: 'text-[#E6E6E6]',
    iconClass: 'text-[#3A7AFE]',
    bgClass: 'bg-[#121212] border-l-[#3A7AFE]',
    badgeBg: 'bg-[#1a1a2a]',
    dotClass: 'bg-[#3A7AFE]',
    hoverBg: 'hover:bg-[#1a1a1a]',
  },
  hint: {
    icon: Lightbulb,
    label: 'Hint',
    textClass: 'text-[#E6E6E6]',
    iconClass: 'text-[#4ade80]',
    bgClass: 'bg-[#121212] border-l-[#4ade80]',
    badgeBg: 'bg-[#0f1a14]',
    dotClass: 'bg-[#4ade80]',
    hoverBg: 'hover:bg-[#1a1a1a]',
  },
};

// Tier badges
const TIER_CONFIG = {
  static: {
    label: 'Static',
    className: 'bg-[#2a2a2a] text-[#E6E6E6]',
  },
  semantic: {
    label: 'Semantic',
    className: 'bg-[#1a1a2a] text-[#3A7AFE]',
  },
  ai: {
    label: 'AI',
    className: 'bg-[#1a1a2a] text-[#3A7AFE]',
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
        'border-l-2',
        severityConfig.bgClass,
        severityConfig.hoverBg,
        'focus:outline-none focus:ring-1 focus:ring-[#3A7AFE] focus:ring-inset',
        isSelected && 'ring-1 ring-[#3A7AFE] ring-inset',
      )}
    >
      {/* Severity Icon */}
      <SeverityIcon className={cn('h-4 w-4 mt-0.5 flex-shrink-0', severityConfig.iconClass)} />
      
      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Message */}
        <p className={cn('text-sm break-words', severityConfig.textClass)}>
          {diagnostic.message}
        </p>
        
        {/* Explanation (AI diagnostics) */}
        {diagnostic.explanation && (
          <p className="text-xs text-[#888888] mt-1 break-words">
            {diagnostic.explanation}
          </p>
        )}
        
        {/* Meta info */}
        <div className="flex items-center gap-2 mt-1 text-xs text-[#666666]">
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
            <span className="text-[#3A7AFE]">
              {Math.round(diagnostic.confidence * 100)}%
            </span>
          )}
        </div>
        
        {/* Cross-file references */}
        {diagnostic.crossFileRefs?.length > 0 && (
          <div className="mt-1 text-xs text-[#666666]">
            <span className="text-[#888888]">Related: </span>
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
                className="text-[#3A7AFE] hover:text-[#5a9aff] hover:underline ml-1"
              >
                {ref.filePath?.split('/').pop() || ref.file?.split('/').pop()}:{(ref.location?.line ?? ref.line ?? 0) + 1}
              </button>
            ))}
          </div>
        )}
        
        {/* Quick fixes available indicator */}
        {diagnostic.fixes?.length > 0 && (
          <div className="flex items-center gap-1 mt-1 text-xs text-[#4ade80]">
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
    <div className="border-b border-[#3A3A3A] last:border-b-0">
      {/* File header */}
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-[#1a1a1a] text-left transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-[#666666]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[#666666]" />
        )}
        
        <FileCode className="h-4 w-4 text-[#888888]" />
        <span className="text-sm text-[#E6E6E6] truncate flex-1">{filePath}</span>
        
        {/* Counts */}
        <div className="flex items-center gap-1.5">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="w-5 h-5 rounded bg-[#2B0F12] flex items-center justify-center text-[#C6362B] font-medium">
                {errorCount}
              </span>
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="w-5 h-5 rounded bg-[#2A1E0A] flex items-center justify-center text-[#D4A017] font-medium">
                {warningCount}
              </span>
            </span>
          )}
        </div>
      </button>
      
      {/* Diagnostics list */}
      {isExpanded && (
        <div className="bg-[#121212]">
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
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[#3A3A3A] bg-[#1a1a1a]">
      <Filter className="h-3.5 w-3.5 text-[#666666]" />
      
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
                ? config.badgeBg + ' ' + config.textClass
                : 'bg-transparent hover:bg-[#2a2a2a] text-[#666666]',
            )}
          >
            <span className={cn('w-2 h-2 rounded-full', config.dotClass)} />
            <span>{count}</span>
          </button>
        );
      })}
      
      {/* Tier filters */}
      <div className="border-l border-[#3A3A3A] pl-2 ml-1">
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
                  : 'bg-transparent hover:bg-[#2a2a2a] text-[#666666]',
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
      'flex flex-col bg-[#121212] border border-[#3A3A3A] rounded-md overflow-hidden',
      className,
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3A3A3A] bg-[#1a1a1a]">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#888888]">
            Problems
          </h3>
          
          {/* Summary badges */}
          <div className="flex items-center gap-1.5">
            {summary.errors > 0 && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2B0F12] text-xs text-[#C6362B]">
                <AlertCircle className="h-3 w-3" />
                {summary.errors}
              </span>
            )}
            {summary.warnings > 0 && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2A1E0A] text-xs text-[#D4A017]">
                <AlertTriangle className="h-3 w-3" />
                {summary.warnings}
              </span>
            )}
          </div>
          
          {/* Analysis status */}
          {isAnalyzing && (
            <div className="flex items-center gap-1 text-xs text-[#3A7AFE]">
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
              className="p-1 rounded hover:bg-[#2a2a2a] text-[#888888] hover:text-[#E6E6E6] disabled:opacity-50 transition-colors"
              title="Refresh analysis"
            >
              <RefreshCw className={cn('h-4 w-4', isAnalyzing && 'animate-spin')} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[#2a2a2a] text-[#888888] hover:text-[#E6E6E6] transition-colors"
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
        <div className="flex items-center gap-2 px-3 py-1 bg-[#1a1a1a] border-b border-[#3A3A3A] text-xs">
          {Object.entries(tierStatus).map(([tier, status]) => {
            const config = TIER_CONFIG[tier];
            if (!config) return null;
            
            return (
              <span key={tier} className="flex items-center gap-1 text-[#888888]">
                {status.status === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-[#3A7AFE]" />
                ) : status.status === 'completed' ? (
                  <span className="w-2 h-2 rounded-full bg-[#4ade80]" />
                ) : status.status === 'error' ? (
                  <span className="w-2 h-2 rounded-full bg-[#C6362B]" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-[#666666]" />
                )}
                {config.label}
                {status.elapsed > 0 && (
                  <span className="text-[#666666]">({Math.round(status.elapsed)}ms)</span>
                )}
              </span>
            );
          })}
        </div>
      )}
      
      {/* Diagnostics list */}
      <div className="flex-1 overflow-auto">
        {filteredDiagnostics.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-[#666666]">
            {diagnostics.length === 0 ? (
              <>
                <AlertCircle className="h-8 w-8 mb-2 text-[#4ade80]/50" />
                <p className="text-sm text-[#E6E6E6]">No problems detected</p>
                <p className="text-xs text-[#666666] mt-1">Your code looks good!</p>
              </>
            ) : (
              <>
                <Filter className="h-8 w-8 mb-2" />
                <p className="text-sm text-[#E6E6E6]">No problems match filters</p>
                <p className="text-xs text-[#666666] mt-1">Adjust filters to see results</p>
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
