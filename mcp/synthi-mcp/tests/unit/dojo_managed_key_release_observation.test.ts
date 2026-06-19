import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDojoManagedKeySigningObservationPayload,
  resolveDojoManagedKeySigningReleaseObservationConfig,
  runDojoManagedKeySigningReleaseObservation,
} from "../../scripts/dojo-managed-key-signing-release-observation.mjs";
import { validateDojoManagedKeySigningReleaseObservation } from "../../scripts/dojo-release-gate-verify.mjs";
import { generateEd25519DojoProofKeyPair } from "../../src/dojo/proof/signing.js";

describe("Dojo managed-key signing release observation", () => {
  it("observes a configured managed-key signer without exporting local key material", async () => {
    const keyPair = generateEd25519DojoProofKeyPair("managed-release-key-a");
    const keyUri = `kms://tenant-a/proof/${keyPair.key_id}`;
    const outDir = await mkdtemp(path.join(tmpdir(), "dojo-managed-key-release-observation-"));
    const observedAt = new Date().toISOString();
    const payload = buildDojoManagedKeySigningObservationPayload({
      keyId: keyPair.key_id,
      keyUri,
      now: observedAt,
      nonce: "unit-test-nonce",
    });
    const artifacts = await runDojoManagedKeySigningReleaseObservation({
      outDir,
      now: observedAt,
      args: {
        provider: "managed-key-service",
        "key-id": keyPair.key_id,
        "key-uri": keyUri,
        command: process.execPath,
        "command-args": JSON.stringify(["-e", managedKeySignerCommandSource()]),
        "public-key-pem": keyPair.public_key_pem,
        payload,
      },
      env: {
        ...process.env,
        MOCK_MANAGED_KEY_PRIVATE_KEY_PEM: keyPair.private_key_pem,
      },
    });

    expect(artifacts.observation.release_ready).toBe(true);
    expect(artifacts.observation.checks).toEqual(expect.objectContaining({
      managed_key_service_observed: true,
      managed_key_uri_observed: true,
      managed_key_custody_observed: true,
      signature_verified_with_public_key: true,
      signer_outage_fail_closed_observed: true,
      uri_mismatch_rejected_observed: true,
      local_custody_rejected_observed: true,
      release_artifact_digest_observed: true,
    }));
    expect(validateDojoManagedKeySigningReleaseObservation(artifacts.observation)).toEqual([]);
    expect(artifacts.observation.signed_payload_sha256).toBe(sha256(payload));
    const observationText = await readFile(artifacts.observation_path, "utf8");
    const transcriptText = await readFile(artifacts.transcript_path, "utf8");
    expect(observationText).not.toContain(keyPair.private_key_pem);
    expect(transcriptText).not.toContain(keyPair.private_key_pem);
    expect(observationText).not.toContain("MOCK_MANAGED_KEY_PRIVATE_KEY_PEM");
    expect(transcriptText).not.toContain("MOCK_MANAGED_KEY_PRIVATE_KEY_PEM");
  });

  it("requires the production managed-key signer contract", async () => {
    await expect(resolveDojoManagedKeySigningReleaseObservationConfig({
      args: {
        provider: "external-command",
      },
      env: {},
    })).rejects.toThrow("dojo_managed_key_release_observation_config_missing");

    await expect(resolveDojoManagedKeySigningReleaseObservationConfig({
      args: {
        provider: "managed-key-service",
        "key-id": "key-a",
        "key-uri": "kms://tenant-a/proof/key-a",
        command: process.execPath,
        "command-args": "[42]",
        "public-key-pem": "-----BEGIN PUBLIC KEY-----\nredacted\n-----END PUBLIC KEY-----",
      },
      env: {},
    })).rejects.toThrow("dojo_managed_key_release_observation_command_args_invalid");
  });

  it("fails closed when configured local signing material is present", async () => {
    const keyPair = generateEd25519DojoProofKeyPair("managed-release-key-b");
    const keyUri = `kms://tenant-b/proof/${keyPair.key_id}`;
    const outDir = await mkdtemp(path.join(tmpdir(), "dojo-managed-key-release-observation-local-"));

    await expect(runDojoManagedKeySigningReleaseObservation({
      outDir,
      args: {
        provider: "managed-key-service",
        "key-id": keyPair.key_id,
        "key-uri": keyUri,
        command: process.execPath,
        "command-args": JSON.stringify(["-e", managedKeySignerCommandSource()]),
        "public-key-pem": keyPair.public_key_pem,
        payload: "configured-local-material-test",
      },
      env: {
        ...process.env,
        MOCK_MANAGED_KEY_PRIVATE_KEY_PEM: keyPair.private_key_pem,
        SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM: keyPair.private_key_pem,
      },
    })).rejects.toThrow("dojo_managed_key_release_observation_checks_missing:no_private_key_material_exported");
  });
});

function managedKeySignerCommandSource(): string {
  return `
    const { sign } = require("node:crypto");
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(body);
      if (request.schema_version !== "synthi.dojo.managedKeySignerRequest.v1") process.exit(8);
      const signature = sign(null, Buffer.from(request.payload, "utf8"), process.env.MOCK_MANAGED_KEY_PRIVATE_KEY_PEM).toString("base64url");
      process.stdout.write(JSON.stringify({
        schema_version: "synthi.dojo.managedKeySignerResponse.v1",
        algorithm: "ed25519",
        key_id: request.key_id,
        key_uri: request.key_uri,
        key_custody: "managed",
        signature
      }));
    });
  `;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
