#include <cuda_runtime.h>

#include <cstdio>

int main() {
    int count = 0;
    cudaError_t err = cudaGetDeviceCount(&count);
    std::printf(
        "cudaGetDeviceCount err=%d name=%s count=%d\n",
        static_cast<int>(err),
        cudaGetErrorName(err),
        count);
    return (err == cudaSuccess && count > 0) ? 0 : 1;
}
