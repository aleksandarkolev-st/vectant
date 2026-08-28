'use strict';

const { ensureRuntimeFilesystem } = require('./runtimeFilesystem');

/**
 * Pre-warm a workspace's runtime container. Called by the frontend on workspace
 * mount so the first terminal doesn't eat the ~15-25s rootless-dockerd cold
 * start. Fire-and-forget: ensure the container, then warm the daemon in the
 * BACKGROUND (don't make the HTTP request hang for 25s). Idempotent — ensure
 * adopts an already-running container.
 *
 * @returns {Promise<{status:number, body:object}>}
 */
async function handleEnsureRuntime({
  workspaceRuntime,
  slug,
  userId,
  codesiteContext = null,
  codesiteMetadata = null,
  ensureFilesystem = ensureRuntimeFilesystem,
}) {
  if (!workspaceRuntime) return { status: 200, body: { enabled: false } };
  if (!slug) return { status: 400, body: { error: 'missing slug' } };
  if (codesiteContext?.active) {
    return {
      status: 409,
      body: {
        error: 'codesite_runtime_quarantine_unavailable',
        message: 'CodeSite runtime prewarm blocked: active CodeSite sessions require a transaction quarantine mount.',
        surface: 'program-runtime:ensure-runtime',
        codesite: codesiteMetadata || null,
      },
    };
  }
  // Docker volume subpath mounts require the per-user workspace directory to
  // exist before Docker creates the runtime container. Prewarm can run before
  // the frontend's ordinary file request, so hydrate it explicitly here rather
  // than racing container creation against repository initialization.
  await ensureFilesystem({
    workspaceSlug: slug,
    filesystemUserId: userId || '',
    reason: 'runtime_prewarm',
  });
  await workspaceRuntime.ensureRuntimeContainer(slug, userId || '');
  // Warm the daemon in the background; the terminal path also waits for ready,
  // so a slow warm here just means the first terminal shows "starting runtime…".
  workspaceRuntime.waitForRuntimeReady(slug, userId || '').catch(() => {});
  return { status: 202, body: { warming: true } };
}

module.exports = { handleEnsureRuntime };
