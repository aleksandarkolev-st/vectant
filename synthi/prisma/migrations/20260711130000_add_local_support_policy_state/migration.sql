CREATE TABLE "LocalSupportPolicyState" (
    "id" TEXT NOT NULL,
    "globalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "orgDisabled" BOOLEAN NOT NULL DEFAULT false,
    "pairingDisabled" BOOLEAN NOT NULL DEFAULT false,
    "previewDisabled" BOOLEAN NOT NULL DEFAULT false,
    "agentAccessDisabled" BOOLEAN NOT NULL DEFAULT true,
    "minAppVersion" TEXT NOT NULL DEFAULT '0.1.0',
    "vulnerableVersionsJson" TEXT NOT NULL DEFAULT '[]',
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LocalSupportPolicyState_pkey" PRIMARY KEY ("id")
);
