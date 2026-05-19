// Mini HMR probe: load one HIP sidecar, launch it, then load another sidecar
// with the same kernel ABI in the same process. Also proves SDL can render the
// reloaded GPU-generated pixels after CPU copyback/texture upload.

#include <hip/hip_runtime.h>
#include <SDL2/SDL.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define CHECK_HIP(call)                                                          \
    do {                                                                         \
        hipError_t err__ = (call);                                               \
        if (err__ != hipSuccess) {                                               \
            std::fprintf(stderr, "HIP error %s:%d: %s\n", __FILE__, __LINE__,    \
                         hipGetErrorString(err__));                              \
            return false;                                                        \
        }                                                                        \
    } while (0)

#define CHECK_SDL(expr)                                                          \
    do {                                                                         \
        if (!(expr)) {                                                           \
            std::fprintf(stderr, "SDL error %s:%d: %s\n", __FILE__, __LINE__,    \
                         SDL_GetError());                                        \
            return false;                                                        \
        }                                                                        \
    } while (0)

static constexpr int W = 512;
static constexpr int H = 320;

static std::uint64_t checksum_rgba(const std::vector<std::uint32_t>& pixels) {
    std::uint64_t checksum = 1469598103934665603ULL;
    for (std::uint32_t px : pixels) {
        checksum ^= px;
        checksum *= 1099511628211ULL;
    }
    return checksum;
}

static bool write_ppm(const char* path, const std::vector<std::uint32_t>& pixels) {
    FILE* f = std::fopen(path, "wb");
    if (!f) {
        std::perror("fopen");
        return false;
    }
    std::fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (std::uint32_t px : pixels) {
        std::uint8_t rgb[3] = {
            (std::uint8_t)(px & 0xff),
            (std::uint8_t)((px >> 8) & 0xff),
            (std::uint8_t)((px >> 16) & 0xff),
        };
        std::fwrite(rgb, 1, sizeof(rgb), f);
    }
    std::fclose(f);
    return true;
}

struct Sidecar {
    hipModule_t module = nullptr;
    hipFunction_t kernel = nullptr;
};

static bool load_sidecar(const char* path, Sidecar* out) {
    CHECK_HIP(hipModuleLoad(&out->module, path));
    CHECK_HIP(hipModuleGetFunction(&out->kernel, out->module, "draw_pixels"));
    return true;
}

static bool launch_sidecar(Sidecar& sidecar, std::uint32_t* device_pixels, unsigned frame,
                           std::vector<std::uint32_t>* host_pixels) {
    int w = W;
    int h = H;
    void* args[] = { &device_pixels, &w, &h, &frame };
    CHECK_HIP(hipModuleLaunchKernel(sidecar.kernel,
                                    (W + 15) / 16, (H + 15) / 16, 1,
                                    16, 16, 1,
                                    0, nullptr, args, nullptr));
    CHECK_HIP(hipDeviceSynchronize());
    CHECK_HIP(hipMemcpy(host_pixels->data(), device_pixels,
                        sizeof(std::uint32_t) * host_pixels->size(),
                        hipMemcpyDeviceToHost));
    return true;
}

static bool render_with_sdl(const std::vector<std::uint32_t>& pixels,
                            std::vector<std::uint32_t>* readback) {
    SDL_Window* window = SDL_CreateWindow("HIP HMR SDL probe",
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
    CHECK_SDL(SDL_UpdateTexture(texture, nullptr, pixels.data(), W * sizeof(std::uint32_t)) == 0);
    CHECK_SDL(SDL_RenderClear(renderer) == 0);
    CHECK_SDL(SDL_RenderCopy(renderer, texture, nullptr, nullptr) == 0);
    SDL_RenderPresent(renderer);
    CHECK_SDL(SDL_RenderReadPixels(renderer, nullptr, SDL_PIXELFORMAT_ABGR8888,
                                   readback->data(), W * sizeof(std::uint32_t)) == 0);
    SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    return true;
}

static bool run(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: %s v1.hsaco v2.hsaco\n", argv[0]);
        return false;
    }

    int device = 0;
    CHECK_HIP(hipGetDevice(&device));
    hipDeviceProp_t props{};
    CHECK_HIP(hipGetDeviceProperties(&props, device));
    std::printf("device=%d name=%s arch=%s\n", device, props.name, props.gcnArchName);

    std::uint32_t* device_pixels = nullptr;
    CHECK_HIP(hipMalloc(&device_pixels, sizeof(std::uint32_t) * W * H));

    std::vector<std::uint32_t> v1(W * H);
    std::vector<std::uint32_t> v2(W * H);
    Sidecar sidecar1;
    Sidecar sidecar2;
    if (!load_sidecar(argv[1], &sidecar1)) return false;
    if (!launch_sidecar(sidecar1, device_pixels, 5u, &v1)) return false;
    std::uint64_t v1_sum = checksum_rgba(v1);
    if (!write_ppm("/tmp/hmr_direct_v1.ppm", v1)) return false;
    CHECK_HIP(hipModuleUnload(sidecar1.module));

    if (!load_sidecar(argv[2], &sidecar2)) return false;
    if (!launch_sidecar(sidecar2, device_pixels, 6u, &v2)) return false;
    std::uint64_t v2_sum = checksum_rgba(v2);
    if (!write_ppm("/tmp/hmr_direct_v2.ppm", v2)) return false;
    CHECK_HIP(hipModuleUnload(sidecar2.module));
    CHECK_HIP(hipFree(device_pixels));

    if (v1_sum == v2_sum) {
        std::fprintf(stderr, "HMR sidecar checksum did not change: %llu\n",
                     (unsigned long long)v1_sum);
        return false;
    }

    CHECK_SDL(SDL_Init(SDL_INIT_VIDEO) == 0);
    std::vector<std::uint32_t> sdl1(W * H);
    std::vector<std::uint32_t> sdl2(W * H);
    if (!render_with_sdl(v1, &sdl1)) return false;
    if (!render_with_sdl(v2, &sdl2)) return false;
    SDL_Quit();
    std::uint64_t sdl1_sum = checksum_rgba(sdl1);
    std::uint64_t sdl2_sum = checksum_rgba(sdl2);
    if (!write_ppm("/tmp/hmr_sdl_v1.ppm", sdl1)) return false;
    if (!write_ppm("/tmp/hmr_sdl_v2.ppm", sdl2)) return false;

    std::printf("ok hmr_direct_pixels v1_checksum=%llu v2_checksum=%llu changed=%s\n",
                (unsigned long long)v1_sum, (unsigned long long)v2_sum,
                v1_sum != v2_sum ? "true" : "false");
    std::printf("ok hmr_sdl_copyback v1_checksum=%llu v2_checksum=%llu changed=%s match_direct=%s\n",
                (unsigned long long)sdl1_sum, (unsigned long long)sdl2_sum,
                sdl1_sum != sdl2_sum ? "true" : "false",
                (sdl1_sum == v1_sum && sdl2_sum == v2_sum) ? "true" : "false");
    return sdl1_sum != sdl2_sum && sdl1_sum == v1_sum && sdl2_sum == v2_sum;
}

int main(int argc, char** argv) {
    return run(argc, argv) ? 0 : 1;
}
