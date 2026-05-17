# GPU Interop Probes

Temporary proof probes for distinguishing three claims:

1. HIP directly writes a pixel buffer on the GPU.
2. SDL can render a HIP-generated pixel buffer after CPU copyback/upload.
3. Zero-copy graphics interop is not proven by the first two probes.

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

These are not zero-copy interop tests.

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

Interpretation:

- Proven: HIP can directly generate pixel data on the actual RX 9070 XT.
- Proven: SDL can render HIP-generated pixels after CPU copyback/upload; the
  SDL readback checksum matched the GPU copyback checksum exactly.
- Not proven: zero-copy VRAM-to-display or HIP/CUDA graphics-buffer interop.
  The current worker image exposes `libGL`/`libEGL`/`libvulkan`, but has no
  `glxinfo`, no `vulkaninfo`, no `glfw3` pkg-config, and no visible ROCm HIP
  graphics interop declarations such as `hipGraphicsGLRegisterBuffer` under
  `/opt/rocm/include`.
