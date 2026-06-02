import { describe, expect, it } from "vitest";
import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrDispatchProof,
  classifyGpuHmrEpochSwapProof,
  classifyGpuHmrFissionProof,
  classifyGpuHmrFullRuntimeProof,
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOriginalHostPathProof,
  classifyGpuHmrOutputProof,
  summarizeGpuHmrAbiProof,
  summarizeGpuHmrDispatchProof,
  summarizeGpuHmrEpochSwapProof,
  summarizeGpuHmrFissionProof,
  summarizeGpuHmrFullRuntimeProof,
  summarizeGpuHmrHostPreservationProof,
  summarizeGpuHmrOriginalHostPathProof,
  summarizeGpuHmrOutputProof,
} from "../../scripts/lib/gpu-hmr-runtime-proof.mjs";
import {
  abiProofFromProofArtifacts,
  artifactTransportProofFromProofArtifacts,
  fissionProofFromProofArtifacts,
  sourceProofFromProofArtifacts,
  summarizeGpuHmrArtifactTransportProof,
  summarizeGpuHmrSourceProof,
} from "../../scripts/lib/gpu-hmr-proof-artifacts.mjs";
import {
  epochSwapProofFromRuntimeEvidence,
  hostPreservationProofFromRuntimeEvidence,
  originalHostPathProofFromRuntimeEvidence,
  runtimeArtifactTransportEvidence,
  runtimeHostIdentityEvidence,
  runtimeOriginalHostPathEvidence,
  runtimeOutputOracleEvidence,
} from "../../scripts/lib/gpu-hmr-runtime-evidence.mjs";
import {
  dockerSnapshotFromInspect,
  validationCommandMetadata,
} from "../../scripts/lib/docker-validation-metadata.mjs";
import {
  REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS,
} from "../../scripts/lib/real-rocm-validation-command-env.mjs";
import {
  buildValidationRuntimeProofArtifact,
} from "../../scripts/lib/gpu-hmr-validation-proof-artifact.mjs";
import {
  buildGpuHmrValidationProofSummary,
} from "../../scripts/lib/gpu-hmr-validation-proof-summary.mjs";

const TEST_ARTIFACT_HASH = "1".repeat(64);
const TEST_ARTIFACT_ID = `artifact:sha256:${TEST_ARTIFACT_HASH}`;
const TEST_OTHER_ARTIFACT_ID = `artifact:sha256:${"2".repeat(64)}`;
const TEST_SCALAR_ARTIFACT_ID = `artifact:sha256:${"3".repeat(64)}`;
const TEST_DISPATCHER_ID = `dispatcher:sha256:${"4".repeat(64)}`;

function dispatchEvidenceRefs(runtimeSession = "runtime-session:test", kernel = "shade") {
  return [`worker-log:synthi_gpu_launch:${runtimeSession}:${kernel}`];
}

function acceptedAbiProof() {
  return classifyGpuHmrAbiProof({
    metadataObserved: true,
    layoutSizeAlignmentVerified: true,
    kernelAbiFingerprintHash: "d".repeat(64),
    constantGlobalLayoutHash: "e".repeat(64),
    evidenceRefs: ["evidence:device-abi-metadata:test"],
    extractorProvenance: [{
      kind: "clang_ast",
      evidenceId: "evidence:clang-ast:abc",
      extractorName: "test_clang_ast",
      extractorVersion: "v1",
      command: "clang++ -Xclang -ast-dump=json",
      inputHash: `sha256:${"a".repeat(64)}`,
    }],
  });
}

const TEST_OLD_ARTIFACT_HASH = "a".repeat(64);
const TEST_NEW_ARTIFACT_HASH = "b".repeat(64);
const TEST_CAPSULE_HASH = "c".repeat(64);
const TEST_ABI_HASH = "d".repeat(64);
const TEST_DEPENDENCY_HASH = "e".repeat(64);
const TEST_PROOF_HASH = "f".repeat(64);

function epochCapsuleMetadata({
  oldHash = TEST_OLD_ARTIFACT_HASH,
  newHash = TEST_ARTIFACT_HASH,
  capsuleHash = TEST_CAPSULE_HASH,
  abiHash = TEST_ABI_HASH,
  dependencyHash = TEST_DEPENDENCY_HASH,
  proofHash = TEST_PROOF_HASH,
  fissionIslandId = `fission-island:sha256:${TEST_PROOF_HASH}`,
  symbols = ["shade"],
  functionHandles = ["shade:0x10"],
  streamEpochCounters = { default: 3 },
} = {}) {
  return {
    oldArtifactId: `artifact:sha256:${oldHash}`,
    newArtifactId: `artifact:sha256:${newHash}`,
    newArtifactHash: `sha256:${newHash}`,
    capsuleId: `capsule:sha256:${capsuleHash}`,
    fissionIslandId,
    abiMembraneHash: `sha256:${abiHash}`,
    dependencyClosureHash: `sha256:${dependencyHash}`,
    proofHash: `sha256:${proofHash}`,
    changedSymbols: symbols,
    functionHandleIds: functionHandles,
    streamEpochCounters,
  };
}

function epochCapsuleFields(options = {}) {
  const metadata = epochCapsuleMetadata(options);
  const streamEpochCounters = Object.entries(metadata.streamEpochCounters)
    .map(([stream, epoch]) => `${stream}:${epoch}`)
    .join(",");
  return `old_artifact_id=${metadata.oldArtifactId} new_artifact_id=${metadata.newArtifactId} new_artifact_hash=${metadata.newArtifactHash} capsule_id=${metadata.capsuleId} fission_island_id=${metadata.fissionIslandId} abi_membrane_hash=${metadata.abiMembraneHash} dependency_closure_hash=${metadata.dependencyClosureHash} proof_hash=${metadata.proofHash} changed_symbols=${metadata.changedSymbols.join(",")} function_handle_ids=${metadata.functionHandleIds.join(",")} stream_epoch_counters=${streamEpochCounters}`;
}

function epochRetirementFields({
  retirementFenceIds = ["stream-sync:default:2->3"],
  delayedUnloadResult = "unloaded",
} = {}) {
  return `retirement_fence_ids=${retirementFenceIds.join(",")} delayed_unload_result=${delayedUnloadResult}`;
}

function epochGenerationGraph({
  previousGeneration = 2,
  activeGeneration = 3,
  publishTimestampMs = 1779979998000,
  dispatchTableHashBefore = "0xaaa",
  dispatchTableHashAfter = "0xabc",
  dispatchTableHash = dispatchTableHashAfter,
  changedEntries = 1,
  runtimeSession = "runtime-session:test",
  retirementState = "retired",
  capsuleMetadata = true,
  retirementFenceIds = [`stream-sync:default:${previousGeneration}->${activeGeneration}`],
  delayedUnloadResult = retirementState === "retired" ? "unloaded" : "pending",
} = {}) {
  const runtimeSessionFields = runtimeSession ? { runtimeSession } : {};
  const capsuleFields = capsuleMetadata ? epochCapsuleMetadata() : {};
  const publicationFields = { publishTimestampMs };
  const dispatchTableFields = {
    dispatchTableHashBefore,
    dispatchTableHashAfter,
    dispatchTableHash,
    changedEntries,
  };
  const retirementFields = { retirementFenceIds, delayedUnloadResult };
  return {
    schemaVersion: "synthi.gpu.epoch_graph.v1",
    runtimeSessionIds: runtimeSession ? [runtimeSession] : [],
    latestPublication: { previousGeneration, activeGeneration, ...publicationFields, ...capsuleFields, ...dispatchTableFields, ...retirementFields },
    retirementState,
    retirementRequired: retirementState !== "not-required",
    matchingRetirementObserved: retirementState === "retired",
    nodes: [
      {
        id: `generation:${previousGeneration}`,
        generation: previousGeneration,
        state: retirementState === "retired" ? "retired" : "pending-retirement",
      },
      {
        id: `generation:${activeGeneration}`,
        generation: activeGeneration,
        state: "published",
      },
    ],
    edges: [
      {
        kind: "publish",
        from: `generation:${previousGeneration}`,
        to: `generation:${activeGeneration}`,
        previousGeneration,
        activeGeneration,
        ...publicationFields,
        ...capsuleFields,
        ...dispatchTableFields,
        ...retirementFields,
        ...runtimeSessionFields,
      },
      ...(retirementState === "retired"
        ? [{
            kind: "retire",
            from: `generation:${previousGeneration}`,
            to: `generation:${activeGeneration}`,
            previousGeneration,
            activeGeneration,
            ...retirementFields,
            ...runtimeSessionFields,
          }]
        : []),
    ],
  };
}

function retiredEpochProof() {
  return classifyGpuHmrEpochSwapProof({
    published: true,
    runtimeSessionIds: ["runtime-session:test"],
    epochGenerationGraph: epochGenerationGraph(),
    dispatchTableHashObserved: true,
    dispatchTableHashBeforeObserved: true,
    dispatchTableHashAfterObserved: true,
    dispatchTableHashChanged: true,
    changedEntriesObserved: true,
    streamOrderingProven: true,
    streamScope: "affected",
    streamIds: ["default"],
    retirementFenceIds: ["stream-sync:default:2->3"],
    delayedUnloadResult: "unloaded",
    retirementTracked: true,
    oldGenerationRetired: true,
    evidenceRefs: ["evidence:epoch:abc"],
  });
}

function safeDispatchProof({
  runtimeSession = "runtime-session:test",
  artifactId = TEST_ARTIFACT_ID,
  dispatchTimestamp = 1779979999000,
} = {}) {
  return classifyGpuHmrDispatchProof({
    dispatchObserved: true,
    dispatchEvidenceRefs: dispatchEvidenceRefs(runtimeSession),
    sessionScoped: true,
    runtimeSessionIds: [runtimeSession],
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    argProvenanceEvidenceRefs: [
      `worker-log:launch_arg_provenance:test:${runtimeSession}:2`,
    ],
    argProvenanceRecords: [{
      argIndex: 0,
      category: "device_allocation",
      provenance: "runtime_observed",
      confidence: "verified",
      allocationId: "allocation:test",
      allocationSize: 8,
      valueSize: 8,
    }],
    argProvenanceRecordComplete: true,
    argProvenanceKnownArgCount: 1,
    abiProof: acceptedAbiProof(),
    epochProof: retiredEpochProof(),
    streamOrderingProven: true,
    replacementScopeProven: true,
    selectedArtifactIds: [artifactId],
    runtimeArtifactIds: [artifactId],
    dispatcherRegistrationIds: [TEST_DISPATCHER_ID],
    dispatchTableEntryIds: ["shade:0x10"],
    dispatchTableHashes: ["0xabc"],
    dispatchStreamIds: ["stream:default"],
    gridDimensions: ["1x1x1"],
    blockDimensions: ["64x1x1"],
    sharedMemoryBytes: [0],
    dispatchTimestamps: [dispatchTimestamp],
    runtimeArtifactMatchesSelected: true,
  });
}

function deterministicOutputOracle({
  runtimeSession = "runtime-session:test",
  artifactId = TEST_ARTIFACT_ID,
} = {}) {
  return {
    oracleId: "oracle:required:test-output",
    requiredOracleId: "oracle:required:test-output",
    kind: "sentinel_buffer_value",
    producer: "deterministic_probe",
    expected: "expected-sentinel",
    actual: "expected-sentinel",
    passed: true,
    outputTargetId: "output:sentinel",
    readbackTimestamp: "1779980000000",
    runtimeSessionId: runtimeSession,
    artifactId,
    probeMode: "fixed_validation_probe",
    probeConfigHash: `sha256:${"a".repeat(64)}`,
    probeEvidenceRefs: ["evidence:output-oracle:readback:abc"],
    evidenceRefs: ["evidence:output-oracle:readback:abc"],
  };
}

function preservedHostIdentityRefs() {
  return [
    "worker-log:host_identity:runner_process",
    "worker-log:host_identity:core_state",
    "worker-log:host_identity:stream",
  ];
}

function preservedHostSnapshotRefs() {
  return [
    "worker-log:host_identity_snapshot:runtime-session:test:runner_process:2->3",
    "worker-log:host_identity_snapshot:runtime-session:test:core_state:2->3",
    "worker-log:host_identity_snapshot:runtime-session:test:stream:2->3",
  ];
}

function preservedHostProof() {
  return classifyGpuHmrHostPreservationProof({
    identityChecksPassed: true,
    identitySnapshotObserved: true,
    identitySnapshotLineageObserved: true,
    requiredIdentityRolesObserved: true,
    identityEvidenceRefs: preservedHostIdentityRefs(),
    identitySnapshotEvidenceRefs: preservedHostSnapshotRefs(),
  });
}

function attachedOriginalHostPathProof() {
  return classifyGpuHmrOriginalHostPathProof({
    required: true,
    attachedToOriginalHostPath: true,
    runtimeEvidenceObserved: true,
    dispatchBoundaryObserved: true,
    dispatchEntryRuntimeVerified: true,
    sessionScoped: true,
    runtimeSessionIds: ["runtime-session:test"],
    evidenceRefs: ["worker-log:original_host_path:host-path:3"],
  });
}

function acceptedFissionVerificationCoverage() {
  const evidenceByCategory: Record<string, string[]> = {
    source_mapping: ["evidence:source-map"],
    include_closure: ["evidence:include-closure"],
    symbol_ownership: ["evidence:symbol-ownership"],
    dependency_closure: ["evidence:dependency-closure"],
    abi_membrane: ["evidence:abi-membrane"],
    compile_recipe: ["evidence:compile-recipe"],
    loader_capability: ["evidence:loader-capability"],
    output_oracle: ["evidence:output-oracle"],
  };
  const requiredCategories = Object.keys(evidenceByCategory);
  return {
    requiredCategories,
    missingCategories: [],
    categories: requiredCategories.map((category) => ({
      category,
      evidenceIds: evidenceByCategory[category],
    })),
  };
}

function acceptedSelectedIslandContract(islandId = "fission-island:abc") {
  return {
    schemaVersion: "synthi.gpu.fission_island.v1",
    islandId,
    sourceEditId: "source-edit:abc",
    sourcePaths: ["src/gpu/kernel.hpp"],
    sourceSpans: [{
      path: "src/gpu/kernel.hpp",
      startLine: 10,
      endLine: 24,
    }],
    generatedRolePath: ".synthi/generated/gpu/device.hip",
    generatedRolePathRequired: true,
    targetSymbols: ["kernel_main"],
    exportedSymbolsExpected: ["kernel_main"],
    artifactKind: "source_include_bridge",
    includeClosure: [{ path: "src/gpu/kernel.hpp" }],
    dependencyClosureHash: "b".repeat(64),
    abiMembraneId: "abi-membrane:abc",
    compileRecipeHash: "c".repeat(64),
    compileCommandHash: "d".repeat(64),
    loaderCapabilityRequirement: {
      acceptedTransports: ["ram_blob", "filesystem_path"],
      selectedArtifactId: TEST_ARTIFACT_ID,
    },
    requiredOracleId: "oracle:required:abc",
    originalHostLaunchMappingId: null,
    originalHostLaunchMappingRequired: false,
    verifierEvidenceIds: ["evidence:source-map"],
    verifierEvidenceId: `fission-verifier:sha256:${"a".repeat(64)}`,
    deterministicVerifierEvidenceIds: ["evidence:source-map"],
    verificationEvidenceCoverage: acceptedFissionVerificationCoverage(),
  };
}

function acceptedLaunchAttachmentProposal() {
  return {
    proposalId: `launch-attachment-proposal:sha256:${"4".repeat(64)}`,
    sourceLaunchSiteId: `launch-site:sha256:${"5".repeat(64)}`,
    hostPathId: `host-path:sha256:${"6".repeat(64)}`,
    path: "src/render_loop.cpp",
    line: 42,
    column: 17,
    sourceProvenance: "source_baseline_contents",
    sourceHash: `sha256:${"a".repeat(64)}`,
    snippetHash: `sha256:${"b".repeat(64)}`,
    instrumentationAction: "upgrade_runtime_boundary_to_original_host_attachment",
    requiredBoundaryApis: [
      "synthi_gpu_launch_source_location",
      "synthi_gpu_launch_original_host_path",
      "synthi_original_host_path_with_provenance",
    ],
    runtimeEvidenceRequired: {
      runtimeSessionScoped: true,
      dispatchBoundaryObserved: true,
      dispatchEntryRuntimeVerified: true,
      launchArgProvenanceComplete: true,
    },
    attachmentContract: {
      schemaVersion: "synthi.gpu.original_host_attachment_contract.v1",
      runtimeDispatchBoundary: {
        required: true,
        dispatchTableEntryIdSource: "runtime_boundary_active_generation",
        mustMatchActiveGenerationEntry: true,
        mustEmitSynthiLaunchDispatch: true,
      },
      launchArgumentProvenance: {
        required: true,
        source: "runtime_observed_launch_arguments",
        completeRequired: true,
        unknownArgumentsBlockFullRuntime: true,
      },
      streamOrdering: {
        required: true,
        source: "runtime_boundary_stream_token",
        mustSynchronizeAffectedStreamsBeforePublish: true,
      },
      hostPreservation: {
        runtimeIdentitySnapshotRequired: true,
        hostReplacementBlocksFullRuntime: true,
      },
      outputProof: {
        deterministicOracleRequired: true,
        visualEvidenceSupplementalOnly: true,
      },
    },
  };
}

function acceptedFissionProof() {
  return classifyGpuHmrFissionProof({
    required: true,
    observed: true,
    passed: true,
    evidenceRefs: ["evidence:fission-verifier-report:abc"],
    verifierEvidenceRefs: [`fission-verifier:sha256:${"a".repeat(64)}`],
    deterministicVerifierEvidenceRefs: ["evidence:fission-deterministic:abc"],
    selectedIslandIds: ["fission-island:abc"],
    selectedIslandContracts: [acceptedSelectedIslandContract()],
  });
}

function acceptedFissionVerifierMetadata() {
  const metadata = {
    schemaVersion: "synthi.gpu.fission_verifier.v1",
    selectionPolicy: "narrowest_viable_generic_v1",
    status: "pass",
    candidateCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    selectedIslandId: "island:sha256:abc",
    selectedCandidateIndex: 0,
    reasonCodes: ["fission.candidate_accepted"],
    candidates: [{
      status: "pass",
      selected: true,
      islandId: "island:sha256:abc",
      candidate: acceptedSelectedIslandContract("island:sha256:abc"),
      reasonCodes: ["fission.candidate_verified"],
      verifierEvidenceId: `fission-verifier:sha256:${"a".repeat(64)}`,
      deterministicVerifierEvidenceIds: ["evidence:source-map"],
      selectionScore: {
        policy: "narrowest_viable_generic_v1",
        comparisonOrder: [
          "scopeRank",
          "missingVerificationCategoryCount",
          "targetSymbolCount",
          "exportedSymbolOverage",
          "sourcePathCount",
          "includeClosureCount",
          "sourceSpanExtent",
          "compileCostPenaltyMs",
          "historicalTimingPenaltyMs",
        ],
        total: 1,
        scopeRank: 1,
        missingVerificationCategoryCount: 0,
        targetSymbolCount: 1,
        exportedSymbolOverage: 0,
        sourcePathCount: 1,
        includeClosureCount: 1,
        sourceSpanExtent: 15,
        compileCostPenaltyMs: 10,
        historicalTimingPenaltyMs: 20,
      },
      verificationEvidenceCoverage: acceptedFissionVerificationCoverage(),
      narrowerRejectionCoverage: {
        requiredRanks: [0],
        coveredRanks: [0],
        missingRanks: [],
      },
    }],
  };
  metadata.selectionDecision = {
    schemaVersion: "synthi.gpu.fission_selection_decision.v1",
    policy: "narrowest_viable_generic_v1",
    deterministic: true,
    comparisonOrder: [
      "scopeRank",
      "missingVerificationCategoryCount",
      "targetSymbolCount",
      "exportedSymbolOverage",
      "sourcePathCount",
      "includeClosureCount",
      "sourceSpanExtent",
      "compileCostPenaltyMs",
      "historicalTimingPenaltyMs",
    ],
    tieBreakers: ["verifierEvidenceId", "candidateIndex"],
    candidateCount: metadata.candidateCount,
    acceptedCount: metadata.acceptedCount,
    rejectedCount: metadata.rejectedCount,
    selectedCandidateIndex: metadata.selectedCandidateIndex,
    selectedIslandId: metadata.selectedIslandId,
    selectedVerifierEvidenceId: metadata.candidates[0].verifierEvidenceId,
    selectedScore: metadata.candidates[0].selectionScore,
    narrowerRejectionCoverage: metadata.candidates[0].narrowerRejectionCoverage,
  };
  return metadata;
}

function acceptedArtifactTransportProof() {
  return {
    schemaVersion: "synthi.gpu.hmr.artifact_transport_proof.v1",
    resultState: "gpu-hmr-artifact-transport-proven",
    transportEvidenceObserved: true,
    ramTransportProven: true,
    ramArtifactReferenceProvided: true,
    ramBlobIdentityProven: true,
    selectedArtifactIds: [TEST_ARTIFACT_ID],
    artifactContentHashes: [`sha256:${TEST_ARTIFACT_HASH}`],
    ramBlobIds: [TEST_ARTIFACT_ID],
    ramBytesHashes: [`sha256:${TEST_ARTIFACT_HASH}`],
    loaderTransports: ["ram_bytes"],
    reloadRequestTransports: ["ram_blob"],
    evidenceRefs: ["worker-log:artifact_transport:sha256:abc"],
    degradedState: null,
    degradedReason: null,
  };
}

function acceptedSourceProof(options: {
  partial?: boolean;
  compileOnly?: boolean;
} = {}) {
  const compileRefs = ["evidence:source:device-artifact", "evidence:source:device-compiler"];
  const symbolRefs = options.compileOnly ? [] : ["evidence:source:device-symbols"];
  return {
    schemaVersion: "synthi.gpu.hmr.source_proof.v1",
    resultState: options.compileOnly ? "gpu-hmr-compile-proven" : "gpu-hmr-symbol-bound",
    degradedState: null,
    degradedReason: options.compileOnly ? "device_symbol_evidence_unverified" : null,
    compileEvidenceObserved: true,
    compileProven: true,
    symbolBindingEvidenceObserved: !options.compileOnly,
    symbolBindingProven: !options.compileOnly,
    sourceProofProven: !options.compileOnly,
    proofArtifactPaths: [".synthi/gpu-hmr/proofs/source-proof.json"],
    artifactIds: [TEST_ARTIFACT_ID],
    evidenceRefs: [...compileRefs, ...symbolRefs],
    compileEvidenceRefs: compileRefs,
    symbolEvidenceRefs: symbolRefs,
    partialArtifactReplacement: options.partial === true,
    partialModule: options.partial === true,
    label: options.partial ? "gpu-hmr-partial" : "gpu-hmr-full-device",
    selectedArtifactKind: options.partial ? "partial_device_region" : "full_device",
    requestedArtifactKind: options.partial ? "partial_device_region" : "full_device",
  };
}

function sourceProofArtifactRecord({
  artifactHash = "a".repeat(64),
  compilerHash = "b".repeat(64),
  symbolHash = "c".repeat(64),
  symbolBound = true,
  artifactBytes = 128,
  compileProvenance = {},
} = {}) {
  const artifactId = `artifact:sha256:${artifactHash}`;
  const artifactEvidenceId = `evidence:device-artifact:${artifactHash}`;
  const compilerEvidenceId = `evidence:device-compiler:${compilerHash}`;
  const symbolEvidenceId = `evidence:device-symbols:${symbolHash}`;
  return {
    proofArtifactPath: "/tmp/gpu-hmr-proof.json",
    artifact: {
      proofId: "proof:gpu-hmr:source",
      evidenceRefs: [
        {
          kind: "device-artifact",
          evidenceId: artifactEvidenceId,
          contentHash: `sha256:${artifactHash}`,
          artifactUri: artifactId,
          metadata: {
            artifactBytes,
            partialModule: true,
            selectedArtifactKind: "partial_device_region",
            requestedArtifactKind: "partial_device_region",
          },
        },
        {
          kind: "device-compiler-output",
          evidenceId: compilerEvidenceId,
          contentHash: `sha256:${compilerHash}`,
          metadata: {
            compilerElapsedMs: 12,
            stderrBytes: 0,
            compileProvenance: {
              compilerExecutable: "/toolchain/device-compiler",
              compilerIdentity: "compiler-identity",
              deviceCompiler: "device-compiler",
              gpuVendor: "generic-vendor",
              gpuArch: ["generic-arch"],
              targetTriple: "generic-vendor:generic-arch",
              sdkVersion: "sdk:version",
              sourceFilename: "src/device.kernel",
              compileCommandHash: "compile-command-hash",
              dependencyHash: "dependency-hash",
              dependencyMethod: "dependency-metadata",
              artifactCacheKey: "artifact-cache-key",
              ...compileProvenance,
            },
          },
        },
        {
          kind: "device-symbol-set",
          evidenceId: symbolEvidenceId,
          contentHash: `sha256:${symbolHash}`,
          artifactUri: artifactId,
          metadata: {
            targetSymbols: ["device_kernel"],
            artifactExportedSymbols: ["device_kernel_export"],
            symbolBound,
          },
        },
      ],
      stageResults: [
        {
          stageId: "device-compile",
          status: "passed",
          outputArtifactIds: [artifactId],
          evidenceRefs: [artifactEvidenceId, compilerEvidenceId],
        },
        {
          stageId: "symbol-binding",
          status: symbolBound ? "passed" : "blocked",
          outputArtifactIds: symbolBound ? [artifactId] : [],
          evidenceRefs: [symbolEvidenceId],
          degradedReason: symbolBound ? null : "expected_device_symbols_not_bound",
        },
      ],
    },
  };
}

describe("validation runtime metadata", () => {
  it("normalizes docker inspect identity and compose state", () => {
    const snapshot = dockerSnapshotFromInspect(
      JSON.stringify([
        {
          Id: "container-id",
          Name: "/project-worker-1",
          Image: "sha256:image-id",
          Config: {
            Image: "project-worker:latest",
            Labels: {
              "com.docker.compose.project": "project",
              "com.docker.compose.service": "worker",
              "com.docker.compose.container-number": "1",
            },
          },
          State: {
            Status: "running",
            Pid: 123,
            StartedAt: "2026-05-27T10:00:00Z",
            FinishedAt: "0001-01-01T00:00:00Z",
            OOMKilled: false,
            ExitCode: 0,
          },
          RestartCount: 2,
        },
      ]),
      "worker-container"
    );

    expect(snapshot.available).toBe(true);
    expect(snapshot.name).toBe("project-worker-1");
    expect(snapshot.image_id).toBe("sha256:image-id");
    expect(snapshot.config_image).toBe("project-worker:latest");
    expect(snapshot.compose_project).toBe("project");
    expect(snapshot.compose_service).toBe("worker");
    expect(snapshot.status).toBe("running");
    expect(snapshot.restart_count).toBe(2);
  });

  it("records only requested validation command env keys", () => {
    const metadata = validationCommandMetadata({
      cwd: "/repo",
      argv: ["node", "script.mjs"],
      env: {
        SYNTHI_GPU_VENDOR: "rocm",
        SECRET_TOKEN: "hidden",
      },
      envKeys: ["SYNTHI_GPU_VENDOR", "SYNTHI_GPU_ARCH"],
    });

    expect(metadata.cwd).toBe("/repo");
    expect(metadata.argv).toEqual(["node", "script.mjs"]);
    expect(metadata.env).toEqual({
      SYNTHI_GPU_VENDOR: "rocm",
      SYNTHI_GPU_ARCH: "",
    });
    expect(Object.prototype.hasOwnProperty.call(metadata.env, "SECRET_TOKEN")).toBe(false);
  });

  it("captures run-defining real repository validation env keys without ambient secrets", () => {
    const metadata = validationCommandMetadata({
      cwd: "/repo",
      argv: ["node", "scripts/gpu-hmr-real-rocm-repo-validation.mjs"],
      env: {
        SYNTHI_REAL_ROCM_DELTA_BEFORE: "old()",
        MCP_TRANSPORT: "docker",
        SYNTHI_VALIDATION_AUTHLESS_WORKSPACE: "1",
        GOOGLE_API_KEY: "secret",
      },
      envKeys: [
        "SYNTHI_REAL_ROCM_DELTA_BEFORE",
        "SYNTHI_REAL_ROCM_DELTA_AFTER",
        "MCP_TRANSPORT",
        "SYNTHI_VALIDATION_AUTHLESS_WORKSPACE",
      ],
    });

    expect(metadata.env).toEqual({
      SYNTHI_REAL_ROCM_DELTA_BEFORE: "old()",
      SYNTHI_REAL_ROCM_DELTA_AFTER: "",
      MCP_TRANSPORT: "docker",
      SYNTHI_VALIDATION_AUTHLESS_WORKSPACE: "1",
    });
    expect(Object.prototype.hasOwnProperty.call(metadata.env, "GOOGLE_API_KEY")).toBe(false);
  });

  it("keeps the real repository validation command allow-list complete and non-secret", () => {
    expect(REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS).toEqual(
      expect.arrayContaining([
        "SYNTHI_REAL_ROCM_DELTA_BEFORE",
        "SYNTHI_REAL_ROCM_DELTA_AFTER",
        "SYNTHI_REAL_ROCM_BUILD_METADATA_DIR",
        "SYNTHI_REAL_ROCM_OUTPUT_ORACLE_JSON",
        "MCP_TRANSPORT",
        "SYNTHI_VALIDATION_AUTHLESS_WORKSPACE",
      ])
    );
    expect(REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS).not.toContain("GOOGLE_API_KEY");
    expect(REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS).not.toContain("GEMINI_API_KEY");
  });
});

describe("GPU HMR runtime output proof classification", () => {
  it("requires dispatch before output proof can be considered", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchObserved: false,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
  });

  it("reports visual-only when a frame exists without a deterministic oracle", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-only");
    expect(summarizeGpuHmrOutputProof(proof)).toContain("gpu-hmr-visual-only");
  });

  it("reports output-unobserved when dispatch has no output evidence", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
  });

  it("reports output-proven only for a passing deterministic oracle", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.outputOracle.passed).toBe(true);
    expect(proof.outputOracle.kind).toBe("sentinel_buffer_value");
    expect(proof.outputOracle.artifactMatchesDispatch).toBe(true);
    expect(proof.outputOracle.dispatchArtifactIds).toEqual([TEST_ARTIFACT_ID]);
  });

  it("requires visual evidence for render output oracle kinds", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        kind: "render_target_hash",
        outputTargetId: "render-target:rgba32f",
        expected: `sha256:${"4".repeat(64)}`,
        actual: `sha256:${"4".repeat(64)}`,
      },
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-evidence-missing");
    expect(proof.degradedReason).toBe("visual_frame_not_observed");
    expect(proof.renderVisualEvidenceRequired).toBe(true);
    expect(proof.visualEvidenceRequired).toBe(true);
    expect(proof.outputOracle.passed).toBe(true);
  });

  it("accepts render output oracle proof when visual evidence is present", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        kind: "selected_pixels",
        outputTargetId: "render-target:rgba32f",
        expected: [0.1, 0.2, 0.3, 1],
        actual: [0.1, 0.2, 0.3, 1],
        tolerance: 0,
        visualEvidenceRefs: ["validation:screenshot:after-hmr"],
      },
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.renderVisualEvidenceRequired).toBe(true);
    expect(proof.visualEvidenceComplete).toBe(true);
    expect(proof.visualEvidenceRefs).toEqual(["validation:screenshot:after-hmr"]);
  });

  it("rejects raw log snippets as output oracle evidence", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        evidenceRefs: ["[gpu-demo] trend=expected"],
      },
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-only");
    expect(proof.degradedReason).toBe("output_oracle_evidence_unaccepted");
    expect(proof.outputOracle.evidenceRefs).toEqual([]);
    expect(proof.outputOracle.rejectedEvidenceRefs).toEqual(["[gpu-demo] trend=expected"]);
  });

  it("does not prove output without a deterministic probe contract", () => {
    const { probeMode: _probeMode, probeConfigHash: _probeConfigHash, probeEvidenceRefs: _probeEvidenceRefs, ...oracle } =
      deterministicOutputOracle();
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: oracle,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-only");
    expect(proof.degradedReason).toBe("output_oracle_probe_contract_missing");
    expect(proof.outputOracle.probeContractComplete).toBe(false);
  });

  it("does not prove output when the oracle record has no passing status", () => {
    const { passed: _passed, ...oracleWithoutStatus } = deterministicOutputOracle();
    const missingStatus = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: oracleWithoutStatus,
      visualFrameObserved: true,
    });

    expect(missingStatus.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(missingStatus.degradedReason).toBe("output_oracle_pass_status_missing");
    expect(missingStatus.outputOracle.passStatusObserved).toBe(false);

    const reportedFailure = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        passed: false,
      },
      visualFrameObserved: true,
    });

    expect(reportedFailure.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(reportedFailure.degradedReason).toBe("output_oracle_reported_failed");
    expect(reportedFailure.outputOracle.reportedPassed).toBe(false);
  });

  it("does not prove output without a bound oracle contract id", () => {
    const { oracleId: _oracleId, requiredOracleId: _requiredOracleId, ...oracleWithoutId } =
      deterministicOutputOracle();
    const missingId = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: oracleWithoutId,
      visualFrameObserved: true,
    });

    expect(missingId.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(missingId.degradedReason).toBe("output_oracle_contract_id_missing");
    expect(missingId.outputOracle.contractIdObserved).toBe(false);

    const { requiredOracleId: _missingRequiredOracleId, ...oracleWithoutRequiredId } =
      deterministicOutputOracle();
    const missingRequiredId = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: oracleWithoutRequiredId,
      visualFrameObserved: true,
    });

    expect(missingRequiredId.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(missingRequiredId.degradedReason).toBe("output_oracle_required_contract_id_missing");
    expect(missingRequiredId.outputOracle.contractIdObserved).toBe(true);
    expect(missingRequiredId.outputOracle.requiredContractObserved).toBe(false);
    expect(missingRequiredId.outputOracle.requiredContractMatched).toBe(false);

    const mismatchedRequiredId = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        oracleId: "oracle:required:observed",
        requiredOracleId: "oracle:required:expected",
      },
      visualFrameObserved: true,
    });

    expect(mismatchedRequiredId.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(mismatchedRequiredId.degradedReason).toBe("output_oracle_contract_mismatch");
    expect(mismatchedRequiredId.outputOracle.requiredContractMatched).toBe(false);
  });

  it("blocks render output proof when required visual evidence is missing", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualEvidenceRequired: true,
      visualFrameObserved: false,
      visualEvidenceRefs: [],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-evidence-missing");
    expect(proof.degradedReason).toBe("visual_frame_not_observed");
    expect(proof.outputOracle.passed).toBe(true);
    expect(proof.visualEvidenceComplete).toBe(false);
  });

  it("accepts render output proof when oracle and visual evidence are both present", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualEvidenceRequired: true,
      visualFrameObserved: true,
      visualEvidenceRefs: ["artifacts/frame.png"],
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.visualEvidenceComplete).toBe(true);
    expect(proof.visualEvidenceRefs).toEqual(["artifacts/frame.png"]);
  });

  it("accepts render visual evidence refs carried by the oracle record", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        visualEvidenceRef: "artifacts/oracle-frame.png",
      },
      visualEvidenceRequired: true,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.visualEvidenceComplete).toBe(true);
    expect(proof.visualEvidenceRefs).toEqual(["artifacts/oracle-frame.png"]);
  });

  it("can prove output from a structured runtime oracle line", () => {
    const evidence = runtimeOutputOracleEvidence([
      `[gpu-runtime-boundary] output_oracle id=probe.checksum required_oracle_id=probe.checksum kind=buffer_checksum producer=runtime_probe expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=${TEST_ARTIFACT_ID} probe_mode=fixed_validation_probe probe_config_hash=sha256:${"b".repeat(64)}`,
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof({ runtimeSession: "pid1", artifactId: TEST_ARTIFACT_ID }),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.total_count).toBe(1);
    expect(evidence.output_oracle?.actual).toBe("sha256:abc");
    expect(evidence.output_oracle?.requiredOracleId).toBe("probe.checksum");
    expect(evidence.output_oracle?.runtimeSession).toBe("pid1");
    expect(evidence.output_oracle?.outputTargetId).toBe("target:main");
    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.outputOracle.evidenceRefs).toEqual(["worker-log:output_oracle:probe.checksum"]);
    expect(proof.outputOracle.probeContractComplete).toBe(true);
    expect(proof.outputOracle.readbackAfterDispatch).toBe(true);
  });

  it("rejects output oracle-shaped records without runtime boundary provenance", () => {
    const evidence = runtimeOutputOracleEvidence([
      `application-log output_oracle id=probe.checksum kind=buffer_checksum producer=runtime_probe expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=${TEST_ARTIFACT_ID} probe_mode=fixed_validation_probe probe_config_hash=sha256:${"b".repeat(64)}`,
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof({ runtimeSession: "pid1", artifactId: TEST_ARTIFACT_ID }),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.total_count).toBe(0);
    expect(evidence.matched_count).toBe(0);
    expect(evidence.output_oracle).toBeNull();
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(proof.degradedReason).toBe("output_oracle_not_collected");
  });

  it("does not prove output from a runtime oracle missing provenance fields", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.checksum kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1",
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof({ runtimeSession: "pid1" }),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.deterministic_oracle_passed).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_provenance_incomplete");
    expect(proof.outputOracle.provenanceComplete).toBe(false);
  });

  it("does not prove output from an oracle missing runtime session provenance", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        runtimeSessionId: undefined,
      },
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_provenance_incomplete");
    expect(proof.outputOracle.runtimeSessionId).toBeNull();
    expect(proof.outputOracle.provenanceComplete).toBe(false);
  });

  it("does not prove output from an oracle with malformed readback timestamp provenance", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        readbackTimestamp: "after-dispatch",
      },
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_provenance_incomplete");
    expect(proof.outputOracle.readbackTimestamp).toBeNull();
    expect(proof.outputOracle.provenanceComplete).toBe(false);
  });

  it("does not prove output when dispatch timestamp provenance is missing", () => {
    const dispatchProof = {
      ...safeDispatchProof(),
      dispatchTimestamps: [],
    };
    const proof = classifyGpuHmrOutputProof({
      dispatchProof,
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_dispatch_timestamp_missing");
    expect(proof.outputOracle.dispatchTimestampObserved).toBe(false);
    expect(proof.outputOracle.readbackAfterDispatch).toBe(false);
  });

  it("does not prove output when oracle readback precedes dispatch evidence", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof({ dispatchTimestamp: 1779980000001 }),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_precedes_dispatch");
    expect(proof.outputOracle.latestDispatchTimestamp).toBe(1779980000001);
    expect(proof.outputOracle.readbackAfterDispatch).toBe(false);
  });

  it("does not prove output from an oracle bound to a different runtime session", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        runtimeSessionId: "runtime-session:old",
      },
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_session_mismatch");
    expect(proof.outputOracle.provenanceComplete).toBe(true);
    expect(proof.outputOracle.runtimeSessionMatchesDispatch).toBe(false);
  });

  it("does not prove output from an oracle bound to a different runtime artifact", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        artifactId: TEST_OTHER_ARTIFACT_ID,
      },
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedReason).toBe("output_oracle_artifact_mismatch");
    expect(proof.outputOracle.provenanceComplete).toBe(true);
    expect(proof.outputOracle.runtimeSessionMatchesDispatch).toBe(true);
    expect(proof.outputOracle.artifactMatchesDispatch).toBe(false);
    expect(proof.outputOracle.dispatchArtifactIds).toEqual([TEST_ARTIFACT_ID]);
  });

  it("only accepts runtime oracle records matching an explicit contract", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.other kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=artifact:def",
    ], {
      expectedOracle: {
        id: "probe.expected",
        kind: "buffer_checksum",
        expected: "sha256:def",
      },
    });

    expect(evidence.total_count).toBe(2);
    expect(evidence.matched_count).toBe(1);
    expect(evidence.output_oracle?.oracleId).toBe("probe.expected");
    expect(evidence.output_oracle?.actual).toBe("sha256:def");
    expect(evidence.output_oracle?.runtimeSession).toBe("pid1");
    expect(evidence.evidence_refs).toEqual(["worker-log:output_oracle:probe.expected"]);
  });

  it("filters runtime oracle records by contract provenance fields", () => {
    const outputOracleContract = {
      oracleId: "probe.expected",
      requiredOracleId: "probe.expected",
      kind: "buffer_checksum",
      expected: "sha256:def",
      producer: "runtime_probe",
      outputTargetId: "target:main",
      artifactId: "artifact:def",
      runtimeSessionId: "pid1",
    };
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:other readback_timestamp=1779980000000 artifact_id=artifact:def",
      "[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=artifact:def",
      "[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid2 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=artifact:def",
    ], { outputOracleContract });
    const mismatchedArtifact = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=artifact:other",
    ], { outputOracleContract });
    const missingRequiredContract = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main readback_timestamp=1779980000000 artifact_id=artifact:def",
    ], { outputOracleContract });

    expect(evidence.matched_count).toBe(1);
    expect(evidence.output_oracle?.outputTargetId).toBe("target:main");
    expect(evidence.output_oracle?.artifactId).toBe("artifact:def");
    expect(evidence.output_oracle?.requiredOracleId).toBe("probe.expected");
    expect(evidence.expected_contract?.outputTargetId).toBe("target:main");
    expect(evidence.expected_contract?.requiredOracleId).toBe("probe.expected");
    expect(mismatchedArtifact.matched_count).toBe(0);
    expect(mismatchedArtifact.deterministic_oracle_passed).toBe(false);
    expect(missingRequiredContract.matched_count).toBe(0);
    expect(missingRequiredContract.deterministic_oracle_passed).toBe(false);
  });

  it("only accepts runtime oracle records from the expected runtime session", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=old-session",
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:bad passed=false generation=3 runtime_session=current-session",
    ], {
      expectedOracle: {
        id: "probe.expected",
        kind: "buffer_checksum",
        expected: "sha256:def",
      },
      runtimeSessionIds: ["current-session"],
    });

    expect(evidence.total_count).toBe(2);
    expect(evidence.matched_count).toBe(1);
    expect(evidence.output_oracle?.runtimeSession).toBe("current-session");
    expect(evidence.deterministic_oracle_passed).toBe(false);
  });

  it("does not accept exact runtime oracle records whose expected and actual values differ", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:bad passed=true generation=3 runtime_session=pid1",
    ]);

    expect(evidence.expected_actual_match).toBe(false);
    expect(evidence.deterministic_output_observed).toBe(true);
    expect(evidence.deterministic_oracle_provided).toBe(true);
    expect(evidence.deterministic_oracle_passed).toBe(false);
  });

  it("does not mark runtime oracle evidence as passed for unaccepted oracle kinds", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.visual kind=visual_change_only expected=changed actual=changed passed=true generation=3 runtime_session=pid1",
    ]);

    expect(evidence.total_count).toBe(1);
    expect(evidence.oracle_kind_accepted).toBe(false);
    expect(evidence.deterministic_output_observed).toBe(true);
    expect(evidence.deterministic_oracle_provided).toBe(false);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(evidence.output_oracle?.kindAccepted).toBe(false);
  });

  it("accepts tolerant numeric runtime oracle records only inside tolerance", () => {
    const evidence = runtimeOutputOracleEvidence([
      `[gpu-runtime-boundary] output_oracle id=probe.scalar required_oracle_id=probe.scalar kind=sentinel_buffer_value producer=runtime_probe expected=1.0 actual=1.005 tolerance=0.01 passed=true generation=3 runtime_session=pid1 output_target_id=target:scalar readback_timestamp=1779980000000 artifact_id=${TEST_SCALAR_ARTIFACT_ID} probe_mode=fixed_validation_probe probe_config_hash=sha256:${"c".repeat(64)}`,
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof({ runtimeSession: "pid1", artifactId: TEST_SCALAR_ARTIFACT_ID }),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.expected_actual_match).toBe(false);
    expect(evidence.expected_actual_compatible).toBe(true);
    expect(evidence.tolerance_applied).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.outputOracle.toleranceApplied).toBe(true);
  });

  it("rejects tolerant numeric runtime oracle records outside tolerance", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.scalar kind=sentinel_buffer_value expected=1.0 actual=1.05 tolerance=0.01 passed=true generation=3 runtime_session=pid1",
    ]);
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: evidence.deterministic_output_observed,
      deterministicOracleProvided: evidence.deterministic_oracle_provided,
      deterministicOraclePassed: evidence.deterministic_oracle_passed,
      outputOracle: evidence.output_oracle,
      evidenceRefs: evidence.evidence_refs,
    });

    expect(evidence.expected_actual_compatible).toBe(false);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("does not treat a nonnumeric tolerance as proof for mismatched oracle values", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        kind: "sentinel_buffer_value",
        expected: "expected-sentinel",
        actual: "other-sentinel",
        tolerance: "loose",
        evidenceRefs: ["worker-log:output_oracle:probe.expected"],
      },
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.outputOracle.valuesCompatible).toBe(false);
    expect(proof.outputOracle.toleranceValid).toBe(false);
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("does not accept runtime oracle records without session provenance", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.expected kind=buffer_checksum expected=sha256:def actual=sha256:def passed=true generation=3",
    ]);

    expect(evidence.total_count).toBe(0);
    expect(evidence.deterministic_output_observed).toBe(false);
    expect(evidence.output_oracle).toBeNull();
  });

  it("does not prove output when runtime oracle records miss the contract", () => {
    const evidence = runtimeOutputOracleEvidence([
      "[gpu-runtime-boundary] output_oracle id=probe.other kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1",
    ], {
      expectedOracle: {
        id: "probe.expected",
      },
    });

    expect(evidence.total_count).toBe(1);
    expect(evidence.matched_count).toBe(0);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(evidence.output_oracle).toBeNull();
  });

  it("does not mark missing runtime oracle evidence as observed", () => {
    const evidence = runtimeOutputOracleEvidence([]);

    expect(evidence.total_count).toBe(0);
    expect(evidence.deterministic_output_observed).toBe(false);
    expect(evidence.deterministic_oracle_provided).toBe(false);
    expect(evidence.deterministic_oracle_passed).toBe(false);
    expect(evidence.output_oracle).toBeNull();
  });

  it("does not prove output from oracle booleans without a concrete oracle record", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      visualFrameObserved: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-only");
    expect(proof.outputOracle.provided).toBe(false);
    expect(proof.outputOracle.observed).toBe(false);
  });

  it("does not prove output from an oracle payload without concrete evidence refs", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        kind: "sentinel_buffer_value",
        expected: "expected-sentinel",
        actual: "expected-sentinel",
      },
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
    expect(proof.outputOracle.provided).toBe(true);
    expect(proof.outputOracle.observed).toBe(true);
    expect(proof.outputOracle.evidenceObserved).toBe(false);
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("does not prove exact output when expected and actual oracle values differ", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        kind: "sentinel_buffer_value",
        expected: "expected-sentinel",
        actual: "other-sentinel",
        evidenceRefs: ["worker-log:output_oracle:probe.expected"],
      },
      visualFrameObserved: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
    expect(proof.outputOracle.valuesCompatible).toBe(false);
    expect(proof.outputOracle.passed).toBe(false);
  });

  it("reports host replacement only from explicit restart or replacement evidence", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      hostRestartObserved: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(summarizeGpuHmrHostPreservationProof(proof)).toContain("gpu-hmr-host-replaced");
  });

  it("does not prove host preservation without identity checks", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      hostRestartObserved: false,
      identityChecksPassed: false,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("reports host-preservation-proven only when identity checks pass", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      identitySnapshotLineageObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: preservedHostIdentityRefs(),
      identitySnapshotEvidenceRefs: preservedHostSnapshotRefs(),
    });

    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.runtimeIdentityEvidenceRefs).toEqual(preservedHostIdentityRefs());
    expect(proof.runtimeIdentitySnapshotEvidenceRefs).toEqual(preservedHostSnapshotRefs());
    expect(proof.identityRoleCategories).toEqual([
      "host_state",
      "runner_process",
      "runtime_resource",
    ]);
    expect(proof.requiredIdentityRoleEvidenceRefsComplete).toBe(true);
  });

  it("does not prove host preservation from role refs without runtime snapshot evidence refs", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      identitySnapshotLineageObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: preservedHostIdentityRefs(),
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_snapshot_evidence_refs_not_collected");
    expect(proof.runtimeIdentitySnapshotEvidenceRefs).toEqual([]);
  });

  it("does not prove host preservation when required runtime role categories are not evidenced", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      identitySnapshotLineageObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: ["worker-log:host_identity:runner_process"],
      identitySnapshotEvidenceRefs: [
        "worker-log:host_identity_snapshot:runtime-session:test:runner_process:2->3",
      ],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_required_role_evidence_refs_incomplete");
    expect(proof.missingRequiredIdentityRoleCategories).toEqual([
      "host_state",
      "runtime_resource",
    ]);
  });

  it("does not prove host preservation from identity booleans without evidence refs", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      requiredIdentityRolesObserved: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_evidence_refs_not_collected");
    expect(proof.identityEvidenceObserved).toBe(false);
  });

  it("does not prove host preservation from asserted checks without runtime snapshots", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identityEvidenceRefs: ["worker-log:host_identity:core_state"],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_snapshots_not_collected");
    expect(proof.identitySnapshotObserved).toBe(false);
  });

  it("does not prove host preservation from snapshots without epoch lineage", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: preservedHostIdentityRefs(),
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_epoch_lineage_not_collected");
    expect(proof.identitySnapshotLineageObserved).toBe(false);
  });

  it("does not prove host preservation from non-runtime identity evidence refs", () => {
    const proof = classifyGpuHmrHostPreservationProof({
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceRefs: ["identity-proof:1"],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_evidence_refs_not_collected");
    expect(proof.runtimeIdentityEvidenceRefs).toEqual([]);
  });

  it("does not prove ABI without collected metadata evidence", () => {
    const proof = classifyGpuHmrAbiProof({});

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_evidence_not_collected");
    expect(summarizeGpuHmrAbiProof(proof)).toContain("metadata=missing");
  });

  it("treats metadata-only ABI evidence as symbol-bound but unverified", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      evidenceRefs: ["evidence:device-abi-metadata:abc"],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_layout_size_alignment_unverified");
    expect(proof.evidenceRefs).toEqual(["evidence:device-abi-metadata:abc"]);
    expect(summarizeGpuHmrAbiProof(proof)).toContain("layout=unverified");
  });

  it("reports ABI-proven only when layout, size, and alignment were verified", () => {
    const proof = acceptedAbiProof();

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.layoutSizeAlignmentVerified).toBe(true);
    expect(proof.acceptedExtractorProvenanceObserved).toBe(true);
    expect(proof.abiFingerprintHashesObserved).toBe(true);
    expect(proof.acceptedExtractorCommands).toEqual(["clang++ -Xclang -ast-dump=json"]);
    expect(proof.acceptedExtractorInputHashes).toEqual([`sha256:${"a".repeat(64)}`]);
  });

  it("does not prove ABI when accepted extractor provenance is missing", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      evidenceRefs: ["evidence:device-abi-layout:abc"],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_extractor_provenance_unverified");
    expect(summarizeGpuHmrAbiProof(proof)).toContain("extractor=unverified");
  });

  it("does not prove ABI from accepted extractor refs without concrete provenance", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      acceptedExtractorEvidenceRefs: ["evidence:clang-ast:abc"],
      acceptedExtractorSources: ["clang_ast"],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_extractor_provenance_unverified");
    expect(proof.acceptedExtractorProvenanceObserved).toBe(false);
  });

  it("does not prove ABI without extractor command and digest input provenance", () => {
    const missingCommand = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      kernelAbiFingerprintHash: "d".repeat(64),
      constantGlobalLayoutHash: "e".repeat(64),
      extractorProvenance: [{
        extractorKind: "clang_ast",
        evidenceId: "evidence:clang-ast:abc",
        extractorName: "test_clang_ast",
        extractorVersion: "v1",
        inputHash: `sha256:${"a".repeat(64)}`,
      }],
    });
    const invalidInputHash = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      kernelAbiFingerprintHash: "d".repeat(64),
      constantGlobalLayoutHash: "e".repeat(64),
      extractorProvenance: [{
        extractorKind: "clang_ast",
        evidenceId: "evidence:clang-ast:abc",
        extractorName: "test_clang_ast",
        extractorVersion: "v1",
        command: "clang++ -Xclang -ast-dump=json",
        inputHash: "sha256:abc",
      }],
    });

    expect(missingCommand.resultState).toBe("gpu-hmr-symbol-bound");
    expect(missingCommand.degradedReason).toBe("abi_extractor_provenance_unverified");
    expect(invalidInputHash.resultState).toBe("gpu-hmr-symbol-bound");
    expect(invalidInputHash.degradedReason).toBe("abi_extractor_provenance_unverified");
  });

  it("does not prove ABI without kernel and constant/global ABI fingerprints", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      extractorProvenance: [{
        extractorKind: "clang_record_layout",
        evidenceId: "evidence:clang-record-layout:abc",
        extractorName: "test_clang_record_layout",
        extractorVersion: "v1",
        command: "clang++ -Xclang -fdump-record-layouts",
        inputHash: `sha256:${"a".repeat(64)}`,
      }],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_fingerprint_hashes_unverified");
    expect(proof.abiFingerprintHashesObserved).toBe(false);
  });

  it("does not prove ABI from placeholder fingerprint values", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      kernelAbiFingerprintHash: "unknown",
      constantGlobalLayoutHash: "0",
      extractorProvenance: [{
        extractorKind: "clang_record_layout",
        evidenceId: "evidence:clang-record-layout:abc",
        extractorName: "test_clang_record_layout",
        extractorVersion: "v1",
        command: "clang++ -Xclang -fdump-record-layouts",
        inputHash: `sha256:${"a".repeat(64)}`,
      }],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_fingerprint_hashes_unverified");
    expect(proof.kernelAbiFingerprintHashes).toEqual([]);
    expect(proof.constantGlobalLayoutHashes).toEqual([]);
  });

  it("rejects extractor provenance explicitly rejected by the runtime correctness plan", () => {
    const proof = classifyGpuHmrAbiProof({
      metadataObserved: true,
      layoutSizeAlignmentVerified: true,
      extractorProvenance: [{
        extractorKind: "clang_ast",
        evidenceId: "evidence:clang-ast:abc",
        extractorName: "test_clang_ast",
        extractorVersion: "v1",
        command: "clang++ -Xclang -ast-dump=json",
        inputHash: `sha256:${"a".repeat(64)}`,
        acceptedByRuntimeCorrectnessPlan: false,
      }],
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_extractor_provenance_unverified");
    expect(proof.acceptedExtractorEvidenceRefs).toEqual([]);
  });

  it("keeps ABI proof unverified when artifact metadata only has rejected source-scan provenance", () => {
    const proof = abiProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-abi-metadata",
          evidenceId: "evidence:device-abi-metadata:abc",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.abi_metadata.v1",
            layoutSizeAlignmentVerified: false,
            acceptedExtractorEvidenceRefs: [],
            extractorProvenance: [{
              extractorKind: "source_text_scan",
              acceptedByRuntimeCorrectnessPlan: false,
            }],
          },
        }],
        stageResults: [{
          stageId: "abi-compatibility",
          status: "blocked",
          degradedReason: "abi_layout_size_alignment_unverified",
        }],
      },
    }]);

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.layoutSizeAlignmentVerified).toBe(false);
    expect(proof.acceptedExtractorProvenanceObserved).toBe(false);
    expect(proof.evidenceRefs).toEqual(["evidence:device-abi-metadata:abc"]);
  });

  it("proves source compile and symbol binding only from linked proof artifact evidence", () => {
    const proof = sourceProofFromProofArtifacts([sourceProofArtifactRecord()]);

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.compileProven).toBe(true);
    expect(proof.symbolBindingProven).toBe(true);
    expect(proof.partialArtifactReplacement).toBe(true);
    expect(proof.compileEvidenceRefs).toEqual([
      `evidence:device-artifact:${"a".repeat(64)}`,
      `evidence:device-compiler:${"b".repeat(64)}`,
    ]);
    expect(proof.symbolEvidenceRefs).toEqual([`evidence:device-symbols:${"c".repeat(64)}`]);
    expect(summarizeGpuHmrSourceProof(proof)).toContain("gpu_source_proof=gpu-hmr-symbol-bound");
  });

  it("keeps source proof at compile when symbol binding evidence is not proven", () => {
    const proof = sourceProofFromProofArtifacts([sourceProofArtifactRecord({ symbolBound: false })]);

    expect(proof.resultState).toBe("gpu-hmr-compile-proven");
    expect(proof.compileProven).toBe(true);
    expect(proof.symbolBindingProven).toBe(false);
    expect(proof.degradedReason).toBe("device_symbol_evidence_unverified");
  });

  it("does not prove source compile from label-only telemetry or incomplete compiler provenance", () => {
    const proof = sourceProofFromProofArtifacts([
      sourceProofArtifactRecord({
        compileProvenance: { compilerIdentity: "" },
      }),
    ], { resultState: "gpu-hmr-symbol-bound", label: "gpu-hmr-partial" });

    expect(proof.resultState).toBeNull();
    expect(proof.compileProven).toBe(false);
    expect(proof.symbolBindingProven).toBe(false);
    expect(proof.label).toBe("gpu-hmr-partial");
    expect(proof.degradedReason).toBe("device_compiler_evidence_unverified");
  });

  it("proves ABI from artifact metadata only with layout proof and accepted extractor evidence", () => {
    const proof = abiProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-abi-metadata",
          evidenceId: "evidence:device-abi-metadata:def",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.abi_metadata.v1",
            layoutSizeAlignmentVerified: true,
            kernelAbiFingerprintHash: "d".repeat(64),
            constantGlobalLayoutHash: "3476900567878811119",
            acceptedExtractorEvidenceRefs: ["evidence:clang-record-layout:def"],
            acceptedExtractorSources: ["clang_record_layout"],
            extractorProvenance: [{
              extractorKind: "clang_record_layout",
              evidenceId: "evidence:clang-record-layout:def",
              extractorName: "test_clang_record_layout",
              extractorVersion: "v1",
              command: "clang++ -Xclang -fdump-record-layouts",
              inputHash: `sha256:${"d".repeat(64)}`,
            }],
          },
        }],
        stageResults: [{
          stageId: "abi-compatibility",
          status: "passed",
        }],
      },
    }]);

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.acceptedExtractorEvidenceRefs).toEqual(["evidence:clang-record-layout:def"]);
    expect(proof.acceptedExtractorCommands).toEqual(["clang++ -Xclang -fdump-record-layouts"]);
    expect(proof.acceptedExtractorInputHashes).toEqual([`sha256:${"d".repeat(64)}`]);
    expect(proof.kernelAbiFingerprintHashes).toEqual(["d".repeat(64)]);
    expect(proof.constantGlobalLayoutHashes).toEqual(["3476900567878811119"]);
  });

  it("proves fission only from verifier stages with evidence", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:abc",
          metadata: acceptedFissionVerifierMetadata(),
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:abc"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.required).toBe(true);
    expect(proof.degradedState).toBeNull();
    expect(proof.evidenceRefs).toEqual([
      "evidence:fission-verifier-report:abc",
      `fission-verifier:sha256:${"a".repeat(64)}`,
    ]);
    expect(proof.verifierEvidenceRefs).toEqual([`fission-verifier:sha256:${"a".repeat(64)}`]);
    expect(proof.deterministicVerifierEvidenceRefs).toEqual(["evidence:source-map"]);
    expect(proof.selectedIslandContractCoverageObserved).toBe(true);
    expect(proof.selectedIslandContractCoverageComplete).toBe(true);
    expect(proof.selectedIslandContracts[0].verificationEvidenceCoverage?.missingCategories).toEqual([]);
    expect(summarizeGpuHmrFissionProof(proof)).toContain("gpu_fission_proof=proven");
  });

  it("does not prove fission from a pass report unlinked from the passed stage evidence", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:abc",
          metadata: acceptedFissionVerifierMetadata(),
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:stale"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_verifier_stage_evidence_link_missing");
    expect(proof.selectedIslandObserved).toBe(true);
    expect(proof.stageStatuses).toEqual(["passed"]);
  });

  it("does not prove fission from generic verifier evidence without deterministic verifier evidence", () => {
    const proof = classifyGpuHmrFissionProof({
      required: true,
      observed: true,
      passed: true,
      evidenceRefs: ["evidence:fission-verifier-report:abc"],
      verifierEvidenceRefs: [`fission-verifier:sha256:${"a".repeat(64)}`],
    });

    expect(proof.fissionProven).toBe(false);
    expect(proof.deterministicVerifierEvidenceObserved).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_deterministic_verifier_evidence_not_collected");
  });

  it("does not prove fission without concrete verifier identity evidence", () => {
    const proof = classifyGpuHmrFissionProof({
      required: true,
      observed: true,
      passed: true,
      evidenceRefs: ["evidence:fission-verifier-report:abc"],
      deterministicVerifierEvidenceRefs: ["evidence:fission-deterministic:abc"],
      selectedIslandIds: ["fission-island:abc"],
    });

    expect(proof.fissionProven).toBe(false);
    expect(proof.verifierEvidenceObserved).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_verifier_identity_not_collected");
  });

  it("does not prove fission without a selected fission island identity", () => {
    const proof = classifyGpuHmrFissionProof({
      required: true,
      observed: true,
      passed: true,
      evidenceRefs: ["evidence:fission-verifier-report:abc"],
      verifierEvidenceRefs: [`fission-verifier:sha256:${"a".repeat(64)}`],
      deterministicVerifierEvidenceRefs: ["evidence:fission-deterministic:abc"],
    });

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandObserved).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_island_not_collected");
  });

  it("does not prove fission without the selected island contract", () => {
    const proof = classifyGpuHmrFissionProof({
      required: true,
      observed: true,
      passed: true,
      evidenceRefs: ["evidence:fission-verifier-report:abc"],
      verifierEvidenceRefs: [`fission-verifier:sha256:${"a".repeat(64)}`],
      deterministicVerifierEvidenceRefs: ["evidence:fission-deterministic:abc"],
      selectedIslandIds: ["fission-island:abc"],
    });

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandObserved).toBe(true);
    expect(proof.selectedIslandContractObserved).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_island_contract_not_collected");
  });

  it("does not prove fission from a selected island contract without verifier coverage", () => {
    const contract = acceptedSelectedIslandContract();
    delete contract.verificationEvidenceCoverage;
    const proof = classifyGpuHmrFissionProof({
      required: true,
      observed: true,
      passed: true,
      evidenceRefs: ["evidence:fission-verifier-report:abc"],
      verifierEvidenceRefs: [`fission-verifier:sha256:${"a".repeat(64)}`],
      deterministicVerifierEvidenceRefs: ["evidence:fission-deterministic:abc"],
      selectedIslandIds: ["fission-island:abc"],
      selectedIslandContracts: [contract],
    });

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContractObserved).toBe(true);
    expect(proof.selectedIslandContractCoverageObserved).toBe(false);
    expect(proof.selectedIslandContractCoverageComplete).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_island_contract_coverage_not_collected");
  });

  it("does not prove fission from a selected island contract with incomplete category coverage", () => {
    const contract = acceptedSelectedIslandContract();
    contract.verificationEvidenceCoverage = acceptedFissionVerificationCoverage();
    contract.verificationEvidenceCoverage.requiredCategories =
      contract.verificationEvidenceCoverage.requiredCategories.filter((category) => category !== "include_closure");
    contract.verificationEvidenceCoverage.categories =
      contract.verificationEvidenceCoverage.categories.filter((entry) => entry.category !== "include_closure");

    const proof = classifyGpuHmrFissionProof({
      required: true,
      observed: true,
      passed: true,
      evidenceRefs: ["evidence:fission-verifier-report:abc"],
      verifierEvidenceRefs: [`fission-verifier:sha256:${"a".repeat(64)}`],
      deterministicVerifierEvidenceRefs: ["evidence:fission-deterministic:abc"],
      selectedIslandIds: ["fission-island:abc"],
      selectedIslandContracts: [contract],
    });

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContractCoverageObserved).toBe(true);
    expect(proof.selectedIslandContractCoverageComplete).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_island_contract_evidence_coverage_incomplete");
  });

  it("records AI fission proposal ids separately from deterministic verifier evidence", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].aiProposalIdRequired = true;
    metadata.candidates[0].aiProposalId = `ai:fission:proposal:sha256:${"b".repeat(64)}`;
    metadata.candidates[0].aiProposalDeterministicPromotionEvidenceIds = [
      "evidence:fission-promotion:abc",
    ];
    metadata.candidates[0].nonAuthoritativeEvidenceIds = [
      metadata.candidates[0].aiProposalId,
    ];

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:abc",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:abc"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.selectedIslandIds).toEqual(["island:sha256:abc"]);
    expect(proof.verifierEvidenceRefs).toEqual([`fission-verifier:sha256:${"a".repeat(64)}`]);
    expect(proof.deterministicVerifierEvidenceRefs).toEqual(["evidence:source-map"]);
    expect(proof.aiProposalIds).toEqual([metadata.candidates[0].aiProposalId]);
    expect(proof.aiProposalPromotionRequired).toBe(true);
    expect(proof.aiProposalDeterministicPromotionEvidenceRefs).toEqual([
      "evidence:fission-promotion:abc",
    ]);
    expect(proof.nonAuthoritativeEvidenceRefs).toEqual([metadata.candidates[0].aiProposalId]);
  });

  it("does not prove AI fission proposals without deterministic promotion evidence", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].aiProposalIdRequired = true;
    metadata.candidates[0].aiProposalId = `ai:fission:proposal:sha256:${"c".repeat(64)}`;

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:abc",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:abc"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_ai_proposal_deterministic_promotion_missing");
    expect(proof.aiProposalIds).toEqual([metadata.candidates[0].aiProposalId]);
    expect(proof.aiProposalDeterministicPromotionEvidenceRefs).toEqual([]);
  });

  it("does not prove fission from a shallow pass report without selected candidate coverage", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:shallow",
          metadata: {
            status: "pass",
            selectedIslandId: "island:sha256:shallow",
          },
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:shallow"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.required).toBe(true);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_verifier_schema_unverified");
  });

  it("does not prove fission without accepted selection policy provenance", () => {
    const metadata = acceptedFissionVerifierMetadata();
    delete metadata.selectionPolicy;

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:selection-policy",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:selection-policy"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selection_policy_unverified");
  });

  it("does not prove fission without deterministic selection decision provenance", () => {
    const metadata = acceptedFissionVerifierMetadata();
    delete metadata.selectionDecision;
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof.json",
      artifact: {
        proofId: "gpu-proof:selection-decision",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:selection-decision",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:selection-decision"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selection_decision_missing");
  });

  it("does not prove fission when deterministic selection order is reordered", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.selectionDecision.comparisonOrder = [
      "historicalTimingPenaltyMs",
      "compileCostPenaltyMs",
      "sourceSpanExtent",
      "includeClosureCount",
      "sourcePathCount",
      "exportedSymbolOverage",
      "targetSymbolCount",
      "missingVerificationCategoryCount",
      "scopeRank",
    ];
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof.json",
      artifact: {
        proofId: "gpu-proof:selection-decision-order",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:selection-decision-order",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:selection-decision-order"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selection_decision_order_unverified");
  });

  it("does not prove fission when deterministic selection tie breakers are reordered", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.selectionDecision.tieBreakers = ["candidateIndex", "verifierEvidenceId"];
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: ".synthi/gpu-hmr/proofs/gpu-proof.json",
      artifact: {
        proofId: "gpu-proof:selection-decision-tie-break",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:selection-decision-tie-break",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:selection-decision-tie-break"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selection_decision_tie_break_unverified");
  });

  it("does not prove fission without selected candidate ranking score provenance", () => {
    const metadata = acceptedFissionVerifierMetadata();
    delete metadata.candidates[0].selectionScore;

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:selection-score",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:selection-score"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selection_decision_score_missing");
  });

  it("does not prove fission when selected candidate is not the narrowest accepted island", () => {
    const metadata = acceptedFissionVerifierMetadata();
    const narrowerCandidate = JSON.parse(JSON.stringify(metadata.candidates[0]));
    narrowerCandidate.selected = false;
    narrowerCandidate.islandId = "island:sha256:narrower";
    narrowerCandidate.candidate = acceptedSelectedIslandContract("island:sha256:narrower");
    narrowerCandidate.candidate.artifactKind = "function_body";
    narrowerCandidate.candidate.exportedSymbolsExpected = ["kernel_main"];
    narrowerCandidate.candidate.includeClosure = [];
    narrowerCandidate.candidate.narrowerCandidateRejections = [];
    narrowerCandidate.selectionScore.total = 0;
    narrowerCandidate.selectionScore.scopeRank = 0;
    narrowerCandidate.selectionScore.includeClosureCount = 0;
    metadata.candidateCount = 2;
    metadata.acceptedCount = 2;
    metadata.selectionDecision.candidateCount = 2;
    metadata.selectionDecision.acceptedCount = 2;
    metadata.candidates.push(narrowerCandidate);

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:not-narrowest",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:not-narrowest"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_candidate_not_narrowest");
  });

  it("does not prove fission when the selected island contract is incomplete", () => {
    const metadata = acceptedFissionVerifierMetadata();
    delete metadata.candidates[0].candidate.compileCommandHash;

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:contract",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:contract"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContractObserved).toBe(true);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_island_compile_contract_unverified");
  });

  it("does not prove fission from original-host mapping without attachment instrumentation", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-no-attachment",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-no-attachment"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContractObserved).toBe(true);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe(
      "fission_selected_island_original_host_attachment_instrumentation_missing",
    );
  });

  it("does not prove fission from original-host mapping with only a bare proposal id", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      mapping: {
        attachmentInstrumentationProposals: [
          `launch-attachment-proposal:sha256:${"8".repeat(64)}`,
        ],
      },
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-bare-proposal",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-bare-proposal"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostAttachmentInstrumentationProposalIds)
      .toEqual([]);
    expect(proof.degradedReason).toBe(
      "fission_selected_island_original_host_attachment_instrumentation_missing",
    );
  });

  it("does not prove fission from original-host mapping with incomplete attachment proposal metadata", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      mapping: {
        attachmentInstrumentationProposals: [{
          proposalId: `launch-attachment-proposal:sha256:${"8".repeat(64)}`,
          sourceLaunchSiteId: `launch-site:sha256:${"9".repeat(64)}`,
          hostPathId: `host-path:sha256:${"a".repeat(64)}`,
          requiredBoundaryApis: [
            "synthi_gpu_launch_source_location",
            "synthi_gpu_launch_original_host_path",
          ],
          runtimeEvidenceRequired: {
            runtimeSessionScoped: true,
            dispatchBoundaryObserved: true,
            dispatchEntryRuntimeVerified: true,
          },
        }],
      },
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-incomplete-proposal",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-incomplete-proposal"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostAttachmentInstrumentationProposalIds)
      .toEqual([]);
    expect(proof.degradedReason).toBe(
      "fission_selected_island_original_host_attachment_instrumentation_missing",
    );
  });

  it("does not prove fission from original-host mapping with partial boundary API contract", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      mapping: {
        attachmentInstrumentationProposals: [{
          ...acceptedLaunchAttachmentProposal(),
          requiredBoundaryApis: [
            "synthi_gpu_launch_source_location",
            "synthi_gpu_launch_original_host_path",
          ],
        }],
      },
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-partial-api-contract",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-partial-api-contract"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostAttachmentInstrumentationProposalIds)
      .toEqual([]);
    expect(proof.degradedReason).toBe(
      "fission_selected_island_original_host_attachment_instrumentation_missing",
    );
  });

  it("does not prove fission from original-host mapping without an attachment contract", () => {
    const metadata = acceptedFissionVerifierMetadata();
    const proposal = acceptedLaunchAttachmentProposal();
    delete proposal.attachmentContract;
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      mapping: {
        attachmentInstrumentationProposals: [proposal],
      },
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-missing-attachment-contract",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-missing-attachment-contract"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostAttachmentInstrumentationProposalIds)
      .toEqual([]);
    expect(proof.degradedReason).toBe(
      "fission_selected_island_original_host_attachment_instrumentation_missing",
    );
  });

  it("proves fission from original-host mapping with a structured attachment proposal", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      mapping: {
        attachmentInstrumentationProposals: [acceptedLaunchAttachmentProposal()],
      },
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-proposal",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-proposal"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostAttachmentInstrumentationProposalIds)
      .toEqual([acceptedLaunchAttachmentProposal().proposalId]);
  });

  it("proves fission proposal coverage from native launch API attachment metadata", () => {
    const nativeLaunchProposal = {
      ...acceptedLaunchAttachmentProposal(),
      instrumentationAction: "wrap_native_launch_api_with_synthi_runtime_boundary",
    };
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      mapping: {
        attachmentInstrumentationProposals: [nativeLaunchProposal],
      },
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-native-launch-proposal",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-native-launch-proposal"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostAttachmentInstrumentationProposalIds)
      .toEqual([nativeLaunchProposal.proposalId]);
  });

  it("proves fission from original-host mapping with runtime-proven attachment", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      runtimeAttachmentProven: true,
      runtimeAttachmentEvidenceIds: [
        `evidence:original-host-runtime-attachment:${"8".repeat(64)}`,
      ],
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-runtime-attached",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-runtime-attached"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentProven).toBe(true);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentEvidenceIds)
      .toEqual([`evidence:original-host-runtime-attachment:${"8".repeat(64)}`]);
  });

  it("does not prove runtime attachment from original-host mapping evidence", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      runtimeAttachmentProven: true,
      runtimeAttachmentEvidenceIds: [
        `evidence:original-host-launch-mapping:${"8".repeat(64)}`,
      ],
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-mapping-as-runtime",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-mapping-as-runtime"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentEvidenceIds)
      .toEqual([]);
    expect(proof.degradedReason).toBe(
      "fission_selected_island_original_host_attachment_instrumentation_missing",
    );
  });

  it("does not prove fission from a bare original-host runtime attachment claim", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.originalHostLaunchMappingRequired = true;
    metadata.candidates[0].candidate.originalHostLaunchMappingId =
      `host-launch:sha256:${"7".repeat(64)}`;
    metadata.candidates[0].launchAttachmentScout = {
      runtimeAttachmentProven: true,
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:original-host-bare-runtime-claim",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:original-host-bare-runtime-claim"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentProven).toBe(false);
    expect(proof.selectedIslandContracts[0].originalHostRuntimeAttachmentEvidenceIds)
      .toEqual([]);
    expect(proof.degradedReason).toBe(
      "fission_selected_island_original_host_attachment_instrumentation_missing",
    );
  });

  it("does not prove fission from an unverified inline oracle proposal", () => {
    const metadata = acceptedFissionVerifierMetadata();
    delete metadata.candidates[0].candidate.requiredOracleId;
    metadata.candidates[0].candidate.outputOracleProposal = {
      kind: "dispatch_counter",
      producer: "deterministic_probe",
      expectedIncrement: 1,
      outputTargetId: "dispatch-counter:main",
      readbackPlan: { syncPoint: "after-dispatch" },
      sessionIdSource: "runtime-session",
      artifactIdSource: "selected-artifact",
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:oracle-contract",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:oracle-contract"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContractObserved).toBe(true);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_island_output_oracle_contract_unverified");
  });

  it("proves fission from a verifier-backed inline oracle proposal", () => {
    const metadata = acceptedFissionVerifierMetadata();
    delete metadata.candidates[0].candidate.requiredOracleId;
    metadata.candidates[0].candidate.outputOracleProposal = {
      kind: "dispatch_counter",
      producer: "deterministic_probe",
      expectedIncrement: 1,
      outputTargetId: "dispatch-counter:main",
      readbackPlan: { syncPoint: "after-dispatch" },
      sessionIdSource: "runtime-session",
      artifactIdSource: "selected-artifact",
    };
    metadata.candidates[0].outputOracleContract = {
      proposalValid: true,
      proposalKind: "dispatch_counter",
      proposalExpectedValuePresent: true,
      proposalProducerPresent: true,
      proposalOutputTargetPresent: true,
      proposalReadbackContractPresent: true,
      proposalRuntimeSessionBindingPresent: true,
      proposalArtifactBindingPresent: true,
      proposalVisualEvidenceRequired: false,
      proposalVisualEvidenceContractPresent: false,
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:oracle-contract-backed",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:oracle-contract-backed"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.selectedIslandContracts[0].oracleProposal?.kind).toBe("dispatch_counter");
    expect(proof.selectedIslandContracts[0].outputOracleContract?.proposalValid).toBe(true);
  });

  it("accepts an explicitly empty include closure for a narrow selected island", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].candidate.artifactKind = "function_body";
    metadata.candidates[0].candidate.includeClosure = [];
    metadata.candidates[0].candidate.exportedSymbolsExpected = ["kernel_main"];
    metadata.candidates[0].narrowerRejectionCoverage = {
      requiredRanks: [],
      coveredRanks: [],
      missingRanks: [],
    };

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:empty-include",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:empty-include"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(true);
    expect(proof.selectedIslandContracts[0].includeClosureObserved).toBe(true);
    expect(proof.selectedIslandContracts[0].includeClosure).toEqual([]);
  });

  it("does not prove fission when a pass report omits required verifier category evidence", () => {
    const metadata = acceptedFissionVerifierMetadata();
    metadata.candidates[0].verificationEvidenceCoverage = acceptedFissionVerificationCoverage();
    metadata.candidates[0].verificationEvidenceCoverage.categories =
      metadata.candidates[0].verificationEvidenceCoverage.categories.map((entry) =>
        entry.category === "include_closure"
          ? { ...entry, evidenceIds: [] }
          : entry
      );

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:incomplete-coverage",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:incomplete-coverage"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_candidate_evidence_coverage_incomplete");
  });

  it("does not prove fission when the include closure field is missing", () => {
    const metadata = acceptedFissionVerifierMetadata();
    delete metadata.candidates[0].candidate.includeClosure;

    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:missing-include",
          metadata,
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "passed",
          evidenceRefs: ["evidence:fission-verifier-report:missing-include"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.selectedIslandContractObserved).toBe(true);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_selected_island_include_closure_missing");
  });

  it("blocks fission proof when a verifier stage rejects the candidate", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:def",
          metadata: {
            status: "reject",
            reasonCodes: ["fission.abi_membrane_unverified"],
          },
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "blocked",
          evidenceRefs: ["evidence:fission-verifier-report:def"],
          degradedReason: "fission.abi_membrane_unverified",
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.required).toBe(true);
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission.abi_membrane_unverified");
  });

  it("uses candidate-level fission rejection reasons over generic no-accepted summary", () => {
    const proof = fissionProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "fission-verifier-report",
          evidenceId: "evidence:fission-verifier-report:ghi",
          metadata: {
            status: "reject",
            reasonCodes: ["fission.no_accepted_candidate"],
            candidates: [{
              status: "reject",
              reasonCodes: ["fission.output_oracle_missing", "fission.abi_membrane_evidence_missing"],
            }],
          },
        }],
        stageResults: [{
          stageId: "fission-candidate-verification",
          status: "blocked",
          evidenceRefs: ["evidence:fission-verifier-report:ghi"],
        }],
      },
    }]);

    expect(proof.fissionProven).toBe(false);
    expect(proof.required).toBe(true);
    expect(proof.degradedReason).toBe("fission.output_oracle_missing");
  });

  it("reports path-only artifact transport as degraded RAM I/O evidence", () => {
    const proof = artifactTransportProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-artifact-transport",
          evidenceId: "evidence:device-artifact-transport:abc",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.artifact_transport.v1",
            selectedLoaderTransport: null,
            reloadRequestTransports: ["filesystem_path"],
            ramArtifactReferenceProvided: false,
            degradedState: "gpu-hmr-ram-io-unavailable",
            degradedReason: "reload_request_contains_filesystem_path_only",
          },
        }],
        stageResults: [{
          stageId: "artifact-transport",
          status: "blocked",
          degradedState: "gpu-hmr-ram-io-unavailable",
        }],
      },
    }]);

    expect(proof.transportEvidenceObserved).toBe(true);
    expect(proof.resultState).toBeNull();
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-ram-io-unavailable");
    expect(proof.degradedReason).toBe("reload_request_contains_filesystem_path_only");
    expect(proof.loaderTransports).toEqual([]);
    expect(proof.reloadRequestTransports).toEqual(["filesystem_path"]);
    expect(proof.evidenceRefs).toEqual(["evidence:device-artifact-transport:abc"]);
    expect(summarizeGpuHmrArtifactTransportProof(proof)).toContain("ram-unproven");
  });

  it("merges runtime RAM references without proving RAM transport through filesystem loaders", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "[gpu-runtime-boundary] artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa artifact_bytes=10 reload_request_transport=filesystem_path,ram_blob selected_loader_transport=filesystem_path loader_api=module_load_path ram_reference=true ram_blob_id=artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ram_transport_proven=false degraded_state=gpu-hmr-ram-io-unavailable degraded_reason=selected_loader_uses_filesystem_path load_result=ok",
    ], { runtimeSessionIds: ["pid1"] });
    const proof = artifactTransportProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: {
        proofId: "proof:gpu-hmr:1",
        evidenceRefs: [{
          kind: "device-artifact-transport",
          evidenceId: "evidence:device-artifact-transport:abc",
          metadata: {
            schemaVersion: "synthi.gpu.hmr.artifact_transport.v1",
            selectedLoaderTransport: null,
            reloadRequestTransports: ["filesystem_path", "ram_blob"],
            ramArtifactReferenceProvided: true,
            degradedState: "gpu-hmr-ram-io-unavailable",
            degradedReason: "selected_loader_transport_not_observed",
          },
        }],
      },
    }], runtimeTransport);

    expect(runtimeTransport.transport_evidence_observed).toBe(true);
    expect(runtimeTransport.ram_transport_proven).toBe(false);
    expect(runtimeTransport.loader_transports).toEqual(["filesystem_path"]);
    expect(runtimeTransport.reload_request_transports).toEqual(["filesystem_path", "ram_blob"]);
    expect(runtimeTransport.ram_blob_identity_proven).toBe(true);
    expect(proof.transportEvidenceObserved).toBe(true);
    expect(proof.resultState).toBeNull();
    expect(proof.ramArtifactReferenceProvided).toBe(true);
    expect(proof.ramBlobIdentityProven).toBe(true);
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.loaderTransports).toEqual(["filesystem_path"]);
    expect(proof.reloadRequestTransports).toEqual(["filesystem_path", "ram_blob"]);
    expect(proof.degradedReason).toBe("selected_loader_uses_filesystem_path");
    expect(proof.evidenceRefs).toEqual([
      "evidence:device-artifact-transport:abc",
      "worker-log:artifact_transport:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
  });

  it("rejects artifact transport-shaped records without runtime boundary provenance", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "application-log artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa artifact_bytes=10 reload_request_transport=ram_blob selected_loader_transport=ram_bytes loader_api=module_load_data ram_reference=true ram_transport_proven=true load_result=ok",
    ], { runtimeSessionIds: ["pid1"] });
    const proof = artifactTransportProofFromProofArtifacts([], runtimeTransport);

    expect(runtimeTransport.total_count).toBe(0);
    expect(runtimeTransport.matched_count).toBe(0);
    expect(runtimeTransport.transport_evidence_observed).toBe(false);
    expect(runtimeTransport.ram_transport_proven).toBe(false);
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.degradedReason).toBe("artifact_transport_evidence_not_collected");
  });

  it("ignores artifact transport lines from unexpected runtime sessions", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "[gpu-runtime-boundary] artifact_transport runtime_session=old generation=3 artifact_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa artifact_bytes=10 reload_request_transport=ram_blob selected_loader_transport=ram_bytes loader_api=module_load_data ram_reference=true ram_transport_proven=true load_result=ok",
    ], { runtimeSessionIds: ["current"] });

    expect(runtimeTransport.total_count).toBe(1);
    expect(runtimeTransport.matched_count).toBe(0);
    expect(runtimeTransport.transport_evidence_observed).toBe(false);
    expect(runtimeTransport.ram_transport_proven).toBe(false);
  });

  it("proves RAM artifact transport only when a RAM reference reaches a RAM loader", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "[gpu-runtime-boundary] artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb artifact_bytes=10 reload_request_transport=ram_blob selected_loader_transport=ram_bytes loader_api=module_load_data ram_reference=true ram_blob_id=artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ram_transport_proven=true degraded_state=none degraded_reason=none load_result=ok",
    ], { runtimeSessionIds: ["pid1"] });
    const proof = artifactTransportProofFromProofArtifacts([], runtimeTransport);

    expect(runtimeTransport.ram_transport_proven).toBe(true);
    expect(runtimeTransport.ram_blob_identity_proven).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-artifact-transport-proven");
    expect(proof.ramArtifactReferenceProvided).toBe(true);
    expect(proof.ramBlobIdentityProven).toBe(true);
    expect(proof.ramTransportProven).toBe(true);
    expect(proof.ramBlobIds).toEqual([
      "artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
    expect(proof.degradedState).toBeNull();
    expect(proof.loaderTransports).toEqual(["ram_bytes"]);
  });

  it("does not prove RAM artifact transport when the RAM blob id mismatches the artifact hash", () => {
    const runtimeTransport = runtimeArtifactTransportEvidence([
      "[gpu-runtime-boundary] artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb artifact_bytes=10 reload_request_transport=ram_blob selected_loader_transport=ram_bytes loader_api=module_load_data ram_reference=true ram_blob_id=artifact:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc ram_transport_proven=true degraded_state=none degraded_reason=none load_result=ok",
    ], { runtimeSessionIds: ["pid1"] });
    const proof = artifactTransportProofFromProofArtifacts([], runtimeTransport);

    expect(runtimeTransport.transport_evidence_observed).toBe(true);
    expect(runtimeTransport.ram_blob_identity_proven).toBe(false);
    expect(runtimeTransport.ram_transport_proven).toBe(false);
    expect(runtimeTransport.degraded_reason).toBe("ram_blob_identity_not_proven");
    expect(proof.resultState).toBeNull();
    expect(proof.ramArtifactReferenceProvided).toBe(true);
    expect(proof.ramBlobIdentityProven).toBe(false);
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.ramBlobIds).toEqual([
      "artifact:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    ]);
    expect(proof.degradedReason).toBe("ram_blob_identity_not_proven");
  });

  it("does not infer RAM artifact transport without transport evidence", () => {
    const proof = artifactTransportProofFromProofArtifacts([{
      proofArtifactPath: "/tmp/gpu-hmr-proof.json",
      artifact: { proofId: "proof:gpu-hmr:1", evidenceRefs: [], stageResults: [] },
    }]);

    expect(proof.transportEvidenceObserved).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.ramTransportProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-ram-io-unavailable");
    expect(proof.degradedReason).toBe("artifact_transport_evidence_not_collected");
  });

  it("reports epoch-swap-proven only for session, stream ordering, generation lineage, table hash, changed entries, and retired old generation", () => {
    const proof = retiredEpochProof();

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.runtimeSessionObserved).toBe(true);
    expect(proof.generationGraphValid).toBe(true);
    expect(proof.streamOrderingProven).toBe(true);
    expect(summarizeGpuHmrEpochSwapProof(proof)).toContain("retired=yes");
  });

  it("does not prove epoch swap from a lineage boolean without a generation graph", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-graph"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.generationGraphObserved).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_not_collected");
  });

  it("does not prove epoch swap from side-channel session ids missing from the generation graph", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph({ runtimeSession: null }),
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementFenceIds: ["stream-sync:default:2->3"],
      delayedUnloadResult: "unloaded",
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-graph-session"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_session_not_collected");
    expect(proof.generationGraphObserved).toBe(true);
    expect(proof.generationGraphValid).toBe(false);
    expect(proof.generationGraphRuntimeSessionIds).toEqual([]);
    expect(proof.generationGraphRuntimeSessionScoped).toBe(false);
  });

  it("keeps pending epoch retirement as a blocker for higher proof", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph({ retirementState: "pending" }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: false,
      evidenceRefs: ["evidence:epoch:pending"],
    });

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("does not accept a retired epoch graph without a matching retirement edge", () => {
    const graph = epochGenerationGraph();
    graph.edges = graph.edges.filter((edge) => edge.kind !== "retire");
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:missing-retire-edge"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_retirement_edge_missing");
  });

  it("does not accept an epoch graph with a contradictory extra edge", () => {
    const graph = epochGenerationGraph();
    graph.edges.push({
      kind: "publish",
      from: "generation:3",
      to: "generation:2",
      runtimeSession: "runtime-session:test",
    });

    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:contradictory-edge"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_edge_invalid");
    expect(proof.edgeClosureValid).toBe(false);
  });

  it("does not accept an epoch graph when node ids disagree with node generations", () => {
    const graph = epochGenerationGraph();
    graph.nodes[0].id = "generation:999";

    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:node-id-mismatch"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_node_invalid");
    expect(proof.nodeIdentitiesValid).toBe(false);
  });

  it("does not accept an epoch graph without the structured schema version", () => {
    const graph = epochGenerationGraph();
    delete graph.schemaVersion;

    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:missing-schema"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_schema_unverified");
    expect(proof.schemaVersionValid).toBe(false);
  });

  it("does not accept an epoch graph without publication timestamp provenance", () => {
    const graph = epochGenerationGraph();
    delete graph.latestPublication.publishTimestampMs;
    delete graph.edges[0].publishTimestampMs;

    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:missing-publish-timestamp"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_publish_timestamp_missing");
    expect(proof.publishTimestampObserved).toBe(false);
  });

  it("does not accept side-channel dispatch table hashes without graph mutation provenance", () => {
    const graph = epochGenerationGraph();
    delete graph.latestPublication.dispatchTableHashBefore;
    delete graph.latestPublication.dispatchTableHashAfter;
    delete graph.latestPublication.dispatchTableHash;
    delete graph.latestPublication.changedEntries;
    delete graph.edges[0].dispatchTableHashBefore;
    delete graph.edges[0].dispatchTableHashAfter;
    delete graph.edges[0].dispatchTableHash;
    delete graph.edges[0].changedEntries;

    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:side-channel-dispatch-table"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_dispatch_table_hash_missing");
    expect(proof.dispatchTableHashObserved).toBe(false);
    expect(proof.changedEntriesObserved).toBe(false);
  });

  it("does not prove epoch swap without runtime session evidence", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      epochGenerationGraph: epochGenerationGraph({ runtimeSession: null }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-session"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_runtime_session_not_collected");
  });

  it("does not prove epoch swap without stream ordering evidence", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph(),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-stream"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_ordering_not_collected");
  });

  it("does not prove epoch stream ordering when stream counters do not cover the observed stream", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph({
        capsuleMetadata: true,
        retirementState: "retired",
      }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["untracked-stream"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:stream-counter-mismatch"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_epoch_counter_unverified");
    expect(proof.streamEpochCounterIds).toEqual(["default"]);
    expect(proof.streamEpochCountersCoverScope).toBe(false);
  });

  it("does not prove epoch swap for affected streams without retirement fence ids", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph({ retirementFenceIds: [] }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      delayedUnloadResult: "unloaded",
      evidenceRefs: ["evidence:epoch:no-fence"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_retirement_fence_ids_not_collected");
    expect(proof.retirementFenceEvidenceObserved).toBe(false);
  });

  it("does not prove epoch swap without delayed unload result evidence", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph({ delayedUnloadResult: null }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementFenceIds: ["stream-sync:default:2->3"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-delayed-unload"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_delayed_unload_result_not_collected");
    expect(proof.delayedUnloadResultObserved).toBe(false);
  });

  it("proves epoch swap from runtime publish and retire evidence", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields()} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields({ delayedUnloadResult: "pending" })} drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
      `[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session=pid1 previous_generation=2 active_generation=3 retired_modules=1 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields()}`,
    ]);

    expect(evidence.stream_ordering_proven).toBe(true);
    expect(evidence.stream_ids).toEqual(["default"]);
    expect(evidence.runtime_session_ids).toEqual(["pid1"]);
    expect(evidence.epoch_generation_graph?.schemaVersion).toBe("synthi.gpu.epoch_graph.v1");
    expect(evidence.epoch_generation_graph?.latestPublication.publishTimestampMs).toBe(1779979998000);
    expect(evidence.epoch_generation_graph?.latestPublication.dispatchTableHashBefore).toBe("0xaaa");
    expect(evidence.epoch_generation_graph?.latestPublication.dispatchTableHashAfter).toBe("0xabc");
    expect(evidence.epoch_generation_graph?.latestPublication.changedEntries).toBe(1);
    expect(evidence.epoch_generation_graph?.nodes.map((node) => node.id)).toEqual([
      "generation:2",
      "generation:3",
    ]);
    expect(evidence.epoch_generation_graph?.retirementState).toBe("retired");
    expect(evidence.dispatch_table_hash_before_observed).toBe(true);
    expect(evidence.dispatch_table_hash_after_observed).toBe(true);
    expect(evidence.retirement_fence_ids).toEqual(["stream-sync:default:2->3"]);
    expect(evidence.delayed_unload_result).toBe("unloaded");
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.generationGraphValid).toBe(true);
    expect(proof.evidenceRefs).toEqual([
      "worker-log:dispatcher_epoch:published:2->3",
      "worker-log:dispatcher_epoch:retired:2->3",
      "worker-log:dispatcher_epoch:retirement_fence:2->3:stream-sync:default:2--3",
    ]);
  });

  it("rejects epoch publication-shaped records without runtime boundary provenance", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `application-log dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields()} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields({ delayedUnloadResult: "pending" })} drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
      `application-log dispatcher_epoch event=retired runtime_session=pid1 previous_generation=2 active_generation=3 retired_modules=1 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields()}`,
    ]);

    expect(evidence.total_count).toBe(0);
    expect(evidence.published).toBe(false);
    expect(evidence.runtime_session_observed).toBe(false);
    expect(evidence.epoch_generation_graph_observed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("epoch_publication_not_observed");
  });

  it("carries capsule lineage metadata into the runtime epoch graph", () => {
    const oldHash = "a".repeat(64);
    const newHash = "b".repeat(64);
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields({ oldHash, newHash, symbols: ["shade", "trace"], functionHandles: ["shade:0x10", "trace:0x20"] })} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=2 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields({ delayedUnloadResult: "pending" })} drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
      `[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session=pid1 previous_generation=2 active_generation=3 retired_modules=1 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields()}`,
    ]);

    const publishEdge = evidence.epoch_generation_graph?.edges.find((edge) => edge.kind === "publish");
    expect(evidence.capsule_metadata_observed).toBe(true);
    expect(evidence.latest_publication?.oldArtifactId).toBe(`artifact:sha256:${oldHash}`);
    expect(evidence.latest_publication?.newArtifactId).toBe(`artifact:sha256:${newHash}`);
    expect(evidence.latest_publication?.changedSymbols).toEqual(["shade", "trace"]);
    expect(evidence.latest_publication?.functionHandleIds).toEqual(["shade:0x10", "trace:0x20"]);
    expect(publishEdge?.oldArtifactId).toBe(`artifact:sha256:${oldHash}`);
    expect(publishEdge?.newArtifactId).toBe(`artifact:sha256:${newHash}`);
    expect(publishEdge?.newArtifactHash).toBe(`sha256:${newHash}`);
    expect(publishEdge?.capsuleId).toBe(`capsule:sha256:${TEST_CAPSULE_HASH}`);
    expect(publishEdge?.fissionIslandId).toBe(`fission-island:sha256:${TEST_PROOF_HASH}`);
    expect(publishEdge?.abiMembraneHash).toBe(`sha256:${TEST_ABI_HASH}`);
    expect(publishEdge?.dependencyClosureHash).toBe(`sha256:${TEST_DEPENDENCY_HASH}`);
    expect(publishEdge?.proofHash).toBe(`sha256:${TEST_PROOF_HASH}`);
    expect(publishEdge?.streamEpochCounters).toEqual({ default: 3 });
    expect(publishEdge?.retirementFenceIds).toEqual(["stream-sync:default:2->3"]);
    expect(evidence.epoch_generation_graph?.latestPublication.delayedUnloadResult).toBe("unloaded");
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.capsuleMetadataObserved).toBe(true);
    expect(summarizeGpuHmrEpochSwapProof(proof)).toContain("capsule=observed");
  });

  it("does not prove epoch swap without capsule artifact lineage metadata", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph({ capsuleMetadata: false }),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-capsule-metadata"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_capsule_metadata_not_collected");
    expect(proof.capsuleMetadataObserved).toBe(false);
    expect(summarizeGpuHmrEpochSwapProof(proof)).toContain("capsule=missing");
  });

  it("does not prove epoch swap when capsule lineage omits the old artifact id", () => {
    const graph = epochGenerationGraph();
    delete graph.latestPublication.oldArtifactId;
    for (const edge of graph.edges) {
      delete edge.oldArtifactId;
    }

    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: graph,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs: ["evidence:epoch:no-old-artifact-id"],
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_capsule_metadata_not_collected");
    expect(proof.capsuleMetadataObserved).toBe(false);
  });

  it("does not prove runtime epoch swap when the capsule artifact id and hash disagree", () => {
    const mismatchedHash = "9".repeat(64);
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields()} new_artifact_hash=sha256:${mismatchedHash} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
    ]);

    expect(evidence.capsule_metadata_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_capsule_metadata_not_collected");
  });

  it("does not treat placeholder capsule metadata as observed lineage", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 old_artifact_id=none new_artifact_id=artifact:sha256:${TEST_NEW_ARTIFACT_HASH} new_artifact_hash=sha256:${TEST_NEW_ARTIFACT_HASH} changed_symbols=none function_handle_ids=none dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
    ]);

    expect(evidence.capsule_metadata_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_capsule_metadata_not_collected");
  });

  it("keeps runtime epoch evidence pending until matching retirement is observed", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields()} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields({ delayedUnloadResult: "pending" })} drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
    ]);

    expect(evidence.old_generation_retired).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("does not prove runtime epoch swap from legacy single dispatch table hash only", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.dispatch_table_hash_observed).toBe(false);
    expect(evidence.dispatch_table_hash_before_observed).toBe(false);
    expect(evidence.dispatch_table_hash_after_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_dispatch_table_hash_missing");
  });

  it("does not prove runtime epoch swap when before and after dispatch table hashes are identical", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xabc dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.dispatch_table_hash_before_observed).toBe(true);
    expect(evidence.dispatch_table_hash_after_observed).toBe(true);
    expect(evidence.dispatch_table_hash_changed).toBe(false);
    expect(evidence.dispatch_table_hash_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_dispatch_table_hash_unchanged");
  });

  it("does not prove runtime epoch swap when no dispatch entries changed", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=0 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.dispatch_table_hash_changed).toBe(true);
    expect(evidence.changed_entries_observed).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_generation_graph_changed_entries_missing");
  });

  it("keeps publication-only retirement pending without explicit zero retired modules", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields()} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields({ delayedUnloadResult: "pending" })} drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
    ]);

    expect(evidence.retirement_not_required).toBe(false);
    expect(evidence.old_generation_retired).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-retirement-pending");
  });

  it("accepts publication-only retirement when zero retired modules is explicit", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields()} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true ${epochRetirementFields({ delayedUnloadResult: "not_required" })} drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000`,
    ]);

    expect(evidence.retirement_not_required).toBe(true);
    expect(evidence.old_generation_retired).toBe(true);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
  });

  it("accepts no-stream epoch ordering only when no affected streams are explicitly recorded", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 ${epochCapsuleFields({ streamEpochCounters: { none: 3 } })} dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=none stream_ids=none stream_ordering_proven=true ${epochRetirementFields({ retirementFenceIds: ["none"], delayedUnloadResult: "not_required" })} drain_result=synced drain_elapsed_ms=0 drain_budget_ms=2000`,
    ]);

    expect(evidence.stream_scope_supported).toBe(true);
    expect(evidence.stream_ids).toEqual(["none"]);
    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBeNull();
  });

  it("does not prove no-stream epoch ordering when the no-stream assertion is omitted", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=none stream_ordering_proven=true drain_result=synced drain_elapsed_ms=0 drain_budget_ms=2000",
    ]);

    expect(evidence.stream_scope_supported).toBe(false);
    expect(evidence.stream_ordering_proven).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_scope_not_collected");
  });

  it("does not prove no-stream epoch ordering when stream ids contradict the scope", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=none stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=0 drain_budget_ms=2000",
    ]);

    expect(evidence.stream_scope_supported).toBe(false);
    expect(evidence.stream_ordering_proven).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_scope_not_collected");
  });

  it("downgrades runtime epoch evidence when stream ordering is missing from the publication", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=true stream_scope=context",
    ]);

    expect(evidence.stream_ordering_proven).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_ordering_not_collected");
  });

  it("does not accept context-wide drain as epoch stream ordering proof", () => {
    const { evidence, proof } = epochSwapProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=true stream_scope=context stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000",
    ]);

    expect(evidence.stream_ordering_proven).toBe(false);
    expect(evidence.stream_scope_supported).toBe(false);
    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_stream_scope_not_collected");
  });

  it("does not prove epoch swap from boolean stream ordering without evidence refs", () => {
    const proof = classifyGpuHmrEpochSwapProof({
      published: true,
      runtimeSessionIds: ["runtime-session:test"],
      epochGenerationGraph: epochGenerationGraph(),
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope: "affected",
      streamIds: ["default"],
      retirementTracked: true,
      oldGenerationRetired: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("epoch_evidence_refs_not_collected");
  });

  it("proves host preservation from matching runtime identity snapshots across the expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=renderer ptr=0x2000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=renderer ptr=0x2000 aux=0 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ], {
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.identity_checks_passed).toBe(true);
    expect(evidence.identity_snapshot_observed).toBe(true);
    expect(evidence.identity_snapshot_lineage_observed).toBe(true);
    expect(evidence.preserved_roles).toEqual(["core_state", "renderer", "runner_process", "stream"]);
    expect(evidence.preserved_role_categories).toEqual(["host_state", "runner_process", "runtime_resource"]);
    expect(evidence.snapshot_evidence_refs).toEqual([
      "worker-log:host_identity_snapshot:pid1:core_state:2->3",
      "worker-log:host_identity_snapshot:pid1:renderer:2->3",
      "worker-log:host_identity_snapshot:pid1:runner_process:2->3",
      "worker-log:host_identity_snapshot:pid1:stream:2->3",
    ]);
    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.runtimeIdentityEvidenceRefs).toEqual([
      "worker-log:host_identity:core_state",
      "worker-log:host_identity:renderer",
      "worker-log:host_identity:runner_process",
      "worker-log:host_identity:stream",
    ]);
    expect(proof.runtimeIdentitySnapshotEvidenceRefs).toEqual([
      "worker-log:host_identity_snapshot:pid1:core_state:2->3",
      "worker-log:host_identity_snapshot:pid1:renderer:2->3",
      "worker-log:host_identity_snapshot:pid1:runner_process:2->3",
      "worker-log:host_identity_snapshot:pid1:stream:2->3",
    ]);
  });

  it("rejects host identity-shaped records without runtime boundary provenance", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "application-log host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "application-log host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "application-log host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "application-log host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "application-log host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "application-log host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ], {
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.raw_count).toBe(0);
    expect(evidence.total_count).toBe(0);
    expect(evidence.identity_snapshot_observed).toBe(false);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("does not prove host preservation from runtime identities without expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.identity_snapshot_observed).toBe(true);
    expect(evidence.identity_snapshot_lineage_required).toBe(true);
    expect(evidence.identity_snapshot_lineage_observed).toBe(false);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("proves host preservation only for snapshots spanning the expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ], {
      epochProof: retiredEpochProof(),
    });

    expect(evidence.expected_generation_lineage).toEqual({
      previousGeneration: 2,
      activeGeneration: 3,
    });
    expect(evidence.expected_generation_lineage_observed).toBe(true);
    expect(evidence.lineage_identity_roles_observed).toEqual([
      "core_state",
      "runner_process",
      "stream",
    ]);
    expect(evidence.identity_checks_passed).toBe(true);
    expect(evidence.snapshot_evidence_refs).toEqual([
      "worker-log:host_identity_snapshot:pid1:core_state:2->3",
      "worker-log:host_identity_snapshot:pid1:runner_process:2->3",
      "worker-log:host_identity_snapshot:pid1:stream:2->3",
    ]);
    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
  });

  it("does not let one-generation diagnostic launch identities block host preservation", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=hmr_boundary_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=hmr_boundary_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runtime_context ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runtime_context ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=launch_kernel_abc123 ptr=0x4000 aux=99 generation=2 runtime_session=pid1",
    ], {
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.identity_checks_passed).toBe(true);
    expect(evidence.lineage_identity_roles_missing).toEqual([]);
    expect(evidence.optional_lineage_identity_roles_missing).toEqual(["launch_kernel_abc123"]);
    expect(evidence.snapshot_evidence_refs).toEqual([
      "worker-log:host_identity_snapshot:pid1:hmr_boundary_state:2->3",
      "worker-log:host_identity_snapshot:pid1:runner_process:2->3",
      "worker-log:host_identity_snapshot:pid1:runtime_context:2->3",
    ]);
    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
  });

  it("does not prove host preservation from snapshots outside the expected epoch lineage", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=1 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=1 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=1 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
    ], {
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.expected_generation_lineage_observed).toBe(false);
    expect(evidence.lineage_identity_roles_missing).toEqual([
      "core_state",
      "runner_process",
      "stream",
    ]);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("scopes host preservation identity snapshots to the expected runtime session", () => {
    const evidence = runtimeHostIdentityEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=old-session",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=old-session",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x800 aux=1 generation=2 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=runner_process ptr=0x800 aux=1 generation=3 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x2000 aux=42 generation=2 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x2000 aux=42 generation=3 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=current-session",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=current-session",
    ], {
      runtimeSessionIds: ["current-session"],
      expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
    });

    expect(evidence.raw_count).toBe(8);
    expect(evidence.total_count).toBe(6);
    expect(evidence.rejected_count).toBe(2);
    expect(evidence.rejected_reasons).toEqual(["runtime_session_unexpected"]);
    expect(evidence.runtime_session_ids).toEqual(["current-session"]);
    expect(evidence.identity_checks_passed).toBe(true);
    expect(evidence.preserved_roles).toEqual(["core_state", "runner_process", "stream"]);
    expect(evidence.required_roles_observed).toBe(true);
  });

  it("does not prove host preservation without runner process identity", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.preserved_role_categories).toEqual(["host_state", "runtime_resource"]);
    expect(evidence.required_roles_observed).toBe(false);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("does not prove host preservation from runtime-only identities", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=runtime_context ptr=0x1000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=runtime_context ptr=0x1000 aux=0 generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=launch_stream ptr=0x2000 aux=0 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=launch_stream ptr=0x2000 aux=0 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.preserved_roles).toEqual(["launch_stream", "runtime_context"]);
    expect(evidence.preserved_role_categories).toEqual(["runtime_resource"]);
    expect(evidence.identity_checks_passed).toBe(false);
    expect(proof.resultState).toBeNull();
  });

  it("does not accept host identity snapshots without session provenance", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3",
    ]);

    expect(evidence.raw_count).toBe(2);
    expect(evidence.total_count).toBe(0);
    expect(evidence.rejected_count).toBe(2);
    expect(evidence.rejected_reasons).toEqual(["runtime_session_missing"]);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("reports rejected host identity evidence reasons without using it as proof", () => {
    const evidence = runtimeHostIdentityEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x0 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=not-a-ptr aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=stream ptr=0x3000 aux=0 generation=2 runtime_session=other",
    ], {
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(4);
    expect(evidence.total_count).toBe(0);
    expect(evidence.rejected_count).toBe(4);
    expect(evidence.rejected_reasons).toEqual([
      "ptr_null",
      "ptr_invalid",
      "generation_missing",
      "runtime_session_unexpected",
    ]);
    expect(evidence.identity_checks_passed).toBe(false);
  });

  it("does not prove host preservation when a runtime identity changes", () => {
    const { evidence, proof } = hostPreservationProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1",
      "[gpu-runtime-boundary] host_identity role=core_state ptr=0x1010 aux=42 generation=3 runtime_session=pid1",
    ]);

    expect(evidence.identity_checks_passed).toBe(false);
    expect(evidence.changed_roles).toEqual(["core_state"]);
    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("host_identity_checks_not_collected");
  });

  it("treats validation runtime identity changes as host replacement evidence", () => {
    const { proof } = hostPreservationProofFromRuntimeEvidence([], {
      hostRestartObserved: true,
      identityEvidenceRefs: ["validation:runtime_identity:first_compile"],
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(proof.identityEvidenceRefs).toEqual(["validation:runtime_identity:first_compile"]);
  });

  it("proves original host path attachment only from runtime-scoped attachment evidence", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.total_count).toBe(1);
    expect(evidence.matching_launch_boundary_observed).toBe(true);
    expect(evidence.matching_dispatch_boundary_observed).toBe(true);
    expect(evidence.attached_to_original_host_path).toBe(true);
    expect(evidence.dispatch_entry_runtime_verified).toBe(true);
    expect(evidence.runtime_dispatch_table_entry_id).toBe("entry-1");
    expect(evidence.evidence_refs).toEqual([
      "worker-log:original_host_path:host-main:3",
      "worker-log:launch_arg_provenance:pid1:3:entry-1",
      "worker-log:synthi_gpu_launch:pid1:entry-1",
    ]);
    expect(proof.attachmentProven).toBe(true);
    expect(proof.degradedState).toBeNull();
    expect(summarizeGpuHmrOriginalHostPathProof(proof)).toContain("gpu_original_host_path_proof=attached");
  });

  it("proves generated host launch wrapper attachment with runtime provenance", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=host_runtime_explicit host_path_id=src-render-loop dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.total_count).toBe(1);
    expect(evidence.attached_to_original_host_path).toBe(true);
    expect(evidence.dispatch_entry_runtime_verified).toBe(true);
    expect(proof.attachmentProven).toBe(true);
    expect(proof.degradedState).toBeNull();
  });

  it("rejects original host attachment-shaped records without runtime boundary provenance", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "application-log original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "application-log synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "application-log launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(0);
    expect(evidence.total_count).toBe(0);
    expect(evidence.launch_boundary_count).toBe(0);
    expect(evidence.dispatch_boundary_count).toBe(0);
    expect(evidence.attached_to_original_host_path).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedReason).toBe("original_host_path_attachment_not_observed");
  });

  it("does not prove original host path attachment when declared and runtime dispatch entries differ", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=declared-entry runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.dispatch_entry_runtime_verified).toBe(false);
    expect(evidence.runtime_dispatch_table_entry_id).toBeNull();
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
  });

  it("does not prove original host path attachment without matching launch boundary provenance", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=4 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.launch_boundary_count).toBe(1);
    expect(evidence.matching_launch_boundary_observed).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
    expect(proof.degradedReason).toBe("original_host_path_attachment_not_observed");
  });

  it("does not prove original host path attachment from a different launch provenance entry", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-other dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.launch_boundary_count).toBe(1);
    expect(evidence.matching_launch_boundary_observed).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
  });

  it("does not prove original host path attachment from incomplete launch provenance", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=false known_args=0 unknown_args=1",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.launch_boundary_count).toBe(0);
    expect(evidence.matching_launch_boundary_observed).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
  });

  it("does not prove original host path attachment without matching dispatch boundary evidence", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-other",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.launch_boundary_count).toBe(1);
    expect(evidence.dispatch_boundary_count).toBe(1);
    expect(evidence.matching_dispatch_boundary_observed).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
  });

  it("does not prove original host path attachment from launch-wrapper auto evidence", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=launch_boundary_auto host_path_id=synthi-gpu-launch-1 dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
  });

  it("does not prove original host path attachment from source instrumentation provenance", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=source_instrumented host_path_id=source-site dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.attached_to_original_host_path).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
    expect(proof.degradedReason).toBe("original_host_path_attachment_not_observed");
  });

  it("does not prove original host path attachment without runtime dispatch entry verification", () => {
    const { evidence, proof } = originalHostPathProofFromRuntimeEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=host-main dispatch_table_entry_id=declared-entry runtime_dispatch_table_entry_id=none dispatch_entry_runtime_verified=false generation=3 runtime_session=pid1",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid1 dispatch_table_entry_id=declared-entry",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=pid1 dispatch_table_entry_id=declared-entry dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
    ], {
      required: true,
      runtimeSessionIds: ["pid1"],
    });

    expect(evidence.raw_count).toBe(1);
    expect(evidence.total_count).toBe(0);
    expect(evidence.dispatch_entry_runtime_verified).toBe(false);
    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedReason).toBe("original_host_path_attachment_not_observed");
  });

  it("does not prove original host path attachment from static metadata", () => {
    const proof = classifyGpuHmrOriginalHostPathProof({
      required: true,
      attachedToOriginalHostPath: true,
      runtimeEvidenceObserved: true,
      dispatchBoundaryObserved: true,
      dispatchEntryRuntimeVerified: true,
      sessionScoped: true,
      runtimeSessionIds: ["pid1"],
      evidenceRefs: ["metadata:host_path:static"],
    });

    expect(proof.attachmentProven).toBe(false);
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
    expect(proof.degradedReason).toBe("original_host_path_runtime_evidence_not_collected");
  });

  it("scopes original host path attachment to the expected runtime session", () => {
    const evidence = runtimeOriginalHostPathEvidence([
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=old-host dispatch_table_entry_id=entry-1 runtime_dispatch_table_entry_id=entry-1 dispatch_entry_runtime_verified=true generation=3 runtime_session=old-session",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=old-session dispatch_table_entry_id=entry-1",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=3 runtime_session=old-session dispatch_table_entry_id=entry-1 dispatch_timestamp=123 complete=true known_args=1 unknown_args=0",
      "[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=runtime_explicit host_path_id=current-host dispatch_table_entry_id=entry-2 runtime_dispatch_table_entry_id=entry-2 dispatch_entry_runtime_verified=true generation=4 runtime_session=current-session",
      "[gpu-runtime-boundary] synthi_gpu_launch kernel=render grid=(1, 1, 1) block=(1, 1, 1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=current-session dispatch_table_entry_id=entry-2",
      "[gpu-runtime-boundary] launch_arg_provenance kernel=render generation=4 runtime_session=current-session dispatch_table_entry_id=entry-2 dispatch_timestamp=456 complete=true known_args=1 unknown_args=0",
    ], {
      runtimeSessionIds: ["current-session"],
    });

    expect(evidence.raw_count).toBe(2);
    expect(evidence.total_count).toBe(1);
    expect(evidence.runtime_session_ids).toEqual(["current-session"]);
    expect(evidence.evidence_refs).toEqual([
      "worker-log:original_host_path:current-host:4",
      "worker-log:launch_arg_provenance:current-session:4:entry-2",
      "worker-log:synthi_gpu_launch:current-session:entry-2",
    ]);
  });

  it("requires session dispatch before dispatch proof can be considered", () => {
    const proof = classifyGpuHmrDispatchProof({});

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("dispatch=missing");
  });

  it("requires concrete runtime session identity for dispatch proof", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.degradedReason).toBe("runtime_session_identity_not_collected");
  });

  it("requires runtime launch evidence refs before dispatch proof can be considered", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceRefs: [
        "worker-log:launch_arg_provenance:test:runtime-session.test:2",
      ],
      unknownArgCount: 0,
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.degradedReason).toBe("runtime_dispatch_evidence_refs_not_collected");
    expect(proof.dispatchEvidenceObserved).toBe(false);
  });

  it("does not prove dispatch from launch refs bound to another runtime session", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      sessionScoped: true,
      runtimeSessionIds: ["current-session"],
      dispatchEvidenceRefs: dispatchEvidenceRefs("old-session"),
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceRefs: [
        "worker-log:launch_arg_provenance:current-session:3:entry-1",
      ],
      unknownArgCount: 0,
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.degradedReason).toBe("runtime_dispatch_evidence_session_mismatch");
    expect(proof.dispatchEvidenceObserved).toBe(false);
    expect(proof.dispatchEvidenceRefs).toEqual([]);
    expect(proof.rejectedDispatchEvidenceRefs).toEqual(dispatchEvidenceRefs("old-session"));
  });

  it("downgrades observed dispatch without argument provenance", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      dispatchEvidenceRefs: dispatchEvidenceRefs(),
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_not_collected");
  });

  it("does not prove dispatch safety from argument provenance booleans without runtime evidence refs", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      dispatchEvidenceRefs: dispatchEvidenceRefs(),
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_evidence_refs_not_collected");
    expect(proof.argProvenanceEvidenceObserved).toBe(false);
  });

  it("does not accept non-runtime argument provenance evidence refs", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      dispatchEvidenceRefs: dispatchEvidenceRefs(),
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
      argProvenanceEvidenceRefs: ["validation:launch_arg_provenance:test"],
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedReason).toBe("launch_argument_provenance_evidence_refs_not_collected");
    expect(proof.argProvenanceEvidenceRefs).toEqual([]);
  });

  it("reports dispatch-observed but not safe when ABI proof is missing", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      dispatchEvidenceRefs: dispatchEvidenceRefs(),
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceRefs: [
        "worker-log:launch_arg_provenance:test:runtime-session.test:2",
      ],
      unknownArgCount: 0,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
  });

  it("does not prove dispatch safety from an ABI boolean without proof evidence refs", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      abiProof: null,
      abiProven: true,
      abiProofEvidenceRefs: [],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("dispatch_abi_proof_evidence_refs_not_collected");
    expect(proof.abiProofEvidenceObserved).toBe(false);
  });

  it("does not prove dispatch safety from an epoch boolean without proof evidence refs", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      epochProof: null,
      epochSwapProven: true,
      epochProofEvidenceRefs: [],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("dispatch_epoch_proof_evidence_refs_not_collected");
    expect(proof.epochProofEvidenceObserved).toBe(false);
  });

  it("does not prove dispatch safety when provenance records do not cover known launch args", () => {
    const [record] = safeDispatchProof().argProvenanceRecords;
    const { launchKey: _launchKey, expectedArgCount: _expectedArgCount, ...recordWithoutLaunchCount } = record;
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      argProvenanceRecords: [recordWithoutLaunchCount],
      argProvenanceComplete: true,
      argProvenanceKnownArgCount: 2,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_record_coverage_incomplete");
    expect(proof.argProvenanceComplete).toBe(false);
  });

  it("does not prove dispatch safety without runtime selected artifact binding", () => {
    const proof = classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      dispatchEvidenceRefs: dispatchEvidenceRefs(),
      sessionScoped: true,
      runtimeSessionIds: ["runtime-session:test"],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceRefs: [
        "worker-log:launch_arg_provenance:test:runtime-session.test:2",
      ],
      unknownArgCount: 0,
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      streamOrderingProven: true,
      replacementScopeProven: true,
      selectedArtifactIds: [TEST_ARTIFACT_ID],
      runtimeArtifactIds: [TEST_OTHER_ARTIFACT_ID],
      dispatcherRegistrationIds: [TEST_DISPATCHER_ID],
      dispatchTableEntryIds: ["shade:0x10"],
      dispatchTableHashes: ["0xabc"],
      runtimeArtifactMatchesSelected: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-epoch-swap-unverified");
    expect(proof.degradedReason).toBe("runtime_artifact_does_not_match_selected_artifact");
    expect(proof.runtimeArtifactMatchesSelected).toBe(false);
  });

  it("reports dispatch-safe-proven only with complete ABI, epoch, stream, scope, and argument gates", () => {
    const proof = safeDispatchProof();

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.dispatchEvidenceRefs).toEqual(dispatchEvidenceRefs());
    expect(proof.evidenceRefs).toEqual(expect.arrayContaining(dispatchEvidenceRefs()));
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("provenance=complete");
    expect(summarizeGpuHmrDispatchProof(proof)).toContain("safety=passed");
  });

  it("does not prove dispatch safety without runtime dispatch timestamp identity", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      dispatchTimestamps: [],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.degradedReason).toBe("dispatch_timestamp_not_observed");
  });

  it("does not prove dispatch safety from malformed artifact identities", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      selectedArtifactIds: ["artifact:sha256:not-a-digest"],
      runtimeArtifactIds: ["artifact:sha256:not-a-digest"],
      runtimeArtifactMatchesSelected: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.degradedReason).toBe("selected_artifact_identity_not_observed");
    expect(proof.selectedArtifactIds).toEqual([]);
  });

  it("does not prove dispatch safety without runtime launch shape evidence", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      gridDimensions: [],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.degradedReason).toBe("dispatch_grid_dimensions_not_observed");
  });

  it("does not prove dispatch safety from provenance booleans without argument records", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      argProvenanceRecords: [],
      argProvenanceRecordComplete: false,
      argProvenanceKnownArgCount: 1,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_records_incomplete");
    expect(proof.argProvenanceRecordComplete).toBe(false);
  });

  it("does not prove dispatch safety for device allocations without allocation size", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      argProvenanceRecords: [{
        argIndex: 0,
        category: "device_allocation",
        provenance: "runtime_observed",
        confidence: "verified",
        allocationId: "allocation:test",
        valueSize: 8,
      }],
      argProvenanceKnownArgCount: 1,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_records_incomplete");
    expect(proof.argProvenanceRecords[0].allocationSize).toBeNull();
  });

  it("does not prove dispatch safety for device allocations without allocation identity", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      argProvenanceRecords: [{
        argIndex: 0,
        category: "device_allocation",
        provenance: "runtime_observed",
        confidence: "verified",
        allocationSize: 8,
        valueSize: 8,
      }],
      argProvenanceKnownArgCount: 1,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_records_incomplete");
    expect(proof.argProvenanceRecords[0].allocationId).toBeNull();
  });

  it("uses complete record-level argument provenance when aggregate completeness is stale", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      argProvenanceComplete: false,
      argProvenanceRecordComplete: false,
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.argProvenanceComplete).toBe(true);
    expect(proof.argProvenanceRecordComplete).toBe(true);
  });

  it("keeps argument provenance records distinct by launch identity", () => {
    const proof = classifyGpuHmrDispatchProof({
      ...safeDispatchProof(),
      argProvenanceComplete: false,
      argProvenanceRecordComplete: false,
      argProvenanceKnownArgCount: 2,
      argProvenanceRecords: [
        {
          argIndex: 0,
          category: "device_allocation",
          provenance: "runtime_observed",
          confidence: "verified",
          kernelName: "kernel",
          runtimeSessionId: "runtime-session:test",
          generation: "2",
          launchKey: "kernel:runtime-session:test:2",
          expectedArgCount: 1,
          allocationId: "allocation:test",
          allocationSize: 8,
          valueSize: 8,
        },
        {
          argIndex: 0,
          category: "device_allocation",
          provenance: "runtime_observed",
          confidence: "verified",
          kernelName: "kernel",
          runtimeSessionId: "runtime-session:test",
          generation: "3",
          launchKey: "kernel:runtime-session:test:3",
          expectedArgCount: 1,
          allocationId: "allocation:test",
          allocationSize: 8,
          valueSize: 8,
        },
      ],
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.argProvenanceRecords).toHaveLength(2);
    expect(proof.argProvenanceRecordComplete).toBe(true);
  });

  it("blocks output proof when dispatch argument provenance is incomplete", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        dispatchEvidenceRefs: dispatchEvidenceRefs(),
        sessionScoped: true,
        runtimeSessionIds: ["runtime-session:test"],
        argProvenanceObserved: true,
        argProvenanceComplete: false,
        unknownArgCount: 1,
      }),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.degradedReason).toBe("launch_argument_provenance_incomplete");
  });

  it("rejects deterministic output oracles with unaccepted oracle kinds", () => {
    const proof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: {
        ...deterministicOutputOracle(),
        kind: "visual_change_only",
      },
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-output-unobserved");
    expect(proof.degradedReason).toBe("output_oracle_kind_unaccepted");
    expect(proof.outputOracle.kindAccepted).toBe(false);
  });

  it("blocks full runtime proof at ABI when source proof has not reached ABI", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      outputProof: classifyGpuHmrOutputProof({
        dispatchObserved: true,
        visualFrameObserved: true,
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=abi,artifact-transport,epoch-swap,dispatch-observed,dispatch-safe,output");
  });

  it("blocks full runtime proof when ABI evidence is metadata-only", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: classifyGpuHmrAbiProof({
        metadataObserved: true,
        evidenceRefs: ["evidence:device-abi-metadata:abc"],
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-symbol-bound");
    expect(proof.degradedState).toBe("gpu-hmr-abi-unverified");
    expect(proof.degradedReason).toBe("abi_layout_size_alignment_unverified");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.postPublicationDecision.disposition).toBe("not-published-or-unverified");
    expect(proof.postPublicationDecision.quarantineRequired).toBe(false);
  });

  it("blocks full runtime proof when artifact transport evidence is missing", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-abi-proven");
    expect(proof.degradedState).toBe("gpu-hmr-ram-io-unavailable");
    expect(proof.degradedReason).toBe("artifact_transport_evidence_not_collected");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.componentStates.artifactTransportProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=artifact-transport");
  });

  it("blocks full runtime proof at dispatch when argument provenance is incomplete", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: classifyGpuHmrDispatchProof({
        dispatchObserved: true,
        dispatchEvidenceRefs: dispatchEvidenceRefs(),
        sessionScoped: true,
        runtimeSessionIds: ["runtime-session:test"],
        argProvenanceObserved: true,
        argProvenanceComplete: false,
        unknownArgCount: 1,
      }),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-observed");
    expect(proof.degradedState).toBe("gpu-hmr-unknown-arg-provenance");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=dispatch-safe");
  });

  it("reports full-runtime-proven only when every required component passes", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.fullRuntimeProven).toBe(true);
    expect(proof.postPublicationDecision.disposition).toBe("accepted");
    expect(proof.postPublicationDecision.aiBlessingAllowed).toBe(false);
    expect(proof.componentStates.artifactIdentityProven).toBe(true);
    expect(proof.componentStates.artifactIdentityCommonArtifactIds).toEqual([TEST_ARTIFACT_ID]);
  });

  it("blocks full runtime proof when proof stages refer to different artifacts", () => {
    const transportProof = {
      ...acceptedArtifactTransportProof(),
      selectedArtifactIds: [TEST_OTHER_ARTIFACT_ID],
      artifactContentHashes: [`sha256:${"2".repeat(64)}`],
      ramBlobIds: [TEST_OTHER_ARTIFACT_ID],
      ramBytesHashes: [`sha256:${"2".repeat(64)}`],
    };
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: transportProof,
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBe("gpu-hmr-artifact-identity-unverified");
    expect(proof.degradedReason).toBe("artifact_identity_cross_stage_mismatch");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.componentStates.artifactIdentityRequired).toBe(true);
    expect(proof.componentStates.artifactIdentityProven).toBe(false);
    expect(proof.componentStates.artifactIdentityCommonArtifactIds).toEqual([]);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=artifact-identity");
  });

  it("blocks full runtime proof when required fission verifier evidence is missing", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      fissionProofRequired: true,
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_candidate_verification_not_observed");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.componentStates.fissionProofRequired).toBe(true);
    expect(proof.componentStates.fissionProofProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=fission-candidate-verification");
  });

  it("requires fission verifier evidence for partial artifact replacements", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof({ partial: true })],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedState).toBe("gpu-hmr-fission-unverified");
    expect(proof.degradedReason).toBe("fission_candidate_verification_not_observed");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.componentStates.fissionProofRequired).toBe(true);
    expect(proof.componentStates.partialArtifactReplacementRequiresFission).toBe(true);
  });

  it("allows full runtime proof when required fission verifier evidence passes", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      fissionProof: acceptedFissionProof(),
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.fullRuntimeProven).toBe(true);
    expect(proof.componentStates.fissionProofRequired).toBe(true);
    expect(proof.componentStates.fissionProofProven).toBe(true);
  });

  it("quarantines a published capsule when post-publication gates fail", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        visualFrameObserved: true,
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(proof.postPublicationDecision.disposition).toBe("quarantined");
    expect(proof.postPublicationDecision.epochPublished).toBe(true);
    expect(proof.postPublicationDecision.rollbackRequired).toBe(true);
    expect(proof.postPublicationDecision.aiBlessingAllowed).toBe(false);
    expect(proof.postPublicationDecision.blockedStageIds).toEqual(["output"]);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("capsule=quarantined");
  });

  it("blocks full runtime proof when original host path attachment is required but missing", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
      originalHostPathRequired: true,
    });

    expect(proof.resultState).toBe("gpu-hmr-host-preservation-proven");
    expect(proof.degradedState).toBe("gpu-hmr-original-host-path-unattached");
    expect(proof.degradedReason).toBe("original_host_path_attachment_not_observed");
    expect(proof.fullRuntimeProven).toBe(false);
    expect(summarizeGpuHmrFullRuntimeProof(proof)).toContain("blocked=original-host-path");
  });

  it("reports full runtime proof with required original host path only when attachment proof is runtime-backed", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
      originalHostPathProof: attachedOriginalHostPathProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.degradedState).toBeNull();
    expect(proof.fullRuntimeProven).toBe(true);
    expect(proof.componentStates.originalHostPathRequired).toBe(true);
    expect(proof.componentStates.originalHostPathProven).toBe(true);
  });

  it("materializes runtime proof ladder as a structured validation artifact", () => {
    const dispatchProof = safeDispatchProof();
    const sourceProof = acceptedSourceProof();
    const outputProof = classifyGpuHmrOutputProof({
      dispatchProof,
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualFrameObserved: true,
      visualEvidenceRefs: ["artifacts/frame.png"],
    });
    const fullRuntimeProof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [sourceProof],
      fissionProof: acceptedFissionProof(),
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof,
      outputProof,
      hostPreservationProof: preservedHostProof(),
      originalHostPathProof: attachedOriginalHostPathProof(),
    });

    const artifact = buildValidationRuntimeProofArtifact({
      workspaceSlug: "workspace",
      runtimeSessionIds: ["runtime-session:test"],
      sourceProofs: [sourceProof],
      fissionProof: acceptedFissionProof(),
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof,
      outputProof,
      hostPreservationProof: preservedHostProof(),
      originalHostPathProof: attachedOriginalHostPathProof(),
      fullRuntimeProof,
      runtimeEvidence: {
        hostIdentitySnapshots: {
          evidence_refs: ["worker-log:host_identity:renderer_state"],
          snapshot_evidence_refs: [
            "worker-log:host_identity_snapshot:test:renderer_state:2->3",
          ],
          lines: [
            "[gpu-runtime-boundary] host_identity role=renderer_state ptr=0x1000 generation=3 runtime_session=test",
          ],
        },
      },
      validationContext: {
        command: {
          cwd: "/repo/mcp/synthi-mcp",
          argv: ["node", "scripts/gpu-hmr-test.mjs"],
          env: { SYNTHI_GPU_VENDOR: "rocm" },
        },
        docker: {
          enabled: true,
          containers: {
            worker: {
              image_id: "sha256:worker-image",
              status: "running",
              restart_count: 0,
            },
          },
        },
        timings: {
          started_at: "2026-05-28T00:00:00.000Z",
          finished_at: "2026-05-28T00:00:01.000Z",
          duration_ms: 1000,
        },
      },
      visualEvidenceRefs: ["artifacts/frame.png"],
      createdAt: "2026-05-28T00:00:00.000Z",
    });

    expect(artifact.schemaVersion).toBe("synthi.gpu.hmr.proof.v1");
    expect(artifact.proofId).toMatch(/^gpu-runtime-proof:sha256:/);
    expect(artifact.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(artifact.stageResults.map((stage) => stage.stageId)).toContain("artifact-transport");
    expect(artifact.stageResults.map((stage) => stage.stageId)).toContain("artifact-identity");
    expect(artifact.stageResults.map((stage) => stage.stageId)).toContain("host-preservation");
    const compileStage = artifact.stageResults.find((stage) => stage.stageId === "compile");
    const symbolStage = artifact.stageResults.find((stage) => stage.stageId === "symbol-binding");
    const outputStage = artifact.stageResults.find((stage) => stage.stageId === "output");
    const artifactIdentityStage = artifact.stageResults.find((stage) => stage.stageId === "artifact-identity");
    expect(compileStage?.outputArtifactIds).toEqual([TEST_ARTIFACT_ID]);
    expect(symbolStage?.outputArtifactIds).toEqual([TEST_ARTIFACT_ID]);
    expect(outputStage?.inputArtifactIds).toEqual([TEST_ARTIFACT_ID]);
    expect(outputStage?.outputArtifactIds).toEqual([TEST_ARTIFACT_ID]);
    expect(artifactIdentityStage?.inputArtifactIds).toEqual([TEST_ARTIFACT_ID]);
    expect(artifactIdentityStage?.outputArtifactIds).toEqual([TEST_ARTIFACT_ID]);
    expect(artifactIdentityStage?.artifactIdentity).toEqual({
      required: true,
      proven: true,
      commonArtifactIds: [TEST_ARTIFACT_ID],
      idsByStage: expect.objectContaining({
        source: [TEST_ARTIFACT_ID],
        transport: [TEST_ARTIFACT_ID],
        epoch: [TEST_ARTIFACT_ID],
        dispatch: [TEST_ARTIFACT_ID],
        output: [TEST_ARTIFACT_ID],
      }),
      missingStages: [],
    });
    expect(artifactIdentityStage?.evidenceRefs).toEqual(expect.arrayContaining([
      ".synthi/gpu-hmr/proofs/source-proof.json",
      "worker-log:artifact_transport:sha256:abc",
      "evidence:epoch:abc",
      "worker-log:synthi_gpu_launch:runtime-session:test:shade",
      "evidence:output-oracle:readback:abc",
    ]));
    expect(artifact.componentStates.artifactIdentityProven).toBe(true);
    expect(artifact.componentStates.artifactIdentityCommonArtifactIds).toEqual([TEST_ARTIFACT_ID]);
    expect(compileStage?.evidenceRefs).toEqual(expect.arrayContaining([
      ".synthi/gpu-hmr/proofs/source-proof.json",
      "evidence:source:device-artifact",
      "evidence:source:device-compiler",
    ]));
    expect(compileStage?.evidenceRefs).not.toContain("evidence:source:device-symbols");
    expect(symbolStage?.evidenceRefs).toEqual(expect.arrayContaining([
      ".synthi/gpu-hmr/proofs/source-proof.json",
      "evidence:source:device-symbols",
    ]));
    expect(symbolStage?.evidenceRefs).not.toContain("evidence:source:device-compiler");
    expect(artifact.limitations).toEqual([]);
    expect(artifact.stageResults.every((stage) => Array.isArray(stage.evidenceRefs))).toBe(true);
    expect(artifact.evidenceRefs.map((ref) => ref.evidenceId)).toContain("worker-log:artifact_transport:sha256:abc");
    expect(artifact.evidenceRefs.map((ref) => ref.evidenceId)).toContain("worker-log:host_identity:core_state");
    expect(artifact.evidenceRefs.map((ref) => ref.evidenceId)).toContain("worker-log:host_identity:renderer_state");
    expect(artifact.evidenceRefs.map((ref) => ref.evidenceId)).toContain(
      "worker-log:host_identity_snapshot:runtime-session:test:core_state:2->3",
    );
    expect(artifact.evidenceRefs.map((ref) => ref.evidenceId)).toContain(
      "worker-log:host_identity_snapshot:test:renderer_state:2->3",
    );
    expect(artifact.visualEvidenceRefs).toEqual(["artifacts/frame.png"]);
    expect(artifact.runtimeEvidence.hostIdentitySnapshots.lines[0]).toContain("renderer_state");
    expect(artifact.validationContextHash).toMatch(/^sha256:/);
    expect(artifact.validationContext.docker.containers.worker.image_id).toBe("sha256:worker-image");
    expect(artifact.validationContext.command.argv).toEqual(["node", "scripts/gpu-hmr-test.mjs"]);
    expect(artifact.proofMaterial.fullRuntimeProof.fullRuntimeProven).toBe(true);
    expect(artifact.proofMaterial.runtimeEvidence.hostIdentitySnapshots.evidence_refs).toEqual([
      "worker-log:host_identity:renderer_state",
    ]);
    expect(artifact.proofMaterial.runtimeEvidence.hostIdentitySnapshots.snapshot_evidence_refs).toEqual([
      "worker-log:host_identity_snapshot:test:renderer_state:2->3",
    ]);
    expect(artifact.proofMaterial.validationContext.timings.duration_ms).toBe(1000);
  });

  it("records blocked proof stages as first-class validation limitations", () => {
    const sourceProof = acceptedSourceProof();
    const fullRuntimeProof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [sourceProof],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      hostPreservationProof: preservedHostProof(),
    });

    const artifact = buildValidationRuntimeProofArtifact({
      workspaceSlug: "workspace",
      runtimeSessionIds: ["runtime-session:test"],
      sourceProofs: [sourceProof],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      hostPreservationProof: preservedHostProof(),
      fullRuntimeProof,
      createdAt: "2026-05-28T00:00:00.000Z",
    });

    expect(artifact.fullRuntimeProven).toBe(false);
    expect(artifact.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "dispatch-observed",
          status: "blocked",
          degradedState: "gpu-hmr-dispatch-unobserved",
          degradedReason: "runtime_dispatch_not_observed",
        }),
        expect.objectContaining({
          stageId: "output",
          status: "blocked",
          degradedState: "gpu-hmr-output-unobserved",
          degradedReason: "output_oracle_not_collected",
        }),
      ])
    );
  });

  it("summarizes validation proof states and supplemental visual artifacts", () => {
    const sourceProof = acceptedSourceProof();
    const fullRuntimeProof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [sourceProof],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      hostPreservationProof: preservedHostProof(),
    });

    const summary = buildGpuHmrValidationProofSummary({
      workspaceSlug: "workspace",
      model: "validation-model",
      gpuVendor: "rocm",
      gpuArch: "gfx-test",
      validationContext: {
        docker: {
          enabled: true,
          containers: {
            worker: {
              container: "worker-container",
              image_id: "sha256:worker-image",
              status: "running",
              restart_count: 0,
              exit_code: 0,
              available: true,
            },
            mcp: {
              container: "mcp-container",
              image_id: "sha256:mcp-image",
              status: "running",
              restart_count: 0,
              exit_code: 0,
              available: true,
            },
          },
        },
        timings: {
          started_at: "2026-05-28T00:00:00.000Z",
          finished_at: "2026-05-28T00:00:01.000Z",
          duration_ms: 1000,
        },
      },
      runtimeFullProofs: [{ phase: "FLOW", name: "outward", proof: fullRuntimeProof }],
      artifactTransportProof: acceptedArtifactTransportProof(),
      runtimeProofArtifactRecords: [{
        phase: "FLOW",
        name: "outward",
        path: "logs/runtime-proof.json",
        proofId: "gpu-runtime-proof:sha256:abc",
        resultState: fullRuntimeProof.resultState,
        degradedState: fullRuntimeProof.degradedState,
        degradedReason: fullRuntimeProof.degradedReason,
        fullRuntimeProven: false,
        limitations: [{
          stageId: "dispatch-observed",
          status: "blocked",
          requiredState: "gpu-hmr-dispatch-proven",
          observedState: null,
          degradedState: "gpu-hmr-dispatch-unobserved",
          degradedReason: "runtime_dispatch_not_observed",
        }],
      }],
      proofArtifactPaths: [".synthi/gpu-hmr/proofs/source-proof.json"],
      visualArtifactPaths: ["artifacts/frame.png"],
    });

    expect(summary.schema_version).toBe("synthi.gpu.hmr.validation-proof-summary.v1");
    expect(summary.workspace_slug).toBe("workspace");
    expect(summary.model).toBe("validation-model");
    expect(summary.gpu_vendor).toBe("rocm");
    expect(summary.gpu_arch).toBe("gfx-test");
    expect(summary.timings?.duration_ms).toBe(1000);
    expect(summary.docker_image_ids.worker).toBe("sha256:worker-image");
    expect(summary.docker_container_states.mcp.status).toBe("running");
    expect(summary.screenshot_artifact_paths).toEqual(["artifacts/frame.png"]);
    expect(summary.runtime_proof_artifact_paths).toEqual(["logs/runtime-proof.json"]);
    expect(summary.proof_artifact_paths).toEqual(expect.arrayContaining([
      ".synthi/gpu-hmr/proofs/source-proof.json",
      "logs/runtime-proof.json",
    ]));
    expect(summary.proof_states.runtime_full[0].full_runtime_proven).toBe(false);
    expect(summary.proof_states.runtime_full[0].blocked_stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage_id: "dispatch-observed",
          degraded_reason: "runtime_dispatch_not_observed",
        }),
      ])
    );
    expect(summary.proof_states.artifact_transport.result_state).toBe(
      "gpu-hmr-artifact-transport-proven",
    );
    expect(summary.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage_id: "dispatch-observed",
          proof_artifact_path: "logs/runtime-proof.json",
        }),
      ])
    );
    expect(summary.visual_evidence_is_supplemental).toBe(true);
    expect(summary.output_correctness_requires_deterministic_oracle).toBe(true);
    expect(summary.full_runtime_proven).toBe(false);
  });

  it("summarizes flat Docker snapshots and separates blank screenshot attempts", () => {
    const summary = buildGpuHmrValidationProofSummary({
      workspaceSlug: "workspace",
      docker: {
        worker: {
          container: "worker-container",
          image_id: "sha256:worker-image",
          status: "running",
          restart_count: 0,
          exit_code: 0,
          available: true,
        },
      },
      screenshots: [
        {
          label: "first",
          path: "artifacts/blank.png",
          width: 800,
          height: 600,
          visible_pixels: 0,
          mean_luma: 0,
          luma_stddev: 0,
          rgb_span_mean: 0,
          unique_color_sample_count: 1,
        },
        {
          label: "flat",
          path: "artifacts/flat.png",
          width: 800,
          height: 600,
          visible_pixels: 480000,
          mean_luma: 90,
          luma_stddev: 0.2,
          rgb_span_mean: 0,
          unique_color_sample_count: 1,
        },
        {
          label: "varied",
          path: "artifacts/varied.png",
          width: 800,
          height: 600,
          visible_pixels: 480000,
          mean_luma: 90,
          luma_stddev: 24,
          rgb_span_mean: 128,
          unique_color_sample_count: 128,
        },
      ],
    });

    expect(summary.docker_image_ids.worker).toBe("sha256:worker-image");
    expect(summary.screenshot_artifact_paths).toEqual([
      "artifacts/blank.png",
      "artifacts/flat.png",
      "artifacts/varied.png",
    ]);
    expect(summary.visual_artifact_paths).toEqual([
      "artifacts/varied.png",
    ]);
    expect(summary.visual_evidence_quality).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "artifacts/blank.png",
          visual_quality: "gpu-hmr-visual-blank",
          accepted_as_visual_evidence: false,
        }),
        expect.objectContaining({
          path: "artifacts/flat.png",
          visual_quality: "gpu-hmr-visual-flat-frame",
          accepted_as_visual_evidence: false,
        }),
        expect.objectContaining({
          path: "artifacts/varied.png",
          visual_quality: "gpu-hmr-visual-varied-frame",
          accepted_as_visual_evidence: true,
        }),
      ])
    );
    expect(summary.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage_id: "visual-evidence",
          status: "diagnostic",
          degraded_reason: "visual_evidence_low_variance",
          degraded_state: "gpu-hmr-visual-flat-frame",
        }),
      ])
    );
  });

  it("reports missing accepted visual evidence only when a render run expects it", () => {
    const optionalSummary = buildGpuHmrValidationProofSummary({
      workspaceSlug: "workspace",
      screenshots: [],
    });
    expect(optionalSummary.visual_artifact_paths).toEqual([]);
    expect(optionalSummary.limitations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage_id: "visual-evidence",
          degraded_state: "gpu-hmr-visual-evidence-missing",
        }),
      ])
    );

    const missingSummary = buildGpuHmrValidationProofSummary({
      workspaceSlug: "workspace",
      visualEvidenceExpected: true,
      screenshots: [],
    });

    expect(missingSummary.visual_artifact_paths).toEqual([]);
    expect(missingSummary.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage_id: "visual-evidence",
          status: "blocked",
          required_state: "gpu-hmr-visual-varied-frame",
          degraded_state: "gpu-hmr-visual-evidence-missing",
          degraded_reason: "visual_evidence_not_collected",
        }),
      ])
    );
  });

  it("reports rejected screenshots as missing accepted visual evidence for render runs", () => {
    const summary = buildGpuHmrValidationProofSummary({
      workspaceSlug: "workspace",
      visualEvidenceExpected: true,
      screenshots: [
        {
          label: "flat",
          path: "artifacts/flat.png",
          width: 800,
          height: 600,
          visible_pixels: 480000,
          mean_luma: 90,
          luma_stddev: 0.2,
          rgb_span_mean: 0,
          unique_color_sample_count: 1,
        },
      ],
    });

    expect(summary.visual_artifact_paths).toEqual([]);
    expect(summary.visual_evidence_quality).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "artifacts/flat.png",
          visual_quality: "gpu-hmr-visual-flat-frame",
          accepted_as_visual_evidence: false,
        }),
      ])
    );
    expect(summary.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage_id: "visual-evidence",
          status: "diagnostic",
          degraded_reason: "visual_evidence_low_variance",
          degraded_state: "gpu-hmr-visual-flat-frame",
        }),
        expect.objectContaining({
          stage_id: "visual-evidence",
          status: "blocked",
          degraded_state: "gpu-hmr-visual-evidence-missing",
          degraded_reason: "visual_evidence_not_accepted",
        }),
      ])
    );
  });

  it("does not reconstruct dispatch proof from output state alone", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      outputProof: { resultState: "gpu-hmr-output-oracle-proven" },
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-epoch-swap-proven");
    expect(proof.degradedState).toBe("gpu-hmr-dispatch-unobserved");
    expect(proof.fullRuntimeProven).toBe(false);
  });

  it("uses dispatch proof embedded in output proof for the full ladder", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof.fullRuntimeProven).toBe(true);
  });

  it("does not accept label-only source proof for compile or symbol gates", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [{ resultState: "gpu-hmr-symbol-bound" }],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBeNull();
    expect(proof.degradedReason).toBe("compile_evidence_not_collected");
    expect(proof.stages.find((stage) => stage.stageId === "compile")?.status).toBe("blocked");
    expect(proof.stages.find((stage) => stage.stageId === "symbol-binding")?.status).toBe("blocked");
    expect(proof.fullRuntimeProven).toBe(false);
  });

  it("preserves specific output degraded state in the full ladder", () => {
    const outputProof = classifyGpuHmrOutputProof({
      dispatchProof: safeDispatchProof(),
      deterministicOutputObserved: true,
      deterministicOracleProvided: true,
      deterministicOraclePassed: true,
      outputOracle: deterministicOutputOracle(),
      visualEvidenceRequired: true,
      visualFrameObserved: false,
      visualEvidenceRefs: [],
    });
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof,
      hostPreservationProof: preservedHostProof(),
    });

    expect(proof.resultState).toBe("gpu-hmr-dispatch-safe-proven");
    expect(proof.degradedState).toBe("gpu-hmr-visual-evidence-missing");
    expect(proof.stages.find((stage) => stage.stageId === "output")?.degradedState)
      .toBe("gpu-hmr-visual-evidence-missing");
  });

  it("does not accept claimed host preservation without runtime identity snapshot provenance", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: { resultState: "gpu-hmr-host-preservation-proven" },
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedReason).toBe("host_identity_snapshot_provenance_unverified");
    expect(proof.fullRuntimeProven).toBe(false);
  });

  it("keeps host replacement as a full-runtime blocker after output proof", () => {
    const proof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: [acceptedSourceProof()],
      abiProof: acceptedAbiProof(),
      artifactTransportProof: acceptedArtifactTransportProof(),
      epochProof: retiredEpochProof(),
      dispatchProof: safeDispatchProof(),
      outputProof: classifyGpuHmrOutputProof({
        dispatchProof: safeDispatchProof(),
        deterministicOutputObserved: true,
        deterministicOracleProvided: true,
        deterministicOraclePassed: true,
        outputOracle: deterministicOutputOracle(),
      }),
      hostPreservationProof: classifyGpuHmrHostPreservationProof({
        hostReplacementObserved: true,
      }),
    });

    expect(proof.resultState).toBe("gpu-hmr-output-oracle-proven");
    expect(proof.degradedState).toBe("gpu-hmr-host-replaced");
    expect(proof.fullRuntimeProven).toBe(false);
  });
});
