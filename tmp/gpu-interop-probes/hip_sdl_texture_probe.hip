// Probe 2: HIP generates pixels, CPU copies them back, SDL uploads and renders.
//
// This proves the current validation class used by the live demo: GPU compute
// feeds a visual renderer through CPU-visible state. It deliberately does not
// claim zero-copy graphics interop.

#include <hip/hip_runtime.h>
#include <SDL2/SDL.h>

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

#define CHECK_SDL(expr)                                                          \
    do {                                                                         \
        if (!(expr)) {                                                           \
            std::fprintf(stderr, "SDL error %s:%d: %s\n", __FILE__, __LINE__,    \
                         SDL_GetError());                                        \
            return 1;                                                            \
        }                                                                        \
    } while (0)

static constexpr int W = 512;
static constexpr int H = 320;

__global__ void draw_pixels(std::uint32_t* pixels, int w, int h, unsigned frame) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= w || y >= h) return;

    int tile = ((x / 32) + (y / 32) + frame) & 1;
    std::uint8_t r = tile ? 245 : 24;
    std::uint8_t g = (std::uint8_t)((x * 255) / (w - 1));
    std::uint8_t b = (std::uint8_t)((y * 255) / (h - 1));
    std::uint8_t a = 255;
    pixels[y * w + x] = ((std::uint32_t)a << 24) | ((std::uint32_t)b << 16)
        | ((std::uint32_t)g << 8) | (std::uint32_t)r;
}

static std::uint64_t checksum_rgba(const std::vector<std::uint32_t>& pixels) {
    std::uint64_t checksum = 1469598103934665603ULL;
    for (std::uint32_t px : pixels) {
        checksum ^= px;
        checksum *= 1099511628211ULL;
    }
    return checksum;
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
    hipLaunchKernelGGL(draw_pixels, grid, block, 0, 0, device_pixels, W, H, 3u);
    CHECK_HIP(hipGetLastError());
    CHECK_HIP(hipDeviceSynchronize());

    std::vector<std::uint32_t> host(W * H);
    CHECK_HIP(hipMemcpy(host.data(), device_pixels, sizeof(std::uint32_t) * host.size(),
                        hipMemcpyDeviceToHost));
    CHECK_HIP(hipFree(device_pixels));
    std::uint64_t gpu_checksum = checksum_rgba(host);

    CHECK_SDL(SDL_Init(SDL_INIT_VIDEO) == 0);
    SDL_Window* window = SDL_CreateWindow("HIP SDL texture probe",
        SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED, W, H, 0);
    CHECK_SDL(window != nullptr);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer) {
        renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
    }
    CHECK_SDL(renderer != nullptr);
    SDL_Texture* texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ABGR8888,
                                            SDL_TEXTUREACCESS_STREAMING, W, H);
    CHECK_SDL(texture != nullptr);
    CHECK_SDL(SDL_UpdateTexture(texture, nullptr, host.data(), W * sizeof(std::uint32_t)) == 0);
    CHECK_SDL(SDL_RenderClear(renderer) == 0);
    CHECK_SDL(SDL_RenderCopy(renderer, texture, nullptr, nullptr) == 0);
    SDL_RenderPresent(renderer);

    std::vector<std::uint32_t> readback(W * H);
    CHECK_SDL(SDL_RenderReadPixels(renderer, nullptr, SDL_PIXELFORMAT_ABGR8888,
                                   readback.data(), W * sizeof(std::uint32_t)) == 0);
    std::uint64_t sdl_checksum = checksum_rgba(readback);

    const char* out_path = "/tmp/hip_sdl_texture_readback.ppm";
    FILE* f = std::fopen(out_path, "wb");
    if (!f) {
        std::perror("fopen");
        return 1;
    }
    std::fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (std::uint32_t px : readback) {
        std::uint8_t rgb[3] = {
            (std::uint8_t)(px & 0xff),
            (std::uint8_t)((px >> 8) & 0xff),
            (std::uint8_t)((px >> 16) & 0xff),
        };
        std::fwrite(rgb, 1, sizeof(rgb), f);
    }
    std::fclose(f);

    SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();

    std::printf("ok hip_to_sdl_texture width=%d height=%d gpu_checksum=%llu sdl_checksum=%llu out=%s\n",
                W, H, (unsigned long long)gpu_checksum,
                (unsigned long long)sdl_checksum, out_path);
    return sdl_checksum != 0 ? 0 : 2;
}
