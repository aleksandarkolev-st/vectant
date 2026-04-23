# synthi-probe

Cooperative enriched-tier library for guest programs. Ultraplan §Enriched tools, phase 2b.

## What it is

When a guest program links `synthi-probe`, it can publish semantic entities (labels, buttons, text fields) to a listening Synthi MCP agent. The agent then calls `synthi_query`, `synthi_act`, `synthi_fill_form`, etc. against real entity ids instead of grinding pixels through a vision backend.

Designed for UIs the a11y-bridge path can't read — SDL2, OpenGL, custom renderers.

## Proprietary posture

The library is distributed under the same access-control policy as the rest of the Synthi MCP:

- Source lives in the `synthi-inc/synthi-ide` repo; collaborators clone + build.
- Binary releases ship to `ghcr.io/synthi-inc/synthi-probe:<version>` alongside the header, statically linked against a recent glibc.
- Maven / npm / PyPI wrappers (Java / JS / Python) are phase-2b follow-ups once one language consumer actually asks for them.

See `PHASE_2A_DISTRIBUTION.txt` at the repo root for the full distribution rationale. The probe inherits it.

## Build

```bash
cd probe/synthi-probe
make               # build/libsynthi_probe.{a,so}
make example       # build/example_counter
```

No external dependencies beyond libc + POSIX sockets. `-std=c11`.

## Integration (C)

```c
#include <synthi_probe.h>

synthi_probe_t* p = synthi_probe_init(getenv("SYNTHI_SESSION_ID"), "my_app");

synthi_probe_entity_t button = {
    .id = "login_button",
    .role = "button",
    .name = "Log in",
    .bbox = {100, 50, 80, 24},
    .on_action = on_login_clicked,
    .user_data = my_state,
};
synthi_probe_publish(p, &button);

while (running) {
    synthi_probe_tick(p);
    /* ... guest's own event loop ... */
}

synthi_probe_shutdown(p);
```

## Wire protocol

Newline-framed JSON over `AF_UNIX/SOCK_STREAM` at `/run/synthi/probe-<session_id>.sock`. Guest and worker share a PID namespace in the worker container, so the path resolves naturally. The probe fails soft: if the socket isn't listening, `synthi_probe_tick` returns `NOT_CONNECTED` and the guest keeps running; once the worker shows up on the next tick, the probe replays every published entity so the agent sees a complete tree from word one.

| Direction | Kind | Fields |
|---|---|---|
| guest → worker | `hello` | `api`, `session_id`, `program` |
| guest → worker | `publish` | `id`, `role`, `name`, `value`, `parent`, `bbox` |
| guest → worker | `remove` | `id` |
| guest → worker | `metric` | `name`, `value`, `unit` |
| guest → worker | `heartbeat` | `ts_ms` |
| worker → guest | `act` | `id`, `request_id`, `action`, `value` |
| guest → worker | `act_result` | `request_id`, `ok`, `reason` |

Heartbeats every 5 seconds so the worker can mark the probe dead if the guest hangs.

## Thread safety

One `synthi_probe_t` per thread, or wrap calls in your own mutex. The library acquires no locks.

## What ships vs. what doesn't

- **Ships:** header, reference C implementation, example fixture, Makefile.
- **Doesn't ship (phase 2b follow-ups):**
  - JS / Java / Python wrappers.
  - Static / dynamic library releases to GHCR (just the source today).
  - The worker-side adapter that terminates the socket + bridges into the MCP's enriched-tier provider registry. That's the hookup the phase-2b enrichment work lands; the library is the guest end of the pipe.
