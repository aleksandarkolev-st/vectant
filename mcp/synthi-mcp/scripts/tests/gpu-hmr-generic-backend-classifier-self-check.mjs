import assert from 'node:assert/strict';

import {
  classifySourceListing,
  mergeClassificationWithBuildMetadataContent,
  summarizeBuildMetadataContent,
} from '../gpu-hmr-random-large-project-cold-path.mjs';

const BUILD_PATH = 'CMakeLists.txt';

function classifyCmake(text, { accepted = true, authority } = {}) {
  const listingClassification = classifySourceListing([{ path: BUILD_PATH }]);
  const summary = summarizeBuildMetadataContent(BUILD_PATH, text);
  const semanticSummary = authority === undefined
    ? summary
    : {
        ...summary,
        backendSignalAuthority: authority,
        backend_signal_authority: authority,
      };
  const contentEvidence = {
    acceptedAsBuildMetadataContent: accepted,
    accepted_as_build_metadata_content: accepted,
    buildFiles: [{
      path: BUILD_PATH,
      semanticSummary,
      semantic_summary: semanticSummary,
    }],
  };
  return {
    summary,
    classification: mergeClassificationWithBuildMetadataContent(
      listingClassification,
      contentEvidence,
    ),
  };
}

const namedOnlyCmake = [
  'cmake_minimum_required(VERSION 3.24)',
  'project(neutral.hip.cu.cl.spv.wgsl.metal-hipcc-nvcc-dpcpp LANGUAGES CXX)',
  'find_package(MIOpen REQUIRED)',
  'find_package(neutral.hip.cu.cl.spv.wgsl.metal-hipcc-nvcc-dpcpp-metallib REQUIRED)',
  'add_library(neutral_host src/host.cpp)',
].join('\n');
const namedOnly = classifyCmake(namedOnlyCmake);
assert.equal(
  namedOnly.summary.projectName,
  'neutral.hip.cu.cl.spv.wgsl.metal-hipcc-nvcc-dpcpp',
);
assert.deepEqual(namedOnly.summary.backendSignalCandidates, []);
assert.deepEqual(namedOnly.classification.buildMetadataBackendCandidates, []);
assert.deepEqual(namedOnly.classification.backendCandidates, []);

const namedPathOnly = classifySourceListing([
  { path: 'vendor/rocm/CMakeLists.txt' },
  { path: 'src/cuda_report.cpp' },
  { path: 'src/opencl_notes.cpp' },
  { path: 'src/webgpu_notes.cpp' },
  { path: 'src/vulkan_notes.cpp' },
  { path: 'src/sycl_notes.cpp' },
  { path: 'src/metal/notes.cpp' },
]);
assert.deepEqual(namedPathOnly.backendCandidates, []);

const hipLanguage = classifyCmake([
  'cmake_minimum_required(VERSION 3.24)',
  'project(neutral_compute LANGUAGES CXX HIP)',
  'find_package(neutral_tensor_package REQUIRED)',
  'add_library(neutral_compute src/host.cpp)',
].join('\n'));
assert.deepEqual(hipLanguage.summary.backendSignalCandidates, ['hip_rocm']);
assert.deepEqual(hipLanguage.classification.buildMetadataBackendCandidates, ['hip_rocm']);
assert.deepEqual(hipLanguage.classification.backendCandidates, ['hip_rocm']);
assert.equal(
  hipLanguage.summary.backendSignals.some((signal) =>
    signal.reason === 'cmake_hip_language_enabled'),
  true,
);

const hipEnableLanguage = classifyCmake([
  'project(neutral_compute LANGUAGES CXX)',
  'enable_language(HIP)',
].join('\n'));
assert.deepEqual(hipEnableLanguage.classification.backendCandidates, ['hip_rocm']);

const hipToolchain = classifyCmake([
  'project(neutral_compute LANGUAGES CXX)',
  'set(CMAKE_HIP_COMPILER clang++)',
  'set(CMAKE_HIP_ARCHITECTURES gfx1201)',
].join('\n'));
assert.deepEqual(hipToolchain.classification.backendCandidates, ['hip_rocm']);
assert.equal(
  hipToolchain.summary.backendSignals.some((signal) =>
    signal.reason === 'hip_toolchain_metadata'),
  true,
);

const hipDeviceSource = classifySourceListing([{ path: 'src/neutral/device_kernel.hip' }]);
assert.deepEqual(hipDeviceSource.backendCandidates, ['hip_rocm']);
assert.deepEqual(hipDeviceSource.backendSignals.hip_rocm, [{
  path: 'src/neutral/device_kernel.hip',
  reason: 'device_source_extension',
}]);

const unboundHipLanguage = classifyCmake([
  'project(neutral_compute LANGUAGES CXX HIP)',
], { accepted: false });
assert.deepEqual(unboundHipLanguage.summary.backendSignalCandidates, ['hip_rocm']);
assert.deepEqual(unboundHipLanguage.classification.backendCandidates, []);

const wrongAuthorityHipLanguage = classifyCmake([
  'project(neutral_compute LANGUAGES CXX HIP)',
], { authority: 'named_project_declaration_only' });
assert.deepEqual(wrongAuthorityHipLanguage.summary.backendSignalCandidates, ['hip_rocm']);
assert.deepEqual(wrongAuthorityHipLanguage.classification.backendCandidates, []);

console.log('generic backend classifier self-check passed');
