/*
 * synthi_probe.h — C interface for the cooperative enriched-tier probe.
 *
 * Ultraplan §Enriched tools, phase 2b. Guest programs that want to
 * expose semantic labels + actions to a Synthi MCP agent link this
 * library and publish entities. The MCP's enriched-tier provider
 * reads them over a per-session Unix domain socket at
 * /run/synthi/probe-<session_id>.sock and answers synthi_query /
 * synthi_act / synthi_fill_form / synthi_get_labels against that tree.
 *
 * Opinionated design choices:
 *
 *   - No network surface. Unix domain socket only; guest and worker
 *     share a PID namespace in the worker container.
 *   - No external deps. Only libc + the POSIX socket API. Ships as a
 *     single header + single source file; link statically for
 *     single-binary deployment.
 *   - Non-blocking. synthi_probe_tick() is safe to call from the
 *     guest's event-loop; it returns quickly whether or not the
 *     worker is attached.
 *   - Fail-soft. If the socket isn't reachable, the probe silently
 *     degrades to a no-op — the guest program keeps running.
 *
 * Thread safety: one synthi_probe_t handle per thread, or wrap in
 * your own mutex. The library itself does not acquire locks.
 */

#ifndef SYNTHI_PROBE_H
#define SYNTHI_PROBE_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SYNTHI_PROBE_API_VERSION 1

typedef struct synthi_probe synthi_probe_t;

typedef struct synthi_probe_bbox {
    int32_t x;
    int32_t y;
    int32_t w;
    int32_t h;
} synthi_probe_bbox_t;

typedef enum synthi_probe_action {
    SYNTHI_PROBE_ACTION_PRESS   = 1,
    SYNTHI_PROBE_ACTION_SELECT  = 2,
    SYNTHI_PROBE_ACTION_FOCUS   = 3,
    SYNTHI_PROBE_ACTION_TOGGLE  = 4,
    SYNTHI_PROBE_ACTION_FILL    = 5, /* carries a `value` payload */
} synthi_probe_action_t;

/* Callback invoked when the MCP agent calls synthi_act / synthi_fill_form
 * targeting this entity. `value` is non-NULL only for FILL actions.
 * Return true if the action was honored; the library will echo that
 * back to the MCP so the tool call's per-entity {ok, reason} is accurate.
 */
typedef bool (*synthi_probe_action_cb)(
    synthi_probe_action_t action,
    const char* value,            /* NULL unless action == FILL */
    void* user_data
);

typedef struct synthi_probe_entity {
    const char* id;                /* stable per-session identifier */
    const char* role;              /* "button" | "text_field" | "label" | "spinner" | ... */
    const char* name;              /* accessible name (short, user-facing) */
    const char* value;             /* current text value; NULL if not applicable */
    synthi_probe_bbox_t bbox;      /* in frame coordinates */
    const char* const* states;     /* NULL-terminated array of state strings, or NULL */
    const char* parent_id;         /* NULL for root entities */
    synthi_probe_action_cb on_action;
    void* user_data;
} synthi_probe_entity_t;

typedef enum synthi_probe_status {
    SYNTHI_PROBE_OK                     = 0,
    SYNTHI_PROBE_ERR_ALLOC              = -1,
    SYNTHI_PROBE_ERR_SOCKET             = -2,
    SYNTHI_PROBE_ERR_CONNECT            = -3,
    SYNTHI_PROBE_ERR_WRITE              = -4,
    SYNTHI_PROBE_ERR_INVALID_ARG        = -5,
    SYNTHI_PROBE_ERR_NOT_CONNECTED      = -6,
    SYNTHI_PROBE_ERR_ENTITY_NOT_FOUND   = -7,
} synthi_probe_status_t;

/* Lifecycle ------------------------------------------------------------ */

/* Allocate and initialize a probe handle. `session_id` must match the
 * Synthi session id the worker knows about; the library derives the
 * socket path `/run/synthi/probe-<session_id>.sock`. `program_name`
 * is a human-readable tag (e.g., "counter_sdl2") included in the
 * initial hello message.
 *
 * Returns NULL on allocation failure. A non-NULL handle is usable
 * even when the worker isn't listening — synthi_probe_publish /
 * synthi_probe_tick degrade gracefully.
 */
synthi_probe_t* synthi_probe_init(const char* session_id, const char* program_name);

/* Override the default socket path. Rarely needed — only when running
 * the probe outside the worker container against a custom MCP setup.
 * Must be called before synthi_probe_tick() attaches the socket.
 */
synthi_probe_status_t synthi_probe_set_socket_path(synthi_probe_t* probe, const char* path);

/* Release all resources. Idempotent on NULL. */
void synthi_probe_shutdown(synthi_probe_t* probe);

/* Entities ------------------------------------------------------------- */

/* Publish or update an entity. The library copies the passed struct +
 * strings into its own storage; `entity` does not need to outlive the
 * call. Calling publish twice with the same `id` is an update.
 */
synthi_probe_status_t synthi_probe_publish(synthi_probe_t* probe, const synthi_probe_entity_t* entity);

/* Remove an entity by id. Returns ENTITY_NOT_FOUND if unknown. */
synthi_probe_status_t synthi_probe_remove(synthi_probe_t* probe, const char* entity_id);

/* Emit a custom metric. MCP surfaces this through synthi_get_metrics. */
synthi_probe_status_t synthi_probe_emit_metric(
    synthi_probe_t* probe,
    const char* name,
    double value,
    const char* unit /* may be NULL */
);

/* Pump ----------------------------------------------------------------- */

/* Drive the probe's IO state machine. Call once per guest event-loop
 * iteration (typical ~30–60Hz is fine). Non-blocking; returns
 * OK when idle, ERR_NOT_CONNECTED when the socket is down (the library
 * will try to reattach on the next tick), or a specific error code.
 *
 * The callback attached to each entity fires synchronously from inside
 * synthi_probe_tick when the MCP invokes an action — wrap your own
 * event-loop's state appropriately.
 */
synthi_probe_status_t synthi_probe_tick(synthi_probe_t* probe);

/* Inspect whether the probe is currently connected to a worker. Useful
 * for guest programs that want to log "running under agent" once. */
bool synthi_probe_is_connected(const synthi_probe_t* probe);

/* The library's view of the currently-agreed wire protocol version.
 * Always equal to SYNTHI_PROBE_API_VERSION for this build. */
int synthi_probe_wire_version(void);

#ifdef __cplusplus
}
#endif

#endif /* SYNTHI_PROBE_H */
