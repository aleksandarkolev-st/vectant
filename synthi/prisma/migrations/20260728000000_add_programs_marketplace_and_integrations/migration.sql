-- CreateTable
CREATE TABLE "McpConnection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'http',
    "scope" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "workspaceSlug" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "headerName" TEXT,
    "secretId" TEXT,
    "toolAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastHealthState" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpCallAudit" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT,
    "serverName" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "userId" TEXT,
    "workspaceSlug" TEXT,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "alias" TEXT,
    "callerType" TEXT,
    "durationMs" INTEGER,
    "argsHash" TEXT,
    "argsBytes" INTEGER,
    "resultBytes" INTEGER,
    "codeSiteProjectId" TEXT,
    "codeSiteTransactionId" TEXT,
    "codeSiteMutationLeaseId" TEXT,
    "codeSiteAgentSessionId" TEXT,
    "codeSiteEvidenceRefsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpCallAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalAccessToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "last4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PersonalAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "baseUrl" TEXT,
    "scope" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "workspaceSlug" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'pat',
    "secretId" TEXT,
    "refreshSecretId" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "oauthScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accountLogin" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "needsRelink" BOOLEAN NOT NULL DEFAULT false,
    "lastHealthState" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceProgram" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "latestVersion" TEXT NOT NULL,
    "displayName" TEXT,
    "description" TEXT,
    "publishedByUserId" TEXT,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "publishedVersion" TEXT,
    "publishedDigest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramVersion" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifestJson" TEXT NOT NULL,
    "requiredTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewState" TEXT NOT NULL DEFAULT 'published',
    "sourceImageRef" TEXT,
    "sourceImageDigest" TEXT,
    "hostedImageDigest" TEXT,
    "scanReportJson" TEXT,
    "aiRiskJson" TEXT,
    "submittedByUserId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewNotes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramInstall" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "installedByUserId" TEXT NOT NULL,
    "grantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramInstall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramSession" (
    "id" TEXT NOT NULL,
    "installId" TEXT,
    "workspaceSlug" TEXT NOT NULL,
    "runtimeType" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'starting',
    "startedByUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "lastHealthState" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionGrant" (
    "id" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramRuntimeEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dataJson" TEXT,
    "codeSiteProjectId" TEXT,
    "codeSiteTransactionId" TEXT,
    "codeSiteMutationLeaseId" TEXT,
    "codeSiteAgentSessionId" TEXT,
    "codeSiteEvidenceRefsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramRuntimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramReviewEvent" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reasonJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramPricing" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'one_time',
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "payoutAccountRef" TEXT,
    "takeRateBps" INTEGER NOT NULL DEFAULT 3000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'user',
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "priceCents" INTEGER,
    "currency" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpConnection_secretId_key" ON "McpConnection"("secretId");

-- CreateIndex
CREATE INDEX "McpConnection_ownerUserId_idx" ON "McpConnection"("ownerUserId");

-- CreateIndex
CREATE INDEX "McpConnection_workspaceSlug_idx" ON "McpConnection"("workspaceSlug");

-- CreateIndex
CREATE INDEX "McpCallAudit_connectionId_idx" ON "McpCallAudit"("connectionId");

-- CreateIndex
CREATE INDEX "McpCallAudit_createdAt_idx" ON "McpCallAudit"("createdAt");

-- CreateIndex
CREATE INDEX "McpCallAudit_codeSiteProjectId_idx" ON "McpCallAudit"("codeSiteProjectId");

-- CreateIndex
CREATE INDEX "McpCallAudit_codeSiteTransactionId_idx" ON "McpCallAudit"("codeSiteTransactionId");

-- CreateIndex
CREATE INDEX "McpCallAudit_codeSiteMutationLeaseId_idx" ON "McpCallAudit"("codeSiteMutationLeaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAccessToken_tokenHash_key" ON "PersonalAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PersonalAccessToken_userId_idx" ON "PersonalAccessToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GitProvider_secretId_key" ON "GitProvider"("secretId");

-- CreateIndex
CREATE UNIQUE INDEX "GitProvider_refreshSecretId_key" ON "GitProvider"("refreshSecretId");

-- CreateIndex
CREATE INDEX "GitProvider_ownerUserId_idx" ON "GitProvider"("ownerUserId");

-- CreateIndex
CREATE INDEX "GitProvider_workspaceSlug_idx" ON "GitProvider"("workspaceSlug");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceProgram_packageId_key" ON "MarketplaceProgram"("packageId");

-- CreateIndex
CREATE INDEX "ProgramVersion_programId_idx" ON "ProgramVersion"("programId");

-- CreateIndex
CREATE INDEX "ProgramVersion_reviewState_idx" ON "ProgramVersion"("reviewState");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramVersion_programId_version_key" ON "ProgramVersion"("programId", "version");

-- CreateIndex
CREATE INDEX "ProgramInstall_programId_idx" ON "ProgramInstall"("programId");

-- CreateIndex
CREATE INDEX "ProgramInstall_workspaceSlug_idx" ON "ProgramInstall"("workspaceSlug");

-- CreateIndex
CREATE INDEX "ProgramInstall_installedByUserId_idx" ON "ProgramInstall"("installedByUserId");

-- CreateIndex
CREATE INDEX "ProgramInstall_grantId_idx" ON "ProgramInstall"("grantId");

-- CreateIndex
CREATE INDEX "ProgramSession_installId_idx" ON "ProgramSession"("installId");

-- CreateIndex
CREATE INDEX "ProgramSession_workspaceSlug_idx" ON "ProgramSession"("workspaceSlug");

-- CreateIndex
CREATE INDEX "ProgramSession_startedByUserId_idx" ON "ProgramSession"("startedByUserId");

-- CreateIndex
CREATE INDEX "ProgramSession_state_idx" ON "ProgramSession"("state");

-- CreateIndex
CREATE INDEX "ProgramSession_startedAt_idx" ON "ProgramSession"("startedAt");

-- CreateIndex
CREATE INDEX "PermissionGrant_workspaceSlug_idx" ON "PermissionGrant"("workspaceSlug");

-- CreateIndex
CREATE INDEX "PermissionGrant_grantedByUserId_idx" ON "PermissionGrant"("grantedByUserId");

-- CreateIndex
CREATE INDEX "ProgramRuntimeEvent_sessionId_idx" ON "ProgramRuntimeEvent"("sessionId");

-- CreateIndex
CREATE INDEX "ProgramRuntimeEvent_createdAt_idx" ON "ProgramRuntimeEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ProgramRuntimeEvent_codeSiteProjectId_idx" ON "ProgramRuntimeEvent"("codeSiteProjectId");

-- CreateIndex
CREATE INDEX "ProgramRuntimeEvent_codeSiteTransactionId_idx" ON "ProgramRuntimeEvent"("codeSiteTransactionId");

-- CreateIndex
CREATE INDEX "ProgramRuntimeEvent_codeSiteMutationLeaseId_idx" ON "ProgramRuntimeEvent"("codeSiteMutationLeaseId");

-- CreateIndex
CREATE INDEX "ProgramReviewEvent_versionId_idx" ON "ProgramReviewEvent"("versionId");

-- CreateIndex
CREATE INDEX "ProgramReviewEvent_createdAt_idx" ON "ProgramReviewEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramPricing_programId_key" ON "ProgramPricing"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_reference_key" ON "Entitlement"("reference");

-- CreateIndex
CREATE INDEX "Entitlement_programId_idx" ON "Entitlement"("programId");

-- CreateIndex
CREATE INDEX "Entitlement_subjectId_idx" ON "Entitlement"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_programId_subjectType_subjectId_key" ON "Entitlement"("programId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_eventId_key" ON "PaymentWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_reference_idx" ON "PaymentWebhookEvent"("reference");

-- AddForeignKey
ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "EncryptedSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCallAudit" ADD CONSTRAINT "McpCallAudit_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitProvider" ADD CONSTRAINT "GitProvider_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "EncryptedSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitProvider" ADD CONSTRAINT "GitProvider_refreshSecretId_fkey" FOREIGN KEY ("refreshSecretId") REFERENCES "EncryptedSecret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramVersion" ADD CONSTRAINT "ProgramVersion_programId_fkey" FOREIGN KEY ("programId") REFERENCES "MarketplaceProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramInstall" ADD CONSTRAINT "ProgramInstall_programId_fkey" FOREIGN KEY ("programId") REFERENCES "MarketplaceProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramInstall" ADD CONSTRAINT "ProgramInstall_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "PermissionGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramSession" ADD CONSTRAINT "ProgramSession_installId_fkey" FOREIGN KEY ("installId") REFERENCES "ProgramInstall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramRuntimeEvent" ADD CONSTRAINT "ProgramRuntimeEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ProgramSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramReviewEvent" ADD CONSTRAINT "ProgramReviewEvent_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ProgramVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramPricing" ADD CONSTRAINT "ProgramPricing_programId_fkey" FOREIGN KEY ("programId") REFERENCES "MarketplaceProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_programId_fkey" FOREIGN KEY ("programId") REFERENCES "MarketplaceProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "LocalSupportControlCommand_deviceFingerprint_status_expiresAt_i" RENAME TO "LocalSupportControlCommand_deviceFingerprint_status_expires_idx";

