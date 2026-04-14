// Phase 7 corpus — FMOD + SDL2 (hot-reload hostile)
// Mitigation 4A: FMOD has persistent global audio state that desyncs
// on dlclose swap. AI should set hot_reload_mode=process_restart.
// Expected: runner_link_flags contains both -lSDL2 and -lfmod.
#include <SDL2/SDL.h>
#include <fmod.h>
#include <stdio.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
    SDL_Window* win = SDL_CreateWindow("FMOD HMR Test", 0, 0, 800, 600, 0);

    FMOD_SYSTEM* fmod = nullptr;
    FMOD_System_Create(&fmod, FMOD_VERSION);
    FMOD_System_Init(fmod, 32, FMOD_INIT_NORMAL, nullptr);

    FMOD_SOUND* sound = nullptr;
    FMOD_System_CreateSound(fmod, "beep.wav", FMOD_DEFAULT, nullptr, &sound);

    bool running = true;
    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            if (e.type == SDL_QUIT) running = false;
            if (e.type == SDL_KEYDOWN) {
                FMOD_System_PlaySound(fmod, sound, nullptr, false, nullptr);
            }
        }
        FMOD_System_Update(fmod);
        SDL_Delay(16);
    }

    FMOD_Sound_Release(sound);
    FMOD_System_Release(fmod);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
