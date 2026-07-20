import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GpuParentRuntimeProofAdmissionReceiptSigner,
  type GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";
import {
  commitGpuHmrMcpAdmissionReceiptForMatrix,
  createGpuHmrMcpAdmissionOnlineReplayRegistry,
  createGpuHmrMcpAdmissionReplayRegistry,
  discardGpuHmrMcpAdmissionReceiptForMatrix,
  GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_AUTHORITY,
  GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_SCHEMA,
  GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY,
  stageGpuHmrMcpAdmissionReceiptForMatrix,
  stagedGpuHmrMcpAdmissionReceiptProjection,
  verifiedGpuHmrMcpAdmissionReceiptProjection,
  verifyGpuHmrMcpAdmissionReceiptForMatrix,
} from "../../scripts/lib/gpu-hmr-mcp-admission-receipt-matrix-verifier.mjs";
import {
  createGpuHmrMcpAdmissionOnlineReplayAuthorityClient,
  disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer,
  gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection,
  gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
  startGpuHmrMcpAdmissionOnlineReplayAuthorityServer,
} from "../../scripts/lib/gpu-hmr-mcp-admission-online-replay-authority.mjs";

const NOW_NS = BigInt(Date.now()) * 1_000_000n;
const MAX_AGE_NS = 30_000_000_000n;
const MAX_FUTURE_SKEW_NS = 1_000_000_000n;
const CHALLENGE = Buffer.alloc(32, 0x27).toString("base64url");
const OTHER_CHALLENGE = Buffer.alloc(32, 0x28).toString("base64url");
const onlineServers: object[] = [];
const relayServers: Array<{
  server: Server;
  endpoint: string;
  sockets: Set<Socket>;
  timers: Set<ReturnType<typeof setTimeout>>;
}> = [];
function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function admissionInput(
  overrides: Partial<GpuParentRuntimeProofAdmissionReceiptInput> = {},
): GpuParentRuntimeProofAdmissionReceiptInput {
  const controlBindingCanonicalSha256 = hash("4");
  return {
    transportSessionId: "opaque-transport-session:matrix-01",
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
    runnerRuntimeSessionId: "opaque-runtime-session:matrix-02",
    runnerChallenge: "23456789abcdef0123456789abcdef01",
    commandEnvelopeSha256: hash("2"),
    protectedProofJsonSha256: hash("3"),
    ...overrides,
  };
}

function deterministicNonce(seed = 0x41): () => Uint8Array {
  let next = seed;
  return () => Buffer.alloc(32, next++);
}

function receiptSigner(
  privateKey: KeyObject,
  options: Partial<{
    challenge: string;
    clockUnixNs: () => bigint;
    nonceBytes: () => Uint8Array;
  }> = {},
): GpuParentRuntimeProofAdmissionReceiptSigner {
  return new GpuParentRuntimeProofAdmissionReceiptSigner({
    privateKey,
    validationRunChallenge: options.challenge ?? CHALLENGE,
    clockUnixNs: options.clockUnixNs ?? (() => NOW_NS),
    nonceBytes: options.nonceBytes ?? deterministicNonce(),
  });
}

function expectedBinding(input: GpuParentRuntimeProofAdmissionReceiptInput) {
  return {
    transportSessionId: input.transportSessionId,
    compileRequestNonce: input.compileRequestNonce,
    computeExpectedOutputContractHash: input.computeExpectedOutputContractHash,
    computeExpectedOutputSemanticsHash: input.computeExpectedOutputSemanticsHash,
    artifactContentHash: input.artifactContentHash,
    fullRuntimeProofId: input.fullRuntimeProofId,
    proofLedgerId: input.proofLedgerId,
    runnerRuntimeSessionId: input.runnerRuntimeSessionId,
  };
}

function verificationContext(options: Partial<{
  signer: GpuParentRuntimeProofAdmissionReceiptSigner;
  input: GpuParentRuntimeProofAdmissionReceiptInput;
  receipt: ReturnType<GpuParentRuntimeProofAdmissionReceiptSigner["sign"]>;
  challenge: string;
  nowUnixNs: bigint;
  maxAgeNs: bigint;
  maxFutureSkewNs: bigint;
  replayRegistry: ReturnType<typeof createGpuHmrMcpAdmissionReplayRegistry>;
  expectedBinding: ReturnType<typeof expectedBinding>;
}> = {}) {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const signer = options.signer ?? receiptSigner(privateKey);
  const input = options.input ?? admissionInput();
  return {
    trustedVerificationKey: signer.exportVerificationKey(),
    validationRunChallenge: options.challenge ?? CHALLENGE,
    receipt: options.receipt ?? signer.sign(input),
    nowUnixNs: options.nowUnixNs ?? NOW_NS,
    maxAgeNs: options.maxAgeNs ?? MAX_AGE_NS,
    maxFutureSkewNs: options.maxFutureSkewNs ?? MAX_FUTURE_SKEW_NS,
    replayRegistry:
      options.replayRegistry ?? createGpuHmrMcpAdmissionReplayRegistry(),
    expectedBinding: options.expectedBinding ?? expectedBinding(input),
  };
}

function expectSupportOnly(result: Awaited<ReturnType<
  typeof verifyGpuHmrMcpAdmissionReceiptForMatrix
>>): void {
  expect(result).toMatchObject({
    proofAuthority: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

async function onlineRegistry(
  signer: GpuParentRuntimeProofAdmissionReceiptSigner,
  metadataTransform: (
    metadata: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> = async (metadata) => metadata,
) {
  const server = await startGpuHmrMcpAdmissionOnlineReplayAuthorityServer({
    trustedVerificationKey: signer.exportVerificationKey(),
    validationRunChallenge: CHALLENGE,
    maxReceiptAgeNs: MAX_AGE_NS,
    maxFutureSkewNs: MAX_FUTURE_SKEW_NS,
    maxScopes: 16,
    maxReceiptsPerScope: 32,
    maxOperations: 128,
    operationTimeoutMs: 1_000,
  });
  onlineServers.push(server);
  const metadata = gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection(
    server,
  );
  if (metadata === null) throw new Error("online authority metadata unavailable");
  const transformed = await metadataTransform({
    ...metadata,
    responseVerificationKey: { ...metadata.responseVerificationKey },
  });
  const client = createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(
    transformed,
  );
  const projection = gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(
    client,
  );
  if (projection === null) throw new Error("online client projection unavailable");
  return {
    metadata,
    client,
    projection,
    replayRegistry: await createGpuHmrMcpAdmissionOnlineReplayRegistry(client),
  };
}

function relayEndpoint() {
  const capability = randomBytes(32).toString("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${capability}`
    : path.join(os.tmpdir(), `${capability}.sock`);
}

async function startDelayingCasRelay(
  targetEndpoint: string,
  delayMode: boolean | number,
) {
  const endpoint = relayEndpoint();
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let casCount = 0;
  const server = createServer({ allowHalfOpen: true }, (downstream) => {
    sockets.add(downstream);
    downstream.on("error", () => {});
    downstream.on("close", () => sockets.delete(downstream));
    const requestChunks: Buffer[] = [];
    let forwarded = false;
    downstream.on("data", (chunk: Buffer) => {
      requestChunks.push(Buffer.from(chunk));
      if (forwarded || !chunk.includes(0x0a)) return;
      forwarded = true;
      const requestBytes = Buffer.concat(requestChunks);
      let isCas = false;
      try {
        const parsed = JSON.parse(requestBytes.toString("utf8"));
        isCas = parsed?.request?.schemaVersion
          === "synthi.gpu_hmr.mcp_admission_online_replay_cas_request.v1";
      } catch {
        isCas = false;
      }
      if (isCas) casCount += 1;
      const upstream = createConnection({ path: targetEndpoint });
      sockets.add(upstream);
      upstream.on("error", () => downstream.destroy());
      upstream.on("close", () => sockets.delete(upstream));
      const responseChunks: Buffer[] = [];
      upstream.on("data", (response: Buffer) => {
        responseChunks.push(Buffer.from(response));
      });
      upstream.on("end", () => {
        const response = Buffer.concat(responseChunks);
        const shouldDelay = isCas && (
          typeof delayMode === "number"
            ? casCount <= delayMode
            : delayMode || casCount === 1
        );
        if (!shouldDelay) {
          if (!downstream.destroyed) downstream.end(response);
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!downstream.destroyed) downstream.end(response);
        }, 1_500);
        timers.add(timer);
      });
      upstream.on("connect", () => upstream.write(requestBytes));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  relayServers.push({ server, endpoint, sockets, timers });
  return endpoint;
}

afterEach(async () => {
  for (const relay of relayServers.splice(0)) {
    for (const timer of relay.timers) clearTimeout(timer);
    for (const socket of relay.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      if (!relay.server.listening) {
        resolve();
        return;
      }
      relay.server.close(() => resolve());
    });
    if (process.platform !== "win32") {
      try {
        if ((await lstat(relay.endpoint)).isSocket()) await unlink(relay.endpoint);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
  }
  for (const server of onlineServers.splice(0)) {
    await disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(server);
  }
});

describe("MCP admission receipt matrix verifier", () => {
  it("stages without replay mutation and commits an accepted projection once", async () => {
    const context = verificationContext();
    const staged = stageGpuHmrMcpAdmissionReceiptForMatrix(context);

    expect(staged).toMatchObject({
      schemaVersion: GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_SCHEMA,
      staged: true,
      reason: null,
      proofAuthority:
        GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_AUTHORITY,
      signatureVerified: true,
      challengeBound: true,
      bindingChecked: true,
      freshnessChecked: true,
      replayChecked: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(staged)).toBe(true);
    expect(staged).not.toHaveProperty("accepted");
    expect(verifiedGpuHmrMcpAdmissionReceiptProjection(staged)).toBeNull();
    expect(stagedGpuHmrMcpAdmissionReceiptProjection(staged)).toMatchObject({
      required: true,
      receiptId: staged.receiptId,
      contractHash: hash("a"),
      semanticsHash: hash("b"),
    });

    const committed = await commitGpuHmrMcpAdmissionReceiptForMatrix(staged);
    expect(committed).toMatchObject({
      accepted: true,
      reason: null,
      commitFreshnessChecked: true,
      replayChecked: true,
      replayCommitted: true,
    });
    expect(committed.replayCommittedAtUnixNs).toMatch(/^[1-9][0-9]*$/);
    expect(verifiedGpuHmrMcpAdmissionReceiptProjection(committed)).toMatchObject({
      receiptId: committed.receiptId,
      contractHash: hash("a"),
      semanticsHash: hash("b"),
    });
    expect(await commitGpuHmrMcpAdmissionReceiptForMatrix(staged)).toMatchObject({
      accepted: false,
      reason:
        "gpu_hmr_mcp_admission_matrix_staged_verification_already_used",
    });
    expect(stagedGpuHmrMcpAdmissionReceiptProjection(staged)).toBeNull();
    expect(discardGpuHmrMcpAdmissionReceiptForMatrix(staged)).toBe(false);
  });

  it("rejects serialized staged forgeries without retiring the real token", async () => {
    const staged = stageGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext(),
    );
    const serialized = JSON.parse(JSON.stringify(staged));

    expect(await commitGpuHmrMcpAdmissionReceiptForMatrix(serialized)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_matrix_staged_verification_invalid",
    });
    expect(discardGpuHmrMcpAdmissionReceiptForMatrix(serialized)).toBe(false);
    expect(stagedGpuHmrMcpAdmissionReceiptProjection(serialized)).toBeNull();
    expect((await commitGpuHmrMcpAdmissionReceiptForMatrix(staged)).accepted)
      .toBe(true);
  });

  it("discards a failed semantic consumer without consuming replay", async () => {
    const context = verificationContext();
    const staged = stageGpuHmrMcpAdmissionReceiptForMatrix(context);
    const semanticConsumerAccepted =
      context.expectedBinding.computeExpectedOutputSemanticsHash === hash("0");

    expect(semanticConsumerAccepted).toBe(false);
    expect(discardGpuHmrMcpAdmissionReceiptForMatrix(staged)).toBe(true);
    expect(discardGpuHmrMcpAdmissionReceiptForMatrix(staged)).toBe(false);
    expect(await commitGpuHmrMcpAdmissionReceiptForMatrix(staged)).toMatchObject({
      accepted: false,
      reason:
        "gpu_hmr_mcp_admission_matrix_staged_verification_already_used",
    });

    const retry = stageGpuHmrMcpAdmissionReceiptForMatrix(context);
    expect(retry).toMatchObject({ staged: true });
    expect((await commitGpuHmrMcpAdmissionReceiptForMatrix(retry)).accepted)
      .toBe(true);
  });

  it("rechecks freshness before replay commit without consuming an expired receipt", async () => {
    const privateKey = generateKeyPairSync("ed25519").privateKey;
    const admittedAt = BigInt(Date.now()) * 1_000_000n;
    const signer = receiptSigner(privateKey, {
      clockUnixNs: () => admittedAt,
    });
    const input = admissionInput();
    const receipt = signer.sign(input);
    const replayRegistry = createGpuHmrMcpAdmissionReplayRegistry();
    const expiringContext = verificationContext({
      signer,
      input,
      receipt,
      nowUnixNs: admittedAt,
      maxAgeNs: 1_000_000n,
      replayRegistry,
    });
    const staged = stageGpuHmrMcpAdmissionReceiptForMatrix(expiringContext);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await commitGpuHmrMcpAdmissionReceiptForMatrix(staged)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_stale",
      freshnessChecked: true,
      replayChecked: false,
      replayCommitAttempted: false,
      replayCommitted: false,
    });

    const retry = stageGpuHmrMcpAdmissionReceiptForMatrix({
      ...expiringContext,
      nowUnixNs: BigInt(Date.now()) * 1_000_000n,
      maxAgeNs: MAX_AGE_NS,
    });
    expect((await commitGpuHmrMcpAdmissionReceiptForMatrix(retry)).accepted)
      .toBe(true);
  });

  it("atomically rechecks replay constraints when staged receipts commit", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const input = admissionInput();
    const firstReceipt = signer.sign(input);
    const secondReceipt = signer.sign(input);
    const replayRegistry = createGpuHmrMcpAdmissionReplayRegistry();
    const firstContext = verificationContext({
      signer,
      input,
      receipt: firstReceipt,
      replayRegistry,
    });
    const duplicate = stageGpuHmrMcpAdmissionReceiptForMatrix(firstContext);
    const first = stageGpuHmrMcpAdmissionReceiptForMatrix(firstContext);
    const second = stageGpuHmrMcpAdmissionReceiptForMatrix({
      ...firstContext,
      receipt: secondReceipt,
    });

    expect(first).toMatchObject({ staged: true });
    expect(duplicate).toMatchObject({ staged: true });
    expect(second).toMatchObject({ staged: true });
    expect((await commitGpuHmrMcpAdmissionReceiptForMatrix(first)).accepted)
      .toBe(true);
    expect(await commitGpuHmrMcpAdmissionReceiptForMatrix(duplicate)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_replayed",
      replayChecked: true,
    });
    expect((await commitGpuHmrMcpAdmissionReceiptForMatrix(second)).accepted)
      .toBe(true);

    const rollbackRegistry = createGpuHmrMcpAdmissionReplayRegistry();
    const stagedFirst = stageGpuHmrMcpAdmissionReceiptForMatrix({
      ...firstContext,
      replayRegistry: rollbackRegistry,
    });
    const stagedSecond = stageGpuHmrMcpAdmissionReceiptForMatrix({
      ...firstContext,
      receipt: secondReceipt,
      replayRegistry: rollbackRegistry,
    });
    expect((await commitGpuHmrMcpAdmissionReceiptForMatrix(stagedSecond)).accepted)
      .toBe(true);
    expect(await commitGpuHmrMcpAdmissionReceiptForMatrix(stagedFirst)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_sequence_not_increasing",
      replayChecked: true,
    });
  });

  it("uses deterministic operation identities and admits one concurrent replay", async () => {
    const replayRegistry = createGpuHmrMcpAdmissionReplayRegistry();
    const context = verificationContext({ replayRegistry });
    const first = stageGpuHmrMcpAdmissionReceiptForMatrix(context);
    const second = stageGpuHmrMcpAdmissionReceiptForMatrix(context);
    const isolated = stageGpuHmrMcpAdmissionReceiptForMatrix({
      ...context,
      replayRegistry: createGpuHmrMcpAdmissionReplayRegistry(),
    });

    expect(first).toMatchObject({
      replayChecked: false,
      replayCommitAttempted: false,
      replayAuthorityDurable: false,
    });
    expect(first.replayOperationId).toMatch(
      /^gpu-hmr-mcp-replay-operation:sha256:[a-f0-9]{64}$/,
    );
    expect(second.replayOperationId).toMatch(
      /^gpu-hmr-mcp-replay-operation:sha256:[a-f0-9]{64}$/,
    );
    expect(second.replayOperationId).toBe(first.replayOperationId);
    expect(second.replayRequestId).toBe(first.replayRequestId);
    expect(isolated.replayOperationId).not.toBe(first.replayOperationId);
    expect(isolated.replayRequestId).not.toBe(first.replayRequestId);
    expect(discardGpuHmrMcpAdmissionReceiptForMatrix(isolated)).toBe(true);

    const results = await Promise.all([
      commitGpuHmrMcpAdmissionReceiptForMatrix(first),
      commitGpuHmrMcpAdmissionReceiptForMatrix(second),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toEqual([
      expect.objectContaining({
        reason: "gpu_hmr_mcp_admission_receipt_replayed",
        replayChecked: true,
        replayCommitAttempted: false,
        replayCommitted: false,
        replayAuthorityDurable: false,
      }),
    ]);
    for (const result of results) {
      expect(result.replayOperationId).toMatch(
        /^gpu-hmr-mcp-replay-operation:sha256:[a-f0-9]{64}$/,
      );
    }
  });

  it("accepts fresh externally trusted receipts and exposes only branded projections", async () => {
    const result = await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext(),
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: null,
      signatureVerified: true,
      challengeBound: true,
      bindingChecked: true,
      freshnessChecked: true,
      replayChecked: true,
    });
    expectSupportOnly(result);
    expect(verifiedGpuHmrMcpAdmissionReceiptProjection(result)).toMatchObject({
      required: true,
      contractHash: hash("a"),
      semanticsHash: hash("b"),
      compileTransportNonce:
        `gpu-proof-transport-request:${"1".repeat(32)}`,
      artifactContentHash: hash("e"),
      fullRuntimeProofId: `gpu-runtime-proof:sha256:${"f".repeat(64)}`,
      proofLedgerId: `gpu-ledger-proof:sha256:${"1".repeat(64)}`,
      runtimeSessionId: "opaque-runtime-session:matrix-02",
    });
    expect(verifiedGpuHmrMcpAdmissionReceiptProjection({
      accepted: true,
      signatureVerified: true,
    })).toBeNull();
  });

  it("uses signed parent freshness with no matrix-local clock", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const input = admissionInput();
    const receipt = signer.sign(input);
    const online = await onlineRegistry(signer);
    const result = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt,
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    });

    expect(result).toMatchObject({
      accepted: true,
      reason: null,
      freshnessChecked: true,
      commitFreshnessChecked: true,
      replayChecked: true,
      replayCommitted: true,
      replayCommitKnown: true,
      replayCommitState: "applied",
      replayOperationCommitted: true,
      replayDurable: false,
      replayAuthorityDurable: false,
      replayAuthorityClass:
        GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
      replayOnlineRequired: true,
      replayOnlineVerified: true,
      replayRollbackProtected: true,
      replaySignedProbeVerified: true,
      replaySignedResponseVerified: true,
      replayAuthorityGenerationId: online.metadata.authorityGenerationId,
      replayAuthorityProcessId: online.metadata.parentPid,
      replayAuthorityParentStartIdentity:
        online.metadata.parentStartIdentity,
      replayAuthorityPolicyHash: online.metadata.policyHash,
      replayResponseKeyId: online.metadata.responseVerificationKey.keyId,
      replayAttemptCount: 1,
      replayIndeterminateRetryUsed: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(result.replayRequestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.replayPreviousCommitHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.replayCommitHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.replayResponseSignature).toMatch(
      /^ed25519:[A-Za-z0-9_-]{86}$/,
    );

    const replayed = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt,
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    });
    expect(replayed).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_replayed",
      replayCommitState: "rejected",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    });
  });

  it("observes an exact online commit idempotently across independent registries", async () => {
    const privateKey = generateKeyPairSync("ed25519").privateKey;
    const signer = receiptSigner(privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
      nonceBytes: () => Buffer.alloc(32, 0x71),
    });
    const online = await onlineRegistry(signer);
    const input = admissionInput();
    const receipt = signer.sign(input);
    const common = {
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt,
      expectedBinding: expectedBinding(input),
    };
    const first = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...common,
      replayRegistry: online.replayRegistry,
    });
    expect(first).toMatchObject({
      accepted: true,
      replayCommitAttempted: true,
      replayCommitKnown: true,
      replayCommitState: "applied",
      replayOperationCommitted: true,
      replaySignedResponseVerified: true,
    });

    const independentClient =
      createGpuHmrMcpAdmissionOnlineReplayAuthorityClient({
        ...online.metadata,
        responseVerificationKey: {
          ...online.metadata.responseVerificationKey,
        },
      });
    const independentRegistry =
      await createGpuHmrMcpAdmissionOnlineReplayRegistry(independentClient);
    const exactRetry = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...common,
      trustedVerificationKey: {
        ...signer.exportVerificationKey(),
      },
      replayRegistry: independentRegistry,
    });
    expect(exactRetry).toMatchObject({
      accepted: true,
      replayCommitAttempted: true,
      replayCommitKnown: true,
      replayCommitState: "applied",
      replayOperationCommitted: true,
      replaySignedResponseVerified: true,
    });
    expect(exactRetry.replayOperationId).toBe(first.replayOperationId);
    expect(exactRetry.replayRequestId).toBe(first.replayRequestId);
    expect(exactRetry.replayRequestHash).toBe(first.replayRequestHash);
    expect(exactRetry.replayRevision).toBe(first.replayRevision);
    expect(exactRetry.replayCommittedAtUnixNs).toBe(
      first.replayCommittedAtUnixNs,
    );
    expect(exactRetry.replayPreviousCommitHash).toBe(
      first.replayPreviousCommitHash,
    );
    expect(exactRetry.replayCommitHash).toBe(first.replayCommitHash);
    expect(exactRetry.replayResponseSignature).toBe(
      first.replayResponseSignature,
    );

    const conflictingBinding = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...common,
      replayRegistry: independentRegistry,
      expectedBinding: {
        ...common.expectedBinding,
        proofLedgerId: `gpu-ledger-proof:sha256:${"2".repeat(64)}`,
      },
    });
    expect(conflictingBinding).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_signed_binding_mismatch",
      bindingChecked: true,
      replayCommitAttempted: false,
    });

    const alteredReceipt = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...common,
      replayRegistry: independentRegistry,
      receipt: {
        ...receipt,
        artifactContentHash: hash("0"),
      },
      expectedBinding: {
        ...common.expectedBinding,
        artifactContentHash: hash("0"),
      },
    });
    expect(alteredReceipt).toMatchObject({
      accepted: false,
      signatureVerified: false,
      replayCommitAttempted: false,
    });

    const staleSigner = receiptSigner(privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
      nonceBytes: () => Buffer.alloc(32, 0x72),
    });
    const staleRegistry = await createGpuHmrMcpAdmissionOnlineReplayRegistry(
      createGpuHmrMcpAdmissionOnlineReplayAuthorityClient({
        ...online.metadata,
        responseVerificationKey: {
          ...online.metadata.responseVerificationKey,
        },
      }),
    );
    const staleReceipt = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...common,
      receipt: staleSigner.sign(input),
      replayRegistry: staleRegistry,
    });
    expect(staleReceipt).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_sequence_not_increasing",
      replayCommitAttempted: true,
      replayCommitKnown: true,
      replayCommitState: "rejected",
      replaySignedResponseVerified: true,
    });
    expect(staleReceipt.replayOperationId).not.toBe(first.replayOperationId);

    const nonceReplayRegistry =
      await createGpuHmrMcpAdmissionOnlineReplayRegistry(
        createGpuHmrMcpAdmissionOnlineReplayAuthorityClient({
          ...online.metadata,
          responseVerificationKey: {
            ...online.metadata.responseVerificationKey,
          },
        }),
      );
    const nonceReplay = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...common,
      receipt: signer.sign(input),
      replayRegistry: nonceReplayRegistry,
    });
    expect(nonceReplay).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_nonce_replayed",
      replayCommitAttempted: true,
      replayCommitKnown: true,
      replayCommitState: "rejected",
      replaySignedResponseVerified: true,
    });
    expect(nonceReplay.replayOperationId).not.toBe(first.replayOperationId);
  });

  it("keeps a concurrent online operation pending until a signed result returns", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const online = await onlineRegistry(signer, async (metadata) => ({
      ...metadata,
      endpoint: await startDelayingCasRelay(metadata.endpoint as string, false),
      operationTimeoutMs: 1_000,
    }));
    const input = admissionInput();
    const receipt = signer.sign(input);
    const context = {
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt,
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    };
    const first = stageGpuHmrMcpAdmissionReceiptForMatrix(context);
    const concurrent = stageGpuHmrMcpAdmissionReceiptForMatrix(context);

    const firstResultPromise = commitGpuHmrMcpAdmissionReceiptForMatrix(first);
    const concurrentResult =
      await commitGpuHmrMcpAdmissionReceiptForMatrix(concurrent);
    expect(concurrentResult).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_authority_indeterminate",
      replayChecked: false,
      replayCommitAttempted: false,
      replayCommitKnown: false,
      replayCommitState: "pending",
      replayOperationCommitted: null,
    });
    await expect(firstResultPromise).resolves.toMatchObject({
      accepted: true,
      replayCommitKnown: true,
      replayCommitState: "applied",
      replayAttemptCount: 2,
      replayIndeterminateRetryUsed: true,
    });
  });

  it("requires the branded async factory and rejects caller-supplied probes", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const online = await onlineRegistry(signer);
    const rawProbe = await online.projection.probe();
    const fabricatedRawProbe = {
      ...rawProbe,
      revision: (BigInt(rawProbe.revision) + 1n).toString(),
    };
    expect(() => createGpuHmrMcpAdmissionReplayRegistry({
      authority: online.client,
      authorityProbe: rawProbe,
    })).toThrow("gpu_hmr_mcp_admission_replay_authority_invalid");
    expect(() => createGpuHmrMcpAdmissionReplayRegistry({
      authority: online.client,
      authorityProbe: fabricatedRawProbe,
    })).toThrow("gpu_hmr_mcp_admission_replay_authority_invalid");
    expect(() => createGpuHmrMcpAdmissionReplayRegistry({
      authorityProbe: fabricatedRawProbe,
    })).toThrow("gpu_hmr_mcp_admission_replay_authority_invalid");
    expect(() => createGpuHmrMcpAdmissionReplayRegistry({
      authority: {},
      authorityProbe: {},
    })).toThrow("gpu_hmr_mcp_admission_replay_authority_invalid");
    await expect(createGpuHmrMcpAdmissionOnlineReplayRegistry({})).rejects
      .toThrow("gpu_hmr_mcp_admission_replay_authority_invalid");

    const input = admissionInput();
    const receipt = signer.sign(input);
    const mismatch = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt,
      maxAgeNs: MAX_AGE_NS + 1n,
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    });
    expect(mismatch).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_authority_policy_mismatch",
      replayOnlineVerified: true,
      replaySignedProbeVerified: true,
    });
  });

  it("retries one indeterminate online commit with the exact operation", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const online = await onlineRegistry(signer, async (metadata) => ({
      ...metadata,
      endpoint: await startDelayingCasRelay(
        metadata.endpoint as string,
        false,
      ),
      operationTimeoutMs: 1_000,
    }));
    const input = admissionInput();
    const result = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt: signer.sign(input),
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    });

    expect(result).toMatchObject({
      accepted: true,
      replayCommitKnown: true,
      replayCommitState: "applied",
      replayAttemptCount: 2,
      replayIndeterminateRetryUsed: true,
      replaySignedResponseVerified: true,
    });
  });

  it("fails closed without claiming an indeterminate commit was absent", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const online = await onlineRegistry(signer, async (metadata) => ({
      ...metadata,
      endpoint: await startDelayingCasRelay(
        metadata.endpoint as string,
        true,
      ),
      operationTimeoutMs: 1_000,
    }));
    const input = admissionInput();
    const result = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt: signer.sign(input),
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    });

    expect(result).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_authority_indeterminate",
      replayCommitKnown: false,
      replayCommitState: "indeterminate",
      replayOperationCommitted: null,
      replayAttemptCount: 2,
      replayIndeterminateRetryUsed: true,
      replaySignedResponseVerified: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    });
  });

  it("restages an indeterminate online operation with the exact identity", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const online = await onlineRegistry(signer, async (metadata) => ({
      ...metadata,
      endpoint: await startDelayingCasRelay(metadata.endpoint as string, 2),
      operationTimeoutMs: 1_000,
    }));
    const input = admissionInput();
    const context = {
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt: signer.sign(input),
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    };

    const indeterminate =
      await verifyGpuHmrMcpAdmissionReceiptForMatrix(context);
    expect(indeterminate).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_authority_indeterminate",
      replayCommitKnown: false,
      replayCommitState: "indeterminate",
      replayAttemptCount: 2,
    });

    const resolved = await verifyGpuHmrMcpAdmissionReceiptForMatrix(context);
    expect(resolved).toMatchObject({
      accepted: true,
      replayCommitKnown: true,
      replayCommitState: "applied",
      replayAttemptCount: 1,
      replaySignedResponseVerified: true,
    });
    expect(resolved.replayOperationId).toBe(indeterminate.replayOperationId);
    expect(resolved.replayRequestId).toBe(indeterminate.replayRequestId);

    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix(context)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_replayed",
      replayCommitAttempted: false,
      replayCommitKnown: true,
      replayCommitState: "rejected",
    });
  });

  it("replays a known signed rejection without relabeling it as receipt replay", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () =>
        BigInt(Date.now()) * 1_000_000n - MAX_AGE_NS - 1_000_000_000n,
    });
    const online = await onlineRegistry(signer);
    const input = admissionInput();
    const context = {
      trustedVerificationKey: signer.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
      receipt: signer.sign(input),
      replayRegistry: online.replayRegistry,
      expectedBinding: expectedBinding(input),
    };

    const first = await verifyGpuHmrMcpAdmissionReceiptForMatrix(context);
    expect(first).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_expired_before_replay_commit",
      replayCommitAttempted: true,
      replayCommitKnown: true,
      replayCommitState: "rejected",
      replaySignedResponseVerified: true,
    });
    const repeated = await verifyGpuHmrMcpAdmissionReceiptForMatrix(context);
    expect(repeated).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_expired_before_replay_commit",
      replayCommitAttempted: false,
      replayCommitKnown: true,
      replayCommitState: "rejected",
      replayAttemptCount: 0,
      replaySignedResponseVerified: true,
    });
  });

  it("rejects wrong keys, wrong challenges, and self-signed receipts", async () => {
    const trustedSigner = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const attackerSigner = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const input = admissionInput();
    const attackerReceipt = attackerSigner.sign(input);

    const wrongKey = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...verificationContext({ signer: trustedSigner, input }),
      receipt: attackerReceipt,
    });
    expect(wrongKey).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_signer_key_mismatch",
    });
    expectSupportOnly(wrongKey);

    const wrongChallenge = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...verificationContext({ signer: trustedSigner, input }),
      validationRunChallenge: OTHER_CHALLENGE,
    });
    expect(wrongChallenge).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_validation_run_challenge_mismatch",
    });
  });

  it("rejects stale and excessively future-dated receipts", async () => {
    const stale = await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ nowUnixNs: NOW_NS + MAX_AGE_NS + 1n }),
    );
    expect(stale).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_stale",
      freshnessChecked: true,
    });

    const futureSigner = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      clockUnixNs: () => NOW_NS + MAX_FUTURE_SKEW_NS + 1n,
    });
    const future = await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer: futureSigner }),
    );
    expect(future).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_from_future",
      freshnessChecked: true,
    });
  });

  it("rejects cross-ledger and other signed binding substitution", async () => {
    const context = verificationContext();
    const crossLedger = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...context,
      expectedBinding: {
        ...context.expectedBinding,
        proofLedgerId: `gpu-ledger-proof:sha256:${"2".repeat(64)}`,
      },
    });
    expect(crossLedger).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_signed_binding_mismatch",
      bindingChecked: true,
    });

    const context2 = verificationContext();
    const artifactSubstitution = await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...context2,
      expectedBinding: {
        ...context2.expectedBinding,
        artifactContentHash: hash("0"),
      },
    });
    expect(artifactSubstitution).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_signed_binding_mismatch",
    });
  });

  it("atomically rejects replay and sequence rollback across collector tasks", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const input = admissionInput();
    const first = signer.sign(input);
    const second = signer.sign(input);
    const registry = createGpuHmrMcpAdmissionReplayRegistry();
    const secondContext = verificationContext({
      signer,
      input,
      receipt: second,
      replayRegistry: registry,
    });
    expect((await verifyGpuHmrMcpAdmissionReceiptForMatrix(secondContext)).accepted)
      .toBe(true);
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix(secondContext)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_receipt_replayed",
      replayChecked: true,
    });
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...secondContext,
      receipt: first,
    })).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_sequence_not_increasing",
      replayChecked: true,
    });

    const parallelRegistry = createGpuHmrMcpAdmissionReplayRegistry();
    const parallelContext = verificationContext({
      signer,
      input,
      receipt: first,
      replayRegistry: parallelRegistry,
    });
    const parallel = await Promise.all([
      verifyGpuHmrMcpAdmissionReceiptForMatrix(parallelContext),
      verifyGpuHmrMcpAdmissionReceiptForMatrix(parallelContext),
    ]);
    expect(parallel.filter((result) => result.accepted)).toHaveLength(1);
    expect(parallel.filter((result) => !result.accepted)).toEqual([
      expect.objectContaining({
        reason: "gpu_hmr_mcp_admission_receipt_replayed",
      }),
    ]);
  });

  it("rejects nonce reuse even when the signed sequence increases", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey, {
      nonceBytes: () => Buffer.alloc(32, 0x77),
    });
    const input = admissionInput();
    const first = signer.sign(input);
    const second = signer.sign(input);
    const replayRegistry = createGpuHmrMcpAdmissionReplayRegistry();

    expect((await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: first, replayRegistry }),
    )).accepted).toBe(true);
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: second, replayRegistry }),
    )).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_nonce_replayed",
    });
  });

  it("fails closed when bounded replay state reaches capacity", async () => {
    const signer = receiptSigner(generateKeyPairSync("ed25519").privateKey);
    const input = admissionInput();
    const replayRegistry = createGpuHmrMcpAdmissionReplayRegistry({
      maxScopes: 1,
      maxReceiptsPerScope: 2,
    });
    const receipts = [signer.sign(input), signer.sign(input), signer.sign(input)];
    expect((await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: receipts[0], replayRegistry }),
    )).accepted).toBe(true);
    expect((await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: receipts[1], replayRegistry }),
    )).accepted).toBe(true);
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({ signer, input, receipt: receipts[2], replayRegistry }),
    )).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted",
    });

    const otherSessionInput = admissionInput({
      transportSessionId: "opaque-transport-session:matrix-02",
    });
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix(
      verificationContext({
        signer,
        input: otherSessionInput,
        receipt: signer.sign(otherSessionInput),
        replayRegistry,
      }),
    )).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted",
    });
    expect(() => createGpuHmrMcpAdmissionReplayRegistry({
      maxScopes: 0,
      maxReceiptsPerScope: 1,
    })).toThrow("gpu_hmr_mcp_admission_replay_registry_capacity_invalid");
    expect(() => createGpuHmrMcpAdmissionReplayRegistry({
      maxScopes: 1,
      maxReceiptsPerScope: 1,
      authority: {},
    })).toThrow("gpu_hmr_mcp_admission_replay_authority_invalid");
  });

  it("rejects forged registries, malformed freshness, and accessor contexts", async () => {
    const base = verificationContext();
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...base,
      replayRegistry: {
        schemaVersion: "synthi.gpu_hmr.mcp_admission_replay_registry.v1",
      },
    })).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_replay_registry_invalid",
    });
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix({
      ...base,
      nowUnixNs: Number(NOW_NS),
    })).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_freshness_policy_invalid",
    });

    const accessorContext = Object.create(Object.prototype);
    for (const [key, value] of Object.entries(base)) {
      Object.defineProperty(accessorContext, key, {
        enumerable: true,
        configurable: true,
        ...(key === "receipt" ? { get: () => value } : { value }),
      });
    }
    expect(await verifyGpuHmrMcpAdmissionReceiptForMatrix(accessorContext)).toMatchObject({
      accepted: false,
      reason: "gpu_hmr_mcp_admission_matrix_context_invalid",
    });
  });
});
