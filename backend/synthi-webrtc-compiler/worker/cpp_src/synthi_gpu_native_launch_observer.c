#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

typedef struct SynthiGpuDim3 {
    unsigned int x;
    unsigned int y;
    unsigned int z;
} SynthiGpuDim3;

typedef int (*SynthiGpuModuleLaunchFn)(
    void* function,
    unsigned int grid_x,
    unsigned int grid_y,
    unsigned int grid_z,
    unsigned int block_x,
    unsigned int block_y,
    unsigned int block_z,
    unsigned int shared_bytes,
    void* stream,
    void** kernel_params,
    void** extra);

typedef int (*SynthiGpuRuntimeLaunchFn)(
    const void* function,
    SynthiGpuDim3 grid,
    SynthiGpuDim3 block,
    void** args,
    size_t shared_bytes,
    void* stream);

static unsigned long long synthi_launch_sequence = 0;

static const char* synthi_runtime_session(void) {
    static char session[64];
    if (session[0] == '\0') {
        snprintf(session, sizeof(session), "native-launch-observer:%ld", (long)getpid());
    }
    return session;
}

static unsigned long long synthi_next_sequence(void) {
    return __sync_add_and_fetch(&synthi_launch_sequence, 1);
}

static void* synthi_next_symbol(const char* name) {
    dlerror();
    void* symbol = dlsym(RTLD_NEXT, name);
    const char* error = dlerror();
    if (error != NULL || symbol == NULL) {
        fprintf(
            stderr,
            "[gpu-runtime-boundary] native_launch_intercept_error api=%s runtime_session=%s error=dlsym_next_missing\n",
            name,
            synthi_runtime_session());
        return NULL;
    }
    return symbol;
}

static void synthi_log_native_launch(
    const char* api,
    void* function,
    unsigned int grid_x,
    unsigned int grid_y,
    unsigned int grid_z,
    unsigned int block_x,
    unsigned int block_y,
    unsigned int block_z,
    unsigned int shared_bytes,
    void* stream,
    void** kernel_params,
    int result) {
    unsigned long long sequence = synthi_next_sequence();
    const char* session = synthi_runtime_session();
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_launch_observed api=%s runtime_session=%s sequence=%llu function_ptr=0x%llx grid=(%u,%u,%u) block=(%u,%u,%u) args_ptr=0x%llx stream=0x%llx shared_bytes=%u result=%d dispatch=observed-native attachment_provenance=native_runtime_intercept\n",
        api,
        session,
        sequence,
        (unsigned long long)(uintptr_t)function,
        grid_x,
        grid_y,
        grid_z,
        block_x,
        block_y,
        block_z,
        (unsigned long long)(uintptr_t)kernel_params,
        (unsigned long long)(uintptr_t)stream,
        shared_bytes,
        result);
    fprintf(
        stderr,
        "[gpu-runtime-boundary] original_host_path event=observed attached=false dispatch_boundary_observed=true attachment_provenance=native_runtime_intercept host_path_id=native-launch-observer:%llu dispatch_table_entry_id=none runtime_dispatch_table_entry_id=none dispatch_entry_runtime_verified=false generation=0 runtime_session=%s\n",
        sequence,
        session);
}

static int synthi_module_launch(
    const char* api,
    SynthiGpuModuleLaunchFn real_launch,
    void* function,
    unsigned int grid_x,
    unsigned int grid_y,
    unsigned int grid_z,
    unsigned int block_x,
    unsigned int block_y,
    unsigned int block_z,
    unsigned int shared_bytes,
    void* stream,
    void** kernel_params,
    void** extra) {
    if (real_launch == NULL) {
        return 1;
    }
    int result = real_launch(
        function,
        grid_x,
        grid_y,
        grid_z,
        block_x,
        block_y,
        block_z,
        shared_bytes,
        stream,
        kernel_params,
        extra);
    synthi_log_native_launch(
        api,
        function,
        grid_x,
        grid_y,
        grid_z,
        block_x,
        block_y,
        block_z,
        shared_bytes,
        stream,
        kernel_params,
        result);
    return result;
}

static int synthi_runtime_launch(
    const char* api,
    SynthiGpuRuntimeLaunchFn real_launch,
    const void* function,
    SynthiGpuDim3 grid,
    SynthiGpuDim3 block,
    void** args,
    size_t shared_bytes,
    void* stream) {
    if (real_launch == NULL) {
        return 1;
    }
    int result = real_launch(function, grid, block, args, shared_bytes, stream);
    synthi_log_native_launch(
        api,
        (void*)function,
        grid.x,
        grid.y,
        grid.z,
        block.x,
        block.y,
        block.z,
        (unsigned int)shared_bytes,
        stream,
        args,
        result);
    return result;
}

int oroModuleLaunchKernel(
    void* function,
    unsigned int grid_x,
    unsigned int grid_y,
    unsigned int grid_z,
    unsigned int block_x,
    unsigned int block_y,
    unsigned int block_z,
    unsigned int shared_bytes,
    void* stream,
    void** kernel_params,
    void** extra) {
    return synthi_module_launch(
        "oroModuleLaunchKernel",
        (SynthiGpuModuleLaunchFn)synthi_next_symbol("oroModuleLaunchKernel"),
        function,
        grid_x,
        grid_y,
        grid_z,
        block_x,
        block_y,
        block_z,
        shared_bytes,
        stream,
        kernel_params,
        extra);
}

int hipModuleLaunchKernel(
    void* function,
    unsigned int grid_x,
    unsigned int grid_y,
    unsigned int grid_z,
    unsigned int block_x,
    unsigned int block_y,
    unsigned int block_z,
    unsigned int shared_bytes,
    void* stream,
    void** kernel_params,
    void** extra) {
    return synthi_module_launch(
        "hipModuleLaunchKernel",
        (SynthiGpuModuleLaunchFn)synthi_next_symbol("hipModuleLaunchKernel"),
        function,
        grid_x,
        grid_y,
        grid_z,
        block_x,
        block_y,
        block_z,
        shared_bytes,
        stream,
        kernel_params,
        extra);
}

int cuLaunchKernel(
    void* function,
    unsigned int grid_x,
    unsigned int grid_y,
    unsigned int grid_z,
    unsigned int block_x,
    unsigned int block_y,
    unsigned int block_z,
    unsigned int shared_bytes,
    void* stream,
    void** kernel_params,
    void** extra) {
    return synthi_module_launch(
        "cuLaunchKernel",
        (SynthiGpuModuleLaunchFn)synthi_next_symbol("cuLaunchKernel"),
        function,
        grid_x,
        grid_y,
        grid_z,
        block_x,
        block_y,
        block_z,
        shared_bytes,
        stream,
        kernel_params,
        extra);
}

int oroLaunchKernel(
    const void* function,
    SynthiGpuDim3 grid,
    SynthiGpuDim3 block,
    void** args,
    size_t shared_bytes,
    void* stream) {
    return synthi_runtime_launch(
        "oroLaunchKernel",
        (SynthiGpuRuntimeLaunchFn)synthi_next_symbol("oroLaunchKernel"),
        function,
        grid,
        block,
        args,
        shared_bytes,
        stream);
}

int hipLaunchKernel(
    const void* function,
    SynthiGpuDim3 grid,
    SynthiGpuDim3 block,
    void** args,
    size_t shared_bytes,
    void* stream) {
    return synthi_runtime_launch(
        "hipLaunchKernel",
        (SynthiGpuRuntimeLaunchFn)synthi_next_symbol("hipLaunchKernel"),
        function,
        grid,
        block,
        args,
        shared_bytes,
        stream);
}
