import { resolveHostedBrowserRuntime } from "./hosted_runtime.js";
import { replayIsolationProfiles } from "./safety.js";
import {
  configuredDojoEvidenceLedgerEnv,
  configuredDojoExternalSigningEnv,
  configuredDojoStoreEnv,
  DOJO_EVIDENCE_LEDGER_STORE_ENV,
  DOJO_PRODUCTION_ENFORCEMENT_ENV,
  DOJO_PROOF_SIGNING_COMMAND_ENV,
  DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV,
  DOJO_PROOF_SIGNING_KEY_ENV,
  DOJO_PROOF_SIGNING_KEY_ID_ENV,
  DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV,
  DOJO_PROOF_SIGNING_PROVIDER_ENV,
  DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
  DOJO_REQUIRE_DURABLE_STORE_ENV,
  DOJO_REQUIRE_EVIDENCE_LEDGER_ENV,
  DOJO_REQUIRE_EXTERNAL_SIGNING_ENV,
  DOJO_STORE_FILE_ENV,
  DOJO_STORE_KEY_ENV,
  DOJO_STORE_SCOPE_ENV,
  isDojoDefaultLocalProofSigningKey,
  resolveDojoEnforcementConfig,
  type DojoEnforcementConfig,
} from "../dojo/config/enforcement.js";
import {
  configuredDojoMcpManifestSigningEnv,
  DOJO_MCP_MANIFEST_ISSUER_ENV,
  DOJO_MCP_MANIFEST_KEY_ID_ENV,
  DOJO_MCP_MANIFEST_SIGNING_KEY_ENV,
  isDojoDefaultMcpManifestSigningKey,
} from "../dojo/mcp/manifest_signing.js";

export type BrowserWorkflowDeploymentMode = "production" | "development";
export type BrowserWorkflowDeploymentCheckStatus = "pass" | "warn" | "fail";

export interface BrowserWorkflowDeploymentReadinessInput {
  mode?: BrowserWorkflowDeploymentMode;
  workspace_id?: string;
  require_workflow_bridge?: boolean;
}

export interface BrowserWorkflowDeploymentCheck {
  id: string;
  status: BrowserWorkflowDeploymentCheckStatus;
  message: string;
  required_env: string[];
  optional_env?: string[];
  configured_env?: string[];
}

export interface BrowserWorkflowDeploymentReadiness {
  schema_version: "synthi.browserWorkflowDeploymentReadiness.v1";
  ok: boolean;
  mode: BrowserWorkflowDeploymentMode;
  product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser";
  checks: BrowserWorkflowDeploymentCheck[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
  hosted_runtime: ReturnType<typeof resolveHostedBrowserRuntime>;
  dojo_enforcement: DojoEnforcementConfig;
  replay_isolation_profile: {
    workspace_id: string;
    readiness: string;
    can_run_full_mutation_replay: boolean;
    missing: string[];
  };
}

export function browserWorkflowDeploymentReadiness(
  input: BrowserWorkflowDeploymentReadinessInput = {},
  env: NodeJS.ProcessEnv = process.env
): BrowserWorkflowDeploymentReadiness {
  const mode: BrowserWorkflowDeploymentMode = input.mode === "development" ? "development" : "production";
  const production = mode === "production";
  const requireWorkflowBridge = input.require_workflow_bridge !== false;
  const workspaceId = nonEmpty(input.workspace_id) ?? nonEmpty(env["SYNTHI_WORKSPACE_ID"]);
  const hostedRuntime = resolveHostedBrowserRuntime({ workspace_id: workspaceId }, env);
  const dojoEnforcement = resolveDojoEnforcementConfig(env);
  const profile = replayIsolationProfiles.get(workspaceId);
  const checks: BrowserWorkflowDeploymentCheck[] = [];

  checks.push(checkHostedRuntime(hostedRuntime, env, production));
  checks.push(checkHostedRuntimeEndpointPolicy(hostedRuntime, production));
  checks.push(checkHostedRuntimeOriginPolicy(hostedRuntime, production));
  checks.push(checkHostedRuntimeSessionPolicy(hostedRuntime, production));
  checks.push(checkHostedRuntimeTenantPolicy(hostedRuntime, production));
  checks.push(checkWorkspaceScope(workspaceId, production));
  checks.push(checkStorePair({
    id: "private_workflow_tool_store",
    fileEnv: "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE",
    keyEnv: "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY",
    scopeEnv: "SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE",
    env,
    production,
    missingMessage: "Private workflow tools will be process-local unless an encrypted store file, key, and scope are configured.",
    partialMessage: "Private workflow tool store configuration is partial; file, key, and scope must be configured together.",
    readyMessage: "Private workflow tool store is encrypted, file-backed, and scoped.",
  }));
  checks.push(checkStorePair({
    id: "auth_checkpoint_store",
    fileEnv: "SYNTHI_AUTH_CHECKPOINT_STORE_FILE",
    keyEnv: "SYNTHI_AUTH_CHECKPOINT_STORE_KEY",
    scopeEnv: "SYNTHI_AUTH_CHECKPOINT_SCOPE",
    env,
    production,
    missingMessage: "Auth checkpoints will be process-local unless an encrypted store file, key, and scope are configured.",
    partialMessage: "Auth checkpoint store configuration is partial; file, key, and scope must be configured together.",
    readyMessage: "Auth checkpoint store is encrypted, file-backed, and scoped.",
  }));
  checks.push(checkWorkflowBridge(env, production, requireWorkflowBridge));
  checks.push(checkLocalCdpLeak(env, production));
  checks.push(...checkDojoProductionBoundary(dojoEnforcement, env, production));

  const summary = {
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: checks.filter((check) => check.status === "warn").length,
    failed: checks.filter((check) => check.status === "fail").length,
  };

  return {
    schema_version: "synthi.browserWorkflowDeploymentReadiness.v1",
    ok: summary.failed === 0,
    mode,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
    checks,
    summary,
    hosted_runtime: hostedRuntime,
    dojo_enforcement: dojoEnforcement,
    replay_isolation_profile: {
      workspace_id: profile.workspace_id,
      readiness: profile.readiness,
      can_run_full_mutation_replay: profile.can_run_full_mutation_replay,
      missing: [...profile.missing],
    },
  };
}

function checkDojoProductionBoundary(
  config: DojoEnforcementConfig,
  env: NodeJS.ProcessEnv,
  production: boolean
): BrowserWorkflowDeploymentCheck[] {
  const checks: BrowserWorkflowDeploymentCheck[] = [];
  if (config.invalid_env.length > 0) {
    checks.push({
      id: "dojo_enforcement_flag_values",
      status: "fail",
      message: `Dojo enforcement flags have invalid boolean values: ${config.invalid_env.map((item) => item.name).join(", ")}.`,
      required_env: [
        DOJO_PRODUCTION_ENFORCEMENT_ENV,
        DOJO_REQUIRE_DURABLE_STORE_ENV,
        DOJO_REQUIRE_EXTERNAL_SIGNING_ENV,
        DOJO_REQUIRE_EVIDENCE_LEDGER_ENV,
      ],
      configured_env: config.configured_env,
    });
    return checks;
  }

  checks.push(checkDojoProductionEnforcement(config, production));
  checks.push(checkDojoDurableStore(config, env, production));
  checks.push(checkDojoExternalSigning(config, env, production));
  checks.push(checkDojoMcpManifestSigning(env, production));
  checks.push(checkDojoEvidenceLedger(config, env, production));
  return checks;
}

function checkDojoProductionEnforcement(
  config: DojoEnforcementConfig,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  if (config.production_enforcement) {
    return pass(
      "dojo_production_enforcement",
      "Dojo production enforcement flag is enabled.",
      [DOJO_PRODUCTION_ENFORCEMENT_ENV],
      [DOJO_PRODUCTION_ENFORCEMENT_ENV]
    );
  }
  return {
    id: "dojo_production_enforcement",
    status: production ? "fail" : "warn",
    message: "Dojo production enforcement is disabled; published competencies may run under development compatibility semantics.",
    required_env: [DOJO_PRODUCTION_ENFORCEMENT_ENV],
    configured_env: [],
  };
}

function checkDojoDurableStore(
  config: DojoEnforcementConfig,
  env: NodeJS.ProcessEnv,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = [DOJO_REQUIRE_DURABLE_STORE_ENV, DOJO_STORE_FILE_ENV, DOJO_STORE_KEY_ENV, DOJO_STORE_SCOPE_ENV];
  const storeEnv = configuredDojoStoreEnv(env);
  const configured = [
    ...(config.require_durable_store ? [DOJO_REQUIRE_DURABLE_STORE_ENV] : []),
    ...storeEnv,
  ];
  if (config.require_durable_store && storeEnv.length === 3) {
    return pass("dojo_durable_store", "Dojo durable store is required and configured.", required, configured);
  }
  return {
    id: "dojo_durable_store",
    status: production ? "fail" : "warn",
    message: "Dojo durable store is not fully configured; production proof, license, and skill state must not be process-local.",
    required_env: required,
    configured_env: configured,
  };
}

function checkDojoExternalSigning(
  config: DojoEnforcementConfig,
  env: NodeJS.ProcessEnv,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = [
    DOJO_REQUIRE_EXTERNAL_SIGNING_ENV,
    DOJO_PROOF_SIGNING_PROVIDER_ENV,
    DOJO_PROOF_SIGNING_KEY_ID_ENV,
    DOJO_PROOF_SIGNING_KEY_ENV,
    DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV,
    DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
    DOJO_PROOF_SIGNING_COMMAND_ENV,
    DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV,
  ];
  const configured = [
    ...(config.require_external_signing ? [DOJO_REQUIRE_EXTERNAL_SIGNING_ENV] : []),
    ...configuredDojoExternalSigningEnv(env),
  ];
  const provider = nonEmpty(env[DOJO_PROOF_SIGNING_PROVIDER_ENV]);
  const keyId = nonEmpty(env[DOJO_PROOF_SIGNING_KEY_ID_ENV]);
  const command = nonEmpty(env[DOJO_PROOF_SIGNING_COMMAND_ENV]);
  const publicKey = nonEmpty(env[DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV]);
  const hasExternalCommandSigner = provider === "external-command"
    && keyId
    && command
    && publicKey;
  const hasExternalSigner = provider
    && provider !== "hmac-local"
    && provider !== "ed25519-local"
    && provider !== "external-command"
    && keyId
    && !isDojoDefaultLocalProofSigningKey(env);
  const hasEd25519Signer = provider === "ed25519-local"
    && keyId
    && nonEmpty(env[DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV])
    && publicKey;
  if (config.require_external_signing && (hasExternalCommandSigner || hasExternalSigner || hasEd25519Signer)) {
    return pass("dojo_external_signing", "Dojo proof signing is configured without the default local signing key.", required, configured);
  }
  return {
    id: "dojo_external_signing",
    status: production ? "fail" : "warn",
    message: "Dojo proof signing is not production-ready; external signer identity and a non-default signing key are required.",
    required_env: required,
    configured_env: configured,
  };
}

function checkDojoEvidenceLedger(
  config: DojoEnforcementConfig,
  env: NodeJS.ProcessEnv,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = [DOJO_REQUIRE_EVIDENCE_LEDGER_ENV, DOJO_EVIDENCE_LEDGER_STORE_ENV];
  const ledgerEnv = configuredDojoEvidenceLedgerEnv(env);
  const configured = [
    ...(config.require_evidence_ledger ? [DOJO_REQUIRE_EVIDENCE_LEDGER_ENV] : []),
    ...ledgerEnv,
  ];
  if (config.require_evidence_ledger && ledgerEnv.length === 1) {
    return pass(
      "dojo_evidence_ledger",
      "Dojo evidence ledger requirement is enabled and ledger store configuration is present.",
      required,
      configured
    );
  }
  return {
    id: "dojo_evidence_ledger",
    status: production ? "fail" : "warn",
    message: "Dojo evidence ledger is not configured; production proof claims cannot be treated as evidence-backed.",
    required_env: required,
    configured_env: configured,
  };
}

function checkDojoMcpManifestSigning(
  env: NodeJS.ProcessEnv,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = [
    DOJO_MCP_MANIFEST_ISSUER_ENV,
    DOJO_MCP_MANIFEST_KEY_ID_ENV,
    DOJO_MCP_MANIFEST_SIGNING_KEY_ENV,
  ];
  const configured = configuredDojoMcpManifestSigningEnv(env);
  const issuer = nonEmpty(env[DOJO_MCP_MANIFEST_ISSUER_ENV]);
  const keyId = nonEmpty(env[DOJO_MCP_MANIFEST_KEY_ID_ENV]);
  const hasNonDefaultSigningKey = !isDojoDefaultMcpManifestSigningKey(env);
  if (issuer && keyId && hasNonDefaultSigningKey) {
    return pass(
      "dojo_mcp_manifest_signing",
      "Dojo MCP skill manifests use an explicit issuer, key ID, and non-default signing key.",
      required,
      configured
    );
  }
  return {
    id: "dojo_mcp_manifest_signing",
    status: production ? "fail" : "warn",
    message: "Dojo MCP skill manifest signing is not production-ready; explicit issuer, key ID, and non-default signing key are required.",
    required_env: required,
    configured_env: configured,
  };
}

function checkHostedRuntime(
  runtime: ReturnType<typeof resolveHostedBrowserRuntime>,
  env: NodeJS.ProcessEnv,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = [
    "SYNTHI_HOSTED_BROWSER_CDP_URL",
    "SYNTHI_WORKSPACE_ID",
    "SYNTHI_HOSTED_BROWSER_WORKSPACE_URL or SYNTHI_WORKSPACE_URL",
  ];
  const configured = [
    ...(runtime.configured ? ["SYNTHI_HOSTED_BROWSER_CDP_URL"] : []),
    ...(nonEmpty(env["SYNTHI_WORKSPACE_ID"]) ? ["SYNTHI_WORKSPACE_ID"] : []),
    ...(nonEmpty(env["SYNTHI_HOSTED_BROWSER_WORKSPACE_URL"])
      ? ["SYNTHI_HOSTED_BROWSER_WORKSPACE_URL"]
      : nonEmpty(env["SYNTHI_WORKSPACE_URL"])
      ? ["SYNTHI_WORKSPACE_URL"]
      : []),
  ];
  const missing = [
    ...(!runtime.configured ? ["SYNTHI_HOSTED_BROWSER_CDP_URL"] : []),
    ...(!nonEmpty(env["SYNTHI_WORKSPACE_ID"]) ? ["SYNTHI_WORKSPACE_ID"] : []),
    ...(!runtime.workspace_url ? ["SYNTHI_HOSTED_BROWSER_WORKSPACE_URL or SYNTHI_WORKSPACE_URL"] : []),
  ];
  if (missing.length === 0) {
    return pass("hosted_browser_runtime", "Hosted browser runtime is configured for workspace attach.", required, configured);
  }
  return {
    id: "hosted_browser_runtime",
    status: production ? "fail" : "warn",
    message: `Hosted browser runtime is missing ${missing.join(", ")}.`,
    required_env: required,
    configured_env: configured,
  };
}

function checkHostedRuntimeEndpointPolicy(
  runtime: ReturnType<typeof resolveHostedBrowserRuntime>,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = ["SYNTHI_HOSTED_BROWSER_CDP_URL"];
  const configured = runtime.configured ? required : [];
  if (runtime.configured && runtime.non_loopback_runtime) {
    return pass("hosted_browser_runtime_endpoint", "Hosted runtime endpoint is non-loopback.", required, configured);
  }
  return {
    id: "hosted_browser_runtime_endpoint",
    status: production ? "fail" : "warn",
    message: runtime.configured
      ? `Hosted runtime endpoint is ${runtime.runtime_host_class}; production runtime sessions must use a non-loopback endpoint.`
      : "Hosted runtime endpoint is not configured.",
    required_env: required,
    configured_env: configured,
  };
}

function checkHostedRuntimeOriginPolicy(
  runtime: ReturnType<typeof resolveHostedBrowserRuntime>,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = ["SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST"];
  const workspaceOrigin = originForUrl(runtime.workspace_url);
  const configured = runtime.origin_allowlist.length > 0 ? required : [];
  if (workspaceOrigin && runtime.origin_allowlist.includes(workspaceOrigin)) {
    return pass("hosted_browser_origin_policy", "Hosted runtime origin allowlist includes the workspace origin.", required, configured);
  }
  return {
    id: "hosted_browser_origin_policy",
    status: production ? "fail" : "warn",
    message: runtime.origin_allowlist.length === 0
      ? "Hosted runtime origin allowlist is missing; production sessions must be origin-scoped."
      : `Hosted runtime origin allowlist does not include workspace origin ${workspaceOrigin ?? "unknown"}.`,
    required_env: required,
    configured_env: configured,
  };
}

function checkHostedRuntimeSessionPolicy(
  runtime: ReturnType<typeof resolveHostedBrowserRuntime>,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = ["SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS"];
  const configured = runtime.session_ttl_ms ? required : [];
  const maxTtlMs = 60 * 60 * 1000;
  if (runtime.session_ttl_ms && runtime.session_ttl_ms <= maxTtlMs) {
    return pass("hosted_browser_session_policy", "Hosted runtime sessions use short-lived credentials.", required, configured);
  }
  return {
    id: "hosted_browser_session_policy",
    status: production ? "fail" : "warn",
    message: runtime.session_ttl_ms
      ? "Hosted runtime session TTL exceeds the one-hour production maximum."
      : "Hosted runtime session TTL is missing; production credentials must be short-lived.",
    required_env: required,
    configured_env: configured,
  };
}

function checkHostedRuntimeTenantPolicy(
  runtime: ReturnType<typeof resolveHostedBrowserRuntime>,
  production: boolean
): BrowserWorkflowDeploymentCheck {
  const required = ["SYNTHI_TENANT_ID", "SYNTHI_AGENT_ID or SYNTHI_ACTOR_ID"];
  const configured = [
    ...(runtime.tenant_id ? ["SYNTHI_TENANT_ID"] : []),
    ...(runtime.actor_id ? ["SYNTHI_AGENT_ID or SYNTHI_ACTOR_ID"] : []),
  ];
  const missing = [
    ...(!runtime.tenant_id ? ["SYNTHI_TENANT_ID"] : []),
    ...(!runtime.actor_id ? ["SYNTHI_AGENT_ID or SYNTHI_ACTOR_ID"] : []),
  ];
  if (missing.length === 0) {
    return pass("hosted_browser_tenant_policy", "Hosted runtime sessions are tenant- and actor-scoped.", required, configured);
  }
  return {
    id: "hosted_browser_tenant_policy",
    status: production ? "fail" : "warn",
    message: `Hosted runtime session scope is missing ${missing.join(", ")}.`,
    required_env: required,
    configured_env: configured,
  };
}

function checkWorkspaceScope(workspaceId: string | undefined, production: boolean): BrowserWorkflowDeploymentCheck {
  if (workspaceId) {
    return pass("workspace_scope", "Workspace scope is configured for runtime and store isolation.", ["SYNTHI_WORKSPACE_ID"], ["SYNTHI_WORKSPACE_ID"]);
  }
  return {
    id: "workspace_scope",
    status: production ? "fail" : "warn",
    message: "Workspace scope is missing; deployment stores would fall back to default scope.",
    required_env: ["SYNTHI_WORKSPACE_ID"],
    configured_env: [],
  };
}

function checkStorePair(input: {
  id: string;
  fileEnv: string;
  keyEnv: string;
  scopeEnv: string;
  env: NodeJS.ProcessEnv;
  production: boolean;
  missingMessage: string;
  partialMessage: string;
  readyMessage: string;
}): BrowserWorkflowDeploymentCheck {
  const required = [input.fileEnv, input.keyEnv, input.scopeEnv];
  const configured = required.filter((name) => nonEmpty(input.env[name]));
  if (configured.length === required.length) return pass(input.id, input.readyMessage, required, configured);
  if (configured.length > 0) {
    return {
      id: input.id,
      status: "fail",
      message: input.partialMessage,
      required_env: required,
      configured_env: configured,
    };
  }
  return {
    id: input.id,
    status: input.production ? "fail" : "warn",
    message: input.missingMessage,
    required_env: required,
    configured_env: [],
  };
}

function checkWorkflowBridge(
  env: NodeJS.ProcessEnv,
  production: boolean,
  required: boolean
): BrowserWorkflowDeploymentCheck {
  const url = nonEmpty(env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL"]);
  const port = nonEmpty(env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT"]);
  const host = nonEmpty(env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST"]) ?? "127.0.0.1";
  const token = nonEmpty(env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN"]);
  const configuredEnv = [
    ...(url ? ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL"] : []),
    ...(port ? ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT"] : []),
    ...(nonEmpty(env["SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST"]) ? ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST"] : []),
    ...(token ? ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN"] : []),
  ];

  if (!url && !port) {
    return {
      id: "browser_workflow_bridge",
      status: production && required ? "fail" : "warn",
      message: "Workflow bridge is not configured; browser-injected Observe/Teach controls cannot reach MCP tools.",
      required_env: required ? ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL or SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT"] : [],
      optional_env: ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN"],
      configured_env: configuredEnv,
    };
  }

  if (!token && !isLoopbackBridge(url, host)) {
    return {
      id: "browser_workflow_bridge",
      status: production ? "fail" : "warn",
      message: "Non-loopback workflow bridge requires SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN.",
      required_env: ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN"],
      configured_env: configuredEnv,
    };
  }

  return pass("browser_workflow_bridge", "Workflow bridge is configured for browser-injected controls.", [], configuredEnv);
}

function checkLocalCdpLeak(env: NodeJS.ProcessEnv, production: boolean): BrowserWorkflowDeploymentCheck {
  const configured = nonEmpty(env["SYNTHI_BROWSER_CDP_URL"]) ? ["SYNTHI_BROWSER_CDP_URL"] : [];
  if (configured.length === 0) {
    return pass("local_cdp_env_absent", "Local CDP dev harness env is not present in this MCP process.", [], []);
  }
  return {
    id: "local_cdp_env_absent",
    status: production ? "fail" : "warn",
    message: "SYNTHI_BROWSER_CDP_URL is a local development harness env and should not be present in production hosted workflow deployments.",
    required_env: [],
    configured_env: configured,
  };
}

function pass(
  id: string,
  message: string,
  requiredEnv: string[],
  configuredEnv: string[]
): BrowserWorkflowDeploymentCheck {
  return { id, status: "pass", message, required_env: requiredEnv, configured_env: configuredEnv };
}

function isLoopbackBridge(url: string | undefined, host: string): boolean {
  if (url) {
    try {
      return isLoopbackHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }
  return isLoopbackHost(host);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function originForUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
