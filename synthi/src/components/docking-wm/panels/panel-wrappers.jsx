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
import { ResizablePanelGroup } from '@/components/ui/resizable';
import { useWorkspacePanelContext } from '../context/workspace-panel-context';

// ────────────────────────────────────────────────────────
//  Lazy component imports (code-split, no SSR)
// ────────────────────────────────────────────────────────

const Placeholder = () => (
  <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
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

const ProblemsPanel = dynamic(
  () => import('@/components/analysis').then(m => ({ default: m.ProblemsPanel })),
  { ssr: false, loading: Placeholder },
);

const SearchView = dynamic(
  () => import('@/app/workspace/[slug]/SearchView'),
  { ssr: false, loading: Placeholder },
);

const GitSummaryPanel = dynamic(
  () => import('@/components/git/GitSummaryPanel').then(m => ({ default: m.GitSummaryPanel })),
  { ssr: false, loading: Placeholder },
);

const ExtensionSidebar = dynamic(
  () => import('@/components/extensions/ExtensionSidebar'),
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
      className="h-full w-full overflow-hidden bg-[#09090b]"
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

export const EditorPanelWrapper = memo(function EditorPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="editor"
      className="h-full w-full min-w-0 overflow-hidden bg-[#18181b]"
    >
      {/* Editor.jsx root return is <ResizablePanel> which requires a parent PanelGroup */}
      <ResizablePanelGroup direction="horizontal" className="h-full w-full">
        <EditorPanel
          {...(ctx?.editorProps || {})}
          filePath={data?.filePath}
        />
      </ResizablePanelGroup>
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
      className="h-full w-full min-h-0 overflow-hidden bg-[#09090b]"
    >
      <TerminalManager
        visible={true}
        onCloseAll={() => {}}
        workspaceSlug={ctx?.workspaceSlug}
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
      className="h-full w-full overflow-hidden bg-[#09090b]"
    >
      <AIChatWindow
        docked={true}
        isVisible={true}
        activeFile={ctx?.activeFile}
        currentCode={ctx?.currentCode}
        editor={ctx?.editor}
        onSuggest={ctx?.onSuggest}
        onBusy={ctx?.onBusy}
        clearSignal={ctx?.clearSignal}
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
      className="h-full w-full overflow-hidden bg-[#09090b]"
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
      className="h-full w-full overflow-hidden bg-[#09090b]"
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
      className="h-full w-full overflow-hidden bg-[#09090b]"
    >
      <GitSummaryPanel
        onOpenScm={ctx?.onOpenScm}
      />
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Extensions Panel Wrapper
// ────────────────────────────────────────────────────────

export const ExtensionsPanelWrapper = memo(function ExtensionsPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="extensions"
      className="h-full w-full overflow-hidden bg-[#09090b]"
    >
      <ExtensionSidebar />
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
      className="h-full w-full overflow-hidden bg-[#09090b] font-mono text-xs text-zinc-400 p-2"
    >
      <div className="flex h-full items-center justify-center">
        Output panel — no output yet
      </div>
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
      className="h-full w-full overflow-hidden bg-[#09090b]"
    >
      <div className="flex h-full items-center justify-center text-xs text-zinc-500">
        No preview available
      </div>
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Wrapper registry (type → component)
// ────────────────────────────────────────────────────────

export const PANEL_WRAPPERS = {
  explorer:   ExplorerPanelWrapper,
  search:     SearchPanelWrapper,
  git:        GitPanelWrapper,
  extensions: ExtensionsPanelWrapper,
  editor:     EditorPanelWrapper,
  terminal:   TerminalPanelWrapper,
  chat:       ChatPanelWrapper,
  problems:   ProblemsPanelWrapper,
  output:     OutputPanelWrapper,
  preview:    PreviewPanelWrapper,
};
