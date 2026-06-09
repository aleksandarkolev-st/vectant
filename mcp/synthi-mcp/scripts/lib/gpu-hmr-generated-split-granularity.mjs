import { createHash } from 'node:crypto';

export const GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.generated_split_granularity.v1';
export const GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_SCHEMA_VERSION =
  'synthi.gpu_hmr.generated_split_deterministic_fission.v1';

const REQUIRED_FISSION_VERIFICATION_CATEGORIES = [
  'source_mapping',
  'include_closure',
  'symbol_ownership',
  'dependency_closure',
  'abi_membrane',
  'compile_recipe',
  'loader_capability',
  'output_oracle',
];

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

function evidenceId(category, value) {
  return `evidence:generated-fission:${category}:sha256:${sha256Hex(stableJson(value))}`;
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

function artifactLoaderProofAccepted(artifact) {
  const value = asObject(artifact);
  const ledger = asObject(value.proofLedgerValidation ?? value.proof_ledger_validation);
  const runtimeArtifact = asObject(
    value.runtimeProofArtifactValidation ?? value.runtime_proof_artifact_validation,
  );
  return value.loaderProofAccepted === true
    || value.loader_proof_accepted === true
    || value.runtimeProofAccepted === true
    || value.runtime_proof_accepted === true
    || value.gpuHmrSuccess === true
    || value.gpu_hmr_success === true
    || value.ledgerGpuHmrSuccess === true
    || value.ledger_gpu_hmr_success === true
    || ledger.gpuHmrSuccess === true
    || ledger.gpu_hmr_success === true
    || runtimeArtifact.accepted === true;
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

function categoryCoverage(category, accepted, evidenceValue) {
  const ids = accepted ? [evidenceId(category, evidenceValue)] : [];
  return { category, accepted, evidenceIds: ids };
}

function coverageComplete(categories) {
  const missingCategories = categories
    .filter((category) => category.accepted !== true || category.evidenceIds.length === 0)
    .map((category) => category.category);
  return {
    requiredCategories: REQUIRED_FISSION_VERIFICATION_CATEGORIES,
    missingCategories,
    categories: categories.map((category) => ({
      category: category.category,
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
  const normalizedChangedPaths = normalizePathList(changedPaths);
  const changedScopeAccepted =
    normalizedChangedPaths.length > 0
    && normalizedChangedPaths.every((changedPath) => changedPath === normalizedSelectedPath);
  const artifactSources = artifactSourcePaths(selectedArtifact);
  const boundArtifactIds = artifactIds(selectedArtifact);
  const boundArtifactProofIds = artifactProofIds(selectedArtifact);
  const boundArtifactHashes = artifactContentHashes(selectedArtifact);
  const artifactBindingAccepted =
    artifactSources.includes(normalizedSelectedPath)
    && (boundArtifactIds.length > 0 || boundArtifactHashes.length > 0 || boundArtifactProofIds.length > 0)
    && artifactLoaderProofAccepted(selectedArtifact);
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
    categoryCoverage('source_mapping', Boolean(selectedRole), {
      selectedPath: normalizedSelectedPath,
      roleIds: selectedRole?.roleIds ?? [],
    }),
    categoryCoverage('include_closure', includeClosureObserved, {
      selectedPath: normalizedSelectedPath,
      sourceFiles: selectedManifestRole.sourceFiles ?? selectedManifestRole.source_files ?? [],
      includedDependencies,
    }),
    categoryCoverage('symbol_ownership', selectedKernelOwnedOnlyBySelectedRole, {
      selectedPath: normalizedSelectedPath,
      selectedKernel,
      allRoleKernels: roleReports.map((role) => ({
        path: role.path,
        kernelSymbols: role.kernelSymbols,
      })),
    }),
    categoryCoverage('dependency_closure', changedScopeAccepted && unaffected.accepted, {
      changedPaths: normalizedChangedPaths,
      selectedPath: normalizedSelectedPath,
      unaffected,
    }),
    categoryCoverage('abi_membrane', abiAccepted, {
      abiCompatibilityClass,
      selectedKernel,
    }),
    categoryCoverage('compile_recipe', compileRecipeAccepted, {
      compiler: selectedManifestRole.compiler,
      arch: selectedManifestRole.arch,
      compileTarget,
      compilerArgsHash,
    }),
    categoryCoverage('loader_capability', loaderFirewallAccepted && artifactBindingAccepted, {
      artifactSources,
      boundArtifactIds,
      boundArtifactProofIds,
      boundArtifactHashes,
      fullDeviceFallback,
      hostRelinked,
      fullRebuildUsed,
      processRestarted,
    }),
    categoryCoverage('output_oracle', outputOracleAccepted, outputOracleContract),
  ];
  const verificationEvidenceCoverage = coverageComplete(categories);
  const accepted = verificationEvidenceCoverage.missingCategories.length === 0
    && selectedRole?.present === true
    && selectedKernel !== null
    && baseAssessment.missingDeviceRolePaths.length === 0;
  const selectedIslandId = selectedKernel
    ? `kernel:${selectedKernel}:${sha256Hex(normalizedSelectedPath).slice(0, 16)}`
    : `device-role:${sha256Hex(normalizedSelectedPath).slice(0, 16)}`;
  const verifierEvidenceId = verifierReportEvidenceId({
    selectedIslandId,
    accepted,
    verificationEvidenceCoverage,
  });
  const deterministicVerifierEvidenceIds = categories.flatMap((category) => category.evidenceIds);
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
    artifactIds: boundArtifactIds,
    artifact_ids: boundArtifactIds,
    artifactProofIds: boundArtifactProofIds,
    artifact_proof_ids: boundArtifactProofIds,
    artifactContentHashes: boundArtifactHashes,
    artifact_content_hashes: boundArtifactHashes,
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
  const categoryEvidenceComplete = REQUIRED_FISSION_VERIFICATION_CATEGORIES.every((category) =>
    categoryNames.includes(category)
    && compactStrings(categories.find((item) => item.category === category)?.evidenceIds).length > 0
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
