# GPU Interop Probes

Temporary proof probes for separating what the current worker stack can prove
from what it cannot prove yet.

## Claims Tested

Passed on the RX 9070 XT worker:

1. HIP directly writes a pixel buffer on the GPU.
2. SDL can render a HIP-generated pixel buffer after CPU copyback/upload.
3. The same process can hot-load two different HIP sidecar images and produce
   visibly different direct-pixel and SDL-rendered output.

Tested and not supported/proven on the current worker:

1. Zero-copy VRAM-to-display.
2. HIP/CUDA sharing a live OpenGL/Vulkan/SDL graphics buffer.
3. HIP/CUDA direct framebuffer display.

The negative result is scoped to this worker/container setup. It does not mean
these are impossible in general; it means the current Docker image, device
exposure, and runtime APIs do not prove or support them today.

## Baseline Commands

Copy into the running worker and run:

```sh
docker cp tmp/gpu-interop-probes/hip_pixel_probe.hip vectant-ade-worker-1:/tmp/hip_pixel_probe.hip
docker cp tmp/gpu-interop-probes/hip_sdl_texture_probe.hip vectant-ade-worker-1:/tmp/hip_sdl_texture_probe.hip

docker exec vectant-ade-worker-1 sh -lc '
hipcc --offload-arch=gfx1201 -O2 /tmp/hip_pixel_probe.hip -o /tmp/hip_pixel_probe
/tmp/hip_pixel_probe

hipcc --offload-arch=gfx1201 -O2 /tmp/hip_sdl_texture_probe.hip -lSDL2 -o /tmp/hip_sdl_texture_probe
xvfb-run -a /tmp/hip_sdl_texture_probe
'
```

Expected outputs:

- `/tmp/hip_direct_pixels.ppm`
- `/tmp/hip_sdl_texture_readback.ppm`

These are not zero-copy interop tests. The SDL path copies GPU output back to
CPU-visible memory, uploads it into an SDL texture, renders the texture, and
reads it back for checksum validation.

## HMR Commands

The HMR probe compiles two HIP sidecar images and loads both in one process via
the HIP module API:

```sh
docker cp tmp/gpu-interop-probes/hmr_pixel_kernel_v1.hip vectant-ade-worker-1:/tmp/hmr_pixel_kernel_v1.hip
docker cp tmp/gpu-interop-probes/hmr_pixel_kernel_v2.hip vectant-ade-worker-1:/tmp/hmr_pixel_kernel_v2.hip
docker cp tmp/gpu-interop-probes/hmr_pixel_host.cpp vectant-ade-worker-1:/tmp/hmr_pixel_host.cpp

docker exec vectant-ade-worker-1 sh -lc '
hipcc --genco --offload-arch=gfx1201 -O2 /tmp/hmr_pixel_kernel_v1.hip -o /tmp/hmr_pixel_v1.hsaco
hipcc --genco --offload-arch=gfx1201 -O2 /tmp/hmr_pixel_kernel_v2.hip -o /tmp/hmr_pixel_v2.hsaco
hipcc -O2 /tmp/hmr_pixel_host.cpp -lSDL2 -o /tmp/hmr_pixel_host
xvfb-run -a /tmp/hmr_pixel_host /tmp/hmr_pixel_v1.hsaco /tmp/hmr_pixel_v2.hsaco
'
```

Expected outputs:

- `/tmp/hmr_direct_v1.ppm`
- `/tmp/hmr_direct_v2.ppm`
- `/tmp/hmr_sdl_v1.ppm`
- `/tmp/hmr_sdl_v2.ppm`

This proves sidecar HMR for the supported paths:

- Direct HIP pixel generation: `v1.hsaco` and `v2.hsaco` produce different
  checksums in the same host process.
- HIP to SDL copyback/upload: the SDL readback checksum matches the direct GPU
  copyback checksum for each loaded sidecar.

## Negative Interop Commands

OpenGL graphics interop compile probe:

```sh
docker cp tmp/gpu-interop-probes/hip_gl_interop_compile_probe.hip vectant-ade-worker-1:/tmp/hip_gl_interop_compile_probe.hip
docker exec vectant-ade-worker-1 sh -lc '
set +e
hipcc --offload-arch=gfx1201 -O2 /tmp/hip_gl_interop_compile_probe.hip -lGL -o /tmp/hip_gl_interop_compile_probe
echo exit=$?
'
```

Vulkan external-memory compile probe:

```sh
docker cp tmp/gpu-interop-probes/hip_vulkan_external_memory_compile_probe.hip vectant-ade-worker-1:/tmp/hip_vulkan_external_memory_compile_probe.hip
docker exec vectant-ade-worker-1 sh -lc '
set +e
hipcc --offload-arch=gfx1201 -O2 /tmp/hip_vulkan_external_memory_compile_probe.hip -lvulkan -o /tmp/hip_vulkan_external_memory_compile_probe
echo exit=$?
'
```

Direct framebuffer/DRI probe:

```sh
docker cp tmp/gpu-interop-probes/framebuffer_device_probe.sh vectant-ade-worker-1:/tmp/framebuffer_device_probe.sh
docker exec vectant-ade-worker-1 sh -lc 'chmod +x /tmp/framebuffer_device_probe.sh; /tmp/framebuffer_device_probe.sh'
```

CUDA runtime probe on this AMD host:

```sh
docker cp tmp/gpu-interop-probes/cuda_device_probe.cu vectant-ade-worker-1:/tmp/cuda_device_probe.cu
docker exec vectant-ade-worker-1 sh -lc '
/usr/local/cuda/bin/nvcc /tmp/cuda_device_probe.cu -o /tmp/cuda_device_probe
/tmp/cuda_device_probe
'
```

## Latest RX 9070 XT Result

Run date: 2026-05-18

Direct HIP pixel write:

```text
device=0 name=AMD Radeon RX 9070 XT arch=gfx1201
ok direct_hip_pixels width=512 height=320 nonzero=163840 checksum=16930193702545587075 out=/tmp/hip_direct_pixels.ppm
```

HIP -> CPU copyback -> SDL texture upload/render/readback:

```text
device=0 name=AMD Radeon RX 9070 XT arch=gfx1201
ok hip_to_sdl_texture width=512 height=320 gpu_checksum=5193755713037534083 sdl_checksum=5193755713037534083 out=/tmp/hip_sdl_texture_readback.ppm
```

HIP sidecar HMR, direct pixel path and SDL copyback/upload path:

```text
device=0 name=AMD Radeon RX 9070 XT arch=gfx1201
ok hmr_direct_pixels v1_checksum=5892303441365236611 v2_checksum=1086148130233490179 changed=true
ok hmr_sdl_copyback v1_checksum=5892303441365236611 v2_checksum=1086148130233490179 changed=true match_direct=true
```

OpenGL interop compile probe:

```text
exit=1
/tmp/hip_gl_interop_compile_probe.hip:11:17: error: use of undeclared identifier 'hipGraphicsGLRegisterBuffer'
```

Vulkan external-memory compile probe:

```text
exit=1
/tmp/hip_vulkan_external_memory_compile_probe.hip:6:10: fatal error: 'vulkan/vulkan.h' file not found
```

Direct framebuffer/DRI probe:

```text
DISPLAY=:99
framebuffer_devices:
dri_devices:
x_server:
name of display:    :99
  dimensions:    800x600 pixels (203x152 millimeters)
  depth of root window:    24 planes
framebuffer_probe=absent
dri_probe=absent
```

CUDA runtime probe:

```text
build_exit=0
cudaGetDeviceCount err=35 name=cudaErrorInsufficientDriver count=0
run_exit=1
```

Interpretation:

- Proven: HIP can directly generate pixel data on the actual RX 9070 XT.
- Proven: SDL can render HIP-generated pixels after CPU copyback/upload; the
  SDL readback checksum matched the GPU copyback checksum exactly.
- Proven: HMR works for direct HIP pixel generation and the SDL copyback/upload
  render path by loading two different sidecars in the same host process.
- Not supported/proven: zero-copy VRAM-to-display or HIP/CUDA graphics-buffer
  interop. The current worker image exposes `libGL`/`libEGL`/`libvulkan`, but
  the HIP OpenGL interop symbol is not declared, Vulkan headers are missing,
  no framebuffer or DRI device is exposed, and CUDA cannot run on this AMD host.
