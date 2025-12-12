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
    
    // Helper for context menu (Inefficient but retained)
    const findNodeByName = (nodes, name) => {
        const stack = [...nodes];
        while (stack.length) {
            const n = stack.shift();
            if (n.name === name) return n;
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
        const el = e?.target?.closest('[data-node-name]');
        if (el) {
            const nodeName = el.getAttribute('data-node-name');
            setContextTarget(findNodeByName(files, nodeName));
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
          className="w-full h-full select-none bg-[#232323] text-gray-100 flex flex-col border-r border-[#343434]"
          onClick={() => {
            setContextTarget(null);
          }}
          onMouseEnter={() => setIsTreeHovered(true)}
          onMouseLeave={() => setIsTreeHovered(false)}
        >
          {/* Header */}
          <div className={`px-3 py-2 flex items-center ${isRightSide ? 'flex-row-reverse' : ''} justify-between border-b border-[#343434] sticky top-0 bg-[#202020] z-10`}>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-wide uppercase text-gray-300">
                Project
              </span>
            </div>
            <button
              onClick={onToggleOrientation}
              className={`p-1.5 rounded border border-[#3a3a3a] bg-[#262626] hover:bg-[#2f2f2f] transition ${isRightSide ? 'mr-auto' : 'ml-auto'}`}
              title={isRightSide ? "Move to left" : "Move to right"}
            >
              {isRightSide ? (
                <PanelLeftClose className="w-4 h-4 text-gray-300" />
              ) : (
                <PanelRightClose className="w-4 h-4 text-gray-300" />
              )}
            </button>
          </div>

          {/* File list */}
          <div className="flex-1 overflow-y-auto">
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
      <ContextMenuContent className="w-48 bg-[#1f1f1f] border border-[#333] text-gray-200 shadow-lg">
        {contextTarget ? (
          contextTarget.isFolder ? (
            <>
              <ContextMenuItem
                onClick={() => handleTreeAction("new-file", contextTarget)}
              >
                New File
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("new-folder", contextTarget)}
              >
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => handleTreeAction("rename", contextTarget)}
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("delete", contextTarget)}
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
                    spinner.className = "ml-2 h-3 w-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin";
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
              >
                Open
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => handleTreeAction("rename", contextTarget)}
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("delete", contextTarget)}
              >
                Delete
              </ContextMenuItem>
            </>
          )
        ) : (
          <>
            <ContextMenuItem
              onClick={() => handleTreeAction("new-file-root")}
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => handleTreeAction("new-folder-root")}
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