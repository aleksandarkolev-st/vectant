# Vendored `stun` 0.5.1 — Synthi patch

This is a byte-identical copy of [`stun`](https://crates.io/crates/stun) `0.5.1`
(the version webrtc-rs `0.9` depends on transitively) with **one** intentional
change:

`src/error_code.rs` — `impl fmt::Display for ErrorCodeAttribute` no longer
returns `Err(fmt::Error)` when the reason bytes are not valid UTF-8. Upstream
returns `Err(fmt::Error)`, which causes the standard library to panic inside
`format!` / `.to_string()` / `write!(String, ...)` with:

    "a formatting trait implementation returned an error when the underlying
     stream did not: Error"

The patched impl uses `String::from_utf8_lossy`, which renders malformed
bytes as U+FFFD instead of panicking.

## Why this matters

The webrtc-rs `turn` crate formats `ErrorCodeAttribute` via
`format!("{} (error {})", res.typ, code)` inside
`turn::client::relay_conn::RelayConnInternal::create_permissions` (see
`turn-0.7.1/src/client/relay_conn.rs:432`). In practice this path fires on
every TURN error response — including the `403 Forbidden IP` coturn sends
when a `CREATE_PERMISSION` is rejected. Coturn replies (mostly) with ASCII
reasons, but any non-UTF-8 byte in the STUN ERROR-CODE value brings the
whole ICE agent task down, which in turn kills the worker's peer
transport and any media flowing over it.

Wire-up lives at the bottom of `worker/Cargo.toml`:

    [patch.crates-io]
    stun = { path = "vendored/stun" }

## When to delete

If/when webrtc-rs either bumps to a `stun` version that uses
`String::from_utf8_lossy` here, or a release of `stun` lands the fix on
its own, this directory and the `[patch.crates-io]` entry can be dropped.
The only file that carries Synthi-specific changes is `src/error_code.rs`;
everything else is crates.io byte-for-byte (see `Cargo.toml` for the
unchanged crate manifest).
