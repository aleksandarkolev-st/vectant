from agents.gpu_source_context import build_project_source_context


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
