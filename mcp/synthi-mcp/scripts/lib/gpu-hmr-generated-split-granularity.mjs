import { createHash } from 'node:crypto';

export const GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.generated_split_granularity.v1';
export const GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_SCHEMA_VERSION =
  'synthi.gpu_hmr.generated_split_deterministic_fission.v1';
export const GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION =
  'synthi.gpu_hmr.generated_split_deterministic_fission_evidence.v1';

const REQUIRED_FISSION_VERIFICATION_CATEGORIES = [
  'selected_island_binding',
  'source_mapping',
  'include_closure',
  'symbol_ownership',
  'dependency_closure',
  'abi_membrane',
  'compile_recipe',
  'loader_capability',
  'output_oracle',
];

const TYPED_EVIDENCE_CATEGORY_ALIASES = {
  selected_island_binding: ['selected_island', 'island_binding', 'selected_island_proof'],
  source_mapping: ['source_map', 'source_mapping_proof'],
  include_closure: ['include_dependency_closure', 'include_closure_proof'],
  symbol_ownership: ['symbol_binding', 'symbol_ownership_proof'],
  dependency_closure: ['dependency_closure_proof'],
  abi_membrane: ['abi_proof', 'abi_compatibility', 'abi_membrane_proof'],
  compile_recipe: ['compile_proof', 'compile_recipe_proof', 'compiler_invocation'],
  loader_capability: ['loader_runtime_proof', 'runtime_loader_proof', 'runtime_proof'],
  output_oracle: ['output_oracle_proof', 'oracle_proof'],
};

const CONTENT_ADDRESSED_EVIDENCE_REF_RE =
  /^(?:evidence|validation):[a-z0-9._/-]+(?::[a-z0-9._/-]+)*:sha256:[0-9a-f]{64}$/i;
const CONTENT_ADDRESSED_ID_RE =
  /^[a-z][a-z0-9._-]*(?::[a-z0-9._/-]+)*:sha256:[0-9a-f]{64}$/i;
const SHA256_CONTENT_ADDRESS_RE = /^sha256:[0-9a-f]{64}$/i;

const DEFAULT_DEVICE_BY_VENDOR = {
  cuda: 'device.cu',
  rocm: 'device.hip',
};

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function verifierReportEvidenceId(value) {
  return `evidence:fission-verifier-report:generated-split:sha256:${sha256Hex(stableJson(value))}`;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function cleanRel(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function compactStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function compactObjects(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function normalizePathList(values) {
  return compactStrings(values).map(cleanRel).filter(Boolean);
}

function normalizeEvidenceCategory(value) {
  return String(value ?? '')
    .trim()
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function categoryAliases(category) {
  return new Set([
    category,
    ...(TYPED_EVIDENCE_CATEGORY_ALIASES[category] ?? []),
  ].map(normalizeEvidenceCategory));
}

function isContentAddressedEvidenceRef(value) {
  return CONTENT_ADDRESSED_EVIDENCE_REF_RE.test(String(value ?? '').trim());
}

function isContentAddressedId(value) {
  const trimmed = String(value ?? '').trim();
  return CONTENT_ADDRESSED_ID_RE.test(trimmed) || SHA256_CONTENT_ADDRESS_RE.test(trimmed);
}

function evidenceRecordSchema(record) {
  return firstText(record?.schemaVersion, record?.schema_version, record?.schema);
}

function evidenceRecordCategory(record) {
  return normalizeEvidenceCategory(firstText(
    record?.category,
    record?.evidenceCategory,
    record?.evidence_category,
    record?.proofCategory,
    record?.proof_category,
  ));
}

function evidenceRecordType(record) {
  return normalizeEvidenceCategory(firstText(
    record?.evidenceType,
    record?.evidence_type,
    record?.kind,
    record?.proofType,
    record?.proof_type,
  ));
}

function evidenceRecordRefs(record) {
  return compactStrings([
    record?.evidenceRef,
    record?.evidence_ref,
    ...(Array.isArray(record?.evidenceRefs) ? record.evidenceRefs : []),
    ...(Array.isArray(record?.evidence_refs) ? record.evidence_refs : []),
  ]);
}

function evidenceRecordContentAddresses(record) {
  return compactStrings([
    record?.contentHash,
    record?.content_hash,
    record?.artifactHash,
    record?.artifact_hash,
    record?.contentAddressedId,
    record?.content_addressed_id,
    record?.artifactId,
    record?.artifact_id,
    record?.proofId,
    record?.proof_id,
    ...(Array.isArray(record?.contentHashes) ? record.contentHashes : []),
    ...(Array.isArray(record?.content_hashes) ? record.content_hashes : []),
    ...(Array.isArray(record?.artifactHashes) ? record.artifactHashes : []),
    ...(Array.isArray(record?.artifact_hashes) ? record.artifact_hashes : []),
    ...(Array.isArray(record?.artifactIds) ? record.artifactIds : []),
    ...(Array.isArray(record?.artifact_ids) ? record.artifact_ids : []),
    ...(Array.isArray(record?.proofIds) ? record.proofIds : []),
    ...(Array.isArray(record?.proof_ids) ? record.proof_ids : []),
  ]).filter(isContentAddressedId);
}

function evidenceRecordSubject(record) {
  return asObject(
    record?.subject
    ?? record?.proofSubject
    ?? record?.proof_subject
    ?? record?.binding
    ?? record?.selectedIsland
    ?? record?.selected_island,
  );
}

function evidenceRecordPaths(record) {
  const subject = evidenceRecordSubject(record);
  return normalizePathList([
    record?.selectedPath,
    record?.selected_path,
    record?.sourcePath,
    record?.source_path,
    ...(Array.isArray(record?.sourcePaths) ? record.sourcePaths : []),
    ...(Array.isArray(record?.source_paths) ? record.source_paths : []),
    subject.selectedPath,
    subject.selected_path,
    subject.sourcePath,
    subject.source_path,
    ...(Array.isArray(subject.sourcePaths) ? subject.sourcePaths : []),
    ...(Array.isArray(subject.source_paths) ? subject.source_paths : []),
  ]);
}

function evidenceRecordIslandIds(record) {
  const subject = evidenceRecordSubject(record);
  return compactStrings([
    record?.selectedIslandId,
    record?.selected_island_id,
    record?.islandId,
    record?.island_id,
    subject.selectedIslandId,
    subject.selected_island_id,
    subject.islandId,
    subject.island_id,
    ...(Array.isArray(record?.selectedIslandIds) ? record.selectedIslandIds : []),
    ...(Array.isArray(record?.selected_island_ids) ? record.selected_island_ids : []),
  ]);
}

function evidenceRecordTargetSymbols(record) {
  const subject = evidenceRecordSubject(record);
  return compactStrings([
    record?.targetSymbol,
    record?.target_symbol,
    record?.kernelSymbol,
    record?.kernel_symbol,
    subject.targetSymbol,
    subject.target_symbol,
    subject.kernelSymbol,
    subject.kernel_symbol,
    ...(Array.isArray(record?.targetSymbols) ? record.targetSymbols : []),
    ...(Array.isArray(record?.target_symbols) ? record.target_symbols : []),
    ...(Array.isArray(subject.targetSymbols) ? subject.targetSymbols : []),
    ...(Array.isArray(subject.target_symbols) ? subject.target_symbols : []),
  ]);
}

function evidenceRecordMatchesCategory(record, category) {
  const aliases = categoryAliases(category);
  return aliases.has(evidenceRecordCategory(record)) || aliases.has(evidenceRecordType(record));
}

function collectFissionEvidenceRecords(...values) {
  const records = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (
      evidenceRecordSchema(value) === GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION
      || evidenceRecordCategory(value)
    ) {
      records.push(value);
    }
    for (const key of [
      'evidence',
      'evidence_records',
      'evidenceRecords',
      'verification_evidence',
      'verificationEvidence',
      'deterministic_fission_evidence',
      'deterministicFissionEvidence',
      'fission_evidence',
      'fissionEvidence',
      'proof_artifacts',
      'proofArtifacts',
    ]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key]);
    }
  };
  for (const value of values) visit(value);
  return records;
}

function typedEvidenceFailure(category, reason, details = {}) {
  return {
    accepted: false,
    failureCode: `generated_split.${category}_${reason}`,
    evidenceIds: [],
    evidenceTypes: [],
    contentAddresses: [],
    ...details,
  };
}

function typedEvidenceGate(category, records, { selectedPath, selectedIslandId, selectedKernel } = {}) {
  const candidates = records.filter((record) => evidenceRecordMatchesCategory(record, category));
  const typedCandidates = candidates.filter((record) =>
    evidenceRecordSchema(record) === GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION
    && evidenceRecordType(record)
  );
  if (typedCandidates.length === 0) {
    return typedEvidenceFailure(category, 'typed_evidence_missing', {
      observedCandidateCount: candidates.length,
    });
  }

  const withRefs = typedCandidates
    .map((record) => ({
      record,
      evidenceIds: evidenceRecordRefs(record).filter(isContentAddressedEvidenceRef),
      contentAddresses: evidenceRecordContentAddresses(record),
    }))
    .filter((item) => item.evidenceIds.length > 0);
  if (withRefs.length === 0) {
    return typedEvidenceFailure(category, 'content_addressed_evidence_ref_missing', {
      observedCandidateCount: typedCandidates.length,
    });
  }

  const withContentAddresses = withRefs.filter((item) => item.contentAddresses.length > 0);
  if (withContentAddresses.length === 0) {
    return typedEvidenceFailure(category, 'content_addressed_payload_missing', {
      observedCandidateCount: withRefs.length,
    });
  }

  const normalizedSelectedPath = cleanRel(selectedPath);
  const pathBound = withContentAddresses.filter((item) =>
    normalizedSelectedPath && evidenceRecordPaths(item.record).includes(normalizedSelectedPath)
  );
  if (pathBound.length === 0) {
    return typedEvidenceFailure(category, 'selected_path_binding_missing', {
      observedCandidateCount: withContentAddresses.length,
    });
  }

  let acceptedRecords = pathBound;
  if (category === 'selected_island_binding') {
    acceptedRecords = acceptedRecords.filter((item) =>
      evidenceRecordIslandIds(item.record).includes(selectedIslandId)
    );
    if (acceptedRecords.length === 0) {
      return typedEvidenceFailure(category, 'selected_island_id_binding_missing', {
        observedCandidateCount: pathBound.length,
      });
    }
    if (selectedKernel) {
      acceptedRecords = acceptedRecords.filter((item) =>
        evidenceRecordTargetSymbols(item.record).includes(selectedKernel)
      );
      if (acceptedRecords.length === 0) {
        return typedEvidenceFailure(category, 'target_symbol_binding_missing', {
          observedCandidateCount: pathBound.length,
        });
      }
    }
  }

  return {
    accepted: true,
    failureCode: null,
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    evidenceIds: compactStrings(acceptedRecords.flatMap((item) => item.evidenceIds)),
    evidenceTypes: compactStrings(acceptedRecords.map((item) => evidenceRecordType(item.record))),
    contentAddresses: compactStrings(acceptedRecords.flatMap((item) => item.contentAddresses)),
    observedCandidateCount: acceptedRecords.length,
  };
}

function sourceForPath(files, filePath) {
  const normalizedPath = cleanRel(filePath);
  const normalizedFiles = new Map(Object.entries(asObject(files)).map(([path, content]) => [
    cleanRel(path),
    String(content ?? ''),
  ]));
  return normalizedFiles.get(normalizedPath) ?? '';
}

function stripBlockAndLineComments(source) {
  return String(source ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

export function deviceKernelSymbolsFromSource(source) {
  const text = stripBlockAndLineComments(source);
  const symbols = [];
  const patterns = [
    /\b__global__\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?(?:[\w:<>,~*&\s]+\s+)?([A-Za-z_]\w*)\s*\(/g,
    /\b__kernel\s+(?:[\w:<>,~*&\s]+\s+)?([A-Za-z_]\w*)\s*\(/g,
    /\bkernel\s+void\s+([A-Za-z_]\w*)\s*\(/g,
    /@compute[\s\S]{0,160}?\bfn\s+([A-Za-z_]\w*)\s*\(/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      symbols.push(match[1]);
    }
  }
  return compactStrings(symbols);
}

export function manifestDeviceRoles(manifest, vendorHint = 'rocm') {
  const manifestObject = asObject(manifest);
  const gpu = asObject(manifestObject.gpu);
  const roles = Array.isArray(gpu.device_roles) ? gpu.device_roles : [];
  const normalizedRoles = roles
    .filter((role) => role && typeof role === 'object')
    .map((role, index) => ({
      id: String(role.id ?? `device.role.${index}`).trim() || `device.role.${index}`,
      path: cleanRel(role.path),
      sourceFiles: compactStrings(role.source_files ?? role.sourceFiles),
      compiler: String(role.compiler ?? gpu.device_compiler ?? '').trim() || null,
      arch: compactStrings(role.arch ?? gpu.arch),
      requiresRdc: role.requires_rdc === true || role.requiresRdc === true,
    }))
    .filter((role) => role.path);
  if (normalizedRoles.length > 0) return normalizedRoles;

  const vendor = String(gpu.vendor ?? vendorHint ?? '').trim().toLowerCase();
  const moduleFiles = asObject(manifestObject.module_files ?? manifestObject.moduleFiles);
  const fallbackPath = cleanRel(moduleFiles.device ?? DEFAULT_DEVICE_BY_VENDOR[vendor] ?? 'device.hip');
  return fallbackPath
    ? [{
        id: 'device.device',
        path: fallbackPath,
        sourceFiles: [],
        compiler: String(gpu.device_compiler ?? (vendor === 'cuda' ? 'nvcc' : 'hipcc')).trim(),
        arch: compactStrings(gpu.arch),
        requiresRdc: false,
      }]
    : [];
}

export function assessGeneratedGpuSplitGranularity({ manifest, files, vendor } = {}) {
  const deviceRoles = manifestDeviceRoles(manifest, vendor);
  const paths = compactStrings(deviceRoles.map((role) => role.path));
  const roleReports = paths.map((filePath) => {
    const source = sourceForPath(files, filePath);
    const kernelSymbols = deviceKernelSymbolsFromSource(source);
    return {
      path: filePath,
      present: source.length > 0,
      kernelSymbols,
      kernelCount: kernelSymbols.length,
      roleIds: deviceRoles
        .filter((role) => role.path === filePath)
        .map((role) => role.id),
    };
  });
  const kernelSymbols = compactStrings(roleReports.flatMap((role) => role.kernelSymbols));
  const missingDeviceRolePaths = roleReports
    .filter((role) => !role.present)
    .map((role) => role.path);
  const deviceTranslationUnitCount = paths.length;
  const multipleKernelsShareDeviceTranslationUnit =
    roleReports.some((role) => role.kernelCount > 1);
  const hmrReloadScope = deviceTranslationUnitCount > 1
    ? 'device_translation_unit_set'
    : 'device_translation_unit';
  const rejectedClaims = compactStrings([
    'smallest_safe_fission_island',
    'per_kernel_hmr',
  ]);

  return {
    schemaVersion: GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION,
    acceptedClaim: `${hmrReloadScope}_hmr`,
    hmrReloadScope,
    fissionGranularity: hmrReloadScope,
    proofBoundary: 'generated_manifest_device_role_topology',
    smallestSafeFissionIslandProven: false,
    perKernelHmrProven: false,
    requiresDeterministicFissionVerifierForSmallestSafeIsland: true,
    requiresDeterministicFissionVerifierForPerKernelHmr: true,
    deviceRoleCount: deviceRoles.length,
    deviceTranslationUnitCount,
    deviceRolePaths: paths,
    deviceRoles,
    roleReports,
    kernelSymbols,
    kernelCount: kernelSymbols.length,
    missingDeviceRolePaths,
    multipleKernelsShareDeviceTranslationUnit,
    rejectedClaims,
    reasonCodes: compactStrings([
      missingDeviceRolePaths.length ? 'generated_split.device_role_source_missing' : null,
      'generated_split.smallest_safe_fission_not_proven_without_verifier',
      'generated_split.per_kernel_hmr_not_proven_without_verifier',
      multipleKernelsShareDeviceTranslationUnit
        ? 'generated_split.single_translation_unit_contains_multiple_kernels'
        : null,
    ]),
  };
}

function artifactSourcePaths(artifact) {
  const value = asObject(artifact);
  return normalizePathList([
    value.sourcePath,
    value.source_path,
    ...(Array.isArray(value.sourcePaths) ? value.sourcePaths : []),
    ...(Array.isArray(value.source_paths) ? value.source_paths : []),
    ...(Array.isArray(value.changedSources) ? value.changedSources : []),
    ...(Array.isArray(value.changed_sources) ? value.changed_sources : []),
  ]);
}

function artifactIds(artifact) {
  const value = asObject(artifact);
  return compactStrings([
    value.artifactId,
    value.artifact_id,
    value.selectedArtifactId,
    value.selected_artifact_id,
    value.contentAddressedId,
    value.content_addressed_id,
    ...(Array.isArray(value.artifactIds) ? value.artifactIds : []),
    ...(Array.isArray(value.artifact_ids) ? value.artifact_ids : []),
    ...(Array.isArray(value.selectedArtifactIds) ? value.selectedArtifactIds : []),
    ...(Array.isArray(value.selected_artifact_ids) ? value.selected_artifact_ids : []),
  ]);
}

function artifactProofIds(artifact) {
  const value = asObject(artifact);
  return compactStrings([
    value.proofId,
    value.proof_id,
    value.runtimeProofId,
    value.runtime_proof_id,
    value.ledgerProofId,
    value.ledger_proof_id,
    value.loaderProofId,
    value.loader_proof_id,
    ...(Array.isArray(value.proofIds) ? value.proofIds : []),
    ...(Array.isArray(value.proof_ids) ? value.proof_ids : []),
    ...(Array.isArray(value.runtimeProofIds) ? value.runtimeProofIds : []),
    ...(Array.isArray(value.runtime_proof_ids) ? value.runtime_proof_ids : []),
    ...(Array.isArray(value.ledgerProofIds) ? value.ledgerProofIds : []),
    ...(Array.isArray(value.ledger_proof_ids) ? value.ledger_proof_ids : []),
  ]);
}

function artifactContentHashes(artifact) {
  const value = asObject(artifact);
  return compactStrings([
    value.contentHash,
    value.content_hash,
    value.artifactHash,
    value.artifact_hash,
    ...(Array.isArray(value.contentHashes) ? value.contentHashes : []),
    ...(Array.isArray(value.content_hashes) ? value.content_hashes : []),
    ...(Array.isArray(value.artifactHashes) ? value.artifactHashes : []),
    ...(Array.isArray(value.artifact_hashes) ? value.artifact_hashes : []),
  ]);
}

function nonEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function outputOracleContractAccepted(contract) {
  const value = asObject(contract);
  return nonEmptyObject(value)
    && Boolean(firstText(
      value.oracleId,
      value.oracle_id,
      value.id,
      value.kind,
      value.target,
      value.outputBuffer,
      value.output_buffer,
      value.visualRegion,
      value.visual_region,
    ));
}

function abiClassAccepted(value) {
  const normalized = String(value?.value ?? value ?? '').trim().toLowerCase();
  return normalized === 'compatible' || normalized === 'additive';
}

function unaffectedRoleHashesAccepted(rolePaths, selectedPath, before = {}, after = {}) {
  const beforeMap = new Map(Object.entries(asObject(before)).map(([key, value]) => [cleanRel(key), String(value ?? '')]));
  const afterMap = new Map(Object.entries(asObject(after)).map(([key, value]) => [cleanRel(key), String(value ?? '')]));
  const unselected = rolePaths.filter((rolePath) => rolePath !== selectedPath);
  const missing = [];
  for (const rolePath of unselected) {
    const beforeHash = beforeMap.get(rolePath);
    const afterHash = afterMap.get(rolePath);
    if (!beforeHash || !afterHash || beforeHash !== afterHash) missing.push(rolePath);
  }
  return {
    accepted: missing.length === 0,
    missingOrChangedPaths: missing,
    unchangedPaths: unselected.filter((rolePath) => !missing.includes(rolePath)),
  };
}

function categoryCoverage(category, materialAccepted, typedGate) {
  const accepted = materialAccepted === true && typedGate?.accepted === true;
  return {
    category,
    accepted,
    materialAccepted: materialAccepted === true,
    evidenceGate: typedGate?.accepted === true ? 'passed' : typedGate?.failureCode,
    evidenceObserved: typedGate?.accepted === true,
    evidenceSchemaVersion: typedGate?.accepted === true ? typedGate.schemaVersion : null,
    evidenceTypes: typedGate?.accepted === true ? typedGate.evidenceTypes : [],
    contentAddresses: typedGate?.accepted === true ? typedGate.contentAddresses : [],
    evidenceIds: accepted ? typedGate.evidenceIds : [],
  };
}

function coverageComplete(categories) {
  const missingCategories = categories
    .filter((category) => category.accepted !== true || category.evidenceIds.length === 0)
    .map((category) => category.category);
  const missingGates = compactStrings(categories
    .filter((category) => category.accepted !== true)
    .map((category) => category.evidenceGate === 'passed'
      ? `generated_split.${category.category}_material_not_accepted`
      : category.evidenceGate));
  return {
    requiredCategories: REQUIRED_FISSION_VERIFICATION_CATEGORIES,
    missingCategories,
    missingGates,
    categories: categories.map((category) => ({
      category: category.category,
      materialAccepted: category.materialAccepted,
      evidenceGate: category.evidenceGate,
      evidenceObserved: category.evidenceObserved,
      evidenceSchemaVersion: category.evidenceSchemaVersion,
      evidenceTypes: category.evidenceTypes,
      contentAddresses: category.contentAddresses,
      evidenceIds: category.evidenceIds,
    })),
  };
}

export function verifyGeneratedGpuSplitDeterministicFission({
  assessment,
  manifest,
  files,
  vendor,
  selectedPath,
  changedPaths,
  selectedArtifact,
  verificationEvidence = [],
  deterministicFissionEvidence = [],
  fissionEvidence = [],
  proofArtifacts = [],
  outputOracleContract,
  abiCompatibilityClass = 'compatible',
  fullDeviceFallback = false,
  hostRelinked = false,
  fullRebuildUsed = false,
  processRestarted = false,
  unaffectedArtifactHashesBefore = {},
  unaffectedArtifactHashesAfter = {},
  includedDependencies = [],
  excludedHostSources = [],
  compilerArgsHash = null,
  compileTarget = null,
} = {}) {
  const baseAssessment = assessment ?? assessGeneratedGpuSplitGranularity({ manifest, files, vendor });
  const roleReports = compactObjects(baseAssessment.roleReports);
  const rolePaths = normalizePathList(baseAssessment.deviceRolePaths);
  const normalizedSelectedPath = cleanRel(
    selectedPath
    ?? (normalizePathList(changedPaths).length === 1 ? normalizePathList(changedPaths)[0] : null)
    ?? (rolePaths.length === 1 ? rolePaths[0] : null),
  );
  const selectedRole = roleReports.find((role) => cleanRel(role.path) === normalizedSelectedPath) ?? null;
  const selectedManifestRole = compactObjects(baseAssessment.deviceRoles)
    .find((role) => cleanRel(role.path) === normalizedSelectedPath) ?? {};
  const selectedKernel = selectedRole?.kernelCount === 1 ? selectedRole.kernelSymbols[0] : null;
  const selectedIslandId = selectedKernel
    ? `kernel:${selectedKernel}:${sha256Hex(normalizedSelectedPath).slice(0, 16)}`
    : `device-role:${sha256Hex(normalizedSelectedPath).slice(0, 16)}`;
  const normalizedChangedPaths = normalizePathList(changedPaths);
  const changedScopeAccepted =
    normalizedChangedPaths.length > 0
    && normalizedChangedPaths.every((changedPath) => changedPath === normalizedSelectedPath);
  const artifactSources = artifactSourcePaths(selectedArtifact);
  const boundArtifactIds = artifactIds(selectedArtifact);
  const boundArtifactProofIds = artifactProofIds(selectedArtifact);
  const boundArtifactHashes = artifactContentHashes(selectedArtifact);
  const contentAddressedBoundArtifactIds = boundArtifactIds.filter(isContentAddressedId);
  const contentAddressedBoundArtifactProofIds = boundArtifactProofIds.filter(isContentAddressedId);
  const contentAddressedBoundArtifactHashes = boundArtifactHashes.filter(isContentAddressedId);
  const artifactBindingAccepted =
    artifactSources.includes(normalizedSelectedPath)
    && (
      contentAddressedBoundArtifactIds.length > 0
      || contentAddressedBoundArtifactHashes.length > 0
      || contentAddressedBoundArtifactProofIds.length > 0
    );
  const fissionEvidenceRecords = collectFissionEvidenceRecords(
    verificationEvidence,
    deterministicFissionEvidence,
    fissionEvidence,
    proofArtifacts,
    selectedArtifact,
    outputOracleContract,
  );
  const typedEvidenceGates = new Map(REQUIRED_FISSION_VERIFICATION_CATEGORIES.map((category) => [
    category,
    typedEvidenceGate(category, fissionEvidenceRecords, {
      selectedPath: normalizedSelectedPath,
      selectedIslandId,
      selectedKernel,
    }),
  ]));
  const typedGate = (category) => typedEvidenceGates.get(category);
  const unaffected = unaffectedRoleHashesAccepted(
    rolePaths,
    normalizedSelectedPath,
    unaffectedArtifactHashesBefore,
    unaffectedArtifactHashesAfter,
  );
  const outputOracleAccepted = outputOracleContractAccepted(outputOracleContract);
  const abiAccepted = abiClassAccepted(abiCompatibilityClass);
  const compileRecipeAccepted = Boolean(Boolean(firstText(
    selectedManifestRole.compiler,
    baseAssessment.deviceRoles?.[0]?.compiler,
  )) && (
    compactStrings(selectedManifestRole.arch).length > 0
    || firstText(compileTarget)
    || firstText(compilerArgsHash)
  ));
  const includeClosureObserved =
    Array.isArray(includedDependencies)
    || Array.isArray(selectedManifestRole.sourceFiles)
    || Array.isArray(selectedManifestRole.source_files);
  const selectedKernelOwnedOnlyBySelectedRole =
    Boolean(selectedKernel)
    && roleReports
      .filter((role) => cleanRel(role.path) !== normalizedSelectedPath)
      .every((role) => !role.kernelSymbols.includes(selectedKernel));
  const loaderFirewallAccepted =
    fullDeviceFallback === false
    && hostRelinked === false
    && fullRebuildUsed === false
    && processRestarted === false;

  const categories = [
    categoryCoverage('selected_island_binding', Boolean(selectedRole) && selectedKernel !== null, typedGate('selected_island_binding')),
    categoryCoverage('source_mapping', Boolean(selectedRole), typedGate('source_mapping')),
    categoryCoverage('include_closure', includeClosureObserved, typedGate('include_closure')),
    categoryCoverage('symbol_ownership', selectedKernelOwnedOnlyBySelectedRole, typedGate('symbol_ownership')),
    categoryCoverage('dependency_closure', changedScopeAccepted && unaffected.accepted, typedGate('dependency_closure')),
    categoryCoverage('abi_membrane', abiAccepted, typedGate('abi_membrane')),
    categoryCoverage('compile_recipe', compileRecipeAccepted, typedGate('compile_recipe')),
    categoryCoverage('loader_capability', loaderFirewallAccepted && artifactBindingAccepted, typedGate('loader_capability')),
    categoryCoverage('output_oracle', outputOracleAccepted, typedGate('output_oracle')),
  ];
  const verificationEvidenceCoverage = coverageComplete(categories);
  const accepted = verificationEvidenceCoverage.missingCategories.length === 0
    && selectedRole?.present === true
    && selectedKernel !== null
    && baseAssessment.missingDeviceRolePaths.length === 0;
  const verifierEvidenceId = verifierReportEvidenceId({
    selectedIslandId,
    accepted,
    verificationEvidenceCoverage,
  });
  const deterministicVerifierEvidenceIds = compactStrings(categories.flatMap((category) => category.evidenceIds));
  const selectedIslandContract = {
    islandId: selectedIslandId,
    island_id: selectedIslandId,
    islandKind: 'generated_device_kernel',
    island_kind: 'generated_device_kernel',
    sourcePaths: [normalizedSelectedPath],
    source_paths: [normalizedSelectedPath],
    includeClosure: includedDependencies,
    include_closure: includedDependencies,
    excludedHostSources: normalizePathList(excludedHostSources),
    excluded_host_sources: normalizePathList(excludedHostSources),
    targetSymbols: selectedKernel ? [selectedKernel] : [],
    target_symbols: selectedKernel ? [selectedKernel] : [],
    artifactIds: contentAddressedBoundArtifactIds,
    artifact_ids: contentAddressedBoundArtifactIds,
    artifactProofIds: contentAddressedBoundArtifactProofIds,
    artifact_proof_ids: contentAddressedBoundArtifactProofIds,
    artifactContentHashes: contentAddressedBoundArtifactHashes,
    artifact_content_hashes: contentAddressedBoundArtifactHashes,
    outputOracleContract: outputOracleContract ?? {},
    output_oracle_contract: outputOracleContract ?? {},
    verificationEvidenceCoverage,
    verification_evidence_coverage: verificationEvidenceCoverage,
    verifierEvidenceId,
    verifier_evidence_id: verifierEvidenceId,
    deterministicVerifierEvidenceIds,
    deterministic_verifier_evidence_ids: deterministicVerifierEvidenceIds,
    selectionDecisionHash: `sha256:${sha256Hex(stableJson({
      selectedIslandId,
      normalizedSelectedPath,
      selectedKernel,
      outputOracleContract,
      deterministicVerifierEvidenceIds,
    }))}`,
    selection_decision_hash: `sha256:${sha256Hex(stableJson({
      selectedIslandId,
      normalizedSelectedPath,
      selectedKernel,
      outputOracleContract,
      deterministicVerifierEvidenceIds,
    }))}`,
    narrowerCandidateRejections: [{
      candidate: 'sub_kernel_region',
      reason: selectedKernel
        ? 'single_kernel_is_minimum_generated_device_symbol_boundary'
        : 'selected_device_role_has_no_single_kernel_boundary',
    }],
    narrower_candidate_rejections: [{
      candidate: 'sub_kernel_region',
      reason: selectedKernel
        ? 'single_kernel_is_minimum_generated_device_symbol_boundary'
        : 'selected_device_role_has_no_single_kernel_boundary',
    }],
  };
  const reasonCodes = compactStrings([
    ...compactStrings(baseAssessment.reasonCodes),
    ...verificationEvidenceCoverage.missingGates,
    accepted ? null : 'generated_split.deterministic_fission_verifier_rejected',
    selectedRole ? null : 'generated_split.selected_device_role_missing',
    selectedRole?.present === true ? null : 'generated_split.selected_device_role_source_missing',
    selectedKernel ? null : 'generated_split.selected_role_not_single_kernel',
    changedScopeAccepted ? null : 'generated_split.changed_paths_not_confined_to_selected_role',
    unaffected.accepted ? null : 'generated_split.unaffected_device_role_hashes_not_proven',
    artifactBindingAccepted ? null : 'generated_split.selected_artifact_binding_not_proven',
    outputOracleAccepted ? null : 'generated_split.output_oracle_contract_missing',
    abiAccepted ? null : 'generated_split.abi_class_not_accepted',
    compileRecipeAccepted ? null : 'generated_split.compile_recipe_not_proven',
    loaderFirewallAccepted ? null : 'generated_split.loader_firewall_not_proven',
    selectedKernelOwnedOnlyBySelectedRole ? null : 'generated_split.kernel_symbol_ownership_not_proven',
  ]);
  const fissionProof = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    required: true,
    observed: true,
    evidenceObserved: true,
    verifierEvidenceObserved: true,
    deterministicVerifierEvidenceObserved: deterministicVerifierEvidenceIds.length > 0,
    selectedIslandObserved: true,
    selectedIslandContractObserved: true,
    selectedIslandContractCoverageObserved: true,
    selectedIslandContractCoverageComplete: accepted,
    fissionProven: accepted,
    resultState: accepted ? 'gpu-hmr-fission-candidate-proven' : null,
    degradedState: accepted ? null : 'gpu-hmr-fission-unverified',
    degradedReason: accepted ? null : 'generated_split_deterministic_fission_rejected',
    evidenceRefs: [verifierEvidenceId],
    verifierEvidenceRefs: [verifierEvidenceId],
    deterministicVerifierEvidenceRefs: deterministicVerifierEvidenceIds,
    selectedIslandIds: [selectedIslandId],
    selectedIslandContracts: [selectedIslandContract],
    excludedHostSources: normalizePathList(excludedHostSources),
    excluded_host_sources: normalizePathList(excludedHostSources),
    stageStatuses: [accepted ? 'passed' : 'rejected'],
    selectionDecisionHash: selectedIslandContract.selectionDecisionHash,
  };
  const rejectedClaims = accepted
    ? compactStrings(baseAssessment.rejectedClaims).filter((claim) =>
        claim !== 'per_kernel_hmr' && claim !== 'smallest_safe_fission_island'
      )
    : compactStrings(baseAssessment.rejectedClaims);
  return {
    ...baseAssessment,
    proofBoundary: accepted ? 'deterministic_fission_verifier' : baseAssessment.proofBoundary,
    acceptedClaim: accepted ? 'per_kernel_hmr' : baseAssessment.acceptedClaim,
    hmrReloadScope: accepted ? 'per_kernel' : baseAssessment.hmrReloadScope,
    fissionGranularity: accepted ? 'per_kernel' : baseAssessment.fissionGranularity,
    smallestSafeFissionIslandProven: accepted,
    perKernelHmrProven: accepted,
    requiresDeterministicFissionVerifierForSmallestSafeIsland: !accepted,
    requiresDeterministicFissionVerifierForPerKernelHmr: !accepted,
    rejectedClaims,
    reasonCodes,
    deterministicFissionVerifier: {
      schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_SCHEMA_VERSION,
      accepted,
      verifierEvidenceId,
      selectedIslandId,
      selectedPath: normalizedSelectedPath,
      selectedKernel,
      verificationEvidenceCoverage,
      failures: verificationEvidenceCoverage.missingCategories,
      failureGates: verificationEvidenceCoverage.missingGates,
    },
    fissionProof,
    selectedIslandContract,
  };
}

function deterministicFissionVerifierAccepted(report) {
  const verifier = asObject(report.deterministicFissionVerifier);
  const proof = asObject(report.fissionProof);
  const selectedContracts = compactObjects(proof.selectedIslandContracts);
  const contract = selectedContracts[0] ?? {};
  const verifierEvidenceId = firstText(verifier.verifierEvidenceId, verifier.verifier_evidence_id);
  const selectedIslandId = firstText(verifier.selectedIslandId, verifier.selected_island_id);
  const contractIslandId = firstText(contract.islandId, contract.island_id);
  const contractVerifierEvidenceId = firstText(
    contract.verifierEvidenceId,
    contract.verifier_evidence_id,
  );
  const proofEvidenceRefs = compactStrings(proof.evidenceRefs);
  const proofVerifierEvidenceRefs = compactStrings(proof.verifierEvidenceRefs);
  const proofDeterministicVerifierEvidenceRefs = compactStrings(
    proof.deterministicVerifierEvidenceRefs,
  );
  const proofSelectedIslandIds = compactStrings(proof.selectedIslandIds);
  const contractDeterministicVerifierEvidenceIds = compactStrings(
    contract.deterministicVerifierEvidenceIds,
  );
  const stageStatuses = compactStrings(proof.stageStatuses)
    .map((status) => status.toLowerCase());
  const coverage = asObject(contract.verificationEvidenceCoverage);
  const missingCategories = compactStrings(coverage.missingCategories);
  const requiredCategories = compactStrings(coverage.requiredCategories);
  const categories = compactObjects(coverage.categories);
  const categoryNames = compactStrings(categories.map((category) => category.category));
  const categoryRecordComplete = (category) => {
    const item = categories.find((candidate) => candidate.category === category);
    if (!item) return false;
    const evidenceIds = compactStrings(item.evidenceIds);
    const contentAddresses = compactStrings(item.contentAddresses);
    return evidenceIds.length > 0
      && evidenceIds.every(isContentAddressedEvidenceRef)
      && item.evidenceGate === 'passed'
      && item.evidenceObserved === true
      && item.evidenceSchemaVersion
        === GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION
      && compactStrings(item.evidenceTypes).length > 0
      && contentAddresses.length > 0
      && contentAddresses.every(isContentAddressedId);
  };
  const categoryEvidenceComplete = REQUIRED_FISSION_VERIFICATION_CATEGORIES.every((category) =>
    categoryNames.includes(category) && categoryRecordComplete(category)
  );
  const categoryEvidenceIds = categories.flatMap((category) => compactStrings(category.evidenceIds));
  const passedStatusObserved = stageStatuses.some((status) =>
    ['passed', 'pass', 'accepted'].includes(status)
  );
  const rejectedStatusObserved = stageStatuses.some((status) =>
    ['blocked', 'failed', 'fail', 'reject', 'rejected'].includes(status)
  );
  return verifier.accepted === true
    && verifier.schemaVersion === GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_SCHEMA_VERSION
    && verifierEvidenceId !== null
    && isContentAddressedEvidenceRef(verifierEvidenceId)
    && selectedIslandId !== null
    && proof.fissionProven === true
    && proof.observed === true
    && proof.evidenceObserved === true
    && proof.verifierEvidenceObserved === true
    && proof.deterministicVerifierEvidenceObserved === true
    && proof.selectedIslandObserved === true
    && proof.selectedIslandContractObserved === true
    && proof.selectedIslandContractCoverageComplete === true
    && passedStatusObserved
    && !rejectedStatusObserved
    && selectedContracts.length === 1
    && contractIslandId === selectedIslandId
    && contractVerifierEvidenceId === verifierEvidenceId
    && proofEvidenceRefs.includes(verifierEvidenceId)
    && proofVerifierEvidenceRefs.includes(verifierEvidenceId)
    && proofSelectedIslandIds.includes(selectedIslandId)
    && missingCategories.length === 0
    && REQUIRED_FISSION_VERIFICATION_CATEGORIES.every((category) => requiredCategories.includes(category))
    && categoryEvidenceComplete
    && categoryEvidenceIds.every(isContentAddressedEvidenceRef)
    && categoryEvidenceIds.every((id) => proofDeterministicVerifierEvidenceRefs.includes(id))
    && categoryEvidenceIds.every((id) => contractDeterministicVerifierEvidenceIds.includes(id));
}

export function assertNoGeneratedSplitFissionOverclaim(assessment) {
  const report = asObject(assessment);
  const deterministicVerifier =
    report.proofBoundary === 'deterministic_fission_verifier'
    && deterministicFissionVerifierAccepted(report);
  if (
    report.smallestSafeFissionIslandProven === true
    && !deterministicVerifier
  ) {
    throw new Error(
      'generated split cannot claim smallest-safe fission without deterministic verifier proof',
    );
  }
  if (report.perKernelHmrProven === true && !deterministicVerifier) {
    throw new Error(
      'generated split cannot claim per-kernel HMR without deterministic verifier proof',
    );
  }
  if (
    report.acceptedClaim === 'per_kernel_hmr'
    && !deterministicVerifier
  ) {
    throw new Error('generated split cannot accept per-kernel HMR without deterministic verifier proof');
  }
}
