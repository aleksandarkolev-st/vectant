// Synthi MCP fixture: canvas with one button baseline, HMR test adds
// a second one.
//
// Why this fixture exists alongside counter/main.cpp:
//   The counter fixture edits a `main()` local's initializer. After a
//   Promoted HMR patch, the binary is new but main() is already running
//   with `counter = 0` on its stack — the patched initializer never
//   re-executes, so rendered pixels are unchanged. pHash-assertion flaky.
//
//   This fixture edits RENDERING CODE that runs every frame. The
//   harness inserts draw calls for a second button at the
//   SECOND_BUTTON_ANCHOR marker. After HMR applies the patched module,
//   the very next SDL_RenderPresent draws both buttons — visible,
//   deterministic, no state-migration assumption.
//
// Before edit (baseline):
//   dark-grey background + one blue button
//
// After edit:
//   dark-grey background + blue button + red button.

#include <SDL2/SDL.h>

int main() {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* win = SDL_CreateWindow(
        "Synthi Button Fixture",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        800, 600, 0
    );
    SDL_Renderer* ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    SDL_Event ev;
    bool quit = false;
    while (!quit) {
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) quit = true;
        }

        // Background: dark grey.
        SDL_SetRenderDrawColor(ren, 32, 32, 32, 255);
        SDL_RenderClear(ren);

        // Blue button — present in both baseline and post-edit frames.
        // Acts as the control: if this disappears after HMR, something
        // other than our edit broke.
        SDL_Rect blue_button = { 150, 120, 500, 160 };
        SDL_SetRenderDrawColor(ren, 40, 120, 220, 255);
        SDL_RenderFillRect(ren, &blue_button);

        // SECOND_BUTTON_ANCHOR
        // ↑ live-test.mjs replaces this marker with three SDL calls that
        //   draw a red button at (150, 320, 500, 160). Keep the marker
        //   on its own line; the regex in the harness matches the whole
        //   line including the leading whitespace.

        SDL_RenderPresent(ren);
        SDL_Delay(16);
    }

    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
