#include <hip/hip_runtime.h>

extern "C" __global__ void synthi_hmr_uint32_reordered_kernel(
  unsigned int* output,
  const unsigned int* input,
  unsigned int increment,
  unsigned int n,
  unsigned int extra) {
  const unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  output[i] = input[i] + increment + extra;
}
