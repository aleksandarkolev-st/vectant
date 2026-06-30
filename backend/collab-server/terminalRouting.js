'use strict';

/**
 * Decide whether a terminal session should run inside the per-workspace rootless
 * Docker runtime container. Requires the flag, a constructed runtime manager,
 * and a slug. Pure for testability.
 */
function shouldUseContainerTerminal({ enableContainerRuntime, workspaceRuntime, workspaceSlug } = {}) {
  return Boolean(enableContainerRuntime && workspaceRuntime && workspaceSlug);
}

function codeSiteTerminalLaunchMode({
  codeSiteContext,
  usesRuntimePodTerminal = false,
  enableContainerRuntime = false,
  workspaceRuntime = null,
  workspaceSlug = '',
} = {}) {
  if (!codeSiteContext?.active) return 'normal';
  if (usesRuntimePodTerminal) return 'block-runtime';
  if (shouldUseContainerTerminal({ enableContainerRuntime, workspaceRuntime, workspaceSlug })) return 'block-runtime';
  return 'quarantine';
}

module.exports = {
  shouldUseContainerTerminal,
  codeSiteTerminalLaunchMode,
};
