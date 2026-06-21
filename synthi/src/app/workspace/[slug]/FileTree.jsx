"use client";
import { useState, useRef, useEffect, useCallback, memo, useMemo } from "react";
import { toast } from "sonner";
import { Virtuoso } from "react-virtuoso";
import { motion, useReducedMotion } from "framer-motion";
import { useAppDispatch, useAppSelector } from "@/redux/hooks";
import { useSessionPermissions } from "@/hooks/useCollabSession";
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
import {
  AlertTriangle,
  FilePlus2,
  FolderPlus,
  LockKeyhole,
  PanelLeftClose,
  PanelRightClose,
  FolderOpen,
  Loader2,
  RotateCw,
  Upload,
} from "lucide-react";
import { getFileIcon, FolderIcon } from "@/utils/fileIcons";
import FileItem from "./FileItem";
import { useVirtualizedTree } from "@/hooks/useVirtualizedTree";
import { useNewProjectPicker } from "@/components/NewProjectPicker";
import { gitClient } from "@/services/gitClient";
import collabSessionService from "@/services/collabSessionService";

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

function ExplorerStatePanel({
  state = "empty",
  errorMessage = "",
  isUploading,
  onUpload,
  onNewFile,
  onNewFolder,
  onRetry,
  onRequestFileOps,
}) {
  const reduceMotion = useReducedMotion();
  const motionProps = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
      };
  const tapProps = reduceMotion ? {} : { whileTap: { scale: 0.98 } };
  const isLoading = state === "loading";
  const isError = state === "error";
  const isNoPermission = state === "permission";

  const copy = isLoading
    ? {
        title: "Loading workspace files",
        body: "Reading the workspace tree from the file service.",
        Icon: Loader2,
      }
    : isError
      ? {
          title: "Could not load files",
          body: errorMessage || "The file service did not return a tree.",
          Icon: AlertTriangle,
        }
      : isNoPermission
        ? {
            title: "File operations are off",
            body: "You can inspect files, but upload, create, and move are disabled.",
            Icon: LockKeyhole,
          }
        : {
            title: "Workspace is empty",
            body: "Upload files, create a folder, or start from a file template.",
            Icon: FolderOpen,
          };
  const Icon = copy.Icon;

  return (
    <motion.div
      {...motionProps}
      className="flex h-full min-h-[220px] items-center px-3 py-5"
      data-testid={`workspace-explorer-${state}-state`}
      role={isLoading ? "status" : undefined}
      aria-live={isLoading || isError ? "polite" : undefined}
    >
      <div
        className="w-full rounded-lg border px-3 py-3.5"
        style={{
          borderColor: "color-mix(in srgb, var(--border-medium) 78%, transparent)",
          background: "color-mix(in srgb, var(--bg-sidebar) 82%, var(--bg-editor) 18%)",
        }}
      >
        <div className="flex items-start gap-2.5">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: "color-mix(in srgb, var(--attention-purple) 26%, var(--border-medium))",
              color: "var(--attention-purple)",
              background: "color-mix(in srgb, var(--attention-purple) 8%, transparent)",
            }}
          >
            <Icon className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>
              {copy.title}
            </div>
            <p className="mt-1 text-[11px] leading-5" style={{ color: "var(--text-muted)" }}>
              {copy.body}
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="mt-3 grid gap-1.5" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="h-7 rounded-md"
                style={{
                  background: `color-mix(in srgb, var(--text-muted) ${index === 0 ? 10 : 7}%, transparent)`,
                }}
              />
            ))}
          </div>
        ) : (
          <div className="mt-3 grid gap-1.5">
            {isError ? (
              <motion.button
                {...tapProps}
                type="button"
                onClick={onRetry}
                className="th-focus-ring flex h-8 items-center gap-2 rounded-md border px-2.5 text-left text-[11px] font-semibold transition-colors hover:bg-white/[0.05]"
                style={{
                  color: "var(--text-primary)",
                  borderColor: "color-mix(in srgb, var(--accent-warning) 34%, var(--border-subtle))",
                  background: "color-mix(in srgb, var(--accent-warning) 7%, transparent)",
                }}
              >
                <RotateCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                Retry file tree
              </motion.button>
            ) : isNoPermission ? (
              <motion.button
                {...tapProps}
                type="button"
                onClick={onRequestFileOps}
                className="th-focus-ring flex h-8 items-center gap-2 rounded-md border px-2.5 text-left text-[11px] font-semibold transition-colors hover:bg-white/[0.05]"
                style={{
                  color: "var(--text-primary)",
                  borderColor: "color-mix(in srgb, var(--attention-purple) 28%, var(--border-subtle))",
                  background: "color-mix(in srgb, var(--attention-purple) 7%, transparent)",
                }}
              >
                <LockKeyhole className="h-3.5 w-3.5" strokeWidth={1.5} />
                Request file access
              </motion.button>
            ) : (
              <motion.button
                {...tapProps}
                type="button"
                onClick={onUpload}
                disabled={isUploading}
                aria-label="Upload files to workspace root"
                className="th-focus-ring flex h-8 items-center gap-2 rounded-md border px-2.5 text-left text-[11px] font-semibold transition-colors hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  color: "var(--text-primary)",
                  borderColor: "color-mix(in srgb, var(--attention-purple) 28%, var(--border-subtle))",
                  background: "color-mix(in srgb, var(--attention-purple) 7%, transparent)",
                }}
              >
                {isUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                )}
                Upload files
              </motion.button>
            )}
            {!isError && !isNoPermission && (
              <div className="grid grid-cols-2 gap-1.5">
                <motion.button
                  {...tapProps}
                  type="button"
                  onClick={onNewFile}
                  aria-label="Create file from template"
                  className="th-focus-ring flex h-8 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors hover:bg-white/[0.05]"
                  style={{
                    color: "var(--text-secondary)",
                    borderColor: "var(--border-subtle)",
                    background: "transparent",
                  }}
                >
                  <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  New file
                </motion.button>
                <motion.button
                  {...tapProps}
                  type="button"
                  onClick={onNewFolder}
                  aria-label="Create folder in workspace root"
                  className="th-focus-ring flex h-8 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors hover:bg-white/[0.05]"
                  style={{
                    color: "var(--text-secondary)",
                    borderColor: "var(--border-subtle)",
                    background: "transparent",
                  }}
                >
                  <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                  New folder
                </motion.button>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ExplorerRootDropTarget({ active, disabled, onActivate, onDragOver, onDrop, onDragLeave }) {
  const handleKeyDown = (event) => {
    if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onActivate?.(event);
  };

  return (
    <div
      data-testid="workspace-root-drop-target"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={disabled ? "Workspace root drop target unavailable" : "Drop files into workspace root"}
      onClick={disabled ? undefined : onActivate}
      onKeyDown={handleKeyDown}
      onDragOver={disabled ? undefined : onDragOver}
      onDrop={disabled ? undefined : onDrop}
      onDragLeave={disabled ? undefined : onDragLeave}
      className="th-focus-ring mx-2 mt-2 flex min-h-8 items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors"
      style={{
        borderColor: active
          ? "color-mix(in srgb, var(--attention-purple) 42%, var(--border-subtle))"
          : "var(--border-subtle)",
        background: active
          ? "color-mix(in srgb, var(--attention-purple) 10%, transparent)"
          : "color-mix(in srgb, var(--bg-sidebar) 88%, var(--bg-editor) 12%)",
        color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
        opacity: disabled ? 0.68 : 1,
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Upload className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
        <span className="truncate text-[11px] font-medium">Workspace root</span>
      </span>
      <span className="hidden text-[10px] sm:inline" style={{ color: "var(--text-muted)" }}>
        {disabled ? "Read-only" : active ? "Drop here" : "Root drop"}
      </span>
    </div>
  );
}

const FileTreeView = ({ onToggleOrientation }) => {
  const dispatch = useAppDispatch();

  // State pulled from Redux
  const files = useAppSelector(selectFilesTree);
  const activeFile = useAppSelector(selectActiveFile);
  const uiActionState = useAppSelector(selectUiActionState);
  const isRightSide = useAppSelector(selectTreeOnRight);
  const slug = useAppSelector((state) => state.workspace.slug);
  const filesStatus = useAppSelector((state) => state.workspace.status);
  const filesLoading = useAppSelector((state) => state.workspace.isLoading);
  const filesError = useAppSelector((state) => state.workspace.error);
  const { canFileOps, role } = useSessionPermissions();
  const canMutateFiles = canFileOps !== false;
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
    const mutatingActions = new Set([
      "new-file",
      "new-file-root",
      "new-folder",
      "new-folder-root",
      "rename",
      "delete",
    ]);
    if (!canMutateFiles && mutatingActions.has(action)) {
      toast.error("File operations are disabled for this session.");
      return;
    }

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
  }, [canMutateFiles, dispatch, files, openPicker]);

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
    if (!canMutateFiles) {
      toast.error("File operations are disabled for this session.");
      return;
    }
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
  }, [canMutateFiles, dispatch, slug]);

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
    if (!canMutateFiles) return;
    setExternalDropTargetFolder(targetFolder || "");
    setIsExternalDropActive(true);
  }, [canMutateFiles]);

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
    if (!canMutateFiles) {
      if (
        dataTransferHasType(e.dataTransfer, "Files") ||
        e.dataTransfer.types.includes("application/x-synthi-tree-item")
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
      }
      return;
    }
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
  }, [canMutateFiles, externalDropTargetFolder, getFolderDropTargetFromEvent, isExternalDropActive]);

  const handleRootTargetDragOver = useCallback((e) => {
    if (!canMutateFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
      return;
    }
    if (dataTransferHasType(e.dataTransfer, "Files")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setIsExternalDropActive(true);
      setExternalDropTargetFolder("");
      return;
    }
    if (!e.dataTransfer.types.includes("application/x-synthi-tree-item")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setExternalDropTargetFolder("");
  }, [canMutateFiles]);

  const handleRootDrop = useCallback(async (e) => {
    if (!canMutateFiles) {
      if (
        dataTransferHasType(e.dataTransfer, "Files") ||
        e.dataTransfer.types.includes("application/x-synthi-tree-item")
      ) {
        e.preventDefault();
        e.stopPropagation();
        toast.error("File operations are disabled for this session.");
      }
      setIsExternalDropActive(false);
      setExternalDropTargetFolder("");
      return;
    }
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
  }, [canMutateFiles, dispatch, externalDropTargetFolder, getFolderDropTargetFromEvent, handleExternalFilesDrop]);

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
  const hasExplorerRows = flatNodes.length > 0;
  const explorerState = filesLoading && !hasExplorerRows
    ? "loading"
    : filesStatus === "failed" && !hasExplorerRows
      ? "error"
      : !canMutateFiles && !hasExplorerRows
        ? "permission"
        : "empty";

  const handleUploadButtonClick = useCallback((event) => {
    event?.stopPropagation?.();
    if (!canMutateFiles) {
      toast.error("File operations are disabled for this session.");
      return;
    }
    uploadInputRef.current?.click();
  }, [canMutateFiles]);

  const handleEmptyNewFile = useCallback((event) => {
    event?.stopPropagation?.();
    handleTreeAction("new-file-root");
  }, [handleTreeAction]);

  const handleEmptyNewFolder = useCallback((event) => {
    event?.stopPropagation?.();
    handleTreeAction("new-folder-root");
  }, [handleTreeAction]);

  const handleRetryFiles = useCallback((event) => {
    event?.stopPropagation?.();
    if (!slug) return;
    dispatch(fetchFilesThunk(slug));
  }, [dispatch, slug]);

  const handleRequestFileOps = useCallback((event) => {
    event?.stopPropagation?.();
    if (role === "guest") {
      collabSessionService.requestPermission("canFileOps");
      toast.info("Requested file access from the host.");
      return;
    }
    toast.info("File operations are not available in this workspace.");
  }, [role]);

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
        canMutateFiles={canMutateFiles}
        uiActionState={uiActionState}
        dispatch={dispatch}
        handleKeyDown={handleKeyDown}
        handleBlur={handleBlur}
        shallow
      />
    );
  }, [flatNodes, isTreeHovered, activeFolderPath, onFileSelectHandler, activeFile, handleTreeAction, handleExternalFilesDrop, handleExternalFolderDragTarget, externalDropTargetFolder, canMutateFiles, uiActionState, dispatch, handleKeyDown, handleBlur, isCreatingFolder, name]);

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
            aria-label="Upload files to workspace root"
            className="sr-only"
            onChange={handleUploadInputChange}
            disabled={!canMutateFiles}
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
                type="button"
                data-testid="workspace-file-upload-button"
                onClick={handleUploadButtonClick}
                disabled={isUploading || !canMutateFiles}
                title="Upload files"
                aria-label="Upload files to workspace root"
                className="th-focus-ring p-1.5 rounded-lg transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: isUploading ? "var(--attention-purple)" : "var(--text-muted)" }}
              >
                {isUploading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Upload className="w-3.5 h-3.5" strokeWidth={1.5} />
                )}
              </button>
              <button
                type="button"
                onClick={onToggleOrientation}
                title={isRightSide ? "Move to left" : "Move to right"}
                aria-label={isRightSide ? "Move explorer to left" : "Move explorer to right"}
                className="th-focus-ring p-1.5 rounded-lg transition-colors hover:bg-white/[0.06]"
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

          <ExplorerRootDropTarget
            active={isExternalDropActive && !externalDropTargetFolder}
            disabled={!canMutateFiles}
            onActivate={handleUploadButtonClick}
            onDragOver={handleRootTargetDragOver}
            onDrop={handleRootDrop}
            onDragLeave={handleRootDragLeave}
          />

          {/* Virtualised file list. The create-input row (root or folder
              target) is injected as a synthetic Virtuoso row by
              useVirtualizedTree and rendered by renderRow above. */}
          <div
            className="flex-1 py-0.5"
            role="tree"
            aria-label="Workspace file explorer"
            style={{ minHeight: 0 }}
          >
            {hasExplorerRows ? (
              <Virtuoso
                totalCount={flatNodes.length}
                overscan={200}
                itemContent={renderRow}
                computeItemKey={(index) => flatNodes[index]?.key ?? index}
                style={{ height: '100%' }}
                increaseViewportBy={{ top: 200, bottom: 200 }}
              />
            ) : (
              <ExplorerStatePanel
                state={explorerState}
                errorMessage={filesError}
                isUploading={isUploading}
                onUpload={handleUploadButtonClick}
                onNewFile={handleEmptyNewFile}
                onNewFolder={handleEmptyNewFolder}
                onRetry={handleRetryFiles}
                onRequestFileOps={handleRequestFileOps}
              />
            )}
          </div>

          {isExternalDropActive && !externalDropTargetFolder && (
            <div
              data-testid="workspace-file-drop-overlay"
              className="pointer-events-none absolute inset-1 z-[2] rounded-lg border border-dashed"
              style={{
                borderColor: "color-mix(in srgb, var(--attention-purple) 56%, transparent)",
                background: "transparent",
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--attention-purple) 12%, transparent)",
              }}
            >
              <div
                className="absolute bottom-2 left-2 right-2 flex items-center gap-2 rounded-md border px-2.5 py-2 text-left"
                style={{
                  borderColor: "color-mix(in srgb, var(--attention-purple) 24%, var(--border-subtle))",
                  background: "color-mix(in srgb, var(--bg-sidebar) 94%, var(--attention-purple) 6%)",
                  boxShadow: "0 8px 18px -16px color-mix(in srgb, var(--attention-purple) 42%, transparent)",
                }}
              >
                <Upload className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--attention-purple)" }} />
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>
                    Drop on a folder to upload there
                  </div>
                  <div className="truncate text-[10px]" style={{ color: "var(--text-muted)" }}>
                    Empty space uploads to workspace root.
                  </div>
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
                disabled={!canMutateFiles}
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
              >
                New File
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("new-folder", contextTarget)}
                disabled={!canMutateFiles}
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
                disabled={!canMutateFiles}
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("delete", contextTarget)}
                disabled={!canMutateFiles}
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
                disabled={!canMutateFiles}
                className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleTreeAction("delete", contextTarget)}
                disabled={!canMutateFiles}
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
              disabled={!canMutateFiles}
              className="px-3 py-2.5 text-sm th-dropdown-item cursor-pointer rounded-md mx-1"
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => handleTreeAction("new-folder-root")}
              disabled={!canMutateFiles}
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
