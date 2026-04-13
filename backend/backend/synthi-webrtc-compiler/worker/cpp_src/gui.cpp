#include "plugin_abi.h"
#include <stdlib.h>
#include <stdio.h>
#include <SDL2/SDL.h>

extern "C" {

// ============================================================
// SINGLE EXPORT ABI (V2.1) IMPLEMENTATION
// ============================================================

bool gui_init(void* state_ptr, const RunnerApi* host) {
    fprintf(stderr, "[GUI] V2 Init called. State: %p\n", state_ptr);
    GuiState* state = (GuiState*)state_ptr;
    
    // Initialize Header
    state->magic = GUI_STATE_MAGIC;
    state->struct_size = sizeof(GuiState);
    state->abi_version = SYNTHI_GUI_ABI_VERSION;
    
    // Initialize Content
    state->x = 0;
    state->dx = 5;
    state->renderer = NULL; // Waiting for render call or legacy load
    state->core = NULL;
    
    return true;
}

void gui_render(void* state_ptr, const RunnerApi* host) {
    GuiState* state = (GuiState*)state_ptr;
    if (!state || !state->renderer) return;

    SDL_Renderer* ren = state->renderer;

    // Update
    state->x += state->dx;
    if (state->x > 590 || state->x < 0) state->dx = -state->dx;

    // Draw
    SDL_SetRenderDrawColor(ren, 255, 255, 255, 255);
    SDL_RenderClear(ren);

    SDL_Rect rect = {state->x, 200, 50, 50};
    SDL_SetRenderDrawColor(ren, 0, 255, 0, 255); // GREEN for V2
    SDL_RenderFillRect(ren, &rect);
}

// Static V2 API Table
static const HotApi HOT_API = {
    .struct_size = sizeof(HotApi),
    .api_version = HOT_API_VERSION,
    .state_version = 1,
    .abi_fingerprint = 0, // TODO: Compute if needed
    .state_size_bytes = sizeof(GuiState),
    .state_align_bytes = 16, // Safe alignment
    .state_min_size_bytes = 0,
    .init = gui_init,
    .render = gui_render,
    // Other fields zeroed
};

const HotApi* hot_get_api(void) {
    return &HOT_API;
}

// ============================================================
// LEGACY COMPATIBILITY (Still called by runner for execution)
// ============================================================

GuiState* gui_on_load(GuiState* prev, void* host_renderer, CoreAPI* api) {
    fprintf(stderr, "[GUI] DEBUG: gui_on_load (Legacy Wrapper). Renderer: %p\n", host_renderer);
    
    // CRITICAL FIX: DO NOT allocating memory if prev is null implies fresh start,
    // BUT checking V2 init flow, runner allocates.
    // However, for the specific "gui_on_load" path, the runner EXPECTS return.
    // If the runner allocated state via V2, 'prev' might be that state?
    // Actually, 'gui_on_load' signature implies WE return the pointer.
    // If we use V2, we shouldn't be here? 
    // Wait, runner.rs calls gui_on_load explicitly.
    
    GuiState* state = prev;
    if (!state) {
         // If runner didn't provide state (legacy mode), we MUST malloc
         // This contradicts V2 rules but matches legacy runner code path.
         fprintf(stderr, "[GUI] Allocating legacy state...\n");
         state = (GuiState*)malloc(sizeof(GuiState));
         state->x = 0; state->dx = 5;
    }
    
    state->magic = GUI_STATE_MAGIC;
    state->struct_size = sizeof(GuiState);
    state->abi_version = SYNTHI_GUI_ABI_VERSION;
    state->renderer = (SDL_Renderer*)host_renderer;
    
    if (api) state->core = api->get_state();
    
    return state;
}

void gui_on_render(GuiState* state) {
    // Forward to V2 logic
    if (state) {
        // Create dummy runner api if needed, or just call logic
        // For simplicity, inline logic here to ensure it works
        SDL_Renderer* ren = state->renderer;
        if (!ren) return;
        
        state->x += state->dx;
        if (state->x > 590 || state->x < 0) state->dx = -state->dx;

        SDL_SetRenderDrawColor(ren, 0, 0, 0, 255); // Black BG
        SDL_RenderClear(ren);

        SDL_Rect rect = {state->x, 200, 50, 50};
        SDL_SetRenderDrawColor(ren, 0, 0, 255, 255); // BLUE for Legacy
        SDL_RenderFillRect(ren, &rect);
    }
}

void gui_on_unload(GuiState* state) {
    // No-op
}

} // extern "C"
