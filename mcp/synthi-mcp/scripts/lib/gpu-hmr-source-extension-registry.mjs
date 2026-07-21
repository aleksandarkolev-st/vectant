import path from 'node:path';

export const GPU_HMR_SOURCE_EXTENSION_REGISTRY_SCHEMA_VERSION =
  'synthi.gpu_hmr.source_extension_registry.v1';
export const GPU_HMR_SOURCE_EXTENSION_REGISTRY_AUTHORITY =
  'legacy_source_suffix_hints_only_not_compiler_build_or_gpu_hmr_proof';

const definitions = [
  ['.c', 'translation_unit', 'c', true],
  ['.c++', 'translation_unit', 'cpp', true],
  ['.cc', 'translation_unit', 'cpp', true],
  ['.cl', 'translation_unit', 'opencl', true],
  ['.comp', 'translation_unit', 'glsl', true],
  ['.cpp', 'translation_unit', 'cpp', true],
  ['.cu', 'translation_unit', 'cuda', true],
  ['.cuh', 'language_context', 'cuda', false],
  ['.cxx', 'translation_unit', 'cpp', true],
  ['.frag', 'translation_unit', 'glsl', true],
  ['.geom', 'translation_unit', 'glsl', true],
  ['.glsl', 'translation_unit', 'glsl', true],
  ['.h', 'neutral_context', null, false],
  ['.h++', 'language_context', 'cpp', false],
  ['.hh', 'language_context', 'cpp', false],
  ['.hip', 'translation_unit', 'hip', true],
  ['.hlsl', 'translation_unit', 'hlsl', true],
  ['.hpp', 'language_context', 'cpp', false],
  ['.hxx', 'language_context', 'cpp', false],
  ['.inc', 'neutral_context', null, false],
  ['.inl', 'neutral_context', null, false],
  ['.ipp', 'neutral_context', null, false],
  ['.metal', 'translation_unit', 'metal', true],
  ['.opencl', 'translation_unit', 'opencl', true],
  ['.rs', 'translation_unit', 'rust', true],
  ['.slang', 'translation_unit', 'slang', true],
  ['.tesc', 'translation_unit', 'glsl', true],
  ['.tese', 'translation_unit', 'glsl', true],
  ['.tpp', 'neutral_context', null, false],
  ['.vert', 'translation_unit', 'glsl', true],
  ['.wgsl', 'translation_unit', 'wgsl', true],
  ['.zig', 'translation_unit', 'zig', true],
];

export const GPU_HMR_SOURCE_EXTENSION_REGISTRY = Object.freeze(
  definitions.map(([extension, role, requestLanguage, automaticEntryCandidate]) => Object.freeze({
    extension,
    role,
    requestLanguage,
    automaticEntryCandidate,
    classificationSupportOnly: true,
    classification_support_only: true,
    canEstablishGpuCapability: false,
  })),
);

const metadataByExtension = new Map(
  GPU_HMR_SOURCE_EXTENSION_REGISTRY.map((entry) => [entry.extension, entry]),
);

export function normalizeGpuHmrSourceExtension(value) {
  const normalized = String(value ?? '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const basename = path.posix.basename(normalized);
  const extension = normalized === basename && /^\.[^.]+$/.test(basename)
    ? basename
    : path.posix.extname(basename);
  return extension.toLowerCase();
}

export function gpuHmrSourceExtensionMetadata(value) {
  return metadataByExtension.get(normalizeGpuHmrSourceExtension(value)) ?? null;
}

// The registry is intentionally incomplete. Callers may use this result as a
// compatibility hint, but must not use its absence to reject ordinary text
// sources or to establish compiler, build, or GPU-HMR authority.
export function gpuHmrSourceSuffixHint(value) {
  const extension = normalizeGpuHmrSourceExtension(value) || null;
  const metadata = extension ? metadataByExtension.get(extension) ?? null : null;
  return Object.freeze({
    extension,
    language: metadata?.requestLanguage ?? null,
    role: metadata?.role ?? 'open_vocabulary_unknown',
    registrySchemaVersion: GPU_HMR_SOURCE_EXTENSION_REGISTRY_SCHEMA_VERSION,
    registry_schema_version: GPU_HMR_SOURCE_EXTENSION_REGISTRY_SCHEMA_VERSION,
    proofAuthority: GPU_HMR_SOURCE_EXTENSION_REGISTRY_AUTHORITY,
    proof_authority: GPU_HMR_SOURCE_EXTENSION_REGISTRY_AUTHORITY,
    classificationSupportOnly: true,
    classification_support_only: true,
    canEstablishGpuCapability: false,
  });
}

export function isGpuHmrSourcePath(value) {
  // Compatibility-only predicate. This must not gate source-first intake.
  return gpuHmrSourceExtensionMetadata(value) !== null;
}

export function isGpuHmrAutomaticEntryCandidate(value) {
  // Compatibility-only predicate. This must not route source-first entries.
  return gpuHmrSourceExtensionMetadata(value)?.automaticEntryCandidate === true;
}
