'use client';

/**
 * @fileoverview Shared context for passing workspace-level props to
 * docking panel wrappers. Extracted to its own module to avoid
 * circular dependencies between DockableWorkspace ↔ panel-wrappers.
 */

import { createContext, useContext } from 'react';

/**
 * Context for passing workspace-level props to panel components.
 * Panel wrappers call `useWorkspacePanelContext()` to get editor,
 * activeFile, diagnostics, etc.
 */
export const WorkspacePanelContext = createContext(null);

/**
 * @returns {{ workspaceSlug: string, editor: any, activeFile: any, ... } | null}
 */
export function useWorkspacePanelContext() {
  return useContext(WorkspacePanelContext);
}
