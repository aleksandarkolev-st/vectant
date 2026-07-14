CREATE TABLE "LocalSupportControlAudit" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deviceFingerprint" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "targetDisplay" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "targetClassification" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "bytesSent" INTEGER NOT NULL DEFAULT 0,
    "redactionCount" INTEGER NOT NULL DEFAULT 0,
    "policyVersion" TEXT NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "logClass" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalSupportControlAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocalSupportControlAudit_commandId_key" ON "LocalSupportControlAudit"("commandId");
CREATE INDEX "LocalSupportControlAudit_accountId_createdAt_idx" ON "LocalSupportControlAudit"("accountId", "createdAt");
CREATE INDEX "LocalSupportControlAudit_sessionId_createdAt_idx" ON "LocalSupportControlAudit"("sessionId", "createdAt");
CREATE INDEX "LocalSupportControlAudit_decision_createdAt_idx" ON "LocalSupportControlAudit"("decision", "createdAt");
CREATE INDEX "LocalSupportControlAudit_logClass_createdAt_idx" ON "LocalSupportControlAudit"("logClass", "createdAt");
