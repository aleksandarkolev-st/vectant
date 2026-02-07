#ifndef PLUGIN_ABI_H
#define PLUGIN_ABI_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <SDL2/SDL.h>

#ifdef __cplusplus
extern "C" {
#endif

// === ABI Version Constants ===
#define SYNTHI_CORE_ABI_VERSION 1
#define SYNTHI_GUI_ABI_VERSION 1
#define HOT_API_VERSION 2

// Magic numbers for struct validation
#define CORE_STATE_MAGIC 0xDEADBEEF
#define GUI_STATE_MAGIC  0x60108EEF

// Forward declaration
typedef void* StatePtr;

// === Runner API (Host Services) ===
typedef struct {
    uint32_t struct_size;
    uint32_t api_version;
    void (*log)(uint32_t level, const uint8_t* msg, size_t len);
    uint64_t (*get_time_ns)(void);
    size_t _reserved[8];
} RunnerApi;

// === Event Structure ===
typedef struct {
    uint32_t kind; 
    uint32_t a;    
    uint32_t b;    
    uint32_t c;    
    const void* payload_ptr;
    size_t payload_len;
} Event;

// === Function Pointers ===
typedef bool (*InitFn)(void* state, const RunnerApi* host);
typedef void (*ShutdownFn)(void* state, const RunnerApi* host);
typedef void (*TickFn)(void* state, const RunnerApi* host, float dt);
typedef void (*RenderFn)(void* state, const RunnerApi* host);
typedef void (*EventFn)(void* state, const Event* e, const RunnerApi* host);
typedef size_t (*SaveSizeFn)(const void* state, uint32_t state_version, const RunnerApi* host);
typedef bool (*SaveWriteMsgpackFn)(const void* state, uint32_t state_version, const RunnerApi* host, uint8_t* out, size_t out_cap, size_t* out_written);
typedef bool (*SaveWriteJsonFn)(const void* state, uint32_t state_version, const RunnerApi* host, uint8_t* out, size_t out_cap, size_t* out_written);
typedef bool (*MigrateFn)(const void* old_blob, uint32_t old_ver, void* new_blob, uint32_t new_ver, const RunnerApi* host, const uint8_t* old_msgpack, size_t old_msgpack_len, const uint8_t* old_json, size_t old_json_len);

// V2.1 Additions
typedef bool (*CanReuseStateFn)(uint64_t old_fingerprint, uint64_t new_fingerprint, uint64_t old_semantic_hash);
typedef uint64_t (*GetSemanticHashFn)(void);
typedef const char* (*GetStateTypeIdFn)(void);
typedef uint64_t (*GetLayoutHashFn)(void);
typedef bool (*EnterQuiescenceFn)(void* state, const RunnerApi* host, uint32_t timeout_ms);
typedef void (*ExitQuiescenceFn)(void* state, const RunnerApi* host);
typedef struct {
    uint32_t timers_stopped;
    uint32_t callbacks_unregistered;
    uint32_t threads_joined;
    uint32_t queue_items_drained;
    uint64_t quiesce_time_us;
    const char* error_message;
} QuiescenceReport;
typedef bool (*GetQuiescenceReportFn)(const void* state, const RunnerApi* host, QuiescenceReport* out_report);

// === HotApi STRUCT ===
typedef struct {
    // --- Header ---
    uint32_t struct_size;       
    uint32_t api_version;       
    uint32_t state_version;     
    uint64_t abi_fingerprint;   
    size_t state_size_bytes;    
    size_t state_align_bytes;   
    size_t state_min_size_bytes;

    // --- Lifecycle ---
    InitFn init;
    ShutdownFn shutdown;
    TickFn tick;
    RenderFn render;
    EventFn event;
    MigrateFn migrate;

    // --- Serialization ---
    SaveSizeFn save_state_msgpack_size;
    SaveWriteMsgpackFn save_state_msgpack_write;
    SaveSizeFn save_state_json_size;
    SaveWriteJsonFn save_state_json_write;

    // --- V2.1 Additions ---
    uint64_t semantic_hash;
    CanReuseStateFn can_reuse_state;
    GetSemanticHashFn get_semantic_hash;
    GetStateTypeIdFn get_state_type_id;
    GetLayoutHashFn get_layout_hash;
    EnterQuiescenceFn enter_quiescence;
    ExitQuiescenceFn exit_quiescence;
    GetQuiescenceReportFn get_quiescence_report;
    const char* error_message;

    size_t _reserved[4];
} HotApi;

// === State Structures ===

// CoreState (owned by core.so)
typedef struct CoreState {
    // === ABI HEADER ===
    uint32_t magic;           // CORE_STATE_MAGIC
    uint32_t struct_size;     // sizeof(CoreState)
    uint32_t abi_version;     // SYNTHI_CORE_ABI_VERSION
    
    // === RUNTIME FLAGS ===
    int running;              
    int paused;               
} CoreState;

// GuiState (owned by gui.so)
typedef struct GuiState {
    // === ABI HEADER ===
    uint32_t magic;           // GUI_STATE_MAGIC
    uint32_t struct_size;     // sizeof(GuiState)
    uint32_t abi_version;     // SYNTHI_GUI_ABI_VERSION
    
    // === RENDERER (provided by runner) ===
    SDL_Renderer* renderer;   
    
    // === CORE REFERENCE ===
    CoreState* core;
    
    // === VIEW STATE ===
    int x;
    int dx;
} GuiState;

// === CoreAPI (vtable exported by core) ===
typedef struct CoreAPI {
    uint32_t version;                      
    CoreState* (*get_state)(void);         
    void (*pause)(void);                   
    void (*resume)(void);                  
} CoreAPI;

#ifdef __cplusplus
}
#endif

#endif // PLUGIN_ABI_H
