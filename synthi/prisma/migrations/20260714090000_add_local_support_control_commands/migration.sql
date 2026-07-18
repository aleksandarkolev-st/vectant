CREATE TABLE "LocalSupportControlCommand" (
    "commandId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deviceFingerprint" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "port" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "resultReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalSupportControlCommand_pkey" PRIMARY KEY ("commandId")
);

CREATE INDEX "LocalSupportControlCommand_sessionId_status_expiresAt_idx" ON "LocalSupportControlCommand"("sessionId", "status", "expiresAt");
CREATE INDEX "LocalSupportControlCommand_deviceFingerprint_status_expiresAt_idx" ON "LocalSupportControlCommand"("deviceFingerprint", "status", "expiresAt");
CREATE INDEX "LocalSupportControlCommand_status_leaseExpiresAt_idx" ON "LocalSupportControlCommand"("status", "leaseExpiresAt");
CREATE INDEX "LocalSupportControlCommand_accountId_createdAt_idx" ON "LocalSupportControlCommand"("accountId", "createdAt");
