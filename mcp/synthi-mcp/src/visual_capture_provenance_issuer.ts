export const VISUAL_CAPTURE_PROVENANCE_REFUSAL_SCHEMA =
  "synthi.gpu_hmr.visual_capture_provenance_issuer_refusal.v1" as const;

export const VISUAL_CAPTURE_PROVENANCE_REFUSAL_CODE =
  "native_runtime_owned_visual_capture_provenance_issuer_unavailable" as const;

export interface VisualCaptureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisualCaptureScale {
  readonly numerator: number;
  readonly denominator: number;
}

export interface VisualCaptureBackendMechanics {
  readonly mechanics: string;
  readonly mechanicsSha256: string;
}

export interface VisualCaptureObservationPoint {
  readonly dispatchId: string;
  readonly outputId: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly editId: string;
  readonly editHash: string;
  readonly epochId: string;
  readonly monotonicNs: bigint;
  readonly processId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly outputTargetId: string;
  readonly deterministicControlState: string;
  readonly deterministicControlSha256: string;
  readonly captureBackend: VisualCaptureBackendMechanics;
  readonly authenticatedSourceStreamSha256: string;
  readonly parentRuntimeAdmissionId: string;
  readonly parentPreOracleLedgerId: string;
  readonly width: number;
  readonly height: number;
  readonly crop: VisualCaptureRegion;
  readonly scale: VisualCaptureScale;
}

export interface VisualCaptureObservationTuple {
  readonly schemaVersion: "synthi.gpu_hmr.visual_runtime_tuple.v2";
  readonly previous: VisualCaptureObservationPoint;
  readonly current: VisualCaptureObservationPoint;
}

export interface VisualCaptureProvenanceIssuerRefusal {
  readonly schemaVersion: typeof VISUAL_CAPTURE_PROVENANCE_REFUSAL_SCHEMA;
  readonly status: "refused";
  readonly reasonCode: typeof VISUAL_CAPTURE_PROVENANCE_REFUSAL_CODE;
  readonly issuerAvailable: false;
  readonly receiptIssuanceAvailable: false;
  readonly receiptConsumptionAvailable: false;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly runtimeAccepted: false;
  readonly dispatchAccepted: false;
  readonly strictLedgerClosed: false;
}

const REFUSAL: VisualCaptureProvenanceIssuerRefusal = Object.freeze({
  schemaVersion: VISUAL_CAPTURE_PROVENANCE_REFUSAL_SCHEMA,
  status: "refused",
  reasonCode: VISUAL_CAPTURE_PROVENANCE_REFUSAL_CODE,
  issuerAvailable: false,
  receiptIssuanceAvailable: false,
  receiptConsumptionAvailable: false,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runtimeAccepted: false,
  dispatchAccepted: false,
  strictLedgerClosed: false,
});

export function createVisualCaptureProvenanceIssuerCore(
  _request?: unknown,
): VisualCaptureProvenanceIssuerRefusal {
  return REFUSAL;
}
