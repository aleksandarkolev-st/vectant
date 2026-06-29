#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  originalHostPathProofFromRuntimeEvidence,
  runtimeArtifactTransportEvidence,
  runtimeEpochSwapEvidence,
  runtimeHostIdentityEvidence,
  runtimeOriginalHostPathEvidence,
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

const bridgeRuntimeSession = 'bridge:pid:4242';
const bridgeLines = [
  [
    '[gpu-runtime-boundary] host_identity',
    'role=runner_process',
    'generation=1',
    'ptr=0x1092',
    'aux=pid:4242',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] host_identity',
    'role=original_host_state',
    'generation=1',
    'ptr=0x2000',
    'aux=host_path:app',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] host_identity',
    'role=hip_stream_resource',
    'generation=1',
    'ptr=0x3000',
    'aux=stream:hmr',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] launch_arg_provenance',
    'kernel=BridgeKernel',
    'generation=2',
    'dispatch_table_entry_id=bridge-slot',
    'artifact_id=artifact:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'complete=true',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] native_runtime_dispatch',
    'kernel=BridgeKernel',
    'dispatch=ok',
    'generation=2',
    'dispatch_id=dispatch:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'dispatch_table_entry_id=bridge-slot',
    'artifact_id=artifact:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'proof_bridge=complete',
    'attachment_provenance=native_runtime_bridge',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] original_host_path',
    'event=attached',
    'attached=true',
    'dispatch_boundary_observed=true',
    'attachment_provenance=native_runtime_bridge',
    'host_path_id=bridge-host',
    'dispatch_table_entry_id=bridge-slot',
    'runtime_dispatch_table_entry_id=bridge-slot',
    'dispatch_entry_runtime_verified=true',
    'generation=2',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] host_identity',
    'role=runner_process',
    'generation=2',
    'ptr=0x1092',
    'aux=pid:4242',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] host_identity',
    'role=original_host_state',
    'generation=2',
    'ptr=0x2000',
    'aux=host_path:app',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
  [
    '[gpu-runtime-boundary] host_identity',
    'role=hip_stream_resource',
    'generation=2',
    'ptr=0x3000',
    'aux=stream:hmr',
    `runtime_session=${bridgeRuntimeSession}`,
  ].join(' '),
];
const bridgeHostEvidence = runtimeOriginalHostPathEvidence(bridgeLines);
assert.equal(bridgeHostEvidence.runtime_evidence_observed, true);
assert.equal(bridgeHostEvidence.dispatch_entry_runtime_verified, true);
assert.equal(bridgeHostEvidence.matching_dispatch_boundary_observed, true);

const nativeOnlyLines = [
  [
    '[gpu-runtime-boundary] native_launch_observer_ready',
    'runtime_session=native-session',
    'pid=4242',
    'apis=genericLaunch',
    'function_resolution_apis=hipModuleGetFunction',
  ].join(' '),
  [
    '[gpu-runtime-boundary] native_launch_attempt',
    'api=genericLaunch',
    'runtime_session=native-session',
    'sequence=7',
    'function_ptr=0x1',
    'kernel_symbol=NativeKernel',
    'grid=(2,3,4)',
    'block=(8,4,1)',
    'args_ptr=0x2',
    'stream=0x3',
    'shared_bytes=64',
    'real_launch_resolved=true',
    'dispatch=attempted-native',
    'attachment_provenance=native_runtime_intercept',
  ].join(' '),
  [
    '[gpu-runtime-boundary] native_launch_observed',
    'api=genericLaunch',
    'runtime_session=native-session',
    'sequence=7',
    'function_ptr=0x1',
    'kernel_symbol=NativeKernel',
    'grid=(2,3,4)',
    'block=(8,4,1)',
    'args_ptr=0x2',
    'stream=0x3',
    'shared_bytes=64',
    'result=0',
    'dispatch=observed-native',
    'attachment_provenance=native_runtime_intercept',
  ].join(' '),
];
const nativeOnlyEvidence = runtimeOriginalHostPathEvidence(nativeOnlyLines);
assert.equal(nativeOnlyEvidence.native_launch_attempt_count, 1);
assert.equal(nativeOnlyEvidence.native_launch_count, 1);
assert.equal(nativeOnlyEvidence.native_launch_observed, true);
assert.equal(nativeOnlyEvidence.native_launch_attempt_records[0].grid_dimensions, '2x3x4');
assert.equal(nativeOnlyEvidence.native_launch_attempt_records[0].block_dimensions, '8x4x1');
assert.equal(nativeOnlyEvidence.native_launch_attempt_records[0].stream_id, '0x3');
assert.equal(nativeOnlyEvidence.native_launch_attempt_records[0].shared_memory_bytes, 64);
assert.equal(nativeOnlyEvidence.native_launch_attempt_records[0].args_ptr, '0x2');
assert.equal(nativeOnlyEvidence.native_launch_attempt_records[0].dispatch, 'attempted-native');
assert.equal(nativeOnlyEvidence.native_launch_records[0].grid_dimensions, '2x3x4');
assert.equal(nativeOnlyEvidence.native_launch_records[0].block_dimensions, '8x4x1');
assert.equal(nativeOnlyEvidence.native_launch_records[0].stream_id, '0x3');
assert.equal(nativeOnlyEvidence.native_launch_records[0].shared_memory_bytes, 64);
assert.equal(nativeOnlyEvidence.native_launch_records[0].args_ptr, '0x2');
assert.equal(nativeOnlyEvidence.native_launch_records[0].dispatch, 'observed-native');
assert.equal(nativeOnlyEvidence.native_launch_records[0].result, 0);
assert.deepEqual(nativeOnlyEvidence.native_launch_attempt_evidence_refs, [
  'worker-log:native_launch_attempt:native-session:NativeKernel:7',
]);
assert.deepEqual(nativeOnlyEvidence.native_launch_evidence_refs, [
  'worker-log:native_launch_observed:native-session:NativeKernel:7',
]);
assert.deepEqual(nativeOnlyEvidence.evidence_refs, []);
assert.equal(nativeOnlyEvidence.attached_to_original_host_path, false);
assert.equal(nativeOnlyEvidence.runtime_evidence_observed, false);
assert.equal(nativeOnlyEvidence.matching_dispatch_boundary_observed, false);
assert.equal(nativeOnlyEvidence.dispatch_boundary_count, 0);
assert.equal(nativeOnlyEvidence.launch_boundary_count, 0);
assert.equal(runtimeArtifactTransportEvidence(nativeOnlyLines).matched_count, 0);
assert.equal(runtimeEpochSwapEvidence(nativeOnlyLines).published_count, 0);
assert.equal(runtimeOutputOracleEvidence(nativeOnlyLines).matched_count, 0);

const nativeOnlyProof = originalHostPathProofFromRuntimeEvidence(nativeOnlyLines, { required: true });
assert.equal(nativeOnlyProof.proof.attachmentProven, false);
assert.equal(nativeOnlyProof.proof.runtimeEvidenceObserved, false);
assert.deepEqual(nativeOnlyProof.proof.runtimeEvidenceRefs, []);
assert.equal(nativeOnlyProof.proof.dispatchBoundaryObserved, false);
assert.equal(nativeOnlyProof.proof.nativeLaunchObserved, true);
assert.equal(nativeOnlyProof.proof.diagnosticEvidenceRefs.includes(
  'worker-log:native_launch_observed:native-session:NativeKernel:7',
), true);

const nativeAttemptOnlyEvidence = runtimeOriginalHostPathEvidence([
  [
    '[gpu-runtime-boundary] native_launch_attempt',
    'api=genericLaunch',
    'runtime_session=native-session',
    'sequence=8',
    'function_ptr=0x1',
    'kernel_symbol=NativeKernel',
    'grid=(1,1,1)',
    'block=(1,1,1)',
    'args_ptr=0x2',
    'stream=0x3',
    'shared_bytes=0',
    'result=0',
    'dispatch=ok',
    'attachment_provenance=native_runtime_intercept',
  ].join(' '),
]);
assert.equal(nativeAttemptOnlyEvidence.native_launch_attempt_observed, true);
assert.equal(nativeAttemptOnlyEvidence.native_launch_observed, false);
assert.equal(nativeAttemptOnlyEvidence.native_launch_attempt_without_result, true);

const hostEvidence = runtimeHostIdentityEvidence(bridgeLines, {
  expectedGenerationLineage: {
    previousGeneration: 1,
    activeGeneration: 2,
  },
});
assert.equal(hostEvidence.identity_checks_passed, true);
assert.deepEqual(hostEvidence.preserved_role_categories.sort(), [
  'host_state',
  'runner_process',
  'runtime_resource',
].sort());

const forgedBridgeEvidence = runtimeOriginalHostPathEvidence(bridgeLines.map((candidate) =>
  candidate.replace('proof_bridge=complete', 'proof_bridge=missing')
));
assert.equal(forgedBridgeEvidence.runtime_evidence_observed, false);
assert.equal(forgedBridgeEvidence.matching_dispatch_boundary_observed, false);
const forgedBridgeWithNativeEvidence = runtimeOriginalHostPathEvidence([
  ...bridgeLines.map((candidate) => candidate.replace('proof_bridge=complete', 'proof_bridge=missing')),
  ...nativeOnlyLines,
]);
assert.equal(forgedBridgeWithNativeEvidence.runtime_evidence_observed, false);
assert.equal(forgedBridgeWithNativeEvidence.matching_dispatch_boundary_observed, false);
assert.equal(forgedBridgeWithNativeEvidence.native_launch_observed, true);

const missingRamIdentityEvidence = runtimeArtifactTransportEvidence([
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
    'ram_blob_id=artifact:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'ram_transport_proven=true',
    'load_result=ok',
  ].join(' '),
]);
assert.equal(missingRamIdentityEvidence.ram_transport_proven, false);
assert.equal(missingRamIdentityEvidence.degraded_reason, 'ram_blob_identity_not_proven');

console.log(JSON.stringify({
  ok: true,
  parsedReadbackSampleBytes: evidence.output_oracle.readbackBytes,
  oracleId: evidence.output_oracle.oracleId,
  transportArtifactId: transportEvidence.artifact_id,
  bridgeRuntimeEvidenceObserved: bridgeHostEvidence.runtime_evidence_observed,
}, null, 2));
