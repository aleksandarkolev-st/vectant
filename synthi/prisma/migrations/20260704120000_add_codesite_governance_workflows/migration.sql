-- CreateTable
CREATE TABLE "CodeSitePermit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionPlanId" TEXT,
    "mutationLeaseId" TEXT,
    "documentId" TEXT,
    "permitType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scopeJson" TEXT NOT NULL,
    "approvalJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "issuedByUserId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSitePermit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteDocumentReview" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "reviewerUserId" TEXT,
    "status" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasonCodesJson" TEXT NOT NULL,
    "bodyJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "CodeSiteDocumentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSiteRouteRevision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionPlanId" TEXT NOT NULL,
    "documentId" TEXT,
    "status" TEXT NOT NULL,
    "previousRouteJson" TEXT NOT NULL,
    "proposedRouteJson" TEXT NOT NULL,
    "affectedLeasesJson" TEXT NOT NULL,
    "approvalJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteRouteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeSitePermit_projectId_idx" ON "CodeSitePermit"("projectId");

-- CreateIndex
CREATE INDEX "CodeSitePermit_executionPlanId_idx" ON "CodeSitePermit"("executionPlanId");

-- CreateIndex
CREATE INDEX "CodeSitePermit_mutationLeaseId_idx" ON "CodeSitePermit"("mutationLeaseId");

-- CreateIndex
CREATE INDEX "CodeSitePermit_documentId_idx" ON "CodeSitePermit"("documentId");

-- CreateIndex
CREATE INDEX "CodeSitePermit_status_idx" ON "CodeSitePermit"("status");

-- CreateIndex
CREATE INDEX "CodeSitePermit_permitType_idx" ON "CodeSitePermit"("permitType");

-- CreateIndex
CREATE INDEX "CodeSiteDocumentReview_projectId_idx" ON "CodeSiteDocumentReview"("projectId");

-- CreateIndex
CREATE INDEX "CodeSiteDocumentReview_documentId_idx" ON "CodeSiteDocumentReview"("documentId");

-- CreateIndex
CREATE INDEX "CodeSiteDocumentReview_reviewerUserId_idx" ON "CodeSiteDocumentReview"("reviewerUserId");

-- CreateIndex
CREATE INDEX "CodeSiteDocumentReview_status_idx" ON "CodeSiteDocumentReview"("status");

-- CreateIndex
CREATE INDEX "CodeSiteDocumentReview_decision_idx" ON "CodeSiteDocumentReview"("decision");

-- CreateIndex
CREATE INDEX "CodeSiteRouteRevision_projectId_idx" ON "CodeSiteRouteRevision"("projectId");

-- CreateIndex
CREATE INDEX "CodeSiteRouteRevision_executionPlanId_idx" ON "CodeSiteRouteRevision"("executionPlanId");

-- CreateIndex
CREATE INDEX "CodeSiteRouteRevision_documentId_idx" ON "CodeSiteRouteRevision"("documentId");

-- CreateIndex
CREATE INDEX "CodeSiteRouteRevision_status_idx" ON "CodeSiteRouteRevision"("status");

-- CreateIndex
CREATE INDEX "CodeSiteRouteRevision_createdAt_idx" ON "CodeSiteRouteRevision"("createdAt");

-- AddForeignKey
ALTER TABLE "CodeSitePermit" ADD CONSTRAINT "CodeSitePermit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteDocumentReview" ADD CONSTRAINT "CodeSiteDocumentReview_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteDocumentReview" ADD CONSTRAINT "CodeSiteDocumentReview_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CodeSiteDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteRouteRevision" ADD CONSTRAINT "CodeSiteRouteRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteRouteRevision" ADD CONSTRAINT "CodeSiteRouteRevision_executionPlanId_fkey" FOREIGN KEY ("executionPlanId") REFERENCES "CodeSiteExecutionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSiteRouteRevision" ADD CONSTRAINT "CodeSiteRouteRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CodeSiteDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
