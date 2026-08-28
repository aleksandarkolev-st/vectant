-- AlterTable
ALTER TABLE "CodeSiteAgentSession" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "CodeSiteWarrant" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "audienceJson" TEXT NOT NULL,
    "grantsJson" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "bearerHash" TEXT,
    "parentWarrantId" TEXT,
    "rootWarrantId" TEXT NOT NULL,
    "delegationJson" TEXT,
    "delegationDepth" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteWarrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteWarrantBudget" (
    "id" TEXT NOT NULL,
    "warrantId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "remainingInvocations" INTEGER NOT NULL,
    "maximumInvocations" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteWarrantBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteWarrantLineage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "descendantWarrantId" TEXT NOT NULL,
    "ancestorWarrantId" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSiteWarrantLineage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteWarrantReceipt" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "warrantId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "principalJson" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteWarrantReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteWarrantAuditHead" (
    "projectId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "headHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteWarrantAuditHead_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "CodeSiteWarrantAuditOutbox" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventJson" TEXT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "signatureKeyId" TEXT,
    "signatureKeyUri" TEXT,
    "signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteWarrantAuditOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeSiteWarrant_projectId_status_expiresAt_idx" ON "CodeSiteWarrant"("projectId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "CodeSiteWarrant_workspaceSlug_status_expiresAt_idx" ON "CodeSiteWarrant"("workspaceSlug", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "CodeSiteWarrant_parentWarrantId_idx" ON "CodeSiteWarrant"("parentWarrantId");

-- CreateIndex
CREATE INDEX "CodeSiteWarrant_rootWarrantId_idx" ON "CodeSiteWarrant"("rootWarrantId");

-- CreateIndex
CREATE INDEX "CodeSiteWarrantBudget_tool_remainingInvocations_idx" ON "CodeSiteWarrantBudget"("tool", "remainingInvocations");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSiteWarrantBudget_warrantId_tool_key" ON "CodeSiteWarrantBudget"("warrantId", "tool");

-- CreateIndex
CREATE INDEX "CodeSiteWarrantLineage_projectId_ancestorWarrantId_idx" ON "CodeSiteWarrantLineage"("projectId", "ancestorWarrantId");

-- CreateIndex
CREATE INDEX "CodeSiteWarrantLineage_projectId_descendantWarrantId_idx" ON "CodeSiteWarrantLineage"("projectId", "descendantWarrantId");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSiteWarrantLineage_descendantWarrantId_ancestorWarrantI_key" ON "CodeSiteWarrantLineage"("descendantWarrantId", "ancestorWarrantId");

-- CreateIndex
CREATE INDEX "CodeSiteWarrantReceipt_workspaceSlug_status_reservedAt_idx" ON "CodeSiteWarrantReceipt"("workspaceSlug", "status", "reservedAt");

-- CreateIndex
CREATE INDEX "CodeSiteWarrantReceipt_warrantId_status_idx" ON "CodeSiteWarrantReceipt"("warrantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSiteWarrantReceipt_projectId_idempotencyKey_key" ON "CodeSiteWarrantReceipt"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CodeSiteWarrantAuditOutbox_workspaceSlug_status_createdAt_idx" ON "CodeSiteWarrantAuditOutbox"("workspaceSlug", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSiteWarrantAuditOutbox_projectId_sequence_key" ON "CodeSiteWarrantAuditOutbox"("projectId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSiteWarrantAuditOutbox_eventHash_key" ON "CodeSiteWarrantAuditOutbox"("eventHash");

-- AddForeignKey
ALTER TABLE "CodeSiteWarrant" ADD CONSTRAINT "CodeSiteWarrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantBudget" ADD CONSTRAINT "CodeSiteWarrantBudget_warrantId_fkey" FOREIGN KEY ("warrantId") REFERENCES "CodeSiteWarrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantLineage" ADD CONSTRAINT "CodeSiteWarrantLineage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantLineage" ADD CONSTRAINT "CodeSiteWarrantLineage_descendantWarrantId_fkey" FOREIGN KEY ("descendantWarrantId") REFERENCES "CodeSiteWarrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantLineage" ADD CONSTRAINT "CodeSiteWarrantLineage_ancestorWarrantId_fkey" FOREIGN KEY ("ancestorWarrantId") REFERENCES "CodeSiteWarrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantReceipt" ADD CONSTRAINT "CodeSiteWarrantReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantReceipt" ADD CONSTRAINT "CodeSiteWarrantReceipt_warrantId_fkey" FOREIGN KEY ("warrantId") REFERENCES "CodeSiteWarrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantAuditHead" ADD CONSTRAINT "CodeSiteWarrantAuditHead_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteWarrantAuditOutbox" ADD CONSTRAINT "CodeSiteWarrantAuditOutbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CodeSiteKnowledgeReference_knowledgeId_refType_refKey_relation_" RENAME TO "CodeSiteKnowledgeReference_knowledgeId_refType_refKey_relat_key";
