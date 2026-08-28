import { ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { channel } from "node:diagnostics_channel";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GpuParentRuntimeProofAdmissionReceiptSigner,
  type GpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";
import {
  createGpuHmrMcpAdmissionOnlineReplayAuthorityClient,
  disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer,
  gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection,
  gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLIENT_SCHEMA,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_SERVER_SCHEMA,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_REQUEST_SCHEMA,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_RESULT_SCHEMA,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA,
  hashGpuHmrMcpAdmissionOnlineReplayExpectedBinding,
  hashGpuHmrMcpAdmissionOnlineReplayPolicy,
  startGpuHmrMcpAdmissionOnlineReplayAuthorityServer,
} from "../../scripts/lib/gpu-hmr-mcp-admission-online-replay-authority.mjs";

const CHALLENGE = Buffer.alloc(32, 0x27).toString("base64url");
const MAX_AGE_NS = 30_000_000_000n;
const MODULE_URL = new URL(
  "../../scripts/lib/gpu-hmr-mcp-admission-online-replay-authority.mjs",
  import.meta.url,
).href;
const CAS_RESULT_KEYS = [
  "schemaVersion",
  "authorityId",
  "authorityGenerationId",
  "authorityClass",
  "rollbackProtected",
  "onlineRequired",
  "requestId",
  "requestHash",
  "replayOperationId",
  "outcome",
  "reason",
  "durable",
  "operationCommitted",
  "receiptId",
  "replayScopeId",
  "sequence",
  "nonceHash",
  "revision",
  "committedAtUnixNs",
  "previousCommitHash",
  "commitHash",
  "policyHash",
  "responseKeyId",
  "parentPid",
  "parentStartIdentity",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "signature",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;

const authorityServers: object[] = [];
const localServers: Array<Readonly<{
  server: NetServer;
  endpoint: string;
  sockets: Set<Socket>;
}>> = [];
const relaySockets = new Set<Socket>();
const delayedWrites = new Set<ReturnType<typeof setTimeout>>();
let requestIndex = 0;

function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function admissionInput(
  overrides: Partial<GpuParentRuntimeProofAdmissionReceiptInput> = {},
): GpuParentRuntimeProofAdmissionReceiptInput {
  const controlBindingCanonicalSha256 = hash("4");
  return {
    transportSessionId: "opaque-transport-session:online-01",
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
    runnerRuntimeSessionId: "opaque-runtime-session:online-02",
    runnerChallenge: "23456789abcdef0123456789abcdef01",
    commandEnvelopeSha256: hash("2"),
    protectedProofJsonSha256: hash("3"),
    ...overrides,
  };
}

function expectedBinding(receipt: GpuParentRuntimeProofAdmissionReceipt) {
  return {
    transportSessionId: receipt.transportSessionId,
    compileRequestNonce: receipt.compileRequestNonce,
    computeExpectedOutputContractHash:
      receipt.computeExpectedOutputContractHash,
    computeExpectedOutputSemanticsHash:
      receipt.computeExpectedOutputSemanticsHash,
    artifactContentHash: receipt.artifactContentHash,
    fullRuntimeProofId: receipt.fullRuntimeProofId,
    proofLedgerId: receipt.proofLedgerId,
    runnerRuntimeSessionId: receipt.runnerRuntimeSessionId,
  };
}

function signer(
  privateKey: KeyObject = generateKeyPairSync("ed25519").privateKey,
  options: Partial<{
    clockUnixNs: () => bigint;
    nonceBytes: () => Uint8Array;
  }> = {},
): GpuParentRuntimeProofAdmissionReceiptSigner {
  return new GpuParentRuntimeProofAdmissionReceiptSigner({
    privateKey,
    validationRunChallenge: CHALLENGE,
    clockUnixNs:
      options.clockUnixNs ?? (() => BigInt(Date.now()) * 1_000_000n),
    nonceBytes: options.nonceBytes ?? (() => randomBytes(32)),
  });
}

type StartOverrides = Partial<{
  maxAgeNs: bigint;
  maxFutureSkewNs: bigint;
  maxScopes: number;
  maxReceiptsPerScope: number;
  maxOperations: number;
  operationTimeoutMs: number;
}>;

async function startAuthority(
  receiptSigner: GpuParentRuntimeProofAdmissionReceiptSigner = signer(),
  overrides: StartOverrides = {},
) {
  const server = await startGpuHmrMcpAdmissionOnlineReplayAuthorityServer({
    trustedVerificationKey: receiptSigner.exportVerificationKey(),
    validationRunChallenge: CHALLENGE,
    maxAgeNs: overrides.maxAgeNs ?? MAX_AGE_NS,
    maxFutureSkewNs: overrides.maxFutureSkewNs ?? 1_000_000_000n,
    maxScopes: overrides.maxScopes ?? 16,
    maxReceiptsPerScope: overrides.maxReceiptsPerScope ?? 32,
    maxOperations: overrides.maxOperations ?? 128,
    operationTimeoutMs: overrides.operationTimeoutMs ?? 5_000,
  });
  authorityServers.push(server);
  const metadata = gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection(
    server,
  );
  if (metadata === null) throw new Error("server projection unavailable");
  const client = createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(metadata);
  const projection = gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(
    client,
  );
  if (projection === null) throw new Error("client projection unavailable");
  return { receiptSigner, server, metadata, client, projection };
}

function casRequest(
  authorityId: string,
  receipt: GpuParentRuntimeProofAdmissionReceipt,
  overrides: Partial<{
    replayOperationId: string;
    expectedBindingHash: string;
    requestId: string;
  }> = {},
) {
  requestIndex += 1;
  const bindingHash = hashGpuHmrMcpAdmissionOnlineReplayExpectedBinding(
    expectedBinding(receipt),
  );
  if (bindingHash === null) throw new Error("binding hash unavailable");
  return {
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_REQUEST_SCHEMA,
    authorityId,
    replayOperationId:
      overrides.replayOperationId ?? `online-replay-operation-${requestIndex}`,
    expectedBindingHash: overrides.expectedBindingHash ?? bindingHash,
    requestId: overrides.requestId ?? `online-replay-request-${requestIndex}`,
    receipt,
  };
}

function clientForMetadata(metadata: Record<string, unknown>) {
  const client = createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(metadata);
  const projection = gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(
    client,
  );
  if (projection === null) throw new Error("client projection unavailable");
  return { client, projection };
}

function randomLocalEndpoint(): string {
  const capability = randomBytes(32).toString("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${capability}`
    : path.join(os.tmpdir(), `${capability}.sock`);
}

async function startLocalServer(
  handler: (socket: Socket) => void,
): Promise<string> {
  const endpoint = randomLocalEndpoint();
  const sockets = new Set<Socket>();
  const server = createNetServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  localServers.push({ server, endpoint, sockets });
  return endpoint;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

async function startRelay(
  targetEndpoint: string,
  options: Partial<{
    delayMs: number;
    corruptSignature: boolean;
    dropConnection: number;
  }> = {},
): Promise<string> {
  let connectionNumber = 0;
  return await startLocalServer((downstream) => {
    connectionNumber += 1;
    const thisConnection = connectionNumber;
    const requestChunks: Buffer[] = [];
    let forwarding = false;
    const forward = () => {
      if (forwarding || downstream.destroyed) return;
      forwarding = true;
      const upstream = createConnection({ path: targetEndpoint });
      relaySockets.add(upstream);
      upstream.on("error", () => downstream.destroy());
      upstream.on("close", () => relaySockets.delete(upstream));
      const responseChunks: Buffer[] = [];
      upstream.on("data", (chunk: Buffer) => responseChunks.push(Buffer.from(chunk)));
      upstream.on("end", () => {
        let response = Buffer.concat(responseChunks);
        if (options.corruptSignature === true) {
          const parsed = JSON.parse(response.toString("utf8")) as
            Record<string, unknown>;
          parsed.signature =
            `ed25519:${Buffer.alloc(64, 0x5a).toString("base64url")}`;
          response = Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
        }
        const write = () => {
          if (!downstream.destroyed) downstream.end(response);
        };
        if ((options.delayMs ?? 0) > 0) {
          const timer = setTimeout(() => {
            delayedWrites.delete(timer);
            write();
          }, options.delayMs);
          delayedWrites.add(timer);
        } else {
          write();
        }
      });
      upstream.on("connect", () => upstream.write(Buffer.concat(requestChunks)));
    };
    downstream.on("data", (chunk: Buffer) => {
      requestChunks.push(Buffer.from(chunk));
      if (chunk.includes(0x0a)) {
        if (options.dropConnection === thisConnection) downstream.destroy();
        else setImmediate(forward);
      }
    });
  });
}

function metadataWith(
  metadata: Record<string, unknown>,
  endpoint: string,
  operationTimeoutMs: number,
) {
  return {
    ...metadata,
    responseVerificationKey: {
      ...(metadata.responseVerificationKey as Record<string, unknown>),
    },
    endpoint,
    operationTimeoutMs,
  };
}

function rawExchange(endpoint: string, frame: Buffer | string): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: endpoint });
    const chunks: Buffer[] = [];
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(Buffer.concat(chunks));
    };
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 1_000).unref();
  });
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(processId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(processId);
}

function childCompareAndSet(
  metadata: Record<string, unknown>,
  request: Record<string, unknown>,
) {
  const program = `
const input = JSON.parse(
  Buffer.from(process.env.ONLINE_REPLAY_INPUT ?? "", "base64url")
    .toString("utf8"),
);
const authorityModule = await import(input.moduleUrl);
const client = authorityModule
  .createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(input.metadata);
const projection = authorityModule
  .gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(client);
if (projection === null) throw new Error("client projection unavailable");
const probe = await projection.probe();
const result = await projection.compareAndSet(input.request);
process.stdout.write(JSON.stringify({
  probe: {
    schemaVersion: probe.schemaVersion,
    authorityId: probe.authorityId,
    revision: probe.revision,
  },
  result,
}));
`;
  const encoded = Buffer.from(JSON.stringify({
    moduleUrl: MODULE_URL,
    metadata,
    request,
  })).toString("base64url");
  return new Promise<Record<string, any>>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", program],
      {
        env: { ...process.env, ONLINE_REPLAY_INPUT: encoded },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${String(code)}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`child returned invalid JSON: ${stdout}`, {
          cause: error,
        }));
      }
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const timer of delayedWrites) clearTimeout(timer);
  delayedWrites.clear();
  for (const socket of relaySockets) socket.destroy();
  relaySockets.clear();
  for (const entry of localServers.splice(0)) {
    for (const socket of entry.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      if (!entry.server.listening) {
        resolve();
        return;
      }
      entry.server.close(() => resolve());
    });
    if (process.platform !== "win32" && existsSync(entry.endpoint)) {
      const status = lstatSync(entry.endpoint);
      if (status.isSocket()) unlinkSync(entry.endpoint);
    }
  }
  for (const server of authorityServers.splice(0)) {
    await disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(server);
  }
  requestIndex = 0;
});

describe("online parent admission replay authority", () => {
  it("exposes only branded public metadata and a non-mutating signed probe", async () => {
    const fixture = await startAuthority();

    expect(fixture.server).toMatchObject({
      schemaVersion:
        GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_SERVER_SCHEMA,
      authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
      rollbackProtected: true,
      onlineRequired: true,
      durable: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    });
    expect(fixture.client).toMatchObject({
      schemaVersion:
        GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLIENT_SCHEMA,
      authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
      rollbackProtected: true,
      onlineRequired: true,
      durable: false,
    });
    expect(Object.keys(fixture.metadata).sort()).toEqual([
      "authorityGenerationId",
      "authorityId",
      "endpoint",
      "maxFutureSkewNs",
      "maxReceiptAgeNs",
      "maxReceiptsPerScope",
      "maxScopes",
      "operationTimeoutMs",
      "parentPid",
      "parentStartIdentity",
      "policyHash",
      "responseVerificationKey",
      "transport",
    ]);
    expect(JSON.stringify(fixture.metadata)).not.toMatch(
      /private|challenge|maxOperations/i,
    );
    expect(fixture.metadata).toMatchObject({
      maxReceiptAgeNs: MAX_AGE_NS.toString(),
      maxFutureSkewNs: "1000000000",
      maxScopes: 16,
      maxReceiptsPerScope: 32,
    });
    expect(fixture.metadata.parentPid).toBe(process.pid);
    expect(fixture.metadata.parentStartIdentity).toMatch(
      /^gpu-hmr-mcp-online-replay-parent-start:sha256:[a-f0-9]{64}$/,
    );
    expect(fixture.metadata.policyHash).toBe(
      hashGpuHmrMcpAdmissionOnlineReplayPolicy({
        maxReceiptAgeNs: fixture.metadata.maxReceiptAgeNs,
        maxFutureSkewNs: fixture.metadata.maxFutureSkewNs,
        maxScopes: fixture.metadata.maxScopes,
        maxReceiptsPerScope: fixture.metadata.maxReceiptsPerScope,
      }),
    );
    expect(fixture.projection).toMatchObject({
      maxReceiptAgeNs: fixture.metadata.maxReceiptAgeNs,
      maxFutureSkewNs: fixture.metadata.maxFutureSkewNs,
      maxScopes: fixture.metadata.maxScopes,
      maxReceiptsPerScope: fixture.metadata.maxReceiptsPerScope,
      policyHash: fixture.metadata.policyHash,
    });
    expect(fixture.metadata.endpoint).not.toMatch(/synthi|gpu|backend|project/i);
    expect(fixture.metadata.endpoint).toMatch(
      process.platform === "win32"
        ? /^\\\\\.\\pipe\\[a-f0-9]{64}$/
        : /[\\/][a-f0-9]{64}\.sock$/,
    );
    if (process.platform !== "win32") {
      expect(lstatSync(fixture.metadata.endpoint).mode & 0o777).toBe(0o600);
    }

    expect(() => createGpuHmrMcpAdmissionOnlineReplayAuthorityClient({
      ...fixture.metadata,
      maxScopes: fixture.metadata.maxScopes + 1,
    })).toThrow("server_projection_invalid");
    expect(() => createGpuHmrMcpAdmissionOnlineReplayAuthorityClient({
      ...fixture.metadata,
      parentStartIdentity: "malformed",
    })).toThrow("server_projection_invalid");
    const mismatchedParentIdentity = clientForMetadata({
      ...fixture.metadata,
      parentStartIdentity: `${fixture.metadata.parentStartIdentity.slice(0, -1)}${
        fixture.metadata.parentStartIdentity.endsWith("0") ? "1" : "0"
      }`,
    });
    await expect(mismatchedParentIdentity.projection.probe()).rejects.toThrow(
      "probe_response_invalid",
    );
    const unavailableParentIdentity = clientForMetadata({
      ...fixture.metadata,
      parentPid: 0x7fff_ffff,
    });
    await expect(unavailableParentIdentity.projection.probe()).rejects.toThrow(
      "probe_response_invalid",
    );
    const substitutedPolicy = {
      maxReceiptAgeNs: fixture.metadata.maxReceiptAgeNs,
      maxFutureSkewNs: fixture.metadata.maxFutureSkewNs,
      maxScopes: fixture.metadata.maxScopes + 1,
      maxReceiptsPerScope: fixture.metadata.maxReceiptsPerScope,
    };
    const substitutedPolicyHash =
      hashGpuHmrMcpAdmissionOnlineReplayPolicy(substitutedPolicy);
    if (substitutedPolicyHash === null) {
      throw new Error("substituted policy hash unavailable");
    }
    const substituted = clientForMetadata({
      ...fixture.metadata,
      ...substitutedPolicy,
      policyHash: substitutedPolicyHash,
    });
    await expect(substituted.projection.probe()).rejects.toThrow(
      "response_frame_invalid",
    );

    const firstProbe = await fixture.projection.probe();
    const secondProbe = await fixture.projection.probe();
    expect(firstProbe).toMatchObject({
      schemaVersion:
        GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA,
      authorityId: fixture.metadata.authorityId,
      authorityGenerationId: fixture.metadata.authorityGenerationId,
      responseKeyId: fixture.metadata.responseVerificationKey.keyId,
      revision: "0",
      rollbackProtected: true,
      onlineRequired: true,
      durable: false,
      policyHash: fixture.metadata.policyHash,
    });
    expect(secondProbe.revision).toBe("0");
    expect(secondProbe.commitHash).toBe(firstProbe.commitHash);
    expect(secondProbe.probeId).not.toBe(firstProbe.probeId);

    const receipt = fixture.receiptSigner.sign(admissionInput());
    const request = casRequest(
      fixture.metadata.authorityId,
      receipt,
    );
    await expect(fixture.projection.compareAndSet({
      ...request,
      maxScopes: 1_000_000,
    })).rejects.toThrow("request_invalid");
    const applied = await fixture.projection.compareAndSet(request);
    expect(Object.keys(applied).sort()).toEqual([...CAS_RESULT_KEYS].sort());
    expect(Object.isFrozen(applied)).toBe(true);
    expect(applied).toMatchObject({
      schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_RESULT_SCHEMA,
      authorityId: fixture.metadata.authorityId,
      authorityGenerationId: fixture.metadata.authorityGenerationId,
      authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
      rollbackProtected: true,
      onlineRequired: true,
      requestId: request.requestId,
      replayOperationId: request.replayOperationId,
      outcome: "applied",
      reason: null,
      durable: false,
      operationCommitted: true,
      receiptId: receipt.receiptId,
      sequence: receipt.sequence,
      revision: "1",
      policyHash: fixture.metadata.policyHash,
      responseKeyId: fixture.metadata.responseVerificationKey.keyId,
      parentPid: fixture.metadata.parentPid,
      parentStartIdentity: fixture.metadata.parentStartIdentity,
      maxReceiptAgeNs: fixture.metadata.maxReceiptAgeNs,
      maxFutureSkewNs: fixture.metadata.maxFutureSkewNs,
      maxScopes: fixture.metadata.maxScopes,
      maxReceiptsPerScope: fixture.metadata.maxReceiptsPerScope,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(applied.requestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(applied.replayScopeId).toMatch(
      /^gpu-hmr-mcp-admission-replay-scope:sha256:[a-f0-9]{64}$/,
    );
    expect(applied.nonceHash).toMatch(
      /^gpu-hmr-mcp-admission-nonce:sha256:[a-f0-9]{64}$/,
    );
    expect(applied.previousCommitHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(applied.commitHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(applied.signature).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);

    let traps = 0;
    const trap = () => { traps += 1; throw new Error("proxy trap called"); };
    expect(gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection(
      new Proxy(fixture.server, { get: trap, ownKeys: trap }),
    )).toBeNull();
    expect(gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(
      new Proxy(fixture.client, { get: trap, ownKeys: trap }),
    )).toBeNull();
    expect(() => createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(
      new Proxy(fixture.metadata, { get: trap, ownKeys: trap }),
    )).toThrow("server_projection_invalid");
    await expect(fixture.projection.compareAndSet(
      new Proxy({}, { get: trap, ownKeys: trap }),
    )).rejects.toThrow("request_invalid");
    expect(traps).toBe(0);
  });

  it("observes actual worker exit on cleanup and leaves no authority process", async () => {
    const lifecycle = channel(
      "gpu-hmr-mcp-admission-online-replay-authority.lifecycle.v1",
    );
    const events: any[] = [];
    const subscriber = (message: any) => events.push(message);
    lifecycle.subscribe(subscriber);
    let fixture: Awaited<ReturnType<typeof startAuthority>>;
    try {
      fixture = await startAuthority();
      const spawned = events.find((event) => event.phase === "spawned");
      expect(spawned).toMatchObject({ parentPid: process.pid });
      expect(Number.isSafeInteger(spawned.processId)).toBe(true);

      const [firstDispose, concurrentDispose] = await Promise.all([
        disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(fixture.server),
        disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(fixture.server),
      ]);
      expect(firstDispose).toBe(true);
      expect(concurrentDispose).toBe(true);
      expect(await disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
        fixture.server,
      )).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        phase: "exit_observed",
        processId: spawned.processId,
      }));
      expect(processExists(spawned.processId)).toBe(false);
      await expect(fixture.projection.probe()).rejects.toThrow(
        "authority_unavailable",
      );
    } finally {
      lifecycle.unsubscribe(subscriber);
    }
  });

  it("fails closed on non-observed termination, unrefs uncertain handles, and retries after late exit", async () => {
    let worker: ChildProcess | null = null;
    const nativeChildUnref = ChildProcess.prototype.unref;
    const childUnref = vi.spyOn(ChildProcess.prototype, "unref")
      .mockImplementation(function (this: ChildProcess) {
        worker = this;
        return Reflect.apply(nativeChildUnref, this, []);
      });
    const fixture = await startAuthority();
    expect(worker).not.toBeNull();
    childUnref.mockClear();
    const channelUnref = vi.spyOn(worker!.channel!, "unref");
    const send = vi.spyOn(worker!, "send")
      .mockImplementation(function (this: ChildProcess, message: any) {
        expect(message).toEqual({
          schemaVersion:
            "synthi.gpu_hmr.mcp_admission_online_replay_worker_stop.v1",
        });
        return true;
      } as any);
    const kill = vi.spyOn(worker!, "kill")
      .mockImplementation(function () {
        return true;
      });

    vi.useFakeTimers();
    try {
      const firstDispose =
        disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(fixture.server);
      const concurrentDispose =
        disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(fixture.server);
      const disposalResults = Promise.allSettled([
        firstDispose,
        concurrentDispose,
      ]);
      await vi.advanceTimersByTimeAsync(5_100);
      const results = await disposalResults;

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("rejected");
      if (results[0].status === "rejected" && results[1].status === "rejected") {
        expect(results[0].reason).toMatchObject({
          code:
            "GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_TERMINATION_INDETERMINATE",
          outcome: "indeterminate",
          failClosed: true,
        });
        expect(results[1].reason).toBe(results[0].reason);
      }
      expect(send).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(childUnref).toHaveBeenCalledTimes(1);
      expect(channelUnref).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      send.mockRestore();
      kill.mockRestore();
      const lateExit = new Promise<void>((resolve) => {
        worker!.once("exit", () => resolve());
      });
      expect(worker!.kill("SIGKILL")).toBe(true);
      await lateExit;

      expect(await disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
        fixture.server,
      )).toBe(true);
      expect(await disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
        fixture.server,
      )).toBe(false);
    } finally {
      vi.useRealTimers();
      send.mockRestore();
      kill.mockRestore();
      if (worker !== null && processExists(worker.pid ?? 0)) {
        worker.kill("SIGKILL");
        await waitForProcessExit(worker.pid ?? 0, 5_000);
      }
    }
  }, 20_000);

  it("terminates the authority when its immediate parent channel closes", async () => {
    const receiptSigner = signer();
    const input = Buffer.from(JSON.stringify({
      moduleUrl: MODULE_URL,
      trustedVerificationKey: receiptSigner.exportVerificationKey(),
      validationRunChallenge: CHALLENGE,
    })).toString("base64url");
    const program = `
const { channel } = await import("node:diagnostics_channel");
const input = JSON.parse(Buffer.from(
  process.env.ONLINE_REPLAY_HOST_INPUT ?? "",
  "base64url",
).toString("utf8"));
let workerPid = null;
channel("gpu-hmr-mcp-admission-online-replay-authority.lifecycle.v1")
  .subscribe((message) => {
    if (message.phase === "spawned") workerPid = message.processId;
  });
const authority = await import(input.moduleUrl);
const server = await authority
  .startGpuHmrMcpAdmissionOnlineReplayAuthorityServer({
    trustedVerificationKey: input.trustedVerificationKey,
    validationRunChallenge: input.validationRunChallenge,
    operationTimeoutMs: 5000,
  });
const projection = authority
  .gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection(server);
process.stdout.write(JSON.stringify({ workerPid, projection }) + "\\n");
setInterval(() => {}, 1000);
`;
    const host = spawn(
      process.execPath,
      ["--input-type=module", "--eval", program],
      {
        env: { ...process.env, ONLINE_REPLAY_HOST_INPUT: input },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let workerPid = 0;
    try {
      const ready = await new Promise<any>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(
          () => reject(new Error("authority host startup timed out")),
          10_000,
        );
        host.stdout.setEncoding("utf8");
        host.stderr.setEncoding("utf8");
        host.stderr.on("data", (chunk: string) => { stderr += chunk; });
        host.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          try {
            resolve(JSON.parse(stdout.slice(0, newline)));
          } catch (error) {
            reject(new Error(`authority host output invalid: ${stderr}`, {
              cause: error,
            }));
          }
        });
        host.once("error", reject);
        host.once("exit", (code, signal) => reject(new Error(
          `authority host exited before ready (${String(code)}, ${String(signal)}): ${stderr}`,
        )));
      });
      workerPid = ready.workerPid;
      expect(ready.projection.parentPid).toBe(host.pid);
      expect(processExists(workerPid)).toBe(true);
      const remoteClient = clientForMetadata(ready.projection);
      await expect(remoteClient.projection.probe()).resolves.toMatchObject({
        revision: "0",
      });

      const hostExited = new Promise<void>((resolve) => {
        host.once("exit", () => resolve());
      });
      host.kill("SIGKILL");
      await hostExited;
      expect(await waitForProcessExit(workerPid, 5_000)).toBe(true);
      await expect(remoteClient.projection.probe()).rejects.toThrow(
        /authority_unavailable|response_frame_invalid/,
      );
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      if (workerPid > 0 && processExists(workerPid)) {
        process.kill(workerPid, "SIGKILL");
        await waitForProcessExit(workerPid, 5_000);
      }
    }
  }, 20_000);

  it("gives concurrent starts independent startup timeout budgets", async () => {
    const short = startAuthority(signer(), { operationTimeoutMs: 1 });
    const long = startAuthority(signer(), { operationTimeoutMs: 5_000 });
    const [shortResult, longResult] = await Promise.allSettled([short, long]);

    expect(shortResult.status).toBe("rejected");
    if (shortResult.status === "rejected") {
      expect(shortResult.reason).toMatchObject({
        code: "GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_WORKER_START_TIMEOUT",
      });
    }
    expect(longResult.status).toBe("fulfilled");
    if (longResult.status === "fulfilled") {
      expect(longResult.value.metadata.operationTimeoutMs).toBe(5_000);
      expect(longResult.value.metadata.parentPid).toBe(process.pid);
    }
  });

  it("keeps a committed result indeterminate until the final signed probe", async () => {
    const fixture = await startAuthority();
    const relay = await startRelay(fixture.metadata.endpoint, {
      dropConnection: 4,
    });
    const relayed = clientForMetadata(metadataWith(
      fixture.metadata,
      relay,
      1_000,
    ));
    const request = casRequest(
      fixture.metadata.authorityId,
      fixture.receiptSigner.sign(admissionInput()),
    );

    await expect(relayed.projection.compareAndSet(request)).rejects
      .toMatchObject({ outcome: "indeterminate", failClosed: true });
    await expect(fixture.projection.compareAndSet(request)).resolves
      .toMatchObject({ outcome: "applied", revision: "1" });
  });

  it("shares replay state with two clients and a real child-process client", async () => {
    const fixture = await startAuthority();
    const receipt = fixture.receiptSigner.sign(admissionInput());
    const childRequest = casRequest(fixture.metadata.authorityId, receipt);
    const child = await childCompareAndSet(fixture.metadata, childRequest);

    expect(child.probe).toEqual({
      schemaVersion:
        GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA,
      authorityId: fixture.metadata.authorityId,
      revision: "0",
    });
    expect(child.result).toMatchObject({
      outcome: "applied",
      reason: null,
      revision: "1",
    });

    const second = clientForMetadata({ ...fixture.metadata });
    const replayed = await second.projection.compareAndSet(casRequest(
      fixture.metadata.authorityId,
      receipt,
    ));
    expect(replayed).toMatchObject({
      outcome: "rejected",
      reason: "gpu_hmr_mcp_admission_receipt_replayed",
      revision: "2",
    });
  });

  it("atomically permits one winner in a concurrent replay race", async () => {
    const fixture = await startAuthority();
    const second = clientForMetadata({ ...fixture.metadata });
    const receipt = fixture.receiptSigner.sign(admissionInput());
    const results = await Promise.all([
      fixture.projection.compareAndSet(casRequest(
        fixture.metadata.authorityId,
        receipt,
      )),
      second.projection.compareAndSet(casRequest(
        fixture.metadata.authorityId,
        receipt,
      )),
    ]);

    expect(results.filter((result) => result.outcome === "applied"))
      .toHaveLength(1);
    expect(results.filter((result) => result.outcome === "rejected"))
      .toEqual([
        expect.objectContaining({
          reason: "gpu_hmr_mcp_admission_receipt_replayed",
        }),
      ]);
  });

  it("rejects duplicate nonces, non-increasing sequences, and capacity overflow", async () => {
    const privateKey = generateKeyPairSync("ed25519").privateKey;
    const fixedNonceSigner = signer(privateKey, {
      nonceBytes: () => Buffer.alloc(32, 0x41),
    });
    const rollbackSigner = signer(privateKey, {
      nonceBytes: () => Buffer.alloc(32, 0x42),
    });
    const fixture = await startAuthority(fixedNonceSigner);
    const input = admissionInput();
    const first = fixedNonceSigner.sign(input);
    const duplicateNonce = fixedNonceSigner.sign(input);
    const rollback = rollbackSigner.sign(input);

    expect((await fixture.projection.compareAndSet(casRequest(
      fixture.metadata.authorityId,
      first,
    ))).outcome).toBe("applied");
    expect(await fixture.projection.compareAndSet(casRequest(
      fixture.metadata.authorityId,
      duplicateNonce,
    ))).toMatchObject({
      outcome: "rejected",
      reason: "gpu_hmr_mcp_admission_nonce_replayed",
    });
    expect(await fixture.projection.compareAndSet(casRequest(
      fixture.metadata.authorityId,
      rollback,
    ))).toMatchObject({
      outcome: "rejected",
      reason: "gpu_hmr_mcp_admission_sequence_not_increasing",
    });

    const capacitySigner = signer();
    const capacity = await startAuthority(capacitySigner, {
      maxScopes: 1,
      maxReceiptsPerScope: 1,
    });
    const capacityFirst = capacitySigner.sign(input);
    const capacitySecond = capacitySigner.sign(input);
    expect((await capacity.projection.compareAndSet(casRequest(
      capacity.metadata.authorityId,
      capacityFirst,
    ))).outcome).toBe("applied");
    expect(await capacity.projection.compareAndSet(casRequest(
      capacity.metadata.authorityId,
      capacitySecond,
    ))).toMatchObject({
      outcome: "rejected",
      reason:
        "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted",
    });
    const otherScope = capacitySigner.sign(admissionInput({
      transportSessionId: "opaque-transport-session:online-other",
    }));
    expect(await capacity.projection.compareAndSet(casRequest(
      capacity.metadata.authorityId,
      otherScope,
    ))).toMatchObject({
      outcome: "rejected",
      reason: "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted",
    });
  });

  it("makes a disposed endpoint unavailable and gives a restart a new generation", async () => {
    const receiptSigner = signer();
    const first = await startAuthority(receiptSigner);
    const oldRequest = casRequest(
      first.metadata.authorityId,
      receiptSigner.sign(admissionInput()),
    );
    expect(await disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
      first.server,
    )).toBe(true);
    expect(await disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
      first.server,
    )).toBe(false);
    await expect(first.projection.compareAndSet(oldRequest)).rejects.toThrow(
      "authority_unavailable",
    );
    await expect(first.projection.probe()).rejects.toThrow(
      "authority_unavailable",
    );

    const restarted = await startAuthority(receiptSigner);
    expect(restarted.metadata.authorityId).not.toBe(first.metadata.authorityId);
    expect(restarted.metadata.authorityGenerationId).not.toBe(
      first.metadata.authorityGenerationId,
    );
    expect(restarted.metadata.responseVerificationKey.keyId).not.toBe(
      first.metadata.responseVerificationKey.keyId,
    );
    expect(restarted.metadata.endpoint).not.toBe(first.metadata.endpoint);
  });

  it("rejects an applied response whose endpoint cannot forge the response key", async () => {
    const fixture = await startAuthority();
    const relay = await startRelay(fixture.metadata.endpoint, {
      corruptSignature: true,
    });
    const forged = clientForMetadata(metadataWith(
      fixture.metadata,
      relay,
      5_000,
    ));
    const receipt = fixture.receiptSigner.sign(admissionInput());
    const request = casRequest(fixture.metadata.authorityId, receipt);

    await expect(forged.projection.compareAndSet(request)).rejects.toThrow(
      "response_signature_invalid",
    );
    expect(await fixture.projection.compareAndSet(request)).toMatchObject({
      outcome: "applied",
      reason: null,
      revision: "1",
    });
  });

  it("enforces the server-owned signed receipt expiry policy", async () => {
    const expiredSigner = signer(undefined, {
      clockUnixNs: () => BigInt(Date.now() - 1_000) * 1_000_000n,
    });
    const fixture = await startAuthority(expiredSigner, {
      maxAgeNs: 10_000_000n,
    });
    const result = await fixture.projection.compareAndSet(casRequest(
      fixture.metadata.authorityId,
      expiredSigner.sign(admissionInput()),
    ));

    expect(result).toMatchObject({
      outcome: "rejected",
      reason:
        "gpu_hmr_mcp_admission_receipt_expired_before_replay_commit",
      durable: false,
    });
  });

  it("keeps freshness anchored to process-monotonic time across wall-clock jumps", async () => {
    const startupWallMs = Date.now();
    let receiptUnixNs = BigInt(startupWallMs) * 1_000_000n;
    const controlledSigner = signer(undefined, {
      clockUnixNs: () => receiptUnixNs,
    });
    const fixture = await startAuthority(controlledSigner, {
      maxAgeNs: 5_000_000_000n,
    });
    const freshReceipt = controlledSigner.sign(admissionInput());
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(
      startupWallMs + 365 * 24 * 60 * 60 * 1_000,
    );

    const freshResult = await fixture.projection.compareAndSet(casRequest(
      fixture.metadata.authorityId,
      freshReceipt,
    ));
    expect(freshResult).toMatchObject({
      outcome: "applied",
      reason: null,
      operationCommitted: true,
    });

    receiptUnixNs = BigInt(startupWallMs - 60_000) * 1_000_000n;
    const staleReceipt = controlledSigner.sign(admissionInput());
    dateNow.mockReturnValue(
      startupWallMs - 365 * 24 * 60 * 60 * 1_000,
    );
    const staleResult = await fixture.projection.compareAndSet(casRequest(
      fixture.metadata.authorityId,
      staleReceipt,
    ));
    expect(staleResult).toMatchObject({
      outcome: "rejected",
      reason:
        "gpu_hmr_mcp_admission_receipt_expired_before_replay_commit",
      operationCommitted: true,
    });
  });

  it("fails closed on abort and timeout, then resolves an indeterminate commit by ID", async () => {
    const fixture = await startAuthority(undefined, {
      operationTimeoutMs: 5_000,
    });
    const receipt = fixture.receiptSigner.sign(admissionInput());
    const request = casRequest(fixture.metadata.authorityId, receipt);

    const registrationController = new AbortController();
    let raceInjected = false;
    let userGetterReads = 0;
    Object.defineProperty(registrationController.signal, "aborted", {
      configurable: true,
      get: () => {
        userGetterReads += 1;
        throw new Error("user aborted getter called");
      },
    });
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const addEventListener = vi
      .spyOn(EventTarget.prototype, "addEventListener")
      .mockImplementation(function (this: EventTarget, ...args: any[]) {
        if (
          !raceInjected
          && this === registrationController.signal
          && args[0] === "abort"
        ) {
          raceInjected = true;
          registrationController.abort();
        }
        return Reflect.apply(nativeAddEventListener, this, args);
      });
    try {
      await expect(fixture.projection.compareAndSet(
        request,
        registrationController.signal,
      )).rejects.toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
        outcome: "indeterminate",
        failClosed: true,
      });
    } finally {
      addEventListener.mockRestore();
    }
    expect(raceInjected).toBe(true);
    expect(userGetterReads).toBe(0);

    const stalledEndpoint = await startLocalServer((socket) => {
      socket.on("data", () => {});
      socket.on("end", () => {});
    });
    const stalled = clientForMetadata(metadataWith(
      fixture.metadata,
      stalledEndpoint,
      500,
    ));
    const controller = new AbortController();
    const aborted = stalled.projection.compareAndSet(request, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(aborted).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
      outcome: "indeterminate",
      failClosed: true,
    });
    await expect(stalled.projection.probe(AbortSignal.abort())).rejects
      .toMatchObject({ name: "AbortError", outcome: "indeterminate" });

    const delayedEndpoint = await startRelay(fixture.metadata.endpoint, {
      delayMs: 4_000,
    });
    const timed = clientForMetadata(metadataWith(
      fixture.metadata,
      delayedEndpoint,
      2_500,
    ));
    let timeoutError: any = null;
    try {
      await timed.projection.compareAndSet(request);
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toMatchObject({
      outcome: "indeterminate",
      failClosed: true,
    });
    expect(timeoutError.message).toContain("authority_timeout");

    const resolved = await fixture.projection.compareAndSet(request);
    const retried = await fixture.projection.compareAndSet(request);
    expect(resolved).toMatchObject({ outcome: "applied", revision: "1" });
    expect(retried).toEqual(resolved);
  });

  it("returns an exact idempotent result and rejects conflicting operation reuse", async () => {
    const fixture = await startAuthority();
    const firstReceipt = fixture.receiptSigner.sign(admissionInput());
    const secondReceipt = fixture.receiptSigner.sign(admissionInput());
    const operationId = "stable-online-operation";
    const first = casRequest(fixture.metadata.authorityId, firstReceipt, {
      replayOperationId: operationId,
    });
    const conflict = casRequest(fixture.metadata.authorityId, secondReceipt, {
      replayOperationId: operationId,
    });

    const applied = await fixture.projection.compareAndSet(first);
    expect(await fixture.projection.compareAndSet(first)).toEqual(applied);
    const independentClient = clientForMetadata({ ...fixture.metadata });
    const conflictResult = await independentClient.projection.compareAndSet(
      conflict,
    );
    expect(conflictResult).toMatchObject({
      outcome: "rejected",
      reason: "gpu_hmr_mcp_admission_replay_operation_id_conflict",
      revision: applied.revision,
    });
    expect(await fixture.projection.compareAndSet(first)).toEqual(applied);
    expect(await fixture.projection.compareAndSet({
      ...conflict,
      replayOperationId: "fresh-online-operation",
    })).toMatchObject({
      outcome: "applied",
      reason: null,
      revision: "2",
    });
    expect(await independentClient.projection.compareAndSet(conflict))
      .toEqual(conflictResult);
  });

  it("rejects malformed, noncanonical, oversized, and multiple IPC frames", async () => {
    const fixture = await startAuthority();
    expect(await rawExchange(fixture.metadata.endpoint, "{\"x\": 1}\n"))
      .toHaveLength(0);
    expect(await rawExchange(fixture.metadata.endpoint, "{}\n{}\n"))
      .toHaveLength(0);
    expect(await rawExchange(
      fixture.metadata.endpoint,
      Buffer.alloc(65 * 1024, 0x61),
    )).toHaveLength(0);
    expect((await fixture.projection.probe()).revision).toBe("0");
  });
});
