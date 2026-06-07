#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  deriveGpuHmrAcceptanceContractFromVerifiedProofs,
  evaluateGpuHmrAcceptanceContract,
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
} from './lib/gpu-hmr-acceptance-contract.mjs';

const BEFORE = 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AFTER = 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function contract(overrides = {}) {
  return {
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    project_id: 'generic-gpu-project',
    edit_id: 'edit-1',
    backend: 'hip',
    confidence: 0.91,
    evidence_refs: ['static:hip-launch', 'runtime:loader'],
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.91,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: ['src/kernels.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['light_kernel'],
      compile_target: 'gfx1201',
      compiler: 'hipcc',
      compiler_args_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    },
    artifact_hash_before: BEFORE,
    artifact_hash_after: AFTER,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: ['code-object:metadata'],
    },
    abi_metadata: {
      kernel_abi_fingerprint_hashes: ['sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'],
      extractor_sources: ['clang_ast'],
    },
    reload_mechanism: 'generated_adapter',
    adapter_outcome: 'adapter_generated',
    reload_evidence_refs: ['runtime:module-load'],
    firewall_evidence: {
      route: 'gpu_device_sidecar_reload',
      evidence_source: 'self-check:reload-boundary',
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: 100,
      process_id_after: 100,
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: 'pid-1',
      device_uuid: 'device-1',
      context_or_device_handle: 'hip-context-1',
      queue_or_stream_handle: 'stream-1',
      persistent_gpu_allocations: ['allocation-1'],
    },
    epoch_policy: {
      publish_mechanism: 'runtime_epoch_publish',
      dispatch_binding: 'dispatch_table_epoch_binding',
      retirement_mechanism: 'stream_event',
    },
    epoch_retirement_proof: {
      value: 'stream_event_proven',
      evidence_refs: ['runtime:stream-event'],
    },
    fission_report: {
      selected_island: 'device-kernel',
      selected_reason: 'verified_fission_contract',
      artifact_hash_before: BEFORE,
      artifact_hash_after: AFTER,
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
    },
    hip_contract: {
      kernel_name: 'light_kernel',
      launch_api: 'hipModuleLaunchKernel',
      grid_dim: [64, 1, 1],
      block_dim: [256, 1, 1],
      shared_mem_bytes: 0,
      stream: 'stream-1',
      kernel_params: [{ name: 'output', kind: 'device_pointer' }],
      code_object_metadata: {
        source: 'amd_code_object_metadata',
        args_hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      },
      output_buffers: ['allocation-1'],
      readback_oracle: {
        kind: 'raw_readback',
        schema_hash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
    },
    ...overrides,
  };
}

function expectReject(name, patch, expectedCode) {
  const result = evaluateGpuHmrAcceptanceContract(contract(patch));
  assert.equal(result.accepted, false, `${name} unexpectedly accepted`);
  assert.ok(
    result.failedGates.some((gate) => gate.code === expectedCode),
    `${name} expected ${expectedCode}, got ${result.failedGates.map((gate) => gate.code).join(',')}`,
  );
}

const accepted = evaluateGpuHmrAcceptanceContract(contract());
assert.equal(accepted.accepted, true);

expectReject('host-only edit', {
  classification: {
    project_kind: 'gpu_project',
    edit_kind: 'host_only',
    route: 'cpu_hmr_or_host_reload',
  },
}, 'host_only_edit_not_gpu_hmr');
expectReject('cpu route', {
  classification: {
    project_kind: 'gpu_project',
    edit_kind: 'gpu_artifact_edit',
    route: 'cpu_hmr_or_host_reload',
  },
}, 'route_not_gpu_hmr');
expectReject('missing verified evidence refs', {
  evidence_refs: [],
}, 'contract_evidence_refs_missing');
expectReject('ai hints only', {
  evidence_refs: [],
  ai_hints: [{ backend: 'hip' }],
}, 'ai_hints_without_verified_evidence');
expectReject('ai-sourced ABI metadata', {
  abi_metadata: {
    kernel_abi_fingerprint_hashes: ['sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'],
    extractor_sources: ['clang_ast'],
    args: [{
      name: 'output',
      type: 'float*',
      size: 8,
      offset: 0,
      source: 'ai_hint',
    }],
  },
}, 'ai_hint_used_as_authoritative_contract_field');
expectReject('layout change', {
  abi_compatibility_class: {
    value: 'layout_changed',
    evidence_refs: ['code-object:metadata'],
  },
}, 'abi_compatibility_not_proven');
expectReject('unknown ABI', {
  abi_compatibility_class: {
    value: 'unknown',
    evidence_refs: ['code-object:metadata'],
  },
}, 'abi_compatibility_not_proven');
expectReject('metadata-only ABI label', {
  abi_metadata: {},
}, 'abi_metadata_missing');
expectReject('missing reload hook', {
  reload_mechanism: 'unsupported',
}, 'reload_mechanism_unsupported');
expectReject('missing state preservation', {
  state_preservation_checks: {
    device_uuid: 'device-1',
    context_or_device_handle: 'hip-context-1',
    queue_or_stream_handle: 'stream-1',
    persistent_gpu_allocations: ['allocation-1'],
  },
}, 'state_process_id_missing');
expectReject('missing epoch policy', {
  epoch_policy: {},
}, 'epoch_publish_mechanism_missing');
expectReject('missing epoch retirement mechanism', {
  epoch_policy: {
    publish_mechanism: 'runtime_epoch_publish',
    dispatch_binding: 'dispatch_table_epoch_binding',
  },
}, 'epoch_retirement_mechanism_missing');
expectReject('missing fission selected reason', {
  fission_report: {
    selected_island: 'device-kernel',
    full_device_fallback: false,
    host_relinked: false,
    process_restarted: false,
    full_rebuild_used: false,
  },
}, 'fission_selected_reason_missing');
expectReject('full rebuild hidden in fission', {
  fission_report: {
    selected_island: 'device-kernel',
    selected_reason: 'verified_fission_contract',
    full_device_fallback: false,
    host_relinked: false,
    process_restarted: false,
    full_rebuild_used: true,
  },
}, 'fission_full_rebuild_used');
expectReject('missing HIP launch evidence', {
  hip_contract: {
    kernel_name: 'light_kernel',
  },
}, 'hip_contract_launch_api_missing');
expectReject('missing HIPRT scene proof', {
  backend: 'hiprt',
  artifact_identity: {
    source_paths: ['src/path_tracer.h'],
    artifact_kind: 'hip_source_bridge',
    entry_points: ['raygen_kernel'],
    compile_target: 'gfx1201',
    compiler: 'hipcc',
    compiler_args_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  },
  state_preservation_checks: {
    process_id: 'pid-1',
    device_uuid: 'device-1',
    context_or_device_handle: 'hip-context-1',
    queue_or_stream_handle: 'stream-1',
    engine_scene_handles: ['scene-1'],
    camera_state_hash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    swapchain_or_framebuffer_identity: 'framebuffer-1',
  },
  hip_contract: {},
  hiprt_contract: {
    kernel_entry: 'raygen_kernel',
  },
}, 'hiprt_contract_scene_or_bvh_handles_missing');
expectReject('missing OpenCL event proof', {
  backend: 'opencl',
  artifact_identity: {
    source_paths: ['kernels/step.cl'],
    artifact_kind: 'opencl_program',
    entry_points: ['step_kernel'],
    compile_target: 'opencl-device-1',
    compiler: 'opencl-jit',
    compiler_args_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  },
  hip_contract: {},
  opencl_contract: {
    program_hash_before: BEFORE,
    program_hash_after: AFTER,
    kernel_name: 'step_kernel',
    command_queue: 'queue-1',
    work_dim: 1,
    global_work_size: [1024],
    local_work_size: [64],
  },
}, 'opencl_contract_event_trace_missing');
expectReject('missing Vulkan command-buffer proof', {
  backend: 'vulkan',
  artifact_identity: {
    source_paths: ['shaders/lighting.comp'],
    artifact_kind: 'spirv',
    entry_points: ['main'],
    compile_target: 'spirv1.6',
    compiler: 'glslang',
    compiler_args_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  },
  state_preservation_checks: {
    process_id: 'pid-1',
    device_uuid: 'device-1',
    context_or_device_handle: 'vk-device-1',
    queue_or_stream_handle: 'vk-queue-1',
    camera_state_hash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    swapchain_or_framebuffer_identity: 'swapchain-1',
  },
  epoch_retirement_proof: {
    value: 'frame_boundary_proven',
    evidence_refs: ['runtime:vk-fence'],
  },
  hip_contract: {},
  vulkan_contract: {
    shader_module_hash_before: BEFORE,
    shader_module_hash_after: AFTER,
    entry_point: 'main',
    descriptor_set_layout_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    pipeline_layout_hash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    pipeline_state_hash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    frame_used_new_pipeline_trace: 'frame:42:pipeline:new',
    command_buffer_re_record_required: true,
  },
}, 'vulkan_contract_command_buffer_re_record_proof_missing');
expectReject('missing WebGPU pipeline proof', {
  backend: 'webgpu',
  artifact_identity: {
    source_paths: ['shaders/particles.wgsl'],
    artifact_kind: 'wgsl',
    entry_points: ['vs_main', 'fs_main'],
    compile_target: 'webgpu',
    compiler: 'wgpu',
    compiler_args_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  },
  state_preservation_checks: {
    process_id: 'pid-1',
    device_uuid: 'device-1',
    context_or_device_handle: 'webgpu-device-1',
    queue_or_stream_handle: 'webgpu-queue-1',
    camera_state_hash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    swapchain_or_framebuffer_identity: 'canvas-1',
  },
  epoch_retirement_proof: {
    value: 'frame_boundary_proven',
    evidence_refs: ['runtime:present-fence'],
  },
  hip_contract: {},
  webgpu_contract: {
    wgsl_hash_before: BEFORE,
    wgsl_hash_after: AFTER,
    shader_module_epoch: 'epoch-2',
    entry_points: ['vs_main', 'fs_main'],
    bind_group_layout_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    pipeline_layout_hash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    vertex_buffer_layout_hash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    color_target_state_hash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    frame_used_new_pipeline_trace: 'frame:17:pipeline:new',
    pipeline_recreate_required: true,
  },
}, 'webgpu_contract_pipeline_recreate_proof_missing');
expectReject('embedded Bevy shader asset', {
  backend: 'bevy_wgsl',
  artifact_identity: {
    source_paths: ['src/material.rs'],
    artifact_kind: 'wgsl',
    entry_points: ['fragment'],
    compile_target: 'wgpu',
    compiler: 'bevy_asset_server',
    compiler_args_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  },
  state_preservation_checks: {
    process_id: 'pid-1',
    device_uuid: 'device-1',
    context_or_device_handle: 'wgpu-device-1',
    queue_or_stream_handle: 'wgpu-queue-1',
    camera_state_hash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    swapchain_or_framebuffer_identity: 'window-1',
  },
  epoch_retirement_proof: {
    value: 'frame_boundary_proven',
    evidence_refs: ['runtime:bevy-frame'],
  },
  reload_mechanism: 'engine_asset_reload',
  adapter_outcome: 'adapter_not_needed_builtin_reload',
  hip_contract: {},
  webgpu_contract: {
    wgsl_hash_before: BEFORE,
    wgsl_hash_after: AFTER,
    shader_module_epoch: 'epoch-2',
    entry_points: ['fragment'],
    bind_group_layout_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    pipeline_layout_hash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    vertex_buffer_layout_hash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    color_target_state_hash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    frame_used_new_pipeline_trace: 'frame:17:pipeline:new',
    pipeline_recreate_required: true,
    pipeline_recreate_proven: true,
    bevy_shader_asset_source: 'embedded',
    asset_watched: true,
  },
}, 'bevy_wgsl_shader_asset_not_file_loaded');

const derivedWithoutFirewall = deriveGpuHmrAcceptanceContractFromVerifiedProofs({
  backend: 'hip',
  projectId: 'generic-gpu-project',
  editId: 'edit-derived',
  gpuArch: 'gfx1201',
  compiler: 'hipcc',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  sourceProofs: [{
    resultState: 'gpu-hmr-symbol-bound',
    evidenceRefs: ['static:hip-launch'],
  }],
  fissionProof: {
    fissionProven: true,
    selectedIslandContracts: [{
      islandId: 'device-kernel',
      sourcePaths: ['src/kernels.hip'],
      targetSymbols: ['light_kernel'],
      artifactKind: 'hsaco',
      compileCommandHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    }],
  },
  abiProof: {
    resultState: 'gpu-hmr-abi-proven',
    evidenceRefs: ['code-object:metadata'],
    kernelAbiFingerprintHashes: [
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    ],
    acceptedExtractorSources: ['clang_ast'],
  },
  artifactTransportProof: {
    resultState: 'gpu-hmr-artifact-transport-proven',
    selectedArtifactIds: [AFTER],
    evidenceRefs: ['runtime:module-load'],
  },
  epochProof: {
    resultState: 'gpu-hmr-epoch-swap-proven',
    published: true,
    oldGenerationRetired: true,
    streamOrderingProven: true,
    retirementStrategy: 'stream_event',
    streamIds: ['stream-1'],
    evidenceRefs: ['runtime:stream-event'],
    epochGenerationGraph: {
      latestPublication: {
        oldArtifactId: BEFORE,
        newArtifactId: AFTER,
      },
    },
  },
  dispatchProof: {
    resultState: 'gpu-hmr-dispatch-safe-proven',
    selectedArtifactIds: [AFTER],
    dispatchTableEntryIds: ['light_kernel:0x1'],
    dispatchStreamIds: ['stream-1'],
    argProvenanceRecords: [{
      category: 'device_allocation',
      allocationId: 'allocation-1',
    }],
  },
  outputProof: {
    resultState: 'gpu-hmr-output-oracle-proven',
    outputOracle: {
      artifactId: AFTER,
      outputBufferReadback: {
        schema_hash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
    },
  },
  hostPreservationProof: {
    resultState: 'gpu-hmr-host-preservation-proven',
    processId: 'pid-1',
  },
  fullRuntimeProof: {
    fullRuntimeProven: true,
  },
});
assert.ok(
  derivedWithoutFirewall.classification.blocking_gaps.includes('route_classifier_not_verified'),
  `derived contract unexpectedly lacked route firewall gap: ${derivedWithoutFirewall.classification.blocking_gaps.join(',')}`,
);
assert.equal(evaluateGpuHmrAcceptanceContract(derivedWithoutFirewall).accepted, false);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
  acceptedContractHash: accepted.contract.contract_hash,
}, null, 2));
