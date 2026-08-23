ALTER TABLE "CodeSiteAgentSession"
ADD COLUMN "workspaceSlug" TEXT,
ADD COLUMN "effectiveWorkspaceUserId" TEXT,
ADD COLUMN "collaborationSessionId" TEXT,
ADD COLUMN "terminalSessionId" TEXT,
ADD COLUMN "runtimeSessionId" TEXT,
ADD COLUMN "capabilitiesJson" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN "subscriptionsJson" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN "deliveryChannelJson" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN "activeMutationLeaseId" TEXT,
ADD COLUMN "activeTransactionId" TEXT,
ADD COLUMN "attachedAt" TIMESTAMP(3),
ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN "detachedAt" TIMESTAMP(3),
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "CodeSiteAgentSession" AS session
SET
  "workspaceSlug" = project."workspaceSlug",
  "effectiveWorkspaceUserId" = session."ownerUserId"
FROM "CodeSiteProject" AS project
WHERE project."id" = session."projectId";

CREATE INDEX "CodeSiteAgentSession_workspaceSlug_idx"
ON "CodeSiteAgentSession"("workspaceSlug");

CREATE INDEX "CodeSiteAgentSession_effectiveWorkspaceUserId_idx"
ON "CodeSiteAgentSession"("effectiveWorkspaceUserId");

CREATE INDEX "CodeSiteAgentSession_collaborationSessionId_status_idx"
ON "CodeSiteAgentSession"("collaborationSessionId", "status");

CREATE INDEX "CodeSiteAgentSession_terminalSessionId_idx"
ON "CodeSiteAgentSession"("terminalSessionId");

CREATE INDEX "CodeSiteAgentSession_runtimeSessionId_idx"
ON "CodeSiteAgentSession"("runtimeSessionId");

CREATE UNIQUE INDEX "CodeSiteAgentSession_workspaceSlug_terminalSessionId_key"
ON "CodeSiteAgentSession"("workspaceSlug", "terminalSessionId");

CREATE UNIQUE INDEX "CodeSiteAgentSession_ownerUserId_agentProvider_providerSessionRef_key"
ON "CodeSiteAgentSession"("ownerUserId", "agentProvider", "providerSessionRef");
