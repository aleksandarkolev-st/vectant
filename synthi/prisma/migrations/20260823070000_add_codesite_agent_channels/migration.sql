-- Registered direct channels (docs/REGISTERED_DIRECT_CHANNELS_DESIGN.md)
-- and per-project coordination mode (docs/CHANNEL_MODES_TRADEOFFS.md).

ALTER TABLE "CodeSiteProject" ADD COLUMN "channelMode" TEXT NOT NULL DEFAULT 'registered_direct';

CREATE TABLE "CodeSiteAgentChannel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "fromSessionId" TEXT NOT NULL,
    "toSessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "purpose" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "fromEndpointRef" TEXT,
    "toEndpointRef" TEXT,
    "channelTokenHash" TEXT,
    "maxDurationMs" INTEGER,
    "grantExpiresAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "summaryDigest" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteAgentChannel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CodeSiteAgentChannel_projectId_status_idx" ON "CodeSiteAgentChannel"("projectId", "status");
CREATE INDEX "CodeSiteAgentChannel_workspaceSlug_status_idx" ON "CodeSiteAgentChannel"("workspaceSlug", "status");
CREATE INDEX "CodeSiteAgentChannel_fromSessionId_idx" ON "CodeSiteAgentChannel"("fromSessionId");
CREATE INDEX "CodeSiteAgentChannel_toSessionId_idx" ON "CodeSiteAgentChannel"("toSessionId");

ALTER TABLE "CodeSiteAgentChannel" ADD CONSTRAINT "CodeSiteAgentChannel_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
