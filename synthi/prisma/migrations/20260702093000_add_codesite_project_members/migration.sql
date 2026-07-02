CREATE TABLE "CodeSiteProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permissionsJson" TEXT NOT NULL,
    "redactionPolicyJson" TEXT,
    "participationStatus" TEXT NOT NULL DEFAULT 'enabled',
    "source" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeSiteProjectMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeSiteProjectMember_projectId_userId_key" ON "CodeSiteProjectMember"("projectId", "userId");
CREATE INDEX "CodeSiteProjectMember_workspaceSlug_userId_idx" ON "CodeSiteProjectMember"("workspaceSlug", "userId");
CREATE INDEX "CodeSiteProjectMember_projectId_idx" ON "CodeSiteProjectMember"("projectId");
CREATE INDEX "CodeSiteProjectMember_role_idx" ON "CodeSiteProjectMember"("role");
CREATE INDEX "CodeSiteProjectMember_projectId_revokedAt_idx" ON "CodeSiteProjectMember"("projectId", "revokedAt");

ALTER TABLE "CodeSiteProjectMember" ADD CONSTRAINT "CodeSiteProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CodeSiteProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "CodeSiteProjectMember" (
    "id",
    "projectId",
    "workspaceSlug",
    "userId",
    "role",
    "permissionsJson",
    "redactionPolicyJson",
    "participationStatus",
    "source",
    "createdByUserId",
    "createdAt",
    "updatedAt"
)
SELECT
    'cspm_creator_' || p."id",
    p."id",
    p."workspaceSlug",
    p."createdByUserId",
    'owner',
    '["project:read","project:write","project:members:manage","mayday:declare","mayday:resume","mayday:override_resume"]',
    NULL,
    'enabled',
    'project_creator_backfill',
    p."createdByUserId",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "CodeSiteProject" p
WHERE p."createdByUserId" IS NOT NULL
ON CONFLICT ("projectId", "userId") DO NOTHING;

INSERT INTO "CodeSiteProjectMember" (
    "id",
    "projectId",
    "workspaceSlug",
    "userId",
    "role",
    "permissionsJson",
    "redactionPolicyJson",
    "participationStatus",
    "source",
    "createdByUserId",
    "createdAt",
    "updatedAt"
)
SELECT
    'cspm_agent_' || s."id",
    s."projectId",
    p."workspaceSlug",
    s."ownerUserId",
    'agent',
    '["project:read","agent:own","document:file","mayday:declare"]',
    s."redactionPolicyJson",
    'enabled',
    'agent_session_backfill',
    p."createdByUserId",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "CodeSiteAgentSession" s
JOIN "CodeSiteProject" p ON p."id" = s."projectId"
WHERE s."ownerUserId" IS NOT NULL
ON CONFLICT ("projectId", "userId") DO NOTHING;
