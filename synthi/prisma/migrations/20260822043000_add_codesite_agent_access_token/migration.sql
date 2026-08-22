ALTER TABLE "CodeSiteAgentSession"
ADD COLUMN "agentAccessTokenHash" TEXT,
ADD COLUMN "agentAccessTokenIssuedAt" TIMESTAMP(3),
ADD COLUMN "agentAccessTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "CodeSiteAgentSession_agentAccessTokenHash_key"
ON "CodeSiteAgentSession"("agentAccessTokenHash");

CREATE INDEX "CodeSiteAgentSession_agentAccessTokenExpiresAt_idx"
ON "CodeSiteAgentSession"("agentAccessTokenExpiresAt");
