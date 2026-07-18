ALTER TABLE "CodeSiteProofBundle" ADD COLUMN "proofSignatureJson" TEXT;
ALTER TABLE "CodeSiteProofBundle" ADD COLUMN "signatureKeyId" TEXT;
ALTER TABLE "CodeSiteProofBundle" ADD COLUMN "landingStatus" TEXT;

CREATE INDEX "CodeSiteProofBundle_signatureKeyId_idx" ON "CodeSiteProofBundle"("signatureKeyId");
