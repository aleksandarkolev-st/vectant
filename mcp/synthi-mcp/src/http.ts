#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Pool } from "pg";
import { loadEnvFile } from "./util/env.js";

const __envLoad = loadEnvFile();

if (!process.env["SYNTHI_VISION_BACKEND"]) {
  process.env["SYNTHI_VISION_BACKEND"] = "agent_side";
}

if (
  process.env["SYNTHI_VISION_BACKEND"] === "gemini_api"
  && !process.env["GEMINI_API_KEY"]
  && !process.env["GOOGLE_API_KEY"]
) {
  throw new Error(
    "gemini_api_no_key: SYNTHI_VISION_BACKEND=gemini_api requires GEMINI_API_KEY or GOOGLE_API_KEY"
  );
}

import { createSynthiServer } from "./server.js";
import { resolveExternalTools } from "./external/index.js";
import { session } from "./session.js";
import { requestRegistry } from "./util/request_registry.js";
import { performShutdown } from "./shutdown.js";
import {
  FileSnapshotPersistor,
  snapshotStore,
} from "./snapshot/index.js";
import { applyDojoPostgresMigrations } from "./dojo/store/postgres_proof_store.js";
import { PostgresTherapeuticProductionRuntimeStateStore } from "./dojo/tomography/production_runtime_state_store.js";
import type { TherapeuticDurableRuntimeState, TherapeuticTenantScope } from "./dojo/tomography/index.js";

type HttpMcpConfig = {
  host: string;
  port: number;
  path: string;
  healthPath: string;
  maxBodyBytes: number;
  bearerToken: string;
  bearerHeader: string;
  defaultSessionId?: string;
  defaultSignalingUrl: string;
  therapeuticProduction: TherapeuticProductionHttpConfig;
};

type TherapeuticProductionHttpConfig = {
  enabled: boolean;
  storePath: string;
  probePath: string;
  storeBearerToken: string;
  probeBearerToken: string;
  postgresUrl: string;
  probeUpstreamUrl: string;
  probeUpstreamBearerToken: string;
};

type HttpMcpSession = {
  server: ReturnType<typeof createSynthiServer>;
  transport: StreamableHTTPServerTransport;
};

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? "";
    if (!raw.startsWith("--")) continue;
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex >= 0) {
      out[raw.slice(2, equalsIndex)] = raw.slice(equalsIndex + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function stringArg(args: Record<string, string | boolean>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (!value || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}_invalid:${value}`);
  }
  return parsed;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeHeaderName(value: string | undefined, fallback: string): string {
  const raw = (value?.trim() || fallback).toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(raw)) {
    throw new Error(`synthi_mcp_http_bearer_header_invalid:${value || ""}`);
  }
  return raw;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

function boolFromEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function resolveConfig(args: Record<string, string | boolean>, env = process.env): HttpMcpConfig {
  const defaultSessionId = stringArg(args, "session")
    ?? stringArg(args, "session-id")
    ?? env["SYNTHI_SESSION_ID"];
  const defaultSignalingUrl = stringArg(args, "signaling-url")
    ?? env["SYNTHI_SIGNALING_URL"]
    ?? "ws://localhost:9000";
  const therapeuticProductionEnabled = boolFromEnv(env["SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED"]);
  const therapeuticProduction: TherapeuticProductionHttpConfig = {
    enabled: therapeuticProductionEnabled,
    storePath: normalizePath(env["SYNTHI_THERAPEUTIC_PROD_STORE_PATH"], "/therapeutic/runtime-state"),
    probePath: normalizePath(env["SYNTHI_THERAPEUTIC_PROD_PROBE_PATH"], "/therapeutic/incident-response"),
    storeBearerToken: env["SYNTHI_THERAPEUTIC_PROD_STORE_AUTH_TOKEN"]?.trim() ?? "",
    probeBearerToken: env["SYNTHI_THERAPEUTIC_PROD_PROBE_AUTH_TOKEN"]?.trim() ?? "",
    postgresUrl: (
      env["SYNTHI_THERAPEUTIC_PROD_POSTGRES_URL"]
      ?? env["SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL"]
      ?? env["DATABASE_URL"]
      ?? ""
    ).trim(),
    probeUpstreamUrl: env["SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_URL"]?.trim() ?? "",
    probeUpstreamBearerToken: env["SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_AUTH_TOKEN"]?.trim() ?? "",
  };
  const config = {
    host: stringArg(args, "host") ?? env["SYNTHI_MCP_HTTP_HOST"] ?? "127.0.0.1",
    port: parsePositiveInt(
      stringArg(args, "port") ?? env["SYNTHI_MCP_HTTP_PORT"],
      9467,
      "synthi_mcp_http_port",
    ),
    path: normalizePath(stringArg(args, "path") ?? env["SYNTHI_MCP_HTTP_PATH"], "/mcp"),
    healthPath: normalizePath(stringArg(args, "health-path") ?? env["SYNTHI_MCP_HTTP_HEALTH_PATH"], "/healthz"),
    maxBodyBytes: parsePositiveInt(
      stringArg(args, "max-body-bytes") ?? env["SYNTHI_MCP_HTTP_MAX_BODY_BYTES"],
      1024 * 1024,
      "synthi_mcp_http_max_body_bytes",
    ),
    bearerToken: stringArg(args, "bearer-token")
      ?? env["SYNTHI_MCP_HTTP_BEARER_TOKEN"]
      ?? env["SYNTHI_DOJO_MCP_BEARER_TOKEN"]
      ?? "",
    bearerHeader: normalizeHeaderName(
      stringArg(args, "bearer-header") ?? env["SYNTHI_MCP_HTTP_BEARER_HEADER"],
      "authorization",
    ),
    ...(defaultSessionId !== undefined ? { defaultSessionId } : {}),
    defaultSignalingUrl,
    therapeuticProduction,
  };
  if (!config.bearerToken && !isLoopbackHost(config.host)) {
    throw new Error("synthi_mcp_http_bearer_token_required_for_non_loopback_host");
  }
  if (config.therapeuticProduction.enabled) {
    if (!config.therapeuticProduction.postgresUrl) {
      throw new Error("therapeutic_production_http_postgres_url_required");
    }
    if (!config.therapeuticProduction.storeBearerToken) {
      throw new Error("therapeutic_production_http_store_bearer_token_required");
    }
    if (!config.therapeuticProduction.probeBearerToken) {
      throw new Error("therapeutic_production_http_probe_bearer_token_required");
    }
    validateExternalHttpsUrl(config.therapeuticProduction.probeUpstreamUrl, "therapeutic_production_probe_upstream_url");
  }
  return config;
}

function sendJson(res: ServerResponse, statusCode: number, value: unknown): void {
  if (res.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isAuthorized(req: IncomingMessage, bearerToken: string, bearerHeader: string): boolean {
  if (!bearerToken) return true;
  const header = req.headers[bearerHeader] || "";
  const value = Array.isArray(header) ? header[0] ?? "" : header;
  const prefix = "Bearer ";
  if (!value.startsWith(prefix)) return false;
  return secureStringEqual(value.slice(prefix.length), bearerToken);
}

function secureStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new HttpError(413, "request_body_too_large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "request_body_invalid_json");
  }
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
}

function requireBearerAuth(
  req: IncomingMessage,
  res: ServerResponse,
  bearerToken: string,
  message: string,
): boolean {
  if (isAuthorized(req, bearerToken, "authorization")) return true;
  res.setHeader("www-authenticate", "Bearer");
  sendJson(res, 401, {
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: null,
  });
  return false;
}

function requireTenantScopeHeaders(req: IncomingMessage): TherapeuticTenantScope {
  const tenantId = headerValue(req, "x-synthi-tenant-id").trim();
  const workspaceId = headerValue(req, "x-synthi-workspace-id").trim();
  const actorId = headerValue(req, "x-synthi-actor-id").trim();
  if (!tenantId || !workspaceId) {
    throw new HttpError(400, "therapeutic_production_tenant_scope_headers_required");
  }
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId,
    ...(actorId ? { actor_id: actorId } : {}),
  };
}

function validateExternalHttpsUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}_invalid`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label}_must_be_https`);
  const host = parsed.hostname.toLowerCase();
  if (
    isLoopbackHost(host)
    || host.endsWith(".test")
    || host.endsWith(".example")
    || host.includes("localhost")
  ) {
    throw new Error(`${label}_must_be_external`);
  }
}

function storeRecordIdFromPath(pathname: string, storePath: string): string | null {
  const prefix = `${storePath.replace(/\/$/, "")}/`;
  if (!pathname.startsWith(prefix)) return null;
  const suffix = pathname.slice(prefix.length);
  if (!suffix || suffix.includes("/")) return null;
  return decodeURIComponent(suffix);
}

export function parseTherapeuticStateAppend(
  body: unknown,
  headerTenantScope: TherapeuticTenantScope,
): {
  tenant_scope: TherapeuticTenantScope;
  task_id: string;
  state: TherapeuticDurableRuntimeState;
  state_sha256?: string;
  created_at?: string;
  created_by?: string;
  record_id?: string;
} {
  if (!isRecord(body)) throw new HttpError(400, "therapeutic_production_state_append_body_required");
  if (body["schema_version"] !== "synthi.dojo.therapeuticProductionStateAppend.v1") {
    throw new HttpError(400, "therapeutic_production_state_append_schema_invalid");
  }
  const tenantScope = body["tenant_scope"];
  const state = body["state"];
  const taskId = stringField(body, "task_id", true);
  if (!isRecord(tenantScope) || !isRecord(state)) {
    throw new HttpError(400, "therapeutic_production_state_append_payload_invalid");
  }
  const bodyTenantScope: TherapeuticTenantScope = {
    tenant_id: stringField(tenantScope, "tenant_id", true),
    workspace_id: stringField(tenantScope, "workspace_id", true),
    ...(stringField(tenantScope, "actor_id", false) ? { actor_id: stringField(tenantScope, "actor_id", false) } : {}),
    ...(stringField(tenantScope, "data_region", false) ? { data_region: stringField(tenantScope, "data_region", false) } : {}),
  };
  if (
    bodyTenantScope.tenant_id !== headerTenantScope.tenant_id
    || bodyTenantScope.workspace_id !== headerTenantScope.workspace_id
    || (
      headerTenantScope.actor_id
      && bodyTenantScope.actor_id
      && bodyTenantScope.actor_id !== headerTenantScope.actor_id
    )
  ) {
    throw new HttpError(403, "therapeutic_production_tenant_scope_mismatch");
  }
  return {
    tenant_scope: {
      ...bodyTenantScope,
      ...(headerTenantScope.actor_id ? { actor_id: headerTenantScope.actor_id } : {}),
    },
    task_id: taskId,
    state: state as unknown as TherapeuticDurableRuntimeState,
    ...(stringField(body, "state_sha256", false) ? { state_sha256: stringField(body, "state_sha256", false) } : {}),
    ...(stringField(body, "created_at", false) ? { created_at: stringField(body, "created_at", false) } : {}),
    ...(stringField(body, "created_by", false) ? { created_by: stringField(body, "created_by", false) } : {}),
    ...(stringField(body, "record_id", false) ? { record_id: stringField(body, "record_id", false) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, required: true): string;
function stringField(record: Record<string, unknown>, key: string, required: false): string | undefined;
function stringField(record: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new HttpError(400, `therapeutic_production_${key}_required`);
    return undefined;
  }
  return value.trim();
}

async function main(): Promise<void> {
  if (__envLoad.path) {
    process.stderr.write(
      `synthi-mcp env: loaded ${__envLoad.loaded} var(s) from ${__envLoad.path} (${__envLoad.skipped_existing} already set)\n`
    );
  }

  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig(args);
  const therapeuticPostgresPool = config.therapeuticProduction.enabled
    ? new Pool({ connectionString: config.therapeuticProduction.postgresUrl })
    : null;
  const therapeuticRuntimeStateStore = therapeuticPostgresPool
    ? new PostgresTherapeuticProductionRuntimeStateStore(therapeuticPostgresPool)
    : null;
  if (therapeuticPostgresPool) {
    await applyDojoPostgresMigrations(therapeuticPostgresPool);
    process.stderr.write("synthi-mcp therapeutic production: postgres-backed endpoints enabled\n");
  }

  const snapshotDir = process.env["SYNTHI_SNAPSHOT_DIR"];
  if (snapshotDir) {
    snapshotStore.setPersistor(new FileSnapshotPersistor(snapshotDir));
    process.stderr.write(`synthi-mcp snapshots: file-backed at ${snapshotDir}\n`);
  }

  const externalTools = await resolveExternalTools();
  if (externalTools.descriptors.length > 0) {
    process.stderr.write(`synthi-mcp external: ${externalTools.descriptors.length} proxied tool(s) advertised\n`);
  }

  const sessions = new Map<string, HttpMcpSession>();

  const createSession = async (): Promise<StreamableHTTPServerTransport> => {
    const server = createSynthiServer({
      defaultSessionId: config.defaultSessionId,
      defaultSignalingUrl: config.defaultSignalingUrl,
      externalTools,
    });
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
    };
    await server.connect(transport);
    return transport;
  };

  const getSessionId = (req: IncomingMessage): string | undefined => {
    const raw = req.headers["mcp-session-id"];
    if (Array.isArray(raw)) return raw[0];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };

  const closeMcpSessions = async (): Promise<void> => {
    const active = Array.from(sessions.values());
    sessions.clear();
    await Promise.allSettled(
      active.map(async ({ server, transport }) => {
        await transport.close();
        await server.close();
      }),
    );
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname === config.healthPath && req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          name: "synthi-mcp-http",
          path: config.path,
          auth_required: Boolean(config.bearerToken),
          auth_header: config.bearerToken ? config.bearerHeader : null,
          therapeutic_production_endpoints_enabled: config.therapeuticProduction.enabled,
        });
        return;
      }

      if (
        config.therapeuticProduction.enabled
        && url.pathname === config.therapeuticProduction.storePath
        && req.method === "POST"
      ) {
        if (!requireBearerAuth(
          req,
          res,
          config.therapeuticProduction.storeBearerToken,
          "therapeutic_production_store_unauthorized",
        )) return;
        if (!therapeuticRuntimeStateStore) throw new HttpError(503, "therapeutic_production_store_unavailable");
        const body = await readJsonBody(req, config.maxBodyBytes);
        const tenantScope = requireTenantScopeHeaders(req);
        const record = await therapeuticRuntimeStateStore.appendState(parseTherapeuticStateAppend(body, tenantScope));
        sendJson(res, 201, {
          record_id: record.record_id,
          state_sha256: record.state_sha256,
          created_at: record.created_at,
        });
        return;
      }

      const therapeuticRuntimeRecordId = config.therapeuticProduction.enabled
        ? storeRecordIdFromPath(url.pathname, config.therapeuticProduction.storePath)
        : null;
      if (therapeuticRuntimeRecordId && req.method === "GET") {
        if (!requireBearerAuth(
          req,
          res,
          config.therapeuticProduction.storeBearerToken,
          "therapeutic_production_store_unauthorized",
        )) return;
        if (!therapeuticRuntimeStateStore) throw new HttpError(503, "therapeutic_production_store_unavailable");
        const tenantScope = requireTenantScopeHeaders(req);
        const record = await therapeuticRuntimeStateStore.getState({
          tenant_id: tenantScope.tenant_id,
          workspace_id: tenantScope.workspace_id,
          record_id: therapeuticRuntimeRecordId,
        });
        if (!record) throw new HttpError(404, "therapeutic_production_state_not_found");
        sendJson(res, 200, record);
        return;
      }

      if (
        config.therapeuticProduction.enabled
        && url.pathname === config.therapeuticProduction.probePath
        && req.method === "POST"
      ) {
        if (!requireBearerAuth(
          req,
          res,
          config.therapeuticProduction.probeBearerToken,
          "therapeutic_production_probe_unauthorized",
        )) return;
        const body = await readJsonBody(req, config.maxBodyBytes);
        const upstreamResponse = await fetch(config.therapeuticProduction.probeUpstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.therapeuticProduction.probeUpstreamBearerToken
              ? { authorization: `Bearer ${config.therapeuticProduction.probeUpstreamBearerToken}` }
              : {}),
            "x-synthi-tenant-id": headerValue(req, "x-synthi-tenant-id"),
            "x-synthi-workspace-id": headerValue(req, "x-synthi-workspace-id"),
            "x-synthi-actor-id": headerValue(req, "x-synthi-actor-id"),
            "x-synthi-runtime-session-id": headerValue(req, "x-synthi-runtime-session-id"),
          },
          body: JSON.stringify(body ?? {}),
        });
        const text = await upstreamResponse.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { upstream_non_json_response: true };
        }
        sendJson(res, upstreamResponse.status, parsed);
        return;
      }

      if (url.pathname !== config.path) {
        sendJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32004, message: "mcp_http_path_not_found" },
          id: null,
        });
        return;
      }

      if (!isAuthorized(req, config.bearerToken, config.bearerHeader)) {
        res.setHeader("www-authenticate", "Bearer");
        sendJson(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "mcp_http_unauthorized" },
          id: null,
        });
        return;
      }

      const parsedBody = req.method === "POST"
        ? await readJsonBody(req, config.maxBodyBytes)
        : undefined;
      const sessionId = getSessionId(req);
      const existingSession = sessionId ? sessions.get(sessionId) : undefined;
      if (existingSession) {
        await existingSession.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === "POST" && isInitializeRequest(parsedBody)) {
        const newTransport = await createSession();
        await newTransport.handleRequest(req, res, parsedBody);
        return;
      }

      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "mcp_http_valid_session_required" },
        id: null,
      });
      return;
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      sendJson(res, statusCode, {
        jsonrpc: "2.0",
        error: {
          code: statusCode === 500 ? -32603 : -32000,
          message: error instanceof Error ? error.message : String(error),
        },
        id: null,
      });
    }
  });

  const shutdown = async (): Promise<void> => {
    await performShutdown({
      requestRegistry,
      session,
      server: { close: closeMcpSessions },
      metricsServer: httpServer,
      logError: (step, err) => {
        process.stderr.write(
          `synthi-mcp-http shutdown[${step}]: ${err instanceof Error ? err.message : String(err)}\n`
        );
      },
    });
    await therapeuticPostgresPool?.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
      httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      process.stderr.write(
        `synthi-mcp http: http://${config.host}:${config.port}${config.path}`
        + `${config.bearerToken ? ` (token-gated via ${config.bearerHeader})` : " (no auth - local only)"}\n`
      );
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`synthi-mcp-http fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
