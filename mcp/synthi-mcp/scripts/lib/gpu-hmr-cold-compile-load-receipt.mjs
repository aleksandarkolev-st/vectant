import { createHash } from 'node:crypto';

export const COLD_COMPILE_LOAD_RECEIPT_SCHEMA =
  'synthi.gpu_hmr.cold_compile_load_receipt.v2';
export const COLD_COMPILE_LOAD_RECEIPT_AUTHORITY =
  'content_bound_cold_compile_load_recomputation_diagnostic_only_not_trusted_producer_or_gpu_hmr_runtime_dispatch_acceptance';

const GPU_HMR_PROOF_SCHEMA = 'synthi.gpu.hmr.proof.v1';
const GPU_ARTIFACT_LOAD_TERMINAL_SCHEMA =
  'synthi.runner.gpu_artifact_load_result.v1';
const ARTIFACT_TRANSPORT_SCHEMA = 'synthi.gpu.hmr.artifact_transport.v1';

const SHA256_VALUE_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^artifact:sha256:[a-f0-9]{64}$/;
const PROOF_ID_PATTERN = /^gpu-proof:[a-f0-9]{64}$/;
const SOURCE_EDIT_ID_PATTERN = /^source-edit:sha256:[a-f0-9]{64}$/;
const REQUEST_ID_PATTERN = /^gpu-reload:request:[a-f0-9]{32}$/;

const PROOF_ARTIFACT_KEYS = Object.freeze([
  'schemaVersion',
  'proofId',
  'workspaceSlug',
  'runtimeSessionId',
  'sourceEditId',
  'selectedArtifactId',
  'resultState',
  'degradedState',
  'degradedReason',
  'stageResults',
  'evidenceRefs',
  'visualEvidenceRefs',
  'createdAt',
]);

const EXPECTED_CONTEXT_KEYS = Object.freeze([
  'workspaceSlug',
  'runtimeSessionId',
  'sourceEditId',
  'proofId',
  'sourceFilename',
  'artifactContentHash',
  'requestId',
]);

const STRICT_COLD_METADATA = Object.freeze({
  compilerCachePolicy: 'empty_parent_environment_external_cache_state_unobserved',
  compilerCacheEvidenceScope: 'no_declared_cache_controls_not_cache_miss_attestation',
  compilerEnvironmentScope:
    'empty_parent_environment_with_explicit_content_bound_control_contract',
  compilerIdentityScope:
    'held_compiler_driver_entry_file_bytes_bound_to_linux_parent_procfd_execution_child_toolchain_not_attested',
  compilerIdentityMethod: 'held_compiler_driver_entry_file_sha256+version_output',
  compilerExecutionTransport: 'linux_parent_procfd_held_compiler_driver_entry_file',
  compileCommandHashScope:
    'explicit_preprocess_and_compile_program_args_cwd_environment_overrides_piped_input_hashes_and_stdout_artifact_transport',
  compilerInputMode: 'compiler_preprocessed_translation_unit_piped_stdin',
  compilerOutputTransport: 'compiler_stdout_parent_materialized_held_reservation',
  compilerSourceEvidenceScope:
    'generated_device_stage_transform_chain_preprocessor_input_and_preprocessed_translation_unit_bound_to_compiler_input_not_original_request_provenance',
  dependencyMethod: 'compiler_preprocessed_translation_unit_sha256',
});

const TERMINAL_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'module',
  'requestId',
  'sourceEditId',
  'artifactContentHash',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
]);

function fail(code) {
  throw new Error(`cold_compile_load_receipt_invalid:${code}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail('non_json_value');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function contentHash(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'));
}

function exactKeys(value, keys) {
  return isRecord(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function requiredBytes(value, field, { allowEmpty = false } = {}) {
  if (!(value instanceof Uint8Array)) fail(`${field}_missing`);
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (!allowEmpty && bytes.byteLength === 0) fail(`${field}_empty`);
  return bytes;
}

function requiredUtf8Bytes(value, field, options = {}) {
  const bytes = requiredBytes(value, field, options);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${field}_not_utf8`);
  }
  return bytes;
}

function requiredString(value, field) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || /[\0\r\n]/.test(value)
  ) {
    fail(`${field}_invalid`);
  }
  return value;
}

function requiredSafeLength(value, field, { allowZero = false } = {}) {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || (!allowZero && value === 0)
  ) {
    fail(`${field}_invalid`);
  }
  return value;
}

function exactStringArray(value, expected, field) {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])
  ) {
    fail(`${field}_mismatch`);
  }
}

function uniqueRecordBy(values, field, expected, gap) {
  if (!Array.isArray(values)) fail(`${gap}_list_missing`);
  const matches = values.filter((value) => isRecord(value) && value[field] === expected);
  if (matches.length !== 1) fail(`${gap}_cardinality`);
  return matches[0];
}

function coldCompilerInput(sourceFilename, transformedSource) {
  if (
    typeof sourceFilename !== 'string'
    || sourceFilename.trim().length === 0
    || /[\0\r\n]/.test(sourceFilename)
  ) {
    fail('source_filename_invalid');
  }
  const normalized = sourceFilename.replaceAll('\\', '/');
  const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return Buffer.concat([
    Buffer.from(`#line 1 "${escaped}"\n`, 'utf8'),
    transformedSource,
  ]);
}

function requireEvidenceId(evidence, prefix, expectedHash, field) {
  requiredString(evidence.evidenceId, field);
  if (evidence.evidenceId !== `${prefix}${expectedHash.slice('sha256:'.length)}`) {
    fail(`${field}_content_mismatch`);
  }
}

function proofMaterial(proofArtifact) {
  return {
    schemaVersion: proofArtifact.schemaVersion,
    workspaceSlug: proofArtifact.workspaceSlug,
    runtimeSessionId: proofArtifact.runtimeSessionId,
    sourceEditId: proofArtifact.sourceEditId,
    selectedArtifactId: proofArtifact.selectedArtifactId,
    resultState: proofArtifact.resultState,
    degradedState: proofArtifact.degradedState,
    degradedReason: proofArtifact.degradedReason,
    stageResults: proofArtifact.stageResults,
    evidenceRefs: proofArtifact.evidenceRefs,
    visualEvidenceRefs: proofArtifact.visualEvidenceRefs,
    createdAt: proofArtifact.createdAt,
  };
}

function authorityClaimTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', 'yes', 'accepted', 'success', 'proven']
    .includes(value.trim().toLowerCase());
}

function hasAuthorityClaim(value) {
  if (Array.isArray(value)) return value.some(hasAuthorityClaim);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if ([
      'acceptedforgpuhmr',
      'gpuhmrsuccess',
      'cansatisfyruntimeproof',
      'cansatisfydispatchproof',
      'fullruntimeproven',
      'runtimeproofaccepted',
      'dispatchproofaccepted',
    ].includes(normalizedKey) && authorityClaimTruthy(nested)) {
      return true;
    }
    if (normalizedKey === 'proofauthority' && typeof nested === 'string') {
      const authority = nested.trim().toLowerCase();
      const claimsGpuAuthority = /gpu.?hmr.?success|gpu.?hmr.?accept|runtime.?authority|dispatch.?authority/
        .test(authority);
      const explicitlyNonAuthoritative = /(?:^|[_\s-])not(?:[_\s-]|$)/.test(authority);
      if (claimsGpuAuthority && !explicitlyNonAuthoritative) return true;
    }
    if (hasAuthorityClaim(nested)) return true;
  }
  return false;
}

function verifyStrictColdMetadata(
  metadata,
  requestSource,
  sourceTransformOutputs,
  preprocessorInput,
  compilerInput,
  artifact,
) {
  if (!isRecord(metadata)) fail('compile_provenance_missing');
  if (
    metadata.artifactCacheBypassed !== true
    || metadata.artifactCacheKey != null
    || metadata.cacheHit !== false
    || metadata.compilerProcessExecuted !== true
    || metadata.preprocessorProcessExecuted !== true
    || metadata.preprocessorIdentityVerifiedAfterExecution !== true
    || metadata.compilerOutputFreshlyCreated !== true
    || metadata.compilerPathIdentityVerifiedAfterExecution !== true
    || metadata.compilerDriverEntryFileAttested !== true
    || metadata.compilerProcessImageAttested !== false
    || metadata.sourceBytesVerifiedAfterExecution !== true
  ) {
    fail('strict_cold_flags_mismatch');
  }

  for (const [field, expected] of Object.entries(STRICT_COLD_METADATA)) {
    if (metadata[field] !== expected) fail(`${field}_mismatch`);
  }
  if (!isRecord(metadata.compilerCacheControls)
    || Object.keys(metadata.compilerCacheControls).length !== 0) {
    fail('compiler_cache_controls_mismatch');
  }
  requiredString(metadata.compilerResolvedPath, 'compiler_resolved_path');
  for (const [field, value] of [
    ['compiler_identity', metadata.compilerIdentity],
    ['compiler_executable_hash', metadata.compilerExecutableHash],
    ['compile_command_hash', metadata.compileCommandHash],
    ['preprocessor_command_hash', metadata.preprocessorCommandHash],
  ]) {
    if (!SHA256_VALUE_PATTERN.test(value ?? '')) fail(`${field}_invalid`);
  }
  requiredSafeLength(metadata.preprocessorElapsedMs, 'preprocessor_elapsed_ms', {
    allowZero: true,
  });

  const requestSourceHash = sha256(requestSource);
  if (
    metadata.requestSourceSha256 !== requestSourceHash
    || metadata.requestSourceBytes !== requestSource.byteLength
  ) {
    fail('request_source_binding_mismatch');
  }

  if (!Array.isArray(metadata.sourceTransforms)) fail('source_transform_list_missing');
  if (metadata.sourceTransforms.length !== sourceTransformOutputs.length) {
    fail('source_transform_count_mismatch');
  }
  let previousBytes = requestSource;
  const transformBindings = metadata.sourceTransforms.map((transform, index) => {
    if (!isRecord(transform)) fail(`source_transform_${index}_invalid`);
    requiredString(transform.transform, `source_transform_${index}_identity`);
    requiredSafeLength(transform.attempt, `source_transform_${index}_attempt`, {
      allowZero: true,
    });
    const outputBytes = sourceTransformOutputs[index];
    const inputHash = sha256(previousBytes);
    const outputHash = sha256(outputBytes);
    if (
      transform.inputSha256 !== inputHash
      || transform.inputBytes !== previousBytes.byteLength
      || transform.outputSha256 !== outputHash
      || transform.outputBytes !== outputBytes.byteLength
    ) {
      fail(`source_transform_${index}_binding_mismatch`);
    }
    const binding = {
      index,
      inputHash,
      inputBytes: previousBytes.byteLength,
      outputHash,
      outputBytes: outputBytes.byteLength,
    };
    previousBytes = outputBytes;
    return binding;
  });

  const transformedSourceHash = sha256(previousBytes);
  if (
    metadata.transformedSourceSha256 !== transformedSourceHash
    || metadata.transformedSourceBytes !== previousBytes.byteLength
  ) {
    fail('transformed_source_binding_mismatch');
  }
  const expectedPreprocessorInput = coldCompilerInput(
    metadata.sourceFilename,
    previousBytes,
  );
  if (!preprocessorInput.equals(expectedPreprocessorInput)) {
    fail('preprocessor_input_bytes_mismatch');
  }
  const preprocessorInputHash = sha256(preprocessorInput);
  if (
    metadata.preprocessorInputSha256 !== preprocessorInputHash
    || metadata.preprocessorInputBytes !== preprocessorInput.byteLength
  ) {
    fail('preprocessor_input_binding_mismatch');
  }

  const compilerInputHash = sha256(compilerInput);
  if (
    metadata.compiledSourceSha256 !== compilerInputHash
    || metadata.compiledSourceBytes !== compilerInput.byteLength
    || metadata.dependencyHash !== compilerInputHash
  ) {
    fail('compiler_input_binding_mismatch');
  }

  const artifactHash = sha256(artifact);
  if (
    metadata.artifactSha256 !== artifactHash
    || metadata.artifactBytes !== artifact.byteLength
  ) {
    fail('artifact_snapshot_binding_mismatch');
  }

  return {
    requestSourceHash,
    requestSourceBytes: requestSource.byteLength,
    transformBindings,
    transformedSourceHash,
    transformedSourceBytes: previousBytes.byteLength,
    preprocessorInputHash,
    preprocessorInputBytes: preprocessorInput.byteLength,
    sourceFilename: metadata.sourceFilename,
    compilerInputHash,
    compilerInputBytes: compilerInput.byteLength,
    artifactHash,
    artifactBytes: artifact.byteLength,
    strictMetadataHash: contentHash(metadata),
  };
}

function verifyProofArtifact(proofArtifact, bindings) {
  if (!isRecord(proofArtifact)) fail('proof_artifact_missing');
  if (hasAuthorityClaim(proofArtifact)) fail('proof_artifact_authority_claimed');
  if (!exactKeys(proofArtifact, PROOF_ARTIFACT_KEYS)) {
    fail('proof_artifact_shape_invalid');
  }
  if (proofArtifact.schemaVersion !== GPU_HMR_PROOF_SCHEMA) fail('proof_schema_mismatch');
  if (!PROOF_ID_PATTERN.test(proofArtifact.proofId ?? '')) fail('proof_id_invalid');
  requiredString(proofArtifact.workspaceSlug, 'workspace_slug');
  requiredString(proofArtifact.runtimeSessionId, 'runtime_session_id');
  requiredString(proofArtifact.createdAt, 'created_at');
  if (!SOURCE_EDIT_ID_PATTERN.test(proofArtifact.sourceEditId ?? '')) {
    fail('source_edit_id_invalid');
  }
  if (!ARTIFACT_ID_PATTERN.test(proofArtifact.selectedArtifactId ?? '')) {
    fail('selected_artifact_id_invalid');
  }
  if (!['gpu-hmr-compile-proven', 'gpu-hmr-symbol-bound'].includes(
    proofArtifact.resultState,
  )) {
    fail('cold_proof_result_state_invalid');
  }
  if (
    proofArtifact.degradedState !== 'gpu-hmr-dispatch-unobserved'
    || typeof proofArtifact.degradedReason !== 'string'
    || proofArtifact.degradedReason.trim().length === 0
  ) {
    fail('cold_proof_degraded_state_invalid');
  }
  if (!Array.isArray(proofArtifact.stageResults)) fail('stage_results_missing');
  if (!Array.isArray(proofArtifact.evidenceRefs)) fail('evidence_refs_missing');
  if (!Array.isArray(proofArtifact.visualEvidenceRefs)) fail('visual_evidence_refs_missing');
  if (proofArtifact.visualEvidenceRefs.length !== 0) {
    fail('cold_compile_visual_evidence_unexpected');
  }

  const recomputedProofId = `gpu-proof:${contentHash(proofMaterial(proofArtifact)).slice(7)}`;
  if (proofArtifact.proofId !== recomputedProofId) fail('proof_id_content_mismatch');

  const expectedArtifactId = `artifact:${bindings.artifactHash}`;
  if (proofArtifact.selectedArtifactId !== expectedArtifactId) {
    fail('selected_artifact_content_mismatch');
  }

  const artifactEvidence = uniqueRecordBy(
    proofArtifact.evidenceRefs,
    'kind',
    'device-artifact',
    'artifact_evidence',
  );
  const compilerEvidence = uniqueRecordBy(
    proofArtifact.evidenceRefs,
    'kind',
    'device-compiler-output',
    'compiler_evidence',
  );
  const transportEvidence = uniqueRecordBy(
    proofArtifact.evidenceRefs,
    'kind',
    'device-artifact-transport',
    'transport_evidence',
  );
  if (
    artifactEvidence.contentHash !== bindings.artifactHash
    || artifactEvidence.artifactUri !== expectedArtifactId
    || !isRecord(artifactEvidence.metadata)
    || artifactEvidence.metadata.artifactBytes !== bindings.artifactBytes
  ) {
    fail('artifact_evidence_binding_mismatch');
  }
  requireEvidenceId(
    artifactEvidence,
    'evidence:device-artifact:',
    bindings.artifactHash,
    'artifact_evidence_id',
  );

  const compilerStderrHash = sha256(bindings.compilerStderr);
  if (
    compilerEvidence.contentHash !== compilerStderrHash
    || !isRecord(compilerEvidence.metadata)
    || compilerEvidence.metadata.stderrBytes !== bindings.compilerStderr.byteLength
    || !Number.isSafeInteger(compilerEvidence.metadata.compilerElapsedMs)
    || compilerEvidence.metadata.compilerElapsedMs < 0
    || !Array.isArray(compilerEvidence.metadata.diagnostics)
  ) {
    fail('compiler_evidence_binding_mismatch');
  }
  requireEvidenceId(
    compilerEvidence,
    'evidence:device-compiler:',
    compilerStderrHash,
    'compiler_evidence_id',
  );
  const compileProvenance = compilerEvidence.metadata?.compileProvenance;
  const strictBindings = verifyStrictColdMetadata(
    compileProvenance,
    bindings.requestSource,
    bindings.sourceTransformOutputs,
    bindings.preprocessorInput,
    bindings.compilerInput,
    bindings.artifact,
  );

  const transport = transportEvidence.metadata;
  if (
    !isRecord(transport)
    || transport.schemaVersion !== ARTIFACT_TRANSPORT_SCHEMA
    || transport.selectedArtifactId !== expectedArtifactId
    || transport.artifactContentHash !== bindings.artifactHash
    || transport.artifactBytes !== bindings.artifactBytes
    || transport.ramArtifactReferenceProvided !== true
    || transport.ramBlobId !== expectedArtifactId
    || transport.ramBytesHash !== bindings.artifactHash
    || transport.selectedLoaderTransport != null
    || transport.fallbackRecorded !== false
  ) {
    fail('artifact_transport_binding_mismatch');
  }
  const transportMetadataHash = contentHash(transport);
  if (transportEvidence.contentHash !== transportMetadataHash) {
    fail('artifact_transport_content_hash_mismatch');
  }
  requireEvidenceId(
    transportEvidence,
    'evidence:device-artifact-transport:',
    transportMetadataHash,
    'transport_evidence_id',
  );

  const compileStage = uniqueRecordBy(
    proofArtifact.stageResults,
    'stageId',
    'device-compile',
    'device_compile_stage',
  );
  if (compileStage.status !== 'passed') fail('device_compile_stage_not_passed');
  exactStringArray(
    compileStage.inputArtifactIds,
    [proofArtifact.sourceEditId],
    'device_compile_stage_inputs',
  );
  exactStringArray(
    compileStage.outputArtifactIds,
    [expectedArtifactId],
    'device_compile_stage_outputs',
  );
  exactStringArray(
    compileStage.evidenceRefs,
    [artifactEvidence.evidenceId, compilerEvidence.evidenceId],
    'device_compile_stage_evidence',
  );

  const transportStage = uniqueRecordBy(
    proofArtifact.stageResults,
    'stageId',
    'artifact-transport',
    'artifact_transport_stage',
  );
  if (transportStage.status !== 'blocked') fail('artifact_transport_stage_overclaimed');
  exactStringArray(
    transportStage.inputArtifactIds,
    [expectedArtifactId],
    'artifact_transport_stage_inputs',
  );
  exactStringArray(
    transportStage.outputArtifactIds,
    [expectedArtifactId],
    'artifact_transport_stage_outputs',
  );
  exactStringArray(
    transportStage.evidenceRefs,
    [transportEvidence.evidenceId],
    'artifact_transport_stage_evidence',
  );

  const dispatchStage = uniqueRecordBy(
    proofArtifact.stageResults,
    'stageId',
    'runtime-dispatch-observation',
    'runtime_dispatch_stage',
  );
  if (dispatchStage.status !== 'blocked') fail('runtime_dispatch_stage_overclaimed');
  exactStringArray(
    dispatchStage.inputArtifactIds,
    [expectedArtifactId],
    'runtime_dispatch_stage_inputs',
  );
  exactStringArray(dispatchStage.outputArtifactIds, [], 'runtime_dispatch_stage_outputs');
  exactStringArray(dispatchStage.evidenceRefs, [], 'runtime_dispatch_stage_evidence');

  return {
    ...strictBindings,
    proofArtifactHash: contentHash(proofArtifact),
    proofId: proofArtifact.proofId,
    workspaceSlug: proofArtifact.workspaceSlug,
    runtimeSessionId: proofArtifact.runtimeSessionId,
    sourceEditId: proofArtifact.sourceEditId,
    selectedArtifactId: expectedArtifactId,
    artifactEvidenceId: artifactEvidence.evidenceId,
    compilerEvidenceId: compilerEvidence.evidenceId,
    transportEvidenceId: transportEvidence.evidenceId,
    compilerStderrHash,
    compilerStderrBytes: bindings.compilerStderr.byteLength,
    transportMetadataHash,
  };
}

function verifyRunnerTerminal(terminal, requestId, proofBindings) {
  if (!exactKeys(terminal, TERMINAL_KEYS)) fail('runner_terminal_shape_invalid');
  if (
    terminal.schemaVersion !== GPU_ARTIFACT_LOAD_TERMINAL_SCHEMA
    || terminal.status !== 'loaded'
    || terminal.module !== 'device'
    || terminal.acceptedForGpuHmr !== false
    || terminal.gpuHmrSuccess !== false
  ) {
    fail('runner_terminal_state_invalid');
  }
  if (!REQUEST_ID_PATTERN.test(terminal.requestId ?? '')) fail('terminal_request_id_invalid');
  if (
    terminal.requestId !== requestId
    || terminal.sourceEditId !== proofBindings.sourceEditId
    || terminal.artifactContentHash !== proofBindings.artifactHash
  ) {
    fail('runner_terminal_correlation_mismatch');
  }
  return {
    requestId,
    terminalHash: contentHash(terminal),
    terminalSchemaVersion: terminal.schemaVersion,
    terminalStatus: terminal.status,
  };
}

function verifyExpectedContext(context, proofBindings, terminalBindings) {
  if (!exactKeys(context, EXPECTED_CONTEXT_KEYS)) fail('expected_context_shape_invalid');
  for (const [field, value] of [
    ['expected_workspace_slug', context.workspaceSlug],
    ['expected_runtime_session_id', context.runtimeSessionId],
  ]) {
    requiredString(value, field);
  }
  coldCompilerInput(context.sourceFilename, Buffer.alloc(0));
  if (!SOURCE_EDIT_ID_PATTERN.test(context.sourceEditId ?? '')) {
    fail('expected_source_edit_id_invalid');
  }
  if (!PROOF_ID_PATTERN.test(context.proofId ?? '')) fail('expected_proof_id_invalid');
  if (!SHA256_VALUE_PATTERN.test(context.artifactContentHash ?? '')) {
    fail('expected_artifact_hash_invalid');
  }
  if (!REQUEST_ID_PATTERN.test(context.requestId ?? '')) {
    fail('expected_context_request_id_invalid');
  }
  if (
    context.workspaceSlug !== proofBindings.workspaceSlug
    || context.runtimeSessionId !== proofBindings.runtimeSessionId
    || context.sourceEditId !== proofBindings.sourceEditId
    || context.proofId !== proofBindings.proofId
    || context.sourceFilename !== proofBindings.sourceFilename
    || context.artifactContentHash !== proofBindings.artifactHash
    || context.requestId !== terminalBindings.requestId
  ) {
    fail('expected_context_binding_mismatch');
  }
  return {
    expectedContextHash: contentHash(context),
    workspaceSlug: context.workspaceSlug,
    runtimeSessionId: context.runtimeSessionId,
    sourceFilename: context.sourceFilename,
  };
}

function recomputeReceiptHash(receipt) {
  const projection = { ...receipt };
  delete projection.receiptHash;
  return contentHash(projection);
}

/**
 * Recomputes the Rust cold compile proof against caller-owned bytes, a
 * correlated runner terminal, and explicit current-run expectations. The
 * result is diagnostic-only: plain JavaScript values cannot establish a
 * trusted producer or authorize GPU HMR, runtime proof, or dispatch proof.
 */
export async function verifyColdCompileLoadReceipt(proofArtifact, supplied) {
  if (!isRecord(supplied)) fail('supplied_evidence_missing');
  const requestId = supplied.requestId;
  if (!REQUEST_ID_PATTERN.test(requestId ?? '')) fail('expected_request_id_invalid');
  const requestSource = requiredUtf8Bytes(
    supplied.requestSourceBytes,
    'request_source_bytes',
  );
  if (!Array.isArray(supplied.sourceTransformOutputBytes)) {
    fail('source_transform_output_bytes_missing');
  }
  const sourceTransformOutputs = supplied.sourceTransformOutputBytes.map((value, index) => (
    requiredUtf8Bytes(value, `source_transform_output_${index}_bytes`)
  ));
  const preprocessorInput = requiredUtf8Bytes(
    supplied.preprocessorInputBytes,
    'preprocessor_input_bytes',
  );
  const compilerInput = requiredUtf8Bytes(
    supplied.compilerInputBytes,
    'compiler_input_bytes',
  );
  const compilerStderr = requiredUtf8Bytes(
    supplied.compilerStderrBytes,
    'compiler_stderr_bytes',
    { allowEmpty: true },
  );
  const artifact = requiredBytes(supplied.artifactBytes, 'artifact_bytes');
  if (!isRecord(supplied.runnerTerminal)) fail('runner_terminal_missing');
  if (!isRecord(supplied.expectedContext)) fail('expected_context_missing');

  const proofBindings = verifyProofArtifact(proofArtifact, {
    requestSource,
    sourceTransformOutputs,
    preprocessorInput,
    compilerInput,
    compilerStderr,
    artifact,
    artifactHash: sha256(artifact),
    artifactBytes: artifact.byteLength,
  });
  const terminalBindings = verifyRunnerTerminal(
    supplied.runnerTerminal,
    requestId,
    proofBindings,
  );
  const contextBindings = verifyExpectedContext(
    supplied.expectedContext,
    proofBindings,
    terminalBindings,
  );

  const receipt = {
    schemaVersion: COLD_COMPILE_LOAD_RECEIPT_SCHEMA,
    proofAuthority: COLD_COMPILE_LOAD_RECEIPT_AUTHORITY,
    proofArtifactHash: proofBindings.proofArtifactHash,
    proofArtifactTrust: 'caller_supplied_untrusted',
    proofId: proofBindings.proofId,
    workspaceSlug: contextBindings.workspaceSlug,
    runtimeSessionId: contextBindings.runtimeSessionId,
    sourceFilename: contextBindings.sourceFilename,
    expectedContextHash: contextBindings.expectedContextHash,
    expectedContextTrust: 'caller_supplied_untrusted',
    sourceEditId: proofBindings.sourceEditId,
    requestId: terminalBindings.requestId,
    selectedArtifactId: proofBindings.selectedArtifactId,
    artifactContentHash: proofBindings.artifactHash,
    requestSourceHash: proofBindings.requestSourceHash,
    requestSourceBytes: proofBindings.requestSourceBytes,
    sourceTransformBindings: proofBindings.transformBindings,
    sourceTransformBindingSetHash: contentHash(proofBindings.transformBindings),
    transformedSourceHash: proofBindings.transformedSourceHash,
    transformedSourceBytes: proofBindings.transformedSourceBytes,
    preprocessorInputHash: proofBindings.preprocessorInputHash,
    preprocessorInputBytes: proofBindings.preprocessorInputBytes,
    compilerInputHash: proofBindings.compilerInputHash,
    compilerInputBytes: proofBindings.compilerInputBytes,
    compilerStderrHash: proofBindings.compilerStderrHash,
    compilerStderrBytes: proofBindings.compilerStderrBytes,
    artifactBytes: proofBindings.artifactBytes,
    strictMetadataHash: proofBindings.strictMetadataHash,
    artifactEvidenceId: proofBindings.artifactEvidenceId,
    compilerEvidenceId: proofBindings.compilerEvidenceId,
    transportEvidenceId: proofBindings.transportEvidenceId,
    transportMetadataHash: proofBindings.transportMetadataHash,
    runnerTerminalHash: terminalBindings.terminalHash,
    runnerTerminalTrust: 'caller_supplied_untrusted',
    runnerTerminalSchemaVersion: terminalBindings.terminalSchemaVersion,
    runnerTerminalStatus: terminalBindings.terminalStatus,
    callerSuppliedBytesInternallyConsistent: true,
    preprocessorInputInternallyRecomputed: true,
    compilerEvidenceBytesInternallyConsistent: true,
    recomputedProofIdMatches: true,
    transportMetadataHashInternallyConsistent: true,
    sourceTransformChainInternallyConsistent: true,
    strictColdCompileMetadataInternallyConsistent: true,
    artifactStageLinksInternallyConsistent: true,
    runnerTerminalInternallyCorrelated: true,
    expectedCurrentContextMatched: true,
    trustedProducerObserved: false,
    diagnosticOnly: true,
    accepted: false,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  receipt.receiptHash = recomputeReceiptHash(receipt);
  return Object.freeze(receipt);
}
