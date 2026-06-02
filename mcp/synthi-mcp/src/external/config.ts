export interface ExternalConfig {
  apiUrl: string;
  pat: string;
  workspaceSlug?: string;
}

/** Read external-tools config from env. Returns null (feature off) unless apiUrl AND pat are set. */
export function readExternalConfig(env: NodeJS.ProcessEnv = process.env): ExternalConfig | null {
  const apiUrl = env["SYNTHI_API_URL"]?.trim();
  const pat = env["SYNTHI_PAT"]?.trim();
  if (!apiUrl || !pat) return null;
  const workspaceSlug = env["SYNTHI_WORKSPACE_SLUG"]?.trim();
  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    pat,
    ...(workspaceSlug ? { workspaceSlug } : {}),
  };
}
