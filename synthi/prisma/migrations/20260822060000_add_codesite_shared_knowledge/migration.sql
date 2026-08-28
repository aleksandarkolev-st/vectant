CREATE TABLE "CodeSiteKnowledgeItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "scopeJson" TEXT NOT NULL,
    "redactionClass" TEXT NOT NULL DEFAULT 'project',
    "confidence" DOUBLE PRECISION,
    "verificationStatus" TEXT NOT NULL DEFAULT 'unverified',
    "createdByUserId" TEXT,
    "createdByAgentSessionId" TEXT,
    "ownerUserId" TEXT,
    "ownerAgentSessionId" TEXT,
    "sourceEventId" TEXT,
    "sourceKnowledgeItemId" TEXT,
    "targetTransactionId" TEXT,
    "dedupeKey" TEXT,
    "evidenceRefsJson" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteKnowledgeItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodeSiteKnowledgeReference" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "knowledgeId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refKey" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "CodeSiteKnowledgeReference_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CodeSiteAgentInboxItem"
ADD COLUMN "knowledgeItemId" TEXT,
ADD COLUMN "responseAction" TEXT,
ADD COLUMN "responseJson" TEXT,
ADD COLUMN "respondedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "CodeSiteKnowledgeItem_projectId_dedupeKey_key"
ON "CodeSiteKnowledgeItem"("projectId", "dedupeKey");

CREATE INDEX "CodeSiteKnowledgeItem_projectId_kind_status_idx"
ON "CodeSiteKnowledgeItem"("projectId", "kind", "status");

CREATE INDEX "CodeSiteKnowledgeItem_projectId_expiresAt_idx"
ON "CodeSiteKnowledgeItem"("projectId", "expiresAt");

CREATE INDEX "CodeSiteKnowledgeItem_createdByAgentSessionId_idx"
ON "CodeSiteKnowledgeItem"("createdByAgentSessionId");

CREATE INDEX "CodeSiteKnowledgeItem_ownerAgentSessionId_idx"
ON "CodeSiteKnowledgeItem"("ownerAgentSessionId");

CREATE INDEX "CodeSiteKnowledgeItem_sourceEventId_idx"
ON "CodeSiteKnowledgeItem"("sourceEventId");

CREATE INDEX "CodeSiteKnowledgeItem_sourceKnowledgeItemId_idx"
ON "CodeSiteKnowledgeItem"("sourceKnowledgeItemId");

CREATE INDEX "CodeSiteKnowledgeItem_targetTransactionId_idx"
ON "CodeSiteKnowledgeItem"("targetTransactionId");

CREATE UNIQUE INDEX "CodeSiteKnowledgeReference_knowledgeId_refType_refKey_relation_key"
ON "CodeSiteKnowledgeReference"("knowledgeId", "refType", "refKey", "relation");

CREATE INDEX "CodeSiteKnowledgeReference_projectId_refType_refKey_idx"
ON "CodeSiteKnowledgeReference"("projectId", "refType", "refKey");

CREATE INDEX "CodeSiteKnowledgeReference_knowledgeId_relation_idx"
ON "CodeSiteKnowledgeReference"("knowledgeId", "relation");

CREATE UNIQUE INDEX "CodeSiteAgentInboxItem_knowledgeItemId_agentSessionId_key"
ON "CodeSiteAgentInboxItem"("knowledgeItemId", "agentSessionId");

ALTER TABLE "CodeSiteKnowledgeItem"
ADD CONSTRAINT "CodeSiteKnowledgeItem_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodeSiteKnowledgeItem"
ADD CONSTRAINT "CodeSiteKnowledgeItem_createdByAgentSessionId_fkey"
FOREIGN KEY ("createdByAgentSessionId") REFERENCES "CodeSiteAgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CodeSiteKnowledgeItem"
ADD CONSTRAINT "CodeSiteKnowledgeItem_ownerAgentSessionId_fkey"
FOREIGN KEY ("ownerAgentSessionId") REFERENCES "CodeSiteAgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CodeSiteKnowledgeItem"
ADD CONSTRAINT "CodeSiteKnowledgeItem_sourceEventId_fkey"
FOREIGN KEY ("sourceEventId") REFERENCES "CodeSiteEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CodeSiteKnowledgeItem"
ADD CONSTRAINT "CodeSiteKnowledgeItem_sourceKnowledgeItemId_fkey"
FOREIGN KEY ("sourceKnowledgeItemId") REFERENCES "CodeSiteKnowledgeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CodeSiteKnowledgeItem"
ADD CONSTRAINT "CodeSiteKnowledgeItem_targetTransactionId_fkey"
FOREIGN KEY ("targetTransactionId") REFERENCES "CodeSiteMutationTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CodeSiteKnowledgeReference"
ADD CONSTRAINT "CodeSiteKnowledgeReference_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodeSiteKnowledgeReference"
ADD CONSTRAINT "CodeSiteKnowledgeReference_knowledgeId_fkey"
FOREIGN KEY ("knowledgeId") REFERENCES "CodeSiteKnowledgeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodeSiteAgentInboxItem"
ADD CONSTRAINT "CodeSiteAgentInboxItem_knowledgeItemId_fkey"
FOREIGN KEY ("knowledgeItemId") REFERENCES "CodeSiteKnowledgeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
