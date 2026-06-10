import path from "node:path";

export function parseBooleanFlag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

export function selectPrivateToolForAcceptance({ tools, requestedToolName = "", seededToolName = "" }) {
  const privateTools = Array.isArray(tools)
    ? tools.filter((tool) => typeof tool?.name === "string" && tool.name.startsWith("synthi_app_"))
    : [];
  const preferredName = String(requestedToolName || seededToolName || "").trim();
  if (preferredName) {
    const tool = privateTools.find((candidate) => candidate.name === preferredName);
    if (!tool) {
      throw new Error(`private_workflow_tool_not_found: ${preferredName}`);
    }
    return tool;
  }
  if (privateTools.length === 1) return privateTools[0];
  if (privateTools.length === 0) {
    throw new Error(`private_workflow_tool_missing: no synthi_app_* tools were advertised in tools/list (${Array.isArray(tools) ? tools.length : 0} total tools)`);
  }
  throw new Error(`private_workflow_tool_ambiguous: pass --tool-name or set SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TOOL_NAME (${privateTools.map((tool) => tool.name).join(", ")})`);
}

export function resolvePrivateToolStoreSpec({
  args = {},
  env = process.env,
  defaultFile,
  defaultKey,
  defaultScope,
} = {}) {
  const file = args["private-tool-store-file"]
    || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_PRIVATE_TOOL_STORE_FILE
    || env.SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE
    || "";
  const key = args["private-tool-store-key"]
    || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_PRIVATE_TOOL_STORE_KEY
    || env.SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY
    || "";
  const scope = args["private-tool-store-scope"]
    || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_PRIVATE_TOOL_STORE_SCOPE
    || env.SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE
    || "";
  const external = Boolean(file || key || scope);
  if (external && (!file || !key || !scope)) {
    throw new Error("private_tool_store_config_incomplete: provide file, key, and scope for an external private workflow store");
  }
  return {
    file: path.resolve(String(file || defaultFile)),
    key: String(key || defaultKey),
    scope: String(scope || defaultScope),
    external,
  };
}

export function parseJsonObjectArgument(value, label = "json_object_argument") {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`${label}_invalid_json`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}_must_be_object`);
  }
  return parsed;
}

export function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

export function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label}_must_be_non_negative_integer`);
  }
  return parsed;
}

export function runtimeEndpointConformance({ cdpUrl, requireNonLoopbackRuntime = false }) {
  const requireNonLoopback = Boolean(requireNonLoopbackRuntime);
  const host = extractUrlHost(cdpUrl);
  const hostClass = classifyRuntimeHost(host);
  return {
    ok: !requireNonLoopback || (Boolean(host) && hostClass === "remote"),
    require_non_loopback_runtime: requireNonLoopback,
    non_loopback_runtime: Boolean(host) && hostClass === "remote",
    runtime_host_class: hostClass,
  };
}

export function assertRuntimeEndpointConformance({ cdpUrl, requireNonLoopbackRuntime }) {
  const conformance = runtimeEndpointConformance({ cdpUrl, requireNonLoopbackRuntime });
  if (!conformance.ok) {
    throw new Error("non_loopback_runtime_required: pass a non-loopback SYNTHI_HOSTED_BROWSER_CDP_URL before using this harness as a production hosted-runtime conformance gate");
  }
  return conformance;
}

function extractUrlHost(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return null;
  }
}

function classifyRuntimeHost(host) {
  if (!host) return "invalid";
  if (isLoopbackHost(host)) return "loopback";
  if (isLocalBindHost(host)) return "local-bind";
  return "remote";
}

function isLoopbackHost(host) {
  const normalized = String(host).toLowerCase();
  return normalized === "localhost"
    || normalized.startsWith("127.")
    || normalized === "::1"
    || normalized === "[::1]";
}

function isLocalBindHost(host) {
  const normalized = String(host).toLowerCase();
  return normalized === "0.0.0.0"
    || normalized === "::"
    || normalized === "[::]";
}
