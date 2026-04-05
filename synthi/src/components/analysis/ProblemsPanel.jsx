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

import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { Virtuoso } from 'react-virtuoso';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Copy,
  FileCode,
  Filter,
  FolderOpen,
  Info,
  Lightbulb,
  Loader2,
  MoreVertical,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  SortAsc,
  SortDesc,
  Sparkles,
  X,
  Eye,
  EyeOff,
  Download,
  Trash2,
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
    description: 'Syntax and compile-time errors',
  },
  semantic: {
    label: 'Semantic',
    className: 'bg-[#0f1a17] text-[#3a8574]',
    description: 'Type checking and semantic analysis',
  },
  ai: {
    label: 'AI',
    className: 'bg-[#0f1a17] text-[#3a8574]',
    icon: Sparkles,
    description: 'AI-powered code insights',
  },
};

// Sort options
const SORT_OPTIONS = {
  severity: { label: 'Severity', description: 'Errors first, then warnings' },
  file: { label: 'File', description: 'Group by file path' },
  line: { label: 'Line Number', description: 'By position in file' },
  tier: { label: 'Analysis Tier', description: 'Static → Semantic → AI' },
  recent: { label: 'Recent', description: 'Most recently detected' },
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
function FileGroup({ filePath, diagnostics, onNavigate, isExpanded, onToggle, totalInFile }) {
  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;
  const infoCount = diagnostics.filter(d => d.severity === 'info').length;
  const hintCount = diagnostics.filter(d => d.severity === 'hint').length;
  
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
        
        {/* Total count badge */}
        <span className="text-xs text-[#5a6178] mr-2">
          {diagnostics.length}{totalInFile && totalInFile !== diagnostics.length ? ` / ${totalInFile}` : ''}
        </span>
        
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
          {infoCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="w-5 h-5 rounded bg-[#0f1a17] flex items-center justify-center text-[#3a8574] font-medium">
                {infoCount}
              </span>
            </span>
          )}
          {hintCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="w-5 h-5 rounded bg-[#0f1a14] flex items-center justify-center text-[#4ade80] font-medium">
                {hintCount}
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
 * Search input component
 */
function SearchInput({ value, onChange, placeholder = "Filter problems..." }) {
  const inputRef = useRef(null);
  
  return (
    <div className="relative flex-1 min-w-0">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#5a6178]" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full pl-7 pr-7 py-1 text-xs rounded bg-[#0d0e14] border border-[#1a1b24]",
          "text-[#f4f5f8] placeholder-[#5a6178]",
          "focus:outline-none focus:border-[#3a8574] focus:ring-1 focus:ring-[#3a8574]/30",
          "transition-colors"
        )}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[#5a6178] hover:text-[#9ba2b8]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Dropdown menu component
 */
function DropdownMenu({ trigger, children, align = 'right' }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);
  
  return (
    <div className="relative" ref={menuRef}>
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      {isOpen && (
        <div className={cn(
          "absolute top-full mt-1 z-50 min-w-[180px] py-1",
          "bg-[#0d0e14] border border-[#2a2b38] rounded-md shadow-xl",
          align === 'right' ? 'right-0' : 'left-0'
        )}>
          {React.Children.map(children, child => 
            React.isValidElement(child) 
              ? React.cloneElement(child, { onClose: () => setIsOpen(false) })
              : child
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, description, onClick, onClose, isActive, danger }) {
  return (
    <button
      onClick={() => { onClick?.(); onClose?.(); }}
      className={cn(
        "w-full px-3 py-1.5 flex items-center gap-2 text-left text-xs transition-colors",
        danger 
          ? "text-[#ff6b6b] hover:bg-[#1a0f14]"
          : isActive
            ? "bg-[#0f1a17] text-[#3a8574]"
            : "text-[#9ba2b8] hover:bg-[#101118] hover:text-[#f4f5f8]"
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      <div className="flex-1">
        <div>{label}</div>
        {description && <div className="text-[10px] text-[#5a6178]">{description}</div>}
      </div>
      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-[#3a8574]" />}
    </button>
  );
}

function MenuDivider() {
  return <div className="my-1 border-t border-[#1a1b24]" />;
}

/**
 * Filter bar for diagnostics - with live counts based on filtered results
 */
function FilterBar({ 
  filters, 
  onFilterChange, 
  filteredCounts,
  totalCounts,
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
  onExpandAll,
  onCollapseAll,
  onCopyAll,
  onClearAll,
  showOptions = true,
}) {
  return (
    <div className="border-b border-[#1a1b24] bg-[#08090d]">
      {/* Main filter row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Filter className="h-3.5 w-3.5 text-[#5a6178] flex-shrink-0" />
        
        {/* Severity filters with FILTERED counts */}
        {Object.entries(SEVERITY_CONFIG).map(([severity, config]) => {
          const filteredCount = filteredCounts[severity] || 0;
          const totalCount = totalCounts[severity] || 0;
          const isActive = filters.severities.includes(severity);
          
          return (
            <button
              key={severity}
              onClick={() => onFilterChange('severity', severity)}
              title={`${config.label}: ${filteredCount} of ${totalCount} shown`}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors',
                isActive
                  ? config.badgeBg + ' ' + config.textClass
                  : 'bg-transparent hover:bg-[#1a1b24] text-[#5a6178]',
              )}
            >
              <span className={cn('w-2 h-2 rounded-full', isActive ? config.dotClass : 'bg-[#5a6178]')} />
              <span className={cn(
                'font-medium tabular-nums',
                !isActive && 'opacity-50'
              )}>
                {filteredCount}
              </span>
              {/* Show total if different from filtered and filter is active */}
              {isActive && filteredCount !== totalCount && (
                <span className="text-[#5a6178] text-[10px]">/{totalCount}</span>
              )}
            </button>
          );
        })}
        
        {/* Separator */}
        <div className="h-4 border-l border-[#1a1b24]" />
        
        {/* Tier filters */}
        {Object.entries(TIER_CONFIG).map(([tier, config]) => {
          const isActive = filters.tiers.includes(tier);
          const TierIcon = config.icon;
          
          return (
            <button
              key={tier}
              onClick={() => onFilterChange('tier', tier)}
              title={config.description}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors flex items-center gap-1',
                isActive
                  ? config.className
                  : 'bg-transparent hover:bg-[#1a1b24] text-[#5a6178]',
              )}
            >
              {TierIcon && <TierIcon className="h-3 w-3" />}
              {config.label}
            </button>
          );
        })}
        
        {/* Spacer */}
        <div className="flex-1" />
        
        {/* Options menu */}
        {showOptions && (
          <DropdownMenu
            trigger={
              <button className="p-1 rounded hover:bg-[#1a1b24] text-[#5a6178] hover:text-[#9ba2b8] transition-colors">
                <MoreVertical className="h-4 w-4" />
              </button>
            }
          >
            <MenuItem icon={ChevronsDown} label="Expand All" onClick={onExpandAll} />
            <MenuItem icon={ChevronsUp} label="Collapse All" onClick={onCollapseAll} />
            <MenuDivider />
            <MenuItem icon={Copy} label="Copy All Problems" onClick={onCopyAll} />
            <MenuItem icon={Download} label="Export as JSON" onClick={() => {
              // Export functionality
              const blob = new Blob([JSON.stringify(filteredCounts, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'problems.json';
              a.click();
              URL.revokeObjectURL(url);
            }} />
            <MenuDivider />
            <MenuItem icon={Trash2} label="Clear All" description="Dismiss all problems" onClick={onClearAll} danger />
          </DropdownMenu>
        )}
      </div>
      
      {/* Search and sort row */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-[#1a1b24]/50">
        <SearchInput
          value={searchQuery}
          onChange={onSearchChange}
          placeholder="Filter by message, code, or file..."
        />
        
        {/* Sort dropdown */}
        <DropdownMenu
          trigger={
            <button className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-[#0d0e14] border border-[#1a1b24] text-[#9ba2b8] hover:border-[#2a2b38] hover:text-[#f4f5f8] transition-colors">
              <SlidersHorizontal className="h-3 w-3" />
              <span>Sort</span>
              <ChevronDown className="h-3 w-3" />
            </button>
          }
        >
          {Object.entries(SORT_OPTIONS).map(([key, option]) => (
            <MenuItem
              key={key}
              label={option.label}
              description={option.description}
              isActive={sortBy === key}
              onClick={() => onSortChange(key)}
            />
          ))}
        </DropdownMenu>
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
  onClearDiagnostics,
  className,
}) {
  // Filter state
  const [filters, setFilters] = useState({
    severities: ['error', 'warning', 'info', 'hint'],
    tiers: ['static', 'semantic', 'ai'],
  });
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  
  // Sort state
  const [sortBy, setSortBy] = useState('severity');
  
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
  
  // Calculate total counts (unfiltered)
  const totalCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0, hint: 0, total: 0 };
    for (const d of diagnostics) {
      if (d.severity && counts[d.severity] !== undefined) {
        counts[d.severity]++;
      }
      counts.total++;
    }
    return counts;
  }, [diagnostics]);
  
  // Filter diagnostics by severity, tier, and search query
  const filteredDiagnostics = useMemo(() => {
    return diagnostics.filter(d => {
      // Severity filter
      if (!filters.severities.includes(d.severity)) return false;
      
      // Tier filter
      if (!filters.tiers.includes(d.tier)) return false;
      
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const message = (d.message || '').toLowerCase();
        const code = (d.code || '').toLowerCase();
        const file = (d.filePath || '').toLowerCase();
        const explanation = (d.explanation || '').toLowerCase();
        
        if (!message.includes(query) && 
            !code.includes(query) && 
            !file.includes(query) &&
            !explanation.includes(query)) {
          return false;
        }
      }
      
      return true;
    });
  }, [diagnostics, filters, searchQuery]);
  
  // Calculate filtered counts (what's currently visible)
  const filteredCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0, hint: 0, total: 0 };
    for (const d of filteredDiagnostics) {
      if (d.severity && counts[d.severity] !== undefined) {
        counts[d.severity]++;
      }
      counts.total++;
    }
    return counts;
  }, [filteredDiagnostics]);
  
  // Sort diagnostics
  const sortedDiagnostics = useMemo(() => {
    const sorted = [...filteredDiagnostics];
    
    const severityOrder = { error: 0, warning: 1, info: 2, hint: 3 };
    const tierOrder = { static: 0, semantic: 1, ai: 2 };
    
    switch (sortBy) {
      case 'severity':
        sorted.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));
        break;
      case 'file':
        sorted.sort((a, b) => (a.filePath || '').localeCompare(b.filePath || ''));
        break;
      case 'line':
        sorted.sort((a, b) => {
          const fileCompare = (a.filePath || '').localeCompare(b.filePath || '');
          if (fileCompare !== 0) return fileCompare;
          return (a.location?.line ?? 0) - (b.location?.line ?? 0);
        });
        break;
      case 'tier':
        sorted.sort((a, b) => (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3));
        break;
      case 'recent':
        sorted.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        break;
    }
    
    return sorted;
  }, [filteredDiagnostics, sortBy]);
  
  // Group by file
  const groupedDiagnostics = useMemo(() => {
    const groups = new Map();
    for (const diagnostic of sortedDiagnostics) {
      const path = diagnostic.filePath || filePath;
      if (!groups.has(path)) {
        groups.set(path, []);
      }
      groups.get(path).push(diagnostic);
    }
    return groups;
  }, [sortedDiagnostics, filePath]);
  
  // Total diagnostics per file (unfiltered) for showing "x of y"
  const totalDiagnosticsPerFile = useMemo(() => {
    const totals = new Map();
    for (const diagnostic of diagnostics) {
      const path = diagnostic.filePath || filePath;
      totals.set(path, (totals.get(path) || 0) + 1);
    }
    return totals;
  }, [diagnostics, filePath]);
  
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
  
  // Expand all files
  const expandAll = useCallback(() => {
    const allFiles = new Set();
    diagnostics.forEach(d => {
      if (d.filePath) allFiles.add(d.filePath);
    });
    allFiles.add(filePath);
    setExpandedFiles(allFiles);
  }, [diagnostics, filePath]);
  
  // Collapse all files
  const collapseAll = useCallback(() => {
    setExpandedFiles(new Set());
  }, []);
  
  // Copy all problems to clipboard
  const copyAllProblems = useCallback(() => {
    const text = sortedDiagnostics.map(d => {
      const loc = d.location ? `${d.filePath || filePath}:${(d.location.line ?? 0) + 1}:${(d.location.column ?? 0) + 1}` : d.filePath || filePath;
      return `[${d.severity?.toUpperCase()}] ${loc} - ${d.message}${d.code ? ` (${d.code})` : ''}`;
    }).join('\n');
    navigator.clipboard?.writeText(text);
  }, [sortedDiagnostics, filePath]);
  
  return (
    <div className={cn(
      'flex flex-col bg-[#0d0e14] border border-[#1a1b24] rounded-md overflow-hidden',
      className,
    )}>
      
      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onFilterChange={handleFilterChange}
        filteredCounts={filteredCounts}
        totalCounts={totalCounts}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sortBy={sortBy}
        onSortChange={setSortBy}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onCopyAll={copyAllProblems}
        onClearAll={onClearDiagnostics}
      />
      
      {/* Tier progress indicators */}
      {isAnalyzing && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[#08090d] border-b border-[#1a1b24] text-xs">
          <Loader2 className="h-3 w-3 animate-spin text-[#3a8574]" />
          <span className="text-[#9ba2b8]">Analyzing...</span>
          {Object.entries(tierStatus).map(([tier, status]) => {
            const config = TIER_CONFIG[tier];
            if (!config) return null;
            
            return (
              <span key={tier} className="flex items-center gap-1 text-[#5a6178]">
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
                  <span className="text-[#3a3b48]">({Math.round(status.elapsed)}ms)</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    
      
      {/* Diagnostics list */}
      <div className="flex-1 overflow-auto">
        {sortedDiagnostics.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-[#5a6178]">
            {diagnostics.length === 0 ? (
              <>
                <AlertCircle className="h-8 w-8 mb-2 text-[#4ade80]/50" />
                <p className="text-sm text-[#f4f5f8]">No problems detected</p>
                <p className="text-xs text-[#5a6178] mt-1">Your code looks good!</p>
              </>
            ) : searchQuery ? (
              <>
                <Search className="h-8 w-8 mb-2" />
                <p className="text-sm text-[#f4f5f8]">No matching problems</p>
                <p className="text-xs text-[#5a6178] mt-1">Try a different search term</p>
                <button
                  onClick={() => setSearchQuery('')}
                  className="mt-2 px-3 py-1 text-xs bg-[#1a1b24] hover:bg-[#2a2b38] text-[#9ba2b8] rounded transition-colors"
                >
                  Clear search
                </button>
              </>
            ) : (
              <>
                <Filter className="h-8 w-8 mb-2" />
                <p className="text-sm text-[#f4f5f8]">No problems match filters</p>
                <p className="text-xs text-[#5a6178] mt-1">Adjust filters to see results</p>
                <button
                  onClick={() => setFilters({
                    severities: ['error', 'warning', 'info', 'hint'],
                    tiers: ['static', 'semantic', 'ai'],
                  })}
                  className="mt-2 px-3 py-1 text-xs bg-[#1a1b24] hover:bg-[#2a2b38] text-[#9ba2b8] rounded transition-colors"
                >
                  Reset filters
                </button>
              </>
            )}
          </div>
        ) : (
          /* PERF: Virtualized file-group list — only renders visible groups,
             preventing thousands of DOM nodes from accumulating in large
             workspaces with many diagnostics. */
          <Virtuoso
            style={{ height: '100%' }}
            data={Array.from(groupedDiagnostics.entries())}
            overscan={200}
            itemContent={(index, [path, fileDiagnostics]) => (
              <FileGroup
                key={path}
                filePath={path}
                diagnostics={fileDiagnostics}
                totalInFile={totalDiagnosticsPerFile.get(path)}
                onNavigate={onNavigate}
                isExpanded={expandedFiles.has(path)}
                onToggle={() => toggleFile(path)}
              />
            )}
          />
        )}
      </div>
      
      {/* Footer with keyboard shortcuts hint */}
      <div className="px-3 py-1.5 bg-[#08090d] border-t border-[#1a1b24] text-[10px] text-[#5a6178] flex items-center justify-between">
        <span>Click to navigate • Double-click for quick fix</span>
        <span className="flex items-center gap-2">
          <kbd className="px-1 py-0.5 bg-[#1a1b24] rounded text-[9px]">F8</kbd>
          <span>Next problem</span>
        </span>
      </div>
    </div>
  );
}

export default ProblemsPanel;
