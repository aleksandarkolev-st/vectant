// Phase 7 corpus — custom engine with explicit // LINK: hint
// Mitigation 1A: zero-day framework. AI should COPY the hint into the
// manifest verbatim and set confidence.link_flags=high because the user
// told us what they need.
// LINK: -lmy_engine -L/opt/my_engine/lib -I/opt/my_engine/include
// REQUIRES: libmy-engine-dev
#include <my_engine/engine.h>
#include <my_engine/window.h>

int main() {
    my_engine::Engine eng;
    eng.init();
    my_engine::Window w(800, 600, "MyEngine Test");

    while (w.is_open()) {
        w.poll_events();
        eng.update();
        w.clear(0x202040);
        w.draw_rect(100, 100, 200, 60, 0x3c78dc);
        w.present();
    }

    eng.shutdown();
    return 0;
}
