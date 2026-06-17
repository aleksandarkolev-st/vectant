'use client';

/**
 * Extension Sidebar View
 * Rendered inside the workspace sidebar when the "Extensions" tab is active.
 * Two tabs: "Installed" (local extensions) and "Marketplace" (Open VSX search).
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Puzzle, Plus, Search, Download, Star, ArrowDownCircle, Loader2, ExternalLink, X, Check, AlertTriangle, Upload, FileArchive, Play, Bug, FileUp } from 'lucide-react';
import { parseExtensionImportList, splitExtensionId } from '@/extensions/loader/ExtensionImportParser';

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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function getContributedCommands(ext) {
  const commands = ext?.manifest?.contributes?.commands;
  if (!Array.isArray(commands)) return [];
  const seen = new Set();
  return commands
    .filter(cmd => cmd && typeof cmd.command === 'string' && !cmd.command.startsWith('_'))
    .map(cmd => ({
      id: cmd.command,
      title: typeof cmd.title === 'string' ? cmd.title : cmd.command,
      category: typeof cmd.category === 'string' ? cmd.category : '',
    }))
    .filter(cmd => {
      if (seen.has(cmd.id)) return false;
      seen.add(cmd.id);
      return true;
    });
}

function getDebuggerContributions(ext) {
  const debuggers = ext?.manifest?.contributes?.debuggers;
  return Array.isArray(debuggers) ? debuggers.filter(Boolean) : [];
}

function getPrimaryCommands(commands) {
  const safeCommands = commands.filter(cmd => {
    const text = `${cmd.title} ${cmd.id}`.toLowerCase();
    if (/debugpy\.|^python\.|^python-envs\.|^testing\./.test(cmd.id)) return false;
    if (/(debug|run|re-run|rerun) in terminal|copy test id|select interpreter|create environment|re-run failed tests|rerun failed tests/.test(text)) return false;
    return true;
  });
  const preferred = safeCommands.filter(cmd => /run|start|test|launch/i.test(`${cmd.title} ${cmd.id}`));
  const source = preferred.length > 0 ? preferred : safeCommands;
  return source.slice(0, 4);
}

async function installOpenVsxExtension(marketplaceExt, onInstall) {
  if (!onInstall) throw new Error('Extension installer is not ready');

  const namespace = marketplaceExt.namespace || marketplaceExt.publisher;
  const name = marketplaceExt.name || marketplaceExt.extension;
  if (!namespace || !name) throw new Error('Missing Open VSX extension identifier');

  const extId = `${namespace}.${name}`;

  let detail = null;
  const detailParams = new URLSearchParams({
    action: 'detail',
    namespace,
    extension: name,
  });
  const detailRes = await fetch(`/api/extensions/search?${detailParams}`);
  if (!detailRes.ok) {
    const message = detailRes.status === 404
      ? 'Not found on Open VSX'
      : `Open VSX detail failed (${detailRes.status})`;
    const error = new Error(message);
    error.code = detailRes.status === 404 ? 'OPEN_VSX_NOT_FOUND' : 'OPEN_VSX_DETAIL_FAILED';
    throw error;
  }
  detail = await detailRes.json();

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

  const manifest = realManifest || {
    name,
    displayName: detail?.displayName || marketplaceExt.displayName || name,
    description: detail?.description || marketplaceExt.description || '',
    version: detail?.version || marketplaceExt.version,
    publisher: namespace,
    engines: { vscode: '^1.80.0' },
    activationEvents: ['*'],
    main: './extension.js',
    contributes: {},
  };

  if (!manifest.publisher) manifest.publisher = namespace;
  if (!manifest.version) manifest.version = detail?.version || marketplaceExt.version;
  manifest.icon = marketplaceExt.files?.icon || detail?.files?.icon || manifest.icon || null;

  let code = null;
  let vsixBase64 = null;
  try {
    const dlParams = new URLSearchParams({
      action: 'download-vsix',
      namespace,
      extension: name,
      ...(manifest.version ? { version: manifest.version } : {}),
    });
    const vsixRes = await fetch(`/api/extensions/search?${dlParams}`);
    if (vsixRes.ok) {
      const vsixBuffer = await vsixRes.arrayBuffer();
      vsixBase64 = arrayBufferToBase64(vsixBuffer);
      const { parseVSIX } = await import('@/extensions/loader/ExtensionInstaller');
      const extracted = await parseVSIX(vsixBuffer);
      code = extracted.code;
      if (extracted.manifest) {
        if (extracted.manifest.contributes) manifest.contributes = extracted.manifest.contributes;
        if (extracted.manifest.displayName) manifest.displayName = extracted.manifest.displayName;
        if (extracted.manifest.description) manifest.description = extracted.manifest.description;
        if (extracted.manifest.browser) manifest.browser = extracted.manifest.browser;
        if (extracted.manifest.main && !manifest.main) manifest.main = extracted.manifest.main;
      }
      if (extracted.manifest?._grammars) manifest._grammars = extracted.manifest._grammars;
      if (extracted.manifest?._langConfigs) manifest._langConfigs = extracted.manifest._langConfigs;
      if (extracted.manifest?._nodeOnly) manifest._nodeOnly = extracted.manifest._nodeOnly;
      if (extracted.manifest?._isWebBundle) manifest._isWebBundle = extracted.manifest._isWebBundle;
      if (extracted.nodeCode) manifest._nodeCode = extracted.nodeCode;
    }
  } catch (e) {
    console.warn(`[Marketplace] VSIX download/extract failed for ${extId}:`, e.message);
  }

  if (!code) {
    const displayName = (manifest.displayName || manifest.name || '').replace(/'/g, "\\'");
    code = `
// ${displayName} v${manifest.version}
// Installed from Open VSX Registry
// VSIX code could not be extracted. Running as declarative-only extension.
function activate(context) {
  console.log('[${extId}] Extension activated (declarative contributions only)');
  vscode.window.showInformationMessage('${displayName} loaded. Declarative contributions active.');
}
function deactivate() {}
module.exports = { activate, deactivate };
`;
  }

  const needsServerVsix = manifest.main || manifest._nodeCode || (code && code.length > 500_000);

  return onInstall(extId, manifest, code, {
    source: 'marketplace',
    ...(vsixBase64 && needsServerVsix ? { vsixBase64 } : {}),
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));

  return results;
}

function createEmptyImportReport() {
  return {
    installed: [],
    alreadyInstalled: [],
    skipped: [],
    failed: [],
    needsVsix: [],
    invalid: [],
  };
}

// ─── State colors ────────────────────────────────────────────
// Style objects (not Tailwind utility strings) so the dots respect the
// active theme — `--accent-*` are remapped by ThemeProvider on swap.
const STATE_STYLES = {
  active:      { background: 'var(--accent-success)' },
  installed:   { background: 'var(--text-muted)' },
  loaded:      { background: 'var(--brand-stop-4)' },
  activating:  { background: 'var(--accent-warning)' },
  'pending-remote': { background: 'var(--brand-stop-4)' },
  disabled:    { background: 'var(--text-dim)' },
  crashed:     { background: 'var(--accent-danger)' },
  quarantined: { background: 'color-mix(in srgb, var(--accent-danger) 80%, black)' },
};
const STATE_PULSE = new Set(['activating', 'pending-remote']);
const STATE_LABELS = {
  active: 'Active', installed: 'Installed', loaded: 'Loaded',
  'pending-remote': 'Remote install queued',
  activating: 'Activating…', disabled: 'Disabled',
  crashed: 'Crashed', quarantined: 'Quarantined',
};

// ─── Installed extension row ─────────────────────────────────
function ExtensionRow({ ext, onEnable, onDisable, onUninstall, onRestart, onExecuteCommand }) {
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);
  const [actionError, setActionError] = useState(null);
  const isActive = ext.state === 'active';
  const isDisabled = ext.state === 'disabled' || ext.state === 'quarantined';
  const contributedCommands = getContributedCommands(ext);
  const primaryCommands = getPrimaryCommands(contributedCommands);
  const debuggerContributions = getDebuggerContributions(ext);
  const hasDebugger = debuggerContributions.length > 0;
  const quickCommand = primaryCommands[0] || null;

  const runCommand = async (commandId) => {
    if (!onExecuteCommand || !commandId) return;
    setRunningAction(commandId);
    setActionError(null);
    try {
      await onExecuteCommand(commandId);
    } catch (err) {
      setActionError(err?.message || `Failed to run ${commandId}`);
    } finally {
      setRunningAction(null);
    }
  };

  return (
    <div className="border rounded-lg mb-1.5 overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
        style={{ ':hover': undefined }}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-7 h-7 rounded flex items-center justify-center text-sm shrink-0" style={{ background: 'var(--bg-elevated)' }}>
          {ext.icon ? <img src={ext.icon} className="w-5 h-5 rounded" alt="" /> : <Puzzle className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{ext.displayName || ext.name}</span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>v{ext.version}</span>
          </div>
          <div className="text-[10px] truncate" style={{ color: 'var(--text-dim)' }}>
            {ext.publisher}
            {ext.state && ext.state !== 'installed' && (
              <span style={{ color: ext.state === 'crashed' ? 'var(--accent-danger)' : 'var(--text-muted)' }}>
                {' '}· {STATE_LABELS[ext.state] || ext.state}
              </span>
            )}
          </div>
        </div>
        {quickCommand && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              runCommand(quickCommand.id);
            }}
            disabled={!isActive || runningAction === quickCommand.id}
            className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-45"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
            title={quickCommand.id}
          >
            {runningAction === quickCommand.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Run
          </button>
        )}
        <span
          className={`shrink-0 inline-block w-2 h-2 rounded-full ${STATE_PULSE.has(ext.state) ? 'animate-pulse' : ''}`}
          style={STATE_STYLES[ext.state] || { background: 'var(--text-muted)' }}
          title={STATE_LABELS[ext.state] || ext.state}
        />
      </div>
      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>{ext.description || 'No description.'}</p>
          <div className="flex gap-3 text-[10px] mb-2" style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            <span>State: <span style={{ color: 'var(--text-primary)' }}>{STATE_LABELS[ext.state] || ext.state}</span></span>
            {ext.crashCount > 0 && <span style={{ color: 'var(--accent-danger)' }}>Crashes: {ext.crashCount}</span>}
            <span>Activations: {ext.activationCount || 0}</span>
          </div>
          {ext.state === 'quarantined' && (
            <div className="border rounded px-2 py-1.5 text-[11px] mb-2" style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-danger) 30%, transparent)', color: 'var(--accent-danger)' }}>
              ⚠ Quarantined: {ext.quarantineReason || 'Repeated failures'}
            </div>
          )}
          {ext.state === 'crashed' && (
            <div className="border rounded px-2 py-1.5 text-[11px] mb-2" style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-danger) 30%, transparent)', color: 'var(--accent-danger)' }}>
              Failed: {ext.failedReason || 'Extension activation failed'}
            </div>
          )}

          {(primaryCommands.length > 0 || hasDebugger) && (
            <div className="mb-2 border rounded-md" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-elevated) 48%, transparent)' }}>
              <div className="px-2 py-1.5 flex items-center justify-between gap-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Use</span>
                {ext.remote && (
                  <span className="text-[10px]" style={{ color: 'var(--accent-success)' }}>Hosted</span>
                )}
              </div>
              <div className="p-1.5 flex flex-wrap gap-1.5">
                {primaryCommands.map(cmd => (
                  <button
                    key={cmd.id}
                    onClick={() => runCommand(cmd.id)}
                    disabled={!isActive || runningAction === cmd.id}
                    className="inline-flex min-w-0 items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors disabled:opacity-45"
                    style={{ background: 'var(--bg-editor)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                    title={cmd.id}
                  >
                    {runningAction === cmd.id ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <Play className="w-3 h-3 shrink-0" />}
                    <span className="truncate max-w-[170px]">{cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title}</span>
                  </button>
                ))}
              </div>
              {hasDebugger && (
                <div className="px-2 pb-1.5 text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
                  <Bug className="w-3 h-3 shrink-0" />
                  <span>
                    {debuggerContributions.map(d => d.label || d.type).filter(Boolean).join(', ')} debug adapter{debuggerContributions.length === 1 ? '' : 's'} installed
                  </span>
                </div>
              )}
            </div>
          )}

          {actionError && (
            <div className="border rounded px-2 py-1.5 text-[11px] mb-2" style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-danger) 30%, transparent)', color: 'var(--accent-danger)' }}>
              {actionError}
            </div>
          )}

          <div className="flex gap-1.5">
            {isDisabled ? (
              <button onClick={() => onEnable(ext.id)} className="px-2 py-1 text-[11px] rounded" style={{ background: 'var(--accent-success)', color: 'var(--bg-app)' }}>Enable</button>
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
              <span className="flex items-center gap-0.5 shrink-0" style={{ color: 'var(--accent-warning)', fontVariantNumeric: 'tabular-nums' }}>
                <Star className="w-2.5 h-2.5 fill-current" />
                {ext.averageRating.toFixed(1)}
              </span>
            )}
            <span className="shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>{downloads} ↓</span>
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
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [importReport, setImportReport] = useState(null);
  const [importError, setImportError] = useState(null);
  const [vsixTargetId, setVsixTargetId] = useState(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  const importInputRef = useRef(null);
  const missingVsixInputRef = useRef(null);

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
    return installOpenVsxExtension(marketplaceExt, onInstall);
  }, [onInstall]);

  const handleImportFile = useCallback(async (file) => {
    if (!file || !onInstall) return;

    setImporting(true);
    setImportError(null);
    setImportReport(null);

    try {
      const content = await file.text();
      const parsed = parseExtensionImportList(content, { installedIds });
      const report = createEmptyImportReport();
      report.alreadyInstalled = parsed.alreadyInstalled;
      report.invalid = parsed.invalid;

      if (parsed.ids.length === 0) {
        setImportReport(report);
        setImportProgress(null);
        return;
      }

      setImportProgress({ completed: 0, total: parsed.ids.length, current: null });

      await runWithConcurrency(parsed.ids, 2, async (extensionId) => {
        setImportProgress(prev => prev ? { ...prev, current: extensionId } : prev);
        const parts = splitExtensionId(extensionId);
        if (!parts) {
          report.invalid.push(extensionId);
        } else {
          try {
            await installOpenVsxExtension({ namespace: parts.namespace, name: parts.name }, onInstall);
            report.installed.push(extensionId);
          } catch (err) {
            if (err.code === 'OPEN_VSX_NOT_FOUND') {
              report.needsVsix.push(extensionId);
            } else {
              report.failed.push({ id: extensionId, reason: err.message || 'Install failed' });
            }
          }
        }
        setImportProgress(prev => prev ? { ...prev, completed: prev.completed + 1 } : prev);
      });

      setImportReport(report);
    } catch (err) {
      setImportError(err.message || 'Import failed');
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }, [installedIds, onInstall]);

  const handleMissingVsixFile = useCallback(async (file) => {
    if (!file || !vsixTargetId || !onInstall) return;
    if (!file.name.endsWith('.vsix')) {
      setImportError('File must be a .vsix file');
      return;
    }

    setImporting(true);
    setImportError(null);
    try {
      const { parseVSIX } = await import('@/extensions/loader/ExtensionInstaller');
      const buffer = await file.arrayBuffer();
      const vsixBase64 = arrayBufferToBase64(buffer);
      const { manifest, code, nodeCode } = await parseVSIX(buffer);
      if (nodeCode) manifest._nodeCode = nodeCode;
      const extId = `${manifest.publisher || 'unknown'}.${manifest.name}`;
      await onInstall(extId, manifest, code, { source: 'vsix', vsixBase64 });

      setImportReport(prev => {
        const report = prev || createEmptyImportReport();
        return {
          ...report,
          installed: [...report.installed, extId],
          needsVsix: report.needsVsix.filter(id => id !== vsixTargetId),
        };
      });
      setVsixTargetId(null);
    } catch (err) {
      setImportReport(prev => {
        const report = prev || createEmptyImportReport();
        return {
          ...report,
          failed: [...report.failed, { id: vsixTargetId, reason: err.message || 'VSIX install failed' }],
        };
      });
    } finally {
      setImporting(false);
    }
  }, [onInstall, vsixTargetId]);

  const skipMissingVsix = useCallback((extensionId) => {
    setImportReport(prev => {
      const report = prev || createEmptyImportReport();
      return {
        ...report,
        skipped: [...report.skipped, extensionId],
        needsVsix: report.needsVsix.filter(id => id !== extensionId),
      };
    });
  }, []);

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
      const vsixBase64 = arrayBufferToBase64(buffer);
      const { manifest, code, nodeCode } = await parseVSIX(buffer);
      if (nodeCode) manifest._nodeCode = nodeCode;
      const extId = `${manifest.publisher || 'unknown'}.${manifest.name}`;
      await onInstall(extId, manifest, code, { source: 'vsix', vsixBase64 });
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
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}>
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'color-mix(in srgb, var(--bg-sidebar) 72%, var(--bg-editor) 28%)',
        }}
      >
        <Puzzle size={14} className="flex-shrink-0" style={{ color: 'var(--accent-secondary)' }} />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Extensions</span>
        <div className="ml-auto flex items-center gap-0.5">
          <input
            ref={importInputRef}
            type="file"
            accept=".txt,.json,.code-workspace"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFile(file);
              e.target.value = '';
            }}
          />
          <input
            ref={missingVsixInputRef}
            type="file"
            accept=".vsix"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleMissingVsixFile(file);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importing || !ready}
            className="p-1.5 rounded-lg transition-all disabled:opacity-40"
            style={{ color: 'var(--text-muted)' }}
            title="Import extensions"
          >
            {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} /> : <FileUp className="w-3.5 h-3.5" strokeWidth={1.5} />}
          </button>
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
      <div className="px-3 pb-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>

        {/* Tab bar: Installed | Marketplace */}
        <div className="flex gap-0.5 rounded-md p-0.5 mb-2" style={{ background: 'var(--bg-editor)' }}>
          <button
            onClick={() => setTab('installed')}
            className="th-focus-ring flex-1 px-2 py-1 text-[11px] font-medium rounded transition-colors"
            style={tab === 'installed' ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' } : { color: 'var(--text-muted)' }}
          >
            Installed (<span style={{ fontVariantNumeric: 'tabular-nums' }}>{extensions.length}</span>)
          </button>
          <button
            onClick={() => setTab('marketplace')}
            className="th-focus-ring flex-1 px-2 py-1 text-[11px] font-medium rounded transition-colors"
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
              className="th-focus-ring-inset w-full pl-7 pr-7 py-1.5 border rounded text-[12px] transition-colors"
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
              className="relative flex flex-col items-center justify-center gap-1.5 border-2 border-dashed rounded-lg py-4 px-3 cursor-pointer transition-colors"
              style={
                dragOver
                  ? {
                      borderColor: 'color-mix(in srgb, var(--brand-stop-4) 60%, transparent)',
                      background: 'color-mix(in srgb, var(--brand-stop-4) 10%, transparent)',
                    }
                  : { borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }
              }
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
              className="w-full px-3 py-1.5 text-[11px] font-medium rounded-md disabled:opacity-40 transition-colors"
              style={{
                /* Secondary CTA — quieter than the brand-gradient
                   primary on the empty state, but still discoverable.
                   Uses a tinted surface so it reads as "action" without
                   competing with the marketplace primary. */
                background: 'color-mix(in srgb, var(--brand-stop-3) 12%, transparent)',
                color: 'var(--text-primary)',
                border: '1px solid color-mix(in srgb, var(--brand-stop-3) 28%, transparent)',
              }}
            >
              {installing && !vsixFileName ? 'Installing…' : 'Install Hello World Extension'}
            </button>
          </div>

          {installError && (
            <div
              className="text-[11px] rounded px-2 py-1.5"
              style={{
                color: 'var(--accent-danger)',
                background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-danger) 26%, transparent)',
              }}
            >
              {installError}
            </div>
          )}
        </div>
      )}

      {(importProgress || importReport || importError) && tab === 'installed' && (
        <div className="border-b p-3 space-y-2" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {importing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" style={{ color: 'var(--accent-secondary)' }} />
              ) : (
                <FileArchive className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent-secondary)' }} />
              )}
              <span className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                Extension import
              </span>
            </div>
            <button
              onClick={() => {
                setImportReport(null);
                setImportError(null);
                setImportProgress(null);
              }}
              className="p-1 rounded transition-colors"
              style={{ color: 'var(--text-dim)' }}
              title="Clear import report"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          {importProgress && (
            <div>
              <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                <span className="truncate">Installing {importProgress.current || 'extensions'}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{importProgress.completed}/{importProgress.total}</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-editor)' }}>
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${Math.round((importProgress.completed / Math.max(importProgress.total, 1)) * 100)}%`,
                    background: 'var(--accent-secondary)',
                  }}
                />
              </div>
            </div>
          )}

          {importError && (
            <div className="text-[11px] rounded px-2 py-1.5" style={{ color: 'var(--accent-danger)', background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-danger) 26%, transparent)' }}>
              {importError}
            </div>
          )}

          {importReport && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-1 text-[10px]">
                <div className="rounded px-2 py-1" style={{ background: 'var(--bg-editor)', color: 'var(--text-muted)' }}>
                  <span style={{ color: 'var(--accent-success)', fontVariantNumeric: 'tabular-nums' }}>{importReport.installed.length}</span> installed
                </div>
                <div className="rounded px-2 py-1" style={{ background: 'var(--bg-editor)', color: 'var(--text-muted)' }}>
                  <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{importReport.alreadyInstalled.length}</span> existing
                </div>
                <div className="rounded px-2 py-1" style={{ background: 'var(--bg-editor)', color: 'var(--text-muted)' }}>
                  <span style={{ color: importReport.failed.length ? 'var(--accent-danger)' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{importReport.failed.length}</span> failed
                </div>
              </div>

              {importReport.needsVsix.length > 0 && (
                <div className="rounded border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
                  <div className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    Needs VSIX
                  </div>
                  {importReport.needsVsix.map(id => (
                    <div key={id} className="flex items-center gap-1.5 text-[10px]">
                      <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>{id}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setVsixTargetId(id);
                          missingVsixInputRef.current?.click();
                        }}
                        disabled={importing}
                        className="px-2 py-1 rounded transition-colors disabled:opacity-40"
                        style={{ background: 'color-mix(in srgb, var(--accent-secondary) 14%, transparent)', color: 'var(--accent-secondary)' }}
                      >
                        Upload
                      </button>
                      <button
                        type="button"
                        onClick={() => skipMissingVsix(id)}
                        disabled={importing}
                        className="px-2 py-1 rounded transition-colors disabled:opacity-40"
                        style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                      >
                        Skip
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {(importReport.skipped.length > 0 || importReport.invalid.length > 0 || importReport.failed.length > 0) && (
                <div className="space-y-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {importReport.skipped.length > 0 && <div>Skipped: {importReport.skipped.join(', ')}</div>}
                  {importReport.invalid.length > 0 && <div>Invalid: {importReport.invalid.join(', ')}</div>}
                  {importReport.failed.map(item => (
                    <div key={`${item.id}:${item.reason}`} style={{ color: 'var(--accent-danger)' }}>
                      {item.id}: {item.reason}
                    </div>
                  ))}
                </div>
              )}
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
              <span style={{ color: err.severity === 'error' ? 'var(--accent-danger)' : 'var(--accent-warning)' }}>●</span>
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
            <div className="flex flex-col items-center justify-center h-full text-center px-4 relative">
              {/* Soft ambient halo behind the icon — restrained so it
                  reads as a focal moment, not background noise. */}
              <div
                aria-hidden="true"
                className="absolute pointer-events-none"
                style={{
                  width: 120,
                  height: 120,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle, color-mix(in srgb, var(--brand-stop-3) 8%, transparent) 0%, transparent 65%)',
                  filter: 'blur(4px)',
                  top: 'calc(50% - 100px)',
                }}
              />
              <div
                className="relative w-11 h-11 mb-3 rounded-xl flex items-center justify-center"
                style={{
                  background: 'color-mix(in srgb, var(--brand-stop-3) 8%, var(--bg-elevated))',
                  border: '1px solid color-mix(in srgb, var(--brand-stop-3) 22%, transparent)',
                  boxShadow: '0 0 22px -4px color-mix(in srgb, var(--brand-stop-3) 28%, transparent)',
                }}
              >
                <Puzzle className="w-5 h-5" style={{ color: 'var(--accent-secondary)' }} />
              </div>
              <div className="text-[13px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>No extensions yet</div>
              <div className="text-[11px] mb-4 max-w-[220px]" style={{ color: 'var(--text-muted)' }}>
                Click <Plus className="inline w-3 h-3 align-text-bottom" /> to install a test extension, or browse the Marketplace.
              </div>
              <button
                onClick={() => setTab('marketplace')}
                className="px-3.5 py-1.5 text-[11px] font-semibold rounded-md transition-all hover:-translate-y-px"
                style={{
                  background: 'var(--brand-gradient-horizontal)',
                  color: '#ffffff',
                  boxShadow: '0 4px 16px -4px color-mix(in srgb, var(--brand-stop-3) 40%, transparent)',
                }}
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
                onExecuteCommand={onExecuteCommand}
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
              <div
                className="text-[11px] rounded px-2 py-1.5 mb-2"
                style={{
                  color: 'var(--accent-danger)',
                  background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent-danger) 26%, transparent)',
                }}
              >
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
                <div className="text-[10px] mb-1.5 px-1" style={{ color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
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
