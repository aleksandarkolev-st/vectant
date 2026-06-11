'use client';

/**
 * @fileoverview Docking-aware wrappers for IDE panels.
 *
 * Each wrapper:
 *  - Imports the real component directly via next/dynamic (no context threading)
 *  - Reads shared *state* (editor, diagnostics, etc.) from WorkspacePanelContext
 *  - Adds a `data-panel-type` attribute for CSS targeting
 *
 * These wrappers are used as the `component` in the panel registry,
 * rendered by PanelContainer when a tab group activates them.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useWorkspacePanelContext } from '../context/workspace-panel-context';
import { useAppSelector } from '@/redux/hooks';
import { selectFocusedEditorPaneId } from '../state/layout-slice';
import { SettingsPanelContent } from '@/components/SettingsPanelContent';
import EditorPaneHeader from '@/components/EditorPaneHeader';
import { WORKFLOW_ACTIONS } from '@/components/agent-workflows/AgentWorkflowPanel';
import {
  callAgentWorkflowTool,
  getAgentWorkflowState,
  resolveAgentWorkflowBridgeToken,
  resolveAgentWorkflowBridgeUrl,
} from '@/services/agentWorkflowClient';

const WORKSPACE_PREVIEW_DISCOVERY_TIMEOUT_MS = 5000;

// ────────────────────────────────────────────────────────
//  Lazy component imports (code-split, no SSR)
// ────────────────────────────────────────────────────────

const Placeholder = () => (
  <div className="flex h-full w-full items-center justify-center text-xs" style={{ color: 'var(--text-disabled)' }}>
    Loading…
  </div>
);

const FileTreeView = dynamic(
  () => import('@/app/workspace/[slug]/FileTree'),
  { ssr: false, loading: Placeholder },
);

const EditorPanel = dynamic(
  () => import('@/app/workspace/[slug]/Editor/Editor'),
  { ssr: false, loading: Placeholder },
);

const TerminalManager = dynamic(
  () => import('@/app/workspace/TerminalManager'),
  { ssr: false, loading: Placeholder },
);

const AIChatWindow = dynamic(
  () => import('@/components/chat/AIChatWindow'),
  { ssr: false, loading: Placeholder },
);

const AgentWorkflowPanel = dynamic(
  () => import('@/components/agent-workflows/AgentWorkflowPanel'),
  { ssr: false, loading: Placeholder },
);

const ProblemsPanel = dynamic(
  () => import('@/components/analysis').then(m => ({ default: m.ProblemsPanel })),
  { ssr: false, loading: Placeholder },
);

function resolveCollabServerUrl() {
  const configured = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL;
  if (configured && configured.trim()) return configured.replace(/\/$/, '');
  if (typeof window === 'undefined') return 'http://localhost:1234';
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:1234`;
}

async function discoverWorkspacePreviewUrl(workspaceSlug) {
  if (typeof window === 'undefined') return null;
  const base = resolveCollabServerUrl();
  const resolvePreviewUrl = (path) => {
    if (typeof path !== 'string' || !path.trim()) return null;
    try {
      return new URL(path, `${base}/`).href;
    } catch {
      return null;
    }
  };
  try {
    const query = typeof workspaceSlug === 'string' && workspaceSlug.trim()
      ? `?workspace=${encodeURIComponent(workspaceSlug.trim())}`
      : '';
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), WORKSPACE_PREVIEW_DISCOVERY_TIMEOUT_MS);
    const res = await fetch(`${base}/ports${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => window.clearTimeout(timer));
    if (!res.ok) return null;
    const data = await res.json();
    const previews = Array.isArray(data?.previews)
      ? data.previews
        .map((preview) => ({
          port: Number(preview?.port),
          url: resolvePreviewUrl(preview?.url),
        }))
        .filter((preview) => (
          Number.isInteger(preview.port) &&
          preview.port > 0 &&
          preview.port <= 65535 &&
          preview.url
        ))
        .sort((a, b) => a.port - b.port)
      : [];
    if (previews[0]?.url) return previews[0].url;

    const ports = Array.isArray(data?.activePorts)
      ? data.activePorts
        .map((port) => Number(port))
        .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
        .sort((a, b) => a - b)
      : [];
    const port = ports[0];
    return port ? resolvePreviewUrl(`/port/${port}/`) : null;
  } catch {
    return null;
  }
}

const SearchView = dynamic(
  () => import('@/app/workspace/[slug]/SearchView'),
  { ssr: false, loading: Placeholder },
);

const GitStatus = dynamic(
  () => import('@/components/git/GitStatus').then(m => ({ default: m.GitStatus })),
  { ssr: false, loading: Placeholder },
);

const ExtensionSidebar = dynamic(
  () => import('@/components/extensions/ExtensionSidebar'),
  { ssr: false, loading: Placeholder },
);

const ExtensionViewContainer = dynamic(
  () => import('@/components/extensions/ExtensionViewContainer'),
  { ssr: false, loading: Placeholder },
);

const ThemeEditorPanel = dynamic(
  () => import('@/components/ThemeEditorPanel'),
  { ssr: false, loading: Placeholder },
);

const OutputPanel = dynamic(
  () => import('./OutputPanel'),
  { ssr: false, loading: Placeholder },
);
  
const PullRequestsPanel = dynamic(
  () => import('@/components/git/PullRequestsPanel').then(m => ({ default: m.PullRequestsPanel })),
  { ssr: false, loading: Placeholder },
);

const CommitHistoryPanel = dynamic(
  () => import('@/components/git/CommitHistoryPanel'),
  { ssr: false, loading: Placeholder },
);

const HealingSettingsPanel = dynamic(
  () => import('@/components/healing/HealingSettingsPanel').then(m => ({ default: m.HealingSettingsPanel })),
  { ssr: false, loading: Placeholder },
);

// ────────────────────────────────────────────────────────
//  Explorer Panel Wrapper
// ────────────────────────────────────────────────────────

export const ExplorerPanelWrapper = memo(function ExplorerPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="explorer"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <FileTreeView
        onToggleOrientation={ctx?.onToggleOrientation}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Editor Panel Wrapper
// ────────────────────────────────────────────────────────

export const EditorPanelWrapper = memo(function EditorPanelWrapper({ data, tabGroupId }) {
  const ctx = useWorkspacePanelContext();
  const focusedPaneId = useAppSelector(selectFocusedEditorPaneId);
  // Mark unfocused editor panes by paneId (not file path) so that two panes
  // showing the SAME file still dim the non-focused one's collaborator cursors.
  const unfocused = !!tabGroupId && focusedPaneId != null && tabGroupId !== focusedPaneId;

  return (
    <div
      data-panel-type="editor"
      data-pane-id={tabGroupId}
      data-pane-unfocused={unfocused ? 'true' : undefined}
      className="h-full w-full min-w-0 overflow-hidden flex flex-col"
      style={{ background: 'var(--bg-editor)' }}
    >
      <EditorPaneHeader paneId={tabGroupId} filePath={data?.filePath} />
      <div className="flex-1 min-h-0 min-w-0">
        <EditorPanel
          {...(ctx?.editorProps || {})}
          filePath={data?.filePath}
          paneId={tabGroupId}
          dockingMode={true}
        />
      </div>
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Terminal Panel Wrapper
// ────────────────────────────────────────────────────────

export const TerminalPanelWrapper = memo(function TerminalPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="terminal"
      className="h-full w-full min-h-0 overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <TerminalManager
        visible={true}
        onCloseAll={() => {}}
        workspaceSlug={ctx?.workspaceSlug}
        workspaceName={ctx?.workspaceName}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Chat Panel Wrapper
// ────────────────────────────────────────────────────────

export const ChatPanelWrapper = memo(function ChatPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="chat"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <AIChatWindow
        docked={true}
        isVisible={true}
        activeFile={ctx?.activeFile}
        getCurrentCode={ctx?.getCurrentCode}
        editor={ctx?.editor}
        onSuggest={ctx?.onSuggest}
        onBusy={ctx?.onBusy}
        clearSignal={ctx?.clearSignal}
        initialPrompt={ctx?.initialPrompt}
        initialAttachments={ctx?.initialAttachments}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Agent Workflows Panel Wrapper
// ────────────────────────────────────────────────────────

export const AgentWorkflowsPanelWrapper = memo(function AgentWorkflowsPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();
  const [workflowState, setWorkflowState] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const latestRequestRef = useRef(0);
  const bridgeConfig = useMemo(() => ({
    url: resolveAgentWorkflowBridgeUrl(),
    token: resolveAgentWorkflowBridgeToken(),
  }), []);

  const workspaceUrl = useCallback(() => {
    if (typeof window === 'undefined') return '';
    return window.location.href;
  }, []);

  const stateWithBridgeError = useCallback((error, previous = null) => {
    const detail = error?.message || String(error || 'Workflow bridge unavailable');
    return {
      ...(previous || {}),
      bridge: {
        ...(previous?.bridge || {}),
        status: 'error',
        url: bridgeConfig.url,
        detail,
      },
      runtime: {
        ...(previous?.runtime || {}),
        status: previous?.runtime?.status || 'notConfigured',
        detail: previous?.runtime?.detail || 'Start the browser workflow bridge to enable panel actions.',
      },
      blockers: [
        {
          id: 'workflow_bridge_error',
          label: 'Workflow bridge unavailable',
          detail,
        },
        ...(Array.isArray(previous?.blockers) ? previous.blockers.filter((item) => item?.id !== 'workflow_bridge_error') : []),
      ],
    };
  }, [bridgeConfig.url]);

  const applyBridgeState = useCallback((nextState) => {
    if (!nextState) return;
    setWorkflowState({
      ...nextState,
      bridge: {
        ...(nextState.bridge || {}),
        status: nextState.bridge?.status || 'ready',
        url: bridgeConfig.url,
      },
    });
  }, [bridgeConfig.url]);

  const refreshWorkflowState = useCallback(async ({ signal } = {}) => {
    const requestId = ++latestRequestRef.current;
    try {
      const nextState = await getAgentWorkflowState({
        url: bridgeConfig.url,
        token: bridgeConfig.token,
        signal,
      });
      if (!signal?.aborted && requestId === latestRequestRef.current) {
        applyBridgeState(nextState);
      }
    } catch (err) {
      if (!signal?.aborted && requestId === latestRequestRef.current) {
        setWorkflowState((prev) => stateWithBridgeError(err, prev));
      }
    }
  }, [applyBridgeState, bridgeConfig.token, bridgeConfig.url, stateWithBridgeError]);

  const callWorkflowTool = useCallback(async (tool, args = {}) => {
    const body = await callAgentWorkflowTool({
      url: bridgeConfig.url,
      token: bridgeConfig.token,
      tool,
      arguments: args,
    });
    if (body?.state) applyBridgeState(body.state);
    if (!body?.ok) {
      const result = body?.result || {};
      throw new Error(result.error || body.error || `${tool}_failed`);
    }
    return body;
  }, [applyBridgeState, bridgeConfig.token, bridgeConfig.url]);

  const ensureObservedWorkspace = useCallback(async () => {
    const currentUrl = workspaceUrl();
    if (!currentUrl) throw new Error('workspace_url_unavailable');
    const previewUrl = await discoverWorkspacePreviewUrl(ctx?.workspaceSlug);
    return callWorkflowTool(WORKFLOW_ACTIONS.OBSERVE, {
      workspace_url: currentUrl,
      ...(previewUrl ? { preview_url: previewUrl, preferred_url: previewUrl } : {}),
    });
  }, [callWorkflowTool, ctx?.workspaceSlug, workspaceUrl]);

  const handleWorkflowAction = useCallback(async (detail) => {
    const action = detail?.action;
    if (!action) return;
    setBusyAction(action);
    try {
      const currentUrl = workspaceUrl();
      const workspaceId = ctx?.workspaceSlug;
      switch (action) {
        case WORKFLOW_ACTIONS.ATTACH_WORKSPACE:
          await callWorkflowTool(WORKFLOW_ACTIONS.ATTACH_WORKSPACE, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
            ...(currentUrl ? { workspace_url: currentUrl } : {}),
            open_workspace: true,
          });
          break;
        case WORKFLOW_ACTIONS.OBSERVE:
          await ensureObservedWorkspace();
          break;
        case WORKFLOW_ACTIONS.BEGIN_TEACH:
          {
            const observedState = workflowState?.observe?.status === 'ready'
              ? { state: workflowState }
              : await ensureObservedWorkspace();
            const selectedTabId = observedState?.state?.observe?.selectedTabId;
            await callWorkflowTool(WORKFLOW_ACTIONS.BEGIN_TEACH, {
              ...(selectedTabId ? { tab_id: selectedTabId } : {}),
              goal: `Teach workflow for ${workspaceId || 'current workspace'}`,
            });
          }
          break;
        case WORKFLOW_ACTIONS.END_TEACH:
          await callWorkflowTool(WORKFLOW_ACTIONS.END_TEACH, { reason: 'operator_stopped' });
          break;
        case WORKFLOW_ACTIONS.CONFIGURE_AUTH:
          await callWorkflowTool(WORKFLOW_ACTIONS.CONFIGURE_AUTH, {
            url: currentUrl,
            unattended: false,
          });
          break;
        case WORKFLOW_ACTIONS.OPEN_SOURCE:
          await callWorkflowTool(WORKFLOW_ACTIONS.OPEN_SOURCE, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.COMPILE_CONTRACT:
          await callWorkflowTool(WORKFLOW_ACTIONS.COMPILE_CONTRACT, {});
          break;
        case WORKFLOW_ACTIONS.PREFIX_VALIDATE:
          await callWorkflowTool(WORKFLOW_ACTIONS.PREFIX_VALIDATE, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.GENERATE_SCRIPT:
          await callWorkflowTool(WORKFLOW_ACTIONS.GENERATE_SCRIPT, {});
          break;
        case WORKFLOW_ACTIONS.GENERATE_MANIFEST:
        case WORKFLOW_ACTIONS.PUBLISH_TOOL:
          await callWorkflowTool(WORKFLOW_ACTIONS.GENERATE_MANIFEST, {});
          break;
        default:
          throw new Error(`Unsupported workflow action: ${action || 'unknown'}`);
      }
    } catch (err) {
      setWorkflowState((prev) => stateWithBridgeError(err, prev));
    } finally {
      setBusyAction(null);
    }
  }, [callWorkflowTool, ctx?.workspaceSlug, ensureObservedWorkspace, stateWithBridgeError, workflowState, workspaceUrl]);

  useEffect(() => {
    const controller = new AbortController();
    refreshWorkflowState({ signal: controller.signal });
    return () => controller.abort();
  }, [refreshWorkflowState]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const interval = window.setInterval(() => {
      if (!busyAction) refreshWorkflowState();
    }, 2000);
    return () => window.clearInterval(interval);
  }, [busyAction, refreshWorkflowState]);

  const displayedWorkflowState = useMemo(() => {
    if (!busyAction) return workflowState;
    return {
      ...(workflowState || {}),
      bridge: {
        ...(workflowState?.bridge || {}),
        status: 'running',
        url: bridgeConfig.url,
        detail: `Running ${busyAction}`,
      },
    };
  }, [bridgeConfig.url, busyAction, workflowState]);

  return (
    <div
      data-panel-type="agent-workflows"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <AgentWorkflowPanel
        workspaceSlug={ctx?.workspaceSlug}
        workflowState={displayedWorkflowState}
        onWorkflowAction={handleWorkflowAction}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Problems Panel Wrapper
// ────────────────────────────────────────────────────────

export const ProblemsPanelWrapper = memo(function ProblemsPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="problems"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <ProblemsPanel
        diagnostics={ctx?.diagnostics || []}
        summary={ctx?.diagnosticSummary}
        isAnalyzing={ctx?.isAnalyzing}
        filePath={ctx?.activeFile?.path || 'Current File'}
        onClose={ctx?.onCloseProblems}
        onNavigate={ctx?.onNavigate}
        className="h-full rounded-none border-0"
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Search Panel Wrapper
// ────────────────────────────────────────────────────────

export const SearchPanelWrapper = memo(function SearchPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="search"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <SearchView slug={ctx?.workspaceSlug} />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Git Panel Wrapper
// ────────────────────────────────────────────────────────

export const GitPanelWrapper = memo(function GitPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="git"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <GitStatus
        slug={ctx?.workspaceSlug}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Extensions Panel Wrapper
// ────────────────────────────────────────────────────────

export const ExtensionsPanelWrapper = memo(function ExtensionsPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();
  // The extension API (install/enable/disable/… handlers + live state) is
  // provided once by the workspace page via panelProps → context. Spreading
  // it here is what makes the marketplace Install button work; without it
  // onInstall is undefined and clicks silently no-op.
  const extensionApi = ctx?.extensionApi || {};

  return (
    <div
      data-panel-type="extensions"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <ExtensionSidebar {...extensionApi} />
    </div>
  );
});

export const ExtensionViewPanelWrapper = memo(function ExtensionViewPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();
  const extensionApi = ctx?.extensionApi || {};
  const containerId = data?.containerId;
  const container = (extensionApi.contributedContainers || []).find((item) => item.id === containerId) || null;

  return (
    <div
      data-panel-type="extension-view"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <ExtensionViewContainer
        containerId={containerId}
        container={container}
        views={extensionApi.contributedViews?.[containerId] || []}
        treeDataMap={extensionApi.treeDataMap || {}}
        webviewPanels={extensionApi.webviewPanels || []}
        webviewManager={extensionApi.webviewManager || null}
        extensions={extensionApi.extensions || []}
        onExecuteCommand={extensionApi.onExecuteCommand}
        onRequestTreeRefresh={extensionApi.onRequestTreeRefresh}
        viewsWelcome={extensionApi.viewsWelcome || {}}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Output Panel Wrapper
// ────────────────────────────────────────────────────────

export const OutputPanelWrapper = memo(function OutputPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="output"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <OutputPanel />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Preview Panel Wrapper
// ────────────────────────────────────────────────────────

export const PreviewPanelWrapper = memo(function PreviewPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="preview"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <div className="flex h-full items-center justify-center text-xs" style={{ color: 'var(--text-disabled)' }}>
        No preview available
      </div>
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Settings Panel Wrapper
// ────────────────────────────────────────────────────────

export const SettingsPanelWrapper = memo(function SettingsPanelWrapper({ data }) {
  // Settings panel is a simple inline component — no lazy import needed
  return (
    <div
      data-panel-type="settings"
      className="h-full w-full overflow-y-auto"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <SettingsPanelContent />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Theme Editor Panel Wrapper
// ────────────────────────────────────────────────────────

export const ThemeEditorPanelWrapper = memo(function ThemeEditorPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="theme-editor"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <ThemeEditorPanel />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Pull Requests Panel Wrapper
// ────────────────────────────────────────────────────────

export const PullRequestsPanelWrapper = memo(function PullRequestsPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="pullrequests"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <PullRequestsPanel
        slug={ctx?.workspaceSlug}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Commit History Panel Wrapper
// ────────────────────────────────────────────────────────

export const CommitHistoryPanelWrapper = memo(function CommitHistoryPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="commithistory"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <CommitHistoryPanel
        slug={ctx?.workspaceSlug}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  AI Healing Panel Wrapper
// ────────────────────────────────────────────────────────

export const AIHealingPanelWrapper = memo(function AIHealingPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="ai-healing"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <HealingSettingsPanel aiHealing={ctx?.aiHealing} />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Wrapper registry (type → component)
// ────────────────────────────────────────────────────────

export const PANEL_WRAPPERS = {
  explorer:       ExplorerPanelWrapper,
  search:         SearchPanelWrapper,
  git:            GitPanelWrapper,
  extensions:     ExtensionsPanelWrapper,
  'extension-view': ExtensionViewPanelWrapper,
  editor:         EditorPanelWrapper,
  terminal:       TerminalPanelWrapper,
  chat:           ChatPanelWrapper,
  'agent-workflows': AgentWorkflowsPanelWrapper,
  problems:       ProblemsPanelWrapper,
  output:         OutputPanelWrapper,
  preview:        PreviewPanelWrapper,
  settings:       SettingsPanelWrapper,
  'theme-editor': ThemeEditorPanelWrapper,
  pullrequests:    PullRequestsPanelWrapper,
  commithistory:   CommitHistoryPanelWrapper,
  'ai-healing':    AIHealingPanelWrapper,
};
