"use client";
import { useState, useRef, useEffect, useCallback, memo, useMemo } from "react";
import { toast } from "sonner";
import { Virtuoso } from "react-virtuoso";
import { useAppDispatch, useAppSelector } from "@/redux/hooks";
import {
  selectFilesTree,
  selectActiveFile,
  handleCreateItemThunk,
  handleRenameItemThunk,
  deleteItemThunk,
  selectFileThunk,
  moveItemThunk,
} from "@/redux/workspaceSlice";
import {
  selectUiActionState,
  setUiActionName,
  cancelUiAction,
  startCreate,
  startRename,
  selectTreeOnRight,
} from "@/redux/uiSlice";
import {
  selectTabs,
  restoreEditorPanel,
} from "@/components/docking-wm/state/layout-slice";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PanelLeftClose, PanelRightClose, FolderOpen } from "lucide-react";
import { getFileIcon, FolderIcon } from "@/utils/fileIcons";
import FileItem from "./FileItem";
import { useVirtualizedTree } from "@/hooks/useVirtualizedTree";
import { useNewProjectPicker } from "@/components/NewProjectPicker";

const FileTreeView = ({ onToggleOrientation }) => {
  const dispatch = useAppDispatch();

  // State pulled from Redux
  const files = useAppSelector(selectFilesTree);
  const activeFile = useAppSelector(selectActiveFile);
  const uiActionState = useAppSelector(selectUiActionState);
  const isRightSide = useAppSelector(selectTreeOnRight);
  const { openPicker } = useNewProjectPicker();

  // inputRef retained ONLY for root-level creation (target: null)
  const inputRef = useRef(null);
  const [contextTarget, setContextTarget] = useState(null);
  const [isTreeHovered, setIsTreeHovered] = useState(false);
  const { mode, target, name } = uiActionState;
  const isCreating = mode.startsWith("create");
  const isRenaming = mode === "rename";
  const isCreatingFile = mode === "create-file";
  const isCreatingFolder = mode === "create-folder";

  const findParentFolderPath = (nodes, targetPath, parentPath = null) => {
    for (const node of nodes || []) {
      if (node?.path === targetPath) return parentPath;
      if (node?.isFolder && node?.children?.length) {
        const found = findParentFolderPath(
          node.children,
          targetPath,
          node.path,
        );
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  const activeFolderPath = activeFile?.path
    ? activeFile?.isFolder
      ? activeFile.path
      : (findParentFolderPath(files, activeFile.path) ?? null)
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
  const handleTreeAction = useCallback(async (action, item = null) => {
    // When the workspace is empty and the user is creating a *file* at the
    // root, surface the project/file-type picker instead of the inline
    // rename input. Folder creation always uses the inline path so users
    // can still scaffold a folder structure manually before any file
    // exists. See [NewProjectPicker.jsx](../../../components/NewProjectPicker.jsx).
    if (
      (action === "new-file" || action === "new-file-root") &&
      (!files || files.length === 0)
    ) {
      openPicker();
      return;
    }
    if (action === "new-file" || action === "new-folder") {
      dispatch(
        startCreate({
          type: action === "new-file" ? "file" : "folder",
          target: item,
        }),
      );
    } else if (action === "new-file-root" || action === "new-folder-root") {
      dispatch(
        startCreate({
          type: action === "new-file-root" ? "file" : "folder",
          target: null,
        }),
      );
    } else if (action === "rename") {
      dispatch(startRename(item));
    } else if (action === "delete") {
      const res = await dispatch(deleteItemThunk(item));
      if (deleteItemThunk.rejected.match(res)) {
        toast.error(`Delete failed: ${res.error?.message || "Unknown error"}`);
      }
    }
  }, [dispatch, files, openPicker]);

  // Action handlers passed down to FileItem
  const handleKeyDown = useCallback(async (e) => {
    if (e.key === "Enter") {
      if (isCreating) {
        const res = await dispatch(handleCreateItemThunk());
        if (handleCreateItemThunk.rejected.match(res)) {
          toast.error(
            `Create failed: ${res.error?.message || "Unknown error"}`,
          );
        }
      } else if (isRenaming) {
        const res = await dispatch(handleRenameItemThunk());
        if (handleRenameItemThunk.rejected.match(res)) {
          toast.error(
            `Rename failed: ${res.error?.message || "Unknown error"}`,
          );
        }
      }
    } else if (e.key === "Escape") {
      dispatch(cancelUiAction());
    }
  }, [dispatch, isCreating, isRenaming]);

  const handleBlur = useCallback(async () => {
    if (isCreating) {
      // For creation, blur acts as cancellation
      dispatch(cancelUiAction());
    } else if (isRenaming) {
      // For renaming, execute thunk or cancel
      if (name.trim() && target && name !== target.name) {
        const res = await dispatch(handleRenameItemThunk());
        if (handleRenameItemThunk.rejected.match(res)) {
          toast.error(
            `Rename failed: ${res.error?.message || "Unknown error"}`,
          );
        }
      } else {
        dispatch(cancelUiAction());
      }
    }
  }, [dispatch, isCreating, isRenaming, name, target]);

  const onOpenMenu = (e) => {
    const el = e?.target?.closest("[data-node-path-id]");
    if (el) {
      const nodePath = el.getAttribute("data-node-path-id");
      setContextTarget(findNodeByPath(files, nodePath));
    } else {
      setContextTarget(null);
    }
  };

  // Drop on the empty tree area moves the dragged item to the workspace root.
  // Per-folder drops are handled inside FileItem; this only fires when the
  // drop lands on whitespace below all rows.
  const handleRootDragOver = useCallback((e) => {
    if (!e.dataTransfer.types.includes("application/x-synthi-tree-item")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleRootDrop = useCallback(async (e) => {
    const raw = e.dataTransfer.getData("application/x-synthi-tree-item");
    if (!raw) return;
    e.preventDefault();
    let src;
    try { src = JSON.parse(raw); } catch (_) { return; }
    if (!src?.path || !src?.name) return;
    const srcParent = src.path.includes("/")
      ? src.path.slice(0, src.path.lastIndexOf("/"))
      : "";
    if (srcParent === "") return; // already at root
    const res = await dispatch(moveItemThunk({
      sourcePath: src.path,
      sourceName: src.name,
      sourceIsFolder: !!src.isFolder,
      targetFolderPath: "",
    }));
    if (moveItemThunk.rejected.match(res)) {
      toast.error(`Move failed: ${res.error?.message || "Unknown error"}`);
    }
  }, [dispatch]);

  // All layout tabs — used to detect if the editor panel is missing
  const layoutTabs = useAppSelector(selectTabs);

  // Handler for FileItem clicks
  const onFileSelectHandler = useCallback(
    (item) => {
      // If the editor panel was somehow closed, restore it in its own split
      const editorExists = Object.values(layoutTabs).some(
        (t) => t.panelType === "editor",
      );
      if (!editorExists) {
        dispatch(restoreEditorPanel());
      }

      dispatch(selectFileThunk(item));
    },
    [dispatch, layoutTabs],
  );

  // Flatten the recursive tree into a virtualised flat list
  const flatNodes = useVirtualizedTree(files, uiActionState);

  // Stable row renderer for Virtuoso
  const renderRow = useCallback((index) => {
    const row = flatNodes[index];
    if (!row) return null;

    if (row.isCreateInput) {
      return (
        <div
          className="file-item relative flex items-center py-1.5 px-2"
          style={{ paddingLeft: `${row.level * 16 + 8}px` }}
        >
          <div className="w-3.5 h-3.5 mr-2.5 flex-shrink-0 flex items-center justify-center text-sm opacity-95">
            {isCreatingFolder ? (
              <FolderIcon />
            ) : (
              getFileIcon(name || "newfile")
            )}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => dispatch(setUiActionName(e.target.value))}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={
              isCreatingFolder ? "New folder name..." : "New file name..."
            }
            className="w-full bg-transparent border-none outline-none text-[12px]"
            style={{ color: "var(--text-primary)" }}
            autoFocus
          />
        </div>
      );
    }

    return (
      <FileItem
        item={row.item}
        level={row.level}
        ancestorHasNext={row.ancestorHasNext}
        hasNextSibling={row.hasNextSibling}
        parentChildCount={row.parentChildCount}
        showAllGuides={isTreeHovered}
        activeFolderPath={activeFolderPath}
        activeFolderLevel={activeFolderPath === null ? -1 : null}
        withinActiveFolderSubtree={
          activeFolderPath === null && activeFolderPath !== undefined
        }
        onFileSelect={onFileSelectHandler}
        activeFile={activeFile}
        onAction={handleTreeAction}
        onRightMouseButtonClick={setContextTarget}
        uiActionState={uiActionState}
        dispatch={dispatch}
        handleKeyDown={handleKeyDown}
        handleBlur={handleBlur}
        shallow
      />
    );
  }, [flatNodes, isTreeHovered, activeFolderPath, onFileSelectHandler, activeFile, handleTreeAction, uiActionState, dispatch, handleKeyDown, handleBlur, isCreatingFolder, name]);

  return (
    <ContextMenu
      onOpenAutoFocus={onOpenMenu}
      onOpenChange={(open) => {
        if (!open) setContextTarget(null);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          className="w-full h-full select-none flex flex-col border-r"
          style={{
            background: "var(--bg-sidebar)",
            color: "var(--text-primary)",
            borderColor: "var(--border-medium)",
          }}
          onClick={() => {
            setContextTarget(null);
          }}
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
          onMouseEnter={() => setIsTreeHovered(true)}
          onMouseLeave={() => setIsTreeHovered(false)}
        >
          <div
            className={`flex shrink-0 items-center gap-2 border-b px-3 py-2 ${isRightSide ? "flex-row-reverse" : ""}`}
            style={{
              borderColor: "var(--border-subtle)",
              background: "color-mix(in srgb, var(--bg-sidebar) 72%, var(--bg-editor) 28%)",
            }}
          >
            <FolderOpen
              size={14}
              className="flex-shrink-0"
              style={{ color: "var(--accent-secondary)" }}
            />
            <span
              className="text-sm font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              Explorer
            </span>
            <div
              className={`${isRightSide ? "mr-auto" : "ml-auto"} flex items-center gap-0.5`}
            >
              <button
                onClick={onToggleOrientation}
                title={isRightSide ? "Move to left" : "Move to right"}
                className="p-1.5 rounded-lg transition-all hover:bg-white/[0.06]"
                style={{ color: "var(--text-muted)" }}
              >
                {isRightSide ? (
                  <PanelLeftClose className="w-3.5 h-3.5" strokeWidth={1.5} />
                ) : (
                  <PanelRightClose
                    className="w-3.5 h-3.5"
                    strokeWidth={1.5}
                  />
                )}
              </button>
            </div>
          </div>

          {/* Virtualised file list. The create-input row (root or folder
              target) is injected as a synthetic Virtuoso row by
              useVirtualizedTree and rendered by renderRow above. */}
          <div className="flex-1 py-0.5" style={{ minHeight: 0 }}>
            <Virtuoso
              totalCount={flatNodes.length}
              overscan={200}
              itemContent={renderRow}
              computeItemKey={(index) => flatNodes[index]?.key ?? index}
              style={{ height: '100%' }}
              increaseViewportBy={{ top: 200, bottom: 200 }}
            />
          </div>
        </div>
      </ContextMenuTrigger>

      {/* Context Menu */}
      <ContextMenuContent
        className="w-52 shadow-xl rounded-lg border"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border-medium)",
          color: "var(--text-primary)",
        }}
      >
        {contextTarget ? (
          contextTarget.isFolder ? (
            <>
              <ContextMenuItem
                onClick={() => handleTreeAction("new-file", contextTarget)}
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
              >
                New File
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("new-folder", contextTarget)}
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
              >
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator
                className="my-1"
                style={{ background: "var(--border-medium)" }}
              />
              <ContextMenuItem
                onClick={() => handleTreeAction("rename", contextTarget)}
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
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
                  const el = document.querySelector(
                    `[data-node-path="${contextTarget.path}"]`,
                  );
                  if (el) {
                    el.setAttribute("data-loading", "true");
                    const spinner = document.createElement("div");
                    spinner.className =
                      "ml-2 h-3 w-3 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin";
                    spinner.setAttribute("data-spinner", "true");
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
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
              >
                Open
              </ContextMenuItem>
              <ContextMenuSeparator
                className="my-1"
                style={{ background: "var(--border-medium)" }}
              />
              <ContextMenuItem
                onClick={() => handleTreeAction("rename", contextTarget)}
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
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
              className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => handleTreeAction("new-folder-root")}
              className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
            >
              New Folder
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};
export default memo(FileTreeView);
