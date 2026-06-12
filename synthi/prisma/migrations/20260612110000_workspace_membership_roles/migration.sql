-- Add durable workspace membership roles.
ALTER TABLE "WorkspaceMembership" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'member';
ALTER TABLE "WorkspaceMembership" ADD COLUMN IF NOT EXISTS "invitedByEmail" TEXT;

-- Existing workspaces predate explicit roles. Treat the earliest membership
-- in each workspace as the owner so every workspace keeps one manager.
WITH first_memberships AS (
  SELECT DISTINCT ON ("workspaceId") "id"
  FROM "WorkspaceMembership"
  ORDER BY "workspaceId", "createdAt" ASC, "id" ASC
)
UPDATE "WorkspaceMembership"
SET "role" = 'owner'
WHERE "id" IN (SELECT "id" FROM first_memberships);
