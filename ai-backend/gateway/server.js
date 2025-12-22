#!/usr/bin/env node

require("dotenv").config();

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

const server = http.createServer(handleHttpRequest);
const wss = new WebSocketServer({
  server,
  path: websocketPath,
});

wss.on("connection", (socket, request) => {
  const clientId = crypto.randomUUID();
  console.info("WS connected", { clientId, ip: request.socket.remoteAddress });

  safeSend(socket, {
    type: "system",
    event: "connected",
    clientId,
  });

  socket.on("message", (raw) => {
    handleClientMessage(socket, raw).catch((err) => {
      console.error("Handler error", err);
      sendError(socket, "Internal gateway error", {
        detail: err.message,
      });
    });
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

server.listen(gatewayPort, () => {
  console.info(
    `Gateway listening on port ${gatewayPort} (WS path ${websocketPath})`
  );
});

function handleHttpRequest(req, res) {
  if (req.method === "GET" && req.url === "/health") {
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

async function handleClientMessage(socket, raw) {
  const payloadText = raw.toString("utf8").trim();
  console.log(`[Gateway DEBUG] Received from client: ${payloadText.substring(0, 200)}...`);
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
    // console.log(`[Gateway] Related files received: ${data.relatedFiles.length}`);
    const sanitized = data.relatedFiles
      .map((file) => {
        if (!file || typeof file !== "object") return null;
        const path = typeof file.path === "string" ? file.path : null;
        const name = typeof file.name === "string" ? file.name : null;
        const content = typeof file.content === "string" ? file.content : "";
        if (!content.trim()) return null;
        // console.log(`[Gateway]   Related file: ${path || name} (${content.length} chars)`);
        return { path, name, content };
      })
      .filter(Boolean);
    if (sanitized.length) {
      forwardBody.related_files = sanitized;
      // console.log(`[Gateway] Forwarding ${sanitized.length} related files to backend`);
    }
  } else {
    // console.log(`[Gateway] No related files in request`);
  }

  // console.log(`[Gateway] === PROACTIVE ANALYSIS REQUEST ===`);
  // console.log(`[Gateway] File: ${forwardBody.file_path}`);
  // console.log(`[Gateway] Language: ${forwardBody.lang}`);
  // console.log(`[Gateway] Code length: ${forwardBody.code?.length || 0} chars`);
  // console.log(`[Gateway] Tiers: ${forwardBody.tiers || 'default'}`);
  // console.log(`[Gateway] Include AI: ${forwardBody.include_ai || false}`);
  // console.log(`[Gateway] Related files count: ${forwardBody.related_files?.length || 0}`);

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
  // console.log(`[Gateway] Backend response status: ${backendResponse.status}`);

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
    // console.log(`[Gateway] === PROACTIVE ANALYSIS RESPONSE ===`);
    // console.log(`[Gateway] Diagnostics count: ${respData.diagnostics?.length || 0}`);
    if (respData.diagnostics?.length > 0) {
      respData.diagnostics.forEach((d, i) => {
        // console.log(`[Gateway]   [${i}] ${d.tier}: ${d.message} @ line ${d.location?.line}`);
      });
    }
  } catch (e) {
    // Ignore parse error, just log raw
    // console.log(`[Gateway] Response preview: ${responseText.substring(0, 200)}...`);
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
  if (typeof data?.version === "number") {
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

  console.log(`[Gateway] === UNIFIED ANALYSIS REQUEST ===`);
  console.log(`[Gateway] Slug: ${forwardBody.slug}`);
  console.log(`[Gateway] File: ${forwardBody.file_path}`);
  console.log(`[Gateway] Language: ${forwardBody.lang}`);
  console.log(`[Gateway] Version: ${forwardBody.version || 'not set'}`);
  console.log(`[Gateway] Layers: ${forwardBody.layers?.join(", ") || "default"}`);
  console.log(`[Gateway] Auto-AI on errors: ${forwardBody.trigger_ai_on_errors !== false}`);

  let backendResponse;
  try {
    backendResponse = await fetch(backendUnifiedAnalyzeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error("[Gateway] Unified analysis backend request failed", err);
    sendError(socket, "Failed to reach unified analysis backend", {
      requestId,
      detail: err.message,
    });
    return;
  }

  const responseText = await backendResponse.text();
  console.log(`[Gateway] Unified analysis response status: ${backendResponse.status}`);

  if (!backendResponse.ok) {
    console.error(`[Gateway] Unified analysis error: ${responseText}`);
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

  // Log results
  console.log(`[Gateway] === UNIFIED ANALYSIS RESPONSE ===`);
  console.log(`[Gateway] Diagnostics count: ${responseJson.diagnostics?.length || 0}`);
  console.log(`[Gateway] Layers run: ${responseJson.layers_run?.join(", ") || "none"}`);
  console.log(`[Gateway] Time: ${responseJson.analysis_time_ms?.toFixed(1) || 0}ms`);

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
    console.error("Failed to send payload", err);
  }
}
