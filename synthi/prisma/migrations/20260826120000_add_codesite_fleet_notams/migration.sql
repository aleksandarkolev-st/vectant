-- Cross-project learned-advisory federation: published fleet NOTAMs and
-- each subscribing project's independent local ingest decision.

CREATE TABLE "CodeSiteFleetNotam" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "sourcePolicyDeltaId" TEXT NOT NULL,
    "advisoryKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "affectedZoneKey" TEXT,
    "affectedRoutesJson" TEXT NOT NULL,
    "triggerConditionsJson" TEXT NOT NULL,
    "ruleCandidateJson" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "expectedRiskReduction" DOUBLE PRECISION,
    "digestSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteFleetNotam_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodeSiteNotamIngestState" (
    "id" TEXT NOT NULL,
    "notamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'unreviewed',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteNotamIngestState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeSiteFleetNotam_projectId_advisoryKey_key"
  ON "CodeSiteFleetNotam"("projectId", "advisoryKey");
CREATE INDEX "CodeSiteFleetNotam_status_expiresAt_idx"
  ON "CodeSiteFleetNotam"("status", "expiresAt");
CREATE INDEX "CodeSiteFleetNotam_workspaceSlug_idx"
  ON "CodeSiteFleetNotam"("workspaceSlug");
CREATE INDEX "CodeSiteFleetNotam_affectedZoneKey_idx"
  ON "CodeSiteFleetNotam"("affectedZoneKey");

CREATE UNIQUE INDEX "CodeSiteNotamIngestState_notamId_projectId_key"
  ON "CodeSiteNotamIngestState"("notamId", "projectId");
CREATE INDEX "CodeSiteNotamIngestState_projectId_state_idx"
  ON "CodeSiteNotamIngestState"("projectId", "state");

ALTER TABLE "CodeSiteFleetNotam" ADD CONSTRAINT "CodeSiteFleetNotam_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteNotamIngestState" ADD CONSTRAINT "CodeSiteNotamIngestState_notamId_fkey"
  FOREIGN KEY ("notamId") REFERENCES "CodeSiteFleetNotam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeSiteNotamIngestState" ADD CONSTRAINT "CodeSiteNotamIngestState_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
