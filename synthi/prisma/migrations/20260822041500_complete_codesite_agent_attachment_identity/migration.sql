-- Keep legacy project and agent rows valid while preserving every identity supplied
-- by the trusted collaboration gateway for newly bound sessions.
ALTER TABLE "CodeSiteProject"
ADD COLUMN "collaborationSessionId" TEXT;

ALTER TABLE "CodeSiteAgentSession"
ADD COLUMN "collaborationUserId" TEXT,
ADD COLUMN "runtimeScope" TEXT,
ADD COLUMN "executionHostJson" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN "attachSource" TEXT,
ADD COLUMN "bindingVersion" INTEGER;

CREATE INDEX "CodeSiteProject_collaborationSessionId_idx"
ON "CodeSiteProject"("collaborationSessionId");

CREATE INDEX "CodeSiteAgentSession_collaborationUserId_idx"
ON "CodeSiteAgentSession"("collaborationUserId");

CREATE INDEX "CodeSiteAgentSession_runtimeScope_idx"
ON "CodeSiteAgentSession"("runtimeScope");

CREATE INDEX "CodeSiteAgentSession_lastHeartbeatAt_idx"
ON "CodeSiteAgentSession"("lastHeartbeatAt");

-- The first migration used unconditional uniqueness. Active bindings need to be
-- reusable after a terminal/provider session has ended, while still resolving
-- concurrent attach races to one durable row.
DROP INDEX "CodeSiteAgentSession_workspaceSlug_terminalSessionId_key";
DROP INDEX "CodeSiteAgentSession_ownerUserId_agentProvider_providerSessionRef_key";

CREATE UNIQUE INDEX "CodeSiteAgentSession_active_terminal_binding_key"
ON "CodeSiteAgentSession"("collaborationSessionId", "terminalSessionId")
WHERE "collaborationSessionId" IS NOT NULL
  AND "terminalSessionId" IS NOT NULL
  AND "endedAt" IS NULL;

CREATE UNIQUE INDEX "CodeSiteAgentSession_active_provider_binding_key"
ON "CodeSiteAgentSession"("projectId", "ownerUserId", "agentProvider", "providerSessionRef")
WHERE "providerSessionRef" IS NOT NULL
  AND "endedAt" IS NULL;
