import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

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
    file: normalizeStoreFileReference(String(file || defaultFile)),
    key: String(key || defaultKey),
    scope: String(scope || defaultScope),
    external,
  };
}

export function privateToolStoreConformance({
  storeSpec,
  requireExternalStore = false,
  env = process.env,
  cwd = process.cwd(),
  tmpDir = os.tmpdir(),
  homeDir = os.homedir(),
  packageRoot = MCP_ROOT,
  repoRoot = REPO_ROOT,
} = {}) {
  const requireExternal = Boolean(requireExternalStore);
  const externalStore = storeSpec?.external === true;
  const location = privateToolStoreLocationConformance({
    file: storeSpec?.file,
    requireExternalStore: requireExternal,
    env,
    cwd,
    tmpDir,
    homeDir,
    packageRoot,
    repoRoot,
  });
  return {
    ok: !requireExternal || (externalStore && location.ok),
    require_external_private_tool_store: requireExternal,
    external_private_tool_store: externalStore,
    external_private_tool_store_location_ok: location.ok,
    external_private_tool_store_location_class: location.location_class,
    external_private_tool_store_location_reasons: location.reasons,
  };
}

export function privateToolStoreCustodyEvidence({ storeSpec, expectedScope } = {}) {
  const key = String(storeSpec?.key || "");
  const scope = String(storeSpec?.scope || "");
  const expected = String(expectedScope || scope || "");
  return {
    key_present: Boolean(key),
    key_fingerprint_alg: "sha256",
    key_sha256: key ? sha256String(key) : null,
    scope,
    expected_scope: expected || null,
    scope_matches_expected: Boolean(scope && expected && scope === expected),
  };
}

export function privateToolStoreCustodyExpectation({ storeSpec, expectedScope, expectedKeySha256 } = {}) {
  const scope = String(expectedScope || storeSpec?.scope || "");
  const configuredFingerprint = normalizeOptionalSha256(
    expectedKeySha256,
    "expected_private_tool_store_key_sha256",
  );
  const key = String(storeSpec?.key || "");
  return {
    key_fingerprint_alg: "sha256",
    key_sha256: configuredFingerprint || (key ? sha256String(key) : null),
    scope: scope || null,
  };
}

export function assertPrivateToolStoreConformance({ storeSpec, requireExternalStore }) {
  const conformance = privateToolStoreConformance({ storeSpec, requireExternalStore });
  if (!conformance.ok) {
    throw new Error("external_private_tool_store_required: pass --private-tool-store-file, --private-tool-store-key, --private-tool-store-scope, and --target-url before using this harness as a deployed saved-workflow conformance gate; the store file must not be under the repo, OS temp directory, or user home directory unless an approved external store root is configured");
  }
  return conformance;
}

export function privateToolStoreLocationConformance({
  file,
  requireExternalStore = false,
  env = process.env,
  cwd = process.cwd(),
  tmpDir = os.tmpdir(),
  homeDir = os.homedir(),
  packageRoot = MCP_ROOT,
  repoRoot = REPO_ROOT,
} = {}) {
  if (!requireExternalStore) {
    return {
      ok: true,
      location_class: "not_required",
      reasons: [],
    };
  }

  const rawFile = String(file || "").trim();
  if (!rawFile) {
    return {
      ok: false,
      location_class: "missing",
      reasons: ["private_tool_store_file_missing"],
    };
  }

  const remoteUriScheme = nonFileUriScheme(rawFile);
  if (remoteUriScheme) {
    return {
      ok: true,
      location_class: "remote_uri",
      reasons: [`remote_uri_scheme:${remoteUriScheme}`],
    };
  }

  const normalizedFile = normalizeFilePath(rawFile);
  const allowedRoots = parsePathList(
    env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_EXTERNAL_STORE_ALLOWED_ROOTS_JSON
      || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_EXTERNAL_STORE_ALLOWED_ROOTS
      || "",
  );
  if (allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => pathIsWithin(normalizedFile, root));
    return {
      ok: allowed,
      location_class: allowed ? "allowed_external_root" : "outside_allowed_external_roots",
      reasons: allowed
        ? ["store_file_under_allowed_external_root"]
        : ["store_file_not_under_allowed_external_root"],
    };
  }

  const disallowedRoots = uniquePaths([
    repoRoot,
    packageRoot,
    cwd,
    tmpDir,
    homeDir,
    ...parsePathList(env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_EXTERNAL_STORE_DISALLOWED_ROOTS_JSON
      || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_EXTERNAL_STORE_DISALLOWED_ROOTS
      || ""),
  ]);
  const matchedRoot = disallowedRoots.find((root) => pathIsWithin(normalizedFile, root));
  if (matchedRoot) {
    return {
      ok: false,
      location_class: "local_disallowed_root",
      reasons: [`store_file_under_disallowed_root:${redactPathForReason(matchedRoot)}`],
    };
  }

  return {
    ok: true,
    location_class: isNetworkPath(normalizedFile) ? "network_path" : "absolute_path",
    reasons: ["store_file_outside_default_local_roots"],
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

export function hostedRuntimePolicyEnv({ targetUrl, sessionTtlMs = 900_000 } = {}) {
  const origin = originForUrl(targetUrl);
  if (!origin) throw new Error("hosted_runtime_target_origin_required");
  const ttl = parseNonNegativeInteger(sessionTtlMs, "hosted_session_ttl_ms");
  if (ttl <= 0) throw new Error("hosted_session_ttl_ms_must_be_positive");
  return {
    SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: origin,
    SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS: String(ttl),
    SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS: "1",
  };
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

function originForUrl(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
}

function sha256String(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeOptionalSha256(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid: expected 64 lowercase or uppercase hex characters`);
  }
  return normalized;
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

function nonFileUriScheme(value) {
  const match = String(value).match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match) return "";
  return match[1].toLowerCase() === "file" ? "" : match[1].toLowerCase();
}

function normalizeFilePath(value) {
  const text = String(value || "");
  if (/^file:\/\//i.test(text)) {
    return path.resolve(fileURLToPath(text));
  }
  return path.resolve(text);
}

function normalizeStoreFileReference(value) {
  const text = String(value || "");
  return nonFileUriScheme(text) ? text : normalizeFilePath(text);
}

function parsePathList(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  let items;
  if (text.startsWith("[")) {
    try {
      items = JSON.parse(text);
    } catch {
      throw new Error("external_store_roots_json_invalid");
    }
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
      throw new Error("external_store_roots_json_must_be_string_array");
    }
  } else {
    items = text.split(path.delimiter);
  }
  return uniquePaths(items.map((item) => item.trim()).filter(Boolean));
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizePathForCompare(path.resolve(String(value)));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(String(value)));
  }
  return result;
}

function pathIsWithin(candidate, root) {
  const normalizedCandidate = normalizePathForCompare(path.resolve(candidate));
  const normalizedRoot = normalizePathForCompare(path.resolve(root));
  if (!normalizedCandidate || !normalizedRoot) return false;
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative)
    && !relative.startsWith("..")
    && !path.isAbsolute(relative);
}

function normalizePathForCompare(value) {
  const normalized = path.resolve(String(value || "")).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNetworkPath(value) {
  return String(value).startsWith("\\\\");
}

function redactPathForReason(value) {
  const normalized = String(value || "");
  if (path.resolve(normalized) === path.resolve(REPO_ROOT)) return "repo_root";
  if (path.resolve(normalized) === path.resolve(MCP_ROOT)) return "package_root";
  if (path.resolve(normalized) === path.resolve(os.homedir())) return "home";
  if (path.resolve(normalized) === path.resolve(os.tmpdir())) return "tmp";
  if (path.resolve(normalized) === path.resolve(process.cwd())) return "cwd";
  return "configured";
}
