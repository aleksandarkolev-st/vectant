import { describe, expect, it } from "vitest";
import {
  assertProductionDojoProofSigner,
  createEd25519DojoProofSigner,
  createEd25519DojoProofVerifier,
  createExternalCommandDojoProofSigner,
  createLocalHmacDojoProofSigner,
  encodeDojoProofSignatureEnvelope,
  generateEd25519DojoProofKeyPair,
  parseDojoProofSignatureEnvelope,
} from "../../src/dojo/proof/signing.js";

describe("Dojo proof signing", () => {
  it("signs and verifies local HMAC payloads for development compatibility", () => {
    const signer = createLocalHmacDojoProofSigner({ key: "unit-test-key", key_id: "hmac-key-a" });
    const signature = signer.sign(payload());

    expect(signature).toEqual(expect.objectContaining({
      algorithm: "hmac-sha256",
      key_id: "hmac-key-a",
      signature: expect.stringMatching(/^hmac-sha256:/),
    }));
    expect(signer.verify(payload(), signature)).toBe(true);
    expect(signer.verify(`${payload()}-tampered`, signature)).toBe(false);
  });

  it("signs Ed25519 payloads and verifies them with the public key", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: keyPair.key_id,
      public_key_pem: keyPair.public_key_pem,
    });
    const signature = signer.sign(payload());

    expect(signature).toEqual(expect.objectContaining({
      algorithm: "ed25519",
      key_id: "ed-key-a",
      signature: expect.stringMatching(/^ed25519:/),
    }));
    expect(verifier.verify(payload(), signature)).toBe(true);
    expect(verifier.verify(`${payload()}-tampered`, signature)).toBe(false);
  });

  it("rejects wrong Ed25519 key IDs", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: "ed-key-b",
      public_key_pem: keyPair.public_key_pem,
    });

    expect(verifier.verify(payload(), signer.sign(payload()))).toBe(false);
  });

  it("signs through an external command signer and verifies with the public key", () => {
    const keyPair = generateEd25519DojoProofKeyPair("external-ed-key-a");
    const signer = createExternalCommandDojoProofSigner({
      key_id: keyPair.key_id,
      command: process.execPath,
      args: ["-e", externalSignerCommandSource()],
      env: {
        ...process.env,
        DOJO_TEST_PRIVATE_KEY_PEM: keyPair.private_key_pem,
      },
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: keyPair.key_id,
      public_key_pem: keyPair.public_key_pem,
    });
    const signature = signer.sign(payload());

    expect(signer.local_development_only).toBe(false);
    expect(signature).toEqual(expect.objectContaining({
      algorithm: "ed25519",
      key_id: keyPair.key_id,
      signature: expect.stringMatching(/^ed25519:/),
    }));
    expect(verifier.verify(payload(), signature)).toBe(true);
  });

  it("fails closed when an external command signer exits or returns the wrong key", () => {
    const keyPair = generateEd25519DojoProofKeyPair("external-ed-key-a");
    expect(() => createExternalCommandDojoProofSigner({
      key_id: keyPair.key_id,
      command: process.execPath,
      args: ["-e", "process.stderr.write('kms unavailable'); process.exit(2);"],
    }).sign(payload())).toThrow("dojo_external_proof_signer_failed:kms unavailable");

    expect(() => createExternalCommandDojoProofSigner({
      key_id: keyPair.key_id,
      command: process.execPath,
      args: ["-e", externalSignerCommandSource({ wrong_key_id: "external-ed-key-b" })],
      env: {
        ...process.env,
        DOJO_TEST_PRIVATE_KEY_PEM: keyPair.private_key_pem,
      },
    }).sign(payload())).toThrow("dojo_external_proof_signer_key_mismatch");
  });

  it("encodes and parses signature envelopes without breaking legacy HMAC signatures", () => {
    const hmacSigner = createLocalHmacDojoProofSigner({ key: "unit-test-key", key_id: "hmac-key-a" });
    const hmacSignature = hmacSigner.sign(payload());
    const hmacEncoded = encodeDojoProofSignatureEnvelope(hmacSignature);

    expect(hmacEncoded).toMatch(/^hmac-sha256:/);
    expect(parseDojoProofSignatureEnvelope({
      algorithm: "hmac-sha256",
      key_id: "hmac-key-a",
      signature: hmacEncoded,
    })).toEqual(hmacSignature);

    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    const edSigner = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const edSignature = edSigner.sign(payload());
    const edEncoded = encodeDojoProofSignatureEnvelope(edSignature);

    expect(edEncoded).toMatch(/^ed25519:ed-key-a:/);
    expect(parseDojoProofSignatureEnvelope({
      algorithm: "ed25519",
      key_id: "fallback-key",
      signature: edEncoded,
    })).toEqual(edSignature);
  });

  it("rejects local/default signers for production use", () => {
    expect(() => assertProductionDojoProofSigner(createLocalHmacDojoProofSigner())).toThrow(
      "dojo_proof_signer_not_production_ready"
    );

    const keyPair = generateEd25519DojoProofKeyPair("ed-key-prod");
    expect(() => assertProductionDojoProofSigner(createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    }))).not.toThrow();
  });
});

function payload(): string {
  return JSON.stringify({
    capsule_id: "capsule-a",
    skill_id: "skill-a",
    evidence_record_ids: ["evidence-a"],
    ledger_checkpoint_hash: "a".repeat(64),
  });
}

function externalSignerCommandSource(input: { wrong_key_id?: string } = {}): string {
  return `
    const { sign } = require("node:crypto");
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(body);
      if (request.schema_version !== "synthi.dojo.externalSignerRequest.v1") process.exit(8);
      const signature = sign(null, Buffer.from(request.payload, "utf8"), process.env.DOJO_TEST_PRIVATE_KEY_PEM).toString("base64url");
      process.stdout.write(JSON.stringify({
        schema_version: "synthi.dojo.externalSignerResponse.v1",
        algorithm: "ed25519",
        key_id: ${JSON.stringify(input.wrong_key_id)} || request.key_id,
        signature
      }));
    });
  `;
}
