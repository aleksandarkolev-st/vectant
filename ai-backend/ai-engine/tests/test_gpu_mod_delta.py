import json

import pytest

from agents.gpu_mod_delta import (
    GpuDiffPatchRequest,
    build_gpu_diff_patch_retry_prompt,
    build_gpu_diff_patch_prompt,
    classify_mod_delta,
    gpu_diff_patch_anchor_failures,
    gpu_diff_patch_content_failures,
    parse_gpu_diff_response,
)


BASE = {
    "core.cpp": "void step(){ synthi_gpu_launch(gpu, \"vec_add\", 1, 256, 0, stream, { &a, &b, &c, &n }); }",
    "device.cu": "__global__ void vec_add(const float* a, const float* b, float* c, int n){ c[0]=a[0]+b[0]; }",
}


def test_device_body_change_is_device_only():
    changed = dict(BASE)
    changed["device.cu"] = BASE["device.cu"].replace("+", "*")
    result = classify_mod_delta(BASE, changed)
    assert result.reload_plan == "device_only"


def test_signature_change_is_abi_breaking():
    changed = dict(BASE)
    changed["device.cu"] = BASE["device.cu"].replace("int n)", "int n, float scale)")
    result = classify_mod_delta(BASE, changed)
    assert result.reload_plan == "abi_breaking"


def test_host_and_device_body_change_is_mixed():
    changed = dict(BASE)
    changed["core.cpp"] = BASE["core.cpp"].replace("256", "128")
    changed["device.cu"] = BASE["device.cu"].replace("+", "*")
    result = classify_mod_delta(BASE, changed)
    assert result.reload_plan == "mixed"


def test_parse_gpu_diff_response_normalizes_device_file_module():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [
                {
                    "module": "device.cu",
                    "operation": "replace",
                    "anchor": "a+b",
                    "content": "a*b",
                }
            ],
        }
    )
    parsed = parse_gpu_diff_response(raw)
    assert parsed["edits"][0]["module"] == "device"


def test_parse_gpu_diff_response_preserves_fission_candidate_as_proposal():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "islandId": "island:1",
                "targetSymbols": ["step"],
                "requiredOracleId": "oracle:1",
            },
        }
    )
    parsed = parse_gpu_diff_response(raw)
    assert parsed["fissionCandidate"]["islandId"] == "island:1"
    assert parsed["fissionCandidate"]["targetSymbols"] == ["step"]


def test_parse_gpu_diff_response_normalizes_fission_candidate_plan_aliases():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "symbols": ["step"],
                "oracleProposal": {"kind": "checksum"},
                "sourceMappingEvidenceIds": ["evidence:source-map"],
                "includeClosureEvidenceIds": ["evidence:include-closure"],
                "symbolOwnershipEvidenceIds": ["evidence:symbol-ownership"],
                "dependencyClosureEvidenceIds": ["evidence:dependency-closure"],
                "abiMembraneEvidenceIds": ["evidence:abi-membrane"],
                "compileRecipeEvidenceIds": ["evidence:compile-recipe"],
                "loaderCapabilityEvidenceIds": ["evidence:loader-capability"],
                "outputOracleEvidenceIds": ["evidence:output-oracle"],
                "originalHostLaunchMappingEvidenceIds": ["evidence:original-host-launch-mapping"],
                "safeExportSupersetEvidenceIds": ["evidence:safe-export"],
                "narrowerCandidateRejections": [
                    {
                        "scopeRank": 0,
                        "reasonCode": "fission.edit_crosses_body_boundary",
                        "verifierEvidenceIds": ["evidence:source-map"],
                    }
                ],
                "proofFailureReasonCodes": ["fission.output_oracle_missing"],
                "sourceSpans": [{"path": "device.cu", "startLine": 7, "endLine": 9}],
            },
        }
    )
    parsed = parse_gpu_diff_response(raw)
    candidate = parsed["fissionCandidate"]
    assert candidate["targetSymbols"] == ["step"]
    assert candidate["outputOracleProposal"] == {"kind": "checksum"}
    assert candidate["abiMembraneEvidenceIds"] == ["evidence:abi-membrane"]
    assert candidate["compileRecipeEvidenceIds"] == ["evidence:compile-recipe"]
    assert candidate["loaderCapabilityEvidenceIds"] == ["evidence:loader-capability"]
    assert candidate["outputOracleEvidenceIds"] == ["evidence:output-oracle"]
    assert candidate["originalHostLaunchMappingEvidenceIds"] == [
        "evidence:original-host-launch-mapping"
    ]
    assert candidate["safeExportSupersetEvidenceIds"] == ["evidence:safe-export"]
    assert candidate["narrowerCandidateRejections"][0]["scopeRank"] == 0
    assert candidate["sourceSpans"][0]["startLine"] == 7


def test_parse_gpu_diff_response_preserves_output_oracle_provenance_fields():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "outputOracleProposal": {
                    "kind": "selected_pixels",
                    "producer": "deterministic_probe",
                    "expected": "[[0,0,[1,0,0,1]]]",
                    "tolerance": 0.001,
                    "outputTargetId": "render-target:primary",
                    "readbackPlan": "after-hmr-frame-1",
                    "probeMode": "fixed_scene",
                    "artifactId": "artifact:sha256:abc",
                    "runtimeSessionId": "runtime-session:abc",
                    "visualEvidenceRef": "artifacts/frame.png",
                },
            },
        }
    )
    parsed = parse_gpu_diff_response(raw)
    proposal = parsed["fissionCandidate"]["outputOracleProposal"]
    assert proposal["outputTargetId"] == "render-target:primary"
    assert proposal["artifactId"] == "artifact:sha256:abc"
    assert proposal["runtimeSessionId"] == "runtime-session:abc"
    assert proposal["tolerance"] == 0.001


def test_parse_gpu_diff_response_preserves_attachment_instrumentation_proposal():
    proposal_id = "launch-attachment-proposal:sha256:" + "4" * 64
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "originalHostAttachmentInstrumentationProposalIds": [proposal_id],
                "attachmentInstrumentationProposals": [
                    {
                        "proposalId": proposal_id,
                        "sourceLaunchSiteId": "launch-site:sha256:" + "5" * 64,
                        "hostPathId": "host-path:sha256:" + "6" * 64,
                        "path": "src/render_loop.cpp",
                        "line": 42,
                        "column": 17,
                        "sourceProvenance": "source_baseline_contents",
                        "sourceHash": "sha256:" + "a" * 64,
                        "snippetHash": "sha256:" + "b" * 64,
                        "instrumentationAction": "upgrade_runtime_boundary_to_original_host_attachment",
                        "requiredBoundaryApis": [
                            "synthi_gpu_launch_source_location",
                            "synthi_gpu_launch_original_host_path",
                        ],
                        "runtimeEvidenceRequired": {
                            "runtimeSessionScoped": True,
                            "dispatchBoundaryObserved": True,
                            "dispatchEntryRuntimeVerified": True,
                            "launchArgProvenanceComplete": True,
                        },
                    }
                ],
            },
        }
    )
    parsed = parse_gpu_diff_response(raw)
    candidate = parsed["fissionCandidate"]
    assert candidate["originalHostAttachmentInstrumentationProposalIds"] == [proposal_id]
    assert candidate["attachmentInstrumentationProposals"][0]["proposalId"] == proposal_id
    assert (
        "synthi_gpu_launch_original_host_path"
        in candidate["attachmentInstrumentationProposals"][0]["requiredBoundaryApis"]
    )


def test_parse_gpu_diff_response_rejects_bare_attachment_proposal_id():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "originalHostAttachmentInstrumentationProposalIds": [
                    "launch-attachment-proposal:sha256:" + "7" * 64
                ],
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "requires matching structured attachmentInstrumentationProposals" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_incomplete_attachment_proposal_metadata():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "attachmentInstrumentationProposals": [
                    {
                        "proposalId": "launch-attachment-proposal:sha256:" + "8" * 64,
                        "sourceLaunchSiteId": "launch-site:sha256:" + "9" * 64,
                        "hostPathId": "host-path:sha256:" + "a" * 64,
                        "requiredBoundaryApis": [
                            "synthi_gpu_launch_source_location",
                            "synthi_gpu_launch_original_host_path",
                        ],
                        "runtimeEvidenceRequired": {
                            "runtimeSessionScoped": True,
                            "dispatchBoundaryObserved": True,
                            "dispatchEntryRuntimeVerified": True,
                        },
                    }
                ],
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.attachmentInstrumentationProposals[0]" in str(excinfo.value)
    assert "non-empty string" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_malformed_attachment_proposal():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "attachmentInstrumentationProposals": [
                    {
                        "proposalId": "launch-attachment-proposal:sha256:" + "8" * 64,
                        "sourceLaunchSiteId": "launch-site:sha256:" + "9" * 64,
                        "hostPathId": "host-path:sha256:" + "a" * 64,
                        "path": "src/render_loop.cpp",
                        "line": 42,
                        "column": 17,
                        "sourceProvenance": "source_baseline_contents",
                        "sourceHash": "sha256:" + "b" * 64,
                        "snippetHash": "sha256:" + "c" * 64,
                        "instrumentationAction": "upgrade_runtime_boundary_to_original_host_attachment",
                        "requiredBoundaryApis": ["unrelated_api"],
                        "runtimeEvidenceRequired": {
                            "runtimeSessionScoped": True,
                            "dispatchBoundaryObserved": True,
                            "dispatchEntryRuntimeVerified": True,
                            "launchArgProvenanceComplete": True,
                        },
                    }
                ],
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "requiredBoundaryApis" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_malformed_output_oracle_proposal():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "outputOracleProposal": {
                    "kind": "selected_pixels",
                    "producer": "deterministic_probe",
                    "outputTargetId": 7,
                    "tolerance": -0.1,
                },
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.outputOracleProposal.outputTargetId" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_invalid_fission_evidence_shape():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {"sourceMappingEvidenceIds": ["evidence:source-map", ""]},
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.sourceMappingEvidenceIds[1]" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_invalid_fission_source_span():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "sourceSpans": [{"path": "device.cu", "startLine": 9, "endLine": 7}],
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.sourceSpans[0].endLine" in str(excinfo.value)


def test_parse_gpu_diff_response_accepts_byte_span_fission_source_span():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "sourceSpans": [{"path": "device.cu", "startByte": 10, "endByte": 42}],
            },
        }
    )
    parsed = parse_gpu_diff_response(raw)
    assert parsed["fissionCandidate"]["sourceSpans"][0]["startByte"] == 10
    assert parsed["fissionCandidate"]["sourceSpans"][0]["endByte"] == 42


def test_parse_gpu_diff_response_rejects_invalid_fission_rejection_evidence():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "narrowerCandidateRejections": [
                    {
                        "scopeRank": -1,
                        "reasonCode": "fission.edit_crosses_body_boundary",
                        "verifierEvidenceIds": ["evidence:source-map"],
                    }
                ],
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.narrowerCandidateRejections[0].scopeRank" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_unregistered_fission_reason_codes():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "proofFailureReasonCodes": ["fission.not_registered"],
                "narrowerCandidateRejections": [
                    {
                        "scopeRank": 0,
                        "reasonCode": "fission.edit_crosses_body_boundary",
                        "verifierEvidenceIds": ["evidence:source-map"],
                    }
                ],
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.proofFailureReasonCodes" in str(excinfo.value)
    assert "fission.not_registered" in str(excinfo.value)

    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "narrowerCandidateRejections": [
                    {
                        "scopeRank": 0,
                        "reasonCode": "fission.not_registered",
                        "verifierEvidenceIds": ["evidence:source-map"],
                    }
                ],
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.narrowerCandidateRejections[0].reasonCode" in str(excinfo.value)
    assert "fission.not_registered" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_invalid_fission_timing_hint():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "compileCostEstimateMs": "fast",
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.compileCostEstimateMs" in str(excinfo.value)


def test_parse_gpu_diff_response_rejects_placeholder_fission_hashes():
    raw = json.dumps(
        {
            "reload_plan": "device_only",
            "edits": [],
            "fissionCandidate": {
                "dependencyClosureHash": "...",
                "compileRecipeHash": "sha256:not-real",
                "compileCommandHash": "0" * 64,
            },
        }
    )
    with pytest.raises(Exception) as excinfo:
        parse_gpu_diff_response(raw)
    assert "fissionCandidate.compileRecipeHash" in str(excinfo.value)
    assert "SHA-256" in str(excinfo.value)


def test_gpu_prompt_contains_runtime_boundary_rule():
    prompt = build_gpu_diff_patch_prompt(GpuDiffPatchRequest(diff="@@"))
    assert "synthi_gpu_launch" in prompt
    assert "synthi_gpu_launch_original_host_path" in prompt
    assert "reload_plan" in prompt


def test_gpu_prompt_marks_fission_candidate_as_proposal_only():
    prompt = build_gpu_diff_patch_prompt(GpuDiffPatchRequest(diff="@@"))
    assert "fissionCandidate" in prompt
    assert "deterministic verifier" in prompt
    assert "sourceMappingEvidenceIds" in prompt
    assert "compileRecipeEvidenceIds" in prompt
    assert "loaderCapabilityEvidenceIds" in prompt
    assert "outputOracleEvidenceIds" in prompt
    assert "outputOracleProposal" in prompt
    assert "outputTargetId" in prompt
    assert "artifactId" in prompt
    assert "attachmentInstrumentationProposals" in prompt
    assert "instrumentationAction" in prompt
    assert "launchArgProvenanceComplete" in prompt
    assert "originalHostAttachmentInstrumentationProposalIds" in prompt
    assert "dispatchEntryRuntimeVerified" in prompt
    assert "originalHostLaunchMappingEvidenceIds" in prompt
    assert "narrowerCandidateRejections" in prompt
    assert "Do not invent ids" in prompt
    assert "Do not emit bare attachment proposal ids" in prompt
    assert "Use null" in prompt
    assert "SHA-256" in prompt


def test_gpu_prompt_requires_generated_role_anchors():
    prompt = build_gpu_diff_patch_prompt(GpuDiffPatchRequest(diff="@@"))
    assert "CURRENT generated role files" in prompt
    assert "original user source" in prompt


def test_gpu_delta_anchor_verifier_rejects_user_source_only_anchor():
    req = GpuDiffPatchRequest(
        diff="- vx[i] += force;\n+ vx[i] -= force;",
        device_content="extern \"C\" __global__ void step(float* vx) { vx[i] += generated_force; }",
    )
    failures = gpu_diff_patch_anchor_failures(
        req,
        [
            {
                "module": "device",
                "operation": "replace",
                "anchor": "vx[i] += force;",
                "content": "vx[i] -= force;",
            }
        ],
    )
    assert failures
    assert failures[0]["reason"] == "anchor_missing"


def test_gpu_delta_anchor_verifier_accepts_generated_device_anchor():
    req = GpuDiffPatchRequest(
        diff="- vx[i] += force;\n+ vx[i] -= force;",
        device_content="extern \"C\" __global__ void step(float* vx) { vx[i] += generated_force; }",
    )
    failures = gpu_diff_patch_anchor_failures(
        req,
        [
            {
                "module": "device",
                "operation": "replace",
                "anchor": "vx[i] += generated_force;",
                "content": "vx[i] -= generated_force;",
            }
        ],
    )
    assert failures == []


def test_gpu_delta_retry_prompt_explains_anchor_rejection():
    prompt = build_gpu_diff_patch_retry_prompt(
        "base prompt",
        [
            {
                "index": 0,
                "module": "device",
                "reason": "anchor_missing",
                "anchor": "vx[i] += force;",
                "match_count": 0,
            }
        ],
    )
    assert "DETERMINISTIC VERIFIER REJECTION" in prompt
    assert "CURRENT generated device role" in prompt
    assert "vx[i] += force;" in prompt


def test_gpu_delta_content_verifier_rejects_project_header_include():
    req = GpuDiffPatchRequest(
        diff="@@",
        compile_manifest={
            "module_files": {
                "shared": ".synthi/generated/gpu/shared.h",
                "core": ".synthi/generated/gpu/core.cpp",
                "gui": ".synthi/generated/gpu/gui.cpp",
                "host_runner": ".synthi/generated/gpu/host_runner.cpp",
                "device": ".synthi/generated/gpu/device.hip",
            }
        },
    )
    failures = gpu_diff_patch_content_failures(
        req,
        [
            {
                "module": "core",
                "operation": "insert_after",
                "anchor": "#include <hip/hip_runtime.h>",
                "content": '\n#include "Device/includes/AdaptiveSampling.h"\n',
            }
        ],
    )
    assert failures
    assert failures[0]["reason"] == "generated_role_includes_project_header"


def test_gpu_delta_content_verifier_allows_generated_role_include():
    req = GpuDiffPatchRequest(diff="@@")
    failures = gpu_diff_patch_content_failures(
        req,
        [
            {
                "module": "core",
                "operation": "insert_after",
                "anchor": "#include <stdint.h>",
                "content": '\n#include "shared.h"\n#include "synthi_gpu_runtime.h"\n',
            }
        ],
    )
    assert failures == []
