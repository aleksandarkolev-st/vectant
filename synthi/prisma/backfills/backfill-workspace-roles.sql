-- Backfill: WorkspaceMembership.role (Plan 1a addendum R1-9)
--
-- Context: this project applies schema with `prisma db push` (no migrations dir),
-- and `db push` does NOT run data migrations. After pushing the schema that adds
-- `WorkspaceMembership.role String @default("member")`, every existing row defaults
-- to 'member'. Run this ONCE to promote the original creator of each workspace.
--
-- Heuristic: Workspace has no creatorId, so the earliest membership (min createdAt,
-- id as a deterministic tiebreak) per workspace is the pragmatic creator proxy.
--
-- Apply (Postgres):
--   psql "$DATABASE_URL" -f synthi/prisma/backfills/backfill-workspace-roles.sql
--
-- Idempotent: only promotes when a workspace has no 'owner' yet, so re-running is safe
-- and will not clobber roles assigned later (e.g. an admin transferring ownership).

UPDATE "WorkspaceMembership" wm
SET "role" = 'owner'
WHERE wm."id" IN (
  SELECT DISTINCT ON (m."workspaceId") m."id"
  FROM "WorkspaceMembership" m
  ORDER BY m."workspaceId", m."createdAt" ASC, m."id" ASC
)
AND NOT EXISTS (
  SELECT 1 FROM "WorkspaceMembership" o
  WHERE o."workspaceId" = wm."workspaceId" AND o."role" = 'owner'
);
