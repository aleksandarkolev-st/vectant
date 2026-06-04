import type { BrowserBroker, BrowserRuntimeAttachment } from "./broker.js";
import type { BrowserTab } from "./types.js";

export interface HostedBrowserRuntimeInput {
  workspace_id?: string;
  workspace_url?: string;
  runtime_id?: string;
  open_workspace?: boolean;
}

export interface HostedBrowserRuntimeConfig {
  configured: boolean;
  workspace_id: string;
  workspace_url: string | null;
  runtime_id: string | null;
  adapter: "hosted-playwright-cdp" | "not-configured";
  required_env: string[];
  ignored_local_dev_env: string[];
  product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser";
}

export interface HostedBrowserAttachDeps {
  attach(cdpUrl: string): Promise<BrowserTab[]>;
  listTabs(): Promise<BrowserTab[]>;
  open(url: string): Promise<BrowserTab>;
}

export type HostedBrowserAttachResult = {
  ok: true;
  runtime: BrowserRuntimeAttachment;
  tabs: BrowserTab[];
  hidden_tabs: number;
  opened_workspace_url: string | null;
  consent_required_for: string | null;
  permission_tiers: string[];
} | {
  ok: false;
  error: "hosted_runtime_not_configured";
  runtime: HostedBrowserRuntimeConfig;
};

interface HostedBrowserRuntimeResolvedConfig extends HostedBrowserRuntimeConfig {
  cdpUrl: string | null;
}

const HOSTED_CDP_ENV = "SYNTHI_HOSTED_BROWSER_CDP_URL";
const WORKSPACE_ID_ENV = "SYNTHI_WORKSPACE_ID";
const WORKSPACE_URL_ENV = "SYNTHI_WORKSPACE_URL";
const HOSTED_WORKSPACE_URL_ENV = "SYNTHI_HOSTED_BROWSER_WORKSPACE_URL";
const RUNTIME_ID_ENV = "SYNTHI_HOSTED_BROWSER_RUNTIME_ID";

export function resolveHostedBrowserRuntime(
  input: HostedBrowserRuntimeInput = {},
  env: NodeJS.ProcessEnv = process.env
): HostedBrowserRuntimeConfig {
  return publicConfig(resolveHostedBrowserRuntimeInternal(input, env));
}

export async function attachHostedBrowserRuntime(
  input: HostedBrowserRuntimeInput,
  deps: HostedBrowserAttachDeps,
  broker: BrowserBroker,
  env: NodeJS.ProcessEnv = process.env
): Promise<HostedBrowserAttachResult> {
  const config = resolveHostedBrowserRuntimeInternal(input, env);
  if (!config.cdpUrl) {
    return { ok: false, error: "hosted_runtime_not_configured", runtime: publicConfig(config) };
  }

  let allTabs = await deps.attach(config.cdpUrl);
  let openedWorkspaceUrl: string | null = null;
  if (config.workspace_url && input.open_workspace !== false) {
    await deps.open(config.workspace_url);
    openedWorkspaceUrl = config.workspace_url;
    allTabs = await deps.listTabs();
  }

  const tabs = broker.registerTabs(allTabs);
  const runtime = broker.setRuntimeAttachment({
    kind: "hosted",
    workspace_id: config.workspace_id,
    runtime_id: config.runtime_id,
    workspace_url: config.workspace_url,
    adapter: config.adapter,
  });
  return {
    ok: true,
    runtime,
    tabs,
    hidden_tabs: allTabs.length - tabs.length,
    opened_workspace_url: openedWorkspaceUrl,
    consent_required_for: config.workspace_url,
    permission_tiers: ["attached", "origin_consent", "snapshot", "teach", "control"],
  };
}

function resolveHostedBrowserRuntimeInternal(
  input: HostedBrowserRuntimeInput,
  env: NodeJS.ProcessEnv
): HostedBrowserRuntimeResolvedConfig {
  const cdpUrl = nonEmpty(env[HOSTED_CDP_ENV]);
  const workspaceId = nonEmpty(input.workspace_id) ?? nonEmpty(env[WORKSPACE_ID_ENV]) ?? "default";
  const workspaceUrl = nonEmpty(input.workspace_url) ?? nonEmpty(env[WORKSPACE_URL_ENV]) ?? nonEmpty(env[HOSTED_WORKSPACE_URL_ENV]) ?? null;
  const runtimeId = nonEmpty(input.runtime_id) ?? nonEmpty(env[RUNTIME_ID_ENV]) ?? null;
  const ignoredLocalDevEnv = nonEmpty(env["SYNTHI_BROWSER_CDP_URL"]) ? ["SYNTHI_BROWSER_CDP_URL"] : [];
  return {
    configured: Boolean(cdpUrl),
    cdpUrl: cdpUrl ?? null,
    workspace_id: workspaceId,
    workspace_url: workspaceUrl,
    runtime_id: runtimeId,
    adapter: cdpUrl ? "hosted-playwright-cdp" : "not-configured",
    required_env: [HOSTED_CDP_ENV],
    ignored_local_dev_env: ignoredLocalDevEnv,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
  };
}

function publicConfig(config: HostedBrowserRuntimeResolvedConfig): HostedBrowserRuntimeConfig {
  const { cdpUrl: _cdpUrl, ...publicFields } = config;
  return publicFields;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
