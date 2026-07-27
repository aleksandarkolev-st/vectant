/**
 * Computes a deterministic notebook sync state. Hashes represent durable content,
 * not client render state, so callers can safely stop before an overwrite.
 */
export function compareNotebookRevisions({ baseline = null, workspace = null, server = null }) {
  if (!workspace?.hash || !server?.hash) return { state: 'stale', reason: 'missing_revision' };
  if (workspace.hash === server.hash) return { state: 'clean', reason: 'content_equal' };
  const workspaceChanged = !baseline?.hash || workspace.hash !== baseline.hash;
  const serverChanged = !baseline?.hash || server.hash !== baseline.hash;
  if (workspaceChanged && serverChanged) return { state: 'conflict', reason: 'both_changed' };
  return workspaceChanged ? { state: 'workspace-newer', reason: 'workspace_changed' } : { state: 'server-newer', reason: 'server_changed' };
}

export function savePlan({ sync, mounted = false }) {
  if (sync?.state === 'conflict') return { allowed: false, operations: [], recovery: 'choose_workspace_or_server' };
  if (mounted) return { allowed: true, operations: ['workspace_write'], recovery: null };
  return { allowed: true, operations: ['workspace_write', 'server_write'], recovery: 'retain_local_buffer_on_partial_failure' };
}
