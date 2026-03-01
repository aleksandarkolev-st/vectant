"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Github,
  LogOut,
  FolderGit2,
  Plus,
  Loader2,
  GitBranch,
  ArrowRight,
  Lock,
  Globe,
  Clock,
  Sparkles,
} from "lucide-react";
import AIJumpstartSection from "@/components/dashboard/AIJumpstartSection";
import { storeJumpstartPayload } from "@/lib/ai-jumpstart-session";

const COLLAB_SERVER_URL =
  process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || "http://localhost:1234";

/* ──────────────────────────── helpers ──────────────────────────── */

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

/* ──────────────────────────── main ──────────────────────────── */

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [workspaces, setWorkspaces] = useState([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);

  // Import state
  const [repoUrl, setRepoUrl] = useState("");
  const [importing, setImporting] = useState(false);

  // Create repo state
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoDesc, setNewRepoDesc] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [creating, setCreating] = useState(false);

  // AI Jumpstart state
  const [aiJumpstart, setAiJumpstart] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiAttachments, setAiAttachments] = useState([]);

  // Active tab
  const [activeTab, setActiveTab] = useState("import");

  // Error / success feedback
  const [feedback, setFeedback] = useState(null); // { type: 'error'|'success', message }

  /* ── data fetching ── */

  const fetchWorkspaces = useCallback(async (email) => {
    setLoadingWorkspaces(true);
    try {
      const res = await fetch(
        `${COLLAB_SERVER_URL}/workspaces?owner=${encodeURIComponent(email)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data);
      }
    } catch (e) {
      console.error("Failed to fetch workspaces", e);
    } finally {
      setLoadingWorkspaces(false);
    }
  }, []);

  useEffect(() => {
    if (session?.user?.email) {
      fetchWorkspaces(session.user.email);
    } else {
      setLoadingWorkspaces(false);
    }
  }, [session, fetchWorkspaces]);

  /* ── import repo ── */

  const handleImport = async (e) => {
    e.preventDefault();
    if (!repoUrl) return;
    setImporting(true);
    setFeedback(null);
    try {
      const slug = Math.random().toString(36).substring(2, 10);
      const name = repoUrl.split("/").pop().replace(".git", "");
      const userId = session?.user?.id || session?.user?.email;

      const res = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/clone`, {
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
        }),
      });

      if (res.ok) {
        await fetchWorkspaces(session.user.email);
        setRepoUrl("");
        router.push(`/workspace/${slug}`);
      } else {
        const err = await res.json();
        setFeedback({
          type: "error",
          message: `Import failed: ${err.error || "Unknown error"}`,
        });
      }
    } catch (e) {
      console.error(e);
      setFeedback({
        type: "error",
        message: "Import failed. Check the URL and try again.",
      });
    } finally {
      setImporting(false);
    }
  };

  /* ── create repo ── */

  const handleCreateRepo = async (e) => {
    e.preventDefault();
    if (!newRepoName.trim()) return;
    setCreating(true);
    setFeedback(null);
    try {
      // 1. Create the repo on GitHub
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
        const err = await createRes.json();
        setFeedback({
          type: "error",
          message: err.error || "Failed to create repository.",
        });
        return;
      }

      const repo = await createRes.json();

      // 2. Clone the newly created repo into a workspace
      const slug = Math.random().toString(36).substring(2, 10);
      const userId = session?.user?.id || session?.user?.email;

      const cloneRes = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/clone`, {
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
        }),
      });

      if (cloneRes.ok) {
        // 3. If AI Jumpstart is enabled, persist prompt data for workspace
        if (aiJumpstart && aiPrompt.trim()) {
          storeJumpstartPayload({
            prompt: aiPrompt.trim(),
            attachments: aiAttachments,
          });
        }

        setNewRepoName("");
        setNewRepoDesc("");
        setAiJumpstart(false);
        setAiPrompt("");
        setAiAttachments([]);
        router.push(`/workspace/${slug}`);
      } else {
        const err = await cloneRes.json();
        setFeedback({
          type: "error",
          message: `Repository created on GitHub but workspace setup failed: ${err.error || "Unknown error"}`,
        });
      }
    } catch (e) {
      console.error(e);
      setFeedback({
        type: "error",
        message: "Something went wrong. Please try again.",
      });
    } finally {
      setCreating(false);
    }
  };

  /* ── loading splash ── */

  if (status === "loading") {
    return (
      <div
        className="flex h-screen items-center justify-center"
        style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
      >
        <div className="flex flex-col items-center gap-4">
          <div
            className="synthi-loading"
            style={{ width: 40, height: 40, borderRadius: "50%" }}
          />
          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Loading...
          </span>
        </div>
      </div>
    );
  }

  /* ── sign-in page ── */

  if (!session) {
    return (
      <div
        className="flex h-screen items-center justify-center"
        style={{ background: "var(--bg-app)" }}
      >
        <div className="synthi-gradient-border" style={{ borderRadius: 16 }}>
          <div
            className="flex flex-col items-center gap-6 px-10 py-10"
            style={{
              background: "var(--bg-editor)",
              borderRadius: 16,
              minWidth: 360,
            }}
          >
            <div className="flex flex-col items-center gap-2">
              <h1
                className="text-2xl font-semibold tracking-tight"
                style={{ color: "var(--text-primary)" }}
              >
                Welcome to <span className="synthi-gradient-text">Synthi</span>
              </h1>
              <p
                className="synthi-body text-sm"
                style={{ color: "var(--text-muted)" }}
              >
                Sign in to access your cloud workspaces
              </p>
            </div>
            <button
              onClick={() => signIn("github", { callbackUrl: "/" })}
              className="synthi-btn w-full flex items-center justify-center gap-2 h-10 text-sm font-medium cursor-pointer"
              style={{ borderRadius: 8 }}
            >
              <Github className="h-4 w-4" /> Sign in with GitHub
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── dashboard ── */

  const isActionLoading = importing || creating;

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      {/* ── Header ── */}
      <header
        className="sticky top-0 z-50 border-b"
        style={{
          background: "color-mix(in srgb, var(--bg-app) 85%, transparent)",
          backdropFilter: "blur(12px)",
          borderColor: "var(--border-subtle)",
        }}
      >
        <div className="max-w-5xl mx-auto flex items-center justify-between px-6 h-14">
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <span className="synthi-gradient-text">Synthi</span>
            <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
              Dashboard
            </span>
          </h1>
          <div className="flex items-center gap-3">
            {session.user?.image && (
              <img
                src={session.user.image}
                alt=""
                className="w-7 h-7 rounded-full"
                style={{ border: "1px solid var(--border-medium)" }}
              />
            )}
            <span
              className="text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              {session.user?.name}
            </span>
            <button
              onClick={() => signOut()}
              className="th-btn-ghost p-1.5 rounded-md transition-colors cursor-pointer"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* ── Get Started Section ── */}
        <section className="mb-12">
          <div className="flex items-center gap-2 mb-6">
            <Sparkles
              className="h-4 w-4"
              style={{ color: "var(--accent-primary)" }}
            />
            <h2 className="synthi-heading text-base">Get Started</h2>
          </div>

          <div
            className="synthi-card overflow-hidden"
            style={{ borderRadius: 12 }}
          >
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="w-full"
            >
              <div className="px-5 pt-5 pb-0">
                <TabsList
                  className="w-full h-10 p-1"
                  style={{
                    background: "var(--bg-app)",
                    borderRadius: 8,
                  }}
                >
                  <TabsTrigger
                    value="import"
                    className="flex-1 h-8 text-sm gap-2 rounded-md transition-all cursor-pointer data-[state=active]:shadow-none"
                    style={{ "--tw-shadow": "none" }}
                    data-synthi-tab=""
                  >
                    <FolderGit2 className="h-3.5 w-3.5" /> Import Repository
                  </TabsTrigger>
                  <TabsTrigger
                    value="create"
                    className="flex-1 h-8 text-sm gap-2 rounded-md transition-all cursor-pointer data-[state=active]:shadow-none"
                    style={{ "--tw-shadow": "none" }}
                    data-synthi-tab=""
                  >
                    <Plus className="h-3.5 w-3.5" /> Create Repository
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* ── Feedback Banner ── */}
              {feedback && (
                <div
                  className="mx-5 mt-4 px-4 py-2.5 rounded-lg text-sm flex items-center gap-2"
                  style={{
                    background:
                      feedback.type === "error"
                        ? "color-mix(in srgb, var(--accent-danger) 10%, transparent)"
                        : "color-mix(in srgb, var(--accent-success) 10%, transparent)",
                    border: `1px solid ${
                      feedback.type === "error"
                        ? "color-mix(in srgb, var(--accent-danger) 30%, transparent)"
                        : "color-mix(in srgb, var(--accent-success) 30%, transparent)"
                    }`,
                    color:
                      feedback.type === "error"
                        ? "var(--accent-danger)"
                        : "var(--accent-success)",
                  }}
                >
                  <span className="flex-1">{feedback.message}</span>
                  <button
                    onClick={() => setFeedback(null)}
                    className="opacity-60 hover:opacity-100 text-xs cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* ── Import Tab ── */}
              <TabsContent value="import" className="px-5 pb-5 pt-4">
                <p
                  className="synthi-body text-sm mb-4"
                  style={{ color: "var(--text-muted)" }}
                >
                  Clone an existing GitHub repository into a new cloud
                  workspace.
                </p>
                <form onSubmit={handleImport} className="flex gap-3">
                  <div className="flex-1 relative">
                    <Github
                      className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
                      style={{ color: "var(--text-dim)" }}
                    />
                    <input
                      type="text"
                      placeholder="https://github.com/username/repo.git"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      disabled={isActionLoading}
                      className="th-input w-full h-10 pl-10 pr-4 rounded-lg text-sm outline-none transition-colors synthi-focus-ring"
                      style={{
                        background: "var(--bg-app)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-medium)",
                      }}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={importing || !repoUrl.trim()}
                    className="synthi-btn h-10 px-5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {importing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        Import <ArrowRight className="h-3.5 w-3.5" />
                      </>
                    )}
                  </button>
                </form>
              </TabsContent>

              {/* ── Create Tab ── */}
              <TabsContent value="create" className="px-5 pb-5 pt-4">
                <p
                  className="synthi-body text-sm mb-4"
                  style={{ color: "var(--text-muted)" }}
                >
                  Create a new repository on GitHub and open it in a cloud
                  workspace.
                </p>
                <form onSubmit={handleCreateRepo} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Repo Name */}
                    <div className="space-y-1.5">
                      <label
                        className="synthi-label"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Repository name
                      </label>
                      <input
                        type="text"
                        placeholder="my-project"
                        value={newRepoName}
                        onChange={(e) => setNewRepoName(e.target.value)}
                        disabled={isActionLoading}
                        className="th-input w-full h-10 px-3 rounded-lg text-sm outline-none transition-colors synthi-focus-ring"
                        style={{
                          background: "var(--bg-app)",
                          color: "var(--text-primary)",
                          border: "1px solid var(--border-medium)",
                        }}
                      />
                    </div>

                    {/* Visibility */}
                    <div className="space-y-1.5">
                      <label
                        className="synthi-label"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Visibility
                      </label>
                      <div className="flex gap-2 h-10">
                        <button
                          type="button"
                          onClick={() => setNewRepoPrivate(true)}
                          disabled={isActionLoading}
                          className="flex-1 h-full flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all cursor-pointer"
                          style={{
                            background: newRepoPrivate
                              ? "color-mix(in srgb, var(--accent-primary) 15%, transparent)"
                              : "var(--bg-app)",
                            border: `1px solid ${
                              newRepoPrivate
                                ? "var(--accent-primary)"
                                : "var(--border-medium)"
                            }`,
                            color: newRepoPrivate
                              ? "var(--accent-tertiary)"
                              : "var(--text-muted)",
                          }}
                        >
                          <Lock className="h-3.5 w-3.5" /> Private
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewRepoPrivate(false)}
                          disabled={isActionLoading}
                          className="flex-1 h-full flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all cursor-pointer"
                          style={{
                            background: !newRepoPrivate
                              ? "color-mix(in srgb, var(--accent-primary) 15%, transparent)"
                              : "var(--bg-app)",
                            border: `1px solid ${
                              !newRepoPrivate
                                ? "var(--accent-primary)"
                                : "var(--border-medium)"
                            }`,
                            color: !newRepoPrivate
                              ? "var(--accent-tertiary)"
                              : "var(--text-muted)",
                          }}
                        >
                          <Globe className="h-3.5 w-3.5" /> Public
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <div className="space-y-1.5">
                    <label
                      className="synthi-label"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Description{" "}
                      <span style={{ color: "var(--text-dim)" }}>
                        (optional)
                      </span>
                    </label>
                    <input
                      type="text"
                      placeholder="A short description of your project"
                      value={newRepoDesc}
                      onChange={(e) => setNewRepoDesc(e.target.value)}
                      disabled={isActionLoading}
                      className="th-input w-full h-10 px-3 rounded-lg text-sm outline-none transition-colors synthi-focus-ring"
                      style={{
                        background: "var(--bg-app)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-medium)",
                      }}
                    />
                  </div>

                  {/* AI Jumpstart */}
                  <AIJumpstartSection
                    enabled={aiJumpstart}
                    onEnabledChange={setAiJumpstart}
                    prompt={aiPrompt}
                    onPromptChange={setAiPrompt}
                    attachments={aiAttachments}
                    onAttachmentsChange={setAiAttachments}
                    disabled={isActionLoading}
                  />

                  {/* Submit */}
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      disabled={creating || !newRepoName.trim()}
                      className="synthi-btn h-10 px-5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {creating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Plus className="h-3.5 w-3.5" /> Create &amp; Open
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        </section>

        {/* ── Workspaces Section ── */}
        <section>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <GitBranch
                className="h-4 w-4"
                style={{ color: "var(--accent-primary)" }}
              />
              <h2 className="synthi-heading text-base">Your Workspaces</h2>
            </div>
            <span className="synthi-pill">
              {workspaces.length}{" "}
              {workspaces.length === 1 ? "workspace" : "workspaces"}
            </span>
          </div>

          {loadingWorkspaces ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="synthi-card p-5 space-y-3"
                  style={{ borderRadius: 12 }}
                >
                  <div
                    className="synthi-loading h-4 rounded"
                    style={{ width: "60%" }}
                  />
                  <div
                    className="synthi-loading h-3 rounded"
                    style={{ width: "40%" }}
                  />
                </div>
              ))}
            </div>
          ) : workspaces.length === 0 ? (
            <div
              className="synthi-card flex flex-col items-center justify-center py-16 gap-3"
              style={{ borderRadius: 12 }}
            >
              <FolderGit2
                className="h-10 w-10"
                style={{ color: "var(--text-dim)" }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                No workspaces yet
              </p>
              <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
                Import or create a repository to get started
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {workspaces.map((ws) => (
                <button
                  key={ws.slug}
                  onClick={() => router.push(`/workspace/${ws.slug}`)}
                  className="synthi-card group text-left p-5 transition-all duration-200 cursor-pointer"
                  style={{
                    borderRadius: 12,
                    border: "1px solid var(--border-subtle)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent-primary)";
                    e.currentTarget.style.boxShadow = "var(--shadow-glow)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-subtle)";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  {/* Workspace name */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderGit2
                        className="h-4 w-4 shrink-0"
                        style={{ color: "var(--accent-primary)" }}
                      />
                      <span
                        className="font-medium text-sm truncate"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {ws.name || "Workspace"}
                      </span>
                    </div>
                    <ArrowRight
                      className="h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: "var(--accent-primary)" }}
                    />
                  </div>

                  {/* Slug */}
                  <div className="mb-3">
                    <span
                      className="font-mono text-xs px-2 py-0.5 rounded"
                      style={{
                        background: "var(--bg-app)",
                        color: "var(--text-dim)",
                        border: "1px solid var(--border-subtle)",
                      }}
                    >
                      {ws.slug}
                    </span>
                  </div>

                  {/* Date */}
                  <div className="flex items-center gap-1.5">
                    <Clock
                      className="h-3 w-3"
                      style={{ color: "var(--text-dim)" }}
                    />
                    <span
                      className="text-xs"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {ws.createdAt ? relativeTime(ws.createdAt) : "Unknown"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
