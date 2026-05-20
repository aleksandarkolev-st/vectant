from agents.gpu_source_context import build_project_source_context, stable_hash


def test_source_context_records_included_and_dropped_reasons():
    files = {
        "src/app/main.cpp": "int main(){ launch<<<1,1>>>(); }",
        "src/gpu/flow.hip": "__global__ void launch() {}",
        "src/render/glfw_view.cpp": "#include <GLFW/glfw3.h>\nvoid draw(){}",
        "docs/readme.md": "notes",
        ".synthi/generated/gpu/device.hip": "__global__ void generated() {}",
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")

    included_reasons = {item["path"]: item["includeReason"] for item in report["included"]}
    dropped_reasons = {item["path"]: item["dropReason"] for item in report["dropped"]}

    assert included_reasons["src/app/main.cpp"] == "entry_translation_unit"
    assert included_reasons["src/gpu/flow.hip"] == "device_translation_unit"
    assert included_reasons["src/render/glfw_view.cpp"] == "render_backend"
    assert dropped_reasons["docs/readme.md"] == "docs_tests_examples"
    assert dropped_reasons[".synthi/generated/gpu/device.hip"] == "generated_or_build_output"
    assert "INCLUDE_REASON: device_translation_unit" in prompt
    assert report["deterministicContextComplete"] is True


def test_source_context_selects_compile_command_for_focus():
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "compile_commands.json": """
        [
          {
            "directory": "/repo/build",
            "file": "/repo/src/app/main.cpp",
            "arguments": ["clang++", "-Iinclude", "-DUSE_GPU=1", "-c", "src/app/main.cpp"]
          }
        ]
        """,
    }

    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    selected = report["buildMetadata"]["selectedCompileCommand"]

    assert report["buildMetadata"]["compileCommandsStatus"] == "selected"
    assert report["buildMetadata"]["compileDbHash"]
    assert selected["status"] == "selected"
    assert selected["compiler"] == "clang++"
    assert selected["file"].endswith("src/app/main.cpp")
    assert selected["effectiveFlagsHash"]


def test_source_context_marks_critical_budget_drop():
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/flow.hip": "__global__ void flow() { int x = 1; }",
    }

    _prompt, report = build_project_source_context(
        files,
        focus="src/app/main.cpp",
        max_chars=80,
        per_file_max_chars=1000,
    )

    assert report["deterministicContextComplete"] is False
    assert report["criticalDropped"]
    assert report["criticalDropped"][0]["dropReason"] == "prompt_budget_exclusion"


def test_source_context_reports_multi_device_tu_topology():
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/a.hip": "__global__ void a() {}",
        "src/gpu/b.hip": "__device__ int b(){ return 1; }",
    }

    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    topology = report["deviceTuTopology"]

    assert topology["multiDeviceTu"] is True
    assert topology["deviceTranslationUnitCount"] == 2
    assert topology["supportStatus"] == "multi_device_tu_requires_topology_verification"
    assert "multi_device_tu_requires_topology_verification" in topology["reasonCodes"]


def test_source_context_resolves_cmake_file_api_target_for_focus():
    files = {
        "CMakeLists.txt": "add_executable(gpu_app src/app/main.cpp src/gpu/flow.hip)",
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/flow.hip": "__global__ void flow() {}",
        ".cmake/api/v1/reply/codemodel-v2-debug.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Debug",
              "targets": [
                {"name": "gpu_app", "id": "gpu_app::@123", "jsonFile": "target-gpu_app-Debug.json"},
                {"name": "helper_lib", "id": "helper::@123", "jsonFile": "target-helper-Debug.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-gpu_app-Debug.json": """
        {
          "name": "gpu_app",
          "id": "gpu_app::@123",
          "type": "EXECUTABLE",
          "sources": [
            {"path": "src/app/main.cpp"},
            {"path": "src/gpu/flow.hip"}
          ]
        }
        """,
        ".cmake/api/v1/reply/target-helper-Debug.json": """
        {
          "name": "helper_lib",
          "id": "helper::@123",
          "type": "STATIC_LIBRARY",
          "sources": [
            {"path": "src/lib/helper.cpp"}
          ]
        }
        """,
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    metadata = report["buildMetadata"]
    cmake = metadata["cmakeFileApi"]
    resolution = metadata["targetResolution"]

    assert metadata["cmakeFileApiStatus"] == "available"
    assert metadata["cmakeCodemodelHash"]
    assert cmake["targetCount"] == 2
    assert resolution["status"] == "selected"
    assert resolution["method"] == "single_executable_target_containing_focus"
    assert resolution["selectedTarget"]["name"] == "gpu_app"
    assert resolution["selectedTarget"]["sourceFiles"] == [
        "src/app/main.cpp",
        "src/gpu/flow.hip",
    ]
    assert "Resolved CMake target: gpu_app" in prompt


def test_source_context_reports_ambiguous_cmake_file_api_target():
    files = {
        "CMakeLists.txt": "add_executable(a src/app/main.cpp)\nadd_executable(b src/app/main.cpp)",
        "src/app/main.cpp": "int main(){ return 0; }",
        ".cmake/api/v1/reply/codemodel-v2-debug.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Debug",
              "targets": [
                {"name": "gpu_app_a", "id": "a::@123", "jsonFile": "target-a-Debug.json"},
                {"name": "gpu_app_b", "id": "b::@123", "jsonFile": "target-b-Debug.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-a-Debug.json": """
        {"name": "gpu_app_a", "id": "a::@123", "type": "EXECUTABLE", "sources": [{"path": "src/app/main.cpp"}]}
        """,
        ".cmake/api/v1/reply/target-b-Debug.json": """
        {"name": "gpu_app_b", "id": "b::@123", "type": "EXECUTABLE", "sources": [{"path": "src/app/main.cpp"}]}
        """,
    }

    prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    resolution = report["buildMetadata"]["targetResolution"]

    assert resolution["status"] == "ambiguous"
    assert resolution["method"] == "ambiguous_executable_targets_containing_focus"
    assert "target_resolution_ambiguous" in resolution["reasonCodes"]
    assert "CMake target resolution is ambiguous" in prompt


def test_source_context_ingests_compiler_template_evidence():
    command = [
        "hipcc",
        "-Iinclude",
        "--offload-arch=gfx1201",
        "-c",
        "src/gpu/reduce.hip",
    ]
    flags_hash = stable_hash(command[1:])
    files = {
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/reduce.hip": """
        template <typename T, int BLOCK_SIZE>
        __device__ T BlockReduce(T value) { return value; }
        __global__ void reduce_kernel(float* values) {
            values[0] = BlockReduce<float, 128>(values[0]);
            values[1] = BlockReduce<float, 256>(values[1]);
        }
        """,
        "compile_commands.json": f"""
        [
          {{
            "directory": "/repo/build",
            "file": "/repo/src/gpu/reduce.hip",
            "arguments": {command!r}
          }}
        ]
        """.replace("'", '"'),
        ".synthi/template-evidence.json": f"""
        {{
          "schemaVersion": "synthi.gpu.template_evidence.v1",
          "status": "fresh",
          "producer": "clang-libtooling+vendor-artifacts",
          "compileCommandHash": "{stable_hash(command)}",
          "effectiveFlagsHash": "{flags_hash}",
          "gpuArch": "gfx1201",
          "bounded": true,
          "entries": [
            {{
              "templateName": "BlockReduce<T, BLOCK_SIZE>",
              "templateArgs": ["float", "128"],
              "owningTU": "src/gpu/reduce.hip",
              "instantiationSite": "src/gpu/reduce.hip:5",
              "reachableFromKernel": "reduce_kernel(float*)",
              "sourceHeaders": ["src/gpu/reduce.hip"],
              "generatedRole": "device.reduce",
              "abiFingerprint": "abi-128",
              "layoutFingerprint": "layout-128",
              "artifactFingerprint": "artifact-128"
            }},
            {{
              "templateName": "BlockReduce<T, BLOCK_SIZE>",
              "templateArgs": ["float", "256"],
              "owningTU": "src/gpu/reduce.hip",
              "instantiationSite": "src/gpu/reduce.hip:6",
              "reachableFromKernel": "reduce_kernel(float*)",
              "sourceHeaders": ["src/gpu/reduce.hip"],
              "generatedRole": "device.reduce",
              "abiFingerprint": "abi-256",
              "layoutFingerprint": "layout-256",
              "artifactFingerprint": "artifact-256"
            }}
          ]
        }}
        """,
    }

    prompt, report = build_project_source_context(files, focus="src/gpu/reduce.hip")
    metadata = report["buildMetadata"]
    evidence = metadata["templateEvidence"]

    assert metadata["templateEvidenceStatus"] == "fresh"
    assert metadata["templateEvidenceCandidateCount"] == 1
    assert metadata["templateEvidenceInvalidationReasons"] == []
    assert evidence["producer"] == "clang-libtooling+vendor-artifacts"
    assert evidence["effectiveFlagsHash"] == flags_hash
    assert evidence["bounded"] is True
    assert [entry["templateArgs"][1] for entry in evidence["entries"]] == ["128", "256"]
    assert "Template evidence: status=fresh" in prompt


def test_template_evidence_can_match_device_tu_compile_command_for_selected_target():
    main_command = [
        "clang++",
        "-Iinclude",
        "-DSCALE_ENTRY=1",
        "-c",
        "src/app/main.cpp",
    ]
    device_command = [
        "hipcc",
        "-Isrc",
        "--offload-arch=gfx1201",
        "-c",
        "src/gpu/reduce.hip",
    ]
    device_flags_hash = stable_hash(device_command[1:])
    files = {
        "CMakeLists.txt": "add_executable(gpu_app src/app/main.cpp src/gpu/reduce.hip)",
        "src/app/main.cpp": "int main(){ return 0; }",
        "src/gpu/reduce.hip": """
        template <typename T, int BLOCK_SIZE>
        __device__ T BlockReduce(T value) { return value; }
        __global__ void reduce_kernel(float* values) {
            values[0] = BlockReduce<float, 128>(values[0]);
            values[1] = BlockReduce<float, 256>(values[1]);
        }
        """,
        "compile_commands.json": f"""
        [
          {{
            "directory": "/repo/build",
            "file": "/repo/src/app/main.cpp",
            "arguments": {main_command!r}
          }},
          {{
            "directory": "/repo/build",
            "file": "/repo/src/gpu/reduce.hip",
            "arguments": {device_command!r}
          }}
        ]
        """.replace("'", '"'),
        ".cmake/api/v1/reply/codemodel-v2-debug.json": """
        {
          "kind": "codemodel",
          "configurations": [
            {
              "name": "Debug",
              "targets": [
                {"name": "gpu_app", "id": "gpu_app::@123", "jsonFile": "target-gpu_app-Debug.json"}
              ]
            }
          ]
        }
        """,
        ".cmake/api/v1/reply/target-gpu_app-Debug.json": """
        {
          "name": "gpu_app",
          "id": "gpu_app::@123",
          "type": "EXECUTABLE",
          "sources": [
            {"path": "src/app/main.cpp"},
            {"path": "src/gpu/reduce.hip"}
          ]
        }
        """,
        ".cmake/api/v1/reply/synthi-template-evidence.json": f"""
        {{
          "templateEvidence": {{
            "schemaVersion": "synthi.gpu.template_evidence.v1",
            "status": "fresh",
            "producer": "clang-libtooling+vendor-artifacts",
            "compileCommandHash": "{stable_hash(device_command)}",
            "effectiveFlagsHash": "{device_flags_hash}",
            "gpuArch": "gfx1201",
            "bounded": true,
            "entries": [
              {{
                "templateName": "BlockReduce<T, BLOCK_SIZE>",
                "templateArgs": ["float", "128"],
                "owningTU": "src/gpu/reduce.hip",
                "instantiationSite": "src/gpu/reduce.hip:5",
                "reachableFromKernel": "reduce_kernel(float*)",
                "sourceHeaders": ["src/gpu/reduce.hip"],
                "generatedRole": "device.reduce",
                "abiFingerprint": "abi-128",
                "layoutFingerprint": "layout-128",
                "artifactFingerprint": "artifact-128"
              }},
              {{
                "templateName": "BlockReduce<T, BLOCK_SIZE>",
                "templateArgs": ["float", "256"],
                "owningTU": "src/gpu/reduce.hip",
                "instantiationSite": "src/gpu/reduce.hip:6",
                "reachableFromKernel": "reduce_kernel(float*)",
                "sourceHeaders": ["src/gpu/reduce.hip"],
                "generatedRole": "device.reduce",
                "abiFingerprint": "abi-256",
                "layoutFingerprint": "layout-256",
                "artifactFingerprint": "artifact-256"
              }}
            ]
          }}
        }}
        """,
    }

    _prompt, report = build_project_source_context(files, focus="src/app/main.cpp")
    metadata = report["buildMetadata"]
    evidence = metadata["templateEvidence"]

    assert metadata["selectedCompileCommand"]["file"].endswith("src/app/main.cpp")
    assert metadata["templateEvidenceStatus"] == "fresh"
    assert metadata["templateEvidenceInvalidationReasons"] == []
    assert evidence["effectiveFlagsHash"] == device_flags_hash
    assert [entry["templateArgs"][1] for entry in evidence["entries"]] == ["128", "256"]
    assert any(
        item["file"].endswith("src/gpu/reduce.hip")
        and item["effectiveFlagsHash"] == device_flags_hash
        for item in metadata["templateEvidenceCompileCommands"]
    )
