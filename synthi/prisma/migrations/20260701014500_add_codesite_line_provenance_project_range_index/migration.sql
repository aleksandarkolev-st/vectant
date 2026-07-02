CREATE INDEX "CodeSiteLineProvenance_projectId_filePath_startLine_endLine_idx"
  ON "CodeSiteLineProvenance"("projectId", "filePath", "startLine", "endLine");
