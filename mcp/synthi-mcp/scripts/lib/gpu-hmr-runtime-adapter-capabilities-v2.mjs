import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS,
  GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS,
  classifyGpuHmrOutputOracleKind,
} from './gpu-hmr-output-oracle-kind.mjs';

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_adapter_capabilities.v2';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY =
  'caller_declared_v2_capability_obligations_only_not_evidence_or_gpu_hmr_success';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_INTEGRITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_adapter_capabilities_integrity.v2';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_INTEGRITY_AUTHORITY =
  'v2_capability_declaration_integrity_only_not_evidence_or_gpu_hmr_success';

export const GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_FORMATS = Object.freeze([
  'native_binary',
  'portable_ir',
  'runtime_source',
  'engine_asset',
  'opaque_payload',
  'execution_graph',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_OUTPUT_MODALITIES = Object.freeze([
  'compute',
  'visual',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS = Object.freeze([
  ...GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS,
  ...GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS,
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_PUBLICATION_MODELS = Object.freeze([
  'dispatch_table_epoch',
  'pipeline_object_epoch',
  'engine_managed_epoch',
  'opaque_callback_epoch',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_COMMAND_RECORDING_MODELS = Object.freeze([
  'late_bound_dispatch',
  'record_after_publication',
  'pre_recorded_commands',
  'opaque_engine_managed',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_CACHE_OWNERS = Object.freeze([
  'none',
  'adapter',
  'application',
  'runtime',
  'engine',
  'opaque_external',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_MATERIALIZATION_MODELS =
  Object.freeze(['ahead_of_time', 'runtime_compile', 'runtime_jit', 'opaque']);
export const GPU_HMR_RUNTIME_ADAPTER_V2_DISPATCH_BINDING_MODELS = Object.freeze([
  'direct',
  'indirect',
  'captured_graph',
  'indirect_captured_graph',
  'opaque',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_RESOURCE_BINDING_MODELS = Object.freeze([
  'fixed_layout',
  'descriptor_layout',
  'bindless',
  'opaque',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_DEVICE_TOPOLOGIES = Object.freeze([
  'single_device',
  'device_group',
  'multi_device',
  'opaque',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_SYNCHRONIZATION_TOPOLOGIES = Object.freeze([
  'single_queue_ordered',
  'single_queue_explicit',
  'multi_queue',
  'multi_device',
  'opaque',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_STATE_CONTINUITY_MODELS = Object.freeze([
  'stateless',
  'persistent_retained',
  'explicit_migration',
  'declared_reset',
  'opaque',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_RAY_TRACING_STATE_MODELS = Object.freeze([
  'none',
  'acceleration_structures',
  'shader_tables',
  'acceleration_structures_and_shader_tables',
  'opaque',
]);
export const GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_REUSE_MODELS = Object.freeze([
  'none',
  'cache',
  'library',
  'cache_and_library',
  'opaque',
]);

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2 = Object.freeze([
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
]);
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2 = Object.freeze(
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2.filter(
    (field) => field !== 'evidenceRefs',
  ),
);

export const GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REFS = 64;
export const GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REF_BYTES = 1024;
export const GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REFS_BYTES = 32 * 1024;

const BASE_OBLIGATIONS = [
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

const APP_HOOK_AND_BOUNDARY = [
  'explicit_app_hook_contract',
  'runtime_boundary_evidence',
];

const RULES = {
  artifactFormat: {
    native_binary: ['native_binary_artifact_identity_binding'],
    portable_ir: ['portable_ir_artifact_identity_binding'],
    runtime_source: ['runtime_source_exact_bytes_binding'],
    engine_asset: [
      'engine_asset_artifact_identity_binding',
      ...APP_HOOK_AND_BOUNDARY,
    ],
    opaque_payload: [
      'opaque_payload_explicit_app_hook_contract',
      'opaque_payload_runtime_boundary_evidence',
      ...APP_HOOK_AND_BOUNDARY,
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
  oracleKind: Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS.map((kind) => [
      kind,
      ['canonical_oracle_kind_classifier_binding'],
    ]),
  ),
  publicationModel: {
    dispatch_table_epoch: ['dispatch_table_identity_epoch_binding'],
    pipeline_object_epoch: [
      'pipeline_recreation_or_rebinding',
      'pipeline_identity_epoch_binding',
    ],
    engine_managed_epoch: [
      'engine_managed_epoch_publication_receipt',
      ...APP_HOOK_AND_BOUNDARY,
    ],
    opaque_callback_epoch: [
      'opaque_callback_epoch_explicit_app_hook_contract',
      'opaque_callback_epoch_runtime_boundary_evidence',
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
    ],
    opaque_external: [
      'pipeline_cache_opaque_external_refresh_proof',
      'pipeline_cache_opaque_external_invalidation_proof',
      'pipeline_cache_opaque_external_identity_binding',
      'opaque_pipeline_cache_owner_explicit_app_hook_contract',
      'opaque_pipeline_cache_owner_runtime_boundary_evidence',
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
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
      ...APP_HOOK_AND_BOUNDARY,
    ],
  },
};

const PARTICIPANT_TOPOLOGIES = ['device_group', 'multi_device', 'opaque'];
const CROSS_QUEUE_OR_DEVICE_SYNCHRONIZATION = ['multi_queue', 'multi_device', 'opaque'];

const INTERACTION_RULES = [
  {
    when: {
      artifactFormat: ['execution_graph'],
      dispatchBindingModel: ['direct'],
    },
    obligations: [
      'direct_graph_node_or_executable_resolution',
      'direct_graph_dispatch_new_artifact_epoch_binding',
      'direct_graph_executable_retirement_after_dispatch',
    ],
  },
  {
    when: {
      artifactFormat: ['execution_graph'],
      dispatchBindingModel: ['indirect'],
    },
    obligations: [
      'indirect_graph_producer_to_node_or_executable_binding',
      'indirect_graph_value_new_artifact_epoch_binding',
      'indirect_graph_executable_retirement_after_dispatch',
    ],
  },
  {
    when: {
      artifactFormat: ['execution_graph'],
      dispatchBindingModel: ['opaque'],
    },
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
    when: {
      deviceTopology: ['multi_device'],
      synchronizationTopology: ['opaque'],
    },
    obligations: [
      'opaque_multi_device_synchronization_participant_ordering',
      'opaque_multi_device_synchronization_fence_binding',
      'opaque_multi_device_synchronization_retirement_binding',
    ],
  },
  {
    when: {
      deviceTopology: ['opaque'],
      synchronizationTopology: ['multi_device'],
    },
    obligations: [
      'opaque_topology_multi_device_participant_membership_binding',
      'opaque_topology_multi_device_transfer_completion_binding',
      'opaque_topology_multi_device_retirement_binding',
    ],
  },
  {
    when: {
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      deviceTopology: PARTICIPANT_TOPOLOGIES,
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
      synchronizationTopology: CROSS_QUEUE_OR_DEVICE_SYNCHRONIZATION,
      stateContinuityModel: GPU_HMR_RUNTIME_ADAPTER_V2_STATE_CONTINUITY_MODELS,
    },
    obligations: [
      'state_cross_queue_or_device_ordering',
      'state_cross_queue_or_device_fence_binding',
      'state_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: CROSS_QUEUE_OR_DEVICE_SYNCHRONIZATION,
      resourceBindingModel: GPU_HMR_RUNTIME_ADAPTER_V2_RESOURCE_BINDING_MODELS,
    },
    obligations: [
      'resource_cross_queue_or_device_ordering',
      'resource_cross_queue_or_device_fence_binding',
      'resource_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: CROSS_QUEUE_OR_DEVICE_SYNCHRONIZATION,
      rayTracingStateModel: GPU_HMR_RUNTIME_ADAPTER_V2_RAY_TRACING_STATE_MODELS,
    },
    obligations: [
      'ray_state_cross_queue_or_device_ordering',
      'ray_state_cross_queue_or_device_fence_binding',
      'ray_state_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: CROSS_QUEUE_OR_DEVICE_SYNCHRONIZATION,
      pipelineReuseModel: GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_REUSE_MODELS,
    },
    obligations: [
      'pipeline_reuse_cross_queue_or_device_ordering',
      'pipeline_reuse_cross_queue_or_device_fence_binding',
      'pipeline_reuse_cross_queue_or_device_retirement',
    ],
  },
  {
    when: {
      synchronizationTopology: CROSS_QUEUE_OR_DEVICE_SYNCHRONIZATION,
      commandRecordingModel: GPU_HMR_RUNTIME_ADAPTER_V2_COMMAND_RECORDING_MODELS,
    },
    obligations: [
      'command_recording_cross_queue_or_device_ordering',
      'command_recording_cross_queue_or_device_fence_binding',
      'command_recording_cross_queue_or_device_retirement',
    ],
  },
];

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const OBLIGATION_ALGEBRA = deepFreeze({
  base: [...BASE_OBLIGATIONS],
  rules: RULES,
  interactions: INTERACTION_RULES,
});

const ENUMS_BY_FIELD = Object.freeze({
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
});
const ENUM_SETS_BY_FIELD = Object.freeze(Object.fromEntries(
  Object.entries(ENUMS_BY_FIELD).map(([field, values]) => [field, new Set(values)]),
));
const INPUT_FIELD_SET = new Set(GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2);
const FACT_FIELD_SET = new Set(GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2);
const FACET_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  ...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2,
  'obligations',
  'capabilitiesHash',
  'obligationsHash',
  'bindingHash',
  'proofId',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);
const FACET_FIELD_SET = new Set(FACET_FIELDS);
const OBLIGATION_ORDER = Object.freeze([
  ...new Set([
    ...OBLIGATION_ALGEBRA.base,
    ...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2.flatMap((field) =>
      Object.values(OBLIGATION_ALGEBRA.rules[field]).flat()),
    ...OBLIGATION_ALGEBRA.interactions.flatMap((rule) => rule.obligations),
  ]),
]);

const MAX_PLAIN_DATA_DEPTH = 16;
const MAX_PLAIN_DATA_NODES = 512;
const MAX_PLAIN_DATA_ARRAY_LENGTH = 128;
const MAX_PLAIN_DATA_OBJECT_FIELDS = 64;
const MAX_PLAIN_DATA_STRING_BYTES = 4096;
const MAX_PLAIN_DATA_TOTAL_STRING_BYTES = 64 * 1024;

function fail(code, detail = '') {
  const suffix = detail === '' ? '' : `:${String(detail)}`;
  throw new TypeError(`gpu_hmr_runtime_adapter_capabilities_v2_${code}${suffix}`);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareStrings).map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(domain, value) {
  return `sha256:${createHash('sha256').update(stableJson({ domain, value })).digest('hex')}`;
}

function descriptorIsAccessor(descriptor) {
  return Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set');
}

function requireExactRecord(value, expectedFields, acceptedFields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}_must_be_plain_data_record`);
  }
  if (utilTypes.isProxy(value)) fail(`${label}_proxy_forbidden`);
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label}_must_be_plain_data_record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== 'string') fail(`${label}_symbol_key_forbidden`);
    const descriptor = descriptors[key];
    if (descriptorIsAccessor(descriptor)) fail(`${label}_accessor_forbidden`, key);
    if (descriptor.enumerable !== true) fail(`${label}_non_enumerable_field`, key);
    if (!acceptedFields.has(key)) fail(`${label}_unknown_field`, key);
  }
  for (const field of expectedFields) {
    if (!Object.hasOwn(descriptors, field)) fail(`${label}_missing_field`, field);
  }
  if (keys.length !== expectedFields.length) fail(`${label}_shape_invalid`);
  return Object.fromEntries(expectedFields.map((field) => [field, descriptors[field].value]));
}

function requireEnum(field, value) {
  if (typeof value !== 'string' || !ENUM_SETS_BY_FIELD[field].has(value)) {
    fail(`${field.replace(/([A-Z])/g, '_$1').toLowerCase()}_invalid`);
  }
  return value;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireEvidenceRefs(value) {
  if (value === null || typeof value !== 'object') fail('evidence_refs_invalid');
  if (utilTypes.isProxy(value)) fail('evidence_refs_proxy_forbidden');
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('evidence_refs_must_be_plain_array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== 'string') fail('evidence_refs_symbol_key_forbidden');
    if (descriptorIsAccessor(descriptors[key])) fail('evidence_refs_accessor_forbidden', key);
  }
  const length = descriptors.length?.value;
  if (!Number.isInteger(length)
    || length < 1
    || length > GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REFS) {
    fail('evidence_refs_length_invalid');
  }
  const references = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail('evidence_refs_sparse_or_non_enumerable', index);
    }
    const reference = descriptor.value;
    if (typeof reference !== 'string'
      || reference.length === 0
      || reference !== reference.trim()
      || Buffer.byteLength(reference, 'utf8') >
        GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REF_BYTES
      || /[\p{Cc}\u2028\u2029]/u.test(reference)
      || hasUnpairedSurrogate(reference)) {
      fail('evidence_ref_invalid', index);
    }
    references.push(reference);
  }
  const expectedKeys = new Set(['length', ...references.map((_, index) => String(index))]);
  if (keys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))) {
    fail('evidence_refs_extra_property_forbidden');
  }
  if (new Set(references).size !== references.length) fail('evidence_refs_duplicate');
  const totalBytes = references.reduce(
    (sum, reference) => sum + Buffer.byteLength(reference, 'utf8'),
    0,
  );
  if (totalBytes > GPU_HMR_RUNTIME_ADAPTER_V2_MAX_EVIDENCE_REFS_BYTES) {
    fail('evidence_refs_total_bytes_exceeded');
  }
  return Object.freeze([...references].sort(compareStrings));
}

function requireOracleKind(value, outputModality) {
  if (typeof value !== 'string') fail('oracle_kind_invalid');
  const classification = classifyGpuHmrOutputOracleKind(value);
  if (!classification.accepted) fail('oracle_kind_invalid');
  if (classification.kind !== value) fail('oracle_kind_not_canonical');
  if (classification.modality !== outputModality) fail('oracle_kind_modality_mismatch');
  return classification.kind;
}

function requireCrossInvariants(capabilities) {
  if (capabilities.pipelineReuseModel === 'none'
    && capabilities.pipelineCacheOwner !== 'none') {
    fail('pipeline_reuse_cache_owner_none_mismatch');
  }
  if ((capabilities.pipelineReuseModel === 'cache'
      || capabilities.pipelineReuseModel === 'cache_and_library')
    && capabilities.pipelineCacheOwner === 'none') {
    fail('pipeline_reuse_cache_owner_required');
  }
}

function interactionMatches(capabilities, interaction) {
  return Object.entries(interaction.when).every(
    ([field, values]) => values.includes(capabilities[field]),
  );
}

function normalizeFacts(source) {
  const outputModality = requireEnum('outputModality', source.outputModality);
  const capabilities = {};
  for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2) {
    capabilities[field] = field === 'oracleKind'
      ? requireOracleKind(source[field], outputModality)
      : requireEnum(field, source[field]);
  }
  requireCrossInvariants(capabilities);
  return Object.freeze(capabilities);
}

export function deriveGpuHmrRuntimeAdapterCapabilityObligationsV2(input) {
  const source = requireExactRecord(
    input,
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2,
    FACT_FIELD_SET,
    'facts',
  );
  const capabilities = normalizeFacts(source);
  const selected = new Set(OBLIGATION_ALGEBRA.base);
  for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2) {
    for (const obligation of OBLIGATION_ALGEBRA.rules[field][capabilities[field]]) {
      selected.add(obligation);
    }
  }
  for (const interaction of OBLIGATION_ALGEBRA.interactions) {
    if (!interactionMatches(capabilities, interaction)) continue;
    for (const obligation of interaction.obligations) selected.add(obligation);
  }
  return Object.freeze(OBLIGATION_ORDER.filter((obligation) => selected.has(obligation)));
}

export function createGpuHmrRuntimeAdapterCapabilitiesV2(input) {
  const source = requireExactRecord(
    input,
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2,
    INPUT_FIELD_SET,
    'input',
  );
  const facts = normalizeFacts(source);
  const capabilities = Object.freeze({
    ...facts,
    evidenceRefs: requireEvidenceRefs(source.evidenceRefs),
  });
  const obligations = deriveGpuHmrRuntimeAdapterCapabilityObligationsV2(
    Object.fromEntries(
      GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2.map(
        (field) => [field, capabilities[field]],
      ),
    ),
  );
  const capabilitiesHash = canonicalSha256(
    `${GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION}.capabilities`,
    capabilities,
  );
  const obligationsHash = canonicalSha256(
    `${GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION}.obligations`,
    obligations,
  );
  const bindingValue = {
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY,
    capabilities,
    obligations,
    capabilitiesHash,
    obligationsHash,
  };
  const bindingHash = canonicalSha256(
    `${GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION}.binding`,
    bindingValue,
  );
  return Object.freeze({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY,
    ...capabilities,
    obligations,
    capabilitiesHash,
    obligationsHash,
    bindingHash,
    proofId: `runtime-adapter-capabilities-v2:${bindingHash}`,
    valid: true,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  });
}

function plainDataTreeFailure(value) {
  const pending = [{ value, leave: false, depth: 0 }];
  const active = new Set();
  const complete = new Set();
  let nodes = 0;
  let totalStringBytes = 0;
  const accountString = (candidate) => {
    const bytes = Buffer.byteLength(candidate, 'utf8');
    if (bytes > MAX_PLAIN_DATA_STRING_BYTES) return 'string_bytes';
    totalStringBytes += bytes;
    return totalStringBytes > MAX_PLAIN_DATA_TOTAL_STRING_BYTES
      ? 'total_string_bytes'
      : null;
  };
  while (pending.length > 0) {
    const entry = pending.pop();
    const current = entry.value;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'string') {
      const failure = accountString(current);
      if (failure) return failure;
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return 'nonfinite_number';
      if (Object.is(current, -0)) return 'negative_zero';
      continue;
    }
    if (typeof current === 'undefined') return 'undefined_value';
    if (typeof current === 'bigint') return 'bigint';
    if (typeof current === 'symbol') return 'symbol_value';
    if (typeof current === 'function') return 'function_value';
    if (typeof current !== 'object') return 'unsupported_value';
    try {
      if (utilTypes.isProxy(current)) return 'proxy';
    } catch {
      return 'introspection_failed';
    }
    if (entry.leave) {
      active.delete(current);
      complete.add(current);
      continue;
    }
    if (entry.depth > MAX_PLAIN_DATA_DEPTH) return 'depth';
    if (complete.has(current)) continue;
    if (active.has(current)) return 'cycle';
    nodes += 1;
    if (nodes > MAX_PLAIN_DATA_NODES) return 'nodes';
    active.add(current);
    pending.push({ value: current, leave: true, depth: entry.depth });
    let prototype;
    let descriptors;
    let keys;
    let isArray;
    try {
      prototype = Object.getPrototypeOf(current);
      isArray = Array.isArray(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
      keys = Reflect.ownKeys(descriptors);
    } catch {
      return 'introspection_failed';
    }
    if (keys.some((key) => typeof key !== 'string')) return 'symbol_property';
    if (isArray) {
      if (prototype !== Array.prototype) return 'array_prototype';
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length)
        || length < 0
        || length > MAX_PLAIN_DATA_ARRAY_LENGTH
        || keys.length !== length + 1) return 'array_shape';
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return 'array_accessor';
        if (descriptor.enumerable !== true) return 'array_descriptor';
        pending.push({ value: descriptor.value, leave: false, depth: entry.depth + 1 });
      }
      continue;
    }
    if (prototype !== Object.prototype) return 'object_prototype';
    if (keys.length > MAX_PLAIN_DATA_OBJECT_FIELDS) return 'object_fields';
    for (const key of keys) {
      const failure = accountString(key);
      if (failure) return failure;
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) return 'accessor_property';
      if (descriptor.enumerable !== true) return 'object_property_descriptor';
      pending.push({ value: descriptor.value, leave: false, depth: entry.depth + 1 });
    }
  }
  return null;
}

function integrityResult(failures, recomputedFacet = null) {
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  const valid = uniqueFailures.length === 0 && recomputedFacet !== null;
  return Object.freeze({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_INTEGRITY_SCHEMA_VERSION,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_INTEGRITY_AUTHORITY,
    valid,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    failures: uniqueFailures,
    recomputedFacet: valid ? recomputedFacet : null,
  });
}

export function evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(facet) {
  const plainDataFailure = plainDataTreeFailure(facet);
  if (plainDataFailure) {
    return integrityResult([
      `runtime_adapter_capabilities_v2_facet_plain_data_${plainDataFailure}`,
    ]);
  }
  if (facet === null || typeof facet !== 'object' || Array.isArray(facet)) {
    return integrityResult(['runtime_adapter_capabilities_v2_facet_not_object']);
  }
  const keys = Object.keys(facet);
  if (keys.length !== FACET_FIELDS.length
    || keys.some((key) => !FACET_FIELD_SET.has(key))
    || FACET_FIELDS.some((key) => !Object.hasOwn(facet, key))) {
    return integrityResult(['runtime_adapter_capabilities_v2_facet_field_set_mismatch']);
  }
  let recomputedFacet;
  try {
    recomputedFacet = createGpuHmrRuntimeAdapterCapabilitiesV2(Object.fromEntries(
      GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2.map(
        (field) => [field, facet[field]],
      ),
    ));
  } catch {
    return integrityResult(['runtime_adapter_capabilities_v2_facet_input_invalid']);
  }
  const failures = [];
  if (facet.schemaVersion !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION) {
    failures.push('runtime_adapter_capabilities_v2_facet_schema_mismatch');
  }
  if (facet.authority !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY) {
    failures.push('runtime_adapter_capabilities_v2_facet_authority_mismatch');
  }
  if (facet.valid !== true || facet.acceptedAsSupportEvidence !== false) {
    failures.push('runtime_adapter_capabilities_v2_facet_declaration_state_invalid');
  }
  if (facet.acceptedForGpuHmr !== false
    || facet.gpuHmrSuccess !== false
    || facet.canSatisfyRuntimeProof !== false
    || facet.canSatisfyDispatchProof !== false) {
    failures.push('runtime_adapter_capabilities_v2_facet_success_authority_forbidden');
  }
  for (const field of FACET_FIELDS) {
    if (stableJson(facet[field]) !== stableJson(recomputedFacet[field])) {
      failures.push(`runtime_adapter_capabilities_v2_facet_${field}_mismatch`);
    }
  }
  return integrityResult(failures, failures.length === 0 ? recomputedFacet : null);
}
