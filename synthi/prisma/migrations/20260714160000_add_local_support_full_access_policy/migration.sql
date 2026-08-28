ALTER TABLE "LocalSupportPolicyState"
ADD COLUMN "fullAccessPolicyJson" TEXT NOT NULL DEFAULT '{"enabled":false,"autoApproval":false,"processVisibility":false,"workspaceMutation":false,"commandExecution":false,"localPortDiscovery":false,"localPortUse":false}';
