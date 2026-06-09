# GPU HMR Investor Demo Status

Updated: 2026-06-09

## Demo Position

Safe investor-demo claim:

```text
On the local AMD ROCm machine, Synthi can hot-reload a GPU device-artifact edit, keep the runtime alive, and prove the changed output with strict runtime-ledger evidence plus pixel-backed before/after/diff visual artifacts.
```

Best demo surfaces:

1. ROCm/HIP MCP ray-light preview: strongest Synthi app preview proof.
2. ROCm/HIP MCP Flow preview: second generated visual workload, proving this is not a one-case path.
3. HIPRT same-process CameraRays and MegaKernel: strongest ray-traced framebuffer proof.
4. ThreeJS WebGL external profile: concrete external runtime screenshot proof, not full ledger acceptance.
5. WebGPU Chrome/AMD scoped WGSL runtime visual proof: shader-module/pipeline/frame proof for an explicit-empty-layout profile.
6. Strict ROCm/HIP compute ledger: strongest full-runtime proof artifact and output-oracle readback.

Do not claim:

```text
CUDA was proven on this AMD GPU.
Every arbitrary GPU project is production accepted.
Bevy or broad/general WebGPU has full-runtime proof-ledger acceptance.
OIDN HIP produced or validated the accepted visual output.
OpenCL dispatch/readback output proof was validated on this worker.
Vulkan pipeline/command-buffer/frame output proof was validated on this worker.
General WebGPU bind-group, vertex-buffer, engine-cache, or arbitrary app shader HMR was validated on this worker.
The one-file generated .hip split proves per-kernel or smallest-safe fission.
Any proof succeeded because of a shim or hardcoded scenario path.
```

## Current Hardening Status

Latest implementation commits:

```text
7dcbbb84c feat(gpu-hmr): normalize webgpu runtime timings
66c42458d feat(gpu-hmr): add webgpu runtime visual proof
b34a7e1a1 feat(gpu-hmr): add webgpu preflight proof
f2a02a83e feat(gpu-hmr): add vulkan preflight rejection proof
732d2bcfa fix(gpu-hmr): bind narrow fission to generated topology
35232abcd fix(gpu-hmr): reject generated split per-kernel overclaims
f47a45c25 feat(gpu-hmr): add opencl preflight rejection proof
97ee6b7cc fix(gpu-hmr): enforce visual runner proof waits
e13508d27 fix(gpu-hmr): use real visual fixtures in rocm self-check
f8559c672 docs(gpu-hmr): record visual ledger hardening status
37f110451 fix(gpu-hmr): bind visual proof to ledger oracle
5e1ad07b6 fix(gpu-hmr): require resolved fission output oracle
394f6ff32 fix(gpu-hmr): bind fission contract to verifier proof
e90fc49b3 fix(gpu-hmr): derive runtime profile self-check fixture
22f003d3b fix(gpu-hmr): require complete fission contract proof
```

Demo-relevant rule changes:

```text
Screenshots and pixel diffs are visual evidence, not authority.
Visual HMR acceptance now requires visual_oracle_artifacts in the derived proof ledger record.
Fission acceptance requires a verified output-oracle proposal or resolved output-oracle contract.
Generated device edits in the visual runner now require the MCP wait gate to apply with full GPU runtime proof before acceptance.
The visual runner now fails immediately when no initial generated device compile marker or GPU split endpoint evidence is observed.
The generated ray-light and Flow demos remain device-translation-unit HMR claims, not per-kernel fission claims.
Generated split topology now rejects per-kernel HMR unless deterministic fission-verifier evidence proves it.
Narrow generated fission candidates now require topology binding to a content-addressed partial artifact before the verifier can pass them.
Vulkan preflight now rejects missing ICD/tool evidence and cannot count as pipeline or frame-output proof.
WebGPU preflight records Chrome launch flags, AMD RDNA4 adapter evidence, and a nonblank diagnostic screenshot, but still cannot count as shader/pipeline/frame HMR proof.
WebGPU runtime visual proof now accepts only the executed explicit-empty-layout WGSL pipeline scope and requires shared ledger success, visual-threshold success, process-continuity evidence, and native WebGPU API evidence.
The timing summary now includes WebGPU runtime visual proofs in the same normalized timing schema as ROCm/HIP, HIPRT, and external profiles.
```

Post-hardening verification:

```text
npx vitest run tests/unit/gpu_hmr_runtime_proof.test.ts -> 279 passed
npm --prefix mcp/synthi-mcp run build -> passed
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check -> passed
cargo gpu_fission tests in worker builder image -> 64 passed
cargo gpu_prod_contracts tests in worker builder image -> 36 passed
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed
npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:opencl:preflight:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:preflight:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check -> passed
```

## Live Preview Targets

The local stack is running:

```text
frontend: 127.0.0.1:3000
MCP: 127.0.0.1:9464
worker: up
```

HTTP preview checks passed:

```text
Ray-light: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-after-wait-gate -> HTTP 200
Flow:      http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-after-wait-gate -> HTTP 200
```

Headless Chrome page-level captures showed only the dark app shell and are not counted as proof. Visual proof for this checkpoint comes from MCP screenshot artifacts tied to frame gates and local image inspection of the persisted PNGs.

## Ray-Light Preview Proof

Accepted current proof:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-after-wait-gate
runtime proof id: gpu-runtime-proof:sha256:e7c6304f46f7f1f8e53b78e02fb0abe1a2cb2c0e4542977a857ae313ac43d045
ledger id: gpu-ledger-proof:sha256:c6e8aed7008136cedc8f141bba699142fd1200d72504e0ec21ef6888601c4959
result state: gpu-hmr-full-runtime-proven
HMR plan: device_only
```

Artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-after-wait-gate/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-after-wait-gate/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-after-wait-gate/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-after-wait-gate/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-after-wait-gate/agent-split-results.txt
```

Visual/timing numbers:

```text
changed pixels: 5.88%
mean abs delta: 10.00
control changed: 0.00%
control mean abs: 0.06
selected frame seq: 1173
selected delta: 2099ms
```

Visual inspection: before renders a ray/light scene with ground grid and ray bundle; after moves the light/ray path; the diff is nonblank and high-signal.

## Flow Preview Proof

Accepted current proof:

```text
workspace slug: flow-gpu-hmr-proof-20260609-after-wait-gate
runtime proof id: gpu-runtime-proof:sha256:919a2b493ddee52df8647b14bd59c4d42b263ed1f1bd205b72df6f8efb456fdf
ledger id: gpu-ledger-proof:sha256:9af232f65b3589f47f7fde378d5034d65a9d09c9529657e53efafd2aec192de7
result state: gpu-hmr-full-runtime-proven
HMR plan: device_only
```

Artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-after-wait-gate/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-after-wait-gate/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-after-wait-gate/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-after-wait-gate/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-after-wait-gate/agent-split-results.txt
```

Visual/timing numbers:

```text
changed pixels: 2.59%
mean abs delta: 3.58
control changed: 0.00%
control mean abs: 0.03
selected frame seq: 3627
selected delta: 2664ms
```

Visual inspection: before renders a sparse particle ring; after renders a gridded wave/field; the diff is nonblank.

## Generated Split Claim

The generated preview demos prove device-translation-unit HMR.

```text
Flow: device_translation_unit_hmr, one device TU, two kernels, rejects per_kernel_hmr and smallest_safe_fission_island.
Ray-light: device_translation_unit_hmr, one device TU, one kernel, rejects per_kernel_hmr and smallest_safe_fission_island because no deterministic fission verifier is present.
```

Demo phrasing:

```text
The current generated HIP path hot-reloads the generated device translation unit. It does not claim per-kernel fission yet.
```

Verifier guard:

```text
Narrower generated fission requires generated-topology evidence and artifact:sha256 binding.
Missing topology evidence rejects with fission.claim_narrower_than_generated_topology.
```

## HIPRT Ray-Traced Proof

HIPRT is a same-process path-tracer proof, not the MCP preview path.

```text
worker repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

CameraRays:

```text
profile: hiprt-camera-rays-horizontal-mirror
proof id: hiprt-warm-runtime-proof:sha256:aa108131d5999bc6c473971db04f4bc0c047e0bce9570614a85f483f27c2ac40
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032207-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032207-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032207-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032207-diff-amplified.png
changed pixels: 91.4019%
mean abs delta 8-bit: 53.1273
live recompile: 41ms
edit to first visual: 1894ms
total wall: 12843.4901ms
```

MegaKernel direct-light:

```text
profile: hiprt-megakernel-direct-light-zero
proof id: hiprt-warm-runtime-proof:sha256:bc32cdeabf7439f559b0f3b16403dcc36738612d6e691bc362a2c9ba98ea93ac
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032241-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032241-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032241-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609032241-diff-amplified.png
changed pixels: 41.8229%
mean abs delta 8-bit: 32.9462
live recompile: 75ms
edit to first visual: 2389ms
total wall: 13764.7823ms
```

Visual inspection: both HIPRT diffs are readable and nonblank. CameraRays shows a mirrored/recomposed Cornell-style framebuffer; MegaKernel shows a direct-light contribution change.

## OIDN Result

Structured OIDN preflight proof:

```text
proof id: oidn-preflight-proof:sha256:809e4e3e9613c6343fcd6fd0b3f138db66f781b74104126e65d7cc06830c60ef
result state: oidn-hip-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-rerun-after-visual-ledger-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-rerun-after-visual-ledger-summary.txt
```

OIDN HIP was tested and rejected:

```text
oidnTest 'device creation' --device hip --success --durations yes --rng-seed 12345
result: FAILED, bool(device) false

oidnTest 'buffer read/write' --device hip --success --durations yes --rng-seed 12345
result: FAILED, bool(device) false

ldd libOpenImageDenoise_device_hip.so.2.3.0:
libamdhip64.so.5 => not found
unsupported reasons: missing_dependency:libamdhip64.so.5, oidn_hip_buffer_read_write_failed, oidn_hip_device_creation_failed
```

OIDN CPU diagnostics passed:

```text
device creation: 8 assertions passed
buffer read/write: 27 assertions passed
```

No OIDN HIP proof is accepted, and no symlink or ABI shim was added.

## OpenCL Result

Structured OpenCL preflight proof:

```text
proof id: opencl-preflight-proof:sha256:64e92684b59489f2dc88c1ac6e570fd54605bc9bb345cb6653cc15e22714c4ea
result state: opencl-runtime-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260609-after-output-gate-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260609-after-output-gate-summary.txt
```

OpenCL was tested and rejected:

```text
OpenCL loader: libOpenCL.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libOpenCL.so.1
vendor ICDs: none
platform count: unknown
device counts: none
unsupported reasons: opencl_vendor_icd_missing, clinfo_missing
```

The preflight does not count as OpenCL HMR output proof:

```text
acceptedForOpenClOutputProof: false
gpuHmrSuccess: false
dispatchTraceRequired: true
outputOracleRequired: true
noShimApplied: true
noVendorIcdSynthesized: true
noSymlinkApplied: true
```

No OpenCL proof is accepted on this worker, and no vendor ICD, symlink, or compatibility shim was synthesized.

## Vulkan Result

Structured Vulkan preflight proof:

```text
proof id: vulkan-preflight-proof:sha256:d904016a24c785659424bae3cc5381ae2a84b816fee87c1f13dd335709d7a528
result state: vulkan-runtime-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-summary.txt
```

Vulkan was tested and rejected:

```text
Vulkan loader: libvulkan.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvulkan.so.1
ICD files: none
ICD libraries: none
API version: unknown
physical device count: 0
device names: none
unsupported reasons: vulkan_icd_missing, vulkaninfo_missing
```

The preflight does not count as Vulkan HMR proof:

```text
acceptedForVulkanPipelineProof: false
gpuHmrSuccess: false
pipelineLayoutProofRequired: true
commandBufferTraceRequired: true
frameOutputOracleRequired: true
noShimApplied: true
noIcdSynthesized: true
noSymlinkApplied: true
```

No Vulkan proof is accepted on this worker, and no ICD, symlink, or compatibility shim was synthesized.

## WebGPU Result

Structured WebGPU runtime preflight proof:

```text
proof id: webgpu-preflight-proof:sha256:c6cc4216d34477cf4968797b420d4ac4f331b84834939acc5c1a956f2c31bd2d
result state: webgpu-runtime-preflight-accepted
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-summary.txt
diagnostic screenshot: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-diagnostic.png
```

WebGPU runtime preflight was tested and accepted:

```text
browser: C:\Program Files\Google\Chrome\Application\chrome.exe
browser launch args: --enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan,WebGPU,UseSkiaRenderer --disable-gpu-sandbox
adapter: {"vendor":"amd","architecture":"rdna-4","device":"","description":""}
preferred canvas format: bgra8unorm
unsupported reasons: none
```

Visual inspection confirmed the diagnostic screenshot is nonblank and contains a rendered WebGPU triangle plus runtime JSON proving secure context, `navigator.gpu`, adapter, device creation, and render submit.

The preflight does not count as WebGPU HMR proof:

```text
acceptedForWebGpuRuntimePreflight: true
acceptedForWebGpuPipelineProof: false
gpuHmrSuccess: false
shaderModuleEpochRequired: true
bindGroupLayoutProofRequired: true
pipelineLayoutProofRequired: true
pipelineRecreateProofRequired: true
frameOutputOracleRequired: true
noShimApplied: true
noBrowserFlagClaimedAsHmr: true
```

No WebGPU shim was added. Browser flags are disclosed as runtime enablement evidence only, not as proof of shader-module, pipeline, epoch, or frame-output HMR.

Structured WebGPU runtime visual HMR proof:

```text
proof id: webgpu-runtime-visual-proof:sha256:e45b1d839607d694a744226228c0341dd6959eb336058bf733152a77f972e81d
result state: webgpu-hmr-full-runtime-proven
ledger proof id: gpu-ledger-proof:sha256:56994c1b29cef52e7b86ba4d3936031a3486123bb62da99ab1e554d779011a2e
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-summary.txt
```

Visual artifacts inspected:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-before.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-after.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-diff.png
changed pixel ratio: 29.3893%
mean abs delta 8-bit: 37.6426
visible pixel count: 67713
```

Accepted scope:

```text
profile: webgpu-wgsl-runtime-triangle
pipeline scope: explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list
wgsl hash before: sha256:46927f5ed8423e965306fb45cf698deab767e2582d9b745db3c064c092285582
wgsl hash after: sha256:63fac832718d56179ba8a043e55afe6b93f6af9608269c13aa174fb3e66a2e66
epoch: webgpu-epoch-2
dispatch id: webgpu-dispatch-2
pipeline id: webgpu-pipeline-2-4fb3e66a2e66
ledger failed invariants: none
visual thresholds accepted: true
process continuity accepted: true
native WebGPU API accepted: true
total validator wall time: 951597400ns
trigger to visible time: 67788100ns
```

Normalized timing report:

```text
timing summary json: mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260609T051533Z.json
source: webgpu_runtime_visual
profile: webgpu-wgsl-runtime-triangle
status: pass
total wall: 951.5974ms
edit/trigger to first visual: 67.7881ms
visual diff: 35.6061ms
```

Do not generalize this to arbitrary WebGPU projects. The runner rejects profiles with non-empty bind-group layouts, vertex buffers, fixed color formats outside the preferred canvas format, or non-opaque alpha mode unless a future proof runner executes and traces those fields.

## Strict ROCm/HIP Compute Ledger

Accepted full-runtime compute/readback proof:

```text
workspace: gpu-real-rocm-repo-20260609005300
runtime proof id: gpu-runtime-proof:sha256:0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2
ledger proof id: gpu-ledger-proof:sha256:1cfa9927c27d63b9eadf4c96021f7d9270051519d822bfb55eb7b7f08b64b9eb
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-repo-20260609005300-real-rocm-runtime-proof-0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2.json
result state: gpu-hmr-full-runtime-proven
full runtime proven: true
limitations: []
```

Supplemental proof card:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260609005300-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

Visual inspection confirmed the proof card is readable and shows matching expected/readback hashes. The patched summary builder also accepts this artifact with `gpu_hmr_success=true`, no limitations, accepted ledger, and accepted contract consistency.

Rejected later reruns:

```text
gpu-real-rocm-repo-20260609010632: rejected because worker runtime session was lost.
gpu-real-rocm-repo-20260609011410: rejected because no HMR proof was produced before first-phase timeout.
```

These are not proof. They demonstrate the harness refuses invalid runtime evidence.

## External Profile Proofs

ThreeJS WebGL shader lava passed as an external runtime screenshot proof:

```text
profile: threejs-webgl-shader-lava
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1780977150053-report.json
proof id: external-visual-proof:8a42ec53c94aa29844c2992782c2ca4156b9cd2c9c285b92d9b64901e4fde6cf
total wall: 9330.6259ms
edit to screenshot: 2836ms
visual diff: 95ms
changed pixels: 28.3806%
mean abs delta 8-bit: 12.9288
Chrome GPU: enabled
```

Artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1780977142363.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1780977147880.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1780977149507.png
```

Visual inspection confirmed a torus-to-sphere material/geometry change and a nonblank diff.

Bevy/WGSL was tested with real Rust GNU and w64devkit and remains rejected, not accepted.

Fresh rejection artifact:

```text
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
rejection proof id: external-rejection-proof:9d3ac84744bb6ff8b8260a8df1827c8a0ffc26847d13de7fa10447015e3f215e
rejection proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972543516-rejection-proof.json
status: fail
reasons: mcp_request_timeout, mcp_no_decoded_frames, visual_frame_missing, visual_oracle_not_accepted
visual evidence accepted: false
total validator wall: 1203518.9259ms
```

Earlier strict proof-state rejection:

```text
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780961693506-report.json
status: fail
reason: gpu_hmr_proof_insufficient
required state: gpu-hmr-full-runtime-proven
observed state: missing
```

This is a correct refusal, not a demo success.

## Verification Checklist

Passed:

```text
npx vitest run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts
npm --prefix mcp/synthi-mcp run build
npm --prefix mcp/synthi-mcp run proof:external-project:self-check
npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process
npm --prefix mcp/synthi-mcp run proof:runtime-profile:hiprt:camera-rays
npm --prefix mcp/synthi-mcp run proof:runtime-profile:hiprt
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
$env:SYNTHI_GPU_HMR_EXTERNAL_PROJECT_DEFAULT_PROFILE_ID='threejs-webgl-shader-lava'; npm --prefix mcp/synthi-mcp run proof:external-project
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/app/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=ray-light SLUG=ray-light-gpu-hmr-proof-20260609-after-wait-gate SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/app/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=flow SLUG=flow-gpu-hmr-proof-20260609-after-wait-gate SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
npm --prefix mcp/synthi-mcp run proof:oidn:preflight:self-check
SYNTHI_OIDN_WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_OIDN_REPO_PATH=/tmp/synthi-real-rocm/HIPRT-Path-Tracer SLUG=oidn-hiprt-rocm-preflight-20260609-rerun-after-visual-ledger npm --prefix mcp/synthi-mcp run proof:oidn:preflight
npm --prefix mcp/synthi-mcp run proof:opencl:preflight:self-check
SYNTHI_OPENCL_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=opencl-rocm-preflight-20260609-after-output-gate npm --prefix mcp/synthi-mcp run proof:opencl:preflight
npm --prefix mcp/synthi-mcp run proof:vulkan:preflight:self-check
SYNTHI_VULKAN_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=vulkan-rocm-preflight-20260609 npm --prefix mcp/synthi-mcp run proof:vulkan:preflight
npm --prefix mcp/synthi-mcp run proof:webgpu:preflight:self-check
$env:SLUG='webgpu-preflight-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:preflight
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:self-check
$env:SLUG='webgpu-runtime-visual-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual
node mcp/synthi-mcp/scripts/gpu-hmr-external-project-profile.mjs --rejection-proof-from-report mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
```

Expected rejection:

```text
SYNTHI_GPU_HMR_EXTERNAL_MCP_TRANSPORT=docker SYNTHI_GPU_HMR_EXTERNAL_SIGNALING_URL=ws://signaling-server:9000 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER=vectant-ade-mcp-1 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER_ENTRY=/app/dist/index.js SYNTHI_GPU_HMR_EXTERNAL_MCP_REQUEST_TIMEOUT_MS=1200000 SYNTHI_GPU_HMR_EXTERNAL_MCP_ATTACH_TIMEOUT_MS=1200000 npm --prefix mcp/synthi-mcp run proof:external-project:bevy
```

## Commit Checkpoint

Relevant current commits:

```text
f2a02a83e feat(gpu-hmr): add vulkan preflight rejection proof
732d2bcfa fix(gpu-hmr): bind narrow fission to generated topology
35232abcd fix(gpu-hmr): reject generated split per-kernel overclaims
f47a45c25 feat(gpu-hmr): add opencl preflight rejection proof
f0db3c67e fix(gpu-hmr): classify external timeout rejections
b542e7390 docs(gpu-hmr): record Bevy rejection proof artifact
706c20799 fix(gpu-hmr): ledger external profile rejections
8b358451e docs(gpu-hmr): record structured OIDN preflight proof
fcff70032 feat(gpu-hmr): add structured OIDN HIP preflight proof
08f16a794 fix(gpu-hmr): archive agent split results per slug
f42e4d32e docs(gpu-hmr): update ROCm proof ledger demo status
92543192f fix(gpu-hmr): preserve derived contracts in proof summaries
302bbc238 fix(gpu-hmr): require explicit real rocm docker config
a12e654d8 fix(gpu-hmr): require explicit agent split docker config
529fce4e2 fix(gpu-hmr): keep external chrome gpu enabled
01a2759a1 fix(gpu-hmr): require explicit docker preview config
71e9e3dd4 fix(gpu-hmr): reject invalid visual evidence artifacts
```

These are generic hardening changes. They are not fixture-specific, and they do not add shims.

## Honest Remaining Work

- Full-runtime Bevy acceptance is not implemented.
- CUDA needs a CUDA machine.
- OIDN HIP needs a ROCm-compatible OIDN HIP build; no ABI shortcut should be used.
- OpenCL needs a real vendor ICD plus dispatch/event/readback ledger proof; no synthesized ICD or shim should be used.
- Vulkan needs a real ICD plus pipeline-layout, command-buffer, frame-boundary, and visual oracle ledger proof; no synthesized ICD or shim should be used.
- WebGPU beyond the accepted explicit-empty-layout WGSL profile needs executed bind-group, vertex-buffer, engine-cache, pipeline-layout, frame trace, and output-oracle ledger proof; browser flags must remain evidence-only.
- Per-kernel/smallest-safe fission needs a deterministic verifier.
- Browser plugin visual proof was unavailable because no in-app browser backend was exposed.
