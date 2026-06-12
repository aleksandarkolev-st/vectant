import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY } from "../config/enforcement.js";

export type DojoProofSigningAlgorithm = "hmac-sha256" | "ed25519";

export interface DojoProofSignatureEnvelope {
  algorithm: DojoProofSigningAlgorithm;
  key_id: string;
  signature: string;
}

export interface DojoProofSigner {
  algorithm: DojoProofSigningAlgorithm;
  key_id: string;
  local_development_only: boolean;
  sign(payload: string): DojoProofSignatureEnvelope;
}

export interface DojoProofVerifier {
  algorithm: DojoProofSigningAlgorithm;
  key_id: string;
  verify(payload: string, signature: DojoProofSignatureEnvelope): boolean;
}

export interface Ed25519DojoProofKeyPair {
  key_id: string;
  public_key_pem: string;
  private_key_pem: string;
}

export interface ExternalCommandDojoProofSignerRequest {
  schema_version: "synthi.dojo.externalSignerRequest.v1";
  algorithm: "ed25519";
  key_id: string;
  payload: string;
}

export interface ExternalCommandDojoProofSignerResponse {
  schema_version: "synthi.dojo.externalSignerResponse.v1";
  algorithm: "ed25519";
  key_id: string;
  signature: string;
}

export function canonicalDojoProofPayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDojoProofPayload).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalDojoProofPayload(record[key])}`).join(",")}}`;
}

export function createLocalHmacDojoProofSigner(input: {
  key?: string;
  key_id?: string;
} = {}): DojoProofSigner & DojoProofVerifier {
  const key = input.key ?? DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY;
  const keyId = input.key_id ?? `dojo-hmac-${sha256Hex(key).slice(0, 12)}`;
  return {
    algorithm: "hmac-sha256",
    key_id: keyId,
    local_development_only: key === DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY,
    sign(payload: string): DojoProofSignatureEnvelope {
      return {
        algorithm: "hmac-sha256",
        key_id: keyId,
        signature: `hmac-sha256:${createHmac("sha256", key).update(payload, "utf8").digest("hex")}`,
      };
    },
    verify(payload: string, signature: DojoProofSignatureEnvelope): boolean {
      if (signature.algorithm !== "hmac-sha256" || signature.key_id !== keyId) return false;
      return signature.signature === this.sign(payload).signature;
    },
  };
}

export function generateEd25519DojoProofKeyPair(keyId: string): Ed25519DojoProofKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    key_id: keyId,
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function createEd25519DojoProofSigner(input: {
  key_id: string;
  private_key_pem: string | KeyObject;
}): DojoProofSigner {
  const privateKey = input.private_key_pem;
  return {
    algorithm: "ed25519",
    key_id: input.key_id,
    local_development_only: false,
    sign(payload: string): DojoProofSignatureEnvelope {
      return {
        algorithm: "ed25519",
        key_id: input.key_id,
        signature: `ed25519:${nodeSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url")}`,
      };
    },
  };
}

export function createEd25519DojoProofVerifier(input: {
  key_id: string;
  public_key_pem: string | KeyObject;
}): DojoProofVerifier {
  const publicKey = input.public_key_pem;
  return {
    algorithm: "ed25519",
    key_id: input.key_id,
    verify(payload: string, signature: DojoProofSignatureEnvelope): boolean {
      if (signature.algorithm !== "ed25519" || signature.key_id !== input.key_id) return false;
      const rawSignature = signature.signature.startsWith("ed25519:")
        ? signature.signature.slice("ed25519:".length)
        : signature.signature;
      return nodeVerify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(rawSignature, "base64url"));
    },
  };
}

export function createExternalCommandDojoProofSigner(input: {
  key_id: string;
  command: string;
  args?: string[];
  timeout_ms?: number;
  env?: NodeJS.ProcessEnv;
}): DojoProofSigner {
  const command = input.command.trim();
  if (!command) throw new Error("dojo_external_proof_signing_command_required");
  const args = input.args ?? [];
  if (!args.every((arg) => typeof arg === "string")) throw new Error("dojo_external_proof_signing_args_invalid");
  return {
    algorithm: "ed25519",
    key_id: input.key_id,
    local_development_only: false,
    sign(payload: string): DojoProofSignatureEnvelope {
      const request: ExternalCommandDojoProofSignerRequest = {
        schema_version: "synthi.dojo.externalSignerRequest.v1",
        algorithm: "ed25519",
        key_id: input.key_id,
        payload,
      };
      const result = spawnSync(command, args, {
        input: JSON.stringify(request),
        encoding: "utf8",
        env: input.env ?? process.env,
        timeout: input.timeout_ms ?? 5000,
        windowsHide: true,
      });
      if (result.error) throw new Error(`dojo_external_proof_signer_failed:${result.error.message}`);
      if (result.status !== 0) {
        const stderr = String(result.stderr ?? "").trim();
        throw new Error(`dojo_external_proof_signer_failed:${stderr || `exit_${result.status ?? "unknown"}`}`);
      }
      const response = parseExternalCommandSignerResponse(String(result.stdout ?? ""));
      if (response.key_id !== input.key_id) throw new Error("dojo_external_proof_signer_key_mismatch");
      const signature = response.signature.startsWith("ed25519:")
        ? response.signature
        : `ed25519:${response.signature}`;
      return {
        algorithm: "ed25519",
        key_id: input.key_id,
        signature,
      };
    },
  };
}

export function encodeDojoProofSignatureEnvelope(envelope: DojoProofSignatureEnvelope): string {
  if (envelope.algorithm === "hmac-sha256") return envelope.signature;
  const signatureValue = envelope.signature.startsWith(`${envelope.algorithm}:`)
    ? envelope.signature.slice(`${envelope.algorithm}:`.length)
    : envelope.signature;
  return `${envelope.algorithm}:${envelope.key_id}:${signatureValue}`;
}

export function parseDojoProofSignatureEnvelope(input: {
  signature: string;
  algorithm: DojoProofSigningAlgorithm;
  key_id: string;
}): DojoProofSignatureEnvelope {
  if (input.algorithm === "hmac-sha256") {
    if (!input.signature.startsWith("hmac-sha256:")) throw new Error("dojo_proof_signature_envelope_invalid");
    return {
      algorithm: "hmac-sha256",
      key_id: input.key_id,
      signature: input.signature,
    };
  }
  const prefix = "ed25519:";
  if (!input.signature.startsWith(prefix)) throw new Error("dojo_proof_signature_envelope_invalid");
  const rest = input.signature.slice(prefix.length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex < 1) {
    return {
      algorithm: "ed25519",
      key_id: input.key_id,
      signature: input.signature,
    };
  }
  const keyId = rest.slice(0, separatorIndex);
  const rawSignature = rest.slice(separatorIndex + 1);
  if (!keyId || !rawSignature) throw new Error("dojo_proof_signature_envelope_invalid");
  return {
    algorithm: "ed25519",
    key_id: keyId,
    signature: `${prefix}${rawSignature}`,
  };
}

export function assertProductionDojoProofSigner(signer: DojoProofSigner): void {
  if (signer.local_development_only || signer.algorithm === "hmac-sha256") {
    throw new Error("dojo_proof_signer_not_production_ready");
  }
}

function parseExternalCommandSignerResponse(raw: string): ExternalCommandDojoProofSignerResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("dojo_external_proof_signer_response_invalid");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("dojo_external_proof_signer_response_invalid");
  const response = parsed as Partial<ExternalCommandDojoProofSignerResponse>;
  if (response.schema_version !== "synthi.dojo.externalSignerResponse.v1") {
    throw new Error("dojo_external_proof_signer_response_schema_invalid");
  }
  if (response.algorithm !== "ed25519") throw new Error("dojo_external_proof_signer_algorithm_invalid");
  if (typeof response.key_id !== "string" || !response.key_id.trim()) {
    throw new Error("dojo_external_proof_signer_key_id_invalid");
  }
  if (typeof response.signature !== "string" || !response.signature.trim()) {
    throw new Error("dojo_external_proof_signer_signature_invalid");
  }
  return {
    schema_version: response.schema_version,
    algorithm: response.algorithm,
    key_id: response.key_id,
    signature: response.signature,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
