'use client';

/**
 * Synthi Extension System - Extension Panel Component
 * PHASE F: User-Facing Integration
 * 
 * Shows users:
 * - List of installed extensions with status
 * - Recent errors and issues
 * - Controls to enable/disable/uninstall
 * - Health indicators
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ExtensionState, getStateDescription } from '../extensions/core/ExtensionState.js';

/**
 * Status badge colors
 */
const STATUS_COLORS = {
  [ExtensionState.ACTIVE]: 'var(--accent-success)',
  [ExtensionState.INSTALLED]: 'var(--text-muted)',
  [ExtensionState.LOADED]: 'var(--brand-stop-4)',
  [ExtensionState.ACTIVATING]: 'var(--accent-warning)',
  [ExtensionState.SUSPENDED]: 'var(--accent-warning)',
  [ExtensionState.CRASHED]: 'var(--accent-danger)',
  [ExtensionState.QUARANTINED]: 'var(--accent-danger)',
  [ExtensionState.DISABLED]: 'var(--text-muted)'
};

const STATUS_ICONS = {
  [ExtensionState.ACTIVE]: '✓',
  [ExtensionState.INSTALLED]: '◯',
  [ExtensionState.LOADED]: '○',
  [ExtensionState.ACTIVATING]: '⟳',
  [ExtensionState.SUSPENDED]: '⏸',
  [ExtensionState.CRASHED]: '✗',
  [ExtensionState.QUARANTINED]: '⚠',
  [ExtensionState.DISABLED]: '◯'
};

/**
 * Extension Status Badge
 */
function StatusBadge({ state }) {
  const color = STATUS_COLORS[state] || 'var(--text-muted)';
  const icon = STATUS_ICONS[state] || '?';
  
  return (
    <span 
      className="vt-workflow-chip text-xs"
      style={{ '--chip-color': color }}
      title={getStateDescription(state)}
    >
      <span className="mr-1">{icon}</span>
      {getStateDescription(state)}
    </span>
  );
}

/**
 * Extension List Item
 */
function ExtensionItem({ extension, onEnable, onDisable, onUninstall, onRestart, isExpanded, onToggle }) {
  const isHealthy = extension.state === ExtensionState.ACTIVE;
  const isQuarantined = extension.state === ExtensionState.QUARANTINED;
  const isDisabled = extension.state === ExtensionState.DISABLED;
  const hasCrashes = extension.crashCount > 0;

  return (
    <div className="vt-workflow-card mb-2 overflow-hidden">
      {/* Header - clickable */}
      <div 
        className="vt-command-item flex cursor-pointer items-center justify-between rounded-none p-3"
        onClick={onToggle}
      >
        <div className="flex items-center space-x-3">
          {/* Extension Icon */}
          <div className="vt-agent-card flex h-8 w-8 items-center justify-center text-lg">
            {extension.icon || '🧩'}
          </div>
          
          {/* Extension Info */}
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-medium text-[var(--text-primary)]">{extension.name}</span>
              <span className="text-xs text-[var(--text-muted)]">v{extension.version}</span>
            </div>
            <div className="text-xs text-[var(--text-muted)]">{extension.publisher || 'Unknown Publisher'}</div>
          </div>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* Warning indicators */}
          {hasCrashes && (
            <span className="vt-workflow-chip text-sm" style={{ '--chip-color': 'var(--accent-warning)' }} title={`${extension.crashCount} crashes`}>
              {extension.crashCount}
            </span>
          )}
          
          {/* Status Badge */}
          <StatusBadge state={extension.state} />
          
          {/* Expand arrow */}
          <span className={`text-[var(--text-muted)] transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
            ▼
          </span>
        </div>
      </div>
      
      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] p-3">
          {/* Description */}
          <p className="mb-3 text-sm text-[var(--text-secondary)]">
            {extension.description || 'No description available.'}
          </p>
          
          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
            <div className="vt-inset-panel p-2">
              <div className="text-[var(--text-muted)]">Activations</div>
              <div className="font-medium text-[var(--text-primary)]">{extension.activationCount || 0}</div>
            </div>
            <div className="vt-inset-panel p-2">
              <div className="text-[var(--text-muted)]">Crashes</div>
              <div className={`font-medium ${hasCrashes ? 'text-[var(--accent-danger)]' : 'text-[var(--text-primary)]'}`}>
                {extension.crashCount || 0}
              </div>
            </div>
            <div className="vt-inset-panel p-2">
              <div className="text-[var(--text-muted)]">Last Active</div>
              <div className="font-medium text-[var(--text-primary)]">
                {extension.lastActiveTime 
                  ? new Date(extension.lastActiveTime).toLocaleTimeString() 
                  : 'Never'}
              </div>
            </div>
          </div>
          
          {/* Quarantine warning */}
          {isQuarantined && (
            <div className="vt-workflow-alert vt-workflow-alert--danger mb-3 p-2 text-sm">
              <div className="font-medium text-[var(--accent-danger)]">Extension Quarantined</div>
              <div className="text-[var(--text-secondary)]">
                This extension was blocked due to repeated failures or security issues.
              </div>
              <div className="mt-1 text-[var(--text-secondary)]">
                Reason: {extension.quarantineReason || 'Unknown'}
              </div>
            </div>
          )}
          
          {/* Actions */}
          <div className="flex space-x-2">
            {isQuarantined || isDisabled ? (
              <button 
                onClick={() => onEnable(extension.id)}
                className="th-focus-ring th-btn-primary px-3 py-1 text-sm"
              >
                Enable
              </button>
            ) : (
              <button 
                onClick={() => onDisable(extension.id)}
                className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-3 py-1 text-sm"
              >
                Disable
              </button>
            )}
            
            {!isQuarantined && !isDisabled && (
              <button 
                onClick={() => onRestart(extension.id)}
                className="th-focus-ring th-btn-active px-3 py-1 text-sm"
              >
                Restart
              </button>
            )}
            
            <button 
              onClick={() => onUninstall(extension.id)}
              className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] border px-3 py-1 text-sm text-[var(--accent-danger)]"
              style={{ borderColor: 'color-mix(in srgb, var(--accent-danger) 28%, transparent)' }}
            >
              Uninstall
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Recent Error Item
 */
function ErrorItem({ error, onDismiss }) {
  const severityColors = {
    error: 'vt-workflow-alert vt-workflow-alert--danger',
    warning: 'vt-workflow-alert',
    info: 'vt-workflow-alert vt-workflow-alert--muted'
  };
  
  return (
    <div className={`mb-2 border-l-4 p-3 ${severityColors[error.severity]}`}>
      <div className="flex justify-between items-start">
        <div className="font-medium text-[var(--text-primary)]">{error.title}</div>
        <button 
          onClick={() => onDismiss(error)}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          ×
        </button>
      </div>
      <div className="mt-1 text-sm text-[var(--text-secondary)]">{error.message}</div>
      {error.suggestion && (
        <div className="mt-2 text-xs text-[var(--text-muted)]">
          {error.suggestion}
        </div>
      )}
      <div className="mt-1 text-xs text-[var(--text-muted)]">
        {new Date(error.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}

/**
 * Extension Panel Component
 */
export function ExtensionPanel({ 
  extensions = [], 
  errors = [],
  onEnableExtension,
  onDisableExtension,
  onRestartExtension,
  onUninstallExtension,
  onDismissError,
  onRefresh
}) {
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState('all'); // all, active, issues
  const [showErrors, setShowErrors] = useState(true);

  const toggleExpanded = useCallback((id) => {
    setExpandedId(prev => prev === id ? null : id);
  }, []);

  // Filter extensions
  const filteredExtensions = extensions.filter(ext => {
    switch (filter) {
      case 'active':
        return ext.state === ExtensionState.ACTIVE;
      case 'issues':
        return ext.state === ExtensionState.CRASHED || 
               ext.state === ExtensionState.QUARANTINED || 
               ext.crashCount > 0;
      default:
        return true;
    }
  });

  // Count by state
  const activeCount = extensions.filter(e => e.state === ExtensionState.ACTIVE).length;
  const issueCount = extensions.filter(e => 
    e.state === ExtensionState.CRASHED || 
    e.state === ExtensionState.QUARANTINED
  ).length;

  return (
    <div className="vt-panel-frame flex h-full flex-col rounded-none border-0">
      {/* Header */}
      <div className="vt-panel-header h-auto min-h-0 flex-col items-stretch p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Extensions</h2>
          <button 
            onClick={onRefresh}
            className="vt-icon-button th-focus-ring h-8 min-w-8"
            title="Refresh"
          >
            ⟳
          </button>
        </div>
        
        {/* Summary */}
        <div className="flex space-x-4 text-sm">
          <span className="text-[var(--accent-success)]">{activeCount} active</span>
          <span className="text-[var(--text-muted)]">{extensions.length} total</span>
          {issueCount > 0 && (
            <span className="text-[var(--accent-danger)]">{issueCount} with issues</span>
          )}
        </div>
        
        {/* Filter tabs */}
        <div className="flex space-x-2 mt-3">
          {['all', 'active', 'issues'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`th-focus-ring rounded-[var(--radius-control)] px-3 py-1 text-sm ${
                filter === f 
                  ? 'th-btn-active'
                  : 'th-btn-ghost'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Recent Errors Section */}
      {errors.length > 0 && (
        <div className="border-b border-[var(--border-subtle)]">
          <div 
            className="vt-command-item flex cursor-pointer items-center justify-between rounded-none p-3"
            onClick={() => setShowErrors(!showErrors)}
          >
            <div className="flex items-center space-x-2">
              <span className="text-[var(--accent-danger)]">!</span>
              <span className="font-medium text-[var(--text-primary)]">Recent Issues ({errors.length})</span>
            </div>
            <span className={`transform transition-transform ${showErrors ? 'rotate-180' : ''}`}>
              ▼
            </span>
          </div>
          
          {showErrors && (
            <div className="p-3 pt-0 max-h-48 overflow-y-auto">
              {errors.map((error, index) => (
                <ErrorItem 
                  key={`${error.extensionId}-${error.timestamp}-${index}`}
                  error={error}
                  onDismiss={onDismissError}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Extension List */}
      <div className="flex-1 overflow-y-auto p-3">
        {filteredExtensions.length === 0 ? (
          <div className="vt-empty-state py-8 text-center">
            {filter !== 'all' 
              ? 'No extensions match this filter.' 
              : 'No extensions installed.'}
          </div>
        ) : (
          filteredExtensions.map(ext => (
            <ExtensionItem
              key={ext.id}
              extension={ext}
              isExpanded={expandedId === ext.id}
              onToggle={() => toggleExpanded(ext.id)}
              onEnable={onEnableExtension}
              onDisable={onDisableExtension}
              onRestart={onRestartExtension}
              onUninstall={onUninstallExtension}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--border-subtle)] p-3 text-xs text-[var(--text-muted)]">
        Extension system v1.0 • {extensions.length} extensions loaded
      </div>
    </div>
  );
}

/**
 * Mini status indicator for menubar/statusbar
 */
export function ExtensionStatusIndicator({ extensions = [], errors = [], onClick }) {
  const activeCount = extensions.filter(e => e.state === ExtensionState.ACTIVE).length;
  const issueCount = extensions.filter(e => 
    e.state === ExtensionState.CRASHED || 
    e.state === ExtensionState.QUARANTINED
  ).length;
  const hasRecentErrors = errors.some(e => Date.now() - e.timestamp < 60000);

  return (
    <button 
      onClick={onClick}
      className="vt-state-pill th-focus-ring"
      title="Extension Status"
    >
      <span className={hasRecentErrors ? 'text-[var(--accent-danger)]' : 'text-[var(--text-muted)]'}>EXT</span>
      <span className="text-[var(--text-secondary)]">{activeCount}</span>
      {issueCount > 0 && (
        <span className="text-[var(--accent-danger)]">({issueCount})</span>
      )}
    </button>
  );
}

export default ExtensionPanel;
