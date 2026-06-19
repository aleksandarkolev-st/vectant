'use strict';

/**
 * Pre-warm a workspace's runtime container. Called by the frontend on workspace
 * mount so the first terminal doesn't eat the ~15-25s rootless-dockerd cold
 * start. Fire-and-forget: ensure the container, then warm the daemon in the
 * BACKGROUND (don't make the HTTP request hang for 25s). Idempotent — ensure
 * adopts an already-running container.
 *
 * @returns {Promise<{status:number, body:object}>}
 */
async function handleEnsureRuntime({ workspaceRuntime, slug, userId }) {
  if (!workspaceRuntime) return { status: 200, body: { enabled: false } };
  if (!slug) return { status: 400, body: { error: 'missing slug' } };
  await workspaceRuntime.ensureRuntimeContainer(slug, userId || '');
  // Warm the daemon in the background; the terminal path also waits for ready,
  // so a slow warm here just means the first terminal shows "starting runtime…".
  workspaceRuntime.waitForRuntimeReady(slug, userId || '').catch(() => {});
  return { status: 202, body: { warming: true } };
}

module.exports = { handleEnsureRuntime };
