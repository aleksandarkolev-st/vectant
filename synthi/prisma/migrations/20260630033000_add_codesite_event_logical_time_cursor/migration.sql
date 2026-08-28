CREATE INDEX IF NOT EXISTS "CodeSiteEvent_projectId_logicalTime_idx"
  ON "CodeSiteEvent"("projectId", "logicalTime");

CREATE UNIQUE INDEX IF NOT EXISTS "CodeSiteEvent_projectId_logicalTime_key"
  ON "CodeSiteEvent"("projectId", "logicalTime");
