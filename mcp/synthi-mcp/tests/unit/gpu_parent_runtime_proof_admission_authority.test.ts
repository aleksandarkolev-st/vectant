import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
  GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
  GpuParentRuntimeProofAdmissionAuthority,
  type GpuParentRuntimeProofAdmissionAuthorityContext,
} from "../../src/gpu_parent_runtime_proof_admission_authority.js";
import {
  verifyGpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";
import {
  createGpuHmrMcpAdmissionOnlineReplayAuthorityClient,
  gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA,
} from "../../scripts/lib/gpu-hmr-mcp-admission-online-replay-authority.mjs";

const CHALLENGE = Buffer.alloc(32, 0x42).toString("base64url");
const U64_MAX = 18_446_744_073_709_551_615n;
const TRUST_MATERIAL_KEYS = [
  "schemaVersion",
  "proofAuthority",
  "verificationKey",
  "validationRunChallenge",
  "replayPolicyRequired",
  "freshnessPolicyRequired",
  "onlineReplayAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;
const ONLINE_REPLAY_AUTHORITY_KEYS = [
  "authorityId",
  "authorityGenerationId",
  "responseVerificationKey",
  "endpoint",
  "parentPid",
  "parentStartIdentity",
  "transport",
  "operationTimeoutMs",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "policyHash",
] as const;
const RESPONSE_VERIFICATION_KEY_KEYS = [
  "schemaVersion",
  "algorithm",
  "keyId",
  "publicKey",
] as const;

const authorities = new Set<GpuParentRuntimeProofAdmissionAuthority>();

function createAuthority(
  context: GpuParentRuntimeProofAdmissionAuthorityContext = {},
): GpuParentRuntimeProofAdmissionAuthority {
  const authority = new GpuParentRuntimeProofAdmissionAuthority(context);
  authorities.add(authority);
  return authority;
}

afterEach(async () => {
  await Promise.all([...authorities].map(async (authority) => {
    await authority.dispose();
  }));
  authorities.clear();
});

function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function admissionInput(): GpuParentRuntimeProofAdmissionReceiptInput {
  const controlBindingCanonicalSha256 = hash("4");
  return {
    transportSessionId: "opaque-transport-session:authority-01",
    compileRequestNonce: `gpu-proof-transport-request:${"1".repeat(32)}`,
    computeExpectedOutputContractHash: hash("a"),
    computeExpectedOutputSemanticsHash: hash("b"),
    workerKeyId:
      `gpu-hmr-runtime-evidence-transport-key:sha256:${"2".repeat(64)}`,
    workerKeyAnnouncementId:
      `gpu-hmr-runtime-evidence-transport-key-announcement:sha256:${"3".repeat(64)}`,
    workerProcessId: "9123",
    controlBindingId:
      `gpu-parent-runtime-proof-control-binding:${controlBindingCanonicalSha256}`,
    controlBindingCanonicalSha256,
    controlTransportReceiptId:
      `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"5".repeat(64)}`,
    controlObservationContextHash: hash("6"),
    parentReceiptId:
      `gpu-parent-runtime-proof-receipt:sha256:${"7".repeat(64)}`,
    parentTransportReceiptId:
      `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"8".repeat(64)}`,
    parentCanonicalProofSha256: hash("9"),
    parentObservationContextHash: hash("0"),
    requestId: `gpu-reload:request:${"c".repeat(32)}`,
    sourceEditId: `source-edit:sha256:${"d".repeat(64)}`,
    artifactContentHash: hash("e"),
    fullRuntimeProofId: `gpu-runtime-proof:sha256:${"f".repeat(64)}`,
    proofLedgerId: `gpu-ledger-proof:sha256:${"1".repeat(64)}`,
    runnerProcessId: 8123,
    runnerRuntimeSessionId: "opaque-runtime-session:authority-02",
    runnerChallenge: "23456789abcdef0123456789abcdef01",
    commandEnvelopeSha256: hash("2"),
    protectedProofJsonSha256: hash("3"),
  };
}

function activeListeningServers(): Set<unknown> {
  const getActiveHandles = (process as unknown as {
    _getActiveHandles?: () => unknown[];
  })._getActiveHandles;
  if (getActiveHandles === undefined) return new Set();
  return new Set(getActiveHandles().filter((handle) => {
    try {
      const candidate = handle as {
        listening?: unknown;
        address?: unknown;
        close?: unknown;
      };
      return candidate.listening === true
        && typeof candidate.address === "function"
        && typeof candidate.close === "function";
    } catch {
      return false;
    }
  }));
}

function onlineClientProjection(
  authority: Awaited<ReturnType<
    GpuParentRuntimeProofAdmissionAuthority["trustMaterial"]
  >>["onlineReplayAuthority"],
) {
  const client = createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(authority);
  const projection =
    gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(client);
  if (projection === null) throw new Error("online replay client unavailable");
  return projection;
}

describe("GpuParentRuntimeProofAdmissionAuthority", () => {
  it("lazily exports exact frozen v3 trust and answers a live signed probe", async () => {
    const first = createAuthority();
    const trustPromise = first.trustMaterial();

    expect(first.trustMaterial()).toBe(trustPromise);
    const trust = await trustPromise;
    const online = trust.onlineReplayAuthority;

    expect(Object.keys(trust)).toEqual(TRUST_MATERIAL_KEYS);
    expect(trust).toEqual({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      verificationKey: trust.verificationKey,
      validationRunChallenge: trust.validationRunChallenge,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      onlineReplayAuthority: online,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.keys(online)).toEqual(ONLINE_REPLAY_AUTHORITY_KEYS);
    expect(Object.keys(online.responseVerificationKey))
      .toEqual(RESPONSE_VERIFICATION_KEY_KEYS);
    expect(Object.isFrozen(trust)).toBe(true);
    expect(Object.isFrozen(trust.verificationKey)).toBe(true);
    expect(Object.isFrozen(online)).toBe(true);
    expect(Object.isFrozen(online.responseVerificationKey)).toBe(true);
    expect(trust.validationRunChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(online.authorityId)
      .toMatch(/^gpu-hmr-mcp-replay-authority:sha256:[a-f0-9]{64}$/);
    expect(online.authorityGenerationId).toMatch(
      /^gpu-hmr-mcp-online-replay-generation:sha256:[a-f0-9]{64}$/,
    );
    expect(online.responseVerificationKey.keyId).toMatch(
      /^gpu-hmr-mcp-online-replay-response-key:sha256:[a-f0-9]{64}$/,
    );
    expect(online.parentPid).toBe(process.pid);
    expect(online.endpoint).not.toMatch(/synthi|gpu|backend|project/i);
    expect(online).not.toHaveProperty("acceptedForGpuHmr");
    expect(online).not.toHaveProperty("gpuHmrSuccess");
    expect(online).not.toHaveProperty("canSatisfyRuntimeProof");

    const serialized = JSON.stringify(trust);
    expect(serialized).not.toMatch(
      /replayState|authenticationKey|privateKey|private_key|secret|root/i,
    );
    expect(trust).not.toHaveProperty("signer");
    expect(Reflect.ownKeys(first)).not.toContain("receiptSigner");
    expect(Reflect.ownKeys(first)).not.toContain("onlineReplayServerPromise");

    const probe = await onlineClientProjection(online).probe();
    expect(probe).toMatchObject({
      schemaVersion:
        GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA,
      authorityId: online.authorityId,
      authorityGenerationId: online.authorityGenerationId,
      responseKeyId: online.responseVerificationKey.keyId,
      authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
      rollbackProtected: true,
      onlineRequired: true,
      durable: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      revision: "0",
      policyHash: online.policyHash,
    });
    expect(probe.signature).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);
  });

  it("does not start IPC for signer-only channel consumption", async () => {
    const before = activeListeningServers();
    const authority = createAuthority({
      validationRunChallenge: CHALLENGE,
      clockUnixNs: () => 99n,
      nonceBytes: () => Buffer.alloc(32, 0x61),
    });

    const receipt = authority.signer().sign(admissionInput());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(receipt.admittedAtUnixNs).toBe("99");
    expect(activeListeningServers()).toEqual(before);
  });

  it("binds receipt verification material while keeping signer inputs private", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let clockCalls = 0;
    let nonceCalls = 0;
    const authority = createAuthority({
      privateKey,
      validationRunChallenge: CHALLENGE,
      clockUnixNs: () => {
        clockCalls += 1;
        return 1_784_500_000_123_456_789n;
      },
      nonceBytes: () => {
        nonceCalls += 1;
        return Buffer.alloc(32, 0x51);
      },
    });
    const receipt = authority.signer().sign(admissionInput());
    const trust = await authority.trustMaterial();

    expect(trust.validationRunChallenge).toBe(CHALLENGE);
    expect(receipt).not.toHaveProperty("publicKey");
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trust.verificationKey,
      receipt,
      trust.validationRunChallenge,
    )).toMatchObject({
      verified: true,
      replayChecked: false,
      freshnessChecked: false,
    });
    const other = createAuthority();
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      other.signer().exportVerificationKey(),
      receipt,
      trust.validationRunChallenge,
    ).verified).toBe(false);
    expect(verifyGpuParentRuntimeProofAdmissionReceipt(
      trust.verificationKey,
      receipt,
      Buffer.alloc(32, 0x52).toString("base64url"),
    ).verified).toBe(false);
    expect(clockCalls).toBe(1);
    expect(nonceCalls).toBe(1);
    expect(trust).not.toHaveProperty("clockUnixNs");
    expect(trust).not.toHaveProperty("nonceBytes");
  });

  it("projects bounded generic online policy without exposing operation capacity", async () => {
    const authority = createAuthority({
      maxReceiptAgeNs: 20_000_000_000n,
      maxFutureSkewNs: 500_000_000n,
      maxScopes: 7,
      maxReceiptsPerScope: 11,
      maxOperations: 19,
      operationTimeoutMs: 750,
    });
    const trust = await authority.trustMaterial();

    expect(trust.onlineReplayAuthority).toMatchObject({
      maxReceiptAgeNs: "20000000000",
      maxFutureSkewNs: "500000000",
      maxScopes: 7,
      maxReceiptsPerScope: 11,
      operationTimeoutMs: 750,
    });
    expect(trust.onlineReplayAuthority).not.toHaveProperty("maxOperations");
    expect(JSON.stringify(trust)).not.toMatch(/backend|project|maxOperations/);
    await expect(onlineClientProjection(
      trust.onlineReplayAuthority,
    ).probe()).resolves.toMatchObject({
      policyHash: trust.onlineReplayAuthority.policyHash,
      revision: "0",
    });
  });

  it("closes a disposed endpoint and rotates every restart generation", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const first = createAuthority({
      privateKey,
      validationRunChallenge: CHALLENGE,
    });
    const firstTrust = await first.trustMaterial();
    const oldClient = onlineClientProjection(firstTrust.onlineReplayAuthority);
    await expect(oldClient.probe()).resolves.toMatchObject({ revision: "0" });

    const firstDisposal = first.dispose();
    expect(first.dispose()).toBe(firstDisposal);
    await firstDisposal;

    await expect(oldClient.probe()).rejects.toThrow("authority_unavailable");
    await expect(first.trustMaterial()).rejects.toThrow(
      "gpu_parent_runtime_proof_admission_authority_disposed",
    );
    expect(() => first.signer()).toThrow(
      "gpu_parent_runtime_proof_admission_authority_disposed",
    );

    const restarted = createAuthority({
      privateKey,
      validationRunChallenge: CHALLENGE,
    });
    const restartedTrust = await restarted.trustMaterial();
    expect(restartedTrust.verificationKey)
      .toEqual(firstTrust.verificationKey);
    expect(restartedTrust.onlineReplayAuthority.authorityId)
      .not.toBe(firstTrust.onlineReplayAuthority.authorityId);
    expect(restartedTrust.onlineReplayAuthority.authorityGenerationId)
      .not.toBe(firstTrust.onlineReplayAuthority.authorityGenerationId);
    expect(restartedTrust.onlineReplayAuthority.responseVerificationKey.keyId)
      .not.toBe(
        firstTrust.onlineReplayAuthority.responseVerificationKey.keyId,
      );
    expect(restartedTrust.onlineReplayAuthority.endpoint)
      .not.toBe(firstTrust.onlineReplayAuthority.endpoint);
  });

  it("rejects non-data, proxied, named, and filesystem context", () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "maxScopes", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 4;
      },
    });
    expect(() => new GpuParentRuntimeProofAdmissionAuthority(accessor))
      .toThrow("gpu_parent_runtime_proof_admission_authority_context_invalid");
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    };
    const proxy = new Proxy({}, {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    });
    expect(() => new GpuParentRuntimeProofAdmissionAuthority(proxy))
      .toThrow("gpu_parent_runtime_proof_admission_authority_context_invalid");
    expect(trapCalls).toBe(0);

    for (const context of [
      Object.assign(Object.create({}), {}),
      { projectName: "named" },
      { backendName: "named" },
      { replayStateRoot: "C:\\replay" },
      { replayAnchorRoot: "C:\\anchor" },
      { replayStateAuthenticationKey: "secret" },
    ]) {
      expect(() => new GpuParentRuntimeProofAdmissionAuthority(context))
        .toThrow("gpu_parent_runtime_proof_admission_authority_context_invalid");
    }
    expect(() => new GpuParentRuntimeProofAdmissionAuthority({
      validationRunChallenge: "not-base64url",
    })).toThrow("gpu_parent_runtime_proof_admission_authority_challenge_invalid");
  });

  it("rejects online policy values outside primitive bounds", () => {
    for (const value of [0n, -1n, U64_MAX + 1n, 1, "1"]) {
      expect(() => new GpuParentRuntimeProofAdmissionAuthority({
        maxReceiptAgeNs: value,
      } as never)).toThrow(
        "gpu_parent_runtime_proof_admission_authority_freshness_policy_invalid",
      );
    }
    for (const value of [-1n, U64_MAX + 1n, 0, "0"]) {
      expect(() => new GpuParentRuntimeProofAdmissionAuthority({
        maxFutureSkewNs: value,
      } as never)).toThrow(
        "gpu_parent_runtime_proof_admission_authority_freshness_policy_invalid",
      );
    }
    for (const context of [
      { maxScopes: 0 },
      { maxScopes: 65_537 },
      { maxReceiptsPerScope: 0 },
      { maxReceiptsPerScope: 65_537 },
      { maxOperations: 0 },
      { maxOperations: 262_145 },
      { maxOperations: 1.5 },
    ]) {
      expect(() => new GpuParentRuntimeProofAdmissionAuthority(context))
        .toThrow(
          "gpu_parent_runtime_proof_admission_authority_capacity_policy_invalid",
        );
    }
    for (const operationTimeoutMs of [0, -1, 1.5, 60_001, "5000"]) {
      expect(() => new GpuParentRuntimeProofAdmissionAuthority({
        operationTimeoutMs,
      } as never)).toThrow(
        "gpu_parent_runtime_proof_admission_authority_operation_timeout_invalid",
      );
    }
  });
});
