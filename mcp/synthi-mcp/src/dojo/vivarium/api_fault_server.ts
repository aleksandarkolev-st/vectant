import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export type DojoApiFaultBehavior =
  | "success"
  | "validation_error"
  | "timeout"
  | "partial_write"
  | "fake_success"
  | "duplicate_entity"
  | "stale_entity"
  | "downstream_failure";

export interface DojoApiFaultServerState {
  requests: Array<{
    method: string;
    url: string;
    body: unknown;
  }>;
  durable_state: {
    committed: boolean;
    partial: boolean;
    validation_error: boolean;
    fake_success: boolean;
    duplicate_entity: boolean;
    stale_entity: boolean;
    downstream_failed: boolean;
    records: Record<string, unknown>[];
  };
}

export interface DojoApiFaultServer {
  url: string;
  behavior: DojoApiFaultBehavior;
  state: DojoApiFaultServerState;
  close(): Promise<void>;
}

export async function startDojoApiFaultServer(input: {
  behavior: DojoApiFaultBehavior;
  timeout_ms?: number;
}): Promise<DojoApiFaultServer> {
  const state: DojoApiFaultServerState = {
    requests: [],
    durable_state: {
      committed: false,
      partial: false,
      validation_error: false,
      fake_success: false,
      duplicate_entity: false,
      stale_entity: false,
      downstream_failed: false,
      records: [],
    },
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response, state, input.behavior, input.timeout_ms ?? 25);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("dojo_api_fault_server_listen_failed");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    behavior: input.behavior,
    state,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: DojoApiFaultServerState,
  behavior: DojoApiFaultBehavior,
  timeoutMs: number
): Promise<void> {
  if (request.method === "GET" && request.url === "/synthetic/state") {
    sendJson(response, 200, state.durable_state);
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, behavior });
    return;
  }
  if (request.method !== "POST" || request.url !== "/synthetic/action") {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  const body = await readJson(request);
  state.requests.push({ method: request.method, url: request.url, body });
  const requestIndex = state.requests.length;

  switch (behavior) {
    case "success":
      state.durable_state.committed = true;
      state.durable_state.records.push(recordFor(body, "committed", requestIndex));
      sendJson(response, 200, { ok: true, visual_success: true, durable_success: true });
      return;
    case "validation_error":
      state.durable_state.validation_error = true;
      sendJson(response, 422, { ok: false, error: "synthetic_validation_error", durable_success: false });
      return;
    case "timeout":
      await delay(timeoutMs);
      sendJson(response, 504, { ok: false, error: "synthetic_timeout", durable_success: false });
      return;
    case "partial_write":
      state.durable_state.partial = true;
      state.durable_state.records.push(recordFor(body, "partial", requestIndex));
      sendJson(response, 207, { ok: false, partial: true, durable_success: false });
      return;
    case "fake_success":
      state.durable_state.fake_success = true;
      sendJson(response, 200, { ok: true, visual_success: true, durable_success: false });
      return;
    case "duplicate_entity":
      state.durable_state.duplicate_entity = true;
      state.durable_state.records.push(...duplicateRecordsFor(body, requestIndex));
      sendJson(response, 409, {
        ok: false,
        error: "synthetic_duplicate_entity",
        durable_success: false,
        candidate_count: 2,
      });
      return;
    case "stale_entity":
      state.durable_state.stale_entity = true;
      state.durable_state.records.push(staleRecordFor(body, requestIndex));
      sendJson(response, 409, {
        ok: false,
        error: "synthetic_stale_entity",
        durable_success: false,
        stale: true,
      });
      return;
    case "downstream_failure":
      state.durable_state.downstream_failed = true;
      sendJson(response, 503, { ok: false, error: "synthetic_downstream_failure", durable_success: false });
      return;
  }
}

function recordFor(
  body: unknown,
  state: "committed" | "partial" | "duplicate" | "stale",
  requestIndex: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const digest = createHash("sha256")
    .update(stableJson({ body, requestIndex, state }), "utf8")
    .digest("hex")
    .slice(0, 12);
  return {
    synthetic_record_id: `record_${digest}_${state}`,
    write_state: state,
    body,
    ...extra,
  };
}

function duplicateRecordsFor(body: unknown, requestIndex: number): Record<string, unknown>[] {
  const displayName = entityDisplayNameFor(body, requestIndex);
  return [0, 1].map((candidateIndex) => recordFor(
    {
      ...recordBodyObject(body),
      display_name: displayName,
      duplicate_candidate_index: candidateIndex + 1,
    },
    "duplicate",
    requestIndex + candidateIndex,
    {
      display_name: displayName,
      duplicate_group_id: `duplicate_${createHash("sha256")
        .update(stableJson({ body, requestIndex, displayName }), "utf8")
        .digest("hex")
        .slice(0, 12)}`,
      duplicate_candidate_index: candidateIndex + 1,
    }
  ));
}

function staleRecordFor(body: unknown, requestIndex: number): Record<string, unknown> {
  const bodyObject = recordBodyObject(body);
  const observedVersion = numericField(bodyObject, ["version", "observed_version", "etag_version"], 1);
  const currentVersion = Math.max(observedVersion + 1, numericField(bodyObject, ["current_version"], observedVersion + 1));
  return recordFor(
    {
      ...bodyObject,
      observed_version: observedVersion,
      current_version: currentVersion,
    },
    "stale",
    requestIndex,
    {
      stale: true,
      observed_version: observedVersion,
      current_version: currentVersion,
    }
  );
}

function entityDisplayNameFor(body: unknown, requestIndex: number): string {
  const bodyObject = recordBodyObject(body);
  for (const key of ["display_name", "name", "label", "entity_name"]) {
    const value = bodyObject[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return `synthetic_entity_${requestIndex}`;
}

function numericField(body: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = body[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function recordBodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>) }
    : { value: body };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)])
  );
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}
