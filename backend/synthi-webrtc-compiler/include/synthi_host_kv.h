// ============================================================
// SYNTHI HOST KV API - C/C++ Header
// ============================================================
// Version: 1.0
// 
// This header defines the Host KV API for Synthi plugins.
// Include this in your plugin to use persistent key-value storage
// that survives hot reloads.
//
// USAGE:
// 1. Export your namespace schemas via host_kv_schemas_len/host_kv_schemas
// 2. Export *_on_load_host instead of *_on_load to receive the host context
// 3. Use the KV API functions from the host context
// ============================================================

#ifndef SYNTHI_HOST_KV_H
#define SYNTHI_HOST_KV_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================
// VERSION CONSTANTS
// ============================================================

#define SYNTHI_HOST_KV_VERSION 1
#define SYNTHI_CORE_ABI_VERSION 1
#define SYNTHI_GUI_ABI_VERSION 1

// ============================================================
// RETURN CODES
// ============================================================

#define SYNTHI_KV_OK              0
#define SYNTHI_KV_NOT_FOUND       1
#define SYNTHI_KV_INVALID_ARG     2
#define SYNTHI_KV_QUOTA_EXCEEDED  3
#define SYNTHI_KV_INTERNAL_ERROR  4

// ============================================================
// MODULE SLOT IDENTIFIERS
// ============================================================

#define SYNTHI_MODULE_SLOT_CORE 0
#define SYNTHI_MODULE_SLOT_GUI  1
#define SYNTHI_MODULE_SLOT_MAIN 2

// ============================================================
// QUOTA LIMITS (for reference)
// ============================================================

#define SYNTHI_KV_MAX_VALUE_BYTES       1000000   // 1 MB per value
#define SYNTHI_KV_MAX_KEYS_PER_NS       2000      // 2000 keys per namespace
#define SYNTHI_KV_MAX_TOTAL_BYTES       20000000  // 20 MB per module
#define SYNTHI_KV_MAX_NAMESPACE_LEN     64
#define SYNTHI_KV_MAX_KEY_LEN           256
#define SYNTHI_KV_MAX_NAMESPACES        128

// ============================================================
// FORWARD DECLARATIONS
// ============================================================

typedef struct SynthiHostContextV1 SynthiHostContextV1;
typedef struct HostKvApiV1 HostKvApiV1;
typedef struct SynthiNamespaceSchemaV1 SynthiNamespaceSchemaV1;

// ============================================================
// KV API VTABLE
// ============================================================
// Function pointer table for KV operations.
// All functions return 0 (SYNTHI_KV_OK) on success.
// ============================================================

struct HostKvApiV1 {
    // API version (must be 1)
    uint32_t version;
    
    // Set bytes for a key in a namespace
    // Returns: SYNTHI_KV_OK on success, error code on failure
    int (*set_bytes)(
        const SynthiHostContextV1* ctx,
        const char* ns,           // Namespace (NUL-terminated)
        const char* key,          // Key (NUL-terminated)
        const uint8_t* data,      // Data buffer
        uint32_t len              // Data length
    );
    
    // Get bytes for a key
    // On success, *out is allocated via host_alloc and must be freed with host_free
    // Returns: SYNTHI_KV_OK on success, SYNTHI_KV_NOT_FOUND if key doesn't exist
    int (*get_bytes)(
        const SynthiHostContextV1* ctx,
        const char* ns,
        const char* key,
        uint8_t** out,            // Output: pointer to allocated buffer
        uint32_t* out_len         // Output: length of data
    );
    
    // Delete a key (idempotent - returns OK even if key doesn't exist)
    int (*delete_key)(
        const SynthiHostContextV1* ctx,
        const char* ns,
        const char* key
    );
    
    // Clear all keys in a namespace
    int (*clear_namespace)(
        const SynthiHostContextV1* ctx,
        const char* ns
    );
    
    // Get schema ID for a namespace
    int (*get_schema)(
        const SynthiHostContextV1* ctx,
        const char* ns,
        uint64_t* out_schema
    );
    
    // Set schema ID for a namespace (optional - usually from exports)
    int (*set_schema)(
        const SynthiHostContextV1* ctx,
        const char* ns,
        uint64_t schema
    );
    
    // Allocate memory (use for buffers that will be passed to host)
    void* (*host_alloc)(uint32_t size);
    
    // Free memory allocated by host_alloc or returned by get_bytes
    void (*host_free)(void* ptr);
    
    // Get last error message (NUL-terminated, do not free)
    const char* (*last_error)(void);
};

// ============================================================
// HOST CONTEXT
// ============================================================
// Passed to *_on_load_host functions.
// Contains session info, KV API, and graphics pointers.
// ============================================================

struct SynthiHostContextV1 {
    // API version (must be 1)
    uint32_t host_api_version;
    
    // KV API vtable
    const HostKvApiV1* kv;
    
    // Session identifier
    const char* session_id;
    uint32_t session_id_len;
    
    // Module slot (0=core, 1=gui, 2=main)
    uint32_t module_slot;
    
    // Graphics pointers (for SDL2 compatibility)
    void* window;     // SDL_Window* or NULL
    void* renderer;   // SDL_Renderer* or NULL
    
    // Reserved for future expansion
    void* reserved[8];
};

// ============================================================
// NAMESPACE SCHEMA ENTRY
// ============================================================
// Export an array of these to declare your namespaces.
// Schema ID changes trigger namespace reset (Fast Refresh-like).
// ============================================================

struct SynthiNamespaceSchemaV1 {
    // Namespace name (NUL-terminated, max 64 chars)
    const char* ns;
    
    // Schema ID - change this when your namespace data format changes
    // Use a hash of your data struct, or a simple version number
    uint64_t schema_id;
};

// ============================================================
// EXPORT MACROS
// ============================================================
// Helper macros for exporting symbols correctly.
// ============================================================

#ifdef _WIN32
    #define SYNTHI_EXPORT __declspec(dllexport)
#else
    #define SYNTHI_EXPORT __attribute__((visibility("default")))
#endif

// ============================================================
// EXAMPLE: CORE MODULE WITH HOST KV
// ============================================================
/*
// Declare your namespaces
static const SynthiNamespaceSchemaV1 g_schemas[] = {
    { "app",       1 },  // Main app state, schema version 1
    { "settings",  1 },  // User settings
};

SYNTHI_EXPORT uint32_t core_host_kv_schemas_len(void) {
    return sizeof(g_schemas) / sizeof(g_schemas[0]);
}

SYNTHI_EXPORT const SynthiNamespaceSchemaV1* core_host_kv_schemas(void) {
    return g_schemas;
}

// Use host context in your on_load
SYNTHI_EXPORT void* core_on_load_host(void* prev_state, const SynthiHostContextV1* host_ctx) {
    MyState* state = (MyState*)prev_state;
    if (!state) {
        state = (MyState*)malloc(sizeof(MyState));
        memset(state, 0, sizeof(MyState));
        
        // Try to restore from KV storage
        uint8_t* data;
        uint32_t len;
        if (host_ctx->kv->get_bytes(host_ctx, "app", "state", &data, &len) == SYNTHI_KV_OK) {
            // Deserialize your state from data
            memcpy(state, data, len < sizeof(MyState) ? len : sizeof(MyState));
            host_ctx->kv->host_free(data);
        }
    }
    
    state->renderer = host_ctx->renderer;
    return state;
}

// Save state before unload
SYNTHI_EXPORT void core_on_unload(void* state_ptr) {
    // Note: To save to KV on unload, you need to store the host_ctx pointer
    // in your state, or use on_save_state for JSON serialization instead.
}
*/

// ============================================================
// EXAMPLE: GUI MODULE WITH HOST KV
// ============================================================
/*
static const SynthiNamespaceSchemaV1 g_gui_schemas[] = {
    { "ui", 1 },  // UI state (window positions, etc.)
};

SYNTHI_EXPORT uint32_t gui_host_kv_schemas_len(void) {
    return sizeof(g_gui_schemas) / sizeof(g_gui_schemas[0]);
}

SYNTHI_EXPORT const SynthiNamespaceSchemaV1* gui_host_kv_schemas(void) {
    return g_gui_schemas;
}

SYNTHI_EXPORT void* gui_on_load_host(void* prev_state, const SynthiHostContextV1* host_ctx) {
    GuiState* state = (GuiState*)prev_state;
    if (!state) {
        state = (GuiState*)malloc(sizeof(GuiState));
        memset(state, 0, sizeof(GuiState));
        
        // Restore UI state
        uint8_t* data;
        uint32_t len;
        if (host_ctx->kv->get_bytes(host_ctx, "ui", "layout", &data, &len) == SYNTHI_KV_OK) {
            // Deserialize layout
            host_ctx->kv->host_free(data);
        }
    }
    
    state->renderer = host_ctx->renderer;
    return state;
}
*/

// ============================================================
// EXAMPLE: LEGACY MAIN MODULE WITH HOST KV
// ============================================================
/*
static const SynthiNamespaceSchemaV1 g_main_schemas[] = {
    { "game", 1 },
};

SYNTHI_EXPORT uint32_t host_kv_schemas_len(void) {
    return sizeof(g_main_schemas) / sizeof(g_main_schemas[0]);
}

SYNTHI_EXPORT const SynthiNamespaceSchemaV1* host_kv_schemas(void) {
    return g_main_schemas;
}

SYNTHI_EXPORT void* on_load_host(void* prev_state, const SynthiHostContextV1* host_ctx) {
    // Your implementation
}
*/

#ifdef __cplusplus
}
#endif

#endif // SYNTHI_HOST_KV_H
