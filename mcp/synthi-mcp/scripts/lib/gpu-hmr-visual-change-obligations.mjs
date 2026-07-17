import { createHash } from 'node:crypto';

export const VISUAL_CHANGE_OBLIGATIONS_SCHEMA =
  'synthi.gpu_hmr.visual_change_obligations.v1';
export const VISUAL_CHANGE_OBLIGATIONS_AUTHORITY =
  'declared_visual_change_obligations_only_not_gpu_hmr_success';
export const VISUAL_CHANGE_FULFILLMENT_SCHEMA =
  'synthi.gpu_hmr.visual_change_obligation_fulfillment.v1';
export const VISUAL_CHANGE_FULFILLMENT_AUTHORITY =
  'visual_worker_obligation_metrics_only_not_gpu_hmr_success';

export const VISUAL_CHANGE_OBLIGATION_TYPES = Object.freeze({
  roi: 'roi_delta.v1',
  tile: 'tile_delta.v1',
});

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MONOTONIC_NS_PATTERN = /^(0|[1-9][0-9]*)$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/;
const PREDICATE_METRIC_VERSION = 'pixel_delta_thresholds.v1';

const DECLARATION_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'sourceManifestHash',
  'editContractHash',
  'renderStateManifestHash',
  'deterministicVisualModeHash',
  'obligations',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'declarationHash',
]);

const FULFILLMENT_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'declarationHash',
  'sourceManifestHash',
  'editContractHash',
  'renderStateManifestHash',
  'deterministicVisualModeHash',
  'runtimeSessionHash',
  'processIdentityHash',
  'deviceIdentityHash',
  'swapchainIdentityHash',
  'captureBackendIdentityHash',
  'presentationBoundaryHash',
  'asyncVisualProofJobHash',
  'epoch',
  'dispatchId',
  'outputTargetId',
  'frameNumber',
  'dispatchTimestampMonotonicNs',
  'captureTimestampMonotonicNs',
  'beforeImageHash',
  'afterImageHash',
  'diffImageHash',
  'frameWidth',
  'frameHeight',
  'results',
  'evidenceRefs',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'bindingHash',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function exactKeys(value, keys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function fail(reason) {
  throw new Error(`visual_change_obligation_${reason}`);
}

function requireHash(value, reason) {
  if (!HASH_PATTERN.test(value ?? '')) fail(reason);
  return value;
}

function requireSafeInteger(value, reason, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(reason);
  return value;
}

function requireRatio(value, reason) {
  if (!Number.isFinite(value) || value < 0 || value > 1) fail(reason);
  return value;
}

function requireMeanAbs(value, reason) {
  if (!Number.isFinite(value) || value < 0 || value > 255) fail(reason);
  return value;
}

function requireOpaqueId(value, reason) {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) fail(reason);
  return value;
}

function requireMonotonicNs(value, reason) {
  if (typeof value !== 'string' || !MONOTONIC_NS_PATTERN.test(value)) fail(reason);
  return value;
}

function normalizePredicate(value) {
  if (!exactKeys(value, [
    'metricVersion',
    'minChangedPixelRatio',
    'minMeanAbsDelta',
    'requireDistinctRegionHashes',
  ])) {
    fail('predicate_shape_invalid');
  }
  if (value.metricVersion !== PREDICATE_METRIC_VERSION) {
    fail('predicate_metric_version_invalid');
  }
  if (value.requireDistinctRegionHashes !== true) {
    fail('predicate_distinct_hash_requirement_missing');
  }
  const minChangedPixelRatio = requireRatio(
    value.minChangedPixelRatio,
    'predicate_changed_pixel_ratio_invalid',
  );
  const minMeanAbsDelta = requireMeanAbs(
    value.minMeanAbsDelta,
    'predicate_mean_abs_delta_invalid',
  );
  if (minChangedPixelRatio <= 0 || minMeanAbsDelta <= 0) {
    fail('predicate_positive_threshold_required');
  }
  return {
    metricVersion: PREDICATE_METRIC_VERSION,
    minChangedPixelRatio,
    minMeanAbsDelta,
    requireDistinctRegionHashes: true,
  };
}

function normalizeRoiSelector(value) {
  if (!exactKeys(value, ['x', 'y', 'width', 'height'])) {
    fail('roi_selector_shape_invalid');
  }
  return {
    x: requireSafeInteger(value.x, 'roi_selector_x_invalid'),
    y: requireSafeInteger(value.y, 'roi_selector_y_invalid'),
    width: requireSafeInteger(value.width, 'roi_selector_width_invalid', 1),
    height: requireSafeInteger(value.height, 'roi_selector_height_invalid', 1),
  };
}

function normalizeIndexList(value, reason, maximumExclusive = null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000_000) fail(reason);
  const indices = value.map((item) => requireSafeInteger(item, reason));
  if (new Set(indices).size !== indices.length) fail(reason);
  indices.sort((left, right) => left - right);
  if (maximumExclusive !== null && indices.some((item) => item >= maximumExclusive)) fail(reason);
  return indices;
}

function normalizeTileSelector(value) {
  if (!exactKeys(value, [
    'frameWidth',
    'frameHeight',
    'tileWidth',
    'tileHeight',
    'tileIndices',
  ])) {
    fail('tile_selector_shape_invalid');
  }
  const frameWidth = requireSafeInteger(value.frameWidth, 'tile_selector_frame_width_invalid', 1);
  const frameHeight = requireSafeInteger(value.frameHeight, 'tile_selector_frame_height_invalid', 1);
  const tileWidth = requireSafeInteger(value.tileWidth, 'tile_selector_tile_width_invalid', 1);
  const tileHeight = requireSafeInteger(value.tileHeight, 'tile_selector_tile_height_invalid', 1);
  if (tileWidth > frameWidth || tileHeight > frameHeight) fail('tile_selector_tile_size_invalid');
  const columns = Math.ceil(frameWidth / tileWidth);
  const rows = Math.ceil(frameHeight / tileHeight);
  const tileIndices = normalizeIndexList(
    value.tileIndices,
    'tile_selector_indices_invalid',
    columns * rows,
  );
  return { frameWidth, frameHeight, tileWidth, tileHeight, tileIndices };
}

function normalizeRawObligation(value) {
  if (!exactKeys(value, ['type', 'selector', 'predicate'])) {
    fail('declaration_entry_shape_invalid');
  }
  if (!Object.values(VISUAL_CHANGE_OBLIGATION_TYPES).includes(value.type)) {
    fail('declaration_entry_type_invalid');
  }
  const selector = value.type === VISUAL_CHANGE_OBLIGATION_TYPES.roi
    ? normalizeRoiSelector(value.selector)
    : normalizeTileSelector(value.selector);
  return {
    type: value.type,
    selector,
    predicate: normalizePredicate(value.predicate),
  };
}

function normalizeDeclaredObligation(value) {
  if (!exactKeys(value, ['obligationId', 'type', 'selector', 'predicate'])) {
    fail('declaration_entry_shape_invalid');
  }
  const normalized = normalizeRawObligation({
    type: value.type,
    selector: value.selector,
    predicate: value.predicate,
  });
  const obligationId = requireHash(value.obligationId, 'declaration_entry_id_invalid');
  if (obligationId !== hashJson(normalized)) fail('declaration_entry_id_mismatch');
  return { obligationId, ...normalized };
}

function declarationProjection(value) {
  return {
    schemaVersion: value.schemaVersion,
    proofAuthority: value.proofAuthority,
    sourceManifestHash: value.sourceManifestHash,
    editContractHash: value.editContractHash,
    renderStateManifestHash: value.renderStateManifestHash,
    deterministicVisualModeHash: value.deterministicVisualModeHash,
    obligations: value.obligations,
    acceptedForGpuHmr: value.acceptedForGpuHmr,
    gpuHmrSuccess: value.gpuHmrSuccess,
    canSatisfyRuntimeProof: value.canSatisfyRuntimeProof,
    canSatisfyDispatchProof: value.canSatisfyDispatchProof,
  };
}

export function createVisualChangeObligationDeclaration(input) {
  if (!exactKeys(input, [
    'sourceManifestHash',
    'editContractHash',
    'renderStateManifestHash',
    'deterministicVisualModeHash',
    'obligations',
  ])) {
    fail('declaration_input_shape_invalid');
  }
  if (!Array.isArray(input.obligations) || input.obligations.length < 1 || input.obligations.length > 4096) {
    fail('declaration_entries_invalid');
  }
  const obligations = input.obligations.map((entry) => {
    const normalized = normalizeRawObligation(entry);
    return { obligationId: hashJson(normalized), ...normalized };
  });
  if (new Set(obligations.map((entry) => entry.obligationId)).size !== obligations.length) {
    fail('declaration_duplicate_entries');
  }
  obligations.sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  const declaration = {
    schemaVersion: VISUAL_CHANGE_OBLIGATIONS_SCHEMA,
    proofAuthority: VISUAL_CHANGE_OBLIGATIONS_AUTHORITY,
    sourceManifestHash: requireHash(input.sourceManifestHash, 'source_manifest_hash_invalid'),
    editContractHash: requireHash(input.editContractHash, 'edit_contract_hash_invalid'),
    renderStateManifestHash: requireHash(
      input.renderStateManifestHash,
      'render_state_manifest_hash_invalid',
    ),
    deterministicVisualModeHash: requireHash(
      input.deterministicVisualModeHash,
      'deterministic_visual_mode_hash_invalid',
    ),
    obligations,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  return {
    ...declaration,
    declarationHash: hashJson(declarationProjection(declaration)),
  };
}

export function verifyVisualChangeObligationDeclaration(value) {
  if (!exactKeys(value, DECLARATION_KEYS)) fail('declaration_shape_invalid');
  if (
    value.schemaVersion !== VISUAL_CHANGE_OBLIGATIONS_SCHEMA
    || value.proofAuthority !== VISUAL_CHANGE_OBLIGATIONS_AUTHORITY
  ) {
    fail('declaration_protocol_invalid');
  }
  if (
    value.acceptedForGpuHmr !== false
    || value.gpuHmrSuccess !== false
    || value.canSatisfyRuntimeProof !== false
    || value.canSatisfyDispatchProof !== false
  ) {
    fail('declaration_authority_claim_invalid');
  }
  requireHash(value.sourceManifestHash, 'source_manifest_hash_invalid');
  requireHash(value.editContractHash, 'edit_contract_hash_invalid');
  requireHash(value.renderStateManifestHash, 'render_state_manifest_hash_invalid');
  requireHash(value.deterministicVisualModeHash, 'deterministic_visual_mode_hash_invalid');
  if (!Array.isArray(value.obligations) || value.obligations.length < 1 || value.obligations.length > 4096) {
    fail('declaration_entries_invalid');
  }
  const obligations = value.obligations.map(normalizeDeclaredObligation);
  if (
    new Set(obligations.map((entry) => entry.obligationId)).size !== obligations.length
    || obligations.some((entry, index) => index > 0 && obligations[index - 1].obligationId >= entry.obligationId)
  ) {
    fail('declaration_entry_order_invalid');
  }
  requireHash(value.declarationHash, 'declaration_hash_invalid');
  if (value.declarationHash !== hashJson(declarationProjection({ ...value, obligations }))) {
    fail('declaration_hash_mismatch');
  }
  return value;
}

function normalizeRawResult(value, obligation) {
  const commonKeys = [
    'obligationId',
    'beforeRegionHash',
    'afterRegionHash',
    'diffRegionHash',
    'changedPixelRatio',
    'meanAbsDelta',
  ];
  const tile = obligation.type === VISUAL_CHANGE_OBLIGATION_TYPES.tile;
  const expectedKeys = tile ? [...commonKeys, 'changedTileIndices', 'tileListHash'] : commonKeys;
  if (!exactKeys(value, expectedKeys) || value.obligationId !== obligation.obligationId) {
    fail('fulfillment_result_shape_invalid');
  }
  const beforeRegionHash = requireHash(value.beforeRegionHash, 'fulfillment_before_region_hash_invalid');
  const afterRegionHash = requireHash(value.afterRegionHash, 'fulfillment_after_region_hash_invalid');
  const diffRegionHash = requireHash(value.diffRegionHash, 'fulfillment_diff_region_hash_invalid');
  if (beforeRegionHash === afterRegionHash) fail('fulfillment_region_hash_unchanged');
  const changedPixelRatio = requireRatio(
    value.changedPixelRatio,
    'fulfillment_changed_pixel_ratio_invalid',
  );
  const meanAbsDelta = requireMeanAbs(value.meanAbsDelta, 'fulfillment_mean_abs_delta_invalid');
  if (
    changedPixelRatio < obligation.predicate.minChangedPixelRatio
    || meanAbsDelta < obligation.predicate.minMeanAbsDelta
  ) {
    fail('fulfillment_predicate_not_satisfied');
  }
  const normalized = {
    obligationId: obligation.obligationId,
    beforeRegionHash,
    afterRegionHash,
    diffRegionHash,
    changedPixelRatio,
    meanAbsDelta,
  };
  if (!tile) return normalized;
  const changedTileIndices = normalizeIndexList(
    value.changedTileIndices,
    'fulfillment_changed_tile_indices_invalid',
  );
  if (changedTileIndices.some((index) => !obligation.selector.tileIndices.includes(index))) {
    fail('fulfillment_changed_tile_outside_selector');
  }
  const tileListHash = requireHash(value.tileListHash, 'fulfillment_tile_list_hash_invalid');
  if (tileListHash !== hashJson(changedTileIndices)) fail('fulfillment_tile_list_hash_mismatch');
  return { ...normalized, changedTileIndices, tileListHash };
}

function resultBindingPayload(context, obligation, result) {
  return {
    declarationHash: context.declarationHash,
    sourceManifestHash: context.sourceManifestHash,
    editContractHash: context.editContractHash,
    renderStateManifestHash: context.renderStateManifestHash,
    deterministicVisualModeHash: context.deterministicVisualModeHash,
    runtimeSessionHash: context.runtimeSessionHash,
    processIdentityHash: context.processIdentityHash,
    deviceIdentityHash: context.deviceIdentityHash,
    swapchainIdentityHash: context.swapchainIdentityHash,
    captureBackendIdentityHash: context.captureBackendIdentityHash,
    presentationBoundaryHash: context.presentationBoundaryHash,
    asyncVisualProofJobHash: context.asyncVisualProofJobHash,
    epoch: context.epoch,
    dispatchId: context.dispatchId,
    outputTargetId: context.outputTargetId,
    frameNumber: context.frameNumber,
    dispatchTimestampMonotonicNs: context.dispatchTimestampMonotonicNs,
    captureTimestampMonotonicNs: context.captureTimestampMonotonicNs,
    beforeImageHash: context.beforeImageHash,
    afterImageHash: context.afterImageHash,
    diffImageHash: context.diffImageHash,
    frameWidth: context.frameWidth,
    frameHeight: context.frameHeight,
    obligation,
    result,
  };
}

function resultEvidenceRefs(context, result, resultBindingHash) {
  return [...new Set([
    context.declarationHash,
    context.sourceManifestHash,
    context.editContractHash,
    context.renderStateManifestHash,
    context.deterministicVisualModeHash,
    context.runtimeSessionHash,
    context.processIdentityHash,
    context.deviceIdentityHash,
    context.swapchainIdentityHash,
    context.captureBackendIdentityHash,
    context.presentationBoundaryHash,
    context.asyncVisualProofJobHash,
    context.beforeImageHash,
    context.afterImageHash,
    context.diffImageHash,
    result.obligationId,
    result.beforeRegionHash,
    result.afterRegionHash,
    result.diffRegionHash,
    result.tileListHash,
    resultBindingHash,
  ].filter(Boolean))].sort();
}

function normalizeFulfillmentContext(input, declaration) {
  const context = {
    declarationHash: declaration.declarationHash,
    sourceManifestHash: requireHash(input.sourceManifestHash, 'fulfillment_source_manifest_hash_invalid'),
    editContractHash: requireHash(input.editContractHash, 'fulfillment_edit_contract_hash_invalid'),
    renderStateManifestHash: requireHash(
      input.renderStateManifestHash,
      'fulfillment_render_state_manifest_hash_invalid',
    ),
    deterministicVisualModeHash: requireHash(
      input.deterministicVisualModeHash,
      'fulfillment_deterministic_visual_mode_hash_invalid',
    ),
    runtimeSessionHash: requireHash(input.runtimeSessionHash, 'fulfillment_runtime_session_hash_invalid'),
    processIdentityHash: requireHash(input.processIdentityHash, 'fulfillment_process_identity_hash_invalid'),
    deviceIdentityHash: requireHash(input.deviceIdentityHash, 'fulfillment_device_identity_hash_invalid'),
    swapchainIdentityHash: requireHash(
      input.swapchainIdentityHash,
      'fulfillment_swapchain_identity_hash_invalid',
    ),
    captureBackendIdentityHash: requireHash(
      input.captureBackendIdentityHash,
      'fulfillment_capture_backend_identity_hash_invalid',
    ),
    presentationBoundaryHash: requireHash(
      input.presentationBoundaryHash,
      'fulfillment_presentation_boundary_hash_invalid',
    ),
    asyncVisualProofJobHash: requireHash(
      input.asyncVisualProofJobHash,
      'fulfillment_async_visual_job_hash_invalid',
    ),
    epoch: requireSafeInteger(input.epoch, 'fulfillment_epoch_invalid', 1),
    dispatchId: requireOpaqueId(input.dispatchId, 'fulfillment_dispatch_id_invalid'),
    outputTargetId: requireOpaqueId(input.outputTargetId, 'fulfillment_output_target_id_invalid'),
    frameNumber: requireSafeInteger(input.frameNumber, 'fulfillment_frame_number_invalid'),
    dispatchTimestampMonotonicNs: requireMonotonicNs(
      input.dispatchTimestampMonotonicNs,
      'fulfillment_dispatch_timestamp_invalid',
    ),
    captureTimestampMonotonicNs: requireMonotonicNs(
      input.captureTimestampMonotonicNs,
      'fulfillment_capture_timestamp_invalid',
    ),
    beforeImageHash: requireHash(input.beforeImageHash, 'fulfillment_before_image_hash_invalid'),
    afterImageHash: requireHash(input.afterImageHash, 'fulfillment_after_image_hash_invalid'),
    diffImageHash: requireHash(input.diffImageHash, 'fulfillment_diff_image_hash_invalid'),
    frameWidth: requireSafeInteger(input.frameWidth, 'fulfillment_frame_width_invalid', 1),
    frameHeight: requireSafeInteger(input.frameHeight, 'fulfillment_frame_height_invalid', 1),
  };
  if (
    context.sourceManifestHash !== declaration.sourceManifestHash
    || context.editContractHash !== declaration.editContractHash
    || context.renderStateManifestHash !== declaration.renderStateManifestHash
    || context.deterministicVisualModeHash !== declaration.deterministicVisualModeHash
  ) {
    fail('fulfillment_declaration_identity_mismatch');
  }
  if (context.beforeImageHash === context.afterImageHash) fail('fulfillment_image_hash_unchanged');
  if (BigInt(context.captureTimestampMonotonicNs) <= BigInt(context.dispatchTimestampMonotonicNs)) {
    fail('fulfillment_capture_not_after_dispatch');
  }
  for (const obligation of declaration.obligations) {
    if (obligation.type === VISUAL_CHANGE_OBLIGATION_TYPES.roi) {
      const { x, y, width, height } = obligation.selector;
      if (x + width > context.frameWidth || y + height > context.frameHeight) {
        fail('fulfillment_roi_out_of_bounds');
      }
    } else if (
      obligation.selector.frameWidth !== context.frameWidth
      || obligation.selector.frameHeight !== context.frameHeight
    ) {
      fail('fulfillment_tile_frame_mismatch');
    }
  }
  return context;
}

function fulfillmentProjection(value) {
  const projection = { ...value };
  delete projection.bindingHash;
  return projection;
}

export function createVisualChangeObligationFulfillment(input) {
  if (!exactKeys(input, [
    'declaration',
    'sourceManifestHash',
    'editContractHash',
    'renderStateManifestHash',
    'deterministicVisualModeHash',
    'runtimeSessionHash',
    'processIdentityHash',
    'deviceIdentityHash',
    'swapchainIdentityHash',
    'captureBackendIdentityHash',
    'presentationBoundaryHash',
    'asyncVisualProofJobHash',
    'epoch',
    'dispatchId',
    'outputTargetId',
    'frameNumber',
    'dispatchTimestampMonotonicNs',
    'captureTimestampMonotonicNs',
    'beforeImageHash',
    'afterImageHash',
    'diffImageHash',
    'frameWidth',
    'frameHeight',
    'results',
  ])) {
    fail('fulfillment_input_shape_invalid');
  }
  const declaration = verifyVisualChangeObligationDeclaration(input.declaration);
  const context = normalizeFulfillmentContext(input, declaration);
  if (!Array.isArray(input.results) || input.results.length !== declaration.obligations.length) {
    fail('fulfillment_result_count_mismatch');
  }
  const suppliedById = new Map(input.results.map((result) => [result?.obligationId, result]));
  if (suppliedById.size !== input.results.length) fail('fulfillment_duplicate_results');
  const results = declaration.obligations.map((obligation) => {
    const result = normalizeRawResult(suppliedById.get(obligation.obligationId), obligation);
    const resultBindingHash = hashJson(resultBindingPayload(context, obligation, result));
    return {
      ...result,
      resultBindingHash,
      evidenceRefs: resultEvidenceRefs(context, result, resultBindingHash),
    };
  });
  const evidenceRefs = [...new Set(results.flatMap((result) => result.evidenceRefs))].sort();
  const fulfillment = {
    schemaVersion: VISUAL_CHANGE_FULFILLMENT_SCHEMA,
    proofAuthority: VISUAL_CHANGE_FULFILLMENT_AUTHORITY,
    ...context,
    results,
    evidenceRefs,
    acceptedAsSupportEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  return { ...fulfillment, bindingHash: hashJson(fulfillmentProjection(fulfillment)) };
}

function verifyEmittedResult(value, context, obligation) {
  const rawKeys = [
    'obligationId',
    'beforeRegionHash',
    'afterRegionHash',
    'diffRegionHash',
    'changedPixelRatio',
    'meanAbsDelta',
  ];
  const tile = obligation.type === VISUAL_CHANGE_OBLIGATION_TYPES.tile;
  const emittedKeys = tile
    ? [...rawKeys, 'changedTileIndices', 'tileListHash', 'resultBindingHash', 'evidenceRefs']
    : [...rawKeys, 'resultBindingHash', 'evidenceRefs'];
  if (!exactKeys(value, emittedKeys)) fail('fulfillment_emitted_result_shape_invalid');
  const raw = Object.fromEntries(rawKeys.map((key) => [key, value[key]]));
  if (tile) {
    raw.changedTileIndices = value.changedTileIndices;
    raw.tileListHash = value.tileListHash;
  }
  const normalized = normalizeRawResult(raw, obligation);
  const resultBindingHash = requireHash(
    value.resultBindingHash,
    'fulfillment_result_binding_hash_invalid',
  );
  if (resultBindingHash !== hashJson(resultBindingPayload(context, obligation, normalized))) {
    fail('fulfillment_result_binding_hash_mismatch');
  }
  const expectedRefs = resultEvidenceRefs(context, normalized, resultBindingHash);
  if (stableJson(value.evidenceRefs) !== stableJson(expectedRefs)) {
    fail('fulfillment_result_evidence_refs_mismatch');
  }
  return value;
}

export function verifyVisualChangeObligationFulfillment(value, declaration) {
  const verifiedDeclaration = verifyVisualChangeObligationDeclaration(declaration);
  if (!exactKeys(value, FULFILLMENT_KEYS)) fail('fulfillment_shape_invalid');
  if (
    value.schemaVersion !== VISUAL_CHANGE_FULFILLMENT_SCHEMA
    || value.proofAuthority !== VISUAL_CHANGE_FULFILLMENT_AUTHORITY
    || value.declarationHash !== verifiedDeclaration.declarationHash
  ) {
    fail('fulfillment_protocol_invalid');
  }
  if (
    value.acceptedAsSupportEvidence !== true
    || value.acceptedForGpuHmr !== false
    || value.gpuHmrSuccess !== false
    || value.canSatisfyRuntimeProof !== false
    || value.canSatisfyDispatchProof !== false
  ) {
    fail('fulfillment_authority_claim_invalid');
  }
  const context = normalizeFulfillmentContext(value, verifiedDeclaration);
  if (!Array.isArray(value.results) || value.results.length !== verifiedDeclaration.obligations.length) {
    fail('fulfillment_result_count_mismatch');
  }
  for (let index = 0; index < value.results.length; index += 1) {
    const obligation = verifiedDeclaration.obligations[index];
    if (value.results[index]?.obligationId !== obligation.obligationId) {
      fail('fulfillment_result_order_invalid');
    }
    verifyEmittedResult(value.results[index], context, obligation);
  }
  const expectedRefs = [...new Set(value.results.flatMap((result) => result.evidenceRefs))].sort();
  if (stableJson(value.evidenceRefs) !== stableJson(expectedRefs)) {
    fail('fulfillment_evidence_refs_mismatch');
  }
  requireHash(value.bindingHash, 'fulfillment_binding_hash_invalid');
  if (value.bindingHash !== hashJson(fulfillmentProjection(value))) {
    fail('fulfillment_binding_hash_mismatch');
  }
  return value;
}
