#!/usr/bin/env node

require("dotenv").config();

// ── PERF: Cluster mode ─────────────────────────────────────────────────────
// Spawn one worker per CPU core so that WS→HTTP proxy work is distributed.
// Each worker gets its own WebSocket server; the OS load-balances incoming
// TCP connections across workers via SO_REUSEPORT / round-robin.
const cluster = require("cluster");
const os = require("os");

const CLUSTER_ENABLED =
  String(process.env.GATEWAY_CLUSTER || "true").toLowerCase() !== "false";
const WORKER_COUNT =
  parseInt(process.env.GATEWAY_WORKERS, 10) || os.cpus().length;

if (CLUSTER_ENABLED && cluster.isPrimary) {
  console.info(
    `[Gateway] Primary ${process.pid} spawning ${WORKER_COUNT} workers`
  );
  for (let i = 0; i < WORKER_COUNT; i++) cluster.fork();
  cluster.on("exit", (worker, code) => {
    console.warn(
      `[Gateway] Worker ${worker.process.pid} exited (code ${code}), restarting…`
    );
    cluster.fork();
  });
} else {
  // ── Worker (or single-process if clustering disabled) ──────────────────

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { fetch } = require("undici");

const gatewayPort = parseInt(process.env.GATEWAY_PORT || "7070", 10);
const websocketPath = process.env.GATEWAY_WS_PATH || "/ws";
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8000";
const backendStaticAnalyzeUrl = new URL("/analyze/static", backendUrl).toString();
const backendAiAnalyzeUrl = new URL("/analyze/ai", backendUrl).toString();
const backendProactiveAnalyzeUrl = new URL("/analyze/proactive", backendUrl).toString();
const backendProactiveQuickUrl = new URL("/analyze/proactive/quick", backendUrl).toString();
const backendContainerAnalyzeUrl = new URL("/analyze/container", backendUrl).toString();
const backendUnifiedAnalyzeUrl = new URL("/analyze/unified", backendUrl).toString();
// Workspace-level analysis endpoints
const backendWorkspaceAnalyzeUrl = new URL("/analyze/workspace", backendUrl).toString();
const backendWorkspaceIncrementalUrl = new URL("/analyze/workspace/incremental", backendUrl).toString();

// Self-healing endpoints
const backendHealAnalyzeUrl = new URL("/heal/analyze", backendUrl).toString();
const backendHealApplyUrl = new URL("/heal/apply", backendUrl).toString();
const backendHealContainerUrl = new URL("/heal/container", backendUrl).toString();
const backendHealConfigUrl = new URL("/heal/config", backendUrl).toString();
const backendHealStatsUrl = new URL("/heal/stats", backendUrl).toString();
const backendHealRulesUrl = new URL("/heal/rules", backendUrl).toString();
const backendHealBatchUrl = new URL("/heal/batch", backendUrl).toString();
const backendHealCacheStatsUrl = new URL("/heal/cache/stats", backendUrl).toString();
const backendHealPresetsUrl = new URL("/heal/presets", backendUrl).toString();
const backendHealPresetApplyUrl = new URL("/heal/preset", backendUrl).toString();
const backendHealMetricsUrl = new URL("/heal/metrics", backendUrl).toString();

// AI Agent endpoints
const backendAIAnalyzeUrl = new URL("/heal/ai/analyze", backendUrl).toString();
const backendAIBatchUrl = new URL("/heal/ai/batch", backendUrl).toString();
const backendAIHybridUrl = new URL("/heal/ai/hybrid", backendUrl).toString();
const backendAIStatsUrl = new URL("/heal/ai/stats", backendUrl).toString();
const backendAIFeedbackUrl = new URL("/heal/ai/feedback", backendUrl).toString();
const backendAIMemoryUrl = new URL("/heal/ai/memory", backendUrl).toString();
const backendAIStreamUrl = new URL("/heal/ai/stream", backendUrl).toString();
const backendAIProjectUrl = new URL("/heal/ai/project", backendUrl).toString();
const backendAIConfigUrl = new URL("/heal/ai/config", backendUrl).toString();
const backendAIHealthUrl = new URL("/heal/ai/health", backendUrl).toString();
const backendAIRuntimeUrl = new URL("/heal/ai/runtime", backendUrl).toString();
const backendAICacheClearUrl = new URL("/heal/ai/cache/clear", backendUrl).toString();
const backendAIPreviewUrl = new URL("/heal/ai/preview", backendUrl).toString();
const backendAIPolicySuppressUrl = new URL("/heal/ai/policy/suppress", backendUrl).toString();
const backendAIPolicyUnsuppressUrl = new URL("/heal/ai/policy/unsuppress", backendUrl).toString();
const backendAIPolicyListUrl = new URL("/heal/ai/policy", backendUrl).toString();
const backendHealRuleTranslateUrl = new URL("/heal/rule/translate", backendUrl).toString();

// Agentic self-healing endpoints
const backendAgenticDiagnoseUrl = new URL("/heal/agentic/diagnose", backendUrl).toString();
const backendAgenticEpisodeCreateUrl = new URL("/heal/agentic/episode/create", backendUrl).toString();
const backendAgenticEpisodesUrl = new URL("/heal/agentic/episodes", backendUrl).toString();
const backendAgenticPolicyEvalUrl = new URL("/heal/agentic/policy/evaluate", backendUrl).toString();
const backendAgenticPolicyStatusUrl = new URL("/heal/agentic/policy/status", backendUrl).toString();
const backendAgenticVerifyUrl = new URL("/heal/agentic/verify", backendUrl).toString();
const backendAgenticGuardrailsUrl = new URL("/heal/agentic/guardrails", backendUrl).toString();
const backendAgenticTelemetryCalUrl = new URL("/heal/agentic/telemetry/calibration", backendUrl).toString();
const backendAgenticTelemetryDegUrl = new URL("/heal/agentic/telemetry/degrading", backendUrl).toString();
const backendAgenticRuntimeIngestUrl = new URL("/heal/agentic/runtime/ingest", backendUrl).toString();
const backendAgenticRuntimeStatsUrl = new URL("/heal/agentic/runtime/stats", backendUrl).toString();
const backendAgenticObsErrorUrl = new URL("/heal/agentic/observability/error", backendUrl).toString();
const backendAgenticObsBuildUrl = new URL("/heal/agentic/observability/build", backendUrl).toString();
const backendAgenticObsHmrUrl = new URL("/heal/agentic/observability/hmr-failure", backendUrl).toString();
const backendAgenticObsStatsUrl = new URL("/heal/agentic/observability/stats", backendUrl).toString();
const backendAgenticObsTriggersUrl = new URL("/heal/agentic/observability/triggers", backendUrl).toString();
const backendAgenticCanaryCreateUrl = new URL("/heal/agentic/canary/create", backendUrl).toString();
const backendAgenticCanaryListUrl = new URL("/heal/agentic/canary", backendUrl).toString();
const backendAgenticCanaryStatsUrl = new URL("/heal/agentic/canary/stats", backendUrl).toString();
const backendAgenticStatusUrl = new URL("/heal/agentic/status", backendUrl).toString();

const server = http.createServer(handleHttpRequest);
const wss = new WebSocketServer({
  server,
  path: websocketPath,
});

wss.on("connection", (socket, request) => {
  const clientId = crypto.randomUUID();
  console.info("WS connected", { clientId, ip: request.socket.remoteAddress });

  // ── PERF: Per-connection rate limiting ──────────────────────────────────
  // Prevents a misbehaving client from flooding the AI engine.
  const RATE_WINDOW_MS = 1000;
  const MAX_MESSAGES_PER_WINDOW = 20;      // matches AI engine STATIC lane concurrency
  const MAX_IN_FLIGHT = 5;                 // matches AI_ANALYZE lane
  let msgTimestamps = [];
  let inFlightCount = 0;
  socket._inFlightAnalysis = new Map();     // key → AbortController for supersede

  safeSend(socket, {
    type: "system",
    event: "connected",
    clientId,
  });

  socket.on("message", (raw) => {
    // Rate check: sliding window
    const now = Date.now();
    msgTimestamps = msgTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (msgTimestamps.length >= MAX_MESSAGES_PER_WINDOW) {
      sendError(socket, "Rate limit exceeded — max " + MAX_MESSAGES_PER_WINDOW + " msg/s", {});
      return;
    }
    msgTimestamps.push(now);

    // In-flight concurrency cap
    if (inFlightCount >= MAX_IN_FLIGHT) {
      sendError(socket, "Too many in-flight requests — max " + MAX_IN_FLIGHT, {});
      return;
    }

    inFlightCount++;
    handleClientMessage(socket, raw)
      .catch((err) => {
        console.error("Handler error", err);
        sendError(socket, "Internal gateway error", { detail: err.message });
      })
      .finally(() => { inFlightCount--; });
  });

  socket.on("close", (code, reason) => {
    console.info("WS closed", {
      clientId,
      code,
      reason: reason.toString(),
    });
  });

  socket.on("error", (err) => {
    console.error("WS error", { clientId, err });
  });
});

server.listen(gatewayPort, '0.0.0.0', () => {
  console.info(
    `Gateway listening on port ${gatewayPort} (WS path ${websocketPath})`
  );
  console.info('[Gateway DEBUG] Listening on 0.0.0.0 for WSL connectivity');
});

function handleHttpRequest(req, res) {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/gateway/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        backend: backendUrl,
      })
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: "not-found",
    })
  );
}

// Redact api key fields from a JSON-ish payload string before logging it.
const API_KEY_REDACT_RE = /("(?:apiKey|api_key)"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
function redactApiKeys(text) {
  return text.replace(API_KEY_REDACT_RE, '$1"[REDACTED]"');
}

async function handleClientMessage(socket, raw) {
  const payloadText = raw.toString("utf8").trim();
  if (process.env.GATEWAY_DEBUG_LOG_PAYLOADS === "1") {
    console.log(`[Gateway DEBUG] Received from client: ${redactApiKeys(payloadText).substring(0, 200)}...`);
  }
  if (!payloadText) {
    sendError(socket, "Empty payload received");
    return;
  }

  let message;
  try {
    message = JSON.parse(payloadText);
  } catch (err) {
    sendError(socket, "Payload must be valid JSON");
    return;
  }

  const { action, requestId, data } = message || {};

  if (!action) {
    sendError(socket, "Missing `action` field", { requestId });
    return;
  }

  switch (action) {
    case "analyze/static":
      await forwardAnalyzeRequest(socket, data, requestId, false);
      break;
    case "analyze/ai":
      await forwardAnalyzeRequest(socket, data, requestId, true);
      break;
    case "analyze/proactive":
      await forwardProactiveAnalysis(socket, data, requestId);
      break;
    case "analyze/proactive/quick":
      await forwardProactiveQuickAnalysis(socket, data, requestId);
      break;
    case "analyze/container":
      await forwardContainerAnalysis(socket, data, requestId);
      break;
    case "analyze/unified":
      await forwardUnifiedAnalysis(socket, data, requestId);
      break;
    case "analyze/workspace":
      await forwardWorkspaceAnalysis(socket, data, requestId);
      break;
    case "analyze/workspace/incremental":
      await forwardWorkspaceIncrementalAnalysis(socket, data, requestId);
      break;
    case "heal/analyze":
      await forwardHealAnalyze(socket, data, requestId);
      break;
    case "heal/apply":
      await forwardHealApply(socket, data, requestId);
      break;
    case "heal/container":
      await forwardHealContainer(socket, data, requestId);
      break;
    case "heal/config":
      await forwardHealConfig(socket, data, requestId);
      break;
    case "heal/stats":
      await forwardHealStats(socket, requestId);
      break;
    case "heal/rules":
      await forwardHealRules(socket, requestId);
      break;
    case "heal/batch":
      await forwardHealBatch(socket, data, requestId);
      break;
    case "heal/cache/stats":
      await forwardHealCacheStats(socket, requestId);
      break;
    case "heal/presets":
      await forwardHealPresets(socket, requestId);
      break;
    case "heal/preset":
      await forwardHealPresetApply(socket, data, requestId);
      break;
    case "heal/metrics":
      await forwardHealMetrics(socket, requestId);
      break;
    case "heal/ai/analyze":
      await forwardAIAnalyze(socket, data, requestId);
      break;
    case "heal/ai/runtime":
      await forwardAIRuntime(socket, data, requestId);
      break;
    case "heal/ai/batch":
      await forwardAIBatch(socket, data, requestId);
      break;
    case "heal/ai/hybrid":
      await forwardAIHybrid(socket, data, requestId);
      break;
    case "heal/rule/translate":
      await forwardHealRuleTranslate(socket, data, requestId);
      break;
    case "heal/ai/stats":
      await forwardAIStats(socket, requestId);
      break;
    case "heal/ai/feedback":
      await forwardAIFeedback(socket, data, requestId);
      break;
    case "heal/ai/memory":
      await forwardAIMemory(socket, requestId);
      break;
    case "heal/ai/memory/clear":
      await forwardAIMemoryClear(socket, requestId);
      break;
    case "heal/ai/stream":
      await forwardAIStream(socket, data, requestId);
      break;
    case "heal/ai/project":
      await forwardAIProject(socket, data, requestId);
      break;
    case "heal/ai/config":
      await forwardAIConfig(socket, data, requestId);
      break;
    case "heal/ai/config/update":
      await forwardAIConfigUpdate(socket, data, requestId);
      break;
    case "heal/ai/health":
      await forwardAIHealth(socket, requestId);
      break;
    case "heal/ai/cache/clear":
      await forwardAICacheClear(socket, requestId);
      break;
    case "heal/ai/preview":
      await forwardAIPreview(socket, data, requestId);
      break;
    case "heal/ai/policy/suppress":
      await forwardAIPolicySuppress(socket, data, requestId);
      break;
    case "heal/ai/policy/unsuppress":
      await forwardAIPolicyUnsuppress(socket, data, requestId);
      break;
    case "heal/ai/policy":
      await forwardAIPolicyList(socket, data, requestId);
      break;
    case "heal/ai/policy/clear":
      await forwardAIPolicyClear(socket, data, requestId);
      break;

    // ── Agentic self-healing ─────────────────────────────────────
    case "heal/agentic/diagnose":
      await forwardAgenticDiagnose(socket, data, requestId);
      break;
    case "heal/agentic/episode/create":
      await forwardAgenticEpisodeCreate(socket, data, requestId);
      break;
    case "heal/agentic/episode":
      await forwardAgenticEpisodeGet(socket, data, requestId);
      break;
    case "heal/agentic/episodes":
      await forwardAgenticEpisodesList(socket, requestId);
      break;
    case "heal/agentic/policy/evaluate":
      await forwardAgenticPolicyEval(socket, data, requestId);
      break;
    case "heal/agentic/policy/status":
      await forwardAgenticPolicyStatus(socket, requestId);
      break;
    case "heal/agentic/verify":
      await forwardAgenticVerify(socket, data, requestId);
      break;
    case "heal/agentic/guardrails":
      await forwardAgenticGuardrails(socket, data, requestId);
      break;
    case "heal/agentic/telemetry/calibration":
      await forwardAgenticTelemetryCalibration(socket, requestId);
      break;
    case "heal/agentic/telemetry/degrading":
      await forwardAgenticTelemetryDegrading(socket, requestId);
      break;
    case "heal/agentic/runtime/ingest":
      await forwardAgenticRuntimeIngest(socket, data, requestId);
      break;
    case "heal/agentic/runtime/stats":
      await forwardAgenticRuntimeStats(socket, requestId);
      break;
    case "heal/agentic/observability/error":
      await forwardAgenticObsError(socket, requestId);
      break;
    case "heal/agentic/observability/build":
      await forwardAgenticObsBuild(socket, data, requestId);
      break;
    case "heal/agentic/observability/hmr-failure":
      await forwardAgenticObsHmr(socket, data, requestId);
      break;
    case "heal/agentic/observability/stats":
      await forwardAgenticObsStats(socket, requestId);
      break;
    case "heal/agentic/observability/triggers":
      await forwardAgenticObsTriggers(socket, requestId);
      break;
    case "heal/agentic/canary/create":
      await forwardAgenticCanaryCreate(socket, data, requestId);
      break;
    case "heal/agentic/canary":
      await forwardAgenticCanaryList(socket, requestId);
      break;
    case "heal/agentic/canary/stats":
      await forwardAgenticCanaryStats(socket, requestId);
      break;
    case "heal/agentic/status":
      await forwardAgenticStatus(socket, requestId);
      break;

    default:
      sendError(socket, `Unsupported action: ${action}`, { requestId });
  }
}

async function forwardAnalyzeRequest(socket, data, requestId, useAi = false) {
  const lang = data?.lang;
  const code = data?.code;

  if (typeof lang !== "string" || !lang.trim()) {
    sendError(socket, "`lang` must be a non-empty string", { requestId });
    return;
  }

  if (typeof code !== "string") {
    sendError(socket, "`code` must be a string", { requestId });
    return;
  }

  let backendResponse;
    try {
    // Include optional `prompt` when forwarding AI requests so backend LLM
    // can receive explicit instructions from the client.
    const forwardBody = { lang, code };
    if (useAi && typeof data.prompt === 'string' && data.prompt.trim()) {
      forwardBody.prompt = data.prompt;
    }
    // Optional mode field (e.g. 'fullfile') to instruct backend for strict responses
    if (useAi && typeof data.mode === 'string' && data.mode.trim()) {
      forwardBody.mode = data.mode;
    }
    if (useAi && typeof data.model === 'string' && data.model.trim()) {
      forwardBody.model = data.model.trim();
    }
    if (useAi && typeof data.apiKey === 'string' && data.apiKey.trim()) {
      forwardBody.api_key = data.apiKey.trim();
    }
    if (useAi && Array.isArray(data?.files) && data.files.length) {
      const sanitized = data.files
        .map((file) => {
          if (!file || typeof file !== 'object') return null;
          const path = typeof file.path === 'string' ? file.path : null;
          const name = typeof file.name === 'string' ? file.name : null;
          const content = typeof file.content === 'string' ? file.content : '';
          if (!content.trim()) return null;
          return { path, name, content };
        })
        .filter(Boolean);
      if (sanitized.length) {
        forwardBody.files = sanitized;
      }
    }
    if (useAi && typeof data?.focus === 'string' && data.focus.trim()) {
      forwardBody.focus = data.focus.trim();
    }

    backendResponse = await fetch(useAi ? backendAiAnalyzeUrl : backendStaticAnalyzeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error("Backend request failed", err);
    sendError(socket, "Failed to reach analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();

  if (!backendResponse.ok) {
    sendError(socket, "Backend returned an error", {
      requestId,
      detail: responseText,
      status: backendResponse.status,
    });
    return;
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (err) {
    sendError(socket, "Backend response was not valid JSON", {
      requestId,
      detail: err.message,
    });
    return;
  }

  // If this was an AI request and the backend provided a suggestion string,
  // emit simulated streaming chunks first (so the client can show token-by-token
  // inline suggestions). Then send the final response (with requestId) to
  // resolve the original pending request.
  if (useAi) {
    const suggestion = responseJson?.ai_suggestion || responseJson?.suggestion || null;
    if (suggestion && typeof suggestion === 'string' && suggestion.length > 0) {
      // Chunk size in characters — small enough to feel streaming but not too chatty
      const chunkSize = 80;
      for (let i = 0; i < suggestion.length; i += chunkSize) {
        const chunk = suggestion.slice(i, i + chunkSize);
        // Emit partial chunk with `streamId` so clients can map to the request
        safeSend(socket, {
          type: 'stream',
          streamId: requestId,
          action: 'analyze.stream',
          data: { partial: chunk, final: false },
        });
      }
      // Indicate stream finished
      safeSend(socket, {
        type: 'stream',
        streamId: requestId,
        action: 'analyze.stream',
        data: { partial: '', final: true },
      });
    }
  }

  // Send final response (this resolves the pending promise client-side)
  safeSend(socket, {
    type: "response",
    action: "analyze",
    requestId,
    data: responseJson,
  });
}

/**
 * Forward proactive analysis request to backend.
 * Proactive analysis runs multi-tier analysis (static, semantic, AI)
 * to detect potential errors before compilation.
 */
async function forwardProactiveAnalysis(socket, data, requestId) {
  const lang = data?.lang;
  const code = data?.code;

  if (typeof lang !== "string" || !lang.trim()) {
    sendError(socket, "`lang` must be a non-empty string", { requestId });
    return;
  }

  if (typeof code !== "string") {
    sendError(socket, "`code` must be a string", { requestId });
    return;
  }

  // Build request body
  const forwardBody = {
    lang: lang.trim(),
    code,
    file_path: data?.filePath || data?.file_path || "untitled",
  };

  // Optional: specify which tiers to run
  if (Array.isArray(data?.tiers) && data.tiers.length) {
    forwardBody.tiers = data.tiers;
  }

  // Optional: include AI tier
  if (typeof data?.includeAi === "boolean") {
    forwardBody.include_ai = data.includeAi;
  }

  // Optional: max diagnostics limit
  if (typeof data?.maxDiagnostics === "number") {
    forwardBody.max_diagnostics = data.maxDiagnostics;
  }

  // Optional: custom model/API key for AI tier
  if (typeof data?.model === "string" && data.model.trim()) {
    forwardBody.model = data.model.trim();
  }
  if (typeof data?.apiKey === "string" && data.apiKey.trim()) {
    forwardBody.api_key = data.apiKey.trim();
  }

  // Optional: related files for cross-file analysis
  if (Array.isArray(data?.relatedFiles) && data.relatedFiles.length) {
    console.log(`[Gateway] Related files received: ${data.relatedFiles.length}`);
    const sanitized = data.relatedFiles
      .map((file) => {
        if (!file || typeof file !== "object") return null;
        const path = typeof file.path === "string" ? file.path : null;
        const name = typeof file.name === "string" ? file.name : null;
        const content = typeof file.content === "string" ? file.content : "";
        if (!content.trim()) return null;
        console.log(`[Gateway]   Related file: ${path || name} (${content.length} chars)`);
        return { path, name, content };
      })
      .filter(Boolean);
    if (sanitized.length) {
      forwardBody.related_files = sanitized;
      console.log(`[Gateway] Forwarding ${sanitized.length} related files to backend`);
    }
  } else {
    console.log(`[Gateway] No related files in request`);
  }

  console.log(`[Gateway] === PROACTIVE ANALYSIS REQUEST ===`);
  console.log(`[Gateway] File: ${forwardBody.file_path}`);
  console.log(`[Gateway] Language: ${forwardBody.lang}`);
  console.log(`[Gateway] Code length: ${forwardBody.code?.length || 0} chars`);
  console.log(`[Gateway] Tiers: ${forwardBody.tiers || 'default'}`);
  console.log(`[Gateway] Include AI: ${forwardBody.include_ai || false}`);
  console.log(`[Gateway] Related files count: ${forwardBody.related_files?.length || 0}`);

  let backendResponse;
  try {
    backendResponse = await fetch(backendProactiveAnalyzeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error("[Gateway] Proactive analysis backend request failed", err);
    sendError(socket, "Failed to reach proactive analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();
  console.log(`[Gateway] Backend response status: ${backendResponse.status}`);

  if (!backendResponse.ok) {
    console.error(`[Gateway] Backend error: ${responseText}`);
    sendError(socket, "Proactive analysis backend returned an error", {
      requestId,
      detail: responseText,
      status: backendResponse.status,
    });
    return;
  }
  
  // Log response diagnostics
  try {
    const respData = JSON.parse(responseText);
    console.log(`[Gateway] === PROACTIVE ANALYSIS RESPONSE ===`);
    console.log(`[Gateway] Diagnostics count: ${respData.diagnostics?.length || 0}`);
    if (respData.diagnostics?.length > 0) {
      respData.diagnostics.forEach((d, i) => {
        console.log(`[Gateway]   [${i}] ${d.tier}: ${d.message} @ line ${d.location?.line}`);
      });
    }
  } catch (e) {
    // Ignore parse error, just log raw
    console.log(`[Gateway] Response preview: ${responseText.substring(0, 200)}...`);
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (err) {
    sendError(socket, "Proactive analysis response was not valid JSON", {
      requestId,
      detail: err.message,
    });
    return;
  }

  // Send diagnostics as they're ready (for streaming experience)
  // The response contains all tiers, so we send tier updates first
  const tiers = responseJson?.tiers || {};
  for (const [tierName, tierData] of Object.entries(tiers)) {
    safeSend(socket, {
      type: "stream",
      streamId: requestId,
      action: "proactive.tier",
      data: {
        tier: tierName,
        diagnostics: tierData.diagnostics || [],
        elapsedMs: tierData.elapsedMs || 0,
        fromCache: tierData.fromCache || false,
      },
    });
  }

  // Send final response with complete results
  safeSend(socket, {
    type: "response",
    action: "analyze/proactive",
    requestId,
    data: responseJson,
  });
}

/**
 * Container-First proactive analysis (RECOMMENDED).
 * 
 * This endpoint does NOT receive content from the client.
 * The backend fetches content directly from the container filesystem,
 * ensuring the AI analyzes exactly what the compiler sees.
 * 
 * This is the preferred analysis method for eliminating ghost errors.
 */
async function forwardContainerAnalysis(socket, data, requestId) {
  const slug = data?.slug;
  const filePath = data?.file_path || data?.filePath;
  const lang = data?.lang;

  if (typeof slug !== "string" || !slug.trim()) {
    sendError(socket, "`slug` must be a non-empty string", { requestId });
    return;
  }

  if (typeof filePath !== "string" || !filePath.trim()) {
    sendError(socket, "`file_path` must be a non-empty string", { requestId });
    return;
  }

  if (typeof lang !== "string" || !lang.trim()) {
    sendError(socket, "`lang` must be a non-empty string", { requestId });
    return;
  }

  // Build request body - note: NO code field!
  const forwardBody = {
    slug: slug.trim(),
    file_path: filePath.trim(),
    lang: lang.trim(),
  };

  // Optional: related file paths (NOT content!)
  if (Array.isArray(data?.related_paths) && data.related_paths.length) {
    forwardBody.related_paths = data.related_paths.filter(
      (p) => typeof p === "string" && p.trim()
    );
  }

  // Optional: specify which tiers to run
  if (Array.isArray(data?.tiers) && data.tiers.length) {
    forwardBody.tiers = data.tiers;
  }

  // Optional: include AI tier
  if (typeof data?.include_ai === "boolean") {
    forwardBody.include_ai = data.include_ai;
  }

  // Optional: max diagnostics limit
  if (typeof data?.max_diagnostics === "number") {
    forwardBody.max_diagnostics = data.max_diagnostics;
  }

  // Optional: custom model/API key for AI tier
  if (typeof data?.model === "string" && data.model.trim()) {
    forwardBody.model = data.model.trim();
  }
  if (typeof data?.api_key === "string" && data.api_key.trim()) {
    forwardBody.api_key = data.api_key.trim();
  }

  console.log(`[Gateway] === CONTAINER ANALYSIS REQUEST ===`);
  console.log(`[Gateway] Slug: ${forwardBody.slug}`);
  console.log(`[Gateway] File: ${forwardBody.file_path}`);
  console.log(`[Gateway] Language: ${forwardBody.lang}`);
  console.log(`[Gateway] Related paths: ${forwardBody.related_paths?.length || 0}`);
  console.log(`[Gateway] NOTE: Content will be fetched by backend from container`);

  let backendResponse;
  try {
    backendResponse = await fetch(backendContainerAnalyzeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error("[Gateway] Container analysis backend request failed", err);
    sendError(socket, "Failed to reach container analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();
  console.log(`[Gateway] Container analysis response status: ${backendResponse.status}`);

  if (!backendResponse.ok) {
    console.error(`[Gateway] Container analysis error: ${responseText}`);
    sendError(socket, "Container analysis backend returned an error", {
      requestId,
      detail: responseText,
      status: backendResponse.status,
    });
    return;
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (err) {
    sendError(socket, "Container analysis response was not valid JSON", {
      requestId,
      detail: err.message,
    });
    return;
  }

  // Log diagnostics
  console.log(`[Gateway] === CONTAINER ANALYSIS RESPONSE ===`);
  console.log(`[Gateway] Diagnostics count: ${responseJson.diagnostics?.length || 0}`);

  // Send tier updates for streaming experience
  const tiers = responseJson?.tiers || {};
  for (const [tierName, tierData] of Object.entries(tiers)) {
    safeSend(socket, {
      type: "stream",
      streamId: requestId,
      action: "container.tier",
      data: {
        tier: tierName,
        diagnostics: tierData.diagnostics || [],
        elapsedMs: tierData.elapsedMs || 0,
        fromCache: tierData.fromCache || false,
      },
    });
  }

  // Send final response
  safeSend(socket, {
    type: "response",
    action: "analyze/container",
    requestId,
    data: responseJson,
  });
}

/**
 * Forward unified intelligence pipeline analysis request.
 * 
 * This is the RECOMMENDED endpoint that combines:
 * - Layer A: Static/LSP analysis (< 200ms)
 * - Layer B: Compiler semantic analysis (500ms-1s)
 * - Layer C: AI analysis (on-demand, auto-triggered when errors found)
 * 
 * Content is fetched from container filesystem - NOT sent by client.
 */
async function forwardUnifiedAnalysis(socket, data, requestId) {
  const slug = data?.slug;
  const filePath = data?.file_path || data?.filePath;
  const lang = data?.lang;

  if (typeof slug !== "string" || !slug.trim()) {
    sendError(socket, "`slug` must be a non-empty string", { requestId });
    return;
  }

  if (typeof filePath !== "string" || !filePath.trim()) {
    sendError(socket, "`file_path` must be a non-empty string", { requestId });
    return;
  }

  if (typeof lang !== "string" || !lang.trim()) {
    sendError(socket, "`lang` must be a non-empty string", { requestId });
    return;
  }

  // Build request body for unified pipeline
  const forwardBody = {
    slug: slug.trim(),
    file_path: filePath.trim(),
    lang: lang.trim(),
  };

  // Optional: version for stale detection
  if (typeof data?.version === "number" || typeof data?.version === "string") {
    forwardBody.version = data.version;
  }

  // Optional: content override
  if (typeof data?.content === "string") {
    forwardBody.content = data.content;
  }

  // Optional: specify which layers to run (static, semantic, ai)
  if (Array.isArray(data?.layers) && data.layers.length) {
    forwardBody.layers = data.layers;
  }

  // Optional: auto-trigger AI on errors (default true)
  if (typeof data?.trigger_ai_on_errors === "boolean") {
    forwardBody.trigger_ai_on_errors = data.trigger_ai_on_errors;
  }

  // Optional: force include AI layer
  if (typeof data?.include_ai === "boolean") {
    forwardBody.include_ai = data.include_ai;
  }

  // Optional: max diagnostics limit
  if (typeof data?.max_diagnostics === "number") {
    forwardBody.max_diagnostics = data.max_diagnostics;
  }

  // Optional: custom model/API key for AI layer
  if (typeof data?.model === "string" && data.model.trim()) {
    forwardBody.model = data.model.trim();
  }
  if (typeof data?.api_key === "string" && data.api_key.trim()) {
    forwardBody.api_key = data.api_key.trim();
  }

  // Compute content hash for debugging
  const crypto = require('crypto');
  const contentHash = forwardBody.content 
    ? crypto.createHash('md5').update(forwardBody.content).digest('hex').substring(0, 16)
    : 'N/A (fetching from disk)';

  console.log(`[Gateway] UNIFIED: ${forwardBody.file_path} | v=${forwardBody.version || 'N/A'} | hash=${contentHash} | content=${forwardBody.content?.length || 0} chars`);

  // ── PERF: Abort-on-supersede ────────────────────────────────────────────
  // If the same client sends a new analyze/unified for the same slug+filePath
  // before the previous one finishes, abort the stale in-flight HTTP request
  // so the AI engine stops wasting compute on outdated content.
  const supersedeKey = `unified:${slug}:${filePath}`;
  const prevController = socket._inFlightAnalysis?.get(supersedeKey);
  if (prevController) {
    prevController.abort();
    console.log(`[Gateway] Superseded in-flight analysis for ${supersedeKey}`);
  }
  const controller = new AbortController();
  if (socket._inFlightAnalysis) socket._inFlightAnalysis.set(supersedeKey, controller);

  let backendResponse;
  try {
    backendResponse = await fetch(backendUnifiedAnalyzeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (socket._inFlightAnalysis) socket._inFlightAnalysis.delete(supersedeKey);
    if (err.name === 'AbortError') {
      // Silently drop — a newer request superseded this one
      return;
    }
    // console.error("[Gateway] Unified analysis backend request failed", err);
    sendError(socket, "Failed to reach unified analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();
  if (socket._inFlightAnalysis) socket._inFlightAnalysis.delete(supersedeKey);
  console.log(`[Gateway] Unified analysis response status: ${backendResponse.status}`);

  if (!backendResponse.ok) {
    // console.error(`[Gateway] Unified analysis error: ${responseText}`);
    sendError(socket, "Unified analysis backend returned an error", {
      requestId,
      detail: responseText,
      status: backendResponse.status,
    });
    return;
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (err) {
    sendError(socket, "Unified analysis response was not valid JSON", {
      requestId,
      detail: err.message,
    });
    return;
  }

  // Condensed response logging
  console.log(`[Gateway] UNIFIED RESULT: ${responseJson.diagnostics?.length || 0} diags | layers=${responseJson.layers_run?.join(",") || "none"} | ${responseJson.analysis_time_ms?.toFixed(0) || 0}ms | hash=${responseJson.content_hash || 'N/A'}`);

  // Send layer updates for streaming experience (if available)
  if (responseJson?.layer_results) {
    for (const [layerName, layerData] of Object.entries(responseJson.layer_results)) {
      safeSend(socket, {
        type: "stream",
        streamId: requestId,
        action: "unified.layer",
        data: {
          layer: layerName,
          diagnostics: layerData.diagnostics || [],
          elapsedMs: layerData.elapsedMs || 0,
        },
      });
    }
  }

  // Send final response
  safeSend(socket, {
    type: "response",
    action: "analyze/unified",
    requestId,
    data: responseJson,
  });
}

/**
 * Forward quick proactive analysis request (static + semantic only).
 * Optimized for real-time feedback during typing.
 */
async function forwardProactiveQuickAnalysis(socket, data, requestId) {
  const lang = data?.lang;
  const code = data?.code;

  if (typeof lang !== "string" || !lang.trim()) {
    sendError(socket, "`lang` must be a non-empty string", { requestId });
    return;
  }

  if (typeof code !== "string") {
    sendError(socket, "`code` must be a string", { requestId });
    return;
  }

  const forwardBody = {
    lang: lang.trim(),
    code,
    file_path: data?.filePath || data?.file_path || "untitled",
  };

  let backendResponse;
  try {
    backendResponse = await fetch(backendProactiveQuickUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error("Quick proactive analysis backend request failed", err);
    sendError(socket, "Failed to reach quick analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();

  if (!backendResponse.ok) {
    sendError(socket, "Quick analysis backend returned an error", {
      requestId,
      detail: responseText,
      status: backendResponse.status,
    });
    return;
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (err) {
    sendError(socket, "Quick analysis response was not valid JSON", {
      requestId,
      detail: err.message,
    });
    return;
  }

  safeSend(socket, {
    type: "response",
    action: "analyze/proactive/quick",
    requestId,
    data: responseJson,
  });
}

/**
 * Forward workspace analysis request to backend.
 * Workspace analysis handles multiple files with:
 * - Incremental analysis (only changed files + dependents)
 * - Cross-file issue detection
 * - Multi-file suggestions
 */
async function forwardWorkspaceAnalysis(socket, data, requestId) {
  const workspaceId = data?.workspaceId || data?.workspace_id;

  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    sendError(socket, "`workspaceId` must be a non-empty string", { requestId });
    return;
  }

  // Build the request body
  const forwardBody = {
    workspace_id: workspaceId.trim(),
  };

  // Changed files (for incremental analysis)
  if (Array.isArray(data?.changedFiles) && data.changedFiles.length) {
    forwardBody.changed_files = data.changedFiles.map((f) => ({
      path: f.path || "",
      content_hash: f.contentHash || f.content_hash || "",
      change_type: f.changeType || f.change_type || "modified",
      content: f.content || null,
      language: f.language || null,
    }));
  }

  // All files in workspace
  if (Array.isArray(data?.allFiles) && data.allFiles.length) {
    forwardBody.all_files = data.allFiles
      .filter((f) => f && typeof f === "object" && typeof f.content === "string")
      .map((f) => ({
        path: f.path || "untitled",
        content: f.content,
        language: f.language || "plaintext",
      }));
  }

  // Focus file (currently being edited)
  if (typeof data?.focusFile === "string" && data.focusFile.trim()) {
    forwardBody.focus_file = data.focusFile.trim();
  }

  // Analysis configuration
  if (Array.isArray(data?.tiers) && data.tiers.length) {
    forwardBody.tiers = data.tiers;
  }

  if (typeof data?.includeAi === "boolean") {
    forwardBody.include_ai = data.includeAi;
  }

  if (typeof data?.maxDiagnosticsPerFile === "number") {
    forwardBody.max_diagnostics_per_file = data.maxDiagnosticsPerFile;
  }

  if (typeof data?.maxTotalDiagnostics === "number") {
    forwardBody.max_total_diagnostics = data.maxTotalDiagnostics;
  }

  if (typeof data?.incremental === "boolean") {
    forwardBody.incremental = data.incremental;
  }

  if (typeof data?.analyzeDependents === "boolean") {
    forwardBody.analyze_dependents = data.analyzeDependents;
  }

  // Custom model/API key
  if (typeof data?.model === "string" && data.model.trim()) {
    forwardBody.model = data.model.trim();
  }
  if (typeof data?.apiKey === "string" && data.apiKey.trim()) {
    forwardBody.api_key = data.apiKey.trim();
  }

  let backendResponse;
  try {
    backendResponse = await fetch(backendWorkspaceAnalyzeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error("Workspace analysis backend request failed", err);
    sendError(socket, "Failed to reach workspace analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();

  if (!backendResponse.ok) {
    sendError(socket, "Workspace analysis backend returned an error", {
      requestId,
      detail: responseText,
      status: backendResponse.status,
    });
    return;
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (err) {
    sendError(socket, "Workspace analysis response was not valid JSON", {
      requestId,
      detail: err.message,
    });
    return;
  }

  // Send per-file updates for progressive UI
  const files = responseJson?.files || {};
  for (const [filePath, fileData] of Object.entries(files)) {
    safeSend(socket, {
      type: "stream",
      streamId: requestId,
      action: "workspace.file",
      data: {
        filePath,
        diagnostics: fileData.diagnostics || [],
        fromCache: fileData.fromCache || false,
      },
    });
  }

  // Send suggestions
  const suggestions = responseJson?.suggestions || [];
  if (suggestions.length > 0) {
    safeSend(socket, {
      type: "stream",
      streamId: requestId,
      action: "workspace.suggestions",
      data: { suggestions },
    });
  }

  // Send final complete response
  safeSend(socket, {
    type: "response",
    action: "analyze/workspace",
    requestId,
    data: responseJson,
  });
}

/**
 * Forward incremental workspace analysis request.
 * Optimized for real-time editing - only analyzes changed files + dependents.
 */
async function forwardWorkspaceIncrementalAnalysis(socket, data, requestId) {
  // Force incremental mode and forward to main handler
  const modifiedData = { ...data, incremental: true };
  
  // Use the same logic but with forced incremental flag
  const workspaceId = data?.workspaceId || data?.workspace_id;

  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    sendError(socket, "`workspaceId` must be a non-empty string", { requestId });
    return;
  }

  const forwardBody = {
    workspace_id: workspaceId.trim(),
    incremental: true,  // Force incremental
  };

  // Changed files (required for incremental)
  if (Array.isArray(data?.changedFiles) && data.changedFiles.length) {
    forwardBody.changed_files = data.changedFiles.map((f) => ({
      path: f.path || "",
      content_hash: f.contentHash || f.content_hash || "",
      change_type: f.changeType || f.change_type || "modified",
      content: f.content || null,
      language: f.language || null,
    }));
  }

  // All files (for context and dependency resolution)
  if (Array.isArray(data?.allFiles) && data.allFiles.length) {
    forwardBody.all_files = data.allFiles
      .filter((f) => f && typeof f === "object" && typeof f.content === "string")
      .map((f) => ({
        path: f.path || "untitled",
        content: f.content,
        language: f.language || "plaintext",
      }));
  }

  // Focus file
  if (typeof data?.focusFile === "string" && data.focusFile.trim()) {
    forwardBody.focus_file = data.focusFile.trim();
  }

  // Include AI only if explicitly requested
  if (typeof data?.includeAi === "boolean") {
    forwardBody.include_ai = data.includeAi;
  }

  // Custom model/API key
  if (typeof data?.model === "string" && data.model.trim()) {
    forwardBody.model = data.model.trim();
  }
  if (typeof data?.apiKey === "string" && data.apiKey.trim()) {
    forwardBody.api_key = data.apiKey.trim();
  }

  let backendResponse;
  try {
    backendResponse = await fetch(backendWorkspaceIncrementalUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error("Incremental workspace analysis backend request failed", err);
    sendError(socket, "Failed to reach incremental analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();

  if (!backendResponse.ok) {
    sendError(socket, "Incremental analysis backend returned an error", {
      requestId,
      detail: responseText,
      status: backendResponse.status,
    });
    return;
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (err) {
    sendError(socket, "Incremental analysis response was not valid JSON", {
      requestId,
      detail: err.message,
    });
    return;
  }

  safeSend(socket, {
    type: "response",
    action: "analyze/workspace/incremental",
    requestId,
    data: responseJson,
  });
}

// =============================================================================
// Self-Healing Forwarding Functions
// =============================================================================

async function forwardHealAnalyze(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;

  if (typeof code !== "string" || typeof lang !== "string") {
    sendError(socket, "`code` and `lang` are required for healing analysis", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendHealAnalyzeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        lang: lang.toLowerCase(),
        file_path: data?.filePath || data?.file_path || "untitled",
        auto_apply: data?.autoApply ?? false,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing analysis backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "Healing response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/analyze",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] analyze forward error:", err);
    sendError(socket, "Healing analysis request failed", { requestId, detail: err.message });
  }
}

async function forwardHealApply(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;

  if (typeof code !== "string" || typeof lang !== "string") {
    sendError(socket, "`code` and `lang` are required for healing apply", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendHealApplyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        lang: lang.toLowerCase(),
        file_path: data?.filePath || data?.file_path || "untitled",
        fix_ids: data?.fixIds || data?.fix_ids || null,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing apply backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "Healing apply response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/apply",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] apply forward error:", err);
    sendError(socket, "Healing apply request failed", { requestId, detail: err.message });
  }
}

async function forwardHealContainer(socket, data, requestId) {
  const slug = data?.slug;
  const filePath = data?.filePath || data?.file_path;
  const lang = data?.lang;

  if (!slug || !filePath || !lang) {
    sendError(socket, "`slug`, `filePath`, and `lang` are required for container healing", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendHealContainerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        file_path: filePath,
        lang: lang.toLowerCase(),
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Container healing backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "Container healing response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/container",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] container forward error:", err);
    sendError(socket, "Container healing request failed", { requestId, detail: err.message });
  }
}

async function forwardHealConfig(socket, data, requestId) {
  try {
    const hasUpdates = data && Object.keys(data).length > 0;
    const method = hasUpdates ? "POST" : "GET";
    const fetchOpts = { method, headers: { "content-type": "application/json" } };
    if (hasUpdates) {
      fetchOpts.body = JSON.stringify(data);
    }

    const backendResponse = await fetch(backendHealConfigUrl, fetchOpts);
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing config backend error", { requestId, detail: responseText });
      return;
    }

    const responseJson = JSON.parse(responseText);
    safeSend(socket, {
      type: "response",
      action: "heal/config",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] config forward error:", err);
    sendError(socket, "Healing config request failed", { requestId, detail: err.message });
  }
}

async function forwardHealStats(socket, requestId) {
  try {
    const backendResponse = await fetch(backendHealStatsUrl, { method: "GET" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing stats backend error", { requestId, detail: responseText });
      return;
    }

    const responseJson = JSON.parse(responseText);
    safeSend(socket, {
      type: "response",
      action: "heal/stats",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] stats forward error:", err);
    sendError(socket, "Healing stats request failed", { requestId, detail: err.message });
  }
}

async function forwardHealRules(socket, requestId) {
  try {
    const backendResponse = await fetch(backendHealRulesUrl, { method: "GET" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing rules backend error", { requestId, detail: responseText });
      return;
    }

    const responseJson = JSON.parse(responseText);
    safeSend(socket, {
      type: "response",
      action: "heal/rules",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] rules forward error:", err);
    sendError(socket, "Healing rules request failed", { requestId, detail: err.message });
  }
}

async function forwardHealBatch(socket, data, requestId) {
  try {
    const backendResponse = await fetch(backendHealBatchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing batch backend error", { requestId, detail: responseText });
      return;
    }

    const responseJson = JSON.parse(responseText);
    safeSend(socket, {
      type: "response",
      action: "heal/batch",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] batch forward error:", err);
    sendError(socket, "Healing batch request failed", { requestId, detail: err.message });
  }
}

async function forwardHealCacheStats(socket, requestId) {
  try {
    const backendResponse = await fetch(backendHealCacheStatsUrl, { method: "GET" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing cache stats backend error", { requestId, detail: responseText });
      return;
    }

    const responseJson = JSON.parse(responseText);
    safeSend(socket, {
      type: "response",
      action: "heal/cache/stats",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] cache stats forward error:", err);
    sendError(socket, "Healing cache stats request failed", { requestId, detail: err.message });
  }
}

async function forwardHealPresets(socket, requestId) {
  try {
    const backendResponse = await fetch(backendHealPresetsUrl, { method: "GET" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing presets backend error", { requestId, detail: responseText });
      return;
    }

    const responseJson = JSON.parse(responseText);
    safeSend(socket, {
      type: "response",
      action: "heal/presets",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] presets forward error:", err);
    sendError(socket, "Healing presets request failed", { requestId, detail: err.message });
  }
}

async function forwardHealPresetApply(socket, data, requestId) {
  try {
    const backendResponse = await fetch(backendHealPresetApplyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: data.preset }),
    });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing preset apply backend error", { requestId, detail: responseText });
      return;
    }

    const responseJson = JSON.parse(responseText);
    safeSend(socket, {
      type: "response",
      action: "heal/preset",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Heal] preset apply forward error:", err);
    sendError(socket, "Healing preset apply request failed", { requestId, detail: err.message });
  }
}

async function forwardHealMetrics(socket, requestId) {
  try {
    const backendResponse = await fetch(backendHealMetricsUrl, { method: "GET" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Healing metrics backend error", { requestId, detail: responseText });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/metrics",
      requestId,
      data: { raw: responseText },
    });
  } catch (err) {
    console.error("[Heal] metrics forward error:", err);
    sendError(socket, "Healing metrics request failed", { requestId, detail: err.message });
  }
}

// =============================================================================
// AI Agent Forwarding
// =============================================================================

async function forwardAIAnalyze(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;

  if (typeof code !== "string" || typeof lang !== "string") {
    sendError(socket, "`code` and `lang` are required for AI analysis", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendAIAnalyzeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        lang: lang.toLowerCase(),
        file_path: data?.filePath || data?.file_path || "untitled",
        workspace_root: data?.workspaceRoot || data?.workspace_root || null,
        auto_apply: data?.autoApply ?? false,
        focus_start_line: data?.focusStartLine ?? null,
        focus_end_line: data?.focusEndLine ?? null,
        validate_fixes: data?.validateFixes ?? true,
        min_confidence: data?.minConfidence ?? null,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "AI analysis backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "AI analysis response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/analyze",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] analyze forward error:", err);
    sendError(socket, "AI analysis request failed", { requestId, detail: err.message });
  }
}

// Per-socket sliding window for rule-translate requests.  Protects the
// Gemini backend from a malicious or buggy client slamming the endpoint.
const RULE_TRANSLATE_WINDOW_MS = 60_000;
const RULE_TRANSLATE_MAX_PER_WINDOW = 10;

async function forwardHealRuleTranslate(socket, data, requestId) {
  const plainEnglish = data?.plainEnglish || data?.plain_english;
  if (typeof plainEnglish !== "string" || !plainEnglish.trim()) {
    sendError(socket, "`plainEnglish` is required", { requestId });
    return;
  }
  if (plainEnglish.length > 500) {
    sendError(socket, "`plainEnglish` too long (max 500 chars)", { requestId });
    return;
  }

  // Rate limit
  const now = Date.now();
  if (!socket._ruleTranslateWindow) socket._ruleTranslateWindow = [];
  socket._ruleTranslateWindow = socket._ruleTranslateWindow.filter(
    (t) => now - t < RULE_TRANSLATE_WINDOW_MS
  );
  if (socket._ruleTranslateWindow.length >= RULE_TRANSLATE_MAX_PER_WINDOW) {
    sendError(socket, "Too many rule translations — try again in a minute", {
      requestId,
      retryAfterMs: RULE_TRANSLATE_WINDOW_MS,
    });
    return;
  }
  socket._ruleTranslateWindow.push(now);

  try {
    const backendResponse = await fetch(backendHealRuleTranslateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plain_english: plainEnglish,
        target_vocabulary: data?.targetVocabulary || data?.target_vocabulary || null,
        scope_vocabulary: data?.scopeVocabulary || data?.scope_vocabulary || null,
        action_vocabulary: data?.actionVocabulary || data?.action_vocabulary || null,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Rule translation backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "Rule translation response was not valid JSON", {
        requestId,
        detail: err.message,
      });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/rule/translate",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[RuleTranslate] forward error:", err);
    sendError(socket, "Rule translation request failed", {
      requestId,
      detail: err.message,
    });
  }
}

async function forwardAIRuntime(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;
  const diagnostics = data?.diagnostics;

  if (typeof code !== "string" || typeof lang !== "string") {
    sendError(socket, "`code` and `lang` are required for runtime error fixing", { requestId });
    return;
  }
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    sendError(socket, "`diagnostics` array is required for runtime error fixing", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendAIRuntimeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        lang: lang.toLowerCase(),
        file_path: data?.filePath || data?.file_path || "untitled",
        diagnostics,
        error_output: data?.errorOutput || data?.error_output || null,
        auto_apply: data?.autoApply ?? true,
        module: data?.module || null,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Runtime error healing backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "Runtime error healing response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/runtime",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[Runtime Healing] forward error:", err);
    sendError(socket, "Runtime error healing request failed", { requestId, detail: err.message });
  }
}

async function forwardAIBatch(socket, data, requestId) {
  const files = data?.files;

  if (!files || typeof files !== "object") {
    sendError(socket, "`files` object is required for AI batch analysis", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendAIBatchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files,
        lang: data?.lang || null,
        auto_apply: data?.autoApply ?? false,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "AI batch analysis backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "AI batch response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/batch",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] batch forward error:", err);
    sendError(socket, "AI batch analysis request failed", { requestId, detail: err.message });
  }
}

async function forwardAIHybrid(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;

  if (typeof code !== "string" || typeof lang !== "string") {
    sendError(socket, "`code` and `lang` are required for hybrid analysis", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendAIHybridUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        lang: lang.toLowerCase(),
        file_path: data?.filePath || data?.file_path || "untitled",
        workspace_root: data?.workspaceRoot || data?.workspace_root || null,
        auto_apply: data?.autoApply ?? false,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "Hybrid analysis backend error", {
        requestId,
        detail: responseText,
        status: backendResponse.status,
      });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "Hybrid analysis response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/hybrid",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] hybrid forward error:", err);
    sendError(socket, "Hybrid analysis request failed", { requestId, detail: err.message });
  }
}

async function forwardAIStats(socket, requestId) {
  try {
    const backendResponse = await fetch(backendAIStatsUrl, { method: "GET" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "AI stats backend error", { requestId, detail: responseText });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "AI stats response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/stats",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] stats forward error:", err);
    sendError(socket, "AI stats request failed", { requestId, detail: err.message });
  }
}

// ── AI Agent: feedback ──────────────────────────────────────────────
async function forwardAIFeedback(socket, data, requestId) {
  const ruleId = data?.ruleId || data?.rule_id;
  const feedbackType = data?.feedbackType || data?.feedback_type;

  if (typeof ruleId !== "string" || typeof feedbackType !== "string") {
    sendError(socket, "`ruleId` and `feedbackType` are required for feedback", { requestId });
    return;
  }

  try {
    const backendResponse = await fetch(backendAIFeedbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rule_id: ruleId,
        feedback_type: feedbackType,
        file_path: data?.filePath || data?.file_path || null,
        original_text: data?.originalText || data?.original_text || null,
        replacement_text: data?.replacementText || data?.replacement_text || null,
        description: data?.description || null,
      }),
    });

    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "AI feedback backend error", { requestId, detail: responseText });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "AI feedback response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/feedback",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] feedback forward error:", err);
    sendError(socket, "AI feedback request failed", { requestId, detail: err.message });
  }
}

// ── AI Agent: memory summary ────────────────────────────────────────
async function forwardAIMemory(socket, requestId) {
  try {
    const backendResponse = await fetch(backendAIMemoryUrl, { method: "GET" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "AI memory backend error", { requestId, detail: responseText });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "AI memory response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/memory",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] memory forward error:", err);
    sendError(socket, "AI memory request failed", { requestId, detail: err.message });
  }
}

// ── AI Agent: clear memory ──────────────────────────────────────────
async function forwardAIMemoryClear(socket, requestId) {
  try {
    const backendResponse = await fetch(backendAIMemoryUrl, { method: "DELETE" });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "AI memory clear backend error", { requestId, detail: responseText });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "AI memory clear response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/memory/clear",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] memory clear forward error:", err);
    sendError(socket, "AI memory clear request failed", { requestId, detail: err.message });
  }
}

/**
 * Forward an SSE streaming AI analysis request.
 *
 * The backend endpoint /heal/ai/stream returns `text/event-stream`.
 * We consume the SSE events and relay each one as a WebSocket message so
 * the browser client receives progressive updates without HTTP streaming.
 */
async function forwardAIStream(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;

  if (typeof code !== "string" || !code.trim()) {
    sendError(socket, "`code` must be a non-empty string", { requestId });
    return;
  }

  try {
    const body = {
      code,
      lang: lang || "plaintext",
      file_path: data?.filePath || data?.file_path || "",
      workspace_root: data?.workspaceRoot || data?.workspace_root || "",
      auto_apply: data?.autoApply ?? false,
      validate_fixes: data?.validateFixes ?? true,
    };
    if (data?.minConfidence != null) body.min_confidence = data.minConfidence;

    const backendResponse = await fetch(backendAIStreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!backendResponse.ok) {
      const errText = await backendResponse.text();
      sendError(socket, "AI stream backend error", { requestId, detail: errText });
      return;
    }

    // Read the SSE body as a stream of text chunks
    const reader = backendResponse.body;
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    for await (const chunk of reader) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

      // Split on double-newline (SSE event boundary)
      const parts = buffer.split("\n\n");
      buffer = parts.pop(); // keep incomplete tail

      for (const part of parts) {
        const dataLine = part
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) continue;

        const jsonStr = dataLine.slice(6); // strip "data: "
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          // Non-JSON SSE event — skip
          continue;
        }

        safeSend(socket, {
          type: "stream",
          action: "heal/ai/stream",
          requestId,
          event: parsed.event || parsed.type || "data",
          data: parsed,
        });
      }
    }

    // Flush the UTF-8 decoder (release any buffered multi-byte tail)
    const tail = decoder.decode(undefined, { stream: false });
    if (tail) buffer += tail;

    // Flush any remaining complete SSE events in the buffer
    if (buffer.trim()) {
      const tailParts = buffer.split("\n\n");
      for (const part of tailParts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const dataLine = trimmed
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const parsed = JSON.parse(dataLine.slice(6));
          safeSend(socket, {
            type: "stream",
            action: "heal/ai/stream",
            requestId,
            event: parsed.event || parsed.type || "data",
            data: parsed,
          });
        } catch {
          // ignore malformed tail
        }
      }
    }

    // Send stream-end marker
    safeSend(socket, {
      type: "stream_end",
      action: "heal/ai/stream",
      requestId,
    });
  } catch (err) {
    console.error("[AI Agent] stream forward error:", err);
    sendError(socket, "AI stream request failed", { requestId, detail: err.message });
  }
}

async function forwardAIProject(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;
  const filePath = data?.filePath || data?.file_path;

  if (typeof code !== "string" || !code.trim()) {
    sendError(socket, "`code` must be a non-empty string", { requestId });
    return;
  }

  try {
    const body = {
      code,
      lang: lang || "plaintext",
      file_path: filePath || "",
      workspace_root: data?.workspaceRoot || data?.workspace_root || "",
      validate_fixes: data?.validateFixes ?? true,
    };
    if (data?.relatedFiles) body.related_files = data.relatedFiles;
    if (data?.minConfidence != null) body.min_confidence = data.minConfidence;

    const backendResponse = await fetch(backendAIProjectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseText = await backendResponse.text();

    if (!backendResponse.ok) {
      sendError(socket, "AI project analysis backend error", { requestId, detail: responseText });
      return;
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (err) {
      sendError(socket, "AI project response was not valid JSON", { requestId, detail: err.message });
      return;
    }

    safeSend(socket, {
      type: "response",
      action: "heal/ai/project",
      requestId,
      data: responseJson,
    });
  } catch (err) {
    console.error("[AI Agent] project forward error:", err);
    sendError(socket, "AI project analysis request failed", { requestId, detail: err.message });
  }
}

async function forwardAIConfig(socket, data, requestId) {
  try {
    const backendResponse = await fetch(backendAIConfigUrl, { method: "GET" });
    const responseText = await backendResponse.text();
    if (!backendResponse.ok) {
      sendError(socket, "AI config backend error", { requestId, detail: responseText });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/config",
      requestId,
      data: JSON.parse(responseText),
    });
  } catch (err) {
    console.error("[AI Agent] config forward error:", err);
    sendError(socket, "AI config request failed", { requestId, detail: err.message });
  }
}

async function forwardAIConfigUpdate(socket, data, requestId) {
  try {
    const body = {};
    if (data?.minConfidence != null) body.min_confidence = data.minConfidence;
    if (data?.validateFixes != null) body.validate_fixes = data.validateFixes;
    if (data?.autoAcceptThreshold != null) body.auto_accept_threshold = data.autoAcceptThreshold;
    if (data?.confidenceDiscount != null) body.confidence_discount = data.confidenceDiscount;
    if (data?.maxFixesPerFile != null) body.max_fixes_per_file = data.maxFixesPerFile;
    if (data?.llmTimeout != null) body.llm_timeout = data.llmTimeout;

    const backendResponse = await fetch(backendAIConfigUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseText = await backendResponse.text();
    if (!backendResponse.ok) {
      sendError(socket, "AI config update backend error", { requestId, detail: responseText });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/config/update",
      requestId,
      data: JSON.parse(responseText),
    });
  } catch (err) {
    console.error("[AI Agent] config update forward error:", err);
    sendError(socket, "AI config update failed", { requestId, detail: err.message });
  }
}

async function forwardAIHealth(socket, requestId) {
  try {
    const backendResponse = await fetch(backendAIHealthUrl, { method: "GET" });
    const responseText = await backendResponse.text();
    if (!backendResponse.ok) {
      sendError(socket, "AI health backend error", { requestId, detail: responseText });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/health",
      requestId,
      data: JSON.parse(responseText),
    });
  } catch (err) {
    console.error("[AI Agent] health forward error:", err);
    sendError(socket, "AI health request failed", { requestId, detail: err.message });
  }
}

async function forwardAICacheClear(socket, requestId) {
  try {
    const backendResponse = await fetch(backendAICacheClearUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const responseText = await backendResponse.text();
    if (!backendResponse.ok) {
      sendError(socket, "AI cache clear backend error", { requestId, detail: responseText });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/cache/clear",
      requestId,
      data: JSON.parse(responseText),
    });
  } catch (err) {
    console.error("[AI Agent] cache clear forward error:", err);
    sendError(socket, "AI cache clear request failed", { requestId, detail: err.message });
  }
}

async function forwardAIPreview(socket, data, requestId) {
  const code = data?.code;
  const lang = data?.lang;
  if (typeof code !== "string" || typeof lang !== "string") {
    sendError(socket, "`code` and `lang` are required for AI preview", { requestId });
    return;
  }
  try {
    const backendResponse = await fetch(backendAIPreviewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        lang: lang.toLowerCase(),
        file_path: data?.filePath || data?.file_path || "untitled",
      }),
    });
    const responseText = await backendResponse.text();
    if (!backendResponse.ok) {
      sendError(socket, "AI preview backend error", { requestId, detail: responseText });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/preview",
      requestId,
      data: JSON.parse(responseText),
    });
  } catch (err) {
    console.error("[AI Agent] preview forward error:", err);
    sendError(socket, "AI preview request failed", { requestId, detail: err.message });
  }
}

// ── AI Policy: suppress ──────────────────────────────────────────────
async function forwardAIPolicySuppress(socket, data, requestId) {
  const ruleId = data?.ruleId || data?.rule_id;
  if (typeof ruleId !== "string") {
    sendError(socket, "`ruleId` is required for policy suppress", { requestId });
    return;
  }
  try {
    const resp = await fetch(backendAIPolicySuppressUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ruleId,
        fingerprint: data?.fingerprint || null,
        mode: data?.mode || "fingerprint",
        reason: data?.reason || null,
        ttl: data?.ttl ?? null,
        env: data?.env || "development",
        workspaceId: data?.workspaceId || "default",
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      sendError(socket, "AI policy suppress backend error", { requestId, detail: text });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/policy/suppress",
      requestId,
      data: JSON.parse(text),
    });
  } catch (err) {
    console.error("[AI Policy] suppress forward error:", err);
    sendError(socket, "AI policy suppress failed", { requestId, detail: err.message });
  }
}

// ── AI Policy: unsuppress ────────────────────────────────────────────
async function forwardAIPolicyUnsuppress(socket, data, requestId) {
  const ruleId = data?.ruleId || data?.rule_id;
  if (typeof ruleId !== "string") {
    sendError(socket, "`ruleId` is required for policy unsuppress", { requestId });
    return;
  }
  try {
    const resp = await fetch(backendAIPolicyUnsuppressUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ruleId,
        fingerprint: data?.fingerprint || null,
        env: data?.env || "development",
        workspaceId: data?.workspaceId || "default",
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      sendError(socket, "AI policy unsuppress backend error", { requestId, detail: text });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/policy/unsuppress",
      requestId,
      data: JSON.parse(text),
    });
  } catch (err) {
    console.error("[AI Policy] unsuppress forward error:", err);
    sendError(socket, "AI policy unsuppress failed", { requestId, detail: err.message });
  }
}

// ── AI Policy: list ──────────────────────────────────────────────────
async function forwardAIPolicyList(socket, data, requestId) {
  try {
    const env = data?.env || "development";
    const workspaceId = data?.workspaceId || "default";
    const url = `${backendAIPolicyListUrl}?env=${encodeURIComponent(env)}&workspaceId=${encodeURIComponent(workspaceId)}`;
    const resp = await fetch(url, { method: "GET" });
    const text = await resp.text();
    if (!resp.ok) {
      sendError(socket, "AI policy list backend error", { requestId, detail: text });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/policy",
      requestId,
      data: JSON.parse(text),
    });
  } catch (err) {
    console.error("[AI Policy] list forward error:", err);
    sendError(socket, "AI policy list failed", { requestId, detail: err.message });
  }
}

// ── AI Policy: clear ─────────────────────────────────────────────────
async function forwardAIPolicyClear(socket, data, requestId) {
  try {
    const env = data?.env || "development";
    const workspaceId = data?.workspaceId || "default";
    const url = `${backendAIPolicyListUrl}?env=${encodeURIComponent(env)}&workspaceId=${encodeURIComponent(workspaceId)}`;
    const resp = await fetch(url, { method: "DELETE" });
    const text = await resp.text();
    if (!resp.ok) {
      sendError(socket, "AI policy clear backend error", { requestId, detail: text });
      return;
    }
    safeSend(socket, {
      type: "response",
      action: "heal/ai/policy/clear",
      requestId,
      data: JSON.parse(text),
    });
  } catch (err) {
    console.error("[AI Policy] clear forward error:", err);
    sendError(socket, "AI policy clear failed", { requestId, detail: err.message });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Agentic Self-Healing forwarding functions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Generic POST forwarder for agentic endpoints. */
async function agenticPost(socket, action, url, data, requestId) {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data || {}),
    });
    const text = await resp.text();
    if (!resp.ok) {
      sendError(socket, `Agentic ${action} backend error`, { requestId, detail: text, status: resp.status });
      return;
    }
    safeSend(socket, { type: "response", action, requestId, data: JSON.parse(text) });
  } catch (err) {
    console.error(`[Agentic] ${action} forward error:`, err);
    sendError(socket, `Agentic ${action} request failed`, { requestId, detail: err.message });
  }
}

/** Generic GET forwarder for agentic endpoints. */
async function agenticGet(socket, action, url, requestId) {
  try {
    const resp = await fetch(url, { method: "GET" });
    const text = await resp.text();
    if (!resp.ok) {
      sendError(socket, `Agentic ${action} backend error`, { requestId, detail: text, status: resp.status });
      return;
    }
    safeSend(socket, { type: "response", action, requestId, data: JSON.parse(text) });
  } catch (err) {
    console.error(`[Agentic] ${action} forward error:`, err);
    sendError(socket, `Agentic ${action} request failed`, { requestId, detail: err.message });
  }
}

// Diagnosis
async function forwardAgenticDiagnose(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/diagnose", backendAgenticDiagnoseUrl, {
    errorText: data?.errorText || data?.error_text || "",
    filePath: data?.filePath || data?.file_path || "",
    language: data?.language || data?.lang || "",
    source: data?.source || "compiler",
  }, requestId);
}

// Episodes
async function forwardAgenticEpisodeCreate(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/episode/create", backendAgenticEpisodeCreateUrl, {
    filePath: data?.filePath || data?.file_path || "",
    errorMessage: data?.errorMessage || data?.error_message || "",
    language: data?.language || data?.lang || "",
  }, requestId);
}

async function forwardAgenticEpisodeGet(socket, data, requestId) {
  const episodeId = data?.episodeId || data?.episode_id || "";
  const url = `${backendAgenticEpisodesUrl.replace("/episodes", "/episode")}/${encodeURIComponent(episodeId)}`;
  await agenticGet(socket, "heal/agentic/episode", url, requestId);
}

async function forwardAgenticEpisodesList(socket, requestId) {
  await agenticGet(socket, "heal/agentic/episodes", backendAgenticEpisodesUrl, requestId);
}

// Policy
async function forwardAgenticPolicyEval(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/policy/evaluate", backendAgenticPolicyEvalUrl, {
    filePath: data?.filePath || data?.file_path || "",
    language: data?.language || data?.lang || "",
    numFiles: data?.numFiles ?? data?.num_files ?? 1,
    estimatedLinesChanged: data?.estimatedLinesChanged ?? data?.estimated_lines ?? 0,
    stepTypes: data?.stepTypes || data?.step_types || null,
  }, requestId);
}

async function forwardAgenticPolicyStatus(socket, requestId) {
  await agenticGet(socket, "heal/agentic/policy/status", backendAgenticPolicyStatusUrl, requestId);
}

// Verification
async function forwardAgenticVerify(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/verify", backendAgenticVerifyUrl, {
    filePath: data?.filePath || data?.file_path || "",
    original: data?.original || "",
    patched: data?.patched || "",
    language: data?.language || data?.lang || "",
  }, requestId);
}

async function forwardAgenticGuardrails(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/guardrails", backendAgenticGuardrailsUrl, {
    filePath: data?.filePath || data?.file_path || "",
    original: data?.original || "",
    patched: data?.patched || "",
  }, requestId);
}

// Telemetry
async function forwardAgenticTelemetryCalibration(socket, requestId) {
  await agenticGet(socket, "heal/agentic/telemetry/calibration", backendAgenticTelemetryCalUrl, requestId);
}

async function forwardAgenticTelemetryDegrading(socket, requestId) {
  await agenticGet(socket, "heal/agentic/telemetry/degrading", backendAgenticTelemetryDegUrl, requestId);
}

// Runtime healing
async function forwardAgenticRuntimeIngest(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/runtime/ingest", backendAgenticRuntimeIngestUrl, {
    message: data?.message || "",
    source: data?.source || "terminal",
    rawOutput: data?.rawOutput || data?.raw_output || "",
    severity: data?.severity || "error",
    workspaceId: data?.workspaceId || data?.workspace_id || "",
  }, requestId);
}

async function forwardAgenticRuntimeStats(socket, requestId) {
  await agenticGet(socket, "heal/agentic/runtime/stats", backendAgenticRuntimeStatsUrl, requestId);
}

// Observability
async function forwardAgenticObsError(socket, requestId) {
  await agenticPost(socket, "heal/agentic/observability/error", backendAgenticObsErrorUrl, {}, requestId);
}

async function forwardAgenticObsBuild(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/observability/build", backendAgenticObsBuildUrl, {
    durationSec: data?.durationSec ?? data?.duration_sec ?? 0,
  }, requestId);
}

async function forwardAgenticObsHmr(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/observability/hmr-failure", backendAgenticObsHmrUrl, {
    filePath: data?.filePath || data?.file_path || "",
  }, requestId);
}

async function forwardAgenticObsStats(socket, requestId) {
  await agenticGet(socket, "heal/agentic/observability/stats", backendAgenticObsStatsUrl, requestId);
}

async function forwardAgenticObsTriggers(socket, requestId) {
  await agenticGet(socket, "heal/agentic/observability/triggers", backendAgenticObsTriggersUrl, requestId);
}

// Canary
async function forwardAgenticCanaryCreate(socket, data, requestId) {
  await agenticPost(socket, "heal/agentic/canary/create", backendAgenticCanaryCreateUrl, {
    canaryFiles: data?.canaryFiles || data?.canary_files || [],
    remainingFiles: data?.remainingFiles || data?.remaining_files || [],
    episodeId: data?.episodeId || data?.episode_id || "",
  }, requestId);
}

async function forwardAgenticCanaryList(socket, requestId) {
  await agenticGet(socket, "heal/agentic/canary", backendAgenticCanaryListUrl, requestId);
}

async function forwardAgenticCanaryStats(socket, requestId) {
  await agenticGet(socket, "heal/agentic/canary/stats", backendAgenticCanaryStatsUrl, requestId);
}

// Overview
async function forwardAgenticStatus(socket, requestId) {
  await agenticGet(socket, "heal/agentic/status", backendAgenticStatusUrl, requestId);
}

function sendError(socket, message, extra = {}) {
  safeSend(socket, {
    type: "error",
    message,
    ...extra,
  });
}

function safeSend(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    const str = JSON.stringify(payload);
    console.log(`[Gateway DEBUG] Sending to client: ${str.substring(0, 200)}...`);
    socket.send(str);
  } catch (err) {
    // console.error("Failed to send payload", err);
  }
}

} // end cluster worker/single-process block
