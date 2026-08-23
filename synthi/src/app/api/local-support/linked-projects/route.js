import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import { createLinkedProjectRequest, findLinkedProject, listLinkedProjects, normalizeLinkedProjectRequest } from "@/lib/local-support/linkedProjectStore";
import { findActiveBrowserControlSession } from "@/lib/local-support/sessionStore";
import { enqueueLocalControlCommand } from "@/lib/local-support/relayStore";

export const runtime = "nodejs";
export async function GET() {
  const session = await getServerSession(authOptions); const accountId = session?.user?.id || session?.user?.email;
  if (!accountId) return response({ decision: "denied", reason: "authentication_required" }, 401);
  return response({ decision: "linked_projects_ready", projects: await listLinkedProjects(accountId), raw_source_uploaded: false });
}
export async function POST(req) {
  if (!isSameOriginRequest(req)) { const denied = deniedJson("bad_origin", "Request origin was not accepted."); return response(denied.body, denied.status); }
  const parsed = await readBoundedJson(req); if (!parsed.ok) return response({ decision: "denied", reason: parsed.reason }, parsed.status);
  const session = await getServerSession(authOptions); const accountId = session?.user?.id || session?.user?.email;
  if (!accountId) return response({ decision: "denied", reason: "authentication_required" }, 401);
  const value = normalizeLinkedProjectRequest(parsed.value); if (!value) return response({ decision: "denied", reason: "invalid_linked_project_request" }, 400);
  const paired = await findActiveBrowserControlSession({ accountId, sessionId: parsed.value.session_id, workspaceId: parsed.value.workspace_id });
  if (!paired) return response({ decision: "denied", reason: "paired_session_not_found" }, 403);
  const project = await createLinkedProjectRequest({ ...value, sessionId: paired.sessionId, accountId: paired.accountId, orgId: paired.orgId, deviceFingerprint: paired.deviceFingerprint });
  await enqueueLocalControlCommand({ commandId: `cmd_${randomUUID().replaceAll("-", "")}`, sessionId: paired.sessionId, accountId: paired.accountId, orgId: paired.orgId, workspaceId: paired.workspaceId, deviceFingerprint: paired.deviceFingerprint, action: "linked_project_activate", expiresAt: new Date(Date.now() + 5 * 60_000), proposal: { project_id: value.projectId, selection_mode: value.selectionMode, display_name: value.displayName }, actor: accountId });
  return response({ decision: "linked_project_confirmation_queued", project_id: project.projectId, raw_source_uploaded: false }, 202);
}
export async function DELETE(req) {
  if (!isSameOriginRequest(req)) { const denied = deniedJson("bad_origin", "Request origin was not accepted."); return response(denied.body, denied.status); }
  const parsed = await readBoundedJson(req); if (!parsed.ok) return response({ decision: "denied", reason: parsed.reason }, parsed.status);
  const session = await getServerSession(authOptions); const accountId = session?.user?.id || session?.user?.email;
  const projectId = parsed.value?.project_id;
  if (!accountId) return response({ decision: "denied", reason: "authentication_required" }, 401);
  if (typeof projectId !== "string" || !/^lproj_[A-Za-z0-9_-]{12,128}$/.test(projectId)) return response({ decision: "denied", reason: "invalid_linked_project" }, 400);
  const project = await findLinkedProject(projectId, accountId);
  if (!project) return response({ decision: "denied", reason: "linked_project_not_found" }, 404);
  await enqueueLocalControlCommand({ commandId: `cmd_${randomUUID().replaceAll("-", "")}`, sessionId: project.sessionId, accountId: project.accountId, orgId: project.orgId, workspaceId: project.session.workspaceId, deviceFingerprint: project.deviceFingerprint, action: "linked_project_disconnect", expiresAt: new Date(Date.now() + 60_000), proposal: { project_id: projectId }, actor: accountId });
  return response({ decision: "linked_project_disconnect_queued", project_id: projectId }, 202);
}
function response(body, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
