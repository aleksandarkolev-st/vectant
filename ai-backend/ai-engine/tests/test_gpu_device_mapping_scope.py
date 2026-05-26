from main import _device_mapping_source_scope


def test_device_mapping_scope_expands_local_device_includes():
    files = {
        "src/app/main.cpp": "int main() { return 0; }\n",
        "src/gpu/particle_api.hpp": '#include "../config/particle_config.hpp"\n',
        "src/config/particle_config.hpp": "constexpr int kParticleCount = 512;\n",
        "src/gpu/particle_template_math.hpp": (
            "template <typename T, int BLOCK_SIZE>\n"
            "__device__ T tuned_gain(T value) { return value; }\n"
        ),
        "src/gpu/particle_kernels.hip": (
            '#include "particle_api.hpp"\n'
            '#include "particle_template_math.hpp"\n'
            'extern "C" __global__ void advance(float* x) { x[0] += tuned_gain<float, 128>(1.0f); }\n'
        ),
        "docs/unrelated.md": "# not source context\n",
    }
    source_context_report = {
        "included": [{"path": "src/app/main.cpp"}],
        "deviceTuTopology": {
            "deviceTranslationUnits": [
                {"path": "src/gpu/particle_kernels.hip"},
            ],
        },
    }

    scoped = _device_mapping_source_scope(files, source_context_report)

    assert "src/gpu/particle_kernels.hip" in scoped
    assert "src/gpu/particle_api.hpp" in scoped
    assert "src/gpu/particle_template_math.hpp" in scoped
    assert "src/config/particle_config.hpp" in scoped
    assert "docs/unrelated.md" not in scoped
