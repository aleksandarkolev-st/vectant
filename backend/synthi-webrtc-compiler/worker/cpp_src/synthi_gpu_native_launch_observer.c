#define _GNU_SOURCE

#include <execinfo.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

typedef int (*SynthiGpuModuleGetFunctionFn)(
    void** function,
    void* module,
    const char* name);

static unsigned long long synthi_launch_sequence = 0;

static unsigned long long synthi_fnv1a_append(
    unsigned long long hash,
    const char* value) {
    const unsigned char* ptr = (const unsigned char*)(value != NULL ? value : "");
    while (*ptr != '\0') {
        hash ^= (unsigned long long)(*ptr);
        hash *= 1099511628211ULL;
        ptr++;
    }
    return hash;
}

static void synthi_sanitize_token(
    const char* value,
    char* out,
    size_t out_size) {
    if (out_size == 0) {
        return;
    }
    size_t written = 0;
    const char* input = value != NULL && value[0] != '\0' ? value : "unknown";
    for (const unsigned char* ptr = (const unsigned char*)input;
         *ptr != '\0' && written + 1 < out_size;
         ptr++) {
        unsigned char ch = *ptr;
        out[written++] = (ch > 32 && ch < 127) ? (char)ch : '_';
    }
    out[written] = '\0';
}

static const char* synthi_runtime_session(void) {
    static char session[64];
    if (session[0] == '\0') {
        snprintf(session, sizeof(session), "native-launch-observer:%ld", (long)getpid());
    }
    return session;
}

static const char* synthi_observed_launch_apis(void) {
    return "oroModuleLaunchKernel,hipModuleLaunchKernel,cuLaunchKernel,oroLaunchKernel,hipLaunchKernel";
}

static const char* synthi_observed_function_resolution_apis(void) {
    return "oroModuleGetFunction,hipModuleGetFunction,cuModuleGetFunction";
}

__attribute__((constructor))
static void synthi_log_native_launch_observer_ready(void) {
    char mode_token[128];
    synthi_sanitize_token(
        getenv("SYNTHI_GPU_NATIVE_LAUNCH_OBSERVER"),
        mode_token,
        sizeof(mode_token));
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_launch_observer_ready runtime_session=%s pid=%ld mode=%s apis=%s function_resolution_apis=%s attachment_provenance=native_runtime_intercept\n",
        synthi_runtime_session(),
        (long)getpid(),
        mode_token,
        synthi_observed_launch_apis(),
        synthi_observed_function_resolution_apis());
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

static void synthi_log_native_function_resolution(
    const char* api,
    void* module,
    const char* name,
    void* function,
    int result,
    int real_resolver_resolved) {
    char symbol_token[256];
    synthi_sanitize_token(name, symbol_token, sizeof(symbol_token));
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_function_resolution api=%s runtime_session=%s module=0x%llx symbol=%s function_ptr=0x%llx result=%d resolution=%s real_resolver_resolved=%s attachment_provenance=native_runtime_intercept\n",
        api,
        synthi_runtime_session(),
        (unsigned long long)(uintptr_t)module,
        symbol_token,
        (unsigned long long)(uintptr_t)function,
        result,
        (result == 0 && function != NULL) ? "ok" : "failed",
        real_resolver_resolved ? "true" : "false");
}

static int synthi_module_get_function(
    const char* api,
    SynthiGpuModuleGetFunctionFn real_get_function,
    void** function,
    void* module,
    const char* name) {
    if (real_get_function == NULL) {
        synthi_log_native_function_resolution(api, module, name, NULL, 1, 0);
        return 1;
    }
    int result = real_get_function(function, module, name);
    void* resolved_function = function != NULL ? *function : NULL;
    synthi_log_native_function_resolution(api, module, name, resolved_function, result, 1);
    return result;
}

static void synthi_log_native_launch_candidates(
    unsigned long long sequence,
    void* function) {
    const char* session = synthi_runtime_session();
    const unsigned int max_candidate_frames = 6;
    void* frames[32];
    int frame_count = backtrace(frames, (int)(sizeof(frames) / sizeof(frames[0])));
    Dl_info self_info;
    const char* self_module = NULL;
    if (dladdr((void*)&synthi_log_native_launch_candidates, &self_info) != 0) {
        self_module = self_info.dli_fname;
    }
    unsigned int emitted = 0;
    for (int frame_index = 1; frame_index < frame_count && emitted < max_candidate_frames; frame_index++) {
        Dl_info frame_info;
        memset(&frame_info, 0, sizeof(frame_info));
        if (dladdr(frames[frame_index], &frame_info) == 0) {
            continue;
        }
        if (
            self_module != NULL
            && frame_info.dli_fname != NULL
            && strcmp(frame_info.dli_fname, self_module) == 0) {
            continue;
        }
        char module_token[256];
        char symbol_token[256];
        synthi_sanitize_token(frame_info.dli_fname, module_token, sizeof(module_token));
        synthi_sanitize_token(frame_info.dli_sname, symbol_token, sizeof(symbol_token));
        unsigned long long candidate_hash = 1469598103934665603ULL;
        candidate_hash = synthi_fnv1a_append(candidate_hash, module_token);
        candidate_hash = synthi_fnv1a_append(candidate_hash, symbol_token);
        candidate_hash ^= (unsigned long long)(uintptr_t)frames[frame_index];
        candidate_hash *= 1099511628211ULL;
        fprintf(
            stderr,
            "[gpu-runtime-boundary] original_host_path_candidate event=candidate attached=false dispatch_boundary_observed=true attachment_provenance=native_runtime_intercept host_path_id=native-callsite:%016llx launch_sequence=%llu frame_index=%d module=%s symbol=%s address=0x%llx function_ptr=0x%llx runtime_session=%s\n",
            candidate_hash,
            sequence,
            frame_index,
            module_token,
            symbol_token,
            (unsigned long long)(uintptr_t)frames[frame_index],
            (unsigned long long)(uintptr_t)function,
            session);
        emitted++;
    }
}

static void synthi_log_native_launch_attempt(
    const char* api,
    unsigned long long sequence,
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
    int real_launch_resolved) {
    const char* session = synthi_runtime_session();
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_launch_attempt api=%s runtime_session=%s sequence=%llu function_ptr=0x%llx grid=(%u,%u,%u) block=(%u,%u,%u) args_ptr=0x%llx stream=0x%llx shared_bytes=%u real_launch_resolved=%s dispatch=attempted-native attachment_provenance=native_runtime_intercept\n",
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
        real_launch_resolved ? "true" : "false");
    synthi_log_native_launch_candidates(sequence, function);
}

static void synthi_log_native_launch(
    const char* api,
    unsigned long long sequence,
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
    unsigned long long sequence = synthi_next_sequence();
    synthi_log_native_launch_attempt(
        api,
        sequence,
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
        real_launch != NULL);
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
        sequence,
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
    unsigned long long sequence = synthi_next_sequence();
    synthi_log_native_launch_attempt(
        api,
        sequence,
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
        real_launch != NULL);
    if (real_launch == NULL) {
        return 1;
    }
    int result = real_launch(function, grid, block, args, shared_bytes, stream);
    synthi_log_native_launch(
        api,
        sequence,
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

int oroModuleGetFunction(
    void** function,
    void* module,
    const char* name) {
    return synthi_module_get_function(
        "oroModuleGetFunction",
        (SynthiGpuModuleGetFunctionFn)synthi_next_symbol("oroModuleGetFunction"),
        function,
        module,
        name);
}

int hipModuleGetFunction(
    void** function,
    void* module,
    const char* name) {
    return synthi_module_get_function(
        "hipModuleGetFunction",
        (SynthiGpuModuleGetFunctionFn)synthi_next_symbol("hipModuleGetFunction"),
        function,
        module,
        name);
}

int cuModuleGetFunction(
    void** function,
    void* module,
    const char* name) {
    return synthi_module_get_function(
        "cuModuleGetFunction",
        (SynthiGpuModuleGetFunctionFn)synthi_next_symbol("cuModuleGetFunction"),
        function,
        module,
        name);
}
