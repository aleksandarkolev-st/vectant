ALTER TABLE "LocalSupportPolicyState" ADD COLUMN "orgId" TEXT;

CREATE UNIQUE INDEX "LocalSupportPolicyState_orgId_key" ON "LocalSupportPolicyState"("orgId");
