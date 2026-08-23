CREATE TABLE "LocalSupportLinkedProject" (
  "projectId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "deviceFingerprint" TEXT NOT NULL,
  "workspaceHash" TEXT NOT NULL,
  "selectionMode" TEXT NOT NULL,
  "selectedNodeIdsJson" TEXT NOT NULL DEFAULT '[]',
  "displayName" TEXT NOT NULL,
  "graphNodeCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending_local_confirmation',
  "fullAccessExpiresAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LocalSupportLinkedProject_pkey" PRIMARY KEY ("projectId"),
  CONSTRAINT "LocalSupportLinkedProject_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LocalSupportSession"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LocalSupportLinkedProject_accountId_status_updatedAt_idx" ON "LocalSupportLinkedProject"("accountId", "status", "updatedAt");
CREATE INDEX "LocalSupportLinkedProject_sessionId_status_idx" ON "LocalSupportLinkedProject"("sessionId", "status");
CREATE INDEX "LocalSupportLinkedProject_deviceFingerprint_status_idx" ON "LocalSupportLinkedProject"("deviceFingerprint", "status");
