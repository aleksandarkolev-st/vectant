import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";

const MODES = new Set(["folder", "file_set"]);
const STATES = new Set(["pending_local_confirmation", "active", "disconnected"]);

export function normalizeLinkedProject(input) {
  const value = input && typeof input === "object" ? input : {};
  if (typeof value.projectId !== "string" || !/^lproj_[A-Za-z0-9_-]{12,128}$/.test(value.projectId)) return null;
  if (!MODES.has(value.selectionMode) || typeof value.workspaceHash !== "string" || !/^sha256:[a-f0-9]{16,128}$/i.test(value.workspaceHash)) return null;
  if (typeof value.displayName !== "string" || value.displayName.trim().length < 1 || value.displayName.length > 96) return null;
  if (!Array.isArray(value.selectedNodeIds) || value.selectedNodeIds.length > 20_000 || value.selectedNodeIds.some((id) => typeof id !== "string" || !/^node_[A-Za-z0-9_-]{8,128}$/.test(id))) return null;
  return { projectId: value.projectId, selectionMode: value.selectionMode, workspaceHash: value.workspaceHash, displayName: value.displayName.trim(), selectedNodeIds: [...new Set(value.selectedNodeIds)].sort(), graphNodeCount: Math.max(0, Math.min(Number(value.graphNodeCount) || 0, 20_000)) };
}

export function normalizeLinkedProjectRequest(input) {
  const value = input && typeof input === "object" ? input : {};
  if (typeof value.project_id !== "string" || !/^lproj_[A-Za-z0-9_-]{12,128}$/.test(value.project_id)) return null;
  if (!MODES.has(value.selection_mode) || typeof value.display_name !== "string") return null;
  const displayName = value.display_name.trim();
  if (!displayName || displayName.length > 96) return null;
  return { projectId: value.project_id, selectionMode: value.selection_mode, displayName };
}

export async function createLinkedProject(input, client = prisma) {
  const value = normalizeLinkedProject(input);
  if (!value) throw new Error("Invalid linked project.");
  return client.localSupportLinkedProject.create({ data: { ...value, selectedNodeIdsJson: JSON.stringify(value.selectedNodeIds), sessionId: input.sessionId, accountId: input.accountId, orgId: input.orgId, deviceFingerprint: input.deviceFingerprint } });
}

export async function createLinkedProjectRequest(input, client = prisma) {
  const value = normalizeLinkedProjectRequest(input);
  if (!value) throw new Error("Invalid linked project request.");
  // A pending project has no local workspace identity until the desktop validates
  // it. This one-way, non-sensitive provisional identifier is replaced only by
  // a device-authenticated activation report.
  const pendingWorkspaceHash = `sha256:${createHash("sha256").update(`pending-linked-project:${value.projectId}`).digest("hex")}`;
  return client.localSupportLinkedProject.create({ data: {
    ...value,
    workspaceHash: pendingWorkspaceHash,
    selectedNodeIdsJson: "[]",
    sessionId: input.sessionId,
    accountId: input.accountId,
    orgId: input.orgId,
    deviceFingerprint: input.deviceFingerprint,
  } });
}

export async function listLinkedProjects(accountId, client = prisma) {
  const rows = await client.localSupportLinkedProject.findMany({ where: { accountId, status: { not: "disconnected" } }, orderBy: { updatedAt: "desc" }, take: 100 });
  return rows.map(projectProjection);
}

export async function findLinkedProject(projectId, accountId, client = prisma) {
  return client.localSupportLinkedProject.findFirst({ where: { projectId, accountId, status: { not: "disconnected" } }, include: { session: true } });
}

export async function markLinkedProject(projectId, accountId, status, extra = {}, client = prisma) {
  if (!STATES.has(status)) return null;
  const result = await client.localSupportLinkedProject.updateMany({ where: { projectId, accountId, status: { not: "disconnected" } }, data: { status, disconnectedAt: status === "disconnected" ? new Date() : null, fullAccessExpiresAt: extra.fullAccessExpiresAt || undefined } });
  return result.count === 1;
}

export async function activateLinkedProject({ projectId, sessionId, deviceFingerprint, workspaceHash, selectionMode, selectedNodeIds, graphNodeCount, fullAccessExpiresAt }, client = prisma) {
  const normalized = normalizeLinkedProject({ projectId, workspaceHash, selectionMode, displayName: "Local project", selectedNodeIds, graphNodeCount });
  if (!normalized) return null;
  const result = await client.localSupportLinkedProject.updateMany({
    where: { projectId, sessionId, deviceFingerprint, status: "pending_local_confirmation" },
    data: {
      workspaceHash: normalized.workspaceHash,
      selectionMode: normalized.selectionMode,
      selectedNodeIdsJson: JSON.stringify(normalized.selectedNodeIds),
      graphNodeCount: normalized.graphNodeCount,
      fullAccessExpiresAt: fullAccessExpiresAt || null,
      status: "active",
    },
  });
  return result.count === 1;
}

export function projectProjection(row) {
  return { project_id: row.projectId, selection_mode: row.selectionMode, display_name: row.displayName, graph_node_count: row.graphNodeCount, status: row.status, full_access_expires_at: row.fullAccessExpiresAt?.toISOString() || null, updated_at: row.updatedAt.toISOString(), local_backed: true, raw_source_uploaded: false };
}
