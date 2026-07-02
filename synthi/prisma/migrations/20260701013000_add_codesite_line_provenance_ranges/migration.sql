ALTER TABLE "CodeSiteLineProvenance" ADD COLUMN "startLine" INTEGER;
ALTER TABLE "CodeSiteLineProvenance" ADD COLUMN "endLine" INTEGER;

CREATE INDEX "CodeSiteLineProvenance_filePath_startLine_endLine_idx"
  ON "CodeSiteLineProvenance"("filePath", "startLine", "endLine");
