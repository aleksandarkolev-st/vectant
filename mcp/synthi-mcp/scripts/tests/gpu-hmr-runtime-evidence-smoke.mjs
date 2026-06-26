#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  runtimeArtifactTransportEvidence,
  runtimeOutputOracleEvidence,
} from '../lib/gpu-hmr-runtime-evidence.mjs';

const line = [
  '[gpu-runtime-boundary] output_oracle',
  'id=oracle:test',
  'required_oracle_id=oracle:test',
  'kind=buffer_checksum',
  'expected=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'actual=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'passed=true',
  'generation=3',
  'runtime_session=pid1',
  'producer=runtime_probe',
  'output_target_id=target:y',
  'artifact_id=artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'after_dispatch_id=dispatch:sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'readback_timestamp=1780000000000',
  'probe_mode=post_hmr_active_kernel_readback_checksum',
  'probe_config_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'probe_evidence_ref=evidence:probe',
  'readback_bytes=8',
  'readback_sample_stride=1',
  'readback_sample_sha256=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  'readback_sample_hex=0001020304050607',
].join(' ');

const evidence = runtimeOutputOracleEvidence([line], {
  expectedOracle: {
    oracleId: 'oracle:test',
    requiredOracleId: 'oracle:test',
    kind: 'buffer_checksum',
    expected: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    producer: 'runtime_probe',
    outputTargetId: 'target:y',
    artifactId: 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
});

assert.equal(evidence.matched_count, 1);
assert.equal(evidence.deterministic_oracle_passed, true);
assert.equal(evidence.output_oracle.readbackBytes, 8);
assert.equal(evidence.output_oracle.readback_bytes, 8);
assert.equal(evidence.output_oracle.output_target_id, 'target:y');
assert.equal(evidence.output_oracle.target_id, 'target:y');
assert.equal(evidence.output_target_id, 'target:y');
assert.equal(evidence.output_oracle.artifact_id, 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
assert.equal(evidence.artifact_id, 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
assert.equal(evidence.output_oracle.timestamp_after_dispatch, '1780000000000');
assert.equal(evidence.timestamp_after_dispatch, '1780000000000');
assert.equal(
  evidence.output_oracle.afterDispatchId,
  'dispatch:sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
);
assert.equal(
  evidence.output_oracle.after_dispatch_id,
  'dispatch:sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
);
assert.equal(evidence.output_oracle.readbackSampleStride, 1);
assert.equal(
  evidence.output_oracle.readbackSampleSha256,
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
);
assert.equal(evidence.output_oracle.readbackSampleHex, '0001020304050607');
assert.equal(evidence.output_oracle.readback_sample_hex, '0001020304050607');

const transportEvidence = runtimeArtifactTransportEvidence([
  [
    '[gpu-runtime-boundary] artifact_transport',
    'runtime_session=pid1',
    'generation=3',
    'artifact_hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'artifact_bytes=8',
    'reload_request_transport=ram_bytes',
    'selected_loader_transport=ram_bytes',
    'loader_api=hipModuleLoadData',
    'ram_reference=true',
    'ram_blob_id=artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'ram_transport_proven=true',
    'load_result=ok',
  ].join(' '),
]);

assert.equal(transportEvidence.ram_transport_proven, true);
assert.equal(
  transportEvidence.artifact_id,
  'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
);
assert.deepEqual(transportEvidence.artifact_ids, [
  'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
]);
assert.deepEqual(transportEvidence.selected_artifact_ids, transportEvidence.artifact_ids);
assert.deepEqual(transportEvidence.artifact_content_hashes, [
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
]);

console.log(JSON.stringify({
  ok: true,
  parsedReadbackSampleBytes: evidence.output_oracle.readbackBytes,
  oracleId: evidence.output_oracle.oracleId,
  transportArtifactId: transportEvidence.artifact_id,
}, null, 2));
