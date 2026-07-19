export const GPU_HMR_OUTPUT_ORACLE_KIND_REGISTRY_SCHEMA_VERSION =
  'synthi.gpu_hmr.output_oracle_kind_registry.v1';

export const GPU_HMR_OUTPUT_ORACLE_MODALITIES = Object.freeze({
  compute: 'compute_oracle',
  visual: 'visual_oracle',
});

const COMPUTE_OUTPUT_ORACLE_KINDS = Object.freeze([
  'compute_oracle',
  'compute',
  'buffer_checksum',
  'compute_readback',
  'source_derived_buffer_checksum',
  'edit_contract',
  'sentinel_buffer_value',
  'kernel_checksum',
  'kernel_side_checksum',
  'per_pass_checksum',
  'dispatch_counter',
]);

const VISUAL_OUTPUT_ORACLE_KINDS = Object.freeze([
  'visual_oracle',
  'runtime_visual_oracle',
  'visual',
  'visual_frame',
  'visual_frame_readback',
  'visual_framebuffer_diff',
  'deterministic_visual_frame',
  'deterministic_framebuffer_diff',
  'deterministic_visual_oracle',
  'render_target_hash',
  'accumulation_buffer_hash',
  'selected_pixels',
  'selected_pixel_values',
]);

export const GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS = COMPUTE_OUTPUT_ORACLE_KINDS;
export const GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS = VISUAL_OUTPUT_ORACLE_KINDS;

const OUTPUT_ORACLE_MODALITY_BY_KIND = new Map([
  ...COMPUTE_OUTPUT_ORACLE_KINDS.map((kind) => [kind, 'compute']),
  ...VISUAL_OUTPUT_ORACLE_KINDS.map((kind) => [kind, 'visual']),
]);

export function normalizeGpuHmrOutputOracleKind(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

export function classifyGpuHmrOutputOracleKind(value) {
  const kind = normalizeGpuHmrOutputOracleKind(value);
  const modality = kind ? OUTPUT_ORACLE_MODALITY_BY_KIND.get(kind) ?? null : null;
  return {
    schemaVersion: GPU_HMR_OUTPUT_ORACLE_KIND_REGISTRY_SCHEMA_VERSION,
    schema_version: GPU_HMR_OUTPUT_ORACLE_KIND_REGISTRY_SCHEMA_VERSION,
    accepted: modality !== null,
    kind,
    modality,
    topLevelKind: modality ? GPU_HMR_OUTPUT_ORACLE_MODALITIES[modality] : null,
    top_level_kind: modality ? GPU_HMR_OUTPUT_ORACLE_MODALITIES[modality] : null,
    failureCode: kind
      ? (modality ? null : 'output_oracle_kind_unknown')
      : 'output_oracle_kind_missing',
    failure_code: kind
      ? (modality ? null : 'output_oracle_kind_unknown')
      : 'output_oracle_kind_missing',
  };
}

export function isGpuHmrComputeOutputOracleKind(value) {
  return classifyGpuHmrOutputOracleKind(value).modality === 'compute';
}

export function isGpuHmrVisualOutputOracleKind(value) {
  return classifyGpuHmrOutputOracleKind(value).modality === 'visual';
}
