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
  fetchFilesThunk,
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
import { PanelLeftClose, PanelRightClose, FolderOpen, Loader2, Upload } from "lucide-react";
import { getFileIcon, FolderIcon } from "@/utils/fileIcons";
import FileItem from "./FileItem";
import { useVirtualizedTree } from "@/hooks/useVirtualizedTree";
import { useNewProjectPicker } from "@/components/NewProjectPicker";
import { gitClient } from "@/services/gitClient";

const MAX_EXPLORER_UPLOAD_FILES = 240;
const MAX_EXPLORER_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_EXPLORER_UPLOAD_FILE_BYTES = 24 * 1024 * 1024;
const IGNORED_EXPLORER_UPLOAD_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".cache",
  ".turbo",
]);

function dataTransferHasType(dataTransfer, type) {
  return Array.from(dataTransfer?.types || []).includes(type);
}

function normalizeUploadPath(rawPath, targetFolder = "") {
  const base = String(targetFolder || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const path = String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("/");

  return [base, path].filter(Boolean).join("/");
}

function isIgnoredUploadPath(path) {
  return normalizeUploadPath(path)
    .split("/")
    .some((segment) => IGNORED_EXPLORER_UPLOAD_SEGMENTS.has(segment));
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function findNodeByPath(nodes, path) {
  const stack = [...(nodes || [])];
  while (stack.length) {
    const n = stack.shift();
    if (n.path === path) return n;
    if (n.isFolder && n.children) stack.push(...n.children);
  }
  return null;
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(entries);
            return;
          }
          entries.push(...batch);
          readBatch();
        },
        reject,
      );
    };
    readBatch();
  });
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function filesFromEntry(entry, prefix = "") {
  if (!entry) return [];

  if (entry.isFile) {
    const file = await readEntryFile(entry);
    return [{ file, path: normalizeUploadPath(`${prefix}${file.name}`) }];
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const children = await readDirectoryEntries(reader);
    const childResults = await Promise.all(
      children.map((child) => filesFromEntry(child, `${prefix}${entry.name}/`)),
    );
    return childResults.flat();
  }

  return [];
}

async function filesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entryItems = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entryItems.length) {
    const results = await Promise.all(entryItems.map((entry) => filesFromEntry(entry)));
    return results.flat();
  }

  return Array.from(dataTransfer?.files || []).map((file) => ({
    file,
    path: normalizeUploadPath(file.webkitRelativePath || file.name),
  }));
}

function filesFromFileList(fileList) {
  return Array.from(fileList || []).map((file) => ({
    file,
    path: normalizeUploadPath(file.webkitRelativePath || file.name),
  }));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fileToBatchEntry(entry) {
  const buffer = await entry.file.arrayBuffer();
  return {
    path: entry.path,
    encoding: "base64",
    content: arrayBufferToBase64(buffer),
  };
}

const FileTreeView = ({ onToggleOrientation }) => {
  const dispatch = useAppDispatch();

  // State pulled from Redux
  const files = useAppSelector(selectFilesTree);
  const activeFile = useAppSelector(selectActiveFile);
  const uiActionState = useAppSelector(selectUiActionState);
  const isRightSide = useAppSelector(selectTreeOnRight);
  const slug = useAppSelector((state) => state.workspace.slug);
  const { openPicker } = useNewProjectPicker();

  // inputRef retained ONLY for root-level creation (target: null)
  const inputRef = useRef(null);
  const uploadInputRef = useRef(null);
  const [contextTarget, setContextTarget] = useState(null);
  const [isTreeHovered, setIsTreeHovered] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isExternalDropActive, setIsExternalDropActive] = useState(false);
  const [externalDropTargetFolder, setExternalDropTargetFolder] = useState("");
  // Bumped on every contextmenu event so the menu Content remounts and
  // Radix recomputes its position from the latest right-click coords.
  // Without this, opening the menu at a new spot while the previous one
  // is still mounted can keep it pinned to the old location.
  const [menuOpenCount, setMenuOpenCount] = useState(0);
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

  // Focus hook for any creation (root or inside a folder). The create-input
  // row is rendered by Virtuoso, which can mount the row a frame or two
  // after the redux state flips, so we retry a few times to be robust.
  useEffect(() => {
    if (!isCreating) return;

    let cancelled = false;
    const tryFocus = () => {
      if (cancelled) return;
      const el = inputRef.current;
      if (el && document.activeElement !== el) {
        el.focus();
        try { el.select(); } catch (_) {}
      }
    };

    tryFocus();
    const raf = requestAnimationFrame(tryFocus);
    const t1 = setTimeout(tryFocus, 50);
    const t2 = setTimeout(tryFocus, 150);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
    };
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
      // Commit the new item on blur when a name has been entered.
      // Empty input (or whitespace) still cancels so an aborted create
      // doesn't leave an orphan node behind.
      if (name.trim()) {
        const res = await dispatch(handleCreateItemThunk());
        if (handleCreateItemThunk.rejected.match(res)) {
          toast.error(
            `Create failed: ${res.error?.message || "Unknown error"}`,
          );
        }
      } else {
        dispatch(cancelUiAction());
      }
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

  const uploadFilesToWorkspace = useCallback(async (entries, targetFolder = "") => {
    if (!slug) {
      toast.error("Workspace is still loading. Try again in a moment.");
      return;
    }

    const uniqueFiles = new Map();
    const skipped = [];
    let totalBytes = 0;

    for (const entry of entries || []) {
      const file = entry?.file || entry;
      const path = normalizeUploadPath(entry?.path || file?.webkitRelativePath || file?.name, targetFolder);
      if (!file || !path || isIgnoredUploadPath(path)) {
        skipped.push(path || file?.name || "unknown");
        continue;
      }
      if (file.size > MAX_EXPLORER_UPLOAD_FILE_BYTES) {
        skipped.push(`${path} (${humanBytes(file.size)})`);
        continue;
      }
      if (!uniqueFiles.has(path) && uniqueFiles.size >= MAX_EXPLORER_UPLOAD_FILES) {
        skipped.push(path);
        continue;
      }
      if (!uniqueFiles.has(path) && totalBytes + file.size > MAX_EXPLORER_UPLOAD_TOTAL_BYTES) {
        skipped.push(path);
        continue;
      }
      if (!uniqueFiles.has(path)) totalBytes += file.size;
      uniqueFiles.set(path, { file, path });
    }

    const uploadEntries = Array.from(uniqueFiles.values());
    if (!uploadEntries.length) {
      toast.warning("No supported files to upload.");
      return;
    }

    setIsUploading(true);
    try {
      const batch = await Promise.all(uploadEntries.map(fileToBatchEntry));
      const result = await gitClient.writeFilesBatch(slug, batch, { syncToGcs: true });
      await dispatch(fetchFilesThunk(slug));

      const failed = Array.isArray(result?.errors) ? result.errors.length : 0;
      const written = Array.isArray(result?.written) ? result.written.length : batch.length;
      if (failed > 0) {
        toast.warning(`Uploaded ${written} file${written === 1 ? "" : "s"}, ${failed} failed.`);
      } else {
        toast.success(`Uploaded ${written} file${written === 1 ? "" : "s"}${targetFolder ? ` to ${targetFolder}` : ""}.`);
      }
      if (skipped.length) {
        toast.info(`${skipped.length} item${skipped.length === 1 ? "" : "s"} skipped.`);
      }
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setIsUploading(false);
      setIsExternalDropActive(false);
    }
  }, [dispatch, slug]);

  const handleUploadInputChange = useCallback((event) => {
    uploadFilesToWorkspace(filesFromFileList(event.target.files));
    event.target.value = "";
  }, [uploadFilesToWorkspace]);

  const handleExternalFilesDrop = useCallback(async (event, targetFolder = "") => {
    event.preventDefault();
    event.stopPropagation();
    setIsExternalDropActive(false);
    setExternalDropTargetFolder("");
    try {
      const entries = await filesFromDataTransfer(event.dataTransfer);
      await uploadFilesToWorkspace(entries, targetFolder);
    } catch (error) {
      console.error(error);
      toast.error("Could not read the dropped files. Try the upload button instead.");
    }
  }, [uploadFilesToWorkspace]);

  const handleExternalFolderDragTarget = useCallback((targetFolder = "") => {
    setExternalDropTargetFolder(targetFolder || "");
    setIsExternalDropActive(true);
  }, []);

  const getFolderDropTargetFromEvent = useCallback((event) => {
    if (typeof document === "undefined") return "";
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const row = target?.closest?.("[data-node-path-id]");
    const nodePath = row?.getAttribute?.("data-node-path-id");
    if (!nodePath) return "";
    const node = findNodeByPath(files, nodePath);
    return node?.isFolder ? node.path : "";
  }, [files]);

  // Drop on the empty tree area moves the dragged item to the workspace root.
  // Per-folder drops are handled inside FileItem; this only fires when the
  // drop lands on whitespace below all rows.
  const handleRootDragOver = useCallback((e) => {
    if (dataTransferHasType(e.dataTransfer, "Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!isExternalDropActive) setIsExternalDropActive(true);
      const hoveredFolder = getFolderDropTargetFromEvent(e);
      if (hoveredFolder !== externalDropTargetFolder) {
        setExternalDropTargetFolder(hoveredFolder);
      }
      return;
    }
    if (!e.dataTransfer.types.includes("application/x-synthi-tree-item")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, [externalDropTargetFolder, getFolderDropTargetFromEvent, isExternalDropActive]);

  const handleRootDrop = useCallback(async (e) => {
    if (dataTransferHasType(e.dataTransfer, "Files")) {
      const targetFolder = externalDropTargetFolder || getFolderDropTargetFromEvent(e);
      await handleExternalFilesDrop(e, targetFolder);
      return;
    }
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
  }, [dispatch, externalDropTargetFolder, getFolderDropTargetFromEvent, handleExternalFilesDrop]);

  const handleRootDragLeave = useCallback((e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsExternalDropActive(false);
    setExternalDropTargetFolder("");
  }, []);

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
        onExternalFilesDrop={handleExternalFilesDrop}
        onExternalFolderDragTarget={handleExternalFolderDragTarget}
        isExternalFolderDropTarget={externalDropTargetFolder === row.item.path}
        uiActionState={uiActionState}
        dispatch={dispatch}
        handleKeyDown={handleKeyDown}
        handleBlur={handleBlur}
        shallow
      />
    );
  }, [flatNodes, isTreeHovered, activeFolderPath, onFileSelectHandler, activeFile, handleTreeAction, handleExternalFilesDrop, handleExternalFolderDragTarget, externalDropTargetFolder, uiActionState, dispatch, handleKeyDown, handleBlur, isCreatingFolder, name]);

  return (
    <ContextMenu
      onOpenAutoFocus={onOpenMenu}
      onOpenChange={(open) => {
        if (!open) setContextTarget(null);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          className="relative w-full h-full select-none flex flex-col border-r"
          style={{
            background: "var(--bg-sidebar)",
            color: "var(--text-primary)",
            borderColor: "var(--border-medium)",
          }}
          onClick={() => {
            setContextTarget(null);
          }}
          onContextMenu={() => setMenuOpenCount((c) => c + 1)}
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
          onDragLeave={handleRootDragLeave}
          onMouseEnter={() => setIsTreeHovered(true)}
          onMouseLeave={() => setIsTreeHovered(false)}
        >
          <input
            ref={uploadInputRef}
            data-testid="workspace-file-upload-input"
            type="file"
            multiple
            className="sr-only"
            onChange={handleUploadInputChange}
          />
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
                data-testid="workspace-file-upload-button"
                onClick={(event) => {
                  event.stopPropagation();
                  uploadInputRef.current?.click();
                }}
                disabled={isUploading}
                title="Upload files"
                className="p-1.5 rounded-lg transition-all hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: isUploading ? "var(--attention-purple)" : "var(--text-muted)" }}
              >
                {isUploading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Upload className="w-3.5 h-3.5" strokeWidth={1.5} />
                )}
              </button>
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

          {isExternalDropActive && !externalDropTargetFolder && (
            <div
              data-testid="workspace-file-drop-overlay"
              className="pointer-events-none absolute inset-2 z-[2] flex items-center justify-center rounded-lg border border-dashed px-4 text-center"
              style={{
                borderColor: "color-mix(in srgb, var(--attention-purple) 66%, transparent)",
                background: "color-mix(in srgb, var(--bg-sidebar) 82%, var(--attention-purple) 18%)",
                boxShadow: "inset 0 1px 0 color-mix(in srgb, var(--text-primary) 10%, transparent)",
              }}
            >
              <div>
                <Upload className="mx-auto mb-2 h-5 w-5" style={{ color: "var(--attention-purple)" }} />
                <div className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                  {externalDropTargetFolder ? `Drop files into ${externalDropTargetFolder}` : "Drop files into workspace root"}
                </div>
                <div className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                  They will be written into this worktree.
                </div>
              </div>
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      {/* Context Menu */}
      <ContextMenuContent
        key={menuOpenCount}
        onCloseAutoFocus={(e) => {
          // Don't let Radix yank focus back to the trigger when the menu
          // closes — the New File / New Folder actions mount a rename
          // input that needs to keep the focus it just acquired, otherwise
          // the blur fires immediately and cancels the create.
          e.preventDefault();
        }}
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
