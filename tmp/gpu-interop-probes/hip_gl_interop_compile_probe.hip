// Negative probe: this is the shape a HIP/OpenGL zero-copy PBO interop test
// would need. On the current ROCm worker image these HIP graphics interop
// declarations are not present, so compiling this file should fail.

#include <hip/hip_runtime.h>
#include <GL/gl.h>

int main() {
    GLuint pbo = 0;
    hipGraphicsResource_t resource = nullptr;
    return (int)hipGraphicsGLRegisterBuffer(&resource, pbo, hipGraphicsRegisterFlagsWriteDiscard);
}
