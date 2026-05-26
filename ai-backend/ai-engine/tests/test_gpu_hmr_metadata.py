import json

from gpu_hmr.metadata import resolve_target_metadata


def _cmake_files(extra_target=None):
    targets = [{"name": "app", "id": "app::@", "jsonFile": "target-app-Debug.json"}]
    if extra_target:
        targets.append(extra_target)
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
                    "arguments": [
                        "hipcc",
                        "-std=c++20",
                        "-Iinclude",
                        "-I",
                        "build/generated",
                        "-DAPP=1",
                        "-UOLD",
                        "-Llib",
                        "-lfoo",
                        "src/app/main.cpp",
                    ],
                }
            ]
        ),
        ".cmake/api/v1/reply/codemodel-v2-abc.json": json.dumps(
            {
                "kind": "codemodel",
                "configurations": [{"name": "Debug", "targets": targets}],
            }
        ),
        ".cmake/api/v1/reply/target-app-Debug.json": json.dumps(
            {
                "name": "app",
                "id": "app::@",
                "type": "EXECUTABLE",
                "sources": [{"path": "src/app/main.cpp"}, {"path": "src/gpu/kernel.hip"}],
            }
        ),
    }


def test_resolve_target_metadata_from_cmake_file_api_and_compile_commands():
    resolved = resolve_target_metadata(
        _cmake_files(),
        focus="src/app/main.cpp",
        environment={"SYNTHI_GPU_VENDOR": "rocm", "SYNTHI_GPU_ARCH": "gfx1201"},
    )

    assert resolved["status"] == "selected"
    assert resolved["blockingReasonCodes"] == []
    assert resolved["advisoryReasonCodes"] == ["target.cmake_file_api_selected"]
    assert resolved["selectedTargetIdentityHash"]
    assert resolved["buildMetadataHash"]
    assert resolved["targetCompileMetadataHash"]

    target = resolved["selectedTargetIdentity"]
    assert target["buildSystem"] == "cmake"
    assert target["buildRoot"] == "build"
    assert target["targetName"] == "app"
    assert target["targetType"] == "EXECUTABLE"
    assert target["compilerId"] == "hipcc"
    assert target["languageStandards"] == ["c++20"]
    assert target["defines"] == ["APP=1"]
    assert target["undefines"] == ["OLD"]
    assert target["includeRoots"] == ["build/generated", "include"]
    assert target["generatedHeaderRoots"] == ["build/generated"]
    assert target["linkLibraries"] == ["foo"]
    assert target["linkDirectories"] == ["lib"]
    assert target["sourceFiles"] == ["src/app/main.cpp", "src/gpu/kernel.hip"]
    assert target["gpuVendor"] == "rocm"
    assert target["gpuArch"] == "gfx1201"
    assert target["deviceLinkMode"] == "single_tu"

    evidence_kinds = {ref["kind"] for ref in resolved["evidenceRefs"]}
    assert {"source_context_report", "compile_commands", "cmake_file_api", "target_compile_metadata", "toolchain_identity"} <= evidence_kinds


def test_resolve_target_metadata_blocks_ambiguous_cmake_targets():
    files = _cmake_files({"name": "other", "id": "other::@", "jsonFile": "target-other-Debug.json"})
    files[".cmake/api/v1/reply/target-other-Debug.json"] = json.dumps(
        {
            "name": "other",
            "id": "other::@",
            "type": "EXECUTABLE",
            "sources": [{"path": "src/app/main.cpp"}],
        }
    )

    resolved = resolve_target_metadata(files, focus="src/app/main.cpp")

    assert resolved["status"] == "blocked"
    assert resolved["selectedTargetIdentityHash"] is None
    assert "target_resolution_ambiguous" in resolved["blockingReasonCodes"]


def test_resolve_target_metadata_uses_compile_commands_only_as_advisory_fallback():
    files = {
        "src/app/main.cpp": "int main(){return 0;}\n",
        "compile_commands.json": json.dumps(
            [
                {
                    "directory": "build",
                    "file": "src/app/main.cpp",
                    "command": "clang++ -std=c++17 -I include -DAPP src/app/main.cpp",
                }
            ]
        ),
    }

    resolved = resolve_target_metadata(files, focus="src/app/main.cpp")

    assert resolved["status"] == "selected"
    assert resolved["blockingReasonCodes"] == []
    assert resolved["advisoryReasonCodes"] == ["target.compile_commands_only"]
    assert resolved["selectedTargetIdentity"]["buildSystem"] == "compile_commands"
    assert resolved["selectedTargetIdentity"]["targetName"] == "src/app/main.cpp"
    assert resolved["selectedTargetIdentity"]["includeRoots"] == ["include"]
