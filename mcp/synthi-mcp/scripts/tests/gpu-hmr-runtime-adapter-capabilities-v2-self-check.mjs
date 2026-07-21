#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS,
  GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS,
  classifyGpuHmrOutputOracleKind,
} from '../lib/gpu-hmr-output-oracle-kind.mjs';

import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2,
  GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_FORMATS,
  GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_MATERIALIZATION_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_COMMAND_RECORDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_DEVICE_TOPOLOGIES,
  GPU_HMR_RUNTIME_ADAPTER_V2_DISPATCH_BINDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REF_BYTES,
  GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REFS,
  GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS,
  GPU_HMR_RUNTIME_ADAPTER_V2_OUTPUT_MODALITIES,
  GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_CACHE_OWNERS,
  GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_REUSE_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_PUBLICATION_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_RAY_TRACING_STATE_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_RESOURCE_BINDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_STATE_CONTINUITY_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_SYNCHRONIZATION_TOPOLOGIES,
  createGpuHmrRuntimeAdapterCapabilitiesV2,
  deriveGpuHmrRuntimeAdapterCapabilityObligationsV2,
  evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity,
} from '../lib/gpu-hmr-runtime-adapter-capabilities-v2.mjs';

const EXPORTED_ENUMS_BY_FIELD = {
  artifactFormat: GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_FORMATS,
  outputModality: GPU_HMR_RUNTIME_ADAPTER_V2_OUTPUT_MODALITIES,
  oracleKind: GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS,
  publicationModel: GPU_HMR_RUNTIME_ADAPTER_V2_PUBLICATION_MODELS,
  commandRecordingModel: GPU_HMR_RUNTIME_ADAPTER_V2_COMMAND_RECORDING_MODELS,
  pipelineCacheOwner: GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_CACHE_OWNERS,
  artifactMaterializationModel:
    GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_MATERIALIZATION_MODELS,
  dispatchBindingModel: GPU_HMR_RUNTIME_ADAPTER_V2_DISPATCH_BINDING_MODELS,
  resourceBindingModel: GPU_HMR_RUNTIME_ADAPTER_V2_RESOURCE_BINDING_MODELS,
  deviceTopology: GPU_HMR_RUNTIME_ADAPTER_V2_DEVICE_TOPOLOGIES,
  synchronizationTopology: GPU_HMR_RUNTIME_ADAPTER_V2_SYNCHRONIZATION_TOPOLOGIES,
  stateContinuityModel: GPU_HMR_RUNTIME_ADAPTER_V2_STATE_CONTINUITY_MODELS,
  rayTracingStateModel: GPU_HMR_RUNTIME_ADAPTER_V2_RAY_TRACING_STATE_MODELS,
  pipelineReuseModel: GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_REUSE_MODELS,
};

const EXPECTED_COMPUTE_ORACLES = [
  'compute_oracle',
  'compute',
  'buffer_checksum',
  'compute_readback',
  'source_derived_buffer_checksum',
  'edit_contract',
  'sentinel_buffer_value',
  'kernel_checksum',
  'kernel_side_checksum',
  'per_pass_checksum',
  'dispatch_counter',
];
const EXPECTED_VISUAL_ORACLES = [
  'visual_oracle',
  'runtime_visual_oracle',
  'visual',
  'visual_frame',
  'visual_frame_readback',
  'visual_framebuffer_diff',
  'deterministic_visual_frame',
  'deterministic_framebuffer_diff',
  'deterministic_visual_oracle',
  'render_target_hash',
  'accumulation_buffer_hash',
  'selected_pixels',
  'selected_pixel_values',
];
const EXPECTED_ALL_ORACLES = [
  ...EXPECTED_COMPUTE_ORACLES,
  ...EXPECTED_VISUAL_ORACLES,
];

const EXPECTED_ENUMS_BY_FIELD = {
  artifactFormat: [
    'native_binary',
    'portable_ir',
    'runtime_source',
    'engine_asset',
    'opaque_payload',
    'execution_graph',
  ],
  outputModality: ['compute', 'visual'],
  oracleKind: EXPECTED_ALL_ORACLES,
  publicationModel: [
    'dispatch_table_epoch',
    'pipeline_object_epoch',
    'engine_managed_epoch',
    'opaque_callback_epoch',
  ],
  commandRecordingModel: [
    'late_bound_dispatch',
    'record_after_publication',
    'pre_recorded_commands',
    'opaque_engine_managed',
  ],
  pipelineCacheOwner: [
    'none',
    'adapter',
    'application',
    'runtime',
    'engine',
    'opaque_external',
  ],
  artifactMaterializationModel: [
    'ahead_of_time',
    'runtime_compile',
    'runtime_jit',
    'opaque',
  ],
  dispatchBindingModel: [
    'direct',
    'indirect',
    'captured_graph',
    'indirect_captured_graph',
    'opaque',
  ],
  resourceBindingModel: ['fixed_layout', 'descriptor_layout', 'bindless', 'opaque'],
  deviceTopology: ['single_device', 'device_group', 'multi_device', 'opaque'],
  synchronizationTopology: [
    'single_queue_ordered',
    'single_queue_explicit',
    'multi_queue',
    'multi_device',
    'opaque',
  ],
  stateContinuityModel: [
    'stateless',
    'persistent_retained',
    'explicit_migration',
    'declared_reset',
    'opaque',
  ],
  rayTracingStateModel: [
    'none',
    'acceleration_structures',
    'shader_tables',
    'acceleration_structures_and_shader_tables',
    'opaque',
  ],
  pipelineReuseModel: ['none', 'cache', 'library', 'cache_and_library', 'opaque'],
};
const ENUMS_BY_FIELD = EXPECTED_ENUMS_BY_FIELD;

const EXPECTED_BASE_OBLIGATIONS = [
  'verified_artifact_transport',
  'changed_artifact_load_into_target_process',
  'epoch_publication',
  'loaded_artifact_epoch_binding',
  'post_publication_dispatch',
  'dispatch_epoch_artifact_binding',
  'same_process_host_identity',
  'output_after_dispatch_oracle_binding',
  'retirement_safety',
  'abi_compatibility',
  'cpu_hmr_full_rebuild_restart_firewall',
];

const EXPECTED_RULE_OBLIGATIONS = {
  artifactFormat: {
    native_binary: ['native_binary_artifact_identity_binding'],
    portable_ir: ['portable_ir_artifact_identity_binding'],
    runtime_source: ['runtime_source_exact_bytes_binding'],
    engine_asset: [
      'engine_asset_artifact_identity_binding',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
    opaque_payload: [
      'opaque_payload_explicit_app_hook_contract',
      'opaque_payload_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
    execution_graph: [
      'execution_graph_artifact_identity_binding',
      'graph_node_or_executable_update_or_reinstantiation',
      'graph_new_artifact_binding',
      'graph_executable_epoch_binding',
      'graph_old_executable_retirement',
    ],
  },
  outputModality: {
    compute: [
      'compute_raw_readback_bytes',
      'compute_readback_schema',
      'compute_before_after_checksum',
      'compute_deterministic_slice',
      'compute_oracle_dispatch_epoch_artifact_binding',
    ],
    visual: [
      'visual_verified_before_bytes',
      'visual_verified_after_bytes',
      'visual_verified_diff_bytes',
      'visual_deterministic_controls',
      'visual_post_epoch_frame_boundary',
      'visual_blank_frame_rejection',
      'visual_stale_frame_rejection',
      'visual_transparent_frame_rejection',
      'visual_temporal_ambiguity_rejection',
      'visual_oracle_dispatch_epoch_artifact_binding',
    ],
  },
  oracleKind: {
    compute_oracle: ['canonical_oracle_kind_classifier_binding'],
    compute: ['canonical_oracle_kind_classifier_binding'],
    buffer_checksum: ['canonical_oracle_kind_classifier_binding'],
    compute_readback: ['canonical_oracle_kind_classifier_binding'],
    source_derived_buffer_checksum: ['canonical_oracle_kind_classifier_binding'],
    edit_contract: ['canonical_oracle_kind_classifier_binding'],
    sentinel_buffer_value: ['canonical_oracle_kind_classifier_binding'],
    kernel_checksum: ['canonical_oracle_kind_classifier_binding'],
    kernel_side_checksum: ['canonical_oracle_kind_classifier_binding'],
    per_pass_checksum: ['canonical_oracle_kind_classifier_binding'],
    dispatch_counter: ['canonical_oracle_kind_classifier_binding'],
    visual_oracle: ['canonical_oracle_kind_classifier_binding'],
    runtime_visual_oracle: ['canonical_oracle_kind_classifier_binding'],
    visual: ['canonical_oracle_kind_classifier_binding'],
    visual_frame: ['canonical_oracle_kind_classifier_binding'],
    visual_frame_readback: ['canonical_oracle_kind_classifier_binding'],
    visual_framebuffer_diff: ['canonical_oracle_kind_classifier_binding'],
    deterministic_visual_frame: ['canonical_oracle_kind_classifier_binding'],
    deterministic_framebuffer_diff: ['canonical_oracle_kind_classifier_binding'],
    deterministic_visual_oracle: ['canonical_oracle_kind_classifier_binding'],
    render_target_hash: ['canonical_oracle_kind_classifier_binding'],
    accumulation_buffer_hash: ['canonical_oracle_kind_classifier_binding'],
    selected_pixels: ['canonical_oracle_kind_classifier_binding'],
    selected_pixel_values: ['canonical_oracle_kind_classifier_binding'],
  },
  publicationModel: {
    dispatch_table_epoch: ['dispatch_table_identity_epoch_binding'],
    pipeline_object_epoch: [
      'pipeline_recreation_or_rebinding',
      'pipeline_identity_epoch_binding',
    ],
    engine_managed_epoch: [
      'engine_managed_epoch_publication_receipt',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
    opaque_callback_epoch: [
      'opaque_callback_epoch_explicit_app_hook_contract',
      'opaque_callback_epoch_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  commandRecordingModel: {
    late_bound_dispatch: ['late_bound_dispatch_resolution_after_publication'],
    record_after_publication: [
      'post_publication_command_recording',
      'new_recording_changed_artifact_proof',
    ],
    pre_recorded_commands: [
      'old_command_invalidation',
      'old_command_retirement',
      'post_publication_command_recording',
      'post_publication_command_rerecord',
      'new_recording_changed_artifact_proof',
    ],
    opaque_engine_managed: [
      'opaque_command_recording_explicit_app_hook_contract',
      'opaque_command_recording_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  pipelineCacheOwner: {
    none: [
      'pipeline_cache_none_refresh_absence_proof',
      'pipeline_cache_none_invalidation_absence_proof',
      'pipeline_cache_none_identity_absence_binding',
    ],
    adapter: [
      'pipeline_cache_adapter_refresh_proof',
      'pipeline_cache_adapter_invalidation_proof',
      'pipeline_cache_adapter_identity_binding',
    ],
    application: [
      'pipeline_cache_application_refresh_proof',
      'pipeline_cache_application_invalidation_proof',
      'pipeline_cache_application_identity_binding',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
    runtime: [
      'pipeline_cache_runtime_refresh_proof',
      'pipeline_cache_runtime_invalidation_proof',
      'pipeline_cache_runtime_identity_binding',
    ],
    engine: [
      'pipeline_cache_engine_refresh_proof',
      'pipeline_cache_engine_invalidation_proof',
      'pipeline_cache_engine_identity_binding',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
    opaque_external: [
      'pipeline_cache_opaque_external_refresh_proof',
      'pipeline_cache_opaque_external_invalidation_proof',
      'pipeline_cache_opaque_external_identity_binding',
      'opaque_pipeline_cache_owner_explicit_app_hook_contract',
      'opaque_pipeline_cache_owner_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  artifactMaterializationModel: {
    ahead_of_time: ['ahead_of_time_materialized_artifact_identity_binding'],
    runtime_compile: [
      'runtime_compile_exact_input_binding',
      'runtime_compile_exact_options_binding',
      'runtime_compile_materialized_artifact_identity',
      'runtime_compile_artifact_load_epoch_chain',
    ],
    runtime_jit: [
      'runtime_jit_exact_input_binding',
      'runtime_jit_exact_options_binding',
      'runtime_jit_materialized_artifact_identity',
      'runtime_jit_artifact_load_epoch_chain',
    ],
    opaque: [
      'opaque_materialization_explicit_app_hook_contract',
      'opaque_materialization_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  dispatchBindingModel: {
    direct: ['direct_dispatch_changed_artifact_binding'],
    indirect: [
      'indirect_dispatch_producer_epoch_binding',
      'indirect_dispatch_value_epoch_binding',
      'indirect_dispatch_stale_value_rejection',
    ],
    captured_graph: [
      'graph_node_or_executable_update_or_reinstantiation',
      'graph_new_artifact_binding',
      'graph_executable_epoch_binding',
      'graph_old_executable_retirement',
    ],
    indirect_captured_graph: [
      'indirect_dispatch_producer_epoch_binding',
      'indirect_dispatch_value_epoch_binding',
      'indirect_dispatch_stale_value_rejection',
      'graph_node_or_executable_update_or_reinstantiation',
      'graph_new_artifact_binding',
      'graph_executable_epoch_binding',
      'graph_old_executable_retirement',
    ],
    opaque: [
      'opaque_dispatch_binding_explicit_app_hook_contract',
      'opaque_dispatch_binding_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  resourceBindingModel: {
    fixed_layout: ['fixed_resource_layout_identity_binding'],
    descriptor_layout: [
      'descriptor_layout_compatibility_proof',
      'descriptor_layout_migration_proof',
      'descriptor_layout_epoch_binding',
    ],
    bindless: [
      'bindless_table_version_binding',
      'bindless_table_artifact_epoch_binding',
      'bindless_stale_mapping_rejection',
    ],
    opaque: [
      'opaque_resource_binding_explicit_app_hook_contract',
      'opaque_resource_binding_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  deviceTopology: {
    single_device: ['single_device_membership_binding'],
    device_group: [
      'device_group_membership_binding',
      'per_participant_dispatch_binding',
      'per_participant_output_binding',
    ],
    multi_device: [
      'multi_device_membership_binding',
      'per_participant_dispatch_binding',
      'per_participant_output_binding',
      'inter_device_transfer_binding',
      'inter_device_transfer_retirement',
    ],
    opaque: [
      'opaque_device_topology_explicit_app_hook_contract',
      'opaque_device_topology_runtime_boundary_evidence',
      'opaque_device_topology_conservative_membership_binding',
      'per_participant_dispatch_binding',
      'per_participant_output_binding',
      'opaque_device_topology_transfer_completion_binding',
      'opaque_device_topology_retirement_binding',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  synchronizationTopology: {
    single_queue_ordered: [
      'single_queue_ordering_proof',
      'single_queue_retirement_ordering',
    ],
    single_queue_explicit: [
      'single_queue_explicit_ordering_proof',
      'single_queue_fence_epoch_binding',
      'single_queue_retirement_fence',
    ],
    multi_queue: [
      'multi_queue_dependency_ordering_proof',
      'multi_queue_fence_epoch_binding',
      'multi_queue_retirement_fence',
    ],
    multi_device: [
      'multi_device_dependency_ordering_proof',
      'multi_device_fence_epoch_binding',
      'multi_device_transfer_completion_binding',
      'multi_device_retirement_fence',
    ],
    opaque: [
      'opaque_synchronization_explicit_app_hook_contract',
      'opaque_synchronization_runtime_boundary_evidence',
      'opaque_synchronization_conservative_ordering_proof',
      'opaque_synchronization_conservative_fence_binding',
      'opaque_synchronization_conservative_retirement_binding',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  stateContinuityModel: {
    stateless: ['stateful_allocation_absence_proof'],
    persistent_retained: [
      'persistent_allocation_identity_retention',
      'persistent_allocation_schema_retention',
      'persistent_state_epoch_binding',
    ],
    explicit_migration: [
      'state_migration_source_destination_schema_binding',
      'state_migration_before_dispatch_ordering',
      'state_migration_oracle_binding',
      'old_state_retirement_after_migration',
    ],
    declared_reset: [
      'declared_state_reset_before_dispatch_ordering',
      'declared_state_reset_oracle_binding',
      'pre_reset_state_stale_use_rejection',
    ],
    opaque: [
      'opaque_state_continuity_explicit_app_hook_contract',
      'opaque_state_continuity_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  rayTracingStateModel: {
    none: ['ray_tracing_state_absence_proof'],
    acceleration_structures: [
      'acceleration_structure_identity_epoch_binding',
      'acceleration_structure_dependency_binding',
      'acceleration_structure_retirement',
    ],
    shader_tables: [
      'shader_table_identity_epoch_binding',
      'shader_table_dependency_binding',
      'shader_table_retirement',
    ],
    acceleration_structures_and_shader_tables: [
      'acceleration_structure_identity_epoch_binding',
      'acceleration_structure_dependency_binding',
      'shader_table_identity_epoch_binding',
      'shader_table_dependency_binding',
      'acceleration_structure_shader_table_dependency_ordering',
      'acceleration_structure_retirement',
      'shader_table_retirement',
    ],
    opaque: [
      'opaque_ray_tracing_state_explicit_app_hook_contract',
      'opaque_ray_tracing_state_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
  pipelineReuseModel: {
    none: ['pipeline_reuse_identity_absence_proof'],
    cache: [
      'pipeline_cache_identity_epoch_binding',
      'pipeline_cache_invalidation_proof',
      'pipeline_cache_new_pipeline_artifact_binding',
    ],
    library: [
      'pipeline_library_identity_epoch_binding',
      'pipeline_library_relink_proof',
      'pipeline_library_new_pipeline_artifact_binding',
    ],
    cache_and_library: [
      'pipeline_cache_identity_epoch_binding',
      'pipeline_cache_invalidation_proof',
      'pipeline_library_identity_epoch_binding',
      'pipeline_library_relink_proof',
      'pipeline_cache_library_new_pipeline_artifact_binding',
    ],
    opaque: [
      'opaque_pipeline_reuse_explicit_app_hook_contract',
      'opaque_pipeline_reuse_runtime_boundary_evidence',
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
    ],
  },
};

const EXPECTED_PARTICIPANT_TOPOLOGIES = ['device_group', 'multi_device', 'opaque'];
const EXPECTED_CROSS_SYNCHRONIZATION = ['multi_queue', 'multi_device', 'opaque'];
const EXPECTED_INTERACTION_OBLIGATIONS = [
  {
    when: { artifactFormat: ['execution_graph'], dispatchBindingModel: ['direct'] },
    obligations: [
      'direct_graph_node_or_executable_resolution',
      'direct_graph_dispatch_new_artifact_epoch_binding',
      'direct_graph_executable_retirement_after_dispatch',
    ],
  },
  {
    when: { artifactFormat: ['execution_graph'], dispatchBindingModel: ['indirect'] },
    obligations: [
      'indirect_graph_producer_to_node_or_executable_binding',
      'indirect_graph_value_new_artifact_epoch_binding',
      'indirect_graph_executable_retirement_after_dispatch',
    ],
  },
  {
    when: { artifactFormat: ['execution_graph'], dispatchBindingModel: ['opaque'] },
    obligations: [
      'opaque_graph_dispatch_node_or_executable_update_or_reinstantiation',
      'opaque_graph_dispatch_new_artifact_binding',
      'opaque_graph_dispatch_epoch_and_retirement_binding',
    ],
  },
  {
    when: {
      deviceTopology: ['multi_device'],
      synchronizationTopology: [
        'single_queue_ordered',
        'single_queue_explicit',
        'multi_queue',
      ],
    },
    obligations: [
      'multi_device_composed_synchronization_participant_ordering',
      'multi_device_composed_synchronization_fence_binding',
      'multi_device_composed_transfer_completion_binding',
      'multi_device_composed_synchronization_retirement',
    ],
  },
  {
    when: {
      deviceTopology: ['single_device', 'device_group'],
      synchronizationTopology: ['multi_device'],
    },
    obligations: [
      'multi_device_synchronization_conservative_participant_membership',
      'multi_device_synchronization_conservative_output_binding',
      'multi_device_synchronization_conservative_transfer_completion',
      'multi_device_synchronization_conservative_retirement',
    ],
  },
  {
    when: { deviceTopology: ['multi_device'], synchronizationTopology: ['opaque'] },
    obligations: [
      'opaque_multi_device_synchronization_participant_ordering',
      'opaque_multi_device_synchronization_fence_binding',
      'opaque_multi_device_synchronization_retirement_binding',
    ],
  },
  {
    when: { deviceTopology: ['opaque'], synchronizationTopology: ['multi_device'] },
    obligations: [
      'opaque_topology_multi_device_participant_membership_binding',
      'opaque_topology_multi_device_transfer_completion_binding',
      'opaque_topology_multi_device_retirement_binding',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      stateContinuityModel: ['persistent_retained'],
    },
    obligations: [
      'per_participant_state_identity_binding',
      'per_participant_persistent_state_schema_binding',
      'per_participant_persistent_state_oracle_binding',
      'per_participant_state_transition_completion',
      'per_participant_state_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      stateContinuityModel: ['explicit_migration'],
    },
    obligations: [
      'per_participant_state_identity_binding',
      'per_participant_state_migration_ordering',
      'per_participant_state_migration_oracle_binding',
      'per_participant_state_transition_completion',
      'per_participant_state_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      commandRecordingModel: ['pre_recorded_commands', 'opaque_engine_managed'],
    },
    obligations: [
      'per_participant_command_invalidation',
      'per_participant_command_rerecord',
      'per_participant_command_new_artifact_binding',
      'per_participant_command_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      stateContinuityModel: ['declared_reset'],
    },
    obligations: [
      'per_participant_state_identity_binding',
      'per_participant_state_reset_ordering',
      'per_participant_state_reset_oracle_binding',
      'per_participant_state_transition_completion',
      'per_participant_state_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      stateContinuityModel: ['opaque'],
    },
    obligations: [
      'per_participant_state_identity_binding',
      'per_participant_opaque_state_migration_or_reset_boundary',
      'per_participant_opaque_state_oracle_binding',
      'per_participant_state_transition_completion',
      'per_participant_state_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      resourceBindingModel: ['descriptor_layout'],
    },
    obligations: [
      'per_participant_descriptor_layout_compatibility',
      'per_participant_descriptor_layout_migration',
      'per_participant_descriptor_layout_version_binding',
      'per_participant_descriptor_stale_mapping_rejection',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      resourceBindingModel: ['bindless'],
    },
    obligations: [
      'per_participant_bindless_table_version_binding',
      'per_participant_bindless_table_epoch_binding',
      'per_participant_bindless_stale_mapping_rejection',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      resourceBindingModel: ['opaque'],
    },
    obligations: [
      'per_participant_opaque_resource_layout_binding',
      'per_participant_opaque_resource_table_version_binding',
      'per_participant_opaque_resource_stale_mapping_rejection',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      rayTracingStateModel: ['acceleration_structures'],
    },
    obligations: [
      'per_participant_acceleration_structure_epoch_binding',
      'per_participant_acceleration_structure_dependency_binding',
      'per_participant_acceleration_structure_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      rayTracingStateModel: ['shader_tables'],
    },
    obligations: [
      'per_participant_shader_table_epoch_binding',
      'per_participant_shader_table_dependency_binding',
      'per_participant_shader_table_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      rayTracingStateModel: ['acceleration_structures_and_shader_tables'],
    },
    obligations: [
      'per_participant_acceleration_structure_epoch_binding',
      'per_participant_acceleration_structure_dependency_binding',
      'per_participant_shader_table_epoch_binding',
      'per_participant_shader_table_dependency_binding',
      'per_participant_acceleration_structure_shader_table_ordering',
      'per_participant_acceleration_structure_retirement',
      'per_participant_shader_table_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      rayTracingStateModel: ['opaque'],
    },
    obligations: [
      'per_participant_opaque_ray_state_epoch_binding',
      'per_participant_opaque_ray_state_dependency_binding',
      'per_participant_opaque_ray_state_retirement',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      pipelineReuseModel: ['cache'],
    },
    obligations: [
      'per_participant_pipeline_cache_input_binding',
      'per_participant_pipeline_cache_invalidation',
      'per_participant_pipeline_identity_binding',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      pipelineReuseModel: ['library'],
    },
    obligations: [
      'per_participant_pipeline_library_input_binding',
      'per_participant_pipeline_library_relink',
      'per_participant_pipeline_identity_binding',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      pipelineReuseModel: ['cache_and_library'],
    },
    obligations: [
      'per_participant_pipeline_cache_input_binding',
      'per_participant_pipeline_cache_invalidation',
      'per_participant_pipeline_library_input_binding',
      'per_participant_pipeline_library_relink',
      'per_participant_pipeline_identity_binding',
    ],
  },
  {
    when: {
      deviceTopology: EXPECTED_PARTICIPANT_TOPOLOGIES,
      pipelineReuseModel: ['opaque'],
    },
    obligations: [
      'per_participant_opaque_pipeline_cache_or_library_input_binding',
      'per_participant_opaque_pipeline_invalidation_or_relink',
      'per_participant_pipeline_identity_binding',
    ],
  },
  {
    when: {
      synchronizationTopology: EXPECTED_CROSS_SYNCHRONIZATION,
      stateContinuityModel: EXPECTED_ENUMS_BY_FIELD.stateContinuityModel,
    },
    obligations: [
      'state_cross_queue_or_device_ordering',
      'state_cross_queue_or_device_fence_binding',
      'state_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: EXPECTED_CROSS_SYNCHRONIZATION,
      resourceBindingModel: EXPECTED_ENUMS_BY_FIELD.resourceBindingModel,
    },
    obligations: [
      'resource_cross_queue_or_device_ordering',
      'resource_cross_queue_or_device_fence_binding',
      'resource_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: EXPECTED_CROSS_SYNCHRONIZATION,
      rayTracingStateModel: EXPECTED_ENUMS_BY_FIELD.rayTracingStateModel,
    },
    obligations: [
      'ray_state_cross_queue_or_device_ordering',
      'ray_state_cross_queue_or_device_fence_binding',
      'ray_state_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: EXPECTED_CROSS_SYNCHRONIZATION,
      pipelineReuseModel: EXPECTED_ENUMS_BY_FIELD.pipelineReuseModel,
    },
    obligations: [
      'pipeline_reuse_cross_queue_or_device_ordering',
      'pipeline_reuse_cross_queue_or_device_fence_binding',
      'pipeline_reuse_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: EXPECTED_CROSS_SYNCHRONIZATION,
      commandRecordingModel: EXPECTED_ENUMS_BY_FIELD.commandRecordingModel,
    },
    obligations: [
      'command_recording_cross_queue_or_device_ordering',
      'command_recording_cross_queue_or_device_fence_binding',
      'command_recording_cross_queue_or_device_retirement',
    ],
  },
];

function expectedObligations(input) {
  const expected = new Set(EXPECTED_BASE_OBLIGATIONS);
  for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2) {
    for (const obligation of EXPECTED_RULE_OBLIGATIONS[field][input[field]]) {
      expected.add(obligation);
    }
  }
  for (const interaction of EXPECTED_INTERACTION_OBLIGATIONS) {
    const matches = Object.entries(interaction.when).every(
      ([field, values]) => values.includes(input[field]),
    );
    if (matches) interaction.obligations.forEach((obligation) => expected.add(obligation));
  }
  return [...expected].sort();
}

function assertCompleteObligations(facet, input, label = '') {
  assert.deepEqual(
    [...facet.obligations].sort(),
    expectedObligations(input),
    label,
  );
  assert.equal(new Set(facet.obligations).size, facet.obligations.length, label);
}

function baseInput(overrides = {}) {
  return {
    artifactFormat: 'native_binary',
    outputModality: 'compute',
    oracleKind: 'buffer_checksum',
    publicationModel: 'dispatch_table_epoch',
    commandRecordingModel: 'late_bound_dispatch',
    pipelineCacheOwner: 'none',
    artifactMaterializationModel: 'ahead_of_time',
    dispatchBindingModel: 'direct',
    resourceBindingModel: 'fixed_layout',
    deviceTopology: 'single_device',
    synchronizationTopology: 'single_queue_ordered',
    stateContinuityModel: 'stateless',
    rayTracingStateModel: 'none',
    pipelineReuseModel: 'none',
    evidenceRefs: ['evidence:load', 'evidence:dispatch', 'evidence:oracle'],
    ...overrides,
  };
}

function supportOnly(value) {
  assert.equal(value.acceptedAsSupportEvidence, false);
  assert.equal(value.acceptedForGpuHmr, false);
  assert.equal(value.gpuHmrSuccess, false);
  assert.equal(value.canSatisfyRuntimeProof, false);
  assert.equal(value.canSatisfyDispatchProof, false);
}

function validInput(overrides = {}) {
  const input = baseInput(overrides);
  const explicitlySet = new Set(Object.keys(overrides));
  const setUnlessExplicit = (field, value) => {
    if (!explicitlySet.has(field)) input[field] = value;
  };
  if (explicitlySet.has('oracleKind') && !explicitlySet.has('outputModality')) {
    const classification = classifyGpuHmrOutputOracleKind(input.oracleKind);
    if (classification.accepted) input.outputModality = classification.modality;
  } else if (!explicitlySet.has('oracleKind')) {
    input.oracleKind = input.outputModality === 'visual'
      ? 'render_target_hash'
      : 'buffer_checksum';
  }
  if (input.pipelineReuseModel === 'none') {
    setUnlessExplicit('pipelineCacheOwner', 'none');
  } else if ((input.pipelineReuseModel === 'cache'
      || input.pipelineReuseModel === 'cache_and_library')
    && input.pipelineCacheOwner === 'none') {
    setUnlessExplicit('pipelineCacheOwner', 'adapter');
  }
  if (input.pipelineCacheOwner === 'none') {
    setUnlessExplicit('pipelineReuseModel', 'none');
  } else if (input.pipelineReuseModel === 'none') {
    setUnlessExplicit('pipelineReuseModel', 'cache');
  }
  return input;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const expectedFields = [
  'artifactFormat',
  'outputModality',
  'oracleKind',
  'publicationModel',
  'commandRecordingModel',
  'pipelineCacheOwner',
  'artifactMaterializationModel',
  'dispatchBindingModel',
  'resourceBindingModel',
  'deviceTopology',
  'synchronizationTopology',
  'stateContinuityModel',
  'rayTracingStateModel',
  'pipelineReuseModel',
  'evidenceRefs',
];
assert.deepEqual(GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2, expectedFields);
assert.deepEqual(
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2,
  expectedFields.filter((field) => field !== 'evidenceRefs'),
);
assert.equal(GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2.length, 14);
assert.equal(Object.keys(EXPECTED_ENUMS_BY_FIELD).length, 14);
assert.equal(GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION.endsWith('.v2'), true);
assert.equal(GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY.includes('v2'), true);
const v2ExportNames = Object.keys(await import(
  '../lib/gpu-hmr-runtime-adapter-capabilities-v2.mjs'
));
assert.deepEqual(
  v2ExportNames.filter((name) => !name.includes('V2')),
  [],
  'v2 module must not shadow the unversioned legacy API',
);
assert.deepEqual(EXPORTED_ENUMS_BY_FIELD, EXPECTED_ENUMS_BY_FIELD);
assert.deepEqual(GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS, EXPECTED_COMPUTE_ORACLES);
assert.deepEqual(GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS, EXPECTED_VISUAL_ORACLES);
assert.deepEqual(GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS, EXPECTED_ALL_ORACLES);

const baselineInput = baseInput();
const baseline = createGpuHmrRuntimeAdapterCapabilitiesV2(baselineInput);
supportOnly(baseline);
assert.equal(baseline.valid, true);
assert.equal(Object.isFrozen(baseline), true);
assert.equal(Object.isFrozen(baseline.evidenceRefs), true);
assert.equal(Object.isFrozen(baseline.obligations), true);
assertCompleteObligations(baseline, baseInput(), 'baseline');
assert.notEqual(baseline.capabilitiesHash, baseline.obligationsHash);
assert.notEqual(baseline.capabilitiesHash, baseline.bindingHash);
assert.match(baseline.capabilitiesHash, /^sha256:[0-9a-f]{64}$/);
assert.match(baseline.obligationsHash, /^sha256:[0-9a-f]{64}$/);
assert.match(baseline.bindingHash, /^sha256:[0-9a-f]{64}$/);
for (const obligation of EXPECTED_BASE_OBLIGATIONS) {
  assert.ok(baseline.obligations.includes(obligation), obligation);
}

const reorderedEvidence = createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
  evidenceRefs: [...baselineInput.evidenceRefs].reverse(),
}));
assert.equal(reorderedEvidence.proofId, baseline.proofId);
const changedEvidence = createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
  evidenceRefs: ['evidence:different'],
}));
assert.notEqual(changedEvidence.capabilitiesHash, baseline.capabilitiesHash);
assert.notEqual(changedEvidence.bindingHash, baseline.bindingHash);

baselineInput.artifactFormat = 'portable_ir';
baselineInput.evidenceRefs[0] = 'evidence:mutated';
assert.equal(baseline.artifactFormat, 'native_binary');
assert.ok(baseline.evidenceRefs.includes('evidence:load'));
assert.throws(() => baseline.evidenceRefs.push('evidence:forbidden'), TypeError);
assert.throws(() => baseline.obligations.push('caller_claim'), TypeError);

let ruleFacets = 0;
for (const [field, values] of Object.entries(ENUMS_BY_FIELD)) {
  for (const value of values) {
    const input = validInput({ [field]: value });
    const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
    assert.equal(facet[field], value, `${field}:${value}`);
    supportOnly(facet);
    for (const obligation of EXPECTED_RULE_OBLIGATIONS[field][value]) {
      assert.ok(facet.obligations.includes(obligation), `${field}:${value}:${obligation}`);
    }
    assertCompleteObligations(facet, input, `${field}:${value}`);
    ruleFacets += 1;
  }
}

const visualFacet = createGpuHmrRuntimeAdapterCapabilitiesV2(validInput({
  outputModality: 'visual',
}));
assert.equal(visualFacet.oracleKind, 'render_target_hash');
assert.ok(visualFacet.obligations.includes('visual_verified_diff_bytes'));
assert.equal(visualFacet.obligations.includes('compute_raw_readback_bytes'), false);
assert.ok(baseline.obligations.includes('compute_raw_readback_bytes'));
assert.equal(baseline.obligations.includes('visual_verified_diff_bytes'), false);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({ oracleKind: ' BUFFER_CHECKSUM ' })),
  /oracle_kind_not_canonical/,
);
for (const oracleKind of EXPECTED_COMPUTE_ORACLES) {
  assert.equal(classifyGpuHmrOutputOracleKind(oracleKind).modality, 'compute');
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
      outputModality: 'visual',
      oracleKind,
    })),
    /oracle_kind_modality_mismatch/,
    oracleKind,
  );
}
for (const oracleKind of EXPECTED_VISUAL_ORACLES) {
  assert.equal(classifyGpuHmrOutputOracleKind(oracleKind).modality, 'visual');
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
      outputModality: 'compute',
      oracleKind,
    })),
    /oracle_kind_modality_mismatch/,
    oracleKind,
  );
}

const opaqueCases = [
  ['artifactFormat', 'opaque_payload', 'opaque_payload'],
  ['publicationModel', 'opaque_callback_epoch', 'opaque_callback_epoch'],
  ['commandRecordingModel', 'opaque_engine_managed', 'opaque_command_recording'],
  ['pipelineCacheOwner', 'opaque_external', 'opaque_pipeline_cache_owner'],
  ['artifactMaterializationModel', 'opaque', 'opaque_materialization'],
  ['dispatchBindingModel', 'opaque', 'opaque_dispatch_binding'],
  ['resourceBindingModel', 'opaque', 'opaque_resource_binding'],
  ['deviceTopology', 'opaque', 'opaque_device_topology'],
  ['synchronizationTopology', 'opaque', 'opaque_synchronization'],
  ['stateContinuityModel', 'opaque', 'opaque_state_continuity'],
  ['rayTracingStateModel', 'opaque', 'opaque_ray_tracing_state'],
  ['pipelineReuseModel', 'opaque', 'opaque_pipeline_reuse'],
];
for (const [field, value, prefix] of opaqueCases) {
  const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(validInput({ [field]: value }));
  assert.ok(facet.obligations.includes('explicit_app_hook_contract'), field);
  assert.ok(facet.obligations.includes('runtime_boundary_evidence'), field);
  assert.ok(facet.obligations.includes(`${prefix}_explicit_app_hook_contract`), field);
  assert.ok(facet.obligations.includes(`${prefix}_runtime_boundary_evidence`), field);
  supportOnly(facet);
  assertCompleteObligations(facet, validInput({ [field]: value }), field);
}

assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
    pipelineCacheOwner: 'none',
    pipelineReuseModel: 'cache',
  })),
  /pipeline_reuse_cache_owner_required/,
);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
    pipelineCacheOwner: 'none',
    pipelineReuseModel: 'cache_and_library',
  })),
  /pipeline_reuse_cache_owner_required/,
);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
    pipelineCacheOwner: 'runtime',
    pipelineReuseModel: 'none',
  })),
  /pipeline_reuse_cache_owner_none_mismatch/,
);
for (const input of [
  baseInput({ pipelineCacheOwner: 'none', pipelineReuseModel: 'library' }),
  baseInput({ pipelineCacheOwner: 'runtime', pipelineReuseModel: 'library' }),
  baseInput({ pipelineCacheOwner: 'none', pipelineReuseModel: 'opaque' }),
  baseInput({ pipelineCacheOwner: 'opaque_external', pipelineReuseModel: 'opaque' }),
]) {
  const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
  supportOnly(facet);
  assertCompleteObligations(facet, input, 'decoupled pipeline reuse');
}
const formerlyRejectedCombinations = [
  baseInput({
    deviceTopology: 'multi_device',
    synchronizationTopology: 'single_queue_ordered',
  }),
  baseInput({
    deviceTopology: 'multi_device',
    synchronizationTopology: 'single_queue_explicit',
  }),
  baseInput({
    deviceTopology: 'multi_device',
    synchronizationTopology: 'multi_queue',
  }),
  baseInput({
    deviceTopology: 'single_device',
    synchronizationTopology: 'multi_device',
  }),
  baseInput({
    deviceTopology: 'device_group',
    synchronizationTopology: 'multi_device',
  }),
  baseInput({
    artifactFormat: 'execution_graph',
    dispatchBindingModel: 'direct',
  }),
  baseInput({
    artifactFormat: 'execution_graph',
    dispatchBindingModel: 'indirect',
  }),
];
const formerlyRejectedFacets = formerlyRejectedCombinations.map((input) => {
  const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
  supportOnly(facet);
  assertCompleteObligations(facet, input, 'formerly rejected generic combination');
  return facet;
});
assert.ok(formerlyRejectedFacets[2].obligations.includes(
  'multi_device_composed_synchronization_participant_ordering',
));
assert.ok(formerlyRejectedFacets[5].obligations.includes(
  'direct_graph_dispatch_new_artifact_epoch_binding',
));
assert.ok(formerlyRejectedFacets[6].obligations.includes(
  'indirect_graph_value_new_artifact_epoch_binding',
));

const acceptedOpaqueCombinations = [
  baseInput({
    deviceTopology: 'multi_device',
    synchronizationTopology: 'opaque',
  }),
  baseInput({
    deviceTopology: 'opaque',
    synchronizationTopology: 'multi_device',
  }),
  baseInput({
    artifactFormat: 'execution_graph',
    dispatchBindingModel: 'opaque',
  }),
];
for (const input of acceptedOpaqueCombinations) {
  const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
  supportOnly(facet);
  assert.ok(facet.obligations.includes('explicit_app_hook_contract'));
  assert.ok(facet.obligations.includes('runtime_boundary_evidence'));
  assertCompleteObligations(facet, input, 'accepted opaque combination');
}
for (const deviceTopology of EXPECTED_PARTICIPANT_TOPOLOGIES) {
  for (const stateContinuityModel of [
    'persistent_retained',
    'explicit_migration',
    'declared_reset',
    'opaque',
  ]) {
    const input = validInput({ deviceTopology, stateContinuityModel });
    const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
    assert.ok(facet.obligations.includes('per_participant_state_identity_binding'));
    assert.ok(facet.obligations.includes('per_participant_state_transition_completion'));
    assert.ok(facet.obligations.includes('per_participant_state_retirement'));
    assertCompleteObligations(facet, input, `${deviceTopology}:${stateContinuityModel}`);
  }
  for (const resourceBindingModel of ['descriptor_layout', 'bindless', 'opaque']) {
    const input = validInput({ deviceTopology, resourceBindingModel });
    const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
    assert.ok(facet.obligations.some((entry) =>
      entry.startsWith('per_participant_') && entry.includes('stale_mapping_rejection')));
    assertCompleteObligations(facet, input, `${deviceTopology}:${resourceBindingModel}`);
  }
  for (const rayTracingStateModel of [
    'acceleration_structures',
    'shader_tables',
    'acceleration_structures_and_shader_tables',
    'opaque',
  ]) {
    const input = validInput({ deviceTopology, rayTracingStateModel });
    const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
    assert.ok(facet.obligations.some((entry) =>
      entry.startsWith('per_participant_') && entry.endsWith('_retirement')));
    assertCompleteObligations(facet, input, `${deviceTopology}:${rayTracingStateModel}`);
  }
  for (const pipelineReuseModel of ['cache', 'library', 'cache_and_library', 'opaque']) {
    const input = validInput({ deviceTopology, pipelineReuseModel });
    const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
    assert.ok(facet.obligations.includes('per_participant_pipeline_identity_binding'));
    assertCompleteObligations(facet, input, `${deviceTopology}:${pipelineReuseModel}`);
  }
  for (const commandRecordingModel of ['pre_recorded_commands', 'opaque_engine_managed']) {
    const input = validInput({ deviceTopology, commandRecordingModel });
    const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
    for (const obligation of [
      'per_participant_command_invalidation',
      'per_participant_command_rerecord',
      'per_participant_command_new_artifact_binding',
      'per_participant_command_retirement',
    ]) {
      assert.ok(facet.obligations.includes(obligation));
    }
    assertCompleteObligations(facet, input, `${deviceTopology}:${commandRecordingModel}`);
  }
}

for (const synchronizationTopology of EXPECTED_CROSS_SYNCHRONIZATION) {
  const input = validInput({
    synchronizationTopology,
    stateContinuityModel: 'explicit_migration',
    resourceBindingModel: 'bindless',
    rayTracingStateModel: 'acceleration_structures_and_shader_tables',
    pipelineReuseModel: 'cache_and_library',
    commandRecordingModel: 'pre_recorded_commands',
  });
  const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
  for (const domain of ['state', 'resource', 'ray_state', 'pipeline_reuse']) {
    assert.ok(facet.obligations.includes(`${domain}_cross_queue_or_device_ordering`));
    assert.ok(facet.obligations.includes(`${domain}_cross_queue_or_device_fence_binding`));
    assert.ok(facet.obligations.includes(`${domain}_cross_queue_or_device_retirement`));
  }
  for (const obligation of [
    'command_recording_cross_queue_or_device_ordering',
    'command_recording_cross_queue_or_device_fence_binding',
    'command_recording_cross_queue_or_device_retirement',
  ]) {
    assert.ok(facet.obligations.includes(obligation));
  }
  assertCompleteObligations(facet, input, `cross synchronization:${synchronizationTopology}`);
}

function pairRequestCompatible(overrides) {
  if (Object.hasOwn(overrides, 'outputModality') && Object.hasOwn(overrides, 'oracleKind')) {
    const classification = classifyGpuHmrOutputOracleKind(overrides.oracleKind);
    if (!classification.accepted || classification.modality !== overrides.outputModality) {
      return false;
    }
  }
  if (Object.hasOwn(overrides, 'pipelineCacheOwner')
    && Object.hasOwn(overrides, 'pipelineReuseModel')) {
    if (overrides.pipelineReuseModel === 'none'
      && overrides.pipelineCacheOwner !== 'none') return false;
    if (['cache', 'cache_and_library'].includes(overrides.pipelineReuseModel)
      && overrides.pipelineCacheOwner === 'none') return false;
  }
  return true;
}

const enumFields = Object.keys(ENUMS_BY_FIELD);
let pairwiseFacets = 0;
let incompatiblePairRequests = 0;
let totalPairRequests = 0;
for (let leftIndex = 0; leftIndex < enumFields.length; leftIndex += 1) {
  for (let rightIndex = leftIndex + 1; rightIndex < enumFields.length; rightIndex += 1) {
    const leftField = enumFields[leftIndex];
    const rightField = enumFields[rightIndex];
    for (const leftValue of ENUMS_BY_FIELD[leftField]) {
      for (const rightValue of ENUMS_BY_FIELD[rightField]) {
        totalPairRequests += 1;
        const requestedPair = {
          [leftField]: leftValue,
          [rightField]: rightValue,
        };
        if (!pairRequestCompatible(requestedPair)) {
          incompatiblePairRequests += 1;
          continue;
        }
        const input = validInput(requestedPair);
        const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(input);
        assert.equal(facet[leftField], leftValue);
        assert.equal(facet[rightField], rightValue);
        supportOnly(facet);
        assertCompleteObligations(facet, input, `${leftField}:${rightField}`);
        pairwiseFacets += 1;
      }
    }
  }
}
assert.equal(incompatiblePairRequests, 31);
assert.equal(pairwiseFacets, totalPairRequests - incompatiblePairRequests);

let randomState = 0x6d2b79f5;
function random() {
  randomState = (Math.imul(randomState ^ (randomState >>> 15), 1 | randomState)
    + 0x6d2b79f5) | 0;
  return ((randomState ^ (randomState >>> 14)) >>> 0) / 0x100000000;
}
for (let iteration = 0; iteration < 256; iteration += 1) {
  const overrides = Object.fromEntries(Object.entries(ENUMS_BY_FIELD).map(
    ([field, values]) => [field, values[Math.floor(random() * values.length)]],
  ));
  const compatibleOracles = overrides.outputModality === 'compute'
    ? EXPECTED_COMPUTE_ORACLES
    : EXPECTED_VISUAL_ORACLES;
  overrides.oracleKind = compatibleOracles[Math.floor(random() * compatibleOracles.length)];
  if (overrides.pipelineReuseModel === 'none') {
    overrides.pipelineCacheOwner = 'none';
  } else if (['cache', 'cache_and_library'].includes(overrides.pipelineReuseModel)
    && overrides.pipelineCacheOwner === 'none') {
    overrides.pipelineCacheOwner = 'runtime';
  }
  const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput(overrides));
  supportOnly(facet);
  assertCompleteObligations(facet, baseInput(overrides), `random:${iteration}`);
  assert.equal(evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(facet).valid, true);
}

for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2) {
  const missing = baseInput();
  delete missing[field];
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilitiesV2(missing),
    new RegExp(`input_missing_field:${field}`),
  );
}
for (const field of Object.keys(ENUMS_BY_FIELD)) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({ [field]: 'invalid' })),
    /_invalid/,
  );
}

const historicalInput = {
  artifactFormat: 'native_binary',
  outputModality: 'compute',
  oracleKind: 'buffer_checksum',
  publicationModel: 'dispatch_table_epoch',
  commandRecordingModel: 'late_bound_dispatch',
  pipelineCacheOwner: 'none',
  evidenceRefs: ['evidence:historical'],
};
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(historicalInput),
  /input_missing_field:artifactMaterializationModel/,
);
assert.equal(
  evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity({
    schemaVersion: 'synthi.gpu_hmr.runtime_adapter_capabilities.v1',
    ...historicalInput,
  }).valid,
  false,
);

for (const callerAuthorityField of [
  'schemaVersion',
  'authority',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'obligations',
  'capabilitiesHash',
  'obligationsHash',
  'bindingHash',
  'proofId',
]) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilitiesV2({
      ...baseInput(),
      [callerAuthorityField]: true,
    }),
    /input_unknown_field/,
  );
}

for (const selectorField of [
  'projectName',
  'repositoryName',
  'backendName',
  'apiName',
  'engineName',
  'profileName',
  'targetName',
  'fixtureName',
  'libraryName',
  'scenarioName',
]) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilitiesV2({
      ...baseInput(),
      [selectorField]: 'caller-selected',
    }),
    /input_unknown_field/,
  );
}

const facts = Object.fromEntries(
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2.map(
    (field) => [field, baseInput()[field]],
  ),
);
assert.deepEqual(
  deriveGpuHmrRuntimeAdapterCapabilityObligationsV2(facts),
  baseline.obligations,
);
for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2) {
  const missing = { ...facts };
  delete missing[field];
  assert.throws(
    () => deriveGpuHmrRuntimeAdapterCapabilityObligationsV2(missing),
    /facts_missing_field/,
  );
}

let inputProxyTrapCalled = false;
const inputProxy = new Proxy(baseInput(), {
  ownKeys() {
    inputProxyTrapCalled = true;
    throw new Error('must not invoke proxy trap');
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(inputProxy),
  /input_proxy_forbidden/,
);
assert.equal(inputProxyTrapCalled, false);

let inputAccessorCalled = false;
const accessorInput = baseInput();
Object.defineProperty(accessorInput, 'artifactFormat', {
  enumerable: true,
  get() {
    inputAccessorCalled = true;
    return 'native_binary';
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(accessorInput),
  /input_accessor_forbidden/,
);
assert.equal(inputAccessorCalled, false);

const symbolInput = baseInput();
symbolInput[Symbol('authority')] = true;
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(symbolInput),
  /input_symbol_key_forbidden/,
);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(
    Object.assign(Object.create(null), baseInput()),
  ),
  /input_must_be_plain_data_record/,
);

let refsProxyTrapCalled = false;
const refsProxy = new Proxy(['evidence:one'], {
  getOwnPropertyDescriptor() {
    refsProxyTrapCalled = true;
    throw new Error('must not invoke proxy trap');
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({ evidenceRefs: refsProxy })),
  /evidence_refs_proxy_forbidden/,
);
assert.equal(refsProxyTrapCalled, false);

let refsAccessorCalled = false;
const accessorRefs = ['evidence:placeholder'];
Object.defineProperty(accessorRefs, '0', {
  enumerable: true,
  get() {
    refsAccessorCalled = true;
    return 'evidence:one';
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
    evidenceRefs: accessorRefs,
  })),
  /evidence_refs_accessor_forbidden/,
);
assert.equal(refsAccessorCalled, false);

const sparseRefs = new Array(1);
const refsWithExtra = ['evidence:one'];
refsWithExtra.extra = 'forbidden';
for (const invalidRefs of [
  [],
  sparseRefs,
  refsWithExtra,
  [''],
  [' evidence:one'],
  ['evidence:one\n'],
  [42],
  ['evidence:duplicate', 'evidence:duplicate'],
  ['x'.repeat(GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REF_BYTES + 1)],
  Array.from(
    { length: GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REFS + 1 },
    (_, index) => `evidence:${index}`,
  ),
]) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilitiesV2(baseInput({
      evidenceRefs: invalidRefs,
    })),
    /evidence_ref|evidence_refs/,
  );
}

const replayed = clone(baseline);
const replayIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(replayed);
assert.equal(replayIntegrity.valid, true);
supportOnly(replayIntegrity);
assert.equal(replayIntegrity.recomputedFacet.proofId, baseline.proofId);
assert.equal(Object.isFrozen(replayIntegrity), true);
assert.equal(Object.isFrozen(replayIntegrity.failures), true);

for (const [field, value] of [
  ['authority', 'caller_authority'],
  ['schemaVersion', 'synthi.gpu_hmr.runtime_adapter_capabilities.v1'],
  ['capabilitiesHash', `sha256:${'0'.repeat(64)}`],
  ['obligationsHash', `sha256:${'1'.repeat(64)}`],
  ['bindingHash', `sha256:${'2'.repeat(64)}`],
  ['proofId', 'caller-proof'],
  ['acceptedAsSupportEvidence', true],
  ['acceptedForGpuHmr', true],
  ['gpuHmrSuccess', true],
  ['canSatisfyRuntimeProof', true],
  ['canSatisfyDispatchProof', true],
]) {
  const tampered = clone(baseline);
  tampered[field] = value;
  const result = evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(tampered);
  assert.equal(result.valid, false, field);
  supportOnly(result);
  assert.equal(result.recomputedFacet, null);
}

const tamperedObligations = clone(baseline);
tamperedObligations.obligations[0] = 'caller_claim';
assert.equal(
  evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(tamperedObligations).valid,
  false,
);
const extraFacetField = clone(baseline);
extraFacetField.callerClaim = true;
assert.equal(
  evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(extraFacetField).valid,
  false,
);

let facetProxyTrapCalled = false;
const facetProxy = new Proxy(clone(baseline), {
  ownKeys() {
    facetProxyTrapCalled = true;
    throw new Error('must not invoke proxy trap');
  },
});
const proxyIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(facetProxy);
assert.equal(proxyIntegrity.valid, false);
assert.ok(proxyIntegrity.failures.some((failure) => failure.endsWith('_proxy')));
assert.equal(facetProxyTrapCalled, false);

let facetAccessorCalled = false;
const accessorFacet = clone(baseline);
Object.defineProperty(accessorFacet, 'authority', {
  enumerable: true,
  get() {
    facetAccessorCalled = true;
    return GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY;
  },
});
const accessorIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(accessorFacet);
assert.equal(accessorIntegrity.valid, false);
assert.ok(accessorIntegrity.failures.some((failure) => failure.endsWith('_accessor_property')));
assert.equal(facetAccessorCalled, false);

const symbolFacet = clone(baseline);
symbolFacet[Symbol('claim')] = true;
assert.equal(evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(symbolFacet).valid, false);
const cyclicFacet = clone(baseline);
cyclicFacet.evidenceRefs.push(cyclicFacet);
const cycleIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(cyclicFacet);
assert.equal(cycleIntegrity.valid, false);
assert.ok(cycleIntegrity.failures.some((failure) => failure.endsWith('_cycle')));

const oversizeArrayFacet = clone(baseline);
oversizeArrayFacet.extra = Array.from({ length: 129 }, () => null);
assert.ok(evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(oversizeArrayFacet)
  .failures.some((failure) => failure.endsWith('_array_shape')));
const oversizeStringFacet = clone(baseline);
oversizeStringFacet.extra = 'x'.repeat(4097);
assert.ok(evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(oversizeStringFacet)
  .failures.some((failure) => failure.endsWith('_string_bytes')));
const deepFacet = clone(baseline);
deepFacet.extra = {};
let cursor = deepFacet.extra;
for (let depth = 0; depth < 18; depth += 1) {
  cursor.next = {};
  cursor = cursor.next;
}
assert.ok(evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(deepFacet)
  .failures.some((failure) => failure.endsWith('_depth')));

const implementationSource = await readFile(
  new URL('../lib/gpu-hmr-runtime-adapter-capabilities-v2.mjs', import.meta.url),
  'utf8',
);
const forbiddenSelectorTokens = [
  'project',
  'repository',
  'backend',
  'api',
  'engine',
  'profile',
  'target',
  'fixture',
  'library',
  'scenario',
];
for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2) {
  const normalized = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const tokens = normalized.split('_');
  assert.equal(
    forbiddenSelectorTokens.some((token) => tokens.includes(token)),
    false,
    field,
  );
}
assert.doesNotMatch(
  implementationSource,
  /\b(?:project|repository|backend|api|engine|profile|target|fixture|library|scenario)(?:Name|Id|Key|Selector)\b/,
);
assert.doesNotMatch(
  implementationSource,
  /capabilities\.(?:project|repository|backend|api|engine|profile|target|fixture|library|scenario)\b/,
);

process.stdout.write(`${JSON.stringify({
  status: 'self_check_passed',
  schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
  ruleFacets,
  pairwiseFacets,
  incompatiblePairRequests,
  totalPairRequests,
  randomizedFacets: 256,
  deterministicProofId: baseline.proofId,
  acceptedAsSupportEvidence: false,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  canSatisfyRuntimeProof: false,
  canSatisfyDispatchProof: false,
}, null, 2)}\n`);
