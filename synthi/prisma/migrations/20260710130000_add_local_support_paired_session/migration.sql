CREATE TABLE "LocalSupportSession" (
    "sessionId" TEXT NOT NULL,
    "pairingId" TEXT NOT NULL,
    "browserSessionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deviceFingerprint" TEXT NOT NULL,
    "devicePublicKey" TEXT NOT NULL,
    "capabilitiesJson" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastDeviceProofAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalSupportSession_pkey" PRIMARY KEY ("sessionId")
);

CREATE UNIQUE INDEX "LocalSupportSession_pairingId_key" ON "LocalSupportSession"("pairingId");
CREATE INDEX "LocalSupportSession_deviceFingerprint_status_expiresAt_idx" ON "LocalSupportSession"("deviceFingerprint", "status", "expiresAt");
CREATE INDEX "LocalSupportSession_accountId_orgId_status_idx" ON "LocalSupportSession"("accountId", "orgId", "status");
CREATE INDEX "LocalSupportSession_expiresAt_idx" ON "LocalSupportSession"("expiresAt");
