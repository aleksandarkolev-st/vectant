-- Durable lifecycle evidence for a published fleet NOTAM. Do not alter the
-- original federation migration: installations that already applied it need a
-- forward-only upgrade path for withdrawal and supersession.

ALTER TABLE "CodeSiteFleetNotam"
    ADD COLUMN "supersedesNotamId" TEXT,
    ADD COLUMN "supersededByNotamId" TEXT,
    ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3),
    ADD COLUMN "lifecycleChangedBy" TEXT,
    ADD COLUMN "lifecycleReason" TEXT;

CREATE INDEX "CodeSiteFleetNotam_supersededByNotamId_idx"
    ON "CodeSiteFleetNotam"("supersededByNotamId");
