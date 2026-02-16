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

// ─── When-clause evaluator ───────────────────────────────────
/**
 * Evaluates a VS Code when-clause expression against a map of context values.
 * Returns true, false, or null (can't determine — unknown context keys).
 * Supports: boolean keys, negation (!key), ==, !=, && and ||.
 */
function evaluateWhenClause(whenClause, contextValues) {
  if (!whenClause || typeof whenClause !== 'string') return null;
  if (!contextValues || typeof contextValues !== 'object') return null;

  const trimmed = whenClause.trim();
  if (!trimmed) return null;

  // Handle && (AND)
  if (trimmed.includes('&&')) {
    const parts = trimmed.split(/\s*&&\s*/);
    const results = parts.map(p => evaluateWhenClause(p, contextValues));
    if (results.includes(false)) return false;
    if (results.includes(null)) return null;
    return true;
  }

  // Handle || (OR)
  if (trimmed.includes('||')) {
    const parts = trimmed.split(/\s*\|\|\s*/);
    const results = parts.map(p => evaluateWhenClause(p, contextValues));
    if (results.includes(true)) return true;
    if (results.includes(null)) return null;
    return false;
  }

  // Handle negation: !key
  if (trimmed.startsWith('!')) {
    const key = trimmed.slice(1).trim();
    if (!(key in contextValues)) return null;
    return !contextValues[key];
  }

  // Handle comparison operators: >=, <=, >, <
  const compMatch = trimmed.match(/^(.+?)\s*(>=|<=|>|<)\s*(.+)$/);
  if (compMatch) {
    const [, key, op, value] = compMatch;
    const k = key.trim();
    if (!(k in contextValues)) return null;
    const lhs = Number(contextValues[k]);
    const rhs = Number(value.trim().replace(/['"]/g, ''));
    if (Number.isNaN(lhs) || Number.isNaN(rhs)) return null;
    switch (op) {
      case '>':  return lhs > rhs;
      case '<':  return lhs < rhs;
      case '>=': return lhs >= rhs;
      case '<=': return lhs <= rhs;
    }
  }

  // Handle equality: key == value
  if (trimmed.includes('==') && !trimmed.includes('!=')) {
    const [key, value] = trimmed.split(/\s*==\s*/).map(s => s.trim());
    if (!(key in contextValues)) return null;
    return String(contextValues[key]) === value.replace(/['"]/g, '');
  }

  // Handle inequality: key != value
  if (trimmed.includes('!=')) {
    const [key, value] = trimmed.split(/\s*!=\s*/).map(s => s.trim());
    if (!(key in contextValues)) return null;
    return String(contextValues[key]) !== value.replace(/['"]/g, '');
  }

  // Simple boolean key
  if (!(trimmed in contextValues)) return null;
  return !!contextValues[trimmed];
}

// ─── Welcome content renderer (from contributes.viewsWelcome) ───
/**
 * Parses and renders viewsWelcome markdown-style content from extension manifests.
 * Supports:
 *   - [text](command:commandId)  → rendered as a button that executes the command
 *   - [text](https://url)       → rendered as a hyperlink
 *   - Plain text                 → rendered as a paragraph
 */
function WelcomeContent({ entries, onExecuteCommand }) {
  if (!entries || entries.length === 0) return null;

  return (
    <div className="py-2 space-y-3">
      {entries.map((entry, idx) => (
        <WelcomeEntry key={idx} contents={entry.contents} onExecuteCommand={onExecuteCommand} />
      ))}
    </div>
  );
}

function WelcomeEntry({ contents, onExecuteCommand }) {
  if (!contents) return null;

  // NLS bundles may resolve to l10n objects {message, comment} instead of strings.
  // Extract the message string if so, or coerce to string as last resort.
  let text;
  if (typeof contents === 'string') {
    text = contents;
  } else if (typeof contents === 'object' && contents !== null && typeof contents.message === 'string') {
    text = contents.message;
  } else {
    return null; // Skip entries we can't render
  }

  // Split the contents into lines and parse each
  const lines = text.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse markdown-style links: [text](target)
    const parts = [];
    let lastIndex = 0;
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;

    while ((match = linkRe.exec(line)) !== null) {
      // Text before the link
      if (match.index > lastIndex) {
        parts.push({ type: 'text', value: line.slice(lastIndex, match.index) });
      }

      const linkText = match[1];
      const linkTarget = match[2];

      if (linkTarget.startsWith('command:')) {
        parts.push({ type: 'command', text: linkText, commandId: linkTarget.replace('command:', '') });
      } else if (linkTarget.startsWith('http://') || linkTarget.startsWith('https://')) {
        parts.push({ type: 'link', text: linkText, url: linkTarget });
      } else {
        parts.push({ type: 'text', value: `${linkText}` });
      }

      lastIndex = match.index + match[0].length;
    }

    // Remaining text after last link
    if (lastIndex < line.length) {
      parts.push({ type: 'text', value: line.slice(lastIndex) });
    }

    // If the entire line is a single command link, render it as a button
    const commandParts = parts.filter(p => p.type === 'command');
    const isButtonLine = commandParts.length === 1 && parts.every(p => p.type === 'command' || (p.type === 'text' && !p.value.trim()));

    if (isButtonLine) {
      const cmd = commandParts[0];
      elements.push(
        <button
          key={i}
          onClick={() => onExecuteCommand?.(cmd.commandId)}
          className="w-full px-3 py-1.5 text-[12px] font-medium text-white bg-[#4aba9a]/20 hover:bg-[#4aba9a]/30 border border-[#4aba9a]/40 rounded transition-colors text-center"
        >
          {cmd.text}
        </button>
      );
    } else {
      // Render as inline content (mixed text + links)
      elements.push(
        <p key={i} className="text-[11px] text-[#9ba2b8] leading-relaxed">
          {parts.map((part, j) => {
            if (part.type === 'command') {
              return (
                <button
                  key={j}
                  onClick={() => onExecuteCommand?.(part.commandId)}
                  className="text-[#4aba9a] hover:underline cursor-pointer inline"
                >
                  {part.text}
                </button>
              );
            }
            if (part.type === 'link') {
              return (
                <a
                  key={j}
                  href={part.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#4aba9a] hover:underline"
                >
                  {part.text}
                </a>
              );
            }
            return <span key={j}>{part.value}</span>;
          })}
        </p>
      );
    }
  }

  return <div className="space-y-2">{elements}</div>;
}

// ─── Tree view section ───────────────────────────────────────
function TreeViewSection({ view, treeData, welcomeEntries, contextValues, onRequestData, onExecuteCommand }) {
  const [collapsed, setCollapsed] = useState(false);

  // Filter welcome entries by when-clause.  In native VS Code, unknown
  // context keys evaluate to falsy, so only entries that evaluate to
  // *true* are shown.  Treating null (unknown) as false prevents
  // contradictory welcome messages from appearing simultaneously.
  const filteredWelcome = welcomeEntries?.filter(entry => {
    if (!entry.when) return true;
    const result = evaluateWhenClause(entry.when, contextValues);
    return result === true;
  });

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
          ) : filteredWelcome && filteredWelcome.length > 0 ? (
            <WelcomeContent entries={filteredWelcome} onExecuteCommand={onExecuteCommand} />
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
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!containerRef.current || !webviewManager) return;

    const instance = webviewManager.webviews?.get(viewId);
    if (instance?.wrapper) {
      instance.wrapper.style.display = 'block';
      instance.wrapper.style.position = 'relative';
      containerRef.current.appendChild(instance.wrapper);
    } else if (retryCount < 10) {
      // Instance might not exist yet — retry after a delay.
      // This handles the race where Redux has the panel but
      // WebviewManager hasn't created the iframe yet.
      const timer = setTimeout(() => setRetryCount(c => c + 1), 500);
      return () => clearTimeout(timer);
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
  }, [viewId, webviewManager, retryCount]);

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
  onRequestTreeRefresh = null,
  viewsWelcome = {},
  contextValues = {},
}) {
  // Auto-request tree data refresh when the container opens with no data.
  // This handles timing races where data arrived before Redux hydration,
  // or was missed during the bootstrap window.
  const refreshRequestedRef = useRef(false);
  useEffect(() => {
    if (!onRequestTreeRefresh || refreshRequestedRef.current) return;
    const treeViews = views.filter(v => v.type !== 'webview');
    const hasAnyData = treeViews.some(v => treeDataMap[v.id] && treeDataMap[v.id].length > 0);
    if (treeViews.length > 0 && !hasAnyData) {
      refreshRequestedRef.current = true;
      onRequestTreeRefresh(containerId);
    }
  }, [containerId, views, treeDataMap, onRequestTreeRefresh]);

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
            {(() => {
              // Phase 1: when-clause filtering — only hide views we're CERTAIN
              // should be hidden (result === false).  Unknown keys (null) keep
              // the view visible.
              const whenFiltered = views.filter(view => {
                if (view.when) {
                  const result = evaluateWhenClause(view.when, contextValues);
                  if (result === false) return false;
                }
                return true;
              });

              // Phase 2: hide empty-view placeholders when sibling DATA views
              // are present in the filtered list AND have tree data.
              const postFiltered = whenFiltered.filter(view => {
                if (view.id.includes('empty-view') || view.id.includes('empty_view')) {
                  const siblingsHaveData = whenFiltered.some(
                    v => v.id !== view.id
                      && !v.id.includes('empty-view')
                      && !v.id.includes('empty_view')
                      && treeDataMap[v.id]?.length > 0
                  );
                  if (siblingsHaveData) return false;
                }
                return true;
              });

              // Safety net: if when-clause filtering removed all views, fall
              // back to showing views ONLY if the extension actually has tree
              // data registered (= the extension is active). Otherwise, showing
              // all views from an unactivated extension floods the panel with
              // contradictory welcome messages.  A blank panel is preferable.
              const anyTreeData = views.some(v => treeDataMap[v.id]?.length > 0);
              const displayViews = postFiltered.length > 0
                ? postFiltered
                : anyTreeData ? views : [];

              if (postFiltered.length === 0 && views.length > 0) {
                console.warn(
                  `[ExtensionViewContainer] All ${views.length} view(s) filtered out for "${containerId}". ` +
                  (anyTreeData
                    ? 'Falling back to showing all views (extension has tree data).'
                    : 'Extension has no tree data — suppressing empty views.'),
                  'contextValues:', contextValues,
                  'views:', views.map(v => ({ id: v.id, when: v.when }))
                );
              }

              return displayViews;
            })()
            .map((view) => {
            // Check if there's a runtime webview panel for this view
            const webviewPanel = webviewPanels.find(p => p.viewType === view.id);

            // Render as webview if: (a) manifest says type=webview AND we have a panel,
            // OR (b) we have a panel regardless of manifest type (the extension registered
            // a webview view provider for this view at runtime)
            if (webviewPanel && (view.type === 'webview' || webviewPanel.viewId)) {
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
                welcomeEntries={viewsWelcome[view.id]}
                contextValues={contextValues}
                onExecuteCommand={onExecuteCommand}
              />
            );
          })}
          </>
        )}
      </div>

      {/* Webview panels that belong to THIS extension but not to a specific view */}
      {webviewPanels
        .filter(p => !views.find(v => v.id === p.viewType))
        .filter(p => {
          // Exclude synthetic placeholder panels created from manifest scanning.
          // These never receive actual HTML content because the extension didn't
          // register a webview view provider in headless mode.
          const syntheticIds = ['manifest-rpc-fallback', 'manifest-fallback', 'rpc-fallback'];
          if (syntheticIds.includes(p.extensionId)) return false;
          // Only show panels with an extensionId that exactly matches this container's extension.
          if (!container?.extensionId) return false;
          return p.extensionId?.toLowerCase() === container.extensionId.toLowerCase();
        })
        .map(panel => (
          <div key={panel.viewId} className="border-t border-[#1a1b24]">
            <div className="px-3 py-2 text-[11px] font-semibold text-[#9ba2b8] uppercase tracking-wider flex items-center gap-1.5">
              <Globe className="w-3 h-3" />
              {_humanizeViewType(panel.title || panel.viewType)}
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

/**
 * Convert a raw viewType like "github:createPullRequestWebview" into
 * a human-readable title like "Create Pull Request".
 */
function _humanizeViewType(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  // Already human-readable (contains spaces)?
  if (raw.includes(' ')) return raw;
  // Strip namespace prefix (e.g. "github:" or "github.")
  let name = raw.includes(':') ? raw.split(':').pop() : raw.includes('.') ? raw.split('.').pop() : raw;
  // Remove common suffixes
  name = name.replace(/Webview$/, '').replace(/Panel$/, '').replace(/View$/, '');
  // CamelCase → spaced (e.g. "createPullRequest" → "Create Pull Request")
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1);
}
