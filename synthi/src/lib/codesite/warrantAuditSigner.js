import { spawn } from 'child_process';
import { verify as verifySignature } from 'crypto';

const SIGNER_RESPONSE_LIMIT_BYTES = 64 * 1024;

export class ManagedWarrantAuditSignerError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Generic managed-key boundary for warrant audit events. The command belongs
 * to deployment and retains custody of private key material; this process only
 * sees the active key reference, trusted public verification keys, and a
 * detached signature. Keeping previous public keys in the keyset makes a
 * rolling key rotation verifiable without a database rewrite.
 */
export function createManagedWarrantAuditSigner(input) {
  const config = object(input, 'warrant_audit_signer_unconfigured');
  const activeKey = keyReference({ key_id: config.key_id, key_uri: config.key_uri }, 'warrant_audit_signer_unconfigured');
  const command = requiredString(config.command, 'warrant_audit_signer_unconfigured');
  const args = commandArguments(config.command_args);
  const timeoutMs = positiveInteger(config.timeout_ms, 'warrant_audit_signer_unconfigured');
  const trustedKeys = trustedKeyset(config.trusted_keys);
  const activePublicKey = trustedKeys.get(keyReferenceKey(activeKey));
  if (!activePublicKey) throw new ManagedWarrantAuditSignerError('warrant_audit_signer_active_key_untrusted');

  return Object.freeze({
    key_custody: 'managed',
    async sign(payload) {
      const canonicalPayload = requiredString(payload, 'warrant_audit_signature_payload_invalid');
      const response = await invokeSignerCommand(command, args, timeoutMs, {
        schema_version: 'synthi.warrant.managedAuditSignerRequest.v1',
        algorithm: 'ed25519',
        key_id: activeKey.key_id,
        key_uri: activeKey.key_uri,
        payload: canonicalPayload,
      });
      const signature = managedSignatureEnvelope(response);
      if (signature.key_id !== activeKey.key_id || signature.key_uri !== activeKey.key_uri) {
        throw new ManagedWarrantAuditSignerError('warrant_audit_signer_key_mismatch');
      }
      if (!verifyDetachedSignature(canonicalPayload, activePublicKey, signature.signature)) {
        throw new ManagedWarrantAuditSignerError('warrant_audit_signer_signature_invalid');
      }
      return signature;
    },
    async verify(payload, signature) {
      const canonicalPayload = requiredString(payload, 'warrant_audit_signature_payload_invalid');
      let envelope;
      try {
        envelope = managedSignatureEnvelope({
          schema_version: 'synthi.warrant.managedAuditSignerResponse.v1',
          algorithm: 'ed25519',
          key_custody: 'managed',
          ...object(signature, 'warrant_audit_signature_invalid'),
        });
      } catch {
        return false;
      }
      const publicKey = trustedKeys.get(keyReferenceKey(envelope));
      return Boolean(publicKey && verifyDetachedSignature(canonicalPayload, publicKey, envelope.signature));
    },
  });
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagedWarrantAuditSignerError(code);
  return value;
}

function requiredString(value, code) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new ManagedWarrantAuditSignerError(code);
  return value.trim();
}

function positiveInteger(value, code) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new ManagedWarrantAuditSignerError(code);
  return numeric;
}

function keyReference(value, code) {
  const raw = object(value, code);
  return {
    key_id: requiredString(raw.key_id, code),
    key_uri: requiredString(raw.key_uri, code),
  };
}

function keyReferenceKey(value) {
  return `${value.key_id}\u0000${value.key_uri}`;
}

function commandArguments(value) {
  if (value === undefined || value === null || value === '') return [];
  const parsed = typeof value === 'string' ? parseJson(value, 'warrant_audit_signer_args_invalid') : value;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string' && !/[\r\n]/.test(entry))) {
    throw new ManagedWarrantAuditSignerError('warrant_audit_signer_args_invalid');
  }
  return [...parsed];
}

function trustedKeyset(value) {
  const parsed = typeof value === 'string' ? parseJson(value, 'warrant_audit_signer_keyset_invalid') : value;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ManagedWarrantAuditSignerError('warrant_audit_signer_keyset_invalid');
  const trusted = new Map();
  for (const raw of parsed) {
    const reference = keyReference(raw, 'warrant_audit_signer_keyset_invalid');
    const publicKey = publicKeyPem(raw.public_key_pem);
    const identity = keyReferenceKey(reference);
    if (trusted.has(identity)) throw new ManagedWarrantAuditSignerError('warrant_audit_signer_keyset_duplicate');
    trusted.set(identity, publicKey);
  }
  return trusted;
}

function publicKeyPem(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > SIGNER_RESPONSE_LIMIT_BYTES) {
    throw new ManagedWarrantAuditSignerError('warrant_audit_signer_keyset_invalid');
  }
  return value.trim();
}

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    throw new ManagedWarrantAuditSignerError(code);
  }
}

async function invokeSignerCommand(command, args, timeoutMs, request) {
  const output = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      reject(new ManagedWarrantAuditSignerError('warrant_audit_signer_unavailable'));
      return;
    }
    let stdout = '';
    let outputBytes = 0;
    let completed = false;
    const finish = (result) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      result instanceof Error ? reject(result) : resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new ManagedWarrantAuditSignerError('warrant_audit_signer_timeout'));
    }, timeoutMs);
    child.on('error', () => finish(new ManagedWarrantAuditSignerError('warrant_audit_signer_unavailable')));
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > SIGNER_RESPONSE_LIMIT_BYTES) {
        child.kill();
        finish(new ManagedWarrantAuditSignerError('warrant_audit_signer_response_oversize'));
        return;
      }
      stdout += String(chunk);
    });
    child.on('close', (code) => {
      if (code !== 0) return finish(new ManagedWarrantAuditSignerError('warrant_audit_signer_unavailable'));
      finish(stdout);
    });
    child.stdin.on('error', () => finish(new ManagedWarrantAuditSignerError('warrant_audit_signer_unavailable')));
    child.stdin.end(JSON.stringify(request));
  });
  try {
    return JSON.parse(output);
  } catch {
    throw new ManagedWarrantAuditSignerError('warrant_audit_signer_response_invalid');
  }
}

function managedSignatureEnvelope(value) {
  const raw = object(value, 'warrant_audit_signer_response_invalid');
  if (raw.schema_version !== 'synthi.warrant.managedAuditSignerResponse.v1'
    || raw.algorithm !== 'ed25519'
    || raw.key_custody !== 'managed') {
    throw new ManagedWarrantAuditSignerError('warrant_audit_signer_response_invalid');
  }
  const reference = keyReference(raw, 'warrant_audit_signer_response_invalid');
  const signature = requiredString(raw.signature, 'warrant_audit_signer_response_invalid');
  return { ...reference, signature };
}

function verifyDetachedSignature(payload, publicKey, signature) {
  const encoded = signature.startsWith('ed25519:') ? signature.slice('ed25519:'.length) : signature;
  try {
    return verifySignature(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(encoded, 'base64url'));
  } catch {
    return false;
  }
}
