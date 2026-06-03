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

typedef struct SynthiGpuChannelFormatDesc {
    int x;
    int y;
    int z;
    int w;
    int f;
} SynthiGpuChannelFormatDesc;

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

typedef int (*SynthiGpuTextureObjectCreateFn)(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc);

typedef int (*SynthiGpuArrayAllocationFn)(
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags);

typedef int (*SynthiGpuArrayCreateFn)(
    void** array,
    const void* descriptor);

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
    void** extra);
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
    void** extra);
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
    void** extra);
int oroLaunchKernel(
    const void* function,
    SynthiGpuDim3 grid,
    SynthiGpuDim3 block,
    void** args,
    size_t shared_bytes,
    void* stream);
int hipLaunchKernel(
    const void* function,
    SynthiGpuDim3 grid,
    SynthiGpuDim3 block,
    void** args,
    size_t shared_bytes,
    void* stream);
int oroModuleGetFunction(void** function, void* module, const char* name);
int hipModuleGetFunction(void** function, void* module, const char* name);
int cuModuleGetFunction(void** function, void* module, const char* name);
int oroCreateTextureObject(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc);
int hipCreateTextureObject(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc);
int hipTexObjectCreate(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc);
int cuTexObjectCreate(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc);
int oroTexObjectCreate(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc);
int oroMallocArray(
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags);
int hipMallocArray(
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags);
int cudaMallocArray(
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags);
int cuArrayCreate(void** array, const void* descriptor);
int cuArrayCreate_v2(void** array, const void* descriptor);

static unsigned long long synthi_launch_sequence = 0;
static unsigned long long synthi_texture_sequence = 0;
static unsigned long long synthi_array_sequence = 0;

static void* synthi_real_oro_module_launch_kernel = NULL;
static void* synthi_real_hip_module_launch_kernel = NULL;
static void* synthi_real_cu_launch_kernel = NULL;
static void* synthi_real_oro_launch_kernel = NULL;
static void* synthi_real_hip_launch_kernel = NULL;
static void* synthi_real_oro_module_get_function = NULL;
static void* synthi_real_hip_module_get_function = NULL;
static void* synthi_real_cu_module_get_function = NULL;
static void* synthi_real_oro_create_texture_object = NULL;
static void* synthi_real_hip_create_texture_object = NULL;
static void* synthi_real_hip_tex_object_create = NULL;
static void* synthi_real_cu_tex_object_create = NULL;
static void* synthi_real_oro_tex_object_create = NULL;
static void* synthi_real_oro_malloc_array = NULL;
static void* synthi_real_hip_malloc_array = NULL;
static void* synthi_real_cuda_malloc_array = NULL;
static void* synthi_real_cu_array_create = NULL;
static void* synthi_real_cu_array_create_v2 = NULL;

#define SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY 256

typedef struct SynthiGpuResolvedFunctionSymbol {
    void* function;
    void* module;
    char symbol[256];
    char api[64];
} SynthiGpuResolvedFunctionSymbol;

static SynthiGpuResolvedFunctionSymbol
    synthi_resolved_function_symbols[SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY];
static unsigned int synthi_resolved_function_symbol_count = 0;

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

static unsigned int synthi_resolved_function_symbol_slot(void* function) {
    unsigned long long hash = (unsigned long long)(uintptr_t)function;
    hash ^= hash >> 33;
    hash *= 0xff51afd7ed558ccdULL;
    hash ^= hash >> 33;
    return (unsigned int)(hash % SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY);
}

static void synthi_record_function_symbol(
    const char* api,
    void* module,
    void* function,
    const char* name) {
    if (function == NULL || name == NULL || name[0] == '\0') {
        return;
    }
    char symbol_token[256];
    char api_token[64];
    synthi_sanitize_token(name, symbol_token, sizeof(symbol_token));
    synthi_sanitize_token(api, api_token, sizeof(api_token));
    unsigned int limit = synthi_resolved_function_symbol_count;
    if (limit > SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY) {
        limit = SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY;
    }
    for (unsigned int index = 0; index < limit; index++) {
        if (synthi_resolved_function_symbols[index].function == function) {
            synthi_resolved_function_symbols[index].module = module;
            snprintf(
                synthi_resolved_function_symbols[index].symbol,
                sizeof(synthi_resolved_function_symbols[index].symbol),
                "%s",
                symbol_token);
            snprintf(
                synthi_resolved_function_symbols[index].api,
                sizeof(synthi_resolved_function_symbols[index].api),
                "%s",
                api_token);
            return;
        }
    }
    unsigned int slot = __sync_fetch_and_add(&synthi_resolved_function_symbol_count, 1);
    if (slot >= SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY) {
        slot = synthi_resolved_function_symbol_slot(function);
    }
    synthi_resolved_function_symbols[slot].module = module;
    snprintf(
        synthi_resolved_function_symbols[slot].symbol,
        sizeof(synthi_resolved_function_symbols[slot].symbol),
        "%s",
        symbol_token);
    snprintf(
        synthi_resolved_function_symbols[slot].api,
        sizeof(synthi_resolved_function_symbols[slot].api),
        "%s",
        api_token);
    __sync_synchronize();
    synthi_resolved_function_symbols[slot].function = function;
}

static void synthi_function_symbol_token(
    void* function,
    char* out,
    size_t out_size) {
    if (out_size == 0) {
        return;
    }
    if (function != NULL) {
        unsigned int limit = synthi_resolved_function_symbol_count;
        if (limit > SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY) {
            limit = SYNTHI_RESOLVED_FUNCTION_SYMBOL_CAPACITY;
        }
        for (unsigned int index = 0; index < limit; index++) {
            if (synthi_resolved_function_symbols[index].function == function) {
                synthi_sanitize_token(
                    synthi_resolved_function_symbols[index].symbol,
                    out,
                    out_size);
                return;
            }
        }
        Dl_info function_info;
        memset(&function_info, 0, sizeof(function_info));
        if (dladdr(function, &function_info) != 0 && function_info.dli_sname != NULL) {
            synthi_sanitize_token(function_info.dli_sname, out, out_size);
            return;
        }
    }
    synthi_sanitize_token(NULL, out, out_size);
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

static const char* synthi_observed_texture_object_apis(void) {
    return "oroCreateTextureObject,hipCreateTextureObject,hipTexObjectCreate,cuTexObjectCreate,oroTexObjectCreate";
}

static const char* synthi_observed_array_allocation_apis(void) {
    return "oroMallocArray,hipMallocArray,cudaMallocArray,cuArrayCreate,cuArrayCreate_v2";
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
        "[gpu-runtime-boundary] native_launch_observer_ready runtime_session=%s pid=%ld mode=%s apis=%s function_resolution_apis=%s texture_object_apis=%s array_allocation_apis=%s attachment_provenance=native_runtime_intercept\n",
        synthi_runtime_session(),
        (long)getpid(),
        mode_token,
        synthi_observed_launch_apis(),
        synthi_observed_function_resolution_apis(),
        synthi_observed_texture_object_apis(),
        synthi_observed_array_allocation_apis());
}

static unsigned long long synthi_next_sequence(void) {
    return __sync_add_and_fetch(&synthi_launch_sequence, 1);
}

static unsigned long long synthi_next_texture_sequence(void) {
    return __sync_add_and_fetch(&synthi_texture_sequence, 1);
}

static unsigned long long synthi_next_array_sequence(void) {
    return __sync_add_and_fetch(&synthi_array_sequence, 1);
}

static void* synthi_real_dlsym_call(void* handle, const char* name) {
    static void* (*real_dlsym)(void*, const char*) = NULL;
    if (real_dlsym == NULL) {
        real_dlsym = (void* (*)(void*, const char*))dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
    }
    return real_dlsym != NULL ? real_dlsym(handle, name) : NULL;
}

static void** synthi_cached_symbol_slot(const char* name) {
    if (name == NULL) {
        return NULL;
    }
    if (strcmp(name, "oroModuleLaunchKernel") == 0) {
        return &synthi_real_oro_module_launch_kernel;
    }
    if (strcmp(name, "hipModuleLaunchKernel") == 0) {
        return &synthi_real_hip_module_launch_kernel;
    }
    if (strcmp(name, "cuLaunchKernel") == 0) {
        return &synthi_real_cu_launch_kernel;
    }
    if (strcmp(name, "oroLaunchKernel") == 0) {
        return &synthi_real_oro_launch_kernel;
    }
    if (strcmp(name, "hipLaunchKernel") == 0) {
        return &synthi_real_hip_launch_kernel;
    }
    if (strcmp(name, "oroModuleGetFunction") == 0) {
        return &synthi_real_oro_module_get_function;
    }
    if (strcmp(name, "hipModuleGetFunction") == 0) {
        return &synthi_real_hip_module_get_function;
    }
    if (strcmp(name, "cuModuleGetFunction") == 0) {
        return &synthi_real_cu_module_get_function;
    }
    if (strcmp(name, "oroCreateTextureObject") == 0) {
        return &synthi_real_oro_create_texture_object;
    }
    if (strcmp(name, "hipCreateTextureObject") == 0) {
        return &synthi_real_hip_create_texture_object;
    }
    if (strcmp(name, "hipTexObjectCreate") == 0) {
        return &synthi_real_hip_tex_object_create;
    }
    if (strcmp(name, "cuTexObjectCreate") == 0) {
        return &synthi_real_cu_tex_object_create;
    }
    if (strcmp(name, "oroTexObjectCreate") == 0) {
        return &synthi_real_oro_tex_object_create;
    }
    if (strcmp(name, "oroMallocArray") == 0) {
        return &synthi_real_oro_malloc_array;
    }
    if (strcmp(name, "hipMallocArray") == 0) {
        return &synthi_real_hip_malloc_array;
    }
    if (strcmp(name, "cudaMallocArray") == 0) {
        return &synthi_real_cuda_malloc_array;
    }
    if (strcmp(name, "cuArrayCreate") == 0) {
        return &synthi_real_cu_array_create;
    }
    if (strcmp(name, "cuArrayCreate_v2") == 0) {
        return &synthi_real_cu_array_create_v2;
    }
    return NULL;
}

static void* synthi_wrapper_symbol(const char* name) {
    if (name == NULL) {
        return NULL;
    }
    if (strcmp(name, "oroModuleLaunchKernel") == 0) {
        return (void*)&oroModuleLaunchKernel;
    }
    if (strcmp(name, "hipModuleLaunchKernel") == 0) {
        return (void*)&hipModuleLaunchKernel;
    }
    if (strcmp(name, "cuLaunchKernel") == 0) {
        return (void*)&cuLaunchKernel;
    }
    if (strcmp(name, "oroLaunchKernel") == 0) {
        return (void*)&oroLaunchKernel;
    }
    if (strcmp(name, "hipLaunchKernel") == 0) {
        return (void*)&hipLaunchKernel;
    }
    if (strcmp(name, "oroModuleGetFunction") == 0) {
        return (void*)&oroModuleGetFunction;
    }
    if (strcmp(name, "hipModuleGetFunction") == 0) {
        return (void*)&hipModuleGetFunction;
    }
    if (strcmp(name, "cuModuleGetFunction") == 0) {
        return (void*)&cuModuleGetFunction;
    }
    if (strcmp(name, "oroCreateTextureObject") == 0) {
        return (void*)&oroCreateTextureObject;
    }
    if (strcmp(name, "hipCreateTextureObject") == 0) {
        return (void*)&hipCreateTextureObject;
    }
    if (strcmp(name, "hipTexObjectCreate") == 0) {
        return (void*)&hipTexObjectCreate;
    }
    if (strcmp(name, "cuTexObjectCreate") == 0) {
        return (void*)&cuTexObjectCreate;
    }
    if (strcmp(name, "oroTexObjectCreate") == 0) {
        return (void*)&oroTexObjectCreate;
    }
    if (strcmp(name, "oroMallocArray") == 0) {
        return (void*)&oroMallocArray;
    }
    if (strcmp(name, "hipMallocArray") == 0) {
        return (void*)&hipMallocArray;
    }
    if (strcmp(name, "cudaMallocArray") == 0) {
        return (void*)&cudaMallocArray;
    }
    if (strcmp(name, "cuArrayCreate") == 0) {
        return (void*)&cuArrayCreate;
    }
    if (strcmp(name, "cuArrayCreate_v2") == 0) {
        return (void*)&cuArrayCreate_v2;
    }
    return NULL;
}

static void synthi_cache_real_symbol(const char* name, void* symbol) {
    void** slot = synthi_cached_symbol_slot(name);
    void* wrapper = synthi_wrapper_symbol(name);
    if (slot != NULL && symbol != NULL && symbol != wrapper) {
        *slot = symbol;
    }
}

static void* synthi_cached_symbol(const char* name) {
    void** slot = synthi_cached_symbol_slot(name);
    return slot != NULL ? *slot : NULL;
}

static void* synthi_next_symbol(const char* name) {
    dlerror();
    void* symbol = synthi_real_dlsym_call(RTLD_NEXT, name);
    const char* error = dlerror();
    if (error != NULL || symbol == NULL) {
        fprintf(
            stderr,
            "[gpu-runtime-boundary] native_launch_intercept_error api=%s runtime_session=%s error=dlsym_next_missing\n",
            name,
            synthi_runtime_session());
        return NULL;
    }
    synthi_cache_real_symbol(name, symbol);
    return symbol;
}

static void* synthi_cached_or_next_symbol(const char* name) {
    void* symbol = synthi_cached_symbol(name);
    return symbol != NULL ? symbol : synthi_next_symbol(name);
}

void* dlsym(void* handle, const char* name) {
    void* symbol = synthi_real_dlsym_call(handle, name);
    void* wrapper = synthi_wrapper_symbol(name);
    if (symbol == NULL || wrapper == NULL) {
        return symbol;
    }
    void* real_symbol = symbol;
    if (real_symbol == wrapper) {
        real_symbol = synthi_real_dlsym_call(RTLD_NEXT, name);
    }
    if (real_symbol == NULL || real_symbol == wrapper) {
        return symbol;
    }
    synthi_cache_real_symbol(name, real_symbol);
    return wrapper;
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
    if (result == 0 && resolved_function != NULL) {
        synthi_record_function_symbol(api, module, resolved_function, name);
    }
    synthi_log_native_function_resolution(api, module, name, resolved_function, result, 1);
    return result;
}

static void synthi_log_native_texture_object_create(
    const char* api,
    unsigned long long sequence,
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc,
    int result,
    int real_resolver_resolved) {
    unsigned long long texture_value = texture != NULL ? *texture : 0ULL;
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_texture_object_create api=%s runtime_session=%s sequence=%llu texture=0x%llx texture_out_ptr=0x%llx resource_desc_ptr=0x%llx texture_desc_ptr=0x%llx resource_view_desc_ptr=0x%llx result=%d creation=%s real_resolver_resolved=%s attachment_provenance=native_runtime_intercept\n",
        api,
        synthi_runtime_session(),
        sequence,
        texture_value,
        (unsigned long long)(uintptr_t)texture,
        (unsigned long long)(uintptr_t)resource_desc,
        (unsigned long long)(uintptr_t)texture_desc,
        (unsigned long long)(uintptr_t)resource_view_desc,
        result,
        (result == 0 && texture_value != 0ULL) ? "ok" : "failed",
        real_resolver_resolved ? "true" : "false");
}

static int synthi_texture_object_create(
    const char* api,
    SynthiGpuTextureObjectCreateFn real_create,
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc) {
    unsigned long long sequence = synthi_next_texture_sequence();
    if (real_create == NULL) {
        synthi_log_native_texture_object_create(
            api,
            sequence,
            texture,
            resource_desc,
            texture_desc,
            resource_view_desc,
            1,
            0);
        return 1;
    }
    int result = real_create(texture, resource_desc, texture_desc, resource_view_desc);
    synthi_log_native_texture_object_create(
        api,
        sequence,
        texture,
        resource_desc,
        texture_desc,
        resource_view_desc,
        result,
        1);
    return result;
}

static void synthi_log_native_array_allocation(
    const char* api,
    unsigned long long sequence,
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags,
    int result,
    int real_resolver_resolved) {
    void* array_value = array != NULL ? *array : NULL;
    const char* descriptor_kind = descriptor == NULL ? "none" : "opaque";
    int channel_x = 0;
    int channel_y = 0;
    int channel_z = 0;
    int channel_w = 0;
    int channel_format_kind = 0;
    if (descriptor != NULL && api != NULL && strstr(api, "MallocArray") != NULL) {
        const SynthiGpuChannelFormatDesc* channel_desc =
            (const SynthiGpuChannelFormatDesc*)descriptor;
        descriptor_kind = "channel_format";
        channel_x = channel_desc->x;
        channel_y = channel_desc->y;
        channel_z = channel_desc->z;
        channel_w = channel_desc->w;
        channel_format_kind = channel_desc->f;
    }
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_array_allocation api=%s runtime_session=%s sequence=%llu array=0x%llx array_out_ptr=0x%llx descriptor_ptr=0x%llx descriptor_kind=%s channel_x=%d channel_y=%d channel_z=%d channel_w=%d channel_format_kind=%d width=%llu height=%llu flags=%u result=%d allocation=%s real_resolver_resolved=%s attachment_provenance=native_runtime_intercept\n",
        api,
        synthi_runtime_session(),
        sequence,
        (unsigned long long)(uintptr_t)array_value,
        (unsigned long long)(uintptr_t)array,
        (unsigned long long)(uintptr_t)descriptor,
        descriptor_kind,
        channel_x,
        channel_y,
        channel_z,
        channel_w,
        channel_format_kind,
        (unsigned long long)width,
        (unsigned long long)height,
        flags,
        result,
        (result == 0 && array_value != NULL) ? "ok" : "failed",
        real_resolver_resolved ? "true" : "false");
}

static int synthi_array_allocation(
    const char* api,
    SynthiGpuArrayAllocationFn real_allocate,
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags) {
    unsigned long long sequence = synthi_next_array_sequence();
    if (real_allocate == NULL) {
        synthi_log_native_array_allocation(
            api,
            sequence,
            array,
            descriptor,
            width,
            height,
            flags,
            1,
            0);
        return 1;
    }
    int result = real_allocate(array, descriptor, width, height, flags);
    synthi_log_native_array_allocation(
        api,
        sequence,
        array,
        descriptor,
        width,
        height,
        flags,
        result,
        1);
    return result;
}

static int synthi_array_create(
    const char* api,
    SynthiGpuArrayCreateFn real_create,
    void** array,
    const void* descriptor) {
    unsigned long long sequence = synthi_next_array_sequence();
    if (real_create == NULL) {
        synthi_log_native_array_allocation(api, sequence, array, descriptor, 0, 0, 0, 1, 0);
        return 1;
    }
    int result = real_create(array, descriptor);
    synthi_log_native_array_allocation(api, sequence, array, descriptor, 0, 0, 0, result, 1);
    return result;
}

static void synthi_log_native_launch_candidates(
    unsigned long long sequence,
    void* function,
    const char* kernel_symbol) {
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
            "[gpu-runtime-boundary] original_host_path_candidate event=candidate attached=false dispatch_boundary_observed=true attachment_provenance=native_runtime_intercept host_path_id=native-callsite:%016llx launch_sequence=%llu frame_index=%d module=%s symbol=%s address=0x%llx function_ptr=0x%llx kernel_symbol=%s runtime_session=%s\n",
            candidate_hash,
            sequence,
            frame_index,
            module_token,
            symbol_token,
            (unsigned long long)(uintptr_t)frames[frame_index],
            (unsigned long long)(uintptr_t)function,
            kernel_symbol,
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
    char kernel_symbol[256];
    synthi_function_symbol_token(function, kernel_symbol, sizeof(kernel_symbol));
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_launch_attempt api=%s runtime_session=%s sequence=%llu function_ptr=0x%llx kernel_symbol=%s grid=(%u,%u,%u) block=(%u,%u,%u) args_ptr=0x%llx stream=0x%llx shared_bytes=%u real_launch_resolved=%s dispatch=attempted-native attachment_provenance=native_runtime_intercept\n",
        api,
        session,
        sequence,
        (unsigned long long)(uintptr_t)function,
        kernel_symbol,
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
    synthi_log_native_launch_candidates(sequence, function, kernel_symbol);
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
    char kernel_symbol[256];
    synthi_function_symbol_token(function, kernel_symbol, sizeof(kernel_symbol));
    fprintf(
        stderr,
        "[gpu-runtime-boundary] native_launch_observed api=%s runtime_session=%s sequence=%llu function_ptr=0x%llx kernel_symbol=%s grid=(%u,%u,%u) block=(%u,%u,%u) args_ptr=0x%llx stream=0x%llx shared_bytes=%u result=%d dispatch=observed-native attachment_provenance=native_runtime_intercept\n",
        api,
        session,
        sequence,
        (unsigned long long)(uintptr_t)function,
        kernel_symbol,
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
        "[gpu-runtime-boundary] original_host_path event=observed attached=false dispatch_boundary_observed=true attachment_provenance=native_runtime_intercept host_path_id=native-launch-observer:%llu dispatch_table_entry_id=none runtime_dispatch_table_entry_id=none dispatch_entry_runtime_verified=false generation=0 function_ptr=0x%llx kernel_symbol=%s runtime_session=%s\n",
        sequence,
        (unsigned long long)(uintptr_t)function,
        kernel_symbol,
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
        (SynthiGpuModuleLaunchFn)synthi_cached_or_next_symbol("oroModuleLaunchKernel"),
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
        (SynthiGpuModuleLaunchFn)synthi_cached_or_next_symbol("hipModuleLaunchKernel"),
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
        (SynthiGpuModuleLaunchFn)synthi_cached_or_next_symbol("cuLaunchKernel"),
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
        (SynthiGpuRuntimeLaunchFn)synthi_cached_or_next_symbol("oroLaunchKernel"),
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
        (SynthiGpuRuntimeLaunchFn)synthi_cached_or_next_symbol("hipLaunchKernel"),
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
        (SynthiGpuModuleGetFunctionFn)synthi_cached_or_next_symbol("oroModuleGetFunction"),
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
        (SynthiGpuModuleGetFunctionFn)synthi_cached_or_next_symbol("hipModuleGetFunction"),
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
        (SynthiGpuModuleGetFunctionFn)synthi_cached_or_next_symbol("cuModuleGetFunction"),
        function,
        module,
        name);
}

int oroCreateTextureObject(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc) {
    return synthi_texture_object_create(
        "oroCreateTextureObject",
        (SynthiGpuTextureObjectCreateFn)synthi_cached_or_next_symbol("oroCreateTextureObject"),
        texture,
        resource_desc,
        texture_desc,
        resource_view_desc);
}

int hipCreateTextureObject(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc) {
    return synthi_texture_object_create(
        "hipCreateTextureObject",
        (SynthiGpuTextureObjectCreateFn)synthi_cached_or_next_symbol("hipCreateTextureObject"),
        texture,
        resource_desc,
        texture_desc,
        resource_view_desc);
}

int hipTexObjectCreate(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc) {
    return synthi_texture_object_create(
        "hipTexObjectCreate",
        (SynthiGpuTextureObjectCreateFn)synthi_cached_or_next_symbol("hipTexObjectCreate"),
        texture,
        resource_desc,
        texture_desc,
        resource_view_desc);
}

int cuTexObjectCreate(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc) {
    return synthi_texture_object_create(
        "cuTexObjectCreate",
        (SynthiGpuTextureObjectCreateFn)synthi_cached_or_next_symbol("cuTexObjectCreate"),
        texture,
        resource_desc,
        texture_desc,
        resource_view_desc);
}

int oroTexObjectCreate(
    unsigned long long* texture,
    const void* resource_desc,
    const void* texture_desc,
    const void* resource_view_desc) {
    return synthi_texture_object_create(
        "oroTexObjectCreate",
        (SynthiGpuTextureObjectCreateFn)synthi_cached_or_next_symbol("oroTexObjectCreate"),
        texture,
        resource_desc,
        texture_desc,
        resource_view_desc);
}

int oroMallocArray(
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags) {
    return synthi_array_allocation(
        "oroMallocArray",
        (SynthiGpuArrayAllocationFn)synthi_cached_or_next_symbol("oroMallocArray"),
        array,
        descriptor,
        width,
        height,
        flags);
}

int hipMallocArray(
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags) {
    return synthi_array_allocation(
        "hipMallocArray",
        (SynthiGpuArrayAllocationFn)synthi_cached_or_next_symbol("hipMallocArray"),
        array,
        descriptor,
        width,
        height,
        flags);
}

int cudaMallocArray(
    void** array,
    const void* descriptor,
    size_t width,
    size_t height,
    unsigned int flags) {
    return synthi_array_allocation(
        "cudaMallocArray",
        (SynthiGpuArrayAllocationFn)synthi_cached_or_next_symbol("cudaMallocArray"),
        array,
        descriptor,
        width,
        height,
        flags);
}

int cuArrayCreate(void** array, const void* descriptor) {
    return synthi_array_create(
        "cuArrayCreate",
        (SynthiGpuArrayCreateFn)synthi_cached_or_next_symbol("cuArrayCreate"),
        array,
        descriptor);
}

int cuArrayCreate_v2(void** array, const void* descriptor) {
    return synthi_array_create(
        "cuArrayCreate_v2",
        (SynthiGpuArrayCreateFn)synthi_cached_or_next_symbol("cuArrayCreate_v2"),
        array,
        descriptor);
}
