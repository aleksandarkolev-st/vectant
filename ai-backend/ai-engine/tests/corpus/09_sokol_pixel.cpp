// Phase 7 corpus — sokol (minimal, header-only graphics)
// Tests a single-header library. sokol is typically pulled in as
// #include + a single .c file that defines SOKOL_IMPL. Expected:
// AI should recognise this as header-only and note that in
// confidence.notes. runner_link_flags may be minimal (X11, GL, m, dl).
#define SOKOL_IMPL
#include <sokol_gfx.h>
#include <sokol_app.h>
#include <sokol_glue.h>

static sg_pass_action pass_action = {};

static void init() {
    sg_setup((sg_desc){
        .context = sapp_sgcontext(),
    });
    pass_action.colors[0] = (sg_color_attachment_action){
        .action = SG_ACTION_CLEAR,
        .value = { 0.08f, 0.08f, 0.15f, 1.0f },
    };
}

static void frame() {
    sg_begin_default_pass(&pass_action, sapp_width(), sapp_height());
    sg_end_pass();
    sg_commit();
}

static void cleanup() {
    sg_shutdown();
}

int main() {
    sapp_desc d = {};
    d.init_cb = init;
    d.frame_cb = frame;
    d.cleanup_cb = cleanup;
    d.width = 800;
    d.height = 600;
    d.window_title = "Sokol HMR Test";
    sapp_run(&d);
    return 0;
}
