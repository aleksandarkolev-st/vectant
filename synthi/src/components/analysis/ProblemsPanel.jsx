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
import { useDispatch } from 'react-redux';
import { Virtuoso } from 'react-virtuoso';
import { addRule, enqueueToast, RuleAction } from '@/redux/healingSlice';
import { createRule, TargetVocabulary, ruleToSentence } from '@/lib/healing/ruleEngine';
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

// Severity configuration with Synthi theme colors
const SEVERITY_CONFIG = {
  error: {
    icon: AlertCircle,
    label: 'Error',
    textClass: 'text-[var(--text-primary)]',
    iconClass: 'vt-diag-icon vt-diag-row--error',
    bgClass: 'vt-diag-row vt-diag-row--error',
    badgeBg: 'vt-diag-badge vt-diag-badge--error',
    dotClass: 'vt-diag-dot vt-diag-dot--error',
    hoverBg: '',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    textClass: 'text-[var(--text-primary)]',
    iconClass: 'vt-diag-icon vt-diag-row--warning',
    bgClass: 'vt-diag-row vt-diag-row--warning',
    badgeBg: 'vt-diag-badge vt-diag-badge--warning',
    dotClass: 'vt-diag-dot vt-diag-dot--warning',
    hoverBg: '',
  },
  info: {
    icon: Info,
    label: 'Info',
    textClass: 'text-[var(--text-primary)]',
    iconClass: 'vt-diag-icon vt-diag-row--info',
    bgClass: 'vt-diag-row vt-diag-row--info',
    badgeBg: 'vt-diag-badge vt-diag-badge--info',
    dotClass: 'vt-diag-dot vt-diag-dot--info',
    hoverBg: '',
  },
  hint: {
    icon: Lightbulb,
    label: 'Hint',
    textClass: 'text-[var(--text-primary)]',
    iconClass: 'vt-diag-icon vt-diag-row--hint',
    bgClass: 'vt-diag-row vt-diag-row--hint',
    badgeBg: 'vt-diag-badge vt-diag-badge--hint',
    dotClass: 'vt-diag-dot vt-diag-dot--hint',
    hoverBg: '',
  },
};

// Tier badges - Synthi themed
const TIER_CONFIG = {
  static: {
    label: 'Static',
    className: 'vt-state-pill',
    description: 'Syntax and compile-time errors',
  },
  semantic: {
    label: 'Semantic',
    className: 'vt-state-pill',
    description: 'Type checking and semantic analysis',
  },
  ai: {
    label: 'AI',
    className: 'vt-state-pill',
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
// Best-effort map diagnostic.category → TargetVocabulary key so the new
// rule shows up as a friendly sentence in the rules panel.
const CATEGORY_TO_TARGET_NAME = {
  missing_semicolon: 'missing_semicolons',
  missing_colon:     'missing_colons',
  missing_bracket:   'missing_brackets',
  unused_import:     'unused_imports',
  missing_import:    'missing_imports',
  duplicate_import:  'missing_imports',
  missing_include:   'missing_imports',
  unused_variable:   'unused_variables',
  type_mismatch:     'type_errors',
  trailing_whitespace: 'style_warnings',
  missing_newline_eof: 'style_warnings',
  trailing_comma:    'style_warnings',
  none_comparison:   'style_warnings',
};

function diagnosticToRuleTarget(diag) {
  const cat = diag?.category;
  if (cat && CATEGORY_TO_TARGET_NAME[cat]) {
    return { kind: 'target', name: CATEGORY_TO_TARGET_NAME[cat] };
  }
  if (cat && TargetVocabulary[cat]) {
    return { kind: 'target', name: cat };
  }
  const sev = (diag?.severity || 'error').toLowerCase();
  if (sev === 'warning') return { kind: 'target', name: 'any_warning' };
  if (sev === 'info' || sev === 'hint') return { kind: 'target', name: 'any_issue' };
  return { kind: 'target', name: 'any_error' };
}

function DiagnosticItem({ diagnostic, onNavigate, isSelected, filePath }) {
  const dispatch = useDispatch();
  const severityConfig = SEVERITY_CONFIG[diagnostic.severity] || SEVERITY_CONFIG.info;
  const tierConfig = TIER_CONFIG[diagnostic.tier] || TIER_CONFIG.static;
  const SeverityIcon = severityConfig.icon;
  const TierIcon = tierConfig.icon;

  // Context menu state — position is null when closed
  const [ctxMenu, setCtxMenu] = useState(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => closeCtxMenu();
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctxMenu, closeCtxMenu]);

  const handleCreateRule = useCallback((action) => {
    const target = diagnosticToRuleTarget(diagnostic);
    const rule = {
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action,
      target,
      scope: { kind: 'scope', name: 'any_file' },
      disabled: false,
    };
    dispatch(addRule(rule));
    dispatch(enqueueToast({
      type: 'healing-undo',
      message: `Rule added: ${ruleToSentence(rule)}`,
      duration: 4000,
    }));
    closeCtxMenu();
  }, [diagnostic, dispatch, closeCtxMenu]);

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

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);
  
  return (
    <>
    <button
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        'w-full text-left px-3 py-2 flex items-start gap-2 transition-colors',
        'border-l-2',
        severityConfig.bgClass,
        severityConfig.hoverBg,
        'focus:outline-none focus:ring-1 focus:ring-[var(--attention-purple)] focus:ring-inset',
        isSelected && 'ring-1 ring-[var(--attention-purple)] ring-inset',
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
          <p className="mt-1 break-words text-xs text-[var(--text-muted)]">
            {diagnostic.explanation}
          </p>
        )}
        
        {/* Meta info */}
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-muted)]">
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
            <span className="text-[var(--accent-secondary)]">
              {Math.round(diagnostic.confidence * 100)}%
            </span>
          )}
        </div>
        
        {/* Cross-file references */}
        {diagnostic.crossFileRefs?.length > 0 && (
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            <span className="text-[var(--text-secondary)]">Related: </span>
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
                className="ml-1 text-[var(--accent-secondary)] hover:underline"
              >
                {ref.filePath?.split('/').pop() || ref.file?.split('/').pop()}:{(ref.location?.line ?? ref.line ?? 0) + 1}
              </button>
            ))}
          </div>
        )}
        
        {/* Quick fixes available indicator */}
        {diagnostic.fixes?.length > 0 && (
          <div className="mt-1 flex items-center gap-1 text-xs text-[var(--accent-success)]">
            <Lightbulb className="h-3 w-3" />
            {diagnostic.fixes.length} quick fix{diagnostic.fixes.length > 1 ? 'es' : ''} available
          </div>
        )}
      </div>
    </button>

    {/* Right-click context menu: create an ignore/auto-apply rule for
        this diagnostic's category in one click.  Sibling of the button
        so the HTML stays spec-compliant (no nested interactives). */}
    {ctxMenu && (
      <div
        onClick={(e) => { e.stopPropagation(); }}
        className="vt-command-popover fixed z-[100] min-w-[220px] py-1"
        style={{ left: ctxMenu.x, top: ctxMenu.y }}
      >
        <div className="vt-panel-kicker border-b border-[var(--border-subtle)] px-3 py-1.5">
          Rule for this kind of issue
        </div>
        <button
          onClick={() => handleCreateRule(RuleAction.IGNORE)}
          className="vt-command-item w-full px-3 py-1.5 text-left text-xs"
        >
          Never heal this
        </button>
        <button
          onClick={() => handleCreateRule(RuleAction.AUTO_APPLY)}
          className="vt-command-item w-full px-3 py-1.5 text-left text-xs"
        >
          Always fix this
        </button>
        <button
          onClick={() => handleCreateRule(RuleAction.SUGGEST)}
          className="vt-command-item w-full px-3 py-1.5 text-left text-xs"
        >
          Suggest a fix
        </button>
        <button
          onClick={() => handleCreateRule(RuleAction.AI_ESCALATE)}
          className="vt-command-item w-full px-3 py-1.5 text-left text-xs"
        >
          Ask AI for these
        </button>
      </div>
    )}
    </>
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
    <div className="border-b border-[var(--border-subtle)] last:border-b-0">
      {/* File header */}
      <button
        onClick={onToggle}
        className="vt-command-item w-full px-3 py-2 flex items-center gap-2 text-left"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[var(--text-muted)]" />
        )}
        
        <FileCode className="h-4 w-4 text-[var(--text-muted)]" />
        <span className="truncate flex-1 text-sm text-[var(--text-primary)]">{filePath}</span>
        
        {/* Total count badge */}
        <span className="mr-2 text-xs text-[var(--text-muted)]">
          {diagnostics.length}{totalInFile && totalInFile !== diagnostics.length ? ` / ${totalInFile}` : ''}
        </span>
        
        {/* Counts */}
        <div className="flex items-center gap-1.5">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="vt-diag-badge vt-diag-badge--error">
                {errorCount}
              </span>
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="vt-diag-badge vt-diag-badge--warning">
                {warningCount}
              </span>
            </span>
          )}
          {infoCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="vt-diag-badge vt-diag-badge--info">
                {infoCount}
              </span>
            </span>
          )}
          {hintCount > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <span className="vt-diag-badge vt-diag-badge--hint">
                {hintCount}
              </span>
            </span>
          )}
        </div>
      </button>
      
      {/* Diagnostics list */}
      {isExpanded && (
        <div className="bg-[color-mix(in_srgb,var(--bg-app)_48%,transparent)]">
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
      <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "th-input w-full rounded-[var(--radius-control)] border py-1 pl-7 pr-7 text-xs",
          "transition-colors"
        )}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
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
          "vt-command-popover",
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
          ? "text-[var(--accent-danger)]"
          : isActive
            ? "text-[var(--text-primary)] bg-[color-mix(in_srgb,var(--attention-purple)_12%,transparent)]"
            : "vt-command-item"
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      <div className="flex-1">
        <div>{label}</div>
        {description && <div className="text-[10px] text-[var(--text-muted)]">{description}</div>}
      </div>
      {isActive && <span className="vt-state-dot" />}
    </button>
  );
}

function MenuDivider() {
  return <div className="my-1 border-t border-[var(--border-subtle)]" />;
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
    <div className="border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-panel)_76%,var(--bg-app)_24%)]">
      {/* Main filter row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Filter className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        
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
                'vt-diag-filter px-2 py-0.5 text-xs',
                isActive
                  ? `${config.badgeBg} is-active ${config.textClass}`
                  : '',
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', isActive ? config.dotClass : 'bg-[var(--text-dim)]')} />
              <span className={cn(
                'font-medium tabular-nums',
                !isActive && 'opacity-50'
              )}>
                {filteredCount}
              </span>
              {/* Show total if different from filtered and filter is active */}
              {isActive && filteredCount !== totalCount && (
                <span className="text-[10px] text-[var(--text-muted)]">/{totalCount}</span>
              )}
            </button>
          );
        })}
        
        {/* Separator */}
        <div className="h-4 border-l border-[var(--border-subtle)]" />
        
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
                'vt-diag-filter px-2 py-0.5 text-xs',
                isActive
                  ? config.className
                  : '',
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
              <button className="vt-icon-button th-focus-ring h-7 w-7">
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
      <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-1.5">
        <SearchInput
          value={searchQuery}
          onChange={onSearchChange}
          placeholder="Filter by message, code, or file..."
        />
        
        {/* Sort dropdown */}
        <DropdownMenu
          trigger={
            <button className="th-focus-ring th-btn-ghost flex items-center gap-1 rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-2 py-1 text-xs">
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
      'vt-panel-frame flex flex-col overflow-hidden rounded-none border-0',
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
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_62%,transparent)] px-3 py-1.5 text-xs">
          <Loader2 className="h-3 w-3 animate-spin text-[var(--accent-secondary)]" />
          <span className="text-[var(--text-muted)]">Analyzing...</span>
          {Object.entries(tierStatus).map(([tier, status]) => {
            const config = TIER_CONFIG[tier];
            if (!config) return null;
            
            return (
              <span key={tier} className="flex items-center gap-1 text-[var(--text-muted)]">
                {status.status === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-[var(--accent-secondary)]" />
                ) : status.status === 'completed' ? (
                  <span className="h-2 w-2 rounded-full bg-[var(--accent-success)]" />
                ) : status.status === 'error' ? (
                  <span className="h-2 w-2 rounded-full bg-[var(--accent-danger)]" />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-[var(--text-dim)]" />
                )}
                {config.label}
                {status.elapsed > 0 && (
                  <span className="text-[var(--text-dim)]">({Math.round(status.elapsed)}ms)</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    
      
      {/* Diagnostics list */}
      <div className="flex-1 overflow-auto">
        {sortedDiagnostics.length === 0 ? (
          <div className="vt-empty-state m-3 flex flex-col items-center justify-center py-8 text-[var(--text-muted)]">
            {diagnostics.length === 0 ? (
              <>
                <AlertCircle className="mb-2 h-8 w-8 text-[var(--accent-success)] opacity-60" />
                <p className="text-sm text-[var(--text-primary)]">No problems detected</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">The current analysis pass is clean.</p>
              </>
            ) : searchQuery ? (
              <>
                <Search className="h-8 w-8 mb-2" />
                <p className="text-sm text-[var(--text-primary)]">No matching problems</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Try a different search term.</p>
                <button
                  onClick={() => setSearchQuery('')}
                  className="th-focus-ring th-btn-ghost mt-2 rounded-[var(--radius-control)] px-3 py-1 text-xs"
                >
                  Clear search
                </button>
              </>
            ) : (
              <>
                <Filter className="h-8 w-8 mb-2" />
                <p className="text-sm text-[var(--text-primary)]">No problems match filters</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Adjust filters to see results.</p>
                <button
                  onClick={() => setFilters({
                    severities: ['error', 'warning', 'info', 'hint'],
                    tiers: ['static', 'semantic', 'ai'],
                  })}
                  className="th-focus-ring th-btn-ghost mt-2 rounded-[var(--radius-control)] px-3 py-1 text-xs"
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
      <div className="flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] px-3 py-1.5 text-[10px] text-[var(--text-tertiary)]">
        <span>Click to navigate. Double-click for quick fix.</span>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-1 py-0.5 text-[9px] text-[var(--text-secondary)]">
            F8
          </kbd>
          <span>Next problem</span>
        </span>
      </div>
    </div>
  );
}

export default ProblemsPanel;
