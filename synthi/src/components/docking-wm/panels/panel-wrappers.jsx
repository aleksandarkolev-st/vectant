'use client';

/**
 * @fileoverview Docking-aware wrappers for IDE panels.
 *
 * Each wrapper adapts an existing IDE component to work inside the
 * docking system. It:
 *  - Reads shared state from WorkspacePanelContext
 *  - Adds a `data-panel-type` attribute for CSS targeting
 *  - Handles the panel chrome (title bar is managed by the tab group)
 *
 * These wrappers are registered with the panel registry and lazily
 * rendered by PanelContainer when a tab group activates them.
 */

import { memo, useMemo } from 'react';
import { useWorkspacePanelContext } from '../DockableWorkspace';

// ────────────────────────────────────────────────────────
//  Explorer Panel Wrapper
// ────────────────────────────────────────────────────────

export const ExplorerPanelWrapper = memo(function ExplorerPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();
  if (!ctx) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-500">
        Workspace context unavailable
      </div>
    );
  }

  // The actual FileTreeView is rendered by the workspace page
  // and passed through context. This wrapper provides the container.
  const FileTree = ctx.components?.FileTree;

  return (
    <div
      data-panel-type="explorer"
      className="h-full w-full overflow-hidden bg-[#09090b]"
    >
      {FileTree ? (
        <FileTree
          onToggleOrientation={ctx.onToggleOrientation}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          Explorer loading…
        </div>
      )}
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
      {ctx?.components?.Editor ? (
        <ctx.components.Editor
          {...(ctx.editorProps || {})}
          filePath={data?.filePath}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          No file open
        </div>
      )}
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
      {ctx?.components?.Terminal ? (
        <ctx.components.Terminal
          workspaceSlug={ctx.workspaceSlug}
          sessionId={data?.sessionId}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          Terminal loading…
        </div>
      )}
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
      {ctx?.components?.Chat ? (
        <ctx.components.Chat
          docked={true}
          isVisible={true}
          activeFile={ctx.activeFile}
          currentCode={ctx.currentCode}
          editor={ctx.editor}
          onSuggest={ctx.onSuggest}
          onBusy={ctx.onBusy}
          clearSignal={ctx.clearSignal}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          AI Chat loading…
        </div>
      )}
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
      {ctx?.components?.Problems ? (
        <ctx.components.Problems
          diagnostics={ctx.diagnostics}
          summary={ctx.diagnosticSummary}
          isAnalyzing={ctx.isAnalyzing}
          filePath={ctx.activeFile?.path || 'Current File'}
          onClose={ctx.onCloseProblems}
          onNavigate={ctx.onNavigate}
          className="h-full rounded-none border-0"
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          Problems loading…
        </div>
      )}
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
      {ctx?.components?.Search ? (
        <ctx.components.Search />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          Search loading…
        </div>
      )}
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
      {ctx?.components?.Git ? (
        <ctx.components.Git
          onOpenScm={ctx.onOpenScm}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          Source Control loading…
        </div>
      )}
    </div>
  );
});

// ────────────────────────────────────────────────────────
//  Extensions Panel Wrapper
// ────────────────────────────────────────────────────────

export const ExtensionsPanelWrapper = memo(function ExtensionsPanelWrapper({ data }) {
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="extensions"
      className="h-full w-full overflow-hidden bg-[#09090b]"
    >
      {ctx?.components?.Extensions ? (
        <ctx.components.Extensions
          {...(ctx.extensionsProps || {})}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          Extensions loading…
        </div>
      )}
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
  const ctx = useWorkspacePanelContext();

  return (
    <div
      data-panel-type="preview"
      className="h-full w-full overflow-hidden bg-[#09090b]"
    >
      {ctx?.components?.Preview ? (
        <ctx.components.Preview
          {...(ctx.previewProps || {})}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          No preview available
        </div>
      )}
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
