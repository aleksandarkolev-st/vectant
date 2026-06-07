import {
  embeddedGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
  type GpuHmrLedgerValidation,
} from "./gpu_proof_ledger.js";

export const GPU_HMR_PROOF_SCHEMA_VERSION = "synthi.gpu.hmr.proof.v1";

export const GPU_HMR_PROOF_STATES = [
  "gpu-hmr-compile-proven",
  "gpu-hmr-symbol-bound",
  "gpu-hmr-abi-proven",
  "gpu-hmr-epoch-swap-proven",
  "gpu-hmr-dispatch-observed",
  "gpu-hmr-dispatch-safe-proven",
  "gpu-hmr-output-oracle-proven",
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
  "gpu-hmr-epoch-retirement-pending",
  "gpu-hmr-epoch-swap-unverified",
  "gpu-hmr-ram-io-unavailable",
  "gpu-hmr-visual-only",
  "gpu-hmr-visual-evidence-missing",
  "gpu-hmr-original-host-path-unattached",
  "gpu-hmr-fission-unverified",
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
  proofLedgerValidation?: GpuHmrLedgerValidation | null;
  runtimeProofArtifactValidation?: GpuHmrRuntimeProofArtifactValidation | null;
}

export interface GpuHmrRuntimeProofArtifactValidation {
  present: boolean;
  accepted: boolean;
  source: string | null;
  failedGates: Array<{ code: string }>;
}

export interface GpuHmrProofMatchOpts {
  sinceTs?: number;
  module?: string;
  previewId?: string;
}

const PROOF_STATE_RANKS = new Map<string, number>(
  GPU_HMR_PROOF_STATES.map((state, index) => [state, index + 1])
);

const DEGRADED_STATE_RANK_CAPS = new Map<string, number>([
  ["gpu-hmr-fake-launch-path", gpuHmrProofStateRank("gpu-hmr-symbol-bound")],
  ["gpu-hmr-unknown-arg-provenance", gpuHmrProofStateRank("gpu-hmr-dispatch-observed")],
  ["gpu-hmr-abi-unverified", gpuHmrProofStateRank("gpu-hmr-symbol-bound")],
  ["gpu-hmr-dispatch-unobserved", gpuHmrProofStateRank("gpu-hmr-epoch-swap-proven")],
  ["gpu-hmr-output-unobserved", gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")],
  ["gpu-hmr-host-replaced", gpuHmrProofStateRank("gpu-hmr-output-oracle-proven")],
  ["gpu-hmr-epoch-retirement-pending", gpuHmrProofStateRank("gpu-hmr-abi-proven")],
  ["gpu-hmr-epoch-swap-unverified", gpuHmrProofStateRank("gpu-hmr-abi-proven")],
  ["gpu-hmr-ram-io-unavailable", gpuHmrProofStateRank("gpu-hmr-epoch-swap-proven")],
  ["gpu-hmr-visual-only", gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")],
  ["gpu-hmr-visual-evidence-missing", gpuHmrProofStateRank("gpu-hmr-dispatch-safe-proven")],
  ["gpu-hmr-original-host-path-unattached", gpuHmrProofStateRank("gpu-hmr-host-preservation-proven")],
  ["gpu-hmr-fission-unverified", 0],
]);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nestedString(raw: Record<string, unknown>, key: string): string | null {
  const direct = stringOrNull(raw[key]);
  if (direct) return direct;
  for (const nestedKey of ["data", "detail"]) {
    const nested = raw[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const value = stringOrNull((nested as Record<string, unknown>)[key]);
      if (value) return value;
    }
  }
  return null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function objectField(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const obj = objectOrNull(raw[key]);
    if (obj !== null) return obj;
  }
  return null;
}

function boolField(raw: Record<string, unknown> | null, ...keys: string[]): boolean | null {
  if (raw === null) return null;
  for (const key of keys) {
    if (typeof raw[key] === "boolean") return raw[key] as boolean;
  }
  return null;
}

function arrayField(raw: Record<string, unknown> | null, ...keys: string[]): unknown[] | null {
  if (raw === null) return null;
  for (const key of keys) {
    if (Array.isArray(raw[key])) return raw[key] as unknown[];
  }
  return null;
}

const RUNTIME_PROOF_ARTIFACT_KEYS = [
  "runtimeProofArtifact",
  "runtime_proof_artifact",
  "validationRuntimeProofArtifact",
  "validation_runtime_proof_artifact",
  "gpuHmrRuntimeProofArtifact",
  "gpu_hmr_runtime_proof_artifact",
  "gpuRuntimeProofArtifact",
  "gpu_runtime_proof_artifact",
] as const;

function runtimeProofArtifactCandidate(
  raw: Record<string, unknown>
): { source: string; artifact: Record<string, unknown> } | null {
  for (const key of RUNTIME_PROOF_ARTIFACT_KEYS) {
    const artifact = objectOrNull(raw[key]);
    if (artifact !== null) return { source: key, artifact };
  }
  for (const nestedKey of ["data", "detail"]) {
    const nested = objectOrNull(raw[nestedKey]);
    if (nested === null) continue;
    const nestedCandidate = runtimeProofArtifactCandidate(nested);
    if (nestedCandidate !== null) {
      return {
        source: `${nestedKey}.${nestedCandidate.source}`,
        artifact: nestedCandidate.artifact,
      };
    }
  }
  if (
    objectOrNull(raw.acceptanceContract ?? raw.acceptance_contract) !== null
    || objectOrNull(raw.acceptanceContractEvaluation ?? raw.acceptance_contract_evaluation) !== null
    || objectOrNull(raw.proofLedgerQuery ?? raw.proof_ledger_query) !== null
    || boolField(raw, "gpuHmrSuccess", "gpu_hmr_success") !== null
  ) {
    return { source: "telemetry", artifact: raw };
  }
  return null;
}

function validateRuntimeProofArtifactAcceptance(
  raw: Record<string, unknown>
): GpuHmrRuntimeProofArtifactValidation {
  const candidate = runtimeProofArtifactCandidate(raw);
  if (candidate === null) {
    return {
      present: false,
      accepted: false,
      source: null,
      failedGates: [{ code: "runtime_proof_artifact_missing" }],
    };
  }

  const artifact = candidate.artifact;
  const failures: Array<{ code: string }> = [];
  const proofLedger = objectField(artifact, "proofLedger", "proof_ledger");
  const proofLedgerQuery = objectField(artifact, "proofLedgerQuery", "proof_ledger_query");
  const acceptanceContract = objectField(artifact, "acceptanceContract", "acceptance_contract");
  const acceptanceContractEvaluation = objectField(
    artifact,
    "acceptanceContractEvaluation",
    "acceptance_contract_evaluation"
  );
  const acceptanceContractConsistency = objectField(
    artifact,
    "acceptanceContractConsistency",
    "acceptance_contract_consistency"
  );
  const proofLedgerSourceConsistency = objectField(
    artifact,
    "proofLedgerSourceConsistency",
    "proof_ledger_source_consistency"
  );
  const deterministicVisualModeEvaluation = objectField(
    artifact,
    "deterministicVisualModeEvaluation",
    "deterministic_visual_mode_evaluation"
  );
  const stageResults = arrayField(artifact, "stageResults", "stage_results");
  const limitations = arrayField(artifact, "limitations");

  if (boolField(artifact, "fullRuntimeProven", "full_runtime_proven") !== true) {
    failures.push({ code: "runtime_full_proof_not_proven" });
  }
  if (boolField(artifact, "gpuHmrSuccess", "gpu_hmr_success") !== true) {
    failures.push({ code: "runtime_proof_artifact_gpu_hmr_success_false" });
  }
  if (stageResults === null || stageResults.length === 0) {
    failures.push({ code: "runtime_proof_artifact_stage_results_missing" });
  } else if (stageResults.some((stage) => objectOrNull(stage)?.status !== "passed")) {
    failures.push({ code: "runtime_proof_artifact_stage_failed" });
  }
  if (limitations === null) {
    failures.push({ code: "runtime_proof_artifact_limitations_missing" });
  } else if (limitations.length > 0) {
    failures.push({ code: "runtime_proof_artifact_limitations_present" });
  }
  if (proofLedger === null) failures.push({ code: "proof_ledger_missing" });
  if (proofLedgerQuery === null) {
    failures.push({ code: "proof_ledger_query_missing" });
  } else if (boolField(proofLedgerQuery, "gpuHmrSuccess", "gpu_hmr_success") !== true) {
    failures.push({ code: "proof_ledger_query_rejected" });
  }
  if (acceptanceContract === null) failures.push({ code: "acceptance_contract_missing" });
  if (acceptanceContractEvaluation === null) {
    failures.push({ code: "acceptance_contract_evaluation_missing" });
  } else if (boolField(acceptanceContractEvaluation, "accepted") !== true) {
    failures.push({ code: "acceptance_contract_rejected" });
  }
  if (acceptanceContractConsistency === null) {
    failures.push({ code: "acceptance_contract_consistency_missing" });
  } else if (boolField(acceptanceContractConsistency, "accepted") !== true) {
    failures.push({ code: "acceptance_contract_consistency_rejected" });
  }
  if (proofLedgerSourceConsistency === null) {
    failures.push({ code: "proof_ledger_source_consistency_missing" });
  } else if (boolField(proofLedgerSourceConsistency, "accepted") !== true) {
    failures.push({ code: "proof_ledger_source_consistency_rejected" });
  }
  if (
    deterministicVisualModeEvaluation !== null
    && boolField(deterministicVisualModeEvaluation, "accepted") !== true
  ) {
    failures.push({ code: "deterministic_visual_mode_rejected" });
  }

  return {
    present: true,
    accepted: failures.length === 0,
    source: candidate.source,
    failedGates: failures,
  };
}

export function gpuHmrProofModule(proof: GpuHmrProofTelemetry | null): string | null {
  return proof ? nestedString(proof.raw, "module") : null;
}

export function gpuHmrProofPreviewId(proof: GpuHmrProofTelemetry | null): string | null {
  if (!proof) return null;
  return nestedString(proof.raw, "preview_id") ?? nestedString(proof.raw, "previewId");
}

export function gpuHmrProofMatches(
  proof: GpuHmrProofTelemetry | null,
  opts: GpuHmrProofMatchOpts = {}
): proof is GpuHmrProofTelemetry {
  if (proof === null) return false;
  if (opts.sinceTs !== undefined && Number.isFinite(opts.sinceTs) && proof.observedAt < opts.sinceTs) {
    return false;
  }
  const expectedModule = opts.module?.trim();
  if (expectedModule && gpuHmrProofModule(proof) !== expectedModule) {
    return false;
  }
  const expectedPreviewId = opts.previewId?.trim();
  if (expectedPreviewId && gpuHmrProofPreviewId(proof) !== expectedPreviewId) {
    return false;
  }
  return true;
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
  let satisfied = effectiveResultRank >= requiredRank;
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
  let proofLedgerValidation: GpuHmrLedgerValidation | null | undefined;
  let runtimeProofArtifactValidation: GpuHmrRuntimeProofArtifactValidation | null | undefined;
  let ledgerReason: string | undefined;
  let runtimeArtifactReason: string | undefined;
  if (requiredState === "gpu-hmr-full-runtime-proven" && reason === undefined) {
    const ledger = embeddedGpuHmrProofLedger(proof.raw);
    if (ledger === null) {
      satisfied = false;
      proofLedgerValidation = null;
      ledgerReason = "proof_ledger_missing";
    } else {
      proofLedgerValidation = queryGpuHmrLedgerInvariants(ledger);
      const proofIdIsLedgerId = proof.proofId?.startsWith("gpu-ledger-proof:") === true;
      if (proofIdIsLedgerId && proof.proofId !== proofLedgerValidation.proofId) {
        proofLedgerValidation = {
          ...proofLedgerValidation,
          gpuHmrSuccess: false,
          failedInvariants: [
            ...proofLedgerValidation.failedInvariants,
            {
              code: "telemetry_proof_id_ledger_mismatch",
              telemetryProofId: proof.proofId,
              ledgerProofId: proofLedgerValidation.proofId,
            },
          ],
        };
      }
      if (!proofLedgerValidation.gpuHmrSuccess) {
        satisfied = false;
        ledgerReason = "proof_ledger_rejected";
      }
    }
    if (ledgerReason === undefined) {
      runtimeProofArtifactValidation = validateRuntimeProofArtifactAcceptance(proof.raw);
      if (!runtimeProofArtifactValidation.accepted) {
        satisfied = false;
        runtimeArtifactReason = runtimeProofArtifactValidation.present
          ? "runtime_proof_artifact_rejected"
          : "runtime_proof_artifact_missing";
      }
    }
  }

  return {
    requiredState,
    requiredRank,
    resultState: proof.resultState,
    resultRank,
    effectiveResultRank,
    degradedState: proof.degradedState,
    degradedStateRankCap,
    satisfied,
    ...(proofLedgerValidation !== undefined ? { proofLedgerValidation } : {}),
    ...(runtimeProofArtifactValidation !== undefined ? { runtimeProofArtifactValidation } : {}),
    ...(reason ?? ledgerReason ?? runtimeArtifactReason
      ? { reason: reason ?? ledgerReason ?? runtimeArtifactReason }
      : {}),
  };
}
