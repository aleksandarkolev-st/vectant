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
  cdp_endpoint_source: "runtime-template" | "env-url" | "not-configured";
  cdp_topology: "same-pod" | "runtime-service" | "external" | "unspecified";
  runtime_host_class: "remote" | "loopback" | "local-bind" | "invalid";
  non_loopback_runtime: boolean;
  adapter: "hosted-playwright-cdp" | "not-configured";
  required_env: string[];
  ignored_local_dev_env: string[];
  cdp_header_names: string[];
  origin_allowlist: string[];
  session_ttl_ms: number | null;
  local_network_allowed: boolean;
  redact_screenshots: boolean;
  product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser";
}

export interface HostedBrowserAttachOptions {
  headers?: Record<string, string>;
}

export interface HostedBrowserAttachDeps {
  attach(cdpUrl: string, options?: HostedBrowserAttachOptions): Promise<BrowserTab[]>;
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
  cdpHeaders: Record<string, string>;
}

const HOSTED_CDP_ENV = "SYNTHI_HOSTED_BROWSER_CDP_URL";
const HOSTED_CDP_TARGET_TEMPLATE_ENV = "SYNTHI_HOSTED_BROWSER_CDP_TARGET_TEMPLATE";
const HOSTED_CDP_PORT_ENV = "SYNTHI_HOSTED_BROWSER_CDP_PORT";
const HOSTED_CDP_TOPOLOGY_ENV = "SYNTHI_HOSTED_BROWSER_CDP_TOPOLOGY";
const HOSTED_CDP_HEADERS_JSON_ENV = "SYNTHI_HOSTED_BROWSER_CDP_HEADERS_JSON";
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
  let allTabs = await deps.attach(config.cdpUrl, { headers: config.cdpHeaders });
  let openedWorkspaceTab: BrowserTab | null = null;
  let openedWorkspaceUrl: string | null = null;
  if (config.workspace_url && input.open_workspace !== false) {
    openedWorkspaceTab = await deps.open(config.workspace_url);
    openedWorkspaceUrl = config.workspace_url;
    allTabs = mergeTabsById(await deps.listTabs(), openedWorkspaceTab);
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
  allTabs = mergeTabsById(await deps.listTabs(), openedWorkspaceTab);
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

function mergeTabsById(tabs: BrowserTab[], openedTab: BrowserTab | null): BrowserTab[] {
  if (!openedTab) return tabs;
  const merged = new Map<string, BrowserTab>();
  for (const tab of tabs) merged.set(tab.tab_id, tab);
  merged.set(openedTab.tab_id, openedTab);
  return [...merged.values()];
}

function resolveHostedBrowserRuntimeInternal(
  input: HostedBrowserRuntimeInput,
  env: NodeJS.ProcessEnv
): HostedBrowserRuntimeResolvedConfig {
  const tenantId = nonEmpty(input.tenant_id) ?? nonEmpty(env[TENANT_ID_ENV]) ?? null;
  const workspaceId = nonEmpty(input.workspace_id) ?? nonEmpty(env[WORKSPACE_ID_ENV]) ?? "default";
  const actorId = nonEmpty(input.actor_id) ?? nonEmpty(env[AGENT_ID_ENV]) ?? nonEmpty(env[ACTOR_ID_ENV]) ?? null;
  const workspaceUrl = nonEmpty(input.workspace_url) ?? nonEmpty(env[WORKSPACE_URL_ENV]) ?? nonEmpty(env[HOSTED_WORKSPACE_URL_ENV]) ?? null;
  const runtimeId = nonEmpty(input.runtime_id) ?? nonEmpty(env[RUNTIME_ID_ENV]) ?? null;
  const runtimeSessionId = nonEmpty(input.runtime_session_id) ?? nonEmpty(env[RUNTIME_SESSION_ID_ENV]) ?? null;
  const templatedCdpUrl = renderHostedRuntimeCdpTemplate({
    template: nonEmpty(env[HOSTED_CDP_TARGET_TEMPLATE_ENV]),
    runtime_id: runtimeId,
    runtime_session_id: runtimeSessionId,
    workspace_id: workspaceId,
    tenant_id: tenantId,
    cdp_port: nonEmpty(env[HOSTED_CDP_PORT_ENV]) ?? "9222",
  });
  const cdpUrl = templatedCdpUrl ?? nonEmpty(env[HOSTED_CDP_ENV]);
  const cdpHeaders = parseCdpHeaders(env[HOSTED_CDP_HEADERS_JSON_ENV]);
  const runtimeHostClass = classifyRuntimeEndpoint(cdpUrl);
  const ignoredLocalDevEnv = nonEmpty(env["SYNTHI_BROWSER_CDP_URL"]) ? ["SYNTHI_BROWSER_CDP_URL"] : [];
  const originAllowlist = parseOriginAllowlist(env[ORIGIN_ALLOWLIST_ENV]);
  const cdpEndpointSource = templatedCdpUrl
    ? "runtime-template"
    : cdpUrl
    ? "env-url"
    : "not-configured";
  return {
    configured: Boolean(cdpUrl),
    cdpUrl: cdpUrl ?? null,
    cdpHeaders,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    actor_id: actorId,
    workspace_url: workspaceUrl,
    runtime_id: runtimeId,
    runtime_session_id: runtimeSessionId,
    cdp_endpoint_source: cdpEndpointSource,
    cdp_topology: normalizeCdpTopology(env[HOSTED_CDP_TOPOLOGY_ENV]),
    runtime_host_class: runtimeHostClass,
    non_loopback_runtime: runtimeHostClass === "remote",
    adapter: cdpUrl ? "hosted-playwright-cdp" : "not-configured",
    required_env: [`${HOSTED_CDP_ENV} or ${HOSTED_CDP_TARGET_TEMPLATE_ENV}`],
    ignored_local_dev_env: ignoredLocalDevEnv,
    cdp_header_names: Object.keys(cdpHeaders).sort(),
    origin_allowlist: originAllowlist,
    session_ttl_ms: parsePositiveInteger(env[SESSION_TTL_MS_ENV]),
    local_network_allowed: parseBoolean(env[ALLOW_LOCAL_NETWORK_ENV]),
    redact_screenshots: env[REDACT_SCREENSHOTS_ENV] === undefined ? true : parseBoolean(env[REDACT_SCREENSHOTS_ENV]),
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
  };
}

function publicConfig(config: HostedBrowserRuntimeResolvedConfig): HostedBrowserRuntimeConfig {
  const { cdpUrl: _cdpUrl, cdpHeaders: _cdpHeaders, ...publicFields } = config;
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

function normalizeCdpTopology(value: unknown): HostedBrowserRuntimeConfig["cdp_topology"] {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "same-pod" || raw === "runtime-service" || raw === "external") return raw;
  return "unspecified";
}

function renderHostedRuntimeCdpTemplate(input: {
  template?: string;
  runtime_id: string | null;
  runtime_session_id: string | null;
  workspace_id: string;
  tenant_id: string | null;
  cdp_port: string;
}): string | null {
  const template = nonEmpty(input.template);
  if (!template) return null;
  const runtimeId = safeDnsLabel(input.runtime_id);
  if (template.includes("{runtimeId}") && !runtimeId) return null;
  const cdpPort = safePort(input.cdp_port);
  if (template.includes("{cdpPort}") && !cdpPort) return null;
  const rendered = template
    .replaceAll("{runtimeId}", runtimeId ?? "")
    .replaceAll("{runtimeSessionId}", encodeURIComponent(input.runtime_session_id ?? ""))
    .replaceAll("{workspaceId}", encodeURIComponent(input.workspace_id))
    .replaceAll("{tenantId}", encodeURIComponent(input.tenant_id ?? ""))
    .replaceAll("{cdpPort}", cdpPort ?? "");
  return nonEmpty(rendered) ?? null;
}

function safeDnsLabel(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  return /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(raw) ? raw : null;
}

function safePort(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? String(parsed) : null;
}

function parseCdpHeaders(value: unknown): Record<string, string> {
  const raw = nonEmpty(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(parsed)) {
      const headerName = String(name || "").trim();
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) continue;
      if (typeof headerValue !== "string") continue;
      headers[headerName] = headerValue;
    }
    return headers;
  } catch {
    return {};
  }
}

function classifyRuntimeEndpoint(value: unknown): HostedBrowserRuntimeConfig["runtime_host_class"] {
  const raw = nonEmpty(value);
  if (!raw) return "invalid";
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]") return "loopback";
    if (host === "0.0.0.0" || host === "::" || host === "[::]") return "local-bind";
    return "remote";
  } catch {
    return "invalid";
  }
}
