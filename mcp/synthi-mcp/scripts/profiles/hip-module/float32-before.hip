#include <hip/hip_runtime.h>

extern "C" __global__ void synthi_hmr_float32_epoch_kernel(
  float* output,
  const float* input,
  float scale,
  float bias,
  unsigned int n) {
  const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  output[i] = input[i] * scale + bias;
}
