'use client';

/**
 * Extension Sidebar View
 * Rendered inside the workspace sidebar when the "Extensions" tab is active.
 * Two tabs: "Installed" (local extensions) and "Marketplace" (Open VSX search).
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Puzzle, Plus, Search, Download, Star, ArrowDownCircle, Loader2, ExternalLink, X, Check, AlertTriangle, Upload, FileArchive } from 'lucide-react';

// ─── Sample extension for quick testing ──────────────────────
const SAMPLE_EXTENSION = {
  id: 'synthi.hello-world',
  manifest: {
    name: 'hello-world',
    displayName: 'Hello World',
    description: 'A simple test extension that registers a greeting command.',
    version: '1.0.0',
    publisher: 'synthi',
    engines: { vscode: '^1.80.0' },
    activationEvents: ['onCommand:helloWorld.sayHello'],
    main: './extension.js',
    browser: './extension.js',
    contributes: {
      commands: [
        { command: 'helloWorld.sayHello', title: 'Hello World: Say Hello' },
      ],
    },
  },
  code: `
function activate(context) {
  console.log('[HelloWorld] activated');
  const disposable = vscode.commands.registerCommand('helloWorld.sayHello', () => {
    vscode.window.showInformationMessage('Hello from the Hello World extension!');
    return 'Hello!';
  });
  context.subscriptions.push(disposable);
}
function deactivate() {}
module.exports = { activate, deactivate };
`,
};

// ─── State colors ────────────────────────────────────────────
const STATE_COLORS = {
  active: 'bg-emerald-500',
  installed: 'bg-zinc-500',
  loaded: 'bg-blue-400',
  activating: 'bg-yellow-500 animate-pulse',
  disabled: 'bg-zinc-600',
  crashed: 'bg-red-500',
  quarantined: 'bg-red-700',
};
const STATE_LABELS = {
  active: 'Active', installed: 'Installed', loaded: 'Loaded',
  activating: 'Activating…', disabled: 'Disabled',
  crashed: 'Crashed', quarantined: 'Quarantined',
};

// ─── Installed extension row ─────────────────────────────────
function ExtensionRow({ ext, onEnable, onDisable, onUninstall, onRestart }) {
  const [expanded, setExpanded] = useState(false);
  const isActive = ext.state === 'active';
  const isDisabled = ext.state === 'disabled' || ext.state === 'quarantined';

  return (
    <div className="border rounded-lg mb-1.5 overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
        style={{ ':hover': undefined }}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-7 h-7 rounded flex items-center justify-center text-sm shrink-0" style={{ background: 'var(--bg-elevated)' }}>
          {ext.icon ? <img src={ext.icon} className="w-5 h-5 rounded" alt="" /> : '🧩'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{ext.displayName || ext.name}</span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>v{ext.version}</span>
          </div>
          <div className="text-[10px] truncate" style={{ color: 'var(--text-dim)' }}>{ext.publisher}</div>
        </div>
        <span className={`shrink-0 inline-block w-2 h-2 rounded-full ${STATE_COLORS[ext.state] || 'bg-zinc-500'}`} title={STATE_LABELS[ext.state] || ext.state} />
      </div>
      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>{ext.description || 'No description.'}</p>
          <div className="flex gap-3 text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
            <span>State: <span style={{ color: 'var(--text-primary)' }}>{STATE_LABELS[ext.state] || ext.state}</span></span>
            {ext.crashCount > 0 && <span style={{ color: 'var(--accent-danger)' }}>Crashes: {ext.crashCount}</span>}
            <span>Activations: {ext.activationCount || 0}</span>
          </div>
          {ext.state === 'quarantined' && (
            <div className="border rounded px-2 py-1.5 text-[11px] mb-2" style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-danger) 30%, transparent)', color: 'var(--accent-danger)' }}>
              ⚠ Quarantined: {ext.quarantineReason || 'Repeated failures'}
            </div>
          )}
          <div className="flex gap-1.5">
            {isDisabled ? (
              <button onClick={() => onEnable(ext.id)} className="px-2 py-1 text-[11px] rounded text-white" style={{ background: 'var(--accent-success)' }}>Enable</button>
            ) : (
              <button onClick={() => onDisable(ext.id)} className="px-2 py-1 text-[11px] rounded transition-colors" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>Disable</button>
            )}
            {isActive && (
              <button onClick={() => onRestart(ext.id)} className="px-2 py-1 text-[11px] rounded transition-colors" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>Restart</button>
            )}
            <button onClick={() => onUninstall(ext.id)} className="px-2 py-1 text-[11px] rounded" style={{ background: 'color-mix(in srgb, var(--accent-danger) 15%, transparent)', color: 'var(--accent-danger)' }}>Uninstall</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Marketplace result row ──────────────────────────────────
function MarketplaceRow({ ext, installedIds, onMarketplaceInstall }) {
  const isInstalled = installedIds.has(`${ext.namespace}.${ext.name}`);
  const [installing, setInstalling] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [installError, setInstallError] = useState(null);

  const handleInstall = async (e) => {
    e.stopPropagation();
    if (installing || isInstalled) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await onMarketplaceInstall(ext);
    } catch (err) {
      console.error(`[Marketplace] Install failed for ${ext.namespace}.${ext.name}:`, err);
      setInstallError(err.message || 'Install failed');
    } finally {
      setInstalling(false);
    }
  };

  const downloads = ext.downloadCount >= 1000
    ? `${(ext.downloadCount / 1000).toFixed(ext.downloadCount >= 10000 ? 0 : 1)}k`
    : (ext.downloadCount ?? 0);

  return (
    <div className="border rounded-lg mb-1.5 overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Icon */}
        <div className="w-8 h-8 rounded flex items-center justify-center text-sm shrink-0 overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
          {ext.files?.icon ? (
            <img src={ext.files.icon} className="w-8 h-8 rounded object-cover" alt="" onError={(e) => { e.target.style.display = 'none'; e.target.parentNode.textContent = '🧩'; }} />
          ) : '🧩'}
        </div>
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{ext.displayName || ext.name}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
            <span className="truncate">{ext.namespace}</span>
            {ext.averageRating != null && (
              <span className="flex items-center gap-0.5 shrink-0" style={{ color: 'var(--accent-warning)' }}>
                <Star className="w-2.5 h-2.5 fill-current" />
                {ext.averageRating.toFixed(1)}
              </span>
            )}
            <span className="shrink-0">{downloads} ↓</span>
          </div>
        </div>
        {/* Install button */}
        <button
          onClick={handleInstall}
          disabled={installing || isInstalled}
          className={`shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded transition-colors ${
            isInstalled
              ? 'cursor-default'
              : installing
              ? ''
              : ''
          }`}
          style={!isInstalled && !installing ? { background: 'color-mix(in srgb, var(--accent-secondary) 15%, transparent)', color: 'var(--accent-secondary)' } : installing ? { background: 'var(--bg-elevated)', color: 'var(--text-muted)' } : { background: 'color-mix(in srgb, var(--accent-success) 12%, transparent)', color: 'var(--accent-success)' }}
        >
          {isInstalled ? (
            <><Check className="w-3 h-3" /> Installed</>
          ) : installing ? (
            <><Loader2 className="w-3 h-3 animate-spin" /> Installing…</>
          ) : (
            <><Download className="w-3 h-3" /> Install</>
          )}
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>{ext.description || 'No description.'}</p>
          <div className="flex flex-wrap gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span>v{ext.version}</span>
            {ext.verified && <span style={{ color: 'var(--accent-success)' }}>✓ Verified</span>}
            {ext.reviewCount > 0 && <span>{ext.reviewCount} reviews</span>}
          </div>
          {ext.url && (
            <a href={ext.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-[10px] hover:underline"
              style={{ color: 'var(--accent-secondary)' }}
            >
              View on Open VSX <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
          {/* Web compatibility note */}
          <div className="mt-2 border rounded px-2 py-1.5 text-[10px] flex items-start gap-1.5" style={{ background: 'color-mix(in srgb, var(--accent-warning) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-warning) 20%, transparent)', color: 'var(--accent-warning)' }}>
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            <span>Declarative contributions (sidebar views, themes, languages, snippets, keybindings) work fully. Extensions requiring Node.js APIs (language servers, debuggers) will run in stub mode.</span>
          </div>
          {installError && (
            <div className="mt-2 text-[11px] border rounded px-2 py-1.5" style={{ color: 'var(--accent-danger)', background: 'color-mix(in srgb, var(--accent-danger) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-danger) 25%, transparent)' }}>
              ⚠ {installError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main sidebar component ──────────────────────────────────
export default function ExtensionSidebar({
  extensions = [],
  errors = [],
  ready = false,
  hostStatus = 'idle',
  vscodeServerState = 'disconnected',
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onRestart,
  onDismissError,
  onExecuteCommand,
}) {
  const [tab, setTab] = useState('installed'); // 'installed' | 'marketplace'
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [showInstall, setShowInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  const activeCount = extensions.filter(e => e.state === 'active').length;
  const issueCount = extensions.filter(e => e.state === 'crashed' || e.state === 'quarantined').length;
  const installedIds = new Set(extensions.map(e => e.id));

  // ─── Marketplace search ───────────────────────────────
  const searchMarketplace = useCallback(async (query) => {
    if (!query || query.length < 2) {
      setSearchResults([]);
      setSearchTotal(0);
      setSearchError(null);
      return;
    }

    // Abort previous request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearching(true);
    setSearchError(null);

    try {
      const params = new URLSearchParams({
        action: 'search',
        query,
        size: '30',
        sortBy: 'relevance',
        sortOrder: 'desc',
      });
      const res = await fetch(`/api/extensions/search?${params}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      if (controller.signal.aborted) return;
      setSearchResults(data.extensions || []);
      setSearchTotal(data.totalSize || 0);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setSearchError(err.message);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // Debounced search on query change
  useEffect(() => {
    if (tab !== 'marketplace') return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchMarketplace(searchQuery), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery, tab, searchMarketplace]);

  // Load popular extensions when switching to marketplace tab with no query
  useEffect(() => {
    if (tab === 'marketplace' && !searchQuery) {
      searchMarketplace('popular');
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Install from marketplace ─────────────────────────
  const handleMarketplaceInstall = useCallback(async (marketplaceExt) => {
    if (!onInstall) return;
    
    const extId = `${marketplaceExt.namespace}.${marketplaceExt.name}`;

    // 1. Fetch extension detail from Open VSX to get download URLs
    let detail;
    try {
      const detailParams = new URLSearchParams({
        action: 'detail',
        namespace: marketplaceExt.namespace,
        extension: marketplaceExt.name,
      });
      const detailRes = await fetch(`/api/extensions/search?${detailParams}`);
      if (detailRes.ok) detail = await detailRes.json();
    } catch (e) {
      console.warn(`[Marketplace] Could not fetch detail for ${extId}:`, e);
    }

    // 2. Fetch the REAL package.json from Open VSX (contains real contributes)
    let realManifest = null;
    const manifestUrl = detail?.files?.manifest;
    if (manifestUrl) {
      try {
        const proxyParams = new URLSearchParams({ action: 'proxy', url: manifestUrl });
        const mRes = await fetch(`/api/extensions/search?${proxyParams}`);
        if (mRes.ok) realManifest = await mRes.json();
      } catch (e) {
        console.warn(`[Marketplace] Could not fetch manifest for ${extId}:`, e);
      }
    }

    // Use the real manifest if we got it, otherwise build a basic one from search data
    const manifest = realManifest || {
      name: marketplaceExt.name,
      displayName: marketplaceExt.displayName || marketplaceExt.name,
      description: marketplaceExt.description || '',
      version: marketplaceExt.version,
      publisher: marketplaceExt.namespace,
      engines: { vscode: '^1.80.0' },
      activationEvents: ['*'],
      main: './extension.js',
      contributes: {},
    };
    // Ensure essential fields are present
    if (!manifest.publisher) manifest.publisher = marketplaceExt.namespace;
    if (!manifest.version) manifest.version = marketplaceExt.version;
    // Preserve the icon URL from the marketplace data
    manifest.icon = marketplaceExt.files?.icon || detail?.files?.icon || manifest.icon || null;

    // 3. Try to download the VSIX and extract real extension code
    let code = null;
    try {
      const dlParams = new URLSearchParams({
        action: 'download-vsix',
        namespace: marketplaceExt.namespace,
        extension: marketplaceExt.name,
        version: marketplaceExt.version,
      });
      const vsixRes = await fetch(`/api/extensions/search?${dlParams}`);
      if (vsixRes.ok) {
        const vsixBuffer = await vsixRes.arrayBuffer();
        const { parseVSIX } = await import('@/extensions/loader/ExtensionInstaller');
        const extracted = await parseVSIX(vsixBuffer);
        code = extracted.code;
        // The VSIX-extracted manifest has NLS %key% placeholders resolved.
        // Prefer it over the raw API manifest for any fields it contains,
        // especially contributes.views where view names would be unreadable.
        if (extracted.manifest) {
          // Merge NLS-resolved fields into manifest (overwrites %key% placeholders)
          if (extracted.manifest.contributes) {
            manifest.contributes = extracted.manifest.contributes;
          }
          if (extracted.manifest.displayName) manifest.displayName = extracted.manifest.displayName;
          if (extracted.manifest.description) manifest.description = extracted.manifest.description;
          // Copy browser/main fields so downstream code knows the entry type
          if (extracted.manifest.browser) manifest.browser = extracted.manifest.browser;
          if (extracted.manifest.main && !manifest.main) manifest.main = extracted.manifest.main;
        }
        // Carry over extracted metadata
        if (extracted.manifest?._grammars) manifest._grammars = extracted.manifest._grammars;
        if (extracted.manifest?._langConfigs) manifest._langConfigs = extracted.manifest._langConfigs;
        if (extracted.manifest?._nodeOnly) manifest._nodeOnly = extracted.manifest._nodeOnly;
        if (extracted.manifest?._isWebBundle) manifest._isWebBundle = extracted.manifest._isWebBundle;
        // Carry the real Node.js bundle for the remote extension host
        if (extracted.nodeCode) manifest._nodeCode = extracted.nodeCode;
      }
    } catch (e) {
      console.warn(`[Marketplace] VSIX download/extract failed for ${extId}:`, e.message);
    }

    // 4. Fall back to stub code if VSIX extraction failed
    // (many extensions need Node.js APIs that our web worker doesn't have)
    if (!code) {
      const displayName = (manifest.displayName || manifest.name || '').replace(/'/g, "\\'");
      code = `
// ${displayName} v${manifest.version}
// Installed from Open VSX Registry
// VSIX code could not be extracted — running as declarative-only extension.
// Contribution points (sidebar views, languages, themes, snippets, etc.)
// are still parsed from the real package.json and rendered in the IDE.
function activate(context) {
  console.log('[${extId}] Extension activated (declarative contributions only)');
  vscode.window.showInformationMessage('${displayName} loaded — declarative contributions active.');
}
function deactivate() {}
module.exports = { activate, deactivate };
`;
    }

    await onInstall(extId, manifest, code);
  }, [onInstall]);

  // ─── Install sample ───────────────────────────────────
  const handleInstallSample = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await onInstall?.(SAMPLE_EXTENSION.id, SAMPLE_EXTENSION.manifest, SAMPLE_EXTENSION.code);
      setShowInstall(false);
    } catch (err) {
      setInstallError(err.message);
    } finally {
      setInstalling(false);
    }
  }, [onInstall]);

  // ─── Install from VSIX file ───────────────────────────
  const vsixInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [vsixFileName, setVsixFileName] = useState(null);

  const handleVsixFile = useCallback(async (file) => {
    if (!file || !onInstall) return;
    if (!file.name.endsWith('.vsix')) {
      setInstallError('File must be a .vsix file');
      return;
    }
    setVsixFileName(file.name);
    setInstalling(true);
    setInstallError(null);
    try {
      const { parseVSIX } = await import('@/extensions/loader/ExtensionInstaller');
      const buffer = await file.arrayBuffer();
      const { manifest, code, nodeCode } = await parseVSIX(buffer);
      if (nodeCode) manifest._nodeCode = nodeCode;
      const extId = `${manifest.publisher || 'unknown'}.${manifest.name}`;
      await onInstall(extId, manifest, code);
      setShowInstall(false);
      setVsixFileName(null);
    } catch (err) {
      setInstallError(err.message);
    } finally {
      setInstalling(false);
    }
  }, [onInstall]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleVsixFile(file);
  }, [handleVsixFile]);

  const onDragOver = useCallback((e) => { e.preventDefault(); setDragOver(true); }, []);
  const onDragLeave = useCallback(() => { setDragOver(false); }, []);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}>
      {/* Header strip with gradient accent */}
      <div className="flex-shrink-0">
        <div className="h-[2px]" style={{ background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary), var(--accent-tertiary), transparent)' }} />
        <div className="flex items-center gap-2 px-3 py-2">
          <Puzzle size={14} className="flex-shrink-0" style={{ color: 'var(--accent-secondary)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Extensions</span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={() => setShowInstall(!showInstall)}
              className="p-1.5 rounded-lg transition-all"
              style={{ color: 'var(--text-muted)' }}
              title="Install from code"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>
      <div className="px-3 pb-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>

        {/* Tab bar: Installed | Marketplace */}
        <div className="flex gap-0.5 rounded-md p-0.5 mb-2" style={{ background: 'var(--bg-editor)' }}>
          <button
            onClick={() => setTab('installed')}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded transition-colors`}
            style={tab === 'installed' ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' } : { color: 'var(--text-muted)' }}
          >
            Installed ({extensions.length})
          </button>
          <button
            onClick={() => setTab('marketplace')}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded transition-colors`}
            style={tab === 'marketplace' ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' } : { color: 'var(--text-muted)' }}
          >
            Marketplace
          </button>
        </div>

        {/* Search bar (marketplace tab) */}
        {tab === 'marketplace' && (
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-dim)' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search extensions on Open VSX…"
              className="w-full pl-7 pr-7 py-1.5 border rounded text-[12px] focus:outline-none transition-colors"
              style={{ background: 'var(--bg-editor)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              autoFocus
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-dim)' }}>
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Status row (installed tab) */}
        {tab === 'installed' && (
          <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: hostStatus === 'ready' ? 'var(--accent-success)' : hostStatus === 'error' ? 'var(--accent-danger)' : 'var(--accent-warning)' }}>
              {hostStatus === 'ready' ? '● Ready' : hostStatus === 'initializing' ? '◌ Starting…' : hostStatus === 'error' ? '● Error' : '○ Idle'}
            </span>
            {vscodeServerState !== 'disconnected' && (
              <span style={{ color:
                vscodeServerState === 'running' ? 'var(--accent-success)' :
                vscodeServerState === 'connecting' ? 'var(--accent-warning)' :
                vscodeServerState === 'error' ? 'var(--accent-danger)' : 'var(--text-muted)'
              }}>
                {vscodeServerState === 'running' ? '● Server' :
                 vscodeServerState === 'connecting' ? '◌ Server…' :
                 vscodeServerState === 'error' ? '● Server ✖' : ''}
              </span>
            )}
            <span>{activeCount} active</span>
            {issueCount > 0 && <span style={{ color: 'var(--accent-danger)' }}>{issueCount} issues</span>}
          </div>
        )}
      </div>

      {/* ─── Quick install panel ─────────────────────────── */}
      {showInstall && tab === 'installed' && (
        <div className="border-b p-3 space-y-3" style={{ borderColor: 'var(--border-subtle)' }}>
          {/* VSIX file drop zone */}
          <div>
            <div className="text-[11px] mb-1.5 font-medium" style={{ color: 'var(--text-secondary)' }}>Install from VSIX</div>
            <div
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={() => vsixInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-1.5 border-2 border-dashed rounded-lg py-4 px-3 cursor-pointer transition-colors ${
                dragOver
                  ? 'border-[#4aba9a] bg-[#4aba9a]/10'
                  : ''
              }`}
              style={!dragOver ? { borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' } : {}}
            >
              <input
                ref={vsixInputRef}
                type="file"
                accept=".vsix"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleVsixFile(file);
                  e.target.value = '';
                }}
              />
              {installing && vsixFileName ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--accent-secondary)' }} />
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Installing {vsixFileName}…</span>
                </>
              ) : (
                <>
                  <Upload className="w-5 h-5" style={{ color: 'var(--text-dim)' }} />
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Drop <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>.vsix</span> file here or click to browse
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>or</span>
            <div className="flex-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
          </div>

          {/* Sample extension quick install */}
          <div>
            <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Install a test extension to verify the system works:
            </div>
            <button
              onClick={handleInstallSample}
              disabled={installing || !ready}
              className="w-full px-3 py-1.5 text-[11px] font-medium rounded disabled:opacity-40 transition-colors"
              style={{ background: 'var(--accent-secondary)', color: 'var(--bg-app)' }}
            >
              {installing && !vsixFileName ? 'Installing…' : 'Install Hello World Extension'}
            </button>
          </div>

          {installError && (
            <div className="text-[11px] text-red-400 bg-red-950/30 border border-red-800/40 rounded px-2 py-1.5">
              {installError}
            </div>
          )}
        </div>
      )}

      {/* ─── Errors (installed tab only) ─────────────────── */}
      {tab === 'installed' && errors.length > 0 && (
        <div className="border-b px-3 py-2 max-h-32 overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Recent Issues</div>
          {errors.slice(0, 5).map((err, i) => (
            <div key={i} className="flex items-start gap-1.5 mb-1 text-[11px]">
              <span className={err.severity === 'error' ? 'text-red-400' : 'text-yellow-400'}>●</span>
              <div className="flex-1 min-w-0">
                <div className="truncate" style={{ color: 'var(--text-primary)' }}>{err.title}</div>
                <div className="truncate" style={{ color: 'var(--text-muted)' }}>{err.message}</div>
              </div>
              <button onClick={() => onDismissError?.(i)} className="shrink-0 transition-colors" style={{ color: 'var(--text-muted)' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* ─── Content area ────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {tab === 'installed' ? (
          // ── Installed extensions list ──
          extensions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <Puzzle className="w-8 h-8 mb-3" style={{ color: 'var(--text-dim)' }} />
              <div className="text-[12px] mb-1" style={{ color: 'var(--text-muted)' }}>No extensions installed</div>
              <div className="text-[11px] mb-3" style={{ color: 'var(--text-dim)' }}>
                Click <Plus className="inline w-3 h-3" /> to install a test extension, or browse the <span style={{ color: 'var(--accent-secondary)' }}>Marketplace</span> tab.
              </div>
              <button
                onClick={() => setTab('marketplace')}
                className="px-3 py-1.5 text-[11px] font-medium rounded transition-colors"
                style={{ background: 'color-mix(in srgb, var(--accent-secondary) 15%, transparent)', color: 'var(--accent-secondary)' }}
              >
                Browse Marketplace
              </button>
            </div>
          ) : (
            extensions.map(ext => (
              <ExtensionRow
                key={ext.id}
                ext={ext}
                onEnable={onEnable}
                onDisable={onDisable}
                onUninstall={onUninstall}
                onRestart={onRestart}
              />
            ))
          )
        ) : (
          // ── Marketplace search results ──
          <>
            {searching && (
              <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-muted)' }}>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                <span className="text-[11px]">Searching Open VSX…</span>
              </div>
            )}
            {searchError && (
              <div className="text-[11px] text-red-400 bg-red-950/30 border border-red-800/40 rounded px-2 py-1.5 mb-2">
                {searchError}
              </div>
            )}
            {!searching && searchResults.length === 0 && !searchError && (
              <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                <Search className="w-6 h-6 mb-2" style={{ color: 'var(--text-dim)' }} />
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {searchQuery.length < 2 ? 'Type at least 2 characters to search' : 'No extensions found'}
                </div>
              </div>
            )}
            {!searching && searchResults.length > 0 && (
              <>
                <div className="text-[10px] mb-1.5 px-1" style={{ color: 'var(--text-dim)' }}>
                  {searchTotal.toLocaleString()} results from Open VSX
                </div>
                {searchResults.map((ext) => (
                  <MarketplaceRow
                    key={`${ext.namespace}.${ext.name}`}
                    ext={ext}
                    installedIds={installedIds}
                    onMarketplaceInstall={handleMarketplaceInstall}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t text-[10px] flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-dim)' }}>
        <span>Extension Host v1.0</span>
        {tab === 'marketplace' && (
          <a href="https://open-vsx.org" target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1" style={{ color: 'var(--accent-secondary)' }}>
            Open VSX <ExternalLink className="w-2.5 h-2.5" />
          </a>
        )}
      </div>
    </div>
  );
}
