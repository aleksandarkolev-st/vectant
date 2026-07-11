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
import { useSession } from 'next-auth/react';
import { useWorkspacePanelContext } from '../context/workspace-panel-context';
import { useAppSelector } from '@/redux/hooks';
import { selectFocusedEditorPaneId } from '../state/layout-slice';
import { SettingsPanelContent } from '@/components/SettingsPanelContent';
import EditorPaneHeader from '@/components/EditorPaneHeader';
import { WORKFLOW_ACTIONS } from '@/components/agent-workflows/AgentWorkflowPanel';
import { collectDojoAuditEvidenceRefs } from '@/services/agentWorkflowDojoAudit';
import { buildAgentWorkflowHandoffFiles, buildDojoArtifactFiles, SYNTHI_WORKFLOW_ROOT } from '@/services/agentWorkflowHandoff';
import {
  callAgentWorkflowTool,
  getAgentWorkflowState,
  resolveAgentWorkflowBridgeToken,
  resolveAgentWorkflowBridgeUrl,
} from '@/services/agentWorkflowClient';
import { gitClient } from '@/services/gitClient';
import { getCurrentUser } from '@/services/userIdentity';
import { getWorkspaceRuntimeIdentity } from '@/services/runtimeScope';

const PREVIEW_WORKFLOW_ERROR_CODES = new Set([
  'preview_not_found',
  'preview_target_not_found',
  'preview_discovery_failed',
  'preview_sidecar_discovery_failed',
  'preview_open_failed',
  'preview_snapshot_failed',
  'preview_target_not_allowed',
  'invalid_preview_url',
  'origin_consent_required',
  'screenshot_consent_required',
  'runtime_scope_required',
]);

const RUNTIME_WORKFLOW_ERROR_CODES = new Set([
  'workflow_runtime_ensure_unreachable',
  'workflow_runtime_ensure_failed',
  'workflow_runtime_unavailable',
  'workflow_bridge_unreachable',
]);

function workflowToolError(tool, body) {
  const result = body?.result || {};
  const code = result.error || body?.error || `${tool}_failed`;
  const detail = result.detail || result.reason || body?.detail || body?.message || '';
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  err.detail = detail;
  err.body = body;
  err.result = result;
  err.state = body?.state;
  return err;
}

function workflowErrorCode(error) {
  return error?.code || error?.result?.error || error?.body?.result?.error || error?.body?.error || '';
}

function workflowErrorDetail(error) {
  return error?.detail || error?.result?.reason || error?.result?.detail || error?.body?.detail || error?.message || '';
}

function isWorkflowToolActionError(error) {
  return Boolean(error?.state || error?.body?.state || error?.body?.result || error?.result);
}

function previewActionDetail(code, fallback) {
  if (code === 'preview_not_found') {
    return 'Start a dev server in this workspace, then click Observe again.';
  }
  if (code === 'preview_target_not_found') {
    return 'A preview was detected, but the hosted browser did not select it yet. Reattach the browser runtime, then click Observe.';
  }
  if (code === 'preview_open_failed') {
    return 'The hosted browser could not open the preview. Restart the dev server or reattach the browser runtime, then click Observe.';
  }
  if (code === 'preview_snapshot_failed') {
    return 'The preview opened, but the hosted browser could not capture it yet. Wait a moment, then click Observe again.';
  }
  if (code === 'preview_target_not_allowed' || code === 'invalid_preview_url') {
    return 'Open a preview URL that belongs to this workspace runtime, then click Observe.';
  }
  if (code === 'origin_consent_required' || code === 'screenshot_consent_required') {
    return 'Click Observe to grant screenshot access for the current preview origin.';
  }
  return fallback || 'Open or start a workspace preview, then click Observe again.';
}

function runtimeActionDetail(code, fallback) {
  if (code === 'workflow_runtime_ensure_unreachable' || code === 'workflow_bridge_unreachable') {
    return 'The workspace runtime is still reconnecting. Wait a moment, then try again.';
  }
  return fallback || 'The workspace runtime is not ready yet. Wait a moment, then try again.';
}

function currentDojoAuditActor() {
  const user = getCurrentUser();
  return {
    actor_id: user?.id || 'guest',
    actor_type: 'human',
  };
}

// ────────────────────────────────────────────────────────
//  Lazy component imports (code-split, no SSR)
// ────────────────────────────────────────────────────────

const Placeholder = () => (
  <div className="flex h-full w-full items-center justify-center text-xs" style={{ color: 'var(--text-disabled)' }}>
    Loading...
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

const CodeSitePanel = dynamic(
  () => import('@/components/codesite/CodeSitePanel'),
  { ssr: false, loading: Placeholder },
);

const ProblemsPanel = dynamic(
  () => import('@/components/analysis').then(m => ({ default: m.ProblemsPanel })),
  { ssr: false, loading: Placeholder },
);

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

const ConnectedToolsPanel = dynamic(
  () => import('@/components/integrations/ConnectedToolsPanel'),
  { ssr: false, loading: Placeholder },
);

const PortsPanel = dynamic(
  () => import('@/components/ports/PortsPanel'),
  { ssr: false, loading: Placeholder },
);

const ProgramsPanel = dynamic(
  () => import('@/components/programs/ProgramsPanel'),
  { ssr: false, loading: Placeholder },
);

const ProgramSessionPanel = dynamic(
  () => import('@/components/programs/ProgramSessionPanel'),
  { ssr: false, loading: Placeholder },
);

function PreviewEmptyState() {
  return (
    <div className="vt-empty-state h-full min-h-0 rounded-none border-0">
      <div className="max-w-[260px] text-center">
        <div className="vt-state-pill mx-auto mb-3 w-max">
          <span className="vt-state-dot" style={{ background: 'var(--text-dim)', boxShadow: 'none' }} />
          Preview
        </div>
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">No preview target</div>
        <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">
          Start a dev server or attach a browser workflow to inspect the running artifact.
        </p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
//  Explorer Panel Wrapper
// ────────────────────────────────────────────────────────

export const ExplorerPanelWrapper = memo(function ExplorerPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="explorer"
      className="vt-panel-frame vt-file-tree h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full min-w-0 overflow-hidden flex flex-col"
      data-panel-kind="editor"
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
      className="vt-panel-frame h-full w-full min-h-0 overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
  const { data: session } = useSession();
  const [workflowState, setWorkflowState] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const latestRequestRef = useRef(0);
  const inFlightActionRef = useRef(0);
  const isActionLockedRef = useRef(false);
  const workflowStateRef = useRef(null);
  const workflowUserId = session?.user?.id || session?.user?.email || null;
  const bridgeConfig = useMemo(() => ({
    url: resolveAgentWorkflowBridgeUrl(),
    token: resolveAgentWorkflowBridgeToken(),
    runtime: ctx?.workspaceSlug && workflowUserId
      ? {
          workspaceSlug: ctx.workspaceSlug,
          ...getWorkspaceRuntimeIdentity(ctx.workspaceSlug, { userId: workflowUserId }),
        }
      : {},
  }), [ctx?.workspaceSlug, workflowUserId]);

  const workspaceUrl = useCallback(() => {
    if (typeof window === 'undefined') return '';
    return window.location.href;
  }, []);

  const stateWithBridgeError = useCallback((error, previous = null) => {
    const code = workflowErrorCode(error);
    const detail = error?.message || String(error || 'Workflow bridge unavailable');
    if (RUNTIME_WORKFLOW_ERROR_CODES.has(code)) {
      return {
        ...(previous || {}),
        bridge: {
          ...(previous?.bridge || {}),
          status: 'error',
          url: bridgeConfig.url,
          detail: runtimeActionDetail(code, workflowErrorDetail(error) || detail),
        },
        runtime: {
          ...(previous?.runtime || {}),
          status: 'starting',
          detail: runtimeActionDetail(code, workflowErrorDetail(error) || detail),
        },
        observe: {
          ...(previous?.observe || {}),
          status: 'needsPreview',
          label: 'Runtime starting',
          detail: runtimeActionDetail(code, workflowErrorDetail(error) || detail),
          error: code,
          selectedTabId: null,
          lastScreenshotAt: null,
          consent: null,
        },
        teach: {
          ...(previous?.teach || {}),
          state: 'idle',
          label: 'Ready after observe',
          detail: 'Observe a live preview before teaching a workflow.',
          tabId: null,
        },
        blockers: [
          {
            id: code || 'workflow_runtime_unavailable',
            label: 'Workspace runtime unavailable',
            detail: runtimeActionDetail(code, workflowErrorDetail(error) || detail),
          },
          ...(Array.isArray(previous?.blockers) ? previous.blockers.filter((item) => !RUNTIME_WORKFLOW_ERROR_CODES.has(item?.id)) : []),
        ],
      };
    }
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
      observe: {
        ...(previous?.observe || {}),
        status: 'needsRuntime',
        label: 'Runtime needed',
        detail,
        error: code || 'workflow_bridge_error',
        selectedTabId: null,
        lastScreenshotAt: null,
        consent: null,
      },
      teach: {
        ...(previous?.teach || {}),
        state: 'idle',
        label: 'Ready after observe',
        detail: 'Reconnect the workflow bridge, then observe a preview before teaching.',
        tabId: null,
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

  const stateWithWorkflowActionError = useCallback((error, previous = null) => {
    const code = workflowErrorCode(error);
    const detail = workflowErrorDetail(error);
    const sourceState = error?.state || error?.body?.state || previous || {};
    const blockers = Array.isArray(sourceState?.blockers)
      ? sourceState.blockers.filter((item) => item?.id !== 'workflow_action_error' && item?.id !== code)
      : [];

    if (PREVIEW_WORKFLOW_ERROR_CODES.has(code)) {
      return {
        ...sourceState,
        bridge: {
          ...(sourceState.bridge || previous?.bridge || {}),
          status: 'ready',
          url: bridgeConfig.url,
          detail: null,
        },
        observe: {
          ...(sourceState.observe || previous?.observe || {}),
          status: 'needsPreview',
          label: 'Preview needed',
          detail: previewActionDetail(code, detail),
          error: code,
          selectedTabId: null,
          lastScreenshotAt: null,
          consent: null,
        },
        teach: {
          ...(sourceState.teach || previous?.teach || {}),
          state: 'idle',
          label: 'Ready after observe',
          detail: 'Observe a live preview before teaching a workflow.',
          tabId: null,
        },
        blockers,
      };
    }

    return {
      ...sourceState,
      bridge: {
        ...(sourceState.bridge || previous?.bridge || {}),
        status: 'ready',
        url: bridgeConfig.url,
        detail: null,
      },
      blockers: [
        {
          id: 'workflow_action_error',
          label: 'Workflow action blocked',
          detail: detail || code || 'The workflow action could not complete.',
        },
        ...blockers,
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
        runtime: bridgeConfig.runtime,
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
  }, [applyBridgeState, bridgeConfig.runtime, bridgeConfig.token, bridgeConfig.url, stateWithBridgeError]);

  const callWorkflowTool = useCallback(async (tool, args = {}) => {
    const body = await callAgentWorkflowTool({
      url: bridgeConfig.url,
      token: bridgeConfig.token,
      runtime: bridgeConfig.runtime,
      tool,
      arguments: args,
    });
    if (body?.state) applyBridgeState(body.state);
    if (!body?.ok) {
      throw workflowToolError(tool, body);
    }
    return body;
  }, [applyBridgeState, bridgeConfig.runtime, bridgeConfig.token, bridgeConfig.url]);

  const readWorkspaceFileOrEmpty = useCallback(async (path) => {
    const workspaceId = ctx?.workspaceSlug;
    if (!workspaceId) return '';
    try {
      const result = await gitClient.readFile(workspaceId, path);
      return typeof result?.content === 'string' ? result.content : '';
    } catch {
      return '';
    }
  }, [ctx?.workspaceSlug]);

  useEffect(() => {
    workflowStateRef.current = workflowState;
  }, [workflowState]);

  const persistWorkflowHandoff = useCallback(async ({ generated, manifest }) => {
    const workspaceId = ctx?.workspaceSlug;
    if (!workspaceId) throw new Error('workflow_handoff_workspace_unavailable');
    const [existingIndexRaw, existingAgentsRaw] = await Promise.all([
      readWorkspaceFileOrEmpty(`${SYNTHI_WORKFLOW_ROOT}/index.json`),
      readWorkspaceFileOrEmpty('AGENTS.md'),
    ]);
    const { files } = buildAgentWorkflowHandoffFiles({
      generated,
      manifest,
      existingIndexRaw,
      existingAgentsRaw,
    });
    await gitClient.writeFilesBatch(workspaceId, files, { syncToGcs: true });
  }, [ctx?.workspaceSlug, readWorkspaceFileOrEmpty]);

  const persistDojoArtifacts = useCallback(async (artifacts) => {
    const workspaceId = ctx?.workspaceSlug;
    if (!workspaceId) throw new Error('dojo_artifact_workspace_unavailable');
    const { files } = buildDojoArtifactFiles({ artifacts });
    await gitClient.writeFilesBatch(workspaceId, files, { syncToGcs: true });
  }, [ctx?.workspaceSlug]);

  const ensureObservedWorkspace = useCallback(async () => {
    const currentUrl = workspaceUrl();
    if (!currentUrl) throw new Error('workspace_url_unavailable');
    return callWorkflowTool(WORKFLOW_ACTIONS.OBSERVE, {
      ...(ctx?.workspaceSlug ? { workspace_id: ctx.workspaceSlug } : {}),
      workspace_url: currentUrl,
      user_gesture: true,
    });
  }, [callWorkflowTool, ctx?.workspaceSlug, workspaceUrl]);

  const handleWorkflowAction = useCallback(async (detail) => {
    const action = detail?.action;
    if (!action) return;
    if (isActionLockedRef.current) return;
    const actionId = ++inFlightActionRef.current;
    isActionLockedRef.current = true;
    setBusyAction(action);
    try {
      const currentUrl = workspaceUrl();
      const workspaceId = ctx?.workspaceSlug;
      switch (action) {
        case WORKFLOW_ACTIONS.ATTACH_WORKSPACE:
          await callWorkflowTool(WORKFLOW_ACTIONS.ATTACH_WORKSPACE, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
            ...(currentUrl ? { workspace_url: currentUrl } : {}),
            runtime_id: bridgeConfig.runtime?.runtimeScope || undefined,
            open_workspace: false,
          });
          break;
        case WORKFLOW_ACTIONS.OBSERVE:
          await ensureObservedWorkspace();
          break;
        case WORKFLOW_ACTIONS.BEGIN_TEACH:
          {
            const observedState = workflowStateRef.current?.observe?.status === 'ready'
              ? { state: workflowStateRef.current }
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
        case WORKFLOW_ACTIONS.RUN_CHECKRIDE:
          await callWorkflowTool(WORKFLOW_ACTIONS.RUN_CHECKRIDE, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.EXPORT_DOJO_ARTIFACTS:
          {
            const skillId = workflowState?.dojo?.skillId;
            const exportBody = await callWorkflowTool(WORKFLOW_ACTIONS.EXPORT_DOJO_ARTIFACTS, {
              ...(skillId ? { skill_id: skillId } : {}),
              ...(workspaceId ? { workspace_id: workspaceId } : {}),
            });
            await persistDojoArtifacts(exportBody?.result?.artifacts);
          }
          break;
        case WORKFLOW_ACTIONS.ISSUE_PROOF_CAPSULE:
          await callWorkflowTool(WORKFLOW_ACTIONS.ISSUE_PROOF_CAPSULE, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
            requested_action: 'run_workflow',
            context_claims: { workspace_verified: true },
          });
          break;
        case WORKFLOW_ACTIONS.RUN_PROOF_DRY_RUN:
          {
            const skillId = workflowState?.dojo?.skillId;
            const capsuleBody = await callWorkflowTool(WORKFLOW_ACTIONS.ISSUE_PROOF_CAPSULE, {
              ...(skillId ? { skill_id: skillId } : {}),
              requested_action: 'run_workflow',
              context_claims: { workspace_verified: true },
            });
            await callWorkflowTool(WORKFLOW_ACTIONS.RUN_PROOF_DRY_RUN, {
              ...(skillId ? { skill_id: skillId } : {}),
              requested_action: 'run_workflow',
              proof_capsule: capsuleBody?.result?.proof_capsule,
              dry_run: true,
            });
          }
          break;
        case WORKFLOW_ACTIONS.EXPLAIN_BLOCK:
          await callWorkflowTool(WORKFLOW_ACTIONS.EXPLAIN_BLOCK, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
            requested_action: 'run_workflow',
          });
          break;
        case WORKFLOW_ACTIONS.REQUEST_PERMISSION_UPGRADE:
          await callWorkflowTool(WORKFLOW_ACTIONS.REQUEST_PERMISSION_UPGRADE, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
            requested_action: 'run_workflow',
          });
          break;
        case WORKFLOW_ACTIONS.GET_UNIVERSE_DOSSIER:
          await callWorkflowTool(WORKFLOW_ACTIONS.GET_UNIVERSE_DOSSIER, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.GET_LIFECYCLE:
          await callWorkflowTool(WORKFLOW_ACTIONS.GET_LIFECYCLE, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.GET_GOVERNANCE_REPORT:
          await callWorkflowTool(WORKFLOW_ACTIONS.GET_GOVERNANCE_REPORT, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.GET_METRICS:
          await callWorkflowTool(WORKFLOW_ACTIONS.GET_METRICS, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.GET_SOURCE_AFFORDANCE_PR_PLAN:
          await callWorkflowTool(WORKFLOW_ACTIONS.GET_SOURCE_AFFORDANCE_PR_PLAN, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.RUN_TIME_MACHINE_DEBUGGER:
          await callWorkflowTool(WORKFLOW_ACTIONS.RUN_TIME_MACHINE_DEBUGGER, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
            question: 'What changes if the active failure variable is removed?',
          });
          break;
        case WORKFLOW_ACTIONS.RUN_VIVARIUM_SCENARIO:
          await callWorkflowTool(WORKFLOW_ACTIONS.RUN_VIVARIUM_SCENARIO, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.RUN_WIND_TUNNEL:
          await callWorkflowTool(WORKFLOW_ACTIONS.RUN_WIND_TUNNEL, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
            max_scenarios: 6,
          });
          break;
        case WORKFLOW_ACTIONS.GET_LICENSE_HEALTH:
          await callWorkflowTool(WORKFLOW_ACTIONS.GET_LICENSE_HEALTH, {
            ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.RECORD_CASE_LAW:
          {
            const evidenceRefs = collectDojoAuditEvidenceRefs({ workflowState });
            await callWorkflowTool(WORKFLOW_ACTIONS.RECORD_CASE_LAW, {
              ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
              title: 'Operator Review Required',
              finding: workflowState?.dojo?.blockExplanation?.refusal || 'An operator marked this skill branch for review.',
              impact: 'Production execution could exceed the currently reviewed license boundary.',
              rule: 'Require human review and recertification before expanding this skill license.',
              applies_to: ['workflow_execution'],
              evidence_refs: evidenceRefs,
            });
          }
          break;
        case WORKFLOW_ACTIONS.REVOKE_LICENSE:
          {
            const actor = currentDojoAuditActor();
            const evidenceRefs = collectDojoAuditEvidenceRefs({ workflowState });
            await callWorkflowTool(WORKFLOW_ACTIONS.REVOKE_LICENSE, {
              ...(workflowState?.dojo?.skillId ? { skill_id: workflowState.dojo.skillId } : {}),
              reason: 'operator_requested_recertification',
              actor_id: actor.actor_id,
              actor_type: actor.actor_type,
              evidence_refs: evidenceRefs,
            });
          }
          break;
        case WORKFLOW_ACTIONS.PREFIX_VALIDATE:
          await callWorkflowTool(WORKFLOW_ACTIONS.PREFIX_VALIDATE, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.GET_MUTATION_PLAN:
          await callWorkflowTool(WORKFLOW_ACTIONS.GET_MUTATION_PLAN, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.SET_REPLAY_ISOLATION_PROFILE:
          await callWorkflowTool(WORKFLOW_ACTIONS.SET_REPLAY_ISOLATION_PROFILE, {
            ...(detail?.payload && typeof detail.payload === 'object' ? detail.payload : {}),
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.RUN_CI_ISOLATED_REPLAY:
          await callWorkflowTool(WORKFLOW_ACTIONS.RUN_CI_ISOLATED_REPLAY, {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
          });
          break;
        case WORKFLOW_ACTIONS.GENERATE_SCRIPT:
          {
            const scriptBody = await callWorkflowTool(WORKFLOW_ACTIONS.GENERATE_SCRIPT, {});
            const manifestBody = await callWorkflowTool(WORKFLOW_ACTIONS.GENERATE_MANIFEST, {});
            await persistWorkflowHandoff({
              generated: scriptBody?.result,
              manifest: manifestBody?.result?.manifest,
            });
          }
          break;
        case WORKFLOW_ACTIONS.GENERATE_MANIFEST:
          await callWorkflowTool(WORKFLOW_ACTIONS.GENERATE_MANIFEST, {});
          break;
        case WORKFLOW_ACTIONS.PUBLISH_TOOL:
          {
            const actor = currentDojoAuditActor();
            const evidenceRefs = collectDojoAuditEvidenceRefs({ workflowState });
            const publishBody = await callWorkflowTool(WORKFLOW_ACTIONS.PUBLISH_TOOL, {
              ...(workspaceId ? { workspace_id: workspaceId } : {}),
              reason: 'operator_requested_license_publish',
              actor_id: actor.actor_id,
              actor_type: actor.actor_type,
              evidence_refs: evidenceRefs,
            });
            const skillId = publishBody?.result?.skill?.skill_id;
            if (skillId) {
              const exportBody = await callWorkflowTool(WORKFLOW_ACTIONS.EXPORT_DOJO_ARTIFACTS, { skill_id: skillId });
              await persistDojoArtifacts(exportBody?.result?.artifacts);
            }
          }
          break;
        default:
          throw new Error(`Unsupported workflow action: ${action || 'unknown'}`);
      }
    } catch (err) {
      setWorkflowState((prev) => (
        isWorkflowToolActionError(err)
          ? stateWithWorkflowActionError(err, prev)
          : stateWithBridgeError(err, prev)
      ));
    } finally {
      if (actionId === inFlightActionRef.current) {
        isActionLockedRef.current = false;
        setBusyAction(null);
      }
    }
}, [bridgeConfig.runtime, callWorkflowTool, ctx?.workspaceSlug, ensureObservedWorkspace, persistDojoArtifacts, persistWorkflowHandoff, stateWithBridgeError, stateWithWorkflowActionError, workflowState, workspaceUrl]);

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
      className="vt-panel-frame h-full w-full overflow-hidden"
    >
      <AgentWorkflowPanel
        workspaceSlug={ctx?.workspaceSlug}
        isBusy={Boolean(busyAction)}
        workflowState={displayedWorkflowState}
        onWorkflowAction={handleWorkflowAction}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  CodeSite Panel Wrapper
// ────────────────────────────────────────────────────────

export const CodeSitePanelWrapper = memo(function CodeSitePanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="codesite"
      className="vt-panel-frame h-full w-full overflow-hidden"
    >
      <CodeSitePanel workspaceSlug={ctx?.workspaceSlug} />
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
    >
      <PreviewEmptyState />
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
      className="vt-panel-frame h-full w-full overflow-y-auto"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
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
      className="vt-panel-frame h-full w-full overflow-hidden"
    >
      <HealingSettingsPanel aiHealing={ctx?.aiHealing} />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Integrations Panel Wrapper
// ────────────────────────────────────────────────────────

export const IntegrationsPanelWrapper = memo(function IntegrationsPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="integrations"
      className="vt-panel-frame h-full w-full overflow-hidden"
    >
      <ConnectedToolsPanel />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Ports Panel Wrapper
// ────────────────────────────────────────────────────────

export const PortsPanelWrapper = memo(function PortsPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="ports"
      className="vt-panel-frame h-full w-full overflow-hidden"
    >
      <PortsPanel />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Programs Panel Wrapper
// ────────────────────────────────────────────────────────

export const ProgramsPanelWrapper = memo(function ProgramsPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="programs"
      className="vt-panel-frame h-full w-full overflow-hidden"
    >
      <ProgramsPanel />
    </div>
  );
});

export const ProgramSessionPanelWrapper = memo(function ProgramSessionPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="program-session"
      className="vt-panel-frame h-full w-full overflow-hidden"
      data-panel-kind="editor"
    >
      <ProgramSessionPanel
        workspaceSlug={data?.workspaceSlug || ctx?.workspaceSlug}
        sessionId={data?.programSessionId}
        title={data?.title || 'Program Session'}
      />
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
  integrations:    IntegrationsPanelWrapper,
  programs:        ProgramsPanelWrapper,
  'program-session': ProgramSessionPanelWrapper,
};
