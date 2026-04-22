/*
 * example_counter.c — reference guest integration of synthi-probe.
 *
 * Minimal command-line fixture that publishes two entities (a button
 * and a label), ticks the probe in a loop, and increments the counter
 * whenever the MCP agent invokes the button's press action. Useful as
 * a conformance target + as the smallest thing that exercises the
 * worker's probe-socket adapter end-to-end.
 *
 * Build + run:
 *
 *   make -C probe/synthi-probe example
 *   SYNTHI_SESSION_ID=smoke ./build/example_counter
 *
 * The probe will silently no-op until the worker creates
 * /run/synthi/probe-smoke.sock — useful for dev-loop verification
 * without a full worker stack.
 */

#define _POSIX_C_SOURCE 200809L

#include "synthi_probe.h"

#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static atomic_int g_counter = 0;
static volatile sig_atomic_t g_stop = 0;

static void on_sigint(int sig) {
    (void)sig;
    g_stop = 1;
}

static bool inc_button(synthi_probe_action_t action, const char* value, void* user_data) {
    (void)value;
    (void)user_data;
    if (action == SYNTHI_PROBE_ACTION_PRESS) {
        atomic_fetch_add(&g_counter, 1);
        return true;
    }
    return false;
}

int main(void) {
    const char* sid = getenv("SYNTHI_SESSION_ID");
    if (!sid || !*sid) sid = "example";

    synthi_probe_t* p = synthi_probe_init(sid, "example_counter");
    if (!p) {
        fprintf(stderr, "synthi_probe_init failed\n");
        return 1;
    }

    signal(SIGINT, on_sigint);
    signal(SIGTERM, on_sigint);

    const synthi_probe_entity_t button = {
        .id = "inc_button",
        .role = "button",
        .name = "Increment",
        .value = NULL,
        .bbox = { .x = 100, .y = 50, .w = 80, .h = 24 },
        .states = NULL,
        .parent_id = NULL,
        .on_action = inc_button,
        .user_data = NULL,
    };
    synthi_probe_publish(p, &button);

    char last_value[32] = "0";
    while (!g_stop) {
        synthi_probe_tick(p);

        int v = atomic_load(&g_counter);
        char buf[32];
        snprintf(buf, sizeof(buf), "%d", v);
        buf[sizeof(buf) - 1] = '\0';
        if (strcmp(buf, last_value) != 0) {
            synthi_probe_entity_t label = {
                .id = "counter_label",
                .role = "label",
                .name = "Counter",
                .value = buf,
                .bbox = { .x = 120, .y = 120, .w = 40, .h = 32 },
                .states = NULL,
                .parent_id = NULL,
                .on_action = NULL,
                .user_data = NULL,
            };
            synthi_probe_publish(p, &label);
            /* buf is shorter than last_value's cap; plain assignment-sized copy is fine. */
            memcpy(last_value, buf, strlen(buf) + 1);
        }

        struct timespec ts = { .tv_sec = 0, .tv_nsec = 16 * 1000 * 1000 }; /* ~60 Hz */
        nanosleep(&ts, NULL);
    }

    synthi_probe_remove(p, "inc_button");
    synthi_probe_remove(p, "counter_label");
    synthi_probe_shutdown(p);
    return 0;
}
