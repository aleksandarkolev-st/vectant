// Synthi MCP fixture: animated particle demo (for spike E2b).
//
// MONOLITHIC user source. The worker's AI split turns this into the
// 4-file HMR layout at runtime; we ship only the single input file.
//
// Library choice is SDL2 for the same reason as ../counter/main.cpp —
// most-stable compile path; not a semantic constraint on the test.
//
// Observable signal for E2b (region-pHash vs full-frame vs agent_side):
//
//   - The particle field fills most of the window and moves every frame.
//     A full-frame pHash of two consecutive screenshots will differ even
//     with no edit — full-frame cache cannot be used as an identity signal.
//
//   - A static UI panel anchored in the top-right corner (650,20,130,60)
//     is driven by `panel_r/panel_g/panel_b` only — it does NOT move
//     between frames, so its region-pHash is stable within an "edit
//     session". Editing `panel_r` changes only the panel's hash; the
//     region cache should keep tracking the handle across 50 dispatches.
//
// E2b compares three dispatch strategies on this fixture:
//   1. Full-frame pHash cache (expected: very low hit % — particles move).
//   2. Region-pHash cache with the panel's bbox ±20% padding
//      (expected: very high hit % — only edits invalidate).
//   3. `agent_side` backend (no server cache; agent re-resolves every call).

#include <SDL2/SDL.h>
#include <cstdlib>

struct Particle {
    float x;
    float y;
    float vx;
    float vy;
};

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* win = SDL_CreateWindow(
        "Synthi Particles",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        800, 600, 0
    );
    SDL_Renderer* ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    const int N = 200;
    Particle p[N];
    for (int i = 0; i < N; i++) {
        p[i].x = (float)(rand() % 800);
        p[i].y = (float)(rand() % 600);
        p[i].vx = ((float)(rand() % 400) - 200.0f) / 100.0f;
        p[i].vy = ((float)(rand() % 400) - 200.0f) / 100.0f;
    }

    // The spike edits these three lines. Baseline = (200,80,60);
    // post-edit flips one channel hard so the panel handle's region-pHash
    // invalidates cleanly.
    Uint8 panel_r = 200;
    Uint8 panel_g = 80;
    Uint8 panel_b = 60;

    SDL_Event ev;
    bool quit = false;
    while (!quit) {
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) quit = true;
        }

        SDL_SetRenderDrawColor(ren, 20, 20, 40, 255);
        SDL_RenderClear(ren);

        // Animated particle field (moves every frame → makes full-frame
        // pHash noisy).
        SDL_SetRenderDrawColor(ren, 255, 255, 255, 255);
        for (int i = 0; i < N; i++) {
            p[i].x += p[i].vx;
            p[i].y += p[i].vy;
            if (p[i].x < 0 || p[i].x > 800) p[i].vx = -p[i].vx;
            if (p[i].y < 0 || p[i].y > 600) p[i].vy = -p[i].vy;
            SDL_Rect r = {(int)p[i].x, (int)p[i].y, 3, 3};
            SDL_RenderFillRect(ren, &r);
        }

        // Static UI panel (doesn't move between frames → stable
        // region-pHash for the handle cache).
        SDL_Rect panel = {650, 20, 130, 60};
        SDL_SetRenderDrawColor(ren, panel_r, panel_g, panel_b, 255);
        SDL_RenderFillRect(ren, &panel);

        SDL_RenderPresent(ren);
        SDL_Delay(16);
    }

    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
