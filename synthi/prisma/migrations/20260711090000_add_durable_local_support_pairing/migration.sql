CREATE TABLE "LocalSupportPairingChallenge" (
    "pairingId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "serverNonce" TEXT NOT NULL,
    "browserSessionId" TEXT NOT NULL,
    "requestedUserId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL DEFAULT 'unclaimed',
    "protocolVersion" TEXT NOT NULL DEFAULT 'unclaimed',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalSupportPairingChallenge_pkey" PRIMARY KEY ("pairingId")
);

CREATE TABLE "LocalSupportPairingRateLimit" (
    "bucket" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LocalSupportPairingRateLimit_pkey" PRIMARY KEY ("bucket")
);

CREATE UNIQUE INDEX "LocalSupportPairingChallenge_codeHash_key" ON "LocalSupportPairingChallenge"("codeHash");
CREATE INDEX "LocalSupportPairingChallenge_status_expiresAt_idx" ON "LocalSupportPairingChallenge"("status", "expiresAt");
CREATE INDEX "LocalSupportPairingChallenge_accountId_orgId_createdAt_idx" ON "LocalSupportPairingChallenge"("accountId", "orgId", "createdAt");
