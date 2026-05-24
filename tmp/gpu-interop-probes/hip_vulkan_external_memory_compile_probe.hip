// Negative probe: this is the shape a HIP/Vulkan external-memory interop test
// would need. On the current ROCm worker image these HIP external memory
// declarations are not present, so compiling this file should fail.

#include <hip/hip_runtime.h>
#include <vulkan/vulkan.h>

int main() {
    hipExternalMemoryHandleDesc desc{};
    desc.type = hipExternalMemoryHandleTypeOpaqueFd;
    desc.handle.fd = -1;
    desc.size = 4096;
    hipExternalMemory_t memory = nullptr;
    return (int)hipImportExternalMemory(&memory, &desc);
}
