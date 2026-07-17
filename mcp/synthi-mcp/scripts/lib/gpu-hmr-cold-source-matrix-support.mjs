import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  defaultCasRootFromEnv,
  validateArtifactCasManifest,
} from './gpu-hmr-artifact-cas.mjs';

export const GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_source_split_compile_support.v1';
export const GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_AUTHORITY =
  'matrix_recomputed_cold_source_split_compile_support_only_not_gpu_hmr_success';

const AGENT_SPLIT_RUN_MODE_SCHEMA_VERSION =
  'synthi.gpu.hmr.agent_split_run_mode_proof.v1';
const COLD_COMPUTE_PROOF_AUTHORITY =
  'cold_ai_split_source_provenance_only_not_gpu_hmr_acceptance';
const SOURCE_FIRST_SCHEMA_VERSION =
  'synthi.gpu.hmr.agent_split_source_first_ingestion.v1';
const SOURCE_FIRST_AUTHORITY =
  'source_first_ingestion_provenance_only_not_runtime_proof';
const SOURCE_FIRST_REQUEST_INTENT_SCHEMA_VERSION =
  'synthi.gpu_hmr.source_first_request_intent.v1';
const SOURCE_FIRST_REQUEST_INTENT_AUTHORITY =
  'source_manifest_bound_request_hints_only_not_gpu_hmr_success';
const SOURCE_FIRST_COMPILE_REQUEST_SCHEMA_VERSION =
  'synthi.gpu_hmr.source_first_compile_cache_request_support.v1';
const SOURCE_FIRST_COMPILE_REQUEST_AUTHORITY =
  'initial_compile_cache_request_support_only_not_fresh_compile_or_gpu_hmr_success';
const COLD_SOURCE_PROFILE_IDENTITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_source_profile_request_identity.v1';
const COLD_SOURCE_PROFILE_IDENTITY_AUTHORITY =
  'profile_request_identity_binding_only_not_gpu_hmr_success';
const COLD_SOURCE_MODALITY_BINDING_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_source_modality_binding.v1';
const COLD_SOURCE_MODALITY_BINDING_AUTHORITY =
  'content_bound_output_oracle_request_only_not_gpu_hmr_success';
const COLD_SOURCE_DERIVATION_CHAIN_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_source_derivation_chain.v1';
const COLD_SOURCE_DERIVATION_CHAIN_AUTHORITY =
  'canonical_cold_source_derivation_chain_only_not_gpu_hmr_success';
const COLD_COMPILED_ARTIFACT_CAS_BINDING_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_compiled_device_artifact_cas_binding.v1';
const COLD_COMPILED_ARTIFACT_CAS_BINDING_AUTHORITY =
  'compiled_device_artifact_cas_binding_only_not_gpu_hmr_success';
const COLD_COMPILED_ARTIFACT_CAS_ROLE = 'compiled_device_artifact';
const COLD_COMPILED_ARTIFACT_CAS_MEDIA_TYPE = 'application/octet-stream';
const COLD_PROVIDER_PROTOCOL_SNAPSHOT_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_provider_protocol_snapshot.v1';
const COLD_PROVIDER_PROTOCOL_SNAPSHOT_AUTHORITY =
  'canonical_provider_protocol_snapshot_only_not_gpu_hmr_success';
const COLD_PROVIDER_PROTOCOL_MATERIAL_SCHEMA_VERSION =
  'synthi.ai.provider_call_protocol_material.v1';
const COLD_PROVIDER_CALL_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_ai_provider_call.v1';
const COLD_PROVIDER_CALL_AUTHORITY =
  'observed_ai_split_provider_call_only_not_gpu_hmr_success';
const COLD_DEVICE_COMPILE_SCHEMA_VERSION =
  'synthi.gpu_hmr.cold_device_compile_provenance.v1';
const COLD_DEVICE_COMPILE_AUTHORITY =
  'fresh_device_compile_provenance_only_not_gpu_hmr_runtime_acceptance';
const PROVIDER_CALL_REQUEST_SCHEMA_VERSION =
  'synthi.ai.provider_call_request.v2';
const PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION =
  'synthi.ai.provider_call_challenge.v1';
const PROVIDER_CALL_RECEIPT_SCHEMA_VERSION =
  'synthi.ai.provider_call_receipt.v1';
const PROVIDER_CALL_RECEIPT_AUTHORITY =
  'request_bound_provider_call_only_not_gpu_hmr_success';
const CAS_LOCATOR_SCHEMA_VERSION = 'synthi.cas.artifact_locator.v1';
const CAS_LOCATOR_AUTHORITY = 'transport_integrity_only';
const RUNNER_TIMING_SCHEMA_VERSION = 'synthi.gpu.hmr.runner_timing_metrics.v1';

const PROOF_AUTHORITY_BY_SCHEMA = new Map([
  [AGENT_SPLIT_RUN_MODE_SCHEMA_VERSION, COLD_COMPUTE_PROOF_AUTHORITY],
  [SOURCE_FIRST_SCHEMA_VERSION, SOURCE_FIRST_AUTHORITY],
  [SOURCE_FIRST_REQUEST_INTENT_SCHEMA_VERSION, SOURCE_FIRST_REQUEST_INTENT_AUTHORITY],
  [SOURCE_FIRST_COMPILE_REQUEST_SCHEMA_VERSION, SOURCE_FIRST_COMPILE_REQUEST_AUTHORITY],
  [COLD_SOURCE_PROFILE_IDENTITY_SCHEMA_VERSION, COLD_SOURCE_PROFILE_IDENTITY_AUTHORITY],
  [COLD_SOURCE_MODALITY_BINDING_SCHEMA_VERSION, COLD_SOURCE_MODALITY_BINDING_AUTHORITY],
  [COLD_SOURCE_DERIVATION_CHAIN_SCHEMA_VERSION, COLD_SOURCE_DERIVATION_CHAIN_AUTHORITY],
  [COLD_COMPILED_ARTIFACT_CAS_BINDING_SCHEMA_VERSION, COLD_COMPILED_ARTIFACT_CAS_BINDING_AUTHORITY],
  [COLD_PROVIDER_PROTOCOL_SNAPSHOT_SCHEMA_VERSION, COLD_PROVIDER_PROTOCOL_SNAPSHOT_AUTHORITY],
  [COLD_PROVIDER_CALL_SCHEMA_VERSION, COLD_PROVIDER_CALL_AUTHORITY],
  [COLD_DEVICE_COMPILE_SCHEMA_VERSION, COLD_DEVICE_COMPILE_AUTHORITY],
  [PROVIDER_CALL_RECEIPT_SCHEMA_VERSION, PROVIDER_CALL_RECEIPT_AUTHORITY],
  [CAS_LOCATOR_SCHEMA_VERSION, CAS_LOCATOR_AUTHORITY],
]);

const FORBIDDEN_VISUAL_KEYS = [
  'coldSingleFrameVisual',
  'cold_single_frame_visual',
  'visualArtifacts',
  'visual_artifacts',
  'visualOracleArtifacts',
  'visual_oracle_artifacts',
  'visualEvidenceArtifacts',
  'visual_evidence_artifacts',
  'visualMetrics',
  'visual_metrics',
  'visualDelta',
  'visual_delta',
  'asyncVisualProofJob',
  'async_visual_proof_job',
];

const RUNTIME_AUTHORITY_CARRIERS = [
  'proofLedger',
  'proof_ledger',
  'runtimeProofArtifact',
  'runtime_proof_artifact',
  'runtimeTrace',
  'runtime_trace',
  'runtimeResourceTrace',
  'runtime_resource_trace',
  'dispatchTrace',
  'dispatch_trace',
  'outputOracleFacet',
  'output_oracle_facet',
  'computeOracleArtifacts',
  'compute_oracle_artifacts',
];

const FALSE_AUTHORITY_KEYS = new Set([
  'acceptedforgpuhmr',
  'gpuhmrsuccess',
  'cansatisfyruntimeproof',
  'cansatisfydispatchproof',
  'cansatisfyoutputoracleproof',
]);

const FORBIDDEN_SUCCESS_KEYS = new Set([
  'fullruntimeproven',
  'strictruntimeproofaccepted',
  'dispatchproofaccepted',
  'outputoracleproofaccepted',
  'outputoracleaccepted',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function contentAddressedSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value ?? '').trim().toLowerCase());
}

function canonicalKey(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function normalizedPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '');
}

function safeRelativePath(value) {
  const normalized = normalizedPath(value);
  return Boolean(
    normalized
    && !path.posix.isAbsolute(normalized)
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !normalized.includes('/../'),
  );
}

function uniqueSortedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))].sort();
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function addGap(gaps, code) {
  if (code && !gaps.includes(code)) gaps.push(code);
}

function readAlias(object, keys, label, gaps, { required = false } = {}) {
  if (!isObject(object)) {
    if (required) addGap(gaps, `${label}_missing`);
    return undefined;
  }
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(object, key));
  if (present.length === 0) {
    if (required) addGap(gaps, `${label}_missing`);
    return undefined;
  }
  const first = object[present[0]];
  for (const key of present.slice(1)) {
    if (stableJson(object[key]) !== stableJson(first)) {
      addGap(gaps, `${label}_alias_conflict`);
    }
  }
  return first;
}

function collectAliasConflicts(value, label, gaps, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectAliasConflicts(entry, `${label}[${index}]`, gaps, seen));
    return;
  }
  const byCanonicalKey = new Map();
  for (const [key, entry] of Object.entries(value)) {
    const canonical = canonicalKey(key);
    const previous = byCanonicalKey.get(canonical);
    if (previous && stableJson(previous.value) !== stableJson(entry)) {
      addGap(gaps, `${label}_${canonical}_alias_conflict`);
    } else if (!previous) {
      byCanonicalKey.set(canonical, { key, value: entry });
    }
    collectAliasConflicts(entry, `${label}.${key}`, gaps, seen);
  }
}

function authorityClaimGaps(value, label, gaps, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => authorityClaimGaps(entry, `${label}[${index}]`, gaps, seen));
    return;
  }
  const schema = value.schemaVersion ?? value.schema_version ?? value.schema ?? null;
  for (const [key, entry] of Object.entries(value)) {
    const canonical = canonicalKey(key);
    if (FALSE_AUTHORITY_KEYS.has(canonical) && entry !== false) {
      addGap(gaps, `${label}_${canonical}_must_be_false`);
    }
    if (FORBIDDEN_SUCCESS_KEYS.has(canonical) && entry !== false && entry != null) {
      addGap(gaps, `${label}_${canonical}_forbidden`);
    }
    if (canonical === 'proofauthority') {
      const expected = PROOF_AUTHORITY_BY_SCHEMA.get(String(schema ?? ''));
      if (!expected || entry !== expected) {
        addGap(gaps, `${label}_proof_authority_invalid`);
      }
    } else if (
      canonical !== 'sourceauthority'
      && (canonical.endsWith('authority') || canonical.endsWith('authorities'))
    ) {
      addGap(gaps, `${label}_${canonical}_forbidden`);
    }
    authorityClaimGaps(entry, `${label}.${key}`, gaps, seen);
  }
}

function supportFlags(value, label, gaps, {
  requireAccepted = true,
  requireOutputFalse = false,
} = {}) {
  if (!isObject(value)) {
    addGap(gaps, `${label}_missing`);
    return;
  }
  if (requireAccepted && value.accepted !== true) addGap(gaps, `${label}_not_accepted`);
  for (const [camel, snake, suffix] of [
    ['acceptedForGpuHmr', 'accepted_for_gpu_hmr', 'accepted_for_gpu_hmr'],
    ['gpuHmrSuccess', 'gpu_hmr_success', 'gpu_hmr_success'],
    ['canSatisfyRuntimeProof', 'can_satisfy_runtime_proof', 'runtime_authority'],
    ['canSatisfyDispatchProof', 'can_satisfy_dispatch_proof', 'dispatch_authority'],
  ]) {
    if (readAlias(value, [camel, snake], `${label}_${suffix}`, gaps, { required: true }) !== false) {
      addGap(gaps, `${label}_${suffix}_not_false`);
    }
  }
  const outputValue = readAlias(
    value,
    ['canSatisfyOutputOracleProof', 'can_satisfy_output_oracle_proof'],
    `${label}_output_oracle_authority`,
    gaps,
    { required: requireOutputFalse },
  );
  if (outputValue !== undefined && outputValue !== false) {
    addGap(gaps, `${label}_output_oracle_authority_not_false`);
  }
}

function emptyGapArrays(value, label, gaps, fields = ['blockingGaps', 'verificationGaps', 'eligibilityGaps']) {
  for (const camel of fields) {
    const snake = camel.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
    const supplied = readAlias(value, [camel, snake], `${label}_${snake}`, gaps);
    if (supplied !== undefined && (!Array.isArray(supplied) || supplied.length !== 0)) {
      addGap(gaps, `${label}_${snake}_not_empty`);
    }
  }
}

function nonemptyCarrier(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function normalizedInitialFiles(sourceFirstFacet) {
  return (Array.isArray(sourceFirstFacet?.initialFiles) ? sourceFirstFacet.initialFiles : [])
    .map((entry) => ({
      path: normalizedPath(entry?.path),
      contentHash: String(entry?.contentHash ?? entry?.content_hash ?? '').trim().toLowerCase(),
      content_hash: String(entry?.contentHash ?? entry?.content_hash ?? '').trim().toLowerCase(),
      byteLength: Number(entry?.byteLength ?? entry?.byte_length),
      byte_length: Number(entry?.byteLength ?? entry?.byte_length),
    }))
    .filter((entry) => entry.path);
}

function requestIntentEvidence(rawSourceFirst, sourceFirstFacet, gaps) {
  const compileContract = readAlias(
    rawSourceFirst,
    ['initialCompileContract', 'initial_compile_contract'],
    'cold_support_initial_compile_contract',
    gaps,
    { required: true },
  );
  const intent = readAlias(
    compileContract,
    ['sourceFirstRequestIntent', 'source_first_request_intent'],
    'cold_support_request_intent',
    gaps,
    { required: true },
  );
  if (!isObject(intent)) return { intent: {}, intentHash: null, compileContract: {} };
  collectAliasConflicts(intent, 'cold_support_request_intent', gaps);
  authorityClaimGaps(intent, 'cold_support_request_intent', gaps);
  supportFlags(intent, 'cold_support_request_intent', gaps, { requireAccepted: false });
  const schemaVersion = readAlias(intent, ['schemaVersion', 'schema_version'], 'cold_support_request_intent_schema', gaps, { required: true });
  const proofAuthority = readAlias(intent, ['proofAuthority', 'proof_authority'], 'cold_support_request_intent_authority', gaps, { required: true });
  if (schemaVersion !== SOURCE_FIRST_REQUEST_INTENT_SCHEMA_VERSION) addGap(gaps, 'cold_support_request_intent_schema_invalid');
  if (proofAuthority !== SOURCE_FIRST_REQUEST_INTENT_AUTHORITY) addGap(gaps, 'cold_support_request_intent_authority_invalid');
  const initialFiles = normalizedInitialFiles(sourceFirstFacet);
  const initialPathSet = new Set(initialFiles.map((entry) => entry.path));
  const sourcePaths = readAlias(intent, ['sourcePaths', 'source_paths'], 'cold_support_request_source_paths', gaps, { required: true });
  const buildPaths = readAlias(intent, ['buildMetadataPaths', 'build_metadata_paths'], 'cold_support_request_build_paths', gaps, { required: true });
  const normalizedSourcePaths = (Array.isArray(sourcePaths) ? sourcePaths : []).map(normalizedPath);
  const normalizedBuildPaths = (Array.isArray(buildPaths) ? buildPaths : []).map(normalizedPath);
  const classifiedPaths = [...normalizedSourcePaths, ...normalizedBuildPaths];
  if (
    stableJson(uniqueSortedStrings(classifiedPaths))
    !== stableJson(uniqueSortedStrings([...initialPathSet]))
    || classifiedPaths.length !== new Set(classifiedPaths).size
  ) {
    addGap(gaps, 'cold_support_request_manifest_path_classification_mismatch');
  }
  const entryPath = normalizedPath(readAlias(intent, ['entryPath', 'entry_path'], 'cold_support_request_entry_path', gaps, { required: true }));
  if (!normalizedSourcePaths.includes(entryPath) || entryPath !== sourceFirstFacet.entryPath) {
    addGap(gaps, 'cold_support_request_entry_path_mismatch');
  }
  const sourceManifestHash = readAlias(intent, ['sourceManifestHash', 'source_manifest_hash'], 'cold_support_request_manifest_hash', gaps, { required: true });
  if (
    sourceManifestHash !== sourceFirstFacet.initialManifestHash
    || sourceManifestHash !== sourceFirstFacet.sourceTreeManifestHash
  ) {
    addGap(gaps, 'cold_support_request_manifest_hash_mismatch');
  }
  const buildEntries = normalizedBuildPaths
    .map((filePath) => initialFiles.find((entry) => entry.path === filePath))
    .filter(Boolean);
  const expectedBuildHash = buildEntries.length > 0 ? sha256Text(stableJson(buildEntries)) : null;
  const buildMetadataHash = readAlias(intent, ['buildMetadataHash', 'build_metadata_hash'], 'cold_support_request_build_metadata_hash', gaps);
  if (buildMetadataHash !== expectedBuildHash) addGap(gaps, 'cold_support_request_build_metadata_hash_mismatch');
  const outputOracleKind = readAlias(intent, ['outputOracleKind', 'output_oracle_kind'], 'cold_support_request_output_oracle_kind', gaps, { required: true });
  const oracleIntent = readAlias(intent, ['oracleIntent', 'oracle_intent'], 'cold_support_request_oracle_intent', gaps, { required: true });
  const isGui = readAlias(intent, ['isGui', 'is_gui'], 'cold_support_request_is_gui', gaps, { required: true });
  if (outputOracleKind !== 'compute_oracle' || oracleIntent !== 'compute_oracle' || isGui !== false) {
    addGap(gaps, 'cold_support_request_compute_modality_invalid');
  }
  const seed = {
    schemaVersion: SOURCE_FIRST_REQUEST_INTENT_SCHEMA_VERSION,
    entryPath,
    sourceManifestHash,
    sourcePaths: normalizedSourcePaths,
    buildPaths: normalizedBuildPaths,
    buildMetadataHash,
    language: readAlias(intent, ['language'], 'cold_support_request_language', gaps, { required: true }),
    sourceLanguageEvidence: readAlias(intent, ['sourceLanguageEvidence', 'source_language_evidence'], 'cold_support_request_language_evidence', gaps, { required: true }),
    languageNeutralSourcePaths: readAlias(intent, ['languageNeutralSourcePaths', 'language_neutral_source_paths'], 'cold_support_request_language_neutral_paths', gaps, { required: true }),
    oracleIntent,
    isGui,
    oracleEvidenceHashes: readAlias(intent, ['oracleEvidenceHashes', 'oracle_evidence_hashes'], 'cold_support_request_oracle_hashes', gaps, { required: true }),
    oracleEvidenceRefs: readAlias(intent, ['oracleEvidenceRefs', 'oracle_evidence_refs'], 'cold_support_request_oracle_refs', gaps, { required: true }),
  };
  const recomputedIntentHash = sha256Text(stableJson(seed));
  const suppliedIntentHash = readAlias(intent, ['intentHash', 'intent_hash'], 'cold_support_request_intent_hash', gaps, { required: true });
  if (suppliedIntentHash !== recomputedIntentHash) addGap(gaps, 'cold_support_request_intent_hash_mismatch');
  if (readAlias(intent, ['acceptedAsRequestHints', 'accepted_as_request_hints'], 'cold_support_request_hints_accepted', gaps, { required: true }) !== true) {
    addGap(gaps, 'cold_support_request_hints_not_accepted');
  }
  emptyGapArrays(intent, 'cold_support_request_intent', gaps, ['blockingGaps']);
  return { intent, intentHash: recomputedIntentHash, compileContract };
}

function profileIdentityEvidence(rawSourceFirst, sourceFirstFacet, intentHash, row, gaps) {
  const identity = readAlias(
    rawSourceFirst,
    ['profileRequestIdentity', 'profile_request_identity'],
    'cold_support_profile_request_identity',
    gaps,
    { required: true },
  );
  if (!isObject(identity)) return { identity: {}, identityHash: null };
  collectAliasConflicts(identity, 'cold_support_profile_request_identity', gaps);
  authorityClaimGaps(identity, 'cold_support_profile_request_identity', gaps);
  supportFlags(identity, 'cold_support_profile_request_identity', gaps, { requireAccepted: false });
  const evidenceRefs = uniqueSortedStrings(readAlias(identity, ['evidenceRefs', 'evidence_refs'], 'cold_support_profile_evidence_refs', gaps, { required: true }));
  const seed = {
    schemaVersion: COLD_SOURCE_PROFILE_IDENTITY_SCHEMA_VERSION,
    profileId: String(readAlias(identity, ['profileId', 'profile_id'], 'cold_support_profile_id', gaps, { required: true }) ?? '').trim(),
    profileHash: readAlias(identity, ['profileHash', 'profile_hash'], 'cold_support_profile_hash', gaps) ?? null,
    profileSource: String(readAlias(identity, ['profileSource', 'profile_source'], 'cold_support_profile_source', gaps, { required: true }) ?? '').trim(),
    profilePath: String(readAlias(identity, ['profilePath', 'profile_path'], 'cold_support_profile_path', gaps) ?? '').trim() || null,
    sourceAuthority: String(readAlias(identity, ['sourceAuthority', 'source_authority'], 'cold_support_profile_source_authority', gaps, { required: true }) ?? '').trim(),
    sourceManifestHash: readAlias(identity, ['sourceManifestHash', 'source_manifest_hash'], 'cold_support_profile_manifest_hash', gaps, { required: true }),
    sourceContentHash: readAlias(identity, ['sourceContentHash', 'source_content_hash'], 'cold_support_profile_source_hash', gaps, { required: true }),
    entryPath: normalizedPath(readAlias(identity, ['entryPath', 'entry_path'], 'cold_support_profile_entry_path', gaps, { required: true })),
    requestIntentHash: readAlias(identity, ['requestIntentHash', 'request_intent_hash'], 'cold_support_profile_intent_hash', gaps, { required: true }),
    outputOracleKind: readAlias(identity, ['outputOracleKind', 'output_oracle_kind'], 'cold_support_profile_output_kind', gaps, { required: true }),
    generatedSplitProfileId: String(readAlias(identity, ['generatedSplitProfileId', 'generated_split_profile_id'], 'cold_support_generated_profile_id', gaps, { required: true }) ?? '').trim(),
    generatedSplitTargetId: String(readAlias(identity, ['generatedSplitTargetId', 'generated_split_target_id'], 'cold_support_generated_target_id', gaps, { required: true }) ?? '').trim(),
    deterministicVisualModeHash: readAlias(identity, ['deterministicVisualModeHash', 'deterministic_visual_mode_hash'], 'cold_support_profile_deterministic_hash', gaps) ?? null,
    visualProofHash: readAlias(identity, ['visualProofHash', 'visual_proof_hash'], 'cold_support_profile_visual_proof_hash', gaps) ?? null,
    visualSceneManifestHash: readAlias(identity, ['visualSceneManifestHash', 'visual_scene_manifest_hash'], 'cold_support_profile_visual_scene_hash', gaps) ?? null,
    evidenceRefs,
  };
  if (
    seed.sourceManifestHash !== sourceFirstFacet.initialManifestHash
    || seed.sourceContentHash !== sourceFirstFacet.sourceContentHash
    || seed.entryPath !== sourceFirstFacet.entryPath
    || seed.requestIntentHash !== intentHash
    || seed.outputOracleKind !== 'compute_oracle'
    || seed.generatedSplitTargetId !== sourceFirstFacet.targetId
    || seed.generatedSplitProfileId !== String(rawSourceFirst.profileId ?? rawSourceFirst.profile_id ?? '')
  ) {
    addGap(gaps, 'cold_support_profile_request_identity_context_mismatch');
  }
  if (
    (seed.deterministicVisualModeHash !== null)
    || (seed.visualProofHash !== null)
    || (seed.visualSceneManifestHash !== null)
  ) {
    addGap(gaps, 'cold_support_compute_profile_contains_visual_identity');
  }
  const rowProfileId = String(row.validationProfileId ?? row.validation_profile_id ?? row.profileId ?? row.profile_id ?? '').trim();
  if (rowProfileId && rowProfileId !== seed.profileId) addGap(gaps, 'cold_support_row_profile_identity_mismatch');
  const recomputedIdentityHash = sha256Text(stableJson(seed));
  const suppliedIdentityHash = readAlias(identity, ['identityHash', 'identity_hash'], 'cold_support_profile_identity_hash', gaps, { required: true });
  if (suppliedIdentityHash !== recomputedIdentityHash) addGap(gaps, 'cold_support_profile_identity_hash_mismatch');
  emptyGapArrays(identity, 'cold_support_profile_identity', gaps, ['blockingGaps']);
  return { identity, identityHash: recomputedIdentityHash };
}

function initialCompileRequestEvidence(rawSourceFirst, sourceFirstFacet, intentHash, gaps) {
  const requestSupport = readAlias(
    rawSourceFirst,
    ['initialCompileCacheRequestSupport', 'initial_compile_cache_request_support'],
    'cold_support_initial_compile_request',
    gaps,
    { required: true },
  );
  if (!isObject(requestSupport)) return { requestSupport: {}, requestIdentity: null, requestBinding: {} };
  collectAliasConflicts(requestSupport, 'cold_support_initial_compile_request', gaps);
  authorityClaimGaps(requestSupport, 'cold_support_initial_compile_request', gaps);
  supportFlags(requestSupport, 'cold_support_initial_compile_request', gaps);
  const requestBinding = readAlias(requestSupport, ['requestBinding', 'request_binding'], 'cold_support_initial_compile_binding', gaps, { required: true });
  if (!isObject(requestBinding)) return { requestSupport, requestIdentity: null, requestBinding: {} };
  const expectedBinding = {
    schemaVersion: SOURCE_FIRST_COMPILE_REQUEST_SCHEMA_VERSION,
    mode: requestBinding.mode ?? null,
    freshAiSplitRequired: requestBinding.freshAiSplitRequired ?? null,
    language: requestBinding.language ?? null,
    filename: normalizedPath(requestBinding.filename),
    sourceHash: requestBinding.sourceHash ?? null,
    initialCompileManifestHash: requestBinding.initialCompileManifestHash ?? null,
    recomputedSourceManifestHash: requestBinding.recomputedSourceManifestHash ?? null,
    initialFileCount: requestBinding.initialFileCount ?? null,
    sourceFirstRequestIntentHash: requestBinding.sourceFirstRequestIntentHash ?? null,
    sourceManifestHash: requestBinding.sourceManifestHash ?? null,
    isGui: requestBinding.isGui ?? null,
    useAiSplit: requestBinding.useAiSplit ?? null,
    aiSplitCacheBypassRequestField: requestBinding.aiSplitCacheBypassRequestField ?? null,
    bypassAiSplitCacheRequested: requestBinding.bypassAiSplitCacheRequested ?? null,
    requireAiProviderCall: requestBinding.requireAiProviderCall ?? null,
    deviceCompileCacheBypassRequestField: requestBinding.deviceCompileCacheBypassRequestField ?? null,
    deviceCompileCacheBypassFieldPresent: requestBinding.deviceCompileCacheBypassFieldPresent ?? null,
    bypassDeviceCompileCacheRequested: requestBinding.bypassDeviceCompileCacheRequested ?? null,
    aiProviderCallNonce: requestBinding.aiProviderCallNonce ?? null,
    aiProvider: requestBinding.aiProvider ?? null,
    aiModel: requestBinding.aiModel ?? null,
    userRequestedAi: requestBinding.userRequestedAi ?? null,
    preferGpuPipeline: requestBinding.preferGpuPipeline ?? null,
    gpuMode: requestBinding.gpuMode ?? null,
    gpuArch: requestBinding.gpuArch ?? null,
    gpuArchSource: requestBinding.gpuArchSource ?? null,
    workspaceSlug: requestBinding.workspaceSlug ?? null,
    width: requestBinding.width ?? null,
    height: requestBinding.height ?? null,
  };
  if (stableJson(requestBinding) !== stableJson(expectedBinding)) {
    addGap(gaps, 'cold_support_initial_compile_binding_shape_invalid');
  }
  if (
    expectedBinding.schemaVersion !== SOURCE_FIRST_COMPILE_REQUEST_SCHEMA_VERSION
    || expectedBinding.mode !== 'cold-ai-split'
    || expectedBinding.freshAiSplitRequired !== true
    || expectedBinding.useAiSplit !== true
    || expectedBinding.bypassAiSplitCacheRequested !== true
    || expectedBinding.requireAiProviderCall !== true
    || expectedBinding.deviceCompileCacheBypassFieldPresent !== true
    || expectedBinding.bypassDeviceCompileCacheRequested !== true
    || expectedBinding.userRequestedAi !== true
    || expectedBinding.preferGpuPipeline !== true
    || expectedBinding.isGui !== false
    || expectedBinding.aiSplitCacheBypassRequestField !== 'bypass_ai_split_cache'
    || expectedBinding.deviceCompileCacheBypassRequestField !== 'bypass_device_compile_cache'
    || !String(expectedBinding.language ?? '').trim()
    || !String(expectedBinding.aiProvider ?? '').trim()
    || !String(expectedBinding.aiModel ?? '').trim()
  ) {
    addGap(gaps, 'cold_support_initial_compile_fresh_request_invalid');
  }
  const providerFileManifestEntries = normalizedInitialFiles(sourceFirstFacet)
    .map((entry) => [entry.path, entry.contentHash])
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const providerFileManifestHash = orderedJsonHash([
    'synthi.ai.provider_call_file_manifest.v1',
    providerFileManifestEntries,
  ]);
  if (
    expectedBinding.sourceHash !== sourceFirstFacet.sourceContentHash
    || expectedBinding.initialCompileManifestHash !== sourceFirstFacet.initialManifestHash
    || expectedBinding.recomputedSourceManifestHash !== sourceFirstFacet.initialManifestHash
    || expectedBinding.sourceManifestHash !== sourceFirstFacet.initialManifestHash
    || expectedBinding.sourceFirstRequestIntentHash !== intentHash
    || expectedBinding.filename !== sourceFirstFacet.entryPath
    || Number(expectedBinding.initialFileCount) !== normalizedInitialFiles(sourceFirstFacet).length
    || expectedBinding.gpuArch !== sourceFirstFacet.gpuArch
  ) {
    addGap(gaps, 'cold_support_initial_compile_source_binding_mismatch');
  }
  if (!/^provider-call:[a-f0-9]{32}$/.test(String(expectedBinding.aiProviderCallNonce ?? ''))) {
    addGap(gaps, 'cold_support_initial_compile_provider_nonce_invalid');
  }
  const requestIdentity = `source-first-initial-compile-request:${sha256Text(stableJson(expectedBinding))}`;
  const suppliedRequestIdentity = readAlias(requestSupport, ['requestIdentity', 'request_identity'], 'cold_support_initial_compile_request_identity', gaps, { required: true });
  if (requestIdentity !== suppliedRequestIdentity) addGap(gaps, 'cold_support_initial_compile_request_identity_mismatch');
  const resultDiagnostics = readAlias(requestSupport, ['resultDiagnostics', 'result_diagnostics'], 'cold_support_initial_compile_result_diagnostics', gaps, { required: true });
  if (!isObject(resultDiagnostics) || resultDiagnostics.accepted !== true) {
    addGap(gaps, 'cold_support_initial_compile_result_diagnostics_invalid');
  }
  const diagnosticsSeed = {
    accepted: resultDiagnostics?.accepted,
    observedBypassFields: resultDiagnostics?.observedBypassFields,
    invalidBypassPaths: resultDiagnostics?.invalidBypassPaths,
    mismatchedEchoPaths: resultDiagnostics?.mismatchedEchoPaths,
    freshnessClaimPaths: resultDiagnostics?.freshnessClaimPaths,
    authorityClaimed: resultDiagnostics?.authorityClaimed,
    blockingGaps: resultDiagnostics?.blockingGaps,
  };
  const evidenceHash = sha256Text(stableJson({
    requestIdentity,
    requestBlockingGaps: [],
    resultDiagnostics: diagnosticsSeed,
  }));
  if (readAlias(requestSupport, ['evidenceHash', 'evidence_hash'], 'cold_support_initial_compile_evidence_hash', gaps, { required: true }) !== evidenceHash) {
    addGap(gaps, 'cold_support_initial_compile_evidence_hash_mismatch');
  }
  if (
    requestSupport.accepted !== true
    || readAlias(requestSupport, ['acceptedAsRequestSupport', 'accepted_as_request_support'], 'cold_support_initial_compile_request_support', gaps, { required: true }) !== true
    || readAlias(requestSupport, ['coldProviderSplitRequired', 'cold_provider_split_required'], 'cold_support_initial_compile_provider_required', gaps, { required: true }) !== true
    || readAlias(requestSupport, ['forcedFreshDeviceCompileRequested', 'forced_fresh_device_compile_requested'], 'cold_support_initial_compile_device_freshness', gaps, { required: true }) !== true
  ) {
    addGap(gaps, 'cold_support_initial_compile_request_not_accepted');
  }
  emptyGapArrays(requestSupport, 'cold_support_initial_compile_request', gaps, ['blockingGaps']);
  return {
    requestSupport,
    requestIdentity,
    requestBinding: expectedBinding,
    providerFileManifestHash,
  };
}

function orderedJsonHash(values) {
  return sha256Text(JSON.stringify(values));
}

function providerProtocolEvidence(
  row,
  sourceFirstFacet,
  requestBinding,
  providerFileManifestHash,
  gaps,
) {
  const providerEvidence = readAlias(
    row,
    ['coldAiProviderCallEvidence', 'cold_ai_provider_call_evidence'],
    'cold_support_provider_evidence',
    gaps,
    { required: true },
  );
  if (!isObject(providerEvidence)) return { providerEvidence: {}, evidenceHash: null };
  collectAliasConflicts(providerEvidence, 'cold_support_provider_evidence', gaps);
  authorityClaimGaps(providerEvidence, 'cold_support_provider_evidence', gaps);
  supportFlags(providerEvidence, 'cold_support_provider_evidence', gaps);
  const snapshot = readAlias(providerEvidence, ['providerProtocolSnapshot', 'provider_protocol_snapshot'], 'cold_support_provider_snapshot', gaps, { required: true });
  if (!isObject(snapshot) || !isObject(snapshot.material)) {
    addGap(gaps, 'cold_support_provider_snapshot_material_missing');
    return { providerEvidence, evidenceHash: null };
  }
  const material = snapshot.material;
  const request = isObject(material.request) ? material.request : {};
  const challenge = isObject(material.challenge) ? material.challenge : {};
  const receipt = isObject(material.receipt) ? material.receipt : {};
  const expectedMaterial = {
    schemaVersion: COLD_PROVIDER_PROTOCOL_MATERIAL_SCHEMA_VERSION,
    request: {
      schemaVersion: request.schemaVersion ?? null,
      nonce: request.nonce ?? null,
      requestHash: request.requestHash ?? null,
      mode: request.mode ?? null,
      requestMode: request.requestMode ?? null,
      language: request.language ?? null,
      focus: request.focus ?? null,
      requestedProvider: request.requestedProvider ?? null,
      requestedModel: request.requestedModel ?? null,
      gpuArch: request.gpuArch ?? null,
      sourceHash: request.sourceHash ?? null,
      fileManifestHash: request.fileManifestHash ?? null,
      fileCount: request.fileCount ?? null,
      extraInstructionsHash: request.extraInstructionsHash ?? null,
    },
    challenge: {
      schemaVersion: challenge.schemaVersion ?? null,
      requestNonce: challenge.requestNonce ?? null,
      requestHash: challenge.requestHash ?? null,
      promptPayloadHash: challenge.promptPayloadHash ?? null,
      challengeHash: challenge.challengeHash ?? null,
    },
    receipt: {
      schemaVersion: receipt.schemaVersion ?? null,
      proofAuthority: receipt.proofAuthority ?? null,
      accepted: receipt.accepted ?? null,
      providerCallUsed: receipt.providerCallUsed ?? null,
      requestNonce: receipt.requestNonce ?? null,
      requestHash: receipt.requestHash ?? null,
      responseHash: receipt.responseHash ?? null,
      challengeHash: receipt.challengeHash ?? null,
      challengeEchoVerified: receipt.challengeEchoVerified ?? null,
      provider: receipt.provider ?? null,
      requestedModel: receipt.requestedModel ?? null,
      actualModel: receipt.actualModel ?? null,
      requestMode: receipt.requestMode ?? null,
      providerModelStatus: receipt.providerModelStatus ?? null,
      fallbackModel: receipt.fallbackModel ?? null,
      fallbackUsed: receipt.fallbackUsed ?? null,
      providerModelAliasResolvedTo: receipt.providerModelAliasResolvedTo ?? null,
      providerShutdownOrDeprecationDetected: receipt.providerShutdownOrDeprecationDetected ?? null,
      modelAvailabilityCheckedAt: receipt.modelAvailabilityCheckedAt ?? null,
      hardInfraFailure: receipt.hardInfraFailure ?? null,
      startedMonotonicNs: receipt.startedMonotonicNs ?? null,
      completedMonotonicNs: receipt.completedMonotonicNs ?? null,
      startedUnixNs: receipt.startedUnixNs ?? null,
      completedUnixNs: receipt.completedUnixNs ?? null,
      acceptedForGpuHmr: receipt.acceptedForGpuHmr ?? null,
      gpuHmrSuccess: receipt.gpuHmrSuccess ?? null,
      canSatisfyRuntimeProof: receipt.canSatisfyRuntimeProof ?? null,
      canSatisfyDispatchProof: receipt.canSatisfyDispatchProof ?? null,
      receiptHash: receipt.receiptHash ?? null,
      callId: receipt.callId ?? null,
    },
  };
  if (stableJson(material) !== stableJson(expectedMaterial)) addGap(gaps, 'cold_support_provider_protocol_material_shape_invalid');
  const requestHash = orderedJsonHash([
    request.schemaVersion,
    request.nonce,
    request.mode,
    request.requestMode,
    request.language,
    request.focus,
    request.requestedProvider,
    request.requestedModel,
    request.gpuArch,
    request.sourceHash,
    request.fileManifestHash,
    request.fileCount,
    request.extraInstructionsHash,
  ]);
  const challengeHash = orderedJsonHash([
    PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION,
    challenge.requestNonce,
    challenge.requestHash,
    challenge.promptPayloadHash,
  ]);
  const producerReceiptHash = orderedJsonHash([
    PROVIDER_CALL_RECEIPT_SCHEMA_VERSION,
    PROVIDER_CALL_RECEIPT_AUTHORITY,
    receipt.requestNonce,
    receipt.requestHash,
    receipt.responseHash,
    receipt.challengeHash,
    receipt.provider,
    receipt.requestedModel,
    receipt.actualModel,
    receipt.requestMode,
    receipt.providerModelStatus,
    String(receipt.fallbackModel ?? ''),
    receipt.fallbackUsed,
    String(receipt.providerModelAliasResolvedTo ?? ''),
    receipt.providerShutdownOrDeprecationDetected,
    receipt.modelAvailabilityCheckedAt,
    receipt.startedMonotonicNs,
    receipt.completedMonotonicNs,
    receipt.startedUnixNs,
    receipt.completedUnixNs,
  ]);
  const canonicalReceiptHash = orderedJsonHash([
    'synthi.ai.provider_call_receipt.canonical_acceptance_binding.v1',
    producerReceiptHash,
    receipt.accepted,
    receipt.providerCallUsed,
    receipt.challengeEchoVerified,
    receipt.hardInfraFailure,
  ]);
  if (
    request.schemaVersion !== PROVIDER_CALL_REQUEST_SCHEMA_VERSION
    || request.mode !== 'split'
    || request.requestMode !== 'split'
    || request.requestHash !== requestHash
    || request.nonce !== requestBinding.aiProviderCallNonce
    || request.language !== requestBinding.language
    || normalizedPath(request.focus) !== sourceFirstFacet.entryPath
    || String(request.requestedProvider ?? '').toLowerCase() !== String(requestBinding.aiProvider ?? '').toLowerCase()
    || request.requestedModel !== requestBinding.aiModel
    || request.gpuArch !== sourceFirstFacet.gpuArch
    || request.sourceHash !== sourceFirstFacet.sourceContentHash
    || Number(request.fileCount) !== normalizedInitialFiles(sourceFirstFacet).length
    || request.fileManifestHash !== providerFileManifestHash
    || !contentAddressedSha256(request.extraInstructionsHash)
  ) {
    addGap(gaps, 'cold_support_provider_request_binding_invalid');
  }
  if (
    challenge.schemaVersion !== PROVIDER_CALL_CHALLENGE_SCHEMA_VERSION
    || challenge.requestNonce !== request.nonce
    || challenge.requestHash !== requestHash
    || challenge.challengeHash !== challengeHash
    || !contentAddressedSha256(challenge.promptPayloadHash)
  ) {
    addGap(gaps, 'cold_support_provider_challenge_binding_invalid');
  }
  let providerIntervalValid = false;
  try {
    providerIntervalValid = BigInt(receipt.completedMonotonicNs) > BigInt(receipt.startedMonotonicNs)
      && BigInt(receipt.completedUnixNs) >= BigInt(receipt.startedUnixNs);
  } catch {
    providerIntervalValid = false;
  }
  if (
    receipt.schemaVersion !== PROVIDER_CALL_RECEIPT_SCHEMA_VERSION
    || receipt.proofAuthority !== PROVIDER_CALL_RECEIPT_AUTHORITY
    || receipt.accepted !== true
    || receipt.providerCallUsed !== true
    || receipt.requestNonce !== request.nonce
    || receipt.requestHash !== requestHash
    || receipt.challengeHash !== challengeHash
    || receipt.challengeEchoVerified !== true
    || receipt.requestedModel !== request.requestedModel
    || receipt.actualModel !== request.requestedModel
    || receipt.requestMode !== 'split'
    || receipt.providerModelStatus !== 'available'
    || receipt.fallbackModel !== null
    || receipt.fallbackUsed !== false
    || receipt.providerModelAliasResolvedTo !== null
    || receipt.providerShutdownOrDeprecationDetected !== false
    || receipt.hardInfraFailure !== false
    || receipt.receiptHash !== producerReceiptHash
    || receipt.callId !== `provider-call:${producerReceiptHash}`
    || !contentAddressedSha256(receipt.responseHash)
    || !providerIntervalValid
    || !Number.isFinite(Date.parse(String(receipt.modelAvailabilityCheckedAt ?? '')))
    || String(receipt.provider ?? '').toLowerCase() === 'deterministic_static_splitter'
  ) {
    addGap(gaps, 'cold_support_provider_receipt_invalid');
  }
  const canonicalJson = stableJson(expectedMaterial);
  const materialHash = sha256Text(canonicalJson);
  const expectedSnapshot = {
    schemaVersion: COLD_PROVIDER_PROTOCOL_SNAPSHOT_SCHEMA_VERSION,
    schema_version: COLD_PROVIDER_PROTOCOL_SNAPSHOT_SCHEMA_VERSION,
    proofAuthority: COLD_PROVIDER_PROTOCOL_SNAPSHOT_AUTHORITY,
    proof_authority: COLD_PROVIDER_PROTOCOL_SNAPSHOT_AUTHORITY,
    material: expectedMaterial,
    canonicalJson,
    canonical_json: canonicalJson,
    materialHash,
    material_hash: materialHash,
    acceptedAsCanonicalProviderProtocolSnapshot: true,
    accepted_as_canonical_provider_protocol_snapshot: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
  if (stableJson(snapshot) !== stableJson(expectedSnapshot)) addGap(gaps, 'cold_support_provider_snapshot_mismatch');
  const evidenceSeed = {
    schemaVersion: COLD_PROVIDER_CALL_SCHEMA_VERSION,
    proofAuthority: COLD_PROVIDER_CALL_AUTHORITY,
    requiredByCaller: true,
    providerCallUsed: true,
    provider: String(receipt.provider ?? '').toLowerCase(),
    requestedProvider: String(request.requestedProvider ?? '').toLowerCase(),
    requestedModel: receipt.requestedModel ?? null,
    actualModel: receipt.actualModel ?? null,
    providerModelStatus: receipt.providerModelStatus ?? null,
    fallbackModel: receipt.fallbackModel ?? null,
    fallbackUsed: receipt.fallbackUsed,
    providerModelAliasResolvedTo: receipt.providerModelAliasResolvedTo ?? null,
    providerShutdownOrDeprecationDetected: receipt.providerShutdownOrDeprecationDetected,
    hardInfraFailure: receipt.hardInfraFailure === true,
    providerCallId: receipt.callId ?? null,
    providerCallReceiptHash: canonicalReceiptHash,
    providerCallProducerReceiptHash: producerReceiptHash,
    providerCallRequestHash: requestHash,
    providerCallResponseHash: receipt.responseHash ?? null,
    providerCallChallengeHash: challengeHash,
    providerCallNonce: request.nonce ?? null,
    providerProtocolSnapshot: expectedSnapshot,
    providerProtocolMaterialHash: materialHash,
    blockingGaps: [],
  };
  const evidenceHash = sha256Text(stableJson(evidenceSeed));
  if (
    readAlias(providerEvidence, ['schemaVersion', 'schema_version'], 'cold_support_provider_schema', gaps, { required: true }) !== COLD_PROVIDER_CALL_SCHEMA_VERSION
    || readAlias(providerEvidence, ['proofAuthority', 'proof_authority'], 'cold_support_provider_authority', gaps, { required: true }) !== COLD_PROVIDER_CALL_AUTHORITY
    || readAlias(providerEvidence, ['evidenceHash', 'evidence_hash'], 'cold_support_provider_hash', gaps, { required: true }) !== evidenceHash
    || readAlias(providerEvidence, ['providerCallReceiptHash', 'provider_call_receipt_hash'], 'cold_support_provider_receipt_hash', gaps, { required: true }) !== canonicalReceiptHash
    || readAlias(providerEvidence, ['providerCallProducerReceiptHash', 'provider_call_producer_receipt_hash'], 'cold_support_provider_producer_receipt_hash', gaps, { required: true }) !== producerReceiptHash
    || readAlias(providerEvidence, ['providerCallRequestHash', 'provider_call_request_hash'], 'cold_support_provider_request_hash', gaps, { required: true }) !== requestHash
    || readAlias(providerEvidence, ['providerCallChallengeHash', 'provider_call_challenge_hash'], 'cold_support_provider_challenge_hash', gaps, { required: true }) !== challengeHash
    || readAlias(providerEvidence, ['providerProtocolMaterialHash', 'provider_protocol_material_hash'], 'cold_support_provider_material_hash', gaps, { required: true }) !== materialHash
    || readAlias(providerEvidence, ['canonicalProviderReceiptVerified', 'canonical_provider_receipt_verified'], 'cold_support_provider_canonical_receipt', gaps, { required: true }) !== true
    || readAlias(providerEvidence, ['liveObservationAccepted', 'live_observation_accepted'], 'cold_support_provider_live_observation', gaps, { required: true }) !== true
    || readAlias(providerEvidence, ['syntheticOrReplayIneligible', 'synthetic_or_replay_ineligible'], 'cold_support_provider_replay_flag', gaps, { required: true }) !== false
  ) {
    addGap(gaps, 'cold_support_provider_evidence_mismatch');
  }
  emptyGapArrays(providerEvidence, 'cold_support_provider_evidence', gaps, ['blockingGaps']);
  return {
    providerEvidence,
    evidenceHash,
    materialHash,
    requestHash,
    responseHash: receipt.responseHash ?? null,
    challengeHash,
    canonicalReceiptHash,
    producerReceiptHash,
  };
}

async function compiledArtifactEvidence(row, sourceFirstFacet, requestBinding, context, gaps) {
  const compile = readAlias(
    row,
    ['coldDeviceCompileProvenance', 'cold_device_compile_provenance'],
    'cold_support_device_compile',
    gaps,
    { required: true },
  );
  if (!isObject(compile)) return { compile: {}, evidenceHash: null };
  collectAliasConflicts(compile, 'cold_support_device_compile', gaps);
  authorityClaimGaps(compile, 'cold_support_device_compile', gaps);
  supportFlags(compile, 'cold_support_device_compile', gaps);
  const locator = readAlias(compile, ['compiledArtifactCasLocator', 'compiled_artifact_cas_locator'], 'cold_support_compiled_artifact_locator', gaps, { required: true });
  const binding = readAlias(compile, ['compiledArtifactCasBinding', 'compiled_artifact_cas_binding'], 'cold_support_compiled_artifact_binding', gaps, { required: true });
  const defaultCasRoot = defaultCasRootFromEnv();
  const allowedRoots = uniqueSortedStrings([
    context?.repoRoot ? path.resolve(context.repoRoot) : null,
    context?.baseDir ? path.resolve(context.baseDir) : null,
    defaultCasRoot ? path.resolve(defaultCasRoot) : null,
    ...(Array.isArray(context?.allowedCasRoots) ? context.allowedCasRoots.map((root) => path.resolve(root)) : []),
  ]);
  let casValidation = null;
  try {
    casValidation = await validateArtifactCasManifest(locator, {
      allowedRoots,
      artifactRoot: context?.baseDir ? path.resolve(context.baseDir) : undefined,
      requireReadableBytes: true,
    });
  } catch (error) {
    addGap(gaps, 'cold_support_compiled_artifact_cas_validation_threw');
    casValidation = { accepted: false, reasons: [String(error?.message ?? error)] };
  }
  if (casValidation?.accepted !== true) {
    addGap(gaps, 'cold_support_compiled_artifact_cas_validation_failed');
    for (const reason of casValidation?.reasons ?? []) addGap(gaps, `cold_support_cas:${reason}`);
  }
  if (!isObject(locator)) addGap(gaps, 'cold_support_compiled_artifact_locator_missing');
  if (Object.prototype.hasOwnProperty.call(locator ?? {}, 'manifest_hash')) addGap(gaps, 'cold_support_compiled_artifact_locator_snake_manifest_hash_forbidden');
  const locatorRole = locator?.role ?? null;
  const locatorMediaType = locator?.mediaType ?? null;
  const locatorKind = locator?.artifactKind ?? null;
  if (
    locator?.schemaVersion !== CAS_LOCATOR_SCHEMA_VERSION
    || locator?.proofAuthority !== CAS_LOCATOR_AUTHORITY
    || locatorRole !== COLD_COMPILED_ARTIFACT_CAS_ROLE
    || locatorMediaType !== COLD_COMPILED_ARTIFACT_CAS_MEDIA_TYPE
    || locatorKind !== COLD_COMPILED_ARTIFACT_CAS_ROLE
    || locator?.transport?.contentAddressed !== true
    || locator?.transport?.manifestOnly !== true
    || locator?.transport?.bytesEmbedded !== false
  ) {
    addGap(gaps, 'cold_support_compiled_artifact_locator_contract_invalid');
  }
  const artifactHash = readAlias(compile, ['artifactHash', 'artifact_hash'], 'cold_support_compile_artifact_hash', gaps, { required: true });
  const artifactBytes = Number(readAlias(compile, ['artifactBytes', 'artifact_bytes'], 'cold_support_compile_artifact_bytes', gaps, { required: true }));
  const declaredArtifactHash = readAlias(compile, ['declaredArtifactHash', 'declared_artifact_hash'], 'cold_support_compile_declared_hash', gaps, { required: true });
  const declaredArtifactBytes = Number(readAlias(compile, ['declaredArtifactBytes', 'declared_artifact_bytes'], 'cold_support_compile_declared_bytes', gaps, { required: true }));
  if (
    !contentAddressedSha256(artifactHash)
    || artifactHash !== declaredArtifactHash
    || artifactHash !== casValidation?.contentHash
    || artifactHash !== locator?.contentHash
    || !Number.isSafeInteger(artifactBytes)
    || artifactBytes <= 0
    || artifactBytes !== declaredArtifactBytes
    || artifactBytes !== casValidation?.byteLength
    || artifactBytes !== locator?.byteLength
  ) {
    addGap(gaps, 'cold_support_compiled_artifact_bytes_mismatch');
  }
  const localPath = locator?.storage?.localPath ? path.resolve(locator.storage.localPath) : null;
  const bindingSeed = {
    schemaVersion: COLD_COMPILED_ARTIFACT_CAS_BINDING_SCHEMA_VERSION,
    role: COLD_COMPILED_ARTIFACT_CAS_ROLE,
    mediaType: COLD_COMPILED_ARTIFACT_CAS_MEDIA_TYPE,
    contentHash: artifactHash,
    byteLength: artifactBytes,
    locatorManifestHash: locator?.manifestHash ?? null,
    recomputedLocatorManifestHash: casValidation?.manifestHash ?? null,
    storageRelativePath: locator?.storage?.relativePath ?? null,
    storageLocalPath: localPath,
    blockingGaps: [],
  };
  const bindingHash = sha256Text(stableJson(bindingSeed));
  const expectedBinding = {
    ...bindingSeed,
    schema_version: bindingSeed.schemaVersion,
    proofAuthority: COLD_COMPILED_ARTIFACT_CAS_BINDING_AUTHORITY,
    proof_authority: COLD_COMPILED_ARTIFACT_CAS_BINDING_AUTHORITY,
    bindingHash,
    binding_hash: bindingHash,
    accepted: true,
    acceptedAsTransportSupport: true,
    accepted_as_transport_support: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    blocking_gaps: [],
  };
  if (stableJson(binding) !== stableJson(expectedBinding)) addGap(gaps, 'cold_support_compiled_artifact_binding_mismatch');
  const proofArtifactPath = readAlias(compile, ['proofArtifactPath', 'proof_artifact_path'], 'cold_support_compile_proof_path', gaps, { required: true });
  const proofArtifactIdentity = readAlias(compile, ['proofArtifactIdentity', 'proof_artifact_identity'], 'cold_support_compile_proof_identity', gaps, { required: true });
  const proofArtifactId = readAlias(compile, ['proofArtifactId', 'proof_artifact_id'], 'cold_support_compile_proof_id', gaps, { required: true });
  const selectedArtifactId = readAlias(compile, ['selectedArtifactId', 'selected_artifact_id'], 'cold_support_compile_selected_artifact', gaps, { required: true });
  const artifactFilePath = normalizedPath(readAlias(compile, ['artifactFilePath', 'artifact_file_path'], 'cold_support_compile_artifact_path', gaps, { required: true }));
  const generatedSourcePath = normalizedPath(readAlias(compile, ['generatedSourcePath', 'generated_source_path'], 'cold_support_compile_generated_source_path', gaps, { required: true }));
  const generatedSourceHash = readAlias(compile, ['generatedSourceHash', 'generated_source_hash'], 'cold_support_compile_generated_source_hash', gaps, { required: true });
  const generatedSourceBytes = Number(readAlias(compile, ['generatedSourceBytes', 'generated_source_bytes'], 'cold_support_compile_generated_source_bytes', gaps, { required: true }));
  const sourceGeneratedArtifacts = (Array.isArray(sourceFirstFacet.generatedArtifacts)
    ? sourceFirstFacet.generatedArtifacts
    : [])
    .filter((entry) => normalizedPath(entry?.path) === generatedSourcePath);
  if (
    !safeRelativePath(proofArtifactPath)
    || !safeRelativePath(artifactFilePath)
    || !safeRelativePath(generatedSourcePath)
    || proofArtifactIdentity !== proofArtifactId
    || !String(selectedArtifactId ?? '').includes(String(artifactHash ?? ''))
    || sourceGeneratedArtifacts.length !== 1
    || sourceGeneratedArtifacts[0].contentHash !== generatedSourceHash
    || Number(sourceGeneratedArtifacts[0].byteLength) !== generatedSourceBytes
  ) {
    addGap(gaps, 'cold_support_compile_artifact_identity_mismatch');
  }
  const verificationGaps = readAlias(compile, ['verificationGaps', 'verification_gaps'], 'cold_support_compile_verification_gaps', gaps, { required: true });
  const eligibilityGaps = readAlias(compile, ['eligibilityGaps', 'eligibility_gaps'], 'cold_support_compile_eligibility_gaps', gaps, { required: true });
  const blockingGaps = readAlias(compile, ['blockingGaps', 'blocking_gaps'], 'cold_support_compile_blocking_gaps', gaps, { required: true });
  const proofSeed = {
    proofArtifactPath,
    proofArtifactIdentity,
    proofId: proofArtifactId,
    workspaceSlug: requestBinding.workspaceSlug ?? null,
    selectedArtifactId,
    artifactFilePath,
    artifactHash,
    artifactBytes,
    declaredArtifactHash,
    declaredArtifactBytes,
    artifactObservationKind: 'worker_live_read',
    byteObservationVerified: readAlias(compile, ['byteObservationVerified', 'byte_observation_verified'], 'cold_support_compile_byte_observation', gaps, { required: true }),
    liveObservationAccepted: readAlias(compile, ['liveObservationAccepted', 'live_observation_accepted'], 'cold_support_compile_live_observation', gaps, { required: true }),
    compiledArtifactCasLocator: locator,
    compiledArtifactCasBinding: expectedBinding,
    compiledArtifactCasBindingHash: bindingHash,
    compiledArtifactCasRole: readAlias(compile, ['compiledArtifactCasRole', 'compiled_artifact_cas_role'], 'cold_support_compile_cas_role', gaps, { required: true }),
    compiledArtifactCasMediaType: readAlias(compile, ['compiledArtifactCasMediaType', 'compiled_artifact_cas_media_type'], 'cold_support_compile_cas_media', gaps, { required: true }),
    compiledArtifactCasContentHash: readAlias(compile, ['compiledArtifactCasContentHash', 'compiled_artifact_cas_content_hash'], 'cold_support_compile_cas_hash', gaps, { required: true }),
    compiledArtifactCasByteLength: Number(readAlias(compile, ['compiledArtifactCasByteLength', 'compiled_artifact_cas_byte_length'], 'cold_support_compile_cas_bytes', gaps, { required: true })),
    compiledArtifactCasManifestHash: readAlias(compile, ['compiledArtifactCasManifestHash', 'compiled_artifact_cas_manifest_hash'], 'cold_support_compile_cas_manifest_hash', gaps, { required: true }),
    compileInvocationBindingHash: readAlias(compile, ['compileInvocationBindingHash', 'compile_invocation_binding_hash'], 'cold_support_compile_invocation_hash', gaps, { required: true }),
    mcpRequestHash: readAlias(compile, ['mcpRequestHash', 'mcp_request_hash'], 'cold_support_compile_mcp_request_hash', gaps, { required: true }),
    mcpCompileResponseHash: readAlias(compile, ['mcpCompileResponseHash', 'mcp_compile_response_hash'], 'cold_support_compile_mcp_response_hash', gaps, { required: true }),
    generatedSourcePath,
    generatedSourceHash,
    generatedSourceBytes,
    compileCommandInputBindingHash: readAlias(compile, ['compileCommandInputBindingHash', 'compile_command_input_binding_hash'], 'cold_support_compile_command_input_hash', gaps, { required: true }),
    dependencyInputBindingHash: readAlias(compile, ['dependencyInputBindingHash', 'dependency_input_binding_hash'], 'cold_support_compile_dependency_input_hash', gaps, { required: true }),
    compilerExecutable: readAlias(compile, ['compilerExecutable', 'compiler_executable'], 'cold_support_compile_compiler', gaps, { required: true }),
    deviceCompiler: readAlias(compile, ['deviceCompiler', 'device_compiler'], 'cold_support_compile_device_compiler', gaps, { required: true }),
    gpuVendor: readAlias(compile, ['gpuVendor', 'gpu_vendor'], 'cold_support_compile_vendor', gaps, { required: true }),
    gpuArch: readAlias(compile, ['gpuArch', 'gpu_arch'], 'cold_support_compile_arch', gaps, { required: true }),
    sourceFilename: normalizedPath(readAlias(compile, ['sourceFilename', 'source_filename'], 'cold_support_compile_source_filename', gaps, { required: true })),
    compileCommandHash: readAlias(compile, ['compileCommandHash', 'compile_command_hash'], 'cold_support_compile_command_hash', gaps, { required: true }),
    dependencyHash: readAlias(compile, ['dependencyHash', 'dependency_hash'], 'cold_support_compile_dependency_hash', gaps, { required: true }),
    compilerIdentity: readAlias(compile, ['compilerIdentity', 'compiler_identity'], 'cold_support_compile_compiler_identity', gaps, { required: true }),
    cacheHit: readAlias(compile, ['cacheHit', 'cache_hit'], 'cold_support_compile_cache_hit', gaps, { required: true }),
    verificationGaps,
    eligibilityGaps,
    blockingGaps,
  };
  const evidenceHash = sha256Text(stableJson(proofSeed));
  if (
    readAlias(compile, ['schemaVersion', 'schema_version'], 'cold_support_compile_schema', gaps, { required: true }) !== COLD_DEVICE_COMPILE_SCHEMA_VERSION
    || readAlias(compile, ['proofAuthority', 'proof_authority'], 'cold_support_compile_authority', gaps, { required: true }) !== COLD_DEVICE_COMPILE_AUTHORITY
    || readAlias(compile, ['evidenceHash', 'evidence_hash'], 'cold_support_compile_evidence_hash', gaps, { required: true }) !== evidenceHash
    || compile.accepted !== true
    || readAlias(compile, ['acceptedAsFreshDeviceCompileEvidence', 'accepted_as_fresh_device_compile_evidence'], 'cold_support_compile_fresh_evidence', gaps, { required: true }) !== true
    || proofSeed.byteObservationVerified !== true
    || proofSeed.liveObservationAccepted !== true
    || readAlias(compile, ['syntheticOrReplayIneligible', 'synthetic_or_replay_ineligible'], 'cold_support_compile_replay_flag', gaps, { required: true }) !== false
    || readAlias(compile, ['freshCompilerInvocation', 'fresh_compiler_invocation'], 'cold_support_compile_fresh_invocation', gaps, { required: true }) !== true
    || proofSeed.cacheHit !== false
    || !contentAddressedSha256(proofSeed.compileInvocationBindingHash)
    || !contentAddressedSha256(proofSeed.mcpRequestHash)
    || !contentAddressedSha256(proofSeed.mcpCompileResponseHash)
    || !contentAddressedSha256(proofSeed.compileCommandInputBindingHash)
    || !contentAddressedSha256(proofSeed.dependencyInputBindingHash)
    || !contentAddressedSha256(proofSeed.compileCommandHash)
    || !contentAddressedSha256(proofSeed.dependencyHash)
    || proofSeed.sourceFilename !== generatedSourcePath
    || !Array.isArray(proofSeed.gpuArch)
    || !proofSeed.gpuArch.includes(sourceFirstFacet.gpuArch)
    || proofSeed.compiledArtifactCasRole !== COLD_COMPILED_ARTIFACT_CAS_ROLE
    || proofSeed.compiledArtifactCasMediaType !== COLD_COMPILED_ARTIFACT_CAS_MEDIA_TYPE
    || proofSeed.compiledArtifactCasContentHash !== artifactHash
    || proofSeed.compiledArtifactCasByteLength !== artifactBytes
    || proofSeed.compiledArtifactCasManifestHash !== casValidation?.manifestHash
  ) {
    addGap(gaps, 'cold_support_compile_evidence_mismatch');
  }
  emptyGapArrays(compile, 'cold_support_device_compile', gaps);
  return {
    compile,
    evidenceHash,
    artifactHash,
    artifactBytes,
    artifactFilePath,
    proofArtifactId,
    proofArtifactIdentity,
    proofArtifactPath,
    generatedSourcePath,
    generatedSourceHash,
    generatedSourceBytes,
    casManifestHash: casValidation?.manifestHash ?? null,
    casBindingHash: bindingHash,
    casValidation,
    mcpRequestHash: proofSeed.mcpRequestHash,
    mcpCompileResponseHash: proofSeed.mcpCompileResponseHash,
    compileInvocationBindingHash: proofSeed.compileInvocationBindingHash,
    compileCommandHash: proofSeed.compileCommandHash,
    dependencyHash: proofSeed.dependencyHash,
    compileCommandInputBindingHash: proofSeed.compileCommandInputBindingHash,
    dependencyInputBindingHash: proofSeed.dependencyInputBindingHash,
  };
}

function timingEvidence(row, sourceFirstFacet, gaps) {
  const timing = readAlias(row, ['timingMetrics', 'timing_metrics', 'runMode', 'run_mode'], 'cold_support_timing', gaps, { required: true });
  if (!isObject(timing)) return { timing: {}, evidenceHash: null };
  collectAliasConflicts(timing, 'cold_support_timing', gaps);
  const timings = isObject(timing.timings) ? timing.timings : {};
  const deviceCompileWallTime = finiteNonnegative(timings.device_compile_wall_time);
  const runtimeProbeTime = finiteNonnegative(timings.runtime_probe_time);
  const totalValidatorWallTime = finiteNonnegative(timings.total_validator_wall_time);
  const editId = readAlias(timing, ['editId', 'edit_id'], 'cold_support_timing_edit_id', gaps);
  const editHash = readAlias(timing, ['editHash', 'edit_hash'], 'cold_support_timing_edit_hash', gaps, { required: true });
  if (
    readAlias(timing, ['schemaVersion', 'schema_version'], 'cold_support_timing_schema', gaps, { required: true }) !== RUNNER_TIMING_SCHEMA_VERSION
    || readAlias(timing, ['metricClock', 'metric_clock'], 'cold_support_timing_clock', gaps, { required: true }) !== 'monotonic_ns'
    || readAlias(timing, ['metricScope', 'metric_scope'], 'cold_support_timing_scope', gaps, { required: true }) !== 'cold'
    || readAlias(timing, ['cacheState', 'cache_state'], 'cold_support_timing_cache_state', gaps, { required: true }) !== 'clean'
    || editHash !== sourceFirstFacet.sourceContentHash
    || readAlias(timing, ['editKind', 'edit_kind'], 'cold_support_timing_edit_kind', gaps, { required: true }) !== 'cold_split'
    || readAlias(timing, ['differentEdit', 'different_edit'], 'cold_support_timing_different_edit', gaps, { required: true }) !== false
    || deviceCompileWallTime === null
    || runtimeProbeTime === null
    || totalValidatorWallTime === null
    || totalValidatorWallTime < deviceCompileWallTime
    || totalValidatorWallTime < runtimeProbeTime
  ) {
    addGap(gaps, 'cold_support_timing_invalid');
  }
  const seed = {
    schemaVersion: RUNNER_TIMING_SCHEMA_VERSION,
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: editId ?? null,
    editHash: sourceFirstFacet.sourceContentHash,
    editKind: 'cold_split',
    differentEdit: false,
    timings: {
      device_compile_wall_time: deviceCompileWallTime,
      runtime_probe_time: runtimeProbeTime,
      total_validator_wall_time: totalValidatorWallTime,
    },
  };
  const evidenceHash = sha256Text(stableJson(seed));
  if (readAlias(timing, ['evidenceHash', 'evidence_hash'], 'cold_support_timing_evidence_hash', gaps, { required: true }) !== evidenceHash) {
    addGap(gaps, 'cold_support_timing_evidence_hash_mismatch');
  }
  return { timing, evidenceHash };
}

function normalizedGeneratedArtifacts(rawSourceFirst, gaps) {
  const entries = readAlias(rawSourceFirst, ['generatedArtifacts', 'generated_artifacts'], 'cold_support_generated_artifacts', gaps, { required: true });
  if (!Array.isArray(entries) || entries.length === 0) {
    addGap(gaps, 'cold_support_generated_artifacts_missing');
    return [];
  }
  return entries.map((entry, index) => {
    collectAliasConflicts(entry, `cold_support_generated_artifact_${index}`, gaps);
    const filePath = normalizedPath(entry?.path);
    const contentHash = readAlias(entry, ['contentHash', 'content_hash'], `cold_support_generated_artifact_${index}_hash`, gaps, { required: true });
    const byteLength = Number(readAlias(entry, ['byteLength', 'byte_length'], `cold_support_generated_artifact_${index}_bytes`, gaps, { required: true }));
    if (!safeRelativePath(filePath) || !contentAddressedSha256(contentHash) || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
      addGap(gaps, `cold_support_generated_artifact_${index}_invalid`);
    }
    return {
      path: filePath,
      contentHash,
      content_hash: contentHash,
      byteLength,
      byte_length: byteLength,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function generatedArtifactBinding(row, rawSourceFirst, compile, gaps) {
  const generated = normalizedGeneratedArtifacts(rawSourceFirst, gaps);
  const manifest = [
    ...generated.map((entry) => ({ ...entry, producer: 'generated_split_bytes' })),
    {
      path: compile.artifactFilePath,
      contentHash: compile.artifactHash,
      content_hash: compile.artifactHash,
      byteLength: compile.artifactBytes,
      byte_length: compile.artifactBytes,
      producer: 'content_identified_worker_compile_proof',
      proofArtifactIdentity: compile.proofArtifactIdentity,
      proof_artifact_identity: compile.proofArtifactIdentity,
      byteObservationVerified: true,
      byte_observation_verified: true,
      artifactCasRole: COLD_COMPILED_ARTIFACT_CAS_ROLE,
      artifact_cas_role: COLD_COMPILED_ARTIFACT_CAS_ROLE,
      artifactCasManifestHash: compile.casManifestHash,
      artifact_cas_manifest_hash: compile.casManifestHash,
      artifactCasBindingHash: compile.casBindingHash,
      artifact_cas_binding_hash: compile.casBindingHash,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const manifestHash = sha256Text(stableJson(manifest));
  const hashes = uniqueSortedStrings(manifest.map((entry) => entry.contentHash));
  const suppliedHashes = uniqueSortedStrings(readAlias(row, ['generatedArtifactHashes', 'generated_artifact_hashes'], 'cold_support_generated_artifact_hashes', gaps, { required: true }));
  if (stableJson(hashes) !== stableJson(suppliedHashes) || !hashes.includes(compile.artifactHash)) {
    addGap(gaps, 'cold_support_generated_artifact_hashes_mismatch');
  }
  return { manifest, manifestHash, hashes };
}

function derivationAndModalityEvidence({
  row,
  rawSourceFirst,
  sourceFirstFacet,
  intent,
  profile,
  request,
  provider,
  compile,
  timing,
  generated,
  gaps,
}) {
  const derivation = readAlias(row, ['coldSourceDerivationChain', 'cold_source_derivation_chain'], 'cold_support_derivation_chain', gaps, { required: true });
  const modality = readAlias(row, ['requestedModalityBinding', 'requested_modality_binding'], 'cold_support_modality_binding', gaps, { required: true });
  collectAliasConflicts(derivation, 'cold_support_derivation_chain', gaps);
  collectAliasConflicts(modality, 'cold_support_modality_binding', gaps);
  authorityClaimGaps(derivation, 'cold_support_derivation_chain', gaps);
  authorityClaimGaps(modality, 'cold_support_modality_binding', gaps);
  supportFlags(derivation, 'cold_support_derivation_chain', gaps);
  supportFlags(modality, 'cold_support_modality_binding', gaps);
  const derivationSeed = {
    schemaVersion: COLD_SOURCE_DERIVATION_CHAIN_SCHEMA_VERSION,
    profileRequestIdentityHash: profile.identityHash,
    requestIntentHash: intent.intentHash,
    initialCompileRequestIdentity: request.requestIdentity,
    mcpRequestHash: compile.mcpRequestHash,
    sourceFirstProofId: sourceFirstFacet.proofId,
    sourceContentHash: sourceFirstFacet.sourceContentHash,
    sourceManifestHash: sourceFirstFacet.initialManifestHash,
    generatedDeviceSourcePath: compile.generatedSourcePath,
    generatedDeviceSourceHash: compile.generatedSourceHash,
    generatedDeviceSourceBytes: compile.generatedSourceBytes,
    generatedArtifactManifestHash: generated.manifestHash,
    generatedArtifactHashes: generated.hashes,
    sidecarHash: sourceFirstFacet.sidecarHash,
    compileManifestHash: sourceFirstFacet.compileManifestHash,
    providerCallReceiptHash: provider.canonicalReceiptHash,
    providerCallProducerReceiptHash: provider.producerReceiptHash,
    providerCallRequestHash: provider.requestHash,
    providerCallResponseHash: provider.responseHash,
    providerCallChallengeHash: provider.challengeHash,
    providerProtocolMaterialHash: provider.materialHash,
    providerCallEvidenceHash: provider.evidenceHash,
    compileEvidenceHash: compile.evidenceHash,
    compileProofArtifactId: compile.proofArtifactId,
    compileProofArtifactIdentity: compile.proofArtifactIdentity,
    compileProofArtifactPath: compile.proofArtifactPath,
    compileArtifactHash: compile.artifactHash,
    compileArtifactBytes: compile.artifactBytes,
    compileArtifactFilePath: compile.artifactFilePath,
    compileArtifactCasRole: COLD_COMPILED_ARTIFACT_CAS_ROLE,
    compileArtifactCasMediaType: COLD_COMPILED_ARTIFACT_CAS_MEDIA_TYPE,
    compileArtifactCasContentHash: compile.artifactHash,
    compileArtifactCasByteLength: compile.artifactBytes,
    compileArtifactCasManifestHash: compile.casManifestHash,
    compileArtifactCasBindingHash: compile.casBindingHash,
    compileCommandHash: compile.compileCommandHash,
    compileDependencyHash: compile.dependencyHash,
    compileCommandInputBindingHash: compile.compileCommandInputBindingHash,
    compileDependencyInputBindingHash: compile.dependencyInputBindingHash,
    compileInvocationBindingHash: compile.compileInvocationBindingHash,
    compileResponseHash: compile.mcpCompileResponseHash,
    timingEvidenceHash: timing.evidenceHash,
    outputOracleKind: 'compute_oracle',
  };
  const derivationHash = sha256Text(stableJson(derivationSeed));
  if (
    !isObject(derivation)
    || readAlias(derivation, ['schemaVersion', 'schema_version'], 'cold_support_derivation_schema', gaps, { required: true }) !== COLD_SOURCE_DERIVATION_CHAIN_SCHEMA_VERSION
    || readAlias(derivation, ['proofAuthority', 'proof_authority'], 'cold_support_derivation_authority', gaps, { required: true }) !== COLD_SOURCE_DERIVATION_CHAIN_AUTHORITY
    || readAlias(derivation, ['derivationChainHash', 'derivation_chain_hash'], 'cold_support_derivation_hash', gaps, { required: true }) !== derivationHash
  ) {
    addGap(gaps, 'cold_support_derivation_chain_mismatch');
  }
  const sourcePurityManifestHash = sourceFirstFacet.sourcePurityManifestHash;
  const modalitySeed = {
    schemaVersion: COLD_SOURCE_MODALITY_BINDING_SCHEMA_VERSION,
    outputOracleKind: 'compute_oracle',
    sourceFirstProofId: sourceFirstFacet.proofId,
    profileRequestIdentityHash: profile.identityHash,
    sourceContentHash: sourceFirstFacet.sourceContentHash,
    sourceManifestHash: sourceFirstFacet.initialManifestHash,
    initialManifestHash: sourceFirstFacet.initialManifestHash,
    sourcePurityManifestHash,
    requestIntentHash: intent.intentHash,
    initialCompileRequestIdentity: request.requestIdentity,
    mcpRequestHash: compile.mcpRequestHash,
    derivationChainHash: derivationHash,
    generatedArtifactHashes: generated.hashes,
    generatedArtifactManifestHash: generated.manifestHash,
    generatedDeviceSourceHash: compile.generatedSourceHash,
    sidecarHash: sourceFirstFacet.sidecarHash,
    compileManifestHash: sourceFirstFacet.compileManifestHash,
    providerCallReceiptHash: provider.canonicalReceiptHash,
    providerCallRequestHash: provider.requestHash,
    providerCallResponseHash: provider.responseHash,
    providerCallChallengeHash: provider.challengeHash,
    providerProtocolMaterialHash: provider.materialHash,
    providerCallEvidenceHash: provider.evidenceHash,
    deviceCompileArtifactHash: compile.artifactHash,
    deviceCompileEvidenceHash: compile.evidenceHash,
    deviceCompileProofArtifactId: compile.proofArtifactId,
    deviceCompileProofArtifactPath: compile.proofArtifactPath,
    deviceCompileProofArtifactIdentity: compile.proofArtifactIdentity,
    deviceCompileCommandHash: compile.compileCommandHash,
    deviceCompileDependencyHash: compile.dependencyHash,
    deviceCompileCommandInputBindingHash: compile.compileCommandInputBindingHash,
    deviceCompileDependencyInputBindingHash: compile.dependencyInputBindingHash,
    deviceCompileArtifactCasManifestHash: compile.casManifestHash,
    deviceCompileArtifactCasBindingHash: compile.casBindingHash,
    timingEvidenceHash: timing.evidenceHash,
  };
  const modalityHash = sha256Text(stableJson(modalitySeed));
  if (
    !isObject(modality)
    || readAlias(modality, ['schemaVersion', 'schema_version'], 'cold_support_modality_schema', gaps, { required: true }) !== COLD_SOURCE_MODALITY_BINDING_SCHEMA_VERSION
    || readAlias(modality, ['proofAuthority', 'proof_authority'], 'cold_support_modality_authority', gaps, { required: true }) !== COLD_SOURCE_MODALITY_BINDING_AUTHORITY
    || readAlias(modality, ['bindingHash', 'binding_hash'], 'cold_support_modality_hash', gaps, { required: true }) !== modalityHash
    || readAlias(modality, ['outputOracleKind', 'output_oracle_kind'], 'cold_support_modality_output_kind', gaps, { required: true }) !== 'compute_oracle'
  ) {
    addGap(gaps, 'cold_support_modality_binding_mismatch');
  }
  emptyGapArrays(derivation, 'cold_support_derivation_chain', gaps, ['blockingGaps']);
  emptyGapArrays(modality, 'cold_support_modality_binding', gaps, ['blockingGaps']);
  return { derivationHash, modalityHash };
}

export async function evaluateColdSourceSplitCompileSupport(row = {}, context = {}) {
  const gaps = [];
  const rawSourceFirst = readAlias(
    row,
    ['sourceFirstIngestion', 'source_first_ingestion', 'sourceFirstIngestionEvidence', 'source_first_ingestion_evidence'],
    'cold_support_source_first',
    gaps,
    { required: true },
  );
  const sourceFirstFacet = isObject(context.sourceFirstFacet) ? context.sourceFirstFacet : {};
  collectAliasConflicts(rawSourceFirst, 'cold_support_source_first', gaps);
  if (
    sourceFirstFacet.accepted !== true
    || sourceFirstFacet.schemaVersion !== SOURCE_FIRST_SCHEMA_VERSION
    || sourceFirstFacet.proofAuthority !== SOURCE_FIRST_AUTHORITY
    || sourceFirstFacet.acceptedForGpuHmr !== false
    || sourceFirstFacet.gpuHmrSuccess !== false
    || sourceFirstFacet.canSatisfyRuntimeProof !== false
  ) {
    addGap(gaps, 'cold_support_source_first_facet_not_accepted');
  }
  for (const key of FORBIDDEN_VISUAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, key)) addGap(gaps, 'cold_support_compute_visual_material_forbidden');
  }
  for (const key of RUNTIME_AUTHORITY_CARRIERS) {
    if (Object.prototype.hasOwnProperty.call(row, key) && nonemptyCarrier(row[key])) {
      addGap(gaps, 'cold_support_runtime_authority_carrier_forbidden');
    }
  }
  const envelope = {
    schemaVersion: row.schemaVersion,
    schema_version: row.schema_version,
    proofAuthority: row.proofAuthority,
    proof_authority: row.proof_authority,
    acceptedForGpuHmr: row.acceptedForGpuHmr,
    accepted_for_gpu_hmr: row.accepted_for_gpu_hmr,
    gpuHmrSuccess: row.gpuHmrSuccess,
    gpu_hmr_success: row.gpu_hmr_success,
    canSatisfyRuntimeProof: row.canSatisfyRuntimeProof,
    can_satisfy_runtime_proof: row.can_satisfy_runtime_proof,
    canSatisfyDispatchProof: row.canSatisfyDispatchProof,
    can_satisfy_dispatch_proof: row.can_satisfy_dispatch_proof,
    canSatisfyOutputOracleProof: row.canSatisfyOutputOracleProof,
    can_satisfy_output_oracle_proof: row.can_satisfy_output_oracle_proof,
  };
  collectAliasConflicts(envelope, 'cold_support_envelope', gaps);
  authorityClaimGaps(envelope, 'cold_support_envelope', gaps);
  supportFlags(envelope, 'cold_support_envelope', gaps, { requireAccepted: false, requireOutputFalse: true });
  const schemaVersion = readAlias(row, ['schemaVersion', 'schema_version'], 'cold_support_schema', gaps, { required: true });
  const proofAuthority = readAlias(row, ['proofAuthority', 'proof_authority'], 'cold_support_proof_authority', gaps, { required: true });
  const outputOracleKind = readAlias(row, ['outputOracleKind', 'output_oracle_kind'], 'cold_support_output_oracle_kind', gaps, { required: true });
  if (schemaVersion !== AGENT_SPLIT_RUN_MODE_SCHEMA_VERSION) addGap(gaps, 'cold_support_schema_invalid');
  if (proofAuthority !== COLD_COMPUTE_PROOF_AUTHORITY) addGap(gaps, 'cold_support_proof_authority_invalid');
  if (outputOracleKind !== 'compute_oracle') addGap(gaps, 'cold_support_output_oracle_kind_not_compute');
  if (
    readAlias(row, ['coldSplitProven', 'cold_split_proven'], 'cold_support_cold_split_proven', gaps, { required: true }) !== true
    || readAlias(row, ['canonicalColdSourceMaterialVerified', 'canonical_cold_source_material_verified'], 'cold_support_canonical_material', gaps, { required: true }) !== true
    || readAlias(row, ['liveObservationAccepted', 'live_observation_accepted'], 'cold_support_live_observation', gaps, { required: true }) !== true
    || readAlias(row, ['syntheticOrReplayIneligible', 'synthetic_or_replay_ineligible'], 'cold_support_replay_flag', gaps, { required: true }) !== false
    || readAlias(row, ['acceptedAsColdAiSplitEvidence', 'accepted_as_cold_ai_split_evidence'], 'cold_support_split_evidence_accepted', gaps, { required: true }) !== true
  ) {
    addGap(gaps, 'cold_support_live_cold_split_protocol_not_closed');
  }
  for (const [key, value] of Object.entries(row)) {
    const canonical = canonicalKey(key);
    if (
      canonical !== 'proofauthority'
      && canonical !== 'sourceauthority'
      && (canonical.endsWith('authority') || canonical.endsWith('authorities'))
    ) {
      addGap(gaps, `cold_support_envelope_${canonical}_forbidden`);
    }
    if (FORBIDDEN_SUCCESS_KEYS.has(canonical) && value !== false && value != null) {
      addGap(gaps, `cold_support_envelope_${canonical}_forbidden`);
    }
  }
  const intent = requestIntentEvidence(rawSourceFirst, sourceFirstFacet, gaps);
  const profile = profileIdentityEvidence(rawSourceFirst, sourceFirstFacet, intent.intentHash, row, gaps);
  const request = initialCompileRequestEvidence(rawSourceFirst, sourceFirstFacet, intent.intentHash, gaps);
  const provider = providerProtocolEvidence(
    row,
    sourceFirstFacet,
    request.requestBinding,
    request.providerFileManifestHash,
    gaps,
  );
  const compile = await compiledArtifactEvidence(row, sourceFirstFacet, request.requestBinding, context, gaps);
  const timing = timingEvidence(row, sourceFirstFacet, gaps);
  const generated = generatedArtifactBinding(row, rawSourceFirst, compile, gaps);
  const bindings = derivationAndModalityEvidence({
    row,
    rawSourceFirst,
    sourceFirstFacet,
    intent,
    profile,
    request,
    provider,
    compile,
    timing,
    generated,
    gaps,
  });
  const blockingGaps = uniqueSortedStrings(gaps);
  const seed = {
    schemaVersion: GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_SCHEMA_VERSION,
    outputOracleKind: 'compute_oracle',
    sourceFirstProofId: sourceFirstFacet.proofId ?? null,
    sourceContentHash: sourceFirstFacet.sourceContentHash ?? null,
    sourceManifestHash: sourceFirstFacet.initialManifestHash ?? null,
    profileRequestIdentityHash: profile.identityHash,
    requestIntentHash: intent.intentHash,
    initialCompileRequestIdentity: request.requestIdentity,
    providerCallEvidenceHash: provider.evidenceHash,
    providerProtocolMaterialHash: provider.materialHash,
    compileEvidenceHash: compile.evidenceHash,
    compiledArtifactHash: compile.artifactHash,
    compiledArtifactBytes: compile.artifactBytes,
    compiledArtifactCasManifestHash: compile.casManifestHash,
    compiledArtifactCasBindingHash: compile.casBindingHash,
    generatedArtifactManifestHash: generated.manifestHash,
    derivationChainHash: bindings.derivationHash,
    requestedModalityBindingHash: bindings.modalityHash,
    timingEvidenceHash: timing.evidenceHash,
    blockingGaps,
  };
  const supportHash = sha256Text(stableJson(seed));
  const accepted = blockingGaps.length === 0;
  return {
    ...seed,
    schema_version: seed.schemaVersion,
    proofAuthority: GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_AUTHORITY,
    proof_authority: GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_AUTHORITY,
    supportHash,
    support_hash: supportHash,
    accepted,
    acceptedAsColdSourceSplitCompileSupport: accepted,
    accepted_as_cold_source_split_compile_support: accepted,
    supportOnly: true,
    support_only: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    canSatisfyOutputOracleProof: false,
    can_satisfy_output_oracle_proof: false,
    compiledArtifactCasAccepted: compile.casValidation?.accepted === true,
    compiled_artifact_cas_accepted: compile.casValidation?.accepted === true,
    compiledArtifactCasResolvedPath: compile.casValidation?.localPath ?? null,
    compiled_artifact_cas_resolved_path: compile.casValidation?.localPath ?? null,
    blocking_gaps: blockingGaps,
    failedGates: blockingGaps,
    failed_gates: blockingGaps,
  };
}
