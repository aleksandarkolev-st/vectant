import path from "node:path";
import { hostedRuntimePolicyEnv } from "../private-tool-acceptance-conformance.mjs";

export {
  parseBooleanFlag,
  parseJsonObjectArgument,
  privateToolStoreLocationConformance,
  privateToolStoreConformance,
  privateToolStoreCustodyExpectation,
  privateToolStoreCustodyEvidence,
  resolvePrivateToolStoreSpec,
  runtimeEndpointConformance,
} from "../private-tool-acceptance-conformance.mjs";

export const DEFAULT_CODEX_ACCEPTANCE_MODEL = "gpt-5.3-codex-spark";
export const CODEX_ACCEPTANCE_DISABLED_FEATURES = ["image_generation", "apps", "plugins", "shell_tool"];

export function buildCodexConfigToml({
  codexReasoning,
  codexModel,
  distIndex,
  mcpCommandSpec,
  storeFile,
  storeKey,
  storeScope,
  cdpUrl,
  targetUrl,
  workspaceId,
  hostedSessionTtlMs = 900_000,
}) {
  const hostedPolicy = hostedRuntimePolicyEnv({ targetUrl, sessionTtlMs: hostedSessionTtlMs });
  const mcpCommand = mcpCommandSpec ?? resolveCodexMcpServerCommandSpec({
    args: {},
    env: {},
    defaultCommand: "node",
    defaultArgs: [distIndex],
    defaultCwd: defaultMcpCwdForDistIndex(distIndex),
  });
  const config = [
    `model_reasoning_effort = ${JSON.stringify(codexReasoning || "low")}`,
    "",
    "[mcp_servers.synthi]",
    `command = ${JSON.stringify(mcpCommand.command)}`,
    `args = [${mcpCommand.args.map((item) => JSON.stringify(item)).join(", ")}]`,
    ...(mcpCommand.explicit_cwd ? [`cwd = ${JSON.stringify(mcpCommand.cwd)}`] : []),
    "",
    "[mcp_servers.synthi.env]",
    `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE = ${JSON.stringify(storeFile)}`,
    `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY = ${JSON.stringify(storeKey)}`,
    `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE = ${JSON.stringify(storeScope)}`,
    `SYNTHI_HOSTED_BROWSER_CDP_URL = ${JSON.stringify(cdpUrl)}`,
    `SYNTHI_HOSTED_BROWSER_WORKSPACE_URL = ${JSON.stringify(targetUrl)}`,
    `SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST = ${JSON.stringify(hostedPolicy.SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST)}`,
    `SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS = ${JSON.stringify(hostedPolicy.SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS)}`,
    `SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS = ${JSON.stringify(hostedPolicy.SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS)}`,
    `SYNTHI_WORKSPACE_ID = ${JSON.stringify(workspaceId)}`,
    'SYNTHI_AGENT_ID = "codex_private_tool_acceptance"',
    "",
  ];
  if (codexModel) {
    config.unshift(`model = ${JSON.stringify(codexModel)}`);
  }
  return config.join("\n");
}

export function resolveCodexMcpServerCommandSpec({
  args = {},
  env = process.env,
  defaultCommand = "node",
  defaultArgs = [],
  defaultCwd = process.cwd(),
} = {}) {
  const commandRaw = args["mcp-command"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_COMMAND;
  const explicitCommand = Boolean(commandRaw);
  const command = String(commandRaw || defaultCommand).trim();
  if (!command) throw new Error("mcp_command_required");
  const argsJson = args["mcp-args-json"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_ARGS_JSON;
  const explicitArgs = Boolean(argsJson);
  const commandArgs = argsJson
    ? parseMcpCommandArgsJson(argsJson)
    : explicitCommand
    ? []
    : [...defaultArgs];
  const cwdRaw = args["mcp-cwd"] || env.SYNTHI_PRIVATE_TOOL_ACCEPTANCE_MCP_CWD;
  const explicitCwd = Boolean(cwdRaw);
  const cwd = path.resolve(String(explicitCwd ? cwdRaw : defaultCwd));
  return {
    command,
    args: commandArgs,
    cwd,
    explicit_command: explicitCommand,
    explicit_args: explicitArgs,
    explicit_cwd: explicitCwd,
    default_repo_dist: command === defaultCommand
      && commandArgs.length === defaultArgs.length
      && commandArgs.every((item, index) => item === defaultArgs[index])
      && cwd === path.resolve(defaultCwd),
  };
}

export function codexMcpCommandConformance({ commandSpec, requireCustomCommand = false }) {
  const customMcpCommand = commandSpec?.default_repo_dist === false;
  const explicitMcpCommandSpec = commandSpec?.explicit_command === true
    && commandSpec?.explicit_args === true
    && commandSpec?.explicit_cwd === true;
  const requireCustom = Boolean(requireCustomCommand);
  return {
    ok: !requireCustom || (customMcpCommand && explicitMcpCommandSpec),
    require_custom_mcp_command: requireCustom,
    custom_mcp_command: customMcpCommand,
    explicit_mcp_command: commandSpec?.explicit_command === true,
    explicit_mcp_args: commandSpec?.explicit_args === true,
    explicit_mcp_cwd: commandSpec?.explicit_cwd === true,
    explicit_mcp_command_spec: explicitMcpCommandSpec,
  };
}

export function buildCodexAcceptancePrompt({ targetUrl, requestedToolName = "", toolArgs = {} } = {}) {
  const toolSelection = requestedToolName
    ? `Call synthi_browser_list_private_tools first. Find the returned tool whose tool_name is exactly ${JSON.stringify(requestedToolName)}. That exact value is the private workflow MCP tool you must call directly.`
    : "Call synthi_browser_list_private_tools first. Read the returned tools[0].tool_name value. That exact value is the private workflow MCP tool you must call directly.";
  const toolArgsJson = JSON.stringify(toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs) ? toolArgs : {});
  return [
    "Use Synthi MCP tools only. Do not use shell commands. Do not read generated scripts or local files.",
    "A saved Synthi app workflow private tool is available as a dynamic MCP tool with a synthi_app_ prefix.",
    "The private workflow tool name returned by synthi_browser_list_private_tools may not appear in static tool help, but it is callable by that exact returned MCP tool name in this session.",
    toolSelection,
    "Attach to the hosted browser with synthi_browser_attach_current_workspace, request screenshot consent for the exact target URL, and open the exact target URL.",
    "Do not call synthi_browser_begin_teach. Do not record a new workflow. Do not use synthi_browser_action to manually click the page. Do not call observe/resource tools as a substitute for the private workflow call. Do not ask for user input.",
    `After the target URL is open and consent is granted, your next MCP call must be the discovered synthi_app_* private workflow tool with this JSON argument object: ${toolArgsJson}.`,
    "Only after that private workflow tool returns ok=true with replay.steps_run > 0, reply exactly as: WORKFLOW_DONE <tool_name_you_called>.",
    `Target URL: ${targetUrl}`,
  ].join("\n");
}

export function codexExecArgs({ codexWorkdir, prompt }) {
  const disabledFeatureArgs = CODEX_ACCEPTANCE_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-rules",
    ...disabledFeatureArgs,
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    codexWorkdir,
    prompt,
  ];
}

export function extractCodexMcpEvidence({ events, toolName, targetUrl }) {
  const completedCalls = events
    .map((event) => event?.item)
    .filter((item) => item?.type === "mcp_tool_call" && item.status === "completed");
  const commandExecutions = events
    .map((event) => event?.item)
    .filter((item) => item?.type === "command_execution")
    .map((item) => ({
      status: item.status ?? null,
      exit_code: item.exit_code ?? null,
      command: redactCommandForEvidence(item.command),
    }));
  const privateToolCall = toolName
    ? completedCalls.find((item) => item.tool === toolName)
    : completedCalls.find((item) => typeof item.tool === "string" && item.tool.startsWith("synthi_app_"));
  const privateToolResult = privateToolCall?.result?.structured_content;
  const privateToolCalledName = privateToolCall?.tool ?? null;
  const consentCall = completedCalls.find((item) => item.tool === "synthi_browser_request_consent"
    && sameUrl(String(item.arguments?.url ?? ""), targetUrl));
  const openCall = completedCalls.find((item) => item.tool === "synthi_browser_open"
    && sameUrl(String(item.arguments?.url ?? ""), targetUrl));
  const hostedAttachCall = completedCalls.find((item) => item.tool === "synthi_browser_attach_current_workspace");
  const hostedAttachOpenedTarget = hostedAttachCall
    && sameUrl(String(hostedAttachCall.result?.structured_content?.opened_workspace_url ?? ""), targetUrl);
  const localAttachCall = completedCalls.find((item) => item.tool === "synthi_browser_attach");
  return {
    attach_call: Boolean(hostedAttachCall),
    hosted_attach_call: Boolean(hostedAttachCall),
    local_attach_call: Boolean(localAttachCall),
    consent_call: Boolean(consentCall),
    open_call: Boolean(openCall) || Boolean(hostedAttachOpenedTarget),
    opened_by_hosted_attach: Boolean(hostedAttachOpenedTarget),
    private_tool_call: Boolean(privateToolCall),
    private_tool_called_name: privateToolCalledName,
    private_tool_result_ok: privateToolResult?.ok === true
      && privateToolResult?.private_tool?.tool_name === privateToolCalledName,
    private_tool_steps_run: Number(privateToolResult?.replay?.steps_run ?? 0),
    private_tool_status: privateToolResult?.replay?.status ?? null,
    command_execution_count: commandExecutions.length,
    command_executions: commandExecutions,
  };
}

export async function findPageForVisualProof({ pages, targetUrl }) {
  const sameOriginCandidates = [];
  for (const page of pages) {
    const pageUrl = page.url();
    const exact = sameUrl(pageUrl, targetUrl);
    if (!exact && !sameOrigin(pageUrl, targetUrl)) continue;
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const match = { page, text, url: pageUrl, match: exact ? "exact-url" : "same-origin" };
    if (exact) return match;
    sameOriginCandidates.push(match);
  }
  return sameOriginCandidates[0] ?? null;
}

export async function findPageWithText({ pages, targetUrl, expectedText }) {
  const sameOriginCandidates = [];
  for (const page of pages) {
    const pageUrl = page.url();
    const exact = sameUrl(pageUrl, targetUrl);
    if (!exact && !sameOrigin(pageUrl, targetUrl)) continue;
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (!text.includes(expectedText)) continue;
    const match = { page, text, url: pageUrl, match: exact ? "exact-url" : "same-origin" };
    if (exact) return match;
    sameOriginCandidates.push(match);
  }
  return sameOriginCandidates[0] ?? null;
}

export function visualProofScreenshotOptions({ path: screenshotPath, timeoutMs }) {
  return {
    path: screenshotPath,
    fullPage: false,
    timeout: Math.min(Math.max(Number(timeoutMs) || 30_000, 5_000), 60_000),
  };
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

export function buildCodexProcessEnv({ baseEnv = process.env, codexHome }) {
  const env = { ...baseEnv, CODEX_HOME: codexHome };
  delete env.SYNTHI_BROWSER_CDP_URL;
  return env;
}

function sameUrl(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.toString() === right.toString();
  } catch {
    return a === b;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function redactCommandForEvidence(command) {
  return typeof command === "string" && command.trim() ? "[redacted-command]" : null;
}

function defaultMcpCwdForDistIndex(distIndex) {
  return distIndex
    ? path.resolve(path.dirname(distIndex), "..")
    : process.cwd();
}

function parseMcpCommandArgsJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error("mcp_args_json_invalid");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("mcp_args_json_must_be_string_array");
  }
  return parsed;
}
