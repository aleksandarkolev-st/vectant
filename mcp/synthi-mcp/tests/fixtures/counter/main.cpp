// Synthi MCP fixture: static counter (for spike E1 / E2 / E3 / E4).
//
// MONOLITHIC user source. The worker's AI split turns this into
//   shared.h + core.cpp + gui.cpp + host_runner.cpp
// at runtime via POST /refactor/split/verified — we do NOT ship a split.
//
// Library here is SDL2 purely because that's the most-stable compile
// path in Synthi today; UNIVERSAL_SPLIT_PROMPT accepts GLFW, SFML,
// raylib, custom engines, and plain console apps. If you want a
// cross-library sanity check, drop in a GLFW/SFML variant of this
// file with the same observable behavior and re-run the spike — the
// harness does not assume SDL2.
//
// Observable signal for the spike:
//   - Background RGB is a function of `counter` (see derive_bg).
//   - The white square's position is a function of `counter`.
// Editing `counter`'s initial value changes both → post-HMR frame
// is pHash-different from the baseline. Tests assert pHash distance
// > 4 from the pre-edit screenshot.

#include <SDL2/SDL.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* win = SDL_CreateWindow(
        "Synthi Counter",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        800, 600, 0
    );
    SDL_Renderer* ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    // The spike edits this line. Baseline = 0; post-edit = 10 (or whatever).
    int counter = 0;

    SDL_Event ev;
    bool quit = false;
    while (!quit) {
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) quit = true;
        }

        // Background color is a function of `counter`. Any prime-multiplied
        // derivation works; we use (17/53/97) so the visible delta is large
        // even for single-digit counter changes.
        Uint8 r = (Uint8)((counter * 17) & 0xFF);
        Uint8 g = (Uint8)((counter * 53) & 0xFF);
        Uint8 b = (Uint8)((counter * 97) & 0xFF);
        SDL_SetRenderDrawColor(ren, r, g, b, 255);
        SDL_RenderClear(ren);

        // White square whose top-left is also a function of `counter`.
        SDL_Rect rect = {
            50 + (counter * 20) % 700,
            100 + (counter * 30) % 400,
            80, 80
        };
        SDL_SetRenderDrawColor(ren, 255, 255, 255, 255);
        SDL_RenderFillRect(ren, &rect);

        SDL_RenderPresent(ren);
        SDL_Delay(16);
    }

    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
