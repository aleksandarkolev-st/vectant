// src/app/FileItem.jsx
"use client";
import { useState, useRef, useEffect } from "react";
import collabClient from '@/services/collabClient';
import { useAppSelector } from "@/redux/hooks";
import { selectExpandedFolders, toggleFolderExpansion } from "@/redux/uiSlice";
import { ChevronIcon } from "./Icons";
import { getFileIcon, FolderIcon } from "@/utils/fileIcons";
import { setUiActionName } from "@/redux/uiSlice";

const FileItem = ({
  item,
  level = 0,
  ancestorHasNext = [],
  hasNextSibling = false,
  parentChildCount = 0,
  showAllGuides = false,
  activeFolderPath = undefined,
  activeFolderLevel = null,
  withinActiveFolderSubtree = false,
  onFileSelect,
  activeFile,
  onAction,
  onRightMouseButtonClick,
  uiActionState,
  dispatch,
  handleKeyDown,
  handleBlur,
}) => {

  const renderTreeGuides = (
    guideLevel,
    guideAncestorHasNext,
    guideHasNextSibling,
    drawCurrentLevel
  ) => {
    if (!guideLevel || guideLevel <= 0) return null;

    const INDENT = 16;
    const BASE = 8;
    const xForCol = (colIndex) => BASE + colIndex * INDENT + INDENT / 2;
    const connectorX = xForCol(guideLevel - 1);

    return (
      <div
        className="pointer-events-none absolute inset-y-0 left-0 z-0"
        aria-hidden="true"
      >
        {Array.isArray(guideAncestorHasNext) &&
          guideAncestorHasNext.map((draw, colIndex) =>
            draw ? (
              <div
                key={`tree-v-${colIndex}`}
                className="absolute top-0 bottom-0 w-px bg-[#343434] opacity-100"
                style={{ left: `${xForCol(colIndex)}px` }}
              />
            ) : null
          )}

        {drawCurrentLevel && (
          <>
            {/* Current column vertical connector */}
            <div
              className="absolute top-0 w-px bg-[#343434] opacity-100"
              style={{
                left: `${connectorX}px`,
                bottom: guideHasNextSibling ? 0 : "50%",
              }}
            />
          </>
        )}
      </div>
    );
  };

  // Helper: check if folder contains the active file
  const containsActiveFile = (folder, activeFilePath) => {
    if (!folder.isFolder || !folder.children || !activeFilePath) return false;
    for (const child of folder.children) {
      if (child.path === activeFilePath) return true;
      if (child.isFolder && containsActiveFile(child, activeFilePath)) return true;
    }
    return false;
  };

  // Determine initial auto-expand state
  const shouldAutoExpand =
    item.isFolder && activeFile && containsActiveFile(item, activeFile.path);

  // Retain local state for folder expansion
  const expandedFolders = useAppSelector(selectExpandedFolders);
  const isOpen = expandedFolders.includes(item.path);
  const isRoot = level === 0; // Check if this is a root-level item

  // Destructure UI state and derive contextual flags
  const { mode, target, name } = uiActionState;
  const isCreating = mode.startsWith("create");
  const isRenaming = mode === "rename";
  const isTargetForRename = isRenaming && target && item.path === target.path;
  const isParentForCreation =
    isCreating && item.isFolder && target && item.path === target.path;
  const isCreatingFolder = mode === "create-folder";

  // Local ref for input focus
  const localInputRef = useRef(null);
  const spinnerRef = useRef(null);
  const fileContentRef = useRef(null);

  // Collaboration presence state (awareness states for this file)
  const slug = useAppSelector(state => state.workspace.slug);
  const [presenceStates, setPresenceStates] = useState([]);
  const [hoverPresence, setHoverPresence] = useState(null);
  const hoverHideTimeoutRef = useRef(null);

  useEffect(() => {
    // Only keep presence for real files (not folders)
    if (!slug || item.isFolder) return;
    // subscribe to awareness updates
    try {
      const listenerUnsub = collabClient.addAwarenessListener(slug, item.path, () => {
        // recompute active editors (deduped)
        const act = collabClient.getActiveEditors(slug, item.path);
        setPresenceStates(act || []);
      });
      // seed initial with active editors only
      const initial = collabClient.getActiveEditors(slug, item.path);
      setPresenceStates(initial || []);
      return () => {
        try { listenerUnsub(); } catch (_) {}
      };
    } catch (_) {
      // ignore if collab client isn't available (e.g., server-only render)
    }
  }, [slug, item.path, item.isFolder]);

  // Clean up spinner when file is loaded or component unmounts
  useEffect(() => {
    return () => {
      // Clean up any spinners when component unmounts
      if (spinnerRef.current) {
        const fileItem = spinnerRef.current.closest('.file-item');
        if (fileItem) {
          fileItem.classList.remove('opacity-50');
          fileItem.removeAttribute('data-loading');
        }
        spinnerRef.current.remove();
        spinnerRef.current = null;
      }
    };
  }, []);

  // Handle spinner cleanup when active file changes
  useEffect(() => {
    if (activeFile?.path === item.path) {
      const el = document.querySelector(`[data-node-path="${item.path}"]`);
      if (el) {
        el.classList.remove('opacity-50');
        el.removeAttribute('data-loading');
        const spinner = el.querySelector('.animate-spin');
        if (spinner) spinner.remove();
      }
    }
  }, [activeFile?.path, item.path]);

  // Auto-expand folders containing the active file
  useEffect(() => {
    if (item.isFolder && activeFile && containsActiveFile(item, activeFile.path)) {
      if (!isOpen) {
        dispatch(toggleFolderExpansion(item.path));
      }
    }
  }, [activeFile?.path, item, item.isFolder, isOpen, dispatch]);

  // Use a ref to track if we're in the middle of creation
  const isCreatingRef = useRef(false);
  
  // Auto-expand folder when it's the target for creation or when creating at root
  useEffect(() => {
  if (isParentForCreation) {
    isCreatingRef.current = true;
    if (!isOpen) {
        dispatch(toggleFolderExpansion(item.path));
    }
    
    return () => {
      setTimeout(() => {
        isCreatingRef.current = false;
      }, 200);
    };
  }
}, [isParentForCreation]); 

useEffect(() => {
  // Auto-expand when this folder becomes the target for creation
  if (isParentForCreation && !isOpen) {
    dispatch(toggleFolderExpansion(item.path));
  }
}, [isParentForCreation, isOpen, dispatch, item.path]);

// Unified auto-focus and selection for rename/create
useEffect(() => {
  // Determine if input should be focused
  const shouldFocus = isTargetForRename || isParentForCreation;
  if (!shouldFocus || !localInputRef.current) return;

  const input = localInputRef.current;

  // Small helper for timing robustness
  const focusAndSelect = () => {
    input.focus();

    // For rename → select only filename (not extension)
    if (isTargetForRename) {
      const nameToUse = item.name || "";
      const dotIndex = nameToUse.lastIndexOf(".");
      if (dotIndex > 0) {
        input.setSelectionRange(0, dotIndex);
      } else {
        input.select();
      }
    } else {
      // For new file/folder → select everything
      input.select();
    }
  };

  // Try immediately
  focusAndSelect();

  // Also retry on next animation frame in case of delayed render
  const rafId = requestAnimationFrame(() => focusAndSelect());
  const timeoutId = setTimeout(() => focusAndSelect(), 50);

  return () => {
    cancelAnimationFrame(rafId);
    clearTimeout(timeoutId);
  };
}, [isTargetForRename, isParentForCreation, item.name]);


  // Check if the item is currently the active file/folder
  const isSelected = activeFile && activeFile.path === item.path;
  const isExpandable =
    item.isFolder &&
    ((item.children && item.children.length > 0) || isParentForCreation);
  const itemStyle = { paddingLeft: `${level * 16 + 8}px`, '--indent-level': level };

  const isActiveFolder =
    !!activeFolderPath && item.isFolder && item.path === activeFolderPath;

  // Mark descendants of the active folder as "within" the active subtree.
  // Note: the active folder row itself is NOT "within" (so it doesn't get indicators when not hovering).
  const nextWithinActiveFolderSubtree = withinActiveFolderSubtree || isActiveFolder;

  // Capture the active folder's depth so we can hide ancestor columns above it.
  const nextActiveFolderLevel =
    activeFolderLevel !== null && activeFolderLevel !== undefined
      ? activeFolderLevel
      : isActiveFolder
        ? level
        : null;

  // When not hovered: show indicators ONLY inside the active folder subtree.
  const guidesVisibleForRow = showAllGuides || withinActiveFolderSubtree;

  // Only show indicators for a container if it has 2+ items.
  // This flag controls the connector for the *current* nesting level.
  const drawCurrentLevelGuides = guidesVisibleForRow && parentChildCount >= 2;

  const maskedAncestorHasNext = (() => {
    if (showAllGuides) return ancestorHasNext;
    if (!withinActiveFolderSubtree) return ancestorHasNext;
    if (nextActiveFolderLevel === null || nextActiveFolderLevel === undefined) return ancestorHasNext;
    if (nextActiveFolderLevel <= 0) return ancestorHasNext;
    return ancestorHasNext.map((v, i) => (i < nextActiveFolderLevel ? false : v));
  })();

  const currentIcon = item.isFolder
    ? <FolderIcon isOpen={isOpen} />
    : getFileIcon(isRenaming && isTargetForRename ? (name || item.name) : item.name);

  // Clean up spinner when component unmounts or active file changes
  useEffect(() => {
    return () => {
      if (spinnerRef.current) {
        spinnerRef.current.remove();
        spinnerRef.current = null;
      }
    };
  }, [activeFile]);

  const handleFileClick = (e) => {
    if (item.isFolder) {
      if (isExpandable) {
        dispatch(toggleFolderExpansion(item.path));
      }
    } else {
      // Show immediate feedback
      const fileItem = e.currentTarget.closest('.file-item');
      if (fileItem) {
        // Remove any existing spinner
        if (spinnerRef.current) {
          spinnerRef.current.remove();
        }
        
        fileItem.classList.add('opacity-50');
        
        // Create and store new spinner
        const spinner = document.createElement('div');
        spinner.className = 'ml-2 h-3 w-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin';
        
        // Get the file content container
        const fileContent = fileItem.querySelector('.file-content');
        if (fileContent) {
          fileContent.appendChild(spinner);
          spinnerRef.current = spinner;
          fileContentRef.current = fileContent;
        }
      }
      
      // Trigger file selection
      onFileSelect(item);
    }
  };

  const handleClick = (e) => {
    if (e.button === 2) {
      // Right-click
      onRightMouseButtonClick(item);
      return;
    }
    // Prevent action propagation if this item is currently rendering the input for renaming
    if (isTargetForRename) return;

    handleFileClick(e);
  };

  // Standard Display Rendering
  return (
    <>
      <div
        ref={fileContentRef}
        data-node-path={item.path}
        data-node-name={item.name}
        className={`file-item relative group flex items-center py-2 px-2 rounded-md hover:bg-[#1a1d23] cursor-pointer transition-colors ${
          isSelected ? 'bg-[#1a1d23] border-l-2 border-[#3b82f6]' : 'border-l-2 border-transparent'
        }`}
        style={itemStyle}
        onClick={handleClick}
        onContextMenu={handleClick}
      >
        {guidesVisibleForRow &&
          renderTreeGuides(level, maskedAncestorHasNext, hasNextSibling, drawCurrentLevelGuides)}
        {isExpandable && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              dispatch(toggleFolderExpansion(item.path));
            }}
          >
            <ChevronIcon isOpen={isOpen} isSelected={isSelected} />
          </div>
        )}
        <div className="w-5 h-5 mr-2.5 flex-shrink-0 flex items-center justify-center text-base">
          {currentIcon}
        </div>
        {/* replaced the early return block, stopping files (children from showing during rename) */}
        {isTargetForRename ? (
          <input
            ref={localInputRef}
            type="text"
            value={name}
            onChange={(e) => dispatch(setUiActionName(e.target.value))}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={item.isFolder ? "Rename folder..." : "Rename file..."}
            className="w-full bg-transparent border-none outline-none text-sm text-[#e8eaed] placeholder-[#6b7280]"
          />
        ) : (
          <div className="file-content flex items-center gap-2">
            <span
              className={`text-sm truncate leading-relaxed ${isSelected ? "text-[#e8eaed] font-medium" : "text-[#9ba1ab]"}`}
            >
              {item.name}
            </span>
            {/* Presence badges */}
                {(!item.isFolder && presenceStates && presenceStates.length > 0) && (
                  <div className="flex items-center gap-1 ml-2">
                    {presenceStates.slice(0,3).map((p) => {
                      const name = p.state?.user?.name || 'U';
                      const initials = name.split(' ').filter(Boolean).map(p => p[0]).slice(0,2).join('').toUpperCase();
                      return (
                        <div key={`pres-${p.clientId}`} className="relative">
                          <div
                            onMouseEnter={(e) => {
                              if (hoverHideTimeoutRef.current) { clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = null; }
                              const rect = e.currentTarget.getBoundingClientRect();
                              setHoverPresence({ user: p.state?.user || {}, rect });
                            }}
                            onMouseLeave={() => { if (hoverHideTimeoutRef.current) clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = setTimeout(() => setHoverPresence(null), 140); }}
                            title={p.state?.user?.name || 'User'}
                            className="w-6 h-6 rounded-full flex items-center justify-center text-xs text-white cursor-default"
                            style={{ border: `2px solid ${p.state?.user?.color || '#0b0b0b'}`, background: p.state?.user?.color ? 'rgba(255,255,255,0.03)' : '#111' }}
                          >
                            {initials}
                          </div>
                        </div>
                      );
                    })}
                    {presenceStates.length > 3 && (
                      <div className="text-[10px] text-gray-300 ml-1">+{presenceStates.length - 3}</div>
                    )}
                  </div>
                )}

            {/* Hover card for file presence */}
            {hoverPresence && hoverPresence.rect && (
              <div style={{ position: 'fixed', left: hoverPresence.rect.left + hoverPresence.rect.width + 6, top: hoverPresence.rect.top - 6, zIndex: 2000 }} onMouseEnter={() => { if (hoverHideTimeoutRef.current) { clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = null; } }} onMouseLeave={() => { if (hoverHideTimeoutRef.current) clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = setTimeout(() => setHoverPresence(null), 140); }}>
                <div className="bg-[#151515] border border-[#333] rounded-md p-2 text-sm text-gray-200 shadow-lg w-44">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm text-white" style={{ background: hoverPresence.user.color || '#555' }}>{(hoverPresence.user.name || 'Anonymous').split(' ').map(p => p[0]).slice(0,2).join('').toUpperCase()}</div>
                    <div className="flex flex-col">
                      <div className="font-semibold text-sm">{hoverPresence.user.name || 'Anonymous'}</div>
                      <div className="text-xs text-gray-400">{hoverPresence.user.id ? `id: ${hoverPresence.user.id}` : 'Anonymous user'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Show children if folder is open or if it's the target for creation */}
      {(isExpandable && (isOpen || isParentForCreation)) && (
        <div className="flex flex-col">
          {isParentForCreation && (
            <div
              className="file-item relative flex items-center py-1 px-2"
              style={{ paddingLeft: `${(level + 1) * 16 + 8}px`, '--indent-level': level + 1 }}
            >
              {guidesVisibleForRow &&
                renderTreeGuides(
                  level + 1,
                  [...ancestorHasNext, hasNextSibling && drawCurrentLevelGuides],
                  (item.children || []).length > 0,
                  guidesVisibleForRow && (item.children || []).length >= 2
                )}
              <div className="flex items-center">
                <div className="w-4 h-4 mr-2 flex-shrink-0 flex items-center justify-center">
                  {isCreatingFolder ? (
                    <FolderIcon />
                  ) : (
                    getFileIcon(name || "newfile")
                  )}
                </div>
                <input
                  ref={localInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => dispatch(setUiActionName(e.target.value))}
                  onKeyDown={handleKeyDown}
                  onBlur={handleBlur}
                  placeholder={
                    isCreatingFolder ? "New folder name..." : "New file name..."
                  }
                  className="w-full bg-transparent border-none outline-none text-sm text-white placeholder-gray-500"
                />
              </div>
            </div>
          )}

          {[...(item.children || [])]
            .sort((a, b) => {
              // Sort folders first, then by name
              if (a.isFolder && !b.isFolder) return -1;
              if (!a.isFolder && b.isFolder) return 1;
              return a.name.localeCompare(b.name);
            })
            .map((child, index, arr) => (
            <FileItem
              key={child.path || index}
              item={child}
              level={level + 1}
              ancestorHasNext={[...ancestorHasNext, hasNextSibling && drawCurrentLevelGuides]}
              hasNextSibling={index < arr.length - 1}
              parentChildCount={arr.length}
              showAllGuides={showAllGuides}
              activeFolderPath={activeFolderPath}
              activeFolderLevel={nextActiveFolderLevel}
              withinActiveFolderSubtree={nextWithinActiveFolderSubtree}
              onFileSelect={onFileSelect}
              activeFile={activeFile}
              onAction={onAction}
              onRightMouseButtonClick={onRightMouseButtonClick}
              // Propagate all necessary state and handlers
              uiActionState={uiActionState}
              dispatch={dispatch}
              handleKeyDown={handleKeyDown}
              handleBlur={handleBlur}
            />
          ))}
        </div>
      )}
    </>
  );
};
export default FileItem;
