// HMR sidecar v2: same ABI, different GPU-generated pixel pattern.
#include <hip/hip_runtime.h>
#include <stdint.h>

extern "C" __global__ void draw_pixels(uint32_t* pixels, int w, int h, unsigned frame) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= w || y >= h) return;

    int tile = ((x / 24) ^ (y / 24) ^ (int)frame) & 1;
    uint8_t r = tile ? 18 : 255;
    uint8_t g = (uint8_t)(255 - ((x * 255) / (w - 1)));
    uint8_t b = (uint8_t)((x + 2 * y + 17 * (int)frame) & 255);
    uint8_t a = 255;
    pixels[y * w + x] = ((uint32_t)a << 24) | ((uint32_t)b << 16)
        | ((uint32_t)g << 8) | (uint32_t)r;
}
