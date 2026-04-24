"use client";

import { memo, useEffect, useState, useMemo } from 'react';
import { Search, TerminalSquare, Play, Settings, MessageSquare, Square, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { toggleAutoSave, selectAutoSaveEnabled, toggleAutoCompletion, selectAutoCompletionEnabled } from '@/redux/uiSlice';
import { selectActiveFile, selectFilesTree, selectFileThunk } from '@/redux/workspaceSlice';
import { getFileIcon } from '@/utils/fileIcons';
import { toast } from 'sonner';
import CollabToolbar from '@/components/collaboration/CollabToolbar';
import { useTheme } from '@/components/ThemeProvider';

function TopNav({ 
  title, 
  onRun, 
  runInGuiMode,
  setRunInGuiMode,
  hmrEnabled,
  setHmrEnabled,
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

  return (
    <div className="flex items-center h-9 px-2 border-b space-x-4 shadow-sm font-[var(--font-ui)]" style={{ background: 'var(--bg-app)', borderColor: 'var(--border-subtle)' }}>
      <div className="flex items-center h-full">
          <img src={isLightTheme ? '/synthi-dark-logo.svg' : '/synthi-logo.svg'} alt="Synthi" className="h-22 w-auto" />
      </div>
      <div className="relative transition-all duration-200" 
           style={{ width: searchOpen ? '400px' : '200px' }}>
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} strokeWidth={1.5} />
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
          placeholder={searchOpen ? "Search files, symbols, commands…" : title}
          className="w-full h-7 th-input text-sm rounded-lg pl-8 pr-3 py-1.5 outline-none border transition-all duration-200"
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
      <div className="flex-1" />

        {/* Collaboration — avatars, inbox, history, session share, knocks */}
        {slug && <CollabToolbar slug={slug} filePath={activeFile?.path} />}

        <div className="flex items-center gap-2">
        {/* Terminal Toggle - Icon Only */}
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-8 w-8 p-0 th-btn-ghost cursor-pointer duration-300 hover:-translate-y-0.5 transition-all rounded-lg" 
          onClick={onToggleTerminal}
          title="Toggle Terminal"
        >
          <TerminalSquare className="w-4 h-4" strokeWidth={2} />
        </Button>
        
        
        {/* Chat Toggle - Icon Only */}
        <Button 
          variant="ghost" 
          size="sm" 
          className={`h-8 w-8 p-0 th-btn-ghost cursor-pointer transition-colors duration-300 hover:-translate-y-0.5 transition-all rounded-lg ${chatVisible ? 'th-btn-active' : ''}`} 
          onClick={onToggleChat}
          aria-label="Toggle Chat"
          title="Toggle Chat"
        >
          <MessageSquare className="w-4 h-4" strokeWidth={2} />
        </Button>

        {/* GUI Mode Toggle */}
        <Button
          variant="ghost"
          size="sm"
          className={`h-8 px-2 text-xs font-medium transition-colors rounded-lg cursor-pointer duration-300 hover:-translate-y-0.5 transition-all th-btn-ghost ${runInGuiMode ? 'th-btn-active' : ''}`}
          onClick={() => setRunInGuiMode(!runInGuiMode)}
          title={runInGuiMode ? "Run in GUI Mode" : "Run in Console Mode"}
        >
          {runInGuiMode ? "GUI" : "Console"}
        </Button>

        {/* HMR Toggle - auto-recompile on save */}
        <Button
          variant="ghost"
          size="sm"
          className={`h-8 px-2 text-xs font-medium transition-colors rounded-lg cursor-pointer duration-300 hover:-translate-y-0.5 transition-all th-btn-ghost ${hmrEnabled ? 'th-btn-active' : ''}`}
          onClick={() => setHmrEnabled(!hmrEnabled)}
          title={hmrEnabled ? "HMR Enabled — app restarts on save" : "HMR Disabled — save does not restart app"}
        >
          {hmrEnabled ? "HMR" : "No HMR"}
        </Button>

        {isRunning ? (
            <>
                <Button
                    size="sm" 
                    className="h-8 w-8 p-0 transition-colors rounded-lg th-bg-app th-btn-ghost cursor-pointer duration-300 hover:-translate-y-0.5 transition-all text-red-500 hover:text-red-400" 
                    onClick={onStop}
                    title="Stop Code"
                >
                    <Square className="w-4 h-4 fill-current" strokeWidth={2} />
                </Button>
                <Button
                    size="sm" 
                    className="h-8 w-8 p-0 transition-colors rounded-lg th-bg-app th-btn-ghost cursor-pointer duration-300 hover:-translate-y-0.5 transition-all" 
                    onClick={onReload}
                    style={{ color: 'var(--accent-primary)' }}
                    title="Reload Code"
                >
                    <RotateCw className="w-4 h-4" strokeWidth={2} />
                </Button>
            </>
        ) : (
            <Button
                size="sm" 
                className="h-8 w-8 p-0 transition-colors rounded-lg th-bg-app th-btn-ghost cursor-pointer duration-300 hover:-translate-y-0.5 transition-all" 
                onClick={onRun}
                title="Run Code"
            >
                <Play className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} strokeWidth={2} />
            </Button>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 th-btn-ghost duration-300 hover:-translate-y-0.5 transition-all cursor-pointer rounded-lg"
            >
              <Settings className="w-4 h-4" strokeWidth={2} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[320px] th-surface-dropdown p-1 shadow-xl rounded-lg border">
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
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

export default memo(TopNav);
