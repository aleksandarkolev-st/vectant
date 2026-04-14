// Phase 7 corpus — SDL2 happy path
// Expected: runner_link_flags contains -lSDL2, hot_reload_mode=swap,
// confidence.runner_synthesis=high, host_runner.cpp non-empty.
#include <SDL2/SDL.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* win = SDL_CreateWindow("HMR Test", 0, 0, 800, 600, 0);
    SDL_Renderer* r = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    bool running = true;
    int frame = 0;

    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = false;
        }

        frame++;

        SDL_SetRenderDrawColor(r, 20, 20, 40, 255);
        SDL_RenderClear(r);

        SDL_Rect btn = {50, 50, 200, 60};
        SDL_SetRenderDrawColor(r, 60, 120, 220, 255);
        SDL_RenderFillRect(r, &btn);

        SDL_RenderPresent(r);
        SDL_Delay(16);
    }

    SDL_DestroyRenderer(r);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
