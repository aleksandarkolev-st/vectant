import { serveHttp } from "../../dist/http.js";
import { RESOURCE_URIS } from "../../dist/resources/index.js";
import { createCodeSiteWarrantContextProvider } from "../../dist/security/codesite_session_warrant_adapter.js";
import { WarrantRequestContextError } from "../../dist/security/warrant_request_context.js";
import { startPrometheusServer } from "../../dist/observability/prometheus_server.js";

function requiredPort(name) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be an available TCP port`);
  }
  return value;
}

function requiredHost(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const host = requiredHost("SYNTHI_LIVE_PROOF_HOST");
const port = requiredPort("SYNTHI_LIVE_PROOF_PORT");
const metricsPort = requiredPort("SYNTHI_LIVE_PROOF_METRICS_PORT");
const proofId = requiredValue("SYNTHI_LIVE_PROOF_ID");
const principal = Object.freeze({
  issuer: `${proofId}:issuer`,
  subject: `${proofId}:subject`,
  workspace: `${proofId}:workspace`,
  project: `${proofId}:project`,
});
const recipient = Object.freeze({ ...principal, subject: `${proofId}:recipient` });
const recipientDirectory = new Map([
  [principal.subject, principal],
  [recipient.subject, recipient],
]);
const resourceCapability = `${principal.issuer}:resource`;
const acceptedResource = RESOURCE_URIS.console;
const reservedRequestIds = new Set();
const warrantId = `${proofId}:warrant`;

process.env.NODE_ENV = "production";
process.env.SYNTHI_WARRANT_MODE = "enforce";
process.env.SYNTHI_MCP_HTTP_HOST = host;
process.env.SYNTHI_MCP_HTTP_PORT = String(port);

const metricsServer = startPrometheusServer({ port: metricsPort, host });
const closeMetrics = () => metricsServer.close();
process.once("SIGINT", closeMetrics);
process.once("SIGTERM", closeMetrics);

const authority = {
  async issue(input) {
    return {
      warrant_id: warrantId,
      subject: input.subject,
      audience: input.audience,
      grants: input.grants,
      issued_at_ms: 0,
      expires_at_ms: input.ttl_ms,
      root_warrant_id: warrantId,
      status: "active",
    };
  },
  async reserve(input) {
    if (reservedRequestIds.has(input.idempotency_key)) {
      return {
        decision: {
          allowed: false,
          reason_code: "receipt_idempotency_key_reused",
          human_reason: "The shared authority already owns this idempotency key.",
        },
      };
    }
    if (input.tool === resourceCapability && input.args?.target !== acceptedResource) {
      return {
        decision: {
          allowed: false,
          reason_code: "resource_not_granted",
          human_reason: "This exact resource is not included in the resolved grant.",
        },
      };
    }
    reservedRequestIds.add(input.idempotency_key);
    return {
      decision: { allowed: true, warrant_id: input.warrant_id },
      reservation: {
        receipt_id: `receipt:${input.idempotency_key}`,
        status: "reserved",
        reserved_at_ms: Date.now(),
      },
    };
  },
  async settle(input) {
    return { receipt_id: input.receipt_id, status: input.outcome };
  },
};

await serveHttp({
  warrantRequestContext: createCodeSiteWarrantContextProvider({
    authenticate: async () => ({
      principal,
      authority,
      serviceAuthentication: {
        transport: `${proofId}:transport`,
        service: `${proofId}:service`,
      },
      resolveResourceGrant: (uri) => ({ capability: resourceCapability, args: { target: uri } }),
      canonicalizeRecipient: async (_issuer, requested) => {
        const canonical = recipientDirectory.get(requested.subject);
        if (!canonical) throw new WarrantRequestContextError("recipient_not_found", 403);
        return canonical;
      },
    }),
  }),
});
