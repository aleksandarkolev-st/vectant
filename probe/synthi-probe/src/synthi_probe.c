/*
 * synthi_probe.c — reference implementation of the cooperative probe.
 *
 * Wire protocol (newline-framed JSON over AF_UNIX/SOCK_STREAM):
 *
 *   client -> worker   {"kind":"hello","api":1,"session_id":"...","program":"..."}
 *   client -> worker   {"kind":"publish","id":"...","role":"...","name":"...","bbox":{...},...}
 *   client -> worker   {"kind":"remove","id":"..."}
 *   client -> worker   {"kind":"metric","name":"...","value":1.5,"unit":"ms"}
 *   client -> worker   {"kind":"heartbeat","ts_ms":1745...}
 *
 *   worker -> client   {"kind":"act","id":"...","request_id":"...","action":"press","value":null}
 *   client -> worker   {"kind":"act_result","request_id":"...","ok":true,"reason":null}
 *
 * Messages are line-delimited (no embedded newlines within a message).
 * The reference implementation emits a compact, escape-minimal JSON —
 * no dynamic JSON library dep.
 *
 * Build:
 *
 *   cc -std=c11 -O2 -Wall -Wextra -fPIC \
 *       -Iinclude -c src/synthi_probe.c -o build/synthi_probe.o
 *   ar rcs build/libsynthi_probe.a build/synthi_probe.o
 *
 * No external dependencies beyond libc + POSIX sockets.
 */

#define _POSIX_C_SOURCE 200809L

#include "synthi_probe.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define SP_DEFAULT_SOCKET_PREFIX "/run/synthi/probe-"
#define SP_RX_BUFFER_SIZE        4096
#define SP_MAX_ENTITIES          512
#define SP_HEARTBEAT_INTERVAL_MS 5000

typedef struct sp_entity_slot {
    bool used;
    char* id;
    char* role;
    char* name;
    char* value;
    char* parent_id;
    synthi_probe_bbox_t bbox;
    synthi_probe_action_cb on_action;
    void* user_data;
} sp_entity_slot_t;

struct synthi_probe {
    int fd;                                 /* -1 when disconnected */
    char* socket_path;
    char* session_id;
    char* program_name;
    int64_t last_heartbeat_ms;
    char rx_buf[SP_RX_BUFFER_SIZE];
    size_t rx_len;
    sp_entity_slot_t entities[SP_MAX_ENTITIES];
};

/* ---- small string helpers (no external deps) ------------------------ */

static char* sp_strdup(const char* s) {
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char* out = (char*)malloc(n);
    if (out) memcpy(out, s, n);
    return out;
}

static int64_t sp_now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* Encode a JSON-safe quoted string around `s`. Returns a malloc'd copy
 * including the surrounding quotes; caller free()s. */
static char* sp_json_str(const char* s) {
    if (!s) return sp_strdup("null");
    size_t cap = strlen(s) + 3;
    char* out = (char*)malloc(cap);
    if (!out) return NULL;
    size_t pos = 0;
    out[pos++] = '"';
    for (const char* p = s; *p; p++) {
        if (pos + 7 >= cap) {
            cap *= 2;
            char* grown = (char*)realloc(out, cap);
            if (!grown) { free(out); return NULL; }
            out = grown;
        }
        unsigned char c = (unsigned char)*p;
        switch (c) {
            case '"':  out[pos++] = '\\'; out[pos++] = '"';  break;
            case '\\': out[pos++] = '\\'; out[pos++] = '\\'; break;
            case '\b': out[pos++] = '\\'; out[pos++] = 'b';  break;
            case '\f': out[pos++] = '\\'; out[pos++] = 'f';  break;
            case '\n': out[pos++] = '\\'; out[pos++] = 'n';  break;
            case '\r': out[pos++] = '\\'; out[pos++] = 'r';  break;
            case '\t': out[pos++] = '\\'; out[pos++] = 't';  break;
            default:
                if (c < 0x20) {
                    pos += (size_t)snprintf(out + pos, cap - pos, "\\u%04x", c);
                } else {
                    out[pos++] = (char)c;
                }
        }
    }
    out[pos++] = '"';
    out[pos] = '\0';
    return out;
}

/* ---- socket IO ------------------------------------------------------ */

static int sp_try_connect(synthi_probe_t* p) {
    if (p->fd >= 0) return SYNTHI_PROBE_OK;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return SYNTHI_PROBE_ERR_SOCKET;
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) { close(fd); return SYNTHI_PROBE_ERR_SOCKET; }
    if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) { close(fd); return SYNTHI_PROBE_ERR_SOCKET; }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, p->socket_path, sizeof(addr.sun_path) - 1);

    if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        if (errno != EINPROGRESS && errno != EAGAIN) {
            close(fd);
            return SYNTHI_PROBE_ERR_CONNECT;
        }
    }
    p->fd = fd;

    /* Send the hello frame. */
    char* sid = sp_json_str(p->session_id ? p->session_id : "");
    char* prog = sp_json_str(p->program_name ? p->program_name : "");
    if (!sid || !prog) { free(sid); free(prog); return SYNTHI_PROBE_ERR_ALLOC; }

    char hello[512];
    int n = snprintf(
        hello, sizeof(hello),
        "{\"kind\":\"hello\",\"api\":%d,\"session_id\":%s,\"program\":%s}\n",
        SYNTHI_PROBE_API_VERSION, sid, prog
    );
    free(sid);
    free(prog);
    if (n < 0 || (size_t)n >= sizeof(hello)) return SYNTHI_PROBE_ERR_ALLOC;

    ssize_t w = send(fd, hello, (size_t)n, MSG_NOSIGNAL);
    if (w < 0 && errno != EAGAIN && errno != EINPROGRESS) {
        close(fd);
        p->fd = -1;
        return SYNTHI_PROBE_ERR_WRITE;
    }
    return SYNTHI_PROBE_OK;
}

static int sp_write_line(synthi_probe_t* p, const char* payload, size_t len) {
    if (p->fd < 0) return SYNTHI_PROBE_ERR_NOT_CONNECTED;
    ssize_t w = send(p->fd, payload, len, MSG_NOSIGNAL);
    if (w < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            /* Socket buffer full; drop this message. Probe is best-
             * effort — the guest's event loop keeps running. */
            return SYNTHI_PROBE_OK;
        }
        close(p->fd);
        p->fd = -1;
        return SYNTHI_PROBE_ERR_WRITE;
    }
    return SYNTHI_PROBE_OK;
}

/* ---- entity storage ------------------------------------------------- */

static sp_entity_slot_t* sp_find_slot(synthi_probe_t* p, const char* id) {
    for (int i = 0; i < SP_MAX_ENTITIES; i++) {
        if (p->entities[i].used && p->entities[i].id &&
            strcmp(p->entities[i].id, id) == 0) {
            return &p->entities[i];
        }
    }
    return NULL;
}

static sp_entity_slot_t* sp_alloc_slot(synthi_probe_t* p) {
    for (int i = 0; i < SP_MAX_ENTITIES; i++) {
        if (!p->entities[i].used) return &p->entities[i];
    }
    return NULL;
}

static void sp_free_slot_strings(sp_entity_slot_t* slot) {
    free(slot->id);       slot->id = NULL;
    free(slot->role);     slot->role = NULL;
    free(slot->name);     slot->name = NULL;
    free(slot->value);    slot->value = NULL;
    free(slot->parent_id); slot->parent_id = NULL;
}

/* ---- outbound serialization ---------------------------------------- */

static int sp_send_publish(synthi_probe_t* p, const sp_entity_slot_t* slot) {
    char* id = sp_json_str(slot->id);
    char* role = sp_json_str(slot->role);
    char* name = sp_json_str(slot->name);
    char* value = sp_json_str(slot->value);
    char* parent = sp_json_str(slot->parent_id);
    if (!id || !role || !name || !value || !parent) {
        free(id); free(role); free(name); free(value); free(parent);
        return SYNTHI_PROBE_ERR_ALLOC;
    }

    char buf[1024];
    int n = snprintf(
        buf, sizeof(buf),
        "{\"kind\":\"publish\",\"id\":%s,\"role\":%s,\"name\":%s,\"value\":%s,\"parent\":%s,"
        "\"bbox\":{\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d}}\n",
        id, role, name, value, parent,
        slot->bbox.x, slot->bbox.y, slot->bbox.w, slot->bbox.h
    );
    free(id); free(role); free(name); free(value); free(parent);
    if (n < 0 || (size_t)n >= sizeof(buf)) return SYNTHI_PROBE_ERR_ALLOC;
    return sp_write_line(p, buf, (size_t)n);
}

static int sp_send_remove(synthi_probe_t* p, const char* id) {
    char* jid = sp_json_str(id);
    if (!jid) return SYNTHI_PROBE_ERR_ALLOC;
    char buf[256];
    int n = snprintf(buf, sizeof(buf), "{\"kind\":\"remove\",\"id\":%s}\n", jid);
    free(jid);
    if (n < 0 || (size_t)n >= sizeof(buf)) return SYNTHI_PROBE_ERR_ALLOC;
    return sp_write_line(p, buf, (size_t)n);
}

static int sp_send_metric(synthi_probe_t* p, const char* name, double value, const char* unit) {
    char* jname = sp_json_str(name);
    char* junit = sp_json_str(unit);
    if (!jname || !junit) { free(jname); free(junit); return SYNTHI_PROBE_ERR_ALLOC; }
    char buf[256];
    int n = snprintf(
        buf, sizeof(buf),
        "{\"kind\":\"metric\",\"name\":%s,\"value\":%.6f,\"unit\":%s}\n",
        jname, value, junit
    );
    free(jname); free(junit);
    if (n < 0 || (size_t)n >= sizeof(buf)) return SYNTHI_PROBE_ERR_ALLOC;
    return sp_write_line(p, buf, (size_t)n);
}

static int sp_send_heartbeat(synthi_probe_t* p) {
    char buf[128];
    int n = snprintf(buf, sizeof(buf),
                     "{\"kind\":\"heartbeat\",\"ts_ms\":%lld}\n",
                     (long long)sp_now_ms());
    if (n < 0 || (size_t)n >= sizeof(buf)) return SYNTHI_PROBE_ERR_ALLOC;
    return sp_write_line(p, buf, (size_t)n);
}

/* ---- inbound line parser (minimal) --------------------------------- */

/* Phase-2b reference parser: the worker drives `act` requests as
 * newline-framed JSON. We don't pull in a full JSON library; we scan
 * for the three fields we care about. If the worker sends a message we
 * don't understand, we respond with ok:false. */
static void sp_extract_str(const char* src, const char* key, char* out, size_t cap) {
    out[0] = '\0';
    const char* k = strstr(src, key);
    if (!k) return;
    k = strchr(k, ':');
    if (!k) return;
    k++;
    while (*k == ' ') k++;
    if (*k != '"') return;
    k++;
    size_t pos = 0;
    while (*k && *k != '"' && pos + 1 < cap) {
        if (*k == '\\' && k[1]) { k++; }
        out[pos++] = *k++;
    }
    out[pos] = '\0';
}

static void sp_dispatch_inbound(synthi_probe_t* p, const char* line) {
    if (!strstr(line, "\"act\"")) return;
    char id[128], request_id[64], action[32], value[512];
    sp_extract_str(line, "\"id\"", id, sizeof(id));
    sp_extract_str(line, "\"request_id\"", request_id, sizeof(request_id));
    sp_extract_str(line, "\"action\"", action, sizeof(action));
    sp_extract_str(line, "\"value\"", value, sizeof(value));

    synthi_probe_action_t act = 0;
    if      (strcmp(action, "press")  == 0) act = SYNTHI_PROBE_ACTION_PRESS;
    else if (strcmp(action, "select") == 0) act = SYNTHI_PROBE_ACTION_SELECT;
    else if (strcmp(action, "focus")  == 0) act = SYNTHI_PROBE_ACTION_FOCUS;
    else if (strcmp(action, "toggle") == 0) act = SYNTHI_PROBE_ACTION_TOGGLE;
    else if (strcmp(action, "fill")   == 0) act = SYNTHI_PROBE_ACTION_FILL;

    bool ok = false;
    sp_entity_slot_t* slot = sp_find_slot(p, id);
    if (slot && slot->on_action && act != 0) {
        ok = slot->on_action(act, value[0] ? value : NULL, slot->user_data);
    }

    char* jrid = sp_json_str(request_id);
    if (!jrid) return;
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
                     "{\"kind\":\"act_result\",\"request_id\":%s,\"ok\":%s,\"reason\":null}\n",
                     jrid, ok ? "true" : "false");
    free(jrid);
    if (n > 0) sp_write_line(p, buf, (size_t)n);
}

static void sp_drain_inbound(synthi_probe_t* p) {
    if (p->fd < 0) return;
    while (1) {
        ssize_t r = recv(p->fd, p->rx_buf + p->rx_len,
                         sizeof(p->rx_buf) - p->rx_len - 1, 0);
        if (r == 0) { close(p->fd); p->fd = -1; return; }
        if (r < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;
            close(p->fd); p->fd = -1; return;
        }
        p->rx_len += (size_t)r;
        p->rx_buf[p->rx_len] = '\0';

        /* Dispatch every complete line, keep the trailing partial. */
        char* start = p->rx_buf;
        char* nl;
        while ((nl = strchr(start, '\n')) != NULL) {
            *nl = '\0';
            sp_dispatch_inbound(p, start);
            start = nl + 1;
        }
        size_t remaining = p->rx_len - (size_t)(start - p->rx_buf);
        if (remaining > 0) memmove(p->rx_buf, start, remaining);
        p->rx_len = remaining;
    }
}

/* ---- public API ----------------------------------------------------- */

synthi_probe_t* synthi_probe_init(const char* session_id, const char* program_name) {
    if (!session_id || !program_name) return NULL;
    synthi_probe_t* p = (synthi_probe_t*)calloc(1, sizeof(*p));
    if (!p) return NULL;
    p->fd = -1;
    p->last_heartbeat_ms = sp_now_ms();
    p->session_id = sp_strdup(session_id);
    p->program_name = sp_strdup(program_name);
    size_t path_cap = strlen(SP_DEFAULT_SOCKET_PREFIX) + strlen(session_id) + 8;
    p->socket_path = (char*)malloc(path_cap);
    if (!p->session_id || !p->program_name || !p->socket_path) {
        synthi_probe_shutdown(p);
        return NULL;
    }
    snprintf(p->socket_path, path_cap, "%s%s.sock", SP_DEFAULT_SOCKET_PREFIX, session_id);
    return p;
}

synthi_probe_status_t synthi_probe_set_socket_path(synthi_probe_t* p, const char* path) {
    if (!p || !path) return SYNTHI_PROBE_ERR_INVALID_ARG;
    free(p->socket_path);
    p->socket_path = sp_strdup(path);
    return p->socket_path ? SYNTHI_PROBE_OK : SYNTHI_PROBE_ERR_ALLOC;
}

void synthi_probe_shutdown(synthi_probe_t* p) {
    if (!p) return;
    if (p->fd >= 0) close(p->fd);
    free(p->socket_path);
    free(p->session_id);
    free(p->program_name);
    for (int i = 0; i < SP_MAX_ENTITIES; i++) {
        sp_free_slot_strings(&p->entities[i]);
    }
    free(p);
}

synthi_probe_status_t synthi_probe_publish(synthi_probe_t* p, const synthi_probe_entity_t* e) {
    if (!p || !e || !e->id) return SYNTHI_PROBE_ERR_INVALID_ARG;
    sp_entity_slot_t* slot = sp_find_slot(p, e->id);
    if (!slot) {
        slot = sp_alloc_slot(p);
        if (!slot) return SYNTHI_PROBE_ERR_ALLOC;
        slot->used = true;
    } else {
        sp_free_slot_strings(slot);
    }
    slot->id = sp_strdup(e->id);
    slot->role = sp_strdup(e->role ? e->role : "unknown");
    slot->name = sp_strdup(e->name ? e->name : "");
    slot->value = sp_strdup(e->value ? e->value : "");
    slot->parent_id = sp_strdup(e->parent_id ? e->parent_id : "");
    slot->bbox = e->bbox;
    slot->on_action = e->on_action;
    slot->user_data = e->user_data;
    if (!slot->id || !slot->role || !slot->name || !slot->value || !slot->parent_id) {
        sp_free_slot_strings(slot);
        slot->used = false;
        return SYNTHI_PROBE_ERR_ALLOC;
    }
    return sp_send_publish(p, slot);
}

synthi_probe_status_t synthi_probe_remove(synthi_probe_t* p, const char* id) {
    if (!p || !id) return SYNTHI_PROBE_ERR_INVALID_ARG;
    sp_entity_slot_t* slot = sp_find_slot(p, id);
    if (!slot) return SYNTHI_PROBE_ERR_ENTITY_NOT_FOUND;
    sp_free_slot_strings(slot);
    slot->used = false;
    return sp_send_remove(p, id);
}

synthi_probe_status_t synthi_probe_emit_metric(synthi_probe_t* p, const char* name, double value, const char* unit) {
    if (!p || !name) return SYNTHI_PROBE_ERR_INVALID_ARG;
    return sp_send_metric(p, name, value, unit);
}

synthi_probe_status_t synthi_probe_tick(synthi_probe_t* p) {
    if (!p) return SYNTHI_PROBE_ERR_INVALID_ARG;
    if (p->fd < 0) {
        int rc = sp_try_connect(p);
        if (rc != SYNTHI_PROBE_OK) return SYNTHI_PROBE_ERR_NOT_CONNECTED;
        /* On fresh connect, re-publish every live entity so the worker
         * has a complete picture without waiting for the guest to call
         * publish again. */
        for (int i = 0; i < SP_MAX_ENTITIES; i++) {
            if (p->entities[i].used) sp_send_publish(p, &p->entities[i]);
        }
    }
    sp_drain_inbound(p);
    int64_t now = sp_now_ms();
    if (now - p->last_heartbeat_ms >= SP_HEARTBEAT_INTERVAL_MS) {
        sp_send_heartbeat(p);
        p->last_heartbeat_ms = now;
    }
    return SYNTHI_PROBE_OK;
}

bool synthi_probe_is_connected(const synthi_probe_t* p) {
    return p && p->fd >= 0;
}

int synthi_probe_wire_version(void) {
    return SYNTHI_PROBE_API_VERSION;
}
