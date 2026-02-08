"use client"
import { useState, useRef, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { 
    selectFilesTree, 
    selectActiveFile, 
    handleCreateItemThunk, 
    handleRenameItemThunk, 
    deleteItemThunk, 
    selectFileThunk 
} from '@/redux/workspaceSlice';
import {
    selectUiActionState,
    setUiActionName,
    cancelUiAction,
    startCreate,
    startRename,
    selectTreeOnRight
} from '@/redux/uiSlice';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { PanelLeftClose, PanelRightClose } from 'lucide-react';
import { getFileIcon, FolderIcon } from '@/utils/fileIcons';
import FileItem from './FileItem';

const FileTreeView = ({
    onToggleOrientation,
}) => {
    const dispatch = useAppDispatch();

    // State pulled from Redux
    const files = useAppSelector(selectFilesTree);
    const activeFile = useAppSelector(selectActiveFile);
    const uiActionState = useAppSelector(selectUiActionState);
    const isRightSide = useAppSelector(selectTreeOnRight);
    
    // inputRef retained ONLY for root-level creation (target: null)
    const inputRef = useRef(null); 
    const [contextTarget, setContextTarget] = useState(null);
    const [isTreeHovered, setIsTreeHovered] = useState(false);
    const { mode, target, name } = uiActionState;
    const isCreating = mode.startsWith('create');
    const isRenaming = mode === 'rename';
    const isCreatingFile = mode === 'create-file';
    const isCreatingFolder = mode === 'create-folder';

    const findParentFolderPath = (nodes, targetPath, parentPath = null) => {
      for (const node of nodes || []) {
        if (node?.path === targetPath) return parentPath;
        if (node?.isFolder && node?.children?.length) {
          const found = findParentFolderPath(node.children, targetPath, node.path);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };

    const activeFolderPath = activeFile?.path
      ? (activeFile?.isFolder ? activeFile.path : (findParentFolderPath(files, activeFile.path) ?? null))
      : undefined;
    
    // Helper for context menu - uses unique path for correct identification
    const findNodeByPath = (nodes, path) => {
        const stack = [...nodes];
        while (stack.length) {
            const n = stack.shift();
            if (n.path === path) return n;
            if (n.isFolder && n.children) stack.push(...n.children);
        }
        return null;
    };

    // Focus hook for root-level creation
    useEffect(() => {
      if (isCreating && !target && inputRef.current) {
        // Use requestAnimationFrame for better timing
        requestAnimationFrame(() => {
          inputRef.current?.focus();
        });
      }
    }, [isCreating, target]);

    // Dispatcher for context menu items
    const handleTreeAction = (action, item = null) => {
        if (action === 'new-file' || action === 'new-folder') {
            dispatch(startCreate({ type: action === 'new-file' ? 'file' : 'folder', target: item }));
        } else if (action === 'new-file-root' || action === 'new-folder-root') {
            dispatch(startCreate({ type: action === 'new-file-root' ? 'file' : 'folder', target: null }));
        } else if (action === 'rename') {
            dispatch(startRename(item));
        } else if (action === 'delete') {
            dispatch(deleteItemThunk(item));
        }
    };
    
    // Action handlers passed down to FileItem
    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            if (isCreating) {
                dispatch(handleCreateItemThunk());
            } else if (isRenaming) {
                dispatch(handleRenameItemThunk());
            }
        } else if (e.key === 'Escape') {
            dispatch(cancelUiAction());
        }
    };
    
    const handleBlur = () => {
        if (isCreating) {
            // For creation, blur acts as cancellation
            dispatch(cancelUiAction());
        } else if (isRenaming) {
            // For renaming, execute thunk or cancel
            if (name.trim() && target && name !== target.name) {
                dispatch(handleRenameItemThunk());
            } else {
                dispatch(cancelUiAction());
            }
        }
    };
    
    const onOpenMenu = (e) => {
        const el = e?.target?.closest('[data-node-path-id]');
        if (el) {
            const nodePath = el.getAttribute('data-node-path-id');
            setContextTarget(findNodeByPath(files, nodePath));
        } else {
            setContextTarget(null);
        }
    };

    // Handler for FileItem clicks
    const onFileSelectHandler = (item) => {
        dispatch(selectFileThunk(item));
    };

    return (
    <ContextMenu
      onOpenAutoFocus={onOpenMenu}
      onOpenChange={(open) => {
        if (!open) setContextTarget(null);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          className="w-full h-full select-none bg-[#0B0E13] text-[#f8f9fb] flex flex-col border-r border-[#252a38]"
          onClick={() => {
            setContextTarget(null);
          }}
          onMouseEnter={() => setIsTreeHovered(true)}
          onMouseLeave={() => setIsTreeHovered(false)}
        >
          {/* Header - Better separation */}
          <div className={`px-3 py-1 flex items-center ${isRightSide ? 'flex-row-reverse' : ''} justify-between border-[#252a38] sticky top-0 bg-[#0B0E13] z-10`}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-widest uppercase text-[#f1f3f8]">
                Explorer
              </span>
            </div>
            <button
              onClick={onToggleOrientation}
              className={`p-1 rounded border border-[#3f4557] bg-[#1c2130] hover:bg-[#232a3b] hover:border-[#63e6be] transition opacity-90 hover:opacity-100 ${isRightSide ? 'mr-auto' : 'ml-auto'}`}
              title={isRightSide ? "Move to left" : "Move to right"}
            >
              {isRightSide ? (
                <PanelLeftClose className="w-3.5 h-3.5 text-[#f8f9fb]" />
              ) : (
                <PanelRightClose className="w-3.5 h-3.5 text-[#f8f9fb]" />
              )}
            </button>
          </div>

          {/* File list - slightly tighter spacing for compactness */}
          <div className="flex-1 overflow-y-auto py-0.5">
            {[...files]
              .sort((a, b) => {
                // Sort folders first, then by name
                if (a.isFolder && !b.isFolder) return -1;
                if (!a.isFolder && b.isFolder) return 1;
                return a.name.localeCompare(b.name);
              })
              .map((item, index, arr) => (
              <FileItem
                key={item.path || index}
                item={item}
                level={0}
                ancestorHasNext={[]}
                hasNextSibling={index < arr.length - 1}
                parentChildCount={arr.length}
                showAllGuides={isTreeHovered}
                activeFolderPath={activeFolderPath}
                activeFolderLevel={activeFolderPath === null ? -1 : null}
                withinActiveFolderSubtree={activeFolderPath === null && activeFolderPath !== undefined}
                onFileSelect={onFileSelectHandler}
                activeFile={activeFile}
                onAction={handleTreeAction}
                onRightMouseButtonClick={(item) => {
                  setContextTarget(item);
                }}
                uiActionState={uiActionState}
                dispatch={dispatch}
                handleKeyDown={handleKeyDown}
                handleBlur={handleBlur}
              />
            ))}

            {/* Root creation input */}
            {isCreating && !target && (
            <div className="px-2 py-1">
              <div className="flex items-center">
                <div className="w-4 h-4 mr-2 flex-shrink-0 flex items-center justify-center">
                  {isCreatingFolder ? (
                    <FolderIcon />
                  ) : (
                    getFileIcon(name || 'newfile')
                  )}
                </div>
                <input
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={(e) => dispatch(setUiActionName(e.target.value))}
                  onKeyDown={handleKeyDown}
                  onBlur={handleBlur}
                  placeholder={isCreatingFolder ? 'New folder name...' : 'New file name...'}
                  className="w-full bg-transparent border-none outline-none text-sm text-white placeholder-gray-500"
                  autoFocus
                />
              </div>
            </div>
          )}
          </div>
        </div>
      </ContextMenuTrigger>

      {/* Context Menu */}
      <ContextMenuContent className="w-52 bg-[#14161a] border border-[#252830] text-[#e8eaed] shadow-xl rounded-lg">
        {contextTarget ? (
          contextTarget.isFolder ? (
            <>
              <ContextMenuItem
                onClick={() => handleTreeAction("new-file", contextTarget)}
                className="px-3 py-2.5 text-sm hover:bg-[#252830] hover:text-[#3b82f6] cursor-pointer rounded-md mx-1"
              >
                New File
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("new-folder", contextTarget)}
                className="px-3 py-2.5 text-sm hover:bg-[#252830] hover:text-[#3b82f6] cursor-pointer rounded-md mx-1"
              >
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator className="bg-[#252830] my-1" />
              <ContextMenuItem
                onClick={() => handleTreeAction("rename", contextTarget)}
                className="px-3 py-2.5 text-sm hover:bg-[#252830] hover:text-[#3b82f6] cursor-pointer rounded-md mx-1"
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("delete", contextTarget)}
                className="px-3 py-2.5 text-sm hover:bg-[#f87171]/10 hover:text-[#f87171] cursor-pointer rounded-md mx-1"
              >
                Delete
              </ContextMenuItem>
            </>
          ) : (
            <>
              <ContextMenuItem
                onClick={() => {
                  // Mark the file as loading and add spinner
                  const el = document.querySelector(`[data-node-path="${contextTarget.path}"]`);
                  if (el) {
                    el.setAttribute('data-loading', 'true');
                    const spinner = document.createElement("div");
                    spinner.className = "ml-2 h-3 w-3 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin";
                    spinner.setAttribute('data-spinner', 'true');
                    const content = el.querySelector(".file-content");
                    if (content) {
                      // remove any previous spinner first
                      const existing = content.querySelector("[data-spinner]");
                      if (existing) existing.remove();
                      content.appendChild(spinner);
                    }
                    el.classList.add("opacity-50");
                  }

                  // Then load the file
                  onFileSelectHandler(contextTarget);
                }}
                className="px-3 py-2.5 text-sm hover:bg-[#252830] hover:text-[#3b82f6] cursor-pointer rounded-md mx-1"
              >
                Open
              </ContextMenuItem>
              <ContextMenuSeparator className="bg-[#252830] my-1" />
              <ContextMenuItem
                onClick={() => handleTreeAction("rename", contextTarget)}
                className="px-3 py-2.5 text-sm hover:bg-[#252830] hover:text-[#3b82f6] cursor-pointer rounded-md mx-1"
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("delete", contextTarget)}
                className="px-3 py-2.5 text-sm hover:bg-[#f87171]/10 hover:text-[#f87171] cursor-pointer rounded-md mx-1"
              >
                Delete
              </ContextMenuItem>
            </>
          )
        ) : (
          <>
            <ContextMenuItem
              onClick={() => handleTreeAction("new-file-root")}
              className="px-3 py-2.5 text-sm hover:bg-[#252830] hover:text-[#3b82f6] cursor-pointer rounded-md mx-1"
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => handleTreeAction("new-folder-root")}
              className="px-3 py-2.5 text-sm hover:bg-[#252830] hover:text-[#3b82f6] cursor-pointer rounded-md mx-1"
            >
              New Folder
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};
export default FileTreeView;