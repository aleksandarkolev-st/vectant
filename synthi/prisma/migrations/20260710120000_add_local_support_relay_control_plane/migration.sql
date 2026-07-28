-- Create durable, body-free Local Support relay delivery state.
CREATE TABLE "LocalSupportRelayRequest" (
    "requestId" TEXT NOT NULL,
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
    "redactionCount" INTEGER NOT NULL DEFAULT 0,
    "scannerVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "deviceProof" TEXT NOT NULL,
    "envelopeSignature" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalSupportRelayRequest_pkey" PRIMARY KEY ("requestId")
);

-- Cloud audit intentionally has no raw request/response body column.
CREATE TABLE "LocalSupportCloudAudit" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
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

    CONSTRAINT "LocalSupportCloudAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LocalSupportRelayRequest_sessionId_status_expiresAt_idx" ON "LocalSupportRelayRequest"("sessionId", "status", "expiresAt");
CREATE INDEX "LocalSupportRelayRequest_deviceFingerprint_status_expiresAt_idx" ON "LocalSupportRelayRequest"("deviceFingerprint", "status", "expiresAt");
CREATE INDEX "LocalSupportRelayRequest_status_leaseExpiresAt_idx" ON "LocalSupportRelayRequest"("status", "leaseExpiresAt");
CREATE INDEX "LocalSupportRelayRequest_createdAt_idx" ON "LocalSupportRelayRequest"("createdAt");
CREATE INDEX "LocalSupportCloudAudit_sessionId_createdAt_idx" ON "LocalSupportCloudAudit"("sessionId", "createdAt");
CREATE INDEX "LocalSupportCloudAudit_accountId_orgId_createdAt_idx" ON "LocalSupportCloudAudit"("accountId", "orgId", "createdAt");
CREATE INDEX "LocalSupportCloudAudit_logClass_createdAt_idx" ON "LocalSupportCloudAudit"("logClass", "createdAt");
CREATE INDEX "LocalSupportCloudAudit_decision_createdAt_idx" ON "LocalSupportCloudAudit"("decision", "createdAt");

ALTER TABLE "LocalSupportCloudAudit" ADD CONSTRAINT "LocalSupportCloudAudit_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "LocalSupportRelayRequest"("requestId") ON DELETE CASCADE ON UPDATE CASCADE;
