// Probe 1: HIP directly writes an RGBA pixel buffer on the GPU.
//
// This proves GPU-computed pixels, not display interop. The program copies the
// device buffer back to CPU memory only to validate it and save a portable PPM.

#include <hip/hip_runtime.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CHECK_HIP(call)                                                          \
    do {                                                                         \
        hipError_t err__ = (call);                                               \
        if (err__ != hipSuccess) {                                               \
            std::fprintf(stderr, "HIP error %s:%d: %s\n", __FILE__, __LINE__,    \
                         hipGetErrorString(err__));                              \
            return 1;                                                            \
        }                                                                        \
    } while (0)

static constexpr int W = 512;
static constexpr int H = 320;

__global__ void draw_pixels(std::uint32_t* pixels, int w, int h, unsigned frame) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= w || y >= h) return;

    float cx = 0.5f * (float)w;
    float cy = 0.5f * (float)h;
    float dx = ((float)x - cx) / cx;
    float dy = ((float)y - cy) / cy;
    float r2 = dx * dx + dy * dy;

    std::uint8_t r = (std::uint8_t)((x * 255) / (w - 1));
    std::uint8_t g = (std::uint8_t)((y * 255) / (h - 1));
    std::uint8_t b = (std::uint8_t)(r2 < 0.28f ? 255 : ((frame * 31 + x + y) & 127));
    std::uint8_t a = 255;
    pixels[y * w + x] = ((std::uint32_t)a << 24) | ((std::uint32_t)b << 16)
        | ((std::uint32_t)g << 8) | (std::uint32_t)r;
}

int main() {
    int device = 0;
    CHECK_HIP(hipGetDevice(&device));
    hipDeviceProp_t props{};
    CHECK_HIP(hipGetDeviceProperties(&props, device));
    std::printf("device=%d name=%s arch=%s\n", device, props.name, props.gcnArchName);

    std::uint32_t* device_pixels = nullptr;
    CHECK_HIP(hipMalloc(&device_pixels, sizeof(std::uint32_t) * W * H));

    dim3 block(16, 16);
    dim3 grid((W + block.x - 1) / block.x, (H + block.y - 1) / block.y);
    hipLaunchKernelGGL(draw_pixels, grid, block, 0, 0, device_pixels, W, H, 7u);
    CHECK_HIP(hipGetLastError());
    CHECK_HIP(hipDeviceSynchronize());

    std::vector<std::uint32_t> host(W * H);
    CHECK_HIP(hipMemcpy(host.data(), device_pixels, sizeof(std::uint32_t) * host.size(),
                        hipMemcpyDeviceToHost));
    CHECK_HIP(hipFree(device_pixels));

    std::uint64_t checksum = 1469598103934665603ULL;
    std::uint32_t nonzero = 0;
    for (std::uint32_t px : host) {
        checksum ^= px;
        checksum *= 1099511628211ULL;
        if (px != 0) ++nonzero;
    }

    const char* out_path = "/tmp/hip_direct_pixels.ppm";
    FILE* f = std::fopen(out_path, "wb");
    if (!f) {
        std::perror("fopen");
        return 1;
    }
    std::fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (std::uint32_t px : host) {
        std::uint8_t rgb[3] = {
            (std::uint8_t)(px & 0xff),
            (std::uint8_t)((px >> 8) & 0xff),
            (std::uint8_t)((px >> 16) & 0xff),
        };
        std::fwrite(rgb, 1, sizeof(rgb), f);
    }
    std::fclose(f);

    std::printf("ok direct_hip_pixels width=%d height=%d nonzero=%u checksum=%llu out=%s\n",
                W, H, nonzero, (unsigned long long)checksum, out_path);
    return nonzero == (std::uint32_t)(W * H) ? 0 : 2;
}
