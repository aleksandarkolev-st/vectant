// src/app/FileItem.jsx
"use client";
import { useState, useRef, useEffect } from "react";
import { ChevronIcon } from "./Icons";
import { getFileIcon, FolderIcon } from "@/utils/fileIcons";
import { setUiActionName } from "@/redux/uiSlice";

const FileItem = ({
  item,
  level = 0,
  onFileSelect,
  activeFile,
  onAction,
  onRightMouseButtonClick,
  uiActionState,
  dispatch,
  handleKeyDown,
  handleBlur,
}) => {
  
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
  const [isOpen, setIsOpen] = useState(shouldAutoExpand);
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
      setIsOpen(true);
    }
  }, [activeFile?.path, item, item.isFolder]);

  // Use a ref to track if we're in the middle of creation
  const isCreatingRef = useRef(false);
  
  // Auto-expand folder when it's the target for creation or when creating at root
  useEffect(() => {
  if (isParentForCreation) {
    isCreatingRef.current = true;
    setIsOpen(true);
    
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
    setIsOpen(true);
  }
}, [isParentForCreation, isOpen]);

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
        setIsOpen(!isOpen);
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
        className={`file-item relative group flex items-center py-1 px-2 rounded hover:bg-[#2a2d2e] cursor-pointer ${
          isSelected ? 'bg-[#2a2d2e]' : ''
        }`}
        style={itemStyle}
        onClick={handleClick}
        onContextMenu={handleClick}
      >
        {isExpandable && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(!isOpen);
            }}
          >
            <ChevronIcon isOpen={isOpen} isSelected={isSelected} />
          </div>
        )}
        <div className="w-4 h-4 mr-2 flex-shrink-0 flex items-center justify-center">
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
            className="w-full bg-transparent border-none outline-none text-sm text-white placeholder-gray-500"
          />
        ) : (
          <div className="file-content flex items-center">
            <span
              className={`text-sm truncate ${isSelected ? "text-white" : "text-gray-200"}`}
            >
              {item.name}
            </span>
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
            .map((child, index) => (
            <FileItem
              key={child.path || index}
              item={child}
              level={level + 1}
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
