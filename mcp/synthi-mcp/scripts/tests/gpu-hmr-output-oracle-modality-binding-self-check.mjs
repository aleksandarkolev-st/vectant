#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  evaluateFullRuntimeOutputOracleModalityBinding,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

const computeArtifacts = {
  raw_readback_bin: 'cas://sha256/compute-readback',
  readback_schema_json: 'cas://sha256/compute-schema',
  raw_readback_hash: `sha256:${'a'.repeat(64)}`,
};
const visualArtifacts = {
  before_image: 'cas://sha256/visual-before',
  after_image: 'cas://sha256/visual-after',
  diff_image: 'cas://sha256/visual-diff',
};

function rowFor({
  facetKind,
  ledgerKind,
  ledgerComputeArtifacts = null,
  ledgerVisualArtifacts = null,
  computeFacetAccepted = false,
  visualFacetAccepted = false,
}) {
  const outputEvent = {
    kind: ledgerKind,
    ...(ledgerComputeArtifacts
      ? { computeOracleArtifacts: ledgerComputeArtifacts }
      : {}),
    ...(ledgerVisualArtifacts
      ? { visualOracleArtifacts: ledgerVisualArtifacts }
      : {}),
  };
  const oracleArtifacts = {
    ...(ledgerComputeArtifacts
      ? { computeOracleArtifacts: ledgerComputeArtifacts }
      : {}),
    ...(ledgerVisualArtifacts
      ? { visualOracleArtifacts: ledgerVisualArtifacts }
      : {}),
  };
  return {
    ledger: {
      proofId: `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
      record: {
        proofId: `gpu-ledger-proof:sha256:${'b'.repeat(64)}`,
        outputEvent,
        oracleArtifacts,
      },
    },
    outputOracleFacet: {
      accepted: true,
      kind: facetKind,
      compute: {
        accepted: computeFacetAccepted,
        fileIntegrityAccepted: computeFacetAccepted,
      },
      evidenceRefs: ['self-check:output-oracle-modality'],
    },
    visual: {
      present: visualFacetAccepted,
      accepted: visualFacetAccepted,
    },
  };
}

function failureCodes(binding) {
  return binding.failedGates.map((failure) => failure.code);
}

const computeBinding = evaluateFullRuntimeOutputOracleModalityBinding(rowFor({
  facetKind: 'compute_oracle',
  ledgerKind: 'buffer_checksum',
  ledgerComputeArtifacts: computeArtifacts,
  computeFacetAccepted: true,
}));
assert.equal(computeBinding.accepted, true);
assert.equal(computeBinding.modality, 'compute');

const visualBinding = evaluateFullRuntimeOutputOracleModalityBinding(rowFor({
  facetKind: 'visual_oracle',
  ledgerKind: 'deterministic_framebuffer_diff',
  ledgerVisualArtifacts: visualArtifacts,
  visualFacetAccepted: true,
}));
assert.equal(visualBinding.accepted, true);
assert.equal(visualBinding.modality, 'visual');

const relabeledVisualLedger = evaluateFullRuntimeOutputOracleModalityBinding(rowFor({
  facetKind: 'compute_oracle',
  ledgerKind: 'visual_frame',
  ledgerVisualArtifacts: visualArtifacts,
  computeFacetAccepted: true,
}));
assert.equal(relabeledVisualLedger.accepted, false);
assert.ok(failureCodes(relabeledVisualLedger).includes(
  'output_oracle_facet_ledger_modality_mismatch',
));
assert.ok(failureCodes(relabeledVisualLedger).includes(
  'output_oracle_ledger_artifact_family_missing',
));

const declarationOnlyCompute = evaluateFullRuntimeOutputOracleModalityBinding(rowFor({
  facetKind: 'compute_oracle',
  ledgerKind: 'compute_readback',
  ledgerComputeArtifacts: computeArtifacts,
}));
assert.equal(declarationOnlyCompute.accepted, false);
assert.ok(failureCodes(declarationOnlyCompute).includes(
  'output_oracle_facet_artifact_evidence_missing',
));

const ambiguousArtifacts = evaluateFullRuntimeOutputOracleModalityBinding(rowFor({
  facetKind: 'compute_oracle',
  ledgerKind: 'compute_oracle',
  ledgerComputeArtifacts: computeArtifacts,
  ledgerVisualArtifacts: visualArtifacts,
  computeFacetAccepted: true,
}));
assert.equal(ambiguousArtifacts.accepted, false);
assert.ok(failureCodes(ambiguousArtifacts).includes(
  'output_oracle_ledger_artifact_modality_ambiguous',
));

const deceptiveKind = evaluateFullRuntimeOutputOracleModalityBinding(rowFor({
  facetKind: 'my_visual_frame_compute_oracle',
  ledgerKind: 'compute_oracle',
  ledgerComputeArtifacts: computeArtifacts,
  computeFacetAccepted: true,
}));
assert.equal(deceptiveKind.accepted, false);
assert.ok(failureCodes(deceptiveKind).includes('output_oracle_kind_unknown'));

console.log('gpu hmr output oracle modality binding self-check passed');
