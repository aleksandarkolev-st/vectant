CREATE TABLE "LocalSupportSecurityEvent" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "alert" BOOLEAN NOT NULL DEFAULT false,
    "alertRoute" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "targetDisplay" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "logClass" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LocalSupportSecurityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LocalSupportSecurityEvent_severity_createdAt_idx" ON "LocalSupportSecurityEvent"("severity", "createdAt");
CREATE INDEX "LocalSupportSecurityEvent_eventType_createdAt_idx" ON "LocalSupportSecurityEvent"("eventType", "createdAt");
CREATE INDEX "LocalSupportSecurityEvent_accountId_createdAt_idx" ON "LocalSupportSecurityEvent"("accountId", "createdAt");
CREATE INDEX "LocalSupportSecurityEvent_dedupeKey_createdAt_idx" ON "LocalSupportSecurityEvent"("dedupeKey", "createdAt");
