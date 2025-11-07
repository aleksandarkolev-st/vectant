"use client";

import { useEffect, useState } from 'react';
import { Search, TerminalSquare, Play, Settings, Undo2, Redo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { toggleAutoSave, selectAutoSaveEnabled, startCreate } from '@/redux/uiSlice';
import { selectActiveFile, selectFilesTree, saveFileContentThunk } from '@/redux/workspaceSlice';

export default function TopNav({ title, onRun, onToggleTerminal, onUndo, onRedo }) {
  const dispatch = useAppDispatch();
  const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
  const activeFile = useAppSelector(selectActiveFile);
  const filesTree = useAppSelector(selectFilesTree);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);

  const handleSave = async () => {
    if (!activeFile) return;
    
    try {
      await dispatch(saveFileContentThunk()).unwrap();
      console.log('File saved successfully');
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  };

  const getTargetFolder = (activeFile, filesTree) => {
  // Safety check: ensure filesTree is an array
  if (!filesTree || !Array.isArray(filesTree)) {
    console.warn('filesTree is not an array:', filesTree);
    return null;
  }
  
  if (!activeFile) return null;
  
  // If active file is a folder, use it
  if (activeFile.isFolder) {
    return activeFile;
  }
  
  // Otherwise, find the parent folder
  const findParentFolder = (nodes, targetPath) => {
    if (!Array.isArray(nodes)) return null;
    
    for (const node of nodes) {
      if (node.isFolder && node.children && Array.isArray(node.children)) {
        // Check if this folder contains the target file
        const hasChild = node.children.some(child => child.path === targetPath);
        if (hasChild) {
          return node;
        }
        // Recursively search in children
        const found = findParentFolder(node.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  };
  
  return findParentFolder(filesTree, activeFile.path);
};


  return (
    <div className="flex items-center h-10 px-3 border-b border-[#2a2a2a] bg-[#1e1e1e] space-x-4">
      <div className="h-26 w-auto">
        <img src="/synthi-logo.svg" alt="Synthi" className="h-full w-auto" />
      </div>
      
      {/* Search bar */}
      <div className="relative transition-all duration-200" 
           style={{ width: searchOpen ? '400px' : '200px' }}>
        <Search className="absolute left-2   top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setSearchOpen(false)}
          placeholder={searchOpen ? "Search files, symbols, commands…" : title}
          className="w-full h-7 bg-[#262626] text-sm text-gray-100 rounded-md pl-8 pr-3 py-1.5 outline-none border border-[#3b3b3b] focus:border-emerald-500 transition-all duration-200"
        />
      </div>

      <div className="flex-1 flex items-center gap-2">
        <Popover open={isFileMenuOpen} onOpenChange={setIsFileMenuOpen}>
          <PopoverTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              className="h-7 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
            >
              File
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[220px] border-[#262626] p-1" style={{ backgroundColor: '#262626'}}>
            <div className="flex flex-col text-sm">
              <button 
                className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors"
                onClick={() => {
                  const target = getTargetFolder(activeFile, filesTree);
                  dispatch(startCreate({ type: 'file', target }));
                }}
              >
                New File
              </button>
              <button 
                className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors"
                onClick={() => {
                  const target = getTargetFolder(activeFile, filesTree);
                  dispatch(startCreate({ type: 'folder', target }));
                }}
              >
                New Folder
              </button>
              <div className="border-t border-[#3a3a3a] my-1"></div>
              <button className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                Open File
              </button>
              <button className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                Open Folder
              </button>
              <div className="border-t border-[#3a3a3a] my-1"></div>
              <button 
                className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSave().finally(() => {
                    setIsFileMenuOpen(false);
                  });
                }}
                disabled={!activeFile}
              >
                Save
              </button>
              <button className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                Save As
              </button>
            </div>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              className="h-7 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
            >
              Edit
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[220px] border-[#262626] p-0" style={{ backgroundColor: '#262626' }}>
            <div className="flex flex-col p-1">
              <button 
                className="flex justify-between items-center w-full px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors"
                onClick={onUndo}
              >
                <span>Undo</span>
                <span className="text-xs text-gray-400">Ctrl+Z</span>
              </button>
              <button 
                className="flex justify-between items-center w-full px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors"
                onClick={onRedo}
              >
                <span>Redo</span>
                <span className="text-xs text-gray-400">Ctrl+Y</span>
              </button>
              <div className="border-t border-[#3a3a3a] my-1"></div>
              <button className="flex justify-between items-center w-full px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                <span>Cut</span>
                <span className="text-xs text-gray-400">Ctrl+X</span>
              </button>
              <button className="flex justify-between items-center w-full px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                <span>Copy</span>
                <span className="text-xs text-gray-400">Ctrl+C</span>
              </button>
              <button className="flex justify-between items-center w-full px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                <span>Paste</span>
                <span className="text-xs text-gray-400">Ctrl+V</span>
              </button>
              <div className="border-t border-[#3a3a3a] my-1"></div>
              <button className="flex justify-between items-center w-full px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                <span>Find</span>
                <span className="text-xs text-gray-400">Ctrl+F</span>
              </button>
              <button className="flex justify-between items-center w-full px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                <span>Replace</span>
                <span className="text-xs text-gray-400">Ctrl+H</span>
              </button>
            </div>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              className="h-7 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
            >
              Selection
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[220px] border-[#262626] p-1" style={{ backgroundColor: '#262626'}}>
            <div className="flex flex-col text-sm">
              <button className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                Select All
              </button>
              <button className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                Expand Selection
              </button>
            </div>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              className="h-7 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
            >
              View
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[220px] border-[#262626] p-1" style={{ backgroundColor: '#262626'}}>
            <div className="flex flex-col text-sm">
              <button className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                Open View...
              </button>
              <button className="flex items-center w-full px-3 py-1.5 text-gray-200 hover:bg-[#2a2d2e] hover:text-emerald-400 hover:rounded-md text-left transition-colors">
                Appearence
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex items-center gap-2">
        <Button 
          variant="outline" 
          size="sm" 
          className="h-7 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors" 
          onClick={onToggleTerminal}
        >
          <TerminalSquare className="w-4 h-4" /> Terminal
        </Button>
        
        <Button 
          variant="outline" 
          size="sm" 
          className="h-7 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors" 
          onClick={onRun}
        >
          <Play className="w-4 h-4 " /> Run
        </Button>
        
        <Popover>
          <PopoverTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 text-gray-200 hover:bg-[#2a2a2a] hover:text-emerald-400 transition-colors"
            >
              <Settings className="w-4 h-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[220px] bg-[#262626] border-[#3a3a3a] border-[#262626]" style={{ backgroundColor: '#262626'}}>
            <div className="text-xs text-gray-400 mb-2 font-semibold">Settings</div>
            <div className="flex flex-col">
              {/* Auto-save toggle */}
              <div className="flex items-center justify-between py-1">
                <span className="text-sm px-1 text-gray-200">Auto Save</span>
                <button
                  onClick={() => dispatch(toggleAutoSave())}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    autoSaveEnabled ? 'bg-emerald-500' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoSaveEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              <div className="border-t border-[#3a3a3a] my-1"></div>
              <div className="text-xs text-gray-400 mb-1 font-semibold">Quick actions</div>
              <button className="text-left text-sm px-1 py-1.5 text-gray-200 hover:text-emerald-400 hover:bg-[#2a2d2e] hover:rounded-md transition-colors" onClick={onRun}>
                Run current file
              </button>
              <button className="text-left text-sm px-1 py-1.5 text-gray-200 hover:text-emerald-400 hover:bg-[#2a2d2e] hover:rounded-md transition-colors" onClick={onToggleTerminal}>
                Toggle terminal
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}