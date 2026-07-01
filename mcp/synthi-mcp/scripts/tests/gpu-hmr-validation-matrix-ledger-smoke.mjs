#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  buildGpuHmrValidationMatrixLedger,
  collectGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
  coldRuntimeBoundaryEventManifestTemplateFacet,
  queryGpuHmrValidationMatrixLedger,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';
import {
  assessGeneratedGpuSplitGranularity,
  verifyGeneratedGpuSplitDeterministicFission,
  GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
} from '../lib/gpu-hmr-generated-split-granularity.mjs';
import {
  bindGpuHmrRunModeCoverageSupport,
  buildGpuHmrProofLedger,
  buildGpuHmrRunModeCoverageSupport,
  evaluateGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from '../lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
} from '../lib/gpu-hmr-acceptance-contract.mjs';
import {
  evaluateGpuHmrDeterministicVisualMode,
  GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
} from '../lib/gpu-hmr-visual-evidence.mjs';
import {
  writeArtifactToCas,
} from '../lib/gpu-hmr-artifact-cas.mjs';
import {
  buildValidationRuntimeProofArtifact,
  computeOracleArtifactsFromFiles,
} from '../lib/gpu-hmr-validation-proof-artifact.mjs';
import {
  buildGpuHmrValidationProofSummary,
} from '../lib/gpu-hmr-validation-proof-summary.mjs';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePng(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, PNG_HEADER);
}

async function writeRgbaPng(filePath, width, height, pixelAt) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixelAt(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256BufferHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function hashValue(label) {
  return `sha256:${sha256Hex(label)}`;
}

function contentHashFor(value) {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

const COLD_RUNTIME_BOUNDARY_TEMPLATE_AUTHORITY =
  'runtime_boundary_event_manifest_template_only_not_gpu_hmr_success';
const COLD_RUNTIME_BOUNDARY_TEMPLATE_KINDS = [
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
];

function hashedColdRuntimeBoundaryEventTemplate(kind, requiredFields) {
  const template = {
    schemaVersion: 'synthi.gpu_hmr.runtime_boundary_event.v1',
    schema_version: 'synthi.gpu_hmr.runtime_boundary_event.v1',
    eventKind: kind,
    event_kind: kind,
    requiredFields,
    required_fields: requiredFields,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
  return {
    ...template,
    templateHash: contentHashFor(template),
    template_hash: contentHashFor(template),
  };
}

function hashedColdRuntimeBoundaryTemplateFacet(overrides = {}) {
  const eventObjectTemplates = [
    hashedColdRuntimeBoundaryEventTemplate('artifact_transport', [
      'runtime_session',
      'process_id',
      'artifact_hash',
    ]),
    hashedColdRuntimeBoundaryEventTemplate('epoch_publication', [
      'runtime_session',
      'process_id',
      'epoch',
    ]),
    hashedColdRuntimeBoundaryEventTemplate('dispatch_trace', [
      'runtime_session',
      'process_id',
      'dispatch_id',
    ]),
    hashedColdRuntimeBoundaryEventTemplate('host_identity', [
      'runtime_session',
      'process_id',
      'device_uuid',
    ]),
    hashedColdRuntimeBoundaryEventTemplate('output_oracle', [
      'runtime_session',
      'process_id',
      'after_dispatch_id',
    ]),
  ];
  const seed = {
    schemaVersion: 'synthi.gpu_hmr.cold_runtime_boundary_event_manifest_template.v1',
    schema_version: 'synthi.gpu_hmr.cold_runtime_boundary_event_manifest_template.v1',
    proofAuthority: COLD_RUNTIME_BOUNDARY_TEMPLATE_AUTHORITY,
    proof_authority: COLD_RUNTIME_BOUNDARY_TEMPLATE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    acceptedAsRuntimeBoundaryEventManifestTemplate: true,
    accepted_as_runtime_boundary_event_manifest_template: true,
    requiredEventKinds: COLD_RUNTIME_BOUNDARY_TEMPLATE_KINDS,
    required_event_kinds: COLD_RUNTIME_BOUNDARY_TEMPLATE_KINDS,
    eventObjectTemplates,
    event_object_templates: eventObjectTemplates,
    manifestTemplate: {
      schemaVersion: 'synthi.gpu_hmr.runtime_boundary_event_manifest.v1',
      schema_version: 'synthi.gpu_hmr.runtime_boundary_event_manifest.v1',
      proofAuthority: COLD_RUNTIME_BOUNDARY_TEMPLATE_AUTHORITY,
      proof_authority: COLD_RUNTIME_BOUNDARY_TEMPLATE_AUTHORITY,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      requiresObservedRuntimeEvents: true,
      requires_observed_runtime_events: true,
      eventObjectTemplates,
      event_object_templates: eventObjectTemplates,
    },
    manifest_template: {
      schemaVersion: 'synthi.gpu_hmr.runtime_boundary_event_manifest.v1',
      schema_version: 'synthi.gpu_hmr.runtime_boundary_event_manifest.v1',
      proofAuthority: COLD_RUNTIME_BOUNDARY_TEMPLATE_AUTHORITY,
      proof_authority: COLD_RUNTIME_BOUNDARY_TEMPLATE_AUTHORITY,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      requiresObservedRuntimeEvents: true,
      requires_observed_runtime_events: true,
      eventObjectTemplates,
      event_object_templates: eventObjectTemplates,
    },
    blockingGaps: [],
    blocking_gaps: [],
    ...overrides,
  };
  return {
    ...seed,
    templateHash: contentHashFor(seed),
    template_hash: contentHashFor(seed),
  };
}

function rehashColdRuntimeBoundaryTemplateFacet(value) {
  const seed = JSON.parse(JSON.stringify(value));
  delete seed.templateHash;
  delete seed.template_hash;
  return {
    ...seed,
    templateHash: contentHashFor(seed),
    template_hash: contentHashFor(seed),
  };
}

const acceptedColdRuntimeBoundaryTemplate =
  coldRuntimeBoundaryEventManifestTemplateFacet(hashedColdRuntimeBoundaryTemplateFacet());
assert.equal(acceptedColdRuntimeBoundaryTemplate.validated, true);
assert.equal(acceptedColdRuntimeBoundaryTemplate.acceptedAsSupportEvidence, true);
assert.equal(acceptedColdRuntimeBoundaryTemplate.acceptedForGpuHmr, false);
assert.equal(acceptedColdRuntimeBoundaryTemplate.gpuHmrSuccess, false);
assert.equal(acceptedColdRuntimeBoundaryTemplate.canSatisfyRuntimeProof, false);
assert.equal(acceptedColdRuntimeBoundaryTemplate.eventTemplateCount, 5);
assert.deepEqual(acceptedColdRuntimeBoundaryTemplate.missingRequiredEventKinds, []);
assert.deepEqual(acceptedColdRuntimeBoundaryTemplate.failedGates, []);

const sourceDerivedOracleTemplate =
  coldRuntimeBoundaryEventManifestTemplateFacet(hashedColdRuntimeBoundaryTemplateFacet({
    acceptableOracleKinds: ['compute_readback'],
    acceptable_oracle_kinds: ['compute_readback'],
    sourceDerivedOracleKinds: ['compute_readback'],
    source_derived_oracle_kinds: ['compute_readback'],
    candidateDeclaredOracleKinds: ['deterministic_visual_oracle'],
    candidate_declared_oracle_kinds: ['deterministic_visual_oracle'],
    candidateOracleHintsUsedForAcceptance: false,
    candidate_oracle_hints_used_for_acceptance: false,
    candidateOracleHintAuthority:
      'candidate_oracle_hints_diagnostic_only_not_oracle_contract',
    candidate_oracle_hint_authority:
      'candidate_oracle_hints_diagnostic_only_not_oracle_contract',
  }));
assert.equal(sourceDerivedOracleTemplate.validated, true);
assert.equal(sourceDerivedOracleTemplate.acceptedAsSupportEvidence, true);
assert.deepEqual(sourceDerivedOracleTemplate.nonSourceDerivedAcceptableOracleKinds, []);

const forgedOracleHintTemplate =
  coldRuntimeBoundaryEventManifestTemplateFacet(hashedColdRuntimeBoundaryTemplateFacet({
    acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
    acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
    sourceDerivedOracleKinds: ['compute_readback'],
    source_derived_oracle_kinds: ['compute_readback'],
    candidateDeclaredOracleKinds: ['deterministic_visual_oracle'],
    candidate_declared_oracle_kinds: ['deterministic_visual_oracle'],
    candidateOracleHintsUsedForAcceptance: true,
    candidate_oracle_hints_used_for_acceptance: true,
    candidateOracleHintClaimsAcceptance: true,
    candidate_oracle_hint_claims_acceptance: true,
    candidateOracleHintAuthority:
      'declared_oracle_hint_runtime_authority_forged',
    candidate_oracle_hint_authority:
      'declared_oracle_hint_runtime_authority_forged',
  }));
assert.equal(forgedOracleHintTemplate.validated, false);
assert.equal(forgedOracleHintTemplate.acceptedAsSupportEvidence, false);
assert.ok(
  forgedOracleHintTemplate.failedGates.includes(
    'cold_runtime_boundary_event_manifest_template_candidate_oracle_hints_used_for_acceptance',
  ),
);
assert.ok(
  forgedOracleHintTemplate.failedGates.includes(
    'cold_runtime_boundary_event_manifest_template_candidate_oracle_hint_claimed_acceptance',
  ),
);
assert.ok(
  forgedOracleHintTemplate.failedGates.includes(
    'cold_runtime_boundary_event_manifest_template_oracle_kind_not_source_derived:deterministic_visual_oracle',
  ),
);

const forgedColdRuntimeBoundarySuccess =
  coldRuntimeBoundaryEventManifestTemplateFacet(hashedColdRuntimeBoundaryTemplateFacet({
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
  }));
assert.equal(forgedColdRuntimeBoundarySuccess.validated, false);
assert.equal(forgedColdRuntimeBoundarySuccess.acceptedAsSupportEvidence, false);
assert.ok(
  forgedColdRuntimeBoundarySuccess.failedGates
    .includes('cold_runtime_boundary_event_manifest_template_claimed_gpu_hmr_success'),
);

const populatedRuntimeEventsTemplateSeed = hashedColdRuntimeBoundaryTemplateFacet();
populatedRuntimeEventsTemplateSeed.manifestTemplate = {
  ...populatedRuntimeEventsTemplateSeed.manifestTemplate,
  runtimeBoundaryEvents: [
    {
      schemaVersion: 'synthi.gpu_hmr.runtime_boundary_event.v1',
      eventKind: 'dispatch_trace',
      dispatch_id: 'dispatch-forged',
    },
  ],
};
populatedRuntimeEventsTemplateSeed.manifest_template =
  populatedRuntimeEventsTemplateSeed.manifestTemplate;
const populatedRuntimeEventsTemplate = coldRuntimeBoundaryEventManifestTemplateFacet(
  rehashColdRuntimeBoundaryTemplateFacet(populatedRuntimeEventsTemplateSeed),
);
assert.equal(populatedRuntimeEventsTemplate.validated, false);
assert.ok(
  populatedRuntimeEventsTemplate.failedGates
    .includes('cold_runtime_boundary_event_manifest_template_contains_runtime_events'),
);

const missingOutputOracleTemplateSeed = hashedColdRuntimeBoundaryTemplateFacet();
missingOutputOracleTemplateSeed.requiredEventKinds =
  missingOutputOracleTemplateSeed.requiredEventKinds
    .filter((kind) => kind !== 'output_oracle');
missingOutputOracleTemplateSeed.required_event_kinds =
  missingOutputOracleTemplateSeed.requiredEventKinds;
missingOutputOracleTemplateSeed.eventObjectTemplates =
  missingOutputOracleTemplateSeed.eventObjectTemplates
    .filter((entry) => entry.eventKind !== 'output_oracle');
missingOutputOracleTemplateSeed.event_object_templates =
  missingOutputOracleTemplateSeed.eventObjectTemplates;
missingOutputOracleTemplateSeed.manifestTemplate.eventObjectTemplates =
  missingOutputOracleTemplateSeed.eventObjectTemplates;
missingOutputOracleTemplateSeed.manifestTemplate.event_object_templates =
  missingOutputOracleTemplateSeed.eventObjectTemplates;
missingOutputOracleTemplateSeed.manifest_template =
  missingOutputOracleTemplateSeed.manifestTemplate;
const missingOutputOracleTemplate = coldRuntimeBoundaryEventManifestTemplateFacet(
  rehashColdRuntimeBoundaryTemplateFacet(missingOutputOracleTemplateSeed),
);
assert.equal(missingOutputOracleTemplate.validated, false);
assert.ok(
  missingOutputOracleTemplate.failedGates
    .includes('cold_runtime_boundary_event_manifest_template_output_oracle_missing'),
);

const badEventHashTemplateSeed = hashedColdRuntimeBoundaryTemplateFacet();
badEventHashTemplateSeed.eventObjectTemplates[0].templateHash =
  hashValue('forged-cold-runtime-boundary-event-template');
badEventHashTemplateSeed.eventObjectTemplates[0].template_hash =
  badEventHashTemplateSeed.eventObjectTemplates[0].templateHash;
badEventHashTemplateSeed.event_object_templates =
  badEventHashTemplateSeed.eventObjectTemplates;
badEventHashTemplateSeed.manifestTemplate.eventObjectTemplates =
  badEventHashTemplateSeed.eventObjectTemplates;
badEventHashTemplateSeed.manifestTemplate.event_object_templates =
  badEventHashTemplateSeed.eventObjectTemplates;
badEventHashTemplateSeed.manifest_template =
  badEventHashTemplateSeed.manifestTemplate;
const badEventHashTemplate = coldRuntimeBoundaryEventManifestTemplateFacet(
  rehashColdRuntimeBoundaryTemplateFacet(badEventHashTemplateSeed),
);
assert.equal(badEventHashTemplate.validated, false);
assert.ok(
  badEventHashTemplate.failedGates
    .includes('cold_runtime_boundary_event_template_hash_mismatch:artifact_transport'),
);

const badTopHashTemplate = {
  ...hashedColdRuntimeBoundaryTemplateFacet(),
  templateHash: hashValue('forged-cold-runtime-boundary-template'),
  template_hash: hashValue('forged-cold-runtime-boundary-template'),
};
const badTopHashFacet = coldRuntimeBoundaryEventManifestTemplateFacet(badTopHashTemplate);
assert.equal(badTopHashFacet.validated, false);
assert.ok(
  badTopHashFacet.failedGates
    .includes('cold_runtime_boundary_event_manifest_template_hash_mismatch'),
);

function selectedIslandIdFor(selectedPath, selectedKernel) {
  return `kernel:${selectedKernel}:${sha256Hex(selectedPath).slice(0, 16)}`;
}

function typedFissionEvidence(category, evidenceType, subject, payload = {}) {
  const contentHash = contentHashFor({
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    subject,
    payload,
  });
  return {
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    evidenceRefs: [
      `evidence:generated-split-fission:${category}:sha256:${sha256Hex(stableJson({
        category,
        evidenceType,
        contentHash,
        subject,
      }))}`,
    ],
    contentHash,
    subject,
    payload,
  };
}

function deterministicFissionEvidenceFor({ selectedPath, selectedKernel, selectedIslandId }) {
  const subject = {
    selectedPath,
    sourcePaths: [selectedPath],
    selectedIslandId,
    targetSymbols: [selectedKernel],
  };
  return [
    typedFissionEvidence('selected_island_binding', 'selected_island_binding', subject),
    typedFissionEvidence('source_mapping', 'source_mapping', subject),
    typedFissionEvidence('include_closure', 'include_closure', subject),
    typedFissionEvidence('symbol_ownership', 'symbol_ownership', subject),
    typedFissionEvidence('dependency_closure', 'dependency_closure', subject),
    typedFissionEvidence('abi_membrane', 'abi_membrane', subject),
    typedFissionEvidence('compile_recipe', 'compile_proof', subject),
    typedFissionEvidence('loader_capability', 'loader_runtime_proof', subject),
    typedFissionEvidence('output_oracle', 'output_oracle_proof', subject),
  ];
}

function hashBuffer(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fileHashForPath(filePath) {
  return hashBuffer(fsSync.readFileSync(filePath));
}

function pngDimensionsForPath(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return null;
  const bytes = fsSync.readFileSync(filePath);
  if (bytes.length < 24 || !bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function visualArtifactSet({ before, after, diff, diagnosticScreenshot } = {}, extra = {}) {
  const dimensions = extra.swapchain_size
    ?? extra.swapchainSize
    ?? pngDimensionsForPath(after)
    ?? pngDimensionsForPath(before)
    ?? pngDimensionsForPath(diff);
  return {
    ...(before
      ? {
          beforeImage: before,
          beforeImageHash: fileHashForPath(before),
        }
      : {}),
    ...(after
      ? {
          afterImage: after,
          afterImageHash: fileHashForPath(after),
        }
      : {}),
    ...(diff
      ? {
          diffImage: diff,
          diffImageHash: fileHashForPath(diff),
        }
      : {}),
    ...(diagnosticScreenshot
      ? {
          diagnosticScreenshot,
          diagnosticScreenshotHash: fileHashForPath(diagnosticScreenshot),
        }
      : {}),
    ...(dimensions ? { swapchain_size: dimensions, swapchainSize: dimensions } : {}),
    ...extra,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function casLocatorForVisualArtifact({ filePath, hash, role, sessionNamespace = 'smoke-visual-cas' }) {
  const locator = await writeArtifactToCas(await fs.readFile(filePath), {
    artifactRoot: casRoot,
    mediaType: 'image/png',
    artifactKind: 'visual_frame',
    role,
    sessionNamespace,
    producer: {
      name: 'validation_matrix_smoke_fixture',
      kind: 'visual_proof_worker',
    },
    producerSubsystem: 'agent_split_visual_proof',
    transportKind: 'cas_shared_volume',
  });
  assert.equal(locator.contentHash, hash);
  return locator;
}

async function visualArtifactSetWithCas({ before, after, diff }, extra = {}) {
  const base = visualArtifactSet({ before, after, diff }, extra);
  const artifactCasLocators = [
    before
      ? await casLocatorForVisualArtifact({
          filePath: before,
          hash: base.beforeImageHash,
          role: 'before_frame',
        })
      : null,
    after
      ? await casLocatorForVisualArtifact({
          filePath: after,
          hash: base.afterImageHash,
          role: 'after_frame',
        })
      : null,
    diff
      ? await casLocatorForVisualArtifact({
          filePath: diff,
          hash: base.diffImageHash,
          role: 'diff_frame',
        })
      : null,
  ].filter(Boolean);
  return {
    ...base,
    artifactCasLocators,
    visualArtifactTransportEvidence: {
      schemaVersion: 'synthi.gpu_hmr.visual_artifact_transport_evidence.v1',
      accepted: true,
      acceptedAsTransportEvidence: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      proofAuthority: 'transport_integrity_only_not_visual_or_ledger_proof',
      locatorCount: artifactCasLocators.length,
      entries: artifactCasLocators.map((locator) => ({
        schemaVersion: 'synthi.gpu_hmr.artifact_transport_evidence.v1',
        accepted: true,
        acceptedAsTransportEvidence: true,
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        proofAuthority: 'transport_integrity_only',
        contentHash: locator.contentHash,
        artifactId: locator.artifactId,
        artifactUri: locator.artifactUri,
        transportKind: locator.transport.kind,
        manifestHash: locator.manifestHash,
        reasons: [],
        gaps: [],
      })),
      reasons: [],
      gaps: [],
    },
  };
}

function visualArtifactSetWithoutLocalPaths(artifacts) {
  const copy = cloneJson(artifacts);
  for (const key of [
    'beforeImage',
    'before_image',
    'afterImage',
    'after_image',
    'diffImage',
    'diff_image',
    'baselineImage',
    'baseline_image',
    'changedImage',
    'changed_image',
  ]) {
    delete copy[key];
  }
  return copy;
}

function forgedVisualArtifactCasOnlySet(artifacts) {
  const copy = visualArtifactSetWithoutLocalPaths(artifacts);
  const locators = copy.artifactCasLocators ?? copy.artifact_cas_locators ?? [];
  if (locators[0]?.storage) {
    const digest = String(locators[0].contentHash ?? '').replace(/^sha256:/, '');
    locators[0].storage.relativePath = `sha256/ff/${digest}`;
    locators[0].storage.relative_path = `sha256/ff/${digest}`;
  }
  copy.artifactCasLocators = locators;
  copy.artifact_cas_locators = locators;
  return copy;
}

function forgedNonVisualCasVisualTransportSet(artifacts, locator) {
  const copy = cloneJson(artifacts);
  copy.artifactCasLocators = [locator];
  copy.artifact_cas_locators = [locator];
  copy.visualArtifactTransportEvidence = {
    schemaVersion: 'synthi.gpu_hmr.visual_artifact_transport_evidence.v1',
    accepted: true,
    acceptedAsTransportEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'transport_integrity_only_not_visual_or_ledger_proof',
    locatorCount: 1,
    entries: [{
      schemaVersion: 'synthi.gpu_hmr.artifact_transport_evidence.v1',
      accepted: true,
      acceptedAsTransportEvidence: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      proofAuthority: 'transport_integrity_only',
      contentHash: locator.contentHash,
      artifactId: locator.artifactId,
      artifactUri: locator.artifactUri,
      transportKind: locator.transport?.kind,
      manifestHash: locator.manifestHash,
      reasons: [],
      gaps: [],
    }],
    reasons: [],
    gaps: [],
  };
  copy.visual_artifact_transport_evidence = copy.visualArtifactTransportEvidence;
  return copy;
}

function forgedAsyncVisualProofJobForVisualArtifacts(artifacts, targetId) {
  const locators = artifacts.artifactCasLocators ?? artifacts.artifact_cas_locators ?? [];
  return {
    schemaVersion: 'synthi.gpu_hmr.async_visual_proof_job.v1',
    schema_version: 'synthi.gpu_hmr.async_visual_proof_job.v1',
    eventType: 'proof_pending',
    event_type: 'proof_pending',
    proofPending: true,
    proof_pending: true,
    proofReady: false,
    proof_ready: false,
    accepted: false,
    acceptedAsAsyncVisualProofJob: true,
    accepted_as_async_visual_proof_job: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: 'async_visual_job_manifest_only_not_gpu_hmr_acceptance',
    proof_authority: 'async_visual_job_manifest_only_not_gpu_hmr_acceptance',
    createdAtMs: 1782380000000,
    created_at_ms: 1782380000000,
    sessionNamespace: targetId,
    session_namespace: targetId,
    producer: {
      name: 'validation_matrix_smoke_fixture',
      kind: 'visual_proof_worker',
    },
    producerSubsystem: 'agent_split_visual_proof',
    producer_subsystem: 'agent_split_visual_proof',
    artifactDir: visualDir,
    artifact_dir: visualDir,
    casRoot,
    cas_root: casRoot,
    request: {
      before: { casManifest: locators.find((locator) => locator.role === 'before_frame') },
      after: { casManifest: locators.find((locator) => locator.role === 'after_frame') },
      tileHashing: true,
      tileSize: 4,
    },
    workerOptions: {
      allowedRoots: [casRoot],
      allowedOutputRoots: [visualDir],
      timeoutMs: 30000,
    },
    worker_options: {
      allowedRoots: [casRoot],
      allowedOutputRoots: [visualDir],
      timeoutMs: 30000,
    },
    artifactCasLocators: locators,
    artifact_cas_locators: locators,
    visualArtifactTransportEvidence: artifacts.visualArtifactTransportEvidence,
    visual_artifact_transport_evidence: artifacts.visualArtifactTransportEvidence,
    jobHash: hashValue(`${targetId}:forged-job-hash`),
    job_hash: hashValue(`${targetId}:forged-job-hash`),
    jobManifestHash: hashValue(`${targetId}:forged-job-manifest-hash`),
    job_manifest_hash: hashValue(`${targetId}:forged-job-manifest-hash`),
  };
}

function modelProvenance(requestMode, requestedModel) {
  return {
    provider: 'google_gemini',
    requested_model: requestedModel,
    provider_model_status: 'available',
    provider_model_alias_resolved_to: requestedModel,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: '2026-06-09T00:00:00.000Z',
    model_availability_source: 'provider_model_registry',
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 1,
    actual_model: requestedModel,
    fallback_model: 'not_used',
    fallback_used: false,
    request_mode: requestMode,
    hard_infra_failure: false,
  };
}

function timingFields(scope) {
  return {
    static_discovery_time: 1,
    ai_contract_synthesis_time: 1,
    model_availability_check_time: 1,
    artifact_hash_time: 1,
    adapter_generation_time: 1,
    device_compile_wall_time: scope === 'hot_delta_2' ? 22000000 : 45000000,
    artifact_load_time: 1,
    epoch_publish_time: 1,
    dispatch_trace_time: 1,
    runtime_probe_time: 3000000000,
    oracle_analysis_time: 1,
    trigger_to_visible_time: 3200000000,
    screenshot_capture_time: 1,
    dispatch_to_output_proof_time: 1,
    total_validator_wall_time: 3300000000,
  };
}

function deterministicMode(scope) {
  return {
    schemaVersion: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
    fixed_seed: true,
    seed_policy_fixed: true,
    seed_policy_hash: hashValue(`seed:${scope}`),
    camera_state_hash: hashValue(`camera:${scope}`),
    frozen_camera: true,
    temporal_accumulation_not_applicable: true,
    taa_not_applicable: true,
    denoiser_not_applicable: true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
    warmup_frames: 2,
  };
}

function visualOracleArtifacts(scope, visualRoot = visualDir) {
  const beforePath = path.join(visualRoot, 'before-hmr-first.png');
  const afterPath = path.join(visualRoot, 'after-hmr-first.png');
  const diffPath = path.join(visualRoot, 'before-after-diff.png');
  const dimensions = pngDimensionsForPath(afterPath)
    ?? pngDimensionsForPath(beforePath)
    ?? pngDimensionsForPath(diffPath)
    ?? [800, 600];
  const existingMaterializedPngHashOrFallback = (filePath, fallbackSeed) =>
    fsSync.existsSync(filePath) && fsSync.statSync(filePath).size > PNG_HEADER.length
      ? fileHashForPath(filePath)
      : hashValue(fallbackSeed);
  return {
    before_image: beforePath,
    before_image_hash: existingMaterializedPngHashOrFallback(beforePath, `before-image:${scope}`),
    before_image_hash_verified: true,
    after_image: afterPath,
    after_image_hash: existingMaterializedPngHashOrFallback(afterPath, `after-image:${scope}`),
    after_image_hash_verified: true,
    diff_image: diffPath,
    diff_image_hash: existingMaterializedPngHashOrFallback(diffPath, `diff-image:${scope}`),
    diff_image_hash_verified: true,
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace: `epoch=epoch:${scope} dispatch=dispatch:${scope} artifact=${hashValue(`artifact-after:${scope}`)}`,
    camera_state_hash: hashValue(`camera:${scope}`),
    swapchain_size: dimensions,
    capture_backend: 'mcp_decoded_frame',
    frame_number: scope === 'hot_delta_2' ? 42 : 24,
    timestamp_after_dispatch: 4000,
    perceptual_diff: 6.5,
    changed_pixel_ratio: 0.042,
    visible_pixel_count: 2000,
    pixel_metrics_verified: true,
  };
}

function completeVisualOracleArtifacts(scope, visualRoot, artifacts = {}) {
  return {
    ...visualOracleArtifacts(scope, visualRoot),
    ...artifacts,
    ...(artifacts.beforeImage ? {
      before_image: artifacts.beforeImage,
      before_image_hash: artifacts.beforeImageHash,
      before_image_hash_verified: true,
    } : {}),
    ...(artifacts.afterImage ? {
      after_image: artifacts.afterImage,
      after_image_hash: artifacts.afterImageHash,
      after_image_hash_verified: true,
    } : {}),
    ...(artifacts.diffImage ? {
      diff_image: artifacts.diffImage,
      diff_image_hash: artifacts.diffImageHash,
      diff_image_hash_verified: true,
    } : {}),
    pixel_metrics_verified: true,
  };
}

function runtimeProofMaterialsWithVisualArtifacts(scope, options, artifacts) {
  return withVisualOracleArtifacts(
    runtimeProofMaterials(scope, options),
    completeVisualOracleArtifacts(scope, options?.visualRoot ?? visualDir, artifacts),
  );
}

function acceptanceContract(scope, options = {}) {
  const projectId = options.projectId ?? 'flow';
  const evidenceRef = `evidence:synthetic-runtime:${scope}`;
  const beforeHash = hashValue(`artifact-before:${scope}`);
  const afterHash = hashValue(`artifact-after:${scope}`);
  const fissionEvidenceRef = `evidence:fission-verifier-report:synthetic:${scope}`;
  const fieldEvidence = Object.fromEntries([
    'kernel_name',
    'launch_api',
    'grid_dim',
    'block_dim',
    'shared_mem_bytes',
    'stream',
    'kernel_params',
    'code_object_metadata',
    'output_buffers',
    'readback_oracle',
  ].map((field) => [field, [evidenceRef]]));
  return {
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    project_id: projectId,
    edit_id: `source-edit:${scope}`,
    backend: 'hip',
    confidence: 0.95,
    evidence_refs: [evidenceRef, fissionEvidenceRef],
    ai_hints: [],
    unsupported_reasons: [],
    failure_mode: 'reject',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: ['gpu/device.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['flow_kernel'],
      compile_target: 'gfx1201',
      compiler: 'hipcc',
      compiler_args_hash: hashValue(`compile-args:${scope}`),
    },
    artifact_hash_before: beforeHash,
    artifact_hash_after: afterHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: [evidenceRef],
    },
    abi_metadata: {
      args: [{
        name: 'out',
        type: 'float*',
        size: 8,
        offset: 0,
        value_kind: 'global_buffer',
        access: 'write',
        address_space: 'global',
        source: 'runtime_trace',
      }],
      workgroup_or_launch_shape: { grid_dim: [1, 1, 1], block_dim: [64, 1, 1] },
      stream_or_queue_requirements: { stream: 'stream:0' },
      extractor_sources: ['code_object_metadata'],
    },
    reload_mechanism: 'generated_adapter',
    adapter_outcome: 'adapter_generated',
    reload_evidence_refs: [evidenceRef],
    output_oracle_target: {
      kind: 'compute',
      target_id: 'buffer:flow-output',
      compute_only_target_verified: true,
      evidence_refs: [evidenceRef],
    },
    firewall_evidence: {
      route: 'gpu_hmr',
      evidence_source: 'runtime_trace',
      evidence_refs: [evidenceRef],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: 'pid:4242',
      process_id_after: 'pid:4242',
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: 'pid:4242',
      device_uuid: 'gpu:synthetic-rocm',
      context_or_device_handle: 'context:0',
      queue_or_stream_handle: 'stream:0',
      persistent_gpu_allocations: ['alloc:output'],
    },
    epoch_policy: {
      publish_mechanism: 'runtime_epoch_publish',
      dispatch_binding: 'dispatch_table_epoch_binding',
      retirement_mechanism: 'stream_event',
    },
    epoch_retirement_proof: {
      value: 'stream_event_proven',
      evidence_refs: [evidenceRef],
    },
    fission_report: {
      selected_island: 'island:flow-kernel',
      selected_reason: 'verified_fission_contract',
      changed_sources: ['gpu/device.hip'],
      included_dependencies: [{ path: 'gpu/device.hip' }],
      excluded_host_sources: ['src/main.cpp'],
      artifact_hash_before: beforeHash,
      artifact_hash_after: afterHash,
      abi_compatibility_class: 'compatible',
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
      unaffected_artifacts_hash_unchanged: true,
      selected_verifier_evidence_id: fissionEvidenceRef,
      deterministic_verifier_evidence_refs: [evidenceRef, fissionEvidenceRef],
      selection_decision_hash: hashValue(`selection:${scope}`),
      output_oracle_contract: {
        kind: 'buffer_checksum',
        expected: 'runtime_readback_changed_after_epoch_dispatch',
        evidence_refs: [evidenceRef],
      },
      evidence_refs: [evidenceRef, fissionEvidenceRef],
    },
    hip_contract: {
      kernel_name: 'flow_kernel',
      launch_api: 'hipModuleLaunchKernel',
      grid_dim: [1, 1, 1],
      block_dim: [64, 1, 1],
      shared_mem_bytes: 0,
      stream: 'stream:0',
      kernel_params: ['out'],
      code_object_metadata: { source: 'code_object_metadata', kernel: 'flow_kernel' },
      output_buffers: ['buffer:flow-output'],
      readback_oracle: 'buffer_checksum_after_dispatch',
      field_evidence_refs: fieldEvidence,
    },
  };
}

function hiprtAcceptanceContract(scope, {
  projectId,
  profileId,
  baselinePath,
  changedPath,
  diffPath,
}) {
  const contract = acceptanceContract(scope, { projectId });
  const evidenceRef = `evidence:synthetic-hiprt:${scope}`;
  const visualRef = `visual:hiprt:diff:${fileHashForPath(diffPath)}`;
  const fieldEvidence = Object.fromEntries([
    'kernel_entry',
    'scene_or_bvh_handles',
    'framebuffer_handle',
    'material_or_geometry_buffers',
    'camera_state_hash',
    'same_process_reload_hook',
    'visual_oracle',
  ].map((field) => [field, [evidenceRef, visualRef]]));
  contract.backend = 'hiprt';
  contract.project_id = projectId ?? profileId;
  contract.artifact_identity.artifact_kind = 'hiprt_runtime_shader_cache';
  contract.artifact_identity.entry_points = ['RenderKernel'];
  contract.output_oracle_target = {
    kind: 'visual',
    target_id: changedPath,
    evidence_refs: [visualRef],
  };
  delete contract.hip_contract;
  contract.hiprt_contract = {
    kernel_entry: 'RenderKernel',
    scene_or_bvh_handles: [`app-declared-scene-or-asset:${profileId}`],
    framebuffer_handle: changedPath,
    material_or_geometry_buffers: ['runtime-observed:hiprtBuildGeometry'],
    camera_state_hash: hashValue(`hiprt-camera:${scope}`),
    same_process_reload_hook: 'SYNTHI_HIPRT_RUNTIME_PROBE_RELOAD_TRIGGER_PATH',
    visual_oracle: {
      kind: 'deterministic_framebuffer_diff',
      before_image_hash: fileHashForPath(baselinePath),
      after_image_hash: fileHashForPath(changedPath),
      diff_image_hash: fileHashForPath(diffPath),
    },
    field_evidence_refs: fieldEvidence,
  };
  return contract;
}

function runtimeProofMaterials(scope, options = {}) {
  const projectId = options.projectId ?? 'flow';
  const visualRoot = options.visualRoot ?? visualDir;
  const sourceAdaptedVisualProfile = options.sourceAdaptedVisualProfile === true;
  const runtimeSessionId = options.runtimeSessionId ?? `runtime-session:${scope}`;
  const outputRuntimeSessionId = options.outputRuntimeSessionId ?? runtimeSessionId;
  const dispatchTableEntryId = options.dispatchTableEntryId ?? `dispatch-table-entry:${scope}`;
  const outputTargetId = options.outputTargetId ?? `output-target:${scope}`;
  const evidenceRef = `evidence:synthetic-runtime:${scope}`;
  const evidenceRefs = [...new Set([
    evidenceRef,
    ...(Array.isArray(options.extraEvidenceRefs) ? options.extraEvidenceRefs : []),
  ].filter(Boolean))];
  const beforeHash = hashValue(`artifact-before:${scope}`);
  const afterHash = hashValue(`artifact-after:${scope}`);
  const timings = timingFields(scope);
  const deterministicVisualMode = deterministicMode(scope);
  const visualArtifacts = visualOracleArtifacts(scope, visualRoot);
  const proofLedger = buildGpuHmrProofLedger({
    project_id: projectId,
    edit_id: `source-edit:${scope}`,
    backend: 'hip',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: hashValue(`contract:${scope}`),
    artifact_before_hash: beforeHash,
    artifact_after_hash: afterHash,
    loader_event: {
      id: `loader:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      selected_loader_transport: 'ram_bytes',
      artifact_transport: {
        selected_loader_transport: 'ram_bytes',
        artifact_hash: afterHash,
        blob_digest: afterHash,
      },
      timestamp_monotonic_ns: 1000,
      process_id: 'pid:4242',
    },
    epoch_publish_event: {
      id: `epoch-publish:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      timestamp_monotonic_ns: 2000,
      process_id: 'pid:4242',
    },
    dispatch_event: {
      id: `dispatch:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      timestamp_monotonic_ns: 3000,
      process_id: 'pid:4242',
    },
    output_event: {
      id: `output:${scope}`,
      kind: 'visual_frame',
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: outputRuntimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      after_dispatch_id: `dispatch:${scope}`,
      timestamp_monotonic_ns: 4000,
      process_id: 'pid:4242',
      passed: true,
      visual_oracle_artifacts: visualArtifacts,
    },
    retirement_event: {
      id: `retire:${scope}`,
      epoch: `epoch:${scope}`,
      timestamp_monotonic_ns: 5000,
      process_id: 'pid:4242',
      proof: 'stream_event_proven',
    },
    process_identity: { process_id: 'pid:4242', runtime_session_id: runtimeSessionId },
    device_identity: { device_uuid: 'gpu:synthetic-rocm', backend: 'hip' },
    oracle_artifacts: { visual_oracle_artifacts: visualArtifacts },
    deterministic_visual_mode: deterministicVisualMode,
    metric_clock: 'monotonic_ns',
    metric_scope: scope,
    cache_state: 'compiler_cache_warm',
    timings,
    modelProvenance: {
      split: modelProvenance('split', 'gemini-3.5-flash'),
      gpu_delta: modelProvenance('gpu_delta', 'gemini-3.1-flash-lite'),
    },
    evidence_refs: evidenceRefs,
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    cpu_hmr_used_evidence_present: true,
    full_rebuild_used_evidence_present: true,
    process_restarted_evidence_present: true,
    firewall_process_id_before: 'pid:4242',
    firewall_process_id_after: 'pid:4242',
  });
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  const contract = acceptanceContract(scope, { projectId });
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  assert.deepEqual(acceptanceContractEvaluation.failedGates, []);
  assert.equal(acceptanceContractEvaluation.accepted, true);
  const acceptanceContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
  });
  assert.equal(acceptanceContractConsistency.accepted, true);
  const deterministicVisualModeEvaluation =
    evaluateGpuHmrDeterministicVisualMode(deterministicVisualMode);
  assert.equal(deterministicVisualModeEvaluation.accepted, true);
  const runtimeTrace = {
    loaderEvents: [{
      source: 'hipModuleLoadData',
      artifactHash: afterHash,
      artifact_hash: afterHash,
      evidenceRefs,
      evidence_refs: evidenceRefs,
    }],
    loader_events: [{
      source: 'hipModuleLoadData',
      artifactHash: afterHash,
      artifact_hash: afterHash,
      evidenceRefs,
      evidence_refs: evidenceRefs,
    }],
    dispatchEvents: [{
      command: 'hipModuleLaunchKernel',
      dispatchId: `dispatch:${scope}`,
      dispatch_id: `dispatch:${scope}`,
      evidenceRefs,
      evidence_refs: evidenceRefs,
    }],
    dispatch_events: [{
      command: 'hipModuleLaunchKernel',
      dispatchId: `dispatch:${scope}`,
      dispatch_id: `dispatch:${scope}`,
      evidenceRefs,
      evidence_refs: evidenceRefs,
    }],
    outputEvents: [{
      kind: 'visual_frame',
      afterDispatchId: `dispatch:${scope}`,
      after_dispatch_id: `dispatch:${scope}`,
      evidenceRefs,
      evidence_refs: evidenceRefs,
    }],
    output_events: [{
      kind: 'visual_frame',
      afterDispatchId: `dispatch:${scope}`,
      after_dispatch_id: `dispatch:${scope}`,
      evidenceRefs,
      evidence_refs: evidenceRefs,
    }],
  };
  const runtimeProofArtifact = {
    proofId: `runtime-proof-artifact:sha256:${sha256Hex(scope)}`,
    fullRuntimeProven: sourceAdaptedVisualProfile ? false : true,
    gpuHmrSuccess: sourceAdaptedVisualProfile ? false : true,
    visualProfileAccepted: sourceAdaptedVisualProfile,
    sourceAdaptedProfile: sourceAdaptedVisualProfile,
    stageResults: [
      { stageId: 'fission-candidate-verification', status: 'passed' },
      { stageId: 'device-compile', status: 'passed' },
      { stageId: 'artifact-load', status: 'passed' },
      { stageId: 'epoch-publish', status: 'passed' },
      { stageId: 'dispatch-trace', status: 'passed' },
      { stageId: 'output-oracle', status: 'passed' },
      {
        stageId: 'no-source-adapted-profile',
        status: sourceAdaptedVisualProfile ? 'failed' : 'passed',
      },
    ],
    limitations: sourceAdaptedVisualProfile
      ? [{ code: 'source_adapted_profile_not_no_shim_gpu_hmr' }]
      : [],
    proofLedger,
    proofLedgerQuery,
    acceptanceContract: contract,
    acceptanceContractEvaluation,
    acceptanceContractConsistency,
    proofLedgerSourceConsistency: {
      accepted: true,
      mode: 'derived_only',
    },
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
    runtimeTrace,
    runtime_trace: runtimeTrace,
  };
  return {
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery,
    proof_ledger_query: proofLedgerQuery,
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
    runtimeTrace,
    runtime_trace: runtimeTrace,
  };
}

function computeProofLedgerMaterials(scope, {
  projectId,
  backend = 'hip',
  rawReadbackPath,
  rawReadbackBytes = null,
  runtimeSessionId = `runtime-session:${scope}`,
  outputRuntimeSessionId = runtimeSessionId,
  dispatchTableEntryId = `dispatch-table-entry:${scope}`,
  outputTargetId = `output-target:${scope}`,
}) {
  const beforeHash = hashValue(`compute-artifact-before:${scope}`);
  const afterHash = hashValue(`compute-artifact-after:${scope}`);
  const actualRawReadbackBytes = Buffer.isBuffer(rawReadbackBytes) ? rawReadbackBytes : null;
  const deterministicSliceLength = Math.min(4, actualRawReadbackBytes?.length ?? 4);
  const rawReadbackHash = actualRawReadbackBytes
    ? hashBuffer(actualRawReadbackBytes)
    : hashValue(`raw-readback:${scope}`);
  const deterministicSliceHash = actualRawReadbackBytes
    ? hashBuffer(actualRawReadbackBytes.subarray(0, deterministicSliceLength))
    : hashValue(`raw-readback-slice:${scope}`);
  const computeOracleArtifacts = {
    raw_readback_bin: rawReadbackPath,
    readback_schema_json: `${rawReadbackPath}.schema.json`,
    checksum_before: hashValue(`compute-checksum-before:${scope}`),
    checksum_after: hashValue(`compute-checksum-after:${scope}`),
    deterministic_slice: {
      offset: 0,
      length: deterministicSliceLength,
      hash: deterministicSliceHash,
    },
    deterministic_slice_hash: deterministicSliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: hashValue(`compute-oracle-code:${scope}`),
    rendered_card_png: `${rawReadbackPath}.card.png`,
    producer: 'synthetic_compute_oracle',
    timestamp_after_dispatch: 4000,
    epoch: `epoch:${scope}`,
    raw_readback_hash: rawReadbackHash,
    raw_readback_hash_verified: true,
    raw_readback_byte_length: actualRawReadbackBytes?.length ?? 4,
    raw_readback_source: 'runtime_raw_readback',
    expected_output_verified: true,
    expected_output_source: 'runtime_checksum_oracle',
    output_change_expected: true,
  };
  const proofLedger = buildGpuHmrProofLedger({
    project_id: projectId,
    edit_id: `source-edit:${scope}`,
    backend,
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: hashValue(`compute-contract:${scope}`),
    artifact_before_hash: beforeHash,
    artifact_after_hash: afterHash,
    loader_event: {
      id: `loader:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      selected_loader_transport: 'ram_bytes',
      artifact_transport: {
        selected_loader_transport: 'ram_bytes',
        artifact_hash: afterHash,
        blob_digest: afterHash,
      },
      timestamp_monotonic_ns: 1000,
      process_id: 'pid:4242',
    },
    epoch_publish_event: {
      id: `epoch-publish:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      timestamp_monotonic_ns: 2000,
      process_id: 'pid:4242',
    },
    dispatch_event: {
      id: `dispatch:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      timestamp_monotonic_ns: 3000,
      process_id: 'pid:4242',
    },
    output_event: {
      id: `output:${scope}`,
      kind: 'compute_oracle',
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: outputRuntimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      after_dispatch_id: `dispatch:${scope}`,
      timestamp_monotonic_ns: 4000,
      process_id: 'pid:4242',
      passed: true,
      compute_oracle_artifacts: computeOracleArtifacts,
    },
    retirement_event: {
      id: `retire:${scope}`,
      epoch: `epoch:${scope}`,
      timestamp_monotonic_ns: 5000,
      process_id: 'pid:4242',
      proof: 'stream_event_proven',
    },
    process_identity: { process_id: 'pid:4242', runtime_session_id: runtimeSessionId },
    device_identity: { device_uuid: 'gpu:synthetic-rocm', backend },
    oracle_artifacts: { compute_oracle_artifacts: computeOracleArtifacts },
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    timings: timingFields('hot_delta_1'),
    modelProvenance: {
      split: modelProvenance('split', 'gemini-3.5-flash'),
      gpu_delta: modelProvenance('gpu_delta', 'gemini-3.1-flash-lite'),
    },
    evidence_refs: [`evidence:synthetic-compute:${scope}`],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    cpu_hmr_used_evidence_present: true,
    full_rebuild_used_evidence_present: true,
    process_restarted_evidence_present: true,
    firewall_process_id_before: 'pid:4242',
    firewall_process_id_after: 'pid:4242',
  });
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  const contract = acceptanceContract(scope, { projectId });
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  assert.deepEqual(acceptanceContractEvaluation.failedGates, []);
  assert.equal(acceptanceContractEvaluation.accepted, true);
  const acceptanceContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
  });
  assert.equal(acceptanceContractConsistency.accepted, true);
  const computeEvidenceRefs = [`evidence:synthetic-compute:${scope}`];
  const dispatchCommand = backend === 'opencl'
    ? 'clEnqueueNDRangeKernel'
    : backend === 'vulkan'
      ? 'vkQueueSubmit'
      : 'hipModuleLaunchKernel';
  const loaderSource = backend === 'opencl'
    ? 'clBuildProgram'
    : backend === 'vulkan'
      ? 'vkCreatePipeline'
      : 'hipModuleLoadData';
  const runtimeTrace = {
    loaderEvents: [{
      source: loaderSource,
      artifactHash: afterHash,
      artifact_hash: afterHash,
      evidenceRefs: computeEvidenceRefs,
      evidence_refs: computeEvidenceRefs,
    }],
    loader_events: [{
      source: loaderSource,
      artifactHash: afterHash,
      artifact_hash: afterHash,
      evidenceRefs: computeEvidenceRefs,
      evidence_refs: computeEvidenceRefs,
    }],
    dispatchEvents: [{
      command: dispatchCommand,
      dispatchId: `dispatch:${scope}`,
      dispatch_id: `dispatch:${scope}`,
      evidenceRefs: computeEvidenceRefs,
      evidence_refs: computeEvidenceRefs,
    }],
    dispatch_events: [{
      command: dispatchCommand,
      dispatchId: `dispatch:${scope}`,
      dispatch_id: `dispatch:${scope}`,
      evidenceRefs: computeEvidenceRefs,
      evidence_refs: computeEvidenceRefs,
    }],
    outputEvents: [{
      kind: 'compute_oracle',
      afterDispatchId: `dispatch:${scope}`,
      after_dispatch_id: `dispatch:${scope}`,
      evidenceRefs: computeEvidenceRefs,
      evidence_refs: computeEvidenceRefs,
    }],
    output_events: [{
      kind: 'compute_oracle',
      afterDispatchId: `dispatch:${scope}`,
      after_dispatch_id: `dispatch:${scope}`,
      evidenceRefs: computeEvidenceRefs,
      evidence_refs: computeEvidenceRefs,
    }],
  };
  const runtimeProofArtifact = {
    proofId: `runtime-proof-artifact:sha256:${sha256Hex(`compute:${scope}`)}`,
    fullRuntimeProven: true,
    gpuHmrSuccess: true,
    stageResults: [
      { stageId: 'fission-candidate-verification', status: 'passed' },
      { stageId: 'device-compile', status: 'passed' },
      { stageId: 'artifact-load', status: 'passed' },
      { stageId: 'epoch-publish', status: 'passed' },
      { stageId: 'dispatch-trace', status: 'passed' },
      { stageId: 'output-oracle', status: 'passed' },
    ],
    limitations: [],
    proofLedger,
    proofLedgerQuery,
    acceptanceContract: contract,
    acceptanceContractEvaluation,
    acceptanceContractConsistency,
    proofLedgerSourceConsistency: {
      accepted: true,
      mode: 'derived_only',
    },
    runtimeTrace,
    runtime_trace: runtimeTrace,
  };
  return {
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery,
    proof_ledger_query: proofLedgerQuery,
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
    computeOracleArtifacts,
    runtimeTrace,
    runtime_trace: runtimeTrace,
  };
}

function hiprtWarmProofArtifact({
  slug,
  profileId,
  baselinePath,
  changedPath,
  diffPath,
  oracleRegionClaimNonBlank = true,
  visualProofThresholds = {
    minChangedPixelRatio: 0.01,
    minMeanAbsDelta8bit: 1,
  },
}) {
  const materials = runtimeProofMaterials('hot_delta_1', {
    projectId: profileId,
    visualRoot: path.dirname(diffPath),
    sourceAdaptedVisualProfile: true,
  });
  const runtimeProbeInstrumentation = hiprtRuntimeProbeInstrumentation(profileId);
  const acceptanceContract = hiprtAcceptanceContract(`hiprt:${slug}`, {
    projectId: profileId,
    profileId,
    baselinePath,
    changedPath,
    diffPath,
  });
  return {
    schemaVersion: 'synthi.hiprt.warm_visual_proof.v2',
    slug,
    createdAt: '2026-06-09T00:00:00.000Z',
    mode: 'same-process',
    metricScope: 'hot_delta_1',
    metric_scope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    cache_state: 'compiler_cache_warm',
    profile: { id: profileId },
    visualProofThresholds,
    visual_proof_thresholds: visualProofThresholds,
    thresholds: visualProofThresholds,
    accepted: true,
    acceptance: {
      strictProvenance: true,
      sameProcessRuntime: true,
      visualDelta: true,
      oracleRegionNonBlank: oracleRegionClaimNonBlank,
    },
    runtime: {
      baseline: {
        localCapturePath: baselinePath,
        contentHash: fileHashForPath(baselinePath),
      },
      changed: {
        localCapturePath: changedPath,
        contentHash: fileHashForPath(changedPath),
        sameProcess: true,
        liveRecompileMs: 1,
        totalHostWallMs: 2,
      },
    },
    diff: {
      path: diffPath,
      contentHash: fileHashForPath(diffPath),
      changedPixelRatioThreshold4: 1,
      meanAbsDelta8bit: 10,
      oracleRegion: {
        thresholds: {
          minVisibleRatio: 0.02,
          minMeanLuma8bit: 4,
          minUniqueColorSampleCount: 1,
        },
        changedPixelsThreshold4: 64,
        changedPixelRatioThreshold4: 1,
        changed: {
          pixels: 64,
          visiblePixels: oracleRegionClaimNonBlank ? 64 : 0,
          visiblePixelRatio: oracleRegionClaimNonBlank ? 1 : 0,
          meanLuma8bit: oracleRegionClaimNonBlank ? 16 : 0,
          uniqueColorSampleCount: oracleRegionClaimNonBlank ? 4 : 1,
        },
        nonBlankAfterEpoch: oracleRegionClaimNonBlank,
        blankFrameRejected: oracleRegionClaimNonBlank,
      },
    },
    strictHmrProvenance: {
      fullRuntimeProven: true,
      strictFullRuntimePassed: true,
    },
    acceptanceContract,
    acceptance_contract: acceptanceContract,
    runtimeProbeInstrumentation,
    runtime_probe_instrumentation: runtimeProbeInstrumentation,
    timings: {
      totalWallMs: 3,
    },
    timingMetrics: {
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `source-edit:${slug}:hot1`,
      editHash: `sha256:${sha256Hex(`${slug}:hot1`)}`,
      editKind: 'gpu_artifact_edit',
    },
    ...materials,
  };
}

function hiprtRuntimeProbeInstrumentation(profileId) {
  return {
    schemaVersion: 'synthi.gpu.hmr.profile_probe_instrumentation.v1',
    kind: 'declared_profile_probe_instrumentation',
    instrumentationKind: 'profile_probe_instrumentation',
    instrumentation_kind: 'profile_probe_instrumentation',
    adapterFamily: 'hiprt-path-tracer-profile-adapter',
    adapter_family: 'hiprt-path-tracer-profile-adapter',
    profileId,
    profile_id: profileId,
    accepted: true,
    applied: true,
    adaptedOrAlreadyPresent: true,
    adapted_or_already_present: true,
    sourceAdaptations: [
      'runtime_capture_from_device_framebuffer',
      'same_process_targeted_kernel_recompile_hook',
    ],
    source_adaptations: [
      'runtime_capture_from_device_framebuffer',
      'same_process_targeted_kernel_recompile_hook',
    ],
    files: [
      { path: 'src/Renderer/GPURendererThread.cpp', status: 'adapted' },
    ],
    acceptanceScope: 'hiprt_declared_visual_profile',
    acceptance_scope: 'hiprt_declared_visual_profile',
    proofAuthority: 'runtime_probe_instrumentation_disclosure_not_universal_hmr',
    proof_authority: 'runtime_probe_instrumentation_disclosure_not_universal_hmr',
    executionBoundary: 'HIPRT-Path-Tracer profile adapter with explicit source hooks',
    execution_boundary: 'HIPRT-Path-Tracer profile adapter with explicit source hooks',
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    broadApplicationAcceptance: false,
    broad_application_acceptance: false,
    broadHipApplicationAcceptance: false,
    broad_hip_application_acceptance: false,
    unsupportedWithoutEvidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
    ],
    unsupported_without_evidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
    ],
  };
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-validation-matrix-'));
const mcpRoot = path.join(tmpRoot, 'mcp', 'synthi-mcp');
const logsRoot = path.join(mcpRoot, '.gpu-hmr-test-logs');
const artifactsRoot = path.join(mcpRoot, '.gpu-hmr-test-artifacts');
const casRoot = path.join(mcpRoot, '.gpu-hmr-test-artifacts-cas');

function randomColdDirectInputEvidenceFixture({
  candidateSource = 'direct_source_url_commit',
  sourceUrl = 'https://example.invalid/arbitrary/user-project.git',
  repoPath = null,
  immutableCommit = '1111111111111111111111111111111111111111',
  inputChannels: inputChannelsOverride = null,
} = {}) {
  const sourceKind = candidateSource === 'direct_local_git_repo_path'
    ? 'local_repo_path_commit'
    : 'source_url_commit';
  const inputChannels = Array.isArray(inputChannelsOverride)
    ? [...inputChannelsOverride].sort()
    : candidateSource === 'direct_local_git_repo_path'
      ? ['cli_arg_repo_path', 'cli_arg_commit']
      : ['cli_arg_source_url', 'cli_arg_commit'];
  const sourceIdentityHash = contentHashFor({
    schemaVersion: 'synthi.gpu_hmr.random_cold_path_direct_source_input.v1',
    candidateSource,
    sourceKind,
    hasSourceUrl: Boolean(sourceUrl),
    hasRepoPath: Boolean(repoPath),
    sourceUrlHash: sourceUrl ? hashValue(sourceUrl) : null,
    repoPathHash: repoPath ? hashValue(repoPath) : null,
    immutableCommit: String(immutableCommit ?? '').trim().toLowerCase(),
    inputChannels,
  });
  return {
    schemaVersion: 'synthi.gpu_hmr.random_cold_path_direct_source_input.v1',
    schema_version: 'synthi.gpu_hmr.random_cold_path_direct_source_input.v1',
    proofAuthority: 'runner_cli_env_direct_source_input_only_not_gpu_hmr_success',
    proof_authority: 'runner_cli_env_direct_source_input_only_not_gpu_hmr_success',
    accepted: true,
    acceptedAsDirectInputEvidence: true,
    accepted_as_direct_input_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    inputMode: 'cli_or_env_direct_source',
    input_mode: 'cli_or_env_direct_source',
    inputChannels,
    input_channels: inputChannels,
    candidateSource,
    candidate_source: candidateSource,
    sourceKind,
    source_kind: sourceKind,
    sourceIdentityRole: 'source_identity_hash_bound_to_direct_input_not_whitelist',
    source_identity_role: 'source_identity_hash_bound_to_direct_input_not_whitelist',
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    sourceIdentityHash,
    source_identity_hash: sourceIdentityHash,
    evidenceHash: sourceIdentityHash,
    evidence_hash: sourceIdentityHash,
    blockingGaps: [],
    blocking_gaps: [],
  };
}

function randomColdBuildMetadataContentEvidenceFixture({
  targetId = 'random-cold-readiness-user-project',
  accepted = true,
  schemaVersion = 'synthi.gpu_hmr.cold_build_metadata_content.v1',
  proofAuthority = 'build_metadata_content_bytes_only_not_gpu_hmr_success',
  acceptedForGpuHmr = false,
  gpuHmrSuccess = false,
  canSatisfyRuntimeProof = false,
  canSatisfyDispatchProof = false,
  contentEvidenceHashOverride = null,
  includeByteLength = true,
  includeTransport = true,
  buildFilePath = 'CMakeLists.txt',
} = {}) {
  const buildFiles = accepted
    ? [
      {
        path: buildFilePath,
        contentHash: hashValue(`random-cold-build-file:${targetId}:${buildFilePath}`),
        content_hash: hashValue(`random-cold-build-file:${targetId}:${buildFilePath}`),
        ...(includeByteLength
          ? {
            byteLength: 4096,
            byte_length: 4096,
          }
          : {}),
        ...(includeTransport
          ? {
            transport: 'git_show_immutable_commit',
          }
          : {}),
      },
    ]
    : [];
  const evidence = {
    schemaVersion,
    schema_version: schemaVersion,
    proofAuthority,
    proof_authority: proofAuthority,
    acceptedForGpuHmr,
    accepted_for_gpu_hmr: acceptedForGpuHmr,
    gpuHmrSuccess,
    gpu_hmr_success: gpuHmrSuccess,
    canSatisfyRuntimeProof,
    can_satisfy_runtime_proof: canSatisfyRuntimeProof,
    canSatisfyDispatchProof,
    can_satisfy_dispatch_proof: canSatisfyDispatchProof,
    acceptedAsBuildMetadataContent: accepted,
    accepted_as_build_metadata_content: accepted,
    completeForSelectedBuildFiles: accepted,
    complete_for_selected_build_files: accepted,
    selectedBuildFileCount: buildFiles.length,
    selected_build_file_count: buildFiles.length,
    acceptedBuildFileCount: buildFiles.length,
    accepted_build_file_count: buildFiles.length,
    failedBuildFileCount: 0,
    failed_build_file_count: 0,
    buildFiles,
    build_files: buildFiles,
    failedFiles: [],
    failed_files: [],
    remainingVerificationGaps: [
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    remaining_verification_gaps: [
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    startedAt: '2026-07-01T00:00:00.000Z',
    started_at: '2026-07-01T00:00:00.000Z',
    finishedAt: '2026-07-01T00:00:01.000Z',
    finished_at: '2026-07-01T00:00:01.000Z',
  };
  const contentEvidenceHash = contentEvidenceHashOverride ?? contentHashFor(evidence);
  return {
    ...evidence,
    contentEvidenceHash,
    content_evidence_hash: contentEvidenceHash,
  };
}

function randomColdPathManifest({
  candidateId = 'direct-random-arbitrary-cold',
  template = hashedColdRuntimeBoundaryTemplateFacet(),
  resultOverrides = {},
  topLevelOverrides = {},
} = {}) {
  const sourceUrl = 'https://example.invalid/arbitrary/user-project.git';
  const immutableCommit = '1111111111111111111111111111111111111111';
  const sourceRelevantFileCount = 73;
  const sourceOrBuildRelevantFileCount = 75;
  const gpuSourceFileCount = 31;
  const directInputEvidence = randomColdDirectInputEvidenceFixture({ sourceUrl, immutableCommit });
  const sourceIntakeEvidence = {
    schemaVersion: 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1',
    schema_version: 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1',
    proofAuthority: 'unprofiled_source_tree_intake_only_not_gpu_hmr_success',
    proof_authority: 'unprofiled_source_tree_intake_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    acceptedAsIntakeEvidence: true,
    accepted_as_intake_evidence: true,
    transport: 'github_git_tree_api_recursive',
    sourceListingHash: hashValue(`${candidateId}:listing`),
    source_listing_hash: hashValue(`${candidateId}:listing`),
    facetHash: hashValue(`${candidateId}:source-intake`),
    facet_hash: hashValue(`${candidateId}:source-intake`),
    fileCount: 2445,
    file_count: 2445,
    totalKnownBytes: 35885065,
    total_known_bytes: 35885065,
    gpuSourceSignals: ['src/shaders/sample.wgsl'],
    gpu_source_signals: ['src/shaders/sample.wgsl'],
    gpuSourceSignalCount: gpuSourceFileCount,
    gpu_source_signal_count: gpuSourceFileCount,
    sourceRelevantFiles: ['src/shaders/sample.wgsl', 'src/lib.rs'],
    source_relevant_files: ['src/shaders/sample.wgsl', 'src/lib.rs'],
    sourceRelevantFileCount,
    source_relevant_file_count: sourceRelevantFileCount,
    sourceOrBuildRelevantFileCount,
    source_or_build_relevant_file_count: sourceOrBuildRelevantFileCount,
    backendCandidates: ['vulkan', 'webgpu_wgsl'],
    backend_candidates: ['vulkan', 'webgpu_wgsl'],
    detectedBuildSystems: ['cargo', 'npm_or_node'],
    detected_build_systems: ['cargo', 'npm_or_node'],
    buildMetadataDiscoveryAccepted: true,
    build_metadata_discovery_accepted: true,
    buildMetadataDiscovery: {
      proofAuthority: 'build_metadata_discovery_only_not_gpu_hmr_success',
      proof_authority: 'build_metadata_discovery_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      detectedBuildSystems: ['cargo', 'npm_or_node'],
      detected_build_systems: ['cargo', 'npm_or_node'],
      backendCandidates: ['vulkan', 'webgpu_wgsl'],
      backend_candidates: ['vulkan', 'webgpu_wgsl'],
      gpuSourceSignalCount: gpuSourceFileCount,
      gpu_source_signal_count: gpuSourceFileCount,
      sourceRelevantFileCount,
      source_relevant_file_count: sourceRelevantFileCount,
      sourceOrBuildRelevantFileCount,
      source_or_build_relevant_file_count: sourceOrBuildRelevantFileCount,
      buildSystemSignals: {
        cargo: ['Cargo.toml', 'examples/standalone/02_hello_window/Cargo.toml'],
        npm_or_node: ['tests/wasm/runner/package.json'],
      },
      build_system_signals: {
        cargo: ['Cargo.toml', 'examples/standalone/02_hello_window/Cargo.toml'],
        npm_or_node: ['tests/wasm/runner/package.json'],
      },
    },
    buildMetadataContentAccepted: true,
    build_metadata_content_accepted: true,
    buildMetadataContentEvidence: {
      proofAuthority: 'build_metadata_content_bytes_only_not_gpu_hmr_success',
      proof_authority: 'build_metadata_content_bytes_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      acceptedAsBuildMetadataContent: true,
      accepted_as_build_metadata_content: true,
      contentEvidenceHash: hashValue(`${candidateId}:build-content`),
      content_evidence_hash: hashValue(`${candidateId}:build-content`),
      acceptedBuildFileCount: 2,
      accepted_build_file_count: 2,
    },
    runtimeBoundaryExpectationAccepted: true,
    runtime_boundary_expectation_accepted: true,
    runtimeBoundaryExpectation: {
      proofAuthority: 'runtime_boundary_expectation_only_not_gpu_hmr_success',
      proof_authority: 'runtime_boundary_expectation_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      acceptedAsRuntimeBoundaryExpectation: true,
      accepted_as_runtime_boundary_expectation: true,
      expectationHash: hashValue(`${candidateId}:runtime-boundary-expectation`),
      expectation_hash: hashValue(`${candidateId}:runtime-boundary-expectation`),
      backendCandidates: ['vulkan', 'webgpu_wgsl'],
      backend_candidates: ['vulkan', 'webgpu_wgsl'],
      requiredBoundaryStages: [
        'same_process_loader',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
      required_boundary_stages: [
        'same_process_loader',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    runtimeBoundaryEventManifestTemplateAccepted: true,
    runtime_boundary_event_manifest_template_accepted: true,
    runtimeBoundaryEventManifestTemplate: template,
    runtime_boundary_event_manifest_template: template,
  };
  const result = {
    candidateId,
    status: 'unprofiled_arbitrary_project_cold_intake_refused',
    backendFamily: 'unknown_gpu_project',
    backend_family: 'unknown_gpu_project',
    profileMode: 'unprofiled_arbitrary_project_cold_intake',
    profile_mode: 'unprofiled_arbitrary_project_cold_intake',
    runnerAttempted: false,
    runner_attempted: false,
    sourceUrl,
    source_url: sourceUrl,
    immutableCommit,
    immutable_commit: immutableCommit,
    sourceRelevantFileCount,
    source_relevant_file_count: sourceRelevantFileCount,
    sourceOrBuildRelevantFileCount,
    source_or_build_relevant_file_count: sourceOrBuildRelevantFileCount,
    gpuSourceFileCount,
    gpu_source_file_count: gpuSourceFileCount,
    sourceTreeIntakeAccepted: true,
    source_tree_intake_accepted: true,
    buildMetadataDiscoveryAccepted: true,
    build_metadata_discovery_accepted: true,
    buildMetadataContentAccepted: true,
    build_metadata_content_accepted: true,
    runtimeBoundaryExpectationAccepted: true,
    runtime_boundary_expectation_accepted: true,
    runtimeBoundaryEventManifestTemplateAccepted: true,
    runtime_boundary_event_manifest_template_accepted: true,
    runtimeBoundaryEventManifestTemplate: template,
    runtime_boundary_event_manifest_template: template,
    sourceIntakeEvidence,
    source_intake_evidence: sourceIntakeEvidence,
    blockingGaps: [
      'runtime_profile_contract_missing',
      'semantic_build_metadata_execution_missing',
      'same_process_loader_unproven',
      'epoch_publication_unproven',
      'dispatch_trace_unproven',
      'host_identity_unproven',
      'output_oracle_unproven',
      'strict_runtime_ledger_missing',
    ],
    blocking_gaps: [
      'runtime_profile_contract_missing',
      'semantic_build_metadata_execution_missing',
      'same_process_loader_unproven',
      'epoch_publication_unproven',
      'dispatch_trace_unproven',
      'host_identity_unproven',
      'output_oracle_unproven',
      'strict_runtime_ledger_missing',
    ],
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    ...resultOverrides,
  };
  return {
    schemaVersion: 'synthi.gpu_hmr.random_large_project_cold_path.v1',
    schema_version: 'synthi.gpu_hmr.random_large_project_cold_path.v1',
    proofAuthority: 'random_large_project_cold_path_selection_only_not_gpu_hmr_success',
    proof_authority: 'random_large_project_cold_path_selection_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    runId: `${candidateId}-run`,
    run_id: `${candidateId}-run`,
    eventType: 'cold_path_complete',
    event_type: 'cold_path_complete',
    status: 'complete',
    selection: {
      seed: 'random-cold-smoke',
      selectedIds: [candidateId],
      selected_ids: [candidateId],
      selectionHash: hashValue(`${candidateId}:selection`),
      selection_hash: hashValue(`${candidateId}:selection`),
    },
    candidates: [{
      id: candidateId,
      backendFamily: 'unknown_gpu_project',
      backend_family: 'unknown_gpu_project',
      profileMode: 'unprofiled_arbitrary_project_cold_intake',
      profile_mode: 'unprofiled_arbitrary_project_cold_intake',
      candidateSource: 'direct_source_url_commit',
      candidate_source: 'direct_source_url_commit',
      directInputEvidence,
      direct_input_evidence: directInputEvidence,
      sourceUrl,
      source_url: sourceUrl,
      immutableCommit,
      immutable_commit: immutableCommit,
    }],
    selectedCandidates: [{
      id: candidateId,
      backendFamily: 'unknown_gpu_project',
      backend_family: 'unknown_gpu_project',
      profileMode: 'unprofiled_arbitrary_project_cold_intake',
      profile_mode: 'unprofiled_arbitrary_project_cold_intake',
      candidateSource: 'direct_source_url_commit',
      candidate_source: 'direct_source_url_commit',
      directInputEvidence,
      direct_input_evidence: directInputEvidence,
      sourceUrl,
      source_url: sourceUrl,
      immutableCommit,
      immutable_commit: immutableCommit,
    }],
    dryRun: false,
    dry_run: false,
    timeoutMs: 120000,
    timeout_ms: 120000,
    runnerTimeoutMs: 240000,
    runner_timeout_ms: 240000,
    sourceIntake: true,
    source_intake: true,
    sourceIntakeTimeoutMs: 120000,
    source_intake_timeout_ms: 120000,
    pendingManifestHash: hashValue(`${candidateId}:pending-manifest`),
    pending_manifest_hash: hashValue(`${candidateId}:pending-manifest`),
    results: [result],
    ...topLevelOverrides,
  };
}

const randomColdPathDir = path.join(tmpRoot, 'random-large-project-cold-path-smoke');
await writeJson(
  path.join(randomColdPathDir, 'random-cold-valid.json'),
  randomColdPathManifest(),
);
const randomColdLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [randomColdPathDir],
  includeUnproven: true,
});
const randomColdRow = randomColdLedger.rows.find(
  (row) => row.proofMode === 'random_large_project_cold_path',
);
assert.equal(randomColdRow?.matrixOutcome, 'refusal_proven');
assert.equal(randomColdRow.acceptedForGpuHmr, false);
assert.equal(randomColdRow.gpuHmrSuccess, false);
assert.equal(randomColdRow.safety.accepted, true);
assert.equal(randomColdRow.randomColdPathDirectInputEvidence.acceptedAsDirectInputEvidence, true);
assert.equal(randomColdRow.backend, 'vulkan');
assert.equal(randomColdRow.randomColdBackendEvidence.backendSource, 'source_tree_intake_backend_candidates');
assert.equal(randomColdRow.randomColdBackendEvidence.candidateBackendUsedForAcceptance, false);
assert.deepEqual(
  randomColdRow.randomColdBackendEvidence.sourceDerivedBackendCandidates,
  ['vulkan', 'webgpu_wgsl'],
);
assert.equal(
  randomColdRow.randomLargeProjectColdPath.directInputEvidence.proofAuthority,
  'runner_cli_env_direct_source_input_only_not_gpu_hmr_success',
);
assert.equal(randomColdRow.randomLargeProjectColdPath.sourceRelevantFileCount, 73);
assert.equal(randomColdRow.randomLargeProjectColdPath.sourceOrBuildRelevantFileCount, 75);
assert.equal(randomColdRow.randomLargeProjectColdPath.gpuSourceFileCount, 31);
assert.equal(randomColdRow.coldSourceTreeIntake.accepted, true);
assert.equal(randomColdRow.coldSourceTreeIntake.sourceRelevantFileCount, 73);
assert.equal(randomColdRow.coldSourceTreeIntake.sourceOrBuildRelevantFileCount, 75);
assert.equal(randomColdRow.coldSourceTreeIntake.gpuSourceSignalCount, 31);
assert.equal(randomColdRow.sourceRelevantFileCount, 73);
assert.equal(randomColdRow.sourceOrBuildRelevantFileCount, 75);
assert.equal(randomColdRow.gpuSourceFileCount, 31);
assert.equal(randomColdRow.coldRuntimeBoundaryEventManifestTemplate.validated, true);
assert.equal(
  randomColdRow.coldRuntimeBoundaryEventManifestTemplate.acceptedAsSupportEvidence,
  true,
);
assert.ok(randomColdRow.openGaps.includes('strict_runtime_ledger_missing'));
const randomColdCoverage = new Map(
  randomColdLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(
  randomColdCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'diagnostic_only',
);
assert.equal(
  randomColdCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  0,
);
assert.equal(
  randomColdCoverage.get('random_large_arbitrary_project_cold_path')?.candidateRowCount,
  0,
);
assert.equal(
  randomColdCoverage.get('random_large_arbitrary_project_cold_path')?.refusalRowCount,
  1,
);
assert.ok(
  randomColdCoverage.get('random_large_arbitrary_project_cold_path')?.openGaps
    .includes('qualifying_direct_random_large_project_cold_path_required'),
);

const multiRandomColdPathDir = path.join(
  tmpRoot,
  'random-large-project-cold-path-multi-result-smoke',
);
const multiColdCandidateIds = [
  'direct-random-arbitrary-multi-a',
  'direct-random-arbitrary-multi-b',
  'direct-random-arbitrary-multi-c',
];
const multiColdUnselectedCandidateId = 'direct-random-arbitrary-multi-unselected';
const multiColdCandidateManifests = multiColdCandidateIds
  .concat(multiColdUnselectedCandidateId)
  .map((candidateId) => randomColdPathManifest({ candidateId }));
const multiColdSelectionHash = hashValue('direct-random-arbitrary-multi:selection');
await writeJson(
  path.join(multiRandomColdPathDir, 'random-cold-multi-result.json'),
  {
    ...multiColdCandidateManifests[0],
    runId: 'direct-random-arbitrary-multi-run',
    run_id: 'direct-random-arbitrary-multi-run',
    selection: {
      ...multiColdCandidateManifests[0].selection,
      selectedIds: multiColdCandidateIds,
      selected_ids: multiColdCandidateIds,
      selectionHash: multiColdSelectionHash,
      selection_hash: multiColdSelectionHash,
    },
    candidates: multiColdCandidateManifests.flatMap((manifest) => manifest.candidates),
    selectedCandidates: multiColdCandidateManifests
      .flatMap((manifest) => manifest.selectedCandidates),
    results: multiColdCandidateManifests.flatMap((manifest) => manifest.results),
  },
);
const multiRandomColdLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [multiRandomColdPathDir],
});
const multiRandomColdRows = multiRandomColdLedger.rows.filter(
  (row) => row.proofMode === 'random_large_project_cold_path',
);
assert.equal(multiRandomColdRows.length, multiColdCandidateIds.length);
assert.deepEqual(
  multiRandomColdRows.map((row) => row.targetId).sort(),
  [...multiColdCandidateIds].sort(),
);
assert.ok(multiRandomColdRows.every((row) => row.acceptedForGpuHmr === false));
assert.ok(multiRandomColdRows.every((row) => row.gpuHmrSuccess === false));
assert.ok(multiRandomColdRows.every((row) => row.matrixOutcome === 'refusal_proven'));
const multiRandomColdCoverage = new Map(
  multiRandomColdLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(
  multiRandomColdCoverage.get('random_large_arbitrary_project_cold_path')?.refusalRowCount,
  multiColdCandidateIds.length,
);
assert.equal(
  multiRandomColdLedger.summary.omittedInvalidatedRows,
  1,
);
const multiRandomColdAuditLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [multiRandomColdPathDir],
  includeInvalidated: true,
});
const multiRandomColdAuditRows = multiRandomColdAuditLedger.rows.filter(
  (row) => row.proofMode === 'random_large_project_cold_path',
);
assert.equal(multiRandomColdAuditRows.length, multiColdCandidateIds.length + 1);
const multiRandomColdUnselectedRow = multiRandomColdAuditRows.find(
  (row) => row.targetId === multiColdUnselectedCandidateId,
);
assert.equal(multiRandomColdUnselectedRow?.safety.accepted, false);
assert.ok(
  multiRandomColdUnselectedRow?.safety.failedGates
    .some((gate) => gate.code === 'random_large_project_cold_path_result_not_selected'),
);

const forgedCandidateBackendDir = path.join(tmpRoot, 'random-large-project-cold-path-backend-forged');
const forgedBackendSourceUrl = 'https://example.invalid/arbitrary/user-project.git';
const forgedBackendCommit = '1111111111111111111111111111111111111111';
const forgedBackendDirectInput = randomColdDirectInputEvidenceFixture({
  sourceUrl: forgedBackendSourceUrl,
  immutableCommit: forgedBackendCommit,
});
const forgedBackendCandidate = {
  id: 'direct-random-arbitrary-forged-backend',
  backend: 'hip',
  backendFamily: 'real_rocm',
  backend_family: 'real_rocm',
  backendCandidates: ['hip_rocm'],
  backend_candidates: ['hip_rocm'],
  profileMode: 'unprofiled_arbitrary_project_cold_intake',
  profile_mode: 'unprofiled_arbitrary_project_cold_intake',
  candidateSource: 'direct_source_url_commit',
  candidate_source: 'direct_source_url_commit',
  directInputEvidence: forgedBackendDirectInput,
  direct_input_evidence: forgedBackendDirectInput,
  sourceUrl: forgedBackendSourceUrl,
  source_url: forgedBackendSourceUrl,
  immutableCommit: forgedBackendCommit,
  immutable_commit: forgedBackendCommit,
};
await writeJson(
  path.join(forgedCandidateBackendDir, 'random-cold-forged-backend.json'),
  randomColdPathManifest({
    candidateId: 'direct-random-arbitrary-forged-backend',
    resultOverrides: {
      backend: 'hip',
      backendFamily: 'real_rocm',
      backend_family: 'real_rocm',
      backendCandidates: ['hip_rocm'],
      backend_candidates: ['hip_rocm'],
    },
    topLevelOverrides: {
      candidates: [forgedBackendCandidate],
      selectedCandidates: [forgedBackendCandidate],
      selected_candidates: [forgedBackendCandidate],
    },
  }),
);
const forgedBackendColdLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedCandidateBackendDir],
  includeUnproven: true,
});
const forgedBackendColdRow = forgedBackendColdLedger.rows.find(
  (row) => row.proofMode === 'random_large_project_cold_path',
);
assert.equal(forgedBackendColdRow?.backend, 'vulkan');
assert.equal(forgedBackendColdRow.randomColdBackendEvidence.candidateDeclaredBackend, 'hip');
assert.equal(forgedBackendColdRow.randomColdBackendEvidence.candidateDeclaredBackendFamily, 'real_rocm');
assert.deepEqual(
  forgedBackendColdRow.randomColdBackendEvidence.candidateDeclaredBackendCandidates,
  ['hip_rocm'],
);
assert.equal(forgedBackendColdRow.randomColdBackendEvidence.candidateBackendUsedForAcceptance, false);
assert.deepEqual(
  forgedBackendColdRow.randomColdBackendEvidence.sourceDerivedBackendCandidates,
  ['vulkan', 'webgpu_wgsl'],
);
assert.equal(forgedBackendColdRow.acceptedForGpuHmr, false);
assert.equal(forgedBackendColdRow.gpuHmrSuccess, false);

const forgedRuntimeEventsTemplateSeed = hashedColdRuntimeBoundaryTemplateFacet();
forgedRuntimeEventsTemplateSeed.manifestTemplate = {
  ...forgedRuntimeEventsTemplateSeed.manifestTemplate,
  runtimeBoundaryEvents: [{ eventKind: 'dispatch_trace', dispatch_id: 'forged-dispatch' }],
};
forgedRuntimeEventsTemplateSeed.manifest_template =
  forgedRuntimeEventsTemplateSeed.manifestTemplate;
const forgedRandomColdPathDir = path.join(tmpRoot, 'random-large-project-cold-path-forged');
await writeJson(
  path.join(forgedRandomColdPathDir, 'random-cold-forged-template.json'),
  randomColdPathManifest({
    candidateId: 'direct-random-arbitrary-forged-template',
    template: rehashColdRuntimeBoundaryTemplateFacet(forgedRuntimeEventsTemplateSeed),
  }),
);
const forgedRandomColdLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRandomColdPathDir],
  includeUnproven: true,
});
const forgedRandomColdRow = forgedRandomColdLedger.rows.find(
  (row) => row.proofMode === 'random_large_project_cold_path',
);
assert.equal(forgedRandomColdRow?.acceptedForGpuHmr, false);
assert.equal(forgedRandomColdRow.gpuHmrSuccess, false);
assert.equal(forgedRandomColdRow.coldRuntimeBoundaryEventManifestTemplate.validated, false);
assert.ok(forgedRandomColdRow.coldRuntimeBoundaryEventManifestTemplate.failedGates.includes(
  'cold_runtime_boundary_event_manifest_template_contains_runtime_events',
));
assert.equal(forgedRandomColdRow.safety.accepted, false);
assert.ok(forgedRandomColdLedger.query.failedGates.some(
  (gate) => gate.code === 'random_large_project_cold_template_not_validated',
));

const visualDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow');
await writeRgbaPng(path.join(visualDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(visualDir, 'after-hmr-first.png'), 8, 8, (x, y) => [16 + x, 24 + y, 48, 255]);
await writeRgbaPng(path.join(visualDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(visualDir, 'agent-split-results.json'), [
  { name: 'fixture', status: 'pass', detail: 'flow' },
  { name: 'worker used GPU split endpoint', status: 'pass', detail: 'GPU markers detected' },
  { name: 'generated split contains HMR ABI', status: 'pass', detail: 'shared.h, core.cpp, device.hip' },
  { name: 'generated split HMR granularity', status: 'pass', detail: 'claim=device_translation_unit_hmr rejected_claims=per_kernel_hmr' },
  {
    name: 'mcp wait_hmr proof gate',
    status: 'pass',
    detail: JSON.stringify({
      gpu_proof_validation: {
        satisfied: true,
        proofLedgerValidation: {
          proofId: 'gpu-ledger-proof:sha256:synthetic',
          gpuHmrSuccess: true,
          failedInvariants: [],
        },
        runtimeProofArtifactValidation: {
          accepted: true,
          failedGates: [],
        },
      },
      gpu_proof_telemetry: {
        proofId: 'gpu-runtime-proof:sha256:synthetic',
      },
      timingMetrics: {
        metricClock: 'monotonic_ns',
        metricScope: 'hot_delta_1',
        cacheState: 'compiler_cache_warm',
      },
    }),
  },
  { name: 'device-only GPU HMR observed', status: 'pass', detail: '[gpu-reload] plan=device_only' },
  {
    name: 'mcp screenshot before hmr',
    status: 'pass',
    detail: `images=${path.join(visualDir, 'before-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot after hmr',
    status: 'pass',
    detail: `images=${path.join(visualDir, 'after-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot visual delta',
    status: 'pass',
    detail: `changed=4.20% mean_abs=6.50 selected_delta_ms=123 diff=${path.join(visualDir, 'before-after-diff.png')}`,
  },
  { name: 'runner stayed alive after GPU HMR', status: 'pass', detail: 'no runner crash marker' },
]);

const visualCameraMismatchMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'visual-camera-mismatch-ledger',
});
const visualCameraMismatchRecord = cloneJson(visualCameraMismatchMaterials.proofLedger.records[0]);
delete visualCameraMismatchRecord.proofId;
const forgedCameraHash = hashValue('visual-camera-mismatch-forged-camera');
if (visualCameraMismatchRecord.oracleArtifacts?.visual_oracle_artifacts) {
  visualCameraMismatchRecord.oracleArtifacts.visual_oracle_artifacts.camera_state_hash = forgedCameraHash;
  visualCameraMismatchRecord.oracleArtifacts.visual_oracle_artifacts.cameraStateHash = forgedCameraHash;
}
if (visualCameraMismatchRecord.outputEvent?.visual_oracle_artifacts) {
  visualCameraMismatchRecord.outputEvent.visual_oracle_artifacts.camera_state_hash = forgedCameraHash;
  visualCameraMismatchRecord.outputEvent.visual_oracle_artifacts.cameraStateHash = forgedCameraHash;
}
const visualCameraMismatchEvaluation = evaluateGpuHmrProofLedger(visualCameraMismatchRecord);
assert.equal(visualCameraMismatchEvaluation.gpuHmrSuccess, false);
assert.ok(visualCameraMismatchEvaluation.failedInvariants.some((failure) =>
  failure.code === 'visual_camera_state_hash_mismatch'
));

const forgedLegacyDir = path.join(logsRoot, 'agent-split-artifacts', 'forged-legacy-preview');
await writeRgbaPng(path.join(forgedLegacyDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedLegacyDir, 'after-hmr-first.png'), 8, 8, (x, y) => [64 + x, 80 + y, 128, 255]);
await writeRgbaPng(path.join(forgedLegacyDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedLegacyDir, 'agent-split-results.json'), [
  { name: 'fixture', status: 'pass', detail: 'forged legacy preview with embedded claims only' },
  { name: 'worker used GPU split endpoint', status: 'pass', detail: 'GPU markers detected' },
  { name: 'generated split contains HMR ABI', status: 'pass', detail: 'shared.h, core.cpp, device.hip' },
  { name: 'generated split HMR granularity', status: 'pass', detail: 'claim=device_translation_unit_hmr' },
  {
    name: 'mcp wait_hmr proof gate',
    status: 'pass',
    detail: JSON.stringify({
      backend: 'hip',
      targetId: 'forged-legacy-preview',
      profileId: 'forged-legacy-preview',
      gpu_proof_validation: {
        satisfied: true,
        proofLedgerValidation: {
          proofId: 'gpu-ledger-proof:sha256:forged-legacy-preview',
          gpuHmrSuccess: true,
          failedInvariants: [],
        },
        runtimeProofArtifactValidation: {
          accepted: true,
          failedGates: [],
        },
      },
      gpu_proof_telemetry: {
        proofId: 'gpu-runtime-proof:sha256:forged-legacy-preview',
      },
      timingMetrics: {
        metricClock: 'monotonic_ns',
        metricScope: 'hot_delta_1',
        cacheState: 'compiler_cache_warm',
      },
    }),
  },
  { name: 'device-only GPU HMR observed', status: 'pass', detail: '[gpu-reload] plan=device_only' },
  {
    name: 'mcp screenshot before hmr',
    status: 'pass',
    detail: `images=${path.join(forgedLegacyDir, 'before-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot after hmr',
    status: 'pass',
    detail: `images=${path.join(forgedLegacyDir, 'after-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot visual delta',
    status: 'pass',
    detail: `changed=4.20% mean_abs=6.50 selected_delta_ms=123 diff=${path.join(forgedLegacyDir, 'before-after-diff.png')}`,
  },
  { name: 'runner stayed alive after GPU HMR', status: 'pass', detail: 'no runner crash marker' },
]);

const runModeProofBase = {
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  backend: 'hip',
  targetId: 'flow',
  profileId: 'flow',
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  visualArtifacts: await visualArtifactSetWithCas({
    before: path.join(visualDir, 'before-hmr-first.png'),
    after: path.join(visualDir, 'after-hmr-first.png'),
    diff: path.join(visualDir, 'before-after-diff.png'),
  }),
  visualMetrics: {
    changedPixelRatio: 0.042,
    meanAbsDelta8bit: 6.5,
    visiblePixelCount: 2000,
  },
};

function waitProofValidation(proofId, runtimeProofId) {
  return {
    gpuProofValidation: {
      satisfied: true,
      proofLedgerValidation: {
        proofId,
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
      runtimeProofArtifactValidation: {
        accepted: true,
        failedGates: [],
      },
    },
    gpuProofTelemetry: {
      proofId: runtimeProofId,
    },
  };
}

function runModeCoverageSupportFor(materials, extraProofIds = [], options = {}) {
  const record = materials.proofLedgerQuery?.record ?? materials.proofLedger?.records?.[0] ?? {};
  const support = buildGpuHmrRunModeCoverageSupport({
    proofLedger: materials.proofLedger,
    proofLedgerQuery: materials.proofLedgerQuery,
    runtimeProofArtifact: materials.runtimeProofArtifact,
    parentProofIds: extraProofIds,
  });
  const artifactAfterHash = record.artifactAfterHash ?? record.artifact_after_hash;
  const namespaceArtifactAfterHash = options.namespaceArtifactAfterHash !== false;
  const selectedArtifactAfterHash = namespaceArtifactAfterHash && String(artifactAfterHash ?? '').startsWith('sha256:')
    ? `artifact:${artifactAfterHash}`
    : artifactAfterHash;
  return {
    ...support,
    artifactAfterHash: selectedArtifactAfterHash,
    artifact_after_hash: selectedArtifactAfterHash,
  };
}

function validationProfileEvidenceFor({
  profileId,
  profileClass,
  evidenceRefs,
  proofIds,
  source = 'agent_split_run_mode_visual_ledger_recomputed',
  profileHash = null,
  sourceContentHash = null,
  declaredSourceContentHash = null,
  deterministicVisualModeHash = null,
  visualProofHash = null,
  visualSceneManifestHash = null,
}) {
  return {
    schemaVersion: 'synthi.gpu.hmr.validation_profile_evidence.v1',
    accepted: true,
    profileId,
    profileClass,
    source,
    profileHash,
    profile_hash: profileHash,
    sourceContentHash,
    source_content_hash: sourceContentHash,
    declaredSourceContentHash,
    declared_source_content_hash: declaredSourceContentHash,
    deterministicVisualModeHash,
    deterministic_visual_mode_hash: deterministicVisualModeHash,
    visualProofHash,
    visual_proof_hash: visualProofHash,
    visualSceneManifestHash,
    visual_scene_manifest_hash: visualSceneManifestHash,
    evidenceRefs,
    proofIds,
  };
}

function sourceFirstIngestionEvidenceFor({
  targetId = 'flow',
  entryPath = 'src/main.cpp',
  sourceHash = hashValue(`${targetId}:seed-source`),
  sourceAuthority = 'builtin_fixture_source',
  sourceUrl = `https://example.invalid/source-first/${targetId}.git`,
  repoPath = null,
  immutableCommit = '2222222222222222222222222222222222222222',
  directSourceInputEvidence = undefined,
  sourceTreeManifestHash = null,
  useAiSplit = true,
  userRequestedAi = true,
  preferGpuPipeline = true,
  gpuArch = 'gfx-self-check',
  gpuArchSource = 'self_check_fixture',
  gpuSplitEndpointObserved = true,
  preexistingGeneratedArtifactPaths = [],
  generatedArtifactHashes = [hashValue(`${targetId}:generated-device`)],
  generatedArtifactPaths = ['.synthi/generated/gpu/device.hip'],
  sidecarHash = hashValue(`${targetId}:sidecar`),
  compileManifestHash = hashValue(`${targetId}:manifest`),
  initialFiles,
  sourcePurityEvidence = null,
  accepted = true,
} = {}) {
  const normalizedInitialFiles = initialFiles ?? [{
    path: entryPath,
    contentHash: sourceHash,
    content_hash: sourceHash,
    byteLength: 4096,
    byte_length: 4096,
  }];
  const normalizedSourcePurityEvidence = sourcePurityEvidence ?? {
    schemaVersion: 'synthi.gpu.hmr.agent_split_source_purity.v1',
    accepted: true,
    noSynthiAbiInSeedSource: true,
    no_synthi_abi_in_seed_source: true,
    forbiddenMarkersChecked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
    forbidden_markers_checked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
    forbiddenMarkersFound: [],
    forbidden_markers_found: [],
    scannedFiles: normalizedInitialFiles.map((entry) => ({
      path: entry.path,
      contentHash: entry.contentHash ?? entry.content_hash,
      content_hash: entry.contentHash ?? entry.content_hash,
      byteLength: entry.byteLength ?? entry.byte_length,
      byte_length: entry.byteLength ?? entry.byte_length,
      accepted: true,
      forbiddenMarkersFound: [],
      forbidden_markers_found: [],
    })),
  };
  normalizedSourcePurityEvidence.purityManifestHash ??=
    contentHashFor(normalizedSourcePurityEvidence.scannedFiles ?? normalizedSourcePurityEvidence.scanned_files ?? []);
  normalizedSourcePurityEvidence.purity_manifest_hash ??= normalizedSourcePurityEvidence.purityManifestHash;
  normalizedSourcePurityEvidence.sourceContentHash ??= sourceHash;
  normalizedSourcePurityEvidence.source_content_hash ??= sourceHash;
  const noSynthiAbiInSeedSource =
    normalizedSourcePurityEvidence.accepted === true
    && (
      normalizedSourcePurityEvidence.noSynthiAbiInSeedSource === true
      || normalizedSourcePurityEvidence.no_synthi_abi_in_seed_source === true
    );
  const initialManifestHash = contentHashFor(normalizedInitialFiles);
  const sourcePurityInitialManifestEntries =
    (normalizedSourcePurityEvidence.scannedFiles ?? normalizedSourcePurityEvidence.scanned_files ?? [])
      .map((entry) => ({
        path: entry.path,
        contentHash: entry.contentHash ?? entry.content_hash,
        content_hash: entry.contentHash ?? entry.content_hash,
        byteLength: entry.byteLength ?? entry.byte_length,
        byte_length: entry.byteLength ?? entry.byte_length,
      }));
  const sourcePurityInitialManifestHash = contentHashFor(sourcePurityInitialManifestEntries);
  const effectiveSourceTreeManifestHash = sourceTreeManifestHash
    ?? (sourceAuthority === 'profile_source_files' ? initialManifestHash : null);
  const directSourceAuthority =
    sourceAuthority === 'direct_source_url_commit'
    || sourceAuthority === 'direct_local_git_repo_path';
  const effectiveSourceUrl = sourceAuthority === 'direct_source_url_commit'
    ? sourceUrl
    : null;
  const effectiveRepoPath = sourceAuthority === 'direct_local_git_repo_path'
    ? (repoPath ?? `C:/example/source-first/${targetId}`)
    : null;
  const effectiveDirectSourceInputEvidence =
    directSourceInputEvidence !== undefined
      ? directSourceInputEvidence
      : directSourceAuthority
        ? randomColdDirectInputEvidenceFixture({
          candidateSource: sourceAuthority,
          sourceUrl: effectiveSourceUrl,
          repoPath: effectiveRepoPath,
          immutableCommit,
        })
        : null;
  const proofId = `agent-split-source-first-ingestion:sha256:${sha256Hex(stableJson({
    sourceContentHash: sourceHash,
    entryPath,
    targetId,
    initialManifestHash,
    sourcePurityManifestHash: normalizedSourcePurityEvidence.purityManifestHash,
    sourcePurityInitialManifestHash,
    gpuArch,
    gpuArchSource,
    generatedArtifactHashes,
    sidecarHash,
    compileManifestHash,
  }))}`;
  return {
    schemaVersion: 'synthi.gpu.hmr.agent_split_source_first_ingestion.v1',
    accepted,
    proofId,
    proofAuthority: 'source_first_ingestion_provenance_only_not_runtime_proof',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    sourceAuthority,
    source_authority: sourceAuthority,
    ...(directSourceAuthority ? {
      sourceUrl: effectiveSourceUrl,
      source_url: effectiveSourceUrl,
      repoPath: effectiveRepoPath,
      repo_path: effectiveRepoPath,
      immutableCommit,
      immutable_commit: immutableCommit,
      directSourceInputEvidence: effectiveDirectSourceInputEvidence,
      direct_source_input_evidence: effectiveDirectSourceInputEvidence,
    } : {}),
    sourceContentHash: sourceHash,
    noSynthiAbiInSeedSource,
    no_synthi_abi_in_seed_source: noSynthiAbiInSeedSource,
    sourcePurityEvidence: normalizedSourcePurityEvidence,
    source_purity_evidence: normalizedSourcePurityEvidence,
    sourcePurityManifestHash: normalizedSourcePurityEvidence.purityManifestHash,
    source_purity_manifest_hash: normalizedSourcePurityEvidence.purityManifestHash,
    sourcePurityInitialManifestHash,
    source_purity_initial_manifest_hash: sourcePurityInitialManifestHash,
    entryPath,
    seededWorkspacePath: entryPath,
    initialCompileContract: {
      filename: entryPath,
      initialFilePaths: normalizedInitialFiles.map((entry) => entry.path),
      initialFiles: normalizedInitialFiles,
      initialManifestHash,
      sourceTreeManifestHash: effectiveSourceTreeManifestHash,
      sourcePurityManifestHash: normalizedSourcePurityEvidence.purityManifestHash,
      sourcePurityInitialManifestHash,
      ...(directSourceAuthority ? {
        sourceUrl: effectiveSourceUrl,
        source_url: effectiveSourceUrl,
        repoPath: effectiveRepoPath,
        repo_path: effectiveRepoPath,
        immutableCommit,
        immutable_commit: immutableCommit,
        directSourceInputEvidence: effectiveDirectSourceInputEvidence,
        direct_source_input_evidence: effectiveDirectSourceInputEvidence,
      } : {}),
      useAiSplit,
      userRequestedAi,
      preferGpuPipeline,
      gpuArch,
      gpu_arch: gpuArch,
      gpuArchSource,
      gpu_arch_source: gpuArchSource,
    },
    initialFilePaths: normalizedInitialFiles.map((entry) => entry.path),
    initialFiles: normalizedInitialFiles,
    initialManifestHash,
    sourceTreeManifestHash: effectiveSourceTreeManifestHash,
    initialSourceFilePresent: normalizedInitialFiles.some((entry) => entry.path === entryPath),
    initialSourceHashMatches: normalizedInitialFiles.some((entry) =>
      entry.path === entryPath && (entry.contentHash ?? entry.content_hash) === sourceHash
    ),
    preexistingGeneratedArtifactsPresent: preexistingGeneratedArtifactPaths.length > 0,
    preexistingGeneratedArtifactPaths,
    gpuSplitEndpointObserved,
    generatedArtifactCreatedAfterAiSplit: true,
    generatedArtifactPaths,
    generatedArtifactHashes,
    sidecarHash,
    compileManifestHash,
    targetId,
    evidenceRefs: [
      proofId,
      sourceHash,
      initialManifestHash,
      sourcePurityInitialManifestHash,
      normalizedSourcePurityEvidence.purityManifestHash,
      effectiveSourceTreeManifestHash,
      effectiveDirectSourceInputEvidence?.sourceIdentityHash,
      effectiveDirectSourceInputEvidence?.source_identity_hash,
      sidecarHash,
      compileManifestHash,
      ...generatedArtifactHashes,
    ].filter(Boolean),
  };
}

const flowHot1RuntimeMaterials = runtimeProofMaterials('hot_delta_1');
const flowHot2RuntimeMaterials = runtimeProofMaterials('hot_delta_2');
const flowRunModeCoverageSupport = runModeCoverageSupportFor(flowHot1RuntimeMaterials, [
  'gpu-runtime-proof:sha256:synthetic-hot1',
  'agent-split-run-mode-proof:sha256:hot1',
]);
assert.match(flowRunModeCoverageSupport.artifactAfterHash, /^artifact:sha256:[a-f0-9]{64}$/);
const flowHot1VisualProfileEvidence = validationProfileEvidenceFor({
  profileId: 'flow',
  profileClass: 'flow_visual_gpu_path',
  evidenceRefs: [
    'evidence:validation-profile:flow:runtime-visual',
    flowHot1RuntimeMaterials.proofLedgerQuery.record.proofId,
  ],
  proofIds: [
    'agent-split-run-mode-proof:sha256:hot1',
    flowHot1RuntimeMaterials.proofLedgerQuery.record.proofId,
    flowHot1RuntimeMaterials.runtimeProofArtifact.proofId,
  ],
});
const flowHot2VisualProfileEvidence = validationProfileEvidenceFor({
  profileId: 'flow',
  profileClass: 'flow_visual_gpu_path',
  source: 'agent_split_profile_runtime_visual_proof',
  evidenceRefs: [
    'evidence:validation-profile:flow:runtime-visual',
    flowHot2RuntimeMaterials.proofLedgerQuery.record.proofId,
  ],
  proofIds: [
    'agent-split-run-mode-proof:sha256:hot2',
    flowHot2RuntimeMaterials.proofLedgerQuery.record.proofId,
    flowHot2RuntimeMaterials.runtimeProofArtifact.proofId,
  ],
});

const flowColdRunMode = {
  metricClock: 'monotonic_ns',
  metricScope: 'cold',
  cacheState: 'clean',
  editId: 'initial-ai-split',
  editHash: hashValue('cold-split'),
};
const flowColdRunModeCoverageSupport = bindGpuHmrRunModeCoverageSupport(
  flowRunModeCoverageSupport,
  { runMode: flowColdRunMode },
);

await writeJson(path.join(visualDir, 'run-mode-cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  proofId: 'agent-split-run-mode-proof:sha256:cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: flowColdRunModeCoverageSupport,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: flowColdRunMode,
});

const forgedFailedSupportColdRunMode = {
  metricClock: 'monotonic_ns',
  metricScope: 'cold',
  cacheState: 'clean',
  editId: 'initial-ai-split:forged-failed-support',
  editHash: hashValue('cold-split-forged-failed-support'),
};
await writeJson(path.join(visualDir, 'run-mode-cold-forged-failed-support.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  proofId: 'agent-split-run-mode-proof:sha256:forged-failed-support-cold',
  profileId: 'flow-forged-failed-support-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: {
    ...bindGpuHmrRunModeCoverageSupport(
      flowRunModeCoverageSupport,
      { runMode: forgedFailedSupportColdRunMode },
    ),
    proofLedgerSuccess: false,
    proof_ledger_success: false,
    runtimeProofArtifactGpuHmrSuccess: false,
    runtime_proof_artifact_gpu_hmr_success: false,
    runtimeProofArtifactFullRuntimeProven: false,
    runtime_proof_artifact_full_runtime_proven: false,
  },
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: forgedFailedSupportColdRunMode,
});

await writeJson(path.join(visualDir, 'run-mode-cold-forged-borrowed-support.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  proofId: 'agent-split-run-mode-proof:sha256:forged-borrowed-support-cold',
  profileId: 'flow-forged-borrowed-support-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: flowColdRunModeCoverageSupport,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split:forged-borrowed-support',
    editHash: hashValue('cold-split-forged-borrowed-support'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation('gpu-ledger-proof:sha256:synthetic-hot1', 'gpu-runtime-proof:sha256:synthetic-hot1'),
  ...flowHot1RuntimeMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:hot1',
  validationProfileEvidence: flowHot1VisualProfileEvidence,
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({ targetId: 'flow' }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1',
    editHash: hashValue('source-edit:hot1'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1-source-first-no-cas.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-first-no-cas',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-first-no-cas',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-first-no-cas',
  }),
  targetId: 'flow-source-first-no-cas',
  profileId: 'flow-source-first-no-cas',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-first-no-cas',
  coverageObligations: {
    perTargetRunModes: false,
  },
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-first-no-cas',
  }),
  visualArtifacts: visualArtifactSet({
    before: path.join(visualDir, 'before-hmr-first.png'),
    after: path.join(visualDir, 'after-hmr-first.png'),
    diff: path.join(visualDir, 'before-after-diff.png'),
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-first-no-cas',
    editHash: hashValue('source-edit:hot1-source-first-no-cas'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1-source-first-cas-only.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-first-cas-only',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-first-cas-only',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-first-cas-only',
  }),
  targetId: 'flow-source-first-cas-only',
  profileId: 'flow-source-first-cas-only',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-first-cas-only',
  coverageObligations: {
    perTargetRunModes: false,
  },
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-first-cas-only',
  }),
  visualArtifacts: visualArtifactSetWithoutLocalPaths(runModeProofBase.visualArtifacts),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-first-cas-only',
    editHash: hashValue('source-edit:hot1-source-first-cas-only'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1-source-first-forged-cas.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-first-forged-cas',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-first-forged-cas',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-first-forged-cas',
  }),
  targetId: 'flow-source-first-forged-cas',
  profileId: 'flow-source-first-forged-cas',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-first-forged-cas',
  coverageObligations: {
    perTargetRunModes: false,
  },
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-first-forged-cas',
  }),
  visualArtifacts: forgedVisualArtifactCasOnlySet(runModeProofBase.visualArtifacts),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-first-forged-cas',
    editHash: hashValue('source-edit:hot1-source-first-forged-cas'),
  },
});

const forgedVisualJobArtifacts = visualArtifactSetWithoutLocalPaths(runModeProofBase.visualArtifacts);
await writeJson(path.join(visualDir, 'run-mode-hot1-source-first-forged-visual-job.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-first-forged-visual-job',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-first-forged-visual-job',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-first-forged-visual-job',
  }),
  targetId: 'flow-source-first-forged-visual-job',
  profileId: 'flow-source-first-forged-visual-job',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-first-forged-visual-job',
  coverageObligations: {
    perTargetRunModes: false,
  },
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-first-forged-visual-job',
  }),
  visualArtifacts: forgedVisualJobArtifacts,
  asyncVisualProofJob: forgedAsyncVisualProofJobForVisualArtifacts(
    forgedVisualJobArtifacts,
    'flow-source-first-forged-visual-job',
  ),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-first-forged-visual-job',
    editHash: hashValue('source-edit:hot1-source-first-forged-visual-job'),
  },
});

const nonVisualMetadataVisualLocator = cloneJson(
  runModeProofBase.visualArtifacts.artifactCasLocators[0],
);
nonVisualMetadataVisualLocator.mediaType = 'application/octet-stream';
nonVisualMetadataVisualLocator.media_type = 'application/octet-stream';
nonVisualMetadataVisualLocator.artifactKind = 'runtime_adapter_compute_readback';
nonVisualMetadataVisualLocator.artifact_kind = 'runtime_adapter_compute_readback';
nonVisualMetadataVisualLocator.role = 'raw_readback';
await writeJson(path.join(visualDir, 'run-mode-hot1-source-first-nonvisual-cas-metadata.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-first-nonvisual-cas-metadata',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-first-nonvisual-cas-metadata',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-first-nonvisual-cas-metadata',
  }),
  targetId: 'flow-source-first-nonvisual-cas-metadata',
  profileId: 'flow-source-first-nonvisual-cas-metadata',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-first-nonvisual-cas-metadata',
  coverageObligations: {
    perTargetRunModes: false,
  },
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-first-nonvisual-cas-metadata',
  }),
  visualArtifacts: forgedNonVisualCasVisualTransportSet(
    runModeProofBase.visualArtifacts,
    nonVisualMetadataVisualLocator,
  ),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-first-nonvisual-cas-metadata',
    editHash: hashValue('source-edit:hot1-source-first-nonvisual-cas-metadata'),
  },
});

const pendingVisualJobHash = hashValue('flow-source-first-pending-visual-job-only');
await writeJson(path.join(visualDir, 'run-mode-hot1-source-first-pending-visual-job-only.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-first-pending-visual-job-only',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-first-pending-visual-job-only',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-first-pending-visual-job-only',
  }),
  targetId: 'flow-source-first-pending-visual-job-only',
  profileId: 'flow-source-first-pending-visual-job-only',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-first-pending-visual-job-only',
  coverageObligations: {
    perTargetRunModes: false,
  },
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-first-pending-visual-job-only',
  }),
  visualArtifacts: {},
  asyncVisualProofJob: {
    schemaVersion: 'synthi.gpu_hmr.async_visual_proof_job.v1',
    eventType: 'proof_pending',
    proofPending: true,
    proofReady: false,
    accepted: false,
    acceptedAsAsyncVisualProofJob: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'async_visual_job_manifest_only_not_gpu_hmr_acceptance',
    jobHash: pendingVisualJobHash,
    jobManifestHash: pendingVisualJobHash,
    artifactCasLocators: [],
  },
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-first-pending-visual-job-only',
    editHash: hashValue('source-edit:hot1-source-first-pending-visual-job-only'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-profile-priority-hot1.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  targetId: 'profile-priority-generated-target',
  profileId: 'agent-realistic-test-profile',
  profile_id: 'agent-realistic-test-profile',
  validationProfileId: 'agent-realistic-test-profile',
  validation_profile_id: 'agent-realistic-test-profile',
  fixtureId: 'flow',
  fixture_id: 'flow',
  proofId: 'agent-split-run-mode-proof:sha256:profile-priority-hot1',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'profile-priority-generated-target',
  }),
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:profile-priority-hot1',
    editHash: hashValue('source-edit:profile-priority-hot1'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1-smuggled-precompiled.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-smuggled-precompiled',
    'gpu-runtime-proof:sha256:synthetic-hot1-smuggled-precompiled',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-smuggled-precompiled',
  }),
  targetId: 'flow-smuggled-precompiled',
  profileId: 'flow-smuggled-precompiled',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-smuggled-precompiled',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-smuggled-precompiled',
    useAiSplit: false,
    preexistingGeneratedArtifactPaths: ['.synthi/generated/gpu/device.hip'],
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-smuggled-precompiled',
    editHash: hashValue('source-edit:hot1-smuggled-precompiled'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1-source-first-missing-arch.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-first-missing-arch',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-first-missing-arch',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-first-missing-arch',
  }),
  targetId: 'flow-source-first-missing-arch',
  profileId: 'flow-source-first-missing-arch',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-first-missing-arch',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-first-missing-arch',
    gpuArch: null,
    gpuArchSource: null,
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-first-missing-arch',
    editHash: hashValue('source-edit:hot1-source-first-missing-arch'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1-forged-generated-source-path.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-forged-generated-source-path',
    'gpu-runtime-proof:sha256:synthetic-hot1-forged-generated-source-path',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-forged-generated-source-path',
  }),
  targetId: 'flow-forged-generated-source-path',
  profileId: 'flow-forged-generated-source-path',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-forged-generated-source-path',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-forged-generated-source-path',
    generatedArtifactPaths: ['src/main.cpp'],
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-forged-generated-source-path',
    editHash: hashValue('source-edit:hot1-forged-generated-source-path'),
  },
});

const precompiledHashOverlapGeneratedHash = hashValue('flow-precompiled-hash-overlap:generated-device');
await writeJson(path.join(visualDir, 'run-mode-hot1-precompiled-hash-overlap.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-precompiled-hash-overlap',
    'gpu-runtime-proof:sha256:synthetic-hot1-precompiled-hash-overlap',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-precompiled-hash-overlap',
  }),
  targetId: 'flow-precompiled-hash-overlap',
  profileId: 'flow-precompiled-hash-overlap',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-precompiled-hash-overlap',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-precompiled-hash-overlap',
    generatedArtifactHashes: [precompiledHashOverlapGeneratedHash],
    initialFiles: [
      {
        path: 'src/main.cpp',
        contentHash: hashValue('flow-precompiled-hash-overlap:seed-source'),
        content_hash: hashValue('flow-precompiled-hash-overlap:seed-source'),
        byteLength: 4096,
        byte_length: 4096,
      },
      {
        path: 'build/cache/device.hip',
        contentHash: precompiledHashOverlapGeneratedHash,
        content_hash: precompiledHashOverlapGeneratedHash,
        byteLength: 8192,
        byte_length: 8192,
      },
    ],
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-precompiled-hash-overlap',
    editHash: hashValue('source-edit:hot1-precompiled-hash-overlap'),
  },
});

const incompletePurityMainHash = hashValue('flow-incomplete-source-purity:seed-source');
const incompletePurityHeaderHash = hashValue('flow-incomplete-source-purity:header');
const incompletePurityInitialFiles = [
  {
    path: 'src/main.cpp',
    contentHash: incompletePurityMainHash,
    content_hash: incompletePurityMainHash,
    byteLength: 4096,
    byte_length: 4096,
  },
  {
    path: 'include/params.hpp',
    contentHash: incompletePurityHeaderHash,
    content_hash: incompletePurityHeaderHash,
    byteLength: 256,
    byte_length: 256,
  },
];
await writeJson(path.join(visualDir, 'run-mode-hot1-incomplete-source-purity.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-incomplete-source-purity',
    'gpu-runtime-proof:sha256:synthetic-hot1-incomplete-source-purity',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-incomplete-source-purity',
  }),
  targetId: 'flow-incomplete-source-purity',
  profileId: 'flow-incomplete-source-purity',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-incomplete-source-purity',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-incomplete-source-purity',
    sourceHash: incompletePurityMainHash,
    initialFiles: incompletePurityInitialFiles,
    sourcePurityEvidence: {
      schemaVersion: 'synthi.gpu.hmr.agent_split_source_purity.v1',
      accepted: true,
      noSynthiAbiInSeedSource: true,
      no_synthi_abi_in_seed_source: true,
      forbiddenMarkersChecked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
      forbidden_markers_checked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
      forbiddenMarkersFound: [],
      forbidden_markers_found: [],
      scannedFiles: [{
        path: 'src/main.cpp',
        contentHash: incompletePurityMainHash,
        content_hash: incompletePurityMainHash,
        byteLength: 4096,
        byte_length: 4096,
        accepted: true,
        forbiddenMarkersFound: [],
        forbidden_markers_found: [],
      }],
    },
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-incomplete-source-purity',
    editHash: hashValue('source-edit:hot1-incomplete-source-purity'),
  },
});

const forgedPurityInitialHashMainHash = hashValue('flow-forged-source-purity-initial-hash:seed-source');
const forgedPurityInitialHashHeaderHash = hashValue('flow-forged-source-purity-initial-hash:header');
const forgedPurityInitialHashFiles = [
  {
    path: 'src/main.cpp',
    contentHash: forgedPurityInitialHashMainHash,
    content_hash: forgedPurityInitialHashMainHash,
    byteLength: 4096,
    byte_length: 4096,
  },
  {
    path: 'include/params.hpp',
    contentHash: forgedPurityInitialHashHeaderHash,
    content_hash: forgedPurityInitialHashHeaderHash,
    byteLength: 256,
    byte_length: 256,
  },
];
const forgedPurityInitialHash = contentHashFor(forgedPurityInitialHashFiles);
const forgedPurityInitialHashEvidence = sourceFirstIngestionEvidenceFor({
  targetId: 'flow-forged-source-purity-initial-hash',
  sourceHash: forgedPurityInitialHashMainHash,
  initialFiles: forgedPurityInitialHashFiles,
  sourcePurityEvidence: {
    schemaVersion: 'synthi.gpu.hmr.agent_split_source_purity.v1',
    accepted: true,
    noSynthiAbiInSeedSource: true,
    no_synthi_abi_in_seed_source: true,
    forbiddenMarkersChecked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
    forbidden_markers_checked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
    forbiddenMarkersFound: [],
    forbidden_markers_found: [],
    scannedFiles: [{
      path: 'src/main.cpp',
      contentHash: forgedPurityInitialHashMainHash,
      content_hash: forgedPurityInitialHashMainHash,
      byteLength: 4096,
      byte_length: 4096,
      accepted: true,
      forbiddenMarkersFound: [],
      forbidden_markers_found: [],
    }],
  },
  accepted: true,
});
forgedPurityInitialHashEvidence.sourcePurityInitialManifestHash = forgedPurityInitialHash;
forgedPurityInitialHashEvidence.source_purity_initial_manifest_hash = forgedPurityInitialHash;
forgedPurityInitialHashEvidence.initialCompileContract.sourcePurityInitialManifestHash = forgedPurityInitialHash;
forgedPurityInitialHashEvidence.initialCompileContract.source_purity_initial_manifest_hash = forgedPurityInitialHash;
forgedPurityInitialHashEvidence.initial_compile_contract ??= {
  ...forgedPurityInitialHashEvidence.initialCompileContract,
};
forgedPurityInitialHashEvidence.initial_compile_contract.sourcePurityInitialManifestHash = forgedPurityInitialHash;
forgedPurityInitialHashEvidence.initial_compile_contract.source_purity_initial_manifest_hash = forgedPurityInitialHash;
await writeJson(path.join(visualDir, 'run-mode-hot1-forged-source-purity-initial-hash.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-forged-source-purity-initial-hash',
    'gpu-runtime-proof:sha256:synthetic-hot1-forged-source-purity-initial-hash',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-forged-source-purity-initial-hash',
  }),
  targetId: 'flow-forged-source-purity-initial-hash',
  profileId: 'flow-forged-source-purity-initial-hash',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-forged-source-purity-initial-hash',
  sourceFirstIngestion: forgedPurityInitialHashEvidence,
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-forged-source-purity-initial-hash',
    editHash: hashValue('source-edit:hot1-forged-source-purity-initial-hash'),
  },
});

const extraPurityMainHash = hashValue('flow-extra-source-purity:seed-source');
const extraPurityInitialFiles = [{
  path: 'src/main.cpp',
  contentHash: extraPurityMainHash,
  content_hash: extraPurityMainHash,
  byteLength: 4096,
  byte_length: 4096,
}];
await writeJson(path.join(visualDir, 'run-mode-hot1-extra-source-purity.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-extra-source-purity',
    'gpu-runtime-proof:sha256:synthetic-hot1-extra-source-purity',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-extra-source-purity',
  }),
  targetId: 'flow-extra-source-purity',
  profileId: 'flow-extra-source-purity',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-extra-source-purity',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-extra-source-purity',
    sourceHash: extraPurityMainHash,
    initialFiles: extraPurityInitialFiles,
    sourcePurityEvidence: {
      schemaVersion: 'synthi.gpu.hmr.agent_split_source_purity.v1',
      accepted: true,
      noSynthiAbiInSeedSource: true,
      no_synthi_abi_in_seed_source: true,
      forbiddenMarkersChecked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
      forbidden_markers_checked: ['core_on_update', 'gui_on_render', 'device_on_load', 'device_descriptor', 'synthi_gpu_launch'],
      forbiddenMarkersFound: [],
      forbidden_markers_found: [],
      scannedFiles: [
        {
          path: 'src/main.cpp',
          contentHash: extraPurityMainHash,
          content_hash: extraPurityMainHash,
          byteLength: 4096,
          byte_length: 4096,
          accepted: true,
          forbiddenMarkersFound: [],
          forbidden_markers_found: [],
        },
        {
          path: 'tmp/generated-cache.hip',
          contentHash: hashValue('flow-extra-source-purity:extra-cache'),
          content_hash: hashValue('flow-extra-source-purity:extra-cache'),
          byteLength: 1024,
          byte_length: 1024,
          accepted: true,
          forbiddenMarkersFound: [],
          forbidden_markers_found: [],
        },
      ],
    },
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-extra-source-purity',
    editHash: hashValue('source-edit:hot1-extra-source-purity'),
  },
});

const sourceTreeManifestMismatchMainHash = hashValue('flow-source-tree-manifest-mismatch:seed-source');
const sourceTreeManifestMismatchFullTree = [
  {
    path: 'CMakeLists.txt',
    contentHash: hashValue('flow-source-tree-manifest-mismatch:cmake'),
    content_hash: hashValue('flow-source-tree-manifest-mismatch:cmake'),
    byteLength: 128,
    byte_length: 128,
  },
  {
    path: 'include/params.hpp',
    contentHash: hashValue('flow-source-tree-manifest-mismatch:params'),
    content_hash: hashValue('flow-source-tree-manifest-mismatch:params'),
    byteLength: 256,
    byte_length: 256,
  },
  {
    path: 'src/main.cpp',
    contentHash: sourceTreeManifestMismatchMainHash,
    content_hash: sourceTreeManifestMismatchMainHash,
    byteLength: 4096,
    byte_length: 4096,
  },
];
await writeJson(path.join(visualDir, 'run-mode-hot1-source-tree-manifest-mismatch.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-source-tree-manifest-mismatch',
    'gpu-runtime-proof:sha256:synthetic-hot1-source-tree-manifest-mismatch',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-source-tree-manifest-mismatch',
  }),
  targetId: 'flow-source-tree-manifest-mismatch',
  profileId: 'flow-source-tree-manifest-mismatch',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-source-tree-manifest-mismatch',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-source-tree-manifest-mismatch',
    sourceHash: sourceTreeManifestMismatchMainHash,
    sourceAuthority: 'profile_source_files',
    sourceTreeManifestHash: contentHashFor(sourceTreeManifestMismatchFullTree),
    initialFiles: [
      {
        path: 'src/main.cpp',
        contentHash: sourceTreeManifestMismatchMainHash,
        content_hash: sourceTreeManifestMismatchMainHash,
        byteLength: 4096,
        byte_length: 4096,
      },
    ],
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-source-tree-manifest-mismatch',
    editHash: hashValue('source-edit:hot1-source-tree-manifest-mismatch'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1-empty-source-manifest.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:synthetic-hot1-empty-source-manifest',
    'gpu-runtime-proof:sha256:synthetic-hot1-empty-source-manifest',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow-empty-source-manifest',
  }),
  targetId: 'flow-empty-source-manifest',
  profileId: 'flow-empty-source-manifest',
  proofId: 'agent-split-run-mode-proof:sha256:hot1-empty-source-manifest',
  sourceFirstIngestion: sourceFirstIngestionEvidenceFor({
    targetId: 'flow-empty-source-manifest',
    initialFiles: [],
    accepted: true,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1-empty-source-manifest',
    editHash: hashValue('source-edit:hot1-empty-source-manifest'),
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot2.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation('gpu-ledger-proof:sha256:synthetic-hot2', 'gpu-runtime-proof:sha256:synthetic-hot2'),
  ...flowHot2RuntimeMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:hot2',
  validationProfileEvidence: flowHot2VisualProfileEvidence,
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot2',
    editHash: hashValue('source-edit:hot2'),
    editKind: 'different_gpu_edit',
    differentEdit: true,
  },
});

await writeJson(path.join(visualDir, 'run-mode-forged-readable-no-hash-diff.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-readable-no-hash-diff',
    'gpu-runtime-proof:sha256:forged-readable-no-hash-diff',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-readable-no-hash-diff',
  }),
  targetId: 'forged-readable-no-hash-diff',
  profileId: 'forged-readable-no-hash-diff',
  proofId: 'agent-split-run-mode-proof:sha256:forged-readable-no-hash-diff',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(visualDir, 'before-hmr-first.png'),
    afterImage: path.join(visualDir, 'after-hmr-first.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-readable-no-hash-diff',
    editHash: hashValue('forged-readable-no-hash-diff'),
    editKind: 'gpu_artifact_edit',
  },
});

const visualDimensionMismatchDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-visual-dimension-mismatch',
);
const visualDimensionMismatchBefore = path.join(visualDimensionMismatchDir, 'before-hmr-first.png');
const visualDimensionMismatchAfter = path.join(visualDimensionMismatchDir, 'after-hmr-first.png');
const visualDimensionMismatchDiff = path.join(visualDimensionMismatchDir, 'before-after-diff.png');
await writeRgbaPng(visualDimensionMismatchBefore, 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(visualDimensionMismatchAfter, 16, 8, (x, y) => [96 + x, 112 + y, 144, 255]);
await writeRgbaPng(visualDimensionMismatchDiff, 16, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(visualDimensionMismatchDir, 'run-mode-visual-dimension-mismatch.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:visual-dimension-mismatch',
    'gpu-runtime-proof:sha256:visual-dimension-mismatch',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'visual-dimension-mismatch',
    visualRoot: visualDimensionMismatchDir,
  }),
  targetId: 'visual-dimension-mismatch',
  profileId: 'visual-dimension-mismatch',
  proofId: 'agent-split-run-mode-proof:sha256:visual-dimension-mismatch',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: visualDimensionMismatchBefore,
    after: visualDimensionMismatchAfter,
    diff: visualDimensionMismatchDiff,
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:visual-dimension-mismatch',
    editHash: hashValue('visual-dimension-mismatch'),
    editKind: 'gpu_artifact_edit',
  },
});

const webgpuSingleFrameColdDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-webgpu-single-frame-cold');
await writeRgbaPng(path.join(webgpuSingleFrameColdDir, 'initial-frame.png'), 8, 8, (x, y) =>
  x >= y ? [20 + x, 64 + y, 180, 255] : [0, 0, 0, 255]);
await writeJson(path.join(webgpuSingleFrameColdDir, 'run-mode-cold-single-frame.json'), {
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  backend: 'webgpu',
  targetId: 'webgpu-single-frame-cold',
  profileId: 'webgpu-single-frame-cold',
  proofId: 'agent-split-run-mode-proof:sha256:webgpu-single-frame-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  visualArtifacts: {
    beforeImage: path.join(webgpuSingleFrameColdDir, 'initial-frame.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-webgpu-frame',
    editHash: hashValue('webgpu-single-frame-cold'),
  },
});
await writeJson(path.join(webgpuSingleFrameColdDir, 'run-mode-hot-single-frame-forged.json'), {
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  backend: 'webgpu',
  targetId: 'webgpu-single-frame-hot-forged',
  profileId: 'webgpu-single-frame-hot-forged',
  proofId: 'agent-split-run-mode-proof:sha256:webgpu-single-frame-hot-forged',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:webgpu-single-frame-hot-forged',
    'gpu-runtime-proof:sha256:webgpu-single-frame-hot-forged',
  ),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  visualArtifacts: {
    beforeImage: path.join(webgpuSingleFrameColdDir, 'initial-frame.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:webgpu-single-frame-hot-forged',
    editHash: hashValue('webgpu-single-frame-hot-forged'),
  },
});

const strictMissingArtifactMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'strict-runtime-missing-artifact',
});
await writeJson(path.join(artifactsRoot, 'strict-runtime-ledger', 'missing-runtime-proof-artifact.json'), {
  schemaVersion: 'synthi.gpu.hmr.proof.v1',
  proofId: 'gpu-runtime-proof:sha256:strict-missing-runtime-artifact',
  target_name: 'strict-runtime-missing-artifact',
  gpuHmrSuccess: true,
  fullRuntimeProven: true,
  resultState: 'gpu-hmr-full-runtime-proven',
  acceptanceContract: acceptanceContract('strict_missing_runtime_artifact', {
    projectId: 'strict-runtime-missing-artifact',
  }),
  proofLedger: strictMissingArtifactMaterials.proofLedger,
  proof_ledger: strictMissingArtifactMaterials.proof_ledger,
  proofLedgerQuery: strictMissingArtifactMaterials.proofLedgerQuery,
  proof_ledger_query: strictMissingArtifactMaterials.proof_ledger_query,
});

const strictComputeMissingReadbackPath = path.join(
  artifactsRoot,
  'strict-runtime-ledger',
  'missing-compute-readback.bin',
);
const strictComputeMissingReadbackMaterials = computeProofLedgerMaterials('strict-compute-missing-readback', {
  projectId: 'strict-runtime-compute-missing-readback',
  rawReadbackPath: strictComputeMissingReadbackPath,
});
await writeJson(path.join(artifactsRoot, 'strict-runtime-ledger', 'missing-compute-readback.json'), {
  schemaVersion: 'synthi.gpu.hmr.proof.v1',
  proofId: 'gpu-runtime-proof:sha256:strict-compute-missing-readback',
  target_name: 'strict-runtime-compute-missing-readback',
  gpuHmrSuccess: true,
  fullRuntimeProven: true,
  resultState: 'gpu-hmr-full-runtime-proven',
  acceptanceContract: acceptanceContract('strict_compute_missing_readback', {
    projectId: 'strict-runtime-compute-missing-readback',
  }),
  proofLedger: strictComputeMissingReadbackMaterials.proofLedger,
  proof_ledger: strictComputeMissingReadbackMaterials.proof_ledger,
  proofLedgerQuery: strictComputeMissingReadbackMaterials.proofLedgerQuery,
  proof_ledger_query: strictComputeMissingReadbackMaterials.proof_ledger_query,
  runtimeProofArtifact: strictComputeMissingReadbackMaterials.runtimeProofArtifact,
  runtime_proof_artifact: strictComputeMissingReadbackMaterials.runtime_proof_artifact,
});

const forgedGenericOpenclDir = path.join(artifactsRoot, 'strict-runtime-ledger', 'forged-generic-opencl');
const forgedGenericOpenclReadback = path.join(forgedGenericOpenclDir, 'readback.bin');
const forgedGenericOpenclBytes = Buffer.from([2, 4, 8, 16, 32, 64, 128, 255]);
await fs.mkdir(forgedGenericOpenclDir, { recursive: true });
await fs.writeFile(forgedGenericOpenclReadback, forgedGenericOpenclBytes);
await writeJson(`${forgedGenericOpenclReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  dtype: 'uint8',
  byteLength: forgedGenericOpenclBytes.length,
  shape: [forgedGenericOpenclBytes.length],
});
await writeRgbaPng(`${forgedGenericOpenclReadback}.card.png`, 8, 8, (x, y) => {
  const value = forgedGenericOpenclBytes[(x + y) % forgedGenericOpenclBytes.length];
  return [value, 255 - value, (value * 3) % 256, 255];
});
const forgedGenericOpenclMaterials = computeProofLedgerMaterials('forged-generic-opencl-label', {
  projectId: 'forged-generic-opencl-label',
  backend: 'opencl',
  rawReadbackPath: forgedGenericOpenclReadback,
  rawReadbackBytes: forgedGenericOpenclBytes,
});
const forgedGenericOpenclContract = acceptanceContract('forged_generic_opencl_label', {
  projectId: 'forged-generic-opencl-label',
});
forgedGenericOpenclContract.backend = { value: 'opencl' };
forgedGenericOpenclContract.artifact_identity.artifact_kind = 'opencl_program';
forgedGenericOpenclContract.opencl_contract = {
  program_hash_before: forgedGenericOpenclContract.artifact_hash_before,
  program_hash_after: forgedGenericOpenclContract.artifact_hash_after,
  kernel_name: 'flow_kernel',
  command_queue: 'queue:0',
  work_dim: 1,
  global_work_size: [64],
  local_work_size: [64],
  event_trace: 'event:forged-generic-opencl-label',
  output_buffer_readback: 'buffer:flow-output',
  field_evidence_refs: Object.fromEntries([
    'program_hash_before',
    'program_hash_after',
    'kernel_name',
    'command_queue',
    'work_dim',
    'global_work_size',
    'local_work_size',
    'event_trace',
    'output_buffer_readback',
  ].map((field) => [field, ['evidence:synthetic-runtime:forged-generic-opencl-label']])),
};
forgedGenericOpenclMaterials.proofLedger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.proof_ledger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtimeProofArtifact.proof_ledger =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedger;
forgedGenericOpenclMaterials.runtime_proof_artifact.proof_ledger =
  forgedGenericOpenclMaterials.runtime_proof_artifact.proofLedger;
forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtimeProofArtifact.proof_ledger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptance_contract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery =
  queryGpuHmrLedgerInvariants(forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedger);
forgedGenericOpenclMaterials.runtimeProofArtifact.proof_ledger_query =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery;
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation =
  evaluateGpuHmrAcceptanceContract(forgedGenericOpenclContract);
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptance_contract_evaluation =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation;
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency =
  evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: forgedGenericOpenclContract,
    derivedContract: forgedGenericOpenclContract,
  });
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptance_contract_consistency =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency;
forgedGenericOpenclMaterials.runtime_proof_artifact.proofLedger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtime_proof_artifact.proof_ledger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptanceContract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptance_contract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtime_proof_artifact.proofLedgerQuery =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery;
forgedGenericOpenclMaterials.runtime_proof_artifact.proof_ledger_query =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptanceContractEvaluation =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptance_contract_evaluation =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptanceContractConsistency =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptance_contract_consistency =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency;
await writeJson(path.join(forgedGenericOpenclDir, 'forged-generic-opencl-label.json'), {
  schemaVersion: 'synthi.gpu.hmr.proof.v1',
  proofId: 'gpu-runtime-proof:sha256:forged-generic-opencl-label',
  target_name: 'forged-generic-opencl-label',
  gpuHmrSuccess: true,
  fullRuntimeProven: true,
  resultState: 'gpu-hmr-full-runtime-proven',
  acceptanceContract: forgedGenericOpenclContract,
  proofLedger: forgedGenericOpenclMaterials.proofLedger,
  proof_ledger: forgedGenericOpenclMaterials.proof_ledger,
  proofLedgerQuery: forgedGenericOpenclMaterials.proofLedgerQuery,
  proof_ledger_query: forgedGenericOpenclMaterials.proof_ledger_query,
  runtimeProofArtifact: forgedGenericOpenclMaterials.runtimeProofArtifact,
  runtime_proof_artifact: forgedGenericOpenclMaterials.runtime_proof_artifact,
});

await writeJson(path.join(visualDir, 'run-mode-forged-source-adapted-webgpu.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-source-adapted-webgpu',
    'gpu-runtime-proof:sha256:forged-source-adapted-webgpu',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-source-adapted-webgpu',
  }),
  backend: 'webgpu',
  targetId: 'forged-source-adapted-webgpu',
  profileId: 'forged-source-adapted-webgpu',
  proofId: 'agent-split-run-mode-proof:sha256:forged-source-adapted-webgpu',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runtimeProbeInstrumentation: {
    sourceAdaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adaptedOrAlreadyPresent: true,
  },
  runtime_probe_instrumentation: {
    source_adaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adapted_or_already_present: true,
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-source-adapted-webgpu',
    editHash: hashValue('forged-source-adapted-webgpu'),
    editKind: 'gpu_artifact_edit',
  },
});

await writeJson(path.join(visualDir, 'run-mode-forged-top-level-source-adapted-webgpu.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-top-level-source-adapted-webgpu',
    'gpu-runtime-proof:sha256:forged-top-level-source-adapted-webgpu',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-top-level-source-adapted-webgpu',
  }),
  backend: 'webgpu',
  targetId: 'forged-top-level-source-adapted-webgpu',
  profileId: 'forged-top-level-source-adapted-webgpu',
  proofId: 'agent-split-run-mode-proof:sha256:forged-top-level-source-adapted-webgpu',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  sourceAdaptation: {
    sourceAdaptations: [
      'top_level_runtime_capture_hook_inserted',
      'top_level_dispatch_binding_rewrite',
    ],
    adaptedOrAlreadyPresent: true,
  },
  source_adaptation: {
    source_adaptations: [
      'top_level_runtime_capture_hook_inserted',
      'top_level_dispatch_binding_rewrite',
    ],
    adapted_or_already_present: true,
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-top-level-source-adapted-webgpu',
    editHash: hashValue('forged-top-level-source-adapted-webgpu'),
    editKind: 'gpu_artifact_edit',
  },
});

await writeJson(path.join(visualDir, 'negative-edit-refusal.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
  proofId: 'agent-split-negative-edit-refusal:sha256:synthetic',
  backend: 'hip',
  targetId: 'flow',
  profileId: 'flow',
  runModeCoverageSupport: bindGpuHmrRunModeCoverageSupport(
    flowRunModeCoverageSupport,
    {
      runMode: {
        metricScope: 'hot_delta_2',
        editHash: `sha256:${'9'.repeat(64)}`,
      },
    },
  ),
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'negative-edit:abi-layout',
    editHash: `sha256:${'9'.repeat(64)}`,
    editKind: 'negative_edit',
    differentEdit: true,
  },
  executableStaticCheck: {
    accepted: true,
    signatureChanged: true,
    negativeKernelFound: true,
    sourceAfterHash: `sha256:${'8'.repeat(64)}`,
    acceptedSignatureHash: `sha256:${'7'.repeat(64)}`,
    negativeSignatureHash: `sha256:${'6'.repeat(64)}`,
  },
  reasons: ['abi_compatibility_class_layout_changed', 'gpu_hmr_rejected_before_load'],
});

await writeJson(path.join(visualDir, 'negative-edit-refusal-forged-reasons-only.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
  proofId: 'agent-split-negative-edit-refusal:sha256:forged-reasons-only',
  backend: 'hip',
  targetId: 'forged-negative-reasons-only',
  profileId: 'forged-negative-reasons-only',
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'negative-edit:forged-reasons-only',
    editHash: `sha256:${'5'.repeat(64)}`,
    editKind: 'negative_edit',
    differentEdit: true,
  },
  reasons: ['gpu_hmr_rejected_before_load'],
});

await writeJson(path.join(visualDir, 'forged-unlinked-flow-cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  proofId: 'agent-split-run-mode-proof:sha256:forged-unlinked-flow-cold',
  profileId: 'forged-unlinked-flow-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split-forged-unlinked',
    editHash: hashValue('forged-unlinked-flow-cold'),
  },
});

await writeJson(path.join(visualDir, 'stale-cold-only.json'), {
  ...runModeProofBase,
  targetId: 'stale-cold-only',
  profileId: 'stale-cold-only',
  proofId: 'agent-split-run-mode-proof:sha256:stale-cold-only',
  coldSplitProven: true,
  cold_split_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split',
    editHash: hashValue('stale-cold-only'),
  },
});

const fissionManifest = {
  gpu: {
    vendor: 'rocm',
    device_roles: [
      { id: 'device.integrator', path: 'gpu/integrator.hip', compiler: 'hipcc', arch: ['gfx1201'] },
      { id: 'device.shading', path: 'gpu/shading.hip', compiler: 'hipcc', arch: ['gfx1201'] },
    ],
  },
};
const fissionFiles = {
  'gpu/integrator.hip': '__global__ void integrate(float* out) {}',
  'gpu/shading.hip': '__global__ void shade(float* out) {}',
};
const fissionAssessment = assessGeneratedGpuSplitGranularity({
  manifest: fissionManifest,
  files: fissionFiles,
});
const fissionSelectedPath = 'gpu/shading.hip';
const fissionSelectedKernel = 'shade';
const fissionSelectedIslandId = selectedIslandIdFor(fissionSelectedPath, fissionSelectedKernel);
const fissionTypedEvidence = deterministicFissionEvidenceFor({
  selectedPath: fissionSelectedPath,
  selectedKernel: fissionSelectedKernel,
  selectedIslandId: fissionSelectedIslandId,
});
const fissionReport = verifyGeneratedGpuSplitDeterministicFission({
  assessment: fissionAssessment,
  selectedPath: fissionSelectedPath,
  changedPaths: [fissionSelectedPath],
  selectedArtifact: {
    sourcePath: fissionSelectedPath,
    artifactId: `artifact:sha256:${sha256Hex('matrix-fission-artifact-id')}`,
    contentHash: hashValue('matrix-fission-artifact-content'),
    proofIds: [
      `gpu-runtime-proof:sha256:${sha256Hex('matrix-fission-runtime-proof')}`,
      `gpu-ledger-proof:sha256:${sha256Hex('matrix-fission-ledger-proof')}`,
    ],
  },
  verificationEvidence: fissionTypedEvidence,
  outputOracleContract: {
    oracleId: `oracle:generated-split-visual:sha256:${sha256Hex('matrix-fission-oracle')}`,
    kind: 'visual',
    target: 'framebuffer',
  },
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
await writeJson(path.join(visualDir, 'generated-split-deterministic-fission.json'), fissionReport);

const openClPreflightEvidenceRef = 'evidence:synthetic-opencl-preflight:runtime-capability';
await writeJson(path.join(artifactsRoot, 'opencl-preflight', 'opencl-proof.json'), {
  schema: 'synthi.gpu_hmr.opencl_preflight.v1',
  slug: 'synthetic-opencl-preflight',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'opencl',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'opencl',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'opencl',
      backendFamily: 'opencl',
      probe: 'opencl_vendor_icd_preflight',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    evidenceRefs: [openClPreflightEvidenceRef],
  },
  classification: {
    backend: {
      value: 'opencl',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    backendFamily: 'opencl',
    runtimeCapabilityPreflight: {
      backend: 'opencl',
      backendFamily: 'opencl',
      probe: 'opencl_vendor_icd_preflight',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    openclAccepted: false,
    resultState: 'opencl-runtime-rejected',
    unsupportedReasons: ['opencl_vendor_icd_missing'],
  },
  acceptance: {
    acceptedForOpenClRuntimePreflight: false,
    acceptedForOpenClOutputProof: false,
    gpuHmrSuccess: true,
    noShimApplied: true,
    noVendorIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'opencl-preflight-proof:sha256:synthetic',
});

const webGpuPreflightEvidenceRef = 'evidence:synthetic-webgpu-preflight:browser-runtime-capability';
await writeJson(path.join(artifactsRoot, 'webgpu-preflight', 'webgpu-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_preflight.v1',
  slug: 'synthetic-webgpu-preflight',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'webgpu',
      evidenceRefs: [webGpuPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'webgpu',
      evidenceRefs: [webGpuPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'webgpu',
      backendFamily: 'webgpu',
      probe: 'webgpu_browser_runtime_preflight',
      browserLaunched: true,
      secureContext: true,
      navigatorGpuPresent: true,
      adapterFound: true,
      deviceCreated: true,
      renderSubmitted: true,
      noShimApplied: true,
      noBrowserFlagClaimedAsHmr: true,
      noSynthesizedRuntime: true,
      noSymlinkApplied: true,
      evidenceRefs: [webGpuPreflightEvidenceRef],
    },
    evidenceRefs: [webGpuPreflightEvidenceRef],
  },
  classification: {
    webgpuAccepted: true,
    resultState: 'webgpu-runtime-preflight-accepted',
    unsupportedReasons: [],
    diagnosticScreenshot: null,
  },
  acceptance: {
    acceptedForWebGpuRuntimePreflight: true,
    acceptedForWebGpuPipelineProof: false,
    gpuHmrSuccess: false,
    reason: 'preflight_only_shader_module_pipeline_and_frame_oracle_still_required',
    noShimApplied: true,
    noBrowserFlagClaimedAsHmr: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'webgpu-preflight-proof:sha256:synthetic',
});

const oidnHipPreflightEvidenceRef = 'evidence:synthetic-oidn-hip-preflight:runtime-capability';
await writeJson(path.join(artifactsRoot, 'oidn-hip-preflight', 'oidn-hip-proof.json'), {
  schema: 'synthi.gpu_hmr.oidn_preflight.v1',
  slug: 'synthetic-oidn-hip-preflight',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'oidn_hip',
      backendFamily: 'oidn_hip',
      probe: 'oidn_hip_device_preflight',
      toolFound: true,
      hipDeviceLibraryFound: true,
      hipTestCount: 2,
      cpuDiagnosticCount: 2,
      noShimApplied: true,
      noSymlinkApplied: true,
      noSynthesizedRuntime: true,
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    evidenceRefs: [oidnHipPreflightEvidenceRef],
  },
  classification: {
    oidnHipRuntimePreflightAccepted: true,
    oidnHipOutputProofAccepted: false,
    oidnHipOutputOracleProven: false,
    resultState: 'oidn-hip-runtime-preflight-accepted',
    unsupportedReasons: [],
    outputProofGaps: ['oidn_output_oracle_not_proven'],
    openGaps: ['oidn_output_oracle_not_proven'],
  },
  acceptance: {
    acceptedForOidnHipRuntimePreflight: true,
    acceptedForHipOutputProof: false,
    acceptedForOidnHipOutputProof: false,
    outputOracleProven: false,
    gpuHmrSuccess: false,
    reason: 'preflight_only_oidn_output_oracle_still_required',
    openGaps: ['oidn_output_oracle_not_proven'],
    noShimApplied: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'oidn-preflight-proof:sha256:synthetic',
});

const oidnOutputDir = path.join(artifactsRoot, 'oidn-hip-output-oracle');
await fs.mkdir(oidnOutputDir, { recursive: true });
const oidnNoisyBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const oidnDenoisedBytes = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15]);
const oidnNoisyPath = path.join(oidnOutputDir, 'noisy.bin');
const oidnDenoisedPath = path.join(oidnOutputDir, 'denoised.bin');
const oidnExpectedPath = path.join(oidnOutputDir, 'expected.bin');
await fs.writeFile(oidnNoisyPath, oidnNoisyBytes);
await fs.writeFile(oidnDenoisedPath, oidnDenoisedBytes);
await fs.writeFile(oidnExpectedPath, oidnDenoisedBytes);
const oidnNoisyHash = `sha256:${sha256BufferHex(oidnNoisyBytes)}`;
const oidnDenoisedHash = `sha256:${sha256BufferHex(oidnDenoisedBytes)}`;
const oidnOutputManifest = {
  schemaVersion: 'synthi.gpu_hmr.oidn_output_oracle.v1',
  proofAuthority: 'oidn_output_oracle_file_bytes_only_not_gpu_hmr_success',
  backend: 'oidn_hip',
  device: 'hip',
  noisyInputPath: oidnNoisyPath,
  denoisedOutputPath: oidnDenoisedPath,
  expectedOutputPath: oidnExpectedPath,
  expectedOutputSha256: oidnDenoisedHash,
};
const oidnOutputManifestPath = path.join(oidnOutputDir, 'oracle.json');
await writeJson(oidnOutputManifestPath, oidnOutputManifest);
const oidnOutputManifestHash = `sha256:${sha256BufferHex(Buffer.from(`${JSON.stringify(oidnOutputManifest, null, 2)}\n`))}`;
await writeJson(path.join(oidnOutputDir, 'oidn-hip-output-proof.json'), {
  schema: 'synthi.gpu_hmr.oidn_preflight.v1',
  slug: 'synthetic-oidn-hip-output-oracle',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'oidn_hip',
      backendFamily: 'oidn_hip',
      probe: 'oidn_hip_device_preflight',
      toolFound: true,
      hipDeviceLibraryFound: true,
      hipTestCount: 2,
      cpuDiagnosticCount: 2,
      noShimApplied: true,
      noSymlinkApplied: true,
      noSynthesizedRuntime: true,
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    evidenceRefs: [oidnHipPreflightEvidenceRef],
  },
  outputOracle: {
    schemaVersion: 'synthi.gpu_hmr.oidn_output_oracle.v1',
    proofAuthority: 'oidn_output_oracle_file_bytes_only_not_gpu_hmr_success',
    accepted: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    backend: 'oidn_hip',
    device: 'hip',
    manifestPath: oidnOutputManifestPath,
    manifestSha256: oidnOutputManifestHash,
    expectedOutputSha256: oidnDenoisedHash,
    files: [
      {
        role: 'noisy_input',
        path: oidnNoisyPath,
        byteLength: oidnNoisyBytes.length,
        sha256: oidnNoisyHash,
        accepted: true,
        failedGates: [],
      },
      {
        role: 'denoised_output',
        path: oidnDenoisedPath,
        byteLength: oidnDenoisedBytes.length,
        sha256: oidnDenoisedHash,
        accepted: true,
        failedGates: [],
      },
      {
        role: 'expected_output',
        path: oidnExpectedPath,
        byteLength: oidnDenoisedBytes.length,
        sha256: oidnDenoisedHash,
        accepted: true,
        failedGates: [],
      },
    ],
    outputDistinctFromInput: true,
    expectedOutputMatched: true,
    evidenceRefs: [
      `oidn-output-oracle-manifest:${oidnOutputManifestHash}`,
      `oidn-output-oracle-noisy:${oidnNoisyHash}`,
      `oidn-output-oracle-denoised:${oidnDenoisedHash}`,
      `oidn-output-oracle-expected:${oidnDenoisedHash}`,
    ],
    failedGates: [],
  },
  classification: {
    oidnHipRuntimePreflightAccepted: true,
    oidnHipOutputProofAccepted: true,
    oidnHipOutputOracleProven: true,
    resultState: 'oidn-hip-output-oracle-accepted-preflight-only',
    unsupportedReasons: [],
    outputProofGaps: [],
    openGaps: ['oidn_full_runtime_hmr_ledger_not_proven'],
  },
  acceptance: {
    acceptedForOidnHipRuntimePreflight: true,
    acceptedForHipOutputProof: true,
    acceptedForOidnHipOutputProof: true,
    outputOracleProven: true,
    gpuHmrSuccess: false,
    reason: 'preflight_output_oracle_only_full_runtime_hmr_ledger_still_required',
    openGaps: ['oidn_full_runtime_hmr_ledger_not_proven'],
    noShimApplied: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'oidn-preflight-proof:sha256:synthetic-output-oracle',
});

await writeJson(path.join(oidnOutputDir, 'oidn-hip-output-proof-forged-file-hash.json'), {
  schema: 'synthi.gpu_hmr.oidn_preflight.v1',
  slug: 'synthetic-oidn-hip-output-oracle-forged-file-hash',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'oidn_hip',
      backendFamily: 'oidn_hip',
      probe: 'oidn_hip_device_preflight',
      toolFound: true,
      hipDeviceLibraryFound: true,
      hipTestCount: 2,
      cpuDiagnosticCount: 2,
      noShimApplied: true,
      noSymlinkApplied: true,
      noSynthesizedRuntime: true,
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    evidenceRefs: [oidnHipPreflightEvidenceRef],
  },
  outputOracle: {
    schemaVersion: 'synthi.gpu_hmr.oidn_output_oracle.v1',
    proofAuthority: 'oidn_output_oracle_file_bytes_only_not_gpu_hmr_success',
    accepted: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    backend: 'oidn_hip',
    device: 'hip',
    manifestPath: oidnOutputManifestPath,
    manifestSha256: oidnOutputManifestHash,
    expectedOutputSha256: oidnDenoisedHash,
    files: [
      {
        role: 'noisy_input',
        path: oidnNoisyPath,
        byteLength: oidnNoisyBytes.length,
        sha256: oidnNoisyHash,
        accepted: true,
        failedGates: [],
      },
      {
        role: 'denoised_output',
        path: oidnDenoisedPath,
        byteLength: oidnDenoisedBytes.length,
        sha256: `sha256:${'0'.repeat(64)}`,
        accepted: true,
        failedGates: [],
      },
    ],
    outputDistinctFromInput: true,
    expectedOutputMatched: true,
    evidenceRefs: [
      `oidn-output-oracle-manifest:${oidnOutputManifestHash}`,
      `oidn-output-oracle-noisy:${oidnNoisyHash}`,
      `oidn-output-oracle-denoised:sha256:${'0'.repeat(64)}`,
      `oidn-output-oracle-expected:${oidnDenoisedHash}`,
    ],
    failedGates: [],
  },
  classification: {
    oidnHipRuntimePreflightAccepted: true,
    oidnHipOutputProofAccepted: true,
    oidnHipOutputOracleProven: true,
    resultState: 'oidn-hip-output-oracle-accepted-preflight-only',
    unsupportedReasons: [],
    outputProofGaps: [],
    openGaps: ['oidn_full_runtime_hmr_ledger_not_proven'],
  },
  acceptance: {
    acceptedForOidnHipRuntimePreflight: true,
    acceptedForHipOutputProof: true,
    acceptedForOidnHipOutputProof: true,
    outputOracleProven: true,
    gpuHmrSuccess: false,
    reason: 'preflight_output_oracle_only_full_runtime_hmr_ledger_still_required',
    openGaps: ['oidn_full_runtime_hmr_ledger_not_proven'],
    noShimApplied: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'oidn-preflight-proof:sha256:synthetic-output-oracle-forged-file-hash',
});

const legacySchemaOnlyPreflightDir = path.join(artifactsRoot, 'legacy-schema-only-preflight');
await writeJson(path.join(legacySchemaOnlyPreflightDir, 'schema-only-opencl-preflight.json'), {
  schema: 'synthi.gpu_hmr.opencl_preflight.v1',
  slug: 'legacy-schema-only-opencl-preflight',
  classification: {
    openclAccepted: true,
    resultState: 'opencl-runtime-observed',
    unsupportedReasons: [],
  },
  acceptance: {
    acceptedForOpenClRuntimePreflight: true,
    acceptedForOpenClOutputProof: false,
    gpuHmrSuccess: false,
    noShimApplied: true,
    noVendorIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'opencl-preflight-proof:sha256:legacy-schema-only',
});

const forgedRawBackendPreflightDir = path.join(artifactsRoot, 'forged-raw-backend-preflight');
await writeJson(path.join(forgedRawBackendPreflightDir, 'raw-vulkan-backend-refs.json'), {
  schema: 'synthi.gpu_hmr.vulkan_preflight.v1',
  slug: 'forged-raw-vulkan-backend-refs',
  backend: 'vulkan',
  backendFamily: 'vulkan',
  evidenceRefs: ['evidence:forged-raw-vulkan-preflight'],
  classification: {
    backend: 'vulkan',
    backendFamily: 'vulkan',
    vulkanAccepted: true,
    resultState: 'vulkan-runtime-observed',
    unsupportedReasons: [],
    evidenceRefs: ['evidence:forged-raw-vulkan-preflight'],
  },
  acceptance: {
    acceptedForVulkanRuntimePreflight: true,
    acceptedForVulkanPipelineProof: false,
    gpuHmrSuccess: false,
    noShimApplied: true,
    noIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'vulkan-preflight-proof:sha256:forged-raw-backend-refs',
});

const schemaCorrectRawBackendPreflightDir = path.join(artifactsRoot, 'schema-correct-raw-backend-preflight');
await writeJson(path.join(schemaCorrectRawBackendPreflightDir, 'schema-correct-raw-vulkan-backend.json'), {
  schema: 'synthi.gpu_hmr.vulkan_preflight.v1',
  slug: 'schema-correct-raw-vulkan-backend',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: 'vulkan',
    backendFamily: 'vulkan',
    runtimeCapabilityPreflight: {
      probe: 'vulkan_loader_preflight',
      evidenceRefs: ['evidence:schema-correct-raw-vulkan-preflight'],
    },
    evidenceRefs: ['evidence:schema-correct-raw-vulkan-preflight'],
  },
  acceptance: {
    acceptedForVulkanRuntimePreflight: true,
    acceptedForVulkanPipelineProof: false,
    gpuHmrSuccess: false,
    noShimApplied: true,
    noIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'vulkan-preflight-proof:sha256:schema-correct-raw-backend',
});

function externalProjectContractForTest({
  profileId,
  backend,
  backendFamily,
  libraryFamily,
  runtimeEnvironment,
  profileClass,
  manifestHash,
  runtimeEvidenceRefs,
}) {
  const evidenceRefs = [`test:external-contract:${profileId}`];
  const typed = (field, value) => ({
    value,
    evidenceRefs: [...evidenceRefs, `test:external-contract:${profileId}:${field}`],
  });
  return {
    schemaVersion: 'synthi.gpu_hmr.external_project_contract.v2',
    accepted: true,
    profileId,
    profile_id: profileId,
    backend: typed('backend', backend),
    backendFamily: typed('backendFamily', backendFamily),
    backend_family: typed('backendFamily', backendFamily),
    libraryFamily: typed('libraryFamily', libraryFamily),
    library_family: typed('libraryFamily', libraryFamily),
    runtimeEnvironment: typed('runtimeEnvironment', runtimeEnvironment),
    runtime_environment: typed('runtimeEnvironment', runtimeEnvironment),
    profileClass: typed('profileClass', profileClass),
    profile_class: typed('profileClass', profileClass),
    profileManifestHash: manifestHash,
    profile_manifest_hash: manifestHash,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    runtimeEvidence: {
      evidenceRefs: runtimeEvidenceRefs,
      evidence_refs: runtimeEvidenceRefs,
    },
    runtime_evidence: {
      evidenceRefs: runtimeEvidenceRefs,
      evidence_refs: runtimeEvidenceRefs,
    },
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
  };
}

await writeJson(path.join(logsRoot, 'external-projects', 'bevy-wgsl-name-only-rejection-proof.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_rejection.v1',
  profileId: 'bevy-wgsl-name-only',
  proofMode: 'mcp_preview',
  status: 'fail',
  rejection: {
    accepted: false,
    reasons: [
      'external_profile_failed',
      'mcp_no_decoded_frames',
      'mcp_request_timeout',
      'visual_frame_missing',
      'visual_oracle_not_accepted',
    ],
  },
  proofId: 'external-rejection-proof:sha256:synthetic-bevy-name-only',
});

await writeJson(path.join(logsRoot, 'external-projects', 'explicit-bevy-wgsl-shader-material-rejection-proof.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_rejection.v1',
  profileId: 'explicit-bevy-wgsl-shader-material',
  proofMode: 'mcp_preview',
  backend: 'bevy_wgsl',
  backendFamily: 'wgpu_vulkan',
  libraryFamily: 'bevy',
  runtimeEnvironment: 'mcp_preview',
  profileClass: 'engine_asset_reload_visual_profile',
  externalProjectContract: externalProjectContractForTest({
    profileId: 'explicit-bevy-wgsl-shader-material',
    backend: 'bevy_wgsl',
    backendFamily: 'wgpu_vulkan',
    libraryFamily: 'bevy',
    runtimeEnvironment: 'mcp_preview',
    profileClass: 'engine_asset_reload_visual_profile',
    manifestHash: hashValue('explicit-bevy-wgsl-shader-material-manifest'),
    runtimeEvidenceRefs: ['external-rejection-proof:sha256:synthetic-bevy'],
  }),
  status: 'fail',
  rejection: {
    accepted: false,
    reasons: [
      'external_profile_failed',
      'mcp_no_decoded_frames',
      'mcp_request_timeout',
      'visual_frame_missing',
      'visual_oracle_not_accepted',
    ],
  },
  proofId: 'external-rejection-proof:sha256:synthetic-bevy',
});

await writeJson(path.join(logsRoot, 'external-projects', 'explicit-self-check-named-project-rejection-proof.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_rejection.v1',
  profileId: 'explicit-self-check-named-project',
  proofMode: 'mcp_preview',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'arbitrary_external_project',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  externalProjectContract: externalProjectContractForTest({
    profileId: 'explicit-self-check-named-project',
    backend: 'webgl',
    backendFamily: 'webgl',
    libraryFamily: 'arbitrary_external_project',
    runtimeEnvironment: 'browser_dev_server',
    profileClass: 'external_engine_visual_profile',
    manifestHash: hashValue('explicit-self-check-named-project-manifest'),
    runtimeEvidenceRefs: ['external-rejection-proof:sha256:synthetic-self-check-named-project'],
  }),
  status: 'fail',
  rejection: {
    accepted: false,
    reasons: [
      'external_profile_failed',
      'visual_frame_missing',
      'visual_oracle_not_accepted',
    ],
  },
  proofId: 'external-rejection-proof:sha256:synthetic-self-check-named-project',
});

const externalVisualDir = path.join(logsRoot, 'external-projects', 'explicit-external-engine-visual');
await writeRgbaPng(path.join(externalVisualDir, 'before.png'), 320, 240, (x, y) => [
  (x * 3 + y) % 256,
  (x + y * 2) % 256,
  (32 + x + y) % 256,
  255,
]);
await writeRgbaPng(path.join(externalVisualDir, 'after.png'), 320, 240, (x, y) => [
  (80 + x * 5 + y) % 256,
  (48 + x + y * 3) % 256,
  (24 + x * 2 + y) % 256,
  255,
]);
await writeRgbaPng(path.join(externalVisualDir, 'diff.png'), 320, 240, (x, y) => [
  (255 - x + y) % 256,
  (180 + x * 2) % 256,
  (64 + y * 3) % 256,
  255,
]);
const externalVisualBefore = path.join(externalVisualDir, 'before.png');
const externalVisualAfter = path.join(externalVisualDir, 'after.png');
const externalVisualDiff = path.join(externalVisualDir, 'diff.png');
const externalVisualProfileSelection = {
  schemaVersion: 'synthi.gpu.hmr.external_profile_selection.v1',
  accepted: true,
  explicit: true,
  source: 'test_profile_path',
  profileId: 'explicit-external-engine-visual',
  profile_id: 'explicit-external-engine-visual',
  manifestHash: hashValue('explicit-external-engine-visual-manifest'),
  manifest_hash: hashValue('explicit-external-engine-visual-manifest'),
  path: 'profiles/explicit-external-engine-visual.json',
  evidenceRefs: ['test:external-profile-selection:explicit-path'],
  evidence_refs: ['test:external-profile-selection:explicit-path'],
};
const externalVisualSourceDeltaEvidence = {
  schemaVersion: 'synthi.gpu.hmr.external_source_delta_evidence.v1',
  accepted: true,
  sourceFile: 'src/material.frag',
  source_file: 'src/material.frag',
  sourcePath: 'external/src/material.frag',
  source_path: 'external/src/material.frag',
  matchCount: 1,
  match_count: 1,
  byteRange: { start: 128, end: 160 },
  byte_range: { start: 128, end: 160 },
  beforeFileHash: hashValue('explicit-external-engine-visual-before-file'),
  before_file_hash: hashValue('explicit-external-engine-visual-before-file'),
  afterFileHash: hashValue('explicit-external-engine-visual-after-file'),
  after_file_hash: hashValue('explicit-external-engine-visual-after-file'),
  beforeSnippetHash: hashValue('vec3 color = vec3(0.25);'),
  before_snippet_hash: hashValue('vec3 color = vec3(0.25);'),
  afterSnippetHash: hashValue('vec3 color = vec3(0.75);'),
  after_snippet_hash: hashValue('vec3 color = vec3(0.75);'),
  evidenceRefs: ['source:src/material.frag:unique-before-snippet'],
  evidence_refs: ['source:src/material.frag:unique-before-snippet'],
};
const externalVisualProjectContract = externalProjectContractForTest({
  profileId: 'explicit-external-engine-visual',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  manifestHash: externalVisualProfileSelection.manifestHash,
  runtimeEvidenceRefs: ['external-visual-proof:explicit-external-engine-visual'],
});
const externalVisualDeterministicMode = deterministicMode('explicit-external-engine-visual');
const externalVisualEvidenceArtifacts = [];
for (const artifactPath of [externalVisualBefore, externalVisualAfter, externalVisualDiff]) {
  const artifactBytes = await fs.readFile(artifactPath);
  const artifactHash = hashBuffer(artifactBytes);
  externalVisualEvidenceArtifacts.push({
    path: artifactPath,
    bytes: artifactBytes.length,
    contentHash: artifactHash,
    evidenceId: `evidence:visual-artifact:${artifactHash}`,
    evidence_id: `evidence:visual-artifact:${artifactHash}`,
    readError: null,
    read_error: null,
    visualAnalysisError: null,
    visual_analysis_error: null,
    width: 320,
    height: 240,
    visiblePixels: 76800,
    visible_pixels: 76800,
    visualQuality: 'gpu-hmr-visual-varied-frame',
    visual_quality: 'gpu-hmr-visual-varied-frame',
    acceptedAsVisualEvidence: true,
    accepted_as_visual_evidence: true,
    kind: 'visual-artifact',
    producerSubsystem: 'mcp.gpu_hmr_validation',
    producer_subsystem: 'mcp.gpu_hmr_validation',
  });
}
const externalVisualProofMaterial = {
  schemaVersion: 'synthi.gpu.hmr.external_visual_proof_artifact.v1',
  profileId: 'explicit-external-engine-visual',
  proofMode: 'external_runtime_screenshot',
  status: 'pass',
  createdAt: '2026-06-09T00:00:00.000Z',
  backend: 'webgl',
  backendFamily: 'webgl',
  backend_family: 'webgl',
  libraryFamily: 'threejs',
  library_family: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  runtime_environment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  profile_class: 'external_engine_visual_profile',
  externalProjectContract: externalVisualProjectContract,
  external_project_contract: externalVisualProjectContract,
  profileSelection: externalVisualProfileSelection,
  profile_selection: externalVisualProfileSelection,
  sourceDeltaEvidence: externalVisualSourceDeltaEvidence,
  source_delta_evidence: externalVisualSourceDeltaEvidence,
  visualOracleArtifacts: visualArtifactSet({
    before: externalVisualBefore,
    after: externalVisualAfter,
    diff: externalVisualDiff,
  }, {
    capture_backend: 'external_runtime_screenshot',
    camera_state_hash: externalVisualDeterministicMode.camera_state_hash,
  }),
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualMode: externalVisualDeterministicMode,
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
  visualEvidenceArtifacts: externalVisualEvidenceArtifacts,
  acceptedVisualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
};
const externalVisualProofArtifact = {
  ...externalVisualProofMaterial,
  proofId: `external-visual-proof:${sha256Hex(stableJson(externalVisualProofMaterial))}`,
};
const externalVisualProofArtifactPath = path.join(
  logsRoot,
  'external-projects',
  'explicit-external-engine-visual-proof.json',
);
await writeJson(externalVisualProofArtifactPath, externalVisualProofArtifact);
await writeJson(path.join(logsRoot, 'external-projects', 'explicit-external-engine-visual-report.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_profile.report.v1',
  profile: {
    id: 'explicit-external-engine-visual',
    backend: 'webgl',
    backendFamily: 'webgl',
    libraryFamily: 'threejs',
    runtimeEnvironment: 'browser_dev_server',
    profileClass: 'external_engine_visual_profile',
  },
  proofMode: 'external_runtime_screenshot',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  externalProjectContract: externalVisualProjectContract,
  external_project_contract: externalVisualProjectContract,
  status: 'pass',
  profileSelection: externalVisualProfileSelection,
  profile_selection: externalVisualProfileSelection,
  sourceDeltaEvidence: externalVisualSourceDeltaEvidence,
  source_delta_evidence: externalVisualSourceDeltaEvidence,
  visualOracleArtifacts: visualArtifactSet({
    before: externalVisualBefore,
    after: externalVisualAfter,
    diff: externalVisualDiff,
  }, {
    capture_backend: 'external_runtime_screenshot',
    camera_state_hash: externalVisualDeterministicMode.camera_state_hash,
  }),
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
  visualProofArtifact: {
    schemaVersion: 'synthi.gpu.hmr.external_visual_proof_artifact.v1',
    proofId: externalVisualProofArtifact.proofId,
    path: externalVisualProofArtifactPath,
    visualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    acceptedVisualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    contentHashes: externalVisualEvidenceArtifacts.map((artifact) => artifact.contentHash),
  },
  proofArtifactPaths: [externalVisualProofArtifactPath],
  timings: {
    totalMs: 44,
    editToScreenshotMs: 12,
    visualDiffMs: 3,
  },
  proofId: 'external-profile-report:sha256:synthetic-engine-visual',
});

const seedlessExternalVisualProfileId = 'forged-external-engine-seedless-visual';
const seedlessExternalVisualProfileSelection = {
  ...externalVisualProfileSelection,
  profileId: seedlessExternalVisualProfileId,
  profile_id: seedlessExternalVisualProfileId,
  manifestHash: hashValue(`${seedlessExternalVisualProfileId}-manifest`),
  manifest_hash: hashValue(`${seedlessExternalVisualProfileId}-manifest`),
  path: `profiles/${seedlessExternalVisualProfileId}.json`,
  evidenceRefs: [`test:external-profile-selection:${seedlessExternalVisualProfileId}`],
  evidence_refs: [`test:external-profile-selection:${seedlessExternalVisualProfileId}`],
};
const seedlessExternalVisualSourceDeltaEvidence = {
  ...externalVisualSourceDeltaEvidence,
  beforeFileHash: hashValue(`${seedlessExternalVisualProfileId}-before-file`),
  before_file_hash: hashValue(`${seedlessExternalVisualProfileId}-before-file`),
  afterFileHash: hashValue(`${seedlessExternalVisualProfileId}-after-file`),
  after_file_hash: hashValue(`${seedlessExternalVisualProfileId}-after-file`),
  evidenceRefs: [`source:src/material.frag:${seedlessExternalVisualProfileId}`],
  evidence_refs: [`source:src/material.frag:${seedlessExternalVisualProfileId}`],
};
const seedlessExternalVisualProjectContract = externalProjectContractForTest({
  profileId: seedlessExternalVisualProfileId,
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  manifestHash: seedlessExternalVisualProfileSelection.manifestHash,
  runtimeEvidenceRefs: [`external-visual-proof:${seedlessExternalVisualProfileId}`],
});
const seedlessExternalVisualMode = {
  ...deterministicMode(seedlessExternalVisualProfileId),
  fixed_seed: false,
  seed_policy_fixed: false,
  seed_policy_hash: null,
};
const seedlessExternalVisualProofMaterial = {
  ...externalVisualProofMaterial,
  profileId: seedlessExternalVisualProfileId,
  externalProjectContract: seedlessExternalVisualProjectContract,
  external_project_contract: seedlessExternalVisualProjectContract,
  profileSelection: seedlessExternalVisualProfileSelection,
  profile_selection: seedlessExternalVisualProfileSelection,
  sourceDeltaEvidence: seedlessExternalVisualSourceDeltaEvidence,
  source_delta_evidence: seedlessExternalVisualSourceDeltaEvidence,
  deterministicVisualMode: seedlessExternalVisualMode,
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
};
const seedlessExternalVisualProofArtifact = {
  ...seedlessExternalVisualProofMaterial,
  proofId: `external-visual-proof:${sha256Hex(stableJson(seedlessExternalVisualProofMaterial))}`,
};
const seedlessExternalVisualProofArtifactPath = path.join(
  logsRoot,
  'external-projects',
  'forged-external-engine-seedless-visual-proof.json',
);
await writeJson(seedlessExternalVisualProofArtifactPath, seedlessExternalVisualProofArtifact);
await writeJson(path.join(logsRoot, 'external-projects', 'forged-external-engine-seedless-visual-report.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_profile.report.v1',
  profile: {
    id: seedlessExternalVisualProfileId,
    backend: 'webgl',
    backendFamily: 'webgl',
    libraryFamily: 'threejs',
    runtimeEnvironment: 'browser_dev_server',
    profileClass: 'external_engine_visual_profile',
  },
  proofMode: 'external_runtime_screenshot',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  externalProjectContract: seedlessExternalVisualProjectContract,
  external_project_contract: seedlessExternalVisualProjectContract,
  status: 'pass',
  profileSelection: seedlessExternalVisualProfileSelection,
  profile_selection: seedlessExternalVisualProfileSelection,
  sourceDeltaEvidence: seedlessExternalVisualSourceDeltaEvidence,
  source_delta_evidence: seedlessExternalVisualSourceDeltaEvidence,
  visualOracleArtifacts: visualArtifactSet({
    before: externalVisualBefore,
    after: externalVisualAfter,
    diff: externalVisualDiff,
  }, {
    capture_backend: 'external_runtime_screenshot',
  }),
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
  visualProofArtifact: {
    schemaVersion: 'synthi.gpu.hmr.external_visual_proof_artifact.v1',
    proofId: seedlessExternalVisualProofArtifact.proofId,
    path: seedlessExternalVisualProofArtifactPath,
    visualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    acceptedVisualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    contentHashes: externalVisualEvidenceArtifacts.map((artifact) => artifact.contentHash),
  },
  proofArtifactPaths: [seedlessExternalVisualProofArtifactPath],
  timings: {
    totalMs: 44,
    editToScreenshotMs: 12,
    visualDiffMs: 3,
  },
  proofId: 'external-profile-report:sha256:forged-seedless-engine-visual',
});

const forgedExternalVisualDir = path.join(logsRoot, 'external-projects', 'forged-external-engine-visual');
await writeRgbaPng(path.join(forgedExternalVisualDir, 'before.png'), 320, 240, (x, y) => [
  (x + y) % 256,
  (x * 2) % 256,
  (y * 3) % 256,
  255,
]);
await writeRgbaPng(path.join(forgedExternalVisualDir, 'after.png'), 320, 240, (x, y) => [
  (72 + x + y) % 256,
  (24 + x * 2) % 256,
  (96 + y * 3) % 256,
  255,
]);
await writeRgbaPng(path.join(forgedExternalVisualDir, 'diff.png'), 320, 240, (x, y) => [
  (255 - x) % 256,
  (255 - y) % 256,
  (x + y) % 256,
  255,
]);
await writeJson(path.join(logsRoot, 'external-projects', 'forged-external-engine-visual-report.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_profile.report.v1',
  profile: {
    id: 'forged-external-engine-visual',
    backend: 'webgl',
    backendFamily: 'webgl',
    libraryFamily: 'threejs',
    runtimeEnvironment: 'browser_dev_server',
    profileClass: 'external_engine_visual_profile',
  },
  proofMode: 'external_runtime_screenshot',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  status: 'pass',
  visualOracleArtifacts: {
    before_image: path.join(forgedExternalVisualDir, 'before.png'),
    after_image: path.join(forgedExternalVisualDir, 'after.png'),
    diff_image: path.join(forgedExternalVisualDir, 'diff.png'),
    capture_backend: 'external_runtime_screenshot',
  },
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
  proofId: 'external-profile-report:sha256:forged-engine-visual',
});

const noDeviceRuntimeCapabilityPreflight = {
  schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
  backend: 'rocm',
  api: 'hipMallocArray',
  probe: 'hip_array_allocation_preflight',
  deviceCountResult: 100,
  deviceCountError: 'no ROCm-capable device is detected',
  deviceCount: 0,
  allocationResult: 100,
  allocationError: 'no ROCm-capable device is detected',
  allocationAvailable: false,
  allocationUnavailable: true,
  anyAllocationAvailable: false,
  allocationMatrixTotal: 8,
  allocationMatrixFailureCount: 8,
  textureResourceFallbackAvailable: false,
  textureResourceMatrixTotal: 4,
  textureResourceMatrixFailureCount: 4,
  exitCode: 70,
  degradedState: 'gpu-runtime-array-allocation-unavailable',
  degradedReason: 'HIP array allocation matrix failed 8/8 entries; no ROCm-capable device is detected',
};

const acceptedRuntimeCapabilityPreflight = {
  schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
  observed: true,
  backend: 'rocm',
  api: 'hipMallocArray',
  probe: 'hip_array_allocation_preflight',
  deviceCountResult: 0,
  deviceCount: 1,
  allocationResult: 0,
  allocationAvailable: true,
  anyAllocationAvailable: true,
  allocationMatrixTotal: 8,
  allocationMatrixFailureCount: 0,
  textureResourceFallbackAvailable: true,
  textureResourceMatrixTotal: 4,
  textureResourceMatrixFailureCount: 0,
  exitCode: 0,
  evidenceRefs: [`evidence:runtime-capability-preflight:${hashValue('accepted-runtime-capability-preflight')}`],
};

const acceptedSidecarRuntimeConsistencyNotApplicable = {
  schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
  status: 'not_applicable',
  accepted: true,
  notApplicable: true,
  not_applicable: true,
  proofAuthority: 'explicit_no_device_sidecar_in_target_contract',
  proof_authority: 'explicit_no_device_sidecar_in_target_contract',
  blockingGaps: [],
  blocking_gaps: [],
  evidenceRefs: [`evidence:sidecar-runtime-consistency:${hashValue('sidecar-not-applicable')}`],
  evidence_refs: [`evidence:sidecar-runtime-consistency:${hashValue('sidecar-not-applicable')}`],
};

function acceptedRealRocmDeviceSidecarContract(scope, overrides = {}) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: overrides.declared ?? false,
    required: overrides.required ?? false,
    status: 'device_sidecar_runtime_proof_evidence',
    proofAuthority: 'runtime_observed_sidecar_contract_evidence',
    proof_authority: 'runtime_observed_sidecar_contract_evidence',
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: true,
    runtime_observation_complete: true,
    runtimeObservedByStage: {
      artifactTransport: true,
      epochPublication: true,
      dispatchTrace: true,
      outputOracle: true,
      hostIdentity: true,
    },
    runtime_observed_by_stage: {
      artifactTransport: true,
      epochPublication: true,
      dispatchTrace: true,
      outputOracle: true,
      hostIdentity: true,
    },
    sourceCoverageComplete: true,
    source_coverage_complete: true,
    backend: overrides.backend ?? 'hip',
    artifact_identity: {
      source_paths: [`src/${scope}/kernel.hip`],
      artifact_kind: 'hsaco',
      entry_points: [`kernel_${scope}`],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang++',
      compiler_args_hash: hashValue(`sidecar-compile-args:${scope}`),
    },
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [
      `evidence:sidecar-contract:${scope}`,
      `gpu-runtime-proof:sha256:${sha256Hex(`sidecar-runtime:${scope}`)}`,
    ],
    evidence_refs: [
      `evidence:sidecar-contract:${scope}`,
      `gpu-runtime-proof:sha256:${sha256Hex(`sidecar-runtime:${scope}`)}`,
    ],
    contractHash: hashValue(`sidecar-contract:${scope}`),
    contract_hash: hashValue(`sidecar-contract:${scope}`),
    ...overrides,
  };
}

function acceptedRealRocmSidecarRuntimeConsistency(scope, overrides = {}) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
    status: 'sidecar_runtime_consistency_proven',
    accepted: true,
    runtimeConsistencyAccepted: true,
    runtime_consistency_accepted: true,
    notApplicable: false,
    not_applicable: false,
    proofAuthority: 'sidecar_backend_runtime_consistency_evidence',
    proof_authority: 'sidecar_backend_runtime_consistency_evidence',
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    sidecarBackend: overrides.sidecarBackend ?? overrides.sidecar_backend ?? 'hip',
    sidecar_backend: overrides.sidecar_backend ?? overrides.sidecarBackend ?? 'hip',
    runtimeBackendCandidates: overrides.runtimeBackendCandidates ?? ['hip'],
    runtime_backend_candidates: overrides.runtime_backend_candidates ?? ['hip'],
    runtimeBoundBackendCandidates: overrides.runtimeBoundBackendCandidates
      ?? overrides.runtime_bound_backend_candidates
      ?? ['hip'],
    runtime_bound_backend_candidates: overrides.runtime_bound_backend_candidates
      ?? overrides.runtimeBoundBackendCandidates
      ?? ['hip'],
    runtimeBackendEvidenceAuthority: overrides.runtimeBackendEvidenceAuthority
      ?? overrides.runtime_backend_evidence_authority
      ?? 'strict_runtime_proof_backend_evidence',
    runtime_backend_evidence_authority: overrides.runtime_backend_evidence_authority
      ?? overrides.runtimeBackendEvidenceAuthority
      ?? 'strict_runtime_proof_backend_evidence',
    runtimeBackendRuntimeEvidenceAccepted: overrides.runtimeBackendRuntimeEvidenceAccepted
      ?? overrides.runtime_backend_runtime_evidence_accepted
      ?? true,
    runtime_backend_runtime_evidence_accepted: overrides.runtime_backend_runtime_evidence_accepted
      ?? overrides.runtimeBackendRuntimeEvidenceAccepted
      ?? true,
    backendConsistencySource: overrides.backendConsistencySource
      ?? overrides.backend_consistency_source
      ?? 'strict_runtime_proof_backend',
    backend_consistency_source: overrides.backend_consistency_source
      ?? overrides.backendConsistencySource
      ?? 'strict_runtime_proof_backend',
    backendHintConsistent: overrides.backendHintConsistent ?? overrides.backend_hint_consistent ?? true,
    backend_hint_consistent: overrides.backend_hint_consistent ?? overrides.backendHintConsistent ?? true,
    backendConsistent: overrides.backendConsistent ?? true,
    backend_consistent: overrides.backend_consistent ?? true,
    sidecarEvidenceComplete: true,
    sidecar_evidence_complete: true,
    sidecarRuntimeObservationComplete: true,
    sidecar_runtime_observation_complete: true,
    sidecarCanSatisfyRuntimeProof: true,
    sidecar_can_satisfy_runtime_proof: true,
    runtimeObserved: true,
    runtime_observed: true,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [`evidence:sidecar-runtime-consistency:${scope}`],
    evidence_refs: [`evidence:sidecar-runtime-consistency:${scope}`],
    contractHash: hashValue(`sidecar-runtime-consistency:${scope}`),
    contract_hash: hashValue(`sidecar-runtime-consistency:${scope}`),
    ...overrides,
  };
}

function acceptedRealRocmAppHookContract(scope, overrides = {}) {
  const stageNames = [
    'artifact_transport',
    'epoch_publication',
    'dispatch_trace',
    'host_identity',
    'output_oracle',
  ];
  const stageResults = Object.fromEntries(stageNames.flatMap((stage) => {
    const result = {
      stage,
      declared: true,
      required: true,
      contractEvidencePresent: true,
      contract_evidence_present: true,
      runtimeObserved: true,
      runtime_observed: true,
      evidenceRefs: [`evidence:app-hook:${scope}:${stage}`],
      evidence_refs: [`evidence:app-hook:${scope}:${stage}`],
      unresolvedEvidenceRefs: [],
      unresolved_evidence_refs: [],
      status: 'contract_and_runtime_observed',
    };
    const camel = stage.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    return [[stage, result], [camel, result]];
  }));
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1',
    declared: true,
    required: true,
    status: 'supplemental_app_hook_runtime_proof_evidence',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    nativeLaunchBoundaryObserved: true,
    native_launch_boundary_observed: true,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: true,
    runtime_observation_complete: true,
    stageResults,
    stage_results: stageResults,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: stageNames.map((stage) => `evidence:app-hook:${scope}:${stage}`),
    evidence_refs: stageNames.map((stage) => `evidence:app-hook:${scope}:${stage}`),
    contractHash: hashValue(`app-hook-contract:${scope}`),
    contract_hash: hashValue(`app-hook-contract:${scope}`),
    ...overrides,
  };
}

function acceptedRealRocmAppHookMaterialization(scope, overrides = {}) {
  const stageNames = [
    'artifact_transport',
    'epoch_publication',
    'dispatch_trace',
    'host_identity',
    'output_oracle',
  ];
  const stagePlans = Object.fromEntries(stageNames.flatMap((stage) => {
    const plan = {
      stage,
      required: true,
      planAvailable: true,
      plan_available: true,
      candidateEvidencePresent: true,
      candidate_evidence_present: true,
      contractEvidencePresent: true,
      contract_evidence_present: true,
      runtimeObserved: true,
      runtime_observed: true,
      proofKinds: [
        `${stage}_contract_ref`,
        `${stage}_runtime_event`,
      ],
      proof_kinds: [
        `${stage}_contract_ref`,
        `${stage}_runtime_event`,
      ],
      evidenceRefs: [`evidence:app-hook-materialization:${scope}:${stage}`],
      evidence_refs: [`evidence:app-hook-materialization:${scope}:${stage}`],
      status: 'materialized_and_observed',
    };
    const camel = stage.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    return [[stage, plan], [camel, plan]];
  }));
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_materialization.v1',
    schema_version: 'synthi.gpu_hmr.real_rocm_app_hook_materialization.v1',
    status: 'app_hook_materialization_complete',
    proofAuthority: 'plan_only_app_hook_materialization_not_runtime_proof',
    proof_authority: 'plan_only_app_hook_materialization_not_runtime_proof',
    required: true,
    acceptedAsPlanningEvidence: true,
    accepted_as_planning_evidence: true,
    acceptedAsRefusalEvidence: false,
    accepted_as_refusal_evidence: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    appHookAuthoringReady: true,
    app_hook_authoring_ready: true,
    materializationComplete: true,
    materialization_complete: true,
    candidateComplete: true,
    candidate_complete: true,
    contractComplete: true,
    contract_complete: true,
    runtimeObservedComplete: true,
    runtime_observed_complete: true,
    outputOracleMaterialized: true,
    output_oracle_materialized: true,
    outputOracleRequestedProfile: 'profile.tensor.checksum.v1',
    output_oracle_requested_profile: 'profile.tensor.checksum.v1',
    outputOracleSelectedSource: 'profile_runtime_profile',
    output_oracle_selected_source: 'profile_runtime_profile',
    contractDeclared: true,
    contract_declared: true,
    stagePlans,
    stage_plans: stagePlans,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: stageNames.map((stage) =>
      `evidence:app-hook-materialization:${scope}:${stage}`
    ),
    evidence_refs: stageNames.map((stage) =>
      `evidence:app-hook-materialization:${scope}:${stage}`
    ),
    materializationHash: hashValue(`app-hook-materialization:${scope}`),
    materialization_hash: hashValue(`app-hook-materialization:${scope}`),
    contractHash: hashValue(`app-hook-materialization:${scope}`),
    contract_hash: hashValue(`app-hook-materialization:${scope}`),
    ...overrides,
  };
}

function acceptedSameProcessRuntimeOracle(scope, overrides = {}) {
  const closureRefs = [
    `runtime-proof-artifact:sha256:${sha256Hex(`compute:${scope}`)}`,
    hashValue(`compute-artifact-after:${scope}`),
    `epoch:${scope}`,
    `dispatch:${scope}`,
    `output-target:${scope}`,
  ];
  return {
    schemaVersion: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v1',
    schema_version: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v1',
    declared: true,
    required: true,
    status: 'same_process_runtime_oracle_contract_proven',
    proofAuthority: 'runtime_stage_evidence_not_serialized_claim',
    proof_authority: 'runtime_stage_evidence_not_serialized_claim',
    accepted: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    appHookContractAccepted: true,
    app_hook_contract_accepted: true,
    artifactTransportObserved: true,
    artifact_transport_observed: true,
    epochPublicationObserved: true,
    epoch_publication_observed: true,
    dispatchTraceObserved: true,
    dispatch_trace_observed: true,
    dispatchUsedPublishedEpoch: true,
    dispatch_used_published_epoch: true,
    sameProcessIdentityObserved: true,
    same_process_identity_observed: true,
    outputOracleObserved: true,
    output_oracle_observed: true,
    outputTargetObserved: true,
    output_target_observed: true,
    outputTargetMatched: true,
    output_target_matched: true,
    outputAfterDispatchObserved: true,
    output_after_dispatch_observed: true,
    artifactEpochMatched: true,
    artifact_epoch_matched: true,
    firewallAccepted: true,
    firewall_accepted: true,
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    stageResults: {
      artifact_transport: { observed: true },
      epoch_publication: { observed: true },
      dispatch_trace: {
        observed: true,
        dispatchUsedPublishedEpoch: true,
        dispatch_used_published_epoch: true,
      },
      host_identity: {
        observed: true,
        sameProcessIdentityObserved: true,
        same_process_identity_observed: true,
      },
      output_oracle: {
        observed: true,
        outputTargetObserved: true,
        output_target_observed: true,
        outputTargetMatched: true,
        output_target_matched: true,
        outputAfterDispatchObserved: true,
        output_after_dispatch_observed: true,
        dispatchOutputTarget: `output-target:${scope}`,
        dispatch_output_target: `output-target:${scope}`,
        oracleOutputTarget: `output-target:${scope}`,
        oracle_output_target: `output-target:${scope}`,
      },
    },
    stage_results: {
      artifact_transport: { observed: true },
      epoch_publication: { observed: true },
      dispatch_trace: {
        observed: true,
        dispatchUsedPublishedEpoch: true,
        dispatch_used_published_epoch: true,
      },
      host_identity: {
        observed: true,
        sameProcessIdentityObserved: true,
        same_process_identity_observed: true,
      },
      output_oracle: {
        observed: true,
        outputTargetObserved: true,
        output_target_observed: true,
        outputTargetMatched: true,
        output_target_matched: true,
        outputAfterDispatchObserved: true,
        output_after_dispatch_observed: true,
        dispatchOutputTarget: `output-target:${scope}`,
        dispatch_output_target: `output-target:${scope}`,
        oracleOutputTarget: `output-target:${scope}`,
        oracle_output_target: `output-target:${scope}`,
      },
    },
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [`evidence:same-process-runtime-oracle:${scope}`, ...closureRefs],
    evidence_refs: [`evidence:same-process-runtime-oracle:${scope}`, ...closureRefs],
    contractHash: hashValue(`same-process-runtime-oracle:${scope}`),
    contract_hash: hashValue(`same-process-runtime-oracle:${scope}`),
    ...overrides,
  };
}

function runtimeAdapterBoundaryBridgeFixture(scope, materials, overrides = {}) {
  const artifactHash = hashValue(`compute-artifact-after:${scope}`);
  const adapterResultHash = hashValue(`runtime-adapter-result:${scope}`);
  const proofLedgerId = materials.proofLedger?.proof_id
    ?? materials.proofLedger?.proofId
    ?? `gpu-ledger-proof:sha256:${sha256Hex(`ledger:${scope}`)}`;
  const strictRuntimeProofId = materials.runtimeProofArtifact?.proofId
    ?? materials.runtime_proof_artifact?.proofId
    ?? `gpu-runtime-proof:sha256:${sha256Hex(`runtime:${scope}`)}`;
  const hostIdentityRuntimeSession = `runtime-session:${scope}`;
  const hostIdentityProcessId = 'pid:4242';
  const boundaryLines = [
    `[gpu-runtime-boundary] artifact_transport event=loaded id=loader:${scope} runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} generation=generation:${scope} artifact_hash=${artifactHash} artifact_bytes=8 reload_request_transport=ram_bytes selected_loader_transport=ram_bytes loader_api=hipModuleLoadData ram_reference=true ram_blob_id=artifact:${artifactHash} ram_transport_proven=true load_result=ok timestamp_monotonic_ns=1000`,
    `[gpu-runtime-boundary] dispatcher_epoch event=published id=epoch:${scope} runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} epoch=epoch:${scope} active_generation=generation:${scope} previous_generation=generation:previous host_identity_active_generation=2 host_identity_previous_generation=1 new_artifact_id=artifact:${artifactHash} new_artifact_hash=${artifactHash} dispatch_table_entry_id=dispatch-table-entry:${scope} dispatch_table_hash_before=${hashValue(`dispatch-table-before:${scope}`)} dispatch_table_hash_after=${hashValue(`dispatch-table-after:${scope}`)} changed_entries=1 stream_ordering_proven=true retirement_tracked=true old_generation_retired=true timestamp_monotonic_ns=2000`,
    `[gpu-runtime-boundary] native_runtime_dispatch dispatch=ok proof_bridge=complete attachment_provenance=native_runtime_bridge runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} artifact_id=artifact:${artifactHash} epoch=epoch:${scope} generation=generation:${scope} dispatch_id=dispatch:${scope} output_target_id=output-target:${scope} dispatch_timestamp=3000 dispatch_table_entry_id=dispatch-table-entry:${scope} dispatch_table_hash=${hashValue(`dispatch-table-after:${scope}`)}`,
    `[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=1 runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} timestamp_monotonic_ns=3400`,
    `[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} timestamp_monotonic_ns=3500`,
    `[gpu-runtime-boundary] host_identity role=host_state ptr=0x1000 aux=42 generation=1 runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} timestamp_monotonic_ns=3400`,
    `[gpu-runtime-boundary] host_identity role=host_state ptr=0x1000 aux=42 generation=2 runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} timestamp_monotonic_ns=3500`,
    `[gpu-runtime-boundary] host_identity role=stream_context ptr=0x2000 aux=0 generation=1 runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} timestamp_monotonic_ns=3400`,
    `[gpu-runtime-boundary] host_identity role=stream_context ptr=0x2000 aux=0 generation=2 runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} device_uuid=gpu:synthetic-rocm context_id=context:0 queue_id=stream:0 timestamp_monotonic_ns=3500`,
    `[gpu-runtime-boundary] output_oracle id=oracle:${scope} kind=buffer_checksum expected=${hashValue(`compute-checksum-after:${scope}`)} actual=${hashValue(`compute-checksum-after:${scope}`)} passed=true runtime_session=${hostIdentityRuntimeSession} process_id=${hostIdentityProcessId} artifact_id=artifact:${artifactHash} epoch=epoch:${scope} generation=generation:${scope} output_target_id=output-target:${scope} after_dispatch_id=dispatch:${scope} dispatch_table_entry_id=dispatch-table-entry:${scope} readback_timestamp=4000 timestamp_monotonic_ns=4000 readback_bytes=8 readback_sample_sha256=${hashValue(`readback-slice:${scope}`)}`,
  ];
  return {
    schemaVersion: 'synthi.real_rocm.runtime_profile_adapter_result_bridge.v1',
    schema_version: 'synthi.real_rocm.runtime_profile_adapter_result_bridge.v1',
    proofAuthority: 'declared_adapter_result_import_not_runtime_authority',
    proof_authority: 'declared_adapter_result_import_not_runtime_authority',
    status: 'runtime_profile_adapter_result_imported',
    declared: true,
    present: true,
    resultPresent: true,
    result_present: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    strictRuntimeProofAccepted: true,
    strict_runtime_proof_accepted: true,
    strictRuntimeProofGateAccepted: true,
    strict_runtime_proof_gate_accepted: true,
    strictRuntimeProofGate: {
      status: 'pass',
      accepted: true,
      failures: [],
    },
    strict_runtime_proof_gate: {
      status: 'pass',
      accepted: true,
      failures: [],
    },
    strictRuntimeProofArtifactPresent: true,
    strict_runtime_proof_artifact_present: true,
    proofLedgerPresent: true,
    proof_ledger_present: true,
    strictRuntimeProofId,
    strict_runtime_proof_id: strictRuntimeProofId,
    proofLedgerId,
    proof_ledger_id: proofLedgerId,
    adapterResultHash,
    adapter_result_hash: adapterResultHash,
    adapterRuntimeBoundaryLines: boundaryLines,
    adapter_runtime_boundary_lines: boundaryLines,
    evidenceRefs: [
      adapterResultHash,
      ...boundaryLines.map((line) => `adapter-boundary:${hashValue(line)}`),
    ],
    evidence_refs: [
      adapterResultHash,
      ...boundaryLines.map((line) => `adapter-boundary:${hashValue(line)}`),
    ],
    blockingGaps: [],
    blocking_gaps: [],
    failedGates: [],
    failed_gates: [],
    ...overrides,
  };
}

function replaceBoundaryHostIdentityWithWeakEvent(lines, scope) {
  const weakHostIdentityLine =
    `[gpu-runtime-boundary] host_identity event=stable runtime_session=runtime-session:${scope} process_id=pid:4242 device_uuid=gpu:synthetic-rocm context_id=context:0 queue_id=stream:0 generation=2 timestamp_monotonic_ns=3500`;
  let inserted = false;
  const result = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (/\bhost_identity\b/i.test(String(line ?? ''))) {
      if (!inserted) {
        result.push(weakHostIdentityLine);
        inserted = true;
      }
      continue;
    }
    result.push(line);
  }
  if (!inserted) result.push(weakHostIdentityLine);
  return result;
}

function runtimeAdapterExecutionFixture(scope, materials, overrides = {}) {
  const boundaryBridge = runtimeAdapterBoundaryBridgeFixture(scope, materials);
  const boundaryLines = boundaryBridge.adapterRuntimeBoundaryLines;
  const adapterCommandHash = hashValue(`runtime-adapter-command:${scope}`);
  return {
    schemaVersion: 'synthi.real_rocm.runtime_adapter_execution.v1',
    schema_version: 'synthi.real_rocm.runtime_adapter_execution.v1',
    proofAuthority: 'adapter_execution_evidence_only_not_runtime_authority',
    proof_authority: 'adapter_execution_evidence_only_not_runtime_authority',
    declared: true,
    enabled: true,
    status: 'runtime_adapter_executed',
    adapterTemplate: 'runtime_boundary_log_harvest_v1',
    adapter_template: 'runtime_boundary_log_harvest_v1',
    adapterCommandHash,
    adapter_command_hash: adapterCommandHash,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    runtimeBoundaryLines: boundaryLines,
    runtime_boundary_lines: boundaryLines,
    runtimeBoundaryLineCount: boundaryLines.length,
    runtime_boundary_line_count: boundaryLines.length,
    evidenceRefs: [
      `runtime-adapter-execution:${scope}`,
      `runtime-adapter-template:runtime_boundary_log_harvest_v1`,
      `runtime-adapter-command:${adapterCommandHash}`,
      ...boundaryLines.map((line) => `runtime-adapter-boundary:${hashValue(line)}`),
    ],
    evidence_refs: [
      `runtime-adapter-execution:${scope}`,
      `runtime-adapter-template:runtime_boundary_log_harvest_v1`,
      `runtime-adapter-command:${adapterCommandHash}`,
      ...boundaryLines.map((line) => `runtime-adapter-boundary:${hashValue(line)}`),
    ],
    blockingGaps: [],
    blocking_gaps: [],
    failedGates: [],
    failed_gates: [],
    ...overrides,
  };
}

function runtimeAdapterStageEventsFixture(lines, overrides = {}) {
  const stageDefs = [
    {
      camel: 'artifactTransport',
      snake: 'artifact_transport',
      pattern: /\bartifact_transport\b/i,
      proofKinds: [
        'changed_artifact_hash',
        'same_process_transport_event',
        'loaded_artifact_hash',
      ],
    },
    {
      camel: 'epochPublication',
      snake: 'epoch_publication',
      pattern: /\bdispatcher_epoch\b/i,
      proofKinds: [
        'published_epoch',
        'published_artifact_hash',
        'same_process_epoch_event',
      ],
    },
    {
      camel: 'dispatchTrace',
      snake: 'dispatch_trace',
      pattern: /\b(?:native_runtime_dispatch|synthi_gpu_launch)\b/i,
      proofKinds: [
        'dispatch_id',
        'dispatch_epoch',
        'dispatch_artifact_hash',
      ],
    },
    {
      camel: 'hostIdentity',
      snake: 'host_identity',
      pattern: /\bhost_identity\b/i,
      proofKinds: [
        'process_id',
        'device_identity',
        'context_or_queue_identity',
      ],
    },
    {
      camel: 'outputOracle',
      snake: 'output_oracle',
      pattern: /\boutput_oracle\b/i,
      proofKinds: [
        'after_dispatch_id',
        'output_target_id',
        'readback_or_visual_artifact',
      ],
    },
  ];
  const normalizedLines = (Array.isArray(lines) ? lines : [])
    .filter((line) => /\[gpu-runtime-boundary\]/i.test(String(line ?? '')));
  const stageResults = {};
  const blockingGaps = [];
  for (const stage of stageDefs) {
    const stageLines = normalizedLines.filter((line) => stage.pattern.test(line));
    const observed = stageLines.length > 0;
    const fieldChecks = Object.fromEntries(stage.proofKinds.map((kind) => [kind, observed]));
    const result = {
      stage: stage.snake,
      observed,
      runtimeObserved: observed,
      runtime_observed: observed,
      boundaryLineCount: stageLines.length,
      boundary_line_count: stageLines.length,
      boundaryLineHashes: stageLines.map(hashValue),
      boundary_line_hashes: stageLines.map(hashValue),
      requiredProofKinds: stage.proofKinds,
      required_proof_kinds: stage.proofKinds,
      missingProofKinds: observed ? [] : stage.proofKinds,
      missing_proof_kinds: observed ? [] : stage.proofKinds,
      fieldChecks,
      field_checks: fieldChecks,
      evidenceRefs: stageLines.map((line) =>
        `runtime-adapter-stage:${stage.snake}:${hashValue(line)}`
      ),
      evidence_refs: stageLines.map((line) =>
        `runtime-adapter-stage:${stage.snake}:${hashValue(line)}`
      ),
    };
    if (!observed) blockingGaps.push(`runtime_adapter_stage_${stage.snake}_missing`);
    for (const proofKind of result.missingProofKinds) {
      blockingGaps.push(`runtime_adapter_stage_${stage.snake}_${proofKind}_missing`);
    }
    stageResults[stage.camel] = result;
    stageResults[stage.snake] = result;
  }
  const boundaryLineHashes = normalizedLines.map(hashValue);
  const facetSeed = { boundaryLineHashes, stageResults, blockingGaps };
  return {
    schemaVersion: 'synthi.real_rocm.runtime_adapter_stage_events.v1',
    schema_version: 'synthi.real_rocm.runtime_adapter_stage_events.v1',
    proofAuthority: 'runtime_adapter_stage_events_normalized_not_runtime_authority',
    proof_authority: 'runtime_adapter_stage_events_normalized_not_runtime_authority',
    present: normalizedLines.length > 0,
    complete: blockingGaps.length === 0 && normalizedLines.length > 0,
    acceptedAsSupportEvidence: blockingGaps.length === 0 && normalizedLines.length > 0,
    accepted_as_support_evidence: blockingGaps.length === 0 && normalizedLines.length > 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    boundaryLineCount: normalizedLines.length,
    boundary_line_count: normalizedLines.length,
    boundaryLineHashes,
    boundary_line_hashes: boundaryLineHashes,
    missingStages: stageDefs
      .filter((stage) => stageResults[stage.snake].observed !== true)
      .map((stage) => stage.snake),
    missing_stages: stageDefs
      .filter((stage) => stageResults[stage.snake].observed !== true)
      .map((stage) => stage.snake),
    blockingGaps,
    blocking_gaps: blockingGaps,
    stageResults,
    stage_results: stageResults,
    evidenceRefs: Object.values(stageResults).flatMap((stage) => stage.evidenceRefs),
    evidence_refs: Object.values(stageResults).flatMap((stage) => stage.evidenceRefs),
    facetHash: hashValue(stableJson(facetSeed)),
    facet_hash: hashValue(stableJson(facetSeed)),
    ...overrides,
  };
}

function acceptedLargeRocmSourceDeltaExecution(scope) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_execution.v1',
    phases: [
      ['hot_delta_1', 'real_repo_user_source_delta_hmr'],
      ['hot_delta_2', 'real_repo_second_user_source_delta_hmr'],
      ['negative_edit', 'real_repo_negative-edit_user_source_delta_hmr'],
    ].map(([kind, phaseName], index) => ({
      label: `${kind}:${scope}`,
      phaseName,
      phase_name: phaseName,
      phaseKind: kind,
      phase_kind: kind,
      metricScope: kind,
      metric_scope: kind,
      file: `src/${scope}/kernel_${index}.hip`,
      editHash: hashValue(`${scope}:${kind}:edit`),
      edit_hash: hashValue(`${scope}:${kind}:edit`),
      sourceBeforeHash: hashValue(`${scope}:${kind}:before`),
      source_before_hash: hashValue(`${scope}:${kind}:before`),
      sourceAfterHash: hashValue(`${scope}:${kind}:after`),
      source_after_hash: hashValue(`${scope}:${kind}:after`),
      sourceWriteObserved: true,
      source_write_observed: true,
      compileCallAttempted: true,
      compile_call_attempted: true,
      compileCallCompleted: kind !== 'negative_edit',
      compile_call_completed: kind !== 'negative_edit',
      expectedRefusal: kind === 'negative_edit',
      expected_refusal: kind === 'negative_edit',
    })),
  };
}

function acceptedLargeRocmProfileObligations(scope) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status: 'profile_proof_obligations_met',
    proofAuthority: 'profile_configuration_gate_not_runtime_proof',
    proof_authority: 'profile_configuration_gate_not_runtime_proof',
    declared: true,
    targetClass: 'large_rocm_ml_infrastructure',
    target_class: 'large_rocm_ml_infrastructure',
    finalAcceptance: true,
    final_acceptance: true,
    largeMlFinalAcceptance: true,
    large_ml_final_acceptance: true,
    requiresFullRuntimeProof: true,
    requires_full_runtime_proof: true,
    requiresOutputOracle: true,
    requires_output_oracle: true,
    outputOraclePresent: true,
    output_oracle_present: true,
    requiresRunModes: true,
    requires_run_modes: true,
    requiresRunModesDeclared: true,
    requires_run_modes_declared: true,
    requiresNegativeEdit: true,
    requires_negative_edit: true,
    requiresNegativeEditDeclared: true,
    requires_negative_edit_declared: true,
    hotDelta2FixtureDeclared: true,
    hot_delta_2_fixture_declared: true,
    negativeEditFixtureDeclared: true,
    negative_edit_fixture_declared: true,
    sourceDeltaExecutionAccepted: true,
    source_delta_execution_accepted: true,
    appHookContractDeclared: true,
    app_hook_contract_declared: true,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [`evidence:large-rocm-profile-obligations:${scope}`],
    evidence_refs: [`evidence:large-rocm-profile-obligations:${scope}`],
  };
}

function largeRocmMlProfile(scope) {
  return {
    id: scope,
    targetClass: 'large_rocm_ml_infrastructure',
    target_class: 'large_rocm_ml_infrastructure',
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      target_class: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requires_full_runtime_proof: true,
      requiresOutputOracle: true,
      requires_output_oracle: true,
      requiresAppHookContract: true,
      requires_app_hook_contract: true,
      requiresRunModes: true,
      requires_run_modes: true,
      requiresNegativeEdit: true,
      requires_negative_edit: true,
    },
    proof_obligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      target_class: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requires_full_runtime_proof: true,
      requiresOutputOracle: true,
      requires_output_oracle: true,
      requiresAppHookContract: true,
      requires_app_hook_contract: true,
      requiresRunModes: true,
      requires_run_modes: true,
      requiresNegativeEdit: true,
      requires_negative_edit: true,
    },
    sourceDelta: {
      second: {
        file: `src/${scope}/kernel_hot2.hip`,
        before: 'return x + y;',
        after: 'return x + y + 1;',
      },
      extraDeltas: [{
        kind: 'negative_edit',
        file: `src/${scope}/kernel_negative.hip`,
        before: 'kernel(a, b, c);',
        after: 'kernel(a, c, b);',
        expectedRefusal: true,
      }],
    },
    source_delta: {
      second: {
        file: `src/${scope}/kernel_hot2.hip`,
        before: 'return x + y;',
        after: 'return x + y + 1;',
      },
      extra_deltas: [{
        kind: 'negative_edit',
        file: `src/${scope}/kernel_negative.hip`,
        before: 'kernel(a, b, c);',
        after: 'kernel(a, c, b);',
        expected_refusal: true,
      }],
    },
  };
}

function largeRocmMlProfileWithImplicitAppHook(scope) {
  const profile = JSON.parse(JSON.stringify(largeRocmMlProfile(scope)));
  delete profile.proofObligations.requiresAppHookContract;
  delete profile.proofObligations.requires_app_hook_contract;
  delete profile.proof_obligations.requiresAppHookContract;
  delete profile.proof_obligations.requires_app_hook_contract;
  return profile;
}

function withAcceptedRuntimeCapabilityPreflight(materials = {}) {
  const camelRuntimeProofArtifact = materials.runtimeProofArtifact && typeof materials.runtimeProofArtifact === 'object'
    ? materials.runtimeProofArtifact
    : {};
  const snakeRuntimeProofArtifact = materials.runtime_proof_artifact && typeof materials.runtime_proof_artifact === 'object'
    ? materials.runtime_proof_artifact
    : camelRuntimeProofArtifact;
  return {
    ...materials,
    runtimeCapabilityPreflight: acceptedRuntimeCapabilityPreflight,
    runtime_capability_preflight: acceptedRuntimeCapabilityPreflight,
    runtimeProofArtifact: {
      ...camelRuntimeProofArtifact,
      runtimeCapabilityPreflight: acceptedRuntimeCapabilityPreflight,
      runtime_capability_preflight: acceptedRuntimeCapabilityPreflight,
      realRocmSidecarRuntimeConsistency: acceptedSidecarRuntimeConsistencyNotApplicable,
      real_rocm_sidecar_runtime_consistency: acceptedSidecarRuntimeConsistencyNotApplicable,
    },
    runtime_proof_artifact: {
      ...snakeRuntimeProofArtifact,
      runtimeCapabilityPreflight: acceptedRuntimeCapabilityPreflight,
      runtime_capability_preflight: acceptedRuntimeCapabilityPreflight,
      realRocmSidecarRuntimeConsistency: acceptedSidecarRuntimeConsistencyNotApplicable,
      real_rocm_sidecar_runtime_consistency: acceptedSidecarRuntimeConsistencyNotApplicable,
    },
  };
}

function stripExpectedOutputVerified(value) {
  if (Array.isArray(value)) {
    value.forEach(stripExpectedOutputVerified);
    return value;
  }
  if (value && typeof value === 'object') {
    delete value.expected_output_verified;
    delete value.expectedOutputVerified;
    for (const nested of Object.values(value)) stripExpectedOutputVerified(nested);
  }
  return value;
}

function realRocmRuntimeProofMaterials(scope, options = {}) {
  return withAcceptedRuntimeCapabilityPreflight(runtimeProofMaterials(scope, options));
}

function realRocmRuntimeProofMaterialsWithSidecar(scope, options = {}) {
  const materials = realRocmRuntimeProofMaterials(scope, options);
  const deviceSidecar = acceptedRealRocmDeviceSidecarContract(scope, options.deviceSidecarOverrides);
  const sidecarRuntimeConsistency = acceptedRealRocmSidecarRuntimeConsistency(
    scope,
    options.sidecarRuntimeConsistencyOverrides,
  );
  return {
    ...materials,
    runtimeProofArtifact: {
      ...materials.runtimeProofArtifact,
      realRocmDeviceSidecarContract: deviceSidecar,
      real_rocm_device_sidecar_contract: deviceSidecar,
      deviceSidecarContract: deviceSidecar,
      device_sidecar_contract: deviceSidecar,
      realRocmSidecarRuntimeConsistency: sidecarRuntimeConsistency,
      real_rocm_sidecar_runtime_consistency: sidecarRuntimeConsistency,
      sidecarRuntimeConsistency,
      sidecar_runtime_consistency: sidecarRuntimeConsistency,
    },
    runtime_proof_artifact: {
      ...materials.runtime_proof_artifact,
      realRocmDeviceSidecarContract: deviceSidecar,
      real_rocm_device_sidecar_contract: deviceSidecar,
      deviceSidecarContract: deviceSidecar,
      device_sidecar_contract: deviceSidecar,
      realRocmSidecarRuntimeConsistency: sidecarRuntimeConsistency,
      real_rocm_sidecar_runtime_consistency: sidecarRuntimeConsistency,
      sidecarRuntimeConsistency,
      sidecar_runtime_consistency: sidecarRuntimeConsistency,
    },
  };
}

function realRocmComputeProofLedgerMaterials(scope, options = {}) {
  return withAcceptedRuntimeCapabilityPreflight(computeProofLedgerMaterials(scope, options));
}

function computeOracleArtifactsWithoutDirectPaths(computeOracleArtifacts) {
  const copy = JSON.parse(JSON.stringify(computeOracleArtifacts));
  for (const key of [
    'raw_readback_bin',
    'rawReadbackBin',
    'readback_schema_json',
    'readbackSchemaJson',
    'rendered_card_png',
    'renderedCardPng',
  ]) {
    delete copy[key];
  }
  return copy;
}

function proofLedgerForComputeOracleArtifacts(materials, computeOracleArtifacts) {
  const record = JSON.parse(JSON.stringify(materials.proofLedger.records[0]));
  const outputEvent = record.output_event ?? record.outputEvent ?? {};
  outputEvent.compute_oracle_artifacts = computeOracleArtifacts;
  outputEvent.computeOracleArtifacts = computeOracleArtifacts;
  record.output_event = outputEvent;
  record.outputEvent = outputEvent;
  const oracleArtifacts = record.oracle_artifacts ?? record.oracleArtifacts ?? {};
  oracleArtifacts.compute_oracle_artifacts = computeOracleArtifacts;
  oracleArtifacts.computeOracleArtifacts = computeOracleArtifacts;
  record.oracle_artifacts = oracleArtifacts;
  record.oracleArtifacts = oracleArtifacts;
  const proofLedger = buildGpuHmrProofLedger(record);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  return { proofLedger, proofLedgerQuery };
}

function withComputeOracleArtifacts(materials, computeOracleArtifacts) {
  const copy = JSON.parse(JSON.stringify(materials));
  const { proofLedger, proofLedgerQuery } = proofLedgerForComputeOracleArtifacts(
    copy,
    computeOracleArtifacts,
  );
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  copy.proofLedger = proofLedger;
  copy.proof_ledger = proofLedger;
  copy.proofLedgerQuery = proofLedgerQuery;
  copy.proof_ledger_query = proofLedgerQuery;
  copy.computeOracleArtifacts = computeOracleArtifacts;
  copy.compute_oracle_artifacts = computeOracleArtifacts;
  for (const key of ['runtimeProofArtifact', 'runtime_proof_artifact']) {
    if (!copy[key]) continue;
    copy[key].proofLedger = proofLedger;
    copy[key].proof_ledger = proofLedger;
    copy[key].proofLedgerQuery = proofLedgerQuery;
    copy[key].proof_ledger_query = proofLedgerQuery;
  }
  return copy;
}

function proofLedgerForVisualOracleArtifacts(materials, visualOracleArtifacts) {
  const record = JSON.parse(JSON.stringify(materials.proofLedger.records[0]));
  const outputEvent = record.output_event ?? record.outputEvent ?? {};
  outputEvent.kind = 'visual_frame';
  outputEvent.visual_oracle_artifacts = visualOracleArtifacts;
  outputEvent.visualOracleArtifacts = visualOracleArtifacts;
  record.output_event = outputEvent;
  record.outputEvent = outputEvent;
  const oracleArtifacts = record.oracle_artifacts ?? record.oracleArtifacts ?? {};
  oracleArtifacts.visual_oracle_artifacts = visualOracleArtifacts;
  oracleArtifacts.visualOracleArtifacts = visualOracleArtifacts;
  record.oracle_artifacts = oracleArtifacts;
  record.oracleArtifacts = oracleArtifacts;
  const proofLedger = buildGpuHmrProofLedger(record);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  return { proofLedger, proofLedgerQuery };
}

function withVisualOracleArtifacts(materials, visualOracleArtifacts) {
  const copy = JSON.parse(JSON.stringify(materials));
  const { proofLedger, proofLedgerQuery } = proofLedgerForVisualOracleArtifacts(
    copy,
    visualOracleArtifacts,
  );
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  copy.proofLedger = proofLedger;
  copy.proof_ledger = proofLedger;
  copy.proofLedgerQuery = proofLedgerQuery;
  copy.proof_ledger_query = proofLedgerQuery;
  copy.visualOracleArtifacts = visualOracleArtifacts;
  copy.visual_oracle_artifacts = visualOracleArtifacts;
  for (const key of ['runtimeProofArtifact', 'runtime_proof_artifact']) {
    if (!copy[key]) continue;
    copy[key].proofLedger = proofLedger;
    copy[key].proof_ledger = proofLedger;
    copy[key].proofLedgerQuery = proofLedgerQuery;
    copy[key].proof_ledger_query = proofLedgerQuery;
  }
  return copy;
}

async function computeOracleCasBackedArtifacts({
  baseArtifacts,
  casRoot,
  rawReadbackPath,
  schemaPath,
  cardPath,
  scope,
}) {
  const producer = { name: 'validation_matrix_smoke', kind: 'proof_runner' };
  const rawLocator = await writeArtifactToCas(await fs.readFile(rawReadbackPath), {
    artifactRoot: casRoot,
    artifactKind: 'runtime_compute_raw_readback',
    mediaType: 'application/octet-stream',
    role: 'raw_readback',
    producer,
    producerSubsystem: 'compute_oracle_artifact_transport',
    sessionNamespace: scope,
    transportKind: 'cas_shared_volume',
  });
  const schemaLocator = await writeArtifactToCas(await fs.readFile(schemaPath), {
    artifactRoot: casRoot,
    artifactKind: 'runtime_compute_readback_schema',
    mediaType: 'application/json',
    role: 'readback_schema',
    producer,
    producerSubsystem: 'compute_oracle_artifact_transport',
    sessionNamespace: scope,
    transportKind: 'cas_shared_volume',
  });
  const cardLocator = await writeArtifactToCas(await fs.readFile(cardPath), {
    artifactRoot: casRoot,
    artifactKind: 'runtime_compute_proof_card',
    mediaType: 'image/png',
    role: 'rendered_card',
    producer,
    producerSubsystem: 'compute_oracle_artifact_transport',
    sessionNamespace: scope,
    transportKind: 'cas_shared_volume',
  });
  const artifacts = {
    ...baseArtifacts,
    artifactCasRoot: casRoot,
    artifact_cas_root: casRoot,
    artifactCasLocators: [rawLocator, schemaLocator, cardLocator],
    artifact_cas_locators: [rawLocator, schemaLocator, cardLocator],
  };
  return artifacts;
}

function withNumericComputeEpoch(materials, epoch) {
  const numericEpoch = Number(epoch);
  assert.equal(Number.isInteger(numericEpoch) && numericEpoch >= 0, true);
  const copy = JSON.parse(JSON.stringify(materials));
  const replaceEpochFields = (value) => {
    if (Array.isArray(value)) {
      value.forEach(replaceEpochFields);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'epoch') value[key] = numericEpoch;
      else replaceEpochFields(child);
    }
  };
  replaceEpochFields(copy);
  const record = copy.proofLedger.records[0];
  for (const event of [
    record.epoch_publish_event,
    record.dispatch_event,
    record.output_event,
    record.retirement_event,
  ]) {
    if (event) event.epoch = numericEpoch;
  }
  if (record.output_event?.compute_oracle_artifacts) {
    record.output_event.compute_oracle_artifacts.epoch = numericEpoch;
  }
  if (record.oracle_artifacts?.compute_oracle_artifacts) {
    record.oracle_artifacts.compute_oracle_artifacts.epoch = numericEpoch;
  }
  if (copy.computeOracleArtifacts) copy.computeOracleArtifacts.epoch = numericEpoch;
  const proofLedger = buildGpuHmrProofLedger(record);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  copy.proofLedger = proofLedger;
  copy.proof_ledger = proofLedger;
  copy.proofLedgerQuery = proofLedgerQuery;
  copy.proof_ledger_query = proofLedgerQuery;
  for (const key of ['runtimeProofArtifact', 'runtime_proof_artifact']) {
    if (copy[key]) {
      copy[key].proofLedger = proofLedger;
      copy[key].proof_ledger = proofLedger;
      copy[key].proofLedgerQuery = proofLedgerQuery;
      copy[key].proof_ledger_query = proofLedgerQuery;
    }
  }
  return copy;
}

function realRocmRuntimeStageObligationsFixture(overrides = {}) {
  const stageProofKinds = {
    artifact_transport: ['changed_artifact_hash', 'same_process_transport_event', 'loaded_artifact_hash'],
    epoch_publication: ['published_epoch', 'published_artifact_hash', 'same_process_epoch_event'],
    dispatch_trace: ['dispatch_id', 'dispatch_epoch', 'dispatch_artifact_hash'],
    host_identity: ['process_id', 'device_identity', 'context_or_queue_identity'],
    output_oracle: ['after_dispatch_id', 'output_target_id', 'readback_or_visual_artifact'],
  };
  const stageResults = Object.fromEntries(Object.entries(stageProofKinds).map(([stage, proofKinds]) => [
    stage,
    {
      stage,
      required: true,
      observed: false,
      runtimeObserved: false,
      runtime_observed: false,
      requiredProofKinds: proofKinds,
      required_proof_kinds: proofKinds,
      missingProofKinds: proofKinds,
      missing_proof_kinds: proofKinds,
      evidenceRefs: [],
      evidence_refs: [],
    },
  ]));
  const blockingGaps = Object.entries(stageProofKinds).flatMap(([stage, proofKinds]) => [
    `${stage}_runtime_observation_missing`,
    ...proofKinds.map((kind) => `${stage}_${kind}_missing`),
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_stage_obligations.v1',
    schema_version: 'synthi.gpu_hmr.real_rocm_runtime_stage_obligations.v1',
    required: true,
    complete: false,
    accepted: false,
    readyForAcceptance: false,
    ready_for_acceptance: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    proofAuthority: 'derived_runtime_stage_obligation_ledger_not_runtime_proof',
    proof_authority: 'derived_runtime_stage_obligation_ledger_not_runtime_proof',
    status: 'runtime_stage_obligations_unmet',
    sourceDeltaExecutionPresent: true,
    source_delta_execution_present: true,
    sourceDeltaExecutionAccepted: true,
    source_delta_execution_accepted: true,
    fullRuntimeProofAccepted: false,
    full_runtime_proof_accepted: false,
    firewallAccepted: false,
    firewall_accepted: false,
    stageResults,
    stage_results: stageResults,
    missingStages: Object.keys(stageProofKinds),
    missing_stages: Object.keys(stageProofKinds),
    blockingGaps: [
      ...blockingGaps,
      'full_runtime_proof_not_accepted',
      'cpu_gpu_firewall_not_proven',
      'app_hook_contract_not_runtime_proof',
      'same_process_runtime_oracle_not_proven',
      'sidecar_runtime_consistency_not_proven',
      'compile_bridge_not_linked_to_runtime_proof',
      'runtime_capability_preflight_not_observed',
    ],
    blocking_gaps: [
      ...blockingGaps,
      'full_runtime_proof_not_accepted',
      'cpu_gpu_firewall_not_proven',
      'app_hook_contract_not_runtime_proof',
      'same_process_runtime_oracle_not_proven',
      'sidecar_runtime_consistency_not_proven',
      'compile_bridge_not_linked_to_runtime_proof',
      'runtime_capability_preflight_not_observed',
    ],
    evidenceRefs: ['real-rocm-source-delta-execution:sha256:fixture'],
    evidence_refs: ['real-rocm-source-delta-execution:sha256:fixture'],
    contractHash: hashValue('real-rocm-runtime-stage-obligations-fixture'),
    contract_hash: hashValue('real-rocm-runtime-stage-obligations-fixture'),
    ...overrides,
  };
}

function acceptedRealRocmRuntimeStageObligations(scope, overrides = {}) {
  const stageProofKinds = {
    artifact_transport: ['changed_artifact_hash', 'same_process_transport_event', 'loaded_artifact_hash'],
    epoch_publication: ['published_epoch', 'published_artifact_hash', 'same_process_epoch_event'],
    dispatch_trace: ['dispatch_id', 'dispatch_epoch', 'dispatch_artifact_hash'],
    host_identity: ['process_id', 'device_identity', 'context_or_queue_identity'],
    output_oracle: ['after_dispatch_id', 'output_target_id', 'readback_or_visual_artifact'],
  };
  const stageResults = Object.fromEntries(Object.entries(stageProofKinds).map(([stage, proofKinds]) => [
    stage,
    {
      stage,
      required: true,
      observed: true,
      runtimeObserved: true,
      runtime_observed: true,
      requiredProofKinds: proofKinds,
      required_proof_kinds: proofKinds,
      missingProofKinds: [],
      missing_proof_kinds: [],
      evidenceRefs: proofKinds.map((kind) => `evidence:runtime-stage:${scope}:${stage}:${kind}`),
      evidence_refs: proofKinds.map((kind) => `evidence:runtime-stage:${scope}:${stage}:${kind}`),
    },
  ]));
  const evidenceRefs = Object.values(stageResults).flatMap((stage) => stage.evidenceRefs);
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_stage_obligations.v1',
    schema_version: 'synthi.gpu_hmr.real_rocm_runtime_stage_obligations.v1',
    required: true,
    complete: true,
    accepted: true,
    readyForAcceptance: true,
    ready_for_acceptance: true,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    proofAuthority: 'derived_runtime_stage_obligation_ledger_not_runtime_proof',
    proof_authority: 'derived_runtime_stage_obligation_ledger_not_runtime_proof',
    status: 'runtime_stage_obligations_observed',
    sourceDeltaExecutionPresent: true,
    source_delta_execution_present: true,
    sourceDeltaExecutionAccepted: true,
    source_delta_execution_accepted: true,
    fullRuntimeProofAccepted: true,
    full_runtime_proof_accepted: true,
    firewallAccepted: true,
    firewall_accepted: true,
    appHookContractAccepted: true,
    app_hook_contract_accepted: true,
    sameProcessRuntimeOracleAccepted: true,
    same_process_runtime_oracle_accepted: true,
    sidecarRuntimeConsistencyAccepted: true,
    sidecar_runtime_consistency_accepted: true,
    stageResults,
    stage_results: stageResults,
    missingStages: [],
    missing_stages: [],
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs,
    evidence_refs: evidenceRefs,
    contractHash: hashValue(`real-rocm-runtime-stage-obligations:${scope}`),
    contract_hash: hashValue(`real-rocm-runtime-stage-obligations:${scope}`),
    ...overrides,
  };
}

function realRocmAppHookMaterializationFixture(overrides = {}) {
  const stageProofKinds = {
    artifact_transport: ['changed_artifact_hash', 'same_process_transport_event', 'loaded_artifact_hash'],
    epoch_publication: ['published_epoch', 'published_artifact_hash', 'same_process_epoch_event'],
    dispatch_trace: ['dispatch_id', 'dispatch_epoch', 'dispatch_artifact_hash'],
    host_identity: ['process_id', 'device_identity', 'context_or_queue_identity'],
    output_oracle: ['after_dispatch_id', 'output_target_id', 'readback_or_visual_artifact'],
  };
  const stagePlans = Object.fromEntries(Object.entries(stageProofKinds).map(([stage, proofKinds]) => [
    stage,
    {
      stage,
      required: true,
      planAvailable: true,
      plan_available: true,
      candidateEvidencePresent: false,
      candidate_evidence_present: false,
      contractEvidencePresent: false,
      contract_evidence_present: false,
      runtimeObserved: false,
      runtime_observed: false,
      proofKinds,
      proof_kinds: proofKinds,
      evidenceRefs: [],
      evidence_refs: [],
      status: 'planned_candidate_missing',
    },
  ]));
  const blockingGaps = [
    'app_hook_materialization_output_oracle_contract_missing',
    'app_hook_materialization_contract_not_declared',
    ...Object.keys(stageProofKinds).map((stage) =>
      `app_hook_materialization_${stage}_candidate_missing`
    ),
  ];
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_materialization.v1',
    schema_version: 'synthi.gpu_hmr.real_rocm_app_hook_materialization.v1',
    status: 'app_hook_materialization_incomplete',
    proofAuthority: 'plan_only_app_hook_materialization_not_runtime_proof',
    proof_authority: 'plan_only_app_hook_materialization_not_runtime_proof',
    required: true,
    acceptedAsPlanningEvidence: true,
    accepted_as_planning_evidence: true,
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    appHookAuthoringReady: false,
    app_hook_authoring_ready: false,
    materializationComplete: false,
    materialization_complete: false,
    candidateComplete: false,
    candidate_complete: false,
    contractComplete: false,
    contract_complete: false,
    runtimeObservedComplete: false,
    runtime_observed_complete: false,
    templateAvailable: true,
    template_available: true,
    requiredTemplateHash: hashValue('real-rocm-app-hook-materialization-template'),
    required_template_hash: hashValue('real-rocm-app-hook-materialization-template'),
    sourceDeltaRequired: true,
    source_delta_required: true,
    sourceDeltaPresent: true,
    source_delta_present: true,
    sourceDeltaAccepted: true,
    source_delta_accepted: true,
    sidecarCandidateMaterialized: true,
    sidecar_candidate_materialized: true,
    sidecarEvidenceComplete: true,
    sidecar_evidence_complete: true,
    sidecarSourceCoverageComplete: true,
    sidecar_source_coverage_complete: true,
    sidecarBackend: 'hip',
    sidecar_backend: 'hip',
    sidecarSourcePaths: ['src/kernels/entry_kernel.hip'],
    sidecar_source_paths: ['src/kernels/entry_kernel.hip'],
    sidecarEntryPoints: ['entry_kernel'],
    sidecar_entry_points: ['entry_kernel'],
    sidecarArtifactKind: 'hsaco',
    sidecar_artifact_kind: 'hsaco',
    compileBridgeCandidate: true,
    compile_bridge_candidate: true,
    compileBridgeStatus: 'compile_bridge_candidate_observed_not_runtime_proof',
    compile_bridge_status: 'compile_bridge_candidate_observed_not_runtime_proof',
    outputOracleRequired: true,
    output_oracle_required: true,
    outputOracleMaterialized: false,
    output_oracle_materialized: false,
    outputOracleRequestedProfile: 'none',
    output_oracle_requested_profile: 'none',
    outputOracleSelectedSource: null,
    output_oracle_selected_source: null,
    contractDeclared: false,
    contract_declared: false,
    stagePlans,
    stage_plans: stagePlans,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs: ['profile:real-rocm-large-lib', 'real-rocm-source-delta-execution:sha256:fixture'],
    evidence_refs: ['profile:real-rocm-large-lib', 'real-rocm-source-delta-execution:sha256:fixture'],
    materializationHash: hashValue('real-rocm-app-hook-materialization-fixture'),
    materialization_hash: hashValue('real-rocm-app-hook-materialization-fixture'),
    contractHash: hashValue('real-rocm-app-hook-materialization-fixture'),
    contract_hash: hashValue('real-rocm-app-hook-materialization-fixture'),
    ...overrides,
  };
}

function realRocmProofSchedulingFixture(overrides = {}) {
  const blockingGaps = [
    'proof_obligation_output_oracle_profile_missing',
    'proof_scheduling_upstream_lifecycle_runtime_absent',
    'proof_scheduling_upstream_lifecycle:upstream_run_not_started_after_build_failure',
    'proof_scheduling_output_oracle_disabled',
    'proof_scheduling_app_hook_contract_missing',
    'proof_scheduling_target_progression_missing',
  ];
  const validationBlocker = {
    schemaVersion: 'synthi.gpu_hmr.validation_blocker.v1',
    schema_version: 'synthi.gpu_hmr.validation_blocker.v1',
    status: 'terminal_for_current_attempt',
    scope: 'full_runtime_proof',
    stageId: 'wait_hmr',
    stage_id: 'wait_hmr',
    phaseName: 'real_repo_user_source_delta_hmr',
    phase_name: 'real_repo_user_source_delta_hmr',
    proofAuthority: 'validation_blocker_only_not_gpu_hmr_success',
    proof_authority: 'validation_blocker_only_not_gpu_hmr_success',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs: ['profile:real-rocm-large-lib', 'phase:real_repo_user_source_delta_hmr'],
    evidence_refs: ['profile:real-rocm-large-lib', 'phase:real_repo_user_source_delta_hmr'],
    waitPolicy: {
      requestedTimeoutMs: 1200000,
      requested_timeout_ms: 1200000,
      effectiveTimeoutMs: 30000,
      effective_timeout_ms: 30000,
      diagnosticCollectionBudgetMs: 30000,
      diagnostic_collection_budget_ms: 30000,
      proofFastFailEnabled: true,
      proof_fast_fail_enabled: true,
      skipAsyncRuntimeWaits: true,
      skip_async_runtime_waits: true,
    },
    wait_policy: {
      requestedTimeoutMs: 1200000,
      requested_timeout_ms: 1200000,
      effectiveTimeoutMs: 30000,
      effective_timeout_ms: 30000,
      diagnosticCollectionBudgetMs: 30000,
      diagnostic_collection_budget_ms: 30000,
      proofFastFailEnabled: true,
      proof_fast_fail_enabled: true,
      skipAsyncRuntimeWaits: true,
      skip_async_runtime_waits: true,
    },
    contractHash: hashValue('real-rocm-proof-scheduling-blocker'),
    contract_hash: hashValue('real-rocm-proof-scheduling-blocker'),
  };
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_proof_scheduling.v1',
    schema_version: 'synthi.gpu_hmr.real_rocm_proof_scheduling.v1',
    status: 'fast_fail_wait_budget_applied',
    proofAuthority: 'proof_scheduling_evidence_only_not_gpu_hmr_success',
    proof_authority: 'proof_scheduling_evidence_only_not_gpu_hmr_success',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    fastFailApplied: true,
    fast_fail_applied: true,
    skipAsyncRuntimeWaits: true,
    skip_async_runtime_waits: true,
    eventCount: 1,
    event_count: 1,
    blockingGaps,
    blocking_gaps: blockingGaps,
    validationBlockers: [validationBlocker],
    validation_blockers: [validationBlocker],
    contractHash: hashValue('real-rocm-proof-scheduling-fixture'),
    contract_hash: hashValue('real-rocm-proof-scheduling-fixture'),
    ...overrides,
  };
}

function runtimeAdapterResultTransportFixture(scope, overrides = {}) {
  const rawSha256 = hashValue(`runtime-adapter-transport:${scope}`);
  const adapterCommandHash = hashValue(`runtime-adapter-command:${scope}`);
  return {
    schemaVersion: 'synthi.real_rocm.runtime_adapter_result_transport.v1',
    schema_version: 'synthi.real_rocm.runtime_adapter_result_transport.v1',
    proofAuthority: 'runtime_adapter_result_transport_only_not_gpu_hmr_success',
    proof_authority: 'runtime_adapter_result_transport_only_not_gpu_hmr_success',
    declared: true,
    status: 'runtime_adapter_result_transport_copied',
    adapterTemplate: 'runtime_boundary_log_harvest_v1',
    adapter_template: 'runtime_boundary_log_harvest_v1',
    adapterCommandHash,
    adapter_command_hash: adapterCommandHash,
    declaredPath: `.gpu-hmr-test-logs/real-rocm-runtime-adapter-results/${scope}.json`,
    declared_path: `.gpu-hmr-test-logs/real-rocm-runtime-adapter-results/${scope}.json`,
    hostPath: `.gpu-hmr-test-logs/real-rocm-runtime-adapter-results/${scope}.json`,
    host_path: `.gpu-hmr-test-logs/real-rocm-runtime-adapter-results/${scope}.json`,
    workerPath: `/var/lib/synthi/runtime-adapter-results/${scope}.json`,
    worker_path: `/var/lib/synthi/runtime-adapter-results/${scope}.json`,
    copied: true,
    byteLength: 256,
    byte_length: 256,
    rawSha256,
    raw_sha256: rawSha256,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    evidenceRefs: [
      rawSha256,
      `runtime-adapter-result-transport:${scope}`,
      'runtime-adapter-template:runtime_boundary_log_harvest_v1',
      `runtime-adapter-command:${adapterCommandHash}`,
    ],
    evidence_refs: [
      rawSha256,
      `runtime-adapter-result-transport:${scope}`,
      'runtime-adapter-template:runtime_boundary_log_harvest_v1',
      `runtime-adapter-command:${adapterCommandHash}`,
    ],
    blockingGaps: [],
    blocking_gaps: [],
    failedGates: [],
    failed_gates: [],
    ...overrides,
  };
}

function runtimeBoundaryTargetEnvironmentFixture(scope, overrides = {}) {
  const environmentHash = hashValue(`runtime-boundary-target-environment:${scope}`);
  const exportedVariableNames = [
    'SYNTHI_GPU_HMR_RUNTIME_BOUNDARY',
    'SYNTHI_REAL_ROCM_RUNTIME_SESSION',
    'SYNTHI_GPU_HMR_RUNTIME_SESSION',
    'SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
    'SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
    'SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
    'SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
    'SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_RESULT_PATH',
    'SYNTHI_GPU_HMR_RUNTIME_ADAPTER_RESULT_PATH',
  ];
  return {
    schemaVersion: 'synthi.real_rocm.runtime_boundary_target_environment.v1',
    schema_version: 'synthi.real_rocm.runtime_boundary_target_environment.v1',
    proofAuthority: 'target_environment_exposure_only_not_gpu_hmr_success',
    proof_authority: 'target_environment_exposure_only_not_gpu_hmr_success',
    adapterDeclared: true,
    adapter_declared: true,
    adapterEnabled: true,
    adapter_enabled: true,
    upstreamRunEnabled: true,
    upstream_run_enabled: true,
    status: 'runtime_boundary_target_environment_exported',
    eventManifestRequested: true,
    event_manifest_requested: true,
    resultPathRequested: true,
    result_path_requested: true,
    declaredEventManifestPath:
      `.gpu-hmr-test-logs/real-rocm-runtime-adapter-events/${scope}.json`,
    declared_event_manifest_path:
      `.gpu-hmr-test-logs/real-rocm-runtime-adapter-events/${scope}.json`,
    workerEventManifestPath:
      `/var/lib/synthi/runtime-adapter-events/${scope}.json`,
    worker_event_manifest_path:
      `/var/lib/synthi/runtime-adapter-events/${scope}.json`,
    declaredResultPath:
      `.gpu-hmr-test-logs/real-rocm-runtime-adapter-results/${scope}.json`,
    declared_result_path:
      `.gpu-hmr-test-logs/real-rocm-runtime-adapter-results/${scope}.json`,
    workerResultPath:
      `/var/lib/synthi/runtime-adapter-results/${scope}.json`,
    worker_result_path:
      `/var/lib/synthi/runtime-adapter-results/${scope}.json`,
    exportedToUpstreamRun: true,
    exported_to_upstream_run: true,
    exportedVariableNames,
    exported_variable_names: exportedVariableNames,
    runtimeSession: `runtime-session:${scope}`,
    runtime_session: `runtime-session:${scope}`,
    acceptedAsSupportEvidence: true,
    accepted_as_support_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    environmentHash,
    environment_hash: environmentHash,
    evidenceRefs: [
      environmentHash,
      `runtime-boundary-target-environment:${scope}`,
    ],
    evidence_refs: [
      environmentHash,
      `runtime-boundary-target-environment:${scope}`,
    ],
    blockingGaps: [],
    blocking_gaps: [],
    failedGates: [],
    failed_gates: [],
    ...overrides,
  };
}

function runtimeBoundaryTargetProcessProvenanceFixture(
  scope,
  boundaryLines,
  targetEnvironment,
  overrides = {},
) {
  const normalizedLines = [...new Set((Array.isArray(boundaryLines) ? boundaryLines : [])
    .filter((line) => /\[gpu-runtime-boundary\]/i.test(String(line ?? ''))))];
  const lineRecords = normalizedLines.map((line) => {
    const runtimeSession = /\bruntime_session=([^\s]+)/.exec(line)?.[1] ?? null;
    const processId = /\bprocess_id=([^\s]+)/.exec(line)?.[1]
      ?? (/(\bpid=)(\d+)/.exec(line)?.[2]
        ? `pid:${/(\bpid=)(\d+)/.exec(line)[2]}`
        : null);
    return {
      lineHash: hashValue(line),
      line_hash: hashValue(line),
      runtimeSession,
      runtime_session: runtimeSession,
      processId,
      process_id: processId,
    };
  });
  const runtimeSessions = [...new Set(lineRecords.map((record) => record.runtimeSession).filter(Boolean))];
  const processIds = [...new Set(lineRecords.map((record) => record.processId).filter(Boolean))];
  const eventChecks = {
    artifact_transport: /\bartifact_transport\b/i,
    epoch_publication: /\bdispatcher_epoch\b/i,
    dispatch_trace: /\b(?:native_runtime_dispatch|synthi_gpu_launch)\b/i,
    host_identity: /\bhost_identity\b/i,
    output_oracle: /\boutput_oracle\b/i,
  };
  const missingEventKinds = Object.entries(eventChecks)
    .filter(([, pattern]) => !normalizedLines.some((line) => pattern.test(line)))
    .map(([kind]) => kind);
  const targetEnvironmentSession =
    targetEnvironment?.runtimeSession ?? targetEnvironment?.runtime_session ?? null;
  const facetHash = contentHashFor({
    scope,
    lineHashes: normalizedLines.map(hashValue),
    runtimeSessions,
    processIds,
    targetEnvironmentSession,
  });
  return {
    schemaVersion: 'synthi.real_rocm.runtime_boundary_target_process_provenance.v1',
    schema_version: 'synthi.real_rocm.runtime_boundary_target_process_provenance.v1',
    proofAuthority: 'runtime_boundary_target_process_provenance_only_not_gpu_hmr_success',
    proof_authority: 'runtime_boundary_target_process_provenance_only_not_gpu_hmr_success',
    present: normalizedLines.length > 0,
    complete: normalizedLines.length > 0
      && runtimeSessions.length === 1
      && processIds.length === 1
      && Boolean(targetEnvironmentSession)
      && runtimeSessions.includes(targetEnvironmentSession)
      && missingEventKinds.length === 0,
    provenanceComplete: normalizedLines.length > 0
      && runtimeSessions.length === 1
      && processIds.length === 1
      && Boolean(targetEnvironmentSession)
      && runtimeSessions.includes(targetEnvironmentSession)
      && missingEventKinds.length === 0,
    provenance_complete: normalizedLines.length > 0
      && runtimeSessions.length === 1
      && processIds.length === 1
      && Boolean(targetEnvironmentSession)
      && runtimeSessions.includes(targetEnvironmentSession)
      && missingEventKinds.length === 0,
    sourceBoundaryLinesProven: normalizedLines.length > 0,
    source_boundary_lines_proven: normalizedLines.length > 0,
    sourceBoundaryLineCount: normalizedLines.length,
    source_boundary_line_count: normalizedLines.length,
    acceptedAsSupportEvidence: true,
    accepted_as_support_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    boundaryLineCount: normalizedLines.length,
    boundary_line_count: normalizedLines.length,
    boundaryLineHashes: normalizedLines.map(hashValue),
    boundary_line_hashes: normalizedLines.map(hashValue),
    runtimeSessions,
    runtime_sessions: runtimeSessions,
    processIds,
    process_ids: processIds,
    targetEnvironmentAccepted: targetEnvironment?.acceptedAsSupportEvidence === true,
    target_environment_accepted: targetEnvironment?.accepted_as_support_evidence === true,
    targetEnvironmentSession,
    target_environment_session: targetEnvironmentSession,
    targetEnvironmentSessionMatched:
      Boolean(targetEnvironmentSession) && runtimeSessions.includes(targetEnvironmentSession),
    target_environment_session_matched:
      Boolean(targetEnvironmentSession) && runtimeSessions.includes(targetEnvironmentSession),
    resultTransportCopied: true,
    result_transport_copied: true,
    lineRecords,
    line_records: lineRecords,
    coverage: {
      missingEventKinds,
      missing_event_kinds: missingEventKinds,
    },
    facetHash,
    facet_hash: facetHash,
    evidenceRefs: [
      facetHash,
      ...normalizedLines.map((line) => `runtime-boundary-target-process:${hashValue(line)}`),
    ],
    evidence_refs: [
      facetHash,
      ...normalizedLines.map((line) => `runtime-boundary-target-process:${hashValue(line)}`),
    ],
    blockingGaps: [],
    blocking_gaps: [],
    failedGates: [],
    failed_gates: [],
    ...overrides,
  };
}

function realRocmSourceTreeTransportFixture(scope, overrides = {}) {
  const sourceTreeManifest = {
    schemaVersion: 'synthi.real_rocm.source_tree_manifest.v1',
    schema_version: 'synthi.real_rocm.source_tree_manifest.v1',
    sourceUrl: `https://example.invalid/rocm/${scope}.git`,
    source_url: `https://example.invalid/rocm/${scope}.git`,
    repoCommit: '0123456789abcdef0123456789abcdef01234567',
    repo_commit: '0123456789abcdef0123456789abcdef01234567',
    gitTreeHash: 'abcdef0123456789abcdef0123456789abcdef01',
    git_tree_hash: 'abcdef0123456789abcdef0123456789abcdef01',
    fileCount: 12000,
    file_count: 12000,
    listingHash: hashValue(`${scope}:git-ls-tree`),
    listing_hash: hashValue(`${scope}:git-ls-tree`),
    parseErrorCount: 0,
    parse_error_count: 0,
    proofAuthority: 'source_tree_identity_only_not_runtime_proof',
    proof_authority: 'source_tree_identity_only_not_runtime_proof',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    manifestHash: hashValue(`${scope}:source-tree-manifest`),
    manifest_hash: hashValue(`${scope}:source-tree-manifest`),
  };
  const artifactCasValidation = {
    schemaVersion: 'synthi.gpu_hmr.artifact_transport_evidence.v1',
    accepted: true,
    acceptedAsTransportEvidence: true,
    accepted_as_transport_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: 'transport_integrity_only',
    proof_authority: 'transport_integrity_only',
    manifestHash: hashValue(`${scope}:artifact-cas-manifest`),
    manifest_hash: hashValue(`${scope}:artifact-cas-manifest`),
    contentHash: hashValue(`${scope}:source-tree-manifest-bytes`),
    content_hash: hashValue(`${scope}:source-tree-manifest-bytes`),
    artifactId: `artifact:${hashValue(`${scope}:source-tree-manifest-bytes`)}`,
    artifact_id: `artifact:${hashValue(`${scope}:source-tree-manifest-bytes`)}`,
    transportKind: 'cas_shared_volume',
    transport_kind: 'cas_shared_volume',
    sharedMountCount: 3,
    shared_mount_count: 3,
    sharedMountRoles: ['frontend', 'mcp', 'worker'],
    shared_mount_roles: ['frontend', 'mcp', 'worker'],
    sharedStorage: {
      accepted: true,
      mountCount: 3,
      mount_count: 3,
    },
    shared_storage: {
      accepted: true,
      mountCount: 3,
      mount_count: 3,
    },
    byteLength: 2048,
    mediaType: 'application/vnd.synthi.real-rocm-source-tree-manifest+json',
    reasons: [],
    gaps: [],
  };
  return {
    schemaVersion: 'synthi.real_rocm.source_tree_transport.v1',
    schema_version: 'synthi.real_rocm.source_tree_transport.v1',
    status: 'source_tree_transport_evidence_accepted',
    proofAuthority: 'source_tree_transport_integrity_only_not_runtime_proof',
    proof_authority: 'source_tree_transport_integrity_only_not_runtime_proof',
    acceptedAsTransportEvidence: true,
    accepted_as_transport_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    sourceTreeManifest,
    source_tree_manifest: sourceTreeManifest,
    sourceTreeManifestHash: sourceTreeManifest.manifestHash,
    source_tree_manifest_hash: sourceTreeManifest.manifestHash,
    artifactCasValidation,
    artifact_cas_validation: artifactCasValidation,
    artifactCasManifestHash: artifactCasValidation.manifestHash,
    artifact_cas_manifest_hash: artifactCasValidation.manifestHash,
    sourceTreeCasRootConfigured: true,
    source_tree_cas_root_configured: true,
    transportKind: 'cas_shared_volume',
    transport_kind: 'cas_shared_volume',
    transferOperation: 'cas_shared_volume',
    transfer_operation: 'cas_shared_volume',
    hotPathOptimized: true,
    hot_path_optimized: true,
    blockingGaps: [],
    blocking_gaps: [],
    failedGates: [],
    failed_gates: [],
    evidenceRefs: [
      `source-tree-manifest:${sourceTreeManifest.manifestHash}`,
      `artifact-cas-manifest:${artifactCasValidation.manifestHash}`,
    ],
    evidence_refs: [
      `source-tree-manifest:${sourceTreeManifest.manifestHash}`,
      `artifact-cas-manifest:${artifactCasValidation.manifestHash}`,
    ],
    contractHash: hashValue(`${scope}:source-tree-transport`),
    contract_hash: hashValue(`${scope}:source-tree-transport`),
    ...overrides,
  };
}

const largeRocmProofSchedulingFixture = realRocmProofSchedulingFixture();
const largeRocmSourceTreeTransportFixture = realRocmSourceTreeTransportFixture('real-rocm-large-lib');
const largeRocmExternalHeaderPrerequisitesFixture =
  realRocmExternalHeaderPrerequisitesFixture('real-rocm-large-lib');

function realRocmExternalHeaderPrerequisitesFixture(scope, overrides = {}) {
  const prerequisiteOverrides = overrides.prerequisiteOverrides ?? overrides.prerequisite_overrides ?? {};
  const {
    prerequisiteOverrides: _prerequisiteOverrides,
    prerequisite_overrides: _prerequisiteOverridesSnake,
    ...facetOverrides
  } = overrides;
  const headerSetHash = hashValue(`${scope}:external-header-set`);
  const prerequisite = {
    schemaVersion: 'synthi.real_rocm.external_header_prerequisite.v1',
    schema_version: 'synthi.real_rocm.external_header_prerequisite.v1',
    proofAuthority: 'external_header_dependency_evidence_only_not_gpu_hmr_success',
    proof_authority: 'external_header_dependency_evidence_only_not_gpu_hmr_success',
    id: `${scope}-headers`,
    token: `\${REAL_ROCM_EXTERNAL_INCLUDE:${scope}-headers}`,
    sourceKind: 'git',
    source_kind: 'git',
    repoUrl: `https://example.invalid/rocm/${scope}-headers.git`,
    repo_url: `https://example.invalid/rocm/${scope}-headers.git`,
    commit: '1234567890abcdef1234567890abcdef12345678',
    includeRoot: 'include',
    include_root: 'include',
    workerIncludeRoot: `/tmp/synthi-real-rocm/external-headers/${scope}/include`,
    worker_include_root: `/tmp/synthi-real-rocm/external-headers/${scope}/include`,
    acceptedAsDependencyEvidence: true,
    accepted_as_dependency_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    status: 'external_header_dependency_available',
    materialization: {
      materialized: true,
      transportKind: 'cas_shared_volume',
      transport_kind: 'cas_shared_volume',
      sourceHash: hashValue(`${scope}:external-header-source`),
      source_hash: hashValue(`${scope}:external-header-source`),
    },
    install: {
      attempted: true,
      accepted: true,
      mode: 'cmake_install',
      reason: 'external_header_install_accepted',
    },
    inspection: {
      allRequiredHeadersPresent: true,
      all_required_headers_present: true,
      requiredHeaderCount: 1,
      required_header_count: 1,
      presentHeaderCount: 1,
      present_header_count: 1,
      headerRecords: [{
        header: 'half/half.hpp',
        hostPresent: true,
        host_present: true,
        workerPath: `/tmp/synthi-real-rocm/external-headers/${scope}/include/half/half.hpp`,
        worker_path: `/tmp/synthi-real-rocm/external-headers/${scope}/include/half/half.hpp`,
      }],
      header_records: [{
        header: 'half/half.hpp',
        hostPresent: true,
        host_present: true,
        workerPath: `/tmp/synthi-real-rocm/external-headers/${scope}/include/half/half.hpp`,
        worker_path: `/tmp/synthi-real-rocm/external-headers/${scope}/include/half/half.hpp`,
      }],
      headerSetHash,
      header_set_hash: headerSetHash,
    },
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [`external-header:${scope}:${headerSetHash}`],
    evidence_refs: [`external-header:${scope}:${headerSetHash}`],
    ...prerequisiteOverrides,
  };
  const facet = {
    schemaVersion: 'synthi.real_rocm.external_header_prerequisites.v1',
    schema_version: 'synthi.real_rocm.external_header_prerequisites.v1',
    proofAuthority: 'external_header_dependency_evidence_only_not_gpu_hmr_success',
    proof_authority: 'external_header_dependency_evidence_only_not_gpu_hmr_success',
    status: 'external_header_prerequisites_available',
    acceptedDependencyCount: 1,
    accepted_dependency_count: 1,
    prerequisiteCount: 1,
    prerequisite_count: 1,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    prerequisites: [prerequisite],
    blockingGaps: [],
    blocking_gaps: [],
  };
  return {
    ...facet,
    ...facetOverrides,
    prerequisites: [prerequisite],
  };
}

function realRocmMissingDependencyProbeFixture(overrides = {}) {
  return {
    schemaVersion: 'synthi.real_rocm.missing_dependency_probe.v1',
    schema_version: 'synthi.real_rocm.missing_dependency_probe.v1',
    proofAuthority: 'missing_dependency_refusal_evidence_only_not_gpu_hmr_success',
    proof_authority: 'missing_dependency_refusal_evidence_only_not_gpu_hmr_success',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status: 'missing_dependency_refusal_evidence',
    dependencyCount: 1,
    dependency_count: 1,
    headerDependencyCount: 1,
    header_dependency_count: 1,
    missingHeaderCount: 1,
    missing_header_count: 1,
    presentHeaderCount: 0,
    present_header_count: 0,
    workerProbeAttempted: true,
    worker_probe_attempted: true,
    workerProbeAccepted: true,
    worker_probe_accepted: true,
    includeRoots: ['/tmp/worker/large-rocm/include', '/usr/include', '/opt/rocm/include'],
    include_roots: ['/tmp/worker/large-rocm/include', '/usr/include', '/opt/rocm/include'],
    dependencies: [{
      token: 'half/half.hpp',
      normalizedToken: 'half_half.hpp',
      normalized_token: 'half_half.hpp',
      kind: 'header',
      headerProbeStatus: 'missing',
      header_probe_status: 'missing',
      candidatePaths: [
        '/tmp/worker/large-rocm/include/half/half.hpp',
        '/usr/include/half/half.hpp',
        '/opt/rocm/include/half/half.hpp',
      ],
      candidate_paths: [
        '/tmp/worker/large-rocm/include/half/half.hpp',
        '/usr/include/half/half.hpp',
        '/opt/rocm/include/half/half.hpp',
      ],
      observedPaths: [],
      observed_paths: [],
      packageOwners: [],
      package_owners: [],
      blockingGaps: ['missing_dependency:half_half.hpp', 'missing_header:half_half.hpp'],
      blocking_gaps: ['missing_dependency:half_half.hpp', 'missing_header:half_half.hpp'],
      evidenceRefs: ['evidence:upstream_lifecycle_failure', 'worker-include-probe:half_half.hpp'],
      evidence_refs: ['evidence:upstream_lifecycle_failure', 'worker-include-probe:half_half.hpp'],
    }],
    blockingGaps: ['missing_build_dependency', 'missing_dependency:half_half.hpp', 'missing_header:half_half.hpp'],
    blocking_gaps: ['missing_build_dependency', 'missing_dependency:half_half.hpp', 'missing_header:half_half.hpp'],
    evidenceRefs: ['evidence:upstream_lifecycle_failure', 'phase:upstream_gpu_build_run'],
    evidence_refs: ['evidence:upstream_lifecycle_failure', 'phase:upstream_gpu_build_run'],
    contractHash: hashValue('real-rocm-missing-dependency-probe-fixture'),
    contract_hash: hashValue('real-rocm-missing-dependency-probe-fixture'),
    ...overrides,
  };
}

const largeRocmLatestReport = {
  slug: 'gpu-real-rocm-large-lib-20260623',
  real_rocm_profile: {
    id: 'real-rocm-large-lib',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    source: 'scripts/profiles/real-rocm-large-lib.json',
  },
  source_url: 'https://example.invalid/rocm/large-lib.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/entry_kernel.hip',
  delta_file: 'src/kernels/activation_delta.h',
  target_name: 'LargeRocmDriver',
  gpu_vendor: 'rocm',
  gpu_arch: 'gfx1201',
  file_count: 12000,
  seeded_file_count: 11800,
  skipped_file_count: 200,
  full_runtime_proof_required: true,
  full_runtime_proven: false,
  gpu_hmr_success: false,
  runtime_capability_preflight: noDeviceRuntimeCapabilityPreflight,
  runtime_proof_artifact: null,
  proof_artifacts: [],
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'none',
    mode: 'none',
    sourceDerivedCandidateCount: 0,
    selectedSource: null,
    disabledReason: 'profile_disabled',
    contractPresent: false,
    runtimeProfilePresent: false,
    runtimeProfileSynced: false,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: '',
    phase: null,
    recognized: true,
    reason: 'phase_not_declared',
    targetName: 'LargeRocmDriver',
    finalAcceptanceTarget: 'LargeRocmDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    nonFinalPhase: false,
    nonFinalTargetRequired: false,
    requirements: [],
  },
  target_progression_gates: [
    {
      name: 'target progression phase',
      status: 'fail',
      detail: 'target progression phase is required but was not declared',
    },
  ],
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status: 'profile_proof_obligations_unmet',
    proofAuthority: 'profile_configuration_gate_not_runtime_proof',
    proof_authority: 'profile_configuration_gate_not_runtime_proof',
    declared: false,
    targetClass: 'large_rocm_ml_infrastructure',
    target_class: 'large_rocm_ml_infrastructure',
    refusalOnly: false,
    refusal_only: false,
    progressionRequired: true,
    progression_required: true,
    finalAcceptance: true,
    final_acceptance: true,
    largeMlFinalAcceptance: true,
    large_ml_final_acceptance: true,
    requiresFullRuntimeProof: true,
    requires_full_runtime_proof: true,
    fullRuntimeProofRequested: true,
    full_runtime_proof_requested: true,
    requiresOutputOracle: true,
    requires_output_oracle: true,
    outputOraclePresent: false,
    output_oracle_present: false,
    requiresRunModes: true,
    requires_run_modes: true,
    requiresRunModesDeclared: false,
    requires_run_modes_declared: false,
    requiresNegativeEdit: true,
    requires_negative_edit: true,
    requiresNegativeEditDeclared: false,
    requires_negative_edit_declared: false,
    blockingGaps: [
      'proof_obligation_output_oracle_profile_missing',
      'proof_obligation_run_modes_missing',
      'proof_obligation_negative_edit_missing',
    ],
    blocking_gaps: [
      'proof_obligation_output_oracle_profile_missing',
      'proof_obligation_run_modes_missing',
      'proof_obligation_negative_edit_missing',
    ],
  },
  real_rocm_app_hook_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1',
    declared: false,
    required: true,
    status: 'required_app_hook_contract_missing',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: false,
    contract_evidence_complete: false,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    blockingGaps: [
      'app_hook_contract_not_declared',
      'app_hook_artifact_transport_evidence_missing',
      'app_hook_epoch_publication_evidence_missing',
      'app_hook_dispatch_trace_evidence_missing',
      'app_hook_host_identity_evidence_missing',
      'app_hook_output_oracle_evidence_missing',
    ],
    blocking_gaps: [
      'app_hook_contract_not_declared',
      'app_hook_artifact_transport_evidence_missing',
      'app_hook_epoch_publication_evidence_missing',
      'app_hook_dispatch_trace_evidence_missing',
      'app_hook_host_identity_evidence_missing',
      'app_hook_output_oracle_evidence_missing',
    ],
  },
  real_rocm_device_sidecar_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: false,
    required: false,
    status: 'derived_device_sidecar_candidate_not_runtime_proof',
    proofAuthority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    proof_authority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    sourceCoverageComplete: true,
    source_coverage_complete: true,
    backend: 'hip',
    artifact_identity: {
      source_paths: ['src/kernels/entry_kernel.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['entry_kernel'],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang++',
      compiler_args_hash: hashValue('large-rocm-device-sidecar-compile-args'),
    },
    blockingGaps: [
      'device_sidecar_artifact_transport_runtime_not_observed',
      'device_sidecar_epoch_publication_runtime_not_observed',
      'device_sidecar_dispatch_trace_runtime_not_observed',
      'device_sidecar_output_oracle_runtime_not_observed',
      'device_sidecar_host_identity_runtime_not_observed',
    ],
    blocking_gaps: [
      'device_sidecar_artifact_transport_runtime_not_observed',
      'device_sidecar_epoch_publication_runtime_not_observed',
      'device_sidecar_dispatch_trace_runtime_not_observed',
      'device_sidecar_output_oracle_runtime_not_observed',
      'device_sidecar_host_identity_runtime_not_observed',
    ],
  },
  real_rocm_sidecar_runtime_consistency: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
    status: 'sidecar_runtime_backend_consistent_not_runtime_proof',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sidecarBackend: 'hip',
    sidecar_backend: 'hip',
    runtimeBackendCandidates: ['hip'],
    runtime_backend_candidates: ['hip'],
    backendConsistent: true,
    backend_consistent: true,
    blockingGaps: ['sidecar_runtime_sidecar_observation_missing'],
    blocking_gaps: ['sidecar_runtime_sidecar_observation_missing'],
  },
  real_rocm_runtime_stage_obligations: realRocmRuntimeStageObligationsFixture(),
  real_rocm_app_hook_materialization: realRocmAppHookMaterializationFixture(),
  real_rocm_source_tree_transport: largeRocmSourceTreeTransportFixture,
  source_tree_transport: largeRocmSourceTreeTransportFixture,
  real_rocm_external_header_prerequisites: largeRocmExternalHeaderPrerequisitesFixture,
  realRocmExternalHeaderPrerequisites: largeRocmExternalHeaderPrerequisitesFixture,
  external_header_prerequisites: largeRocmExternalHeaderPrerequisitesFixture,
  externalHeaderPrerequisites: largeRocmExternalHeaderPrerequisitesFixture,
  real_rocm_proof_scheduling: largeRocmProofSchedulingFixture,
  proof_scheduling: largeRocmProofSchedulingFixture,
  timeout_intelligence_failure: largeRocmProofSchedulingFixture,
  validation_blockers: largeRocmProofSchedulingFixture.validation_blockers,
  strict_proof_gates: {
    schemaVersion: 'synthi.gpu_hmr.strict_proof_gates.v1',
    name: 'strict runtime proof artifact presence',
    status: 'fail',
    accepted: false,
    failures: ['runtime_proof_artifact_missing'],
  },
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-large-lib-delta',
    editHash: hashValue('real-rocm-large-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/large-lib.git @ 0123456789ab files=12000' },
    { name: 'compile projection', status: 'pass', detail: 'real_repo_user_source_delta_hmr selected=120 bytes=1000000 omitted=11880' },
    {
      name: 'real_repo_user_source_delta_hmr',
      status: 'warn',
      detail: `provisional_wait_terminal=true gpu_proof=missing ${JSON.stringify({
        name: 'real_repo_user_source_delta_hmr',
        wait_hmr_status: 'timeout',
        gpu_proof_validation: {
          requiredState: 'gpu-hmr-full-runtime-proven',
          satisfied: false,
          reason: 'proof_state_missing',
        },
      })}`,
    },
    { name: 'strict runtime proof artifact presence', status: 'fail', detail: 'failures=runtime_proof_artifact_missing' },
  ],
};
await writeJson(path.join(logsRoot, 'real-rocm-results.json'), largeRocmLatestReport);
const retainedRealRocmDir = path.join(logsRoot, 'real-rocm-results');
await writeJson(
  path.join(retainedRealRocmDir, 'gpu-real-rocm-large-lib-20260623.json'),
  largeRocmLatestReport,
);
await writeJson(path.join(retainedRealRocmDir, 'gpu-real-rocm-second-lib-20260623.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-second-lib-20260623',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-second-lib',
    source: 'scripts/profiles/real-rocm-second-lib.json',
  },
  source_url: 'https://example.invalid/rocm/second-lib.git',
  entry_file: 'src/kernels/second_entry.hip',
  delta_file: 'src/kernels/second_delta.h',
  target_name: 'SecondRocmDriver',
  timingMetrics: {
    ...largeRocmLatestReport.timingMetrics,
    editId: 'real-rocm-second-lib-delta',
    editHash: hashValue('real-rocm-second-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/second-lib.git @ 0123456789ab files=8000' },
    ...largeRocmLatestReport.checks.slice(1),
  ],
});

const originalHostPreflightRocmDir = path.join(logsRoot, 'real-rocm-original-host-preflight');
await writeJson(path.join(originalHostPreflightRocmDir, 'real-rocm-original-host-preflight.json'), {
  slug: 'gpu-real-rocm-original-host-preflight-20260623',
  real_rocm_profile: { id: 'real-rocm-original-host-preflight' },
  source_url: 'https://example.invalid/rocm/original-host-preflight.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/original_host_preflight.hip',
  delta_file: 'src/kernels/original_host_preflight.hip',
  target_name: 'OriginalHostPreflightDriver',
  gpu_vendor: 'rocm',
  full_runtime_proven: false,
  gpu_hmr_success: false,
  originalHostPathProof: {
    runtimeCapabilityPreflightObserved: true,
    runtimeCapabilityPreflight: noDeviceRuntimeCapabilityPreflight,
  },
  checks: [
    {
      name: 'real ROCm repo',
      status: 'pass',
      detail: 'https://example.invalid/rocm/original-host-preflight.git @ 0123456789ab files=2000',
    },
    {
      name: 'real_repo_user_source_delta_hmr',
      status: 'warn',
      detail: JSON.stringify({
        wait_hmr_status: 'timeout',
        gpu_proof_validation: { reason: 'proof_state_missing', satisfied: false },
      }),
    },
  ],
});

await writeJson(path.join(artifactsRoot, 'webgpu-runtime-visual-proof', 'forged-webgpu-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu' },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

const forgedWebGpuVisualDir = path.join(artifactsRoot, 'webgpu-runtime-visual-proof');
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-after.png'), 8, 8, (x, y) => [32 + x, 48 + y, 64, 255]);
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-single-screenshot.png'), 8, 8, (x, y) => [
  16 + x,
  32 + y,
  64,
  255,
]);
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-single-image-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:single-image-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-single-image' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-single-image',
    visualRoot: forgedWebGpuVisualDir,
  }),
  visualOracleArtifacts: {
    diagnosticScreenshot: path.join(forgedWebGpuVisualDir, 'forged-single-screenshot.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-query-only-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:query-only-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-query-only' },
  visualOracleArtifacts: visualArtifactSet({
    before: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    after: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diff: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  }),
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
  asyncVisualMetrics: {
    accepted: true,
    acceptedAsAsyncVisualMetrics: true,
    acceptedForGpuHmr: true,
    gpuHmrSuccess: true,
    proofAuthority: 'async_visual_metrics_only',
    asyncVisualMetricsHash: `sha256:${'a'.repeat(64)}`,
  },
  visualArtifactTransportEvidence: {
    accepted: true,
    acceptedAsTransportEvidence: true,
    acceptedForGpuHmr: true,
    gpuHmrSuccess: true,
    proofAuthority: 'transport_integrity_only_not_visual_or_ledger_proof',
  },
  proofLedgerQuery: {
    schemaVersion: 'synthi.gpu.hmr.proof_ledger_query.v1',
    proofId: 'gpu-ledger-proof:sha256:forged-query-only',
    gpuHmrSuccess: true,
    failedInvariants: [],
  },
});

await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-hash-mismatch-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:hash-mismatch-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-hash-mismatch' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-hash-mismatch',
    visualRoot: forgedWebGpuVisualDir,
  }),
  visualOracleArtifacts: {
    beforeImage: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    beforeImageHash: hashValue('wrong-before-image-hash'),
    afterImage: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diffImage: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

const outsideVisualDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-outside-visual-'));
await writeRgbaPng(path.join(outsideVisualDir, 'outside-before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(outsideVisualDir, 'outside-after.png'), 8, 8, (x, y) => [40 + x, 56 + y, 72, 255]);
await writeRgbaPng(path.join(outsideVisualDir, 'outside-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-path-escape-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:path-escape-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-path-escape' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-path-escape',
    visualRoot: forgedWebGpuVisualDir,
  }),
  visualOracleArtifacts: {
    beforeImage: path.join(outsideVisualDir, 'outside-before.png'),
    afterImage: path.join(outsideVisualDir, 'outside-after.png'),
    diffImage: path.join(outsideVisualDir, 'outside-diff.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

const forgedWebGpuVisualArtifacts = visualArtifactSet({
  before: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
  after: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
  diff: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
});
Object.assign(forgedWebGpuVisualArtifacts, {
  ...completeVisualOracleArtifacts('hot_delta_1', forgedWebGpuVisualDir, forgedWebGpuVisualArtifacts),
});
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-source-adapted-visual-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:source-adapted-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-source-adapted-visual' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list',
    },
  },
  ...withVisualOracleArtifacts(runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-source-adapted-visual',
    visualRoot: forgedWebGpuVisualDir,
  }), forgedWebGpuVisualArtifacts),
  visualOracleArtifacts: forgedWebGpuVisualArtifacts,
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  runtimeProbeInstrumentation: {
    sourceAdaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adaptedOrAlreadyPresent: true,
  },
  runtime_probe_instrumentation: {
    source_adaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adapted_or_already_present: true,
  },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-seedless-visual-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:seedless-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-seedless-visual' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-seedless-visual',
    visualRoot: forgedWebGpuVisualDir,
  }),
  deterministicVisualMode: {
    ...deterministicMode('hot_delta_1'),
    fixed_seed: false,
    seed_policy_fixed: false,
    seed_policy_hash: null,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
    forgedByFixture: true,
  },
  visualOracleArtifacts: visualArtifactSet({
    before: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    after: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diff: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  }),
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

await writeJson(path.join(artifactsRoot, 'webgpu-runtime-compute-proof', 'forged-webgpu-compute-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_compute_proof.v1',
  proofId: 'webgpu-runtime-compute-proof:sha256:forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-compute' },
  computeOracleValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  contract: {
    webgpu_contract: {
      pipeline_kind: 'compute',
      supported_pipeline_scope: 'explicit-compute-profiled-layout-storage-uniform-float32-readback',
    },
  },
});

const hiprtDir = path.join(artifactsRoot, 'hiprt-light-math-warm-proof');
const hiprtAcceptedBefore = path.join(hiprtDir, 'accepted-before.png');
const hiprtAcceptedAfter = path.join(hiprtDir, 'accepted-after.png');
const hiprtAcceptedDiff = path.join(hiprtDir, 'accepted-diff.png');
await writeRgbaPng(hiprtAcceptedBefore, 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(hiprtAcceptedAfter, 8, 8, (x, y) => [24 + x, 32 + y, 48 + x + y, 255]);
await writeRgbaPng(hiprtAcceptedDiff, 8, 8, () => [255, 255, 255, 255]);
const hiprtAcceptedVisualArtifactsHot1 = visualArtifactSet({
  before: hiprtAcceptedBefore,
  after: hiprtAcceptedAfter,
  diff: hiprtAcceptedDiff,
});
Object.assign(hiprtAcceptedVisualArtifactsHot1, {
  ...completeVisualOracleArtifacts('hot_delta_1', hiprtDir, hiprtAcceptedVisualArtifactsHot1),
});
await writeJson(path.join(hiprtDir, 'accepted-hiprt-proof.json'), hiprtWarmProofArtifact({
  slug: 'accepted-hiprt-recomputed-oracle',
  profileId: 'accepted-hiprt-recomputed-oracle',
  baselinePath: hiprtAcceptedBefore,
  changedPath: hiprtAcceptedAfter,
  diffPath: hiprtAcceptedDiff,
  oracleRegionClaimNonBlank: true,
}));
await writeJson(path.join(hiprtDir, 'forged-hiprt-visual-threshold-proof.json'), hiprtWarmProofArtifact({
  slug: 'forged-hiprt-visual-threshold',
  profileId: 'forged-hiprt-visual-threshold',
  baselinePath: hiprtAcceptedBefore,
  changedPath: hiprtAcceptedAfter,
  diffPath: hiprtAcceptedDiff,
  oracleRegionClaimNonBlank: true,
  visualProofThresholds: {
    minChangedPixelRatio: 1.01,
    minMeanAbsDelta8bit: 512,
  },
}));
await writeJson(path.join(hiprtDir, 'accepted-hiprt-cold.json'), {
  ...runModeProofBase,
  backend: 'hiprt',
  targetId: 'accepted-hiprt-recomputed-oracle',
  profileId: 'accepted-hiprt-recomputed-oracle',
  acceptanceContract: hiprtAcceptanceContract('accepted-hiprt-cold', {
    projectId: 'accepted-hiprt-recomputed-oracle',
    profileId: 'accepted-hiprt-recomputed-oracle',
    baselinePath: hiprtAcceptedBefore,
    changedPath: hiprtAcceptedAfter,
    diffPath: hiprtAcceptedDiff,
  }),
  runtimeProbeInstrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  runtime_probe_instrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  coverageObligations: { perTargetRunModes: false },
  proofId: 'agent-split-run-mode-proof:sha256:accepted-hiprt-cold',
  coldSplitProven: true,
  cold_split_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  visualArtifacts: visualArtifactSet({
    before: hiprtAcceptedBefore,
    after: hiprtAcceptedAfter,
    diff: hiprtAcceptedDiff,
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split',
    editHash: hashValue('accepted-hiprt-cold'),
    editKind: 'cold_split',
  },
});
await writeJson(path.join(hiprtDir, 'accepted-hiprt-hot2.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:accepted-hiprt-hot2', 'gpu-runtime-proof:sha256:accepted-hiprt-hot2'),
  ...runtimeProofMaterials('hot_delta_2', {
    projectId: 'accepted-hiprt-recomputed-oracle',
    visualRoot: hiprtDir,
    sourceAdaptedVisualProfile: true,
  }),
  backend: 'hiprt',
  targetId: 'accepted-hiprt-recomputed-oracle',
  profileId: 'accepted-hiprt-recomputed-oracle',
  acceptanceContract: hiprtAcceptanceContract('accepted-hiprt-hot2', {
    projectId: 'accepted-hiprt-recomputed-oracle',
    profileId: 'accepted-hiprt-recomputed-oracle',
    baselinePath: hiprtAcceptedBefore,
    changedPath: hiprtAcceptedAfter,
    diffPath: hiprtAcceptedDiff,
  }),
  runtimeProbeInstrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  runtime_probe_instrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  coverageObligations: { perTargetRunModes: false },
  proofId: 'agent-split-run-mode-proof:sha256:accepted-hiprt-hot2',
  acceptedForGpuHmr: false,
  visualProfileAccepted: true,
  sourceAdaptedProfile: true,
  gpuHmrSuccess: false,
  visualArtifacts: visualArtifactSet({
    before: hiprtAcceptedBefore,
    after: hiprtAcceptedAfter,
    diff: hiprtAcceptedDiff,
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:accepted-hiprt-hot2',
    editHash: hashValue('accepted-hiprt-hot2'),
    editKind: 'different_gpu_edit',
    differentEdit: true,
  },
});

await writeJson(path.join(hiprtDir, 'forged-hiprt-missing-instrumentation-hot.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-hiprt-missing-instrumentation',
    'gpu-runtime-proof:sha256:forged-hiprt-missing-instrumentation',
  ),
  ...withVisualOracleArtifacts(runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-hiprt-missing-instrumentation',
    visualRoot: hiprtDir,
  }), hiprtAcceptedVisualArtifactsHot1),
  backend: 'hiprt',
  targetId: 'forged-hiprt-missing-instrumentation',
  profileId: 'forged-hiprt-missing-instrumentation',
  coverageObligations: { perTargetRunModes: false },
  proofId: 'agent-split-run-mode-proof:sha256:forged-hiprt-missing-instrumentation',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: hiprtAcceptedVisualArtifactsHot1,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-hiprt-missing-instrumentation',
    editHash: hashValue('forged-hiprt-missing-instrumentation'),
    editKind: 'gpu_artifact_edit',
  },
});

const hiprtForgedBefore = path.join(hiprtDir, 'forged-before.png');
const hiprtForgedAfter = path.join(hiprtDir, 'forged-after.png');
const hiprtForgedDiff = path.join(hiprtDir, 'forged-diff.png');
await writeRgbaPng(hiprtForgedBefore, 8, 8, (x, y) => [24 + x, 32 + y, 48 + x + y, 255]);
await writeRgbaPng(hiprtForgedAfter, 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(hiprtForgedDiff, 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(hiprtDir, 'forged-hiprt-proof.json'), hiprtWarmProofArtifact({
  slug: 'forged-hiprt-oracle-region-json',
  profileId: 'forged-hiprt-oracle-region-json',
  baselinePath: hiprtForgedBefore,
  changedPath: hiprtForgedAfter,
  diffPath: hiprtForgedDiff,
  oracleRegionClaimNonBlank: true,
}));

const truncatedVisualDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-truncated-visual');
await writePng(path.join(truncatedVisualDir, 'before-hmr-first.png'));
await writePng(path.join(truncatedVisualDir, 'after-hmr-first.png'));
await writePng(path.join(truncatedVisualDir, 'before-after-diff.png'));
await writeJson(path.join(truncatedVisualDir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:truncated-visual-hot1', 'gpu-runtime-proof:sha256:truncated-visual-hot1'),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'truncated-visual',
    visualRoot: truncatedVisualDir,
  }),
  targetId: 'truncated-visual',
  profileId: 'truncated-visual',
  proofId: 'agent-split-run-mode-proof:sha256:truncated-visual-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(truncatedVisualDir, 'before-hmr-first.png'),
    afterImage: path.join(truncatedVisualDir, 'after-hmr-first.png'),
    diffImage: path.join(truncatedVisualDir, 'before-after-diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:truncated-visual-hot1',
    editHash: hashValue('truncated-visual-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});

const blankBeforeVisualDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-blank-before-visual');
await writeRgbaPng(path.join(blankBeforeVisualDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(blankBeforeVisualDir, 'after-hmr-first.png'), 8, 8, (x, y) => [32 + x, 48 + y, 96, 255]);
await writeRgbaPng(path.join(blankBeforeVisualDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(blankBeforeVisualDir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:blank-before-visual-hot1', 'gpu-runtime-proof:sha256:blank-before-visual-hot1'),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'blank-before-visual',
    visualRoot: blankBeforeVisualDir,
  }),
  targetId: 'blank-before-visual',
  profileId: 'blank-before-visual',
  proofId: 'agent-split-run-mode-proof:sha256:blank-before-visual-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: path.join(blankBeforeVisualDir, 'before-hmr-first.png'),
    after: path.join(blankBeforeVisualDir, 'after-hmr-first.png'),
    diff: path.join(blankBeforeVisualDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:blank-before-visual-hot1',
    editHash: hashValue('blank-before-visual-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});

const noVisualOptOutDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-no-visual-optout');
await writeJson(path.join(noVisualOptOutDir, 'hot1.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation('gpu-ledger-proof:sha256:no-visual-optout-hot1', 'gpu-runtime-proof:sha256:no-visual-optout-hot1'),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'no-visual-optout',
    visualRoot: noVisualOptOutDir,
  }),
  backend: 'hip',
  targetId: 'no-visual-optout',
  profileId: 'no-visual-optout',
  proofId: 'agent-split-run-mode-proof:sha256:no-visual-optout-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualRequired: false,
  visual_required: false,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:no-visual-optout-hot1',
    editHash: hashValue('no-visual-optout-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});

const ledger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [logsRoot, artifactsRoot],
  generatedAt: '2026-06-09T00:00:00.000Z',
  includeUnproven: true,
});

assert.equal(ledger.schemaVersion, GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION);
assert.equal(ledger.query.accepted, true);
assert.ok(ledger.proofId.startsWith('gpu-validation-matrix-ledger:sha256:'));

const acceptedFlow = ledger.rows.find((row) =>
  row.targetId === 'flow'
    && row.matrixOutcome === 'full_runtime_gpu_hmr'
    && row.runMode?.metricScope === 'hot_delta_1'
);
assert.equal(acceptedFlow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedFlow.acceptedForGpuHmr, true);
assert.equal(acceptedFlow.visual.accepted, true);
assert.equal(acceptedFlow.visual.allImagesAreDecodedPng, true);
assert.equal(acceptedFlow.visual.decodedImageCount, 3);
assert.equal(acceptedFlow.visual.recomputedVisualPair.source, 'matrix_recomputed_png_pixels');
assert.equal(acceptedFlow.visual.recomputedVisualPair.recomputeEngine, 'matrix_async_visual_worker_rgba');
assert.equal(acceptedFlow.visual.recomputedVisualPair.accepted, true);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.proofAuthority,
  'async_visual_metrics_only',
);
assert.equal(acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.acceptedForGpuHmr, false);
assert.equal(acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.gpuHmrSuccess, false);
assert.match(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.asyncVisualMetricsHash ?? '',
  /^sha256:[a-f0-9]{64}$/,
);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.asyncVisualMetricsHash,
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.async_visual_metrics_hash,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics ?? {},
    'proofHash',
  ),
  false,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics ?? {},
    'durationMs',
  ),
  false,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker ?? {},
    'threadId',
  ),
  false,
);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.identitySchemaVersion,
  'synthi.gpu_hmr.visual_worker_identity.v1',
);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executorIdentity,
  'node_worker_threads_visual_proof_worker',
);
assert.match(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableHash ?? '',
  /^sha256:[a-f0-9]{64}$/,
);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableHash,
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executable_hash,
);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableHash,
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableManifestHash,
);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableManifestSchemaVersion,
  'synthi.gpu_hmr.visual_worker_executable_manifest.v1',
);
assert.equal(
  acceptedFlow.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableModuleCount,
  3,
);
assert.equal(acceptedFlow.runMode.accepted, true);
assert.equal(acceptedFlow.runMode.metricScope, 'hot_delta_1');
assert.equal(acceptedFlow.visual.changedPixelRatio, 0.042);
assert.ok(acceptedFlow.ledger.proofId.startsWith('gpu-ledger-proof:sha256:'));
assert.equal(acceptedFlow.ledger.source, 'recomputed_ledger');
assert.equal(acceptedFlow.runtimeProofArtifact.accepted, true);
assert.equal(acceptedFlow.generalityClaim.schemaVersion, 'synthi.gpu_hmr.generality_claim.v1');
assert.equal(acceptedFlow.generalityClaim.profileScopedOnly, true);
assert.equal(acceptedFlow.generalityClaim.broadLibraryAgnosticAccepted, false);
assert.equal(acceptedFlow.generalityClaim.arbitraryLibraryAccepted, false);
assert.equal(acceptedFlow.generalityClaim.arbitraryTargetRuntimeAccepted, false);
assert.ok(acceptedFlow.generalityClaim.unsupportedWithoutEvidence.length > 0);

const backendMutatedAcceptedRow = JSON.parse(JSON.stringify(acceptedFlow));
backendMutatedAcceptedRow.backend = 'vulkan';
const backendMutatedAcceptedQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [backendMutatedAcceptedRow],
});
assert.equal(backendMutatedAcceptedQuery.accepted, false);
assert.equal(backendMutatedAcceptedQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(backendMutatedAcceptedQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_row_backend_bound_to_ledger_record'
));

const targetMutatedAcceptedRow = JSON.parse(JSON.stringify(acceptedFlow));
targetMutatedAcceptedRow.targetId = 'forged-target-with-stale-row-id';
const targetMutatedAcceptedQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [targetMutatedAcceptedRow],
});
assert.equal(targetMutatedAcceptedQuery.accepted, false);
assert.equal(targetMutatedAcceptedQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(targetMutatedAcceptedQuery.failedGates.some((gate) =>
  gate.code === 'validation_matrix_row_id_mismatch'
));

const nativeAuthorityTrace = {
  loaderEvents: [{
    source: 'hipModuleLoadData',
    evidenceRefs: ['evidence:native-authority:loader'],
  }],
  dispatchEvents: [{
    command: 'hipModuleLaunchKernel',
    evidenceRefs: ['evidence:native-authority:dispatch'],
  }],
  outputEvents: [{
    kind: 'visual_frame',
    evidenceRefs: ['evidence:native-authority:output'],
  }],
};
const nativeAuthorityRow = withQueryRecomputedRowId(acceptedAuthoritativeMatrixRow('native-authority-no-strict-artifact', {
  proofMode: 'hip_module_runtime_readback',
  proofChain: 'backend_native_recomputed_ledger_trace',
  proofChainAccepted: true,
  runtimeProofArtifact: null,
  runtime_proof_artifact: null,
  runtimeTrace: nativeAuthorityTrace,
  runtime_trace: nativeAuthorityTrace,
  fullRuntimeEvidenceAuthority: null,
  full_runtime_evidence_authority: null,
}));
const nativeAuthorityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [nativeAuthorityRow],
});
assert.equal(nativeAuthorityQuery.accepted, false);
assert.equal(nativeAuthorityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(nativeAuthorityQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_strict_runtime_proof_artifact'
));
assert.ok(nativeAuthorityQuery.failedGates.some((gate) =>
  gate.code === 'full_runtime_authority_strict_runtime_proof_artifact_missing'
));

const nativeAuthorityMissingLoaderRow = withQueryRecomputedRowId(acceptedAuthoritativeMatrixRow('native-authority-missing-loader', {
  proofMode: 'hip_module_runtime_readback',
  proofChain: 'backend_native_recomputed_ledger_trace',
  proofChainAccepted: true,
  runtimeProofArtifact: null,
  runtime_proof_artifact: null,
  runtimeTrace: {
    dispatchEvents: nativeAuthorityTrace.dispatchEvents,
    outputEvents: nativeAuthorityTrace.outputEvents,
  },
  runtime_trace: {
    dispatchEvents: nativeAuthorityTrace.dispatchEvents,
    outputEvents: nativeAuthorityTrace.outputEvents,
  },
  fullRuntimeEvidenceAuthority: null,
  full_runtime_evidence_authority: null,
}));
const nativeAuthorityMissingLoaderQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [nativeAuthorityMissingLoaderRow],
});
assert.equal(nativeAuthorityMissingLoaderQuery.accepted, false);
assert.equal(nativeAuthorityMissingLoaderQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(nativeAuthorityMissingLoaderQuery.failedGates.some((gate) =>
  gate.code === 'full_runtime_authority_native_runtime_trace_missing'
));
assert.ok(nativeAuthorityMissingLoaderQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_strict_runtime_proof_artifact'
));

const strictArtifactMissingNativeAuthorityRow = withQueryRecomputedRowId((() => {
  const missingLoaderTrace = {
    dispatchEvents: nativeAuthorityTrace.dispatchEvents,
    outputEvents: nativeAuthorityTrace.outputEvents,
  };
  const row = acceptedAuthoritativeMatrixRow(
    'strict-artifact-missing-native-authority',
    {
      proofMode: 'strict_runtime_ledger',
      proofChain: 'embedded_runtime_proof_artifact_recomputed_ledger',
      proofChainAccepted: true,
      runtimeTrace: missingLoaderTrace,
      runtime_trace: missingLoaderTrace,
      fullRuntimeEvidenceAuthority: null,
      full_runtime_evidence_authority: null,
    },
  );
  const artifact = {
    ...(row.runtimeProofArtifact ?? row.runtime_proof_artifact ?? {}),
    runtimeTrace: missingLoaderTrace,
    runtime_trace: missingLoaderTrace,
    runtimeResourceTrace: {},
    runtime_resource_trace: {},
  };
  row.runtimeProofArtifact = artifact;
  row.runtime_proof_artifact = artifact;
  const record = row.ledger?.record ?? {};
  const originalLoader = record.loaderEvent ?? record.loader_event ?? {};
  const scrubbedLoader = {
    artifactHash: originalLoader.artifactHash ?? originalLoader.artifact_hash,
    artifact_hash: originalLoader.artifact_hash ?? originalLoader.artifactHash,
    evidenceRefs: ['evidence:strict-artifact-missing-native-authority:loader-without-boundary'],
    evidence_refs: ['evidence:strict-artifact-missing-native-authority:loader-without-boundary'],
  };
  record.loaderEvent = scrubbedLoader;
  record.loader_event = scrubbedLoader;
  row.ledger.record = record;
  return row;
})());
const strictArtifactMissingNativeAuthorityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [strictArtifactMissingNativeAuthorityRow],
});
assert.equal(strictArtifactMissingNativeAuthorityQuery.accepted, false);
assert.equal(strictArtifactMissingNativeAuthorityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(strictArtifactMissingNativeAuthorityQuery.failedGates.some((gate) =>
  gate.code === 'full_runtime_authority_native_runtime_trace_missing'
));
assert.equal(
  strictArtifactMissingNativeAuthorityQuery.failedGates.some((gate) =>
    gate.code === 'full_runtime_authority_strict_runtime_proof_artifact_missing'
  ),
  false,
);

const ledgerOnlyNativeAuthorityRow = withQueryRecomputedRowId((() => {
  const row = acceptedAuthoritativeMatrixRow('strict-artifact-ledger-only-native-authority', {
    proofMode: 'strict_runtime_ledger',
    proofChain: 'embedded_runtime_proof_artifact_recomputed_ledger',
    proofChainAccepted: true,
    fullRuntimeEvidenceAuthority: null,
    full_runtime_evidence_authority: null,
  });
  delete row.runtimeTrace;
  delete row.runtime_trace;
  delete row.runtimeResourceTrace;
  delete row.runtime_resource_trace;
  delete row.nativeHipApiEvidence;
  delete row.native_hip_api_evidence;
  delete row.nativeOpenClApiEvidence;
  delete row.native_opencl_api_evidence;
  delete row.nativeVulkanApiEvidence;
  delete row.native_vulkan_api_evidence;
  delete row.nativeWebGpuApiEvidence;
  delete row.native_webgpu_api_evidence;
  const artifact = { ...(row.runtimeProofArtifact ?? row.runtime_proof_artifact ?? {}) };
  delete artifact.runtimeTrace;
  delete artifact.runtime_trace;
  delete artifact.runtimeResourceTrace;
  delete artifact.runtime_resource_trace;
  delete artifact.nativeHipApiEvidence;
  delete artifact.native_hip_api_evidence;
  delete artifact.nativeOpenClApiEvidence;
  delete artifact.native_opencl_api_evidence;
  delete artifact.nativeVulkanApiEvidence;
  delete artifact.native_vulkan_api_evidence;
  delete artifact.nativeWebGpuApiEvidence;
  delete artifact.native_webgpu_api_evidence;
  row.runtimeProofArtifact = artifact;
  row.runtime_proof_artifact = artifact;
  return row;
})());
const ledgerOnlyNativeAuthorityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [ledgerOnlyNativeAuthorityRow],
});
assert.equal(ledgerOnlyNativeAuthorityQuery.accepted, false);
assert.equal(ledgerOnlyNativeAuthorityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(ledgerOnlyNativeAuthorityQuery.failedGates.some((gate) =>
  gate.code === 'full_runtime_authority_native_runtime_trace_missing'
));
assert.ok(ledgerOnlyNativeAuthorityQuery.failedGates.some((gate) =>
  gate.code === 'native_runtime_trace_cannot_be_ledger_only'
));

const observedOutputMismatchRow = withQueryRecomputedRowId((() => {
  const row = acceptedAuthoritativeMatrixRow('strict-artifact-runtime-output-mismatch', {
    proofMode: 'strict_runtime_ledger',
    proofChain: 'embedded_runtime_proof_artifact_recomputed_ledger',
    proofChainAccepted: true,
    fullRuntimeEvidenceAuthority: null,
    full_runtime_evidence_authority: null,
  });
  const trace = JSON.parse(JSON.stringify(
    row.runtimeTrace
    ?? row.runtime_trace
    ?? row.runtimeProofArtifact?.runtimeTrace
    ?? row.runtimeProofArtifact?.runtime_trace
    ?? row.runtime_proof_artifact?.runtimeTrace
    ?? row.runtime_proof_artifact?.runtime_trace,
  ));
  trace.outputEvents[0].afterDispatchId = 'dispatch:forged-observed-output';
  trace.outputEvents[0].after_dispatch_id = 'dispatch:forged-observed-output';
  trace.output_events[0].afterDispatchId = 'dispatch:forged-observed-output';
  trace.output_events[0].after_dispatch_id = 'dispatch:forged-observed-output';
  row.runtimeTrace = trace;
  row.runtime_trace = trace;
  row.runtimeProofArtifact.runtimeTrace = trace;
  row.runtimeProofArtifact.runtime_trace = trace;
  row.runtime_proof_artifact = row.runtimeProofArtifact;
  return row;
})());
const observedOutputMismatchQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [observedOutputMismatchRow],
});
assert.equal(observedOutputMismatchQuery.accepted, false);
assert.equal(observedOutputMismatchQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(observedOutputMismatchQuery.failedGates.some((gate) =>
  gate.code === 'native_runtime_trace_ledger_output_mismatch'
));

const strictMissingArtifact = ledger.rows.find((row) => row.targetId === 'strict-runtime-missing-artifact');
assert.equal(strictMissingArtifact?.proofMode, 'strict_runtime_ledger');
assert.equal(strictMissingArtifact.matrixOutcome, 'unproven');
assert.equal(strictMissingArtifact.acceptedForGpuHmr, false);
assert.equal(strictMissingArtifact.gpuHmrSuccess, false);
assert.equal(strictMissingArtifact.ledger.gpuHmrSuccess, true);
assert.equal(strictMissingArtifact.runtimeProofArtifact.present, false);
assert.equal(strictMissingArtifact.runtimeProofArtifact.accepted, false);
assert.ok(strictMissingArtifact.reasons.includes('runtime_proof_artifact_not_strictly_accepted'));
assert.ok(strictMissingArtifact.openGaps.includes('runtime_proof_artifact_missing'));

const strictComputeMissingReadback = ledger.rows.find((row) =>
  row.targetId === 'strict-runtime-compute-missing-readback'
);
assert.equal(strictComputeMissingReadback?.proofMode, 'strict_runtime_ledger');
assert.equal(strictComputeMissingReadback.matrixOutcome, 'unproven');
assert.equal(strictComputeMissingReadback.acceptedForGpuHmr, false);
assert.equal(strictComputeMissingReadback.gpuHmrSuccess, false);
assert.equal(strictComputeMissingReadback.ledger.gpuHmrSuccess, true);
assert.equal(strictComputeMissingReadback.runtimeProofArtifact.accepted, true);
assert.equal(strictComputeMissingReadback.outputOracleFacet.kind, 'compute_oracle');
assert.equal(strictComputeMissingReadback.outputOracleFacet.accepted, false);
assert.equal(strictComputeMissingReadback.outputOracleFacet.compute.present, true);
assert.equal(strictComputeMissingReadback.outputOracleFacet.compute.rawReadbackHashVerified, false);
assert.ok(strictComputeMissingReadback.outputOracleFacet.compute.rawReadbackReadError);
assert.ok(strictComputeMissingReadback.reasons.includes('compute_oracle_files_not_accepted'));
assert.ok(strictComputeMissingReadback.reasons.includes('compute_oracle_raw_readback_hash_unverified'));
assert.ok(strictComputeMissingReadback.openGaps.includes('compute_oracle_raw_readback_unreadable'));

const forgedGenericOpencl = ledger.rows.find((row) =>
  row.targetId === 'forged-generic-opencl-label'
);
assert.equal(forgedGenericOpencl?.proofMode, 'strict_runtime_ledger');
assert.equal(forgedGenericOpencl.backend, 'opencl');
assert.equal(forgedGenericOpencl.matrixOutcome, 'unproven');
assert.equal(forgedGenericOpencl.acceptedForGpuHmr, false);
assert.equal(forgedGenericOpencl.gpuHmrSuccess, false);
assert.equal(forgedGenericOpencl.outputOracleFacet.accepted, true);
assert.equal(forgedGenericOpencl.acceptanceScope, 'declared_profile_scoped');
assert.equal(forgedGenericOpencl.claimScope, 'unknown_scope');
assert.equal(forgedGenericOpencl.safety.accepted, true);
assert.ok(forgedGenericOpencl.reasons.includes('gpu_hmr_success_requires_known_acceptance_scope'));
assert.ok(forgedGenericOpencl.openGaps.includes('gpu_hmr_success_requires_known_acceptance_scope'));

function acceptedMatrixRowMissingFirewall(targetId, firewallFields = {}) {
  const artifactBeforeHash = hashValue(`accepted-row:${targetId}:artifact-before`);
  const artifactAfterHash = hashValue(`accepted-row:${targetId}:artifact-after`);
  const ledgerProofId = `gpu-ledger-proof:sha256:${sha256Hex(`accepted-row:${targetId}:ledger`)}`;
  const runtimeProofId = `gpu-runtime-proof:sha256:${sha256Hex(`accepted-row:${targetId}:runtime`)}`;
  const editHash = hashValue(`accepted-row:${targetId}:edit`);
  return {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    rowId: `gpu-validation-matrix-row:sha256:${sha256Hex(`missing-firewall:${targetId}`)}`,
    backend: 'hip',
    targetId,
    proofMode: 'strict_runtime_ledger',
    matrixOutcome: 'full_runtime_gpu_hmr',
    acceptedForGpuHmr: true,
    gpuHmrSuccess: true,
    proofChainAccepted: true,
    acceptanceScope: 'rocm_hip_declared_runtime_profile',
    claimScope: 'scoped_profile',
    proofIds: [ledgerProofId, runtimeProofId],
    ledger: {
      present: true,
      source: 'recomputed_ledger',
      proofId: ledgerProofId,
      gpuHmrSuccess: true,
      failedInvariants: [],
      record: {
        proofId: ledgerProofId,
        proof_id: ledgerProofId,
        artifact_before_hash: artifactBeforeHash,
        artifact_after_hash: artifactAfterHash,
        loader_event: {
          artifact_hash: artifactAfterHash,
        },
        epoch_publish_event: {
          artifact_hash: artifactAfterHash,
        },
        dispatch_event: {
          artifact_hash: artifactAfterHash,
        },
        output_event: {
          artifact_hash: artifactAfterHash,
        },
      },
    },
    runtimeProofArtifact: {
      present: true,
      proofId: runtimeProofId,
      accepted: true,
      failedGates: [],
    },
    runMode: {
      editHash,
      edit_hash: editHash,
    },
    visual: {
      required: false,
      accepted: true,
    },
    ...firewallFields,
  };
}

function acceptedAuthoritativeMatrixRow(targetId, fields = {}) {
  const row = JSON.parse(JSON.stringify(acceptedFlow));
  const effectiveProfileId = fields.profileId ?? fields.profile_id ?? targetId;
  const validationProfileEvidence = {
    ...(row.validationProfileEvidence ?? {}),
    profileId: effectiveProfileId,
    profile_id: effectiveProfileId,
    evidenceRefs: [
      ...new Set([
        ...((row.validationProfileEvidence?.evidenceRefs ?? row.validationProfileEvidence?.evidence_refs) ?? []),
        targetId,
      ]),
    ],
  };
  validationProfileEvidence.evidence_refs = validationProfileEvidence.evidenceRefs;
  const out = {
    ...row,
    targetId,
    target_id: targetId,
    profileId: effectiveProfileId,
    profile_id: effectiveProfileId,
    sourceFirstIngestion: sourceFirstIngestionEvidenceFor({ targetId }),
    source_first_ingestion: sourceFirstIngestionEvidenceFor({ targetId }),
    validationProfileEvidence,
    validation_profile_evidence: validationProfileEvidence,
    ...fields,
  };
  out.source_first_ingestion = out.sourceFirstIngestion ?? out.source_first_ingestion;
  out.validation_profile_evidence = out.validationProfileEvidence ?? out.validation_profile_evidence;
  delete out.matrixKey;
  delete out.attemptKey;
  delete out.row_id;
  const rowIdSeed = { ...out };
  delete rowIdSeed.rowId;
  delete rowIdSeed.row_id;
  delete rowIdSeed.matrixKey;
  delete rowIdSeed.matrix_key;
  delete rowIdSeed.attemptKey;
  delete rowIdSeed.attempt_key;
  out.rowId = `gpu-validation-matrix-row:sha256:${sha256Hex(stableJson(rowIdSeed))}`;
  return out;
}

function scopedGeneralityClaim(acceptanceScope) {
  return {
    schemaVersion: 'synthi.gpu_hmr.generality_claim.v1',
    authority: 'matrix_computed_from_acceptance_scope',
    acceptanceScope,
    acceptance_scope: acceptanceScope,
    claimScope: 'scoped_profile',
    claim_scope: 'scoped_profile',
    profileScopedOnly: true,
    profile_scoped_only: true,
    broadLibraryAgnosticAccepted: false,
    broad_library_agnostic_accepted: false,
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
    unsupportedWithoutEvidence: [
      'arbitrary_library_hmr_not_proven',
      'arbitrary_target_runtime_not_proven',
    ],
    unsupported_without_evidence: [
      'arbitrary_library_hmr_not_proven',
      'arbitrary_target_runtime_not_proven',
    ],
    openGaps: ['broad_library_agnostic_proof_not_present'],
    open_gaps: ['broad_library_agnostic_proof_not_present'],
    failedGates: [],
    failed_gates: [],
  };
}

function acceptedBroadReadinessCandidate({
  targetId,
  backend,
  acceptanceScope,
  proofMode = 'strict_runtime_ledger',
  oracle = 'compute',
  sourceFirstSourceAuthority = 'direct_source_url_commit',
  updatedAt = '2026-06-30T21:00:00.000Z',
}) {
  const row = acceptedAuthoritativeMatrixRow(targetId, {
    backend,
    proofMode,
    proof_mode: proofMode,
    acceptanceScope,
    acceptance_scope: acceptanceScope,
    claimScope: 'scoped_profile',
    claim_scope: 'scoped_profile',
    generalityClaim: scopedGeneralityClaim(acceptanceScope),
    generality_claim: scopedGeneralityClaim(acceptanceScope),
  });
  row.acceptanceContract = {
    ...(row.acceptanceContract ?? row.acceptance_contract ?? {}),
    projectId: targetId,
    project_id: targetId,
  };
  row.acceptance_contract = row.acceptanceContract;
  row.ledger.record.projectId = targetId;
  row.ledger.record.project_id = targetId;
  row.ledger.record.editId = `edit:${targetId}`;
  row.ledger.record.edit_id = `edit:${targetId}`;
  row.ledger.record.backend = backend;
  row.ledger.record.proofId = null;
  row.ledger.record.proof_id = null;
  const recomputedLedger = queryGpuHmrLedgerInvariants(row.ledger.record, {
    ignoreSuppliedLedgerQueryAndSuccess: true,
  });
  const recomputedLedgerProofId = recomputedLedger.record.proofId;
  row.ledger.record.proofId = recomputedLedgerProofId;
  row.ledger.record.proof_id = recomputedLedgerProofId;
  row.ledger.proofId = recomputedLedgerProofId;
  row.ledger.proof_id = recomputedLedgerProofId;
  row.proofIds = [
    recomputedLedgerProofId,
    ...[...new Set((Array.isArray(row.proofIds ?? row.proof_ids) ? (row.proofIds ?? row.proof_ids) : []))]
      .filter((proofId) => !proofId.startsWith('gpu-ledger-proof:sha256:')),
  ];
  row.proof_ids = row.proofIds;
  row.sourceFirstIngestion = sourceFirstIngestionEvidenceFor({
    targetId,
    sourceAuthority: sourceFirstSourceAuthority,
  });
  row.source_first_ingestion = row.sourceFirstIngestion;
  if (oracle === 'visual') {
    row.visual = {
      ...(row.visual ?? {}),
      required: true,
      accepted: true,
    };
    row.outputOracleFacet = {
      ...(row.outputOracleFacet ?? {}),
      kind: 'visual_oracle',
      accepted: true,
    };
    row.output_oracle_facet = row.outputOracleFacet;
  } else {
    row.visual = {
      ...(row.visual ?? {}),
      required: false,
      accepted: true,
    };
    row.outputOracleFacet = {
      ...(row.outputOracleFacet ?? {}),
      kind: 'compute_oracle',
      accepted: true,
    };
    row.output_oracle_facet = row.outputOracleFacet;
  }
  row.updatedAt = updatedAt;
  row.updated_at = updatedAt;
  return withQueryRecomputedRowId(row);
}

function withUpdatedAt(row, updatedAt) {
  const cloned = JSON.parse(JSON.stringify(row));
  cloned.updatedAt = updatedAt;
  cloned.updated_at = updatedAt;
  return withQueryRecomputedRowId(cloned);
}

function withArtifactPath(row, artifactPath) {
  const cloned = JSON.parse(JSON.stringify(row));
  cloned.artifactPath = artifactPath;
  cloned.artifact_path = artifactPath;
  return withQueryRecomputedRowId(cloned);
}

function withSourceFirstSourceAuthority(row, sourceAuthority) {
  const cloned = JSON.parse(JSON.stringify(row));
  cloned.sourceFirstIngestion = sourceFirstIngestionEvidenceFor({
    targetId: cloned.targetId,
    sourceAuthority,
  });
  cloned.source_first_ingestion = cloned.sourceFirstIngestion;
  return withQueryRecomputedRowId(cloned);
}

function withSharedSourceFirstDirectIdentity(row, sourceUrl, immutableCommit) {
  const cloned = JSON.parse(JSON.stringify(row));
  cloned.sourceFirstIngestion = sourceFirstIngestionEvidenceFor({
    targetId: cloned.targetId,
    sourceAuthority: 'direct_source_url_commit',
    sourceUrl,
    immutableCommit,
  });
  cloned.source_first_ingestion = cloned.sourceFirstIngestion;
  return withQueryRecomputedRowId(cloned);
}

function withSourceFirstDirectLocalIdentity(row, repoPath, immutableCommit) {
  const cloned = JSON.parse(JSON.stringify(row));
  cloned.sourceFirstIngestion = sourceFirstIngestionEvidenceFor({
    targetId: cloned.targetId,
    sourceAuthority: 'direct_local_git_repo_path',
    repoPath,
    immutableCommit,
  });
  cloned.source_first_ingestion = cloned.sourceFirstIngestion;
  return withQueryRecomputedRowId(cloned);
}

function withoutSourceFirstDirectSourceIdentity(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  const sourceFirst = {
    ...(cloned.sourceFirstIngestion ?? cloned.source_first_ingestion ?? {}),
  };
  delete sourceFirst.directSourceInputEvidence;
  delete sourceFirst.direct_source_input_evidence;
  if (sourceFirst.initialCompileContract) {
    delete sourceFirst.initialCompileContract.directSourceInputEvidence;
    delete sourceFirst.initialCompileContract.direct_source_input_evidence;
  }
  if (sourceFirst.initial_compile_contract) {
    delete sourceFirst.initial_compile_contract.directSourceInputEvidence;
    delete sourceFirst.initial_compile_contract.direct_source_input_evidence;
  }
  cloned.sourceFirstIngestion = sourceFirst;
  cloned.source_first_ingestion = sourceFirst;
  return withQueryRecomputedRowId(cloned);
}

function withSourceFirstSchemaVersion(row, schemaVersion) {
  const cloned = JSON.parse(JSON.stringify(row));
  const sourceFirst = {
    ...(cloned.sourceFirstIngestion ?? cloned.source_first_ingestion ?? {}),
    schemaVersion,
    schema_version: schemaVersion,
  };
  cloned.sourceFirstIngestion = sourceFirst;
  cloned.source_first_ingestion = sourceFirst;
  return withQueryRecomputedRowId(cloned);
}

function withForgedSourceFirstProofId(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  const sourceFirst = {
    ...(cloned.sourceFirstIngestion ?? cloned.source_first_ingestion ?? {}),
    proofId: `agent-split-source-first-ingestion:sha256:${sha256Hex(
      `forged-source-first-proof:${cloned.targetId ?? cloned.target_id ?? 'unknown'}`,
    )}`,
  };
  sourceFirst.proof_id = sourceFirst.proofId;
  sourceFirst.accepted = true;
  cloned.sourceFirstIngestion = sourceFirst;
  cloned.source_first_ingestion = sourceFirst;
  return withQueryRecomputedRowId(cloned);
}

function withAsyncVisualSupportAuthorityClaim(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  const asyncVisual = {
    ...(cloned.asyncVisualCasBundle ?? cloned.async_visual_cas_bundle ?? {}),
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
  };
  cloned.asyncVisualCasBundle = asyncVisual;
  cloned.async_visual_cas_bundle = asyncVisual;
  return withQueryRecomputedRowId(cloned);
}

function withSerializedOnlyAsyncVisualSupport(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  delete cloned.visualArtifacts;
  delete cloned.visual_artifacts;
  delete cloned.asyncVisualProofJob;
  delete cloned.async_visual_proof_job;
  return withQueryRecomputedRowId(cloned);
}

function withForgedComputeCardOnlyFlag(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  cloned.computeCardOnlyProofAccepted = true;
  cloned.compute_card_only_proof_accepted = true;
  delete cloned.computeCardEvidence;
  delete cloned.compute_card_evidence;
  return withQueryRecomputedRowId(cloned);
}

function withComputeCardOnlyButNoOutputOracleFacet(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  delete cloned.outputOracleFacet;
  delete cloned.output_oracle_facet;
  cloned.computeCardOnlyProofAccepted = true;
  cloned.compute_card_only_proof_accepted = true;
  cloned.computeCardEvidence = {
    accepted: true,
    proofAuthority: 'compute_card_render_only_not_output_oracle',
    proof_authority: 'compute_card_render_only_not_output_oracle',
  };
  cloned.compute_card_evidence = cloned.computeCardEvidence;
  cloned.visual = {
    ...(cloned.visual ?? {}),
    present: true,
    accepted: true,
    evidenceKind: 'compute_card_not_runtime_visual_oracle',
    evidence_kind: 'compute_card_not_runtime_visual_oracle',
  };
  return withQueryRecomputedRowId(cloned);
}

function withoutOutputOracleFacet(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  delete cloned.outputOracleFacet;
  delete cloned.output_oracle_facet;
  return withQueryRecomputedRowId(cloned);
}

function withoutSourceFirstVisualSupport(row) {
  const cloned = JSON.parse(JSON.stringify(row));
  delete cloned.sourceFirstIngestion;
  delete cloned.source_first_ingestion;
  if (cloned.asyncVisualCasBundle) {
    cloned.asyncVisualCasBundle = {
      ...cloned.asyncVisualCasBundle,
      accepted: false,
      failedGates: [
        ...new Set([
          ...(
            cloned.asyncVisualCasBundle.failedGates
            ?? cloned.asyncVisualCasBundle.failed_gates
            ?? []
          ),
          'source_first_visual_support_removed_for_broad_readiness_fixture',
        ]),
      ],
    };
    cloned.asyncVisualCasBundle.failed_gates = cloned.asyncVisualCasBundle.failedGates;
    cloned.async_visual_cas_bundle = cloned.asyncVisualCasBundle;
  }
  return withQueryRecomputedRowId(cloned);
}

function refusalMatrixRow(targetId, backend = 'hip') {
  return withQueryRecomputedRowId({
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    rowId: `gpu-validation-matrix-row:sha256:${sha256Hex(`refusal:${targetId}`)}`,
    backend,
    targetId,
    target_id: targetId,
    profileId: targetId,
    profile_id: targetId,
    proofMode: 'adversarial_refusal_fixture',
    proof_mode: 'adversarial_refusal_fixture',
    matrixOutcome: 'refusal_proven',
    matrix_outcome: 'refusal_proven',
    acceptanceClass: 'refusal_proven',
    acceptance_class: 'refusal_proven',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    refusalProven: true,
    refusal_proven: true,
    proofChainAccepted: true,
    proof_chain_accepted: true,
    proofChain: 'adversarial_refusal_fixture',
    proof_chain: 'adversarial_refusal_fixture',
    updatedAt: '2026-06-30T21:00:00.000Z',
    updated_at: '2026-06-30T21:00:00.000Z',
    reasons: ['adversarial_refusal_fixture'],
    openGaps: [],
    open_gaps: [],
  });
}

function randomColdReadinessMatrixRow({
  targetId = 'random-cold-readiness-user-project',
  profileMode = 'unprofiled_arbitrary_project_cold_intake',
  candidateSource = 'direct_source_url_commit',
  resultStatus = 'unprofiled_arbitrary_project_cold_intake_refused',
  sourceUrl = 'https://example.invalid/user/project.git',
  localRepoPath = null,
  immutableCommit = '22c6cb18d4b73254b0d62511e6a9d68e06dea70f',
  fileCount = 1500,
  totalKnownBytes = 15 * 1024 * 1024,
  sourceRelevantFileCount = fileCount,
  inputMode = 'cli_or_env_direct_source',
  directInputEvidence = true,
  directInputEvidenceInputChannels = null,
  buildMetadataDiscoveryAccepted = true,
  buildMetadataContentAccepted = true,
  buildMetadataContentEvidence = undefined,
  buildMetadataContentHash = null,
  sourceListingHash = null,
  sourceIntakeFacetHash = null,
  eventType = 'cold_path_complete',
  dryRun = false,
  actualAttempt = eventType === 'cold_path_complete' && dryRun !== true,
  updatedAt = '2026-06-30T21:00:00.000Z',
  artifactPath = `random-cold-readiness/${targetId}.json`,
} = {}) {
  const sourceContentSeed = {
    sourceUrl: sourceUrl ?? null,
    localRepoPath: localRepoPath ?? null,
    immutableCommit: String(immutableCommit ?? '').trim().toLowerCase(),
  };
  sourceListingHash ??= contentHashFor({
    schemaVersion: 'synthi.gpu_hmr.random_cold_path_source_listing_identity.v1',
    ...sourceContentSeed,
  });
  sourceIntakeFacetHash ??= contentHashFor({
    schemaVersion: 'synthi.gpu_hmr.random_cold_path_source_intake_identity.v1',
    ...sourceContentSeed,
  });
  const sourceContentEvidenceId = contentHashFor({
    schemaVersion: 'synthi.gpu_hmr.random_cold_path_build_metadata_content_identity.v1',
    ...sourceContentSeed,
  });
  if (buildMetadataContentEvidence === undefined) {
    buildMetadataContentEvidence = buildMetadataContentAccepted
      ? randomColdBuildMetadataContentEvidenceFixture({
        targetId: sourceContentEvidenceId,
        accepted: true,
      })
      : null;
  }
  buildMetadataContentHash ??= buildMetadataContentEvidence?.contentEvidenceHash ?? null;
  const sizeSignals = inputMode
    ? {
      inputMode,
      input_mode: inputMode,
      coldPathKind: candidateSource === 'direct_local_git_repo_path'
        ? 'direct_local_git_repo_cold_intake'
        : 'direct_source_url_commit_cold_intake',
      cold_path_kind: candidateSource === 'direct_local_git_repo_path'
        ? 'direct_local_git_repo_cold_intake'
        : 'direct_source_url_commit_cold_intake',
    }
    : {};
  const directInputEvidenceFacet = directInputEvidence
    && inputMode
    && (candidateSource === 'direct_source_url_commit'
      || candidateSource === 'direct_local_git_repo_path')
    ? directInputEvidence === true
      ? randomColdDirectInputEvidenceFixture({
        candidateSource,
        sourceUrl,
        repoPath: localRepoPath,
        immutableCommit,
        inputChannels: directInputEvidenceInputChannels,
      })
      : directInputEvidence
    : null;
  const directInputEvidenceFields = directInputEvidenceFacet
    ? {
      directInputEvidence: directInputEvidenceFacet,
      direct_input_evidence: directInputEvidenceFacet,
    }
    : {};
  return withQueryRecomputedRowId({
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    rowId: `gpu-validation-matrix-row:sha256:${sha256Hex(`random-cold:${targetId}`)}`,
    backend: 'webgpu',
    targetId,
    target_id: targetId,
    artifactPath,
    artifact_path: artifactPath,
    updatedAt,
    updated_at: updatedAt,
    profileId: profileMode,
    profile_id: profileMode,
    profileMode,
    profile_mode: profileMode,
    proofMode: 'random_large_project_cold_path',
    proof_mode: 'random_large_project_cold_path',
    eventType,
    event_type: eventType,
    dryRun,
    dry_run: dryRun,
    actualAttempt,
    actual_attempt: actualAttempt,
    matrixOutcome: 'refusal_proven',
    matrix_outcome: 'refusal_proven',
    acceptanceClass: 'runtime_proof_rejected',
    acceptance_class: 'runtime_proof_rejected',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    refusalProven: true,
    refusal_proven: true,
    proofChainAccepted: false,
    proof_chain_accepted: false,
    proofChain: 'random_large_project_cold_path_refusal_only',
    proof_chain: 'random_large_project_cold_path_refusal_only',
    randomLargeProjectColdPath: {
      present: true,
      proofAuthority: 'random_large_project_cold_path_selection_only_not_gpu_hmr_success',
      proof_authority: 'random_large_project_cold_path_selection_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      profileMode,
      profile_mode: profileMode,
      candidateSource,
      candidate_source: candidateSource,
      eventType,
      event_type: eventType,
      dryRun,
      dry_run: dryRun,
      actualAttempt,
      actual_attempt: actualAttempt,
      ...directInputEvidenceFields,
      candidateId: targetId,
      candidate_id: targetId,
      sourceUrl,
      source_url: sourceUrl,
      ...(localRepoPath
        ? {
          localRepoPath,
          local_repo_path: localRepoPath,
        }
        : {}),
      immutableCommit,
      immutable_commit: immutableCommit,
      fileCount,
      file_count: fileCount,
      totalKnownBytes,
      total_known_bytes: totalKnownBytes,
      sourceRelevantFileCount,
      source_relevant_file_count: sourceRelevantFileCount,
      sizeSignals,
      size_signals: sizeSignals,
      resultStatus,
      result_status: resultStatus,
      failedGates: [],
      failed_gates: [],
    },
    random_large_project_cold_path: {
      present: true,
      proofAuthority: 'random_large_project_cold_path_selection_only_not_gpu_hmr_success',
      proof_authority: 'random_large_project_cold_path_selection_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      profileMode,
      profile_mode: profileMode,
      candidateSource,
      candidate_source: candidateSource,
      eventType,
      event_type: eventType,
      dryRun,
      dry_run: dryRun,
      actualAttempt,
      actual_attempt: actualAttempt,
      ...directInputEvidenceFields,
      candidateId: targetId,
      candidate_id: targetId,
      sourceUrl,
      source_url: sourceUrl,
      ...(localRepoPath
        ? {
          localRepoPath,
          local_repo_path: localRepoPath,
        }
        : {}),
      immutableCommit,
      immutable_commit: immutableCommit,
      fileCount,
      file_count: fileCount,
      totalKnownBytes,
      total_known_bytes: totalKnownBytes,
      sourceRelevantFileCount,
      source_relevant_file_count: sourceRelevantFileCount,
      sizeSignals,
      size_signals: sizeSignals,
      resultStatus,
      result_status: resultStatus,
      failedGates: [],
      failed_gates: [],
    },
    coldSourceTreeIntake: {
      present: true,
      schemaVersion: 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1',
      schema_version: 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1',
      proofAuthority: 'unprofiled_source_tree_intake_only_not_gpu_hmr_success',
      proof_authority: 'unprofiled_source_tree_intake_only_not_gpu_hmr_success',
      accepted: true,
      acceptedAsIntakeEvidence: true,
      accepted_as_intake_evidence: true,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      canSatisfyDispatchProof: false,
      can_satisfy_dispatch_proof: false,
      buildMetadataDiscoveryAccepted,
      build_metadata_discovery_accepted: buildMetadataDiscoveryAccepted,
      buildMetadataContentAccepted,
      build_metadata_content_accepted: buildMetadataContentAccepted,
      buildMetadataContentHash,
      build_metadata_content_hash: buildMetadataContentHash,
      buildMetadataContentEvidence,
      build_metadata_content_evidence: buildMetadataContentEvidence,
      backendCandidates: ['vulkan', 'webgpu_wgsl'],
      backend_candidates: ['vulkan', 'webgpu_wgsl'],
      detectedBuildSystems: ['cargo', 'npm_or_node'],
      detected_build_systems: ['cargo', 'npm_or_node'],
      sourceListingHash,
      source_listing_hash: sourceListingHash,
      facetHash: sourceIntakeFacetHash,
      facet_hash: sourceIntakeFacetHash,
      fileCount,
      file_count: fileCount,
      totalKnownBytes,
      total_known_bytes: totalKnownBytes,
      sourceRelevantFileCount,
      source_relevant_file_count: sourceRelevantFileCount,
      failedGates: [],
      failed_gates: [],
    },
    cold_source_tree_intake: {
      present: true,
      schemaVersion: 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1',
      schema_version: 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1',
      proofAuthority: 'unprofiled_source_tree_intake_only_not_gpu_hmr_success',
      proof_authority: 'unprofiled_source_tree_intake_only_not_gpu_hmr_success',
      accepted: true,
      acceptedAsIntakeEvidence: true,
      accepted_as_intake_evidence: true,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      canSatisfyDispatchProof: false,
      can_satisfy_dispatch_proof: false,
      buildMetadataDiscoveryAccepted,
      build_metadata_discovery_accepted: buildMetadataDiscoveryAccepted,
      buildMetadataContentAccepted,
      build_metadata_content_accepted: buildMetadataContentAccepted,
      buildMetadataContentHash,
      build_metadata_content_hash: buildMetadataContentHash,
      buildMetadataContentEvidence,
      build_metadata_content_evidence: buildMetadataContentEvidence,
      backendCandidates: ['vulkan', 'webgpu_wgsl'],
      backend_candidates: ['vulkan', 'webgpu_wgsl'],
      detectedBuildSystems: ['cargo', 'npm_or_node'],
      detected_build_systems: ['cargo', 'npm_or_node'],
      sourceListingHash,
      source_listing_hash: sourceListingHash,
      facetHash: sourceIntakeFacetHash,
      facet_hash: sourceIntakeFacetHash,
      fileCount,
      file_count: fileCount,
      totalKnownBytes,
      total_known_bytes: totalKnownBytes,
      sourceRelevantFileCount,
      source_relevant_file_count: sourceRelevantFileCount,
      failedGates: [],
      failed_gates: [],
    },
    coldRuntimeBoundaryEventManifestTemplate: {
      present: true,
      validated: true,
      acceptedAsSupportEvidence: true,
      accepted_as_support_evidence: true,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      failedGates: [],
      failed_gates: [],
    },
    cold_runtime_boundary_event_manifest_template: {
      present: true,
      validated: true,
      acceptedAsSupportEvidence: true,
      accepted_as_support_evidence: true,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      failedGates: [],
      failed_gates: [],
    },
    sourceTreeIntakeAccepted: true,
    source_tree_intake_accepted: true,
    sourceTreeFileCount: fileCount,
    source_tree_file_count: fileCount,
    sourceTreeTotalKnownBytes: totalKnownBytes,
    source_tree_total_known_bytes: totalKnownBytes,
    sourceRelevantFileCount,
    source_relevant_file_count: sourceRelevantFileCount,
    buildMetadataDiscoveryAccepted,
    build_metadata_discovery_accepted: buildMetadataDiscoveryAccepted,
    buildMetadataContentAccepted,
    build_metadata_content_accepted: buildMetadataContentAccepted,
    buildMetadataContentHash,
    build_metadata_content_hash: buildMetadataContentHash,
    buildMetadataContentEvidence,
    build_metadata_content_evidence: buildMetadataContentEvidence,
    runtimeBoundaryEventManifestTemplateAccepted: true,
    runtime_boundary_event_manifest_template_accepted: true,
    randomColdPathDirectInputEvidence:
      directInputEvidenceFacet ?? { present: false, accepted: false, failedGates: [] },
    random_cold_path_direct_input_evidence:
      directInputEvidenceFacet ?? { present: false, accepted: false, failed_gates: [] },
    sourceUrl,
    source_url: sourceUrl,
    ...(localRepoPath
      ? {
        localRepoPath,
        local_repo_path: localRepoPath,
      }
      : {}),
    immutableCommit,
    immutable_commit: immutableCommit,
    reasons: ['strict_runtime_ledger_missing'],
    openGaps: ['strict_runtime_ledger_missing'],
    open_gaps: ['strict_runtime_ledger_missing'],
  });
}

function withQueryRecomputedRowId(row) {
  const probe = {
    ...JSON.parse(JSON.stringify(row)),
    rowId: 'gpu-validation-matrix-row:sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  const query = queryGpuHmrValidationMatrixLedger({
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    rows: [probe],
  });
  const mismatch = query.failedGates.find((gate) => gate.code === 'validation_matrix_row_id_mismatch');
  assert.ok(mismatch?.recomputedRowId, 'expected query to expose recomputed row id for probe row');
  return {
    ...row,
    rowId: mismatch.recomputedRowId,
  };
}

function mutateAcceptedLedgerRecord(row, mutate) {
  const cloned = JSON.parse(JSON.stringify(row));
  mutate(cloned.ledger.record, cloned);
  return cloned;
}

const missingStrictRuntimeArtifactQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-strict-runtime-artifact', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
      runtimeProofArtifact: {
        present: false,
        accepted: false,
        failedGates: [{ code: 'runtime_proof_artifact_missing' }],
      },
    }),
  ],
});
assert.equal(missingStrictRuntimeArtifactQuery.accepted, false);
assert.equal(missingStrictRuntimeArtifactQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingStrictRuntimeArtifactQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_strict_runtime_proof_artifact'
));

const missingGeneralityClaimRow = acceptedAuthoritativeMatrixRow('accepted-missing-generality-claim');
delete missingGeneralityClaimRow.generalityClaim;
delete missingGeneralityClaimRow.generality_claim;
const missingGeneralityClaimQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [missingGeneralityClaimRow],
});
assert.equal(missingGeneralityClaimQuery.accepted, false);
assert.equal(missingGeneralityClaimQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingGeneralityClaimQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_generality_claim_facet'
));

const forgedGeneralityClaimQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-forged-generality-claim', {
      generalityClaim: {
        ...acceptedFlow.generalityClaim,
        arbitraryLibraryAccepted: true,
        arbitrary_library_accepted: true,
      },
      generality_claim: {
        ...acceptedFlow.generalityClaim,
        arbitraryLibraryAccepted: true,
        arbitrary_library_accepted: true,
      },
    }),
  ],
});
assert.equal(forgedGeneralityClaimQuery.accepted, false);
assert.equal(forgedGeneralityClaimQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedGeneralityClaimQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_generality_claim_arbitrary_library_mismatch'
));

const missingFirewallQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-cpu-firewall', {
      fullRebuildUsed: false,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-missing-full-rebuild-firewall', {
      cpuHmrUsed: false,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-missing-process-restart-firewall', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-null-cpu-firewall', {
      cpuHmrUsed: null,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-null-full-rebuild-firewall', {
      cpuHmrUsed: false,
      fullRebuildUsed: null,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-null-process-restart-firewall', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: null,
    }),
  ],
});
assert.equal(missingFirewallQuery.accepted, false);
for (const expectedGate of [
  'gpu_hmr_success_requires_cpu_hmr_false',
  'gpu_hmr_success_requires_full_rebuild_false',
  'gpu_hmr_success_requires_process_restart_false',
]) {
  assert.ok(
    missingFirewallQuery.failedGates.some((gate) => gate.code === expectedGate),
    `expected validation matrix safety gate ${expectedGate}`,
  );
}
const missingLedgerAuthorityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-ledger-authority', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
      ledger: {
        present: true,
        source: 'recomputed_ledger',
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
    }),
  ],
});
assert.equal(missingLedgerAuthorityQuery.accepted, false);
assert.equal(missingLedgerAuthorityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
for (const expectedGate of [
  'gpu_hmr_success_requires_ledger_proof_id',
  'gpu_hmr_success_requires_proof_ledger_record',
  'gpu_hmr_success_requires_ledger_record_proof_id',
  'gpu_hmr_success_requires_complete_ledger_record',
]) {
  assert.ok(
    missingLedgerAuthorityQuery.failedGates.some((gate) => gate.code === expectedGate),
    `expected validation matrix ledger authority gate ${expectedGate}`,
  );
}
const missingLedgerProofRefQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-ledger-proof-id-not-referenced', {
      proofIds: [],
    }),
  ],
});
assert.equal(missingLedgerProofRefQuery.accepted, false);
assert.equal(missingLedgerProofRefQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingLedgerProofRefQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_ledger_proof_id_in_row_proof_ids'
));
const forgedRecordCpuFallbackQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    mutateAcceptedLedgerRecord(
      acceptedAuthoritativeMatrixRow('accepted-ledger-record-cpu-fallback'),
      (record) => {
        record.cpuHmrUsed = true;
      },
    ),
  ],
});
assert.equal(forgedRecordCpuFallbackQuery.accepted, false);
assert.equal(forgedRecordCpuFallbackQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedRecordCpuFallbackQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_recomputed_ledger_record_success'
));
assert.ok(forgedRecordCpuFallbackQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_zero_recomputed_ledger_record_invariants'
  && gate.invariantCodes?.includes('cpu_hmr_used')
));
const acceptedRowSuccessFlagMismatchQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-row-success-flag-false', {
      gpuHmrSuccess: false,
    }),
  ],
});
assert.equal(acceptedRowSuccessFlagMismatchQuery.accepted, false);
assert.ok(acceptedRowSuccessFlagMismatchQuery.failedGates.some((gate) =>
  gate.code === 'accepted_gpu_hmr_row_requires_gpu_hmr_success_true'
));
const acceptedRowRefusalMismatchQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-row-refusal-proven', {
      refusalProven: true,
    }),
  ],
});
assert.equal(acceptedRowRefusalMismatchQuery.accepted, false);
assert.ok(acceptedRowRefusalMismatchQuery.failedGates.some((gate) =>
  gate.code === 'accepted_gpu_hmr_row_cannot_be_refusal_proven'
));
const sourceAdaptedFirewallQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-source-adapted-row', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
      sourceAdaptedProfile: true,
      sourceAdaptation: {
        sourceAdaptedProfile: true,
        sourceAdaptations: ['test-only source rewrite disclosed by runtime probe'],
        failedGates: [{ code: 'source_adapted_profile_not_no_shim_gpu_hmr' }],
      },
    }),
  ],
});
assert.equal(sourceAdaptedFirewallQuery.accepted, false);
assert.equal(sourceAdaptedFirewallQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(sourceAdaptedFirewallQuery.failedGates.some((gate) =>
  gate.code === 'source_adapted_profile_not_no_shim_gpu_hmr'
));
const sourceDerivedOracleAdaptationQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-source-derived-oracle-adapted-row', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
      output_oracle_adaptations: [
        {
          kind: 'source_derived_buffer_checksum',
          profileId: 'hip.generic.readback.v1',
          oracleId: 'oracle:generic',
        },
      ],
    }),
  ],
});
assert.equal(sourceDerivedOracleAdaptationQuery.accepted, false);
assert.equal(sourceDerivedOracleAdaptationQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(sourceDerivedOracleAdaptationQuery.failedGates.some((gate) =>
  gate.code === 'source_adapted_profile_not_no_shim_gpu_hmr'
));
const missingNoShimSourceIdentityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-no-shim-source-identity', {
      proofIds: [],
      ledger: {
        present: true,
        source: 'recomputed_ledger',
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
      runtimeProofArtifact: {
        present: true,
        accepted: true,
        failedGates: [],
      },
      runMode: {},
      noShimSourceIdentity: {
        schemaVersion: 'synthi.gpu_hmr.no_shim_source_identity.v1',
        accepted: true,
        proofIds: ['forged:no-shim-proof'],
      },
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(missingNoShimSourceIdentityQuery.accepted, false);
assert.equal(missingNoShimSourceIdentityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingNoShimSourceIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_source_or_edit_hash_missing'
));
assert.ok(missingNoShimSourceIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_runtime_artifact_chain_unclosed'
));
assert.ok(missingNoShimSourceIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_runtime_proof_binding_missing'
));
const sourcePathOnlyNoShimIdentityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-source-path-only-no-shim-identity', {
      runMode: {},
      acceptanceContract: {
        artifact_identity: {
          source_paths: ['src/kernels/generic_kernel.hip'],
        },
      },
      fissionReport: {
        changed_sources: ['src/kernels/generic_kernel.hip'],
      },
      realRocmSourceDeltaExecution: {
        schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_execution.v1',
        phases: [
          {
            phaseName: 'hot_delta_1',
            sourcePath: 'src/kernels/generic_kernel.hip',
            sourceWriteObserved: true,
            compileCallAttempted: true,
          },
        ],
      },
      noShimSourceIdentity: {
        schemaVersion: 'synthi.gpu_hmr.no_shim_source_identity.v1',
        accepted: true,
        sourceIdentityPresent: true,
      },
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(sourcePathOnlyNoShimIdentityQuery.accepted, false);
assert.equal(sourcePathOnlyNoShimIdentityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(sourcePathOnlyNoShimIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_source_or_edit_hash_missing'
));
const unknownAcceptanceScopeQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-unknown-acceptance-scope', {
      acceptanceScope: 'vendor_runtime_claim_without_declared_scope',
      claimScope: 'unknown_scope',
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(unknownAcceptanceScopeQuery.accepted, false);
assert.ok(unknownAcceptanceScopeQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_known_acceptance_scope'
));
const forgedBroadScopeQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-forged-broad-acceptance-scope', {
      acceptanceScope: 'broad_library_agnostic',
      claimScope: 'broad_library_agnostic',
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(forgedBroadScopeQuery.accepted, false);
assert.equal(forgedBroadScopeQuery.summary.broadFullRuntimeGpuHmrRows, 0);
assert.equal(forgedBroadScopeQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedBroadScopeQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_broad_library_agnostic_scope_proof'
));
assert.ok(forgedBroadScopeQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_known_acceptance_scope'
));
assert.equal(
  forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.authority,
  'matrix_computed_not_row_declared',
);
assert.equal(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.accepted, false);
assert.equal(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.broadRuntimeRowsComputed, true);
assert.equal(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.broadRuntimeRowsMissing, true);
assert.equal(
  forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.rowLocalBroadRuntimeRowsMissing,
  true,
);
assert.ok(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.openGaps.includes(
  'broad_runtime_rows_missing',
));
assert.ok(!forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.openGaps.includes(
  'broad_runtime_rows_not_computed_from_matrix',
));
const forgedBroadScopeWithFacetQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-forged-broad-acceptance-scope-with-facet', {
      acceptanceScope: 'broad_library_agnostic',
      claimScope: 'broad_library_agnostic',
      broadLibraryAgnosticProof: {
        accepted: true,
        recomputedFromLedger: true,
        evidenceRefs: ['ledger:a', 'ledger:b'],
        backendScopes: ['hip', 'hiprt', 'webgpu', 'opencl'],
        libraryFamilies: ['generated', 'engine', 'large-rocm'],
        environmentClasses: ['local-rocm'],
        negativeRefusalProofs: ['refusal:a'],
        outputOracleProofs: ['oracle:a'],
      },
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(forgedBroadScopeWithFacetQuery.accepted, false);
assert.equal(forgedBroadScopeWithFacetQuery.summary.broadFullRuntimeGpuHmrRows, 0);
assert.equal(forgedBroadScopeWithFacetQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedBroadScopeWithFacetQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_broad_library_agnostic_scope_proof'
));
assert.ok(forgedBroadScopeWithFacetQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_known_acceptance_scope'
));
assert.equal(
  forgedBroadScopeWithFacetQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.accepted,
  false,
);

const broadReadinessRows = [
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-hip-visual',
    backend: 'hip',
    acceptanceScope: 'rocm_hip_declared_runtime_profile',
    oracle: 'visual',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-webgpu-compute',
    backend: 'webgpu',
    acceptanceScope: 'webgpu_declared_compute_readback',
    proofMode: 'webgpu_wgsl_runtime_compute',
    oracle: 'compute',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-opencl-compute',
    backend: 'opencl',
    acceptanceScope: 'opencl_declared_compute_readback',
    oracle: 'compute',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-vulkan-visual',
    backend: 'vulkan',
    acceptanceScope: 'vulkan_declared_pipeline_visual',
    oracle: 'visual',
  }),
  ...Array.from({ length: 8 }, (_, index) =>
    refusalMatrixRow(`broad-readiness-adversarial-refusal-${index + 1}`)
  ),
];
const broadReadinessVisualOnlyRows = [
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-only-hip',
    backend: 'hip',
    acceptanceScope: 'rocm_hip_declared_runtime_profile',
    oracle: 'visual',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-only-webgpu',
    backend: 'webgpu',
    acceptanceScope: 'webgpu_declared_compute_readback',
    proofMode: 'webgpu_wgsl_runtime_compute',
    oracle: 'visual',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-only-opencl',
    backend: 'opencl',
    acceptanceScope: 'opencl_declared_compute_readback',
    oracle: 'visual',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-only-vulkan',
    backend: 'vulkan',
    acceptanceScope: 'vulkan_declared_pipeline_visual',
    oracle: 'visual',
  }),
  ...Array.from({ length: 8 }, (_, index) =>
    refusalMatrixRow(`broad-readiness-visual-only-refusal-${index + 1}`)
  ),
];
const broadReadinessVisualArtifactComputeOracleRows = [
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-artifact-compute-oracle-hip',
    backend: 'hip',
    acceptanceScope: 'rocm_hip_declared_runtime_profile',
    oracle: 'compute',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-artifact-compute-oracle-webgpu',
    backend: 'webgpu',
    acceptanceScope: 'webgpu_declared_compute_readback',
    proofMode: 'webgpu_wgsl_runtime_compute',
    oracle: 'compute',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-artifact-compute-oracle-opencl',
    backend: 'opencl',
    acceptanceScope: 'opencl_declared_compute_readback',
    oracle: 'compute',
  }),
  acceptedBroadReadinessCandidate({
    targetId: 'broad-readiness-visual-artifact-compute-oracle-vulkan',
    backend: 'vulkan',
    acceptanceScope: 'vulkan_declared_pipeline_visual',
    oracle: 'compute',
  }),
  ...Array.from({ length: 8 }, (_, index) =>
    refusalMatrixRow(`broad-readiness-visual-artifact-compute-oracle-refusal-${index + 1}`)
  ),
];
const broadReadinessRandomColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `random-cold-readiness-user-project-${index + 1}`,
    sourceUrl: `https://example.invalid/user/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`random-cold-readiness-commit-${index + 1}`).slice(0, 40),
  })
);
const broadReadinessWithoutRandomColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: broadReadinessRows,
});
assert.equal(broadReadinessWithoutRandomColdQuery.accepted, true);
assert.equal(
  broadReadinessWithoutRandomColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithoutRandomColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  0,
);
assert.ok(
  broadReadinessWithoutRandomColdQuery.summary.broadLibraryAgnosticReadiness.openGaps.includes(
    'broad_acceptance_requires_random_large_project_cold_path',
  ),
);
const broadReadinessWithProfiledColdOnlyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    randomColdReadinessMatrixRow({
      targetId: 'profiled-cold-readiness-large-rocm',
      profileMode: 'profile_backed_real_rocm_runner',
      candidateSource: 'configured_candidate_pool',
      resultStatus: 'runner_timeout_failed_closed',
      sourceUrl: 'https://example.invalid/profiled/large-rocm.git',
    }),
  ],
});
assert.equal(broadReadinessWithProfiledColdOnlyQuery.accepted, true);
assert.equal(
  broadReadinessWithProfiledColdOnlyQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithProfiledColdOnlyQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  0,
);
assert.ok(
  broadReadinessWithProfiledColdOnlyQuery.summary.broadLibraryAgnosticReadiness.openGaps.includes(
    'broad_acceptance_requires_random_large_project_cold_path',
  ),
);
const profiledColdOnlyCoverage = new Map(
  broadReadinessWithProfiledColdOnlyQuery.summary.planCoverage.map((entry) => [entry.id, entry])
);
assert.equal(
  profiledColdOnlyCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'diagnostic_only',
);
assert.equal(
  profiledColdOnlyCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  0,
);
assert.ok(
  profiledColdOnlyCoverage.get('random_large_arbitrary_project_cold_path')?.openGaps
    .includes('qualifying_direct_random_large_project_cold_path_required'),
);
const broadReadinessWithConfiguredUnprofiledColdOnlyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    randomColdReadinessMatrixRow({
      targetId: 'configured-unprofiled-cold-readiness-user-project',
      candidateSource: 'configured_candidate_pool',
      resultStatus: 'unprofiled_candidate_pool_cold_intake_refused',
      sourceUrl: 'https://example.invalid/configured-pool/project.git',
    }),
  ],
});
assert.equal(broadReadinessWithConfiguredUnprofiledColdOnlyQuery.accepted, true);
assert.equal(
  broadReadinessWithConfiguredUnprofiledColdOnlyQuery.summary.broadLibraryAgnosticReadiness
    .accepted,
  false,
);
assert.equal(
  broadReadinessWithConfiguredUnprofiledColdOnlyQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.ok(
  broadReadinessWithConfiguredUnprofiledColdOnlyQuery.summary.broadLibraryAgnosticReadiness
    .openGaps.includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const configuredColdOnlyCoverage = new Map(
  broadReadinessWithConfiguredUnprofiledColdOnlyQuery.summary.planCoverage.map((entry) =>
    [entry.id, entry]
  )
);
assert.equal(
  configuredColdOnlyCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'diagnostic_only',
);
assert.equal(
  configuredColdOnlyCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  0,
);
assert.ok(
  configuredColdOnlyCoverage.get('random_large_arbitrary_project_cold_path')?.openGaps
    .includes('qualifying_direct_random_large_project_cold_path_required'),
);
const broadReadinessForgedDirectSourceRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `forged-direct-source-cold-readiness-${index + 1}`,
    sourceUrl: `https://example.invalid/forged-direct/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`forged-direct-source-commit-${index + 1}`).slice(0, 40),
    inputMode: null,
  })
);
const broadReadinessWithForgedDirectSourceQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessForgedDirectSourceRows,
  ],
});
assert.equal(broadReadinessWithForgedDirectSourceQuery.accepted, true);
assert.equal(
  broadReadinessWithForgedDirectSourceQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithForgedDirectSourceQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithForgedDirectSourceQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithForgedDirectSourceQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const broadReadinessMissingDirectInputEvidenceRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `missing-direct-input-evidence-cold-readiness-${index + 1}`,
    sourceUrl: `https://example.invalid/missing-direct-input/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`missing-direct-input-evidence-commit-${index + 1}`).slice(0, 40),
    directInputEvidence: false,
  })
);
const broadReadinessWithMissingDirectInputEvidenceQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessMissingDirectInputEvidenceRows,
  ],
});
assert.equal(broadReadinessWithMissingDirectInputEvidenceQuery.accepted, true);
assert.equal(
  broadReadinessWithMissingDirectInputEvidenceQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithMissingDirectInputEvidenceQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithMissingDirectInputEvidenceQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithMissingDirectInputEvidenceQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const broadReadinessMismatchedDirectInputRows = Array.from({ length: 5 }, (_, index) => {
  const immutableCommit = sha256Hex(`mismatched-direct-input-evidence-commit-${index + 1}`)
    .slice(0, 40);
  return randomColdReadinessMatrixRow({
    targetId: `mismatched-direct-input-evidence-cold-readiness-${index + 1}`,
    sourceUrl: `https://example.invalid/direct-input-row/project-${index + 1}.git`,
    immutableCommit,
    directInputEvidence: randomColdDirectInputEvidenceFixture({
      sourceUrl: `https://example.invalid/replayed-direct-input/project-${index + 1}.git`,
      immutableCommit,
    }),
  });
});
const broadReadinessWithMismatchedDirectInputQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessMismatchedDirectInputRows,
  ],
});
assert.equal(broadReadinessWithMismatchedDirectInputQuery.accepted, true);
assert.equal(
  broadReadinessWithMismatchedDirectInputQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithMismatchedDirectInputQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithMismatchedDirectInputQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithMismatchedDirectInputQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const broadReadinessDiscoveryOnlyBuildRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `discovery-only-build-metadata-cold-readiness-${index + 1}`,
    sourceUrl: `https://example.invalid/discovery-only-build/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`discovery-only-build-metadata-commit-${index + 1}`).slice(0, 40),
    buildMetadataDiscoveryAccepted: true,
    buildMetadataContentAccepted: false,
    buildMetadataContentHash: null,
  })
);
const broadReadinessWithDiscoveryOnlyBuildQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessDiscoveryOnlyBuildRows,
  ],
});
assert.equal(broadReadinessWithDiscoveryOnlyBuildQuery.accepted, true);
assert.equal(
  broadReadinessWithDiscoveryOnlyBuildQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithDiscoveryOnlyBuildQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithDiscoveryOnlyBuildQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithDiscoveryOnlyBuildQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const broadReadinessDeclaredOnlyBuildContentRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `declared-only-build-content-cold-readiness-${index + 1}`,
    sourceUrl: `https://example.invalid/declared-only-build-content/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`declared-only-build-content-commit-${index + 1}`).slice(0, 40),
    buildMetadataDiscoveryAccepted: true,
    buildMetadataContentAccepted: true,
    buildMetadataContentHash: hashValue(`declared-only-build-content:${index + 1}`),
    buildMetadataContentEvidence: null,
  })
);
const broadReadinessWithDeclaredOnlyBuildContentQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessDeclaredOnlyBuildContentRows,
  ],
});
assert.equal(broadReadinessWithDeclaredOnlyBuildContentQuery.accepted, true);
assert.equal(
  broadReadinessWithDeclaredOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithDeclaredOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithDeclaredOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithDeclaredOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const broadReadinessHashOnlyBuildContentRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `hash-only-build-content-cold-readiness-${index + 1}`,
    sourceUrl: `https://example.invalid/hash-only-build-content/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`hash-only-build-content-commit-${index + 1}`).slice(0, 40),
    buildMetadataContentEvidence: randomColdBuildMetadataContentEvidenceFixture({
      targetId: `hash-only-build-content-${index + 1}`,
      includeByteLength: false,
      includeTransport: false,
    }),
  })
);
const broadReadinessWithHashOnlyBuildContentQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessHashOnlyBuildContentRows,
  ],
});
assert.equal(broadReadinessWithHashOnlyBuildContentQuery.accepted, true);
assert.equal(
  broadReadinessWithHashOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithHashOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithHashOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithHashOnlyBuildContentQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const hashOnlyBuildContentCoverage = new Map(
  broadReadinessWithHashOnlyBuildContentQuery.summary.planCoverage.map((entry) => [entry.id, entry])
);
assert.equal(
  hashOnlyBuildContentCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'diagnostic_only',
);
assert.equal(
  hashOnlyBuildContentCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  0,
);
assert.ok(
  hashOnlyBuildContentCoverage.get('random_large_arbitrary_project_cold_path')?.openGaps
    .includes('qualifying_direct_random_large_project_cold_path_required'),
);
const broadReadinessUnrecognizedBuildContentRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `unrecognized-build-content-cold-readiness-${index + 1}`,
    sourceUrl: `https://example.invalid/unrecognized-build-content/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`unrecognized-build-content-commit-${index + 1}`).slice(0, 40),
    buildMetadataContentEvidence: randomColdBuildMetadataContentEvidenceFixture({
      targetId: `unrecognized-build-content-${index + 1}`,
      buildFilePath: 'README.md',
    }),
  })
);
const broadReadinessWithUnrecognizedBuildContentQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessUnrecognizedBuildContentRows,
  ],
});
assert.equal(broadReadinessWithUnrecognizedBuildContentQuery.accepted, true);
assert.equal(
  broadReadinessWithUnrecognizedBuildContentQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithUnrecognizedBuildContentQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithUnrecognizedBuildContentQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithUnrecognizedBuildContentQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const unrecognizedBuildContentCoverage = new Map(
  broadReadinessWithUnrecognizedBuildContentQuery.summary.planCoverage.map((entry) => [
    entry.id,
    entry,
  ])
);
assert.equal(
  unrecognizedBuildContentCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'diagnostic_only',
);
assert.equal(
  unrecognizedBuildContentCoverage.get('random_large_arbitrary_project_cold_path')
    ?.qualifyingRowCount,
  0,
);
assert.ok(
  unrecognizedBuildContentCoverage.get('random_large_arbitrary_project_cold_path')?.openGaps
    .includes('qualifying_direct_random_large_project_cold_path_required'),
);
const broadReadinessSmallRandomColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `small-random-cold-readiness-user-project-${index + 1}`,
    sourceUrl: `https://example.invalid/user/small-project-${index + 1}.git`,
    immutableCommit: sha256Hex(`small-random-cold-readiness-commit-${index + 1}`).slice(0, 40),
    fileCount: 3,
    totalKnownBytes: 4096,
  })
);
const broadReadinessWithSmallRandomColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessSmallRandomColdRows,
  ],
});
assert.equal(broadReadinessWithSmallRandomColdQuery.accepted, true);
assert.equal(
  broadReadinessWithSmallRandomColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithSmallRandomColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithSmallRandomColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  5,
);
assert.ok(
  broadReadinessWithSmallRandomColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_large_random_project_cold_paths'),
);
const smallRandomColdCoverage = new Map(
  broadReadinessWithSmallRandomColdQuery.summary.planCoverage.map((entry) => [entry.id, entry])
);
assert.equal(
  smallRandomColdCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'candidate_only',
);
assert.equal(
  smallRandomColdCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  0,
);
assert.equal(
  smallRandomColdCoverage.get('random_large_arbitrary_project_cold_path')?.candidateRowCount,
  5,
);
assert.ok(
  smallRandomColdCoverage.get('random_large_arbitrary_project_cold_path')?.openGaps
    .includes('random_large_project_cold_path_large_source_required'),
);
const broadReadinessAssetHeavyLowSourceColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `asset-heavy-low-source-cold-readiness-user-project-${index + 1}`,
    sourceUrl: `https://example.invalid/user/asset-heavy-low-source-${index + 1}.git`,
    immutableCommit: sha256Hex(`asset-heavy-low-source-cold-readiness-commit-${index + 1}`).slice(0, 40),
    fileCount: 2500,
    totalKnownBytes: 128 * 1024 * 1024,
    sourceRelevantFileCount: 3,
  })
);
const broadReadinessWithAssetHeavyLowSourceColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...broadReadinessAssetHeavyLowSourceColdRows,
  ],
});
assert.equal(broadReadinessWithAssetHeavyLowSourceColdQuery.accepted, true);
assert.equal(
  broadReadinessWithAssetHeavyLowSourceColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithAssetHeavyLowSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithAssetHeavyLowSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  5,
);
assert.ok(
  broadReadinessWithAssetHeavyLowSourceColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_large_random_project_cold_paths'),
);
assert.equal(
  broadReadinessWithAssetHeavyLowSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .minimumRandomColdPathSourceRelevantFileCount,
  25,
);
assert.equal(
  broadReadinessWithAssetHeavyLowSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.randomColdPathSelectionPredicate
    .minimumSourceRelevantFileCountWhenLargeRequired,
  25,
);
const assetHeavyLowSourceColdCoverage = new Map(
  broadReadinessWithAssetHeavyLowSourceColdQuery.summary.planCoverage.map((entry) => [
    entry.id,
    entry,
  ])
);
assert.equal(
  assetHeavyLowSourceColdCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'candidate_only',
);
assert.equal(
  assetHeavyLowSourceColdCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  0,
);
assert.equal(
  assetHeavyLowSourceColdCoverage.get('random_large_arbitrary_project_cold_path')?.candidateRowCount,
  5,
);
assert.ok(
  assetHeavyLowSourceColdCoverage.get('random_large_arbitrary_project_cold_path')?.openGaps
    .includes('random_large_project_cold_path_large_source_required'),
);
const broadReadinessWithoutSourceFirstVisualQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) => withoutSourceFirstVisualSupport(row)),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithoutSourceFirstVisualQuery.accepted, true);
assert.equal(
  broadReadinessWithoutSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithoutSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithoutSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithoutSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const broadReadinessWithProfiledSourceFirstVisualQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) => withSourceFirstSourceAuthority(row, 'profile_source_files')),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithProfiledSourceFirstVisualQuery.accepted, true);
assert.equal(
  broadReadinessWithProfiledSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithProfiledSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithProfiledSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithProfiledSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const profiledSourceFirstCoverage = new Map(
  broadReadinessWithProfiledSourceFirstVisualQuery.summary.planCoverage.map((entry) =>
    [entry.id, entry]
  )
);
assert.equal(
  profiledSourceFirstCoverage.get('source_first_uncompiled_project_validation')?.status,
  'missing',
);
const broadReadinessWithImplicitCliSourceFirstVisualQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) => withSourceFirstSourceAuthority(row, 'cli_or_env_direct_source')),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithImplicitCliSourceFirstVisualQuery.accepted, true);
assert.equal(
  broadReadinessWithImplicitCliSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithImplicitCliSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithImplicitCliSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithImplicitCliSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const implicitCliSourceFirstCoverage = new Map(
  broadReadinessWithImplicitCliSourceFirstVisualQuery.summary.planCoverage.map((entry) =>
    [entry.id, entry]
  )
);
assert.equal(
  implicitCliSourceFirstCoverage.get('source_first_uncompiled_project_validation')?.status,
  'missing',
);
const broadReadinessWithDirectSourceFirstMissingIdentityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) => withoutSourceFirstDirectSourceIdentity(row)),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithDirectSourceFirstMissingIdentityQuery.accepted, true);
assert.equal(
  broadReadinessWithDirectSourceFirstMissingIdentityQuery.summary.broadLibraryAgnosticReadiness
    .accepted,
  false,
);
assert.equal(
  broadReadinessWithDirectSourceFirstMissingIdentityQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithDirectSourceFirstMissingIdentityQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.equal(
  broadReadinessWithDirectSourceFirstMissingIdentityQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualSourceIdentityCount,
  0,
);
assert.ok(
  broadReadinessWithDirectSourceFirstMissingIdentityQuery.summary.broadLibraryAgnosticReadiness
    .openGaps.includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const missingDirectSourceIdentityCoverage = new Map(
  broadReadinessWithDirectSourceFirstMissingIdentityQuery.summary.planCoverage.map((entry) =>
    [entry.id, entry]
  )
);
assert.equal(
  missingDirectSourceIdentityCoverage.get('source_first_uncompiled_project_validation')?.status,
  'missing',
);
const fixtureLocalSourceFirstVisualRows = broadReadinessRows.map((row) => {
  const oracleKind = row.outputOracleFacet?.kind ?? row.output_oracle_facet?.kind;
  return oracleKind === 'visual_oracle'
    ? withSourceFirstDirectLocalIdentity(
      row,
      path.join(
        'mcp',
        'synthi-mcp',
        '.gpu-hmr-test-logs',
        'source-first',
        'visual-fixture',
        row.targetId,
      ),
      sha256Hex(`fixture-local-source-first:${row.targetId}`).slice(0, 40),
    )
    : row;
});
const broadReadinessWithFixtureLocalSourceFirstVisualQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...fixtureLocalSourceFirstVisualRows,
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithFixtureLocalSourceFirstVisualQuery.accepted, true);
assert.equal(
  broadReadinessWithFixtureLocalSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .accepted,
  false,
);
assert.equal(
  broadReadinessWithFixtureLocalSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithFixtureLocalSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .openGaps.includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
assert.ok(
  broadReadinessWithFixtureLocalSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.sourceFirstVisualSelectionPredicate.requiredSignals
    .includes('direct_local_source_path_outside_matrix_fixture_roots'),
);
assert.ok(
  broadReadinessWithFixtureLocalSourceFirstVisualQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.sourceFirstVisualSelectionPredicate
    .rejectedDirectLocalSourceRootsForBroadReadiness
    .includes('.gpu-hmr-test-logs'),
);
const fixtureLocalSourceFirstCoverage = new Map(
  broadReadinessWithFixtureLocalSourceFirstVisualQuery.summary.planCoverage.map((entry) => [
    entry.id,
    entry,
  ])
);
assert.equal(
  fixtureLocalSourceFirstCoverage.get('source_first_uncompiled_project_validation')?.status,
  'missing',
);
const repeatedSourceFirstVisualIdentityRows = broadReadinessRows.map((row) => {
  const oracleKind = row.outputOracleFacet?.kind ?? row.output_oracle_facet?.kind;
  return oracleKind === 'visual_oracle'
    ? withSharedSourceFirstDirectIdentity(
      row,
      'https://example.invalid/replayed/source-first-visual.git',
      '9999999999999999999999999999999999999999',
    )
    : row;
});
const broadReadinessWithRepeatedSourceFirstVisualIdentityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...repeatedSourceFirstVisualIdentityRows,
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithRepeatedSourceFirstVisualIdentityQuery.accepted, true);
assert.equal(
  broadReadinessWithRepeatedSourceFirstVisualIdentityQuery.summary.broadLibraryAgnosticReadiness
    .accepted,
  false,
);
assert.equal(
  broadReadinessWithRepeatedSourceFirstVisualIdentityQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  2,
);
assert.equal(
  broadReadinessWithRepeatedSourceFirstVisualIdentityQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualSourceIdentityCount,
  1,
);
assert.equal(
  broadReadinessWithRepeatedSourceFirstVisualIdentityQuery.summary.broadLibraryAgnosticReadiness
    .minimumSourceFirstVisualDistinctSourceIdentityCount,
  2,
);
assert.ok(
  broadReadinessWithRepeatedSourceFirstVisualIdentityQuery.summary.broadLibraryAgnosticReadiness
    .openGaps.includes('broad_acceptance_requires_distinct_source_first_visual_full_runtime_sources'),
);
const repeatedSourceFirstVisualIdentityCoverage = new Map(
  broadReadinessWithRepeatedSourceFirstVisualIdentityQuery.summary.planCoverage.map((entry) => [
    entry.id,
    entry,
  ])
);
assert.equal(
  repeatedSourceFirstVisualIdentityCoverage.get('source_first_uncompiled_project_validation')
    ?.status,
  'candidate_only',
);
assert.ok(
  repeatedSourceFirstVisualIdentityCoverage.get('source_first_uncompiled_project_validation')
    ?.openGaps.includes('distinct_source_first_visual_full_runtime_sources_required'),
);
const broadReadinessWithForgedSourceFirstSchemaQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) =>
      withSourceFirstSchemaVersion(row, 'synthi.gpu.hmr.agent_split_source_first_ingestion.forged')
    ),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithForgedSourceFirstSchemaQuery.accepted, true);
assert.equal(
  broadReadinessWithForgedSourceFirstSchemaQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithForgedSourceFirstSchemaQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithForgedSourceFirstSchemaQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithForgedSourceFirstSchemaQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const forgedSourceFirstSchemaCoverage = new Map(
  broadReadinessWithForgedSourceFirstSchemaQuery.summary.planCoverage.map((entry) => [entry.id, entry])
);
assert.equal(
  forgedSourceFirstSchemaCoverage.get('source_first_uncompiled_project_validation')?.status,
  'missing',
);
const broadReadinessWithForgedSourceFirstProofIdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) => withForgedSourceFirstProofId(row)),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithForgedSourceFirstProofIdQuery.accepted, true);
assert.equal(
  broadReadinessWithForgedSourceFirstProofIdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithForgedSourceFirstProofIdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithForgedSourceFirstProofIdQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithForgedSourceFirstProofIdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const broadReadinessWithForgedAsyncVisualAuthorityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) => withAsyncVisualSupportAuthorityClaim(row)),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithForgedAsyncVisualAuthorityQuery.accepted, true);
assert.equal(
  broadReadinessWithForgedAsyncVisualAuthorityQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithForgedAsyncVisualAuthorityQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithForgedAsyncVisualAuthorityQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithForgedAsyncVisualAuthorityQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const forgedAsyncVisualAuthorityCoverage = new Map(
  broadReadinessWithForgedAsyncVisualAuthorityQuery.summary.planCoverage.map((entry) =>
    [entry.id, entry]
  )
);
assert.equal(
  forgedAsyncVisualAuthorityCoverage.get('source_first_uncompiled_project_validation')?.status,
  'missing',
);
const broadReadinessWithoutVisualOutputOracleFacetQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows.map((row) => withoutOutputOracleFacet(row)),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessWithoutVisualOutputOracleFacetQuery.accepted, false);
assert.ok(broadReadinessWithoutVisualOutputOracleFacetQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_accepted_output_oracle_facet'
));
assert.equal(
  broadReadinessWithoutVisualOutputOracleFacetQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithoutVisualOutputOracleFacetQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithoutVisualOutputOracleFacetQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessWithoutVisualOutputOracleFacetQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const forgedComputeCardOnlyOutputClosureQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    withComputeCardOnlyButNoOutputOracleFacet(acceptedBroadReadinessCandidate({
      targetId: 'forged-compute-card-output-closure',
      backend: 'opencl',
      acceptanceScope: 'opencl_declared_compute_readback',
      oracle: 'compute',
    })),
  ],
});
assert.equal(forgedComputeCardOnlyOutputClosureQuery.accepted, false);
assert.ok(forgedComputeCardOnlyOutputClosureQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_accepted_output_oracle_facet'
));
const broadReadinessRowsWithOneRandomCold = [
  ...broadReadinessRows,
  randomColdReadinessMatrixRow(),
];
const broadReadinessWithOneRandomColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: broadReadinessRowsWithOneRandomCold,
});
assert.equal(broadReadinessWithOneRandomColdQuery.accepted, true);
assert.equal(
  broadReadinessWithOneRandomColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithOneRandomColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  1,
);
assert.ok(
  broadReadinessWithOneRandomColdQuery.summary.broadLibraryAgnosticReadiness.openGaps.includes(
    'broad_acceptance_requires_more_random_large_project_cold_paths',
  ),
);
const pendingOrDryRunRandomColdRows = [
  ...Array.from({ length: 3 }, (_, index) =>
    randomColdReadinessMatrixRow({
      targetId: `pending-random-cold-readiness-${index + 1}`,
      sourceUrl: `https://example.invalid/pending/random-cold-${index + 1}.git`,
      immutableCommit: `777777777777777777777777777777777777777${index + 1}`,
      eventType: 'cold_path_pending',
      dryRun: false,
      actualAttempt: false,
    })
  ),
  ...Array.from({ length: 2 }, (_, index) =>
    randomColdReadinessMatrixRow({
      targetId: `dry-run-random-cold-readiness-${index + 1}`,
      sourceUrl: `https://example.invalid/dry-run/random-cold-${index + 1}.git`,
      immutableCommit: `888888888888888888888888888888888888888${index + 1}`,
      eventType: 'cold_path_complete',
      dryRun: true,
      actualAttempt: false,
    })
  ),
];
const broadReadinessWithPendingOrDryRunColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...pendingOrDryRunRandomColdRows,
  ],
});
assert.equal(broadReadinessWithPendingOrDryRunColdQuery.accepted, true);
assert.equal(
  broadReadinessWithPendingOrDryRunColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithPendingOrDryRunColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithPendingOrDryRunColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithPendingOrDryRunColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const directLocalRandomColdRow = randomColdReadinessMatrixRow({
  targetId: 'direct-local-random-cold-readiness-user-project',
  candidateSource: 'direct_local_git_repo_path',
  sourceUrl: 'file:///tmp/arbitrary-local-user-project',
  localRepoPath: path.join(tmpRoot, 'arbitrary-local-user-project'),
  immutableCommit: '1212121212121212121212121212121212121212',
});
const broadReadinessWithDirectLocalColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    directLocalRandomColdRow,
  ],
});
assert.equal(broadReadinessWithDirectLocalColdQuery.accepted, true);
assert.equal(
  broadReadinessWithDirectLocalColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  1,
);
assert.equal(
  broadReadinessWithDirectLocalColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceIdentityCount,
  1,
);
assert.deepEqual(
  broadReadinessWithDirectLocalColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathTargets,
  ['direct-local-random-cold-readiness-user-project'],
);
const fixtureLocalRandomColdRow = randomColdReadinessMatrixRow({
  targetId: 'fixture-local-random-cold-readiness-user-project',
  candidateSource: 'direct_local_git_repo_path',
  sourceUrl: 'file:///tmp/synthi-self-check-local-user-project',
  localRepoPath: path.join(
    'mcp',
    'synthi-mcp',
    '.gpu-hmr-test-logs',
    'random-large-project-cold-path',
    'self-check',
    'local-user-project',
  ),
  immutableCommit: '1313131313131313131313131313131313131313',
});
const broadReadinessWithFixtureLocalColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    fixtureLocalRandomColdRow,
  ],
});
assert.equal(broadReadinessWithFixtureLocalColdQuery.accepted, true);
assert.equal(
  broadReadinessWithFixtureLocalColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithFixtureLocalColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithFixtureLocalColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithFixtureLocalColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
assert.ok(
  broadReadinessWithFixtureLocalColdQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.randomColdPathSelectionPredicate.requiredSignals
    .includes('direct_local_git_repo_path_outside_matrix_fixture_roots'),
);
assert.ok(
  broadReadinessWithFixtureLocalColdQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.randomColdPathSelectionPredicate
    .rejectedDirectLocalRepoPathRootsForBroadReadiness
    .includes('.gpu-hmr-test-logs'),
);
const repeatedSourceRandomColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `replayed-source-random-cold-readiness-${index + 1}`,
    sourceUrl: 'https://example.invalid/replayed/random-large-project.git',
    immutableCommit: '3333333333333333333333333333333333333333',
  })
);
const broadReadinessWithRepeatedSourceColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...repeatedSourceRandomColdRows,
  ],
});
assert.equal(broadReadinessWithRepeatedSourceColdQuery.accepted, true);
assert.equal(
  broadReadinessWithRepeatedSourceColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithRepeatedSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithRepeatedSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceIdentityCount,
  1,
);
assert.equal(
  broadReadinessWithRepeatedSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.randomColdPathDistinctSourceIdentityCount,
  1,
);
assert.ok(
  broadReadinessWithRepeatedSourceColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_distinct_random_large_project_cold_sources'),
);
const repeatedSourceColdCoverage = new Map(
  broadReadinessWithRepeatedSourceColdQuery.summary.planCoverage.map((entry) => [entry.id, entry])
);
assert.equal(
  repeatedSourceColdCoverage.get('random_large_arbitrary_project_cold_path')
    ?.qualifyingRowCount,
  5,
);
assert.equal(
  repeatedSourceColdCoverage.get('random_large_arbitrary_project_cold_path')
    ?.qualifyingDistinctSourceIdentityCount,
  1,
);
const variedInputChannelSets = [
  ['cli_arg_source_url', 'cli_arg_commit'],
  ['env_source_url', 'env_commit'],
  ['cli_arg_source_url', 'env_commit'],
  ['env_source_url', 'cli_arg_commit'],
  ['cli_arg_source_url', 'cli_arg_commit', 'env_source_id'],
];
const variedChannelSameSourceRandomColdRows = variedInputChannelSets.map((inputChannels, index) =>
  randomColdReadinessMatrixRow({
    targetId: `varied-channel-source-random-cold-readiness-${index + 1}`,
    sourceUrl: 'https://example.invalid/replayed/channel-variant-large-project.git',
    immutableCommit: '5555555555555555555555555555555555555555',
    directInputEvidenceInputChannels: inputChannels,
  })
);
const broadReadinessWithVariedChannelSameSourceColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...variedChannelSameSourceRandomColdRows,
  ],
});
assert.equal(broadReadinessWithVariedChannelSameSourceColdQuery.accepted, true);
assert.equal(
  broadReadinessWithVariedChannelSameSourceColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithVariedChannelSameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithVariedChannelSameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceIdentityCount,
  1,
);
assert.equal(
  broadReadinessWithVariedChannelSameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceContentIdentityCount,
  1,
);
assert.ok(
  broadReadinessWithVariedChannelSameSourceColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_distinct_random_large_project_cold_sources'),
);
const sharedContentSourceListingHash = hashValue('shared-random-cold-content-only:listing');
const sharedContentBuildEvidence = randomColdBuildMetadataContentEvidenceFixture({
  targetId: 'shared-random-cold-content-only',
});
const differentSourceLabelsSameContentColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `different-label-same-content-random-cold-${index + 1}`,
    sourceUrl: `https://example.invalid/relabelled/content-clone-${index + 1}.git`,
    immutableCommit: sha256Hex(`different-label-same-content-random-cold-${index + 1}`)
      .slice(0, 40),
    sourceListingHash: sharedContentSourceListingHash,
    buildMetadataContentEvidence: sharedContentBuildEvidence,
  })
);
const broadReadinessWithDifferentLabelsSameContentColdQuery =
  queryGpuHmrValidationMatrixLedger({
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    rows: [
      ...broadReadinessRows,
      ...differentSourceLabelsSameContentColdRows,
    ],
  });
assert.equal(broadReadinessWithDifferentLabelsSameContentColdQuery.accepted, true);
assert.equal(
  broadReadinessWithDifferentLabelsSameContentColdQuery.summary.broadLibraryAgnosticReadiness
    .accepted,
  false,
);
assert.equal(
  broadReadinessWithDifferentLabelsSameContentColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithDifferentLabelsSameContentColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceIdentityCount,
  5,
);
assert.equal(
  broadReadinessWithDifferentLabelsSameContentColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceContentOnlyIdentityCount,
  1,
);
assert.ok(
  broadReadinessWithDifferentLabelsSameContentColdQuery.summary.broadLibraryAgnosticReadiness
    .openGaps.includes('broad_acceptance_requires_distinct_random_large_project_cold_content'),
);
const replayedSourceWithForgedContentIdentitiesRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `forged-content-identity-source-random-cold-readiness-${index + 1}`,
    sourceUrl: 'https://example.invalid/replayed/content-identity-large-project.git',
    immutableCommit: '6666666666666666666666666666666666666666',
    sourceListingHash: hashValue(`forged-content-identity:listing:${index + 1}`),
    sourceIntakeFacetHash: hashValue(`forged-content-identity:intake:${index + 1}`),
    buildMetadataContentEvidence: randomColdBuildMetadataContentEvidenceFixture({
      targetId: `forged-content-identity-build-${index + 1}`,
    }),
  })
);
const broadReadinessWithForgedContentIdentitySameSourceColdQuery =
  queryGpuHmrValidationMatrixLedger({
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    rows: [
      ...broadReadinessRows,
      ...replayedSourceWithForgedContentIdentitiesRows,
    ],
  });
assert.equal(broadReadinessWithForgedContentIdentitySameSourceColdQuery.accepted, true);
assert.equal(
  broadReadinessWithForgedContentIdentitySameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .accepted,
  false,
);
assert.equal(
  broadReadinessWithForgedContentIdentitySameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessWithForgedContentIdentitySameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceIdentityCount,
  1,
);
assert.equal(
  broadReadinessWithForgedContentIdentitySameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceContentIdentityCount,
  5,
);
assert.ok(
  broadReadinessWithForgedContentIdentitySameSourceColdQuery.summary.broadLibraryAgnosticReadiness
    .openGaps.includes('broad_acceptance_requires_distinct_random_large_project_cold_sources'),
);
const forgedSourceIntakeAuthorityColdRow = withQueryRecomputedRowId((() => {
  const row = randomColdReadinessMatrixRow({
    targetId: 'forged-source-intake-authority-random-cold',
    sourceUrl: 'https://example.invalid/forged/source-intake-authority.git',
    immutableCommit: '2323232323232323232323232323232323232323',
  });
  row.coldSourceTreeIntake.proofAuthority = 'forged_source_intake_runtime_authority';
  row.coldSourceTreeIntake.proof_authority = 'forged_source_intake_runtime_authority';
  row.cold_source_tree_intake.proofAuthority = 'forged_source_intake_runtime_authority';
  row.cold_source_tree_intake.proof_authority = 'forged_source_intake_runtime_authority';
  return row;
})());
const forgedSourceIntakeAuthorityColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    forgedSourceIntakeAuthorityColdRow,
  ],
});
assert.equal(forgedSourceIntakeAuthorityColdQuery.accepted, false);
assert.ok(forgedSourceIntakeAuthorityColdQuery.failedGates.some((gate) =>
  gate.code === 'random_large_project_cold_source_intake_invalid'
));
assert.ok(forgedSourceIntakeAuthorityColdQuery.failedGates.some((gate) =>
  gate.code === 'random_cold_source_intake_authority_invalid'
));
assert.equal(
  forgedSourceIntakeAuthorityColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  0,
);
assert.ok(
  forgedSourceIntakeAuthorityColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const profileIdOnlyRandomColdRow = withQueryRecomputedRowId((() => {
  const row = randomColdReadinessMatrixRow({
    targetId: 'profile-id-only-random-cold',
    sourceUrl: 'https://example.invalid/profile-id-only/random-cold.git',
    immutableCommit: '2424242424242424242424242424242424242424',
  });
  row.profileId = 'unprofiled_arbitrary_project_cold_intake';
  row.profile_id = 'unprofiled_arbitrary_project_cold_intake';
  delete row.profileMode;
  delete row.profile_mode;
  delete row.randomLargeProjectColdPath.profileMode;
  delete row.randomLargeProjectColdPath.profile_mode;
  delete row.random_large_project_cold_path.profileMode;
  delete row.random_large_project_cold_path.profile_mode;
  return row;
})());
const profileIdOnlyRandomColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    profileIdOnlyRandomColdRow,
  ],
});
assert.equal(profileIdOnlyRandomColdQuery.accepted, true);
assert.equal(
  profileIdOnlyRandomColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  0,
);
assert.equal(
  profileIdOnlyRandomColdQuery.summary.broadLibraryAgnosticReadiness.randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  profileIdOnlyRandomColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_random_large_project_cold_path'),
);
const staleUnsafeAcceptedRow = withoutOutputOracleFacet(acceptedBroadReadinessCandidate({
  targetId: 'stale-unsafe-accepted-source-first-visual',
  backend: 'hip',
  acceptanceScope: 'rocm_hip_declared_runtime_profile',
  oracle: 'visual',
}));
const staleUnsafeRandomColdDirectInput = {
  ...randomColdDirectInputEvidenceFixture({
    sourceUrl: 'https://example.invalid/stale/random-cold.git',
    immutableCommit: '4444444444444444444444444444444444444444',
  }),
  sourceIdentityRole: 'forged_target_specific_role',
  source_identity_role: 'forged_target_specific_role',
};
const staleUnsafeRandomColdRow = withQueryRecomputedRowId((() => {
  const row = randomColdReadinessMatrixRow({
    targetId: 'stale-unsafe-random-cold-missing-direct-input',
    sourceUrl: 'https://example.invalid/stale/random-cold.git',
    immutableCommit: '4444444444444444444444444444444444444444',
    directInputEvidence: staleUnsafeRandomColdDirectInput,
  });
  const failedGates = [
    'random_cold_direct_input_evidence_invalid',
    'random_cold_direct_input_source_identity_role_invalid',
  ];
  row.randomLargeProjectColdPath.failedGates = failedGates;
  row.randomLargeProjectColdPath.failed_gates = failedGates;
  row.random_large_project_cold_path.failedGates = failedGates;
  row.random_large_project_cold_path.failed_gates = failedGates;
  return row;
})());
const staleUnsafeDirectQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    staleUnsafeAcceptedRow,
    staleUnsafeRandomColdRow,
  ],
});
assert.equal(staleUnsafeDirectQuery.accepted, false);
assert.ok(staleUnsafeDirectQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_accepted_output_oracle_facet'
));
assert.ok(staleUnsafeDirectQuery.failedGates.some((gate) =>
  gate.code === 'random_large_project_cold_path_facet_invalid'
));
const broadReadinessRowsWithRandomCold = [
  ...broadReadinessRows,
  ...broadReadinessRandomColdRows,
];
const broadReadinessFreshRandomColdLedger = buildGpuHmrValidationMatrixLedger(
  broadReadinessRowsWithRandomCold,
  { generatedAt: '2026-06-30T21:05:00.000Z' },
);
assert.equal(broadReadinessFreshRandomColdLedger.query.accepted, true);
assert.equal(
  broadReadinessFreshRandomColdLedger.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.accepted,
  true,
);
assert.equal(
  broadReadinessFreshRandomColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathFreshnessPolicy.enforced,
  true,
);
assert.equal(
  broadReadinessFreshRandomColdLedger.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  5,
);
const staleRandomColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `stale-random-cold-current-run-${index + 1}`,
    sourceUrl: `https://example.invalid/stale-current-run/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`stale-random-cold-current-run-${index + 1}`).slice(0, 40),
    updatedAt: '2026-06-01T00:00:00.000Z',
    artifactPath: `historical-default-root/random-cold-${index + 1}.json`,
  })
);
const broadReadinessWithStaleRandomColdLedger = buildGpuHmrValidationMatrixLedger([
  ...broadReadinessRows,
  ...staleRandomColdRows,
], {
  generatedAt: '2026-06-30T21:05:00.000Z',
});
assert.equal(broadReadinessWithStaleRandomColdLedger.query.accepted, true);
assert.equal(
  broadReadinessWithStaleRandomColdLedger.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithStaleRandomColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithStaleRandomColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithStaleRandomColdLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_fresh_random_large_project_cold_path'),
);
assert.ok(
  broadReadinessWithStaleRandomColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathFreshnessGaps
    .includes('random_cold_path_freshness_row_too_old_for_current_matrix'),
);
const staleRandomColdCoverage = new Map(
  broadReadinessWithStaleRandomColdLedger.summary.planCoverage.map((entry) => [entry.id, entry])
);
assert.equal(
  staleRandomColdCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  0,
);
assert.ok(
  staleRandomColdCoverage.get('random_large_arbitrary_project_cold_path')?.freshnessGaps
    .includes('random_cold_path_freshness_row_too_old_for_current_matrix'),
);
const replayedHistoricalRandomColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `fresh-mtime-replayed-historical-random-cold-${index + 1}`,
    sourceUrl: `https://example.invalid/fresh-mtime-replay/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`fresh-mtime-replayed-historical-random-cold-${index + 1}`).slice(0, 40),
    updatedAt: '2026-06-30T21:03:00.000Z',
    artifactPath: `historical-default-root/random-cold-${index + 1}.json`,
  })
);
const broadReadinessWithFreshMtimeHistoricalColdLedger = buildGpuHmrValidationMatrixLedger([
  ...broadReadinessRows,
  ...replayedHistoricalRandomColdRows,
], {
  generatedAt: '2026-06-30T21:05:00.000Z',
});
assert.equal(broadReadinessWithFreshMtimeHistoricalColdLedger.query.accepted, true);
assert.equal(
  broadReadinessWithFreshMtimeHistoricalColdLedger.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithFreshMtimeHistoricalColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.equal(
  broadReadinessWithFreshMtimeHistoricalColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathCandidateRowCount,
  0,
);
assert.ok(
  broadReadinessWithFreshMtimeHistoricalColdLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_fresh_random_large_project_cold_path'),
);
assert.ok(
  broadReadinessWithFreshMtimeHistoricalColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathFreshnessGaps
    .includes('random_cold_path_artifact_path_replay_or_audit_root'),
);
const replayedOldDatedRandomColdRows = Array.from({ length: 5 }, (_, index) =>
  randomColdReadinessMatrixRow({
    targetId: `fresh-mtime-old-dated-random-cold-${index + 1}`,
    sourceUrl: `https://example.invalid/fresh-mtime-old-dated/project-${index + 1}.git`,
    immutableCommit: sha256Hex(`fresh-mtime-old-dated-random-cold-${index + 1}`).slice(0, 40),
    updatedAt: '2026-06-30T21:03:00.000Z',
    artifactPath:
      `mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/project-20260609/replay-${index + 1}.json`,
  })
);
const broadReadinessWithFreshMtimeOldDatedColdLedger = buildGpuHmrValidationMatrixLedger([
  ...broadReadinessRows,
  ...replayedOldDatedRandomColdRows,
], {
  generatedAt: '2026-06-30T21:05:00.000Z',
});
assert.equal(broadReadinessWithFreshMtimeOldDatedColdLedger.query.accepted, true);
assert.equal(
  broadReadinessWithFreshMtimeOldDatedColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  0,
);
assert.ok(
  broadReadinessWithFreshMtimeOldDatedColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathFreshnessGaps
    .includes('random_cold_path_artifact_path_timestamp_too_old_for_current_matrix'),
);
const staleBroadReadinessContributorRows = broadReadinessRows.map((row) =>
  withUpdatedAt(row, '2026-06-01T00:00:00.000Z')
);
const broadReadinessWithStaleContributorLedger = buildGpuHmrValidationMatrixLedger([
  ...staleBroadReadinessContributorRows,
  ...broadReadinessRandomColdRows,
], {
  generatedAt: '2026-06-30T21:05:00.000Z',
});
assert.equal(broadReadinessWithStaleContributorLedger.query.accepted, true);
assert.equal(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.accepted,
  false,
);
assert.equal(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.acceptedFullRuntimeRows,
  0,
);
assert.equal(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.fullRuntimeCandidateRows,
  4,
);
assert.ok(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_fresh_full_runtime_rows'),
);
assert.ok(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_fresh_adversarial_refusals'),
);
assert.ok(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_fresh_source_first_visual_full_runtime_row'),
);
assert.ok(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness
    .fullRuntimeFreshnessGaps
    .includes('full_runtime:broad_readiness_freshness_row_too_old_for_current_matrix'),
);
assert.ok(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness
    .refusalFreshnessGaps
    .includes('adversarial_refusal:broad_readiness_freshness_row_too_old_for_current_matrix'),
);
assert.ok(
  broadReadinessWithStaleContributorLedger.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualFreshnessGaps
    .includes('source_first_visual:broad_readiness_freshness_row_too_old_for_current_matrix'),
);
const freshMtimeReplayedContributorRows = broadReadinessRows.map((row, index) =>
  withArtifactPath(
    row,
    index % 2 === 0
      ? `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/replayed-${index + 1}.json`
      : `mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/replayed-20260609-${index + 1}.json`,
  )
);
const broadReadinessWithFreshMtimeReplayedContributorsLedger =
  buildGpuHmrValidationMatrixLedger([
    ...freshMtimeReplayedContributorRows,
    ...broadReadinessRandomColdRows,
  ], {
    generatedAt: '2026-06-30T21:05:00.000Z',
  });
assert.equal(broadReadinessWithFreshMtimeReplayedContributorsLedger.query.accepted, true);
assert.equal(
  broadReadinessWithFreshMtimeReplayedContributorsLedger.summary.broadLibraryAgnosticReadiness
    .accepted,
  false,
);
assert.equal(
  broadReadinessWithFreshMtimeReplayedContributorsLedger.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.acceptedFullRuntimeRows,
  0,
);
assert.ok(
  broadReadinessWithFreshMtimeReplayedContributorsLedger.summary.broadLibraryAgnosticReadiness
    .fullRuntimeFreshnessGaps
    .some((gap) =>
      gap === 'full_runtime:broad_readiness_artifact_path_replay_or_audit_root'
      || gap === 'full_runtime:broad_readiness_artifact_path_timestamp_too_old_for_current_matrix'
    ),
);
assert.ok(
  broadReadinessWithFreshMtimeReplayedContributorsLedger.summary.broadLibraryAgnosticReadiness
    .refusalFreshnessGaps
    .some((gap) =>
      gap === 'adversarial_refusal:broad_readiness_artifact_path_replay_or_audit_root'
      || gap === 'adversarial_refusal:broad_readiness_artifact_path_timestamp_too_old_for_current_matrix'
    ),
);
assert.ok(
  broadReadinessWithFreshMtimeReplayedContributorsLedger.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualFreshnessGaps
    .some((gap) =>
      gap === 'source_first_visual:broad_readiness_artifact_path_replay_or_audit_root'
      || gap === 'source_first_visual:broad_readiness_artifact_path_timestamp_too_old_for_current_matrix'
    ),
);
const broadReadinessWithMixedFreshStaleColdLedger = buildGpuHmrValidationMatrixLedger([
  ...broadReadinessRows,
  ...broadReadinessRandomColdRows.slice(0, 2),
  ...staleRandomColdRows.slice(0, 3),
], {
  generatedAt: '2026-06-30T21:05:00.000Z',
});
assert.equal(broadReadinessWithMixedFreshStaleColdLedger.query.accepted, true);
assert.equal(
  broadReadinessWithMixedFreshStaleColdLedger.summary.broadLibraryAgnosticReadiness
    .randomColdPathRowCount,
  2,
);
assert.equal(
  broadReadinessWithMixedFreshStaleColdLedger.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.ok(
  broadReadinessWithMixedFreshStaleColdLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_more_random_large_project_cold_paths'),
);
const broadReadinessWithStaleUnsafeRowsLedger = buildGpuHmrValidationMatrixLedger([
  ...broadReadinessRowsWithRandomCold,
  staleUnsafeAcceptedRow,
  staleUnsafeRandomColdRow,
], {
  generatedAt: '2026-06-30T21:05:00.000Z',
});
assert.equal(broadReadinessWithStaleUnsafeRowsLedger.query.accepted, true);
assert.equal(broadReadinessWithStaleUnsafeRowsLedger.summary.omittedInvalidatedRows, 2);
assert.equal(broadReadinessWithStaleUnsafeRowsLedger.summary.omitted_invalidated_rows, 2);
assert.equal(
  broadReadinessWithStaleUnsafeRowsLedger.rows.some((row) =>
    row.targetId === 'stale-unsafe-accepted-source-first-visual'
  ),
  false,
);
assert.equal(
  broadReadinessWithStaleUnsafeRowsLedger.rows.some((row) =>
    row.targetId === 'stale-unsafe-random-cold-missing-direct-input'
  ),
  false,
);
const broadReadinessRowsWithNewerWeakAttempt = JSON.parse(JSON.stringify(broadReadinessRowsWithRandomCold));
broadReadinessRowsWithNewerWeakAttempt[0].attemptKey = 'generic-broad-readiness-rerun-attempt';
broadReadinessRowsWithNewerWeakAttempt[0].attempt_key = 'generic-broad-readiness-rerun-attempt';
const newerWeakBroadReadinessAttempt = {
  ...JSON.parse(JSON.stringify(broadReadinessRowsWithNewerWeakAttempt[0])),
  rowId: `gpu-validation-matrix-row:sha256:${sha256Hex('generic-broad-readiness-rerun-newer-weak')}`,
  row_id: `gpu-validation-matrix-row:sha256:${sha256Hex('generic-broad-readiness-rerun-newer-weak')}`,
  matrixOutcome: 'unproven',
  matrix_outcome: 'unproven',
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
  proofChainAccepted: false,
  proof_chain_accepted: false,
  updatedAt: '2999-01-01T00:00:00.000Z',
  updated_at: '2999-01-01T00:00:00.000Z',
  artifactPath: 'generic-broad-readiness-rerun-newer-weak.json',
  artifact_path: 'generic-broad-readiness-rerun-newer-weak.json',
  reasons: ['newer_rerun_missing_runtime_proof'],
  openGaps: ['newer_rerun_missing_runtime_proof'],
  open_gaps: ['newer_rerun_missing_runtime_proof'],
};
const broadReadinessWithNewerWeakAttemptLedger = buildGpuHmrValidationMatrixLedger([
  ...broadReadinessRowsWithNewerWeakAttempt,
  newerWeakBroadReadinessAttempt,
], {
  generatedAt: '2026-06-30T21:05:00.000Z',
});
assert.equal(broadReadinessWithNewerWeakAttemptLedger.query.accepted, true);
assert.equal(
  broadReadinessWithNewerWeakAttemptLedger.attemptHistory.latestUnselectedAttemptWarning,
  true,
);
assert.equal(
  broadReadinessWithNewerWeakAttemptLedger.summary.broadLibraryAgnosticReadiness
    .latestAttemptUnselectedBlocksReadiness,
  true,
);
assert.equal(
  broadReadinessWithNewerWeakAttemptLedger.summary.broadLibraryAgnosticReadiness
    .latestUnselectedAttemptCount,
  1,
);
assert.ok(
  broadReadinessWithNewerWeakAttemptLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('latest_attempt_unselected_by_priority_selection'),
);
const broadReadinessSerializedAsyncVisualOnlyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: broadReadinessRowsWithRandomCold.map((row) =>
    withSerializedOnlyAsyncVisualSupport(row)
  ),
});
assert.equal(broadReadinessSerializedAsyncVisualOnlyQuery.accepted, true);
assert.equal(
  broadReadinessSerializedAsyncVisualOnlyQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessSerializedAsyncVisualOnlyQuery.summary.broadLibraryAgnosticReadiness
    .sourceFirstVisualRowCount,
  0,
);
assert.ok(
  broadReadinessSerializedAsyncVisualOnlyQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_source_first_visual_full_runtime_row'),
);
const broadReadinessVisualOnlyWithRandomColdQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessVisualOnlyRows,
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessVisualOnlyWithRandomColdQuery.accepted, true);
assert.equal(
  broadReadinessVisualOnlyWithRandomColdQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessVisualOnlyWithRandomColdQuery.summary.broadLibraryAgnosticReadiness
    .computeOracleTargetCount,
  0,
);
assert.ok(
  broadReadinessVisualOnlyWithRandomColdQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_compute_oracle_rows'),
);
const broadReadinessVisualArtifactsComputeOracleQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessVisualArtifactComputeOracleRows,
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessVisualArtifactsComputeOracleQuery.accepted, true);
assert.equal(
  broadReadinessVisualArtifactsComputeOracleQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessVisualArtifactsComputeOracleQuery.summary.broadLibraryAgnosticReadiness
    .visualOracleTargetCount,
  0,
);
assert.equal(
  broadReadinessVisualArtifactsComputeOracleQuery.summary.broadLibraryAgnosticReadiness
    .computeOracleTargetCount,
  4,
);
assert.deepEqual(
  broadReadinessVisualArtifactsComputeOracleQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.visualTargets,
  [],
);
assert.ok(
  broadReadinessVisualArtifactsComputeOracleQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_visual_oracle_rows'),
);
const broadReadinessForgedComputeCardOnlyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessVisualOnlyRows.map((row) => withForgedComputeCardOnlyFlag(row)),
    ...broadReadinessRandomColdRows,
  ],
});
assert.equal(broadReadinessForgedComputeCardOnlyQuery.accepted, true);
assert.equal(
  broadReadinessForgedComputeCardOnlyQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  broadReadinessForgedComputeCardOnlyQuery.summary.broadLibraryAgnosticReadiness
    .computeOracleTargetCount,
  0,
);
assert.ok(
  broadReadinessForgedComputeCardOnlyQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('broad_acceptance_requires_compute_oracle_rows'),
);
const broadReadinessQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: broadReadinessRowsWithRandomCold,
});
assert.equal(broadReadinessQuery.accepted, true);
const broadReadinessCoverage = new Map(
  broadReadinessQuery.summary.planCoverage.map((entry) => [entry.id, entry])
);
assert.equal(
  broadReadinessCoverage.get('random_large_arbitrary_project_cold_path')?.status,
  'refused',
);
assert.equal(
  broadReadinessCoverage.get('random_large_arbitrary_project_cold_path')?.qualifyingRowCount,
  5,
);
assert.equal(
  broadReadinessCoverage.get('random_large_arbitrary_project_cold_path')?.candidateRowCount,
  5,
);
assert.equal(
  broadReadinessCoverage.get('source_first_uncompiled_project_validation')?.status,
  'accepted',
);
assert.equal(
  broadReadinessCoverage.get('source_first_uncompiled_project_validation')?.sourceIdentityCount,
  2,
);
assert.ok(
  broadReadinessCoverage.get('source_first_uncompiled_project_validation')?.rows.every((row) =>
    [
      'direct_source_url_commit',
      'direct_local_git_repo_path',
      'user_source_files',
      'workspace_source_files',
    ].includes(row.sourceFirstIngestion?.sourceAuthority)
  )
);
assert.equal(broadReadinessQuery.summary.acceptedFullRuntimeGpuHmrRows, 4);
assert.equal(broadReadinessQuery.summary.broadFullRuntimeGpuHmrRows, 0);
assert.equal(broadReadinessQuery.summary.scopedFullRuntimeGpuHmrRows, 4);
assert.equal(
  broadReadinessQuery.summary.acceptedFullRuntimeClaimScopeBreakdown.scoped_profile,
  4,
);
assert.equal(
  broadReadinessQuery.summary.fullRuntimeGeneralityBreakdown.profile_scoped_only,
  4,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('row_local_broad_runtime_rows_missing'),
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.matrixGeneralizationAccepted,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.rowLocalBroadRuntimeProofRequired,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .accepted,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof.authority,
  'matrix_recomputed_from_strict_full_runtime_rows',
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .broadRuntimeRows,
  0,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .matrixGeneralizationRuntimeRows,
  4,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadRuntimeRows,
  0,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadRuntimeRowsMissing,
  false,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.rowLocalBroadRuntimeRowsMissing,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.matrixGeneralizationRuntimeRows,
  4,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  5,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceIdentityCount,
  5,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.sourceFirstVisualRowCount,
  2,
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.sourceFirstVisualTargets,
  ['broad-readiness-hip-visual', 'broad-readiness-vulkan-visual'],
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathRows,
  5,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathDistinctSourceIdentityCount,
  5,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualRows,
  2,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSourceIdentityCount,
  2,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .minimumSourceFirstVisualDistinctSourceIdentityCount,
  2,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.sourceFirstVisualSourceIdentityCount,
  2,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .minimumSourceFirstVisualDistinctSourceIdentityCount,
  2,
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSourceIdentityHashes.every((hash) => /^sha256:[a-f0-9]{64}$/.test(hash)),
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionTargetNameIndependent,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.authority,
  'matrix_static_source_first_visual_predicate_not_project_name_whitelist',
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.projectNameWhitelist,
  [],
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.specificTargetIdsAllowed,
  [],
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.acceptedSourceAuthorities,
  [
    'direct_source_url_commit',
    'direct_local_git_repo_path',
    'user_source_files',
    'workspace_source_files',
  ],
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.distinctSourceIdentitiesRequired,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.minimumDistinctSourceIdentityCount,
  2,
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.directSourceAuthoritiesRequiringIdentityEvidence,
  [
    'direct_source_url_commit',
    'direct_local_git_repo_path',
  ],
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.rejectedSourceAuthoritiesForBroadReadiness
    .includes('cli_or_env_direct_source'),
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredDirectInputEvidenceAuthority,
  'runner_cli_env_direct_source_input_only_not_gpu_hmr_success',
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredSignals.includes(
      'full_runtime_evidence_authority_schema_accepted',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredSignals.includes(
      'strict_runtime_visual_authority_accepted',
    ),
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredFullRuntimeEvidenceAuthoritySchema,
  'synthi.gpu_hmr.full_runtime_evidence_authority.v1',
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredFullRuntimeEvidenceAuthority,
  'matrix_recomputed_full_runtime_evidence_authority_not_row_declared',
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredFullRuntimeAuthoritySource,
  'strict_runtime_proof_artifact',
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredSignals.includes(
      'visual_output_oracle_accepted',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredSignals.includes(
      'direct_source_identity_evidence_accepted_when_direct_authority',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.requiredSignals.includes(
      'distinct_source_first_visual_source_identities_observed',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualSelectionPredicate.ignoredForAcceptance.includes('target_id_value'),
);
assert.ok(
  /^sha256:[a-f0-9]{64}$/.test(
    broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
      .sourceFirstVisualSelectionPredicate.predicateHash,
  ),
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionTargetNameIndependent,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.authority,
  'matrix_static_predicate_not_project_name_whitelist',
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.sourceIdentityRole,
  'source_identity_hash_bound_to_direct_input_not_whitelist',
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.distinctSourceIdentitiesRequired,
  true,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.minimumDistinctSourceIdentityCount,
  5,
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredDirectInputEvidenceAuthority,
  'runner_cli_env_direct_source_input_only_not_gpu_hmr_success',
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredBuildMetadataContentEvidenceSchema,
  'synthi.gpu_hmr.cold_build_metadata_content.v1',
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredBuildMetadataContentEvidenceAuthority,
  'build_metadata_content_bytes_only_not_gpu_hmr_success',
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'direct_source_input_evidence_accepted',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'distinct_direct_source_identities_observed',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'build_metadata_content_evidence_accepted',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'build_metadata_content_schema_authority_accepted',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'build_metadata_content_byte_hashes_observed',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'build_metadata_content_build_file_path_recognized',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'build_metadata_content_hash_observed',
    ),
);
assert.ok(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.requiredSignals.includes(
      'source_relevant_file_count_required_for_large_source',
    ),
);
assert.equal(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.minimumSourceRelevantFileCountWhenLargeRequired,
  25,
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.projectNameWhitelist,
  [],
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathSelectionPredicate.specificTargetIdsAllowed,
  [],
);
assert.ok(
  /^sha256:[a-f0-9]{64}$/.test(
    broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
      .randomColdPathSelectionPredicate.predicateHash,
  ),
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .randomColdPathTargets,
  [
    'random-cold-readiness-user-project-1',
    'random-cold-readiness-user-project-2',
    'random-cold-readiness-user-project-3',
    'random-cold-readiness-user-project-4',
    'random-cold-readiness-user-project-5',
  ],
);
assert.deepEqual(
  broadReadinessQuery.summary.broadLibraryAgnosticReadiness.broadLibraryAgnosticProof
    .sourceFirstVisualTargets,
  ['broad-readiness-hip-visual', 'broad-readiness-vulkan-visual'],
);
const nonWhitelistedRandomColdRows = Array.from({ length: 5 }, (_, index) => {
  const suffix = sha256Hex(`opaque-arbitrary-cold-${index + 1}`).slice(0, 12);
  return randomColdReadinessMatrixRow({
    targetId: `opaque-user-gpu-project-${suffix}`,
    sourceUrl: `https://example.invalid/customer/private-gpu-project-${suffix}.git`,
    immutableCommit: sha256Hex(`opaque-arbitrary-cold-commit-${index + 1}`).slice(0, 40),
  });
});
const opaqueSourceFirstVisualRows = [
  acceptedBroadReadinessCandidate({
    targetId: `opaque-source-first-visual-${sha256Hex('opaque-source-first-hip').slice(0, 12)}`,
    backend: 'hip',
    acceptanceScope: 'rocm_hip_declared_runtime_profile',
    oracle: 'visual',
  }),
  acceptedBroadReadinessCandidate({
    targetId: `opaque-source-first-compute-${sha256Hex('opaque-source-first-webgpu').slice(0, 12)}`,
    backend: 'webgpu',
    acceptanceScope: 'webgpu_declared_compute_readback',
    proofMode: 'webgpu_wgsl_runtime_compute',
    oracle: 'compute',
  }),
  acceptedBroadReadinessCandidate({
    targetId: `opaque-source-first-compute-${sha256Hex('opaque-source-first-opencl').slice(0, 12)}`,
    backend: 'opencl',
    acceptanceScope: 'opencl_declared_compute_readback',
    oracle: 'compute',
  }),
  acceptedBroadReadinessCandidate({
    targetId: `opaque-source-first-visual-${sha256Hex('opaque-source-first-vulkan').slice(0, 12)}`,
    backend: 'vulkan',
    acceptanceScope: 'vulkan_declared_pipeline_visual',
    oracle: 'visual',
  }),
  ...Array.from({ length: 8 }, (_, index) =>
    refusalMatrixRow(
      `opaque-source-first-refusal-${sha256Hex(`opaque-source-first-refusal-${index + 1}`).slice(0, 12)}`,
    )
  ),
];
const opaqueSourceFirstBroadReadinessQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...opaqueSourceFirstVisualRows,
    ...nonWhitelistedRandomColdRows,
  ],
});
assert.equal(opaqueSourceFirstBroadReadinessQuery.accepted, true);
assert.equal(
  opaqueSourceFirstBroadReadinessQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.ok(
  opaqueSourceFirstBroadReadinessQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('row_local_broad_runtime_rows_missing'),
);
assert.equal(
  opaqueSourceFirstBroadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .matrixGeneralizationAccepted,
  true,
);
assert.equal(
  opaqueSourceFirstBroadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.sourceFirstVisualSelectionTargetNameIndependent,
  true,
);
assert.deepEqual(
  opaqueSourceFirstBroadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.sourceFirstVisualSelectionPredicate.projectNameWhitelist,
  [],
);
const nonWhitelistedBroadReadinessQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    ...broadReadinessRows,
    ...nonWhitelistedRandomColdRows,
  ],
});
assert.equal(nonWhitelistedBroadReadinessQuery.accepted, true);
assert.equal(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness.randomColdPathRowCount,
  5,
);
assert.equal(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .randomColdPathDistinctSourceIdentityCount,
  5,
);
assert.equal(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.randomColdPathSelectionTargetNameIndependent,
  true,
);
assert.deepEqual(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .broadLibraryAgnosticProof.randomColdPathSelectionPredicate.projectNameWhitelist,
  [],
);
assert.ok(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('row_local_broad_runtime_rows_missing'),
);
assert.equal(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness
    .matrixGeneralizationAccepted,
  true,
);
assert.ok(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness.randomColdPathTargets
    .every((target) => target.startsWith('opaque-user-gpu-project-')),
);
assert.ok(
  nonWhitelistedBroadReadinessQuery.summary.broadLibraryAgnosticReadiness.randomColdPathTargets
    .every((target) => !/(wgpu|bevy|godot|llama|miopen|hipblaslt|composable)/i.test(target)),
);
const validScopedSummaryQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-scoped-summary-row'),
  ],
});
assert.equal(validScopedSummaryQuery.accepted, true);
const inflatedSummaryQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-scoped-summary-row'),
  ],
  summary: {
    ...validScopedSummaryQuery.summary,
    acceptedFullRuntimeClaimScopeBreakdown: { broad_library_agnostic: 1 },
    broadFullRuntimeGpuHmrRows: 1,
    broadFullRuntimeTargets: ['accepted-scoped-summary-row'],
  },
});
assert.equal(inflatedSummaryQuery.accepted, false);
assert.ok(inflatedSummaryQuery.failedGates.some((gate) =>
  gate.code === 'validation_matrix_summary_mismatch'
));
const missingRequiredHookSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-missing-required-app-hook', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmProfileProofObligations: {
        requiresAppHookContract: true,
        requires_app_hook_contract: true,
        blockingGaps: [],
        blocking_gaps: [],
      },
    },
  ],
});
assert.equal(missingRequiredHookSafetyQuery.accepted, false);
assert.ok(missingRequiredHookSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_real_rocm_app_hook_contract'
));
const failedRuntimeCapabilityPreflightSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-failed-runtime-capability-preflight', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmRuntimeCapabilityPreflight: {
        schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_capability_preflight_facet.v1',
        present: true,
        accepted: false,
        blockingGaps: ['runtime_device_unavailable'],
        blocking_gaps: ['runtime_device_unavailable'],
      },
    },
  ],
});
assert.equal(failedRuntimeCapabilityPreflightSafetyQuery.accepted, false);
assert.ok(failedRuntimeCapabilityPreflightSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_cannot_have_failed_real_rocm_runtime_capability_preflight'
));
const missingRuntimeCapabilityPreflightSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-missing-runtime-capability-preflight', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmRuntimeCapabilityPreflight: {
        schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_capability_preflight_facet.v1',
        present: false,
        accepted: null,
        blockingGaps: [],
        blocking_gaps: [],
      },
    },
  ],
});
assert.equal(missingRuntimeCapabilityPreflightSafetyQuery.accepted, false);
assert.ok(missingRuntimeCapabilityPreflightSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_real_rocm_runtime_capability_preflight'
));

const forgedRuntimeProfileAdapterResultSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-forged-runtime-profile-adapter-result', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmRuntimeProfileAdapterResult: {
        schemaVersion: 'synthi.real_rocm.runtime_profile_adapter_result_bridge.v1',
        schema_version: 'synthi.real_rocm.runtime_profile_adapter_result_bridge.v1',
        proofAuthority: 'runtime_proof',
        proof_authority: 'runtime_proof',
        status: 'runtime_profile_adapter_result_imported',
        declared: true,
        present: true,
        acceptedForGpuHmr: true,
        accepted_for_gpu_hmr: true,
        gpuHmrSuccess: true,
        gpu_hmr_success: true,
        canSatisfyRuntimeProof: true,
        can_satisfy_runtime_proof: true,
        canSatisfyDispatchProof: true,
        can_satisfy_dispatch_proof: true,
        strictRuntimeProofAccepted: true,
        strict_runtime_proof_accepted: true,
        strictRuntimeProofArtifactPresent: true,
        strict_runtime_proof_artifact_present: true,
        proofLedgerPresent: true,
        proof_ledger_present: true,
        strictRuntimeProofId: `gpu-runtime-proof:sha256:${'a'.repeat(64)}`,
        strict_runtime_proof_id: `gpu-runtime-proof:sha256:${'a'.repeat(64)}`,
        proofLedgerId: `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
        proof_ledger_id: `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
        adapterResultHash: `sha256:${'c'.repeat(64)}`,
        adapter_result_hash: `sha256:${'c'.repeat(64)}`,
        evidenceRefs: [`sha256:${'c'.repeat(64)}`],
        evidence_refs: [`sha256:${'c'.repeat(64)}`],
        blockingGaps: [],
        blocking_gaps: [],
      },
    },
  ],
});
assert.equal(forgedRuntimeProfileAdapterResultSafetyQuery.accepted, false);
assert.ok(forgedRuntimeProfileAdapterResultSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_cannot_have_failed_real_rocm_runtime_profile_adapter_result'
));
assert.ok(forgedRuntimeProfileAdapterResultSafetyQuery.failedGates.some((gate) =>
  gate.code === 'real_rocm_runtime_profile_adapter_result_claimed_gpu_hmr_acceptance'
));
assert.ok(forgedRuntimeProfileAdapterResultSafetyQuery.failedGates.some((gate) =>
  gate.code === 'real_rocm_runtime_profile_adapter_result_claimed_gpu_hmr_success'
));
assert.ok(forgedRuntimeProfileAdapterResultSafetyQuery.failedGates.some((gate) =>
  gate.code === 'real_rocm_runtime_profile_adapter_result_claimed_runtime_authority'
));
assert.ok(forgedRuntimeProfileAdapterResultSafetyQuery.failedGates.some((gate) =>
  gate.code === 'real_rocm_runtime_profile_adapter_result_claimed_dispatch_authority'
));

const forgedOperationalEvidenceSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-forged-operational-evidence', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmOperationalEvidence: {
        timeoutControl: {
          schemaVersion: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
          schema_version: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
          proofAuthority: 'runtime_proof',
          proof_authority: 'runtime_proof',
          runId: 'forged-run-a',
          run_id: 'forged-run-a',
          timeoutSeconds: 1,
          timeout_seconds: 1,
          acceptedForGpuHmr: true,
          accepted_for_gpu_hmr: true,
          gpuHmrSuccess: true,
          gpu_hmr_success: true,
          canSatisfyRuntimeProof: true,
          can_satisfy_runtime_proof: true,
        },
        runtimeEvidenceCollection: {
          schemaVersion: 'synthi.real_rocm.runtime_evidence_collection.v1',
          schema_version: 'synthi.real_rocm.runtime_evidence_collection.v1',
          proofAuthority: 'runtime_proof',
          proof_authority: 'runtime_proof',
          status: 'collected',
          acceptedForGpuHmr: true,
          accepted_for_gpu_hmr: true,
          gpuHmrSuccess: true,
          gpu_hmr_success: true,
          canSatisfyRuntimeProof: true,
          can_satisfy_runtime_proof: true,
        },
        resultCheckpoints: [
          {
            label: 'pre-runtime-evidence',
            status: 'fail_closed_checkpoint_write',
            proofAuthority: 'runtime_proof',
            proof_authority: 'runtime_proof',
            acceptedForGpuHmr: true,
            accepted_for_gpu_hmr: true,
            gpuHmrSuccess: true,
            gpu_hmr_success: true,
            canSatisfyRuntimeProof: true,
            can_satisfy_runtime_proof: true,
          },
        ],
      },
    },
  ],
});
assert.equal(forgedOperationalEvidenceSafetyQuery.accepted, false);
assert.ok(forgedOperationalEvidenceSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_cannot_have_failed_real_rocm_operational_evidence'
));
assert.ok(forgedOperationalEvidenceSafetyQuery.failedGates.some((gate) =>
  gate.code === 'real_rocm_worker_lifecycle_timeout_control_claimed_gpu_hmr_success'
));
assert.ok(forgedOperationalEvidenceSafetyQuery.failedGates.some((gate) =>
  gate.code === 'real_rocm_runtime_evidence_collection_claimed_runtime_authority'
));
assert.ok(forgedOperationalEvidenceSafetyQuery.failedGates.some((gate) =>
  gate.code === 'real_rocm_result_checkpoint_claimed_runtime_authority'
));

const opencl = ledger.rows.find((row) =>
  row.backend === 'opencl'
  && row.targetId === 'synthetic-opencl-preflight'
);
assert.equal(opencl?.matrixOutcome, 'refusal_proven');
assert.equal(opencl.acceptedForGpuHmr, false);
assert.equal(opencl.gpuHmrSuccess, false);
assert.equal(opencl.refusalProven, true);
assert.equal(opencl.backendEvidence.accepted, true);
assert.equal(opencl.backendEvidence.backend, 'opencl');
assert.equal(opencl.backendEvidence.backendFamily, 'opencl');
assert.deepEqual(opencl.backendEvidence.evidenceRefs, [openClPreflightEvidenceRef]);

const webgpuPreflight = ledger.rows.find((row) =>
  row.backend === 'webgpu'
  && row.targetId === 'synthetic-webgpu-preflight'
);
assert.equal(webgpuPreflight?.matrixOutcome, 'preflight_only');
assert.equal(webgpuPreflight.acceptedForGpuHmr, false);
assert.equal(webgpuPreflight.gpuHmrSuccess, false);
assert.equal(webgpuPreflight.refusalProven, false);
assert.equal(webgpuPreflight.proofChainAccepted, true);
assert.equal(webgpuPreflight.backendEvidence.accepted, true);
assert.equal(webgpuPreflight.backendEvidence.backend, 'webgpu');
assert.equal(webgpuPreflight.backendEvidence.backendFamily, 'webgpu');
assert.deepEqual(webgpuPreflight.backendEvidence.evidenceRefs, [webGpuPreflightEvidenceRef]);
assert.ok(webgpuPreflight.openGaps.includes('shader_pipeline_or_output_oracle_not_proven'));
assert.ok(!webgpuPreflight.reasons.includes('preflight_typed_backend_evidence_required'));

const oidnHipPreflight = ledger.rows.find((row) =>
  row.backend === 'oidn_hip'
  && row.targetId === 'synthetic-oidn-hip-preflight'
);
assert.equal(oidnHipPreflight?.matrixOutcome, 'preflight_only');
assert.equal(oidnHipPreflight.acceptedForGpuHmr, false);
assert.equal(oidnHipPreflight.gpuHmrSuccess, false);
assert.equal(oidnHipPreflight.refusalProven, false);
assert.equal(oidnHipPreflight.proofChainAccepted, true);
assert.equal(oidnHipPreflight.backendEvidence.accepted, true);
assert.equal(oidnHipPreflight.backendEvidence.backend, 'oidn_hip');
assert.equal(oidnHipPreflight.backendEvidence.backendFamily, 'oidn_hip');
assert.deepEqual(oidnHipPreflight.backendEvidence.evidenceRefs, [oidnHipPreflightEvidenceRef]);
assert.ok(oidnHipPreflight.openGaps.includes('oidn_output_oracle_not_proven'));
assert.ok(!oidnHipPreflight.openGaps.includes('shader_pipeline_or_output_oracle_not_proven'));
assert.ok(oidnHipPreflight.reasons.includes('preflight_only_oidn_output_oracle_still_required'));

const oidnHipOutputOracle = ledger.rows.find((row) =>
  row.backend === 'oidn_hip'
  && row.targetId === 'synthetic-oidn-hip-output-oracle'
);
assert.equal(oidnHipOutputOracle?.matrixOutcome, 'preflight_only');
assert.equal(oidnHipOutputOracle.acceptedForGpuHmr, false);
assert.equal(oidnHipOutputOracle.gpuHmrSuccess, false);
assert.equal(oidnHipOutputOracle.proofChain, 'runtime_preflight_and_output_oracle_only');
assert.equal(oidnHipOutputOracle.outputOracleFacet.accepted, true);
assert.equal(
  oidnHipOutputOracle.outputOracleFacet.proofAuthority,
  'oidn_output_oracle_file_bytes_only_not_gpu_hmr_success',
);
assert.ok(oidnHipOutputOracle.reasons.includes('preflight_output_oracle_does_not_prove_gpu_hmr'));
assert.ok(oidnHipOutputOracle.openGaps.includes('oidn_full_runtime_hmr_ledger_not_proven'));
assert.ok(oidnHipOutputOracle.openGaps.includes('strict_runtime_proof_ledger_required'));

const forgedOidnHipOutputOracle = ledger.rows.find((row) =>
  row.backend === 'oidn_hip'
  && row.targetId === 'synthetic-oidn-hip-output-oracle-forged-file-hash'
);
assert.equal(forgedOidnHipOutputOracle?.matrixOutcome, 'preflight_only');
assert.equal(forgedOidnHipOutputOracle.acceptedForGpuHmr, false);
assert.equal(forgedOidnHipOutputOracle.gpuHmrSuccess, false);
assert.equal(forgedOidnHipOutputOracle.proofChain, 'runtime_preflight_only');
assert.equal(forgedOidnHipOutputOracle.outputOracleFacet.accepted, false);
assert.ok(forgedOidnHipOutputOracle.reasons.includes(
  'denoised_output:oidn_output_oracle_recomputed_hash_mismatch',
));
assert.ok(forgedOidnHipOutputOracle.openGaps.includes('oidn_output_oracle_not_proven'));

const legacySchemaOnlyPreflightLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [legacySchemaOnlyPreflightDir],
  generatedAt: '2026-06-09T00:00:00.050Z',
  includeUnproven: true,
});
const legacySchemaOnlyPreflight = legacySchemaOnlyPreflightLedger.rows.find(
  (row) => row.targetId === 'legacy-schema-only-opencl-preflight',
);
assert.equal(legacySchemaOnlyPreflight?.backend, 'unknown');
assert.equal(legacySchemaOnlyPreflight.matrixOutcome, 'unproven');
assert.equal(legacySchemaOnlyPreflight.acceptedForGpuHmr, false);
assert.equal(legacySchemaOnlyPreflight.proofChainAccepted, false);
assert.equal(legacySchemaOnlyPreflight.backendEvidence.accepted, false);
assert.ok(legacySchemaOnlyPreflight.reasons.includes('preflight_typed_backend_evidence_required'));
assert.ok(legacySchemaOnlyPreflight.openGaps.includes('preflight_typed_backend_evidence_required'));
const legacySchemaOnlyPreflightCoverage = new Map(
  legacySchemaOnlyPreflightLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(legacySchemaOnlyPreflightCoverage.get('opencl_dispatch_readback')?.status, 'missing');

const forgedRawBackendPreflightLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRawBackendPreflightDir],
  generatedAt: '2026-06-09T00:00:00.060Z',
  includeUnproven: true,
});
const forgedRawBackendPreflight = forgedRawBackendPreflightLedger.rows.find(
  (row) => row.targetId === 'forged-raw-vulkan-backend-refs',
);
assert.equal(forgedRawBackendPreflight?.proofMode, 'runtime_preflight');
assert.equal(forgedRawBackendPreflight.matrixOutcome, 'unproven');
assert.equal(forgedRawBackendPreflight.backend, 'unknown');
assert.equal(forgedRawBackendPreflight.backendEvidence.accepted, false);
assert.ok(forgedRawBackendPreflight.backendEvidence.failedGates.some(
  (gate) => gate.code === 'preflight_backend_contract_schema_missing'
));
const forgedRawBackendPreflightCoverage = new Map(
  forgedRawBackendPreflightLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(forgedRawBackendPreflightCoverage.get('vulkan_pipeline_frame')?.status, 'missing');

const schemaCorrectRawBackendPreflightLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [schemaCorrectRawBackendPreflightDir],
  generatedAt: '2026-06-09T00:00:00.070Z',
  includeUnproven: true,
});
const schemaCorrectRawBackendPreflight = schemaCorrectRawBackendPreflightLedger.rows.find(
  (row) => row.targetId === 'schema-correct-raw-vulkan-backend',
);
assert.equal(schemaCorrectRawBackendPreflight?.proofMode, 'runtime_preflight');
assert.equal(schemaCorrectRawBackendPreflight.matrixOutcome, 'unproven');
assert.equal(schemaCorrectRawBackendPreflight.backend, 'unknown');
assert.equal(schemaCorrectRawBackendPreflight.backendEvidence.accepted, false);
assert.ok(schemaCorrectRawBackendPreflight.backendEvidence.failedGates.some(
  (gate) => gate.code === 'preflight_backend_value_missing'
));
assert.ok(schemaCorrectRawBackendPreflight.backendEvidence.failedGates.some(
  (gate) => gate.code === 'preflight_backend_field_evidence_refs_missing'
));
const schemaCorrectRawBackendPreflightCoverage = new Map(
  schemaCorrectRawBackendPreflightLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(schemaCorrectRawBackendPreflightCoverage.get('vulkan_pipeline_frame')?.status, 'missing');

const forgedPreflightBackendCoverageQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [{
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    artifactSchema: 'synthi.gpu_hmr.opencl_preflight.v1',
    artifactPath: 'synthetic/schema-only-opencl-preflight.json',
    updatedAt: '2026-06-09T00:00:00.050Z',
    backend: 'opencl',
    targetId: 'forged-schema-only-opencl-preflight',
    profileId: 'forged-schema-only-opencl-preflight',
    proofMode: 'runtime_preflight',
    evidenceKind: 'runtime_preflight_refusal',
    matrixOutcome: 'refusal_proven',
    acceptanceClass: 'refusal_proven',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven: true,
    proofChainAccepted: true,
    proofChain: 'structured_runtime_refusal',
    proofIds: ['opencl-preflight-proof:sha256:forged-schema-only'],
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    reasons: [],
    openGaps: [],
  }],
});
assert.equal(forgedPreflightBackendCoverageQuery.accepted, false);
assert.ok(forgedPreflightBackendCoverageQuery.failedGates.some((gate) =>
  gate.code === 'preflight_backend_specific_classification_requires_typed_backend_evidence'
));
const forgedPreflightBackendCoverage = new Map(
  forgedPreflightBackendCoverageQuery.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(forgedPreflightBackendCoverage.get('opencl_dispatch_readback')?.status, 'missing');

const oidnHipRefusedPreflightCoverageQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [withQueryRecomputedRowId({
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    artifactSchema: 'synthi.gpu_hmr.oidn_preflight.v1',
    artifactPath: 'synthetic/refused-oidn-hip-preflight.json',
    updatedAt: '2026-06-09T00:00:00.060Z',
    backend: 'oidn_hip',
    targetId: 'refused-oidn-hip-preflight',
    profileId: 'refused-oidn-hip-preflight',
    proofMode: 'runtime_preflight',
    evidenceKind: 'runtime_preflight_refusal',
    matrixOutcome: 'refusal_proven',
    acceptanceClass: 'refusal_proven',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven: true,
    proofChainAccepted: true,
    proofChain: 'structured_runtime_refusal',
    proofIds: ['oidn-preflight-proof:sha256:refused'],
    backendEvidence: {
      accepted: true,
      backend: 'oidn_hip',
      backendFamily: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
      failedGates: [],
    },
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: ['runtime_preflight_failed'],
    },
    reasons: ['oidn_runtime_preflight_failed'],
    openGaps: ['oidn_runtime_preflight_failed'],
  })],
});
const oidnHipRefusedPreflightCoverage = new Map(
  oidnHipRefusedPreflightCoverageQuery.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(oidnHipRefusedPreflightCoverage.get('oidn_hip_runtime_preflight')?.status, 'refused');
assert.ok(oidnHipRefusedPreflightCoverage.get('oidn_hip_runtime_preflight')?.openGaps.includes(
  'oidn_runtime_preflight_failed',
));
assert.equal(oidnHipRefusedPreflightCoverage.get('oidn_hip_output')?.status, 'refused');
assert.ok(oidnHipRefusedPreflightCoverage.get('oidn_hip_output')?.openGaps.includes(
  'oidn_runtime_preflight_failed',
));

const forgedOidnHipOutputBroadRow = withQueryRecomputedRowId({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
  artifactSchema: 'synthi.gpu_hmr.oidn_preflight.v1',
  artifactPath: 'synthetic/forged-oidn-hip-output-broad.json',
  updatedAt: '2026-06-09T00:00:00.075Z',
  backend: 'oidn_hip',
  targetId: 'forged-oidn-hip-output-broad',
  profileId: 'forged-oidn-hip-output-broad',
  proofMode: 'runtime_preflight',
  evidenceKind: 'runtime_preflight_diagnostic',
  matrixOutcome: 'full_runtime_gpu_hmr',
  acceptanceClass: 'full_runtime_gpu_hmr',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  refusalProven: false,
  proofChainAccepted: true,
  proofChain: 'runtime_preflight_only',
  acceptanceScope: 'broad_library_agnostic',
  claimScope: 'broad_library_agnostic',
  proofIds: ['oidn-preflight-proof:sha256:forged-output-broad'],
  backendEvidence: {
    accepted: true,
    backend: 'oidn_hip',
    backendFamily: 'oidn_hip',
    evidenceRefs: [oidnHipPreflightEvidenceRef],
    failedGates: [],
  },
  ledger: {
    present: false,
    proofId: null,
    gpuHmrSuccess: false,
    failedInvariants: [],
  },
  runtimeProofArtifact: {
    present: false,
    accepted: false,
    failedGates: [{ code: 'runtime_proof_artifact_missing' }],
  },
  reasons: ['forged_oidn_output_success_from_preflight'],
  openGaps: [],
});
const forgedOidnHipOutputBroadQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [forgedOidnHipOutputBroadRow],
});
assert.equal(forgedOidnHipOutputBroadQuery.accepted, false);
assert.equal(forgedOidnHipOutputBroadQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.equal(forgedOidnHipOutputBroadQuery.summary.broadFullRuntimeGpuHmrRows, 0);
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'runtime_preflight_row_cannot_accept_gpu_hmr'
));
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'runtime_preflight_row_cannot_report_gpu_hmr_success'
));
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'runtime_preflight_row_cannot_be_full_runtime_gpu_hmr'
));
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_broad_library_agnostic_scope_proof'
));
const forgedOidnHipOutputBroadCoverage = new Map(
  forgedOidnHipOutputBroadQuery.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(forgedOidnHipOutputBroadCoverage.get('oidn_hip_output')?.status, 'missing');

const bevy = ledger.rows.find((row) => row.backend === 'bevy_wgsl');
assert.equal(bevy?.matrixOutcome, 'refusal_proven');
assert.equal(bevy.acceptedForGpuHmr, false);
assert.equal(bevy.externalProjectContract.accepted, true);
assert.equal(bevy.externalProjectContract.profileClass, 'engine_asset_reload_visual_profile');
assert.ok(bevy.reasons.includes('mcp_no_decoded_frames'));
assert.ok(bevy.reasons.includes('mcp_request_timeout'));
assert.ok(bevy.reasons.includes('visual_frame_missing'));

const bevyNameOnly = ledger.rows.find((row) => row.targetId === 'bevy-wgsl-name-only');
assert.equal(bevyNameOnly?.matrixOutcome, 'refusal_proven');
assert.equal(bevyNameOnly.backend, 'unknown');
assert.equal(bevyNameOnly.externalProjectContract.accepted, false);
assert.ok(bevyNameOnly.openGaps.includes('external_backend_metadata_missing'));
assert.ok(bevyNameOnly.openGaps.includes('external_profile_class_missing'));

const selfCheckNamedExternalRejection = ledger.rows.find(
  (row) => row.targetId === 'explicit-self-check-named-project',
);
assert.equal(selfCheckNamedExternalRejection?.matrixOutcome, 'refusal_proven');
assert.equal(selfCheckNamedExternalRejection.backend, 'webgl');
assert.equal(selfCheckNamedExternalRejection.acceptedForGpuHmr, false);
assert.equal(selfCheckNamedExternalRejection.gpuHmrSuccess, false);
assert.equal(selfCheckNamedExternalRejection.refusalProven, true);
assert.equal(selfCheckNamedExternalRejection.proofChainAccepted, true);
assert.equal(selfCheckNamedExternalRejection.externalProjectContract.accepted, true);
assert.ok(selfCheckNamedExternalRejection.reasons.includes('external_profile_failed'));
assert.ok(selfCheckNamedExternalRejection.reasons.includes('visual_frame_missing'));
assert.ok(selfCheckNamedExternalRejection.reasons.includes('visual_oracle_not_accepted'));

const externalVisual = ledger.rows.find((row) => row.targetId === 'explicit-external-engine-visual');
assert.equal(externalVisual?.matrixOutcome, 'visual_profile_accepted');
assert.equal(externalVisual.backend, 'webgl');
assert.equal(externalVisual.visual.accepted, true);
assert.equal(externalVisual.externalProjectContract.accepted, true);
assert.equal(externalVisual.externalProjectContract.profileClass, 'external_engine_visual_profile');
assert.equal(externalVisual.externalProfileSelection.accepted, true);
assert.equal(externalVisual.externalSourceDelta.accepted, true);
assert.equal(externalVisual.externalSourceDelta.matchCount, 1);
assert.equal(externalVisual.externalVisualProofArtifact.accepted, true);
assert.equal(externalVisual.externalVisualProofArtifact.externalVisualStateBinding.accepted, true);
assert.equal(externalVisual.externalVisualProofArtifact.externalVisualStateBinding.acceptedForGpuHmr, false);
assert.equal(externalVisual.externalVisualProofArtifact.requiredContentHashes.length, 3);
assert.equal(externalVisual.externalVisualProofArtifact.visualDiff.accepted, true);
assert.equal(externalVisual.deterministicVisualModeEvaluation.accepted, true);

const seedlessExternalVisual = ledger.rows.find(
  (row) => row.targetId === 'forged-external-engine-seedless-visual',
);
assert.equal(seedlessExternalVisual?.matrixOutcome, 'unproven');
assert.equal(seedlessExternalVisual.visual.accepted, true);
assert.equal(seedlessExternalVisual.externalProjectContract.accepted, true);
assert.equal(seedlessExternalVisual.externalProfileSelection.accepted, true);
assert.equal(seedlessExternalVisual.externalSourceDelta.accepted, true);
assert.equal(seedlessExternalVisual.externalVisualProofArtifact.accepted, false);
assert.equal(seedlessExternalVisual.externalVisualProofArtifact.externalVisualStateBinding.accepted, false);
assert.equal(seedlessExternalVisual.externalVisualProofArtifact.deterministicAccepted, false);
assert.equal(seedlessExternalVisual.deterministicVisualModeEvaluation.accepted, false);
assert.ok(seedlessExternalVisual.reasons.includes('seed_policy_unproven'));
assert.ok(seedlessExternalVisual.openGaps.includes('deterministic_visual_mode_not_accepted'));
assert.ok(seedlessExternalVisual.externalVisualProofArtifact.failedGates.includes('seed_policy_unproven'));
assert.ok(seedlessExternalVisual.externalVisualProofArtifact.failedGates.includes('external_visual_state_binding_not_accepted'));
assert.ok(seedlessExternalVisual.externalVisualProofArtifact.failedGates.includes('external_visual_state_seed_hash_missing'));

const forgedExternalVisual = ledger.rows.find((row) => row.targetId === 'forged-external-engine-visual');
assert.equal(forgedExternalVisual?.matrixOutcome, 'unproven');
assert.equal(forgedExternalVisual.backend, 'unknown');
assert.equal(forgedExternalVisual.visual.accepted, false);
assert.equal(forgedExternalVisual.visual.allImagesAreDecodedPng, true);
assert.ok(forgedExternalVisual.visual.failedGates.includes('visual_artifact_declared_hash_missing'));
assert.equal(forgedExternalVisual.externalProjectContract.accepted, false);
assert.equal(forgedExternalVisual.externalProfileSelection.accepted, false);
assert.equal(forgedExternalVisual.externalSourceDelta.accepted, false);
assert.equal(forgedExternalVisual.externalVisualProofArtifact.accepted, false);
assert.ok(forgedExternalVisual.openGaps.includes('external_contract_schema_missing'));
assert.ok(forgedExternalVisual.openGaps.includes('external_profile_selection_schema_missing'));
assert.ok(forgedExternalVisual.openGaps.includes('external_source_delta_schema_missing'));
assert.ok(forgedExternalVisual.openGaps.includes('external_visual_proof_artifact_path_missing'));

const largeRocm = ledger.rows.find((row) =>
  row.proofMode === 'real_rocm_repo_validation'
  && row.targetId === 'real-rocm-large-lib'
);
assert.equal(largeRocm?.targetId, 'real-rocm-large-lib');
assert.equal(largeRocm.backend, 'hip');
assert.equal(largeRocm.matrixOutcome, 'refusal_proven');
assert.equal(largeRocm.acceptedForGpuHmr, false);
assert.equal(largeRocm.gpuHmrSuccess, false);
assert.equal(largeRocm.refusalProven, true);
assert.equal(largeRocm.runtimeProofArtifact.present, false);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.accepted, false);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.deviceCount, 0);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.status, 'gpu-runtime-array-allocation-unavailable');
assert.ok(largeRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes('runtime_device_unavailable'));
assert.ok(largeRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes('runtime_device_count_zero'));
assert.ok(largeRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes(
  'runtime_array_allocation_unavailable',
));
assert.equal(largeRocm.outputOracleResolution.disabledReason, 'profile_disabled');
assert.equal(largeRocm.outputOracleResolution.sourceDerivedCandidateCount, 0);
assert.equal(largeRocm.outputOracleResolution.contractPresent, false);
assert.equal(largeRocm.targetProgression.required, true);
assert.equal(largeRocm.targetProgression.reason, 'phase_not_declared');
assert.equal(largeRocm.targetProgressionGates[0]?.status, 'fail');
assert.equal(largeRocm.realRocmProfileProofObligations.status, 'profile_proof_obligations_unmet');
assert.ok(largeRocm.realRocmProfileProofObligations.blockingGaps.includes(
  'proof_obligation_output_oracle_profile_missing',
));
assert.ok(largeRocm.realRocmProfileProofObligations.blockingGaps.includes(
  'proof_obligation_run_modes_missing',
));
assert.ok(largeRocm.realRocmProfileProofObligations.blockingGaps.includes(
  'proof_obligation_negative_edit_missing',
));
assert.equal(largeRocm.realRocmAppHookContract.status, 'required_app_hook_contract_missing');
assert.equal(largeRocm.realRocmAppHookContract.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmDeviceSidecarContract.status, 'derived_device_sidecar_candidate_not_runtime_proof');
assert.equal(largeRocm.realRocmDeviceSidecarContract.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmSidecarRuntimeConsistency.status, 'sidecar_runtime_backend_consistent_not_runtime_proof');
assert.equal(largeRocm.realRocmSidecarRuntimeConsistency.backendConsistent, true);
assert.equal(largeRocm.realRocmRuntimeStageObligations.status, 'runtime_stage_obligations_unmet');
assert.equal(largeRocm.realRocmRuntimeStageObligations.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmRuntimeStageObligationsGate.present, true);
assert.equal(largeRocm.realRocmRuntimeStageObligationsGate.accepted, false);
assert.ok(largeRocm.realRocmRuntimeStageObligationsGate.failedGates.includes(
  'runtime_stage_obligations_not_accepted',
));
assert.ok(largeRocm.realRocmRuntimeStageObligationsGate.failedGates.includes(
  'runtime_stage_obligation_artifact_transport_changed_artifact_hash_missing',
));
assert.ok(largeRocm.realRocmRuntimeStageObligationsGate.failedGates.includes(
  'runtime_stage_obligation_output_oracle_readback_or_visual_artifact_missing',
));
assert.equal(largeRocm.realRocmAppHookMaterialization.status, 'app_hook_materialization_incomplete');
assert.equal(largeRocm.realRocmAppHookMaterialization.acceptedForGpuHmr, false);
assert.equal(largeRocm.realRocmAppHookMaterialization.gpuHmrSuccess, false);
assert.equal(largeRocm.realRocmAppHookMaterialization.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmAppHookMaterialization.outputOracleMaterialized, false);
assert.equal(largeRocm.realRocmAppHookMaterialization.sidecarCandidateMaterialized, true);
assert.equal(largeRocm.realRocmAppHookMaterializationGate.present, true);
assert.equal(largeRocm.realRocmAppHookMaterializationGate.accepted, true);
assert.equal(largeRocm.realRocmAppHookMaterializationGate.acceptedAsRefusalEvidence, true);
assert.ok(largeRocm.realRocmAppHookMaterialization.blockingGaps.includes(
  'app_hook_materialization_output_oracle_contract_missing',
));
assert.ok(largeRocm.realRocmAppHookMaterialization.blockingGaps.includes(
  'app_hook_materialization_contract_not_declared',
));
assert.equal(largeRocm.realRocmSourceTreeTransport.present, true);
assert.equal(largeRocm.realRocmSourceTreeTransport.accepted, true);
assert.equal(largeRocm.realRocmSourceTreeTransport.acceptedAsTransportEvidence, true);
assert.equal(largeRocm.realRocmSourceTreeTransport.acceptedForGpuHmr, false);
assert.equal(largeRocm.realRocmSourceTreeTransport.gpuHmrSuccess, false);
assert.equal(largeRocm.realRocmSourceTreeTransport.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmSourceTreeTransport.transportKind, 'cas_shared_volume');
assert.equal(largeRocm.realRocmSourceTreeTransport.hotPathOptimized, true);
assert.equal(largeRocm.realRocmSourceTreeTransport.sharedMountCount, 3);
assert.equal(largeRocm.realRocmSourceTreeTransport.sharedStorageAccepted, true);
assert.equal(largeRocm.realRocmSourceTreeTransport.failedGates.length, 0);
assert.equal(largeRocm.attemptCompleteness.sourceTreeTransportPresent, true);
assert.equal(largeRocm.attemptCompleteness.sourceTreeTransportAcceptedAsEvidence, true);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.present, true);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.accepted, true);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.acceptedAsDependencyEvidence, true);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.acceptedForGpuHmr, false);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.gpuHmrSuccess, false);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.prerequisiteCount, 1);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.acceptedDependencyCount, 1);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.prerequisites[0].accepted, true);
assert.equal(largeRocm.realRocmExternalHeaderPrerequisites.failedGates.length, 0);
assert.equal(largeRocm.realRocmProofScheduling.present, true);
assert.equal(largeRocm.realRocmProofScheduling.acceptedAsRefusalEvidence, true);
assert.equal(largeRocm.realRocmProofScheduling.accepted, true);
assert.equal(largeRocm.realRocmProofScheduling.fastFailApplied, true);
assert.equal(largeRocm.realRocmProofScheduling.skipAsyncRuntimeWaits, true);
assert.ok(largeRocm.realRocmProofScheduling.blockingGaps.includes(
  'proof_scheduling_upstream_lifecycle_runtime_absent',
));
assert.equal(largeRocm.realRocmProofScheduling.validationBlockerGates[0].accepted, true);
assert.equal(largeRocm.realRocmProofScheduling.validationBlockerGates[0].acceptedAsRefusalEvidence, true);
assert.equal(largeRocm.realRocmProofScheduling.validationBlockers[0].acceptedForGpuHmr, false);
assert.equal(largeRocm.realRocmProofScheduling.validationBlockers[0].gpuHmrSuccess, false);
assert.equal(largeRocm.attemptCompleteness.proofSchedulingAcceptedAsRefusalEvidence, true);
assert.equal(largeRocm.attemptCompleteness.score, 80);

const missingAppHookMaterializationRocmDir = path.join(
  logsRoot,
  'real-rocm-missing-app-hook-materialization',
);
await writeJson(
  path.join(
    missingAppHookMaterializationRocmDir,
    'real-rocm-missing-app-hook-materialization.json',
  ),
  {
    ...largeRocmLatestReport,
    slug: 'gpu-real-rocm-missing-app-hook-materialization-20260627',
    real_rocm_profile: {
      ...largeRocmLatestReport.real_rocm_profile,
      id: 'real-rocm-missing-app-hook-materialization',
      source: 'scripts/profiles/real-rocm-missing-app-hook-materialization.json',
      proofObligations: {
        targetClass: 'large_rocm_ml_infrastructure',
        requiresAppHookContract: true,
      },
      proof_obligations: {
        target_class: 'large_rocm_ml_infrastructure',
        requires_app_hook_contract: true,
      },
    },
    source_url: 'https://example.invalid/rocm/missing-app-hook-materialization.git',
    target_name: 'MissingAppHookMaterializationDriver',
    real_rocm_profile_proof_obligations: {
      ...largeRocmLatestReport.real_rocm_profile_proof_obligations,
      requiresAppHookContract: true,
      requires_app_hook_contract: true,
    },
    real_rocm_app_hook_materialization: null,
    realRocmAppHookMaterialization: null,
    app_hook_materialization: null,
    appHookMaterialization: null,
  },
);
const missingAppHookMaterializationLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [missingAppHookMaterializationRocmDir],
  generatedAt: '2026-06-27T00:00:00.500Z',
});
const missingAppHookMaterializationRocm = missingAppHookMaterializationLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(missingAppHookMaterializationRocm?.matrixOutcome, 'refusal_proven');
assert.equal(missingAppHookMaterializationRocm.acceptedForGpuHmr, false);
assert.equal(missingAppHookMaterializationRocm.gpuHmrSuccess, false);
assert.equal(
  missingAppHookMaterializationRocm.realRocmProfileProofObligations.requiresAppHookContract,
  true,
);
assert.equal(missingAppHookMaterializationRocm.realRocmAppHookMaterializationGate.present, true);
assert.equal(missingAppHookMaterializationRocm.realRocmAppHookMaterializationGate.required, true);
assert.equal(
  missingAppHookMaterializationRocm.realRocmAppHookMaterializationGate.requiredByProfile,
  true,
);
assert.equal(
  missingAppHookMaterializationRocm.realRocmAppHookMaterializationGate.materializationPresent,
  false,
);
assert.equal(missingAppHookMaterializationRocm.realRocmAppHookMaterializationGate.accepted, false);
assert.ok(missingAppHookMaterializationRocm.realRocmAppHookMaterializationGate.failedGates.includes(
  'real_rocm_app_hook_materialization_missing',
));
assert.ok(missingAppHookMaterializationRocm.realRocmAppHookMaterializationGate.failedGates.includes(
  'app_hook_materialization_required_by_profile_obligation',
));
assert.ok(missingAppHookMaterializationRocm.reasons.includes(
  'real_rocm_app_hook_materialization_not_accepted',
));
assert.ok(missingAppHookMaterializationRocm.openGaps.includes(
  'real_rocm_app_hook_materialization_required',
));
assert.ok(missingAppHookMaterializationRocm.openGaps.includes(
  'real_rocm_app_hook_materialization:real_rocm_app_hook_materialization_missing',
));
const missingAppHookMaterializationCoverage = new Map(
  missingAppHookMaterializationLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
).get('large_real_rocm_repo:real-rocm-missing-app-hook-materialization');
assert.equal(missingAppHookMaterializationCoverage?.appHookMaterialization.required, true);
assert.equal(missingAppHookMaterializationCoverage.appHookMaterialization.proven, false);
assert.equal(
  missingAppHookMaterializationCoverage.appHookMaterialization.status,
  'materialization_missing_or_unproven',
);
assert.ok(missingAppHookMaterializationCoverage.appHookMaterialization.blockingGaps.includes(
  'app_hook_materialization_required_by_profile_obligation',
));

const emptyProofSchedulingRocmDir = path.join(logsRoot, 'real-rocm-empty-proof-scheduling');
await writeJson(path.join(emptyProofSchedulingRocmDir, 'real-rocm-empty-proof-scheduling.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-empty-proof-scheduling-20260627',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-empty-proof-scheduling',
    source: 'scripts/profiles/real-rocm-empty-proof-scheduling.json',
  },
  source_url: 'https://example.invalid/rocm/empty-proof-scheduling.git',
  target_name: 'EmptyProofSchedulingDriver',
  real_rocm_proof_scheduling: null,
  realRocmProofScheduling: null,
  proof_scheduling: null,
  proofScheduling: null,
  timeout_intelligence_failure: null,
  timeoutIntelligenceFailure: null,
  validation_blockers: [],
  validationBlockers: [],
});
const emptyProofSchedulingLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [emptyProofSchedulingRocmDir],
  generatedAt: '2026-06-27T00:00:01.000Z',
});
const emptyProofSchedulingRocm = emptyProofSchedulingLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(emptyProofSchedulingRocm?.matrixOutcome, 'refusal_proven');
assert.equal(emptyProofSchedulingRocm.realRocmProofScheduling.present, false);
assert.equal(emptyProofSchedulingRocm.realRocmProofScheduling.acceptedAsRefusalEvidence, false);
assert.equal(emptyProofSchedulingRocm.realRocmProofScheduling.skipAsyncRuntimeWaits, false);
assert.equal(emptyProofSchedulingRocm.attemptCompleteness.proofSchedulingPresent, false);
assert.equal(emptyProofSchedulingRocm.attemptCompleteness.proofSchedulingAcceptedAsRefusalEvidence, false);
assert.equal(emptyProofSchedulingRocm.reasons.some((reason) =>
  reason.startsWith('real_rocm_proof_scheduling:')
), false);

const forgedTimeoutIntelligence = realRocmProofSchedulingFixture({
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
});
const timeoutIntelligenceOnlyRocmDir = path.join(logsRoot, 'real-rocm-timeout-intelligence-only');
await writeJson(path.join(timeoutIntelligenceOnlyRocmDir, 'real-rocm-timeout-intelligence-only.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-timeout-intelligence-only-20260627',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-timeout-intelligence-only',
    source: 'scripts/profiles/real-rocm-timeout-intelligence-only.json',
  },
  source_url: 'https://example.invalid/rocm/timeout-intelligence-only.git',
  target_name: 'TimeoutIntelligenceOnlyDriver',
  real_rocm_proof_scheduling: null,
  realRocmProofScheduling: null,
  proof_scheduling: null,
  proofScheduling: null,
  timeout_intelligence_failure: forgedTimeoutIntelligence,
  timeoutIntelligenceFailure: forgedTimeoutIntelligence,
  real_rocm_runtime_stage_obligations: realRocmRuntimeStageObligationsFixture(),
});
const timeoutIntelligenceOnlyLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [timeoutIntelligenceOnlyRocmDir],
  generatedAt: '2026-06-27T00:00:02.000Z',
});
const timeoutIntelligenceRocm = timeoutIntelligenceOnlyLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(timeoutIntelligenceRocm?.acceptedForGpuHmr, false);
assert.equal(timeoutIntelligenceRocm.gpuHmrSuccess, false);
assert.equal(timeoutIntelligenceRocm.realRocmProofScheduling.present, true);
assert.equal(timeoutIntelligenceRocm.realRocmProofScheduling.acceptedAsRefusalEvidence, true);
assert.equal(timeoutIntelligenceRocm.realRocmProofScheduling.accepted, false);
assert.equal(timeoutIntelligenceRocm.timeoutIntelligenceFailure.fastFailApplied, true);
assert.ok(timeoutIntelligenceRocm.realRocmProofScheduling.failedGates.includes(
  'real_rocm_proof_scheduling_claimed_gpu_hmr_acceptance',
));
assert.ok(timeoutIntelligenceRocm.realRocmProofScheduling.failedGates.includes(
  'real_rocm_proof_scheduling_claimed_gpu_hmr_success',
));
assert.ok(timeoutIntelligenceRocm.realRocmProofScheduling.failedGates.includes(
  'real_rocm_proof_scheduling_claimed_runtime_authority',
));
assert.deepEqual(timeoutIntelligenceRocm.realRocmRuntimeStageObligationsGate.missingStages, [
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
]);
assert.ok(timeoutIntelligenceRocm.reasons.includes('real_rocm_runtime_stage_obligations_not_met'));
assert.ok(timeoutIntelligenceRocm.openGaps.includes('real_rocm_runtime_stage_obligations_required'));

const forgedSourceTreeTransport = realRocmSourceTreeTransportFixture(
  'real-rocm-forged-source-tree-transport',
  {
    acceptedForGpuHmr: true,
    accepted_for_gpu_hmr: true,
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
  },
);
const forgedSourceTreeTransportDir = path.join(logsRoot, 'real-rocm-forged-source-tree-transport');
await writeJson(path.join(forgedSourceTreeTransportDir, 'real-rocm-forged-source-tree-transport.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-forged-source-tree-transport-20260627',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-forged-source-tree-transport',
    source: 'scripts/profiles/real-rocm-forged-source-tree-transport.json',
  },
  source_url: 'https://example.invalid/rocm/forged-source-tree-transport.git',
  target_name: 'ForgedSourceTreeTransportDriver',
  real_rocm_source_tree_transport: forgedSourceTreeTransport,
  realRocmSourceTreeTransport: forgedSourceTreeTransport,
  source_tree_transport: forgedSourceTreeTransport,
  sourceTreeTransport: forgedSourceTreeTransport,
});
const forgedSourceTreeTransportLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedSourceTreeTransportDir],
  generatedAt: '2026-06-27T00:00:02.500Z',
});
const forgedSourceTreeTransportRocm = forgedSourceTreeTransportLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedSourceTreeTransportRocm?.acceptedForGpuHmr, false);
assert.equal(forgedSourceTreeTransportRocm.gpuHmrSuccess, false);
assert.equal(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.present, true);
assert.equal(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.accepted, false);
assert.equal(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.acceptedForGpuHmr, false);
assert.equal(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.gpuHmrSuccess, false);
assert.ok(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.failedGates.includes(
  'real_rocm_source_tree_transport_claimed_gpu_hmr_acceptance',
));
assert.ok(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.failedGates.includes(
  'real_rocm_source_tree_transport_claimed_gpu_hmr_success',
));
assert.ok(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.failedGates.includes(
  'real_rocm_source_tree_transport_claimed_runtime_authority',
));
assert.ok(forgedSourceTreeTransportRocm.realRocmSourceTreeTransport.failedGates.includes(
  'real_rocm_source_tree_transport_claimed_dispatch_authority',
));
assert.equal(forgedSourceTreeTransportRocm.attemptCompleteness.sourceTreeTransportPresent, true);
assert.equal(forgedSourceTreeTransportRocm.attemptCompleteness.sourceTreeTransportAcceptedAsEvidence, false);

const forgedExternalHeaderPrerequisites = realRocmExternalHeaderPrerequisitesFixture(
  'real-rocm-forged-external-header-prerequisites',
  {
    acceptedForGpuHmr: true,
    accepted_for_gpu_hmr: true,
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    prerequisiteOverrides: {
      acceptedForGpuHmr: true,
      accepted_for_gpu_hmr: true,
      gpuHmrSuccess: true,
      gpu_hmr_success: true,
      canSatisfyRuntimeProof: true,
      can_satisfy_runtime_proof: true,
      canSatisfyDispatchProof: true,
      can_satisfy_dispatch_proof: true,
    },
  },
);
const forgedExternalHeaderPrerequisitesDir = path.join(
  logsRoot,
  'real-rocm-forged-external-header-prerequisites',
);
await writeJson(
  path.join(
    forgedExternalHeaderPrerequisitesDir,
    'real-rocm-forged-external-header-prerequisites.json',
  ),
  {
    ...largeRocmLatestReport,
    slug: 'gpu-real-rocm-forged-external-header-prerequisites-20260628',
    real_rocm_profile: {
      ...largeRocmLatestReport.real_rocm_profile,
      id: 'real-rocm-forged-external-header-prerequisites',
      source: 'scripts/profiles/real-rocm-forged-external-header-prerequisites.json',
    },
    source_url: 'https://example.invalid/rocm/forged-external-header-prerequisites.git',
    target_name: 'ForgedExternalHeaderPrerequisitesDriver',
    real_rocm_external_header_prerequisites: forgedExternalHeaderPrerequisites,
    realRocmExternalHeaderPrerequisites: forgedExternalHeaderPrerequisites,
    external_header_prerequisites: forgedExternalHeaderPrerequisites,
    externalHeaderPrerequisites: forgedExternalHeaderPrerequisites,
  },
);
const forgedExternalHeaderPrerequisitesLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedExternalHeaderPrerequisitesDir],
  generatedAt: '2026-06-27T00:00:02.650Z',
});
const forgedExternalHeaderPrerequisitesRocm = forgedExternalHeaderPrerequisitesLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedExternalHeaderPrerequisitesRocm?.acceptedForGpuHmr, false);
assert.equal(forgedExternalHeaderPrerequisitesRocm.gpuHmrSuccess, false);
assert.equal(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.present, true);
assert.equal(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.accepted, false);
assert.equal(
  forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.acceptedForGpuHmr,
  false,
);
assert.equal(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.gpuHmrSuccess, false);
assert.equal(
  forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.canSatisfyRuntimeProof,
  false,
);
assert.ok(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.failedGates.includes(
  'real_rocm_external_header_prerequisites_claimed_gpu_hmr_acceptance',
));
assert.ok(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.failedGates.includes(
  'real_rocm_external_header_prerequisites_claimed_gpu_hmr_success',
));
assert.ok(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.failedGates.includes(
  'real_rocm_external_header_prerequisites_claimed_runtime_authority',
));
assert.ok(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.failedGates.includes(
  'real_rocm_external_header_prerequisites_claimed_dispatch_authority',
));
assert.ok(forgedExternalHeaderPrerequisitesRocm.realRocmExternalHeaderPrerequisites.failedGates.some(
  (gate) => gate.includes('real_rocm_external_header_prerequisite_claimed_gpu_hmr_acceptance'),
));

const missingDependencyProbe = realRocmMissingDependencyProbeFixture();
const missingDependencyProbeDir = path.join(logsRoot, 'real-rocm-missing-dependency-probe');
await writeJson(path.join(missingDependencyProbeDir, 'real-rocm-missing-dependency-probe.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-missing-dependency-probe-20260628',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-missing-dependency-probe',
    source: 'scripts/profiles/real-rocm-missing-dependency-probe.json',
  },
  upstream_lifecycle_failure: {
    schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    schema_version: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    reasons: ['upstream_build_failed', 'missing_build_dependency'],
    missingDependencies: ['half/half.hpp'],
    missing_dependencies: ['half/half.hpp'],
  },
  real_rocm_missing_dependency_probe: missingDependencyProbe,
  realRocmMissingDependencyProbe: missingDependencyProbe,
  missing_dependency_probe: missingDependencyProbe,
  missingDependencyProbe,
});
const missingDependencyProbeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [missingDependencyProbeDir],
  generatedAt: '2026-06-27T00:00:02.750Z',
});
const missingDependencyProbeRocm = missingDependencyProbeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(missingDependencyProbeRocm?.acceptedForGpuHmr, false);
assert.equal(missingDependencyProbeRocm.gpuHmrSuccess, false);
assert.equal(missingDependencyProbeRocm.realRocmMissingDependencyProbe.present, true);
assert.equal(missingDependencyProbeRocm.realRocmMissingDependencyProbe.accepted, true);
assert.ok(missingDependencyProbeRocm.reasons.includes(
  'real_rocm_missing_dependency_probe:missing_dependency_refusal_evidence',
));
assert.ok(missingDependencyProbeRocm.openGaps.includes(
  'real_rocm_missing_dependency_probe_required_absent',
));
assert.ok(missingDependencyProbeRocm.openGaps.includes(
  'real_rocm_missing_dependency_probe:missing_header:half_half.hpp',
));

const lifecycleRecomputeDir = path.join(logsRoot, 'real-rocm-lifecycle-recompute');
await writeJson(path.join(lifecycleRecomputeDir, 'real-rocm-lifecycle-recompute.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-lifecycle-recompute-20260630',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-lifecycle-recompute',
    source: 'scripts/profiles/real-rocm-lifecycle-recompute.json',
  },
  upstream_lifecycle_failure: {
    schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    schema_version: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    reasons: [
      'cmake_configure_failed',
      'upstream_build_blocked_by_configure',
      'upstream_run_not_started_after_configure_failure',
      'upstream_lifecycle_command_failed',
    ],
    cmakeConfigureFailed: true,
    cmake_configure_failed: true,
    configureExitCodeText: 'unknown',
    configure_exit_code_text: 'unknown',
    buildFailed: false,
    build_failed: false,
    buildBlockedByConfigure: true,
    build_blocked_by_configure: true,
    buildExitCodeText: 'unknown',
    build_exit_code_text: 'unknown',
    runBlockedByConfigure: true,
    run_blocked_by_configure: true,
    runExitCodeText: 'not-run',
    run_exit_code_text: 'not-run',
    timings: [
      'configure_ms=failed',
      'build_ms=failed',
      'run_ms=skipped',
      'configure_exit_code=unknown',
      'build_exit_code=unknown',
      'run_exit_code=not-run',
    ].join('\n'),
    configureLogTail: '-- The C compiler identification is Clang\n-- Generic project option OFF',
    configure_log_tail: '-- The C compiler identification is Clang\n-- Generic project option OFF',
    buildLogTail: '[ 38%] Building CXX object src/CMakeFiles/lib.dir/kernel.cpp.o\nTerminated\ngmake: *** [Makefile:6677: target] Terminated',
    build_log_tail: '[ 38%] Building CXX object src/CMakeFiles/lib.dir/kernel.cpp.o\nTerminated\ngmake: *** [Makefile:6677: target] Terminated',
    runLogTail: 'upstream run skipped after configure_status=0 post_configure_status=0 build_status=143',
    run_log_tail: 'upstream run skipped after configure_status=0 post_configure_status=0 build_status=143',
  },
});
const lifecycleRecomputeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [lifecycleRecomputeDir],
  generatedAt: '2026-06-30T00:00:03.050Z',
});
const lifecycleRecomputeRocm = lifecycleRecomputeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(lifecycleRecomputeRocm?.acceptedForGpuHmr, false);
assert.equal(lifecycleRecomputeRocm.gpuHmrSuccess, false);
assert.equal(lifecycleRecomputeRocm.upstreamLifecycleFailure.matrixRecomputedFromLogTails, true);
assert.equal(lifecycleRecomputeRocm.upstreamLifecycleFailure.cmakeConfigureFailed, false);
assert.equal(lifecycleRecomputeRocm.upstreamLifecycleFailure.configureExitCodeText, '0');
assert.equal(lifecycleRecomputeRocm.upstreamLifecycleFailure.buildExitCodeText, '143');
assert.equal(lifecycleRecomputeRocm.upstreamLifecycleFailure.buildFailed, true);
assert.equal(lifecycleRecomputeRocm.upstreamLifecycleFailure.runBlockedByBuild, true);
assert.ok(!lifecycleRecomputeRocm.upstreamLifecycleFailure.reasons.includes('cmake_configure_failed'));
assert.ok(lifecycleRecomputeRocm.upstreamLifecycleFailure.reasons.includes('upstream_build_failed'));
assert.ok(lifecycleRecomputeRocm.upstreamLifecycleFailure.reasons.includes(
  'upstream_run_not_started_after_build_failure',
));

const lifecycleStatusSpoofDir = path.join(logsRoot, 'real-rocm-lifecycle-status-spoof');
await writeJson(path.join(lifecycleStatusSpoofDir, 'real-rocm-lifecycle-status-spoof.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-lifecycle-status-spoof-20260630',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-lifecycle-status-spoof',
    source: 'scripts/profiles/real-rocm-lifecycle-status-spoof.json',
  },
  upstream_lifecycle_failure: {
    schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    schema_version: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    reasons: ['upstream_build_failed'],
    timings: [
      'configure_ms=failed',
      'build_ms=failed',
      'run_ms=skipped',
      'configure_exit_code=unknown',
      'build_exit_code=unknown',
      'run_exit_code=not-run',
    ].join('\n'),
    configureLogTail: 'project log: configure_status=0\nConfiguring incomplete, errors occurred!',
    configure_log_tail: 'project log: configure_status=0\nConfiguring incomplete, errors occurred!',
    buildLogTail: 'project log: build_status=0',
    build_log_tail: 'project log: build_status=0',
    runLogTail: 'project log: run_status=0',
    run_log_tail: 'project log: run_status=0',
  },
});
const lifecycleStatusSpoofLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [lifecycleStatusSpoofDir],
  generatedAt: '2026-06-30T00:00:03.075Z',
});
const lifecycleStatusSpoofRocm = lifecycleStatusSpoofLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(lifecycleStatusSpoofRocm?.acceptedForGpuHmr, false);
assert.equal(lifecycleStatusSpoofRocm.gpuHmrSuccess, false);
assert.equal(lifecycleStatusSpoofRocm.upstreamLifecycleFailure.matrixRecomputedFromLogTails, true);
assert.equal(lifecycleStatusSpoofRocm.upstreamLifecycleFailure.configureExitCodeText, null);
assert.equal(lifecycleStatusSpoofRocm.upstreamLifecycleFailure.buildExitCodeText, null);
assert.equal(lifecycleStatusSpoofRocm.upstreamLifecycleFailure.cmakeConfigureFailed, true);
assert.ok(lifecycleStatusSpoofRocm.upstreamLifecycleFailure.reasons.includes('cmake_configure_failed'));

const forgedMissingDependencyProbe = realRocmMissingDependencyProbeFixture({
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
});
const forgedMissingDependencyProbeDir = path.join(logsRoot, 'real-rocm-forged-missing-dependency-probe');
await writeJson(
  path.join(forgedMissingDependencyProbeDir, 'real-rocm-forged-missing-dependency-probe.json'),
  {
    ...largeRocmLatestReport,
    slug: 'gpu-real-rocm-forged-missing-dependency-probe-20260628',
    real_rocm_profile: {
      ...largeRocmLatestReport.real_rocm_profile,
      id: 'real-rocm-forged-missing-dependency-probe',
      source: 'scripts/profiles/real-rocm-forged-missing-dependency-probe.json',
    },
    upstream_lifecycle_failure: {
      schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
      schema_version: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
      acceptedAsRefusalEvidence: true,
      accepted_as_refusal_evidence: true,
      reasons: ['upstream_build_failed', 'missing_build_dependency'],
      missingDependencies: ['half/half.hpp'],
      missing_dependencies: ['half/half.hpp'],
    },
    real_rocm_missing_dependency_probe: forgedMissingDependencyProbe,
    realRocmMissingDependencyProbe: forgedMissingDependencyProbe,
    missing_dependency_probe: forgedMissingDependencyProbe,
    missingDependencyProbe: forgedMissingDependencyProbe,
  },
);
const forgedMissingDependencyProbeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingDependencyProbeDir],
  generatedAt: '2026-06-27T00:00:02.900Z',
});
const forgedMissingDependencyProbeRocm = forgedMissingDependencyProbeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingDependencyProbeRocm?.acceptedForGpuHmr, false);
assert.equal(forgedMissingDependencyProbeRocm.gpuHmrSuccess, false);
assert.equal(forgedMissingDependencyProbeRocm.realRocmMissingDependencyProbe.accepted, false);
assert.ok(forgedMissingDependencyProbeRocm.realRocmMissingDependencyProbe.failedGates.includes(
  'real_rocm_missing_dependency_probe_claimed_gpu_hmr_acceptance',
));
assert.ok(forgedMissingDependencyProbeRocm.realRocmMissingDependencyProbe.failedGates.includes(
  'real_rocm_missing_dependency_probe_claimed_gpu_hmr_success',
));
assert.ok(forgedMissingDependencyProbeRocm.realRocmMissingDependencyProbe.failedGates.includes(
  'real_rocm_missing_dependency_probe_claimed_runtime_authority',
));

const forgedAppHookMaterialization = realRocmAppHookMaterializationFixture({
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
  canSatisfyDispatchProof: true,
  can_satisfy_dispatch_proof: true,
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
});
const forgedAppHookMaterializationDir = path.join(logsRoot, 'real-rocm-forged-app-hook-materialization');
await writeJson(path.join(forgedAppHookMaterializationDir, 'real-rocm-forged-app-hook-materialization.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-forged-app-hook-materialization-20260627',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-forged-app-hook-materialization',
    source: 'scripts/profiles/real-rocm-forged-app-hook-materialization.json',
  },
  source_url: 'https://example.invalid/rocm/forged-app-hook-materialization.git',
  target_name: 'ForgedAppHookMaterializationDriver',
  real_rocm_app_hook_materialization: forgedAppHookMaterialization,
  realRocmAppHookMaterialization: forgedAppHookMaterialization,
  app_hook_materialization: forgedAppHookMaterialization,
  appHookMaterialization: forgedAppHookMaterialization,
});
const forgedAppHookMaterializationLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedAppHookMaterializationDir],
  generatedAt: '2026-06-27T00:00:03.000Z',
});
const forgedAppHookMaterializationRocm = forgedAppHookMaterializationLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedAppHookMaterializationRocm?.acceptedForGpuHmr, false);
assert.equal(forgedAppHookMaterializationRocm.gpuHmrSuccess, false);
assert.equal(forgedAppHookMaterializationRocm.realRocmAppHookMaterializationGate.accepted, false);
assert.ok(forgedAppHookMaterializationRocm.realRocmAppHookMaterializationGate.failedGates.includes(
  'real_rocm_app_hook_materialization_authority_unknown',
));
assert.ok(forgedAppHookMaterializationRocm.realRocmAppHookMaterializationGate.failedGates.includes(
  'real_rocm_app_hook_materialization_claimed_gpu_hmr_acceptance',
));
assert.ok(forgedAppHookMaterializationRocm.realRocmAppHookMaterializationGate.failedGates.includes(
  'real_rocm_app_hook_materialization_claimed_gpu_hmr_success',
));
assert.ok(forgedAppHookMaterializationRocm.realRocmAppHookMaterializationGate.failedGates.includes(
  'real_rocm_app_hook_materialization_claimed_runtime_authority',
));
assert.ok(forgedAppHookMaterializationRocm.realRocmAppHookMaterializationGate.failedGates.includes(
  'real_rocm_app_hook_materialization_claimed_dispatch_authority',
));
assert.ok(forgedAppHookMaterializationRocm.reasons.includes(
  'real_rocm_app_hook_materialization_not_accepted',
));
assert.ok(forgedAppHookMaterializationRocm.openGaps.includes(
  'real_rocm_app_hook_materialization_required',
));

const importedRuntimeProfileAdapterBoundary = runtimeAdapterBoundaryBridgeFixture(
  'runtime-profile-adapter-result',
  {},
);
const importedRuntimeProfileAdapterResult = {
  schemaVersion: 'synthi.real_rocm.runtime_profile_adapter_result_bridge.v1',
  schema_version: 'synthi.real_rocm.runtime_profile_adapter_result_bridge.v1',
  proofAuthority: 'declared_adapter_result_import_not_runtime_authority',
  proof_authority: 'declared_adapter_result_import_not_runtime_authority',
  status: 'runtime_profile_adapter_result_imported',
  declared: true,
  present: true,
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
  canSatisfyRuntimeProof: false,
  can_satisfy_runtime_proof: false,
  canSatisfyDispatchProof: false,
  can_satisfy_dispatch_proof: false,
  strictRuntimeProofAccepted: true,
  strict_runtime_proof_accepted: true,
  strictRuntimeProofGateAccepted: true,
  strict_runtime_proof_gate_accepted: true,
  strictRuntimeProofGate: {
    status: 'pass',
    accepted: true,
    failures: [],
  },
  strict_runtime_proof_gate: {
    status: 'pass',
    accepted: true,
    failures: [],
  },
  strictRuntimeProofArtifactPresent: true,
  strict_runtime_proof_artifact_present: true,
  strictRuntimeProofId: `gpu-runtime-proof:sha256:${'a'.repeat(64)}`,
  strict_runtime_proof_id: `gpu-runtime-proof:sha256:${'a'.repeat(64)}`,
  proofLedgerPresent: true,
  proof_ledger_present: true,
  proofLedgerId: `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
  proof_ledger_id: `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
  adapterResultHash: `sha256:${'c'.repeat(64)}`,
  adapter_result_hash: `sha256:${'c'.repeat(64)}`,
  adapterRuntimeBoundaryLines:
    importedRuntimeProfileAdapterBoundary.adapterRuntimeBoundaryLines,
  adapter_runtime_boundary_lines:
    importedRuntimeProfileAdapterBoundary.adapterRuntimeBoundaryLines,
  blockingGaps: [],
  blocking_gaps: [],
  evidenceRefs: [
    `sha256:${'c'.repeat(64)}`,
    `gpu-runtime-proof:sha256:${'a'.repeat(64)}`,
    `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
    ...importedRuntimeProfileAdapterBoundary.adapterRuntimeBoundaryLines.map((line) =>
      `runtime-profile-adapter-boundary:${hashValue(line)}`
    ),
  ],
  evidence_refs: [
    `sha256:${'c'.repeat(64)}`,
    `gpu-runtime-proof:sha256:${'a'.repeat(64)}`,
    `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
    ...importedRuntimeProfileAdapterBoundary.adapterRuntimeBoundaryLines.map((line) =>
      `runtime-profile-adapter-boundary:${hashValue(line)}`
    ),
  ],
};
const runtimeProfileAdapterResultDir = path.join(logsRoot, 'real-rocm-runtime-profile-adapter-result');
await writeJson(path.join(runtimeProfileAdapterResultDir, 'real-rocm-runtime-profile-adapter-result.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-runtime-profile-adapter-result-20260629',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-runtime-profile-adapter-result',
    source: 'scripts/profiles/real-rocm-runtime-profile-adapter-result.json',
  },
  source_url: 'https://example.invalid/rocm/runtime-profile-adapter-result.git',
  target_name: 'RuntimeProfileAdapterResultDriver',
  real_rocm_runtime_profile_adapter_result: importedRuntimeProfileAdapterResult,
  realRocmRuntimeProfileAdapterResult: importedRuntimeProfileAdapterResult,
  runtime_profile_adapter_result: importedRuntimeProfileAdapterResult,
  runtimeProfileAdapterResult: importedRuntimeProfileAdapterResult,
});
const runtimeProfileAdapterResultLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [runtimeProfileAdapterResultDir],
  generatedAt: '2026-06-27T00:00:03.100Z',
});
const runtimeProfileAdapterResultRocm = runtimeProfileAdapterResultLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(runtimeProfileAdapterResultRocm?.acceptedForGpuHmr, false);
assert.equal(runtimeProfileAdapterResultRocm.gpuHmrSuccess, false);
assert.equal(runtimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.accepted, true);
assert.equal(runtimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.acceptedForGpuHmr, false);
assert.equal(runtimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.canSatisfyRuntimeProof, false);
assert.ok(runtimeProfileAdapterResultRocm.reasons.includes(
  'real_rocm_runtime_profile_adapter_result:runtime_profile_adapter_result_imported',
));

const {
  strictRuntimeProofGateAccepted: _runtimeProfileAdapterResultGateAccepted,
  strict_runtime_proof_gate_accepted: _runtimeProfileAdapterResultGateAcceptedSnake,
  strictRuntimeProofGate: _runtimeProfileAdapterResultGate,
  strict_runtime_proof_gate: _runtimeProfileAdapterResultGateSnake,
  ...nakedStrictRuntimeProfileAdapterResult
} = importedRuntimeProfileAdapterResult;
const nakedStrictRuntimeProfileAdapterResultDir = path.join(
  logsRoot,
  'real-rocm-naked-strict-runtime-profile-adapter-result',
);
await writeJson(
  path.join(
    nakedStrictRuntimeProfileAdapterResultDir,
    'real-rocm-naked-strict-runtime-profile-adapter-result.json',
  ),
  {
    ...largeRocmLatestReport,
    slug: 'gpu-real-rocm-naked-strict-runtime-profile-adapter-result-20260630',
    real_rocm_profile: {
      ...largeRocmLatestReport.real_rocm_profile,
      id: 'real-rocm-naked-strict-runtime-profile-adapter-result',
      source: 'scripts/profiles/real-rocm-naked-strict-runtime-profile-adapter-result.json',
    },
    source_url: 'https://example.invalid/rocm/naked-strict-runtime-profile-adapter-result.git',
    target_name: 'NakedStrictRuntimeProfileAdapterResultDriver',
    real_rocm_runtime_profile_adapter_result: nakedStrictRuntimeProfileAdapterResult,
    realRocmRuntimeProfileAdapterResult: nakedStrictRuntimeProfileAdapterResult,
    runtime_profile_adapter_result: nakedStrictRuntimeProfileAdapterResult,
    runtimeProfileAdapterResult: nakedStrictRuntimeProfileAdapterResult,
  },
);
const nakedStrictRuntimeProfileAdapterResultLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [nakedStrictRuntimeProfileAdapterResultDir],
  generatedAt: '2026-06-30T00:00:03.150Z',
});
const nakedStrictRuntimeProfileAdapterResultRocm =
  nakedStrictRuntimeProfileAdapterResultLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(nakedStrictRuntimeProfileAdapterResultRocm?.acceptedForGpuHmr, false);
assert.equal(nakedStrictRuntimeProfileAdapterResultRocm.gpuHmrSuccess, false);
assert.equal(
  nakedStrictRuntimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.accepted,
  false,
);
assert.ok(
  nakedStrictRuntimeProfileAdapterResultRocm
    .realRocmRuntimeProfileAdapterResult
    .failedGates
    .includes('real_rocm_runtime_profile_adapter_result_strict_gate_not_accepted'),
);
assert.ok(
  nakedStrictRuntimeProfileAdapterResultRocm
    .realRocmRuntimeProfileAdapterResult
    .failedGates
    .includes('real_rocm_runtime_profile_adapter_result_imported_without_strict_proof'),
);
assert.ok(nakedStrictRuntimeProfileAdapterResultRocm.reasons.includes(
  'real_rocm_runtime_profile_adapter_result_not_accepted',
));

const forgedRuntimeProfileAdapterResult = {
  ...importedRuntimeProfileAdapterResult,
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
  canSatisfyDispatchProof: true,
  can_satisfy_dispatch_proof: true,
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
};
const forgedRuntimeProfileAdapterResultDir = path.join(
  logsRoot,
  'real-rocm-forged-runtime-profile-adapter-result',
);
await writeJson(
  path.join(forgedRuntimeProfileAdapterResultDir, 'real-rocm-forged-runtime-profile-adapter-result.json'),
  {
    ...largeRocmLatestReport,
    slug: 'gpu-real-rocm-forged-runtime-profile-adapter-result-20260629',
    real_rocm_profile: {
      ...largeRocmLatestReport.real_rocm_profile,
      id: 'real-rocm-forged-runtime-profile-adapter-result',
      source: 'scripts/profiles/real-rocm-forged-runtime-profile-adapter-result.json',
    },
    source_url: 'https://example.invalid/rocm/forged-runtime-profile-adapter-result.git',
    target_name: 'ForgedRuntimeProfileAdapterResultDriver',
    real_rocm_runtime_profile_adapter_result: forgedRuntimeProfileAdapterResult,
    realRocmRuntimeProfileAdapterResult: forgedRuntimeProfileAdapterResult,
    runtime_profile_adapter_result: forgedRuntimeProfileAdapterResult,
    runtimeProfileAdapterResult: forgedRuntimeProfileAdapterResult,
  },
);
const forgedRuntimeProfileAdapterResultLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRuntimeProfileAdapterResultDir],
  generatedAt: '2026-06-27T00:00:03.200Z',
});
const forgedRuntimeProfileAdapterResultRocm = forgedRuntimeProfileAdapterResultLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedRuntimeProfileAdapterResultRocm?.acceptedForGpuHmr, false);
assert.equal(forgedRuntimeProfileAdapterResultRocm.gpuHmrSuccess, false);
assert.equal(forgedRuntimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.accepted, false);
assert.ok(forgedRuntimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.failedGates.includes(
  'real_rocm_runtime_profile_adapter_result_authority_unknown',
));
assert.ok(forgedRuntimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.failedGates.includes(
  'real_rocm_runtime_profile_adapter_result_claimed_gpu_hmr_acceptance',
));
assert.ok(forgedRuntimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.failedGates.includes(
  'real_rocm_runtime_profile_adapter_result_claimed_gpu_hmr_success',
));
assert.ok(forgedRuntimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.failedGates.includes(
  'real_rocm_runtime_profile_adapter_result_claimed_runtime_authority',
));
assert.ok(forgedRuntimeProfileAdapterResultRocm.realRocmRuntimeProfileAdapterResult.failedGates.includes(
  'real_rocm_runtime_profile_adapter_result_claimed_dispatch_authority',
));
assert.ok(forgedRuntimeProfileAdapterResultRocm.reasons.includes(
  'real_rocm_runtime_profile_adapter_result_not_accepted',
));
assert.ok(forgedRuntimeProfileAdapterResultRocm.openGaps.includes(
  'real_rocm_runtime_profile_adapter_result_required',
));

assert.ok(largeRocm.reasons.includes('runtime_proof_artifact_missing'));
assert.ok(largeRocm.reasons.includes('proof_state_missing'));
assert.ok(largeRocm.reasons.includes('output_or_visual_oracle_proof_missing'));
assert.ok(largeRocm.reasons.includes('target_progression_gate_failed:target progression phase'));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_output_oracle_profile_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_run_modes_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_missing',
));
assert.ok(largeRocm.reasons.includes('real_rocm_app_hook_contract:app_hook_contract_not_declared'));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_device_sidecar_contract:derived_device_sidecar_candidate_not_runtime_proof',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_sidecar_observation_missing',
));
assert.ok(largeRocm.reasons.includes('real_rocm_runtime_stage_obligations_not_met'));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_runtime_stage_obligations:runtime_stage_obligation_artifact_transport_changed_artifact_hash_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_runtime_stage_obligations:runtime_stage_obligation_output_oracle_readback_or_visual_artifact_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_app_hook_materialization:app_hook_materialization_incomplete',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_app_hook_materialization:app_hook_materialization_output_oracle_contract_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_proof_scheduling:fast_fail_wait_budget_applied',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_proof_scheduling:proof_scheduling_app_hook_contract_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_runtime_capability_preflight:gpu-runtime-array-allocation-unavailable',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_runtime_capability_preflight:runtime_device_unavailable',
));
assert.ok(largeRocm.openGaps.includes('output_or_visual_oracle_proof_required'));
assert.ok(largeRocm.openGaps.includes('target_progression_gates_failed'));
assert.ok(largeRocm.openGaps.includes('real_rocm_runtime_capability_preflight_failed'));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_runtime_capability_preflight:runtime_device_unavailable',
));
assert.ok(largeRocm.openGaps.includes('real_rocm_profile_proof_obligations_required'));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_output_oracle_profile_missing',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_run_modes_missing',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_missing',
));
assert.equal(largeRocm.cpuHmrUsed, null);
assert.equal(largeRocm.fullRebuildUsed, null);
assert.equal(largeRocm.processRestarted, null);
assert.equal(largeRocm.realRocmFirewall.accepted, false);
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall:cpu_hmr_absence_evidence_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall:full_rebuild_absence_evidence_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall:process_restart_absence_evidence_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_app_hook_contract:app_hook_artifact_transport_evidence_missing'));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_device_sidecar_contract:device_sidecar_dispatch_trace_runtime_not_observed',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_sidecar_observation_missing',
));
assert.ok(largeRocm.openGaps.includes('real_rocm_runtime_stage_obligations_required'));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_runtime_stage_obligations:runtime_stage_obligation_dispatch_trace_dispatch_epoch_missing',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_app_hook_materialization:app_hook_materialization_contract_not_declared',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_app_hook_materialization:app_hook_materialization_output_oracle_contract_missing',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_proof_scheduling:proof_scheduling_output_oracle_disabled',
));
const retainedRealRocmRows = ledger.rows.filter((row) => row.proofMode === 'real_rocm_repo_validation');
assert.equal(
  retainedRealRocmRows.filter((row) => row.targetId === 'real-rocm-large-lib').length,
  1,
  'latest alias plus retained real ROCm report must not double-count one target',
);
const retainedSecondRocm = retainedRealRocmRows.find((row) => row.targetId === 'real-rocm-second-lib');
assert.equal(retainedSecondRocm?.matrixOutcome, 'refusal_proven');
assert.equal(retainedSecondRocm.backend, 'hip');
assert.equal(retainedSecondRocm.proofChain, 'real_rocm_strict_runtime_refusal');

const originalHostPreflightRocm = ledger.rows.find((row) =>
  row.proofMode === 'real_rocm_repo_validation'
  && row.targetId === 'real-rocm-original-host-preflight'
);
assert.equal(originalHostPreflightRocm?.matrixOutcome, 'unproven');
assert.equal(originalHostPreflightRocm.acceptedForGpuHmr, false);
assert.equal(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.accepted, false);
assert.equal(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.allocationAvailable, false);
assert.ok(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes(
  'runtime_device_unavailable',
));
assert.ok(originalHostPreflightRocm.openGaps.includes('real_rocm_runtime_capability_preflight_failed'));
assert.ok(originalHostPreflightRocm.reasons.includes(
  'real_rocm_runtime_capability_preflight:gpu-runtime-array-allocation-unavailable',
));

const requiredProgressionRocmDir = path.join(logsRoot, 'real-rocm-required-progression-runtime');
await writeJson(path.join(requiredProgressionRocmDir, 'real-rocm-required-progression-runtime.json'), {
  slug: 'gpu-real-rocm-required-progression-runtime-20260623',
  real_rocm_profile: { id: 'real-rocm-required-progression-runtime' },
  source_url: 'https://example.invalid/rocm/required-progression.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/required_progression.hip',
  delta_file: 'src/kernels/required_progression.hip',
  target_name: 'RequiredProgressionDriver',
  gpu_vendor: 'rocm',
  full_runtime_proven: false,
  gpu_hmr_success: false,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'none',
    mode: 'none',
    disabledReason: 'profile_disabled',
    contractPresent: false,
    runtimeProfilePresent: false,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  strict_proof_gates: {
    schemaVersion: 'synthi.gpu_hmr.strict_proof_gates.v1',
    status: 'fail',
    accepted: false,
    failures: ['runtime_proof_artifact_missing'],
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/required-progression.git @ 0123456789ab files=2000' },
    {
      name: 'real_repo_user_source_delta_hmr',
      status: 'warn',
      detail: JSON.stringify({
        wait_hmr_status: 'timeout',
        gpu_proof_validation: { reason: 'proof_state_missing', satisfied: false },
      }),
    },
  ],
});
const requiredProgressionLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [requiredProgressionRocmDir],
  generatedAt: '2026-06-09T00:00:01.100Z',
  includeUnproven: true,
});
const requiredProgressionRow = requiredProgressionLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(requiredProgressionRow?.matrixOutcome, 'refusal_proven');
assert.equal(requiredProgressionRow.acceptedForGpuHmr, false);
assert.equal(requiredProgressionRow.refusalProven, true);
assert.ok(requiredProgressionRow.openGaps.includes('strict_runtime_proof_artifact_required'));

const truncatedVisual = ledger.rows.find((row) => row.targetId === 'truncated-visual');
assert.equal(truncatedVisual?.matrixOutcome, 'unproven');
assert.equal(truncatedVisual.acceptedForGpuHmr, false);
assert.equal(truncatedVisual.visual.present, true);
assert.equal(truncatedVisual.visual.allImagesArePng, true);
assert.equal(truncatedVisual.visual.allImagesDecode, false);
assert.equal(truncatedVisual.visual.decodedImageCount, 0);
assert.ok(truncatedVisual.visual.images.every((image) => image.decodeError?.startsWith('png_decode_failed')));
assert.ok(truncatedVisual.reasons.includes('visual_artifacts_not_readable'));

const blankBeforeVisual = ledger.rows.find((row) => row.targetId === 'blank-before-visual');
assert.equal(blankBeforeVisual?.matrixOutcome, 'unproven');
assert.equal(blankBeforeVisual.acceptedForGpuHmr, false);
assert.equal(blankBeforeVisual.visual.recomputedVisualPair.accepted, false);
assert.ok(blankBeforeVisual.visual.recomputedVisualPair.failedGates.some((gate) =>
  gate.code === 'visual_pair_blank_before_frame'
));
assert.ok(blankBeforeVisual.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'));
assert.ok(blankBeforeVisual.reasons.includes('visual_artifacts_not_readable'));

const noVisualOptOut = ledger.rows.find((row) => row.targetId === 'no-visual-optout');
assert.equal(noVisualOptOut?.matrixOutcome, 'unproven');
assert.equal(noVisualOptOut.acceptedForGpuHmr, false);
assert.equal(noVisualOptOut.visual.required, true);
assert.equal(noVisualOptOut.visual.present, false);
assert.equal(noVisualOptOut.visual.accepted, false);
assert.ok(noVisualOptOut.reasons.includes('visual_artifacts_not_readable'));

const forgedReadableNoHashDiff = ledger.rows.find((row) =>
  row.targetId === 'forged-readable-no-hash-diff'
);
assert.equal(forgedReadableNoHashDiff?.matrixOutcome, 'unproven');
assert.equal(forgedReadableNoHashDiff.acceptedForGpuHmr, false);
assert.equal(forgedReadableNoHashDiff.visual.present, true);
assert.equal(forgedReadableNoHashDiff.visual.allImagesAreDecodedPng, true);
assert.equal(forgedReadableNoHashDiff.visual.recomputedVisualPair.accepted, true);
assert.equal(
  forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.proofAuthority,
  'async_visual_metrics_only',
);
assert.equal(forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.accepted, true);
assert.equal(
  forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.acceptedForGpuHmr,
  false,
);
assert.equal(forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.gpuHmrSuccess, false);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics ?? {},
    'proofHash',
  ),
  false,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.worker ?? {},
    'threadId',
  ),
  false,
);
assert.match(
  forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableHash ?? '',
  /^sha256:[a-f0-9]{64}$/,
);
assert.equal(
  forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableHash,
  forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableManifestHash,
);
assert.equal(
  forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executableModuleCount,
  3,
);
assert.equal(
  forgedReadableNoHashDiff.visual.recomputedVisualPair.asyncVisualMetrics?.worker?.executorIdentity,
  'node_worker_threads_visual_proof_worker',
);
assert.equal(forgedReadableNoHashDiff.visual.requireDeclaredHashes, true);
assert.equal(forgedReadableNoHashDiff.visual.requireDiff, true);
assert.equal(forgedReadableNoHashDiff.visual.allRequiredHashesDeclared, false);
assert.equal(forgedReadableNoHashDiff.visual.hasDiffImage, false);
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_artifact_declared_hash_missing'));
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_before_artifact_hash_missing'));
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_after_artifact_hash_missing'));
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_diff_artifact_missing'));
assert.ok(forgedReadableNoHashDiff.reasons.includes('visual_artifacts_not_readable'));

const visualDimensionMismatch = ledger.rows.find((row) =>
  row.targetId === 'visual-dimension-mismatch'
);
assert.equal(visualDimensionMismatch?.matrixOutcome, 'unproven');
assert.equal(visualDimensionMismatch.acceptedForGpuHmr, false);
assert.equal(visualDimensionMismatch.visual.present, true);
assert.equal(visualDimensionMismatch.visual.allImagesAreDecodedPng, true);
assert.equal(visualDimensionMismatch.visual.recomputedVisualPair.accepted, false);
assert.ok(visualDimensionMismatch.visual.recomputedVisualPair.failedGates.some((gate) =>
  gate.code === 'visual_pair_dimension_mismatch'
));
assert.equal(visualDimensionMismatch.visual.recomputedVisualPair.asyncVisualMetrics?.accepted, true);
assert.equal(visualDimensionMismatch.visual.recomputedVisualPair.asyncVisualMetrics?.acceptedForGpuHmr, false);
assert.equal(visualDimensionMismatch.visual.recomputedVisualPair.asyncVisualMetrics?.gpuHmrSuccess, false);
assert.ok(visualDimensionMismatch.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'));

const visualWorkerTimeoutRoot = path.join(tmpRoot, 'visual-worker-timeout-root');
const visualWorkerTimeoutLogsRoot = path.join(visualWorkerTimeoutRoot, '.gpu-hmr-test-logs');
const visualWorkerTimeoutDir = path.join(
  visualWorkerTimeoutLogsRoot,
  'agent-split-artifacts',
  'synthetic-visual-worker-timeout',
);
const visualWorkerTimeoutBefore = path.join(visualWorkerTimeoutDir, 'before-hmr-first.png');
const visualWorkerTimeoutAfter = path.join(visualWorkerTimeoutDir, 'after-hmr-first.png');
const visualWorkerTimeoutDiff = path.join(visualWorkerTimeoutDir, 'before-after-diff.png');
await writeRgbaPng(visualWorkerTimeoutBefore, 32, 32, (x, y) => [20 + x, 32 + y, 96, 255]);
await writeRgbaPng(visualWorkerTimeoutAfter, 32, 32, (x, y) => [96 + x, 40 + y, 160, 255]);
await writeRgbaPng(visualWorkerTimeoutDiff, 32, 32, () => [255, 255, 255, 255]);
await writeJson(path.join(visualWorkerTimeoutDir, 'run-mode-visual-worker-timeout.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:visual-worker-timeout',
    'gpu-runtime-proof:sha256:visual-worker-timeout',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'visual-worker-timeout',
    visualRoot: visualWorkerTimeoutDir,
  }),
  targetId: 'visual-worker-timeout',
  profileId: 'visual-worker-timeout',
  proofId: 'agent-split-run-mode-proof:sha256:visual-worker-timeout',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: visualWorkerTimeoutBefore,
    after: visualWorkerTimeoutAfter,
    diff: visualWorkerTimeoutDiff,
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:visual-worker-timeout',
    editHash: hashValue('visual-worker-timeout'),
    editKind: 'gpu_artifact_edit',
  },
});
const previousVisualWorkerTimeoutMs = process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS;
const previousVisualWorkerDiagnosticDelayMs =
  process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_DIAGNOSTIC_DELAY_MS;
process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS = '5';
process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_DIAGNOSTIC_DELAY_MS = '50';
let visualWorkerTimeoutLedger;
try {
  visualWorkerTimeoutLedger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: visualWorkerTimeoutRoot,
    mcpRoot,
    roots: [visualWorkerTimeoutLogsRoot],
    generatedAt: '2026-06-09T00:00:00.000Z',
    includeUnproven: true,
  });
} finally {
  if (previousVisualWorkerTimeoutMs === undefined) {
    delete process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS;
  } else {
    process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS = previousVisualWorkerTimeoutMs;
  }
  if (previousVisualWorkerDiagnosticDelayMs === undefined) {
    delete process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_DIAGNOSTIC_DELAY_MS;
  } else {
    process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_DIAGNOSTIC_DELAY_MS =
      previousVisualWorkerDiagnosticDelayMs;
  }
}
const visualWorkerTimeout = visualWorkerTimeoutLedger.rows.find((row) =>
  row.targetId === 'visual-worker-timeout'
);
assert.equal(visualWorkerTimeout?.acceptedForGpuHmr, false);
assert.equal(visualWorkerTimeout.visual.present, true);
assert.equal(visualWorkerTimeout.visual.allImagesAreDecodedPng, true);
assert.equal(visualWorkerTimeout.visual.recomputedVisualPair.recomputeEngine, 'matrix_async_visual_worker_rgba');
assert.equal(visualWorkerTimeout.visual.recomputedVisualPair.accepted, false);
assert.ok(visualWorkerTimeout.visual.recomputedVisualPair.failedGates.some((gate) =>
  gate.code === 'visual_pair_async_worker_recompute_not_accepted'
));
assert.equal(visualWorkerTimeout.visual.recomputedVisualPair.asyncVisualMetrics?.accepted, false);
assert.equal(
  visualWorkerTimeout.visual.recomputedVisualPair.asyncVisualMetrics?.acceptedForGpuHmr,
  false,
);
assert.equal(visualWorkerTimeout.visual.recomputedVisualPair.asyncVisualMetrics?.gpuHmrSuccess, false);
assert.ok(
  visualWorkerTimeout.visual.recomputedVisualPair.asyncVisualMetrics?.reasons?.includes('visual_worker_timeout'),
);
assert.ok(visualWorkerTimeout.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'));

const forgedWebGpu = ledger.rows.find((row) => row.targetId === 'forged-webgpu');
assert.equal(forgedWebGpu?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpu.acceptedForGpuHmr, false);
assert.ok(forgedWebGpu.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuSingleImage = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-single-image'
);
assert.equal(forgedWebGpuSingleImage?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuSingleImage.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuSingleImage.visual.present, true);
assert.equal(forgedWebGpuSingleImage.visual.allImagesAreDecodedPng, true);
assert.equal(forgedWebGpuSingleImage.visual.hasBeforeImage, false);
assert.equal(forgedWebGpuSingleImage.visual.hasAfterImage, false);
assert.equal(forgedWebGpuSingleImage.visual.accepted, false);
assert.ok(forgedWebGpuSingleImage.visual.failedGates.includes('visual_before_artifact_missing'));
assert.ok(forgedWebGpuSingleImage.visual.failedGates.includes('visual_after_artifact_missing'));
assert.ok(
  forgedWebGpuSingleImage.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'),
);
assert.ok(forgedWebGpuSingleImage.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuQueryOnly = ledger.rows.find((row) => row.targetId === 'forged-webgpu-query-only');
assert.equal(forgedWebGpuQueryOnly?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuQueryOnly.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuQueryOnly.visual.accepted, true);
assert.equal(forgedWebGpuQueryOnly.visual.allImagesAreDecodedPng, true);
assert.match(
  forgedWebGpuQueryOnly.visual.recomputedVisualPair.asyncVisualMetrics?.asyncVisualMetricsHash ?? '',
  /^sha256:[a-f0-9]{64}$/,
);
assert.notEqual(
  forgedWebGpuQueryOnly.visual.recomputedVisualPair.asyncVisualMetrics?.asyncVisualMetricsHash,
  `sha256:${'a'.repeat(64)}`,
);
assert.equal(
  forgedWebGpuQueryOnly.visual.recomputedVisualPair.asyncVisualMetrics?.acceptedForGpuHmr,
  false,
);
assert.equal(
  forgedWebGpuQueryOnly.visual.recomputedVisualPair.asyncVisualMetrics?.gpuHmrSuccess,
  false,
);
assert.equal(forgedWebGpuQueryOnly.ledger.present, false);
assert.equal(forgedWebGpuQueryOnly.ledger.source, 'supplied_query_ignored_no_ledger');
assert.ok(forgedWebGpuQueryOnly.reasons.includes('proof_ledger_record_missing'));
assert.ok(forgedWebGpuQueryOnly.reasons.includes('runtime_proof_artifact_not_strictly_accepted'));

const forgedWebGpuHashMismatch = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-hash-mismatch'
);
assert.equal(forgedWebGpuHashMismatch?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuHashMismatch.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuHashMismatch.visual.present, true);
assert.equal(forgedWebGpuHashMismatch.visual.allImagesAreDecodedPng, true);
assert.equal(forgedWebGpuHashMismatch.visual.allDeclaredHashesMatch, false);
assert.ok(forgedWebGpuHashMismatch.visual.failedGates.includes('visual_artifact_hash_mismatch'));
assert.ok(forgedWebGpuHashMismatch.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuPathEscape = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-path-escape'
);
assert.equal(forgedWebGpuPathEscape?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuPathEscape.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuPathEscape.visual.present, true);
assert.equal(forgedWebGpuPathEscape.visual.accepted, false);
assert.ok(forgedWebGpuPathEscape.visual.images.every((image) =>
  image.decodeError === 'evidence_path_outside_allowed_roots'
));
assert.ok(forgedWebGpuPathEscape.reasons.includes('visual_artifacts_not_readable'));

const forgedSourceAdaptedWebGpu = ledger.rows.find((row) =>
  row.targetId === 'forged-source-adapted-webgpu'
);
assert.equal(forgedSourceAdaptedWebGpu?.matrixOutcome, 'visual_profile_accepted');
assert.equal(forgedSourceAdaptedWebGpu.acceptedForGpuHmr, false);
assert.equal(forgedSourceAdaptedWebGpu.gpuHmrSuccess, false);
assert.equal(forgedSourceAdaptedWebGpu.visualProfileAccepted, true);
assert.equal(forgedSourceAdaptedWebGpu.sourceAdaptedProfile, true);
assert.equal(forgedSourceAdaptedWebGpu.runtimeProofArtifact.accepted, true);
assert.equal(forgedSourceAdaptedWebGpu.ledger.gpuHmrSuccess, true);
assert.equal(forgedSourceAdaptedWebGpu.backend, 'webgpu');
assert.ok(forgedSourceAdaptedWebGpu.reasons.includes('source_adapted_profile_not_no_shim_gpu_hmr'));
assert.ok(forgedSourceAdaptedWebGpu.openGaps.includes('source_adapted_profile_not_no_shim_gpu_hmr'));

const forgedTopLevelSourceAdaptedWebGpu = ledger.rows.find((row) =>
  row.targetId === 'forged-top-level-source-adapted-webgpu'
);
assert.equal(forgedTopLevelSourceAdaptedWebGpu?.matrixOutcome, 'visual_profile_accepted');
assert.equal(forgedTopLevelSourceAdaptedWebGpu.acceptedForGpuHmr, false);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.gpuHmrSuccess, false);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.visualProfileAccepted, true);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.sourceAdaptedProfile, true);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.sourceAdaptation.sourceAdaptedProfile, true);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.runtimeProbeInstrumentation.accepted, false);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.backend, 'webgpu');
assert.ok(forgedTopLevelSourceAdaptedWebGpu.reasons.includes('source_adapted_profile_not_no_shim_gpu_hmr'));
assert.ok(forgedTopLevelSourceAdaptedWebGpu.openGaps.includes('source_adapted_profile_not_no_shim_gpu_hmr'));

const forgedSourceAdaptedWebGpuVisual = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-source-adapted-visual'
);
assert.equal(forgedSourceAdaptedWebGpuVisual?.proofMode, 'webgpu_wgsl_runtime_visual');
assert.equal(forgedSourceAdaptedWebGpuVisual.matrixOutcome, 'visual_profile_accepted');
assert.equal(forgedSourceAdaptedWebGpuVisual.acceptedForGpuHmr, false);
assert.equal(forgedSourceAdaptedWebGpuVisual.gpuHmrSuccess, false);
assert.equal(forgedSourceAdaptedWebGpuVisual.visualProfileAccepted, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.sourceAdaptedProfile, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.ledger.gpuHmrSuccess, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.visual.accepted, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.declaredScopeEvidence.accepted, true);
assert.ok(forgedSourceAdaptedWebGpuVisual.reasons.includes(
  'source_adapted_profile_not_no_shim_gpu_hmr',
));
assert.ok(forgedSourceAdaptedWebGpuVisual.openGaps.includes(
  'source_adapted_profile_not_no_shim_gpu_hmr',
));

const forgedSeedlessWebGpuVisual = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-seedless-visual'
);
assert.equal(forgedSeedlessWebGpuVisual?.proofMode, 'webgpu_wgsl_runtime_visual');
assert.equal(forgedSeedlessWebGpuVisual.matrixOutcome, 'unproven');
assert.equal(forgedSeedlessWebGpuVisual.acceptedForGpuHmr, false);
assert.equal(forgedSeedlessWebGpuVisual.ledger.gpuHmrSuccess, true);
assert.equal(forgedSeedlessWebGpuVisual.visual.accepted, true);
assert.equal(forgedSeedlessWebGpuVisual.deterministicVisualModeEvaluation.accepted, false);
assert.ok(forgedSeedlessWebGpuVisual.deterministicVisualModeEvaluation.failedGates.some(
  (failure) => failure.code === 'seed_policy_unproven',
));
assert.ok(forgedSeedlessWebGpuVisual.reasons.includes('deterministic_visual_mode_not_accepted'));
assert.ok(forgedSeedlessWebGpuVisual.reasons.includes('seed_policy_unproven'));
assert.ok(forgedSeedlessWebGpuVisual.openGaps.includes('seed_policy_unproven'));

const forgedWebGpuCompute = ledger.rows.find((row) => row.targetId === 'forged-webgpu-compute');
assert.equal(forgedWebGpuCompute?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuCompute.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuCompute.outputOracleFacet.accepted, false);
assert.equal(forgedWebGpuCompute.visual.accepted, false);
assert.equal(
  forgedWebGpuCompute.visual.reason,
  'webgpu_compute_readback_uses_compute_card_not_runtime_frame_visual_proof',
);
assert.ok(forgedWebGpuCompute.reasons.includes('proof_ledger_record_missing'));
assert.ok(forgedWebGpuCompute.reasons.includes('compute_oracle_files_not_accepted'));
assert.ok(forgedWebGpuCompute.reasons.includes('compute_oracle_expected_output_not_verified'));
assert.ok(forgedWebGpuCompute.reasons.includes('webgpu_compute_declared_scope_not_evidence_backed'));

const acceptedHiprt = ledger.rows.find((row) =>
  row.targetId === 'accepted-hiprt-recomputed-oracle'
  && row.proofMode === 'same-process'
);
assert.equal(acceptedHiprt?.matrixOutcome, 'visual_profile_accepted');
assert.equal(acceptedHiprt.acceptedForGpuHmr, false);
assert.equal(acceptedHiprt.visualProfileAccepted, true);
assert.equal(acceptedHiprt.sourceAdaptedProfile, true);
assert.equal(acceptedHiprt.gpuHmrSuccess, false);
assert.equal(acceptedHiprt.oracleRegion.source, 'matrix_recomputed_png_pixels');
assert.equal(acceptedHiprt.oracleRegion.accepted, true);
assert.equal(acceptedHiprt.oracleRegion.nonBlankAfterEpoch, true);
assert.equal(acceptedHiprt.runtimeProbeInstrumentation.accepted, true);
assert.equal(acceptedHiprt.runtimeProbeInstrumentation.scope, 'hiprt_declared_visual_profile');
assert.equal(acceptedHiprt.runtimeProbeInstrumentation.arbitraryLibraryAccepted, false);
assert.equal(acceptedHiprt.hiprtContract.present, true);
assert.equal(acceptedHiprt.hiprtContract.accepted, true);
assert.equal(acceptedHiprt.hiprtContract.acceptedForGpuHmr, false);
assert.equal(acceptedHiprt.hiprtContract.noShimEligible, false);
assert.equal(acceptedHiprt.hiprtContract.sourceAdaptedProfile, true);
assert.deepEqual(acceptedHiprt.hiprtContract.missingFields, []);
assert.deepEqual(acceptedHiprt.hiprtContract.missingEvidenceFields, []);
assert.equal(acceptedHiprt.visual.visualThresholdValidation.accepted, true);
assert.equal(acceptedHiprt.visual.visualThresholdValidation.source, 'matrix_recomputed_png_pixels_declared_thresholds');
assert.ok(acceptedHiprt.reasons.includes('source_adapted_profile_not_no_shim_gpu_hmr'));
assert.ok(acceptedHiprt.openGaps.includes('source_adapted_profile_not_no_shim_gpu_hmr'));

const forgedHiprtVisualThreshold = ledger.rows.find(
  (row) => row.targetId === 'forged-hiprt-visual-threshold',
);
assert.equal(forgedHiprtVisualThreshold?.matrixOutcome, 'unproven');
assert.equal(forgedHiprtVisualThreshold.acceptedForGpuHmr, false);
assert.equal(forgedHiprtVisualThreshold.visual.accepted, false);
assert.equal(forgedHiprtVisualThreshold.visual.visualThresholdValidation.accepted, false);
assert.equal(
  forgedHiprtVisualThreshold.visual.visualThresholdValidation.source,
  'matrix_recomputed_png_pixels_declared_thresholds',
);
assert.ok(forgedHiprtVisualThreshold.visual.failedGates.includes(
  'visual_changed_pixel_ratio_below_declared_threshold',
));
assert.ok(forgedHiprtVisualThreshold.visual.failedGates.includes(
  'visual_mean_abs_delta_below_declared_threshold',
));
assert.ok(forgedHiprtVisualThreshold.reasons.includes(
  'visual_changed_pixel_ratio_below_declared_threshold',
));
assert.ok(forgedHiprtVisualThreshold.openGaps.includes(
  'visual_mean_abs_delta_below_declared_threshold',
));

const forgedHiprtMissingInstrumentation = ledger.rows.find(
  (row) => row.targetId === 'forged-hiprt-missing-instrumentation',
);
assert.equal(forgedHiprtMissingInstrumentation?.matrixOutcome, 'unproven');
assert.equal(forgedHiprtMissingInstrumentation.acceptedForGpuHmr, false);
assert.equal(forgedHiprtMissingInstrumentation.runtimeProofArtifact.accepted, true);
assert.equal(forgedHiprtMissingInstrumentation.ledger.gpuHmrSuccess, true);
assert.equal(forgedHiprtMissingInstrumentation.visual.accepted, true);
assert.equal(forgedHiprtMissingInstrumentation.runtimeProbeInstrumentation.accepted, false);
assert.equal(forgedHiprtMissingInstrumentation.hiprtContract.accepted, false);
assert.ok(forgedHiprtMissingInstrumentation.reasons.includes(
  'hiprt_profile_instrumentation_disclosure_not_proven',
));
assert.ok(forgedHiprtMissingInstrumentation.reasons.includes('hiprt_contract_not_proven'));
assert.ok(forgedHiprtMissingInstrumentation.openGaps.includes(
  'hiprt_profile_instrumentation_disclosure_required',
));
assert.ok(forgedHiprtMissingInstrumentation.openGaps.includes('hiprt_contract_required'));

const forgedHiprt = ledger.rows.find((row) => row.targetId === 'forged-hiprt-oracle-region-json');
assert.equal(forgedHiprt?.matrixOutcome, 'unproven');
assert.equal(forgedHiprt.acceptedForGpuHmr, false);
assert.equal(forgedHiprt.oracleRegion.source, 'matrix_recomputed_png_pixels');
assert.equal(forgedHiprt.oracleRegion.accepted, false);
assert.equal(forgedHiprt.oracleRegion.nonBlankAfterEpoch, false);
assert.ok(forgedHiprt.reasons.includes('hiprt_oracle_region_pixel_recompute_not_accepted'));

const legacyAgentSplit = ledger.rows.find((row) =>
  row.proofMode === 'mcp_preview_visual'
  && row.targetId === 'unknown'
);
assert.equal(legacyAgentSplit?.matrixOutcome, 'unproven');
assert.equal(legacyAgentSplit.targetId, 'unknown');

const forgedLegacyPreview = ledger.rows.find((row) => row.targetId === 'forged-legacy-preview');
assert.equal(forgedLegacyPreview?.proofMode, 'mcp_preview_visual');
assert.equal(forgedLegacyPreview.matrixOutcome, 'unproven');
assert.equal(forgedLegacyPreview.acceptedForGpuHmr, false);
assert.equal(forgedLegacyPreview.ledger.source, 'embedded_validation_claim');
assert.equal(forgedLegacyPreview.runtimeProofArtifact.present, false);
assert.ok(forgedLegacyPreview.reasons.includes('mcp_preview_recomputed_proof_ledger_missing'));
assert.ok(forgedLegacyPreview.reasons.includes('mcp_preview_runtime_proof_artifact_missing'));

assert.equal(ledger.summary.acceptedFullRuntimeGpuHmrRows, 4);
assert.equal(ledger.summary.broadFullRuntimeGpuHmrRows, 0);
assert.equal(ledger.summary.scopedFullRuntimeGpuHmrRows, 4);
assert.equal(ledger.summary.allFullRuntimeGpuHmrRows, 4);
assert.ok(ledger.summary.visualProfileAcceptedRows >= 1);
assert.equal(
  Object.values(ledger.summary.fullRuntimeScopeBreakdown).reduce((sum, count) => sum + count, 0),
  ledger.summary.allFullRuntimeGpuHmrRows,
);
const retainedRealRocmRefusalCount = retainedRealRocmRows
  .filter((row) => row.matrixOutcome === 'refusal_proven').length;
assert.equal(retainedRealRocmRefusalCount, 2);
assert.equal(ledger.summary.refusalProvenRows, 5 + retainedRealRocmRefusalCount);
assert.ok(ledger.summary.unprovenRows >= 1);

const coverageById = new Map(ledger.summary.planCoverage.map((entry) => [entry.id, entry]));
const flowVisualCoverage = coverageById.get('flow_visual_gpu_path');
assert.equal(flowVisualCoverage?.status, 'accepted');
assert.ok(flowVisualCoverage.rows.some((row) =>
  row.validationProfileEvidence?.accepted === true
  && row.validationProfileEvidence.profileId === 'flow'
  && row.validationProfileEvidence.profileClass === 'flow_visual_gpu_path'
));
assert.ok(flowVisualCoverage.rows.some((row) =>
  row.validationProfileEvidence?.accepted === true
  && row.validationProfileEvidence.source === 'agent_split_profile_runtime_visual_proof'
));
const sourceFirstCoverage = coverageById.get('source_first_uncompiled_project_validation');
assert.equal(sourceFirstCoverage?.status, 'missing');
assert.equal(
  sourceFirstCoverage?.proofAuthority,
  'source_first_ingestion_provenance_only_not_runtime_proof',
);
assert.equal(
  sourceFirstCoverage?.sourceFirstEvidenceAuthority,
  'source_first_provenance_only_plus_strict_runtime_ledger',
);
assert.equal(
  sourceFirstCoverage?.asyncVisualCasSupportAuthority,
  'async_visual_metrics_and_transport_only',
);
assert.equal(sourceFirstCoverage?.rowCount, 0);
assert.equal(sourceFirstCoverage?.sourceIdentityCount, 0);
assert.ok(sourceFirstCoverage?.openGaps.includes(
  'source_first_full_runtime_visual_or_compute_proof_with_async_cas_support_required',
));
assert.ok(!sourceFirstCoverage.rows.some((row) =>
  row.targetId === 'flow-smuggled-precompiled'
  || row.targetId === 'flow-forged-generated-source-path'
  || row.targetId === 'flow-source-first-no-cas'
  || row.targetId === 'flow-source-tree-manifest-mismatch'
  || row.targetId === 'flow-empty-source-manifest'
));
assert.equal(coverageById.get('opencl_dispatch_readback')?.status, 'refused');
assert.ok(!coverageById.get('opencl_dispatch_readback')?.rows.some((row) =>
  row.targetId === 'forged-generic-opencl-label'
));
assert.equal(coverageById.get('cuda_runtime')?.status, 'not_applicable');
assert.equal(coverageById.get('cuda_runtime')?.not_applicable, true);
assert.equal(coverageById.get('cuda_runtime')?.hardwareScope, 'rocm_amd_local_run');
assert.deepEqual(coverageById.get('cuda_runtime')?.openGaps, []);
assert.equal(coverageById.get('bevy_file_loaded_wgsl')?.status, 'refused');
assert.equal(coverageById.get('large_real_rocm_repo')?.status, 'refused');
assert.ok(coverageById.get('large_real_rocm_repo')?.openGaps.includes('output_or_visual_oracle_proof_required'));
assert.equal(coverageById.get('large_real_rocm_repo:real-rocm-large-lib')?.status, 'refused');
assert.equal(coverageById.get('large_real_rocm_repo:real-rocm-large-lib')?.rowCount, 1);
assert.ok(coverageById.get('large_real_rocm_repo:real-rocm-large-lib')?.openGaps.includes(
  'output_or_visual_oracle_proof_required',
));
const largeRocmCoverage = coverageById.get('large_real_rocm_repo:real-rocm-large-lib');
assert.equal(largeRocmCoverage?.appHookContract.required, true);
assert.equal(largeRocmCoverage.appHookContract.proven, false);
assert.equal(largeRocmCoverage.appHookContract.status, 'contract_missing_or_unproven');
assert.ok(largeRocmCoverage.appHookContract.blockingGaps.includes('real_rocm_app_hook_contract_required'));
assert.equal(largeRocmCoverage.appHookMaterialization.required, true);
assert.equal(largeRocmCoverage.appHookMaterialization.proven, false);
assert.equal(largeRocmCoverage.appHookMaterialization.status, 'materialization_missing_or_unproven');
assert.ok(largeRocmCoverage.appHookMaterialization.blockingGaps.includes(
  'app_hook_materialization_output_oracle_contract_missing',
));
assert.equal(largeRocmCoverage.sameProcessRuntimeOracleContract.required, true);
assert.equal(largeRocmCoverage.sameProcessRuntimeOracleContract.proven, false);
assert.equal(largeRocmCoverage.sameProcessRuntimeOracleContract.status, 'contract_missing_or_unproven');
assert.equal(largeRocmCoverage.deviceSidecarContract.required, true);
assert.equal(largeRocmCoverage.deviceSidecarContract.proven, false);
assert.equal(largeRocmCoverage.deviceSidecarContract.status, 'device_sidecar_missing_or_unproven');
assert.ok(largeRocmCoverage.deviceSidecarContract.blockingGaps.includes(
  'device_sidecar_dispatch_trace_runtime_not_observed',
));
assert.equal(largeRocmCoverage.sidecarRuntimeConsistency.required, true);
assert.equal(largeRocmCoverage.sidecarRuntimeConsistency.proven, false);
assert.equal(largeRocmCoverage.sidecarRuntimeConsistency.status, 'consistency_missing_or_unproven');
assert.ok(largeRocmCoverage.sidecarRuntimeConsistency.blockingGaps.includes(
  'sidecar_runtime_sidecar_observation_missing',
));

const contradictoryRealRocmCoverageQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [{
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    artifactSchema: 'synthi.gpu_hmr.real_rocm_repo_validation.v1',
    artifactPath: 'synthetic/real-rocm-contradictory-contracts.json',
    updatedAt: '2026-06-09T00:00:00.080Z',
    backend: 'hip',
    targetId: 'real-rocm-contradictory-contracts',
    profileId: 'real-rocm-contradictory-contracts',
    proofMode: 'real_rocm_repo_validation',
    evidenceKind: 'real_rocm_repo_refusal',
    matrixOutcome: 'refusal_proven',
    acceptanceClass: 'refusal_proven',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven: true,
    proofChainAccepted: true,
    proofChain: 'structured_runtime_refusal',
    proofIds: ['real-rocm-contradictory-contracts-proof:sha256:refusal'],
    ledger: {
      present: true,
      proofId: 'real-rocm-contradictory-contracts-ledger:sha256:refusal',
      gpuHmrSuccess: false,
      failedInvariants: ['runtime_proof_missing'],
    },
    reasons: ['runtime_proof_missing'],
    openGaps: ['output_or_visual_oracle_proof_required'],
    realRocmAppHookContract: {
      required: true,
      accepted: true,
      canSatisfyRuntimeProof: true,
      blockingGaps: ['contradictory_app_hook_gap'],
      blocking_gaps: ['contradictory_app_hook_gap'],
    },
    realRocmSameProcessRuntimeOracle: {
      required: true,
      accepted: true,
      canSatisfyRuntimeProof: true,
      failedGaps: ['contradictory_oracle_gap'],
      failed_gaps: ['contradictory_oracle_gap'],
    },
    realRocmDeviceSidecarContract: {
      accepted: true,
      proven: true,
      failedGates: [{ code: 'contradictory_sidecar_gate' }],
      failed_gates: [{ code: 'contradictory_sidecar_gate' }],
    },
    realRocmSidecarRuntimeConsistency: {
      accepted: true,
      runtimeConsistencyAccepted: true,
      blockingGaps: ['contradictory_consistency_gap'],
      blocking_gaps: ['contradictory_consistency_gap'],
    },
  }],
});
const contradictoryCoverage = new Map(
  contradictoryRealRocmCoverageQuery.summary.planCoverage.map((entry) => [entry.id, entry]),
).get('large_real_rocm_repo:real-rocm-contradictory-contracts');
assert.equal(contradictoryCoverage?.status, 'refused');
assert.equal(contradictoryCoverage.appHookContract.proven, false);
assert.equal(contradictoryCoverage.appHookContract.accepted, false);
assert.equal(contradictoryCoverage.appHookContract.status, 'contract_missing_or_unproven');
assert.ok(contradictoryCoverage.appHookContract.blockingGaps.includes('contradictory_app_hook_gap'));
assert.equal(contradictoryCoverage.sameProcessRuntimeOracleContract.proven, false);
assert.equal(contradictoryCoverage.sameProcessRuntimeOracleContract.accepted, false);
assert.ok(contradictoryCoverage.sameProcessRuntimeOracleContract.blockingGaps.includes(
  'contradictory_oracle_gap',
));
assert.equal(contradictoryCoverage.deviceSidecarContract.proven, false);
assert.equal(contradictoryCoverage.deviceSidecarContract.accepted, false);
assert.equal(contradictoryCoverage.deviceSidecarContract.status, 'device_sidecar_missing_or_unproven');
assert.ok(contradictoryCoverage.deviceSidecarContract.blockingGaps.includes(
  'contradictory_sidecar_gate',
));
assert.equal(contradictoryCoverage.sidecarRuntimeConsistency.proven, false);
assert.equal(contradictoryCoverage.sidecarRuntimeConsistency.accepted, false);
assert.equal(contradictoryCoverage.sidecarRuntimeConsistency.status, 'consistency_missing_or_unproven');
assert.ok(contradictoryCoverage.sidecarRuntimeConsistency.blockingGaps.includes(
  'contradictory_consistency_gap',
));
assert.equal(coverageById.get('large_real_rocm_repo:real-rocm-second-lib')?.status, 'refused');
assert.equal(coverageById.get('webgpu_scoped_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_empty_layout_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_profiled_layout_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_compute_runtime_readback')?.status, 'missing');
assert.equal(coverageById.get('webgpu_runtime_preflight')?.status, 'preflight_only');
assert.ok(coverageById.get('webgpu_runtime_preflight')?.openGaps.includes(
  'shader_pipeline_or_output_oracle_not_proven',
));
assert.equal(coverageById.get('oidn_hip_runtime_preflight')?.status, 'preflight_only');
assert.ok(coverageById.get('oidn_hip_runtime_preflight')?.openGaps.includes('oidn_output_oracle_not_proven'));
assert.equal(coverageById.get('oidn_hip_output_oracle_support')?.status, 'preflight_only');
assert.equal(coverageById.get('oidn_hip_output_oracle_support')?.acceptedForGpuHmr, false);
assert.equal(coverageById.get('oidn_hip_output_oracle_support')?.gpuHmrSuccess, false);
assert.equal(
  coverageById.get('oidn_hip_output_oracle_support')?.proofAuthority,
  'oidn_output_oracle_support_only_not_gpu_hmr_acceptance',
);
assert.ok(coverageById.get('oidn_hip_output_oracle_support')?.openGaps.includes(
  'strict_runtime_proof_ledger_required',
));
assert.ok(coverageById.get('oidn_hip_output_oracle_support')?.rows.some((row) =>
  row.targetId === 'synthetic-oidn-hip-output-oracle'
));
assert.ok(!coverageById.get('oidn_hip_output_oracle_support')?.rows.some((row) =>
  row.targetId === 'synthetic-oidn-hip-output-oracle-forged-file-hash'
));
assert.equal(coverageById.get('oidn_hip_output')?.status, 'missing');
assert.ok(coverageById.get('oidn_hip_output')?.openGaps.includes('oidn_hip_runtime_proof_required'));
assert.equal(ledger.summary.broadLibraryAgnosticReadiness.broadRuntimeRows, 0);
assert.equal(coverageById.get('external_engine_visual_profile')?.status, 'visual_profile_only');
assert.ok(coverageById.get('external_engine_visual_profile')?.rows.every((row) =>
  row.externalProfileSelection?.accepted === true
  && row.externalSourceDelta?.accepted === true
  && row.externalVisualProofArtifact?.accepted === true
));
assert.ok(!coverageById.get('external_engine_visual_profile')?.rows.some((row) =>
  row.targetId === 'forged-external-engine-visual'
));
assert.equal(coverageById.get('per_kernel_smallest_safe_fission')?.status, 'accepted');
assert.equal(coverageById.get('per_target_run_modes')?.status, 'accepted');
assert.ok(coverageById.get('per_target_run_modes')?.acceptedTargetCount > 0);
assert.equal(coverageById.get('per_target_run_modes')?.incompleteTargetCount, 0);
const flowRunModeTarget = coverageById.get('per_target_run_modes')?.targetCoverage.find(
  (entry) => entry.targetKey === 'hip:flow',
);
assert.equal(flowRunModeTarget?.status, 'accepted');
assert.deepEqual(flowRunModeTarget.openGaps, []);
assert.ok(flowRunModeTarget.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:cold')
  && row.runModeCoverageSupport?.accepted === true
));
assert.ok(!flowRunModeTarget.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-unlinked-flow-cold')
));
assert.ok(!flowRunModeTarget.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-failed-support-cold')
));
assert.ok(!flowRunModeTarget.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-borrowed-support-cold')
));
assert.ok(coverageById.get('per_target_run_modes')?.unlinkedSupportRowCount >= 1);
const optedOutHiprtRunModeTarget = coverageById.get('per_target_run_modes')?.targetCoverage.find(
  (entry) => entry.targetKey === 'hiprt:accepted-hiprt-recomputed-oracle',
);
assert.equal(optedOutHiprtRunModeTarget, undefined);
assert.equal(coverageById.get('hiprt_visual_path')?.status, 'visual_profile_only');
assert.ok(coverageById.get('hiprt_visual_path')?.openGaps.includes(
  'source_adapted_profile_not_no_shim_gpu_hmr',
));
assert.equal(coverageById.get('hiprt_visual_path')?.acceptedForGpuHmr, false);
assert.equal(coverageById.get('hiprt_run_modes')?.status, 'visual_profile_partial');
const hiprtRunModeTarget = coverageById.get('hiprt_run_modes')?.targetCoverage?.find(
  (entry) => entry.targetKey === 'hiprt:accepted-hiprt-recomputed-oracle',
);
assert.equal(hiprtRunModeTarget?.status, 'visual_profile_partial');
assert.ok(hiprtRunModeTarget.openGaps.includes(
  'hiprt:accepted-hiprt-recomputed-oracle:negative_edit_refusal_evidence_missing',
));
assert.ok(coverageById.get('hiprt_run_modes')?.openGaps.includes(
  'hiprt_no_shim_full_runtime_run_modes_required',
));
assert.equal(coverageById.get('hiprt_run_modes')?.acceptedForGpuHmr, false);
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:cold_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_1_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_2_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_2_different_edit_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('negative_edit_refusal_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:stale-cold-only:hot_delta_1_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:stale-cold-only:hot_delta_2_evidence_missing'));

const coldRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'cold'
);
assert.equal(coldRunMode?.matrixOutcome, 'cold_split_proven');
assert.equal(coldRunMode.acceptedForGpuHmr, false);
assert.equal(coldRunMode.artifactSchema, 'synthi.gpu.hmr.runtime_run_mode_proof.v1');
assert.equal(coldRunMode.proofChain, 'runtime_initial_visual_gate');

const webgpuSingleFrameCold = ledger.rows.find((row) =>
  row.targetId === 'webgpu-single-frame-cold'
  && row.proofMode === 'run_mode_proof'
  && row.runMode.metricScope === 'cold'
);
assert.equal(webgpuSingleFrameCold?.matrixOutcome, 'cold_split_proven');
assert.equal(webgpuSingleFrameCold.visual.accepted, true);
assert.equal(webgpuSingleFrameCold.visual.allowSingleFrameProof, true);
assert.equal(webgpuSingleFrameCold.visual.recomputedSingleFrame.accepted, true);
assert.equal(
  webgpuSingleFrameCold.visual.recomputedSingleFrame.recomputeEngine,
  'matrix_async_visual_worker_rgba',
);
assert.equal(webgpuSingleFrameCold.visual.recomputedSingleFrame.asyncVisualMetrics.accepted, true);
assert.equal(
  webgpuSingleFrameCold.visual.recomputedSingleFrame.asyncVisualMetrics.worker.offMainThread,
  true,
);
assert.ok(!webgpuSingleFrameCold.visual.failedGates.includes('visual_after_artifact_missing'));
assert.ok(!webgpuSingleFrameCold.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'));
const webgpuSingleFrameHotForged = ledger.rows.find((row) =>
  row.targetId === 'webgpu-single-frame-hot-forged'
  && row.proofMode === 'run_mode_proof'
  && row.runMode.metricScope === 'hot_delta_1'
);
assert.equal(webgpuSingleFrameHotForged?.matrixOutcome, 'unproven');
assert.equal(webgpuSingleFrameHotForged.visual.accepted, false);
assert.equal(webgpuSingleFrameHotForged.visual.allowSingleFrameProof, false);
assert.equal(webgpuSingleFrameHotForged.visual.recomputedSingleFrame.accepted, true);
assert.equal(
  webgpuSingleFrameHotForged.visual.recomputedSingleFrame.recomputeEngine,
  'matrix_async_visual_worker_rgba',
);
assert.equal(webgpuSingleFrameHotForged.visual.recomputedSingleFrame.asyncVisualMetrics.accepted, true);
assert.ok(webgpuSingleFrameHotForged.visual.failedGates.includes('visual_after_artifact_missing'));
assert.ok(webgpuSingleFrameHotForged.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'));

const hot2RunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'hot_delta_2'
);
assert.equal(hot2RunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(hot2RunMode.artifactSchema, 'synthi.gpu.hmr.runtime_run_mode_proof.v1');
assert.equal(hot2RunMode.runMode.differentEdit, true);

const hot1RunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'hot_delta_1'
);
assert.equal(hot1RunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(hot1RunMode.artifactSchema, 'synthi.gpu.hmr.agent_split_run_mode_proof.v1');
assert.equal(hot1RunMode.sourceFirstIngestion.accepted, true);
assert.equal(hot1RunMode.sourceFirstIngestion.proofAuthority, 'source_first_ingestion_provenance_only_not_runtime_proof');
assert.equal(hot1RunMode.asyncVisualCasBundle.accepted, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.acceptedForGpuHmr, false);
assert.equal(hot1RunMode.asyncVisualCasBundle.gpuHmrSuccess, false);
assert.equal(hot1RunMode.asyncVisualCasBundle.proofAuthority, 'async_visual_metrics_and_transport_only');
assert.equal(hot1RunMode.asyncVisualCasBundle.proofReady, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.offMainThread, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.transportAccepted, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.casHashesMatchDeclaredVisualHashes, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.casHashesMatchMatrixVisualHashes, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.workerCasInputAccepted, true);
assert.equal(
  hot1RunMode.asyncVisualCasBundle.workerInputTransports.before.transportKind,
  'cas_shared_volume',
);
assert.equal(
  hot1RunMode.asyncVisualCasBundle.workerInputTransports.after.transportKind,
  'cas_shared_volume',
);
assert.equal(hot1RunMode.asyncVisualCasBundle.tileEvidenceAccepted, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.tileBindingAccepted, true);
assert.equal(hot1RunMode.asyncVisualCasBundle.incrementalEvidenceBindingAccepted, true);
assert.match(hot1RunMode.asyncVisualCasBundle.tileBindingHash, /^sha256:[a-f0-9]{64}$/);
assert.match(hot1RunMode.asyncVisualCasBundle.workerExecutableHash, /^sha256:[a-f0-9]{64}$/);
assert.match(
  hot1RunMode.asyncVisualCasBundle.workerNativeDependencyManifestHash,
  /^sha256:[a-f0-9]{64}$/,
);
assert.equal(
  hot1RunMode.asyncVisualCasBundle.workerNativeDependencyManifestSchemaVersion,
  'synthi.gpu_hmr.visual_worker_native_dependency_manifest.v1',
);
assert.equal(hot1RunMode.asyncVisualCasBundle.workerNativeDependencyCount, 1);
assert.equal(hot1RunMode.asyncVisualCasBundle.nativeImageDependencyBound, true);
assert.equal(hot1RunMode.visual.artifactCasLocatorCount, 3);
assert.equal(hot1RunMode.visual.allCasLocatorsAccepted, true);
assert.equal(hot1RunMode.visual.allCasLocatorHashesMatch, true);

const sourceFirstNoCasRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-source-first-no-cas'
);
assert.equal(sourceFirstNoCasRunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(sourceFirstNoCasRunMode.sourceFirstIngestion.accepted, true);
assert.equal(sourceFirstNoCasRunMode.asyncVisualCasBundle.accepted, false);
assert.equal(sourceFirstNoCasRunMode.asyncVisualCasBundle.acceptedForGpuHmr, false);
assert.equal(sourceFirstNoCasRunMode.asyncVisualCasBundle.gpuHmrSuccess, false);
assert.ok(sourceFirstNoCasRunMode.asyncVisualCasBundle.failedGates.includes(
  'visual_artifact_transport_not_accepted',
));
assert.ok(sourceFirstNoCasRunMode.asyncVisualCasBundle.failedGates.includes(
  'visual_artifact_cas_locators_not_accepted',
));
assert.ok(sourceFirstNoCasRunMode.asyncVisualCasBundle.failedGates.includes(
  'async_visual_worker_cas_input_missing',
));

const sourceFirstPendingVisualJobOnly = ledger.rows.find((row) =>
  row.targetId === 'flow-source-first-pending-visual-job-only'
);
assert.equal(sourceFirstPendingVisualJobOnly?.matrixOutcome, 'unproven');
assert.equal(sourceFirstPendingVisualJobOnly.acceptedForGpuHmr, false);
assert.equal(sourceFirstPendingVisualJobOnly.gpuHmrSuccess, false);
assert.equal(sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.present, true);
assert.equal(sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.accepted, false);
assert.equal(sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.proofReady, false);
assert.equal(sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.asyncVisualProofJobPresent, true);
assert.equal(sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.asyncVisualProofJobPending, true);
assert.equal(
  sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.asyncVisualProofJobAuthority,
  'async_visual_job_manifest_only_not_gpu_hmr_acceptance',
);
assert.ok(sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.failedGates.includes(
  'async_visual_proof_pending_not_ready',
));
assert.ok(sourceFirstPendingVisualJobOnly.asyncVisualCasBundle.failedGates.includes(
  'async_visual_metrics_missing',
));
assert.ok(sourceFirstPendingVisualJobOnly.reasons.includes('visual_artifacts_not_readable'));

const sourceFirstCasOnlyRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-source-first-cas-only'
);
assert.equal(sourceFirstCasOnlyRunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(sourceFirstCasOnlyRunMode.visual.accepted, true);
assert.equal(sourceFirstCasOnlyRunMode.visual.existingImageCount, 3);
assert.equal(sourceFirstCasOnlyRunMode.visual.decodedImageCount, 3);
assert.equal(sourceFirstCasOnlyRunMode.visual.artifactCasLocatorCount, 3);
assert.equal(sourceFirstCasOnlyRunMode.visual.allCasLocatorsAccepted, true);
assert.equal(sourceFirstCasOnlyRunMode.visual.allCasLocatorHashesMatch, true);
assert.ok(sourceFirstCasOnlyRunMode.visual.images.every((image) => image.resolvedFromCas === true));
assert.equal(sourceFirstCasOnlyRunMode.asyncVisualCasBundle.accepted, true);
assert.equal(sourceFirstCasOnlyRunMode.asyncVisualCasBundle.workerCasInputAccepted, true);
assert.equal(sourceFirstCasOnlyRunMode.asyncVisualCasBundle.nativeImageDependencyBound, true);

const retargetedSourceFirstReplayRow = JSON.parse(JSON.stringify(acceptedFlow));
retargetedSourceFirstReplayRow.targetId = 'flow-source-first-retargeted-alias';
retargetedSourceFirstReplayRow.target_id = 'flow-source-first-retargeted-alias';
retargetedSourceFirstReplayRow.sourceFirstIngestion = sourceFirstIngestionEvidenceFor({
  targetId: 'flow-source-first-retargeted-alias',
});
retargetedSourceFirstReplayRow.source_first_ingestion = retargetedSourceFirstReplayRow.sourceFirstIngestion;
delete retargetedSourceFirstReplayRow.fullRuntimeRowIdentityBinding;
delete retargetedSourceFirstReplayRow.full_runtime_row_identity_binding;
const retargetedSourceFirstReplayQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [withQueryRecomputedRowId(retargetedSourceFirstReplayRow)],
});
assert.equal(retargetedSourceFirstReplayQuery.accepted, false);
assert.equal(retargetedSourceFirstReplayQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(retargetedSourceFirstReplayQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_row_target_bound_to_ledger_record'
));

const forgedSourceFirstVisualJobRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-source-first-forged-visual-job'
);
assert.equal(forgedSourceFirstVisualJobRunMode?.matrixOutcome, 'unproven');
assert.equal(forgedSourceFirstVisualJobRunMode.visual.accepted, true);
assert.equal(forgedSourceFirstVisualJobRunMode.visual.allCasLocatorsAccepted, true);
assert.equal(forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.accepted, false);
assert.equal(forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.asyncVisualProofJobPresent, true);
assert.equal(forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.asyncVisualProofJobBinding.present, true);
assert.equal(forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.asyncVisualProofJobBinding.accepted, false);
assert.equal(
  forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.asyncVisualProofJobBinding.jobHashMatches,
  false,
);
assert.equal(
  forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.asyncVisualProofJobBinding.jobManifestHashMatches,
  false,
);
assert.ok(forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.failedGates.includes(
  'async_visual_proof_job_binding_not_accepted',
));
assert.ok(forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.failedGates.includes(
  'async_visual_proof_job_hash_mismatch',
));
assert.ok(forgedSourceFirstVisualJobRunMode.asyncVisualCasBundle.failedGates.includes(
  'async_visual_proof_job_manifest_hash_mismatch',
));

const nonVisualCasMetadataRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-source-first-nonvisual-cas-metadata'
);
assert.equal(nonVisualCasMetadataRunMode?.matrixOutcome, 'unproven');
assert.equal(nonVisualCasMetadataRunMode.visual.accepted, true);
assert.equal(nonVisualCasMetadataRunMode.asyncVisualCasBundle.accepted, false);
assert.equal(nonVisualCasMetadataRunMode.asyncVisualCasBundle.rejectedNonVisualLocatorCount, 1);
assert.equal(nonVisualCasMetadataRunMode.asyncVisualCasBundle.locatorCount, 0);
assert.ok(nonVisualCasMetadataRunMode.asyncVisualCasBundle.failedGates.includes(
  'visual_artifact_transport_non_visual_locator_rejected',
));
assert.ok(nonVisualCasMetadataRunMode.reasons.includes(
  'visual_artifact_transport_non_visual_locator_rejected',
));
assert.ok(nonVisualCasMetadataRunMode.openGaps.includes(
  'visual_artifact_transport_visual_locator_required',
));

const forgedSourceFirstCasRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-source-first-forged-cas'
);
assert.equal(forgedSourceFirstCasRunMode?.matrixOutcome, 'unproven');
assert.equal(forgedSourceFirstCasRunMode.visual.accepted, false);
assert.equal(forgedSourceFirstCasRunMode.visual.allCasLocatorsAccepted, false);
assert.ok(forgedSourceFirstCasRunMode.visual.failedGates.includes(
  'visual_artifact_cas_locator_validation_failed',
));
assert.ok(forgedSourceFirstCasRunMode.asyncVisualCasBundle.failedGates.includes(
  'visual_artifact_cas_locator_validation_failed',
));

const profilePriorityRunMode = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:profile-priority-hot1')
);
assert.equal(profilePriorityRunMode?.targetId, 'profile-priority-generated-target');
assert.equal(profilePriorityRunMode.profileId, 'agent-realistic-test-profile');
assert.equal(profilePriorityRunMode.fixtureId, 'flow');
assert.equal(profilePriorityRunMode.validationProfileId, 'agent-realistic-test-profile');
assert.equal(profilePriorityRunMode.matrixOutcome, 'unproven');

const smuggledPrecompiledRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-smuggled-precompiled'
);
assert.equal(smuggledPrecompiledRunMode?.matrixOutcome, 'unproven');
assert.equal(smuggledPrecompiledRunMode.acceptedForGpuHmr, false);
assert.equal(smuggledPrecompiledRunMode.sourceFirstIngestion.accepted, false);
assert.ok(smuggledPrecompiledRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(smuggledPrecompiledRunMode.reasons.includes('source_first_compile_use_ai_split_missing'));
assert.ok(smuggledPrecompiledRunMode.reasons.includes('source_first_precompiled_generated_artifacts_present'));

const missingArchSourceFirstRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-source-first-missing-arch'
);
assert.equal(missingArchSourceFirstRunMode?.matrixOutcome, 'unproven');
assert.equal(missingArchSourceFirstRunMode.acceptedForGpuHmr, false);
assert.equal(missingArchSourceFirstRunMode.sourceFirstIngestion.accepted, false);
assert.equal(missingArchSourceFirstRunMode.sourceFirstIngestion.gpuArchExplicit, false);
assert.ok(missingArchSourceFirstRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(missingArchSourceFirstRunMode.reasons.includes('source_first_gpu_arch_missing'));

const forgedGeneratedSourcePathRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-forged-generated-source-path'
);
assert.equal(forgedGeneratedSourcePathRunMode?.matrixOutcome, 'unproven');
assert.equal(forgedGeneratedSourcePathRunMode.acceptedForGpuHmr, false);
assert.equal(forgedGeneratedSourcePathRunMode.sourceFirstIngestion.accepted, false);
assert.equal(forgedGeneratedSourcePathRunMode.sourceFirstIngestion.generatedArtifactPathsInGeneratedNamespace, false);
assert.ok(forgedGeneratedSourcePathRunMode.sourceFirstIngestion.failedGates.includes(
  'source_first_generated_artifact_namespace_unproven',
));
assert.ok(forgedGeneratedSourcePathRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(forgedGeneratedSourcePathRunMode.reasons.includes(
  'source_first_generated_artifact_namespace_unproven',
));

const hashOverlapRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-precompiled-hash-overlap'
);
assert.equal(hashOverlapRunMode?.matrixOutcome, 'unproven');
assert.equal(hashOverlapRunMode.acceptedForGpuHmr, false);
assert.equal(hashOverlapRunMode.sourceFirstIngestion.accepted, false);
assert.equal(hashOverlapRunMode.sourceFirstIngestion.preexistingGeneratedArtifactHashOverlaps.length, 1);
assert.equal(
  hashOverlapRunMode.sourceFirstIngestion.preexistingGeneratedArtifactHashOverlaps[0].path,
  'build/cache/device.hip',
);
assert.ok(hashOverlapRunMode.sourceFirstIngestion.failedGates.includes(
  'source_first_precompiled_generated_artifact_hash_overlap',
));
assert.ok(hashOverlapRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(hashOverlapRunMode.reasons.includes(
  'source_first_precompiled_generated_artifact_hash_overlap',
));

const incompletePurityRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-incomplete-source-purity'
);
assert.equal(incompletePurityRunMode?.matrixOutcome, 'unproven');
assert.equal(incompletePurityRunMode.acceptedForGpuHmr, false);
assert.equal(incompletePurityRunMode.sourceFirstIngestion.accepted, false);
assert.equal(incompletePurityRunMode.sourceFirstIngestion.sourcePurityCoversInitialManifest, false);
assert.ok(incompletePurityRunMode.sourceFirstIngestion.failedGates.includes(
  'source_first_seed_purity_manifest_incomplete',
));
assert.ok(incompletePurityRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(incompletePurityRunMode.reasons.includes(
  'source_first_seed_purity_manifest_incomplete',
));

const forgedPurityInitialHashRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-forged-source-purity-initial-hash'
);
assert.equal(forgedPurityInitialHashRunMode?.matrixOutcome, 'unproven');
assert.equal(forgedPurityInitialHashRunMode.acceptedForGpuHmr, false);
assert.equal(forgedPurityInitialHashRunMode.sourceFirstIngestion.accepted, false);
assert.equal(forgedPurityInitialHashRunMode.sourceFirstIngestion.sourcePurityInitialManifestHashMatches, false);
assert.equal(forgedPurityInitialHashRunMode.sourceFirstIngestion.sourcePurityFileSetMatchesInitialManifest, false);
assert.ok(forgedPurityInitialHashRunMode.sourceFirstIngestion.failedGates.includes(
  'source_first_seed_purity_initial_manifest_hash_mismatch',
));
assert.ok(forgedPurityInitialHashRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(forgedPurityInitialHashRunMode.reasons.includes(
  'source_first_seed_purity_initial_manifest_hash_mismatch',
));

const extraPurityRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-extra-source-purity'
);
assert.equal(extraPurityRunMode?.matrixOutcome, 'unproven');
assert.equal(extraPurityRunMode.acceptedForGpuHmr, false);
assert.equal(extraPurityRunMode.sourceFirstIngestion.accepted, false);
assert.equal(extraPurityRunMode.sourceFirstIngestion.sourcePurityFileSetMatchesInitialManifest, false);
assert.ok(extraPurityRunMode.sourceFirstIngestion.failedGates.includes(
  'source_first_seed_purity_file_set_mismatch',
));
assert.ok(extraPurityRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(extraPurityRunMode.reasons.includes(
  'source_first_seed_purity_file_set_mismatch',
));

const sourceTreeManifestMismatchRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-source-tree-manifest-mismatch'
);
assert.equal(sourceTreeManifestMismatchRunMode?.matrixOutcome, 'unproven');
assert.equal(sourceTreeManifestMismatchRunMode.acceptedForGpuHmr, false);
assert.equal(sourceTreeManifestMismatchRunMode.sourceFirstIngestion.accepted, false);
assert.equal(sourceTreeManifestMismatchRunMode.sourceFirstIngestion.sourceAuthority, 'profile_source_files');
assert.equal(sourceTreeManifestMismatchRunMode.sourceFirstIngestion.sourceTreeManifestRequired, true);
assert.equal(sourceTreeManifestMismatchRunMode.sourceFirstIngestion.sourceTreeManifestHashMatches, false);
assert.ok(sourceTreeManifestMismatchRunMode.sourceFirstIngestion.failedGates.includes(
  'source_first_source_tree_manifest_mismatch',
));
assert.ok(sourceTreeManifestMismatchRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(sourceTreeManifestMismatchRunMode.reasons.includes(
  'source_first_source_tree_manifest_mismatch',
));

const emptySourceManifestRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow-empty-source-manifest'
);
assert.equal(emptySourceManifestRunMode?.matrixOutcome, 'unproven');
assert.equal(emptySourceManifestRunMode.acceptedForGpuHmr, false);
assert.equal(emptySourceManifestRunMode.sourceFirstIngestion.accepted, false);
assert.ok(emptySourceManifestRunMode.reasons.includes('source_first_ingestion_not_accepted'));
assert.ok(emptySourceManifestRunMode.reasons.includes('source_first_initial_file_manifest_missing'));
assert.ok(emptySourceManifestRunMode.reasons.includes('source_first_initial_source_file_missing'));

const negativeEdit = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-negative-edit-refusal:sha256:synthetic')
);
assert.equal(negativeEdit?.matrixOutcome, 'refusal_proven');
assert.equal(negativeEdit.runModeCoverageSupport.accepted, true);
assert.equal(negativeEdit.refusalEvidence.accepted, true);
assert.ok(negativeEdit.refusalEvidence.typedRefusalModes.includes('executable_static_check'));

const forgedReasonsOnlyNegativeEdit = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-negative-edit-refusal:sha256:forged-reasons-only')
);
assert.equal(forgedReasonsOnlyNegativeEdit?.matrixOutcome, 'unproven');
assert.equal(forgedReasonsOnlyNegativeEdit.refusalEvidence.accepted, false);
assert.ok(forgedReasonsOnlyNegativeEdit.refusalEvidence.failedGates.includes(
  'negative_edit_cpu_hmr_firewall_not_explicitly_false',
));
assert.ok(forgedReasonsOnlyNegativeEdit.refusalEvidence.failedGates.includes(
  'negative_edit_structural_refusal_proof_missing',
));

const forgedUnlinkedFlowCold = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-unlinked-flow-cold')
);
assert.equal(forgedUnlinkedFlowCold?.matrixOutcome, 'cold_split_proven');
assert.equal(forgedUnlinkedFlowCold.runModeCoverageSupport.accepted, false);
assert.ok(forgedUnlinkedFlowCold.runModeCoverageSupport.failedGates.includes(
  'run_mode_support_parent_proof_id_missing',
));

const forgedFailedSupportCold = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-failed-support-cold')
);
assert.equal(forgedFailedSupportCold?.matrixOutcome, 'cold_split_proven');
assert.equal(forgedFailedSupportCold.runModeCoverageSupport.accepted, false);
assert.ok(forgedFailedSupportCold.runModeCoverageSupport.failedGates.includes(
  'run_mode_support_proof_ledger_not_successful',
));
assert.ok(forgedFailedSupportCold.runModeCoverageSupport.failedGates.includes(
  'run_mode_support_runtime_artifact_gpu_hmr_success_false',
));
assert.ok(forgedFailedSupportCold.runModeCoverageSupport.failedGates.includes(
  'run_mode_support_runtime_artifact_full_runtime_not_proven',
));

const forgedBorrowedSupportCold = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-borrowed-support-cold')
);
assert.equal(forgedBorrowedSupportCold?.matrixOutcome, 'cold_split_proven');
assert.equal(forgedBorrowedSupportCold.runModeCoverageSupport.accepted, false);
assert.ok(forgedBorrowedSupportCold.runModeCoverageSupport.failedGates.includes(
  'run_mode_support_not_bound_to_current_run_mode_artifact',
));

const reverseArtifactNamespaceDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-artifact-namespace-reverse',
);
await writeRgbaPng(path.join(reverseArtifactNamespaceDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(reverseArtifactNamespaceDir, 'after-hmr-first.png'), 8, 8, (x, y) => [92 + x, 104 + y, 132, 255]);
await writeRgbaPng(path.join(reverseArtifactNamespaceDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
const reverseArtifactNamespaceMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'artifact-namespace-reverse',
  visualRoot: reverseArtifactNamespaceDir,
});
const reverseArtifactNamespaceAfterHash = reverseArtifactNamespaceMaterials.proofLedgerQuery.record.artifactAfterHash
  ?? reverseArtifactNamespaceMaterials.proofLedgerQuery.record.artifact_after_hash;
const reverseArtifactNamespaceSupport = runModeCoverageSupportFor(
  reverseArtifactNamespaceMaterials,
  ['agent-split-run-mode-proof:sha256:artifact-namespace-reverse-hot1'],
  { namespaceArtifactAfterHash: false },
);
assert.match(reverseArtifactNamespaceSupport.artifactAfterHash, /^sha256:[a-f0-9]{64}$/);
await writeJson(path.join(reverseArtifactNamespaceDir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:artifact-namespace-reverse-hot1',
    'gpu-runtime-proof:sha256:artifact-namespace-reverse-hot1',
  ),
  ...reverseArtifactNamespaceMaterials,
  targetId: 'artifact-namespace-reverse',
  profileId: 'artifact-namespace-reverse',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-reverse-hot1',
  artifactAfterHash: `artifact:${reverseArtifactNamespaceAfterHash}`,
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: path.join(reverseArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(reverseArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(reverseArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:artifact-namespace-reverse-hot1',
    editHash: hashValue('artifact-namespace-reverse-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});
await writeJson(path.join(reverseArtifactNamespaceDir, 'cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  targetId: 'artifact-namespace-reverse',
  profileId: 'artifact-namespace-reverse',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-reverse-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: bindGpuHmrRunModeCoverageSupport(
    reverseArtifactNamespaceSupport,
    {
      runMode: {
        metricScope: 'cold',
        editHash: hashValue('artifact-namespace-reverse-cold'),
      },
    },
  ),
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  visualArtifacts: visualArtifactSet({
    before: path.join(reverseArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(reverseArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(reverseArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split:artifact-namespace-reverse',
    editHash: hashValue('artifact-namespace-reverse-cold'),
  },
});
const reverseArtifactNamespaceLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [reverseArtifactNamespaceDir],
  generatedAt: '2026-06-09T00:00:01.005Z',
  includeUnproven: true,
});
const reverseArtifactNamespaceCoverage = new Map(
  reverseArtifactNamespaceLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const reverseArtifactNamespaceTarget = reverseArtifactNamespaceCoverage
  .get('per_target_run_modes')?.targetCoverage.find(
    (entry) => entry.targetKey === 'hip:artifact-namespace-reverse',
  );
assert.ok(reverseArtifactNamespaceTarget?.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:artifact-namespace-reverse-cold')
  && row.runModeCoverageSupport?.accepted === true
));

const mismatchedArtifactNamespaceDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-artifact-namespace-mismatch',
);
await writeRgbaPng(path.join(mismatchedArtifactNamespaceDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(mismatchedArtifactNamespaceDir, 'after-hmr-first.png'), 8, 8, (x, y) => [96 + x, 112 + y, 144, 255]);
await writeRgbaPng(path.join(mismatchedArtifactNamespaceDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
const mismatchedArtifactNamespaceMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'artifact-namespace-mismatch',
  visualRoot: mismatchedArtifactNamespaceDir,
});
const mismatchedArtifactNamespaceSupport = {
  ...runModeCoverageSupportFor(
    mismatchedArtifactNamespaceMaterials,
    ['agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-hot1'],
    { namespaceArtifactAfterHash: false },
  ),
  artifactAfterHash: hashValue('different-artifact-namespace-mismatch-after'),
};
await writeJson(path.join(mismatchedArtifactNamespaceDir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:artifact-namespace-mismatch-hot1',
    'gpu-runtime-proof:sha256:artifact-namespace-mismatch-hot1',
  ),
  ...mismatchedArtifactNamespaceMaterials,
  targetId: 'artifact-namespace-mismatch',
  profileId: 'artifact-namespace-mismatch',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: path.join(mismatchedArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(mismatchedArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(mismatchedArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:artifact-namespace-mismatch-hot1',
    editHash: hashValue('artifact-namespace-mismatch-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});
await writeJson(path.join(mismatchedArtifactNamespaceDir, 'cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  targetId: 'artifact-namespace-mismatch',
  profileId: 'artifact-namespace-mismatch',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: bindGpuHmrRunModeCoverageSupport(
    mismatchedArtifactNamespaceSupport,
    {
      runMode: {
        metricScope: 'cold',
        editHash: hashValue('artifact-namespace-mismatch-cold'),
      },
    },
  ),
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  visualArtifacts: visualArtifactSet({
    before: path.join(mismatchedArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(mismatchedArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(mismatchedArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split:artifact-namespace-mismatch',
    editHash: hashValue('artifact-namespace-mismatch-cold'),
  },
});
const mismatchedArtifactNamespaceLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [mismatchedArtifactNamespaceDir],
  generatedAt: '2026-06-09T00:00:01.006Z',
  includeUnproven: true,
});
const mismatchedArtifactNamespaceCoverage = new Map(
  mismatchedArtifactNamespaceLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const mismatchedArtifactNamespaceTarget = mismatchedArtifactNamespaceCoverage
  .get('per_target_run_modes')?.targetCoverage.find(
    (entry) => entry.targetKey === 'hip:artifact-namespace-mismatch',
  );
assert.ok(!mismatchedArtifactNamespaceTarget?.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-cold')
));
assert.ok(mismatchedArtifactNamespaceCoverage.get('per_target_run_modes')?.unlinkedSupportRowCount >= 1);
assert.ok(mismatchedArtifactNamespaceTarget?.openGaps.includes(
  'hip:artifact-namespace-mismatch:cold_evidence_missing',
));

const spoofNamedFlowDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-name-only-profile');
await writeRgbaPng(path.join(spoofNamedFlowDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(spoofNamedFlowDir, 'after.png'), 8, 8, (x, y) => [80 + x, 92 + y, 120, 255]);
await writeRgbaPng(path.join(spoofNamedFlowDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const spoofNamedFlowVisualArtifacts = visualArtifactSet({
  before: path.join(spoofNamedFlowDir, 'before.png'),
  after: path.join(spoofNamedFlowDir, 'after.png'),
  diff: path.join(spoofNamedFlowDir, 'diff.png'),
});
await writeJson(path.join(spoofNamedFlowDir, 'hot1-name-only.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:flow-name-only-hot1', 'gpu-runtime-proof:sha256:flow-name-only-hot1'),
  ...runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
    projectId: 'flow',
    visualRoot: spoofNamedFlowDir,
  }, spoofNamedFlowVisualArtifacts),
  proofId: 'agent-split-run-mode-proof:sha256:flow-name-only-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts('hot_delta_1', spoofNamedFlowDir, spoofNamedFlowVisualArtifacts),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-name-only-hot1',
    editHash: hashValue('flow-name-only-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});
const spoofNamedFlowLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [spoofNamedFlowDir],
  generatedAt: '2026-06-09T00:00:01.010Z',
  includeUnproven: true,
});
const spoofNamedFlowCoverage = new Map(spoofNamedFlowLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
const spoofNamedFlowRuntime = spoofNamedFlowLedger.rows.find((row) => row.targetId === 'flow');
assert.equal(spoofNamedFlowRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(spoofNamedFlowRuntime.validationProfileEvidence.accepted, false);
assert.equal(spoofNamedFlowCoverage.get('flow_visual_gpu_path'), undefined);

const forgedAcceptedProfileDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-non-flow-forged-profile');
await writeRgbaPng(path.join(forgedAcceptedProfileDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedAcceptedProfileDir, 'after.png'), 8, 8, (x, y) => [88 + x, 96 + y, 132, 255]);
await writeRgbaPng(path.join(forgedAcceptedProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const forgedAcceptedProfileVisualArtifacts = visualArtifactSet({
  before: path.join(forgedAcceptedProfileDir, 'before.png'),
  after: path.join(forgedAcceptedProfileDir, 'after.png'),
  diff: path.join(forgedAcceptedProfileDir, 'diff.png'),
});
const forgedAcceptedProfileMaterials = runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
  projectId: 'not-flow-runtime-target',
  visualRoot: forgedAcceptedProfileDir,
}, forgedAcceptedProfileVisualArtifacts);
await writeJson(path.join(forgedAcceptedProfileDir, 'hot1-forged-flow-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    forgedAcceptedProfileMaterials.proofLedgerQuery.record.proofId,
    forgedAcceptedProfileMaterials.runtimeProofArtifact.proofId,
  ),
  ...forgedAcceptedProfileMaterials,
  targetId: 'not-flow-runtime-target',
  profileId: 'not-flow-runtime-target',
  proofId: 'agent-split-run-mode-proof:sha256:not-flow-forged-flow-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
      forgedAcceptedProfileMaterials.proofLedgerQuery.record.proofId,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:not-flow-forged-flow-profile',
      forgedAcceptedProfileMaterials.proofLedgerQuery.record.proofId,
      forgedAcceptedProfileMaterials.runtimeProofArtifact.proofId,
    ],
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts('hot_delta_1', forgedAcceptedProfileDir, forgedAcceptedProfileVisualArtifacts),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:not-flow-forged-profile',
    editHash: hashValue('not-flow-forged-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const forgedAcceptedProfileLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedAcceptedProfileDir],
  generatedAt: '2026-06-09T00:00:01.020Z',
  includeUnproven: true,
});
const forgedAcceptedProfileCoverage = new Map(
  forgedAcceptedProfileLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const forgedAcceptedProfileRuntime = forgedAcceptedProfileLedger.rows.find((row) =>
  row.targetId === 'not-flow-runtime-target'
);
assert.equal(forgedAcceptedProfileRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(forgedAcceptedProfileRuntime.validationProfileEvidence.accepted, false);
assert.ok(forgedAcceptedProfileRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_id_not_bound_to_runtime_identity',
));
assert.equal(forgedAcceptedProfileCoverage.get('flow_visual_gpu_path'), undefined);

const prefixedProfileIdentityDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-flow-prefixed-runtime-identity-profile',
);
await writeRgbaPng(path.join(prefixedProfileIdentityDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(prefixedProfileIdentityDir, 'after.png'), 8, 8, (x, y) => [92 + x, 100 + y, 136, 255]);
await writeRgbaPng(path.join(prefixedProfileIdentityDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const prefixedProfileIdentityVisualArtifacts = visualArtifactSet({
  before: path.join(prefixedProfileIdentityDir, 'before.png'),
  after: path.join(prefixedProfileIdentityDir, 'after.png'),
  diff: path.join(prefixedProfileIdentityDir, 'diff.png'),
});
const prefixedProfileIdentityMaterials = runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
  projectId: 'flow:runtime-target',
  visualRoot: prefixedProfileIdentityDir,
}, prefixedProfileIdentityVisualArtifacts);
await writeJson(path.join(prefixedProfileIdentityDir, 'hot1-prefixed-runtime-identity-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    prefixedProfileIdentityMaterials.proofLedgerQuery.record.proofId,
    prefixedProfileIdentityMaterials.runtimeProofArtifact.proofId,
  ),
  ...prefixedProfileIdentityMaterials,
  targetId: 'flow:runtime-target',
  profileId: 'flow:runtime-target',
  proofId: 'agent-split-run-mode-proof:sha256:flow-prefixed-runtime-identity-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
      prefixedProfileIdentityMaterials.proofLedgerQuery.record.proofId,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-prefixed-runtime-identity-profile',
      prefixedProfileIdentityMaterials.proofLedgerQuery.record.proofId,
      prefixedProfileIdentityMaterials.runtimeProofArtifact.proofId,
    ],
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts(
    'hot_delta_1',
    prefixedProfileIdentityDir,
    prefixedProfileIdentityVisualArtifacts,
  ),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-prefixed-runtime-identity-profile',
    editHash: hashValue('flow-prefixed-runtime-identity-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const prefixedProfileIdentityLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [prefixedProfileIdentityDir],
  generatedAt: '2026-06-09T00:00:01.025Z',
  includeUnproven: true,
});
const prefixedProfileIdentityCoverage = new Map(
  prefixedProfileIdentityLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const prefixedProfileIdentityRuntime = prefixedProfileIdentityLedger.rows.find((row) =>
  row.targetId === 'flow:runtime-target'
);
assert.equal(prefixedProfileIdentityRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(prefixedProfileIdentityRuntime.validationProfileEvidence.accepted, false);
assert.ok(prefixedProfileIdentityRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_id_not_bound_to_runtime_identity',
));
assert.equal(prefixedProfileIdentityCoverage.get('flow_visual_gpu_path'), undefined);

const substringOnlyProfileDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-substring-only-profile');
await writeRgbaPng(path.join(substringOnlyProfileDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(substringOnlyProfileDir, 'after.png'), 8, 8, (x, y) => [96 + x, 112 + y, 144, 255]);
await writeRgbaPng(path.join(substringOnlyProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const substringOnlyProfileVisualArtifacts = visualArtifactSet({
  before: path.join(substringOnlyProfileDir, 'before.png'),
  after: path.join(substringOnlyProfileDir, 'after.png'),
  diff: path.join(substringOnlyProfileDir, 'diff.png'),
});
const substringOnlyProfileMaterials = runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
  projectId: 'flow',
  visualRoot: substringOnlyProfileDir,
}, substringOnlyProfileVisualArtifacts);
await writeJson(path.join(substringOnlyProfileDir, 'hot1-substring-only-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    substringOnlyProfileMaterials.proofLedgerQuery.record.proofId,
    substringOnlyProfileMaterials.runtimeProofArtifact.proofId,
  ),
  ...substringOnlyProfileMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:flow-substring-only-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-substring-only-profile',
      substringOnlyProfileMaterials.proofLedgerQuery.record.proofId,
      substringOnlyProfileMaterials.runtimeProofArtifact.proofId,
    ],
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts('hot_delta_1', substringOnlyProfileDir, substringOnlyProfileVisualArtifacts),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-substring-only-profile',
    editHash: hashValue('flow-substring-only-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const substringOnlyProfileLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [substringOnlyProfileDir],
  generatedAt: '2026-06-09T00:00:01.030Z',
  includeUnproven: true,
});
const substringOnlyProfileCoverage = new Map(
  substringOnlyProfileLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const substringOnlyProfileRuntime = substringOnlyProfileLedger.rows.find((row) => row.targetId === 'flow');
assert.equal(substringOnlyProfileRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(substringOnlyProfileRuntime.validationProfileEvidence.accepted, false);
assert.ok(substringOnlyProfileRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_evidence_refs_not_bound_to_row',
));
assert.equal(substringOnlyProfileCoverage.get('flow_visual_gpu_path'), undefined);

const explicitContractSourceProfileDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-flow-explicit-contract-source-profile',
);
await writeRgbaPng(path.join(explicitContractSourceProfileDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(explicitContractSourceProfileDir, 'after.png'), 8, 8, (x, y) => [104 + x, 124 + y, 148, 255]);
await writeRgbaPng(path.join(explicitContractSourceProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const explicitContractSourceProfileVisualArtifacts = visualArtifactSet({
  before: path.join(explicitContractSourceProfileDir, 'before.png'),
  after: path.join(explicitContractSourceProfileDir, 'after.png'),
  diff: path.join(explicitContractSourceProfileDir, 'diff.png'),
});
const explicitContractSourceProfileMaterials = runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
  projectId: 'flow',
  visualRoot: explicitContractSourceProfileDir,
}, explicitContractSourceProfileVisualArtifacts);
await writeJson(path.join(explicitContractSourceProfileDir, 'hot1-explicit-contract-source-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    explicitContractSourceProfileMaterials.proofLedgerQuery.record.proofId,
    explicitContractSourceProfileMaterials.runtimeProofArtifact.proofId,
  ),
  ...explicitContractSourceProfileMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:flow-explicit-contract-source-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    source: 'explicit_validation_matrix_profile_contract',
    evidenceRefs: [
      explicitContractSourceProfileMaterials.proofLedgerQuery.record.proofId,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-explicit-contract-source-profile',
      explicitContractSourceProfileMaterials.proofLedgerQuery.record.proofId,
      explicitContractSourceProfileMaterials.runtimeProofArtifact.proofId,
    ],
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts(
    'hot_delta_1',
    explicitContractSourceProfileDir,
    explicitContractSourceProfileVisualArtifacts,
  ),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-explicit-contract-source-profile',
    editHash: hashValue('flow-explicit-contract-source-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const explicitContractSourceProfileLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [explicitContractSourceProfileDir],
  generatedAt: '2026-06-09T00:00:01.040Z',
  includeUnproven: true,
});
const explicitContractSourceProfileCoverage = new Map(
  explicitContractSourceProfileLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const explicitContractSourceProfileRuntime = explicitContractSourceProfileLedger.rows.find((row) =>
  row.targetId === 'flow'
);
assert.equal(explicitContractSourceProfileRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(explicitContractSourceProfileRuntime.validationProfileEvidence.accepted, false);
assert.ok(explicitContractSourceProfileRuntime.validationProfileEvidence.binding.accepted);
assert.ok(explicitContractSourceProfileRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_evidence_source_not_authorized',
));
assert.equal(explicitContractSourceProfileCoverage.get('flow_visual_gpu_path'), undefined);

const hashBoundProfileDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-hash-bound-profile');
await writeRgbaPng(path.join(hashBoundProfileDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(hashBoundProfileDir, 'after.png'), 8, 8, (x, y) => [112 + x, 132 + y, 156, 255]);
await writeRgbaPng(path.join(hashBoundProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const hashBoundProfileVisualArtifacts = visualArtifactSet({
  before: path.join(hashBoundProfileDir, 'before.png'),
  after: path.join(hashBoundProfileDir, 'after.png'),
  diff: path.join(hashBoundProfileDir, 'diff.png'),
});
const boundProfileHash = hashValue('flow-profile-hash-bound');
const boundSourceHash = hashValue('flow-source-hash-bound');
const boundDeterministicModeHash = hashValue('flow-deterministic-mode-hash-bound');
const boundVisualProofHash = hashValue('flow-visual-proof-hash-bound');
const boundVisualSceneManifestHash = hashValue('flow-visual-scene-manifest-hash-bound');
const hashBoundProfileMaterials = runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
  projectId: 'flow',
  visualRoot: hashBoundProfileDir,
  extraEvidenceRefs: [boundVisualSceneManifestHash],
}, hashBoundProfileVisualArtifacts);
await writeJson(path.join(hashBoundProfileDir, 'hot1-hash-bound-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    hashBoundProfileMaterials.proofLedgerQuery.record.proofId,
    hashBoundProfileMaterials.runtimeProofArtifact.proofId,
  ),
  ...hashBoundProfileMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:flow-hash-bound-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
      hashBoundProfileMaterials.proofLedgerQuery.record.proofId,
      boundProfileHash,
      boundSourceHash,
      boundDeterministicModeHash,
      boundVisualProofHash,
      boundVisualSceneManifestHash,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-hash-bound-profile',
      hashBoundProfileMaterials.proofLedgerQuery.record.proofId,
      hashBoundProfileMaterials.runtimeProofArtifact.proofId,
    ],
    profileHash: boundProfileHash,
    sourceContentHash: boundSourceHash,
    declaredSourceContentHash: boundSourceHash,
    deterministicVisualModeHash: boundDeterministicModeHash,
    visualProofHash: boundVisualProofHash,
    visualSceneManifestHash: boundVisualSceneManifestHash,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts('hot_delta_1', hashBoundProfileDir, hashBoundProfileVisualArtifacts),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-hash-bound-profile',
    editHash: hashValue('flow-hash-bound-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const hashBoundProfileLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [hashBoundProfileDir],
  generatedAt: '2026-06-09T00:00:01.050Z',
  includeUnproven: true,
});
const hashBoundProfileRuntime = hashBoundProfileLedger.rows.find((row) => row.targetId === 'flow');
assert.equal(hashBoundProfileRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(hashBoundProfileRuntime.validationProfileEvidence.accepted, true);
assert.equal(hashBoundProfileRuntime.validationProfileEvidence.binding.sourceContentHashBoundToEvidenceRefs, true);
assert.equal(hashBoundProfileRuntime.validationProfileEvidence.binding.visualSceneManifestHashBoundToEvidenceRefs, true);

const unboundSceneManifestProfileDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-flow-unbound-scene-manifest-profile',
);
await writeRgbaPng(path.join(unboundSceneManifestProfileDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(unboundSceneManifestProfileDir, 'after.png'), 8, 8, (x, y) => [118 + x, 130 + y, 172, 255]);
await writeRgbaPng(path.join(unboundSceneManifestProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const unboundSceneManifestVisualArtifacts = visualArtifactSet({
  before: path.join(unboundSceneManifestProfileDir, 'before.png'),
  after: path.join(unboundSceneManifestProfileDir, 'after.png'),
  diff: path.join(unboundSceneManifestProfileDir, 'diff.png'),
});
const unboundSceneManifestMaterials = runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
  projectId: 'flow',
  visualRoot: unboundSceneManifestProfileDir,
}, unboundSceneManifestVisualArtifacts);
await writeJson(path.join(unboundSceneManifestProfileDir, 'hot1-unbound-scene-manifest-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    unboundSceneManifestMaterials.proofLedgerQuery.record.proofId,
    unboundSceneManifestMaterials.runtimeProofArtifact.proofId,
  ),
  ...unboundSceneManifestMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:flow-unbound-scene-manifest-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
      unboundSceneManifestMaterials.proofLedgerQuery.record.proofId,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-unbound-scene-manifest-profile',
      unboundSceneManifestMaterials.proofLedgerQuery.record.proofId,
      unboundSceneManifestMaterials.runtimeProofArtifact.proofId,
    ],
    visualSceneManifestHash: hashValue('flow-unbound-scene-manifest-hash'),
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts(
    'hot_delta_1',
    unboundSceneManifestProfileDir,
    unboundSceneManifestVisualArtifacts,
  ),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-unbound-scene-manifest-profile',
    editHash: hashValue('flow-unbound-scene-manifest-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const unboundSceneManifestLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [unboundSceneManifestProfileDir],
  generatedAt: '2026-06-09T00:00:01.055Z',
  includeUnproven: true,
});
const unboundSceneManifestRuntime = unboundSceneManifestLedger.rows.find((row) => row.targetId === 'flow');
assert.equal(unboundSceneManifestRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(unboundSceneManifestRuntime.validationProfileEvidence.accepted, false);
assert.ok(unboundSceneManifestRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_visual_scene_manifest_hash_not_bound_to_evidence_refs',
));

const mismatchedSourceHashProfileDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-flow-source-hash-mismatch-profile',
);
await writeRgbaPng(path.join(mismatchedSourceHashProfileDir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(mismatchedSourceHashProfileDir, 'after.png'), 8, 8, (x, y) => [120 + x, 140 + y, 164, 255]);
await writeRgbaPng(path.join(mismatchedSourceHashProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const mismatchedSourceHashVisualArtifacts = visualArtifactSet({
  before: path.join(mismatchedSourceHashProfileDir, 'before.png'),
  after: path.join(mismatchedSourceHashProfileDir, 'after.png'),
  diff: path.join(mismatchedSourceHashProfileDir, 'diff.png'),
});
const mismatchedSourceHashMaterials = runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
  projectId: 'flow',
  visualRoot: mismatchedSourceHashProfileDir,
}, mismatchedSourceHashVisualArtifacts);
const mismatchedActualSourceHash = hashValue('flow-source-actual');
const mismatchedDeclaredSourceHash = hashValue('flow-source-declared');
await writeJson(path.join(mismatchedSourceHashProfileDir, 'hot1-source-hash-mismatch-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    mismatchedSourceHashMaterials.proofLedgerQuery.record.proofId,
    mismatchedSourceHashMaterials.runtimeProofArtifact.proofId,
  ),
  ...mismatchedSourceHashMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:flow-source-hash-mismatch-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
      mismatchedSourceHashMaterials.proofLedgerQuery.record.proofId,
      mismatchedActualSourceHash,
      mismatchedDeclaredSourceHash,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-source-hash-mismatch-profile',
      mismatchedSourceHashMaterials.proofLedgerQuery.record.proofId,
      mismatchedSourceHashMaterials.runtimeProofArtifact.proofId,
    ],
    sourceContentHash: mismatchedActualSourceHash,
    declaredSourceContentHash: mismatchedDeclaredSourceHash,
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts(
    'hot_delta_1',
    mismatchedSourceHashProfileDir,
    mismatchedSourceHashVisualArtifacts,
  ),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-source-hash-mismatch-profile',
    editHash: hashValue('flow-source-hash-mismatch-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const mismatchedSourceHashLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [mismatchedSourceHashProfileDir],
  generatedAt: '2026-06-09T00:00:01.060Z',
  includeUnproven: true,
});
const mismatchedSourceHashRuntime = mismatchedSourceHashLedger.rows.find((row) => row.targetId === 'flow');
assert.equal(mismatchedSourceHashRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(mismatchedSourceHashRuntime.validationProfileEvidence.accepted, false);
assert.ok(mismatchedSourceHashRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_source_hash_mismatch',
));

const duplicateHot2Dir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-duplicate-hot2');
await writeRgbaPng(path.join(duplicateHot2Dir, 'before.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(duplicateHot2Dir, 'after.png'), 8, 8, (x, y) => [64 + x, 72 + y, 96, 255]);
await writeRgbaPng(path.join(duplicateHot2Dir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const duplicateHot2VisualArtifacts = visualArtifactSet({
  before: path.join(duplicateHot2Dir, 'before.png'),
  after: path.join(duplicateHot2Dir, 'after.png'),
  diff: path.join(duplicateHot2Dir, 'diff.png'),
});
await writeJson(path.join(duplicateHot2Dir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:duplicate-hot1', 'gpu-runtime-proof:sha256:duplicate-hot1'),
  ...runtimeProofMaterialsWithVisualArtifacts('hot_delta_1', {
    projectId: 'duplicate-hot2',
    visualRoot: duplicateHot2Dir,
  }, duplicateHot2VisualArtifacts),
  targetId: 'duplicate-hot2',
  profileId: 'duplicate-hot2',
  proofId: 'agent-split-run-mode-proof:sha256:duplicate-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts('hot_delta_1', duplicateHot2Dir, duplicateHot2VisualArtifacts),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot1',
    editHash: hashValue('same-edit'),
  },
});
await writeJson(path.join(duplicateHot2Dir, 'hot2.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:duplicate-hot2', 'gpu-runtime-proof:sha256:duplicate-hot2'),
  ...runtimeProofMaterialsWithVisualArtifacts('hot_delta_2', {
    projectId: 'duplicate-hot2',
    visualRoot: duplicateHot2Dir,
  }, duplicateHot2VisualArtifacts),
  targetId: 'duplicate-hot2',
  profileId: 'duplicate-hot2',
  proofId: 'agent-split-run-mode-proof:sha256:duplicate-hot2',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: completeVisualOracleArtifacts('hot_delta_2', duplicateHot2Dir, duplicateHot2VisualArtifacts),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot2',
    editHash: hashValue('same-edit'),
    editKind: 'gpu_artifact_edit',
    differentEdit: false,
  },
});
const duplicateLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [duplicateHot2Dir],
  generatedAt: '2026-06-09T00:00:01.000Z',
  includeUnproven: true,
});
const duplicateCoverage = new Map(duplicateLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(duplicateCoverage.get('per_target_run_modes')?.status, 'missing');
assert.ok(duplicateCoverage.get('per_target_run_modes')?.openGaps.includes(
  'hip:duplicate-hot2:hot_delta_2_different_edit_evidence_missing',
));

const fissionRow = ledger.rows.find((row) => row.matrixOutcome === 'deterministic_fission_proven');
assert.equal(fissionRow?.acceptedForGpuHmr, false);
assert.equal(fissionRow.proofChainAccepted, true);
assert.equal(fissionRow.acceptanceClass, 'smallest_safe_per_kernel_fission');

const acceptedRealRocmDir = path.join(logsRoot, 'real-rocm-accepted-lib');
await writeRgbaPng(path.join(acceptedRealRocmDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(acceptedRealRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [80 + x, 96 + y, 128, 255]);
await writeRgbaPng(path.join(acceptedRealRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(acceptedRealRocmDir, 'real-rocm-accepted.json'), {
  slug: 'gpu-real-rocm-accepted-lib-20260623',
  real_rocm_profile: { id: 'real-rocm-accepted-lib' },
  source_url: 'https://example.invalid/rocm/accepted-lib.git',
  repo_commit: 'abcdef0123456789abcdef0123456789abcdef01',
  entry_file: 'src/kernels/accepted_entry.hip',
  delta_file: 'src/kernels/accepted_delta.h',
  target_name: 'AcceptedRocmDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'runtime_output_oracle_evidence',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
    targetName: 'AcceptedRocmSmallOracle',
    finalAcceptanceTarget: 'AcceptedRocmDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: false,
    nonFinalPhase: true,
    nonFinalTargetRequired: true,
    requirements: ['target_must_not_be_final_acceptance_target_when_declared', 'output_oracle_proven'],
  },
  target_progression_gates: [
    {
      name: 'target progression phase',
      status: 'pass',
      detail: 'phase=small-oracle target=AcceptedRocmSmallOracle final_target=AcceptedRocmDriver',
    },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-accepted-lib',
    visualRoot: acceptedRealRocmDir,
  }),
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(acceptedRealRocmDir, 'before-hmr-first.png'),
    after: path.join(acceptedRealRocmDir, 'after-hmr-first.png'),
    diff: path.join(acceptedRealRocmDir, 'before-after-diff.png'),
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-lib-delta',
    editHash: hashValue('real-rocm-accepted-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-lib.git @ abcdef012345 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedRealRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedRealRocmDir],
  generatedAt: '2026-06-09T00:00:02.000Z',
  includeUnproven: true,
});
const acceptedRealRocm = acceptedRealRocmLedger.rows.find((row) => row.proofMode === 'real_rocm_repo_validation');
assert.equal(acceptedRealRocm?.matrixOutcome, 'target_progression_evidence');
assert.equal(acceptedRealRocm.acceptedForGpuHmr, false);
assert.equal(acceptedRealRocm.gpuHmrSuccess, false);
assert.equal(acceptedRealRocm.targetProgressionEvidence, true);
assert.equal(acceptedRealRocm.proofChainAccepted, true);
assert.equal(acceptedRealRocm.ledger.source, 'recomputed_ledger');
assert.equal(acceptedRealRocm.runtimeProofArtifact.accepted, true);
assert.equal(acceptedRealRocm.visual.present, true);
assert.equal(acceptedRealRocm.visual.accepted, true);
assert.equal(acceptedRealRocm.outputOracleResolution.selectedSource, 'runtime_output_oracle_evidence');
assert.equal(acceptedRealRocm.outputOracleResolution.contractPresent, true);
assert.equal(acceptedRealRocm.targetProgression.phase, 'small-oracle');
assert.equal(acceptedRealRocm.targetProgressionGates[0]?.status, 'pass');
assert.ok(!acceptedRealRocm.targetProgressionGates.some((gate) => gate.status === 'fail'));
assert.equal(acceptedRealRocm.coverageObligations.perTargetRunModes, false);
assert.equal(acceptedRealRocm.validationTargetScope, 'evidence_row');
assert.equal(acceptedRealRocm.cpuHmrUsed, false);
assert.equal(acceptedRealRocm.fullRebuildUsed, false);
assert.equal(acceptedRealRocm.processRestarted, false);
assert.equal(acceptedRealRocm.realRocmFirewall.accepted, true);
assert.equal(acceptedRealRocm.realRocmFirewall.firewallEvidenceSource, 'proof_ledger_invariant_summary');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.accepted, true);
assert.equal(acceptedRealRocm.realRocmRuntimeChain.selectedLoaderTransport, 'ram_bytes');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.runtimeSessionId, 'runtime-session:hot_delta_1');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.dispatchTableEntryId, 'dispatch-table-entry:hot_delta_1');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.outputTargetId, 'output-target:hot_delta_1');
assert.equal(acceptedRealRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(acceptedRealRocm.realRocmRuntimeCapabilityPreflight.accepted, true);
assert.equal(acceptedRealRocm.realRocmRuntimeCapabilityPreflight.observed, true);
assert.equal(acceptedRealRocm.realRocmSidecarRuntimeConsistencyGate.accepted, true);
assert.equal(acceptedRealRocm.realRocmSidecarRuntimeConsistencyGate.notApplicable, true);
const acceptedRealRocmCoverage = new Map(acceptedRealRocmLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(acceptedRealRocmCoverage.get('large_real_rocm_repo')?.status, 'missing');
assert.equal(acceptedRealRocmCoverage.get('large_real_rocm_repo:real-rocm-accepted-lib'), undefined);
assert.equal(acceptedRealRocmCoverage.get('per_target_run_modes')?.status, 'missing');
assert.equal(acceptedRealRocmCoverage.get('per_target_run_modes')?.targetCoverage.length, 0);
const acceptedRealRocmDefaultLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedRealRocmDir],
  generatedAt: '2026-06-09T00:00:02.001Z',
  includeUnproven: false,
});
assert.ok(acceptedRealRocmDefaultLedger.rows.some((row) =>
  row.proofMode === 'real_rocm_repo_validation'
  && row.matrixOutcome === 'target_progression_evidence'
  && row.acceptedForGpuHmr === false
));

const acceptedRealRocmSidecarDir = path.join(logsRoot, 'real-rocm-accepted-sidecar');
await writeRgbaPng(path.join(acceptedRealRocmSidecarDir, 'before-hmr-first.png'), 8, 8, () => [8, 12, 16, 255]);
await writeRgbaPng(path.join(acceptedRealRocmSidecarDir, 'after-hmr-first.png'), 8, 8, (x, y) => [120 + x, 64 + y, 192, 255]);
await writeRgbaPng(path.join(acceptedRealRocmSidecarDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(acceptedRealRocmSidecarDir, 'real-rocm-accepted-sidecar.json'), {
  slug: 'gpu-real-rocm-accepted-sidecar-20260625',
  real_rocm_profile: {
    id: 'real-rocm-accepted-sidecar',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
  },
  source_url: 'https://example.invalid/rocm/accepted-sidecar.git',
  repo_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  entry_file: 'src/sidecar/kernel.hip',
  delta_file: 'src/sidecar/kernel_delta.h',
  target_name: 'AcceptedSidecarDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
    targetName: 'AcceptedSidecarSmallOracle',
    finalAcceptanceTarget: 'AcceptedSidecarDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: false,
    nonFinalPhase: true,
    nonFinalTargetRequired: true,
    requirements: ['target_must_not_be_final_acceptance_target_when_declared', 'output_oracle_proven'],
  },
  target_progression_gates: [
    {
      name: 'target progression phase',
      status: 'pass',
      detail: 'phase=small-oracle target=AcceptedSidecarSmallOracle final_target=AcceptedSidecarDriver',
    },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...realRocmRuntimeProofMaterialsWithSidecar('hot_delta_1', {
    projectId: 'real-rocm-accepted-sidecar',
    visualRoot: acceptedRealRocmSidecarDir,
    deviceSidecarOverrides: {
      artifact_identity: {
        source_paths: ['src/sidecar/kernel.hip'],
        artifact_kind: 'hsaco',
        entry_points: ['accepted_sidecar_kernel'],
        compile_target: 'gfx1201',
        compiler: '/opt/rocm/llvm/bin/amdclang++',
        compiler_args_hash: hashValue('sidecar-compile-args:accepted-sidecar'),
      },
    },
  }),
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(acceptedRealRocmSidecarDir, 'before-hmr-first.png'),
    after: path.join(acceptedRealRocmSidecarDir, 'after-hmr-first.png'),
    diff: path.join(acceptedRealRocmSidecarDir, 'before-after-diff.png'),
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-sidecar-delta',
    editHash: hashValue('real-rocm-accepted-sidecar-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-sidecar.git @ abcdefabcdef files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedRealRocmSidecarLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedRealRocmSidecarDir],
  generatedAt: '2026-06-25T00:00:02.000Z',
  includeUnproven: true,
});
const acceptedRealRocmSidecar = acceptedRealRocmSidecarLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedRealRocmSidecar?.matrixOutcome, 'target_progression_evidence');
assert.equal(acceptedRealRocmSidecar.acceptedForGpuHmr, false);
assert.equal(acceptedRealRocmSidecar.gpuHmrSuccess, false);
assert.equal(acceptedRealRocmSidecar.targetProgressionEvidence, true);
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistencyGate.accepted, true);
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistencyGate.notApplicable, false);
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistency.status, 'sidecar_runtime_consistency_proven');
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistency.canSatisfyRuntimeProof, true);
assert.equal(acceptedRealRocmSidecar.realRocmDeviceSidecarContract.runtimeObservationComplete, true);
assert.equal(acceptedRealRocmSidecar.realRocmDeviceSidecarContract.canSatisfyRuntimeProof, true);

async function writeForgedRealRocmAcceptanceGateCase({
  slug,
  outputOracleResolution = null,
  runtimeCapabilityPreflight = null,
  mutateMaterials = null,
  expectedMatrixOutcome = 'target_progression_evidence',
  expectedReasons = [],
  expectedOpenGaps = [],
}) {
  const dir = path.join(logsRoot, `real-rocm-forged-${slug}`);
  await writeRgbaPng(path.join(dir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
  await writeRgbaPng(path.join(dir, 'after-hmr-first.png'), 8, 8, (x, y) => [84 + x, 100 + y, 132, 255]);
  await writeRgbaPng(path.join(dir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
  const materials = realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: `real-rocm-forged-${slug}`,
    visualRoot: dir,
  });
  if (runtimeCapabilityPreflight !== null) {
    materials.runtimeCapabilityPreflight = runtimeCapabilityPreflight;
    materials.runtime_capability_preflight = runtimeCapabilityPreflight;
    materials.runtimeProofArtifact.runtimeCapabilityPreflight = runtimeCapabilityPreflight;
    materials.runtimeProofArtifact.runtime_capability_preflight = runtimeCapabilityPreflight;
    materials.runtime_proof_artifact.runtimeCapabilityPreflight = runtimeCapabilityPreflight;
    materials.runtime_proof_artifact.runtime_capability_preflight = runtimeCapabilityPreflight;
  }
  if (typeof mutateMaterials === 'function') mutateMaterials(materials);
  await writeJson(path.join(dir, `real-rocm-forged-${slug}.json`), {
    slug: `gpu-real-rocm-forged-${slug}-20260623`,
    real_rocm_profile: { id: `real-rocm-forged-${slug}` },
    source_url: `https://example.invalid/rocm/forged-${slug}.git`,
    repo_commit: 'dededededededededededededededededededede',
    entry_file: 'src/kernels/gate_entry.hip',
    delta_file: 'src/kernels/gate_delta.h',
    target_name: `ForgedGate${slug}`,
    gpu_vendor: 'rocm',
    full_runtime_proof_required: true,
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: outputOracleResolution ?? {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      sourceDerivedCandidateCount: 0,
      selectedSource: 'profile_runtime_profile',
      disabledReason: null,
      failedReason: null,
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    target_progression: {
      schemaVersion: 'synthi.real_rocm.target_progression.v1',
      required: false,
      phaseRaw: 'small-oracle',
      phase: 'small-oracle',
      recognized: true,
      reason: null,
    },
    target_progression_gates: [
      { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
    ],
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    ...materials,
    visualEvidenceArtifacts: visualArtifactSet({
      before: path.join(dir, 'before-hmr-first.png'),
      after: path.join(dir, 'after-hmr-first.png'),
      diff: path.join(dir, 'before-after-diff.png'),
    }),
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `real-rocm-forged-${slug}-delta`,
      editHash: hashValue(`real-rocm-forged-${slug}-delta`),
    },
    checks: [
      {
        name: 'real ROCm repo',
        status: 'pass',
        detail: `https://example.invalid/rocm/forged-${slug}.git @ dededede files=16000`,
      },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const forgedLedger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-09T00:00:02.010Z',
    includeUnproven: true,
  });
  const row = forgedLedger.rows.find((entry) => entry.proofMode === 'real_rocm_repo_validation');
  assert.equal(row?.matrixOutcome, expectedMatrixOutcome);
  assert.equal(row.acceptedForGpuHmr, false);
  assert.equal(row.gpuHmrSuccess, false);
  assert.equal(row.runtimeProofArtifact.accepted, true);
  assert.equal(row.ledger.gpuHmrSuccess, true);
  for (const reason of expectedReasons) {
    assert.ok(row.reasons.includes(reason), `${reason} actual=${stableJson(row.reasons)}`);
  }
  for (const gap of expectedOpenGaps) {
    assert.ok(row.openGaps.includes(gap), `${gap} actual=${stableJson(row.openGaps)}`);
  }
  return row;
}

const forgedUndertypedPreflightRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'undertyped-runtime-preflight',
  runtimeCapabilityPreflight: { backend: 'rocm' },
  expectedReasons: [
    'real_rocm_runtime_capability_preflight_not_proven',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_schema_missing',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_not_observed',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_api_missing',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_probe_missing',
  ],
  expectedOpenGaps: [
    'real_rocm_runtime_capability_preflight_failed',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_evidence_refs_missing',
  ],
});
assert.equal(forgedUndertypedPreflightRocm.realRocmRuntimeCapabilityPreflight.accepted, false);

const forgedUndertypedOutputResolutionRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'undertyped-output-resolution',
  outputOracleResolution: {
    selectedSource: 'profile_runtime_profile',
  },
  expectedReasons: ['real_rocm_output_oracle_resolution_not_accepted'],
  expectedOpenGaps: [
    'real_rocm_output_oracle_resolution_required',
    'real_rocm_output_oracle_resolution_schema_missing',
    'real_rocm_output_oracle_contract_not_explicitly_present',
    'real_rocm_output_oracle_runtime_profile_not_explicitly_present',
    'real_rocm_output_oracle_runtime_profile_sync_not_explicitly_proven',
  ],
});
assert.equal(forgedUndertypedOutputResolutionRocm.outputOracleResolutionGate.accepted, false);

const forgedUnsupportedOutputResolutionRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'unsupported-output-resolution-source',
  outputOracleResolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'serialized_success_flag',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  expectedReasons: ['real_rocm_output_oracle_resolution_not_accepted'],
  expectedOpenGaps: [
    'real_rocm_output_oracle_resolution_required',
    'real_rocm_output_oracle_source_unsupported',
  ],
});
assert.equal(forgedUnsupportedOutputResolutionRocm.outputOracleResolutionGate.accepted, false);

const forgedSourceDerivedOutputResolutionRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'source-derived-output-resolution-source',
  outputOracleResolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'hip.matrix-multiplication.readback-c.v1',
    mode: 'hip.matrix-multiplication.readback-c.v1',
    sourceDerivedCandidateCount: 1,
    selectedSource: 'source_derived_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  expectedReasons: ['real_rocm_output_oracle_resolution_not_accepted'],
  expectedOpenGaps: [
    'real_rocm_output_oracle_resolution_required',
    'real_rocm_output_oracle_source_derived_profile_not_runtime_authority',
  ],
});
assert.equal(forgedSourceDerivedOutputResolutionRocm.outputOracleResolutionGate.accepted, false);
assert.equal(
  forgedSourceDerivedOutputResolutionRocm.outputOracleResolutionGate.sourceDerivedProfileSelected,
  true,
);

const forgedMissingSidecarRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'missing-sidecar-consistency',
  mutateMaterials(materials) {
    delete materials.runtimeProofArtifact.realRocmSidecarRuntimeConsistency;
    delete materials.runtimeProofArtifact.real_rocm_sidecar_runtime_consistency;
    delete materials.runtime_proof_artifact.realRocmSidecarRuntimeConsistency;
    delete materials.runtime_proof_artifact.real_rocm_sidecar_runtime_consistency;
  },
  expectedReasons: [
    'real_rocm_sidecar_runtime_consistency_not_proven',
    'real_rocm_sidecar_runtime_consistency:real_rocm_sidecar_runtime_consistency_missing',
  ],
  expectedOpenGaps: ['real_rocm_sidecar_runtime_consistency_required'],
});
assert.equal(forgedMissingSidecarRocm.realRocmSidecarRuntimeConsistencyGate.accepted, false);

const forgedHintOnlySidecarRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'hint-only-sidecar-consistency',
  mutateMaterials(materials) {
    const hintOnlySidecarConsistency = {
      ...materials.runtimeProofArtifact.realRocmSidecarRuntimeConsistency,
      status: 'sidecar_runtime_backend_hint_consistent_not_runtime_proof',
      proofAuthority: 'sidecar_backend_hint_only_not_runtime_authority',
      proof_authority: 'sidecar_backend_hint_only_not_runtime_authority',
      runtimeBoundBackendCandidates: [],
      runtime_bound_backend_candidates: [],
      runtimeBackendEvidenceAuthority: 'diagnostic_backend_hints_only_not_runtime_authority',
      runtime_backend_evidence_authority: 'diagnostic_backend_hints_only_not_runtime_authority',
      runtimeBackendRuntimeEvidenceAccepted: false,
      runtime_backend_runtime_evidence_accepted: false,
      backendConsistencySource: 'profile_build_compiler_hint',
      backend_consistency_source: 'profile_build_compiler_hint',
      backendHintConsistent: true,
      backend_hint_consistent: true,
      backendConsistent: true,
      backend_consistent: true,
      accepted: true,
      runtimeConsistencyAccepted: true,
      runtime_consistency_accepted: true,
      notApplicable: false,
      not_applicable: false,
      canSatisfyRuntimeProof: true,
      can_satisfy_runtime_proof: true,
      sidecarBackend: 'hip',
      sidecar_backend: 'hip',
      runtimeBackendCandidates: ['hip'],
      runtime_backend_candidates: ['hip'],
      blockingGaps: [],
      blocking_gaps: [],
    };
    materials.realRocmSidecarRuntimeConsistency = hintOnlySidecarConsistency;
    materials.real_rocm_sidecar_runtime_consistency = hintOnlySidecarConsistency;
    materials.runtimeProofArtifact.realRocmSidecarRuntimeConsistency = hintOnlySidecarConsistency;
    materials.runtimeProofArtifact.real_rocm_sidecar_runtime_consistency = hintOnlySidecarConsistency;
    materials.runtime_proof_artifact.realRocmSidecarRuntimeConsistency = hintOnlySidecarConsistency;
    materials.runtime_proof_artifact.real_rocm_sidecar_runtime_consistency = hintOnlySidecarConsistency;
  },
  expectedReasons: [
    'real_rocm_sidecar_runtime_consistency_not_proven',
    'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_runtime_evidence_missing',
    'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_evidence_not_runtime_bound',
  ],
  expectedOpenGaps: [
    'real_rocm_sidecar_runtime_consistency_required',
    'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_runtime_evidence_missing',
    'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_evidence_not_runtime_bound',
  ],
});
assert.equal(forgedHintOnlySidecarRocm.realRocmSidecarRuntimeConsistencyGate.accepted, false);
assert.equal(
  forgedHintOnlySidecarRocm.realRocmSidecarRuntimeConsistencyGate.runtimeBackendEvidenceAuthority,
  'diagnostic_backend_hints_only_not_runtime_authority',
);
assert.equal(
  forgedHintOnlySidecarRocm.realRocmSidecarRuntimeConsistencyGate.runtimeBackendRuntimeEvidenceAccepted,
  false,
);
assert.equal(
  forgedHintOnlySidecarRocm.realRocmSidecarRuntimeConsistencyGate.backendConsistencySource,
  'profile_build_compiler_hint',
);

async function writeForgedRealRocmFirewallCase({ slug, field, expectedReason }) {
  const dir = path.join(logsRoot, `real-rocm-forged-${slug}`);
  await writeRgbaPng(path.join(dir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
  await writeRgbaPng(path.join(dir, 'after-hmr-first.png'), 8, 8, (x, y) => [90 + x, 104 + y, 140, 255]);
  await writeRgbaPng(path.join(dir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
  const materials = realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: `real-rocm-forged-${slug}`,
    visualRoot: dir,
  });
  const record = materials.proofLedger.records[0];
  if (field === 'cpu') {
    record.cpuHmrUsed = true;
    record.cpu_hmr_used = true;
  } else if (field === 'full_rebuild') {
    record.fullRebuildUsed = true;
    record.full_rebuild_used = true;
  } else if (field === 'process_restart') {
    record.processRestarted = true;
    record.process_restarted = true;
  }
  await writeJson(path.join(dir, `real-rocm-forged-${slug}.json`), {
    slug: `gpu-real-rocm-forged-${slug}-20260623`,
    real_rocm_profile: { id: `real-rocm-forged-${slug}` },
    source_url: `https://example.invalid/rocm/forged-${slug}.git`,
    repo_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    entry_file: 'src/kernels/firewall_entry.hip',
    delta_file: 'src/kernels/firewall_delta.h',
    target_name: `ForgedFirewall${slug}`,
    gpu_vendor: 'rocm',
    full_runtime_proof_required: true,
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      selectedSource: 'profile_runtime_profile',
      disabledReason: null,
      failedReason: null,
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    target_progression: {
      schemaVersion: 'synthi.real_rocm.target_progression.v1',
      required: false,
      phaseRaw: 'small-oracle',
      phase: 'small-oracle',
      recognized: true,
      reason: null,
    },
    target_progression_gates: [
      { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
    ],
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    ...materials,
    visualEvidenceArtifacts: visualArtifactSet({
      before: path.join(dir, 'before-hmr-first.png'),
      after: path.join(dir, 'after-hmr-first.png'),
      diff: path.join(dir, 'before-after-diff.png'),
    }),
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `real-rocm-forged-${slug}-delta`,
      editHash: hashValue(`real-rocm-forged-${slug}-delta`),
    },
    checks: [
      { name: 'real ROCm repo', status: 'pass', detail: `https://example.invalid/rocm/forged-${slug}.git @ abcdef files=12000` },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const forgedLedger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-09T00:00:02.020Z',
    includeUnproven: true,
  });
  const row = forgedLedger.rows.find((entry) => entry.proofMode === 'real_rocm_repo_validation');
  assert.equal(row?.matrixOutcome, 'unproven');
  assert.equal(row.acceptedForGpuHmr, false);
  assert.equal(row.realRocmFirewall.accepted, false);
  assert.ok(row.reasons.includes(expectedReason));
  assert.ok(row.reasons.includes('real_rocm_cpu_gpu_firewall_not_proven'));
  assert.ok(row.openGaps.includes('real_rocm_cpu_gpu_firewall_required'));
  assert.ok(row.openGaps.includes(`real_rocm_cpu_gpu_firewall:${expectedReason}`));
  return row;
}

const forgedCpuFirewall = await writeForgedRealRocmFirewallCase({
  slug: 'cpu-hmr-firewall',
  field: 'cpu',
  expectedReason: 'cpu_hmr_used_by_real_rocm_firewall',
});
assert.equal(forgedCpuFirewall.cpuHmrUsed, true);
const forgedFullRebuildFirewall = await writeForgedRealRocmFirewallCase({
  slug: 'full-rebuild-firewall',
  field: 'full_rebuild',
  expectedReason: 'full_rebuild_used_by_real_rocm_firewall',
});
assert.equal(forgedFullRebuildFirewall.fullRebuildUsed, true);
const forgedRestartFirewall = await writeForgedRealRocmFirewallCase({
  slug: 'process-restart-firewall',
  field: 'process_restart',
  expectedReason: 'process_restart_observed_by_real_rocm_firewall',
});
assert.equal(forgedRestartFirewall.processRestarted, true);

const forgedOldArtifactRocmDir = path.join(logsRoot, 'real-rocm-forged-old-artifact-dispatch');
await writeRgbaPng(path.join(forgedOldArtifactRocmDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedOldArtifactRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [94 + x, 106 + y, 144, 255]);
await writeRgbaPng(path.join(forgedOldArtifactRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
const forgedOldArtifactMaterials = realRocmRuntimeProofMaterials('hot_delta_1', {
  projectId: 'real-rocm-forged-old-artifact-dispatch',
  visualRoot: forgedOldArtifactRocmDir,
});
forgedOldArtifactMaterials.proofLedger.records[0].dispatchEvent.artifact_hash =
  hashValue('old-artifact-dispatched');
await writeJson(path.join(forgedOldArtifactRocmDir, 'real-rocm-forged-old-artifact-dispatch.json'), {
  slug: 'gpu-real-rocm-forged-old-artifact-dispatch-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-old-artifact-dispatch' },
  source_url: 'https://example.invalid/rocm/forged-old-artifact.git',
  repo_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  entry_file: 'src/kernels/old_artifact_entry.hip',
  delta_file: 'src/kernels/old_artifact_delta.h',
  target_name: 'ForgedOldArtifactDispatch',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedOldArtifactMaterials,
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedOldArtifactRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedOldArtifactRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedOldArtifactRocmDir, 'before-after-diff.png'),
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-old-artifact-dispatch-delta',
    editHash: hashValue('real-rocm-forged-old-artifact-dispatch-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-old-artifact.git @ abcdef files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedOldArtifactLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedOldArtifactRocmDir],
  generatedAt: '2026-06-09T00:00:02.025Z',
  includeUnproven: true,
});
const forgedOldArtifact = forgedOldArtifactLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedOldArtifact?.matrixOutcome, 'unproven');
assert.equal(forgedOldArtifact.acceptedForGpuHmr, false);
assert.equal(forgedOldArtifact.ledger.gpuHmrSuccess, false);
assert.ok(forgedOldArtifact.reasons.includes('dispatch_artifact_hash_mismatch'));
assert.ok(forgedOldArtifact.openGaps.includes('proof_ledger_success_required'));

const forgedSidecarMismatchRocmDir = path.join(logsRoot, 'real-rocm-forged-sidecar-mismatch');
await writeRgbaPng(path.join(forgedSidecarMismatchRocmDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedSidecarMismatchRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [88 + x, 100 + y, 136, 255]);
await writeRgbaPng(path.join(forgedSidecarMismatchRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedSidecarMismatchRocmDir, 'real-rocm-forged-sidecar-mismatch.json'), {
  slug: 'gpu-real-rocm-forged-sidecar-mismatch-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-sidecar-mismatch' },
  source_url: 'https://example.invalid/rocm/forged-sidecar-mismatch.git',
  repo_commit: 'bcdef0123456789abcdef0123456789abcdef012',
  entry_file: 'src/kernels/sidecar_entry.cl',
  delta_file: 'src/kernels/sidecar_delta.h',
  target_name: 'ForgedSidecarMismatchDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_device_sidecar_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: true,
    required: true,
    status: 'declared_device_sidecar_contract_not_runtime_proof',
    proofAuthority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    proof_authority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    backend: 'opencl',
    artifact_identity: {
      source_paths: ['src/kernels/sidecar_entry.cl'],
      artifact_kind: 'opencl_program',
      entry_points: ['opencl_sidecar_kernel'],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang',
      compiler_args_hash: hashValue('forged-sidecar-mismatch-compile-args'),
    },
    blockingGaps: ['device_sidecar_dispatch_trace_runtime_not_observed'],
    blocking_gaps: ['device_sidecar_dispatch_trace_runtime_not_observed'],
  },
  real_rocm_sidecar_runtime_consistency: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
    status: 'sidecar_runtime_backend_inconsistent_or_unproven',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sidecarBackend: 'opencl',
    sidecar_backend: 'opencl',
    runtimeBackendCandidates: ['hip'],
    runtime_backend_candidates: ['hip'],
    backendConsistent: false,
    backend_consistent: false,
    blockingGaps: ['sidecar_runtime_backend_mismatch'],
    blocking_gaps: ['sidecar_runtime_backend_mismatch'],
  },
  real_rocm_runtime_eligibility: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_eligibility.v1',
    status: 'supplemental_runtime_proof_evidence',
    backendCandidates: ['hip'],
    backend_candidates: ['hip'],
    blockingGaps: [],
    blocking_gaps: [],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-sidecar-mismatch',
    visualRoot: forgedSidecarMismatchRocmDir,
  }),
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedSidecarMismatchRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedSidecarMismatchRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedSidecarMismatchRocmDir, 'before-after-diff.png'),
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-sidecar-mismatch-delta',
    editHash: hashValue('real-rocm-forged-sidecar-mismatch-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-sidecar-mismatch.git @ bcdef012345 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedSidecarMismatchLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedSidecarMismatchRocmDir],
  generatedAt: '2026-06-09T00:00:02.050Z',
  includeUnproven: true,
});
const forgedSidecarMismatch = forgedSidecarMismatchLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedSidecarMismatch?.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedSidecarMismatch.acceptedForGpuHmr, false);
assert.equal(forgedSidecarMismatch.gpuHmrSuccess, false);
assert.equal(forgedSidecarMismatch.targetProgressionEvidence, true);
assert.equal(forgedSidecarMismatch.runtimeProofArtifact.accepted, true);
assert.equal(forgedSidecarMismatch.ledger.gpuHmrSuccess, true);
assert.equal(forgedSidecarMismatch.outputOracleFacet.accepted, true);
assert.equal(forgedSidecarMismatch.realRocmSidecarRuntimeConsistency.backendConsistent, false);
assert.ok(forgedSidecarMismatch.reasons.includes('real_rocm_sidecar_runtime_consistency_not_proven'));
assert.ok(forgedSidecarMismatch.reasons.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_mismatch',
));
assert.ok(forgedSidecarMismatch.openGaps.includes('real_rocm_sidecar_runtime_consistency_required'));
assert.ok(forgedSidecarMismatch.openGaps.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_mismatch',
));

const forgedRequiredHookRocmDir = path.join(logsRoot, 'real-rocm-forged-required-hook');
await writeRgbaPng(path.join(forgedRequiredHookRocmDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedRequiredHookRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [90 + x, 112 + y, 140, 255]);
await writeRgbaPng(path.join(forgedRequiredHookRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedRequiredHookRocmDir, 'real-rocm-forged-required-hook.json'), {
  slug: 'gpu-real-rocm-forged-required-hook-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-required-hook' },
  source_url: 'https://example.invalid/rocm/forged-required-hook.git',
  repo_commit: 'cdef0123456789abcdef0123456789abcdef0123',
  entry_file: 'src/kernels/required_hook_entry.hip',
  delta_file: 'src/kernels/required_hook_delta.h',
  target_name: 'ForgedRequiredHookDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    selectedSource: 'profile_runtime_profile',
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_app_hook_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1',
    declared: true,
    required: true,
    status: 'declared_app_hook_pending_runtime_observation',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    blockingGaps: ['app_hook_dispatch_trace_runtime_not_observed'],
    blocking_gaps: ['app_hook_dispatch_trace_runtime_not_observed'],
  },
  real_rocm_compile_bridge: {
    schemaVersion: 'synthi.real_rocm.compile_bridge_facet.v1',
    status: 'compile_bridge_candidate_observed_not_runtime_proof',
    proofAuthority: 'compile_response_evidence_only_not_gpu_hmr_success',
    proof_authority: 'compile_response_evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    phaseCount: 1,
    phase_count: 1,
    blockingGaps: ['compile_response_bridge_candidate_not_runtime_proof'],
    blocking_gaps: ['compile_response_bridge_candidate_not_runtime_proof'],
  },
  real_rocm_device_sidecar_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: true,
    required: true,
    status: 'declared_device_sidecar_contract_not_runtime_proof',
    proofAuthority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    proof_authority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    sourceCoverageComplete: true,
    source_coverage_complete: true,
    backend: 'hip',
    artifact_identity: {
      source_paths: ['src/kernels/required_hook_entry.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['required_hook_kernel'],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang++',
      compiler_args_hash: hashValue('forged-required-hook-sidecar-compile-args'),
    },
    blockingGaps: [
      'device_sidecar_dispatch_trace_runtime_not_observed',
    ],
    blocking_gaps: [
      'device_sidecar_dispatch_trace_runtime_not_observed',
    ],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-required-hook',
    visualRoot: forgedRequiredHookRocmDir,
  }),
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedRequiredHookRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedRequiredHookRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedRequiredHookRocmDir, 'before-after-diff.png'),
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-required-hook-delta',
    editHash: hashValue('real-rocm-forged-required-hook-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-required-hook.git @ cdef012345 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedRequiredHookRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRequiredHookRocmDir],
  generatedAt: '2026-06-09T00:00:02.125Z',
  includeUnproven: true,
});
const forgedRequiredHookRocm = forgedRequiredHookRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedRequiredHookRocm?.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedRequiredHookRocm.acceptedForGpuHmr, false);
assert.equal(forgedRequiredHookRocm.gpuHmrSuccess, false);
assert.equal(forgedRequiredHookRocm.targetProgressionEvidence, true);
assert.equal(forgedRequiredHookRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedRequiredHookRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedRequiredHookRocm.outputOracleFacet.accepted, true);
assert.equal(forgedRequiredHookRocm.realRocmAppHookContract.declared, true);
assert.equal(forgedRequiredHookRocm.realRocmAppHookContract.canSatisfyRuntimeProof, false);
assert.equal(forgedRequiredHookRocm.realRocmDeviceSidecarContract.declared, true);
assert.equal(forgedRequiredHookRocm.realRocmDeviceSidecarContract.canSatisfyRuntimeProof, false);
assert.equal(forgedRequiredHookRocm.realRocmCompileBridge.canSatisfyRuntimeProof, false);
assert.ok(forgedRequiredHookRocm.reasons.includes('real_rocm_app_hook_contract_required_not_proven'));
assert.ok(forgedRequiredHookRocm.reasons.includes(
  'real_rocm_device_sidecar_contract:declared_device_sidecar_contract_not_runtime_proof',
));
assert.ok(forgedRequiredHookRocm.reasons.includes('real_rocm_compile_bridge:compile_bridge_candidate_observed_not_runtime_proof'));
assert.ok(forgedRequiredHookRocm.openGaps.includes('real_rocm_app_hook_contract_required'));
assert.ok(forgedRequiredHookRocm.openGaps.includes(
  'real_rocm_device_sidecar_contract:device_sidecar_dispatch_trace_runtime_not_observed',
));
assert.ok(forgedRequiredHookRocm.openGaps.includes(
  'real_rocm_compile_bridge:compile_response_bridge_candidate_not_runtime_proof',
));

const forgedMissingHookFacetRocmDir = path.join(logsRoot, 'real-rocm-forged-missing-hook-facet');
await writeRgbaPng(path.join(forgedMissingHookFacetRocmDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedMissingHookFacetRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [32 + x, 96 + y, 180, 255]);
await writeRgbaPng(path.join(forgedMissingHookFacetRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedMissingHookFacetRocmDir, 'real-rocm-forged-missing-hook-facet.json'), {
  slug: 'gpu-real-rocm-forged-missing-hook-facet-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-missing-hook-facet' },
  source_url: 'https://example.invalid/rocm/forged-missing-hook-facet.git',
  repo_commit: 'fedcba9876543210fedcba9876543210fedcba98',
  entry_file: 'src/kernels/missing_hook_entry.hip',
  delta_file: 'src/kernels/missing_hook_delta.h',
  target_name: 'ForgedMissingHookFacetDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    selectedSource: 'profile_runtime_profile',
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  native_rocm_launch_boundary: {
    schemaVersion: 'synthi.gpu_hmr.native_rocm_launch_boundary_refusal.v1',
    observed: true,
    status: 'refusal_evidence',
    adapterOutcome: 'adapter_impossible_requires_app_hook',
    adapter_outcome: 'adapter_impossible_requires_app_hook',
    blockingGaps: ['adapter_impossible_requires_app_hook'],
    blocking_gaps: ['adapter_impossible_requires_app_hook'],
  },
  real_rocm_runtime_eligibility: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_eligibility.v1',
    status: 'refused_missing_runtime_proof',
    appHookContractStatus: 'required_app_hook_contract_missing',
    app_hook_contract_status: 'required_app_hook_contract_missing',
    blockingGaps: ['app_hook_contract_not_declared'],
    blocking_gaps: ['app_hook_contract_not_declared'],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-missing-hook-facet',
    visualRoot: forgedMissingHookFacetRocmDir,
  }),
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedMissingHookFacetRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedMissingHookFacetRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedMissingHookFacetRocmDir, 'before-after-diff.png'),
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-missing-hook-facet-delta',
    editHash: hashValue('real-rocm-forged-missing-hook-facet-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-missing-hook-facet.git @ fedcba9 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedMissingHookFacetRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingHookFacetRocmDir],
  generatedAt: '2026-06-09T00:00:02.126Z',
  includeUnproven: true,
});
const forgedMissingHookFacetRocm = forgedMissingHookFacetRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingHookFacetRocm?.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedMissingHookFacetRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingHookFacetRocm.gpuHmrSuccess, false);
assert.equal(forgedMissingHookFacetRocm.targetProgressionEvidence, true);
assert.equal(forgedMissingHookFacetRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingHookFacetRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingHookFacetRocm.outputOracleFacet.accepted, true);
assert.deepEqual(forgedMissingHookFacetRocm.realRocmAppHookContract, {});
assert.ok(forgedMissingHookFacetRocm.reasons.includes('real_rocm_app_hook_contract_required_not_proven'));
assert.ok(forgedMissingHookFacetRocm.openGaps.includes('real_rocm_app_hook_contract_required'));

const acceptedComputeRocmDir = path.join(logsRoot, 'real-rocm-accepted-compute-lib');
const acceptedComputeRawReadback = path.join(acceptedComputeRocmDir, 'readback.bin');
const acceptedComputeBytes = Buffer.from([1, 7, 23, 42, 88, 111, 4, 19]);
await fs.mkdir(acceptedComputeRocmDir, { recursive: true });
await fs.writeFile(acceptedComputeRawReadback, acceptedComputeBytes);
await writeJson(`${acceptedComputeRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: acceptedComputeBytes.length,
  shape: [acceptedComputeBytes.length],
});
await writeRgbaPng(`${acceptedComputeRawReadback}.card.png`, 8, 8, (x, y) => [
  acceptedComputeBytes[(x + y) % acceptedComputeBytes.length],
  64 + x,
  120 + y,
  255,
]);
const acceptedComputeProofMaterials = realRocmComputeProofLedgerMaterials('accepted-compute-files', {
  projectId: 'real-rocm-accepted-compute-lib',
  rawReadbackPath: acceptedComputeRawReadback,
  rawReadbackBytes: acceptedComputeBytes,
});
await writeJson(path.join(acceptedComputeRocmDir, 'real-rocm-accepted-compute.json'), {
  slug: 'gpu-real-rocm-accepted-compute-lib-20260623',
  real_rocm_profile: { id: 'real-rocm-accepted-compute-lib' },
  source_url: 'https://example.invalid/rocm/accepted-compute.git',
  repo_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'AcceptedComputeDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...acceptedComputeProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-compute-lib-delta',
    editHash: hashValue('real-rocm-accepted-compute-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-compute.git @ bbbbbbbb files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedComputeRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedComputeRocmDir],
  generatedAt: '2026-06-09T00:00:02.250Z',
  includeUnproven: true,
});
const acceptedComputeRocm = acceptedComputeRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedComputeRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedComputeRocm.acceptedForGpuHmr, true);
assert.equal(acceptedComputeRocm.runtimeProofArtifact.accepted, true);
assert.equal(acceptedComputeRocm.ledger.gpuHmrSuccess, true);
assert.equal(acceptedComputeRocm.visual.present, false);
assert.equal(acceptedComputeRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(acceptedComputeRocm.outputOracleFacet.accepted, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.semanticAccepted, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.expectedOutputVerified, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.rawReadbackHashVerified, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.rawReadbackByteLength, acceptedComputeBytes.length);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.deterministicSliceHashVerified, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.readbackSchemaByteLength > 0, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.renderedCard.decoded, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.renderedCard.format, 'png');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.accepted, true);
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.selectedLoaderTransport, 'ram_bytes');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.runtimeSessionId, 'runtime-session:accepted-compute-files');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.dispatchTableEntryId, 'dispatch-table-entry:accepted-compute-files');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.outputTargetId, 'output-target:accepted-compute-files');
assert.equal(acceptedComputeRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(acceptedComputeRocm.realRocmRuntimeCapabilityPreflight.accepted, true);

const acceptedComputeCasRocmDir = path.join(logsRoot, 'real-rocm-accepted-compute-cas-lib');
const acceptedComputeCasSourceRaw = path.join(acceptedComputeCasRocmDir, 'readback-source.bin');
const acceptedComputeCasRoot = path.join(acceptedComputeCasRocmDir, 'artifact-cas');
await fs.mkdir(acceptedComputeCasRocmDir, { recursive: true });
await fs.writeFile(acceptedComputeCasSourceRaw, acceptedComputeBytes);
await writeJson(`${acceptedComputeCasSourceRaw}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: acceptedComputeBytes.length,
  shape: [acceptedComputeBytes.length],
});
await writeRgbaPng(`${acceptedComputeCasSourceRaw}.card.png`, 8, 8, (x, y) => [
  acceptedComputeBytes[(x * 3 + y) % acceptedComputeBytes.length],
  48 + y,
  144 + x,
  255,
]);
const acceptedComputeCasBaseMaterials = realRocmComputeProofLedgerMaterials('accepted-compute-cas', {
  projectId: 'real-rocm-accepted-compute-cas-lib',
  rawReadbackPath: acceptedComputeCasSourceRaw,
  rawReadbackBytes: acceptedComputeBytes,
});
const acceptedComputeCasArtifacts = await computeOracleCasBackedArtifacts({
  baseArtifacts: acceptedComputeCasBaseMaterials.computeOracleArtifacts,
  casRoot: acceptedComputeCasRoot,
  rawReadbackPath: acceptedComputeCasSourceRaw,
  schemaPath: `${acceptedComputeCasSourceRaw}.schema.json`,
  cardPath: `${acceptedComputeCasSourceRaw}.card.png`,
  scope: 'accepted-compute-cas',
});
const acceptedComputeCasProofMaterials = withComputeOracleArtifacts(
  acceptedComputeCasBaseMaterials,
  acceptedComputeCasArtifacts,
);
await writeJson(path.join(acceptedComputeCasRocmDir, 'real-rocm-accepted-compute-cas.json'), {
  slug: 'gpu-real-rocm-accepted-compute-cas-lib-20260629',
  real_rocm_profile: { id: 'real-rocm-accepted-compute-cas-lib' },
  source_url: 'https://example.invalid/rocm/accepted-compute-cas.git',
  repo_commit: 'cccccccccccccccccccccccccccccccccccccccc',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'AcceptedComputeCasDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...acceptedComputeCasProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-compute-cas-lib-delta',
    editHash: hashValue('real-rocm-accepted-compute-cas-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-compute-cas.git @ cccccccc files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedComputeCasRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedComputeCasRocmDir],
  generatedAt: '2026-06-09T00:00:02.260Z',
  includeUnproven: true,
});
const acceptedComputeCasRocm = acceptedComputeCasRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedComputeCasRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedComputeCasRocm.outputOracleFacet.accepted, true);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.fileIntegrityAccepted, true);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.rawReadbackHashVerified, true);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.renderedCard.decoded, true);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.computeArtifactCasResolution.accepted, true);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.computeArtifactCasResolution.acceptedForGpuHmr, false);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.computeArtifactCasResolution.gpuHmrSuccess, false);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.computeArtifactCasResolution.locatorCount, 3);
assert.equal(acceptedComputeCasRocm.outputOracleFacet.compute.computeArtifactCasResolution.acceptedCount, 3);

const acceptedComputeCasOnlyRocmDir = path.join(logsRoot, 'real-rocm-accepted-compute-cas-only-lib');
await fs.mkdir(acceptedComputeCasOnlyRocmDir, { recursive: true });
const acceptedComputeCasOnlyArtifacts = computeOracleArtifactsWithoutDirectPaths(
  acceptedComputeCasArtifacts,
);
const acceptedComputeCasOnlyMaterializedArtifacts = await computeOracleArtifactsFromFiles(
  acceptedComputeCasOnlyArtifacts,
  { artifactRoot: acceptedComputeCasRoot, casRoot: acceptedComputeCasRoot },
);
assert.equal(
  acceptedComputeCasOnlyMaterializedArtifacts.computeArtifactCasResolution.accepted,
  true,
);
assert.ok(acceptedComputeCasOnlyMaterializedArtifacts.raw_readback_bin);
assert.ok(acceptedComputeCasOnlyMaterializedArtifacts.readback_schema_json);
assert.ok(acceptedComputeCasOnlyMaterializedArtifacts.rendered_card_png);
const selfDeclaredComputeCasRoot = path.join(tmpRoot, 'self-declared-untrusted-compute-cas');
const selfDeclaredRawLocator = await writeArtifactToCas(acceptedComputeBytes, {
  artifactRoot: selfDeclaredComputeCasRoot,
  artifactKind: 'runtime_compute_raw_readback',
  mediaType: 'application/octet-stream',
  role: 'raw_readback',
  producer: { name: 'validation_matrix_smoke', kind: 'proof_runner' },
  producerSubsystem: 'compute_oracle_artifact_transport',
  sessionNamespace: 'self-declared-compute-cas-root',
  transportKind: 'cas_shared_volume',
});
const selfDeclaredComputeCasArtifacts = computeOracleArtifactsWithoutDirectPaths(acceptedComputeCasArtifacts);
selfDeclaredComputeCasArtifacts.raw_readback_cas_manifest = selfDeclaredRawLocator;
selfDeclaredComputeCasArtifacts.rawReadbackCasManifest = selfDeclaredRawLocator;
selfDeclaredComputeCasArtifacts.artifactCasRoot = selfDeclaredComputeCasRoot;
selfDeclaredComputeCasArtifacts.artifact_cas_root = selfDeclaredComputeCasRoot;
selfDeclaredComputeCasArtifacts.allowedCasRoots = [selfDeclaredComputeCasRoot];
selfDeclaredComputeCasArtifacts.allowed_cas_roots = [selfDeclaredComputeCasRoot];
const selfDeclaredComputeCasResolved = await computeOracleArtifactsFromFiles(
  selfDeclaredComputeCasArtifacts,
  { artifactRoot: acceptedComputeCasRoot, casRoot: acceptedComputeCasRoot },
);
const selfDeclaredRawEntry = selfDeclaredComputeCasResolved.computeArtifactCasResolution.entries.find(
  (entry) => entry.role === 'raw_readback',
);
assert.equal(selfDeclaredComputeCasResolved.computeArtifactCasResolution.accepted, false);
assert.equal(selfDeclaredRawEntry.accepted, false);
assert.ok(selfDeclaredRawEntry.reasons.includes('artifact_cas_local_path_outside_allowed_roots'));
assert.equal(selfDeclaredComputeCasResolved.raw_readback_bin, undefined);
const acceptedComputeCasOnlyProofMaterials = withComputeOracleArtifacts(
  acceptedComputeCasBaseMaterials,
  acceptedComputeCasOnlyMaterializedArtifacts,
);
const {
  proofLedger: acceptedComputeCasOnlyTopLedger,
  proofLedgerQuery: acceptedComputeCasOnlyTopLedgerQuery,
} = proofLedgerForComputeOracleArtifacts(
  acceptedComputeCasBaseMaterials,
  acceptedComputeCasOnlyArtifacts,
);
assert.equal(acceptedComputeCasOnlyTopLedgerQuery.gpuHmrSuccess, false);
assert.ok(acceptedComputeCasOnlyTopLedgerQuery.failedInvariants.some(
  (failure) => failure.code === 'compute_oracle_artifacts_incomplete',
));
await writeJson(path.join(acceptedComputeCasOnlyRocmDir, 'real-rocm-accepted-compute-cas-only.json'), {
  slug: 'gpu-real-rocm-accepted-compute-cas-only-lib-20260629',
  real_rocm_profile: { id: 'real-rocm-accepted-compute-cas-only-lib' },
  source_url: 'https://example.invalid/rocm/accepted-compute-cas-only.git',
  repo_commit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'AcceptedComputeCasOnlyDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...acceptedComputeCasOnlyProofMaterials,
  proofLedger: acceptedComputeCasOnlyTopLedger,
  proof_ledger: acceptedComputeCasOnlyTopLedger,
  proofLedgerQuery: acceptedComputeCasOnlyTopLedgerQuery,
  proof_ledger_query: acceptedComputeCasOnlyTopLedgerQuery,
  computeOracleArtifacts: acceptedComputeCasOnlyArtifacts,
  compute_oracle_artifacts: acceptedComputeCasOnlyArtifacts,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-compute-cas-only-lib-delta',
    editHash: hashValue('real-rocm-accepted-compute-cas-only-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-compute-cas-only.git @ eeeeeeee files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedComputeCasOnlyRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedComputeCasOnlyRocmDir],
  generatedAt: '2026-06-09T00:00:02.265Z',
  includeUnproven: true,
});
const acceptedComputeCasOnlyRocm = acceptedComputeCasOnlyRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedComputeCasOnlyRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedComputeCasOnlyRocm.acceptedForGpuHmr, true);
assert.equal(acceptedComputeCasOnlyRocm.ledger.gpuHmrSuccess, true);
assert.equal(acceptedComputeCasOnlyRocm.ledger.failedInvariants.length, 0);
assert.equal(acceptedComputeCasOnlyRocm.ledger.computeArtifactCasResolutions[0].accepted, true);
assert.equal(acceptedComputeCasOnlyRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(acceptedComputeCasOnlyRocm.outputOracleFacet.accepted, true);
assert.equal(acceptedComputeCasOnlyRocm.outputOracleFacet.compute.computeArtifactCasResolution.accepted, true);
assert.equal(acceptedComputeCasOnlyRocm.outputOracleFacet.compute.computeArtifactCasResolution.acceptedForGpuHmr, false);
assert.equal(acceptedComputeCasOnlyRocm.outputOracleFacet.compute.computeArtifactCasResolution.gpuHmrSuccess, false);

const acceptedVisualCasRocmDir = path.join(logsRoot, 'real-rocm-accepted-visual-cas-lib');
await fs.mkdir(acceptedVisualCasRocmDir, { recursive: true });
const acceptedVisualCasBaseMaterials = realRocmRuntimeProofMaterials(
  'hot_delta_1',
  { projectId: 'real-rocm-accepted-visual-cas-lib' },
);
const acceptedVisualCasBaseRecord = acceptedVisualCasBaseMaterials.proofLedger.records[0];
const acceptedVisualCasCameraStateHash =
  acceptedVisualCasBaseRecord.deterministic_visual_mode?.camera_state_hash
  ?? acceptedVisualCasBaseRecord.deterministic_visual_mode?.cameraStateHash
  ?? acceptedVisualCasBaseRecord.deterministicVisualMode?.camera_state_hash
  ?? acceptedVisualCasBaseRecord.deterministicVisualMode?.cameraStateHash;
const acceptedVisualCasArtifacts = await visualArtifactSetWithCas({
  before: path.join(visualDir, 'before-hmr-first.png'),
  after: path.join(visualDir, 'after-hmr-first.png'),
  diff: path.join(visualDir, 'before-after-diff.png'),
}, {
  cameraStateHash: acceptedVisualCasCameraStateHash,
  camera_state_hash: acceptedVisualCasCameraStateHash,
  captureBackend: 'runtime_adapter_visual_oracle',
  capture_backend: 'runtime_adapter_visual_oracle',
  swapchainSize: [8, 8],
  swapchain_size: [8, 8],
  frameNumber: 11,
  frame_number: 11,
});
const acceptedVisualCasTrace =
  acceptedVisualCasBaseMaterials.proofLedger.records[0].artifact_after_hash
  ?? acceptedVisualCasBaseMaterials.proofLedger.records[0].artifactAfterHash;
Object.assign(acceptedVisualCasArtifacts, {
  blankFrameRejection: true,
  blank_frame_rejection: true,
  sameFrameRejection: true,
  same_frame_rejection: true,
  newEpochWatermarkOrTrace: acceptedVisualCasTrace,
  new_epoch_watermark_or_trace: acceptedVisualCasTrace,
  timestampAfterDispatch: 4000,
  timestamp_after_dispatch: 4000,
  perceptualDiff: 0.125,
  perceptual_diff: 0.125,
  changedPixelRatio: 0.25,
  changed_pixel_ratio: 0.25,
  visiblePixelCount: 64,
  visible_pixel_count: 64,
  pixelMetricsVerified: true,
  pixel_metrics_verified: true,
  beforeImageHashVerified: true,
  before_image_hash_verified: true,
  afterImageHashVerified: true,
  after_image_hash_verified: true,
  diffImageHashVerified: true,
  diff_image_hash_verified: true,
});
const acceptedVisualCasProofMaterials = withVisualOracleArtifacts(
  acceptedVisualCasBaseMaterials,
  acceptedVisualCasArtifacts,
);
await writeJson(path.join(acceptedVisualCasRocmDir, 'real-rocm-accepted-visual-cas.json'), {
  slug: 'gpu-real-rocm-accepted-visual-cas-lib-20260630',
  real_rocm_profile: { id: 'real-rocm-accepted-visual-cas-lib' },
  source_url: 'https://example.invalid/rocm/accepted-visual-cas.git',
  repo_commit: 'fefefefefefefefefefefefefefefefefefefefe',
  entry_file: 'src/kernels/visual_entry.hip',
  delta_file: 'src/kernels/visual_delta.h',
  target_name: 'AcceptedVisualCasDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.visual.render-target-hash.v1',
    mode: 'profile.visual.render-target-hash.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...acceptedVisualCasProofMaterials,
  visualOracleArtifacts: acceptedVisualCasArtifacts,
  visual_oracle_artifacts: acceptedVisualCasArtifacts,
  visualEvidenceArtifacts: [acceptedVisualCasArtifacts],
  visual_evidence_artifacts: [acceptedVisualCasArtifacts],
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-visual-cas-lib-delta',
    editHash: hashValue('real-rocm-accepted-visual-cas-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-visual-cas.git @ fefefefe files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedVisualCasRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedVisualCasRocmDir],
  generatedAt: '2026-06-09T00:00:02.270Z',
  includeUnproven: true,
});
const acceptedVisualCasRocm = acceptedVisualCasRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedVisualCasRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedVisualCasRocm.acceptedForGpuHmr, true);
assert.equal(acceptedVisualCasRocm.ledger.gpuHmrSuccess, true);
assert.equal(acceptedVisualCasRocm.ledger.failedInvariants.length, 0);
assert.equal(acceptedVisualCasRocm.ledger.visualArtifactCasResolutions[0].accepted, true);
assert.equal(acceptedVisualCasRocm.ledger.visualArtifactCasResolutions[0].locatorCount, 3);
assert.equal(acceptedVisualCasRocm.outputOracleFacet.kind, 'visual_oracle');
assert.equal(acceptedVisualCasRocm.outputOracleFacet.accepted, true);
assert.equal(acceptedVisualCasRocm.visual.accepted, true);
assert.equal(acceptedVisualCasRocm.visual.artifactCasLocatorCount, 3);
assert.equal(acceptedVisualCasRocm.visual.artifactCasLocatorAcceptedCount, 3);
assert.equal(acceptedVisualCasRocm.visual.artifactCasHashMatchedCount, 3);

const forgedVisualCasRocmDir = path.join(logsRoot, 'real-rocm-forged-visual-cas-lib');
await fs.mkdir(forgedVisualCasRocmDir, { recursive: true });
const forgedVisualCasArtifacts = JSON.parse(JSON.stringify(acceptedVisualCasArtifacts));
forgedVisualCasArtifacts.afterImageHash = hashValue('real-rocm-forged-visual-cas-after');
forgedVisualCasArtifacts.after_image_hash = forgedVisualCasArtifacts.afterImageHash;
const forgedVisualCasProofMaterials = withVisualOracleArtifacts(
  acceptedVisualCasBaseMaterials,
  forgedVisualCasArtifacts,
);
await writeJson(path.join(forgedVisualCasRocmDir, 'real-rocm-forged-visual-cas.json'), {
  slug: 'gpu-real-rocm-forged-visual-cas-lib-20260630',
  real_rocm_profile: { id: 'real-rocm-forged-visual-cas-lib' },
  source_url: 'https://example.invalid/rocm/forged-visual-cas.git',
  repo_commit: 'efefefefefefefefefefefefefefefefefefefef',
  entry_file: 'src/kernels/visual_entry.hip',
  delta_file: 'src/kernels/visual_delta.h',
  target_name: 'ForgedVisualCasDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.visual.render-target-hash.v1',
    mode: 'profile.visual.render-target-hash.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedVisualCasProofMaterials,
  visualOracleArtifacts: forgedVisualCasArtifacts,
  visual_oracle_artifacts: forgedVisualCasArtifacts,
  visualEvidenceArtifacts: [forgedVisualCasArtifacts],
  visual_evidence_artifacts: [forgedVisualCasArtifacts],
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-visual-cas-lib-delta',
    editHash: hashValue('real-rocm-forged-visual-cas-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-visual-cas.git @ efefefef files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
  ],
});
const forgedVisualCasRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedVisualCasRocmDir],
  generatedAt: '2026-06-09T00:00:02.275Z',
  includeUnproven: true,
});
const forgedVisualCasRocm = forgedVisualCasRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedVisualCasRocm?.matrixOutcome, 'unproven');
assert.equal(forgedVisualCasRocm.acceptedForGpuHmr, false);
assert.equal(forgedVisualCasRocm.outputOracleFacet.kind, 'ledger_rejected');
assert.equal(forgedVisualCasRocm.outputOracleFacet.accepted, false);
assert.equal(forgedVisualCasRocm.outputOracleFacet.compute, null);
assert.ok(forgedVisualCasRocm.visual.failedGates.some(
  (gate) => gate === 'visual_artifact_hash_mismatch'
    || gate.code === 'visual_artifact_hash_mismatch',
));
assert.ok(forgedVisualCasRocm.ledger.failedInvariants.some(
  (gate) => gate.code === 'visual_artifact_hash_mismatch'
    || gate.code === 'visual_artifact_cas_locator_hash_mismatch',
));
assert.ok(forgedVisualCasRocm.reasons.includes('visual_artifact_hash_mismatch'));
assert.ok(forgedVisualCasRocm.reasons.includes('proof_ledger_success_required'));
assert.ok(forgedVisualCasRocm.reasons.includes('output_or_visual_oracle_proof_missing'));
assert.ok(forgedVisualCasRocm.openGaps.includes('output_or_visual_oracle_proof_required'));

const forgedComputeCasRocmDir = path.join(logsRoot, 'real-rocm-forged-compute-cas');
await fs.mkdir(forgedComputeCasRocmDir, { recursive: true });
const forgedComputeCasArtifacts = JSON.parse(JSON.stringify(acceptedComputeCasArtifacts));
forgedComputeCasArtifacts.artifact_cas_locators[0].contentHash = hashValue('forged-compute-cas-wrong-hash');
forgedComputeCasArtifacts.artifactCasLocators = forgedComputeCasArtifacts.artifact_cas_locators;
const forgedComputeCasBaseMaterials = realRocmComputeProofLedgerMaterials('forged-compute-cas', {
  projectId: 'real-rocm-forged-compute-cas',
  rawReadbackPath: acceptedComputeCasSourceRaw,
  rawReadbackBytes: acceptedComputeBytes,
});
const forgedComputeCasProofMaterials = withComputeOracleArtifacts(
  forgedComputeCasBaseMaterials,
  forgedComputeCasArtifacts,
);
await writeJson(path.join(forgedComputeCasRocmDir, 'real-rocm-forged-compute-cas.json'), {
  slug: 'gpu-real-rocm-forged-compute-cas-20260629',
  real_rocm_profile: { id: 'real-rocm-forged-compute-cas' },
  source_url: 'https://example.invalid/rocm/forged-compute-cas.git',
  repo_commit: 'dddddddddddddddddddddddddddddddddddddddd',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'ForgedComputeCasDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedComputeCasProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-compute-cas-delta',
    editHash: hashValue('real-rocm-forged-compute-cas-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-compute-cas.git @ dddddddd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedComputeCasRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedComputeCasRocmDir],
  generatedAt: '2026-06-09T00:00:02.270Z',
  includeUnproven: true,
});
const forgedComputeCasRocm = forgedComputeCasRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedComputeCasRocm?.matrixOutcome, 'unproven');
assert.equal(forgedComputeCasRocm.acceptedForGpuHmr, false);
assert.equal(forgedComputeCasRocm.outputOracleFacet.kind, 'ledger_rejected');
assert.equal(forgedComputeCasRocm.outputOracleFacet.accepted, false);
assert.equal(forgedComputeCasRocm.outputOracleFacet.compute, null);
assert.ok(forgedComputeCasRocm.ledger.failedInvariants.some(
  (failure) => failure.code === 'compute_oracle_artifact_cas_locator_validation_failed',
));
assert.ok(forgedComputeCasRocm.reasons.includes('compute_oracle_artifact_cas_locator_validation_failed'));
assert.ok(forgedComputeCasRocm.reasons.includes('proof_ledger_success_required'));
assert.ok(forgedComputeCasRocm.reasons.includes('output_or_visual_oracle_proof_missing'));

const forgedComputeCasRoleRocmDir = path.join(logsRoot, 'real-rocm-forged-compute-cas-role');
await fs.mkdir(forgedComputeCasRoleRocmDir, { recursive: true });
const forgedComputeCasRoleArtifacts = JSON.parse(JSON.stringify(acceptedComputeCasArtifacts));
const rawComputeLocator = forgedComputeCasRoleArtifacts.artifact_cas_locators.find(
  (locator) => locator.role === 'raw_readback',
) ?? forgedComputeCasRoleArtifacts.artifact_cas_locators[0];
const roleMismatchedRawLocator = {
  ...rawComputeLocator,
  role: 'rendered_card',
  artifactRole: 'rendered_card',
  artifact_role: 'rendered_card',
};
forgedComputeCasRoleArtifacts.raw_readback_cas_manifest = roleMismatchedRawLocator;
forgedComputeCasRoleArtifacts.rawReadbackCasManifest = roleMismatchedRawLocator;
const forgedComputeCasRoleBaseMaterials = realRocmComputeProofLedgerMaterials('forged-compute-cas-role', {
  projectId: 'real-rocm-forged-compute-cas-role',
  rawReadbackPath: acceptedComputeCasSourceRaw,
  rawReadbackBytes: acceptedComputeBytes,
});
const forgedComputeCasRoleProofMaterials = withComputeOracleArtifacts(
  forgedComputeCasRoleBaseMaterials,
  forgedComputeCasRoleArtifacts,
);
await writeJson(path.join(forgedComputeCasRoleRocmDir, 'real-rocm-forged-compute-cas-role.json'), {
  slug: 'gpu-real-rocm-forged-compute-cas-role-20260629',
  real_rocm_profile: { id: 'real-rocm-forged-compute-cas-role' },
  source_url: 'https://example.invalid/rocm/forged-compute-cas-role.git',
  repo_commit: 'cccccccccccccccccccccccccccccccccccccccc',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'ForgedComputeCasRoleDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedComputeCasRoleProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-compute-cas-role-delta',
    editHash: hashValue('real-rocm-forged-compute-cas-role-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-compute-cas-role.git @ cccccccc files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedComputeCasRoleRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedComputeCasRoleRocmDir],
  generatedAt: '2026-06-09T00:00:02.272Z',
  includeUnproven: true,
});
const forgedComputeCasRoleRocm = forgedComputeCasRoleRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedComputeCasRoleRocm?.matrixOutcome, 'unproven');
assert.equal(forgedComputeCasRoleRocm.acceptedForGpuHmr, false);
assert.equal(forgedComputeCasRoleRocm.outputOracleFacet.kind, 'ledger_rejected');
assert.equal(forgedComputeCasRoleRocm.outputOracleFacet.accepted, false);
assert.equal(forgedComputeCasRoleRocm.outputOracleFacet.compute, null);
assert.ok(forgedComputeCasRoleRocm.ledger.failedInvariants.some(
  (failure) => failure.code === 'compute_oracle_artifact_cas_locator_validation_failed',
));
assert.ok(forgedComputeCasRoleRocm.reasons.includes('compute_oracle_artifact_cas_locator_validation_failed'));
assert.ok(forgedComputeCasRoleRocm.reasons.includes('proof_ledger_success_required'));
assert.ok(forgedComputeCasRoleRocm.reasons.includes('output_or_visual_oracle_proof_missing'));

const acceptedRuntimeArtifactInput = {
  createdAt: '2026-06-09T00:00:02.200Z',
  workspaceSlug: 'real-rocm-missing-dependency-runtime-artifact-smoke',
  fullRuntimeProof: {
    resultState: 'gpu-hmr-full-runtime-proven',
    fullRuntimeProven: true,
    stages: [
      'fission-candidate-verification',
      'compile',
      'symbol-binding',
      'abi',
      'artifact-transport',
      'epoch-swap',
      'dispatch-safe',
      'output',
      'artifact-identity',
      'host-preservation',
    ].map((stageId) => ({ stageId, status: 'passed' })),
  },
  proofLedgerRecord: acceptedComputeProofMaterials.proofLedger.records[0],
  acceptanceContract: acceptedComputeProofMaterials.runtimeProofArtifact.acceptanceContract,
  adversarialPreflight: {
    ok: true,
    skipped: false,
    scriptPath: 'mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs',
    exitCode: 0,
    elapsedMs: 1,
    stdoutHash: hashValue('missing-dependency-runtime-artifact-stdout'),
    stderrHash: hashValue('missing-dependency-runtime-artifact-stderr'),
  },
};
const acceptedRuntimeArtifactWithoutProbe = acceptedComputeProofMaterials.runtimeProofArtifact;
assert.equal(acceptedRuntimeArtifactWithoutProbe.proofLedgerQuery.gpuHmrSuccess, true);
assert.equal(acceptedRuntimeArtifactWithoutProbe.gpuHmrSuccess, true);
const missingDependencyRuntimeArtifact = buildValidationRuntimeProofArtifact({
  ...acceptedRuntimeArtifactInput,
  realRocmMissingDependencyProbe: missingDependencyProbe,
  real_rocm_missing_dependency_probe: missingDependencyProbe,
});
assert.equal(missingDependencyRuntimeArtifact.proofLedgerQuery.gpuHmrSuccess, true);
assert.equal(missingDependencyRuntimeArtifact.gpuHmrSuccess, false);
assert.ok(missingDependencyRuntimeArtifact.limitations.some(
  (limitation) => limitation.stageId === 'real-rocm-missing-dependency-probe',
));
const forgedRuntimeBoundaryTargetEnvironment =
  runtimeBoundaryTargetEnvironmentFixture('runtime-artifact-forged-authority', {
    proofAuthority: 'runtime_proof',
    proof_authority: 'runtime_proof',
    acceptedForGpuHmr: true,
    accepted_for_gpu_hmr: true,
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
  });
const forgedRuntimeBoundaryTargetEnvironmentArtifact =
  buildValidationRuntimeProofArtifact({
    ...acceptedRuntimeArtifactInput,
    realRocmRuntimeBoundaryTargetEnvironment:
      forgedRuntimeBoundaryTargetEnvironment,
    real_rocm_runtime_boundary_target_environment:
      forgedRuntimeBoundaryTargetEnvironment,
  });
assert.equal(
  forgedRuntimeBoundaryTargetEnvironmentArtifact.proofLedgerQuery.gpuHmrSuccess,
  true,
);
assert.equal(forgedRuntimeBoundaryTargetEnvironmentArtifact.gpuHmrSuccess, false);
assert.ok(forgedRuntimeBoundaryTargetEnvironmentArtifact.limitations.some(
  (limitation) =>
    limitation.stageId === 'real-rocm-runtime-boundary-target-environment'
    && limitation.blockingGaps.includes(
      'real_rocm_runtime_boundary_target_environment_claimed_runtime_authority',
    ),
));
const missingDependencyRuntimeSummary = buildGpuHmrValidationProofSummary({
  workspaceSlug: 'real-rocm-missing-dependency-runtime-summary-smoke',
  fullRuntimeProof: acceptedRuntimeArtifactInput.fullRuntimeProof,
  runtimeProofArtifactRecords: [acceptedRuntimeArtifactWithoutProbe],
  proofLedgerQuery: acceptedRuntimeArtifactWithoutProbe.proofLedgerQuery,
  acceptanceContractEvaluation: acceptedRuntimeArtifactWithoutProbe.acceptanceContractEvaluation,
  acceptanceContractConsistency: acceptedRuntimeArtifactWithoutProbe.acceptanceContractConsistency,
  realRocmMissingDependencyProbe: missingDependencyProbe,
});
assert.equal(missingDependencyRuntimeSummary.proof_states.real_rocm_missing_dependency_probe.accepted_as_refusal_evidence, true);
assert.equal(missingDependencyRuntimeSummary.gpu_hmr_success, false);
assert.ok(missingDependencyRuntimeSummary.limitations.some(
  (limitation) => limitation.stage_id === 'real-rocm-missing-dependency-probe',
));

const acceptedComputeSafetyLedger = buildGpuHmrValidationMatrixLedger([
  {
    ...acceptedComputeRocm,
    rowId: 'gpu-validation-matrix-row:sha256:' + 'f'.repeat(64),
    row_id: 'gpu-validation-matrix-row:sha256:' + 'f'.repeat(64),
    realRocmMissingDependencyProbe: missingDependencyProbe,
    real_rocm_missing_dependency_probe: missingDependencyProbe,
    missingDependencyProbe,
    missing_dependency_probe: missingDependencyProbe,
  },
], { includeUnproven: true, latestPerTarget: false });
assert.equal(acceptedComputeSafetyLedger.rows.length, 1);
assert.equal(acceptedComputeSafetyLedger.rows[0].acceptedForGpuHmr, true);
assert.equal(acceptedComputeSafetyLedger.rows[0].safety.accepted, false);
assert.ok(acceptedComputeSafetyLedger.rows[0].safety.failedGates.some(
  (gate) => gate.code === 'gpu_hmr_success_cannot_have_real_rocm_missing_dependency_probe',
));

const acceptedComputeExternalHeaderSafetyLedger = buildGpuHmrValidationMatrixLedger([
  {
    ...acceptedComputeRocm,
    rowId: 'gpu-validation-matrix-row:sha256:' + 'e'.repeat(64),
    row_id: 'gpu-validation-matrix-row:sha256:' + 'e'.repeat(64),
    realRocmExternalHeaderPrerequisites: forgedExternalHeaderPrerequisites,
    real_rocm_external_header_prerequisites: forgedExternalHeaderPrerequisites,
    externalHeaderPrerequisites: forgedExternalHeaderPrerequisites,
    external_header_prerequisites: forgedExternalHeaderPrerequisites,
  },
], { includeUnproven: true, latestPerTarget: false });
assert.equal(acceptedComputeExternalHeaderSafetyLedger.rows.length, 1);
assert.equal(acceptedComputeExternalHeaderSafetyLedger.rows[0].acceptedForGpuHmr, true);
assert.equal(acceptedComputeExternalHeaderSafetyLedger.rows[0].safety.accepted, false);
assert.ok(acceptedComputeExternalHeaderSafetyLedger.rows[0].safety.failedGates.some(
  (gate) =>
    gate.code
    === 'gpu_hmr_success_cannot_have_failed_real_rocm_external_header_prerequisites',
));
assert.ok(acceptedComputeExternalHeaderSafetyLedger.rows[0].safety.failedGates.some(
  (gate) => gate.code === 'real_rocm_external_header_prerequisites_claimed_gpu_hmr_acceptance',
));

const acceptedNativeBridgeRocmDir = path.join(logsRoot, 'real-rocm-accepted-native-runtime-bridge');
const acceptedNativeBridgeReadback = path.join(acceptedNativeBridgeRocmDir, 'readback.bin');
const acceptedNativeBridgeBytes = Buffer.from([9, 18, 27, 36, 45, 54, 63, 72]);
await fs.mkdir(acceptedNativeBridgeRocmDir, { recursive: true });
await fs.writeFile(acceptedNativeBridgeReadback, acceptedNativeBridgeBytes);
await writeJson(`${acceptedNativeBridgeReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: acceptedNativeBridgeBytes.length,
  shape: [acceptedNativeBridgeBytes.length],
});
await writeRgbaPng(`${acceptedNativeBridgeReadback}.card.png`, 8, 8, (x, y) => [
  acceptedNativeBridgeBytes[(x + y) % acceptedNativeBridgeBytes.length],
  96 + x,
  160 + y,
  255,
]);
const acceptedNativeBridgeProofMaterials =
  realRocmComputeProofLedgerMaterials('accepted-native-runtime-bridge', {
    projectId: 'real-rocm-accepted-native-runtime-bridge',
    rawReadbackPath: acceptedNativeBridgeReadback,
    rawReadbackBytes: acceptedNativeBridgeBytes,
  });
const acceptedNativeBridgeSameProcess =
  acceptedSameProcessRuntimeOracle('accepted-native-runtime-bridge', {
    declared: false,
    appHookContractAccepted: false,
    app_hook_contract_accepted: false,
    nativeRuntimeBridgeAccepted: true,
    native_runtime_bridge_accepted: true,
    nativeRuntimeBridgeObserved: true,
    native_runtime_bridge_observed: true,
    runtimeProofBridgeAccepted: true,
    runtime_proof_bridge_accepted: true,
  });
await writeJson(path.join(acceptedNativeBridgeRocmDir, 'real-rocm-accepted-native-runtime-bridge.json'), {
  slug: 'gpu-real-rocm-accepted-native-runtime-bridge-20260626',
  real_rocm_profile: { id: 'real-rocm-accepted-native-runtime-bridge' },
  source_url: 'https://example.invalid/rocm/accepted-native-runtime-bridge.git',
  repo_commit: 'dddddddddddddddddddddddddddddddddddddddd',
  entry_file: 'src/kernels/native_bridge_entry.hip',
  delta_file: 'src/kernels/native_bridge_delta.h',
  target_name: 'AcceptedNativeRuntimeBridgeDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
  same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
  runtime_proof_artifact: {
    ...acceptedNativeBridgeProofMaterials.runtime_proof_artifact,
    realRocmSameProcessRuntimeOracle: acceptedNativeBridgeSameProcess,
    real_rocm_same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
    sameProcessRuntimeOracle: acceptedNativeBridgeSameProcess,
    same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
  },
  proof_ledger: acceptedNativeBridgeProofMaterials.proof_ledger,
  proofLedger: acceptedNativeBridgeProofMaterials.proofLedger,
  proof_ledger_query: acceptedNativeBridgeProofMaterials.proof_ledger_query,
  proofLedgerQuery: acceptedNativeBridgeProofMaterials.proofLedgerQuery,
  computeOracleArtifacts: acceptedNativeBridgeProofMaterials.computeOracleArtifacts,
  compute_oracle_artifacts: acceptedNativeBridgeProofMaterials.computeOracleArtifacts,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-native-runtime-bridge-delta',
    editHash: hashValue('real-rocm-accepted-native-runtime-bridge-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-native-runtime-bridge.git @ dddddddd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedNativeBridgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedNativeBridgeRocmDir],
  generatedAt: '2026-06-26T00:00:02.255Z',
  includeUnproven: true,
});
const acceptedNativeBridgeRocm = acceptedNativeBridgeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedNativeBridgeRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedNativeBridgeRocm.acceptedForGpuHmr, true);
assert.equal(acceptedNativeBridgeRocm.realRocmAppHookContractGate.required, false);
assert.equal(acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.accepted, true);
assert.equal(
  acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.checks.appHookContractAccepted,
  false,
);
assert.equal(
  acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.checks.nativeRuntimeBridgeAccepted,
  true,
);
assert.equal(
  acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.checks.runtimeProofBridgeAccepted,
  true,
);

const numericEpochComputeRocmDir = path.join(logsRoot, 'real-rocm-accepted-compute-numeric-epoch');
const numericEpochComputeRawReadback = path.join(numericEpochComputeRocmDir, 'readback.bin');
const numericEpochComputeBytes = Buffer.from([2, 4, 8, 16, 32, 64, 128, 255]);
await fs.mkdir(numericEpochComputeRocmDir, { recursive: true });
await fs.writeFile(numericEpochComputeRawReadback, numericEpochComputeBytes);
await writeJson(`${numericEpochComputeRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: numericEpochComputeBytes.length,
  shape: [numericEpochComputeBytes.length],
});
await writeRgbaPng(`${numericEpochComputeRawReadback}.card.png`, 8, 8, (x, y) => [
  numericEpochComputeBytes[(x + y) % numericEpochComputeBytes.length],
  80 + x,
  150 + y,
  255,
]);
const numericEpochComputeProofMaterials = withNumericComputeEpoch(
  realRocmComputeProofLedgerMaterials('accepted-compute-numeric-epoch', {
    projectId: 'real-rocm-accepted-compute-numeric-epoch',
    rawReadbackPath: numericEpochComputeRawReadback,
    rawReadbackBytes: numericEpochComputeBytes,
  }),
  2,
);
await writeJson(path.join(numericEpochComputeRocmDir, 'real-rocm-accepted-compute-numeric-epoch.json'), {
  slug: 'gpu-real-rocm-accepted-compute-numeric-epoch-20260626',
  real_rocm_profile: { id: 'real-rocm-accepted-compute-numeric-epoch' },
  source_url: 'https://example.invalid/rocm/accepted-compute-numeric-epoch.git',
  repo_commit: 'cccccccccccccccccccccccccccccccccccccccc',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'AcceptedComputeNumericEpochDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...numericEpochComputeProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-compute-numeric-epoch-delta',
    editHash: hashValue('real-rocm-accepted-compute-numeric-epoch-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-compute-numeric-epoch.git @ cccccccc files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const numericEpochComputeRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [numericEpochComputeRocmDir],
  generatedAt: '2026-06-09T00:00:02.260Z',
  includeUnproven: true,
});
const numericEpochComputeRocm = numericEpochComputeRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(numericEpochComputeRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(numericEpochComputeRocm.acceptedForGpuHmr, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(numericEpochComputeRocm.outputOracleFacet.accepted, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.epoch, '2');
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.semanticAccepted, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.expectedOutputVerified, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.rawReadbackByteLength, numericEpochComputeBytes.length);

const acceptedLargeMlRocmDir = path.join(logsRoot, 'real-rocm-accepted-large-ml-generic-hook');
const acceptedLargeMlRawReadback = path.join(acceptedLargeMlRocmDir, 'readback.bin');
const acceptedLargeMlBytes = Buffer.from([3, 5, 8, 13, 21, 34, 55, 89]);
await fs.mkdir(acceptedLargeMlRocmDir, { recursive: true });
await fs.writeFile(acceptedLargeMlRawReadback, acceptedLargeMlBytes);
await writeJson(`${acceptedLargeMlRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: acceptedLargeMlBytes.length,
  shape: [acceptedLargeMlBytes.length],
});
await writeRgbaPng(`${acceptedLargeMlRawReadback}.card.png`, 8, 8, (x, y) => [
  acceptedLargeMlBytes[(x + y) % acceptedLargeMlBytes.length],
  70 + x,
  130 + y,
  255,
]);
const acceptedLargeMlProofMaterials = realRocmComputeProofLedgerMaterials(
  'accepted-large-ml-generic-hook',
  {
    projectId: 'real-rocm-accepted-large-ml-generic-hook',
    rawReadbackPath: acceptedLargeMlRawReadback,
    rawReadbackBytes: acceptedLargeMlBytes,
  },
);
const acceptedLargeMlAppHook = acceptedRealRocmAppHookContract('accepted-large-ml-generic-hook');
const acceptedLargeMlAppHookMaterialization =
  acceptedRealRocmAppHookMaterialization('accepted-large-ml-generic-hook');
const acceptedLargeMlSameProcessOracle =
  acceptedSameProcessRuntimeOracle('accepted-large-ml-generic-hook');
const acceptedLargeMlPriorArtifacts = acceptedLargeMlProofMaterials.computeOracleArtifacts;
await writeJson(path.join(acceptedLargeMlRocmDir, 'real-rocm-accepted-large-ml-generic-hook.json'), {
  slug: 'gpu-real-rocm-accepted-large-ml-generic-hook-20260625',
  real_rocm_profile: largeRocmMlProfile('real-rocm-accepted-large-ml-generic-hook'),
  source_url: 'https://example.invalid/rocm/accepted-large-ml-generic-hook.git',
  repo_commit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  entry_file: 'src/kernels/generic_large_ml_entry.hip',
  delta_file: 'src/kernels/generic_large_ml_delta.h',
  target_name: 'AcceptedLargeMlGenericHookDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'AcceptedLargeMlGenericHookDriver',
    finalAcceptanceTarget: 'AcceptedLargeMlGenericHookDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_ledger: {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
    provided: true,
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        resultState: 'gpu-hmr-output-oracle-proven',
        outputOracleProven: true,
        proofId: 'large-ml-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
        compute_oracle_artifacts: acceptedLargeMlPriorArtifacts,
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'large-ml-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'large-ml-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
        originalHostPathProven: true,
        attachmentProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_profile_proof_obligations:
    acceptedLargeRocmProfileObligations('accepted-large-ml-generic-hook'),
  real_rocm_source_delta_execution:
    acceptedLargeRocmSourceDeltaExecution('accepted-large-ml-generic-hook'),
  real_rocm_external_header_prerequisites:
    realRocmExternalHeaderPrerequisitesFixture('accepted-large-ml-generic-hook'),
  realRocmExternalHeaderPrerequisites:
    realRocmExternalHeaderPrerequisitesFixture('accepted-large-ml-generic-hook'),
  real_rocm_app_hook_contract: acceptedLargeMlAppHook,
  real_rocm_app_hook_materialization: acceptedLargeMlAppHookMaterialization,
  real_rocm_same_process_runtime_oracle: acceptedLargeMlSameProcessOracle,
  runtime_proof_artifact: {
    ...acceptedLargeMlProofMaterials.runtime_proof_artifact,
    realRocmAppHookContract: acceptedLargeMlAppHook,
    real_rocm_app_hook_contract: acceptedLargeMlAppHook,
    realRocmAppHookMaterialization: acceptedLargeMlAppHookMaterialization,
    real_rocm_app_hook_materialization: acceptedLargeMlAppHookMaterialization,
    realRocmSameProcessRuntimeOracle: acceptedLargeMlSameProcessOracle,
    real_rocm_same_process_runtime_oracle: acceptedLargeMlSameProcessOracle,
    sameProcessRuntimeOracle: acceptedLargeMlSameProcessOracle,
    same_process_runtime_oracle: acceptedLargeMlSameProcessOracle,
    realRocmProfileProofObligations:
      acceptedLargeRocmProfileObligations('accepted-large-ml-generic-hook'),
    real_rocm_profile_proof_obligations:
      acceptedLargeRocmProfileObligations('accepted-large-ml-generic-hook'),
    realRocmSourceDeltaExecution:
      acceptedLargeRocmSourceDeltaExecution('accepted-large-ml-generic-hook'),
    real_rocm_source_delta_execution:
      acceptedLargeRocmSourceDeltaExecution('accepted-large-ml-generic-hook'),
    realRocmExternalHeaderPrerequisites:
      realRocmExternalHeaderPrerequisitesFixture('accepted-large-ml-generic-hook'),
    real_rocm_external_header_prerequisites:
      realRocmExternalHeaderPrerequisitesFixture('accepted-large-ml-generic-hook'),
  },
  proof_ledger: acceptedLargeMlProofMaterials.proof_ledger,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-large-ml-generic-hook-delta',
    editHash: hashValue('real-rocm-accepted-large-ml-generic-hook-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-large-ml-generic-hook.git @ eeeeeeee files=30000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedLargeMlRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedLargeMlRocmDir],
  generatedAt: '2026-06-25T00:00:02.275Z',
  includeUnproven: true,
});
const acceptedLargeMlRocm = acceptedLargeMlRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedLargeMlRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedLargeMlRocm.acceptedForGpuHmr, true);
assert.equal(acceptedLargeMlRocm.realRocmAppHookContractGate.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmAppHookMaterializationGate.required, true);
assert.equal(acceptedLargeMlRocm.realRocmAppHookMaterializationGate.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmSameProcessRuntimeOracleGate.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmSameProcessRuntimeOracleGate.proven, true);
assert.equal(acceptedLargeMlRocm.realRocmSourceDeltaExecution.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmSourceDeltaExecution.hotDelta2PhaseExecuted, true);
assert.equal(acceptedLargeMlRocm.realRocmSourceDeltaExecution.negativeEditPhaseExecuted, true);
assert.equal(acceptedLargeMlRocm.realRocmProfileProofObligations.blockingGaps.length, 0);
assert.equal(acceptedLargeMlRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(acceptedLargeMlRocm.outputOracleFacet.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmExternalHeaderPrerequisites.present, true);
assert.equal(acceptedLargeMlRocm.realRocmExternalHeaderPrerequisites.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmExternalHeaderPrerequisites.acceptedAsDependencyEvidence, true);
assert.equal(acceptedLargeMlRocm.realRocmExternalHeaderPrerequisites.acceptedForGpuHmr, false);
assert.equal(acceptedLargeMlRocm.realRocmExternalHeaderPrerequisites.gpuHmrSuccess, false);
assert.equal(acceptedLargeMlRocm.realRocmExternalHeaderPrerequisites.canSatisfyRuntimeProof, false);

async function writeSameProcessOracleNegative({
  scope,
  appHookOverrides = {},
  sameProcessOverrides = {},
  mutateMaterials = null,
  omitSameProcessOracle = false,
  omitRuntimeProofArtifact = false,
  expectedGap = null,
  expectedAppHookGap = null,
}) {
  const dir = path.join(logsRoot, scope);
  const rawReadback = path.join(dir, 'readback.bin');
  const bytes = Buffer.from([11, 22, 33, 44, 55, 66, 77, 88]);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(rawReadback, bytes);
  await writeJson(`${rawReadback}.schema.json`, {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    elementType: 'u8',
    byteLength: bytes.length,
    shape: [bytes.length],
  });
  await writeRgbaPng(`${rawReadback}.card.png`, 8, 8, (x, y) => [
    bytes[(x + y) % bytes.length],
    50 + x,
    90 + y,
    255,
  ]);
  const materials = realRocmComputeProofLedgerMaterials(scope, {
    projectId: scope,
    rawReadbackPath: rawReadback,
    rawReadbackBytes: bytes,
  });
  if (typeof mutateMaterials === 'function') {
    mutateMaterials(materials);
  }
  const appHook = acceptedRealRocmAppHookContract(scope, appHookOverrides);
  const sameProcessOracle = omitSameProcessOracle
    ? null
    : acceptedSameProcessRuntimeOracle(scope, sameProcessOverrides);
  const runtimeProofArtifact = omitRuntimeProofArtifact
    ? null
    : {
      ...materials.runtime_proof_artifact,
      realRocmAppHookContract: appHook,
      real_rocm_app_hook_contract: appHook,
      ...(sameProcessOracle ? {
        realRocmSameProcessRuntimeOracle: sameProcessOracle,
        real_rocm_same_process_runtime_oracle: sameProcessOracle,
        sameProcessRuntimeOracle: sameProcessOracle,
        same_process_runtime_oracle: sameProcessOracle,
      } : {}),
      realRocmProfileProofObligations: acceptedLargeRocmProfileObligations(scope),
      real_rocm_profile_proof_obligations: acceptedLargeRocmProfileObligations(scope),
      realRocmSourceDeltaExecution: acceptedLargeRocmSourceDeltaExecution(scope),
      real_rocm_source_delta_execution: acceptedLargeRocmSourceDeltaExecution(scope),
    };
  await writeJson(path.join(dir, `${scope}.json`), {
    slug: `gpu-${scope}-20260625`,
    real_rocm_profile: largeRocmMlProfile(scope),
    source_url: `https://example.invalid/rocm/${scope}.git`,
    repo_commit: 'abababababababababababababababababababab',
    entry_file: `src/${scope}/entry.hip`,
    delta_file: `src/${scope}/delta.h`,
    target_name: `${scope}-driver`,
    gpu_vendor: 'rocm',
    full_runtime_proof_required: true,
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      selectedSource: 'profile_runtime_profile',
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    target_progression: {
      schemaVersion: 'synthi.real_rocm.target_progression.v1',
      required: true,
      phaseRaw: 'final-acceptance',
      phase: 'final-acceptance',
      recognized: true,
      targetName: `${scope}-driver`,
      finalAcceptanceTarget: `${scope}-driver`,
      finalAcceptanceTargetDeclared: true,
      targetMatchesFinalAcceptance: true,
    },
    target_progression_ledger: {
      schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
      provided: true,
      entries: [
        {
          phase: 'small-oracle',
          status: 'pass',
          resultState: 'gpu-hmr-output-oracle-proven',
          outputOracleProven: true,
          proofId: `${scope}-small:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
          schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
          compute_oracle_artifacts: materials.computeOracleArtifacts,
        },
        {
          phase: 'partial-reload',
          status: 'pass',
          proofId: `${scope}-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
          schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
          partialReloadProven: true,
          fissionProven: true,
        },
        {
          phase: 'original-host-path',
          status: 'pass',
          proofId: `${scope}-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc`,
          schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
          originalHostPathProven: true,
          attachmentProven: true,
          hostPreservationProven: true,
          dispatchSafeProven: true,
        },
      ],
    },
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    real_rocm_profile_proof_obligations: acceptedLargeRocmProfileObligations(scope),
    real_rocm_source_delta_execution: acceptedLargeRocmSourceDeltaExecution(scope),
    real_rocm_app_hook_contract: appHook,
    real_rocm_same_process_runtime_oracle: sameProcessOracle,
    runtime_proof_artifact: runtimeProofArtifact,
    proof_ledger: materials.proof_ledger,
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `${scope}-delta`,
      editHash: hashValue(`${scope}-delta`),
    },
    checks: [
      { name: 'real ROCm repo', status: 'pass', detail: `https://example.invalid/rocm/${scope}.git @ abababab files=30000` },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const negativeLedger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-25T00:00:02.276Z',
    includeUnproven: true,
  });
  const row = negativeLedger.rows.find((candidate) =>
    candidate.proofMode === 'real_rocm_repo_validation'
  );
  assert.equal(row?.matrixOutcome, 'unproven');
  assert.equal(row.acceptedForGpuHmr, false);
  if (expectedGap) {
    assert.equal(row.realRocmSameProcessRuntimeOracleGate.accepted, false);
    assert.ok(row.openGaps.includes('real_rocm_same_process_runtime_oracle_required'));
    assert.ok(row.openGaps.includes(`real_rocm_same_process_runtime_oracle:${expectedGap}`));
  }
  if (expectedAppHookGap) {
    assert.equal(row.realRocmAppHookContractGate.proven, false);
    assert.ok(row.openGaps.includes('real_rocm_app_hook_contract_required'));
    assert.ok(row.openGaps.includes(expectedAppHookGap));
  }
}

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-hook',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    appHookContractAccepted: false,
    app_hook_contract_accepted: false,
    blockingGaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
    blocking_gaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
  },
  expectedGap: 'same_process_runtime_oracle_app_hook_contract_unproven',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-unresolved-hook-ref',
  appHookOverrides: {
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status: 'declared_app_hook_contract_incomplete',
    blockingGaps: ['app_hook_epoch_publication_evidence_ref_unresolved'],
    blocking_gaps: ['app_hook_epoch_publication_evidence_ref_unresolved'],
  },
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    appHookContractAccepted: false,
    app_hook_contract_accepted: false,
    blockingGaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
    blocking_gaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
  },
  expectedGap: 'same_process_runtime_oracle_app_hook_contract_unproven',
});

const forgedStageScope = 'real-rocm-forged-app-hook-stage-evidence';
const forgedStageResults = JSON.parse(JSON.stringify(
  acceptedRealRocmAppHookContract(forgedStageScope).stageResults,
));
for (const stageKey of ['epoch_publication', 'epochPublication']) {
  forgedStageResults[stageKey] = {
    ...forgedStageResults[stageKey],
    contractEvidencePresent: false,
    contract_evidence_present: false,
    unresolvedEvidenceRefs: ['evidence:app-hook:unresolved-epoch-publication'],
    unresolved_evidence_refs: ['evidence:app-hook:unresolved-epoch-publication'],
  };
}
await writeSameProcessOracleNegative({
  scope: forgedStageScope,
  appHookOverrides: {
    stageResults: forgedStageResults,
    stage_results: forgedStageResults,
  },
  expectedAppHookGap: 'real_rocm_app_hook_contract_stage_epoch_publication_evidence_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-output-target',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    outputTargetObserved: false,
    output_target_observed: false,
    outputTargetMatched: false,
    output_target_matched: false,
    blockingGaps: ['same_process_runtime_oracle_output_target_missing'],
    blocking_gaps: ['same_process_runtime_oracle_output_target_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_output_target_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-output-target-mismatch',
  sameProcessOverrides: {
    outputTargetMatched: false,
    output_target_matched: false,
  },
  expectedGap: 'same_process_runtime_oracle_output_target_mismatch',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-evidence-closure',
  sameProcessOverrides: {
    evidenceRefs: ['evidence:same-process-runtime-oracle:unbound'],
    evidence_refs: ['evidence:same-process-runtime-oracle:unbound'],
  },
  expectedGap: 'same_process_runtime_oracle_evidence_ref_closure_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-stage-results',
  sameProcessOverrides: {
    stageResults: null,
    stage_results: null,
  },
  expectedGap: 'same_process_runtime_oracle_stage_results_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-runtime-chain-mismatch',
  mutateMaterials(materials) {
    const record = materials.proof_ledger.records[0];
    const outputEvent = record.output_event ?? record.outputEvent;
    outputEvent.output_target_id = 'output-target:mutated-after-facet';
    outputEvent.outputTargetId = 'output-target:mutated-after-facet';
    materials.runtime_proof_artifact.proofLedger = materials.proof_ledger;
    materials.runtime_proof_artifact.proof_ledger = materials.proof_ledger;
  },
  expectedGap: 'same_process_runtime_oracle_runtime_chain_closure_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-facet',
  omitSameProcessOracle: true,
  expectedGap: 'same_process_runtime_oracle_contract_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-wrong-schema',
  sameProcessOverrides: {
    schemaVersion: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v0',
    schema_version: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v0',
  },
  expectedGap: 'same_process_runtime_oracle_contract_schema_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-artifact-transport',
  sameProcessOverrides: {
    artifactTransportObserved: false,
    artifact_transport_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_artifact_transport_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-epoch-publication',
  sameProcessOverrides: {
    epochPublicationObserved: false,
    epoch_publication_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_epoch_publication_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-dispatch-trace',
  sameProcessOverrides: {
    dispatchTraceObserved: false,
    dispatch_trace_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_dispatch_trace_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-dispatch-epoch-mismatch',
  sameProcessOverrides: {
    dispatchUsedPublishedEpoch: false,
    dispatch_used_published_epoch: false,
  },
  expectedGap: 'same_process_runtime_oracle_dispatch_epoch_mismatch',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-output-oracle',
  sameProcessOverrides: {
    outputOracleObserved: false,
    output_oracle_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_output_oracle_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-full-runtime-missing',
  sameProcessOverrides: {
    blockingGaps: ['same_process_runtime_oracle_full_runtime_proof_missing'],
    blocking_gaps: ['same_process_runtime_oracle_full_runtime_proof_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_full_runtime_proof_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-cpu-hmr-used',
  sameProcessOverrides: {
    firewallAccepted: false,
    firewall_accepted: false,
    cpuHmrUsed: true,
    cpu_hmr_used: true,
  },
  expectedGap: 'same_process_runtime_oracle_firewall_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-full-rebuild-used',
  sameProcessOverrides: {
    firewallAccepted: false,
    firewall_accepted: false,
    fullRebuildUsed: true,
    full_rebuild_used: true,
  },
  expectedGap: 'same_process_runtime_oracle_firewall_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-process-restarted',
  sameProcessOverrides: {
    firewallAccepted: false,
    firewall_accepted: false,
    processRestarted: true,
    process_restarted: true,
  },
  expectedGap: 'same_process_runtime_oracle_firewall_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-runtime-artifact-missing',
  omitRuntimeProofArtifact: true,
  expectedGap: 'same_process_runtime_oracle_strict_runtime_proof_artifact_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-process-mismatch',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sameProcessIdentityObserved: false,
    same_process_identity_observed: false,
    blockingGaps: ['same_process_runtime_oracle_process_identity_missing'],
    blocking_gaps: ['same_process_runtime_oracle_process_identity_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_process_identity_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-oracle-before-dispatch',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    outputAfterDispatchObserved: false,
    output_after_dispatch_observed: false,
    blockingGaps: ['same_process_runtime_oracle_after_dispatch_missing'],
    blocking_gaps: ['same_process_runtime_oracle_after_dispatch_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_after_dispatch_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-artifact-mismatch',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    artifactEpochMatched: false,
    artifact_epoch_matched: false,
    blockingGaps: ['same_process_runtime_oracle_artifact_epoch_mismatch'],
    blocking_gaps: ['same_process_runtime_oracle_artifact_epoch_mismatch'],
  },
  expectedGap: 'same_process_runtime_oracle_artifact_epoch_mismatch',
});

const forgedComputeSemanticRocmDir = path.join(logsRoot, 'real-rocm-forged-compute-semantic');
const forgedComputeSemanticReadback = path.join(forgedComputeSemanticRocmDir, 'readback.bin');
const forgedComputeSemanticBytes = Buffer.from([5, 10, 15, 20, 25, 30, 35, 40]);
await fs.mkdir(forgedComputeSemanticRocmDir, { recursive: true });
await fs.writeFile(forgedComputeSemanticReadback, forgedComputeSemanticBytes);
await writeJson(`${forgedComputeSemanticReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedComputeSemanticBytes.length,
  shape: [forgedComputeSemanticBytes.length],
});
await writeRgbaPng(`${forgedComputeSemanticReadback}.card.png`, 8, 8, (x, y) => [
  forgedComputeSemanticBytes[(x + y) % forgedComputeSemanticBytes.length],
  64 + x,
  96 + y,
  255,
]);
const forgedComputeSemanticProofMaterials = stripExpectedOutputVerified(
  realRocmComputeProofLedgerMaterials('forged-compute-semantic', {
    projectId: 'real-rocm-forged-compute-semantic',
    rawReadbackPath: forgedComputeSemanticReadback,
    rawReadbackBytes: forgedComputeSemanticBytes,
  }),
);
const forgedComputeSemanticSliceLength = Math.min(4, forgedComputeSemanticBytes.length);
const forgedComputeSemanticPriorArtifacts = {
  raw_readback_bin: forgedComputeSemanticReadback,
  readback_schema_json: `${forgedComputeSemanticReadback}.schema.json`,
  checksum_before: hashValue('forged-compute-semantic-prior-before'),
  checksum_after: hashValue('forged-compute-semantic-prior-after'),
  deterministic_slice: {
    offset: 0,
    length: forgedComputeSemanticSliceLength,
    hash: hashBuffer(forgedComputeSemanticBytes.subarray(0, forgedComputeSemanticSliceLength)),
  },
  deterministic_slice_hash: hashBuffer(forgedComputeSemanticBytes.subarray(0, forgedComputeSemanticSliceLength)),
  deterministic_slice_hash_verified: true,
  oracle_code_hash: hashValue('forged-compute-semantic-prior-oracle'),
  rendered_card_png: `${forgedComputeSemanticReadback}.card.png`,
  producer: 'synthetic_compute_oracle',
  timestamp_after_dispatch: 4000,
  epoch: 'epoch:forged-compute-semantic',
  raw_readback_hash: hashBuffer(forgedComputeSemanticBytes),
  raw_readback_hash_verified: true,
  raw_readback_byte_length: forgedComputeSemanticBytes.length,
  raw_readback_source: 'runtime_raw_readback',
  output_change_expected: true,
};
await writeJson(path.join(forgedComputeSemanticRocmDir, 'real-rocm-forged-compute-semantic.json'), {
  slug: 'gpu-real-rocm-forged-compute-semantic-20260625',
  real_rocm_profile: { id: 'real-rocm-forged-compute-semantic' },
  source_url: 'https://example.invalid/rocm/forged-compute-semantic.git',
  repo_commit: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  entry_file: 'src/kernels/compute_semantic_entry.hip',
  delta_file: 'src/kernels/compute_semantic_delta.h',
  target_name: 'ForgedComputeSemanticDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedComputeSemanticDriver',
    finalAcceptanceTarget: 'ForgedComputeSemanticDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_ledger: {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
    provided: true,
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        resultState: 'gpu-hmr-output-oracle-proven',
        outputOracleProven: true,
        proofId: 'compute-semantic-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
        compute_oracle_artifacts: forgedComputeSemanticPriorArtifacts,
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'compute-semantic-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'compute-semantic-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
        originalHostPathProven: true,
        attachmentProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  },
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedComputeSemanticProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-compute-semantic-delta',
    editHash: hashValue('real-rocm-forged-compute-semantic-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-compute-semantic.git @ cdcdcdcd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedComputeSemanticLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedComputeSemanticRocmDir],
  generatedAt: '2026-06-25T00:00:02.300Z',
  includeUnproven: true,
});
const forgedComputeSemanticRocm = forgedComputeSemanticLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
const forgedComputeSemanticSmallOracleGate = forgedComputeSemanticRocm?.targetProgressionGates.find(
  (gate) => gate.name === 'target progression prior small-oracle',
);
assert.equal(forgedComputeSemanticRocm?.matrixOutcome, 'unproven');
assert.equal(forgedComputeSemanticRocm.acceptedForGpuHmr, false);
assert.equal(forgedComputeSemanticRocm.outputOracleFacet.kind, 'ledger_rejected');
assert.equal(forgedComputeSemanticSmallOracleGate?.status, 'fail');
assert.match(forgedComputeSemanticSmallOracleGate?.detail ?? '', /compute_oracle_expected_output_not_verified/);
assert.ok(forgedComputeSemanticRocm.reasons.includes(
  'target_progression_gate_failed:target progression prior small-oracle',
));
assert.ok(forgedComputeSemanticRocm.openGaps.includes('target_progression_gates_failed'));

const forgedFinalMissingFixturesRocmDir = path.join(logsRoot, 'real-rocm-forged-final-missing-fixtures');
const forgedFinalMissingFixturesReadback = path.join(forgedFinalMissingFixturesRocmDir, 'readback.bin');
const forgedFinalMissingFixturesBytes = Buffer.from([2, 4, 8, 16, 32, 64, 128, 255]);
await fs.mkdir(forgedFinalMissingFixturesRocmDir, { recursive: true });
await fs.writeFile(forgedFinalMissingFixturesReadback, forgedFinalMissingFixturesBytes);
await writeJson(`${forgedFinalMissingFixturesReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedFinalMissingFixturesBytes.length,
  shape: [forgedFinalMissingFixturesBytes.length],
});
await writeRgbaPng(`${forgedFinalMissingFixturesReadback}.card.png`, 8, 8, (x, y) => [
  forgedFinalMissingFixturesBytes[(x + y) % forgedFinalMissingFixturesBytes.length],
  72 + x,
  108 + y,
  255,
]);
const forgedFinalMissingFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-final-missing-fixtures',
  {
    projectId: 'real-rocm-forged-final-missing-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(forgedFinalMissingFixturesRocmDir, 'real-rocm-forged-final-missing-fixtures.json'), {
  slug: 'gpu-real-rocm-forged-final-missing-fixtures-20260625',
  real_rocm_profile: {
    id: 'real-rocm-forged-final-missing-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    targetClass: 'large_rocm_ml_infrastructure',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    sourceDelta: {
      before: 'value = value + 1;',
      after: 'value = value + 2;',
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
    },
  },
  source_url: 'https://example.invalid/rocm/forged-final-missing-fixtures.git',
  repo_commit: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'ForgedFinalMissingFixturesDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalMissingFixturesDriver',
    finalAcceptanceTarget: 'ForgedFinalMissingFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalMissingFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-missing-fixtures-delta',
    editHash: hashValue('real-rocm-forged-final-missing-fixtures-delta'),
  },
  checks: [
    {
      name: 'real ROCm repo',
      status: 'pass',
      detail: 'https://example.invalid/rocm/forged-final-missing-fixtures.git @ f1f1f1f1 files=18000',
    },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedFinalMissingFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalMissingFixturesRocmDir],
  generatedAt: '2026-06-25T00:00:02.400Z',
  includeUnproven: true,
});
const forgedFinalMissingFixturesRocm = forgedFinalMissingFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalMissingFixturesRocm?.matrixOutcome, 'unproven');
assert.notEqual(forgedFinalMissingFixturesRocm.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedFinalMissingFixturesRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalMissingFixturesRocm.targetProgressionEvidence, false);
assert.equal(forgedFinalMissingFixturesRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedFinalMissingFixturesRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedFinalMissingFixturesRocm.outputOracleFacet.accepted, true);
assert.equal(forgedFinalMissingFixturesRocm.outputOracleResolutionGate.accepted, true);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.requiresRunModesDeclared, true);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.requiresNegativeEditDeclared, true);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, false);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, false);
assert.ok(forgedFinalMissingFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_fixture_missing',
));
assert.ok(forgedFinalMissingFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_fixture_missing',
));
assert.ok(forgedFinalMissingFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_fixture_missing',
));
assert.ok(forgedFinalMissingFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_fixture_missing',
));

const forgedFinalUnexecutedFixturesRocmDir = path.join(logsRoot, 'real-rocm-forged-final-unexecuted-fixtures');
const forgedFinalUnexecutedFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-final-unexecuted-fixtures',
  {
    projectId: 'real-rocm-forged-final-unexecuted-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(forgedFinalUnexecutedFixturesRocmDir, 'real-rocm-forged-final-unexecuted-fixtures.json'), {
  slug: 'gpu-real-rocm-forged-final-unexecuted-fixtures-20260625',
  real_rocm_profile: {
    id: 'real-rocm-forged-final-unexecuted-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    sourceDelta: {
      before: 'value = value + 1;',
      after: 'value = value + 2;',
      second: {
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 2;',
        after: 'value = value + 3;',
      },
      extraDeltas: [{
        label: 'negative-edit',
        kind: 'negative_edit',
        expectedRefusal: true,
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 3;',
        after: 'value = layout_breaking(value);',
      }],
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
    },
  },
  source_url: 'https://example.invalid/rocm/forged-final-unexecuted-fixtures.git',
  repo_commit: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'ForgedFinalUnexecutedFixturesDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalUnexecutedFixturesDriver',
    finalAcceptanceTarget: 'ForgedFinalUnexecutedFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalUnexecutedFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-unexecuted-fixtures-delta',
    editHash: hashValue('real-rocm-forged-final-unexecuted-fixtures-delta'),
  },
  checks: [
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
  ],
});
const forgedFinalUnexecutedFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalUnexecutedFixturesRocmDir],
  generatedAt: '2026-06-25T00:00:02.500Z',
  includeUnproven: true,
});
const forgedFinalUnexecutedFixturesRocm = forgedFinalUnexecutedFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalUnexecutedFixturesRocm?.matrixOutcome, 'unproven');
assert.equal(forgedFinalUnexecutedFixturesRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, true);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, true);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2PhaseExecuted, false);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditPhaseExecuted, false);
assert.ok(forgedFinalUnexecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.reasons.includes(
  'real_rocm_source_delta_execution:source_delta_execution_missing',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));

const compactSerializedFixturesRocmDir = path.join(logsRoot, 'real-rocm-compact-serialized-fixtures');
const compactSerializedFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'compact-serialized-fixtures',
  {
    projectId: 'real-rocm-compact-serialized-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(compactSerializedFixturesRocmDir, 'real-rocm-compact-serialized-fixtures.json'), {
  slug: 'gpu-real-rocm-compact-serialized-fixtures-20260626',
  real_rocm_profile: {
    id: 'real-rocm-compact-serialized-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
    },
  },
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status: 'profile_proof_obligations_unmet',
    proofAuthority: 'profile_configuration_gate_not_runtime_proof',
    sourceDeltaFixtures: {
      schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_fixtures.v1',
      proofAuthority: 'profile_configuration_only_not_runtime_proof',
      hotDelta2Declared: true,
      hot_delta_2_declared: true,
      secondDeltaDeclared: true,
      second_delta_declared: true,
      negativeEditDeclared: true,
      negative_edit_declared: true,
      fallbackFile: 'src/kernels/final_fixture_delta.h',
      fallback_file: 'src/kernels/final_fixture_delta.h',
      executableExtraDeltaCount: 1,
      executable_extra_delta_count: 1,
      hotDelta2FixtureCount: 1,
      hot_delta_2_fixture_count: 1,
      negativeEditFixtureCount: 1,
      negative_edit_fixture_count: 1,
    },
  },
  source_url: 'https://example.invalid/rocm/compact-serialized-fixtures.git',
  repo_commit: 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'CompactSerializedFixturesDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'CompactSerializedFixturesDriver',
    finalAcceptanceTarget: 'CompactSerializedFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...compactSerializedFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-compact-serialized-fixtures-delta',
    editHash: hashValue('real-rocm-compact-serialized-fixtures-delta'),
  },
  checks: [
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
  ],
});
const compactSerializedFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [compactSerializedFixturesRocmDir],
  generatedAt: '2026-06-26T00:00:02.550Z',
  includeUnproven: true,
});
const compactSerializedFixturesRocm = compactSerializedFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(compactSerializedFixturesRocm?.matrixOutcome, 'unproven');
assert.equal(compactSerializedFixturesRocm.acceptedForGpuHmr, false);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.profileSourceDeltaPresent, false);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.serializedConfigurationUsed, true);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, true);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, true);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2PhaseExecuted, false);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditPhaseExecuted, false);
assert.ok(!compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_fixture_missing',
));
assert.ok(!compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_fixture_missing',
));
assert.ok(compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));

const forgedFinalExecutedFixturesRocmDir = path.join(logsRoot, 'real-rocm-forged-final-executed-fixtures');
const forgedFinalExecutedFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-final-executed-fixtures',
  {
    projectId: 'real-rocm-forged-final-executed-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(forgedFinalExecutedFixturesRocmDir, 'real-rocm-forged-final-executed-fixtures.json'), {
  slug: 'gpu-real-rocm-forged-final-executed-fixtures-20260625',
  real_rocm_profile: {
    id: 'real-rocm-forged-final-executed-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    sourceDelta: {
      before: 'value = value + 1;',
      after: 'value = value + 2;',
      second: {
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 2;',
        after: 'value = value + 3;',
      },
      extraDeltas: [{
        label: 'negative-edit',
        kind: 'negative_edit',
        expectedRefusal: true,
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 3;',
        after: 'value = layout_breaking(value);',
      }],
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
      requiresAppHookContract: true,
    },
  },
  source_url: 'https://example.invalid/rocm/forged-final-executed-fixtures.git',
  repo_commit: 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'ForgedFinalExecutedFixturesDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  source_delta_execution: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_execution.v1',
    phases: [
      {
        label: 'second',
        phaseKind: 'hot_delta_2',
        phaseName: 'real_repo_second_user_source_delta_hmr',
        file: 'src/kernels/final_fixture_delta.h',
        editHash: hashValue('executed-fixtures-hot-delta-2-edit'),
        sourceBeforeHash: hashValue('executed-fixtures-hot-delta-2-before'),
        sourceAfterHash: hashValue('executed-fixtures-hot-delta-2-after'),
        sourceWriteObserved: true,
        compileCallAttempted: true,
        compileCallCompleted: true,
        hmrWaitStatus: 'applied',
      },
      {
        label: 'negative-edit',
        phaseKind: 'negative_edit',
        phaseName: 'real_repo_negative-edit_user_source_delta_hmr',
        file: 'src/kernels/final_fixture_delta.h',
        editHash: hashValue('executed-fixtures-negative-edit'),
        sourceBeforeHash: hashValue('executed-fixtures-negative-before'),
        sourceAfterHash: hashValue('executed-fixtures-negative-after'),
        sourceWriteObserved: true,
        compileCallAttempted: true,
        compileCallCompleted: true,
        hmrWaitStatus: 'rejected',
        expectedRefusal: true,
      },
    ],
  },
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalExecutedFixturesDriver',
    finalAcceptanceTarget: 'ForgedFinalExecutedFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalExecutedFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-executed-fixtures-delta',
    editHash: hashValue('real-rocm-forged-final-executed-fixtures-delta'),
  },
  checks: [
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
  ],
});
const forgedFinalExecutedFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalExecutedFixturesRocmDir],
  generatedAt: '2026-06-25T00:00:02.600Z',
  includeUnproven: true,
});
const forgedFinalExecutedFixturesRocm = forgedFinalExecutedFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalExecutedFixturesRocm?.matrixOutcome, 'unproven');
assert.equal(forgedFinalExecutedFixturesRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmSourceDeltaExecution.present, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmSourceDeltaExecution.accepted, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2PhaseExecuted, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditPhaseExecuted, true);
assert.ok(!forgedFinalExecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(!forgedFinalExecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));
assert.ok(!forgedFinalExecutedFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(forgedFinalExecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_app_hook_contract_missing',
));

const forgedRuntimeChainMismatchRocmDir = path.join(logsRoot, 'real-rocm-forged-runtime-chain-mismatch');
const forgedRuntimeChainMismatchProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-runtime-chain-mismatch',
  {
    projectId: 'real-rocm-forged-runtime-chain-mismatch',
    rawReadbackPath: acceptedComputeRawReadback,
    rawReadbackBytes: acceptedComputeBytes,
    outputRuntimeSessionId: 'runtime-session:wrong-output-session',
  },
);
await writeJson(path.join(forgedRuntimeChainMismatchRocmDir, 'real-rocm-forged-runtime-chain-mismatch.json'), {
  slug: 'gpu-real-rocm-forged-runtime-chain-mismatch-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-runtime-chain-mismatch' },
  source_url: 'https://example.invalid/rocm/forged-runtime-chain-mismatch.git',
  repo_commit: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'ForgedRuntimeChainMismatchDriver',
  gpu_vendor: 'rocm',
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedRuntimeChainMismatchProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-runtime-chain-mismatch-delta',
    editHash: hashValue('real-rocm-forged-runtime-chain-mismatch-delta'),
  },
  checks: [
    {
      name: 'real ROCm repo',
      status: 'pass',
      detail: 'https://example.invalid/rocm/forged-runtime-chain-mismatch.git @ cdcdcdcd files=18000',
    },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedRuntimeChainMismatchRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRuntimeChainMismatchRocmDir],
  generatedAt: '2026-06-09T00:00:02.255Z',
  includeUnproven: true,
});
const forgedRuntimeChainMismatchRocm = forgedRuntimeChainMismatchRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedRuntimeChainMismatchRocm?.matrixOutcome, 'unproven');
assert.equal(forgedRuntimeChainMismatchRocm.acceptedForGpuHmr, false);
assert.equal(forgedRuntimeChainMismatchRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedRuntimeChainMismatchRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedRuntimeChainMismatchRocm.outputOracleFacet.accepted, true);
assert.equal(forgedRuntimeChainMismatchRocm.outputOracleResolutionGate.accepted, true);
assert.equal(forgedRuntimeChainMismatchRocm.realRocmRuntimeChain.accepted, false);
assert.ok(forgedRuntimeChainMismatchRocm.reasons.includes(
  'real_rocm_runtime_chain_session_mismatch',
));
assert.ok(forgedRuntimeChainMismatchRocm.openGaps.includes('real_rocm_runtime_chain_required'));

async function writeForgedRuntimeChainCase({
  slug,
  mutateRecord,
  expectedReason,
  expectedOutputOracleAccepted = true,
  expectedOutputOracleFailedGates = [],
}) {
  const dir = path.join(logsRoot, `real-rocm-forged-runtime-chain-${slug}`);
  const scope = `forged-runtime-chain-${slug}`;
  const materials = realRocmComputeProofLedgerMaterials(scope, {
    projectId: `real-rocm-forged-runtime-chain-${slug}`,
    rawReadbackPath: acceptedComputeRawReadback,
    rawReadbackBytes: acceptedComputeBytes,
  });
  const mutatedRecord = structuredClone(materials.proofLedger.records[0]);
  mutateRecord(mutatedRecord);
  const proofLedger = buildGpuHmrProofLedger(mutatedRecord);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  materials.proofLedger = proofLedger;
  materials.proof_ledger = proofLedger;
  materials.proofLedgerQuery = proofLedgerQuery;
  materials.proof_ledger_query = proofLedgerQuery;
  materials.runtimeProofArtifact.proofLedger = proofLedger;
  materials.runtimeProofArtifact.proofLedgerQuery = proofLedgerQuery;
  materials.runtime_proof_artifact.proofLedger = proofLedger;
  materials.runtime_proof_artifact.proofLedgerQuery = proofLedgerQuery;
  await writeJson(path.join(dir, `real-rocm-forged-runtime-chain-${slug}.json`), {
    slug: `gpu-real-rocm-forged-runtime-chain-${slug}-20260623`,
    real_rocm_profile: { id: `real-rocm-forged-runtime-chain-${slug}` },
    source_url: `https://example.invalid/rocm/forged-runtime-chain-${slug}.git`,
    repo_commit: 'cececececececececececececececececececece',
    entry_file: 'src/kernels/compute_entry.hip',
    delta_file: 'src/kernels/compute_delta.h',
    target_name: `ForgedRuntimeChain${slug}`,
    gpu_vendor: 'rocm',
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      sourceDerivedCandidateCount: 0,
      selectedSource: 'profile_runtime_profile',
      disabledReason: null,
      failedReason: null,
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    ...materials,
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `real-rocm-forged-runtime-chain-${slug}-delta`,
      editHash: hashValue(`real-rocm-forged-runtime-chain-${slug}-delta`),
    },
    checks: [
      {
        name: 'real ROCm repo',
        status: 'pass',
        detail: `https://example.invalid/rocm/forged-runtime-chain-${slug}.git @ cececece files=18000`,
      },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const ledger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-09T00:00:02.260Z',
    includeUnproven: true,
  });
  const row = ledger.rows.find((entry) => entry.proofMode === 'real_rocm_repo_validation');
  assert.equal(row?.matrixOutcome, 'unproven');
  assert.equal(row.acceptedForGpuHmr, false);
  assert.equal(row.runtimeProofArtifact.accepted, true);
  assert.equal(row.ledger.gpuHmrSuccess, true);
  assert.equal(row.outputOracleFacet.accepted, expectedOutputOracleAccepted);
  const outputOracleFailedGateCodes = (row.outputOracleFacet.failedGates ?? [])
    .map((gate) => gate?.code ?? gate);
  for (const expectedGate of expectedOutputOracleFailedGates) {
    assert.ok(outputOracleFailedGateCodes.includes(expectedGate));
  }
  assert.equal(row.outputOracleResolutionGate.accepted, true);
  assert.equal(row.realRocmRuntimeChain.accepted, false);
  assert.ok(row.reasons.includes(expectedReason));
  assert.ok(row.openGaps.includes('real_rocm_runtime_chain_required'));
  return row;
}

await writeForgedRuntimeChainCase({
  slug: 'missing-dispatch-session',
  expectedReason: 'real_rocm_runtime_chain_session_missing',
  mutateRecord(record) {
    if (record.dispatchEvent) delete record.dispatchEvent.runtime_session_id;
    if (record.dispatch_event) delete record.dispatch_event.runtime_session_id;
  },
});
await writeForgedRuntimeChainCase({
  slug: 'missing-transport-hash',
  expectedReason: 'real_rocm_runtime_chain_transport_hash_missing',
  mutateRecord(record) {
    if (record.loaderEvent?.artifact_transport) {
      delete record.loaderEvent.artifact_transport.artifact_hash;
      delete record.loaderEvent.artifact_transport.blob_digest;
    }
    if (record.loader_event?.artifact_transport) {
      delete record.loader_event.artifact_transport.artifact_hash;
      delete record.loader_event.artifact_transport.blob_digest;
    }
  },
});
await writeForgedRuntimeChainCase({
  slug: 'missing-output-target',
  expectedReason: 'real_rocm_runtime_chain_output_target_missing',
  expectedOutputOracleAccepted: false,
  expectedOutputOracleFailedGates: [
    'output_oracle_binding_oracle_target_missing',
    'output_oracle_binding_target_mismatch',
  ],
  mutateRecord(record) {
    if (record.outputEvent) delete record.outputEvent.output_target_id;
    if (record.output_event) delete record.output_event.output_target_id;
  },
});

const completeAdapterBoundaryBridgeRocmDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-bridge-complete',
);
const completeAdapterBoundaryBridgeScope = 'adapter-boundary-bridge-complete';
const completeAdapterBoundaryRawReadback = path.join(
  completeAdapterBoundaryBridgeRocmDir,
  'readback.bin',
);
const completeAdapterBoundaryReadbackBytes = Buffer.from([4, 8, 12, 16, 20, 24, 28, 32]);
await fs.mkdir(completeAdapterBoundaryBridgeRocmDir, { recursive: true });
await fs.writeFile(completeAdapterBoundaryRawReadback, completeAdapterBoundaryReadbackBytes);
await writeJson(`${completeAdapterBoundaryRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: completeAdapterBoundaryReadbackBytes.length,
  shape: [completeAdapterBoundaryReadbackBytes.length],
});
await writeRgbaPng(`${completeAdapterBoundaryRawReadback}.card.png`, 8, 8, (x, y) => [
  completeAdapterBoundaryReadbackBytes[
    (x + y) % completeAdapterBoundaryReadbackBytes.length
  ],
  80 + x,
  140 + y,
  255,
]);
const completeAdapterBoundaryMaterials = realRocmComputeProofLedgerMaterials(
  completeAdapterBoundaryBridgeScope,
  {
    projectId: 'real-rocm-adapter-boundary-bridge-complete',
    rawReadbackPath: completeAdapterBoundaryRawReadback,
    rawReadbackBytes: completeAdapterBoundaryReadbackBytes,
  },
);
const completeAdapterBoundaryAppHook =
  acceptedRealRocmAppHookContract(completeAdapterBoundaryBridgeScope);
const completeAdapterBoundaryAppHookMaterialization =
  acceptedRealRocmAppHookMaterialization(completeAdapterBoundaryBridgeScope);
const completeAdapterBoundarySameProcessOracle =
  acceptedSameProcessRuntimeOracle(completeAdapterBoundaryBridgeScope);
const completeAdapterBoundaryStageObligations =
  acceptedRealRocmRuntimeStageObligations(completeAdapterBoundaryBridgeScope);
const completeAdapterBoundarySidecar =
  acceptedRealRocmDeviceSidecarContract(completeAdapterBoundaryBridgeScope, { required: true });
const completeAdapterBoundarySidecarConsistency =
  acceptedRealRocmSidecarRuntimeConsistency(completeAdapterBoundaryBridgeScope);
const completeAdapterBoundaryRuntimeAdapterResult =
  runtimeAdapterBoundaryBridgeFixture(
    completeAdapterBoundaryBridgeScope,
    completeAdapterBoundaryMaterials,
  );
const completeAdapterBoundaryRuntimeAdapterExecution =
  runtimeAdapterExecutionFixture(
    completeAdapterBoundaryBridgeScope,
    completeAdapterBoundaryMaterials,
  );
const completeAdapterBoundarySynthiLaunchLines =
  completeAdapterBoundaryRuntimeAdapterResult.adapterRuntimeBoundaryLines.map((line) =>
    line.replace(
      '[gpu-runtime-boundary] native_runtime_dispatch dispatch=ok proof_bridge=complete attachment_provenance=native_runtime_bridge',
      '[gpu-runtime-boundary] synthi_gpu_launch dispatch=ok proof_bridge=complete attachment_provenance=synthi_runtime_adapter',
    )
  );
completeAdapterBoundaryRuntimeAdapterResult.adapterRuntimeBoundaryLines =
  completeAdapterBoundarySynthiLaunchLines;
completeAdapterBoundaryRuntimeAdapterResult.adapter_runtime_boundary_lines =
  completeAdapterBoundarySynthiLaunchLines;
completeAdapterBoundaryRuntimeAdapterResult.evidenceRefs = [
  completeAdapterBoundaryRuntimeAdapterResult.adapterResultHash,
  ...completeAdapterBoundarySynthiLaunchLines.map((line) => `adapter-boundary:${hashValue(line)}`),
];
completeAdapterBoundaryRuntimeAdapterResult.evidence_refs =
  completeAdapterBoundaryRuntimeAdapterResult.evidenceRefs;
const completeAdapterBoundaryExecutionSynthiLaunchLines =
  completeAdapterBoundaryRuntimeAdapterExecution.runtimeBoundaryLines.map((line) =>
    line.replace(
      '[gpu-runtime-boundary] native_runtime_dispatch dispatch=ok proof_bridge=complete attachment_provenance=native_runtime_bridge',
      '[gpu-runtime-boundary] synthi_gpu_launch dispatch=ok proof_bridge=complete attachment_provenance=synthi_runtime_adapter',
    )
  );
completeAdapterBoundaryRuntimeAdapterExecution.runtimeBoundaryLines =
  completeAdapterBoundaryExecutionSynthiLaunchLines;
completeAdapterBoundaryRuntimeAdapterExecution.runtime_boundary_lines =
  completeAdapterBoundaryExecutionSynthiLaunchLines;
completeAdapterBoundaryRuntimeAdapterExecution.runtimeBoundaryLineCount =
  completeAdapterBoundaryExecutionSynthiLaunchLines.length;
completeAdapterBoundaryRuntimeAdapterExecution.runtime_boundary_line_count =
  completeAdapterBoundaryExecutionSynthiLaunchLines.length;
completeAdapterBoundaryRuntimeAdapterExecution.evidenceRefs = [
  `runtime-adapter-execution:${completeAdapterBoundaryBridgeScope}`,
  `runtime-adapter-template:runtime_boundary_log_harvest_v1`,
  `runtime-adapter-command:${completeAdapterBoundaryRuntimeAdapterExecution.adapterCommandHash}`,
  ...completeAdapterBoundaryExecutionSynthiLaunchLines.map((line) =>
    `runtime-adapter-boundary:${hashValue(line)}`
  ),
];
completeAdapterBoundaryRuntimeAdapterExecution.evidence_refs =
  completeAdapterBoundaryRuntimeAdapterExecution.evidenceRefs;
const completeAdapterBoundaryRuntimeAdapterStageEvents =
  runtimeAdapterStageEventsFixture(completeAdapterBoundaryExecutionSynthiLaunchLines);
const completeAdapterBoundaryRuntimeAdapterResultTransport =
  runtimeAdapterResultTransportFixture(completeAdapterBoundaryBridgeScope);
const completeAdapterBoundaryRuntimeBoundaryTargetEnvironment =
  runtimeBoundaryTargetEnvironmentFixture(completeAdapterBoundaryBridgeScope);
const completeAdapterBoundaryRuntimeBoundaryTargetProcessProvenance =
  runtimeBoundaryTargetProcessProvenanceFixture(
    completeAdapterBoundaryBridgeScope,
    completeAdapterBoundaryExecutionSynthiLaunchLines,
    completeAdapterBoundaryRuntimeBoundaryTargetEnvironment,
  );
const completeAdapterBoundaryReport = {
  slug: 'gpu-real-rocm-adapter-boundary-bridge-complete-20260629',
  real_rocm_profile: largeRocmMlProfile('real-rocm-adapter-boundary-bridge-complete'),
  source_url: 'https://example.invalid/rocm/adapter-boundary-bridge-complete.git',
  repo_commit: 'abababababababababababababababababababab',
  entry_file: 'src/kernels/generic_adapter_entry.hip',
  delta_file: 'src/kernels/generic_adapter_delta.h',
  target_name: 'CompleteAdapterBoundaryBridgeDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'CompleteAdapterBoundaryBridgeDriver',
    finalAcceptanceTarget: 'CompleteAdapterBoundaryBridgeDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_ledger: {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
    provided: true,
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        resultState: 'gpu-hmr-output-oracle-proven',
        outputOracleProven: true,
        proofId: 'adapter-boundary-complete-small:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
        compute_oracle_artifacts: completeAdapterBoundaryMaterials.computeOracleArtifacts,
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'adapter-boundary-complete-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'adapter-boundary-complete-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
        originalHostPathProven: true,
        attachmentProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_profile_proof_obligations:
    acceptedLargeRocmProfileObligations('real-rocm-adapter-boundary-bridge-complete'),
  real_rocm_source_delta_execution:
    acceptedLargeRocmSourceDeltaExecution('real-rocm-adapter-boundary-bridge-complete'),
  real_rocm_external_header_prerequisites:
    realRocmExternalHeaderPrerequisitesFixture(completeAdapterBoundaryBridgeScope),
  realRocmExternalHeaderPrerequisites:
    realRocmExternalHeaderPrerequisitesFixture(completeAdapterBoundaryBridgeScope),
  real_rocm_app_hook_contract: completeAdapterBoundaryAppHook,
  real_rocm_app_hook_materialization: completeAdapterBoundaryAppHookMaterialization,
  real_rocm_same_process_runtime_oracle: completeAdapterBoundarySameProcessOracle,
  real_rocm_runtime_stage_obligations: completeAdapterBoundaryStageObligations,
  real_rocm_device_sidecar_contract: completeAdapterBoundarySidecar,
  real_rocm_sidecar_runtime_consistency: completeAdapterBoundarySidecarConsistency,
  real_rocm_runtime_profile_adapter_result: completeAdapterBoundaryRuntimeAdapterResult,
  real_rocm_runtime_adapter_execution: completeAdapterBoundaryRuntimeAdapterExecution,
  real_rocm_runtime_adapter_stage_events: completeAdapterBoundaryRuntimeAdapterStageEvents,
  real_rocm_runtime_adapter_result_transport:
    completeAdapterBoundaryRuntimeAdapterResultTransport,
  real_rocm_runtime_boundary_target_environment:
    completeAdapterBoundaryRuntimeBoundaryTargetEnvironment,
  real_rocm_runtime_boundary_target_process_provenance:
    completeAdapterBoundaryRuntimeBoundaryTargetProcessProvenance,
  ...completeAdapterBoundaryMaterials,
  runtime_proof_artifact: {
    ...completeAdapterBoundaryMaterials.runtime_proof_artifact,
    realRocmProfileProofObligations:
      acceptedLargeRocmProfileObligations('real-rocm-adapter-boundary-bridge-complete'),
    real_rocm_profile_proof_obligations:
      acceptedLargeRocmProfileObligations('real-rocm-adapter-boundary-bridge-complete'),
    realRocmSourceDeltaExecution:
      acceptedLargeRocmSourceDeltaExecution('real-rocm-adapter-boundary-bridge-complete'),
    real_rocm_source_delta_execution:
      acceptedLargeRocmSourceDeltaExecution('real-rocm-adapter-boundary-bridge-complete'),
    realRocmExternalHeaderPrerequisites:
      realRocmExternalHeaderPrerequisitesFixture(completeAdapterBoundaryBridgeScope),
    real_rocm_external_header_prerequisites:
      realRocmExternalHeaderPrerequisitesFixture(completeAdapterBoundaryBridgeScope),
    realRocmAppHookContract: completeAdapterBoundaryAppHook,
    real_rocm_app_hook_contract: completeAdapterBoundaryAppHook,
    realRocmAppHookMaterialization: completeAdapterBoundaryAppHookMaterialization,
    real_rocm_app_hook_materialization: completeAdapterBoundaryAppHookMaterialization,
    realRocmSameProcessRuntimeOracle: completeAdapterBoundarySameProcessOracle,
    real_rocm_same_process_runtime_oracle: completeAdapterBoundarySameProcessOracle,
    sameProcessRuntimeOracle: completeAdapterBoundarySameProcessOracle,
    same_process_runtime_oracle: completeAdapterBoundarySameProcessOracle,
    realRocmRuntimeStageObligations: completeAdapterBoundaryStageObligations,
    real_rocm_runtime_stage_obligations: completeAdapterBoundaryStageObligations,
    realRocmDeviceSidecarContract: completeAdapterBoundarySidecar,
    real_rocm_device_sidecar_contract: completeAdapterBoundarySidecar,
    realRocmSidecarRuntimeConsistency: completeAdapterBoundarySidecarConsistency,
    real_rocm_sidecar_runtime_consistency: completeAdapterBoundarySidecarConsistency,
    realRocmRuntimeProfileAdapterResult: completeAdapterBoundaryRuntimeAdapterResult,
    real_rocm_runtime_profile_adapter_result: completeAdapterBoundaryRuntimeAdapterResult,
    realRocmRuntimeAdapterExecution: completeAdapterBoundaryRuntimeAdapterExecution,
    real_rocm_runtime_adapter_execution: completeAdapterBoundaryRuntimeAdapterExecution,
    realRocmRuntimeAdapterStageEvents: completeAdapterBoundaryRuntimeAdapterStageEvents,
    real_rocm_runtime_adapter_stage_events: completeAdapterBoundaryRuntimeAdapterStageEvents,
    realRocmRuntimeAdapterResultTransport:
      completeAdapterBoundaryRuntimeAdapterResultTransport,
    real_rocm_runtime_adapter_result_transport:
      completeAdapterBoundaryRuntimeAdapterResultTransport,
    realRocmRuntimeBoundaryTargetEnvironment:
      completeAdapterBoundaryRuntimeBoundaryTargetEnvironment,
    real_rocm_runtime_boundary_target_environment:
      completeAdapterBoundaryRuntimeBoundaryTargetEnvironment,
    realRocmRuntimeBoundaryTargetProcessProvenance:
      completeAdapterBoundaryRuntimeBoundaryTargetProcessProvenance,
    real_rocm_runtime_boundary_target_process_provenance:
      completeAdapterBoundaryRuntimeBoundaryTargetProcessProvenance,
  },
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-adapter-boundary-bridge-complete-delta',
    editHash: hashValue('real-rocm-adapter-boundary-bridge-complete-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/adapter-boundary-bridge-complete.git @ abababab files=32000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
};
await writeJson(
  path.join(completeAdapterBoundaryBridgeRocmDir, 'real-rocm-adapter-boundary-bridge-complete.json'),
  completeAdapterBoundaryReport,
);
const completeAdapterBoundaryBridgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [completeAdapterBoundaryBridgeRocmDir],
  generatedAt: '2026-06-29T00:00:02.264Z',
  includeUnproven: true,
});
const completeAdapterBoundaryBridgeRow = completeAdapterBoundaryBridgeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(completeAdapterBoundaryBridgeRow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(completeAdapterBoundaryBridgeRow.acceptedForGpuHmr, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult.accepted, true);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult.acceptedForGpuHmr,
  false,
);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult.gpuHmrSuccess, false);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.acceptedAsDiagnosticEvidence,
  true,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.hostIdentityProofShaped,
  true,
);
assert.deepEqual(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.missingEventKinds,
  [],
);
assert.ok(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult
    .adapterRuntimeBoundaryLineHashes.includes(
      hashValue(completeAdapterBoundaryRuntimeAdapterResult.adapterRuntimeBoundaryLines[0]),
    ),
);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.accepted, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.acceptedForGpuHmr, false);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.gpuHmrSuccess, false);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.acceptedAsDiagnosticEvidence,
  true,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.hostIdentityProofShaped,
  true,
);
assert.deepEqual(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.missingEventKinds,
  [],
);
assert.ok(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution
    .runtimeBoundaryEvidenceRefs.includes(
      `runtime-adapter-boundary:${hashValue(
        completeAdapterBoundaryRuntimeAdapterExecution.runtimeBoundaryLines[0],
      )}`,
    ),
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.adapterTemplate,
  'runtime_boundary_log_harvest_v1',
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.adapterCommandHash,
  hashValue(`runtime-adapter-command:${completeAdapterBoundaryBridgeScope}`),
);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents.accepted, true);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents.acceptedAsSupportEvidence,
  true,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents.acceptedForGpuHmr,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents.gpuHmrSuccess,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents.canSatisfyRuntimeProof,
  false,
);
assert.deepEqual(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents.missingStages,
  [],
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents
    .stageResults.output_oracle.fieldChecks.readback_or_visual_artifact,
  true,
);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.accepted, true);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.acceptedForGpuHmr,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.gpuHmrSuccess,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.canSatisfyRuntimeProof,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.adapterTemplate,
  'runtime_boundary_log_harvest_v1',
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.adapterCommandHash,
  hashValue(`runtime-adapter-command:${completeAdapterBoundaryBridgeScope}`),
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetEnvironment.accepted,
  true,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetEnvironment
    .acceptedAsSupportEvidence,
  true,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetEnvironment.acceptedForGpuHmr,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetEnvironment.gpuHmrSuccess,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetEnvironment
    .canSatisfyRuntimeProof,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetEnvironment
    .canSatisfyDispatchProof,
  false,
);
assert.ok(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetEnvironment
    .exportedVariableNames.includes('SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH'),
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetProcessProvenance.accepted,
  true,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .acceptedAsSupportEvidence,
  true,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .acceptedForGpuHmr,
  false,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .gpuHmrSuccess,
  false,
);
assert.deepEqual(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .runtimeSessions,
  [`runtime-session:${completeAdapterBoundaryBridgeScope}`],
);
assert.deepEqual(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetProcessProvenance.processIds,
  ['pid:4242'],
);
assert.deepEqual(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .coverage.missingEventKinds,
  [],
);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmAppHookContractGate.accepted, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmAppHookMaterializationGate.accepted, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracleGate.accepted, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeStageObligations.accepted, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeChain.accepted, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeChain.adapterBoundaryOverlayAccepted, true);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmRuntimeChain.adapterBoundaryOverlayLineCount, 20);
assert.deepEqual(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeChain.adapterBoundaryOverlaySources,
  ['runtime_profile_adapter_result', 'runtime_adapter_execution'],
);
assert.equal(completeAdapterBoundaryBridgeRow.outputOracleFacet.kind, 'compute_oracle');
assert.equal(completeAdapterBoundaryBridgeRow.outputOracleFacet.accepted, true);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmDeviceSidecarContract.canSatisfyRuntimeProof,
  true,
);
assert.deepEqual(completeAdapterBoundaryBridgeRow.realRocmDeviceSidecarContract.blockingGaps, []);
assert.equal(completeAdapterBoundaryBridgeRow.realRocmSidecarRuntimeConsistency.accepted, true);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeChain.dispatchId,
  `dispatch:${completeAdapterBoundaryBridgeScope}`,
);
assert.equal(
  completeAdapterBoundaryBridgeRow.realRocmRuntimeChain.outputTargetId,
  `output-target:${completeAdapterBoundaryBridgeScope}`,
);

const derivedAdapterBoundaryBridgeDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-derived-app-hook',
);
await fs.mkdir(derivedAdapterBoundaryBridgeDir, { recursive: true });
const derivedAdapterBoundaryBridgeReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
derivedAdapterBoundaryBridgeReport.slug =
  'gpu-real-rocm-adapter-boundary-derived-app-hook-20260630';
delete derivedAdapterBoundaryBridgeReport.real_rocm_app_hook_contract;
delete derivedAdapterBoundaryBridgeReport.realRocmAppHookContract;
delete derivedAdapterBoundaryBridgeReport.app_hook_contract;
delete derivedAdapterBoundaryBridgeReport.appHookContract;
delete derivedAdapterBoundaryBridgeReport.runtime_proof_artifact.realRocmAppHookContract;
delete derivedAdapterBoundaryBridgeReport.runtime_proof_artifact.real_rocm_app_hook_contract;
delete derivedAdapterBoundaryBridgeReport.runtime_proof_artifact.appHookContract;
delete derivedAdapterBoundaryBridgeReport.runtime_proof_artifact.app_hook_contract;
await writeJson(
  path.join(
    derivedAdapterBoundaryBridgeDir,
    'real-rocm-adapter-boundary-derived-app-hook.json',
  ),
  derivedAdapterBoundaryBridgeReport,
);
const derivedAdapterBoundaryBridgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [derivedAdapterBoundaryBridgeDir],
  generatedAt: '2026-06-30T00:00:02.264Z',
  includeUnproven: true,
});
const derivedAdapterBoundaryBridgeRow = derivedAdapterBoundaryBridgeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(derivedAdapterBoundaryBridgeRow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(derivedAdapterBoundaryBridgeRow.acceptedForGpuHmr, true);
assert.equal(derivedAdapterBoundaryBridgeRow.realRocmAppHookContractGate.accepted, true);
assert.equal(derivedAdapterBoundaryBridgeRow.realRocmAppHookContractGate.proven, true);
assert.equal(
  derivedAdapterBoundaryBridgeRow.realRocmAppHookContract.contractSource,
  'runtime_adapter_stage_events',
);
assert.equal(
  derivedAdapterBoundaryBridgeRow.realRocmAppHookContract.derivedFromRuntimeAdapterStageEvents,
  true,
);
assert.equal(
  derivedAdapterBoundaryBridgeRow.realRocmAppHookContract.sourceFacetHash,
  derivedAdapterBoundaryBridgeRow.realRocmRuntimeAdapterStageEvents.facetHash,
);
assert.equal(
  derivedAdapterBoundaryBridgeRow.realRocmAppHookContractGate
    .derivedFromRuntimeAdapterStageEvents,
  true,
);
assert.deepEqual(
  derivedAdapterBoundaryBridgeRow.realRocmAppHookContractGate.derivedSourceFailedGaps,
  [],
);
assert.equal(derivedAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracleGate.accepted, true);
assert.equal(derivedAdapterBoundaryBridgeRow.realRocmRuntimeChain.accepted, true);

const derivedSameProcessAdapterBoundaryBridgeDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-derived-same-process',
);
await fs.mkdir(derivedSameProcessAdapterBoundaryBridgeDir, { recursive: true });
const derivedSameProcessAdapterBoundaryBridgeReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
derivedSameProcessAdapterBoundaryBridgeReport.slug =
  'gpu-real-rocm-adapter-boundary-derived-same-process-20260630';
delete derivedSameProcessAdapterBoundaryBridgeReport.real_rocm_same_process_runtime_oracle;
delete derivedSameProcessAdapterBoundaryBridgeReport.realRocmSameProcessRuntimeOracle;
delete derivedSameProcessAdapterBoundaryBridgeReport.same_process_runtime_oracle;
delete derivedSameProcessAdapterBoundaryBridgeReport.sameProcessRuntimeOracle;
delete derivedSameProcessAdapterBoundaryBridgeReport.runtime_proof_artifact
  .realRocmSameProcessRuntimeOracle;
delete derivedSameProcessAdapterBoundaryBridgeReport.runtime_proof_artifact
  .real_rocm_same_process_runtime_oracle;
delete derivedSameProcessAdapterBoundaryBridgeReport.runtime_proof_artifact
  .sameProcessRuntimeOracle;
delete derivedSameProcessAdapterBoundaryBridgeReport.runtime_proof_artifact
  .same_process_runtime_oracle;
await writeJson(
  path.join(
    derivedSameProcessAdapterBoundaryBridgeDir,
    'real-rocm-adapter-boundary-derived-same-process.json',
  ),
  derivedSameProcessAdapterBoundaryBridgeReport,
);
const derivedSameProcessAdapterBoundaryBridgeLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [derivedSameProcessAdapterBoundaryBridgeDir],
    generatedAt: '2026-06-30T00:00:03.264Z',
    includeUnproven: true,
  });
const derivedSameProcessAdapterBoundaryBridgeRow =
  derivedSameProcessAdapterBoundaryBridgeLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(
  derivedSameProcessAdapterBoundaryBridgeRow?.matrixOutcome,
  'full_runtime_gpu_hmr',
);
assert.equal(derivedSameProcessAdapterBoundaryBridgeRow.acceptedForGpuHmr, true);
assert.equal(
  derivedSameProcessAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracleGate.accepted,
  true,
);
assert.equal(
  derivedSameProcessAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracle.contractSource,
  'matrix_runtime_chain_derivation',
);
assert.equal(
  derivedSameProcessAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracle
    .derivedFromRuntimeChain,
  true,
);
assert.equal(
  derivedSameProcessAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracleGate
    .proofClosureChecks.runtimeChainAccepted,
  true,
);
assert.equal(
  derivedSameProcessAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracleGate
    .proofClosureChecks.outputOracleFacetAccepted,
  true,
);
assert.equal(
  derivedSameProcessAdapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracleGate
    .proofClosureChecks.firewallEvidenceAccepted,
  true,
);
assert.equal(derivedSameProcessAdapterBoundaryBridgeRow.realRocmRuntimeChain.accepted, true);
assert.equal(derivedSameProcessAdapterBoundaryBridgeRow.outputOracleFacet.accepted, true);

const forgedDerivedSameProcessOutputTargetDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-forged-derived-same-process-output-target',
);
await fs.mkdir(forgedDerivedSameProcessOutputTargetDir, { recursive: true });
const forgedDerivedSameProcessOutputTargetReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
forgedDerivedSameProcessOutputTargetReport.slug =
  'gpu-real-rocm-adapter-boundary-forged-derived-same-process-output-target-20260630';
delete forgedDerivedSameProcessOutputTargetReport.real_rocm_same_process_runtime_oracle;
delete forgedDerivedSameProcessOutputTargetReport.realRocmSameProcessRuntimeOracle;
delete forgedDerivedSameProcessOutputTargetReport.same_process_runtime_oracle;
delete forgedDerivedSameProcessOutputTargetReport.sameProcessRuntimeOracle;
delete forgedDerivedSameProcessOutputTargetReport.runtime_proof_artifact
  .realRocmSameProcessRuntimeOracle;
delete forgedDerivedSameProcessOutputTargetReport.runtime_proof_artifact
  .real_rocm_same_process_runtime_oracle;
delete forgedDerivedSameProcessOutputTargetReport.runtime_proof_artifact
  .sameProcessRuntimeOracle;
delete forgedDerivedSameProcessOutputTargetReport.runtime_proof_artifact
  .same_process_runtime_oracle;
for (const ledgerLike of [
  forgedDerivedSameProcessOutputTargetReport.proofLedger,
  forgedDerivedSameProcessOutputTargetReport.proof_ledger,
  forgedDerivedSameProcessOutputTargetReport.runtime_proof_artifact?.proofLedger,
  forgedDerivedSameProcessOutputTargetReport.runtime_proof_artifact?.proof_ledger,
]) {
  const record = ledgerLike?.records?.[0];
  if (!record) continue;
  if (record.outputEvent) record.outputEvent.output_target_id = 'output-target:forged-derived-mismatch';
  if (record.outputEvent) record.outputEvent.outputTargetId = 'output-target:forged-derived-mismatch';
  if (record.output_event) record.output_event.output_target_id = 'output-target:forged-derived-mismatch';
  if (record.output_event) record.output_event.outputTargetId = 'output-target:forged-derived-mismatch';
}
await writeJson(
  path.join(
    forgedDerivedSameProcessOutputTargetDir,
    'real-rocm-adapter-boundary-forged-derived-same-process-output-target.json',
  ),
  forgedDerivedSameProcessOutputTargetReport,
);
const forgedDerivedSameProcessOutputTargetLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [forgedDerivedSameProcessOutputTargetDir],
    generatedAt: '2026-06-30T00:00:04.264Z',
    includeUnproven: true,
  });
const forgedDerivedSameProcessOutputTargetRow =
  forgedDerivedSameProcessOutputTargetLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(forgedDerivedSameProcessOutputTargetRow?.matrixOutcome, 'unproven');
assert.equal(forgedDerivedSameProcessOutputTargetRow.acceptedForGpuHmr, false);
assert.equal(
  forgedDerivedSameProcessOutputTargetRow.realRocmSameProcessRuntimeOracleGate.accepted,
  false,
);
assert.ok(
  forgedDerivedSameProcessOutputTargetRow.openGaps.includes(
    'real_rocm_same_process_runtime_oracle:same_process_runtime_oracle_output_target_mismatch',
  ),
);
assert.ok(
  forgedDerivedSameProcessOutputTargetRow.openGaps.some((gap) =>
    gap.includes('output_target_mismatch')
    && gap.startsWith('real_rocm_runtime_chain')
  ),
);

const forgedDerivedAdapterBoundaryBridgeDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-forged-derived-app-hook',
);
await fs.mkdir(forgedDerivedAdapterBoundaryBridgeDir, { recursive: true });
const forgedDerivedAdapterBoundaryBridgeReport =
  JSON.parse(JSON.stringify(derivedAdapterBoundaryBridgeReport));
const forgedDerivedAppHookContract =
  JSON.parse(JSON.stringify(derivedAdapterBoundaryBridgeRow.realRocmAppHookContract));
forgedDerivedAdapterBoundaryBridgeReport.slug =
  'gpu-real-rocm-adapter-boundary-forged-derived-app-hook-20260630';
forgedDerivedAdapterBoundaryBridgeReport.real_rocm_app_hook_contract =
  forgedDerivedAppHookContract;
forgedDerivedAdapterBoundaryBridgeReport.runtime_proof_artifact.realRocmAppHookContract =
  forgedDerivedAppHookContract;
forgedDerivedAdapterBoundaryBridgeReport.runtime_proof_artifact.real_rocm_app_hook_contract =
  forgedDerivedAppHookContract;
delete forgedDerivedAdapterBoundaryBridgeReport.real_rocm_runtime_adapter_stage_events;
delete forgedDerivedAdapterBoundaryBridgeReport.realRocmRuntimeAdapterStageEvents;
delete forgedDerivedAdapterBoundaryBridgeReport.runtime_adapter_stage_events;
delete forgedDerivedAdapterBoundaryBridgeReport.runtimeAdapterStageEvents;
delete forgedDerivedAdapterBoundaryBridgeReport.runtime_proof_artifact
  .realRocmRuntimeAdapterStageEvents;
delete forgedDerivedAdapterBoundaryBridgeReport.runtime_proof_artifact
  .real_rocm_runtime_adapter_stage_events;
delete forgedDerivedAdapterBoundaryBridgeReport.runtime_proof_artifact
  .runtimeAdapterStageEvents;
delete forgedDerivedAdapterBoundaryBridgeReport.runtime_proof_artifact
  .runtime_adapter_stage_events;
await writeJson(
  path.join(
    forgedDerivedAdapterBoundaryBridgeDir,
    'real-rocm-adapter-boundary-forged-derived-app-hook.json',
  ),
  forgedDerivedAdapterBoundaryBridgeReport,
);
const forgedDerivedAdapterBoundaryBridgeLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [forgedDerivedAdapterBoundaryBridgeDir],
    generatedAt: '2026-06-30T00:00:02.265Z',
    includeUnproven: true,
  });
const forgedDerivedAdapterBoundaryBridgeRow =
  forgedDerivedAdapterBoundaryBridgeLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(forgedDerivedAdapterBoundaryBridgeRow?.matrixOutcome, 'unproven');
assert.equal(forgedDerivedAdapterBoundaryBridgeRow.acceptedForGpuHmr, false);
assert.equal(forgedDerivedAdapterBoundaryBridgeRow.realRocmAppHookContractGate.required, true);
assert.equal(forgedDerivedAdapterBoundaryBridgeRow.realRocmAppHookContractGate.proven, false);
assert.ok(
  forgedDerivedAdapterBoundaryBridgeRow.realRocmAppHookContractGate
    .derivedSourceFailedGaps.includes(
      'real_rocm_app_hook_contract_derived_stage_events_missing',
    ),
);
assert.ok(
  forgedDerivedAdapterBoundaryBridgeRow.reasons.includes(
    'real_rocm_app_hook_contract_derived_stage_events_missing',
  ),
);

const adapterBoundaryOnlyBridgeDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-only-bridge-complete',
);
await fs.mkdir(adapterBoundaryOnlyBridgeDir, { recursive: true });
const adapterBoundaryOnlyBridgeReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterBoundaryOnlyBridgeFacet = {
  ...adapterBoundaryOnlyBridgeReport.real_rocm_runtime_profile_adapter_result,
  status: 'runtime_profile_adapter_result_refusal_evidence',
  strictRuntimeProofAccepted: false,
  strict_runtime_proof_accepted: false,
  strictRuntimeProofArtifactPresent: false,
  strict_runtime_proof_artifact_present: false,
  proofLedgerPresent: false,
  proof_ledger_present: false,
  strictRuntimeProofId: null,
  strict_runtime_proof_id: null,
  proofLedgerId: null,
  proof_ledger_id: null,
  adapterResultHash: null,
  adapter_result_hash: null,
  resultHash: null,
  result_hash: null,
  acceptedAsBoundaryEvidence: true,
  accepted_as_boundary_evidence: true,
  blockingGaps: ['runtime_profile_adapter_strict_runtime_proof_not_accepted'],
  blocking_gaps: ['runtime_profile_adapter_strict_runtime_proof_not_accepted'],
  boundaryImportBlockingGaps: [],
  boundary_import_blocking_gaps: [],
  failedGates: [
    'real_rocm_runtime_profile_adapter_result_imported_without_strict_proof',
    'real_rocm_runtime_profile_adapter_result_imported_without_runtime_artifact',
    'real_rocm_runtime_profile_adapter_result_imported_without_proof_ledger',
    'real_rocm_runtime_profile_adapter_result_strict_proof_id_missing',
    'real_rocm_runtime_profile_adapter_result_proof_ledger_id_missing',
    'real_rocm_runtime_profile_adapter_result_hash_missing',
  ],
  failed_gates: [
    'real_rocm_runtime_profile_adapter_result_imported_without_strict_proof',
    'real_rocm_runtime_profile_adapter_result_imported_without_runtime_artifact',
    'real_rocm_runtime_profile_adapter_result_imported_without_proof_ledger',
    'real_rocm_runtime_profile_adapter_result_strict_proof_id_missing',
    'real_rocm_runtime_profile_adapter_result_proof_ledger_id_missing',
    'real_rocm_runtime_profile_adapter_result_hash_missing',
  ],
};
adapterBoundaryOnlyBridgeReport.slug =
  'gpu-real-rocm-adapter-boundary-only-bridge-complete-20260630';
adapterBoundaryOnlyBridgeReport.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryOnlyBridgeFacet;
adapterBoundaryOnlyBridgeReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterBoundaryOnlyBridgeFacet;
adapterBoundaryOnlyBridgeReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryOnlyBridgeFacet;
await writeJson(
  path.join(
    adapterBoundaryOnlyBridgeDir,
    'real-rocm-adapter-boundary-only-bridge-complete.json',
  ),
  adapterBoundaryOnlyBridgeReport,
);
const adapterBoundaryOnlyBridgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryOnlyBridgeDir],
  generatedAt: '2026-06-30T00:00:02.264Z',
  includeUnproven: true,
});
const adapterBoundaryOnlyBridgeRow = adapterBoundaryOnlyBridgeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(adapterBoundaryOnlyBridgeRow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(adapterBoundaryOnlyBridgeRow.acceptedForGpuHmr, true);
assert.equal(adapterBoundaryOnlyBridgeRow.realRocmRuntimeProfileAdapterResult.accepted, false);
assert.equal(
  adapterBoundaryOnlyBridgeRow.realRocmRuntimeProfileAdapterResult.acceptedAsBoundaryEvidence,
  true,
);
assert.deepEqual(
  adapterBoundaryOnlyBridgeRow.realRocmRuntimeProfileAdapterResult.boundaryImportBlockingGaps,
  [],
);
assert.ok(
  adapterBoundaryOnlyBridgeRow.realRocmRuntimeProfileAdapterResult.blockingGaps.includes(
    'runtime_profile_adapter_strict_runtime_proof_not_accepted',
  ),
);
assert.equal(
  adapterBoundaryOnlyBridgeRow.realRocmRuntimeProfileAdapterResult.acceptedForGpuHmr,
  false,
);
assert.equal(adapterBoundaryOnlyBridgeRow.realRocmRuntimeProfileAdapterResult.gpuHmrSuccess, false);
assert.equal(adapterBoundaryOnlyBridgeRow.runtimeProofArtifact.accepted, true);
assert.equal(adapterBoundaryOnlyBridgeRow.ledger.gpuHmrSuccess, true);
assert.equal(adapterBoundaryOnlyBridgeRow.realRocmRuntimeChain.accepted, true);
assert.equal(
  adapterBoundaryOnlyBridgeRow.realRocmRuntimeChain.adapterBoundaryOverlayAccepted,
  true,
);
assert.ok(
  !adapterBoundaryOnlyBridgeRow.reasons.includes(
    'real_rocm_runtime_profile_adapter_result_not_accepted',
  ),
);
assert.ok(
  !adapterBoundaryOnlyBridgeRow.openGaps.includes(
    'real_rocm_runtime_profile_adapter_result_not_accepted',
  ),
);

const adapterBoundaryOnlyBridgeNoExecutionDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-only-bridge-no-execution',
);
await fs.mkdir(adapterBoundaryOnlyBridgeNoExecutionDir, { recursive: true });
const adapterBoundaryOnlyBridgeNoExecutionReport =
  JSON.parse(JSON.stringify(adapterBoundaryOnlyBridgeReport));
adapterBoundaryOnlyBridgeNoExecutionReport.slug =
  'gpu-real-rocm-adapter-boundary-only-bridge-no-execution-20260630';
delete adapterBoundaryOnlyBridgeNoExecutionReport.real_rocm_runtime_adapter_execution;
delete adapterBoundaryOnlyBridgeNoExecutionReport.realRocmRuntimeAdapterExecution;
delete adapterBoundaryOnlyBridgeNoExecutionReport.runtime_adapter_execution;
delete adapterBoundaryOnlyBridgeNoExecutionReport.runtimeAdapterExecution;
if (
  adapterBoundaryOnlyBridgeNoExecutionReport.evidence
  && typeof adapterBoundaryOnlyBridgeNoExecutionReport.evidence === 'object'
) {
  delete adapterBoundaryOnlyBridgeNoExecutionReport.evidence
    .real_rocm_runtime_adapter_execution;
}
delete adapterBoundaryOnlyBridgeNoExecutionReport.runtime_proof_artifact
  .realRocmRuntimeAdapterExecution;
delete adapterBoundaryOnlyBridgeNoExecutionReport.runtime_proof_artifact
  .real_rocm_runtime_adapter_execution;
await writeJson(
  path.join(
    adapterBoundaryOnlyBridgeNoExecutionDir,
    'real-rocm-adapter-boundary-only-bridge-no-execution.json',
  ),
  adapterBoundaryOnlyBridgeNoExecutionReport,
);
const adapterBoundaryOnlyBridgeNoExecutionLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryOnlyBridgeNoExecutionDir],
  generatedAt: '2026-06-30T00:00:02.265Z',
  includeUnproven: true,
});
const adapterBoundaryOnlyBridgeNoExecutionRow =
  adapterBoundaryOnlyBridgeNoExecutionLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(adapterBoundaryOnlyBridgeNoExecutionRow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(adapterBoundaryOnlyBridgeNoExecutionRow.acceptedForGpuHmr, true);
assert.equal(
  adapterBoundaryOnlyBridgeNoExecutionRow.realRocmRuntimeProfileAdapterResult
    .acceptedAsBoundaryEvidence,
  true,
);
assert.equal(
  adapterBoundaryOnlyBridgeNoExecutionRow.realRocmRuntimeProfileAdapterResult.acceptedForGpuHmr,
  false,
);
assert.equal(
  adapterBoundaryOnlyBridgeNoExecutionRow.realRocmRuntimeProfileAdapterResult.gpuHmrSuccess,
  false,
);
assert.equal(adapterBoundaryOnlyBridgeNoExecutionRow.realRocmRuntimeChain.accepted, true);
assert.deepEqual(
  adapterBoundaryOnlyBridgeNoExecutionRow.realRocmRuntimeChain.adapterBoundaryOverlaySources,
  ['runtime_profile_adapter_result'],
);
assert.equal(
  adapterBoundaryOnlyBridgeNoExecutionRow.realRocmRuntimeChain.adapterBoundaryOverlayAccepted,
  true,
);
assert.ok(
  !adapterBoundaryOnlyBridgeNoExecutionRow.reasons.includes(
    'real_rocm_runtime_adapter_execution_not_accepted',
  ),
);
assert.ok(
  !adapterBoundaryOnlyBridgeNoExecutionRow.openGaps.includes(
    'real_rocm_runtime_adapter_execution_not_accepted',
  ),
);

const adapterBoundaryEventManifestOnlyDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-event-manifest-only',
);
await fs.mkdir(adapterBoundaryEventManifestOnlyDir, { recursive: true });
const adapterBoundaryEventManifestOnlyReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterBoundaryEventManifestOnlyLines =
  adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_profile_adapter_result
    .adapterRuntimeBoundaryLines;
const adapterBoundaryEventManifestOnlyFacet = {
  ...adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_profile_adapter_result,
  status: 'runtime_profile_adapter_result_refusal_evidence',
  present: true,
  resultPresent: false,
  result_present: false,
  eventManifestPresent: true,
  event_manifest_present: true,
  strictRuntimeProofAccepted: false,
  strict_runtime_proof_accepted: false,
  strictRuntimeProofArtifactPresent: false,
  strict_runtime_proof_artifact_present: false,
  proofLedgerPresent: false,
  proof_ledger_present: false,
  strictRuntimeProofId: null,
  strict_runtime_proof_id: null,
  proofLedgerId: null,
  proof_ledger_id: null,
  adapterResultHash: null,
  adapter_result_hash: null,
  resultHash: null,
  result_hash: null,
  adapterRuntimeBoundaryLines: [],
  adapter_runtime_boundary_lines: [],
  runtimeBoundaryLines: [],
  runtime_boundary_lines: [],
  eventManifestBoundaryLines: adapterBoundaryEventManifestOnlyLines,
  event_manifest_boundary_lines: adapterBoundaryEventManifestOnlyLines,
  acceptedAsBoundaryEvidence: true,
  accepted_as_boundary_evidence: true,
  blockingGaps: [
    'runtime_profile_adapter_result_unreadable',
    'runtime_profile_adapter_strict_runtime_proof_not_accepted',
  ],
  blocking_gaps: [
    'runtime_profile_adapter_result_unreadable',
    'runtime_profile_adapter_strict_runtime_proof_not_accepted',
  ],
  boundaryImportBlockingGaps: [],
  boundary_import_blocking_gaps: [],
  failedGates: [
    'real_rocm_runtime_profile_adapter_result_imported_without_strict_proof',
    'real_rocm_runtime_profile_adapter_result_imported_without_runtime_artifact',
    'real_rocm_runtime_profile_adapter_result_imported_without_proof_ledger',
    'real_rocm_runtime_profile_adapter_result_strict_proof_id_missing',
    'real_rocm_runtime_profile_adapter_result_proof_ledger_id_missing',
    'real_rocm_runtime_profile_adapter_result_hash_missing',
  ],
  failed_gates: [
    'real_rocm_runtime_profile_adapter_result_imported_without_strict_proof',
    'real_rocm_runtime_profile_adapter_result_imported_without_runtime_artifact',
    'real_rocm_runtime_profile_adapter_result_imported_without_proof_ledger',
    'real_rocm_runtime_profile_adapter_result_strict_proof_id_missing',
    'real_rocm_runtime_profile_adapter_result_proof_ledger_id_missing',
    'real_rocm_runtime_profile_adapter_result_hash_missing',
  ],
};
adapterBoundaryEventManifestOnlyReport.slug =
  'gpu-real-rocm-adapter-boundary-event-manifest-only-20260630';
adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryEventManifestOnlyFacet;
adapterBoundaryEventManifestOnlyReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterBoundaryEventManifestOnlyFacet;
adapterBoundaryEventManifestOnlyReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryEventManifestOnlyFacet;
delete adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_adapter_execution;
delete adapterBoundaryEventManifestOnlyReport.realRocmRuntimeAdapterExecution;
delete adapterBoundaryEventManifestOnlyReport.runtime_adapter_execution;
delete adapterBoundaryEventManifestOnlyReport.runtimeAdapterExecution;
delete adapterBoundaryEventManifestOnlyReport.runtime_proof_artifact
  .realRocmRuntimeAdapterExecution;
delete adapterBoundaryEventManifestOnlyReport.runtime_proof_artifact
  .real_rocm_runtime_adapter_execution;
adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_adapter_result_transport = {
  ...runtimeAdapterResultTransportFixture(completeAdapterBoundaryBridgeScope),
  copied: false,
  status: 'runtime_adapter_result_transport_missing',
  byteLength: 0,
  byte_length: 0,
  rawSha256: null,
  raw_sha256: null,
  blockingGaps: ['runtime_adapter_result_transport_worker_file_missing'],
  blocking_gaps: ['runtime_adapter_result_transport_worker_file_missing'],
};
adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_adapter_event_manifest_transport = {
  schemaVersion: 'synthi.real_rocm.runtime_adapter_event_manifest_transport.v1',
  schema_version: 'synthi.real_rocm.runtime_adapter_event_manifest_transport.v1',
  proofAuthority: 'runtime_adapter_event_manifest_transport_only_not_gpu_hmr_success',
  proof_authority: 'runtime_adapter_event_manifest_transport_only_not_gpu_hmr_success',
  declared: true,
  copied: true,
  status: 'runtime_adapter_event_manifest_transport_copied',
  adapterTemplate: 'runtime_boundary_log_harvest_v1',
  adapter_template: 'runtime_boundary_log_harvest_v1',
  rawSha256: hashValue('event-manifest-only-boundary-payload'),
  raw_sha256: hashValue('event-manifest-only-boundary-payload'),
  byteLength: 4096,
  byte_length: 4096,
  evidenceRefs: [hashValue('event-manifest-only-boundary-payload')],
  evidence_refs: [hashValue('event-manifest-only-boundary-payload')],
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
  canSatisfyRuntimeProof: false,
  can_satisfy_runtime_proof: false,
  canSatisfyDispatchProof: false,
  can_satisfy_dispatch_proof: false,
  blockingGaps: [],
  blocking_gaps: [],
};
adapterBoundaryEventManifestOnlyReport.runtime_proof_artifact
  .real_rocm_runtime_adapter_result_transport =
  adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_adapter_result_transport;
adapterBoundaryEventManifestOnlyReport.runtime_proof_artifact
  .realRocmRuntimeAdapterEventManifestTransport =
  adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_adapter_event_manifest_transport;
adapterBoundaryEventManifestOnlyReport.runtime_proof_artifact
  .real_rocm_runtime_adapter_event_manifest_transport =
  adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_adapter_event_manifest_transport;
await writeJson(
  path.join(
    adapterBoundaryEventManifestOnlyDir,
    'real-rocm-adapter-boundary-event-manifest-only.json',
  ),
  adapterBoundaryEventManifestOnlyReport,
);
const adapterBoundaryEventManifestOnlyLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [adapterBoundaryEventManifestOnlyDir],
    generatedAt: '2026-06-30T00:00:02.2655Z',
    includeUnproven: true,
  });
const adapterBoundaryEventManifestOnlyRow =
  adapterBoundaryEventManifestOnlyLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(adapterBoundaryEventManifestOnlyRow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(adapterBoundaryEventManifestOnlyRow.acceptedForGpuHmr, true);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeProfileAdapterResult.resultPresent,
  false,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeProfileAdapterResult.eventManifestPresent,
  true,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeProfileAdapterResult.boundaryPayloadPresent,
  true,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeProfileAdapterResult
    .acceptedAsBoundaryEvidence,
  true,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeAdapterResultTransport.accepted,
  false,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeAdapterEventManifestTransport.accepted,
  true,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .resultTransportCopied,
  false,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .eventManifestTransportCopied,
  true,
);
assert.equal(
  adapterBoundaryEventManifestOnlyRow.realRocmRuntimeBoundaryTargetProcessProvenance
    .boundarySourceTransportCopied,
  true,
);
assert.ok(
  !adapterBoundaryEventManifestOnlyRow.openGaps.some((gap) =>
    gap.includes('runtime_adapter_result_transport_worker_file_missing')
  ),
);
assert.ok(
  !adapterBoundaryEventManifestOnlyRow.reasons.includes(
    'real_rocm_runtime_adapter_boundary_transport_not_accepted',
  ),
);

const adapterBoundaryEventManifestCannotMaskForgedResultTransportDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-event-manifest-cannot-mask-forged-result-transport',
);
await fs.mkdir(adapterBoundaryEventManifestCannotMaskForgedResultTransportDir, { recursive: true });
const adapterBoundaryEventManifestCannotMaskForgedResultTransportReport =
  JSON.parse(JSON.stringify(adapterBoundaryEventManifestOnlyReport));
adapterBoundaryEventManifestCannotMaskForgedResultTransportReport.slug =
  'gpu-real-rocm-adapter-boundary-event-manifest-cannot-mask-forged-result-transport-20260630';
adapterBoundaryEventManifestCannotMaskForgedResultTransportReport
  .real_rocm_runtime_adapter_result_transport = {
    ...adapterBoundaryEventManifestOnlyReport.real_rocm_runtime_adapter_result_transport,
    proofAuthority: 'forged_runtime_adapter_result_transport_authority',
    proof_authority: 'forged_runtime_adapter_result_transport_authority',
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
  };
adapterBoundaryEventManifestCannotMaskForgedResultTransportReport.runtime_proof_artifact
  .real_rocm_runtime_adapter_result_transport =
  adapterBoundaryEventManifestCannotMaskForgedResultTransportReport
    .real_rocm_runtime_adapter_result_transport;
await writeJson(
  path.join(
    adapterBoundaryEventManifestCannotMaskForgedResultTransportDir,
    'real-rocm-adapter-boundary-event-manifest-cannot-mask-forged-result-transport.json',
  ),
  adapterBoundaryEventManifestCannotMaskForgedResultTransportReport,
);
const adapterBoundaryEventManifestCannotMaskForgedResultTransportLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [adapterBoundaryEventManifestCannotMaskForgedResultTransportDir],
    generatedAt: '2026-06-30T00:00:02.2656Z',
    includeUnproven: true,
  });
const adapterBoundaryEventManifestCannotMaskForgedResultTransportRow =
  adapterBoundaryEventManifestCannotMaskForgedResultTransportLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.notEqual(
  adapterBoundaryEventManifestCannotMaskForgedResultTransportRow?.matrixOutcome,
  'full_runtime_gpu_hmr',
);
assert.equal(
  adapterBoundaryEventManifestCannotMaskForgedResultTransportRow.acceptedForGpuHmr,
  false,
);
assert.equal(
  adapterBoundaryEventManifestCannotMaskForgedResultTransportRow
    .realRocmRuntimeAdapterEventManifestTransport.accepted,
  true,
);
assert.equal(
  adapterBoundaryEventManifestCannotMaskForgedResultTransportRow
    .realRocmRuntimeAdapterResultTransport.accepted,
  false,
);
assert.ok(
  adapterBoundaryEventManifestCannotMaskForgedResultTransportRow.reasons.includes(
    'real_rocm_runtime_adapter_result_transport:real_rocm_runtime_adapter_result_transport_claimed_gpu_hmr_success',
  ),
);
assert.ok(
  adapterBoundaryEventManifestCannotMaskForgedResultTransportRow.openGaps.includes(
    'real_rocm_runtime_adapter_result_transport:real_rocm_runtime_adapter_result_transport_claimed_runtime_authority',
  ),
);

const adapterBoundaryOnlyPartialBridgeDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-only-partial-bridge',
);
await fs.mkdir(adapterBoundaryOnlyPartialBridgeDir, { recursive: true });
const adapterBoundaryOnlyPartialBridgeReport =
  JSON.parse(JSON.stringify(adapterBoundaryOnlyBridgeReport));
const adapterBoundaryOnlyPartialBridgeFacet =
  adapterBoundaryOnlyPartialBridgeReport.real_rocm_runtime_profile_adapter_result;
const partialBoundaryLines = (
  Array.isArray(adapterBoundaryOnlyPartialBridgeFacet.adapterRuntimeBoundaryLines)
    ? adapterBoundaryOnlyPartialBridgeFacet.adapterRuntimeBoundaryLines
    : []
)
  .map((line) => String(line ?? '').trim())
  .filter(Boolean)
  .filter((line) => !/\boutput_oracle\b/i.test(line));
adapterBoundaryOnlyPartialBridgeFacet.adapterRuntimeBoundaryLines = partialBoundaryLines;
adapterBoundaryOnlyPartialBridgeFacet.adapter_runtime_boundary_lines = partialBoundaryLines;
adapterBoundaryOnlyPartialBridgeFacet.runtimeBoundaryLines = partialBoundaryLines;
adapterBoundaryOnlyPartialBridgeFacet.runtime_boundary_lines = partialBoundaryLines;
adapterBoundaryOnlyPartialBridgeFacet.acceptedAsBoundaryEvidence = true;
adapterBoundaryOnlyPartialBridgeFacet.accepted_as_boundary_evidence = true;
adapterBoundaryOnlyPartialBridgeFacet.boundaryImportBlockingGaps = [];
adapterBoundaryOnlyPartialBridgeFacet.boundary_import_blocking_gaps = [];
adapterBoundaryOnlyPartialBridgeReport.slug =
  'gpu-real-rocm-adapter-boundary-only-partial-bridge-20260630';
adapterBoundaryOnlyPartialBridgeReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterBoundaryOnlyPartialBridgeFacet;
adapterBoundaryOnlyPartialBridgeReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryOnlyPartialBridgeFacet;
await writeJson(
  path.join(
    adapterBoundaryOnlyPartialBridgeDir,
    'real-rocm-adapter-boundary-only-partial-bridge.json',
  ),
  adapterBoundaryOnlyPartialBridgeReport,
);
const adapterBoundaryOnlyPartialBridgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryOnlyPartialBridgeDir],
  generatedAt: '2026-06-30T00:00:02.265Z',
  includeUnproven: true,
});
const adapterBoundaryOnlyPartialBridgeRow =
  adapterBoundaryOnlyPartialBridgeLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(adapterBoundaryOnlyPartialBridgeRow?.matrixOutcome, 'unproven');
assert.equal(adapterBoundaryOnlyPartialBridgeRow.acceptedForGpuHmr, false);
assert.equal(
  adapterBoundaryOnlyPartialBridgeRow.realRocmRuntimeProfileAdapterResult
    .acceptedAsBoundaryEvidence,
  false,
);
assert.ok(
  adapterBoundaryOnlyPartialBridgeRow.realRocmRuntimeProfileAdapterResult
    .boundaryImportBlockingGaps.includes(
      'real_rocm_runtime_profile_adapter_result_boundary_coverage_incomplete',
    ),
);
assert.ok(
  adapterBoundaryOnlyPartialBridgeRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.missingEventKinds.includes('output_oracle'),
);
assert.ok(
  adapterBoundaryOnlyPartialBridgeRow.reasons.includes(
    'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_profile_adapter_result_boundary_coverage_incomplete',
  ),
);

const adapterStageEventsForgedAuthorityDir = path.join(
  logsRoot,
  'real-rocm-adapter-stage-events-forged-authority',
);
await fs.mkdir(adapterStageEventsForgedAuthorityDir, { recursive: true });
const adapterStageEventsForgedAuthorityReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterStageEventsForgedAuthorityFacet = {
  ...adapterStageEventsForgedAuthorityReport.real_rocm_runtime_adapter_stage_events,
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
};
adapterStageEventsForgedAuthorityReport.slug =
  'gpu-real-rocm-adapter-stage-events-forged-authority-20260629';
adapterStageEventsForgedAuthorityReport.real_rocm_runtime_adapter_stage_events =
  adapterStageEventsForgedAuthorityFacet;
adapterStageEventsForgedAuthorityReport.runtime_proof_artifact.realRocmRuntimeAdapterStageEvents =
  adapterStageEventsForgedAuthorityFacet;
adapterStageEventsForgedAuthorityReport.runtime_proof_artifact.real_rocm_runtime_adapter_stage_events =
  adapterStageEventsForgedAuthorityFacet;
await writeJson(
  path.join(
    adapterStageEventsForgedAuthorityDir,
    'real-rocm-adapter-stage-events-forged-authority.json',
  ),
  adapterStageEventsForgedAuthorityReport,
);
const adapterStageEventsForgedAuthorityLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterStageEventsForgedAuthorityDir],
  generatedAt: '2026-06-29T00:00:02.265Z',
  includeUnproven: true,
});
const adapterStageEventsForgedAuthorityRow =
  adapterStageEventsForgedAuthorityLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(adapterStageEventsForgedAuthorityRow?.matrixOutcome, 'unproven');
assert.equal(adapterStageEventsForgedAuthorityRow.acceptedForGpuHmr, false);
assert.equal(
  adapterStageEventsForgedAuthorityRow.realRocmRuntimeAdapterStageEvents.accepted,
  false,
);
assert.ok(
  adapterStageEventsForgedAuthorityRow.reasons.includes(
    'real_rocm_runtime_adapter_stage_events:real_rocm_runtime_adapter_stage_events_claimed_gpu_hmr_acceptance',
  ),
);
assert.ok(
  adapterStageEventsForgedAuthorityRow.reasons.includes(
    'real_rocm_runtime_adapter_stage_events:real_rocm_runtime_adapter_stage_events_claimed_runtime_authority',
  ),
);

const runtimeBoundaryTargetEnvironmentForgedAuthorityDir = path.join(
  logsRoot,
  'real-rocm-runtime-boundary-target-environment-forged-authority',
);
await fs.mkdir(runtimeBoundaryTargetEnvironmentForgedAuthorityDir, { recursive: true });
const runtimeBoundaryTargetEnvironmentForgedAuthorityReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const runtimeBoundaryTargetEnvironmentForgedAuthorityFacet = {
  ...runtimeBoundaryTargetEnvironmentForgedAuthorityReport
    .real_rocm_runtime_boundary_target_environment,
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
  canSatisfyDispatchProof: true,
  can_satisfy_dispatch_proof: true,
};
runtimeBoundaryTargetEnvironmentForgedAuthorityReport.slug =
  'gpu-real-rocm-runtime-boundary-target-environment-forged-authority-20260630';
runtimeBoundaryTargetEnvironmentForgedAuthorityReport
  .real_rocm_runtime_boundary_target_environment =
    runtimeBoundaryTargetEnvironmentForgedAuthorityFacet;
runtimeBoundaryTargetEnvironmentForgedAuthorityReport
  .runtime_proof_artifact.realRocmRuntimeBoundaryTargetEnvironment =
    runtimeBoundaryTargetEnvironmentForgedAuthorityFacet;
runtimeBoundaryTargetEnvironmentForgedAuthorityReport
  .runtime_proof_artifact.real_rocm_runtime_boundary_target_environment =
    runtimeBoundaryTargetEnvironmentForgedAuthorityFacet;
await writeJson(
  path.join(
    runtimeBoundaryTargetEnvironmentForgedAuthorityDir,
    'real-rocm-runtime-boundary-target-environment-forged-authority.json',
  ),
  runtimeBoundaryTargetEnvironmentForgedAuthorityReport,
);
const runtimeBoundaryTargetEnvironmentForgedAuthorityLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [runtimeBoundaryTargetEnvironmentForgedAuthorityDir],
    generatedAt: '2026-06-30T00:00:02.2655Z',
    includeUnproven: true,
  });
const runtimeBoundaryTargetEnvironmentForgedAuthorityRow =
  runtimeBoundaryTargetEnvironmentForgedAuthorityLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(runtimeBoundaryTargetEnvironmentForgedAuthorityRow?.matrixOutcome, 'unproven');
assert.equal(runtimeBoundaryTargetEnvironmentForgedAuthorityRow.acceptedForGpuHmr, false);
assert.equal(
  runtimeBoundaryTargetEnvironmentForgedAuthorityRow
    .realRocmRuntimeBoundaryTargetEnvironment.accepted,
  false,
);
assert.ok(
  runtimeBoundaryTargetEnvironmentForgedAuthorityRow.reasons.includes(
    'real_rocm_runtime_boundary_target_environment:real_rocm_runtime_boundary_target_environment_claimed_gpu_hmr_acceptance',
  ),
);
assert.ok(
  runtimeBoundaryTargetEnvironmentForgedAuthorityRow.reasons.includes(
    'real_rocm_runtime_boundary_target_environment:real_rocm_runtime_boundary_target_environment_claimed_runtime_authority',
  ),
);
assert.ok(
  runtimeBoundaryTargetEnvironmentForgedAuthorityRow.openGaps.includes(
    'real_rocm_runtime_boundary_target_environment:real_rocm_runtime_boundary_target_environment_claimed_dispatch_authority',
  ),
);

const runtimeBoundaryTargetProcessForgedAuthorityDir = path.join(
  logsRoot,
  'real-rocm-runtime-boundary-target-process-forged-authority',
);
await fs.mkdir(runtimeBoundaryTargetProcessForgedAuthorityDir, { recursive: true });
const runtimeBoundaryTargetProcessForgedAuthorityReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const runtimeBoundaryTargetProcessForgedAuthorityFacet = {
  ...runtimeBoundaryTargetProcessForgedAuthorityReport
    .real_rocm_runtime_boundary_target_process_provenance,
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
  canSatisfyDispatchProof: true,
  can_satisfy_dispatch_proof: true,
};
runtimeBoundaryTargetProcessForgedAuthorityReport.slug =
  'gpu-real-rocm-runtime-boundary-target-process-forged-authority-20260630';
runtimeBoundaryTargetProcessForgedAuthorityReport
  .real_rocm_runtime_boundary_target_process_provenance =
    runtimeBoundaryTargetProcessForgedAuthorityFacet;
runtimeBoundaryTargetProcessForgedAuthorityReport
  .runtime_proof_artifact.realRocmRuntimeBoundaryTargetProcessProvenance =
    runtimeBoundaryTargetProcessForgedAuthorityFacet;
runtimeBoundaryTargetProcessForgedAuthorityReport
  .runtime_proof_artifact.real_rocm_runtime_boundary_target_process_provenance =
    runtimeBoundaryTargetProcessForgedAuthorityFacet;
await writeJson(
  path.join(
    runtimeBoundaryTargetProcessForgedAuthorityDir,
    'real-rocm-runtime-boundary-target-process-forged-authority.json',
  ),
  runtimeBoundaryTargetProcessForgedAuthorityReport,
);
const runtimeBoundaryTargetProcessForgedAuthorityLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [runtimeBoundaryTargetProcessForgedAuthorityDir],
    generatedAt: '2026-06-30T00:00:02.2656Z',
    includeUnproven: true,
  });
const runtimeBoundaryTargetProcessForgedAuthorityRow =
  runtimeBoundaryTargetProcessForgedAuthorityLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(runtimeBoundaryTargetProcessForgedAuthorityRow?.matrixOutcome, 'unproven');
assert.equal(runtimeBoundaryTargetProcessForgedAuthorityRow.acceptedForGpuHmr, false);
assert.equal(
  runtimeBoundaryTargetProcessForgedAuthorityRow
    .realRocmRuntimeBoundaryTargetProcessProvenance.accepted,
  false,
);
assert.ok(
  runtimeBoundaryTargetProcessForgedAuthorityRow.reasons.includes(
    'real_rocm_runtime_boundary_target_process_provenance:real_rocm_runtime_boundary_target_process_provenance_claimed_gpu_hmr_acceptance',
  ),
);
assert.ok(
  runtimeBoundaryTargetProcessForgedAuthorityRow.reasons.includes(
    'real_rocm_runtime_boundary_target_process_provenance:real_rocm_runtime_boundary_target_process_provenance_claimed_runtime_authority',
  ),
);
assert.ok(
  runtimeBoundaryTargetProcessForgedAuthorityRow.openGaps.includes(
    'real_rocm_runtime_boundary_target_process_provenance:real_rocm_runtime_boundary_target_process_provenance_claimed_dispatch_authority',
  ),
);

const runtimeBoundaryTargetProcessSerializedOnlyDir = path.join(
  logsRoot,
  'real-rocm-runtime-boundary-target-process-serialized-only',
);
await fs.mkdir(runtimeBoundaryTargetProcessSerializedOnlyDir, { recursive: true });
const runtimeBoundaryTargetProcessSerializedOnlyReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
runtimeBoundaryTargetProcessSerializedOnlyReport.slug =
  'gpu-real-rocm-runtime-boundary-target-process-serialized-only-20260630';
for (const container of [
  runtimeBoundaryTargetProcessSerializedOnlyReport.real_rocm_runtime_profile_adapter_result,
  runtimeBoundaryTargetProcessSerializedOnlyReport.real_rocm_runtime_adapter_execution,
  runtimeBoundaryTargetProcessSerializedOnlyReport.runtime_proof_artifact
    .realRocmRuntimeProfileAdapterResult,
  runtimeBoundaryTargetProcessSerializedOnlyReport.runtime_proof_artifact
    .real_rocm_runtime_profile_adapter_result,
  runtimeBoundaryTargetProcessSerializedOnlyReport.runtime_proof_artifact
    .realRocmRuntimeAdapterExecution,
  runtimeBoundaryTargetProcessSerializedOnlyReport.runtime_proof_artifact
    .real_rocm_runtime_adapter_execution,
]) {
  if (!container || typeof container !== 'object') continue;
  container.runtimeBoundaryLines = [];
  container.runtime_boundary_lines = [];
  container.adapterRuntimeBoundaryLines = [];
  container.adapter_runtime_boundary_lines = [];
  container.runtimeBoundaryLineCount = 0;
  container.runtime_boundary_line_count = 0;
}
await writeJson(
  path.join(
    runtimeBoundaryTargetProcessSerializedOnlyDir,
    'real-rocm-runtime-boundary-target-process-serialized-only.json',
  ),
  runtimeBoundaryTargetProcessSerializedOnlyReport,
);
const runtimeBoundaryTargetProcessSerializedOnlyLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [runtimeBoundaryTargetProcessSerializedOnlyDir],
    generatedAt: '2026-06-30T00:00:02.2657Z',
    includeUnproven: true,
  });
const runtimeBoundaryTargetProcessSerializedOnlyRow =
  runtimeBoundaryTargetProcessSerializedOnlyLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(runtimeBoundaryTargetProcessSerializedOnlyRow?.matrixOutcome, 'unproven');
assert.equal(runtimeBoundaryTargetProcessSerializedOnlyRow.acceptedForGpuHmr, false);
assert.equal(
  runtimeBoundaryTargetProcessSerializedOnlyRow
    .realRocmRuntimeBoundaryTargetProcessProvenance.accepted,
  false,
);
assert.ok(
  runtimeBoundaryTargetProcessSerializedOnlyRow.openGaps.includes(
    'real_rocm_runtime_boundary_target_process_provenance:runtime_boundary_target_process_source_lines_missing',
  ),
);

const adapterOverlayOnlyClosureDir = path.join(
  logsRoot,
  'real-rocm-adapter-overlay-only-runtime-chain-closure',
);
await fs.mkdir(adapterOverlayOnlyClosureDir, { recursive: true });
const adapterOverlayOnlyClosureReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterOverlayOnlyClosureRecord =
  adapterOverlayOnlyClosureReport.runtime_proof_artifact.proofLedger.records[0];
for (const key of [
  'selected_loader_transport',
  'selectedLoaderTransport',
  'artifact_transport',
  'artifactTransport',
]) {
  if (adapterOverlayOnlyClosureRecord.loader_event) {
    delete adapterOverlayOnlyClosureRecord.loader_event[key];
  }
  if (adapterOverlayOnlyClosureRecord.loaderEvent) {
    delete adapterOverlayOnlyClosureRecord.loaderEvent[key];
  }
}
for (const event of [
  adapterOverlayOnlyClosureRecord.epoch_publish_event,
  adapterOverlayOnlyClosureRecord.epochPublishEvent,
  adapterOverlayOnlyClosureRecord.dispatch_event,
  adapterOverlayOnlyClosureRecord.dispatchEvent,
  adapterOverlayOnlyClosureRecord.output_event,
  adapterOverlayOnlyClosureRecord.outputEvent,
]) {
  if (!event) continue;
  delete event.dispatch_table_entry_id;
  delete event.dispatchTableEntryId;
}
for (const event of [
  adapterOverlayOnlyClosureRecord.dispatch_event,
  adapterOverlayOnlyClosureRecord.dispatchEvent,
  adapterOverlayOnlyClosureRecord.output_event,
  adapterOverlayOnlyClosureRecord.outputEvent,
]) {
  if (!event) continue;
  delete event.output_target_id;
  delete event.outputTargetId;
}
const adapterOverlayOnlyClosureProofLedger =
  buildGpuHmrProofLedger(adapterOverlayOnlyClosureRecord);
const adapterOverlayOnlyClosureProofLedgerQuery =
  queryGpuHmrLedgerInvariants(adapterOverlayOnlyClosureProofLedger);
assert.deepEqual(adapterOverlayOnlyClosureProofLedgerQuery.failedInvariants, []);
assert.equal(adapterOverlayOnlyClosureProofLedgerQuery.gpuHmrSuccess, true);
adapterOverlayOnlyClosureReport.slug =
  'gpu-real-rocm-adapter-overlay-only-runtime-chain-closure-20260629';
adapterOverlayOnlyClosureReport.proofLedger = adapterOverlayOnlyClosureProofLedger;
adapterOverlayOnlyClosureReport.proof_ledger = adapterOverlayOnlyClosureProofLedger;
adapterOverlayOnlyClosureReport.proofLedgerQuery =
  adapterOverlayOnlyClosureProofLedgerQuery;
adapterOverlayOnlyClosureReport.proof_ledger_query =
  adapterOverlayOnlyClosureProofLedgerQuery;
adapterOverlayOnlyClosureReport.runtime_proof_artifact.proofLedger =
  adapterOverlayOnlyClosureProofLedger;
adapterOverlayOnlyClosureReport.runtime_proof_artifact.proof_ledger =
  adapterOverlayOnlyClosureProofLedger;
adapterOverlayOnlyClosureReport.runtime_proof_artifact.proofLedgerQuery =
  adapterOverlayOnlyClosureProofLedgerQuery;
adapterOverlayOnlyClosureReport.runtime_proof_artifact.proof_ledger_query =
  adapterOverlayOnlyClosureProofLedgerQuery;
const adapterOverlayOnlyClosureAdapterResult = {
  ...adapterOverlayOnlyClosureReport.real_rocm_runtime_profile_adapter_result,
  proofLedgerId: adapterOverlayOnlyClosureProofLedger.proofId,
  proof_ledger_id: adapterOverlayOnlyClosureProofLedger.proofId,
};
adapterOverlayOnlyClosureReport.real_rocm_runtime_profile_adapter_result =
  adapterOverlayOnlyClosureAdapterResult;
adapterOverlayOnlyClosureReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterOverlayOnlyClosureAdapterResult;
adapterOverlayOnlyClosureReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterOverlayOnlyClosureAdapterResult;
await writeJson(
  path.join(
    adapterOverlayOnlyClosureDir,
    'real-rocm-adapter-overlay-only-runtime-chain-closure.json',
  ),
  adapterOverlayOnlyClosureReport,
);
const adapterOverlayOnlyClosureLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterOverlayOnlyClosureDir],
  generatedAt: '2026-06-29T00:00:02.266Z',
  includeUnproven: true,
});
const adapterOverlayOnlyClosureRow =
  adapterOverlayOnlyClosureLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.equal(adapterOverlayOnlyClosureRow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(adapterOverlayOnlyClosureRow.acceptedForGpuHmr, true);
assert.equal(adapterOverlayOnlyClosureRow.realRocmRuntimeChain.accepted, true);
assert.equal(adapterOverlayOnlyClosureRow.realRocmRuntimeChain.adapterBoundaryOverlayAccepted, true);
assert.deepEqual(adapterOverlayOnlyClosureRow.realRocmRuntimeChain.adapterOverlayClosureGaps, []);
assert.deepEqual(adapterOverlayOnlyClosureRow.realRocmRuntimeChain.adapterOverlayBaseClosureGaps, []);
assert.equal(
  adapterOverlayOnlyClosureRow.realRocmRuntimeChain.selectedLoaderTransport,
  'ram_bytes',
);
assert.equal(
  adapterOverlayOnlyClosureRow.realRocmRuntimeChain.dispatchTableEntryId,
  `dispatch-table-entry:${completeAdapterBoundaryBridgeScope}`,
);
assert.equal(
  adapterOverlayOnlyClosureRow.realRocmRuntimeChain.outputTargetId,
  `output-target:${completeAdapterBoundaryBridgeScope}`,
);
assert.equal(
  adapterOverlayOnlyClosureLedger.summary.broadLibraryAgnosticReadiness.accepted,
  false,
);
assert.equal(
  adapterOverlayOnlyClosureLedger.summary.broadLibraryAgnosticReadiness.broadRuntimeRows,
  0,
);

const adapterBoundaryWeakHostIdentityDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-host-identity-weak',
);
await fs.mkdir(adapterBoundaryWeakHostIdentityDir, { recursive: true });
const adapterBoundaryWeakHostIdentityReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterBoundaryWeakHostIdentityResult = {
  ...adapterBoundaryWeakHostIdentityReport.real_rocm_runtime_profile_adapter_result,
};
const adapterBoundaryWeakHostIdentityResultLines =
  replaceBoundaryHostIdentityWithWeakEvent(
    adapterBoundaryWeakHostIdentityResult.adapterRuntimeBoundaryLines,
    completeAdapterBoundaryBridgeScope,
  );
adapterBoundaryWeakHostIdentityResult.adapterRuntimeBoundaryLines =
  adapterBoundaryWeakHostIdentityResultLines;
adapterBoundaryWeakHostIdentityResult.adapter_runtime_boundary_lines =
  adapterBoundaryWeakHostIdentityResultLines;
adapterBoundaryWeakHostIdentityResult.evidenceRefs = [
  adapterBoundaryWeakHostIdentityResult.adapterResultHash,
  ...adapterBoundaryWeakHostIdentityResultLines.map((line) =>
    `adapter-boundary:${hashValue(line)}`
  ),
];
adapterBoundaryWeakHostIdentityResult.evidence_refs =
  adapterBoundaryWeakHostIdentityResult.evidenceRefs;
const adapterBoundaryWeakHostIdentityExecution = {
  ...adapterBoundaryWeakHostIdentityReport.real_rocm_runtime_adapter_execution,
};
const adapterBoundaryWeakHostIdentityExecutionLines =
  replaceBoundaryHostIdentityWithWeakEvent(
    adapterBoundaryWeakHostIdentityExecution.runtimeBoundaryLines,
    completeAdapterBoundaryBridgeScope,
  );
adapterBoundaryWeakHostIdentityExecution.runtimeBoundaryLines =
  adapterBoundaryWeakHostIdentityExecutionLines;
adapterBoundaryWeakHostIdentityExecution.runtime_boundary_lines =
  adapterBoundaryWeakHostIdentityExecutionLines;
adapterBoundaryWeakHostIdentityExecution.runtimeBoundaryLineCount =
  adapterBoundaryWeakHostIdentityExecutionLines.length;
adapterBoundaryWeakHostIdentityExecution.runtime_boundary_line_count =
  adapterBoundaryWeakHostIdentityExecutionLines.length;
adapterBoundaryWeakHostIdentityExecution.evidenceRefs = [
  `runtime-adapter-execution:${completeAdapterBoundaryBridgeScope}`,
  `runtime-adapter-template:runtime_boundary_log_harvest_v1`,
  `runtime-adapter-command:${adapterBoundaryWeakHostIdentityExecution.adapterCommandHash}`,
  ...adapterBoundaryWeakHostIdentityExecutionLines.map((line) =>
    `runtime-adapter-boundary:${hashValue(line)}`
  ),
];
adapterBoundaryWeakHostIdentityExecution.evidence_refs =
  adapterBoundaryWeakHostIdentityExecution.evidenceRefs;
adapterBoundaryWeakHostIdentityReport.slug =
  'gpu-real-rocm-adapter-boundary-host-identity-weak-20260630';
adapterBoundaryWeakHostIdentityReport.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryWeakHostIdentityResult;
adapterBoundaryWeakHostIdentityReport.real_rocm_runtime_adapter_execution =
  adapterBoundaryWeakHostIdentityExecution;
adapterBoundaryWeakHostIdentityReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterBoundaryWeakHostIdentityResult;
adapterBoundaryWeakHostIdentityReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryWeakHostIdentityResult;
adapterBoundaryWeakHostIdentityReport.runtime_proof_artifact.realRocmRuntimeAdapterExecution =
  adapterBoundaryWeakHostIdentityExecution;
adapterBoundaryWeakHostIdentityReport.runtime_proof_artifact.real_rocm_runtime_adapter_execution =
  adapterBoundaryWeakHostIdentityExecution;
await writeJson(
  path.join(
    adapterBoundaryWeakHostIdentityDir,
    'real-rocm-adapter-boundary-host-identity-weak.json',
  ),
  adapterBoundaryWeakHostIdentityReport,
);
const adapterBoundaryWeakHostIdentityLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryWeakHostIdentityDir],
  generatedAt: '2026-06-30T00:00:02.2645Z',
  includeUnproven: true,
});
const adapterBoundaryWeakHostIdentityRow = adapterBoundaryWeakHostIdentityLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(adapterBoundaryWeakHostIdentityRow?.matrixOutcome, 'unproven');
assert.equal(adapterBoundaryWeakHostIdentityRow.acceptedForGpuHmr, false);
assert.equal(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeProfileAdapterResult.accepted,
  false,
);
assert.equal(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeAdapterExecution.accepted,
  false,
);
assert.deepEqual(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.missingEventKinds,
  [],
);
assert.deepEqual(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.missingEventKinds,
  [],
);
assert.equal(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.hostIdentityProofShaped,
  false,
);
assert.equal(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.hostIdentityProofShaped,
  false,
);
assert.ok(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.hostIdentityEvidence.rejected_reasons.includes('role_missing'),
);
assert.ok(
  adapterBoundaryWeakHostIdentityRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.hostIdentityEvidence.rejected_reasons.includes('role_missing'),
);
assert.ok(adapterBoundaryWeakHostIdentityRow.openGaps.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_adapter_boundary_host_identity_fields_incomplete',
));
assert.ok(adapterBoundaryWeakHostIdentityRow.openGaps.includes(
  'real_rocm_runtime_adapter_execution:real_rocm_runtime_adapter_boundary_host_identity_fields_incomplete',
));
assert.ok(adapterBoundaryWeakHostIdentityRow.reasons.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_adapter_boundary_host_identity_fields_incomplete',
));
assert.ok(adapterBoundaryWeakHostIdentityRow.reasons.includes(
  'real_rocm_runtime_adapter_execution:real_rocm_runtime_adapter_boundary_host_identity_fields_incomplete',
));

const forgedOperationalEvidenceRocmDir = path.join(
  logsRoot,
  'real-rocm-operational-evidence-forge',
);
await fs.mkdir(forgedOperationalEvidenceRocmDir, { recursive: true });
const forgedOperationalEvidenceReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const forgedOperationalTimeoutControl = {
  schemaVersion: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
  schema_version: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
  runId: 'forged-operational-run-a',
  run_id: 'forged-operational-run-a',
  timeoutSeconds: 1,
  timeout_seconds: 1,
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
  cleanup: {
    schemaVersion: 'synthi.real_rocm.worker_lifecycle_cleanup.v1',
    schema_version: 'synthi.real_rocm.worker_lifecycle_cleanup.v1',
    runId: 'forged-operational-run-b',
    run_id: 'forged-operational-run-b',
    proofAuthority: 'runtime_proof',
    proof_authority: 'runtime_proof',
    acceptedForGpuHmr: true,
    accepted_for_gpu_hmr: true,
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
  },
};
const forgedOperationalRuntimeCollection = {
  schemaVersion: 'synthi.real_rocm.runtime_evidence_collection.v1',
  schema_version: 'synthi.real_rocm.runtime_evidence_collection.v1',
  status: 'collected',
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
};
const forgedOperationalRuntimeCheckpoint = {
  schemaVersion: 'synthi.real_rocm.fail_closed_runtime_checkpoint.v1',
  schema_version: 'synthi.real_rocm.fail_closed_runtime_checkpoint.v1',
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  fullRuntimeProven: true,
  full_runtime_proven: true,
};
const forgedOperationalResultCheckpoint = {
  label: 'pre-runtime-evidence',
  status: 'fail_closed_checkpoint_write',
  proofAuthority: 'runtime_proof',
  proof_authority: 'runtime_proof',
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
};
forgedOperationalEvidenceReport.slug =
  'gpu-real-rocm-operational-evidence-forge-20260629';
forgedOperationalEvidenceReport.upstream_lifecycle_timeout_control =
  forgedOperationalTimeoutControl;
forgedOperationalEvidenceReport.upstreamLifecycleTimeoutControl =
  forgedOperationalTimeoutControl;
forgedOperationalEvidenceReport.runtime_evidence_collection =
  forgedOperationalRuntimeCollection;
forgedOperationalEvidenceReport.runtimeEvidenceCollection =
  forgedOperationalRuntimeCollection;
forgedOperationalEvidenceReport.runtime_evidence_checkpoint =
  forgedOperationalRuntimeCheckpoint;
forgedOperationalEvidenceReport.runtimeEvidenceCheckpoint =
  forgedOperationalRuntimeCheckpoint;
forgedOperationalEvidenceReport.result_checkpoints = [
  forgedOperationalResultCheckpoint,
];
forgedOperationalEvidenceReport.resultCheckpoints =
  forgedOperationalEvidenceReport.result_checkpoints;
forgedOperationalEvidenceReport.current_result_checkpoint =
  forgedOperationalResultCheckpoint;
forgedOperationalEvidenceReport.currentResultCheckpoint =
  forgedOperationalResultCheckpoint;
await writeJson(
  path.join(forgedOperationalEvidenceRocmDir, 'real-rocm-operational-evidence-forge.json'),
  forgedOperationalEvidenceReport,
);
const forgedOperationalEvidenceLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedOperationalEvidenceRocmDir],
  generatedAt: '2026-06-29T00:00:02.2645Z',
  includeUnproven: true,
});
const forgedOperationalEvidenceRow = forgedOperationalEvidenceLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedOperationalEvidenceRow?.matrixOutcome, 'unproven');
assert.equal(forgedOperationalEvidenceRow.acceptedForGpuHmr, false);
assert.equal(forgedOperationalEvidenceRow.realRocmOperationalEvidence.present, true);
assert.equal(forgedOperationalEvidenceRow.realRocmOperationalEvidence.accepted, false);
assert.ok(forgedOperationalEvidenceRow.reasons.includes(
  'real_rocm_operational_evidence:real_rocm_worker_lifecycle_timeout_control_claimed_gpu_hmr_success',
));
assert.ok(forgedOperationalEvidenceRow.reasons.includes(
  'real_rocm_operational_evidence:real_rocm_worker_lifecycle_cleanup_run_id_mismatch',
));
assert.ok(forgedOperationalEvidenceRow.reasons.includes(
  'real_rocm_operational_evidence:real_rocm_runtime_evidence_collection_claimed_runtime_authority',
));
assert.ok(forgedOperationalEvidenceRow.reasons.includes(
  'real_rocm_operational_evidence:real_rocm_runtime_evidence_checkpoint_claimed_full_runtime_proof',
));
assert.ok(forgedOperationalEvidenceRow.openGaps.includes(
  'real_rocm_operational_evidence:real_rocm_result_checkpoint_claimed_runtime_authority',
));
assert.ok(forgedOperationalEvidenceRow.openGaps.includes(
  'real_rocm_operational_evidence_not_accepted',
));

const validOperationalTimeoutSourceDir = path.join(
  logsRoot,
  'real-rocm-operational-timeout-source-valid',
);
await fs.mkdir(validOperationalTimeoutSourceDir, { recursive: true });
const validOperationalTimeoutSourceReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
validOperationalTimeoutSourceReport.slug =
  'gpu-real-rocm-operational-timeout-source-valid-20260630';
validOperationalTimeoutSourceReport.upstream_lifecycle_timeout_control = {
  schemaVersion: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
  schema_version: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
  proofAuthority: 'orchestration_timeout_control_not_gpu_hmr_proof',
  proof_authority: 'orchestration_timeout_control_not_gpu_hmr_proof',
  runId: 'valid-timeout-source-run',
  run_id: 'valid-timeout-source-run',
  timeoutSource: 'caller_env',
  timeout_source: 'caller_env',
  timeoutEnvValue: '120000',
  timeout_env_value: '120000',
  timeoutMs: 120000,
  timeout_ms: 120000,
  timeoutSeconds: 120,
  timeout_seconds: 120,
  killAfterSeconds: 6,
  kill_after_seconds: 6,
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
  canSatisfyRuntimeProof: false,
  can_satisfy_runtime_proof: false,
};
validOperationalTimeoutSourceReport.upstreamLifecycleTimeoutControl =
  validOperationalTimeoutSourceReport.upstream_lifecycle_timeout_control;
await writeJson(
  path.join(
    validOperationalTimeoutSourceDir,
    'real-rocm-operational-timeout-source-valid.json',
  ),
  validOperationalTimeoutSourceReport,
);
const validOperationalTimeoutSourceLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [validOperationalTimeoutSourceDir],
  generatedAt: '2026-06-30T00:00:02.2646Z',
  includeUnproven: true,
});
const validOperationalTimeoutSourceRow =
  validOperationalTimeoutSourceLedger.rows.find((row) =>
    row.proofMode === 'real_rocm_repo_validation'
  );
assert.equal(validOperationalTimeoutSourceRow?.realRocmOperationalEvidence.present, true);
assert.equal(validOperationalTimeoutSourceRow.realRocmOperationalEvidence.accepted, true);
assert.equal(validOperationalTimeoutSourceRow.realRocmOperationalEvidence.timeoutSource, 'caller_env');
assert.equal(validOperationalTimeoutSourceRow.realRocmOperationalEvidence.timeoutMs, 120000);
assert.equal(validOperationalTimeoutSourceRow.realRocmOperationalEvidence.timeoutSeconds, 120);
assert.equal(validOperationalTimeoutSourceRow.realRocmOperationalEvidence.killAfterSeconds, 6);
assert.equal(validOperationalTimeoutSourceRow.realRocmOperationalEvidence.timeoutEnvValue, 120000);
assert.ok(!validOperationalTimeoutSourceRow.reasons.includes(
  'real_rocm_operational_evidence_not_accepted',
));

const forgedOperationalTimeoutSourceDir = path.join(
  logsRoot,
  'real-rocm-operational-timeout-source-forge',
);
await fs.mkdir(forgedOperationalTimeoutSourceDir, { recursive: true });
const forgedOperationalTimeoutSourceReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
forgedOperationalTimeoutSourceReport.slug =
  'gpu-real-rocm-operational-timeout-source-forge-20260630';
forgedOperationalTimeoutSourceReport.upstream_lifecycle_timeout_control = {
  schemaVersion: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
  schema_version: 'synthi.real_rocm.worker_lifecycle_timeout_control.v1',
  proofAuthority: 'orchestration_timeout_control_not_gpu_hmr_proof',
  proof_authority: 'orchestration_timeout_control_not_gpu_hmr_proof',
  runId: 'forged-timeout-source-run',
  run_id: 'forged-timeout-source-run',
  timeoutSource: 'caller_env',
  timeout_source: 'caller_env',
  timeoutEnvValue: '120000',
  timeout_env_value: '120000',
  timeoutMs: 7200000,
  timeout_ms: 7200000,
  timeoutSeconds: 7200,
  timeout_seconds: 7200,
  killAfterSeconds: 30,
  kill_after_seconds: 30,
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
  canSatisfyRuntimeProof: false,
  can_satisfy_runtime_proof: false,
};
forgedOperationalTimeoutSourceReport.upstreamLifecycleTimeoutControl =
  forgedOperationalTimeoutSourceReport.upstream_lifecycle_timeout_control;
await writeJson(
  path.join(
    forgedOperationalTimeoutSourceDir,
    'real-rocm-operational-timeout-source-forge.json',
  ),
  forgedOperationalTimeoutSourceReport,
);
const forgedOperationalTimeoutSourceLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedOperationalTimeoutSourceDir],
  generatedAt: '2026-06-30T00:00:02.2647Z',
  includeUnproven: true,
});
const forgedOperationalTimeoutSourceRow =
  forgedOperationalTimeoutSourceLedger.rows.find((row) =>
    row.proofMode === 'real_rocm_repo_validation'
  );
assert.equal(forgedOperationalTimeoutSourceRow?.matrixOutcome, 'unproven');
assert.equal(forgedOperationalTimeoutSourceRow.acceptedForGpuHmr, false);
assert.equal(forgedOperationalTimeoutSourceRow.realRocmOperationalEvidence.present, true);
assert.equal(forgedOperationalTimeoutSourceRow.realRocmOperationalEvidence.accepted, false);
assert.ok(forgedOperationalTimeoutSourceRow.reasons.includes(
  'real_rocm_operational_evidence:real_rocm_worker_lifecycle_timeout_control_env_value_mismatch',
));
assert.ok(forgedOperationalTimeoutSourceRow.openGaps.includes(
  'real_rocm_operational_evidence_not_accepted',
));

const adapterBoundaryProofIdMismatchDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-bridge-proof-id-mismatch',
);
await fs.mkdir(adapterBoundaryProofIdMismatchDir, { recursive: true });
const adapterBoundaryProofIdMismatchReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterBoundaryMismatchedResult = {
  ...adapterBoundaryProofIdMismatchReport.real_rocm_runtime_profile_adapter_result,
  strictRuntimeProofId: `gpu-runtime-proof:sha256:${'d'.repeat(64)}`,
  strict_runtime_proof_id: `gpu-runtime-proof:sha256:${'d'.repeat(64)}`,
  proofLedgerId: `gpu-ledger-proof:sha256:${'e'.repeat(64)}`,
  proof_ledger_id: `gpu-ledger-proof:sha256:${'e'.repeat(64)}`,
};
adapterBoundaryProofIdMismatchReport.slug =
  'gpu-real-rocm-adapter-boundary-bridge-proof-id-mismatch-20260629';
adapterBoundaryProofIdMismatchReport.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryMismatchedResult;
adapterBoundaryProofIdMismatchReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterBoundaryMismatchedResult;
adapterBoundaryProofIdMismatchReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryMismatchedResult;
await writeJson(
  path.join(
    adapterBoundaryProofIdMismatchDir,
    'real-rocm-adapter-boundary-bridge-proof-id-mismatch.json',
  ),
  adapterBoundaryProofIdMismatchReport,
);
const adapterBoundaryProofIdMismatchLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryProofIdMismatchDir],
  generatedAt: '2026-06-29T00:00:02.265Z',
  includeUnproven: true,
});
const adapterBoundaryProofIdMismatchRow = adapterBoundaryProofIdMismatchLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(adapterBoundaryProofIdMismatchRow?.matrixOutcome, 'unproven');
assert.equal(adapterBoundaryProofIdMismatchRow.acceptedForGpuHmr, false);
assert.equal(
  adapterBoundaryProofIdMismatchRow.realRocmRuntimeProfileAdapterResult.accepted,
  true,
);
assert.equal(
  adapterBoundaryProofIdMismatchRow.realRocmRuntimeProfileAdapterResult.strictRuntimeProofIdMatches,
  false,
);
assert.equal(
  adapterBoundaryProofIdMismatchRow.realRocmRuntimeProfileAdapterResult.proofLedgerIdMatches,
  false,
);
assert.ok(adapterBoundaryProofIdMismatchRow.openGaps.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_profile_adapter_result_runtime_proof_id_mismatch',
));
assert.ok(adapterBoundaryProofIdMismatchRow.openGaps.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_profile_adapter_result_proof_ledger_id_mismatch',
));
assert.ok(adapterBoundaryProofIdMismatchRow.reasons.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_profile_adapter_result_runtime_proof_id_mismatch',
));
assert.ok(adapterBoundaryProofIdMismatchRow.reasons.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_profile_adapter_result_proof_ledger_id_mismatch',
));

const adapterBoundaryResultIncompleteDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-result-incomplete',
);
await fs.mkdir(adapterBoundaryResultIncompleteDir, { recursive: true });
const adapterBoundaryResultIncompleteReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterBoundaryIncompleteResult = {
  ...adapterBoundaryResultIncompleteReport.real_rocm_runtime_profile_adapter_result,
};
const adapterBoundaryIncompleteResultLines =
  adapterBoundaryIncompleteResult.adapterRuntimeBoundaryLines.filter((line) =>
    !/\boutput_oracle\b/i.test(line)
  );
adapterBoundaryIncompleteResult.adapterRuntimeBoundaryLines =
  adapterBoundaryIncompleteResultLines;
adapterBoundaryIncompleteResult.adapter_runtime_boundary_lines =
  adapterBoundaryIncompleteResultLines;
adapterBoundaryResultIncompleteReport.slug =
  'gpu-real-rocm-adapter-boundary-result-incomplete-20260629';
adapterBoundaryResultIncompleteReport.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryIncompleteResult;
adapterBoundaryResultIncompleteReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterBoundaryIncompleteResult;
adapterBoundaryResultIncompleteReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryIncompleteResult;
await writeJson(
  path.join(
    adapterBoundaryResultIncompleteDir,
    'real-rocm-adapter-boundary-result-incomplete.json',
  ),
  adapterBoundaryResultIncompleteReport,
);
const adapterBoundaryResultIncompleteLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryResultIncompleteDir],
  generatedAt: '2026-06-29T00:00:02.2655Z',
  includeUnproven: true,
});
const adapterBoundaryResultIncompleteRow = adapterBoundaryResultIncompleteLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(adapterBoundaryResultIncompleteRow?.matrixOutcome, 'unproven');
assert.equal(adapterBoundaryResultIncompleteRow.acceptedForGpuHmr, false);
assert.equal(
  adapterBoundaryResultIncompleteRow.realRocmRuntimeProfileAdapterResult.accepted,
  false,
);
assert.ok(
  adapterBoundaryResultIncompleteRow.realRocmRuntimeProfileAdapterResult
    .adapterBoundaryCoverage.missingEventKinds.includes('output_oracle'),
);
assert.ok(adapterBoundaryResultIncompleteRow.openGaps.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_profile_adapter_result_boundary_coverage_incomplete',
));
assert.ok(adapterBoundaryResultIncompleteRow.reasons.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_profile_adapter_result_boundary_coverage_incomplete',
));

const adapterBoundaryExecutionIncompleteDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-execution-incomplete',
);
await fs.mkdir(adapterBoundaryExecutionIncompleteDir, { recursive: true });
const adapterBoundaryExecutionIncompleteReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const adapterBoundaryIncompleteExecution = {
  ...adapterBoundaryExecutionIncompleteReport.real_rocm_runtime_adapter_execution,
};
const adapterBoundaryIncompleteExecutionLines =
  adapterBoundaryIncompleteExecution.runtimeBoundaryLines.filter((line) =>
    !/\bhost_identity\b/i.test(line)
  );
adapterBoundaryIncompleteExecution.runtimeBoundaryLines =
  adapterBoundaryIncompleteExecutionLines;
adapterBoundaryIncompleteExecution.runtime_boundary_lines =
  adapterBoundaryIncompleteExecutionLines;
adapterBoundaryIncompleteExecution.runtimeBoundaryLineCount =
  adapterBoundaryIncompleteExecutionLines.length;
adapterBoundaryIncompleteExecution.runtime_boundary_line_count =
  adapterBoundaryIncompleteExecutionLines.length;
adapterBoundaryExecutionIncompleteReport.slug =
  'gpu-real-rocm-adapter-boundary-execution-incomplete-20260629';
adapterBoundaryExecutionIncompleteReport.real_rocm_runtime_adapter_execution =
  adapterBoundaryIncompleteExecution;
adapterBoundaryExecutionIncompleteReport.runtime_proof_artifact.realRocmRuntimeAdapterExecution =
  adapterBoundaryIncompleteExecution;
adapterBoundaryExecutionIncompleteReport.runtime_proof_artifact.real_rocm_runtime_adapter_execution =
  adapterBoundaryIncompleteExecution;
await writeJson(
  path.join(
    adapterBoundaryExecutionIncompleteDir,
    'real-rocm-adapter-boundary-execution-incomplete.json',
  ),
  adapterBoundaryExecutionIncompleteReport,
);
const adapterBoundaryExecutionIncompleteLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryExecutionIncompleteDir],
  generatedAt: '2026-06-29T00:00:02.2656Z',
  includeUnproven: true,
});
const adapterBoundaryExecutionIncompleteRow = adapterBoundaryExecutionIncompleteLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(adapterBoundaryExecutionIncompleteRow?.matrixOutcome, 'unproven');
assert.equal(adapterBoundaryExecutionIncompleteRow.acceptedForGpuHmr, false);
assert.equal(
  adapterBoundaryExecutionIncompleteRow.realRocmRuntimeAdapterExecution.accepted,
  false,
);
assert.ok(
  adapterBoundaryExecutionIncompleteRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.missingEventKinds.includes('host_identity'),
);
assert.ok(adapterBoundaryExecutionIncompleteRow.openGaps.includes(
  'real_rocm_runtime_adapter_execution:real_rocm_runtime_adapter_execution_boundary_coverage_incomplete',
));
assert.ok(adapterBoundaryExecutionIncompleteRow.reasons.includes(
  'real_rocm_runtime_adapter_execution:real_rocm_runtime_adapter_execution_boundary_coverage_incomplete',
));

const adapterBoundaryCoverageForgeDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-coverage-forge',
);
await fs.mkdir(adapterBoundaryCoverageForgeDir, { recursive: true });
const adapterBoundaryCoverageForgeReport =
  JSON.parse(JSON.stringify(completeAdapterBoundaryReport));
const forgedAdapterBoundaryCoverage = {
  schemaVersion: 'synthi.real_rocm.runtime_adapter_boundary_coverage.v1',
  schema_version: 'synthi.real_rocm.runtime_adapter_boundary_coverage.v1',
  proofAuthority: 'adapter_boundary_coverage_diagnostic_only_not_runtime_authority',
  proof_authority: 'adapter_boundary_coverage_diagnostic_only_not_runtime_authority',
  acceptedForGpuHmr: true,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: true,
  gpu_hmr_success: true,
  canSatisfyRuntimeProof: true,
  can_satisfy_runtime_proof: true,
  boundaryLineHashes:
    completeAdapterBoundaryRuntimeAdapterResult.adapterRuntimeBoundaryLines.map(hashValue),
  boundary_line_hashes:
    completeAdapterBoundaryRuntimeAdapterResult.adapterRuntimeBoundaryLines.map(hashValue),
};
adapterBoundaryCoverageForgeReport.slug =
  'gpu-real-rocm-adapter-boundary-coverage-forge-20260629';
adapterBoundaryCoverageForgeReport.real_rocm_runtime_profile_adapter_result = {
  ...adapterBoundaryCoverageForgeReport.real_rocm_runtime_profile_adapter_result,
  adapterBoundaryCoverage: forgedAdapterBoundaryCoverage,
  adapter_boundary_coverage: forgedAdapterBoundaryCoverage,
};
adapterBoundaryCoverageForgeReport.runtime_proof_artifact.realRocmRuntimeProfileAdapterResult =
  adapterBoundaryCoverageForgeReport.real_rocm_runtime_profile_adapter_result;
adapterBoundaryCoverageForgeReport.runtime_proof_artifact.real_rocm_runtime_profile_adapter_result =
  adapterBoundaryCoverageForgeReport.real_rocm_runtime_profile_adapter_result;
await writeJson(
  path.join(adapterBoundaryCoverageForgeDir, 'real-rocm-adapter-boundary-coverage-forge.json'),
  adapterBoundaryCoverageForgeReport,
);
const adapterBoundaryCoverageForgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryCoverageForgeDir],
  generatedAt: '2026-06-29T00:00:02.266Z',
  includeUnproven: true,
});
const adapterBoundaryCoverageForgeRow = adapterBoundaryCoverageForgeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(adapterBoundaryCoverageForgeRow?.matrixOutcome, 'unproven');
assert.equal(adapterBoundaryCoverageForgeRow.acceptedForGpuHmr, false);
assert.equal(adapterBoundaryCoverageForgeRow.realRocmRuntimeProfileAdapterResult.accepted, false);
assert.ok(adapterBoundaryCoverageForgeRow.openGaps.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_adapter_boundary_coverage_claimed_gpu_hmr_acceptance',
));
assert.ok(adapterBoundaryCoverageForgeRow.openGaps.includes(
  'real_rocm_runtime_profile_adapter_result:real_rocm_runtime_adapter_boundary_coverage_claimed_runtime_authority',
));

const adapterBoundaryBridgeRocmDir = path.join(
  logsRoot,
  'real-rocm-adapter-boundary-bridge-missing-after-dispatch',
);
const adapterBoundaryBridgeScope = 'adapter-boundary-bridge-missing-after-dispatch';
const adapterBoundaryRawReadback = path.join(adapterBoundaryBridgeRocmDir, 'readback.bin');
const adapterBoundaryReadbackBytes = Buffer.from([2, 4, 6, 8, 10, 12, 14, 16]);
await fs.mkdir(adapterBoundaryBridgeRocmDir, { recursive: true });
await fs.writeFile(adapterBoundaryRawReadback, adapterBoundaryReadbackBytes);
await writeJson(`${adapterBoundaryRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: adapterBoundaryReadbackBytes.length,
  shape: [adapterBoundaryReadbackBytes.length],
});
await writeRgbaPng(`${adapterBoundaryRawReadback}.card.png`, 8, 8, (x, y) => [
  adapterBoundaryReadbackBytes[(x + y) % adapterBoundaryReadbackBytes.length],
  60 + x,
  120 + y,
  255,
]);
const adapterBoundaryMaterials = realRocmComputeProofLedgerMaterials(adapterBoundaryBridgeScope, {
  projectId: 'real-rocm-adapter-boundary-bridge-missing-after-dispatch',
  rawReadbackPath: adapterBoundaryRawReadback,
  rawReadbackBytes: adapterBoundaryReadbackBytes,
});
const adapterBoundaryAppHook = acceptedRealRocmAppHookContract(adapterBoundaryBridgeScope);
const adapterBoundaryAppHookMaterialization =
  acceptedRealRocmAppHookMaterialization(adapterBoundaryBridgeScope);
const adapterBoundarySameProcessOracle =
  acceptedSameProcessRuntimeOracle(adapterBoundaryBridgeScope);
const adapterBoundaryStageObligations =
  acceptedRealRocmRuntimeStageObligations(adapterBoundaryBridgeScope);
const adapterBoundarySidecar =
  acceptedRealRocmDeviceSidecarContract(adapterBoundaryBridgeScope, { required: true });
const adapterBoundarySidecarConsistency =
  acceptedRealRocmSidecarRuntimeConsistency(adapterBoundaryBridgeScope);
const adapterBoundaryRuntimeAdapterExecution =
  runtimeAdapterExecutionFixture(adapterBoundaryBridgeScope, adapterBoundaryMaterials);
const adapterBoundaryForgedRuntimeAdapterResultTransport =
  runtimeAdapterResultTransportFixture(adapterBoundaryBridgeScope, {
    acceptedForGpuHmr: true,
    accepted_for_gpu_hmr: true,
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
  });
const adapterBoundaryMismatchedLines =
  adapterBoundaryRuntimeAdapterExecution.runtimeBoundaryLines.map((line) =>
    line.replace(
      `after_dispatch_id=dispatch:${adapterBoundaryBridgeScope}`,
      'after_dispatch_id=dispatch:mismatched-adapter-output',
    )
  );
adapterBoundaryRuntimeAdapterExecution.runtimeBoundaryLines = adapterBoundaryMismatchedLines;
adapterBoundaryRuntimeAdapterExecution.runtime_boundary_lines = adapterBoundaryMismatchedLines;
adapterBoundaryRuntimeAdapterExecution.runtimeBoundaryLineCount = adapterBoundaryMismatchedLines.length;
adapterBoundaryRuntimeAdapterExecution.runtime_boundary_line_count =
  adapterBoundaryMismatchedLines.length;
adapterBoundaryRuntimeAdapterExecution.evidenceRefs = [
  `runtime-adapter-execution:${adapterBoundaryBridgeScope}`,
  ...adapterBoundaryMismatchedLines.map((line) => `runtime-adapter-boundary:${hashValue(line)}`),
];
adapterBoundaryRuntimeAdapterExecution.evidence_refs =
  adapterBoundaryRuntimeAdapterExecution.evidenceRefs;
await writeJson(
  path.join(adapterBoundaryBridgeRocmDir, 'real-rocm-adapter-boundary-bridge-missing-after-dispatch.json'),
  {
    slug: 'gpu-real-rocm-adapter-boundary-bridge-missing-after-dispatch-20260629',
    real_rocm_profile: largeRocmMlProfile('real-rocm-adapter-boundary-bridge-missing-after-dispatch'),
    source_url: 'https://example.invalid/rocm/adapter-boundary-bridge.git',
    repo_commit: 'adadadadadadadadadadadadadadadadadadadad',
    entry_file: 'src/kernels/generic_adapter_entry.hip',
    delta_file: 'src/kernels/generic_adapter_delta.h',
    target_name: 'GenericAdapterBoundaryBridgeDriver',
    gpu_vendor: 'rocm',
    full_runtime_proof_required: true,
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      sourceDerivedCandidateCount: 0,
      selectedSource: 'profile_runtime_profile',
      disabledReason: null,
      failedReason: null,
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    target_progression: {
      schemaVersion: 'synthi.real_rocm.target_progression.v1',
      required: true,
      phaseRaw: 'final-acceptance',
      phase: 'final-acceptance',
      recognized: true,
      reason: null,
      targetName: 'GenericAdapterBoundaryBridgeDriver',
      finalAcceptanceTarget: 'GenericAdapterBoundaryBridgeDriver',
      finalAcceptanceTargetDeclared: true,
      targetMatchesFinalAcceptance: true,
    },
    target_progression_ledger: {
      schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
      provided: true,
      entries: [
        {
          phase: 'small-oracle',
          status: 'pass',
          resultState: 'gpu-hmr-output-oracle-proven',
          outputOracleProven: true,
          proofId: 'adapter-boundary-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
          compute_oracle_artifacts: adapterBoundaryMaterials.computeOracleArtifacts,
        },
        {
          phase: 'partial-reload',
          status: 'pass',
          proofId: 'adapter-boundary-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
          partialReloadProven: true,
          fissionProven: true,
        },
        {
          phase: 'original-host-path',
          status: 'pass',
          proofId: 'adapter-boundary-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
          originalHostPathProven: true,
          attachmentProven: true,
          hostPreservationProven: true,
          dispatchSafeProven: true,
        },
      ],
    },
    target_progression_gates: [
      { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
    ],
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    real_rocm_profile_proof_obligations:
      acceptedLargeRocmProfileObligations('real-rocm-adapter-boundary-bridge-missing-after-dispatch'),
    real_rocm_source_delta_execution:
      acceptedLargeRocmSourceDeltaExecution('real-rocm-adapter-boundary-bridge-missing-after-dispatch'),
    real_rocm_app_hook_contract: adapterBoundaryAppHook,
    real_rocm_app_hook_materialization: adapterBoundaryAppHookMaterialization,
    real_rocm_same_process_runtime_oracle: adapterBoundarySameProcessOracle,
    real_rocm_runtime_stage_obligations: adapterBoundaryStageObligations,
    real_rocm_device_sidecar_contract: adapterBoundarySidecar,
    real_rocm_sidecar_runtime_consistency: adapterBoundarySidecarConsistency,
    real_rocm_runtime_adapter_execution: adapterBoundaryRuntimeAdapterExecution,
    real_rocm_runtime_adapter_result_transport:
      adapterBoundaryForgedRuntimeAdapterResultTransport,
    ...adapterBoundaryMaterials,
    runtime_proof_artifact: {
      ...adapterBoundaryMaterials.runtime_proof_artifact,
      realRocmAppHookContract: adapterBoundaryAppHook,
      real_rocm_app_hook_contract: adapterBoundaryAppHook,
      realRocmAppHookMaterialization: adapterBoundaryAppHookMaterialization,
      real_rocm_app_hook_materialization: adapterBoundaryAppHookMaterialization,
      realRocmSameProcessRuntimeOracle: adapterBoundarySameProcessOracle,
      real_rocm_same_process_runtime_oracle: adapterBoundarySameProcessOracle,
      realRocmRuntimeStageObligations: adapterBoundaryStageObligations,
      real_rocm_runtime_stage_obligations: adapterBoundaryStageObligations,
      realRocmDeviceSidecarContract: adapterBoundarySidecar,
      real_rocm_device_sidecar_contract: adapterBoundarySidecar,
      realRocmSidecarRuntimeConsistency: adapterBoundarySidecarConsistency,
      real_rocm_sidecar_runtime_consistency: adapterBoundarySidecarConsistency,
      realRocmRuntimeAdapterExecution: adapterBoundaryRuntimeAdapterExecution,
      real_rocm_runtime_adapter_execution: adapterBoundaryRuntimeAdapterExecution,
      realRocmRuntimeAdapterResultTransport:
        adapterBoundaryForgedRuntimeAdapterResultTransport,
      real_rocm_runtime_adapter_result_transport:
        adapterBoundaryForgedRuntimeAdapterResultTransport,
    },
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: 'real-rocm-adapter-boundary-bridge-missing-after-dispatch-delta',
      editHash: hashValue('real-rocm-adapter-boundary-bridge-missing-after-dispatch-delta'),
    },
    checks: [
      { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/adapter-boundary-bridge.git @ adadadad files=32000' },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  },
);
const adapterBoundaryBridgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [adapterBoundaryBridgeRocmDir],
  generatedAt: '2026-06-29T00:00:02.265Z',
  includeUnproven: true,
});
const adapterBoundaryBridgeRow = adapterBoundaryBridgeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(adapterBoundaryBridgeRow?.matrixOutcome, 'unproven');
assert.equal(adapterBoundaryBridgeRow.acceptedForGpuHmr, false);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeProfileAdapterResult.present, false);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.accepted, true);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.acceptedForGpuHmr, false);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeAdapterExecution.gpuHmrSuccess, false);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.accepted, false);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.acceptedForGpuHmr, true);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeAdapterResultTransport.gpuHmrSuccess, true);
assert.ok(adapterBoundaryBridgeRow.reasons.includes(
  'real_rocm_runtime_adapter_result_transport:real_rocm_runtime_adapter_result_transport_claimed_gpu_hmr_acceptance',
));
assert.ok(adapterBoundaryBridgeRow.reasons.includes(
  'real_rocm_runtime_adapter_result_transport:real_rocm_runtime_adapter_result_transport_claimed_gpu_hmr_success',
));
assert.ok(adapterBoundaryBridgeRow.reasons.includes(
  'real_rocm_runtime_adapter_result_transport:real_rocm_runtime_adapter_result_transport_claimed_runtime_authority',
));
assert.ok(adapterBoundaryBridgeRow.reasons.includes(
  'real_rocm_runtime_adapter_result_transport:real_rocm_runtime_adapter_result_transport_claimed_dispatch_authority',
));
assert.ok(adapterBoundaryBridgeRow.openGaps.includes(
  'real_rocm_runtime_adapter_result_transport_required',
));
assert.equal(adapterBoundaryBridgeRow.realRocmAppHookContractGate.accepted, true);
assert.equal(adapterBoundaryBridgeRow.realRocmAppHookMaterializationGate.accepted, true);
assert.equal(adapterBoundaryBridgeRow.realRocmSameProcessRuntimeOracleGate.accepted, false);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeStageObligations.accepted, true);
assert.equal(adapterBoundaryBridgeRow.realRocmDeviceSidecarContract.canSatisfyRuntimeProof, true);
assert.deepEqual(adapterBoundaryBridgeRow.realRocmDeviceSidecarContract.blockingGaps, []);
assert.equal(adapterBoundaryBridgeRow.realRocmSidecarRuntimeConsistency.accepted, true);
assert.equal(adapterBoundaryBridgeRow.ledger.gpuHmrSuccess, true);
assert.deepEqual(adapterBoundaryBridgeRow.ledger.failedInvariants, []);
for (const clearedGap of [
  'app_hook_artifact_transport_runtime_not_observed',
  'app_hook_epoch_publication_runtime_not_observed',
  'app_hook_dispatch_trace_runtime_not_observed',
  'app_hook_host_identity_runtime_not_observed',
  'app_hook_output_oracle_runtime_not_observed',
  'device_sidecar_artifact_transport_runtime_not_observed',
  'device_sidecar_epoch_publication_runtime_not_observed',
  'device_sidecar_dispatch_trace_runtime_not_observed',
  'device_sidecar_host_identity_runtime_not_observed',
  'device_sidecar_output_oracle_runtime_not_observed',
  'runtime_stage_obligation_output_oracle_after_dispatch_id_missing',
]) {
  assert.ok(
    !adapterBoundaryBridgeRow.openGaps.includes(clearedGap)
      && !adapterBoundaryBridgeRow.reasons.includes(clearedGap),
    `adapter boundary bridge fixture should clear ${clearedGap}`,
  );
}
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeChain.accepted, false);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeChain.adapterBoundaryOverlayAccepted, true);
assert.equal(adapterBoundaryBridgeRow.realRocmRuntimeChain.adapterBoundaryOverlayLineCount, 10);
assert.deepEqual(
  adapterBoundaryBridgeRow.realRocmRuntimeChain.adapterBoundaryOverlaySources,
  ['runtime_adapter_execution'],
);
assert.ok(adapterBoundaryBridgeRow.openGaps.includes('real_rocm_runtime_chain_required'));
assert.ok(adapterBoundaryBridgeRow.openGaps.includes('real_rocm_same_process_runtime_oracle_required'));
assert.ok(adapterBoundaryBridgeRow.reasons.includes(
  'real_rocm_runtime_chain_adapter_output_dispatch_mismatch',
));

const forgedMissingUnflaggedResolutionRocmDir = path.join(
  logsRoot,
  'real-rocm-forged-missing-unflagged-resolution',
);
const forgedMissingUnflaggedResolutionProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-missing-unflagged-resolution',
  {
    projectId: 'real-rocm-forged-missing-unflagged-resolution',
    rawReadbackPath: acceptedComputeRawReadback,
    rawReadbackBytes: acceptedComputeBytes,
  },
);
await writeJson(
  path.join(forgedMissingUnflaggedResolutionRocmDir, 'real-rocm-forged-missing-unflagged-resolution.json'),
  {
    slug: 'gpu-real-rocm-forged-missing-unflagged-resolution-20260623',
    real_rocm_profile: { id: 'real-rocm-forged-missing-unflagged-resolution' },
    source_url: 'https://example.invalid/rocm/forged-missing-unflagged-resolution.git',
    repo_commit: 'bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
    entry_file: 'src/kernels/compute_entry.hip',
    delta_file: 'src/kernels/compute_delta.h',
    target_name: 'ForgedMissingUnflaggedResolutionDriver',
    gpu_vendor: 'rocm',
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    ...forgedMissingUnflaggedResolutionProofMaterials,
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: 'real-rocm-forged-missing-unflagged-resolution-delta',
      editHash: hashValue('real-rocm-forged-missing-unflagged-resolution-delta'),
    },
    checks: [
      {
        name: 'real ROCm repo',
        status: 'pass',
        detail: 'https://example.invalid/rocm/forged-missing-unflagged-resolution.git @ bcbcbcbc files=18000',
      },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  },
);
const forgedMissingUnflaggedResolutionRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingUnflaggedResolutionRocmDir],
  generatedAt: '2026-06-09T00:00:02.260Z',
  includeUnproven: true,
});
const forgedMissingUnflaggedResolutionRocm = forgedMissingUnflaggedResolutionRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingUnflaggedResolutionRocm?.matrixOutcome, 'unproven');
assert.equal(forgedMissingUnflaggedResolutionRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingUnflaggedResolutionRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.outputOracleFacet.accepted, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.outputOracleResolutionGate.required, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.outputOracleResolutionGate.accepted, false);
assert.ok(forgedMissingUnflaggedResolutionRocm.reasons.includes(
  'real_rocm_output_oracle_resolution_missing',
));
assert.ok(forgedMissingUnflaggedResolutionRocm.openGaps.includes(
  'real_rocm_output_oracle_resolution_required',
));

const forgedMissingResolutionRocmDir = path.join(logsRoot, 'real-rocm-forged-missing-resolution');
const forgedMissingResolutionProofMaterials = realRocmComputeProofLedgerMaterials('forged-missing-resolution', {
  projectId: 'real-rocm-forged-missing-resolution',
  rawReadbackPath: acceptedComputeRawReadback,
  rawReadbackBytes: acceptedComputeBytes,
});
await writeJson(path.join(forgedMissingResolutionRocmDir, 'real-rocm-forged-missing-resolution.json'), {
  slug: 'gpu-real-rocm-forged-missing-resolution-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-missing-resolution' },
  source_url: 'https://example.invalid/rocm/forged-missing-resolution.git',
  repo_commit: 'abababababababababababababababababababab',
  entry_file: 'src/kernels/missing_resolution_entry.hip',
  delta_file: 'src/kernels/missing_resolution_delta.h',
  target_name: 'ForgedMissingResolutionDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedMissingResolutionProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-missing-resolution-delta',
    editHash: hashValue('real-rocm-forged-missing-resolution-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-missing-resolution.git @ abababab files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedMissingResolutionRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingResolutionRocmDir],
  generatedAt: '2026-06-09T00:00:02.260Z',
  includeUnproven: true,
});
const forgedMissingResolutionRocm = forgedMissingResolutionRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingResolutionRocm?.matrixOutcome, 'unproven');
assert.equal(forgedMissingResolutionRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingResolutionRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingResolutionRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingResolutionRocm.outputOracleFacet.accepted, true);
assert.equal(forgedMissingResolutionRocm.outputOracleResolutionGate.accepted, false);
assert.ok(forgedMissingResolutionRocm.reasons.includes('real_rocm_output_oracle_resolution_missing'));
assert.ok(forgedMissingResolutionRocm.reasons.includes('real_rocm_output_oracle_resolution_not_accepted'));
assert.ok(forgedMissingResolutionRocm.openGaps.includes('real_rocm_output_oracle_resolution_required'));

const forgedFinalNoOracleRocmDir = path.join(logsRoot, 'real-rocm-forged-final-no-oracle');
const forgedFinalNoOracleRawReadback = path.join(forgedFinalNoOracleRocmDir, 'readback.bin');
const forgedFinalNoOracleBytes = Buffer.from([13, 21, 34, 55, 89, 144, 233, 1]);
await fs.mkdir(forgedFinalNoOracleRocmDir, { recursive: true });
await fs.writeFile(forgedFinalNoOracleRawReadback, forgedFinalNoOracleBytes);
await writeJson(`${forgedFinalNoOracleRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedFinalNoOracleBytes.length,
  shape: [forgedFinalNoOracleBytes.length],
});
await writeRgbaPng(`${forgedFinalNoOracleRawReadback}.card.png`, 8, 8, (x, y) => [
  forgedFinalNoOracleBytes[(x + y) % forgedFinalNoOracleBytes.length],
  70 + x,
  90 + y,
  255,
]);
const forgedFinalNoOracleProofMaterials = realRocmComputeProofLedgerMaterials('forged-final-no-oracle', {
  projectId: 'real-rocm-forged-final-no-oracle',
  rawReadbackPath: forgedFinalNoOracleRawReadback,
  rawReadbackBytes: forgedFinalNoOracleBytes,
});
await writeJson(path.join(forgedFinalNoOracleRocmDir, 'real-rocm-forged-final-no-oracle.json'), {
  slug: 'gpu-real-rocm-forged-final-no-oracle-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-final-no-oracle' },
  source_url: 'https://example.invalid/rocm/forged-final-no-oracle.git',
  repo_commit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  entry_file: 'src/kernels/final_entry.hip',
  delta_file: 'src/kernels/final_delta.h',
  target_name: 'ForgedFinalDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'none',
    mode: 'none',
    selectedSource: 'none',
    disabledReason: 'profile_disabled',
    failedReason: null,
    contractPresent: false,
    runtimeProfilePresent: false,
    runtimeProfileSynced: false,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalDriver',
    finalAcceptanceTarget: 'ForgedFinalDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations.v1',
    status: 'profile_proof_obligations_met',
    requiresFullRuntimeProof: true,
    requires_full_runtime_proof: true,
    blockingGaps: [],
    blocking_gaps: [],
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalNoOracleProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-no-oracle-delta',
    editHash: hashValue('real-rocm-forged-final-no-oracle-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-final-no-oracle.git @ eeeeeeee files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedFinalNoOracleRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalNoOracleRocmDir],
  generatedAt: '2026-06-09T00:00:02.275Z',
  includeUnproven: true,
});
const forgedFinalNoOracleRocm = forgedFinalNoOracleRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalNoOracleRocm?.matrixOutcome, 'unproven');
assert.notEqual(forgedFinalNoOracleRocm.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedFinalNoOracleRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalNoOracleRocm.targetProgressionEvidence, false);
assert.equal(forgedFinalNoOracleRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedFinalNoOracleRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedFinalNoOracleRocm.outputOracleFacet.accepted, true);
assert.equal(forgedFinalNoOracleRocm.outputOracleResolutionGate.accepted, false);
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_profile_disabled'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_contract_missing'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_runtime_profile_missing'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_runtime_profile_not_synced'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_source_missing'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_resolution_not_accepted'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_raw_profile_declaration_missing',
));
assert.ok(forgedFinalNoOracleRocm.openGaps.includes('real_rocm_output_oracle_resolution_required'));
assert.ok(forgedFinalNoOracleRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_raw_profile_declaration_missing',
));

const forgedMissingRequiredHookRocmDir = path.join(logsRoot, 'real-rocm-forged-missing-required-hook');
const forgedMissingRequiredHookRawReadback = path.join(forgedMissingRequiredHookRocmDir, 'readback.bin');
const forgedMissingRequiredHookBytes = Buffer.from([3, 6, 9, 12, 15, 18, 21, 24]);
await fs.mkdir(forgedMissingRequiredHookRocmDir, { recursive: true });
await fs.writeFile(forgedMissingRequiredHookRawReadback, forgedMissingRequiredHookBytes);
await writeJson(`${forgedMissingRequiredHookRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedMissingRequiredHookBytes.length,
  shape: [forgedMissingRequiredHookBytes.length],
});
await writeRgbaPng(`${forgedMissingRequiredHookRawReadback}.card.png`, 8, 8, (x, y) => [
  forgedMissingRequiredHookBytes[(x + y) % forgedMissingRequiredHookBytes.length],
  88 + x,
  104 + y,
  255,
]);
const forgedMissingRequiredHookProofMaterials = realRocmComputeProofLedgerMaterials('forged-missing-required-hook', {
  projectId: 'real-rocm-forged-missing-required-hook',
  rawReadbackPath: forgedMissingRequiredHookRawReadback,
  rawReadbackBytes: forgedMissingRequiredHookBytes,
});
await writeJson(path.join(forgedMissingRequiredHookRocmDir, 'real-rocm-forged-missing-required-hook.json'), {
  slug: 'gpu-real-rocm-forged-missing-required-hook-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-missing-required-hook' },
  source_url: 'https://example.invalid/rocm/forged-missing-required-hook.git',
  repo_commit: 'dddddddddddddddddddddddddddddddddddddddd',
  entry_file: 'src/kernels/required_hook_entry.hip',
  delta_file: 'src/kernels/required_hook_delta.h',
  target_name: 'ForgedMissingRequiredHookDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations.v1',
    status: 'profile_proof_obligations_met',
    requiresAppHookContract: true,
    requires_app_hook_contract: true,
    blockingGaps: [],
    blocking_gaps: [],
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedMissingRequiredHookProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-missing-required-hook-delta',
    editHash: hashValue('real-rocm-forged-missing-required-hook-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-missing-required-hook.git @ dddddddd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedMissingRequiredHookRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingRequiredHookRocmDir],
  generatedAt: '2026-06-09T00:00:02.300Z',
  includeUnproven: true,
});
const forgedMissingRequiredHookRocm = forgedMissingRequiredHookRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingRequiredHookRocm?.matrixOutcome, 'unproven');
assert.equal(forgedMissingRequiredHookRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingRequiredHookRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingRequiredHookRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingRequiredHookRocm.outputOracleFacet.accepted, true);
assert.equal(forgedMissingRequiredHookRocm.realRocmAppHookContractGate.required, true);
assert.equal(forgedMissingRequiredHookRocm.realRocmAppHookContractGate.missing, true);
assert.ok(forgedMissingRequiredHookRocm.reasons.includes('real_rocm_app_hook_contract_required_not_proven'));
assert.ok(forgedMissingRequiredHookRocm.reasons.includes('real_rocm_app_hook_contract_missing'));
assert.ok(forgedMissingRequiredHookRocm.openGaps.includes('real_rocm_app_hook_contract_required'));
assert.ok(forgedMissingRequiredHookRocm.openGaps.includes('real_rocm_app_hook_contract_missing'));

const forgedImplicitLargeMlHookRocmDir =
  path.join(logsRoot, 'real-rocm-forged-implicit-large-ml-hook');
const forgedImplicitLargeMlHookRawReadback =
  path.join(forgedImplicitLargeMlHookRocmDir, 'readback.bin');
const forgedImplicitLargeMlHookBytes = Buffer.from([8, 13, 21, 34, 55, 89, 144, 233]);
await fs.mkdir(forgedImplicitLargeMlHookRocmDir, { recursive: true });
await fs.writeFile(forgedImplicitLargeMlHookRawReadback, forgedImplicitLargeMlHookBytes);
await writeJson(`${forgedImplicitLargeMlHookRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedImplicitLargeMlHookBytes.length,
  shape: [forgedImplicitLargeMlHookBytes.length],
});
await writeRgbaPng(`${forgedImplicitLargeMlHookRawReadback}.card.png`, 8, 8, (x, y) => [
  forgedImplicitLargeMlHookBytes[(x + y) % forgedImplicitLargeMlHookBytes.length],
  96 + x,
  112 + y,
  255,
]);
const forgedImplicitLargeMlHookProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-implicit-large-ml-hook',
  {
    projectId: 'real-rocm-forged-implicit-large-ml-hook',
    rawReadbackPath: forgedImplicitLargeMlHookRawReadback,
    rawReadbackBytes: forgedImplicitLargeMlHookBytes,
  },
);
await writeJson(
  path.join(forgedImplicitLargeMlHookRocmDir, 'real-rocm-forged-implicit-large-ml-hook.json'),
  {
    slug: 'gpu-real-rocm-forged-implicit-large-ml-hook-20260626',
    real_rocm_profile: largeRocmMlProfileWithImplicitAppHook(
      'real-rocm-forged-implicit-large-ml-hook',
    ),
    source_url: 'https://example.invalid/rocm/forged-implicit-large-ml-hook.git',
    repo_commit: 'ffffffffffffffffffffffffffffffffffffffff',
    entry_file: 'src/kernels/implicit_large_ml_entry.hip',
    delta_file: 'src/kernels/implicit_large_ml_delta.h',
    target_name: 'ForgedImplicitLargeMlHookDriver',
    gpu_vendor: 'rocm',
    full_runtime_proof_required: true,
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      sourceDerivedCandidateCount: 0,
      selectedSource: 'profile_runtime_profile',
      disabledReason: null,
      failedReason: null,
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    target_progression: {
      schemaVersion: 'synthi.real_rocm.target_progression.v1',
      required: true,
      phaseRaw: 'final-acceptance',
      phase: 'final-acceptance',
      recognized: true,
      reason: null,
      targetName: 'ForgedImplicitLargeMlHookDriver',
      finalAcceptanceTarget: 'ForgedImplicitLargeMlHookDriver',
      finalAcceptanceTargetDeclared: true,
      targetMatchesFinalAcceptance: true,
    },
    target_progression_ledger: {
      schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
      provided: true,
      entries: [
        {
          phase: 'small-oracle',
          status: 'pass',
          resultState: 'gpu-hmr-output-oracle-proven',
          outputOracleProven: true,
          proofId: 'implicit-large-ml-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
          compute_oracle_artifacts: forgedImplicitLargeMlHookProofMaterials.computeOracleArtifacts,
        },
        {
          phase: 'partial-reload',
          status: 'pass',
          proofId: 'implicit-large-ml-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
          partialReloadProven: true,
          fissionProven: true,
        },
        {
          phase: 'original-host-path',
          status: 'pass',
          proofId: 'implicit-large-ml-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
          originalHostPathProven: true,
          attachmentProven: true,
          hostPreservationProven: true,
          dispatchSafeProven: true,
        },
      ],
    },
    target_progression_gates: [
      { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
    ],
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    real_rocm_source_delta_execution:
      acceptedLargeRocmSourceDeltaExecution('real-rocm-forged-implicit-large-ml-hook'),
    runtime_proof_artifact: {
      ...forgedImplicitLargeMlHookProofMaterials.runtime_proof_artifact,
      realRocmSourceDeltaExecution:
        acceptedLargeRocmSourceDeltaExecution('real-rocm-forged-implicit-large-ml-hook'),
      real_rocm_source_delta_execution:
        acceptedLargeRocmSourceDeltaExecution('real-rocm-forged-implicit-large-ml-hook'),
    },
    proof_ledger: forgedImplicitLargeMlHookProofMaterials.proof_ledger,
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: 'real-rocm-forged-implicit-large-ml-hook-delta',
      editHash: hashValue('real-rocm-forged-implicit-large-ml-hook-delta'),
    },
    checks: [
      {
        name: 'real ROCm repo',
        status: 'pass',
        detail: 'https://example.invalid/rocm/forged-implicit-large-ml-hook.git @ ffffffff files=18000',
      },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  },
);
const forgedImplicitLargeMlHookRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedImplicitLargeMlHookRocmDir],
  generatedAt: '2026-06-09T00:00:02.301Z',
  includeUnproven: true,
});
const forgedImplicitLargeMlHookRocm = forgedImplicitLargeMlHookRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedImplicitLargeMlHookRocm?.matrixOutcome, 'unproven');
assert.equal(forgedImplicitLargeMlHookRocm.acceptedForGpuHmr, false);
assert.equal(forgedImplicitLargeMlHookRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedImplicitLargeMlHookRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedImplicitLargeMlHookRocm.outputOracleFacet.accepted, true);
assert.equal(
  forgedImplicitLargeMlHookRocm.realRocmProfileProofObligations.largeMlFinalAcceptance,
  true,
);
assert.equal(
  forgedImplicitLargeMlHookRocm.realRocmProfileProofObligations.requiresAppHookContract,
  true,
);
assert.equal(forgedImplicitLargeMlHookRocm.realRocmAppHookContractGate.required, true);
assert.equal(forgedImplicitLargeMlHookRocm.realRocmAppHookContractGate.missing, true);
assert.ok(forgedImplicitLargeMlHookRocm.reasons.includes(
  'real_rocm_app_hook_contract_required_not_proven',
));
assert.ok(forgedImplicitLargeMlHookRocm.openGaps.includes('real_rocm_app_hook_contract_required'));
assert.ok(forgedImplicitLargeMlHookRocm.openGaps.includes('real_rocm_app_hook_contract_missing'));

const forgedTargetProgressionRocmDir = path.join(logsRoot, 'real-rocm-forged-target-progression-failure');
const forgedTargetProgressionRawReadback = path.join(forgedTargetProgressionRocmDir, 'readback.bin');
const forgedTargetProgressionBytes = Buffer.from([5, 10, 15, 20, 25, 30, 35, 40]);
await fs.mkdir(forgedTargetProgressionRocmDir, { recursive: true });
await fs.writeFile(forgedTargetProgressionRawReadback, forgedTargetProgressionBytes);
await writeJson(`${forgedTargetProgressionRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedTargetProgressionBytes.length,
  shape: [forgedTargetProgressionBytes.length],
});
await writeRgbaPng(`${forgedTargetProgressionRawReadback}.card.png`, 8, 8, (x, y) => [
  forgedTargetProgressionBytes[(x + y) % forgedTargetProgressionBytes.length],
  72 + x,
  96 + y,
  255,
]);
const forgedTargetProgressionProofMaterials = realRocmComputeProofLedgerMaterials('forged-target-progression-failure', {
  projectId: 'real-rocm-forged-target-progression-failure',
  rawReadbackPath: forgedTargetProgressionRawReadback,
  rawReadbackBytes: forgedTargetProgressionBytes,
});
await writeJson(path.join(forgedTargetProgressionRocmDir, 'real-rocm-forged-target-progression-failure.json'), {
  slug: 'gpu-real-rocm-forged-target-progression-failure-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-target-progression-failure' },
  source_url: 'https://example.invalid/rocm/forged-target-progression.git',
  repo_commit: 'cccccccccccccccccccccccccccccccccccccccc',
  entry_file: 'src/kernels/progression_entry.hip',
  delta_file: 'src/kernels/progression_delta.h',
  target_name: 'ForgedProgressionDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  target_progression_gates: [
    {
      name: 'target progression prior partial-reload',
      status: 'fail',
      detail: 'prior phase partial-reload proof missing from target progression ledger',
    },
  ],
  ...forgedTargetProgressionProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-target-progression-failure-delta',
    editHash: hashValue('real-rocm-forged-target-progression-failure-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-target-progression.git @ cccccccc files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedTargetProgressionRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedTargetProgressionRocmDir],
  generatedAt: '2026-06-09T00:00:02.375Z',
  includeUnproven: true,
});
const forgedTargetProgressionRocm = forgedTargetProgressionRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedTargetProgressionRocm?.matrixOutcome, 'unproven');
assert.equal(forgedTargetProgressionRocm.acceptedForGpuHmr, false);
assert.equal(forgedTargetProgressionRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedTargetProgressionRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedTargetProgressionRocm.outputOracleFacet.accepted, true);
assert.ok(forgedTargetProgressionRocm.reasons.includes(
  'target_progression_gate_failed:target progression prior partial-reload',
));
assert.ok(forgedTargetProgressionRocm.openGaps.includes('target_progression_gates_failed'));

const forgedVisualPriorRocmDir = path.join(logsRoot, 'real-rocm-forged-visual-prior-hash');
const forgedVisualPriorBefore = path.join(forgedVisualPriorRocmDir, 'prior-before.png');
const forgedVisualPriorAfter = path.join(forgedVisualPriorRocmDir, 'prior-after.png');
const forgedVisualPriorDiff = path.join(forgedVisualPriorRocmDir, 'prior-diff.png');
const forgedVisualPriorReadback = path.join(forgedVisualPriorRocmDir, 'readback.bin');
const forgedVisualPriorBytes = Buffer.from([7, 14, 21, 28, 35, 42, 49, 56]);
await writeRgbaPng(forgedVisualPriorBefore, 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(forgedVisualPriorAfter, 8, 8, (x, y) => [72 + x, 88 + y, 120, 255]);
await writeRgbaPng(forgedVisualPriorDiff, 8, 8, () => [255, 255, 255, 255]);
await fs.writeFile(forgedVisualPriorReadback, forgedVisualPriorBytes);
await writeJson(`${forgedVisualPriorReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedVisualPriorBytes.length,
  shape: [forgedVisualPriorBytes.length],
});
await writeRgbaPng(`${forgedVisualPriorReadback}.card.png`, 8, 8, (x, y) => [
  forgedVisualPriorBytes[(x + y) % forgedVisualPriorBytes.length],
  80 + x,
  120 + y,
  255,
]);
const forgedVisualPriorProofMaterials = realRocmComputeProofLedgerMaterials('forged-visual-prior-hash', {
  projectId: 'real-rocm-forged-visual-prior-hash',
  rawReadbackPath: forgedVisualPriorReadback,
  rawReadbackBytes: forgedVisualPriorBytes,
});
await writeJson(path.join(forgedVisualPriorRocmDir, 'real-rocm-forged-visual-prior-hash.json'), {
  slug: 'gpu-real-rocm-forged-visual-prior-hash-20260625',
  real_rocm_profile: { id: 'real-rocm-forged-visual-prior-hash' },
  source_url: 'https://example.invalid/rocm/forged-visual-prior.git',
  repo_commit: 'dddddddddddddddddddddddddddddddddddddddd',
  entry_file: 'src/kernels/visual_prior_entry.hip',
  delta_file: 'src/kernels/visual_prior_delta.h',
  target_name: 'ForgedVisualPriorDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedVisualPriorDriver',
    finalAcceptanceTarget: 'ForgedVisualPriorDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_ledger: {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
    provided: true,
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        resultState: 'gpu-hmr-output-oracle-proven',
        outputOracleProven: true,
        proofId: 'visual-prior-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        schemaVersion: 'synthi.gpu_hmr.visual_prior_oracle.v1',
        visualEvidenceArtifacts: [
          { role: 'before', path: forgedVisualPriorBefore, contentHash: hashValue('wrong-prior-before') },
          { role: 'after', path: forgedVisualPriorAfter, contentHash: hashValue('wrong-prior-after') },
          { role: 'diff', path: forgedVisualPriorDiff, contentHash: hashValue('wrong-prior-diff') },
        ],
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'visual-prior-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'visual-prior-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
        originalHostPathProven: true,
        attachmentProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedVisualPriorProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-visual-prior-hash-delta',
    editHash: hashValue('real-rocm-forged-visual-prior-hash-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-visual-prior.git @ dddddddd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedVisualPriorRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedVisualPriorRocmDir],
  generatedAt: '2026-06-25T00:00:02.450Z',
  includeUnproven: true,
});
const forgedVisualPriorRocm = forgedVisualPriorRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
const forgedVisualPriorSmallOracleGate = forgedVisualPriorRocm?.targetProgressionGates.find(
  (gate) => gate.name === 'target progression prior small-oracle',
);
assert.equal(forgedVisualPriorRocm?.matrixOutcome, 'unproven');
assert.equal(forgedVisualPriorRocm.acceptedForGpuHmr, false);
assert.equal(forgedVisualPriorSmallOracleGate?.status, 'fail');
assert.match(forgedVisualPriorSmallOracleGate?.detail ?? '', /visual_artifact_hash_mismatch/);
assert.ok(forgedVisualPriorRocm.reasons.includes(
  'target_progression_gate_failed:target progression prior small-oracle',
));
assert.ok(forgedVisualPriorRocm.openGaps.includes('target_progression_gates_failed'));

const forgedComputeRocmDir = path.join(logsRoot, 'real-rocm-forged-compute-missing-raw');
const forgedComputeRawReadback = path.join(forgedComputeRocmDir, 'missing-readback.bin');
const forgedComputeProofMaterials = realRocmComputeProofLedgerMaterials('forged-compute-missing-raw', {
  projectId: 'real-rocm-forged-compute-missing-raw',
  rawReadbackPath: forgedComputeRawReadback,
});
await writeJson(path.join(forgedComputeRocmDir, 'real-rocm-forged-compute-missing-raw.json'), {
  slug: 'gpu-real-rocm-forged-compute-missing-raw-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-compute-missing-raw' },
  source_url: 'https://example.invalid/rocm/forged-compute.git',
  repo_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'ForgedComputeDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedComputeProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-compute-missing-raw-delta',
    editHash: hashValue('real-rocm-forged-compute-missing-raw-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-compute.git @ aaaaaaaa files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedComputeRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedComputeRocmDir],
  generatedAt: '2026-06-09T00:00:02.500Z',
  includeUnproven: true,
});
const forgedComputeRocm = forgedComputeRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedComputeRocm?.matrixOutcome, 'unproven');
assert.equal(forgedComputeRocm.acceptedForGpuHmr, false);
assert.equal(forgedComputeRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedComputeRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedComputeRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(forgedComputeRocm.outputOracleFacet.accepted, false);
assert.equal(forgedComputeRocm.outputOracleFacet.compute.present, true);
assert.equal(forgedComputeRocm.outputOracleFacet.compute.rawReadbackHashVerified, false);
assert.equal(forgedComputeRocm.outputOracleFacet.compute.deterministicSliceHashVerified, false);
assert.ok(forgedComputeRocm.outputOracleFacet.compute.rawReadbackReadError);
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_raw_readback_hash_unverified'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_raw_readback_bytes_missing'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_deterministic_slice_hash_unverified'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_raw_readback_unreadable'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_readback_schema_bytes_missing'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_readback_schema_unreadable'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_rendered_card_decode_failed'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_rendered_card_not_png'));
assert.ok(forgedComputeRocm.reasons.includes('output_or_visual_oracle_proof_missing'));

const forgedRealRocmDir = path.join(logsRoot, 'real-rocm-forged-no-oracle');
await writeJson(path.join(forgedRealRocmDir, 'real-rocm-forged-no-oracle.json'), {
  slug: 'gpu-real-rocm-forged-no-oracle-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-no-oracle' },
  source_url: 'https://example.invalid/rocm/forged-lib.git',
  repo_commit: 'fedcba9876543210fedcba9876543210fedcba98',
  entry_file: 'src/kernels/forged_entry.hip',
  delta_file: 'src/kernels/forged_delta.h',
  target_name: 'ForgedRocmDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-no-oracle',
    visualRoot: forgedRealRocmDir,
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-no-oracle-delta',
    editHash: hashValue('real-rocm-forged-no-oracle-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-lib.git @ fedcba987654 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedRealRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRealRocmDir],
  generatedAt: '2026-06-09T00:00:03.000Z',
  includeUnproven: true,
});
const forgedRealRocm = forgedRealRocmLedger.rows.find((row) => row.proofMode === 'real_rocm_repo_validation');
assert.equal(forgedRealRocm?.matrixOutcome, 'unproven');
assert.equal(forgedRealRocm.acceptedForGpuHmr, false);
assert.equal(forgedRealRocm.runtimeProofArtifact.accepted, false);
assert.ok(forgedRealRocm.runtimeProofArtifact.failedGates.some(
  (gate) => gate.code === 'visual_oracle_before_image_bytes_unreadable',
));
assert.equal(forgedRealRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedRealRocm.visual.present, false);
assert.ok(forgedRealRocm.reasons.includes('output_or_visual_oracle_proof_missing'));

const realRocmCompletenessDir = path.join(logsRoot, 'real-rocm-completeness-selection');
const olderCompleteRefusalPath = path.join(realRocmCompletenessDir, 'real-rocm-complete-refusal.json');
const newerWeakRefusalPath = path.join(realRocmCompletenessDir, 'real-rocm-weak-refusal.json');
const completenessBaseArtifact = {
  real_rocm_profile: { id: 'real-rocm-completeness-selection' },
  source_url: 'https://example.invalid/rocm/completeness.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/completeness_entry.hip',
  delta_file: 'src/kernels/completeness_delta.h',
  target_name: 'CompletenessDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  strict_proof_gates: {
    accepted: false,
    failures: ['runtime_full_proof_not_proven'],
  },
  checks: [
    {
      name: 'strict real ROCm runtime proof artifact acceptance',
      status: 'fail',
      detail: 'failures=runtime_full_proof_not_proven',
    },
  ],
};
await writeJson(olderCompleteRefusalPath, {
  ...completenessBaseArtifact,
  slug: 'gpu-real-rocm-completeness-selection-older-complete',
  upstream_lifecycle_failure: {
    schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    accepted_as_refusal_evidence: true,
    reasons: ['cmake_configure_failed'],
  },
});
await writeJson(newerWeakRefusalPath, {
  ...completenessBaseArtifact,
  slug: 'gpu-real-rocm-completeness-selection-newer-weak',
});
await fs.utimes(olderCompleteRefusalPath, new Date('2026-06-09T00:00:00.000Z'), new Date('2026-06-09T00:00:00.000Z'));
await fs.utimes(newerWeakRefusalPath, new Date('2026-06-09T00:05:00.000Z'), new Date('2026-06-09T00:05:00.000Z'));
const completenessSelectionLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [realRocmCompletenessDir],
  generatedAt: '2026-06-09T00:05:01.000Z',
});
const completenessSelectionRow = completenessSelectionLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.ok(completenessSelectionRow?.artifactPath.endsWith('real-rocm-complete-refusal.json'));
assert.equal(completenessSelectionRow.attemptCompleteness.score, 80);
assert.equal(completenessSelectionRow.attemptCompleteness.upstreamLifecycleAcceptedAsRefusalEvidence, true);
assert.equal(completenessSelectionLedger.attemptHistory.enabled, false);
assert.equal(completenessSelectionLedger.attemptHistory.latestAttemptCount, 1);
assert.equal(completenessSelectionLedger.attemptHistory.attemptCount, 0);
assert.equal(completenessSelectionLedger.attemptHistory.latestUnselectedAttemptCount, 1);
assert.equal(completenessSelectionLedger.attemptHistory.latestUnselectedAttemptWarning, true);
assert.ok(
  completenessSelectionLedger.attemptHistory.warningGaps
    .includes('latest_attempt_unselected_by_priority_selection'),
);
assert.equal(
  completenessSelectionLedger.summary.broadLibraryAgnosticReadiness
    .latestAttemptUnselectedBlocksReadiness,
  true,
);
assert.equal(
  completenessSelectionLedger.summary.broadLibraryAgnosticReadiness.latestUnselectedAttemptCount,
  1,
);
assert.ok(
  completenessSelectionLedger.summary.broadLibraryAgnosticReadiness.openGaps
    .includes('latest_attempt_unselected_by_priority_selection'),
);

const completenessSelectionLedgerWithHistory = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [realRocmCompletenessDir],
  generatedAt: '2026-06-09T00:05:01.000Z',
  includeUnproven: true,
});
const completenessSelectionRowWithHistory = completenessSelectionLedgerWithHistory.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.ok(completenessSelectionRowWithHistory?.artifactPath.endsWith('real-rocm-complete-refusal.json'));
const completenessAttemptHistory = completenessSelectionLedgerWithHistory.attemptHistory.attempts.find(
  (attempt) => attempt.selected?.artifactPath?.endsWith('real-rocm-complete-refusal.json'),
);
assert.ok(completenessAttemptHistory);
assert.equal(completenessAttemptHistory.selectedIsLatest, false);
assert.equal(completenessAttemptHistory.latestAttemptIsUnselected, true);
assert.ok(completenessAttemptHistory.latest.artifactPath.endsWith('real-rocm-weak-refusal.json'));
assert.ok(completenessAttemptHistory.selected.artifactPath.endsWith('real-rocm-complete-refusal.json'));
assert.equal(completenessSelectionLedgerWithHistory.attemptHistory.latestUnselectedAttemptCount, 1);
assert.equal(
  completenessSelectionLedgerWithHistory.query.attemptHistory.latestUnselectedAttemptCount,
  1,
);

const runtimeBoundarySupportSelectionDir = path.join(
  logsRoot,
  'real-rocm-runtime-boundary-support-selection',
);
const olderBoundarySupportPath = path.join(
  runtimeBoundarySupportSelectionDir,
  'real-rocm-boundary-support-refusal.json',
);
const newerBoundaryThinPath = path.join(
  runtimeBoundarySupportSelectionDir,
  'real-rocm-boundary-thin-refusal.json',
);
const boundarySupportScope = 'runtime-boundary-support-selection';
const boundarySupportMaterials = realRocmRuntimeProofMaterials('hot_delta_1', {
  projectId: 'real-rocm-runtime-boundary-support-selection',
  visualRoot: runtimeBoundarySupportSelectionDir,
});
const completeBoundarySupportExecution = runtimeAdapterExecutionFixture(
  boundarySupportScope,
  boundarySupportMaterials,
);
const diagnosticBoundarySupportLines = completeBoundarySupportExecution.runtimeBoundaryLines
  .filter((line) => !/\boutput_oracle\b/i.test(line));
const boundarySupportExecution = runtimeAdapterExecutionFixture(
  boundarySupportScope,
  boundarySupportMaterials,
  {
    runtimeBoundaryLines: diagnosticBoundarySupportLines,
    runtime_boundary_lines: diagnosticBoundarySupportLines,
    runtimeBoundaryLineCount: diagnosticBoundarySupportLines.length,
    runtime_boundary_line_count: diagnosticBoundarySupportLines.length,
  },
);
const boundarySupportStageEvents = runtimeAdapterStageEventsFixture(
  boundarySupportExecution.runtimeBoundaryLines,
);
const runtimeBoundarySupportBaseArtifact = {
  real_rocm_profile: { id: 'real-rocm-runtime-boundary-support-selection' },
  source_url: 'https://example.invalid/rocm/runtime-boundary-support.git',
  repo_commit: '1234567890abcdef1234567890abcdef12345678',
  entry_file: 'src/kernels/runtime_boundary_entry.hip',
  delta_file: 'src/kernels/runtime_boundary_delta.h',
  target_name: 'RuntimeBoundarySupportDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  strict_proof_gates: {
    accepted: false,
    failures: ['runtime_full_proof_not_proven'],
  },
  upstream_lifecycle_failure: {
    schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    accepted_as_refusal_evidence: true,
    reasons: ['runtime_proof_not_closed'],
  },
  checks: [
    {
      name: 'strict real ROCm runtime proof artifact acceptance',
      status: 'fail',
      detail: 'failures=runtime_full_proof_not_proven',
    },
  ],
};
await writeJson(olderBoundarySupportPath, {
  ...runtimeBoundarySupportBaseArtifact,
  slug: 'gpu-real-rocm-runtime-boundary-support-older-rich-refusal',
  real_rocm_runtime_adapter_execution: boundarySupportExecution,
  realRocmRuntimeAdapterExecution: boundarySupportExecution,
});
await writeJson(newerBoundaryThinPath, {
  ...runtimeBoundarySupportBaseArtifact,
  slug: 'gpu-real-rocm-runtime-boundary-support-newer-thin-refusal',
  real_rocm_runtime_adapter_execution: {
    schemaVersion: 'synthi.real_rocm.runtime_adapter_execution.v1',
    schema_version: 'synthi.real_rocm.runtime_adapter_execution.v1',
    proofAuthority: 'adapter_execution_evidence_only_not_runtime_authority',
    proof_authority: 'adapter_execution_evidence_only_not_runtime_authority',
    declared: false,
    enabled: false,
    status: 'runtime_adapter_not_declared',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    runtimeBoundaryLines: [],
    runtime_boundary_lines: [],
  },
});
await fs.utimes(
  olderBoundarySupportPath,
  new Date('2026-06-29T01:00:00.000Z'),
  new Date('2026-06-29T01:00:00.000Z'),
);
await fs.utimes(
  newerBoundaryThinPath,
  new Date('2026-06-29T01:05:00.000Z'),
  new Date('2026-06-29T01:05:00.000Z'),
);
const runtimeBoundarySupportSelectionLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [runtimeBoundarySupportSelectionDir],
  generatedAt: '2026-06-29T01:05:01.000Z',
  includeUnproven: true,
});
const runtimeBoundarySupportSelectionRow =
  runtimeBoundarySupportSelectionLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.ok(
  runtimeBoundarySupportSelectionRow?.artifactPath.endsWith(
    'real-rocm-boundary-support-refusal.json',
  ),
);
assert.equal(runtimeBoundarySupportSelectionRow.matrixOutcome, 'refusal_proven');
assert.equal(runtimeBoundarySupportSelectionRow.acceptedForGpuHmr, false);
assert.equal(runtimeBoundarySupportSelectionRow.attemptCompleteness.score, 80);
assert.equal(runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterExecution.accepted, false);
assert.equal(
  runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterExecution.acceptedForGpuHmr,
  false,
);
assert.equal(
  runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterExecution
    .adapterBoundaryCoverage.acceptedAsDiagnosticEvidence,
  true,
);
assert.ok(
  runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterExecution.failedGates.includes(
    'real_rocm_runtime_adapter_execution_boundary_coverage_incomplete',
  ),
);
assert.equal(runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterStageEvents.present, true);
assert.equal(runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterStageEvents.accepted, false);
assert.deepEqual(
  runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterStageEvents.boundaryLineHashes,
  boundarySupportStageEvents.boundaryLineHashes,
);
assert.ok(
  runtimeBoundarySupportSelectionRow.realRocmRuntimeAdapterStageEvents.missingStages.includes(
    'output_oracle',
  ),
);
const runtimeBoundarySupportAttempt =
  runtimeBoundarySupportSelectionLedger.attemptHistory.attempts.find(
    (attempt) =>
      attempt.selected?.artifactPath?.endsWith('real-rocm-boundary-support-refusal.json'),
  );
assert.ok(runtimeBoundarySupportAttempt);
assert.equal(runtimeBoundarySupportAttempt.selectedIsLatest, false);
assert.equal(runtimeBoundarySupportAttempt.latestAttemptIsUnselected, true);
assert.ok(
  runtimeBoundarySupportAttempt.selected.runtimeBoundarySupportScore
    > runtimeBoundarySupportAttempt.latest.runtimeBoundarySupportScore,
);

const forgedRuntimeBoundarySupportSelectionDir = path.join(
  logsRoot,
  'real-rocm-forged-runtime-boundary-support-selection',
);
const olderForgedBoundarySupportPath = path.join(
  forgedRuntimeBoundarySupportSelectionDir,
  'real-rocm-forged-boundary-support-refusal.json',
);
const newerForgedBoundaryThinPath = path.join(
  forgedRuntimeBoundarySupportSelectionDir,
  'real-rocm-forged-boundary-thin-refusal.json',
);
const forgedBoundarySupportExecution = runtimeAdapterExecutionFixture(
  'forged-runtime-boundary-support-selection',
  boundarySupportMaterials,
  {
    gpuHmrSuccess: true,
    gpu_hmr_success: true,
  },
);
const forgedRuntimeBoundarySupportBaseArtifact = {
  ...runtimeBoundarySupportBaseArtifact,
  real_rocm_profile: { id: 'real-rocm-forged-runtime-boundary-support-selection' },
};
await writeJson(olderForgedBoundarySupportPath, {
  ...forgedRuntimeBoundarySupportBaseArtifact,
  slug: 'gpu-real-rocm-forged-runtime-boundary-support-older-rich-refusal',
  real_rocm_runtime_adapter_execution: forgedBoundarySupportExecution,
  realRocmRuntimeAdapterExecution: forgedBoundarySupportExecution,
});
await writeJson(newerForgedBoundaryThinPath, {
  ...forgedRuntimeBoundarySupportBaseArtifact,
  slug: 'gpu-real-rocm-forged-runtime-boundary-support-newer-thin-refusal',
});
await fs.utimes(
  olderForgedBoundarySupportPath,
  new Date('2026-06-29T02:00:00.000Z'),
  new Date('2026-06-29T02:00:00.000Z'),
);
await fs.utimes(
  newerForgedBoundaryThinPath,
  new Date('2026-06-29T02:05:00.000Z'),
  new Date('2026-06-29T02:05:00.000Z'),
);
const forgedRuntimeBoundarySupportSelectionLedger =
  await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [forgedRuntimeBoundarySupportSelectionDir],
    generatedAt: '2026-06-29T02:05:01.000Z',
    includeUnproven: true,
  });
const forgedRuntimeBoundarySupportSelectionRow =
  forgedRuntimeBoundarySupportSelectionLedger.rows.find(
    (row) => row.proofMode === 'real_rocm_repo_validation',
  );
assert.ok(
  forgedRuntimeBoundarySupportSelectionRow?.artifactPath.endsWith(
    'real-rocm-forged-boundary-thin-refusal.json',
  ),
);
const forgedRuntimeBoundarySupportAttempt =
  forgedRuntimeBoundarySupportSelectionLedger.attemptHistory.attempts.find(
    (attempt) =>
      attempt.latest?.artifactPath?.endsWith('real-rocm-forged-boundary-thin-refusal.json'),
  );
assert.ok(forgedRuntimeBoundarySupportAttempt);
assert.equal(forgedRuntimeBoundarySupportAttempt.selectedIsLatest, true);
assert.equal(forgedRuntimeBoundarySupportAttempt.selected.runtimeBoundarySupportScore, 0);

const workerTransferRefusalDir = path.join(logsRoot, 'real-rocm-worker-transfer-refusal');
await writeJson(path.join(workerTransferRefusalDir, 'real-rocm-worker-transfer-refusal.json'), {
  slug: 'gpu-real-rocm-worker-transfer-refusal-20260625',
  real_rocm_profile: { id: 'real-rocm-worker-transfer-refusal-generic' },
  source_url: 'https://example.invalid/rocm/generic-worker-transfer.git',
  repo_commit: '1111111111111111111111111111111111111111',
  entry_file: 'src/gpu/generic_entry.hip',
  delta_file: 'src/gpu/generic_delta.h',
  target_name: 'GenericRocmDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: false,
  gpu_hmr_success: false,
  strict_proof_gates: {
    accepted: false,
    failures: ['runtime_full_proof_not_proven'],
  },
  runtime_proof_artifact: {
    proofId: 'runtime-proof-artifact:worker-transfer-refusal',
    fullRuntimeProven: false,
    full_runtime_proven: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    stageResults: [
      { stageId: 'worker-repo-transfer', status: 'failed' },
    ],
    limitations: [{ code: 'worker_repo_transfer_failed' }],
  },
  worker_repo_transfer_failure: {
    schemaVersion: 'synthi.real_rocm.worker_repo_transfer_failure.v1',
    schema_version: 'synthi.real_rocm.worker_repo_transfer_failure.v1',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    operation: 'docker_cp',
    sourcePath: '/tmp/generic-real-rocm-source',
    source_path: '/tmp/generic-real-rocm-source',
    destinationPath: 'worker:/tmp/generic-real-rocm-repo',
    destination_path: 'worker:/tmp/generic-real-rocm-repo',
    workerContainer: 'generic-rocm-worker',
    worker_container: 'generic-rocm-worker',
    reasons: [
      'worker_repo_transfer_failed',
      'docker_copy_failed',
      'filesystem_io_error',
    ],
    errorMessage: 'Command failed: docker cp /tmp/generic-real-rocm-source worker:/tmp/generic-real-rocm-repo: input/output error',
    error_message: 'Command failed: docker cp /tmp/generic-real-rocm-source worker:/tmp/generic-real-rocm-repo: input/output error',
  },
  checks: [
    {
      name: 'worker repo transfer',
      status: 'fail',
      detail: 'operation=docker_cp reasons=worker_repo_transfer_failed,docker_copy_failed,filesystem_io_error',
    },
    {
      name: 'strict real ROCm runtime proof artifact acceptance',
      status: 'fail',
      detail: 'failures=runtime_full_proof_not_proven',
    },
  ],
});
const workerTransferRefusalLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [workerTransferRefusalDir],
  generatedAt: '2026-06-09T00:06:00.000Z',
});
const workerTransferRefusalRow = workerTransferRefusalLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(workerTransferRefusalRow?.matrixOutcome, 'refusal_proven');
assert.equal(workerTransferRefusalRow.acceptanceClass, 'large_real_rocm_repo_refusal');
assert.equal(workerTransferRefusalRow.acceptedForGpuHmr, false);
assert.equal(workerTransferRefusalRow.gpuHmrSuccess, false);
assert.equal(workerTransferRefusalRow.refusalProven, true);
assert.equal(workerTransferRefusalRow.proofChainAccepted, true);
assert.equal(workerTransferRefusalRow.proofChain, 'real_rocm_strict_runtime_refusal');
assert.equal(workerTransferRefusalRow.runtimeProofArtifact.present, true);
assert.equal(workerTransferRefusalRow.runtimeProofArtifact.accepted, false);
assert.ok(workerTransferRefusalRow.runtimeProofArtifact.failedGates.some(
  (failure) => failure.code === 'runtime_full_proof_not_proven',
));
assert.equal(workerTransferRefusalRow.workerRepoTransferFailure.schemaVersion,
  'synthi.real_rocm.worker_repo_transfer_failure.v1');
assert.equal(workerTransferRefusalRow.workerRepoTransferFailure.acceptedAsRefusalEvidence, true);
assert.equal(workerTransferRefusalRow.workerRepoTransferFailure.operation, 'docker_cp');
assert.ok(workerTransferRefusalRow.workerRepoTransferFailure.reasons.includes('worker_repo_transfer_failed'));
assert.ok(workerTransferRefusalRow.workerRepoTransferFailure.reasons.includes('docker_copy_failed'));
assert.ok(workerTransferRefusalRow.workerRepoTransferFailure.reasons.includes('filesystem_io_error'));
assert.equal(workerTransferRefusalRow.attemptCompleteness.score, 70);
assert.equal(workerTransferRefusalRow.attemptCompleteness.workerRepoTransferPresent, true);
assert.equal(workerTransferRefusalRow.attemptCompleteness.workerRepoTransferAcceptedAsRefusalEvidence, true);
assert.equal(workerTransferRefusalRow.attemptCompleteness.upstreamLifecycleAcceptedAsRefusalEvidence, false);
assert.equal(workerTransferRefusalRow.attemptCompleteness.accepted, false);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  proofId: ledger.proofId,
  rows: ledger.rows.length,
}, null, 2));
