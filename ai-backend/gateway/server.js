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
    socket.send(JSON.stringify(payload));
  } catch (err) {
    console.error("Failed to send payload", err);
  }
}
