import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION } from './lib/gpu-hmr-runtime-profile.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(MCP_ROOT, '..', '..');
const LOG_DIR = path.join(MCP_ROOT, '.gpu-hmr-test-logs', 'random-large-project-cold-path');
const SOURCE_INTAKE_DIR = path.join(LOG_DIR, 'source-intake');
const SCHEMA = 'synthi.gpu_hmr.random_large_project_cold_path.v1';
const AUTHORITY = 'random_large_project_cold_path_selection_only_not_gpu_hmr_success';
const SELECTION_AUDIT_SCHEMA = 'synthi.gpu_hmr.random_large_project_cold_path_selection_audit.v1';
const SELECTION_AUDIT_AUTHORITY =
  'random_large_project_selection_audit_only_not_gpu_hmr_success';
const DIRECT_SOURCE_INPUT_SCHEMA = 'synthi.gpu_hmr.random_cold_path_direct_source_input.v1';
const DIRECT_SOURCE_INPUT_AUTHORITY =
  'runner_cli_env_direct_source_input_only_not_gpu_hmr_success';
const DIRECT_SOURCE_INPUT_IDENTITY_ROLE =
  'source_identity_hash_bound_to_direct_input_not_whitelist';
const SOURCE_INTAKE_SCHEMA = 'synthi.gpu_hmr.unprofiled_cold_source_intake.v1';
const SOURCE_INTAKE_AUTHORITY = 'unprofiled_source_tree_intake_only_not_gpu_hmr_success';
const SOURCE_INTAKE_TRANSPORT_FALLBACK_SCHEMA =
  'synthi.gpu_hmr.source_intake_transport_fallback.v1';
const SOURCE_INTAKE_TRANSPORT_FALLBACK_AUTHORITY =
  'source_intake_transport_fallback_only_not_gpu_hmr_success';
const BUILD_METADATA_DISCOVERY_SCHEMA = 'synthi.gpu_hmr.cold_build_metadata_discovery.v1';
const BUILD_METADATA_DISCOVERY_AUTHORITY = 'build_metadata_discovery_only_not_gpu_hmr_success';
const BUILD_METADATA_CONTENT_SCHEMA = 'synthi.gpu_hmr.cold_build_metadata_content.v1';
const BUILD_METADATA_CONTENT_AUTHORITY = 'build_metadata_content_bytes_only_not_gpu_hmr_success';
const BUILD_METADATA_BACKEND_SIGNAL_AUTHORITY =
  'build_metadata_semantic_tokens_only_not_runtime_authority';
const COLD_BUILD_EXECUTION_PLAN_SCHEMA = 'synthi.gpu_hmr.cold_build_execution_plan.v1';
const COLD_BUILD_EXECUTION_PLAN_AUTHORITY =
  'cold_build_execution_plan_only_not_gpu_hmr_success';
const RUNTIME_BOUNDARY_EXPECTATION_SCHEMA = 'synthi.gpu_hmr.cold_runtime_boundary_expectation.v1';
const RUNTIME_BOUNDARY_EXPECTATION_AUTHORITY = 'runtime_boundary_expectation_only_not_gpu_hmr_success';
const RUNTIME_BOUNDARY_EVENT_SCHEMA = 'synthi.gpu_hmr.runtime_boundary_event.v1';
const RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA = 'synthi.gpu_hmr.runtime_boundary_event_manifest.v1';
const RUNTIME_BOUNDARY_EVENT_TEMPLATE_SCHEMA =
  'synthi.gpu_hmr.cold_runtime_boundary_event_manifest_template.v1';
const RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY =
  'runtime_boundary_event_manifest_template_only_not_gpu_hmr_success';
const RUNTIME_BOUNDARY_TEMPLATE_SOURCE_BINDING_SCHEMA =
  'synthi.gpu_hmr.cold_runtime_boundary_template_source_binding.v1';
const RUNTIME_BOUNDARY_TEMPLATE_SOURCE_BINDING_AUTHORITY =
  'runtime_boundary_template_source_binding_only_not_runtime_authority';
const RUNTIME_PROFILE_PROOF_BRIDGE_SCHEMA =
  'synthi.gpu_hmr.random_cold_path_runtime_profile_proof_bridge.v1';
const RUNTIME_PROFILE_PROOF_BRIDGE_AUTHORITY =
  'runtime_profile_proof_bridge_observation_only_not_gpu_hmr_success';
const DERIVED_RUNTIME_PROFILE_CONTRACT_SCHEMA =
  'synthi.gpu_hmr.random_cold_path_derived_runtime_profile_contract.v1';
const DERIVED_RUNTIME_PROFILE_CONTRACT_AUTHORITY =
  'cold_intake_derived_runtime_profile_contract_only_not_gpu_hmr_success';
const DERIVED_RUNTIME_PROFILE_EVENT_MANIFEST_AUTHORITY =
  'cold_intake_runtime_boundary_event_manifest_template_only_not_gpu_hmr_success';
const ADAPTER_CLOSURE_EXPECTATION_SCHEMA =
  'synthi.gpu_hmr.random_large_project_adapter_closure_expectation.v1';
const ADAPTER_CLOSURE_EXPECTATION_AUTHORITY =
  'adapter_closure_expectation_only_not_gpu_hmr_success';
const APP_HOOK_MATERIALIZATION_PLAN_SCHEMA =
  'synthi.gpu_hmr.random_cold_path_app_hook_materialization_plan.v1';
const APP_HOOK_MATERIALIZATION_PLAN_AUTHORITY =
  'random_cold_path_app_hook_materialization_plan_only_not_gpu_hmr_success';
const RUNTIME_BOUNDARY_PLAN_BINDING_SCHEMA =
  'synthi.gpu_hmr.random_cold_path_runtime_boundary_plan_binding.v1';
const RUNTIME_BOUNDARY_PLAN_BINDING_AUTHORITY =
  'runtime_boundary_plan_binding_only_not_gpu_hmr_success';
const RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_STAGE =
  'runtime_adapter_or_app_hook_contract';
const RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_GAP =
  'runtime_adapter_or_app_hook_contract_missing';
const REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS = Object.freeze([
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
]);

const RUNTIME_BOUNDARY_ADAPTER_INPUT_REQUIRED_FIELDS = Object.freeze([
  'projectId',
  'editId',
  'targetId',
  'backend',
  'sourcePaths',
  'sourceManifestHash',
  'sourceManifestHashVerified',
  'sourceIdentityEvidenceRefs',
  'entryPoint',
  'compileTarget',
  'compiler',
  'compilerArgsHash',
  'artifactHashBefore',
  'artifactHashAfter',
  'contractHash',
  'runtimeBoundaryEvents',
]);

const RUNTIME_BOUNDARY_ADAPTER_INPUT_FIELD_ALIASES = Object.freeze({
  projectId: ['project_id'],
  editId: ['edit_id', 'sourceEditId', 'source_edit_id'],
  targetId: ['target_id', 'validationTargetId', 'validation_target_id'],
  backend: ['gpuBackend', 'gpu_backend'],
  sourcePaths: ['source_paths'],
  sourceManifestHash: ['source_manifest_hash', 'sourceTreeManifestHash', 'source_tree_manifest_hash', 'sourceIdentityHash', 'source_identity_hash'],
  sourceManifestHashVerified: ['source_manifest_hash_verified', 'sourceTreeManifestHashVerified', 'source_tree_manifest_hash_verified', 'sourceIdentityHashVerified', 'source_identity_hash_verified'],
  sourceIdentityEvidenceRefs: ['source_identity_evidence_refs', 'sourceManifestEvidenceRefs', 'source_manifest_evidence_refs'],
  entryPoint: ['entry_point', 'kernelName', 'kernel_name'],
  compileTarget: ['compile_target', 'gpuArch', 'gpu_arch'],
  compilerArgsHash: ['compiler_args_hash'],
  artifactHashBefore: ['artifact_hash_before'],
  artifactHashAfter: ['artifact_hash_after'],
  contractHash: ['contract_hash'],
  runtimeBoundaryEvents: ['runtime_boundary_events', 'adapterRuntimeBoundaryEvents', 'adapter_runtime_boundary_events', 'events'],
});
const BUILD_METADATA_CONTENT_MAX_FILES = 12;
const BUILD_METADATA_CONTENT_MAX_BYTES = 128 * 1024;
const DEFAULT_CONFIGURED_SAMPLE_POOL_COUNT = 5;
const IDENTITY_SORT_SELECTION_ALGORITHM = 'sha256_seed_candidate_identity_sort_v1';
const CLASS_BUCKET_SELECTION_ALGORITHM = 'sha256_seed_class_bucket_round_robin_v1';
const SAMPLE_POOL_COVERAGE_CONTRACT_SCHEMA =
  'synthi.gpu_hmr.random_large_project_cold_path_sample_pool_coverage_contract.v1';
const SAMPLE_POOL_COVERAGE_CONTRACT_AUTHORITY =
  'sample_pool_coverage_contract_only_not_gpu_hmr_success';
const CONFIGURED_SAMPLE_POOL_REQUIRED_BUCKETS = Object.freeze([
  'profiled_real_rocm_project',
  'unprofiled_large_rocm_ml',
  'large_graphics_or_native_gpu_stack',
  'large_engine_or_rendering_project',
  'large_multibackend_gpu_project',
]);

const DEFAULT_CANDIDATES = [
  {
    id: 'real-rocm-miopen-activation-large-ml',
    backendFamily: 'real_rocm',
    profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-miopen-activation-large-ml.json'),
    sourceUrl: 'https://github.com/ROCm/MIOpen.git',
    immutableCommit: '06977176afd94476c18d5290f21cb40745bb73a9',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'MIOpenDriver',
      coldPathKind: 'real_upstream_cmake_project',
    },
  },
  {
    id: 'real-rocm-composable-kernel-gemm-large-ml',
    backendFamily: 'real_rocm',
    profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-composable-kernel-gemm-large-ml.json'),
    sourceUrl: 'https://github.com/ROCm/composable_kernel.git',
    immutableCommit: '713f1fbf46ae73755c06a0b115f01795cea9a4f9',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'example_gemm_xdl_fp32_v3',
      coldPathKind: 'real_upstream_cmake_project',
    },
  },
  {
    id: 'real-rocm-hipblaslt-gelu-aux-bias-large-ml',
    backendFamily: 'real_rocm',
    profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-hipblaslt-gelu-aux-bias-large-ml.json'),
    sourceUrl: 'https://github.com/ROCm/hipBLASLt.git',
    immutableCommit: '3a609b06926c8227e753b62087555e1f435bf2d4',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'sample_hipblaslt_gemm_gelu_aux_bias',
      coldPathKind: 'real_upstream_cmake_project',
    },
  },
  {
    id: 'unprofiled-rocm-hipdnn-large-ml',
    backendFamily: 'real_rocm',
    sourceUrl: 'https://github.com/ROCm/hipDNN.git',
    immutableCommit: 'ebba3d34660ed206491f33a7dc1825efe0571780',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'generic_hipdnn_runtime_boundary',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['structured_tensor_readback', 'compute_readback'],
    },
  },
  {
    id: 'unprofiled-rocm-migraphx-large-ml',
    backendFamily: 'real_rocm',
    sourceUrl: 'https://github.com/ROCm/AMDMIGraphX.git',
    immutableCommit: 'db2b920b468dd77b74e0f4a7fa633cfc0209f52f',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'generic_migraphx_runtime_boundary',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['structured_tensor_readback', 'compute_readback'],
    },
  },
  {
    id: 'unprofiled-rocm-rocmlir-large-ml-compiler',
    backendFamily: 'real_rocm',
    sourceUrl: 'https://github.com/ROCm/rocMLIR.git',
    immutableCommit: 'c4c1caef7293b5003b902f9a45e550919c61db4d',
    sizeSignals: {
      class: 'large_rocm_ml_compiler_infrastructure',
      target: 'generic_rocmlir_runtime_boundary',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['compiled_kernel_metadata', 'compute_readback'],
    },
  },
  {
    id: 'unprofiled-rocm-tensile-large-ml-kernels',
    backendFamily: 'real_rocm',
    sourceUrl: 'https://github.com/ROCm/Tensile.git',
    immutableCommit: 'e8a8999e0e7374aaae546a6d7cb703d9e06b0ebf',
    sizeSignals: {
      class: 'large_rocm_ml_kernel_generator',
      target: 'generic_tensile_runtime_boundary',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['structured_tensor_readback', 'compute_readback'],
    },
  },
  {
    id: 'unprofiled-rocm-rocblas-large-ml',
    backendFamily: 'real_rocm',
    sourceUrl: 'https://github.com/ROCm/rocBLAS.git',
    immutableCommit: 'defce200a69e5346eeadd7ac1e199238758add61',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'generic_rocblas_runtime_boundary',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['structured_tensor_readback', 'compute_readback'],
    },
  },
  {
    id: 'unprofiled-rocm-rocrand-large-ml',
    backendFamily: 'real_rocm',
    sourceUrl: 'https://github.com/ROCm/rocRAND.git',
    immutableCommit: '9a2aab8643f1e2390e202fc6a71e0e8ae181ac48',
    sizeSignals: {
      class: 'large_rocm_ml_infrastructure',
      target: 'generic_rocrand_runtime_boundary',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['statistical_readback', 'compute_readback'],
    },
  },
  {
    id: 'unprofiled-rocm-aotriton-large-ml-kernels',
    backendFamily: 'real_rocm',
    sourceUrl: 'https://github.com/ROCm/aotriton.git',
    immutableCommit: '27b92c90887716395fba7c8e5522c51342a7af63',
    sizeSignals: {
      class: 'large_rocm_ml_kernel_infrastructure',
      target: 'generic_aotriton_runtime_boundary',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['structured_tensor_readback', 'compute_readback'],
    },
  },
  {
    id: 'unprofiled-llama-cpp-multibackend',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/ggerganov/llama.cpp.git',
    immutableCommit: '4f31eedb0ccf546b7e8d6bb243b170f12522f54d',
    sizeSignals: {
      class: 'large_arbitrary_multibackend_user_project',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt', 'Makefile'],
    },
    runtimeBoundaryHints: {
      required: [
        'same_process_loader',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['compute_readback', 'visual_oracle'],
    },
  },
  {
    id: 'unprofiled-wgpu-rust-graphics-stack',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/gfx-rs/wgpu.git',
    immutableCommit: '22c6cb18d4b73254b0d62511e6a9d68e06dea70f',
    sizeSignals: {
      class: 'large_arbitrary_webgpu_vulkan_metal_user_project',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['Cargo.toml'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'pipeline_epoch',
        'frame_or_compute_dispatch_trace',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['mapped_buffer_readback', 'visual_oracle'],
    },
  },
  {
    id: 'unprofiled-dawn-webgpu-stack',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/google/dawn.git',
    immutableCommit: 'a25d07794c686b4de8e231e53b7550c3e983e6e6',
    sizeSignals: {
      class: 'large_arbitrary_webgpu_native_stack',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['CMakeLists.txt'],
    },
    runtimeBoundaryHints: {
      required: [
        'runtime_profile_contract',
        'same_process_loader',
        'shader_or_pipeline_epoch',
        'dispatch_trace',
        'output_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['mapped_buffer_readback', 'visual_oracle'],
    },
  },
  {
    id: 'unprofiled-godot-engine-rendering',
    backendFamily: 'unknown_gpu_project',
    sourceUrl: 'https://github.com/godotengine/godot.git',
    immutableCommit: 'f4c57c2824951a5df945392923bdfdc1c4055395',
    sizeSignals: {
      class: 'large_arbitrary_engine_rendering_project',
      coldPathKind: 'github_source_tree_intake_only',
    },
    buildSystemHints: {
      expectedFiles: ['SConstruct'],
    },
    runtimeBoundaryHints: {
      required: [
        'engine_reload_hook',
        'same_process_loader',
        'pipeline_epoch',
        'frame_dispatch_trace',
        'host_identity',
        'visual_oracle',
      ],
    },
    oracleHints: {
      acceptedByDeclaration: false,
      expectedKinds: ['deterministic_visual_oracle'],
    },
  },
];

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-check') out.selfCheck = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--seed') out.seed = argv[++i];
    else if (arg === '--count') out.count = argv[++i];
    else if (arg === '--candidate') out.candidateId = argv[++i];
    else if (arg === '--candidates') out.candidatesPath = argv[++i];
    else if (arg === '--direct-candidates') out.directCandidatesPath = argv[++i];
    else if (arg === '--require-direct-source') out.requireDirectSource = true;
    else if (arg === '--sample-pool') out.samplePool = true;
    else if (arg === '--source-url') out.sourceUrl = argv[++i];
    else if (arg === '--repo-path') out.repoPath = argv[++i];
    else if (arg === '--commit' || arg === '--immutable-commit') out.immutableCommit = argv[++i];
    else if (arg === '--source-id') out.sourceId = argv[++i];
    else if (arg === '--backend-family') out.backendFamily = argv[++i];
    else if (arg === '--runtime-profile' || arg === '--runtime-profile-path') out.runtimeProofProfilePath = argv[++i];
    else if (arg === '--output-dir') out.outputDir = argv[++i];
    else if (String(arg ?? '').startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length > 0) {
    const [source, commit, sourceId, backendFamily, runtimeProofProfilePath] = positionals;
    if (!out.sourceUrl && !out.repoPath && source) {
      const sourceText = String(source);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(sourceText) || /^git@/i.test(sourceText) || /\.git$/i.test(sourceText)) {
        out.sourceUrl = sourceText;
      } else {
        out.repoPath = sourceText;
      }
    }
    if (!out.immutableCommit && commit) out.immutableCommit = commit;
    if (!out.sourceId && sourceId) out.sourceId = sourceId;
    if (!out.backendFamily && backendFamily) out.backendFamily = backendFamily;
    if (!out.runtimeProofProfilePath && runtimeProofProfilePath) {
      out.runtimeProofProfilePath = runtimeProofProfilePath;
    }
    out.positionals = positionals;
  }
  return out;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function contentHash(value) {
  return `sha256:${sha256(value)}`;
}

function gitBlobObjectId(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash('sha1')
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest('hex');
}

function githubRawUrlForPath({ owner, repo }, commit, pathName) {
  const encodedPath = String(pathName)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${encodedPath}`;
}

function safeSlug(value, fallback = 'repo') {
  const slug = String(value ?? '')
    .trim()
    .replace(/\.git$/i, '')
    .split(/[/:\\]+/)
    .filter(Boolean)
    .slice(-2)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 48);
  return slug || fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function claimsGpuHmrAuthority(value) {
  const object = value && typeof value === 'object' ? value : {};
  return firstBoolean(object.acceptedForGpuHmr, object.accepted_for_gpu_hmr) === true
    || firstBoolean(object.gpuHmrSuccess, object.gpu_hmr_success) === true
    || firstBoolean(object.canSatisfyRuntimeProof, object.can_satisfy_runtime_proof) === true
    || firstBoolean(object.canSatisfyDispatchProof, object.can_satisfy_dispatch_proof) === true;
}

function canonicalSourceListingIdentity(files = []) {
  return (Array.isArray(files) ? files : [])
    .map((file) => {
      const mode = String(file.mode ?? file.gitMode ?? file.git_mode ?? '').trim();
      const type = String(file.type ?? file.objectType ?? file.object_type ?? '').trim();
      const identity = {
        path: String(file.path ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\/+/, ''),
        object: file.object ?? null,
        byteLength: Number.isFinite(file.byteLength) ? file.byteLength : null,
      };
      if (mode) identity.mode = mode;
      if (type) identity.type = type;
      return identity;
    })
    .filter((file) => file.path)
    .sort((a, b) =>
      stableJson(a).localeCompare(stableJson(b))
    );
}

function uniqueSortedStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )].sort();
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}

function firstArrayField(object, ...keys) {
  const source = object && typeof object === 'object' ? object : {};
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key];
  }
  return [];
}

function firstObjectField(object, ...keys) {
  const source = object && typeof object === 'object' ? object : {};
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return {};
}

function runtimeBoundaryHintsWithSupportClosure(raw = {}) {
  const hints = raw && typeof raw === 'object' ? raw : {};
  const required = uniqueSortedStrings([
    ...(Array.isArray(hints.required) ? hints.required : []),
    ...(Array.isArray(hints.required_stages) ? hints.required_stages : []),
    RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_STAGE,
  ]);
  return {
    ...hints,
    required,
    required_stages: required,
  };
}

function bloblessGitTreeSizeListingEnabled(env = process.env) {
  return env.SYNTHI_GPU_HMR_BLOBLESS_TREE_SIZE_LISTING === '1';
}

function bloblessBuildMetadataContentFetchEnabled(env = process.env) {
  return env.SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH === '1'
    || bloblessGitTreeSizeListingEnabled(env);
}

function fullGitSourceTreeFallbackEnabled(env = process.env) {
  return env.SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK === '1';
}

function cleanCandidate(
  raw,
  index = 0,
  { candidateSource = 'configured_candidate_pool', directInputEvidence = null } = {},
) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const id = String(candidate.id ?? '').trim();
  const backendFamily = String(
    candidate.backendFamily
      ?? candidate.backend_family
      ?? candidate.backend
      ?? 'unknown_gpu_project',
  ).trim().toLowerCase();
  const profilePath = String(candidate.profilePath ?? candidate.profile_path ?? '').trim();
  const runtimeProofProfilePath = String(
    candidate.runtimeProofProfilePath
      ?? candidate.runtime_proof_profile_path
      ?? candidate.runtimeProfilePath
      ?? candidate.runtime_profile_path
      ?? candidate.strictRuntimeProfilePath
      ?? candidate.strict_runtime_profile_path
      ?? '',
  ).trim();
  const sourceUrl = String(candidate.sourceUrl ?? candidate.source_url ?? candidate.repo?.url ?? '').trim();
  const localRepoPath = String(
    candidate.localRepoPath
      ?? candidate.local_repo_path
      ?? candidate.repoPath
      ?? candidate.repo_path
      ?? '',
  ).trim();
  const immutableCommit = String(
    candidate.immutableCommit
      ?? candidate.immutable_commit
      ?? candidate.repo?.commit
      ?? '',
  ).trim();
  if (!id) throw new Error(`candidate[${index}] id missing`);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`candidate[${index}] id must be a safe identifier`);
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(backendFamily)) {
    throw new Error(`candidate[${index}] backendFamily must be a safe identifier`);
  }
  if (!sourceUrl) throw new Error(`candidate[${index}] sourceUrl missing`);
  if (!/^[0-9a-f]{40,64}$/i.test(immutableCommit)) {
    throw new Error(`candidate[${index}] immutableCommit must be a git commit hash`);
  }
  const resolvedProfilePath = profilePath ? path.resolve(profilePath) : null;
  const resolvedRuntimeProofProfilePath =
    resolveRepoBoundPath(runtimeProofProfilePath, 'candidate.runtimeProofProfilePath');
  const profileMode = resolvedProfilePath
    ? 'profile_driven_real_rocm_runner'
    : 'unprofiled_arbitrary_project_cold_intake';
  return {
    id,
    backendFamily,
    profilePath: resolvedProfilePath,
    profileMode,
    profile_mode: profileMode,
    runtimeProofProfilePath: resolvedRuntimeProofProfilePath,
    runtime_proof_profile_path: resolvedRuntimeProofProfilePath,
    runtimeProofProfileRelativePath: resolvedRuntimeProofProfilePath
      ? repoRelativePath(resolvedRuntimeProofProfilePath)
      : null,
    runtime_proof_profile_relative_path: resolvedRuntimeProofProfilePath
      ? repoRelativePath(resolvedRuntimeProofProfilePath)
      : null,
    runtimeProofProfileMode: resolvedRuntimeProofProfilePath
      ? 'declared_generic_runtime_profile'
      : 'none',
    runtime_proof_profile_mode: resolvedRuntimeProofProfilePath
      ? 'declared_generic_runtime_profile'
      : 'none',
    candidateSource,
    candidate_source: candidateSource,
    directInputEvidence,
    direct_input_evidence: directInputEvidence,
    sourceUrl,
    localRepoPath: localRepoPath ? path.resolve(localRepoPath) : null,
    local_repo_path: localRepoPath ? path.resolve(localRepoPath) : null,
    immutableCommit,
    sizeSignals: candidate.sizeSignals ?? candidate.size_signals ?? {},
    buildSystemHints: candidate.buildSystemHints ?? candidate.build_system_hints ?? {},
    build_system_hints: candidate.buildSystemHints ?? candidate.build_system_hints ?? {},
    runtimeBoundaryHints: runtimeBoundaryHintsWithSupportClosure(
      candidate.runtimeBoundaryHints ?? candidate.runtime_boundary_hints ?? {},
    ),
    runtime_boundary_hints: runtimeBoundaryHintsWithSupportClosure(
      candidate.runtimeBoundaryHints ?? candidate.runtime_boundary_hints ?? {},
    ),
    oracleHints: candidate.oracleHints ?? candidate.oracle_hints ?? {},
    oracle_hints: candidate.oracleHints ?? candidate.oracle_hints ?? {},
  };
}

function directSourceInputEvidence({
  candidateSource,
  sourceUrl,
  repoPath,
  immutableCommit,
  inputChannels = [],
} = {}) {
  const channels = uniqueSortedStrings(inputChannels);
  const sourceKind = candidateSource === 'direct_local_git_repo_path'
    ? 'local_repo_path_commit'
    : candidateSource === 'direct_source_url_commit'
      ? 'source_url_commit'
      : 'unknown';
  const seed = {
    schemaVersion: DIRECT_SOURCE_INPUT_SCHEMA,
    candidateSource,
    sourceKind,
    hasSourceUrl: Boolean(String(sourceUrl ?? '').trim()),
    hasRepoPath: Boolean(String(repoPath ?? '').trim()),
    sourceUrlHash: String(sourceUrl ?? '').trim()
      ? contentHash(String(sourceUrl ?? '').trim())
      : null,
    repoPathHash: String(repoPath ?? '').trim()
      ? contentHash(String(repoPath ?? '').trim())
      : null,
    immutableCommit: String(immutableCommit ?? '').trim().toLowerCase(),
    inputChannels: channels,
  };
  const sourceIdentityHash = contentHash(stableJson(seed));
  const hasCliOrEnvChannel = channels.some((channel) =>
    /^cli_arg[_:]/.test(channel) || /^env[_:]/.test(channel)
  );
  const blockingGaps = [
    candidateSource === 'direct_source_url_commit' || candidateSource === 'direct_local_git_repo_path'
      ? null
      : 'direct_source_input_candidate_source_not_direct',
    hasCliOrEnvChannel ? null : 'direct_source_input_cli_or_env_channel_missing',
    seed.immutableCommit ? null : 'direct_source_input_commit_missing',
    seed.hasSourceUrl || seed.hasRepoPath ? null : 'direct_source_input_source_identity_missing',
  ].filter(Boolean);
  const accepted = blockingGaps.length === 0;
  return {
    schemaVersion: DIRECT_SOURCE_INPUT_SCHEMA,
    schema_version: DIRECT_SOURCE_INPUT_SCHEMA,
    proofAuthority: DIRECT_SOURCE_INPUT_AUTHORITY,
    proof_authority: DIRECT_SOURCE_INPUT_AUTHORITY,
    accepted,
    acceptedAsDirectInputEvidence: accepted,
    accepted_as_direct_input_evidence: accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    inputMode: 'cli_or_env_direct_source',
    input_mode: 'cli_or_env_direct_source',
    inputChannels: channels,
    input_channels: channels,
    candidateSource,
    candidate_source: candidateSource,
    sourceKind,
    source_kind: sourceKind,
    sourceIdentityRole: DIRECT_SOURCE_INPUT_IDENTITY_ROLE,
    source_identity_role: DIRECT_SOURCE_INPUT_IDENTITY_ROLE,
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
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
}

function directCandidateFromInput({
  sourceUrl,
  repoPath,
  immutableCommit,
  sourceId,
  backendFamily,
  runtimeProofProfilePath,
  inputChannels = [],
} = {}) {
  const url = String(sourceUrl ?? '').trim();
  const repo = String(repoPath ?? '').trim();
  const commit = String(immutableCommit ?? '').trim();
  if (!url && !repo && !commit) return null;
  if ((!url && !repo) || !commit) {
    throw new Error('direct cold-path source input requires --source-url or --repo-path plus --commit');
  }
  const resolvedRepo = repo ? path.resolve(repo) : null;
  const effectiveSourceUrl = url || pathToFileURL(resolvedRepo).href;
  const id = String(sourceId ?? '').trim()
    || `direct-${safeSlug(url || resolvedRepo)}-${sha256(`${effectiveSourceUrl}\0${commit}`).slice(0, 12)}`;
  const candidateSource = resolvedRepo ? 'direct_local_git_repo_path' : 'direct_source_url_commit';
  const directInputEvidence = directSourceInputEvidence({
    candidateSource,
    sourceUrl: effectiveSourceUrl,
    repoPath: resolvedRepo,
    immutableCommit: commit,
    inputChannels,
  });
  return cleanCandidate(
    {
      id,
      backendFamily: backendFamily || 'unknown_gpu_project',
      runtimeProofProfilePath,
      sourceUrl: effectiveSourceUrl,
      localRepoPath: resolvedRepo,
      immutableCommit: commit,
      sizeSignals: {
        class: 'large_arbitrary_user_project',
        coldPathKind: resolvedRepo
          ? 'direct_local_git_repo_cold_intake'
          : 'direct_source_url_commit_cold_intake',
        inputMode: 'cli_or_env_direct_source',
      },
      runtimeBoundaryHints: {
        required: [
          'runtime_profile_contract',
          'same_process_loader',
          'epoch_publication',
          'dispatch_trace',
          'host_identity',
          'output_oracle',
        ],
      },
      oracleHints: {
        acceptedByDeclaration: false,
        expectedKinds: ['compute_readback', 'deterministic_visual_oracle'],
      },
    },
    0,
    {
      candidateSource,
      directInputEvidence,
    },
  );
}

function directInputChannelsFromArgsEnv(args = {}, env = process.env) {
  const channels = [];
  const pushChannel = (argName, argValue, envName) => {
    if (String(argValue ?? '').trim()) channels.push(`cli_arg_${argName}`);
    else if (String(env[envName] ?? '').trim()) channels.push(`env_${envName}`);
  };
  pushChannel('source_url', args.sourceUrl, 'SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_URL');
  pushChannel('repo_path', args.repoPath, 'SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_REPO_PATH');
  pushChannel('commit', args.immutableCommit, 'SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_COMMIT');
  pushChannel('source_id', args.sourceId, 'SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_ID');
  pushChannel('backend_family', args.backendFamily, 'SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_BACKEND_FAMILY');
  pushChannel('runtime_profile', args.runtimeProofProfilePath, 'SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_RUNTIME_PROFILE_PATH');
  return channels;
}

function samplePoolModeRequested(args = {}, env = process.env) {
  return args.samplePool === true
    || env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SAMPLE_POOL === '1';
}

function directSourceRequired(args = {}, env = process.env) {
  return (
    args.requireDirectSource === true
    || env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_REQUIRE_DIRECT_SOURCE === '1'
  ) && !samplePoolModeRequested(args, env);
}

function assertDirectSourceRequirement({ requireDirectSource = false, directCandidate = null } = {}) {
  if (!requireDirectSource || directCandidate) return;
  throw new Error(
    'random large-project cold-path direct source mode requires --source-url or --repo-path plus --commit; use --sample-pool for configured diagnostic candidates',
  );
}

function assertConfiguredSamplePoolExplicit({
  useConfiguredCandidatePool = false,
  samplePool = false,
} = {}) {
  if (!useConfiguredCandidatePool || samplePool === true) return;
  throw new Error(
    'random large-project cold-path configured diagnostic candidates require --sample-pool; provide --source-url or --repo-path plus --commit for direct user-source cold intake',
  );
}

async function loadCandidates({ candidatesJson, candidatesPath } = {}) {
  let raw = DEFAULT_CANDIDATES;
  if (candidatesJson) {
    raw = JSON.parse(candidatesJson);
  } else if (candidatesPath) {
    raw = JSON.parse(await readFile(path.resolve(candidatesPath), 'utf8'));
  }
  const candidates = Array.isArray(raw) ? raw : raw?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('large-project cold-path candidates must be a non-empty array');
  }
  const cleaned = candidates.map((candidate, index) =>
    cleanCandidate(candidate, index, { candidateSource: 'configured_candidate_pool' }));
  const ids = new Set();
  for (const candidate of cleaned) {
    if (ids.has(candidate.id)) throw new Error(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
  }
  return cleaned;
}

async function loadDirectCandidates({ candidatesJson, candidatesPath } = {}) {
  if (!candidatesJson && !candidatesPath) return [];
  const raw = candidatesJson
    ? JSON.parse(candidatesJson)
    : JSON.parse(await readFile(path.resolve(candidatesPath), 'utf8'));
  const candidates = Array.isArray(raw) ? raw : raw?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('direct large-project cold-path candidates must be a non-empty array');
  }
  const out = candidates.map((candidate, index) => {
    const item = candidate && typeof candidate === 'object' ? candidate : {};
    const direct = directCandidateFromInput({
      sourceUrl: item.sourceUrl ?? item.source_url ?? item.repo?.url,
      repoPath: item.repoPath ?? item.repo_path ?? item.localRepoPath ?? item.local_repo_path,
      immutableCommit: item.immutableCommit ?? item.immutable_commit ?? item.commit ?? item.repo?.commit,
      sourceId: item.sourceId ?? item.source_id ?? item.id,
      backendFamily: item.backendFamily ?? item.backend_family ?? item.backend,
      inputChannels: ['cli_arg_direct_candidates'],
    });
    if (!direct) throw new Error(`direct candidate[${index}] did not contain a source`);
    return direct;
  });
  const ids = new Set();
  for (const candidate of out) {
    if (ids.has(candidate.id)) throw new Error(`duplicate direct candidate id: ${candidate.id}`);
    ids.add(candidate.id);
  }
  return out;
}

function normalizedSelectionToken(value, fallback = 'unknown') {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || fallback;
}

function configuredSamplePoolSelectionBucket(candidate = {}) {
  const sizeSignals = candidate.sizeSignals ?? candidate.size_signals ?? {};
  const classToken = normalizedSelectionToken(sizeSignals.class ?? sizeSignals.kind);
  const backendToken = normalizedSelectionToken(candidate.backendFamily ?? candidate.backend_family);
  const profilePath = firstString(
    candidate.profilePath,
    candidate.profile_path,
    candidate.runtimeProofProfilePath,
    candidate.runtime_proof_profile_path,
  );
  if (profilePath && backendToken === 'real_rocm') return 'profiled_real_rocm_project';
  if (classToken.includes('rocm') && classToken.includes('ml')) {
    return 'unprofiled_large_rocm_ml';
  }
  if (
    classToken.includes('webgpu')
    || classToken.includes('wgpu')
    || classToken.includes('vulkan')
    || classToken.includes('metal')
  ) {
    return 'large_graphics_or_native_gpu_stack';
  }
  if (classToken.includes('engine') || classToken.includes('render')) {
    return 'large_engine_or_rendering_project';
  }
  if (classToken.includes('multibackend') || classToken.includes('multi_backend')) {
    return 'large_multibackend_gpu_project';
  }
  return `large_${backendToken}_${classToken}`;
}

function normalizedSelectionValues(values) {
  const source = Array.isArray(values) ? values : [values];
  return uniqueSortedStrings(
    source
      .map((value) => normalizedSelectionToken(value, ''))
      .filter(Boolean),
  );
}

function buildFamilyTokenForPath(pathName) {
  const normalizedPath = String(pathName ?? '').trim().replace(/\\/g, '/').toLowerCase();
  const base = normalizedPath.split('/').filter(Boolean).pop() ?? '';
  if (base === 'cmakelists.txt') return 'cmake';
  if (base === 'build.gn' || base === '.gn') return 'gn';
  if (base === 'build.bazel' || base === 'workspace' || base === 'workspace.bazel') return 'bazel';
  if (base === 'makefile' || base === 'gnumakefile') return 'make';
  if (base === 'cargo.toml') return 'cargo';
  if (base === 'package.json') return 'npm';
  if (base === 'meson.build') return 'meson';
  if (base === 'pyproject.toml' || base === 'setup.py') return 'python';
  return null;
}

function candidateSelectionFacets(candidate = {}) {
  const sizeSignals = candidate.sizeSignals ?? candidate.size_signals ?? {};
  const buildSystemHints = candidate.buildSystemHints ?? candidate.build_system_hints ?? {};
  const runtimeBoundaryHints = candidate.runtimeBoundaryHints ?? candidate.runtime_boundary_hints ?? {};
  const oracleHints = candidate.oracleHints ?? candidate.oracle_hints ?? {};
  const profilePath = firstString(
    candidate.profilePath,
    candidate.profile_path,
    candidate.runtimeProofProfilePath,
    candidate.runtime_proof_profile_path,
  );
  const buildHintPaths = [
    ...firstArrayField(buildSystemHints, 'expectedFiles', 'expected_files'),
    ...firstArrayField(buildSystemHints, 'observedFiles', 'observed_files'),
    ...firstArrayField(buildSystemHints, 'buildFiles', 'build_files'),
  ];
  return {
    selectionBucket: configuredSamplePoolSelectionBucket(candidate),
    selection_bucket: configuredSamplePoolSelectionBucket(candidate),
    backendFamily: normalizedSelectionToken(
      candidate.backendFamily ?? candidate.backend_family,
      'unknown_gpu_project',
    ),
    backend_family: normalizedSelectionToken(
      candidate.backendFamily ?? candidate.backend_family,
      'unknown_gpu_project',
    ),
    profileMode: normalizedSelectionToken(candidate.profileMode ?? candidate.profile_mode),
    profile_mode: normalizedSelectionToken(candidate.profileMode ?? candidate.profile_mode),
    profileKind: profilePath ? 'profile_or_runtime_profile_declared' : 'unprofiled_cold_intake',
    profile_kind: profilePath ? 'profile_or_runtime_profile_declared' : 'unprofiled_cold_intake',
    sizeClass: normalizedSelectionToken(sizeSignals.class ?? sizeSignals.kind),
    size_class: normalizedSelectionToken(sizeSignals.class ?? sizeSignals.kind),
    coldPathKind: normalizedSelectionToken(sizeSignals.coldPathKind ?? sizeSignals.cold_path_kind),
    cold_path_kind: normalizedSelectionToken(sizeSignals.coldPathKind ?? sizeSignals.cold_path_kind),
    buildFamilies: uniqueSortedStrings(buildHintPaths.map(buildFamilyTokenForPath).filter(Boolean)),
    build_families: uniqueSortedStrings(buildHintPaths.map(buildFamilyTokenForPath).filter(Boolean)),
    runtimeBoundaryStages: normalizedSelectionValues(
      firstArrayField(runtimeBoundaryHints, 'required', 'requiredStages', 'required_stages'),
    ),
    runtime_boundary_stages: normalizedSelectionValues(
      firstArrayField(runtimeBoundaryHints, 'required', 'requiredStages', 'required_stages'),
    ),
    oracleKinds: normalizedSelectionValues(
      firstArrayField(oracleHints, 'expectedKinds', 'expected_kinds'),
    ),
    oracle_kinds: normalizedSelectionValues(
      firstArrayField(oracleHints, 'expectedKinds', 'expected_kinds'),
    ),
  };
}

function candidateFacets(candidate = {}) {
  return candidate.selectionFacets
    ?? candidate.selection_facets
    ?? candidateSelectionFacets(candidate);
}

function selectionFacetSummary(candidates = []) {
  const facets = (Array.isArray(candidates) ? candidates : []).map(candidateFacets);
  return {
    selectionBuckets: uniqueSortedStrings(facets.map((facet) =>
      facet.selectionBucket ?? facet.selection_bucket)),
    selection_buckets: uniqueSortedStrings(facets.map((facet) =>
      facet.selectionBucket ?? facet.selection_bucket)),
    backendFamilies: uniqueSortedStrings(facets.map((facet) =>
      facet.backendFamily ?? facet.backend_family)),
    backend_families: uniqueSortedStrings(facets.map((facet) =>
      facet.backendFamily ?? facet.backend_family)),
    profileModes: uniqueSortedStrings(facets.map((facet) =>
      facet.profileMode ?? facet.profile_mode)),
    profile_modes: uniqueSortedStrings(facets.map((facet) =>
      facet.profileMode ?? facet.profile_mode)),
    profileKinds: uniqueSortedStrings(facets.map((facet) =>
      facet.profileKind ?? facet.profile_kind)),
    profile_kinds: uniqueSortedStrings(facets.map((facet) =>
      facet.profileKind ?? facet.profile_kind)),
    sizeClasses: uniqueSortedStrings(facets.map((facet) =>
      facet.sizeClass ?? facet.size_class)),
    size_classes: uniqueSortedStrings(facets.map((facet) =>
      facet.sizeClass ?? facet.size_class)),
    coldPathKinds: uniqueSortedStrings(facets.map((facet) =>
      facet.coldPathKind ?? facet.cold_path_kind)),
    cold_path_kinds: uniqueSortedStrings(facets.map((facet) =>
      facet.coldPathKind ?? facet.cold_path_kind)),
    buildFamilies: uniqueSortedStrings(facets.flatMap((facet) =>
      facet.buildFamilies ?? facet.build_families ?? [])),
    build_families: uniqueSortedStrings(facets.flatMap((facet) =>
      facet.buildFamilies ?? facet.build_families ?? [])),
    runtimeBoundaryStages: uniqueSortedStrings(facets.flatMap((facet) =>
      facet.runtimeBoundaryStages ?? facet.runtime_boundary_stages ?? [])),
    runtime_boundary_stages: uniqueSortedStrings(facets.flatMap((facet) =>
      facet.runtimeBoundaryStages ?? facet.runtime_boundary_stages ?? [])),
    oracleKinds: uniqueSortedStrings(facets.flatMap((facet) =>
      facet.oracleKinds ?? facet.oracle_kinds ?? [])),
    oracle_kinds: uniqueSortedStrings(facets.flatMap((facet) =>
      facet.oracleKinds ?? facet.oracle_kinds ?? [])),
  };
}

function samplePoolCoverageContract({ candidates, selected, requestedCount } = {}) {
  const candidateSummary = selectionFacetSummary(candidates);
  const selectedSummary = selectionFacetSummary(selected);
  const availableBuckets = candidateSummary.selectionBuckets ?? [];
  const selectedBuckets = selectedSummary.selectionBuckets ?? [];
  const requiredBuckets = CONFIGURED_SAMPLE_POOL_REQUIRED_BUCKETS.filter((bucket) =>
    availableBuckets.includes(bucket));
  const missingRequiredBuckets = requiredBuckets.filter((bucket) => !selectedBuckets.includes(bucket));
  const countValue = Math.max(1, Number(requestedCount) || 1);
  const coverageEnforced = requiredBuckets.length > 0 && countValue >= requiredBuckets.length;
  const coverageLimitedByRequestedCount = requiredBuckets.length > countValue;
  const coverageHash = contentHash(stableJson({
    requiredBuckets,
    availableBuckets,
    selectedBuckets,
    requestedCount: countValue,
    missingRequiredBuckets,
  }));
  return {
    schemaVersion: SAMPLE_POOL_COVERAGE_CONTRACT_SCHEMA,
    schema_version: SAMPLE_POOL_COVERAGE_CONTRACT_SCHEMA,
    proofAuthority: SAMPLE_POOL_COVERAGE_CONTRACT_AUTHORITY,
    proof_authority: SAMPLE_POOL_COVERAGE_CONTRACT_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    requiredBuckets,
    required_buckets: requiredBuckets,
    availableBuckets,
    available_buckets: availableBuckets,
    selectedBuckets,
    selected_buckets: selectedBuckets,
    requiredBucketCount: requiredBuckets.length,
    required_bucket_count: requiredBuckets.length,
    selectedBucketCount: selectedBuckets.length,
    selected_bucket_count: selectedBuckets.length,
    requiredBucketCoverageSatisfied: missingRequiredBuckets.length === 0,
    required_bucket_coverage_satisfied: missingRequiredBuckets.length === 0,
    coverageEnforced,
    coverage_enforced: coverageEnforced,
    coverageLimitedByRequestedCount,
    coverage_limited_by_requested_count: coverageLimitedByRequestedCount,
    coverageAcceptableForRequestedCount:
      !coverageEnforced || missingRequiredBuckets.length === 0,
    coverage_acceptable_for_requested_count:
      !coverageEnforced || missingRequiredBuckets.length === 0,
    missingRequiredBuckets,
    missing_required_buckets: missingRequiredBuckets,
    candidateFacetSummary: candidateSummary,
    candidate_facet_summary: candidateSummary,
    selectedFacetSummary: selectedSummary,
    selected_facet_summary: selectedSummary,
    coverageHash,
    coverage_hash: coverageHash,
    evidenceRef: `random-cold-path-sample-pool-coverage:${coverageHash}`,
    evidence_ref: `random-cold-path-sample-pool-coverage:${coverageHash}`,
  };
}

function candidateSelectionEntry(candidate, seed, { stratifyByClass = false } = {}) {
  const selectionFacets = candidateSelectionFacets(candidate);
  const selectionBucket = stratifyByClass
    ? selectionFacets.selectionBucket
    : 'identity_sort';
  const selectionAlgorithm = stratifyByClass
    ? CLASS_BUCKET_SELECTION_ALGORITHM
    : IDENTITY_SORT_SELECTION_ALGORITHM;
  const selectionKey = sha256(
    `${seed}\0${selectionAlgorithm}\0${selectionBucket}\0${candidate.id}\0${candidate.sourceUrl}\0${candidate.immutableCommit}`,
  );
  return {
    candidate,
    selectionAlgorithm,
    selectionBucket,
    selectionFacets,
    selectionKey,
  };
}

function selectCandidates({ candidates, seed, count, candidateId, stratifyByClass = false }) {
  let pool = candidates;
  if (candidateId) {
    pool = candidates.filter((candidate) => candidate.id === candidateId);
    if (pool.length === 0) throw new Error(`candidate not found: ${candidateId}`);
  }
  const requestedCount = Math.max(1, Math.min(Number(count) || 1, pool.length));
  const entries = pool
    .map((candidate) => candidateSelectionEntry(candidate, seed, { stratifyByClass }))
    .sort((a, b) => a.selectionKey.localeCompare(b.selectionKey));
  const selectedEntries = [];
  if (stratifyByClass && !candidateId) {
    const buckets = new Map();
    for (const entry of entries) {
      const queue = buckets.get(entry.selectionBucket) ?? [];
      queue.push(entry);
      buckets.set(entry.selectionBucket, queue);
    }
    const bucketOrder = [...buckets.keys()].sort((a, b) =>
      sha256(`${seed}\0bucket\0${a}`).localeCompare(sha256(`${seed}\0bucket\0${b}`))
    );
    while (selectedEntries.length < requestedCount) {
      let advanced = false;
      for (const bucket of bucketOrder) {
        const queue = buckets.get(bucket) ?? [];
        if (queue.length === 0) continue;
        selectedEntries.push(queue.shift());
        advanced = true;
        if (selectedEntries.length >= requestedCount) break;
      }
      if (!advanced) break;
    }
  } else {
    selectedEntries.push(...entries.slice(0, requestedCount));
  }
  return selectedEntries.map((entry, rank) => ({
    ...entry.candidate,
    selectionRank: rank + 1,
    selectionKey: entry.selectionKey,
    selection_key: entry.selectionKey,
    selectionBucket: entry.selectionBucket,
    selection_bucket: entry.selectionBucket,
    selectionAlgorithm: entry.selectionAlgorithm,
    selection_algorithm: entry.selectionAlgorithm,
    selectionFacets: entry.selectionFacets,
    selection_facets: entry.selectionFacets,
  }));
}

function defaultColdPathSelectionCount({
  directCandidate = null,
  directCandidates = [],
  samplePool = false,
} = {}) {
  if (directCandidate) return 1;
  if (Array.isArray(directCandidates) && directCandidates.length > 0) {
    return directCandidates.length;
  }
  return samplePool ? DEFAULT_CONFIGURED_SAMPLE_POOL_COUNT : 1;
}

function inferColdPathSourceMode(candidates = []) {
  const candidateSources = uniqueSortedStrings(
    candidates.map((candidate) => candidate.candidateSource ?? candidate.candidate_source),
  );
  if (
    candidateSources.length > 0
    && candidateSources.every((source) =>
      source === 'direct_source_url_commit' || source === 'direct_local_git_repo_path')
  ) {
    return candidateSources.length === 1 && candidateSources[0] === 'direct_local_git_repo_path'
      ? 'direct_local_user_source'
      : 'direct_user_source_batch';
  }
  if (candidateSources.length === 1 && candidateSources[0] === 'configured_candidate_pool') {
    return 'configured_candidate_pool';
  }
  return 'mixed_candidate_sources';
}

function coldPathSelectionAudit({
  seed,
  count,
  candidateId,
  dryRun,
  candidates,
  selected,
  results,
  sourceMode = null,
  requireDirectSource = false,
  samplePool = false,
} = {}) {
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const selectedList = Array.isArray(selected) ? selected : [];
  const resultList = Array.isArray(results) ? results : [];
  const selectedIds = selectedList.map((candidate) => candidate.id).filter(Boolean);
  const resultIds = resultList.map((result) => result?.candidateId).filter(Boolean);
  const sourceModeValue = sourceMode ?? inferColdPathSourceMode(candidateList);
  const candidateSources = uniqueSortedStrings(
    candidateList.map((candidate) => candidate.candidateSource ?? candidate.candidate_source),
  );
  const profileModes = uniqueSortedStrings(
    candidateList.map((candidate) => candidate.profileMode ?? candidate.profile_mode),
  );
  const backendFamilies = uniqueSortedStrings(
    candidateList.map((candidate) => candidate.backendFamily ?? candidate.backend_family),
  );
  const selectionAlgorithms = uniqueSortedStrings(
    selectedList.map((candidate) => candidate.selectionAlgorithm ?? candidate.selection_algorithm),
  );
  const selectedBuckets = uniqueSortedStrings(
    selectedList.map((candidate) => candidate.selectionBucket ?? candidate.selection_bucket),
  );
  const deterministicSelectionAlgorithm =
    selectionAlgorithms.length === 1
      ? selectionAlgorithms[0]
      : selectionAlgorithms.length > 1
        ? 'mixed_selection_algorithms'
        : IDENTITY_SORT_SELECTION_ALGORITHM;
  const selectedFacetSummary = selectionFacetSummary(selectedList);
  const samplePoolCoverage = samplePoolCoverageContract({
    candidates: candidateList,
    selected: selectedList,
    requestedCount: count,
  });
  const selectedResultsMatch =
    selectedIds.length === resultIds.length
    && stableJson([...selectedIds].sort()) === stableJson([...resultIds].sort());
  const directUserSourceCount = candidateList.filter((candidate) =>
    candidate.candidateSource === 'direct_source_url_commit'
    || candidate.candidateSource === 'direct_local_git_repo_path'
  ).length;
  const configuredPoolCount = candidateList.filter((candidate) =>
    candidate.candidateSource === 'configured_candidate_pool'
  ).length;
  const authorityClaims = [];
  for (const candidate of candidateList) {
    if (claimsGpuHmrAuthority(candidate)) authorityClaims.push(`candidate:${candidate.id}`);
    if (claimsGpuHmrAuthority(candidate.directInputEvidence ?? candidate.direct_input_evidence)) {
      authorityClaims.push(`direct_input_evidence:${candidate.id}`);
    }
  }
  for (const result of resultList) {
    if (claimsGpuHmrAuthority(result)) authorityClaims.push(`result:${result?.candidateId ?? 'unknown'}`);
    if (claimsGpuHmrAuthority(result?.directInputEvidence ?? result?.direct_input_evidence)) {
      authorityClaims.push(`result_direct_input_evidence:${result?.candidateId ?? 'unknown'}`);
    }
  }
  const selectionSeed = {
    seed,
    count: Number(count) || 1,
    candidateId: candidateId || null,
    sourceMode: sourceModeValue,
    candidateSources,
    profileModes,
    backendFamilies,
    selectionAlgorithms,
    selectedBuckets,
    selectedFacetSummary,
    samplePoolCoverageHash: samplePoolCoverage.coverageHash,
    candidateIds: candidateList.map((candidate) => candidate.id),
    selectedIds,
  };
  const blockingGaps = [
    candidateList.length > 0 ? null : 'cold_path_selection_candidate_pool_empty',
    selectedIds.length > 0 ? null : 'cold_path_selection_selected_ids_missing',
    selectedResultsMatch ? null : 'cold_path_selection_results_mismatch',
    authorityClaims.length === 0 ? null : 'cold_path_selection_authority_claim_present',
    requireDirectSource && directUserSourceCount === 0
      ? 'cold_path_direct_source_required_but_not_selected'
      : null,
    (sourceModeValue === 'configured_sample_pool' || sourceModeValue === 'configured_candidate_pool')
      && samplePool !== true
      ? 'cold_path_sample_pool_mode_not_explicitly_requested'
      : null,
    sourceModeValue === 'configured_sample_pool'
      && samplePool === true
      && samplePoolCoverage.coverageEnforced === true
      && samplePoolCoverage.coverageAcceptableForRequestedCount !== true
      ? 'cold_path_sample_pool_required_bucket_coverage_missing'
      : null,
  ].filter(Boolean);
  const auditHash = contentHash(stableJson({
    ...selectionSeed,
    dryRun: dryRun === true,
    requireDirectSource: requireDirectSource === true,
    samplePool: samplePool === true,
    authorityClaims,
    blockingGaps,
  }));
  return {
    schemaVersion: SELECTION_AUDIT_SCHEMA,
    schema_version: SELECTION_AUDIT_SCHEMA,
    proofAuthority: SELECTION_AUDIT_AUTHORITY,
    proof_authority: SELECTION_AUDIT_AUTHORITY,
    accepted: blockingGaps.length === 0,
    acceptedAsSelectionAudit: blockingGaps.length === 0,
    accepted_as_selection_audit: blockingGaps.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    sourceMode: sourceModeValue,
    source_mode: sourceModeValue,
    deterministicSelectionAlgorithm,
    deterministic_selection_algorithm: deterministicSelectionAlgorithm,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    directSourceRequired: requireDirectSource === true,
    direct_source_required: requireDirectSource === true,
    samplePoolExplicitlyRequested: samplePool === true,
    sample_pool_explicitly_requested: samplePool === true,
    directUserSourceCount,
    direct_user_source_count: directUserSourceCount,
    configuredPoolCount,
    configured_pool_count: configuredPoolCount,
    candidateCount: candidateList.length,
    candidate_count: candidateList.length,
    selectedCount: selectedIds.length,
    selected_count: selectedIds.length,
    resultCount: resultIds.length,
    result_count: resultIds.length,
    candidateSources,
    candidate_sources: candidateSources,
    profileModes,
    profile_modes: profileModes,
    backendFamilies,
    backend_families: backendFamilies,
    selectionAlgorithms,
    selection_algorithms: selectionAlgorithms,
    selectedBuckets,
    selected_buckets: selectedBuckets,
    selectedBucketCount: selectedBuckets.length,
    selected_bucket_count: selectedBuckets.length,
    selectedFacetSummary,
    selected_facet_summary: selectedFacetSummary,
    samplePoolCoverageContract: samplePoolCoverage,
    sample_pool_coverage_contract: samplePoolCoverage,
    selectedResultsMatch,
    selected_results_match: selectedResultsMatch,
    candidatePoolHash: contentHash(stableJson(candidateList.map((candidate) => ({
      id: candidate.id,
      candidateSource: candidate.candidateSource,
      profileMode: candidate.profileMode,
      backendFamily: candidate.backendFamily,
      immutableCommit: candidate.immutableCommit,
      runtimeProofProfilePath: candidate.runtimeProofProfileRelativePath ?? null,
      directInputEvidenceHash: candidate.directInputEvidence?.evidenceHash ?? null,
    })))),
    candidate_pool_hash: contentHash(stableJson(candidateList.map((candidate) => ({
      id: candidate.id,
      candidateSource: candidate.candidateSource,
      profileMode: candidate.profileMode,
      backendFamily: candidate.backendFamily,
      immutableCommit: candidate.immutableCommit,
      runtimeProofProfilePath: candidate.runtimeProofProfileRelativePath ?? null,
      directInputEvidenceHash: candidate.directInputEvidence?.evidenceHash ?? null,
    })))),
    selectedIdentityHash: contentHash(stableJson(selectionSeed)),
    selected_identity_hash: contentHash(stableJson(selectionSeed)),
    authorityClaims,
    authority_claims: authorityClaims,
    blockingGaps,
    blocking_gaps: blockingGaps,
    auditHash,
    audit_hash: auditHash,
    evidenceRef: `random-cold-path-selection-audit:${auditHash}`,
    evidence_ref: `random-cold-path-selection-audit:${auditHash}`,
  };
}

function tail(text, max = 8000) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(-max) : value;
}

function makeStamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 18);
}

function isInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function repoRelativePath(filePath) {
  return path.relative(REPO_ROOT, path.resolve(filePath)).replace(/\\/g, '/');
}

function resolveRepoBoundPath(rawPath, fieldName) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return null;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(REPO_ROOT, raw);
  if (!isInsideDirectory(REPO_ROOT, resolved)) {
    throw new Error(`${fieldName} must stay inside the repo: ${raw}`);
  }
  return resolved;
}

function killChildTree(child) {
  if (!child?.pid) return false;
  try {
    child.kill('SIGTERM');
  } catch {
    // Timeout cleanup is best-effort and never proof authority.
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      // child.kill above is the portable fallback.
    }
    try {
      spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Stop-Process -Id ${Number(child.pid)} -Force -ErrorAction SilentlyContinue`,
      ], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      // taskkill/child.kill may already have handled the child.
    }
  }
  const hardKill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already be gone.
    }
  }, 2000);
  hardKill.unref?.();
  return true;
}

function releaseChildHandles(child) {
  try {
    child?.stdin?.destroy?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
  try {
    child?.stdout?.destroy?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
  try {
    child?.stderr?.destroy?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
  try {
    child?.unref?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
}

function cleanupSourceIntakeGitProcesses(localPath) {
  if (process.platform !== 'win32') {
    return {
      attempted: false,
      reason: 'source_intake_git_process_cleanup_not_needed_on_non_windows',
    };
  }
  const startedAt = new Date().toISOString();
  const needle = path.resolve(localPath).replace(/'/g, "''");
  const script = [
    `$needle='${needle}'`,
    '$procs=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$needle*" -and ($_.Name -like "git*.exe" -or $_.Name -eq "ssh.exe") }',
    '$ids=@($procs | ForEach-Object { $_.ProcessId })',
    'if ($ids.Count -gt 0) { Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue }',
    '$ids -join ","',
  ].join('; ');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cleanedPids = String(result.stdout ?? '')
      .trim()
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      attempted: true,
      proofAuthority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      proof_authority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      localPath: path.relative(REPO_ROOT, path.resolve(localPath)).replace(/\\/g, '/'),
      local_path: path.relative(REPO_ROOT, path.resolve(localPath)).replace(/\\/g, '/'),
      cleanedPids,
      cleaned_pids: cleanedPids,
      exitCode: result.status,
      exit_code: result.status,
      signal: result.signal,
      timedOut: result.error?.code === 'ETIMEDOUT',
      timed_out: result.error?.code === 'ETIMEDOUT',
      stderrTail: tail(result.stderr ?? '', 2000),
      stderr_tail: tail(result.stderr ?? '', 2000),
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      attempted: true,
      proofAuthority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      proof_authority: 'source_intake_timeout_cleanup_only_not_gpu_hmr_success',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      error: error?.message || String(error),
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const {
      timeoutMs = 0,
      stdoutMax = 32000,
      stderrMax = 32000,
      streamOutput = true,
      ...spawnOptions
    } = options ?? {};
    const startedAt = new Date().toISOString();
    let child;
    try {
      child = spawn(command, args, spawnOptions);
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        error: error?.message || String(error),
        stdout: '',
        stderr: '',
        timedOut: false,
        timeoutMs: Number(timeoutMs) || 0,
        timeoutKillAttempted: false,
        childPid: null,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutKillAttempted = false;
    let settled = false;
    let timeoutFinalizeTimer = null;
    const timer = Number(timeoutMs) > 0
      ? setTimeout(() => {
        timedOut = true;
        timeoutKillAttempted = killChildTree(child);
        timeoutFinalizeTimer = setTimeout(() => {
          releaseChildHandles(child);
          finish({
            exitCode: null,
            signal: 'timeout-forced-finalize',
            error: 'process_timeout_forced_finalize',
            stdout,
            stderr,
          });
        }, 5000);
        timeoutFinalizeTimer.unref?.();
      }, Number(timeoutMs))
      : null;
    timer?.unref?.();
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
      resolve({
        ...payload,
        timedOut,
        timeoutMs: Number(timeoutMs) || 0,
        timeoutKillAttempted,
        childPid: child.pid ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    };
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      stdout = tail(stdout + text, stdoutMax);
      if (streamOutput) process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      stderr = tail(stderr + text, stderrMax);
      if (streamOutput) process.stderr.write(text);
    });
    child.on('error', (error) => {
      finish({ exitCode: null, signal: null, error: error.message, stdout, stderr });
    });
    child.on('close', (exitCode, signal) => {
      finish({ exitCode, signal, error: null, stdout, stderr });
    });
  });
}

function sourceIntakePathForCandidate(candidate) {
  return path.join(
    SOURCE_INTAKE_DIR,
    `${candidate.id}-${candidate.immutableCommit.slice(0, 12)}`,
  );
}

function classifySourceListing(files) {
  const buildFileBasenames = new Set([
    'cmakelists.txt',
    'makefile',
    'meson.build',
    'build.bazel',
    'workspace',
    'cargo.toml',
    'package.json',
    'pyproject.toml',
    'build.gradle',
    'configure.ac',
    'xmake.lua',
    'premake5.lua',
    'sconstruct',
    'sconscript',
    'build.gn',
  ]);
  const buildFileExtensions = new Set(['.sln', '.vcxproj', '.vcxproj.filters', '.csproj']);
  const gpuExtensions = new Set([
    '.hip',
    '.cu',
    '.cuh',
    '.cl',
    '.clh',
    '.wgsl',
    '.glsl',
    '.hlsl',
    '.spv',
    '.metal',
    '.comp',
    '.vert',
    '.frag',
    '.geom',
    '.tesc',
    '.tese',
    '.ll',
    '.mlir',
  ]);
  const sourceRelevantExtensions = new Set([
    ...gpuExtensions,
    '.c',
    '.cc',
    '.cpp',
    '.cxx',
    '.h',
    '.hh',
    '.hpp',
    '.hxx',
    '.ipp',
    '.inl',
    '.rs',
    '.zig',
    '.go',
    '.swift',
    '.m',
    '.mm',
    '.java',
    '.kt',
    '.kts',
    '.scala',
    '.cs',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rb',
    '.lua',
    '.nim',
    '.d',
    '.f',
    '.for',
    '.f90',
    '.f95',
    '.jl',
  ]);
  const backendSignals = new Map();
  const addBackend = (backend, pathName, reason) => {
    if (!backendSignals.has(backend)) backendSignals.set(backend, []);
    const entries = backendSignals.get(backend);
    if (entries.length < 20) entries.push({ path: pathName, reason });
  };
  const buildSignals = [];
  const gpuSourceSignals = [];
  const sourceRelevantFiles = [];
  let buildSignalCount = 0;
  let gpuSourceSignalCount = 0;
  let sourceRelevantFileCount = 0;
  let sourceOrBuildRelevantFileCount = 0;
  for (const file of files) {
    const pathName = String(file.path ?? '');
    const lower = pathName.toLowerCase();
    const basename = lower.split('/').pop() ?? lower;
    const ext = path.extname(lower);
    const isBuildSignal = buildFileBasenames.has(basename) || buildFileExtensions.has(ext);
    const isSourceRelevant = sourceRelevantExtensions.has(ext);
    const isGpuPathSourceSignal = isSourceRelevant && (
      lower.includes('/gpu/')
      || lower.includes('/kernel/')
      || lower.includes('/kernels/')
      || lower.includes('/shader/')
      || lower.includes('/shaders/')
      || /(^|\/)(device|kernel|shader)[^/]*\.(c|cc|cpp|cxx|h|hh|hpp|hxx|ipp|inl)$/i.test(lower)
    );
    const isGpuSourceSignal = gpuExtensions.has(ext) || isGpuPathSourceSignal;
    const isSourceOrBuildRelevant = isSourceRelevant || isBuildSignal;
    if (isBuildSignal) {
      buildSignalCount += 1;
      if (buildSignals.length < 80) buildSignals.push(pathName);
    }
    if (isGpuSourceSignal) {
      gpuSourceSignalCount += 1;
      if (gpuSourceSignals.length < 80) gpuSourceSignals.push(pathName);
    }
    if (isSourceRelevant) {
      sourceRelevantFileCount += 1;
      if (sourceRelevantFiles.length < 80) sourceRelevantFiles.push(pathName);
    }
    if (isSourceOrBuildRelevant) sourceOrBuildRelevantFileCount += 1;
    if (ext === '.hip' || lower.includes('/hip/') || lower.includes('rocm')) addBackend('hip_rocm', pathName, 'path_or_extension');
    if (ext === '.cu' || ext === '.cuh' || lower.includes('cuda')) addBackend('cuda', pathName, 'path_or_extension');
    if (ext === '.cl' || ext === '.clh' || lower.includes('opencl')) addBackend('opencl', pathName, 'path_or_extension');
    if (ext === '.wgsl' || lower.includes('wgpu') || lower.includes('webgpu')) addBackend('webgpu_wgsl', pathName, 'path_or_extension');
    if (
      ['.spv', '.glsl', '.hlsl', '.comp', '.vert', '.frag', '.geom', '.tesc', '.tese'].includes(ext)
      || lower.includes('vulkan')
    ) addBackend('vulkan', pathName, 'path_or_extension');
    if (ext === '.metal' || lower.includes('/metal/')) addBackend('metal', pathName, 'path_or_extension');
    if (lower.includes('sycl') || lower.includes('dpcpp')) addBackend('sycl', pathName, 'path_or_extension');
  }
  const backendCandidates = [...backendSignals.keys()].sort();
  return {
    buildSignals,
    build_signals: buildSignals,
    buildSignalCount,
    build_signal_count: buildSignalCount,
    gpuSourceSignals,
    gpu_source_signals: gpuSourceSignals,
    gpuSourceSignalCount,
    gpu_source_signal_count: gpuSourceSignalCount,
    sourceRelevantFiles,
    source_relevant_files: sourceRelevantFiles,
    sourceRelevantFileCount,
    source_relevant_file_count: sourceRelevantFileCount,
    sourceOrBuildRelevantFileCount,
    source_or_build_relevant_file_count: sourceOrBuildRelevantFileCount,
    backendCandidates,
    backend_candidates: backendCandidates,
    backendSignals: Object.fromEntries(backendSignals),
    backend_signals: Object.fromEntries(backendSignals),
  };
}

function classifyBuildSystemPath(pathName) {
  const normalized = String(pathName ?? '').replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const basename = lower.split('/').pop() ?? lower;
  const ext = path.extname(lower);
  if (basename === 'cmakelists.txt') return 'cmake';
  if (basename === 'cargo.toml') return 'cargo';
  if (basename === 'build.gn') return 'gn';
  if (basename === 'sconstruct' || basename === 'sconscript') return 'scons';
  if (basename === 'makefile') return 'make';
  if (basename === 'meson.build') return 'meson';
  if (basename === 'build.bazel' || basename === 'workspace') return 'bazel';
  if (basename === 'package.json') return 'npm_or_node';
  if (basename === 'pyproject.toml') return 'python_pyproject';
  if (basename === 'build.gradle') return 'gradle';
  if (basename === 'configure.ac') return 'autotools';
  if (basename === 'xmake.lua') return 'xmake';
  if (basename === 'premake5.lua') return 'premake';
  if (['.sln', '.vcxproj', '.vcxproj.filters', '.csproj'].includes(ext)) return 'msbuild';
  return 'unknown_build_file';
}

function buildMetadataBackendSignals(pathName, text) {
  const source = String(text ?? '');
  const pathHint = String(pathName ?? '').replace(/\\/g, '/').toLowerCase();
  const signals = [];
  const add = (backend, reason, regex) => {
    if (!regex.test(source) && !regex.test(pathHint)) return;
    signals.push({ backend, reason });
  };
  add(
    'hip_rocm',
    'rocm_hip_build_metadata_token',
    /\b(?:find_package\s*\(\s*(?:hip|rocm|rocblas|miopen|hipblas|hipdnn|migraphx|tensile|rocprim|rocrand|rocsolver|rocsparse|hipfft)\b|enable_language\s*\(\s*hip\b|languages\s+[^)\n]*\bhip\b|cmake_hip|hip::|hip_add_|hipcc|amdgpu_targets?|--amdgpu-target|rocm_path|rocm_cmake)\b/i,
  );
  add(
    'cuda',
    'cuda_build_metadata_token',
    /\b(?:find_package\s*\(\s*(?:cuda|cudatoolkit)\b|enable_language\s*\(\s*cuda\b|languages\s+[^)\n]*\bcuda\b|cmake_cuda|cuda::|cuda_add_|nvcc)\b/i,
  );
  add(
    'opencl',
    'opencl_build_metadata_token',
    /\b(?:find_package\s*\(\s*opencl\b|opencl::|cl_khr|clenqueue|opencl)\b/i,
  );
  add(
    'vulkan',
    'vulkan_build_metadata_token',
    /\b(?:find_package\s*\(\s*vulkan\b|vulkan::|glslang|shaderc|spirv|spir-v)\b/i,
  );
  add(
    'webgpu_wgsl',
    'webgpu_build_metadata_token',
    /\b(?:webgpu|wgpu|wgsl|naga)\b/i,
  );
  add(
    'sycl',
    'sycl_build_metadata_token',
    /\b(?:find_package\s*\(\s*(?:sycl|dpcpp|adaptivecpp|hipsycl)\b|-fsycl|dpcpp|oneapi::dpl|sycl)\b/i,
  );
  add(
    'metal',
    'metal_build_metadata_token',
    /\b(?:metal::|metal-cpp|metallib|xcrun\s+metal|metal)\b/i,
  );
  const seen = new Set();
  return signals.filter((signal) => {
    const key = `${signal.backend}:${signal.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildMetadataBackendCandidates(contentEvidence = {}) {
  const accepted = contentEvidence?.acceptedAsBuildMetadataContent === true
    || contentEvidence?.accepted_as_build_metadata_content === true
    || contentEvidence?.accepted === true;
  if (!accepted) {
    return {
      candidates: [],
      signals: [],
    };
  }
  const buildFiles = Array.isArray(contentEvidence.buildFiles)
    ? contentEvidence.buildFiles
    : Array.isArray(contentEvidence.build_files)
      ? contentEvidence.build_files
      : [];
  const candidates = new Set();
  const signals = [];
  for (const buildFile of buildFiles) {
    const summary = buildFile.semanticSummary ?? buildFile.semantic_summary ?? {};
    const authority = summary.backendSignalAuthority ?? summary.backend_signal_authority;
    if (authority !== BUILD_METADATA_BACKEND_SIGNAL_AUTHORITY) continue;
    const fileSignals = Array.isArray(summary.backendSignals)
      ? summary.backendSignals
      : Array.isArray(summary.backend_signals)
        ? summary.backend_signals
        : [];
    for (const signal of fileSignals) {
      const backend = typeof signal.backend === 'string' ? signal.backend.trim() : '';
      const reason = typeof signal.reason === 'string' ? signal.reason.trim() : 'build_metadata_token';
      if (!backend) continue;
      candidates.add(backend);
      if (signals.length < 40) {
        signals.push({
          path: buildFile.path,
          backend,
          reason,
        });
      }
    }
  }
  return {
    candidates: [...candidates].sort(),
    signals,
  };
}

function mergeClassificationWithBuildMetadataContent(classification = {}, contentEvidence = {}) {
  const backendSignals = new Map(Object.entries(classification.backendSignals ?? {}));
  const buildMetadata = buildMetadataBackendCandidates(contentEvidence);
  for (const signal of buildMetadata.signals) {
    if (!backendSignals.has(signal.backend)) backendSignals.set(signal.backend, []);
    const entries = backendSignals.get(signal.backend);
    if (entries.length < 20) {
      entries.push({
        path: signal.path,
        reason: signal.reason,
        source: 'verified_build_metadata_content',
      });
    }
  }
  const backendCandidates = [
    ...new Set([
      ...(Array.isArray(classification.backendCandidates)
        ? classification.backendCandidates
        : []),
      ...buildMetadata.candidates,
    ]),
  ].sort();
  return {
    ...classification,
    backendCandidates,
    backend_candidates: backendCandidates,
    backendSignals: Object.fromEntries([...backendSignals.entries()]),
    backend_signals: Object.fromEntries([...backendSignals.entries()]),
    buildMetadataBackendCandidates: buildMetadata.candidates,
    build_metadata_backend_candidates: buildMetadata.candidates,
    buildMetadataBackendSignals: buildMetadata.signals,
    build_metadata_backend_signals: buildMetadata.signals,
    backendCandidateAuthority:
      'source_listing_and_verified_build_metadata_classification_only_not_runtime_authority',
    backend_candidate_authority:
      'source_listing_and_verified_build_metadata_classification_only_not_runtime_authority',
  };
}

function summarizeBuildMetadataContent(pathName, text) {
  const family = classifyBuildSystemPath(pathName);
  const lines = String(text ?? '').split(/\r?\n/);
  const backendSignals = buildMetadataBackendSignals(pathName, text);
  const backendSignalCandidates = [...new Set(backendSignals.map((entry) => entry.backend))].sort();
  const summary = {
    family,
    nonEmptyLineCount: lines.filter((line) => line.trim()).length,
    non_empty_line_count: lines.filter((line) => line.trim()).length,
    backendSignalCandidates,
    backend_signal_candidates: backendSignalCandidates,
    backendSignals,
    backend_signals: backendSignals,
    backendSignalAuthority:
      BUILD_METADATA_BACKEND_SIGNAL_AUTHORITY,
    backend_signal_authority:
      BUILD_METADATA_BACKEND_SIGNAL_AUTHORITY,
  };
  if (family === 'cmake') {
    const projectMatch = String(text).match(/\bproject\s*\(\s*([A-Za-z0-9_.+-]+)/i);
    summary.projectName = projectMatch?.[1] ?? null;
    summary.project_name = projectMatch?.[1] ?? null;
    summary.addExecutableCount = (String(text).match(/\badd_executable\s*\(/gi) ?? []).length;
    summary.add_executable_count = summary.addExecutableCount;
    summary.addLibraryCount = (String(text).match(/\badd_library\s*\(/gi) ?? []).length;
    summary.add_library_count = summary.addLibraryCount;
  } else if (family === 'cargo') {
    summary.hasPackageSection = /^\s*\[package\]\s*$/mi.test(String(text));
    summary.has_package_section = summary.hasPackageSection;
    summary.hasWorkspaceSection = /^\s*\[workspace\]\s*$/mi.test(String(text));
    summary.has_workspace_section = summary.hasWorkspaceSection;
    summary.dependencySectionCount = (String(text).match(/^\s*\[(?:[\w.-]+\.)?dependencies[.\w-]*\]\s*$/gmi) ?? []).length;
    summary.dependency_section_count = summary.dependencySectionCount;
  } else if (family === 'npm_or_node') {
    try {
      const parsed = JSON.parse(String(text));
      summary.packageName = typeof parsed?.name === 'string' ? parsed.name : null;
      summary.package_name = summary.packageName;
      summary.scriptNames = parsed?.scripts && typeof parsed.scripts === 'object'
        ? Object.keys(parsed.scripts).sort().slice(0, 40)
        : [];
      summary.script_names = summary.scriptNames;
    } catch {
      summary.jsonParseError = true;
      summary.json_parse_error = true;
    }
  } else if (family === 'gn') {
    summary.targetDefinitionCount = (String(text).match(/\b(?:executable|source_set|static_library|shared_library|group)\s*\(/g) ?? []).length;
    summary.target_definition_count = summary.targetDefinitionCount;
  } else if (family === 'scons') {
    summary.programCallCount = (String(text).match(/\bProgram\s*\(/g) ?? []).length;
    summary.program_call_count = summary.programCallCount;
    summary.libraryCallCount = (String(text).match(/\b(?:Library|SharedLibrary|StaticLibrary)\s*\(/g) ?? []).length;
    summary.library_call_count = summary.libraryCallCount;
  }
  return summary;
}

function selectBuildFilesForContent({ files, classification, maxFiles = BUILD_METADATA_CONTENT_MAX_FILES }) {
  const byPath = new Map(files.map((file) => [String(file.path), file]));
  const dependencySegments = new Set([
    '3rdparty',
    'deps',
    'dependencies',
    'extern',
    'external',
    'externals',
    'node_modules',
    'submodule',
    'submodules',
    'third-party',
    'third_party',
    'vendor',
    'vendors',
  ]);
  const rankBuildPath = (pathName) => {
    const normalized = String(pathName ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    const segments = normalized.toLowerCase().split('/').filter(Boolean);
    const depth = Math.max(0, segments.length - 1);
    const dependencyIndex = segments.findIndex((segment) => dependencySegments.has(segment));
    const dependencyPenalty = dependencyIndex >= 0 ? 1000 + dependencyIndex : 0;
    const basename = segments.at(-1) ?? '';
    const rootBuildBonus = depth === 0 ? -200 : 0;
    const buildFilePriority = basename === 'cmakelists.txt'
      || basename === 'build.gn'
      || basename === 'build.bazel'
      || basename === 'cargo.toml'
      || basename === 'pyproject.toml'
      || basename === 'package.json'
      || basename === 'makefile'
      ? -20
      : 0;
    return {
      score: dependencyPenalty + (depth * 10) + rootBuildBonus + buildFilePriority,
      path: normalized,
    };
  };
  return (classification?.buildSignals ?? [])
    .map((pathName, index) => ({
      index,
      pathName: String(pathName),
      file: byPath.get(String(pathName)),
      rank: rankBuildPath(pathName),
    }))
    .filter((entry) => entry.file)
    .sort((left, right) =>
      left.rank.score - right.rank.score
      || left.rank.path.localeCompare(right.rank.path)
      || left.index - right.index
    )
    .map((entry) => entry.file)
    .slice(0, maxFiles);
}

async function readBuildFileContent({
  candidate,
  file,
  transport,
  transportEvidence,
  sourceIntakeTimeoutMs,
}) {
  const pathName = String(file.path ?? '');
  if (
    transport === 'local_git_ls_tree_clean_worktree'
    || transport === 'local_git_ls_tree_no_size_clean_worktree'
    || transport === 'local_git_ls_tree_commit_snapshot_dirty_worktree'
  ) {
    const noSizeLocalTransport = transport === 'local_git_ls_tree_no_size_clean_worktree';
    const dirtyCommitSnapshotTransport =
      transport === 'local_git_ls_tree_commit_snapshot_dirty_worktree';
    const lazyBlobFetchAllowed = !noSizeLocalTransport
      || bloblessBuildMetadataContentFetchEnabled();
    const repoPath = transportEvidence?.resolvedTopLevel ?? transportEvidence?.resolved_top_level ?? candidate.localRepoPath;
    const show = await runProcess(
      'git',
      ['-C', path.resolve(repoPath), 'show', `${candidate.immutableCommit}:${pathName}`],
      {
        cwd: REPO_ROOT,
        env: lazyBlobFetchAllowed
          ? process.env
          : {
            ...process.env,
            GIT_NO_LAZY_FETCH: '1',
          },
        timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
        stdoutMax: BUILD_METADATA_CONTENT_MAX_BYTES + 4096,
        stderrMax: 16000,
        streamOutput: false,
      },
    );
    if (show.exitCode !== 0 || show.timedOut || show.error) {
      return {
        path: pathName,
        accepted: false,
        status: 'local_git_build_file_read_failed',
        reason: 'local_git_build_file_read_failed',
        lazyBlobFetchAllowed,
        lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
        result: show,
      };
    }
    return {
      path: pathName,
      accepted: true,
      transport: dirtyCommitSnapshotTransport
        ? 'local_git_commit_snapshot_show'
        : noSizeLocalTransport
          ? 'local_git_no_size_show'
          : 'local_git_show',
      lazyBlobFetchAllowed,
      lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
      content: show.stdout,
    };
  }
  if (transport === 'git_fetch_depth_1_blobless' || transport === 'git_fetch_depth_1_full_tree') {
    const fullTreeTransport = transport === 'git_fetch_depth_1_full_tree';
    const lazyBlobFetchAllowed = fullTreeTransport || bloblessBuildMetadataContentFetchEnabled();
    const repoPath = transportEvidence?.resolvedLocalPath
      ?? transportEvidence?.resolved_local_path
      ?? transportEvidence?.localPath
      ?? transportEvidence?.local_path;
    if (!repoPath) {
      return {
        path: pathName,
        accepted: false,
        status: 'git_fetch_build_file_repo_path_missing',
        reason: 'git_fetch_build_file_repo_path_missing',
        transport,
      };
    }
    const resolvedRepoPath = path.isAbsolute(String(repoPath))
      ? path.resolve(String(repoPath))
      : path.resolve(REPO_ROOT, String(repoPath));
    const show = await runProcess(
      'git',
      ['-C', resolvedRepoPath, 'show', `${candidate.immutableCommit}:${pathName}`],
      {
        cwd: REPO_ROOT,
        env: lazyBlobFetchAllowed
          ? process.env
          : {
            ...process.env,
            GIT_NO_LAZY_FETCH: '1',
          },
        timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
        stdoutMax: BUILD_METADATA_CONTENT_MAX_BYTES + 4096,
        stderrMax: 16000,
        streamOutput: false,
      },
    );
    if (show.exitCode !== 0 || show.timedOut || show.error) {
      const githubFallback = await readBuildFileContent({
        candidate,
        file,
        transport: 'github_git_tree_api_recursive',
        transportEvidence,
        sourceIntakeTimeoutMs,
      });
      if (githubFallback.accepted === true) {
        return {
          ...githubFallback,
          transport: `${githubFallback.transport ?? 'github_build_file_content'}_after_git_fetch_show_failed`,
          fallbackTransport: githubFallback.transport ?? null,
          fallback_transport: githubFallback.transport ?? null,
          fallbackFromTransport: transport,
          fallback_from_transport: transport,
          fallbackReason: 'git_fetch_build_file_read_failed',
          fallback_reason: 'git_fetch_build_file_read_failed',
          fallbackGitShowResult: show,
          fallback_git_show_result: show,
        };
      }
      return {
        path: pathName,
        accepted: false,
        status: 'git_fetch_build_file_read_failed',
        reason: 'git_fetch_build_file_read_failed',
        transport,
        lazyBlobFetchAllowed,
        lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
        result: show,
        fallbackAttempt: githubFallback,
        fallback_attempt: githubFallback,
      };
    }
    return {
      path: pathName,
      accepted: true,
      transport: fullTreeTransport ? 'git_fetch_full_tree_show' : 'git_fetch_blobless_show',
      lazyBlobFetchAllowed,
      lazy_blob_fetch_allowed: lazyBlobFetchAllowed,
      content: show.stdout,
    };
  }
  if (transport === 'github_git_tree_api_recursive') {
    const parsed = parseGitHubRepoUrl(candidate.sourceUrl);
    if (!parsed) {
      return {
        path: pathName,
        accepted: false,
        status: 'github_build_file_blob_repo_unparsed',
        reason: 'github_build_file_blob_repo_unparsed',
      };
    }
    const rawUrl = githubRawUrlForPath(parsed, candidate.immutableCommit, pathName);
    const rawController = new AbortController();
    const rawTimer = setTimeout(() => rawController.abort(), Math.min(sourceIntakeTimeoutMs, 60000));
    rawTimer.unref?.();
    try {
      const rawResponse = await fetch(rawUrl, { signal: rawController.signal });
      const rawBytes = Buffer.from(await rawResponse.arrayBuffer());
      if (rawResponse.ok) {
        const observedObject = gitBlobObjectId(rawBytes);
        const expectedObject = String(file.object ?? '').trim().toLowerCase();
        if (expectedObject && observedObject !== expectedObject) {
          return {
            path: pathName,
            accepted: false,
            status: 'github_raw_build_file_object_mismatch',
            reason: 'github_raw_build_file_object_mismatch',
            rawUrl,
            raw_url: rawUrl,
            expectedObject,
            expected_object: expectedObject,
            observedObject,
            observed_object: observedObject,
          };
        }
        return {
          path: pathName,
          accepted: true,
          transport: 'github_raw_commit_blob_verified',
          rawUrl,
          raw_url: rawUrl,
          expectedObject,
          expected_object: expectedObject,
          observedObject,
          observed_object: observedObject,
          content: rawBytes.toString('utf8', 0, Math.min(rawBytes.length, BUILD_METADATA_CONTENT_MAX_BYTES)),
          byteLength: rawBytes.length,
          byte_length: rawBytes.length,
          truncated: rawBytes.length > BUILD_METADATA_CONTENT_MAX_BYTES,
        };
      }
    } catch {
      // Fall through to the GitHub blob API path below; failures are recorded there.
    } finally {
      clearTimeout(rawTimer);
    }
    const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/blobs/${file.object}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(sourceIntakeTimeoutMs, 60000));
    timer.unref?.();
    const githubApi = githubApiHeaders();
    try {
      const response = await fetch(apiUrl, {
        headers: githubApi.headers,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          path: pathName,
          accepted: false,
          status: 'github_build_file_blob_fetch_failed',
          reason: 'github_build_file_blob_fetch_failed',
          apiUrl,
          api_url: apiUrl,
          githubApiAuthentication: githubApi.authEvidence,
          github_api_authentication: githubApi.authEvidence,
          httpStatus: response.status,
          http_status: response.status,
          bodyTail: tail(text, 1000),
          body_tail: tail(text, 1000),
        };
      }
      const payload = JSON.parse(text);
      if (payload?.encoding !== 'base64' || typeof payload?.content !== 'string') {
        return {
          path: pathName,
          accepted: false,
          status: 'github_build_file_blob_encoding_unsupported',
          reason: 'github_build_file_blob_encoding_unsupported',
          apiUrl,
          api_url: apiUrl,
          githubApiAuthentication: githubApi.authEvidence,
          github_api_authentication: githubApi.authEvidence,
        };
      }
      const bytes = Buffer.from(payload.content.replace(/\s/g, ''), 'base64');
      return {
        path: pathName,
        accepted: true,
        transport: 'github_git_blob_api',
        apiUrl,
        api_url: apiUrl,
        githubApiAuthentication: githubApi.authEvidence,
        github_api_authentication: githubApi.authEvidence,
        content: bytes.toString('utf8', 0, Math.min(bytes.length, BUILD_METADATA_CONTENT_MAX_BYTES)),
        byteLength: bytes.length,
        byte_length: bytes.length,
        truncated: bytes.length > BUILD_METADATA_CONTENT_MAX_BYTES,
      };
    } catch (error) {
      return {
        path: pathName,
        accepted: false,
        status: error?.name === 'AbortError'
          ? 'github_build_file_blob_timeout'
          : 'github_build_file_blob_error',
        reason: error?.name === 'AbortError'
          ? 'github_build_file_blob_timeout'
          : 'github_build_file_blob_error',
        apiUrl,
        api_url: apiUrl,
        githubApiAuthentication: githubApi.authEvidence,
        github_api_authentication: githubApi.authEvidence,
        error: error?.message || String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    path: pathName,
    accepted: false,
    status: 'build_file_content_transport_unsupported',
    reason: 'build_file_content_transport_unsupported',
    transport,
  };
}

async function collectBuildMetadataContentEvidence({
  candidate,
  files,
  classification,
  transport,
  transportEvidence,
  sourceIntakeTimeoutMs,
}) {
  const selectedFiles = selectBuildFilesForContent({ files, classification });
  const startedAt = new Date().toISOString();
  const buildFiles = [];
  const failedFiles = [];
  for (const file of selectedFiles) {
    // Build file content is support evidence; keep it bounded and sequential to avoid
    // turning arbitrary project intake into an uncontrolled crawler.
    const result = await readBuildFileContent({
      candidate,
      file,
      transport,
      transportEvidence,
      sourceIntakeTimeoutMs,
    });
    if (result.accepted === true) {
      const content = String(result.content ?? '');
      buildFiles.push({
        path: file.path,
        family: classifyBuildSystemPath(file.path),
        object: file.object,
        declaredByteLength: file.byteLength,
        declared_byte_length: file.byteLength,
        observedByteLength: Number.isFinite(result.byteLength) ? result.byteLength : Buffer.byteLength(content),
        observed_byte_length: Number.isFinite(result.byteLength) ? result.byteLength : Buffer.byteLength(content),
        contentHash: contentHash(content),
        content_hash: contentHash(content),
        truncated: result.truncated === true || Buffer.byteLength(content) > BUILD_METADATA_CONTENT_MAX_BYTES,
        transport: result.transport,
        fallbackTransport: result.fallbackTransport ?? null,
        fallback_transport: result.fallback_transport ?? result.fallbackTransport ?? null,
        fallbackFromTransport: result.fallbackFromTransport ?? null,
        fallback_from_transport: result.fallback_from_transport ?? result.fallbackFromTransport ?? null,
        fallbackReason: result.fallbackReason ?? null,
        fallback_reason: result.fallback_reason ?? result.fallbackReason ?? null,
        lazyBlobFetchAllowed: result.lazyBlobFetchAllowed === true,
        lazy_blob_fetch_allowed: result.lazyBlobFetchAllowed === true,
        githubApiAuthentication: result.githubApiAuthentication ?? null,
        github_api_authentication: result.github_api_authentication ?? null,
        semanticSummary: summarizeBuildMetadataContent(file.path, content),
        semantic_summary: summarizeBuildMetadataContent(file.path, content),
      });
    } else {
      failedFiles.push(result);
    }
  }
  const evidence = {
    schemaVersion: BUILD_METADATA_CONTENT_SCHEMA,
    schema_version: BUILD_METADATA_CONTENT_SCHEMA,
    proofAuthority: BUILD_METADATA_CONTENT_AUTHORITY,
    proof_authority: BUILD_METADATA_CONTENT_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    acceptedAsBuildMetadataContent: buildFiles.length > 0,
    accepted_as_build_metadata_content: buildFiles.length > 0,
    completeForSelectedBuildFiles: failedFiles.length === 0 && buildFiles.length === selectedFiles.length,
    complete_for_selected_build_files: failedFiles.length === 0 && buildFiles.length === selectedFiles.length,
    selectedBuildFileCount: selectedFiles.length,
    selected_build_file_count: selectedFiles.length,
    acceptedBuildFileCount: buildFiles.length,
    accepted_build_file_count: buildFiles.length,
    failedBuildFileCount: failedFiles.length,
    failed_build_file_count: failedFiles.length,
    maxBuildFiles: BUILD_METADATA_CONTENT_MAX_FILES,
    max_build_files: BUILD_METADATA_CONTENT_MAX_FILES,
    maxBytesPerFile: BUILD_METADATA_CONTENT_MAX_BYTES,
    max_bytes_per_file: BUILD_METADATA_CONTENT_MAX_BYTES,
    buildFiles,
    build_files: buildFiles,
    failedFiles,
    failed_files: failedFiles,
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
    startedAt,
    started_at: startedAt,
    finishedAt: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  return {
    ...evidence,
    contentEvidenceHash: contentHash(stableJson(evidence)),
    content_evidence_hash: contentHash(stableJson(evidence)),
  };
}

function discoverBuildMetadata({ candidate, files, classification, contentEvidence = null }) {
  const buildSignals = Array.isArray(classification?.buildSignals)
    ? classification.buildSignals
    : [];
  const families = new Map();
  for (const pathName of buildSignals) {
    const family = classifyBuildSystemPath(pathName);
    if (!families.has(family)) families.set(family, []);
    const paths = families.get(family);
    if (paths.length < 20) paths.push(pathName);
  }
  const detectedFamilies = [...families.keys()].sort();
  const rootBuildFiles = buildSignals.filter((pathName) => !String(pathName).includes('/'));
  const blockingGaps = [];
  if (detectedFamilies.length === 0) blockingGaps.push('build_metadata_not_detected');
  const sourceFilesWithKnownBytes = files.filter((file) => Number.isFinite(file.byteLength)).length;
  const buildSignalCount = Number.isFinite(Number(classification?.buildSignalCount))
    ? Number(classification.buildSignalCount)
    : buildSignals.length;
  const gpuSourceSignalCount = Number.isFinite(Number(classification?.gpuSourceSignalCount))
    ? Number(classification.gpuSourceSignalCount)
    : 0;
  const sourceRelevantFileCount = Number.isFinite(Number(classification?.sourceRelevantFileCount))
    ? Number(classification.sourceRelevantFileCount)
    : 0;
  const sourceOrBuildRelevantFileCount =
    Number.isFinite(Number(classification?.sourceOrBuildRelevantFileCount))
      ? Number(classification.sourceOrBuildRelevantFileCount)
      : sourceRelevantFileCount;
  const discovery = {
    schemaVersion: BUILD_METADATA_DISCOVERY_SCHEMA,
    schema_version: BUILD_METADATA_DISCOVERY_SCHEMA,
    proofAuthority: BUILD_METADATA_DISCOVERY_AUTHORITY,
    proof_authority: BUILD_METADATA_DISCOVERY_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    acceptedAsBuildMetadataDiscovery: detectedFamilies.length > 0,
    accepted_as_build_metadata_discovery: detectedFamilies.length > 0,
    projectId: candidate.id,
    project_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    detectedBuildSystems: detectedFamilies,
    detected_build_systems: detectedFamilies,
    buildSystemSignals: Object.fromEntries([...families.entries()].map(([family, paths]) => [family, paths])),
    build_system_signals: Object.fromEntries([...families.entries()].map(([family, paths]) => [family, paths])),
    rootBuildFiles,
    root_build_files: rootBuildFiles,
    buildSignalCount,
    build_signal_count: buildSignalCount,
    gpuSourceSignalCount,
    gpu_source_signal_count: gpuSourceSignalCount,
    sourceRelevantFileCount,
    source_relevant_file_count: sourceRelevantFileCount,
    sourceOrBuildRelevantFileCount,
    source_or_build_relevant_file_count: sourceOrBuildRelevantFileCount,
    sourceFileCount: files.length,
    source_file_count: files.length,
    sourceFilesWithKnownBytes,
    source_files_with_known_bytes: sourceFilesWithKnownBytes,
    backendCandidates: classification?.backendCandidates ?? [],
    backend_candidates: classification?.backendCandidates ?? [],
    buildMetadataContentEvidence: contentEvidence,
    build_metadata_content_evidence: contentEvidence,
    buildMetadataContentAccepted: contentEvidence?.acceptedAsBuildMetadataContent === true,
    build_metadata_content_accepted: contentEvidence?.acceptedAsBuildMetadataContent === true,
    remainingVerificationGaps: [
      contentEvidence?.acceptedAsBuildMetadataContent === true
        ? 'semantic_build_metadata_execution_missing'
        : 'semantic_build_metadata_verification_missing',
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    remaining_verification_gaps: [
      contentEvidence?.acceptedAsBuildMetadataContent === true
        ? 'semantic_build_metadata_execution_missing'
        : 'semantic_build_metadata_verification_missing',
      'build_command_execution_not_observed',
      'compile_database_not_verified',
      'runtime_profile_contract_missing',
    ],
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
  return {
    ...discovery,
    discoveryHash: contentHash(stableJson(discovery)),
    discovery_hash: contentHash(stableJson(discovery)),
  };
}

function genericBuildExecutionStepsForFamilies(buildSystems = []) {
  const families = uniqueSortedStrings(buildSystems);
  const genericSteps = [
    {
      step: 'configure_or_prepare_build_graph',
      requiredEvidence: ['build_command_invocation', 'build_environment_snapshot'],
      required_evidence: ['build_command_invocation', 'build_environment_snapshot'],
    },
    {
      step: 'capture_compiler_invocations',
      requiredEvidence: ['compile_database_or_compiler_trace'],
      required_evidence: ['compile_database_or_compiler_trace'],
    },
    {
      step: 'build_smallest_device_artifact_candidate',
      requiredEvidence: ['device_artifact_hash_after_build', 'dependency_closure_hash'],
      required_evidence: ['device_artifact_hash_after_build', 'dependency_closure_hash'],
    },
  ];
  const familySteps = families.map((family) => ({
    step: `${family}_build_system_probe`,
    buildSystem: family,
    build_system: family,
    requiredEvidence: ['build_system_command_observed', 'exit_status_observed'],
    required_evidence: ['build_system_command_observed', 'exit_status_observed'],
  }));
  return [...genericSteps, ...familySteps];
}

function compileDatabaseCandidatePathsForFamilies(buildSystems = [], buildFiles = []) {
  const paths = new Set();
  for (const file of buildFiles) {
    const filePath = firstString(file.path, file.relativePath, file.relative_path);
    if (!filePath) continue;
    if (/compile_commands\.json$/i.test(filePath)) paths.add(filePath);
  }
  const families = new Set(uniqueSortedStrings(buildSystems));
  if (families.has('cmake')) {
    paths.add('compile_commands.json');
    paths.add('build/compile_commands.json');
    paths.add('out/compile_commands.json');
  }
  if (families.has('meson')) {
    paths.add('builddir/compile_commands.json');
    paths.add('build/compile_commands.json');
  }
  if (families.has('make') || families.has('autotools') || families.has('xmake')) {
    paths.add('compile_commands.json');
  }
  return [...paths].sort();
}

function deriveColdBuildExecutionPlan({
  candidate,
  sourceListingHash,
  buildMetadataDiscovery,
  buildMetadataContentEvidence,
  runtimeBoundaryExpectation,
}) {
  const buildSystems = uniqueSortedStrings([
    ...firstArrayField(buildMetadataDiscovery, 'detectedBuildSystems', 'detected_build_systems'),
  ]);
  const buildFiles = firstArrayField(
    buildMetadataContentEvidence,
    'buildFiles',
    'build_files',
  ).map((file) => ({
    path: firstString(file.path, file.relativePath, file.relative_path),
    contentHash: firstString(file.contentHash, file.content_hash),
    content_hash: firstString(file.contentHash, file.content_hash),
    family: firstString(file.family),
  })).filter((file) => file.path);
  const buildMetadataContentHash = firstString(
    buildMetadataContentEvidence.contentEvidenceHash,
    buildMetadataContentEvidence.content_evidence_hash,
  );
  const buildMetadataDiscoveryHash = firstString(
    buildMetadataDiscovery.discoveryHash,
    buildMetadataDiscovery.discovery_hash,
  );
  const runtimeBoundaryExpectationHash = firstString(
    runtimeBoundaryExpectation.expectationHash,
    runtimeBoundaryExpectation.expectation_hash,
  );
  const backendCandidates = uniqueSortedStrings([
    ...firstArrayField(runtimeBoundaryExpectation, 'backendCandidates', 'backend_candidates'),
    ...firstArrayField(buildMetadataDiscovery, 'backendCandidates', 'backend_candidates'),
  ]);
  const rootBuildFiles = uniqueSortedStrings([
    ...firstArrayField(buildMetadataDiscovery, 'rootBuildFiles', 'root_build_files'),
    ...buildFiles
      .map((file) => file.path)
      .filter((filePath) => filePath && !filePath.includes('/')),
  ]);
  const requiredBuildEvidence = [
    'build_command_invocation',
    'build_exit_status',
    'compile_database_or_compiler_trace',
    'device_artifact_hash_after_build',
    'dependency_closure_hash',
  ];
  const requiredRuntimeBridgeOutputs = [
    'runtime_profile_contract',
    'runtime_boundary_event_manifest',
    'artifact_transport_event',
    'epoch_publication_event',
    'dispatch_trace_event',
    'host_identity_event',
    'output_oracle_artifact',
  ];
  const failedGates = uniqueSortedStrings([
    claimsGpuHmrAuthority(candidate)
      ? 'cold_build_execution_plan_candidate_claimed_gpu_hmr_authority'
      : null,
    sourceListingHash ? null : 'cold_build_execution_plan_source_listing_hash_missing',
    buildMetadataContentHash ? null : 'cold_build_execution_plan_build_metadata_hash_missing',
    buildMetadataDiscoveryHash ? null : 'cold_build_execution_plan_discovery_hash_missing',
    runtimeBoundaryExpectationHash ? null : 'cold_build_execution_plan_runtime_expectation_hash_missing',
    buildSystems.length > 0 ? null : 'cold_build_execution_plan_build_systems_missing',
    buildFiles.length > 0 ? null : 'cold_build_execution_plan_build_files_missing',
  ]);
  const blockingGaps = [
    backendCandidates.length > 0 ? null : 'cold_build_execution_plan_backend_candidates_missing',
    'build_command_execution_not_observed',
    'compile_database_not_verified',
    'compiler_invocation_trace_missing',
    'device_artifact_build_not_observed',
    'cold_runtime_profile_contract_not_executed',
  ].filter(Boolean);
  const plan = {
    schemaVersion: COLD_BUILD_EXECUTION_PLAN_SCHEMA,
    schema_version: COLD_BUILD_EXECUTION_PLAN_SCHEMA,
    proofAuthority: COLD_BUILD_EXECUTION_PLAN_AUTHORITY,
    proof_authority: COLD_BUILD_EXECUTION_PLAN_AUTHORITY,
    accepted: false,
    acceptedAsSupportEvidence: failedGates.length === 0,
    accepted_as_support_evidence: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    observedBuildExecution: false,
    observed_build_execution: false,
    observedCompileDatabase: false,
    observed_compile_database: false,
    observedDeviceArtifactBuild: false,
    observed_device_artifact_build: false,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    candidateId: candidate?.id ?? null,
    candidate_id: candidate?.id ?? null,
    sourceUrl: candidate?.sourceUrl ?? null,
    source_url: candidate?.sourceUrl ?? null,
    immutableCommit: candidate?.immutableCommit ?? null,
    immutable_commit: candidate?.immutableCommit ?? null,
    sourceListingHash,
    source_listing_hash: sourceListingHash,
    buildMetadataContentHash,
    build_metadata_content_hash: buildMetadataContentHash,
    buildMetadataDiscoveryHash,
    build_metadata_discovery_hash: buildMetadataDiscoveryHash,
    runtimeBoundaryExpectationHash,
    runtime_boundary_expectation_hash: runtimeBoundaryExpectationHash,
    buildSystems,
    build_systems: buildSystems,
    rootBuildFiles,
    root_build_files: rootBuildFiles,
    buildFiles,
    build_files: buildFiles,
    backendCandidates,
    backend_candidates: backendCandidates,
    compileDatabaseCandidatePaths: compileDatabaseCandidatePathsForFamilies(buildSystems, buildFiles),
    compile_database_candidate_paths: compileDatabaseCandidatePathsForFamilies(buildSystems, buildFiles),
    executionSteps: genericBuildExecutionStepsForFamilies(buildSystems),
    execution_steps: genericBuildExecutionStepsForFamilies(buildSystems),
    requiredBuildEvidence,
    required_build_evidence: requiredBuildEvidence,
    requiredRuntimeBridgeOutputs,
    required_runtime_bridge_outputs: requiredRuntimeBridgeOutputs,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
  return {
    ...plan,
    planHash: contentHash(stableJson(plan)),
    plan_hash: contentHash(stableJson(plan)),
  };
}

function runtimeRequirementsForBackend(backend) {
  const commonStages = [
    'runtime_profile_contract',
    RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_STAGE,
    'artifact_transport',
    'same_process_loader',
    'epoch_publication',
    'dispatch_trace',
    'host_identity',
    'output_oracle',
    'cpu_full_rebuild_restart_firewall',
    'strict_runtime_ledger',
  ];
  const table = {
    hip_rocm: {
      backend,
      artifactKind: 'hsaco_or_hip_module',
      artifact_kind: 'hsaco_or_hip_module',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'hip_module_load_or_code_object_load',
        'epoch_publish',
        'hip_kernel_dispatch',
        'stream_or_queue_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      expected_runtime_events: [
        'hip_module_load_or_code_object_load',
        'epoch_publish',
        'hip_kernel_dispatch',
        'stream_or_queue_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
    },
    opencl: {
      backend,
      artifactKind: 'opencl_program',
      artifact_kind: 'opencl_program',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'program_build_or_load',
        'epoch_publish',
        'cl_enqueue_kernel',
        'command_queue_identity',
        'cl_enqueue_read_buffer_after_event',
      ],
      expected_runtime_events: [
        'program_build_or_load',
        'epoch_publish',
        'cl_enqueue_kernel',
        'command_queue_identity',
        'cl_enqueue_read_buffer_after_event',
      ],
      acceptableOracleKinds: ['compute_readback'],
      acceptable_oracle_kinds: ['compute_readback'],
    },
    vulkan: {
      backend,
      artifactKind: 'spirv_pipeline',
      artifact_kind: 'spirv_pipeline',
      requiredStages: commonStages.concat(['pipeline_layout_binding', 'command_buffer_re_record_or_dynamic_binding']),
      required_stages: commonStages.concat(['pipeline_layout_binding', 'command_buffer_re_record_or_dynamic_binding']),
      expectedRuntimeEvents: [
        'shader_module_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_buffer_or_dispatch_bind',
        'queue_device_identity',
        'readback_or_frame_capture_after_epoch_dispatch',
      ],
      expected_runtime_events: [
        'shader_module_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_buffer_or_dispatch_bind',
        'queue_device_identity',
        'readback_or_frame_capture_after_epoch_dispatch',
      ],
      acceptableOracleKinds: ['deterministic_visual_oracle', 'compute_readback'],
      acceptable_oracle_kinds: ['deterministic_visual_oracle', 'compute_readback'],
    },
    webgpu_wgsl: {
      backend,
      artifactKind: 'wgsl_shader_module_or_pipeline',
      artifact_kind: 'wgsl_shader_module_or_pipeline',
      requiredStages: commonStages.concat(['pipeline_recreate_or_asset_reload']),
      required_stages: commonStages.concat(['pipeline_recreate_or_asset_reload']),
      expectedRuntimeEvents: [
        'shader_module_create',
        'pipeline_epoch_publish',
        'pass_dispatch_or_draw',
        'device_queue_identity',
        'mapped_buffer_or_frame_capture_after_epoch_dispatch',
      ],
      expected_runtime_events: [
        'shader_module_create',
        'pipeline_epoch_publish',
        'pass_dispatch_or_draw',
        'device_queue_identity',
        'mapped_buffer_or_frame_capture_after_epoch_dispatch',
      ],
      acceptableOracleKinds: ['mapped_buffer_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['mapped_buffer_readback', 'deterministic_visual_oracle'],
    },
    metal: {
      backend,
      artifactKind: 'metal_shader_library_or_pipeline',
      artifact_kind: 'metal_shader_library_or_pipeline',
      requiredStages: commonStages.concat(['pipeline_recreate_or_library_reload']),
      required_stages: commonStages.concat(['pipeline_recreate_or_library_reload']),
      expectedRuntimeEvents: [
        'library_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_encoder_dispatch_or_draw',
        'device_queue_identity',
        'buffer_or_frame_capture_after_epoch_dispatch',
      ],
      expected_runtime_events: [
        'library_or_pipeline_create',
        'pipeline_epoch_publish',
        'command_encoder_dispatch_or_draw',
        'device_queue_identity',
        'buffer_or_frame_capture_after_epoch_dispatch',
      ],
      acceptableOracleKinds: ['deterministic_visual_oracle', 'compute_readback'],
      acceptable_oracle_kinds: ['deterministic_visual_oracle', 'compute_readback'],
    },
    cuda: {
      backend,
      artifactKind: 'cuda_cubin_or_ptx',
      artifact_kind: 'cuda_cubin_or_ptx',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'cuda_module_load_or_jit',
        'epoch_publish',
        'cuda_kernel_launch',
        'stream_context_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      expected_runtime_events: [
        'cuda_module_load_or_jit',
        'epoch_publish',
        'cuda_kernel_launch',
        'stream_context_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
    },
    sycl: {
      backend,
      artifactKind: 'sycl_bundle_or_device_image',
      artifact_kind: 'sycl_bundle_or_device_image',
      requiredStages: commonStages,
      required_stages: commonStages,
      expectedRuntimeEvents: [
        'device_image_or_bundle_load',
        'epoch_publish',
        'queue_submit_kernel',
        'queue_device_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      expected_runtime_events: [
        'device_image_or_bundle_load',
        'epoch_publish',
        'queue_submit_kernel',
        'queue_device_identity',
        'readback_or_visual_output_after_dispatch',
      ],
      acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
      acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
    },
  };
  return table[backend] ?? {
    backend,
    artifactKind: 'unknown',
    artifact_kind: 'unknown',
    requiredStages: commonStages,
    required_stages: commonStages,
    expectedRuntimeEvents: [
      'artifact_load',
      'epoch_publish',
      'dispatch_trace',
      'host_identity',
      'output_oracle_after_dispatch',
    ],
    expected_runtime_events: [
      'artifact_load',
      'epoch_publish',
      'dispatch_trace',
      'host_identity',
      'output_oracle_after_dispatch',
    ],
    acceptableOracleKinds: ['compute_readback', 'deterministic_visual_oracle'],
    acceptable_oracle_kinds: ['compute_readback', 'deterministic_visual_oracle'],
  };
}

function deriveRuntimeBoundaryExpectation({ candidate, classification, buildMetadataDiscovery }) {
  const backendCandidates = Array.isArray(classification?.backendCandidates)
    ? classification.backendCandidates
    : [];
  const perBackendRequirements = backendCandidates.map(runtimeRequirementsForBackend);
  const requiredBoundaryStages = [
    ...new Set(perBackendRequirements.flatMap((entry) => entry.requiredStages ?? [])),
  ].sort();
  const expectedRuntimeEvents = [
    ...new Set(perBackendRequirements.flatMap((entry) => entry.expectedRuntimeEvents ?? [])),
  ].sort();
  const sourceDerivedOracleKinds = uniqueSortedStrings(
    perBackendRequirements.flatMap((entry) => entry.acceptableOracleKinds ?? []),
  );
  const candidateDeclaredOracleKinds = uniqueSortedStrings([
    ...(Array.isArray(candidate?.oracleHints?.expectedKinds)
      ? candidate.oracleHints.expectedKinds
      : []),
    ...(Array.isArray(candidate?.oracle_hints?.expected_kinds)
      ? candidate.oracle_hints.expected_kinds
      : []),
  ]);
  const candidateOracleHintClaimsAcceptance =
    candidate?.oracleHints?.acceptedByDeclaration === true
    || candidate?.oracleHints?.accepted_by_declaration === true
    || candidate?.oracle_hints?.acceptedByDeclaration === true
    || candidate?.oracle_hints?.accepted_by_declaration === true;
  const acceptableOracleKinds = sourceDerivedOracleKinds;
  const missingRuntimeEvidenceGaps = [
    'runtime_profile_contract_missing',
    RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_GAP,
    'artifact_transport_unproven',
    'same_process_loader_unproven',
    'epoch_publication_unproven',
    'dispatch_trace_unproven',
    'host_identity_unproven',
    'output_oracle_unproven',
    'cpu_full_rebuild_restart_firewall_unproven',
    'strict_runtime_ledger_missing',
  ];
  const blockingGaps = [];
  if (backendCandidates.length === 0) blockingGaps.push('runtime_backend_candidate_missing');
  if (buildMetadataDiscovery?.acceptedAsBuildMetadataDiscovery !== true) {
    blockingGaps.push('build_metadata_discovery_missing');
  }
  if (candidateOracleHintClaimsAcceptance) {
    blockingGaps.push('candidate_oracle_hint_acceptance_claim_rejected');
  }
  const facet = {
    schemaVersion: RUNTIME_BOUNDARY_EXPECTATION_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EXPECTATION_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_EXPECTATION_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_EXPECTATION_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    acceptedAsRuntimeBoundaryExpectation: blockingGaps.length === 0,
    accepted_as_runtime_boundary_expectation: blockingGaps.length === 0,
    projectId: candidate.id,
    project_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    backendCandidates,
    backend_candidates: backendCandidates,
    buildSystems: buildMetadataDiscovery?.detectedBuildSystems ?? [],
    build_systems: buildMetadataDiscovery?.detectedBuildSystems ?? [],
    requiredBoundaryStages,
    required_boundary_stages: requiredBoundaryStages,
    expectedRuntimeEvents,
    expected_runtime_events: expectedRuntimeEvents,
    acceptableOracleKinds,
    acceptable_oracle_kinds: acceptableOracleKinds,
    sourceDerivedOracleKinds,
    source_derived_oracle_kinds: sourceDerivedOracleKinds,
    candidateDeclaredOracleKinds,
    candidate_declared_oracle_kinds: candidateDeclaredOracleKinds,
    candidateOracleHintsUsedForAcceptance: false,
    candidate_oracle_hints_used_for_acceptance: false,
    candidateOracleHintAuthority:
      'candidate_oracle_hints_diagnostic_only_not_oracle_contract',
    candidate_oracle_hint_authority:
      'candidate_oracle_hints_diagnostic_only_not_oracle_contract',
    candidateOracleHintClaimsAcceptance,
    candidate_oracle_hint_claims_acceptance: candidateOracleHintClaimsAcceptance,
    perBackendRequirements,
    per_backend_requirements: perBackendRequirements,
    runtimeBoundaryHints: candidate.runtimeBoundaryHints ?? {},
    runtime_boundary_hints: candidate.runtimeBoundaryHints ?? {},
    oracleHints: candidate.oracleHints ?? {},
    oracle_hints: candidate.oracleHints ?? {},
    missingRuntimeEvidenceGaps,
    missing_runtime_evidence_gaps: missingRuntimeEvidenceGaps,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
  return {
    ...facet,
    expectationHash: contentHash(stableJson(facet)),
    expectation_hash: contentHash(stableJson(facet)),
  };
}

function deriveRuntimeSupportClosureObligation({
  candidate,
  runtimeBoundaryExpectation,
  runtimeProfileProofBridgeAccepted = false,
  runtimeProfileStrictRuntimeProofAccepted = false,
} = {}) {
  const hints = candidate?.runtimeBoundaryHints ?? candidate?.runtime_boundary_hints ?? {};
  const closureHint = hints.adapterClosure ?? hints.adapter_closure ?? {};
  const possibleOutcomes = [
    'built_in_reload',
    'generated_adapter',
    'api_interpose',
    'engine_asset_reload',
    'unsupported_requires_app_hook',
  ];
  const hintedOutcome = firstString(
    closureHint.outcome,
    closureHint.reloadMechanism,
    closureHint.reload_mechanism,
    closureHint.adapterOutcome,
    closureHint.adapter_outcome,
  );
  const outcome = runtimeProfileProofBridgeAccepted
    ? 'generated_adapter'
    : possibleOutcomes.includes(hintedOutcome)
      ? hintedOutcome
      : 'unsupported_requires_app_hook';
  const hintClaimsAuthority = claimsGpuHmrAuthority(closureHint);
  const boundaryStages = uniqueSortedStrings([
    ...(Array.isArray(runtimeBoundaryExpectation?.requiredBoundaryStages)
      ? runtimeBoundaryExpectation.requiredBoundaryStages
      : []),
    ...(Array.isArray(runtimeBoundaryExpectation?.required_boundary_stages)
      ? runtimeBoundaryExpectation.required_boundary_stages
      : []),
  ]);
  const blockingGaps = runtimeProfileStrictRuntimeProofAccepted
    ? ['runtime_support_closure_requires_matrix_runtime_chain_ingestion']
    : runtimeProfileProofBridgeAccepted
      ? ['runtime_support_closure_requires_strict_runtime_proof']
      : outcome === 'unsupported_requires_app_hook'
        ? ['runtime_support_closure_requires_app_hook']
        : ['runtime_support_closure_requires_runtime_boundary_proof'];
  const failedGates = uniqueSortedStrings([
    hintClaimsAuthority ? 'runtime_support_closure_hint_claimed_gpu_hmr_authority' : null,
  ]);
  const facet = {
    schemaVersion: ADAPTER_CLOSURE_EXPECTATION_SCHEMA,
    schema_version: ADAPTER_CLOSURE_EXPECTATION_SCHEMA,
    proofAuthority: ADAPTER_CLOSURE_EXPECTATION_AUTHORITY,
    proof_authority: ADAPTER_CLOSURE_EXPECTATION_AUTHORITY,
    accepted: false,
    acceptedAsSupportEvidence: failedGates.length === 0,
    accepted_as_support_evidence: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    required: true,
    outcome,
    possibleOutcomes,
    possible_outcomes: possibleOutcomes,
    runtimeProfileProofBridgeAccepted,
    runtime_profile_proof_bridge_accepted: runtimeProfileProofBridgeAccepted,
    runtimeProfileStrictRuntimeProofAccepted,
    runtime_profile_strict_runtime_proof_accepted: runtimeProfileStrictRuntimeProofAccepted,
    candidateHintsUsedForAcceptance: false,
    candidate_hints_used_for_acceptance: false,
    requiredBoundaryStages: boundaryStages,
    required_boundary_stages: boundaryStages,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
  return {
    ...facet,
    obligationHash: contentHash(stableJson(facet)),
    obligation_hash: contentHash(stableJson(facet)),
  };
}

function runtimeBoundaryLineTokenForKind(kind) {
  const tokens = {
    artifact_transport: 'artifact_transport',
    epoch_publication: 'dispatcher_epoch',
    dispatch_trace: 'synthi_gpu_launch',
    host_identity: 'host_identity',
    output_oracle: 'output_oracle',
  };
  return tokens[kind] ?? kind;
}

function runtimeBoundaryBaseTemplateFields(kind) {
  const fields = {
    artifact_transport: [
      'runtime_session',
      'process_id',
      'artifact_hash',
      'artifact_kind',
      'artifact_locator_or_path',
      'loader_target',
    ],
    epoch_publication: [
      'runtime_session',
      'process_id',
      'epoch',
      'generation',
      'artifact_hash',
      'dispatch_table_entry',
      'publish_timestamp_ns',
    ],
    dispatch_trace: [
      'runtime_session',
      'process_id',
      'dispatch_id',
      'epoch',
      'generation',
      'artifact_hash',
      'dispatch_api',
      'output_target',
      'timestamp_ns',
    ],
    host_identity: [
      'runtime_session',
      'process_id',
      'device_uuid',
      'context_id',
      'queue_or_stream_id',
      'host_identity_previous_generation',
      'host_identity_active_generation',
      'runner_process_identity',
      'runtime_resource_identity',
    ],
    output_oracle: [
      'runtime_session',
      'process_id',
      'after_dispatch_id',
      'epoch',
      'output_target',
      'oracle_kind',
      'oracle_artifact_hash',
      'timestamp_after_dispatch_ns',
    ],
  };
  return fields[kind] ?? ['runtime_session', 'process_id'];
}

function runtimeBoundaryBackendTemplateFields(backend, kind) {
  const fields = {
    hip_rocm: {
      artifact_transport: ['hsaco_hash', 'hip_module_handle'],
      epoch_publication: ['hip_function_handle', 'stream_id'],
      dispatch_trace: ['kernel_name', 'grid_dim', 'block_dim', 'shared_mem_bytes', 'stream_id'],
      host_identity: ['hip_context_id', 'stream_id'],
      output_oracle: ['hip_event_after_dispatch', 'readback_buffer_hash'],
    },
    opencl: {
      artifact_transport: ['program_hash', 'kernel_name'],
      epoch_publication: ['program_epoch', 'kernel_handle'],
      dispatch_trace: ['kernel_name', 'command_queue', 'work_dim', 'global_work_size', 'local_work_size'],
      host_identity: ['platform_id', 'device_id', 'command_queue'],
      output_oracle: ['cl_event_id', 'raw_readback_hash', 'readback_schema_hash'],
    },
    vulkan: {
      artifact_transport: ['spirv_hash', 'shader_module_handle'],
      epoch_publication: ['pipeline_handle', 'pipeline_layout_hash'],
      dispatch_trace: ['command_buffer_id', 'pipeline_handle', 'descriptor_set_layout_hash'],
      host_identity: ['vk_device_id', 'queue_family_index', 'queue_handle'],
      output_oracle: ['fence_id', 'swapchain_size', 'before_image_hash', 'after_image_hash', 'diff_image_hash'],
    },
    webgpu_wgsl: {
      artifact_transport: ['wgsl_hash', 'shader_module_label'],
      epoch_publication: ['shader_module_epoch', 'pipeline_layout_hash'],
      dispatch_trace: ['pass_encoder_id', 'pipeline_label', 'bind_group_layout_hash'],
      host_identity: ['adapter_id', 'device_id', 'queue_id'],
      output_oracle: ['mapped_buffer_hash', 'before_image_hash', 'after_image_hash', 'diff_image_hash'],
    },
    metal: {
      artifact_transport: ['metal_library_hash', 'function_name'],
      epoch_publication: ['pipeline_state_handle', 'library_epoch'],
      dispatch_trace: ['command_buffer_id', 'command_encoder_id', 'pipeline_state_handle'],
      host_identity: ['metal_device_id', 'command_queue_id'],
      output_oracle: ['completed_command_buffer_id', 'buffer_hash', 'drawable_image_hash'],
    },
    cuda: {
      artifact_transport: ['cubin_or_ptx_hash', 'cuda_module_handle'],
      epoch_publication: ['cuda_function_handle', 'stream_id'],
      dispatch_trace: ['kernel_name', 'grid_dim', 'block_dim', 'shared_mem_bytes', 'stream_id'],
      host_identity: ['cuda_context_id', 'stream_id'],
      output_oracle: ['cuda_event_after_dispatch', 'raw_readback_hash', 'readback_schema_hash'],
    },
    sycl: {
      artifact_transport: ['device_image_hash', 'kernel_bundle_hash'],
      epoch_publication: ['kernel_bundle_epoch', 'kernel_id'],
      dispatch_trace: ['queue_submit_id', 'kernel_name', 'nd_range'],
      host_identity: ['sycl_device_id', 'sycl_context_id', 'sycl_queue_id'],
      output_oracle: ['event_after_dispatch', 'raw_readback_hash', 'readback_schema_hash'],
    },
  };
  return fields[backend]?.[kind] ?? [];
}

function runtimeBoundaryOracleAlternatives(acceptableOracleKinds) {
  const kinds = uniqueSortedStrings(acceptableOracleKinds);
  const alternatives = [];
  if (kinds.includes('compute_readback') || kinds.includes('mapped_buffer_readback')) {
    alternatives.push({
      mode: 'compute_readback',
      mode_kind: 'compute_readback',
      requiredFields: ['raw_readback_hash', 'readback_schema_hash', 'checksum_after'],
      required_fields: ['raw_readback_hash', 'readback_schema_hash', 'checksum_after'],
    });
  }
  if (kinds.includes('deterministic_visual_oracle')) {
    alternatives.push({
      mode: 'deterministic_visual_oracle',
      mode_kind: 'deterministic_visual_oracle',
      requiredFields: ['before_image_hash', 'after_image_hash', 'diff_image_hash', 'camera_state_hash'],
      required_fields: ['before_image_hash', 'after_image_hash', 'diff_image_hash', 'camera_state_hash'],
    });
  }
  return alternatives;
}

function runtimeBoundaryEventObjectTemplate({ kind, backendCandidates, acceptableOracleKinds }) {
  const requiredFields = runtimeBoundaryBaseTemplateFields(kind);
  const backendSpecificFields = uniqueSortedStrings(
    backendCandidates.flatMap((backend) => runtimeBoundaryBackendTemplateFields(backend, kind)),
  );
  const fieldPlaceholders = {};
  for (const field of requiredFields) fieldPlaceholders[field] = `required:${field}`;
  const token = runtimeBoundaryLineTokenForKind(kind);
  const exampleFields = requiredFields
    .slice(0, 8)
    .map((field) => `${field}=${field.toUpperCase()}`)
    .join(' ');
  const template = {
    schemaVersion: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    eventKind: kind,
    event_kind: kind,
    boundaryLineToken: token,
    boundary_line_token: token,
    requiredFields,
    required_fields: requiredFields,
    backendSpecificFields,
    backend_specific_fields: backendSpecificFields,
    fieldPlaceholders,
    field_placeholders: fieldPlaceholders,
    exampleBoundaryLineTemplate: `[gpu-runtime-boundary] ${token} ${exampleFields}`,
    example_boundary_line_template: `[gpu-runtime-boundary] ${token} ${exampleFields}`,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
  if (kind === 'output_oracle') {
    template.oracleFieldAlternatives = runtimeBoundaryOracleAlternatives(acceptableOracleKinds);
    template.oracle_field_alternatives = template.oracleFieldAlternatives;
  }
  return {
    ...template,
    templateHash: contentHash(stableJson(template)),
    template_hash: contentHash(stableJson(template)),
  };
}

function deriveRuntimeBoundaryTemplateSourceBinding({
  candidate,
  runtimeBoundaryExpectation,
  sourceListingHash,
  buildMetadataContentHash,
} = {}) {
  const backendCandidates = uniqueSortedStrings(runtimeBoundaryExpectation?.backendCandidates ?? []);
  const sourceExpectationHash =
    runtimeBoundaryExpectation?.expectationHash
    ?? runtimeBoundaryExpectation?.expectation_hash
    ?? null;
  const blockingGaps = uniqueSortedStrings([
    sourceListingHash ? null : 'source_listing_hash_missing',
    buildMetadataContentHash ? null : 'build_metadata_content_hash_missing',
    sourceExpectationHash ? null : 'runtime_boundary_expectation_hash_missing',
    backendCandidates.length > 0 ? null : 'backend_candidates_missing',
  ]);
  const binding = {
    schemaVersion: RUNTIME_BOUNDARY_TEMPLATE_SOURCE_BINDING_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_TEMPLATE_SOURCE_BINDING_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_TEMPLATE_SOURCE_BINDING_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_TEMPLATE_SOURCE_BINDING_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    acceptedAsTemplateSourceBinding: blockingGaps.length === 0,
    accepted_as_template_source_binding: blockingGaps.length === 0,
    projectId: candidate.id,
    project_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    sourceListingHash: sourceListingHash ?? null,
    source_listing_hash: sourceListingHash ?? null,
    buildMetadataContentHash: buildMetadataContentHash ?? null,
    build_metadata_content_hash: buildMetadataContentHash ?? null,
    sourceExpectationHash,
    source_expectation_hash: sourceExpectationHash,
    backendCandidates,
    backend_candidates: backendCandidates,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
  return {
    ...binding,
    bindingHash: contentHash(stableJson(binding)),
    binding_hash: contentHash(stableJson(binding)),
  };
}

function deriveRuntimeBoundaryEventManifestTemplate({
  candidate,
  runtimeBoundaryExpectation,
  sourceListingHash = null,
  buildMetadataContentHash = null,
}) {
  const backendCandidates = uniqueSortedStrings(runtimeBoundaryExpectation?.backendCandidates ?? []);
  const acceptableOracleKinds = uniqueSortedStrings(runtimeBoundaryExpectation?.acceptableOracleKinds ?? []);
  const eventObjectTemplates = REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.map((kind) =>
    runtimeBoundaryEventObjectTemplate({ kind, backendCandidates, acceptableOracleKinds }));
  const sourceBinding = deriveRuntimeBoundaryTemplateSourceBinding({
    candidate,
    runtimeBoundaryExpectation,
    sourceListingHash,
    buildMetadataContentHash,
  });
  const presentKinds = new Set(eventObjectTemplates.map((entry) => entry.eventKind));
  const missingEventKinds = REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.filter((kind) => !presentKinds.has(kind));
  const expectationAccepted =
    runtimeBoundaryExpectation?.acceptedAsRuntimeBoundaryExpectation === true;
  const blockingGaps = uniqueSortedStrings([
    ...(expectationAccepted ? [] : ['runtime_boundary_expectation_not_accepted']),
    ...(sourceBinding.acceptedAsTemplateSourceBinding === true
      ? []
      : ['runtime_boundary_template_source_binding_incomplete']),
    ...(Array.isArray(runtimeBoundaryExpectation?.blockingGaps)
      ? runtimeBoundaryExpectation.blockingGaps
      : []),
    ...(Array.isArray(sourceBinding.blockingGaps) ? sourceBinding.blockingGaps : []),
    ...missingEventKinds.map((kind) => `runtime_boundary_event_template_${kind}_missing`),
  ]);
  const accepted = blockingGaps.length === 0;
  const manifestTemplate = {
    schemaVersion: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    requiresObservedRuntimeEvents: true,
    requires_observed_runtime_events: true,
    runtimeBoundaryEventsPlaceholder:
      'populate_runtimeBoundaryEvents_with_observed_target_process_events_only',
    runtime_boundary_events_placeholder:
      'populate_runtimeBoundaryEvents_with_observed_target_process_events_only',
    adapterInputRequiredFields: RUNTIME_BOUNDARY_ADAPTER_INPUT_REQUIRED_FIELDS,
    adapter_input_required_fields: RUNTIME_BOUNDARY_ADAPTER_INPUT_REQUIRED_FIELDS,
    adapterInputFieldAliases: RUNTIME_BOUNDARY_ADAPTER_INPUT_FIELD_ALIASES,
    adapter_input_field_aliases: RUNTIME_BOUNDARY_ADAPTER_INPUT_FIELD_ALIASES,
    oracleArtifactRequirements: runtimeBoundaryOracleAlternatives(acceptableOracleKinds),
    oracle_artifact_requirements: runtimeBoundaryOracleAlternatives(acceptableOracleKinds),
    eventObjectTemplates,
    event_object_templates: eventObjectTemplates,
  };
  const facet = {
    schemaVersion: RUNTIME_BOUNDARY_EVENT_TEMPLATE_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EVENT_TEMPLATE_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_EVENT_TEMPLATE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    acceptedAsRuntimeBoundaryEventManifestTemplate: accepted,
    accepted_as_runtime_boundary_event_manifest_template: accepted,
    projectId: candidate.id,
    project_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    sourceListingHash: sourceBinding.sourceListingHash,
    source_listing_hash: sourceBinding.source_listing_hash,
    buildMetadataContentHash: sourceBinding.buildMetadataContentHash,
    build_metadata_content_hash: sourceBinding.build_metadata_content_hash,
    sourceExpectationHash: runtimeBoundaryExpectation?.expectationHash ?? null,
    source_expectation_hash: runtimeBoundaryExpectation?.expectation_hash ?? null,
    sourceBinding,
    source_binding: sourceBinding,
    sourceBindingHash: sourceBinding.bindingHash,
    source_binding_hash: sourceBinding.binding_hash,
    runtimeBoundaryEventSchema: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    runtime_boundary_event_schema: RUNTIME_BOUNDARY_EVENT_SCHEMA,
    eventManifestSchema: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    event_manifest_schema: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    requiredEventKinds: REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS,
    required_event_kinds: REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS,
    adapterInputRequiredFields: RUNTIME_BOUNDARY_ADAPTER_INPUT_REQUIRED_FIELDS,
    adapter_input_required_fields: RUNTIME_BOUNDARY_ADAPTER_INPUT_REQUIRED_FIELDS,
    adapterInputFieldAliases: RUNTIME_BOUNDARY_ADAPTER_INPUT_FIELD_ALIASES,
    adapter_input_field_aliases: RUNTIME_BOUNDARY_ADAPTER_INPUT_FIELD_ALIASES,
    oracleArtifactRequirements: runtimeBoundaryOracleAlternatives(acceptableOracleKinds),
    oracle_artifact_requirements: runtimeBoundaryOracleAlternatives(acceptableOracleKinds),
    backendCandidates,
    backend_candidates: backendCandidates,
    acceptableOracleKinds,
    acceptable_oracle_kinds: acceptableOracleKinds,
    sourceDerivedOracleKinds:
      runtimeBoundaryExpectation?.sourceDerivedOracleKinds
      ?? runtimeBoundaryExpectation?.source_derived_oracle_kinds
      ?? [],
    source_derived_oracle_kinds:
      runtimeBoundaryExpectation?.sourceDerivedOracleKinds
      ?? runtimeBoundaryExpectation?.source_derived_oracle_kinds
      ?? [],
    candidateDeclaredOracleKinds:
      runtimeBoundaryExpectation?.candidateDeclaredOracleKinds
      ?? runtimeBoundaryExpectation?.candidate_declared_oracle_kinds
      ?? [],
    candidate_declared_oracle_kinds:
      runtimeBoundaryExpectation?.candidateDeclaredOracleKinds
      ?? runtimeBoundaryExpectation?.candidate_declared_oracle_kinds
      ?? [],
    candidateOracleHintsUsedForAcceptance:
      runtimeBoundaryExpectation?.candidateOracleHintsUsedForAcceptance === true
      || runtimeBoundaryExpectation?.candidate_oracle_hints_used_for_acceptance === true,
    candidate_oracle_hints_used_for_acceptance:
      runtimeBoundaryExpectation?.candidateOracleHintsUsedForAcceptance === true
      || runtimeBoundaryExpectation?.candidate_oracle_hints_used_for_acceptance === true,
    candidateOracleHintAuthority:
      runtimeBoundaryExpectation?.candidateOracleHintAuthority
      ?? runtimeBoundaryExpectation?.candidate_oracle_hint_authority
      ?? 'candidate_oracle_hints_diagnostic_only_not_oracle_contract',
    candidate_oracle_hint_authority:
      runtimeBoundaryExpectation?.candidateOracleHintAuthority
      ?? runtimeBoundaryExpectation?.candidate_oracle_hint_authority
      ?? 'candidate_oracle_hints_diagnostic_only_not_oracle_contract',
    candidateOracleHintClaimsAcceptance:
      runtimeBoundaryExpectation?.candidateOracleHintClaimsAcceptance === true
      || runtimeBoundaryExpectation?.candidate_oracle_hint_claims_acceptance === true,
    candidate_oracle_hint_claims_acceptance:
      runtimeBoundaryExpectation?.candidateOracleHintClaimsAcceptance === true
      || runtimeBoundaryExpectation?.candidate_oracle_hint_claims_acceptance === true,
    eventObjectTemplates,
    event_object_templates: eventObjectTemplates,
    eventTemplateHashes: eventObjectTemplates.map((entry) => entry.templateHash),
    event_template_hashes: eventObjectTemplates.map((entry) => entry.templateHash),
    manifestTemplate,
    manifest_template: manifestTemplate,
    environmentAliases: [
      'SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
    ],
    environment_aliases: [
      'SYNTHI_GPU_HMR_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH',
      'SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
      'SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH',
    ],
    missingRuntimeEvidenceGaps: runtimeBoundaryExpectation?.missingRuntimeEvidenceGaps ?? [],
    missing_runtime_evidence_gaps: runtimeBoundaryExpectation?.missing_runtime_evidence_gaps ?? [],
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
  return {
    ...facet,
    templateHash: contentHash(stableJson(facet)),
    template_hash: contentHash(stableJson(facet)),
  };
}

function runtimeBoundaryTemplateByKind(runtimeBoundaryEventManifestTemplate = {}) {
  const templates = [
    ...(Array.isArray(runtimeBoundaryEventManifestTemplate.eventObjectTemplates)
      ? runtimeBoundaryEventManifestTemplate.eventObjectTemplates
      : []),
    ...(Array.isArray(runtimeBoundaryEventManifestTemplate.event_object_templates)
      ? runtimeBoundaryEventManifestTemplate.event_object_templates
      : []),
  ];
  const byKind = new Map();
  for (const template of templates) {
    const kind = firstString(template?.eventKind, template?.event_kind);
    if (kind && !byKind.has(kind)) byKind.set(kind, template);
  }
  return byKind;
}

function runtimeBoundaryStageProofKinds(kind) {
  const proofKinds = {
    artifact_transport: [
      'artifact_hash_after',
      'loaded_artifact_identity',
      'same_process_loader_target',
    ],
    epoch_publication: [
      'published_epoch',
      'published_artifact_hash',
      'dispatch_table_binding',
    ],
    dispatch_trace: [
      'dispatch_id',
      'published_epoch_used_by_dispatch',
      'artifact_hash_bound_to_dispatch',
    ],
    host_identity: [
      'process_identity',
      'device_identity',
      'context_or_queue_identity',
      'stable_runtime_resource_identity',
    ],
    output_oracle: [
      'after_dispatch_output_binding',
      'compute_or_visual_oracle_artifacts',
      'oracle_artifact_hashes',
    ],
  };
  return proofKinds[kind] ?? ['runtime_boundary_event'];
}

function deriveAppHookMaterializationPlan({
  candidate,
  runtimeBoundaryExpectation = {},
  runtimeBoundaryEventManifestTemplate = {},
  runtimeSupportClosureObligation = {},
  derivedRuntimeProfileContract = null,
  runtimeProfileProofBridge = null,
  sourceIntakeEvidence = {},
} = {}) {
  const templateByKind = runtimeBoundaryTemplateByKind(runtimeBoundaryEventManifestTemplate);
  const backendCandidates = uniqueSortedStrings([
    ...firstArrayField(runtimeBoundaryExpectation, 'backendCandidates', 'backend_candidates'),
    ...firstArrayField(sourceIntakeEvidence, 'backendCandidates', 'backend_candidates'),
  ]);
  const acceptableOracleKinds = uniqueSortedStrings([
    ...firstArrayField(runtimeBoundaryExpectation, 'acceptableOracleKinds', 'acceptable_oracle_kinds'),
    ...firstArrayField(runtimeBoundaryEventManifestTemplate, 'acceptableOracleKinds', 'acceptable_oracle_kinds'),
  ]);
  const stagePlans = REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.map((kind) => {
    const eventTemplate = templateByKind.get(kind)
      ?? runtimeBoundaryEventObjectTemplate({ kind, backendCandidates, acceptableOracleKinds });
    const requiredFields = uniqueSortedStrings([
      ...firstArrayField(eventTemplate, 'requiredFields', 'required_fields'),
    ]);
    const backendSpecificFields = uniqueSortedStrings([
      ...firstArrayField(eventTemplate, 'backendSpecificFields', 'backend_specific_fields'),
    ]);
    const oracleAlternatives = kind === 'output_oracle'
      ? (
        Array.isArray(eventTemplate.oracleFieldAlternatives)
          ? eventTemplate.oracleFieldAlternatives
          : Array.isArray(eventTemplate.oracle_field_alternatives)
            ? eventTemplate.oracle_field_alternatives
            : runtimeBoundaryOracleAlternatives(acceptableOracleKinds)
      )
      : [];
    return {
      stage: kind,
      eventKind: kind,
      event_kind: kind,
      boundaryLineToken: firstString(
        eventTemplate.boundaryLineToken,
        eventTemplate.boundary_line_token,
        runtimeBoundaryLineTokenForKind(kind),
      ),
      boundary_line_token: firstString(
        eventTemplate.boundaryLineToken,
        eventTemplate.boundary_line_token,
        runtimeBoundaryLineTokenForKind(kind),
      ),
      requiredProofKinds: runtimeBoundaryStageProofKinds(kind),
      required_proof_kinds: runtimeBoundaryStageProofKinds(kind),
      requiredFields,
      required_fields: requiredFields,
      backendSpecificFields,
      backend_specific_fields: backendSpecificFields,
      oracleAlternatives,
      oracle_alternatives: oracleAlternatives,
      eventTemplateHash: firstString(eventTemplate.templateHash, eventTemplate.template_hash),
      event_template_hash: firstString(eventTemplate.templateHash, eventTemplate.template_hash),
      acceptedAsPlanOnlyStage: true,
      accepted_as_plan_only_stage: true,
      materialized: false,
      observedRuntimeEventRequired: true,
      observed_runtime_event_required: true,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      canSatisfyDispatchProof: false,
      can_satisfy_dispatch_proof: false,
      missingRuntimeEventGap: `app_hook_materialization_${kind}_event_missing`,
      missing_runtime_event_gap: `app_hook_materialization_${kind}_event_missing`,
      evidenceRefs: uniqueSortedStrings([
        firstString(eventTemplate.templateHash, eventTemplate.template_hash)
          ? `runtime-boundary-event-template:${firstString(eventTemplate.templateHash, eventTemplate.template_hash)}`
          : null,
      ]),
      evidence_refs: uniqueSortedStrings([
        firstString(eventTemplate.templateHash, eventTemplate.template_hash)
          ? `runtime-boundary-event-template:${firstString(eventTemplate.templateHash, eventTemplate.template_hash)}`
          : null,
      ]),
    };
  });
  const runtimeBoundaryExpectationHash = firstString(
    runtimeBoundaryExpectation.expectationHash,
    runtimeBoundaryExpectation.expectation_hash,
  );
  const runtimeBoundaryEventManifestTemplateHash = firstString(
    runtimeBoundaryEventManifestTemplate.templateHash,
    runtimeBoundaryEventManifestTemplate.template_hash,
  );
  const runtimeSupportClosureObligationHash = firstString(
    runtimeSupportClosureObligation.obligationHash,
    runtimeSupportClosureObligation.obligation_hash,
  );
  const derivedRuntimeProfileContractHash = firstString(
    derivedRuntimeProfileContract?.facetHash,
    derivedRuntimeProfileContract?.facet_hash,
  );
  const runtimeProfileProofBridgeHash = firstString(
    runtimeProfileProofBridge?.facetHash,
    runtimeProfileProofBridge?.facet_hash,
  );
  const sourceListingHash = firstString(
    sourceIntakeEvidence.sourceListingHash,
    sourceIntakeEvidence.source_listing_hash,
    runtimeBoundaryEventManifestTemplate.sourceListingHash,
    runtimeBoundaryEventManifestTemplate.source_listing_hash,
  );
  const buildMetadataContentHash = firstString(
    sourceIntakeEvidence.buildMetadataContentEvidence?.contentEvidenceHash,
    sourceIntakeEvidence.build_metadata_content_evidence?.content_evidence_hash,
    runtimeBoundaryEventManifestTemplate.buildMetadataContentHash,
    runtimeBoundaryEventManifestTemplate.build_metadata_content_hash,
  );
  const failedGates = uniqueSortedStrings([
    claimsGpuHmrAuthority(candidate) ? 'app_hook_materialization_candidate_claimed_gpu_hmr_authority' : null,
    claimsGpuHmrAuthority(runtimeBoundaryExpectation)
      ? 'app_hook_materialization_expectation_claimed_gpu_hmr_authority'
      : null,
    claimsGpuHmrAuthority(runtimeBoundaryEventManifestTemplate)
      ? 'app_hook_materialization_template_claimed_gpu_hmr_authority'
      : null,
    claimsGpuHmrAuthority(runtimeSupportClosureObligation)
      ? 'app_hook_materialization_closure_claimed_gpu_hmr_authority'
      : null,
  ]);
  const blockingGaps = uniqueSortedStrings([
    runtimeBoundaryExpectationHash ? null : 'app_hook_materialization_runtime_boundary_expectation_hash_missing',
    runtimeBoundaryEventManifestTemplateHash
      ? null
      : 'app_hook_materialization_event_manifest_template_hash_missing',
    runtimeSupportClosureObligationHash
      ? null
      : 'app_hook_materialization_runtime_support_closure_hash_missing',
    backendCandidates.length > 0 ? null : 'app_hook_materialization_backend_candidates_missing',
    ...stagePlans.map((stage) => stage.missingRuntimeEventGap),
    'app_hook_materialization_requires_observed_target_process_events',
  ]);
  const plan = {
    schemaVersion: APP_HOOK_MATERIALIZATION_PLAN_SCHEMA,
    schema_version: APP_HOOK_MATERIALIZATION_PLAN_SCHEMA,
    proofAuthority: APP_HOOK_MATERIALIZATION_PLAN_AUTHORITY,
    proof_authority: APP_HOOK_MATERIALIZATION_PLAN_AUTHORITY,
    accepted: false,
    acceptedAsSupportEvidence: failedGates.length === 0,
    accepted_as_support_evidence: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    materializesRuntimeEvents: false,
    materializes_runtime_events: false,
    requiresObservedTargetProcessEvents: true,
    requires_observed_target_process_events: true,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    candidateId: candidate?.id ?? null,
    candidate_id: candidate?.id ?? null,
    sourceUrl: candidate?.sourceUrl ?? null,
    source_url: candidate?.sourceUrl ?? null,
    immutableCommit: candidate?.immutableCommit ?? null,
    immutable_commit: candidate?.immutableCommit ?? null,
    sourceListingHash,
    source_listing_hash: sourceListingHash,
    buildMetadataContentHash,
    build_metadata_content_hash: buildMetadataContentHash,
    runtimeBoundaryExpectationHash,
    runtime_boundary_expectation_hash: runtimeBoundaryExpectationHash,
    runtimeBoundaryEventManifestTemplateHash,
    runtime_boundary_event_manifest_template_hash: runtimeBoundaryEventManifestTemplateHash,
    runtimeSupportClosureObligationHash,
    runtime_support_closure_obligation_hash: runtimeSupportClosureObligationHash,
    derivedRuntimeProfileContractHash,
    derived_runtime_profile_contract_hash: derivedRuntimeProfileContractHash,
    runtimeProfileProofBridgeHash,
    runtime_profile_proof_bridge_hash: runtimeProfileProofBridgeHash,
    backendCandidates,
    backend_candidates: backendCandidates,
    acceptableOracleKinds,
    acceptable_oracle_kinds: acceptableOracleKinds,
    requiredStages: REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS,
    required_stages: REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS,
    stagePlans,
    stage_plans: stagePlans,
    missingRuntimeEventGaps: stagePlans.map((stage) => stage.missingRuntimeEventGap),
    missing_runtime_event_gaps: stagePlans.map((stage) => stage.missingRuntimeEventGap),
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
  return {
    ...plan,
    materializationPlanHash: contentHash(stableJson(plan)),
    materialization_plan_hash: contentHash(stableJson(plan)),
  };
}

function deriveRuntimeBoundaryPlanBinding({
  runtimeProfileProofBridge = null,
  runtimeAppHookMaterializationPlan = {},
  sourceIntakeEvidence = {},
} = {}) {
  const runtimeBoundaryEventManifestSha256 = firstString(
    runtimeProfileProofBridge?.runtimeBoundaryEventManifestSha256,
    runtimeProfileProofBridge?.runtime_boundary_event_manifest_sha256,
  );
  const materializationPlanHash = firstString(
    runtimeAppHookMaterializationPlan.materializationPlanHash,
    runtimeAppHookMaterializationPlan.materialization_plan_hash,
  );
  const buildMetadataContentEvidence = firstObjectField(
    sourceIntakeEvidence,
    'buildMetadataContentEvidence',
    'build_metadata_content_evidence',
  );
  const runtimeBoundaryExpectation = firstObjectField(
    sourceIntakeEvidence,
    'runtimeBoundaryExpectation',
    'runtime_boundary_expectation',
  );
  const runtimeBoundaryEventManifestTemplate = firstObjectField(
    sourceIntakeEvidence,
    'runtimeBoundaryEventManifestTemplate',
    'runtime_boundary_event_manifest_template',
  );
  const sourceListingHash = firstString(
    sourceIntakeEvidence.sourceListingHash,
    sourceIntakeEvidence.source_listing_hash,
  );
  const buildMetadataContentHash = firstString(
    buildMetadataContentEvidence.contentEvidenceHash,
    buildMetadataContentEvidence.content_evidence_hash,
    runtimeAppHookMaterializationPlan.buildMetadataContentHash,
    runtimeAppHookMaterializationPlan.build_metadata_content_hash,
  );
  const runtimeBoundaryExpectationHash = firstString(
    runtimeBoundaryExpectation.expectationHash,
    runtimeBoundaryExpectation.expectation_hash,
    runtimeAppHookMaterializationPlan.runtimeBoundaryExpectationHash,
    runtimeAppHookMaterializationPlan.runtime_boundary_expectation_hash,
  );
  const runtimeBoundaryEventManifestTemplateHash = firstString(
    runtimeBoundaryEventManifestTemplate.templateHash,
    runtimeBoundaryEventManifestTemplate.template_hash,
    runtimeAppHookMaterializationPlan.runtimeBoundaryEventManifestTemplateHash,
    runtimeAppHookMaterializationPlan.runtime_boundary_event_manifest_template_hash,
  );
  const requiredStages = uniqueSortedStrings([
    ...firstArrayField(runtimeAppHookMaterializationPlan, 'requiredStages', 'required_stages'),
  ]);
  const stagePlans = [
    ...firstArrayField(runtimeAppHookMaterializationPlan, 'stagePlans', 'stage_plans'),
  ].filter((entry) => entry && typeof entry === 'object');
  const stageTemplateHashes = uniqueSortedStrings(stagePlans
    .map((stage) => firstString(stage.eventTemplateHash, stage.event_template_hash))
    .filter(Boolean));
  const bindingSeed = {
    schemaVersion: RUNTIME_BOUNDARY_PLAN_BINDING_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_PLAN_BINDING_AUTHORITY,
    materializationPlanHash,
    runtimeBoundaryEventManifestSha256,
    sourceListingHash,
    buildMetadataContentHash,
    runtimeBoundaryExpectationHash,
    runtimeBoundaryEventManifestTemplateHash,
    adapterResultSha256: null,
    proofJsonSha256: null,
    requiredStages,
    stageTemplateHashes,
  };
  const failedGates = uniqueSortedStrings([
    materializationPlanHash ? null : 'runtime_boundary_plan_binding_materialization_plan_hash_missing',
    runtimeBoundaryEventManifestSha256 ? null : 'runtime_boundary_plan_binding_event_manifest_hash_missing',
    sourceListingHash ? null : 'runtime_boundary_plan_binding_source_listing_hash_missing',
    buildMetadataContentHash ? null : 'runtime_boundary_plan_binding_build_metadata_hash_missing',
    runtimeBoundaryExpectationHash ? null : 'runtime_boundary_plan_binding_expectation_hash_missing',
    runtimeBoundaryEventManifestTemplateHash ? null : 'runtime_boundary_plan_binding_template_hash_missing',
    REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.every((kind) => requiredStages.includes(kind))
      ? null
      : 'runtime_boundary_plan_binding_required_stages_incomplete',
    stageTemplateHashes.length > 0 ? null : 'runtime_boundary_plan_binding_stage_template_hashes_missing',
  ]);
  const accepted = failedGates.length === 0;
  return {
    schemaVersion: RUNTIME_BOUNDARY_PLAN_BINDING_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_PLAN_BINDING_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_PLAN_BINDING_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_PLAN_BINDING_AUTHORITY,
    accepted,
    acceptedAsSupportEvidence: accepted,
    accepted_as_support_evidence: accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    materializationPlanHash,
    materialization_plan_hash: materializationPlanHash,
    runtimeBoundaryEventManifestSha256,
    runtime_boundary_event_manifest_sha256: runtimeBoundaryEventManifestSha256,
    sourceListingHash,
    source_listing_hash: sourceListingHash,
    buildMetadataContentHash,
    build_metadata_content_hash: buildMetadataContentHash,
    runtimeBoundaryExpectationHash,
    runtime_boundary_expectation_hash: runtimeBoundaryExpectationHash,
    runtimeBoundaryEventManifestTemplateHash,
    runtime_boundary_event_manifest_template_hash: runtimeBoundaryEventManifestTemplateHash,
    adapterResultSha256: null,
    adapter_result_sha256: null,
    proofJsonSha256: null,
    proof_json_sha256: null,
    requiredStages,
    required_stages: requiredStages,
    stageTemplateHashes,
    stage_template_hashes: stageTemplateHashes,
    bindingHash: contentHash(stableJson(bindingSeed)),
    binding_hash: contentHash(stableJson(bindingSeed)),
    failedGates,
    failed_gates: failedGates,
  };
}

function parseGitLsTree(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40,64})(?:\s+(-|\d+))?\t(.+)$/i);
      if (!match) return null;
      const declaredSize = match[4];
      return {
        mode: match[1],
        type: match[2],
        object: match[3],
        byteLength: declaredSize == null || declaredSize === '-' ? null : Number(declaredSize),
        byte_length: declaredSize == null || declaredSize === '-' ? null : Number(declaredSize),
        path: match[5],
      };
    })
    .filter(Boolean);
}

function parseGitHubRepoUrl(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(String(sourceUrl));
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;
  const [owner, rawRepo] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

function githubApiAuthentication(env = process.env) {
  const sources = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT'];
  const source = sources.find((name) => String(env[name] ?? '').trim());
  const token = source ? String(env[source]).trim() : '';
  const evidence = {
    proofAuthority: 'github_api_authentication_transport_only_not_gpu_hmr_success',
    proof_authority: 'github_api_authentication_transport_only_not_gpu_hmr_success',
    tokenPresent: Boolean(token),
    token_present: Boolean(token),
    tokenSource: source ?? null,
    token_source: source ?? null,
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
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    evidence,
  };
}

function githubApiHeaders(env = process.env) {
  const auth = githubApiAuthentication(env);
  return {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'synthi-gpu-hmr-random-cold-intake',
      ...auth.headers,
    },
    authEvidence: auth.evidence,
    auth_evidence: auth.evidence,
  };
}

async function fetchGitHubTreeListing(candidate, { sourceIntakeTimeoutMs }) {
  const parsed = parseGitHubRepoUrl(candidate.sourceUrl);
  if (!parsed) return { attempted: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sourceIntakeTimeoutMs);
  timer.unref?.();
  const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${candidate.immutableCommit}?recursive=1`;
  const startedAt = new Date().toISOString();
  const githubApi = githubApiHeaders();
  try {
    const response = await fetch(apiUrl, {
      headers: githubApi.headers,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        attempted: true,
        accepted: false,
        status: 'source_intake_github_tree_failed',
        reason: 'source_tree_github_tree_fetch_failed',
        apiUrl,
        api_url: apiUrl,
        httpStatus: response.status,
        http_status: response.status,
        githubApiAuthentication: githubApi.authEvidence,
        github_api_authentication: githubApi.authEvidence,
        bodyTail: tail(text, 2000),
        body_tail: tail(text, 2000),
        startedAt,
        started_at: startedAt,
        finishedAt: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      };
    }
    const payload = JSON.parse(text);
    if (payload?.truncated === true) {
      return {
        attempted: true,
        accepted: false,
        status: 'source_intake_github_tree_truncated',
        reason: 'source_tree_github_tree_truncated',
        apiUrl,
        api_url: apiUrl,
        githubApiAuthentication: githubApi.authEvidence,
        github_api_authentication: githubApi.authEvidence,
        startedAt,
        started_at: startedAt,
        finishedAt: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      };
    }
    const files = Array.isArray(payload?.tree)
      ? payload.tree
        .filter((entry) => entry?.type === 'blob' && entry.path && entry.sha)
        .map((entry) => ({
          mode: String(entry.mode ?? ''),
          type: 'blob',
          object: String(entry.sha),
          byteLength: Number.isFinite(entry.size) ? entry.size : null,
          byte_length: Number.isFinite(entry.size) ? entry.size : null,
          path: String(entry.path),
        }))
      : [];
    return {
      attempted: true,
      accepted: true,
      apiUrl,
      api_url: apiUrl,
      githubApiAuthentication: githubApi.authEvidence,
      github_api_authentication: githubApi.authEvidence,
      transport: 'github_git_tree_api_recursive',
      files,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      attempted: true,
      accepted: false,
      status: error?.name === 'AbortError'
        ? 'source_intake_github_tree_timeout'
        : 'source_intake_github_tree_error',
      reason: error?.name === 'AbortError'
        ? 'source_tree_github_tree_timeout'
        : 'source_tree_github_tree_error',
      apiUrl,
      api_url: apiUrl,
      githubApiAuthentication: githubApi.authEvidence,
      github_api_authentication: githubApi.authEvidence,
      error: error?.message || String(error),
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function githubTreeFailureCanUseAutomaticGitFallback(githubTree = {}) {
  const status = String(githubTree?.status ?? '');
  if (status !== 'source_intake_github_tree_failed') return false;
  const httpStatus = Number(githubTree?.httpStatus ?? githubTree?.http_status);
  const bodyTail = String(githubTree?.bodyTail ?? githubTree?.body_tail ?? '').toLowerCase();
  return httpStatus === 429 || ((httpStatus === 403 || httpStatus === 429) && bodyTail.includes('rate limit'));
}

function directUserSourceCanUseAutomaticGitFallback(candidate = {}) {
  const candidateSource = String(candidate.candidateSource ?? candidate.candidate_source ?? '');
  const directInputEvidence = candidate.directInputEvidence ?? candidate.direct_input_evidence;
  const directEvidence = directInputEvidence && typeof directInputEvidence === 'object'
    ? directInputEvidence
    : {};
  return (candidateSource === 'direct_source_url_commit' || candidateSource === 'direct_local_git_repo_path')
    && (directEvidence.acceptedAsDirectInputEvidence ?? directEvidence.accepted_as_direct_input_evidence) === true
    && (directEvidence.proofAuthority ?? directEvidence.proof_authority) === DIRECT_SOURCE_INPUT_AUTHORITY
    && (directEvidence.targetNameIndependent ?? directEvidence.target_name_independent) === true
    && Array.isArray(directEvidence.projectNameWhitelist ?? directEvidence.project_name_whitelist)
    && (directEvidence.projectNameWhitelist ?? directEvidence.project_name_whitelist).length === 0
    && Array.isArray(directEvidence.specificTargetIdsAllowed ?? directEvidence.specific_target_ids_allowed)
    && (directEvidence.specificTargetIdsAllowed ?? directEvidence.specific_target_ids_allowed).length === 0
    && claimsGpuHmrAuthority(candidate) === false
    && claimsGpuHmrAuthority(directEvidence) === false;
}

function githubTreeTruncationCanUseAutomaticGitFallback(githubTree = {}, candidate = {}) {
  return String(githubTree?.status ?? '') === 'source_intake_github_tree_truncated'
    && directUserSourceCanUseAutomaticGitFallback(candidate) === true;
}

function directSourceInputEvidenceHashForCandidate(candidate = {}) {
  const directInputEvidence = candidate.directInputEvidence ?? candidate.direct_input_evidence;
  const directEvidence = directInputEvidence && typeof directInputEvidence === 'object'
    ? directInputEvidence
    : {};
  return directEvidence.evidenceHash ?? directEvidence.evidence_hash ?? null;
}

function sourceIntakeTransportFallbackEvidence({
  candidate = {},
  reason,
  automatic = false,
  automaticReason = null,
  requiresExplicitOptIn = true,
  recommendedTransport,
  githubTree = null,
  forcedByEnv = null,
  fullTreeOptInEnv = null,
} = {}) {
  const candidateSource = String(candidate.candidateSource ?? candidate.candidate_source ?? '');
  const immutableCommit = String(candidate.immutableCommit ?? candidate.immutable_commit ?? '').trim();
  const trigger = githubTree && typeof githubTree === 'object'
    ? {
      status: githubTree.status ?? null,
      reason: githubTree.reason ?? null,
      httpStatus: githubTree.httpStatus ?? githubTree.http_status ?? null,
      githubApiAuthentication: githubTree.githubApiAuthentication ?? githubTree.github_api_authentication ?? null,
      bodyTail: githubTree.bodyTail ?? githubTree.body_tail ?? null,
    }
    : null;
  const seed = {
    schemaVersion: SOURCE_INTAKE_TRANSPORT_FALLBACK_SCHEMA,
    reason,
    automatic: automatic === true,
    automaticReason,
    requiresExplicitOptIn: requiresExplicitOptIn === true,
    recommendedTransport,
    candidateSource,
    immutableCommit,
    directSourceInputEvidenceHash: directSourceInputEvidenceHashForCandidate(candidate),
    trigger,
    forcedByEnv,
    fullTreeOptInEnv,
  };
  const fallbackEvidenceHash = contentHash(stableJson(seed));
  return {
    schemaVersion: SOURCE_INTAKE_TRANSPORT_FALLBACK_SCHEMA,
    schema_version: SOURCE_INTAKE_TRANSPORT_FALLBACK_SCHEMA,
    proofAuthority: SOURCE_INTAKE_TRANSPORT_FALLBACK_AUTHORITY,
    proof_authority: SOURCE_INTAKE_TRANSPORT_FALLBACK_AUTHORITY,
    fallbackAuthority: SOURCE_INTAKE_TRANSPORT_FALLBACK_AUTHORITY,
    fallback_authority: SOURCE_INTAKE_TRANSPORT_FALLBACK_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    acceptedAsTransportFallbackEvidence: true,
    accepted_as_transport_fallback_evidence: true,
    targetNameIndependent: true,
    target_name_independent: true,
    projectNameWhitelist: [],
    project_name_whitelist: [],
    specificTargetIdsAllowed: [],
    specific_target_ids_allowed: [],
    reason,
    automatic: automatic === true,
    automaticReason,
    automatic_reason: automaticReason,
    requiresExplicitOptIn: requiresExplicitOptIn === true,
    requires_explicit_opt_in: requiresExplicitOptIn === true,
    recommendedTransport,
    recommended_transport: recommendedTransport,
    candidateSource,
    candidate_source: candidateSource,
    immutableCommit,
    immutable_commit: immutableCommit,
    directSourceInputEvidenceHash: seed.directSourceInputEvidenceHash,
    direct_source_input_evidence_hash: seed.directSourceInputEvidenceHash,
    fullTreeOptInEnv,
    full_tree_opt_in_env: fullTreeOptInEnv,
    forcedByEnv,
    forced_by_env: forcedByEnv,
    trigger,
    fallbackEvidenceHash,
    fallback_evidence_hash: fallbackEvidenceHash,
    githubTree,
    github_tree: githubTree,
  };
}

async function readLocalGitTreeListing(candidate, { sourceIntakeTimeoutMs }) {
  if (!candidate.localRepoPath) return { attempted: false };
  const repoPath = path.resolve(candidate.localRepoPath);
  const startedAt = new Date().toISOString();
  const noSizeListing = process.env.SYNTHI_GPU_HMR_LOCAL_GIT_NO_SIZE === '1';
  const baseRunOptions = {
    cwd: REPO_ROOT,
    timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
    stdoutMax: 8 * 1024 * 1024,
    stderrMax: 64000,
    streamOutput: false,
  };
  const topLevel = await runProcess(
    'git',
    ['-C', repoPath, 'rev-parse', '--show-toplevel'],
    baseRunOptions,
  );
  if (topLevel.exitCode !== 0 || topLevel.timedOut || topLevel.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_top_level_failed',
      reason: 'source_tree_local_git_top_level_failed',
      repoPath,
      repo_path: repoPath,
      topLevel,
      top_level: topLevel,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  const resolvedTopLevel = path.resolve(topLevel.stdout.trim());
  const commitCheck = await runProcess(
    'git',
    ['-C', resolvedTopLevel, 'cat-file', '-e', `${candidate.immutableCommit}^{commit}`],
    baseRunOptions,
  );
  if (commitCheck.exitCode !== 0 || commitCheck.timedOut || commitCheck.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_commit_missing',
      reason: 'source_tree_local_git_commit_missing',
      repoPath,
      repo_path: repoPath,
      resolvedTopLevel,
      resolved_top_level: resolvedTopLevel,
      commitCheck,
      commit_check: commitCheck,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  const dirtyCheck = await runProcess(
    'git',
    ['-C', resolvedTopLevel, 'status', '--porcelain=v1', '--untracked-files=all'],
    baseRunOptions,
  );
  if (dirtyCheck.exitCode !== 0 || dirtyCheck.timedOut || dirtyCheck.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_status_failed',
      reason: 'source_tree_local_git_status_failed',
      repoPath,
      repo_path: repoPath,
      resolvedTopLevel,
      resolved_top_level: resolvedTopLevel,
      dirtyCheck,
      dirty_check: dirtyCheck,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  const dirtyStatus = dirtyCheck.stdout.trim();
  const dirtyWorktreeObserved = Boolean(dirtyStatus);
  const lsTree = await runProcess(
    'git',
    noSizeListing
      ? ['-C', resolvedTopLevel, 'ls-tree', '-r', '--full-tree', candidate.immutableCommit]
      : ['-C', resolvedTopLevel, 'ls-tree', '-r', '-l', '--full-tree', candidate.immutableCommit],
    baseRunOptions,
  );
  if (lsTree.exitCode !== 0 || lsTree.timedOut || lsTree.error) {
    return {
      attempted: true,
      accepted: false,
      status: 'source_intake_local_git_listing_failed',
      reason: 'source_tree_local_git_listing_failed',
      repoPath,
      repo_path: repoPath,
      resolvedTopLevel,
      resolved_top_level: resolvedTopLevel,
      lsTree,
      ls_tree: lsTree,
      startedAt,
      started_at: startedAt,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
  return {
    attempted: true,
    accepted: true,
    transport: dirtyWorktreeObserved
      ? 'local_git_ls_tree_commit_snapshot_dirty_worktree'
      : noSizeListing
        ? 'local_git_ls_tree_no_size_clean_worktree'
        : 'local_git_ls_tree_clean_worktree',
    repoPath,
    repo_path: repoPath,
    resolvedTopLevel,
    resolved_top_level: resolvedTopLevel,
    sourceSnapshotMode: 'immutable_git_commit_tree',
    source_snapshot_mode: 'immutable_git_commit_tree',
    worktreeContentConsumed: false,
    worktree_content_consumed: false,
    dirtyWorktreeObserved,
    dirty_worktree_observed: dirtyWorktreeObserved,
    dirtyStatusTail: dirtyWorktreeObserved ? tail(dirtyStatus, 4000) : null,
    dirty_status_tail: dirtyWorktreeObserved ? tail(dirtyStatus, 4000) : null,
    listingMode: noSizeListing ? 'git_ls_tree_no_size' : 'git_ls_tree_with_size',
    listing_mode: noSizeListing ? 'git_ls_tree_no_size' : 'git_ls_tree_with_size',
    byteLengthMode: noSizeListing ? 'unknown_avoids_blob_fetch' : 'declared_from_git_ls_tree_l',
    byte_length_mode: noSizeListing ? 'unknown_avoids_blob_fetch' : 'declared_from_git_ls_tree_l',
    files: parseGitLsTree(lsTree.stdout),
    startedAt,
    started_at: startedAt,
    finishedAt: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
}

async function buildAcceptedSourceIntakeFacet({
  base,
  candidate,
  files,
  transport,
  transportEvidence = {},
  sourceIntakeTimeoutMs,
}) {
  const listingIdentity = canonicalSourceListingIdentity(files);
  const totalKnownBytes = files.reduce((sum, file) => sum + (Number.isFinite(file.byteLength) ? file.byteLength : 0), 0);
  const listingClassification = classifySourceListing(files);
  const sourceListingHash = contentHash(stableJson(listingIdentity));
  const sourceListingManifest = {
    schemaVersion: 'synthi.gpu_hmr.random_cold_source_listing_manifest.v1',
    schema_version: 'synthi.gpu_hmr.random_cold_source_listing_manifest.v1',
    proofAuthority: 'source_listing_entries_only_not_gpu_hmr_success',
    proof_authority: 'source_listing_entries_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    sourceListingHash,
    source_listing_hash: sourceListingHash,
    entries: listingIdentity,
    fileCount: files.length,
    file_count: files.length,
    totalKnownBytes,
    total_known_bytes: totalKnownBytes,
    sourceRelevantFileCount: listingClassification.sourceRelevantFileCount,
    source_relevant_file_count: listingClassification.sourceRelevantFileCount,
    sourceOrBuildRelevantFileCount: listingClassification.sourceOrBuildRelevantFileCount,
    source_or_build_relevant_file_count: listingClassification.sourceOrBuildRelevantFileCount,
    gpuSourceSignalCount: listingClassification.gpuSourceSignalCount,
    gpu_source_signal_count: listingClassification.gpuSourceSignalCount,
  };
  const buildMetadataContentEvidence = await collectBuildMetadataContentEvidence({
    candidate,
    files,
    classification: listingClassification,
    transport,
    transportEvidence,
    sourceIntakeTimeoutMs,
  });
  const classification = mergeClassificationWithBuildMetadataContent(
    listingClassification,
    buildMetadataContentEvidence,
  );
  const buildMetadataDiscovery = discoverBuildMetadata({
    candidate,
    files,
    classification,
    contentEvidence: buildMetadataContentEvidence,
  });
  const runtimeBoundaryExpectation = deriveRuntimeBoundaryExpectation({
    candidate,
    classification,
    buildMetadataDiscovery,
  });
  const coldBuildExecutionPlan = deriveColdBuildExecutionPlan({
    candidate,
    sourceListingHash,
    buildMetadataDiscovery,
    buildMetadataContentEvidence,
    runtimeBoundaryExpectation,
  });
  const runtimeSupportClosureObligation = deriveRuntimeSupportClosureObligation({
    candidate,
    runtimeBoundaryExpectation,
  });
  const runtimeBoundaryEventManifestTemplate = deriveRuntimeBoundaryEventManifestTemplate({
    candidate,
    runtimeBoundaryExpectation,
    sourceListingHash,
    buildMetadataContentHash:
      buildMetadataContentEvidence.contentEvidenceHash
      ?? buildMetadataContentEvidence.content_evidence_hash
      ?? null,
  });
  const runtimeAppHookMaterializationPlan = deriveAppHookMaterializationPlan({
    candidate,
    runtimeBoundaryExpectation,
    runtimeBoundaryEventManifestTemplate,
    runtimeSupportClosureObligation,
    sourceIntakeEvidence: {
      sourceListingHash,
      source_listing_hash: sourceListingHash,
      buildMetadataContentEvidence,
      build_metadata_content_evidence: buildMetadataContentEvidence,
      backendCandidates: classification.backendCandidates,
      backend_candidates: classification.backendCandidates,
    },
  });
  const blockingGaps = [];
  if (classification.buildSignalCount === 0) blockingGaps.push('build_system_metadata_not_detected');
  if (classification.backendCandidates.length === 0) blockingGaps.push('gpu_backend_signal_not_detected');
  const facet = {
    ...base,
    status: 'source_intake_listing_accepted',
    acceptedAsIntakeEvidence: true,
    accepted_as_intake_evidence: true,
    transport,
    sourceTransport: transport,
    source_transport: transport,
    transportEvidence,
    transport_evidence: transportEvidence,
    fileCount: files.length,
    file_count: files.length,
    totalKnownBytes,
    total_known_bytes: totalKnownBytes,
    listingHash: sourceListingHash,
    listing_hash: sourceListingHash,
    sourceListingHash,
    source_listing_hash: sourceListingHash,
    sourceListingManifest,
    source_listing_manifest: sourceListingManifest,
    sampleFiles: files.slice(0, 80).map((file) => file.path),
    sample_files: files.slice(0, 80).map((file) => file.path),
    buildSystemHints: candidate.buildSystemHints,
    build_system_hints: candidate.buildSystemHints,
    buildMetadataDiscovery,
    build_metadata_discovery: buildMetadataDiscovery,
    buildMetadataDiscoveryAccepted: buildMetadataDiscovery.acceptedAsBuildMetadataDiscovery === true,
    build_metadata_discovery_accepted: buildMetadataDiscovery.acceptedAsBuildMetadataDiscovery === true,
    buildMetadataContentEvidence,
    build_metadata_content_evidence: buildMetadataContentEvidence,
    buildMetadataContentAccepted: buildMetadataContentEvidence.acceptedAsBuildMetadataContent === true,
    build_metadata_content_accepted: buildMetadataContentEvidence.acceptedAsBuildMetadataContent === true,
    coldBuildExecutionPlan,
    cold_build_execution_plan: coldBuildExecutionPlan,
    coldBuildExecutionPlanAccepted:
      coldBuildExecutionPlan.acceptedAsSupportEvidence === true,
    cold_build_execution_plan_accepted:
      coldBuildExecutionPlan.acceptedAsSupportEvidence === true,
    runtimeBoundaryExpectation,
    runtime_boundary_expectation: runtimeBoundaryExpectation,
    runtimeBoundaryExpectationAccepted:
      runtimeBoundaryExpectation.acceptedAsRuntimeBoundaryExpectation === true,
    runtime_boundary_expectation_accepted:
      runtimeBoundaryExpectation.acceptedAsRuntimeBoundaryExpectation === true,
    runtimeSupportClosureObligation,
    runtime_support_closure_obligation: runtimeSupportClosureObligation,
    runtimeSupportClosureOutcome: runtimeSupportClosureObligation.outcome,
    runtime_support_closure_outcome: runtimeSupportClosureObligation.outcome,
    runtimeBoundaryEventManifestTemplate,
    runtime_boundary_event_manifest_template: runtimeBoundaryEventManifestTemplate,
    runtimeBoundaryEventManifestTemplateAccepted:
      runtimeBoundaryEventManifestTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate === true,
    runtime_boundary_event_manifest_template_accepted:
      runtimeBoundaryEventManifestTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate === true,
    runtimeAppHookMaterializationPlan,
    runtime_app_hook_materialization_plan: runtimeAppHookMaterializationPlan,
    runtimeAppHookMaterializationPlanAccepted:
      runtimeAppHookMaterializationPlan.acceptedAsSupportEvidence === true,
    runtime_app_hook_materialization_plan_accepted:
      runtimeAppHookMaterializationPlan.acceptedAsSupportEvidence === true,
    runtimeBoundaryHints: candidate.runtimeBoundaryHints,
    runtime_boundary_hints: candidate.runtimeBoundaryHints,
    oracleHints: candidate.oracleHints,
    oracle_hints: candidate.oracleHints,
    ...classification,
    blockingGaps,
    blocking_gaps: blockingGaps,
    finishedAt: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  return {
    ...facet,
    facetHash: contentHash(stableJson(facet)),
    facet_hash: contentHash(stableJson(facet)),
  };
}

async function runUnprofiledSourceIntake(candidate, { sourceIntakeTimeoutMs }) {
  const startedAt = new Date().toISOString();
  const localPath = sourceIntakePathForCandidate(candidate);
  const relativeLocalPath = path.relative(REPO_ROOT, localPath).replace(/\\/g, '/');
  const liveGitFallbackEnabled = process.env.SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK === '1';
  const forceGitFallbackEnabled = process.env.SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK === '1';
  const fullGitFallbackEnabled = fullGitSourceTreeFallbackEnabled();
  const directSourceAutomaticGitFallbackEnabled = directUserSourceCanUseAutomaticGitFallback(candidate);
  const base = {
    schemaVersion: SOURCE_INTAKE_SCHEMA,
    schema_version: SOURCE_INTAKE_SCHEMA,
    proofAuthority: SOURCE_INTAKE_AUTHORITY,
    proof_authority: SOURCE_INTAKE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    localRepoPath: candidate.localRepoPath,
    local_repo_path: candidate.localRepoPath,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    localPath: relativeLocalPath,
    local_path: relativeLocalPath,
    gitFallbackForced: forceGitFallbackEnabled,
    git_fallback_forced: forceGitFallbackEnabled,
    liveGitFallbackEnabled,
    live_git_fallback_enabled: liveGitFallbackEnabled,
    directSourceAutomaticGitFallbackEnabled,
    direct_source_automatic_git_fallback_enabled: directSourceAutomaticGitFallbackEnabled,
    fullGitFallbackEnabled,
    full_git_fallback_enabled: fullGitFallbackEnabled,
    startedAt,
    started_at: startedAt,
  };
  const fail = (status, reason, extra = {}) => {
    const facet = {
      ...base,
      status,
      acceptedAsIntakeEvidence: false,
      accepted_as_intake_evidence: false,
      blockingGaps: [reason],
      blocking_gaps: [reason],
      ...extra,
      finishedAt: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
    return {
      ...facet,
      facetHash: contentHash(stableJson(facet)),
      facet_hash: contentHash(stableJson(facet)),
    };
  };
  const localGitListing = await readLocalGitTreeListing(candidate, { sourceIntakeTimeoutMs });
  if (localGitListing.attempted === true) {
    if (localGitListing.accepted !== true) {
      return fail(localGitListing.status, localGitListing.reason, {
        localGitListing,
        local_git_listing: localGitListing,
      });
    }
    if (!Array.isArray(localGitListing.files) || localGitListing.files.length === 0) {
      return fail('source_intake_local_git_empty_listing', 'source_tree_local_git_empty_listing', {
        localGitListing,
        local_git_listing: localGitListing,
      });
    }
    return await buildAcceptedSourceIntakeFacet({
      base,
      candidate,
      files: localGitListing.files,
      transport: localGitListing.transport,
      transportEvidence: {
        repoPath: localGitListing.repoPath,
        repo_path: localGitListing.repo_path,
        resolvedTopLevel: localGitListing.resolvedTopLevel,
        resolved_top_level: localGitListing.resolved_top_level,
        sourceSnapshotMode: localGitListing.sourceSnapshotMode,
        source_snapshot_mode: localGitListing.source_snapshot_mode,
        worktreeContentConsumed: localGitListing.worktreeContentConsumed,
        worktree_content_consumed: localGitListing.worktree_content_consumed,
        dirtyWorktreeObserved: localGitListing.dirtyWorktreeObserved,
        dirty_worktree_observed: localGitListing.dirty_worktree_observed,
        dirtyStatusTail: localGitListing.dirtyStatusTail,
        dirty_status_tail: localGitListing.dirty_status_tail,
        listingMode: localGitListing.listingMode,
        listing_mode: localGitListing.listing_mode,
        byteLengthMode: localGitListing.byteLengthMode,
        byte_length_mode: localGitListing.byte_length_mode,
        startedAt: localGitListing.startedAt,
        started_at: localGitListing.started_at,
        finishedAt: localGitListing.finishedAt,
        finished_at: localGitListing.finished_at,
      },
      sourceIntakeTimeoutMs,
    });
  }
  await rm(localPath, { recursive: true, force: true });
  const githubTree = forceGitFallbackEnabled
    ? { attempted: false, skipped: true, reason: 'forced_git_fallback_for_source_tree_intake' }
    : await fetchGitHubTreeListing(candidate, { sourceIntakeTimeoutMs });
  let githubTreeFallback = forceGitFallbackEnabled
    ? sourceIntakeTransportFallbackEvidence({
      candidate,
      reason: 'forced_git_fallback_for_source_tree_intake',
      automatic: false,
      automaticReason: 'explicit_force_git_fallback_env',
      requiresExplicitOptIn: false,
      recommendedTransport: fullGitFallbackEnabled
        ? 'git_fetch_depth_1_full_tree'
        : 'git_fetch_depth_1_blobless',
      forcedByEnv: 'SYNTHI_GPU_HMR_UNPROFILED_FORCE_GIT_FALLBACK=1',
      fullTreeOptInEnv: fullGitFallbackEnabled
        ? 'SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK=1'
        : null,
    })
    : null;
  if (githubTree.attempted === true) {
    if (githubTree.accepted !== true) {
      if (githubTree.status === 'source_intake_github_tree_truncated') {
        const automaticTruncationFallback =
          githubTreeTruncationCanUseAutomaticGitFallback(githubTree, candidate);
        if (!liveGitFallbackEnabled && !automaticTruncationFallback) {
          const gitFallbackPlan = {
            available: true,
            available_authority: 'fallback_plan_only_not_source_intake_or_gpu_hmr_success',
            recommendedTransport: fullGitFallbackEnabled
              ? 'git_fetch_depth_1_full_tree'
              : 'git_fetch_depth_1_blobless',
            recommended_transport: fullGitFallbackEnabled
              ? 'git_fetch_depth_1_full_tree'
              : 'git_fetch_depth_1_blobless',
            requiresExplicitOptIn: true,
            requires_explicit_opt_in: true,
            optInEnv: 'SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK=1',
            opt_in_env: 'SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK=1',
            fullTreeOptInEnv: 'SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK=1',
            full_tree_opt_in_env: 'SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK=1',
            reason: 'github_recursive_tree_truncated',
          };
          return fail('source_intake_github_tree_truncated_git_fallback_disabled', githubTree.reason, {
            githubTree,
            github_tree: githubTree,
            gitFallbackPlan,
            git_fallback_plan: gitFallbackPlan,
          });
        }
        githubTreeFallback = sourceIntakeTransportFallbackEvidence({
          candidate,
          reason: automaticTruncationFallback
            ? 'github_recursive_tree_truncated_direct_source_falling_back_to_blobless_git_tree'
            : 'github_recursive_tree_truncated_falling_back_to_blobless_git_tree',
          automatic: automaticTruncationFallback,
          automaticReason: automaticTruncationFallback
            ? 'direct_user_source_github_tree_truncated'
            : 'explicit_git_fallback_opt_in',
          requiresExplicitOptIn: automaticTruncationFallback !== true,
          recommendedTransport: fullGitFallbackEnabled
            ? 'git_fetch_depth_1_full_tree'
            : 'git_fetch_depth_1_blobless',
          fullTreeOptInEnv: fullGitFallbackEnabled
            ? 'SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK=1'
            : null,
          githubTree,
        });
      } else if (githubTreeFailureCanUseAutomaticGitFallback(githubTree)) {
        githubTreeFallback = sourceIntakeTransportFallbackEvidence({
          candidate,
          reason: 'github_tree_rate_limited_falling_back_to_blobless_git_tree',
          automatic: true,
          automaticReason: 'github_api_rate_limited',
          recommendedTransport: fullGitFallbackEnabled
            ? 'git_fetch_depth_1_full_tree'
            : 'git_fetch_depth_1_blobless',
          requiresExplicitOptIn: false,
          fullTreeOptInEnv: fullGitFallbackEnabled
            ? 'SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK=1'
            : null,
          githubTree,
        });
      } else {
        return fail(githubTree.status, githubTree.reason, {
          githubTree,
          github_tree: githubTree,
        });
      }
    } else {
      if (!Array.isArray(githubTree.files) || githubTree.files.length === 0) {
        return fail('source_intake_empty_listing', 'source_tree_listing_empty', {
          githubTree,
          github_tree: githubTree,
        });
      }
      return await buildAcceptedSourceIntakeFacet({
        base,
        candidate,
        files: githubTree.files,
        transport: githubTree.transport,
        transportEvidence: {
          apiUrl: githubTree.apiUrl,
          api_url: githubTree.api_url,
          githubApiAuthentication: githubTree.githubApiAuthentication,
          github_api_authentication: githubTree.github_api_authentication,
          startedAt: githubTree.startedAt,
          started_at: githubTree.started_at,
          finishedAt: githubTree.finishedAt,
          finished_at: githubTree.finished_at,
        },
        sourceIntakeTimeoutMs,
      });
    }
  }
  await mkdir(localPath, { recursive: true });
  const gitInit = await runProcess(
    'git',
    ['init', localPath],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 30000),
      stdoutMax: 64000,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (gitInit.exitCode !== 0 || gitInit.timedOut || gitInit.error) {
    return fail('source_intake_git_init_failed', 'source_tree_git_init_failed', {
      gitInit,
      git_init: gitInit,
    });
  }
  const remoteAdd = await runProcess(
    'git',
    ['-C', localPath, 'remote', 'add', 'origin', candidate.sourceUrl],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 30000),
      stdoutMax: 64000,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (remoteAdd.exitCode !== 0 || remoteAdd.timedOut || remoteAdd.error) {
    return fail('source_intake_remote_add_failed', 'source_tree_remote_add_failed', {
      remoteAdd,
      remote_add: remoteAdd,
    });
  }
  const fetch = await runProcess(
    'git',
    fullGitFallbackEnabled
      ? ['-C', localPath, 'fetch', '--depth=1', 'origin', candidate.immutableCommit]
      : ['-C', localPath, 'fetch', '--depth=1', '--filter=blob:none', 'origin', candidate.immutableCommit],
    {
      cwd: REPO_ROOT,
      timeoutMs: sourceIntakeTimeoutMs,
      stdoutMax: 64000,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (fetch.exitCode !== 0 || fetch.timedOut || fetch.error) {
    const sourceIntakeProcessCleanup = fetch.timedOut || fetch.error
      ? cleanupSourceIntakeGitProcesses(localPath)
      : null;
    return fail('source_intake_fetch_failed', 'source_tree_fetch_failed', {
      fetch,
      fetch_result: fetch,
      sourceIntakeProcessCleanup,
      source_intake_process_cleanup: sourceIntakeProcessCleanup,
    });
  }
  const commitCheck = await runProcess(
    'git',
    ['-C', localPath, 'cat-file', '-e', `${candidate.immutableCommit}^{commit}`],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 60000),
      streamOutput: false,
    },
  );
  if (commitCheck.exitCode !== 0 || commitCheck.timedOut || commitCheck.error) {
    return fail('source_intake_commit_missing', 'immutable_commit_not_available', {
      commitCheck,
      commit_check: commitCheck,
    });
  }
  const bloblessSizeListing = bloblessGitTreeSizeListingEnabled();
  const sizeListing = fullGitFallbackEnabled || bloblessSizeListing;
  const lsTree = await runProcess(
    'git',
    sizeListing
      ? ['-C', localPath, 'ls-tree', '-r', '-l', '--full-tree', candidate.immutableCommit]
      : ['-C', localPath, 'ls-tree', '-r', '--full-tree', candidate.immutableCommit],
    {
      cwd: REPO_ROOT,
      timeoutMs: Math.min(sourceIntakeTimeoutMs, 120000),
      stdoutMax: 8 * 1024 * 1024,
      stderrMax: 64000,
      streamOutput: false,
    },
  );
  if (lsTree.exitCode !== 0 || lsTree.timedOut || lsTree.error) {
    const sourceIntakeProcessCleanup = lsTree.timedOut || lsTree.error
      ? cleanupSourceIntakeGitProcesses(localPath)
      : null;
    return fail('source_intake_listing_failed', 'source_tree_listing_failed', {
      listingResult: lsTree,
      listing_result: lsTree,
      sourceIntakeProcessCleanup,
      source_intake_process_cleanup: sourceIntakeProcessCleanup,
    });
  }
  const files = parseGitLsTree(lsTree.stdout);
  if (files.length === 0) {
    return fail('source_intake_empty_listing', 'source_tree_listing_empty');
  }
  return await buildAcceptedSourceIntakeFacet({
    base,
    candidate,
    files,
    transport: fullGitFallbackEnabled ? 'git_fetch_depth_1_full_tree' : 'git_fetch_depth_1_blobless',
    transportEvidence: {
      githubTreeFallback,
      github_tree_fallback: githubTreeFallback,
      fetchMode: fullGitFallbackEnabled ? 'depth_1_full_tree' : 'depth_1_blobless',
      fetch_mode: fullGitFallbackEnabled ? 'depth_1_full_tree' : 'depth_1_blobless',
      fullGitFallbackEnabled,
      full_git_fallback_enabled: fullGitFallbackEnabled,
      fullGitFallbackOptInEnv: fullGitFallbackEnabled
        ? 'SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK'
        : null,
      full_git_fallback_opt_in_env: fullGitFallbackEnabled
        ? 'SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK'
        : null,
      listingMode: fullGitFallbackEnabled
        ? 'git_ls_tree_with_size_full_fetch'
        : bloblessSizeListing
        ? 'git_ls_tree_with_size_blobless_opt_in'
        : 'git_ls_tree_no_size_blobless',
      listing_mode: fullGitFallbackEnabled
        ? 'git_ls_tree_with_size_full_fetch'
        : bloblessSizeListing
        ? 'git_ls_tree_with_size_blobless_opt_in'
        : 'git_ls_tree_no_size_blobless',
      byteLengthMode: fullGitFallbackEnabled
        ? 'declared_from_git_ls_tree_l_full_fetch'
        : bloblessSizeListing
        ? 'declared_from_git_ls_tree_l_blobless_opt_in'
        : 'unknown_avoids_blob_fetch',
      byte_length_mode: fullGitFallbackEnabled
        ? 'declared_from_git_ls_tree_l_full_fetch'
        : bloblessSizeListing
        ? 'declared_from_git_ls_tree_l_blobless_opt_in'
        : 'unknown_avoids_blob_fetch',
      byteLengthOptInEnv: bloblessSizeListing
        ? 'SYNTHI_GPU_HMR_BLOBLESS_TREE_SIZE_LISTING'
        : null,
      byte_length_opt_in_env: bloblessSizeListing
        ? 'SYNTHI_GPU_HMR_BLOBLESS_TREE_SIZE_LISTING'
        : null,
      resolvedLocalPath: localPath,
      resolved_local_path: localPath,
      localPath: relativeLocalPath,
      local_path: relativeLocalPath,
      gitInit,
      git_init: gitInit,
      remoteAdd,
      remote_add: remoteAdd,
      fetch,
      fetch_result: fetch,
    },
    sourceIntakeTimeoutMs,
  });
}

async function readJsonArtifact(filePath) {
  if (!filePath) return { present: false, value: null, textSha256: null, byteLength: 0, error: null };
  try {
    const text = await readFile(filePath, 'utf8');
    return {
      present: true,
      value: JSON.parse(text),
      textSha256: contentHash(text),
      byteLength: Buffer.byteLength(text, 'utf8'),
      error: null,
    };
  } catch (error) {
    return {
      present: false,
      value: null,
      textSha256: null,
      byteLength: 0,
      error: error?.message ?? String(error),
    };
  }
}

function runtimeBoundaryProfileBackend(backendCandidate) {
  const backend = String(backendCandidate ?? '').trim().toLowerCase();
  if (backend === 'hip_rocm') return 'hip';
  if (backend === 'webgpu_wgsl') return 'webgpu';
  return backend || 'unknown';
}

function derivedRuntimeProfileSourcePath(sourceIntakeEvidence = {}) {
  const sourcePath = firstString(
    firstArrayField(sourceIntakeEvidence, 'gpuSourceSignals', 'gpu_source_signals')[0],
    firstArrayField(sourceIntakeEvidence, 'sourceRelevantFiles', 'source_relevant_files')[0],
    firstArrayField(sourceIntakeEvidence, 'sampleFiles', 'sample_files')[0],
  );
  return sourcePath ? sourcePath.replace(/\\/g, '/') : null;
}

function derivedRuntimeProfileEntryPoint(backendCandidate) {
  const backend = String(backendCandidate ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `${backend || 'unknown'}_runtime_boundary_entrypoint`;
}

async function deriveRuntimeProofProfileFromColdIntake(candidate, sourceIntakeEvidence = {}) {
  if (candidate.runtimeProofProfilePath) return null;
  const runtimeBoundaryExpectation = firstObjectField(
    sourceIntakeEvidence,
    'runtimeBoundaryExpectation',
    'runtime_boundary_expectation',
  );
  const runtimeBoundaryEventManifestTemplate = firstObjectField(
    sourceIntakeEvidence,
    'runtimeBoundaryEventManifestTemplate',
    'runtime_boundary_event_manifest_template',
  );
  const buildMetadataContentEvidence = firstObjectField(
    sourceIntakeEvidence,
    'buildMetadataContentEvidence',
    'build_metadata_content_evidence',
  );
  const sourceListingHash = firstString(
    sourceIntakeEvidence.sourceListingHash,
    sourceIntakeEvidence.source_listing_hash,
    sourceIntakeEvidence.listingHash,
    sourceIntakeEvidence.listing_hash,
  );
  const buildMetadataContentHash = firstString(
    buildMetadataContentEvidence.contentEvidenceHash,
    buildMetadataContentEvidence.content_evidence_hash,
  );
  const expectationHash = firstString(
    runtimeBoundaryExpectation.expectationHash,
    runtimeBoundaryExpectation.expectation_hash,
  );
  const templateHash = firstString(
    runtimeBoundaryEventManifestTemplate.templateHash,
    runtimeBoundaryEventManifestTemplate.template_hash,
  );
  const backendCandidates = uniqueSortedStrings([
    ...firstArrayField(runtimeBoundaryExpectation, 'backendCandidates', 'backend_candidates'),
    ...firstArrayField(sourceIntakeEvidence, 'backendCandidates', 'backend_candidates'),
  ]);
  const acceptedSourceIntake =
    sourceIntakeEvidence.acceptedAsIntakeEvidence === true
    || sourceIntakeEvidence.accepted_as_intake_evidence === true;
  const buildMetadataContentAccepted =
    buildMetadataContentEvidence.acceptedAsBuildMetadataContent === true
    || buildMetadataContentEvidence.accepted_as_build_metadata_content === true;
  const expectationAccepted =
    runtimeBoundaryExpectation.acceptedAsRuntimeBoundaryExpectation === true
    || runtimeBoundaryExpectation.accepted_as_runtime_boundary_expectation === true;
  const templateAccepted =
    runtimeBoundaryEventManifestTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate === true
    || runtimeBoundaryEventManifestTemplate.accepted_as_runtime_boundary_event_manifest_template === true;
  const primaryBackend = backendCandidates[0] ?? 'unknown';
  const boundaryBackend = runtimeBoundaryProfileBackend(primaryBackend);
  const sourceFile = derivedRuntimeProfileSourcePath(sourceIntakeEvidence);
  const entryPoint = derivedRuntimeProfileEntryPoint(primaryBackend);
  const blockingGaps = [
    acceptedSourceIntake ? null : 'derived_runtime_profile_source_intake_not_accepted',
    buildMetadataContentAccepted ? null : 'derived_runtime_profile_build_metadata_content_not_accepted',
    expectationAccepted ? null : 'derived_runtime_profile_runtime_boundary_expectation_not_accepted',
    templateAccepted ? null : 'derived_runtime_profile_event_manifest_template_not_accepted',
    sourceListingHash ? null : 'derived_runtime_profile_source_listing_hash_missing',
    buildMetadataContentHash ? null : 'derived_runtime_profile_build_metadata_hash_missing',
    expectationHash ? null : 'derived_runtime_profile_expectation_hash_missing',
    templateHash ? null : 'derived_runtime_profile_template_hash_missing',
    backendCandidates.length > 0 ? null : 'derived_runtime_profile_backend_candidate_missing',
    sourceFile ? null : 'derived_runtime_profile_source_path_missing',
  ].filter(Boolean);
  const accepted = blockingGaps.length === 0;
  const profileSeed = {
    candidateId: candidate.id,
    sourceUrl: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    sourceListingHash,
    buildMetadataContentHash,
    expectationHash,
    templateHash,
    backendCandidates,
    sourceFile,
    entryPoint,
  };
  const profileId = `derived-${safeSlug(candidate.id)}-${sha256(stableJson(profileSeed)).slice(0, 12)}`;
  const baseDir = path.join(
    LOG_DIR,
    'derived-runtime-profiles',
    safeSlug(candidate.id),
    makeStamp(),
  );
  const eventManifestPath = path.join(baseDir, 'runtime-boundary-events-template.json');
  const profilePath = path.join(baseDir, 'runtime-profile.json');
  const eventManifestRelativePath = repoRelativePath(eventManifestPath);
  const profileRelativePath = repoRelativePath(profilePath);
  const sourceIdentityEvidenceRefs = [
    sourceListingHash ? `random-cold-source-listing:${sourceListingHash}` : null,
    buildMetadataContentHash ? `random-cold-build-metadata:${buildMetadataContentHash}` : null,
    expectationHash ? `random-cold-runtime-boundary-expectation:${expectationHash}` : null,
    templateHash ? `random-cold-runtime-boundary-template:${templateHash}` : null,
    candidate.directInputEvidence?.sourceIdentityHash
      ? `direct-source-input:${candidate.directInputEvidence.sourceIdentityHash}`
      : null,
  ].filter(Boolean);
  const eventManifest = {
    schemaVersion: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    proofAuthority: DERIVED_RUNTIME_PROFILE_EVENT_MANIFEST_AUTHORITY,
    proof_authority: DERIVED_RUNTIME_PROFILE_EVENT_MANIFEST_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    derivedFromColdIntake: true,
    derived_from_cold_intake: true,
    requiresObservedRuntimeEvents: true,
    requires_observed_runtime_events: true,
    runtimeBoundaryEvents: [],
    runtime_boundary_events: [],
    missingRuntimeEventsReason: 'derived_contract_requires_target_process_boundary_events',
    missing_runtime_events_reason: 'derived_contract_requires_target_process_boundary_events',
    runtimeBoundaryAdapterInput: {
      projectId: candidate.id,
      project_id: candidate.id,
      editId: 'cold-intake-derived-runtime-profile-contract',
      edit_id: 'cold-intake-derived-runtime-profile-contract',
      targetId: `${candidate.id}:runtime-boundary`,
      target_id: `${candidate.id}:runtime-boundary`,
      backend: boundaryBackend,
      sourcePaths: [sourceFile],
      source_paths: [sourceFile],
      sourceManifestHash: sourceListingHash,
      source_manifest_hash: sourceListingHash,
      sourceManifestHashVerified: acceptedSourceIntake,
      source_manifest_hash_verified: acceptedSourceIntake,
      sourceIdentityEvidenceRefs,
      source_identity_evidence_refs: sourceIdentityEvidenceRefs,
      entryPoint,
      entry_point: entryPoint,
      runtimeBoundaryEvents: [],
      runtime_boundary_events: [],
    },
    runtime_boundary_adapter_input: {
      project_id: candidate.id,
      edit_id: 'cold-intake-derived-runtime-profile-contract',
      target_id: `${candidate.id}:runtime-boundary`,
      backend: boundaryBackend,
      source_paths: [sourceFile],
      source_manifest_hash: sourceListingHash,
      source_manifest_hash_verified: acceptedSourceIntake,
      source_identity_evidence_refs: sourceIdentityEvidenceRefs,
      entry_point: entryPoint,
      runtime_boundary_events: [],
    },
    runtimeBoundaryExpectationHash: expectationHash,
    runtime_boundary_expectation_hash: expectationHash,
    runtimeBoundaryEventManifestTemplateHash: templateHash,
    runtime_boundary_event_manifest_template_hash: templateHash,
    buildMetadataContentHash,
    build_metadata_content_hash: buildMetadataContentHash,
    sourceListingHash,
    source_listing_hash: sourceListingHash,
    backendCandidates,
    backend_candidates: backendCandidates,
    manifestTemplate: runtimeBoundaryEventManifestTemplate.manifestTemplate
      ?? runtimeBoundaryEventManifestTemplate.manifest_template
      ?? null,
    manifest_template: runtimeBoundaryEventManifestTemplate.manifest_template
      ?? runtimeBoundaryEventManifestTemplate.manifestTemplate
      ?? null,
    eventObjectTemplates: runtimeBoundaryEventManifestTemplate.eventObjectTemplates
      ?? runtimeBoundaryEventManifestTemplate.event_object_templates
      ?? [],
    event_object_templates: runtimeBoundaryEventManifestTemplate.event_object_templates
      ?? runtimeBoundaryEventManifestTemplate.eventObjectTemplates
      ?? [],
  };
  const profile = {
    schemaVersion: GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION,
    id: profileId,
    adapter: {
      family: 'generic-runtime-boundary-adapter',
      proofRunner: 'runtime-boundary-proof-adapter',
      runtimeBoundaryEventManifestPath: eventManifestRelativePath,
      runtimeBoundaryAppHook: {
        derivedFromColdIntake: true,
        sourceListingHash,
        buildMetadataContentHash,
        runtimeBoundaryExpectationHash: expectationHash,
        runtimeBoundaryEventManifestTemplateHash: templateHash,
      },
    },
    runtime: {
      targetName: `${candidate.id}:runtime-boundary`,
      requiredKernels: [entryPoint],
      reload: {
        kernelName: entryPoint,
        kernelSymbol: entryPoint,
      },
    },
    source: {
      file: sourceFile,
      before: 'synthi_runtime_boundary_contract_before',
      after: 'synthi_runtime_boundary_contract_after',
    },
    runMode: {
      metricScope: 'cold',
      cacheState: 'clean',
      editKind: 'gpu_artifact_edit',
    },
    proof: {
      requireStrictProvenance: true,
    },
  };
  const profileBody = `${JSON.stringify(profile, null, 2)}\n`;
  const eventManifestBody = `${JSON.stringify(eventManifest, null, 2)}\n`;
  const profileHash = contentHash(profileBody);
  const eventManifestHash = contentHash(eventManifestBody);
  const facetSeed = {
    schemaVersion: DERIVED_RUNTIME_PROFILE_CONTRACT_SCHEMA,
    candidateId: candidate.id,
    sourceUrl: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    accepted,
    profileHash,
    eventManifestHash,
    profileRelativePath,
    eventManifestRelativePath,
    sourceListingHash,
    buildMetadataContentHash,
    expectationHash,
    templateHash,
    backendCandidates,
    sourceFile,
    entryPoint,
    blockingGaps,
  };
  const facetHash = contentHash(stableJson(facetSeed));
  if (accepted) {
    await mkdir(baseDir, { recursive: true });
    await writeFile(eventManifestPath, eventManifestBody);
    await writeFile(profilePath, profileBody);
  }
  return {
    schemaVersion: DERIVED_RUNTIME_PROFILE_CONTRACT_SCHEMA,
    schema_version: DERIVED_RUNTIME_PROFILE_CONTRACT_SCHEMA,
    proofAuthority: DERIVED_RUNTIME_PROFILE_CONTRACT_AUTHORITY,
    proof_authority: DERIVED_RUNTIME_PROFILE_CONTRACT_AUTHORITY,
    accepted,
    acceptedAsDerivedRuntimeProfileContract: accepted,
    accepted_as_derived_runtime_profile_contract: accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    candidateId: candidate.id,
    candidate_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    runtimeProofProfileMode: accepted ? 'derived_from_cold_intake_contract' : 'none',
    runtime_proof_profile_mode: accepted ? 'derived_from_cold_intake_contract' : 'none',
    runtimeProofProfilePath: accepted ? profileRelativePath : null,
    runtime_proof_profile_path: accepted ? profileRelativePath : null,
    runtimeProofProfileResolvedPath: accepted ? profilePath : null,
    runtime_proof_profile_resolved_path: accepted ? profilePath : null,
    runtimeProofProfileSha256: accepted ? profileHash : null,
    runtime_proof_profile_sha256: accepted ? profileHash : null,
    runtimeBoundaryEventManifestPath: accepted ? eventManifestRelativePath : null,
    runtime_boundary_event_manifest_path: accepted ? eventManifestRelativePath : null,
    runtimeBoundaryEventManifestSha256: accepted ? eventManifestHash : null,
    runtime_boundary_event_manifest_sha256: accepted ? eventManifestHash : null,
    sourceListingHash,
    source_listing_hash: sourceListingHash,
    buildMetadataContentHash,
    build_metadata_content_hash: buildMetadataContentHash,
    runtimeBoundaryExpectationHash: expectationHash,
    runtime_boundary_expectation_hash: expectationHash,
    runtimeBoundaryEventManifestTemplateHash: templateHash,
    runtime_boundary_event_manifest_template_hash: templateHash,
    backendCandidates,
    backend_candidates: backendCandidates,
    selectedBackend: primaryBackend,
    selected_backend: primaryBackend,
    runtimeBoundaryBackend: boundaryBackend,
    runtime_boundary_backend: boundaryBackend,
    sourceFile,
    source_file: sourceFile,
    entryPoint,
    entry_point: entryPoint,
    sourceIdentityEvidenceRefs,
    source_identity_evidence_refs: sourceIdentityEvidenceRefs,
    blockingGaps,
    blocking_gaps: blockingGaps,
    facetHash,
    facet_hash: facetHash,
  };
}

async function runRuntimeProfileProofBridge(
  candidate,
  {
    runnerTimeoutMs,
    runtimeProofProfilePath = null,
    runtimeProofProfileRelativePath = null,
    runtimeProofProfileMode = null,
  } = {},
) {
  const profilePath = runtimeProofProfilePath ?? candidate.runtimeProofProfilePath;
  if (!profilePath) return null;
  const profileRelativePath = runtimeProofProfileRelativePath
    ?? candidate.runtimeProofProfileRelativePath
    ?? repoRelativePath(profilePath);
  const profileMode = runtimeProofProfileMode
    ?? candidate.runtimeProofProfileMode
    ?? 'declared_generic_runtime_profile';
  const profileRead = await readJsonArtifact(profilePath);
  const runtimeProofProfileSchemaVersion =
    profileRead.value?.schemaVersion
    ?? profileRead.value?.schema_version
    ?? profileRead.value?.schema
    ?? null;
  const runtimeProofProfileSchemaAccepted =
    profileRead.present === true
    && runtimeProofProfileSchemaVersion === GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION;
  const resultPath = path.join(
    LOG_DIR,
    'runtime-profile-results',
    `${safeSlug(candidate.id)}-${makeStamp()}-adapter-result.json`,
  );
  let runnerResult = null;
  if (runtimeProofProfileSchemaAccepted) {
    runnerResult = await runProcess(
      process.execPath,
      [
        path.join(SCRIPT_DIR, 'gpu-hmr-runtime-profile-proof.mjs'),
        '--profile',
        profileRelativePath,
        '--result-path',
        repoRelativePath(resultPath),
      ],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: runnerTimeoutMs,
        stdoutMax: 64000,
        stderrMax: 64000,
      },
    );
  }
  const adapterResultRead = await readJsonArtifact(resultPath);
  const adapterResult = adapterResultRead.value && typeof adapterResultRead.value === 'object'
    ? adapterResultRead.value
    : null;
  const strictRuntimeProofAccepted =
    adapterResult?.strictRuntimeProofAccepted === true
    || adapterResult?.strict_runtime_proof_accepted === true;
  const strictRuntimeProofId =
    adapterResult?.strictRuntimeProofId
    ?? adapterResult?.strict_runtime_proof_id
    ?? null;
  const proofLedgerId =
    adapterResult?.proofLedgerId
    ?? adapterResult?.proof_ledger_id
    ?? null;
  const runtimeBoundaryEventManifestPath =
    adapterResult?.runtimeBoundaryEventManifestPath
    ?? adapterResult?.runtime_boundary_event_manifest_path
    ?? null;
  const runtimeBoundaryEventManifestSha256 =
    adapterResult?.runtimeBoundaryEventManifestSha256
    ?? adapterResult?.runtime_boundary_event_manifest_sha256
    ?? null;
  const runtimeBoundaryProofAdapterAccepted =
    adapterResult?.runtimeBoundaryProofAdapterAccepted === true
    || adapterResult?.runtime_boundary_proof_adapter_accepted === true;
  const runtimeBoundaryProofAdapterProofId =
    adapterResult?.runtimeBoundaryProofAdapterProofId
    ?? adapterResult?.runtime_boundary_proof_adapter_proof_id
    ?? null;
  const authorityClaims = [];
  if (claimsGpuHmrAuthority(candidate)) authorityClaims.push('candidate_claimed_gpu_hmr_authority');
  if (claimsGpuHmrAuthority(adapterResult)) {
    authorityClaims.push('runtime_profile_adapter_result_claimed_gpu_hmr_authority');
  }
  const blockingGaps = [
    profileRead.present ? null : 'runtime_profile_path_unreadable',
    profileRead.present && !runtimeProofProfileSchemaAccepted
      ? 'runtime_profile_schema_unsupported_for_bridge'
      : null,
    runtimeProofProfileSchemaAccepted && !runnerResult
      ? 'runtime_profile_proof_runner_not_attempted'
      : null,
    runnerResult?.timedOut ? 'runtime_profile_proof_runner_timeout' : null,
    runnerResult && runnerResult.exitCode !== 0 ? 'runtime_profile_proof_runner_failed' : null,
    adapterResultRead.present ? null : 'runtime_profile_adapter_result_missing',
    authorityClaims.length > 0 ? 'runtime_profile_bridge_authority_claim_rejected' : null,
    strictRuntimeProofAccepted ? null : 'runtime_profile_adapter_strict_runtime_proof_not_accepted',
  ].filter(Boolean);
  const acceptedAsBridge =
    runtimeProofProfileSchemaAccepted === true
    && Boolean(runnerResult)
    && runnerResult.timedOut !== true
    && adapterResultRead.present === true
    && authorityClaims.length === 0;
  const facetSeed = {
    schemaVersion: RUNTIME_PROFILE_PROOF_BRIDGE_SCHEMA,
    candidateId: candidate.id,
    sourceUrl: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    runtimeProofProfilePath: profileRelativePath,
    runtimeProofProfileMode: profileMode,
    runtimeProofProfileSchemaVersion,
    runtimeProofProfileSchemaAccepted,
    runtimeProofProfileSha256: profileRead.textSha256,
    runtimeProfileAdapterResultSha256: adapterResultRead.textSha256,
    runtimeBoundaryEventManifestPath,
    runtimeBoundaryEventManifestSha256,
    runtimeBoundaryProofAdapterAccepted,
    runtimeBoundaryProofAdapterProofId,
    strictRuntimeProofAccepted,
    strictRuntimeProofId,
    proofLedgerId,
    authorityClaims,
    blockingGaps,
  };
  const facetHash = contentHash(stableJson(facetSeed));
  return {
    schemaVersion: RUNTIME_PROFILE_PROOF_BRIDGE_SCHEMA,
    schema_version: RUNTIME_PROFILE_PROOF_BRIDGE_SCHEMA,
    proofAuthority: RUNTIME_PROFILE_PROOF_BRIDGE_AUTHORITY,
    proof_authority: RUNTIME_PROFILE_PROOF_BRIDGE_AUTHORITY,
    accepted: acceptedAsBridge,
    acceptedAsRuntimeProfileProofBridge: acceptedAsBridge,
    accepted_as_runtime_profile_proof_bridge: acceptedAsBridge,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    candidateId: candidate.id,
    candidate_id: candidate.id,
    sourceUrl: candidate.sourceUrl,
    source_url: candidate.sourceUrl,
    immutableCommit: candidate.immutableCommit,
    immutable_commit: candidate.immutableCommit,
    runtimeProofProfilePath: profileRelativePath,
    runtime_proof_profile_path: profileRelativePath,
    runtimeProofProfileMode: profileMode,
    runtime_proof_profile_mode: profileMode,
    runtimeProofProfileSchemaVersion,
    runtime_proof_profile_schema_version: runtimeProofProfileSchemaVersion,
    runtimeProofProfileSchemaAccepted,
    runtime_proof_profile_schema_accepted: runtimeProofProfileSchemaAccepted,
    runtimeProofProfileSha256: profileRead.textSha256,
    runtime_proof_profile_sha256: profileRead.textSha256,
    runtimeProofProfileByteLength: profileRead.byteLength,
    runtime_proof_profile_byte_length: profileRead.byteLength,
    runtimeProofProfileReadError: profileRead.error,
    runtime_proof_profile_read_error: profileRead.error,
    runtimeProfileProofRunner: 'gpu-hmr-runtime-profile-proof.mjs',
    runtime_profile_proof_runner: 'gpu-hmr-runtime-profile-proof.mjs',
    runnerAttempted: Boolean(runnerResult),
    runner_attempted: Boolean(runnerResult),
    runnerExitCode: runnerResult?.exitCode ?? null,
    runner_exit_code: runnerResult?.exitCode ?? null,
    runnerTimedOut: runnerResult?.timedOut === true,
    runner_timed_out: runnerResult?.timedOut === true,
    runnerTimeoutMs: runnerResult?.timeoutMs ?? runnerTimeoutMs,
    runner_timeout_ms: runnerResult?.timeoutMs ?? runnerTimeoutMs,
    runnerStdoutSha256: runnerResult ? contentHash(runnerResult.stdout ?? '') : null,
    runner_stdout_sha256: runnerResult ? contentHash(runnerResult.stdout ?? '') : null,
    runnerStderrSha256: runnerResult ? contentHash(runnerResult.stderr ?? '') : null,
    runner_stderr_sha256: runnerResult ? contentHash(runnerResult.stderr ?? '') : null,
    runnerStdoutTail: runnerResult ? tail(runnerResult.stdout ?? '', 2000) : null,
    runner_stdout_tail: runnerResult ? tail(runnerResult.stdout ?? '', 2000) : null,
    runnerStderrTail: runnerResult ? tail(runnerResult.stderr ?? '', 2000) : null,
    runner_stderr_tail: runnerResult ? tail(runnerResult.stderr ?? '', 2000) : null,
    runtimeProfileAdapterResultPath: repoRelativePath(resultPath),
    runtime_profile_adapter_result_path: repoRelativePath(resultPath),
    runtimeProfileAdapterResultPresent: adapterResultRead.present,
    runtime_profile_adapter_result_present: adapterResultRead.present,
    runtimeProfileAdapterResultSha256: adapterResultRead.textSha256,
    runtime_profile_adapter_result_sha256: adapterResultRead.textSha256,
    runtimeProfileAdapterResultByteLength: adapterResultRead.byteLength,
    runtime_profile_adapter_result_byte_length: adapterResultRead.byteLength,
    runtimeProfileAdapterResultReadError: adapterResultRead.error,
    runtime_profile_adapter_result_read_error: adapterResultRead.error,
    runtimeBoundaryEventManifestPath,
    runtime_boundary_event_manifest_path: runtimeBoundaryEventManifestPath,
    runtimeBoundaryEventManifestSha256,
    runtime_boundary_event_manifest_sha256: runtimeBoundaryEventManifestSha256,
    runtimeBoundaryProofAdapterAccepted,
    runtime_boundary_proof_adapter_accepted: runtimeBoundaryProofAdapterAccepted,
    runtimeBoundaryProofAdapterProofId,
    runtime_boundary_proof_adapter_proof_id: runtimeBoundaryProofAdapterProofId,
    strictRuntimeProofAccepted,
    strict_runtime_proof_accepted: strictRuntimeProofAccepted,
    strictRuntimeProofId,
    strict_runtime_proof_id: strictRuntimeProofId,
    proofLedgerId,
    proof_ledger_id: proofLedgerId,
    adapterResultBlockingGaps: Array.isArray(adapterResult?.blockingGaps)
      ? adapterResult.blockingGaps
      : [],
    adapter_result_blocking_gaps: Array.isArray(adapterResult?.blocking_gaps)
      ? adapterResult.blocking_gaps
      : [],
    authorityClaims,
    authority_claims: authorityClaims,
    blockingGaps,
    blocking_gaps: blockingGaps,
    facetHash,
    facet_hash: facetHash,
  };
}

async function runSelectedCandidate(
  candidate,
  { dryRun, timeoutMs, runnerTimeoutMs, sourceIntake, sourceIntakeTimeoutMs },
) {
  if (dryRun) {
    return {
      candidateId: candidate.id,
      status: 'selected_not_executed_dry_run',
      backendFamily: candidate.backendFamily,
      backend_family: candidate.backendFamily,
      profileMode: candidate.profileMode,
      profile_mode: candidate.profileMode,
      runtimeProofProfilePath: candidate.runtimeProofProfileRelativePath,
      runtime_proof_profile_path: candidate.runtimeProofProfileRelativePath,
      runtimeProofProfileMode: candidate.runtimeProofProfileMode,
      runtime_proof_profile_mode: candidate.runtimeProofProfileMode,
      candidateSource: candidate.candidateSource,
      candidate_source: candidate.candidateSource,
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
      localRepoPath: candidate.localRepoPath,
      local_repo_path: candidate.localRepoPath,
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      directInputEvidence: candidate.directInputEvidence ?? null,
      direct_input_evidence: candidate.directInputEvidence ?? null,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    };
  }
  if (!candidate.profilePath || candidate.backendFamily !== 'real_rocm') {
    const sourceIntakeEvidence = sourceIntake === true
      ? await runUnprofiledSourceIntake(candidate, { sourceIntakeTimeoutMs })
      : null;
    const sourceTreeIntakeAccepted = sourceIntakeEvidence?.acceptedAsIntakeEvidence === true;
    const buildMetadataDiscoveryAccepted = sourceIntakeEvidence?.buildMetadataDiscoveryAccepted === true;
    const buildMetadataContentAccepted = sourceIntakeEvidence?.buildMetadataContentAccepted === true;
    const coldBuildExecutionPlanAccepted =
      sourceIntakeEvidence?.coldBuildExecutionPlanAccepted === true
      || sourceIntakeEvidence?.cold_build_execution_plan_accepted === true;
    const runtimeBoundaryExpectationAccepted =
      sourceIntakeEvidence?.runtimeBoundaryExpectationAccepted === true;
    const runtimeBoundaryEventManifestTemplateAccepted =
      sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplateAccepted === true;
    const evidenceCount = (...values) => {
      for (const value of values) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
      }
      return 0;
    };
    const sourceRelevantFileCount = evidenceCount(
      sourceIntakeEvidence?.sourceRelevantFileCount,
      sourceIntakeEvidence?.source_relevant_file_count,
    );
    const sourceOrBuildRelevantFileCount = evidenceCount(
      sourceIntakeEvidence?.sourceOrBuildRelevantFileCount,
      sourceIntakeEvidence?.source_or_build_relevant_file_count,
      sourceRelevantFileCount,
    );
    const gpuSourceFileCount = evidenceCount(
      sourceIntakeEvidence?.gpuSourceSignalCount,
      sourceIntakeEvidence?.gpu_source_signal_count,
    );
    const derivedRuntimeProfileContract = sourceIntakeEvidence
      ? await deriveRuntimeProofProfileFromColdIntake(candidate, sourceIntakeEvidence)
      : null;
    const derivedRuntimeProfileContractAccepted =
      derivedRuntimeProfileContract?.acceptedAsDerivedRuntimeProfileContract === true
      || derivedRuntimeProfileContract?.accepted_as_derived_runtime_profile_contract === true;
    const runtimeProfileProofBridge = await runRuntimeProfileProofBridge(candidate, {
      runnerTimeoutMs,
      runtimeProofProfilePath: derivedRuntimeProfileContractAccepted
        ? derivedRuntimeProfileContract.runtimeProofProfileResolvedPath
        : null,
      runtimeProofProfileRelativePath: derivedRuntimeProfileContractAccepted
        ? derivedRuntimeProfileContract.runtimeProofProfilePath
        : null,
      runtimeProofProfileMode: derivedRuntimeProfileContractAccepted
        ? derivedRuntimeProfileContract.runtimeProofProfileMode
        : null,
    });
    const runtimeProfileProofBridgeAccepted =
      runtimeProfileProofBridge?.acceptedAsRuntimeProfileProofBridge === true
      || runtimeProfileProofBridge?.accepted_as_runtime_profile_proof_bridge === true;
    const runtimeProfileBridgeStrictRuntimeProofAccepted =
      runtimeProfileProofBridge?.strictRuntimeProofAccepted === true
      || runtimeProfileProofBridge?.strict_runtime_proof_accepted === true;
    const derivedRuntimeProfileStrictRuntimeProofSuppressed =
      derivedRuntimeProfileContractAccepted
      && runtimeProfileBridgeStrictRuntimeProofAccepted;
    const runtimeProfileStrictRuntimeProofAccepted =
      runtimeProfileBridgeStrictRuntimeProofAccepted
      && !derivedRuntimeProfileContractAccepted;
    const runtimeSupportClosureObligation = deriveRuntimeSupportClosureObligation({
      candidate,
      runtimeBoundaryExpectation: sourceIntakeEvidence?.runtimeBoundaryExpectation
        ?? sourceIntakeEvidence?.runtime_boundary_expectation,
      runtimeProfileProofBridgeAccepted,
      runtimeProfileStrictRuntimeProofAccepted,
    });
    const runtimeAppHookMaterializationPlan = deriveAppHookMaterializationPlan({
      candidate,
      runtimeBoundaryExpectation: sourceIntakeEvidence?.runtimeBoundaryExpectation
        ?? sourceIntakeEvidence?.runtime_boundary_expectation,
      runtimeBoundaryEventManifestTemplate:
        sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate
        ?? sourceIntakeEvidence?.runtime_boundary_event_manifest_template,
      runtimeSupportClosureObligation,
      derivedRuntimeProfileContract,
      runtimeProfileProofBridge,
      sourceIntakeEvidence: sourceIntakeEvidence ?? {},
    });
    const runtimeBoundaryPlanBinding = sourceIntakeEvidence && firstString(
      runtimeProfileProofBridge?.runtimeBoundaryEventManifestSha256,
      runtimeProfileProofBridge?.runtime_boundary_event_manifest_sha256,
    )
      ? deriveRuntimeBoundaryPlanBinding({
        runtimeProfileProofBridge,
        runtimeAppHookMaterializationPlan,
        sourceIntakeEvidence,
      })
      : null;
    const runtimeSupportClosureGaps = uniqueSortedStrings([
      ...(Array.isArray(runtimeSupportClosureObligation.blockingGaps)
        ? runtimeSupportClosureObligation.blockingGaps
        : []),
      ...(Array.isArray(runtimeSupportClosureObligation.blocking_gaps)
        ? runtimeSupportClosureObligation.blocking_gaps
        : []),
    ]);
    const buildMetadataGap = buildMetadataContentAccepted
      ? 'semantic_build_metadata_execution_missing'
      : (buildMetadataDiscoveryAccepted
        ? 'semantic_build_metadata_verification_missing'
        : 'build_metadata_unverified');
    const buildExecutionPlanGaps = coldBuildExecutionPlanAccepted
      ? [
        'cold_build_execution_plan_support_only_not_runtime_proof',
        ...uniqueSortedStrings([
          ...(Array.isArray(sourceIntakeEvidence?.coldBuildExecutionPlan?.blockingGaps)
            ? sourceIntakeEvidence.coldBuildExecutionPlan.blockingGaps
            : []),
          ...(Array.isArray(sourceIntakeEvidence?.cold_build_execution_plan?.blocking_gaps)
            ? sourceIntakeEvidence.cold_build_execution_plan.blocking_gaps
            : []),
        ]),
      ]
      : ['cold_build_execution_plan_missing'];
    const runtimeProfileBridgeGaps = runtimeProfileProofBridge
      ? [
        ...(Array.isArray(runtimeProfileProofBridge.blockingGaps)
          ? runtimeProfileProofBridge.blockingGaps
          : []),
        ...(Array.isArray(runtimeProfileProofBridge.blocking_gaps)
          ? runtimeProfileProofBridge.blocking_gaps
          : []),
        derivedRuntimeProfileStrictRuntimeProofSuppressed
          ? 'derived_runtime_profile_contract_support_only_not_strict_runtime_authority'
          : null,
      ]
      : [];
    const missingRuntimeGaps = runtimeProfileStrictRuntimeProofAccepted
      ? ['cold_path_runtime_profile_proof_requires_matrix_ingestion']
      : [
        runtimeProfileProofBridgeAccepted ? null : 'runtime_profile_contract_missing',
        ...runtimeSupportClosureGaps,
        'same_process_loader_unproven',
        'epoch_publication_unproven',
        'dispatch_trace_unproven',
        'host_identity_unproven',
        'output_oracle_unproven',
        'strict_runtime_ledger_missing',
        ...runtimeProfileBridgeGaps,
      ];
    const blockingGaps = uniqueSortedStrings([
      buildMetadataGap,
      ...buildExecutionPlanGaps,
      ...missingRuntimeGaps,
    ]);
    if (!sourceTreeIntakeAccepted) {
      blockingGaps.unshift('source_tree_intake_missing');
    }
    if (
      derivedRuntimeProfileContract
      && derivedRuntimeProfileContractAccepted !== true
    ) {
      blockingGaps.push(...(derivedRuntimeProfileContract.blockingGaps ?? []));
    }
    if (candidate.backendFamily !== 'real_rocm' && !runtimeProfileProofBridge) {
      blockingGaps.unshift('local_backend_runner_unavailable');
    }
    const effectiveRuntimeProofProfilePath =
      runtimeProfileProofBridge?.runtimeProofProfilePath
      ?? runtimeProfileProofBridge?.runtime_proof_profile_path
      ?? derivedRuntimeProfileContract?.runtimeProofProfilePath
      ?? candidate.runtimeProofProfileRelativePath;
    const effectiveRuntimeProofProfileMode =
      runtimeProfileProofBridge?.runtimeProofProfileMode
      ?? runtimeProfileProofBridge?.runtime_proof_profile_mode
      ?? derivedRuntimeProfileContract?.runtimeProofProfileMode
      ?? candidate.runtimeProofProfileMode;
    return {
      candidateId: candidate.id,
      status: runtimeProfileProofBridge
        ? 'unprofiled_arbitrary_project_cold_intake_runtime_profile_bridged_refused'
        : 'unprofiled_arbitrary_project_cold_intake_refused',
      backendFamily: candidate.backendFamily,
      backend_family: candidate.backendFamily,
      profileMode: candidate.profileMode,
      profile_mode: candidate.profileMode,
      runtimeProofProfilePath: effectiveRuntimeProofProfilePath,
      runtime_proof_profile_path: effectiveRuntimeProofProfilePath,
      runtimeProofProfileMode: effectiveRuntimeProofProfileMode,
      runtime_proof_profile_mode: effectiveRuntimeProofProfileMode,
      candidateSource: candidate.candidateSource,
      candidate_source: candidate.candidateSource,
      directInputEvidence: candidate.directInputEvidence ?? null,
      direct_input_evidence: candidate.directInputEvidence ?? null,
      runnerAttempted: false,
      runner_attempted: false,
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
      localRepoPath: candidate.localRepoPath,
      local_repo_path: candidate.localRepoPath,
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      sourceRelevantFileCount,
      source_relevant_file_count: sourceRelevantFileCount,
      sourceOrBuildRelevantFileCount,
      source_or_build_relevant_file_count: sourceOrBuildRelevantFileCount,
      gpuSourceFileCount,
      gpu_source_file_count: gpuSourceFileCount,
      sourceTreeIntakeAccepted,
      source_tree_intake_accepted: sourceTreeIntakeAccepted,
      buildMetadataDiscoveryAccepted,
      build_metadata_discovery_accepted: buildMetadataDiscoveryAccepted,
      buildMetadataContentAccepted,
      build_metadata_content_accepted: buildMetadataContentAccepted,
      buildMetadataDiscovery: sourceIntakeEvidence?.buildMetadataDiscovery ?? null,
      build_metadata_discovery: sourceIntakeEvidence?.build_metadata_discovery ?? null,
      buildMetadataContentEvidence: sourceIntakeEvidence?.buildMetadataContentEvidence ?? null,
      build_metadata_content_evidence: sourceIntakeEvidence?.build_metadata_content_evidence ?? null,
      coldBuildExecutionPlan: sourceIntakeEvidence?.coldBuildExecutionPlan ?? null,
      cold_build_execution_plan: sourceIntakeEvidence?.cold_build_execution_plan ?? null,
      coldBuildExecutionPlanAccepted,
      cold_build_execution_plan_accepted: coldBuildExecutionPlanAccepted,
      runtimeBoundaryExpectationAccepted,
      runtime_boundary_expectation_accepted: runtimeBoundaryExpectationAccepted,
      runtimeBoundaryExpectation: sourceIntakeEvidence?.runtimeBoundaryExpectation ?? null,
      runtime_boundary_expectation: sourceIntakeEvidence?.runtime_boundary_expectation ?? null,
      runtimeBoundaryEventManifestTemplateAccepted,
      runtime_boundary_event_manifest_template_accepted: runtimeBoundaryEventManifestTemplateAccepted,
      runtimeBoundaryEventManifestTemplate:
        sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate ?? null,
      runtime_boundary_event_manifest_template:
        sourceIntakeEvidence?.runtime_boundary_event_manifest_template ?? null,
      runtimeSupportClosureObligation,
      runtime_support_closure_obligation: runtimeSupportClosureObligation,
      runtimeSupportClosureOutcome: runtimeSupportClosureObligation.outcome,
      runtime_support_closure_outcome: runtimeSupportClosureObligation.outcome,
      runtimeAppHookMaterializationPlan,
      runtime_app_hook_materialization_plan: runtimeAppHookMaterializationPlan,
      runtimeAppHookMaterializationPlanAccepted:
        runtimeAppHookMaterializationPlan.acceptedAsSupportEvidence === true,
      runtime_app_hook_materialization_plan_accepted:
        runtimeAppHookMaterializationPlan.acceptedAsSupportEvidence === true,
      runtimeBoundaryPlanBinding,
      runtime_boundary_plan_binding: runtimeBoundaryPlanBinding,
      runtimeBoundaryPlanBindingAccepted:
        runtimeBoundaryPlanBinding?.acceptedAsSupportEvidence === true,
      runtime_boundary_plan_binding_accepted:
        runtimeBoundaryPlanBinding?.acceptedAsSupportEvidence === true,
      derivedRuntimeProfileContract,
      derived_runtime_profile_contract: derivedRuntimeProfileContract,
      derivedRuntimeProfileContractAccepted,
      derived_runtime_profile_contract_accepted: derivedRuntimeProfileContractAccepted,
      runtimeProfileProofBridgeAccepted,
      runtime_profile_proof_bridge_accepted: runtimeProfileProofBridgeAccepted,
      runtimeProfileStrictRuntimeProofAccepted,
      runtime_profile_strict_runtime_proof_accepted: runtimeProfileStrictRuntimeProofAccepted,
      runtimeProfileBridgeStrictRuntimeProofAccepted,
      runtime_profile_bridge_strict_runtime_proof_accepted:
        runtimeProfileBridgeStrictRuntimeProofAccepted,
      derivedRuntimeProfileStrictRuntimeProofSuppressed,
      derived_runtime_profile_strict_runtime_proof_suppressed:
        derivedRuntimeProfileStrictRuntimeProofSuppressed,
      runtimeProfileProofBridge,
      runtime_profile_proof_bridge: runtimeProfileProofBridge,
      sourceIntakeEvidence,
      source_intake_evidence: sourceIntakeEvidence,
      blockingGaps,
      blocking_gaps: blockingGaps,
      unsupportedReasons: blockingGaps,
      unsupported_reasons: blockingGaps,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    };
  }
  const env = {
    ...process.env,
    SYNTHI_REAL_ROCM_PROFILE_PATH: candidate.profilePath,
    SYNTHI_VALIDATION_AUTHLESS_WORKSPACE: '1',
    SYNTHI_REAL_ROCM_COMPILE_TRANSPORT: 'workspace-ref',
    SYNTHI_REAL_ROCM_REQUIRE_FULL_RUNTIME_PROOF: '1',
    SYNTHI_REAL_ROCM_REQUIRE_ORIGINAL_HOST_PATH_PROOF: '1',
    SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER: '1',
    SYNTHI_REAL_ROCM_REUSE_WORKER_REPO: '0',
    SYNTHI_REAL_ROCM_CLEAN_BUILD: '1',
    SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_SOURCE: 'caller_env',
    SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS: String(timeoutMs),
  };
  const result = await runProcess(
    process.execPath,
    [path.join(SCRIPT_DIR, 'gpu-hmr-real-rocm-repo-validation.mjs')],
    { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: runnerTimeoutMs },
  );
  return {
    candidateId: candidate.id,
    status: result.timedOut
      ? 'runner_timeout_failed_closed'
      : (result.exitCode === 0 ? 'runner_completed' : 'runner_failed_closed_or_error'),
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    timedOut: result.timedOut,
    timed_out: result.timedOut,
    runnerTimeoutMs: result.timeoutMs,
    runner_timeout_ms: result.timeoutMs,
    timeoutKillAttempted: result.timeoutKillAttempted,
    timeout_kill_attempted: result.timeoutKillAttempted,
    childPid: result.childPid,
    child_pid: result.childPid,
    startedAt: result.startedAt,
    started_at: result.startedAt,
    finishedAt: result.finishedAt,
    finished_at: result.finishedAt,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  };
}

async function writeManifest(manifest, outputDir = LOG_DIR, { suffix = '', filePath = null } = {}) {
  await mkdir(outputDir, { recursive: true });
  const stamp = manifest.runId ?? manifest.run_id ?? makeStamp();
  const resolvedFilePath = filePath ?? path.join(outputDir, `random-large-project-cold-path-${stamp}${suffix}.json`);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolvedFilePath, body);
  return { filePath: resolvedFilePath, hash: contentHash(body) };
}

async function buildManifest({
  seed,
  count,
  candidateId,
  dryRun,
  timeoutMs,
  runnerTimeoutMs,
  sourceIntake,
  sourceIntakeTimeoutMs,
  candidates,
  outputDir,
  sourceMode = null,
  requireDirectSource = false,
  samplePool = false,
  runCandidate = runSelectedCandidate,
}) {
  const selected = selectCandidates({
    candidates,
    seed,
    count,
    candidateId,
    stratifyByClass: sourceMode === 'configured_sample_pool',
  });
  const runId = makeStamp();
  const startedAt = new Date().toISOString();
  let pendingWritten = null;
  if (!dryRun) {
    const pendingManifest = createManifest({
      runId,
      seed,
      count,
      candidateId,
      dryRun,
      timeoutMs,
      runnerTimeoutMs,
      sourceIntake,
      sourceIntakeTimeoutMs,
      candidates,
      selected,
      sourceMode,
      requireDirectSource,
      samplePool,
      startedAt,
      finishedAt: null,
      eventType: 'cold_path_pending',
      status: 'pending',
      results: selected.map((candidate) => ({
        candidateId: candidate.id,
        status: 'selected_pending_execution',
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
      })),
    });
    pendingWritten = await writeManifest(pendingManifest, outputDir, { suffix: '-pending' });
  }
  const results = [];
  for (const candidate of selected) {
    try {
      results.push(await runCandidate(candidate, {
        dryRun,
        timeoutMs,
        runnerTimeoutMs,
        sourceIntake,
        sourceIntakeTimeoutMs,
      }));
    } catch (error) {
      results.push({
        candidateId: candidate.id,
        status: 'sampler_candidate_error_failed_closed',
        error: error?.message || String(error),
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
      });
    }
  }
  const finishedAt = new Date().toISOString();
  const manifest = createManifest({
    runId,
    seed,
    count,
    candidateId,
    dryRun,
    timeoutMs,
    runnerTimeoutMs,
    sourceIntake,
    sourceIntakeTimeoutMs,
    candidates,
    selected,
    sourceMode,
    requireDirectSource,
    samplePool,
    startedAt,
    finishedAt,
    eventType: 'cold_path_complete',
    status: 'complete',
    results,
    pendingWritten,
  });
  const written = await writeManifest(manifest, outputDir);
  return { manifest: { ...manifest, manifestPath: written.filePath, manifestHash: written.hash }, written };
}

function createManifest({
  runId,
  seed,
  count,
  candidateId,
  dryRun,
  timeoutMs,
  runnerTimeoutMs,
  sourceIntake,
  sourceIntakeTimeoutMs,
  candidates,
  selected,
  sourceMode,
  requireDirectSource = false,
  samplePool = false,
  startedAt,
  finishedAt,
  eventType,
  status,
  results,
  pendingWritten = null,
}) {
  const selectionAlgorithms = uniqueSortedStrings(
    selected.map((candidate) => candidate.selectionAlgorithm ?? candidate.selection_algorithm),
  );
  const selectedBuckets = uniqueSortedStrings(
    selected.map((candidate) => candidate.selectionBucket ?? candidate.selection_bucket),
  );
  const selectionAlgorithm =
    selectionAlgorithms.length === 1
      ? selectionAlgorithms[0]
      : selectionAlgorithms.length > 1
        ? 'mixed_selection_algorithms'
        : IDENTITY_SORT_SELECTION_ALGORITHM;
  const selectionHash = contentHash(stableJson(selected.map((candidate) => ({
    id: candidate.id,
    key: candidate.selectionKey,
    bucket: candidate.selectionBucket ?? candidate.selection_bucket ?? null,
    algorithm: candidate.selectionAlgorithm ?? candidate.selection_algorithm ?? null,
  }))));
  const selectionAudit = coldPathSelectionAudit({
    seed,
    count,
    candidateId,
    dryRun,
    candidates,
    selected,
    results,
    sourceMode,
    requireDirectSource,
    samplePool,
  });
  return {
    schemaVersion: SCHEMA,
    schema_version: SCHEMA,
    proofAuthority: AUTHORITY,
    proof_authority: AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    runId,
    run_id: runId,
    eventType,
    event_type: eventType,
    status,
    startedAt,
    started_at: startedAt,
    finishedAt,
    finished_at: finishedAt,
    selection: {
      seed,
      requestedCount: Number(count) || 1,
      requested_count: Number(count) || 1,
      candidateId: candidateId || null,
      candidate_id: candidateId || null,
      candidateCount: candidates.length,
      candidate_count: candidates.length,
      selectedIds: selected.map((candidate) => candidate.id),
      selected_ids: selected.map((candidate) => candidate.id),
      selectedBuckets,
      selected_buckets: selectedBuckets,
      selectedBucketCount: selectedBuckets.length,
      selected_bucket_count: selectedBuckets.length,
      selectionAlgorithm,
      selection_algorithm: selectionAlgorithm,
      selectionAlgorithms,
      selection_algorithms: selectionAlgorithms,
      selectionHash,
      selection_hash: selectionHash,
    },
    selectionAudit,
    selection_audit: selectionAudit,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      backendFamily: candidate.backendFamily,
      backend_family: candidate.backendFamily,
      profileMode: candidate.profileMode,
      profile_mode: candidate.profileMode,
      runtimeProofProfilePath: candidate.runtimeProofProfileRelativePath,
      runtime_proof_profile_path: candidate.runtimeProofProfileRelativePath,
      runtimeProofProfileMode: candidate.runtimeProofProfileMode,
      runtime_proof_profile_mode: candidate.runtimeProofProfileMode,
      candidateSource: candidate.candidateSource,
      candidate_source: candidate.candidateSource,
      directInputEvidence: candidate.directInputEvidence,
      direct_input_evidence: candidate.directInputEvidence,
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
      localRepoPath: candidate.localRepoPath,
      local_repo_path: candidate.localRepoPath,
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      sizeSignals: candidate.sizeSignals,
      size_signals: candidate.sizeSignals,
      buildSystemHints: candidate.buildSystemHints,
      build_system_hints: candidate.buildSystemHints,
      runtimeBoundaryHints: candidate.runtimeBoundaryHints,
      runtime_boundary_hints: candidate.runtimeBoundaryHints,
      oracleHints: candidate.oracleHints,
      oracle_hints: candidate.oracleHints,
    })),
    selectedCandidates: selected.map((candidate) => ({
      id: candidate.id,
      backendFamily: candidate.backendFamily,
      backend_family: candidate.backendFamily,
      profilePath: candidate.profilePath,
      profile_path: candidate.profilePath,
      profileMode: candidate.profileMode,
      profile_mode: candidate.profileMode,
      runtimeProofProfilePath: candidate.runtimeProofProfileRelativePath,
      runtime_proof_profile_path: candidate.runtimeProofProfileRelativePath,
      runtimeProofProfileMode: candidate.runtimeProofProfileMode,
      runtime_proof_profile_mode: candidate.runtimeProofProfileMode,
      candidateSource: candidate.candidateSource,
      candidate_source: candidate.candidateSource,
      directInputEvidence: candidate.directInputEvidence,
      direct_input_evidence: candidate.directInputEvidence,
      sourceUrl: candidate.sourceUrl,
      source_url: candidate.sourceUrl,
      localRepoPath: candidate.localRepoPath,
      local_repo_path: candidate.localRepoPath,
      immutableCommit: candidate.immutableCommit,
      immutable_commit: candidate.immutableCommit,
      selectionRank: candidate.selectionRank,
      selection_rank: candidate.selectionRank,
      selectionKey: candidate.selectionKey,
      selection_key: candidate.selectionKey,
      selectionBucket: candidate.selectionBucket,
      selection_bucket: candidate.selectionBucket,
      selectionAlgorithm: candidate.selectionAlgorithm,
      selection_algorithm: candidate.selectionAlgorithm,
      selectionFacets: candidate.selectionFacets,
      selection_facets: candidate.selectionFacets,
      sizeSignals: candidate.sizeSignals,
      size_signals: candidate.sizeSignals,
      buildSystemHints: candidate.buildSystemHints,
      build_system_hints: candidate.buildSystemHints,
      runtimeBoundaryHints: candidate.runtimeBoundaryHints,
      runtime_boundary_hints: candidate.runtimeBoundaryHints,
      oracleHints: candidate.oracleHints,
      oracle_hints: candidate.oracleHints,
    })),
    dryRun,
    dry_run: dryRun,
    timeoutMs,
    timeout_ms: timeoutMs,
    runnerTimeoutMs,
    runner_timeout_ms: runnerTimeoutMs,
    sourceIntake,
    source_intake: sourceIntake,
    sourceIntakeTimeoutMs,
    source_intake_timeout_ms: sourceIntakeTimeoutMs,
    pendingManifestPath: pendingWritten?.filePath ?? null,
    pending_manifest_path: pendingWritten?.filePath ?? null,
    pendingManifestHash: pendingWritten?.hash ?? null,
    pending_manifest_hash: pendingWritten?.hash ?? null,
    results,
  };
}

async function selfCheck() {
  const defaultCandidates = await loadCandidates();
  const defaultUnprofiledCandidates = defaultCandidates.filter(
    (candidate) => candidate.profileMode === 'unprofiled_arbitrary_project_cold_intake',
  );
  if (
    defaultCandidates.length < 6
    || defaultUnprofiledCandidates.length < 3
    || !defaultUnprofiledCandidates.every((candidate) => candidate.profilePath === null)
  ) {
    throw new Error('random large-project cold-path default pool must include unprofiled arbitrary project intake candidates');
  }
  const candidates = [
    cleanCandidate({
      id: 'alpha-large',
      backendFamily: 'real_rocm',
      profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-saxpy.json'),
      sourceUrl: 'https://example.invalid/alpha.git',
      immutableCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    cleanCandidate({
      id: 'beta-large',
      backendFamily: 'real_rocm',
      profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-saxpy.json'),
      sourceUrl: 'https://example.invalid/beta.git',
      immutableCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
    cleanCandidate({
      id: 'gamma-large',
      backendFamily: 'real_rocm',
      profilePath: path.join(SCRIPT_DIR, 'profiles', 'real-rocm-saxpy.json'),
      sourceUrl: 'https://example.invalid/gamma.git',
      immutableCommit: 'cccccccccccccccccccccccccccccccccccccccc',
    }),
    cleanCandidate({
      id: 'delta-unprofiled-large',
      sourceUrl: 'https://example.invalid/delta.git',
      immutableCommit: 'dddddddddddddddddddddddddddddddddddddddd',
      sizeSignals: {
        class: 'large_unknown_gpu_project',
        coldPathKind: 'unprofiled_arbitrary_project',
      },
      buildSystemHints: {
        observedFiles: ['CMakeLists.txt'],
      },
    }),
  ];
  const first = selectCandidates({ candidates, seed: 'self-check-seed', count: 2 });
  const second = selectCandidates({ candidates, seed: 'self-check-seed', count: 2 });
  if (stableJson(first) !== stableJson(second) || first.length !== 2) {
    throw new Error('random large-project cold-path selection is not deterministic');
  }
  if (
    first.some((candidate) =>
      candidate.selectionAlgorithm !== IDENTITY_SORT_SELECTION_ALGORITHM
      || candidate.selectionBucket !== 'identity_sort'
    )
  ) {
    throw new Error('random large-project cold-path direct identity selection changed unexpectedly');
  }
  const stratifiedDefault = selectCandidates({
    candidates: defaultCandidates,
    seed: 'stratified-default-self-check-seed',
    count: DEFAULT_CONFIGURED_SAMPLE_POOL_COUNT,
    stratifyByClass: true,
  });
  const stratifiedDefaultBuckets = uniqueSortedStrings(
    stratifiedDefault.map((candidate) => candidate.selectionBucket),
  );
  const stratifiedDefaultAudit = coldPathSelectionAudit({
    seed: 'stratified-default-self-check-seed',
    count: DEFAULT_CONFIGURED_SAMPLE_POOL_COUNT,
    dryRun: true,
    candidates: defaultCandidates,
    selected: stratifiedDefault,
    results: stratifiedDefault.map((candidate) => ({ candidateId: candidate.id })),
    sourceMode: 'configured_sample_pool',
    samplePool: true,
  });
  if (
    stratifiedDefault.length !== DEFAULT_CONFIGURED_SAMPLE_POOL_COUNT
    || !CONFIGURED_SAMPLE_POOL_REQUIRED_BUCKETS.every((bucket) =>
      stratifiedDefaultBuckets.includes(bucket))
    || stratifiedDefault.some((candidate) =>
      candidate.selectionAlgorithm !== CLASS_BUCKET_SELECTION_ALGORITHM
      || !candidate.selectionFacets
      || candidate.acceptedForGpuHmr === true
      || candidate.gpuHmrSuccess === true
      || candidate.canSatisfyRuntimeProof === true
    )
    || stratifiedDefaultAudit.accepted !== true
    || stratifiedDefaultAudit.deterministicSelectionAlgorithm !== CLASS_BUCKET_SELECTION_ALGORITHM
    || stratifiedDefaultAudit.samplePoolCoverageContract?.schemaVersion
      !== SAMPLE_POOL_COVERAGE_CONTRACT_SCHEMA
    || stratifiedDefaultAudit.samplePoolCoverageContract?.proofAuthority
      !== SAMPLE_POOL_COVERAGE_CONTRACT_AUTHORITY
    || stratifiedDefaultAudit.samplePoolCoverageContract?.requiredBucketCoverageSatisfied !== true
    || stratifiedDefaultAudit.samplePoolCoverageContract?.acceptedForGpuHmr !== false
    || stratifiedDefaultAudit.samplePoolCoverageContract?.gpuHmrSuccess !== false
    || stratifiedDefaultAudit.samplePoolCoverageContract?.canSatisfyRuntimeProof !== false
    || stratifiedDefaultAudit.samplePoolCoverageContract?.projectNameWhitelist?.length !== 0
    || stratifiedDefaultAudit.samplePoolCoverageContract?.specificTargetIdsAllowed?.length !== 0
    || !stratifiedDefaultAudit.selectedFacetSummary?.runtimeBoundaryStages?.includes('output_oracle')
    || !stratifiedDefaultAudit.selectedFacetSummary?.oracleKinds?.some((kind) =>
      kind.includes('readback') || kind.includes('visual'))
  ) {
    throw new Error('random large-project cold-path configured sample-pool stratified coverage self-check failed');
  }
  const narrowStratifiedAudit = coldPathSelectionAudit({
    seed: 'narrow-stratified-self-check-seed',
    count: 2,
    dryRun: true,
    candidates: defaultCandidates,
    selected: stratifiedDefault.slice(0, 2),
    results: stratifiedDefault.slice(0, 2).map((candidate) => ({ candidateId: candidate.id })),
    sourceMode: 'configured_sample_pool',
    samplePool: true,
  });
  if (
    narrowStratifiedAudit.accepted !== true
    || narrowStratifiedAudit.samplePoolCoverageContract?.coverageLimitedByRequestedCount !== true
    || narrowStratifiedAudit.samplePoolCoverageContract?.coverageEnforced !== false
    || narrowStratifiedAudit.samplePoolCoverageContract?.coverageAcceptableForRequestedCount !== true
  ) {
    throw new Error('random large-project cold-path narrow sample-pool coverage accounting failed');
  }
  const unprofiledRocmMlCandidates = DEFAULT_CANDIDATES.filter((candidate) =>
    String(candidate.id ?? '').startsWith('unprofiled-rocm-')
  );
  if (
    unprofiledRocmMlCandidates.length < 7
    || unprofiledRocmMlCandidates.some((candidate) =>
      candidate.profilePath
      || candidate.profile_path
      || candidate.runtimeProofProfilePath
      || candidate.runtime_proof_profile_path
      || candidate.oracleHints?.acceptedByDeclaration !== false
      || !/^[0-9a-f]{40}$/i.test(String(candidate.immutableCommit ?? ''))
      || !Array.isArray(candidate.runtimeBoundaryHints?.required)
      || !candidate.runtimeBoundaryHints.required.includes('output_oracle')
    )
  ) {
    throw new Error('random large-project cold-path ROCm/ML sample-pool candidates must stay unprofiled diagnostic exact-commit inputs');
  }
  if (
    parseArgs(['--require-direct-source']).requireDirectSource !== true
    || parseArgs(['--sample-pool']).samplePool !== true
    || parseArgs([
      '--require-direct-source',
      'https://example.invalid/direct.git',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'direct-positional-project',
      'unknown_gpu_project',
    ]).sourceUrl !== 'https://example.invalid/direct.git'
    || parseArgs([
      '--require-direct-source',
      'https://example.invalid/direct.git',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'direct-positional-project',
      'unknown_gpu_project',
    ]).immutableCommit !== 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    || parseArgs([
      '--require-direct-source',
      'C:/tmp/direct-local-project',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]).repoPath !== 'C:/tmp/direct-local-project'
    || directSourceRequired(
      { requireDirectSource: true },
      { SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SAMPLE_POOL: '1' },
    ) !== false
  ) {
    throw new Error('random large-project cold-path direct/sample-pool mode parsing failed');
  }
  if (
    defaultColdPathSelectionCount({ samplePool: true }) !== DEFAULT_CONFIGURED_SAMPLE_POOL_COUNT
    || defaultColdPathSelectionCount({ samplePool: false }) !== 1
    || defaultColdPathSelectionCount({ directCandidate: candidates[0], samplePool: true }) !== 1
    || defaultColdPathSelectionCount({
      directCandidates: candidates.slice(0, 3),
      samplePool: false,
    }) !== 3
  ) {
    throw new Error('random large-project cold-path default selection count self-check failed');
  }
  let configuredPoolRejected = false;
  try {
    assertConfiguredSamplePoolExplicit({
      useConfiguredCandidatePool: true,
      samplePool: false,
    });
  } catch {
    configuredPoolRejected = true;
  }
  if (
    configuredPoolRejected !== true
    || assertConfiguredSamplePoolExplicit({
      useConfiguredCandidatePool: true,
      samplePool: true,
    }) !== undefined
    || assertConfiguredSamplePoolExplicit({
      useConfiguredCandidatePool: false,
      samplePool: false,
    }) !== undefined
  ) {
    throw new Error('random large-project cold-path configured sample-pool CLI guard failed');
  }
  const rankedBuildFiles = selectBuildFilesForContent({
    files: [
      { path: 'third_party/CMakeLists.txt', object: 'vendored-cmake', byteLength: 10 },
      { path: 'third_party/dep/BUILD.gn', object: 'vendored-gn', byteLength: 10 },
      { path: 'tools/BUILD.gn', object: 'tools-gn', byteLength: 10 },
      { path: 'CMakeLists.txt', object: 'root-cmake', byteLength: 10 },
      { path: 'src/render/BUILD.gn', object: 'render-gn', byteLength: 10 },
      { path: 'external/lib/BUILD.bazel', object: 'external-bazel', byteLength: 10 },
    ],
    classification: {
      buildSignals: [
        'third_party/CMakeLists.txt',
        'third_party/dep/BUILD.gn',
        'tools/BUILD.gn',
        'CMakeLists.txt',
        'src/render/BUILD.gn',
        'external/lib/BUILD.bazel',
      ],
    },
    maxFiles: 3,
  }).map((file) => file.path);
  if (
    rankedBuildFiles[0] !== 'CMakeLists.txt'
    || !rankedBuildFiles.includes('tools/BUILD.gn')
    || !rankedBuildFiles.includes('src/render/BUILD.gn')
    || rankedBuildFiles.some((pathName) =>
      String(pathName).includes('third_party/') || String(pathName).includes('external/')
    )
  ) {
    throw new Error('random large-project cold-path build metadata content ranking self-check failed');
  }
  const implicitSamplePoolAudit = coldPathSelectionAudit({
    seed: 'implicit-sample-pool-self-check',
    count: 1,
    dryRun: true,
    candidates,
    selected: [first[0]],
    results: [{ candidateId: first[0].id }],
    sourceMode: 'configured_candidate_pool',
    samplePool: false,
  });
  const explicitSamplePoolAudit = coldPathSelectionAudit({
    seed: 'explicit-sample-pool-self-check',
    count: 1,
    dryRun: true,
    candidates,
    selected: [first[0]],
    results: [{ candidateId: first[0].id }],
    sourceMode: 'configured_sample_pool',
    samplePool: true,
  });
  if (
    implicitSamplePoolAudit.accepted !== false
    || !implicitSamplePoolAudit.blockingGaps?.includes(
      'cold_path_sample_pool_mode_not_explicitly_requested',
    )
    || explicitSamplePoolAudit.accepted !== true
    || explicitSamplePoolAudit.blockingGaps?.length !== 0
  ) {
    throw new Error('random large-project cold-path sample-pool explicitness self-check failed');
  }
  if (
    bloblessGitTreeSizeListingEnabled({}) !== false
    || bloblessGitTreeSizeListingEnabled({ SYNTHI_GPU_HMR_BLOBLESS_TREE_SIZE_LISTING: '1' }) !== true
    || bloblessGitTreeSizeListingEnabled({ SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH: '1' }) !== false
    || bloblessBuildMetadataContentFetchEnabled({}) !== false
    || bloblessBuildMetadataContentFetchEnabled({ SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH: '1' }) !== true
    || bloblessBuildMetadataContentFetchEnabled({ SYNTHI_GPU_HMR_BLOBLESS_TREE_SIZE_LISTING: '1' }) !== true
    || fullGitSourceTreeFallbackEnabled({}) !== false
    || fullGitSourceTreeFallbackEnabled({ SYNTHI_GPU_HMR_UNPROFILED_FULL_GIT_FALLBACK: '1' }) !== true
    || fullGitSourceTreeFallbackEnabled({ SYNTHI_GPU_HMR_UNPROFILED_GIT_FALLBACK: '1' }) !== false
  ) {
    throw new Error('random large-project cold-path blobless fetch opt-in separation failed');
  }
  const unauthenticatedGitHubApi = githubApiHeaders({});
  const authenticatedGitHubApi = githubApiHeaders({ GH_TOKEN: 'self-check-secret-token' });
  if (
    unauthenticatedGitHubApi.headers.Authorization
    || unauthenticatedGitHubApi.authEvidence.tokenPresent !== false
    || authenticatedGitHubApi.headers.Authorization !== 'Bearer self-check-secret-token'
    || authenticatedGitHubApi.authEvidence.tokenPresent !== true
    || authenticatedGitHubApi.authEvidence.tokenSource !== 'GH_TOKEN'
    || stableJson(authenticatedGitHubApi.authEvidence).includes('self-check-secret-token')
    || authenticatedGitHubApi.authEvidence.acceptedForGpuHmr !== false
    || authenticatedGitHubApi.authEvidence.gpuHmrSuccess !== false
    || authenticatedGitHubApi.authEvidence.canSatisfyRuntimeProof !== false
  ) {
    throw new Error('random large-project cold-path GitHub API auth evidence self-check failed');
  }
  let rejectedMissingDirectSource = false;
  try {
    assertDirectSourceRequirement({ requireDirectSource: true, directCandidate: null });
  } catch {
    rejectedMissingDirectSource = true;
  }
  if (!rejectedMissingDirectSource) {
    throw new Error('random large-project cold-path direct-source requirement accepted sample-pool input');
  }
  const { manifest: multiResultManifest } = await buildManifest({
    seed: 'multi-result-self-check-seed',
    count: 3,
    dryRun: true,
    timeoutMs: 1,
    runnerTimeoutMs: 1,
    sourceIntake: false,
    sourceIntakeTimeoutMs: 1,
    candidates,
    sourceMode: 'configured_sample_pool',
    samplePool: true,
    outputDir: path.join(LOG_DIR, 'self-check'),
    runCandidate: async (candidate) => ({
      candidateId: candidate.id,
      status: 'selected_not_executed_dry_run',
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    }),
  });
  const multiResultSelectedIds = Array.isArray(multiResultManifest.selection?.selectedIds)
    ? multiResultManifest.selection.selectedIds
    : [];
  const multiResultIds = Array.isArray(multiResultManifest.results)
    ? multiResultManifest.results.map((result) => result.candidateId)
    : [];
  if (
    multiResultSelectedIds.length !== 3
    || multiResultIds.length !== multiResultSelectedIds.length
    || stableJson([...multiResultIds].sort()) !== stableJson([...multiResultSelectedIds].sort())
    || multiResultManifest.selectionAudit?.schemaVersion !== SELECTION_AUDIT_SCHEMA
    || multiResultManifest.selectionAudit?.proofAuthority !== SELECTION_AUDIT_AUTHORITY
    || multiResultManifest.selectionAudit?.accepted !== true
    || multiResultManifest.selectionAudit?.acceptedForGpuHmr !== false
    || multiResultManifest.selectionAudit?.gpuHmrSuccess !== false
    || multiResultManifest.selectionAudit?.canSatisfyRuntimeProof !== false
    || multiResultManifest.selectionAudit?.targetNameIndependent !== true
    || multiResultManifest.selectionAudit?.projectNameWhitelist?.length !== 0
    || multiResultManifest.selectionAudit?.specificTargetIdsAllowed?.length !== 0
    || multiResultManifest.selectionAudit?.selectedResultsMatch !== true
    || multiResultManifest.selection?.selectionAlgorithm !== CLASS_BUCKET_SELECTION_ALGORITHM
    || multiResultManifest.selectionAudit?.samplePoolCoverageContract?.proofAuthority
      !== SAMPLE_POOL_COVERAGE_CONTRACT_AUTHORITY
    || multiResultManifest.selectionAudit?.samplePoolCoverageContract?.acceptedForGpuHmr !== false
    || multiResultManifest.selectionAudit?.samplePoolCoverageContract?.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path multi-result manifest did not preserve one result per selected candidate');
  }
  let rejectedMissingCommit = false;
  try {
    cleanCandidate({
      id: 'bad',
      backendFamily: 'real_rocm',
      profilePath: 'profile.json',
      sourceUrl: 'https://example.invalid/bad.git',
      immutableCommit: '',
    });
  } catch {
    rejectedMissingCommit = true;
  }
  if (!rejectedMissingCommit) {
    throw new Error('random large-project cold-path candidate validation accepted missing commit');
  }
  let rejectedUnsafeBackend = false;
  try {
    cleanCandidate({
      id: 'bad-backend',
      backendFamily: '../real_rocm',
      sourceUrl: 'https://example.invalid/bad-backend.git',
      immutableCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
  } catch {
    rejectedUnsafeBackend = true;
  }
  if (!rejectedUnsafeBackend) {
    throw new Error('random large-project cold-path candidate validation accepted unsafe backend');
  }
  const unprofiled = cleanCandidate({
    id: 'plain-arbitrary-large',
    sourceUrl: 'https://example.invalid/plain.git',
    immutableCommit: 'ffffffffffffffffffffffffffffffffffffffff',
  });
  if (
    unprofiled.profilePath !== null
    || unprofiled.backendFamily !== 'unknown_gpu_project'
    || unprofiled.profileMode !== 'unprofiled_arbitrary_project_cold_intake'
  ) {
    throw new Error('random large-project cold-path unprofiled normalization failed');
  }
  const directCandidate = directCandidateFromInput({
    sourceUrl: 'https://example.invalid/user/project.git',
    immutableCommit: '1111111111111111111111111111111111111111',
    sourceId: 'user-supplied-project',
    inputChannels: ['cli_arg_source_url', 'cli_arg_commit', 'cli_arg_source_id'],
  });
  if (
    directCandidate.id !== 'user-supplied-project'
    || directCandidate.profilePath !== null
    || directCandidate.candidateSource !== 'direct_source_url_commit'
    || directCandidate.sizeSignals?.coldPathKind !== 'direct_source_url_commit_cold_intake'
    || directCandidate.directInputEvidence?.acceptedAsDirectInputEvidence !== true
    || directCandidate.directInputEvidence?.proofAuthority !== DIRECT_SOURCE_INPUT_AUTHORITY
    || directCandidate.directInputEvidence?.targetNameIndependent !== true
    || directCandidate.directInputEvidence?.projectNameWhitelist?.length !== 0
    || directCandidate.directInputEvidence?.specificTargetIdsAllowed?.length !== 0
    || !/^sha256:[a-f0-9]{64}$/i.test(directCandidate.directInputEvidence?.sourceIdentityHash ?? '')
    || directCandidate.directInputEvidence?.evidenceHash
      !== directCandidate.directInputEvidence?.sourceIdentityHash
    || directCandidate.oracleHints?.acceptedByDeclaration !== false
  ) {
    throw new Error('random large-project cold-path direct source input normalization failed');
  }
  const directBatchCandidates = await loadDirectCandidates({
    candidatesJson: JSON.stringify([
      {
        id: 'direct-batch-project-a',
        sourceUrl: 'https://example.invalid/direct-batch-a.git',
        immutableCommit: '2222222222222222222222222222222222222222',
        backendFamily: 'unknown_gpu_project',
      },
      {
        id: 'direct-batch-project-b',
        sourceUrl: 'https://example.invalid/direct-batch-b.git',
        immutableCommit: '3333333333333333333333333333333333333333',
        backendFamily: 'unknown_gpu_project',
      },
    ]),
  });
  const { manifest: directBatchManifest } = await buildManifest({
    seed: 'direct-batch-self-check-seed',
    count: 2,
    dryRun: true,
    timeoutMs: 1,
    runnerTimeoutMs: 1,
    sourceIntake: false,
    sourceIntakeTimeoutMs: 1,
    candidates: directBatchCandidates,
    outputDir: path.join(LOG_DIR, 'self-check'),
    sourceMode: 'direct_user_source_batch',
  });
  if (
    directBatchCandidates.length !== 2
    || directBatchManifest.selection.selectedIds.length !== 2
    || directBatchManifest.results.length !== 2
    || directBatchManifest.selectionAudit?.sourceMode !== 'direct_user_source_batch'
    || directBatchManifest.selectionAudit?.directUserSourceCount !== 2
    || directBatchManifest.selectionAudit?.configuredPoolCount !== 0
    || directBatchManifest.selectionAudit?.acceptedForGpuHmr !== false
    || directBatchManifest.selectionAudit?.gpuHmrSuccess !== false
    || directBatchManifest.candidates.some((candidate) =>
      candidate.candidateSource !== 'direct_source_url_commit'
      || candidate.directInputEvidence?.acceptedAsDirectInputEvidence !== true
      || !candidate.directInputEvidence?.inputChannels?.includes('cli_arg_direct_candidates')
      || candidate.directInputEvidence?.targetNameIndependent !== true
      || candidate.directInputEvidence?.projectNameWhitelist?.length !== 0
      || candidate.directInputEvidence?.specificTargetIdsAllowed?.length !== 0
      || !/^sha256:[a-f0-9]{64}$/i.test(candidate.directInputEvidence?.sourceIdentityHash ?? '')
      || candidate.directInputEvidence?.evidenceHash
        !== candidate.directInputEvidence?.sourceIdentityHash
      || candidate.acceptedForGpuHmr === true
      || candidate.gpuHmrSuccess === true
    )
  ) {
    throw new Error('random large-project cold-path direct candidate batch self-check failed');
  }
  const runtimeBridgeProfile = path.join(
    'mcp/synthi-mcp/.gpu-hmr-test-logs/random-large-project-cold-path/self-check-runtime-profile.json',
  );
  const runtimeBridgeProfilePath = path.resolve(REPO_ROOT, runtimeBridgeProfile);
  await mkdir(path.dirname(runtimeBridgeProfilePath), { recursive: true });
  await writeFile(runtimeBridgeProfilePath, `${JSON.stringify({
    schemaVersion: 'synthi.gpu.hmr.runtime_profile.v1',
    id: 'random-cold-runtime-bridge-self-check',
    adapter: {
      family: 'random-cold-runtime-bridge-self-check',
      proofRunner: 'profile-runner',
      runnerKind: 'node-script',
      runnerPath: 'mcp/synthi-mcp/scripts/fixtures/runtime-profile-external-adapter-smoke.mjs',
    },
    runtime: {
      targetName: 'generic-target',
      requiredKernels: ['generic_kernel'],
      reload: {
        kernelName: 'generic_kernel',
        kernelSymbol: 'generic_kernel',
      },
    },
    source: {
      file: 'src/generic_device.hip',
      before: 'return 1;',
      after: 'return 2;',
    },
  }, null, 2)}\n`);
  const runtimeBridgeCandidate = cleanCandidate({
    id: 'direct-runtime-bridge-large',
    backendFamily: 'unknown_gpu_project',
    runtimeProofProfilePath: runtimeBridgeProfile,
    sourceUrl: 'https://example.invalid/direct-runtime-bridge.git',
    immutableCommit: '8888888888888888888888888888888888888888',
  });
  const runtimeBridgeFacet = await runRuntimeProfileProofBridge(runtimeBridgeCandidate, {
    runnerTimeoutMs: 60000,
  });
  if (
    runtimeBridgeCandidate.runtimeProofProfileRelativePath !== runtimeBridgeProfile.replace(/\\/g, '/')
    || runtimeBridgeFacet?.schemaVersion !== RUNTIME_PROFILE_PROOF_BRIDGE_SCHEMA
    || runtimeBridgeFacet?.proofAuthority !== RUNTIME_PROFILE_PROOF_BRIDGE_AUTHORITY
    || runtimeBridgeFacet?.acceptedForGpuHmr !== false
    || runtimeBridgeFacet?.gpuHmrSuccess !== false
    || runtimeBridgeFacet?.canSatisfyRuntimeProof !== false
    || runtimeBridgeFacet?.runtimeProofProfileSchemaAccepted !== true
    || runtimeBridgeFacet?.acceptedAsRuntimeProfileProofBridge !== true
    || runtimeBridgeFacet?.strictRuntimeProofAccepted !== false
    || !runtimeBridgeFacet?.blockingGaps?.includes('runtime_profile_adapter_strict_runtime_proof_not_accepted')
    || !runtimeBridgeFacet?.adapterResultBlockingGaps?.includes('runtime_profile_adapter_proof_path_missing')
  ) {
    throw new Error('random large-project cold-path runtime profile bridge self-check failed');
  }
  const unsupportedRuntimeBridgeProfile = path.join(
    'mcp/synthi-mcp/.gpu-hmr-test-logs/random-large-project-cold-path/self-check-real-rocm-profile.json',
  );
  const unsupportedRuntimeBridgeProfilePath = path.resolve(REPO_ROOT, unsupportedRuntimeBridgeProfile);
  await writeFile(unsupportedRuntimeBridgeProfilePath, `${JSON.stringify({
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    id: 'random-cold-runtime-bridge-unsupported-schema',
    target: { targetName: 'generic-target' },
  }, null, 2)}\n`);
  const unsupportedRuntimeBridgeCandidate = cleanCandidate({
    id: 'direct-runtime-bridge-unsupported-schema',
    backendFamily: 'unknown_gpu_project',
    runtimeProofProfilePath: unsupportedRuntimeBridgeProfile,
    sourceUrl: 'https://example.invalid/direct-runtime-bridge-unsupported.git',
    immutableCommit: '8989898989898989898989898989898989898989',
  });
  const unsupportedRuntimeBridgeFacet = await runRuntimeProfileProofBridge(
    unsupportedRuntimeBridgeCandidate,
    { runnerTimeoutMs: 60000 },
  );
  if (
    unsupportedRuntimeBridgeFacet?.acceptedAsRuntimeProfileProofBridge !== false
    || unsupportedRuntimeBridgeFacet?.runtimeProofProfileSchemaAccepted !== false
    || unsupportedRuntimeBridgeFacet?.runtimeProofProfileSchemaVersion !== 'synthi.gpu.hmr.real_rocm_profile.v1'
    || unsupportedRuntimeBridgeFacet?.runnerAttempted !== false
    || unsupportedRuntimeBridgeFacet?.acceptedForGpuHmr !== false
    || unsupportedRuntimeBridgeFacet?.gpuHmrSuccess !== false
    || !unsupportedRuntimeBridgeFacet?.blockingGaps?.includes('runtime_profile_schema_unsupported_for_bridge')
    || unsupportedRuntimeBridgeFacet?.blockingGaps?.includes('runtime_profile_proof_runner_failed')
  ) {
    throw new Error('random large-project cold-path unsupported runtime profile bridge self-check failed');
  }
  const runtimeBoundaryBridgeDir = path.join(
    LOG_DIR,
    'self-check-runtime-boundary-profile',
    String(Date.now()),
  );
  await mkdir(runtimeBoundaryBridgeDir, { recursive: true });
  const runtimeHashA = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const runtimeHashB = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const runtimeHashC = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const runtimeHashD = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  const runtimeHashE = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const genericBoundaryEvents = [
    {
      kind: 'artifact_transport',
      eventId: 'load-1',
      artifactHash: runtimeHashB,
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      timestampMonotonicNs: 100,
      evidenceRefs: ['runtime-boundary:artifact-transport'],
    },
    {
      kind: 'epoch_publication',
      eventId: 'publish-1',
      artifactHash: runtimeHashB,
      epoch: 'epoch-7',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      timestampMonotonicNs: 200,
      dispatchTableHashBefore: runtimeHashD,
      dispatchTableHashAfter: runtimeHashE,
      evidenceRefs: ['runtime-boundary:epoch-publication'],
    },
    {
      kind: 'synthi_gpu_launch',
      eventId: 'dispatch-1',
      artifactHash: runtimeHashB,
      epoch: 'epoch-7',
      dispatchId: 'dispatch-1',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      stream: 'stream-1',
      dispatchTableEntry: 'generic_kernel:epoch-7',
      timestampMonotonicNs: 300,
      evidenceRefs: [
        'worker-log:synthi_gpu_launch:runtime-session-1:dispatch-1',
        'worker-log:launch_arg_provenance:runtime-session-1:dispatch-1:output',
      ],
    },
    {
      kind: 'host_identity',
      eventId: 'host-1',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      deviceUuid: 'device-1',
      contextId: 'ctx-1',
      stream: 'stream-1',
      timestampMonotonicNs: 310,
      evidenceRefs: [
        'worker-log:host_identity:runner_process',
        'worker-log:host_identity:host_state',
        'worker-log:host_identity:stream_context',
        'worker-log:host_identity_snapshot:runtime-session-1:runner_process:1->2',
        'worker-log:host_identity_snapshot:runtime-session-1:host_state:1->2',
        'worker-log:host_identity_snapshot:runtime-session-1:stream_context:1->2',
      ],
    },
    {
      kind: 'output_oracle',
      eventId: 'output-1',
      artifactHash: runtimeHashB,
      epoch: 'epoch-7',
      afterDispatchId: 'dispatch-1',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      outputTargetId: 'allocation-1',
      oracleKind: 'buffer_checksum',
      timestampMonotonicNs: 400,
      evidenceRefs: ['worker-log:output_oracle:runtime-session-1:dispatch-1'],
    },
  ];
  const genericBoundaryManifest = path.join(runtimeBoundaryBridgeDir, 'runtime-boundary-events.json');
  await writeFile(genericBoundaryManifest, `${JSON.stringify({
    schemaVersion: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    proofAuthority: 'runtime_boundary_event_manifest_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    backend: 'hip',
    projectId: 'generic-runtime-boundary-cold-project',
    editId: 'gpu-artifact-edit',
    targetId: 'generic-runtime-boundary-cold-target',
    sourcePaths: ['src/kernels/generic.hip'],
    sourceManifestHash: runtimeHashD,
    sourceManifestHashVerified: true,
    sourceIdentityEvidenceRefs: ['runtime-boundary:source-manifest:generic-runtime-boundary-cold-project'],
    entryPoint: 'generic_kernel',
    compileTarget: 'gfx1201',
    compiler: 'hipcc',
    compilerArgsHash: runtimeHashC,
    artifactHashBefore: runtimeHashA,
    artifactHashAfter: runtimeHashB,
    contractHash: runtimeHashC,
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    runtimeBoundaryEvents: genericBoundaryEvents,
    computeOracleArtifacts: {
      raw_readback_bin: 'runtime-boundary://raw-readback',
      readback_schema_json: 'runtime-boundary://readback-schema',
      checksum_before: runtimeHashA,
      checksum_after: runtimeHashB,
      expected_output_change: true,
      expected_output_verified: true,
      expected_output_hash: runtimeHashB,
      deterministic_slice: {
        offset: 0,
        length: 64,
        format: 'bytes',
        hash: runtimeHashC,
      },
      raw_readback_hash: runtimeHashB,
      raw_readback_hash_verified: true,
      raw_readback_byte_length: 128,
      raw_readback_source: 'runtime_raw_readback',
      deterministic_slice_hash: runtimeHashC,
      deterministic_slice_hash_verified: true,
      raw_readback_verification: {
        hash_verified: true,
        byte_length: 128,
        deterministic_slice_hash: runtimeHashC,
        deterministic_slice_hash_verified: true,
        expected_output_verified: true,
        slice_bounds_verified: true,
      },
      oracle_code_hash: runtimeHashC,
      rendered_card_png: 'runtime-boundary://compute-proof-card.png',
      producer: 'random_cold_runtime_boundary_profile_self_check',
      timestamp_after_dispatch: 400,
      epoch: 'epoch-7',
      evidenceRefs: ['compute-oracle:raw-readback-bytes'],
    },
  }, null, 2)}\n`);
  const genericRuntimeBoundaryProfile = path.join(runtimeBoundaryBridgeDir, 'runtime-boundary-profile.json');
  await writeFile(genericRuntimeBoundaryProfile, `${JSON.stringify({
    schemaVersion: GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION,
    id: 'random-cold-generic-runtime-boundary-profile',
    adapter: {
      family: 'generic-runtime-boundary-adapter',
      proofRunner: 'runtime-boundary-proof-adapter',
      runtimeBoundaryEventManifestPath:
        repoRelativePath(genericBoundaryManifest),
    },
    runtime: {
      targetName: 'generic-runtime-boundary-cold-target',
      requiredKernels: ['generic_kernel'],
      reload: {
        kernelName: 'generic_kernel',
        kernelSymbol: 'generic_kernel',
      },
    },
    source: {
      file: 'src/kernels/generic.hip',
      before: 'return 1;',
      after: 'return 2;',
    },
  }, null, 2)}\n`);
  const genericRuntimeBoundaryCandidate = cleanCandidate({
    id: 'direct-runtime-boundary-generic-large',
    backendFamily: 'unknown_gpu_project',
    runtimeProofProfilePath: repoRelativePath(genericRuntimeBoundaryProfile),
    sourceUrl: 'https://example.invalid/direct-runtime-boundary-generic.git',
    immutableCommit: 'abababababababababababababababababababab',
  });
  const genericRuntimeBoundaryResult = await runSelectedCandidate(
    genericRuntimeBoundaryCandidate,
    {
      dryRun: false,
      timeoutMs: 1,
      runnerTimeoutMs: 60000,
      sourceIntake: false,
      sourceIntakeTimeoutMs: 1,
    },
  );
  if (
    genericRuntimeBoundaryResult.status !== 'unprofiled_arbitrary_project_cold_intake_runtime_profile_bridged_refused'
    || genericRuntimeBoundaryResult.runtimeProfileProofBridgeAccepted !== true
    || genericRuntimeBoundaryResult.runtimeProfileStrictRuntimeProofAccepted !== true
    || genericRuntimeBoundaryResult.runtimeProfileProofBridge?.strictRuntimeProofId === null
    || genericRuntimeBoundaryResult.runtimeProfileProofBridge?.proofLedgerId === null
    || genericRuntimeBoundaryResult.runtimeProfileProofBridge?.runtimeBoundaryProofAdapterAccepted !== true
    || !genericRuntimeBoundaryResult.runtimeProfileProofBridge?.runtimeBoundaryEventManifestSha256?.startsWith('sha256:')
    || genericRuntimeBoundaryResult.runtimeBoundaryPlanBindingAccepted !== false
    || genericRuntimeBoundaryResult.runtimeBoundaryPlanBinding !== null
    || genericRuntimeBoundaryResult.blockingGaps?.includes('same_process_loader_unproven')
    || genericRuntimeBoundaryResult.blockingGaps?.includes('epoch_publication_unproven')
    || genericRuntimeBoundaryResult.blockingGaps?.includes('dispatch_trace_unproven')
    || genericRuntimeBoundaryResult.blockingGaps?.includes('host_identity_unproven')
    || genericRuntimeBoundaryResult.blockingGaps?.includes('output_oracle_unproven')
    || !genericRuntimeBoundaryResult.blockingGaps?.includes('cold_path_runtime_profile_proof_requires_matrix_ingestion')
    || genericRuntimeBoundaryResult.acceptedForGpuHmr !== false
    || genericRuntimeBoundaryResult.gpuHmrSuccess !== false
    || genericRuntimeBoundaryResult.canSatisfyRuntimeProof !== false
  ) {
    throw new Error('random large-project cold-path generic runtime-boundary bridge self-check failed');
  }
  const spoofedDirectPool = await loadCandidates({
    candidatesJson: JSON.stringify([
      {
        id: 'spoofed-direct-candidate',
        candidateSource: 'direct_source_url_commit',
        candidate_source: 'direct_source_url_commit',
        directInputEvidence: directSourceInputEvidence({
          candidateSource: 'direct_source_url_commit',
          sourceUrl: 'https://example.invalid/spoofed-direct.git',
          immutableCommit: '1212121212121212121212121212121212121212',
          inputChannels: ['cli_arg_source_url', 'cli_arg_commit'],
        }),
        sourceUrl: 'https://example.invalid/spoofed-direct.git',
        immutableCommit: '1212121212121212121212121212121212121212',
      },
    ]),
  });
  if (
    spoofedDirectPool[0]?.candidateSource !== 'configured_candidate_pool'
    || spoofedDirectPool[0]?.candidate_source !== 'configured_candidate_pool'
    || spoofedDirectPool[0]?.directInputEvidence !== null
  ) {
    throw new Error('random large-project cold-path candidate JSON was allowed to forge direct source authority');
  }
  const spoofedDirectLocalPool = await loadCandidates({
    candidatesJson: JSON.stringify([
      {
        id: 'spoofed-direct-local-candidate',
        candidateSource: 'direct_local_git_repo_path',
        candidate_source: 'direct_local_git_repo_path',
        directInputEvidence: directSourceInputEvidence({
          candidateSource: 'direct_local_git_repo_path',
          sourceUrl: 'file:///tmp/spoofed-direct-local',
          repoPath: '/tmp/spoofed-direct-local',
          immutableCommit: '3434343434343434343434343434343434343434',
          inputChannels: ['cli_arg_repo_path', 'cli_arg_commit'],
        }),
        sourceUrl: 'file:///tmp/spoofed-direct-local',
        localRepoPath: '/tmp/spoofed-direct-local',
        immutableCommit: '3434343434343434343434343434343434343434',
      },
    ]),
  });
  if (
    spoofedDirectLocalPool[0]?.candidateSource !== 'configured_candidate_pool'
    || spoofedDirectLocalPool[0]?.candidate_source !== 'configured_candidate_pool'
    || spoofedDirectLocalPool[0]?.directInputEvidence !== null
  ) {
    throw new Error('random large-project cold-path candidate JSON was allowed to forge direct local repo authority');
  }
  const parsedListing = parseGitLsTree([
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tCMakeLists.txt',
    '100644 blob dddddddddddddddddddddddddddddddddddddddd 78\tcrates/gpu/Cargo.toml',
    '100644 blob eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee 90\tengine/BUILD.gn',
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 34\tkernels/example.hip',
    '100644 blob cccccccccccccccccccccccccccccccccccccccc 56\tsrc/vulkan/shader.comp',
  ].join('\n'));
  const shuffledListing = [parsedListing[3], parsedListing[0], parsedListing[4], parsedListing[1], parsedListing[2]];
  if (
    stableJson(canonicalSourceListingIdentity(parsedListing))
      !== stableJson(canonicalSourceListingIdentity(shuffledListing))
  ) {
    throw new Error('random large-project cold-path listing identity depended on transport order');
  }
  const listingClassification = classifySourceListing(parsedListing);
  const wideSourceClassification = classifySourceListing(parseGitLsTree([
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tCMakeLists.txt',
    ...Array.from({ length: 120 }, (_, index) => {
      const object = index.toString(16).slice(-1).repeat(40);
      return `100644 blob ${object} ${index + 1}\tsrc/module_${index}.cpp`;
    }),
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 34\tkernels/example.hip',
  ].join('\n')));
  const headerHeavyGpuClassification = classifySourceListing(parseGitLsTree([
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tCMakeLists.txt',
    '100644 blob ffffffffffffffffffffffffffffffffffffffff 11\trocm/CMakeLists.txt',
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 34\tinclude/math/gpu/block_gemm.hpp',
    '100644 blob cccccccccccccccccccccccccccccccccccccccc 56\tlibrary/src/tensor_operation_instance/gpu/device_gemm.cpp',
    '100644 blob dddddddddddddddddddddddddddddddddddddddd 78\tinclude/math/kernel/tile_pipeline.hpp',
    '100644 blob eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee 90\tinclude/math/host/reference_gemm.hpp',
  ].join('\n')));
  const buildMetadataOnlyListing = parseGitLsTree([
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tCMakeLists.txt',
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 34\tsrc/model_runtime.cpp',
    '100644 blob cccccccccccccccccccccccccccccccccccccccc 56\tinclude/model_runtime.hpp',
  ].join('\n'));
  const buildMetadataOnlyListingClassification = classifySourceListing(buildMetadataOnlyListing);
  const buildMetadataOnlyText = [
    'cmake_minimum_required(VERSION 3.24)',
    'project(arbitrary_ml_runtime LANGUAGES CXX HIP)',
    'enable_language(HIP)',
    'find_package(hip REQUIRED)',
    'set(AMDGPU_TARGETS gfx1201 CACHE STRING "")',
    'add_library(arbitrary_runtime src/model_runtime.cpp)',
  ].join('\n');
  const buildMetadataOnlySummary =
    summarizeBuildMetadataContent('CMakeLists.txt', buildMetadataOnlyText);
  const buildMetadataOnlyContentEvidence = {
    schemaVersion: BUILD_METADATA_CONTENT_SCHEMA,
    schema_version: BUILD_METADATA_CONTENT_SCHEMA,
    proofAuthority: BUILD_METADATA_CONTENT_AUTHORITY,
    proof_authority: BUILD_METADATA_CONTENT_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    acceptedAsBuildMetadataContent: true,
    accepted_as_build_metadata_content: true,
    buildFiles: [{
      path: 'CMakeLists.txt',
      object: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      declaredByteLength: 12,
      declared_byte_length: 12,
      observedByteLength: Buffer.byteLength(buildMetadataOnlyText),
      observed_byte_length: Buffer.byteLength(buildMetadataOnlyText),
      contentHash: contentHash(buildMetadataOnlyText),
      content_hash: contentHash(buildMetadataOnlyText),
      transport: 'self_check_fixture_bytes',
      semanticSummary: buildMetadataOnlySummary,
      semantic_summary: buildMetadataOnlySummary,
    }],
    build_files: [{
      path: 'CMakeLists.txt',
      object: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      declaredByteLength: 12,
      declared_byte_length: 12,
      observedByteLength: Buffer.byteLength(buildMetadataOnlyText),
      observed_byte_length: Buffer.byteLength(buildMetadataOnlyText),
      contentHash: contentHash(buildMetadataOnlyText),
      content_hash: contentHash(buildMetadataOnlyText),
      transport: 'self_check_fixture_bytes',
      semanticSummary: buildMetadataOnlySummary,
      semantic_summary: buildMetadataOnlySummary,
    }],
  };
  const buildMetadataOnlyMergedClassification = mergeClassificationWithBuildMetadataContent(
    buildMetadataOnlyListingClassification,
    buildMetadataOnlyContentEvidence,
  );
  const buildMetadataOnlyDiscovery = discoverBuildMetadata({
    candidate: candidates[0],
    files: buildMetadataOnlyListing,
    classification: buildMetadataOnlyMergedClassification,
    contentEvidence: buildMetadataOnlyContentEvidence,
  });
  const buildMetadataOnlyRuntimeExpectation = deriveRuntimeBoundaryExpectation({
    candidate: candidates[0],
    classification: buildMetadataOnlyMergedClassification,
    buildMetadataDiscovery: buildMetadataOnlyDiscovery,
  });
  const buildDiscovery = discoverBuildMetadata({
    candidate: candidates[0],
    files: parsedListing,
    classification: listingClassification,
  });
  const runtimeExpectation = deriveRuntimeBoundaryExpectation({
    candidate: candidates[0],
    classification: listingClassification,
    buildMetadataDiscovery: buildDiscovery,
  });
  const runtimeSupportClosure = deriveRuntimeSupportClosureObligation({
    candidate: candidates[0],
    runtimeBoundaryExpectation: runtimeExpectation,
  });
  const unboundRuntimeEventTemplate = deriveRuntimeBoundaryEventManifestTemplate({
    candidate: candidates[0],
    runtimeBoundaryExpectation: runtimeExpectation,
  });
  const runtimeEventTemplate = deriveRuntimeBoundaryEventManifestTemplate({
    candidate: candidates[0],
    runtimeBoundaryExpectation: runtimeExpectation,
    sourceListingHash: contentHash(stableJson(canonicalSourceListingIdentity(parsedListing))),
    buildMetadataContentHash: contentHash('self-check-build-metadata-content'),
  });
  const noBackendRuntimeExpectation = deriveRuntimeBoundaryExpectation({
    candidate: candidates[0],
    classification: { backendCandidates: [] },
    buildMetadataDiscovery: buildDiscovery,
  });
  const noBackendRuntimeEventTemplate = deriveRuntimeBoundaryEventManifestTemplate({
    candidate: candidates[0],
    runtimeBoundaryExpectation: noBackendRuntimeExpectation,
  });
  const forgedOracleHintCandidate = cleanCandidate({
    id: 'forged-oracle-hint-large',
    sourceUrl: 'https://example.invalid/forged-oracle.git',
    immutableCommit: '1313131313131313131313131313131313131313',
    oracleHints: {
      acceptedByDeclaration: true,
      expectedKinds: ['deterministic_visual_oracle'],
    },
  });
  const openclOnlyListing = parseGitLsTree([
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tCMakeLists.txt',
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 34\tkernels/example.cl',
  ].join('\n'));
  const openclOnlyClassification = classifySourceListing(openclOnlyListing);
  const openclOnlyBuildDiscovery = discoverBuildMetadata({
    candidate: forgedOracleHintCandidate,
    files: openclOnlyListing,
    classification: openclOnlyClassification,
  });
  const forgedOracleHintExpectation = deriveRuntimeBoundaryExpectation({
    candidate: forgedOracleHintCandidate,
    classification: openclOnlyClassification,
    buildMetadataDiscovery: openclOnlyBuildDiscovery,
  });
  const outputOracleTemplate = runtimeEventTemplate.eventObjectTemplates
    ?.find((entry) => entry.eventKind === 'output_oracle');
  const parsedNoSizeListing = parseGitLsTree(
    '100644 blob ffffffffffffffffffffffffffffffffffffffff\tpackage.json\n',
  );
  if (
    parsedListing.length !== 5
    || parsedNoSizeListing.length !== 1
    || parsedNoSizeListing[0]?.byteLength !== null
    || parsedNoSizeListing[0]?.path !== 'package.json'
    || listingClassification.buildSignalCount !== 3
    || listingClassification.sourceRelevantFileCount !== 2
    || listingClassification.sourceOrBuildRelevantFileCount !== 5
    || !listingClassification.backendCandidates.includes('hip_rocm')
    || !listingClassification.backendCandidates.includes('vulkan')
    || wideSourceClassification.buildSignalCount !== 1
    || wideSourceClassification.gpuSourceSignalCount !== 1
    || wideSourceClassification.sourceRelevantFileCount !== 121
    || wideSourceClassification.sourceOrBuildRelevantFileCount !== 122
    || wideSourceClassification.sourceRelevantFiles.length !== 80
    || headerHeavyGpuClassification.gpuSourceSignalCount !== 3
    || headerHeavyGpuClassification.sourceRelevantFileCount !== 4
    || !headerHeavyGpuClassification.backendCandidates.includes('hip_rocm')
    || buildMetadataOnlyListingClassification.backendCandidates.length !== 0
    || !buildMetadataOnlySummary.backendSignalCandidates.includes('hip_rocm')
    || !buildMetadataOnlyMergedClassification.backendCandidates.includes('hip_rocm')
    || !buildMetadataOnlyMergedClassification.buildMetadataBackendCandidates.includes('hip_rocm')
    || buildMetadataOnlyMergedClassification.backendCandidateAuthority
      !== 'source_listing_and_verified_build_metadata_classification_only_not_runtime_authority'
    || !buildMetadataOnlyDiscovery.backendCandidates.includes('hip_rocm')
    || buildMetadataOnlyRuntimeExpectation.acceptedAsRuntimeBoundaryExpectation !== true
    || !buildMetadataOnlyRuntimeExpectation.expectedRuntimeEvents.includes('hip_kernel_dispatch')
    || buildMetadataOnlyRuntimeExpectation.gpuHmrSuccess !== false
    || buildDiscovery.acceptedAsBuildMetadataDiscovery !== true
    || !buildDiscovery.detectedBuildSystems.includes('cmake')
    || !buildDiscovery.detectedBuildSystems.includes('cargo')
    || !buildDiscovery.detectedBuildSystems.includes('gn')
    || buildDiscovery.buildSignalCount !== 3
    || buildDiscovery.gpuSourceSignalCount !== 2
    || buildDiscovery.sourceRelevantFileCount !== 2
    || buildDiscovery.sourceOrBuildRelevantFileCount !== 5
    || buildDiscovery.buildMetadataContentAccepted !== false
    || runtimeExpectation.acceptedAsRuntimeBoundaryExpectation !== true
    || runtimeExpectation.gpuHmrSuccess !== false
    || !runtimeExpectation.requiredBoundaryStages.includes(RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_STAGE)
    || !runtimeExpectation.missingRuntimeEvidenceGaps.includes(RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_GAP)
    || !runtimeExpectation.requiredBoundaryStages.includes('output_oracle')
    || !runtimeExpectation.expectedRuntimeEvents.includes('hip_kernel_dispatch')
    || !runtimeExpectation.expectedRuntimeEvents.includes('command_buffer_or_dispatch_bind')
    || runtimeSupportClosure.proofAuthority !== ADAPTER_CLOSURE_EXPECTATION_AUTHORITY
    || runtimeSupportClosure.acceptedForGpuHmr !== false
    || runtimeSupportClosure.gpuHmrSuccess !== false
    || runtimeSupportClosure.canSatisfyRuntimeProof !== false
    || !runtimeSupportClosure.possibleOutcomes.includes('unsupported_requires_app_hook')
    || !runtimeSupportClosure.blockingGaps.includes('runtime_support_closure_requires_app_hook')
    || unboundRuntimeEventTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate !== false
    || !unboundRuntimeEventTemplate.blockingGaps.includes(
      'runtime_boundary_template_source_binding_incomplete',
    )
    || runtimeEventTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate !== true
    || runtimeEventTemplate.sourceBinding?.acceptedAsTemplateSourceBinding !== true
    || !runtimeEventTemplate.sourceBindingHash?.startsWith('sha256:')
    || runtimeEventTemplate.gpuHmrSuccess !== false
    || runtimeEventTemplate.canSatisfyRuntimeProof !== false
    || runtimeEventTemplate.requiredEventKinds?.length !== 5
    || runtimeEventTemplate.eventObjectTemplates?.length !== 5
    || !runtimeEventTemplate.requiredEventKinds.includes('output_oracle')
    || !runtimeEventTemplate.adapterInputRequiredFields?.includes('sourceManifestHash')
    || !runtimeEventTemplate.adapterInputRequiredFields?.includes('sourceManifestHashVerified')
    || !runtimeEventTemplate.adapterInputRequiredFields?.includes('sourceIdentityEvidenceRefs')
    || !runtimeEventTemplate.adapterInputRequiredFields?.includes('runtimeBoundaryEvents')
    || !runtimeEventTemplate.adapterInputFieldAliases?.runtimeBoundaryEvents?.includes('events')
    || !runtimeEventTemplate.manifestTemplate?.adapterInputRequiredFields?.includes('artifactHashAfter')
    || !runtimeEventTemplate.manifestTemplate?.adapterInputFieldAliases?.sourceManifestHash?.includes('source_identity_hash')
    || !runtimeEventTemplate.manifestTemplate?.oracleArtifactRequirements?.some((entry) => entry.mode === 'compute_readback')
    || !outputOracleTemplate?.requiredFields?.includes('after_dispatch_id')
    || !outputOracleTemplate?.oracleFieldAlternatives?.some((entry) => entry.mode === 'compute_readback')
    || runtimeEventTemplate.manifestTemplate?.runtimeBoundaryEvents !== undefined
    || noBackendRuntimeExpectation.acceptedAsRuntimeBoundaryExpectation !== false
    || !noBackendRuntimeExpectation.blockingGaps.includes('runtime_backend_candidate_missing')
    || noBackendRuntimeEventTemplate.acceptedAsRuntimeBoundaryEventManifestTemplate !== false
    || !noBackendRuntimeEventTemplate.blockingGaps.includes('runtime_backend_candidate_missing')
    || forgedOracleHintExpectation.acceptedAsRuntimeBoundaryExpectation !== false
    || forgedOracleHintExpectation.candidateOracleHintsUsedForAcceptance !== false
    || forgedOracleHintExpectation.candidateOracleHintClaimsAcceptance !== true
    || !forgedOracleHintExpectation.blockingGaps.includes(
      'candidate_oracle_hint_acceptance_claim_rejected',
    )
    || !forgedOracleHintExpectation.candidateDeclaredOracleKinds.includes('deterministic_visual_oracle')
    || forgedOracleHintExpectation.acceptableOracleKinds.includes('deterministic_visual_oracle')
    || !forgedOracleHintExpectation.acceptableOracleKinds.includes('compute_readback')
    || buildDiscovery.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path source listing classifier self-check failed');
  }
  if (
    githubTreeFailureCanUseAutomaticGitFallback({
      status: 'source_intake_github_tree_failed',
      httpStatus: 403,
      bodyTail: 'API rate limit exceeded for this source',
    }) !== true
    || githubTreeFailureCanUseAutomaticGitFallback({
      status: 'source_intake_github_tree_failed',
      httpStatus: 429,
      bodyTail: 'too many requests',
    }) !== true
    || githubTreeFailureCanUseAutomaticGitFallback({
      status: 'source_intake_github_tree_failed',
      httpStatus: 403,
      bodyTail: 'resource not accessible by integration',
    }) !== false
    || githubTreeFailureCanUseAutomaticGitFallback({
      status: 'source_intake_github_tree_truncated',
      httpStatus: 200,
    }) !== false
    || githubTreeTruncationCanUseAutomaticGitFallback({
      status: 'source_intake_github_tree_truncated',
      httpStatus: 200,
    }, directCandidate) !== true
    || githubTreeTruncationCanUseAutomaticGitFallback({
      status: 'source_intake_github_tree_truncated',
      httpStatus: 200,
    }, candidates[0]) !== false
    || githubTreeTruncationCanUseAutomaticGitFallback({
      status: 'source_intake_github_tree_truncated',
      httpStatus: 200,
    }, {
      ...directCandidate,
      acceptedForGpuHmr: true,
    }) !== false
    || directUserSourceCanUseAutomaticGitFallback(spoofedDirectPool[0]) !== false
  ) {
    throw new Error('random large-project cold-path GitHub rate-limit fallback self-check failed');
  }
  const fallbackEvidence = sourceIntakeTransportFallbackEvidence({
    candidate: directCandidate,
    reason: 'self_check_direct_source_truncation',
    automatic: true,
    automaticReason: 'direct_user_source_github_tree_truncated',
    requiresExplicitOptIn: false,
    recommendedTransport: 'git_fetch_depth_1_blobless',
    githubTree: {
      status: 'source_intake_github_tree_truncated',
      reason: 'github_recursive_tree_truncated',
      httpStatus: 200,
    },
  });
  if (
    fallbackEvidence.schemaVersion !== SOURCE_INTAKE_TRANSPORT_FALLBACK_SCHEMA
    || fallbackEvidence.proofAuthority !== SOURCE_INTAKE_TRANSPORT_FALLBACK_AUTHORITY
    || fallbackEvidence.fallbackAuthority !== SOURCE_INTAKE_TRANSPORT_FALLBACK_AUTHORITY
    || fallbackEvidence.acceptedForGpuHmr !== false
    || fallbackEvidence.gpuHmrSuccess !== false
    || fallbackEvidence.canSatisfyRuntimeProof !== false
    || fallbackEvidence.canSatisfyDispatchProof !== false
    || fallbackEvidence.targetNameIndependent !== true
    || fallbackEvidence.projectNameWhitelist.length !== 0
    || fallbackEvidence.specificTargetIdsAllowed.length !== 0
    || fallbackEvidence.directSourceInputEvidenceHash
      !== directCandidate.directInputEvidence?.evidenceHash
    || fallbackEvidence.requiresExplicitOptIn !== false
    || fallbackEvidence.automatic !== true
    || !/^sha256:[a-f0-9]{64}$/i.test(fallbackEvidence.fallbackEvidenceHash ?? '')
    || claimsGpuHmrAuthority(fallbackEvidence) === true
  ) {
    throw new Error('random large-project cold-path transport fallback evidence self-check failed');
  }
  const { manifest } = await buildManifest({
    seed: 'self-check-seed',
    count: 1,
    dryRun: true,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    candidates,
    sourceMode: 'configured_sample_pool',
    samplePool: true,
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  if (
    manifest.schemaVersion !== SCHEMA
    || manifest.proofAuthority !== AUTHORITY
    || manifest.acceptedForGpuHmr !== false
    || manifest.gpuHmrSuccess !== false
    || manifest.results[0]?.status !== 'selected_not_executed_dry_run'
    || !manifest.selection.selectionHash?.startsWith('sha256:')
  ) {
    throw new Error('random large-project cold-path manifest self-check failed');
  }
  const timeoutProbe = await runProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 50 },
  );
  if (timeoutProbe.error && /\bEPERM\b/i.test(timeoutProbe.error)) {
    console.warn('random large-project cold-path timeout self-check skipped child spawn probe: EPERM');
  } else if (!timeoutProbe.timedOut || timeoutProbe.timeoutMs !== 50 || !timeoutProbe.timeoutKillAttempted) {
    throw new Error('random large-project cold-path timeout self-check failed');
  }
  const { manifest: pendingManifest } = await buildManifest({
    seed: 'pending-self-check-seed',
    count: 1,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    candidates,
    sourceMode: 'configured_sample_pool',
    samplePool: true,
    outputDir: path.join(LOG_DIR, 'self-check'),
    runCandidate: async (candidate) => ({
      candidateId: candidate.id,
      status: 'synthetic_runner_timeout_failed_closed',
      timedOut: true,
      timed_out: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    }),
  });
  if (
    pendingManifest.eventType !== 'cold_path_complete'
    || !pendingManifest.pendingManifestPath
    || !pendingManifest.pendingManifestHash?.startsWith('sha256:')
    || pendingManifest.results[0]?.status !== 'synthetic_runner_timeout_failed_closed'
  ) {
    throw new Error('random large-project cold-path pending manifest self-check failed');
  }
  const { manifest: unprofiledManifest } = await buildManifest({
    seed: 'unprofiled-self-check-seed',
    count: 1,
    candidateId: 'delta-unprofiled-large',
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    candidates,
    sourceMode: 'configured_sample_pool',
    samplePool: true,
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  const unprofiledResult = unprofiledManifest.results[0] ?? {};
  if (
    unprofiledResult.status !== 'unprofiled_arbitrary_project_cold_intake_refused'
    || unprofiledResult.runnerAttempted !== false
    || !unprofiledResult.blockingGaps?.includes('runtime_profile_contract_missing')
    || !unprofiledResult.blockingGaps?.includes('runtime_support_closure_requires_app_hook')
    || !unprofiledResult.blockingGaps?.includes('cold_build_execution_plan_missing')
    || !unprofiledResult.blockingGaps?.includes('strict_runtime_ledger_missing')
    || unprofiledResult.runtimeSupportClosureObligation?.proofAuthority
      !== ADAPTER_CLOSURE_EXPECTATION_AUTHORITY
    || unprofiledResult.runtimeSupportClosureObligation?.acceptedForGpuHmr !== false
    || unprofiledResult.runtimeSupportClosureObligation?.gpuHmrSuccess !== false
    || unprofiledResult.runtimeSupportClosureObligation?.canSatisfyRuntimeProof !== false
    || unprofiledResult.runtimeAppHookMaterializationPlan?.proofAuthority
      !== APP_HOOK_MATERIALIZATION_PLAN_AUTHORITY
    || unprofiledResult.runtimeAppHookMaterializationPlan?.acceptedAsSupportEvidence !== true
    || unprofiledResult.runtimeAppHookMaterializationPlan?.targetNameIndependent !== true
    || unprofiledResult.runtimeAppHookMaterializationPlan?.projectNameWhitelist?.length !== 0
    || unprofiledResult.runtimeAppHookMaterializationPlan?.specificTargetIdsAllowed?.length !== 0
    || unprofiledResult.runtimeAppHookMaterializationPlan?.acceptedForGpuHmr !== false
    || unprofiledResult.runtimeAppHookMaterializationPlan?.gpuHmrSuccess !== false
    || unprofiledResult.runtimeAppHookMaterializationPlan?.canSatisfyRuntimeProof !== false
    || unprofiledResult.runtimeAppHookMaterializationPlan?.canSatisfyDispatchProof !== false
    || !unprofiledResult.runtimeAppHookMaterializationPlan?.materializationPlanHash?.startsWith('sha256:')
    || !REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.every((kind) =>
      unprofiledResult.runtimeAppHookMaterializationPlan?.requiredStages?.includes(kind)
      && unprofiledResult.runtimeAppHookMaterializationPlan?.stagePlans
        ?.some((stage) => stage.stage === kind && stage.materialized === false)
    )
    || unprofiledResult.acceptedForGpuHmr !== false
    || unprofiledResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path unprofiled refusal self-check failed');
  }
  const { manifest: directManifest } = await buildManifest({
    seed: 'direct-source-self-check-seed',
    count: 1,
    candidateId: directCandidate.id,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    sourceIntake: false,
    candidates: [directCandidate],
    outputDir: path.join(LOG_DIR, 'self-check'),
    sourceMode: 'direct_user_source',
    requireDirectSource: true,
  });
  const directResult = directManifest.results[0] ?? {};
  if (
    directManifest.candidates[0]?.candidateSource !== 'direct_source_url_commit'
    || directManifest.candidates[0]?.directInputEvidence?.acceptedAsDirectInputEvidence !== true
    || !directManifest.candidates[0]?.directInputEvidence?.inputChannels?.includes('cli_arg_source_url')
    || directManifest.selectionAudit?.sourceMode !== 'direct_user_source'
    || directManifest.selectionAudit?.directSourceRequired !== true
    || directManifest.selectionAudit?.directUserSourceCount !== 1
    || directManifest.selectionAudit?.accepted !== true
    || directManifest.selectionAudit?.acceptedForGpuHmr !== false
    || directManifest.selectionAudit?.gpuHmrSuccess !== false
    || directResult.status !== 'unprofiled_arbitrary_project_cold_intake_refused'
    || directResult.sourceTreeIntakeAccepted !== false
    || !directResult.blockingGaps?.includes('source_tree_intake_missing')
    || !directResult.blockingGaps?.includes('runtime_support_closure_requires_app_hook')
    || directResult.runtimeSupportClosureOutcome !== 'unsupported_requires_app_hook'
    || directResult.acceptedForGpuHmr !== false
    || directResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path direct source refusal self-check failed');
  }
  const localRepoPath = path.join(LOG_DIR, 'self-check', 'local-user-project');
  await rm(localRepoPath, { recursive: true, force: true });
  await mkdir(path.join(localRepoPath, 'kernels'), { recursive: true });
  await writeFile(path.join(localRepoPath, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(local_user_project)\n');
  await writeFile(path.join(localRepoPath, 'kernels', 'example.hip'), '__global__ void k(float* out) { out[0] = 1.0f; }\n');
  const localGitInit = await runProcess('git', ['init', localRepoPath], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const localGitAdd = await runProcess('git', ['-C', localRepoPath, 'add', '.'], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const localGitCommit = await runProcess(
    'git',
    ['-C', localRepoPath, '-c', 'user.email=synthi@example.invalid', '-c', 'user.name=Synthi Self Check', 'commit', '-m', 'initial'],
    {
      cwd: REPO_ROOT,
      timeoutMs: 30000,
      streamOutput: false,
    },
  );
  if (localGitInit.exitCode !== 0 || localGitAdd.exitCode !== 0 || localGitCommit.exitCode !== 0) {
    throw new Error(
      `random large-project cold-path local git fixture setup failed: `
      + `init=${localGitInit.exitCode}:${tail(localGitInit.stderr || localGitInit.stdout || localGitInit.error || '', 240)} `
      + `add=${localGitAdd.exitCode}:${tail(localGitAdd.stderr || localGitAdd.stdout || localGitAdd.error || '', 240)} `
      + `commit=${localGitCommit.exitCode}:${tail(localGitCommit.stderr || localGitCommit.stdout || localGitCommit.error || '', 240)}`,
    );
  }
  const localGitHead = await runProcess('git', ['-C', localRepoPath, 'rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const localCommit = localGitHead.stdout.trim();
  const localCandidate = directCandidateFromInput({
    repoPath: localRepoPath,
    immutableCommit: localCommit,
    sourceId: 'local-user-project',
    inputChannels: ['cli_arg_repo_path', 'cli_arg_commit', 'cli_arg_source_id'],
  });
  const { manifest: localManifest } = await buildManifest({
    seed: 'local-source-self-check-seed',
    count: 1,
    candidateId: localCandidate.id,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    sourceIntake: true,
    sourceIntakeTimeoutMs: 30000,
    candidates: [localCandidate],
    outputDir: path.join(LOG_DIR, 'self-check'),
    sourceMode: 'direct_local_user_source',
    requireDirectSource: true,
  });
  const localResult = localManifest.results[0] ?? {};
  const localBuildContentFiles = localResult.sourceIntakeEvidence?.buildMetadataContentEvidence?.buildFiles ?? [];
  const localColdBuildExecutionPlan = localResult.sourceIntakeEvidence?.coldBuildExecutionPlan;
  if (
    localManifest.candidates[0]?.candidateSource !== 'direct_local_git_repo_path'
    || localManifest.candidates[0]?.directInputEvidence?.acceptedAsDirectInputEvidence !== true
    || localManifest.candidates[0]?.directInputEvidence?.sourceKind !== 'local_repo_path_commit'
    || localManifest.selectionAudit?.sourceMode !== 'direct_local_user_source'
    || localManifest.selectionAudit?.directSourceRequired !== true
    || localManifest.selectionAudit?.directUserSourceCount !== 1
    || localManifest.selectionAudit?.accepted !== true
    || localManifest.selectionAudit?.acceptedForGpuHmr !== false
    || localManifest.selectionAudit?.gpuHmrSuccess !== false
    || localResult.status !== 'unprofiled_arbitrary_project_cold_intake_runtime_profile_bridged_refused'
    || localResult.runtimeProofProfileMode !== 'derived_from_cold_intake_contract'
    || !String(localResult.runtimeProofProfilePath ?? '')
      .includes('/derived-runtime-profiles/local-user-project/')
    || localResult.sourceTreeIntakeAccepted !== true
    || localResult.buildMetadataDiscoveryAccepted !== true
    || localResult.buildMetadataContentAccepted !== true
    || localResult.sourceRelevantFileCount !== 1
    || localResult.sourceOrBuildRelevantFileCount !== 2
    || localResult.gpuSourceFileCount !== 1
    || localResult.runtimeBoundaryExpectationAccepted !== true
    || localResult.runtimeBoundaryEventManifestTemplateAccepted !== true
    || localResult.derivedRuntimeProfileContractAccepted !== true
    || localResult.derivedRuntimeProfileContract?.schemaVersion
      !== DERIVED_RUNTIME_PROFILE_CONTRACT_SCHEMA
    || localResult.derivedRuntimeProfileContract?.proofAuthority
      !== DERIVED_RUNTIME_PROFILE_CONTRACT_AUTHORITY
    || localResult.derivedRuntimeProfileContract?.acceptedForGpuHmr !== false
    || localResult.derivedRuntimeProfileContract?.gpuHmrSuccess !== false
    || localResult.derivedRuntimeProfileContract?.canSatisfyRuntimeProof !== false
    || !localResult.derivedRuntimeProfileContract?.runtimeProofProfileSha256?.startsWith('sha256:')
    || !localResult.derivedRuntimeProfileContract?.runtimeBoundaryEventManifestSha256?.startsWith('sha256:')
    || localResult.derivedRuntimeProfileContract?.runtimeBoundaryEventManifestTemplateHash
      !== localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.templateHash
    || localResult.derivedRuntimeProfileContract?.sourceListingHash
      !== localResult.sourceIntakeEvidence?.sourceListingHash
    || localResult.runtimeProfileProofBridgeAccepted !== true
    || localResult.runtimeProfileStrictRuntimeProofAccepted !== false
    || localResult.runtimeProfileProofBridge?.acceptedAsRuntimeProfileProofBridge !== true
    || localResult.runtimeProfileProofBridge?.strictRuntimeProofAccepted !== false
    || localResult.runtimeProfileProofBridge?.runtimeProofProfileMode
      !== 'derived_from_cold_intake_contract'
    || !localResult.runtimeProfileProofBridge?.blockingGaps
      ?.includes('runtime_profile_adapter_strict_runtime_proof_not_accepted')
    || !localResult.runtimeProfileProofBridge?.adapterResultBlockingGaps
      ?.includes('runtime_profile_adapter_strict_runtime_proof_artifact_missing')
    || localResult.runtimeSupportClosureOutcome !== 'generated_adapter'
    || localResult.sourceIntakeEvidence?.transport !== 'local_git_ls_tree_clean_worktree'
    || localResult.sourceIntakeEvidence?.sourceRelevantFileCount !== 1
    || localResult.sourceIntakeEvidence?.sourceOrBuildRelevantFileCount !== 2
    || localResult.sourceIntakeEvidence?.gpuSourceSignalCount !== 1
    || localResult.sourceIntakeEvidence?.sourceListingManifest?.schemaVersion
      !== 'synthi.gpu_hmr.random_cold_source_listing_manifest.v1'
    || localResult.sourceIntakeEvidence?.sourceListingManifest?.proofAuthority
      !== 'source_listing_entries_only_not_gpu_hmr_success'
    || localResult.sourceIntakeEvidence?.sourceListingManifest?.sourceListingHash
      !== localResult.sourceIntakeEvidence?.sourceListingHash
    || localResult.sourceIntakeEvidence?.sourceListingManifest?.entries?.length !== 2
    || localResult.sourceIntakeEvidence?.sourceListingManifest?.gpuHmrSuccess !== false
    || localResult.sourceIntakeEvidence?.sourceListingManifest?.canSatisfyRuntimeProof !== false
    || localResult.sourceIntakeEvidence?.buildMetadataDiscovery?.sourceRelevantFileCount !== 1
    || localResult.sourceIntakeEvidence?.buildMetadataDiscovery?.sourceOrBuildRelevantFileCount !== 2
    || localResult.sourceIntakeEvidence?.buildMetadataDiscovery?.gpuSourceSignalCount !== 1
    || !localResult.sourceIntakeEvidence?.buildMetadataDiscovery?.detectedBuildSystems?.includes('cmake')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryExpectation?.requiredBoundaryStages?.includes('same_process_loader')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryExpectation?.requiredBoundaryStages
      ?.includes(RUNTIME_ADAPTER_OR_APP_HOOK_CONTRACT_STAGE)
    || localResult.sourceIntakeEvidence?.runtimeBoundaryExpectation?.gpuHmrSuccess !== false
    || localColdBuildExecutionPlan?.proofAuthority !== COLD_BUILD_EXECUTION_PLAN_AUTHORITY
    || localColdBuildExecutionPlan?.acceptedAsSupportEvidence !== true
    || localColdBuildExecutionPlan?.targetNameIndependent !== true
    || localColdBuildExecutionPlan?.projectNameWhitelist?.length !== 0
    || localColdBuildExecutionPlan?.specificTargetIdsAllowed?.length !== 0
    || localColdBuildExecutionPlan?.acceptedForGpuHmr !== false
    || localColdBuildExecutionPlan?.gpuHmrSuccess !== false
    || localColdBuildExecutionPlan?.canSatisfyRuntimeProof !== false
    || localColdBuildExecutionPlan?.canSatisfyDispatchProof !== false
    || localColdBuildExecutionPlan?.observedBuildExecution !== false
    || localColdBuildExecutionPlan?.observedCompileDatabase !== false
    || localColdBuildExecutionPlan?.observedDeviceArtifactBuild !== false
    || !localColdBuildExecutionPlan?.planHash?.startsWith('sha256:')
    || !localColdBuildExecutionPlan?.requiredBuildEvidence?.includes(
      'compile_database_or_compiler_trace',
    )
    || !localColdBuildExecutionPlan?.requiredRuntimeBridgeOutputs?.includes(
      'output_oracle_artifact',
    )
    || !localColdBuildExecutionPlan?.blockingGaps?.includes('build_command_execution_not_observed')
    || !localColdBuildExecutionPlan?.blockingGaps?.includes('compile_database_not_verified')
    || localResult.sourceIntakeEvidence?.runtimeSupportClosureObligation?.proofAuthority
      !== ADAPTER_CLOSURE_EXPECTATION_AUTHORITY
    || localResult.sourceIntakeEvidence?.runtimeSupportClosureObligation?.gpuHmrSuccess !== false
    || localResult.sourceIntakeEvidence?.runtimeSupportClosureObligation?.canSatisfyRuntimeProof !== false
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.proofAuthority
      !== APP_HOOK_MATERIALIZATION_PLAN_AUTHORITY
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.acceptedAsSupportEvidence !== true
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.targetNameIndependent !== true
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.projectNameWhitelist?.length !== 0
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan
      ?.specificTargetIdsAllowed?.length !== 0
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.gpuHmrSuccess !== false
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.canSatisfyRuntimeProof !== false
    || localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.canSatisfyDispatchProof !== false
    || !REQUIRED_RUNTIME_BOUNDARY_EVENT_KINDS.every((kind) =>
      localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.requiredStages?.includes(kind)
      && localResult.sourceIntakeEvidence?.runtimeAppHookMaterializationPlan?.stagePlans
        ?.some((stage) => stage.stage === kind && stage.observedRuntimeEventRequired === true)
    )
    || localResult.runtimeAppHookMaterializationPlan?.proofAuthority
      !== APP_HOOK_MATERIALIZATION_PLAN_AUTHORITY
    || localResult.runtimeAppHookMaterializationPlan?.acceptedAsSupportEvidence !== true
    || localResult.runtimeAppHookMaterializationPlan?.gpuHmrSuccess !== false
    || localResult.runtimeAppHookMaterializationPlan?.canSatisfyRuntimeProof !== false
    || localResult.runtimeAppHookMaterializationPlan?.canSatisfyDispatchProof !== false
    || !localResult.runtimeAppHookMaterializationPlan?.blockingGaps
      ?.includes('app_hook_materialization_requires_observed_target_process_events')
    || localResult.runtimeBoundaryPlanBindingAccepted !== true
    || localResult.runtimeBoundaryPlanBinding?.schemaVersion !== RUNTIME_BOUNDARY_PLAN_BINDING_SCHEMA
    || localResult.runtimeBoundaryPlanBinding?.proofAuthority !== RUNTIME_BOUNDARY_PLAN_BINDING_AUTHORITY
    || localResult.runtimeBoundaryPlanBinding?.acceptedForGpuHmr !== false
    || localResult.runtimeBoundaryPlanBinding?.gpuHmrSuccess !== false
    || localResult.runtimeBoundaryPlanBinding?.canSatisfyRuntimeProof !== false
    || localResult.runtimeBoundaryPlanBinding?.runtimeBoundaryEventManifestSha256
      !== localResult.runtimeProfileProofBridge?.runtimeBoundaryEventManifestSha256
    || localResult.runtimeBoundaryPlanBinding?.materializationPlanHash
      !== localResult.runtimeAppHookMaterializationPlan?.materializationPlanHash
    || localResult.runtimeBoundaryPlanBinding?.sourceListingHash
      !== localResult.sourceIntakeEvidence?.sourceListingHash
    || localResult.runtimeBoundaryPlanBinding?.runtimeBoundaryEventManifestTemplateHash
      !== localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.templateHash
    || !localResult.runtimeBoundaryPlanBinding?.bindingHash?.startsWith('sha256:')
    || localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.gpuHmrSuccess !== false
    || localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.canSatisfyRuntimeProof !== false
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.requiredEventKinds?.includes('dispatch_trace')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.adapterInputRequiredFields
      ?.includes('sourceManifestHash')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.adapterInputRequiredFields
      ?.includes('runtimeBoundaryEvents')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.manifestTemplate
      ?.adapterInputRequiredFields?.includes('contractHash')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.manifestTemplate
      ?.oracleArtifactRequirements?.some((entry) => entry.mode === 'compute_readback')
    || !localResult.sourceIntakeEvidence?.runtimeBoundaryEventManifestTemplate?.eventObjectTemplates
      ?.some((entry) => entry.eventKind === 'artifact_transport' && entry.backendSpecificFields?.includes('hsaco_hash'))
    || !localResult.sourceIntakeEvidence?.backendCandidates?.includes('hip_rocm')
    || !(localResult.sourceIntakeEvidence?.buildMetadataContentEvidence?.acceptedBuildFileCount >= 1)
    || !localBuildContentFiles.some((file) => file.family === 'cmake' && file.contentHash?.startsWith('sha256:'))
    || !localResult.blockingGaps?.includes('semantic_build_metadata_execution_missing')
    || localResult.blockingGaps?.includes('runtime_profile_contract_missing')
    || !localResult.blockingGaps?.includes('same_process_loader_unproven')
    || !localResult.blockingGaps?.includes('dispatch_trace_unproven')
    || !localResult.blockingGaps?.includes('output_oracle_unproven')
    || !localResult.blockingGaps?.includes('strict_runtime_ledger_missing')
    || localResult.acceptedForGpuHmr !== false
    || localResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path local git source intake self-check failed');
  }
  const fallbackContentRead = await readBuildFileContent({
    candidate: localCandidate,
    file: { path: 'CMakeLists.txt', object: 'self-check-cmake', byteLength: 64 },
    transport: 'git_fetch_depth_1_blobless',
    transportEvidence: {
      resolvedLocalPath: localRepoPath,
      resolved_local_path: localRepoPath,
    },
    sourceIntakeTimeoutMs: 30000,
  });
  if (
    fallbackContentRead.accepted !== true
    || fallbackContentRead.transport !== 'git_fetch_blobless_show'
    || !String(fallbackContentRead.content ?? '').includes('project(local_user_project)')
  ) {
    throw new Error('random large-project cold-path git fallback build-file content self-check failed');
  }
  const fullTreeContentRead = await readBuildFileContent({
    candidate: localCandidate,
    file: { path: 'CMakeLists.txt', object: 'self-check-cmake', byteLength: 64 },
    transport: 'git_fetch_depth_1_full_tree',
    transportEvidence: {
      resolvedLocalPath: localRepoPath,
      resolved_local_path: localRepoPath,
    },
    sourceIntakeTimeoutMs: 30000,
  });
  if (
    fullTreeContentRead.accepted !== true
    || fullTreeContentRead.transport !== 'git_fetch_full_tree_show'
    || fullTreeContentRead.lazyBlobFetchAllowed !== true
    || !String(fullTreeContentRead.content ?? '').includes('project(local_user_project)')
  ) {
    throw new Error('random large-project cold-path full git fallback build-file content self-check failed');
  }
  const noSizeLsTree = await runProcess('git', ['-C', localRepoPath, 'ls-tree', '-r', '--full-tree', localCommit], {
    cwd: REPO_ROOT,
    timeoutMs: 30000,
    streamOutput: false,
  });
  const noSizeFiles = parseGitLsTree(noSizeLsTree.stdout);
  const noSizeFallbackBase = {
    schemaVersion: SOURCE_INTAKE_SCHEMA,
    schema_version: SOURCE_INTAKE_SCHEMA,
    proofAuthority: SOURCE_INTAKE_AUTHORITY,
    proof_authority: SOURCE_INTAKE_AUTHORITY,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sourceUrl: localCandidate.sourceUrl,
    source_url: localCandidate.sourceUrl,
    localRepoPath: localCandidate.localRepoPath,
    local_repo_path: localCandidate.localRepoPath,
    immutableCommit: localCandidate.immutableCommit,
    immutable_commit: localCandidate.immutableCommit,
    localPath: path.relative(REPO_ROOT, localRepoPath).replace(/\\/g, '/'),
    local_path: path.relative(REPO_ROOT, localRepoPath).replace(/\\/g, '/'),
    startedAt: new Date().toISOString(),
    started_at: new Date().toISOString(),
  };
  const noSizeFallbackFacet = await buildAcceptedSourceIntakeFacet({
    base: noSizeFallbackBase,
    candidate: localCandidate,
    files: noSizeFiles,
    transport: 'git_fetch_depth_1_blobless',
    transportEvidence: {
      resolvedLocalPath: localRepoPath,
      resolved_local_path: localRepoPath,
      listingMode: 'git_ls_tree_no_size_blobless',
      listing_mode: 'git_ls_tree_no_size_blobless',
      byteLengthMode: 'unknown_avoids_blob_fetch',
      byte_length_mode: 'unknown_avoids_blob_fetch',
    },
    sourceIntakeTimeoutMs: 30000,
  });
  if (
    noSizeLsTree.exitCode !== 0
    || noSizeFallbackFacet.acceptedAsIntakeEvidence !== true
    || noSizeFallbackFacet.transport !== 'git_fetch_depth_1_blobless'
    || noSizeFallbackFacet.totalKnownBytes !== 0
    || noSizeFallbackFacet.buildMetadataDiscoveryAccepted !== true
    || noSizeFallbackFacet.buildMetadataContentAccepted !== true
    || noSizeFallbackFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.transport !== 'git_fetch_blobless_show'
    || noSizeFallbackFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.lazyBlobFetchAllowed !== false
  ) {
    throw new Error('random large-project cold-path no-size git fallback facet self-check failed');
  }
  const previousBloblessContentFetch = process.env.SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH;
  process.env.SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH = '1';
  try {
    const noSizeContentFetchFacet = await buildAcceptedSourceIntakeFacet({
      base: noSizeFallbackBase,
      candidate: localCandidate,
      files: noSizeFiles,
      transport: 'git_fetch_depth_1_blobless',
      transportEvidence: {
        resolvedLocalPath: localRepoPath,
        resolved_local_path: localRepoPath,
        listingMode: 'git_ls_tree_no_size_blobless',
        listing_mode: 'git_ls_tree_no_size_blobless',
        byteLengthMode: 'unknown_avoids_blob_fetch',
        byte_length_mode: 'unknown_avoids_blob_fetch',
      },
      sourceIntakeTimeoutMs: 30000,
    });
    if (
      noSizeContentFetchFacet.totalKnownBytes !== 0
      || noSizeContentFetchFacet.buildMetadataContentAccepted !== true
      || noSizeContentFetchFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.transport
        !== 'git_fetch_blobless_show'
      || noSizeContentFetchFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.lazyBlobFetchAllowed
        !== true
    ) {
      throw new Error('random large-project cold-path no-size build-content fetch opt-in self-check failed');
    }
  } finally {
    if (previousBloblessContentFetch === undefined) {
      delete process.env.SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH;
    } else {
      process.env.SYNTHI_GPU_HMR_BLOBLESS_CONTENT_FETCH = previousBloblessContentFetch;
    }
  }
  const fullTreeFallbackFacet = await buildAcceptedSourceIntakeFacet({
    base: noSizeFallbackBase,
    candidate: localCandidate,
    files: localResult.sourceIntakeEvidence.sourceListingManifest.entries,
    transport: 'git_fetch_depth_1_full_tree',
    transportEvidence: {
      resolvedLocalPath: localRepoPath,
      resolved_local_path: localRepoPath,
      listingMode: 'git_ls_tree_with_size_full_fetch',
      listing_mode: 'git_ls_tree_with_size_full_fetch',
      byteLengthMode: 'declared_from_git_ls_tree_l_full_fetch',
      byte_length_mode: 'declared_from_git_ls_tree_l_full_fetch',
      fullGitFallbackEnabled: true,
      full_git_fallback_enabled: true,
    },
    sourceIntakeTimeoutMs: 30000,
  });
  if (
    fullTreeFallbackFacet.acceptedAsIntakeEvidence !== true
    || fullTreeFallbackFacet.transport !== 'git_fetch_depth_1_full_tree'
    || !(fullTreeFallbackFacet.totalKnownBytes > 0)
    || fullTreeFallbackFacet.buildMetadataContentAccepted !== true
    || fullTreeFallbackFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.transport
      !== 'git_fetch_full_tree_show'
    || fullTreeFallbackFacet.buildMetadataContentEvidence?.buildFiles?.[0]?.lazyBlobFetchAllowed
      !== true
    || fullTreeFallbackFacet.acceptedForGpuHmr !== false
    || fullTreeFallbackFacet.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path full git fallback facet self-check failed');
  }
  await writeFile(path.join(localRepoPath, 'untracked-dirty.tmp'), 'dirty\n');
  const { manifest: dirtyManifest } = await buildManifest({
    seed: 'dirty-local-source-self-check-seed',
    count: 1,
    candidateId: localCandidate.id,
    dryRun: false,
    timeoutMs: 1000,
    runnerTimeoutMs: 2000,
    sourceIntake: true,
    sourceIntakeTimeoutMs: 30000,
    candidates: [localCandidate],
    outputDir: path.join(LOG_DIR, 'self-check'),
  });
  const dirtyResult = dirtyManifest.results[0] ?? {};
  const dirtyTransportEvidence = dirtyResult.sourceIntakeEvidence?.transportEvidence ?? {};
  const dirtyBuildContentFiles =
    dirtyResult.sourceIntakeEvidence?.buildMetadataContentEvidence?.buildFiles ?? [];
  if (
    dirtyResult.sourceTreeIntakeAccepted !== true
    || dirtyResult.buildMetadataContentAccepted !== true
    || dirtyResult.sourceIntakeEvidence?.status !== 'source_intake_listing_accepted'
    || dirtyResult.sourceIntakeEvidence?.transport !== 'local_git_ls_tree_commit_snapshot_dirty_worktree'
    || dirtyTransportEvidence.dirtyWorktreeObserved !== true
    || dirtyTransportEvidence.worktreeContentConsumed !== false
    || dirtyTransportEvidence.sourceSnapshotMode !== 'immutable_git_commit_tree'
    || !(dirtyResult.sourceIntakeEvidence?.buildMetadataContentEvidence?.acceptedBuildFileCount >= 1)
    || !dirtyBuildContentFiles.some((file) => file.transport === 'local_git_commit_snapshot_show')
    || dirtyResult.sourceIntakeEvidence?.sampleFiles?.includes('untracked-dirty.tmp')
    || dirtyResult.blockingGaps?.includes('source_tree_intake_missing')
    || !dirtyResult.blockingGaps?.some((gap) =>
      gap === 'semantic_build_metadata_execution_missing'
      || gap === 'semantic_build_metadata_verification_missing'
    )
    || dirtyResult.acceptedForGpuHmr !== false
    || dirtyResult.gpuHmrSuccess !== false
  ) {
    throw new Error('random large-project cold-path dirty local git commit-snapshot self-check failed');
  }
  const forgedSelectionAudit = coldPathSelectionAudit({
    seed: 'forged-selection-audit-self-check',
    count: 1,
    candidates: [directCandidate],
    selected: [{ ...directCandidate, selectionKey: 'forged-selection-key' }],
    results: [{
      candidateId: directCandidate.id,
      status: 'forged_success',
      acceptedForGpuHmr: true,
      gpuHmrSuccess: true,
      canSatisfyRuntimeProof: true,
    }],
    sourceMode: 'direct_user_source',
    requireDirectSource: true,
  });
  if (
    forgedSelectionAudit.accepted !== false
    || !forgedSelectionAudit.blockingGaps?.includes('cold_path_selection_authority_claim_present')
    || forgedSelectionAudit.acceptedForGpuHmr !== false
    || forgedSelectionAudit.gpuHmrSuccess !== false
    || forgedSelectionAudit.canSatisfyRuntimeProof !== false
  ) {
    throw new Error('random large-project cold-path selection audit accepted forged GPU HMR authority');
  }
  console.log('random large-project cold-path self-check passed');
}

async function main() {
  const args = parseArgs();
  if (args.selfCheck) {
    await selfCheck();
    return;
  }
  const seed = String(args.seed ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SEED ?? '2026-06-30-random-large-project-cold-path');
  const dryRun = Boolean(args.dryRun || process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_DRY_RUN === '1');
  const candidateId = args.candidateId ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATE_ID ?? '';
  const timeoutMs = Number(process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_TIMEOUT_MS ?? process.env.SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS ?? 120000);
  const runnerTimeoutMs = Number(
    process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_RUN_TIMEOUT_MS
      ?? Math.max(timeoutMs + 120000, timeoutMs),
  );
  const sourceIntake = process.env.SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE !== '0';
  const sourceIntakeTimeoutMs = Number(
    process.env.SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE_TIMEOUT_MS
      ?? Math.max(timeoutMs, 120000),
  );
  const requireDirectSource = directSourceRequired(args);
  const directCandidate = directCandidateFromInput({
    sourceUrl: args.sourceUrl ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_URL,
    repoPath: args.repoPath ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_REPO_PATH,
    immutableCommit: args.immutableCommit ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_COMMIT,
    sourceId: args.sourceId ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_SOURCE_ID,
    backendFamily: args.backendFamily ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_BACKEND_FAMILY,
    runtimeProofProfilePath:
      args.runtimeProofProfilePath
      ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_RUNTIME_PROFILE_PATH,
    inputChannels: directInputChannelsFromArgsEnv(args),
  });
  const directCandidates = directCandidate ? [] : await loadDirectCandidates({
    candidatesJson: process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_DIRECT_CANDIDATES_JSON,
    candidatesPath: args.directCandidatesPath
      ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_DIRECT_CANDIDATES_PATH,
  });
  const useConfiguredCandidatePool = !directCandidate && directCandidates.length === 0;
  assertConfiguredSamplePoolExplicit({
    useConfiguredCandidatePool,
    samplePool: samplePoolModeRequested(args),
  });
  assertDirectSourceRequirement({
    requireDirectSource,
    directCandidate: directCandidate ?? directCandidates[0] ?? null,
  });
  const candidates = directCandidate ? [directCandidate] : directCandidates.length > 0 ? directCandidates : await loadCandidates({
    candidatesJson: process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATES_JSON,
    candidatesPath: args.candidatesPath ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_CANDIDATES_PATH,
  });
  const sourceMode = directCandidate
    ? 'direct_user_source'
    : directCandidates.length > 0
      ? 'direct_user_source_batch'
      : samplePoolModeRequested(args)
        ? 'configured_sample_pool'
        : 'configured_candidate_pool';
  const effectiveCandidateId = directCandidate ? directCandidate.id : candidateId;
  const defaultCount = defaultColdPathSelectionCount({
    directCandidate,
    directCandidates,
    samplePool: samplePoolModeRequested(args),
  });
  const count = Number(args.count ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_COUNT ?? defaultCount);
  const effectiveCount = directCandidate ? 1 : count;
  const { manifest, written } = await buildManifest({
    seed,
    count: effectiveCount,
    candidateId: effectiveCandidateId,
    dryRun,
    timeoutMs,
    runnerTimeoutMs,
    sourceIntake,
    sourceIntakeTimeoutMs,
    candidates,
    sourceMode,
    requireDirectSource,
    samplePool: samplePoolModeRequested(args),
    outputDir: path.resolve(args.outputDir ?? process.env.SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_OUTPUT_DIR ?? LOG_DIR),
  });
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: SCHEMA,
    manifestPath: written.filePath,
    manifestHash: written.hash,
    sourceMode,
    selectedIds: manifest.selection.selectedIds,
    dryRun,
    resultStatuses: manifest.results.map((result) => result.status),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
