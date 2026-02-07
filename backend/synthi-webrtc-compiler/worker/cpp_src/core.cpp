#include "plugin_abi.h"
// Cache bust: 2026-02-03-02-FINAL
#include <stdlib.h>
#include <stdio.h>

// Global pointer to state (standard pattern for singleton core)
static CoreState* global_core_state = NULL;

extern "C" {

// ============================================================
// SINGLE EXPORT ABI (V2.1)
// ============================================================

bool core_init(void* state_ptr, const RunnerApi* host) {
    fprintf(stderr, "[Core] V2 Init. State: %p\n", state_ptr);
    global_core_state = (CoreState*)state_ptr;
    
    global_core_state->magic = CORE_STATE_MAGIC;
    global_core_state->struct_size = sizeof(CoreState);
    global_core_state->abi_version = SYNTHI_CORE_ABI_VERSION;
    global_core_state->running = 1;
    global_core_state->paused = 0;
    
    return true;
}

// Static V2 API Table
static const HotApi HOT_API = {
    .struct_size = sizeof(HotApi),
    .api_version = HOT_API_VERSION,
    .state_version = 1,
    .state_size_bytes = sizeof(CoreState),
    .state_align_bytes = 16,
    .init = core_init,
    // tick, shutdown, etc. can be added
};

const HotApi* hot_get_api(void) {
    return &HOT_API;
}

// ============================================================
// LEGACY COMPATIBILITY
// ============================================================

// API Implementations
CoreState* api_get_state(void) {
    return global_core_state;
}

void api_pause(void) {
    if (global_core_state) global_core_state->paused = 1;
}

void api_resume(void) {
    if (global_core_state) global_core_state->paused = 0;
}

static CoreAPI global_api = {
    .version = 1,
    .get_state = api_get_state,
    .pause = api_pause,
    .resume = api_resume
};

CoreAPI* core_get_api(void) {
    return &global_api;
}

// Required: Initialize State
CoreState* core_on_load(CoreState* prev, void* host_ctx) {
    fprintf(stderr, "[Core] DEBUG: Loading fresh core module V3-DualABI\n");
    if (prev) {
        fprintf(stderr, "[Core] Reloading... keeping existing state.\n");
        global_core_state = prev;
        return prev;
    }

    fprintf(stderr, "[Core] Initializing fresh state (Legacy Alloc).\n");
    CoreState* state = (CoreState*)malloc(sizeof(CoreState));
    if (!state) return NULL;

    state->magic = CORE_STATE_MAGIC;
    state->struct_size = sizeof(CoreState);
    state->abi_version = SYNTHI_CORE_ABI_VERSION;
    state->running = 1;
    state->paused = 0;

    global_core_state = state;
    return state;
}

// Required: Update Loop
void core_on_update(CoreState* state, double dt) {
    // Basic simulation logic could go here
    // For this example, we do nothing
}

// Required: Unload
void core_on_unload(CoreState* state) {
    fprintf(stderr, "[Core] Unloaded.\n");
    // Usually we don't free state here if we want to support reload,
    // but the runner manages the pointer transition.
}

} // extern "C"
