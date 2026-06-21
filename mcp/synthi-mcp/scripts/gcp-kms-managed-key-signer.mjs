#!/usr/bin/env node
/*
 * Dojo managed-key signer for Google Cloud KMS.
 *
 * The script implements the generic Dojo managed-key command protocol. It does
 * not know about a tenant, workspace, or edge case. The caller supplies the KMS
 * CryptoKeyVersion resource in request.key_uri and the script signs the exact
 * UTF-8 payload through Cloud KMS asymmetricSign.
 */

import { spawnSync } from "node:child_process";

const REQUEST_SCHEMA = "synthi.dojo.managedKeySignerRequest.v1";
const RESPONSE_SCHEMA = "synthi.dojo.managedKeySignerResponse.v1";
const DEFAULT_KMS_API_BASE_URL = "https://cloudkms.googleapis.com";
const DEFAULT_METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function main() {
  const input = await readStdin();
  const request = parseRequest(input);
  const keyResource = normalizeKmsKeyVersionResource(request.key_uri);
  const token = await resolveAccessToken();
  const response = await signWithKms({
    keyResource,
    payload: request.payload,
    accessToken: token,
    baseUrl: process.env.SYNTHI_GCP_KMS_API_BASE_URL || DEFAULT_KMS_API_BASE_URL,
  });

  const signature = Buffer.from(response.signature, "base64").toString("base64url");
  process.stdout.write(JSON.stringify({
    schema_version: RESPONSE_SCHEMA,
    algorithm: "ed25519",
    key_id: request.key_id,
    key_uri: request.key_uri,
    key_custody: "managed",
    signature: `ed25519:${signature}`,
  }));
}

function parseRequest(input) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("dojo_gcp_kms_signer_request_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dojo_gcp_kms_signer_request_invalid");
  }
  if (parsed.schema_version !== REQUEST_SCHEMA) {
    throw new Error("dojo_gcp_kms_signer_request_schema_invalid");
  }
  if (parsed.algorithm !== "ed25519") {
    throw new Error("dojo_gcp_kms_signer_algorithm_unsupported");
  }
  for (const field of ["key_id", "key_uri", "payload"]) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new Error(`dojo_gcp_kms_signer_${field}_required`);
    }
  }
  return {
    schema_version: REQUEST_SCHEMA,
    algorithm: "ed25519",
    key_id: parsed.key_id,
    key_uri: parsed.key_uri,
    payload: parsed.payload,
  };
}

function normalizeKmsKeyVersionResource(value) {
  const trimmed = String(value || "").trim();
  const withoutScheme = trimmed
    .replace(/^gcp-kms:\/\//, "")
    .replace(/^\/\/cloudkms\.googleapis\.com\//, "")
    .replace(/^https:\/\/cloudkms\.googleapis\.com\/v1\//, "");
  if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[^/]+$/.test(withoutScheme)) {
    throw new Error("dojo_gcp_kms_signer_key_uri_invalid");
  }
  return withoutScheme;
}

async function resolveAccessToken() {
  const explicit = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
  if (explicit?.trim()) return explicit.trim();

  try {
    const metadataUrl = process.env.SYNTHI_GCP_METADATA_TOKEN_URL || DEFAULT_METADATA_TOKEN_URL;
    const response = await fetch(metadataUrl, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(Number(process.env.SYNTHI_GCP_METADATA_TOKEN_TIMEOUT_MS || 3000)),
    });
    if (response.ok) {
      const payload = await response.json();
      if (typeof payload.access_token === "string" && payload.access_token.trim()) {
        return payload.access_token.trim();
      }
    }
  } catch {
    // Fall through to the explicit opt-in local gcloud fallback below.
  }

  if (process.env.SYNTHI_GCP_KMS_SIGNER_ALLOW_GCLOUD === "1") {
    const gcloudBin = process.env.GCLOUD_BIN || "gcloud";
    const result = spawnSync(gcloudBin, ["auth", "print-access-token"], {
      encoding: "utf8",
      timeout: Number(process.env.SYNTHI_GCP_KMS_SIGNER_GCLOUD_TIMEOUT_MS || 5000),
      windowsHide: true,
    });
    if (result.status === 0 && String(result.stdout || "").trim()) {
      return String(result.stdout).trim();
    }
  }

  throw new Error("dojo_gcp_kms_signer_access_token_unavailable");
}

async function signWithKms({ keyResource, payload, accessToken, baseUrl }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/${keyResource}:asymmetricSign`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: Buffer.from(payload, "utf8").toString("base64"),
    }),
    signal: AbortSignal.timeout(Number(process.env.SYNTHI_GCP_KMS_SIGNER_TIMEOUT_MS || 10000)),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`dojo_gcp_kms_signer_response_invalid:${response.status}`);
  }
  if (!response.ok) {
    const status = response.status || "unknown";
    const code = parsed?.error?.status || parsed?.error?.code || status;
    throw new Error(`dojo_gcp_kms_signer_request_failed:${code}`);
  }
  if (typeof parsed.signature !== "string" || !parsed.signature.trim()) {
    throw new Error("dojo_gcp_kms_signer_signature_missing");
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.length > Number(process.env.SYNTHI_GCP_KMS_SIGNER_MAX_STDIN_BYTES || 65536)) {
        reject(new Error("dojo_gcp_kms_signer_request_too_large"));
        process.stdin.destroy();
      }
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}
