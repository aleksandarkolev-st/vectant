CREATE TABLE "JupyterServer" (
    "id" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "secretId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JupyterServer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JupyterServer_secretId_key" ON "JupyterServer"("secretId");
CREATE UNIQUE INDEX "JupyterServer_workspaceSlug_origin_key" ON "JupyterServer"("workspaceSlug", "origin");
CREATE INDEX "JupyterServer_workspaceSlug_idx" ON "JupyterServer"("workspaceSlug");
ALTER TABLE "JupyterServer" ADD CONSTRAINT "JupyterServer_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "EncryptedSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "JupyterAuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "serverId" TEXT,
    "actorUserId" TEXT,
    "eventType" TEXT NOT NULL,
    "notebookPath" TEXT,
    "kernelId" TEXT,
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JupyterAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JupyterAuditEvent_workspaceSlug_createdAt_idx" ON "JupyterAuditEvent"("workspaceSlug", "createdAt");
CREATE INDEX "JupyterAuditEvent_serverId_createdAt_idx" ON "JupyterAuditEvent"("serverId", "createdAt");
CREATE INDEX "JupyterAuditEvent_eventType_createdAt_idx" ON "JupyterAuditEvent"("eventType", "createdAt");
