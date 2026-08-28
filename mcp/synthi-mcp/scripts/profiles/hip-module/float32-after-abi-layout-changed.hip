#include <hip/hip_runtime.h>

extern "C" __global__ void synthi_hmr_float32_epoch_kernel(
  const float* input,
  float* output,
  float scale,
  float bias,
  unsigned int n,
  float extra_gain) {
  const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    output[i] = input[i] * (scale + extra_gain) + bias;
  }
}
