"use client";

import { memo, useEffect, useState, useMemo } from 'react';
import { Search, TerminalSquare, Play, Settings, MessageSquare, Square, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { splitEditorPanel } from '@/components/docking-wm/state/layout-slice';
import { toggleAutoSave, selectAutoSaveEnabled, toggleAutoCompletion, selectAutoCompletionEnabled } from '@/redux/uiSlice';
import { selectActiveFile, selectFilesTree, selectFileThunk } from '@/redux/workspaceSlice';
import { getFileIcon } from '@/utils/fileIcons';
import { toast } from 'sonner';
import CollabToolbar from '@/components/collaboration/CollabToolbar';
import { useTheme } from '@/components/ThemeProvider';
import { EditorTabStrip } from '@/components/EditorTabStrip';

function TopNav({ 
  title, 
  onRun, 
  runInGuiMode,
  setRunInGuiMode,
  hmrEnabled,
  setHmrEnabled,
  gpuModeEnabled,
  setGpuModeEnabled,
  gpuTarget = 'auto',
  setGpuTarget,
  onStop,
  onReload,
  isRunning,
  onToggleTerminal, 
  onUndo,  
  onRedo, 
  onCommandPalette,
  onToggleChat, 
  chatVisible,
  onNewFile,
  onNewFolder,
  onSave,
  onCopyLineUp,
  onCopyLineDown,
  onMoveLineUp,
  onMoveLineDown,
  onDuplicateSelection
}) {
  const dispatch = useAppDispatch();
  const slug = useAppSelector(state => state.workspace.slug);
  const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
  const autoCompletionEnabled = useAppSelector(selectAutoCompletionEnabled);
  const activeFile = useAppSelector(selectActiveFile);
  const filesTree = useAppSelector(selectFilesTree);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');

  // Flatten files tree for search
  const allFiles = useMemo(() => {
    const files = [];
    const traverse = (nodes) => {
      if (!nodes) return;
      nodes.forEach(node => {
        if (!node.isFolder) {
          files.push(node);
        }
        if (node.children) {
          traverse(node.children);
        }
      });
    };
    traverse(filesTree);
    return files;
  }, [filesTree]);

  const { resolvedTheme } = useTheme();
  const isLightTheme = resolvedTheme?.type === 'light';

  const searchResults = useMemo(() => {
    if (!searchText.trim()) return [];
    const lower = searchText.toLowerCase();
    return allFiles.filter(f => f.name.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower)).slice(0, 10);
  }, [allFiles, searchText]);

  const handleFileSelect = (file) => {
    dispatch(selectFileThunk(file));
    setSearchText('');
    setSearchOpen(false);
  };

  const handleSplitEditor = () => {
    dispatch(splitEditorPanel());
  };

  // Compact placeholder for the search field. When idle, prefer the
  // active filename; only fall back to the wordy workspace title when
  // there's nothing else to surface — and even then keep it short so
  // it doesn't truncate at 200px width.
  const idlePlaceholder = activeFile?.name || 'Search files, symbols…';

  return (
    <div
      className="topnav-root vt-ambient-bottom relative flex items-center h-10 px-2 border-b space-x-2 font-[var(--font-ui)]"
      style={{ background: 'var(--bg-app)', borderColor: 'var(--border-subtle)' }}
    >
      {/* Vectant wordmark — left-anchored so the centered slot can host
          the lifted file-tab strip without collision. Dark theme is +2px
          because its strokes are visibly thinner than the light variant. */}
      <div className="flex items-center justify-center h-full flex-shrink-0 pl-1 pr-2 select-none">
        <img
          src={isLightTheme ? '/vectant-light-theme.png' : '/vectant-dark-theme.png'}
          alt="Vectant"
          className={`block w-auto object-contain ${isLightTheme ? 'h-[22px]' : 'h-[24px]'}`}
          draggable={false}
        />
      </div>
      <div
        className="topnav-search relative transition-all duration-200 hidden sm:block min-w-0"
        style={{ width: searchOpen ? '420px' : '240px', maxWidth: '100%' }}
      >
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} strokeWidth={1.5} />
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
          placeholder={searchOpen ? "Search files, symbols, commands…" : idlePlaceholder}
          className="w-full h-6 th-input text-[12px] rounded-md pl-8 pr-3 outline-none border transition-all duration-200"
        />
        {/* Search Results Dropdown */}
        {searchOpen && searchText && (
          <div className="absolute left-0 right-0 top-full mt-1 th-surface-dropdown border rounded-lg shadow-lg z-[100] max-h-60 overflow-y-auto">
            {searchResults.length > 0 ? (
              searchResults.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center px-3 py-2.5 cursor-pointer th-dropdown-item text-sm"
                  onClick={() => handleFileSelect(file)}
                >
                  <span className="mr-2.5 flex-shrink-0 text-base">{getFileIcon(file.name)}</span>
                  <div className="flex flex-col overflow-hidden min-w-0">
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>{file.path}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="px-3 py-2.5 text-sm" style={{ color: 'var(--text-muted)' }}>No results found</div>
            )}
          </div>
        )}
      </div>

      {/* Smart strip — open file tabs lifted into the TopNav row.
          Click-only, edge-fades into the surrounding chrome at both ends,
          horizontally scrollable when there are more tabs than fit. The
          outer flex-1 lets the strip soak up the remaining row width so
          the search bar's focus-expand animation is visible (the strip
          shrinks smoothly as the search bar grows). */}
      <div className="topnav-tabs flex-1 min-w-0 h-full flex items-center justify-center px-2 lg:px-3">
        <div className="w-full max-w-[760px] xl:max-w-[860px] h-full flex items-center min-w-0">
          <EditorTabStrip />
        </div>
      </div>

        {/* Collaboration — avatars, inbox, history, session share, knocks.
            Hidden on narrow widths to keep the run controls reachable. */}
        {slug && (
          <div className="hidden lg:flex items-center">
            <CollabToolbar slug={slug} filePath={activeFile?.path} />
          </div>
        )}

        <div className="flex items-center gap-2 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="hidden sm:inline-flex h-7 w-7 p-0 th-btn-ghost cursor-pointer duration-200 hover:-translate-y-0.5 transition-all rounded-md"
          onClick={handleSplitEditor}
          title="Split editor in two"
          aria-label="Split editor in two"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1.25" y="2" width="11.5" height="10" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7 2.6V11.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </Button>

        {/* Terminal Toggle - Icon Only */}
        <Button
          variant="ghost"
          size="sm"
          className="hidden sm:inline-flex h-7 w-7 p-0 th-btn-ghost cursor-pointer duration-200 hover:-translate-y-0.5 transition-all rounded-md"
          onClick={onToggleTerminal}
          aria-label="Toggle terminal"
          title="Toggle Terminal"
        >
          <TerminalSquare className="w-4 h-4" strokeWidth={2} />
        </Button>
        
        
        {/* Chat Toggle - Icon Only */}
        <Button 
          variant="ghost" 
          size="sm" 
          className={`h-7 w-7 p-0 th-btn-ghost cursor-pointer transition-all duration-200 hover:-translate-y-0.5 rounded-md ${chatVisible ? 'th-btn-active' : ''}`}
          onClick={onToggleChat}
          aria-label="Toggle Chat"
          title="Toggle Chat"
        >
          <MessageSquare className="w-4 h-4" strokeWidth={2} />
        </Button>

        {/* Run / Stop / Reload — primary moment.
            Desktop (sm:+): only the Run button lives here. While running
            it greys out and is non-clickable; the actual Stop + Restart
            live in the build-controls island next to the status bar.
            Mobile (< sm): Stop + Restart replace the run button here. */}
            
        {/* GPU Pipeline Toggle - desktop only.
            Persistent "GPU" label + on/off dot. Earlier we flipped the
            label between "GPU" and "No GPU" — readable enough, but you
            had to scan the text to know the state. A coloured dot is
            parseable at a glance and matches how status is signalled
            elsewhere in the chrome (status island, collab pill). */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={gpuModeEnabled ? "Disable GPU pipeline" : "Enable GPU pipeline"}
          aria-pressed={gpuModeEnabled}
          className={`hidden xl:inline-flex items-center gap-1.5 h-8 px-2 text-xs font-medium transition-colors rounded-lg cursor-pointer duration-300 hover:-translate-y-0.5 transition-all th-btn-ghost ${gpuModeEnabled ? 'th-btn-active' : ''}`}
          onClick={() => setGpuModeEnabled(!gpuModeEnabled)}
          title={gpuModeEnabled ? `GPU pipeline enabled (${gpuTarget.toUpperCase()})` : "GPU pipeline disabled"}
        >
          <span
            aria-hidden="true"
            className="inline-block w-1.5 h-1.5 rounded-full transition-colors"
            style={{
              background: gpuModeEnabled ? 'var(--accent-success)' : 'var(--text-muted)',
              boxShadow: gpuModeEnabled ? '0 0 6px color-mix(in srgb, var(--accent-success) 60%, transparent)' : 'none',
            }}
          />
          <span>GPU</span>
        </Button>
        {isRunning ? (
            <>
                {/* Mobile-only: stop + restart in topnav */}
                <Button
                    size="sm"
                    className="sm:hidden h-7 w-7 p-0 transition-all rounded-md th-bg-app th-btn-ghost cursor-pointer duration-200 hover:-translate-y-0.5 text-red-500 hover:text-red-400"
                    onClick={onStop}
                    aria-label="Stop running app"
                    title="Stop"
                >
                    <Square className="w-3.5 h-3.5 fill-current" strokeWidth={2} />
                </Button>
                <Button
                    size="sm"
                    className="sm:hidden h-7 w-7 p-0 transition-all rounded-md th-bg-app th-btn-ghost cursor-pointer duration-200 hover:-translate-y-0.5"
                    onClick={onReload}
                    style={{ color: '#3d6dff' }}
                    aria-label="Restart running app"
                    title="Restart"
                >
                    <RotateCw className="w-3.5 h-3.5" strokeWidth={2} />
                </Button>
                {/* Desktop-only: disabled, greyed-out run button */}
                <Button
                    size="sm"
                    disabled
                    aria-disabled="true"
                    aria-label="App is running"
                    className="hidden sm:inline-flex h-7 w-7 p-0 rounded-md th-bg-app cursor-not-allowed opacity-40"
                    title="Running — use the stop/restart controls"
                >
                    <Play className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} strokeWidth={2} />
                </Button>
            </>
        ) : (
            <Button
                size="sm"
                className="h-7 w-7 p-0 transition-all rounded-md th-bg-app th-btn-ghost cursor-pointer duration-200 hover:-translate-y-0.5"
                onClick={onRun}
                aria-label="Run code"
                title="Run Code"
            >
                <Play className="w-3.5 h-3.5" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
            </Button>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Open settings"
              title="Settings"
              className="h-7 w-7 p-0 th-btn-ghost duration-200 hover:-translate-y-0.5 transition-all cursor-pointer rounded-md"
            >
              <Settings className="w-3.5 h-3.5" strokeWidth={2} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[320px] th-surface-dropdown p-1 shadow-xl rounded-lg border">
            {/* Run mode + HMR moved here: secondary controls, not primary chrome */}
            <div className="text-xs font-semibold p-2" style={{ color: 'var(--text-muted)' }}>Run options</div>
            <div className="flex flex-col">
              <div className="flex items-center justify-between py-1.5 px-2">
                <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>Run mode</span>
                <button
                  onClick={() => setRunInGuiMode(!runInGuiMode)}
                  className="text-[11px] font-semibold px-2 py-0.5 rounded transition-colors"
                  style={{
                    background: runInGuiMode ? 'color-mix(in srgb, var(--attention-purple) 12%, transparent)' : 'var(--bg-elevated)',
                    color: runInGuiMode ? 'var(--attention-purple)' : 'var(--text-secondary)',
                    border: runInGuiMode ? '1px solid color-mix(in srgb, var(--attention-purple) 30%, transparent)' : '1px solid var(--border-subtle)',
                  }}
                >
                  {runInGuiMode ? 'GUI' : 'Console'}
                </button>
              </div>
              <div className="flex items-center justify-between py-1.5 px-2">
                <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>Hot reload</span>
                <button
                  onClick={() => setHmrEnabled(!hmrEnabled)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${hmrEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${hmrEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }}></div>
            <div className="text-xs font-semibold p-2" style={{ color: 'var(--text-muted)' }}>Settings</div>
            <div className="flex flex-col">
              {/* Auto-save toggle */}
              <div className="flex items-center justify-between py-2 px-1">
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>Auto Save</span>
                <button
                  onClick={() => dispatch(toggleAutoSave())}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${autoSaveEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
                      autoSaveEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {/* AI Auto-completion toggle */}
              <div className="flex items-center justify-between py-2 px-1">
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>AI Auto Completion</span>
                <button
                  onClick={() => {
                    dispatch(toggleAutoCompletion());
                    toast(autoCompletionEnabled ? 'AI Auto Completion disabled' : 'AI Auto Completion enabled', {
                      duration: 2000,
                    });
                  }}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${autoCompletionEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
                      autoCompletionEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }}></div>
              <div className="flex items-center justify-between py-2 px-1 gap-3">
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>GPU Target</span>
                <div className="inline-flex rounded-md border p-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
                  {['auto', 'cuda', 'rocm'].map((target) => (
                    <button
                      key={target}
                      type="button"
                      onClick={() => {
                        setGpuTarget?.(target);
                        toast(`GPU target set to ${target.toUpperCase()}`, { duration: 1600 });
                      }}
                      className={`px-2 py-1 text-[11px] rounded transition-colors ${gpuTarget === target ? 'th-btn-active' : 'th-btn-ghost'}`}
                      title={`Use ${target.toUpperCase()} for GPU HMR compile requests`}
                    >
                      {target.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }}></div>
              <div className="text-xs font-semibold p-2" style={{ color: 'var(--text-muted)' }}>Quick actions</div>
              <button className="flex justify-between items-center w-full text-left text-sm px-2 py-2 th-action rounded-lg transition-colors" onClick={onRun}>
                <span>Run current file</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>F5</span>
              </button>
              <button className="flex justify-between items-center w-full text-left text-sm px-2 py-2 th-action rounded-lg transition-colors" onClick={onToggleTerminal}>
                <span>Toggle terminal</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Ctrl+`</span>
              </button>
            </div>
            </div>
          </PopoverContent>
        </Popover>
        </div>
    </div>
  );
}

export default memo(TopNav);
