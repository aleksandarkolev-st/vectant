import path from "node:path";
import { fileURLToPath } from "node:url";

export {
  parseBooleanFlag,
  parseJsonObjectArgument,
  privateToolStoreConformance,
  resolvePrivateToolStoreSpec,
  runtimeEndpointConformance,
  selectPrivateToolForAcceptance,
} from "../private-tool-acceptance-conformance.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "../..");
const DIST_INDEX = path.join(MCP_ROOT, "dist", "index.js");

export function strictHostValidateToolArgs(schema, args) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["schema_not_object"];
  const errors = [];
  if (schema.type !== "object") errors.push("schema_type_not_object");
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item) => typeof item === "string")
    : [];
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) errors.push(`missing_required:${name}`);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) errors.push(`additional_property:${name}`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property || typeof property !== "object" || Array.isArray(property)) continue;
    if (property.type === "string" && typeof value !== "string") errors.push(`type:${name}`);
    if (property.type === "boolean" && typeof value !== "boolean") errors.push(`type:${name}`);
    if (property.type === "number" && typeof value !== "number") errors.push(`type:${name}`);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) errors.push(`enum:${name}`);
    if (typeof property.pattern === "string" && typeof value === "string") {
      const pattern = new RegExp(property.pattern);
      if (!pattern.test(value)) errors.push(`pattern:${name}`);
    }
  }
  return errors;
}

export function selectCdpTargetsToClose(targets) {
  if (!Array.isArray(targets)) return [];
  const pageTargets = targets.filter((target) => (
    target
    && typeof target.id === "string"
    && (target.type === "page" || target.type === "webview")
  ));
  if (pageTargets.length <= 1) return [];
  return pageTargets.slice(1);
}

export function resolveMcpServerCommandSpec({
  args = {},
  env = process.env,
  defaultCommand = process.execPath,
  defaultArgs = [DIST_INDEX],
  defaultCwd = MCP_ROOT,
} = {}) {
  const hasCustomCommand = Boolean(args["mcp-command"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND);
  const command = String(args["mcp-command"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND || defaultCommand).trim();
  if (!command) throw new Error("mcp_command_required");
  const argsJson = args["mcp-args-json"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON;
  const commandArgs = argsJson
    ? parseMcpCommandArgsJson(argsJson)
    : hasCustomCommand
    ? []
    : [...defaultArgs];
  const cwdRaw = args["mcp-cwd"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD || defaultCwd;
  const cwd = path.resolve(String(cwdRaw));
  return {
    command,
    args: commandArgs,
    cwd,
    default_repo_dist: command === defaultCommand
      && commandArgs.length === defaultArgs.length
      && commandArgs.every((item, index) => item === defaultArgs[index])
      && cwd === path.resolve(defaultCwd),
  };
}

export function mcpCommandConformance({ commandSpec, requireCustomCommand = false }) {
  const customMcpCommand = commandSpec?.default_repo_dist === false;
  const requireCustom = Boolean(requireCustomCommand);
  return {
    ok: !requireCustom || customMcpCommand,
    require_custom_mcp_command: requireCustom,
    custom_mcp_command: customMcpCommand,
  };
}

export function buildStdioMcpEnv({ baseEnv = process.env, ...overrides }) {
  const env = { ...baseEnv, ...overrides };
  delete env.SYNTHI_BROWSER_CDP_URL;
  return env;
}

export function stdioAcceptanceAttachEvidence({ attachResult }) {
  const runtimeKind = attachResult?.parsed?.runtime?.kind ?? null;
  return {
    hosted_attach: attachResult?.parsed?.ok === true && runtimeKind === "hosted",
    local_attach: runtimeKind === "local-dev-cdp",
    runtime_kind: runtimeKind,
    product_path: "agent_client_to_synthi_mcp_to_broker_to_hosted_browser",
  };
}

function parseMcpCommandArgsJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("mcp_args_json_invalid");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("mcp_args_json_must_be_string_array");
  }
  return parsed;
}
