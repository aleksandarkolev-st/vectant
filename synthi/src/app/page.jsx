"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  PiArrowRight as ArrowRight,
  PiCheckCircle as CheckCircle2,
  PiClock as Clock,
  PiCloudArrowUp as UploadCloud,
  PiCodeSimple as Code2,
  PiCommand as Command,
  PiDatabase as Database,
  PiFileArchive as FileArchive,
  PiFolderOpen as FolderOpen,
  PiFolderPlus as FolderPlus,
  PiGitBranch as FolderGit2,
  PiGithubLogo as Github,
  PiGlobe as Globe,
  PiHardDrives as Server,
  PiHouse as Home,
  PiKey as KeyRound,
  PiLock as Lock,
  PiNetwork as Network,
  PiPulse as Activity,
  PiSignOut as LogOut,
  PiSpinner as Loader2,
  PiStackSimple as Layers3,
  PiWarningCircle as AlertCircle,
  PiX as X,
} from "react-icons/pi";
import AIJumpstartSection from "@/components/dashboard/AIJumpstartSection";
import { storeJumpstartPayload } from "@/lib/ai-jumpstart-session";
import { resolveCollabHttpUrl } from "@/lib/collab-url";
import { toast } from "sonner";

const LAST_WORKSPACE_KEY = "vectant:last-workspace";
const MAX_LOCAL_UPLOAD_FILES = 240;
const MAX_LOCAL_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_UPLOAD_FILE_BYTES = 24 * 1024 * 1024;
const IGNORED_UPLOAD_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".cache",
  ".turbo",
]);

function relativeTime(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createSlug(prefix = "ws") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUploadPath(rawPath) {
  return String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function isIgnoredUploadPath(path) {
  return normalizeUploadPath(path)
    .split("/")
    .some((segment) => IGNORED_UPLOAD_SEGMENTS.has(segment));
}

function inferWorkspaceName(entries) {
  const firstPath = entries[0]?.path || "";
  const firstSegment = firstPath.split("/").filter(Boolean)[0];
  if (entries.length > 1 && firstSegment && entries.every((entry) => entry.path.startsWith(`${firstSegment}/`))) {
    return firstSegment;
  }
  const fileName = firstPath.split("/").pop() || "uploaded-workspace";
  return fileName.replace(/\.[^.]+$/, "") || "uploaded-workspace";
}

function repoNameFromUrl(repoUrl) {
  const clean = String(repoUrl || "").trim().replace(/\/+$/, "");
  const tail = clean.split("/").pop() || "imported-repo";
  return tail.replace(/\.git$/i, "") || "imported-repo";
}

async function readResponseError(response, fallbackMessage) {
  try {
    const data = await response.json();
    if (data?.error) return data.error;
    if (data?.message) return data.message;
  } catch (_) {
    const text = await response.text().catch(() => "");
    if (text) return text;
  }

  return fallbackMessage;
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

function modeTitle(mode) {
  switch (mode) {
    case "local":
      return "Import files from disk";
    case "create":
      return "Initialize from brief";
    default:
      return "Import repository";
  }
}

const workspaceSignals = [
  { icon: Server, label: "Runtime isolation", detail: "Scoped container worktrees" },
  { icon: Database, label: "State registry", detail: "Imports, uploads, creates saved" },
  { icon: KeyRound, label: "Access boundary", detail: "User-scoped file operations" },
];

const launcherStatusRows = [
  ["source.ingest", "repo/folder/files"],
  ["runtime.mode", "local container"],
  ["agent.context", "optional brief"],
  ["recents.write", "enabled"],
];

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const collabServerUrl = resolveCollabHttpUrl();

  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const [workspaces, setWorkspaces] = useState([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [lastWorkspace, setLastWorkspace] = useState(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [importing, setImporting] = useState(false);

  const [localWorkspaceName, setLocalWorkspaceName] = useState("");
  const [localUploadFiles, setLocalUploadFiles] = useState([]);
  const [localUploadSkipped, setLocalUploadSkipped] = useState([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [uploadingLocal, setUploadingLocal] = useState(false);

  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoDesc, setNewRepoDesc] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [creating, setCreating] = useState(false);

  const [aiJumpstart, setAiJumpstart] = useState(true);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiAttachments, setAiAttachments] = useState([]);
  const [aiProjectType, setAiProjectType] = useState(null);

  const [activeTab, setActiveTab] = useState("local");
  const [feedback, setFeedback] = useState(null);

  const isActionLoading = importing || creating || uploadingLocal;

  const localUploadSummary = useMemo(() => {
    const totalBytes = localUploadFiles.reduce((sum, item) => sum + item.file.size, 0);
    return {
      totalBytes,
      label: `${localUploadFiles.length} ${localUploadFiles.length === 1 ? "file" : "files"} / ${humanBytes(totalBytes)}`,
    };
  }, [localUploadFiles]);

  const fetchWorkspaces = useCallback(async (email) => {
    setLoadingWorkspaces(true);
    try {
      const res = await fetch(
        `${collabServerUrl}/workspaces?owner=${encodeURIComponent(email)}&recent=true`,
      );
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(Array.isArray(data) ? data : []);
      }
    } catch (e) {
      console.error("Failed to fetch recent workspaces", e);
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [collabServerUrl]);

  const ensureWorkspaceRecord = useCallback(async ({ slug, name, repoUrl }) => {
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, name, repoUrl }),
    });

    if (response.ok || response.status === 409) return;

    const errorMessage = await readResponseError(
      response,
      "Failed to register workspace.",
    );
    throw new Error(errorMessage);
  }, []);

  useEffect(() => {
    if (session?.user?.email) {
      fetchWorkspaces(session.user.email);
    } else {
      setLoadingWorkspaces(false);
    }
  }, [session, fetchWorkspaces]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_WORKSPACE_KEY);
      if (raw) setLastWorkspace(JSON.parse(raw));
    } catch (_) {
      setLastWorkspace(null);
    }
  }, []);

  const addLocalFiles = useCallback((entries) => {
    const incoming = Array.from(entries || []);
    if (!incoming.length) return;

    const previous = new Map(localUploadFiles.map((entry) => [entry.path, entry]));
    const skipped = [];
    let totalBytes = localUploadFiles.reduce((sum, item) => sum + item.file.size, 0);

    for (const entry of incoming) {
      const file = entry.file || entry;
      const path = normalizeUploadPath(entry.path || file.webkitRelativePath || file.name);

      if (!path || isIgnoredUploadPath(path)) {
        skipped.push({ path: path || file.name, reason: "ignored" });
        continue;
      }
      if (file.size > MAX_LOCAL_UPLOAD_FILE_BYTES) {
        skipped.push({ path, reason: `over ${humanBytes(MAX_LOCAL_UPLOAD_FILE_BYTES)}` });
        continue;
      }
      if (!previous.has(path) && previous.size >= MAX_LOCAL_UPLOAD_FILES) {
        skipped.push({ path, reason: `over ${MAX_LOCAL_UPLOAD_FILES} file limit` });
        continue;
      }
      if (!previous.has(path) && totalBytes + file.size > MAX_LOCAL_UPLOAD_TOTAL_BYTES) {
        skipped.push({ path, reason: `over ${humanBytes(MAX_LOCAL_UPLOAD_TOTAL_BYTES)} total` });
        continue;
      }

      const replaced = previous.get(path);
      if (!replaced) totalBytes += file.size;
      previous.set(path, { file, path });
    }

    const nextFiles = Array.from(previous.values()).sort((a, b) => a.path.localeCompare(b.path));
    setLocalUploadFiles(nextFiles);
    setLocalUploadSkipped(skipped);
    if (!localWorkspaceName.trim() && nextFiles.length) {
      setLocalWorkspaceName(inferWorkspaceName(nextFiles));
    }
    if (skipped.length) {
      toast.warning(`${skipped.length} item${skipped.length === 1 ? "" : "s"} skipped`);
    }
  }, [localUploadFiles, localWorkspaceName]);

  const handleFileInputChange = useCallback((event) => {
    addLocalFiles(
      Array.from(event.target.files || []).map((file) => ({
        file,
        path: normalizeUploadPath(file.webkitRelativePath || file.name),
      })),
    );
    event.target.value = "";
  }, [addLocalFiles]);

  const handleDrop = useCallback(async (event) => {
    event.preventDefault();
    setIsDraggingFiles(false);
    setFeedback(null);

    try {
      const files = await filesFromDataTransfer(event.dataTransfer);
      addLocalFiles(files);
    } catch (error) {
      console.error(error);
      setFeedback({
        type: "error",
        message: "Could not read the dropped files. Try the file picker instead.",
      });
    }
  }, [addLocalFiles]);

  const handleImport = async (event) => {
    event.preventDefault();
    if (!repoUrl.trim()) return;
    setImporting(true);
    setFeedback(null);
    try {
      const slug = createSlug("repo");
      const name = repoNameFromUrl(repoUrl);
      const userId = session?.user?.id || session?.user?.email;

      const res = await fetch(`${collabServerUrl}/git/${slug}/clone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          repoUrl,
          token: session?.accessToken,
          owner: session?.user?.email,
          name,
          source: "import",
          showInRecent: true,
        }),
      });

      if (!res.ok) {
        const errorMessage = await readResponseError(res, "Unknown error");
        throw new Error(`Import failed: ${errorMessage}`);
      }

      await ensureWorkspaceRecord({ slug, name, repoUrl });
      setRepoUrl("");
      router.push(`/${slug}`);
    } catch (error) {
      console.error(error);
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Import failed. Check the URL and try again.",
      });
    } finally {
      setImporting(false);
    }
  };

  const handleLocalUpload = async (event) => {
    event.preventDefault();
    if (!localUploadFiles.length) return;

    const slug = createSlug("local");
    const name = localWorkspaceName.trim() || inferWorkspaceName(localUploadFiles);
    const userId = session?.user?.id || session?.user?.email;

    setUploadingLocal(true);
    setFeedback(null);
    try {
      const initRes = await fetch(`${collabServerUrl}/git/${slug}/init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          owner: session?.user?.email,
          name,
          source: "local-upload",
          showInRecent: true,
        }),
      });

      if (!initRes.ok) {
        const errorMessage = await readResponseError(initRes, "Workspace init failed");
        throw new Error(errorMessage);
      }

      const files = await Promise.all(localUploadFiles.map(fileToBatchEntry));
      const writeRes = await fetch(`${collabServerUrl}/git/${slug}/write-files-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          files,
          syncToGcs: true,
          source: "local-upload",
          showInRecent: true,
        }),
      });

      if (!writeRes.ok) {
        const errorMessage = await readResponseError(writeRes, "Upload failed");
        throw new Error(errorMessage);
      }

      const writeData = await writeRes.json();
      if (Array.isArray(writeData?.errors) && writeData.errors.length > 0) {
        throw new Error(`Uploaded ${writeData.written?.length || 0} files, but ${writeData.errors.length} failed.`);
      }

      await ensureWorkspaceRecord({ slug, name, repoUrl: null });
      setLocalUploadFiles([]);
      setLocalUploadSkipped([]);
      setLocalWorkspaceName("");
      router.push(`/${slug}`);
    } catch (error) {
      console.error(error);
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Upload failed. Try a smaller selection.",
      });
    } finally {
      setUploadingLocal(false);
    }
  };

  const handleCreateRepo = async (event) => {
    event.preventDefault();
    if (!newRepoName.trim()) return;

    if (aiJumpstart && !aiProjectType) {
      setFeedback({
        type: "error",
        message: "Choose a project type for AI creation, or turn AI creation off.",
      });
      return;
    }
    if (aiJumpstart && !aiPrompt.trim()) {
      setFeedback({
        type: "error",
        message: "Describe what the AI workspace should build.",
      });
      return;
    }

    setCreating(true);
    setFeedback(null);
    try {
      const createRes = await fetch("/api/github/create-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newRepoName.trim(),
          description: newRepoDesc.trim(),
          isPrivate: newRepoPrivate,
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        const errorMessage = err.error || "Failed to create repository.";
        toast.error(errorMessage);
        throw new Error(errorMessage);
      }

      const repo = await createRes.json();
      const slug = createSlug("ai");
      const userId = session?.user?.id || session?.user?.email;
      const showInRecent = true;

      const cloneRes = await fetch(`${collabServerUrl}/git/${slug}/clone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          repoUrl: repo.cloneUrl,
          token: session?.accessToken,
          owner: session?.user?.email,
          name: repo.name,
          source: aiJumpstart ? "ai" : "create",
          showInRecent,
        }),
      });

      if (!cloneRes.ok) {
        const errorMessage = await readResponseError(cloneRes, "Unknown error");
        throw new Error(`Repository created on GitHub but workspace setup failed: ${errorMessage}`);
      }

      await ensureWorkspaceRecord({
        slug,
        name: repo.name,
        repoUrl: repo.cloneUrl,
      });

      if (showInRecent && session?.user?.email) {
        await fetchWorkspaces(session.user.email);
      }

      if (aiJumpstart && aiPrompt.trim()) {
        storeJumpstartPayload({
          prompt: aiPrompt.trim(),
          attachments: aiAttachments,
          projectType: aiProjectType,
        });
      }

      setNewRepoName("");
      setNewRepoDesc("");
      setAiJumpstart(true);
      setAiPrompt("");
      setAiAttachments([]);
      setAiProjectType(null);
      router.push(`/${slug}`);
    } catch (error) {
      console.error(error);
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Something went wrong. Please try again.",
      });
    } finally {
      setCreating(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--bg-app)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading session
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <main className="min-h-[100dvh] overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
        <section className="relative mx-auto flex min-h-[100dvh] w-full max-w-6xl items-center px-6 py-12">
          <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_390px] lg:items-stretch">
            <div className="flex min-h-[500px] flex-col justify-between rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_88%,transparent)] p-5">
              <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-4">
                <img src="/vectant-dark-theme.png" alt="Vectant" className="h-8 w-auto" />
                <span className="rounded-md border border-[var(--border-subtle)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--text-muted)]">
                  auth required
                </span>
              </div>

              <div className="max-w-2xl">
                <div className="mb-4 inline-flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_58%,transparent)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
                  <Network className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
                  Workspace control plane
                </div>
                <h1 className="max-w-2xl text-3xl font-semibold leading-tight tracking-normal md:text-4xl">
                  Provision workspaces behind an identity boundary.
                </h1>
                <p className="mt-5 max-w-xl text-sm leading-6 text-[var(--text-secondary)]">
                  Import repositories, local files, or agent briefs only after Vectant can attach ownership, runtime scope, and file operation permissions.
                </p>
              </div>

              <div className="grid gap-2 md:grid-cols-3">
                {workspaceSignals.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_50%,transparent)] p-3">
                      <Icon className="mb-2 h-4 w-4 text-[var(--attention-purple)]" />
                      <div className="text-xs font-semibold">{item.label}</div>
                      <div className="mt-1 text-[11px] text-[var(--text-muted)]">{item.detail}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_92%,transparent)] p-5">
              <div className="mb-5 border-b border-[var(--border-subtle)] pb-5">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-medium)] bg-[var(--bg-surface)]">
                  <KeyRound className="h-5 w-5 text-[var(--attention-purple)]" />
                </div>
                <h2 className="text-2xl font-semibold">Authenticate</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                  Sign in to unlock workspace provisioning.
                </p>
              </div>
              <button
                type="button"
                onClick={() => signIn("github", { callbackUrl: "/" })}
                className="th-focus-ring flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-[var(--bg-app)] transition hover:opacity-90"
              >
                <Github className="h-4 w-4" />
                Continue with GitHub
              </button>
              <button
                type="button"
                onClick={() => router.push("/login")}
                className="th-focus-ring mt-3 flex h-10 w-full items-center justify-center rounded-md border border-[var(--border-medium)] text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
              >
                More auth options
              </button>
              <div className="mt-5 rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_52%,transparent)] p-3 font-mono text-[11px] text-[var(--text-muted)]">
                {launcherStatusRows.slice(0, 3).map(([event, state]) => (
                  <div key={event} className="flex items-center justify-between gap-3 py-1">
                    <span>{event}</span>
                    <span>{state}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const modes = [
    { id: "local", icon: UploadCloud, label: "Files", detail: "Drop or browse" },
    { id: "import", icon: Github, label: "Repo", detail: "Clone from URL" },
    { id: "create", icon: Command, label: "Agent", detail: "Brief to repo" },
  ];
  const handleModeKeyDown = (event, index) => {
    const lastIndex = modes.length - 1;
    let nextIndex = index;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = index === lastIndex ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = index === 0 ? lastIndex : index - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = lastIndex;
    else return;

    event.preventDefault();
    setActiveTab(modes[nextIndex].id);
  };

  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-[0.055]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--text-primary) 10%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--text-primary) 10%, transparent) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          maskImage: "linear-gradient(to bottom, black, transparent 84%)",
        }}
      />

      <header className="relative z-10 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_88%,transparent)]">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5 md:px-8">
          <div className="flex items-center gap-3">
            <img src="/vectant/the_V.png" alt="" className="h-7 w-7 object-contain" draggable={false} />
            <div>
              <div className="text-sm font-semibold">Vectant ADE</div>
              <div className="text-xs text-[var(--text-muted)]">Control plane</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {lastWorkspace?.slug && (
              <button
                type="button"
                onClick={() => router.push(`/${lastWorkspace.slug}`)}
                aria-label={`Return to workspace ${lastWorkspace.name || lastWorkspace.slug}`}
                className="th-focus-ring hidden h-8 items-center gap-2 rounded-md border border-[var(--border-medium)] px-3 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] sm:flex"
              >
                <Home className="h-4 w-4" />
                Return to workspace
              </button>
            )}
            {session.user?.image && (
              <img
                src={session.user.image}
                alt=""
                className="h-8 w-8 rounded-full border border-[var(--border-medium)]"
              />
            )}
            <button
              type="button"
              onClick={() => signOut()}
              className="th-focus-ring flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto grid max-w-7xl gap-5 px-5 py-5 md:px-8 lg:grid-cols-[minmax(0,1fr)_370px]">
        <section className="min-w-0">
          <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-stretch">
            <div className="rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_84%,transparent)] p-4">
              <p className="mb-3 inline-flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_70%,transparent)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)]">
                <Command className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
                Workspace control plane
              </p>
              <h1 className="max-w-3xl text-2xl font-semibold leading-tight tracking-normal md:text-3xl">
                Provision a source workspace.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
                Attach a repository, local folder, or agent brief to an owned worktree before the editor runtime opens.
              </p>
              <div className="mt-4 grid max-w-3xl gap-2 sm:grid-cols-3">
                {workspaceSignals.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.label}
                      className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_50%,transparent)] px-3 py-3"
                    >
                      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                        <Icon className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
                        {item.label}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--text-muted)]">{item.detail}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_88%,transparent)] p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                  <Activity className="h-3.5 w-3.5 text-[var(--attention-purple)]" />
                  Provisioning state
                </div>
                <span className="rounded-md border border-[var(--border-subtle)] px-2 py-1 font-mono text-[10px] text-[var(--text-muted)]">
                  configured
                </span>
              </div>
              <div className="space-y-1.5 font-mono text-[11px]">
                {launcherStatusRows.map(([event, state]) => (
                  <div key={event} className="grid grid-cols-[minmax(0,1fr)_124px] gap-3 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_46%,transparent)] px-3 py-2">
                    <span className="truncate text-[var(--text-secondary)]">{event}</span>
                    <span className="whitespace-nowrap text-right text-[10px] text-[var(--text-muted)]">{state}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div
            className="mb-3 flex w-full rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_90%,transparent)] p-1"
            role="tablist"
            aria-label="Workspace source mode"
          >
              {modes.map((mode, index) => {
                const Icon = mode.icon;
                const active = activeTab === mode.id;
                return (
                  <button
                    key={mode.id}
                    id={`workspace-mode-tab-${mode.id}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`workspace-mode-panel-${mode.id}`}
                    tabIndex={active ? 0 : -1}
                    onClick={() => setActiveTab(mode.id)}
                    onKeyDown={(event) => handleModeKeyDown(event, index)}
                    className="th-focus-ring relative flex h-12 flex-1 min-w-0 items-center justify-center gap-2 rounded-md px-3 py-2 text-left text-sm transition"
                    style={{ color: active ? "var(--text-primary)" : "var(--text-muted)" }}
                  >
                    {active && (
                      <motion.span
                        layoutId="workspace-mode-active"
                        className="absolute inset-0 rounded-md bg-[var(--bg-surface)]"
                        transition={{ duration: 0.16 }}
                      />
                    )}
                    <Icon className="relative h-4 w-4 shrink-0" />
                    <span className="relative hidden min-w-[76px] flex-col sm:flex">
                      <span className="text-xs font-semibold">{mode.label}</span>
                      <span className="text-[10px] opacity-70">{mode.detail}</span>
                    </span>
                  </button>
                );
              })}
          </div>

          {feedback && (
            <div
              className="mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm"
              style={{
                background:
                  feedback.type === "error"
                    ? "color-mix(in srgb, var(--accent-danger) 11%, transparent)"
                    : "color-mix(in srgb, var(--accent-success) 11%, transparent)",
                borderColor:
                  feedback.type === "error"
                    ? "color-mix(in srgb, var(--accent-danger) 32%, transparent)"
                    : "color-mix(in srgb, var(--accent-success) 32%, transparent)",
                color: feedback.type === "error" ? "var(--accent-danger)" : "var(--accent-success)",
              }}
            >
              {feedback.type === "error" ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              <span className="flex-1">{feedback.message}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                aria-label="Dismiss"
                className="th-focus-ring rounded-sm opacity-70 hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_91%,transparent)]">
            <div className="border-b border-[var(--border-subtle)] px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_58%,transparent)]">
                    {activeTab === "local" ? (
                      <UploadCloud className="h-4 w-4 text-[var(--attention-purple)]" />
                    ) : activeTab === "create" ? (
                      <Command className="h-4 w-4 text-[var(--attention-purple)]" />
                    ) : (
                      <Github className="h-4 w-4 text-[var(--attention-purple)]" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">{modeTitle(activeTab)}</h2>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                      {activeTab === "local"
                        ? "Selected files are written into a fresh workspace and saved in recents."
                        : activeTab === "create"
                          ? "A validated brief creates a repository, then opens it inside a scoped runtime."
                          : "Cloned repositories open immediately and stay in recents."}
                    </p>
                  </div>
                </div>
                <span className="hidden rounded-md border border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-muted)] sm:inline-flex">
                  {activeTab === "local" ? localUploadSummary.label : isActionLoading ? "Working" : "Ready"}
                </span>
              </div>
            </div>

            <AnimatePresence mode="wait">
              {activeTab === "local" && (
                <motion.form
                  key="local"
                  id="workspace-mode-panel-local"
                  role="tabpanel"
                  aria-labelledby="workspace-mode-tab-local"
                  onSubmit={handleLocalUpload}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="p-5"
                >
                  <input
                    ref={fileInputRef}
                    data-testid="workspace-local-file-input"
                    type="file"
                    multiple
                    aria-label="Select files for workspace import"
                    className="sr-only"
                    onChange={handleFileInputChange}
                  />
                  <input
                    ref={folderInputRef}
                    data-testid="workspace-local-folder-input"
                    type="file"
                    multiple
                    webkitdirectory="true"
                    aria-label="Select folder for workspace import"
                    className="sr-only"
                    onChange={handleFileInputChange}
                  />

                  <motion.div
                    data-testid="workspace-local-dropzone"
                    role="button"
                    tabIndex={0}
                    aria-label="Drop files here or press Enter to browse files"
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setIsDraggingFiles(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                      setIsDraggingFiles(true);
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) setIsDraggingFiles(false);
                    }}
                    onDrop={handleDrop}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      fileInputRef.current?.click();
                    }}
                    className="th-focus-ring relative flex min-h-[240px] flex-col items-start justify-center overflow-hidden rounded-md border border-dashed p-5 text-left transition"
                    style={{
                      borderColor: isDraggingFiles ? "var(--attention-purple)" : "var(--border-strong)",
                      background: isDraggingFiles
                        ? "color-mix(in srgb, var(--attention-purple) 12%, transparent)"
                        : "color-mix(in srgb, var(--bg-app) 54%, transparent)",
                    }}
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-8 top-0 h-px"
                      style={{
                        background:
                          "linear-gradient(90deg, transparent, color-mix(in srgb, var(--attention-purple) 70%, transparent), transparent)",
                      }}
                    />
                    <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md border border-[var(--border-medium)] bg-[var(--bg-surface)]">
                      <UploadCloud className="h-5 w-5 text-[var(--text-primary)]" />
                    </div>
                    <h3 className="text-lg font-semibold">Ingest local source files</h3>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--text-muted)]">
                      Drag a project folder or selected files. Generated directories are skipped before the workspace is written.
                    </p>
                    <div className="mt-5 flex flex-wrap gap-3">
                      <button
                        type="button"
                        data-testid="workspace-local-browse-files"
                        onClick={() => fileInputRef.current?.click()}
                        aria-label="Browse files to import"
                        className="th-focus-ring flex h-10 items-center gap-2 rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-[var(--bg-app)] transition hover:opacity-90"
                      >
                        <FolderOpen className="h-4 w-4" />
                        Browse files
                      </button>
                      <button
                        type="button"
                        data-testid="workspace-local-browse-folder"
                        onClick={() => folderInputRef.current?.click()}
                        aria-label="Browse a folder to import"
                        className="th-focus-ring flex h-10 items-center gap-2 rounded-md border border-[var(--border-medium)] px-4 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
                      >
                        <FolderPlus className="h-4 w-4" />
                        Browse folder
                      </button>
                    </div>
                  </motion.div>

                  <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
                    <label className="block">
                      <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">
                        Workspace name
                      </span>
                      <input
                        value={localWorkspaceName}
                        onChange={(event) => setLocalWorkspaceName(event.target.value)}
                        disabled={isActionLoading}
                        placeholder="uploaded-workspace"
                        className="th-focus-ring h-11 w-full rounded-md border border-[var(--border-medium)] bg-[var(--bg-app)] px-3 text-sm outline-none transition focus:border-[var(--attention-purple)]"
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={uploadingLocal || !localUploadFiles.length}
                      className="th-focus-ring mt-auto flex h-11 items-center justify-center gap-2 rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-[var(--bg-app)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {uploadingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileArchive className="h-4 w-4" />}
                      Open workspace
                    </button>
                  </div>

                  {(localUploadFiles.length > 0 || localUploadSkipped.length > 0) && (
                    <div className="mt-5 rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_52%,transparent)]">
                      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
                        <span className="text-sm font-medium">{localUploadSummary.label}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setLocalUploadFiles([]);
                            setLocalUploadSkipped([]);
                          }}
                          className="th-focus-ring rounded-sm text-xs text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="max-h-44 overflow-auto px-2 py-2">
                        {localUploadFiles.slice(0, 80).map((entry) => (
                          <div key={entry.path} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)]">
                            <span className="min-w-0 truncate font-mono">{entry.path}</span>
                            <span className="shrink-0 text-[var(--text-dim)]">{humanBytes(entry.file.size)}</span>
                          </div>
                        ))}
                        {localUploadFiles.length > 80 && (
                          <div className="px-2 py-1.5 text-xs text-[var(--text-muted)]">
                            {localUploadFiles.length - 80} more files selected
                          </div>
                        )}
                        {localUploadSkipped.slice(0, 6).map((item) => (
                          <div key={`${item.path}-${item.reason}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[var(--accent-warning)]">
                            <AlertCircle className="h-3.5 w-3.5" />
                            <span className="min-w-0 truncate">{item.path}</span>
                            <span className="shrink-0 opacity-80">{item.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </motion.form>
              )}

              {activeTab === "import" && (
                <motion.form
                  key="import"
                  id="workspace-mode-panel-import"
                  role="tabpanel"
                  aria-labelledby="workspace-mode-tab-import"
                  onSubmit={handleImport}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="p-5"
                >
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
                    <div className="rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_52%,transparent)] p-4">
                      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--text-secondary)]">
                        <Github className="h-4 w-4" />
                        Clone repository
                      </div>
                      <label>
                        <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">
                          Repository URL
                        </span>
                        <input
                          data-testid="workspace-repo-url-input"
                          type="text"
                          placeholder="https://github.com/owner/repo.git"
                          value={repoUrl}
                          onChange={(event) => setRepoUrl(event.target.value)}
                          disabled={isActionLoading}
                          className="th-focus-ring h-12 w-full rounded-md border border-[var(--border-medium)] bg-[var(--bg-app)] px-3 text-sm outline-none transition focus:border-[var(--attention-purple)]"
                        />
                      </label>
                      <button
                        type="submit"
                        data-testid="workspace-repo-import-button"
                        disabled={importing || !repoUrl.trim()}
                        className="th-focus-ring mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[var(--text-primary)] px-4 text-sm font-semibold text-[var(--bg-app)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                        Import and open
                      </button>
                      <p className="mt-3 text-xs leading-5 text-[var(--text-dim)]">
                        The repository is cloned into a scoped workspace and added to recents.
                      </p>
                    </div>
                    <div className="rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_34%,transparent)] p-4">
                      <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                        <Code2 className="h-5 w-5 text-[var(--text-secondary)]" />
                      </div>
                      <h3 className="text-sm font-semibold">Import scope</h3>
                      <div className="mt-3 space-y-2 font-mono text-[11px] text-[var(--text-muted)]">
                        <div className="flex justify-between gap-3"><span>recents.write</span><span>enabled</span></div>
                        <div className="flex justify-between gap-3"><span>source.type</span><span>git</span></div>
                        <div className="flex justify-between gap-3"><span>runtime.open</span><span>after clone</span></div>
                      </div>
                    </div>
                  </div>
                </motion.form>
              )}

              {activeTab === "create" && (
                <motion.form
                  key="create"
                  id="workspace-mode-panel-create"
                  role="tabpanel"
                  aria-labelledby="workspace-mode-tab-create"
                  onSubmit={handleCreateRepo}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="space-y-5 p-5"
                >
                  <div className="grid gap-4 md:grid-cols-2">
                    <label>
                      <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">
                        Repository name
                      </span>
                      <input
                        type="text"
                        placeholder="infra-runtime-gateway"
                        value={newRepoName}
                        onChange={(event) => setNewRepoName(event.target.value)}
                        disabled={isActionLoading}
                        className="th-focus-ring h-11 w-full rounded-md border border-[var(--border-medium)] bg-[var(--bg-app)] px-3 text-sm outline-none transition focus:border-[var(--attention-purple)]"
                      />
                    </label>
                    <div>
                      <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">
                        Visibility
                      </span>
                      <div className="grid h-11 grid-cols-2 gap-2">
                        <button
                          type="button"
                          aria-pressed={newRepoPrivate}
                          onClick={() => setNewRepoPrivate(true)}
                          disabled={isActionLoading}
                          className="th-focus-ring flex items-center justify-center gap-2 rounded-md border text-sm font-medium transition disabled:opacity-40"
                          style={{
                            borderColor: newRepoPrivate ? "var(--attention-purple)" : "var(--border-medium)",
                            background: newRepoPrivate
                              ? "color-mix(in srgb, var(--attention-purple) 14%, transparent)"
                              : "var(--bg-app)",
                            color: newRepoPrivate ? "var(--text-primary)" : "var(--text-muted)",
                          }}
                        >
                          <Lock className="h-4 w-4" />
                          Private
                        </button>
                        <button
                          type="button"
                          aria-pressed={!newRepoPrivate}
                          onClick={() => setNewRepoPrivate(false)}
                          disabled={isActionLoading}
                          className="th-focus-ring flex items-center justify-center gap-2 rounded-md border text-sm font-medium transition disabled:opacity-40"
                          style={{
                            borderColor: !newRepoPrivate ? "var(--attention-purple)" : "var(--border-medium)",
                            background: !newRepoPrivate
                              ? "color-mix(in srgb, var(--attention-purple) 14%, transparent)"
                              : "var(--bg-app)",
                            color: !newRepoPrivate ? "var(--text-primary)" : "var(--text-muted)",
                          }}
                        >
                          <Globe className="h-4 w-4" />
                          Public
                        </button>
                      </div>
                    </div>
                  </div>

                  <label className="block">
                    <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">
                      Description
                    </span>
                    <input
                      type="text"
                      placeholder="Short project summary"
                      value={newRepoDesc}
                      onChange={(event) => setNewRepoDesc(event.target.value)}
                      disabled={isActionLoading}
                      className="th-focus-ring h-11 w-full rounded-md border border-[var(--border-medium)] bg-[var(--bg-app)] px-3 text-sm outline-none transition focus:border-[var(--attention-purple)]"
                    />
                  </label>

                  <AIJumpstartSection
                    enabled={aiJumpstart}
                    onEnabledChange={(value) => {
                      setAiJumpstart(value);
                      if (!value) setAiProjectType(null);
                    }}
                    prompt={aiPrompt}
                    onPromptChange={setAiPrompt}
                    attachments={aiAttachments}
                    onAttachmentsChange={setAiAttachments}
                    projectType={aiProjectType}
                    onProjectTypeChange={setAiProjectType}
                    disabled={isActionLoading}
                  />

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={creating || !newRepoName.trim() || (aiJumpstart && (!aiProjectType || !aiPrompt.trim()))}
                      className="th-focus-ring flex h-11 items-center gap-2 rounded-md bg-[var(--text-primary)] px-5 text-sm font-semibold text-[var(--bg-app)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Command className="h-4 w-4" />}
                      {aiJumpstart ? "Provision with agent" : "Create and open"}
                    </button>
                  </div>
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </section>

        <aside className="space-y-5">
          {lastWorkspace?.slug && (
            <button
              type="button"
              onClick={() => router.push(`/${lastWorkspace.slug}`)}
              aria-label={`Return to workspace ${lastWorkspace.name || lastWorkspace.slug}`}
              className="th-focus-ring w-full rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_90%,transparent)] p-4 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface)]"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Home className="h-4 w-4 text-[var(--attention-purple)]" />
                  Return
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
              </div>
              <div className="truncate text-sm text-[var(--text-secondary)]">
                {lastWorkspace.name || lastWorkspace.slug}
              </div>
              <div className="mt-1 font-mono text-xs text-[var(--text-dim)]">{lastWorkspace.slug}</div>
            </button>
          )}

          <section className="rounded-lg border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--bg-editor)_90%,transparent)] p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Layers3 className="h-4 w-4 text-[var(--attention-purple)]" />
                  Recent workspaces
                </h2>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Repos, uploads, and created workspaces</p>
              </div>
              <span className="rounded-md border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-muted)]">
                {workspaces.length}
              </span>
            </div>

            {loadingWorkspaces ? (
              <div className="space-y-2">
                {[1, 2, 3].map((item) => (
                  <div key={item} className="h-16 animate-pulse rounded-lg bg-[var(--bg-surface)]" />
                ))}
              </div>
            ) : workspaces.length === 0 ? (
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_50%,transparent)] p-4">
                <FolderGit2 className="mb-3 h-5 w-5 text-[var(--text-muted)]" />
                <p className="text-sm text-[var(--text-secondary)]">No recent workspaces yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.slug}
                    type="button"
                    onClick={() => router.push(`/${workspace.slug}`)}
                    aria-label={`Open workspace ${workspace.name || workspace.slug}`}
                    className="th-focus-ring group w-full rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_46%,transparent)] p-3 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                          {workspace.name || "Workspace"}
                        </div>
                        <div className="mt-1 truncate font-mono text-xs text-[var(--text-dim)]">{workspace.slug}</div>
                      </div>
                      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-0 transition group-hover:opacity-100" />
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <Clock className="h-3.5 w-3.5" />
                      {workspace.createdAt ? relativeTime(workspace.createdAt) : "Unknown"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
