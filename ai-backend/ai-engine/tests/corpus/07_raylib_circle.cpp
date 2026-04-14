// Phase 7 corpus — raylib (self-contained library, minimal deps)
// Tests a self-contained modern library. Expected: runner_link_flags
// contains -lraylib, hot_reload_mode=swap, confidence high.
#include <raylib.h>

int main() {
    InitWindow(800, 600, "Raylib HMR Test");
    SetTargetFPS(60);

    int frame = 0;

    while (!WindowShouldClose()) {
        frame++;

        BeginDrawing();
        ClearBackground((Color){20, 20, 40, 255});

        DrawCircle(400, 300, 80.0f, (Color){60, 120, 220, 255});
        DrawText("Raylib HMR", 10, 10, 20, RAYWHITE);

        EndDrawing();
    }

    CloseWindow();
    return 0;
}
