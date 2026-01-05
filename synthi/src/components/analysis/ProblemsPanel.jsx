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
 * COLOR PALETTE - Synthi Premium Dark Theme (Blue-Gray with Teal Accent)
 * Matches the rest of the application's theme
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

// SYNTHI PREMIUM DARK PALETTE - Blue-Gray with Teal Accent
const COLORS = {
  // Error colors - tinted to match blue-gray theme
  errorBg: '#1a0f14',        // Blue-tinted dark red background
  errorText: '#f4f5f8',      // Synthi text-primary
  errorAccent: '#ff6b6b',    // Synthi error red
  errorHoverBg: '#241419',   // Slightly lighter
  
  // Warning colors - tinted to match theme
  warningBg: '#1a1508',      // Blue-tinted dark amber
  warningAccent: '#fbbf24',  // Synthi warning amber
  warningHoverBg: '#24200e', // Slightly lighter
  
  // Info colors - Synthi teal accent
  infoBg: '#0d0e14',         // Synthi bg-card
  infoAccent: '#3a8574',     // Synthi teal accent
  infoHoverBg: '#101118',    // Synthi bg-panel
  
  // General - Synthi theme colors
  border: '#1a1b24',         // Synthi border-subtle
  borderMedium: '#2a2b38',   // Synthi border-medium
  panelBg: '#0d0e14',        // Synthi bg-card
  headerBg: '#08090d',       // Synthi bg-app
  text: '#f4f5f8',           // Synthi text-primary
  textMuted: '#9ba2b8',      // Synthi text-secondary
  textDim: '#5a6178',        // Synthi text-muted
};

// Severity configuration with Synthi theme colors
const SEVERITY_CONFIG = {
  error: {
    icon: AlertCircle,
    label: 'Error',
    textClass: 'text-[#f4f5f8]',
    iconClass: 'text-[#ff6b6b]',
    bgClass: 'bg-[#1a0f14] border-l-[#ff6b6b]',
    badgeBg: 'bg-[#1a0f14]',
    dotClass: 'bg-[#ff6b6b]',
    hoverBg: 'hover:bg-[#241419]',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    textClass: 'text-[#f4f5f8]',
    iconClass: 'text-[#fbbf24]',
    bgClass: 'bg-[#1a1508] border-l-[#fbbf24]',
    badgeBg: 'bg-[#1a1508]',
    dotClass: 'bg-[#fbbf24]',
    hoverBg: 'hover:bg-[#24200e]',
  },
  info: {
    icon: Info,
    label: 'Info',
    textClass: 'text-[#f4f5f8]',
    iconClass: 'text-[#3a8574]',
    bgClass: 'bg-[#0d0e14] border-l-[#3a8574]',
    badgeBg: 'bg-[#0f1a17]',
    dotClass: 'bg-[#3a8574]',
    hoverBg: 'hover:bg-[#101118]',
  },
  hint: {
    icon: Lightbulb,
    label: 'Hint',
    textClass: 'text-[#f4f5f8]',
    iconClass: 'text-[#4ade80]',
    bgClass: 'bg-[#0d0e14] border-l-[#4ade80]',
    badgeBg: 'bg-[#0f1a14]',
    dotClass: 'bg-[#4ade80]',
    hoverBg: 'hover:bg-[#101118]',
  },
};

// Tier badges - Synthi themed
const TIER_CONFIG = {
  static: {
    label: 'Static',
    className: 'bg-[#1a1b24] text-[#9ba2b8]',
  },
  semantic: {
    label: 'Semantic',
    className: 'bg-[#0f1a17] text-[#3a8574]',
  },
  ai: {
    label: 'AI',
    className: 'bg-[#0f1a17] text-[#3a8574]',
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
        'focus:outline-none focus:ring-1 focus:ring-[#3a8574] focus:ring-inset',
        isSelected && 'ring-1 ring-[#3a8574] ring-inset',
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
          <p className="text-xs text-[#9ba2b8] mt-1 break-words">
            {diagnostic.explanation}
          </p>
        )}
        
        {/* Meta info */}
        <div className="flex items-center gap-2 mt-1 text-xs text-[#5a6178]">
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
            <span className="text-[#3a8574]">
              {Math.round(diagnostic.confidence * 100)}%
            </span>
          )}
        </div>
        
        {/* Cross-file references */}
        {diagnostic.crossFileRefs?.length > 0 && (
          <div className="mt-1 text-xs text-[#5a6178]">
            <span className="text-[#9ba2b8]">Related: </span>
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
                className="text-[#3a8574] hover:text-[#4aba9a] hover:underline ml-1"
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
    <div className="border-b border-[#1a1b24] last:border-b-0">
      {/* File header */}
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-[#101118] text-left transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-[#5a6178]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[#5a6178]" />
        )}
        
        <FileCode className="h-4 w-4 text-[#9ba2b8]" />
        <span className="text-sm text-[#f4f5f8] truncate flex-1">{filePath}</span>
        
        {/* Counts */}
        <div className="flex items-center gap-1.5">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="w-5 h-5 rounded bg-[#1a0f14] flex items-center justify-center text-[#ff6b6b] font-medium">
                {errorCount}
              </span>
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="w-5 h-5 rounded bg-[#1a1508] flex items-center justify-center text-[#fbbf24] font-medium">
                {warningCount}
              </span>
            </span>
          )}
        </div>
      </button>
      
      {/* Diagnostics list */}
      {isExpanded && (
        <div className="bg-[#0d0e14]">
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
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1a1b24] bg-[#08090d]">
      <Filter className="h-3.5 w-3.5 text-[#5a6178]" />
      
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
                : 'bg-transparent hover:bg-[#1a1b24] text-[#5a6178]',
            )}
          >
            <span className={cn('w-2 h-2 rounded-full', config.dotClass)} />
            <span>{count}</span>
          </button>
        );
      })}
      
      {/* Tier filters */}
      <div className="border-l border-[#1a1b24] pl-2 ml-1">
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
                  : 'bg-transparent hover:bg-[#1a1b24] text-[#5a6178]',
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
      'flex flex-col bg-[#0d0e14] border border-[#1a1b24] rounded-md overflow-hidden',
      className,
    )}>
      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onFilterChange={handleFilterChange}
        summary={summary}
      />
      
      {/* Tier progress indicators */}
      {isAnalyzing && (
        <div className="flex items-center gap-2 px-3 py-1 bg-[#08090d] border-b border-[#1a1b24] text-xs">
          {Object.entries(tierStatus).map(([tier, status]) => {
            const config = TIER_CONFIG[tier];
            if (!config) return null;
            
            return (
              <span key={tier} className="flex items-center gap-1 text-[#9ba2b8]">
                {status.status === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-[#3a8574]" />
                ) : status.status === 'completed' ? (
                  <span className="w-2 h-2 rounded-full bg-[#4ade80]" />
                ) : status.status === 'error' ? (
                  <span className="w-2 h-2 rounded-full bg-[#ff6b6b]" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-[#5a6178]" />
                )}
                {config.label}
                {status.elapsed > 0 && (
                  <span className="text-[#5a6178]">({Math.round(status.elapsed)}ms)</span>
                )}
              </span>
            );
          })}
        </div>
      )}
      
      {/* Diagnostics list */}
      <div className="flex-1 overflow-auto">
        {filteredDiagnostics.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-[#5a6178]">
            {diagnostics.length === 0 ? (
              <>
                <AlertCircle className="h-8 w-8 mb-2 text-[#4ade80]/50" />
                <p className="text-sm text-[#f4f5f8]">No problems detected</p>
                <p className="text-xs text-[#5a6178] mt-1">Your code looks good!</p>
              </>
            ) : (
              <>
                <Filter className="h-8 w-8 mb-2" />
                <p className="text-sm text-[#f4f5f8]">No problems match filters</p>
                <p className="text-xs text-[#5a6178] mt-1">Adjust filters to see results</p>
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
