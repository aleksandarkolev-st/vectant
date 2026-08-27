ALTER TABLE "CodeSiteKnowledgeItem"
  ADD COLUMN "learningScope" TEXT NOT NULL DEFAULT 'project';

CREATE INDEX "CodeSiteKnowledgeItem_learningScope_kind_status_idx"
  ON "CodeSiteKnowledgeItem"("learningScope", "kind", "status");
