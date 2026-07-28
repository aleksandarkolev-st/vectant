import prisma from '@/lib/prisma';

/** Records redacted operational facts only. Observability must never block Jupyter work. */
export async function recordJupyterAudit({ workspaceSlug, serverId = null, actorUserId = null, eventType, notebookPath = null, kernelId = null, details = {} }) {
  try {
    await prisma.jupyterAuditEvent.create({
      data: { workspaceSlug, serverId, actorUserId, eventType, notebookPath, kernelId, detailsJson: JSON.stringify(details) },
    });
  } catch { /* best effort by contract */ }
}
