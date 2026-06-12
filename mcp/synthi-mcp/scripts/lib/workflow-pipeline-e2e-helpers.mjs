export function freshMcpProcessEnv({
  baseEnv = process.env,
  privateWorkflowStoreEnv,
  cdpUrl,
  previewUrl,
  workspaceId,
}) {
  const env = {
    ...baseEnv,
    ...privateWorkflowStoreEnv,
    SYNTHI_HOSTED_BROWSER_CDP_URL: cdpUrl,
    SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: previewUrl,
    SYNTHI_WORKSPACE_ID: workspaceId,
    SYNTHI_AGENT_ID: "workflow_pipeline_fresh_mcp_acceptance",
  };
  delete env.SYNTHI_BROWSER_CDP_URL;
  return env;
}
