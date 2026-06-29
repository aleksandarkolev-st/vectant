-- CreateTable
CREATE TABLE "CodeSiteProject" (
    "id" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "zonePolicyJson" TEXT NOT NULL,
    "controlPlanJson" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteMutationZone" (
    "id" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "zoneKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "pathsJson" TEXT NOT NULL,
    "rulesJson" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteMutationZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteAgentSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "agentProvider" TEXT NOT NULL,
    "agentRuntime" TEXT,
    "providerSessionRef" TEXT,
    "displayCallsign" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "permissionsJson" TEXT NOT NULL,
    "redactionPolicyJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteAgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteExecutionPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "displayCallsign" TEXT NOT NULL,
    "mission" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "routeJson" TEXT NOT NULL,
    "blockedZonesJson" TEXT NOT NULL,
    "abortJson" TEXT NOT NULL,
    "requestedToolsJson" TEXT NOT NULL,
    "estimatedDurationMs" INTEGER,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteExecutionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteMutationLease" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionPlanId" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "displayCallsign" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "leaseJson" TEXT NOT NULL,
    "dojoProofRef" TEXT,
    "dojoLicenseRef" TEXT,
    "dojoEvidenceRefsJson" TEXT,
    "dojoLedgerCheckpointHash" TEXT,
    "dojoDecisionDigest" TEXT,
    "implementationStatusJson" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteMutationLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteMutationTransaction" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mutationLeaseId" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "baseSnapshot" TEXT NOT NULL,
    "isolation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "readSetJson" TEXT NOT NULL,
    "observedReadSetJson" TEXT,
    "writeSetJson" TEXT NOT NULL,
    "observedWriteSetJson" TEXT,
    "semanticDependencyRefsJson" TEXT,
    "invariantsJson" TEXT NOT NULL,
    "assumptionRefsJson" TEXT NOT NULL,
    "commitDecisionJson" TEXT,
    "proofBundleDigest" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteMutationTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteAssumptionLease" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerSessionId" TEXT NOT NULL,
    "displayCallsign" TEXT NOT NULL,
    "assumptionKey" TEXT NOT NULL,
    "dependsOnJson" TEXT NOT NULL,
    "usedByJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "invalidatedBy" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSiteAssumptionLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSitePolicyDecision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mutationLeaseId" TEXT,
    "displayCallsign" TEXT,
    "decision" TEXT NOT NULL,
    "reasonCodesJson" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "decisionJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSitePolicyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteProofBundle" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "commitSha" TEXT,
    "readSetDigest" TEXT NOT NULL,
    "writeSetDigest" TEXT NOT NULL,
    "invariantsJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "dojoEvidenceRefsJson" TEXT,
    "incidentReplayDigest" TEXT,
    "bundleDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSiteProofBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteLineProvenance" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineAnchor" TEXT NOT NULL,
    "displayCallsign" TEXT NOT NULL,
    "reasonRef" TEXT,
    "evidenceRefsJson" TEXT NOT NULL,
    "dojoSourceRefsJson" TEXT,
    "proofBundleId" TEXT,
    "processAncestryJson" TEXT,
    "promptSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSiteLineProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteInspectionRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionPlanId" TEXT,
    "displayCallsign" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "changedPathsJson" TEXT NOT NULL,
    "inspectionSignalsJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteInspectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteIncident" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "participantsJson" TEXT NOT NULL,
    "affectedZonesJson" TEXT NOT NULL,
    "incidentReplayJson" TEXT NOT NULL,
    "replayDigest" TEXT,
    "timelineEventRefsJson" TEXT,
    "policyDeltaJson" TEXT,
    "evidenceRefsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSiteIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteDocument" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyJson" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mutationLeaseId" TEXT,
    "eventType" TEXT NOT NULL,
    "displayCallsign" TEXT,
    "actorType" TEXT,
    "actorId" TEXT,
    "detailsJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT,
    "logicalTime" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSiteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteAgentInboxItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "eventId" TEXT,
    "documentId" TEXT,
    "kind" TEXT NOT NULL,
    "requiresResponse" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "redactedPayloadJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteAgentInboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteCounterfactualRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "shadowJobRef" TEXT,
    "baseSnapshot" TEXT NOT NULL,
    "universesJson" TEXT NOT NULL,
    "arbiterVerdictJson" TEXT,
    "userChoiceJson" TEXT,
    "laterManualEditsJson" TEXT,
    "validityStrength" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeSiteCounterfactualRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSitePolicyDelta" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "learnedFromIncidentsJson" TEXT NOT NULL,
    "affectedZoneKey" TEXT,
    "ruleCandidateJson" TEXT NOT NULL,
    "triggerConditionsJson" TEXT NOT NULL,
    "expectedRiskReduction" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION NOT NULL,
    "promotionState" TEXT NOT NULL,
    "replayRefsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSitePolicyDelta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeSiteProject_workspaceSlug_idx" ON "CodeSiteProject"("workspaceSlug");
CREATE INDEX "CodeSiteProject_status_idx" ON "CodeSiteProject"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSiteMutationZone_workspaceSlug_zoneKey_key" ON "CodeSiteMutationZone"("workspaceSlug", "zoneKey");
CREATE INDEX "CodeSiteMutationZone_workspaceSlug_idx" ON "CodeSiteMutationZone"("workspaceSlug");
CREATE INDEX "CodeSiteMutationZone_class_idx" ON "CodeSiteMutationZone"("class");

-- CreateIndex
CREATE INDEX "CodeSiteAgentSession_projectId_idx" ON "CodeSiteAgentSession"("projectId");
CREATE INDEX "CodeSiteAgentSession_ownerUserId_idx" ON "CodeSiteAgentSession"("ownerUserId");
CREATE INDEX "CodeSiteAgentSession_displayCallsign_idx" ON "CodeSiteAgentSession"("displayCallsign");
CREATE INDEX "CodeSiteAgentSession_status_idx" ON "CodeSiteAgentSession"("status");

-- CreateIndex
CREATE INDEX "CodeSiteExecutionPlan_projectId_idx" ON "CodeSiteExecutionPlan"("projectId");
CREATE INDEX "CodeSiteExecutionPlan_agentSessionId_idx" ON "CodeSiteExecutionPlan"("agentSessionId");
CREATE INDEX "CodeSiteExecutionPlan_displayCallsign_idx" ON "CodeSiteExecutionPlan"("displayCallsign");
CREATE INDEX "CodeSiteExecutionPlan_status_idx" ON "CodeSiteExecutionPlan"("status");

-- CreateIndex
CREATE INDEX "CodeSiteMutationLease_projectId_idx" ON "CodeSiteMutationLease"("projectId");
CREATE INDEX "CodeSiteMutationLease_executionPlanId_idx" ON "CodeSiteMutationLease"("executionPlanId");
CREATE INDEX "CodeSiteMutationLease_agentSessionId_idx" ON "CodeSiteMutationLease"("agentSessionId");
CREATE INDEX "CodeSiteMutationLease_displayCallsign_idx" ON "CodeSiteMutationLease"("displayCallsign");
CREATE INDEX "CodeSiteMutationLease_status_idx" ON "CodeSiteMutationLease"("status");

-- CreateIndex
CREATE INDEX "CodeSiteMutationTransaction_projectId_idx" ON "CodeSiteMutationTransaction"("projectId");
CREATE INDEX "CodeSiteMutationTransaction_mutationLeaseId_idx" ON "CodeSiteMutationTransaction"("mutationLeaseId");
CREATE INDEX "CodeSiteMutationTransaction_agentSessionId_idx" ON "CodeSiteMutationTransaction"("agentSessionId");
CREATE INDEX "CodeSiteMutationTransaction_status_idx" ON "CodeSiteMutationTransaction"("status");
CREATE INDEX "CodeSiteMutationTransaction_openedAt_idx" ON "CodeSiteMutationTransaction"("openedAt");

-- CreateIndex
CREATE INDEX "CodeSiteAssumptionLease_projectId_idx" ON "CodeSiteAssumptionLease"("projectId");
CREATE INDEX "CodeSiteAssumptionLease_ownerSessionId_idx" ON "CodeSiteAssumptionLease"("ownerSessionId");
CREATE INDEX "CodeSiteAssumptionLease_assumptionKey_idx" ON "CodeSiteAssumptionLease"("assumptionKey");
CREATE INDEX "CodeSiteAssumptionLease_status_idx" ON "CodeSiteAssumptionLease"("status");

-- CreateIndex
CREATE INDEX "CodeSitePolicyDecision_projectId_idx" ON "CodeSitePolicyDecision"("projectId");
CREATE INDEX "CodeSitePolicyDecision_mutationLeaseId_idx" ON "CodeSitePolicyDecision"("mutationLeaseId");
CREATE INDEX "CodeSitePolicyDecision_displayCallsign_idx" ON "CodeSitePolicyDecision"("displayCallsign");
CREATE INDEX "CodeSitePolicyDecision_decision_idx" ON "CodeSitePolicyDecision"("decision");
CREATE INDEX "CodeSitePolicyDecision_createdAt_idx" ON "CodeSitePolicyDecision"("createdAt");

-- CreateIndex
CREATE INDEX "CodeSiteProofBundle_projectId_idx" ON "CodeSiteProofBundle"("projectId");
CREATE INDEX "CodeSiteProofBundle_transactionId_idx" ON "CodeSiteProofBundle"("transactionId");
CREATE INDEX "CodeSiteProofBundle_commitSha_idx" ON "CodeSiteProofBundle"("commitSha");
CREATE INDEX "CodeSiteProofBundle_bundleDigest_idx" ON "CodeSiteProofBundle"("bundleDigest");

-- CreateIndex
CREATE INDEX "CodeSiteLineProvenance_projectId_idx" ON "CodeSiteLineProvenance"("projectId");
CREATE INDEX "CodeSiteLineProvenance_transactionId_idx" ON "CodeSiteLineProvenance"("transactionId");
CREATE INDEX "CodeSiteLineProvenance_filePath_idx" ON "CodeSiteLineProvenance"("filePath");
CREATE INDEX "CodeSiteLineProvenance_displayCallsign_idx" ON "CodeSiteLineProvenance"("displayCallsign");

-- CreateIndex
CREATE INDEX "CodeSiteInspectionRun_projectId_idx" ON "CodeSiteInspectionRun"("projectId");
CREATE INDEX "CodeSiteInspectionRun_executionPlanId_idx" ON "CodeSiteInspectionRun"("executionPlanId");
CREATE INDEX "CodeSiteInspectionRun_displayCallsign_idx" ON "CodeSiteInspectionRun"("displayCallsign");
CREATE INDEX "CodeSiteInspectionRun_status_idx" ON "CodeSiteInspectionRun"("status");

-- CreateIndex
CREATE INDEX "CodeSiteIncident_projectId_idx" ON "CodeSiteIncident"("projectId");
CREATE INDEX "CodeSiteIncident_severity_idx" ON "CodeSiteIncident"("severity");
CREATE INDEX "CodeSiteIncident_category_idx" ON "CodeSiteIncident"("category");

-- CreateIndex
CREATE INDEX "CodeSiteDocument_projectId_idx" ON "CodeSiteDocument"("projectId");
CREATE INDEX "CodeSiteDocument_kind_idx" ON "CodeSiteDocument"("kind");
CREATE INDEX "CodeSiteDocument_status_idx" ON "CodeSiteDocument"("status");

-- CreateIndex
CREATE INDEX "CodeSiteEvent_projectId_idx" ON "CodeSiteEvent"("projectId");
CREATE INDEX "CodeSiteEvent_mutationLeaseId_idx" ON "CodeSiteEvent"("mutationLeaseId");
CREATE INDEX "CodeSiteEvent_displayCallsign_idx" ON "CodeSiteEvent"("displayCallsign");
CREATE INDEX "CodeSiteEvent_eventType_idx" ON "CodeSiteEvent"("eventType");
CREATE INDEX "CodeSiteEvent_createdAt_idx" ON "CodeSiteEvent"("createdAt");

-- CreateIndex
CREATE INDEX "CodeSiteAgentInboxItem_projectId_idx" ON "CodeSiteAgentInboxItem"("projectId");
CREATE INDEX "CodeSiteAgentInboxItem_agentSessionId_idx" ON "CodeSiteAgentInboxItem"("agentSessionId");
CREATE INDEX "CodeSiteAgentInboxItem_recipientUserId_idx" ON "CodeSiteAgentInboxItem"("recipientUserId");
CREATE INDEX "CodeSiteAgentInboxItem_eventId_idx" ON "CodeSiteAgentInboxItem"("eventId");
CREATE INDEX "CodeSiteAgentInboxItem_status_idx" ON "CodeSiteAgentInboxItem"("status");

-- CreateIndex
CREATE INDEX "CodeSiteCounterfactualRun_projectId_idx" ON "CodeSiteCounterfactualRun"("projectId");
CREATE INDEX "CodeSiteCounterfactualRun_shadowJobRef_idx" ON "CodeSiteCounterfactualRun"("shadowJobRef");
CREATE INDEX "CodeSiteCounterfactualRun_validityStrength_idx" ON "CodeSiteCounterfactualRun"("validityStrength");

-- CreateIndex
CREATE INDEX "CodeSitePolicyDelta_projectId_idx" ON "CodeSitePolicyDelta"("projectId");
CREATE INDEX "CodeSitePolicyDelta_affectedZoneKey_idx" ON "CodeSitePolicyDelta"("affectedZoneKey");
CREATE INDEX "CodeSitePolicyDelta_promotionState_idx" ON "CodeSitePolicyDelta"("promotionState");

-- AddForeignKey
ALTER TABLE "CodeSiteAgentSession" ADD CONSTRAINT "CodeSiteAgentSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteExecutionPlan" ADD CONSTRAINT "CodeSiteExecutionPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteExecutionPlan" ADD CONSTRAINT "CodeSiteExecutionPlan_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "CodeSiteAgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteMutationLease" ADD CONSTRAINT "CodeSiteMutationLease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteMutationLease" ADD CONSTRAINT "CodeSiteMutationLease_executionPlanId_fkey" FOREIGN KEY ("executionPlanId") REFERENCES "CodeSiteExecutionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteMutationLease" ADD CONSTRAINT "CodeSiteMutationLease_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "CodeSiteAgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteMutationTransaction" ADD CONSTRAINT "CodeSiteMutationTransaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteMutationTransaction" ADD CONSTRAINT "CodeSiteMutationTransaction_mutationLeaseId_fkey" FOREIGN KEY ("mutationLeaseId") REFERENCES "CodeSiteMutationLease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteMutationTransaction" ADD CONSTRAINT "CodeSiteMutationTransaction_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "CodeSiteAgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteAssumptionLease" ADD CONSTRAINT "CodeSiteAssumptionLease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSitePolicyDecision" ADD CONSTRAINT "CodeSitePolicyDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSitePolicyDecision" ADD CONSTRAINT "CodeSitePolicyDecision_mutationLeaseId_fkey" FOREIGN KEY ("mutationLeaseId") REFERENCES "CodeSiteMutationLease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteProofBundle" ADD CONSTRAINT "CodeSiteProofBundle_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteProofBundle" ADD CONSTRAINT "CodeSiteProofBundle_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "CodeSiteMutationTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteLineProvenance" ADD CONSTRAINT "CodeSiteLineProvenance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteLineProvenance" ADD CONSTRAINT "CodeSiteLineProvenance_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "CodeSiteMutationTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteInspectionRun" ADD CONSTRAINT "CodeSiteInspectionRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteInspectionRun" ADD CONSTRAINT "CodeSiteInspectionRun_executionPlanId_fkey" FOREIGN KEY ("executionPlanId") REFERENCES "CodeSiteExecutionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteIncident" ADD CONSTRAINT "CodeSiteIncident_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteDocument" ADD CONSTRAINT "CodeSiteDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteEvent" ADD CONSTRAINT "CodeSiteEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteEvent" ADD CONSTRAINT "CodeSiteEvent_mutationLeaseId_fkey" FOREIGN KEY ("mutationLeaseId") REFERENCES "CodeSiteMutationLease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteAgentInboxItem" ADD CONSTRAINT "CodeSiteAgentInboxItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteAgentInboxItem" ADD CONSTRAINT "CodeSiteAgentInboxItem_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "CodeSiteAgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteAgentInboxItem" ADD CONSTRAINT "CodeSiteAgentInboxItem_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CodeSiteEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CodeSiteAgentInboxItem" ADD CONSTRAINT "CodeSiteAgentInboxItem_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CodeSiteDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteCounterfactualRun" ADD CONSTRAINT "CodeSiteCounterfactualRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSitePolicyDelta" ADD CONSTRAINT "CodeSitePolicyDelta_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
