export const GPU_HMR_PROOF_SCHEMA_VERSION = "synthi.gpu.hmr.proof.v1";

export const GPU_HMR_PROOF_STATES = [
  "gpu-hmr-compile-proven",
  "gpu-hmr-symbol-bound",
  "gpu-hmr-abi-proven",
  "gpu-hmr-dispatch-proven",
  "gpu-hmr-output-proven",
  "gpu-hmr-host-preservation-proven",
  "gpu-hmr-full-runtime-proven",
] as const;

export type GpuHmrProofState = (typeof GPU_HMR_PROOF_STATES)[number];

export const GPU_HMR_DEGRADED_STATES = [
  "gpu-hmr-fake-launch-path",
  "gpu-hmr-unknown-arg-provenance",
  "gpu-hmr-abi-unverified",
  "gpu-hmr-dispatch-unobserved",
  "gpu-hmr-output-unobserved",
  "gpu-hmr-host-replaced",
  "gpu-hmr-visual-only",
] as const;

export interface GpuHmrProofTelemetry {
  schemaVersion: string | null;
  proofId: string | null;
  proofArtifactPath: string | null;
  resultState: string;
  degradedState: string | null;
  degradedReason: string | null;
  label: string | null;
  source: "gpu_hmr_proof" | "gpu-proof-state";
  observedAt: number;
  raw: Record<string, unknown>;
}

export interface GpuHmrProofValidation {
  requiredState: string;
  requiredRank: number;
  resultState: string | null;
  resultRank: number;
  effectiveResultRank: number;
  degradedState: string | null;
  degradedStateRankCap: number | null;
  satisfied: boolean;
  reason?: string;
}

const PROOF_STATE_RANKS = new Map<string, number>(
  GPU_HMR_PROOF_STATES.map((state, index) => [state, index + 1])
);

const DEGRADED_STATE_RANK_CAPS = new Map<string, number>([
  ["gpu-hmr-fake-launch-path", gpuHmrProofStateRank("gpu-hmr-symbol-bound")],
  ["gpu-hmr-unknown-arg-provenance", gpuHmrProofStateRank("gpu-hmr-abi-proven")],
  ["gpu-hmr-abi-unverified", gpuHmrProofStateRank("gpu-hmr-symbol-bound")],
  ["gpu-hmr-dispatch-unobserved", gpuHmrProofStateRank("gpu-hmr-abi-proven")],
  ["gpu-hmr-output-unobserved", gpuHmrProofStateRank("gpu-hmr-dispatch-proven")],
  ["gpu-hmr-host-replaced", gpuHmrProofStateRank("gpu-hmr-output-proven")],
  ["gpu-hmr-visual-only", gpuHmrProofStateRank("gpu-hmr-dispatch-proven")],
]);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function isKnownGpuHmrProofState(value: unknown): value is GpuHmrProofState {
  return typeof value === "string" && PROOF_STATE_RANKS.has(value);
}

export function gpuHmrProofStateRank(value: unknown): number {
  return typeof value === "string" ? PROOF_STATE_RANKS.get(value) ?? 0 : 0;
}

export function gpuHmrDegradedStateRankCap(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return 0;
  return DEGRADED_STATE_RANK_CAPS.get(value) ?? 0;
}

export function classifyGpuHmrProofMessage(
  msg: Record<string, unknown>,
  observedAt = Date.now()
): GpuHmrProofTelemetry | null {
  const source =
    msg.type === "gpu_hmr_proof"
      ? "gpu_hmr_proof"
      : msg.status === "gpu-proof-state"
        ? "gpu-proof-state"
        : null;
  if (source === null) return null;

  const resultState = stringOrNull(msg.resultState ?? msg.result_state);
  if (resultState === null) return null;

  return {
    schemaVersion: stringOrNull(msg.schemaVersion ?? msg.schema_version),
    proofId: stringOrNull(msg.proofId ?? msg.proof_id),
    proofArtifactPath: stringOrNull(msg.proofArtifactPath ?? msg.proof_artifact_path),
    resultState,
    degradedState: stringOrNull(msg.degradedState ?? msg.degraded_state),
    degradedReason: stringOrNull(msg.degradedReason ?? msg.degraded_reason),
    label: stringOrNull(msg.label),
    source,
    observedAt,
    raw: msg,
  };
}

export function validateGpuHmrProofState(
  proof: GpuHmrProofTelemetry | null,
  requiredState: string
): GpuHmrProofValidation {
  const requiredRank = gpuHmrProofStateRank(requiredState);
  if (requiredRank === 0) {
    return {
      requiredState,
      requiredRank,
      resultState: proof?.resultState ?? null,
      resultRank: gpuHmrProofStateRank(proof?.resultState),
      effectiveResultRank: gpuHmrProofStateRank(proof?.resultState),
      degradedState: proof?.degradedState ?? null,
      degradedStateRankCap: gpuHmrDegradedStateRankCap(proof?.degradedState),
      satisfied: false,
      reason: "unknown_required_proof_state",
    };
  }
  if (proof === null) {
    return {
      requiredState,
      requiredRank,
      resultState: null,
      resultRank: 0,
      effectiveResultRank: 0,
      degradedState: null,
      degradedStateRankCap: null,
      satisfied: false,
      reason: "proof_state_missing",
    };
  }

  const resultRank = gpuHmrProofStateRank(proof.resultState);
  const degradedStateRankCap = gpuHmrDegradedStateRankCap(proof.degradedState);
  const effectiveResultRank =
    degradedStateRankCap === null ? resultRank : Math.min(resultRank, degradedStateRankCap);
  const satisfied = effectiveResultRank >= requiredRank;
  const reason =
    resultRank === 0
      ? "unknown_result_proof_state"
      : degradedStateRankCap === 0
        ? "unknown_degraded_proof_state"
        : resultRank < requiredRank
          ? "proof_state_below_required"
          : !satisfied
            ? "degraded_state_blocks_required_proof"
            : undefined;

  return {
    requiredState,
    requiredRank,
    resultState: proof.resultState,
    resultRank,
    effectiveResultRank,
    degradedState: proof.degradedState,
    degradedStateRankCap,
    satisfied,
    ...(reason ? { reason } : {}),
  };
}
