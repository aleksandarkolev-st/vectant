function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function hiprtRuntimeProbeAdaptationCommand(workerRepoRoot) {
  return `
if [ ! -d ${shQuote(workerRepoRoot)} ]; then
  printf 'SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION {"enabled":true,"applied":false,"reason":"repo_root_missing"}\\n'
else
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION {"enabled":true,"applied":false,"reason":"python3_missing"}\\n' >&2
    exit 87
  fi
  python3 - ${shQuote(workerRepoRoot)} <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
results = {
    "enabled": True,
    "repoRoot": str(root),
    "applied": False,
    "sourceAdaptations": [],
    "files": [],
    "missingFiles": [],
}

def fail(message):
    results["error"] = message
    print("SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION " + json.dumps(results, sort_keys=True))
    raise SystemExit(87)

def read(path):
    return path.read_text(encoding="utf-8", errors="strict")

def write(path, text):
    path.write_text(text, encoding="utf-8")

def insert_after(text, needle, insertion, label):
    if insertion.strip() in text:
        return text, False
    if needle not in text:
        fail(f"{label}: insertion anchor missing")
    return text.replace(needle, needle + insertion, 1), True

def insert_before(text, needle, insertion, label):
    if insertion.strip() in text:
        return text, False
    if needle not in text:
        fail(f"{label}: insertion anchor missing")
    return text.replace(needle, insertion + needle, 1), True

def replace_once(text, old, new, label):
    if new.strip() in text:
        return text, False
    if old not in text:
        fail(f"{label}: replacement anchor missing")
    return text.replace(old, new, 1), True

def patch_file(relative_path, marker, patcher, adaptation_names):
    path = root / relative_path
    if not path.exists():
        results["missingFiles"].append(relative_path)
        return
    text = read(path)
    if marker in text:
        results["files"].append({"path": relative_path, "status": "already-adapted"})
        return
    patched = patcher(text)
    if patched == text:
        results["files"].append({"path": relative_path, "status": "unchanged"})
        return
    write(path, patched)
    results["applied"] = True
    results["files"].append({"path": relative_path, "status": "adapted"})
    for name in adaptation_names:
        if name not in results["sourceAdaptations"]:
            results["sourceAdaptations"].append(name)

def patch_opengl_interop_buffer(text):
    text, _ = insert_after(
        text,
        '#include "HIPRT-Orochi/HIPRTOrochiUtils.h"\\n',
        '#include "HIPRT-Orochi/OrochiBuffer.h"\\n',
        "OpenGLInteropBuffer include OrochiBuffer",
    )
    text, _ = insert_after(
        text,
        '#include "Utils/Utils.h"\\n\\n',
        '#include <cstdlib>\\n#include <cstdio>\\n#include <vector>\\n\\n',
        "OpenGLInteropBuffer include std headers",
    )
    text, _ = insert_after(
        text,
        '\\tsize_t get_byte_size() const;\\n',
        '\\tbool uses_device_buffer_fallback() const;\\n\\tstd::vector<T> download_data() const;\\n',
        "OpenGLInteropBuffer public readback API",
    )
    text, _ = insert_after(
        text,
        'private:\\n',
        '\\tbool use_device_buffer_fallback() const;\\n\\n',
        "OpenGLInteropBuffer fallback selector declaration",
    )
    text, _ = insert_after(
        text,
        '\\tT* m_mapped_pointer = nullptr;\\n',
        '\\tbool m_uses_device_buffer_fallback = false;\\n',
        "OpenGLInteropBuffer fallback flag",
    )
    text, _ = insert_after(
        text,
        '\\toroGraphicsResource_t m_buffer_resource = nullptr;\\n',
        '\\tOrochiBuffer<T> m_fallback_device_buffer;\\n\\tstd::vector<T> m_fallback_host_buffer;\\n',
        "OpenGLInteropBuffer fallback storage",
    )
    text, _ = insert_before(
        text,
        'template <typename T>\\nOpenGLInteropBuffer<T>::OpenGLInteropBuffer(int element_count)\\n',
        '''template <typename T>
bool OpenGLInteropBuffer<T>::use_device_buffer_fallback() const
{
\\treturn std::getenv("SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP") != nullptr ||
\\t\\tstd::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr;
}

''',
        "OpenGLInteropBuffer fallback selector definition",
    )
    text, _ = insert_after(
        text,
        'OpenGLInteropBuffer<T>::OpenGLInteropBuffer(int element_count)\\n{\\n',
        '''\\tif (use_device_buffer_fallback())
\\t{
\\t\\tresize(element_count);
\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer constructor fallback",
    )
    text, _ = insert_before(
        text,
        '\\tif (m_initialized)\\n\\t{\\n\\t\\toroGraphicsUnregisterResource(m_buffer_resource);\\n',
        '''\\tif (use_device_buffer_fallback())
\\t{
\\t\\tif (!m_initialized)
\\t\\t\\tglCreateBuffers(1, &m_buffer_name);

\\t\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, m_buffer_name);
\\t\\tglBufferData(GL_PIXEL_UNPACK_BUFFER, new_element_count * sizeof(T), nullptr, GL_DYNAMIC_DRAW);
\\t\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);

\\t\\tm_fallback_device_buffer.resize(new_element_count);
\\t\\tm_fallback_host_buffer.resize(new_element_count);

\\t\\tm_initialized = true;
\\t\\tm_uses_device_buffer_fallback = true;
\\t\\tm_mapped = false;
\\t\\tm_mapped_pointer = nullptr;
\\t\\tm_element_count = new_element_count;

\\t\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] opengl_interop_buffer=fallback_device_buffer elements=%d bytes=%zu\\\\n", new_element_count, new_element_count * sizeof(T));

\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer resize fallback",
    )
    text, _ = insert_before(
        text,
        'template <typename T>\\nT* OpenGLInteropBuffer<T>::map()\\n',
        '''template <typename T>
bool OpenGLInteropBuffer<T>::uses_device_buffer_fallback() const
{
\\treturn m_uses_device_buffer_fallback;
}

template <typename T>
std::vector<T> OpenGLInteropBuffer<T>::download_data() const
{
\\tif (m_uses_device_buffer_fallback)
\\t\\treturn m_fallback_device_buffer.download_data();

\\treturn {};
}

''',
        "OpenGLInteropBuffer readback methods",
    )
    text, _ = insert_before(
        text,
        '\\tsize_t byte_size;\\n\\tOROCHI_CHECK_ERROR(oroGraphicsMapResources',
        '''\\tif (m_uses_device_buffer_fallback)
\\t{
\\t\\tm_mapped_pointer = m_fallback_device_buffer.get_device_pointer();
\\t\\tm_mapped = true;
\\t\\treturn m_mapped_pointer;
\\t}

''',
        "OpenGLInteropBuffer map fallback",
    )
    text, _ = insert_before(
        text,
        '\\tOROCHI_CHECK_ERROR(oroGraphicsUnmapResources',
        '''\\tif (m_uses_device_buffer_fallback)
\\t{
\\t\\tm_mapped = false;
\\t\\tm_mapped_pointer = nullptr;
\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer unmap fallback",
    )
    text, _ = insert_before(
        text,
        '\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, get_opengl_buffer());\\n',
        '''\\tif (m_uses_device_buffer_fallback)
\\t{
\\t\\tm_fallback_device_buffer.download_data_into(m_fallback_host_buffer.data());
\\t\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
\\t\\tglTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, width, height, format, type, m_fallback_host_buffer.data());
\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer texture upload fallback",
    )
    text, _ = replace_once(
        text,
        '\\t\\tOROCHI_CHECK_ERROR(oroGraphicsUnregisterResource(reinterpret_cast<oroGraphicsResource_t>(m_buffer_resource)));\\n',
        '''\\t\\tif (!m_uses_device_buffer_fallback)
\\t\\t\\tOROCHI_CHECK_ERROR(oroGraphicsUnregisterResource(reinterpret_cast<oroGraphicsResource_t>(m_buffer_resource)));
\\t\\telse if (m_fallback_device_buffer.is_allocated())
\\t\\t\\tm_fallback_device_buffer.free();
''',
        "OpenGLInteropBuffer unregister fallback",
    )
    text, _ = insert_after(
        text,
        '\\tm_initialized = false;\\n',
        '\\tm_uses_device_buffer_fallback = false;\\n\\tm_buffer_resource = nullptr;\\n',
        "OpenGLInteropBuffer fallback reset",
    )
    return text

def patch_gpu_renderer(text):
    text, _ = insert_after(
        text,
        '#include <Orochi/OrochiUtils.h>\\n\\n',
        '#include <cstdio>\\n#include <cstdlib>\\n',
        "GPURenderer std headers",
    )
    text, _ = insert_after(
        text,
        'GPURenderer::GPURenderer(RenderWindow* render_window, std::shared_ptr<HIPRTOrochiCtx> hiprt_oro_ctx, std::shared_ptr<ApplicationSettings> application_settings)\\n{\\n',
        '''\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t{
\\t\\tThreadManager::set_monothread(true);
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] thread_manager=monothread reason=runtime_compile_determinism\\\\n");
\\t}

''',
        "GPURenderer monothread runtime compile",
    )
    text, _ = insert_after(
        text,
        '\\tm_global_compiler_options->set_macro_value("__USE_HWI__", device_supports_hardware_acceleration() == HardwareAccelerationSupport::SUPPORTED);\\n',
        '''\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t{
\\t\\tm_global_compiler_options->set_macro_value("__USE_HWI__", 0);
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] hiprt_hardware_intersection=disabled reason=texture_object_capability_probe\\\\n");
\\t}
''',
        "GPURenderer disable HWI under texture capability fallback",
    )
    text, _ = insert_after(
        text,
        'void GPURenderer::setup_brdfs_data()\\n{\\n',
        '''\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t{
\\t\\tm_render_data.bsdfs_data.energy_compensation_roughness_threshold = 1.0e9f;
\\t\\tg_imgui_logger.add_line(ImGuiLoggerSeverity::IMGUI_LOGGER_WARNING, "SYNTHI HIPRT runtime probe disabled GPU texture-object LUT upload; energy-compensation LUT sampling is disabled for this run.");
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] texture_object_luts=disabled energy_compensation_roughness_threshold=%g\\\\n", m_render_data.bsdfs_data.energy_compensation_roughness_threshold);
\\t\\treturn;
\\t}

''',
        "GPURenderer skip texture-object LUTs",
    )
    return text

def patch_gpu_renderer_thread(text):
    text, _ = insert_after(
        text,
        '#include "Renderer/GPURendererThread.h"\\n\\n',
        '#include "Image/Image.h"\\n',
        "GPURendererThread image include",
    )
    text, _ = insert_after(
        text,
        '#include "UI/RenderWindow.h"\\n\\n',
        '#include <cstdlib>\\n#include <cstdio>\\n#include <algorithm>\\n#include <cmath>\\n#include <memory>\\n#include <vector>\\n\\n',
        "GPURendererThread std includes",
    )
    text, _ = insert_before(
        text,
        'void GPURendererThread::init(GPURenderer* renderer)\\n',
        '''namespace
{
void synthi_capture_runtime_framebuffer_if_requested(const std::shared_ptr<OpenGLInteropBuffer<ColorRGB32F>>& framebuffer, int width, int height, oroStream_t stream)
{
\\tconst char* capture_path = std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH");
\\tif (capture_path == nullptr || capture_path[0] == '\\\\0')
\\t\\treturn;

\\tstatic bool captured = false;
\\tif (captured)
\\t\\treturn;

\\tif (framebuffer == nullptr)
\\t\\treturn;

\\tOROCHI_CHECK_ERROR(oroStreamSynchronize(stream));

\\tstd::vector<ColorRGB32F> framebuffer_pixels = framebuffer->download_data();
\\tconst size_t expected_pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
\\tif (framebuffer_pixels.size() < expected_pixels || expected_pixels == 0)
\\t{
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] capture_failed path=%s width=%d height=%d pixels=%zu expected_pixels=%zu reason=framebuffer_readback_unavailable\\\\n", capture_path, width, height, framebuffer_pixels.size(), expected_pixels);
\\t\\treturn;
\\t}

\\tstd::vector<float> pixels(expected_pixels * 3);
\\tdouble luma_sum = 0.0;
\\tdouble luma_sq_sum = 0.0;
\\tsize_t non_black_pixels = 0;
\\tfloat min_luma = 1.0e30f;
\\tfloat max_luma = -1.0e30f;
\\tfor (size_t i = 0; i < expected_pixels; i++)
\\t{
\\t\\tconst ColorRGB32F pixel = framebuffer_pixels[i];
\\t\\tconst float r = std::max(0.0f, pixel.r);
\\t\\tconst float g = std::max(0.0f, pixel.g);
\\t\\tconst float b = std::max(0.0f, pixel.b);
\\t\\tpixels[i * 3 + 0] = r;
\\t\\tpixels[i * 3 + 1] = g;
\\t\\tpixels[i * 3 + 2] = b;

\\t\\tconst float luma = 0.3086f * r + 0.6094f * g + 0.0820f * b;
\\t\\tluma_sum += luma;
\\t\\tluma_sq_sum += static_cast<double>(luma) * static_cast<double>(luma);
\\t\\tmin_luma = std::min(min_luma, luma);
\\t\\tmax_luma = std::max(max_luma, luma);
\\t\\tif (r > 0.0001f || g > 0.0001f || b > 0.0001f)
\\t\\t\\tnon_black_pixels++;
\\t}

\\tImage32Bit image(pixels, width, height, 3);
\\tconst bool wrote = image.write_image_png(capture_path, true);
\\tconst double mean_luma = luma_sum / static_cast<double>(expected_pixels);
\\tconst double variance = std::max(0.0, luma_sq_sum / static_cast<double>(expected_pixels) - mean_luma * mean_luma);
\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] capture_path=%s wrote=%d width=%d height=%d pixels=%zu non_black_pixels=%zu mean_luma=%.9f luma_stddev=%.9f min_luma=%.9f max_luma=%.9f framebuffer_fallback=%d\\\\n",
\\t\\tcapture_path,
\\t\\twrote ? 1 : 0,
\\t\\twidth,
\\t\\theight,
\\t\\texpected_pixels,
\\t\\tnon_black_pixels,
\\t\\tmean_luma,
\\t\\tstd::sqrt(variance),
\\t\\tmin_luma,
\\t\\tmax_luma,
\\t\\tframebuffer->uses_device_buffer_fallback() ? 1 : 0);

\\tcaptured = wrote;
\\tif (wrote && std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_CAPTURE") != nullptr)
\\t{
\\t\\tstd::fflush(stderr);
\\t\\tstd::exit(0);
\\t}
}
}

''',
        "GPURendererThread framebuffer capture helper",
    )
    text, _ = replace_once(
        text,
        '''\\t\\tpost_sample_update(m_render_data_for_frame, m_compiler_options_for_frame);
\\t}

\\t// Recording GPU frame time stop timestamp and computing the frame time
''',
        '''\\t\\tpost_sample_update(m_render_data_for_frame, m_compiler_options_for_frame);
\\t}

\\tsynthi_capture_runtime_framebuffer_if_requested(
\\t\\tm_renderer->m_framebuffer,
\\t\\tm_renderer->m_render_resolution.x,
\\t\\tm_renderer->m_render_resolution.y,
\\t\\tm_renderer->get_main_stream());

\\t// Recording GPU frame time stop timestamp and computing the frame time
''',
        "GPURendererThread capture call",
    )
    return text

def patch_hiprt_orochi_ctx(text):
    text, _ = insert_after(
        text,
        '#include <memory>\\n',
        '#include <cstdlib>\\n',
        "HIPRTOrochiCtx stdlib include",
    )
    text, _ = replace_once(
        text,
        '''#ifdef OROCHI_ENABLE_CUEW
\\t\\tint error_initialize = oroInitialize((oroApi)(ORO_API_CUDA), 0);
#else
\\t\\tint error_initialize = oroInitialize((oroApi)(ORO_API_HIP), 0);
#endif
''',
        '''#ifdef OROCHI_ENABLE_CUEW
\\t\\tconst char* synthi_force_hip_orochi = std::getenv("SYNTHI_HIPRT_FORCE_HIP_OROCHI");
\\t\\tconst oroApi synthi_requested_orochi_api =
\\t\\t\\t(synthi_force_hip_orochi != nullptr && synthi_force_hip_orochi[0] != '\\\\0')
\\t\\t\\t\\t? (oroApi)(ORO_API_HIP)
\\t\\t\\t\\t: (oroApi)(ORO_API_CUDA);
\\t\\tint error_initialize = oroInitialize(synthi_requested_orochi_api, 0);
#else
\\t\\tint error_initialize = oroInitialize((oroApi)(ORO_API_HIP), 0);
#endif
''',
        "HIPRTOrochiCtx runtime backend selector",
    )
    return text

def patch_hiprt_common(text):
    text = text.replace('#include <cstdint>', '#include <stdint.h>', 1)
    old = '''using uint16_t = unsigned short;
#if defined( __CUDACC_RTC__ )
using int32_t  = int;
using uint32_t = unsigned int;
using int64_t  = long long;
using uint64_t = unsigned long long;
#endif
#endif
'''
    new = '''using uint16_t = unsigned short;
using int32_t  = int;
using uint32_t = unsigned int;
using int64_t  = long long;
using uint64_t = unsigned long long;
#endif
'''
    if old in text:
        text = text.replace(old, new, 1)
    return text

fingerprint_files = [
    root / "src/Renderer/GPURenderer.cpp",
    root / "src/Renderer/GPURendererThread.cpp",
    root / "src/OpenGL/OpenGLInteropBuffer.h",
    root / "src/HIPRT-Orochi/HIPRTOrochiCtx.h",
    root / "thirdparties/HIPRT-Fork/hiprt/hiprt_common.h",
]
if not all(path.exists() for path in fingerprint_files):
    results["missingFiles"] = [str(path.relative_to(root)) for path in fingerprint_files if not path.exists()]
    print("SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION " + json.dumps(results, sort_keys=True))
    raise SystemExit(0)

patch_file(
    "src/OpenGL/OpenGLInteropBuffer.h",
    "SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP",
    patch_opengl_interop_buffer,
    ["opengl_interop_device_buffer_fallback", "runtime_capture_from_device_framebuffer"],
)
patch_file(
    "src/Renderer/GPURenderer.cpp",
    "texture_object_luts=disabled",
    patch_gpu_renderer,
    [
        "hiprt_texture_objects_disabled_due_capability_probe",
        "hiprt_hwi_disabled_due_texture_capability",
        "thread_manager_monothread_for_runtime_compile_determinism",
    ],
)
patch_file(
    "src/Renderer/GPURendererThread.cpp",
    "SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH",
    patch_gpu_renderer_thread,
    ["runtime_capture_from_device_framebuffer"],
)
patch_file(
    "src/HIPRT-Orochi/HIPRTOrochiCtx.h",
    "SYNTHI_HIPRT_FORCE_HIP_OROCHI",
    patch_hiprt_orochi_ctx,
    ["hiprt_orochi_runtime_backend_selection"],
)
for rel in ["thirdparties/HIPRT-Fork/hiprt/hiprt_common.h", "hiprt/hiprt_common.h"]:
    path = root / rel
    if path.exists():
        text = read(path)
        patched = patch_hiprt_common(text)
        if patched != text:
            write(path, patched)
            results["applied"] = True
            results["files"].append({"path": rel, "status": "adapted"})
            if "hiprt_rtc_integer_alias_compatibility" not in results["sourceAdaptations"]:
                results["sourceAdaptations"].append("hiprt_rtc_integer_alias_compatibility")
        else:
            results["files"].append({"path": rel, "status": "already-adapted"})

print("SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION " + json.dumps(results, sort_keys=True))
PY
fi
`;
}

export function parseHiprtRuntimeProbeAdaptationOutput(text) {
  const records = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION\s+(\{.*\})\s*$/.exec(line.trim());
    if (!match) continue;
    try {
      records.push(JSON.parse(match[1]));
    } catch {
      records.push({ parseError: true, raw: line.trim() });
    }
  }
  return records;
}
