ALTER TABLE IF EXISTS "McpCallAudit"
  ADD COLUMN IF NOT EXISTS "codeSiteProjectId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteMutationLeaseId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteAgentSessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteEvidenceRefsJson" TEXT;

ALTER TABLE IF EXISTS "ProgramRuntimeEvent"
  ADD COLUMN IF NOT EXISTS "codeSiteProjectId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteMutationLeaseId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteAgentSessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSiteEvidenceRefsJson" TEXT;

ALTER TABLE "CodeSiteAgentSession"
  ADD COLUMN IF NOT EXISTS "dojoPilotLicenseRef" TEXT,
  ADD COLUMN IF NOT EXISTS "dojoProofRef" TEXT,
  ADD COLUMN IF NOT EXISTS "dojoEvidenceRefsJson" TEXT,
  ADD COLUMN IF NOT EXISTS "dojoDecisionDigest" TEXT,
  ADD COLUMN IF NOT EXISTS "pilotLicenseSnapshotJson" TEXT;

DO $$
BEGIN
  IF to_regclass('"McpCallAudit"') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "McpCallAudit_codeSiteProjectId_idx" ON "McpCallAudit"("codeSiteProjectId");
    CREATE INDEX IF NOT EXISTS "McpCallAudit_codeSiteTransactionId_idx" ON "McpCallAudit"("codeSiteTransactionId");
    CREATE INDEX IF NOT EXISTS "McpCallAudit_codeSiteMutationLeaseId_idx" ON "McpCallAudit"("codeSiteMutationLeaseId");
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"ProgramRuntimeEvent"') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "ProgramRuntimeEvent_codeSiteProjectId_idx" ON "ProgramRuntimeEvent"("codeSiteProjectId");
    CREATE INDEX IF NOT EXISTS "ProgramRuntimeEvent_codeSiteTransactionId_idx" ON "ProgramRuntimeEvent"("codeSiteTransactionId");
    CREATE INDEX IF NOT EXISTS "ProgramRuntimeEvent_codeSiteMutationLeaseId_idx" ON "ProgramRuntimeEvent"("codeSiteMutationLeaseId");
  END IF;
END $$;
