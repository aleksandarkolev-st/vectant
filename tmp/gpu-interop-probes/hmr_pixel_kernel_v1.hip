// HMR sidecar v1: GPU-generated pixel pattern.
#include <hip/hip_runtime.h>
#include <stdint.h>

extern "C" __global__ void draw_pixels(uint32_t* pixels, int w, int h, unsigned frame) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= w || y >= h) return;

    float cx = 0.5f * (float)w;
    float cy = 0.5f * (float)h;
    float dx = ((float)x - cx) / cx;
    float dy = ((float)y - cy) / cy;
    float r2 = dx * dx + dy * dy;

    uint8_t r = (uint8_t)((x * 255) / (w - 1));
    uint8_t g = (uint8_t)((y * 255) / (h - 1));
    uint8_t b = (uint8_t)(r2 < 0.28f ? 255 : ((frame * 31 + x + y) & 127));
    uint8_t a = 255;
    pixels[y * w + x] = ((uint32_t)a << 24) | ((uint32_t)b << 16)
        | ((uint32_t)g << 8) | (uint32_t)r;
}
