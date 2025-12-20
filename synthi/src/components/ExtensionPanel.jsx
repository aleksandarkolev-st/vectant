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
import { ExtensionState, getStateDescription } from '../core/ExtensionState.js';

/**
 * Status badge colors
 */
const STATUS_COLORS = {
  [ExtensionState.ACTIVE]: 'bg-green-500',
  [ExtensionState.INSTALLED]: 'bg-gray-400',
  [ExtensionState.LOADED]: 'bg-blue-400',
  [ExtensionState.ACTIVATING]: 'bg-yellow-500 animate-pulse',
  [ExtensionState.SUSPENDED]: 'bg-orange-400',
  [ExtensionState.CRASHED]: 'bg-red-500',
  [ExtensionState.QUARANTINED]: 'bg-red-700',
  [ExtensionState.DISABLED]: 'bg-gray-600'
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
  const colorClass = STATUS_COLORS[state] || 'bg-gray-400';
  const icon = STATUS_ICONS[state] || '?';
  
  return (
    <span 
      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium text-white ${colorClass}`}
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
    <div className="border border-gray-700 rounded-lg mb-2 overflow-hidden">
      {/* Header - clickable */}
      <div 
        className="flex items-center justify-between p-3 bg-gray-800 cursor-pointer hover:bg-gray-750"
        onClick={onToggle}
      >
        <div className="flex items-center space-x-3">
          {/* Extension Icon */}
          <div className="w-8 h-8 bg-gray-700 rounded flex items-center justify-center text-lg">
            {extension.icon || '🧩'}
          </div>
          
          {/* Extension Info */}
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-medium text-white">{extension.name}</span>
              <span className="text-xs text-gray-400">v{extension.version}</span>
            </div>
            <div className="text-xs text-gray-400">{extension.publisher || 'Unknown Publisher'}</div>
          </div>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* Warning indicators */}
          {hasCrashes && (
            <span className="text-yellow-500 text-sm" title={`${extension.crashCount} crashes`}>
              ⚠ {extension.crashCount}
            </span>
          )}
          
          {/* Status Badge */}
          <StatusBadge state={extension.state} />
          
          {/* Expand arrow */}
          <span className={`text-gray-400 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
            ▼
          </span>
        </div>
      </div>
      
      {/* Expanded content */}
      {isExpanded && (
        <div className="p-3 bg-gray-850 border-t border-gray-700">
          {/* Description */}
          <p className="text-sm text-gray-300 mb-3">
            {extension.description || 'No description available.'}
          </p>
          
          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
            <div className="bg-gray-700 p-2 rounded">
              <div className="text-gray-400">Activations</div>
              <div className="text-white font-medium">{extension.activationCount || 0}</div>
            </div>
            <div className="bg-gray-700 p-2 rounded">
              <div className="text-gray-400">Crashes</div>
              <div className={`font-medium ${hasCrashes ? 'text-red-400' : 'text-white'}`}>
                {extension.crashCount || 0}
              </div>
            </div>
            <div className="bg-gray-700 p-2 rounded">
              <div className="text-gray-400">Last Active</div>
              <div className="text-white font-medium">
                {extension.lastActiveTime 
                  ? new Date(extension.lastActiveTime).toLocaleTimeString() 
                  : 'Never'}
              </div>
            </div>
          </div>
          
          {/* Quarantine warning */}
          {isQuarantined && (
            <div className="bg-red-900/30 border border-red-700 rounded p-2 mb-3 text-sm">
              <div className="font-medium text-red-400">⚠ Extension Quarantined</div>
              <div className="text-red-300">
                This extension was blocked due to repeated failures or security issues.
              </div>
              <div className="text-red-300 mt-1">
                Reason: {extension.quarantineReason || 'Unknown'}
              </div>
            </div>
          )}
          
          {/* Actions */}
          <div className="flex space-x-2">
            {isQuarantined || isDisabled ? (
              <button 
                onClick={() => onEnable(extension.id)}
                className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded"
              >
                Enable
              </button>
            ) : (
              <button 
                onClick={() => onDisable(extension.id)}
                className="px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded"
              >
                Disable
              </button>
            )}
            
            {!isQuarantined && !isDisabled && (
              <button 
                onClick={() => onRestart(extension.id)}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded"
              >
                Restart
              </button>
            )}
            
            <button 
              onClick={() => onUninstall(extension.id)}
              className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-sm rounded"
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
    error: 'border-red-500 bg-red-900/20',
    warning: 'border-yellow-500 bg-yellow-900/20',
    info: 'border-blue-500 bg-blue-900/20'
  };
  
  return (
    <div className={`border-l-4 rounded p-3 mb-2 ${severityColors[error.severity]}`}>
      <div className="flex justify-between items-start">
        <div className="font-medium text-white">{error.title}</div>
        <button 
          onClick={() => onDismiss(error)}
          className="text-gray-400 hover:text-white"
        >
          ×
        </button>
      </div>
      <div className="text-sm text-gray-300 mt-1">{error.message}</div>
      {error.suggestion && (
        <div className="text-xs text-gray-400 mt-2">
          💡 {error.suggestion}
        </div>
      )}
      <div className="text-xs text-gray-500 mt-1">
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
    <div className="h-full flex flex-col bg-gray-900 text-white">
      {/* Header */}
      <div className="p-4 border-b border-gray-700">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold">Extensions</h2>
          <button 
            onClick={onRefresh}
            className="text-gray-400 hover:text-white p-1"
            title="Refresh"
          >
            ⟳
          </button>
        </div>
        
        {/* Summary */}
        <div className="flex space-x-4 text-sm">
          <span className="text-green-400">{activeCount} active</span>
          <span className="text-gray-400">{extensions.length} total</span>
          {issueCount > 0 && (
            <span className="text-red-400">{issueCount} with issues</span>
          )}
        </div>
        
        {/* Filter tabs */}
        <div className="flex space-x-2 mt-3">
          {['all', 'active', 'issues'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-sm rounded ${
                filter === f 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Recent Errors Section */}
      {errors.length > 0 && (
        <div className="border-b border-gray-700">
          <div 
            className="p-3 flex justify-between items-center cursor-pointer hover:bg-gray-800"
            onClick={() => setShowErrors(!showErrors)}
          >
            <div className="flex items-center space-x-2">
              <span className="text-red-400">⚠</span>
              <span className="font-medium">Recent Issues ({errors.length})</span>
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
          <div className="text-center text-gray-400 py-8">
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
      <div className="p-3 border-t border-gray-700 text-xs text-gray-500">
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
      className="flex items-center space-x-1 px-2 py-1 text-xs hover:bg-gray-700 rounded"
      title="Extension Status"
    >
      <span className={hasRecentErrors ? 'text-red-400' : 'text-gray-400'}>🧩</span>
      <span className="text-gray-300">{activeCount}</span>
      {issueCount > 0 && (
        <span className="text-red-400">({issueCount}⚠)</span>
      )}
    </button>
  );
}

export default ExtensionPanel;
