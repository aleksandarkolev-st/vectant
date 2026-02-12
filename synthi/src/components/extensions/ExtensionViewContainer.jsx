'use client';

/**
 * ExtensionViewContainer
 *
 * Renders the sidebar panel for an extension-contributed viewContainer.
 * Shows the contributed views (tree views, webview views) with proper headers,
 * collapsible sections, and placeholder content until the extension provides data.
 *
 * Also handles rendering webview panels created at runtime.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown, Box, Loader2, AlertTriangle, Globe, Server } from 'lucide-react';

// ─── Tree view placeholder (until extension provides data) ───
function TreeViewSection({ view, treeData, onRequestData, onExecuteCommand }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="border-b border-[#1a1b24] last:border-b-0">
      {/* Section header */}
      <button
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-[#9ba2b8] uppercase tracking-wider hover:bg-[#0c0d12] transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <ChevronRight className="w-3 h-3 text-[#4a5060]" />
        ) : (
          <ChevronDown className="w-3 h-3 text-[#4a5060]" />
        )}
        {view.name}
      </button>

      {/* Content */}
      {!collapsed && (
        <div className="px-3 pb-2">
          {treeData && treeData.length > 0 ? (
            <div className="space-y-0.5">
              {treeData.map((item, i) => (
                <TreeItem key={item.id || i} item={item} depth={0} onExecuteCommand={onExecuteCommand} />
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[#4a5060] italic py-3 text-center">
              {view.type === 'webview' ? (
                <div className="flex flex-col items-center gap-1.5">
                  <Globe className="w-4 h-4" />
                  <span>Webview loading…</span>
                </div>
              ) : (
                'No items'
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tree item (recursive) ──────────────────────────────────
function TreeItem({ item, depth, onExecuteCommand }) {
  // collapsibleState: 0=None, 1=Collapsed, 2=Expanded (vs code TreeItemCollapsibleState)
  const hasChildren = item.children && item.children.length > 0;
  const isCollapsible = hasChildren || item.collapsibleState === 1 || item.collapsibleState === 2;
  const [expanded, setExpanded] = useState(item.collapsibleState === 2);
  const indent = depth * 16;

  const handleClick = useCallback(() => {
    if (isCollapsible) {
      setExpanded(prev => !prev);
    }
    // If the item has a command, execute it
    if (item.command?.command && onExecuteCommand) {
      onExecuteCommand(item.command.command, item.command.arguments);
    }
  }, [isCollapsible, item.command, onExecuteCommand]);

  // Render icon: supports codicon:xxx, URL paths, and data URIs
  const renderIcon = () => {
    if (!item.iconPath) return null;
    if (typeof item.iconPath === 'string' && item.iconPath.startsWith('codicon:')) {
      const iconId = item.iconPath.slice(8);
      return (
        <span
          className={`codicon codicon-${iconId} shrink-0`}
          style={{ fontSize: '14px', width: '14px', height: '14px', lineHeight: '14px' }}
        />
      );
    }
    return <img src={item.iconPath} alt="" className="w-3.5 h-3.5 shrink-0" />;
  };

  return (
    <>
      <div
        className="flex items-center gap-1 py-0.5 px-1 rounded hover:bg-[#1a1b24] cursor-pointer text-[12px] text-[#e8eaed] transition-colors"
        style={{ paddingLeft: `${indent + 4}px` }}
        onClick={handleClick}
        title={item.tooltip || undefined}
      >
        {isCollapsible ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-[#4a5060] shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-[#4a5060] shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {renderIcon()}
        <span className="truncate">{item.label || item.id}</span>
        {item.description && (
          <span className="text-[#4a5060] text-[10px] truncate ml-1">{item.description}</span>
        )}
      </div>
      {expanded && hasChildren && (
        <div>
          {item.children.map((child, i) => (
            <TreeItem key={child.id || i} item={child} depth={depth + 1} onExecuteCommand={onExecuteCommand} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Webview panel embed ────────────────────────────────────
function WebviewPanelEmbed({ viewId, webviewManager }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !webviewManager) return;

    const instance = webviewManager.webviews?.get(viewId);
    if (instance?.wrapper) {
      instance.wrapper.style.display = 'block';
      instance.wrapper.style.position = 'relative';
      containerRef.current.appendChild(instance.wrapper);
    }

    return () => {
      if (instance?.wrapper) {
        instance.wrapper.style.display = 'none';
        // Move it back to the webview manager container if it exists
        if (webviewManager.container) {
          webviewManager.container.appendChild(instance.wrapper);
        }
      }
    };
  }, [viewId, webviewManager]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-[200px] relative bg-[#0c0d12]"
    />
  );
}

// ─── Main container component ───────────────────────────────
/**
 * @param {Object} props
 * @param {string} props.containerId - The view container ID (e.g., "prisma")
 * @param {{ id, title, icon, extensionId }} props.container - Container definition
 * @param {Array<{ id, name, type, extensionId }>} props.views - Views belonging to this container
 * @param {Object} props.treeDataMap - Map of viewId → tree data array
 * @param {Array} props.webviewPanels - Active webview panels
 * @param {Object} props.webviewManager - WebviewManager instance
 * @param {Object} props.extensions - Map of extensionId → extension info
 */
export default function ExtensionViewContainer({
  containerId,
  container,
  views = [],
  treeDataMap = {},
  webviewPanels = [],
  webviewManager = null,
  extensions = {},
  onExecuteCommand = null,
}) {
  // extensions may be an array (from selectExtensionList) or an object map.
  // Normalise to find the extension info by its ID.
  const extInfo = Array.isArray(extensions)
    ? extensions.find(e => e.id === container?.extensionId)
    : extensions[container?.extensionId];
  const isActive = extInfo?.state === 'active';
  const isPendingRemote = extInfo?.state === 'pending-remote' || extInfo?.state === 'activating';
  const isRemote = extInfo?.remote === true;

  return (
    <div className="h-full flex flex-col bg-[#09090b] text-[#e8eaed]">
      {/* Container header */}
      <div className="px-3 pt-3 pb-2 border-b border-[#1a1b24]">
        <div className="flex items-center gap-1.5 mb-1">
          {container?.icon && (container.icon.startsWith('http') || container.icon.startsWith('data:')) ? (
            <img src={container.icon} alt="" className="w-4 h-4" />
          ) : (
            <Box className="w-4 h-4 text-[#4aba9a]" />
          )}
          <span className="text-[13px] font-semibold tracking-tight">
            {container?.title || containerId}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#6b7280]">
          <span className={isActive ? 'text-emerald-400' : isPendingRemote ? 'text-blue-400' : 'text-yellow-400'}>
            {isActive ? (isRemote ? '● Remote' : '● Active') : isPendingRemote ? '◌ Connecting…' : '◌ Inactive'}
          </span>
          {extInfo && (
            <span className="truncate">
              {extInfo.displayName} v{extInfo.version}
            </span>
          )}
        </div>
      </div>

      {/* Views list */}
      <div className="flex-1 overflow-y-auto">
        {isPendingRemote ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <Loader2 className="w-5 h-5 text-blue-400 mb-2 animate-spin" />
            <div className="text-[12px] text-[#9ba2b8] mb-1">Connecting to remote host…</div>
            <div className="text-[11px] text-[#4a5060]">
              This extension requires Node.js and will run on
              the remote extension host once connected.
            </div>
          </div>
        ) : !isActive ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <AlertTriangle className="w-6 h-6 text-[#4a5060] mb-2" />
            <div className="text-[12px] text-[#6b7280] mb-1">Extension not active</div>
            <div className="text-[11px] text-[#4a5060]">
              The extension providing this view is not running.
              Activate it from the Extensions panel.
            </div>
          </div>
        ) : views.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <Box className="w-6 h-6 text-[#2a2b34] mb-2" />
            <div className="text-[12px] text-[#6b7280]">No views registered</div>
          </div>
        ) : (
          <>
            {isRemote && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0d1117] border-b border-[#1a1b24] text-[10px] text-[#6b7280]">
                <Server className="w-3 h-3 text-emerald-500/60" />
                <span>Running on remote extension host</span>
              </div>
            )}
            {views.map((view) => {
            // Check if there's a runtime webview panel for this view
            const webviewPanel = webviewPanels.find(p => p.viewType === view.id);

            if (view.type === 'webview' && webviewPanel) {
              return (
                <div key={view.id} className="border-b border-[#1a1b24]">
                  <div className="px-3 py-2 text-[11px] font-semibold text-[#9ba2b8] uppercase tracking-wider">
                    {view.name}
                  </div>
                  <WebviewPanelEmbed
                    viewId={webviewPanel.viewId}
                    webviewManager={webviewManager}
                  />
                </div>
              );
            }

            return (
              <TreeViewSection
                key={view.id}
                view={view}
                treeData={treeDataMap[view.id]}
                onExecuteCommand={onExecuteCommand}
              />
            );
          })}
          </>
        )}
      </div>

      {/* Webview panels that don't belong to a specific view */}
      {webviewPanels
        .filter(p => !views.find(v => v.id === p.viewType))
        .map(panel => (
          <div key={panel.viewId} className="border-t border-[#1a1b24]">
            <div className="px-3 py-2 text-[11px] font-semibold text-[#9ba2b8] uppercase tracking-wider flex items-center gap-1.5">
              <Globe className="w-3 h-3" />
              {panel.title}
            </div>
            <WebviewPanelEmbed
              viewId={panel.viewId}
              webviewManager={webviewManager}
            />
          </div>
        ))}
    </div>
  );
}
