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

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { useWorkspacePanelContext } from '../context/workspace-panel-context';
import { useAppSelector } from '@/redux/hooks';
import { selectFocusedEditorPaneId } from '../state/layout-slice';
import { SettingsPanelContent } from '@/components/SettingsPanelContent';
import EditorPaneHeader from '@/components/EditorPaneHeader';

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

  return (
    <div
      data-panel-type="agent-workflows"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <AgentWorkflowPanel workspaceSlug={ctx?.workspaceSlug} />
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
