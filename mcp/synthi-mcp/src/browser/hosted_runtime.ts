import { randomUUID } from "node:crypto";
import type { BrowserBroker, BrowserRuntimeAttachment } from "./broker.js";
import type { BrowserTab } from "./types.js";

export interface HostedBrowserRuntimeInput {
  tenant_id?: string;
  workspace_id?: string;
  actor_id?: string;
  workspace_url?: string;
  runtime_id?: string;
  runtime_session_id?: string;
  open_workspace?: boolean;
}

export interface HostedBrowserRuntimeConfig {
  configured: boolean;
  tenant_id: string | null;
  workspace_id: string;
  actor_id: string | null;
  workspace_url: string | null;
  runtime_id: string | null;
  runtime_session_id: string | null;
  adapter: "hosted-playwright-cdp" | "not-configured";
  required_env: string[];
  ignored_local_dev_env: string[];
  origin_allowlist: string[];
  session_ttl_ms: number | null;
  local_network_allowed: boolean;
  redact_screenshots: boolean;
  product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser";
}

export interface HostedBrowserAttachDeps {
  attach(cdpUrl: string): Promise<BrowserTab[]>;
  listTabs(): Promise<BrowserTab[]>;
  open(url: string): Promise<BrowserTab>;
  setWorkflowOverlayEnabled?(enabled: boolean): void;
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
} | {
  ok: false;
  error: "hosted_runtime_origin_not_allowed";
  runtime: HostedBrowserRuntimeConfig;
  workspace_origin: string | null;
  allowed_origins: string[];
};

interface HostedBrowserRuntimeResolvedConfig extends HostedBrowserRuntimeConfig {
  cdpUrl: string | null;
}

const HOSTED_CDP_ENV = "SYNTHI_HOSTED_BROWSER_CDP_URL";
const TENANT_ID_ENV = "SYNTHI_TENANT_ID";
const WORKSPACE_ID_ENV = "SYNTHI_WORKSPACE_ID";
const AGENT_ID_ENV = "SYNTHI_AGENT_ID";
const ACTOR_ID_ENV = "SYNTHI_ACTOR_ID";
const WORKSPACE_URL_ENV = "SYNTHI_WORKSPACE_URL";
const HOSTED_WORKSPACE_URL_ENV = "SYNTHI_HOSTED_BROWSER_WORKSPACE_URL";
const RUNTIME_ID_ENV = "SYNTHI_HOSTED_BROWSER_RUNTIME_ID";
const RUNTIME_SESSION_ID_ENV = "SYNTHI_HOSTED_BROWSER_SESSION_ID";
const ORIGIN_ALLOWLIST_ENV = "SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST";
const SESSION_TTL_MS_ENV = "SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS";
const ALLOW_LOCAL_NETWORK_ENV = "SYNTHI_HOSTED_BROWSER_ALLOW_LOCAL_NETWORK";
const REDACT_SCREENSHOTS_ENV = "SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS";

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
  const workspaceOrigin = originForUrl(config.workspace_url);
  if (config.origin_allowlist.length > 0 && (!workspaceOrigin || !config.origin_allowlist.includes(workspaceOrigin))) {
    return {
      ok: false,
      error: "hosted_runtime_origin_not_allowed",
      runtime: publicConfig(config),
      workspace_origin: workspaceOrigin,
      allowed_origins: config.origin_allowlist,
    };
  }

  deps.setWorkflowOverlayEnabled?.(true);
  let allTabs = await deps.attach(config.cdpUrl);
  let openedWorkspaceUrl: string | null = null;
  if (config.workspace_url && input.open_workspace !== false) {
    await deps.open(config.workspace_url);
    openedWorkspaceUrl = config.workspace_url;
    allTabs = await deps.listTabs();
  }

  const runtime = broker.setRuntimeAttachment({
    kind: "hosted",
    tenant_id: config.tenant_id,
    workspace_id: config.workspace_id,
    actor_id: config.actor_id,
    runtime_id: config.runtime_id,
    session_id: config.runtime_session_id ?? `hosted_session_${randomUUID()}`,
    workspace_url: config.workspace_url,
    adapter: config.adapter,
    expires_at: config.session_ttl_ms ? Date.now() + config.session_ttl_ms : null,
    origin_allowlist: config.origin_allowlist,
    egress_policy: {
      local_network_allowed: config.local_network_allowed,
    },
    redaction_policy: {
      screenshots: config.redact_screenshots,
    },
  });
  allTabs = await deps.listTabs();
  const tabs = broker.registerTabs(allTabs);
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
  const tenantId = nonEmpty(input.tenant_id) ?? nonEmpty(env[TENANT_ID_ENV]) ?? null;
  const workspaceId = nonEmpty(input.workspace_id) ?? nonEmpty(env[WORKSPACE_ID_ENV]) ?? "default";
  const actorId = nonEmpty(input.actor_id) ?? nonEmpty(env[AGENT_ID_ENV]) ?? nonEmpty(env[ACTOR_ID_ENV]) ?? null;
  const workspaceUrl = nonEmpty(input.workspace_url) ?? nonEmpty(env[WORKSPACE_URL_ENV]) ?? nonEmpty(env[HOSTED_WORKSPACE_URL_ENV]) ?? null;
  const runtimeId = nonEmpty(input.runtime_id) ?? nonEmpty(env[RUNTIME_ID_ENV]) ?? null;
  const runtimeSessionId = nonEmpty(input.runtime_session_id) ?? nonEmpty(env[RUNTIME_SESSION_ID_ENV]) ?? null;
  const ignoredLocalDevEnv = nonEmpty(env["SYNTHI_BROWSER_CDP_URL"]) ? ["SYNTHI_BROWSER_CDP_URL"] : [];
  const originAllowlist = parseOriginAllowlist(env[ORIGIN_ALLOWLIST_ENV]);
  return {
    configured: Boolean(cdpUrl),
    cdpUrl: cdpUrl ?? null,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    actor_id: actorId,
    workspace_url: workspaceUrl,
    runtime_id: runtimeId,
    runtime_session_id: runtimeSessionId,
    adapter: cdpUrl ? "hosted-playwright-cdp" : "not-configured",
    required_env: [HOSTED_CDP_ENV],
    ignored_local_dev_env: ignoredLocalDevEnv,
    origin_allowlist: originAllowlist,
    session_ttl_ms: parsePositiveInteger(env[SESSION_TTL_MS_ENV]),
    local_network_allowed: parseBoolean(env[ALLOW_LOCAL_NETWORK_ENV]),
    redact_screenshots: env[REDACT_SCREENSHOTS_ENV] === undefined ? true : parseBoolean(env[REDACT_SCREENSHOTS_ENV]),
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

export function parseOriginAllowlist(value: unknown): string[] {
  const raw = typeof value === "string" ? value : "";
  const origins = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => originForUrl(item))
    .filter((item): item is string => Boolean(item));
  return [...new Set(origins)].sort();
}

function originForUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parsePositiveInteger(value: unknown): number | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value: unknown): boolean {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
