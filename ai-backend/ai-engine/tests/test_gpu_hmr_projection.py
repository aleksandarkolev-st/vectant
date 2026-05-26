import json

from agents.gpu_source_context import build_source_context_report
from gpu_hmr.broker import get_gpu_hmr_broker, reset_gpu_hmr_broker_for_tests
from gpu_hmr.metadata import resolve_target_metadata
from gpu_hmr.projection import build_target_scoped_projection


def _files():
    return {
        "src/app/main.cpp": "int main(){return 0;}\n",
        "src/gpu/kernel.hip": "__global__ void k() {}\n",
        "include/app.h": "#pragma once\n",
        "CMakeLists.txt": "add_executable(app src/app/main.cpp src/gpu/kernel.hip)\n",
        "compile_commands.json": json.dumps(
            [
                {
                    "directory": "build",
                    "file": "src/app/main.cpp",
                    "arguments": ["hipcc", "-std=c++20", "-Iinclude", "src/app/main.cpp"],
                }
            ]
        ),
        ".cmake/api/v1/reply/codemodel-v2-abc.json": json.dumps(
            {"kind": "codemodel", "configurations": [{"name": "Debug", "targets": [{"name": "app", "id": "app::@", "jsonFile": "target-app-Debug.json"}]}]}
        ),
        ".cmake/api/v1/reply/target-app-Debug.json": json.dumps(
            {"name": "app", "id": "app::@", "type": "EXECUTABLE", "sources": [{"path": "src/app/main.cpp"}, {"path": "src/gpu/kernel.hip"}]}
        ),
    }


def test_projection_builder_creates_broker_request_without_source_text():
    reset_gpu_hmr_broker_for_tests()
    files = _files()
    report = build_source_context_report(files, focus="src/app/main.cpp")
    metadata = resolve_target_metadata(files, focus="src/app/main.cpp", source_context_report=report)
    projection = build_target_scoped_projection(
        source_split_identity_hash="source-split-1",
        codeintel_generation="ci-42",
        target_metadata=metadata,
        source_context_report=report,
        retrieval_evidence_refs=[{"kind": "rag_trace", "hash": "trace-1"}],
    )

    assert projection["status"] == "ready"
    assert projection["projectionHash"]
    request = projection["brokerRequest"]
    assert request["selectedTargetIdentityHash"] == metadata["selectedTargetIdentityHash"]
    assert request["buildMetadataHash"] == metadata["buildMetadataHash"]
    assert request["sourceSets"]["targetInputFiles"] == ["src/app/main.cpp", "src/gpu/kernel.hip"]
    assert "int main" not in json.dumps(request)

    status_code, response = get_gpu_hmr_broker().create_projection(request)
    assert status_code == 200
    assert response["projectionHash"] == projection["projectionHash"]
    assert response["status"] == "ready"


def test_projection_builder_blocks_when_target_metadata_is_ambiguous():
    files = _files()
    files[".cmake/api/v1/reply/codemodel-v2-abc.json"] = json.dumps(
        {
            "kind": "codemodel",
            "configurations": [
                {
                    "name": "Debug",
                    "targets": [
                        {"name": "app", "id": "app::@", "jsonFile": "target-app-Debug.json"},
                        {"name": "other", "id": "other::@", "jsonFile": "target-other-Debug.json"},
                    ],
                }
            ],
        }
    )
    files[".cmake/api/v1/reply/target-other-Debug.json"] = json.dumps(
        {"name": "other", "id": "other::@", "type": "EXECUTABLE", "sources": [{"path": "src/app/main.cpp"}]}
    )
    report = build_source_context_report(files, focus="src/app/main.cpp")
    metadata = resolve_target_metadata(files, focus="src/app/main.cpp", source_context_report=report)
    projection = build_target_scoped_projection(
        source_split_identity_hash="source-split-1",
        codeintel_generation="ci-42",
        target_metadata=metadata,
        source_context_report=report,
    )

    assert projection["status"] == "blocked"
    assert projection["brokerRequest"] is None
    assert projection["projectionHash"] is None
    assert "target_resolution_ambiguous" in projection["blockingReasonCodes"]


def test_projection_hash_changes_with_codeintel_generation():
    files = _files()
    report = build_source_context_report(files, focus="src/app/main.cpp")
    metadata = resolve_target_metadata(files, focus="src/app/main.cpp", source_context_report=report)

    first = build_target_scoped_projection(
        source_split_identity_hash="source-split-1",
        codeintel_generation="ci-42",
        target_metadata=metadata,
        source_context_report=report,
    )
    second = build_target_scoped_projection(
        source_split_identity_hash="source-split-1",
        codeintel_generation="ci-43",
        target_metadata=metadata,
        source_context_report=report,
    )

    assert first["projectionHash"] != second["projectionHash"]
