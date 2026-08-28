export const GPU_HMR_OUTPUT_ORACLE_KIND_REGISTRY_SCHEMA_VERSION =
  "synthi.gpu_hmr.output_oracle_kind_registry.v1";

export const GPU_HMR_OUTPUT_ORACLE_MODALITIES = Object.freeze({
  compute: "compute_oracle",
  visual: "visual_oracle",
} as const);

export type GpuHmrOutputOracleModality = keyof typeof GPU_HMR_OUTPUT_ORACLE_MODALITIES;

export const GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS = Object.freeze([
  "compute_oracle",
  "compute",
  "buffer_checksum",
  "compute_readback",
  "source_derived_buffer_checksum",
  "edit_contract",
  "sentinel_buffer_value",
  "kernel_checksum",
  "kernel_side_checksum",
  "per_pass_checksum",
  "dispatch_counter",
]);

export const GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS = Object.freeze([
  "visual_oracle",
  "runtime_visual_oracle",
  "visual",
  "visual_frame",
  "visual_frame_readback",
  "visual_framebuffer_diff",
  "deterministic_visual_frame",
  "deterministic_framebuffer_diff",
  "deterministic_visual_oracle",
  "render_target_hash",
  "accumulation_buffer_hash",
  "selected_pixels",
  "selected_pixel_values",
]);

const OUTPUT_ORACLE_MODALITY_BY_KIND = new Map<string, GpuHmrOutputOracleModality>([
  ...GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS.map(
    (kind) => [kind, "compute"] as const
  ),
  ...GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS.map(
    (kind) => [kind, "visual"] as const
  ),
]);

export function normalizeGpuHmrOutputOracleKind(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

export function classifyGpuHmrOutputOracleKind(value: unknown) {
  const kind = normalizeGpuHmrOutputOracleKind(value);
  const modality = kind ? OUTPUT_ORACLE_MODALITY_BY_KIND.get(kind) ?? null : null;
  const failureCode = kind
    ? (modality ? null : "output_oracle_kind_unknown")
    : "output_oracle_kind_missing";
  const topLevelKind = modality ? GPU_HMR_OUTPUT_ORACLE_MODALITIES[modality] : null;

  return {
    schemaVersion: GPU_HMR_OUTPUT_ORACLE_KIND_REGISTRY_SCHEMA_VERSION,
    schema_version: GPU_HMR_OUTPUT_ORACLE_KIND_REGISTRY_SCHEMA_VERSION,
    accepted: modality !== null,
    kind,
    modality,
    topLevelKind,
    top_level_kind: topLevelKind,
    failureCode,
    failure_code: failureCode,
  };
}

export function isGpuHmrComputeOutputOracleKind(value: unknown): boolean {
  return classifyGpuHmrOutputOracleKind(value).modality === "compute";
}

export function isGpuHmrVisualOutputOracleKind(value: unknown): boolean {
  return classifyGpuHmrOutputOracleKind(value).modality === "visual";
}
