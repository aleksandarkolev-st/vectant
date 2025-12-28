"use client";

import { useEffect, useState, useMemo } from 'react';
import { Search, TerminalSquare, Play, Settings, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { toggleAutoSave, selectAutoSaveEnabled, toggleAutoCompletion, selectAutoCompletionEnabled } from '@/redux/uiSlice';
import { selectActiveFile, selectFilesTree, selectFileThunk } from '@/redux/workspaceSlice';
import { getFileIcon } from '@/utils/fileIcons';
import { toast } from 'sonner';

export default function TopNav({ 
  title, 
  onRun, 
  runInGuiMode,
  setRunInGuiMode,
  useAiSplit,
  setUseAiSplit,
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
    <div className="flex items-center h-9 px-2 border-b border-[#1c1d26] bg-[#0a0b10] space-x-4 shadow-sm font-[var(--font-ui)]">
      <div className="flex items-center h-full">
          <img src="/synthi-logo.svg" alt="Synthi" className="h-22 w-auto" />
      </div>
      <div className="relative transition-all duration-200" 
           style={{ width: searchOpen ? '400px' : '200px' }}>
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6b7089]" strokeWidth={1.5} />
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
          placeholder={searchOpen ? "Search files, symbols, commands…" : title}
          className="w-full h-7 bg-[#0d0e14] text-sm text-[#f0f2f5] rounded-lg pl-8 pr-3 py-1.5 outline-none border border-[#1c1d26] focus:border-[#327464] focus:ring-2 focus:ring-[#327464]/20 transition-all duration-200 placeholder:text-[#6b7089]"
        />
        {/* Search Results Dropdown */}
        {searchOpen && searchText && (
          <div className="w-full mt-1 bg-[#0d0e14] border border-[#1c1d26] rounded-lg shadow-lg z-[100] max-h-60 overflow-y-auto">
            {searchResults.length > 0 ? (
              searchResults.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center px-3 py-2.5 cursor-pointer hover:bg-[#32746415] text-sm text-[#f0f2f5]"
                  onClick={() => handleFileSelect(file)}
                >
                  <span className="mr-2.5 flex-shrink-0 text-base">{getFileIcon(file.name)}</span>
                  <div className="flex flex-col overflow-hidden min-w-0">
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="truncate text-xs text-[#6b7089]">{file.path}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="px-3 py-2.5 text-sm text-[#6b7089]">No results found</div>
            )}
          </div>
        )}
      </div>
      <div className="flex-1" />
        <div className="flex items-center gap-2">
        {/* Terminal Toggle - Icon Only */}
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-8 w-8 p-0 text-[#a8adc0] hover:bg-[#1c1d26] hover:text-[#f0f2f5] cursor-pointer duration-300 hover:-translate-y-0.5 transition-all rounded-lg" 
          onClick={onToggleTerminal}
          title="Toggle Terminal"
        >
          <TerminalSquare className="w-4 h-4" strokeWidth={2} />
        </Button>
        
        
        {/* Chat Toggle - Icon Only */}
        <Button 
          variant="ghost" 
          size="sm" 
          className={`h-8 w-8 p-0 text-[#a8adc0] hover:bg-[#1c1d26] hover:text-[#f0f2f5] cursor-pointer transition-colors duration-300 hover:-translate-y-0.5 transition-all rounded-lg ${chatVisible ? 'text-[#327464] bg-[#32746415] border border-[#32746440]' : ''}`} 
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
          className={`h-8 px-2 text-xs font-medium transition-colors rounded-lg cursor-pointer duration-300 hover:-translate-y-0.5 transition-all ${
            runInGuiMode 
              ? 'text-[#327464] bg-[#32746415] border border-[#32746440]' 
              : 'text-[#a8adc0] hover:bg-[#1c1d26] hover:text-[#f0f2f5]'
          }`}
          onClick={() => setRunInGuiMode(!runInGuiMode)}
          title={runInGuiMode ? "Run in GUI Mode" : "Run in Console Mode"}
        >
          {runInGuiMode ? "GUI" : "Console"}
        </Button>

        {/* AI Split Toggle */}
        <Button
          variant="ghost"
          size="sm"
          className={`h-8 px-2 text-xs font-medium transition-colors rounded-lg cursor-pointer duration-300 hover:-translate-y-0.5 transition-all ${
            useAiSplit 
              ? 'text-[#327464] bg-[#32746415] border border-[#32746440]' 
              : 'text-[#a8adc0] hover:bg-[#1c1d26] hover:text-[#f0f2f5]'
          }`}
          onClick={() => setUseAiSplit(!useAiSplit)}
          title={useAiSplit ? "AI HMR Enabled" : "AI HMR Disabled"}
        >
          {useAiSplit ? "AI HMR" : "Std HMR"}
        </Button>

        <Button
          size="sm" 
          className="h-8 w-8 p-0 transition-colors rounded-lg bg-[#0a0b10] hover:bg-[#1c1d26] cursor-pointer duration-300 hover:-translate-y-0.5 transition-all" 
          onClick={onRun}
          title="Run Code"
        >
          <Play className="w-4 h-4 text-[#327464]" strokeWidth={2} />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 text-[#a8adc0] hover:bg-[#1c1d26] hover:text-[#f0f2f5] duration-300 hover:-translate-y-0.5 transition-all cursor-pointer rounded-lg"
            >
              <Settings className="w-4 h-4" strokeWidth={2} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[320px] bg-[#0d0e14] border-[#1c1d26] p-1 shadow-xl rounded-lg" style={{ backgroundColor: '#0d0e14'}}>
            <div className="text-xs text-[#6b7089] font-semibold p-2">Settings</div>
            <div className="flex flex-col">
              {/* Auto-save toggle */}
              <div className="flex items-center justify-between py-2 px-1">
                <span className="text-sm text-[#f0f2f5]">Auto Save</span>
                <button
                  onClick={() => dispatch(toggleAutoSave())}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${
                    autoSaveEnabled ? 'bg-gradient-to-r from-[#327464] to-[#3d8b78]' : 'bg-[#32334a]'
                  }`}
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
                <span className="text-sm text-[#f0f2f5]">AI Auto Completion</span>
                <button
                  onClick={() => {
                    dispatch(toggleAutoCompletion());
                    toast(autoCompletionEnabled ? 'AI Auto Completion disabled' : 'AI Auto Completion enabled', {
                      duration: 2000,
                    });
                  }}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${
                    autoCompletionEnabled ? 'bg-gradient-to-r from-[#327464] to-[#3d8b78]' : 'bg-[#32334a]'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
                      autoCompletionEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              <div className="border-t border-[#1c1d26] my-1"></div>
              <div className="text-xs text-[#6b7089] font-semibold p-2">Quick actions</div>
              <button className="flex justify-between items-center w-full text-left text-sm px-2 py-2 text-[#f0f2f5] hover:text-[#327464] hover:bg-[#32746415] rounded-lg transition-colors" onClick={onRun}>
                <span>Run current file</span>
                <span className="text-xs text-[#6b7089]">F5</span>
              </button>
              <button className="flex justify-between items-center w-full text-left text-sm px-2 py-2 text-[#f0f2f5] hover:text-[#327464] hover:bg-[#32746415] rounded-lg transition-colors" onClick={onToggleTerminal}>
                <span>Toggle terminal</span>
                <span className="text-xs text-[#6b7089]">Ctrl+`</span>
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
